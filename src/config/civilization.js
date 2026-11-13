import { materialize } from './supplies.js';
import { zoneIndexAt } from './zones.js';

/**
 * 文明度與據點設定。
 *
 * 文明度（Civilization）代表倖存者勢力的發展程度：建築、玩家等級、裝備都會提升文明度。
 * 屍潮強度只取決於文明度（與據點危險度），不再隨天數成長——發展越快，吸引的屍群越強。
 */

/** 文明度權重 */
export const CIV_WEIGHTS = {
  facilityLevel: 1.8, // 每個據點每一級設施
  defenseLevel: 1.3, // 每一級防禦建築
  playerLevel: 4, // 玩家（領袖）每一級
  equipmentPower: 1 / 70, // 已裝備裝備的戰力總和（裝備戰力公式計入詞條後數值較高）
  researchLevel: 0.25, // 每一級科技（科技總數多，權重較低）
};

export const CIV_TIERS = [
  { min: 0, name: '廢墟', icon: '🏚️' },
  { min: 40, name: '營地', icon: '⛺' },
  { min: 100, name: '聚落', icon: '🏘️' },
  { min: 200, name: '城鎮', icon: '🏙️' },
  { min: 350, name: '城邦', icon: '🏛️' },
  { min: 550, name: '新文明', icon: '🌆' },
  { min: 900, name: '復興都市', icon: '🏙️' },
  { min: 1400, name: '黎明之國', icon: '🌇' },
  { min: 2000, name: '曙光聯邦', icon: '🌍' },
  { min: 2800, name: '重生紀元', icon: '🌟' },
];

/** 屍潮隨文明度成長的係數 */
export const SIEGE_SCALING = {
  civBaseline: 20, // 新手保護：低於此文明度不加成
  /** 文明度超過 softFrom（新文明）的部分，只以 softRate 的比例增加屍潮強度（避免後期無限變強） */
  softFrom: 550,
  softRate: 0.5,
  /** 屍潮殭屍最高等級（含據點與區域加成；v10.9 由 60 提高，讓後期持續變強） */
  maxZombieLevel: 75,
  /** 屍潮殭屍的生命、攻擊整體倍率（v10.9 略為加強；破牆後的近身戰沿用同一批殭屍的數值） */
  zombieMul: { hp: 1.1, atk: 1.1 },
  civPerLevel: 16, // 每 16 文明度，殭屍 +1 級
  spawnPerCiv: 0.0012, // 每點文明度，屍潮頻率 +0.12%
  maxSpawnMul: 2.5, // 文明度造成的頻率倍率上限（v10.9 由 2.2 提高）
  hpPerCiv: 0.00273, // 每點文明度，屍潮殭屍生命 +0.273%（等級已隨文明度提高）
  atkPerCiv: 0.00163, // 每點文明度，屍潮殭屍攻擊 +0.163%
  /** 前期固定加強：生命 +80%、攻擊 +20%，在超過基準 earlyCiv 點文明度時加滿（讓文明 150～300 也有一點壓力） */
  hpEarly: 0.8,
  atkEarly: 0.2,
  earlyCiv: 130,
  /** 駐守人員（含瞭望塔駐守、協防隊）在屍潮中的傷害倍率：讓駐守人數成為守城關鍵 */
  guardDmgMul: 2,
  /** 防禦設施在屍潮中的傷害倍率 */
  towerDmgMul: 0.7,
  /** 每多一波，殭屍數量 +2%（最多 +60%） */
  waveGrowth: 0.02,
  /** Boss 在屍潮中的生命、攻擊倍率（抵銷文明度加成，維持原本強度） */
  bossMul: 0.5,
  dangerLevelMul: 0.25, // 每點據點危險度（超過 1 的部分），殭屍 +0.25 級
  dangerSpawn: 0.04, // 每點據點危險度，屍潮頻率 +4%
  /** 每晚最多幾波屍潮（依文明度階級：廢墟／新手 1 波 → 新文明 6 波） */
  wavesByTier: [1, 2, 3, 4, 5, 6, 6, 6, 6, 6], // 新文明之後的階段維持 6 波
  /** 文明度越低，每波殭屍越少（倍率從 0.45 到 0.7） */
  waveSizeMin: 0.45,
  waveSizeMax: 0.7,
  waveSizeCiv: 350, // 文明度達此值時每波數量達到上限
  /** 文明度越低，屍潮殭屍越弱（生命、攻擊從 0.6 倍起，文明度 100 時恢復正常） */
  weakMin: 0.6,
  weakCiv: 100,
  /** 文明度達到門檻後，該種敵人才會加入屍潮 */
  unlock: {
    infected: 20, berserker: 60, mutant: 140, nightStalker: 90, boss: 200, exploder: 80, armored: 110, screamer: 120, breaker: 160, climber: 220,
  },
};

/**
 * 主要據點危險度係數：主要據點危險度 = 建築基礎危險度 + 文明度 × 係數。
 * 例：文明度 150 → +3 危險度。
 */
export const PRIMARY_DANGER_COEF = 0.02;

/** 前哨站上限（研究「前哨站」科技逐步解鎖） */
export const MAX_OUTPOSTS = 3;
/** 舊存檔相容：避難所 1 座 + 前哨站 */
export const MAX_BASES = 1 + MAX_OUTPOSTS;
/** 放棄據點時退還的建造資源比例 */
export const ABANDON_REFUND = 0.25;
/** 搬遷避難所：防禦建築退還的建造材料比例 */
export const RELOCATE_DEFENSE_REFUND = 0.5;
/** 搬遷避難所：食物、木材、燃料保留的比例 */
export const RELOCATE_KEEP = 0.1;

/** 建立第 n 座前哨站的費用 */
export const baseEstablishCost = (n) => materialize({
  coins: 250 * n, wood: 200 * n, metal: 120 * n, cloth: 60 * n,
}, { tier: n, tags: ['struct'], key: 'outpost' });

/** 據點遭突破時損失的資源比例 */
export const BREACH_LOSS = { primary: 0.5, outpost: 0.5 };

/**
 * 屍潮防守的獎勵與懲罰。
 * 守住：天亮依城牆剩餘給評價倍率，發放金幣、零件、彈藥（優秀時有機率得到設計圖），整晚駐守的人額外獲得經驗。
 * 突破：越早被突破損失越重（資源、材料、防禦設施損毀），駐守人員可能受傷。
 */
export const SIEGE_REWARD = {
  grades: [
    { min: 0.8, id: 'excellent', name: '優秀', mul: 1.5 },
    { min: 0.5, id: 'good', name: '良好', mul: 1.2 },
    { min: 0.2, id: 'normal', name: '普通', mul: 1 },
    { min: 0, id: 'barely', name: '勉強', mul: 0.7 },
  ],
  coinsPerKill: 2,
  partsPerWave: 2,
  ammoPerWave: 10,
  blueprintChance: 0.05, // 評價「優秀」時
  guardXpPct: 0.05, // 整晚駐守：每人獲得升級所需經驗的 5%
  boss: { parts: 8, gearChance: 0.25, blueprintChance: 0.1 },
};
export const SIEGE_PENALTY = {
  lossMax: 0.55, // 第 1 波就被突破
  lossSpan: 0.35, // 撐過的比例越高，損失越少
  materialChance: 0.25, // 每種零件、布料被奪走的機率
  materialMin: 0.05,
  materialMax: 0.15,
  defenseBase: 0.2, // 防禦設施損毀機率：0.2 + 0.4 ×（1 − 撐過比例）
  defenseSpan: 0.4,
  lightChance: 0.4, // 駐守人員輕傷（生命 −30%）
  lightHpPct: 0.3,
  severeChance: 0.2, // 駐守人員重傷
};

/**
 * 據點遭突破時，每棟建築（設施與防禦建築）各自有此機率損毀降 1 級；
 * 1 級建築損毀即被拆除（圍牆最低保留 1 級）。
 */
export const BREACH_BUILDING_DAMAGE_CHANCE = 0.3;

/**
 * 據點規模：決定可建造的防禦建築數量（設施固定 9 種）。最大的「巨型」據點共可建造 20 棟建築。
 * 據點越大，圍牆越長越難防守：siegeMul 為屍潮數量倍率。
 */
export const BASE_SIZES = {
  small: { name: '小型', slots: 3, facMax: 8, icon: '⛺', pin: 32, mul: 0.88, color: '#b0bec5', siegeMul: 0.85, searchMin: 2, alert: 40 },
  medium: { name: '中型', slots: 5, facMax: 11, icon: '🏘️', pin: 35, mul: 1, color: '#9ccc65', siegeMul: 1, searchMin: 4, alert: 55 },
  large: { name: '大型', slots: 8, facMax: 13, icon: '🏢', pin: 38, mul: 1.12, color: '#42a5f5', siegeMul: 1.25, searchMin: 6, alert: 70 },
  huge: { name: '巨型', slots: 11, facMax: 15, icon: '🏰', pin: 42, mul: 1.25, color: '#ffa726', siegeMul: 1.55, searchMin: 8, alert: 90 },
};
export const FACILITY_COUNT = 9;
/** 設施依據點規模的最高等級（facMax）；超過時降級並退還的建造材料比例 */
export const FACILITY_CAP_REFUND = 0.5;

/** 各建築類型可能的規模（同類型中依建築 ID 固定挑選，不會每次變動） */
const SIZE_BY_TYPE = {
  residential: ['small', 'small', 'medium'],
  shop: ['small', 'medium', 'medium'],
  gasStation: ['medium'],
  school: ['medium', 'large', 'large'],
  police: ['large'],
  hospital: ['large', 'large', 'huge'],
  factory: ['large', 'huge'],
  warehouse: ['large', 'huge'],
  military: ['huge'],
  garage: ['small', 'medium'],
  supermarket: ['medium', 'large'],
  forest: ['small', 'medium'],
  pharmacy: ['small'],
  recycling: ['medium', 'large'],
  bakery: ['small'],
};

function hashString(s) {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

/**
 * v14：各區域的建築規模比例（小、中、大、巨，%）：巨型、大型集中在致死區與深淵區，致死區以下沒有巨型。
 */
export const SIZE_BY_ZONE = [
  [55, 40, 5, 0], // 安全區
  [45, 45, 10, 0], // 一般區
  [35, 50, 15, 0], // 警戒區
  [25, 50, 25, 0], // 危險區
  [15, 35, 35, 15], // 致死區
  [5, 25, 40, 30], // 深淵區
];
/**
 * 實際挑選用的比例（已扣掉固定規模的建築：藥局、樹林、軍事基地），讓各區整體比例符合 SIZE_BY_ZONE（v15 依新地圖實際產生的建築重新校正）。
 * 區域或建築種類比例改變時，用 scripts 重新計算（見 docs/material-balance.md 同一份流程）。
 */
export const SIZE_PICK = [[36.1, 61.6, 6.5, 0], [23.8, 63.3, 19, 0], [15.1, 59.5, 25.9, 0], [21.8, 50.3, 27.7, 0], [12.5, 27.4, 41.6, 17.1], [2.9, 11.6, 46.5, 35.9]];
const SIZE_KEYS = ['small', 'medium', 'large', 'huge'];
/** 固定規模的建築：藥局、麵包店一律小型，軍事基地一律巨型，樹林最多中型 */
const SIZE_LIMIT = { pharmacy: ['small'], bakery: ['small'], military: ['huge'], forest: ['small', 'medium'] };

/** 某棟建築作為據點時的規模 ID（依所在區域的比例，建築 ID 固定挑選，不會每次變動） */
export function baseSizeOf(poi) {
  const h = hashString(String(poi?.id || ''));
  if (Number.isFinite(poi?.lat) && Number.isFinite(poi?.lon)) {
    const allow = SIZE_LIMIT[poi.type] || SIZE_KEYS;
    if (allow.length === 1) return allow[0];
    const row = SIZE_PICK[zoneIndexAt(poi.lat, poi.lon)] || SIZE_PICK[1];
    const w = SIZE_KEYS.map((k, i) => (allow.includes(k) ? row[i] : 0));
    const tot = w.reduce((a, b) => a + b, 0) || 1;
    let m = Math.imul(h ^ (h >>> 16), 2246822507);
    m = Math.imul(m ^ (m >>> 13), 3266489909);
    let x = (((m ^ (m >>> 16)) >>> 0) / 4294967296) * tot;
    for (let i = 0; i < SIZE_KEYS.length; i += 1) { x -= w[i]; if (x < 0 && w[i] > 0) return SIZE_KEYS[i]; }
    return allow[allow.length - 1];
  }
  const options = SIZE_BY_TYPE[poi?.type] || ['medium'];
  return options[h % options.length];
}
