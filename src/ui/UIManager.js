import { RESOURCES, RESOURCE_KEYS, CURRENCIES } from '../config/constants.js';
import { bus, EVT } from '../core/EventBus.js';
import { $, delegateActions, escapeHtml } from '../utils/dom.js';
import { formatNumber } from '../utils/math.js';
import { Toast } from './Toast.js';
import { Modal } from './Modal.js';
import { progressBar } from './components.js';
import { MapPanel } from './panels/MapPanel.js';
import { ShelterPanel } from './panels/ShelterPanel.js';
import { ExplorePanel } from './panels/ExplorePanel.js';
import { SurvivorPanel } from './panels/SurvivorPanel.js';
import { InventoryPanel } from './panels/InventoryPanel.js';
import { ResearchPanel } from './panels/ResearchPanel.js';
import { QuestPanel } from './panels/QuestPanel.js';
import { SettingsPanel } from './panels/SettingsPanel.js';
import { CLOUD_EVT } from '../cloud/CloudSync.js';
import { WORLD_EVT } from '../multiplayer/WorldSync.js';
import { APP_VERSION } from '../config/version.js';
import { showChangelog } from './ChangelogView.js';

const TABS = [
  { id: 'map', icon: '🗺️', name: '地圖' },
  { id: 'shelter', icon: '🏠', name: '避難所' },
  { id: 'explore', icon: '🧭', name: '探索' },
  { id: 'survivors', icon: '👥', name: '倖存者' },
  { id: 'inventory', icon: '🛠️', name: '製作' },
  { id: 'research', icon: '🔬', name: '研究' },
  { id: 'quests', icon: '📜', name: '任務' },
  { id: 'settings', icon: '⚙️', name: '設定' },
];

const DESKTOP_BP = 900;
const DRAWER_W = 400;

/**
 * UI 總管：HUD、導覽列、分頁切換、面板渲染、彈窗與通知。
 * 面板為無狀態的「state → HTML」函式物件，操作透過 data-action 委派回面板。
 */
export class UIManager {
  /**
   * @param {import('../core/Game.js').Game} game
   * @param {Phaser.Game} phaser
   * @param {import('../cloud/CloudSync.js').CloudSync} cloud
   */
  constructor(game, phaser, cloud) {
    this.game = game;
    this.phaser = phaser;
    this.cloud = cloud;
    this.hud = $('#hud');
    this.nav = $('#nav');
    this.panelEl = $('#panel');
    this.mapRoot = $('#map-root');
    this.toastEl = new Toast($('#toasts'));
    this.modal = new Modal($('#modal-root'));
    this.modal.onAnyAction = () => this.game.requestSave(); // 彈窗內的操作也立即存檔
    this.tab = 'shelter';
    this.viewBaseId = null; // 避難所分頁目前檢視的據點（null = 主要據點）
    this.drawerCollapsed = false;
    this.lastHtml = '';

    this.panels = {
      map: new MapPanel(this),
      shelter: new ShelterPanel(this),
      explore: new ExplorePanel(this),
      survivors: new SurvivorPanel(this),
      inventory: new InventoryPanel(this),
      research: new ResearchPanel(this),
      quests: new QuestPanel(this),
      settings: new SettingsPanel(this),
    };
  }

  init() {
    this.nav.innerHTML = TABS.map((t) => `
      <button class="nav-btn" data-action="tab" data-tab="${t.id}">
        <span class="nav-icon">${t.icon}</span><span class="nav-label">${t.name}</span><i class="badge" data-badge="${t.id}"></i>
      </button>`).join('');
    delegateActions(this.nav, (action, data) => { if (action === 'tab') this.switchTab(data.tab); });

    delegateActions(this.panelEl, (action, data, el) => {
      if (action === 'toggleDrawer') {
        this.drawerCollapsed = !this.drawerCollapsed;
        this.applyLayout();
        return;
      }
      this.panels[this.tab].onAction?.(action, data, el);
      this.game.requestSave(); // 任何操作都立即存檔
    });
    delegateActions(this.hud, (action) => {
      if (action === 'openSettings') this.switchTab('settings');
      if (action === 'openRates') this.showRates();
      if (action === 'openCloud') this.switchTab('settings');
      if (action === 'openCiv') this.switchTab('shelter');
      if (action === 'openSurvivors') this.switchTab('survivors');
      if (action === 'openChangelog') showChangelog(this);
    });

    bus.on(EVT.TOAST, ({ msg, type }) => this.toastEl.show(msg, type));
    bus.on(EVT.STATE_CHANGED, () => this.refresh());
    bus.on(EVT.OPEN_SLOT, ({ slot }) => this.panels.shelter.openSlot(slot));
    bus.on(EVT.OPEN_POI, ({ poiId }) => this.panels.map.openPoi(poiId));
    bus.on('ui:openZombie', ({ groupId }) => this.panels.map.openZombie(groupId));
    bus.on('ui:openPlayer', ({ playerId }) => this.panels.map.openPlayer(playerId));
    bus.on('ui:openNpc', ({ npcId }) => this.panels.map.openNpc(npcId));
    bus.on('npcs:changed', () => this.panels.map.renderMap(true));
    bus.on(WORLD_EVT, (players) => this.panels.map.onWorld(players));
    bus.on(EVT.MAP_CHANGED, () => this.panels.map.renderMap(true));
    bus.on('expedition:done', () => this.panels.map.renderMap(true));
    window.addEventListener('resize', () => this.applyLayout());
    bus.on(CLOUD_EVT.STATUS, () => this.renderHud());
    bus.on(CLOUD_EVT.LOCKED, (meta) => this.showCloudLock(meta));

    bus.on('shelter:changed', () => {
      this.phaser.registry.set('viewBaseId', this.viewBase()?.id || null);
    });
    this.phaser.registry.set('viewBaseId', this.viewBase()?.id || null);
    this.panels.map.init();
    this.switchTab(this.game.shelter.hasShelter() ? 'shelter' : 'map');
  }

  /** 目前檢視的據點（不存在時回到主要據點） */
  viewBase() {
    return this.game.shelter.base(this.viewBaseId) || this.game.shelter.primary() || this.game.state.bases[0] || null;
  }

  setViewBase(id) {
    this.viewBaseId = id;
    this.phaser.registry.set('viewBaseId', this.viewBase()?.id || null);
    this.refresh(true);
  }

  switchTab(id) {
    if (!this.panels[id]) return;
    if (this.tab === 'map' && id !== 'map') this.panels.map.onHide();
    this.tab = id;
    this.lastHtml = '';
    this.panelEl.scrollTop = 0;
    this.nav.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === id));
    this.applyLayout();
    this.refresh(true);
    if (id === 'map') this.panels.map.onShow();
  }

  /** 依分頁與螢幕寬度切換版面，並告知 Phaser 可視區域 */
  applyLayout() {
    const desktop = window.innerWidth >= DESKTOP_BP;
    const isMap = this.tab === 'map';
    const isShelter = this.tab === 'shelter';
    this.mapRoot.classList.toggle('hidden', !isMap);
    this.panelEl.className = `panel ${isMap ? 'hidden' : isShelter ? 'drawer' : 'full'} ${this.drawerCollapsed ? 'collapsed' : ''}`;
    let inset = { right: 0, bottom: 0, top: 0 };
    if (isShelter && !this.drawerCollapsed) {
      inset = desktop ? { right: DRAWER_W, bottom: 0, top: 0 } : { right: 0, bottom: Math.round(window.innerHeight * 0.42), top: 0 };
    }
    this.phaser.registry.set('viewInset', inset);
  }

  refresh(force = false) {
    this.renderHud();
    this.modal.refreshLive();
    this.renderBadges();
    const panel = this.panels[this.tab];
    if (this.tab === 'map') {
      panel.renderOverlay();
      return;
    }
    const html = panel.render();
    if (!force && html === this.lastHtml) return;
    this.lastHtml = html;
    const top = this.panelEl.scrollTop;
    this.panelEl.innerHTML = html;
    this.panelEl.scrollTop = top;
    panel.afterRender?.(this.panelEl);
  }

  renderHud() {
    const g = this.game;
    const st = g.state;
    const { net } = g.resources.rates();
    const cap = g.resources.storageCap();
    const phase = g.time.phase();
    const res = RESOURCE_KEYS.map((k) => {
      // 右上角顯示總數量：倉庫 + 所有隊員背包
      const v = st.resources[k];
      const carried = g.survivors.carried(k);
      const r = net[k];
      const full = v >= cap;
      return `<div class="res ${full ? 'full' : ''} ${v < 1 && r < 0 ? 'empty' : ''}" title="${RESOURCES[k].name}：總計 ${Math.floor(v + carried)}（倉庫 ${Math.floor(v)}/${cap}、隊員攜帶 ${Math.floor(carried)}）・${r >= 0 ? '+' : ''}${r.toFixed(1)}/時">
        <span>${RESOURCES[k].icon}</span><b>${formatNumber(v + carried)}</b><small class="${r < 0 ? 'neg' : ''}">${r >= 0 ? '+' : ''}${formatNumber(r)}</small></div>`;
    }).join('');
    const hasBase = g.shelter.hasShelter();
    const wallRatio = hasBase ? g.shelter.wallHp() / g.shelter.wallMax() : 1;
    const tier = g.civilization.tier();
    this.hud.innerHTML = `
      <div class="hud-left">
        <div class="clock phase-${g.time.phaseId()}" title="${phase.desc}">
          <span class="phase-icon">${phase.icon}</span>
          <div><b>第 ${g.time.day()} 天 ${g.time.clockText()}</b><small>${phase.name}・${phase.desc}</small></div>
        </div>
        <div class="hud-badges">
        ${this.cloudBadge()}
        <button class="ver-badge" data-action="openChangelog" title="查看更新內容">v${APP_VERSION}</button>
        ${st.starving ? '<button class="starve-badge" data-action="openSurvivors" title="食物耗盡，人員持續扣血">🍽️ 飢餓中</button>' : ''}
        <button class="civ-badge" data-action="openCiv" title="文明度：建築、玩家等級、裝備越高，屍潮越強">${tier.icon} 文明 ${g.civilization.value()}</button>
        </div>
        <div class="wallhp" title="主要據點圍牆耐久">🧱${progressBar(wallRatio, wallRatio < 0.3 ? 'danger' : '', hasBase ? `${Math.floor(g.shelter.wallHp())}/${g.shelter.wallMax()}` : '—')}</div>
      </div>
      <div class="hud-res" data-action="openRates">${res}
        <div class="res cur" title="${CURRENCIES.coins.name}"><span>${CURRENCIES.coins.icon}</span><b>${formatNumber(st.player.coins)}</b></div>
        <div class="res cur" title="${CURRENCIES.parts.name}"><span>${CURRENCIES.parts.icon}</span><b>${formatNumber(st.player.parts)}</b></div>
      </div>`;
  }

  cloudBadge() {
    const c = this.cloud;
    if (!c?.enabled) return '';
    const map = {
      idle: ['☁️', '雲端存檔已連線'], syncing: ['🔄', '同步中…'], synced: ['☁️✓', '已同步'],
      offline: ['☁️✕', '離線：恢復連線後自動上傳（請勿關閉頁面）'], error: ['☁️!', c.error], locked: ['🔒', '存檔已在其他裝置繼續'],
    };
    const [icon, tip] = map[c.status] || map.idle;
    return `<button class="cloud-badge st-${c.status}" data-action="openCloud" title="${escapeHtml(tip)}">${icon}</button>`;
  }

  /** 其他裝置接手時顯示的鎖定畫面（不可關閉） */
  showCloudLock(meta) {
    this.modal.forceClose();
    const when = meta?.updatedAt ? new Date(meta.updatedAt).toLocaleString() : '';
    this.modal.open({
      title: '☁️ 存檔已在其他裝置繼續',
      dismissible: false,
      body: `
        <p><b>${escapeHtml(meta?.deviceName || '另一台裝置')}</b> 於 ${when} 更新了雲端存檔。</p>
        <p class="muted">為避免兩台裝置互相覆蓋進度，本裝置的遊戲已暫停。</p>
        <div class="btn-row end">
          <button class="btn btn-ghost" data-action="takeover">📲 在此裝置接管</button>
          <button class="btn btn-primary" data-action="reload">🔄 載入最新進度</button>
        </div>`,
      onAction: async (action, _data, m, el) => {
        if (action === 'reload') location.reload();
        if (action === 'takeover') {
          if (!confirm('接管會用「本裝置的進度」覆蓋雲端，另一台裝置的新進度將會遺失。確定？')) return;
          el.disabled = true;
          try {
            await this.cloud.takeover();
            location.reload();
          } catch (err) {
            el.disabled = false;
            this.toastEl.show(`接管失敗：${err.message}`, 'danger');
          }
        }
        void m;
      },
    });
  }

  renderBadges() {
    const g = this.game;
    const counts = {
      quests: g.quests.claimableCount(),
      survivors: g.state.recruitPool.length,
      explore: g.state.expeditions.length,
    };
    this.nav.querySelectorAll('[data-badge]').forEach((el) => {
      const n = counts[el.dataset.badge] || 0;
      el.textContent = n ? String(n) : '';
      el.classList.toggle('on', n > 0);
    });
  }

  showRates() {
    const { gross, upkeep, net } = this.game.resources.rates();
    const rows = RESOURCE_KEYS.map((k) => `<tr><td>${RESOURCES[k].icon} ${RESOURCES[k].name}</td><td>+${gross[k].toFixed(1)}</td><td>-${upkeep[k].toFixed(1)}</td><td class="${net[k] < 0 ? 'neg' : 'pos'}">${net[k].toFixed(1)}</td></tr>`).join('');
    this.modal.open({
      title: '📊 每小時產出',
      body: `<table class="table"><thead><tr><th>資源</th><th>產出</th><th>消耗</th><th>淨值</th></tr></thead><tbody>${rows}</tbody></table>
        <p class="muted">資源上限：${this.game.resources.storageCap()}（升級倉庫提高）。離線最多累積 24 小時收益。</p>`,
    });
  }

  /** 統一處理操作結果 */
  result(res, successMsg) {
    if (!res) return res;
    if (res.ok) {
      if (res.msg || successMsg) this.toastEl.show(res.msg || successMsg, 'success');
    } else if (res.reason) {
      this.toastEl.show(res.reason, 'danger');
    }
    this.game.changed();
    return res;
  }

  escape(s) {
    return escapeHtml(s);
  }
}
