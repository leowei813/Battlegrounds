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
    .map((b) => ({ lat: b.lat, lon: b.lon, name: String(b.name || '').slice(0, 40), primary: !!b.primary }));
  if (!bases.length) return null;
  const trips = (Array.isArray(p.trips) ? p.trips : []).slice(0, 10).filter((t) => validPoint(t?.from) && validPoint(t?.to)
    && finite(t.startAt) && finite(t.endAt) && t.endAt > t.startAt)
    .map((t) => ({
      from: t.from, to: t.to, startAt: t.startAt, endAt: t.endAt,
      travelMs: finite(t.travelMs) ? t.travelMs : 0, searchMs: finite(t.searchMs) ? t.searchMs : t.endAt - t.startAt,
      members: finite(t.members) ? t.members : 1, target: String(t.target || '').slice(0, 40),
    }));
  return {
    id: String(p.id || ''), name: String(p.name || '倖存者').slice(0, 16), civ: finite(p.civ) ? p.civ : 0, bases, trips,
  };
}

/**
 * 多人互動：把自己的據點與探索隊伍公開給附近玩家，並顯示附近其他玩家。
 * 需要伺服器（內建 server/ 或 Supabase）；公開與否由玩家自行選擇（預設不公開）。
 */
export class WorldSync {
  /**
   * @param {import('../core/Game.js').Game} game
   * @param {object|null} provider 與雲端存檔共用的後端
   */
  constructor(game, provider) {
    this.game = game;
    this.provider = provider?.worldNearby ? provider : null;
    this.others = [];
    this.status = this.provider ? 'idle' : 'off';
    this.lastSyncAt = 0;
    this.timer = null;
  }

  get available() {
    return !!this.provider;
  }

  /** 是否公開自己（undefined = 尚未選擇） */
  get sharing() {
    return this.game.state.settings.shareWorld === true;
  }

  /** 玩家身分：存在存檔中（雲端同步後各裝置相同），token 只上傳雜湊 */
  identity() {
    const p = this.game.state.player;
    if (!p.worldId) {
      p.worldId = sha256(uid('world')).slice(0, 32);
      p.worldSecret = sha256(`${uid('secret')}${Math.random()}`);
    }
    return { id: p.worldId, token: sha256(`jdqs-world:${p.worldSecret}`) };
  }

  start() {
    if (!this.provider || this.timer) return;
    this.sync();
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
      bases: g.state.bases.map((b) => ({
        lat: b.lat, lon: b.lon, name: b.name, primary: b === primary, size: b.size,
      })),
      trips: g.state.expeditions.map((ex) => {
        const poi = g.exploration.poi(ex.poiId);
        return poi && ex.from && {
          from: ex.from, to: { lat: poi.lat, lon: poi.lon }, startAt: ex.startAt, endAt: ex.endAt,
          travelMs: ex.travelMs, searchMs: ex.searchMs, members: ex.memberIds.length, target: poi.name,
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
      if (this.sharing && g.state.bases.length) await this.provider.worldPut(id, token, this.presence());
      const list = await this.provider.worldNearby(center.lat, center.lon, WORLD_RADIUS_KM, id);
      this.others = list.map(cleanPlayer).filter((p) => p && p.id !== id);
      this.status = 'online';
      this.lastSyncAt = Date.now();
    } catch (err) {
      this.status = err.kind === 'network' ? 'offline' : 'error';
      this.error = err.message;
    }
    bus.emit(WORLD_EVT, this.others);
  }

  /** 開啟/關閉公開；關閉時從世界上移除自己 */
  async setSharing(on) {
    this.game.state.settings.shareWorld = !!on;
    this.game.changed();
    if (!this.provider) return;
    if (!on) {
      const { id, token } = this.identity();
      await this.provider.worldDelete(id, token).catch(() => {});
    }
    await this.sync();
  }
}
