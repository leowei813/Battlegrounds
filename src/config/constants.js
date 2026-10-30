/** 全域常數。調整數值平衡請優先修改 config/ 下的資料檔。 */

export const GAME_TITLE = '絕地求生';
export const SAVE_KEY = 'jdqs_save_v1';
export const SAVE_VERSION = 8;

export const TICK_MS = 1000;
export const AUTOSAVE_MS = 30 * 1000;

/** 現實 30 分鐘 = 遊戲 1 天 */
export const DAY_REAL_MS = 30 * 60 * 1000;
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
  gasStation: 200, hospital: 300, police: 200, military: 100,
};
/** 分散取樣的格子大小（公尺）：同一格優先只取一棟，避免擠在一起 */
export const POI_SPREAD_CELL_M = 40;
/** 地圖殭屍刷新週期 */
export const ZOMBIE_REFRESH_MS = 5 * 60 * 1000;
export const ZOMBIE_MAX_GROUPS = 60;

/** 探索可選時長（分鐘） */
export const EXPLORE_DURATIONS = [5, 15, 30, 60];
export const MAX_TEAM_SIZE = 4;

/** 同時施工數 */
export const BUILD_QUEUE_SIZE = 2;

export const MAX_LOG = 80;

export const RESOURCES = {
  food: { name: '食物', icon: '🥫' },
  wood: { name: '木材', icon: '🪵' },
  metal: { name: '金屬', icon: '🔩' },
  cloth: { name: '布料', icon: '🧵' },
  fuel: { name: '燃料', icon: '⛽' },
  medicine: { name: '藥品', icon: '💊' },
};
export const RESOURCE_KEYS = Object.keys(RESOURCES);

export const CURRENCIES = {
  coins: { name: '金錢', icon: '💰' },
  parts: { name: '稀有材料', icon: '⚙️' },
};

/** 新遊戲初始資源 */
export const STARTING_RESOURCES = {
  food: 200, wood: 150, metal: 80, cloth: 60, fuel: 40, medicine: 15,
};
export const STARTING_COINS = 150;
