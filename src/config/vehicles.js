import { materialize } from './supplies.js';

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
    craft: { workbench: 1, cost: { wood: 40, bolt: 6, rubber: 4, screw: 6 } },
  },
  bicycle: {
    name: '腳踏車', icon: '🚲', seats: 1, speed: 1.7, cargo: 40, fuelPerKm: 0, durability: 80, find: 14,
    craft: { workbench: 2, cost: { wood: 20, chain: 2, gear: 2, rubber: 6, ironPlate: 3, bolt: 10, coarse: 4 } },
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

/** 載具等級（維修需要的零件階級） */
const VEHICLE_TIER = {
  kickScooter: 1, bicycle: 1, moped50: 2, scooter100: 2, motorcycle150: 3, car: 3, sportsCar: 4, van: 3, pickup: 3, truck: 4, bus: 4,
};

/** 維修費用：依缺少的耐久換算成零件（有引擎的載具還需要電子零件與稀有材料） */
export function repairCost(type, missing) {
  const def = VEHICLES[type];
  if (missing <= 0) return {};
  const engine = def.fuelPerKm > 0;
  const cost = materialize({ metal: Math.ceil(missing * (engine ? 0.8 : 0.4)) }, {
    tier: VEHICLE_TIER[type] || 2, tags: engine ? ['mech', 'elec'] : ['mech'], key: `veh-${type}`,
  });
  if (engine) cost.parts = Math.ceil(missing / 80);
  return cost;
}

/** 依建築類型找到載具的機率加成 */
export const VEHICLE_FIND_BY_POI = {
  garage: 8, gasStation: 0.3, warehouse: 0.3, factory: 0.3, military: 0.5, police: 0.3, residential: 0, shop: 0, hospital: 0, school: 0, supermarket: 0, forest: 0, pharmacy: 0, recycling: 0.2, bakery: 0,
};
