/**
 * 研究樹：10 個分支、78 項科技，每項都有等級（大多最高 10 級）。
 *
 *  - tier       1～4，決定需要的研究中心等級（tier n 需 Lv n×2−1）；第 L 級另需研究中心 Lv L 以上
 *  - effects    每一級提供的數值（等級越高效果越大，累加）
 *  - unlock     第 1 級解鎖的功能旗標
 *  - requires   前置科技與需要的等級
 *  - maxLevel   最高等級（預設 10）
 * 費用每級 ×1.6、時間每級 ×1.4。
 */
export const RESEARCH_BRANCHES = {
  weapons: { name: '武器科技', icon: '🔫' },
  defense: { name: '防禦科技', icon: '🛡️' },
  medical: { name: '醫療科技', icon: '💉' },
  agriculture: { name: '農業科技', icon: '🌾' },
  industry: { name: '工業科技', icon: '🏭' },
  survival: { name: '生存科技', icon: '🧭' },
  vehicles: { name: '載具科技', icon: '🚗' },
  crafting: { name: '製作科技', icon: '🛠️' },
  recruitment: { name: '招募科技', icon: '📻' },
  expansion: { name: '擴張科技', icon: '🏴' },
};

export const MAX_RESEARCH_LEVEL = 10;

/** 各分支的研究材料（第 1 級基準量 = 數值 × 分階倍率） */
const BRANCH_COST = {
  weapons: { metal: 1, wood: 0.5 },
  defense: { wood: 1, metal: 0.8 },
  medical: { medicine: 0.3, cloth: 0.8 },
  agriculture: { food: 1, wood: 0.6 },
  industry: { wood: 0.8, metal: 0.8, cloth: 0.4 },
  survival: { food: 0.8, cloth: 0.8 },
  vehicles: { metal: 1, fuel: 0.4 },
  crafting: { metal: 0.8, cloth: 0.6, wood: 0.6 },
  recruitment: { coins: 1, food: 0.8 },
  expansion: { wood: 1.4, metal: 1, cloth: 0.6 },
};
const TIER_AMOUNT = [0, 60, 150, 350, 700];
const TIER_PARTS = [0, 0, 1, 3, 6];
const TIER_TIME = [0, 90, 240, 600, 1200];

const r = (branch, tier, name, desc, effects, opts = {}) => ({
  branch, tier, name, desc, effects, maxLevel: opts.max || MAX_RESEARCH_LEVEL,
  requires: opts.req || [], unlock: opts.unlock || [], costMul: opts.costMul || 1,
});

export const RESEARCH = {
  // ---- 武器 ----
  w_atk: r('weapons', 1, '戰鬥訓練', '全隊攻擊提升', { atkPct: 0.02 }),
  w_crit: r('weapons', 1, '弱點打擊', '暴擊率提升', { critAdd: 0.006 }),
  w_melee: r('weapons', 1, '近戰精通', '近戰武器攻擊提升', { catAtk_melee: 0.04 }),
  w_pistol: r('weapons', 1, '手槍精通', '手槍攻擊提升', { catAtk_pistol: 0.04 }),
  w_crossbow: r('weapons', 1, '弓弩精通', '十字弓攻擊提升', { catAtk_crossbow: 0.04 }),
  w_critdmg: r('weapons', 2, '致命一擊', '暴擊傷害提升', { critDmgAdd: 0.04 }, { req: [['w_crit', 3]] }),
  w_speed: r('weapons', 2, '快速裝填', '攻擊速度提升', { atkSpeedAdd: 0.02 }, { req: [['w_atk', 2]] }),
  w_smg: r('weapons', 2, '衝鋒槍精通', '衝鋒槍攻擊提升', { catAtk_smg: 0.04 }, { req: [['w_pistol', 2]] }),
  w_shotgun: r('weapons', 2, '散彈槍精通', '散彈槍攻擊提升', { catAtk_shotgun: 0.04 }, { req: [['w_pistol', 2]] }),
  w_rifle: r('weapons', 2, '步槍精通', '步槍攻擊提升', { catAtk_rifle: 0.04 }, { req: [['w_pistol', 3]] }),
  w_sniper: r('weapons', 3, '狙擊精通', '狙擊槍攻擊提升', { catAtk_sniper: 0.04 }, { req: [['w_rifle', 3]] }),
  w_lifesteal: r('weapons', 3, '嗜血', '攻擊時吸血', { lifeStealAdd: 0.004 }, { req: [['w_melee', 3]] }),
  w_lmg: r('weapons', 4, '機槍精通', '輕機槍攻擊提升', { catAtk_lmg: 0.04 }, { req: [['w_rifle', 5]] }),
  // ---- 防禦 ----
  d_wall: r('defense', 1, '加固工事', '圍牆耐久提升', { wallHpPct: 0.05 }),
  d_repair: r('defense', 1, '快速修補', '修繕圍牆速度提升、耗材降低', { repairPct: 0.1 }),
  d_trap: r('defense', 1, '陷阱工藝', '陷阱傷害提升', { defDmg_trap: 0.06 }),
  d_mg: r('defense', 1, '機槍塔', '解鎖機槍塔，並提升機槍塔傷害', { defDmg_machineGun: 0.05 }, { unlock: ['machineGun'] }),
  d_tower: r('defense', 2, '火力強化', '所有防禦塔傷害提升', { towerDmgPct: 0.04 }, { req: [['d_mg', 2]] }),
  d_range: r('defense', 2, '射程延伸', '防禦塔射程提升', { towerRangePct: 0.03 }, { req: [['d_mg', 2]] }),
  d_armor: r('defense', 2, '減傷結構', '圍牆減傷提升', { wallReduceAdd: 0.01 }, { req: [['d_wall', 3]] }),
  d_guard: r('defense', 2, '守備訓練', '防禦駐守與瞭望塔駐守傷害提升', { guardDmgPct: 0.05 }),
  d_npc: r('defense', 2, '反掠奪', '對 NPC 掠奪隊的防禦傷害提升', { raidDefensePct: 0.08 }),
  d_flame: r('defense', 2, '燃燒劑', '解鎖火焰塔，並提升火焰塔傷害', { defDmg_flameTower: 0.05 }, { unlock: ['flameTower'], req: [['d_mg', 3]] }),
  d_em: r('defense', 3, '電磁學', '解鎖電磁塔，並提升電磁塔傷害', { defDmg_emTower: 0.05 }, { unlock: ['emTower'], req: [['d_flame', 3]] }),
  d_offline: r('defense', 3, '夜間自動防禦', '解鎖離線防守收益，並提升離線擊殺數', { offlineDefPct: 0.1 }, { unlock: ['offlineDefense'], req: [['d_tower', 3]] }),
  // ---- 醫療 ----
  m_regen: r('medical', 1, '休養', '生命自然回復加快', { regenPct: 0.08 }),
  m_heal: r('medical', 1, '急救', '藥品治療回復量提升', { healPct: 0.04 }),
  m_hp: r('medical', 1, '體能訓練', '全隊生命提升', { hpPct: 0.02 }),
  m_cost: r('medical', 2, '藥品節約', '治療消耗的藥品減少', { healCostReduce: 0.05 }, { req: [['m_heal', 2]] }),
  m_def: r('medical', 2, '抗打擊', '全隊防禦提升', { defPct: 0.02 }, { req: [['m_hp', 2]] }),
  m_dodge: r('medical', 2, '反應訓練', '閃避率提升', { dodgeAdd: 0.004 }),
  m_med: r('medical', 2, '草藥學', '每小時產出藥品', { medicinePerHour: 0.2 }),
  m_severe: r('medical', 3, '重傷護理', '重傷者回復加快', { severeRegenPct: 0.1 }, { req: [['m_regen', 3]] }),
  m_starve: r('medical', 3, '耐飢體質', '飢餓時扣血變慢', { starveResist: 0.05 }, { req: [['m_hp', 3]] }),
  // ---- 農業 ----
  a_food: r('agriculture', 1, '輪作', '農場食物產量提升', { foodPct: 0.04 }),
  a_rain: r('agriculture', 1, '淨水', '雨水收集器效果提升', { rainPct: 0.06 }),
  a_ration: r('agriculture', 2, '配給制度', '每人消耗的食物減少', { foodUpkeepReduce: 0.03 }, { req: [['a_food', 2]] }),
  a_forage: r('agriculture', 2, '野外覓食', '探索時食物收穫提升', { forageAdd: 0.05 }),
  a_fuel: r('agriculture', 3, '生質燃料', '每小時產出燃料', { fuelPerHour: 0.3 }, { req: [['a_food', 3]] }),
  a_green: r('agriculture', 4, '溫室', '每級農場額外產出食物', { farmFlat: 0.4 }, { req: [['a_food', 5]] }),
  // ---- 工業 ----
  i_work: r('industry', 1, '工作台效率', '工作台資源產量提升', { workbenchPct: 0.05 }),
  i_storage: r('industry', 1, '物資管理', '資源上限提升', { storagePct: 0.05 }),
  i_shelves: r('industry', 1, '倉儲擴建', '倉庫的物品格子增加', { storeSlots: 5 }),
  i_salvage: r('industry', 1, '拆解回收', '拆解裝備獲得的材料提升', { dismantlePct: 0.08 }),
  i_trade: r('industry', 1, '以物易物', '出售裝備獲得的金錢提升', { sellPct: 0.05 }),
  i_gen: r('industry', 2, '發電效率', '發電機的生產加成提升', { generatorPct: 0.05 }, { req: [['i_work', 2]] }),
  i_genfuel: r('industry', 2, '節能', '發電機耗油減少', { generatorFuelReduce: 0.05 }, { req: [['i_gen', 1]] }),
  i_build: r('industry', 2, '建築學', '建造與升級費用降低', { buildCostReduce: 0.02 }),
  i_fast: r('industry', 2, '快速施工', '建造與升級時間縮短', { buildTimeReduce: 0.03 }),
  // ---- 生存 ----
  s_scout: r('survival', 1, '斥候訓練', '探索速度提升，解鎖「自動探索」', { exploreSpeed: 0.02 }, { unlock: ['autoExplore'] }),
  s_loot: r('survival', 1, '拾荒技巧', '探索物資提升', { lootPct: 0.03 }),
  s_carry: r('survival', 1, '負重訓練', '每人徒步運載量提升', { carryPct: 0.05 }),
  s_night: r('survival', 2, '夜行者', '夜間探索懲罰降低', { nightPenaltyReduce: 0.06 }, { req: [['s_scout', 2]] }),
  s_stealth: r('survival', 2, '潛行', '移動途中遇襲機率降低', { ambushReduce: 0.05 }, { req: [['s_scout', 2]] }),
  s_items: r('survival', 2, '尋寶', '探索時找到裝備的機率提升', { itemFindPct: 0.05 }, { req: [['s_loot', 2]] }),
  s_survivor: r('survival', 2, '搜救', '探索時遇到倖存者的機率提升', { survivorFindPct: 0.08 }),
  s_bp: r('survival', 3, '圖紙蒐集', '探索時找到設計圖的機率提升', { blueprintPct: 0.08 }, { req: [['s_items', 3]] }),
  // ---- 載具 ----
  v_wear: r('vehicles', 1, '保養', '載具磨損減少', { vehicleWearReduce: 0.05 }),
  v_fuel: r('vehicles', 1, '省油駕駛', '載具耗油減少', { vehicleFuelReduce: 0.04 }),
  v_repair: r('vehicles', 1, '維修技術', '載具維修費用降低', { repairCostReduce: 0.05 }),
  v_speed: r('vehicles', 2, '改裝引擎', '載具速度提升', { vehicleSpeedPct: 0.03 }, { req: [['v_repair', 2]] }),
  v_cargo: r('vehicles', 2, '貨架改裝', '載具運載量提升', { vehicleCargoPct: 0.04 }),
  v_find: r('vehicles', 2, '車輛搜尋', '探索時找到載具的機率提升', { vehicleFindPct: 0.1 }),
  v_garage: r('vehicles', 2, '車庫擴建', '車庫容量提升（每 2 級 +1）', { garageSlots: 0.5 }),
  // ---- 製作 ----
  c_tech: r('crafting', 1, '製作技術', '製作出高品級裝備的機率提升（滿級時稀有 0.2%）', { craftTech: 1 }),
  c_cost: r('crafting', 1, '材料節約', '製作費用降低', { craftCostReduce: 0.03 }),
  c_gun: r('crafting', 2, '槍械製造', '解鎖槍械製作：Lv1 手槍、Lv2 十字弓、Lv3 衝鋒槍、Lv4 散彈槍、Lv5 步槍、Lv7 狙擊槍、Lv9 輕機槍', { gunCraft: 1 }, { req: [['c_tech', 1]] }),
  c_level: r('crafting', 2, '精工', '製作的裝備等級提升', { craftLevelAdd: 1 }, { req: [['c_tech', 2]] }),
  c_bp: r('crafting', 3, '設計圖解析', '用設計圖製作時有機會提升一個品級', { craftBpBoost: 0.03 }, { req: [['c_tech', 3]] }),
  c_quality: r('crafting', 3, '品質控管', '製作裝備的素質提升', { craftQualityAdd: 0.03 }, { req: [['c_level', 2]] }),
  // ---- 招募 ----
  r_tech: r('recruitment', 1, '招募技術', '招募到高品級倖存者的機率提升（滿級時稀有 0.2%）', { recruitTech: 1 }),
  r_cost: r('recruitment', 1, '招募宣傳', '招募費用降低', { recruitCostReduce: 0.04 }),
  r_board: r('recruitment', 2, '情報網', '每小時出現的倖存者人數增加（每 5 級 +1）', { boardSlots: 0.2 }, { req: [['r_tech', 2]] }),
  r_train: r('recruitment', 2, '教練', '倖存者獲得的經驗提升', { xpPct: 0.04 }),
  r_level: r('recruitment', 3, '老手', '招募到的倖存者等級提升', { recruitLevelAdd: 0.3 }, { req: [['r_tech', 3]] }),
  // ---- 擴張 ----
  e_outpost: r('expansion', 1, '前哨站', '每級可多建 1 座前哨站（只有防禦功能）', { outposts: 1 }, { max: 3, costMul: 2.5 }),
  e_cost: r('expansion', 2, '前哨後勤', '建立前哨站的費用降低', { establishCostReduce: 0.05 }, { req: [['e_outpost', 1]] }),
  e_wall: r('expansion', 2, '前哨工事', '前哨站圍牆耐久提升', { outpostWallPct: 0.08 }, { req: [['e_outpost', 1]] }),
};

export const requiredLabLevel = (tier) => tier * 2 - 1;

/** 研究到第 level 級需要的研究中心等級 */
export const labLevelFor = (id, level) => Math.max(requiredLabLevel(RESEARCH[id].tier), level);

/** 研究到第 level 級的費用 */
export function researchCost(id, level) {
  const def = RESEARCH[id];
  const amount = TIER_AMOUNT[def.tier] * def.costMul * 1.6 ** (level - 1);
  const cost = Object.fromEntries(Object.entries(BRANCH_COST[def.branch]).map(([k, m]) => [k, Math.round(amount * m)]));
  const parts = Math.round(TIER_PARTS[def.tier] * 1.4 ** (level - 1));
  if (parts) cost.parts = parts;
  return cost;
}

/** 研究到第 level 級的基本時間（秒） */
export const researchTime = (id, level) => Math.round(TIER_TIME[RESEARCH[id].tier] * 1.4 ** (level - 1));

/** 效果說明 */
const pct = (v) => `${+(v * 100).toFixed(1)}%`;
const CATS = {
  melee: '近戰', pistol: '手槍', crossbow: '十字弓', smg: '衝鋒槍', shotgun: '散彈槍', rifle: '步槍', sniper: '狙擊槍', lmg: '輕機槍',
};
const TOWERS = {
  trap: '陷阱', machineGun: '機槍塔', flameTower: '火焰塔', emTower: '電磁塔',
};
const LABELS = {
  atkPct: (v) => `攻擊 +${pct(v)}`, critAdd: (v) => `暴擊率 +${pct(v)}`, critDmgAdd: (v) => `暴擊傷害 +${pct(v)}`,
  atkSpeedAdd: (v) => `攻速 +${v.toFixed(2)}`, lifeStealAdd: (v) => `吸血 +${pct(v)}`, hpPct: (v) => `生命 +${pct(v)}`,
  defPct: (v) => `防禦 +${pct(v)}`, dodgeAdd: (v) => `閃避 +${pct(v)}`, wallHpPct: (v) => `圍牆耐久 +${pct(v)}`,
  repairPct: (v) => `修繕效率 +${pct(v)}`, towerDmgPct: (v) => `防禦塔傷害 +${pct(v)}`, towerRangePct: (v) => `射程 +${pct(v)}`,
  wallReduceAdd: (v) => `圍牆減傷 +${pct(v)}`, guardDmgPct: (v) => `駐守傷害 +${pct(v)}`, raidDefensePct: (v) => `防禦 NPC +${pct(v)}`,
  offlineDefPct: (v) => `離線擊殺 +${pct(v)}`, regenPct: (v) => `回復 +${pct(v)}`, healPct: (v) => `治療量 +${pct(v)}`,
  healCostReduce: (v) => `藥品消耗 −${pct(v)}`, medicinePerHour: (v) => `藥品 +${v.toFixed(1)}/時`, severeRegenPct: (v) => `重傷回復 +${pct(v)}`,
  starveResist: (v) => `飢餓扣血 −${pct(v)}`, foodPct: (v) => `食物 +${pct(v)}`, rainPct: (v) => `雨水收集器 +${pct(v)}`,
  foodUpkeepReduce: (v) => `食物消耗 −${pct(v)}`, forageAdd: (v) => `探索食物 +${pct(v)}`, fuelPerHour: (v) => `燃料 +${v.toFixed(1)}/時`,
  farmFlat: (v) => `每級農場食物 +${v.toFixed(1)}/時`, workbenchPct: (v) => `工作台產量 +${pct(v)}`, storagePct: (v) => `資源上限 +${pct(v)}`,
  dismantlePct: (v) => `拆解材料 +${pct(v)}`, sellPct: (v) => `出售金錢 +${pct(v)}`, generatorPct: (v) => `發電加成 +${pct(v)}`,
  generatorFuelReduce: (v) => `發電耗油 −${pct(v)}`, buildCostReduce: (v) => `建造費用 −${pct(v)}`, buildTimeReduce: (v) => `建造時間 −${pct(v)}`,
  exploreSpeed: (v) => `探索速度 +${pct(v)}`, lootPct: (v) => `探索物資 +${pct(v)}`, carryPct: (v) => `徒步運載 +${pct(v)}`,
  nightPenaltyReduce: (v) => `夜間懲罰 −${pct(v)}`, ambushReduce: (v) => `遇襲機率 −${pct(v)}`, itemFindPct: (v) => `裝備掉落 +${pct(v)}`,
  survivorFindPct: (v) => `遇到倖存者 +${pct(v)}`, blueprintPct: (v) => `設計圖 +${pct(v)}`, vehicleWearReduce: (v) => `載具磨損 −${pct(v)}`,
  vehicleFuelReduce: (v) => `載具耗油 −${pct(v)}`, repairCostReduce: (v) => `維修費用 −${pct(v)}`, vehicleSpeedPct: (v) => `載具速度 +${pct(v)}`,
  vehicleCargoPct: (v) => `載具運載 +${pct(v)}`, vehicleFindPct: (v) => `找到載具 +${pct(v)}`, garageSlots: (v) => `車庫 +${Math.floor(v)}`,
  storeSlots: (v) => `倉庫格子 +${v}`,
  craftTech: (v) => `製作技術 Lv${v}`, craftCostReduce: (v) => `製作費用 −${pct(v)}`, gunCraft: (v) => `槍械製造 Lv${v}`,
  craftLevelAdd: (v) => `製作裝備等級 +${v}`, craftBpBoost: (v) => `設計圖升階 ${pct(v)}`, craftQualityAdd: (v) => `製作素質 +${pct(v)}`,
  recruitTech: (v) => `招募技術 Lv${v}`, recruitCostReduce: (v) => `招募費用 −${pct(v)}`, boardSlots: (v) => `每小時倖存者 +${Math.floor(v)}`,
  xpPct: (v) => `經驗 +${pct(v)}`, recruitLevelAdd: (v) => `招募等級 +${Math.floor(v)}`, outposts: (v) => `前哨站 ${v} 座`,
  establishCostReduce: (v) => `前哨站費用 −${pct(v)}`, outpostWallPct: (v) => `前哨站圍牆 +${pct(v)}`,
};
Object.entries(CATS).forEach(([k, n]) => { LABELS[`catAtk_${k}`] = (v) => `${n}攻擊 +${pct(v)}`; });
Object.entries(TOWERS).forEach(([k, n]) => { LABELS[`defDmg_${k}`] = (v) => `${n}傷害 +${pct(v)}`; });

/** 某科技在 level 級時的效果文字 */
export function effectText(id, level) {
  if (level <= 0) return '—';
  return Object.entries(RESEARCH[id].effects).map(([k, v]) => (LABELS[k] ? LABELS[k](v * level) : `${k} ${v * level}`)).join('、');
}

/** 舊版（v4 以前）研究 → 新科技與等級 */
export const LEGACY_RESEARCH = {
  wpn1: ['w_atk', 3], wpn2: ['w_crit', 3], wpn3: ['w_critdmg', 3], wpn4: ['w_atk', 6],
  def1: ['d_mg', 1], def2: ['d_flame', 1], def3: ['d_em', 1], def4: ['d_tower', 4],
  med1: ['m_regen', 3], med2: ['m_med', 3], med3: ['m_hp', 4], med4: ['m_hp', 6],
  agr1: ['a_food', 3], agr2: ['a_food', 5], agr3: ['a_fuel', 3], agr4: ['a_green', 3],
  srv1: ['s_scout', 3], srv2: ['s_loot', 4], srv3: ['d_offline', 1], srv4: ['i_storage', 4],
  out1: ['e_outpost', 1], out2: ['e_outpost', 2], out3: ['e_outpost', 3],
};
