import { AssistSystem, ASSIST_TRAVEL_MUL } from './AssistSystem.js';
import { pathLength, pointAlong } from '../map/routing.js';
import { uid, pick, randInt } from '../utils/math.js';
import { haversine, formatDuration } from '../utils/math.js';
import { NPC_REWARD_MUL, RALLY_SHARE_FLOOR } from '../config/npcs.js';
import { AUTO_HOME_LABEL } from './AutoHomeSystem.js';

/** 集結：出發倒數可選的分鐘數 */
export const RALLY_DELAYS = [5, 10, 15, 20];
/** 加入集結後的緩衝時間：這段時間內共用資料還沒更新也不會讓隊伍回家 */
export const RALLY_JOIN_GRACE_MS = 30000;
/** 查詢範圍（公里） */
export const RALLY_KM = 20;
/** 結算鎖定逾時（結算中的人斷線時，其他參加者可以接手） */
const LOCK_MS = 60000;
/** 集結戰鬥詳細最多保留的紀錄筆數（放在共用資料裡，分給每位參加者） */
const RALLY_LOG = 80;
/** 集結共用資料的大小上限（伺服器每筆 16000 位元組，保留一些空間） */
const RALLY_BYTES = 14000;
/** 攻陷 NPC 據點時能搶到的金錢比例（與單獨攻打相同） */
const NPC_COIN_LOOT = 0.35;

/**
 * 集結（廣播塔）：對 NPC 據點或重度感染據點發起，好友派隊參加，一起出發、一起作戰。
 *  - 集結資料存在共用物件 rally:<id>；隊員的戰鬥數值在加入時寫入，因此任何一位參加者都能結算，
 *    發起人或其他參加者不在線上也不影響。
 *  - 隊伍數量 = 廣播塔等級 + 1（含發起人）；倒數結束或滿員時出發；出發前發起人可以取消。
 *  - 成功後金錢平分，其他物品隨機分配給參加的隊伍。
 */
export class RallySystem {
  constructor(game) {
    this.game = game;
    this.busy = new Set();
    this.lastAt = 0;
    game.shared?.watch('rally', RALLY_KM);
  }

  get st() {
    const s = this.game.state;
    s.rally = s.rally || { seen: {} };
    s.rally.seen = s.rally.seen || {};
    return s.rally;
  }

  myId() {
    return this.game.shared.store().me;
  }

  level() {
    return this.game.shelter.maxLevel('broadcast');
  }

  maxTeams(lv = this.level()) {
    return lv > 0 ? lv + 1 : 0;
  }

  get(id) {
    const d = this.game.shared.get('rally', id);
    return d ? { id, ...d } : null;
  }

  /** 自己參加中（含發起）的集結行程 */
  trips() {
    return this.game.state.expeditions.filter((e) => e.kind === 'rally' && e.rallyId);
  }

  /** 好友發起、還在集結中、自己還沒參加的 */
  invites(now = Date.now()) {
    const me = this.myId();
    const t = this.game.territory;
    const mine = new Set(this.trips().map((e) => e.rallyId));
    return this.game.shared.all('rally').map((o) => ({ id: o.id, ...o.data }))
      .filter((d) => d.status === 'gathering' && d.owner !== me && !mine.has(d.id) && now < d.departAt
        && t.relation(d.owner) === 'friend' && !(d.teams || []).some((x) => x.player === me) && !this.targetGone(d.target, now));
  }

  /** 目標（NPC 據點或重度感染據點） */
  target(t) {
    const g = this.game;
    if (this.targetGone(t)) return null;
    if (t.kind === 'npc') return g.npcs.get(t.id) || g.npcs.byIdent?.(t.ident) || null;
    if (t.kind === 'inf') return g.infected.get(t.id) || g.infected.byId?.(t.id) || null;
    return null;
  }

  /**
   * 目標是否已經被攻陷／消滅（看共用資料，自己的地圖還沒更新時也能判斷）。
   * 用於：不能對已攻陷的目標發起或參加集結；集結途中目標被別人攻陷時取消集結。
   */
  targetGone(t, now = Date.now()) {
    const g = this.game;
    if (!t) return true;
    if (t.kind === 'npc') {
      if (g.npcs.get(t.id)?.gone) return true;
      if (!t.ident) return false;
      const [i, j, slot, gen, dc] = String(t.ident).split(':');
      const d = g.shared?.get?.('npc', `${i}:${j}:${slot}`);
      return !!(d && String(d.gen) === gen && (d.dc || 0) > (Number(dc) || 0) && d.destroyed && now < d.destroyed.respawnAt);
    }
    if (t.kind === 'inf') {
      const s = g.infected.siteById(t.id);
      return !!(s && g.infected.cleared(s, now));
    }
    return false;
  }

  /** 讓探索系統把集結目標當成目的地 */
  asPoi(id) {
    if (!String(id).startsWith('rally:')) return null;
    const d = this.get(String(id).slice(6)) || this.pendingTarget;
    const t = d?.target || this.pendingTarget;
    return t && {
      id, name: `🚩 集結：${t.name}`, lat: t.lat, lon: t.lon, type: 'military', icon: '🚩', rally: true,
    };
  }

  canStart(target) {
    const g = this.game;
    if (!g.shelter.hasShelter()) return { ok: false, reason: '需要先有避難所' };
    if (this.level() < 1) return { ok: false, reason: '需要建造📡廣播塔' };
    if (this.trips().some((e) => this.get(e.rallyId)?.owner === this.myId() && ['gathering', 'departed', 'resolving'].includes(this.get(e.rallyId)?.status))) {
      return { ok: false, reason: '已經有進行中的集結' };
    }
    if (target && !['npc', 'inf'].includes(target.kind)) return { ok: false, reason: '只能對 NPC 據點或重度感染據點發起集結' };
    return { ok: true };
  }

  /** 隊員的戰鬥數值（寫入集結資料，讓任何參加者都能結算） */
  units(memberIds) {
    const g = this.game;
    return memberIds.map((id, i) => {
      const sv = g.survivors.get(id);
      if (!sv) return null;
      return AssistSystem.unitData(g, sv, i, { withMeds: true });
    }).filter(Boolean);
  }

  /**
   * 集結中的隊伍：倒數結束（或隊伍湊滿提早出發）時才真正出發。
   * 出發前隊伍留在避難所（地圖顯示「集結中・等待出發」），出發時間依集結的出發時間設定。
   */
  setDepartAt(exp, departAt) {
    if (!exp || !departAt) return;
    exp.gatherUntil = departAt;
    if (!exp.rallyResult) exp.endAt = departAt + 24 * 3600000;
  }

  /** 出發加入（自己的倖存者成為「集結中」的隊伍，直到結果出來） */
  depart(rallyId, target, memberIds, vehicleIds = [], home = null) {
    this.pendingTarget = target;
    const r = this.game.exploration.start(`rally:${rallyId}`, memberIds, 0, false, Date.now(), { kind: 'rally', vehicleIds });
    this.pendingTarget = null;
    if (!r.ok) return r;
    r.exp.rallyId = rallyId;
    r.exp.rallyJoinedAt = Date.now();
    // 集結一起行動：不會單獨遇襲或被攔截
    r.exp.encountered = null;
    r.exp.threats = [];
    r.exp.rallyTarget = target;
    // v12.1：參加者先走到發起人的避難所（集結點）會合；發起人本身就在集結點
    if (home) {
      const g = this.game;
      const sh = g.shelter.primary();
      const from = sh ? { lat: sh.lat, lon: sh.lon } : r.exp.from;
      const route = g.territory?.route ? g.territory.route(from, home, {}) : null;
      const path = route?.length > 1 ? route.slice(0, 20) : [from, home];
      const dist = Math.round(pathLength(path));
      const rate = r.exp.distanceM > 0 && r.exp.travelMs > 0 ? r.exp.travelMs / r.exp.distanceM : g.exploration.walkRate(r.exp);
      r.exp.rallyHome = { lat: home.lat, lon: home.lon };
      r.exp.rallyGatherPath = path;
      r.exp.rallyGatherMs = dist > 30 ? Math.round(dist * rate * ASSIST_TRAVEL_MUL) : 0;
      r.exp.rallyArriveAt = r.exp.startAt + r.exp.rallyGatherMs;
    }
    // 結果出來前不會結束（由集結系統設定回家時間）
    r.exp.endAt = r.exp.startAt + 24 * 3600000;
    return r;
  }

  /**
   * 發起集結。
   * @param {{kind:'npc'|'inf', id:string, name:string, lat:number, lon:number, ident?:string}} target
   */
  async start(target, delayMin, memberIds, vehicleIds = []) {
    const g = this.game;
    const c = this.canStart(target);
    if (!c.ok) return c;
    if (!RALLY_DELAYS.includes(Number(delayMin))) return { ok: false, reason: '請選擇出發倒數時間' };
    if (!this.target(target)) return { ok: false, reason: '目標已經不在了' };
    const id = uid('rl');
    const sh0 = g.shelter.primary();
    const dep = this.depart(id, target, memberIds, vehicleIds, sh0 ? { lat: sh0.lat, lon: sh0.lon } : null);
    if (!dep.ok) return dep;
    // 寫入共用世界期間不要檢查這個集結（還沒寫入前會被誤判成「已取消」而讓隊伍回家）
    this.busy.add(id);
    const now = Date.now();
    const me = this.myId();
    const sh = g.shelter.primary();
    const data = {
      owner: me, ownerName: g.state.player.name || '倖存者', target, status: 'gathering', at: now,
      departAt: now + Number(delayMin) * 60000, travelMs: dep.exp.travelMs, maxTeams: this.maxTeams(),
      // v12.1：集結點（發起人的避難所）與部隊從集結點前往目標的路線
      home: { lat: sh.lat, lon: sh.lon }, ...(dep.exp.path?.length > 2 ? { path: dep.exp.path.slice(0, 20) } : {}),
      teams: [{ player: me, name: g.state.player.name || '倖存者', units: this.units(memberIds), at: now, travelMs: dep.exp.travelMs || 0, from: { lat: sh.lat, lon: sh.lon }, arriveAt: now }],
    };
    const r = await g.shared.update('rally', id, (d) => (d ? { fail: '編號重複，請再試一次' } : { data }), { lat: sh.lat, lon: sh.lon }).finally(() => this.busy.delete(id));
    if (!r.ok) {
      this.abort(dep.exp);
      return r;
    }
    this.setDepartAt(dep.exp, data.departAt);
    g.world?.syncSoon?.();
    g.log(`🚩 發起集結：目標「${target.name}」，${delayMin} 分鐘後出發（最多 ${data.maxTeams} 支隊伍）`, 'info');
    return { ok: true, id, msg: `已發起集結，好友會收到通知（${delayMin} 分鐘後出發）` };
  }

  /** 參加好友的集結 */
  async join(rallyId, memberIds, vehicleIds = []) {
    const g = this.game;
    const d0 = this.get(rallyId);
    if (!d0 || d0.status !== 'gathering') return { ok: false, reason: '這個集結已經出發或結束了' };
    if (g.territory.relation(d0.owner) !== 'friend') return { ok: false, reason: '只能參加友好玩家的集結' };
    if ((d0.teams || []).length >= d0.maxTeams) return { ok: false, reason: '集結隊伍已滿' };
    if (Date.now() >= d0.departAt) return { ok: false, reason: '集結倒數已經結束，不能再參加' };
    if (this.targetGone(d0.target) || (!this.target(d0.target) && d0.target.kind === 'npc' && !d0.target.ident)) return { ok: false, reason: '目標已經被攻陷或消滅了' };
    const dep = this.depart(rallyId, d0.target, memberIds, vehicleIds, d0.home || null);
    if (!dep.ok) return dep;
    const me = this.myId();
    const sh = g.shelter.primary();
    const team = {
      player: me, name: g.state.player.name || '倖存者', units: this.units(memberIds), at: dep.exp.startAt, travelMs: dep.exp.travelMs || 0,
      ...(d0.home ? { from: sh ? { lat: sh.lat, lon: sh.lon } : d0.home, arriveAt: dep.exp.rallyArriveAt || dep.exp.startAt } : {}),
    };
    // 寫入共用世界期間不要檢查這個集結（還沒加入名單前會被誤判成「被移出」而讓隊伍回家）
    this.busy.add(rallyId);
    const r = await g.shared.update('rally', rallyId, (d) => {
      if (!d || d.status !== 'gathering') return { fail: '這個集結已經出發或結束了' };
      if (Date.now() >= d.departAt) return { fail: '集結倒數已經結束，不能再參加' };
      if ((d.teams || []).some((x) => x.player === me)) return { fail: '已經參加了' };
      if (d.teams.length >= d.maxTeams) return { fail: '集結隊伍已滿' };
      d.teams.push(team);
      return { data: d };
    }).finally(() => this.busy.delete(rallyId));
    if (!r.ok) {
      this.abort(dep.exp);
      return r;
    }
    this.setDepartAt(dep.exp, r.data?.departAt || d0.departAt);
    g.log(`🚩 參加「${d0.ownerName}」的集結：目標「${d0.target.name}」`, 'info');
    g.world?.syncSoon?.();
    return { ok: true, msg: `已加入「${d0.ownerName}」的集結` };
  }

  /**
   * 發起人提前出發（v12.2）：倒數立刻結束、不能再參加；部隊等最後一位參加的玩家抵達集結點後出發。
   */
  async departNow(rallyId) {
    const g = this.game;
    const me = this.myId();
    const now = Date.now();
    const r = await g.shared.update('rally', rallyId, (d) => {
      if (!d) return { fail: '找不到集結' };
      if (d.owner !== me) return { fail: '只有發起人可以提前出發' };
      if (d.status !== 'gathering') return { fail: '已經出發了' };
      if (!d.home) return { fail: '這個集結不能提前出發' };
      d.departAt = Math.min(d.departAt, now);
      d.early = true;
      return { data: d };
    });
    if (!r.ok) return r;
    const sc = RallySystem.schedule(r.data);
    g.log(`🚩 集結「${r.data.target?.name}」提前出發${sc.go > now ? `，等所有隊伍抵達集結點（約 ${formatDuration(sc.go - now)}）` : ''}`, 'info');
    this.lastAt = 0;
    return { ok: true, msg: sc.go > now ? `已提前出發，等「${sc.waitFor?.name || '其他隊伍'}」抵達集結點` : '已提前出發，部隊出發' };
  }

  /** 取消（發起人）或退出（參加者）：只能在出發前 */
  async leave(rallyId) {
    const g = this.game;
    const me = this.myId();
    const r = await g.shared.update('rally', rallyId, (d) => {
      if (!d) return { fail: '找不到集結' };
      if (d.status !== 'gathering') return { fail: '已經出發了，不能取消' };
      if (d.early) return { fail: d.owner === me ? '已經提前出發，不能取消' : '部隊已經準備出發，不能退出' };
      if (d.owner === me) d.status = 'cancelled';
      else d.teams = (d.teams || []).filter((x) => x.player !== me);
      return { data: d };
    });
    if (!r.ok) return r;
    this.trips().filter((e) => e.rallyId === rallyId).forEach((e) => this.walkHome(e, Date.now(), r.data.owner === me ? '集結已取消' : '退出集結'));
    return { ok: true, msg: r.data.owner === me ? '已取消集結' : '已退出集結' };
  }

  /**
   * 自動回家：退出集結。還沒出發時直接留在避難所；已經出發、還沒交戰時，自己的隊伍退出這場集結並從目前位置走回避難所
   * （其他玩家的隊伍照常進行）。已經交戰完的照常回家。
   * @returns {boolean} 是否召回
   */
  withdraw(exp, at = Date.now()) {
    const g = this.game;
    const d = this.get(exp.rallyId);
    if (!d || exp.recalled || exp.rallyResult) return false;
    const me = this.myId();
    // 提前出發後視同已出發：不能單獨脫隊
    if (d.status === 'gathering' && d.early) return false;
    if (d.status === 'gathering') {
      this.leave(exp.rallyId).catch(() => {});
      if (g.state.expeditions.includes(exp) && !exp.recalled) this.walkHome(exp, at, `${AUTO_HOME_LABEL} 自動回家：退出集結`);
      return true;
    }
    // v12.1：部隊出發後一起行動，不能單獨脫隊（打完才各自回家）
    if (d.home) return false;
    if (d.status !== 'departed') return false;
    g.shared.update('rally', exp.rallyId, (x) => {
      if (!x || x.status !== 'departed') return { fail: 'done' };
      x.teams = (x.teams || []).filter((t) => t.player !== me);
      return { data: x };
    }).catch(() => {});
    if (!g.exploration.turnBack(exp, at)) return false;
    exp.recalled = true;
    exp.travelEvents = [...(exp.travelEvents || []), `🏠 ${AUTO_HOME_LABEL} 自動回家：隊伍退出集結，折返避難所`];
    return true;
  }

  /** 還沒出發就結束：隊員直接留在避難所 */
  abort(exp) {
    const g = this.game;
    g.state.expeditions = g.state.expeditions.filter((e) => e.id !== exp.id);
    g.exploration.free(exp);
    g.bus.emit('expedition:done', { reports: [] });
  }

  /** 出發前取消或退出：還在家就直接留下，已經在路上或在集結點的從目前位置走回避難所 */
  walkHome(exp, at = Date.now(), why = '集結已取消') {
    const g = this.game;
    if (!g.state.expeditions.includes(exp) || exp.recalled) return;
    const pos = this.position(exp, at);
    const sh = g.shelter.primary();
    if (!pos || !sh || haversine(pos.lat, pos.lon, sh.lat, sh.lon) < 30) {
      this.abort(exp);
      return;
    }
    if (!g.exploration.turnBack(exp, at, pos)) {
      this.abort(exp);
      return;
    }
    exp.recalled = true;
    exp.travelEvents = [...(exp.travelEvents || []), `🚩 ${why}，隊伍走回避難所`];
  }

  /**
   * 集結時程（v12.1，純函式）：倒數結束（或滿員）後，等所有隊伍抵達集結點才一起出發。
   * @returns {{trigger:number, ready:number, go:number, fightAt:number, waitFor:object|null}}
   */
  static schedule(d) {
    const teams = d.teams || [];
    const arrive = (t) => t.arriveAt ?? t.at ?? d.at;
    const ready = Math.max(d.at || 0, ...teams.map(arrive));
    const full = teams.length >= d.maxTeams;
    const trigger = full ? Math.min(d.departAt, Math.max(...teams.map((t) => t.at || 0))) : d.departAt;
    const go = d.departedAt || Math.max(trigger, ready);
    const march = d.home ? d.travelMs || 0 : Math.max(d.travelMs || 0, ...teams.map((t) => t.travelMs || 0));
    const waitFor = teams.filter((t) => arrive(t) > trigger).sort((a, b) => arrive(b) - arrive(a))[0] || null;
    return { trigger, ready, go, fightAt: d.fightAt || go + march, waitFor };
  }

  /**
   * 集結在地圖上的階段與位置（v12.1）：gather 前往集結點／wait 在集結點等待／march 部隊前往目標／fight 交戰中。
   * team 給定時回傳那一隊（還在前往集結點時）的位置，否則回傳部隊的位置。
   */
  static phaseOf(d, now = Date.now(), team = null) {
    if (!d?.home || !d.target) return null;
    const s = RallySystem.schedule(d);
    const home = d.home;
    if (team && team.from && (team.arriveAt || 0) > now) {
      const span = Math.max(1, team.arriveAt - (team.at || now));
      const r = Math.min(1, Math.max(0, (now - (team.at || now)) / span));
      return { phase: 'gather', pos: { lat: team.from.lat + (home.lat - team.from.lat) * r, lon: team.from.lon + (home.lon - team.from.lon) * r }, left: team.arriveAt - now, s };
    }
    if (d.status === 'gathering' || now < s.go) return { phase: 'wait', pos: home, left: Math.max(0, s.go - now), s };
    if (now < s.fightAt) {
      const path = Array.isArray(d.path) && d.path.length >= 2 ? d.path : [home, d.target];
      const r = Math.min(1, Math.max(0, (now - s.go) / Math.max(1, s.fightAt - s.go)));
      return { phase: 'march', pos: pointAlong(path, pathLength(path) * r), left: s.fightAt - now, s, path };
    }
    return { phase: 'fight', pos: { lat: d.target.lat, lon: d.target.lon }, left: 0, s };
  }

  /** 自己的集結隊伍目前位置（結果出來前） */
  position(exp, now = Date.now()) {
    const d = this.get(exp.rallyId);
    if (exp.rallyHome && exp.rallyArriveAt > now && exp.rallyGatherPath?.length >= 2) {
      const span = Math.max(1, exp.rallyArriveAt - exp.startAt);
      const r = Math.min(1, Math.max(0, (now - exp.startAt) / span));
      return pointAlong(exp.rallyGatherPath, pathLength(exp.rallyGatherPath) * r);
    }
    if (d?.home) return RallySystem.phaseOf(d, now)?.pos || exp.rallyHome;
    return exp.rallyHome || this.game.exploration.progress(exp, now)?.pos || null;
  }

  /**
   * 自己集結隊伍的狀態文字（地圖、探索頁、倖存者卡片共用）。
   * @returns {{tag:string, line1:string, line2:string}|null} 舊版集結（沒有集結點）回傳 null
   */
  statusOf(exp, now = Date.now()) {
    if (exp.kind !== 'rally') return null;
    if (exp.recalled || exp.rallyResult) {
      const left = Math.max(0, exp.endAt - now);
      return { tag: '返程', line1: exp.recalled ? '↩️ 返程中' : '🏃 集結結束・返程中', line2: `⏱ 剩 ${formatDuration(left)}` };
    }
    const d = this.get(exp.rallyId);
    if (!d?.home) return null;
    const mine = (d.teams || []).find((t) => t.player === this.myId());
    const p = RallySystem.phaseOf(d, now, mine);
    if (!p) return null;
    if (p.phase === 'gather') return { tag: '集結', line1: '🚩 前往集結點', line2: `⏱ 剩 ${formatDuration(p.left)} 抵達` };
    if (p.phase === 'wait') {
      if (now >= p.s.trigger && p.s.waitFor) return { tag: '集結', line1: '🚩 在集結點等待', line2: `⏳ 等${String(p.s.waitFor.name).slice(0, 8)}抵達・${formatDuration(p.left)}` };
      return { tag: '集結', line1: '🚩 在集結點等待', line2: `⏱ ${formatDuration(p.left)} 後出發` };
    }
    if (p.phase === 'march') return { tag: '集結', line1: '🚩 集結部隊行軍中', line2: `⏱ 剩 ${formatDuration(p.left)} 抵達` };
    return { tag: '集結', line1: '⚔️ 集結交戰中', line2: '⏱ 等待結果' };
  }

  /** 附近有進行中（或剛結束）的集結：世界同步改為較快的頻率，讓大家的畫面盡快一致 */
  active(now = Date.now()) {
    return (this.game.shared?.all?.('rally') || []).some((o) => {
      const d = o.data || {};
      return ['gathering', 'departed', 'resolving'].includes(d.status) || (d.status === 'done' && now - (d.fightAt || 0) < 10 * 60000);
    });
  }

  /** 每 2 秒：出發、結算、套用結果、好友通知 */
  update(now = Date.now()) {
    if (now - this.lastAt < 2000) return;
    this.lastAt = now;
    const g = this.game;
    // 快要開打或等待結算中的集結：每 3 秒重新讀取，戰鬥結果與返程能同步顯示（不用等下一次世界同步）
    const due = (g.shared?.all?.('rally') || []).some((o) => ['departed', 'resolving'].includes(o.data?.status) && now >= (o.data.fightAt || 0) - 2000);
    if (due && now - (this.fastAt || 0) >= 3000 && g.shared?.list) {
      this.fastAt = now;
      g.shared.list('rally', RALLY_KM).catch(() => {});
    }
    this.invites(now).forEach((d) => {
      if (this.st.seen[d.id]) return;
      this.st.seen[d.id] = now;
      g.log(`🚩 好友「${d.ownerName}」發起集結：目標「${d.target.name}」，${Math.max(1, Math.round((d.departAt - now) / 60000))} 分鐘後出發（地圖左上角點擊參加）`, 'info');
    });
    Object.keys(this.st.seen).forEach((k) => { if (now - this.st.seen[k] > 86400000) delete this.st.seen[k]; });
    this.trips().forEach((exp) => this.step(exp, now));
  }

  async step(exp, now) {
    const g = this.game;
    const d = this.get(exp.rallyId);
    if (exp.recalled || !d || this.busy.has(exp.rallyId)) return;
    // 剛加入時共用資料可能還是舊的（名單裡還沒有自己）：給一段緩衝時間，避免誤判成被移出而回家
    const notListed = d.status === 'gathering' && !(d.teams || []).some((x) => x.player === this.myId());
    if (notListed && now - (exp.rallyJoinedAt || 0) < RALLY_JOIN_GRACE_MS) return;
    // 集結途中目標已被攻陷（例如另一個集結先打下來）：取消，隊伍直接回家
    // （開打時間之後不檢查：可能就是這個集結自己打下來的，要等結果）
    if ((d.status === 'gathering' || (d.status === 'departed' && now < (d.fightAt || 0))) && this.targetGone(d.target, now)) {
      g.log(`🚩 集結目標「${d.target?.name}」已經被攻陷，集結取消，隊員回到避難所`, 'info');
      this.walkHome(exp, now, '目標已被攻陷，集結取消');
      return;
    }
    if (d.status === 'cancelled' || notListed) {
      g.log(`🚩 集結「${d.target?.name}」已取消，隊員回到避難所`, 'info');
      this.walkHome(exp, now);
      return;
    }
    // 隊伍湊滿提早出發：出發時間改為實際出發的時間
    if (d.departedAt && exp.gatherUntil && exp.gatherUntil !== d.departedAt && !exp.rallyResult) this.setDepartAt(exp, d.departedAt);
    // 開打時間（等最晚抵達的隊伍）：先到的隊伍在目標附近等待
    if (d.fightAt) exp.rallyFightAt = d.fightAt;
    this.busy.add(exp.rallyId);
    try {
      if (d.status === 'gathering' && d.home && now >= RallySystem.schedule(d).go) {
        // v12.1：所有隊伍都到集結點後，部隊一起從集結點出發
        await g.shared.update('rally', exp.rallyId, (x) => {
          if (!x || x.status !== 'gathering') return { fail: 'done' };
          const sc = RallySystem.schedule(x);
          if (now < sc.go) return { fail: 'wait' };
          x.status = 'departed';
          x.departedAt = sc.go;
          x.fightAt = sc.fightAt;
          return { data: x };
        });
      } else if (d.status === 'gathering' && !d.home && (now >= d.departAt || d.teams.length >= d.maxTeams)) {
        await g.shared.update('rally', exp.rallyId, (x) => {
          if (!x || x.status !== 'gathering') return { fail: 'done' };
          x.status = 'departed';
          x.departedAt = Math.min(now, x.departAt);
          // 舊版集結：各隊從自己的避難所出發，等最晚抵達的那一隊到了才一起開打
          x.fightAt = x.departedAt + Math.max(x.travelMs || 0, ...(x.teams || []).map((t) => t.travelMs || 0));
          return { data: x };
        });
      } else if ((d.status === 'departed' && now >= d.fightAt) || (d.status === 'resolving' && now - (d.lockAt || 0) > LOCK_MS)) {
        await this.resolve(exp.rallyId, now);
      } else if (d.status === 'done' && !exp.rallyResult && !exp.recalled) {
        exp.rallyResult = d.result?.teams?.[this.myId()] || { units: [], coins: 0, items: [], mats: {} };
        exp.rallySummary = d.result?.summary || '';
        exp.rallyDetail = Array.isArray(d.result?.detail) ? d.result.detail.slice(0, 12) : [];
        if (d.result?.battle) exp.rallyBattle = d.result.battle;
        exp.rallyVictory = !!d.result?.victory;
        exp.endAt = Math.max(now, (d.fightAt || now) + (exp.travelMs || 0));
        // v12.1：打完從目標直接走回自己的避難所（地圖上顯示一般的返程）
        if (d.home) {
          exp.startAt = exp.endAt - 2 * (exp.travelMs || 0);
          exp.searchMs = 0;
        }
      }
    } finally {
      this.busy.delete(exp.rallyId);
    }
  }

  /** 結算（任何一位參加者都可以）：先鎖定，計算戰鬥並改變目標，再寫入結果 */
  async resolve(rallyId, now = Date.now()) {
    const g = this.game;
    const me = this.myId();
    const lock = await g.shared.update('rally', rallyId, (x) => {
      if (!x || !(x.status === 'departed' || (x.status === 'resolving' && now - (x.lockAt || 0) > LOCK_MS))) return { fail: 'busy' };
      x.status = 'resolving';
      x.lockBy = me;
      x.lockAt = now;
      return { data: x };
    });
    if (!lock.ok) return lock;
    const d = lock.data;
    const out = await this.fight(d, now);
    return g.shared.update('rally', rallyId, (x) => {
      if (!x || x.status !== 'resolving' || x.lockBy !== me) return { fail: 'lost' };
      x.status = 'done';
      x.result = out;
      RallySystem.fitBattle(x);
      return { data: x };
    });
  }

  /**
   * 共用資料每筆有大小上限（16000 位元組）：戰鬥詳細太長時先縮短逐筆紀錄，還是太大就不附戰鬥詳細。
   */
  static fitBattle(x, max = RALLY_BYTES) {
    const b = x.result?.battle;
    if (!b) return x;
    const size = () => new TextEncoder().encode(JSON.stringify(x)).length;
    while (size() > max && b.log?.length > 10) b.log = [...b.log.slice(0, Math.ceil(b.log.length / 2) - 10), ...b.log.slice(-10)];
    if (size() > max) delete x.result.battle;
    return x;
  }

  /** 集結戰鬥：所有隊伍的隊員一起上場 */
  // （各隊戰況摘要見 teamLines）
  async fight(d, now) {
    const g = this.game;
    const teams = d.teams || [];
    const units = teams.flatMap((t) => (t.units || []).slice(0, 6).map((u) => AssistSystem.unitOf({ id: t.player, name: t.name }, u)));
    const people = units.length;
    const empty = () => Object.fromEntries(teams.map((t) => [t.player, { units: [], coins: 0, items: [], mats: {} }]));
    const res = { victory: false, summary: '', teams: empty() };
    const tg = this.target(d.target);
    if (!tg) {
      res.summary = `抵達時「${d.target.name}」已經不在了`;
      teams.forEach((t) => { res.teams[t.player].units = (t.units || []).map((u) => ({ i: u.i, hp: u.hp, down: false })); });
      return res;
    }
    /**
     * 分配戰利品。weights（玩家 → 貢獻）有值時：每支隊伍先平均拿到保底比例，其餘依貢獻分配；
     * 沒有貢獻資料時平均分配（裝備與材料隨機分給各隊）。
     */
    const share = (coins, items, mats, weights = null) => {
      const n = Math.max(1, teams.length);
      const tot = weights ? teams.reduce((s, t) => s + (weights[t.player] || 0), 0) : 0;
      const frac = (p) => (tot > 0 ? RALLY_SHARE_FLOOR / n + (1 - RALLY_SHARE_FLOOR) * ((weights[p] || 0) / tot) : 1 / n);
      const pickW = () => {
        let r = Math.random();
        for (const t of teams) { r -= frac(t.player); if (r <= 0) return t; }
        return teams[teams.length - 1];
      };
      teams.forEach((t) => { res.teams[t.player].coins += Math.floor(coins * frac(t.player)); });
      items.forEach((it) => { res.teams[pickW().player].items.push(it); });
      Object.entries(mats).forEach(([k, v]) => {
        // 每一份依比例分給一支隊伍
        let left = v;
        while (left > 0) {
          const part = Math.max(1, Math.ceil(v / Math.max(1, teams.length)));
          const who = res.teams[pickW().player].mats;
          who[k] = (who[k] || 0) + Math.min(part, left);
          left -= part;
        }
      });
    };
    let result;
    if (d.target.kind === 'npc') {
      const n = tg;
      const df = g.npcs.defense(n);
      const attackers = units.map((u) => ({ u, maxHp: u.maxHp, atk: u.atk }));
      const as = g.combat.wallAssault(attackers, df.wall, df.dps);
      const fallen = new Set(attackers.filter((a) => !as.alive.includes(a)).map((a) => a.u.id));
      const fighters = units.filter((u) => !fallen.has(u.id));
      result = as.breached && fighters.length ? g.combat.simulate([], g.npcs.garrison(n, { assault: true }), { allies: fighters, record: false, capture: RALLY_LOG, title: `🚩 集結攻打「${n.name}」` }) : null;
      if (result?.entry) res.battle = result.entry;
      const down = new Set([...fallen, ...(result ? result.team.filter((x) => x.down).map((x) => x.id) : fighters.map((u) => u.id))]);
      units.forEach((u) => {
        const r = result?.team.find((x) => x.id === u.id);
        res.teams[u.ally.player].units.push({ i: u.ally.i, hp: down.has(u.id) ? 0 : Math.round(r?.hp ?? u.hp), down: down.has(u.id), dealt: Math.round(r?.dealt || 0), kills: r?.kills || 0, maxHp: u.maxHp, wall: fallen.has(u.id), meds: r?.medsUsed || 0 });
      });
      // 戰況摘要（所有參加的玩家都看得到）
      const foes = result ? result.foes.length : g.npcs.garrison(n, { assault: true }).length;
      res.detail = [
        `🧱 攻擊圍牆 ${as.sec} 秒（耐久 ${Math.round(df.wall)}、防禦火力每秒 ${Math.round(df.dps)}）${fallen.size ? `，${fallen.size} 名隊員被防禦火力擊倒` : ''}${as.breached ? '・圍牆被打破' : '・沒能打破圍牆'}`,
        ...(result ? [`⚔️ 與守軍交戰 ${Math.round(result.duration)} 秒：守軍 ${foes} 人（Lv${n.level}），擊倒 ${result.foes.filter((f) => f.down).length}/${foes} 人，我方 ${units.length} 人中倒下 ${down.size} 人`] : []),
        ...teamLines(teams, res),
      ];
      res.victory = !!result?.victory;
      if (res.victory) {
        // 攻陷獎勵（v10 提高）：依各隊在戰鬥中造成的傷害分配（有保底）
        const items = Array.from({ length: (1 + Math.floor(teams.length / 2)) * NPC_REWARD_MUL }, () => g.equipment.generate({ level: n.level, boost: 0.4 }));
        const dealt = {};
        (result.team || []).forEach((x) => { const p = x.ally?.player; if (p) dealt[p] = (dealt[p] || 0) + (x.dealt || 0); });
        share(Math.round(n.coins * NPC_COIN_LOOT * NPC_REWARD_MUL), items, Object.fromEntries(Object.entries(n.resources).filter(([, v]) => v > 0).map(([k, v]) => [k, Math.floor(v * NPC_REWARD_MUL)])), dealt);
        // 「就是要鎖你」：每支參戰隊伍各自抽一次
        Object.values(res.teams).forEach((t) => { const k = g.rebirth?.rollNpc() || 0; if (k) t.mats.locks = (t.mats.locks || 0) + k; });
        g.npcs.destroy(n, now);
        res.summary = `🏆 集結攻陷 NPC 據點「${n.name}」（${people} 人參戰）`;
      } else {
        if (result) g.npcs.assaultWound(n, result.kills.length, now); // 沒打破圍牆就沒有擊倒守軍
        res.summary = `💀 集結攻打「${n.name}」失敗（${as.breached ? '與守軍交戰落敗' : '沒能打破圍牆'}）`;
      }
    } else {
      const s = tg;
      const b = g.infected.battle(s, [], units, now, { capture: RALLY_LOG, title: `🚩 集結淨化「${s.name}」` });
      result = b.result;
      if (result.entry) res.battle = result.entry;
      units.forEach((u) => {
        const r = result.team.find((x) => x.id === u.id);
        res.teams[u.ally.player].units.push({ i: u.ally.i, hp: Math.round(r?.hp ?? 0), down: !!r?.down, dealt: Math.round(r?.dealt || 0), kills: r?.kills || 0, maxHp: u.maxHp, meds: r?.medsUsed || 0 });
      });
      res.detail = [
        `☣️ 交戰 ${Math.round(result.duration)} 秒：敵人 ${result.foes.length} 隻，擊倒 ${result.foes.filter((f) => f.down).length} 隻，我方 ${units.length} 人中倒下 ${result.team.filter((x) => x.down).length} 人・淨化 +${b.gain.toFixed(1)}%`,
        ...teamLines(teams, res),
      ];
      const p = await g.infected.addPurity(s, b.gain, now);
      res.purity = p.purity;
      res.victory = !!p.killed;
      if (p.killed) {
        const rw = g.infected.rewards(s, people);
        share(rw.coins, rw.items, rw.mats);
        // 「就是要鎖你」：每支參戰隊伍各得一份（依總參戰人數）
        Object.values(res.teams).forEach((t) => { t.mats.locks = (t.mats.locks || 0) + (g.rebirth?.infectDrop(people) || 0); });
        res.summary = `🏆 集結消滅重度感染據點「${s.name}」（${people} 人參戰）`;
      } else res.summary = `☣️ 集結淨化「${s.name}」：淨化度 ${b.before.toFixed(1)}% → ${(p.purity ?? b.before + b.gain).toFixed(1)}%`;
    }
    void randInt;
    return res;
  }

  /** 探索系統結算集結行程（回到避難所時） */
  report(exp) {
    const g = this.game;
    const members = exp.memberIds.map((id) => g.survivors.get(id)).filter(Boolean);
    const r = exp.rallyResult || { units: [], coins: 0, items: [], mats: {} };
    const report = {
      id: uid('rp'), poiName: `🚩 集結：${exp.rallyTarget?.name || ''}`, poiType: 'military', at: exp.endAt,
      events: [...(exp.travelEvents || [])], resources: {}, items: [], blueprints: [],
      kills: exp.travelKills || 0, xp: exp.travelXp || 0, success: !!exp.rallyVictory, members: members.map((m) => m.name),
    };
    (exp.rallyDetail || []).forEach((line) => report.events.push(String(line).slice(0, 200)));
    (r.units || []).forEach((u) => {
      const sv = g.survivors.get(exp.memberIds[u.i]);
      if (!sv || u.dealt == null) return;
      report.events.push(`　・${sv.name}：${u.wall ? '攻牆時被防禦火力擊倒' : `造成 ${u.dealt} 傷害、擊倒 ${u.kills || 0}`}・剩餘生命 ${Math.max(0, u.hp)}${u.maxHp ? `/${Math.round(u.maxHp)}` : ''}${u.down ? '（倒下・重傷）' : ''}`);
    });
    if (exp.rallySummary) report.events.push(exp.rallySummary);
    // 戰鬥詳細（逐筆傷害與每人統計）：每位參加的玩家都會收到一份
    if (exp.rallyBattle) g.combat.adopt(exp.rallyBattle, report);
    (r.units || []).forEach((u) => {
      const sv = g.survivors.get(exp.memberIds[u.i]);
      if (!sv) return;
      if (u.meds > 0) g.combat.consumeMeds(sv, { medsUsed: Math.floor(u.meds) });
      if (u.down) g.survivors.becomeSevere(sv, '在集結戰鬥中', exp.endAt);
      else g.survivors.setHp(sv, Math.max(1, u.hp));
    });
    (r.items || []).forEach((it) => {
      const item = { ...it, id: uid('it') };
      if (g.equipment.addItem(item, '集結')) report.items.push(item);
    });
    report.resources = g.grant({ ...(r.mats || {}), coins: r.coins || 0 });
    if (report.resources.locks > 0) {
      report.locks = report.resources.locks;
      report.events.push(`🔒 集結戰利品中分到「就是要鎖你」×${report.locks}`);
    }
    if (exp.rallyVictory) g.state.stats.battlesWon += 1;
    else if (!exp.recalled) g.state.stats.battlesLost += 1;
    return report;
  }

  /** 左上角顯示：自己發起或參加中的集結 */
  feed(now = Date.now()) {
    return this.trips().map((e) => ({ exp: e, d: this.get(e.rallyId) })).filter((x) => x.d).map(({ exp, d }) => ({
      id: d.id, exp, target: d.target, mine: d.owner === this.myId(), status: d.status, teams: (d.teams || []).length, maxTeams: d.maxTeams,
      left: d.status === 'gathering' ? Math.max(0, (d.home ? RallySystem.schedule(d).go : d.departAt) - now) : d.status === 'departed' ? Math.max(0, (d.fightAt || now) - now) : 0,
      ownerName: d.ownerName, early: !!d.early,
    }));
  }

  /**
   * 參加前估算：從自己的避難所走到集結點的時間（直線距離，協防趕路速度）。
   * 給了隊員與載具時，依隊伍的移動速度計算（載具座位足夠時以載具速度移動）。
   */
  gatherEstimate(d, memberIds = null, vehicleIds = []) {
    const sh = this.game.shelter.primary();
    if (!sh || !d?.home) return 0;
    const dist = haversine(sh.lat, sh.lon, d.home.lat, d.home.lon);
    const rate = memberIds?.length ? this.game.exploration.walkRate({ memberIds, vehicleIds: vehicleIds || [] }) : (1.2 / 1000) * 60000;
    return Math.round(dist * rate * ASSIST_TRAVEL_MUL);
  }

  /** 與目標的距離（公尺） */
  distanceTo(t) {
    const sh = this.game.shelter.primary();
    return sh ? Math.round(haversine(sh.lat, sh.lon, t.lat, t.lon)) : 0;
  }
}

/** 各隊戰況：造成傷害、擊倒、倒下人數 */
function teamLines(teams, res) {
  return teams.map((t) => {
    const us = res.teams[t.player]?.units || [];
    const dealt = us.reduce((a, u) => a + (u.dealt || 0), 0);
    const kills = us.reduce((a, u) => a + (u.kills || 0), 0);
    return `👥 ${String(t.name || '隊伍').slice(0, 16)}：${us.length} 人・造成 ${dealt} 傷害・擊倒 ${kills}・倒下 ${us.filter((u) => u.down).length} 人`;
  });
}
