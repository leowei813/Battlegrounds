import { bus, EVT } from '../core/EventBus.js';
import { SaveManager } from '../core/SaveManager.js';
import { CloudError } from './providers/CloudError.js';
import { credentials, normalizeUsername, validateCredentials } from './account.js';
import { sha256 } from '../utils/sha256.js';

const CFG_KEY = 'jdqs_cloud_v2';
/** 無 SSE 時輪詢雲端版本的間隔 */
const POLL_MS = 10000;
/** 有 SSE 時的保險輪詢（防止連線靜默中斷） */
const SAFETY_POLL_MS = 60000;

export const CLOUD_EVT = { STATUS: 'cloud:status', LOCKED: 'cloud:locked' };

function deviceName() {
  const ua = navigator.userAgent;
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android'
    : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '裝置';
  const br = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
  return `${os} ${br}`.trim();
}

function loadCfg() {
  try {
    return JSON.parse(localStorage.getItem(CFG_KEY)) || {};
  } catch {
    return {};
  }
}

/**
 * 帳號制雲端存檔（唯一的存檔位置，本機不保存遊戲進度）。
 *
 * 帳號登入後即讀取雲端進度；此裝置只記住登入憑證（雜湊後的 token，不含密碼）。
 *
 * 一致性模型：「單一作用中裝置 + 樂觀鎖」
 *  - 每次上傳帶 baseRev，雲端版本不同就回 409（不會互相覆蓋）。
 *  - 遊戲執行中若偵測到其他裝置寫入較新版本 → 鎖定本機遊戲，
 *    讓玩家選擇「載入最新進度」或「在此裝置接管」。
 */
export class CloudSync {
  /** @param {object|null} provider */
  constructor(provider) {
    this.provider = provider;
    this.cfg = loadCfg();
    if (!this.cfg.deviceId) {
      this.cfg.deviceId = `dev_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
      this.persist();
    }
    this.game = null;
    this.status = this.enabled ? 'idle' : 'off';
    this.error = '';
    this.locked = false;
    this.inflight = false;
    this.pending = false;
    this.lastPushAt = 0;
    this.timers = [];
    this.unwatch = null;
  }

  get available() {
    return !!this.provider;
  }

  /** 已登入帳號 */
  get enabled() {
    return !!(this.provider && this.cfg.auth);
  }

  get username() {
    return this.cfg.auth?.username || '';
  }

  get deviceId() {
    return this.cfg.deviceId;
  }

  creds() {
    return { id: this.cfg.auth.id, token: this.cfg.auth.token };
  }

  /** 地圖建築清單另存一筆雲端紀錄（同一組憑證） */
  mapCreds() {
    return { id: sha256(`jdqs-map:${this.cfg.auth.id}`).slice(0, 32), token: this.cfg.auth.token };
  }

  persist() {
    try {
      localStorage.setItem(CFG_KEY, JSON.stringify(this.cfg));
    } catch {
      /* ignore */
    }
  }

  setStatus(status, error = '') {
    this.status = status;
    this.error = error;
    bus.emit(CLOUD_EVT.STATUS, { status, error });
  }

  handleError(err) {
    if (!(err instanceof CloudError)) {
      console.error('[cloud]', err);
      this.setStatus('error', err.message);
      return;
    }
    if (err.kind === 'network') this.setStatus('offline', err.message);
    else this.setStatus('error', err.message);
  }

  // ---------------- 帳號 ----------------

  check(username, password) {
    if (!this.provider) throw new CloudError('server', '此版本未設定雲端伺服器，無法登入');
    const u = normalizeUsername(username);
    const msg = validateCredentials(u, password);
    if (msg) throw new CloudError('invalid', msg);
    return credentials(u, password);
  }

  /**
   * 登入並讀取雲端進度。
   * @returns {Promise<{state:object|null, meta?:object}>} state=null 代表帳號尚未建立角色
   */
  async login(username, password) {
    const auth = this.check(username, password);
    try {
      await this.provider.meta(auth.id, auth.token);
    } catch (err) {
      if (err.kind === 'notfound') throw new CloudError('notfound', '帳號不存在，請先註冊');
      if (err.kind === 'forbidden') throw new CloudError('forbidden', '密碼錯誤');
      throw err;
    }
    this.cfg = { deviceId: this.cfg.deviceId, auth, rev: 0 };
    this.persist();
    return this.loadCurrent();
  }

  /** 註冊：確認帳號可用並記住憑證；第一次上傳存檔（create）時才真正建立 */
  async register(username, password) {
    const auth = this.check(username, password);
    try {
      await this.provider.meta(auth.id, auth.token);
      throw new CloudError('taken', '這個帳號已經有人使用');
    } catch (err) {
      if (err.kind === 'forbidden') throw new CloudError('taken', '這個帳號已經有人使用');
      if (err.kind !== 'notfound') throw err;
    }
    this.cfg = { deviceId: this.cfg.deviceId, auth, rev: 0, pendingCreate: true };
    this.persist();
  }

  /**
   * 讀取目前帳號的雲端進度。
   * @returns {Promise<{state:object|null, meta?:object}>}
   */
  async loadCurrent() {
    const { id, token } = this.creds();
    this.setStatus('syncing');
    try {
      const remote = await this.provider.pull(id, token);
      const state = SaveManager.migrate(remote.data);
      if (state?.map?.poisExternal) {
        const m = this.mapCreds();
        const map = await this.provider.pull(m.id, m.token).catch((err) => {
          if (err.kind === 'notfound') return null;
          throw err;
        });
        SaveManager.mergeMap(state, map?.data);
        this.mapPushedAt = state.map.pois.length ? state.map.fetchedAt : 0;
      }
      this.cfg.rev = remote.meta.rev;
      this.cfg.lastSyncAt = Date.now();
      delete this.cfg.pendingCreate;
      this.persist();
      this.setStatus('synced');
      // 重置進度後的空存檔：需要重新建立角色
      if (!state?.player) return { state: null, meta: remote.meta };
      return { state, meta: remote.meta };
    } catch (err) {
      if (err.kind === 'notfound' && this.cfg.pendingCreate) {
        this.setStatus('idle');
        return { state: null };
      }
      if (err.kind === 'notfound' || err.kind === 'forbidden') this.logout();
      this.handleError(err);
      throw err;
    }
  }

  /** 把新建立的遊戲寫入雲端（註冊後第一次、或重置後重新開始） */
  async create(game) {
    this.game = game;
    await this.pushNow({ force: !this.cfg.pendingCreate, throwOnError: true });
    delete this.cfg.pendingCreate;
    this.persist();
  }

  /** 清空雲端進度（保留帳號），下次登入會重新建立角色 */
  async resetProgress() {
    const { id, token } = this.creds();
    this.detach();
    this.locked = true;
    const meta = await this.provider.push(id, token, {
      baseRev: this.cfg.rev || 0, deviceId: this.deviceId, deviceName: deviceName(), data: { reset: Date.now() }, force: true,
    });
    this.cfg.rev = meta.rev;
    this.persist();
  }

  logout() {
    this.detach();
    this.cfg = { deviceId: this.cfg.deviceId };
    this.persist();
    this.setStatus('off');
  }

  // ---------------- 執行中同步 ----------------

  /** 掛上遊戲：自動上傳、即時監看其他裝置 */
  attach(game) {
    this.game = game;
    if (!this.listening) {
      this.listening = true;
      bus.on(EVT.SAVE, ({ final }) => this.onSave(final));
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) this.checkRemote();
      });
      window.addEventListener('online', () => this.checkRemote());
    }
    if (!this.enabled) return;
    this.detach();
    const { id, token } = this.creds();
    this.unwatch = this.provider.watch(id, token, (meta) => this.onRemoteMeta(meta));
    this.timers.push(setInterval(() => this.checkRemote(), this.unwatch ? SAFETY_POLL_MS : POLL_MS));
    // 宣告「此裝置正在遊玩」：其他開著的裝置會立即收到通知並鎖定
    this.pushNow();
  }

  detach() {
    this.unwatch?.();
    this.unwatch = null;
    this.timers.forEach(clearInterval);
    this.timers = [];
  }

  /** 每次存檔都立即上傳；上傳中又有新存檔時，完成後再上傳最新狀態（合併為一次） */
  onSave(final) {
    if (!this.enabled || this.locked) return;
    this.pushNow({ keepalive: final });
  }

  async pushNow({ force = false, keepalive = false, throwOnError = false } = {}) {
    if (!this.enabled || !this.game || (this.locked && !force)) return false;
    if (this.inflight) {
      this.pending = true;
      return false;
    }
    this.inflight = true;
    this.lastPushAt = Date.now();
    this.setStatus('syncing');
    const { id, token } = this.creds();
    try {
      // 地圖建築重新掃描過才上傳建築清單（較大，平常不需要）
      const st = this.game.state;
      if (st.map.pois.length && st.map.fetchedAt !== this.mapPushedAt) {
        const m = this.mapCreds();
        await this.provider.push(m.id, m.token, {
          baseRev: 0, deviceId: this.deviceId, deviceName: deviceName(), data: SaveManager.packMap(st), force: true,
        });
        this.mapPushedAt = st.map.fetchedAt;
      }
      const meta = await this.provider.push(id, token, {
        baseRev: this.cfg.rev || 0,
        deviceId: this.deviceId,
        deviceName: deviceName(),
        data: SaveManager.packMain(st),
        force,
      }, { keepalive });
      this.cfg.rev = meta.rev;
      this.cfg.lastSyncAt = Date.now();
      this.persist();
      this.setStatus('synced');
      return true;
    } catch (err) {
      if (err.kind === 'conflict' && err.meta?.deviceId !== this.deviceId) this.lock(err.meta);
      else if (err.kind === 'conflict') {
        // 自己上一個工作階段的上傳（回應遺失）：以雲端版本為基準重試
        this.cfg.rev = err.meta.rev;
        this.pending = true;
      } else this.handleError(err);
      if (throwOnError) throw err;
      return false;
    } finally {
      this.inflight = false;
      if (this.pending && !this.locked) {
        this.pending = false;
        setTimeout(() => this.pushNow(), 0);
      }
    }
  }

  async checkRemote() {
    if (!this.enabled || this.locked || !this.game) return;
    try {
      const { id, token } = this.creds();
      this.onRemoteMeta(await this.provider.meta(id, token));
      if (this.status === 'offline') this.setStatus('synced');
    } catch (err) {
      if (err.kind !== 'notfound') this.handleError(err);
    }
  }

  onRemoteMeta(meta) {
    if (!meta || this.locked) return;
    if (meta.rev > (this.cfg.rev || 0) && meta.deviceId && meta.deviceId !== this.deviceId) this.lock(meta);
  }

  /** 其他裝置已接手：停止本機遊戲，避免覆蓋較新進度 */
  lock(meta) {
    this.locked = true;
    if (this.game) {
      this.game.locked = true;
      this.game.stop();
    }
    this.detach();
    this.setStatus('locked');
    bus.emit(CLOUD_EVT.LOCKED, meta);
  }

  /** 在此裝置接管：以本機進度強制覆蓋雲端 */
  async takeover() {
    this.game.locked = false;
    this.game.save();
    const ok = await this.pushNow({ force: true, throwOnError: true });
    this.locked = false;
    return ok;
  }
}
