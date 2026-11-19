/**
 * 共用世界物件（NPC 狀態、夜晚殭屍群擊倒紀錄、黑市售出紀錄、交易市場、重度感染據點、集結）。
 * 伺服器以版本號做「先到先得」寫入：版本不符時回傳最新資料，這裡自動用最新資料重算再寫一次，
 * 因此兩人同時購買同一項商品時只有一人成功，不會重複結算。
 * 沒有伺服器（單機、測試）時使用本機記憶體，行為相同。
 */
import { WORLD_CENTER } from '../config/world.js';

const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
/** 物件在伺服器保留多久沒更新就清除 */
export const OBJ_KEEP_MS = 14 * 24 * 3600 * 1000;
/** 伺服器每種物件最多回傳的數量；回傳數達到上限時代表結果被截斷 */
export const OBJ_LIST_LIMIT = 500;
/** v17.3.3：伺服器一次查詢最多幾種物件（Supabase 與自架伺服器都只取前 10 種，超過的種類不會回傳） */
export const OBJ_KINDS_PER_QUERY = 10;
/** v17.4：多久完整同步一次（其他時候只下載有變動的） */
export const FULL_SYNC_MS = 60 * 60 * 1000;
/** 只下載變動時往前多抓一點（伺服器時間誤差、同一毫秒寫入） */
export const SINCE_OVERLAP_MS = 5000;

/** 本機記憶體版本的共用物件（與伺服器相同的語意，供單機與測試使用；多個遊戲可共用同一個實例模擬多人） */
export class MemoryObjects {
  /** @param {() => Record<string, object>} [holder] 保存位置（例如存檔中的物件表；沒有則只在記憶體） */
  constructor(holder = null) {
    const mem = {};
    this.holder = holder || (() => mem);
  }

  get map() {
    const h = this.holder();
    const now = Date.now();
    return {
      get: (k) => h[k],
      set: (k, v) => { h[k] = v; },
      values: () => Object.entries(h).filter(([k, o]) => {
        if (o?.updatedAt && now - o.updatedAt > OBJ_KEEP_MS) { delete h[k]; return false; }
        return true;
      }).map(([, o]) => o),
    };
  }

  async objList(kind, lat, lon, km) {
    const dLat = km / 111.32;
    const dLon = km / (111.32 * Math.max(0.1, Math.cos((lat * Math.PI) / 180)));
    return [...this.map.values()].filter((o) => o.kind === kind
      && (o.lat == null || (Math.abs(o.lat - lat) <= dLat && Math.abs(o.lon - lon) <= dLon))).map(clone);
  }

  async objListMany(list, lat, lon) {
    const out = [];
    // 與伺服器相同：一次最多查 10 種（超過的不回傳），測試時才抓得到
    for (const { kind, km } of list.slice(0, OBJ_KINDS_PER_QUERY)) out.push(...(await this.objList(kind, lat, lon, km)));
    return out;
  }

  /** v17.4：只回傳 since 之後更新過的（與伺服器相同：一次最多 20 種） */
  async objListSince(list, lat, lon) {
    const out = [];
    for (const { kind, km, since } of list.slice(0, 20)) out.push(...(await this.objList(kind, lat, lon, km)).filter((o) => (o.updatedAt || 0) > (since || 0)));
    return out;
  }

  async objPut(_from, _token, kind, id, { lat = null, lon = null, data, ver = 0 }) {
    // 與伺服器相同的檢查（種類只能 2～12 個英文小寫字母、資料 16000 位元組以內），測試時才抓得到
    if (!/^[a-z]{2,12}$/.test(kind) || !id || String(id).length > 80) return { status: 'invalid' };
    if (new TextEncoder().encode(JSON.stringify(data ?? null)).length > 16000) return { status: 'invalid' };
    const key = `${kind}:${id}`;
    const cur = this.map.get(key);
    if ((cur?.ver || 0) !== (ver || 0)) return { status: 'conflict', obj: clone(cur) || null };
    const obj = { kind, id: String(id), lat, lon, data: clone(data), ver: (ver || 0) + 1, updatedAt: Date.now() };
    this.map.set(key, obj);
    return { status: 'ok', obj: clone(obj) };
  }
}

export class SharedWorld {
  /** @param {import('../core/Game.js').Game} game */
  constructor(game) {
    this.game = game;
    this.cache = new Map();
    // 單機（沒有伺服器）時存在存檔中，重新開啟也保留
    this.local = new MemoryObjects(() => {
      const st = game.state;
      st.sharedLocal = st.sharedLocal || {};
      return st.sharedLocal;
    });
    /** 測試或單機時可指定共用的後端 */
    this.backend = null;
    /** 定期同步的種類：kind -> { km, global } */
    this.watched = new Map();
    this.listedAt = {};
    /** v17.4：每種物件已經讀到的最新更新時間（伺服器時間）；下次只下載這之後的 */
    this.cursor = {};
    this.fullAt = 0;
  }

  /** 目前使用的後端：伺服器（有登入身分時）或本機 */
  store() {
    if (this.backend) {
      let me = this.game.world?.myId;
      try { me = me || this.game.world?.identity?.().id; } catch { /* 沒有身分 */ }
      return { b: this.backend, me: me || 'local', token: 'local' };
    }
    const w = this.game.world;
    if (w?.provider?.objPut) {
      const { id, token } = w.identity();
      return { b: w.provider, me: id, token };
    }
    return { b: this.local, me: 'local', token: 'local' };
  }

  get online() {
    return !!(this.backend || this.game.world?.provider?.objPut);
  }

  key(kind, id) {
    return `${kind}:${id}`;
  }

  /** 快取中的物件資料（沒有則 null） */
  get(kind, id) {
    return this.cache.get(this.key(kind, id))?.data ?? null;
  }

  /** 快取中某種類的全部物件 */
  all(kind) {
    return [...this.cache.values()].filter((o) => o.kind === kind);
  }

  /** 設定定期同步的種類 */
  watch(kind, km = 5) {
    this.watched.set(kind, { km });
  }

  /** v13：所有玩家共用同一張固定地圖，同步範圍以地圖中心為準 */
  center() {
    return WORLD_CENTER;
  }

  /** 讀取範圍內某種類的物件並更新快取（範圍外的舊快取會移除） */
  async list(kind, km = 5, at = this.center()) {
    const { b } = this.store();
    const list = await b.objList(kind, at.lat, at.lon, km);
    this.replace([kind], list);
    return this.all(kind);
  }

  /** 沒有伺服器時：每 30 秒從本機資料同步一次（有伺服器時由 WorldSync 負責） */
  tick(now = Date.now()) {
    if (this.online || now - (this.localPollAt || 0) < 30000) return;
    this.localPollAt = now;
    this.poll();
  }

  /** 讀到的物件更新每種的游標（最新的更新時間） */
  advance(list) {
    (Array.isArray(list) ? list : []).forEach((o) => {
      if (o?.kind && Number(o.updatedAt) > (this.cursor[o.kind] || 0)) this.cursor[o.kind] = Number(o.updatedAt);
    });
  }

  /** v17.4：只下載變動：合併新的物件（不移除沒回傳的），並清掉本機超過保留期限的 */
  merge(kinds, list) {
    const now = Date.now();
    const set = new Set(kinds);
    (Array.isArray(list) ? list : []).forEach((o) => {
      if (!o || typeof o !== 'object' || !set.has(o.kind) || !o.id) return;
      const k = this.key(o.kind, o.id);
      const cur = this.cache.get(k);
      if (cur && (cur.ver || 0) > (o.ver || 0)) return;
      this.cache.set(k, o);
    });
    [...this.cache.entries()].forEach(([k, o]) => { if (set.has(o.kind) && o.updatedAt && now - o.updatedAt > OBJ_KEEP_MS) this.cache.delete(k); });
    kinds.forEach((k) => { this.listedAt[k] = now; });
    this.advance(list);
  }

  /** 同步所有定期同步的種類（WorldSync 每次同步時呼叫） */
  async poll() {
    const kinds = [...this.watched.entries()];
    const { b } = this.store();
    const now = Date.now();
    // v17.4：平常只下載有變動的；每小時（或資料庫還不支援時）完整同步一次
    if (b.objListSince && !this.sinceOff && this.fullAt && now - this.fullAt < FULL_SYNC_MS && kinds.length) {
      try {
        const at = this.center();
        for (let i = 0; i < kinds.length; i += OBJ_KINDS_PER_QUERY) {
          const part = kinds.slice(i, i + OBJ_KINDS_PER_QUERY);
          // eslint-disable-next-line no-await-in-loop
          const list = await b.objListSince(part.map(([kind, { km }]) => ({ kind, km, since: Math.max(0, (this.cursor[kind] || 0) - SINCE_OVERLAP_MS) })), at.lat, at.lon);
          if (list === null) { this.sinceOff = true; break; }
          this.merge(part.map(([k]) => k), list);
        }
        if (!this.sinceOff) {
          this.game.bus.emit('shared:changed');
          return;
        }
      } catch { /* 改用完整同步 */ }
    }
    if (b.objListMany && kinds.length) {
      // 一次查詢所有種類（減少請求數）
      try {
        const at = this.center();
        // v17.3.3：伺服器一次只回傳前 10 種，種類超過時分批查詢（以前第 11 種之後，例如屍王 wb，每次同步都被當成已刪除）
        for (let i = 0; i < kinds.length; i += OBJ_KINDS_PER_QUERY) {
          const part = kinds.slice(i, i + OBJ_KINDS_PER_QUERY);
          // eslint-disable-next-line no-await-in-loop
          const list = await b.objListMany(part.map(([kind, { km }]) => ({ kind, km })), at.lat, at.lon);
          this.replace(part.map(([k]) => k), list);
          this.advance(list);
        }
        this.fullAt = now;
      } catch { /* 下次再試 */ }
    } else {
      for (const [kind, { km }] of kinds) {
        // eslint-disable-next-line no-await-in-loop
        await this.list(kind, km).catch(() => {});
      }
    }
    this.game.bus.emit('shared:changed');
  }

  /** 以查詢結果取代這些種類的快取 */
  replace(kinds, list) {
    const now = Date.now();
    const set = new Set(kinds);
    const arr = Array.isArray(list) ? list : [];
    // 某種物件回傳數達到伺服器上限：結果被截斷（沒回傳的不代表已刪除），改為合併，不清掉已知的物件。
    // 否則每次同步都會隨機少掉一部分（例如「已搜空」的地點紀錄時有時無，地圖忽亮忽灰、自動探索一直重複出發）
    const count = {};
    arr.forEach((o) => { if (o?.kind) count[o.kind] = (count[o.kind] || 0) + 1; });
    const truncated = new Set(kinds.filter((k) => (count[k] || 0) >= OBJ_LIST_LIMIT));
    const known = new Map(this.cache);
    [...this.cache.entries()].forEach(([k, o]) => {
      if (!set.has(o.kind)) return;
      if (truncated.has(o.kind) && !(o.updatedAt && now - o.updatedAt > OBJ_KEEP_MS)) return;
      this.cache.delete(k);
    });
    arr.forEach((o) => {
      if (!o || typeof o !== 'object' || !set.has(o.kind) || !o.id) return;
      if (o.updatedAt && now - o.updatedAt > OBJ_KEEP_MS) return;
      const cur = known.get(this.key(o.kind, o.id));
      // 已知的版本比較新（剛寫入、伺服器回傳的是舊資料）時保留新的
      if (cur && (cur.ver || 0) > (o.ver || 0)) {
        this.cache.set(this.key(o.kind, o.id), cur);
        return;
      }
      this.cache.set(this.key(o.kind, o.id), o);
    });
    kinds.forEach((k) => { this.listedAt[k] = now; });
  }

  /**
   * 先到先得更新：fn(目前資料或 null) 回傳 { data, result } 寫入，或 { fail: 原因 } 放棄。
   * 版本衝突時以伺服器最新資料重算（最多 5 次）。
   * @returns {Promise<{ok:boolean, reason?:string, data?:object, result?:any}>}
   */
  async update(kind, id, fn, pos = null) {
    const { b, me, token } = this.store();
    const k = this.key(kind, id);
    let cur = this.cache.get(k) || null;
    for (let i = 0; i < 5; i += 1) {
      const out = fn(clone(cur?.data ?? null), cur);
      if (!out || out.fail) return { ok: false, reason: out?.fail || '無法更新' };
      let r;
      try {
        // eslint-disable-next-line no-await-in-loop
        r = await b.objPut(me, token, kind, id, {
          // 指定 pos 時以 pos 為準（lat 為 null＝沒有位置的全域物件，所有玩家都讀得到）
          lat: pos ? (pos.lat ?? null) : (cur?.lat ?? null), lon: pos ? (pos.lon ?? null) : (cur?.lon ?? null), data: out.data, ver: cur?.ver || 0,
        });
      } catch (err) {
        return { ok: false, reason: err?.kind === 'network' ? '無法連線到伺服器，請稍後再試' : (err?.message || '伺服器錯誤') };
      }
      if (r?.status === 'ok' && r.obj) {
        this.cache.set(k, r.obj);
        return { ok: true, data: r.obj.data, result: out.result };
      }
      if (r?.status !== 'conflict') return { ok: false, reason: '伺服器不接受這個操作' };
      cur = r.obj || null;
      if (cur) this.cache.set(k, cur);
      else this.cache.delete(k);
    }
    return { ok: false, reason: '同時有太多人操作，請再試一次' };
  }
}
