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

/**
 * 待在避難所的倖存者背包：待命中（沒有外出探索）、且不是駐守在前哨站的人。
 * 建造、升級、研究等支出也可以使用他們身上的物資。
 */
export function homeBags(state) {
  const away = new Set();
  (state.bases || []).forEach((b) => {
    if (b.id === state.primaryBaseId) return;
    (b.defenses || []).forEach((d) => { if (d.garrisonId) away.add(d.garrisonId); });
  });
  return (state.survivors || []).filter((s) => s.status === 'idle' && !away.has(s.id) && s.bag).map((s) => s.bag);
}

/** 倉庫裡的數量（不含倖存者背包） */
export function storedOf(state, key) {
  return pool(state, key)?.[key] ?? 0;
}

/** 目前可用的數量：倉庫（資源、貨幣、材料物品）＋待在避難所的倖存者背包 */
export function amountOf(state, key) {
  const base = storedOf(state, key);
  if (CURRENCY_KEYS.includes(key)) return base;
  return base + homeBags(state).reduce((s, bag) => s + Math.max(0, Math.floor(bag[key] || 0)), 0);
}

export function canAfford(state, cost = {}) {
  return Object.entries(cost).every(([k, v]) => amountOf(state, k) >= v);
}

/** 缺少的項目 { key: 缺少數量 } */
export function missing(state, cost = {}) {
  const out = {};
  Object.entries(cost).forEach(([k, v]) => {
    const have = amountOf(state, k);
    if (have < v) out[k] = v - have;
  });
  return out;
}

/** 支付：先扣倉庫，不夠的部分再從待在避難所的倖存者背包扣 */
export function payCost(state, cost = {}) {
  if (!canAfford(state, cost)) return false;
  Object.entries(cost).forEach(([k, v]) => {
    const p = pool(state, k);
    const fromStore = Math.min(v, Math.max(0, p[k] || 0));
    p[k] = (p[k] || 0) - fromStore;
    let left = v - fromStore;
    if (left > 0 && !CURRENCY_KEYS.includes(k)) {
      homeBags(state).forEach((bag) => {
        if (left <= 0) return;
        const n = Math.min(left, Math.floor(bag[k] || 0));
        if (!n) return;
        bag[k] -= n;
        if (bag[k] <= 0) delete bag[k];
        left -= n;
      });
    }
    if (left > 0) p[k] -= left; // 理論上不會發生（canAfford 已檢查）
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
