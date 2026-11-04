import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { ALL_ENEMIES } from '../config/enemies.js';
import { POI_SCAN_RADIUS, OUTPOST_SCAN_RADIUS } from '../config/constants.js';
import { BASE_SIZES } from '../config/civilization.js';
import { bus, EVT } from '../core/EventBus.js';
import { escapeHtml } from '../utils/dom.js';
import { SiegeMapLayer } from './SiegeMapLayer.js';
import { PoiCanvasLayer } from './PoiCanvasLayer.js';
import { ZoneLayer, ZONE_MODES, ZONE_MODE_ORDER } from './ZoneLayer.js';

const ZONE_MODE_KEY = 'jdqs.zoneMode';
/** 危險度圖層模式（每台裝置各自記住） */
export function savedZoneMode() {
  try {
    const m = localStorage.getItem(ZONE_MODE_KEY);
    return ZONE_MODES[m] ? m : 'light';
  } catch {
    return 'light';
  }
}
import { dayKey } from '../systems/LootStock.js';
import { npcAlert } from '../systems/TerritorySystem.js';
import { GPS_RADIUS } from '../systems/GpsSystem.js';

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
      className: 'base-tiles',
    }).addTo(this.map);
    // 區域危險度底色
    this.zoneLayer = new ZoneLayer(savedZoneMode()).addTo(this.map);
    this.applyZoneMode(savedZoneMode());
    this.layers.range = L.layerGroup().addTo(this.map);
    this.poiLayer = new PoiCanvasLayer((poiId) => bus.emit(EVT.OPEN_POI, { poiId })).addTo(this.map);
    this.layers.routes = L.layerGroup().addTo(this.map);
    // 路線畫在建築圖層（440）之上：原本在預設圖層（400）會被建築畫布蓋住而看不到
    if (!this.map.getPane('routePane')) {
      const pane = this.map.createPane('routePane');
      pane.style.zIndex = 445;
      pane.style.pointerEvents = 'none';
    }
    this.routeRenderer = L.svg({ pane: 'routePane' });
    this.layers.zombies = L.layerGroup().addTo(this.map);
    this.layers.shelter = L.layerGroup().addTo(this.map);
    this.layers.others = L.layerGroup().addTo(this.map);
    this.layers.npcs = L.layerGroup().addTo(this.map);
    this.layers.infected = L.layerGroup().addTo(this.map);
    this.layers.gps = L.layerGroup().addTo(this.map);
    this.siegeLayer = new SiegeMapLayer(this.game).addTo(this.map);
    this.poiLayer.teamHit = (pt) => {
      const team = this.siegeLayer.teamAt(pt);
      if (team) bus.emit('ui:openTeam', team);
      return !!team;
    };
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
    const detected = state.map.detected || {};
    const marked = new Set((state.map.markers || []).map((m) => m.id));
    const remain = state.map.remain || {};
    const poiKey = `${state.map.fetchedAt}|${pois.length}|${[...basePoiIds].join(',')}|${today}|${looted}|${Object.keys(detected).length}|${[...marked].join(',')}|${Object.keys(remain).join(',')}`;
    if (poiKey !== this.poiKey) {
      this.poiKey = poiKey;
      this.poiLayer.setData(pois.filter((p) => !basePoiIds.has(p.id)), detected, { marked, remain });
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

  /** 自己的 GPS 位置與 50 公尺偵測範圍（在據點內時為灰色，不偵測） */
  renderGps(gps) {
    if (!this.map) return;
    this.layers.gps.clearLayers();
    if (!gps?.pos || gps.status === 'off') return;
    const inBase = gps.status === 'inBase';
    L.circle([gps.pos.lat, gps.pos.lon], {
      radius: GPS_RADIUS, color: inBase ? '#9e9e9e' : '#29b6f6', weight: 2, fillColor: inBase ? '#9e9e9e' : '#29b6f6', fillOpacity: 0.08, interactive: false,
    }).addTo(this.layers.gps);
    L.circleMarker([gps.pos.lat, gps.pos.lon], {
      radius: 7, color: '#fff', weight: 2, fillColor: '#1e88e5', fillOpacity: 1, interactive: false,
    }).addTo(this.layers.gps);
  }

  /** 切換危險度圖層：淡 ↔ 關閉 */
  cycleZoneMode() {
    const cur = this.zoneLayer?.mode || savedZoneMode();
    const next = ZONE_MODE_ORDER[(ZONE_MODE_ORDER.indexOf(cur) + 1) % ZONE_MODE_ORDER.length];
    try { localStorage.setItem(ZONE_MODE_KEY, next); } catch { /* 無法保存 */ }
    this.applyZoneMode(next);
    return ZONE_MODES[next].name;
  }

  applyZoneMode(mode) {
    this.zoneLayer?.setMode(mode);
  }

  zoneMode() {
    return this.zoneLayer?.mode || savedZoneMode();
  }

  /** NPC 據點（紅色骷髏旗，標示等級） */
  renderNpcs(list = []) {
    if (!this.map) return;
    const iv = (n) => this.game.npcs.intelView(n).levelShort;
    const key = list.map((n) => `${n.id}:${iv(n)}`).join('|');
    if (key === this.npcKey) return;
    this.npcKey = key;
    this.layers.npcs.clearLayers();
    list.forEach((n) => {
      // NPC 一律敵對：紅色警戒範圍
      L.circle([n.lat, n.lon], {
        radius: npcAlert(n), color: '#e53935', weight: 1, dashArray: '3 5', fillColor: '#e53935', fillOpacity: 0.05, interactive: false,
      }).addTo(this.layers.npcs);
      L.marker([n.lat, n.lon], {
        icon: this.icon(`<div class="npc-pin">🏴‍☠️<i class="npc-lv">${iv(n)}</i></div>`, 'shelter-icon', 34),
        zIndexOffset: 850,
      }).on('click', () => bus.emit('ui:openNpc', { npcId: n.id }))
        .bindTooltip(`🏴‍☠️ ${escapeHtml(n.name)}（${iv(n)}）`, { direction: 'top', offset: [0, -17] })
        .addTo(this.layers.npcs);
    });
  }


  /** 重度感染據點（比巨型據點略大，標示淨化度） */
  renderInfected(list = [], pin = 48) {
    if (!this.map) return;
    const key = list.map((s) => `${s.id}:${Math.floor(s.purity)}`).join('|');
    if (key === this.infKey) return;
    this.infKey = key;
    this.layers.infected.clearLayers();
    list.forEach((s) => {
      L.marker([s.lat, s.lon], {
        icon: this.icon(`<div class="inf-pin" style="--d:${pin}px">☣️<i class="inf-pur">${Math.floor(s.purity)}%</i></div>`, 'shelter-icon', pin),
        zIndexOffset: 860,
      }).on('click', () => bus.emit('ui:openInfected', { id: s.id }))
        .bindTooltip(`☣️ 重度感染據點「${escapeHtml(s.name)}」・淨化 ${Math.floor(s.purity)}%`, { direction: 'top', offset: [0, -pin / 2] })
        .addTo(this.layers.infected);
    });
  }

  /** 其他玩家公開的據點（多人互動） */
  renderOthers(players = [], relationOf = () => 'neutral') {
    if (!this.map) return;
    this.layers.others.clearLayers();
    const COLORS = { hostile: '#e53935', friend: '#43a047', neutral: '#26c6da' };
    players.forEach((p) => p.bases.forEach((b) => {
      const rel = relationOf(p.id);
      // 警戒範圍：敵對紅、友好綠、中立青
      L.circle([b.lat, b.lon], {
        radius: b.alert || BASE_SIZES[b.size]?.alert || 80, color: COLORS[rel], weight: 1, dashArray: '3 5', fillColor: COLORS[rel], fillOpacity: 0.05, interactive: false,
      }).addTo(this.layers.others);
      const { icon, d } = this.baseIcon(b.size, b.primary, `other-pin rel-${rel}`);
      L.marker([b.lat, b.lon], { icon, zIndexOffset: 800 })
        .on('click', () => bus.emit('ui:openPlayer', { playerId: p.id }))
        .bindTooltip(`${{ hostile: '⚔️ 敵對', friend: '🤝 友好', neutral: '👤 中立' }[rel]}・${escapeHtml(p.name)}・${escapeHtml(b.name)}（${(BASE_SIZES[b.size] || BASE_SIZES.medium).name}）`, { direction: 'top', offset: [0, -d / 2] })
        .addTo(this.layers.others);
      // 友好玩家正遭到屍潮攻擊：顯示 🧟 圖示與狀況，點擊可協防
      if (rel === 'friend' && b.siege) {
        const s = b.siege;
        L.marker([b.lat, b.lon], {
          icon: L.divIcon({ className: 'siege-badge', html: '<span>🧟</span>', iconSize: [26, 26], iconAnchor: [d / 2 + 20, d / 2 + 14] }),
          zIndexOffset: 950,
        }).on('click', () => bus.emit('ui:openPlayer', { playerId: p.id }))
          .bindTooltip(`🧟 ${escapeHtml(p.name)} 正遭到屍潮攻擊：第 ${s.wave}/${s.maxWaves} 波・剩 ${s.left} 隻・圍牆 ${s.wallPct}%${s.helpers ? `・🛡️ ${s.helpers} 位協防中` : ''}（點擊查看）`, { direction: 'top' })
          .addTo(this.layers.others);
      }
      // 友好玩家正被 NPC 或玩家攻打：顯示 ⚔️ 圖示
      const raids = rel === 'friend' ? (b.raids || []).filter((r) => r.at > Date.now()) : [];
      if (raids.length) {
        L.marker([b.lat, b.lon], {
          icon: L.divIcon({ className: 'siege-badge raid-badge', html: '<span>⚔️</span>', iconSize: [26, 26], iconAnchor: [d / 2 + 20, -d / 2 + 6] }),
          zIndexOffset: 950,
        }).on('click', () => bus.emit('ui:openPlayer', { playerId: p.id }))
          .bindTooltip(`⚔️ ${escapeHtml(p.name)} 的據點正被攻打：${raids.map((r) => `${escapeHtml(r.by)}（約 ${Math.max(1, Math.round((r.at - Date.now()) / 60000))} 分鐘後抵達）`).join('、')}`, { direction: 'top' })
          .addTo(this.layers.others);
      }
    }));
  }

  /** 預覽路線（探索佇列）：與實際出發時相同的繞路規則；依地點與警戒範圍快取，避免每秒重算 */
  plannedRoute(a, b) {
    // 只用 NPC 與其他玩家據點的識別判斷是否需要重算（不每秒建立完整的警戒範圍資料）
    const zonesKey = `${this.game.npcs.list.map((n) => `${n.id}:${n.level}`).join(',')}|${(this.game.world?.others || []).map((o) => `${o.id}:${o.bases.length}`).join(',')}`;
    if (zonesKey !== this.routeZonesKey) {
      this.routeZonesKey = zonesKey;
      this.routeCache = new Map();
    }
    const key = `${a.id || `${a.lat},${a.lon}`}>${b.id || `${b.lat},${b.lon}`}`;
    if (!this.routeCache.has(key)) {
      const ignore = b.id ? this.game.exploration.targetZone(b) : [];
      this.routeCache.set(key, this.game.territory.route(a, b, { ignore }));
    }
    return this.routeCache.get(key);
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
      // 自己據點的警戒範圍
      L.circle([b.lat, b.lon], {
        radius: this.game.territory.alertRadius(b), color: '#ffd54f', weight: 1, dashArray: '2 4', fillOpacity: 0, interactive: false,
      }).addTo(this.layers.range);
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
      const now = Date.now();
      state.expeditions.forEach((ex) => {
        const p = this.game.exploration.poi(ex.poiId);
        if (!p) return;
        const from = ex.from || sh;
        const phase = this.game.exploration.progress(ex, now)?.phase;
        const outPath = ex.path ? ex.path.map((q) => [q.lat, q.lon]) : [[from.lat, from.lon], [p.lat, p.lon]];
        // 連續探索：回程是另一條路線（從這個地點直接回避難所），返程時以黃線顯示，否則淡淡顯示
        const backPath = Array.isArray(ex.backPath) && ex.backPath.length >= 2 ? ex.backPath.map((q) => [q.lat, q.lon]) : null;
        if (!backPath || phase !== 'returning') {
          L.polyline(outPath, { color: '#ffd54f', weight: 3, dashArray: '4 8', className: 'route-line', pane: 'routePane', renderer: this.routeRenderer }).addTo(this.layers.routes);
        }
        if (backPath) {
          L.polyline(backPath, phase === 'returning'
            ? { color: '#ffd54f', weight: 3, dashArray: '4 8', className: 'route-line', pane: 'routePane', renderer: this.routeRenderer }
            : { color: '#ffd54f', weight: 2, opacity: 0.35, dashArray: '2 8', interactive: false, pane: 'routePane', renderer: this.routeRenderer }).addTo(this.layers.routes);
        }
        // 探索佇列：從目前的目的地依序連到佇列中的每個地點（同樣繞開 NPC 等警戒範圍），並標上順序
        const queued = (ex.queue || []).map((id) => this.game.exploration.poi(id)).filter(Boolean);
        if (!queued.length) return;
        const pts = [p, ...queued];
        const line = [];
        for (let i = 0; i < pts.length - 1; i += 1) {
          const seg = this.plannedRoute(pts[i], pts[i + 1]);
          (i ? seg.slice(1) : seg).forEach((q) => line.push([q.lat, q.lon]));
        }
        L.polyline(line, {
          color: '#8fc3ff', weight: 3, opacity: 0.9, dashArray: '2 7', interactive: false, pane: 'routePane', renderer: this.routeRenderer,
        }).addTo(this.layers.routes);
        queued.forEach((q, i) => {
          L.marker([q.lat, q.lon], {
            icon: this.icon(`<div class="queue-pin">${i + 1}</div>`, 'queue-icon', 22),
            interactive: false,
            zIndexOffset: 700,
          }).addTo(this.layers.routes);
        });
      });
    }
  }
}
