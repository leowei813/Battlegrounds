import { cancelRefund } from './ShelterSystem.js';
import {
  RESEARCH, labLevelFor, researchCost, researchTime,
} from '../config/research.js';
import { canAfford, payCost } from './costUtils.js';

/**
 * 研究系統：一次進行一項研究；每項科技都有等級，效果隨等級累加。
 * 狀態：research.levels = { 科技ID: 等級 }，research.active = { id, level, startAt, endAt }，
 * research.queue = [{ id, level, cost }]：排隊中的研究（加入時已扣材料，依序自動開始）。
 */
/** 研究中心這個等級起可以同時進行兩項研究 */
export const PARALLEL_LAB = 10;

export class ResearchSystem {
  constructor(game) {
    this.game = game;
    this._cache = null;
  }

  get state() {
    return this.game.state.research;
  }

  invalidate() {
    this._cache = null;
  }

  level(id) {
    return this.state.levels[id] || 0;
  }

  /** 彙總所有科技的效果（每級效果 × 等級） */
  bonuses() {
    if (this._cache) return this._cache;
    const sum = { unlock: new Set() };
    Object.entries(this.state.levels).forEach(([id, lv]) => {
      const def = RESEARCH[id];
      if (!def || lv <= 0) return;
      Object.entries(def.effects).forEach(([k, v]) => { sum[k] = (sum[k] || 0) + v * lv; });
      def.unlock.forEach((u) => sum.unlock.add(u));
    });
    this._cache = sum;
    return sum;
  }

  bonus(key) {
    return this.bonuses()[key] || 0;
  }

  /** 至少研究到第 1 級 */
  isDone(id) {
    return this.level(id) > 0;
  }

  hasUnlock(flag) {
    return this.bonuses().unlock.has(flag);
  }

  labLevel() {
    return this.game.shelter.maxLevel('researchCenter');
  }

  /** 研究時間（秒）受研究中心等級加速 */
  researchTime(id, level = this.level(id) + 1) {
    const speed = 1 + this.labLevel() * 0.1;
    return Math.round(researchTime(id, level) / speed);
  }

  cost(id, level = this.level(id) + 1) {
    return researchCost(id, level);
  }

  get queue() {
    if (!Array.isArray(this.state.queue)) this.state.queue = [];
    return this.state.queue;
  }

  /** 研究佇列格數（含研究中的項目）：研究中心 Lv1 有 1 格，每 5 級多 1 格；Lv10 起的第二研究位再多 1 格 */
  slots(lab = this.labLevel()) {
    return lab > 0 ? 1 + Math.floor(lab / 5) + (this.parallel(lab) > 1 ? 1 : 0) : 0;
  }

  /** 可以同時進行的研究數：研究中心 Lv10 起 2 項 */
  parallel(lab = this.labLevel()) {
    return lab >= PARALLEL_LAB ? 2 : 1;
  }

  /** 研究中的項目：[{ key: 'active'|'active2', a }] */
  actives() {
    return ['active', 'active2'].filter((k) => this.state[k]).map((k) => ({ key: k, a: this.state[k] }));
  }

  /** 空著的研究位（沒有則 null） */
  freeSlot() {
    if (!this.state.active) return 'active';
    if (this.parallel() > 1 && !this.state.active2) return 'active2';
    return null;
  }

  /** 已佔用的格數 */
  used() {
    return this.actives().length + this.queue.length;
  }

  /** 這一項現在可以開始嗎：沒有同一科技正在研究、前置科技已完成、等級剛好是下一級 */
  ready(q) {
    const def = RESEARCH[q.id];
    if (!def) return false;
    if (this.actives().some(({ a }) => a.id === q.id)) return false;
    if (q.level !== this.level(q.id) + 1) return false;
    return def.requires.every(([rid, need]) => this.level(rid) >= need);
  }

  /** 把佇列中第一個可以開始的項目放進空著的研究位 */
  fill(at) {
    let key = this.freeSlot();
    while (key) {
      const i = this.queue.findIndex((q) => this.ready(q));
      if (i < 0) return;
      const [next] = this.queue.splice(i, 1);
      this.begin(next, at, key);
      this.game.log(`開始研究「${RESEARCH[next.id].name}」Lv${next.level}（研究佇列${key === 'active2' ? '・研究位 2' : ''}）`, 'info');
      key = this.freeSlot();
    }
  }

  /** 排到佇列最後時的等級（含研究中與排隊中的） */
  plannedLevels() {
    const lv = { ...this.state.levels };
    this.actives().forEach(({ a }) => { lv[a.id] = Math.max(lv[a.id] || 0, a.level); });
    this.queue.forEach((q) => { lv[q.id] = Math.max(lv[q.id] || 0, q.level); });
    return lv;
  }

  plannedLevel(id) {
    return this.plannedLevels()[id] || 0;
  }

  /**
   * 能否開始研究，或加入佇列（以佇列全部完成後的等級判斷前置與下一級）
   * @returns {{ok:boolean, reason?:string, queued?:boolean}}
   */
  canStart(id) {
    const def = RESEARCH[id];
    if (!def) return { ok: false, reason: '未知研究' };
    const planned = this.plannedLevels();
    const next = (planned[id] || 0) + 1;
    if (next > def.maxLevel) return { ok: false, reason: '已達最高等級' };
    // 有空著的研究位、而且這項現在就能開始（同一科技沒有在研究、前置已完成）：直接開始；否則加入佇列
    const free = this.freeSlot();
    const queued = !free || !this.ready({ id, level: next });
    if (queued && this.used() >= this.slots()) return { ok: false, reason: `研究佇列已滿（${this.used()}/${this.slots()}）` };
    const lab = labLevelFor(id, next);
    if (this.labLevel() < lab) return { ok: false, reason: `需要研究中心 Lv${lab}` };
    const missing = def.requires.find(([rid, lv]) => (planned[rid] || 0) < lv);
    if (missing) return { ok: false, reason: `需先將「${RESEARCH[missing[0]].name}」研究到 Lv${missing[1]}` };
    if (!canAfford(this.game.state, this.cost(id, next))) return { ok: false, reason: '資源不足' };
    return { ok: true, queued };
  }

  /** 開始研究；已有研究進行中時加入佇列（加入時就扣除材料） */
  start(id) {
    const check = this.canStart(id);
    if (!check.ok) return check;
    const level = this.plannedLevel(id) + 1;
    const cost = this.cost(id, level);
    payCost(this.game.state, cost);
    if (check.queued) {
      this.queue.push({ id, level, cost });
      const n = this.used();
      this.game.log(`📋 加入研究佇列第 ${n} 項：「${RESEARCH[id].name}」Lv${level}`, 'info');
      return { ok: true, msg: `已加入研究佇列第 ${n} 項：${RESEARCH[id].name} Lv${level}（已扣除材料）` };
    }
    const key = this.freeSlot();
    this.begin({ id, level, cost }, Date.now(), key);
    this.game.log(`開始研究「${RESEARCH[id].name}」Lv${level}${key === 'active2' ? '（研究位 2）' : ''}`, 'info');
    return { ok: true, msg: `開始研究「${RESEARCH[id].name}」Lv${level}` };
  }

  begin(q, at, key = 'active') {
    this.state[key] = {
      id: q.id, level: q.level, startAt: at, endAt: at + this.researchTime(q.id, q.level) * 1000, cost: q.cost,
    };
  }

  /** 排隊中項目預估的開始時間（毫秒時間戳） */
  queueStartAt(i, now = Date.now()) {
    // 依序由先空出的研究位接著做（估算）
    const free = Array.from({ length: this.parallel() }, (_, k) => {
      const a = this.state[k === 0 ? 'active' : 'active2'];
      return a ? a.endAt : now;
    });
    let t = now;
    for (let k = 0; k <= i; k += 1) {
      const j = free.indexOf(Math.min(...free));
      t = Math.max(now, free[j]);
      if (k < i) free[j] = t + this.researchTime(this.queue[k].id, this.queue[k].level) * 1000;
    }
    return t;
  }

  /** 依序檢查佇列是否合理：同一科技等級連續、前置與研究中心等級都滿足 */
  validOrder(queue) {
    const lv = { ...this.state.levels };
    this.actives().forEach(({ a }) => { lv[a.id] = Math.max(lv[a.id] || 0, a.level); });
    return queue.every((q) => {
      const def = RESEARCH[q.id];
      if (!def || q.level !== (lv[q.id] || 0) + 1) return false;
      if (def.requires.some(([rid, need]) => (lv[rid] || 0) < need)) return false;
      lv[q.id] = q.level;
      return true;
    });
  }

  /** 調整排隊順序（dir：-1 往前、1 往後） */
  move(i, dir) {
    const q = [...this.queue];
    const j = i + dir;
    if (i < 0 || j < 0 || i >= q.length || j >= q.length) return { ok: false, reason: '無法移動' };
    [q[i], q[j]] = [q[j], q[i]];
    if (!this.validOrder(q)) return { ok: false, reason: '順序不合理：同一項科技要依等級排，前置科技要排在前面' };
    this.state.queue = q;
    return { ok: true };
  }

  /** 取消排隊中的項目：全額退還；依賴它的後續項目一併取消退還 */
  cancelQueued(i) {
    if (i < 0 || i >= this.queue.length) return { ok: false, reason: '找不到這個項目' };
    const removed = this.queue.splice(i, 1);
    // 之後不再合理的項目（例如同一科技的更高等級、以它為前置的科技）一併取消
    let keep = [...this.queue];
    while (keep.length && !this.validOrder(keep)) {
      const bad = keep.findIndex((_, k) => !this.validOrder(keep.slice(0, k + 1)));
      removed.push(...keep.splice(bad, 1));
    }
    this.state.queue = keep;
    removed.forEach((q) => this.game.grant(q.cost));
    const names = removed.map((q) => `${RESEARCH[q.id].name} Lv${q.level}`);
    this.game.log(`🚫 取消研究佇列：${names.join('、')}，材料全額退還`, 'info');
    return { ok: true, msg: `已取消「${names.join('、')}」，材料全額退還`, removed };
  }

  /** 搬遷等情況：取消研究中與所有排隊中的研究（研究中依完成度退還，排隊中全額退還） */
  cancelAll(now = Date.now()) {
    this.queue.splice(0).forEach((q) => this.game.grant(q.cost));
    if (this.state.active2) this.cancel(now, { promote: false, key: 'active2' });
    if (this.state.active) this.cancel(now, { promote: false });
  }

  /** 研究中心降級導致格數不足：超出的排隊項目取消並全額退還 */
  trimQueue() {
    // 研究中心降級到 Lv10 以下：第二研究位的研究移回佇列最前面（已扣材料、進度不保留）
    if (this.state.active2 && this.parallel() < 2) {
      const a = this.state.active2;
      this.state.active2 = null;
      this.queue.unshift({ id: a.id, level: a.level, cost: a.cost });
    }
    const extra = this.used() - Math.max(this.slots(), this.actives().length);
    if (extra <= 0 || !this.queue.length) return;
    const removed = this.queue.splice(Math.max(0, this.queue.length - extra));
    removed.forEach((q) => this.game.grant(q.cost));
    this.game.log(`📋 研究中心等級降低，佇列格數不足：取消${removed.map((q) => `「${RESEARCH[q.id].name} Lv${q.level}」`).join('、')}並全額退還材料`, 'info');
  }

  /** 取消研究：依完成度退還材料（完成度越高退得越少） */
  cancel(now = Date.now(), { promote = true, key = 'active' } = {}) {
    const a = this.state[key];
    if (!a) return { ok: false, reason: '目前沒有研究' };
    const refund = cancelRefund(a, now, () => this.cost(a.id, a.level));
    this.state[key] = null;
    this.game.grant(refund.cost);
    this.game.log(`🚫 取消研究「${RESEARCH[a.id].name}」Lv${a.level}，退還 ${Math.round(refund.ratio * 100)}% 材料`, 'info');
    // 依賴它的排隊項目（同一科技更高等級、以它為前置）取消並全額退還；其餘依序開始下一項
    let extra = '';
    if (promote && this.queue.length) {
      const keep = [...this.queue];
      const removed = [];
      while (keep.length && !this.validOrder(keep)) {
        const bad = keep.findIndex((_, k) => !this.validOrder(keep.slice(0, k + 1)));
        removed.push(...keep.splice(bad, 1));
      }
      this.state.queue = keep;
      removed.forEach((q) => this.game.grant(q.cost));
      if (removed.length) extra = `；${removed.map((q) => `${RESEARCH[q.id].name} Lv${q.level}`).join('、')}一併取消並全額退還`;
      this.fill(now);
    }
    return { ok: true, msg: `已取消研究，退還約 ${Math.round(refund.ratio * 100)}% 材料${extra}` };
  }

  update(now) {
    this.trimQueue();
    // 離線期間也依序完成：哪一項先結束，就由那個研究位接佇列中第一項（開始時間＝上一項完成的時間）
    let guard = 0;
    for (;;) {
      const done = this.actives().filter(({ a }) => now >= a.endAt).sort((x, y) => x.a.endAt - y.a.endAt)[0];
      if (!done || guard >= 100) break;
      guard += 1;
      const { key, a: active } = done;
      this.state.levels[active.id] = Math.max(this.level(active.id), active.level || 1);
      this.state[key] = null;
      this.invalidate();
      this.game.state.stats.researchDone += 1;
      // 剛完成：卡片與分支標示 NEW，玩家看過後才消失
      this.state.fresh = { ...(this.state.fresh || {}), [active.id]: { level: this.level(active.id), at: now } };
      const name = `${RESEARCH[active.id].name} Lv${this.level(active.id)}`;
      this.game.log(`🔬 研究完成：「${name}」`, 'success');
      this.game.toast(`研究完成：${name}`, 'success');
      this.fill(active.endAt);
    }
    // 研究中心剛升到 Lv10：第二研究位立刻接佇列
    if (this.freeSlot() && this.queue.length) this.fill(now);
  }
}
