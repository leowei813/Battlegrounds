import { WORLD_BOUNDS } from './world.js';
import { zoneIndexAt, zoneSide, inNpcHome } from './zones.js';

/**
 * v17 控制點：除了左側安全區與右側三大勢力領地，其餘地圖（含一般區）切成 2×2 共 4 個控制點（左上、左下、右上、右下），
 * 邊界不規則（所有玩家相同）。一開始 4 個都是中立，三大勢力從大本營出兵搶。
 */

/** 共用資料的種類（v17 控制點改成 4 個，換新的種類讓所有控制點重新開始） */
export const CP_KIND = 'cp4';
/** v15.7：駐防隊擋下勢力部隊：沒倒下的隊員獲得自己升級所需經驗的比例（倒下不扣） */
export const CP_GUARD_XP_PCT = 0.03;
export const CP_TURN_KIND = 'cp4turn';

/** 控制點中心（地圖上的相對位置：x 0＝最西、1＝最東；y 0＝最北、1＝最南） */
const SEEDS = [[0.31, 0.27], [0.31, 0.73], [0.7, 0.27], [0.7, 0.73]];
const NAMES = ['左上區', '左下區', '右上區', '右下區'];

const B = WORLD_BOUNDS;
const toLatLon = (x, y) => ({ lat: B.n - y * (B.n - B.s), lon: B.w + x * (B.e - B.w) });
const toXY = (lat, lon) => ({ x: (lon - B.w) / (B.e - B.w), y: (B.n - lat) / (B.n - B.s) });

/** 左右分界（不規則） */
const edge = (y) => Math.sin(y * 23) * 0.012 + Math.sin(y * 9 + 1) * 0.01;
/** 上下分界（不規則） */
const mid = (x) => Math.sin(x * 21) * 0.015 + Math.sin(x * 7 + 2) * 0.01;

/** 座標所在的控制點索引（安全區、勢力領地、地圖外回傳 -1） */
export function cpIndexAt(lat, lon) {
  const { x, y } = toXY(lat, lon);
  if (x < 0 || x > 1 || y < 0 || y > 1 || inNpcHome(lat, lon) || zoneIndexAt(lat, lon) === 0) return -1;
  return (x > 0.51 + edge(y) ? 2 : 0) + (y > 0.5 + mid(x) ? 1 : 0);
}

/**
 * v17 守軍與進攻部隊的總戰力（unitPower 合計）。
 * neutral：中立控制點的感染者守軍；npc：勢力佔領後的留守（打下時 start，每 10 分鐘補 1 人到 full）；
 * attack：勢力進攻部隊（再乘上勢力的控制點數加成，最多 ×1.4）。
 */
export const CP_POWER = {
  neutral: { left: 150000, right: 400000 },
  npc: { start: 700000, full: 900000 },
  attack: { left: 300000, right: 500000 },
};
/** 守軍人數：中立左側 10、右側 12；勢力留守滿編 18（打下時 14 人＝70 萬） */
export const CP_GARRISON = { neutral: { left: 10, right: 12 }, npc: 18, attackN: 12 };
/** 守軍等級（顯示用、戰鬥公式用） */
export const CP_LEVEL = { left: 30, right: 45, npc: 50 };
/** 被打下後每小時（現實時間）補回的守軍人數 */
export const CP_REFILL_PER_HOUR = 6; // 現實每 10 分鐘補回 1 人
/** v16.1：控制點被打下（玩家或勢力佔領）後的保護期：這段時間內任何人（玩家、集結、勢力）都不能攻打 */
export const CP_SHIELD = { ms: 3600000 };
/** v17：勢力進攻部隊強度跟著勢力的控制點數：每擁有 1 個 +step，範圍 min～max（4 個時 ×1.4） */
export const FACTION_FORCE_SCALE = { base: 0, step: 0.1, min: 1, max: 1.4 };
/** v17：戰損保留：駐防隊員的生命與路障耐久在交戰後保留，約現實 2 小時回滿 */
export const CP_RECOVER_MS = 2 * 3600000;
/** v17：勢力進攻被擊退後，約 30 分鐘後追加一波（每次被擊退最多追加 1 波） */
export const CP_FOLLOW_MS = 30 * 60000;
/** 每名玩家每個控制點最多駐防人數 */
export const CP_GUARD_MAX = 3;
/** v17：每個控制點最多幾位玩家駐防或蓋防禦建築 */
export const CP_MAX_PLAYERS = 8;
/** v17：控制點防禦建築（每位玩家各 1 座）：效果為避難所同等級的 3 倍，費用為一半 */
export const CP_BUILDINGS = ['barricade', 'machineGun', 'watchPost'];
export const CP_BUILD = { effectMul: 3, costMul: 0.5 };

/**
 * 每天 06:00 收益（v17：右側以深淵區、左側以致死區為基準 ×6，並加入布料）。
 * parts：零件種類數範圍；tiers：1～5 階的機率（%）。
 */
export const CP_INCOME = {
  4: { food: 17, wood: 17, fuel: 7, parts: [4, 5], tiers: [45, 30, 17, 6, 2] },
  5: { food: 20, wood: 20, fuel: 8, parts: [5, 6], tiers: [35, 30, 20, 10, 5] },
};
/** v17：收益倍率 */
export const CP_INCOME_MUL = 6;
/** 每種零件的數量：1 階 2～3、2 階 1～2、3 階以上 1 */
export const CP_PART_QTY = [[0, 0], [2, 3], [1, 2], [1, 1], [1, 1], [1, 1]];
/** 收益發放的遊戲時間（每天） */
export const CP_INCOME_HOUR = 6;

/** 全部控制點（固定）：zone 是收益基準（左側 4＝致死、右側 5＝深淵） */
export const CONTROL_POINTS = SEEDS.map(([x, y], i) => {
  const { lat, lon } = toLatLon(x, y);
  const side = x < 0.5 ? 'left' : 'right';
  return {
    id: `cp${i + 1}`, no: i + 1, name: NAMES[i], lat, lon, side, zone: side === 'left' ? 4 : 5,
    garrison: { level: CP_LEVEL[side], count: CP_GARRISON.neutral[side] },
  };
});

/** 左側兩個（緊鄰玩家一般區）：沒有任何控制點時也可以攻打 */
export const CP_START = CONTROL_POINTS.filter((c) => c.side === 'left').map((c) => c.id);

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
  red: { name: '赤月', color: '#ef5350', hour: 8, hq: [0.95, 0.17] },
  black: { name: '黑曜', color: '#ffb300', hour: 12, hq: [0.95, 0.5] },
  blue: { name: '冥府', color: '#7e57c2', hour: 16, hq: [0.95, 0.83] },
};
export const FACTION_KEYS = Object.keys(FACTIONS);
/** 大本營位置（經緯度） */
export const factionHq = (f) => toLatLon(...FACTIONS[f].hq);
/** NPC 據點：v17 每擁有 1 個控制點建 1 座，最多 4 座，起始 Lv35；沒有據點時由大本營出兵（Lv40） */
export const FACTION_BASE = { perCps: 1, max: 4, level: 35, hqLevel: 40 };
/** 控制點越多進攻頻率越低：擁有這麼多以上時隔天才進攻一次 */
export const FACTION_SLOW_AT = 3;

/** 一開始（沒有共用資料時）各勢力擁有的控制點：v17 一開始 4 個都是中立 */
export function defaultFaction(cp) {
  void cp;
  return null;
}

/** 和大本營相鄰的控制點（右側）：勢力沒有控制點時從這裡開始進攻（赤月在北、冥府在南、黑曜在中間兩個都可以） */
export function hqNeighbors(f) {
  const hy = FACTIONS[f].hq[1];
  return CONTROL_POINTS.filter((c) => c.side === 'right' && Math.abs(toXY(c.lat, c.lon).y - hy) < 0.4).map((c) => c.id);
}
