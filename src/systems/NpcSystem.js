import { unitPower } from '../utils/math.js';
import { DUNGEONS, DG_CLEAR_M } from '../config/dungeons.js';
import { AssistSystem } from './AssistSystem.js';
import { NPC_ZONE_MAX, NPC_CONFIG, NPC_NAMES, npcAggression, NPC_ASSAULT, NPC_REWARD_MUL, npcQuietSpan, NPC_QUIET, NPC_DAY_SLOW, RALLY_XP, NPC_OFFLINE_RAID } from '../config/npcs.js';
import { xpToNext } from '../config/survivors.js';
import {
  RESOURCE_KEYS, RAID_TRAVEL,
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
import { inWorld } from '../config/world.js';
import { FACTIONS, FACTION_KEYS, FACTION_BASE, cpById, cpAt, factionHq, CP_KIND } from '../config/controlPoints.js';

/**
 * 共用 NPC：位置、名稱、基礎等級由「格子＋世代」決定（所有玩家相同）；
 * 傷亡、等級損失、物資增減、被摧毀等變化寫入共用物件 npc:<格子>:<編號>，大家同步。
 */
export const SHARED_NPC = {
  /** （舊）每個 NPC 據點存在的時間，之後由新的勢力取代；v10.11 起停止自然換批 */
  lifeMs: 48 * 3600000,
  /**
   * v10.11：停止自然換批的時間點（台灣時間 2026-11-07 00:00）。之後世代固定為這個時間點的世代，
   * NPC 據點一直存在到被攻陷為止（已經出現的據點原地保留）。
   */
  freezeAt: Date.UTC(2026, 10, 6, 16, 0, 0),
  /** 每隔多久升一級 */
  levelMs: 2 * 3600000,
  /** 自然升級的上限：最多比出生時高幾級（停止換批後避免全部長到最高等級） */
  maxGrowth: 15,
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
    this.createdAt = Date.now();
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
    return { wall: Math.round((400 + n.level * 160) * NPC_ASSAULT.wall), dps: Math.round((10 + n.level * 5) * NPC_ASSAULT.dps) };
  }

  /**
   * 據點守備：掠奪者人數（扣除傷亡）與等級。
   * assault：玩家攻打據點時的守軍（人數與強度提高，需要多人集結）；NPC 外出掠奪的隊伍不受影響。
   */
  garrison(n, { assault = false } = {}) {
    const base = Math.max(0, this.fullCount(n) - (n.wounded || 0));
    const count = assault ? Math.round(base * NPC_ASSAULT.count) : Math.floor(base);
    const enemies = Array.from({ length: count }, () => this.game.combat.createEnemy('raider', n.level));
    enemies.push(this.game.combat.createEnemy('raiderChief', n.level));
    if (assault) enemies.forEach((e) => { e.maxHp = Math.round(e.maxHp * NPC_ASSAULT.hp); e.atk = Math.round(e.atk * NPC_ASSAULT.atk); });
    return enemies;
  }

  /** 攻打這個據點的建議戰力 */
  power(n) {
    return this.garrison(n, { assault: true }).reduce((s, e) => s + e.maxHp * 0.1 + e.atk, 0);
  }

  /** 顯示用的守軍戰力（與倖存者戰力同一套公式，方便比較）；NPC 行為判斷仍用 power() */
  displayPower(n) {
    return this.garrison(n, { assault: true }).reduce((s, e) => s + unitPower(e), 0);
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
    if (String(cellKey).startsWith('fx:')) return this.factionSlot(cellKey.slice(3), slot, now);
    const [i, j] = cellKey.split(':').map(Number);
    const sid = `${cellKey}:${slot}`;
    // 密度：部分名額固定沒有 NPC（依種子決定，所有玩家相同）
    if (seeded(`npc-keep:${sid}`, () => randFloat(0, 1)) >= (NPC_CONFIG.keepRatio ?? 1)) return null;
    const offset = seeded(`npc-off:${sid}`, () => randFloat(0, SHARED_NPC.lifeMs));
    // 停止自然換批：超過 freezeAt 後世代固定
    const gen = Math.floor((Math.min(now, SHARED_NPC.freezeAt ?? Infinity) + offset) / SHARED_NPC.lifeMs);
    const genStart = gen * SHARED_NPC.lifeMs - offset;
    const d = this.sharedOf(sid, gen);
    const dc = d?.dc || 0;
    if (d?.destroyed && now < d.destroyed.respawnAt) return null;
    const bornAt = dc > 0 && d?.destroyed ? d.destroyed.respawnAt : genStart;
    const ident = `${sid}:${gen}:${dc}`;
    const box = cellBox(i, j, NPC_CONFIG.cellKm);
    const npc = seeded(`npc:${ident}`, () => {
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
    // 不會出現在地下感染區（副本）入口附近：推到 DG_CLEAR_M 以外（所有玩家算法相同）
    Object.values(DUNGEONS).forEach((dg) => {
      const dist = haversine(npc.lat, npc.lon, dg.lat, dg.lon);
      if (dist >= DG_CLEAR_M) return;
      const kLat = 111320;
      const kLon = 111320 * Math.cos((dg.lat * Math.PI) / 180);
      let dx = (npc.lon - dg.lon) * kLon;
      let dy = (npc.lat - dg.lat) * kLat;
      const len = Math.hypot(dx, dy);
      if (len < 1) { dx = 0; dy = 1; } else { dx /= len; dy /= len; }
      npc.lat = dg.lat + (dy * DG_CLEAR_M) / kLat;
      npc.lon = dg.lon + (dx * DG_CLEAR_M) / kLon;
    });
    // 被攻陷後重生的據點：至少 respawnMinLevel 級
    if (dc > 0) npc.baseLevel = Math.max(npc.baseLevel, this.minLevel(npc));
    return npc;
  }

  /**
   * v14：三大勢力的 NPC 據點：每擁有 3 個控制點建 1 座（最多 4 座），起始 Lv35，建在自己最靠前線的控制點附近。
   * 被摧毀後 36 小時才重建（共用資料 destroyed）。
   */
  /**
   * v15.14：勢力據點清單（共用、全域）：{ list: [{ cp, at }] }。據點建好後固定在那個控制點，
   * 控制點變少也不會消失，只有被玩家打掉才移除；勢力打下控制點、數量達到門檻時才蓋新的（不再計時重生）。
   */
  factionRec(f) {
    return this.game.shared?.get(CP_KIND, `fbase:${f}`) || null;
  }

  /** 目前存在的勢力據點（只算勢力還擁有的控制點），依由西到東排序 */
  factionAlive(f) {
    const rec = this.factionRec(f);
    if (!rec) return null;
    const owned = new Set(this.game.cp?.factionCps(f) || []);
    // 被打掉（共用資料的 destroyed 晚於建立時間）的不算，等清單更新移除
    const gone = (b) => (this.sharedOf(`fx:${f}:${b.cp}`, 0)?.destroyed?.at || 0) >= (b.at || 0);
    return (rec.list || []).filter((b) => owned.has(b.cp) && cpById(b.cp) && !gone(b))
      .sort((a, b) => cpById(a.cp).lon - cpById(b.cp).lon);
  }

  /** 舊規則（依控制點數即時算出）的據點：只用來在第一次建立清單時保留已經存在的據點 */
  legacyFactionList(f, now = Date.now()) {
    const cps = this.game.cp?.factionCps(f) || [];
    const count = Math.min(FACTION_BASE.max, Math.floor(cps.length / FACTION_BASE.perCps));
    return cps.map((id) => cpById(id)).filter(Boolean).sort((a, b) => a.lon - b.lon).slice(0, count)
      .map((cp) => ({ cp: cp.id, d: this.sharedOf(`fx:${f}:${cp.id}`, 0) }))
      .filter(({ d }) => !(d?.destroyed && now < d.destroyed.respawnAt))
      .map(({ cp, d }) => ({ cp, at: d?.destroyed?.respawnAt || SHARED_NPC.freezeAt }));
  }

  /** 共用清單：第一次建立（保留目前已存在的據點）、移除已不屬於這個勢力的控制點 */
  async syncFactionRecs(now = Date.now()) {
    const g = this.game;
    if (!g.cp?.ready?.() || !g.shared || this.recBusy) return;
    this.recBusy = true;
    try {
      for (const f of FACTION_KEYS) {
        const rec = this.factionRec(f);
        const owned = new Set(g.cp.factionCps(f) || []);
        // 伺服器會清除太久沒更新的共用資料：每天更新一次時間
        const stale = rec && now - (rec.touchedAt || 0) > 24 * 3600000;
        if (rec && !stale && !(rec.list || []).some((b) => !owned.has(b.cp))) continue;
        // eslint-disable-next-line no-await-in-loop
        await g.shared.update(CP_KIND, `fbase:${f}`, (x) => {
          if (!x) return { data: { list: this.legacyFactionList(f, now), touchedAt: now } };
          const list = (x.list || []).filter((b) => owned.has(b.cp));
          if (list.length === (x.list || []).length && now - (x.touchedAt || 0) <= 24 * 3600000) return { fail: 'same' };
          return { data: { ...x, list, touchedAt: now } };
        }, { lat: null, lon: null });
      }
    } finally { this.recBusy = false; }
  }

  /** 勢力打下控制點後：據點數少於「控制點數 ÷ 3」（最多 4 座）時，在最西邊還沒有據點的控制點蓋一座 */
  async factionBuild(f, now = Date.now()) {
    const g = this.game;
    if (!FACTIONS[f] || !g.shared) return null;
    const cps = (g.cp?.factionCps(f) || []).map((id) => cpById(id)).filter(Boolean).sort((a, b) => a.lon - b.lon);
    const want = Math.min(FACTION_BASE.max, Math.floor(cps.length / FACTION_BASE.perCps));
    let built = null;
    await g.shared.update(CP_KIND, `fbase:${f}`, (x) => {
      const owned = new Set(cps.map((c) => c.id));
      const list = (x ? x.list || [] : this.legacyFactionList(f, now)).filter((b) => owned.has(b.cp));
      if (list.length >= want) return x ? { fail: 'enough' } : { data: { list } };
      const cp = cps.find((c) => !list.some((b) => b.cp === c.id));
      if (!cp) return { fail: 'full' };
      built = cp.id;
      return { data: { ...(x || {}), list: [...list, { cp: cp.id, at: now }] } };
    }, { lat: null, lon: null });
    if (built) g.bus?.emit('npcs:changed');
    return built;
  }

  factionSlot(f, slot, now = Date.now()) {
    if (!FACTIONS[f]) return null;
    const alive = this.factionAlive(f);
    // 共用清單還沒建立（剛更新到這一版、或還沒讀到）：沿用舊規則
    if (!alive) return this.factionSlotLegacy(f, slot, now);
    if (!alive.length) return slot === 0 ? this.factionHqNpc(f) : null;
    const b = alive[slot];
    if (!b) return null;
    return this.factionNpcAt(f, cpById(b.cp), b.at);
  }

  /** 在某個控制點的勢力據點（位置、名字依控制點與被打掉次數決定，所有玩家相同） */
  factionNpcAt(f, cp, bornAt) {
    const sid = `fx:${f}:${cp.id}`;
    const gen = 0;
    const d = this.sharedOf(sid, gen);
    const dc = d?.dc || 0;
    const ident = `${sid}:${gen}:${dc}:p3`;
    const npc = seeded(`npc:${ident}`, () => {
      const { lat, lon } = this.factionSpot(cp, randFloat(0, Math.PI * 2));
      return {
        sid, ident, gen, dc, cell: `fx:${f}`, lat, lon, bornAt, baseLevel: FACTION_BASE.level,
        faction: f, cp: cp.id, name: pick(NPC_NAMES),
        resources: {
          food: randInt(60, 160), wood: randInt(60, 200), fuel: randInt(10, 60), scrap: randInt(10, 40), nail: randInt(10, 40), bandage: randInt(0, 4),
        },
        coins: randInt(40, 120),
      };
    });
    npc.baseLevel = Math.max(npc.baseLevel, FACTION_BASE.level);
    return npc;
  }

  /** （v15.13 以前）依控制點數即時算出的勢力據點 */
  factionSlotLegacy(f, slot, now = Date.now()) {
    const cps = this.game.cp?.factionCps(f) || [];
    const count = Math.min(FACTION_BASE.max, Math.floor(cps.length / FACTION_BASE.perCps));
    // 沒有任何據點時，改由大本營出兵（大本營不能攻打、不會探索）
    if (!count) return slot === 0 ? this.factionHqNpc(f) : null;
    if (slot >= count) return null;
    // 最靠近前線（最西邊）的控制點優先
    const list = cps.map((id) => cpById(id)).sort((a, b) => a.lon - b.lon);
    const cp = list[slot];
    if (!cp) return null;
    // v15.5.2：共用資料（被摧毀、重生時間）綁定在控制點上，不是第幾座：
    // 勢力的控制點增減讓排序改變時，才不會把「被打下」的紀錄套到另一座據點
    const sid = `fx:${f}:${cp.id}`;
    const gen = 0;
    const d = this.sharedOf(sid, gen);
    const dc = d?.dc || 0;
    if (d?.destroyed && now < d.destroyed.respawnAt) return null;
    const ident = `${sid}:${gen}:${dc}:p3`;
    const npc = seeded(`npc:${ident}`, () => {
      const { lat, lon } = this.factionSpot(cp, randFloat(0, Math.PI * 2));
      return {
        sid, ident, gen, dc, cell: `fx:${f}`, lat, lon, bornAt: d?.destroyed?.respawnAt || SHARED_NPC.freezeAt, baseLevel: FACTION_BASE.level,
        faction: f, cp: cp.id, name: pick(NPC_NAMES),
        resources: {
          food: randInt(60, 160), wood: randInt(60, 200), fuel: randInt(10, 60), scrap: randInt(10, 40), nail: randInt(10, 40), bandage: randInt(0, 4),
        },
        coins: randInt(40, 120),
      };
    });
    npc.baseLevel = Math.max(npc.baseLevel, FACTION_BASE.level);
    return npc;
  }

  /**
   * v15：勢力據點的位置：在自己的控制點裡面，警戒範圍（最大等級時）也不超出這個控制點，並避開控制點圓點。
   * 只依控制點與起始角度決定（所有玩家相同）。
   */
  factionSpot(cp, ang0 = 0) {
    // 位置計算沿用 Lv40 的警戒範圍（v15.14 上限提高後已經建好的據點位置不變）
    const R = 60 + 40 + 10;
    const kLat = 111320;
    const kLon = 111320 * Math.cos((cp.lat * Math.PI) / 180);
    const at = (lat, lon, r, a) => ({ lat: lat + (Math.sin(a) * r) / kLat, lon: lon + (Math.cos(a) * r) / kLon });
    const ring = (p, r) => Array.from({ length: 16 }, (_, i) => at(p.lat, p.lon, r, (i / 16) * Math.PI * 2)).every((q) => cpAt(q.lat, q.lon)?.id === cp.id);
    // 控制點內所有候選點（20 公尺格線）依「離邊界的距離」分級，快取起來（每個控制點只算一次）
    this.spotCache = this.spotCache || {};
    if (!this.spotCache[cp.id]) {
      const mark = this.game.cp?.markerSpot?.(cp.id);
      const list = [];
      for (let dy = -800; dy <= 800; dy += 20) {
        for (let dx = -800; dx <= 800; dx += 20) {
          const p = { lat: cp.lat + dy / kLat, lon: cp.lon + dx / kLon };
          if (cpAt(p.lat, p.lon)?.id !== cp.id) continue;
          if (mark && haversine(mark.lat, mark.lon, p.lat, p.lon) < 70) continue;
          let r = 0;
          for (const t of [R, R * 0.85, R * 0.7, R * 0.55, R * 0.4]) if (ring(p, t)) { r = t; break; }
          list.push({ ...p, r });
        }
      }
      const best = Math.max(0, ...list.map((x) => x.r));
      this.spotCache[cp.id] = list.filter((x) => x.r === best);
    }
    const pool = this.spotCache[cp.id];
    if (!pool.length) return at(cp.lat, cp.lon, 80, ang0);
    const k = Math.floor(((ang0 / (Math.PI * 2)) % 1) * pool.length);
    const p = pool[Math.max(0, Math.min(pool.length - 1, k))];
    return { lat: p.lat, lon: p.lon };
  }

  /** 大本營出兵用的 NPC（地圖上顯示為大本營，不能攻打） */
  factionHqNpc(f) {
    const sid = `fx:${f}:hq`;
    const hq = factionHq(f);
    return {
      sid, ident: `${sid}:0:0`, gen: 0, dc: 0, cell: `fx:${f}`, lat: hq.lat, lon: hq.lon, bornAt: SHARED_NPC.freezeAt, baseLevel: FACTION_BASE.hqLevel,
      faction: f, hq: true, name: `${FACTIONS[f].name}大本營`,
      resources: { food: 0, wood: 0, fuel: 0 }, coins: 0,
    };
  }

  /** v15.14：等級上限依所在區域（安全 25、一般 35、警戒 40、危險 45、其他 50） */
  levelCap(n) {
    // 勢力大本營在地圖外的勢力領地（區域判斷不適用）
    if (n?.hq) return NPC_CONFIG.maxLevel;
    const z = Number.isFinite(n?.lat) ? zoneAt(n.lat, n.lon)?.id : null;
    return Math.min(NPC_CONFIG.maxLevel, NPC_ZONE_MAX[z] ?? NPC_CONFIG.maxLevel);
  }

  /** 最低等級：被攻陷後重生的據點至少 respawnMinLevel 級，其餘 1 級 */
  minLevel(n) {
    if (!((n?.dc || 0) > 0)) return 1;
    // v15.10：重生最低等級依區域（安全區、一般區、警戒區較低）
    const z = Number.isFinite(n.lat) ? zoneAt(n.lat, n.lon)?.id : null;
    return Math.min(this.levelCap(n), NPC_CONFIG.respawnMinByZone?.[z] ?? NPC_CONFIG.respawnMinLevel ?? 1);
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

  /** 連線中、還沒讀到第一次共用 NPC 資料（最多等 30 秒，讀不到就照常產生） */
  waitingShared() {
    const sh = this.game.shared;
    // 只在有存檔裡的 NPC 可以先顯示時等待（新遊戲直接產生）
    return !!(sh?.online && !sh.listedAt?.npc && this.state?.list?.length && Date.now() - (this.createdAt || 0) < 30000);
  }

  /** 共用資料（不是同一世代的舊資料視為沒有） */
  sharedOf(sid, gen) {
    const d = this.game.shared?.get('npc', sid);
    return d && d.gen === gen ? d : null;
  }

  /** 共用 NPC 目前的等級：基礎等級＋存在時間成長（最多 +maxGrowth）－被擊退的損失 */
  sharedLevel(n, now = Date.now()) {
    return Math.max(this.minLevel(n), Math.min(this.levelCap(n), n.baseLevel + Math.min(SHARED_NPC.maxGrowth ?? Infinity, Math.floor(Math.max(0, now - n.bornAt) / SHARED_NPC.levelMs)) - (n.levelLoss || 0)));
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

  /** v15.8：每次補回的傷亡份數（攻打據點時的 1 名守軍） */
  static get HEAL_STEP() { return 1 / NPC_ASSAULT.count; }

  /** 共用 NPC：傷亡隨時間補回 */
  static healTo(d, now, full) {
    while (d.wounded > 0 && d.healAt && now >= d.healAt) {
      d.wounded = Math.max(0, d.wounded - NpcSystem.HEAL_STEP);
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
    // 連線中但還沒讀到共用 NPC 資料（剛開遊戲）：先保留存檔裡的 NPC，不要用不完整的資料重建
    // （否則會先出現已被摧毀的舊勢力或沒扣掉等級損失的等級，資料讀到後等級又突然下降）
    if (this.waitingShared()) return 0;
    // 玩家據點附近（警戒範圍，或至少 300 公尺）不會有 NPC：所有玩家據點都一樣
    const zones = this.playerZones().map((z) => ({ ...z, r: Math.max(z.r, NPC_CONFIG.minFromShelterM) }));
    const inAlert = (p) => zones.some((z) => haversine(z.lat, z.lon, p.lat, p.lon) <= z.r);
    // v13：只出現在固定世界地圖範圍內（所有玩家看到的相同）
    const inView = (p) => inWorld(p.lat, p.lon, 60);
    // 哪些格子有 NPC：只看固定格子產生的地點（v10，所有玩家相同）；舊地圖沒有時才用全部建築
    const pois = this.game.state.map.pois;
    const real = pois.filter((p) => String(p.id).startsWith('w_'));
    const cells = new Set();
    // v14：新地圖只有三大勢力的 NPC 據點（建在自己的控制點附近）
    if (this.game.state.map.source === 'generated' && this.game.cp) FACTION_KEYS.forEach((f) => cells.add(`fx:${f}`));
    else (real.length ? real : pois).forEach((p) => cells.add(this.cellOf(p.lat, p.lon)));
    const want = [];
    cells.forEach((key) => {
      const inCell = [];
      for (let slot = 0; slot < (String(key).startsWith('fx:') ? FACTION_BASE.max : NPC_CONFIG.perCell); slot += 1) {
        const s = this.slotNpc(key, slot, now);
        if (!s) continue;
        // 同一格裡靠太近的 NPC 只保留編號小的：只依格子本身判斷，與各玩家看到的範圍無關（所有玩家相同）
        if (inCell.some((x) => haversine(x.lat, x.lon, s.lat, s.lon) < 120)) continue;
        inCell.push(s);
        if (haversine(o.lat, o.lon, s.lat, s.lon) < NPC_CONFIG.minFromShelterM || inAlert(s) || !inView(s)) continue;
        want.push(s);
      }
    });
    NpcSystem.uniqueNames(want);
    const keep = new Set(want.map((s) => s.ident));
    const before = this.list.length;
    // 不再存在的共用 NPC 移除（正在掠奪途中的隊伍保留到結束）
    // 已被摧毀（共用資料的 dc 變大）的據點：立刻移除；只有正在掠奪途中的隊伍保留到結束（探索隊一起消失）
    const destroyed = (n) => { const sd = n.sid && this.game.shared?.get('npc', n.sid); return !!sd && (sd.dc || 0) > (n.dc || 0); };
    this.state.list = this.list.filter((n) => !n.sid || (keep.has(n.ident) && !destroyed(n))
      || (n.trip && n.trip.endAt > now && !n.gone && (!destroyed(n) || n.trip.kind === 'raid')));
    // 已經在地圖上的 NPC 也套用不重複的名字（v12 改名後舊存檔的 NPC 一起更新）
    const nameOf = new Map(want.map((s) => [s.ident, s.name]));
    this.list.forEach((n) => { if (n.sid && nameOf.has(n.ident)) n.name = nameOf.get(n.ident); });
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

  /**
   * 同一張地圖上的 NPC 名稱不重複：依編號排序，撞名時依編號決定的固定間隔往後找沒用過的名字
   * （同一批 NPC 每位玩家算出來的結果相同）。
   */
  static uniqueNames(list) {
    const used = new Set();
    [...list].sort((a, b) => String(a.sid).localeCompare(String(b.sid))).forEach((s) => {
      if (s.hq) return; // 大本營用固定名稱
      let idx = Math.max(0, NPC_NAMES.indexOf(s.name));
      let h = 0;
      for (const ch of String(s.sid)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
      const step = 1 + (h % 97);
      for (let k = 0; k < NPC_NAMES.length && used.has(NPC_NAMES[idx]); k += 1) idx = (idx + step) % NPC_NAMES.length;
      if (used.has(NPC_NAMES[idx])) idx = Math.max(0, NPC_NAMES.findIndex((x) => !used.has(x)));
      s.name = NPC_NAMES[idx];
      used.add(s.name);
      // v14：三大勢力的據點名稱前面加上勢力名
      if (s.faction && FACTIONS[s.faction]) s.name = `${FACTIONS[s.faction].name}・${s.name}`;
    });
    return list;
  }

  /** 由共用格子資料建立 NPC（本機另外記錄自己的行動時間） */
  materialize(s, now = Date.now()) {
    const coins = s.coins * (s.baseLevel + 5);
    const n = {
      id: `npc_${s.ident.replace(/:/g, '_')}`,
      sid: s.sid,
      ident: s.ident,
      ...(s.faction ? { faction: s.faction, cp: s.cp } : {}),
      ...(s.hq ? { hq: true } : {}),
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
      ...this.list.map((n) => ({ lat: n.lat, lon: n.lon, r: 60 + Math.min(40, n.level || 0) })),
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
      startLevel: level,
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
    // v15.8：白天（台灣時間 08:00～00:00）掠奪次數減半（凌晨完全不掠奪）
    return (NPC_CONFIG.raidBaseMs * NPC_DAY_SLOW * crowd / (0.3 + this.aggression())) * randFloat(0.7, 1.3);
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
    // v15.14：勢力據點清單（第一次建立、移除已失去的控制點）
    if (now >= (this.recSyncAt || 0)) { this.recSyncAt = now + 60000; this.syncFactionRecs(now).catch(() => {}); }
    if (now >= (st.nextSpawnAt || 0)) {
      // 第一次（或重新掃描後）一次補齊，不逐一記錄
      const first = !this.list.some((n) => n.sid);
      const added = this.fillCells(now, { silent: first });
      if (first && added) this.game.log(`🏴‍☠️ 附近有 ${added} 個 NPC 勢力據點（所有倖存者看到的相同）`, 'danger');
      st.nextSpawnAt = now + 60000;
    }
    this.list.forEach((n) => {
      // 傷亡人員逐漸補回
      if (n.wounded > 0) {
        n.healAt = n.healAt || now + NPC_CONFIG.woundHealMs;
        while (n.wounded > 0 && now >= n.healAt) {
          n.wounded = Math.max(0, n.wounded - NpcSystem.HEAL_STEP);
          n.healAt += NPC_CONFIG.woundHealMs;
        }
        if (!n.wounded) n.healAt = 0;
      }
      // （v10.9：NPC 據點不再需要抵禦屍潮，等級不會因此下降）
      // 升級（共用 NPC 依存在時間計算）
      if (n.sid) n.level = this.sharedLevel(n, now);
      if (!n.sid && n.startLevel == null) n.startLevel = n.level;
      let guard = 0;
      while (now >= n.nextLevelAt && guard < 20) {
        guard += 1;
        if (n.level < Math.min(this.levelCap(n), (n.startLevel ?? n.level) + (SHARED_NPC.maxGrowth ?? Infinity))) n.level += 1;
        n.nextLevelAt += rand(NPC_CONFIG.levelUpMs);
      }
      if (n.trip) this.checkCrossings(n, now);
      // 掠奪隊抵達時立即交戰，之後返回據點
      if (n.trip?.kind === 'raid' && !n.trip.resolved && now >= this.arriveAt(n.trip)) {
        n.trip.resolved = true;
        // 這次防守的戰鬥明細記在避難所紀錄裡
        const holder = { battleIds: [] };
        this.game.combat.within(holder, () => this.resolveIncoming(n, n.trip, now, holder));
      }
      if (!this.list.includes(n)) return;
      if (n.trip && now >= n.trip.endAt) this.finishTrip(n, now);
      // 有傷員時要先治療（補回人手）才會外出探索或掠奪
      if (n.wounded > 0) return;
      if (!n.trip && now >= n.nextRaidAt) this.launchRaid(n, now);
      if (!n.trip && now >= n.nextExploreAt) this.launchExplore(n, now);
    });
  }

  /**
   * 攻打據點（守軍為平時的 NPC_ASSAULT.count 倍）時擊倒的人數換算成據點傷亡：
   * 擊倒幾名守軍，下次攻打就只少幾名（不再加倍扣除）。
   */
  assaultWound(n, kills, now = Date.now()) {
    return this.wound(n, Math.min(kills / NPC_ASSAULT.count, this.fullCount(n)), now);
  }

  /** NPC 人員傷亡（依 woundHealMs 逐一補回） */
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
    } else n.level = Math.max(this.minLevel(n), n.level - by);
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
      view.wounded = Math.round((n.wounded || 0) * NPC_ASSAULT.count); // 攻打據點時的守軍傷亡人數
    }
    if (lv >= 5) {
      view.resources = Object.entries(n.resources).filter(([, v]) => v > 0).map(([k, v]) => [k, lv >= 7 ? `${Math.floor(v)}` : approx(v, 50)]);
      view.coins = lv >= 7 ? `${n.coins}` : approx(n.coins, 100);
    }
    if (lv >= 7) view.power = this.displayPower(n);
    if (lv >= 9) view.nextRaid = Math.max(0, n.nextRaidAt - now);
    if (lv >= 11) view.defense = this.defense(n); // v15.10：圍牆耐久與防禦火力
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
    if (n.hq) return; // 大本營只出兵掠奪，不探索
    const targets = this.game.state.map.pois.filter((p) => !this.game.shelter.baseAtPoi(p.id)
      && !this.list.some((m) => m.poiId === p.id)
      && POI_TYPES[p.type] && !this.game.poiShare.view(p, now).empty
      && haversine(n.lat, n.lon, p.lat, p.lon) <= NPC_CONFIG.exploreRadiusM
      // v15：勢力據點只探索自己勢力控制點內的建築
      && (!n.faction || this.game.cp?.factionOf(cpAt(p.lat, p.lon)?.id) === n.faction));
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
    if (this.game.time.siegeTime(now)) return;
    const bases = this.game.state.bases;
    if (!bases.length) return;
    // 盡量避免多個 NPC 同時攻打玩家：已經有掠奪隊在路上時大多會放棄，玩家文明度很高時才比較常發生
    if (!this.allowConcurrentRaid(now)) return;
    // 等級差太大不出手：避免高等 NPC 一面倒地掠奪等級低很多的玩家
    if (n.level > this.raidLevelCap()) return;
    // v15.7：勢力的控制點還沒推進到最西側一排（緊鄰玩家）時，只攻打控制點、不攻打玩家據點
    if (n.faction && !this.game.cp?.factionReachedWest?.(n.faction)) return;
    const base = pick(bases);
    const t = this.tripTimes(n, base, 0, base.id);
    // 掠奪避難所的移動時間較長，讓玩家有時間準備防守
    t.travelMs = Math.round(Math.max(t.travelMs * RAID_TRAVEL.npcMul, RAID_TRAVEL.minMin * 60000));
    // v15.10：偵查 Lv15：NPC 掠奪隊的行軍時間 +10%（多一點準備時間）
    if (this.intel() >= 15) t.travelMs = Math.round(t.travelMs * 1.1);
    // v15.10：現實凌晨（台灣時間 00:00～08:00）每位玩家每 3 小時最多被掠奪一次（出發或抵達落在這段時間都算）
    const night = npcQuietSpan(now, now + t.travelMs);
    if (night && now - (this.game.state.npcNightRaidAt || 0) < NPC_QUIET.gapMs) return;
    if (night) this.game.state.npcNightRaidAt = now;
    // 抵達時若在屍潮時段（22:00～06:00），NPC 會放棄這次掠奪
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
    if (trip.kind === 'explore' && !trip.recalled) {
      const poi = this.game.state.map.pois.find((p) => p.id === trip.poiId);
      const at = this.arriveAt(trip);
      // 探索途中遭遇殭屍：可能有人受傷，要治療（補回人手）後才能再外出
      if (poi) {
        const night = this.game.time.phase(at).zombies ? 1.6 : 1;
        if (chance(NPC_CONFIG.exploreInjuryChance * this.game.zombies.encounterMul(poi.lat, poi.lon) * night)) this.wound(n, chance(0.3) ? 2 : 1, now);
      }
      const view = poi && this.game.poiShare.view(poi, at);
      if (!poi || view.empty) return;
      const stock = stockOf(poi, at, view);
      this.addResources(n, Object.fromEntries(Object.entries(stock.resources).map(([k, v]) => [k, Math.round(v * 0.6)])));
      // NPC 探索過的建築（自己的地圖）：恢復時間內沒有物資
      this.game.poiShare.markNpc(poi, at + (trip.searchMs || 0), n.name);
      this.game.bus.emit('map:changed');
    }
  }

  /**
   * v15.4：NPC 探索中，目標建築所在的控制點不再屬於自己的勢力時，強制撤回（從目前位置走回據點，沒有收穫）。
   */
  recallLostTrips(now = Date.now()) {
    const g = this.game;
    if (g.state.map?.source !== 'generated' || !g.cp) return 0;
    let n0 = 0;
    this.list.forEach((n) => {
      const trip = n.trip;
      if (!n.faction || trip?.kind !== 'explore' || trip.recalled || now >= trip.endAt) return;
      const poi = g.state.map.pois.find((p) => p.id === trip.poiId);
      const cp = poi && cpAt(poi.lat, poi.lon);
      if (!cp || g.cp.factionOf(cp.id) === n.faction) return;
      const travel = trip.travelMs || 0;
      const search = trip.searchMs ?? 0;
      const t = now - trip.startAt;
      if (t >= travel + search) return; // 已經在回程
      const r = travel > 0 ? Math.min(1, t / travel) : 1;
      trip.searchMs = search;
      trip.startAt = now - (travel + search + travel * (1 - r));
      trip.endAt = now + travel * r;
      trip.recalled = true;
      n0 += 1;
    });
    if (n0) g.bus.emit('npcs:changed');
    return n0;
  }

  /** NPC 掠奪隊抵達玩家據點 */
  resolveIncoming(n, trip, now, holder = null) {
    const g = this.game;
    const base = g.shelter.base(trip.baseId);
    const arrive = this.arriveAt(trip);
    if (!base) return;
    if (g.time.siegeTime(arrive)) {
      g.log(`🏴‍☠️「${n.name}」的掠奪隊見屍潮來襲，撤退了`, 'info');
      g.shelter.recordRetreat(base, `NPC「${n.name}」（${this.intelView(n).levelShort}）`);
      return;
    }
    // 1. 掠奪者要先打破圍牆，期間防禦設施持續射擊
    const all = this.garrison(n);
    const raiders = all.length;
    const siege = g.siege.of(base.id);
    const wallBefore = g.shelter.wallHp(base);
    // 友好玩家的協防隊：守城時一起射擊，圍牆被打破後一起迎戰
    const isHome = g.shelter.isPrimary(base);
    // v15.3.1：防禦範圍涵蓋這裡的好友，防禦設施也會協助（kind cover）
    const helpers = isHome ? g.assist.incoming().filter((h) => h.kind === 'team' || h.kind === 'cover') : [];
    const allies = isHome ? g.assist.allyUnits() : [];
    const helpDps = helpers.reduce((s, h) => s + (h.dps || 0), 0);
    const severeBefore = new Set(g.state.survivors.filter((sv) => sv.severe).map((sv) => sv.id));
    // 防守前的生命：結算傷勢時只列出這次真的受傷的人（升級或原本就沒滿血都不算）
    const hpBefore = new Map(g.state.survivors.map((sv) => [sv.id, g.survivors.hpOf(sv)]));
    const as = g.combat.wallAssault(all, wallBefore, siege.defenseDps({ raw: true }) * (1 + g.research.bonus('raidDefensePct')) + helpDps);
    // v15.10：不在線（畫面沒開）超過 30 分鐘：圍牆與資源損失減半
    const offline = arrive - (g.state.activeAt || arrive) > NPC_OFFLINE_RAID.afterMs;
    base.wallHp = Math.max(0, offline ? Math.round(wallBefore - (wallBefore - as.wallLeft) * NPC_OFFLINE_RAID.lossMul) : as.wallLeft);
    // 守城時：近戰防守的人會受傷，對方有遠程武器時遠程防守的人也可能中彈
    const wallGuards = [...siege.guards().map((x) => x.sv), ...base.defenses.map((d) => g.shelter.towerGuard(d)).filter(Boolean)];
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
      const reward = this.raidReward(n, all, as, result, participants, severeBefore, hpBefore);
      g.state.stats.battlesWon += 1;
      const how = !as.breached
        ? (enemies.length ? `圍牆撐住了 ${as.sec} 秒，掠奪隊放棄撤退` : '防禦設施在圍牆被打破前擊退了掠奪隊')
        : `圍牆被打破，防守人員（${defenders.map((d) => d.name).join('、')}）擊退了掠奪隊`;
      const entry = g.shelter.recordDefense({ battleIds: holder?.battleIds,
        base, attacker: label, success: true, kills, injured, wallLost: as.wallLost, note: [how, assistNote].filter(Boolean).join('。'), reward,
      });
      g.toast(`🛡️「${base.name}」擊退了「${n.name}」的掠奪隊！`, 'success');
      g.bus.emit('raid:result', entry);
      if (!n.hq) this.levelDown(n);
      g.bus.emit('npc:raid', { npcId: n.id, baseId: base.id, victory: true });
      return;
    }
    void raiders;
    // 掠奪成功：搶走資源與部分金錢，圍牆受損
    const res = g.state.resources;
    const stolen = {};
    RESOURCE_KEYS.forEach((k) => {
      stolen[k] = Math.floor(g.shelter.exposed(k) * NPC_CONFIG.raidStealPct * (offline ? NPC_OFFLINE_RAID.lossMul : 1)); // 地窖裡的搶不走
      res[k] -= stolen[k];
    });
    const coins = Math.floor(g.shelter.exposed('coins') * 0.1 * (offline ? NPC_OFFLINE_RAID.lossMul : 1));
    g.state.player.coins -= coins;
    this.addResources(n, stolen, coins);
    g.state.stats.battlesLost += 1;
    const damaged = siege.damageBuildings(base);
    g.shelter.recordDefense({ battleIds: holder?.battleIds,
      base, attacker: label, success: false, lost: stolen, coins, kills, damaged, injured: ShelterSystem.newlySevere(severeBefore, defenders),
      wallLost: Math.max(0, wallBefore - base.wallHp), note: [`圍牆被打破；${offline ? '（你不在線，損失減半）' : ''}${defenders.length || allies.length ? `防守人員（${[...defenders.map((d) => d.name), ...allies.map((a) => a.name)].join('、')}）戰敗` : '據點裡沒有人可以防守'}`, assistNote].filter(Boolean).join('。'),
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
  raidReward(n, all, as, result, participants, severeBefore, hpBefore = new Map()) {
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
    // 傷勢（在發經驗前計算，避免升級拉高生命上限被誤判）：重傷、交戰中被擊倒、或生命比防守前少
    const downIds = new Set((result?.team || []).filter((u) => u.down).map((u) => u.id));
    const hurt = participants.filter((sv) => !severeBefore.has(sv.id)
      && (sv.severe || downIds.has(sv.id) || g.survivors.hpOf(sv) < (hpBefore.get(sv.id) ?? Infinity) - 0.5))
      .map((sv) => ({ name: sv.name, severe: !!sv.severe, down: downIds.has(sv.id), pct: Math.round((g.survivors.hpOf(sv) / g.survivors.maxHp(sv)) * 100) }));
    const xp = participants.map((sv) => {
      const amount = Math.round(xpToNext(sv.level) * R.xpPct);
      const level = sv.level;
      g.survivors.gainXp(sv, amount);
      return { name: sv.name, level, xp: amount };
    });
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
  resolveRaid(exp, at = exp.endAt) {
    const g = this.game;
    const n = this.get(exp.poiId);
    const members = exp.memberIds.map((id) => g.survivors.get(id)).filter(Boolean);
    const report = {
      id: uid('rp'), poiName: n ? `🏴‍☠️ ${n.name}` : 'NPC 據點', poiType: 'military', at: at,
      events: [...(exp.travelEvents || [])], resources: {}, items: [], blueprints: [],
      kills: exp.travelKills || 0, xp: exp.travelXp || 0, success: false, members: members.map((m) => m.name),
    };
    if (!n || !members.length) {
      report.events.push('🏚️ 抵達時據點已經人去樓空。');
      return report;
    }
    const enemies = this.garrison(n, { assault: true });
    report.events.push(`⚔️ 攻打「${n.name}」（Lv${n.level}）：守軍 ${enemies.length} 人${n.wounded ? `（另有 ${n.wounded * NPC_ASSAULT.count} 人傷亡中）` : ''}`);
    // 1. 先打破 NPC 據點的圍牆：期間據點的防禦火力持續射擊，被擊倒的隊員重傷
    const df = this.defense(n);
    const attackers = members.map((m) => ({ sv: m, maxHp: Math.max(1, g.survivors.hpOf(m)), atk: g.survivors.stats(m).atk }));
    const as = g.combat.wallAssault(attackers, df.wall, df.dps);
    attackers.forEach((a) => {
      if (!as.alive.includes(a)) g.survivors.battleDown(a.sv, '在攻打 NPC 據點時被防禦火力擊倒', at, RALLY_XP.downPct);
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
    g.combat.applyOutcome(fighters, result, at, { attackXp: RALLY_XP });
    report.kills += result.kills.length;
    report.xp += result.xp;
    if (result.winBonus?.length) report.events.push(`🏆 勝利經驗：${result.winBonus.join('、')}`);
    if (!result.victory) {
      g.state.stats.battlesLost += 1;
      this.assaultWound(n, result.kills.length, at);
      report.events.push(`💀 攻打失敗，隊伍撤退！${result.kills.length ? `（擊倒對方 ${result.kills.length} 人，對方需要時間補回人手）` : ''}`);
      return report;
    }
    // 勝利：搶走據點資源（受運載量限制），據點被摧毀
    g.state.stats.battlesWon += 1;
    report.success = true;
    const carry = exp.cargo || members.length * 40;
    const total = Object.entries(n.resources).reduce((s, [k, v]) => s + (v || 0) * unitWeight(k), 0);
    const ratio = total > carry ? carry / total : 1;
    // 攻陷獎勵（v10 提高）：物資、金錢與裝備數量都乘上獎勵倍率
    // v15.11：研究「戰利品搜刮」提高搶到的物資與金錢
    const lootMul = 1 + g.research.bonus('battleLootPct');
    const loot = Object.fromEntries(Object.entries(n.resources).map(([k, v]) => [k, Math.floor((v || 0) * ratio * NPC_REWARD_MUL * lootMul)]));
    // 據點的金錢只搶得到一部分
    report.resources = g.grant({ ...loot, coins: Math.round(n.coins * NPC_COIN_LOOT * NPC_REWARD_MUL * lootMul) });
    if (ratio < 1) report.events.push(`🎒 帶不走全部物資（運載量 ${carry}），留下約 ${Math.round(total - carry)} 重量的物資`);
    for (let i = 0; i < NPC_REWARD_MUL; i += 1) {
      if (!chance(0.6)) continue;
      const item = g.equipment.generate({ level: n.level, boost: 0.3 + zoneAt(n.lat, n.lon).rarityBoost });
      if (g.equipment.addItem(item, '攻打 NPC', members)) report.items.push(item);
    }
    const lockN = g.rebirth?.rollNpc() || 0;
    if (lockN) {
      g.rebirth.addLocks(lockN);
      report.locks = lockN;
      report.events.push(`🔒 在據點的保險箱裡找到「就是要鎖你」×${lockN}`);
    }
    report.events.push(`🏆 攻陷「${n.name}」，據點被摧毀！`);
    g.log(`🏆 攻陷 NPC 據點「${n.name}」`, 'success');
    this.destroy(n, at);
    return report;
  }

  destroy(n, now = Date.now()) {
    this.state.list = this.list.filter((x) => x.id !== n.id);
    n.gone = true;
    const respawnAt = now + (NPC_CONFIG.respawnAfterMs ?? 36 * 3600000);
    this.state.cellNext = this.state.cellNext || {};
    this.state.cellNext[n.cell || this.cellOf(n.lat, n.lon)] = respawnAt;
    // 共用 NPC：所有玩家的地圖上一起消失，重生時間到後出現新的勢力
    const r = this.push(n, (d) => {
      if (d.ident !== n.ident || (d.dc || 0) !== n.dc) return false;
      d.destroyed = { at: now, respawnAt };
      d.dc = n.dc + 1;
      return true;
    });
    // v15.14：勢力據點被打掉：從勢力據點清單移除（不再計時重生，要等勢力再打下控制點才蓋新的）
    if (n.faction && n.cp && !n.hq && this.game.shared) {
      this.game.shared.update(CP_KIND, `fbase:${n.faction}`, (x) => {
        if (!x) return { fail: 'none' };
        const list = (x.list || []).filter((b) => b.cp !== n.cp);
        return list.length === (x.list || []).length ? { fail: 'same' } : { data: { ...x, list } };
      }, { lat: null, lon: null }).catch(() => {});
    }
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
