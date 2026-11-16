import {
  AIRDROP, AIRDROP_ZONE, AIRDROP_AMOUNT, AIRDROP_GUARD_MIX, AIRDROP_FABRIC_MUL,
} from '../config/airdrops.js';
import { SUPPLIES, SUPPLY_KEYS } from '../config/supplies.js';
import { RARITY_ORDER } from '../config/equipment.js';
import { zoneAt } from '../config/zones.js';
import { inWorld } from '../config/world.js';
import { seeded, cellOf } from '../multiplayer/worldGrid.js';
import { generateWorldPois } from '../map/WorldGen.js';
import {
  chance, randFloat, randInt, weightedPick, uid, haversine,
} from '../utils/math.js';
import { baseSupplyWeight } from './LootStock.js';
import { WorldEventSystem } from './WorldEventSystem.js';
import { AssistSystem } from './AssistSystem.js';

/** v16.1：等待隊伍的共用資料大小上限（共用資料每筆上限 16000 位元組，保留結算結果的空間） */
const WAIT_BYTES = 11000;
/** 結算鎖定逾時 */
const LOCK_MS = 60000;
const bytes = (x) => new TextEncoder().encode(JSON.stringify(x)).length;

/**
 * v15.19：全服空投。位置、時間、內容與守衛都由「輪次＋格子」決定，所有玩家相同；
 * 誰搶走寫在共用資料（種類 ad，先到先得）。降落後一段時間沒人搶走，視為被 NPC 勢力拿走。
 */
export class AirdropSystem {
  constructor(game) {
    this.game = game;
    this.slotCache = new Map();
    game.shared?.watch(AIRDROP.kind, 5);
  }

  /** 有建築的格子（地圖固定，第一次用到時計算）：{ key, pois } */
  cells() {
    if (this.cellList) return this.cellList;
    // 用固定世界地圖的建築（所有玩家相同；不含存檔裡保留的舊地點）
    const pois = AirdropSystem.worldPois || (AirdropSystem.worldPois = generateWorldPois());
    const km = AIRDROP.cellKm;
    const map = new Map();
    pois.filter((p) => inWorld(p.lat, p.lon)).forEach((p) => {
      const k = cellOf(p.lat, p.lon, km).key;
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(p);
    });
    this.cellList = [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, list]) => ({ key, pois: list.sort((x, y) => String(x.id).localeCompare(String(y.id))) }));
    return this.cellList;
  }

  static slotOf(t) {
    return Math.floor(t / AIRDROP.slotMs);
  }

  /** 某一輪的全部空投（決定性） */
  slotDrops(slot) {
    if (this.slotCache.has(slot)) return this.slotCache.get(slot);
    const t0 = slot * AIRDROP.slotMs;
    // 補給日：空投機率加倍
    const p = Math.min(0.9, AIRDROP.chance * WorldEventSystem.fx('drop', t0));
    const out = [];
    this.cells().forEach(({ key, pois }) => {
      seeded(`ad:${slot}:${key}`, () => {
        if (!chance(p)) return;
        // 落在格子內某棟建築附近（約 60 公尺內），一定在地圖上
        const base = pois[randInt(0, pois.length - 1)];
        let lat = base.lat + randFloat(-0.0005, 0.0005);
        let lon = base.lon + randFloat(-0.0006, 0.0006);
        if (!inWorld(lat, lon)) { lat = base.lat; lon = base.lon; }
        const zone = zoneAt(lat, lon).id;
        const Z = AIRDROP_ZONE[zone] || AIRDROP_ZONE.safe;
        const landAt = t0 + AIRDROP.announceMs + randFloat(0, AIRDROP.slotMs - AIRDROP.stayMs - AIRDROP.announceMs);
        const mats = {};
        for (let k = 0; k < Z.kinds; k += 1) {
          const tier = randInt(Z.tiers[0], Z.tiers[1]);
          const cat = chance(0.65) ? 'part' : 'fabric';
          const keys = SUPPLY_KEYS.filter((s) => SUPPLIES[s].cat === cat && SUPPLIES[s].tier === tier && SUPPLIES[s].tag !== 'ammo').sort();
          if (!keys.length) continue;
          const sk = weightedPick(Object.fromEntries(keys.map((s) => [s, baseSupplyWeight(s)])));
          const n = Math.max(1, Math.round(AIRDROP_AMOUNT[tier] * (cat === 'fabric' ? AIRDROP_FABRIC_MUL[tier] ?? 1 : 1) * Z.mul * randFloat(0.8, 1.2)));
          mats[sk] = (mats[sk] || 0) + n;
        }
        out.push({
          id: `ad_${slot}_${key.replace(':', '_')}`, slot, lat, lon, zone,
          announceAt: landAt - AIRDROP.announceMs, landAt, expireAt: landAt + AIRDROP.stayMs,
          npcAt: landAt + randInt(AIRDROP.npcMin[0], AIRDROP.npcMin[1]) * 60000,
          mats, coins: randInt(Z.coins[0], Z.coins[1]), parts: randInt(Z.parts[0], Z.parts[1]), bp: chance(Z.bp),
        });
      });
    });
    if (this.slotCache.size > 12) this.slotCache.clear();
    this.slotCache.set(slot, out);
    return out;
  }

  /** 地圖上目前看得到的空投（預告中、已降落、剛被搶走）：前一輪與這一輪 */
  list(now = Date.now()) {
    const s = AirdropSystem.slotOf(now);
    return [...this.slotDrops(s - 1), ...this.slotDrops(s)].filter((d) => now >= d.announceAt && now < d.expireAt);
  }

  get(id, now = Date.now()) {
    const m = String(id).match(/^ad_(-?\d+)_/);
    if (!m) return null;
    return this.slotDrops(Number(m[1])).find((d) => d.id === id) || null;
  }

  /** 狀態：falling（預告中）、landed（可以搶）、taken（被玩家搶走）、npc（被 NPC 勢力拿走）、gone（消失） */
  status(d, now = Date.now()) {
    if (!d) return { state: 'gone' };
    const rec = this.game.shared?.get(AIRDROP.kind, d.id);
    if (rec?.by) return { state: 'taken', by: rec.by, at: rec.at };
    if (now >= d.expireAt) return { state: 'gone' };
    if (now >= d.npcAt) return { state: 'npc' };
    if (now < d.landAt) return { state: 'falling' };
    return { state: 'landed' };
  }

  zoneOf(d) {
    return AIRDROP_ZONE[d.zone] || AIRDROP_ZONE.safe;
  }

  /** 守衛殭屍（強度依區域） */
  guards(d) {
    const G = this.zoneOf(d).guard;
    return Array.from({ length: G.n }, (_, i) => this.game.combat.createEnemy(AIRDROP_GUARD_MIX[i % AIRDROP_GUARD_MIX.length], G.lv, false, { hp: G.mul, atk: G.mul }));
  }

  /** 顯示用：距離與步行時間 */
  distanceTo(d) {
    const sh = this.game.shelter.primary();
    return sh ? Math.round(haversine(sh.lat, sh.lon, d.lat, d.lon)) : 0;
  }

  /** 打贏後拿到的東西（設計圖在搶到時才產生） */
  loot(d) {
    const Z = this.zoneOf(d);
    const blueprints = [];
    if (d.bp) {
      const lv = Z.guard.lv;
      const bp = this.game.equipment.makeBlueprint(lv);
      if (Z.bpMin && RARITY_ORDER.indexOf(bp.rarity) < RARITY_ORDER.indexOf(Z.bpMin)) bp.rarity = Z.bpMin;
      blueprints.push(bp);
    }
    return {
      gained: { ...d.mats, coins: d.coins, parts: d.parts }, items: [], blueprints,
    };
  }

  /** 搶走空投（先到先得）：成功回傳 true */
  async claim(d, name, now = Date.now()) {
    const r = await this.game.shared.update(AIRDROP.kind, d.id, (cur) => {
      if (cur?.by) return { fail: `已經被「${cur.by}」搶走了` };
      if (cur?.w?.length && !cur.res) return { fail: '落點還有等待中的隊伍，正在結算' };
      if (now >= d.npcAt) return { fail: '已經被 NPC 勢力拿走了' };
      return { data: { by: name, at: now } };
    }, { lat: null, lon: null }).catch((e) => ({ ok: false, reason: e?.message || '連線失敗' }));
    return r;
  }

  // ---------- v16.1：降落前抵達的隊伍原地等待，降落當下一起結算 ----------

  /** 共用資料（誰搶走、等待中的隊伍、降落結算結果） */
  record(d) {
    return d ? this.game.shared?.get(AIRDROP.kind, d.id) || null : null;
  }

  /** 等待降落的隊伍（依抵達順序）：[{ k, p, n, at, f, ps?, u? }] */
  waiters(d) {
    return [...(this.record(d)?.w || [])].sort((a, b) => a.at - b.at);
  }

  /** 自己的好友（玩家編號） */
  friendIds() {
    const r = this.game.territory?.rel?.players || {};
    return Object.entries(r).filter(([, p]) => p?.status === 'friend').map(([id]) => id).slice(0, 40);
  }

  /**
   * 登記等待：w = { k 隊伍編號, p 玩家, n 名稱, at 抵達時間, f 好友, ps 集結的所有玩家, u 隊員戰鬥數值 }
   * 已經降落結算過、被搶走，或等待的隊伍太多時失敗。
   */
  async addWaiter(d, w) {
    if (!this.game.shared) return { ok: false, reason: '沒有共用資料' };
    return this.game.shared.update(AIRDROP.kind, d.id, (cur) => {
      const x = cur || {};
      if (x.by) return { fail: `已經被「${x.by}」搶走了` };
      if (x.res) return { fail: '空投已經降落' };
      x.w = (x.w || []).filter((y) => y.k !== w.k);
      x.w.push(w);
      if (bytes(x) > WAIT_BYTES) return { fail: '等待的隊伍太多了' };
      return { data: x };
    }, { lat: null, lon: null }).catch(() => ({ ok: false, reason: '連線失敗' }));
  }

  /** 取消等待（召回） */
  async removeWaiter(d, k) {
    if (!this.game.shared || !d) return { ok: false };
    return this.game.shared.update(AIRDROP.kind, d.id, (cur) => {
      if (!cur?.w?.some((y) => y.k === k) || cur.res) return { fail: 'none' };
      cur.w = cur.w.filter((y) => y.k !== k);
      return { data: cur };
    }, { lat: null, lon: null }).catch(() => ({ ok: false }));
  }

  /** 降落後由任一位等待中的玩家結算（先鎖定，計算後寫入結果；所有人讀同一份結果） */
  async resolveLanding(d, now = Date.now()) {
    const g = this.game;
    if (!g.shared || !d || now < d.landAt) return { ok: false };
    this.resolving = this.resolving || new Set();
    if (this.resolving.has(d.id)) return { ok: false, reason: 'busy' };
    this.resolving.add(d.id);
    try {
      const me = g.shared.store().me;
      const lock = await g.shared.update(AIRDROP.kind, d.id, (cur) => {
        if (!cur?.w?.length || cur.res) return { fail: 'done' };
        if (cur.lk && cur.lk.by !== me && now - cur.lk.at < LOCK_MS) return { fail: 'busy' };
        cur.lk = { by: me, at: now };
        return { data: cur };
      }, { lat: null, lon: null });
      if (!lock.ok) return lock;
      const res = this.landingFight(d, lock.data);
      return await g.shared.update(AIRDROP.kind, d.id, (cur) => {
        if (!cur || cur.res || cur.lk?.by !== me) return { fail: 'lost' };
        if (res.win) { cur.by = res.byName; cur.at = d.landAt; }
        cur.res = res;
        delete cur.lk;
        // 結算後不再需要隊員數值（縮小共用資料）
        cur.w = (cur.w || []).map(({ u, ...rest }) => rest);
        if (bytes(cur) > 15500) res.lines = res.lines.slice(0, 4);
        return { data: cur };
      }, { lat: null, lon: null });
    } catch {
      return { ok: false };
    } finally {
      this.resolving.delete(d.id);
    }
  }

  /**
   * 降落結算（純計算）：互為好友的玩家同一陣營；不同陣營依抵達順序輪流交戰，勝方帶著剩下的生命再打守衛；
   * 打贏守衛：材料與金錢依玩家人數平分，設計圖給陣營中最先抵達的玩家。
   * @returns {{ win:boolean, byName?:string, lines:string[], out:Object<string,object> }}
   */
  landingFight(d, rec) {
    const g = this.game;
    const W = (rec?.w || []).filter((w) => w.at <= d.landAt + 1000).sort((a, b) => a.at - b.at);
    const out = {};
    const lines = [];
    if (!W.length) return { win: false, lines, out };
    const players = (w) => (Array.isArray(w.ps) && w.ps.length ? w.ps : [w.p]);
    const friends = (a, b) => (a.f || []).some((id) => players(b).includes(id)) || (b.f || []).some((id) => players(a).includes(id))
      || players(a).some((id) => players(b).includes(id));
    // 陣營（好友關係可以串連）：依最早抵達的隊伍排序
    const camp = W.map((_, i) => i);
    const root = (i) => (camp[i] === i ? i : (camp[i] = root(camp[i])));
    W.forEach((a, i) => W.forEach((b, j) => { if (j > i && friends(a, b)) camp[root(j)] = root(i); }));
    const camps = [];
    W.forEach((w, i) => {
      let c = camps.find((x) => x.r === root(i));
      if (!c) { c = { r: root(i), ws: [] }; camps.push(c); }
      c.ws.push(w);
    });
    const name = (c) => c.ws.map((w) => `「${w.n}」`).join('、');
    // 每位隊員的狀態
    const units = new Map();
    W.forEach((w) => {
      (w.u || []).slice(0, w.ps ? 36 : 6).forEach((u) => {
        const unit = AssistSystem.unitOf({ id: w.k, name: w.n }, u);
        units.set(unit.id, {
          w: w.k, i: u.i, unit, hp: unit.hp, maxHp: unit.maxHp, down: false, dealt: 0, kills: 0, meds: 0,
        });
      });
    });
    const campUnits = (c) => [...units.values()].filter((x) => !x.down && x.hp > 0 && c.ws.some((w) => w.k === x.w));
    const asAlly = (x) => ({ ...x.unit, hp: x.hp });
    // 對手方：戰鬥會從 maxHp 開始，所以把目前生命當成上限
    const asFoe = (x) => {
      const { ally, ...u } = x.unit;
      void ally;
      return { ...u, maxHp: Math.max(1, Math.round(x.hp)) };
    };
    const applyTeam = (r) => r.team.forEach((t) => {
      const x = units.get(t.id);
      if (!x) return;
      x.hp = t.hp;
      x.down = t.down;
      x.dealt += t.dealt || 0;
      x.kills += t.kills || 0;
      x.meds += t.medsUsed || 0;
    });
    const applyFoes = (r) => r.foes.forEach((t) => {
      const x = units.get(t.id);
      if (!x) return;
      x.hp = t.hp;
      x.down = t.down;
      x.kills += t.kills || 0;
    });
    let champ = camps[0];
    for (let k = 1; k < camps.length; k += 1) {
      const c = camps[k];
      const mine = campUnits(champ);
      const theirs = campUnits(c);
      if (!theirs.length) continue;
      if (!mine.length) { champ = c; continue; }
      const r = g.combat.simulate([], theirs.map(asFoe), { allies: mine.map(asAlly), record: false, title: '📦 爭奪空投' });
      applyTeam(r);
      applyFoes(r);
      const stand = campUnits(champ).length > 0;
      lines.push(`⚔️ ${name(champ)} 與 ${name(c)} 在落點交戰：${stand ? name(champ) : name(c)} 獲勝`);
      if (!stand) champ = c;
    }
    const fighters = campUnits(champ);
    let win = false;
    let xpEach = 0;
    if (fighters.length) {
      const r = g.combat.simulate([], this.guards(d), { allies: fighters.map(asAlly), record: false, title: '📦 搶奪空投：迎戰守衛殭屍' });
      applyTeam(r);
      win = !!r.victory;
      xpEach = Math.round((r.xp || 0) / Math.max(1, fighters.length));
      lines.push(win ? `🏆 ${name(champ)} 擊退守衛殭屍（擊殺 ${r.kills.length}），搶到空投` : `💀 ${name(champ)} 沒能打贏守衛殭屍`);
    } else lines.push('💀 落點的隊伍全部倒下，沒有人拿到空投');
    // 戰利品：依玩家人數平分（集結隊伍依參加的玩家數）
    const share = {};
    if (win) {
      const loot = this.loot(d);
      const { coins = 0, ...mats } = loot.gained;
      const wt = (w) => players(w).length;
      const tot = champ.ws.reduce((s, w) => s + wt(w), 0);
      champ.ws.forEach((w, idx) => {
        const fr = wt(w) / tot;
        share[w.k] = {
          coins: Math.floor(coins * fr),
          mats: Object.fromEntries(Object.entries(mats).map(([k2, v]) => [k2, Math.floor(v * fr) + (idx === 0 ? v - champ.ws.reduce((s2, w2) => s2 + Math.floor(v * (wt(w2) / tot)), 0) : 0)]).filter(([, v]) => v > 0)),
          bps: idx === 0 ? loot.blueprints : [],
        };
      });
    }
    W.forEach((w) => {
      const inWin = win && champ.ws.includes(w);
      out[w.k] = {
        win: inWin,
        camp: camps.findIndex((c) => c.ws.includes(w)),
        units: [...units.values()].filter((x) => x.w === w.k).map((x) => ({
          i: x.i, hp: Math.round(x.hp), down: !!x.down || x.hp <= 0, dealt: Math.round(x.dealt), kills: x.kills, maxHp: Math.round(x.maxHp), meds: Math.floor(x.meds),
        })),
        xpEach: champ.ws.includes(w) ? xpEach : 0,
        ...(inWin ? share[w.k] : { coins: 0, mats: {}, bps: [] }),
      };
    });
    const byName = win ? champ.ws.map((w) => w.n).join('、').slice(0, 40) : undefined;
    if (W.length > 1) lines.unshift(`⏳ ${W.length} 支隊伍在落點等待降落（${camps.length} 個陣營）`);
    return { win, ...(byName ? { byName } : {}), lines: lines.slice(0, 10), out };
  }

  /** 集結戰鬥用的目標資訊 */
  asTarget(d) {
    return d && { kind: AIRDROP.kind, id: d.id, name: `📦 空投（${zoneAt(d.lat, d.lon).name}）`, lat: d.lat, lon: d.lon };
  }

  /** 唯一編號（報告用） */
  static reportId() {
    return uid('rp');
  }
}
