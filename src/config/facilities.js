/**
 * 避難所設施。
 * cost(level) 回傳升到 level 所需資源；time(level) 回傳秒數。
 * effect(level) 只描述數值，實際套用在 ShelterSystem / ResourceSystem。
 */
const scale = (base, level, growth = 1.55) =>
  Object.fromEntries(Object.entries(base).map(([k, v]) => [k, Math.round(v * growth ** (level - 1))]));

export const FACILITY_MAX_LEVEL = 10;

export const FACILITIES = {
  wall: {
    name: '圍牆', icon: '🧱', startLevel: 1,
    desc: '避難所的生命線。提升耐久與減傷。',
    cost: (lv) => scale({ wood: 60, metal: 30 }, lv),
    effectText: (lv) => `耐久 ${wallMaxHp(lv)}，減傷 ${Math.round(lv * 3)}%`,
  },
  warehouse: {
    name: '倉庫', icon: '📦', startLevel: 1,
    desc: '提高資源上限。',
    cost: (lv) => scale({ wood: 80, metal: 20, cloth: 20 }, lv),
    effectText: (lv) => `資源上限 ${storageCap(lv)}`,
  },
  watchtower: {
    name: '監視塔', icon: '🗼', startLevel: 0,
    desc: '擴大偵查範圍，提前發現屍潮並提升防禦塔射程。',
    cost: (lv) => scale({ wood: 70, metal: 40 }, lv),
    effectText: (lv) => `防禦射程 +${lv * 6}%，探索遭遇戰先手率 +${lv * 4}%`,
  },
  farm: {
    name: '農場', icon: '🌾', startLevel: 1,
    desc: '持續生產食物。',
    cost: (lv) => scale({ wood: 50, cloth: 10 }, lv),
    effectText: (lv) => `食物 +${lv * 18}/時`,
  },
  generator: {
    name: '發電機', icon: '⚡', startLevel: 0,
    desc: '消耗燃料，提升所有生產與防禦塔效率。',
    cost: (lv) => scale({ metal: 80, fuel: 20 }, lv),
    effectText: (lv) => `全生產 +${lv * 6}%，耗燃料 ${lv * 2}/時`,
  },
  rainCollector: {
    name: '雨水收集器', icon: '💧', startLevel: 0,
    desc: '淨水灌溉農場並可製作簡易藥品。',
    cost: (lv) => scale({ wood: 40, cloth: 30, metal: 10 }, lv),
    effectText: (lv) => `農場 +${lv * 10}%，藥品 +${(lv * 1.5).toFixed(1)}/時`,
  },
  workbench: {
    name: '工作台', icon: '🛠️', startLevel: 1,
    desc: '拆解廢料產出木材/金屬/布料，並可製作裝備。',
    cost: (lv) => scale({ wood: 60, metal: 50 }, lv),
    effectText: (lv) => `木 +${lv * 8} 金 +${lv * 5} 布 +${lv * 4}/時，可製作 Lv${lv * 5} 裝備`,
  },
  researchCenter: {
    name: '研究中心', icon: '🔬', startLevel: 0,
    desc: '解鎖研究，等級越高可研究的科技越多、速度越快。',
    cost: (lv) => scale({ wood: 100, metal: 80, cloth: 40, medicine: 10 }, lv),
    effectText: (lv) => `研究速度 +${lv * 10}%，可研究第 ${Math.min(4, Math.ceil(lv / 2))} 階`,
  },
};

/** 施工秒數 */
export const facilityBuildTime = (lv) => Math.round(8 * 1.6 ** (lv - 1));

export const wallMaxHp = (lv) => 400 + lv * 350 + lv * lv * 40;
export const storageCap = (lv) => 600 + lv * 700 + lv * lv * 120;
export const housingCap = (lv) => 3 + lv * 2;
