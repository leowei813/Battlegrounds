import {
  CONTROL_POINTS, cpById, cpAt, CP_GARRISON_MUL, CP_PLAYER_SIDE_MUL, FACTIONS, FACTION_KEYS, FACTION_SLOW_AT, defaultFaction, hqNeighbors, cpNeighbors, factionHq, CP_REFILL_PER_HOUR, CP_GUARD_MAX, CP_INCOME, CP_PART_QTY, CP_INCOME_HOUR,
} from '../config/controlPoints.js';
import { inNpcHome } from '../config/zones.js';
import { SUPPLIES, SUPPLY_KEYS } from '../config/supplies.js';
import { DAY_REAL_MS } from '../config/constants.js';
import {
  uid, haversine, randInt, weightedPick, formatDuration, unitPower,
} from '../utils/math.js';
import { AssistSystem } from './AssistSystem.js';
import { balanceMultipliers } from './MaterialBalance.js';
import { baseSupplyWeight } from './LootStock.js';

/** 駐防隊在控制點最多停留的時間（之後自動回家） */
const GUARD_STAY_MS = 7 * 24 * 3600000;
/** 運輸隊的移動速度（公尺／秒） */
const CONVOY_SPEED = 1.4;
/** 中立控制點的感染者守軍種類 */
const NEUTRAL_TYPES = ['walker', 'infected', 'berserker', 'mutant'];

/**
 * v14 控制點：佔領後該區域才能探索；佔領者與好友可以駐防；每天 06:00 運輸隊送回收益。
 *
 * 共用資料 cp:<id>：
 *  owners  [{ p, n }]   佔領者（集結打下的為所有參加者）
 *  faction  null|string  NPC 勢力（第 3 批）
 *  guards  [{ p, n, e, units, at }]  駐防隊（每名玩家最多 CP_GUARD_MAX 人）
 *  lost    守軍已損失的人數（每小時補回 CP_REFILL_PER_HOUR，即現實每 10 分鐘 1 人）；lostAt 損失時間
 */
export class ControlPointSystem {
  constructor(game) {
    this.game = game;
    this.busy = new Set();
    game.shared?.watch('cp', 5);
  }

  get st() {
    const s = this.game.state;
    if (!s.cp) s.cp = { incomeDay: 0, convoys: [] };
    if (!Array.isArray(s.cp.convoys)) s.cp.convoys = [];
    return s.cp;
  }

  myId() {
    const w = this.game.world;
    let id = w?.myId;
    try { id = id || w?.identity?.().id; } catch { /* 沒有身分 */ }
    return id || 'local';
  }

  /** 共用資料（沒有＝中立、守軍滿員） */
  data(id) {
    return this.game.shared?.get('cp', id) || null;
  }

  /** 佔領的勢力（沒有共用資料時：東側控制點屬於最近的大本營） */
  factionOf(id) {
    const d = this.data(id);
    if (d) return d.faction || null;
    return defaultFaction(cpById(id));
  }

  /** 勢力擁有的控制點 */
  factionCps(f) {
    return CONTROL_POINTS.filter((c) => this.factionOf(c.id) === f).map((c) => c.id);
  }

  owners(id) {
    return (this.data(id)?.owners || []).filter((o) => o && o.p);
  }

  /** 自己或好友 */
  isAlly(pid) {
    return pid === this.myId() || this.game.territory?.relation?.(pid) === 'friend';
  }

  /** 控制點的狀態：mine（自己或好友佔領）、hostile（敵對玩家）、other（其他玩家）、faction、neutral */
  statusOf(id) {
    const own = this.owners(id);
    if (this.factionOf(id)) return 'faction';
    if (!own.length) return 'neutral';
    if (own.some((o) => this.isAlly(o.p))) return 'mine';
    if (own.every((o) => this.game.territory?.relation?.(o.p) === 'hostile')) return 'hostile';
    return 'other';
  }

  /**
   * 這棟建築能不能探索：控制點區域要自己或好友佔領；勢力領地不能探索；其他地方自由探索。
   * @returns {{ok:boolean, reason?:string}}
   */
  canExplore(poi) {
    if (!poi || !Number.isFinite(poi.lat)) return { ok: true };
    if (inNpcHome(poi.lat, poi.lon)) return { ok: false, reason: '這裡是三大勢力的大本營領地，不能探索' };
    const cp = cpAt(poi.lat, poi.lon);
    if (!cp) return { ok: true };
    if (this.statusOf(cp.id) === 'mine') return { ok: true };
    return { ok: false, reason: `要先佔領控制點 #${cp.no}，才能探索這個區域` };
  }

  /** 目前的守軍人數（被打下後每小時補回） */
  garrisonCount(id, now = Date.now()) {
    const cp = cpById(id);
    const d = this.data(id);
    const full = cp.garrison.count;
    if (!d?.lost) return full;
    const back = Math.floor(((now - (d.lostAt || now)) / 3600000) * CP_REFILL_PER_HOUR);
    return Math.max(0, Math.min(full, full - d.lost + back));
  }

  /** NPC／感染者守軍（中立與勢力的控制點） */
  npcGarrison(id, now = Date.now()) {
    const cp = cpById(id);
    const d = this.data(id);
    const n = this.garrisonCount(id, now);
    const cb = this.game.combat;
    const fac = this.factionOf(id);
    const list = Array.from({ length: n }, (_, i) => (fac
      ? cb.createEnemy(i === 0 ? 'raiderChief' : 'raider', cp.garrison.level)
      : cb.createEnemy(NEUTRAL_TYPES[i % NEUTRAL_TYPES.length], cp.garrison.level, i === 0)));
    // 感染者守軍校正成同等級掠奪者的強度，再乘上控制點倍率（強度表見 docs/v14-plan.md）
    const ref = unitPower(cb.createEnemy('raider', cp.garrison.level));
    list.forEach((e) => {
      const k = (fac ? 1 : ref / Math.max(1, unitPower(e))) * CP_GARRISON_MUL * (cp.side === 'player' ? CP_PLAYER_SIDE_MUL : 1);
      e.maxHp = Math.round(e.maxHp * k); e.hp = e.maxHp; e.atk = Math.round(e.atk * k);
    });
    return list;
  }

  /** 防守方：玩家佔領的是駐防隊員，其他是 NPC／感染者守軍 */
  defenders(id, now = Date.now()) {
    if (this.owners(id).length && !this.factionOf(id)) {
      return (this.data(id)?.guards || []).flatMap((h) => (h.units || []).slice(0, CP_GUARD_MAX).map((u) => AssistSystem.unitOf({ id: h.p, name: h.n }, u)));
    }
    return this.npcGarrison(id, now);
  }

  /** 防守方戰力（顯示用） */
  defensePower(id, now = Date.now()) {
    return this.defenders(id, now).reduce((s, u) => s + unitPower(u), 0);
  }

  canAttack(id) {
    const g = this.game;
    const cp = cpById(id);
    if (!cp) return { ok: false, reason: '找不到控制點' };
    if (!g.shelter.hasShelter()) return { ok: false, reason: '請先建立避難所' };
    const s = this.statusOf(id);
    if (s === 'mine') return { ok: false, reason: '這是你或好友的控制點' };
    if (s === 'other') return { ok: false, reason: '只能攻打中立、勢力或敵對玩家的控制點' };
    return { ok: true };
  }

  /** 讓探索系統把控制點當成目的地 */
  asPoi(id) {
    const m = /^cp(?:guard)?:(cp\d+)$/.exec(String(id));
    const cp = m && cpById(m[1]);
    if (!cp) return null;
    const at = this.markerSpot(cp.id); // 隊伍前往地圖上的控制點圈圈
    return {
      id, name: `🚩 控制點 #${cp.no}`, lat: at.lat, lon: at.lon, type: 'military', icon: '🚩', cp: cp.id,
    };
  }

  /** 派隊攻打控制點 */
  attack(id, memberIds, opts = {}) {
    const c = this.canAttack(id);
    if (!c.ok) return c;
    const st = this.game.exploration.start(`cp:${id}`, memberIds, 2, false, Date.now(), { ...opts, kind: 'cp' });
    if (st.ok) st.exp.cpId = id;
    return st;
  }

  /** 我在這個控制點的駐防人數（含前往中） */
  myGuards(id) {
    return this.game.state.expeditions.filter((e) => e.kind === 'cpGuard' && e.cpId === id && !e.recalled && !e.defeated)
      .reduce((s, e) => s + e.memberIds.length, 0);
  }

  canGuard(id, n = 1) {
    if (!this.game.shelter.hasShelter()) return { ok: false, reason: '請先建立避難所' };
    if (this.statusOf(id) !== 'mine') return { ok: false, reason: '只能駐防自己或好友佔領的控制點' };
    if (this.myGuards(id) + n > CP_GUARD_MAX) return { ok: false, reason: `每名玩家每個控制點最多駐防 ${CP_GUARD_MAX} 人` };
    return { ok: true };
  }

  /** 派人駐防（抵達後留守，直到召回） */
  guard(id, memberIds, opts = {}) {
    const c = this.canGuard(id, memberIds.length);
    if (!c.ok) return c;
    const st = this.game.exploration.start(`cpguard:${id}`, memberIds, 0, false, Date.now(), { ...opts, kind: 'cpGuard' });
    if (!st.ok) return st;
    const exp = st.exp;
    exp.cpId = id;
    exp.searchMs = GUARD_STAY_MS;
    exp.endAt = exp.startAt + exp.travelMs * 2 + exp.searchMs;
    return { ok: true, exp, msg: `隊伍出發駐防控制點 #${cpById(id).no}，約 ${Math.max(1, Math.round(exp.travelMs / 60000))} 分鐘後抵達` };
  }

  /** 已抵達的駐防隊（寫入共用資料，讓攻打方能讀到守軍） */
  async syncGuards(now = Date.now()) {
    const g = this.game;
    const me = this.myId();
    const name = g.state.player.name || '倖存者';
    for (const exp of g.state.expeditions.filter((e) => e.kind === 'cpGuard' && e.cpId)) {
      const arrived = now >= exp.startAt + exp.travelMs;
      const d = this.data(exp.cpId);
      const listed = (d?.guards || []).some((x) => x.e === exp.id);
      if (exp.recalled || exp.defeated) {
        if (listed) await this.removeGuard(exp.cpId, exp.id);
        continue;
      }
      if (!arrived) continue;
      if (!exp.cpListed) {
        if (this.busy.has(exp.id)) continue;
        this.busy.add(exp.id);
        const units = g.rally.units(exp.memberIds);
        const r = await g.shared.update('cp', exp.cpId, (x) => {
          const data = x || { owners: [], guards: [] };
          if (!(data.owners || []).some((o) => this.isAlly(o.p))) return { fail: '控制點已經不是你或好友的' };
          data.guards = [...(data.guards || []).filter((h) => h.e !== exp.id), { p: me, n: name, e: exp.id, units, at: now }];
          return { data };
        }, { lat: cpById(exp.cpId).lat, lon: cpById(exp.cpId).lon });
        this.busy.delete(exp.id);
        if (r.ok) exp.cpListed = true;
        else { exp.cpListed = false; g.exploration.recall(exp.id, now); }
      } else if (d && !listed) {
        // 駐防隊被擊退（從共用資料中移除）：受傷回家
        exp.defeated = true;
        g.log(`🚩 控制點 #${cpById(exp.cpId).no} 的駐防隊被擊退，正在撤回避難所`, 'danger');
        g.exploration.recall(exp.id, now);
      }
    }
  }

  async removeGuard(id, expId) {
    return this.game.shared.update('cp', id, (x) => {
      if (!x) return { fail: 'none' };
      x.guards = (x.guards || []).filter((h) => h.e !== expId);
      return { data: x };
    });
  }

  /** 抵達控制點：和守軍交戰（攻打隊），結果寫進共用資料 */
  async resolveAttacks(now = Date.now()) {
    const g = this.game;
    for (const exp of g.state.expeditions.filter((e) => e.kind === 'cp' && e.cpId && !e.cpResult && !e.recalled)) {
      const at = exp.startAt + exp.travelMs;
      if (now < at || this.busy.has(exp.id)) continue;
      this.busy.add(exp.id);
      try {
        exp.cpResult = await this.fight(exp, at);
      } finally {
        this.busy.delete(exp.id);
      }
    }
  }

  async fight(exp, at) {
    const g = this.game;
    const id = exp.cpId;
    const cp = cpById(id);
    const members = exp.memberIds.map((x) => g.survivors.get(x)).filter(Boolean);
    const c = this.canAttack(id);
    if (!c.ok) return { victory: false, events: [`🚩 抵達時控制點 #${cp.no} ${c.reason}`] };
    const foes = this.defenders(id, at);
    const before = foes.length;
    const result = g.combat.simulate(members, foes, { title: `🚩 攻打控制點 #${cp.no}` });
    g.combat.applyOutcome(members, result, at);
    const me = this.myId();
    const name = g.state.player.name || '倖存者';
    const killed = result.foes.filter((f) => f.down).length;
    const events = [`⚔️ 控制點 #${cp.no}：守軍 ${before} 人，擊倒 ${killed} 人`];
    if (result.victory) {
      const r = await g.shared.update('cp', id, (x) => ({
        data: { ...(x || {}), owners: [{ p: me, n: name }], faction: null, guards: [], lost: cp.garrison.count, lostAt: at, takenAt: at },
      }), { lat: cp.lat, lon: cp.lon });
      events.push(r.ok ? `🏆 佔領控制點 #${cp.no}！這個區域的建築現在可以探索了` : `⚠️ 佔領失敗：${r.reason}`);
      if (r.ok) g.log(`🚩 佔領控制點 #${cp.no}`, 'success');
      return { victory: r.ok, events };
    }
    // 沒打下：守軍損失保留（NPC 守軍每小時補回；駐防隊員倒下的從名單移除）
    const downIds = new Set(result.foes.filter((f) => f.down).map((f) => f.ally?.player).filter(Boolean));
    await g.shared.update('cp', id, (x) => {
      const data = x || { owners: [], guards: [], faction: defaultFaction(cp) };
      if (data.owners?.length && !data.faction) data.guards = (data.guards || []).filter((h) => !downIds.has(h.p));
      else { data.lost = Math.min(cp.garrison.count, (cp.garrison.count - this.garrisonCount(id, at)) + killed); data.lostAt = at; }
      return { data };
    }, { lat: cp.lat, lon: cp.lon });
    events.push(`💀 沒能打下控制點 #${cp.no}`);
    return { victory: false, events };
  }

  /** 攻打隊回到避難所的報告 */
  report(exp) {
    const g = this.game;
    const cp = cpById(exp.cpId);
    const members = exp.memberIds.map((x) => g.survivors.get(x)).filter(Boolean);
    const r = exp.cpResult || { victory: false, events: ['🚩 隊伍撤回'] };
    return {
      id: uid('rp'), poiName: `🚩 控制點 #${cp?.no ?? '?'}`, poiType: 'military', at: exp.endAt,
      events: [...(exp.travelEvents || []), ...r.events], resources: {}, items: [], blueprints: [],
      kills: exp.travelKills || 0, xp: exp.travelXp || 0, success: !!r.victory, members: members.map((m) => m.name),
    };
  }

  /** 駐防隊回家的報告 */
  guardReport(exp) {
    const cp = cpById(exp.cpId);
    const members = exp.memberIds.map((x) => this.game.survivors.get(x)).filter(Boolean);
    return {
      id: uid('rp'), poiName: `🛡️ 駐防控制點 #${cp?.no ?? '?'}`, poiType: 'military', at: exp.endAt,
      events: [...(exp.travelEvents || []), exp.defeated ? '💀 駐防隊被擊退' : '🛡️ 駐防結束，回到避難所'], resources: {}, items: [], blueprints: [],
      kills: exp.travelKills || 0, xp: exp.travelXp || 0, success: !exp.defeated, members: members.map((m) => m.name),
    };
  }

  // ================= 每日收益 =================

  /** 今天 06:00 的現實時間 */
  incomeTime(now = Date.now()) {
    const t = this.game.time;
    const h = t.totalHours(now);
    const day0 = Math.floor(h / 24) * 24;
    return now - ((h - day0 - CP_INCOME_HOUR) / 24) * DAY_REAL_MS;
  }

  /** 收益內容（食物、木材、燃料＋隨機零件：階級越高機率越低、數量越少） */
  rollIncome(cp, rnd = Math.random) {
    const inc = CP_INCOME[cp.zone] || CP_INCOME[2];
    const out = { food: inc.food, wood: inc.wood, fuel: inc.fuel };
    const bal = balanceMultipliers(baseSupplyWeight);
    const kinds = randInt(inc.parts[0], inc.parts[1]);
    for (let i = 0; i < kinds; i += 1) {
      const tier = 1 + Number(weightedPick(Object.fromEntries(inc.tiers.map((w, k) => [k, w]))));
      const keys = SUPPLY_KEYS.filter((k) => SUPPLIES[k].cat === 'part' && SUPPLIES[k].tier === tier && SUPPLIES[k].tag !== 'ammo');
      if (!keys.length) continue;
      const k = weightedPick(Object.fromEntries(keys.map((x) => [x, baseSupplyWeight(x) * (bal[x] ?? 1)])));
      const [a, b] = CP_PART_QTY[tier];
      out[k] = (out[k] || 0) + randInt(a, b);
    }
    void rnd;
    return out;
  }

  /** 我可以拿收益的控制點：佔領者或駐防者（同一人只算一次） */
  incomeSources() {
    const me = this.myId();
    return CONTROL_POINTS.filter((cp) => {
      const d = this.data(cp.id);
      if (!d || d.faction) return false;
      return (d.owners || []).some((o) => o.p === me) || (d.guards || []).some((h) => h.p === me);
    });
  }

  /** 每天 06:00：每個控制點派運輸隊把收益送回避難所 */
  startConvoys(now = Date.now()) {
    const g = this.game;
    const sh = g.shelter.primary();
    if (!sh) return;
    const day = g.time.day(now);
    const at = this.incomeTime(now);
    if (now < at || this.st.incomeDay === day) return;
    this.st.incomeDay = day;
    this.incomeSources().forEach((cp) => {
      const dist = haversine(this.markerSpot(cp.id).lat, this.markerSpot(cp.id).lon, sh.lat, sh.lon);
      const travel = Math.round((dist / CONVOY_SPEED) * 1000);
      this.st.convoys.push({
        id: uid('cv'), cp: cp.id, from: { ...this.markerSpot(cp.id) }, to: { lat: sh.lat, lon: sh.lon }, startAt: at, endAt: at + travel, goods: this.rollIncome(cp),
      });
    });
    if (this.st.convoys.length) g.log(`🚚 控制點運輸隊出發：${this.st.convoys.length} 支，正把收益送回避難所`, 'info');
  }

  /** 運輸隊抵達：收益入庫 */
  deliverConvoys(now = Date.now()) {
    const g = this.game;
    const done = this.st.convoys.filter((c) => now >= c.endAt);
    if (!done.length) return;
    this.st.convoys = this.st.convoys.filter((c) => now < c.endAt);
    done.forEach((c) => {
      const got = g.grant(c.goods);
      const text = Object.entries(got).filter(([, v]) => v > 0).map(([k, v]) => `${SUPPLIES[k]?.name || { food: '食物', wood: '木材', fuel: '燃料' }[k] || k} ×${v}`).join('、');
      g.log(`🚚 控制點 #${cpById(c.cp)?.no} 的運輸隊抵達：${text || '沒有東西'}`, 'loot');
    });
  }

  /** 地圖顯示：運輸隊目前位置 */
  convoyView(now = Date.now()) {
    return this.st.convoys.map((c) => {
      const p = Math.max(0, Math.min(1, (now - c.startAt) / Math.max(1, c.endAt - c.startAt)));
      return { ...c, lat: c.from.lat + (c.to.lat - c.from.lat) * p, lon: c.from.lon + (c.to.lon - c.from.lon) * p, left: Math.max(0, c.endAt - now) };
    });
  }

  // ================= 敵對：共同擁有者變成敵對時回到中立 =================

  async checkHostileOwners(now = Date.now()) {
    const g = this.game;
    const me = this.myId();
    for (const cp of CONTROL_POINTS) {
      const own = this.owners(cp.id);
      if (!own.some((o) => o.p === me) || own.length < 2) continue;
      if (!own.some((o) => o.p !== me && g.territory?.relation?.(o.p) === 'hostile')) continue;
      if (this.busy.has(`h:${cp.id}`)) continue;
      this.busy.add(`h:${cp.id}`);
      // eslint-disable-next-line no-await-in-loop
      const r = await g.shared.update('cp', cp.id, (x) => ({ data: { ...(x || {}), owners: [], guards: [], faction: null, lost: cp.garrison.count, lostAt: now } }), { lat: cp.lat, lon: cp.lon });
      this.busy.delete(`h:${cp.id}`);
      if (r.ok) g.log(`🚩 控制點 #${cp.no} 的共同佔領者變成敵對，控制點回到中立`, 'danger');
    }
  }

  // ================= 三大勢力的行動 =================

  /** 勢力今天的進攻時間（遊戲時間 hour 點） */
  turnTime(f, now = Date.now()) {
    const t = this.game.time;
    const h = t.totalHours(now);
    const day0 = Math.floor(h / 24) * 24;
    return now - ((h - day0 - FACTIONS[f].hour) / 24) * DAY_REAL_MS;
  }

  /**
   * 勢力挑選進攻目標：只打和自己相鄰的控制點（沒有控制點時從大本營旁邊開始），
   * 優先：無人駐守 → 守軍戰力最弱 → 離大本營最近。中立、其他勢力、玩家的控制點都可能被打。
   */
  pickTarget(f, now = Date.now()) {
    const own = this.factionCps(f);
    const near = new Set(own.length ? own.flatMap((id) => cpNeighbors(id)) : hqNeighbors(f));
    own.forEach((id) => near.delete(id));
    const hq = this.hqLatLon(f);
    const list = [...near].map((id) => {
      const cp = cpById(id);
      const guarded = this.owners(id).length > 0 && !this.factionOf(id) && (this.data(id)?.guards || []).length > 0;
      return { id, guarded, power: this.defensePower(id, now), dist: haversine(cp.lat, cp.lon, hq.lat, hq.lon) };
    });
    if (!list.length) return null;
    list.sort((a, b) => (a.guarded - b.guarded) || (a.power - b.power) || (a.dist - b.dist));
    return list[0].id;
  }

  hqLatLon(f) {
    return factionHq(f);
  }

  /** 進攻部隊：目標控制點守軍規模 ×1.2、同等級的掠奪者 */
  attackForce(f, id) {
    const cp = cpById(id);
    const cb = this.game.combat;
    const n = Math.round(cp.garrison.count * 1.2);
    return Array.from({ length: n }, (_, i) => {
      const e = cb.createEnemy(i === 0 ? 'raiderChief' : 'raider', cp.garrison.level);
      const k = CP_GARRISON_MUL * (cp.side === 'player' ? CP_PLAYER_SIDE_MUL : 1);
      return {
        id: `fx:${f}:${i}`, ally: { player: `npc:${f}`, i }, name: `${FACTIONS[f].name}${e.name}`,
        maxHp: Math.round(e.maxHp * k), hp: Math.round(e.maxHp * k), atk: Math.round(e.atk * k), def: e.def || 0,
        crit: e.crit || 0.05, critDmg: e.critDmg || 1.5, dodge: e.dodge || 0.02, atkSpeed: e.atkSpeed || 1, level: cp.garrison.level, skills: {}, lifeSteal: 0,
      };
    });
  }

  /** 每個勢力每天在自己的時間進攻一次（第一個處理的玩家結算並寫入共用資料，其他人直接讀結果） */
  async npcTurns(now = Date.now()) {
    const g = this.game;
    if (!g.shared || g.state.map?.source !== 'generated') return;
    const day = g.time.day(now);
    for (const f of FACTION_KEYS) {
      const at = this.turnTime(f, now);
      if (now < at || this.busy.has(`turn:${f}`)) continue;
      const own = this.factionCps(f);
      if (own.length >= FACTION_SLOW_AT && day % 2) continue; // 控制點多的勢力隔天才進攻
      if ((this.lastTurn || {})[f] === day) continue;
      this.busy.add(`turn:${f}`);
      try {
        // eslint-disable-next-line no-await-in-loop
        const lock = await g.shared.update('cpturn', f, (x) => (x?.day === day ? { fail: 'done' } : { data: { day, at: now } }));
        this.lastTurn = { ...(this.lastTurn || {}), [f]: day };
        if (!lock.ok) continue;
        const target = this.pickTarget(f, at);
        if (!target) continue;
        // eslint-disable-next-line no-await-in-loop
        await this.npcAttack(f, target, at);
      } finally {
        this.busy.delete(`turn:${f}`);
      }
    }
  }

  async npcAttack(f, id, at = Date.now()) {
    const g = this.game;
    const cp = cpById(id);
    const foes = this.defenders(id, at);
    const attackers = this.attackForce(f, id);
    const r = g.combat.simulate([], foes, { allies: attackers, record: false });
    const win = !!r.victory || !foes.length;
    const killed = r.foes.filter((x) => x.down).length;
    const downIds = new Set(r.foes.filter((x) => x.down).map((x) => x.ally?.player).filter(Boolean));
    const res = await g.shared.update('cp', id, (x) => {
      const data = x || { owners: [], guards: [], faction: defaultFaction(cp) };
      if (win) {
        // 打下後留守：守軍約為進攻部隊的一半（之後每小時補回）
        return { data: { owners: [], guards: [], faction: f, lost: Math.ceil(cp.garrison.count / 2), lostAt: at, takenAt: at, by: f } };
      }
      if (data.owners?.length && !data.faction) data.guards = (data.guards || []).filter((h) => !downIds.has(h.p));
      else { data.lost = Math.min(cp.garrison.count, (cp.garrison.count - this.garrisonCount(id, at)) + killed); data.lostAt = at; }
      return { data };
    }, { lat: cp.lat, lon: cp.lon });
    if (res.ok && win) g.log(`🏴 勢力「${FACTIONS[f].name}」佔領了控制點 #${cp.no}`, 'danger');
    return { win, ok: res.ok };
  }

  /** 每 2 秒 */
  update(now = Date.now()) {
    if (now - (this.lastAt || 0) < 2000) return;
    this.lastAt = now;
    this.resolveAttacks(now).catch(() => {});
    this.syncGuards(now).catch(() => {});
    this.checkHostileOwners(now).catch(() => {});
    this.npcTurns(now).catch(() => {});
    this.startConvoys(now);
    this.deliverConvoys(now);
  }

  /**
   * 地圖上的點位：控制點中心附近、避開其他建築（至少 CLEAR_M 公尺）的位置（所有玩家相同）。
   */
  markerSpot(id) {
    this.spots = this.spots || {};
    if (this.spots[id]) return this.spots[id];
    const cp = cpById(id);
    const CLEAR_M = 40;
    const near = (this.game.state.map?.pois || []).filter((p) => haversine(p.lat, p.lon, cp.lat, cp.lon) < 450);
    const kLat = 111320;
    const kLon = 111320 * Math.cos((cp.lat * Math.PI) / 180);
    let spot = { lat: cp.lat, lon: cp.lon };
    search: for (let r = 0; r <= 400; r += 15) {
      const n = r ? Math.max(8, Math.round(r / 8)) : 1;
      for (let k = 0; k < n; k += 1) {
        const a = (k / n) * Math.PI * 2;
        const lat = cp.lat + (Math.sin(a) * r) / kLat;
        const lon = cp.lon + (Math.cos(a) * r) / kLon;
        if (cpAt(lat, lon)?.id !== id) continue;
        if (near.every((p) => haversine(p.lat, p.lon, lat, lon) >= CLEAR_M)) { spot = { lat, lon }; break search; }
      }
    }
    if ((this.game.state.map?.pois || []).length) this.spots[id] = spot;
    return spot;
  }

  /** 某位玩家佔領的控制點數 */
  countOf(pid) {
    return CONTROL_POINTS.filter((c) => !this.factionOf(c.id) && this.owners(c.id).some((o) => o.p === pid)).length;
  }

  /** 控制點的說明文字（地圖、視窗共用） */
  summary(id, now = Date.now()) {
    const cp = cpById(id);
    const s = this.statusOf(id);
    const own = this.owners(id);
    const guards = this.data(id)?.guards || [];
    const fac = this.factionOf(id);
    const label = { mine: '你與好友可探索', hostile: '敵對玩家佔領・不可探索', other: '其他玩家佔領・不可探索', faction: `${FACTIONS[fac]?.name || ''}勢力佔領・不可探索`, neutral: '中立（感染者佔據）・不可探索' }[s];
    return {
      cp, status: s, label, owners: own, guards, garrison: s === 'neutral' || s === 'faction' ? this.garrisonCount(id, now) : guards.reduce((a, h) => a + (h.units || []).length, 0),
      nextIncome: formatDuration(Math.max(0, this.incomeTime(now) + (now >= this.incomeTime(now) ? DAY_REAL_MS : 0) - now)),
    };
  }
}
