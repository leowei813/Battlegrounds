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
      <h3>存檔</h3>
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
      location.reload();
    }
  }
}
