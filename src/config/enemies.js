/**
 * 敵人資料。數值為等級 1 基準，CombatSystem 依等級與危險度縮放。
 */
export const ENEMIES = {
  walker: {
    name: '普通殭屍', icon: '🧟', color: 0x7cb342, tier: 1,
    hp: 60, atk: 8, def: 2, crit: 0.02, dodge: 0.02, atkSpeed: 0.7, speed: 9,
    xp: 6, coins: 2, partsChance: 0.02,
  },
  infected: {
    name: '感染者', icon: '🧟‍♀️', color: 0x9ccc65, tier: 1,
    hp: 75, atk: 11, def: 3, crit: 0.05, dodge: 0.06, atkSpeed: 0.9, speed: 12,
    xp: 9, coins: 3, partsChance: 0.03,
  },
  berserker: {
    name: '狂暴者', icon: '👹', color: 0xe53935, tier: 2,
    hp: 110, atk: 20, def: 4, crit: 0.12, dodge: 0.1, atkSpeed: 1.3, speed: 20,
    xp: 18, coins: 6, partsChance: 0.06,
  },
  mutant: {
    name: '變異體', icon: '🦠', color: 0x8e24aa, tier: 3,
    hp: 260, atk: 26, def: 12, crit: 0.08, dodge: 0.03, atkSpeed: 0.6, speed: 7,
    xp: 35, coins: 12, partsChance: 0.15,
  },
  nightStalker: {
    name: '夜魔', icon: '🦇', color: 0x37474f, tier: 3, nightOnly: true,
    hp: 200, atk: 34, def: 8, crit: 0.2, dodge: 0.25, atkSpeed: 1.4, speed: 24,
    xp: 50, coins: 18, partsChance: 0.25,
  },
};

/** Boss 清單：僅出現在特殊區域或作為精英事件 */
export const BOSSES = {
  tankBoss: {
    name: '坦克屍', icon: '🦍', color: 0x5d4037, tier: 5, boss: true,
    hp: 1400, atk: 45, def: 22, crit: 0.1, dodge: 0.02, atkSpeed: 0.5, speed: 6,
    xp: 300, coins: 120, partsChance: 1,
  },
  witchBoss: {
    name: '尖嘯女王', icon: '👸', color: 0xd81b60, tier: 5, boss: true,
    hp: 900, atk: 60, def: 10, crit: 0.25, dodge: 0.15, atkSpeed: 0.9, speed: 10,
    xp: 300, coins: 120, partsChance: 1,
  },
  generalBoss: {
    name: '屍化將軍', icon: '🎖️', color: 0x33691e, tier: 6, boss: true,
    hp: 1800, atk: 55, def: 28, crit: 0.15, dodge: 0.08, atkSpeed: 0.8, speed: 8,
    xp: 450, coins: 200, partsChance: 1,
  },
};

export const ALL_ENEMIES = { ...ENEMIES, ...BOSSES };

/** 精英怪倍率 */
export const ELITE_MUL = { hp: 2.4, atk: 1.6, def: 1.5, xp: 3, coins: 3 };

/** 殭屍對倖存者的攻擊強度倍率（探索、地圖殭屍群、破牆後交戰） */
export const ZOMBIE_VS_SURVIVOR = { atk: 1.3 };
/** 防禦減傷：受到的傷害 = 攻擊 × 100 ÷（100 + 防禦 × defFactor） */
export const COMBAT_TUNING = { defFactor: 0.5 };
/** 據點防守戰（掠奪、突襲）倒下的人：各有此機率重傷，其餘以剩下的生命比例撐住（守住或戰敗都適用） */
export const HOME_DEFENSE_DOWN = { severeChance: 0.3, hpPct: 0.2 };
export const defReduce = (def) => 100 / (100 + Math.max(0, def) * COMBAT_TUNING.defFactor);
/** 夜晚的危險度：基本倍率，區域每高一級再增加 */
export const NIGHT_MUL = { hp: 1.2, atk: 1.25, perDanger: 0.12 };
/**
 * 建築內的殭屍依區域危險度加強（不分日夜）：額外等級與生命／攻擊倍率。
 * 區域危險度：-1 安全、0 一般、1 警戒、2 危險、3 致死
 */
export const BUILDING_ZONE = {
  extraLevel: { 1: 6, 2: 15, 3: 28 },
  statMul: { 1: 1.9, 2: 3.2, 3: 2.15 },
};
/**
 * 白天（沒有夜間加成時）建築內的區域加成（v10.13）：高危區白天也有風險。
 *  - encounter：遭遇殭屍／精英的機率倍率（夜晚改用夜晚的區域倍率）
 *  - level：殭屍等級加成（上限一起提高）
 *  - stat：殭屍生命、攻擊倍率
 */
export const DAY_ZONE = {
  encounter: { safe: 0.6, normal: 1, alert: 1.2, danger: 1.4, lethal: 1.6, abyss: 2 },
  level: { safe: 0, normal: 0, alert: 0, danger: 2, lethal: 4, abyss: 6 },
  stat: { safe: 1, normal: 1, alert: 1.05, danger: 1.1, lethal: 1.2, abyss: 1.3 },
};
/** 夜晚地圖上的殭屍群：一般、精英、Boss 的額外強度 */
export const MAP_GROUP_MUL = {
  normal: { hp: 1.3, atk: 1.3 },
  elite: { hp: 1.8, atk: 1.4 },
  boss: { hp: 5, atk: 2.5 }, // v15.11：原 ×2.6／×1.8
};

/** 合併強度倍率 */
export const mulOf = (...list) => list.filter(Boolean).reduce((a, m) => ({ hp: a.hp * (m.hp || 1), atk: a.atk * (m.atk || 1) }), { hp: 1, atk: 1 });

/** 人類敵人：NPC 據點的掠奪者（不會出現在屍潮或一般探索中） */
export const RAIDERS = {
  raider: {
    name: '掠奪者', icon: '🥷', color: 0x6d4c41, tier: 2,
    hp: 190, atk: 30, def: 14, crit: 0.12, dodge: 0.12, atkSpeed: 1.1, speed: 12,
    xp: 18, coins: 4, partsChance: 0.08, ranged: true,
  },
  raiderChief: {
    name: '掠奪者首領', icon: '🦹', color: 0x4e342e, tier: 4,
    hp: 760, atk: 58, def: 30, crit: 0.18, dodge: 0.12, atkSpeed: 1.1, speed: 10,
    xp: 90, coins: 15, partsChance: 0.5, ranged: true,
  },
};
Object.assign(ALL_ENEMIES, RAIDERS);
