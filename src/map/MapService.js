import { formatDuration } from '../utils/math.js';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { ALL_ENEMIES } from '../config/enemies.js';
import { WORLD_BOUNDS, inWorld } from '../config/world.js';
import { BASE_SIZES } from '../config/civilization.js';
import { bus, EVT } from '../core/EventBus.js';
import { escapeHtml } from '../utils/dom.js';
import { SiegeMapLayer } from './SiegeMapLayer.js';
import { PoiCanvasLayer } from './PoiCanvasLayer.js';
import { ZoneLayer, ZONE_MODES, ZONE_MODE_ORDER, FACTION_COLORS } from './ZoneLayer.js';
import * as CP_CONFIG from '../config/controlPoints.js';

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
import { npcAlert } from '../systems/TerritorySystem.js';
import { GPS_RADIUS } from '../systems/GpsSystem.js';

/**
 * 真實地圖（Leaflet + OpenStreetMap 圖磚）。
 * 只負責呈現與互動；點擊事件透過 EventBus 交給 UI 層處理。
 */
/** 控制點圓點內的圖案：交叉劍 */
const CP_ICON = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 2 L10 10 M10 2 L2 10" stroke="#111" stroke-width="1.6" stroke-linecap="round"/><path d="M1.5 8.5 l2 2 M8.5 10.5 l2-2" stroke="#111" stroke-width="1.6"/></svg>';

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
    // v13：固定世界地圖，只能在範圍附近移動
    const b = WORLD_BOUNDS;
    const pad = 0.0025;
    this.map = L.map(this.container, {
      zoomControl: true, attributionControl: true, minZoom: 14,
      maxBounds: [[b.s - pad, b.w - pad], [b.n + pad, b.e + pad]], maxBoundsViscosity: 1,
    }).setView([lat, lon], 16);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
      className: 'base-tiles',
      // v13：只載入固定地圖範圍內的底圖
      bounds: [[b.s, b.w], [b.n, b.e]],
    }).addTo(this.map);
    // 區域危險度底色
    this.zoneLayer = new ZoneLayer(savedZoneMode()).addTo(this.map);
    this.applyZoneMode(savedZoneMode());
    // 範圍外完全遮住（不顯示、不載入），範圍邊框
    const far = [[b.s - 1, b.w - 1], [b.s - 1, b.e + 1], [b.n + 1, b.e + 1], [b.n + 1, b.w - 1]];
    const box = [[b.s, b.w], [b.s, b.e], [b.n, b.e], [b.n, b.w]];
    L.polygon([far, box], {
      stroke: false, fillColor: '#0b1418', fillOpacity: 1, interactive: false, className: 'world-mask',
    }).addTo(this.map);
    L.rectangle([[b.s, b.w], [b.n, b.e]], {
      color: '#ff5252', weight: 3, fill: false, interactive: false, className: 'world-edge',
    }).addTo(this.map);
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
    this.layers.cps = L.layerGroup().addTo(this.map);
    this.layers.convoys = L.layerGroup().addTo(this.map);
    this.cpConfig = CP_CONFIG;
    this.layers.dungeons = L.layerGroup().addTo(this.map);
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
    const detected = state.map.detected || {};
    const marked = new Set((state.map.markers || []).map((m) => m.id));
    // v10：地點狀態（有人探索中、搜過一部分、已搜空）由共用紀錄決定
    const ps = this.game?.poiShare;
    const npcTrips = (this.game?.npcs?.list || []).filter((n) => n.trip?.kind === 'explore').map((n) => n.trip.poiId).join(',');
    // v15：不可探索的區域（未佔領的控制點、勢力領地）不顯示建築，地圖上變黑、只顯示控制點
    const cpSys = state.map.source === 'generated' ? this.game?.cp : null;
    const cpSig = cpSys ? (this.cpConfig?.CONTROL_POINTS || []).map((c) => (cpSys.statusOf(c.id) === 'mine' ? 1 : 0)).join('') : '';
    const poiKey = `${state.map.fetchedAt}|${pois.length}|${[...basePoiIds].join(',')}|${Object.keys(detected).length}|${[...marked].join(',')}|${ps?.signature() || ''}|${npcTrips}|${cpSig}`;
    if (poiKey !== this.poiKey) {
      this.poiKey = poiKey;
      this.poiLayer.setData(pois.filter((p) => !basePoiIds.has(p.id) && (!cpSys || cpSys.canExplore(p).ok)), detected, { marked, statusOf: ps ? (p) => ps.view(p) : null });
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

  /** 切換圖層：危險度 ⇄ 勢力圖 */
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
      if (n.hq) return; // 大本營另外顯示（renderCps）
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
  /** v14 控制點：圓形點位（依佔領狀態上色），點擊打開控制點資訊；勢力圖底色一併更新 */
  renderCps(game) {
    if (!this.map || !this.layers.cps) return;
    const { CONTROL_POINTS } = this.cpConfig || {};
    if (!CONTROL_POINTS) return;
    const cols = { mine: '#4fc3f7', other: '#9e9e9e', hostile: '#ef9a9a', neutral: '#bdbdbd', faction: '#ef5350' };
    const z = this.map.getZoom();
    const st = `${z}|${CONTROL_POINTS.map((c) => `${c.id}:${game.cp.statusOf(c.id)}:${game.cp.factionOf(c.id) || ''}`).join('|')}`;
    if (st === this.cpKey) return;
    this.cpKey = st;
    this.layers.cps.clearLayers();
    CONTROL_POINTS.forEach((c) => {
      const s = game.cp.statusOf(c.id);
      const col = s === 'faction' ? FACTION_COLORS[game.cp.factionOf(c.id)] : cols[s];
      // 控制點：與巨型資源點一樣大的圓形點位（隨縮放），位置避開其他建築；顏色＝佔領狀態、外圈慢速呼吸光；點這個點才打開控制點資訊
      const size = Math.max(10, Math.round((this.poiLayer?.radius?.() || 6) * 1.25 * 2) + 4);
      const spot = game.cp.markerSpot(c.id);
      L.marker([spot.lat, spot.lon], {
        icon: this.icon(`<div class="cp-dot" style="--c:${col || '#bdbdbd'};--s:${size}px">${CP_ICON}</div>`, 'shelter-icon', size),
        zIndexOffset: 850,
      }).on('click', () => bus.emit('ui:openCp', { id: c.id }))
        .bindTooltip(`🚩 控制點・${game.cp.summary(c.id).label}`, { direction: 'top', offset: [0, -size / 2] })
        .addTo(this.layers.cps);
    });
    // 三大勢力大本營（不能攻打；沒有 NPC 據點時從這裡出兵），點擊顯示勢力資訊
    if (game.state.map?.source === 'generated') {
      const { FACTIONS: FX, FACTION_KEYS: FK, factionHq: hqOf } = this.cpConfig;
      FK.forEach((f) => {
        const p = hqOf(f);
        L.marker([p.lat, p.lon], {
          icon: L.divIcon({ className: '', iconSize: [96, 80], iconAnchor: [48, 28], html: `<div class="hq-pin" style="--c:${FX[f].color}"><b>🏯</b><span>${FX[f].name}大本營</span></div>` }),
          zIndexOffset: 900,
        }).on('click', () => bus.emit('ui:openHq', { f })).addTo(this.layers.cps);
      });
    }
    if (this.zoneLayer) {
      // v15：危險度圖層把不可探索的控制點區域塗黑
      this.zoneLayer.cpLocked = game.state.map?.source === 'generated' ? (i) => { const c = CONTROL_POINTS[i]; return !!c && game.cp.statusOf(c.id) !== 'mine'; } : null;
      this.zoneLayer.factionColor = (i) => {
        const c = CONTROL_POINTS[i];
        const s = c ? game.cp.statusOf(c.id) : 'neutral';
        if (s === 'faction') return FACTION_COLORS[game.cp.factionOf(c.id)] || FACTION_COLORS.red;
        return FACTION_COLORS[s] || FACTION_COLORS.neutral;
      };
      if (this.zoneLayer.mode !== 'off') this.zoneLayer.redraw();
    }
  }

  /** v14 控制點運輸隊（乙：發光物資箱＋小字倒數，淡金色虛線路線）；每秒更新位置 */
  renderConvoys(list = []) {
    if (!this.map || !this.layers.convoys) return;
    const ids = list.map((c) => c.id).join('|');
    if (ids !== this.convoyIds) {
      this.convoyIds = ids;
      this.layers.convoys.clearLayers();
      this.convoyMarks = new Map();
      list.forEach((c) => {
        L.polyline([[c.from.lat, c.from.lon], [c.to.lat, c.to.lon]], { color: '#ffd54f', weight: 1.5, dashArray: '2 6', opacity: 0.7, interactive: false }).addTo(this.layers.convoys);
        const mk = L.marker([c.lat, c.lon], { icon: this.icon('<div class="convoy-pin">📦<i></i></div>', 'shelter-icon', 24), zIndexOffset: 870 })
          .on('click', () => bus.emit('ui:openConvoy', { id: c.id }))
          .addTo(this.layers.convoys);
        this.convoyMarks.set(c.id, mk);
      });
    }
    list.forEach((c) => {
      const mk = this.convoyMarks?.get(c.id);
      if (!mk) return;
      mk.setLatLng([c.lat, c.lon]);
      const el = mk.getElement()?.querySelector('.convoy-pin i');
      if (el) el.textContent = formatDuration(c.left);
    });
  }

  renderInfected(list = [], pin = 48) {
    if (!this.map) return;
    // 位置也列入比對：附近玩家據點載入或新建時，據點會換到不重疊的位置，要跟著重畫
    const key = list.map((s) => `${s.id}:${Math.floor(s.purity)}:${s.lat.toFixed(6)},${s.lon.toFixed(6)}`).join('|');
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

  /**
   * 地下感染區（副本）入口：地裂獸口圖示＋今天的狀態。
   * @param {{id:string, name:string, lat:number, lon:number, label:string}[]} list
   */
  renderDungeons(list = [], svg = '') {
    if (!this.map) return;
    const key = list.map((d) => `${d.id}:${d.label}`).join('|');
    if (key === this.dgKey) return;
    this.dgKey = key;
    this.layers.dungeons.clearLayers();
    list.forEach((d) => {
      L.marker([d.lat, d.lon], {
        icon: L.divIcon({ html: `<div class="dg-pin"><span class="dg-pin-ic">${svg}</span><i class="dg-pin-lb">${escapeHtml(d.label)}</i></div>`, className: 'dg-pin-wrap', iconSize: [58, 48], iconAnchor: [29, 24] }),
        zIndexOffset: 870,
      }).on('click', () => bus.emit('ui:openDungeon', { id: d.id }))
        .bindTooltip(`🕳️ 地下感染區「${escapeHtml(d.name)}」・${escapeHtml(d.label)}`, { direction: 'top', offset: [0, -24] })
        .addTo(this.layers.dungeons);
    });
  }

  /** 其他玩家公開的據點（多人互動） */
  renderOthers(players = [], relationOf = () => 'neutral') {
    if (!this.map) return;
    this.layers.others.clearLayers();
    const COLORS = { hostile: '#e53935', friend: '#43a047', neutral: '#26c6da' };
    // v12：前哨站已移除；還沒更新的玩家的舊前哨站不顯示
    // v13：只顯示固定地圖範圍內的據點（範圍外的玩家上線後會搬進範圍）
    players.forEach((p) => p.bases.filter((b) => b.primary && inWorld(b.lat, b.lon)).forEach((b) => {
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
        const ll = (pts) => pts.map((q) => [q.lat, q.lon]);
        const route = (latlngs, style) => L.polyline(latlngs, { pane: 'routePane', renderer: this.routeRenderer, ...style }).addTo(this.layers.routes);
        const YELLOW = { color: '#ffd54f', weight: 3, opacity: 0.3, dashArray: '4 8', className: 'route-line' };
        const HOME = { color: '#ffab40', weight: 2.5, opacity: 0.3, dashArray: '8 6', interactive: false };
        // 連續探索：已經走過的路線（避難所 → 搜索過的地點）以灰線保留
        if (Array.isArray(ex.trail) && ex.trail.length >= 2) {
          route(ll(ex.trail), { color: '#90a4ae', weight: 2, opacity: 0.2, interactive: false });
        }
        const outPath = ex.path ? ll(ex.path) : [[from.lat, from.lon], [p.lat, p.lon]];
        // 連續探索的回程是另一條路線（從這個地點直接回避難所）
        const backPath = Array.isArray(ex.backPath) && ex.backPath.length >= 2 ? ll(ex.backPath) : null;
        if (!backPath || phase !== 'returning') route(outPath, YELLOW);
        else route(backPath, YELLOW);
        // 已搜索過的地點標上 ✓
        (ex.stops || []).forEach((id) => {
          const s = this.game.exploration.poi(id);
          if (!s || id === ex.poiId) return;
          L.marker([s.lat, s.lon], { icon: this.icon('<div class="queue-pin done">✓</div>', 'queue-icon', 22), interactive: false, zIndexOffset: 690 }).addTo(this.layers.routes);
        });
        // 探索佇列：從目前的目的地依序連到佇列中的每個地點（同樣繞開 NPC 等警戒範圍），並標上順序
        const queued = (ex.queue || []).map((id) => this.game.exploration.poi(id)).filter(Boolean);
        const chainOn = ex.kind === 'explore' && ex.chain !== false;
        if (!queued.length) {
          // 最後一站：預計回家路線（回程中已經畫成黃線）
          if (backPath && phase !== 'returning') route(backPath, HOME);
          return;
        }
        const pts = [p, ...queued];
        const line = [];
        for (let i = 0; i < pts.length - 1; i += 1) {
          const seg = this.plannedRoute(pts[i], pts[i + 1]);
          (i ? seg.slice(1) : seg).forEach((q) => line.push([q.lat, q.lon]));
        }
        route(line, { color: '#8fc3ff', weight: 3, opacity: 0.5, dashArray: '2 7', interactive: false });
        // 連續探索：預計回家路線從佇列最後一個地點畫回避難所
        if (chainOn) route(ll(this.plannedRoute(queued[queued.length - 1], sh)), HOME);
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
