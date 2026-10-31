/**
 * 地圖建築類型（來源：OpenStreetMap 標籤；樹林為隨機生成的資源點）。
 * loot：每日物資的「類別」權重——
 *   food 食物、wood 木材、fuel 燃料、part 零件、fabric 布料、
 *   medLow 低階藥品（紗布、繃帶…）、med 各級藥品（含醫藥箱）、ammo 彈藥與箭矢
 * itemChance：找到裝備的機率（0 = 不會出現裝備）；itemBias：裝備部位權重
 * enemies：遭遇敵人權重
 */
export const LOOT_CATS = {
  food: { name: '食物', icon: '🥫' },
  wood: { name: '木材', icon: '🪵' },
  fuel: { name: '燃料', icon: '⛽' },
  part: { name: '零件', icon: '🔩' },
  fabric: { name: '布料', icon: '🧵' },
  medLow: { name: '低階藥品', icon: '🩹' },
  med: { name: '藥品', icon: '💊' },
  ammo: { name: '彈藥／箭矢', icon: '🎯' },
  gear: { name: '裝備', icon: '🎁' },
  vehicle: { name: '載具（需維修）', icon: '🚗' },
};

export const POI_TYPES = {
  residential: {
    name: '住宅區', icon: '🏠', color: '#8bc34a', danger: 1,
    loot: { food: 6, fabric: 4, medLow: 1 },
    itemChance: 0, blueprintChance: 0.01,
    itemBias: { melee: 4, pistol: 2, helmet: 2, armor: 1, legs: 2, gloves: 2, boots: 3, backpack: 3, accessory: 3 },
    enemies: { walker: 8, infected: 2 },
  },
  shop: {
    name: '商店', icon: '🏪', color: '#ffc107', danger: 2,
    loot: { food: 6, fabric: 3, medLow: 2, ammo: 0.6 },
    itemChance: 0, blueprintChance: 0.02,
    itemBias: { backpack: 4, legs: 2, helmet: 1, pistol: 1, boots: 3, gloves: 2, accessory: 4, melee: 1 },
    enemies: { walker: 6, infected: 4 },
  },
  supermarket: {
    name: '超市', icon: '🛒', color: '#ffeb3b', danger: 2, amountMul: 2,
    loot: { food: 7, fabric: 3, medLow: 2, part: 2 },
    itemChance: 0, blueprintChance: 0.02,
    itemBias: { backpack: 3, boots: 2, gloves: 2, accessory: 2 },
    enemies: { walker: 7, infected: 4 },
  },
  hospital: {
    name: '醫院', icon: '🏥', color: '#f44336', danger: 4, special: true,
    loot: { med: 7, food: 2 },
    itemChance: 0, blueprintChance: 0.05,
    itemBias: { armor: 2, helmet: 2, backpack: 1, gloves: 2, accessory: 2, melee: 1 },
    enemies: { infected: 5, mutant: 3, berserker: 2 },
  },
  school: {
    name: '學校', icon: '🏫', color: '#03a9f4', danger: 2,
    loot: { food: 3, wood: 5, fabric: 3, medLow: 1 },
    itemChance: 0.12, blueprintChance: 0.06,
    itemBias: { backpack: 3, helmet: 1, legs: 2, crossbow: 2, melee: 2, boots: 2, accessory: 2 },
    enemies: { walker: 7, infected: 3 },
  },
  factory: {
    name: '工廠', icon: '🏭', color: '#9e9e9e', danger: 3,
    loot: { part: 7, wood: 3, fuel: 2 },
    itemChance: 0.16, blueprintChance: 0.06,
    itemBias: { armor: 2, legs: 2, shotgun: 1, helmet: 2, gloves: 3, boots: 2, melee: 3 },
    enemies: { walker: 4, infected: 4, berserker: 2 },
  },
  gasStation: {
    name: '加油站', icon: '⛽', color: '#ff9800', danger: 2,
    loot: { fuel: 7, part: 4 },
    itemChance: 0, blueprintChance: 0.02,
    itemBias: { pistol: 2, shotgun: 2, backpack: 1, melee: 2, gloves: 1, boots: 1 },
    enemies: { walker: 6, infected: 3, berserker: 1 },
  },
  garage: {
    name: '修車廠', icon: '🔧', color: '#607d8b', danger: 2,
    loot: { part: 9, vehicle: 2 },
    itemChance: 0, blueprintChance: 0.02,
    itemBias: { melee: 2, gloves: 2, boots: 1 },
    enemies: { walker: 6, infected: 3, berserker: 1 },
  },
  police: {
    name: '警察局', icon: '🚓', color: '#3f51b5', danger: 4, special: true,
    loot: { gear: 3, ammo: 4, part: 3, fuel: 0.8 },
    itemChance: 0.32, blueprintChance: 0.07,
    itemBias: { pistol: 4, shotgun: 3, rifle: 1, smg: 3, helmet: 3, armor: 3, gloves: 2, boots: 2, accessory: 1 },
    enemies: { infected: 4, berserker: 4, mutant: 1 },
  },
  military: {
    name: '軍事基地', icon: '🪖', color: '#556b2f', danger: 5, special: true,
    loot: { gear: 4, ammo: 5, part: 4, fuel: 1 },
    itemChance: 0.42, blueprintChance: 0.12,
    itemBias: { rifle: 4, sniper: 2, shotgun: 1, smg: 2, lmg: 2, helmet: 3, armor: 4, legs: 2, gloves: 2, boots: 3, accessory: 2 },
    enemies: { berserker: 4, mutant: 4, infected: 2 },
  },
  warehouse: {
    name: '倉庫', icon: '🏚️', color: '#795548', danger: 3,
    loot: { wood: 4, part: 4, fabric: 4, food: 3, fuel: 2 },
    itemChance: 0.18, blueprintChance: 0.05,
    itemBias: { backpack: 3, legs: 2, armor: 1, shotgun: 1, crossbow: 1, melee: 2, boots: 2, gloves: 2 },
    enemies: { walker: 5, infected: 4, berserker: 1 },
  },
  forest: {
    name: '樹林', icon: '🌲', color: '#2e7d32', danger: 1, generated: true, amountMul: 1.6,
    loot: { wood: 10 },
    itemChance: 0, blueprintChance: 0,
    itemBias: { melee: 1 },
    enemies: { walker: 8, infected: 1 },
  },
};

export const POI_KEYS = Object.keys(POI_TYPES);

/** 若 OSM 查不到某類型，每類程序化補足的最小數量（樹林全部隨機生成） */
export const POI_MIN_PER_TYPE = {
  residential: 250, shop: 150, hospital: 30, school: 50, factory: 60,
  gasStation: 50, police: 30, military: 20, warehouse: 60, garage: 30, supermarket: 15, forest: 45,
};
