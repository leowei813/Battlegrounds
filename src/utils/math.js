/**
 * 通用數學與隨機工具。
 * 所有遊戲隨機皆透過此模組，便於日後替換為可重現的種子亂數。
 */

export const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

export const lerp = (a, b, t) => a + (b - a) * t;

export const randFloat = (min, max) => min + Math.random() * (max - min);

export const randInt = (min, max) => Math.floor(randFloat(min, max + 1));

export const chance = (p) => Math.random() < p;

export const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

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
  let r = Math.random() * total;
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
