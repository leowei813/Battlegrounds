import { sha256 } from '../utils/sha256.js';
import { withOwnSeed } from '../utils/math.js';

/**
 * 全世界共用的格子與決定性亂數：所有玩家用同樣的格子與種子，算出同樣的 NPC、殭屍群、重度感染據點。
 */

const KM_LAT = 111.32;

/** 字串 → 32 位元種子 */
export const seedOf = (str) => parseInt(sha256(String(str)).slice(0, 8), 16) >>> 0;

/** 以字串為種子執行（期間 randFloat/chance/pick… 都是決定性的） */
export function seeded(str, fn) {
  return withOwnSeed(seedOf(str), fn);
}

/** 經緯度所在的格子（格子大小 km；經度方向依緯度帶換算，與玩家位置無關） */
export function cellOf(lat, lon, km) {
  const dLat = km / KM_LAT;
  const i = Math.floor(lat / dLat);
  const dLon = km / (KM_LAT * Math.max(0.1, Math.cos(((i + 0.5) * dLat * Math.PI) / 180)));
  return { i, j: Math.floor(lon / dLon), key: `${i}:${Math.floor(lon / dLon)}`, dLat, dLon };
}

/** 格子的範圍 */
export function cellBox(i, j, km) {
  const dLat = km / KM_LAT;
  const dLon = km / (KM_LAT * Math.max(0.1, Math.cos(((i + 0.5) * dLat * Math.PI) / 180)));
  return {
    lat0: i * dLat, lon0: j * dLon, dLat, dLon, lat: (i + 0.5) * dLat, lon: (j + 0.5) * dLon,
  };
}

/** 某點周圍 r 公里內的所有格子 */
export function cellsAround(lat, lon, km, rKm) {
  const c = cellOf(lat, lon, km);
  const n = Math.ceil(rKm / km);
  const out = [];
  for (let di = -n; di <= n; di += 1) {
    for (let dj = -n; dj <= n; dj += 1) out.push({ i: c.i + di, j: c.j + dj, key: `${c.i + di}:${c.j + dj}` });
  }
  return out;
}
