import { bus, EVT } from '../core/EventBus.js';
import { SaveManager } from '../core/SaveManager.js';
import { CloudError } from './providers/CloudError.js';
import {
  generateCode, normalizeCode, saveIdFromCode, tokenFromCode, formatCode,
} from './syncCode.js';

const CFG_KEY = 'jdqs_cloud_v1';
/** 無 SSE 時輪詢雲端版本的間隔 */
const POLL_MS = 10000;
/** 有 SSE 時的保險輪詢（防止連線靜默中斷） */
const SAFETY_POLL_MS = 60000;
/** 一般自動存檔時，兩次上傳的最短間隔 */
const PUSH_MIN_INTERVAL = 10000;

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
 * 雲端存檔同步。
 *
 * 一致性模型：「單一作用中裝置 + 樂觀鎖」
 *  - 每次上傳帶 baseRev，雲端版本不同就回 409（不會互相覆蓋）。
 *  - 開啟遊戲時若雲端版本較新 → 直接讀雲端（換裝置即時接續）。
 *  - 遊戲執行中若偵測到其他裝置寫入較新版本 → 鎖定本機遊戲，
 *    讓玩家選擇「載入最新進度」或「在此裝置接管」。
 *  - 本機存檔（LocalStorage）仍是離線時的主要存檔；雲端是跨裝置的同步層。
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

  get enabled() {
    return !!(this.provider && this.cfg.code);
  }

  get displayCode() {
    return this.cfg.code ? formatCode(this.cfg.code) : '';
  }

  get deviceId() {
    return this.cfg.deviceId;
  }

  creds() {
    return { id: saveIdFromCode(this.cfg.code), token: tokenFromCode(this.cfg.code) };
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

  // ---------------- 開機 / 連結 ----------------

  /**
   * 開機時決定要用本機還是雲端存檔。
   * @param {object|null} local 本機存檔
   * @returns {Promise<{state:object|null, source:'local'|'cloud', meta?:object}>}
   */
  async resolveBoot(local) {
    if (!this.enabled) return { state: local, source: 'local' };
    const { id, token } = this.creds();
    this.setStatus('syncing');
    try {
      const meta = await this.provider.meta(id, token);
      if (!local || meta.rev > (this.cfg.rev || 0)) {
        const remote = await this.provider.pull(id, token);
        const state = SaveManager.migrate(remote.data);
        SaveManager.save(state);
        this.cfg.rev = remote.meta.rev;
        this.cfg.lastSyncAt = Date.now();
        this.persist();
        this.setStatus('synced');
        return { state, source: 'cloud', meta: remote.meta };
      }
      this.setStatus('idle');
      return { state: local, source: 'local' };
    } catch (err) {
      if (err.kind === 'notfound') {
        // 雲端資料遺失：以本機為準，下次上傳時重建
        this.cfg.rev = 0;
        this.persist();
        this.setStatus('idle');
      } else {
        this.handleError(err);
      }
      return { state: local, source: 'local' };
    }
  }

  /**
   * 用同步碼連結既有雲端存檔，回傳雲端遊戲狀態（呼叫端負責寫入並重新載入）。
   */
  async link(input) {
    if (!this.provider) throw new CloudError('server', '未設定雲端伺服器');
    const code = normalizeCode(input);
    if (!code) throw new CloudError('forbidden', '同步碼格式錯誤（應為 24 個英數字）');
    const remote = await this.provider.pull(saveIdFromCode(code), tokenFromCode(code));
    const state = SaveManager.migrate(remote.data);
    if (!state?.player || !Array.isArray(state?.bases)) throw new CloudError('server', '雲端存檔格式錯誤');
    this.cfg = { ...this.cfg, code, rev: remote.meta.rev, lastSyncAt: Date.now() };
    this.persist();
    return { state, meta: remote.meta };
  }

  /** 為目前遊戲建立新的雲端存檔並產生同步碼 */
  async enable(game) {
    if (!this.provider) throw new CloudError('server', '未設定雲端伺服器');
    const prev = { ...this.cfg };
    this.game = game;
    this.cfg = { ...this.cfg, code: generateCode(), rev: 0 };
    try {
      await this.pushNow({ throwOnError: true });
    } catch (err) {
      this.cfg = prev;
      this.persist();
      throw err;
    }
    this.attach(game);
    return this.displayCode;
  }

  disable() {
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

  onSave(final) {
    if (!this.enabled || this.locked) return;
    if (final || Date.now() - this.lastPushAt >= PUSH_MIN_INTERVAL) this.pushNow({ keepalive: final });
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
      const meta = await this.provider.push(id, token, {
        baseRev: this.cfg.rev || 0,
        deviceId: this.deviceId,
        deviceName: deviceName(),
        data: this.game.state,
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
