import L from 'leaflet';
import { ZONES, zoneIndexAt } from '../config/zones.js';

/** 每個取樣方塊的像素大小（低解析度取樣後放大；邊界線依同樣的方塊描繪） */
const BLOCK = 6;

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

/**
 * 危險度圖層的顯示模式：
 *  - strong（清楚）：底色較濃且依危險度遞增、區域交界畫邊界線、危險區以上加斜線紋路（底圖另外降低彩度）
 *  - light（淡）：原本的淡色底色與細邊界
 *  - off（關閉）
 */
export const ZONE_MODES = {
  strong: { name: '清楚', alpha: [0.12, 0.14, 0.18, 0.22, 0.28, 0.38], border: 2, hatch: true },
  light: { name: '淡', alpha: ZONES.map((z) => z.alpha), border: 1, hatch: false },
  off: { name: '關閉' },
};
export const ZONE_MODE_ORDER = ['strong', 'light', 'off'];

/** 斜線紋路：危險區以上，越危險越密（間距 px） */
const HATCH_GAP = { danger: 12, lethal: 9, abyss: 6 };

/** 斜線紋路圖樣（每個區域一張） */
const patterns = new Map();
function hatchCanvas(zone) {
  if (patterns.has(zone.id)) return patterns.get(zone.id);
  const gap = HATCH_GAP[zone.id];
  let c = null;
  if (gap) {
    c = document.createElement('canvas');
    c.width = gap;
    c.height = gap;
    const g = c.getContext('2d');
    const [r, gg, b] = rgb(zone.id === 'abyss' ? '#ffffff' : zone.color);
    g.strokeStyle = `rgba(${r},${gg},${b},${zone.id === 'abyss' ? 0.28 : 0.45})`;
    g.lineWidth = 1.5;
    g.beginPath();
    // 斜線（左下到右上），兩端補畫讓圖樣接縫連續
    g.moveTo(0, gap);
    g.lineTo(gap, 0);
    g.moveTo(-gap / 2, gap / 2);
    g.lineTo(gap / 2, -gap / 2);
    g.moveTo(gap / 2, gap * 1.5);
    g.lineTo(gap * 1.5, gap / 2);
    g.stroke();
  }
  patterns.set(zone.id, c);
  return c;
}

/**
 * 區域危險度底色：以顏色區分安全區～深淵區，並依模式加上邊界線與斜線紋路。
 * 在低解析度格子上逐方塊取樣區域，底色平滑放大；邊界與紋路依格子在全解析度繪製。
 */
export const ZoneLayer = L.Layer.extend({
  initialize(mode = 'strong') {
    this.mode = ZONE_MODES[mode] ? mode : 'strong';
  },

  setMode(mode) {
    this.mode = ZONE_MODES[mode] ? mode : 'strong';
    if (this.map) this.redraw();
  },

  onAdd(map) {
    this.map = map;
    if (!map.getPane('zonePane')) {
      const pane = map.createPane('zonePane');
      pane.style.zIndex = 250; // 底圖（200）之上、建築（440）之下
      pane.style.pointerEvents = 'none';
    }
    this.canvas = L.DomUtil.create('canvas', 'zone-canvas leaflet-zoom-hide');
    map.getPane('zonePane').appendChild(this.canvas);
    this.low = document.createElement('canvas');
    this.mask = document.createElement('canvas');
    map.on('moveend zoomend resize viewreset', this.redraw, this);
    this.redraw();
  },

  onRemove(map) {
    map.off('moveend zoomend resize viewreset', this.redraw, this);
    this.canvas.remove();
  },

  redraw() {
    const map = this.map;
    if (!map) return;
    const size = map.getSize();
    this.canvas.width = size.x;
    this.canvas.height = size.y;
    this.canvas.style.width = `${size.x}px`;
    this.canvas.style.height = `${size.y}px`;
    L.DomUtil.setPosition(this.canvas, map.containerPointToLayerPoint([0, 0]));
    const ctx = this.canvas.getContext('2d');
    ctx.clearRect(0, 0, size.x, size.y);
    const m = ZONE_MODES[this.mode];
    if (!m.alpha) return;

    // 1. 取樣每個方塊所在的區域
    const w = Math.ceil(size.x / BLOCK) + 1;
    const h = Math.ceil(size.y / BLOCK) + 1;
    const grid = new Uint8Array(w * h);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const ll = map.containerPointToLatLng([x * BLOCK, y * BLOCK]);
        grid[y * w + x] = zoneIndexAt(ll.lat, ll.lng);
      }
    }

    // 2. 底色（低解析度平滑放大）
    this.low.width = w;
    this.low.height = h;
    const lctx = this.low.getContext('2d');
    const img = lctx.createImageData(w, h);
    const colors = ZONES.map((z, i) => [...rgb(z.color), Math.round(m.alpha[i] * 255)]);
    for (let i = 0; i < grid.length; i += 1) {
      const c = colors[grid[i]];
      img.data.set(c, i * 4);
    }
    lctx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.low, 0, 0, w * BLOCK, h * BLOCK);

    // 3. 斜線紋路：危險區以上
    if (m.hatch) {
      ZONES.forEach((z, zi) => {
        const pat = hatchCanvas(z);
        if (!pat || !grid.includes(zi)) return;
        this.mask.width = size.x;
        this.mask.height = size.y;
        const mctx = this.mask.getContext('2d');
        mctx.clearRect(0, 0, size.x, size.y);
        mctx.fillStyle = '#000';
        for (let y = 0; y < h; y += 1) {
          for (let x = 0; x < w; x += 1) {
            if (grid[y * w + x] === zi) mctx.fillRect(x * BLOCK - BLOCK / 2, y * BLOCK - BLOCK / 2, BLOCK, BLOCK);
          }
        }
        mctx.globalCompositeOperation = 'source-in';
        mctx.fillStyle = mctx.createPattern(pat, 'repeat');
        mctx.fillRect(0, 0, size.x, size.y);
        mctx.globalCompositeOperation = 'source-over';
        ctx.drawImage(this.mask, 0, 0);
      });
    }

    // 4. 區域交界的邊界線：使用較危險一側的顏色
    ctx.lineWidth = m.border;
    ctx.lineCap = 'square';
    const segs = new Map();
    const add = (zi, x1, y1, x2, y2) => {
      if (!segs.has(zi)) segs.set(zi, []);
      segs.get(zi).push(x1, y1, x2, y2);
    };
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const a = grid[y * w + x];
        const px = x * BLOCK - BLOCK / 2;
        const py = y * BLOCK - BLOCK / 2;
        if (x + 1 < w) {
          const b = grid[y * w + x + 1];
          if (a !== b) add(Math.max(a, b), px + BLOCK, py, px + BLOCK, py + BLOCK);
        }
        if (y + 1 < h) {
          const b = grid[(y + 1) * w + x];
          if (a !== b) add(Math.max(a, b), px, py + BLOCK, px + BLOCK, py + BLOCK);
        }
      }
    }
    segs.forEach((list, zi) => {
      const z = ZONES[zi];
      const [r, g, b] = rgb(z.color);
      ctx.strokeStyle = `rgba(${r},${g},${b},${this.mode === 'strong' ? 0.85 : 0.5})`;
      ctx.beginPath();
      for (let i = 0; i < list.length; i += 4) {
        ctx.moveTo(list[i], list[i + 1]);
        ctx.lineTo(list[i + 2], list[i + 3]);
      }
      ctx.stroke();
    });
  },
});
