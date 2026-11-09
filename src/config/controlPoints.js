import { WORLD_BOUNDS } from './world.js';
import { zoneIndexAt, zoneSide } from './zones.js';

/**
 * v14 控制點：分布在警戒區～深淵區（跨到一般區的部分保留），共 21 個，範圍不規則（所有玩家相同）。
 * 規則見 docs/v14-plan.md。
 */

/** 控制點中心（地圖上的相對位置：x 0＝最西、1＝最東；y 0＝最北、1＝最南） */
const COLS = [0.27, 0.36, 0.45, 0.55, 0.64, 0.73];
function seedsOf() {
  let s = 7;
  const r = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const out = [];
  COLS.forEach((cx, ci) => {
    const n = ci % 2 ? 3 : 4;
    for (let i = 0; i < n; i += 1) out.push([cx + (r() - 0.5) * 0.05, (i + 0.5) / n + (r() - 0.5) * 0.08]);
  });
  return out;
}
const SEEDS = seedsOf();

const B = WORLD_BOUNDS;
const toLatLon = (x, y) => ({ lat: B.n - y * (B.n - B.s), lon: B.w + x * (B.e - B.w) });
const toXY = (lat, lon) => ({ x: (lon - B.w) / (B.e - B.w), y: (B.n - lat) / (B.n - B.s) });

/** 控制點範圍的東西邊界（不規則） */
const edge = (y) => Math.sin(y * 23) * 0.012 + Math.sin(y * 9 + 1) * 0.01;

/** 座標所在的控制點索引（不在任何控制點範圍內回傳 -1） */
export function cpIndexAt(lat, lon) {
  const { x, y } = toXY(lat, lon);
  if (x < 0.205 + edge(y) || x > 0.795 - edge(y) || y < 0 || y > 1) return -1;
  let best = -1;
  let bd = Infinity;
  SEEDS.forEach(([sx, sy], i) => {
    const d = Math.hypot((x - sx) * 1.16, y - sy) + Math.sin((x + y) * 40 + i) * 0.012;
    if (d < bd) { bd = d; best = i; }
  });
  return best;
}

/** 控制點守軍（乙方案：一般守軍強度 ×3）：依區域與在哪一側 */
const GARRISON = {
  player: { 2: { level: 25, count: 8 }, 3: { level: 32, count: 10 }, 4: { level: 38, count: 12 }, 5: { level: 50, count: 16 } },
  npc: { 2: { level: 32, count: 10 }, 3: { level: 38, count: 12 }, 4: { level: 45, count: 14 }, 5: { level: 50, count: 16 } },
};
/** 守軍強度倍率（生命、攻擊） */
export const CP_GARRISON_MUL = 3;
/** 玩家側（西側警戒～致死區）的控制點守軍再減弱一半 */
export const CP_PLAYER_SIDE_MUL = 0.5;
/** 被打下後每小時（現實時間）補回的守軍人數 */
export const CP_REFILL_PER_HOUR = 6; // 現實每 10 分鐘補回 1 人
/** 每名玩家每個控制點最多駐防人數 */
export const CP_GUARD_MAX = 2;

/**
 * 每天 06:00 收益（v14：食物、木材、燃料為原規劃的 1/3；零件不變）。
 * parts：零件種類數範圍；tiers：1～5 階的機率（%）。
 */
export const CP_INCOME = {
  2: { food: 10, wood: 10, fuel: 3, parts: [2, 3], tiers: [70, 25, 5, 0, 0] },
  3: { food: 13, wood: 13, fuel: 5, parts: [3, 4], tiers: [55, 30, 12, 3, 0] },
  4: { food: 17, wood: 17, fuel: 7, parts: [4, 5], tiers: [45, 30, 17, 6, 2] },
  5: { food: 20, wood: 20, fuel: 8, parts: [5, 6], tiers: [35, 30, 20, 10, 5] },
};
/** 每種零件的數量：1 階 2～3、2 階 1～2、3 階以上 1 */
export const CP_PART_QTY = [[0, 0], [2, 3], [1, 2], [1, 1], [1, 1], [1, 1]];
/** 收益發放的遊戲時間（每天） */
export const CP_INCOME_HOUR = 6;

/** 全部控制點（固定） */
export const CONTROL_POINTS = SEEDS.map(([x, y], i) => {
  const { lat, lon } = toLatLon(x, y);
  const zone = Math.max(2, Math.min(5, zoneIndexAt(lat, lon)));
  const side = zone === 5 ? 'mid' : zoneSide(lat, lon);
  const g = GARRISON[side === 'npc' ? 'npc' : 'player'][zone];
  return {
    id: `cp${i + 1}`, no: i + 1, lat, lon, zone, side, garrison: g,
  };
});

/** 最西側一排（緊鄰玩家一般區）：沒有任何控制點時也可以攻打 */
export const CP_START = CONTROL_POINTS.filter((c) => toXY(c.lat, c.lon).x < (COLS[0] + COLS[1]) / 2).map((c) => c.id);

export const cpById = (id) => CONTROL_POINTS.find((c) => c.id === id) || null;

/** 座標所在的控制點（沒有回傳 null） */
export function cpAt(lat, lon) {
  const i = cpIndexAt(lat, lon);
  return i >= 0 ? CONTROL_POINTS[i] : null;
}

/** 相鄰的控制點（用地圖上的取樣判斷邊界相接） */
let adjCache = null;
export function cpNeighbors(id) {
  if (!adjCache) {
    adjCache = Object.fromEntries(CONTROL_POINTS.map((c) => [c.id, new Set()]));
    const N = 120;
    let prev = null;
    for (let yi = 0; yi <= N; yi += 1) {
      const row = [];
      for (let xi = 0; xi <= N; xi += 1) {
        const { lat, lon } = toLatLon(xi / N, yi / N);
        const k = cpIndexAt(lat, lon);
        row.push(k);
        const link = (a, b) => { if (a >= 0 && b >= 0 && a !== b) { adjCache[`cp${a + 1}`].add(`cp${b + 1}`); adjCache[`cp${b + 1}`].add(`cp${a + 1}`); } };
        if (xi > 0) link(row[xi - 1], k);
        if (prev) link(prev[xi], k);
      }
      prev = row;
    }
  }
  return [...(adjCache[id] || [])];
}

/**
 * v14 三大勢力：大本營在地圖右側上、中、下（不能攻打、不出兵）。
 * hour：每天進攻的遊戲時間；hq：大本營位置（地圖相對位置）。
 */
export const FACTIONS = {
  red: { name: '赤月', color: '#ef5350', hour: 8, hq: [0.93, 0.17] },
  black: { name: '黑曜', color: '#ffb300', hour: 12, hq: [0.93, 0.5] },
  blue: { name: '冥府', color: '#7e57c2', hour: 16, hq: [0.93, 0.83] },
};
export const FACTION_KEYS = Object.keys(FACTIONS);
/** 大本營位置（經緯度） */
export const factionHq = (f) => toLatLon(...FACTIONS[f].hq);
/** NPC 據點：每擁有 3 個控制點建 1 座，最多 4 座，起始 Lv35 */
export const FACTION_BASE = { perCps: 3, max: 4, level: 35 };
/** 控制點越多進攻頻率越低：擁有這麼多以上時隔天才進攻一次 */
export const FACTION_SLOW_AT = 8;

/** 一開始（沒有共用資料時）各勢力擁有的控制點：東側（勢力側）依南北位置分給最近的大本營 */
export function defaultFaction(cp) {
  if (!cp || cp.side !== 'npc') return null;
  const { y } = toXY(cp.lat, cp.lon);
  return y < 1 / 3 ? 'red' : y < 2 / 3 ? 'black' : 'blue';
}

/** 和大本營相鄰的控制點（最東側那一排）：勢力沒有控制點時可以從這裡開始進攻 */
export function hqNeighbors(f) {
  const east = CONTROL_POINTS.filter((c) => toXY(c.lat, c.lon).x > 0.7);
  const hy = FACTIONS[f].hq[1];
  return east.filter((c) => Math.abs(toXY(c.lat, c.lon).y - hy) < 0.34).map((c) => c.id);
}
