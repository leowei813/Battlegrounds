import { RESOURCE_KEYS } from '../config/constants.js';
import { isSupply } from '../config/supplies.js';

/**
 * 成本/獎勵工具。成本物件可同時包含資源 (food…)、貨幣 (coins, parts) 與材料物品（零件、布料、藥品、彈藥）。
 * 材料物品存放在物品倉庫 state.supplies。
 */
const CURRENCY_KEYS = ['coins', 'parts'];

function pool(state, key) {
  if (CURRENCY_KEYS.includes(key)) return state.player;
  if (RESOURCE_KEYS.includes(key)) return state.resources;
  if (isSupply(key)) {
    if (!state.supplies) state.supplies = {};
    return state.supplies;
  }
  return null;
}

/** 目前擁有的數量（資源、貨幣或倉庫裡的材料物品） */
export function amountOf(state, key) {
  return pool(state, key)?.[key] ?? 0;
}

export function canAfford(state, cost = {}) {
  return Object.entries(cost).every(([k, v]) => (pool(state, k)?.[k] ?? 0) >= v);
}

/** 缺少的項目 { key: 缺少數量 } */
export function missing(state, cost = {}) {
  const out = {};
  Object.entries(cost).forEach(([k, v]) => {
    const have = pool(state, k)?.[k] ?? 0;
    if (have < v) out[k] = v - have;
  });
  return out;
}

export function payCost(state, cost = {}) {
  if (!canAfford(state, cost)) return false;
  Object.entries(cost).forEach(([k, v]) => {
    const p = pool(state, k);
    p[k] -= v;
    if (isSupply(k) && p[k] <= 0) delete p[k];
  });
  return true;
}

/** 給予資源（資源受倉庫上限限制，貨幣不受限；材料物品的格子限制由 Game.grant 處理）。回傳實際入帳量 */
export function grant(state, gains = {}, cap = Infinity) {
  const actual = {};
  Object.entries(gains).forEach(([k, v]) => {
    const p = pool(state, k);
    if (!p || !v) return;
    const before = p[k] || 0;
    const limit = RESOURCE_KEYS.includes(k) ? Math.max(cap, before) : Infinity;
    p[k] = Math.min(limit, before + v);
    actual[k] = p[k] - before;
  });
  return actual;
}

export function scaleCost(cost, mul) {
  return Object.fromEntries(Object.entries(cost).map(([k, v]) => [k, Math.max(1, Math.round(v * mul))]));
}
