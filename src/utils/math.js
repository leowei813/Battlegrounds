/**
 * 通用數學與隨機工具。
 * 所有遊戲隨機皆透過此模組；重要結果（製作、招募、探索、戰鬥）改用存檔中的種子，
 * 重新讀檔也會得到相同結果，無法靠反覆讀檔刷結果。
 */

export const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

export const lerp = (a, b, t) => a + (b - a) * t;

/** 目前使用的亂數來源（預設 Math.random；withSeed 期間改為種子亂數） */
let source = Math.random;
const rnd = () => source();

/** 新的隨機種子（32 位元整數） */
export const newSeed = () => Math.floor(Math.random() * 2 ** 32) >>> 0;

/**
 * 在 fn 執行期間，所有遊戲隨機都改用 holder[key] 的種子（mulberry32），結束後寫回推進後的種子。
 * 種子隨存檔保存並立即上傳，因此讀回舊存檔會重現同樣的結果。
 * @template T
 * @param {Record<string, number>} holder 存檔中的種子表（state.rng）
 * @param {string} key 種子名稱
 * @param {() => T} fn
 * @returns {T}
 */
export function withSeed(holder, key, fn) {
  if (source !== Math.random || !holder) return fn(); // 巢狀呼叫沿用外層種子
  let s = Number.isInteger(holder[key]) ? holder[key] >>> 0 : newSeed();
  source = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  try {
    return fn();
  } finally {
    holder[key] = s;
    source = Math.random;
  }
}

export const randFloat = (min, max) => min + rnd() * (max - min);

export const randInt = (min, max) => Math.floor(randFloat(min, max + 1));

export const chance = (p) => rnd() < p;

export const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

/**
 * 依權重隨機挑選。
 * @param {Record<string, number>|Array<{weight:number}>} table
 * @returns {string|object|null}
 */
export function weightedPick(table) {
  const entries = Array.isArray(table)
    ? table.map((e) => [e, e.weight])
    : Object.entries(table);
  const total = entries.reduce((s, [, w]) => s + Math.max(0, w), 0);
  if (total <= 0) return null;
  let r = rnd() * total;
  for (const [key, w] of entries) {
    r -= Math.max(0, w);
    if (r <= 0) return key;
  }
  return entries[entries.length - 1][0];
}

let uidCounter = 0;
/** 產生短唯一 ID（時間 + 計數 + 亂數）。 */
export function uid(prefix = 'id') {
  uidCounter = (uidCounter + 1) % 1e6;
  return `${prefix}_${Date.now().toString(36)}${uidCounter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** 數字縮寫：1234 -> 1.2K */
export function formatNumber(n) {
  const v = Math.floor(n);
  if (Math.abs(v) >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (Math.abs(v) >= 1e4) return `${(v / 1e3).toFixed(1)}K`;
  return String(v);
}

/** 毫秒 -> 「1時 05分」/「3分 20秒」 */
export function formatDuration(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}時 ${String(m).padStart(2, '0')}分`;
  if (m > 0) return `${m}分 ${String(sec).padStart(2, '0')}秒`;
  return `${sec}秒`;
}

const EARTH_R = 6371000;
const toRad = (d) => (d * Math.PI) / 180;

/** 兩經緯度間距離（公尺）。 */
export function haversine(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.sqrt(a));
}

/** 從某點依方位角與距離位移，回傳新經緯度。 */
export function offsetLatLon(lat, lon, distanceM, bearingRad) {
  const dLat = (distanceM * Math.cos(bearingRad)) / EARTH_R;
  const dLon = (distanceM * Math.sin(bearingRad)) / (EARTH_R * Math.cos(toRad(lat)));
  return { lat: lat + (dLat * 180) / Math.PI, lon: lon + (dLon * 180) / Math.PI };
}
