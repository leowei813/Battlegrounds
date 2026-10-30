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
