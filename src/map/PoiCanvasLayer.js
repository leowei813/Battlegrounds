import L from 'leaflet';
import { POI_TYPES } from '../config/poiTypes.js';
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

  setData(pois, { marked = new Set(), statusOf = null } = {}) {
    this.marked = marked;
    this.statusOf = statusOf;
    this.pois = pois;
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
    const now = Date.now();
    const badges = [];
    const order = [...this.pois].sort((a, b) => POI_TYPES[a.type].danger - POI_TYPES[b.type].danger);
    order.forEach((poi) => {
      const pt = map.latLngToContainerPoint([poi.lat, poi.lon]);
      if (pt.x < -pad || pt.y < -pad || pt.x > size.x + pad || pt.y > size.y + pad) return;
      const def = POI_TYPES[poi.type];
      const bs = BASE_SIZES[sizeOf(poi)];
      const rr = r * bs.mul;
      // v10 地點狀態：已搜空變淡；有人探索中藍框、搜過一部分黃框
      const st = this.statusOf ? this.statusOf(poi) : null;
      const busy = st && !st.empty ? st.occ.find((x) => x.a <= now && x.l > now) : null;
      ctx.globalAlpha = st?.empty ? 0.3 : 1;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, rr, 0, Math.PI * 2);
      // 建築類型的顏色（區域危險度改由地圖底色呈現）
      ctx.fillStyle = icons ? 'rgba(17,17,17,0.82)' : def.color;
      ctx.fill();
      if (!icons) {
        // 細外框：在灰階底圖與區域底色上也看得清楚
        ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(255,255,255,0.75)';
        ctx.stroke();
      }
      if (icons) {
        ctx.lineWidth = 2;
        ctx.strokeStyle = def.color;
        ctx.stroke();
        ctx.fillText(def.icon, pt.x, pt.y + 1);
        if (r >= 12) this.sizeTag(ctx, pt.x + rr * 0.8, pt.y + rr * 0.8, bs);
      }
      if (busy || st?.left) {
        ctx.globalAlpha = 1;
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, rr + 2.5, 0, Math.PI * 2);
        ctx.lineWidth = 3;
        // NPC 探索中用紅色、友好玩家綠色，其他玩家（含自己）藍色
        ctx.strokeStyle = busy ? (busy.npc ? '#ef5350' : busy.rel === 'friend' ? '#66bb6a' : '#4fc3f7') : '#ffb300';
        ctx.stroke();
      }
      // 放大時才顯示文字（誰在探索・還要多久／剩幾個檢核點／幾點恢復）
      if (r >= 12 && st) {
        const hm = (t) => { const d = new Date(t); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
        let text = '';
        let bg = '';
        if (st.empty) { text = `🕸️ ${hm(st.until)}`; bg = '#424242'; }
        else if (busy) { text = `🔍 ${String(busy.n).replace(/^NPC「(.*)」$/, 'NPC $1').slice(0, 8)} ${Math.max(1, Math.ceil((busy.l - now) / 60000))}分`; bg = busy.npc ? '#b71c1c' : busy.rel === 'friend' ? '#2e7d32' : '#01579b'; }
        else if (st.left && st.left.total > st.left.done) { text = `⏳ 剩 ${st.left.total - st.left.done}/${st.left.total}`; bg = '#8a6d1d'; }
        if (text) badges.push({ x: pt.x, y: pt.y - rr - 9, text, bg });
      }
      ctx.globalAlpha = 1;
      this.drawn.push({ poi, x: pt.x, y: pt.y, r: rr });
    });
    // 狀態文字畫在最上層
    const font = ctx.font;
    ctx.font = 'bold 11px sans-serif';
    badges.forEach((b) => {
      const w = ctx.measureText(b.text).width + 10;
      ctx.fillStyle = b.bg;
      ctx.globalAlpha = 0.92;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(b.x - w / 2, b.y - 8, w, 16, 8); else ctx.rect(b.x - w / 2, b.y - 8, w, 16);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#fff';
      ctx.fillText(b.text, b.x, b.y + 0.5);
    });
    ctx.font = font;
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
