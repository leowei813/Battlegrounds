/**
 * v13：固定的方形世界地圖（所有玩家共用同一張地圖）。
 * 範圍外不能建立據點、不會產生地點、NPC、屍群與重度感染據點。
 */
export const WORLD_BOUNDS = { n: 25.0427, s: 25.0254, w: 121.5557, e: 121.5798 };

export const WORLD_CENTER = {
  lat: (WORLD_BOUNDS.n + WORLD_BOUNDS.s) / 2,
  lon: (WORLD_BOUNDS.w + WORLD_BOUNDS.e) / 2,
};

/** 規劃用格線：8 欄（1～8，由西到東）× 7 列（A～G，由北到南） */
export const WORLD_GRID = { cols: 8, rows: 7 };

/** 座標是否在世界範圍內（pad：往內縮的公尺數） */
export function inWorld(lat, lon, pad = 0) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  const b = WORLD_BOUNDS;
  const dLat = pad / 111320;
  const dLon = pad / (111320 * Math.cos((WORLD_CENTER.lat * Math.PI) / 180));
  return lat <= b.n - dLat && lat >= b.s + dLat && lon >= b.w + dLon && lon <= b.e - dLon;
}

/** 格線代號（例如 "E4"）的中心座標 */
export function gridCenter(code) {
  const m = /^([A-G])([1-8])$/.exec(String(code).toUpperCase());
  if (!m) return null;
  const b = WORLD_BOUNDS;
  const r = 'ABCDEFG'.indexOf(m[1]);
  const c = Number(m[2]) - 1;
  return {
    lat: b.n - ((r + 0.5) * (b.n - b.s)) / WORLD_GRID.rows,
    lon: b.w + ((c + 0.5) * (b.e - b.w)) / WORLD_GRID.cols,
  };
}

/** 範圍內的隨機座標（rnd 預設 Math.random） */
export function randomInWorld(rnd = Math.random, pad = 150) {
  const b = WORLD_BOUNDS;
  const dLat = pad / 111320;
  const dLon = pad / (111320 * Math.cos((WORLD_CENTER.lat * Math.PI) / 180));
  return {
    lat: b.s + dLat + rnd() * (b.n - b.s - 2 * dLat),
    lon: b.w + dLon + rnd() * (b.e - b.w - 2 * dLon),
  };
}

/** 中心到角落的距離（公尺），用來設定同步範圍 */
export const WORLD_HALF_DIAG_M = Math.hypot(
  ((WORLD_BOUNDS.n - WORLD_BOUNDS.s) / 2) * 111320,
  ((WORLD_BOUNDS.e - WORLD_BOUNDS.w) / 2) * 111320 * Math.cos((WORLD_CENTER.lat * Math.PI) / 180),
);
