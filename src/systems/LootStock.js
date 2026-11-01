import { POI_TYPES } from '../config/poiTypes.js';
import { RESOURCE_KEYS } from '../config/constants.js';
import { zoneAt } from '../config/zones.js';
import { SUPPLIES, suppliesOf, medWeight } from '../config/supplies.js';

/**
 * 建築每日物資：以「建築 ID + 當地日期」為種子隨機產生當天的物資種類與數量，
 * 因此不需要為上千棟建築額外存檔，同一天內結果固定。
 * 建築被探索後清空（記錄 lootedDay），每天早上 6:00 與下午 6:00（當地時間）各重置一次並重新隨機。
 */

/** 每天的刷新時間（當地時間，小時） */
export const REFRESH_HOURS = [6, 18];
const HALF_DAY = 12 * 3600000;

/** 物資刷新時段編號（每天 06:00、18:00 換一個時段） */
export function dayKey(at = Date.now()) {
  const d = new Date(at);
  const local = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds());
  return Math.floor((local - REFRESH_HOURS[0] * 3600000) / HALF_DAY);
}

/** 距離下一次物資刷新（06:00 或 18:00）的毫秒數 */
export function msToReset(at = Date.now()) {
  const d = new Date(at);
  const next = REFRESH_HOURS.map((h) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), h).getTime())
    .concat(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, REFRESH_HOURS[0]).getTime())
    .find((t) => t > at);
  return next - at;
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

/** 建築內殘留的物資（上次探索帶不走而留下的），只在當天有效 */
export function remainOf(poi, remainMap, at = Date.now()) {
  const r = remainMap?.[poi.id];
  return r && r.day === dayKey(at) && Object.keys(r.res || {}).length ? r.res : null;
}

/** 基礎建設材料的出現機率倍率 */
const BASIC_BUILD_BOOST = 1.4;
const isBasicBuild = (k) => SUPPLIES[k]?.tag === 'struct' && SUPPLIES[k].tier <= 2;
/** 第 1 階（基礎消耗性）零件與布料的出現機率倍率 */
const BASIC_TIER_BOOST = 1.6;
/** 零件與布料依階級的數量倍率：基礎材料較多，階級越高越少 */
const TIER_AMOUNT = [1, 1.3, 0.9, 0.7, 0.5, 0.35];

/** 依類別與危險度挑出具體的材料物品 */
function pickSupply(cat, rnd, danger) {
  let keys;
  let weight;
  if (cat === 'medLow') {
    keys = suppliesOf('med', 2);
    weight = (k) => medWeight(k);
  } else if (cat === 'medMid') {
    keys = suppliesOf('med', 3);
    weight = (k) => medWeight(k);
  } else if (cat === 'med') {
    keys = suppliesOf('med');
    weight = (k) => medWeight(k);
  } else if (cat === 'ammo') {
    keys = suppliesOf('ammo');
    weight = (k) => (k === 'arrow' ? 3 : 2) * 0.6 ** Math.max(0, SUPPLIES[k].tier - danger);
  } else {
    keys = suppliesOf(cat);
    // 越危險的地點越容易出現高階零件與布料
    // 基礎建設材料（第 1～2 階結構零件，例如釘子、螺絲、鐵絲、鐵板）較容易出現
    weight = (k) => 0.45 ** Math.max(0, SUPPLIES[k].tier - Math.ceil(danger / 1.3)) * (isBasicBuild(k) ? BASIC_BUILD_BOOST : 1)
      * (SUPPLIES[k].tier === 1 ? BASIC_TIER_BOOST : 1);
  }
  const total = keys.reduce((sum, k) => sum + weight(k), 0);
  let r = rnd() * total;
  for (const k of keys) {
    r -= weight(k);
    if (r <= 0) return k;
  }
  return keys[0];
}

/** 每單位的數量係數：零件、布料、藥品比食物木材稀少 */
const CAT_AMOUNT = {
  food: 0.65, wood: 1, fuel: 0.7, part: 0.21, fabric: 0.25, medLow: 0.08, medMid: 0.08, med: 0.08, ammo: 0.6,
};
/** 全部物資依比例調降（所有類別一起套用） */
const LOOT_AMOUNT_MUL = 0.85;

/**
 * 今日物資。已被搜刮則回傳空物資；有殘留物資時回傳殘留的部分（並標記 partial）。
 * resources 的鍵為基本資源或具體的材料物品（例如 nail、bandage）。
 * @param {object} [remainMap] state.map.remain
 * @returns {{resources: Record<string, number>, itemMul:number, empty:boolean, partial?:boolean, gear:boolean, vehicle:boolean}}
 */
export function stockOf(poi, at = Date.now(), remainMap = null) {
  const left = remainOf(poi, remainMap, at);
  if (left) return { resources: { ...left }, itemMul: 0, empty: false, partial: true, gear: false, vehicle: false };
  if (isLooted(poi, at)) return { resources: {}, itemMul: 0, empty: true, gear: false, vehicle: false };
  const pt = POI_TYPES[poi.type];
  const rnd = seeded(hashString(`${poi.id}|${dayKey(at)}`));
  // 種類：多半來自該類建築的物資表
  const pool = Object.entries(pt.loot).filter(([k]) => k !== 'gear' && k !== 'vehicle');
  const total = pool.reduce((s, [, w]) => s + w, 0);
  const pickType = () => {
    let r = rnd() * total;
    for (const [k, w] of pool) {
      r -= w;
      if (r <= 0) return k;
    }
    return pool[0][0];
  };
  const kinds = 1 + Math.floor(rnd() * 3) + (pt.amountMul > 1.5 ? 1 : 0);
  const resources = {};
  // 區域越危險物資越豐富
  const zone = zoneAt(poi.lat, poi.lon);
  const danger = pt.danger + Math.max(0, zone.danger || 0);
  for (let i = 0; i < kinds; i += 1) {
    const cat = pickType();
    const key = RESOURCE_KEYS.includes(cat) ? cat : pickSupply(cat, rnd, danger);
    const tierMul = cat === 'part' || cat === 'fabric' ? TIER_AMOUNT[SUPPLIES[key]?.tier || 1] : 1;
    const amount = Math.max(1, Math.round((15 + pt.danger * 12) * (0.4 + rnd() * 1.6) * zone.lootMul * (pt.amountMul || 1) * CAT_AMOUNT[cat] * LOOT_AMOUNT_MUL * tierMul));
    resources[key] = (resources[key] || 0) + amount;
  }
  return {
    resources, itemMul: 0.5 + rnd(), empty: false, gear: pt.itemChance > 0, vehicle: !!pt.loot.vehicle,
  };
}
