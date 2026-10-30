import { MapService } from '../../map/MapService.js';
import { POI_TYPES } from '../../config/poiTypes.js';
import { ALL_ENEMIES } from '../../config/enemies.js';
import { RESOURCES } from '../../config/constants.js';
import { delegateActions, escapeHtml } from '../../utils/dom.js';
import { haversine, formatDuration } from '../../utils/math.js';
import { stockOf, msToReset } from '../../systems/LootStock.js';
import { EXP_PHASES, tripProgress } from '../../systems/ExplorationSystem.js';
import { btn, costHtml } from '../components.js';
import { openTeamPicker } from '../TeamPicker.js';
import { showBattle } from '../BattleView.js';

const stars = (n) => '☠'.repeat(Math.min(7, n));

/**
 * 地圖分頁：Leaflet 地圖 + 浮動控制列，以及 POI / 殭屍群互動彈窗。
 */
export class MapPanel {
  constructor(ui) {
    this.ui = ui;
    this.game = ui.game;
    this.lastRender = 0;
    this.scanning = false;
  }

  init() {
    const root = this.ui.mapRoot;
    root.innerHTML = '<div id="map-canvas"></div><div id="map-overlay" class="map-overlay"></div>';
    this.overlay = root.querySelector('#map-overlay');
    this.service = new MapService(root.querySelector('#map-canvas'), this.game);
    const c = this.game.shelter.primary() || this.game.state.map.center;
    this.service.init(c.lat, c.lon);
    delegateActions(this.overlay, (action, data) => this.onAction(action, data));
  }

  /** 多人資料更新：重畫其他玩家據點 */
  onWorld(players) {
    this.service.renderOthers(players);
    this.lastOverlay = '';
    if (this.ui.tab === 'map') this.renderOverlay();
  }

  onShow() {
    this.service.invalidate();
    this.renderMap(true);
    this.service.setLive(true);
  }

  onHide() {
    this.service.setLive(false);
  }

  renderMap(force = false) {
    if (this.ui.tab !== 'map' && !force) return;
    this.lastRender = Date.now();
    this.service.render(this.game.state);
  }

  renderOverlay() {
    if (Date.now() - this.lastRender > 5000) this.renderMap(true);
    this.ui.mapRoot.dataset.phase = this.game.time.phaseId(); // 地圖依日夜變暗
    const st = this.game.state;
    const has = this.game.shelter.hasShelter();
    const src = { overpass: 'OpenStreetMap', generated: '程序生成（OSM 無法連線）', none: '—' }[st.map.source] || st.map.source;
    const html = `
      ${has ? '' : '<div class="map-hint">👆 點選地圖上任一建築，將它設為你的<b>避難所</b></div>'}
      <div class="map-tools">
        ${btn('🏰', 'gotoShelter', {}, { cls: 'btn-icon', disabled: !has, title: '回到避難所' })}
        ${btn(this.scanning ? '⏳' : '🔄', 'rescan', {}, { cls: 'btn-icon', disabled: this.scanning, title: '重新掃描附近建築' })}
        ${btn('🧾', 'legend', {}, { cls: 'btn-icon', title: '圖例' })}
      </div>
      ${this.siegeBanner()}
      ${this.scanning ? `<div class="scan-progress">📡 掃描建築中 ${this.scanProgress || ''}</div>` : ''}
      ${this.worldChip()}
      <div class="map-info">建築 ${st.map.pois.length}・殭屍群 ${st.map.zombieGroups.length}・資料：${src}</div>`;
    if (html !== this.lastOverlay) {
      this.lastOverlay = html;
      this.overlay.innerHTML = html;
    }
  }

  /** 多人互動狀態：附近玩家數，或提示開啟 */
  worldChip() {
    const w = this.game.world;
    if (!w?.available) return '';
    const n = w.others.length;
    const trips = w.others.reduce((s, p) => s + p.trips.filter((t) => t.endAt > Date.now()).length, 0);
    if (this.game.state.settings.shareWorld === undefined) {
      return `<button class="world-chip invite" data-action="worldSettings">👥 多人互動：附近 ${n} 位玩家・點此設定是否公開你的據點</button>`;
    }
    return `<button class="world-chip" data-action="worldSettings">👥 附近玩家 ${n}・隊伍 ${trips}${w.sharing ? '・已公開' : '・未公開'}</button>`;
  }

  /** 其他玩家資訊 */
  openPlayer(playerId) {
    const p = this.game.world?.others.find((x) => x.id === playerId);
    if (!p) return;
    const now = Date.now();
    const trips = p.trips.filter((t) => t.endAt > now);
    this.ui.modal.open({
      title: `👤 ${p.name}`,
      body: `<p>🏛️ 文明度 <b>${p.civ}</b>・據點 ${p.bases.length} 個・外出隊伍 ${trips.length} 支</p>
        <div class="pick-list">${p.bases.map((b, i) => `<button class="pick-row" data-action="fly" data-i="${i}">${b.primary ? '⭐' : '🏴'} ${escapeHtml(b.name)}</button>`).join('')}</div>
        ${trips.length ? `<div class="label">探索中</div><ul class="event-list">${trips.map((t) => `<li>${EXP_PHASES[tripProgress(t, now).phase].icon} 前往「${escapeHtml(t.target || '某處')}」・${t.members} 人・剩 ${formatDuration(t.endAt - now)}</li>`).join('')}</ul>` : ''}
        <p class="muted">其他玩家自願公開的據點與隊伍，位置每 30 秒更新。</p>`,
      onAction: (action, data, m) => {
        if (action !== 'fly') return;
        const b = p.bases[+data.i];
        m.close();
        this.service.focus(b.lat, b.lon, 17);
      },
    });
  }

  /** 今日物資（種類與數量每天 00:00 重新隨機；探索後清空） */
  stockHtml(poi) {
    const st = stockOf(poi);
    const reset = `每天 00:00 重置（${formatDuration(msToReset())}後）`;
    if (st.empty) return `<div class="muted">🕸️ 今日物資已被搜刮一空・${reset}</div>`;
    const list = Object.entries(st.resources).map(([k, v]) => `${RESOURCES[k].icon}${RESOURCES[k].name} ${v}`).join('、');
    return `<div class="muted">📦 今日物資：${list}・${reset}</div>`;
  }

  /** 各據點即時屍潮摘要；點擊可飛到該據點 */
  siegeBanner() {
    const g = this.game;
    const rows = g.state.bases.map((b) => {
      const s = g.siege.of(b.id);
      const ratio = g.shelter.wallHp(b) / g.shelter.wallMax(b);
      return { b, n: s.zombies.length, ratio };
    }).filter((r) => r.n > 0 || r.ratio < 0.999);
    if (!rows.length) return '';
    return `<div class="siege-banner">${rows.map(({ b, n, ratio }) => `
      <button class="siege-chip ${ratio < 0.3 ? 'danger' : ''}" data-action="flyTo" data-id="${b.id}">
        ${g.shelter.isPrimary(b) ? '⭐' : '🏠'} ${escapeHtml(b.name)}・🧟${n}・🧱${Math.round(ratio * 100)}%
      </button>`).join('')}</div>`;
  }

  async onAction(action, data = {}) {
    const sh = this.game.shelter.primary();
    if (action === 'gotoShelter' && sh) this.service.focus(sh.lat, sh.lon);
    if (action === 'legend') this.showLegend();
    if (action === 'worldSettings') this.ui.switchTab('settings');
    if (action === 'flyTo') {
      const b = this.game.shelter.base(data.id);
      if (b) this.service.focus(b.lat, b.lon, 17);
    }
    if (action === 'rescan') {
      if (this.scanning) return;
      this.scanning = true;
      this.scanProgress = '';
      this.renderOverlay();
      const c = sh || this.game.state.map.center;
      this.ui.toastEl.show('📡 分區掃描附近建築中，市區可能需要 30 秒～1 分鐘…', 'info', 6000);
      const r = await this.game.scanMap(c.lat, c.lon, (done, total) => {
        this.scanProgress = `${done}/${total}`;
        this.lastOverlay = '';
        this.renderOverlay();
      });
      this.scanning = false;
      this.scanProgress = '';
      this.ui.toastEl.show(`發現 ${r.count} 個地點（${r.source === 'overpass' ? 'OSM' : '程序生成'}）`, 'success');
      this.renderMap(true);
    }
  }

  showLegend() {
    const rows = Object.values(POI_TYPES).map((p) => `<div class="legend-row"><span class="poi-pin" style="--c:${p.color}">${p.icon}</span> ${p.name} <span class="danger">${stars(p.danger)}</span><small>${Object.keys(p.loot).map((k) => RESOURCES[k].icon).join('')}</small></div>`).join('');
    this.ui.modal.open({ title: '🧾 圖例', body: `${rows}<p class="muted">☠ 越多越危險；距離避難所越遠危險度越高。紅框為探索範圍。</p>` });
  }

  poiBody(poi) {
    const g = this.game;
    const pt = POI_TYPES[poi.type];
    const sh = g.shelter.primary();
    const base = g.shelter.baseAtPoi(poi.id);
    const dist = sh && !g.shelter.isPrimary(base) ? Math.round(haversine(sh.lat, sh.lon, poi.lat, poi.lon)) : null;
    const danger = g.zombies.areaDanger(poi);
    const groups = g.state.map.zombieGroups.filter((z) => z.poiId === poi.id);
    const exploring = g.state.expeditions.filter((e) => e.poiId === poi.id).length;
    const actions = [];
    let establish = '';
    if (!g.shelter.hasShelter()) {
      actions.push(btn('🏠 設為避難所', 'setShelter', {}, { cls: 'btn-primary' }));
      const z = g.shelter.sizeInfo(poi);
      establish = `<small class="muted block">🏗️ ${z.name}據點：可建造 ${z.total} 棟建築（防禦欄位 ${z.slots}）</small>`;
    }
    else if (base) {
      actions.push(btn('🏠 進入據點', 'enterShelter', {}, { cls: 'btn-primary' }));
      if (!g.shelter.isPrimary(base)) actions.push(btn('⭐ 設為主要據點', 'setPrimary', {}, { cls: 'btn-ghost' }));
    } else {
      const check = g.shelter.canEstablish(poi);
      actions.push(btn('🧭 派遣探索', 'explore', {}, { cls: 'btn-primary' }));
      actions.push(btn('🏗️ 建立新據點', 'setShelter', {}, { cls: 'btn-ghost', disabled: !check.ok, title: check.reason || '' }));
      const z = g.shelter.sizeInfo(poi);
      establish = `<small class="muted block">🏗️ ${z.name}據點：可建造 ${z.total} 棟建築（防禦欄位 ${z.slots}）</small><small class="muted block">建立據點費用：<span class="costs inline">${costHtml(g.state, g.shelter.establishCost())}</span>${check.ok ? '' : `（${check.reason}）`}</small>`;
    }
    return `
      <div class="poi-detail">
        <div class="poi-big" style="--c:${pt.color}">${pt.icon}</div>
        <div>
          <b>${pt.name}</b>${poi.osm ? ' <small class="tag">OSM</small>' : ' <small class="tag">傳聞</small>'}
          ${base ? `<div><span class="tag tag-amber">${g.shelter.isPrimary(base) ? '⭐ 主要據點' : '🏠 前哨據點'}</span> 據點危險度 <b>${g.shelter.dangerLevel(base)}</b></div>` : `<div>危險度 <span class="danger">${stars(danger)}</span> ${pt.special ? '<span class="tag tag-red">高級怪物</span>' : ''}</div>`}
          ${dist != null ? `<div class="muted">距避難所 ${dist} 公尺</div>` : ''}
          ${this.stockHtml(poi)}
          ${exploring ? `<div class="tag tag-blue">${exploring} 支隊伍探索中</div>` : ''}
        </div>
      </div>
      ${groups.length ? `<div class="label">附近殭屍</div>${groups.map((z) => `<div class="row-between"><span>${ALL_ENEMIES[z.enemyId].icon} ${g.zombies.groupLabel(z)}</span>${btn('⚔️ 攻擊', 'attack', { id: z.id }, { cls: 'btn-danger btn-sm', disabled: !g.shelter.hasShelter() })}</div>`).join('')}` : ''}
      <div class="btn-row">${actions.join('')}</div>${establish}`;
  }

  openPoi(poiId) {
    const poi = this.game.state.map.pois.find((p) => p.id === poiId);
    if (!poi) return;
    this.ui.modal.open({
      title: `${POI_TYPES[poi.type].icon} ${poi.name}`,
      body: this.poiBody(poi),
      live: () => this.poiBody(poi),
      onAction: (action, data, m) => {
        if (action === 'setShelter') {
          const r = this.ui.result(this.game.shelter.establish(poi));
          if (r.ok) {
            m.close();
            this.renderMap(true);
            this.game.zombies.refresh();
            this.ui.setViewBase(r.base.id);
            this.ui.switchTab('shelter');
          }
        } else if (action === 'setPrimary') {
          const r = this.ui.result(this.game.shelter.setPrimary(this.game.shelter.baseAtPoi(poi.id)?.id));
          if (r.ok) this.renderMap(true);
        } else if (action === 'enterShelter') {
          m.close();
          this.ui.setViewBase(this.game.shelter.baseAtPoi(poi.id)?.id);
          this.ui.switchTab('shelter');
        } else if (action === 'explore') {
          this.openExplore(poi);
        } else if (action === 'attack') {
          this.attackGroup(data.id);
        }
      },
    });
  }

  openExplore(poi) {
    const g = this.game;
    openTeamPicker(this.ui, {
      title: `🧭 探索：${poi.name}`,
      intro: `<p class="muted">${POI_TYPES[poi.type].name}・危險度 ${stars(g.zombies.areaDanger(poi))}・敵人等級約 Lv${g.zombies.areaLevel(poi)}</p>`,
      withDuration: true,
      estimate: (ids, dur) => g.exploration.actualDurationMs(poi, ids.map((id) => g.survivors.get(id)), dur),
      confirmLabel: '出發！',
      onConfirm: (ids, dur, auto) => {
        const r = this.ui.result(g.exploration.start(poi.id, ids, dur, auto));
        if (r.ok) this.renderMap(true);
        return r;
      },
    });
  }

  zombieBody(gr) {
    const e = ALL_ENEMIES[gr.enemyId];
    const sample = this.game.combat.createEnemy(gr.enemyId, gr.level, gr.elite);
    return `
      <div class="poi-detail">
        <div class="poi-big" style="--c:#b71c1c">${e.icon}</div>
        <div>
          <b>${this.game.zombies.groupLabel(gr)}</b> ${gr.boss ? '<span class="tag tag-red">BOSS</span>' : ''}
          <div class="muted">單體：生命 ${sample.maxHp}・攻擊 ${sample.atk}・防禦 ${sample.def}</div>
          <div class="muted">擊殺可得經驗、金錢、材料，並有機率掉落裝備</div>
        </div>
      </div>
      <div class="btn-row">${btn('⚔️ 派隊攻擊', 'attack', { id: gr.id }, { cls: 'btn-danger', disabled: !this.game.shelter.hasShelter() })}</div>`;
  }

  openZombie(groupId) {
    const gr = this.game.state.map.zombieGroups.find((z) => z.id === groupId);
    if (!gr) return;
    this.ui.modal.open({
      title: `${ALL_ENEMIES[gr.enemyId].icon} 殭屍群`,
      body: this.zombieBody(gr),
      onAction: (action, data) => { if (action === 'attack') this.attackGroup(data.id); },
    });
  }

  attackGroup(groupId) {
    const g = this.game;
    const gr = g.state.map.zombieGroups.find((z) => z.id === groupId);
    if (!gr) return;
    openTeamPicker(this.ui, {
      title: `⚔️ 攻擊 ${g.zombies.groupLabel(gr)}`,
      intro: '<p class="muted">戰鬥為自動進行。倒下的隊員會受傷，需要休養或使用藥品治療。</p>',
      confirmLabel: '開戰！',
      onConfirm: (ids) => {
        const r = g.zombies.attack(groupId, ids);
        if (!r.ok) return this.ui.result(r);
        g.changed();
        this.renderMap(true);
        setTimeout(() => showBattle(this.ui, r.result, r.loot, `⚔️ ${g.zombies.groupLabel(r.group)}`), 0);
        return { ok: true };
      },
    });
  }
}
