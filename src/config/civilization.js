/**
 * 文明度與據點設定。
 *
 * 文明度（Civilization）代表倖存者勢力的發展程度：建築、玩家等級、裝備都會提升文明度。
 * 屍潮強度只取決於文明度（與據點危險度），不再隨天數成長——發展越快，吸引的屍群越強。
 */

/** 文明度權重 */
export const CIV_WEIGHTS = {
  facilityLevel: 2, // 每個據點每一級設施
  defenseLevel: 1.5, // 每一級防禦建築
  playerLevel: 4, // 玩家（領袖）每一級
  equipmentPower: 1 / 50, // 已裝備裝備的戰力總和
};

export const CIV_TIERS = [
  { min: 0, name: '廢墟', icon: '🏚️' },
  { min: 40, name: '營地', icon: '⛺' },
  { min: 100, name: '聚落', icon: '🏘️' },
  { min: 200, name: '城鎮', icon: '🏙️' },
  { min: 350, name: '城邦', icon: '🏛️' },
  { min: 550, name: '新文明', icon: '🌆' },
];

/** 屍潮隨文明度成長的係數 */
export const SIEGE_SCALING = {
  civBaseline: 20, // 新手保護：低於此文明度不加成
  civPerLevel: 16, // 每 16 文明度，殭屍 +1 級
  spawnPerCiv: 0.005, // 每點文明度，屍潮頻率 +0.5%
  maxSpawnMul: 4, // 文明度造成的頻率倍率上限
  hpPerCiv: 0.006, // 每點文明度，屍潮殭屍生命 +0.6%
  atkPerCiv: 0.004, // 每點文明度，屍潮殭屍攻擊 +0.4%
  dangerLevelMul: 0.5, // 每點據點危險度（超過 1 的部分），殭屍 +0.5 級
  dangerSpawn: 0.08, // 每點據點危險度，屍潮頻率 +8%
  /** 文明度達到門檻後，該種敵人才會加入屍潮 */
  unlock: { infected: 20, berserker: 60, mutant: 140, nightStalker: 90, boss: 200 },
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

/** 建立第 n 座前哨站的費用 */
export const baseEstablishCost = (n) => ({
  coins: 250 * n, wood: 200 * n, metal: 120 * n, cloth: 60 * n,
});

/** 據點遭突破時損失的資源比例 */
export const BREACH_LOSS = { primary: 0.25, outpost: 0.25 };

/**
 * 據點遭突破時，每棟建築（設施與防禦建築）各自有此機率損毀降 1 級；
 * 1 級建築損毀即被拆除（圍牆最低保留 1 級）。
 */
export const BREACH_BUILDING_DAMAGE_CHANCE = 0.3;

/**
 * 據點規模：決定可建造的防禦建築數量（設施固定 8 種）。最大的「巨型」據點共可建造 20 棟建築。
 * 據點越大，圍牆越長越難防守：siegeMul 為屍潮數量倍率。
 */
export const BASE_SIZES = {
  small: { name: '小型', slots: 4, icon: '⛺', pin: 32, mul: 0.88, color: '#b0bec5', siegeMul: 0.85 },
  medium: { name: '中型', slots: 6, icon: '🏘️', pin: 35, mul: 1, color: '#9ccc65', siegeMul: 1 },
  large: { name: '大型', slots: 9, icon: '🏢', pin: 38, mul: 1.12, color: '#42a5f5', siegeMul: 1.25 },
  huge: { name: '巨型', slots: 12, icon: '🏰', pin: 42, mul: 1.25, color: '#ffa726', siegeMul: 1.55 },
};
export const FACILITY_COUNT = 8;

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
};

function hashString(s) {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

/** 某棟建築作為據點時的規模 ID */
export function baseSizeOf(poi) {
  const options = SIZE_BY_TYPE[poi?.type] || ['medium'];
  return options[hashString(String(poi?.id || '')) % options.length];
}
