import { BASE_SIZES } from '../config/civilization.js';
import { bus } from '../core/EventBus.js';
import { sha256 } from '../utils/sha256.js';
import { uid } from '../utils/math.js';

/** 上傳／下載間隔 */
const SYNC_MS = 30000;
/** 顯示多遠範圍內的其他玩家（公里） */
export const WORLD_RADIUS_KM = 5;
export const WORLD_EVT = 'world:updated';

const finite = (v) => Number.isFinite(v);
const validPoint = (p) => p && finite(p.lat) && finite(p.lon) && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180;

/** 下載資料也要驗證（Supabase 後端不會替我們清理玩家上傳的內容） */
function cleanPlayer(p) {
  if (!p || typeof p !== 'object') return null;
  const bases = (Array.isArray(p.bases) ? p.bases : []).filter(validPoint).slice(0, 5)
    .map((b) => ({
      lat: b.lat, lon: b.lon, name: String(b.name || '').slice(0, 40), primary: !!b.primary,
      size: BASE_SIZES[b.size] ? b.size : 'medium',
      alert: finite(b.alert) ? Math.min(500, Math.max(0, b.alert)) : BASE_SIZES[b.size]?.alert || 80,
      guards: finite(b.guards) ? Math.min(20, Math.max(0, Math.round(b.guards))) : 0,
      guardLevel: finite(b.guardLevel) ? Math.min(60, Math.max(1, Math.round(b.guardLevel))) : 1,
    }));
  if (!bases.length) return null;
  const trips = (Array.isArray(p.trips) ? p.trips : []).slice(0, 10).filter((t) => validPoint(t?.from) && validPoint(t?.to)
    && finite(t.startAt) && finite(t.endAt) && t.endAt > t.startAt)
    .map((t) => ({
      from: t.from, to: t.to, startAt: t.startAt, endAt: t.endAt,
      ...(Array.isArray(t.path) && t.path.length >= 2 && t.path.every(validPoint) ? { path: t.path.slice(0, 20) } : {}),
      travelMs: finite(t.travelMs) ? t.travelMs : 0, searchMs: finite(t.searchMs) ? t.searchMs : t.endAt - t.startAt,
      members: finite(t.members) ? t.members : 1, target: String(t.target || '').slice(0, 40),
    }));
  return {
    id: String(p.id || ''), name: String(p.name || '倖存者').slice(0, 16), civ: finite(p.civ) ? p.civ : 0, bases, trips,
  };
}

/**
 * 多人互動：把自己的據點與探索隊伍公開給附近玩家，並顯示附近其他玩家。
 * 需要伺服器（內建 server/ 或 Supabase）；所有玩家一律公開。
 */
export class WorldSync {
  /**
   * @param {import('../core/Game.js').Game} game
   * @param {object|null} provider 與雲端存檔共用的後端
   */
  constructor(game, provider, cloud = null) {
    this.game = game;
    this.cloud = cloud;
    this.provider = provider?.worldNearby ? provider : null;
    this.others = [];
    this.status = this.provider ? 'idle' : 'off';
    this.lastSyncAt = 0;
    this.timer = null;
  }

  get available() {
    return !!this.provider;
  }

  /** 所有玩家一律公開據點與探索隊伍 */
  get sharing() {
    return true;
  }

  /**
   * 玩家身分：由帳號推導（同一帳號重新開始也是同一個身分，舊的據點會被取代），token 只上傳雜湊。
   * 沒有帳號時（例如測試）才使用存檔中的隨機身分。
   */
  identity() {
    const auth = this.cloud?.cfg?.auth;
    if (auth) return { id: sha256(`jdqs-world:${auth.id}`).slice(0, 32), token: sha256(`jdqs-world-token:${auth.token}`) };
    const p = this.game.state.player;
    if (!p.worldId) {
      p.worldId = sha256(uid('world')).slice(0, 32);
      p.worldSecret = sha256(`${uid('secret')}${Math.random()}`);
    }
    return { id: p.worldId, token: sha256(`jdqs-world:${p.worldSecret}`) };
  }

  /** 舊版（存檔內隨機身分）留下的公開資料：刪除後改用帳號身分 */
  async dropLegacy() {
    const p = this.game.state.player;
    if (!this.cloud?.cfg?.auth || !p.worldId || !p.worldSecret) return;
    const legacy = { id: p.worldId, token: sha256(`jdqs-world:${p.worldSecret}`) };
    await this.provider.worldDelete(legacy.id, legacy.token).catch(() => {});
    delete p.worldId;
    delete p.worldSecret;
  }

  /** 從世界上移除自己（刪除進度時） */
  async clear() {
    if (!this.provider) return;
    const { id, token } = this.identity();
    await this.provider.worldDelete(id, token).catch(() => {});
    this.shared = false;
  }

  start() {
    if (!this.provider || this.timer) return;
    this.dropLegacy().finally(() => this.sync());
    this.timer = setInterval(() => this.sync(), SYNC_MS);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  /** 自己公開的內容：據點、進行中的探索隊伍（只含地圖顯示需要的資料） */
  presence() {
    const g = this.game;
    const primary = g.shelter.primary();
    return {
      name: g.state.player.name,
      civ: g.civilization.value(),
      bases: g.state.bases.map((b) => {
        const gar = g.territory.garrison(b);
        return {
          lat: b.lat, lon: b.lon, name: b.name, primary: b === primary, size: b.size,
          alert: g.territory.alertRadius(b), guards: gar.count, guardLevel: gar.level,
        };
      }),
      trips: g.state.expeditions.map((ex) => {
        const poi = g.exploration.poi(ex.poiId);
        return poi && ex.from && {
          from: ex.from, to: { lat: poi.lat, lon: poi.lon }, startAt: ex.startAt, endAt: ex.endAt,
          travelMs: ex.travelMs, searchMs: ex.searchMs, members: ex.memberIds.length, target: poi.name,
          ...(ex.path?.length > 2 ? { path: ex.path.slice(0, 20) } : {}),
        };
      }).filter(Boolean),
    };
  }

  async sync() {
    const g = this.game;
    if (!this.provider || g.locked) return;
    const center = g.shelter.primary() || g.state.map.center;
    const { id, token } = this.identity();
    try {
      if (this.sharing && g.state.bases.length) {
        await this.provider.worldPut(id, token, this.presence());
        this.shared = true;
      } else if (this.shared !== false) {
        // 沒有據點：從其他玩家的地圖上移除
        await this.provider.worldDelete(id, token).catch(() => {});
        this.shared = false;
      }
      const list = await this.provider.worldNearby(center.lat, center.lon, WORLD_RADIUS_KM, id);
      this.others = list.map(cleanPlayer).filter((p) => p && p.id !== id);
      // 其他玩家送來的事件（攻擊、友好請求…）
      if (this.provider.worldInbox && this.shared) {
        const events = await this.provider.worldInbox(id, token).catch(() => []);
        if (events.length) g.territory.handleEvents(events);
      }
      this.status = 'online';
      this.lastSyncAt = Date.now();
    } catch (err) {
      this.status = err.kind === 'network' ? 'offline' : 'error';
      this.error = err.message;
    }
    bus.emit(WORLD_EVT, this.others);
  }
}
