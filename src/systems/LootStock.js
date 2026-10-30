import { POI_TYPES } from '../config/poiTypes.js';
import { RESOURCE_KEYS } from '../config/constants.js';

/**
 * 建築每日物資：以「建築 ID + 當地日期」為種子隨機產生當天的物資種類與數量，
 * 因此不需要為上千棟建築額外存檔，同一天內結果固定。
 * 建築被探索後清空（記錄 lootedDay），每個現實日晚上 12:00（當地時間）重置並重新隨機。
 */

/** 當地日期的天數編號（每天 00:00 換日） */
export function dayKey(at = Date.now()) {
  const d = new Date(at);
  return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000);
}

/** 距離下一次 00:00 重置的毫秒數 */
export function msToReset(at = Date.now()) {
  const d = new Date(at);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime() - at;
}

function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32：可重現的亂數 */
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function isLooted(poi, at = Date.now()) {
  return poi.lootedDay === dayKey(at);
}

/**
 * 今日物資。已被搜刮則回傳空物資。
 * @returns {{resources: Record<string, number>, itemMul:number, empty:boolean}}
 */
export function stockOf(poi, at = Date.now()) {
  if (isLooted(poi, at)) return { resources: {}, itemMul: 0, empty: true };
  const pt = POI_TYPES[poi.type];
  const rnd = seeded(hashString(`${poi.id}|${dayKey(at)}`));
  // 種類：1～3 種，多半來自該類建築的物資表，偶爾出現意外的物資
  const pool = Object.entries(pt.loot);
  const total = pool.reduce((s, [, w]) => s + w, 0);
  const pickType = () => {
    if (rnd() < 0.15) return RESOURCE_KEYS[Math.floor(rnd() * RESOURCE_KEYS.length)];
    let r = rnd() * total;
    for (const [k, w] of pool) {
      r -= w;
      if (r <= 0) return k;
    }
    return pool[0][0];
  };
  const kinds = 1 + Math.floor(rnd() * 3);
  const resources = {};
  for (let i = 0; i < kinds; i += 1) {
    const k = pickType();
    const amount = Math.round((15 + pt.danger * 12) * (0.4 + rnd() * 1.6));
    resources[k] = (resources[k] || 0) + amount;
  }
  return { resources, itemMul: 0.5 + rnd(), empty: false };
}
