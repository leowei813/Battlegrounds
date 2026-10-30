import { GAME_TITLE } from '../../config/constants.js';
import { escapeHtml } from '../../utils/dom.js';
import { formatNumber } from '../../utils/math.js';
import { btn } from '../components.js';
import { COPYRIGHT } from '../../config/legal.js';
import { APP_VERSION } from '../../config/version.js';
import { showChangelog } from '../ChangelogView.js';
import { accessGateEnabled, lockDevice } from '../../security/AccessGate.js';

const STAT_NAMES = {
  kills: '總擊殺', siegeKills: '防線擊殺', bossKills: 'Boss 擊殺', eliteKills: '精英擊殺', explorations: '探索次數',
  battlesWon: '戰鬥勝利', battlesLost: '戰鬥失敗', itemsFound: '獲得裝備', rareItems: '精良以上', legendaryItems: '稀有（橘）裝備',
  crafted: '製作次數', upgrades: '建築升級', recruits: '招募人數', researchDone: '完成研究', breaches: '防線失守', daysSurvived: '存活天數',
};

/**
 * 設定分頁：帳號與雲端存檔（立即存檔/登出/重置）、多人互動、顯示選項、統計。
 */
export class SettingsPanel {
  constructor(ui) {
    this.ui = ui;
    this.game = ui.game;
    this.cloud = ui.cloud;
    this.health = null; // null=未檢查 true/false
    this.busy = false;
  }

  /** 多人互動：公開自己的據點與探索隊伍給附近玩家 */
  renderWorld() {
    const w = this.game.world;
    if (!w?.available) {
      return '<p class="muted">此版本沒有連線伺服器，無法使用多人互動。需要設定內建伺服器或 Supabase（見 docs/06-CLOUD-SAVE.md）。</p>';
    }
    const status = { online: '🟢 已連線', offline: '🔴 無法連線', error: `❌ ${escapeHtml(w.error || '')}`, idle: '連線中…' }[w.status] || w.status;
    return `<div class="card">
      <p>在地圖上可以看見附近 5 公里內其他玩家的<b>據點</b>與<b>探索隊伍</b>（${status}・目前 ${w.others.length} 位）。</p>
      <small class="muted block">⚠️ 所有玩家的據點與探索隊伍都會公開：附近玩家會看到據點位置與你的玩家名稱「${escapeHtml(this.game.state.player.name)}」。據點是真實地圖上的建築，建議不要設在住家。</small>
    </div>
    ${this.renderRelations()}`;
  }

  /** 外交：收到的友好請求、友好與敵對玩家 */
  renderRelations() {
    const r = this.game.territory.rel;
    const reqs = Object.entries(r.requestsIn).map(([id, x]) => `<div class="row-between"><span>🤝 「${escapeHtml(x.name)}」想建立友好</span>
      <span>${btn('接受', 'relAccept', { id }, { cls: 'btn-xs btn-primary' })}${btn('拒絕', 'relDecline', { id }, { cls: 'btn-xs btn-ghost' })}</span></div>`).join('');
    const list = Object.entries(r.players).map(([id, x]) => `<div class="row-between"><span>${x.status === 'friend' ? '🤝 友好' : '⚔️ 敵對'}：${escapeHtml(x.name || '玩家')}</span>
      ${x.status === 'friend' ? btn('解除', 'relRemove', { id }, { cls: 'btn-xs btn-ghost' }) : btn('🤝 提出友好', 'relRequest', { id, name: x.name || '' }, { cls: 'btn-xs', disabled: !!r.requestsOut[id] })}</div>`).join('');
    if (!reqs && !list) return '<p class="muted">與所有玩家都是中立。點地圖上其他玩家的據點可以提出友好或發動攻擊；NPC 一律敵對。</p>';
    return `<div class="card">${reqs}${list}</div>`;
  }

  /** 帳號與雲端存檔區塊 */
  renderCloud() {
    const c = this.cloud;
    if (this.health === null) {
      this.health = 'checking';
      c.provider.health().then((ok) => { this.health = ok; this.ui.refresh(true); }, () => { this.health = false; this.ui.refresh(true); });
    }
    const server = this.health === 'checking' ? '檢查中…' : this.health ? '🟢 可連線' : '🔴 無法連線';
    const labels = {
      idle: '已連線', syncing: '同步中…', synced: '✅ 已同步', offline: '⚠️ 離線（恢復連線後自動上傳）', error: `❌ ${escapeHtml(c.error)}`, locked: '🔒 已在其他裝置繼續',
    };
    const last = c.cfg.lastSyncAt ? new Date(c.cfg.lastSyncAt).toLocaleString() : '—';
    return `
      <div class="card">
        <div class="row-between"><span>👤 帳號 <b class="account-name">${escapeHtml(c.username)}</b></span><span>${labels[c.status] || c.status}</span></div>
        <small class="muted block">進度只儲存在雲端，換裝置登入同一個帳號即可接續。伺服器：${c.provider.name}（${server}）・雲端版本 #${c.cfg.rev || 0}・上次同步 ${last}</small>
        <div class="btn-row">
          ${btn('☁️ 立即存檔', 'cloudSync', {}, { cls: 'btn-sm btn-primary', disabled: c.status === 'syncing' })}
          ${btn('🚪 登出', 'cloudLogout', {}, { cls: 'btn-sm' })}
        </div>
      </div>`;
  }

  async onCloudAction(action) {
    const c = this.cloud;
    const g = this.game;
    if (action === 'cloudSync') {
      g.save();
      const ok = await c.pushNow();
      this.ui.toastEl.show(ok ? '☁️ 已存檔到雲端' : `存檔失敗：${c.error || '請稍後再試'}`, ok ? 'success' : 'danger');
    }
    if (action === 'cloudLogout' && confirm('登出前會先把進度存到雲端。確定登出？')) {
      g.save();
      await c.pushNow();
      g.stop();
      g.resetting = true;
      c.logout();
      location.reload();
      return;
    }
    if (action === 'cloudReset' && confirm('確定刪除這個帳號的所有進度並重新開始？此動作無法復原！') && confirm('真的確定嗎？所有進度都會消失。')) {
      try {
        g.stop();
        g.resetting = true;
        await c.resetProgress();
        location.reload();
      } catch (err) {
        g.resetting = false;
        this.ui.toastEl.show(`重置失敗：${err.message}`, 'danger');
      }
      return;
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
        <small class="muted block">上次存檔：${new Date(st.lastSaveAt).toLocaleTimeString()}（自動存到雲端，離開頁面時也會存檔）</small>
      </div>
      <h3>👥 多人互動</h3>
      ${this.renderWorld()}
      <h3>帳號與存檔</h3>
      ${this.renderCloud()}
      <h3>顯示</h3>
      <label class="toggle"><input type="checkbox" data-setting="showDamage" ${st.settings.showDamage ? 'checked' : ''}> 顯示傷害數字</label>
      <h3>統計</h3>
      <div class="stat-grid">${stats}</div>
      ${accessGateEnabled() ? `<h3>通行碼</h3><div class="btn-row">${btn('🔒 鎖定此裝置（下次需重新輸入通行碼）', 'lockDevice', {}, { cls: 'btn-ghost' })}</div>` : ''}
      <h3>關於</h3>
      <div class="row-between"><span>目前版本 <span class="ver-tag">v${APP_VERSION}</span></span>${btn('📋 更新內容', 'changelog', {}, { cls: 'btn-sm' })}</div>
      <h3>危險區域</h3>
      <div class="btn-row">${btn('🗑️ 刪除進度重新開始', 'cloudReset', {}, { cls: 'btn-danger' })}</div>
      <p class="copyright left">${COPYRIGHT}</p>
      <p class="muted">${GAME_TITLE} v${APP_VERSION}・地圖資料 © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors，建築資料來自 Overpass API。</p>
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

  onAction(action, data = {}) {
    const g = this.game;
    if (action === 'changelog') {
      showChangelog(this.ui);
      return;
    }
    if (action === 'lockDevice' && confirm('鎖定後重新整理頁面需要再次輸入通行碼。確定？')) {
      g.save();
      lockDevice();
      location.reload();
      return;
    }
    if (action.startsWith('rel')) {
      const t = g.territory;
      const run = {
        relAccept: () => t.acceptFriend(data.id), relDecline: () => t.declineFriend(data.id),
        relRemove: () => t.removeFriend(data.id), relRequest: () => t.requestFriend(data.id, data.name),
      }[action];
      Promise.resolve(run?.()).then((res) => { this.ui.result(res); this.ui.refresh(true); });
      return;
    }
    if (action.startsWith('cloud')) {
      this.onCloudAction(action);
      return;
    }
  }
}
