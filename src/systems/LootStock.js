import { POI_TYPES } from '../config/poiTypes.js';
import { RESOURCE_KEYS } from '../config/constants.js';
import { zoneAt } from '../config/zones.js';
import { SUPPLIES, suppliesOf, medWeight } from '../config/supplies.js';
import { balanceMultipliers } from './MaterialBalance.js';

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

/** 單一物資殘留數量上限 */
const REMAIN_MAX = 2000;

/** 建築內殘留的物資（上次探索帶不走而留下的），只在當天有效 */
export function remainOf(poi, remainMap, at = Date.now()) {
  const r = remainMap?.[poi.id];
  if (!(r && r.day === dayKey(at) && Object.keys(r.res || {}).length)) return null;
  // 舊版重複加成造成的異常數量：限制在合理範圍
  return Object.fromEntries(Object.entries(r.res).map(([k, v]) => [k, Math.min(REMAIN_MAX, Math.max(0, Math.floor(v) || 0))]));
}

/** 基礎建設材料的出現機率倍率 */
const BASIC_BUILD_BOOST = 1.4;
const isBasicBuild = (k) => SUPPLIES[k]?.tag === 'struct' && SUPPLIES[k].tier <= 2;
/** 第 1 階（基礎消耗性）零件與布料的出現機率倍率 */
const BASIC_TIER_BOOST = 1.6;
/** 塑膠外殼的出現機率倍率（霰彈、建築都會用到，原本太難取得） */
const PLASTIC_BOOST = 1.5;
/** 資源回收站：電子零件（電線、燈泡、塑膠外殼、電池…）的出現機率倍率 */
const RECYCLING_ELEC_BOOST = 2;
/** 這些常見地點本身不太出零件，但每次有機會找到少量塑膠外殼 */
export const PLASTIC_SPOTS = { supermarket: 0.15, residential: 0.1, school: 0.15 };
/**
 * v15.13：同階總掉落量固定。每一階的掉落量依「基準種類數」計算，新增或移除材料時該階總量不變，
 * 只是由同階的材料依需求比例分配（不會擠壓其他階）。基準＝v15.13 新增聚酯纖維前的種類數。
 * 之後新增材料不要改這張表；要調整某一階的總量請改 TIER_DROP_BOOST。
 */
export const TIER_BASE_KINDS = {
  'part:1': 11, 'part:2': 9, 'part:3': 8, 'part:4': 6, 'part:5': 4,
  'fabric:1': 3, 'fabric:2': 3, 'fabric:3': 1, 'fabric:4': 2, 'fabric:5': 1,
};
/** 某一階的總掉落量倍率（v15.13：第 3 階布料 ×1.3） */
export const TIER_DROP_BOOST = { 'fabric:3': 1.3 };
const tierGroup = (k) => `${SUPPLIES[k].cat}:${SUPPLIES[k].tier}`;
const tierKinds = {};
suppliesOf('part').concat(suppliesOf('fabric')).filter((k) => SUPPLIES[k].tag !== 'ammo').forEach((k) => { tierKinds[tierGroup(k)] = (tierKinds[tierGroup(k)] || 0) + 1; });
/** 同階種類數變動時的換算倍率（種類數與基準相同時為 1） */
const tierScale = (k) => {
  const g = tierGroup(k);
  const base = TIER_BASE_KINDS[g];
  return (base && tierKinds[g] ? base / tierKinds[g] : 1) * (TIER_DROP_BOOST[g] ?? 1);
};

/** 零件與布料掉落的基本權重（與危險度、建築類型無關的部分） */
export const baseSupplyWeight = (k) => (isBasicBuild(k) ? BASIC_BUILD_BOOST : 1)
  * (SUPPLIES[k].tier === 1 ? BASIC_TIER_BOOST : 1)
  * (k === 'plastic' ? PLASTIC_BOOST : 1)
  * (['part', 'fabric'].includes(SUPPLIES[k].cat) ? tierScale(k) : 1);
/** 找到零件時額外多找到 1、2 種零件的機率 */
const PART_EXTRA_KINDS = [0.6, 0.3];

/** 零件與布料依階級的數量倍率：基礎材料較多，階級越高越少 */
const TIER_AMOUNT = [1, 1.3, 0.9, 0.7, 0.5, 0.35];

/** 藥品依風險提高高階藥品的權重：每點風險讓每高一階的權重多 MED_RISK_GROWTH 倍 */
const MED_RISK_GROWTH = 0.1;
const medRiskWeight = (k, danger) => medWeight(k) * (1 + MED_RISK_GROWTH * Math.max(0, danger)) ** (SUPPLIES[k].tier - 1);

/** 依類別與危險度挑出具體的材料物品（poiType：依建築類型調整，例如回收站多電子零件） */
export function pickSupply(cat, rnd, danger, poiType = null) {
  let keys;
  let weight;
  if (cat === 'medLow') {
    keys = suppliesOf('med', 2);
    weight = (k) => medRiskWeight(k, danger);
  } else if (cat === 'medMid') {
    keys = suppliesOf('med', 3);
    weight = (k) => medRiskWeight(k, danger);
  } else if (cat === 'med') {
    keys = suppliesOf('med');
    weight = (k) => medRiskWeight(k, danger);
  } else if (cat === 'ammo') {
    // 彈藥類地點也常找到彈殼
    keys = [...suppliesOf('ammo'), 'casing'];
    weight = (k) => (k === 'casing' ? 3 : k === 'arrow' ? 3 : 2) * 0.6 ** Math.max(0, SUPPLIES[k].tier - danger);
  } else if (cat === 'casing') {
    return 'casing';
  } else {
    keys = suppliesOf(cat).filter((k) => SUPPLIES[k].tag !== 'ammo');
    // 越危險的地點越容易出現高階零件與布料
    // 基礎建設材料（第 1～2 階結構零件，例如釘子、螺絲、鐵絲、鐵板）較容易出現
    // v13.3：同階內依需求比例調整掉落（MaterialBalance，隨成本設定自動更新）
    const bal = balanceMultipliers(baseSupplyWeight);
    weight = (k) => 0.45 ** Math.max(0, SUPPLIES[k].tier - Math.ceil(danger / 1.3)) * baseSupplyWeight(k) * (bal[k] ?? 1)
      * (poiType === 'recycling' && SUPPLIES[k].tag === 'elec' ? RECYCLING_ELEC_BOOST : 1);
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
  food: 0.65, wood: 1, fuel: 0.7, part: 0.21, casing: 0.5, fabric: 0.25, medLow: 0.08, medMid: 0.08, med: 0.08, ammo: 0.6,
};
/** 全部物資依比例調降（所有類別一起套用） */
const LOOT_AMOUNT_MUL = 0.85;
/**
 * 依風險調整數量：越安全的地點調降越多，高風險地點保留較多（風險 = 建築危險度 + 區域危險度）。
 * 風險 0 → ×0.45、風險 4 → ×0.69、風險 8 以上 → ×0.9
 */
export const riskAmountMul = (risk) => Math.min(0.9, Math.max(0.45, 0.45 + 0.06 * Math.max(0, risk)));

/**
 * 地點目前的物資（v10：所有玩家共用）。已被搜空回傳空物資；搜過一部分時回傳剩下的部分（並標記 partial）。
 * 物資依「地點 ID + 世代」產生：搜空一段時間後換下一個世代、重新產生。
 * resources 的鍵為基本資源或具體的材料物品（例如 nail、bandage）。
 * @param {{gen:number, empty:boolean, left:{res:object}|null}} [view] PoiShareSystem.view() 的結果；沒有時視為第 0 世代、沒被搜過
 * @returns {{resources: Record<string, number>, itemMul:number, empty:boolean, partial?:boolean, gear:boolean, vehicle:boolean}}
 */
export function stockOf(poi, at = Date.now(), view = null) {
  if (view?.empty) return { resources: {}, itemMul: 0, empty: true, gear: false, vehicle: false };
  if (view?.left) {
    const left = Object.fromEntries(Object.entries(view.left.res || {}).map(([k, v]) => [k, Math.min(REMAIN_MAX, Math.max(0, Math.floor(v) || 0))]).filter(([, v]) => v > 0));
    if (Object.keys(left).length) return { resources: left, itemMul: 0, empty: false, partial: true, gear: false, vehicle: false };
  }
  const pt = POI_TYPES[poi.type];
  const rnd = seeded(hashString(`${poi.id}|g${view?.gen || 0}`));
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
  const kinds = 1 + Math.floor(rnd() * 3) + (pt.amountMul > 1.5 ? 1 : 0) + (pt.extraKinds || 0);
  const resources = {};
  // 區域越危險物資越豐富
  const zone = zoneAt(poi.lat, poi.lon);
  const danger = pt.danger + Math.max(0, zone.danger || 0);
  for (let i = 0; i < kinds; i += 1) {
    const cat = i === 0 && pt.lootFirst ? pt.lootFirst : pickType();
    const key = RESOURCE_KEYS.includes(cat) ? cat : pickSupply(cat, rnd, danger, poi.type);
    const tierMul = (cat === 'part' || cat === 'fabric' ? TIER_AMOUNT[SUPPLIES[key]?.tier || 1] : 1) * (pt.lootAmount?.[cat] ?? (cat.startsWith('med') ? pt.lootAmount?.med ?? 1 : 1));
    const amount = Math.max(1, Math.round((15 + pt.danger * 12) * (0.4 + rnd() * 1.6) * zone.lootMul * (pt.amountMul || 1) * CAT_AMOUNT[cat] * LOOT_AMOUNT_MUL * riskAmountMul(danger) * tierMul));
    resources[key] = (resources[key] || 0) + amount;
    // 零件種類特別多：找到零件時，常常同時找到其他種類的零件
    if (cat === 'part') {
      const extra = (rnd() < PART_EXTRA_KINDS[0] ? 1 : 0) + (rnd() < PART_EXTRA_KINDS[1] ? 1 : 0);
      for (let j = 0; j < extra; j += 1) {
        const k2 = pickSupply('part', rnd, danger, poi.type);
        const a2 = Math.max(1, Math.round(amount * (0.4 + rnd() * 0.5) * (TIER_AMOUNT[SUPPLIES[k2]?.tier || 1] / tierMul || 1)));
        resources[k2] = (resources[k2] || 0) + a2;
      }
    }
  }
  // 超市、住宅、學校：有機會找到少量塑膠外殼
  if (PLASTIC_SPOTS[poi.type] && rnd() < PLASTIC_SPOTS[poi.type]) {
    resources.plastic = (resources.plastic || 0) + Math.max(1, Math.round((2 + rnd() * 4) * zone.lootMul * riskAmountMul(danger)));
  }
  return {
    resources, itemMul: 0.5 + rnd(), empty: false, gear: pt.itemChance > 0, vehicle: !!pt.loot.vehicle,
  };
}
