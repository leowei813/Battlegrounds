import { SAVE_KEY, SAVE_VERSION } from '../config/constants.js';
import { STAT_KEYS, newSeeds } from './GameState.js';
import { POI_KEYS } from '../config/poiTypes.js';
import { SLOT_KEYS, ITEM_MODELS } from '../config/equipment.js';
import { RESEARCH, LEGACY_RESEARCH } from '../config/research.js';
import { BASE_SIZES, baseSizeOf } from '../config/civilization.js';
import { legacyToSupplies } from '../config/supplies.js';
import { MAIN_QUESTS } from '../config/quests.js';

/**
 * 地圖建築改以「欄位陣列」儲存（市區可達數千棟，物件格式體積約大一倍）：
 * [id, 類型索引, 名稱, 緯度, 經度, 是否 OSM(1/0), 被搜刮的日期編號, 最後探索時間]
 */
function packPois(pois) {
  return {
    types: POI_KEYS,
    rows: pois.map((p) => [p.id, POI_KEYS.indexOf(p.type), p.name, p.lat, p.lon, p.osm ? 1 : 0, p.lootedDay || 0, p.lastVisit || 0]),
  };
}

function unpackPois({ types, rows }) {
  return rows.map(([id, t, name, lat, lon, osm, lootedDay, lastVisit]) => {
    const poi = { id, type: types[t], name, lat, lon, osm: !!osm };
    // v4 以前此欄為枯竭度（小數），不再使用；整數才是被搜刮的日期編號
    if (Number.isInteger(lootedDay) && lootedDay > 1) poi.lootedDay = lootedDay;
    if (lastVisit) poi.lastVisit = lastVisit;
    return poi;
  }).filter((p) => p.type);
}

/**
 * 存檔格式：精簡打包、版本遷移。
 * 遊戲進度只存在雲端帳號；本機 LocalStorage 只用來讀取舊版（v2.1 以前）留下的存檔，
 * 讓玩家註冊帳號時可以把它轉移上去。
 */
export class SaveManager {
  /** 舊版本機存檔（沒有則回傳 null） */
  static legacyLoad() {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return null;
      const data = SaveManager.migrate(JSON.parse(raw));
      return data?.player ? data : null;
    } catch (err) {
      console.error('[SaveManager] legacy load failed', err);
      return null;
    }
  }

  /** 舊版本機存檔已轉移到帳號後刪除 */
  static clearLegacy() {
    try {
      localStorage.removeItem(SAVE_KEY);
      localStorage.removeItem('jdqs_cloud_v1');
    } catch {
      /* ignore */
    }
  }

  /**
   * 轉為儲存/上傳用的精簡格式（不修改傳入的狀態）。
   * 雲端存檔使用此格式；讀取時由 migrate() 還原。
   */
  static pack(state) {
    const { pois, ...map } = state.map;
    return { ...state, map: { ...map, poiPack: packPois(pois) } };
  }

  /**
   * 雲端主存檔：不含地圖建築（上千棟、很少變動），只記錄今天被搜刮的建築。
   * 建築清單另存一份（packMap），只有重新掃描時才上傳，讓每次事件的即時存檔保持輕量。
   */
  static packMain(state) {
    const { pois, ...map } = state.map;
    const looted = {};
    pois.forEach((p) => { if (p.lootedDay) looted[p.id] = p.lootedDay; });
    return { ...state, map: { ...map, poisExternal: true, looted } };
  }

  /** 地圖建築清單（不含搜刮紀錄） */
  static packMap(state) {
    const pois = state.map.pois.map(({ lootedDay, ...p }) => p);
    return { fetchedAt: state.map.fetchedAt, poiPack: packPois(pois) };
  }

  /** 把另存的建築清單合併回主存檔，並套回搜刮紀錄 */
  static mergeMap(state, mapData) {
    const looted = state.map.looted || {};
    state.map.pois = mapData?.poiPack ? unpackPois(mapData.poiPack) : [];
    state.map.pois.forEach((p) => { if (looted[p.id]) p.lootedDay = looted[p.id]; });
    delete state.map.looted;
    delete state.map.poisExternal;
    return state;
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
    // v5：據點依規模調整防禦欄位數（保留已建造的欄位）
    data.bases.forEach((b) => {
      if (b.size) return;
      const poi = (data.map?.pois || []).find((p) => p.id === b.poiId)
        || unpackPois(data.map?.poiPack || { types: [], rows: [] }).find((p) => p.id === b.poiId)
        || { id: b.poiId, type: 'residential' };
      b.size = baseSizeOf(poi);
      const lastBuilt = b.defenses.reduce((m, d, i) => (d.type ? i : m), -1);
      const len = Math.max(BASE_SIZES[b.size].slots, lastBuilt + 1);
      b.defenses = Array.from({ length: len }, (_, slot) => b.defenses[slot] || { slot, type: null, level: 0, garrisonId: null });
    });
    data.recruitOffer = data.recruitOffer || null;
    // v6：避難所只有一座，其他據點轉為前哨站；新增載具與 NPC 據點
    data.bases.forEach((b) => {
      if (!b.kind) b.kind = b.id === data.primaryBaseId || (!data.primaryBaseId && b === data.bases[0]) ? 'shelter' : 'outpost';
    });
    if (!data.bases.some((b) => b.id === data.primaryBaseId && b.kind === 'shelter')) {
      data.primaryBaseId = data.bases.find((b) => b.kind === 'shelter')?.id || null;
    }
    data.vehicles = data.vehicles || [];
    // v7：研究改為等級制；裝備改為具體型號；每小時固定出現的倖存者
    const rs = data.research || {};
    if (!rs.levels) {
      rs.levels = {};
      (rs.completed || []).forEach((id) => {
        const [nid, lv] = LEGACY_RESEARCH[id] || [];
        if (nid) rs.levels[nid] = Math.max(rs.levels[nid] || 0, lv);
      });
      delete rs.completed;
    }
    if (rs.active && (!RESEARCH[rs.active.id] || !rs.active.level)) rs.active = null;
    data.research = { levels: rs.levels, active: rs.active || null };
    (data.inventory?.items || []).forEach((it) => {
      if (it.model && ITEM_MODELS[it.model]) return;
      const candidates = Object.entries(ITEM_MODELS).filter(([, md]) => md.type === it.type);
      const named = candidates.find(([, md]) => String(it.name || '').includes(md.name));
      const [mid, md] = named || candidates.sort((a, b) => a[1].tier - b[1].tier)[0] || [];
      if (!mid) return;
      it.model = mid;
      it.cat = it.type;
      it.tier = md.tier;
    });
    (data.inventory?.blueprints || []).forEach((bp) => {
      if (bp.model) return;
      bp.model = Object.entries(ITEM_MODELS).filter(([, md]) => md.type === bp.itemType).sort((a, b) => a[1].tier - b[1].tier)[1]?.[0]
        || Object.keys(ITEM_MODELS)[0];
    });
    data.recruitBoard = data.recruitBoard || { list: [], refreshAt: 0 };
    // v11：倉庫分為消耗品倉庫與物品倉庫（沿用原倉庫等級，避免格子變少）
    data.bases.forEach((b) => {
      if (b.facilities && !b.facilities.itemStore) b.facilities.itemStore = { level: b.kind === 'outpost' ? 0 : Math.max(1, b.facilities.warehouse?.level || 1) };
    });
    data.map = data.map || {};
    data.map.detected = data.map.detected || {};
    // v10：物品位置（倉庫或隊員背包）
    (data.inventory?.items || []).forEach((it) => { if (!it.loc) it.loc = 'store'; });
    // v8：隨機結果種子
    data.rng = { ...newSeeds(), ...(data.rng || {}) };
    // v10：與其他玩家的關係
    data.relations = { players: {}, requestsIn: {}, requestsOut: {}, ...(data.relations || {}) };
    data.npcs = data.npcs || { list: [], nextSpawnAt: 0 };
    // v3 -> v4：品級改為 6 階（舊的灰色「普通」→「劣質」），裝備欄新增手套、鞋子、飾品
    if (v < 4) {
      (data.inventory?.items || []).forEach((it) => { if (it.rarity === 'common') it.rarity = 'poor'; });
    }
    (data.survivors || []).concat(data.recruitPool || []).forEach((sv) => {
      // v4 -> v5：受傷計時改為生命值 / 重傷制，倖存者新增品級
      if (v < 5) {
        sv.rarity = sv.rarity || (sv.isLeader ? 'uncommon' : 'common');
        sv.hp = null;
        sv.severe = false;
        sv.zeroSince = 0;
        delete sv.injuredUntil;
      }
      sv.equipment = sv.equipment || {};
      sv.bag = sv.bag || {};
      if (sv.isLeader) sv.rarity = null; // v9：主角沒有品級
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
    // v12：金屬、布料、藥品不再是基本資源，換算成零件、布料、藥品物品
    if (v < 12 && data.resources) {
      const res = data.resources;
      const toSupplies = (src) => {
        const conv = legacyToSupplies(src);
        delete src.metal;
        delete src.cloth;
        delete src.medicine;
        return conv;
      };
      data.supplies = data.supplies || {};
      Object.entries(toSupplies(res)).forEach(([k, n]) => { data.supplies[k] = (data.supplies[k] || 0) + n; });
      (data.survivors || []).forEach((sv) => {
        Object.entries(toSupplies(sv.bag || {})).forEach(([k, n]) => { sv.bag[k] = (sv.bag[k] || 0) + n; });
      });
      (data.npcs?.list || []).forEach((n) => { if (n.resources) toSupplies(n.resources); });
    }
    // v12：主線任務新增項目，舊的進度依任務 ID 換算到新的位置
    if (v < 12 && data.quests && Number.isInteger(data.quests.mainIndex)) {
      const OLD_MAIN = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9', 'm10', 'm11', 'm12', 'm12b', 'm12c', 'm13'];
      const id = OLD_MAIN[data.quests.mainIndex];
      data.quests.mainIndex = id ? Math.max(0, MAIN_QUESTS.findIndex((q) => q.id === id)) : MAIN_QUESTS.length;
    }
    // v13：遊戲一天由現實 30 分鐘改為 1 小時；調整建檔時間，讓目前的天數與時刻維持不變
    if (v < 13 && Number.isFinite(data.createdAt)) {
      const now = Date.now();
      data.createdAt = now - Math.max(0, now - data.createdAt) * 2;
    }
    // v14：雨水收集器改為伐木場（保留等級），淨水科技改為伐木技術
    if (v < 14) {
      (data.bases || []).forEach((b) => {
        const f = b.facilities;
        if (f && !f.lumberMill) f.lumberMill = { level: f.rainCollector?.level || 0 };
        if (f) delete f.rainCollector;
        (b.buildQueue || []).forEach((q) => { if (q.id === 'rainCollector') q.id = 'lumberMill'; });
      });
      const rs = data.research;
      if (rs?.levels && 'a_rain' in rs.levels) {
        rs.levels.a_lumber = Math.max(rs.levels.a_lumber || 0, rs.levels.a_rain);
        delete rs.levels.a_rain;
      }
      if (rs?.active?.id === 'a_rain') rs.active.id = 'a_lumber';
    }
    // v15：新增宿舍（人數上限需要宿舍）。舊存檔依現有人數給予足夠等級，不會有人被趕走
    if (v < 15) {
      const n = (data.survivors || []).length;
      const need = n > 1 ? Math.max(1, n - 2) : 0;
      (data.bases || []).forEach((b) => {
        if (!b.facilities || b.facilities.dormitory) return;
        b.facilities.dormitory = { level: b.kind === 'outpost' ? 0 : need };
      });
    }
    data.supplies = data.supplies || {};
    data.defenseLog = data.defenseLog || [];
    if (data.map) {
      data.map.markers = data.map.markers || [];
      data.map.remain = data.map.remain || {};
    }
    data.version = SAVE_VERSION;
    return data;
  }
}
