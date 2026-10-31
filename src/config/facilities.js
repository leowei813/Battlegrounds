import { materialize, tierFromLevel } from './supplies.js';

/**
 * 避難所設施。
 * cost(level) 回傳升到 level 所需資源；time(level) 回傳秒數。
 * effect(level) 只描述數值，實際套用在 ShelterSystem / ResourceSystem。
 */
/** 升級成本隨等級快速成長（每級 ×1.8），高等級需要大量探索物資 */
const scale = (base, level, growth = 1.8) =>
  Object.fromEntries(Object.entries(base).map(([k, v]) => [k, Math.round(v * growth ** (level - 1))]));

export const FACILITY_MAX_LEVEL = 10;

/**
 * 升級費用：木材、燃料等依等級快速成長；抽象的金屬／布料／藥品換算成具體零件與布料，
 * 等級越高越需要高階零件（數量成長較慢，但高階零件難找）。
 */
const MAT_KEYS = ['metal', 'cloth', 'medicine'];
const mat = (key, tags, base, lv) => {
  const plain = scale(Object.fromEntries(Object.entries(base).filter(([k]) => !MAT_KEYS.includes(k))), lv);
  const abstract = Object.fromEntries(Object.entries(base).filter(([k]) => MAT_KEYS.includes(k)).map(([k, v]) => [k, v * 1.3 ** (lv - 1)]));
  return materialize({ ...plain, ...abstract }, { tier: tierFromLevel(lv, FACILITY_MAX_LEVEL), tags, key });
};

/** 生產設施每級的每小時產量（生產只是輔助，主要物資需靠探索） */
export const FARM_FOOD = 7;
/** 伐木場每級每小時產出木材（產量低，比不上直接探索樹林） */
export const LUMBER_WOOD = 3;
/** 工作台每級每小時產出（木材，以及少量基礎零件） */
export const WORKBENCH = { wood: 3, nail: 0.5, screw: 0.5 };

/** 修繕圍牆：每名修繕人員每秒修復的耐久，與每點耐久消耗的材料 */
export const REPAIR = { hpPerSec: 1.5, cost: { wood: 0.09, nail: 0.006, scrap: 0.003 } };

/** 前哨站只有防禦功能，只能建造這些設施 */
export const OUTPOST_FACILITIES = ['wall', 'watchtower'];

export const FACILITIES = {
  wall: {
    name: '圍牆', icon: '🧱', startLevel: 1,
    desc: '避難所的生命線。提升耐久與減傷。',
    cost: (lv) => mat('wall', ['struct'], { wood: 80, metal: 40 }, lv),
    effectText: (lv) => `耐久 ${wallMaxHp(lv)}，減傷 ${Math.round(lv * 3)}%`,
  },
  warehouse: {
    name: '消耗品倉庫', icon: '📦', startLevel: 1,
    desc: '存放食物、木材等消耗品，提高消耗品上限。',
    cost: (lv) => mat('warehouse', ['struct'], { wood: 100, metal: 30, cloth: 30 }, lv),
    effectText: (lv) => `消耗品上限 ${storageCap(lv)}`,
  },
  itemStore: {
    name: '物品倉庫', icon: '🗄️', startLevel: 1,
    desc: '存放裝備等物品，每升一級增加物品格子。',
    cost: (lv) => mat('itemStore', ['struct'], { wood: 90, metal: 50, cloth: 20 }, lv),
    effectText: (lv) => `物品格子 ${itemStoreSlots(lv)} 格`,
  },
  watchtower: {
    name: '探照燈', icon: '🔦', startLevel: 0,
    desc: '擴大偵查範圍，提前發現屍潮並提升防禦塔射程。',
    cost: (lv) => mat('watchtower', ['struct', 'mech'], { wood: 90, metal: 55 }, lv),
    effectText: (lv) => `防禦射程 +${lv * 6}%，探索遭遇戰先手率 +${lv * 4}%`,
  },
  farm: {
    name: '農場', icon: '🌾', startLevel: 0,
    desc: '持續生產食物。',
    cost: (lv) => mat('farm', ['struct', 'mech'], { wood: 70, cloth: 20 }, lv),
    effectText: (lv) => `食物 +${lv * FARM_FOOD}/時`,
  },
  generator: {
    name: '發電機', icon: '⚡', startLevel: 0,
    desc: '消耗燃料，提升所有生產與防禦塔效率。',
    cost: (lv) => mat('generator', ['elec', 'mech'], { metal: 100, fuel: 30 }, lv),
    effectText: (lv) => `全生產 +${lv * 6}%，耗燃料 ${lv * 2}/時`,
  },
  lumberMill: {
    name: '伐木場', icon: '🪓', startLevel: 0,
    desc: '持續砍伐產出少量木材（產量不高，大量木材仍需到樹林探索）。',
    cost: (lv) => mat('lumberMill', ['mech', 'struct'], { wood: 40, metal: 40, cloth: 10 }, lv),
    effectText: (lv) => `木材 +${lv * LUMBER_WOOD}/時`,
  },
  dormitory: {
    name: '宿舍', icon: '🛏️', startLevel: 0,
    desc: '倖存者的住處。沒有宿舍無法招募新成員，每升一級可多住 1 人。',
    cost: (lv) => mat('dormitory', ['struct'], { wood: 90, metal: 25, cloth: 45 }, lv),
    effectText: (lv) => `可住 ${dormCap(lv)} 人（含領袖）`,
  },
  workbench: {
    name: '工作台', icon: '🛠️', startLevel: 0,
    desc: '拆解廢料產出木材/金屬/布料，並可製作裝備。',
    cost: (lv) => mat('workbench', ['mech', 'struct'], { wood: 80, metal: 70 }, lv),
    effectText: (lv) => `木 +${lv * WORKBENCH.wood}、釘子與螺絲各 +${lv * WORKBENCH.nail}/時，可製作 Lv${lv * 5} 裝備`,
  },
  researchCenter: {
    name: '研究中心', icon: '🔬', startLevel: 0,
    desc: '解鎖研究，等級越高可研究的科技越多、速度越快。',
    cost: (lv) => {
      const c = mat('researchCenter', ['elec'], { wood: 130, metal: 100, cloth: 50, medicine: 15 }, lv);
      // 第 1 級降低電線與燈泡需求，讓研究較早開放
      if (lv === 1) ['wire', 'bulb'].forEach((k) => { if (c[k]) c[k] = Math.max(1, Math.round(c[k] * 0.6)); });
      return c;
    },
    effectText: (lv) => `研究速度 +${lv * 10}%，可研究第 ${Math.min(4, Math.ceil(lv / 2))} 階`,
  },
};

/** 施工秒數 */
export const facilityBuildTime = (lv) => Math.round(20 * 1.75 ** (lv - 1));

export const wallMaxHp = (lv) => 400 + lv * 350 + lv * lv * 40;
export const storageCap = (lv) => 600 + lv * 700 + lv * lv * 120;
/** 物品倉庫格子：Lv1 30 格，每升一級 +10 */
export const itemStoreSlots = (lv) => 30 + Math.max(0, lv - 1) * 10;
export const housingCap = (lv) => 3 + lv * 2;
/** 宿舍可住人數（含領袖）：沒有宿舍只有領袖 1 人，Lv1 3 人，之後每級 +1 */
export const dormCap = (lv) => (lv > 0 ? 2 + lv : 1);
