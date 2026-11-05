import { POI_TYPES } from '../config/poiTypes.js';
import { zoneIndexAt } from '../config/zones.js';

/**
 * v10 隨機地圖：地點不再來自真實地圖的建築，而是由「固定格子」決定。
 * 世界切成約 48 公尺的格子，每一格有沒有地點、是什麼建築、在格子內的位置，都只由格子座標決定，
 * 因此所有玩家在同一個位置看到的地點完全相同（不需要網路，也不需要另外存檔）。
 *
 * 比例（整體平均）：食物 24%、木材 18%、燃料 9%、零件布料 18%、藥品 13%、裝備彈藥 18%。
 * 區域限定：藥局只在警戒區以下、醫院只在警戒區以上、軍事基地只在深淵區（約佔深淵區 15%）。
 */
export const WORLD_GEN = {
  cellM: 48,
  /** 有地點的格子比例：避難所周圍（1.2 公里）約 1,400 個地點 */
  fill: 0.73,
  /** 軍事基地在深淵區內的比例 */
  militaryInAbyss: 0.15,
};

/**
 * 各建築的權重：已依各區域的面積校正，扣掉區域限定後整體平均符合目標比例
 * （住宅 14、商店 6、超市 4、樹林 18、加油站 9、工廠 7、修車廠 5、回收站 6、藥局 10、醫院 3、倉庫 6.5、學校 6.5、警察局 4.4）。
 */
const WEIGHTS = {
  residential: 13.1, shop: 5.61, supermarket: 3.74, forest: 16.84, gasStation: 8.42, factory: 6.55, garage: 4.68,
  recycling: 5.61, pharmacy: 14.16, hospital: 5.01, warehouse: 6.08, school: 6.08, police: 4.12,
};
/** 可出現的區域（0 安全、1 一般、2 警戒、3 危險、4 致死、5 深淵） */
const ALLOW = { pharmacy: [0, 1, 2], hospital: [2, 3, 4, 5] };
const ABYSS = 5;

const RUIN_PREFIX = ['廢棄的', '燒毀的', '荒廢的', '被封鎖的', '倒塌的'];

function hash(x, y, s) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(s, 0x27d4eb2d);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const M_PER_DEG = 111320;
const LAT_STEP = WORLD_GEN.cellM / M_PER_DEG;
/** 每一列格子的經度寬度（依該列緯度，取到 0.1 度讓結果固定） */
const lonStepOf = (r) => WORLD_GEN.cellM / (M_PER_DEG * Math.cos((Math.round((r + 0.5) * LAT_STEP * 10) / 10) * Math.PI / 180));

/** 格子 (r, c) 的地點；這一格沒有地點時回傳 null */
export function poiAtCell(r, c) {
  if (hash(c, r, 1) >= WORLD_GEN.fill) return null;
  const lonStep = lonStepOf(r);
  const lat = (r + 0.1 + 0.8 * hash(c, r, 2)) * LAT_STEP;
  const lon = (c + 0.1 + 0.8 * hash(c, r, 3)) * lonStep;
  const z = zoneIndexAt(lat, lon);
  let type = null;
  if (z === ABYSS && hash(c, r, 6) < WORLD_GEN.militaryInAbyss) type = 'military';
  else {
    const w = Object.entries(WEIGHTS).filter(([k]) => !ALLOW[k] || ALLOW[k].includes(z));
    const tot = w.reduce((s, [, v]) => s + v, 0);
    let x = hash(c, r, 4) * tot;
    type = w[w.length - 1][0];
    for (const [k, v] of w) { x -= v; if (x < 0) { type = k; break; } }
  }
  const def = POI_TYPES[type];
  const no = 1 + Math.floor(hash(c, r, 5) * 899);
  const prefix = def.generated ? '' : RUIN_PREFIX[Math.floor(hash(c, r, 7) * RUIN_PREFIX.length)];
  return { id: `w_${r}_${c}`, type, name: `${prefix}${def.name} ${no}號`, lat, lon, osm: false };
}

/** 圓形範圍內的所有地點（依格子決定，所有玩家相同） */
export function generatePois(lat0, lon0, radius) {
  const out = [];
  const cos0 = Math.cos((lat0 * Math.PI) / 180);
  const r0 = Math.floor((lat0 - radius / M_PER_DEG) / LAT_STEP);
  const r1 = Math.ceil((lat0 + radius / M_PER_DEG) / LAT_STEP);
  const dLon = radius / (M_PER_DEG * cos0);
  for (let r = r0; r <= r1; r += 1) {
    const lonStep = lonStepOf(r);
    const c0 = Math.floor((lon0 - dLon) / lonStep);
    const c1 = Math.ceil((lon0 + dLon) / lonStep);
    for (let c = c0; c <= c1; c += 1) {
      const p = poiAtCell(r, c);
      if (!p) continue;
      const dy = (p.lat - lat0) * M_PER_DEG;
      const dx = (p.lon - lon0) * M_PER_DEG * cos0;
      if (dx * dx + dy * dy <= radius * radius) out.push(p);
    }
  }
  return out;
}
