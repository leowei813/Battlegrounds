import { SaveManager } from '../../core/SaveManager.js';
import { GAME_TITLE } from '../../config/constants.js';
import { escapeHtml } from '../../utils/dom.js';
import { formatNumber } from '../../utils/math.js';
import { btn } from '../components.js';

const STAT_NAMES = {
  kills: '總擊殺', siegeKills: '防線擊殺', bossKills: 'Boss 擊殺', eliteKills: '精英擊殺', explorations: '探索次數',
  battlesWon: '戰鬥勝利', battlesLost: '戰鬥失敗', itemsFound: '獲得裝備', rareItems: '稀有以上', legendaryItems: '傳說裝備',
  crafted: '製作次數', upgrades: '建築升級', recruits: '招募人數', researchDone: '完成研究', breaches: '防線失守', daysSurvived: '存活天數',
};

/**
 * 設定分頁：存檔管理（手動存檔/匯出/匯入/重置）、顯示選項、統計。
 */
export class SettingsPanel {
  constructor(ui) {
    this.ui = ui;
    this.game = ui.game;
    this.cloud = ui.cloud;
    this.health = null; // null=未檢查 true/false
    this.showCode = false;
    this.busy = false;
  }

  /** 雲端存檔區塊 */
  renderCloud() {
    const c = this.cloud;
    if (!c?.available) {
      return '<p class="muted">此版本未設定雲端伺服器（建置時 VITE_CLOUD_PROVIDER=none）。請參考 docs/06-CLOUD-SAVE.md。</p>';
    }
    if (this.health === null) {
      this.health = 'checking';
      c.provider.health().then((ok) => { this.health = ok; this.ui.refresh(true); }, () => { this.health = false; this.ui.refresh(true); });
    }
    const server = this.health === 'checking' ? '檢查中…' : this.health ? '🟢 可連線' : '🔴 無法連線';
    if (!c.enabled) {
      return `
        <p class="muted">啟用後會產生一組<b>同步碼</b>。在其他裝置開啟遊戲時輸入同步碼，即可接續同一份進度；遊戲開啟時會自動讀取雲端最新存檔。</p>
        <p class="muted">伺服器（${c.provider.name}）：${server}</p>
        <div class="btn-row">
          ${btn('☁️ 啟用雲端存檔', 'cloudEnable', {}, { cls: 'btn-primary', disabled: this.busy || this.health === false })}
          ${btn('🔗 輸入同步碼連結既有存檔', 'cloudLink', {}, { disabled: this.busy || this.health === false })}
        </div>`;
    }
    const labels = {
      idle: '已連線', syncing: '同步中…', synced: '✅ 已同步', offline: '⚠️ 離線（恢復連線後自動上傳）', error: `❌ ${escapeHtml(c.error)}`, locked: '🔒 已在其他裝置繼續',
    };
    const last = c.cfg.lastSyncAt ? new Date(c.cfg.lastSyncAt).toLocaleString() : '—';
    const code = this.showCode ? c.displayCode : c.displayCode.replace(/[A-Z0-9]/g, '•');
    return `
      <div class="card">
        <div class="row-between"><b>☁️ 雲端存檔</b><span>${labels[c.status] || c.status}</span></div>
        <small class="muted block">伺服器：${c.provider.name}（${server}）・雲端版本 #${c.cfg.rev || 0}・上次同步 ${last}</small>
        <div class="label">同步碼（在其他裝置輸入即可讀取存檔，請勿公開）</div>
        <div class="sync-code">${code}</div>
        <div class="btn-row">
          ${btn(this.showCode ? '🙈 隱藏' : '👁️ 顯示', 'cloudToggleCode', {}, { cls: 'btn-sm' })}
          ${btn('📋 複製同步碼', 'cloudCopy', {}, { cls: 'btn-sm' })}
          ${btn('🔄 立即同步', 'cloudSync', {}, { cls: 'btn-sm btn-primary', disabled: c.status === 'syncing' })}
          ${btn('停用（本機保留進度）', 'cloudDisable', {}, { cls: 'btn-sm btn-ghost' })}
        </div>
      </div>`;
  }

  async onCloudAction(action) {
    const c = this.cloud;
    const g = this.game;
    if (action === 'cloudToggleCode') this.showCode = !this.showCode;
    if (action === 'cloudCopy') {
      navigator.clipboard?.writeText(c.displayCode).then(
        () => this.ui.toastEl.show('已複製同步碼', 'success'),
        () => prompt('請手動複製同步碼：', c.displayCode),
      );
    }
    if (action === 'cloudSync') {
      g.save();
      const ok = await c.pushNow();
      this.ui.toastEl.show(ok ? '☁️ 已同步到雲端' : `同步失敗：${c.error || '請稍後再試'}`, ok ? 'success' : 'danger');
    }
    if (action === 'cloudDisable' && confirm('停用後此裝置不再同步（雲端資料保留，可用同步碼重新連結）。確定？')) {
      c.disable();
    }
    if (action === 'cloudEnable') {
      this.busy = true;
      this.ui.refresh(true);
      try {
        g.save();
        await c.enable(g);
        this.showCode = true;
        this.ui.modal.open({
          title: '☁️ 雲端存檔已啟用',
          body: `<p>你的同步碼：</p><div class="sync-code big">${c.displayCode}</div>
            <p class="muted">在另一台裝置開啟遊戲 → 首頁「☁️ 用同步碼讀取雲端存檔」（或 設定 → 輸入同步碼），即可接續進度。請妥善保存，擁有同步碼的人都能讀寫此存檔。</p>`,
        });
      } catch (err) {
        this.ui.toastEl.show(`啟用失敗：${err.message}`, 'danger');
      }
      this.busy = false;
    }
    if (action === 'cloudLink') {
      const code = prompt('輸入其他裝置上的同步碼：');
      if (!code) return;
      if (!confirm('連結後，本裝置目前的進度會被雲端存檔取代。確定？')) return;
      this.busy = true;
      this.ui.refresh(true);
      try {
        const { state } = await c.link(code);
        g.stop();
        g.resetting = true;
        SaveManager.save(state);
        location.reload();
        return;
      } catch (err) {
        this.ui.toastEl.show(`連結失敗：${err.message}`, 'danger');
      }
      this.busy = false;
    }
    this.ui.refresh(true);
  }

  render() {
    const st = this.game.state;
    const stats = Object.entries(STAT_NAMES).map(([k, n]) => `<div><small>${n}</small><b>${formatNumber(st.stats[k] || 0)}</b></div>`).join('');
    return `<div class="panel-inner">
      <h2>⚙️ 設定</h2>
      <div class="card">
        <b>${escapeHtml(st.player.name)}</b> 的避難所・建立於 ${new Date(st.createdAt).toLocaleString()}
        <small class="muted block">上次存檔：${new Date(st.lastSaveAt).toLocaleTimeString()}（每 30 秒自動存檔，離開頁面時也會存檔）</small>
      </div>
      <h3>雲端存檔（跨裝置）</h3>
      ${this.renderCloud()}
      <h3>本機存檔</h3>
      <div class="btn-row">
        ${btn('💾 立即存檔', 'save', {}, { cls: 'btn-primary' })}
        ${btn('📤 匯出存檔', 'export')}
        ${btn('📥 匯入存檔', 'import')}
        ${btn('🗑️ 刪除存檔重新開始', 'reset', {}, { cls: 'btn-danger' })}
      </div>
      <h3>顯示</h3>
      <label class="toggle"><input type="checkbox" data-setting="showDamage" ${st.settings.showDamage ? 'checked' : ''}> 顯示傷害數字</label>
      <h3>統計</h3>
      <div class="stat-grid">${stats}</div>
      <h3>關於</h3>
      <p class="muted">${GAME_TITLE} v1.0・地圖資料 © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors，建築資料來自 Overpass API。</p>
    </div>`;
  }

  afterRender(root) {
    root.querySelectorAll('[data-setting]').forEach((el) => {
      el.addEventListener('change', () => {
        this.game.state.settings[el.dataset.setting] = el.checked;
        this.game.changed();
      });
    });
  }

  onAction(action) {
    const g = this.game;
    if (action.startsWith('cloud')) {
      this.onCloudAction(action);
      return;
    }
    if (action === 'save') this.ui.result({ ok: g.save(), msg: '已存檔', reason: '存檔失敗（儲存空間不足？）' });
    if (action === 'export') {
      g.save();
      const str = SaveManager.exportString(g.state);
      this.ui.modal.open({
        title: '📤 匯出存檔',
        body: `<p class="muted">複製以下字串保存，可在其他裝置匯入。</p><textarea class="export" readonly>${str}</textarea>
          <div class="btn-row end">${btn('複製', 'copy', {}, { cls: 'btn-primary' })}</div>`,
        onAction: (a, d, m) => {
          if (a === 'copy') {
            const ta = m.body.querySelector('textarea');
            ta.select();
            navigator.clipboard?.writeText(str).then(() => this.ui.toastEl.show('已複製', 'success'), () => document.execCommand('copy'));
          }
        },
      });
    }
    if (action === 'import') {
      const str = prompt('貼上存檔字串（會覆蓋目前進度）：');
      if (!str) return;
      try {
        const data = SaveManager.importString(str);
        g.stop();
        g.resetting = true;
        SaveManager.save(data);
        location.reload();
      } catch (err) {
        this.ui.toastEl.show(`匯入失敗：${err.message}`, 'danger');
      }
    }
    if (action === 'reset' && confirm('確定刪除存檔？此動作無法復原！') && confirm('真的確定嗎？所有進度都會消失。')) {
      g.stop();
      g.resetting = true;
      SaveManager.wipe();
      // 同時解除雲端連結（雲端資料保留），否則重新整理後會再從雲端讀回
      this.cloud?.disable();
      location.reload();
    }
  }
}
