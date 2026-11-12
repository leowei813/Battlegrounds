import { escapeHtml } from '../utils/dom.js';
import { formatDuration } from '../utils/math.js';
import { rallyFlag } from './components.js';
import { DungeonSystem } from '../systems/DungeonSystem.js';
import { DUNGEONS, DUNGEON_KEYS } from '../config/dungeons.js';
import { openDungeon } from './DungeonView.js';

/** v15.15：地下城未報名提醒顯示時間 */
export const DG_REMIND_MS = 15000;

/** 聊天預覽顯示時間 */
export const CHAT_POP_MS = 5000;
/** 集結邀請顯示時間 */
export const RALLY_POP_MS = 8000;
/** 太舊的聊天訊息（例如剛登入讀到的歷史訊息）不跳出預覽 */
const CHAT_FRESH_MS = 3 * 60000;

/**
 * 右下角提醒（v12.1）：新的聊天訊息與好友的集結邀請，在任何分頁都看得到；點一下打開聊天或集結視窗。
 * 集結（紫）在上、聊天（藍）在下。
 */
export class NotifyStack {
  constructor(ui) {
    this.ui = ui;
    this.game = ui.game;
    this.el = document.createElement('div');
    this.el.className = 'notify-stack';
    document.body.appendChild(this.el);
    this.chatSeen = null;
    this.rallySeen = new Set();
    this.el.addEventListener('click', (e) => {
      const card = e.target.closest('.notify-card');
      if (!card) return;
      if (card.dataset.kind === 'chat') this.ui.chatView?.open();
      if (card.dataset.kind === 'rally') this.ui.panels.map.openRally(card.dataset.id);
      if (card.dataset.kind === 'dg' && DUNGEONS[card.dataset.id]) openDungeon(this.ui, card.dataset.id);
      card.remove();
    });
  }

  /** 每次重繪時檢查有沒有新的訊息或邀請 */
  tick(now = Date.now()) {
    const g = this.game;
    // 聊天：最新一則別人的未讀訊息
    const chat = g.chat;
    if (chat) {
      const seen = chat.st.seenId || 0;
      const fresh = chat.visible().filter((m) => !m.mine && m.id > seen);
      const last = fresh[fresh.length - 1];
      if (this.chatSeen == null) this.chatSeen = last?.id || 0;
      else if (last && last.id > this.chatSeen) {
        this.chatSeen = last.id;
        if (!this.ui.chatView?.isOpen && now - (last.at || now) < CHAT_FRESH_MS) {
          const more = fresh.length - 1;
          this.show('chat', '', `<span class="nc-ic">💬</span><div><b>${escapeHtml(last.name)}</b><p>${escapeHtml(String(last.text).slice(0, 60))}</p><small>全服聊天・點一下查看${more > 0 ? `（還有 ${more} 則未讀）` : ''}</small></div>`, CHAT_POP_MS);
        }
      }
    }
    this.dungeonRemind(now);
    // 集結邀請：好友剛發起、自己還沒參加
    (g.rally?.invites(now) || []).forEach((d) => {
      if (this.rallySeen.has(d.id)) return;
      this.rallySeen.add(d.id);
      this.show('rally', d.id, `<span class="nc-ic">${rallyFlag(26)}</span><div><b>好友「${escapeHtml(d.ownerName)}」發起集結</b><p>目標：${escapeHtml(d.target.name)}</p><small>${formatDuration(Math.max(0, d.departAt - now))}後出發・隊伍 ${(d.teams || []).length}/${d.maxTeams}・點一下查看並參加</small></div>`, RALLY_POP_MS);
    });
  }

  /**
   * v15.15：每天地下城開放報名後第一次開遊戲（或遊戲開著跨過 00:00）：還有副本沒報名就提醒一次（報名截止前）。
   */
  dungeonRemind(now = Date.now()) {
    const g = this.game;
    const dgs = g.dungeon;
    if (!dgs || !g.shelter?.hasShelter?.() || DungeonSystem.phase(now) !== 'signup') return;
    const day = DungeonSystem.dayKey(now);
    if (g.state.dgRemindDay === day) return;
    g.state.dgRemindDay = day;
    const left = DUNGEON_KEYS.filter((dg) => { const r = dgs.record(dg, now); return !r || r.cancelled; });
    if (!left.length) return;
    const close = DungeonSystem.times(DungeonSystem.dayStart(now)).close;
    const names = left.map((dg) => escapeHtml(DUNGEONS[dg].name)).join('、');
    this.show('dg', left[0], `<span class="nc-ic">🕳️</span><div><b>今天的地下城還沒報名（${left.length}/${DUNGEON_KEYS.length}）</b><p>${names}</p><small>${formatDuration(Math.max(0, close - now))}後截止（17:40）・點一下前往報名</small></div>`, DG_REMIND_MS);
  }

  show(kind, id, html, ms) {
    this.el.querySelectorAll(`.notify-card[data-kind="${kind}"]`).forEach((x) => x.remove());
    const card = document.createElement('button');
    card.type = 'button';
    card.className = `notify-card ${kind}`;
    card.dataset.kind = kind;
    card.dataset.id = id;
    card.innerHTML = html;
    if (kind === 'rally') this.el.prepend(card);
    else this.el.appendChild(card);
    setTimeout(() => card.remove(), ms);
  }
}
