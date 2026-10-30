import { DAY_REAL_MS, START_HOUR } from '../config/constants.js';
import { TIME_PHASES, phaseForHour } from '../config/timePhases.js';

/**
 * 日夜系統：時間完全由「建檔時間」推導，因此不需額外存檔，
 * 離線回來時也能正確計算當下時段。
 */
export class TimeSystem {
  constructor(game) {
    this.game = game;
  }

  /** 遊戲經過的總小時數（含起始偏移） */
  totalHours(at = Date.now()) {
    const elapsed = at - this.game.state.createdAt;
    return START_HOUR + (elapsed / DAY_REAL_MS) * 24;
  }

  day(at = Date.now()) {
    return Math.floor(this.totalHours(at) / 24) + 1;
  }

  hour(at = Date.now()) {
    return this.totalHours(at) % 24;
  }

  phaseId(at = Date.now()) {
    return phaseForHour(this.hour(at));
  }

  phase(at = Date.now()) {
    return TIME_PHASES[this.phaseId(at)];
  }

  clockText(at = Date.now()) {
    const h = this.hour(at);
    const hh = Math.floor(h);
    const mm = Math.floor((h - hh) * 60);
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  }

  /**
   * 夜間懲罰經研究減免後的探索速度倍率
   */
  exploreSpeedMul(at = Date.now()) {
    const p = this.phase(at);
    if (p.exploreSpeed >= 1) return p.exploreSpeed;
    const reduce = this.game.research.bonus('nightPenaltyReduce');
    return 1 - (1 - p.exploreSpeed) * (1 - reduce);
  }
}
