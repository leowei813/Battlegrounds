import { POI_TYPES } from '../config/poiTypes.js';
import { POI_MAX_PER_TYPE, POI_SPREAD_CELL_M } from '../config/constants.js';
import { haversine } from '../utils/math.js';

/** 依序嘗試的 Overpass 端點（任一失敗即換下一個） */
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

const RESIDENTIAL = /^(apartments|residential|house|dormitory|terrace|detached|semidetached_house)$/;
const SHOP_AMENITY = /^(restaurant|cafe|fast_food|food_court|marketplace|pharmacy|bank|convenience|bar|pub)$/;
const SCHOOL_AMENITY = /^(school|university|college|kindergarten|library)$/;
const MEDICAL = /^(hospital|clinic|doctors)$/;

/**
 * 從 OSM 標籤判斷遊戲建築類型
 * @returns {string|null}
 */
export function classify(tags = {}) {
  if (MEDICAL.test(tags.amenity || '') || tags.healthcare === 'hospital' || tags.healthcare === 'clinic' || tags.building === 'hospital') return 'hospital';
  if (tags.amenity === 'police' || tags.amenity === 'fire_station') return 'police';
  if (tags.landuse === 'military' || tags.military) return 'military';
  if (tags.amenity === 'fuel' || tags.amenity === 'charging_station') return 'gasStation';
  if (SCHOOL_AMENITY.test(tags.amenity || '') || /^(school|university|college|kindergarten)$/.test(tags.building || '')) return 'school';
  if (tags.building === 'warehouse' || tags.shop === 'wholesale' || tags.building === 'storage_tank') return 'warehouse';
  if (/^(industrial|factory|manufacture)$/.test(tags.building || '') || tags.landuse === 'industrial' || tags.man_made === 'works' || tags.craft) return 'factory';
  if (tags.shop || SHOP_AMENITY.test(tags.amenity || '') || /^(retail|commercial|supermarket)$/.test(tags.building || '')) return 'shop';
  if (RESIDENTIAL.test(tags.building || '') || tags.landuse === 'residential') return 'residential';
  // 沒有標註用途的一般建築（OSM 中最常見）視為住宅
  if (tags.building === 'yes') return 'residential';
  return null;
}

/** 沒有名字時以門牌地址命名（中文：忠孝東路123號；其他：123 Main St） */
export function nameFromTags(tags = {}) {
  const name = tags['name:zh-Hant'] || tags['name:zh'] || tags.name;
  if (name) return name;
  const street = tags['addr:street'];
  const num = tags['addr:housenumber'];
  if (street && num) {
    return /[一-鿿]/.test(street) ? `${street}${num}${/號$/.test(num) ? '' : '號'}` : `${num} ${street}`;
  }
  return '';
}

/** 以中心與半徑（公尺）計算 bbox：[south, west, north, east] */
export function bboxAround(lat, lon, r) {
  const dLat = r / 111320;
  const dLon = r / (111320 * Math.cos((lat * Math.PI) / 180));
  return [lat - dLat, lon - dLon, lat + dLat, lon + dLon];
}

/** 把 bbox 切成 n×n 塊（建築量大的市區分塊查詢，避免單次查詢逾時被截斷） */
export function splitBbox([s, w, n, e], parts = 2) {
  const out = [];
  const dy = (n - s) / parts;
  const dx = (e - w) / parts;
  for (let i = 0; i < parts; i += 1) {
    for (let j = 0; j < parts; j += 1) out.push([s + dy * i, w + dx * j, s + dy * (i + 1), w + dx * (j + 1)]);
  }
  return out;
}

const fmt = (b) => b.map((v) => v.toFixed(6)).join(',');

/** 查詢一：有用途標籤的設施（商店、醫院、學校…），數量較少，一次查完 */
function amenityQuery(bbox, bigBbox) {
  const a = `(${fmt(bbox)})`;
  const big = `(${fmt(bigBbox)})`;
  return `[out:json][timeout:90];
(
  nwr["shop"]${a};
  nwr["amenity"~"^(hospital|clinic|doctors|school|university|college|kindergarten|library|fuel|charging_station|police|fire_station|restaurant|cafe|fast_food|food_court|marketplace|pharmacy|bank|bar|pub)$"]${a};
  nwr["healthcare"~"^(hospital|clinic)$"]${a};
  nwr["landuse"="military"]${big};
  nwr["military"]${big};
  nwr["landuse"="industrial"]${a};
  nwr["man_made"="works"]${a};
  nwr["craft"]${a};
);
out center tags qt;`;
}

/** 查詢二：一個區塊內的所有建築輪廓（含未標註用途的一般建築） */
function buildingQuery(bbox) {
  return `[out:json][timeout:90];
way["building"](${fmt(bbox)});
out center tags qt;`;
}

async function fetchWithTimeout(url, body, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, {
      method: 'POST',
      body: `data=${encodeURIComponent(body)}`,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 分散取樣：有名字的優先；每個格子（約 90 公尺）先取一棟，
 * 不足上限時再補入同格的其他建築，讓地點平均分布在整張地圖上。
 */
export function spreadPick(list, cap, lat0, cellM = POI_SPREAD_CELL_M) {
  const mPerLat = 111320;
  const mPerLon = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const shuffled = [...list].sort(() => Math.random() - 0.5).sort((a, b) => (b.named ? 1 : 0) - (a.named ? 1 : 0));
  const used = new Set();
  const picked = [];
  const rest = [];
  shuffled.forEach((p) => {
    const cell = `${Math.floor((p.lat * mPerLat) / cellM)}:${Math.floor((p.lon * mPerLon) / cellM)}`;
    if (!used.has(cell) && picked.length < cap) {
      used.add(cell);
      picked.push(p);
    } else rest.push(p);
  });
  return picked.concat(rest.slice(0, Math.max(0, cap - picked.length)));
}

/** 依序嘗試各端點；伺服器回報 runtime error（結果被截斷）時拋出 TRUNCATED */
async function runQuery(query) {
  let lastErr = null;
  for (const url of ENDPOINTS) {
    try {
      const data = await fetchWithTimeout(url, query, 100000);
      if (/runtime error/i.test(data.remark || '')) {
        const err = new Error(`TRUNCATED: ${data.remark}`);
        err.truncated = true;
        err.partial = data.elements || [];
        throw err;
      }
      return data.elements || [];
    } catch (err) {
      if (err.truncated) throw err;
      lastErr = err;
      console.warn('[Overpass] endpoint failed', url, err.message);
    }
  }
  throw lastErr || new Error('Overpass unavailable');
}

/** 查詢一個建築區塊；被截斷時再切成 4 塊重抓（最多切兩層） */
async function fetchBuildings(bbox, depth = 0) {
  try {
    return await runQuery(buildingQuery(bbox));
  } catch (err) {
    if (!err.truncated) throw err;
    if (depth >= 2) return err.partial;
    console.warn('[Overpass] 區塊結果被截斷，切小重抓', err.message);
    const parts = [];
    for (const sub of splitBbox(bbox, 2)) parts.push(...await fetchBuildings(sub, depth + 1));
    return parts;
  }
}

/**
 * 查詢附近建築並轉為遊戲 POI。
 * 分成「設施」與 4 個「建築區塊」依序查詢（公共伺服器每個 IP 同時只允許少量請求）。
 * @param {(done:number,total:number)=>void} [onProgress]
 * @returns {Promise<Array<{id,type,name,lat,lon,osm:true}>>}
 */
export async function fetchPois(lat, lon, radius, onProgress = () => {}) {
  const bbox = bboxAround(lat, lon, radius);
  const tiles = splitBbox(bbox, 2);
  const total = tiles.length + 1;
  onProgress(0, total);
  const elements = await runQuery(amenityQuery(bbox, bboxAround(lat, lon, radius * 2))).catch((err) => {
    if (err.truncated) return err.partial;
    throw err;
  });
  onProgress(1, total);
  let buildingErr = null;
  for (let i = 0; i < tiles.length; i += 1) {
    try {
      elements.push(...await fetchBuildings(tiles[i]));
    } catch (err) {
      buildingErr = err; // 某區塊失敗不影響其他區塊
    }
    onProgress(i + 2, total);
  }
  if (!elements.length && buildingErr) throw buildingErr;

  const byType = {};
  const seen = new Set();
  elements.forEach((el) => {
    const type = classify(el.tags);
    if (!type) return;
    const pLat = el.lat ?? el.center?.lat;
    const pLon = el.lon ?? el.center?.lon;
    if (pLat == null || pLon == null) return;
    const id = `osm_${el.type[0]}${el.id}`;
    if (seen.has(id)) return;
    seen.add(id);
    // bbox 是方形；只保留圓形掃描範圍內（軍事區放寬兩倍）
    const limit = type === 'military' ? radius * 2 : radius;
    if (haversine(lat, lon, pLat, pLon) > limit) return;
    const name = nameFromTags(el.tags);
    (byType[type] = byType[type] || []).push({
      id, type, name, named: !!name, lat: +pLat.toFixed(6), lon: +pLon.toFixed(6), osm: true,
    });
  });

  const result = [];
  Object.entries(byType).forEach(([type, list]) => {
    spreadPick(list, POI_MAX_PER_TYPE[type] ?? 200, lat).forEach((p, i) => {
      const { named, ...poi } = p;
      result.push({ ...poi, name: poi.name || `${POI_TYPES[type].name} #${i + 1}` });
    });
  });
  return result;
}
