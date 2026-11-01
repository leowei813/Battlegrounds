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
      { id: 'toughness', name: '堅韌', unlock: 12, desc: '生命 +15%', effect: { hpPct: 0.15 } },
      { id: 'veteran', name: '百戰老兵', unlock: 16, desc: '攻擊 +15%', effect: { atkPct: 0.15 } },
      { id: 'juggernaut', name: '不屈', unlock: 22, desc: '防禦 +20%、吸血 +5%', effect: { defPct: 0.2, lifeStealAdd: 0.05 } },
    ],
  },
  medic: {
    name: '醫生', icon: '⚕️', color: '#81c784',
    base: { hp: 110, atk: 9, def: 5, crit: 0.05, critDmg: 1.5, dodge: 0.08, atkSpeed: 0.9 },
    growth: { hp: 15, atk: 1.4, def: 0.8 },
    skills: [
      { id: 'heal', name: '急救', unlock: 1, desc: '每 4 秒治療生命最低的隊友', effect: { healEvery: 4, healPct: 0.12 } },
      { id: 'triage', name: '傷患分流', unlock: 5, desc: '隊伍受傷恢復時間 -40%', effect: { injuryReduce: 0.4 } },
      { id: 'pharma', name: '製藥', unlock: 8, desc: '駐守避難所時紗布 +2/時', effect: { medicinePerHour: 2 } },
      { id: 'vital', name: '生命專家', unlock: 12, desc: '生命 +12%、閃避 +3%', effect: { hpPct: 0.12, dodgeAdd: 0.03 } },
      { id: 'surgeon', name: '外科手術', unlock: 16, desc: '戰鬥中的急救治療量 +8%（最大生命比例）', effect: { healPct: 0.08 } },
      { id: 'apothecary', name: '藥劑大師', unlock: 22, desc: '駐守避難所時紗布再 +2/時', effect: { medicinePerHour: 2 } },
    ],
  },
  engineer: {
    name: '工程師', icon: '🔧', color: '#ffb74d',
    base: { hp: 120, atk: 11, def: 6, crit: 0.06, critDmg: 1.5, dodge: 0.05, atkSpeed: 1.0 },
    growth: { hp: 17, atk: 1.8, def: 1.0 },
    skills: [
      { id: 'repair', name: '維修', unlock: 1, desc: '修繕圍牆的速度 +50%', effect: { repairBonus: 0.5 } },
      { id: 'efficient', name: '高效施工', unlock: 4, desc: '建造費用 -10%', effect: { buildDiscount: 0.1 } },
      { id: 'overclock', name: '超頻', unlock: 8, desc: '防禦塔傷害 +15%', effect: { towerDmg: 0.15 } },
      { id: 'tinker', name: '精密改裝', unlock: 12, desc: '防禦塔傷害再 +10%', effect: { towerDmg: 0.1 } },
      { id: 'fortify', name: '加固專家', unlock: 16, desc: '修繕圍牆的速度再 +50%', effect: { repairBonus: 0.5 } },
      { id: 'mechAim', name: '機械瞄準', unlock: 22, desc: '攻擊 +15%、暴擊率 +5%', effect: { atkPct: 0.15, critAdd: 0.05 } },
    ],
  },
  farmer: {
    name: '農夫', icon: '🌱', color: '#aed581',
    base: { hp: 130, atk: 10, def: 6, crit: 0.04, critDmg: 1.5, dodge: 0.05, atkSpeed: 0.9 },
    growth: { hp: 19, atk: 1.5, def: 1.0 },
    skills: [
      { id: 'harvest', name: '豐收', unlock: 1, desc: '駐守時食物產量 +20%', effect: { foodPct: 0.2 } },
      { id: 'forage', name: '野外覓食', unlock: 4, desc: '探索時食物收穫 +30%', effect: { forage: 0.3 } },
      { id: 'herbal', name: '草藥種植', unlock: 8, desc: '駐守時紗布 +1/時', effect: { medicinePerHour: 1 } },
      { id: 'stamina', name: '吃苦耐勞', unlock: 12, desc: '生命 +15%', effect: { hpPct: 0.15 } },
      { id: 'bountiful', name: '大豐收', unlock: 16, desc: '駐守時食物產量再 +20%', effect: { foodPct: 0.2 } },
      { id: 'scavenger', name: '拾荒專家', unlock: 22, desc: '探索物資 +15%', effect: { lootPct: 0.15 } },
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
      { id: 'evasion', name: '閃避大師', unlock: 12, desc: '閃避 +5%', effect: { dodgeAdd: 0.05 } },
      { id: 'sniper', name: '狙擊', unlock: 16, desc: '暴擊率 +8%、攻擊 +10%', effect: { critAdd: 0.08, atkPct: 0.1 } },
      { id: 'treasure', name: '尋寶專家', unlock: 22, desc: '裝備掉落率 +25%、探索物資 +10%', effect: { itemPct: 0.25, lootPct: 0.1 } },
    ],
  },
};

export const CLASS_KEYS = Object.keys(CLASSES);

/**
 * 工作指派：倖存者閒置時可以在避難所工作。
 * produce：每小時基礎產出；classBonus：同職業時倍率。
 */
export const JOBS = {
  idle: { name: '閒置', icon: '💤', produce: {}, desc: '不做任何工作，在據點休息。' },
  scavenge: { name: '附近拾荒', icon: '🔍', desc: '在據點附近撿拾木材、廢鐵、粗布與燃料（偵察兵效率較高）。', produce: { wood: 2, scrap: 0.6, coarse: 0.4, fuel: 0.5 }, classBonus: { scout: 1.6 } },
  farm: { name: '農場工作', icon: '🌾', desc: '照顧作物，持續生產食物（農夫效率較高，部分技能還會提高農場產量）。', produce: { food: 4 }, classBonus: { farmer: 1.8 } },
  workshop: { name: '工作台', icon: '🛠️', desc: '在工作台加工，產出木材、釘子與螺絲（工程師效率較高）。', produce: { wood: 2, nail: 0.6, screw: 0.6 }, classBonus: { engineer: 1.8 } },
  clinic: { name: '醫療站', icon: '🏥', desc: '製作紗布與繃帶。醫生在醫療站工作時，全員的回復速度每人 +25%（最多 +100%）。', produce: { gauze: 0.4, bandage: 0.2 }, classBonus: { medic: 2 } },
  guard: { name: '防禦駐守', icon: '🛡️', desc: '留守主要據點：夜晚屍潮時一起攻擊殭屍、NPC 掠奪時參與防守，也算在警戒範圍的駐守人數（戰士效率較高）。', produce: {}, classBonus: { warrior: 1.5 } },
  repair: { name: '修繕圍牆', icon: '🔨', desc: '修理受損的圍牆，主要消耗木材（工程師效率較高；沒有零件時改用純木材、速度減半）。', produce: {}, classBonus: { engineer: 1.8 } },
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
/**
 * 品級：growth 每級成長倍率、base 基礎能力倍率、skills 可解放的技能數（每個職業共 6 個技能）。
 * 品級越高能力越好、可解放的技能越多。
 */
export const SURVIVOR_RARITY = {
  poor: { growth: 0.8, base: 0.9, skills: 1 },
  common: { growth: 0.9, base: 1, skills: 2 },
  uncommon: { growth: 1.0, base: 1.06, skills: 3 },
  rare: { growth: 1.15, base: 1.12, skills: 4 },
  epic: { growth: 1.3, base: 1.2, skills: 5 },
  legendary: { growth: 1.5, base: 1.3, skills: 6 },
};

/**
 * 倖存者品級機率（%）：初始稀有 0%、罕見 0.1%；研究「招募技術」每級提升，滿級稀有 0.2%。
 * @param {number} tech 招募技術等級 0～15（換算成 0～10 的進度）
 */
export function survivorRarityTable(tech = 0) {
  const t = (Math.max(0, Math.min(15, tech)) * 10) / 15;
  const legendary = 0.02 * t;
  const epic = 0.1 + 0.05 * t;
  const rare = 2 + 0.3 * t;
  const uncommon = 12 + t;
  const poor = 32 - 1.5 * t;
  return {
    poor, common: 100 - legendary - epic - rare - uncommon - poor, uncommon, rare, epic, legendary,
  };
}

/** 雇用費（金錢）：不論廣播招募或附近的倖存者，招募時都要另外支付；品級與等級越高越貴 */
export const HIRE_FEE_MUL = {
  poor: 0.6, common: 1, uncommon: 1.6, rare: 3, epic: 6, legendary: 12,
};
export const hireFee = (sv) => Math.round((40 + sv.level * 15) * (HIRE_FEE_MUL[sv.rarity] || 1));

/** 固定出現的可招募倖存者：每小時更新 */
export const RECRUIT_BOARD_SIZE = 2;
export const RECRUIT_BOARD_MS = 60 * 60 * 1000;
/** 廣播招募的候選人、探索遇到的倖存者停留時間（現實時間） */
export const RECRUIT_STAY_MS = 60 * 60 * 1000;

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
  regenPctPerMin: 0.02, // （舊）已改由診療室決定休息回復速度
  severeRegenPctPerMin: 0.008,
  medicCarePctPerMin: 0.001, // 醫生在據點或隊伍中照顧隊友：每分鐘回復 0.1%（比診療室慢，醫生等級越高越快）
  severeClinicMul: 0.6, // 重傷者在診療室的回復為一般的 60%
  severeRecoverRatio: 0.3, // 生命回到 30% 才解除重傷
  starveDrainPctPerMin: 0.04, // 飢餓時每分鐘流失最大生命 4%（約 25 分鐘歸零）
  xpPenaltyPct: 0.1, // 重傷懲罰：扣除升級所需經驗的 10%，不足時降一級
  deathGameDays: 3, // 飢餓且生命為 0 持續遊戲內 3 天 → 永久死亡（領袖除外）
  medicRegenBonus: 0.25, // 每位在醫療站工作的醫生，全員回復速度 +25%（上限 +100%）
};
/** 升級所需經驗：Lv4 以後大幅增加（每多一級 +50%），等級越高越困難 */
export const xpToNext = (level) => Math.round(40 * level ** 1.6 * (1 + (level / 20) ** 2) * (level <= 4 ? 1 : 1 + 0.5 * (level - 4)));
/** 招募費用（依目前人數） */
export const recruitCost = (count) => ({ coins: 60 + count * 45, food: 40 + count * 20 });
/** 人數對應每小時食物消耗 */
export const FOOD_PER_SURVIVOR_HOUR = 5;
/** 離線期間（以及分頁在背景超過 1 分鐘）每人每小時的食物消耗 */
export const FOOD_PER_SURVIVOR_HOUR_OFFLINE = 2;
/** 等級越高吃得越多：每高 1 級食物消耗 +3%（Lv10 約 ×1.27、Lv50 約 ×2.47） */
export const FOOD_LEVEL_STEP = 0.03;
export const foodLevelMul = (level = 1) => 1 + Math.max(0, level - 1) * FOOD_LEVEL_STEP;
