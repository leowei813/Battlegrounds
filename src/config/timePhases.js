/**
 * 日夜系統階段定義（遊戲內小時）。
 * exploreSpeed：探索時間倍率的倒數（>1 代表更快）
 * zombieMul：地圖殭屍數量與避難所襲擊頻率倍率
 * danger：敵人強度倍率
 * zombies：地圖上是否出現殭屍（地圖殭屍群與據點屍潮）。
 *          白天殭屍躲在建築內，只會在探索時遭遇。
 */
export const TIME_PHASES = {
  day: {
    name: '白天', icon: '☀️', exploreSpeed: 1.25, lootMul: 1.15, zombieMul: 1, danger: 1,
    special: false, overlay: 0, zombies: false, desc: '殭屍躲在建築內，地圖上安全，探索效率提升',
  },
  dusk: {
    name: '黃昏', icon: '🌇', exploreSpeed: 1, lootMul: 1, zombieMul: 1.5, danger: 1.2,
    special: false, overlay: 0.25, zombies: false, desc: '天色漸暗，殭屍即將出沒',
  },
  night: {
    name: '夜晚', icon: '🌙', exploreSpeed: 0.85, lootMul: 1.2, zombieMul: 1.8, danger: 1.7,
    special: false, overlay: 0.5, zombies: true, desc: '殭屍出沒、襲擊據點，危險度大幅提升',
  },
  midnight: {
    name: '午夜', icon: '🌑', exploreSpeed: 0.8, lootMul: 1.35, zombieMul: 2, danger: 2.1,
    special: true, overlay: 0.62, zombies: true, desc: '殭屍與特殊怪物出沒',
  },
};

/** 一天中殭屍出沒（夜晚 + 午夜）的時間比例：20:00–06:00 共 10 小時 */
export const ZOMBIE_HOURS_FRACTION = 10 / 24;

/** 小時 -> 階段 ID */
export function phaseForHour(hour) {
  if (hour >= 6 && hour < 17) return 'day';
  if (hour >= 17 && hour < 20) return 'dusk';
  if (hour >= 0 && hour < 2) return 'midnight';
  return 'night';
}
