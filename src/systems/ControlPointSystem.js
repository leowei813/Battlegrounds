import { TimeSystem } from './TimeSystem.js';
import {
  CONTROL_POINTS, cpById, cpAt, CP_POWER, CP_GARRISON, CP_LEVEL, CP_MAX_PLAYERS, CP_BUILDINGS, CP_BUILD, CP_INCOME_MUL, FACTIONS, FACTION_KEYS, FACTION_SLOW_AT, defaultFaction, hqNeighbors, cpNeighbors, factionHq, CP_REFILL_PER_HOUR, CP_GUARD_MAX, CP_INCOME, CP_PART_QTY, CP_INCOME_HOUR, CP_START, CP_KIND, CP_TURN_KIND, CP_GUARD_XP_PCT, CP_SHIELD, FACTION_FORCE_SCALE,
} from '../config/controlPoints.js';
import { inNpcHome, ZONES } from '../config/zones.js';
import { xpToNext } from '../config/survivors.js';
import { SUPPLIES, SUPPLY_KEYS } from '../config/supplies.js';
import { RAID_TRAVEL } from '../config/constants.js';
import { NPC_CONFIG, npcQuietSpan, NPC_QUIET, NPC_DAY_SLOW, RALLY_XP } from '../config/npcs.js';
import {
  uid, haversine, randInt, weightedPick, formatDuration, unitPower,
} from '../utils/math.js';
import { DEFENSES, DEFENSE_MAX_LEVEL } from '../config/defenses.js';
import { canAfford, payCost, scaleCost, grant as grantCost } from './costUtils.js';
import { AssistSystem } from './AssistSystem.js';
import { balanceMultipliers } from './MaterialBalance.js';
import { baseSupplyWeight } from './LootStock.js';

/** 駐防隊在控制點最多停留的時間（之後自動回家） */
/** 離線期間的每日收益最多補發幾次（遊戲一天＝現實 90 分鐘，24 次約現實 1.5 天） */
export const CP_OFFLINE_INCOME_MAX = 24;
const GUARD_STAY_MS = 7 * 24 * 3600000;
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
/** 物資清單文字 */
const goodsText = (got) => Object.entries(got || {}).filter(([, v]) => v > 0).map(([k, v]) => `${SUPPLIES[k]?.name || { food: '食物', wood: '木材', fuel: '燃料' }[k] || k} ×${v}`).join('、');
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

  /** v15.7：勢力是否已經佔領最西側一排（CP_START）的控制點：佔領到之後才會攻打玩家據點 */
  factionReachedWest(f) {
    return CP_START.some((id) => this.factionOf(id) === f);
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
    if (own.some((o) => this.hostileTo(o.p))) return 'hostile';
    return 'other';
  }

  /** v17：和這位玩家是敵對關係 */
  hostileTo(pid) {
    return pid !== this.myId() && this.game.territory?.relation?.(pid) === 'hostile';
  }

  /** v17：可以進入（探索、路線穿越）：中立，或佔領者都不是敵對；勢力佔領的不行 */
  canEnter(id) {
    if (this.factionOf(id)) return false;
    return !this.owners(id).some((o) => this.hostileTo(o.p));
  }

  /** v17：可以駐防、蓋防禦建築：有玩家佔領，且佔領者都不是敵對 */
  canJoin(id) {
    const own = this.owners(id);
    return !this.factionOf(id) && own.length > 0 && !own.some((o) => this.hostileTo(o.p));
  }

  /** v17：在這個控制點駐防或有建築的玩家 */
  members(id) {
    const d = this.data(id) || {};
    return [...new Set([...(d.guards || []).map((h) => h.p), ...Object.keys(d.bld || {})])];
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
    if (this.canEnter(cp.id)) return { ok: true };
    return { ok: false, reason: this.factionOf(cp.id) ? `控制點 #${cp.no}（${cp.name}）被勢力佔領，要先打下才能探索這個區域` : `控制點 #${cp.no}（${cp.name}）被敵對玩家佔領，不能探索這個區域` };
  }

  /** v17：滿編守軍人數（勢力佔領 18 人、中立左側 10／右側 12） */
  garrisonFull(id) {
    const cp = cpById(id);
    return this.factionOf(id) ? CP_GARRISON.npc : CP_GARRISON.neutral[cp.side];
  }

  /** 目前的守軍人數（被打下後每小時補回） */
  garrisonCount(id, now = Date.now()) {
    const d = this.data(id);
    const full = this.garrisonFull(id);
    if (!d?.lost) return full;
    const back = Math.floor(((now - (d.lostAt || now)) / 3600000) * CP_REFILL_PER_HOUR);
    return Math.max(0, Math.min(full, full - d.lost + back));
  }

  /** v17：把敵人調整到指定戰力（倍率依種類與目標快取） */
  scaledEnemy(type, level, power, elite = false) {
    const cb = this.game.combat;
    this.scaleCache = this.scaleCache || new Map();
    const key = `${type}|${level}|${Math.round(power)}|${elite ? 1 : 0}`;
    const e = cb.createEnemy(type, level, elite);
    let k = this.scaleCache.get(key);
    if (!k) {
      const h0 = e.maxHp;
      const a0 = e.atk;
      let lo = 0.01;
      let hi = 2000;
      for (let i = 0; i < 50; i += 1) {
        const m = Math.sqrt(lo * hi);
        e.maxHp = Math.round(h0 * m); e.atk = Math.round(a0 * m);
        if (unitPower(e) < power) lo = m; else hi = m;
      }
      k = Math.sqrt(lo * hi);
      this.scaleCache.set(key, k);
      e.maxHp = h0; e.atk = a0;
    }
    e.maxHp = Math.round(e.maxHp * k); e.hp = e.maxHp; e.atk = Math.round(e.atk * k);
    return e;
  }

  /** NPC／感染者守軍（中立與勢力的控制點）：v17 依總戰力換算（中立左 15 萬、右 40 萬；勢力滿編 90 萬） */
  npcGarrison(id, now = Date.now()) {
    const cp = cpById(id);
    const n = this.garrisonCount(id, now);
    const fac = this.factionOf(id);
    const full = this.garrisonFull(id);
    const each = (fac ? CP_POWER.npc.full : CP_POWER.neutral[cp.side]) / full;
    const lv = fac ? CP_LEVEL.npc : cp.garrison.level;
    return Array.from({ length: n }, (_, i) => (fac
      ? this.scaledEnemy(i === 0 ? 'raiderChief' : 'raider', lv, each)
      : this.scaledEnemy(NEUTRAL_TYPES[i % NEUTRAL_TYPES.length], lv, each)));
  }

  /**
   * v15.7：已經抵達的駐防隊（出發時就寫進共用資料並記下抵達時間 arr，玩家離線時抵達也算數）。
   * 舊資料沒有 arr：視為已抵達。
   */
  guardsAt(id, at = Date.now()) {
    return (this.data(id)?.guards || []).filter((h) => !(h.arr > at));
  }

  /** 防守方：玩家佔領的是駐防隊員，其他是 NPC／感染者守軍 */
  defenders(id, now = Date.now()) {
    if (this.owners(id).length && !this.factionOf(id)) {
      // 記下是哪一支駐防隊（h.e）的第幾位，交戰後依此判斷誰倒下、誰拿防守經驗
      return this.guardsAt(id, now).flatMap((h) => (h.units || []).slice(0, CP_GUARD_MAX).map((u) => {
        const x = AssistSystem.unitOf({ id: h.p, name: h.n }, u);
        x.ally.e = h.e;
        return x;
      }));
    }
    return this.npcGarrison(id, now);
  }

  /** 防守方戰力（顯示用） */
  defensePower(id, now = Date.now()) {
    return this.defenders(id, now).reduce((s, u) => s + unitPower(u), 0);
  }

  // ================= v17：控制點防禦建築（每位玩家路障、機槍塔、瞭望台各 1 座） =================

  /** 某位玩家在這個控制點的建築等級 { barricade, machineGun, watchPost } */
  bldOf(id, pid = this.myId()) {
    return { ...(this.data(id)?.bld?.[pid]?.b || {}) };
  }

  /** 建造或升級到 lv 的費用：避難所同等級的一半 */
  bldCost(key, lv) {
    // v17：費用為避難所的一半，再套用自己的「降低建造費用」科技（與工程師折扣，同避難所）
    const half = scaleCost(DEFENSES[key].cost(lv), CP_BUILD.costMul);
    return this.game.shelter?.discounted ? this.game.shelter.discounted(half) : half;
  }

  /**
   * v17：自己的科技對控制點防禦建築的加成（建造或升級時寫進共用資料，研究升級後自動更新）：
   * w 路障耐久（圍牆耐久科技）、g 機槍塔傷害（防禦塔傷害、機槍塔、精準射擊科技）、v 瞭望台射擊（駐守射擊科技）
   */
  techMul() {
    const r = this.game.research;
    const b = (k) => Number(r?.bonus?.(k)) || 0;
    const round = (x) => Math.round(x * 1000) / 1000;
    return { w: round(1 + b('wallHpPct')), g: round(1 + b('towerDmgPct') + b('defDmg_machineGun') + b('towerRangePct')), v: round(1 + b('guardDmgPct')) };
  }

  /** v17：研究升級後，把自己在各控制點的建築加成更新到共用資料 */
  async syncBldTech() {
    const g = this.game;
    if (!g.shared || this.busy.has('tech')) return;
    const me = this.myId();
    const m = this.techMul();
    const key = JSON.stringify(m);
    const stale = CONTROL_POINTS.filter((c) => { const x = this.data(c.id)?.bld?.[me]; return x && JSON.stringify(x.m || {}) !== key; });
    if (!stale.length) return;
    this.busy.add('tech');
    try {
      for (const c of stale) {
        // eslint-disable-next-line no-await-in-loop
        await g.shared.update(CP_KIND, c.id, (x) => {
          if (!x?.bld?.[me]) return { fail: 'none' };
          x.bld[me] = { ...x.bld[me], m };
          return { data: x };
        }, { lat: c.lat, lon: c.lon });
      }
    } finally {
      this.busy.delete('tech');
    }
  }

  /** 單座建築的效果（避難所的 3 倍）：wall 路障耐久、dps 機槍每秒傷害、mul 瞭望台射擊倍率 */
  static bldEffect(key, lv, guardAtk = 0, tech = null) {
    if (!lv) return { wall: 0, dps: 0 };
    const st = DEFENSES[key].stats(lv);
    const m = CP_BUILD.effectMul;
    const t = (k) => Math.min(5, Math.max(1, Number(tech?.[k]) || 1));
    if (key === 'barricade') return { wall: st.wallBonus * m * t('w'), dps: 0 };
    if (key === 'machineGun') return { wall: 0, dps: st.damage * st.fireRate * m * t('g') };
    if (key === 'watchPost') return { wall: 0, dps: guardAtk * st.garrisonMul * st.fireRate * m * t('v') };
    return { wall: 0, dps: 0 };
  }

  /** 控制點的總防禦（玩家佔領時）：路障耐久、每秒傷害（機槍＋瞭望台以該玩家最強駐防隊員射擊） */
  defenseOf(id, at = Date.now()) {
    const d = this.data(id);
    const out = { wall: 0, dps: 0 };
    if (!d || d.faction || !(d.owners || []).length) return out;
    const guards = this.guardsAt(id, at);
    Object.entries(d.bld || {}).forEach(([pid, x]) => {
      const atk = Math.max(0, ...guards.filter((h) => h.p === pid).flatMap((h) => h.units || []).map((u) => Number(u.atk) || 0));
      CP_BUILDINGS.forEach((k) => {
        const e = ControlPointSystem.bldEffect(k, Math.min(DEFENSE_MAX_LEVEL, Number(x?.b?.[k]) || 0), atk, x?.m);
        out.wall += e.wall;
        out.dps += e.dps;
      });
    });
    out.wall = Math.round(out.wall);
    out.dps = Math.round(out.dps);
    return out;
  }

  /** 能不能在這個控制點加入（駐防或蓋建築）：佔領者不是敵對，且玩家數未滿 */
  joinCheck(id) {
    if (!this.game.shelter.hasShelter()) return { ok: false, reason: '請先建立避難所' };
    if (!this.canJoin(id)) return { ok: false, reason: this.factionOf(id) ? '勢力佔領的控制點不能駐防' : this.owners(id).length ? '佔領者是你的敵對玩家' : '要先有玩家佔領才能駐防或蓋建築' };
    const ms = this.members(id);
    if (!ms.includes(this.myId()) && ms.length >= CP_MAX_PLAYERS) return { ok: false, reason: `這個控制點已經有 ${CP_MAX_PLAYERS} 位玩家駐防或蓋建築` };
    return { ok: true };
  }

  /** 建造或升級：檢查研究、等級上限與資源 */
  canBuild(id, key) {
    const g = this.game;
    if (!CP_BUILDINGS.includes(key)) return { ok: false, reason: '不能蓋這種建築' };
    const j = this.joinCheck(id);
    if (!j.ok) return j;
    if (!g.shelter.isDefenseUnlocked(key)) return { ok: false, reason: g.shelter.defenseLockReason(key) };
    const lv = (this.bldOf(id)[key] || 0) + 1;
    if (lv > DEFENSE_MAX_LEVEL) return { ok: false, reason: '已經是最高等級' };
    const cost = this.bldCost(key, lv);
    if (!canAfford(g.state, cost)) return { ok: false, reason: '資源不足', cost, lv };
    return { ok: true, cost, lv };
  }

  /** 建造或升級（立即完成；先扣自己的資源，寫入共用資料失敗時退還） */
  async build(id, key) {
    const g = this.game;
    const c = this.canBuild(id, key);
    if (!c.ok) return c;
    if (this.busy.has(`b:${id}`)) return { ok: false, reason: '處理中，請稍候' };
    this.busy.add(`b:${id}`);
    const me = this.myId();
    const name = g.state.player.name || '倖存者';
    const cp = cpById(id);
    payCost(g.state, c.cost);
    try {
      const r = await g.shared.update(CP_KIND, id, (x) => {
        const data = x || { owners: [], guards: [] };
        if (data.faction || !(data.owners || []).length || data.owners.some((o) => this.hostileTo(o.p))) return { fail: '控制點已經不能蓋建築' };
        const ms = new Set([...(data.guards || []).map((h) => h.p), ...Object.keys(data.bld || {})]);
        if (!ms.has(me) && ms.size >= CP_MAX_PLAYERS) return { fail: `這個控制點已經有 ${CP_MAX_PLAYERS} 位玩家` };
        data.bld = data.bld || {};
        const cur = data.bld[me]?.b || {};
        if ((cur[key] || 0) + 1 !== c.lv) return { fail: '等級已經改變，請再試一次' };
        data.bld[me] = { n: name, b: { ...cur, [key]: c.lv }, m: this.techMul() };
        return { data };
      }, { lat: cp.lat, lon: cp.lon });
      if (!r.ok) {
        grantCost(g.state, c.cost);
        return r;
      }
      g.log(`🏗️ 在控制點 #${cp.no} ${c.lv === 1 ? '建造' : '升級'}${DEFENSES[key].name}（Lv${c.lv}）`, 'success');
      g.changed?.();
      return { ok: true, msg: `${DEFENSES[key].name}${c.lv === 1 ? '建造完成' : `升級到 Lv${c.lv}`}` };
    } finally {
      this.busy.delete(`b:${id}`);
    }
  }

  /**
   * v17：進攻方先攻打路障（期間機槍塔、瞭望台持續射擊），打破後才和駐防隊交戰。
   * attackers：有 maxHp、atk 的物件（會被改寫 hp）。回傳仍存活的進攻者與攻牆資訊。
   */
  assault(id, attackers, at = Date.now()) {
    const df = this.defenseOf(id, at);
    if (!df.wall && !df.dps) return { alive: attackers, killed: 0, breached: true, sec: 0, df };
    const as = this.game.combat.wallAssault(attackers, df.wall, df.dps);
    return { ...as, df };
  }

  /**
   * 能不能進攻：中立、勢力或敵對玩家的控制點，且要和自己或好友佔領的控制點相鄰（最西側一排不受限制）。
   * @param {{reach?:boolean}} [opts] reach=false：不檢查相鄰（隊伍已經出發、抵達時用）
   */
  canAttack(id, { reach = true, now = Date.now() } = {}) {
    const g = this.game;
    const cp = cpById(id);
    if (!cp) return { ok: false, reason: '找不到控制點' };
    if (!g.shelter.hasShelter()) return { ok: false, reason: '請先建立避難所' };
    const s = this.statusOf(id);
    if (s === 'mine') return { ok: false, reason: '這是你或好友的控制點' };
    if (s === 'other') return { ok: false, reason: '只能攻打中立、勢力或敵對玩家的控制點' };
    // v16.1：剛被打下的控制點保護 1 小時，任何人都不能攻打
    const left = this.shieldLeft(id, now);
    if (left > 0) return { ok: false, shield: true, left, reason: `保護中，${Math.ceil(left / 60000)} 分後才能攻打` };
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
    const dup = list.includes(msg); // 交戰經過已經寫進報告（v15.8）：不重複
    if (i >= 0) list.splice(i, 1, ...(dup ? [] : [msg]));
    else if (!dup) list.push(msg);
    e.travelEvents = list;
  }

  recallLostExplores(now = Date.now()) {
    const g = this.game;
    if (g.state.map?.source !== 'generated' || !this.ready()) return 0;
    let n = 0;
    let dropped = 0;
    let redirected = 0;
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
      const note = `🚩 控制點${cp ? ` #${cp.no}` : ''}被佔領，「${poi.name}」不能再探索`;
      // v15.9.1：佇列中還有可以探索的地點：直接改去下一站，不先回家
      if ((e.queue || []).length) {
        const rep = g.exploration.redirect(e, at, note);
        if (rep) {
          g.exploration.pendingReports = [...(g.exploration.pendingReports || []), rep];
          redirected += 1;
          return;
        }
      }
      e.queue = [];
      e.auto = false;
      const r = g.exploration.recall(e.id, at);
      if (!r.ok) return;
      ControlPointSystem.replaceRecallText(e, `🚩 控制點${cp ? ` #${cp.no}` : ''}被佔領，「${poi.name}」不能再探索，隊伍強制撤回`);
      n += 1;
    });
    if (redirected) g.log(`🚩 探索區域的控制點被佔領：${redirected} 支隊伍改去佇列中的下一個地點`, 'danger');
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
    const j = this.joinCheck(id);
    if (!j.ok) return j;
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
    exp.cpKind = CP_KIND;
    exp.searchMs = GUARD_STAY_MS;
    exp.endAt = exp.startAt + exp.travelMs * 2 + exp.searchMs;
    // v15.7：出發時就寫進共用資料（含抵達時間）：抵達時玩家離線，交戰時也算得到這支駐防隊
    this.listGuard(exp).catch(() => {});
    return { ok: true, exp, msg: `隊伍出發駐防控制點 #${cpById(id).no}，約 ${Math.max(1, Math.round(exp.travelMs / 60000))} 分鐘後抵達` };
  }

  /**
   * v15.8：駐防隊撤回的原因：控制點在駐防期間被勢力攻下時說明是誰攻下、駐防隊有沒有參戰；
   * 其他情況（佔領者放棄、好友解除關係）維持原本的說明。
   */
  lostReason(e) {
    const no = cpById(e.cpId)?.no || '';
    const ft = this.data(e.cpId)?.fight;
    if (ft?.win && ft.at >= e.startAt) {
      const who = ControlPointSystem.fightWho(ft);
      if (this.guardFought(e, ft)) return `🏴 控制點 #${no} 被${who}（${ft.atk} 人）攻下：守軍 ${ft.total} 人全數被擊倒，駐防隊撤回`;
      return `🏴 駐防隊還沒抵達，控制點 #${no} 已被${who}（${ft.atk} 人）攻下，駐防隊撤回`;
    }
    if (e.cpKind !== CP_KIND) return `🛡️ 控制點改版（改為 4 個控制點），駐防隊撤回避難所`;
    return `🛡️ 控制點 #${no}的佔領者已經是你的敵對玩家或已易主，駐防隊撤回`;
  }

  /** v15.10：戰鬥明細寫進共用資料前縮小（逐筆紀錄過多時保留頭尾） */
  static fitBattle(b, max = 9000) {
    // 戰報給佔領者與駐防者（防守方）看：我方＝守軍、敵方＝進攻方，勝負也換成守軍的角度
    const log = (b.log || []).map((l) => (l.type === 'win' ? { ...l, msg: '💀 守軍全數被擊倒，控制點失守', type: 'lose' } : l.type === 'lose' ? { ...l, msg: '🏆 守住控制點，進攻方撤退', type: 'win' } : l));
    const x = { ...b, team: b.foes || [], foes: b.team || [], victory: !b.victory, log };
    const size = () => new TextEncoder().encode(JSON.stringify(x)).length;
    while (size() > max && x.log.length > 12) x.log = [...x.log.slice(0, Math.ceil(x.log.length / 2) - 10), ...x.log.slice(-10)];
    return size() > max ? { ...x, log: [] } : x;
  }

  /** 交戰紀錄的進攻方：勢力部隊或玩家的隊伍（v15.8） */
  static fightWho(ft) {
    return ft.pn ? `玩家「${ft.pn}」的隊伍` : `「${FACTIONS[ft.f]?.name || '勢力'}」的部隊`;
  }

  /** 這支駐防隊有沒有參加這場交戰（交戰時已抵達並登記在共用資料） */
  guardFought(e, ft) {
    return Array.isArray(ft.ge) ? ft.ge.includes(e.id) : e.startAt + (e.travelMs || 0) <= ft.at;
  }

  /** v15.4.1：駐防沒有期限（直到撤回或被打下）：快到期時自動延長 */
  extendGuards(now = Date.now()) {
    const g = this.game;
    // 控制點不再是自己或好友的（例如共同佔領的好友解除關係、被打下）：駐防隊撤回
    // （連線時要等讀到共用的控制點資料，否則剛開遊戲時所有控制點看起來都是中立）
    if (this.ready()) g.state.expeditions.filter((e) => e.kind === 'cpGuard' && !e.recalled && !e.defeated && e.cpId && (e.cpKind !== CP_KIND || !this.canJoin(e.cpId))).forEach((e) => {
      if (!g.exploration.canRecall(e, now)) return;
      const r = g.exploration.recall(e.id, now);
      if (!r.ok) return;
      const msg = this.lostReason(e);
      ControlPointSystem.replaceRecallText(e, msg);
      // 被攻下的戰報由 reportFights 發出（v15.8），這裡不重複
      if (!/攻下/.test(msg)) g.log(msg, 'danger');
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
    for (const exp of g.state.expeditions.filter((e) => e.kind === 'cpGuard' && e.cpId && e.cpKind === CP_KIND)) {
      const arrived = now >= exp.startAt + exp.travelMs;
      const d = this.data(exp.cpId);
      const listed = (d?.guards || []).some((x) => x.e === exp.id);
      if (exp.recalled || exp.defeated) {
        if (listed) await this.removeGuard(exp.cpId, exp.id);
        continue;
      }
      if (!exp.cpListed) {
        // 出發時沒寫成功（例如離線）：抵達前持續重試；抵達時控制點已經不是自己或好友的就撤回
        const r = await this.listGuard(exp, now);
        if (r && !r.ok && arrived && r.reason !== 'busy') { exp.cpListed = false; g.exploration.recall(exp.id, now); }
      } else if (arrived && d && !listed) {
        // 駐防隊被擊退（從共用資料中移除）：受傷回家
        // v15.8：先撤回再標記被擊退（被擊退的隊伍不能再召回，順序相反時隊伍會留在原地直到駐防時間結束）
        const r = g.exploration.recall(exp.id, now);
        // 報告結尾已經寫「駐防隊被擊退」：拿掉「收到召回命令」
        if (r.ok) exp.travelEvents = (exp.travelEvents || []).filter((t) => t !== '↩️ 收到召回命令，隊伍折返避難所');
        exp.defeated = true;
        g.log(`🚩 控制點 #${cpById(exp.cpId).no} 的駐防隊被擊退，正在撤回避難所`, 'danger');
      }
    }
  }

  /** 把駐防隊寫進共用資料（含抵達時間 arr） */
  async listGuard(exp, now = Date.now()) {
    const g = this.game;
    if (this.busy.has(exp.id)) return { ok: false, reason: 'busy' };
    this.busy.add(exp.id);
    try {
      const me = this.myId();
      const name = g.state.player.name || '倖存者';
      // v15.6：科技「據點駐防」：自己派出的駐防隊生命與攻擊提升（寫進共用資料，攻打方讀到的就是強化後的數值）
      const bon = g.research.bonus('cpGuardPct');
      const units = g.rally.units(exp.memberIds).map((u) => (bon > 0 ? { ...u, hp: Math.round(u.hp * (1 + bon)), maxHp: Math.round(u.maxHp * (1 + bon)), atk: Math.round(u.atk * (1 + bon)) } : u));
      const arr = exp.startAt + (exp.travelMs || 0);
      const r = await g.shared.update(CP_KIND, exp.cpId, (x) => {
        const data = x || { owners: [], guards: [] };
        if (data.faction || !(data.owners || []).length || data.owners.some((o) => this.hostileTo(o.p))) return { fail: '控制點已經不能駐防' };
        const ms = new Set([...(data.guards || []).map((h) => h.p), ...Object.keys(data.bld || {})]);
        if (!ms.has(me) && ms.size >= CP_MAX_PLAYERS) return { fail: `這個控制點已經有 ${CP_MAX_PLAYERS} 位玩家` };
        data.guards = [...(data.guards || []).filter((h) => h.e !== exp.id), { p: me, n: name, e: exp.id, units, at: now, arr }];
        return { data };
      }, { lat: cpById(exp.cpId).lat, lon: cpById(exp.cpId).lon });
      if (r.ok) exp.cpListed = true;
      return r;
    } finally {
      this.busy.delete(exp.id);
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
        // v15.9.2：抵達就交戰（同集結），結果先通知，隊伍走回家後才收到報告
        this.game.toast?.(`${exp.cpResult.victory ? '🏆' : '⚠️'} 攻打控制點 #${cpById(exp.cpId)?.no || ''}：${exp.cpResult.victory ? '佔領成功' : '沒能打下'}，隊伍返回避難所`, exp.cpResult.victory ? 'success' : 'danger');
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
    const c = this.canAttack(id, { reach: false, now: at });
    if (!c.ok) return { victory: false, events: [`🚩 抵達時控制點 #${cp.no} ${c.reason}`] };
    const foes = this.defenders(id, at);
    const before = foes.length;
    // v17：先攻打路障（防禦建築射擊），被擊倒的隊員重傷
    const att = members.map((m) => ({ sv: m, maxHp: Math.max(1, g.survivors.hpOf(m)), atk: g.survivors.stats(m).atk }));
    const as = this.assault(id, att, at);
    const wallEvents = as.df.wall || as.df.dps ? [`🧱 攻打路障 ${as.sec} 秒（耐久 ${as.df.wall.toLocaleString()}、防禦火力每秒 ${as.df.dps.toLocaleString()}）${att.length - as.alive.length ? `，${att.length - as.alive.length} 名隊員被擊倒` : ''}${as.breached ? '・路障被打破' : '・沒能打破路障'}`] : [];
    att.forEach((a) => {
      if (!as.alive.includes(a)) g.survivors.battleDown(a.sv, '攻打控制點時被防禦建築擊倒', at);
      else if (as.df.wall || as.df.dps) g.survivors.setHp(a.sv, a.hp);
    });
    const fighters = as.breached ? as.alive.map((a) => a.sv) : [];
    const result = fighters.length ? g.combat.simulate(fighters, foes, { title: `🚩 攻打控制點 #${cp.no}`, capture: 60 })
      : { victory: false, foes: foes.map((f) => ({ id: f.id, ally: f.ally, down: false, hp: f.hp })), team: [], kills: [], xp: 0 };
    if (fighters.length) g.combat.applyOutcome(fighters, result, at, { attackXp: RALLY_XP });
    const me = this.myId();
    const name = g.state.player.name || '倖存者';
    const killed = result.foes.filter((f) => f.down).length;
    const events = [...wallEvents, ...(fighters.length ? [`⚔️ 控制點 #${cp.no}：守軍 ${before} 人，擊倒 ${killed} 人`] : [])];
    if (result.winBonus?.length) events.push(`🏆 勝利經驗：${result.winBonus.join('、')}`);
    // v15.8：玩家攻打有人佔領的控制點也留下交戰紀錄，佔領者與駐防者會收到戰報、駐防隊報告寫出原因
    const fightOf = (x, win) => {
      if (!(x?.owners || []).length) return x?.fight;
      const arrived = (x.guards || []).filter((h) => !(h.arr > at));
      return {
        p: me, pn: name, at, win, total: before, lost: killed, atk: members.length, atkDown: (result.team || []).filter((u) => u.down).length,
        owners: x.owners.map((o) => o.p), guards: [...new Set(arrived.map((h) => h.p))],
        down: [...new Set(result.foes.filter((f) => f.down).map((f) => f.ally?.player).filter(Boolean))],
        downU: result.foes.filter((f) => f.down && f.ally?.e).map((f) => `${f.ally.e}:${f.ally.i}`).slice(0, 60),
        ge: [...new Set(arrived.map((h) => h.e).filter(Boolean))].slice(0, 30),
        ...(result.entry ? { battle: ControlPointSystem.fitBattle({ ...result.entry, title: `🚩 玩家「${name}」攻打控制點 #${cp.no}` }) } : {}),
      };
    };
    if (result.victory) {
      const r = await g.shared.update(CP_KIND, id, (x) => ({
        data: { ...(x || {}), owners: [{ p: me, n: name }], faction: null, guards: [], bld: {}, lost: CP_GARRISON.neutral[cp.side], lostAt: at, takenAt: at, fight: fightOf(x, true) },
      }), { lat: cp.lat, lon: cp.lon });
      events.push(r.ok ? `🏆 佔領控制點 #${cp.no}！這個區域的建築現在可以探索了` : `⚠️ 佔領失敗：${r.reason}`);
      if (r.ok) g.log(`🚩 佔領控制點 #${cp.no}`, 'success');
      return { victory: r.ok, events };
    }
    // 沒打下：守軍損失保留（NPC 守軍每小時補回；駐防隊員倒下的從名單移除）
    const downIds = new Set(result.foes.filter((f) => f.down).map((f) => f.ally?.player).filter(Boolean));
    await g.shared.update(CP_KIND, id, (x) => {
      const data = x || { owners: [], guards: [], faction: defaultFaction(cp) };
      if (data.owners?.length && !data.faction) data.fight = fightOf(data, false);
      if (data.owners?.length && !data.faction) data.guards = (data.guards || []).filter((h) => !downIds.has(h.p));
      else { const full = this.garrisonFull(id); data.lost = Math.min(full, (full - this.garrisonCount(id, at)) + killed); data.lostAt = at; }
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
      kills: exp.travelKills || 0, xp: exp.travelXp || 0, success: !!r.victory, members: members.map((m) => m.name), cp: true,
    };
  }

  /** 駐防隊回家的報告 */
  guardReport(exp) {
    const cp = cpById(exp.cpId);
    const members = exp.memberIds.map((x) => this.game.survivors.get(x)).filter(Boolean);
    return {
      id: uid('rp'), poiName: `🛡️ 駐防控制點 #${cp?.no ?? '?'}`, poiType: 'military', at: exp.endAt,
      events: [...(exp.travelEvents || []), exp.defeated ? '💀 駐防隊被擊退' : exp.recalled ? '🏠 駐防隊撤回避難所' : '🛡️ 駐防結束，回到避難所'], resources: {}, items: [], blueprints: [],
      kills: exp.travelKills || 0, xp: exp.travelXp || 0, success: !exp.defeated && !exp.recalled, members: members.map((m) => m.name), cp: true,
    };
  }

  // ================= 每日收益 =================

  /** 今天 06:00 的現實時間 */
  incomeTime(now = Date.now()) {
    const t = this.game.time;
    const h = t.totalHours(now);
    const day0 = Math.floor(h / 24) * 24;
    return now - ((h - day0 - CP_INCOME_HOUR) / 24) * TimeSystem.dayMs(now);
  }

  /** 收益內容（食物、木材、燃料＋隨機零件：階級越高機率越低、數量越少） */
  rollIncome(cp, rnd = Math.random) {
    const inc = CP_INCOME[cp.zone] || CP_INCOME[5];
    const M = CP_INCOME_MUL;
    const out = { food: inc.food * M, wood: inc.wood * M, fuel: inc.fuel * M };
    const bal = balanceMultipliers(baseSupplyWeight);
    // v17：零件（每種數量 ×6）＋布料（種類約零件的一半）
    const roll = (cat, kinds) => {
      for (let i = 0; i < kinds; i += 1) {
        const tier = 1 + Number(weightedPick(Object.fromEntries(inc.tiers.map((w, k) => [k, w]))));
        const keys = SUPPLY_KEYS.filter((k) => SUPPLIES[k].cat === cat && SUPPLIES[k].tier === tier && SUPPLIES[k].tag !== 'ammo');
        if (!keys.length) continue;
        const k = weightedPick(Object.fromEntries(keys.map((x) => [x, baseSupplyWeight(x) * (bal[x] ?? 1)])));
        const [a, b] = CP_PART_QTY[tier];
        out[k] = (out[k] || 0) + randInt(a, b) * M;
      }
    };
    const kinds = randInt(inc.parts[0], inc.parts[1]);
    roll('part', kinds);
    roll('fabric', Math.ceil(kinds / 2));
    void rnd;
    return out;
  }

  /** 我可以拿收益的控制點：佔領者或駐防者（同一人只算一次） */
  incomeSources() {
    const me = this.myId();
    return CONTROL_POINTS.filter((cp) => {
      const d = this.data(cp.id);
      if (!d || d.faction) return false;
      return (d.owners || []).some((o) => o.p === me) || this.guardsAt(cp.id).some((h) => h.p === me);
    });
  }

  /**
   * 每天 06:00：控制點收益直接入庫（v15.7：不再派運輸隊），跳出視窗告知來自哪些控制點、各多少。
   * @returns {{list:object[], total:object, text:string}|null}
   */
  startConvoys(now = Date.now()) {
    const g = this.game;
    const sh = g.shelter.primary();
    if (!sh) return null;
    const day = g.time.day(now);
    const at = this.incomeTime(now);
    if (now < at || this.st.incomeDay === day) return null;
    this.st.incomeDay = day;
    const me = this.myId();
    const total = {};
    const list = this.incomeSources().map((cp) => {
      const d = this.data(cp.id) || {};
      const own = (d.owners || []).some((o) => o.p === me);
      const guard = (d.guards || []).some((h) => h.p === me);
      const got = g.grant(this.rollIncome(cp));
      Object.entries(got).forEach(([k, v]) => { if (v > 0) total[k] = (total[k] || 0) + v; });
      return { id: cp.id, no: cp.no, zone: cp.name, role: own && guard ? '佔領・駐防' : own ? '佔領' : '駐防', goods: got, text: goodsText(got) };
    });
    if (!list.length) return null;
    const res = { list, total, text: goodsText(total) };
    g.log(`🚚 06:00 控制點物資送達（${list.length} 個控制點）：${res.text || '沒有東西'}`, 'loot');
    g.bus.emit('cp:dailyIncome', res);
    return res;
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
    const text = goodsText(got);
    g.log(`🚚 離線期間的控制點收益（${times} 次${missed > times ? `，最多補 ${CP_OFFLINE_INCOME_MAX} 次` : ''}）：${text}`, 'loot');
    const res = { times, missed, goods: got, text, cps: sources.length };
    this.lastCatchUp = res;
    g.bus.emit('cp:offlineIncome', res);
    return res;
  }

  /** 舊版存檔裡還在路上的運輸隊：直接入庫（v15.7 起不再有運輸隊動畫） */
  deliverConvoys() {
    const g = this.game;
    const done = this.st.convoys || [];
    if (!done.length) return;
    this.st.convoys = [];
    done.forEach((c) => {
      const got = g.grant(c.goods);
      g.log(`🚚 控制點 #${cpById(c.cp)?.no} 的物資送達：${goodsText(got) || '沒有東西'}`, 'loot');
    });
  }

  /** 地圖顯示：v15.7 起沒有運輸隊 */
  convoyView() {
    return [];
  }

  // ================= 敵對：共同擁有者變成敵對時回到中立 =================

  async checkHostileOwners(now = Date.now()) {
    const g = this.game;
    const me = this.myId();
    for (const cp of CONTROL_POINTS) {
      const own = this.owners(cp.id);
      const d = this.data(cp.id);
      if (!d || d.faction) continue;
      const iOwn = own.some((o) => o.p === me);
      // 共同擁有者變成敵對：控制點回到中立
      if (iOwn && own.length >= 2 && own.some((o) => o.p !== me && this.hostileTo(o.p))) {
        if (this.busy.has(`h:${cp.id}`)) continue;
        this.busy.add(`h:${cp.id}`);
        // eslint-disable-next-line no-await-in-loop
        const r = await g.shared.update(CP_KIND, cp.id, (x) => ({ data: { ...(x || {}), owners: [], guards: [], bld: {}, faction: null, lost: CP_GARRISON.neutral[cp.side], lostAt: now } }), { lat: cp.lat, lon: cp.lon });
        this.busy.delete(`h:${cp.id}`);
        if (r.ok) g.log(`🚩 控制點 #${cp.no} 的共同佔領者變成敵對，控制點回到中立`, 'danger');
        continue;
      }
      // v17：和佔領者敵對的玩家：拆除他的防禦建築、遣返駐防隊（佔領者或該玩家任一方處理）
      const bad = iOwn ? this.members(cp.id).filter((p) => p !== me && !own.some((o) => o.p === p) && this.hostileTo(p))
        : (own.some((o) => this.hostileTo(o.p)) && this.members(cp.id).includes(me) ? [me] : []);
      if (!bad.length || this.busy.has(`hb:${cp.id}`)) continue;
      this.busy.add(`hb:${cp.id}`);
      // eslint-disable-next-line no-await-in-loop
      const r = await g.shared.update(CP_KIND, cp.id, (x) => {
        if (!x) return { fail: 'none' };
        x.guards = (x.guards || []).filter((h) => !bad.includes(h.p));
        x.bld = Object.fromEntries(Object.entries(x.bld || {}).filter(([p]) => !bad.includes(p)));
        return { data: x };
      }, { lat: cp.lat, lon: cp.lon });
      this.busy.delete(`hb:${cp.id}`);
      if (r.ok) g.log(iOwn ? `🚩 控制點 #${cp.no}：敵對玩家的防禦建築已拆除、駐防隊遣返` : `🚩 你和控制點 #${cp.no} 的佔領者成為敵對：你的防禦建築已拆除、駐防隊撤回`, 'danger');
    }
  }

  // ================= 三大勢力的行動 =================

  /** v15.8：這個遊戲日是不是這個勢力的進攻日（每 NPC_DAY_SLOW 天一次、勢力之間錯開；控制點多的勢力間隔再加倍） */
  static turnDay(f, day, ownCount = 0) {
    const every = NPC_DAY_SLOW * (ownCount >= FACTION_SLOW_AT ? 2 : 1);
    return (day + FACTION_KEYS.indexOf(f)) % every === 0;
  }

  /** 勢力今天的進攻時間（遊戲時間 hour 點） */
  turnTime(f, now = Date.now()) {
    const t = this.game.time;
    const h = t.totalHours(now);
    const day0 = Math.floor(h / 24) * 24;
    return now - ((h - day0 - FACTIONS[f].hour) / 24) * TimeSystem.dayMs(now);
  }

  /**
   * 勢力挑選進攻目標：只打和自己相鄰的控制點（沒有控制點時從大本營旁邊開始），
   * 優先：無人駐守 → 守軍戰力最弱 → 離大本營最近。中立、其他勢力、玩家的控制點都可能被打。
   */
  pickTarget(f, now = Date.now()) {
    const own = this.factionCps(f);
    const near = new Set(own.length ? own.flatMap((id) => cpNeighbors(id)) : hqNeighbors(f));
    own.forEach((id) => near.delete(id));
    // v16.1：剛被打下（保護期內）的控制點，勢力不會選它
    [...near].forEach((id) => { if (this.shielded(id, now)) near.delete(id); });
    const hq = this.hqLatLon(f);
    const list = [...near].map((id) => {
      const cp = cpById(id);
      const guarded = this.owners(id).length > 0 && !this.factionOf(id) && this.guardsAt(id, now).length > 0;
      return { id, guarded, power: this.defensePower(id, now), dist: haversine(cp.lat, cp.lon, hq.lat, hq.lon) };
    });
    if (!list.length) return null;
    list.sort((a, b) => (a.guarded - b.guarded) || (a.power - b.power) || (a.dist - b.dist));
    return list[0].id;
  }

  /** v16.1：剛被打下（玩家或勢力佔領）1 小時內的控制點：剩餘保護時間（毫秒，0＝沒有保護） */
  shieldLeft(id, now = Date.now()) {
    const d = this.data(id);
    if (!(CP_SHIELD.ms > 0) || !d?.takenAt || !((d.owners || []).length || d.faction)) return 0;
    // 不超過保護期本身（各玩家的時鐘略有誤差時也不會多出來）
    return Math.min(CP_SHIELD.ms, Math.max(0, d.takenAt + CP_SHIELD.ms - now));
  }

  shielded(id, now = Date.now()) {
    return this.shieldLeft(id, now) > 0;
  }

  /** v15.10：勢力進攻部隊的強度倍率（勢力控制點越多越強） */
  forceScale(f) {
    const c = FACTION_FORCE_SCALE;
    return Math.min(c.max, Math.max(c.min, 1 + (this.factionCps(f).length - c.base) * c.step));
  }

  hqLatLon(f) {
    return factionHq(f);
  }

  /** v17 進攻部隊：左側 30 萬、右側 60 萬 × 勢力控制點數加成（最多 ×1.4） */
  attackForce(f, id) {
    const cp = cpById(id);
    const n = CP_GARRISON.attackN;
    const each = (CP_POWER.attack[cp.side] * this.forceScale(f)) / n;
    const lv = CP_LEVEL[cp.side];
    return Array.from({ length: n }, (_, i) => {
      const e = this.scaledEnemy(i === 0 ? 'raiderChief' : 'raider', lv, each);
      return {
        id: `fx:${f}:${i}`, ally: { player: `npc:${f}`, i }, name: `${FACTIONS[f].name}${e.name}`,
        maxHp: e.maxHp, hp: e.maxHp, atk: e.atk, def: e.def || 0,
        crit: e.crit || 0.05, critDmg: e.critDmg || 1.5, dodge: e.dodge || 0.02, atkSpeed: e.atkSpeed || 1, level: lv, skills: {}, lifeSteal: 0,
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
      // v15.8：進攻次數減半（每 NPC_DAY_SLOW 個遊戲日一次，三個勢力錯開）；控制點多的勢力再減半
      if (!ControlPointSystem.turnDay(f, day, own.length)) continue;
      if ((this.lastTurn || {})[f] === day) continue;
      this.busy.add(`turn:${f}`);
      try {
        // eslint-disable-next-line no-await-in-loop
        const lock = await g.shared.update(CP_TURN_KIND, f, (x) => (x?.day === day ? { fail: 'done' } : { data: { day, at: now } }));
        this.lastTurn = { ...(this.lastTurn || {}), [f]: day };
        if (!lock.ok) continue;
        const target = this.pickTarget(f, at);
        if (!target) continue;
        // v15.10：現實凌晨（台灣時間 00:00～08:00）：三個勢力加起來每 3 小時最多進攻一次（共用紀錄，所有玩家判斷一致）
        const to = this.markerSpot(target);
        if (npcQuietSpan(at, at + ControlPointSystem.marchMs(this.marchFrom(f, to), to))) {
          // eslint-disable-next-line no-await-in-loop
          const nl = await g.shared.update(CP_TURN_KIND, 'night', (x) => (x?.at && at - x.at < NPC_QUIET.gapMs ? { fail: 'gap' } : { data: { at } }));
          if (!nl.ok) continue;
        }
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

  /**
   * v15.7：地圖左上角的紅色威脅訊息（同 NPC 攻打避難所）：
   * 勢力部隊正前往自己佔領／駐防的控制點、大本營部隊正前往自己的探索隊。
   * @returns {{text:string, at:number, lat:number, lon:number}[]}
   */
  incoming(now = Date.now()) {
    const out = [];
    const me = this.myId();
    CONTROL_POINTS.forEach((cp) => {
      const m = this.data(cp.id)?.march;
      if (!m || now >= m.arriveAt) return;
      const owner = this.owners(cp.id).some((o) => o.p === me);
      const guard = (this.data(cp.id)?.guards || []).some((h) => h.p === me);
      const intel = this.marchIntel(m, cp.id);
      if (!owner && !guard && !intel) return;
      const at = this.markerSpot(cp.id);
      // 不是自己的控制點（偵查 Lv13 才看得到）：文字精簡
      let text = `勢力「${FACTIONS[m.f]?.name || ''}」部隊${intel} → 控制點 #${cp.no}`;
      if (!owner && !guard) {
        const force = this.attackForce(m.f, cp.id);
        const pw = force.reduce((s, u) => s + unitPower(u), 0);
        text = `${FACTIONS[m.f]?.name || ''}${force.length}人⚔${pw >= 10000 ? `${(pw / 10000).toFixed(1)}萬` : Math.round(pw)} → #${cp.no}`;
      }
      out.push({ text, at: m.arriveAt, lat: at.lat, lon: at.lon, mine: owner || guard });
    });
    this.game.state.expeditions.forEach((e) => {
      const a = e.hqAmbush;
      if (!a || a.done || e.recalled || now >= a.hitAt) return;
      out.push({ text: `${FACTIONS[a.f]?.name || ''}大本營部隊 → 探索點「${this.game.exploration.poi(e.poiId)?.name || ''}」`, at: a.hitAt, lat: a.to.lat, lon: a.to.lon });
    });
    return out.sort((a, b) => a.at - b.at);
  }

  /** v15.10：偵查 Lv13：勢力進攻部隊的人數與戰力（看得到所有控制點的行軍） */
  marchIntel(m, id) {
    if ((this.game.npcs?.intel?.() || 0) < 13) return '';
    const force = this.attackForce(m.f, id);
    return `（${force.length} 人・戰力 ${Math.round(force.reduce((s, u) => s + unitPower(u), 0)).toLocaleString()}）`;
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
      const intel = this.marchIntel(m, cp.id);
      if (!owner && !guard && !intel) return;
      const key = `${cp.id}:${m.arriveAt}`;
      if (this.warned.has(key)) return;
      this.warned.add(key);
      const min = Math.max(1, Math.round((m.arriveAt - now) / 60000));
      // v15.10：偵查 Lv13：其他控制點的行軍也會記在事件紀錄（不跳提醒）
      if (!owner && !guard) {
        this.game.log(`🔭 偵查：勢力「${FACTIONS[m.f]?.name || ''}」的部隊${intel}正前往控制點 #${cp.no}（約 ${min} 分鐘後抵達）`, 'info');
        return;
      }
      const role = owner && guard ? '你佔領並駐防的' : owner ? '你佔領的' : '你駐防的';
      const msg = `⚔️ 勢力「${FACTIONS[m.f]?.name || ''}」的部隊${intel}正前往${role}控制點 #${cp.no}（約 ${min} 分鐘後抵達）${owner && !guard ? '，可以派人駐防' : ''}`;
      this.game.log(msg, 'danger');
      this.game.toast?.(msg, 'danger');
    });
  }

  /**
   * （v15.4～v15.8：探索點在鄰接大本營的控制點時，大本營可能派部隊襲擊；v15.8.1 移除）
   * 移動時間比照攻打玩家避難所；部隊抵達時隊伍還在那裡搜索才交戰（先撤回就能躲開）。
   */
  hqAmbushes() {
    // v15.8.1：移除大本營伏擊探索隊：不再派出部隊；舊版本已派出、還沒抵達的部隊直接取消
    this.game.state.expeditions.forEach((e) => {
      if (e.hqAmbush && !e.hqAmbush.done) e.hqAmbush = null;
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
    // v16.1：部隊抵達時控制點剛被別人打下（保護期內）：撲空返回
    if (this.shielded(id, at)) return { win: false, ok: false, shielded: true };
    const foes = this.defenders(id, at);
    const attackers0 = this.attackForce(f, id);
    // v17：先攻打玩家的路障（防禦建築射擊），打破後才和駐防隊交戰
    const as = this.assault(id, attackers0, at);
    const attackers = as.breached ? as.alive : [];
    const r = attackers.length ? g.combat.simulate([], foes, { allies: attackers, record: false, capture: 60, title: `🏴 「${FACTIONS[f].name}」進攻控制點 #${cp.no}` })
      : { victory: false, foes: foes.map((x) => ({ id: x.id, ally: x.ally, down: false })), team: attackers0.map((u) => ({ id: u.id, down: true })) };
    const win = attackers.length > 0 && (!!r.victory || !foes.length);
    const killed = r.foes.filter((x) => x.down).length;
    const downIds = new Set(r.foes.filter((x) => x.down).map((x) => x.ally?.player).filter(Boolean));
    const res = await g.shared.update(CP_KIND, id, (x) => {
      const data = x || { owners: [], guards: [], faction: defaultFaction(cp) };
      // v15.6：交戰結果記在共用資料，佔領者與駐防者（不在線也一樣）之後都會收到戰報
      const fight = {
        f, at, win, lost: killed, total: foes.length, atk: attackers0.length, ...(as.df.wall || as.df.dps ? { wall: { sec: as.sec, killed: attackers0.length - (as.breached ? as.alive.length : 0), breached: !!as.breached } } : {}), atkDown: (r.team || []).filter((u) => u.down).length,
        owners: (data.owners || []).map((o) => o.p), guards: [...new Set((data.guards || []).filter((h) => !(h.arr > at)).map((h) => h.p))],
        down: [...downIds],
        // v15.7：倒下的駐防隊員（駐防隊 id:第幾位），沒倒下的人防守成功時拿經驗
        downU: r.foes.filter((x) => x.down && x.ally?.e).map((x) => `${x.ally.e}:${x.ally.i}`).slice(0, 60),
        ge: [...new Set((data.guards || []).filter((h) => !(h.arr > at)).map((h) => h.e).filter(Boolean))].slice(0, 30),
        // v15.10：戰鬥明細（佔領者與駐防者都看得到）
        ...(r.entry ? { battle: ControlPointSystem.fitBattle(r.entry) } : {}),
      };
      if (win) {
        // 打下後留守：守軍約為進攻部隊的一半（之後每小時補回）
        // v17：打下後留守 70 萬起（滿編 90 萬，每 10 分鐘補 1 人）
        const full = CP_GARRISON.npc;
        return { data: { owners: [], guards: [], bld: {}, faction: f, lost: full - Math.round((CP_POWER.npc.start / CP_POWER.npc.full) * full), lostAt: at, takenAt: at, by: f, fight } };
      }
      data.fight = fight;
      if (data.owners?.length && !data.faction) data.guards = (data.guards || []).filter((h) => !downIds.has(h.p));
      else { const full = this.garrisonFull(id); data.lost = Math.min(full, (full - this.garrisonCount(id, at)) + killed); data.lostAt = at; }
      return { data };
    }, { lat: cp.lat, lon: cp.lon });
    if (res.ok && win) {
      g.log(`🏴 勢力「${FACTIONS[f].name}」佔領了控制點 #${cp.no}`, 'danger');
      // v15.14：控制點數達到門檻時蓋新的勢力據點
      await g.npcs?.factionBuild?.(f, at);
    }
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
      // v15.8：交戰時還在路上的駐防隊也要知道控制點被攻下了
      const mine = g.state.expeditions.filter((e) => e.kind === 'cpGuard' && e.cpId === cp.id && e.startAt <= ft.at);
      const enRoute = ft.win && mine.some((e) => !this.guardFought(e, ft));
      if (!owner && !guard && !enRoute) return;
      const who = ControlPointSystem.fightWho(ft);
      const role = owner && guard ? '你佔領並駐防的' : owner ? '你佔領的' : '你駐防的';
      const msg = ft.win
        ? `🏴 ${who}（${ft.atk} 人）攻下了${role}控制點 #${cp.no}${ft.total ? `：守軍 ${ft.total} 人全數被擊倒` : '（沒有駐防）'}`
        : `🛡️ ${role}控制點 #${cp.no} 擊退了${who}（${ft.atk} 人）：擊倒 ${ft.atkDown || 0} 人，守軍倒下 ${ft.lost || 0} 人${(ft.down || []).includes(me) ? '（你的駐防隊有人倒下，撤回避難所）' : ''}`;
      const text = !owner && !guard ? this.lostReason(mine.find((e) => !this.guardFought(e, ft))) : msg;
      g.log(text, ft.win ? 'danger' : 'success');
      g.toast?.(text, ft.win ? 'danger' : 'success');
      // v15.9：控制點交戰戰報另外記在「消息 → 🚩 控制點」
      // v15.14：沒有玩家駐防的控制點不出詳細戰報（事件紀錄與提示照常）
      if ((ft.guards || []).length) {
        const logEntry = { id: `cpf:${cp.id}:${ft.at}`, at: ft.at, no: cp.no, win: !!ft.win, text };
        if (ft.battle) g.combat.adopt?.(ft.battle, logEntry);
        g.state.cpLog = [logEntry, ...(g.state.cpLog || [])].slice(0, 30);
      }
      // v15.8：交戰經過也寫進駐防隊的探索報告（回到避難所時看得到）
      mine.forEach((e) => {
        const line = ft.win ? this.lostReason(e) : this.guardFought(e, ft) ? msg : null;
        if (!line) return;
        if (!(e.travelEvents || []).includes(line)) e.travelEvents = [...(e.travelEvents || []), line];
        if (ft.battle && this.guardFought(e, ft)) g.combat.adopt?.(ft.battle, e);
      });
      if (!ft.win && guard && ft.f) this.guardXp(cp, ft); // 防守經驗只限擊退勢力部隊（v15.7 規則）
    });
  }

  /** v15.7：防守成功：沒倒下的駐防隊員獲得自己升級所需經驗的 CP_GUARD_XP_PCT（倒下的人不扣經驗） */
  guardXp(cp, ft) {
    const g = this.game;
    const down = new Set(ft.downU || []);
    const got = [];
    // 參戰的駐防隊（交戰時在共用資料裡的隊伍）
    g.state.expeditions.filter((e) => e.kind === 'cpGuard' && e.cpId === cp.id && this.guardFought(e, ft)).forEach((e) => {
      e.memberIds.forEach((sid, i) => {
        const sv = g.survivors.get(sid);
        if (!sv || sv.severe || down.has(`${e.id}:${i}`)) return;
        const amt = Math.round(xpToNext(sv.level) * CP_GUARD_XP_PCT);
        if (amt <= 0) return;
        g.survivors.gainXp(sv, amt);
        got.push(`${sv.name} +${amt.toLocaleString()}`);
      });
    });
    if (got.length) g.log(`⭐ 控制點 #${cp.no} 防守成功經驗：${got.join('、')}`, 'success');
    return got.length;
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
    this.syncBldTech().catch(() => {});
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
    const guards = this.guardsAt(id, now);
    const fac = this.factionOf(id);
    const label = { mine: '你與好友佔領・可探索', hostile: '敵對玩家佔領・不可探索', other: '其他玩家佔領・可探索', faction: `${FACTIONS[fac]?.name || ''}勢力佔領・不可探索`, neutral: '中立（感染者佔據）・可探索' }[s];
    return {
      cp, status: s, label, owners: own, guards, garrison: s === 'neutral' || s === 'faction' ? this.garrisonCount(id, now) : guards.reduce((a, h) => a + (h.units || []).length, 0),
      nextIncome: formatDuration(Math.max(0, this.incomeTime(now) + (now >= this.incomeTime(now) ? TimeSystem.dayMs(now) : 0) - now)),
    };
  }
}
