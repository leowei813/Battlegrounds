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
  const circles = avoid.map((c) => ({ ...toXY(c, o), r: c.r }))
    .filter((c) => dist(c, toXY(from, o)) > c.r && dist(c, toXY(to, o)) > c.r);
  const route = (a, b, depth) => {
    if (depth > 8) return [b];
    let hit = null;
    circles.forEach((c) => {
      const p = closest(a, b, c);
      if (dist(p, c) < c.r && (!hit || p.t < hit.p.t)) hit = { c, p };
    });
    if (!hit) return [b];
    const { c, p } = hit;
    let nx = p.x - c.x;
    let ny = p.y - c.y;
    let n = Math.hypot(nx, ny);
    if (n < 1e-6) {
      // 正好穿過圓心：往路線的垂直方向繞
      nx = -(b.y - a.y);
      ny = b.x - a.x;
      n = Math.hypot(nx, ny) || 1;
    }
    const w = { x: c.x + (nx / n) * c.r * 1.3, y: c.y + (ny / n) * c.r * 1.3 };
    return [...route(a, w, depth + 1), ...route(w, b, depth + 1)];
  };
  const a = toXY(from, o);
  return [{ lat: from.lat, lon: from.lon }, ...route(a, toXY(to, o), 0).map((q) => toLatLon(q, o))];
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
