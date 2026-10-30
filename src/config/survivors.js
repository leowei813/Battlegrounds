/**
 * 倖存者職業。
 * base/growth：戰鬥屬性
 * jobs：可指派的工作與職業加成（match 時倍率）
 * skills：依等級解鎖的被動技能，effect 由 SurvivorSystem / CombatSystem 解讀
 */
export const CLASSES = {
  warrior: {
    name: '戰士', icon: '🛡️', color: '#e57373',
    base: { hp: 150, atk: 14, def: 8, crit: 0.05, critDmg: 1.5, dodge: 0.04, atkSpeed: 1.0 },
    growth: { hp: 22, atk: 2.4, def: 1.4 },
    skills: [
      { id: 'cleave', name: '橫掃', unlock: 1, desc: '攻擊有 20% 機率波及另一名敵人', effect: { cleaveChance: 0.2 } },
      { id: 'bulwark', name: '鋼鐵意志', unlock: 5, desc: '防禦 +20%', effect: { defPct: 0.2 } },
      { id: 'rage', name: '怒火', unlock: 10, desc: '生命低於 30% 時攻擊 +50%', effect: { rage: 0.5 } },
    ],
  },
  medic: {
    name: '醫生', icon: '⚕️', color: '#81c784',
    base: { hp: 110, atk: 9, def: 5, crit: 0.05, critDmg: 1.5, dodge: 0.08, atkSpeed: 0.9 },
    growth: { hp: 15, atk: 1.4, def: 0.8 },
    skills: [
      { id: 'heal', name: '急救', unlock: 1, desc: '每 4 秒治療生命最低的隊友', effect: { healEvery: 4, healPct: 0.12 } },
      { id: 'triage', name: '傷患分流', unlock: 5, desc: '隊伍受傷恢復時間 -40%', effect: { injuryReduce: 0.4 } },
      { id: 'pharma', name: '製藥', unlock: 8, desc: '駐守避難所時藥品 +2/時', effect: { medicinePerHour: 2 } },
    ],
  },
  engineer: {
    name: '工程師', icon: '🔧', color: '#ffb74d',
    base: { hp: 120, atk: 11, def: 6, crit: 0.06, critDmg: 1.5, dodge: 0.05, atkSpeed: 1.0 },
    growth: { hp: 17, atk: 1.8, def: 1.0 },
    skills: [
      { id: 'repair', name: '維修', unlock: 1, desc: '駐守時圍牆每秒修復 +0.5%', effect: { wallRegen: 0.005 } },
      { id: 'efficient', name: '高效施工', unlock: 4, desc: '建造費用 -10%', effect: { buildDiscount: 0.1 } },
      { id: 'overclock', name: '超頻', unlock: 8, desc: '防禦塔傷害 +15%', effect: { towerDmg: 0.15 } },
    ],
  },
  farmer: {
    name: '農夫', icon: '🌱', color: '#aed581',
    base: { hp: 130, atk: 10, def: 6, crit: 0.04, critDmg: 1.5, dodge: 0.05, atkSpeed: 0.9 },
    growth: { hp: 19, atk: 1.5, def: 1.0 },
    skills: [
      { id: 'harvest', name: '豐收', unlock: 1, desc: '駐守時食物產量 +20%', effect: { foodPct: 0.2 } },
      { id: 'forage', name: '野外覓食', unlock: 4, desc: '探索時食物收穫 +30%', effect: { forage: 0.3 } },
      { id: 'herbal', name: '草藥種植', unlock: 8, desc: '駐守時藥品 +1/時', effect: { medicinePerHour: 1 } },
    ],
  },
  scout: {
    name: '偵察兵', icon: '🔭', color: '#64b5f6',
    base: { hp: 105, atk: 13, def: 4, crit: 0.12, critDmg: 1.7, dodge: 0.14, atkSpeed: 1.15 },
    growth: { hp: 14, atk: 2.1, def: 0.7 },
    skills: [
      { id: 'pathfinder', name: '尋路', unlock: 1, desc: '隊伍探索時間 -15%', effect: { exploreSpeed: 0.15 } },
      { id: 'keenEye', name: '銳眼', unlock: 4, desc: '探索物資 +20%，裝備掉落率 +25%', effect: { lootPct: 0.2, itemPct: 0.25 } },
      { id: 'ambush', name: '伏擊', unlock: 8, desc: '戰鬥首擊必定暴擊', effect: { firstStrikeCrit: true } },
    ],
  },
};

export const CLASS_KEYS = Object.keys(CLASSES);

/**
 * 工作指派：倖存者閒置時可以在避難所工作。
 * produce：每小時基礎產出；classBonus：同職業時倍率。
 */
export const JOBS = {
  idle: { name: '閒置', icon: '💤', produce: {} },
  scavenge: { name: '附近拾荒', icon: '🔍', produce: { wood: 4, metal: 2, cloth: 2, fuel: 1 }, classBonus: { scout: 1.6 } },
  farm: { name: '農場工作', icon: '🌾', produce: { food: 10 }, classBonus: { farmer: 1.8 } },
  workshop: { name: '工作台', icon: '🛠️', produce: { wood: 4, metal: 4, cloth: 2 }, classBonus: { engineer: 1.8 } },
  clinic: { name: '醫療站', icon: '🏥', produce: { medicine: 1.5 }, classBonus: { medic: 2 } },
  guard: { name: '防禦駐守', icon: '🛡️', produce: {}, classBonus: { warrior: 1.5 } },
};

export const SURVIVOR_NAMES = [
  '阿傑', '小美', '老王', '志明', '春嬌', '阿豪', '雅婷', '建國', '淑芬', '俊傑',
  '怡君', '家豪', '宗翰', '佳穎', '冠宇', '詩涵', '彥廷', '欣怡', '承恩', '子晴',
  'Mike', 'Sarah', 'Ivan', 'Yuki', 'Leon', 'Ada', 'Chris', 'Jill', 'Hana', 'Omar',
];

export const MAX_SURVIVOR_LEVEL = 50;

/**
 * 倖存者品級（與裝備相同的 6 階與顏色）：品級越高，每次升級提升的能力越多。
 * growth 為等級成長倍率；weight 為招募/遭遇時出現的權重。
 */
export const SURVIVOR_RARITY = {
  poor: { growth: 0.8, weight: 25 },
  common: { growth: 0.9, weight: 35 },
  uncommon: { growth: 1.0, weight: 24 },
  rare: { growth: 1.15, weight: 11 },
  epic: { growth: 1.3, weight: 4 },
  legendary: { growth: 1.5, weight: 1 },
};

/** 人員上限：3 + 領袖等級 ÷ 5 + 各據點等級總和，最多 10 人（含領袖） */
export const MAX_SURVIVORS = 10;
export const BASE_SURVIVOR_CAP = 3;
export const LEADER_LEVELS_PER_SLOT = 5;
/** 一次招募出現的候選人數 */
export const RECRUIT_CHOICES = 3;

/**
 * 生命、重傷、飢餓、死亡（時間以現實分鐘計）。
 */
export const VITALS = {
  regenPctPerMin: 0.02, // 未飢餓時，每分鐘回復最大生命 2%
  severeRegenPctPerMin: 0.008, // 重傷時回復較慢
  severeRecoverRatio: 0.3, // 生命回到 30% 才解除重傷
  starveDrainPctPerMin: 0.04, // 飢餓時每分鐘流失最大生命 4%（約 25 分鐘歸零）
  healPct: 0.5, // 藥品治療回復最大生命 50%
  healCost: { medicine: 5 },
  xpPenaltyPct: 0.1, // 重傷懲罰：扣除升級所需經驗的 10%，不足時降一級
  deathGameDays: 3, // 飢餓且生命為 0 持續遊戲內 3 天 → 永久死亡（領袖除外）
  medicRegenBonus: 0.25, // 每位在醫療站工作的醫生，全員回復速度 +25%（上限 +100%）
};
export const xpToNext = (level) => Math.round(40 * level ** 1.6);
/** 招募費用（依目前人數） */
export const recruitCost = (count) => ({ coins: 60 + count * 45, food: 40 + count * 20 });
/** 人數對應每小時食物消耗 */
export const FOOD_PER_SURVIVOR_HOUR = 3;
