import {
  CONTROL_POINTS, cpById, cpAt, CP_GARRISON_MUL, CP_PLAYER_SIDE_MUL, CP_ZONE_MUL, FACTIONS, FACTION_KEYS, FACTION_SLOW_AT, defaultFaction, hqNeighbors, cpNeighbors, factionHq, CP_REFILL_PER_HOUR, CP_GUARD_MAX, CP_INCOME, CP_PART_QTY, CP_INCOME_HOUR, CP_START, CP_KIND, CP_TURN_KIND,
} from '../config/controlPoints.js';
import { inNpcHome } from '../config/zones.js';
import { SUPPLIES, SUPPLY_KEYS } from '../config/supplies.js';
import { DAY_REAL_MS, RAID_TRAVEL } from '../config/constants.js';
import { NPC_CONFIG } from '../config/npcs.js';
import { HQ_AMBUSH, hqFactionOf } from './ExplorationSystem.js';
import {
  uid, haversine, chance, randInt, weightedPick, formatDuration, unitPower,
} from '../utils/math.js';
import { AssistSystem } from './AssistSystem.js';
import { balanceMultipliers } from './MaterialBalance.js';
import { baseSupplyWeight } from './LootStock.js';

/** 駐防隊在控制點最多停留的時間（之後自動回家） */
/** 離線期間的每日收益最多補發幾次（遊戲一天＝現實 1 小時，24 次約現實 1 天） */
export const CP_OFFLINE_INCOME_MAX = 24;
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
/** 地圖提示用：探索隊的目的地名稱 */
const g0name = (g, e) => `「${g.exploration.poi(e.poiId)?.name || '探索點'}」`;

export class ControlPointSystem {
  constructor(game) {
    this.game = game;
    this.busy = new Set();
    game.shared?.watch(CP_KIND, 5);
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
    return this.game.shared?.get(CP_KIND, id) || null;
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
      const k = (fac ? 1 : ref / Math.max(1, unitPower(e))) * CP_GARRISON_MUL * (CP_ZONE_MUL[cp.zone] ?? 1) * (cp.side === 'player' ? CP_PLAYER_SIDE_MUL : 1);
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

  /**
   * 能不能進攻：中立、勢力或敵對玩家的控制點，且要和自己或好友佔領的控制點相鄰（最西側一排不受限制）。
   * @param {{reach?:boolean}} [opts] reach=false：不檢查相鄰（隊伍已經出發、抵達時用）
   */
  canAttack(id, { reach = true } = {}) {
    const g = this.game;
    const cp = cpById(id);
    if (!cp) return { ok: false, reason: '找不到控制點' };
    if (!g.shelter.hasShelter()) return { ok: false, reason: '請先建立避難所' };
    const s = this.statusOf(id);
    if (s === 'mine') return { ok: false, reason: '這是你或好友的控制點' };
    if (s === 'other') return { ok: false, reason: '只能攻打中立、勢力或敵對玩家的控制點' };
    // v15.3：勢力控制點裡有 NPC 據點時，要先打掉據點才能佔領
    const base = this.factionOf(id) ? (g.npcs?.list || []).find((n) => n.cp === id && n.faction && !n.hq && !n.gone) : null;
    if (base) return { ok: false, locked: true, reason: `需先打掉控制點內的 NPC 據點「${base.name}」才能進攻` };
    if (reach && !this.reachable(id)) {
      const need = cpNeighbors(id).map((n) => cpById(n).no).sort((a, b) => a - b).map((n) => `#${n}`).join('、');
      return { ok: false, locked: true, reason: `需先佔領相鄰的控制點才能進攻：${need}` };
    }
    return { ok: true };
  }

  /** 和自己或好友佔領的控制點相鄰，或在最西側一排（起始可攻打） */
  reachable(id) {
    if (CP_START.includes(id)) return true;
    return cpNeighbors(id).some((n) => this.statusOf(n) === 'mine');
  }

  /**
   * v15.4：探索中，目標建築所在的控制點被別人佔領（不能再探索）時，強制撤回這些隊伍（佇列一併取消）。
   */
  /** 讀到共用的控制點資料了沒（連線時剛開遊戲還沒讀到前，所有控制點看起來都是中立，不能據此撤回隊伍） */
  ready() {
    const sh = this.game.shared;
    return !sh?.online || !!sh.backend || !!sh.listedAt?.[CP_KIND];
  }

  /**
   * 共用資料太久沒更新（14 天）會被當成不存在（控制點會看起來回到中立）：
   * 佔領者每 3 天把自己佔領的控制點資料更新一次。
   */
  async touchOwned(now = Date.now()) {
    const g = this.game;
    if (!this.ready() || this.busy.has('touch')) return;
    const me = this.myId();
    const stale = CONTROL_POINTS.filter((c) => {
      const o = g.shared?.cache?.get(`${CP_KIND}:${c.id}`);
      return o?.updatedAt && now - o.updatedAt > 3 * 24 * 3600000 && (o.data?.owners || []).some((x) => x.p === me);
    });
    if (!stale.length) return;
    this.busy.add('touch');
    try {
      for (const c of stale) {
        // eslint-disable-next-line no-await-in-loop
        await g.shared.update(CP_KIND, c.id, (x) => (x ? { data: { ...x, touchedAt: now } } : { fail: 'gone' }), { lat: c.lat, lon: c.lon });
      }
    } finally {
      this.busy.delete('touch');
    }
  }

  /** 強制撤回時，把一般的「收到召回命令」換成原因 */
  static replaceRecallText(e, msg) {
    const list = e.travelEvents || [];
    const i = list.lastIndexOf('↩️ 收到召回命令，隊伍折返避難所');
    if (i >= 0) list.splice(i, 1, msg);
    else list.push(msg);
    e.travelEvents = list;
  }

  recallLostExplores(now = Date.now()) {
    const g = this.game;
    if (g.state.map?.source !== 'generated' || !this.ready()) return 0;
    let n = 0;
    let dropped = 0;
    // 佇列中（自動探索預定前往）的地點：在不能再探索的區域裡的一併取消
    g.state.expeditions.filter((e) => e.kind === 'explore' && (e.queue || []).length).forEach((e) => {
      const keep = e.queue.filter((id) => { const p = g.exploration.poi(id); return !p || this.canExplore(p).ok; });
      if (keep.length !== e.queue.length) {
        dropped += e.queue.length - keep.length;
        e.travelEvents = [...(e.travelEvents || []), `🚩 佇列中有 ${e.queue.length - keep.length} 個地點所在的控制點被佔領，已取消`];
        e.queue = keep;
      }
    });
    if (dropped) g.log(`🚩 控制點被佔領：探索佇列中的 ${dropped} 個地點已取消`, 'danger');
    g.state.expeditions.filter((e) => e.kind === 'explore' && !e.recalled && !e.defeated).forEach((e) => {
      const poi = g.exploration.poi(e.poiId);
      if (!poi || this.canExplore(poi).ok) return;
      const cp = cpAt(poi.lat, poi.lon);
      // 離線期間被佔領：從被佔領的那一刻起撤回（之後找到的物資不算）
      const d = cp ? this.data(cp.id) : null;
      const lostAt = d?.takenAt || d?.lostAt || now;
      const at = Math.max(e.startAt, Math.min(now, lostAt));
      if (!g.exploration.canRecall(e, at)) return;
      e.queue = [];
      e.auto = false;
      const r = g.exploration.recall(e.id, at);
      if (!r.ok) return;
      ControlPointSystem.replaceRecallText(e, `🚩 控制點${cp ? ` #${cp.no}` : ''}被佔領，「${poi.name}」不能再探索，隊伍強制撤回`);
      n += 1;
    });
    if (n) {
      g.log(`🚩 探索區域的控制點被佔領：${n} 支隊伍強制撤回`, 'danger');
      g.toast?.(`🚩 探索區域的控制點被佔領，${n} 支隊伍強制撤回`, 'danger');
    }
    return n;
  }

  /**
   * v15.5：其他玩家的探索隊：出發後目標所在的控制點換了佔領者（被打下、回到中立）時，地圖上不再顯示
   * （對方離線時還沒辦法自己撤回；等對方上線同步後會撤回）。
   * 舊版本沒有標示種類：目標是一般建築（不是集結、協防）的視為探索。
   */
  hideOtherTrip(trip, now = Date.now()) {
    if (!trip || trip.rally || trip.kind === 'assist' || trip.defeated) return false;
    if (trip.kind && trip.kind !== 'explore') return false;
    if (this.game.state.map?.source !== 'generated') return false;
    const cp = cpAt(trip.to?.lat, trip.to?.lon);
    if (!cp) return false;
    if (!trip.kind && !(this.game.state.map.pois || []).some((p) => Math.abs(p.lat - trip.to.lat) < 1e-5 && Math.abs(p.lon - trip.to.lon) < 1e-5)) return false;
    const d = this.data(cp.id);
    const changedAt = d?.takenAt || d?.lostAt;
    return !!changedAt && changedAt > trip.startAt && now >= changedAt;
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

  /** v15.4.1：駐防沒有期限（直到撤回或被打下）：快到期時自動延長 */
  extendGuards(now = Date.now()) {
    const g = this.game;
    // 控制點不再是自己或好友的（例如共同佔領的好友解除關係、被打下）：駐防隊撤回
    // （連線時要等讀到共用的控制點資料，否則剛開遊戲時所有控制點看起來都是中立）
    if (this.ready()) g.state.expeditions.filter((e) => e.kind === 'cpGuard' && !e.recalled && !e.defeated && e.cpId && this.statusOf(e.cpId) !== 'mine').forEach((e) => {
      if (!g.exploration.canRecall(e, now)) return;
      const r = g.exploration.recall(e.id, now);
      if (!r.ok) return;
      const msg = `🛡️ 控制點 #${cpById(e.cpId)?.no || ''}已不是你或好友的控制點，駐防隊撤回`;
      ControlPointSystem.replaceRecallText(e, msg);
      g.log(msg, 'danger');
    });
    g.state.expeditions.filter((e) => e.kind === 'cpGuard' && !e.recalled && !e.defeated).forEach((e) => {
      const stayEnd = e.startAt + (e.travelMs || 0) + (e.searchMs || 0);
      if (stayEnd - now > GUARD_STAY_MS / 2) return;
      e.searchMs = (e.searchMs || 0) + GUARD_STAY_MS;
      e.endAt = e.startAt + (e.travelMs || 0) * 2 + e.searchMs;
    });
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
        const r = await g.shared.update(CP_KIND, exp.cpId, (x) => {
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
    return this.game.shared.update(CP_KIND, id, (x) => {
      if (!x) return { fail: 'none' };
      x.guards = (x.guards || []).filter((h) => h.e !== expId);
      return { data: x };
    });
  }

  /** 抵達控制點：和守軍交戰（攻打隊），結果寫進共用資料 */
  async resolveAttacks(now = Date.now()) {
    const g = this.game;
    for (const exp of g.state.expeditions.filter((e) => e.kind === 'cp' && e.cpId && !e.cpResult && !e.recalled)) {
      const at = exp.startAt + exp.travelMs + (exp.searchMs || 0); // 攻打時間（倒數）結束才結算佔領
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
    const c = this.canAttack(id, { reach: false });
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
      const r = await g.shared.update(CP_KIND, id, (x) => ({
        data: { ...(x || {}), owners: [{ p: me, n: name }], faction: null, guards: [], lost: cp.garrison.count, lostAt: at, takenAt: at },
      }), { lat: cp.lat, lon: cp.lon });
      events.push(r.ok ? `🏆 佔領控制點 #${cp.no}！這個區域的建築現在可以探索了` : `⚠️ 佔領失敗：${r.reason}`);
      if (r.ok) g.log(`🚩 佔領控制點 #${cp.no}`, 'success');
      return { victory: r.ok, events };
    }
    // 沒打下：守軍損失保留（NPC 守軍每小時補回；駐防隊員倒下的從名單移除）
    const downIds = new Set(result.foes.filter((f) => f.down).map((f) => f.ally?.player).filter(Boolean));
    await g.shared.update(CP_KIND, id, (x) => {
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

  /**
   * v15.5：離線期間錯過的每日 06:00 收益一次補發（最多 CP_OFFLINE_INCOME_MAX 次，直接入庫），
   * 以上線時仍佔領或駐防的控制點計算。要等讀到共用的控制點資料後才補發（避免誤判沒有控制點）。
   * @returns {{times:number, goods:object}|null}
   */
  catchUpIncome(now = Date.now()) {
    const g = this.game;
    if (this.st.incomeDay == null || !g.shelter.primary()) return null;
    if (g.shared?.online && !g.shared.backend && !g.shared.listedAt?.[CP_KIND]) return null;
    // 補發「昨天以前」錯過的部分；今天的 06:00 照常由運輸隊送回（在線時跨過 06:00 也一樣）
    const today = g.time.day(now);
    const missed = today - 1 - this.st.incomeDay;
    if (missed <= 0) return null;
    this.st.incomeDay = today - 1;
    const times = Math.min(CP_OFFLINE_INCOME_MAX, missed);
    const sources = this.incomeSources();
    if (!sources.length) return null;
    const goods = {};
    for (let i = 0; i < times; i += 1) {
      sources.forEach((cp) => Object.entries(this.rollIncome(cp)).forEach(([k, v]) => { goods[k] = (goods[k] || 0) + v; }));
    }
    const got = g.grant(goods);
    const text = Object.entries(got).filter(([, v]) => v > 0).map(([k, v]) => `${SUPPLIES[k]?.name || { food: '食物', wood: '木材', fuel: '燃料' }[k] || k} ×${v}`).join('、');
    g.log(`🚚 離線期間的控制點收益（${times} 次${missed > times ? `，最多補 ${CP_OFFLINE_INCOME_MAX} 次` : ''}）：${text}`, 'loot');
    const res = { times, missed, goods: got, text, cps: sources.length };
    this.lastCatchUp = res;
    g.bus.emit('cp:offlineIncome', res);
    return res;
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
      const r = await g.shared.update(CP_KIND, cp.id, (x) => ({ data: { ...(x || {}), owners: [], guards: [], faction: null, lost: cp.garrison.count, lostAt: now } }), { lat: cp.lat, lon: cp.lon });
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
      const k = CP_GARRISON_MUL * (CP_ZONE_MUL[cp.zone] ?? 1) * (cp.side === 'player' ? CP_PLAYER_SIDE_MUL : 1);
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
        const lock = await g.shared.update(CP_TURN_KIND, f, (x) => (x?.day === day ? { fail: 'done' } : { data: { day, at: now } }));
        this.lastTurn = { ...(this.lastTurn || {}), [f]: day };
        if (!lock.ok) continue;
        const target = this.pickTarget(f, at);
        if (!target) continue;
        // v15.4：部隊從勢力據點（沒有時從大本營）出發，移動時間比照攻打玩家避難所，讓玩家有時間反應
        // eslint-disable-next-line no-await-in-loop
        await this.launchMarch(f, target, at);
      } finally {
        this.busy.delete(`turn:${f}`);
      }
    }
  }

  /** v15.4：NPC 部隊的移動時間（比照攻打玩家避難所：步行時間 ×RAID_TRAVEL.npcMul，至少 RAID_TRAVEL.minMin 分鐘） */
  static marchMs(from, to) {
    const dist = haversine(from.lat, from.lon, to.lat, to.lon);
    return Math.round(Math.max((dist / 1000) * NPC_CONFIG.walkMinPerKm * RAID_TRAVEL.npcMul, RAID_TRAVEL.minMin) * 60000);
  }

  /** 勢力出兵的地點：離目標最近的自己的 NPC 據點，沒有時從大本營 */
  marchFrom(f, to) {
    const bases = (this.game.npcs?.list || []).filter((n) => n.faction === f && !n.hq);
    const near = bases.sort((a, b) => haversine(a.lat, a.lon, to.lat, to.lon) - haversine(b.lat, b.lon, to.lat, to.lon))[0];
    return near ? { lat: near.lat, lon: near.lon } : factionHq(f);
  }

  /** 勢力派兵前往控制點（寫進共用資料，抵達時才交戰） */
  async launchMarch(f, id, at = Date.now()) {
    const to = this.markerSpot(id);
    const from = this.marchFrom(f, to);
    const arriveAt = at + ControlPointSystem.marchMs(from, to);
    const cp = cpById(id);
    const r = await this.game.shared.update(CP_KIND, id, (x) => {
      const data = x || { owners: [], guards: [], faction: defaultFaction(cp) };
      if (data.march) return { fail: 'busy' };
      return { data: { ...data, march: { f, from, at, arriveAt } } };
    }, { lat: cp.lat, lon: cp.lon });
    if (r.ok) this.game.log(`🏴 勢力「${FACTIONS[f].name}」派兵前往控制點 #${cp.no}（約 ${Math.max(1, Math.round((arriveAt - at) / 60000))} 分鐘後抵達）`, 'danger');
    return r;
  }

  /** 抵達的進攻部隊：先取得結算權（清掉 march，避免多位玩家重複結算），再交戰 */
  async resolveMarches(now = Date.now()) {
    const g = this.game;
    for (const cp of CONTROL_POINTS) {
      const m = this.data(cp.id)?.march;
      if (!m || now < m.arriveAt || this.busy.has(`march:${cp.id}`)) continue;
      this.busy.add(`march:${cp.id}`);
      try {
        // eslint-disable-next-line no-await-in-loop
        const claim = await g.shared.update(CP_KIND, cp.id, (x) => (x?.march?.arriveAt === m.arriveAt ? { data: { ...x, march: null } } : { fail: 'done' }), { lat: cp.lat, lon: cp.lon });
        // eslint-disable-next-line no-await-in-loop
        if (claim.ok) await this.npcAttack(m.f, cp.id, m.arriveAt);
      } finally {
        this.busy.delete(`march:${cp.id}`);
      }
    }
  }

  /** 前往自己（或好友）控制點的進攻部隊：提醒一次 */
  warnMarches(now = Date.now()) {
    this.warned = this.warned || new Set();
    CONTROL_POINTS.forEach((cp) => {
      const m = this.data(cp.id)?.march;
      if (!m || now >= m.arriveAt) return;
      // 佔領者與駐防者都會收到；同一位玩家同時是佔領者與駐防者時只收到一則
      const me = this.myId();
      const owner = this.owners(cp.id).some((o) => o.p === me);
      const guard = (this.data(cp.id)?.guards || []).some((h) => h.p === me);
      if (!owner && !guard) return;
      const key = `${cp.id}:${m.arriveAt}`;
      if (this.warned.has(key)) return;
      this.warned.add(key);
      const min = Math.max(1, Math.round((m.arriveAt - now) / 60000));
      const role = owner && guard ? '你佔領並駐防的' : owner ? '你佔領的' : '你駐防的';
      const msg = `⚔️ 勢力「${FACTIONS[m.f]?.name || ''}」的部隊正前往${role}控制點 #${cp.no}（約 ${min} 分鐘後抵達）${owner && !guard ? '，可以派人駐防' : ''}`;
      this.game.log(msg, 'danger');
      this.game.toast?.(msg, 'danger');
    });
  }

  /**
   * v15.4：探索點在鄰接大本營的控制點：隊伍開始搜索時擲一次（HQ_AMBUSH.chance），被盯上時大本營派出部隊，
   * 移動時間比照攻打玩家避難所；部隊抵達時隊伍還在那裡搜索才交戰（先撤回就能躲開）。
   */
  hqAmbushes(now = Date.now()) {
    const g = this.game;
    if (g.state.map?.source !== 'generated') return;
    g.state.expeditions.filter((e) => e.kind === 'explore' && !e.recalled && !e.defeated).forEach((e) => {
      const arrive = e.startAt + (e.travelMs || 0);
      const searchEnd = arrive + (e.searchMs || 0);
      const poi = g.exploration.poi(e.poiId);
      if (!e.hqRoll && now >= arrive && now < searchEnd) {
        e.hqRoll = true;
        const f = hqFactionOf(poi);
        if (f && chance(HQ_AMBUSH.chance)) {
          const from = factionHq(f);
          const hitAt = now + ControlPointSystem.marchMs(from, poi);
          e.hqAmbush = { f, from, to: { lat: poi.lat, lon: poi.lon }, at: now, hitAt };
          const min = Math.max(1, Math.round((hitAt - now) / 60000));
          const msg = `🏯 ${FACTIONS[f].name}大本營派出部隊前往「${poi.name}」（約 ${min} 分鐘後抵達），可以先召回隊伍`;
          e.travelEvents = [...(e.travelEvents || []), msg];
          g.log(msg, 'danger');
          g.toast?.(msg, 'danger');
        }
      }
      const a = e.hqAmbush;
      if (a && !a.done && now >= a.hitAt) {
        a.done = true;
        // 部隊抵達時隊伍已經搜完離開：撲空
        if (a.hitAt >= searchEnd) return;
        g.exploration.runCheckpoints(e, a.hitAt);
        g.exploration.hqAmbushFight(e, poi, a);
      }
    });
  }

  /** 移動中的部隊（地圖顯示：控制點進攻部隊、襲擊探索點的大本營部隊） */
  marchView(now = Date.now()) {
    const out = [];
    const at = (m, to) => { const p = Math.max(0, Math.min(1, (now - m.at) / Math.max(1, (m.arriveAt ?? m.hitAt) - m.at))); return { lat: m.from.lat + (to.lat - m.from.lat) * p, lon: m.from.lon + (to.lon - m.from.lon) * p }; };
    CONTROL_POINTS.forEach((cp) => {
      const m = this.data(cp.id)?.march;
      if (!m || now >= m.arriveAt) return;
      const to = this.markerSpot(cp.id);
      out.push({ id: `mc:${cp.id}`, kind: 'march', f: m.f, from: m.from, to, ...at(m, to), startAt: m.at, arriveAt: m.arriveAt, left: m.arriveAt - now, label: `控制點 #${cp.no}` });
    });
    this.game.state.expeditions.forEach((e) => {
      const a = e.hqAmbush;
      if (!a || a.done || now >= a.hitAt || e.recalled) return;
      out.push({ id: `ma:${e.id}`, kind: 'march', f: a.f, from: a.from, to: a.to, ...at(a, a.to), startAt: a.at, arriveAt: a.hitAt, left: a.hitAt - now, label: g0name(this.game, e) });
    });
    return out;
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
    const res = await g.shared.update(CP_KIND, id, (x) => {
      const data = x || { owners: [], guards: [], faction: defaultFaction(cp) };
      // v15.6：交戰結果記在共用資料，佔領者與駐防者（不在線也一樣）之後都會收到戰報
      const fight = {
        f, at, win, lost: killed, total: foes.length, atk: attackers.length, atkDown: (r.team || []).filter((u) => u.down).length,
        owners: (data.owners || []).map((o) => o.p), guards: [...new Set((data.guards || []).map((h) => h.p))],
        down: [...downIds],
      };
      if (win) {
        // 打下後留守：守軍約為進攻部隊的一半（之後每小時補回）
        return { data: { owners: [], guards: [], faction: f, lost: Math.ceil(cp.garrison.count / 2), lostAt: at, takenAt: at, by: f, fight } };
      }
      data.fight = fight;
      if (data.owners?.length && !data.faction) data.guards = (data.guards || []).filter((h) => !downIds.has(h.p));
      else { data.lost = Math.min(cp.garrison.count, (cp.garrison.count - this.garrisonCount(id, at)) + killed); data.lostAt = at; }
      return { data };
    }, { lat: cp.lat, lon: cp.lon });
    if (res.ok && win) g.log(`🏴 勢力「${FACTIONS[f].name}」佔領了控制點 #${cp.no}`, 'danger');
    return { win, ok: res.ok };
  }

  /** v15.6：勢力進攻控制點的交戰結果：佔領者與駐防者各收到一則（同一人只一則） */
  reportFights() {
    const g = this.game;
    if (!this.ready()) return;
    const me = this.myId();
    this.st.fightSeen = this.st.fightSeen || {};
    CONTROL_POINTS.forEach((cp) => {
      const ft = this.data(cp.id)?.fight;
      if (!ft || (this.st.fightSeen[cp.id] || 0) >= ft.at) return;
      this.st.fightSeen[cp.id] = ft.at;
      const owner = (ft.owners || []).includes(me);
      const guard = (ft.guards || []).includes(me);
      if (!owner && !guard) return;
      const fname = FACTIONS[ft.f]?.name || '勢力';
      const role = owner && guard ? '你佔領並駐防的' : owner ? '你佔領的' : '你駐防的';
      const msg = ft.win
        ? `🏴 「${fname}」的部隊（${ft.atk} 人）攻下了${role}控制點 #${cp.no}${ft.total ? `：守軍 ${ft.total} 人全數被擊倒` : '（沒有駐防）'}`
        : `🛡️ ${role}控制點 #${cp.no} 擊退了「${fname}」的部隊（${ft.atk} 人）：擊倒 ${ft.atkDown || 0} 人，守軍倒下 ${ft.lost || 0} 人${(ft.down || []).includes(me) ? '（你的駐防隊有人倒下，撤回避難所）' : ''}`;
      g.log(msg, ft.win ? 'danger' : 'success');
      g.toast?.(msg, ft.win ? 'danger' : 'success');
    });
  }

  /** 每 2 秒 */
  update(now = Date.now()) {
    if (now - (this.lastAt || 0) < 2000) return;
    this.lastAt = now;
    this.resolveAttacks(now).catch(() => {});
    this.extendGuards(now);
    this.touchOwned(now).catch(() => {});
    this.syncGuards(now).catch(() => {});
    this.checkHostileOwners(now).catch(() => {});
    this.npcTurns(now).catch(() => {});
    this.resolveMarches(now).catch(() => {});
    this.warnMarches(now);
    this.reportFights();
    this.hqAmbushes(now);
    this.recallLostExplores(now);
    this.game.npcs?.recallLostTrips?.(now);
    this.catchUpIncome(now);
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
