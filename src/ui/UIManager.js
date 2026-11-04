import { formatDuration } from '../utils/math.js';
import { RESOURCES, RESOURCE_KEYS, CURRENCIES } from '../config/constants.js';
import { bus, EVT } from '../core/EventBus.js';
import { $, delegateActions, escapeHtml } from '../utils/dom.js';
import { formatNumber } from '../utils/math.js';
import { Toast } from './Toast.js';
import { Modal } from './Modal.js';
import { openSiegeResult, openRaidResult } from './SiegeResult.js';
import { progressBar, metaOf } from './components.js';
import { MapPanel } from './panels/MapPanel.js';
import { ShelterPanel } from './panels/ShelterPanel.js';
import { ExplorePanel } from './panels/ExplorePanel.js';
import { SurvivorPanel } from './panels/SurvivorPanel.js';
import { InventoryPanel } from './panels/InventoryPanel.js';
import { ResearchPanel } from './panels/ResearchPanel.js';
import { QuestPanel } from './panels/QuestPanel.js';
import { SettingsPanel } from './panels/SettingsPanel.js';
import { MarketPanel } from './panels/MarketPanel.js';
import { CLOUD_EVT } from '../cloud/CloudSync.js';
import { WORLD_EVT } from '../multiplayer/WorldSync.js';
import { APP_VERSION } from '../config/version.js';
import { showChangelog } from './ChangelogView.js';
import { ChatView } from './ChatView.js';

/** 可左右捲動的分頁列與標籤列（重畫時保留捲動位置） */
const H_SCROLL = '.sh-nav-list, .chips, .craft-kinds, .sv-tabs, .bt-wrap';

const TABS = [
  { id: 'map', icon: '🗺️', name: '地圖' },
  { id: 'shelter', icon: '🏠', name: '避難所' },
  { id: 'survivors', icon: '👥', name: '倖存者' },
  { id: 'market', icon: '🏪', name: '市場' },
  { id: 'research', icon: '🔬', name: '研究', more: true },
  { id: 'inventory', icon: '🛠️', name: '製作', more: true },
  { id: 'quests', icon: '📜', name: '任務', more: true },
  { id: 'settings', icon: '⚙️', name: '設定', more: true },
];
/** 手機版底部選單收進「更多」的分頁 */
const MORE_TABS = TABS.filter((t) => t.more).map((t) => t.id);

const DESKTOP_BP = 900;
/** 手機避難所抽屜佔畫面的比例（與 CSS 一致） */

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
    this.drawerFull = false; // 手機：抽屜展開成全螢幕
    this.shelterTab = 'overview'; // 避難所抽屜分頁
    this.lastHtml = '';

    this.panels = {
      map: new MapPanel(this),
      shelter: new ShelterPanel(this),
      explore: new ExplorePanel(this),
      survivors: new SurvivorPanel(this),
      market: new MarketPanel(this),
      inventory: new InventoryPanel(this),
      research: new ResearchPanel(this),
      quests: new QuestPanel(this),
      settings: new SettingsPanel(this),
    };
  }

  init() {
    // 網頁版顯示全部分頁；手機版只顯示前 4 個，其餘收進「更多」
    this.nav.innerHTML = `${TABS.map((t) => `
      <button class="nav-btn ${t.more ? 'nav-secondary' : ''}" data-action="tab" data-tab="${t.id}">
        <span class="nav-icon">${t.icon}</span><span class="nav-label">${t.name}</span><i class="badge" data-badge="${t.id}"></i>
      </button>`).join('')}
      <button class="nav-btn nav-more-btn" data-action="navMore" aria-expanded="false">
        <span class="nav-icon">☰</span><span class="nav-label">更多</span><i class="badge" data-badge="more"></i>
      </button>
      <div class="nav-more hidden" role="menu">${TABS.filter((t) => t.more).map((t) => `
        <button class="nav-more-item" role="menuitem" data-action="tab" data-tab="${t.id}"><span>${t.icon}</span> ${t.name}<i class="badge" data-badge="${t.id}"></i></button>`).join('')}
      </div>`;
    delegateActions(this.nav, (action, data) => {
      if (action === 'navMore') {
        this.toggleMore();
        return;
      }
      if (action === 'tab') {
        this.toggleMore(false);
        this.switchTab(data.tab);
      }
    });
    document.addEventListener('click', (e) => { if (!this.nav.contains(e.target)) this.toggleMore(false); });

    // 記錄左右捲動與觸控狀態（見 refresh）
    this.panelEl.addEventListener('scroll', (e) => {
      if (e.target === this.panelEl || !e.target.matches?.(H_SCROLL)) return;
      this.hScrollAt = Date.now();
      // 記下每一列最後的位置（依分頁與第幾列）：重畫後一律以此還原，不受慣性滑動中讀值的影響
      const list = [...this.panelEl.querySelectorAll(H_SCROLL)];
      const i = list.indexOf(e.target);
      if (i >= 0) {
        this.hScrollPos = this.hScrollPos || {};
        (this.hScrollPos[this.tab] = this.hScrollPos[this.tab] || [])[i] = e.target.scrollLeft;
      }
    }, { capture: true, passive: true });
    this.panelEl.addEventListener('touchstart', (e) => {
      if (!e.target.closest?.(H_SCROLL)) return;
      this.touching = true;
      this.touchAt = Date.now();
    }, { passive: true });
    const endTouch = () => {
      if (!this.touching) return;
      this.touching = false;
      this.hScrollAt = Date.now();
    };
    // 綁在 document：觸控中的元素被重畫移除時仍收得到
    document.addEventListener('touchend', endTouch, { passive: true });
    document.addEventListener('touchcancel', endTouch, { passive: true });
    delegateActions(this.panelEl, (action, data, el) => {
      if (action === 'toggleDrawer') {
        this.drawerCollapsed = !this.drawerCollapsed;
        if (this.drawerCollapsed) this.drawerFull = false;
        this.applyLayout();
        this.refresh(true);
        return;
      }
      if (action === 'drawerFull') {
        this.drawerFull = !this.drawerFull;
        this.drawerCollapsed = false;
        this.applyLayout();
        this.refresh(true);
        return;
      }
      if (action === 'shelterTab') {
        this.shelterTab = data.t;
        this.panelEl.scrollTop = 0;
        this.refresh(true);
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
    // 屍潮結算（天亮守住的獎勵／被突破的損失）：沒有其他視窗開著時跳出結算，否則只留在紀錄
    bus.on('siege:result', (e) => {
      if (!this.game.started || this.modal.current) return;
      openSiegeResult(this, e);
    });
    bus.on('raid:result', (e) => {
      if (!this.game.started || this.modal.current) return;
      openRaidResult(this, e);
    });
    bus.on(EVT.OPEN_POI, ({ poiId }) => this.panels.map.openPoi(poiId));
    bus.on('ui:openZombie', ({ groupId }) => this.panels.map.openZombie(groupId));
    bus.on('ui:openPlayer', ({ playerId }) => this.panels.map.openPlayer(playerId));
    bus.on('ui:openNpc', ({ npcId }) => this.panels.map.openNpc(npcId));
    bus.on('ui:openInfected', ({ id }) => this.panels.map.openInfected(id));
    bus.on('ui:openTeam', (team) => this.panels.map.openTeam(team));
    // 點避難所畫面上的設施：展開管理面板的「設施」分頁
    bus.on('ui:shelterTab', ({ tab }) => {
      this.shelterTab = tab;
      this.drawerCollapsed = false;
      this.applyLayout();
      this.refresh(true);
    });
    bus.on('npcs:changed', () => this.panels.map.renderMap(true));
    bus.on('trader:changed', () => this.refresh(true));
    bus.on('shared:changed', () => this.panels.map.renderMap());
    bus.on('relations:changed', () => this.panels.map.onWorld(this.game.world?.others || []));
    bus.on('gps:update', (gps) => {
      this.panels.map.service?.renderGps(gps);
      this.panels.map.lastOverlay = '';
      if (this.tab === 'map') this.panels.map.renderOverlay();
    });
    // GPS 偵測已移除：舊存檔開著的也關閉
    if (this.game.gps.enabled) this.game.gps.setEnabled(false);
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
    this.chatView = new ChatView(this);
    this.chatView.mount(document.querySelector('#stage'));
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

  /** 手機版「更多」選單 */
  toggleMore(open) {
    const menu = this.nav.querySelector('.nav-more');
    const btn = this.nav.querySelector('.nav-more-btn');
    if (!menu) return;
    const on = open ?? menu.classList.contains('hidden');
    menu.classList.toggle('hidden', !on);
    btn?.setAttribute('aria-expanded', String(on));
  }

  switchTab(id) {
    if (!this.panels[id]) return;
    if (this.tab === 'map' && id !== 'map') this.panels.map.onHide();
    if (this.tab !== id) this.panels[this.tab]?.onLeave?.();
    if (id !== 'map' && this.chatView?.isOpen) this.chatView.close(); // 聊天只在地圖分頁開啟
    this.tab = id;
    this.lastHtml = '';
    this.panelEl.scrollTop = 0;
    this.nav.querySelectorAll('.nav-btn, .nav-more-item').forEach((b) => b.classList.toggle('active', b.dataset.tab === id));
    this.nav.querySelector('.nav-more-btn')?.classList.toggle('active', MORE_TABS.includes(id));
    this.applyLayout();
    this.refresh(true);
    if (id === 'map') this.panels.map.onShow();
    else this.panels[id].onShow?.();
  }

  /** 依分頁與螢幕寬度切換版面，並告知 Phaser 可視區域 */
  applyLayout() {
    const desktop = window.innerWidth >= DESKTOP_BP;
    const isMap = this.tab === 'map';
    const isShelter = this.tab === 'shelter';
    this.mapRoot.classList.toggle('hidden', !isMap);
    // v9：移除避難所畫面，避難所頁只顯示面板內容（與其他頁相同的全頁面板）
    void isShelter;
    void desktop;
    this.drawerCollapsed = false;
    this.panelEl.className = `panel ${isMap ? 'hidden' : 'full'}`;
    this.phaser.registry.set('viewInset', { right: 0, bottom: 0, top: 0 });
    // 避難所場景不再顯示：暫停繪製以節省效能
    try { this.phaser.loop?.sleep?.(); } catch { /* 尚未啟動 */ }
  }

  /** 據點被當成攻擊目標時：螢幕外圍紅框＋上方閃爍「威脅接近中」 */
  renderThreat() {
    const list = this.game.threats();
    if (!this.threatEl) {
      this.threatEl = document.createElement('div');
      this.threatEl.className = 'threat-alert';
      this.threatEl.innerHTML = '<div class="threat-frame"></div><div class="threat-label">⚠️ 威脅接近中</div>';
      document.body.appendChild(this.threatEl);
    }
    const on = list.length > 0;
    this.threatEl.classList.toggle('on', on);
    // 顯示誰攻過來、預計多久抵達
    const d = on ? this.game.threatDetails()[0] : null;
    const text = d ? `⚠️ 威脅接近中：${d.text}${d.at ? `・約 ${formatDuration(d.at - Date.now())}後抵達` : ''}` : '⚠️ 威脅接近中';
    const label = this.threatEl.querySelector('.threat-label');
    if (label.textContent !== text) label.textContent = text;
    label.title = list.join('、');
  }

  refresh(force = false) {
    this.renderHud();
    this.renderThreat();
    this.modal.refreshLive();
    this.renderBadges();
    const panel = this.panels[this.tab];
    // 停在交易所的市場時，每 30 秒自動更新其他玩家的刊登
    if (this.tab === 'market' && panel.sub === 'exchange' && (panel.exForm?.view || 'market') === 'market'
      && Date.now() - (this.mkAutoAt || 0) > 30000 && this.game.market) {
      this.mkAutoAt = Date.now();
      this.game.market.refresh().then(() => this.refresh(true));
    }
    if (this.tab === 'map') {
      panel.renderOverlay();
      return;
    }
    // 正在輸入（輸入框、下拉選單有焦點）時不重新繪製，避免打斷輸入
    const active = document.activeElement;
    if (!force && active && this.panelEl.contains(active) && ['INPUT', 'SELECT', 'TEXTAREA'].includes(active.tagName)) return;
    // 手指正在滑動（或剛滑完）左右捲動的分頁列時先不重畫，避免打斷滑動
    if (this.touching && Date.now() - (this.touchAt || 0) > 8000) this.touching = false; // 保險：最多暫停 8 秒
    if (!force && (this.touching || Date.now() - (this.hScrollAt || 0) < 1200)) return;
    // 拖移排序中不重畫
    if (!force && this.dragging) return;
    const html = panel.render();
    if (!force && html === this.lastHtml) return;
    this.lastHtml = html;
    const top = this.panelEl.scrollTop;
    // 保留可左右捲動的分頁列、標籤列的位置（面板每秒重新繪製）
    const keep = [...this.panelEl.querySelectorAll(H_SCROLL)].map((el) => el.scrollLeft);
    const saved = this.hScrollTab === this.tab ? (this.hScrollPos?.[this.tab] || []) : [];
    this.panelEl.innerHTML = html;
    this.panelEl.scrollTop = top;
    if (this.hScrollTab === this.tab) {
      this.panelEl.querySelectorAll(H_SCROLL).forEach((el, i) => {
        const x = saved[i] ?? keep[i];
        if (x) el.scrollLeft = x;
      });
    } else if (this.hScrollPos) delete this.hScrollPos[this.tab];
    this.hScrollTab = this.tab;
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
          <div><b>${g.time.dateText()} ${g.time.clockText()}</b><small>${phase.name}・生存第 ${g.time.survivalDay()} 天</small></div>
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
    };
    counts.more = MORE_TABS.reduce((s, id) => s + (counts[id] || 0), 0);
    // 研究：閒置時亮紅色「閒置」，研究中顯示剩餘時間
    const rs = this.researchBadge();
    // 市場：刊登中的總筆數（藍色，只顯示數量）
    const mk = this.panels.market?.listingCount() || 0;
    this.nav.querySelectorAll('[data-badge]').forEach((el) => {
      const key = el.dataset.badge;
      if (key === 'market') {
        el.textContent = mk ? String(Math.min(999, mk)) : '';
        el.classList.toggle('on', mk > 0);
        el.classList.add('badge-info');
        return;
      }
      const n = counts[key] || 0;
      const text = key === 'research' || (key === 'more' && !n) ? rs?.text : null;
      el.textContent = text || (n ? String(n) : '');
      el.classList.toggle('on', !!text || n > 0);
      el.classList.toggle('badge-info', !!text && rs.kind === 'busy');
    });
  }

  /** 研究狀態徽章：研究中心閒置 → 閒置；研究中 → 剩餘時間 */
  researchBadge() {
    const g = this.game;
    if (!g.research.labLevel()) return null;
    const a = g.state.research.active;
    if (!a) return { kind: 'idle', text: '閒置' };
    const left = Math.max(0, a.endAt - Date.now());
    const min = Math.ceil(left / 60000);
    return { kind: 'busy', text: min >= 60 ? `${Math.floor(min / 60)}時` : `${min}分` };
  }

  showRates() {
    const { gross, upkeep, net } = this.game.resources.rates();
    const rows = Object.keys(net).map((k) => `<tr><td>${metaOf(k).icon} ${metaOf(k).name}</td><td>+${gross[k].toFixed(1)}</td><td>-${upkeep[k].toFixed(1)}</td><td class="${net[k] < 0 ? 'neg' : 'pos'}">${net[k].toFixed(1)}</td></tr>`).join('');
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
