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

/** 雜訊門檻：值落在第 i 個門檻以下即為第 i 級區域 */
const THRESHOLDS = [0.33, 0.47, 0.58, 0.68, 0.77];
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

/** 座標所在區域的索引（0 = 安全區 … 5 = 深淵區） */
export function zoneIndexAt(lat, lon) {
  const v = zoneValue(lat, lon);
  const i = THRESHOLDS.findIndex((t) => v < t);
  return i === -1 ? ZONES.length - 1 : i;
}

/** @returns {typeof ZONES[number]} */
export const zoneAt = (lat, lon) => ZONES[zoneIndexAt(lat, lon)];
