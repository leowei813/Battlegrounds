/**
 * 裝備資料：品級、類型、詞綴。
 *
 * 品級素質規則：每件裝備的每一項數值都在該品級的倍率範圍 [min, max] 內隨機。
 * 各品級範圍首尾相接、互不重疊，因此同類型、同等級時，
 * 任一品級的最低素質都不會低於低一階品級的最高素質。
 */
export const RARITIES = {
  poor: { name: '劣質', color: '#9e9e9e', min: 0.7, max: 0.85, affixes: 0, weight: 30, sell: 3 },
  common: { name: '一般', color: '#f5f5f5', min: 0.85, max: 1.0, affixes: 0, weight: 34, sell: 6 },
  uncommon: { name: '優良', color: '#4caf50', min: 1.0, max: 1.2, affixes: 1, weight: 22, sell: 12 },
  rare: { name: '精良', color: '#2196f3', min: 1.2, max: 1.45, affixes: 2, weight: 10, sell: 30 },
  epic: { name: '罕見', color: '#ab47bc', min: 1.45, max: 1.75, affixes: 3, weight: 3.4, sell: 80 },
  legendary: { name: '稀有', color: '#ff9800', min: 1.75, max: 2.2, affixes: 4, weight: 0.6, sell: 250 },
};
export const RARITY_ORDER = Object.keys(RARITIES);
export const rarityIndex = (r) => RARITY_ORDER.indexOf(r);

export const SLOTS = {
  weapon: { name: '武器', icon: '🔫' },
  helmet: { name: '頭盔', icon: '⛑️' },
  armor: { name: '防彈衣', icon: '🦺' },
  legs: { name: '護腿', icon: '👖' },
  gloves: { name: '手套', icon: '🧤' },
  boots: { name: '鞋子', icon: '🥾' },
  backpack: { name: '背包', icon: '🎒' },
  accessory: { name: '飾品', icon: '📿' },
};
export const SLOT_KEYS = Object.keys(SLOTS);

/** 空的裝備欄（新倖存者與舊存檔補欄位用） */
export const emptyEquipment = () => Object.fromEntries(SLOT_KEYS.map((k) => [k, null]));

/**
 * base 為等級 1 數值，perLevel 為每級成長；兩者都會乘上品級素質倍率（負值不乘）。
 * requires：製作時需要的研究 ID（掉落不受限）。
 */
export const ITEM_TYPES = {
  // ---- 武器 ----
  melee: {
    name: '近戰武器', slot: 'weapon', icon: '🪓', requires: null,
    base: { atk: 11, atkSpeed: 0.1, crit: 0.08, lifeSteal: 0.03 }, perLevel: { atk: 1.9 },
    names: ['棒球棍', '開山刀', '消防斧', '撬棍', '武士刀', '大鐵鎚', '鋼管', '砍骨刀', '軍用工兵鏟'],
  },
  pistol: {
    name: '手槍', slot: 'weapon', icon: '🔫', requires: null,
    base: { atk: 9, atkSpeed: 0.25, crit: 0.05 }, perLevel: { atk: 1.6 },
    names: ['M1911', 'Glock 17', 'USP', '沙漠之鷹', 'P226', 'Beretta M9', 'CZ 75', '左輪手槍', 'FN Five-seveN'],
  },
  crossbow: {
    name: '十字弓', slot: 'weapon', icon: '🏹', requires: null,
    base: { atk: 18, atkSpeed: -0.2, crit: 0.12, critDmg: 0.2 }, perLevel: { atk: 2.8 },
    names: ['獵弩', '複合弩', '戰術十字弓', '連弩', '狩獵複合弓', '反曲弓', '手槍弩', '重型弩'],
  },
  smg: {
    name: '衝鋒槍', slot: 'weapon', icon: '🔫', requires: 'wpn1',
    base: { atk: 8, atkSpeed: 0.55, crit: 0.04 }, perLevel: { atk: 1.5 },
    names: ['UZI', 'MP5', 'Vector', 'UMP45', 'P90', 'MP7', 'Thompson', 'PP-19 Bizon', 'MAC-10'],
  },
  rifle: {
    name: '步槍', slot: 'weapon', icon: '🪖', requires: 'wpn1',
    base: { atk: 15, atkSpeed: 0.15, crit: 0.06 }, perLevel: { atk: 2.6 },
    names: ['M4A1', 'AK-47', 'SCAR-L', 'AUG', 'M16A4', 'QBZ-95', 'G36C', 'FAMAS', 'HK416', 'T91'],
  },
  shotgun: {
    name: '散彈槍', slot: 'weapon', icon: '💥', requires: 'wpn2',
    base: { atk: 22, atkSpeed: -0.15, crit: 0.03 }, perLevel: { atk: 3.6 },
    names: ['S686', 'S1897', 'M870', 'SPAS-12', 'Saiga-12', 'AA-12', 'KSG', 'M1014', '短管獵槍'],
  },
  sniper: {
    name: '狙擊槍', slot: 'weapon', icon: '🎯', requires: 'wpn3',
    base: { atk: 34, atkSpeed: -0.35, crit: 0.18, critDmg: 0.5 }, perLevel: { atk: 5 },
    names: ['Kar98k', 'AWM', 'M24', 'SVD', 'Barrett', 'Mini14', 'SKS', 'Mosin-Nagant', 'L96A1'],
  },
  lmg: {
    name: '輕機槍', slot: 'weapon', icon: '⚙️', requires: 'wpn4',
    base: { atk: 17, atkSpeed: 0.4, crit: 0.03 }, perLevel: { atk: 2.9 },
    names: ['M249', 'DP-28', 'MG3', 'RPK', 'Negev', 'PKM', 'M60', 'Ultimax 100'],
  },
  // ---- 防具 ----
  helmet: {
    name: '頭盔', slot: 'helmet', icon: '⛑️', requires: null,
    base: { def: 4, hp: 20 }, perLevel: { def: 0.8, hp: 5 },
    names: ['一級頭', '二級頭', '三級頭', '戰術頭盔', '防暴頭盔', '機車安全帽', '消防頭盔', '夜視頭盔', '鈦合金頭盔'],
  },
  armor: {
    name: '防彈衣', slot: 'armor', icon: '🦺', requires: null,
    base: { def: 7, hp: 40 }, perLevel: { def: 1.4, hp: 9 },
    names: ['一級甲', '二級甲', '三級甲', '凱夫拉背心', '陶瓷插板', '防刺背心', '戰術背心', '鎖子甲', '重型防爆服'],
  },
  legs: {
    name: '護腿', slot: 'legs', icon: '👖', requires: null,
    base: { def: 3, dodge: 0.03 }, perLevel: { def: 0.6 },
    names: ['工作褲', '戰術護腿', '迷彩褲', '防刺護腿', '輕量護甲', '牛仔褲', '機車護膝', '登山褲'],
  },
  gloves: {
    name: '手套', slot: 'gloves', icon: '🧤', requires: null,
    base: { atk: 3, crit: 0.03 }, perLevel: { atk: 0.5 },
    names: ['工作手套', '戰術手套', '皮革手套', '防割手套', '射擊手套', '拳擊繃帶', '鋼指虎手套', '機車手套'],
  },
  boots: {
    name: '鞋子', slot: 'boots', icon: '🥾', requires: null,
    base: { def: 2, dodge: 0.03, exploreSpeed: 0.03 }, perLevel: { def: 0.4 },
    names: ['運動鞋', '軍靴', '登山靴', '雨靴', '安全鞋', '跑鞋', '戰術短靴', '消防靴'],
  },
  backpack: {
    name: '背包', slot: 'backpack', icon: '🎒', requires: null,
    base: { hp: 15, lootBonus: 0.05 }, perLevel: { hp: 4 },
    names: ['一級包', '二級包', '三級包', '登山包', '軍用背包', '書包', '腰包', '露營背包', '突擊背包'],
  },
  accessory: {
    name: '飾品', slot: 'accessory', icon: '📿', requires: null,
    base: { crit: 0.03, lootBonus: 0.03, hp: 10 }, perLevel: { hp: 3 },
    names: ['護身符', '軍牌', '戰術手錶', '夜視鏡', '無線電', '家人的照片', '幸運硬幣', '指南針', '防毒面具'],
  },
};

/**
 * 隨機詞綴。value 為等級 1、素質倍率 1 時的基準值，實際值 = (value + perLevel×(等級−1)) × 品級素質倍率。
 * pct=true 時以百分比顯示。
 */
export const AFFIXES = {
  atkFlat: { name: '攻擊', stat: 'atk', value: 3, perLevel: 0.6 },
  atkPct: { name: '攻擊%', stat: 'atkPct', value: 0.05, pct: true },
  hpFlat: { name: '生命', stat: 'hp', value: 18, perLevel: 4 },
  hpPct: { name: '生命%', stat: 'hpPct', value: 0.06, pct: true },
  defFlat: { name: '防禦', stat: 'def', value: 2, perLevel: 0.4 },
  defPct: { name: '防禦%', stat: 'defPct', value: 0.06, pct: true },
  crit: { name: '暴擊率', stat: 'crit', value: 0.03, pct: true },
  critDmg: { name: '暴擊傷害', stat: 'critDmg', value: 0.12, pct: true },
  dodge: { name: '閃避', stat: 'dodge', value: 0.025, pct: true },
  atkSpeed: { name: '攻速', stat: 'atkSpeed', value: 0.06 },
  lifeSteal: { name: '吸血', stat: 'lifeSteal', value: 0.03, pct: true },
  exploreSpeed: { name: '探索速度', stat: 'exploreSpeed', value: 0.04, pct: true },
  lootBonus: { name: '搜刮加成', stat: 'lootBonus', value: 0.05, pct: true },
};

/** 名稱前綴，依品級挑選 */
export const RARITY_PREFIX = {
  poor: ['破損的', '生鏽的', '粗糙的', '快壞的'],
  common: ['普通的', '堪用的', '標準'],
  uncommon: ['可靠的', '改良的', '堅固的'],
  rare: ['精良的', '強化的', '戰術'],
  epic: ['精英', '特種', '血染的', '罕見的'],
  legendary: ['末日', '不朽', '傳奇', '倖存者之'],
};
