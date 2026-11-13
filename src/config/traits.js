/**
 * v16：倖存者特質與轉職。
 *
 * 特質：劣質～優良 1 個，精良以上 2 個（第 2 個只抽正面或混合）；指揮官固定「領袖氣質」＋1 個正面特質。
 *   type：pos 正面、mix 混合、neg 負面（抽中權重 3:2:1）
 *   fx：併入技能效果（skillEffects）的數值；條件型效果只在戰鬥中生效（不算進顯示的戰力）
 *     - teamAtk／teamDef／teamHp：同隊全員攻擊／防禦／生命（同隊有多位只算一次）
 *     - nightAtk／dayAtk：夜間（夜晚、午夜）或其他時段的攻擊
 *     - soloAll／groupAll：單人出隊時全能力、組隊時全能力
 *     - foodUse：自己的食物消耗；guardPct：擔任守衛時屍潮傷害；prodAll：避難所所有產量（多位只算一次）
 */
export const TRAIT_WEIGHT = { pos: 3, mix: 2, neg: 1 };

export const TRAITS = {
  sharpshooter: { name: '神射手', icon: '🏹', type: 'pos', desc: '暴擊率 +4%', fx: { critAdd: 0.04 } },
  ironwall: { name: '鐵壁', icon: '🛡️', type: 'pos', desc: '防禦 +8%', fx: { defPct: 0.08 } },
  sturdy: { name: '壯碩', icon: '💪', type: 'pos', desc: '生命 +8%', fx: { hpPct: 0.08 } },
  nimble: { name: '敏捷', icon: '🤸', type: 'pos', desc: '閃避 +3%', fx: { dodgeAdd: 0.03 } },
  lucky: { name: '幸運兒', icon: '🍀', type: 'pos', desc: '探索物資 +8%', fx: { lootPct: 0.08 } },
  craftsman: { name: '工匠', icon: '🔧', type: 'pos', desc: '修牆速度 +20%、建造費用 −3%', fx: { repairBonus: 0.2, buildDiscount: 0.03 } },
  ironGut: { name: '鐵胃', icon: '🍖', type: 'pos', desc: '自己的食物消耗 −20%', fx: { foodUse: -0.2 } },
  swift: { name: '飛毛腿', icon: '👟', type: 'pos', desc: '探索速度 +8%', fx: { exploreSpeed: 0.08 } },
  leader: { name: '領袖氣質', icon: '👑', type: 'pos', desc: '同隊全員攻擊、防禦 +3%（戰鬥時）', fx: { teamAtk: 0.03, teamDef: 0.03 } },
  homebody: { name: '戀家', icon: '🏠', type: 'pos', desc: '擔任守衛時屍潮傷害 +12%', fx: { guardPct: 0.12 } },
  nightOwl: { name: '夜貓子', icon: '🦉', type: 'mix', desc: '夜間戰鬥攻擊 +10%、白天 −5%', fx: { nightAtk: 0.1, dayAtk: -0.05 } },
  reckless: { name: '莽撞', icon: '😤', type: 'mix', desc: '攻擊 +8%、防禦 −8%', fx: { atkPct: 0.08, defPct: -0.08 } },
  timid: { name: '膽小', icon: '😰', type: 'mix', desc: '閃避 +4%、攻擊 −5%', fx: { dodgeAdd: 0.04, atkPct: -0.05 } },
  loner: { name: '獨行俠', icon: '🐺', type: 'mix', desc: '單人出隊全能力 +15%，組隊時 −3%', fx: { soloAll: 0.15, groupAll: -0.03 } },
  glutton: { name: '貪吃', icon: '🍗', type: 'mix', desc: '生命 +5%、自己的食物消耗 +20%', fx: { hpPct: 0.05, foodUse: 0.2 } },
  nightBlind: { name: '夜盲', icon: '🌑', type: 'neg', desc: '夜間戰鬥攻擊 −10%', fx: { nightAtk: -0.1 } },
  frail: { name: '嬌弱', icon: '🥀', type: 'neg', desc: '生命 −6%', fx: { hpPct: -0.06 } },
  clumsy: { name: '笨手笨腳', icon: '🫨', type: 'neg', desc: '暴擊率 −3%', fx: { critAdd: -0.03 } },
};
export const TRAIT_KEYS = Object.keys(TRAITS);

/** 個人任務解鎖等級：精良以上（含指揮官）Lv30，其他 Lv40 */
export const QUEST_LEVEL = { high: 30, low: 40 };

/**
 * 個人任務（各職業 3 步驟，同時計算）與轉職（二選一，永久）。
 * 步驟 key：wins 打贏的戰鬥、cleanWins 打贏且自己沒倒下、kills 擊殺、explores 完成探索、
 *   guardNights 擔任守衛撐過的屍潮夜晚、farmMin 耕作分鐘（現實時間）、hunts 獵殺殭屍群或搶到空投、dungeons 完成地下城
 */
export const CLASS_QUESTS = {
  warrior: {
    name: '戰士之路',
    steps: [
      { key: 'wins', need: 20, name: '身經百戰', desc: '打贏 20 場戰鬥' },
      { key: 'kills', need: 300, name: '屍山血海', desc: '擊殺 300 隻殭屍' },
      { key: 'dungeons', need: 1, name: '深入地底', desc: '完成一次地下城' },
    ],
    adv: [
      { id: 'tank', name: '重裝兵', icon: '🦾', desc: '防禦 +20%、生命 +10%', fx: { defPct: 0.2, hpPct: 0.1 } },
      { id: 'berserker', name: '狂戰士', icon: '🪓', desc: '攻擊 +15%、怒火加強', fx: { atkPct: 0.15, rage: 0.3 } },
    ],
  },
  medic: {
    name: '醫者之路',
    steps: [
      { key: 'explores', need: 20, name: '四處行醫', desc: '完成探索 20 次' },
      { key: 'cleanWins', need: 30, name: '屹立不倒', desc: '打贏 30 場且自己沒倒下' },
      { key: 'dungeons', need: 1, name: '深入地底', desc: '完成一次地下城' },
    ],
    adv: [
      { id: 'surgeon', name: '外科醫生', icon: '🩺', desc: '急救治療量 +10%', fx: { healPct: 0.1 } },
      { id: 'herbalist', name: '老中醫', icon: '🌿', desc: '隊伍生命 +8%（戰鬥時，同隊全員）', fx: { teamHp: 0.08 } },
    ],
  },
  engineer: {
    name: '工匠之路',
    steps: [
      { key: 'guardNights', need: 10, name: '堅守防線', desc: '擔任守衛撐過 10 晚屍潮' },
      { key: 'kills', need: 200, name: '火力壓制', desc: '擊殺 200 隻殭屍' },
      { key: 'dungeons', need: 1, name: '深入地底', desc: '完成一次地下城' },
    ],
    adv: [
      { id: 'demolition', name: '爆破專家', icon: '💣', desc: '防禦塔傷害 +20%', fx: { towerDmg: 0.2 } },
      { id: 'architect', name: '建築師', icon: '🏗️', desc: '建造費用 −10%、修牆速度 +50%', fx: { buildDiscount: 0.1, repairBonus: 0.5 } },
    ],
  },
  farmer: {
    name: '開墾之路',
    steps: [
      { key: 'farmMin', need: 24 * 60, name: '日出而作', desc: '耕作累計 24 小時（現實時間）' },
      { key: 'explores', need: 30, name: '遍地尋糧', desc: '完成探索 30 次' },
      { key: 'dungeons', need: 1, name: '深入地底', desc: '完成一次地下城' },
    ],
    adv: [
      { id: 'producer', name: '生產家', icon: '🏭', desc: '在家時避難所所有產量 +20%（多位不疊加）', fx: { prodAll: 0.2 } },
      { id: 'scavenger', name: '拾荒者', icon: '🎒', desc: '探索物資 +15%、野外覓食 +20%', fx: { lootPct: 0.15, forage: 0.2 } },
    ],
  },
  scout: {
    name: '斥候之路',
    steps: [
      { key: 'explores', need: 40, name: '踏遍廢墟', desc: '完成探索 40 次' },
      { key: 'hunts', need: 10, name: '獵手的眼睛', desc: '獵殺殭屍群或搶到空投 10 次' },
      { key: 'dungeons', need: 1, name: '深入地底', desc: '完成一次地下城' },
    ],
    adv: [
      { id: 'sniper', name: '狙擊手', icon: '🎯', desc: '攻擊 +12%、暴擊率 +3%', fx: { atkPct: 0.12, critAdd: 0.03 } },
      { id: 'pathfinder', name: '斥候', icon: '🦅', desc: '探索速度 +15%、閃避 +4%', fx: { exploreSpeed: 0.15, dodgeAdd: 0.04 } },
    ],
  },
};

/** 轉職 ID → 設定（含原職業） */
export const ADVANCED = Object.fromEntries(Object.entries(CLASS_QUESTS).flatMap(([cls, q]) => q.adv.map((a) => [a.id, { ...a, cls }])));

/** 依字串產生 0～1 的決定性亂數（同一位倖存者每次算出相同的特質） */
export function traitRandom(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  let s = h >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HIGH = ['rare', 'epic', 'legendary'];
/**
 * 抽特質：劣質～優良 1 個，精良以上 2 個（第 2 個只抽正面或混合）；指揮官固定領袖氣質＋1 個正面特質。
 * @param {string|null} rarity 品級（指揮官為 null）
 */
export function rollTraits(rarity, rnd = Math.random, leader = false) {
  const pickOne = (types, except = []) => {
    const keys = TRAIT_KEYS.filter((k) => types.includes(TRAITS[k].type) && !except.includes(k));
    const total = keys.reduce((s, k) => s + TRAIT_WEIGHT[TRAITS[k].type], 0);
    let x = rnd() * total;
    for (const k of keys) {
      x -= TRAIT_WEIGHT[TRAITS[k].type];
      if (x < 0) return k;
    }
    return keys[keys.length - 1];
  };
  if (leader) return ['leader', pickOne(['pos'], ['leader'])];
  const first = pickOne(['pos', 'mix', 'neg']);
  if (!HIGH.includes(rarity)) return [first];
  return [first, pickOne(['pos', 'mix'], [first])];
}
