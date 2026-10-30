import { fetchNearby } from '../map/OverpassService.js';
import { dayKey } from './LootStock.js';
import { haversine } from '../utils/math.js';

/** GPS 偵測半徑（公尺） */
export const GPS_RADIUS = 50;
/** 移動超過這個距離才重新向地圖伺服器查詢附近建築 */
const REFETCH_M = 30;

/**
 * GPS 偵測：依裝置的真實位置，偵測 50 公尺內的建築。
 *  - 偵測到的建築當天可以看到實際的今日物資（平常只顯示可能出現的物資）。
 *  - 地圖上還沒有的建築會自動加入地圖。
 *  - 人在自己的據點範圍內時不偵測。
 */
export class GpsSystem {
  constructor(game) {
    this.game = game;
    this.pos = null;
    this.status = 'off'; // off | locating | active | inBase | denied | unsupported | error
    this.nearby = [];
    this.watchId = null;
    this.lastFetch = null;
  }

  get enabled() {
    return !!this.game.state.settings.gps;
  }

  setEnabled(on) {
    this.game.state.settings.gps = !!on;
    if (on) this.start();
    else this.stop();
    this.game.changed();
  }

  start() {
    if (this.watchId != null) return;
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      this.status = 'unsupported';
      this.emit();
      return;
    }
    this.status = 'locating';
    this.watchId = navigator.geolocation.watchPosition(
      (p) => this.onPosition(p.coords.latitude, p.coords.longitude, p.coords.accuracy),
      (err) => {
        this.status = err.code === 1 ? 'denied' : 'error';
        this.error = err.message;
        this.emit();
      },
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 30000 },
    );
    this.emit();
  }

  stop() {
    if (this.watchId != null && typeof navigator !== 'undefined') navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
    this.status = 'off';
    this.nearby = [];
    this.emit();
  }

  emit() {
    this.game.bus.emit('gps:update', this);
  }

  /** 位置在哪一座自己的據點範圍內（不在則為 null） */
  baseAt(lat, lon) {
    return this.game.state.bases.find((b) => haversine(lat, lon, b.lat, b.lon) <= this.game.territory.alertRadius(b)) || null;
  }

  isDetected(poi, at = Date.now()) {
    return this.game.state.map.detected?.[poi.id] === dayKey(at);
  }

  onPosition(lat, lon, accuracy = 0) {
    this.pos = { lat, lon, accuracy, at: Date.now() };
    this.detect();
    if (this.status === 'active' && (!this.lastFetch || haversine(lat, lon, this.lastFetch.lat, this.lastFetch.lon) > REFETCH_M)) {
      this.lastFetch = { lat, lon };
      this.discover(lat, lon);
    }
    this.emit();
  }

  /** 偵測 50 公尺內的建築；在自己的據點內則不偵測 */
  detect() {
    const { lat, lon } = this.pos;
    if (this.baseAt(lat, lon)) {
      this.status = 'inBase';
      this.nearby = [];
      return [];
    }
    this.status = 'active';
    const map = this.game.state.map;
    const today = dayKey();
    map.detected = Object.fromEntries(Object.entries(map.detected || {}).filter(([, d]) => d === today));
    this.nearby = map.pois.filter((p) => !this.game.shelter.baseAtPoi(p.id) && haversine(lat, lon, p.lat, p.lon) <= GPS_RADIUS);
    const fresh = this.nearby.filter((p) => map.detected[p.id] !== today);
    fresh.forEach((p) => { map.detected[p.id] = today; });
    if (fresh.length) {
      this.game.log(`📡 GPS 偵測到 ${fresh.length} 棟附近建築，可查看今日物資`, 'info');
      this.game.bus.emit('map:changed');
    }
    return this.nearby;
  }

  /** 查詢真實地圖上附近的建築，地圖上還沒有的加入地圖 */
  async discover(lat, lon) {
    try {
      const found = await fetchNearby(lat, lon, GPS_RADIUS + 10);
      const map = this.game.state.map;
      const ids = new Set(map.pois.map((p) => p.id));
      const added = found.filter((p) => !ids.has(p.id));
      if (!added.length) return;
      map.pois.push(...added);
      map.fetchedAt = Date.now(); // 建築清單變更，雲端另存的建築清單會重新上傳
      this.game.log(`📡 GPS 發現 ${added.length} 棟新建築，已加入地圖`, 'success');
      if (this.pos) this.detect();
      this.game.bus.emit('map:changed');
      this.emit();
    } catch {
      /* 地圖伺服器暫時無法連線：下次移動再試 */
    }
  }
}
