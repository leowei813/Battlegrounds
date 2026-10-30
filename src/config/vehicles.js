/**
 * 載具：影響探索隊的移動速度與運載量，有耐久度（可維修），除了滑板車與腳踏車都會耗油。
 *
 *  - seats      座位數（每台至少要一人駕駛；隊員都有座位時全隊才能以載具速度移動）
 *  - speed      移動速度倍率（步行 = 1）
 *  - cargo      運載量（資源單位）
 *  - fuelPerKm  每公里耗油（往返都算）
 *  - durability 最大耐久
 *  - find       探索時找到的權重
 *  - craft      可在工作台製作（需要的工作台等級與材料）
 */
export const VEHICLES = {
  kickScooter: {
    name: '滑板車', icon: '🛴', seats: 1, speed: 1.3, cargo: 20, fuelPerKm: 0, durability: 60, find: 14,
    craft: { workbench: 1, cost: { wood: 40, metal: 30 } },
  },
  bicycle: {
    name: '腳踏車', icon: '🚲', seats: 1, speed: 1.7, cargo: 40, fuelPerKm: 0, durability: 80, find: 14,
    craft: { workbench: 2, cost: { wood: 60, metal: 80, cloth: 20 } },
  },
  moped50: { name: '50cc 機車', icon: '🛵', seats: 2, speed: 2.2, cargo: 60, fuelPerKm: 0.15, durability: 100, find: 11 },
  scooter100: { name: '100cc 機車', icon: '🛵', seats: 2, speed: 2.6, cargo: 80, fuelPerKm: 0.2, durability: 120, find: 9 },
  motorcycle150: { name: '150cc 機車', icon: '🏍️', seats: 2, speed: 3.1, cargo: 100, fuelPerKm: 0.25, durability: 140, find: 6 },
  car: { name: '小客車', icon: '🚗', seats: 4, speed: 3.2, cargo: 250, fuelPerKm: 0.5, durability: 220, find: 8 },
  sportsCar: { name: '跑車', icon: '🏎️', seats: 2, speed: 4.5, cargo: 80, fuelPerKm: 0.9, durability: 160, find: 2 },
  van: { name: '廂型車', icon: '🚐', seats: 4, speed: 2.8, cargo: 500, fuelPerKm: 0.7, durability: 260, find: 5 },
  pickup: { name: '小貨車', icon: '🛻', seats: 3, speed: 2.8, cargo: 800, fuelPerKm: 0.8, durability: 300, find: 4 },
  truck: { name: '大貨車', icon: '🚚', seats: 3, speed: 2.1, cargo: 1800, fuelPerKm: 1.4, durability: 400, find: 1.5 },
  bus: { name: '巴士', icon: '🚌', seats: 4, speed: 2, cargo: 1000, fuelPerKm: 1.6, durability: 450, find: 1 },
};

/** 每名倖存者徒步可攜帶的資源量 */
export const PERSON_CARRY = 40;
/** 車庫容量 */
export const GARAGE_SIZE = 8;
/** 每公里磨損的耐久（往返都算） */
export const WEAR_PER_KM = 2.5;
/** 途中遇襲時載具受到的損傷 */
export const AMBUSH_WEAR = [8, 20];

/** 維修費用：每點耐久的金屬；有引擎的載具另需零件 */
export function repairCost(type, missing) {
  const def = VEHICLES[type];
  if (missing <= 0) return {};
  const cost = { metal: Math.ceil(missing * (def.fuelPerKm > 0 ? 0.8 : 0.4)) };
  if (def.fuelPerKm > 0) cost.parts = Math.ceil(missing / 80);
  return cost;
}

/** 依建築類型找到載具的機率加成 */
export const VEHICLE_FIND_BY_POI = {
  gasStation: 3, warehouse: 2, factory: 1.5, military: 2, shop: 1, residential: 0.8, police: 1.5, hospital: 0.6, school: 0.6,
};
