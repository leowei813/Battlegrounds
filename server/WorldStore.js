import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** 超過此時間未更新的玩家不再出現在世界上 */
const STALE_MS = 3 * 24 * 60 * 60 * 1000;
const MAX_BASES = 5;
const MAX_TRIPS = 10;
/** 玩家之間的事件（攻擊、友好請求…） */
const EVENT_TYPES = new Set(['attack', 'friendRequest', 'friendAccept', 'friendRemove', 'intercept', 'plunder', 'tradeBuy', 'tradeEnd', 'tradeRefund', 'demandSell', 'demandPay', 'demandReturn']);
const MAX_INBOX = 50;

const num = (v, min, max) => (Number.isFinite(v) && v >= min && v <= max ? v : null);
const str = (v, len) => String(v ?? '').replace(/[\u0000-\u001f]/g, '').slice(0, len);
const point = (p) => {
  const lat = num(p?.lat, -90, 90);
  const lon = num(p?.lon, -180, 180);
  return lat == null || lon == null ? null : { lat: +lat.toFixed(6), lon: +lon.toFixed(6) };
};

/** 交易擺攤清單：最多 12 項，裝備資料限制大小 */
/** 小型 JSON 物件（超過大小就丟掉） */
function smallObj(o, max = 1024) {
  if (!o || typeof o !== 'object') return null;
  try {
    const text = JSON.stringify(o);
    return text.length <= max ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function sanitizeStall(list) {
  return (Array.isArray(list) ? list : []).slice(0, 12).map((x) => {
    const qty = num(x?.qty, 1, 999999);
    if (!x || qty == null) return null;
    const base = { id: str(x.id, 40), qty, sold: num(x.sold, 0, qty) ?? 0, price: num(x.price, 0, 100000) ?? 0 };
    if (x.item && typeof x.item === 'object') {
      const json = JSON.stringify(x.item);
      return json.length <= 1500 ? { ...base, qty: 1, item: JSON.parse(json) } : null;
    }
    return x.key ? { ...base, key: str(x.key, 20) } : null;
  }).filter(Boolean);
}

/** 驗證並清理玩家上傳的公開資料（只保留地圖顯示需要的欄位） */
export function sanitizePresence(body) {
  const bases = (Array.isArray(body?.bases) ? body.bases : []).slice(0, MAX_BASES).map((b) => {
    const p = point(b);
    return p && {
      ...p,
      name: str(b.name, 40),
      primary: !!b.primary,
      size: str(b.size, 10),
      alert: num(b.alert, 0, 500) ?? 80, // 警戒範圍（公尺）
      guards: num(b.guards, 0, 20) ?? 0, // 駐守人數
      guardLevel: num(b.guardLevel, 1, 60) ?? 1,
      wall: num(b.wall, 0, 1e6) ?? 0, // 圍牆耐久
      dps: num(b.dps, 0, 1e5) ?? 0, // 防禦設施火力
      // 屍潮狀況、正在前來攻打的隊伍、協防戰果（給友好玩家看；前端讀取時會再驗證）
      ...(b.siege && typeof b.siege === 'object' ? { siege: smallObj(b.siege) } : {}),
      ...(Array.isArray(b.raids) && b.raids.length ? { raids: b.raids.slice(0, 5).map(smallObj).filter(Boolean) } : {}),
      ...(b.assisted && typeof b.assisted === 'object' ? { assisted: smallObj(b.assisted, 2048) } : {}),
      ...(b.raidAssist && typeof b.raidAssist === 'object' ? { raidAssist: smallObj(b.raidAssist, 2048) } : {}),
    };
  }).filter(Boolean);
  if (!bases.length) return null;
  const trips = (Array.isArray(body?.trips) ? body.trips : []).slice(0, MAX_TRIPS).map((t) => {
    const from = point(t.from);
    const to = point(t.to);
    const startAt = num(t.startAt, 0, 9e15);
    const endAt = num(t.endAt, 0, 9e15);
    if (!from || !to || startAt == null || endAt == null || endAt <= startAt) return null;
    const path = (Array.isArray(t.path) ? t.path : []).slice(0, 20).map(point).filter(Boolean);
    return {
      from, to, startAt, endAt, ...(path.length >= 2 ? { path } : {}),
      travelMs: num(t.travelMs, 0, 1e9) ?? 0,
      searchMs: num(t.searchMs, 0, 1e9) ?? endAt - startAt,
      members: num(t.members, 1, 10) ?? 1,
      target: str(t.target, 40),
      id: str(t.id, 40),
      level: num(t.level, 1, 60) ?? 1,
      ...(t.defeated ? { defeated: true } : {}),
      ...(t.kind === 'trade' ? { kind: 'trade', targetId: str(t.targetId, 40), stall: sanitizeStall(t.stall) } : {}),
      ...(t.kind === 'deliver' ? { kind: 'deliver' } : {}),
      ...(t.kind === 'assist' ? { kind: 'assist' } : {}),
    };
  }).filter(Boolean);
  return {
    name: str(body.name, 16) || '倖存者',
    civ: num(body.civ, 0, 1e6) ?? 0,
    epoch: num(body.epoch, 0, 1e14) ?? 0,
    bases,
    trips,
    exchange: num(body.exchange, 0, 20) ?? 0,
    demands: (Array.isArray(body?.demands) ? body.demands : []).slice(0, 10).map((d) => {
      const qty = num(d?.qty, 1, 99999);
      return qty == null || !d?.key ? null : { id: str(d.id, 40), key: str(d.key, 20), qty, price: num(d.price, 0, 100000) ?? 0 };
    }).filter(Boolean),
    // 協防隊與防禦範圍協防
    ...(body.assist && typeof body.assist === 'object' ? { assist: smallObj(body.assist, 3072) } : {}),
    ...(body.cover && typeof body.cover === 'object' ? { cover: smallObj(body.cover) } : {}),
  };
}

/**
 * 多人世界：記錄公開分享的玩家據點與探索隊伍。
 * 記憶體保存，並在變更後延遲寫入 DATA_DIR/world.json。
 */
const CHAT_MAX_LEN = 120;
const CHAT_COOLDOWN_MS = 5000;
const CHAT_KEEP = 200;
const CHAT_HIDE_REPORTS = 3;

export class WorldStore {
  constructor(dir) {
    this.file = path.join(dir, 'world.json');
    this.players = new Map();
    try {
      JSON.parse(fs.readFileSync(this.file, 'utf8')).forEach((p) => this.players.set(p.id, p));
    } catch {
      /* 首次啟動 */
    }
  }

  persistSoon() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify([...this.players.values()]));
      fs.renameSync(tmp, this.file);
    }, 2000);
  }

  static matches(rec, token) {
    const a = Buffer.from(rec.tokenHash, 'hex');
    const b = Buffer.from(String(token || ''), 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  /** @returns {'ok'|'forbidden'|'invalid'} */
  put(id, token, body) {
    const data = sanitizePresence(body);
    if (!data) return 'invalid';
    const rec = this.players.get(id);
    if (rec && !WorldStore.matches(rec, token)) return 'forbidden';
    this.players.set(id, {
      id, tokenHash: rec?.tokenHash || token, ...data, inbox: rec?.inbox || [], updatedAt: Date.now(),
    });
    this.persistSoon();
    return 'ok';
  }

  remove(id, token) {
    const rec = this.players.get(id);
    if (!rec) return 'ok';
    if (!WorldStore.matches(rec, token)) return 'forbidden';
    this.players.delete(id);
    this.persistSoon();
    return 'ok';
  }

  /**
   * 送出事件給另一位玩家（寄件者需以自己的 token 驗證）。
   * @returns {'ok'|'forbidden'|'notfound'|'invalid'}
   */
  send(fromId, token, toId, body) {
    const from = this.players.get(fromId);
    if (!from || !WorldStore.matches(from, token)) return 'forbidden';
    const to = this.players.get(toId);
    if (!to) return 'notfound';
    const type = str(body?.type, 20);
    if (!EVENT_TYPES.has(type) || fromId === toId) return 'invalid';
    const json = body?.data && typeof body.data === 'object' ? JSON.stringify(body.data) : '{}';
    if (json.length > 2000) return 'invalid';
    const data = JSON.parse(json);
    to.inbox = [...(to.inbox || []), { from: fromId, fromName: from.name, type, data, at: Date.now() }].slice(-MAX_INBOX);
    this.persistSoon();
    return 'ok';
  }

  /** 讀取並清空自己的事件信箱 */
  take(id, token) {
    const rec = this.players.get(id);
    if (!rec) return { status: 'ok', events: [] };
    if (!WorldStore.matches(rec, token)) return { status: 'forbidden' };
    const events = rec.inbox || [];
    rec.inbox = [];
    if (events.length) this.persistSoon();
    return { status: 'ok', events };
  }

  // ================= 共用世界物件（NPC、殭屍群、黑市、市場、集結…） =================

  /** 物件存放在 objects.json；第一次使用時載入 */
  objs() {
    if (!this.objects) {
      this.objects = new Map();
      try {
        JSON.parse(fs.readFileSync(this.objFile(), 'utf8')).forEach((o) => this.objects.set(`${o.kind}:${o.id}`, o));
      } catch { /* 沒有檔案 */ }
    }
    return this.objects;
  }

  objFile() {
    return path.join(path.dirname(this.file), 'objects.json');
  }

  persistObjectsSoon() {
    clearTimeout(this.objTimer);
    this.objTimer = setTimeout(() => {
      const tmp = `${this.objFile()}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify([...this.objs().values()]));
      fs.renameSync(tmp, this.objFile());
    }, 2000);
  }

  /** 範圍內某種類的物件（lat/lon 為 null 的全域物件一律回傳） */
  objList(kind, lat, lon, km) {
    const dLat = km / 111.32;
    const dLon = km / (111.32 * Math.max(0.1, Math.cos((lat * Math.PI) / 180)));
    const out = [];
    const now = Date.now();
    this.objs().forEach((o, key) => {
      // 14 天沒有更新的物件清除
      if (now - (o.updatedAt || 0) > 14 * 24 * 3600 * 1000) {
        this.objs().delete(key);
        return;
      }
      if (o.kind !== kind) return;
      if (o.lat != null && (Math.abs(o.lat - lat) > dLat || Math.abs(o.lon - lon) > dLon)) return;
      out.push(o);
    });
    return out.slice(0, 500);
  }

  /**
   * 以版本號寫入（先到先得）：ver 必須等於目前版本（新建時為 0），否則回傳 conflict 與最新資料。
   * @returns {{status:'ok'|'conflict'|'forbidden'|'invalid', obj?:object}}
   */
  objPut(playerId, token, kind, id, body) {
    const p = this.players.get(playerId);
    if (!p || !WorldStore.matches(p, token)) return { status: 'forbidden' };
    if (!/^[a-z]{2,12}$/.test(kind) || !id || String(id).length > 80) return { status: 'invalid' };
    const json = JSON.stringify(body?.data ?? null);
    if (json.length > 16000) return { status: 'invalid' };
    const key = `${kind}:${id}`;
    const cur = this.objs().get(key);
    const ver = Number(body?.ver) || 0;
    if ((cur?.ver || 0) !== ver) return { status: 'conflict', obj: cur || null };
    const lat = Number.isFinite(body?.lat) ? body.lat : null;
    const lon = Number.isFinite(body?.lon) ? body.lon : null;
    const obj = { kind, id: String(id), lat, lon, data: JSON.parse(json), ver: ver + 1, updatedAt: Date.now() };
    this.objs().set(key, obj);
    this.persistObjectsSoon();
    return { status: 'ok', obj };
  }

  // ================= 全服聊天（單一頻道、保留最近 200 則） =================

  chatFile() {
    return path.join(path.dirname(this.file), 'chat.json');
  }

  chatData() {
    if (!this.chat) {
      this.chat = { list: [], nextId: 1, reports: {} };
      try {
        Object.assign(this.chat, JSON.parse(fs.readFileSync(this.chatFile(), 'utf8')));
      } catch { /* 沒有檔案 */ }
    }
    return this.chat;
  }

  persistChatSoon() {
    clearTimeout(this.chatTimer);
    this.chatTimer = setTimeout(() => {
      const tmp = `${this.chatFile()}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.chatData()));
      fs.renameSync(tmp, this.chatFile());
    }, 2000);
  }

  /** after 之後的訊息（不含被檢舉隱藏的），以及被隱藏的訊息編號 */
  chatList(after = 0) {
    const c = this.chatData();
    const shown = c.list.filter((m) => (m.reports || 0) < CHAT_HIDE_REPORTS);
    return {
      messages: shown.filter((m) => m.id > after).slice(-CHAT_KEEP).map(({ reports, ...m }) => m),
      hidden: c.list.filter((m) => (m.reports || 0) >= CHAT_HIDE_REPORTS).map((m) => m.id),
    };
  }

  /** @returns {{status:'ok'|'slow'|'forbidden'|'invalid', msg?:object, waitMs?:number}} */
  chatSend(fromId, token, text) {
    const p = this.players.get(fromId);
    if (!p || !WorldStore.matches(p, token)) return { status: 'forbidden' };
    const t = String(text ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!t || [...t].length > CHAT_MAX_LEN) return { status: 'invalid' };
    const c = this.chatData();
    const now = Date.now();
    const last = [...c.list].reverse().find((m) => m.from === fromId);
    if (last && now - last.at < CHAT_COOLDOWN_MS) return { status: 'slow', waitMs: CHAT_COOLDOWN_MS - (now - last.at) };
    const msg = { id: c.nextId, from: fromId, name: p.name || '倖存者', civ: p.civ || 0, text: t, at: now };
    c.nextId += 1;
    c.list.push({ ...msg, reports: 0 });
    if (c.list.length > CHAT_KEEP) {
      const drop = c.list.splice(0, c.list.length - CHAT_KEEP);
      drop.forEach((m) => { delete c.reports[m.id]; });
    }
    this.persistChatSoon();
    return { status: 'ok', msg };
  }

  /** 檢舉訊息：同一人對同一則只算一次，不能檢舉自己 */
  chatReport(fromId, token, id) {
    const p = this.players.get(fromId);
    if (!p || !WorldStore.matches(p, token)) return { status: 'forbidden' };
    const c = this.chatData();
    const m = c.list.find((x) => x.id === Number(id));
    if (!m || m.from === fromId) return { status: 'ok' };
    const by = c.reports[m.id] || (c.reports[m.id] = []);
    if (!by.includes(fromId)) {
      by.push(fromId);
      m.reports = by.length;
      this.persistChatSoon();
    }
    return { status: 'ok' };
  }

  /** 任一據點在範圍內的玩家（不含自己、不含過期資料） */
  nearby(lat, lon, km, excludeId = '') {
    const now = Date.now();
    const dLat = km / 111.32;
    const dLon = km / (111.32 * Math.max(0.1, Math.cos((lat * Math.PI) / 180)));
    const out = [];
    this.players.forEach((p) => {
      if (p.id === excludeId) return;
      if (now - p.updatedAt > STALE_MS) {
        this.players.delete(p.id);
        return;
      }
      if (!p.bases.some((b) => Math.abs(b.lat - lat) <= dLat && Math.abs(b.lon - lon) <= dLon)) return;
      const { tokenHash, inbox, ...pub } = p;
      out.push(pub);
    });
    return out.slice(0, 100);
  }
}
