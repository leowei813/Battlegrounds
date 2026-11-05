import { exchangeBody, exchangeAction, exchangeForm } from '../ExchangeDialog.js';
import { blackMarketBody, blackMarketAction, exchangePreview, exchangeReady } from '../BlackMarketView.js';

/**
 * 市場分頁（導覽列「🏪 市場」）：交易所（玩家之間的刊登）與黑市兩個分頁。
 */
export class MarketPanel {
  constructor(ui) {
    this.ui = ui;
    this.game = ui.game;
    /** 'exchange' | 'blackmarket' */
    this.sub = 'exchange';
    this.exForm = {};
  }

  /** 市場上刊登中的總筆數（含自己的；導覽列與分頁標籤顯示） */
  listingCount() {
    return this.game.market?.listings().length || 0;
  }

  onShow() {
    this.refreshData();
  }

  /** 切換到這個分頁時重新讀取共用資料 */
  refreshData() {
    const p = this.sub === 'blackmarket' ? this.game.blackMarket.refresh() : this.game.market?.refresh();
    p?.then(() => this.ui.refresh(true));
  }

  render() {
    const ui = this.ui;
    const n = this.listingCount();
    const tab = (id, label, extra = '') => `<button class="chip ${this.sub === id ? 'active' : ''}" data-action="marketSub" data-t="${id}">${label}${extra}</button>`;
    const body = this.sub === 'blackmarket' ? blackMarketBody(ui, ui.bmView) : exchangeBody(ui, this.exForm || {});
    return `<div class="market-page">
      <h3>🏪 市場</h3>
      <div class="chips market-subs">${tab('exchange', '🏪 交易所', n ? ` <span class="cnt-badge">${n}</span>` : '')}${tab('blackmarket', '🕶️ 黑市')}</div>
      ${body}
    </div>`;
  }

  onAction(action, data) {
    if (action === 'marketSub') {
      this.sub = data.t === 'blackmarket' ? 'blackmarket' : 'exchange';
      this.refreshData();
      this.ui.refresh(true);
      return;
    }
    const root = this.ui.panelEl;
    if (this.sub === 'blackmarket' && blackMarketAction(this.ui, action, data)) {
      this.ui.refresh(true);
      return;
    }
    if (this.sub === 'exchange' && exchangeAction(this.ui, action, data, root, this.exForm || {}, (f) => { this.exForm = f; })) {
      this.ui.refresh(true);
    }
  }

  /** 保留輸入中的值（面板每秒重新繪製） */
  afterRender(el) {
    if (this.boundEl === el) return;
    this.boundEl = el;
    const save = (e) => {
      if (this.ui.tab !== 'market') return;
      if (e.target.closest?.('.demand-form') || e.target.classList?.contains('d-gear-price')) this.exForm = exchangeForm(el, this.exForm || {});
      // 黑市交換：數量輸入時只更新試算（不重畫，避免打斷輸入）
      if (e.target.dataset?.role === 'bmExQty' && this.ui.bmEx) {
        // 想換到幾個（可以輸入超過材料的數量：會標紅並停用交換按鈕）
        this.ui.bmEx.get = Math.max(0, Math.floor(Number(e.target.value) || 0));
        const pv = el.querySelector('.bmx-preview');
        if (pv) pv.innerHTML = exchangePreview(this.game, this.ui.bmEx);
        const go = el.querySelector('[data-action="bmExDo"]');
        if (go) go.disabled = !exchangeReady(this.game, this.ui.bmEx);
      }
    };
    el.addEventListener('input', save);
    el.addEventListener('change', save);
  }
}
