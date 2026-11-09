import { unitPower } from '../utils/math.js';
import {
  DG_TZ_MS, DG_TIME, DG_FLOORS, DG_TEAM, DG_MAX_SIGNUPS, DG_RULES, DG_DIFF, DG_ROSTER, DG_OBSTACLES, DG_BOSSES, DG_DROPS,
  DG_FLOOR_LOOT, DUNGEONS, DUNGEON_KEYS, DG_CORES, DG_GEAR, DG_SLOTS, DG_CRAFT, DG_RECIPES, DG_SET, DG_SET_STAT,
  DG_STAT_NAME, DG_RARITY,
} from '../config/dungeons.js';
import { CLASSES } from '../config/survivors.js';
import { SUPPLIES, SUPPLY_KEYS } from '../config/supplies.js';
import { RARITIES, ITEM_MODELS } from '../config/equipment.js';
import { canAfford, payCost } from './costUtils.js';
import { AssistSystem } from './AssistSystem.js';
import {
  withOwnSeed, randFloat, randInt, chance, uid,
} from '../utils/math.js';

const DAY_MS = 24 * 3600 * 1000;
const pad = (n) => String(n).padStart(2, '0');
/** 字串雜湊（亂數種子） */
export function dgHash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
/** 亂數洗牌（使用目前的亂數來源，副本計算時是固定種子） */
const shuffle = (arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(randFloat(0, i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

/**
 * 地下感染區（多人副本）。
 *
 * 共用資料：每個副本每天一個物件（種類 dg、編號「副本-日期」），存報名清單與每人倖存者的能力快照。
 * 報名、取消、更新快照都以「先到先得」寫入，兩人同時搶最後名額也不會重複。
 *
 * 18:00 開打後，每位參加者讀同一份報名清單，依報名先後分團，
 * 以「副本＋日期＋團號＋成員」當亂數種子算出 20 層的結果：大家看到的結果完全相同。
 * 每層 9 分鐘，依時間逐層公布；結束時（通關或失敗的那一層）各自結算自己的獎勵。
 */
export class DungeonSystem {
  /** @param {import('../core/Game.js').Game} game */
  constructor(game) {
    this.game = game;
    /** 計算結果快取（不存檔，重新開啟時會算出同樣的結果） */
    this.cache = new Map();
    game.shared?.watch('dg', 5);
  }

  get state() {
    const st = this.game.state;
    st.dungeon = st.dungeon || { sign: {} };
    st.dungeon.sign = st.dungeon.sign || {};
    return st.dungeon;
  }

  myId() {
    const w = this.game.world;
    let id = w?.myId;
    try { id = id || w?.identity?.().id; } catch { /* 沒有身分 */ }
    return id || 'local';
  }

  // ================= 時間 =================

  /** 台灣時間當天 00:00 的時間戳 */
  static dayStart(now) {
    return Math.floor((now + DG_TZ_MS) / DAY_MS) * DAY_MS - DG_TZ_MS;
  }

  /** 台灣日期 YYYYMMDD */
  static dayKey(now) {
    const d = new Date(now + DG_TZ_MS);
    return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
  }

  /** 某天的各個時間點 */
  static times(day0) {
    const start = day0 + DG_TIME.start;
    return {
      open: day0 + DG_TIME.open, close: day0 + DG_TIME.close, lock: day0 + DG_TIME.lock, depart: day0 + DG_TIME.depart, start, end: start + DG_FLOORS * DG_TIME.floorMs,
    };
  }

  /** 現在的階段：before／signup／closed（截止～鎖定）／locked（鎖定～出發）／gather（集結）／run／after */
  static phase(now) {
    const t = DungeonSystem.times(DungeonSystem.dayStart(now));
    if (now < t.open) return 'before';
    if (now < t.close) return 'signup';
    if (now < t.lock) return 'closed';
    if (now < t.depart) return 'locked';
    if (now < t.start) return 'gather';
    if (now < t.end) return 'run';
    return 'after';
  }

  static objId(dg, day) {
    return `${dg}-${day}`;
  }

  // ================= 報名 =================

  /** 共用的報名資料 */
  data(dg, day) {
    return this.game.shared.get('dg', DungeonSystem.objId(dg, day));
  }

  /** 今天（或指定日）自己在某副本的報名紀錄 */
  record(dg, now = Date.now()) {
    return this.state.sign[DungeonSystem.objId(dg, DungeonSystem.dayKey(now))] || null;
  }

  /** 倖存者今天報名的副本（沒有則 null） */
  signedDungeon(svId, now = Date.now()) {
    const day = DungeonSystem.dayKey(now);
    const rec = Object.values(this.state.sign).find((r) => r.svId === svId && r.day === day && !r.cancelled);
    return rec ? rec.dg : null;
  }

  /** 倖存者是否已被副本鎖定（17:50 起到結算前不能外出） */
  isLocked(sv, now = Date.now()) {
    if (!sv) return false;
    if (sv.dungeon) return true;
    const rec = Object.values(this.state.sign).find((r) => r.svId === sv.id && !r.cancelled && !r.settled && !r.excluded);
    return !!rec && now >= DungeonSystem.times(rec.day0).lock;
  }

  /** 倖存者在副本中的能力快照（其他玩家計算戰鬥用） */
  snapshot(sv) {
    const g = this.game;
    const u = AssistSystem.unitData(g, sv, 0, { withMeds: true });
    // 精簡（共用資料每個副本每天上限 16KB）：名稱、等級另存，開打時一律滿血
    delete u.name; delete u.lv; delete u.i; delete u.hp;
    if (u.meds) delete u.meds.key;
    // 重傷時需要的藥品是否足夠治療到滿血
    const lost = g.survivors.maxHp(sv) - g.survivors.hpOf(sv);
    const heal = g.survivors.medicines(sv).reduce((s, m) => s + g.survivors.healAmount(sv, m.key) * ((m.bag || 0) + (g.survivors.atShelter(sv) ? m.store || 0 : 0)), 0);
    // 只在需要時記錄（節省共用資料空間）：sev 重傷、med 藥品足夠、si 套裝感染減免
    const out = {
      p: this.myId(), n: String(g.state.player.name || '倖存者').slice(0, 8), s: sv.id, sn: String(sv.name).slice(0, 8), c: sv.classId, lv: sv.level, u,
      bpm: +(1 + g.research.bonus('blueprintPct')).toFixed(2),
      pw: Math.round(g.survivors.stats(sv).power),
    };
    if (sv.severe) { out.sev = true; out.med = heal >= lost; }
    const si = this.setInfReduce(sv);
    if (si) out.si = si;
    return out;
  }

  /** 可以報名嗎 */
  canSignup(dg, svId, now = Date.now()) {
    const g = this.game;
    if (!DUNGEONS[dg]) return { ok: false, reason: '找不到副本' };
    if (!g.shelter.hasShelter()) return { ok: false, reason: '請先建立避難所' };
    const ph = DungeonSystem.phase(now);
    if (ph === 'before') return { ok: false, reason: '每天 00:00 換日後開放報名' };
    if (ph !== 'signup') return { ok: false, reason: '今天的報名已經截止（17:40）' };
    const sv = g.survivors.get(svId);
    if (!sv) return { ok: false, reason: '找不到倖存者' };
    if (sv.isLeader) return { ok: false, reason: '指揮官不能參加副本' };
    if (this.record(dg, now) && !this.record(dg, now).cancelled) return { ok: false, reason: '今天已經報名這個副本（每個副本每天一次）' };
    const other = this.signedDungeon(svId, now);
    if (other) return { ok: false, reason: `${sv.name} 今天已經報名「${DUNGEONS[other].name}」` };
    const d = this.data(dg, DungeonSystem.dayKey(now));
    if ((d?.list || []).length >= DG_MAX_SIGNUPS) return { ok: false, reason: `今天的名額已滿（${DG_MAX_SIGNUPS} 人）` };
    return { ok: true, sv };
  }

  /** 報名：指定一名倖存者（指揮官除外） */
  async signup(dg, svId, now = Date.now()) {
    const g = this.game;
    const check = this.canSignup(dg, svId, now);
    if (!check.ok) return check;
    const sv = check.sv;
    const day = DungeonSystem.dayKey(now);
    const id = DungeonSystem.objId(dg, day);
    const entry = { ...this.snapshot(sv), at: now };
    const me = entry.p;
    const write = () => g.shared.update('dg', id, (d) => {
      const data = d || { dg, day, list: [] };
      data.list = Array.isArray(data.list) ? data.list : [];
      if (data.list.some((e) => e.p === me)) return { fail: '今天已經報名這個副本（每個副本每天一次）' };
      if (data.list.length >= DG_MAX_SIGNUPS) return { fail: `今天的名額已滿（${DG_MAX_SIGNUPS} 人）` };
      data.list.push(entry);
      return { data };
    }, { lat: null, lon: null });
    let r = await write();
    // 剛登入、伺服器還沒登記自己時：同步一次再試
    if (!r.ok && /帳號|forbidden/.test(r.reason || '') && g.world?.sync) {
      await g.world.sync().catch(() => {});
      r = await write();
    }
    if (!r.ok) return r;
    this.state.sign[id] = {
      dg, day, day0: DungeonSystem.dayStart(now), svId: sv.id, svName: sv.name, at: now, pushedAt: now, snap: JSON.stringify([entry.u, entry.pw]),
    };
    g.log(`🕳️ ${sv.name} 報名「${DUNGEONS[dg].name}」（今天 18:00 開打）`, 'info');
    g.changed?.();
    return { ok: true, msg: `已報名「${DUNGEONS[dg].name}」：${sv.name}（17:50 鎖定、18:00 開打）` };
  }

  /** 取消報名（17:40 截止前） */
  async cancel(dg, now = Date.now()) {
    const g = this.game;
    const rec = this.record(dg, now);
    if (!rec || rec.cancelled) return { ok: false, reason: '今天沒有報名這個副本' };
    if (DungeonSystem.phase(now) !== 'signup') return { ok: false, reason: '報名截止後不能取消' };
    const id = DungeonSystem.objId(dg, rec.day);
    const me = this.myId();
    const r = await g.shared.update('dg', id, (d) => {
      if (!d) return { fail: '找不到報名資料' };
      d.list = (d.list || []).filter((e) => e.p !== me);
      return { data: d };
    });
    if (!r.ok) return r;
    delete this.state.sign[id];
    g.log(`🕳️ 取消報名「${DUNGEONS[dg].name}」`, 'info');
    g.changed?.();
    return { ok: true, msg: `已取消報名「${DUNGEONS[dg].name}」` };
  }

  /** 更新自己在共用資料中的快照（截止前，或鎖定時的最終狀態） */
  async pushEntry(rec, patch = {}, now = Date.now()) {
    const g = this.game;
    const sv = g.survivors.get(rec.svId);
    if (!sv) return;
    const id = DungeonSystem.objId(rec.dg, rec.day);
    const me = this.myId();
    const snap = this.snapshot(sv);
    if (now >= DungeonSystem.times(rec.day0).lock + 60000) return; // 鎖定之後不再改（避免和其他玩家的計算不同）
    rec.pushedAt = now;
    const r = await g.shared.update('dg', id, (d) => {
      const e = (d?.list || []).find((x) => x.p === me);
      if (!e) return { fail: 'gone' };
      delete e.sev; delete e.med; delete e.si;
      Object.assign(e, { ...snap, ...patch, at: e.at });
      return { data: d };
    }).catch(() => null);
    if (r?.ok) rec.snap = JSON.stringify([snap.u, snap.pw]);
  }

  // ================= 分團與計算 =================

  /**
   * 依報名先後分團（v11.2：最多 12 人、只有一團）；鎖定時重傷又沒有藥品的人不能出擊。
   * @returns {{groups:object[][], out:object[], cancelled:boolean}}
   */
  static groupsOf(data) {
    // 報名額滿 12 人（同一團）：超過的部分不計（舊資料或同時搶名額才可能發生）
    const list = [...(data?.list || [])].filter((e) => e && e.p && e.u && DungeonSystem.validEntry(e))
      .sort((a, b) => (a.at || 0) - (b.at || 0) || String(a.p).localeCompare(String(b.p))).slice(0, DG_MAX_SIGNUPS);
    const out = list.filter((e) => e.x || (e.sev && !e.med));
    const ready = list.filter((e) => !out.includes(e));
    if (ready.length < DG_TEAM.min) return { groups: [], out, cancelled: true, list };
    const n = ready.length;
    const G = Math.ceil(n / DG_TEAM.max);
    const base = Math.floor(n / G);
    const extra = n % G;
    const groups = [];
    let i = 0;
    for (let k = 0; k < G; k += 1) {
      const size = base + (k < extra ? 1 : 0);
      groups.push(ready.slice(i, i + size));
      i += size;
    }
    return {
      groups, out, cancelled: false, list,
    };
  }

  /** 報名資料的戰力（舊資料沒有 pw 時，用快照的能力依遊戲的戰力公式換算） */
  static powerOf(e) {
    if (Number.isFinite(e?.pw)) return e.pw;
    const u = e?.u;
    if (!u) return 0;
    return unitPower(u);
  }

  static validEntry(e) {
    return typeof e.p === 'string' && typeof e.s === 'string' && CLASSES[e.c] && e.u && Number.isFinite(e.u.maxHp);
  }

  /** 某副本某天的全部結果（快取）；資料還沒同步時回傳 null */
  results(dg, day) {
    const d = this.data(dg, day);
    if (!d) return null;
    const key = `${dg}-${day}`;
    const sig = JSON.stringify(d.list || []);
    const hit = this.cache.get(key);
    if (hit && hit.sig === sig) return hit.res;
    const day0 = DungeonSystem.dayStart(Date.UTC(+day.slice(0, 4), +day.slice(4, 6) - 1, +day.slice(6, 8), 12) - DG_TZ_MS);
    const g = DungeonSystem.groupsOf(d);
    const start = DungeonSystem.times(day0).start;
    const runs = g.groups.map((members, gi) => {
      const run = this.simulate(dg, day, gi, members);
      run.start = start;
      run.endAt = start + run.endFloor * DG_TIME.floorMs;
      return run;
    });
    const res = { ...g, runs, day0 };
    this.cache.set(key, { sig, res });
    return res;
  }

  /** 計算一團的 20 層（固定亂數種子，所有玩家結果相同） */
  simulate(dg, day, gi, members) {
    const seed = dgHash(`${dg}|${day}|${gi}|${members.map((m) => `${m.p}:${m.s}`).join(',')}`);
    const run = withOwnSeed(seed, () => this.runFloors(dg, members));
    run.group = gi;
    run.seed = seed;
    run.members = members.map((m) => ({
      p: m.p, n: m.n, s: m.s, sn: m.sn, c: m.c, lv: m.lv, bpm: m.bpm,
    }));
    run.rewards = members.map((m, i) => withOwnSeed(dgHash(`${seed}|r${i}`), () => this.memberRewards(dg, run, i, m)));
    return run;
  }

  /** 戰鬥單位（由快照建立） */
  static unitOf(e, i) {
    const u = AssistSystem.unitOf({ id: e.p, name: e.n }, e.u);
    u.id = `m${i}`;
    u.name = e.sn;
    u.cls = e.c;
    u.hp = u.maxHp;
    u.lifeSteal *= DG_RULES.lifeStealMul;
    u.base = {
      atk: u.atk, def: u.def, atkSpeed: u.atkSpeed,
    };
    u.sev = false;
    return u;
  }

  /** 20 層的過程 */
  runFloors(dg, members) {
    const g = this.game;
    const R = DG_RULES;
    const D = DG_DIFF;
    // 難度依人數成長，但最多以 DG_DIFF.maxPlayers（8 人）計算
    const N = Math.min(members.length, D.maxPlayers || members.length);
    const units = members.map((e, i) => DungeonSystem.unitOf(e, i));
    const stat = units.map(() => ({
      dealt: 0, taken: 0, healed: 0, obs: 0, downs: 0, xp: 0, coins: 0, floors: [], boss: [], wins: 0,
    }));
    const setInf = Math.min(0.1, members.reduce((s, m) => s + (Number(m.si) || 0), 0));
    const alive = () => units.filter((u) => !u.sev);
    const count = (cls) => Math.min(2, alive().filter((u) => u.cls === cls).length);
    const floors = [];
    let inf = 0;
    let result = 'clear';
    let reason = '';
    let endFloor = DG_FLOORS;
    const fail = (f, why) => { result = 'fail'; reason = why; endFloor = f; };
    for (let f = 1; f <= DG_FLOORS && result === 'clear'; f += 1) {
      const fl = {
        f, obs: [], waves: [], events: [], rest: null,
      };
      floors.push(fl);
      // ---- 障礙 ----
      const mods = { atk: 1, hp: 1, hpLoss: 0 };
      const nObs = randInt(1, 3);
      shuffle(Object.keys(DG_OBSTACLES)).slice(0, nObs).forEach((id) => {
        const ob = DG_OBSTACLES[id];
        const cand = alive().filter((u) => u.cls === ob.cls);
        if (cand.length) {
          const by = cand.reduce((a, b) => (stat[units.indexOf(a)].obs <= stat[units.indexOf(b)].obs ? a : b));
          stat[units.indexOf(by)].obs += 1;
          fl.obs.push({ id, by: by.id, ok: true });
          return;
        }
        fl.obs.push({ id, by: null, ok: false });
        mods.atk *= ob.atk || 1;
        mods.hp *= ob.hp || 1;
        mods.hpLoss += ob.hpLoss || 0;
        inf += ob.inf || 0;
      });
      // ---- 感染 ----
      inf += R.infPerFloor * (1 - R.medicInfReduce * count('medic')) * (1 - setInf);
      const boss = DG_BOSSES[f] || (f === DG_FLOORS ? { skill: 'final' } : null);
      if (boss?.skill === 'poison') {
        const half = count('medic') ? 0.5 : 1;
        mods.hpLoss += 0.1 * half;
        inf += 10 * half;
        fl.events.push(`☠️ 毒霧${half < 1 ? '（醫生淨化一半）' : ''}`);
      }
      inf = Math.min(100, Math.round(inf * 10) / 10);
      fl.inf = inf;
      if (inf >= 100) {
        fl.events.push('☣️ 感染值滿 100，全隊撤退');
        fail(f, 'infection');
        break;
      }
      alive().forEach((u) => { u.hp = Math.max(1, u.hp - u.maxHp * mods.hpLoss); });
      // ---- 戰鬥（每層 2 波；首領層第 2 波是首領戰） ----
      for (let w = 0; w < 2; w += 1) {
        const fighters = alive();
        if (!fighters.length) { fail(f, 'wipe'); break; }
        const isBoss = !!boss && w === 1;
        const cls = new Set(fighters.map((u) => u.cls));
        const all5 = ['warrior', 'medic', 'engineer', 'scout', 'farmer'].every((c) => cls.has(c));
        const mul = Math.max(0.2, 1 - R.infStatPer10 * Math.floor(inf / 10)) * (all5 ? 1 + R.all5 : 1);
        const defMul = mul * (count('warrior') >= 2 ? 1 + R.warriorDef2 : 1);
        const spdMul = isBoss && boss.skill === 'scream' ? 1 - (count('scout') ? 0.075 : 0.15) : 1;
        fighters.forEach((u) => {
          u.atk = Math.round(u.base.atk * mul);
          u.def = Math.round(u.base.def * defMul);
          u.atkSpeed = +(u.base.atkSpeed * spdMul).toFixed(2);
        });
        const level = D.baseLevel + f;
        // 難度成長的層數：curve＝1 時就是 f−1；第 20 層一律是 19（最後一層難度不變）
        const step = (DG_FLOORS - 1) * ((f - 1) / (DG_FLOORS - 1)) ** (D.curve || 1);
        const MA = D.atk0 * D.atkGrow ** step * (N / 5) ** D.sizePow * mods.atk;
        const MH = D.hp0 * D.hpGrow ** step * mods.hp;
        const MD = D.defGrow ** step;
        const roster = DG_ROSTER(f);
        const guard = isBoss ? 1 - R.engineerGuard * count('engineer') : 1;
        const enemies = [];
        const n = isBoss ? Math.ceil((N * D.perPlayer) / 2) + (boss.skill === 'final' ? N : 0) : N * D.perPlayer;
        for (let i = 0; i < n; i += 1) {
          const e = g.combat.createEnemy(roster[i % roster.length], level);
          e.maxHp = Math.round(e.maxHp * MH);
          e.atk = Math.round(e.atk * MA * guard);
          e.def = Math.round(e.def * MD);
          enemies.push(e);
        }
        if (isBoss) {
          const final = boss.skill === 'final';
          const def = final ? { base: 'generalBoss', ...DUNGEONS[dg].final } : boss;
          const b = g.combat.createEnemy(def.base, level);
          b.name = def.name;
          b.icon = def.icon;
          const smash = boss.skill === 'smash' && count('warrior') ? 0.7 : 1;
          b.maxHp = Math.round(b.maxHp * MH * N * D.bossHpPer * (final ? D.finalHp * 1.1 : 1));
          b.atk = Math.round(b.atk * MA * D.bossAtk * (final ? D.finalAtk * 1.15 : 1) * smash * guard);
          b.def = Math.round(b.def * MD);
          enemies.push(b);
        }
        const r = g.combat.simulate([], enemies, { allies: fighters, record: false, maxTime: isBoss ? R.bossMaxSec : R.fightMaxSec });
        const downNow = [];
        r.team.forEach((t) => {
          const u = units.find((x) => x.id === t.id);
          if (!u) return;
          const st = stat[units.indexOf(u)];
          u.hp = t.hp;
          if (u.meds) u.meds.qty = Math.max(0, u.meds.qty - (t.medsUsed || 0));
          st.dealt += t.dealt || 0;
          st.taken += t.taken || 0;
          st.healed += t.healed || 0;
          if (t.down || t.hp <= 0) {
            u.sev = true;
            u.hp = 0;
            st.downs += 1;
            downNow.push(u.id);
          }
        });
        const xpEach = Math.round(r.xp / Math.max(1, fighters.length));
        const coinsEach = Math.round(r.coins / Math.max(1, fighters.length));
        fighters.forEach((u) => {
          const st = stat[units.indexOf(u)];
          // 首領戰：有參與就有獎勵（戰鬥中倒下也算）；一般戰鬥：倒下的人沒有經驗
          if (r.victory && (isBoss || !downNow.includes(u.id))) {
            st.xp += xpEach;
            st.coins += coinsEach;
          }
          if (isBoss && r.victory) st.boss.push(f);
        });
        fl.waves.push({
          boss: isBoss, name: isBoss ? (boss.skill === 'final' ? DUNGEONS[dg].final.name : boss.name) : null, victory: r.victory, sec: r.duration, kills: r.kills.length, enemies: enemies.length, xpEach, coinsEach, downs: downNow, fighters: fighters.map((u) => u.id),
        });
        if (!r.victory) { fail(f, r.duration >= (isBoss ? R.bossMaxSec : R.fightMaxSec) - 0.5 ? 'timeout' : 'wipe'); break; }
      }
      if (result !== 'clear') break;
      fl.scout = count('scout') > 0;
      fl.farmer = count('farmer') > 0;
      fl.all5 = ['warrior', 'medic', 'engineer', 'scout', 'farmer'].every((c) => alive().some((u) => u.cls === c));
      // 本層結束時沒有重傷的人：計算本層物資
      alive().forEach((u) => stat[units.indexOf(u)].floors.push(f));
      // ---- 休息站 ----
      if (f % R.restEvery === 0 && f < DG_FLOORS) {
        const medics = alive().filter((u) => u.cls === 'medic').length;
        const revived = units.filter((u) => u.sev).slice(0, medics * R.reviveEach);
        revived.forEach((u) => { u.sev = false; u.hp = Math.round(u.maxHp * R.reviveHp); });
        const heal = fl.farmer ? R.restHealFarmer : R.restHeal;
        alive().forEach((u) => { if (!revived.includes(u)) u.hp = Math.min(u.maxHp, Math.round(u.hp + u.maxHp * heal)); });
        const before = inf;
        inf = Math.max(0, inf - (medics ? R.restInfMedic : R.restInf));
        fl.rest = {
          revived: revived.map((u) => u.id), heal, inf: [before, inf], left: units.filter((u) => u.sev).map((u) => u.id),
        };
      }
      fl.hp = units.map((u) => (u.sev ? 0 : Math.round((100 * u.hp) / u.maxHp)));
      fl.st = stat.map((x) => [x.dealt, x.taken, x.healed, x.obs]);
      fl.inf2 = inf;
    }
    const last = floors[floors.length - 1];
    if (last && !last.hp) {
      last.hp = units.map((u) => (u.sev ? 0 : Math.round((100 * u.hp) / u.maxHp)));
      last.st = stat.map((x) => [x.dealt, x.taken, x.healed, x.obs]);
    }
    const ids = units.map((u) => u.id);
    const mvp = (k) => {
      const i = stat.reduce((best, s, j) => (s[k] > stat[best][k] ? j : best), 0);
      return stat[i][k] > 0 ? ids[i] : null;
    };
    return {
      floors, result, reason, endFloor, stat, ids,
      final: units.map((u) => ({ id: u.id, sev: u.sev, hp: u.sev ? 0 : +(u.hp / u.maxHp).toFixed(3) })),
      mvp: {
        dealt: mvp('dealt'), taken: mvp('taken'), healed: mvp('healed'), obs: mvp('obs'),
      },
    };
  }

  /** 某位參加者的獎勵（每人各自的亂數種子：其他玩家也能算出相同的結果） */
  memberRewards(dg, run, i, m) {
    const st = run.stat[i];
    const mats = {};
    const pool = SUPPLY_KEYS.filter((k) => ['part', 'fabric'].includes(SUPPLIES[k].cat) && k !== 'casing');
    st.floors.forEach((f) => {
      const fl = run.floors[f - 1];
      const tiers = DG_FLOOR_LOOT.tiers(f);
      const kinds = DG_FLOOR_LOOT.kinds + (fl?.scout ? 1 : 0);
      const mul = (fl?.farmer ? 1 + DG_RULES.farmerLoot : 1) * (fl?.all5 ? 1 + DG_RULES.all5 : 1);
      for (let k = 0; k < kinds; k += 1) {
        const tier = tiers[randInt(0, tiers.length - 1)];
        const keys = pool.filter((x) => SUPPLIES[x].tier === tier);
        const key = keys[randInt(0, keys.length - 1)];
        const [a, b] = DG_FLOOR_LOOT.amount[tier];
        mats[key] = (mats[key] || 0) + Math.round(randInt(a, b) * mul);
      }
    });
    const cores = {};
    const bps = [];
    const coreKey = DUNGEONS[dg].core;
    st.boss.forEach((f) => {
      const dr = DG_DROPS[f];
      if (!dr) return;
      if (chance(dr.core)) cores[coreKey] = (cores[coreKey] || 0) + randInt(dr.coreN[0], dr.coreN[1]);
      if (chance(dr.bp * Math.max(1, Number(m.bpm) || 1))) bps.push({ f, model: `${dg}_${DG_SLOTS[randInt(0, DG_SLOTS.length - 1)]}` });
    });
    return {
      xp: st.xp, coins: st.coins, mats, cores, bps,
    };
  }

  /** 自己所在的團與位置 */
  myRun(rec) {
    const res = this.results(rec.dg, rec.day);
    if (!res) return null;
    const me = this.myId();
    if (res.cancelled) return { res, cancelled: true };
    if (res.out.some((e) => e.p === me)) return { res, out: true };
    for (const run of res.runs) {
      const i = run.members.findIndex((m) => m.p === me);
      if (i >= 0) return { res, run, i };
    }
    return { res, missing: true };
  }

  /** 進行中的層數（已公布的層數 +1；結束後為最後一層） */
  static floorAt(run, now) {
    const done = Math.floor((now - run.start) / DG_TIME.floorMs);
    return Math.max(1, Math.min(run.endFloor, done + 1));
  }

  /** 已公布結果的層數 */
  static revealed(run, now) {
    return Math.max(0, Math.min(run.endFloor, Math.floor((now - run.start) / DG_TIME.floorMs)));
  }

  // ================= 每秒更新 =================

  update(now = Date.now()) {
    const g = this.game;
    Object.entries(this.state.sign).forEach(([id, rec]) => {
      if (rec.settled) {
        if (now - rec.day0 > 3 * DAY_MS) delete this.state.sign[id];
        return;
      }
      const t = DungeonSystem.times(rec.day0);
      const sv = g.survivors.get(rec.svId);
      // 報名的倖存者已經不在（驅逐、死亡）：截止前自動取消報名，空出名額也可以改派其他人
      if (!sv && !rec.cancelled && now < t.close && !rec.dropping) {
        rec.dropping = true;
        this.cancel(rec.dg, now).then((r) => {
          if (r?.ok) g.log(`🕳️ ${rec.svName} 已不在避難所，自動取消「${DUNGEONS[rec.dg].name}」的報名`, 'info');
        }).finally(() => { rec.dropping = false; });
        return;
      }
      // 報名期間：倖存者的能力或戰力有變動（換裝備、升級…）就更新快照（最多每 15 秒寫入一次）
      if (now < t.lock && sv && now - (rec.checkedAt || 0) >= 1000) {
        rec.checkedAt = now;
        const sn = this.snapshot(sv);
        const snap = JSON.stringify([sn.u, sn.pw]);
        if (snap !== rec.snap && now - (rec.pushedAt || 0) >= 15000) this.pushEntry(rec, {}, now);
      }
      if (now >= t.lock && !rec.locked) this.lock(rec, Math.min(now, t.lock));
      if (now >= t.depart && !rec.departed && rec.locked && !rec.excluded) this.depart(rec);
      if (now >= t.start) this.progress(rec, now);
    });
  }

  /** 17:50 鎖定：外出中的小隊召回；重傷用藥治療到滿血，藥品不夠就不能出擊 */
  lock(rec, at) {
    const g = this.game;
    rec.locked = true;
    const sv = g.survivors.get(rec.svId);
    if (!sv) {
      rec.excluded = 'gone';
      this.pushEntry(rec, { x: 'gone' }, at);
      return;
    }
    const ex = g.exploration;
    ex.update(at, { silent: true });
    // 控制點駐防中：不叫回（駐防到撤回或被打下為止），這次副本不能參加
    if (g.state.expeditions.some((exp) => exp.kind === 'cpGuard' && !exp.recalled && !exp.defeated && (exp.memberIds || []).includes(sv.id))) {
      rec.excluded = 'guard';
      g.log(`🛡️ ${sv.name} 正在駐防控制點，不會被叫回，無法參加「${DUNGEONS[rec.dg].name}」`, 'danger');
      this.pushEntry(rec, { x: 'guard' }, at);
      return;
    }
    [...g.state.expeditions].filter((exp) => (exp.memberIds || []).includes(sv.id)).forEach((exp) => {
      exp.queue = [];
      if (exp.kind === 'rally') g.rally.withdraw(exp, at);
      else if (ex.canRecall(exp, at) && exp.startAt <= at) ex.recall(exp.id, at);
    });
    if (sv.severe) {
      for (let i = 0; i < 60 && sv.severe; i += 1) if (!g.survivors.heal(sv.id).ok) break;
      if (sv.severe) {
        rec.excluded = 'nomed';
        g.log(`🕳️ ${sv.name} 重傷且藥品不足，無法參加「${DUNGEONS[rec.dg].name}」`, 'danger');
        this.pushEntry(rec, { x: 'nomed', sev: true, med: false }, at);
        return;
      }
      g.log(`🕳️ ${sv.name} 為了副本使用藥品治療`, 'info');
    }
    g.log(`🔒 ${sv.name} 已鎖定，準備前往「${DUNGEONS[rec.dg].name}」`, 'info');
    this.pushEntry(rec, { sev: false, med: true }, at);
  }

  /** 17:55 出發集結 */
  depart(rec) {
    const sv = this.game.survivors.get(rec.svId);
    rec.departed = true;
    if (!sv) return;
    sv.status = 'exploring';
    sv.dungeon = { dg: rec.dg, day: rec.day };
    this.game.bus?.emit?.('map:changed');
  }

  /** 開打後：等結果算出來，結束時結算 */
  progress(rec, now) {
    const g = this.game;
    if (!g.shared.listedAt?.dg && g.shared.online && now - rec.day0 < DAY_MS) return; // 還沒同步到報名資料
    const mine = this.myRun(rec);
    if (!mine) {
      // 共用資料已經不在（例如很久沒上線）：直接結束
      if (now - rec.day0 > 2 * DAY_MS || !g.shared.online) this.settle(rec, null, now);
      return;
    }
    if (mine.cancelled || mine.out || mine.missing) {
      this.settle(rec, mine, now);
      return;
    }
    rec.group = mine.run.group;
    if (now >= mine.run.endAt) this.settle(rec, mine, now);
  }

  /** 結算：發放獎勵、倖存者回家、寫副本報告 */
  settle(rec, mine, now) {
    const g = this.game;
    rec.settled = true;
    const sv = g.survivors.get(rec.svId);
    const d = DUNGEONS[rec.dg];
    const release = () => {
      if (!sv) return;
      if (sv.dungeon) {
        delete sv.dungeon;
        const busy = g.state.expeditions.some((e) => (e.memberIds || []).includes(sv.id));
        if (!busy) sv.status = 'idle';
      }
    };
    if (!mine?.run) {
      release();
      const why = mine?.cancelled ? `報名人數不足（至少 ${DG_TEAM.min} 人）` : mine?.out || rec.excluded === 'nomed' ? '鎖定時重傷且藥品不足，無法出擊' : '沒有分配到隊伍';
      this.pushReport({
        kind: 'dungeon', dg: rec.dg, day: rec.day, status: mine?.cancelled ? 'cancel' : 'out', why, svName: rec.svName, at: now,
      });
      g.log(`🕳️ 「${d.name}」今天沒有出擊：${why}`, 'info');
      g.changed?.();
      return;
    }
    const { run, i } = mine;
    const rw = run.rewards[i];
    const fin = run.final[i];
    // 經驗、金錢、材料、核心材料、圖紙
    const xpMul = 1 + g.research.bonus('xpPct');
    if (sv) {
      release();
      // 副本中重傷不扣經驗
      g.survivors.gainXp(sv, rw.xp);
      if (fin.sev) {
        sv.severe = true;
        g.survivors.setHp(sv, 0);
      } else g.survivors.setHp(sv, Math.max(1, Math.round(g.survivors.maxHp(sv) * fin.hp)));
    }
    g.state.player.coins += rw.coins;
    g.equipment.addSupplies?.(rw.mats);
    const cores = this.cores();
    Object.entries(rw.cores).forEach(([k, n]) => { cores[k] = (cores[k] || 0) + n; });
    rw.bps.forEach((b) => g.state.inventory.blueprints.push({ id: uid('bp'), model: b.model, rarity: 'dungeon', dg: true }));
    this.pushReport({
      kind: 'dungeon', dg: rec.dg, day: rec.day, status: run.result, svName: rec.svName, at: now, group: run.group, me: i,
      xpGot: Math.round(rw.xp * xpMul), coins: rw.coins, mats: rw.mats, cores: rw.cores, bps: rw.bps.map((b) => b.model),
    });
    const clear = run.result === 'clear';
    const msg = `🕳️ 「${d.name}」${clear ? '通關！' : `失敗（停在第 ${run.endFloor} 層）`}${rw.bps.length ? '✨ 拿到副本圖紙！' : ''}`;
    g.log(msg, clear ? 'loot' : 'info');
    g.toast?.(msg, rw.bps.length ? 'loot' : 'info');
    g.changed?.();
  }

  /** 加入報告（副本報告存在探索報告列表） */
  pushReport(r) {
    const st = this.game.state;
    st.reports = st.reports || [];
    st.reports.unshift({
      id: uid('rp'), items: [], blueprints: [], events: [], resources: {}, members: [], kills: 0, success: r.status === 'clear', ...r, poiName: DUNGEONS[r.dg]?.name,
    });
    if (st.reports.length > 20) st.reports.length = 20;
  }

  /** 報告展開時重新算出的完整過程（同樣的種子＝同樣的結果） */
  reportRun(r) {
    const res = this.results(r.dg, r.day);
    return res?.runs?.[r.group] || null;
  }

  // ================= 核心材料、副本裝備 =================

  cores() {
    const st = this.game.state;
    st.dgCores = st.dgCores || {};
    return st.dgCores;
  }

  gearDef(id) {
    return DG_GEAR[id] || null;
  }

  /** 圖紙卡片上的一句說明 */
  gearLine(id) {
    const d = DG_GEAR[id];
    if (!d) return '';
    return `${CLASSES[d.cls].icon} ${CLASSES[d.cls].name}專用・需要${DG_CORES[DUNGEONS[d.dg].core].name} ×${DG_CRAFT.core[d.slot]}、💰${DG_CRAFT.coins[d.slot].toLocaleString()}`;
  }

  /** 製作需求（不含圖紙） */
  craftCost(id) {
    const d = DG_GEAR[id];
    if (!d) return null;
    return { ...DG_RECIPES[id], coins: DG_CRAFT.coins[d.slot] };
  }

  /** 可以製作嗎：需要圖紙、5 級工作台、核心材料、金幣與材料 */
  canCraft(id, bpId = null) {
    const g = this.game;
    const d = DG_GEAR[id];
    if (!d) return { ok: false, reason: '未知的副本裝備' };
    const bp = g.state.inventory.blueprints.find((b) => b.dg && b.model === id && (!bpId || b.id === bpId));
    if (!bp) return { ok: false, reason: '需要這件裝備的副本圖紙' };
    if (g.shelter.maxLevel('workbench') < DG_CRAFT.bench) return { ok: false, reason: `需要 ${DG_CRAFT.bench} 級工作台` };
    const coreKey = DUNGEONS[d.dg].core;
    const needCore = DG_CRAFT.core[d.slot];
    if ((this.cores()[coreKey] || 0) < needCore) return { ok: false, reason: `${DG_CORES[coreKey].name}不足（${this.cores()[coreKey] || 0}/${needCore}）` };
    const cost = this.craftCost(id);
    if (!canAfford(g.state, cost)) return { ok: false, reason: '材料或金幣不足' };
    if (!g.equipment.fits({ model: d.base, type: ITEM_MODELS[d.base]?.type }, 'store')) return { ok: false, reason: '倉庫空間不足' };
    return { ok: true, bp };
  }

  /** 製作副本裝備：消耗圖紙、核心材料、金幣與材料；做出來就綁定 */
  craft(id, bpId = null) {
    const g = this.game;
    const check = this.canCraft(id, bpId);
    if (!check.ok) return check;
    const d = DG_GEAR[id];
    const cost = this.craftCost(id);
    if (!payCost(g.state, cost)) return { ok: false, reason: '材料或金幣不足' };
    const coreKey = DUNGEONS[d.dg].core;
    this.cores()[coreKey] -= DG_CRAFT.core[d.slot];
    g.state.inventory.blueprints = g.state.inventory.blueprints.filter((b) => b.id !== check.bp.id);
    const item = this.makeGear(id);
    g.equipment.addItem(item, '製作');
    g.state.stats.crafted = (g.state.stats.crafted || 0) + 1;
    g.log(`✨ 製作副本裝備「${item.name}」`, 'loot');
    return { ok: true, item, msg: `製作完成：副本裝備「${item.name}」` };
  }

  /** 產生一件副本裝備（副本品級、每項素質 50% 起、綁定） */
  makeGear(id) {
    const d = DG_GEAR[id];
    const g = this.game;
    const item = g.equipment.generate({
      level: DG_CRAFT.level, model: d.base, rarity: 'dungeon', qualityAdd: DG_RARITY.qualityAdd,
    });
    item.name = d.name;
    item.dg = id;
    item.bound = true;
    item.power = g.equipment.itemPower(item);
    return item;
  }

  /** 套裝：身上穿的同副本裝備件數 */
  setCount(sv) {
    const g = this.game;
    const counts = {};
    Object.values(sv?.equipment || {}).forEach((itemId) => {
      const it = g.equipment.getItem(itemId);
      const def = it?.dg && DG_GEAR[it.dg];
      if (def && def.cls === sv.classId) counts[def.dg] = (counts[def.dg] || 0) + 1;
    });
    return counts;
  }

  /** 套裝加成：{ stat, pct, inf } */
  setBonus(sv) {
    const counts = this.setCount(sv);
    let pct = 0;
    let inf = 0;
    Object.values(counts).forEach((n) => DG_SET.forEach((t) => {
      if (n >= t.n) {
        pct += t.pct;
        inf += t.inf || 0;
      }
    }));
    return { stat: DG_SET_STAT[sv?.classId] || 'atk', pct, inf };
  }

  setInfReduce(sv) {
    return +this.setBonus(sv).inf.toFixed(3);
  }

  /** 套裝效果說明（三段） */
  static setText(cls) {
    const stat = DG_STAT_NAME[DG_SET_STAT[cls]] || '能力';
    const pct = (v) => `${Math.round(v * 1000) / 10}%`;
    return [
      `3 件：${CLASSES[cls].name}${stat} +${pct(DG_SET[0].pct)}`,
      `6 件：再 +${pct(DG_SET[1].pct)}、副本內感染累積 −${pct(DG_SET[1].inf)}`,
      `9 件：再 +${pct(DG_SET[2].pct)}（合計 +${pct(DG_SET.reduce((s2, t) => s2 + t.pct, 0))}）`,
    ];
  }

  /** 副本裝備顯示顏色 */
  static get color() {
    return RARITIES.dungeon.color;
  }
}

export { DUNGEON_KEYS };
