import { SUPPLIES, SUPPLY_KEYS, AMMO_RECIPES, MED_RECIPES } from '../config/supplies.js';
import { FACILITIES, FACILITY_MAX_LEVEL, REPAIR } from '../config/facilities.js';
import { DEFENSES, DEFENSE_MAX_LEVEL } from '../config/defenses.js';
import { RESEARCH, MAX_RESEARCH_LEVEL, researchCost } from '../config/research.js';
import { ITEM_MODELS } from '../config/equipment.js';
import { craftRecipe } from './EquipmentSystem.js';

/**
 * v13.3：材料需求與掉落配比（同類別、同階互比）。
 *
 * 需求：所有設施、防禦建築、研究（每一級）與裝備製作（每種型號一次）需要的零件與布料總和。
 * 掉落：探索時同類別、同階的材料依「佔需求的比例 ÷ 佔掉落的比例」調整出現機率，
 * 調整幅度限制在 ×MIN～×MAX，並保持該階的總掉落量不變。
 * 子彈、藥品製作與圍牆修繕會反覆用到的材料（消耗品材料）不會被降低（倍率至少 ×1）。
 *
 * 由目前的設定即時計算：之後新增或修改研究、建築、裝備的成本，掉落配比會自動跟著調整。
 * 報表：`npm run balance`（scripts/material-balance.js），說明見 docs/material-balance.md。
 */
export const BALANCE = { min: 0.6, max: 2 };

/** 參與配比的材料：零件（彈殼除外）與布料 */
const balanced = (k) => (SUPPLIES[k].cat === 'part' && SUPPLIES[k].tag !== 'ammo') || SUPPLIES[k].cat === 'fabric';

/** 消耗品材料：子彈、藥品製作與圍牆修繕會反覆用到（由目前的配方自動取得） */
export function consumableMaterials() {
  const keys = new Set();
  [...Object.values(AMMO_RECIPES), ...Object.values(MED_RECIPES)].forEach((r) => Object.keys(r.cost || {}).forEach((k) => keys.add(k)));
  Object.keys(REPAIR.cost || {}).forEach((k) => keys.add(k));
  return [...keys].filter((k) => SUPPLIES[k] && balanced(k));
}

/** 各材料的需求總量與來源 */
export function materialDemand() {
  const total = {};
  const bySrc = {};
  const add = (cost, src) => Object.entries(cost || {}).forEach(([k, v]) => {
    if (!SUPPLIES[k] || !balanced(k) || !(v > 0)) return;
    total[k] = (total[k] || 0) + v;
    (bySrc[k] = bySrc[k] || {})[src] = (bySrc[k][src] || 0) + v;
  });
  Object.values(FACILITIES).forEach((f) => { for (let lv = 1; lv <= FACILITY_MAX_LEVEL; lv += 1) add(f.cost?.(lv), '設施'); });
  Object.values(DEFENSES).forEach((d) => { for (let lv = 1; lv <= DEFENSE_MAX_LEVEL; lv += 1) add(d.cost?.(lv), '防禦'); });
  Object.keys(RESEARCH).forEach((id) => { for (let lv = 1; lv <= MAX_RESEARCH_LEVEL; lv += 1) add(researchCost(id, lv), '研究'); });
  Object.values(ITEM_MODELS).forEach((md) => { try { add(craftRecipe(md), '製作'); } catch { /* 不能製作的型號 */ } });
  return { total, bySrc };
}

let cache = null;

/**
 * 每種材料的掉落倍率（同類別、同階內）。
 * @param {(k:string)=>number} baseWeight 未調整前的掉落權重（同一階內比較，與危險度無關的部分）
 */
export function balanceMultipliers(baseWeight) {
  if (cache) return cache;
  const { total } = materialDemand();
  const keep = new Set(consumableMaterials());
  const out = {};
  const groups = {};
  SUPPLY_KEYS.filter(balanced).forEach((k) => { (groups[`${SUPPLIES[k].cat}:${SUPPLIES[k].tier}`] = groups[`${SUPPLIES[k].cat}:${SUPPLIES[k].tier}`] || []).push(k); });
  Object.values(groups).forEach((keys) => {
    const D = keys.reduce((a, k) => a + (total[k] || 0), 0);
    const W = keys.reduce((a, k) => a + baseWeight(k), 0);
    if (!D || !W || keys.length < 2) { keys.forEach((k) => { out[k] = 1; }); return; }
    const raw = Object.fromEntries(keys.map((k) => {
      const ratio = ((total[k] || 0) / D) / (baseWeight(k) / W);
      return [k, Math.min(BALANCE.max, Math.max(keep.has(k) ? 1 : BALANCE.min, ratio))];
    }));
    // 保持該階總掉落量不變：只縮放非消耗品材料（消耗品材料維持至少 ×1）
    const Wk = keys.filter((k) => keep.has(k) && raw[k] <= 1).reduce((a, k) => a + baseWeight(k) * raw[k], 0);
    const Wn = keys.filter((k) => !(keep.has(k) && raw[k] <= 1)).reduce((a, k) => a + baseWeight(k) * raw[k], 0);
    const f = Wn > 0 && W > Wk ? (W - Wk) / Wn : 1;
    keys.forEach((k) => { out[k] = keep.has(k) && raw[k] <= 1 ? raw[k] : Math.min(BALANCE.max, Math.max(BALANCE.min, raw[k] * f)); });
  });
  cache = out;
  return out;
}

let scarcityCache = null;

/**
 * 稀缺度：同類別、同階內「佔需求的比例 ÷ 調整後佔掉落的比例」（1 = 剛好；越大越缺）。
 * 黑市交換價值、黑市售價與回收價、黑市上架的材料都參考這個數值。
 */
export function scarcity(baseWeight) {
  if (scarcityCache) return scarcityCache;
  const { total } = materialDemand();
  const mul = balanceMultipliers(baseWeight);
  const out = {};
  const groups = {};
  SUPPLY_KEYS.filter(balanced).forEach((k) => { (groups[`${SUPPLIES[k].cat}:${SUPPLIES[k].tier}`] = groups[`${SUPPLIES[k].cat}:${SUPPLIES[k].tier}`] || []).push(k); });
  Object.values(groups).forEach((keys) => {
    const D = keys.reduce((a, k) => a + (total[k] || 0), 0);
    const W = keys.reduce((a, k) => a + baseWeight(k) * (mul[k] ?? 1), 0);
    keys.forEach((k) => {
      out[k] = D && W && keys.length > 1 ? ((total[k] || 0) / D) / ((baseWeight(k) * (mul[k] ?? 1)) / W) : 1;
    });
  });
  scarcityCache = out;
  return out;
}

/** 黑市交換的價值點數：每階的基準 × 稀缺度（限制在 ×0.5～×3），取到 0.5 */
export const EXCHANGE_TIER_VALUE = [0, 1, 3, 6, 13];
export function exchangeValues(baseWeight, maxTier = 4) {
  const sc = scarcity(baseWeight);
  return Object.fromEntries(Object.keys(sc).filter((k) => SUPPLIES[k].tier <= maxTier).map((k) => {
    const v = EXCHANGE_TIER_VALUE[SUPPLIES[k].tier] * Math.min(3, Math.max(0.5, sc[k]));
    return [k, Math.max(0.5, Math.round(v * 2) / 2)];
  }));
}
