/**
 * 路線規劃（純函式）：以直線前進，遇到需要避開的圓形警戒範圍時加入繞行點。
 * 座標在小範圍內以平面近似（公尺）。
 */
const M_PER_LAT = 111320;

const mPerLon = (lat) => M_PER_LAT * Math.cos((lat * Math.PI) / 180);

function toXY(p, o) {
  return { x: (p.lon - o.lon) * mPerLon(o.lat), y: (p.lat - o.lat) * M_PER_LAT };
}

function toLatLon(q, o) {
  return { lat: +(o.lat + q.y / M_PER_LAT).toFixed(6), lon: +(o.lon + q.x / mPerLon(o.lat)).toFixed(6) };
}

/** 線段 ab 上離點 c 最近的位置（t 為 0～1 的比例） */
function closest(a, b, c) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((c.x - a.x) * dx + (c.y - a.y) * dy) / len2));
  return { t, x: a.x + dx * t, y: a.y + dy * t };
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** 兩點距離（公尺） */
export function distanceM(a, b) {
  return dist(toXY(a, a), toXY(b, a));
}

/** 折線總長（公尺） */
export function pathLength(path) {
  let s = 0;
  for (let i = 1; i < path.length; i += 1) s += distanceM(path[i - 1], path[i]);
  return s;
}

/** 沿折線前進 d 公尺的位置 */
export function pointAlong(path, d) {
  if (path.length < 2 || d <= 0) return { lat: path[0].lat, lon: path[0].lon };
  let left = d;
  for (let i = 1; i < path.length; i += 1) {
    const seg = distanceM(path[i - 1], path[i]);
    if (left <= seg) {
      const r = seg ? left / seg : 0;
      return { lat: path[i - 1].lat + (path[i].lat - path[i - 1].lat) * r, lon: path[i - 1].lon + (path[i].lon - path[i - 1].lon) * r };
    }
    left -= seg;
  }
  const last = path[path.length - 1];
  return { lat: last.lat, lon: last.lon };
}

/**
 * 規劃從 from 到 to 的路線，繞開 avoid 中的圓形範圍（起點或終點在範圍內的不繞）。
 * @param {{lat:number, lon:number}} from
 * @param {{lat:number, lon:number}} to
 * @param {{lat:number, lon:number, r:number}[]} avoid
 * @returns {{lat:number, lon:number}[]} 折線（含起點與終點）
 */
export function planRoute(from, to, avoid = []) {
  const o = from;
  const A = toXY(from, o);
  const B = toXY(to, o);
  const circles = avoid.map((c) => ({ ...toXY(c, o), r: c.r }))
    .filter((c) => c.r > 0 && dist(c, A) > c.r && dist(c, B) > c.r);
  const blocked = (p, q) => circles.some((c) => dist(closest(p, q, c), c) < c.r * 0.999);
  if (!blocked(A, B)) return [{ lat: from.lat, lon: from.lon }, { lat: to.lat, lon: to.lon }];
  // 最短繞行：每個範圍外擴成八邊形，在起點、終點與所有頂點之間找不穿過任何範圍的最短路線
  const SIDES = 8;
  const R = 1.0 / Math.cos(Math.PI / SIDES) + 0.08;
  const nodes = [A, B];
  circles.forEach((c) => {
    for (let k = 0; k < SIDES; k += 1) {
      const ang = (2 * Math.PI * k) / SIDES + Math.PI / SIDES;
      const v = { x: c.x + Math.cos(ang) * c.r * R, y: c.y + Math.sin(ang) * c.r * R };
      if (!circles.some((c2) => dist(v, c2) < c2.r)) nodes.push(v);
    }
  });
  const n = nodes.length;
  const best = new Array(n).fill(Infinity);
  const prev = new Array(n).fill(-1);
  const done = new Array(n).fill(false);
  best[0] = 0;
  for (let it = 0; it < n; it += 1) {
    let u = -1;
    for (let i = 0; i < n; i += 1) if (!done[i] && (u < 0 || best[i] < best[u])) u = i;
    if (u < 0 || best[u] === Infinity) break;
    if (u === 1) break;
    done[u] = true;
    for (let v = 0; v < n; v += 1) {
      if (done[v] || v === u) continue;
      const d = best[u] + dist(nodes[u], nodes[v]);
      if (d < best[v] && !blocked(nodes[u], nodes[v])) { best[v] = d; prev[v] = u; }
    }
  }
  // 完全被包圍（找不到路線）：維持直線
  if (prev[1] < 0) return [{ lat: from.lat, lon: from.lon }, { lat: to.lat, lon: to.lon }];
  const path = [];
  for (let v = 1; v >= 0; v = prev[v]) path.unshift(nodes[v]);
  return [{ lat: from.lat, lon: from.lon }, ...path.slice(1).map((q) => toLatLon(q, o))];
}

/**
 * 折線進入各圓形範圍的位置（沿路線的距離），起點已在範圍內的不算。
 * @returns {{index:number, at:number}[]} index 為 circles 的索引，at 為進入時已走的公尺數
 */
export function crossings(path, circles) {
  if (path.length < 2) return [];
  const o = path[0];
  const pts = path.map((p) => toXY(p, o));
  const out = [];
  circles.forEach((c0, index) => {
    const c = { ...toXY(c0, o), r: c0.r };
    if (dist(pts[0], c) <= c.r) return;
    let walked = 0;
    for (let i = 1; i < pts.length; i += 1) {
      const a = pts[i - 1];
      const b = pts[i];
      const seg = dist(a, b);
      const p = closest(a, b, c);
      const d = dist(p, c);
      if (d < c.r) {
        // 進入點：從最近點往回退半弦長
        const back = Math.sqrt(c.r * c.r - d * d);
        out.push({ index, at: Math.max(0, walked + p.t * seg - back) });
        return;
      }
      walked += seg;
    }
  });
  return out.sort((x, y) => x.at - y.at);
}
