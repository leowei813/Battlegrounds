import { fmtQty } from '../utils/math.js';
import {
  BLOCKADE, BLOCKADE_ZONE, BLOCKADE_MIX, EV_TZ_MS,
} from '../config/eventModes.js';
import { SUPPLIES, unitWeight } from '../config/supplies.js';
import { RESOURCES } from '../config/constants.js';
import { RARITY_ORDER } from '../config/equipment.js';
import { zoneAt, ZONES } from '../config/zones.js';
import { seeded } from '../multiplayer/worldGrid.js';
import { generateWorldPois } from '../map/WorldGen.js';
import { AirdropSystem } from './AirdropSystem.js';
import { pickTierSupply } from './WorldBossSystem.js';
import {
  chance, randInt, weightedPick, uid, haversine,
} from '../utils/math.js';

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const isLootKey = (k) => !!RESOURCES[k] || !!SUPPLIES[k];
const weightOf = (g) => Object.entries(g || {}).filter(([k]) => isLootKey(k)).reduce((s, [k, v]) => s + v * unitWeight(k), 0);
const roundRand = (x) => Math.floor(x) + (chance(x - Math.floor(x)) ? 1 : 0);
const label = (k) => { const m = RESOURCES[k] || SUPPLIES[k]; return m ? `${m.icon}${m.name}` : k === 'coins' ? '💰' : k === 'parts' ? '⚙️稀有材料' : k; };
/** 一輪收穫的摘要：零件、布料（最高階）、金錢、稀有材料 */
export function lootBrief(g) {
  const sum = { part: [0, 0], fabric: [0, 0] };
  Object.entries(g || {}).forEach(([k, v]) => { const s = SUPPLIES[k]; if (s && sum[s.cat]) { sum[s.cat][0] += v; sum[s.cat][1] = Math.max(sum[s.cat][1], s.tier); } });
  return [sum.part[0] ? `🔩 零件 ×${sum.part[0]}（最高 ${sum.part[1]} 階）` : '', sum.fabric[0] ? `🧵 布料 ×${sum.fabric[0]}（最高 ${sum.fabric[1]} 階）` : '',
    g?.coins ? `💰 ${g.coins}` : '', g?.parts ? `⚙️ 稀有材料 ×${g.parts}` : ''].filter(Boolean).join('、');
}
export const lootText = (g) => Object.entries(g || {}).filter(([, v]) => v > 0).map(([k, v]) => (k === 'coins' ? `💰 ${fmtQty(v)}` : `${label(k)} ×${fmtQty(v)}`)).join('、');

/**
 * v17.3：封鎖區撤離。開放時間與地點由日期決定（所有玩家相同），每位玩家每次開放可派 1 支隊伍。
 * 隊伍在封鎖區內每 10 分鐘搜刮一輪，威脅值越高越容易遭遇屍群；撤離時要打贏追擊戰才能全部帶回。
 * 搜刮、遭遇、撤離都以「隊伍＋輪次」固定亂數，離線回來時依序補算（結果相同）。
 */
export class BlockadeSystem {
  constructor(game) {
    this.game = game;
  }

  get st() {
    const s = this.game.state;
    s.bz = s.bz || { used: [], auto: { ...BLOCKADE.auto } };
    s.bz.used = s.bz.used || [];
    s.bz.auto = { ...BLOCKADE.auto, ...(s.bz.auto || {}) };
    return s.bz;
  }

  // ---------- 時程與地點 ----------

  /** 某天某時段的封鎖區 */
  of(d, hour) {
    const start = d * DAY - EV_TZ_MS + hour * HOUR;
    const id = `bz${new Date(d * DAY).toISOString().slice(0, 10).replace(/-/g, '')}${String(hour).padStart(2, '0')}`;
    return { id, start, close: start + BLOCKADE.openMs, ...this.placeOf(id) };
  }

  placeOf(id) {
    this.placeCache = this.placeCache || new Map();
    if (this.placeCache.has(id)) return this.placeCache.get(id);
    const pois = AirdropSystem.worldPois || (AirdropSystem.worldPois = generateWorldPois());
    const byZone = {};
    pois.forEach((p) => { const z = zoneAt(p.lat, p.lon).id; if (BLOCKADE.zones[z]) (byZone[z] = byZone[z] || []).push(p); });
    Object.values(byZone).forEach((l) => l.sort((a, b) => String(a.id).localeCompare(String(b.id))));
    const out = seeded(`bzpos:${id}`, () => {
      const w = Object.fromEntries(Object.entries(BLOCKADE.zones).filter(([z]) => byZone[z]?.length));
      const z = Object.keys(w).length ? weightedPick(w) : null;
      const list = z ? byZone[z] : pois;
      const p = list[randInt(0, list.length - 1)];
      return {
        lat: p.lat, lon: p.lon, zone: z || zoneAt(p.lat, p.lon).id, place: p.name,
      };
    });
    if (!BLOCKADE_ZONE[out.zone]) out.zone = 'danger';
    this.placeCache.set(id, out);
    return out;
  }

  /** 目前開放中的封鎖區（沒有回傳 null） */
  current(now = Date.now()) {
    const d = Math.floor((now + EV_TZ_MS) / DAY);
    for (const dd of [d, d - 1]) {
      for (const h of BLOCKADE.hours) {
        const z = this.of(dd, h);
        if (now >= z.start && now < z.close) return z;
      }
    }
    return null;
  }

  /** 下一次開放 */
  next(now = Date.now()) {
    const d = Math.floor((now + EV_TZ_MS) / DAY);
    for (const dd of [d, d + 1]) {
      for (const h of BLOCKADE.hours) {
        const z = this.of(dd, h);
        if (z.start > now) return z;
      }
    }
    return null;
  }

  get(id) {
    const m = String(id || '').match(/^bz(\d{4})(\d{2})(\d{2})(\d{2})$/);
    if (!m) return null;
    return this.of(Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3]) / DAY), +m[4]);
  }

  zoneDef(z) {
    return BLOCKADE_ZONE[z.zone] || BLOCKADE_ZONE.danger;
  }

  zoneName(z) {
    return ZONES.find((x) => x.id === z.zone)?.name || zoneAt(z.lat, z.lon).name;
  }

  distanceTo(z) {
    const sh = this.game.shelter.primary();
    return sh ? Math.round(haversine(sh.lat, sh.lon, z.lat, z.lon)) : 0;
  }

  /** 封鎖區當成目的地：id = bz:封鎖區編號 */
  asPoi(id) {
    if (!String(id).startsWith('bz:')) return null;
    const z = this.get(String(id).slice(3));
    return z && {
      id, name: `🚧 封鎖區・${z.place || ''}`, lat: z.lat, lon: z.lon, type: 'military', icon: '🚧', blockade: true,
    };
  }

  used(z) {
    return this.st.used.includes(z.id);
  }

  /** 自己在這個封鎖區的隊伍 */
  myTeam(z) {
    return this.game.state.expeditions.find((e) => e.kind === 'bz' && e.bz?.id === z.id) || null;
  }

  canEnter(z, now = Date.now()) {
    if (!z || now < z.start || now >= z.close) return { ok: false, reason: '封鎖區目前沒有開放' };
    if (now > z.close - BLOCKADE.enterBeforeMs) return { ok: false, reason: '封鎖區即將關閉，不能再進入' };
    if (this.used(z)) return { ok: false, reason: '這次開放已經派過隊伍了' };
    return { ok: true };
  }

  // ---------- 出發與每輪搜刮 ----------

  /** 派隊進入封鎖區 */
  start(memberIds, opts = {}, now = Date.now()) {
    const z = this.current(now);
    const ok = this.canEnter(z, now);
    if (!ok.ok) return ok;
    const r = this.game.exploration.start(`bz:${z.id}`, memberIds, 0, false, now, { ...opts, kind: 'bz' });
    if (!r.ok) return r;
    const exp = r.exp;
    const arrive = exp.startAt + (exp.travelMs || 0);
    // 先以「待到關閉」估算回家時間；撤離後再更新
    exp.searchMs = Math.max(0, z.close - arrive);
    exp.endAt = arrive + exp.searchMs + (exp.travelMs || 0);
    exp.bz = {
      id: z.id, zone: z.zone, close: z.close, round: 0, threat: 0, gained: {}, bps: [], log: [],
      auto: { ...this.st.auto }, exitAt: null, exitWhy: '', done: false, result: null,
    };
    this.st.used = [...this.st.used, z.id].slice(-20);
    r.msg = `${r.msg}（抵達後每 10 分鐘搜刮一輪）`;
    return r;
  }

  /** 隊伍目前可以作戰的隊員 */
  fighters(exp) {
    return exp.memberIds.map((id) => this.game.survivors.get(id)).filter((m) => m && !m.severe && this.game.survivors.hpOf(m) > 0);
  }

  /** 背包容量與目前負重 */
  load(exp) {
    const cap = exp.cargo || this.game.vehicles.personCarry() * exp.memberIds.length;
    return { cap, used: weightOf(exp.bz?.gained), ratio: cap > 0 ? Math.min(1, weightOf(exp.bz?.gained) / cap) : 1 };
  }

  /** 屍群：區域守衛 × 強度 */
  horde(exp, k) {
    const G = this.zoneDef(exp.bz).guard;
    return Array.from({ length: G.n }, (_, i) => this.game.combat.createEnemy(BLOCKADE_MIX[i % BLOCKADE_MIX.length], G.lv, false, { hp: G.mul * k, atk: G.mul * k }));
  }

  fight(exp, k, at, title) {
    const g = this.game;
    const members = this.fighters(exp);
    if (!members.length) return { victory: false, kills: [], xp: 0, team: [] };
    return g.combat.within(exp, () => {
      const r = g.combat.simulate(members, this.horde(exp, k), { title });
      g.combat.applyOutcome(members, r, at);
      return r;
    });
  }

  /** 一輪搜刮的收穫 */
  roundLoot(exp, n) {
    const Z = this.zoneDef(exp.bz);
    const mul = 1 + BLOCKADE.grow * (n - 1);
    const out = {};
    ['part', 'fabric'].forEach((cat) => Object.entries(Z[cat] || {}).forEach(([tier, amt]) => {
      const cnt = roundRand(amt * mul);
      for (let i = 0; i < cnt; i += 1) {
        const k = pickTierSupply(cat, Number(tier)) || pickTierSupply('part', Number(tier));
        if (k) out[k] = (out[k] || 0) + 1;
      }
    }));
    out.coins = Math.round(Z.coins * mul);
    if (chance(Z.parts)) out.parts = 1;
    const bps = [];
    if (n >= BLOCKADE.bpFrom && chance(Z.bp)) {
      const bp = this.game.equipment.makeBlueprint(Z.guard.lv);
      if (Z.bpMin && RARITY_ORDER.indexOf(bp.rarity) < RARITY_ORDER.indexOf(Z.bpMin)) bp.rarity = Z.bpMin;
      bps.push(bp);
    }
    return { out, bps };
  }

  /** 每輪威脅上升 */
  threatGain(exp, at) {
    const T = BLOCKADE.threat;
    const night = this.game.time.phase(at)?.zombies ? T.night : 1;
    return Math.round((T.base + T.load * this.load(exp).ratio) * night);
  }

  /** 處理到 now 為止的所有輪次、撤離與追擊戰（線上每秒、離線結算時呼叫） */
  check(now = Date.now()) {
    this.game.state.expeditions.forEach((exp) => {
      if (exp.kind !== 'bz' || !exp.bz || exp.bz.done || exp.recalled || exp.defeated) return;
      this.advance(exp, now);
    });
  }

  advance(exp, now) {
    const b = exp.bz;
    const arrive = exp.startAt + (exp.travelMs || 0);
    if (now < arrive) return;
    for (let guard = 0; guard < 40 && !b.done; guard += 1) {
      if (b.exitAt != null) {
        const at = b.exitAt + BLOCKADE.exitMs;
        if (now < at) return;
        this.chase(exp, at);
        return;
      }
      const T = arrive + (b.round + 1) * BLOCKADE.roundMs;
      // 關閉前自動撤離
      if (T > b.close - BLOCKADE.closeExitMs) {
        const at = Math.max(arrive + b.round * BLOCKADE.roundMs, Math.min(T, b.close - BLOCKADE.exitMs));
        this.exit(exp, at, '封鎖區即將關閉');
        continue;
      }
      if (now < T) return;
      seeded(`bz:${exp.id}:${b.round + 1}`, () => this.round(exp, T));
    }
  }

  /** 第 n 輪：先判定遭遇，再搜刮、威脅上升，最後檢查自動撤離 */
  round(exp, at) {
    const b = exp.bz;
    const n = b.round + 1;
    b.round = n;
    if (chance(b.threat / 100)) {
      const E = BLOCKADE.enc;
      const r = this.fight(exp, E.min + (E.span * b.threat) / 100, at, `🚧 封鎖區第 ${n} 輪：遭遇屍群`);
      exp.travelKills = (exp.travelKills || 0) + r.kills.length;
      exp.travelXp = (exp.travelXp || 0) + (r.xp || 0);
      const downs = (r.team || []).filter((u) => u.down).length;
      if (!r.victory) {
        b.log.unshift(`第 ${n} 輪：⚔️ 遭遇屍群 ${r.kills.length ? `（擊殺 ${r.kills.length}）` : ''}，全隊被擊潰`);
        this.finish(exp, at, 'wiped');
        return;
      }
      b.log.unshift(`第 ${n} 輪：⚔️ 遭遇屍群，勝利（擊殺 ${r.kills.length}${downs ? `，${downs} 人倒下` : ''}）`);
    }
    const { out, bps } = this.roundLoot(exp, n);
    // 背包放不下的部分丟掉
    const { cap, used } = this.load(exp);
    const add = {};
    let room = cap - used;
    Object.entries(out).forEach(([k, v]) => {
      if (!isLootKey(k)) { add[k] = v; return; }
      const w = unitWeight(k);
      const take = w > 0 ? Math.max(0, Math.min(v, Math.floor(room / w))) : v;
      if (take > 0) { add[k] = take; room -= take * w; }
    });
    Object.entries(add).forEach(([k, v]) => { b.gained[k] = (b.gained[k] || 0) + v; });
    b.bps.push(...bps);
    const gain = this.threatGain(exp, at);
    b.threat = Math.min(BLOCKADE.threat.max, b.threat + gain);
    b.log.unshift(`第 ${n} 輪：搜到 ${lootBrief(add) || '（背包滿了，帶不走）'}${bps.length ? '、📜設計圖' : ''}；威脅 +${gain}%`);
    b.log = b.log.slice(0, 30);
    const A = b.auto;
    const full = this.load(exp).ratio >= 0.98;
    const down = exp.memberIds.some((id) => this.game.survivors.get(id)?.severe);
    if (b.threat >= BLOCKADE.threat.max) this.exit(exp, at, '威脅值 100%，被屍群包圍');
    else if (b.threat >= A.threat) this.exit(exp, at, `威脅值達 ${A.threat}%`);
    else if (A.down && down) this.exit(exp, at, '有隊員倒下');
    else if (A.full && full) this.exit(exp, at, '背包滿了');
    else if (!this.fighters(exp).length) this.exit(exp, at, '沒有能作戰的隊員');
  }

  /** 開始撤離（exitMs 後打追擊戰） */
  exit(exp, at, why) {
    const b = exp.bz;
    if (b.exitAt != null || b.done) return;
    b.exitAt = at;
    b.exitWhy = why;
    b.log.unshift(`🚁 開始撤離：${why}`);
  }

  /** 手動撤離（召回） */
  extract(exp, now = Date.now()) {
    const b = exp?.bz;
    if (!b || b.done) return { ok: false, reason: '隊伍已經離開封鎖區' };
    this.advance(exp, now);
    if (b.done) return { ok: true, msg: '隊伍已經離開封鎖區' };
    if (b.exitAt != null) return { ok: false, reason: '隊伍已經在撤離中' };
    this.exit(exp, now, '收到撤離命令');
    return { ok: true, msg: `隊伍開始撤離，約 ${Math.round(BLOCKADE.exitMs / 60000)} 分鐘後擺脫追擊` };
  }

  /** 追擊戰：打贏全部帶回；打輸丟一半 */
  chase(exp, at) {
    const b = exp.bz;
    const C = BLOCKADE.chase;
    const r = seeded(`bz:${exp.id}:chase`, () => this.fight(exp, C.min + (C.span * b.threat) / 100, at, '🚁 撤離：擺脫追擊的屍群'));
    exp.travelKills = (exp.travelKills || 0) + r.kills.length;
    exp.travelXp = (exp.travelXp || 0) + (r.xp || 0);
    if (r.victory) {
      b.log.unshift(`🚁 擺脫追擊（擊殺 ${r.kills.length}），帶著全部物資離開封鎖區`);
      this.finish(exp, at, 'ok');
    } else {
      const keep = BLOCKADE.chaseKeep;
      Object.keys(b.gained).forEach((k) => { b.gained[k] = Math.floor(b.gained[k] * keep); });
      b.bps = b.bps.slice(0, Math.floor(b.bps.length * keep));
      b.log.unshift('⚠️ 追擊戰失敗，丟失一半物資才逃出封鎖區');
      this.finish(exp, at, 'half');
    }
  }

  /** 離開封鎖區：更新回家時間，物資背在身上 */
  finish(exp, at, result) {
    const b = exp.bz;
    b.done = true;
    b.result = result;
    if (result === 'wiped') {
      b.gained = {};
      b.bps = [];
      b.log.unshift('💀 這趟搜刮的物資全部丟失');
    }
    const arrive = exp.startAt + (exp.travelMs || 0);
    exp.searchMs = Math.max(0, at - arrive);
    exp.endAt = at + (exp.travelMs || 0);
    const gained = Object.fromEntries(Object.entries(b.gained).filter(([, v]) => v > 0));
    exp.carried = Object.keys(gained).length || b.bps.length ? { gained, items: [], blueprints: b.bps.map((x) => ({ ...x })) } : null;
    const g = this.game;
    const msg = result === 'ok' ? '🚧 封鎖區撤離成功！隊伍帶著物資返回' : result === 'half' ? '🚧 封鎖區撤離：追擊戰失敗，丟失一半物資' : '💀 封鎖區的隊伍被屍群擊潰，物資全部丟失';
    g.log(msg, result === 'ok' ? 'success' : 'danger');
    g.toast?.(msg, result === 'ok' ? 'success' : 'danger');
    g.bus.emit('map:changed');
  }

  /** 回到避難所的報告 */
  report(exp) {
    const g = this.game;
    if (exp.bz && !exp.bz.done) this.advance(exp, exp.endAt);
    const b = exp.bz || { log: [], result: null };
    const members = exp.memberIds.map((id) => g.survivors.get(id)).filter(Boolean);
    const gained = { ...(exp.carried?.gained || {}) };
    const bps = [...(exp.carried?.blueprints || [])];
    const note = exp.carried ? g.exploration.bringCarried(exp, 1, members).replace('先前地點取得的物資帶回避難所', '物資帶回避難所') : '';
    const z = this.get(b.id);
    return {
      id: uid('rp'), poiName: `🚧 封鎖區・${z?.place || ''}`, poiType: 'military', at: exp.endAt,
      events: [...(exp.travelEvents || []), ...[...(b.log || [])].reverse(), ...(note ? [note] : [])],
      resources: note ? gained : {}, items: [], blueprints: note ? bps : [], kills: exp.travelKills || 0, xp: exp.travelXp || 0,
      success: b.result === 'ok', members: members.map((m) => m.name),
    };
  }

  /** 更新自動撤離設定（預設值與這支隊伍） */
  setAuto(patch, exp = null) {
    const a = { ...this.st.auto, ...patch };
    a.threat = Math.min(100, Math.max(10, Number(a.threat) || BLOCKADE.auto.threat));
    a.down = !!a.down;
    a.full = !!a.full;
    this.st.auto = a;
    if (exp?.bz && !exp.bz.done) exp.bz.auto = { ...a };
    return a;
  }
}
