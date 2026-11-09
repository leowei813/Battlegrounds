import {
  DAY_REAL_MS, DAY_REAL_MS_OLD, DAY_SWITCH_AT, WORLD_EPOCH_MS, WORLD_START,
} from '../config/constants.js';
import { TIME_PHASES, phaseForHour } from '../config/timePhases.js';

/**
 * 日夜系統（v9：世界時間）：所有玩家共用同一個日曆，從 WORLD_EPOCH_MS（2050/1/1 06:00）起算，
 * 遊戲一天＝現實 90 分鐘（v15.7 之前 1 小時），大家的時間、日夜都相同。生存天數另外從自己的開局時間起算。
 */
export class TimeSystem {
  constructor(game) {
    this.game = game;
  }

  /** 遊戲經過的總小時數（含起始偏移） */
  totalHours(at = Date.now()) {
    // worldShift 只在測試時用來調整時刻
    return TimeSystem.hoursAt(at + (this.game.state.worldShift || 0));
  }

  /**
   * 現實時間 → 遊戲經過的總小時數。v15.7：DAY_SWITCH_AT 之前一天 60 分鐘、之後一天 90 分鐘（接續計算，不會跳）。
   */
  /** 這個時刻遊戲一天的現實長度（毫秒） */
  static dayMs(t = Date.now()) {
    return t < Math.max(WORLD_EPOCH_MS, TimeSystem.switchAt) ? DAY_REAL_MS_OLD : DAY_REAL_MS;
  }

  static hoursAt(t) {
    const sw = Math.max(WORLD_EPOCH_MS, TimeSystem.switchAt);
    if (t <= sw) return WORLD_START.hour + ((t - WORLD_EPOCH_MS) / DAY_REAL_MS_OLD) * 24;
    return WORLD_START.hour + ((sw - WORLD_EPOCH_MS) / DAY_REAL_MS_OLD) * 24 + ((t - sw) / DAY_REAL_MS) * 24;
  }

  /** 世界日序（2050/1/1 為第 1 天） */
  day(at = Date.now()) {
    return Math.floor(this.totalHours(at) / 24) + 1;
  }

  /** 生存天數：從自己開局算起（第 1 天開始） */
  survivalDay(at = Date.now()) {
    const c = this.game.state.createdAt || at;
    return Math.max(1, Math.floor((TimeSystem.hoursAt(at) - TimeSystem.hoursAt(c)) / 24) + 1);
  }

  /** 世界日期（2050/1/1 起） */
  dateText(at = Date.now()) {
    const d = new Date(Date.UTC(WORLD_START.year, WORLD_START.month - 1, WORLD_START.day) + (this.day(at) - 1) * 86400000);
    return `${d.getUTCFullYear()}/${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
  }

  /** 夜晚編號：夜晚跨過午夜，以入夜那天計（20:00～隔天 06:00 為同一晚） */
  nightKey(at = Date.now()) {
    return this.day(at - (6 / 24) * TimeSystem.dayMs(at));
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
    return at + (hours / 24) * TimeSystem.dayMs(at);
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

/** 改為 90 分鐘一天的時刻（測試可改） */
TimeSystem.switchAt = DAY_SWITCH_AT;
