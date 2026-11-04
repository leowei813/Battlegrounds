import { AssistSystem } from './AssistSystem.js';
import { NPC_CONFIG, NPC_NAMES, npcAggression } from '../config/npcs.js';
import { xpToNext } from '../config/survivors.js';
import {
  RESOURCE_KEYS, RAID_TRAVEL, POI_SCAN_RADIUS, OUTPOST_SCAN_RADIUS,
} from '../config/constants.js';
import { ShelterSystem } from './ShelterSystem.js';
import { unitWeight } from '../config/supplies.js';
import { POI_TYPES } from '../config/poiTypes.js';
import { zoneAt } from '../config/zones.js';
import { stockOf, dayKey } from './LootStock.js';
import { tripProgress } from './ExplorationSystem.js';
import { planRoute, pathLength, crossings } from '../map/routing.js';
import {
  withSeed,
  pick, randFloat, randInt, haversine, chance, uid,
} from '../utils/math.js';
import { seeded, cellOf as gridCell, cellBox } from '../multiplayer/worldGrid.js';

/**
 * 共用 NPC：位置、名稱、基礎等級由「格子＋世代」決定（所有玩家相同）；
 * 傷亡、等級損失、物資增減、被摧毀等變化寫入共用物件 npc:<格子>:<編號>，大家同步。
 */
export const SHARED_NPC = {
  /** 每個 NPC 據點存在的時間，之後由新的勢力取代（避免全部長到最高等級） */
  lifeMs: 48 * 3600000,
  /** 每隔多久升一級 */
  levelMs: 2 * 3600000,
  /** 同步範圍（公里） */
  km: 5,
};

const rand = ([a, b]) => randFloat(a, b);

/**
 * NPC 據點：自己升級、外出探索（會搶先搜刮建築），並依玩家文明度積極掠奪玩家據點。
 * 玩家可以派隊攻打 NPC 據點搶奪資源；據點被摧毀後會在別處重新出現。
 * 夜晚屍潮期間 NPC 不會出動掠奪。
 */
/** 攻陷 NPC 據點時能搶到的金錢比例 */
const NPC_COIN_LOOT = 0.35;

/** 下一個中午 12:00（當地時間）：被擊敗的 NPC 據點在這時才重新出現 */
export function nextNoon(at = Date.now()) {
  const d = new Date(at);
  d.setHours(NPC_CONFIG.respawnHour ?? 12, 0, 0, 0);
  if (d.getTime() <= at) d.setDate(d.getDate() + 1);
  return d.getTime();
}

export class NpcSystem {
  constructor(game) {
    this.game = game;
    this.pending = [];
    game.shared?.watch('npc', SHARED_NPC.km);
    game.bus?.on?.('shared:changed', () => this.applyShared());
  }

  get state() {
    return this.game.state.npcs;
  }

  get list() {
    return this.state.list;
  }

  get(id) {
    return this.list.find((n) => n.id === id) || null;
  }

  /** 讓探索系統把 NPC 據點當成目的地 */
  asPoi(id) {
    const n = this.get(id);
    return n && {
      id: n.id, name: n.name, lat: n.lat, lon: n.lon, type: 'military', icon: '🏴‍☠️', npc: true,
    };
  }

  /** 滿編時的掠奪者人數（不含首領） */
  fullCount(n) {
    // 後期：Lv28 起每 2 級多 1 人（Lv33 共 11 人、Lv40 共 15 人，另有首領），需要更多人在家才守得住
    const c = NPC_CONFIG.lateGarrison;
    const extra = c && n.level >= c.from ? Math.floor((n.level - c.from) / c.step) + 1 : 0;
    return Math.min(8, 3 + Math.floor(n.level / 4)) + extra;
  }

  /** NPC 據點的防禦：圍牆耐久與防禦火力（攻打時要先破牆） */
  defense(n) {
    return { wall: Math.round(400 + n.level * 160), dps: Math.round(10 + n.level * 5) };
  }

  /** 據點守備：掠奪者人數（扣除傷亡）與等級 */
  garrison(n) {
    const count = Math.max(0, this.fullCount(n) - (n.wounded || 0));
    const enemies = Array.from({ length: count }, () => this.game.combat.createEnemy('raider', n.level));
    enemies.push(this.game.combat.createEnemy('raiderChief', n.level));
    return enemies;
  }

  power(n) {
    return this.garrison(n).reduce((s, e) => s + e.maxHp * 0.1 + e.atk, 0);
  }

  aggression() {
    return npcAggression(this.game.civilization.value());
  }

  // ---------- 生成 ----------

  origin() {
    return this.game.shelter.primary() || this.game.state.map.center;
  }

  /** 建築所在的 1 公里格子 */
  cellOf(lat, lon) {
    return gridCell(lat, lon, NPC_CONFIG.cellKm).key;
  }

  /** 共用格子中某一格的 NPC（被摧毀等待重生時回傳 null）；由種子決定，所有玩家相同 */
  slotNpc(cellKey, slot, now = Date.now()) {
    const [i, j] = cellKey.split(':').map(Number);
    const sid = `${cellKey}:${slot}`;
    // 密度：部分名額固定沒有 NPC（依種子決定，所有玩家相同）
    if (seeded(`npc-keep:${sid}`, () => randFloat(0, 1)) >= (NPC_CONFIG.keepRatio ?? 1)) return null;
    const offset = seeded(`npc-off:${sid}`, () => randFloat(0, SHARED_NPC.lifeMs));
    const gen = Math.floor((now + offset) / SHARED_NPC.lifeMs);
    const genStart = gen * SHARED_NPC.lifeMs - offset;
    const d = this.sharedOf(sid, gen);
    const dc = d?.dc || 0;
    if (d?.destroyed && now < d.destroyed.respawnAt) return null;
    const bornAt = dc > 0 && d?.destroyed ? d.destroyed.respawnAt : genStart;
    const ident = `${sid}:${gen}:${dc}`;
    const box = cellBox(i, j, NPC_CONFIG.cellKm);
    return seeded(`npc:${ident}`, () => {
      const lat = box.lat0 + box.dLat * randFloat(0.1, 0.9);
      const lon = box.lon0 + box.dLon * randFloat(0.1, 0.9);
      const zone = zoneAt(lat, lon);
      const baseLevel = randInt(1, 6) + Math.max(0, zone.danger) * 2;
      return {
        sid, ident, gen, dc, cell: cellKey, lat, lon, bornAt, baseLevel,
        name: pick(NPC_NAMES),
        resources: {
          food: randInt(60, 160), wood: randInt(60, 200), fuel: randInt(10, 60), scrap: randInt(10, 40), nail: randInt(10, 40), bandage: randInt(0, 4),
        },
        coins: randInt(40, 120),
      };
    });
  }

  /** 依識別碼找回共用 NPC（不在自己附近時也能重建，例如集結時） */
  byIdent(ident, now = Date.now()) {
    if (!ident) return null;
    const hit = this.list.find((n) => n.ident === ident);
    if (hit) return hit;
    const [i, j, slot] = ident.split(':');
    const s = this.slotNpc(`${i}:${j}`, Number(slot), now);
    return s && s.ident === ident ? this.materialize(s, now) : null;
  }

  /** 共用資料（不是同一世代的舊資料視為沒有） */
  sharedOf(sid, gen) {
    const d = this.game.shared?.get('npc', sid);
    return d && d.gen === gen ? d : null;
  }

  /** 共用 NPC 目前的等級：基礎等級＋存在時間成長－被擊退的損失 */
  sharedLevel(n, now = Date.now()) {
    return Math.max(1, Math.min(NPC_CONFIG.maxLevel, n.baseLevel + Math.floor(Math.max(0, now - n.bornAt) / SHARED_NPC.levelMs) - (n.levelLoss || 0)));
  }

  /** 由共用資料更新 NPC 的狀態（有人改變過才套用） */
  applySharedTo(n) {
    if (!n.sid) return;
    const obj = this.game.shared?.cache?.get(`npc:${n.sid}`);
    const d = obj?.data;
    if (!d || d.ident !== n.ident || obj.ver === n.sharedVer) return;
    n.sharedVer = obj.ver;
    n.wounded = Math.max(0, d.wounded || 0);
    n.healAt = d.healAt || 0;
    n.levelLoss = d.levelLoss || 0;
    const res = { ...n.baseRes };
    Object.entries(d.res || {}).forEach(([k, v]) => { res[k] = Math.max(0, (res[k] || 0) + v); });
    n.resources = res;
    n.coins = Math.max(0, n.baseCoins + (d.coins || 0));
    if (d.siegeNight) n.siegeNight = d.siegeNight;
    if (d.lastSiege) n.lastSiege = d.lastSiege;
    n.level = this.sharedLevel(n);
  }

  applyShared() {
    if (!this.state?.list) return;
    this.list.forEach((n) => this.applySharedTo(n));
    // 被別人摧毀或世代更替：重新整理
    this.reconcile(Date.now());
    this.retryPending();
  }

  /**
   * 寫入共用 NPC 狀態（依目前伺服器資料套用變化，大家的變化會累加）。
   * fn(d) 直接修改資料；回傳 false 表示不需要寫入。
   */
  push(n, fn) {
    if (!n?.sid || !this.game.shared) return null;
    const run = () => this.game.shared.update('npc', n.sid, (cur) => {
      const d = cur && cur.gen === n.gen ? cur : { gen: n.gen, dc: n.dc, ident: n.ident };
      if (d.ident !== n.ident) {
        if ((d.dc || 0) > n.dc) return { fail: 'stale' };
        Object.assign(d, {
          ident: n.ident, dc: n.dc, wounded: 0, healAt: 0, levelLoss: 0, res: {}, coins: 0, destroyed: null,
        });
      }
      if (fn(d) === false) return { fail: 'skip' };
      return { data: d };
    }, cellBox(...n.cell.split(':').map(Number), NPC_CONFIG.cellKm)).then((r) => {
      if (r.ok || ['stale', 'skip'].includes(r.reason)) {
        // 套用伺服器上合併後的結果（包含別人同時造成的變化）；
        // 別人已經結算過（skip）時也要改回伺服器的值，避免本機重複扣等級、傷亡與物資
        n.sharedVer = null;
        this.applySharedTo(n);
      } else if (r.reason && !['stale', 'skip'].includes(r.reason) && this.pending.length < 30) this.pending.push(run);
      return r;
    });
    return run();
  }

  /** 連線失敗的共用寫入：下次同步時重試 */
  retryPending() {
    const list = this.pending.splice(0, 30);
    list.forEach((run) => run());
  }

  /** 共用 NPC：傷亡隨時間補回 */
  static healTo(d, now, full) {
    while (d.wounded > 0 && d.healAt && now >= d.healAt) {
      d.wounded -= 1;
      d.healAt += NPC_CONFIG.woundHealMs;
    }
    if (!(d.wounded > 0)) {
      d.wounded = 0;
      d.healAt = 0;
    }
    d.wounded = Math.min(full, d.wounded);
  }

  /**
   * 共用 NPC：附近有建築（危險度 ≥ 2）的格子，每格依種子產生固定數量的 NPC 據點（所有玩家相同）。
   * 不會出現在任何玩家據點的警戒範圍內，也不會在避難所旁邊；被摧毀的要等重生時間。
   * @returns {number} 本次新增的數量
   */
  fillCells(now = Date.now(), { silent = false } = {}) {
    const o = this.origin();
    if (!o) return 0;
    // 玩家據點附近（警戒範圍，或至少 300 公尺）不會有 NPC：所有玩家據點都一樣
    const zones = this.playerZones().map((z) => ({ ...z, r: Math.max(z.r, NPC_CONFIG.minFromShelterM) }));
    const inAlert = (p) => zones.some((z) => haversine(z.lat, z.lon, p.lat, p.lon) <= z.r);
    // 只出現在玩家的可視範圍內（避難所 POI_SCAN_RADIUS、前哨站 OUTPOST_SCAN_RADIUS；所有玩家都算，彼此看到的相同）
    const views = this.viewZones();
    const inView = (p) => views.some((z) => haversine(z.lat, z.lon, p.lat, p.lon) <= z.r);
    // 哪些格子有 NPC：只看 OpenStreetMap 的真實建築（所有玩家相同），不看各自隨機補上的建築；
    // 完全沒有真實建築資料時（離線、程序生成地圖）才用全部建築
    const pois = this.game.state.map.pois;
    const real = pois.filter((p) => String(p.id).startsWith('osm_'));
    const cells = new Set();
    (real.length ? real : pois).forEach((p) => cells.add(this.cellOf(p.lat, p.lon)));
    const want = [];
    cells.forEach((key) => {
      const inCell = [];
      for (let slot = 0; slot < NPC_CONFIG.perCell; slot += 1) {
        const s = this.slotNpc(key, slot, now);
        if (!s) continue;
        // 同一格裡靠太近的 NPC 只保留編號小的：只依格子本身判斷，與各玩家看到的範圍無關（所有玩家相同）
        if (inCell.some((x) => haversine(x.lat, x.lon, s.lat, s.lon) < 120)) continue;
        inCell.push(s);
        if (haversine(o.lat, o.lon, s.lat, s.lon) < NPC_CONFIG.minFromShelterM || inAlert(s) || !inView(s)) continue;
        want.push(s);
      }
    });
    const keep = new Set(want.map((s) => s.ident));
    const before = this.list.length;
    // 不再存在的共用 NPC 移除（正在掠奪途中的隊伍保留到結束）
    this.state.list = this.list.filter((n) => !n.sid || keep.has(n.ident) || (n.trip && n.trip.endAt > now && !n.gone));
    const have = new Set(this.list.map((n) => n.ident).filter(Boolean));
    let added = 0;
    want.forEach((s) => {
      if (have.has(s.ident)) return;
      const n = this.materialize(s, now);
      this.list.push(n);
      added += 1;
      if (!silent) this.game.log(`🏴‍☠️ NPC 勢力「${n.name}」在附近建立據點（${this.intelView(n).levelShort}）`, 'danger');
    });
    if (added || this.list.length !== before) this.game.bus.emit('npcs:changed');
    return added;
  }

  /** 由共用格子資料建立 NPC（本機另外記錄自己的行動時間） */
  materialize(s, now = Date.now()) {
    const coins = s.coins * (s.baseLevel + 5);
    const n = {
      id: `npc_${s.ident.replace(/:/g, '_')}`,
      sid: s.sid,
      ident: s.ident,
      gen: s.gen,
      dc: s.dc,
      name: s.name,
      cell: s.cell,
      lat: s.lat,
      lon: s.lon,
      baseLevel: s.baseLevel,
      bornAt: s.bornAt,
      level: 1,
      levelLoss: 0,
      baseRes: { ...s.resources },
      resources: { ...s.resources },
      baseCoins: coins,
      coins,
      wounded: 0,
      nextLevelAt: Infinity,
      nextExploreAt: now + rand(NPC_CONFIG.exploreEveryMs) * randFloat(0.3, 1),
      nextRaidAt: now + this.raidDelay(),
      trip: null,
    };
    this.applySharedTo(n);
    n.level = this.sharedLevel(n, now);
    return n;
  }

  /** 重新整理共用 NPC（被摧毀、世代更替） */
  reconcile(now = Date.now()) {
    if (!this.game.state.map.pois.length || !this.game.shelter.hasShelter()) return;
    this.fillCells(now, { silent: true });
  }

  /** 玩家據點的警戒範圍（NPC 不會出現在裡面） */
  /** 所有玩家的可視範圍：避難所（主要據點）1200 公尺、前哨站 500 公尺 */
  viewZones() {
    const g = this.game;
    const primary = g.shelter.primary();
    return [
      ...g.state.bases.map((b) => ({ lat: b.lat, lon: b.lon, r: b === primary ? POI_SCAN_RADIUS : OUTPOST_SCAN_RADIUS })),
      ...(g.world?.others || []).flatMap((p) => p.bases.map((b) => ({ lat: b.lat, lon: b.lon, r: b.primary ? POI_SCAN_RADIUS : OUTPOST_SCAN_RADIUS }))),
    ];
  }

  playerZones() {
    const g = this.game;
    return [
      ...g.state.bases.map((b) => ({ lat: b.lat, lon: b.lon, r: g.territory.alertRadius(b) })),
      ...(g.world?.others || []).flatMap((p) => p.bases.map((b) => ({ lat: b.lat, lon: b.lon, r: b.alert || 80 }))),
    ];
  }

  /** 所有警戒範圍（公尺）：自己的據點、其他玩家的據點、NPC 據點 */
  alertZones() {
    const g = this.game;
    return [
      ...g.state.bases.map((b) => ({ lat: b.lat, lon: b.lon, r: g.territory.alertRadius(b) })),
      ...(g.world?.others || []).flatMap((p) => p.bases.map((b) => ({ lat: b.lat, lon: b.lon, r: b.alert || 80 }))),
      ...this.list.map((n) => ({ lat: n.lat, lon: n.lon, r: 60 + n.level })),
    ];
  }

  spawnAt(poi, cell, now = Date.now(), silent = false) {
    const leader = this.game.survivors.leader();
    const zone = zoneAt(poi.lat, poi.lon);
    const level = Math.max(1, (leader?.level || 1) - 2 + randInt(0, 3) + Math.max(0, zone.danger));
    const n = {
      id: uid('npc'),
      name: pick(NPC_NAMES.filter((x) => !this.list.some((m) => m.name === x))) || pick(NPC_NAMES),
      poiId: poi.id,
      cell,
      lat: poi.lat,
      lon: poi.lon,
      level,
      resources: {
        food: randInt(60, 160), wood: randInt(60, 200), fuel: randInt(10, 60), scrap: randInt(10, 40), nail: randInt(10, 40), bandage: randInt(0, 4),
      },
      coins: randInt(40, 120) * level,
      nextLevelAt: now + rand(NPC_CONFIG.levelUpMs),
      nextExploreAt: now + rand(NPC_CONFIG.exploreEveryMs) * randFloat(0.3, 1),
      nextRaidAt: now + this.raidDelay(),
      trip: null,
    };
    this.list.push(n);
    if (!silent) this.game.log(`🏴‍☠️ NPC 勢力「${n.name}」在「${poi.name}」建立據點（Lv${n.level}）`, 'danger');
    return n;
  }

  /** 下一次掠奪的間隔：積極度越高越頻繁 */
  raidDelay() {
    const crowd = Math.max(1, this.list.length / 3);
    return (NPC_CONFIG.raidBaseMs * crowd / (0.3 + this.aggression())) * randFloat(0.7, 1.3);
  }

  // ---------- 更新 ----------

  /** NPC 行動（使用存檔種子） */
  update(now = Date.now()) {
    return withSeed(this.game.state.rng, 'npc', () => this.updateNow(now));
  }

  updateNow(now = Date.now()) {
    if (!this.game.state.map.pois.length || !this.game.shelter.hasShelter()) return;
    // 連線中：等第一次讀到共用 NPC 資料再顯示與結算（否則會先顯示沒扣掉等級損失的較高等級，同步後又變低）
    const sh = this.game.shared;
    if (sh?.online && !sh.backend && !sh.listedAt?.npc) return;
    const st = this.state;
    if (now >= (st.nextSpawnAt || 0)) {
      // 第一次（或重新掃描後）一次補齊，不逐一記錄
      const first = !this.list.some((n) => n.sid);
      const added = this.fillCells(now, { silent: first });
      if (first && added) this.game.log(`🏴‍☠️ 附近有 ${added} 個 NPC 勢力據點（所有倖存者看到的相同）`, 'danger');
      st.nextSpawnAt = now + 60000;
    }
    const phase = this.game.time.phase(now);
    const night = this.game.time.nightKey(now);
    this.list.forEach((n) => {
      // 傷亡人員逐漸補回
      if (n.wounded > 0) {
        n.healAt = n.healAt || now + NPC_CONFIG.woundHealMs;
        while (n.wounded > 0 && now >= n.healAt) {
          n.wounded -= 1;
          n.healAt += NPC_CONFIG.woundHealMs;
        }
        if (!n.wounded) n.healAt = 0;
      }
      // 夜晚：NPC 據點也要抵禦屍群（每晚一次）
      if (phase.zombies && n.siegeNight !== night) this.nightSiege(n, night, now);
      // 升級（共用 NPC 依存在時間計算）
      if (n.sid) n.level = this.sharedLevel(n, now);
      let guard = 0;
      while (now >= n.nextLevelAt && guard < 20) {
        guard += 1;
        if (n.level < NPC_CONFIG.maxLevel) n.level += 1;
        n.nextLevelAt += rand(NPC_CONFIG.levelUpMs);
      }
      if (n.trip) this.checkCrossings(n, now);
      // 掠奪隊抵達時立即交戰，之後返回據點
      if (n.trip?.kind === 'raid' && !n.trip.resolved && now >= this.arriveAt(n.trip)) {
        n.trip.resolved = true;
        this.resolveIncoming(n, n.trip, now);
      }
      if (!this.list.includes(n)) return;
      if (n.trip && now >= n.trip.endAt) this.finishTrip(n, now);
      // 有傷員時要先治療（補回人手）才會外出探索或掠奪
      if (n.wounded > 0) return;
      if (!n.trip && now >= n.nextRaidAt) this.launchRaid(n, now);
      if (!n.trip && now >= n.nextExploreAt) this.launchExplore(n, now);
    });
  }

  /** NPC 人員傷亡（每人 20 分鐘補回） */
  wound(n, count, now = Date.now()) {
    if (count <= 0) return;
    n.wounded = Math.min(this.fullCount(n), (n.wounded || 0) + count);
    if (!n.healAt || n.healAt < now) n.healAt = now + NPC_CONFIG.woundHealMs;
    const full = this.fullCount(n);
    return this.push(n, (d) => {
      NpcSystem.healTo(d, now, full);
      d.wounded = Math.min(full, (d.wounded || 0) + count);
      if (!d.healAt || d.healAt < now) d.healAt = now + NPC_CONFIG.woundHealMs;
    });
  }

  /** NPC 等級下降（被擊退、攔截） */
  levelDown(n, by = 1) {
    if (n.sid) {
      n.levelLoss = (n.levelLoss || 0) + by;
      n.level = this.sharedLevel(n);
      this.push(n, (d) => { d.levelLoss = (d.levelLoss || 0) + by; });
    } else n.level = Math.max(1, n.level - by);
  }

  /** NPC 物資增減（掠奪所得、被屍群破壞） */
  addResources(n, delta = {}, coins = 0) {
    Object.entries(delta).forEach(([k, v]) => { n.resources[k] = Math.max(0, (n.resources[k] || 0) + v); });
    n.coins = Math.max(0, (n.coins || 0) + coins);
    this.push(n, (d) => {
      d.res = d.res || {};
      Object.entries(delta).forEach(([k, v]) => { d.res[k] = (d.res[k] || 0) + v; });
      d.coins = (d.coins || 0) + coins;
    });
  }

  /**
   * NPC 據點抵禦屍群（每晚一次）：依區域危險度、等級與目前傷亡判定結果。
   * 守住會有少量傷亡；被突破會損失物資、人員與等級；本來就元氣大傷的據點可能被屍群攻陷。
   */
  nightSiege(n, night, now) {
    n.siegeNight = night;
    const zone = zoneAt(n.lat, n.lon);
    const weak = (n.wounded || 0) / Math.max(1, this.fullCount(n));
    // 共用 NPC：結果由種子決定（每位玩家看到的相同），且每晚只結算一次
    const roll = () => {
      const r = randFloat(0.5, 1.5) * (1 + Math.max(0, zone.danger) * 0.08) + weak * 0.6;
      if (r < 0.85) return { r, result: 'held', hurt: chance(0.4) ? 1 : 0, mul: 1, drop: 0 };
      if (r < 1.3) return { r, result: 'hurt', hurt: randInt(1, 2), mul: 0.9, drop: 0 };
      return { r, result: 'breached', hurt: randInt(2, 3), mul: 0.7, drop: 1 };
    };
    const o = n.sid ? seeded(`npc-siege:${n.ident}:${night}`, roll) : roll();
    const full = this.fullCount(n);
    n.wounded = Math.min(full, (n.wounded || 0) + o.hurt);
    if (o.hurt && (!n.healAt || n.healAt < now)) n.healAt = now + NPC_CONFIG.woundHealMs;
    const lost = {};
    Object.keys(n.resources).forEach((k) => {
      lost[k] = n.resources[k] - Math.floor(n.resources[k] * o.mul);
      n.resources[k] -= lost[k];
    });
    if (o.drop) {
      if (n.sid) {
        n.levelLoss = (n.levelLoss || 0) + o.drop;
        n.level = this.sharedLevel(n, now);
      } else n.level = Math.max(1, n.level - o.drop);
    }
    n.lastSiege = { night, result: o.result };
    this.push(n, (d) => {
      if (d.siegeNight === night) return false;
      d.siegeNight = night;
      d.lastSiege = n.lastSiege;
      NpcSystem.healTo(d, now, full);
      d.wounded = Math.min(full, (d.wounded || 0) + o.hurt);
      if (o.hurt && (!d.healAt || d.healAt < now)) d.healAt = now + NPC_CONFIG.woundHealMs;
      d.res = d.res || {};
      Object.entries(lost).forEach(([k, v]) => { if (v) d.res[k] = (d.res[k] || 0) - v; });
      d.levelLoss = (d.levelLoss || 0) + o.drop;
      return true;
    });
    // 人員全數倒下：據點被屍群攻陷
    if (o.result === 'breached' && this.garrison(n).length <= 1 && o.r > 1.6) {
      if (this.intel() >= 1) this.game.log(`🧟 NPC 勢力「${n.name}」的據點被屍群攻陷了`, 'info');
      this.destroy(n, now);
    }
  }

  /** 偵查等級（研究「偵查」）：越高可得知越詳細的 NPC 情報 */
  intel() {
    return this.game.research.level('s_recon');
  }

  /**
   * 依偵查等級顯示的 NPC 情報。
   *  0：只知道名稱；1：大約等級；3：確切等級、守軍與傷亡；5：大約物資；7：確切物資與建議戰力；9：下次掠奪時間
   */
  intelView(n, now = Date.now()) {
    const lv = this.intel();
    const approx = (v, step) => `約 ${Math.max(0, Math.round(v / step) * step)}`;
    const low = Math.max(1, Math.floor((n.level - 1) / 5) * 5 + 1);
    const view = {
      lv,
      level: lv >= 3 ? `Lv${n.level}` : lv >= 1 ? `Lv${low}～${low + 4}` : 'Lv?',
      levelShort: lv >= 3 ? `Lv${n.level}` : lv >= 1 ? `Lv${low}+` : 'Lv?',
      garrison: null,
      wounded: null,
      siege: null,
      resources: null,
      coins: null,
      power: null,
      nextRaid: null,
    };
    if (lv >= 3) {
      const g = this.garrison(n);
      view.garrison = g;
      view.wounded = n.wounded || 0;
      const s = n.lastSiege;
      if (s) view.siege = { held: '守住了屍群', hurt: '守住屍群但有傷亡', breached: '被屍群突破、損失慘重' }[s.result];
    }
    if (lv >= 5) {
      view.resources = Object.entries(n.resources).filter(([, v]) => v > 0).map(([k, v]) => [k, lv >= 7 ? `${Math.floor(v)}` : approx(v, 50)]);
      view.coins = lv >= 7 ? `${n.coins}` : approx(n.coins, 100);
    }
    if (lv >= 7) view.power = Math.round(this.power(n));
    if (lv >= 9) view.nextRaid = Math.max(0, n.nextRaidAt - now);
    return view;
  }

  /** 玩家據點看起來的防禦強度（防禦塔與駐守人員的武器）；NPC 不知道據點還有沒有彈藥 */
  baseDefense(base) {
    const g = this.game;
    const guards = g.territory.garrison(base).list.reduce((s, sv) => s + g.survivors.stats(sv, sv.equipment?.weapon ? 'ranged' : 'melee').power, 0);
    return g.siege.of(base.id).defenseDps({ apparent: true, raw: true }) * 8 + guards;
  }

  /**
   * NPC 行程：自動判斷玩家據點的警戒範圍是否有威脅——防禦強過自己就繞路，
   * 否則直接穿過（若該據點有駐守人員會遭到攻擊）。
   * @param {string} [targetBaseId] 掠奪目標（不繞開）
   */
  tripTimes(n, to, searchMs, targetBaseId = null) {
    const g = this.game;
    const power = this.power(n);
    const zones = g.state.bases.filter((b) => b.id !== targetBaseId).map((b) => ({
      base: b, lat: b.lat, lon: b.lon, r: g.territory.alertRadius(b), defense: this.baseDefense(b),
    }));
    const avoid = zones.filter((z) => z.defense > power * 0.7);
    const from = { lat: n.lat, lon: n.lon };
    const path = planRoute(from, to, avoid);
    const dist = pathLength(path);
    const through = zones.filter((z) => !avoid.includes(z) && g.territory.garrison(z.base).count > 0);
    const back = [...path].reverse();
    const crossingsList = [
      ...crossings(path, through).map(({ index, at }) => ({ baseId: through[index].base.id, at, leg: 'out', done: false })),
      ...crossings(back, through).map(({ index, at }) => ({ baseId: through[index].base.id, at, leg: 'back', done: false })),
    ];
    const travelMs = Math.round((dist / 1000) * NPC_CONFIG.walkMinPerKm * 60000);
    return {
      travelMs, searchMs, distanceM: Math.round(dist), path, crossings: crossingsList, avoided: avoid.length,
    };
  }

  /** NPC 隊伍穿過有駐守人員的玩家據點範圍：駐守人員主動攻擊 */
  checkCrossings(n, now) {
    const trip = n.trip;
    for (const c of trip?.crossings || []) {
      const ratio = trip.distanceM ? c.at / trip.distanceM : 0;
      const at = c.leg === 'out' ? trip.startAt + trip.travelMs * ratio : trip.startAt + trip.travelMs + trip.searchMs + trip.travelMs * ratio;
      if (c.done || at > now) continue;
      c.done = true;
      const g = this.game;
      const base = g.shelter.base(c.baseId);
      const guards = base ? g.territory.garrison(base).list : [];
      if (!guards.length) continue;
      const enemies = Array.from({ length: Math.min(4, 2 + Math.floor(n.level / 8)) }, () => g.combat.createEnemy('raider', n.level));
      const result = g.combat.simulate(guards, enemies, { title: `🏴‍☠️ 攔截 NPC「${n.name}」的隊伍` });
      g.combat.applyOutcome(guards, result, now);
      if (result.victory) {
        g.log(`🛡️「${base.name}」的駐守人員擊退了路過的「${n.name}」隊伍`, 'success');
        g.toast(`🛡️「${base.name}」擊退了路過的「${n.name}」隊伍`, 'success');
        n.trip = null;
        this.levelDown(n);
        g.bus.emit('npcs:changed');
        return;
      }
      g.log(`⚠️「${n.name}」的隊伍強行穿過「${base.name}」的警戒範圍`, 'danger');
    }
  }

  launchExplore(n, now) {
    n.nextExploreAt = now + rand(NPC_CONFIG.exploreEveryMs);
    const targets = this.game.state.map.pois.filter((p) => !this.game.shelter.baseAtPoi(p.id)
      && !this.list.some((m) => m.poiId === p.id)
      && (p.lootedDay !== dayKey(now) || this.game.state.map.remain?.[p.id])
      && haversine(n.lat, n.lon, p.lat, p.lon) <= NPC_CONFIG.exploreRadiusM);
    const poi = pick(targets);
    if (!poi) return;
    const t = this.tripTimes(n, poi, NPC_CONFIG.searchMs);
    n.trip = {
      kind: 'explore', poiId: poi.id, target: poi.name, from: { lat: n.lat, lon: n.lon }, to: { lat: poi.lat, lon: poi.lon },
      startAt: now, endAt: now + t.travelMs * 2 + t.searchMs, ...t,
    };
  }

  /** 屍潮期間（夜晚）不出動；文明度越高越常來 */
  launchRaid(n, now) {
    n.nextRaidAt = now + this.raidDelay();
    if (this.game.time.phase(now).zombies) return;
    const bases = this.game.state.bases;
    if (!bases.length) return;
    // 盡量避免多個 NPC 同時攻打玩家：已經有掠奪隊在路上時大多會放棄，玩家文明度很高時才比較常發生
    if (!this.allowConcurrentRaid(now)) return;
    // 等級差太大不出手：避免高等 NPC 一面倒地掠奪等級低很多的玩家
    if (n.level > this.raidLevelCap()) return;
    const base = pick(bases);
    const t = this.tripTimes(n, base, 0, base.id);
    // 掠奪避難所的移動時間較長，讓玩家有時間準備防守
    t.travelMs = Math.round(Math.max(t.travelMs * RAID_TRAVEL.npcMul, RAID_TRAVEL.minMin * 60000));
    // 抵達時若已入夜（屍潮），NPC 會放棄這次掠奪
    n.trip = {
      kind: 'raid', baseId: base.id, target: base.name, from: { lat: n.lat, lon: n.lon }, to: { lat: base.lat, lon: base.lon },
      startAt: now, endAt: now + t.travelMs * 2, ...t,
    };
    const eta = `約 ${Math.max(1, Math.round(t.travelMs / 60000))} 分鐘後抵達`;
    this.game.log(`🏴‍☠️「${n.name}」的掠奪隊正朝「${base.name}」前進！（${eta}）`, 'danger');
    this.game.toast(`🏴‍☠️「${n.name}」（${this.intelView(n).levelShort}）的掠奪隊正朝「${base.name}」前進！（${eta}）`, 'danger');
  }

  /** 會掠奪這位玩家的 NPC 等級上限：倖存者中等級最高 6 人的平均等級 × 倍率（倍率隨等級提高，最多高出 20 級） */
  raidLevelCap() {
    const top = this.game.state.survivors.map((s) => s.level).sort((a, b) => b - a).slice(0, 6);
    const avg = top.length ? top.reduce((a, b) => a + b, 0) / top.length : 1;
    const c = NPC_CONFIG;
    const m = c.raidLevelMul || { base: 99, perLevel: 0 };
    // 至少比平均等級高 2 級（新手也會遇到同等級的 NPC）
    return Math.floor(Math.max(avg + 2, Math.min(avg * (m.base + m.perLevel * avg), avg + (c.raidLevelGap ?? 99))) + 1e-9);
  }

  /** 正在前往玩家據點的 NPC 掠奪隊數量 */
  activeRaids(now = Date.now()) {
    return this.list.filter((m) => m.trip?.kind === 'raid' && !m.trip.resolved && !m.trip.hidden && now < m.trip.endAt).length;
  }

  /** 已經有掠奪隊時，是否還要再發動（機率很低，文明度很高時才提高） */
  allowConcurrentRaid(now = Date.now()) {
    const active = this.activeRaids(now);
    if (!active) return true;
    const civ = this.game.civilization.value();
    const c = NPC_CONFIG;
    const p = civ < c.concurrentCiv ? c.concurrentChance : Math.min(c.concurrentMax, c.concurrentChance + (civ - c.concurrentCiv) / 1000);
    return chance(p / active);
  }

  /** NPC 行程抵達目的地的時間 */
  arriveAt(trip) {
    return trip.startAt + trip.travelMs;
  }

  finishTrip(n, now = Date.now()) {
    const trip = n.trip;
    n.trip = null;
    // 回到據點後先休息一段時間，不會一直外出
    n.nextExploreAt = Math.max(n.nextExploreAt || 0, now + rand(NPC_CONFIG.exploreEveryMs));
    if (trip.kind === 'explore') {
      const poi = this.game.state.map.pois.find((p) => p.id === trip.poiId);
      const at = this.arriveAt(trip);
      // 探索途中遭遇殭屍：可能有人受傷，要治療（補回人手）後才能再外出
      if (poi) {
        const night = this.game.time.phase(at).zombies ? 1.6 : 1;
        if (chance(NPC_CONFIG.exploreInjuryChance * this.game.zombies.encounterMul(poi.lat, poi.lon) * night)) this.wound(n, chance(0.3) ? 2 : 1, now);
      }
      const remain = this.game.state.map.remain || {};
      if (!poi || (poi.lootedDay === dayKey(at) && !remain[poi.id])) return;
      const stock = stockOf(poi, at, remain);
      this.addResources(n, Object.fromEntries(Object.entries(stock.resources).map(([k, v]) => [k, Math.round(v * 0.6)])));
      // NPC 探索過的建築資源一併消失（包含殘留的物資）
      poi.lootedDay = dayKey(at);
      delete remain[poi.id];
      this.game.bus.emit('map:changed');
    }
  }

  /** NPC 掠奪隊抵達玩家據點 */
  resolveIncoming(n, trip, now) {
    const g = this.game;
    const base = g.shelter.base(trip.baseId);
    const arrive = this.arriveAt(trip);
    if (!base) return;
    if (g.time.phase(arrive).zombies) {
      g.log(`🏴‍☠️「${n.name}」的掠奪隊見屍潮來襲，撤退了`, 'info');
      return;
    }
    // 1. 掠奪者要先打破圍牆，期間防禦設施持續射擊
    const all = this.garrison(n);
    const raiders = all.length;
    const siege = g.siege.of(base.id);
    const wallBefore = g.shelter.wallHp(base);
    // 友好玩家的協防隊：守城時一起射擊，圍牆被打破後一起迎戰
    const isHome = g.shelter.isPrimary(base);
    const helpers = isHome ? g.assist.incoming().filter((h) => h.kind === 'team') : [];
    const allies = isHome ? g.assist.allyUnits() : [];
    const helpDps = helpers.reduce((s, h) => s + (h.dps || 0), 0);
    const severeBefore = new Set(g.state.survivors.filter((sv) => sv.severe).map((sv) => sv.id));
    const as = g.combat.wallAssault(all, wallBefore, siege.defenseDps({ raw: true }) * (1 + g.research.bonus('raidDefensePct')) + helpDps);
    base.wallHp = Math.max(0, as.wallLeft);
    // 守城時：近戰防守的人會受傷，對方有遠程武器時遠程防守的人也可能中彈
    const wallGuards = [...siege.guards().map((x) => x.sv), ...base.defenses.map((d) => g.survivors.get(d.garrisonId)).filter(Boolean)];
    g.combat.wallDefenseHurt([...new Set(wallGuards)], all, as.sec, '守城對抗 NPC 掠奪時受傷');
    const enemies = as.alive;
    const defenders = this.defenders(base);
    // 2. 圍牆被打破後，與據點中的人員交戰；打贏才能掠奪
    let victory = !as.breached;
    let result = null;
    if (as.breached && (defenders.length || allies.length)) {
      result = g.combat.simulate(defenders, enemies, { firstStrikeBonus: base.facilities.watchtower.level * 0.04, allies, title: `🛡️ 防守 NPC「${n.name}」的掠奪` });
      g.combat.applyOutcome(defenders, result, now, { homeDefense: true });
      victory = result.victory;
    }
    const label0 = `NPC「${n.name}」`;
    const helperNames = Object.fromEntries(helpers.map((h) => [h.id, h.name]));
    const helperSum = AssistSystem.summarize(result ? result.team : [], helperNames);
    helpers.forEach((h) => { if (!helperSum[h.id]) helperSum[h.id] = { name: h.name, kills: 0, units: [] }; });
    const assistNote = g.assist.recordRaid(base, label0, victory, helperSum);
    const kills = as.killed + (result?.kills.length || 0);
    // NPC 的傷亡：被防禦設施或防守人員擊倒的掠奪者，需要時間補回
    this.wound(n, Math.min(kills, this.fullCount(n)), now);
    const label = `NPC「${n.name}」（${this.intelView(n).levelShort}）`;
    if (victory) {
      const injured = ShelterSystem.newlySevere(severeBefore, defenders);
      const participants = [...new Set([...wallGuards, ...(as.breached ? defenders : [])])];
      const reward = this.raidReward(n, all, as, result, participants, severeBefore);
      g.state.stats.battlesWon += 1;
      const how = !as.breached
        ? (enemies.length ? `圍牆撐住了 ${as.sec} 秒，掠奪隊放棄撤退` : '防禦設施在圍牆被打破前擊退了掠奪隊')
        : `圍牆被打破，防守人員（${defenders.map((d) => d.name).join('、')}）擊退了掠奪隊`;
      const entry = g.shelter.recordDefense({
        base, attacker: label, success: true, kills, injured, wallLost: as.wallLost, note: [how, assistNote].filter(Boolean).join('。'), reward,
      });
      g.toast(`🛡️「${base.name}」擊退了「${n.name}」的掠奪隊！`, 'success');
      g.bus.emit('raid:result', entry);
      this.levelDown(n);
      g.bus.emit('npc:raid', { npcId: n.id, baseId: base.id, victory: true });
      return;
    }
    void raiders;
    // 掠奪成功：搶走資源與部分金錢，圍牆受損
    const res = g.state.resources;
    const stolen = {};
    RESOURCE_KEYS.forEach((k) => {
      stolen[k] = Math.floor(g.shelter.exposed(k) * NPC_CONFIG.raidStealPct); // 地窖裡的搶不走
      res[k] -= stolen[k];
    });
    const coins = Math.floor(g.shelter.exposed('coins') * 0.1);
    g.state.player.coins -= coins;
    this.addResources(n, stolen, coins);
    g.state.stats.battlesLost += 1;
    const damaged = siege.damageBuildings(base);
    g.shelter.recordDefense({
      base, attacker: label, success: false, lost: stolen, coins, kills, damaged, injured: ShelterSystem.newlySevere(severeBefore, defenders),
      wallLost: as.wallLost, note: [`圍牆被打破；${defenders.length || allies.length ? `防守人員（${[...defenders.map((d) => d.name), ...allies.map((a) => a.name)].join('、')}）戰敗` : '據點裡沒有人可以防守'}`, assistNote].filter(Boolean).join('。'),
    });
    const total = Object.values(stolen).reduce((s, v) => s + v, 0);
    g.toast(`💀「${n.name}」掠奪了「${base.name}」！搶走 ${total} 單位物資`, 'danger');
    g.bus.emit('npc:raid', {
      npcId: n.id, baseId: base.id, victory: false, stolen, coins,
    });
  }

  /**
   * 擊退掠奪隊的獎勵（只給防守方）：賞金、被擊倒的掠奪者遺落的裝備、參與防守的人的經驗。
   * @returns {{coins:number, gear:object[], xp:object[], hurt:object[], level:number, npc:string}}
   */
  raidReward(n, all, as, result, participants, severeBefore) {
    const g = this.game;
    const R = NPC_CONFIG.raidReward;
    // 被擊倒的掠奪者：守城時被防禦設施擊倒的，加上破牆後戰鬥中被擊倒的
    const downed = [...all.filter((e) => !as.alive.includes(e)), ...(result?.kills || [])];
    const coins = Math.round(downed.length * n.level * R.bounty);
    if (coins) g.state.player.coins += coins;
    const boost = 0.3 + zoneAt(n.lat, n.lon).rarityBoost;
    const gear = [];
    downed.forEach((e) => {
      if (!chance(e.enemyId === 'raiderChief' ? R.chiefGear : R.raiderGear)) return;
      const item = g.equipment.generate({ level: n.level, boost });
      const kept = g.equipment.addItem(item, '掠奪隊遺落') !== false;
      gear.push({ name: item.name, rarity: item.rarity, chief: e.enemyId === 'raiderChief', kept });
    });
    const xp = participants.map((sv) => {
      const amount = Math.round(xpToNext(sv.level) * R.xpPct);
      const level = sv.level;
      g.survivors.gainXp(sv, amount);
      return { name: sv.name, level, xp: amount };
    });
    const hurt = participants.filter((sv) => !severeBefore.has(sv.id) && (sv.severe || g.survivors.hpOf(sv) < g.survivors.maxHp(sv)))
      .map((sv) => ({ name: sv.name, severe: !!sv.severe, pct: Math.round((g.survivors.hpOf(sv) / g.survivors.maxHp(sv)) * 100) }));
    const list = [`💰${coins}`, ...gear.map((x) => `🎁${x.name}${x.kept ? '' : '（空間不足，留在原地）'}`)];
    g.log(`🛡️ 擊退「${n.name}」的獎勵：${list.join('、')}${xp.length ? `；${xp.length} 名防守人員獲得經驗` : ''}`, 'success');
    return {
      npc: n.name, level: n.level, raiders: all.length, downed: downed.length, coins, gear, xp, hurt,
    };
  }

  /** 防守的倖存者：避難所為所有在家的可行動人員；前哨站只有駐守瞭望塔的人 */
  defenders(base) {
    const g = this.game;
    const home = g.state.survivors.filter((s) => s.status === 'idle' && !s.severe);
    if (g.shelter.isPrimary(base)) return home.filter((s) => !g.survivors.isGarrisoned(s.id) || g.shelter.garrisonOf(s.id)?.base.id === base.id).slice(0, 6);
    return home.filter((s) => g.shelter.garrisonOf(s.id)?.base.id === base.id);
  }

  // ---------- 玩家攻打 ----------

  /** 探索系統結算「攻打 NPC 據點」 */
  resolveRaid(exp) {
    const g = this.game;
    const n = this.get(exp.poiId);
    const members = exp.memberIds.map((id) => g.survivors.get(id)).filter(Boolean);
    const report = {
      id: uid('rp'), poiName: n ? `🏴‍☠️ ${n.name}` : 'NPC 據點', poiType: 'military', at: exp.endAt,
      events: [...(exp.travelEvents || [])], resources: {}, items: [], blueprints: [],
      kills: exp.travelKills || 0, xp: exp.travelXp || 0, success: false, members: members.map((m) => m.name),
    };
    if (!n || !members.length) {
      report.events.push('🏚️ 抵達時據點已經人去樓空。');
      return report;
    }
    const enemies = this.garrison(n);
    report.events.push(`⚔️ 攻打「${n.name}」（Lv${n.level}）：守軍 ${enemies.length} 人${n.wounded ? `（另有 ${n.wounded} 人傷亡中）` : ''}`);
    // 1. 先打破 NPC 據點的圍牆：期間據點的防禦火力持續射擊，被擊倒的隊員重傷
    const df = this.defense(n);
    const attackers = members.map((m) => ({ sv: m, maxHp: Math.max(1, g.survivors.hpOf(m)), atk: g.survivors.stats(m).atk }));
    const as = g.combat.wallAssault(attackers, df.wall, df.dps);
    attackers.forEach((a) => {
      if (!as.alive.includes(a)) g.survivors.becomeSevere(a.sv, '在攻打 NPC 據點時被防禦火力擊倒', exp.endAt);
      else g.survivors.setHp(a.sv, a.hp);
    });
    report.events.push(`🧱 攻擊圍牆 ${as.sec} 秒（耐久 ${df.wall}）${as.killed ? `，${as.killed} 名隊員被防禦火力擊倒` : ''}`);
    const fighters = as.alive.map((a) => a.sv);
    if (!as.breached || !fighters.length) {
      g.state.stats.battlesLost += 1;
      report.events.push(fighters.length ? '🧱 圍牆太堅固，久攻不下只好撤退' : '💀 隊員全被防禦火力擊倒，攻打失敗');
      return report;
    }
    // 2. 破牆後與守軍交戰
    const result = g.combat.simulate(fighters, enemies, { title: `⚔️ 攻打 NPC「${n.name}」（Lv${n.level}）` });
    g.combat.applyOutcome(fighters, result, exp.endAt);
    report.kills += result.kills.length;
    report.xp += result.xp;
    if (!result.victory) {
      g.state.stats.battlesLost += 1;
      this.wound(n, Math.min(result.kills.length, this.fullCount(n)), exp.endAt);
      report.events.push(`💀 攻打失敗，隊伍撤退！${result.kills.length ? `（擊倒對方 ${result.kills.length} 人，對方需要時間補回人手）` : ''}`);
      return report;
    }
    // 勝利：搶走據點資源（受運載量限制），據點被摧毀
    g.state.stats.battlesWon += 1;
    report.success = true;
    const carry = exp.cargo || members.length * 40;
    const total = Object.entries(n.resources).reduce((s, [k, v]) => s + (v || 0) * unitWeight(k), 0);
    const ratio = total > carry ? carry / total : 1;
    const loot = Object.fromEntries(Object.entries(n.resources).map(([k, v]) => [k, Math.floor((v || 0) * ratio)]));
    // 據點的金錢只搶得到一部分
    report.resources = g.grant({ ...loot, coins: Math.round(n.coins * NPC_COIN_LOOT) });
    if (ratio < 1) report.events.push(`🎒 帶不走全部物資（運載量 ${carry}），留下約 ${Math.round(total - carry)} 重量的物資`);
    if (chance(0.6)) {
      const item = g.equipment.generate({ level: n.level, boost: 0.3 + zoneAt(n.lat, n.lon).rarityBoost });
      report.items.push(item);
      g.equipment.addItem(item, '攻打 NPC');
    }
    report.events.push(`🏆 攻陷「${n.name}」，據點被摧毀！`);
    g.log(`🏆 攻陷 NPC 據點「${n.name}」`, 'success');
    this.destroy(n, exp.endAt);
    return report;
  }

  destroy(n, now = Date.now()) {
    this.state.list = this.list.filter((x) => x.id !== n.id);
    n.gone = true;
    const respawnAt = nextNoon(now);
    this.state.cellNext = this.state.cellNext || {};
    this.state.cellNext[n.cell || this.cellOf(n.lat, n.lon)] = respawnAt;
    // 共用 NPC：所有玩家的地圖上一起消失，重生時間到後出現新的勢力
    const r = this.push(n, (d) => {
      if (d.ident !== n.ident || (d.dc || 0) !== n.dc) return false;
      d.destroyed = { at: now, respawnAt };
      d.dc = n.dc + 1;
      return true;
    });
    if (r && n.sid) {
      // 本機先反映（伺服器確認前也不會再出現）
      const obj = this.game.shared.cache.get(`npc:${n.sid}`);
      if (!obj || obj.data?.dc === n.dc) {
        this.game.shared.cache.set(`npc:${n.sid}`, {
          kind: 'npc', id: n.sid, ver: obj?.ver || 0, data: { ...(obj?.data || { gen: n.gen, ident: n.ident }), gen: n.gen, dc: n.dc + 1, destroyed: { at: now, respawnAt } },
        });
      }
    }
    this.game.bus.emit('npcs:changed');
  }

  /** 地圖顯示：所有 NPC 行程（含掠奪隊） */
  trips(now = Date.now()) {
    // 被擊敗後撤回的隊伍（hidden）仍顯示移動，但不能再被攔截
    return this.list.filter((n) => n.trip && n.trip.endAt > now).map((n) => ({ npc: n, trip: n.trip, p: tripProgress(n.trip, now) }));
  }
}
