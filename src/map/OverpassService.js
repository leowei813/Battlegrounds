import { POI_TYPES } from '../config/poiTypes.js';
import { POI_MAX_PER_TYPE, POI_SPREAD_CELL_M } from '../config/constants.js';

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

function buildQuery(lat, lon, r) {
  const a = `(around:${r},${lat},${lon})`;
  const big = `(around:${r * 2},${lat},${lon})`;
  return `[out:json][timeout:30];
(
  nwr["shop"]${a};
  nwr["amenity"~"^(hospital|clinic|doctors|school|university|college|kindergarten|library|fuel|charging_station|police|fire_station|restaurant|cafe|fast_food|food_court|marketplace|pharmacy|bank|bar|pub)$"]${a};
  nwr["healthcare"~"^(hospital|clinic)$"]${a};
  nwr["landuse"="military"]${big};
  nwr["military"]${big};
  nwr["building"~"^(warehouse|industrial|factory|manufacture|storage_tank|retail|commercial|supermarket|hospital|school|university)$"]${a};
  nwr["landuse"="industrial"]${a};
  nwr["man_made"="works"]${a};
  nwr["craft"]${a};
  way["building"~"^(apartments|residential|dormitory|house|terrace|detached|semidetached_house)$"]${a};
);
out center tags 4000;`;
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

/**
 * 查詢附近建築並轉為遊戲 POI。
 * @returns {Promise<Array<{id,type,name,lat,lon,osm:true}>>}
 */
export async function fetchPois(lat, lon, radius) {
  const query = buildQuery(lat.toFixed(6), lon.toFixed(6), radius);
  let data = null;
  let lastErr = null;
  for (const url of ENDPOINTS) {
    try {
      data = await fetchWithTimeout(url, query, 30000);
      break;
    } catch (err) {
      lastErr = err;
      console.warn('[Overpass] endpoint failed', url, err.message);
    }
  }
  if (!data) throw lastErr || new Error('Overpass unavailable');

  const byType = {};
  const seen = new Set();
  data.elements.forEach((el) => {
    const type = classify(el.tags);
    if (!type) return;
    const pLat = el.lat ?? el.center?.lat;
    const pLon = el.lon ?? el.center?.lon;
    if (pLat == null || pLon == null) return;
    const id = `osm_${el.type[0]}${el.id}`;
    if (seen.has(id)) return;
    seen.add(id);
    const name = nameFromTags(el.tags);
    (byType[type] = byType[type] || []).push({
      id, type, name, named: !!name, lat: pLat, lon: pLon, osm: true,
    });
  });

  const result = [];
  Object.entries(byType).forEach(([type, list]) => {
    spreadPick(list, POI_MAX_PER_TYPE[type] ?? 20, lat).forEach((p, i) => {
      const { named, ...poi } = p;
      result.push({ ...poi, name: poi.name || `${POI_TYPES[type].name} #${i + 1}` });
    });
  });
  return result;
}
