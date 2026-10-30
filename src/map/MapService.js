import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { ALL_ENEMIES } from '../config/enemies.js';
import { POI_SCAN_RADIUS, OUTPOST_SCAN_RADIUS } from '../config/constants.js';
import { BASE_SIZES } from '../config/civilization.js';
import { bus, EVT } from '../core/EventBus.js';
import { escapeHtml } from '../utils/dom.js';
import { SiegeMapLayer } from './SiegeMapLayer.js';
import { PoiCanvasLayer } from './PoiCanvasLayer.js';
import { ZoneLayer } from './ZoneLayer.js';
import { dayKey } from '../systems/LootStock.js';

/**
 * 真實地圖（Leaflet + OpenStreetMap 圖磚）。
 * 只負責呈現與互動；點擊事件透過 EventBus 交給 UI 層處理。
 */
export class MapService {
  /**
   * @param {HTMLElement} container
   * @param {import('../core/Game.js').Game} game 用於即時屍潮圖層
   */
  constructor(container, game) {
    this.container = container;
    this.game = game;
    this.map = null;
    this.layers = {};
    this.poiKey = '';
    this.zombieKey = '';
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
    this.zoneLayer = new ZoneLayer().addTo(this.map);
    this.layers.range = L.layerGroup().addTo(this.map);
    this.poiLayer = new PoiCanvasLayer((poiId) => bus.emit(EVT.OPEN_POI, { poiId })).addTo(this.map);
    this.layers.routes = L.layerGroup().addTo(this.map);
    this.layers.zombies = L.layerGroup().addTo(this.map);
    this.layers.shelter = L.layerGroup().addTo(this.map);
    this.layers.others = L.layerGroup().addTo(this.map);
    this.layers.npcs = L.layerGroup().addTo(this.map);
    this.siegeLayer = new SiegeMapLayer(this.game).addTo(this.map);
  }

  /** 地圖可見時才逐幀繪製屍潮 */
  setLive(on) {
    if (!this.siegeLayer) return;
    if (on) this.siegeLayer.start();
    else this.siegeLayer.stop();
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
    const sh = state.bases.find((b) => b.id === state.primaryBaseId && b.kind !== 'outpost') || null;

    // 建築與殭屍群數量多，只有內容變動時才重建標記
    const today = dayKey();
    let looted = 0;
    for (const p of pois) if (p.lootedDay === today) looted += 1;
    const poiKey = `${state.map.fetchedAt}|${pois.length}|${[...basePoiIds].join(',')}|${today}|${looted}`;
    if (poiKey !== this.poiKey) {
      this.poiKey = poiKey;
      this.poiLayer.setData(pois.filter((p) => !basePoiIds.has(p.id)));
    }

    const zombieKey = zombieGroups.map((g) => `${g.id}:${g.count}`).join(',');
    if (zombieKey !== this.zombieKey) this.zombieKey = zombieKey;
    else return this.renderBases(state, sh);
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
    return this.renderBases(state, sh);
  }

  /**
   * 據點圖示：依規模換圖示與大小，右下角標出規模；主要據點加上 ⭐。
   * @param {string} cls shelter-pin（自己）或 other-pin（其他玩家）
   */
  baseIcon(size, primary, cls) {
    const s = BASE_SIZES[size] || BASE_SIZES.medium;
    const d = s.pin + (primary ? 4 : 0);
    const html = `<div class="${cls} size-${size} ${primary ? 'primary' : 'outpost'}" style="--d:${d}px">${s.icon}`
      + `<i class="size-tag">${s.name[0]}</i>${primary ? '<i class="star-tag">⭐</i>' : ''}</div>`;
    return { icon: this.icon(html, 'shelter-icon', d), d };
  }

  /** NPC 據點（紅色骷髏旗，標示等級） */
  renderNpcs(list = []) {
    if (!this.map) return;
    const key = list.map((n) => `${n.id}:${n.level}`).join('|');
    if (key === this.npcKey) return;
    this.npcKey = key;
    this.layers.npcs.clearLayers();
    list.forEach((n) => {
      L.marker([n.lat, n.lon], {
        icon: this.icon(`<div class="npc-pin">🏴‍☠️<i class="npc-lv">Lv${n.level}</i></div>`, 'shelter-icon', 34),
        zIndexOffset: 850,
      }).on('click', () => bus.emit('ui:openNpc', { npcId: n.id }))
        .bindTooltip(`🏴‍☠️ ${escapeHtml(n.name)}（Lv${n.level}）`, { direction: 'top', offset: [0, -17] })
        .addTo(this.layers.npcs);
    });
  }

  /** 其他玩家公開的據點（多人互動） */
  renderOthers(players = []) {
    if (!this.map) return;
    this.layers.others.clearLayers();
    players.forEach((p) => p.bases.forEach((b) => {
      const { icon, d } = this.baseIcon(b.size, b.primary, 'other-pin');
      L.marker([b.lat, b.lon], { icon, zIndexOffset: 800 })
        .on('click', () => bus.emit('ui:openPlayer', { playerId: p.id }))
        .bindTooltip(`👤 ${escapeHtml(p.name)}・${escapeHtml(b.name)}（${(BASE_SIZES[b.size] || BASE_SIZES.medium).name}）`, { direction: 'top', offset: [0, -d / 2] })
        .addTo(this.layers.others);
    }));
  }

  /** 據點、探索範圍、補給線與探索路線（數量少，每次重建） */
  renderBases(state, sh) {
    this.layers.shelter.clearLayers();
    this.layers.range.clearLayers();
    if (sh) {
      L.circle([sh.lat, sh.lon], {
        radius: POI_SCAN_RADIUS, color: '#ff5252', weight: 1, dashArray: '6 6', fillOpacity: 0.03,
      }).addTo(this.layers.range);
    }
    state.bases.forEach((b) => {
      const primary = b === sh;
      const { icon, d } = this.baseIcon(b.size, primary, 'shelter-pin');
      L.marker([b.lat, b.lon], { icon, zIndexOffset: primary ? 1000 : 900, title: b.name })
        .on('click', () => bus.emit(EVT.OPEN_POI, { poiId: b.poiId }))
        .bindTooltip(`${primary ? '⭐ 避難所' : '🏴 前哨站'}・${escapeHtml(b.name)}（${(BASE_SIZES[b.size] || BASE_SIZES.medium).name}）`, { direction: 'top', offset: [0, -d / 2] })
        .addTo(this.layers.shelter);
      // 前哨站的可視範圍較小
      if (!primary) {
        L.circle([b.lat, b.lon], {
          radius: OUTPOST_SCAN_RADIUS, color: '#ffb300', weight: 1, dashArray: '4 6', fillOpacity: 0.02,
        }).addTo(this.layers.range);
      }
      // 前哨與主要據點之間的補給線
      if (!primary && sh) {
        L.polyline([[sh.lat, sh.lon], [b.lat, b.lon]], { color: '#ffb300', weight: 2, opacity: 0.5 }).addTo(this.layers.range);
      }
    });

    this.layers.routes.clearLayers();
    if (sh) {
      state.expeditions.forEach((ex) => {
        const p = this.game.exploration.poi(ex.poiId);
        if (!p) return;
        const from = ex.from || sh;
        L.polyline([[from.lat, from.lon], [p.lat, p.lon]], {
          color: '#ffd54f', weight: 3, dashArray: '4 8', className: 'route-line',
        }).addTo(this.layers.routes);
      });
    }
  }
}
