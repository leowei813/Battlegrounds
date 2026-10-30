import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** 超過此時間未更新的玩家不再出現在世界上 */
const STALE_MS = 3 * 24 * 60 * 60 * 1000;
const MAX_BASES = 5;
const MAX_TRIPS = 10;

const num = (v, min, max) => (Number.isFinite(v) && v >= min && v <= max ? v : null);
const str = (v, len) => String(v ?? '').replace(/[\u0000-\u001f]/g, '').slice(0, len);
const point = (p) => {
  const lat = num(p?.lat, -90, 90);
  const lon = num(p?.lon, -180, 180);
  return lat == null || lon == null ? null : { lat: +lat.toFixed(6), lon: +lon.toFixed(6) };
};

/** 驗證並清理玩家上傳的公開資料（只保留地圖顯示需要的欄位） */
export function sanitizePresence(body) {
  const bases = (Array.isArray(body?.bases) ? body.bases : []).slice(0, MAX_BASES).map((b) => {
    const p = point(b);
    return p && { ...p, name: str(b.name, 40), primary: !!b.primary, size: str(b.size, 10) };
  }).filter(Boolean);
  if (!bases.length) return null;
  const trips = (Array.isArray(body?.trips) ? body.trips : []).slice(0, MAX_TRIPS).map((t) => {
    const from = point(t.from);
    const to = point(t.to);
    const startAt = num(t.startAt, 0, 9e15);
    const endAt = num(t.endAt, 0, 9e15);
    if (!from || !to || startAt == null || endAt == null || endAt <= startAt) return null;
    return {
      from, to, startAt, endAt,
      travelMs: num(t.travelMs, 0, 1e9) ?? 0,
      searchMs: num(t.searchMs, 0, 1e9) ?? endAt - startAt,
      members: num(t.members, 1, 10) ?? 1,
      target: str(t.target, 40),
    };
  }).filter(Boolean);
  return {
    name: str(body.name, 16) || '倖存者',
    civ: num(body.civ, 0, 1e6) ?? 0,
    bases,
    trips,
  };
}

/**
 * 多人世界：記錄公開分享的玩家據點與探索隊伍。
 * 記憶體保存，並在變更後延遲寫入 DATA_DIR/world.json。
 */
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
    this.players.set(id, { id, tokenHash: rec?.tokenHash || token, ...data, updatedAt: Date.now() });
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
      const { tokenHash, ...pub } = p;
      out.push(pub);
    });
    return out.slice(0, 100);
  }
}
