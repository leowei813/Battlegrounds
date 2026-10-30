import L from 'leaflet';
import { ZONES, zoneIndexAt } from '../config/zones.js';

/** 每個取樣方塊的像素大小（低解析度繪製後放大，邊界自然柔和） */
const BLOCK = 8;

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const COLORS = ZONES.map((z) => [...rgb(z.color), Math.round(z.alpha * 255)]);

/**
 * 區域危險度底色：以淡淡的顏色區分安全區～深淵區。
 * 在低解析度畫布上逐方塊取樣區域，再平滑放大到地圖大小。
 */
export const ZoneLayer = L.Layer.extend({
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
    map.on('moveend zoomend resize viewreset', this.redraw, this);
    this.redraw();
  },

  onRemove(map) {
    map.off('moveend zoomend resize viewreset', this.redraw, this);
    this.canvas.remove();
  },

  redraw() {
    const map = this.map;
    const size = map.getSize();
    const w = Math.ceil(size.x / BLOCK) + 1;
    const h = Math.ceil(size.y / BLOCK) + 1;
    this.low.width = w;
    this.low.height = h;
    const lctx = this.low.getContext('2d');
    const img = lctx.createImageData(w, h);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const ll = map.containerPointToLatLng([x * BLOCK, y * BLOCK]);
        const c = COLORS[zoneIndexAt(ll.lat, ll.lng)];
        const o = (y * w + x) * 4;
        img.data[o] = c[0];
        img.data[o + 1] = c[1];
        img.data[o + 2] = c[2];
        img.data[o + 3] = c[3];
      }
    }
    lctx.putImageData(img, 0, 0);
    this.canvas.width = size.x;
    this.canvas.height = size.y;
    this.canvas.style.width = `${size.x}px`;
    this.canvas.style.height = `${size.y}px`;
    L.DomUtil.setPosition(this.canvas, map.containerPointToLayerPoint([0, 0]));
    const ctx = this.canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.clearRect(0, 0, size.x, size.y);
    ctx.drawImage(this.low, 0, 0, w * BLOCK, h * BLOCK);
  },
});
