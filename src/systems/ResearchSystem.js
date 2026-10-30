import {
  RESEARCH, labLevelFor, researchCost, researchTime,
} from '../config/research.js';
import { canAfford, payCost } from './costUtils.js';

/**
 * 研究系統：一次進行一項研究；每項科技都有等級，效果隨等級累加。
 * 狀態：research.levels = { 科技ID: 等級 }，research.active = { id, level, startAt, endAt }。
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

  /** @returns {{ok:boolean, reason?:string}} */
  canStart(id) {
    const def = RESEARCH[id];
    if (!def) return { ok: false, reason: '未知研究' };
    const next = this.level(id) + 1;
    if (next > def.maxLevel) return { ok: false, reason: '已達最高等級' };
    if (this.state.active) return { ok: false, reason: '已有研究進行中' };
    const lab = labLevelFor(id, next);
    if (this.labLevel() < lab) return { ok: false, reason: `需要研究中心 Lv${lab}` };
    const missing = def.requires.find(([rid, lv]) => this.level(rid) < lv);
    if (missing) return { ok: false, reason: `需先將「${RESEARCH[missing[0]].name}」研究到 Lv${missing[1]}` };
    if (!canAfford(this.game.state, this.cost(id, next))) return { ok: false, reason: '資源不足' };
    return { ok: true };
  }

  start(id) {
    const check = this.canStart(id);
    if (!check.ok) return check;
    const level = this.level(id) + 1;
    payCost(this.game.state, this.cost(id, level));
    this.state.active = {
      id, level, startAt: Date.now(), endAt: Date.now() + this.researchTime(id, level) * 1000,
    };
    this.game.log(`開始研究「${RESEARCH[id].name}」Lv${level}`, 'info');
    return { ok: true, msg: `開始研究「${RESEARCH[id].name}」Lv${level}` };
  }

  update(now) {
    const active = this.state.active;
    if (!active || now < active.endAt) return;
    this.state.levels[active.id] = Math.max(this.level(active.id), active.level || 1);
    this.state.active = null;
    this.invalidate();
    this.game.state.stats.researchDone += 1;
    const name = `${RESEARCH[active.id].name} Lv${this.level(active.id)}`;
    this.game.log(`🔬 研究完成：「${name}」`, 'success');
    this.game.toast(`研究完成：${name}`, 'success');
  }
}
