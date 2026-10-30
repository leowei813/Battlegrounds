/**
 * 日夜系統階段定義（遊戲內小時）。
 * exploreSpeed：探索時間倍率的倒數（>1 代表更快）
 * zombieMul：地圖殭屍數量與避難所襲擊頻率倍率
 * danger：敵人強度倍率
 */
export const TIME_PHASES = {
  day: {
    name: '白天', icon: '☀️', exploreSpeed: 1.25, lootMul: 1.15, zombieMul: 1, danger: 1,
    special: false, overlay: 0, desc: '探索效率提升',
  },
  dusk: {
    name: '黃昏', icon: '🌇', exploreSpeed: 1, lootMul: 1, zombieMul: 1.5, danger: 1.2,
    special: false, overlay: 0.25, desc: '殭屍數量增加',
  },
  night: {
    name: '夜晚', icon: '🌙', exploreSpeed: 0.85, lootMul: 1.2, zombieMul: 1.8, danger: 1.7,
    special: false, overlay: 0.5, desc: '危險度大幅提升',
  },
  midnight: {
    name: '午夜', icon: '🌑', exploreSpeed: 0.8, lootMul: 1.35, zombieMul: 2, danger: 2.1,
    special: true, overlay: 0.62, desc: '特殊怪物出沒',
  },
};

/** 小時 -> 階段 ID */
export function phaseForHour(hour) {
  if (hour >= 6 && hour < 17) return 'day';
  if (hour >= 17 && hour < 20) return 'dusk';
  if (hour >= 0 && hour < 2) return 'midnight';
  return 'night';
}
