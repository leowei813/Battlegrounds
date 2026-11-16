/** 全域常數。調整數值平衡請優先修改 config/ 下的資料檔。 */

export const GAME_TITLE = '絕地求生';
export const SAVE_KEY = 'jdqs_save_v1';
export const SAVE_VERSION = 41;

export const TICK_MS = 1000;
/** v15.7 省電：沒有屍潮時地圖圖層每秒畫 10 次（有屍潮時逐幀） */
export const IDLE_LOW_FPS = true;
/** 設定「地圖更新頻率」可選的每秒次數與預設值 */
export const MAP_FPS_OPTIONS = [10, 30, 60];
export const MAP_FPS_DEFAULT = 10;
/** v15.7 省電：沒有屍潮時屍潮模擬每秒推進一次（依經過時間補算，結果相同） */
export const IDLE_SIEGE_THROTTLE = true;
export const AUTOSAVE_MS = 30 * 1000;

/** v15.7：遊戲一天＝現實 90 分鐘（原本 60 分鐘，DAY_SWITCH_AT 之前照舊制計算，時間連續不跳） */
export const DAY_REAL_MS = 90 * 60 * 1000;
export const DAY_REAL_MS_OLD = 60 * 60 * 1000;
/** 改為 90 分鐘一天的時刻（所有玩家相同；發版時設定在上線後幾分鐘） */
export const DAY_SWITCH_AT = Date.UTC(2026, 10, 9, 16, 45, 0); // 台灣時間 11/10 00:45
/** 遊戲開始時的時刻（早上 8 點） */
export const START_HOUR = 8;

/** 離線收益上限 24 小時 */
export const OFFLINE_CAP_MS = 24 * 60 * 60 * 1000;

/** OSM 掃描半徑（公尺） */
export const POI_SCAN_RADIUS = 1200;
/** 前哨站周圍的掃描半徑（公尺，比避難所小） */
export const OUTPOST_SCAN_RADIUS = 500;
/** 每類建築在地圖上的數量上限（優先保留有名字的建築，並平均分散） */
export const POI_MAX_PER_TYPE = {
  residential: 6000, shop: 1500, school: 300, factory: 600, warehouse: 400,
  gasStation: 200, hospital: 300, police: 200, military: 100, garage: 200, supermarket: 80, forest: 120, pharmacy: 150, recycling: 80, bakery: 150,
};
/** 分散取樣的格子大小（公尺）：同一格優先只取一棟，避免擠在一起 */
export const POI_SPREAD_CELL_M = 40;
/** 地圖建築密度上限：每個方格（公尺）最多一個地點，避免密集住宅區擠滿標記 */
export const POI_DENSITY_CELL_M = 50;
/** 密度調整版本：變更規則時遞增，舊地圖會在下次開啟時重新整理 */
export const POI_THIN_VERSION = 1;
/** 地圖殭屍刷新週期 */
export const ZOMBIE_REFRESH_MS = 5 * 60 * 1000;
export const ZOMBIE_MAX_GROUPS = 60;

/** 探索可選時長（分鐘） */
export const EXPLORE_DURATIONS = [5, 15, 30, 60];
export const MAX_TEAM_SIZE = 4;

/** 每個據點同時施工數 */
export const BUILD_QUEUE_SIZE = 3;
/** 同時在外的隊伍上限（探索、攻打、突襲、攔截都算） */
export const MAX_EXPEDITIONS = 5;

export const MAX_LOG = 80;

export const RESOURCES = {
  food: { name: '食物', icon: '🥫' },
  wood: { name: '木材', icon: '🪵' },
  fuel: { name: '燃料', icon: '⛽' },
};
export const RESOURCE_KEYS = Object.keys(RESOURCES);

export const CURRENCIES = {
  coins: { name: '金錢', icon: '💰' },
  parts: { name: '稀有材料', icon: '⚙️' },
  /** v10.12：重生器洗鍊時鎖住素質用（不佔物品格） */
  locks: { name: '就是要鎖你', icon: '🔒' },
};

/** 新遊戲初始資源 */
export const STARTING_RESOURCES = {
  food: 200, wood: 150, fuel: 40,
};
/** 新遊戲初始材料物品（零件、布料、藥品、彈藥；見 config/supplies.js） */
export const STARTING_SUPPLIES = {
  nail: 40, screw: 40, scrap: 30, bolt: 15, wire: 10, tape: 10, glass: 20, ironWire: 25, rubber: 10, plastic: 10, bulb: 10,
  coarse: 25, cotton: 20, linen: 10, bandage: 5, gauze: 5, arrow: 20,
};
export const STARTING_COINS = 150;

/** 戰鬥（探索、攔截、屍潮等）掉落金錢的倍率 */
export const COIN_GAIN_MUL = 0.8;

/**
 * 攻打玩家避難所（玩家突襲、NPC 掠奪）的移動時間較長，讓防守方有時間準備。
 *  - playerMul / npcMul：步行時間倍率
 *  - minMin：步行最少分鐘數（載具仍有加速效果）
 */
export const RAID_TRAVEL = { playerMul: 4, npcMul: 2.5, minMin: 5 };

/**
 * 世界時間：所有玩家共用同一個日曆與日夜。
 * WORLD_EPOCH_MS 這一刻為 2050/1/1 06:00（v9.0.0 上線時間），遊戲一天＝現實 1 小時（v15.7 起 90 分鐘）。
 */
export const WORLD_EPOCH_MS = Date.UTC(2026, 10, 3, 7, 10, 0);
export const WORLD_START = { year: 2050, month: 1, day: 1, hour: 6 };
