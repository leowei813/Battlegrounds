import { RESOURCE_KEYS } from '../config/constants.js';

/**
 * 成本/獎勵工具。成本物件可同時包含資源 (food…) 與貨幣 (coins, parts)。
 */
const CURRENCY_KEYS = ['coins', 'parts'];

function pool(state, key) {
  if (CURRENCY_KEYS.includes(key)) return state.player;
  if (RESOURCE_KEYS.includes(key)) return state.resources;
  return null;
}

export function canAfford(state, cost = {}) {
  return Object.entries(cost).every(([k, v]) => (pool(state, k)?.[k] ?? 0) >= v);
}

export function payCost(state, cost = {}) {
  if (!canAfford(state, cost)) return false;
  Object.entries(cost).forEach(([k, v]) => {
    pool(state, k)[k] -= v;
  });
  return true;
}

/** 給予資源（資源受倉庫上限限制，貨幣不受限）。回傳實際入帳量 */
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
