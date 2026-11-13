/**
 * v15.18：天候事件日。每天 00:00（台灣時間，與地下城同一天）全服抽一種，持續 24 小時，所有玩家相同。
 * fx：各系統讀取的倍率（沒有列出的為 1）；地下城不受影響。
 *  - loot：探索搜刮量
 *  - hurt：探索與野外戰鬥受到的傷害
 *  - alert：NPC 與玩家據點的警戒範圍
 *  - food：食物消耗
 *  - move：探索移動速度
 *  - nightCount／nightLevel：夜間地圖殭屍群數量倍率／額外等級
 *  - killReward：獵殺夜間殭屍群的金錢與經驗
 *  - variant：屍潮變種出現權重
 *  - drop：全服空投次數（第二階段）
 *  - bmSell：黑市售價；bmBuy：黑市收購價
 *  - farm：農夫產量（耕作職務的技能加成）；foodProd：食物總產量
 */
export const WORLD_EVENTS = {
  calm: { name: '平靜日', icon: '☀️', weight: 30, lines: ['沒有特別效果'], short: '無特別效果', fx: {} },
  acidRain: {
    name: '酸雨', icon: '🌧️', weight: 12, lines: ['探索搜刮量 +20%', '探索與野外戰鬥受到的傷害 +30%'], short: '搜刮 +20%・受傷 +30%', fx: { loot: 1.2, hurt: 1.3 },
  },
  fog: {
    name: '濃霧', icon: '🌫️', weight: 12, lines: ['所有警戒範圍 −30%（NPC 與玩家都是），比較容易繞路與偷襲'], short: '警戒範圍 −30%', fx: { alert: 0.7 },
  },
  heatWave: {
    name: '熱浪', icon: '🔥', weight: 10, lines: ['食物消耗 +25%', '探索移動速度 −15%'], short: '食物消耗 +25%・移動 −15%', fx: { food: 1.25, move: 0.85 },
  },
  bloodMoon: {
    name: '血月', icon: '🌕', weight: 8, lines: ['夜間殭屍群數量 +30%、等級 +3', '獵殺夜間殭屍群的金錢與經驗 +50%', '屍潮變種出現機率加倍'], short: '夜間殭屍增強・獎勵 +50%・變種加倍',
    fx: {
      nightCount: 1.3, nightLevel: 3, killReward: 1.5, variant: 2,
    },
  },
  // 第二階段（全服空投）上線後才會出現
  supply: {
    name: '補給日', icon: '📦', weight: 0, lines: ['全服空投次數加倍'], short: '空投次數加倍', fx: { drop: 2 },
  },
  blackSale: {
    name: '黑市大促', icon: '🕶️', weight: 9, lines: ['黑市售價 −20%', '黑市收購價 +20%'], short: '黑市售價 −20%・收購 +20%', fx: { bmSell: 0.8, bmBuy: 1.2 },
  },
  harvest: {
    name: '豐收', icon: '🌾', weight: 9, lines: ['農夫產量 +30%', '避難所食物產量 +15%'], short: '農夫 +30%・食物產量 +15%', fx: { farm: 1.3, foodProd: 1.15 },
  },
};
export const WORLD_EVENT_KEYS = Object.keys(WORLD_EVENTS);
