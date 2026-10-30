import { RESEARCH, requiredLabLevel } from '../config/research.js';
import { canAfford, payCost } from './costUtils.js';

/**
 * 研究系統：一次進行一項研究，完成後效果永久累加。
 */
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

  /** 彙總所有已完成研究的效果 */
  bonuses() {
    if (this._cache) return this._cache;
    const sum = { unlock: new Set() };
    this.state.completed.forEach((id) => {
      const fx = RESEARCH[id]?.effects || {};
      Object.entries(fx).forEach(([k, v]) => {
        if (k === 'unlock') v.forEach((u) => sum.unlock.add(u));
        else sum[k] = (sum[k] || 0) + v;
      });
    });
    this._cache = sum;
    return sum;
  }

  bonus(key) {
    return this.bonuses()[key] || 0;
  }

  isDone(id) {
    return this.state.completed.includes(id);
  }

  hasUnlock(flag) {
    return this.bonuses().unlock.has(flag);
  }

  labLevel() {
    return this.game.state.shelter.facilities.researchCenter.level;
  }

  /** 研究時間（秒）受研究中心等級加速 */
  researchTime(id) {
    const speed = 1 + this.labLevel() * 0.1;
    return Math.round(RESEARCH[id].time / speed);
  }

  /** @returns {{ok:boolean, reason?:string}} */
  canStart(id) {
    const def = RESEARCH[id];
    if (!def) return { ok: false, reason: '未知研究' };
    if (this.isDone(id)) return { ok: false, reason: '已完成' };
    if (this.state.active) return { ok: false, reason: '已有研究進行中' };
    if (this.labLevel() < requiredLabLevel(def.tier)) {
      return { ok: false, reason: `需要研究中心 Lv${requiredLabLevel(def.tier)}` };
    }
    const missing = (def.requires || []).filter((r) => !this.isDone(r));
    if (missing.length) return { ok: false, reason: `需先完成「${RESEARCH[missing[0]].name}」` };
    if (!canAfford(this.game.state, def.cost)) return { ok: false, reason: '資源不足' };
    return { ok: true };
  }

  start(id) {
    const check = this.canStart(id);
    if (!check.ok) return check;
    payCost(this.game.state, RESEARCH[id].cost);
    this.state.active = { id, startAt: Date.now(), endAt: Date.now() + this.researchTime(id) * 1000 };
    this.game.log(`開始研究「${RESEARCH[id].name}」`, 'info');
    return { ok: true };
  }

  update(now) {
    const active = this.state.active;
    if (!active || now < active.endAt) return;
    this.state.completed.push(active.id);
    this.state.active = null;
    this.invalidate();
    this.game.state.stats.researchDone += 1;
    this.game.log(`🔬 研究完成：「${RESEARCH[active.id].name}」`, 'success');
    this.game.toast(`研究完成：${RESEARCH[active.id].name}`, 'success');
  }
}
