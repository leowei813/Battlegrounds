import {
  WORLD_BOSS, WORLD_BOSS_ROSTER, WORLD_BOSS_PHASES, WORLD_BOSS_REWARD, EV_TZ_MS,
} from '../config/eventModes.js';
import { AIRDROP_AMOUNT } from '../config/airdrops.js';
import { SUPPLIES, SUPPLY_KEYS } from '../config/supplies.js';
import { RARITY_ORDER } from '../config/equipment.js';
import { zoneAt } from '../config/zones.js';
import { seeded } from '../multiplayer/worldGrid.js';
import { generateWorldPois } from '../map/WorldGen.js';
import { AirdropSystem } from './AirdropSystem.js';
import { baseSupplyWeight } from './LootStock.js';
import { trimReports } from './reportList.js';
import {
  chance, randInt, randFloat, weightedPick, uid, haversine,
} from '../utils/math.js';

const DAY = 24 * 3600 * 1000;
/** 台灣日期序號（從 1970-01-01 起的天數） */
const dayNum = (t) => Math.floor((t + EV_TZ_MS) / DAY);
/** 1970-01-01 是星期四 */
const weekday = (d) => (d + 4) % 7;
/** 屍王序號：一週（週四起算）內週六在前、週三在後 */
const seqOf = (d) => Math.floor(d / 7) * 2 + (weekday(d) === 3 ? 1 : 0);
/** 第一隻屍王（骷髏王）的日期：2026-11-18（週三） */
const FIRST_SEQ = seqOf(Math.floor(Date.UTC(2026, 10, 18) / DAY));
const ymd = (d) => new Date(d * DAY).toISOString().slice(0, 10).replace(/-/g, '');
const fmtWan = (n) => (n >= 1e8 ? `${(n / 1e8).toFixed(2).replace(/\.?0+$/, '')} 億` : n >= 1e4 ? `${Math.round(n / 1e4).toLocaleString()} 萬` : Math.round(n).toLocaleString());

/** 隨機進位（2.3 → 2 或 3） */
const roundRand = (x) => Math.floor(x) + (chance(x - Math.floor(x)) ? 1 : 0);

/** 依階級挑一種零件或布料（同空投：基本權重） */
export function pickTierSupply(cat, tier) {
  const keys = SUPPLY_KEYS.filter((s) => SUPPLIES[s].cat === cat && SUPPLIES[s].tier === tier && SUPPLIES[s].tag !== 'ammo').sort();
  if (!keys.length) return null;
  return weightedPick(Object.fromEntries(keys.map((s) => [s, baseSupplyWeight(s)])));
}

/** 獎勵箱的材料（同空投的每階基本量 × 倍率） */
export function boxMats(spec, mul = 1) {
  const mats = {};
  for (let k = 0; k < spec.kinds; k += 1) {
    const tier = randInt(spec.tiers[0], spec.tiers[1]);
    const cat = chance(0.65) ? 'part' : 'fabric';
    const sk = pickTierSupply(cat, tier) || pickTierSupply('part', tier);
    if (!sk) continue;
    const n = Math.max(1, Math.round(AIRDROP_AMOUNT[tier] * spec.mul * mul * randFloat(0.8, 1.2)));
    mats[sk] = (mats[sk] || 0) + n;
  }
  return mats;
}

export { fmtWan };

/**
 * v17.3：屍王降臨（全服共鬥世界王）。
 * 出現時間、地點、名稱都由日期決定（所有玩家相同）；血量與每位玩家的傷害寫在共用資料（種類 wb）。
 * 共用資料：{ hp 本次血量, s 開始時間, h: { 玩家: [名稱, 傷害, 出擊次數] }, k 擊倒時間 }
 */
export class WorldBossSystem {
  constructor(game) {
    this.game = game;
    game.shared?.watch(WORLD_BOSS.kind, 5);
  }

  get st() {
    const s = this.game.state;
    s.wb = s.wb || { tries: {}, claimed: [], pending: [] };
    s.wb.tries = s.wb.tries || {};
    s.wb.claimed = s.wb.claimed || [];
    s.wb.pending = s.wb.pending || [];
    return s.wb;
  }

  // ---------- 時程與地點 ----------

  /** 某天（台灣日期序號）的屍王資訊；不是降臨日回傳 null */
  bossOfDay(d) {
    if (!WORLD_BOSS.days.includes(weekday(d))) return null;
    const seq = seqOf(d);
    const n = WORLD_BOSS_ROSTER.length;
    const who = WORLD_BOSS_ROSTER[(((seq - FIRST_SEQ) % n) + n) % n];
    const start = d * DAY - EV_TZ_MS + WORLD_BOSS.hour * 3600 * 1000;
    const id = `wb${ymd(d)}`;
    const pos = this.placeOf(id);
    return {
      id, seq, day: d, name: who.name, icon: who.icon, start, end: start + WORLD_BOSS.stayMs, ...pos,
    };
  }

  /** 地點：依編號固定挑一棟指定區域的建築 */
  placeOf(id) {
    this.placeCache = this.placeCache || new Map();
    if (this.placeCache.has(id)) return this.placeCache.get(id);
    const pois = AirdropSystem.worldPois || (AirdropSystem.worldPois = generateWorldPois());
    const cands = pois.filter((p) => WORLD_BOSS.zones.includes(zoneAt(p.lat, p.lon).id)).sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const list = cands.length ? cands : pois;
    const p = seeded(`wbpos:${id}`, () => list[randInt(0, list.length - 1)]);
    const out = { lat: p.lat, lon: p.lon, zone: zoneAt(p.lat, p.lon).id, place: p.name };
    this.placeCache.set(id, out);
    return out;
  }

  /** 由編號取得屍王 */
  get(id) {
    const m = String(id || '').match(/^wb(\d{4})(\d{2})(\d{2})$/);
    if (!m) return null;
    return this.bossOfDay(Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3]) / DAY));
  }

  /** 最近一次（已開始）的屍王 */
  latest(now = Date.now()) {
    let d = dayNum(now);
    for (let i = 0; i < 8; i += 1, d -= 1) {
      const b = this.bossOfDay(d);
      if (b && b.start <= now) return b;
    }
    return null;
  }

  /** 下一次降臨 */
  next(now = Date.now()) {
    let d = dayNum(now);
    for (let i = 0; i < 9; i += 1, d += 1) {
      const b = this.bossOfDay(d);
      if (b && b.start > now) return b;
    }
    return null;
  }

  /** 前一隻屍王 */
  prev(b) {
    let d = b.day - 1;
    for (let i = 0; i < 8; i += 1, d -= 1) {
      const p = this.bossOfDay(d);
      if (p) return p;
    }
    return null;
  }

  /** 目前在地圖上的屍王（降臨中；倒下或離開後消失） */
  active(now = Date.now()) {
    const b = this.latest(now);
    if (!b) return null;
    const s = this.status(b, now);
    return s.state === 'active' ? b : null;
  }

  // ---------- 血量與傷害 ----------

  record(b) {
    return b ? this.game.shared?.get(WORLD_BOSS.kind, b.id) || null : null;
  }

  static total(rec) {
    return Object.values(rec?.h || {}).reduce((s, x) => s + (Number(x?.[1]) || 0), 0);
  }

  /** 本次血量：已經有人出擊就以共用資料為準；否則依上一隻的結果計算 */
  maxHp(b) {
    const rec = this.record(b);
    if (rec?.hp > 0) return rec.hp;
    const p = this.prev(b);
    const pr = p ? this.record(p) : null;
    if (!pr?.hp) return WORLD_BOSS.hp0;
    const A = WORLD_BOSS.adjust;
    let hp;
    if (pr.k) hp = pr.hp * (pr.k - p.start <= A.fastMs ? A.fast : A.slow);
    else hp = WorldBossSystem.total(pr) * A.fail;
    return Math.max(WORLD_BOSS.hpMin, Math.round(hp / 10000) * 10000);
  }

  /** 狀態：upcoming、active、killed（被擊倒）、fled（時間到離開） */
  status(b, now = Date.now()) {
    if (!b) return { state: 'none' };
    const rec = this.record(b);
    const hp = this.maxHp(b);
    const dealt = WorldBossSystem.total(rec);
    const left = Math.max(0, hp - dealt);
    const base = {
      hp, dealt, left, pct: hp ? left / hp : 0, players: Object.keys(rec?.h || {}).length,
    };
    if (now < b.start) return { state: 'upcoming', ...base };
    if (rec?.k || left <= 0) return { state: 'killed', at: rec?.k || now, ...base };
    if (now >= b.end) return { state: 'fled', at: b.end, ...base };
    return { state: 'active', ...base };
  }

  /** 目前階段（依剩餘血量比例） */
  phaseOf(pct) {
    return WORLD_BOSS_PHASES.find((p) => pct > p.to) || WORLD_BOSS_PHASES[WORLD_BOSS_PHASES.length - 1];
  }

  /** 傷害排行：[{ p, n, d, t }]（傷害高到低） */
  ranking(b) {
    const rec = this.record(b);
    return Object.entries(rec?.h || {}).map(([p, x]) => ({
      p, n: String(x?.[0] || '倖存者'), d: Number(x?.[1]) || 0, t: Number(x?.[2]) || 0,
    })).sort((a, c) => c.d - a.d || a.p.localeCompare(c.p));
  }

  me() {
    return this.game.shared?.store().me || 'local';
  }

  triesLeft(b) {
    return Math.max(0, WORLD_BOSS.tries - (this.st.tries[b.id] || 0));
  }

  /** 正在前往（或交戰中）這隻屍王的自己的隊伍 */
  myTeam(b) {
    return this.game.state.expeditions.find((e) => e.kind === 'boss' && e.bossId === b.id && !e.bossDone && !e.recalled) || null;
  }

  /** 屍王當成目的地：id = boss:屍王編號 */
  asPoi(id) {
    if (!String(id).startsWith('boss:')) return null;
    const b = this.get(String(id).slice(5));
    return b && {
      id, name: `${b.icon} ${b.name}`, lat: b.lat, lon: b.lon, type: 'military', icon: b.icon, boss: true,
    };
  }

  distanceTo(b) {
    const sh = this.game.shelter.primary();
    return sh ? Math.round(haversine(sh.lat, sh.lon, b.lat, b.lon)) : 0;
  }

  // ---------- 出擊 ----------

  /** 派隊挑戰屍王 */
  start(memberIds, opts = {}, now = Date.now()) {
    const b = this.active(now);
    if (!b) return { ok: false, reason: '屍王目前不在地圖上' };
    if (this.triesLeft(b) <= 0) return { ok: false, reason: `這次降臨的 ${WORLD_BOSS.tries} 次出擊已經用完` };
    if (this.myTeam(b)) return { ok: false, reason: '已經有隊伍前往挑戰屍王，等這次戰鬥結束再出擊' };
    const r = this.game.exploration.start(`boss:${b.id}`, memberIds, 0, false, now, { ...opts, kind: 'boss' });
    if (!r.ok) return r;
    const exp = r.exp;
    exp.bossId = b.id;
    exp.searchMs = WORLD_BOSS.fightSec * 1000;
    exp.endAt += exp.searchMs;
    this.st.tries[b.id] = (this.st.tries[b.id] || 0) + 1;
    r.msg = `${r.msg}（這次降臨剩 ${this.triesLeft(b)} 次出擊）`;
    return r;
  }

  /** 還沒交戰就召回：退回出擊次數 */
  refund(exp) {
    if (exp?.kind !== 'boss' || exp.bossDone) return;
    exp.bossDone = true;
    exp.bossResult = { dmg: 0, events: [] };
    if (this.st.tries[exp.bossId] > 0) this.st.tries[exp.bossId] -= 1;
  }

  /** 戰鬥用的敵人：屍王（剩餘血量）＋召喚階段的屍群 */
  enemies(b, left, pct) {
    const c = this.game.combat;
    const B = WORLD_BOSS.boss;
    const ph = this.phaseOf(pct);
    const boss = c.createEnemy(B.base, B.level, false, { atk: B.atkMul * (ph.atk || 1) });
    Object.assign(boss, {
      name: b.name, icon: b.icon, maxHp: Math.max(1, Math.round(left)), atkSpeed: boss.atkSpeed * (ph.spd || 1), worldBoss: true,
    });
    boss.hp = boss.maxHp;
    const adds = Array.from({ length: ph.adds || 0 }, () => c.createEnemy(ph.addId, ph.addLv, false, { hp: ph.addMul, atk: ph.addMul }));
    return { boss, list: [boss, ...adds], phase: ph };
  }

  /** 抵達後交戰（線上每秒、離線結算時檢查） */
  check(now = Date.now()) {
    this.game.state.expeditions.forEach((exp) => {
      if (exp.kind !== 'boss' || exp.bossDone || exp.recalled || exp.defeated) return;
      const at = exp.startAt + (exp.travelMs || 0);
      if (now >= at) this.fight(exp, at);
    });
  }

  fight(exp, at) {
    const g = this.game;
    exp.bossDone = true;
    const b = this.get(exp.bossId);
    const st = this.status(b, at);
    if (!b || st.state !== 'active') {
      exp.bossResult = { dmg: 0, missed: true, events: [`🏳️ 抵達時${b?.name || '屍王'}${st.state === 'killed' ? '已經被擊倒了' : '已經離開了'}，撲空了。`] };
      if (this.st.tries[exp.bossId] > 0) this.st.tries[exp.bossId] -= 1;
      return;
    }
    const members = exp.memberIds.map((id) => g.survivors.get(id)).filter((m) => m && !m.severe);
    const { boss, list, phase } = this.enemies(b, st.left, st.pct);
    const r = g.combat.within(exp, () => {
      const res = g.combat.simulate(members, list, { title: `${b.icon} 挑戰${b.name}`, maxTime: WORLD_BOSS.fightSec });
      g.combat.applyOutcome(members, res, at);
      return res;
    });
    const left = r.foes.find((f) => f.id === boss.id)?.hp ?? boss.maxHp;
    const dmg = Math.max(0, Math.round(boss.maxHp - left));
    exp.travelKills = (exp.travelKills || 0) + r.kills.filter((k) => !k.worldBoss).length;
    exp.travelXp = (exp.travelXp || 0) + r.xp;
    const downs = r.team.filter((u) => u.down).length;
    const events = [`${phase.icon} 階段「${phase.name}」：${phase.text}`,
      `⚔️ 對${b.name}造成 ${fmtWan(dmg)} 傷害${downs ? `（${downs} 人倒下・重傷）` : ''}`];
    exp.bossResult = { dmg, events, pending: true };
    // 每場出擊的獎勵：依傷害立即獲得（背著回家）
    const hit = dmg > 0 ? Object.fromEntries(Object.entries(this.hitLoot(dmg, `${exp.id}`)).filter(([, v]) => v > 0)) : {};
    if (Object.keys(hit).length) exp.carried = { gained: hit, items: [], blueprints: [] };
    this.write(b, dmg, at, exp.id);
    g.bus.emit('map:changed');
  }

  /** 每場出擊的獎勵（每 100 萬傷害） */
  hitLoot(dmg, seed) {
    const H = WORLD_BOSS_REWARD.hit;
    const f = dmg / 1e6;
    return seeded(`wbhit:${seed}`, () => {
      const out = { coins: Math.round(H.coins * f) };
      const add = (tier, n) => {
        for (let i = 0; i < roundRand(n); i += 1) {
          const k = pickTierSupply(chance(0.65) ? 'part' : 'fabric', tier) || pickTierSupply('part', tier);
          if (k) out[k] = (out[k] || 0) + 1;
        }
      };
      add(3, H.t3 * f);
      add(4, H.t4 * f);
      return out;
    });
  }

  /** 把傷害寫入共用資料（失敗時留著下次重試） */
  write(b, dmg, at, expId) {
    if (dmg <= 0) return;
    const g = this.game;
    const name = String(g.state.player?.name || '倖存者').slice(0, 16);
    const me = this.me();
    const hp = this.maxHp(b);
    const job = { id: b.id, dmg, at, exp: expId, name };
    const exp = g.state.expeditions.find((e) => e.id === expId);
    const run = () => g.shared?.update(WORLD_BOSS.kind, b.id, (cur) => {
      const x = cur || { hp, s: b.start, h: {} };
      x.h = x.h || {};
      if (x.k) return { fail: 'killed' };
      const room = Math.max(0, x.hp - WorldBossSystem.total(x));
      const d = Math.min(room, dmg);
      if (d <= 0) return { fail: 'killed' };
      const mine = x.h[me] || [name, 0, 0];
      x.h[me] = [name, (Number(mine[1]) || 0) + d, (Number(mine[2]) || 0) + 1];
      if (WorldBossSystem.total(x) >= x.hp) x.k = at;
      return { data: x, result: { d, kill: !!x.k } };
    }, { lat: null, lon: null });
    const done = (res) => {
      if (exp?.bossResult) exp.bossResult.pending = false;
      if (res?.ok) {
        if (exp?.bossResult && res.result.d < dmg) exp.bossResult.events.push(`（${b.name}剩下的血量只有 ${fmtWan(res.result.d)}）`);
        if (res.result.kill) {
          exp?.bossResult?.events.push(`🏆 ${b.name}被擊倒了！結算後依傷害排名發放獎勵`);
          g.log(`🏆 ${b.icon} ${b.name}被擊倒了！`, 'success');
          g.toast(`🏆 ${b.name}被擊倒了！`, 'success');
        }
        return;
      }
      if (res?.reason === 'killed') {
        exp?.bossResult?.events.push(`🏳️ 晚了一步：${b.name}已經被其他玩家擊倒，這次傷害不計入`);
        return;
      }
      // 連線失敗：之後重試
      this.st.pending.push(job);
    };
    const p = run();
    if (p?.then) p.then(done).catch(() => this.st.pending.push(job));
    else this.st.pending.push(job);
  }

  /** 重試寫入失敗的傷害 */
  retry() {
    const list = this.st.pending.splice(0);
    list.slice(-6).forEach((j) => {
      const b = this.get(j.id);
      if (b && Date.now() < b.end + WORLD_BOSS.settleMs) this.write(b, j.dmg, j.at, j.exp);
    });
  }

  /** 返回避難所時的報告 */
  report(exp) {
    if (!exp.bossDone && !exp.recalled) this.fight(exp, exp.startAt + (exp.travelMs || 0));
    const g = this.game;
    const b = this.get(exp.bossId);
    const r = exp.bossResult || { dmg: 0, events: [] };
    const members = exp.memberIds.map((id) => g.survivors.get(id)).filter(Boolean);
    const gained = { ...(exp.carried?.gained || {}) };
    const note = exp.carried ? g.exploration.bringCarried(exp, 1, members).replace('先前地點取得的物資帶回避難所', '物資帶回避難所') : '';
    return {
      id: uid('rp'), poiName: b ? `${b.icon} ${b.name}` : '屍王', poiType: 'military', at: exp.endAt,
      events: [...(exp.travelEvents || []), ...r.events, ...(note ? [note] : [])], resources: note ? gained : {}, items: [], blueprints: [],
      kills: exp.travelKills || 0, xp: exp.travelXp || 0, success: r.dmg > 0, members: members.map((m) => m.name),
    };
  }

  // ---------- 結算 ----------

  /** 自己的名次與箱子 */
  rankOf(b) {
    const list = this.ranking(b);
    const me = this.me();
    const i = list.findIndex((x) => x.p === me);
    if (i < 0) return null;
    const box = i === 0 ? 'gold' : i < WORLD_BOSS_REWARD.silverTop ? 'silver' : 'bronze';
    return {
      rank: i + 1, box, d: list[i].d, n: list.length, avg: list.reduce((s, x) => s + x.d, 0) / list.length,
    };
  }

  /** 開箱（依屍王與玩家固定亂數） */
  openBox(b, rk, killed) {
    const R = WORLD_BOSS_REWARD;
    const spec = R.box[rk.box];
    const mul = (killed ? 1 : R.failMul) * (rk.box === 'bronze' ? Math.min(R.bronzeShare[1], Math.max(R.bronzeShare[0], rk.d / Math.max(1, rk.avg))) : 1);
    return seeded(`wbbox:${b.id}:${this.me()}`, () => {
      const gained = { ...boxMats(spec, mul), coins: Math.round(spec.coins * mul), parts: Math.max(1, Math.round(spec.parts * mul)) };
      const blueprints = [];
      if (chance(spec.bp * (killed ? 1 : R.failMul))) {
        const bp = this.game.equipment.makeBlueprint(WORLD_BOSS.boss.level);
        if (spec.bpMin && RARITY_ORDER.indexOf(bp.rarity) < RARITY_ORDER.indexOf(spec.bpMin)) bp.rarity = spec.bpMin;
        blueprints.push(bp);
      }
      return { gained, blueprints };
    });
  }

  /** 屍王倒下或離開後：依排名發箱（每隻只領一次） */
  settle(now = Date.now()) {
    const g = this.game;
    let b = this.latest(now);
    const out = [];
    for (let i = 0; i < 4 && b; i += 1, b = this.prev(b)) {
      if (this.st.claimed.includes(b.id)) continue;
      const st = this.status(b, now);
      if (!['killed', 'fled'].includes(st.state) || now < st.at + WORLD_BOSS.settleMs) continue;
      if (now - b.end > 10 * DAY) continue;
      const rk = this.rankOf(b);
      if (!rk) continue;
      // 還有自己的傷害沒寫進去：等重試完
      if (this.st.pending.some((j) => j.id === b.id)) continue;
      this.st.claimed = [...this.st.claimed, b.id].slice(-12);
      const killed = st.state === 'killed';
      const box = this.openBox(b, rk, killed);
      const got = g.grant(box.gained);
      g.state.inventory.blueprints.push(...box.blueprints);
      const spec = WORLD_BOSS_REWARD.box[rk.box];
      const head = killed ? `🏆 ${b.icon} ${b.name}已被擊倒` : `🏃 ${b.icon} ${b.name}時間到離開了（獎勵減半）`;
      const report = {
        id: uid('rp'), poiName: `${b.icon} ${b.name}・結算`, poiType: 'military', at: now,
        events: [head, `你的傷害 ${fmtWan(rk.d)}・第 ${rk.rank} 名（共 ${rk.n} 人）`, `${spec.icon} 獲得${spec.name}`],
        resources: got, items: [], blueprints: box.blueprints, kills: 0, xp: 0, success: true, members: [], worldBoss: true,
      };
      out.push(report);
      g.log(`${spec.icon} ${b.name}結算：第 ${rk.rank} 名，獲得${spec.name}`, 'success');
      g.toast(`${spec.icon} ${b.name}結算：第 ${rk.rank} 名，獲得${spec.name}`, 'success');
    }
    if (out.length) {
      const st = g.state;
      st.reports = trimReports([...out, ...(st.reports || [])]);
      g.bus.emit('expedition:done', out);
    }
    return out;
  }

  update(now = Date.now()) {
    if (this.st.pending.length && now - (this.retryAt || 0) > 30000) {
      this.retryAt = now;
      this.retry();
    }
    if (now - (this.settleAt || 0) > 10000) {
      this.settleAt = now;
      this.settle(now);
    }
  }

  /** 唯一編號（測試用） */
  static uid() {
    return uid('wb');
  }
}
