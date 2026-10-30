import { SAVE_KEY, SAVE_VERSION } from '../config/constants.js';
import { STAT_KEYS } from './GameState.js';

/**
 * 存檔管理：LocalStorage 讀寫、版本遷移、匯出/匯入。
 * 所有存取都包 try/catch，避免無痕模式或空間不足造成遊戲崩潰。
 */
export class SaveManager {
  static hasSave() {
    try {
      return !!localStorage.getItem(SAVE_KEY);
    } catch {
      return false;
    }
  }

  /** @returns {object|null} */
  static load() {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return null;
      return SaveManager.migrate(JSON.parse(raw));
    } catch (err) {
      console.error('[SaveManager] load failed', err);
      return null;
    }
  }

  static save(state) {
    try {
      state.lastSaveAt = Date.now();
      localStorage.setItem(SAVE_KEY, JSON.stringify(state));
      return true;
    } catch (err) {
      console.error('[SaveManager] save failed', err);
      return false;
    }
  }

  static wipe() {
    try {
      localStorage.removeItem(SAVE_KEY);
    } catch {
      /* ignore */
    }
  }

  /** 匯出為 Base64 字串，供玩家跨裝置備份 */
  static exportString(state) {
    const json = JSON.stringify(state);
    return btoa(unescape(encodeURIComponent(json)));
  }

  static importString(str) {
    const json = decodeURIComponent(escape(atob(str.trim())));
    const data = SaveManager.migrate(JSON.parse(json));
    if (!data?.player || !data?.shelter) throw new Error('存檔格式錯誤');
    return data;
  }

  /**
   * 版本遷移：未來資料結構變更時，在此依 version 逐步升級。
   * 同時補齊新增的統計欄位，確保舊存檔不會缺欄位。
   */
  static migrate(data) {
    if (!data || typeof data !== 'object') return null;
    const v = data.version ?? 0;
    if (v > SAVE_VERSION) {
      console.warn('[SaveManager] save is from a newer version');
    }
    // v0 -> v1 範例：補 stats
    data.stats = data.stats || {};
    STAT_KEYS.forEach((k) => {
      if (typeof data.stats[k] !== 'number') data.stats[k] = 0;
    });
    data.inventory = data.inventory || { items: [], blueprints: [] };
    data.inventory.blueprints = data.inventory.blueprints || [];
    data.recruitPool = data.recruitPool || [];
    data.reports = data.reports || [];
    data.log = data.log || [];
    data.settings = { autoSave: true, showDamage: true, ...(data.settings || {}) };
    data.version = SAVE_VERSION;
    return data;
  }
}
