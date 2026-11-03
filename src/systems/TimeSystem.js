import { DAY_REAL_MS, WORLD_EPOCH_MS, WORLD_START } from '../config/constants.js';
import { TIME_PHASES, phaseForHour } from '../config/timePhases.js';

/**
 * 日夜系統（v9：世界時間）：所有玩家共用同一個日曆，從 WORLD_EPOCH_MS（2050/1/1 06:00）起算，
 * 遊戲一天＝現實 1 小時，大家的時間、日夜都相同。生存天數另外從自己的開局時間起算。
 */
export class TimeSystem {
  constructor(game) {
    this.game = game;
  }

  /** 遊戲經過的總小時數（含起始偏移） */
  totalHours(at = Date.now()) {
    // worldShift 只在測試時用來調整時刻
    const elapsed = at - WORLD_EPOCH_MS + (this.game.state.worldShift || 0);
    return WORLD_START.hour + (elapsed / DAY_REAL_MS) * 24;
  }

  /** 世界日序（2050/1/1 為第 1 天） */
  day(at = Date.now()) {
    return Math.floor(this.totalHours(at) / 24) + 1;
  }

  /** 生存天數：從自己開局算起（第 1 天開始） */
  survivalDay(at = Date.now()) {
    return Math.max(1, Math.floor((at - (this.game.state.createdAt || at)) / DAY_REAL_MS) + 1);
  }

  /** 世界日期（2050/1/1 起） */
  dateText(at = Date.now()) {
    const d = new Date(Date.UTC(WORLD_START.year, WORLD_START.month - 1, WORLD_START.day) + (this.day(at) - 1) * 86400000);
    return `${d.getUTCFullYear()}/${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
  }

  /** 夜晚編號：夜晚跨過午夜，以入夜那天計（20:00～隔天 06:00 為同一晚） */
  nightKey(at = Date.now()) {
    return this.day(at - (6 / 24) * DAY_REAL_MS);
  }

  hour(at = Date.now()) {
    return ((this.totalHours(at) % 24) + 24) % 24;
  }

  phaseId(at = Date.now()) {
    return phaseForHour(this.hour(at));
  }

  phase(at = Date.now()) {
    return TIME_PHASES[this.phaseId(at)];
  }

  /** 下一次天亮（06:00）的現實時間 */
  nextDawn(at = Date.now()) {
    const h = this.hour(at);
    const hours = h < 6 ? 6 - h : 30 - h;
    return at + (hours / 24) * DAY_REAL_MS;
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
