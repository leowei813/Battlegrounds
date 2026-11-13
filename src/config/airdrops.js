/**
 * v15.19：全服空投。
 * 地圖切成 cellKm 的格子（有建築的格子才會掉），每 slotMs 一輪，每格有 chance 的機率掉一箱；
 * 所有玩家以「輪次＋格子」當亂數種子算出相同的位置、時間與內容。
 * 降落前 announceMs 地圖出現落點，降落後停留 stayMs；第一支抵達並打贏守衛的隊伍拿走全部。
 * 降落後 npcMin 分鐘（固定亂數）還沒有玩家搶走，就被 NPC 勢力拿走。
 */
export const AIRDROP = {
  kind: 'ad',
  cellKm: 0.45,
  slotMs: 3 * 3600 * 1000,
  chance: 0.12,
  announceMs: 10 * 60 * 1000,
  stayMs: 60 * 60 * 1000,
  npcMin: [25, 55],
};

/** 每種材料的基本數量（依階級）；實際數量 × 區域倍率 × 0.8～1.2 */
export const AIRDROP_AMOUNT = { 1: 110, 2: 18, 3: 6.5, 4: 2.6, 5: 0.75 };
/** 布料的數量倍率（依階級；探索中 1 階布料較少，避免空投佔比過高） */
export const AIRDROP_FABRIC_MUL = { 1: 0.5, 3: 0.8 };
/** 守衛殭屍的種類（依序輪替） */
export const AIRDROP_GUARD_MIX = ['infected', 'berserker', 'mutant', 'infected'];

/**
 * 各區域的空投內容與守衛：
 *  - tiers：零件、布料的階級範圍；kinds：材料種類數；mul：數量倍率
 *  - coins／parts：金錢、稀有材料範圍；bp：設計圖機率（bpMin：保底品級）
 *  - power：建議隊伍總戰力（剛好達到時勝率約六成，低兩成打不贏）
 *  - guard：守衛等級、數量、生命與攻擊倍率（依實際戰鬥模擬校準到 power）
 */
export const AIRDROP_ZONE = {
  safe: {
    tiers: [1, 2], kinds: 3, mul: 1, coins: [40, 80], parts: [1, 2], bp: 0, power: 15000, guard: { lv: 12, n: 5, mul: 11.17 },
  },
  normal: {
    tiers: [1, 2], kinds: 3, mul: 1.2, coins: [60, 120], parts: [1, 3], bp: 0, power: 35000, guard: { lv: 20, n: 6, mul: 14.22 },
  },
  alert: {
    tiers: [2, 3], kinds: 3, mul: 1.4, coins: [100, 180], parts: [2, 4], bp: 0.1, power: 65000, guard: { lv: 27, n: 6, mul: 22.82 },
  },
  danger: {
    tiers: [3, 4], kinds: 4, mul: 1.6, coins: [150, 260], parts: [3, 6], bp: 0.2, power: 120000, guard: { lv: 35, n: 7, mul: 30.04 },
  },
  lethal: {
    tiers: [3, 5], kinds: 4, mul: 1.8, coins: [220, 380], parts: [4, 8], bp: 0.2, bpMin: 'rare', power: 200000, guard: { lv: 43, n: 8, mul: 45.4 },
  },
  abyss: {
    tiers: [4, 5], kinds: 4, mul: 2, coins: [300, 500], parts: [6, 10], bp: 0.2, bpMin: 'rare', power: 300000, guard: { lv: 50, n: 8, mul: 59.2 },
  },
};
