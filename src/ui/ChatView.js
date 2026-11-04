import { shareCardHtml } from './ShareDialog.js';
import { escapeHtml } from '../utils/dom.js';
import { CHAT_MAX_LEN, CHAT_COOLDOWN_MS } from '../multiplayer/Chat.js';

const pad = (n) => String(n).padStart(2, '0');
function timeOf(at) {
  const d = new Date(at);
  const now = new Date();
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.toDateString() === now.toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}
function dayOf(at) {
  const d = new Date(at);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return '今天';
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return '昨天';
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** 只在內容不同時才更新，避免每半秒重畫造成手機畫面閃爍 */
function setText(el, text) {
  if (el && el.textContent !== text) el.textContent = text;
}
function setProp(el, key, value) {
  if (el && el[key] !== value) el[key] = value;
}

/** 一則訊息的 HTML */
function msgHtml(m) {
  return `
        <div class="chat-msg ${m.mine ? 'mine' : ''}" data-msg="${m.id}" data-mine="${m.mine ? 1 : 0}">
          <div class="chat-meta"><b>${m.mine ? '我' : escapeHtml(m.name)}</b> <span>${m.mine ? '' : `文明 ${m.civ}・`}${timeOf(m.at)}</span>
            ${m.mine ? '' : `<button class="chat-more" data-chat="menu" data-id="${m.id}" aria-label="更多">⋯</button>`}</div>
          ${shareCardHtml(m.text) || `<div class="chat-bubble">${escapeHtml(m.text)}</div>`}
        </div>`;
}

/**
 * 全服聊天面板：網頁版在地圖右側滑出，手機版佔滿畫面。
 * 訊息列表只在有變化時重畫，輸入框不會因為重畫而清空。
 */
export class ChatView {
  /** @param {import('./UIManager.js').UIManager} ui */
  constructor(ui) {
    this.ui = ui;
    this.game = ui.game;
    this.chat = ui.game.chat;
    this.el = null;
    this.isOpen = false;
    this.newCount = 0;
    this.lastKey = '';
    this.sheet = null; // 目前開啟的選單：{ type: 'msg', id } | { type: 'blocked' }
  }

  mount(parent) {
    const el = document.createElement('aside');
    el.className = 'chat-drawer hidden';
    el.setAttribute('aria-label', '全服聊天');
    el.innerHTML = `
      <div class="chat-head">
        <button class="btn btn-icon chat-back" data-chat="close" aria-label="返回地圖">←</button>
        <div class="chat-title"><b>全服聊天</b><small>所有玩家都看得到</small></div>
        <button class="btn btn-sm" data-chat="blocked">封鎖名單 <span data-chat-n>0</span></button>
        <button class="btn btn-icon chat-x" data-chat="close" aria-label="關閉">✕</button>
      </div>
      <div class="chat-list" role="log" aria-live="polite"></div>
      <button class="chat-new hidden" data-chat="toBottom"></button>
      <form class="chat-form">
        <div class="chat-row">
          <input class="chat-input" maxlength="${CHAT_MAX_LEN}" placeholder="說點什麼…（最多 ${CHAT_MAX_LEN} 字）" aria-label="輸入訊息" autocomplete="off" enterkeyhint="send">
          <button class="btn btn-primary chat-send" type="submit">送出</button>
        </div>
        <div class="chat-hint"><span class="chat-tip"></span><span class="chat-len">0/${CHAT_MAX_LEN}</span></div>
      </form>
      <div class="chat-sheet hidden"></div>`;
    parent.appendChild(el);
    this.el = el;
    this.list = el.querySelector('.chat-list');
    this.input = el.querySelector('.chat-input');
    this.sendBtn = el.querySelector('.chat-send');

    el.addEventListener('click', (e) => this.onClick(e));
    el.querySelector('.chat-form').addEventListener('submit', (e) => {
      e.preventDefault();
      this.send();
    });
    this.input.addEventListener('input', () => this.renderForm());
    this.list.addEventListener('scroll', () => {
      if (this.atBottom()) this.setNew(0);
    });
    // 手機：長按訊息開啟選單
    this.list.addEventListener('pointerdown', (e) => {
      const m = e.target.closest('[data-msg]');
      if (!m || m.dataset.mine === '1') return;
      clearTimeout(this.pressTimer);
      this.pressTimer = setTimeout(() => this.openSheet({ type: 'msg', id: Number(m.dataset.msg) }), 500);
    });
    ['pointerup', 'pointerleave', 'pointercancel', 'scroll'].forEach((t) => this.list.addEventListener(t, () => clearTimeout(this.pressTimer)));
    this.list.addEventListener('contextmenu', (e) => {
      if (e.target.closest('[data-msg]')) e.preventDefault();
    });

    this.game.bus.on('chat:changed', () => this.renderList());
    setInterval(() => { if (this.isOpen) this.renderForm(); }, 500);
  }

  open() {
    if (!this.el) return;
    this.isOpen = true;
    this.el.classList.remove('hidden');
    document.body.classList.add('chat-open');
    // 手機：聊天佔滿畫面，暫停並隱藏底下的地圖（地圖標記很多時，iPhone 會因繪圖記憶體不足而黑畫面、閃爍）
    this.coverMap = !window.matchMedia?.('(min-width: 900px)').matches;
    if (this.coverMap) {
      document.body.classList.add('chat-full');
      this.ui.mapCovered = true;
      this.ui.panels.map.onHide();
    }
    this.chat.setOpen(true);
    this.lastKey = '';
    this.renderList(true);
    this.renderForm();
    this.ui.panels.map.lastOverlay = '';
    this.ui.refresh(true);
    if (window.matchMedia?.('(min-width: 900px)').matches) this.input.focus();
  }

  close() {
    if (!this.el) return;
    this.isOpen = false;
    this.closeSheet();
    this.el.classList.add('hidden');
    document.body.classList.remove('chat-open');
    if (this.coverMap) {
      this.coverMap = false;
      document.body.classList.remove('chat-full');
      this.ui.mapCovered = false;
      if (this.ui.tab === 'map') this.ui.panels.map.onShow();
    }
    this.chat.setOpen(false);
    this.ui.panels.map.lastOverlay = '';
    this.ui.refresh(true);
  }

  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }

  atBottom() {
    const l = this.list;
    return l.scrollHeight - l.scrollTop - l.clientHeight < 40;
  }

  setNew(n) {
    this.newCount = n;
    const b = this.el.querySelector('.chat-new');
    b.textContent = `↓ ${n} 則新訊息`;
    b.classList.toggle('hidden', !n);
  }

  /** 重畫訊息列表；原本在最底下時保持在最底下，否則顯示「新訊息」提示 */
  renderList(force = false) {
    if (!this.el) return;
    this.el.querySelector('[data-chat-n]').textContent = this.chat.st.blocked.length;
    if (!this.isOpen) return;
    const msgs = this.chat.visible();
    const key = `${msgs.length}:${msgs[msgs.length - 1]?.id || 0}:${this.chat.st.blocked.length}:${this.chat.status}`;
    if (!force && key === this.lastKey) return;
    const prevLast = Number(this.lastKey.split(':')[1]) || 0;
    this.lastKey = key;
    const stick = force || this.atBottom();
    const ids = msgs.map((m) => m.id);
    const prev = this.renderedIds || [];
    const sameBase = !force && msgs.length && prev.length && prev.length <= ids.length
      && this.renderedBlocked === this.chat.st.blocked.length && prev.every((id, i) => ids[i] === id);
    if (sameBase && ids.length > prev.length) {
      // 只有新訊息：接在後面，不重畫整個列表（重畫 200 則在手機上會閃）
      let html = '';
      let day = this.renderedDay;
      msgs.slice(prev.length).forEach((m) => {
        const d = dayOf(m.at);
        if (d !== day) {
          day = d;
          html += `<div class="chat-day">— ${d} —</div>`;
        }
        html += msgHtml(m);
      });
      this.list.insertAdjacentHTML('beforeend', html);
      this.renderedDay = day;
    } else if (!sameBase) {
      let html = '';
      let day = '';
      msgs.forEach((m) => {
        const d = dayOf(m.at);
        if (d !== day) {
          day = d;
          html += `<div class="chat-day">— ${d} —</div>`;
        }
        html += msgHtml(m);
      });
      if (!msgs.length) {
        html = `<div class="chat-empty muted">${this.chat.online
          ? (this.chat.status === 'error' ? '聊天伺服器尚未啟用或暫時無法使用' : '還沒有人說話，打聲招呼吧！')
          : '離線中：連上伺服器後才能看到其他玩家的訊息'}</div>`;
      }
      this.list.innerHTML = html;
      this.renderedDay = day;
    }
    this.renderedIds = ids;
    this.renderedBlocked = this.chat.st.blocked.length;
    if (stick) {
      this.list.scrollTop = this.list.scrollHeight;
      this.setNew(0);
    } else {
      const added = msgs.filter((m) => m.id > prevLast && !m.mine).length;
      if (added) this.setNew(this.newCount + added);
    }
  }

  renderForm() {
    if (!this.el) return;
    const len = [...this.input.value].length;
    setText(this.el.querySelector('.chat-len'), `${len}/${CHAT_MAX_LEN}`);
    const why = this.chat.blockReason();
    const wait = this.chat.cooldown();
    const tip = this.el.querySelector('.chat-tip');
    setProp(this.input, 'disabled', !!why);
    if (why) {
      setText(tip, why);
      setProp(this.sendBtn, 'disabled', true);
      setText(this.sendBtn, '送出');
    } else if (wait > 0) {
      setText(tip, `剛送出，冷卻中・每 ${CHAT_COOLDOWN_MS / 1000} 秒最多 1 則`);
      setProp(this.sendBtn, 'disabled', true);
      setText(this.sendBtn, `${Math.ceil(wait / 1000)} 秒`);
    } else {
      setText(tip, `Enter 送出・每 ${CHAT_COOLDOWN_MS / 1000} 秒最多 1 則・保留最近 200 則`);
      setProp(this.sendBtn, 'disabled', this.sending || !this.input.value.trim());
      setText(this.sendBtn, '送出');
    }
  }

  async send() {
    const text = this.input.value;
    if (!text.trim() || this.sending) return;
    this.sending = true;
    this.renderForm();
    const r = await this.chat.send(text);
    this.sending = false;
    if (r.ok) {
      this.input.value = '';
      this.lastKey = '';
      this.renderList(true);
    } else this.toast(r.reason, 'danger');
    this.renderForm();
    this.game.requestSave?.();
  }

  openSheet(sheet) {
    this.sheet = sheet;
    const el = this.el.querySelector('.chat-sheet');
    if (sheet.type === 'msg') {
      const m = this.chat.messages.find((x) => x.id === sheet.id);
      if (!m) return this.closeSheet();
      const text = this.chat.visible().find((x) => x.id === m.id)?.text || '';
      el.innerHTML = `
        <div class="chat-sheet-box" role="menu">
          <small class="muted">${escapeHtml(m.name)}「${escapeHtml(text.length > 30 ? `${text.slice(0, 30)}…` : text)}」</small>
          <button class="btn" data-chat="copy" data-id="${m.id}">📋 複製文字</button>
          <button class="btn" data-chat="report" data-id="${m.id}">🚩 檢舉這則訊息</button>
          <button class="btn btn-danger" data-chat="block" data-id="${m.id}">🚫 封鎖 ${escapeHtml(m.name)}（不再看到他的訊息）</button>
          <button class="btn" data-chat="closeSheet">取消</button>
        </div>`;
    } else {
      const list = this.chat.st.blocked;
      el.innerHTML = `
        <div class="chat-sheet-box">
          <b>封鎖名單</b>
          ${list.length ? list.map((b) => `
            <div class="chat-blocked"><span>${escapeHtml(b.name)}</span><button class="btn btn-sm" data-chat="unblock" data-pid="${escapeHtml(b.id)}">解除封鎖</button></div>`).join('')
            : '<p class="muted">沒有封鎖任何玩家。長按（或點 ⋯）別人的訊息即可封鎖。</p>'}
          <button class="btn" data-chat="closeSheet">關閉</button>
        </div>`;
    }
    el.classList.remove('hidden');
    return null;
  }

  closeSheet() {
    this.sheet = null;
    this.el?.querySelector('.chat-sheet')?.classList.add('hidden');
  }

  toast(msg, type = 'info') {
    this.ui.toastEl.show(msg, type);
  }

  async onClick(e) {
    const t = e.target.closest('[data-chat]');
    if (!t) {
      if (e.target.classList.contains('chat-sheet')) this.closeSheet();
      return;
    }
    const act = t.dataset.chat;
    const id = Number(t.dataset.id);
    if (act === 'close') this.close();
    else if (act === 'blocked') this.openSheet({ type: 'blocked' });
    else if (act === 'closeSheet') this.closeSheet();
    else if (act === 'menu') this.openSheet({ type: 'msg', id });
    else if (act === 'toBottom') {
      this.list.scrollTop = this.list.scrollHeight;
      this.setNew(0);
    } else if (act === 'copy') {
      const text = this.chat.visible().find((x) => x.id === id)?.text || '';
      try {
        await navigator.clipboard.writeText(text);
        this.toast('已複製');
      } catch {
        this.toast('無法複製', 'danger');
      }
      this.closeSheet();
    } else if (act === 'report') {
      const r = await this.chat.report(id);
      this.toast(r.ok ? '已檢舉，被多位玩家檢舉的訊息會自動隱藏' : r.reason, r.ok ? 'info' : 'danger');
      this.closeSheet();
    } else if (act === 'block') {
      const m = this.chat.messages.find((x) => x.id === id);
      if (m && this.chat.block(m.from, m.name)) this.toast(`已封鎖 ${m.name}，可在「封鎖名單」解除`);
      this.closeSheet();
      this.game.requestSave?.();
    } else if (act === 'unblock') {
      this.chat.unblock(t.dataset.pid);
      this.openSheet({ type: 'blocked' });
      this.game.requestSave?.();
    }
  }
}
