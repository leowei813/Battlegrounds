import { WORLD_BOUNDS } from './world.js';

/**
 * 區域危險度：整張世界地圖依座標劃分為 6 種區域（所有玩家看到的都一樣）。
 * 區域越危險，物資越豐富、裝備品級越高，但殭屍與屍潮也越強。
 *
 *  - lootMul      建築每日物資倍率
 *  - rarityBoost  裝備品級加成（越高越容易出高品級）
 *  - danger       探索／地圖殭屍的區域危險度加成
 *  - siegeLevel   據點屍潮殭屍等級加成
 *  - siegeMul     據點屍潮數量倍率
 */
export const ZONES = [
  { id: 'safe', name: '安全區', color: '#43a047', alpha: 0.07, lootMul: 0.6, rarityBoost: 0, danger: -1, siegeLevel: 0, siegeMul: 0.75 },
  { id: 'normal', name: '一般區', color: '#9ccc65', alpha: 0.07, lootMul: 1, rarityBoost: 0.05, danger: 0, siegeLevel: 0, siegeMul: 1 },
  { id: 'alert', name: '警戒區', color: '#fdd835', alpha: 0.09, lootMul: 1.3, rarityBoost: 0.15, danger: 1, siegeLevel: 1, siegeMul: 1.2 },
  { id: 'danger', name: '危險區', color: '#e53935', alpha: 0.1, lootMul: 1.7, rarityBoost: 0.3, danger: 2, siegeLevel: 3, siegeMul: 1.45 },
  { id: 'lethal', name: '致死區', color: '#8e24aa', alpha: 0.12, lootMul: 2.2, rarityBoost: 0.5, danger: 3, siegeLevel: 5, siegeMul: 1.75 },
  { id: 'abyss', name: '深淵區', color: '#000000', alpha: 0.22, lootMul: 3, rarityBoost: 0.8, danger: 5, siegeLevel: 8, siegeMul: 2.2 },
];

/** 兩層雜訊的格點間距（度）：大區塊約 900 公尺、細節約 350 公尺 */
const COARSE = 0.008;
const FINE = 0.0032;

function hash2(x, y) {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ 0x5bd1e995;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const smooth = (t) => t * t * (3 - 2 * t);

/** 平滑的數值雜訊（0～1） */
function valueNoise(lat, lon, step) {
  const gx = lon / step;
  const gy = lat / step;
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const tx = smooth(gx - x0);
  const ty = smooth(gy - y0);
  const a = hash2(x0, y0);
  const b = hash2(x0 + 1, y0);
  const c = hash2(x0, y0 + 1);
  const d = hash2(x0 + 1, y0 + 1);
  return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
}

/** 座標的區域雜訊值（0～1） */
export function zoneValue(lat, lon) {
  return valueNoise(lat, lon, COARSE) * 0.7 + valueNoise(lat + 31.7, lon - 17.3, FINE) * 0.3;
}

/**
 * v15：區域依東西位置劃分（所有玩家相同）：
 * 左側安全區（玩家據點區）→ 一般 → 警戒 → 危險 → 致死 → 深淵（緊鄰勢力領地）→ 最右側三大勢力大本營領地。
 * 交界用雜訊做成不規則的形狀。
 */
export const ZONE_BANDS = [[0.12, 0], [0.24, 1], [0.38, 2], [0.52, 3], [0.67, 4], [0.9, 5]];
/** 最右側三大勢力大本營領地的起點（東西位置） */
export const NPC_HOME_X = 0.9;
const BOUNDS = { w: WORLD_BOUNDS.w, e: WORLD_BOUNDS.e };
/** 經度換算成地圖上的東西位置（0 = 最西、1 = 最東） */
export const normX = (lon) => (lon - BOUNDS.w) / (BOUNDS.e - BOUNDS.w);
/** 交界的不規則偏移（約 ±0.02） */
const edgeNoise = (lat, lon) => (valueNoise(lat, lon, FINE) - 0.5) * 0.035 + (valueNoise(lat + 3.1, lon - 1.7, COARSE) - 0.5) * 0.02;
const bandX = (lat, lon) => normX(lon) + edgeNoise(lat, lon);

/** 是否在三大勢力大本營領地（最右側：不能探索、沒有建築） */
export const inNpcHome = (lat, lon) => bandX(lat, lon) >= NPC_HOME_X;

/** 座標所在區域的索引（0 = 安全區 … 5 = 深淵區；勢力領地算安全區） */
export function zoneIndexAt(lat, lon) {
  const x = bandX(lat, lon);
  if (x >= NPC_HOME_X) return 0;
  for (const [t, z] of ZONE_BANDS) if (x < t) return z;
  return 5;
}

/** 在地圖的哪一側：玩家側（西）或勢力側（東） */
export const zoneSide = (lat, lon) => (normX(lon) < 0.6 ? 'player' : 'npc');

/** 是否在玩家據點區（左側安全區，可以建立避難所） */
export const inPlayerSafe = (lat, lon) => zoneIndexAt(lat, lon) === 0 && !inNpcHome(lat, lon);

/** @returns {typeof ZONES[number]} */
export const zoneAt = (lat, lon) => ZONES[zoneIndexAt(lat, lon)];
