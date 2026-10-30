/**
 * 裝備資料：品質、類型、詞綴。
 */
export const RARITIES = {
  common: { name: '普通', color: '#b0bec5', mul: 1, affixes: 0, weight: 55, sell: 5 },
  uncommon: { name: '優秀', color: '#66bb6a', mul: 1.2, affixes: 1, weight: 28, sell: 12 },
  rare: { name: '稀有', color: '#42a5f5', mul: 1.45, affixes: 2, weight: 12, sell: 30 },
  epic: { name: '史詩', color: '#ab47bc', mul: 1.75, affixes: 3, weight: 4, sell: 80 },
  legendary: { name: '傳說', color: '#ffa726', mul: 2.2, affixes: 4, weight: 1, sell: 250 },
};
export const RARITY_ORDER = Object.keys(RARITIES);

export const SLOTS = {
  weapon: { name: '武器', icon: '🔫' },
  helmet: { name: '頭盔', icon: '⛑️' },
  armor: { name: '防彈衣', icon: '🦺' },
  legs: { name: '護腿', icon: '👖' },
  backpack: { name: '背包', icon: '🎒' },
};
export const SLOT_KEYS = Object.keys(SLOTS);

/**
 * base 為等級 1 數值，perLevel 為每級成長。
 * requires：製作時需要的研究 ID（掉落不受限）。
 */
export const ITEM_TYPES = {
  pistol: {
    name: '手槍', slot: 'weapon', icon: '🔫', requires: null,
    base: { atk: 9, atkSpeed: 0.25, crit: 0.05 }, perLevel: { atk: 1.6 },
    names: ['M1911', 'Glock 17', 'USP', '沙漠之鷹', 'P226'],
  },
  rifle: {
    name: '步槍', slot: 'weapon', icon: '🪖', requires: 'wpn1',
    base: { atk: 15, atkSpeed: 0.15, crit: 0.06 }, perLevel: { atk: 2.6 },
    names: ['M4A1', 'AK-47', 'SCAR-L', 'AUG', 'M16A4'],
  },
  shotgun: {
    name: '散彈槍', slot: 'weapon', icon: '💥', requires: 'wpn2',
    base: { atk: 22, atkSpeed: -0.15, crit: 0.03 }, perLevel: { atk: 3.6 },
    names: ['S686', 'S1897', 'M870', 'SPAS-12', 'Saiga-12'],
  },
  sniper: {
    name: '狙擊槍', slot: 'weapon', icon: '🎯', requires: 'wpn3',
    base: { atk: 34, atkSpeed: -0.35, crit: 0.18, critDmg: 0.5 }, perLevel: { atk: 5 },
    names: ['Kar98k', 'AWM', 'M24', 'SVD', 'Barrett'],
  },
  helmet: {
    name: '頭盔', slot: 'helmet', icon: '⛑️', requires: null,
    base: { def: 4, hp: 20 }, perLevel: { def: 0.8, hp: 5 },
    names: ['一級頭', '二級頭', '三級頭', '戰術頭盔', '防暴頭盔'],
  },
  armor: {
    name: '防彈衣', slot: 'armor', icon: '🦺', requires: null,
    base: { def: 7, hp: 40 }, perLevel: { def: 1.4, hp: 9 },
    names: ['一級甲', '二級甲', '三級甲', '凱夫拉背心', '陶瓷插板'],
  },
  legs: {
    name: '護腿', slot: 'legs', icon: '👖', requires: null,
    base: { def: 3, dodge: 0.03 }, perLevel: { def: 0.6 },
    names: ['工作褲', '戰術護腿', '迷彩褲', '防刺護腿', '輕量護甲'],
  },
  backpack: {
    name: '背包', slot: 'backpack', icon: '🎒', requires: null,
    base: { hp: 15, lootBonus: 0.05 }, perLevel: { hp: 4 },
    names: ['一級包', '二級包', '三級包', '登山包', '軍用背包'],
  },
};

/**
 * 隨機詞綴。value 為品質倍率 1、等級 1 的基準值。
 * pct=true 時以百分比顯示。
 */
export const AFFIXES = {
  atkFlat: { name: '攻擊', stat: 'atk', value: 3, perLevel: 0.6 },
  atkPct: { name: '攻擊%', stat: 'atkPct', value: 0.05, pct: true },
  hpFlat: { name: '生命', stat: 'hp', value: 18, perLevel: 4 },
  hpPct: { name: '生命%', stat: 'hpPct', value: 0.06, pct: true },
  defFlat: { name: '防禦', stat: 'def', value: 2, perLevel: 0.4 },
  crit: { name: '暴擊率', stat: 'crit', value: 0.03, pct: true },
  critDmg: { name: '暴擊傷害', stat: 'critDmg', value: 0.12, pct: true },
  dodge: { name: '閃避', stat: 'dodge', value: 0.025, pct: true },
  atkSpeed: { name: '攻速', stat: 'atkSpeed', value: 0.06 },
  lootBonus: { name: '搜刮加成', stat: 'lootBonus', value: 0.05, pct: true },
};

/** 詞綴前綴（名稱用），依品質挑選 */
export const RARITY_PREFIX = {
  common: ['破舊的', '普通的', '生鏽的'],
  uncommon: ['可靠的', '改良的', '堅固的'],
  rare: ['精良的', '強化的', '戰術'],
  epic: ['精英', '特種', '血染的'],
  legendary: ['末日', '不朽', '傳奇', '倖存者之'],
};
