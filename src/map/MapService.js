import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { POI_TYPES } from '../config/poiTypes.js';
import { ALL_ENEMIES } from '../config/enemies.js';
import { POI_SCAN_RADIUS } from '../config/constants.js';
import { bus, EVT } from '../core/EventBus.js';
import { escapeHtml } from '../utils/dom.js';

/**
 * 真實地圖（Leaflet + OpenStreetMap 圖磚）。
 * 只負責呈現與互動；點擊事件透過 EventBus 交給 UI 層處理。
 */
export class MapService {
  constructor(container) {
    this.container = container;
    this.map = null;
    this.layers = {};
    this.poiMarkers = new Map();
  }

  init(lat, lon) {
    if (this.map) {
      this.map.setView([lat, lon], 16);
      return;
    }
    this.map = L.map(this.container, { zoomControl: true, attributionControl: true }).setView([lat, lon], 16);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
    }).addTo(this.map);
    this.layers.range = L.layerGroup().addTo(this.map);
    this.layers.pois = L.layerGroup().addTo(this.map);
    this.layers.routes = L.layerGroup().addTo(this.map);
    this.layers.zombies = L.layerGroup().addTo(this.map);
    this.layers.shelter = L.layerGroup().addTo(this.map);
  }

  invalidate() {
    if (this.map) setTimeout(() => this.map.invalidateSize(), 50);
  }

  focus(lat, lon, zoom = 17) {
    this.map?.setView([lat, lon], zoom);
  }

  icon(html, cls, size = 34) {
    return L.divIcon({ html, className: cls, iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
  }

  /**
   * 依目前狀態重繪所有圖層。
   * @param {object} state 遊戲狀態
   */
  render(state) {
    if (!this.map) return;
    const { pois, zombieGroups } = state.map;
    const basePoiIds = new Set(state.bases.map((b) => b.poiId));
    const sh = state.bases.find((b) => b.id === state.primaryBaseId) || state.bases[0] || null;

    this.layers.pois.clearLayers();
    pois.forEach((p) => {
      if (basePoiIds.has(p.id)) return;
      const pt = POI_TYPES[p.type];
      const dep = p.depletion ? ` style="opacity:${1 - p.depletion * 0.8}"` : '';
      const m = L.marker([p.lat, p.lon], {
        icon: this.icon(`<div class="poi-pin" style="--c:${pt.color}"${dep}>${pt.icon}</div>`, 'poi-icon'),
        title: p.name,
        riseOnHover: true,
      });
      m.on('click', () => bus.emit(EVT.OPEN_POI, { poiId: p.id }));
      m.addTo(this.layers.pois);
    });

    this.layers.zombies.clearLayers();
    zombieGroups.forEach((g) => {
      const e = ALL_ENEMIES[g.enemyId];
      const cls = g.boss ? 'zombie-pin boss' : g.elite ? 'zombie-pin elite' : 'zombie-pin';
      const m = L.marker([g.lat, g.lon], {
        icon: this.icon(`<div class="${cls}">${e.icon}<span>${g.count}</span></div>`, 'zombie-icon', g.boss ? 40 : 28),
        zIndexOffset: 500,
      });
      m.on('click', () => bus.emit('ui:openZombie', { groupId: g.id }));
      m.addTo(this.layers.zombies);
    });

    this.layers.shelter.clearLayers();
    this.layers.range.clearLayers();
    if (sh) {
      L.circle([sh.lat, sh.lon], {
        radius: POI_SCAN_RADIUS, color: '#ff5252', weight: 1, dashArray: '6 6', fillOpacity: 0.03,
      }).addTo(this.layers.range);
    }
    state.bases.forEach((b) => {
      const primary = b === sh;
      L.marker([b.lat, b.lon], {
        icon: primary
          ? this.icon('<div class="shelter-pin">🏰</div>', 'shelter-icon', 46)
          : this.icon('<div class="shelter-pin outpost">🏠</div>', 'shelter-icon', 36),
        zIndexOffset: primary ? 1000 : 900,
        title: b.name,
      }).on('click', () => bus.emit(EVT.OPEN_POI, { poiId: b.poiId }))
        .bindTooltip(`${primary ? '⭐ ' : ''}${escapeHtml(b.name)}`, { direction: 'top', offset: [0, primary ? -20 : -16] })
        .addTo(this.layers.shelter);
      // 前哨與主要據點之間的補給線
      if (!primary && sh) {
        L.polyline([[sh.lat, sh.lon], [b.lat, b.lon]], { color: '#ffb300', weight: 2, opacity: 0.5 }).addTo(this.layers.range);
      }
    });

    this.layers.routes.clearLayers();
    if (sh) {
      state.expeditions.forEach((ex) => {
        const p = pois.find((x) => x.id === ex.poiId);
        if (!p) return;
        L.polyline([[sh.lat, sh.lon], [p.lat, p.lon]], {
          color: '#ffd54f', weight: 3, dashArray: '4 8', className: 'route-line',
        }).addTo(this.layers.routes);
      });
    }
  }
}
