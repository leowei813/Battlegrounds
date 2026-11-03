import { zoneAt } from '../config/zones.js';
import L from 'leaflet';
import { POI_TYPES } from '../config/poiTypes.js';
import { dayKey } from '../systems/LootStock.js';
import { BASE_SIZES, baseSizeOf } from '../config/civilization.js';

/** 建築作為據點時的規模（依 ID 固定，快取避免每次重繪都計算） */
const sizeCache = new Map();
const sizeOf = (poi) => {
  let s = sizeCache.get(poi.id);
  if (!s) sizeCache.set(poi.id, (s = baseSizeOf(poi)));
  return s;
};

/**
 * 地圖建築圖層：上千棟建築用單一 canvas 繪製（DOM 標記在手機上會卡頓）。
 * 只在地圖移動/縮放結束或資料變更時重繪；點擊與滑鼠提示以像素距離判定。
 *
 * 縮放顯示：≤16 色點、17 小圖示、≥18 完整圖示（建築密集時避免重疊）。
 * 圖示大小依「可建立的據點規模」略有差異（小 < 中 < 大 < 巨），完整圖示再標上規模字樣。
 */
/** 區域顏色轉成圖示底色（較深、半透明，讓圖示清楚） */
const zoneFillCache = new Map();
function zoneFill(zone) {
  if (zoneFillCache.has(zone.id)) return zoneFillCache.get(zone.id);
  const hex = zone.color.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const mix = (c) => Math.round(c * 0.55 + 17 * 0.45);
  const v = `rgba(${mix(r)},${mix(g)},${mix(b)},0.92)`;
  zoneFillCache.set(zone.id, v);
  return v;
}

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

  /** @param {Record<string, number>} [detected] GPS 今日偵測過的建築（id → 日期） */
  setData(pois, detected = {}, { marked = new Set(), remain = {} } = {}) {
    this.marked = marked;
    this.remain = remain;
    this.pois = pois;
    this.detected = detected;
    if (this.map) this.redraw();
  },

  radius() {
    const z = this.map.getZoom();
    // 圖示略為放大，方便辨識
    if (z <= 14) return 2.5;
    if (z === 15) return 4.2;
    if (z === 16) return 6.2;
    if (z === 17) return 10.5;
    return 14;
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
    const today = dayKey();
    const order = [...this.pois].sort((a, b) => POI_TYPES[a.type].danger - POI_TYPES[b.type].danger);
    order.forEach((poi) => {
      const pt = map.latLngToContainerPoint([poi.lat, poi.lon]);
      if (pt.x < -pad || pt.y < -pad || pt.x > size.x + pad || pt.y > size.y + pad) return;
      const def = POI_TYPES[poi.type];
      const bs = BASE_SIZES[sizeOf(poi)];
      const rr = r * bs.mul;
      // 這個時段已被搜刮一空的建築變淡；還有殘留物資的維持原本亮度
      const left = this.remain?.[poi.id]?.day === today;
      ctx.globalAlpha = poi.lootedDay === today && !left ? 0.3 : 1;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, rr, 0, Math.PI * 2);
      // 底色：建築所在區域的顏色（安全區綠 → 深淵區黑），外框為建築類型的顏色；縮小時的圓點也用區域顏色
      const zc = zoneAt(poi.lat, poi.lon);
      ctx.fillStyle = icons ? zoneFill(zc) : zc.color;
      ctx.fill();
      if (!icons) {
        // 細外框：深色區域（致死、深淵）在地圖上也看得清楚
        ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(255,255,255,0.7)';
        ctx.stroke();
      }
      if (icons) {
        ctx.lineWidth = 2;
        ctx.strokeStyle = def.color;
        ctx.stroke();
        ctx.fillText(def.icon, pt.x, pt.y + 1);
        if (r >= 12) this.sizeTag(ctx, pt.x + rr * 0.8, pt.y + rr * 0.8, bs);
      }
      ctx.globalAlpha = 1;
      // GPS 偵測過的建築：青色外圈
      if (this.detected?.[poi.id] === today) {
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, rr + 3, 0, Math.PI * 2);
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#26c6da';
        ctx.stroke();
      }
      // 標記的地點：右上角插上圖釘
      if (this.marked?.has(poi.id)) {
        ctx.font = `${Math.round(Math.max(12, r * 1.1))}px sans-serif`;
        ctx.fillText('📌', pt.x + rr * 0.7, pt.y - rr * 0.9);
        ctx.font = `${Math.round(r * 1.15)}px sans-serif`;
      }
      this.drawn.push({ poi, x: pt.x, y: pt.y, r: rr });
    });
  },

  /** 右下角的規模字樣（小／中／大／巨） */
  sizeTag(ctx, x, y, size) {
    const font = ctx.font;
    ctx.font = 'bold 9px sans-serif';
    ctx.fillStyle = 'rgba(17,17,17,0.9)';
    ctx.beginPath();
    ctx.arc(x, y, 6.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = size.color;
    ctx.stroke();
    ctx.fillStyle = size.color;
    ctx.fillText(size.name[0], x, y + 0.5);
    ctx.font = font;
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
    // 點到野外的隊伍（其他玩家、NPC）時優先開啟隊伍資訊
    if (this.teamHit?.(e.containerPoint)) return;
    const poi = this.hit(e.containerPoint);
    if (poi) this.onClick(poi.id);
  },

  handleHover(e) {
    const poi = this.hit(e.containerPoint);
    const el = this.map.getContainer();
    el.style.cursor = poi ? 'pointer' : '';
    el.title = poi ? `${POI_TYPES[poi.type].icon} ${poi.name}（${BASE_SIZES[sizeOf(poi)].name}據點）` : '';
  },
});
