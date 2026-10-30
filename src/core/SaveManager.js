import { SAVE_KEY, SAVE_VERSION } from '../config/constants.js';
import { STAT_KEYS } from './GameState.js';
import { POI_KEYS } from '../config/poiTypes.js';
import { SLOT_KEYS } from '../config/equipment.js';

/**
 * 地圖建築改以「欄位陣列」儲存（市區可達數千棟，物件格式體積約大一倍）：
 * [id, 類型索引, 名稱, 緯度, 經度, 是否 OSM(1/0), 枯竭度, 最後探索時間]
 */
function packPois(pois) {
  return {
    types: POI_KEYS,
    rows: pois.map((p) => [p.id, POI_KEYS.indexOf(p.type), p.name, p.lat, p.lon, p.osm ? 1 : 0, p.depletion ? +p.depletion.toFixed(3) : 0, p.lastVisit || 0]),
  };
}

function unpackPois({ types, rows }) {
  return rows.map(([id, t, name, lat, lon, osm, depletion, lastVisit]) => {
    const poi = { id, type: types[t], name, lat, lon, osm: !!osm };
    if (depletion) poi.depletion = depletion;
    if (lastVisit) poi.lastVisit = lastVisit;
    return poi;
  }).filter((p) => p.type);
}

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
      localStorage.setItem(SAVE_KEY, JSON.stringify(SaveManager.pack(state)));
      return true;
    } catch (err) {
      console.error('[SaveManager] save failed', err);
      return false;
    }
  }

  /**
   * 轉為儲存/上傳用的精簡格式（不修改傳入的狀態）。
   * LocalStorage、匯出字串與雲端存檔都使用此格式；讀取時由 migrate() 還原。
   */
  static pack(state) {
    const { pois, ...map } = state.map;
    return { ...state, map: { ...map, poiPack: packPois(pois) } };
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
    const json = JSON.stringify(SaveManager.pack(state));
    return btoa(unescape(encodeURIComponent(json)));
  }

  static importString(str) {
    const json = decodeURIComponent(escape(atob(str.trim())));
    const data = SaveManager.migrate(JSON.parse(json));
    if (!data?.player || !Array.isArray(data?.bases)) throw new Error('存檔格式錯誤');
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
    // v1 -> v2：單一避難所 shelter 改為多據點 bases + primaryBaseId
    if (v < 2 && data.shelter) {
      const { shelter } = data;
      data.bases = shelter.poiId
        ? [{
          id: 'base_legacy',
          poiId: shelter.poiId,
          name: shelter.name,
          lat: shelter.lat,
          lon: shelter.lon,
          createdAt: data.createdAt,
          facilities: shelter.facilities,
          defenses: shelter.defenses,
          wallHp: shelter.wallHp,
          buildQueue: shelter.buildQueue || [],
        }]
        : [];
      data.primaryBaseId = data.bases[0]?.id || null;
      delete data.shelter;
    }
    data.bases = data.bases || [];
    // v3 -> v4：品級改為 6 階（舊的灰色「普通」→「劣質」），裝備欄新增手套、鞋子、飾品
    if (v < 4) {
      (data.inventory?.items || []).forEach((it) => { if (it.rarity === 'common') it.rarity = 'poor'; });
    }
    (data.survivors || []).concat(data.recruitPool || []).forEach((sv) => {
      sv.equipment = sv.equipment || {};
      SLOT_KEYS.forEach((k) => { if (!(k in sv.equipment)) sv.equipment[k] = null; });
    });
    // v3：地圖建築改以精簡格式儲存，載入時還原為物件
    if (data.map?.poiPack) {
      data.map.pois = unpackPois(data.map.poiPack);
      delete data.map.poiPack;
    }
    if (data.map) data.map.pois = data.map.pois || [];
    // 補 stats
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
