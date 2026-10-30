import L from 'leaflet';
import { POI_TYPES } from '../config/poiTypes.js';

/**
 * 地圖建築圖層：上千棟建築用單一 canvas 繪製（DOM 標記在手機上會卡頓）。
 * 只在地圖移動/縮放結束或資料變更時重繪；點擊與滑鼠提示以像素距離判定。
 *
 * 縮放顯示：≤16 色點、17 小圖示、≥18 完整圖示（建築密集時避免重疊）。
 */
export const PoiCanvasLayer = L.Layer.extend({
  /** @param {(poiId:string)=>void} onClick */
  initialize(onClick) {
    this.onClick = onClick;
    this.pois = [];
    this.drawn = []; // 最近一次繪製的 { poi, x, y, r }，供點擊判定
  },

  onAdd(map) {
    this.map = map;
    if (!map.getPane('poiPane')) {
      const pane = map.createPane('poiPane');
      pane.style.zIndex = 440; // 在屍潮圖層（450）與標記（600）之下
      pane.style.pointerEvents = 'none';
    }
    this.canvas = L.DomUtil.create('canvas', 'poi-canvas leaflet-zoom-hide');
    map.getPane('poiPane').appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    map.on('moveend zoomend resize viewreset', this.redraw, this);
    map.on('click', this.handleClick, this);
    map.on('mousemove', this.handleHover, this);
    this.redraw();
  },

  onRemove(map) {
    map.off('moveend zoomend resize viewreset', this.redraw, this);
    map.off('click', this.handleClick, this);
    map.off('mousemove', this.handleHover, this);
    this.canvas.remove();
  },

  setData(pois) {
    this.pois = pois;
    if (this.map) this.redraw();
  },

  radius() {
    const z = this.map.getZoom();
    if (z <= 14) return 2;
    if (z === 15) return 3.5;
    if (z === 16) return 5;
    if (z === 17) return 9;
    return 12;
  },

  redraw() {
    const map = this.map;
    const size = map.getSize();
    const dpr = window.devicePixelRatio || 1;
    if (this.canvas.width !== size.x * dpr || this.canvas.height !== size.y * dpr) {
      this.canvas.width = size.x * dpr;
      this.canvas.height = size.y * dpr;
      this.canvas.style.width = `${size.x}px`;
      this.canvas.style.height = `${size.y}px`;
    }
    L.DomUtil.setPosition(this.canvas, map.containerPointToLayerPoint([0, 0]));
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.x, size.y);

    const r = this.radius();
    const icons = r >= 9;
    const pad = r + 2;
    this.drawn = [];
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `${Math.round(r * 1.15)}px sans-serif`;
    // 住宅先畫，重要建築畫在上層
    const order = [...this.pois].sort((a, b) => POI_TYPES[a.type].danger - POI_TYPES[b.type].danger);
    order.forEach((poi) => {
      const pt = map.latLngToContainerPoint([poi.lat, poi.lon]);
      if (pt.x < -pad || pt.y < -pad || pt.x > size.x + pad || pt.y > size.y + pad) return;
      const def = POI_TYPES[poi.type];
      const rr = poi.type === 'residential' && icons ? r * 0.8 : r;
      ctx.globalAlpha = 1 - (poi.depletion || 0) * 0.8;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, rr, 0, Math.PI * 2);
      ctx.fillStyle = icons ? 'rgba(17,17,17,0.82)' : def.color;
      ctx.fill();
      if (icons) {
        ctx.lineWidth = 2;
        ctx.strokeStyle = def.color;
        ctx.stroke();
        ctx.fillText(def.icon, pt.x, pt.y + 1);
      }
      ctx.globalAlpha = 1;
      this.drawn.push({ poi, x: pt.x, y: pt.y, r: rr });
    });
  },

  /** 找出滑鼠/手指位置附近的建築（觸控放寬判定範圍） */
  hit(containerPoint) {
    const slop = L.Browser.touch ? 10 : 4;
    let best = null;
    let bestD = Infinity;
    this.drawn.forEach((d) => {
      const dist = Math.hypot(d.x - containerPoint.x, d.y - containerPoint.y);
      if (dist <= Math.max(d.r, 6) + slop && dist < bestD) {
        best = d.poi;
        bestD = dist;
      }
    });
    return best;
  },

  handleClick(e) {
    const poi = this.hit(e.containerPoint);
    if (poi) this.onClick(poi.id);
  },

  handleHover(e) {
    const poi = this.hit(e.containerPoint);
    const el = this.map.getContainer();
    el.style.cursor = poi ? 'pointer' : '';
    el.title = poi ? `${POI_TYPES[poi.type].icon} ${poi.name}` : '';
  },
});
