import { inWorld, WORLD_CENTER } from '../config/world.js';
import { FACILITIES } from '../config/facilities.js';
import { SAVE_KEY, SAVE_VERSION } from '../config/constants.js';
import { STAT_KEYS, newSeeds } from './GameState.js';
import { POI_KEYS } from '../config/poiTypes.js';
import { SLOT_KEYS, ITEM_MODELS } from '../config/equipment.js';
import {
  RESEARCH, LEGACY_RESEARCH, REMOVED_RESEARCH, researchCost,
} from '../config/research.js';
import { BASE_SIZES, baseSizeOf, FACILITY_CAP_REFUND, baseEstablishCost } from '../config/civilization.js';
import { DEFENSES } from '../config/defenses.js';
import { legacyToSupplies } from '../config/supplies.js';
import { MAIN_QUESTS } from '../config/quests.js';
import { rollQualities } from '../config/survivors.js';

/** v12 移除的擴張科技 */
const OUTPOST_RESEARCH = ['e_outpost', 'e_cost', 'e_wall'];

/** 把退還的材料加回存檔（金錢、零件、資源、物品倉庫） */
function grantRaw(data, refund) {
  Object.entries(refund).forEach(([k, n]) => {
    if (!(n > 0)) return;
    if (k === 'coins') data.player.coins = (data.player.coins || 0) + n;
    else if (k === 'parts') data.player.parts = (data.player.parts || 0) + n;
    else {
      const pool = data.resources && k in data.resources ? data.resources : (data.supplies = data.supplies || {});
      pool[k] = (pool[k] || 0) + n;
    }
  });
}

/**
 * v12：移除前哨站與擴張科技，全部全額退還。
 * 前哨站：建立費用、設施與防禦建築的建造材料、施工佇列中已扣的材料；駐守資料跟著據點一起移除（倖存者留在避難所）。
 * 擴張科技（前哨站、前哨後勤、前哨工事）：已研究等級的研究材料、研究中與排隊中已扣的材料。
 */
function removeOutposts(data, rs) {
  const refund = {};
  const add = (cost) => Object.entries(cost || {}).forEach(([k, n]) => { if (Number.isFinite(n)) refund[k] = (refund[k] || 0) + n; });
  const outposts = (data.bases || []).filter((b) => b.kind === 'outpost');
  outposts.forEach((b, i) => {
    add(baseEstablishCost(i + 1));
    Object.entries(b.facilities || {}).forEach(([id, f]) => {
      if (!FACILITIES[id]) return;
      for (let lv = (id === 'wall' ? 1 : 0) + 1; lv <= (f?.level || 0); lv += 1) add(FACILITIES[id].cost(lv));
    });
    (b.defenses || []).forEach((d) => {
      if (!d?.type || !DEFENSES[d.type]) return;
      for (let lv = 1; lv <= (d.level || 0); lv += 1) add(DEFENSES[d.type].cost(lv));
    });
    (b.buildQueue || []).forEach((q) => add(q.cost));
  });
  const names = outposts.map((b) => b.name);
  if (outposts.length) {
    data.bases = data.bases.filter((b) => b.kind !== 'outpost');
  }
  let researched = false;
  OUTPOST_RESEARCH.forEach((id) => {
    const lv = rs.levels?.[id] || 0;
    for (let i = 1; i <= lv; i += 1) add(researchCost(id, i, REMOVED_RESEARCH[id]));
    if (lv) researched = true;
    if (rs.levels) delete rs.levels[id];
  });
  ['active', 'active2'].forEach((k) => {
    if (rs[k] && OUTPOST_RESEARCH.includes(rs[k].id)) { add(rs[k].cost); rs[k] = null; researched = true; }
  });
  if (Array.isArray(rs.queue)) {
    rs.queue.filter((q) => q && OUTPOST_RESEARCH.includes(q.id)).forEach((q) => { add(q.cost); researched = true; });
    rs.queue = rs.queue.filter((q) => !q || !OUTPOST_RESEARCH.includes(q.id));
  }
  if (!outposts.length && !researched) return;
  Object.keys(refund).forEach((k) => { refund[k] = Math.round(refund[k]); });
  grantRaw(data, refund);
  data.log = data.log || [];
  data.log.unshift({ t: Date.now(), msg: `🏴 前哨站與擴張科技已移除${names.length ? `：拆除前哨站「${names.join('」「')}」` : ''}，建造與研究材料全額退還`, type: 'info' });
}

/** 依字串產生固定的亂數（同一位倖存者重新讀檔也得到相同素質） */
function idRandom(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 地圖建築改以「欄位陣列」儲存（市區可達數千棟，物件格式體積約大一倍）：
 * [id, 類型索引, 名稱, 緯度, 經度, 是否 OSM(1/0), 被搜刮的日期編號, 最後探索時間, 被誰搜刮（'self'／'n:NPC 名稱'，可省略）]
 */
const packLootedBy = (p) => (p.lootedBy && p.lootedBy.day === p.lootedDay ? (p.lootedBy.kind === 'npc' ? `n:${p.lootedBy.name}` : 'self') : 0);
function packPois(pois) {
  return {
    types: POI_KEYS,
    rows: pois.map((p) => [p.id, POI_KEYS.indexOf(p.type), p.name, p.lat, p.lon, p.osm ? 1 : 0, p.lootedDay || 0, p.lastVisit || 0, ...(packLootedBy(p) ? [packLootedBy(p)] : [])]),
  };
}

function unpackPois({ types, rows }) {
  return rows.map(([id, t, name, lat, lon, osm, lootedDay, lastVisit, by]) => {
    const poi = { id, type: types[t], name, lat, lon, osm: !!osm };
    // v4 以前此欄為枯竭度（小數），不再使用；整數才是被搜刮的日期編號
    if (Number.isInteger(lootedDay) && lootedDay > 1) poi.lootedDay = lootedDay;
    if (by && poi.lootedDay) poi.lootedBy = String(by).startsWith('n:') ? { kind: 'npc', name: String(by).slice(2), day: poi.lootedDay } : { kind: 'self', day: poi.lootedDay };
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
    // v12：移除前哨站與擴張科技（每次載入都檢查，舊存檔或其他裝置的舊資料都會處理到）
    removeOutposts(data, rs);
    if (rs.active && (!RESEARCH[rs.active.id] || !rs.active.level)) rs.active = null;
    if (rs.active2 && (!RESEARCH[rs.active2.id] || !rs.active2.level)) rs.active2 = null;
    // 研究佇列與剛完成標示也要保留（之前載入時被清掉，排隊中的研究與已扣的材料會消失）
    const queue = (Array.isArray(rs.queue) ? rs.queue : []).filter((q) => q && RESEARCH[q.id] && q.level > 0);
    data.research = {
      levels: rs.levels, active: rs.active || null, ...(rs.active2 ? { active2: rs.active2 } : {}), queue, ...(rs.fresh && typeof rs.fresh === 'object' ? { fresh: rs.fresh } : {}),
    };
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
    // v16：新增診療室（休息回復需要診療室）。舊存檔的避難所贈送 Lv1，避免原本的回復突然消失
    if (v < 16) {
      (data.bases || []).forEach((b) => {
        if (b.facilities && !b.facilities.clinic) b.facilities.clinic = { level: b.kind === 'outpost' ? 0 : 1 };
      });
    }
    if (v < 21) {
      // v9.9：倖存者能力素質（每項 0～100%）。所有非首領的倖存者與候選人重新隨機
      const list = [...(data.survivors || []), ...(data.recruitPool || []), ...(data.recruitBoard?.list || []), ...(data.recruitOffer || [])];
      list.forEach((sv) => { if (sv && !sv.isLeader) sv.quality = rollQualities(idRandom(`q:${sv.id}`)); });
    }
    if (v < 20) {
      // v9.6：全服聊天（封鎖名單、已讀位置）
      if (!data.chat || typeof data.chat !== 'object') data.chat = { blocked: [], seenId: 0 };
    }
    if (v < 19) {
      // v9.2：移除「巡迴搜索」研究（自動探索不再換地點）；進行中的研究退回待研究
      if (data.research?.levels) delete data.research.levels.s_route;
      if (data.research?.active?.id === 's_route') {
        // 退還已支付的研究材料
        Object.entries(data.research.active.cost || {}).forEach(([k, n]) => {
          const pool = data.resources && k in data.resources ? data.resources : (data.supplies = data.supplies || {});
          pool[k] = (pool[k] || 0) + (Number(n) || 0);
        });
        data.research.active = null;
      }
      (data.expeditions || []).forEach((e) => { delete e.autoHops; });
    }
    if (v < 18) {
      // v9：武器欄拆成遠程與近戰；新增彈藥欄與藥品欄
      // 流浪商人改為全體共用的黑市
      delete data.trader;
      // NPC 據點改為所有玩家共用（重新產生）
      data.npcs = { list: [], nextSpawnAt: 0 };
      // 移除派人交易與派人交付：收購保留的金錢退還，交易／交付中的倖存者帶著背包裡的物品直接回到避難所
      (data.demands?.list || []).forEach((d) => {
        const left = Math.max(0, (d.qty || 0) - (d.filled || 0));
        if (data.player) data.player.coins = (data.player.coins || 0) + left * (d.price || 0);
      });
      delete data.demands;
      delete data.trade;
      const ended = (data.expeditions || []).filter((e) => e.kind === 'trade' || e.kind === 'deliver');
      ended.forEach((e) => (e.memberIds || []).forEach((id) => {
        const sv = (data.survivors || []).find((x) => x.id === id);
        if (sv && sv.status === 'exploring') sv.status = 'idle';
      }));
      if (ended.length) {
        data.expeditions = data.expeditions.filter((e) => !ended.includes(e));
        (data.vehicles || []).forEach((v) => { if (ended.some((e) => (e.vehicleIds || []).includes(v.id))) v.status = 'idle'; });
      }
      const items = data.inventory?.items || [];
      (data.survivors || []).forEach((sv) => {
        sv.equipment = sv.equipment || {};
        if (!('melee' in sv.equipment)) sv.equipment.melee = null;
        const w = items.find((i) => i.id === sv.equipment.weapon);
        if (w && w.type === 'melee') {
          sv.equipment.melee = w.id;
          sv.equipment.weapon = null;
        }
        sv.loadout = sv.loadout || { ammo: null, med: null };
      });
      items.forEach((i) => { if (i.type === 'melee') i.slot = 'melee'; });
    }
    // 新增的設施（例如地窖）：舊據點補上 Lv0
    (data.bases || []).forEach((b) => {
      if (!b.facilities) return;
      Object.keys(FACILITIES).forEach((id) => { if (!b.facilities[id]) b.facilities[id] = { level: 0 }; });
    });
    data.supplies = data.supplies || {};
    data.defenseLog = data.defenseLog || [];
    if (data.map) {
      data.map.markers = data.map.markers || [];
      data.map.remain = data.map.remain || {};
    }
    if (v < 22) {
      // v9.10：設施等級依據點規模設上限（小型 Lv8、中型 Lv11、大型 Lv13、巨型 Lv15）。
      // 超過的設施降到上限，降掉的等級退還 50% 建造材料；目標超過上限的施工取消並全額退還
      const give = (k, n) => {
        if (!(n > 0)) return;
        if (k === 'coins') { data.player.coins = (data.player.coins || 0) + n; return; }
        const pool = data.resources && k in data.resources ? data.resources : (data.supplies = data.supplies || {});
        pool[k] = (pool[k] || 0) + n;
      };
      const notes = [];
      (data.bases || []).forEach((b) => {
        const cap = BASE_SIZES[b.size]?.facMax;
        if (!cap || !b.facilities) return;
        b.buildQueue = (b.buildQueue || []).filter((q) => {
          if (q.kind !== 'facility' || q.targetLevel <= cap) return true;
          Object.entries(q.cost || {}).forEach(([k, n]) => give(k, n));
          return false;
        });
        Object.entries(b.facilities).forEach(([id, f]) => {
          if (!FACILITIES[id] || !(f.level > cap)) return;
          const refund = {};
          for (let lv = cap + 1; lv <= f.level; lv += 1) {
            Object.entries(FACILITIES[id].cost(lv)).forEach(([k, n]) => { refund[k] = (refund[k] || 0) + n; });
          }
          Object.entries(refund).forEach(([k, n]) => give(k, Math.floor(n * FACILITY_CAP_REFUND)));
          notes.push(`${FACILITIES[id].name} Lv${f.level}→Lv${cap}`);
          f.level = cap;
          b.wallHp = null;
        });
      });
      if (notes.length && Array.isArray(data.log)) {
        data.log.unshift({ t: Date.now(), msg: `🏗️ 設施等級改為依據點規模設上限：${notes.join('、')}，已退還 ${Math.round(FACILITY_CAP_REFUND * 100)}% 建造材料`, type: 'info' });
      }
    }
    if (v < 25) {
      // v9.25：移除黑市專屬保留區與研究「黑市商人的厚愛」：全額退還研究材料（含研究中、排隊中）
      delete data.bmVip;
      // v9.25：戰鬥明細改為跟著探索報告與避難所紀錄保存；舊紀錄無法得知屬於哪一場，不保留
      data.battles = [];
      data.bmBought = null;
      const R = data.research || {};
      const refund = {};
      const add = (cost) => Object.entries(cost || {}).forEach(([k, n]) => { refund[k] = (refund[k] || 0) + n; });
      const lv = R.levels?.t_bm_vip || 0;
      for (let i = 1; i <= lv; i += 1) add(researchCost('t_bm_vip', i, REMOVED_RESEARCH.t_bm_vip));
      if (R.active?.id === 't_bm_vip') { add(R.active.cost); R.active = null; }
      if (Array.isArray(R.queue)) {
        R.queue.filter((q) => q.id === 't_bm_vip').forEach((q) => add(q.cost));
        R.queue = R.queue.filter((q) => q.id !== 't_bm_vip');
      }
      if (R.levels) delete R.levels.t_bm_vip;
      if (Object.keys(refund).length) {
        Object.entries(refund).forEach(([k, n]) => {
          if (k === 'coins') data.player.coins = (data.player.coins || 0) + n;
          else if (k === 'parts') data.player.parts = (data.player.parts || 0) + n;
          else {
            const pool = data.resources && k in data.resources ? data.resources : (data.supplies = data.supplies || {});
            pool[k] = (pool[k] || 0) + n;
          }
        });
        data.log = data.log || [];
        data.log.unshift({ t: Date.now(), msg: '🕶️ 黑市改為定時全部換新、每輪限購：移除「專屬保留區」與研究「黑市商人的厚愛」，已全額退還研究材料', type: 'info' });
      }
    }
    if (v < 26) {
      // v9.26：黑市改為每 30 分鐘換新：購買紀錄改存成清單（舊的一輪紀錄已過期，直接清空）
      data.bmBought = null;
    }
    if (v < 28) {
      // v10.12：新增「就是要鎖你」（貨幣，不佔物品格）、重生器（設施於下方自動補 Lv0）、黑市特殊品每日購買紀錄
      if (data.player) data.player.locks = Math.max(0, Math.floor(data.player.locks || 0));
      data.bmSpecial = data.bmSpecial || null;
    }
    if (v < 30) {
      // v11.1：研究中心 Lv10 起第二研究位（research.active2）；沒有的補 null
      if (data.research && !data.research.active2) data.research.active2 = null;
    }
    if (v < 29) {
      // v11：地下感染區（多人副本）：報名紀錄、副本核心材料（不佔倉庫格子）
      data.dungeon = data.dungeon && typeof data.dungeon === 'object' ? data.dungeon : { sign: {} };
      data.dungeon.sign = data.dungeon.sign || {};
      data.dgCores = data.dgCores && typeof data.dgCores === 'object' ? data.dgCores : {};
    }
    if (v < 27) {
      // v10：地圖地點改為固定格子產生（載入後重新產生，據點與探索目的地保留）；建築殘留物資改為所有玩家共用
      delete data.map.remain;
      if (Array.isArray(data.log)) data.log.unshift({ t: Date.now(), msg: '🗺️ v10：地圖上的地點改為隨機產生（所有玩家相同），你的據點與正在前往的地點都保留', type: 'info' });
    }
    if (v < 23 && data.research?.levels?.r_board) {
      // v9.17：情報網改為 3 級（每級 +1）：舊等級每 5 級 +1 換算成新等級，效果不變
      const old = data.research.levels.r_board;
      data.research.levels.r_board = Math.min(3, Math.floor(old / 5));
      if (!data.research.levels.r_board) delete data.research.levels.r_board;
      if (data.research.active?.id === 'r_board') {
        // 研究中的情報網：取消並全額退還（新的等級規則不同）
        Object.entries(data.research.active.cost || {}).forEach(([k, n]) => {
          const pool = data.resources && k in data.resources ? data.resources : (data.supplies = data.supplies || {});
          if (k === 'coins') data.player.coins = (data.player.coins || 0) + n;
          else pool[k] = (pool[k] || 0) + n;
        });
        data.research.active = null;
      }
      if (Array.isArray(data.research.queue)) data.research.queue = data.research.queue.filter((q) => q.id !== 'r_board');
      data.log = data.log || [];
      data.log.unshift({ t: Date.now(), msg: `🔬 情報網改為 3 級（每級每小時倖存者 +1）：原本 Lv${old} 換算為 Lv${Math.min(3, Math.floor(old / 5))}，效果不變`, type: 'info' });
    }
    // 指定給臨時小隊的載具：小隊已不存在時歸還車庫
    (data.vehicles || []).forEach((v) => {
      if (v.status !== 'reserved') return;
      const exp = (data.expeditions || []).find((e) => e.id === v.reservedFor);
      if (!exp || !(exp.nextVehicleIds || []).includes(v.id)) {
        v.status = 'idle';
        delete v.reservedFor;
      }
    });
    if (v < 32 && data.map) {
      // v13：固定世界地圖。地圖中心在範圍外時改到範圍中心（範圍外的避難所在遊戲開始時整座搬進範圍內）
      const c = data.map.center;
      if (!c || !inWorld(c.lat, c.lon)) data.map.center = { ...WORLD_CENTER };
    }
    data.version = SAVE_VERSION;
    return data;
  }
}
