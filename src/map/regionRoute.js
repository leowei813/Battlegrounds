/**
 * v15.3：區域路線（純函式）：在固定世界地圖上以格子找路，只走 passable(lat, lon) 為 true 的地方。
 * 用於探索隊繞過不可探索的區域（未佔領的控制點、勢力領地）。
 */
const M_PER_LAT = 111320;

/**
 * @param {{lat:number, lon:number}} from
 * @param {{lat:number, lon:number}} to
 * @param {(lat:number, lon:number) => boolean} passable
 * @param {{n:number, s:number, w:number, e:number}} bounds
 * @param {number} [cellM] 格子大小（公尺）
 * @returns {{lat:number, lon:number}[]|null} 折線（含起點與終點）；找不到路時回傳 null
 */
export function gridRoute(from, to, passable, bounds, cellM = 30) {
  const mLon = M_PER_LAT * Math.cos((((bounds.n + bounds.s) / 2) * Math.PI) / 180);
  const W = Math.ceil(((bounds.e - bounds.w) * mLon) / cellM);
  const H = Math.ceil(((bounds.n - bounds.s) * M_PER_LAT) / cellM);
  const cx = (lon) => Math.max(0, Math.min(W - 1, Math.floor(((lon - bounds.w) * mLon) / cellM)));
  const cy = (lat) => Math.max(0, Math.min(H - 1, Math.floor(((bounds.n - lat) * M_PER_LAT) / cellM)));
  const lonOf = (x) => bounds.w + ((x + 0.5) * cellM) / mLon;
  const latOf = (y) => bounds.n - ((y + 0.5) * cellM) / M_PER_LAT;
  const ok = new Uint8Array(W * H);
  for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) ok[y * W + x] = passable(latOf(y), lonOf(x)) ? 1 : 0;
  const s = cy(from.lat) * W + cx(from.lon);
  const t = cy(to.lat) * W + cx(to.lon);
  ok[s] = 1;
  ok[t] = 1;
  // A*（8 方向）
  const g = new Float64Array(W * H).fill(Infinity);
  const prev = new Int32Array(W * H).fill(-1);
  const closed = new Uint8Array(W * H);
  const tx = t % W;
  const ty = Math.floor(t / W);
  const h = (i) => Math.hypot((i % W) - tx, Math.floor(i / W) - ty);
  const open = [s];
  g[s] = 0;
  const f = new Float64Array(W * H).fill(Infinity);
  f[s] = h(s);
  const DIRS = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]];
  while (open.length) {
    let bi = 0;
    for (let i = 1; i < open.length; i += 1) if (f[open[i]] < f[open[bi]]) bi = i;
    const u = open[bi];
    open[bi] = open[open.length - 1];
    open.pop();
    if (u === t) break;
    if (closed[u]) continue;
    closed[u] = 1;
    const ux = u % W;
    const uy = Math.floor(u / W);
    for (const [dx, dy, c] of DIRS) {
      const x = ux + dx;
      const y = uy + dy;
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const v = y * W + x;
      if (!ok[v] || closed[v]) continue;
      // 斜走不能切過不可通行的角落
      if (dx && dy && (!ok[uy * W + x] || !ok[y * W + ux])) continue;
      const nd = g[u] + c;
      if (nd < g[v]) {
        g[v] = nd;
        prev[v] = u;
        f[v] = nd + h(v);
        open.push(v);
      }
    }
  }
  if (prev[t] < 0 && s !== t) return null;
  const cells = [];
  for (let v = t; v >= 0; v = v === s ? -1 : prev[v]) cells.unshift(v);
  // 拉直：從目前的點直接連到最遠、中間都可以通行的點
  const clear = (a, b) => {
    const ax = a % W; const ay = Math.floor(a / W); const bx = b % W; const by = Math.floor(b / W);
    const n = Math.max(Math.abs(bx - ax), Math.abs(by - ay)) * 2;
    for (let i = 1; i < n; i += 1) {
      const x = Math.round(ax + ((bx - ax) * i) / n);
      const y = Math.round(ay + ((by - ay) * i) / n);
      if (!ok[y * W + x]) return false;
    }
    return true;
  };
  const keep = [cells[0]];
  let i = 0;
  while (i < cells.length - 1) {
    let j = cells.length - 1;
    while (j > i + 1 && !clear(cells[i], cells[j])) j -= 1;
    keep.push(cells[j]);
    i = j;
  }
  const pts = keep.slice(1, -1).map((v) => ({ lat: +latOf(Math.floor(v / W)).toFixed(6), lon: +lonOf(v % W).toFixed(6) }));
  return [{ lat: from.lat, lon: from.lon }, ...pts, { lat: to.lat, lon: to.lon }];
}
