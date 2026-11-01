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
/** 交易擺攤清單（數值在收下時另外驗證） */
function cleanStall(list) {
  return (Array.isArray(list) ? list : []).slice(0, 12).map((x) => {
    if (!x || typeof x !== 'object') return null;
    const qty = finite(x.qty) ? Math.min(999999, Math.max(0, Math.floor(x.qty))) : 0;
    const sold = finite(x.sold) ? Math.min(qty, Math.max(0, Math.floor(x.sold))) : 0;
    const price = finite(x.price) ? Math.min(100000, Math.max(0, Math.floor(x.price))) : 0;
    const id = String(x.id || '').slice(0, 40);
    if (!id || !qty) return null;
    if (x.item && typeof x.item === 'object') return { id, qty: 1, sold: Math.min(1, sold), price, item: x.item };
    return x.key ? { id, key: String(x.key).slice(0, 20), qty, sold, price } : null;
  }).filter(Boolean);
}

function cleanPlayer(p) {
  if (!p || typeof p !== 'object') return null;
  const bases = (Array.isArray(p.bases) ? p.bases : []).filter(validPoint).slice(0, 5)
    .map((b) => ({
      lat: b.lat, lon: b.lon, name: String(b.name || '').slice(0, 40), primary: !!b.primary,
      size: BASE_SIZES[b.size] ? b.size : 'medium',
      alert: finite(b.alert) ? Math.min(500, Math.max(0, b.alert)) : BASE_SIZES[b.size]?.alert || 80,
      guards: finite(b.guards) ? Math.min(20, Math.max(0, Math.round(b.guards))) : 0,
      guardLevel: finite(b.guardLevel) ? Math.min(60, Math.max(1, Math.round(b.guardLevel))) : 1,
      wall: finite(b.wall) ? Math.min(1e6, Math.max(0, b.wall)) : 0,
      dps: finite(b.dps) ? Math.min(1e5, Math.max(0, b.dps)) : 0,
    }));
  if (!bases.length) return null;
  const trips = (Array.isArray(p.trips) ? p.trips : []).slice(0, 10).filter((t) => validPoint(t?.from) && validPoint(t?.to)
    && finite(t.startAt) && finite(t.endAt) && t.endAt > t.startAt)
    .map((t) => ({
      from: t.from, to: t.to, startAt: t.startAt, endAt: t.endAt,
      ...(Array.isArray(t.path) && t.path.length >= 2 && t.path.every(validPoint) ? { path: t.path.slice(0, 20) } : {}),
      travelMs: finite(t.travelMs) ? t.travelMs : 0, searchMs: finite(t.searchMs) ? t.searchMs : t.endAt - t.startAt,
      members: finite(t.members) ? Math.min(10, Math.max(1, t.members)) : 1, target: String(t.target || '').slice(0, 40),
      id: String(t.id || '').slice(0, 40), level: finite(t.level) ? Math.min(60, Math.max(1, Math.round(t.level))) : 1,
      defeated: !!t.defeated,
      ...(t.kind === 'trade' ? { kind: 'trade', targetId: String(t.targetId || '').slice(0, 40), stall: cleanStall(t.stall) } : {}),
      ...(t.kind === 'deliver' ? { kind: 'deliver' } : {}),
    }));
  const demands = (Array.isArray(p.demands) ? p.demands : []).slice(0, 10).map((d) => ({
    id: String(d?.id || '').slice(0, 40), key: String(d?.key || '').slice(0, 20),
    qty: finite(d?.qty) ? Math.min(99999, Math.max(0, Math.floor(d.qty))) : 0,
    price: finite(d?.price) ? Math.min(100000, Math.max(0, Math.floor(d.price))) : 0,
  })).filter((d) => d.id && d.key && d.qty > 0);
  return {
    id: String(p.id || ''), name: String(p.name || '倖存者').slice(0, 16), civ: finite(p.civ) ? p.civ : 0, bases, trips,
    exchange: finite(p.exchange) ? Math.min(20, Math.max(0, Math.floor(p.exchange))) : 0, demands,
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
      exchange: g.shelter.maxLevel('exchange'),
      demands: g.demand.published(),
      bases: g.state.bases.map((b) => {
        const gar = g.territory.garrison(b);
        return {
          lat: b.lat, lon: b.lon, name: b.name, primary: b === primary, size: b.size,
          alert: g.territory.alertRadius(b), guards: gar.count, guardLevel: gar.level,
          // 攻擊者要先打破圍牆，期間防禦設施會射擊（只公開看得到的強度，不含彈藥存量）
          wall: Math.round(g.shelter.wallHp(b)), dps: g.siege.of(b.id).defenseDps({ apparent: true }),
        };
      }),
      // 被攔截而撤回的隊伍也會顯示移動，但其他玩家的地圖不顯示時間，也無法再攔截
      trips: g.state.expeditions.map((ex) => {
        const poi = g.exploration.poi(ex.poiId);
        const members = ex.memberIds.map((id) => g.survivors.get(id)).filter(Boolean);
        return poi && ex.from && {
          id: ex.id, ...(ex.defeated ? { defeated: true } : {}), level: members.length ? Math.round(members.reduce((s, m) => s + m.level, 0) / members.length) : 1,
          from: ex.from, to: { lat: poi.lat, lon: poi.lon }, startAt: ex.startAt, endAt: ex.endAt,
          travelMs: ex.travelMs, searchMs: ex.searchMs, members: ex.memberIds.length, target: poi.name,
          ...(ex.path?.length > 2 ? { path: ex.path.slice(0, 20) } : {}),
          // 交易隊：對方玩家與擺攤商品
          ...(ex.kind === 'trade' && ex.trade && !ex.recalled && !ex.tradeEnded && !ex.defeated
            ? { kind: 'trade', targetId: ex.trade.playerId, stall: g.trade.stallOf(ex) } : {}),
          ...(ex.kind === 'deliver' && !ex.defeated ? { kind: 'deliver' } : {}),
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
