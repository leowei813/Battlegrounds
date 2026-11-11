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

/**
 * 倖存者名單（v12）：台味搞笑／中二霸氣的縱貫線風格，每個最多 6 個字。
 * 甲：台灣地名、路名＋港星名字、職稱或稱謂；乙：台灣小吃、飲料＋堅持的吃法。
 */
export const SURVIVOR_NAMES = [
  // ---- 地名／路名＋稱謂 ----
  '三重劉德華', '萬華阿港伯', '大甲鎮瀾護法', '縱貫線老二', '檳榔攤扛霸子', '噴水池之狼', '西螺最後希望', '隔壁阿傑', '水門市場阿珠', '隔壁班陳董',
  '天天開心阿忠', '巷口王伯伯', '美鳳姐鐵粉', '村長伯阿松', '板橋周潤發', '新莊梁朝偉', '永和郭富城', '中和黎明', '蘆洲張學友', '北投古天樂',
  '士林周星馳', '林口吳孟達', '鶯歌劉青雲', '中壢阿明哥', '竹北科技新貴', '苗栗山城浪子', '逢甲夜市戰神', '八卦山劍聖', '鹿港老街掌門', '員林阿嬤',
  '斗六阿伯', '北港媽祖鐵粉', '嘉義雞肉飯王', '朴子阿姑', '府城少爺', '安平阿嬤', '新營阿財', '鳳山阿強', '鹽埕大哥大', '岡山羊肉董',
  '墾丁衝浪王', '恆春教父', '東港鮪魚船長', '太魯閣遊俠', '池上米王', '羅東夜市老大', '基隆廟口阿娥', '九份阿妹', '淡水夕陽王子', '西門町潮男',
  '三和夜市一哥', '汐止阿水伯', '二林里長伯', '台十一線浪人', '國道總舖師', '中正路阿福', '民生社區王董', '南京東路課長', '樹林阿雄', '土城阿達',
  '新店碧潭漢子', '三峽老街阿嬤', '深坑豆腐王', '坪林茶霸', '烏來溫泉仙', '金山鴨肉阿伯', '萬里蟹老闆', '瑞芳礦工仔', '平溪天燈仔', '貢寮海女',
  '八里左岸王子', '五股工業區長', '泰山阿忠', '新竹米粉伯', '湖口老街阿婆', '關西仙草哥', '竹東阿財伯', '頭份阿龍', '後龍西瓜王', '苑裡藺草姨',
  '大湖草莓公主', '三義木雕師', '豐原廟東哥', '大雅小麥王', '清水阿姑', '沙鹿夜市王', '梧棲漁港伯', '霧峰林家少爺', '東勢客家大哥', '和美阿國',
  '溪湖羊肉伯', '北斗肉圓王', '田尾花仙子', '二水阿忠', '埔里紹興伯', '日月潭船長', '集集火車迷', '竹山竹筍王', '草屯阿盛', '虎尾布袋戲迷',
  '斗南阿伯', '土庫阿嬤', '麥寮工業男', '民雄鬼屋探險', '竹崎小火車迷', '布袋港阿伯', '東石蚵仔王', '鹽水蜂炮勇士', '麻豆文旦王', '玉井芒果王',
  '關廟鳳梨伯', '永康阿雄', '歸仁阿嬤', '佳里阿財', '旗山香蕉王', '美濃粄條姐', '甲仙芋頭伯', '林園阿忠', '大寮阿國', '前鎮漁港伯',
  '旗津渡輪長', '左營眷村伯', '楠梓阿強', '茄萣烏魚王', '潮州冷熱冰', '萬丹紅豆王', '枋寮阿伯', '林邊黑珍珠', '琉球小島主', '礁溪溫泉王',
  '蘇澳冷泉哥', '頭城搶孤勇士', '花蓮麻糬王', '玉里羊羹伯', '鳳林阿嬤', '台東釋迦王', '成功漁港伯', '綠島監獄長', '蘭嶼飛魚王', '澎湖仙人掌',
  '金門高粱伯', '馬祖芙蓉嫂', '民權路阿伯', '民族路阿姨', '中山路大哥', '復興路阿舍', '建國路阿明', '光復路阿美', '信義路大老闆', '仁愛路阿姐',
  '和平路阿伯', '忠孝路阿國', '博愛路阿雄', '自由路阿珍', '文化路夜市王', '公園路阿伯', '林森路老大', '成功路阿強', '菜市場阿姨', '雜貨店老闆',
  '廟口算命仙', '宮廟乩童', '里長伯', '鄰長阿姨', '補習班名師', '警衛伯伯', '計程車運將', '遊覽車司機', '卡拉OK麥霸', '夜市叫賣哥',
  '機車行老闆', '鐵工廠師傅', '水電行阿伯', '牛肉麵老闆', '早餐店阿姨', '便利商店店長', '加油站小弟', '雞排攤老闆', '鹹酥雞阿伯', '喜宴總舖師',
  '拜拜大使', '廣播電台DJ', '電子花車女王', '八家將小隊長', '陣頭鼓手', '布袋戲主演', '歌仔戲小生', '那卡西歌王', '社區巡守隊長', '管委會主委',
  '媽祖遶境老手', '大樓保全', '藥局阿伯', '中藥行老闆', '修車廠黑手', '汽車美容王', '洗頭阿姨',
  // ---- 小吃／飲料＋堅持 ----
  '滷肉飯去香菜', '大腸包不加辣', '排骨酥去香菜', '小腸加辣油', '結冰水愛好者', '保力達蠻牛', '紅灰雙子星', '科學麵不捏碎', '珍奶半糖去冰', '雞排不切不辣',
  '九層塔加倍', '臭豆腐加泡菜', '蚵仔煎醬另放', '肉圓不要醬', '鹽酥雞不要椒', '米血狂撒花生', '豆花不加糖', '擔仔麵不加蛋', '牛肉麵湯另裝', '米糕醬多一點',
  '碗粿不淋醬', '刈包不要酸菜', '鍋貼不沾醬', '甜不辣醬淋滿', '炒米粉辣到哭', '麻醬麵拌到斷', '雞排切六塊', '冬瓜茶無糖派', '愛玉檸檬加大', '木瓜牛奶去冰',
  '麥香吸管戳歪', '沙士配鹽巴', '綠豆沙少糖', '芒果冰只吃芒', '剉冰拒絕煉乳', '粉圓加到滿', '地瓜球用捏的', '香腸配生蒜', '胡椒餅燙舌頭', '麻糬不沾粉',
  '鳳梨酥只吃餡', '蚵仔麵線加醋', '鴨血不要韭菜', '臭豆腐要臭爆', '豬血湯加酸菜', '魯味全部加辣', '滷蛋只吃蛋白', '控肉飯要肥的', '雞肉飯多淋油', '割包加香菜',
  '潤餅不加糖粉', '生煎包燙嘴派', '小籠包吸湯派', '水煎包要焦皮', '蔥油餅要加蛋', '蘿蔔糕煎到脆', '燒仙草加奶球', '豆漿要無糖', '油條泡到爛', '飯糰加兩顆蛋',
  '蛋餅要煎焦', '鐵板麵黑胡椒', '炒泡麵加蛋', '泡麵只喝湯', '王子麵直接啃', '統一麵不加料', '鹹酥雞不加蒜', '炸雞皮加梅粉', '甘梅薯條狂粉', '雞蛋糕要焦邊',
  '車輪餅只吃奶', '紅豆餅不要皮', '糖葫蘆咬斷牙', '烤玉米刷三次', '烤魷魚要加辣', '鹽烤香魚頭先', '碳烤三明治', '蛋包飯畫愛心', '咖哩飯不拌開', '火鍋料先下肚',
  '麻辣鍋加大辣', '多多綠不加多', '奶茶只喝珍珠', '紅茶冰去冰', '青茶無糖去冰', '烏龍茶濃到苦', '檸檬汁加爆酸', '楊桃汁加鹽', '酸梅湯冰到牙', '仙草茶加奶',
  '杏仁茶不加糖', '米漿要燒的', '豆奶各一半', '養樂多喝五瓶', '伯朗咖啡加冰', '麥茶當水喝', '蘆筍汁喝到底', '彈珠汽水搖瓶', '黑松汽水打嗝', '蘋果西打續杯',
  '運動飲料泡麵', '提神飲料當水', '舒跑配便當', '鮮奶茶冰沙', '芭樂汁加梅粉', '西瓜汁不去籽', '甘蔗汁加檸檬', '椰子汁插兩管', '啤酒配花生', '高粱配香腸',
];

export const MAX_SURVIVOR_LEVEL = 50;

/**
 * 倖存者能力素質（每項 0～100%，招募時隨機、之後不變；首領一律 100%）。
 * 生命／攻擊／防禦／暴擊／閃避：0% ×0.88、50% ×1.00、100% ×1.12；攻速：×0.90～×1.10。
 * 生命／攻擊／防禦的每級成長也套用同一個素質。
 */
export const QUALITY_KEYS = ['hp', 'atk', 'def', 'crit', 'dodge', 'atkSpeed'];
export const QUALITY_NAMES = { hp: '生命', atk: '攻擊', def: '防禦', crit: '暴擊', dodge: '閃避', atkSpeed: '攻速' };
export const qualityMul = (key, q = 100) => {
  const t = Math.max(0, Math.min(100, Number.isFinite(q) ? q : 100)) / 100;
  return key === 'atkSpeed' ? 0.9 + 0.2 * t : 0.88 + 0.24 * t;
};
/** 隨機素質：越接近 100% 越少見（100% 約 0.6%） */
export const rollQuality = (rnd = Math.random) => Math.min(100, Math.floor(101 * rnd() ** 1.6));
export const rollQualities = (rnd = Math.random) => Object.fromEntries(QUALITY_KEYS.map((k) => [k, rollQuality(rnd)]));

/**
 * 倖存者品級（與裝備相同的 6 階與顏色）：品級越高，每次升級提升的能力越多。
 * growth 為等級成長倍率；weight 為招募/遭遇時出現的權重。
 */
/**
 * 品級：growth 每級成長倍率、base 基礎能力倍率、skills 可解放的技能數（每個職業共 6 個技能）。
 * 品級越高能力越好、可解放的技能越多。
 */
export const SURVIVOR_RARITY = {
  poor: { growth: 0.78, base: 0.89, skills: 1 },
  common: { growth: 0.9, base: 1, skills: 2 },
  uncommon: { growth: 1.03, base: 1.07, skills: 3 },
  rare: { growth: 1.2, base: 1.15, skills: 4 },
  epic: { growth: 1.38, base: 1.24, skills: 5 },
  legendary: { growth: 1.6, base: 1.35, skills: 6 },
};

/**
 * 倖存者品級機率（%）：研究「招募技術」每級提升，滿級時傳奇 3%。
 * 0 級：劣質 32／一般 53.9／優良 12／精良 2／罕見 0.1／傳奇 0；
 * 滿級：劣質 10／一般 33／優良 28／精良 18／罕見 8／傳奇 3（中間依等級線性變化）。
 * @param {number} tech 招募技術等級 0～15
 */
export const SURVIVOR_RARITY_ODDS = {
  min: { poor: 32, uncommon: 12, rare: 2, epic: 0.1, legendary: 0 },
  max: { poor: 10, uncommon: 28, rare: 18, epic: 8, legendary: 3 },
};
export function survivorRarityTable(tech = 0) {
  const t = Math.max(0, Math.min(15, tech)) / 15;
  const { min, max } = SURVIVOR_RARITY_ODDS;
  const at = (k) => min[k] + (max[k] - min[k]) * t;
  const legendary = at('legendary');
  const epic = at('epic');
  const rare = at('rare');
  const uncommon = at('uncommon');
  const poor = at('poor');
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
export const MAX_SURVIVORS = 12;
/** 人數上限 = 基本 5 + 領袖等級 ÷ 3（最多 10 人），且不能超過宿舍可住人數 */
export const BASE_SURVIVOR_CAP = 5;
export const LEADER_LEVELS_PER_SLOT = 3;
/** 一次招募出現的候選人數 */
export const RECRUIT_CHOICES = 3;

/**
 * 生命、重傷、飢餓、死亡（時間以現實分鐘計）。
 */
export const VITALS = {
  regenPctPerMin: 0.02, // （舊）已改由醫療站決定休息回復速度
  severeRegenPctPerMin: 0.008,
  medicCarePctPerMin: 0.001, // 醫生在據點或隊伍中照顧隊友：每分鐘回復 0.1%（比醫療站慢，醫生等級越高越快）
  severeClinicMul: 0.6, // 重傷者在醫療站的回復為一般的 60%
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
