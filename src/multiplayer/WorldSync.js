import { BASE_SIZES } from '../config/civilization.js';
import { bus } from '../core/EventBus.js';
import { sha256 } from '../utils/sha256.js';
import { uid } from '../utils/math.js';
import { MAX_ASSIST_DPS } from '../systems/AssistSystem.js';

/** 上傳／下載間隔 */
const SYNC_MS = 30000;
/** 自己或友好玩家正遭到屍潮攻擊（或正在協防）時加快同步，讓對方即時看到狀況 */
const FAST_SYNC_MS = 10000;
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

/** 屍潮狀況（只有正在被攻擊時才有） */
function cleanSiege(s) {
  if (!s || typeof s !== 'object') return null;
  const int = (v, max) => (finite(v) ? Math.min(max, Math.max(0, Math.round(v))) : 0);
  return {
    wave: int(s.wave, 99), maxWaves: int(s.maxWaves, 99), left: int(s.left, 9999), wallPct: int(s.wallPct, 100), helpers: int(s.helpers, 20),
  };
}

/** 據點今晚的協防戰果（公開） */
export function assistedOf(b) {
  const log = b.assistLog;
  if (!log || !Object.keys(log.list || {}).length) return null;
  return {
    night: log.night, result: log.result,
    list: Object.entries(log.list).slice(0, 10).map(([id, x]) => ({ id, kind: x.kind, dmg: Math.round(x.dmg), kills: x.kills })),
  };
}

function cleanAssisted(a) {
  if (!a || typeof a !== 'object' || !Array.isArray(a.list)) return null;
  return {
    night: String(a.night ?? '').slice(0, 20),
    result: ['ok', 'breached'].includes(a.result) ? a.result : 'ongoing',
    list: a.list.slice(0, 10).map((x) => ({
      id: String(x?.id || '').slice(0, 50), kind: x?.kind === 'cover' ? 'cover' : 'team',
      dmg: finite(x?.dmg) ? Math.min(1e8, Math.max(0, Math.round(x.dmg))) : 0,
      kills: finite(x?.kills) ? Math.min(1e5, Math.max(0, Math.round(x.kills))) : 0,
    })).filter((x) => x.id),
  };
}

/** 協防資料：要協防的玩家與火力 */
function cleanAssist(a) {
  if (!a || typeof a !== 'object' || !finite(a.until) || !a.to) return null;
  return {
    to: String(a.to).slice(0, 40), until: a.until, at: finite(a.at) ? a.at : 0,
    dps: finite(a.dps) ? Math.min(MAX_ASSIST_DPS, Math.max(0, Math.round(a.dps))) : 0,
    count: finite(a.count) ? Math.min(20, Math.max(1, Math.round(a.count))) : 1,
  };
}

export function cleanPlayer(p) {
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
      siege: cleanSiege(b.siege),
      assisted: cleanAssisted(b.assisted),
      raids: (Array.isArray(b.raids) ? b.raids : []).slice(0, 5).filter((r) => r && finite(r.at))
        .map((r) => ({
          by: String(r.by || '不明隊伍').slice(0, 30), kind: r.kind === 'npc' ? 'npc' : 'player', at: r.at,
          ...(r.kind === 'npc' && validPoint(r.from) && finite(r.startAt) && r.startAt < r.at ? {
            npc: String(r.npc || '').slice(0, 30), level: finite(r.level) ? Math.min(60, Math.max(1, Math.round(r.level))) : 1,
            from: { lat: r.from.lat, lon: r.from.lon }, startAt: r.startAt,
            ...(Array.isArray(r.path) && r.path.length >= 2 && r.path.length <= 20 && r.path.every(validPoint) ? { path: r.path.map((q) => ({ lat: q.lat, lon: q.lon })) } : {}),
          } : {}),
        })),
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
      ...(t.kind === 'assist' ? { kind: 'assist' } : {}),
    }));
  const demands = (Array.isArray(p.demands) ? p.demands : []).slice(0, 10).map((d) => ({
    id: String(d?.id || '').slice(0, 40), key: String(d?.key || '').slice(0, 20),
    qty: finite(d?.qty) ? Math.min(99999, Math.max(0, Math.floor(d.qty))) : 0,
    price: finite(d?.price) ? Math.min(100000, Math.max(0, Math.floor(d.price))) : 0,
  })).filter((d) => d.id && d.key && d.qty > 0);
  return {
    id: String(p.id || ''), name: String(p.name || '倖存者').slice(0, 16), civ: finite(p.civ) ? p.civ : 0, bases, trips,
    exchange: finite(p.exchange) ? Math.min(20, Math.max(0, Math.floor(p.exchange))) : 0, demands,
    assist: cleanAssist(p.assist),
    cover: p.cover && finite(p.cover.r) && finite(p.cover.dps)
      ? { r: Math.min(400, Math.max(0, p.cover.r)), dps: Math.min(MAX_ASSIST_DPS, Math.max(0, Math.round(p.cover.dps))) } : null,
  };
}

/** 據點正在被屍潮攻擊時的狀況（公開給友好玩家看） */
export function siegeStatus(g, b) {
  const w = g.siege.of(b.id).waveInfo();
  if (!w.active || !w.attacking) return null;
  const max = g.shelter.wallMax(b) || 1;
  return {
    wave: w.wave, maxWaves: w.maxWaves, left: w.left, wallPct: Math.round((g.shelter.wallHp(b) / max) * 100),
    helpers: g.shelter.isPrimary(b) ? g.assist.incoming().length : 0,
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
    this.timer = setInterval(() => {
      const gap = Date.now() - (this.lastTryAt || 0);
      if (gap >= SYNC_MS || (gap >= FAST_SYNC_MS && this.urgent())) this.sync();
    }, FAST_SYNC_MS);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  /** 是否需要加快同步 */
  urgent() {
    const g = this.game;
    return (g.assist?.trips().length || 0) > 0 || g.threats().length > 0 || (g.assist?.friendSieges().length || 0) > 0
      || (g.assist?.friendRaids().length || 0) > 0;
  }

  /** 盡快同步一次（例如剛出發協防） */
  syncSoon() {
    clearTimeout(this.soonTimer);
    this.soonTimer = setTimeout(() => this.sync(), 500);
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
      assist: g.assist.published(),
      // 屍潮防禦範圍與可分出的防禦火力（涵蓋友好據點時自動協助）
      cover: g.assist.publishedCover(),
      bases: g.state.bases.map((b) => {
        const gar = g.territory.garrison(b);
        return {
          lat: b.lat, lon: b.lon, name: b.name, primary: b === primary, size: b.size,
          alert: g.territory.alertRadius(b), guards: gar.count, guardLevel: gar.level,
          // 攻擊者要先打破圍牆，期間防禦設施會射擊（只公開看得到的強度，不含彈藥存量）
          wall: Math.round(g.shelter.wallHp(b)), dps: g.siege.of(b.id).defenseDps({ apparent: true }),
          // 正在被屍潮攻擊：友好玩家可以看到狀況並前來協防
          siege: siegeStatus(g, b),
          // 正在前來攻打的隊伍（友好玩家可以看到）
          raids: g.territory.incomingRaids(b),
          // 友好玩家協防的戰果（協防的人據此收到戰報）
          assisted: assistedOf(b),
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
          ...(ex.kind === 'assist' && !ex.defeated ? { kind: 'assist' } : {}),
        };
      }).filter(Boolean),
    };
  }

  async sync() {
    const g = this.game;
    if (!this.provider || g.locked) return;
    const center = g.shelter.primary() || g.state.map.center;
    const { id, token } = this.identity();
    this.myId = id;
    this.lastTryAt = Date.now();
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
