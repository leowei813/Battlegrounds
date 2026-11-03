/**
 * 共用世界物件（NPC 狀態、夜晚殭屍群擊倒紀錄、黑市售出紀錄、交易市場、重度感染據點、集結）。
 * 伺服器以版本號做「先到先得」寫入：版本不符時回傳最新資料，這裡自動用最新資料重算再寫一次，
 * 因此兩人同時購買同一項商品時只有一人成功，不會重複結算。
 * 沒有伺服器（單機、測試）時使用本機記憶體，行為相同。
 */

const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
/** 物件在伺服器保留多久沒更新就清除 */
export const OBJ_KEEP_MS = 14 * 24 * 3600 * 1000;

/** 本機記憶體版本的共用物件（與伺服器相同的語意，供單機與測試使用；多個遊戲可共用同一個實例模擬多人） */
export class MemoryObjects {
  constructor() {
    this.map = new Map();
  }

  async objList(kind, lat, lon, km) {
    const dLat = km / 111.32;
    const dLon = km / (111.32 * Math.max(0.1, Math.cos((lat * Math.PI) / 180)));
    return [...this.map.values()].filter((o) => o.kind === kind
      && (o.lat == null || (Math.abs(o.lat - lat) <= dLat && Math.abs(o.lon - lon) <= dLon))).map(clone);
  }

  async objPut(_from, _token, kind, id, { lat = null, lon = null, data, ver = 0 }) {
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
    this.local = new MemoryObjects();
    /** 測試或單機時可指定共用的後端 */
    this.backend = null;
    /** 定期同步的種類：kind -> { km, global } */
    this.watched = new Map();
    this.listedAt = {};
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

  center() {
    const g = this.game;
    return g.shelter.primary() || g.state.map?.center || { lat: 0, lon: 0 };
  }

  /** 讀取範圍內某種類的物件並更新快取（範圍外的舊快取會移除） */
  async list(kind, km = 5, at = this.center()) {
    const { b } = this.store();
    const list = await b.objList(kind, at.lat, at.lon, km);
    const now = Date.now();
    [...this.cache.keys()].forEach((k) => { if (k.startsWith(`${kind}:`)) this.cache.delete(k); });
    (Array.isArray(list) ? list : []).forEach((o) => {
      if (!o || typeof o !== 'object' || o.kind !== kind || !o.id) return;
      if (o.updatedAt && now - o.updatedAt > OBJ_KEEP_MS) return;
      this.cache.set(this.key(kind, o.id), o);
    });
    this.listedAt[kind] = now;
    return this.all(kind);
  }

  /** 同步所有定期同步的種類（WorldSync 每次同步時呼叫） */
  async poll() {
    const kinds = [...this.watched.entries()];
    for (const [kind, { km }] of kinds) {
      // eslint-disable-next-line no-await-in-loop
      await this.list(kind, km).catch(() => {});
    }
    this.game.bus.emit('shared:changed');
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
          lat: pos?.lat ?? cur?.lat ?? null, lon: pos?.lon ?? cur?.lon ?? null, data: out.data, ver: cur?.ver || 0,
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
