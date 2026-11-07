/**
 * 地下感染區（多人副本）設定。
 *
 * 時程（台灣時間，現實時間）：07:00 開放報名 → 17:40 截止 → 17:50 鎖定倖存者 → 17:55 出發集結 → 18:00 開打，
 * 20 層、每層 9 分鐘，約 21:00 結束。每位玩家每個副本每天可以派一名倖存者（指揮官不能參加）。
 *
 * 多人計算：所有參加者讀同一份報名資料（共用世界物件），以「副本＋日期＋團號」當亂數種子各自計算，
 * 每個人看到的每層結果完全相同；不需要伺服器計算，離線的玩家上線後也會算出同樣的結果。
 */

/** 台灣時區（UTC+8） */
export const DG_TZ_MS = 8 * 3600 * 1000;
const MIN = 60 * 1000;
/** 每天的時程（從台灣時間 00:00 起算的毫秒） */
export const DG_TIME = {
  open: 7 * 60 * MIN,
  close: (17 * 60 + 40) * MIN,
  lock: (17 * 60 + 50) * MIN,
  depart: (17 * 60 + 55) * MIN,
  start: 18 * 60 * MIN,
  floorMs: 9 * MIN,
};
export const DG_FLOORS = 20;
/** 每團人數（v11.2：不再分團，所有報名者同一團） */
export const DG_TEAM = { min: 3, max: 12 };
/** 每個副本每天最多報名人數：12 人 */
export const DG_MAX_SIGNUPS = 12;

/** 副本戰鬥規則（只在副本內生效） */
export const DG_RULES = {
  lifeStealMul: 0.3, // 吸血效果只剩 30%
  fightMaxSec: 90,
  bossMaxSec: 240, // 首領戰最長 4 分鐘
  infPerFloor: 4, // 每層自然增加的感染值
  medicInfReduce: 0.25, // 每名醫生感染累積 −25%（最多 2 名）
  infStatPer10: 0.04, // 每 10 點感染：全隊攻擊／防禦 −4%
  restEvery: 3, // 休息站：第 3、6、9…層
  restHeal: 0.4,
  restHealFarmer: 0.6,
  restInf: 15,
  restInfMedic: 30,
  reviveEach: 2, // 每名醫生每個休息站最多救回 2 人
  reviveHp: 0.4, // 救回時恢復 40% 生命
  all5: 0.1, // 五職業齊全：全隊攻擊／防禦 +10%、獎勵 +10%
  warriorDef2: 0.05, // 戰士 2 名：全隊防禦再 +5%
  engineerGuard: 0.05, // 每名工程師（最多 2 名）首領戰全隊受到傷害 −5%
  farmerLoot: 0.2, // 隊伍有農夫：全隊帶回物資 +20%
};

/** 難度：依人數與層數成長（以正式計算模擬校準：滿配標準隊伍約一半以上通關，罕見裝備約停在 16～17 層） */
export const DG_DIFF = {
  maxPlayers: 8, // 難度最多以 8 人計算（9～12 人時難度與 8 人相同）
  perPlayer: 3, // 每波敵人數 = 人數 × 3
  atk0: 16, atkGrow: 1.14, // 敵人攻擊倍率
  hp0: 2.5, hpGrow: 1.08, // 敵人生命倍率
  defGrow: 1.04, // 敵人防禦成長（較慢）
  sizePow: 0.42, // 依人數調整攻擊：（人數 / 5）^0.42（3、5、8 人的標準隊伍通關率接近）
  bossHpPer: 1.5, // 首領生命 × 人數 × 1.5
  bossAtk: 1.5,
  finalAtk: 0.7, finalHp: 0.75, // 最終首領（另有召喚屍群、狂暴、吞噬）
  baseLevel: 50, // 敵人等級 = 50 + 層數
};

/** 各層的敵人種類 */
export const DG_ROSTER = (f) => (f <= 5 ? ['infected', 'berserker'] : f <= 10 ? ['berserker', 'mutant'] : f <= 15 ? ['mutant', 'nightStalker'] : ['nightStalker', 'mutant', 'nightStalker']);

/**
 * 障礙：每層隨機 1～3 個，需要對應職業處理；沒有該職業（或該職業都重傷）時受到懲罰。
 * hpLoss：全隊損失最大生命比例；inf：感染值；atk／hp：本層敵人攻擊／生命倍率；ambush：敵人先手
 */
export const DG_OBSTACLES = {
  horde: { name: '屍群衝鋒', icon: '🧟', cls: 'warrior', ok: '擋下', fail: '敵人攻擊 +25%', atk: 1.25 },
  gas: { name: '毒氣區', icon: '☁️', cls: 'medic', ok: '淨化成功', fail: '全隊 −10% 生命、感染 +8', hpLoss: 0.1, inf: 8 },
  door: { name: '封鎖門', icon: '🚪', cls: 'engineer', ok: '拆除成功', fail: '繞路：全隊 −8% 生命、感染 +6', hpLoss: 0.08, inf: 6 },
  ambush: { name: '伏擊', icon: '🧟‍♂️', cls: 'scout', ok: '提前發現', fail: '被偷襲：敵人攻擊 +20%', atk: 1.2 },
  rot: { name: '腐敗菌田', icon: '🦠', cls: 'farmer', ok: '清除成功', fail: '菌絲讓敵人生命 +15%', hp: 1.15 },
};

/** 職業在副本中的說明（報名畫面「職業說明」） */
export const DG_CLASS_NOTES = {
  warrior: '首領重擊優先打戰士（首領攻擊 −30%）；2 名時全隊防禦再 +5%',
  medic: '感染累積 −25%（2 名 −50%）；休息站每名醫生救回 2 名重傷隊員（恢復 40% 生命）、多降感染',
  engineer: '首領戰架設路障，全隊受到傷害 −5%（2 名 −10%）',
  scout: '每層多搜一個隱藏房間（物資增加）；可以打斷首領的尖嘯',
  farmer: '隊伍有農夫：全隊帶回物資增加；休息站回復 60%（沒有農夫 40%）',
};

/** 首領：第 5／10／15 層精英首領，第 20 層最終首領（各副本不同） */
export const DG_BOSSES = {
  5: { base: 'tankBoss', name: '腐蝕巨屍', icon: '🦍', skill: 'smash', skillText: '重擊：有戰士時由戰士承受，傷害 −30%' },
  10: { base: 'witchBoss', name: '尖嘯母體', icon: '👸', skill: 'scream', skillText: '尖嘯：全隊攻速 −15%（有偵察兵時減半）' },
  15: { base: 'generalBoss', name: '毒霧將軍', icon: '🎖️', skill: 'poison', skillText: '毒霧：戰前全隊 −10% 生命、感染 +10（有醫生時減半）' },
};
export const DG_FINAL_SKILL = '召喚屍群、狂暴、吞噬回血：需要多職業配合';

/** 首領層掉落（每位參加者各自擲）：核心材料機率與數量、圖紙機率（套用研究「圖紙蒐集」） */
export const DG_DROPS = {
  5: { core: 0.25, coreN: [1, 1], bp: 0.01 },
  10: { core: 0.5, coreN: [1, 1], bp: 0.025 },
  15: { core: 0.75, coreN: [1, 1], bp: 0.04 },
  20: { core: 1, coreN: [1, 3], bp: 0.08 },
};

/** 每層一般材料獎勵（每位參加者）：依層數決定品級，數量隨機 */
export const DG_FLOOR_LOOT = {
  kinds: 2, // 每層 2 種（偵察兵的隱藏房間 +1 種）
  tiers: (f) => (f <= 5 ? [1, 2] : f <= 10 ? [2, 3] : f <= 15 ? [3, 4] : [4, 5]),
  amount: { 1: [30, 60], 2: [15, 30], 3: [8, 15], 4: [4, 8], 5: [2, 4] },
};

/** NPC 據點不會出現在副本入口這個距離以內（公尺） */
export const DG_CLEAR_M = 150;

/** 五個副本（位置在信義區一帶，固定在地圖上） */
export const DUNGEONS = {
  drain: {
    name: '地下排水迷宮', short: '迷宮', cls: 'scout', lat: 25.0377, lon: 121.5698,
    core: 'coreDrain', final: { name: '迷宮吞噬者', icon: '🐍' },
  },
  greenhouse: {
    name: '地下溫室', short: '溫室', cls: 'farmer', lat: 25.0342, lon: 121.5640,
    core: 'coreGreen', final: { name: '孢子母樹', icon: '🌳' },
  },
  depot: {
    name: '廢棄捷運機廠', short: '機廠', cls: 'engineer', lat: 25.0338, lon: 121.5732,
    core: 'coreDepot', final: { name: '鋼鐵縫合怪', icon: '🤖' },
  },
  bunker: {
    name: '山腳防空洞', short: '防空洞', cls: 'warrior', lat: 25.0302, lon: 121.5716,
    core: 'coreBunker', final: { name: '屍化指揮官', icon: '💂' },
  },
  lab: {
    name: '醫學院地下實驗室', short: '實驗室', cls: 'medic', lat: 25.0290, lon: 121.5655,
    core: 'coreLab', final: { name: '地下母巢', icon: '🕷️' },
  },
};
export const DUNGEON_KEYS = Object.keys(DUNGEONS);

/** 核心材料（副本材料）：各副本專屬，可以在交易市場交易 */
export const DG_CORES = {
  coreDrain: { name: '迷霧核心', icon: '🌀', dg: 'drain' },
  coreGreen: { name: '孢子核心', icon: '🍄', dg: 'greenhouse' },
  coreDepot: { name: '機械核心', icon: '⚙️', dg: 'depot' },
  coreBunker: { name: '戰甲核心', icon: '🔰', dg: 'bunker' },
  coreLab: { name: '變異核心', icon: '🧬', dg: 'lab' },
};
export const DG_CORE_KEYS = Object.keys(DG_CORES);
export const isDgCore = (k) => !!DG_CORES[k];

/** 副本裝備：每個副本 9 個部位各一件（base 為產生數值用的型號） */
export const DG_SLOTS = ['weapon', 'melee', 'helmet', 'armor', 'legs', 'gloves', 'boots', 'backpack', 'accessory'];
const ARMOR_BASE = { helmet: 'titanHelmet', armor: 'eodSuit', legs: 'exoLegs', gloves: 'exoGloves', boots: 'exoBoots', backpack: 'pack3', accessory: 'nvg' };
const WEAPON_BASE = { scout: 'barrett', farmer: 'carbonXbow', engineer: 'aa12', warrior: 'm134', medic: 'vector' };
const GEAR_NAMES = {
  drain: ['消音狙擊槍', '獵刀', '夜視頭盔', '潛行戰衣', '輕量護腿', '攀爬手套', '靜音靴', '偵察背包', '熱感儀'],
  greenhouse: ['孢子弩', '收割鐮刀', '防孢面罩', '藤甲', '防水護腿', '園藝手套', '雨靴', '採集背包', '生態感測器'],
  depot: ['電磁霰彈槍', '液壓破壞剪', '焊接面罩', '工程外骨骼', '液壓護腿', '絕緣手套', '磁力靴', '工具背包', '多功能腕錶'],
  bunker: ['重型機槍', '破城斧', '鋼盔', '重裝甲', '裝甲護腿', '鐵拳手套', '戰靴', '彈藥背包', '戰旗徽章'],
  lab: ['消毒噴槍', '手術鋸', '防疫頭罩', '隔離防護衣', '無菌護腿', '醫護手套', '無塵靴', '急救背包', '生命監測器'],
};
/** 製作需求：核心材料、金幣（依部位） */
export const DG_CRAFT = {
  bench: 5,
  core: { weapon: 20, melee: 16, armor: 16, helmet: 14, legs: 14, gloves: 12, boots: 12, backpack: 12, accessory: 12 },
  coins: { weapon: 150000, melee: 120000, armor: 120000, helmet: 80000, legs: 80000, gloves: 80000, boots: 80000, backpack: 80000, accessory: 80000 },
  level: 60,
};
/** 副本品級：強度約傳奇的 1.2 倍，每項素質 50% 起 */
export const DG_RARITY = { min: 2.1, max: 2.64, qualityAdd: 0.5, affixes: 4 };

/** 套裝效果（同副本裝備穿越多件，加成越多；主要能力依職業） */
export const DG_SET = [
  { n: 3, pct: 0.02 },
  { n: 6, pct: 0.025, inf: 0.03 },
  { n: 9, pct: 0.035 },
];
export const DG_SET_STAT = { warrior: 'def', medic: 'hp', engineer: 'atk', scout: 'atk', farmer: 'hp' };
export const DG_STAT_NAME = { hp: '生命', atk: '攻擊', def: '防禦' };

/**
 * 一般材料配方（固定）：每件 5 個品級各 3 種；低品級用量多；
 * 同品級中目前其他製作、研究、建造總用量越少的材料，需求越高。
 */
export const DG_RECIPES = {
  lab_weapon: { coarse: 1200, ironWire: 1960, cotton: 1200, leather: 670, hinge: 900, ironPlate: 1200, steelPipe: 430, firingPin: 450, bearing: 300, icBoard: 290, reinforced: 170, piston: 160, solarCell: 140, titanium: 90, precision: 70 },
  lab_melee: { linen: 1040, tape: 1300, screw: 1580, canvas: 670, copperCoil: 650, leather: 580, firingPin: 390, circuit: 380, aluminum: 390, icBoard: 250, ballistic: 160, reinforced: 140, chip: 120, solarCell: 120, titanium: 80 },
  lab_helmet: { scrap: 1250, screw: 1340, tape: 1100, nylon: 440, hinge: 660, gear: 440, aluminum: 330, steelPlate: 280, steelPipe: 310, icBoard: 210, alloyPlate: 150, sensor: 210, solarCell: 110, kevlar: 50, precision: 50 },
  lab_armor: { screw: 1580, plastic: 1450, bulb: 1710, ironPlate: 1040, hinge: 780, chain: 600, steelPipe: 370, steelPlate: 330, circuit: 380, icBoard: 250, barrel: 160, hydraulic: 130, chip: 120, solarCell: 120, kevlar: 60 },
  lab_legs: { glass: 1290, tape: 1100, linen: 880, hinge: 660, gear: 440, nylon: 440, circuit: 320, aluminum: 330, firingPin: 330, icBoard: 210, piston: 120, barrel: 140, solarCell: 110, chip: 110, precision: 50 },
  lab_gloves: { screw: 1220, tape: 1000, nail: 1270, hinge: 600, chain: 460, ironPlate: 800, bearing: 200, techCotton: 200, steelPlate: 250, icBoard: 190, sensor: 190, ballistic: 120, chip: 100, solarCell: 100, precision: 50 },
  lab_boots: { nail: 1270, cotton: 800, ironWire: 1300, copperCoil: 500, ironPlate: 800, battery: 690, steelPlate: 250, motor: 230, bearing: 200, icBoard: 190, hydraulic: 100, reinforced: 110, titanium: 60, kevlar: 50, solarCell: 100 },
  lab_backpack: { plastic: 1120, nail: 1270, scrap: 1140, battery: 690, ironPlate: 800, copperCoil: 500, aluminum: 300, steelPlate: 250, circuit: 290, icBoard: 190, barrel: 130, hydraulic: 100, kevlar: 50, solarCell: 100, chip: 100 },
  lab_accessory: { tape: 1000, coarse: 800, glass: 1170, spring: 400, chain: 460, canvas: 510, firingPin: 300, aluminum: 300, motor: 230, alloyPlate: 140, icBoard: 190, piston: 110, titanium: 60, kevlar: 50, chip: 100 },
  bunker_weapon: { glass: 1760, coarse: 1200, bulb: 1970, hinge: 900, nylon: 600, switch: 1200, motor: 350, bearing: 300, firingPin: 450, icBoard: 290, alloyPlate: 200, sensor: 290, solarCell: 140, chip: 140, titanium: 90 },
  bunker_melee: { linen: 1040, tape: 1300, plastic: 1450, copperCoil: 650, switch: 1040, nylon: 520, aluminum: 390, circuit: 380, firingPin: 390, icBoard: 250, reinforced: 140, barrel: 160, chip: 120, kevlar: 60, solarCell: 120 },
  bunker_helmet: { bulb: 1450, nail: 1400, scrap: 1250, gear: 440, copperCoil: 550, ironPlate: 880, circuit: 320, steelPlate: 280, firingPin: 330, icBoard: 210, piston: 120, sensor: 210, titanium: 70, precision: 50, solarCell: 110 },
  bunker_armor: { bolt: 1040, wire: 1110, glass: 1520, copperCoil: 650, hinge: 780, leather: 580, circuit: 380, aluminum: 390, motor: 310, icBoard: 250, barrel: 160, sensor: 250, kevlar: 60, solarCell: 120, precision: 60 },
  bunker_legs: { glass: 1290, linen: 880, rubber: 880, canvas: 560, switch: 880, copperCoil: 550, circuit: 320, steelPlate: 280, aluminum: 330, icBoard: 210, barrel: 140, hydraulic: 110, solarCell: 110, chip: 110, precision: 50 },
  bunker_gloves: { coarse: 800, wire: 850, bolt: 800, chain: 460, switch: 800, gear: 400, valve: 200, steelPipe: 280, firingPin: 300, icBoard: 190, hydraulic: 100, sensor: 190, kevlar: 50, precision: 50, titanium: 60 },
  bunker_boots: { rubber: 800, plastic: 1120, wire: 850, switch: 800, rebar: 510, chain: 460, motor: 230, techCotton: 200, steelPlate: 250, icBoard: 190, sensor: 190, alloyPlate: 140, titanium: 60, precision: 50, solarCell: 100 },
  bunker_backpack: { ironWire: 1300, bulb: 1310, plastic: 1120, nylon: 400, battery: 690, rebar: 510, motor: 230, steelPipe: 280, firingPin: 300, icBoard: 190, hydraulic: 100, piston: 110, solarCell: 100, precision: 50, titanium: 60 },
  bunker_accessory: { cotton: 800, nail: 1270, coarse: 800, hinge: 600, nylon: 400, copperCoil: 500, steelPlate: 250, aluminum: 300, firingPin: 300, icBoard: 190, reinforced: 110, sensor: 190, precision: 50, solarCell: 100, kevlar: 50 },
  depot_weapon: { bulb: 1970, glass: 1760, screw: 1830, hinge: 900, battery: 1030, copperCoil: 750, techCotton: 300, valve: 300, circuit: 440, icBoard: 290, ballistic: 180, hydraulic: 150, solarCell: 140, titanium: 90, chip: 140 },
  depot_melee: { bolt: 1040, nail: 1650, bulb: 1710, canvas: 670, ironPlate: 1040, battery: 900, circuit: 380, techCotton: 260, firingPin: 390, icBoard: 250, piston: 140, barrel: 160, solarCell: 120, kevlar: 60, chip: 120 },
  depot_helmet: { bulb: 1450, bolt: 880, glass: 1290, ironPlate: 880, leather: 490, nylon: 440, steelPlate: 280, aluminum: 330, techCotton: 220, icBoard: 210, sensor: 210, barrel: 140, titanium: 70, solarCell: 110, chip: 110 },
  depot_armor: { bulb: 1710, linen: 1040, nail: 1650, battery: 900, hinge: 780, switch: 1040, valve: 260, firingPin: 390, techCotton: 260, icBoard: 250, barrel: 160, ballistic: 160, precision: 60, kevlar: 60, chip: 120 },
  depot_legs: { scrap: 1250, coarse: 880, glass: 1290, battery: 760, rebar: 560, leather: 490, motor: 260, firingPin: 330, aluminum: 330, icBoard: 210, alloyPlate: 150, sensor: 210, titanium: 70, chip: 110, solarCell: 110 },
  depot_gloves: { wire: 850, plastic: 1120, scrap: 1140, hinge: 600, switch: 800, battery: 690, valve: 200, firingPin: 300, bearing: 200, icBoard: 190, sensor: 190, barrel: 130, titanium: 60, chip: 100, solarCell: 100 },
  depot_boots: { wire: 850, bulb: 1310, tape: 1000, hinge: 600, battery: 690, switch: 800, bearing: 200, aluminum: 300, steelPipe: 280, sensor: 190, icBoard: 190, alloyPlate: 140, chip: 100, solarCell: 100, precision: 50 },
  depot_backpack: { ironWire: 1300, linen: 800, bolt: 800, rebar: 510, ironPlate: 800, canvas: 510, circuit: 290, motor: 230, techCotton: 200, icBoard: 190, ballistic: 120, sensor: 190, titanium: 60, precision: 50, kevlar: 50 },
  depot_accessory: { ironWire: 1300, scrap: 1140, glass: 1170, hinge: 600, battery: 690, spring: 400, aluminum: 300, bearing: 200, circuit: 290, icBoard: 190, alloyPlate: 140, hydraulic: 100, kevlar: 50, titanium: 60, precision: 50 },
  drain_weapon: { scrap: 1710, bulb: 1970, cotton: 1200, hinge: 900, rebar: 770, ironPlate: 1200, aluminum: 440, circuit: 440, motor: 350, icBoard: 290, sensor: 290, piston: 160, titanium: 90, chip: 140, kevlar: 70 },
  drain_melee: { rubber: 1040, scrap: 1480, glass: 1520, gear: 520, nylon: 520, switch: 1040, motor: 310, firingPin: 390, aluminum: 390, icBoard: 250, hydraulic: 130, sensor: 250, precision: 60, solarCell: 120, chip: 120 },
  drain_helmet: { cotton: 880, scrap: 1250, nail: 1400, switch: 880, hinge: 660, gear: 440, circuit: 320, steelPlate: 280, techCotton: 220, icBoard: 210, reinforced: 120, barrel: 140, chip: 110, titanium: 70, solarCell: 110 },
  drain_armor: { nail: 1650, screw: 1580, linen: 1040, gear: 520, nylon: 520, copperCoil: 650, motor: 310, aluminum: 390, techCotton: 260, icBoard: 250, reinforced: 140, sensor: 250, titanium: 80, chip: 120, kevlar: 60 },
  drain_legs: { wire: 940, bolt: 880, screw: 1340, hinge: 660, switch: 880, copperCoil: 550, firingPin: 330, motor: 260, circuit: 320, icBoard: 210, ballistic: 130, sensor: 210, chip: 110, precision: 50, solarCell: 110 },
  drain_gloves: { nail: 1270, scrap: 1140, screw: 1220, switch: 800, ironPlate: 800, battery: 690, steelPlate: 250, steelPipe: 280, motor: 230, icBoard: 190, sensor: 190, barrel: 130, kevlar: 50, solarCell: 100, chip: 100 },
  drain_boots: { glass: 1170, coarse: 800, screw: 1220, hinge: 600, chain: 460, switch: 800, circuit: 290, valve: 200, steelPlate: 250, icBoard: 190, barrel: 130, sensor: 190, solarCell: 100, precision: 50, kevlar: 50 },
  drain_backpack: { bulb: 1310, rubber: 800, tape: 1000, ironPlate: 800, gear: 400, switch: 800, techCotton: 200, firingPin: 300, steelPipe: 280, icBoard: 190, barrel: 130, ballistic: 120, chip: 100, precision: 50, solarCell: 100 },
  drain_accessory: { ironWire: 1300, scrap: 1140, bulb: 1310, hinge: 600, switch: 800, rebar: 510, steelPipe: 280, motor: 230, circuit: 290, icBoard: 190, piston: 110, barrel: 130, solarCell: 100, kevlar: 50, chip: 100 },
  greenhouse_weapon: { screw: 1830, cotton: 1200, nail: 1910, hinge: 900, gear: 600, ironPlate: 1200, steelPipe: 430, valve: 300, circuit: 440, icBoard: 290, sensor: 290, barrel: 190, kevlar: 70, precision: 70, chip: 140 },
  greenhouse_melee: { glass: 1520, ironWire: 1700, coarse: 1040, switch: 1040, gear: 520, hinge: 780, motor: 310, valve: 260, firingPin: 390, icBoard: 250, alloyPlate: 180, ballistic: 160, solarCell: 120, precision: 60, chip: 120 },
  greenhouse_helmet: { cotton: 880, bulb: 1450, bolt: 880, canvas: 560, ironPlate: 880, rebar: 560, motor: 260, steelPlate: 280, aluminum: 330, icBoard: 210, barrel: 140, ballistic: 130, solarCell: 110, chip: 110, kevlar: 50 },
  greenhouse_armor: { scrap: 1480, nail: 1650, glass: 1520, switch: 1040, chain: 600, rebar: 660, steelPipe: 370, firingPin: 390, circuit: 380, icBoard: 250, reinforced: 140, alloyPlate: 180, kevlar: 60, titanium: 80, precision: 60 },
  greenhouse_legs: { linen: 880, bolt: 880, glass: 1290, gear: 440, hinge: 660, copperCoil: 550, circuit: 320, steelPlate: 280, bearing: 220, icBoard: 210, barrel: 140, alloyPlate: 150, chip: 110, solarCell: 110, precision: 50 },
  greenhouse_gloves: { bolt: 800, rubber: 800, plastic: 1120, switch: 800, copperCoil: 500, canvas: 510, firingPin: 300, motor: 230, circuit: 290, icBoard: 190, hydraulic: 100, ballistic: 120, solarCell: 100, chip: 100, titanium: 60 },
  greenhouse_boots: { cotton: 800, linen: 800, nail: 1270, nylon: 400, battery: 690, rebar: 510, firingPin: 300, steelPipe: 280, valve: 200, icBoard: 190, reinforced: 110, sensor: 190, solarCell: 100, chip: 100, precision: 50 },
  greenhouse_backpack: { nail: 1270, ironWire: 1300, bolt: 800, battery: 690, switch: 800, nylon: 400, steelPipe: 280, aluminum: 300, techCotton: 200, icBoard: 190, sensor: 190, reinforced: 110, chip: 100, precision: 50, kevlar: 50 },
  greenhouse_accessory: { bulb: 1310, plastic: 1120, wire: 850, hinge: 600, switch: 800, chain: 460, motor: 230, steelPipe: 280, aluminum: 300, icBoard: 190, reinforced: 110, alloyPlate: 140, precision: 50, chip: 100, solarCell: 100 },
};

/** 45 件副本裝備的定義：id = 副本_部位 */
export const DG_GEAR = Object.fromEntries(DUNGEON_KEYS.flatMap((dg) => DG_SLOTS.map((slot, i) => {
  const d = DUNGEONS[dg];
  const base = slot === 'weapon' ? WEAPON_BASE[d.cls] : slot === 'melee' ? 'chainsaw' : ARMOR_BASE[slot];
  return [`${dg}_${slot}`, {
    dg, slot, cls: d.cls, base, name: `${d.short}・${GEAR_NAMES[dg][i]}`,
  }];
})));
