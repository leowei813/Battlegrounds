/**
 * 地圖建築類型（來源：OpenStreetMap 標籤）。
 * loot：每次「發現物資」事件的資源權重與基礎數量
 * itemBias：掉落裝備時各部位權重
 * enemies：遭遇敵人權重
 */
export const POI_TYPES = {
  residential: {
    name: '住宅區', icon: '🏠', color: '#8bc34a', danger: 1,
    loot: { food: 5, cloth: 4, wood: 4, medicine: 1 },
    itemChance: 0.12, blueprintChance: 0.01,
    itemBias: { pistol: 3, helmet: 2, armor: 1, legs: 2, backpack: 3 },
    enemies: { walker: 8, infected: 2 },
  },
  shop: {
    name: '商店', icon: '🏪', color: '#ffc107', danger: 2,
    loot: { food: 6, cloth: 3, medicine: 1, fuel: 1 },
    itemChance: 0.15, blueprintChance: 0.02,
    itemBias: { backpack: 4, legs: 2, helmet: 1, pistol: 1 },
    enemies: { walker: 6, infected: 4 },
  },
  hospital: {
    name: '醫院', icon: '🏥', color: '#f44336', danger: 4, special: true,
    loot: { medicine: 7, cloth: 3, food: 1 },
    itemChance: 0.18, blueprintChance: 0.05,
    itemBias: { armor: 2, helmet: 2, backpack: 1 },
    enemies: { infected: 5, mutant: 3, berserker: 2 },
  },
  school: {
    name: '學校', icon: '🏫', color: '#03a9f4', danger: 2,
    loot: { food: 3, wood: 5, cloth: 3, medicine: 1 },
    itemChance: 0.12, blueprintChance: 0.06,
    itemBias: { backpack: 3, helmet: 1, legs: 2 },
    enemies: { walker: 7, infected: 3 },
  },
  factory: {
    name: '工廠', icon: '🏭', color: '#9e9e9e', danger: 3,
    loot: { metal: 7, wood: 3, fuel: 2 },
    itemChance: 0.16, blueprintChance: 0.06,
    itemBias: { armor: 2, legs: 2, shotgun: 1, helmet: 2 },
    enemies: { walker: 4, infected: 4, berserker: 2 },
  },
  gasStation: {
    name: '加油站', icon: '⛽', color: '#ff9800', danger: 2,
    loot: { fuel: 8, food: 2, metal: 1 },
    itemChance: 0.1, blueprintChance: 0.02,
    itemBias: { pistol: 2, shotgun: 2, backpack: 1 },
    enemies: { walker: 6, infected: 3, berserker: 1 },
  },
  police: {
    name: '警察局', icon: '🚓', color: '#3f51b5', danger: 4, special: true,
    loot: { metal: 3, medicine: 2, cloth: 2, fuel: 1 },
    itemChance: 0.32, blueprintChance: 0.07,
    itemBias: { pistol: 4, shotgun: 3, rifle: 1, helmet: 3, armor: 3 },
    enemies: { infected: 4, berserker: 4, mutant: 1 },
  },
  military: {
    name: '軍事基地', icon: '🪖', color: '#556b2f', danger: 5, special: true,
    loot: { metal: 4, fuel: 4, medicine: 2, food: 2 },
    itemChance: 0.42, blueprintChance: 0.12,
    itemBias: { rifle: 4, sniper: 2, shotgun: 1, helmet: 3, armor: 4, legs: 2 },
    enemies: { berserker: 4, mutant: 4, infected: 2 },
  },
  warehouse: {
    name: '倉庫', icon: '🏚️', color: '#795548', danger: 3,
    loot: { wood: 4, metal: 4, cloth: 4, food: 3, fuel: 2 },
    itemChance: 0.18, blueprintChance: 0.05,
    itemBias: { backpack: 3, legs: 2, armor: 1, shotgun: 1 },
    enemies: { walker: 5, infected: 4, berserker: 1 },
  },
};

export const POI_KEYS = Object.keys(POI_TYPES);

/** 若 OSM 查不到某類型，每類程序化補足的最小數量 */
export const POI_MIN_PER_TYPE = {
  residential: 250, shop: 150, hospital: 30, school: 50, factory: 60,
  gasStation: 50, police: 30, military: 20, warehouse: 60,
};
