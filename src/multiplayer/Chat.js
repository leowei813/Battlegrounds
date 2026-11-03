/**
 * 全服聊天：只有一個頻道，所有玩家都看得到。
 * 伺服器只保留最近 200 則；每位玩家每 5 秒最多 1 則、每則最多 120 字。
 * 被 3 位以上玩家檢舉的訊息會自動隱藏；封鎖只對自己有效（存在存檔中）。
 */

export const CHAT_MAX_LEN = 120;
export const CHAT_COOLDOWN_MS = 5000;
export const CHAT_KEEP = 200;
export const CHAT_HIDE_REPORTS = 3;
/** 聊天開著時多久讀一次新訊息；關閉時只更新未讀數 */
const POLL_OPEN_MS = 4000;
const POLL_CLOSED_MS = 20000;

// 常見的髒話（中英文），出現時以＊取代
const BAD_WORDS = [
  '幹你娘', '幹妳娘', '操你媽', '操你妈', '肏', '靠北', '靠杯', '機掰', '雞掰', '雞巴', '鸡巴', '王八蛋', '去死', '智障', '白癡', '白痴',
  '腦殘', '垃圾人', '婊子', '賤人', '畜生', '三小', '他媽的', '他妈的', '媽的', '你娘', '屌',
  'fuck', 'shit', 'bitch', 'cunt', 'dick', 'asshole', 'motherfucker', 'wtf', 'nigger', 'fag',
];
const BAD_RE = new RegExp(BAD_WORDS.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi');
// 網址、電子郵件、手機或電話號碼、LINE ID 等聯絡方式一律遮蔽
const URL_RE = /(https?:\/\/|www\.)\S+|[a-z0-9-]+(\.[a-z0-9-]+)*\.(com|net|org|tw|io|me|cc|xyz|top|info|app|gg|ly|co|cn|hk|jp)(\/\S*)?/gi;
const MAIL_RE = /[\w.+-]+@[\w-]+(\.[\w-]+)+/g;
const PHONE_RE = /(\+?\d[\d\s-]{6,}\d)/g;
const LINE_RE = /(line\s*(id)?\s*[:：]?\s*)[@\w.-]{3,}/gi;

/** 整理並過濾一則訊息：去除多餘空白、限制長度、遮蔽聯絡方式與髒話 */
export function cleanChat(text) {
  let s = String(text ?? '').replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202e\u2060\ufeff]/g, ' ').replace(/\s+/g, ' ').trim();
  s = [...s].slice(0, CHAT_MAX_LEN).join('');
  s = s.replace(MAIL_RE, '***').replace(URL_RE, '***').replace(LINE_RE, '$1***').replace(PHONE_RE, (m) => (m.replace(/\D/g, '').length >= 8 ? '***' : m));
  s = s.replace(BAD_RE, (m) => '＊'.repeat([...m].length));
  return s;
}

const clone = (v) => JSON.parse(JSON.stringify(v));

/** 本機記憶體版本的聊天（測試或單機模擬多人時使用，語意與伺服器相同） */
export class MemoryChat {
  constructor() {
    this.list = [];
    this.nextId = 1;
    this.reports = new Set();
    this.names = {};
  }

  async chatList(after = 0) {
    const msgs = this.list.filter((m) => m.reports < CHAT_HIDE_REPORTS);
    return {
      messages: msgs.filter((m) => m.id > after).slice(-CHAT_KEEP).map(({ reports, ...m }) => clone(m)),
      hidden: this.list.filter((m) => m.reports >= CHAT_HIDE_REPORTS).map((m) => m.id),
    };
  }

  async chatSend(from, _token, text, { name = '倖存者', civ = 0 } = {}) {
    const t = String(text || '').trim();
    if (!t || [...t].length > CHAT_MAX_LEN) return { status: 'invalid' };
    const now = Date.now();
    const last = [...this.list].reverse().find((m) => m.from === from);
    if (last && now - last.at < CHAT_COOLDOWN_MS) return { status: 'slow', waitMs: CHAT_COOLDOWN_MS - (now - last.at) };
    const msg = { id: this.nextId, from, name: this.names[from] || name, civ, text: t, at: now, reports: 0 };
    this.nextId += 1;
    this.list.push(msg);
    this.list = this.list.slice(-CHAT_KEEP);
    const { reports, ...out } = msg;
    return { status: 'ok', msg: clone(out) };
  }

  async chatReport(from, _token, id) {
    const key = `${id}:${from}`;
    const m = this.list.find((x) => x.id === id);
    if (!m || m.from === from || this.reports.has(key)) return { status: 'ok' };
    this.reports.add(key);
    m.reports += 1;
    return { status: 'ok' };
  }
}

export class ChatSystem {
  /** @param {import('../core/Game.js').Game} game */
  constructor(game) {
    this.game = game;
    this.messages = [];
    this.lastId = 0;
    /** 測試時可指定共用的後端（MemoryChat） */
    this.backend = null;
    this.open = false;
    this.status = 'idle';
    this.lastSentAt = 0;
    this.pollAt = 0;
    this.polling = false;
  }

  /** 存檔中的聊天設定：封鎖名單、已讀到哪一則 */
  get st() {
    const s = this.game.state;
    if (!s.chat || typeof s.chat !== 'object') s.chat = { blocked: [], seenId: 0 };
    if (!Array.isArray(s.chat.blocked)) s.chat.blocked = [];
    return s.chat;
  }

  /** 目前使用的後端與身分（沒有則 null：離線） */
  store() {
    const w = this.game.world;
    let id = null;
    let token = null;
    try {
      if (w?.identity) ({ id, token } = w.identity());
    } catch { /* 沒有身分 */ }
    if (this.backend) return { b: this.backend, me: id || w?.myId || 'local', token: token || 'local', local: true };
    if (w?.provider?.chatSend) return { b: w.provider, me: id, token };
    return null;
  }

  get online() {
    return !!this.store();
  }

  myId() {
    return this.store()?.me || null;
  }

  isBlocked(id) {
    return this.st.blocked.some((b) => b.id === id);
  }

  /** 顯示用的訊息（排除封鎖的玩家），文字一律再過濾一次 */
  visible() {
    return this.messages.filter((m) => !this.isBlocked(m.from)).map((m) => ({ ...m, text: cleanChat(m.text), mine: m.from === this.myId() }));
  }

  /** 未讀數（不含自己與封鎖的玩家） */
  unread() {
    const me = this.myId();
    const seen = this.st.seenId || 0;
    return this.messages.filter((m) => m.id > seen && m.from !== me && !this.isBlocked(m.from)).length;
  }

  markSeen() {
    if (this.lastId > (this.st.seenId || 0)) this.st.seenId = this.lastId;
  }

  setOpen(open) {
    this.open = !!open;
    if (this.open) {
      this.markSeen();
      this.poll();
    }
  }

  /** 由遊戲迴圈呼叫：聊天開著時 4 秒、關閉時 20 秒讀一次 */
  tick(now = Date.now()) {
    if (!this.online || this.polling) return;
    if (now - this.pollAt < (this.open ? POLL_OPEN_MS : POLL_CLOSED_MS)) return;
    this.poll();
  }

  async poll() {
    const s = this.store();
    if (!s || this.polling) return;
    this.polling = true;
    this.pollAt = Date.now();
    try {
      const r = await s.b.chatList(this.lastId);
      this.merge(r?.messages || [], r?.hidden || []);
      this.status = 'online';
    } catch (err) {
      this.status = err?.kind === 'network' ? 'offline' : 'error';
    } finally {
      this.polling = false;
    }
  }

  /** 合併新讀到的訊息（只保留最近 200 則），並移除被檢舉隱藏的訊息 */
  merge(list, hidden = []) {
    const hide = new Set(hidden.map(Number));
    const byId = new Map(this.messages.map((m) => [m.id, m]));
    let added = 0;
    (Array.isArray(list) ? list : []).forEach((m) => {
      const id = Number(m?.id);
      if (!id || byId.has(id) || typeof m.text !== 'string') return;
      byId.set(id, {
        id, from: String(m.from || ''), name: String(m.name || '倖存者').slice(0, 24), civ: Math.max(0, Math.round(Number(m.civ) || 0)),
        text: m.text, at: Number(m.at) || Date.now(),
      });
      added += 1;
    });
    this.messages = [...byId.values()].filter((m) => !hide.has(m.id)).sort((a, b) => a.id - b.id).slice(-CHAT_KEEP);
    this.lastId = Math.max(this.lastId, ...this.messages.map((m) => m.id), 0);
    if (this.open) this.markSeen();
    if (added || hide.size) this.game.bus.emit('chat:changed');
    return added;
  }

  /** 冷卻剩餘毫秒 */
  cooldown(now = Date.now()) {
    return Math.max(0, CHAT_COOLDOWN_MS - (now - this.lastSentAt));
  }

  /** 不能發言的原因（可以時回傳 null） */
  blockReason() {
    if (!this.online) return '離線中，無法使用聊天';
    if (!this.game.shelter.hasShelter()) return '建立避難所後才能發言';
    return null;
  }

  /** @returns {Promise<{ok:boolean, reason?:string}>} */
  async send(raw) {
    const why = this.blockReason();
    if (why) return { ok: false, reason: why };
    const text = cleanChat(raw);
    if (!text) return { ok: false, reason: '請輸入訊息' };
    const wait = this.cooldown();
    if (wait > 0) return { ok: false, reason: `發言太快了，請 ${Math.ceil(wait / 1000)} 秒後再試` };
    const s = this.store();
    // 伺服器以公開的據點資料辨識名字；第一次發言前先同步一次
    if (!s.local && this.game.world && !this.game.world.shared) await this.game.world.sync?.();
    let r;
    try {
      r = await s.b.chatSend(s.me, s.token, text, { name: this.game.state.player.name, civ: this.game.civilization.value() });
    } catch (err) {
      return { ok: false, reason: err?.kind === 'network' ? '無法連線到伺服器，請稍後再試' : (err?.message || '伺服器錯誤') };
    }
    if (r?.status === 'slow') {
      this.lastSentAt = Date.now() - CHAT_COOLDOWN_MS + (Number(r.waitMs) || CHAT_COOLDOWN_MS);
      return { ok: false, reason: `發言太快了，請 ${Math.ceil((Number(r.waitMs) || CHAT_COOLDOWN_MS) / 1000)} 秒後再試` };
    }
    if (r?.status !== 'ok') return { ok: false, reason: r?.status === 'forbidden' ? '身分驗證失敗，請重新整理' : '伺服器不接受這則訊息' };
    this.lastSentAt = Date.now();
    if (r.msg) this.merge([r.msg]);
    this.markSeen();
    // 補讀這段時間其他人的訊息
    this.poll();
    return { ok: true };
  }

  async report(id) {
    const s = this.store();
    const m = this.messages.find((x) => x.id === Number(id));
    if (!s || !m) return { ok: false, reason: '找不到這則訊息' };
    if (m.from === s.me) return { ok: false, reason: '不能檢舉自己的訊息' };
    try {
      await s.b.chatReport(s.me, s.token, m.id);
    } catch (err) {
      return { ok: false, reason: err?.kind === 'network' ? '無法連線到伺服器，請稍後再試' : '檢舉失敗' };
    }
    return { ok: true };
  }

  block(id, name) {
    if (!id || id === this.myId() || this.isBlocked(id)) return false;
    this.st.blocked.push({ id: String(id), name: String(name || '倖存者').slice(0, 24) });
    this.st.blocked = this.st.blocked.slice(-100);
    this.game.bus.emit('chat:changed');
    return true;
  }

  unblock(id) {
    const n = this.st.blocked.length;
    this.st.blocked = this.st.blocked.filter((b) => b.id !== id);
    if (n !== this.st.blocked.length) this.game.bus.emit('chat:changed');
    return n !== this.st.blocked.length;
  }
}
