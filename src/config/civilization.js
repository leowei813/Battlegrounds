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

export const MAX_BASES = 5;

/** 建立第 n+1 個據點的費用（n = 目前據點數） */
export const baseEstablishCost = (n) => ({
  coins: 250 * n, wood: 200 * n, metal: 120 * n, cloth: 60 * n,
});

/** 據點遭突破時損失的資源比例 */
export const BREACH_LOSS = { primary: 0.08, outpost: 0.04 };
