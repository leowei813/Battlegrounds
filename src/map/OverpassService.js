import { POI_TYPES } from '../config/poiTypes.js';
import { POI_MAX_PER_TYPE } from '../config/constants.js';

/** 依序嘗試的 Overpass 端點（任一失敗即換下一個） */
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

const RESIDENTIAL = /^(apartments|residential|house|dormitory|terrace|detached)$/;

/**
 * 從 OSM 標籤判斷遊戲建築類型
 * @returns {string|null}
 */
export function classify(tags = {}) {
  if (tags.amenity === 'hospital' || tags.amenity === 'clinic' || tags.healthcare === 'hospital') return 'hospital';
  if (tags.amenity === 'police') return 'police';
  if (tags.landuse === 'military' || tags.military) return 'military';
  if (tags.amenity === 'fuel') return 'gasStation';
  if (/^(school|university|college|kindergarten)$/.test(tags.amenity || '')) return 'school';
  if (tags.building === 'warehouse' || tags.shop === 'wholesale') return 'warehouse';
  if (/^(industrial|factory|manufacture)$/.test(tags.building || '') || tags.landuse === 'industrial' || tags.man_made === 'works') return 'factory';
  if (tags.shop) return 'shop';
  if (RESIDENTIAL.test(tags.building || '') || tags.landuse === 'residential') return 'residential';
  return null;
}

function buildQuery(lat, lon, r) {
  const a = `(around:${r},${lat},${lon})`;
  const big = `(around:${r * 2},${lat},${lon})`;
  return `[out:json][timeout:25];
(
  nwr["shop"]${a};
  nwr["amenity"~"^(hospital|clinic|school|university|college|kindergarten|fuel|police)$"]${a};
  nwr["healthcare"="hospital"]${a};
  nwr["landuse"="military"]${big};
  nwr["military"]${big};
  nwr["building"~"^(warehouse|industrial|factory)$"]${a};
  nwr["landuse"="industrial"]${a};
  nwr["man_made"="works"]${a};
  way["building"~"^(apartments|residential|dormitory)$"]${a};
);
out center tags 1500;`;
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
 * 查詢附近建築並轉為遊戲 POI。
 * @returns {Promise<Array<{id,type,name,lat,lon,osm:true}>>}
 */
export async function fetchPois(lat, lon, radius) {
  const query = buildQuery(lat.toFixed(6), lon.toFixed(6), radius);
  let data = null;
  let lastErr = null;
  for (const url of ENDPOINTS) {
    try {
      data = await fetchWithTimeout(url, query, 25000);
      break;
    } catch (err) {
      lastErr = err;
      console.warn('[Overpass] endpoint failed', url, err.message);
    }
  }
  if (!data) throw lastErr || new Error('Overpass unavailable');

  const byType = {};
  data.elements.forEach((el) => {
    const type = classify(el.tags);
    if (!type) return;
    const pLat = el.lat ?? el.center?.lat;
    const pLon = el.lon ?? el.center?.lon;
    if (pLat == null || pLon == null) return;
    const name = el.tags['name:zh-Hant'] || el.tags['name:zh'] || el.tags.name || '';
    (byType[type] = byType[type] || []).push({
      id: `osm_${el.type[0]}${el.id}`, type, name, lat: pLat, lon: pLon, osm: true,
    });
  });

  // 每類限制數量：有名字的優先，其餘隨機
  const result = [];
  Object.entries(byType).forEach(([type, list]) => {
    list.sort((a, b) => (b.name ? 1 : 0) - (a.name ? 1 : 0) || Math.random() - 0.5);
    list.slice(0, POI_MAX_PER_TYPE).forEach((p, i) => {
      result.push({ ...p, name: p.name || `${POI_TYPES[type].name} #${i + 1}` });
    });
  });
  return result;
}
