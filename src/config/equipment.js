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
  armor: { name: '衣服', icon: '🦺' },
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
 * 裝備類別。base 為等級 1、強度 1 級的數值，perLevel 為每級成長；
 * 實際數值 = (base + perLevel × (等級−1)) × 型號強度倍率 × 品級素質倍率（負值不乘）。
 * gun：槍械製作需要研究「槍械製造」到該等級。
 */
export const ITEM_TYPES = {
  // ---- 武器 ----
  melee: { name: '近戰武器', slot: 'weapon', icon: '🪓', base: { atk: 11, atkSpeed: 0.1, crit: 0.08, lifeSteal: 0.03 }, perLevel: { atk: 1.9 } },
  crossbow: { name: '弓弩', slot: 'weapon', icon: '🏹', gun: 2, base: { atk: 18, atkSpeed: -0.2, crit: 0.12, critDmg: 0.2 }, perLevel: { atk: 2.8 } },
  pistol: { name: '手槍', slot: 'weapon', icon: '🔫', gun: 1, base: { atk: 9, atkSpeed: 0.25, crit: 0.05 }, perLevel: { atk: 1.6 } },
  smg: { name: '衝鋒槍', slot: 'weapon', icon: '🔫', gun: 3, base: { atk: 8, atkSpeed: 0.55, crit: 0.04 }, perLevel: { atk: 1.5 } },
  shotgun: { name: '散彈槍', slot: 'weapon', icon: '💥', gun: 4, base: { atk: 22, atkSpeed: -0.15, crit: 0.03 }, perLevel: { atk: 3.6 } },
  rifle: { name: '步槍', slot: 'weapon', icon: '🪖', gun: 5, base: { atk: 15, atkSpeed: 0.15, crit: 0.06 }, perLevel: { atk: 2.6 } },
  sniper: { name: '狙擊槍', slot: 'weapon', icon: '🎯', gun: 7, base: { atk: 34, atkSpeed: -0.35, crit: 0.18, critDmg: 0.5 }, perLevel: { atk: 5 } },
  lmg: { name: '輕機槍', slot: 'weapon', icon: '⚙️', gun: 9, base: { atk: 17, atkSpeed: 0.4, crit: 0.03 }, perLevel: { atk: 2.9 } },
  // ---- 防具 ----
  helmet: { name: '頭盔', slot: 'helmet', icon: '⛑️', base: { def: 4, hp: 20 }, perLevel: { def: 0.8, hp: 5 } },
  armor: { name: '衣服', slot: 'armor', icon: '🦺', base: { def: 7, hp: 40 }, perLevel: { def: 1.4, hp: 9 } },
  legs: { name: '護腿', slot: 'legs', icon: '👖', base: { def: 3, dodge: 0.03 }, perLevel: { def: 0.6 } },
  gloves: { name: '手套', slot: 'gloves', icon: '🧤', base: { atk: 3, crit: 0.03 }, perLevel: { atk: 0.5 } },
  boots: { name: '鞋子', slot: 'boots', icon: '🥾', base: { def: 2, dodge: 0.03, exploreSpeed: 0.03 }, perLevel: { def: 0.4 } },
  backpack: { name: '背包', slot: 'backpack', icon: '🎒', base: { hp: 15, lootBonus: 0.03 }, perLevel: { hp: 4 } },
  accessory: { name: '飾品', slot: 'accessory', icon: '📿', base: { crit: 0.03, lootBonus: 0.03, hp: 10 }, perLevel: { hp: 3 } },
};

/**
 * 具體型號：tier 1～10 為強度與取得難度（越強越難掉落、越需要高等工作台）。
 *  - simple   簡易製作：不需要工作台
 *  - extra    額外固定屬性（例如背包的運載量 carry）
 *  - fuel     每場戰鬥消耗的燃料（電鋸），燃料不足時威力大減
 */
const m = (type, name, tier, opts = {}) => ({ type, name, tier, ...opts });
export const ITEM_MODELS = {
  // 近戰
  knuckles: m('melee', '拳套', 1, { icon: '🥊', simple: true }),
  knife: m('melee', '小刀', 1, { icon: '🔪', simple: true }),
  cleaver: m('melee', '菜刀', 2, { icon: '🔪' }),
  bat: m('melee', '球棒', 3, { icon: '🏏' }),
  pipe: m('melee', '水管', 3, { icon: '🪈' }),
  shovel: m('melee', '鐵鍬', 4, { icon: '⛏️' }),
  machete: m('melee', '開山刀', 5, { icon: '🗡️' }),
  axe: m('melee', '斧頭', 6, { icon: '🪓' }),
  katana: m('melee', '武士刀', 8, { icon: '⚔️' }),
  chainsaw: m('melee', '電鋸', 10, { icon: '🪚', fuel: 3 }),
  // 弓弩
  woodBow: m('crossbow', '簡易木弓', 1, { simple: true }),
  recurve: m('crossbow', '反曲弓', 2),
  huntXbow: m('crossbow', '獵弩', 3),
  pistolXbow: m('crossbow', '手槍弩', 3),
  compound: m('crossbow', '複合弓', 4),
  huntCompound: m('crossbow', '狩獵複合弓', 5),
  tacXbow: m('crossbow', '戰術十字弓', 6),
  repeater: m('crossbow', '連弩', 7),
  heavyXbow: m('crossbow', '重型弩', 8),
  carbonXbow: m('crossbow', '碳纖維複合弩', 10),
  // 手槍
  revolver: m('pistol', '左輪手槍', 1),
  m1911: m('pistol', 'M1911', 2),
  m9: m('pistol', 'Beretta M9', 3),
  glock17: m('pistol', 'Glock 17', 3),
  usp: m('pistol', 'USP', 4),
  p226: m('pistol', 'P226', 5),
  cz75: m('pistol', 'CZ 75', 5),
  fiveSeven: m('pistol', 'FN Five-seveN', 6),
  deagle: m('pistol', '沙漠之鷹', 8),
  glock18: m('pistol', 'Glock 18C', 10),
  // 衝鋒槍
  mac10: m('smg', 'MAC-10', 2),
  skorpion: m('smg', 'Skorpion', 2),
  uzi: m('smg', 'UZI', 3),
  thompson: m('smg', 'Thompson', 3),
  bizon: m('smg', 'PP-19 Bizon', 4),
  ump45: m('smg', 'UMP45', 5),
  mp5: m('smg', 'MP5', 5),
  mp7: m('smg', 'MP7', 6),
  p90: m('smg', 'P90', 7),
  vector: m('smg', 'Vector', 8),
  // 散彈槍
  sawedOff: m('shotgun', '短管獵槍', 2),
  s1897: m('shotgun', 'S1897', 3),
  s686: m('shotgun', 'S686', 3),
  m870: m('shotgun', 'M870', 4),
  m1014: m('shotgun', 'M1014', 5),
  saiga: m('shotgun', 'Saiga-12', 6),
  spas12: m('shotgun', 'SPAS-12', 6),
  ksg: m('shotgun', 'KSG', 7),
  dbs: m('shotgun', 'DBS', 8),
  aa12: m('shotgun', 'AA-12', 9),
  // 步槍
  mini14: m('rifle', 'Mini14', 3),
  sks: m('rifle', 'SKS', 3),
  ak47: m('rifle', 'AK-47', 4),
  m16: m('rifle', 'M16A4', 5),
  t91: m('rifle', 'T91', 5),
  qbz95: m('rifle', 'QBZ-95', 5),
  famas: m('rifle', 'FAMAS', 6),
  g36c: m('rifle', 'G36C', 6),
  m4a1: m('rifle', 'M4A1', 7),
  aug: m('rifle', 'AUG', 8),
  scarL: m('rifle', 'SCAR-L', 8),
  hk416: m('rifle', 'HK416', 9),
  // 狙擊槍
  win94: m('sniper', 'Win94', 4),
  mosin: m('sniper', 'Mosin-Nagant', 4),
  kar98k: m('sniper', 'Kar98k', 5),
  svd: m('sniper', 'SVD', 5),
  m24: m('sniper', 'M24', 6),
  slr: m('sniper', 'SLR', 6),
  mk14: m('sniper', 'Mk14 EBR', 7),
  l96: m('sniper', 'L96A1', 8),
  awm: m('sniper', 'AWM', 9),
  barrett: m('sniper', 'Barrett M82', 10),
  // 輕機槍
  dp28: m('lmg', 'DP-28', 5),
  mg3: m('lmg', 'MG3', 6),
  rpk: m('lmg', 'RPK', 6),
  ultimax: m('lmg', 'Ultimax 100', 7),
  m249: m('lmg', 'M249', 7),
  negev: m('lmg', 'Negev', 8),
  pkm: m('lmg', 'PKM', 8),
  m60: m('lmg', 'M60', 8),
  mg4: m('lmg', 'MG4', 9),
  m134: m('lmg', 'M134 迷你砲', 10),
  // 頭盔
  cap: m('helmet', '棒球帽', 1, { icon: '🧢', simple: true }),
  bikeHelmet: m('helmet', '機車安全帽', 2),
  hardHat: m('helmet', '工地安全帽', 2, { icon: '⛑️' }),
  fireHelmet: m('helmet', '消防頭盔', 3),
  helmet1: m('helmet', '一級頭', 4),
  riotHelmet: m('helmet', '防暴頭盔', 5),
  helmet2: m('helmet', '二級頭', 6),
  tacHelmet: m('helmet', '戰術頭盔', 7),
  helmet3: m('helmet', '三級頭', 8),
  nvgHelmet: m('helmet', '夜視頭盔', 9),
  titanHelmet: m('helmet', '鈦合金頭盔', 10),
  // 衣服
  tshirt: m('armor', 'T恤', 1, { icon: '👕', simple: true }),
  hoodie: m('armor', '帽T', 1, { icon: '🧥', simple: true }),
  leatherJacket: m('armor', '皮夾克', 2, { icon: '🧥' }),
  coverall: m('armor', '工作服', 2),
  stabVest: m('armor', '防刺背心', 3),
  vest1: m('armor', '一級甲', 4),
  tacVest: m('armor', '戰術背心', 5),
  kevlar: m('armor', '凱夫拉背心', 6),
  vest2: m('armor', '二級甲', 7),
  vest3: m('armor', '三級甲', 8),
  ceramic: m('armor', '陶瓷插板背心', 9),
  eodSuit: m('armor', '重型防爆服', 10),
  // 護腿
  jeans: m('legs', '牛仔褲', 1, { simple: true }),
  sweatpants: m('legs', '運動褲', 1, { simple: true }),
  workPants: m('legs', '工作褲', 2),
  hikingPants: m('legs', '登山褲', 2),
  camoPants: m('legs', '迷彩褲', 3),
  kneePads: m('legs', '機車護膝', 4),
  tacLegs: m('legs', '戰術護腿', 5),
  stabLegs: m('legs', '防刺護腿', 6),
  lightArmorLegs: m('legs', '輕量護甲', 7),
  riotLegs: m('legs', '防爆護腿', 9),
  exoLegs: m('legs', '外骨骼護腿', 10),
  // 手套
  clothGloves: m('gloves', '布手套', 1, { simple: true }),
  workGloves: m('gloves', '工作手套', 1, { simple: true }),
  leatherGloves: m('gloves', '皮革手套', 2),
  wraps: m('gloves', '拳擊繃帶', 3),
  bikeGloves: m('gloves', '機車手套', 3),
  cutGloves: m('gloves', '防割手套', 4),
  shootGloves: m('gloves', '射擊手套', 5),
  tacGloves: m('gloves', '戰術手套', 6),
  knuckleGloves: m('gloves', '鋼指虎手套', 7),
  kevlarGloves: m('gloves', '凱夫拉手套', 8),
  exoGloves: m('gloves', '外骨骼手套', 10),
  // 鞋子
  slippers: m('boots', '拖鞋', 1, { icon: '🩴', simple: true }),
  sneakers: m('boots', '運動鞋', 1, { icon: '👟', simple: true }),
  rainBoots: m('boots', '雨靴', 2),
  runners: m('boots', '跑鞋', 3, { icon: '👟' }),
  safetyShoes: m('boots', '安全鞋', 3),
  hikingBoots: m('boots', '登山靴', 4),
  fireBoots: m('boots', '消防靴', 5),
  combatBoots: m('boots', '軍靴', 6),
  tacBoots: m('boots', '戰術短靴', 7),
  paraBoots: m('boots', '傘兵靴', 8),
  exoBoots: m('boots', '外骨骼靴', 10),
  // 背包（七種大小）：carry 為增加的運載量
  waistPack: m('backpack', '腰包', 1, { simple: true, extra: { carry: 10 } }),
  schoolBag: m('backpack', '書包', 2, { simple: true, extra: { carry: 20 } }),
  pack1: m('backpack', '一級包', 3, { extra: { carry: 35 } }),
  hikingPack: m('backpack', '登山包', 5, { extra: { carry: 55 } }),
  pack2: m('backpack', '二級包', 6, { extra: { carry: 75 } }),
  militaryPack: m('backpack', '軍用背包', 8, { extra: { carry: 100 } }),
  pack3: m('backpack', '三級包', 10, { extra: { carry: 140 } }),
  // 飾品
  luckyCoin: m('accessory', '幸運硬幣', 1, { simple: true }),
  photo: m('accessory', '家人的照片', 1, { simple: true }),
  amulet: m('accessory', '護身符', 2),
  dogTag: m('accessory', '軍牌', 3),
  compass: m('accessory', '指南針', 3),
  radio: m('accessory', '無線電', 4),
  gasMask: m('accessory', '防毒面具', 5),
  tacWatch: m('accessory', '戰術手錶', 6),
  nvg: m('accessory', '夜視鏡', 8),
};
export const MODEL_KEYS = Object.keys(ITEM_MODELS);

/** 型號強度倍率：tier 1 = 1、tier 10 = 3.25 */
export const tierMul = (tier) => 1 + (tier - 1) * 0.25;

/** 製作型號需要的工作台等級（簡易製作為 0） */
export const benchFor = (model) => (model.simple ? 0 : model.tier);

/**
 * 製作的品級機率（%）：初始稀有 0%、罕見 0.1%；研究「製作技術」每級提升，滿級稀有 0.2%。
 * @param {number} tech 製作技術等級 0～10
 */
export function craftRarityTable(tech = 0) {
  const t = Math.max(0, Math.min(10, tech));
  const legendary = 0.02 * t;
  const epic = 0.1 + 0.05 * t;
  const rare = 4.9 + 0.4 * t;
  const uncommon = 15 + t;
  const poor = 40 - 1.5 * t;
  return {
    poor, common: 100 - legendary - epic - rare - uncommon - poor, uncommon, rare, epic, legendary,
  };
}

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
