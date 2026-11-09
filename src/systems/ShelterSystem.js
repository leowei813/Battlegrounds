import { BUILD_QUEUE_SIZE } from '../config/constants.js';
import {
  FACILITIES, FACILITY_MAX_LEVEL, cellarCap, cellarCoins, cellarMatCap, facilityBuildTime, wallMaxHp, OUTPOST_FACILITIES, REPAIR,
} from '../config/facilities.js';
import { RESOURCE_KEYS } from '../config/constants.js';
import { JOBS } from '../config/survivors.js';
import { DEFENSES, DEFENSE_MAX_LEVEL, defenseBuildTime } from '../config/defenses.js';
import { RESEARCH } from '../config/research.js';
import { POI_TYPES } from '../config/poiTypes.js';
import {
  PRIMARY_DANGER_COEF, baseEstablishCost, BASE_SIZES, FACILITY_COUNT, baseSizeOf, ABANDON_REFUND, RELOCATE_DEFENSE_REFUND, RELOCATE_KEEP, FACILITY_CAP_REFUND, MAX_OUTPOSTS,
} from '../config/civilization.js';
import { createBase } from '../core/GameState.js';
import { SUPPLIES } from '../config/supplies.js';
import { canAfford, payCost, scaleCost } from './costUtils.js';
import { inWorld } from '../config/world.js';
import { inPlayerSafe } from '../config/zones.js';
import { DUNGEONS, DG_CLEAR_M } from '../config/dungeons.js';
import { haversine } from '../utils/math.js';

/** 屍潮範圍在地圖上的最小比例（完整大小約半徑 225 公尺） */
export const SIEGE_RANGE = { min: 0.4, fullM: 225 };

/**
 * 據點系統：
 *  - 避難所（只能一座）：倖存者居住、生產、探索出發、駐守倖存者防衛的地方。
 *  - 前哨站（研究「前哨站」科技解鎖，最多 3 座）：只有圍牆、探照燈與防禦建築，不能生產。
 * 每個據點有自己的設施、防禦建築、圍牆與施工佇列；據點可以放棄，退還 25% 建造資源。
 *
 * 大多數方法第一個參數為據點（物件或 ID），省略時代表避難所。
 */
/**
 * 取消施工／研究的退還：完成度越高退得越少（未開始 90% → 完成 0%）。
 * @param {{startAt:number, endAt:number, cost?:object}} q
 * @param {() => object} fallback 舊資料沒有記錄費用時重新計算
 */
export function cancelRefund(q, now, fallback) {
  const total = Math.max(1, q.endAt - q.startAt);
  const done = Math.min(1, Math.max(0, (now - q.startAt) / total));
  const ratio = Math.max(0, 0.9 * (1 - done));
  const cost = Object.fromEntries(Object.entries(q.cost || fallback()).map(([k, v]) => [k, Math.floor(v * ratio)]).filter(([, v]) => v > 0));
  return { ratio, done, cost };
}

export class ShelterSystem {
  constructor(game) {
    this.game = game;
  }

  get bases() {
    return this.game.state.bases;
  }

  base(id) {
    return this.bases.find((b) => b.id === id) || null;
  }

  /** 避難所（沒有則為 null） */
  primary() {
    const b = this.base(this.game.state.primaryBaseId);
    return b && b.kind !== 'outpost' ? b : null;
  }

  isOutpost(b) {
    return this.resolve(b)?.kind === 'outpost';
  }

  outposts() {
    return this.bases.filter((b) => b.kind === 'outpost');
  }

  /** 可建立的前哨站數量（研究解鎖） */
  outpostLimit() {
    return 0; // v12：前哨站已移除
  }

  /** 據點物件 / ID / undefined（主要據點）→ 據點物件 */
  resolve(b) {
    if (!b) return this.primary();
    return typeof b === 'string' ? this.base(b) : b;
  }

  isPrimary(b) {
    return !!b && this.resolve(b)?.id === this.primary()?.id;
  }

  hasShelter() {
    return !!this.primary();
  }

  baseAtPoi(poiId) {
    return this.bases.find((b) => b.poiId === poiId) || null;
  }

  poiOf(b) {
    return this.game.state.map.pois.find((p) => p.id === b.poiId) || null;
  }

  // ---------- 跨據點彙總 ----------

  /** 該設施的等級（研究中心、工作台等只在避難所運作；圍牆、探照燈取所有據點最高） */
  maxLevel(fid) {
    const bases = OUTPOST_FACILITIES.includes(fid) ? this.bases : this.bases.filter((b) => b.kind !== 'outpost');
    return bases.reduce((m, b) => Math.max(m, b.facilities[fid].level), 0);
  }

  /** 地窖保護的數量（金錢用 coins） */
  cellarProtect(key) {
    const lv = this.maxLevel('cellar');
    if (key === 'coins') return cellarCoins(lv);
    const cat = SUPPLIES[key]?.cat;
    if (cat === 'part' || cat === 'fabric') return cellarMatCap(lv);
    return cellarCap(lv);
  }

  /** 地窖目前實際藏起的數量：每種基礎物資、金錢，以及零件／布料合計（給畫面顯示） */
  cellarStatus() {
    const lv = this.maxLevel('cellar');
    const st = this.game.state;
    const res = Object.fromEntries(RESOURCE_KEYS.map((k) => [k, Math.min(Math.floor(st.resources[k] || 0), cellarCap(lv))]));
    const coins = Math.min(Math.floor(st.player.coins || 0), cellarCoins(lv));
    let mats = 0;
    let matKinds = 0;
    Object.entries(st.supplies || {}).forEach(([k, n]) => {
      const cat = SUPPLIES[k]?.cat;
      if ((cat !== 'part' && cat !== 'fabric') || !(n > 0)) return;
      mats += Math.min(n, cellarMatCap(lv));
      matKinds += 1;
    });
    return { lv, cap: cellarCap(lv), coinCap: cellarCoins(lv), matCap: cellarMatCap(lv), res, coins, mats, matKinds };
  }

  /** 會被掠奪的數量：超過地窖容量的部分 */
  exposed(key) {
    const have = key === 'coins' ? this.game.state.player.coins : this.game.state.resources[key] || 0;
    return Math.max(0, have - this.cellarProtect(key));
  }

  /** 所有據點中該設施的等級總和 */
  totalLevel(fid) {
    return this.bases.reduce((s, b) => s + b.facilities[fid].level, 0);
  }

  /**
   * 據點規模資訊（據點或尚未建立的建築皆可查詢）
   * @returns {{id:string, name:string, slots:number, total:number}}
   */
  sizeInfo(baseOrPoi) {
    const id = baseOrPoi?.size || baseSizeOf(baseOrPoi);
    const size = BASE_SIZES[id];
    const slots = baseOrPoi?.defenses ? baseOrPoi.defenses.length : size.slots;
    return { id, name: size.name, slots, total: FACILITY_COUNT + slots };
  }

  /** 據點等級：該據點所有設施等級的平均（無條件捨去），用於人員上限 */
  baseLevel(b) {
    const base = this.resolve(b);
    if (!base) return 0;
    const levels = Object.values(base.facilities).map((f) => f.level);
    return Math.floor(levels.reduce((s, l) => s + l, 0) / levels.length);
  }

  defenseCount() {
    return this.bases.reduce((s, b) => s + b.defenses.filter((d) => d.level > 0).length, 0);
  }

  // ---------- 危險度 ----------

  /** 據點本身（建築類型）的危險度 */
  baseDanger(b) {
    const poi = this.poiOf(b);
    return poi ? POI_TYPES[poi.type].danger : 1;
  }

  /**
   * 據點危險度：建築基礎危險度；主要據點再依文明度 × 係數提高。
   * @returns {number} 保留一位小數
   */
  dangerLevel(b) {
    const base = this.resolve(b);
    if (!base) return 1;
    const extra = this.isPrimary(base) ? this.game.civilization.value() * PRIMARY_DANGER_COEF : 0;
    return Math.round((this.baseDanger(base) + extra) * 10) / 10;
  }

  // ---------- 建立 / 放棄 ----------

  /** 下一個要建立的據點類型：沒有避難所時建立避難所，否則為前哨站 */
  nextKind() {
    return this.primary() ? 'outpost' : 'shelter';
  }

  establishCost() {
    return this.primary() ? scaleCost(baseEstablishCost(this.outposts().length + 1), Math.max(0.3, 1 - this.game.research.bonus('establishCostReduce'))) : {};
  }

  canEstablish(poi) {
    if (!poi) return { ok: false, reason: '找不到地點' };
    if (this.baseAtPoi(poi.id)) return { ok: false, reason: '這裡已經是你的據點' };
    // 重度感染據點位置固定：據點（含警戒範圍）不能和它重疊
    // v14：避難所一律比照巨型的警戒範圍
    const inf = this.game.infected?.blocking(poi, BASE_SIZES[this.primary() ? baseSizeOf(poi) : 'huge']?.alert || 80);
    if (inf) return { ok: false, reason: `這裡太靠近重度感染據點「${inf.name}」，無法建立據點` };
    // v14：避難所只能建在左側安全區（玩家據點區）
    if (this.game.state.map?.source === 'generated' && !inPlayerSafe(poi.lat, poi.lon)) return { ok: false, reason: '避難所只能建在地圖左側的安全區' };
    // v12：前哨站已移除，只能有一座避難所（搬遷時先放棄原本的避難所）
    if (this.primary()) return { ok: false, reason: '已經有避難所了' };
    if (!canAfford(this.game.state, this.establishCost())) return { ok: false, reason: '資源不足' };
    return { ok: true };
  }

  /** 在地點建立據點：沒有避難所時建立避難所（免費），否則建立前哨站 */
  establish(poi) {
    const check = this.canEstablish(poi);
    if (!check.ok) return check;
    payCost(this.game.state, this.establishCost());
    const kind = this.nextKind();
    const base = createBase(poi, kind);
    if (kind === 'shelter') base.size = 'huge'; // v14：避難所一律比照巨型
    // 搬遷：保留原本避難所的設施等級
    const reloc = kind === 'shelter' ? this.game.state.relocation : null;
    if (reloc?.facilities) {
      Object.entries(reloc.facilities).forEach(([fid, f]) => {
        if (base.facilities[fid]) base.facilities[fid].level = Math.max(base.facilities[fid].level, Math.round(Number(f.level) || 0));
      });
      base.wallHp = null;
      delete this.game.state.relocation;
    }
    this.bases.push(base);
    if (kind === 'shelter') this.game.state.primaryBaseId = base.id;
    // 新地點較小：超過上限的設施降級並退還 50% 材料
    if (reloc?.facilities) {
      const capped = this.capFacilities(base);
      if (capped.changes.length) {
        this.game.log(`🏗️ 新避難所規模較小，${capped.changes.map((c) => `${FACILITIES[c.id].name} Lv${c.from}→Lv${c.to}`).join('、')}，退還 ${Math.round(FACILITY_CAP_REFUND * 100)}% 建造材料`, 'info');
      }
    }
    this.game.civilization.invalidate();
    this.game.log(`🏠 ${kind === 'shelter' ? '建立避難所' : '建立前哨站'}於「${poi.name}」`, 'success');
    // v10：新據點周圍的地點直接產生（不需要重新掃描）
    if (this.game.state.map.source === 'generated') {
      this.game.genMap();
      this.game.bus.emit('map:changed');
    }
    this.game.bus.emit('shelter:changed');
    return { ok: true, base, msg: kind === 'shelter' ? `避難所設於 ${poi.name}` : `已在 ${poi.name} 建立前哨站` };
  }

  /**
   * v13：避難所在固定地圖範圍外時，整座搬到範圍內的空地（設施、防禦、倉庫全部保留，不扣資源）。
   * 優先選同規模的建築，避開其他玩家的據點、重度感染據點與地下感染區入口。
   * @returns {object|null} 新地點
   */
  moveIntoWorld(rnd = Math.random) {
    const sh = this.primary();
    if (!sh || inWorld(sh.lat, sh.lon)) return null;
    const g = this.game;
    const others = (g.world?.others || []).flatMap((p) => p.bases || []);
    const alert = BASE_SIZES[sh.size]?.alert || 80;
    const free = (g.state.map.pois || []).filter((p) => inWorld(p.lat, p.lon, 100) && inPlayerSafe(p.lat, p.lon)
      && !g.infected?.blocking(p, alert)
      && !others.some((b) => haversine(b.lat, b.lon, p.lat, p.lon) < 250)
      && !Object.values(DUNGEONS).some((dg) => haversine(dg.lat, dg.lon, p.lat, p.lon) < DG_CLEAR_M + alert));
    const same = free.filter((p) => baseSizeOf(p) === sh.size);
    const list = same.length ? same : free;
    if (!list.length) return null;
    const poi = list[Math.floor(rnd() * list.length)];
    const from = sh.name;
    Object.assign(sh, { poiId: poi.id, name: poi.name, lat: poi.lat, lon: poi.lon });
    g.state.map.center = { lat: poi.lat, lon: poi.lon };
    this.game.civilization?.invalidate?.();
    g.log(`🗺️ 世界地圖改為固定範圍：避難所從「${from}」整座搬到「${poi.name}」，設施與物資全部保留`, 'info');
    g.bus.emit('shelter:changed');
    return poi;
  }

  /**
   * v14：改版後一次免費重新選擇避難所（只能選左側安全區）。
   * 整座搬過去：設施、防禦建築、圍牆、倉庫資源全部保留，規模沿用原本的避難所。
   */
  canFreeMove(poi) {
    const sh = this.primary();
    if (!this.game.state.freeRelocate) return { ok: false, reason: '已經使用過免費重選' };
    if (!sh) return { ok: false, reason: '還沒有避難所' };
    if (!poi || this.baseAtPoi(poi.id)) return { ok: false, reason: '這裡已經是你的避難所' };
    if (!inPlayerSafe(poi.lat, poi.lon)) return { ok: false, reason: '避難所只能建在地圖左側的安全區' };
    if (this.game.state.expeditions.length) return { ok: false, reason: '有隊伍在外，等隊伍回來再搬' };
    const inf = this.game.infected?.blocking(poi, BASE_SIZES[sh.size]?.alert || 80);
    if (inf) return { ok: false, reason: `這裡太靠近重度感染據點「${inf.name}」` };
    return { ok: true };
  }

  freeMove(poi) {
    const c = this.canFreeMove(poi);
    if (!c.ok) return c;
    const sh = this.primary();
    const from = sh.name;
    Object.assign(sh, { poiId: poi.id, name: poi.name, lat: poi.lat, lon: poi.lon });
    sh.defenses.forEach((d) => { d.garrisonId = d.garrisonId || null; });
    delete this.game.state.freeRelocate;
    this.game.state.map.center = { lat: poi.lat, lon: poi.lon };
    this.game.civilization?.invalidate?.();
    this.game.log(`🏠 免費重新選擇避難所：從「${from}」整座搬到「${poi.name}」，設施、防禦建築與資源全部保留`, 'success');
    this.game.bus.emit('shelter:changed');
    return { ok: true, msg: `避難所已搬到「${poi.name}」` };
  }

  /** 放棄免費重選（不再提醒） */
  skipFreeMove() {
    delete this.game.state.freeRelocate;
    return { ok: true };
  }

  /** 舊 API 相容 */
  setShelter(poi) {
    return this.establish(poi);
  }

  /** 已建造的建築總成本（避難所的初始設施不計） */
  builtCost(base) {
    const total = {};
    const add = (cost) => Object.entries(cost).forEach(([k, v]) => { total[k] = (total[k] || 0) + v; });
    Object.entries(base.facilities).forEach(([id, f]) => {
      const start = base.kind === 'outpost' ? (id === 'wall' ? 1 : 0) : FACILITIES[id].startLevel;
      for (let lv = start + 1; lv <= f.level; lv += 1) add(FACILITIES[id].cost(lv));
    });
    base.defenses.forEach((d) => {
      if (!d.type) return;
      for (let lv = 1; lv <= d.level; lv += 1) add(DEFENSES[d.type].cost(lv));
    });
    return total;
  }

  /** 防禦建築的建造成本總和 */
  defenseBuiltCost(base) {
    const total = {};
    base.defenses.forEach((d) => {
      if (!d.type) return;
      for (let lv = 1; lv <= d.level; lv += 1) {
        Object.entries(DEFENSES[d.type].cost(lv)).forEach(([k, v]) => { total[k] = (total[k] || 0) + v; });
      }
    });
    return total;
  }

  /**
   * 放棄前哨站／搬遷避難所的結果預覽。
   * 搬遷避難所：進行中的研究與施工先取消並退還材料；防禦建築全部移除並退還 50% 建造材料；
   * 其他設施保留到新的避難所；食物、木材、燃料（含退還的部分）只剩 10%。
   * 前哨站：所有建築消失，退還 25% 建造資源。
   */
  abandonPreview(id, now = Date.now()) {
    const base = this.base(id);
    if (!base) return null;
    if (base.kind === 'outpost') {
      const refund = Object.fromEntries(Object.entries(this.builtCost(base))
        .map(([k, v]) => [k, Math.floor(v * ABANDON_REFUND)]).filter(([, v]) => v > 0));
      return { refund };
    }
    const add = (to, cost) => Object.entries(cost || {}).forEach(([k, v]) => { if (v > 0) to[k] = (to[k] || 0) + v; });
    const cancelled = {};
    // 研究中的項目（第二研究位也算）：依完成度退還
    let researchInfo = null;
    this.game.research.actives().forEach(({ a: active }) => {
      const refund = cancelRefund(active, now, () => this.game.research.cost(active.id, active.level)).cost;
      add(cancelled, refund);
      if (!researchInfo) researchInfo = { id: active.id, level: active.level, refund };
    });
    // 排隊中的研究：全額退還
    (this.game.state.research.queue || []).forEach((q) => add(cancelled, q.cost));
    const builds = base.buildQueue.map((q) => cancelRefund(q, now, () => (q.kind === 'facility' ? this.discounted(FACILITIES[q.id].cost(q.targetLevel)) : this.defenseCost(q.id, q.targetLevel))).cost);
    builds.forEach((c) => add(cancelled, c));
    const defRefund = Object.fromEntries(Object.entries(this.defenseBuiltCost(base))
      .map(([k, v]) => [k, Math.floor(v * RELOCATE_DEFENSE_REFUND)]).filter(([, v]) => v > 0));
    const res = this.game.state.resources;
    const before = Object.fromEntries(RESOURCE_KEYS.map((k) => [k, Math.floor(res[k] + (cancelled[k] || 0) + (defRefund[k] || 0))]));
    const keep = Object.fromEntries(RESOURCE_KEYS.map((k) => [k, Math.floor(before[k] * RELOCATE_KEEP)]));
    const lost = Object.fromEntries(RESOURCE_KEYS.map((k) => [k, before[k] - keep[k]]).filter(([, v]) => v > 0));
    const facilities = Object.entries(base.facilities).filter(([, f]) => f.level > 0).map(([fid, f]) => ({ id: fid, level: f.level }));
    const defenses = base.defenses.filter((d) => d.type).map((d) => ({ type: d.type, level: d.level }));
    return {
      relocate: true, research: researchInfo,
      builds: base.buildQueue.length, cancelled, defRefund, defenses, facilities, before, keep, lost,
    };
  }

  abandon(id) {
    const base = this.base(id);
    if (!base) return { ok: false, reason: '找不到據點' };
    const isShelter = base.kind !== 'outpost';
    if (!isShelter && base.buildQueue.length) return { ok: false, reason: '施工中無法放棄' };
    if (isShelter && this.game.state.expeditions.length) return { ok: false, reason: '有隊伍在外，無法搬遷避難所' };
    const preview = this.abandonPreview(id);
    base.defenses.forEach((d) => { d.garrisonId = null; });
    if (isShelter) {
      // 1. 進行中的研究與施工先取消並退還材料
      this.game.research.cancelAll();
      while (base.buildQueue.length) this.cancelBuild(base, 0);
      // 2. 防禦建築全部移除，退還 50% 建造材料
      this.game.grant(preview.defRefund);
      // 3. 食物、木材、燃料只剩 10%
      const res = this.game.state.resources;
      RESOURCE_KEYS.forEach((k) => { res[k] = Math.floor(res[k] * RELOCATE_KEEP); });
      // 4. 設施保留到新的避難所（防禦建築與圍牆耐久不保留）
      this.game.state.relocation = {
        facilities: Object.fromEntries(Object.entries(base.facilities).map(([fid, f]) => [fid, { level: f.level }])),
        from: base.name, at: Date.now(),
      };
      this.game.state.bases = this.bases.filter((b) => b.id !== id);
      this.game.state.primaryBaseId = null;
    } else {
      this.game.state.bases = this.bases.filter((b) => b.id !== id);
      this.game.grant(preview.refund);
    }
    this.game.civilization.invalidate();
    this.game.log(isShelter
      ? `🚚 搬遷避難所「${base.name}」：防禦建築拆除並退還 ${Math.round(RELOCATE_DEFENSE_REFUND * 100)}% 材料，設施保留，食物、木材、燃料只帶走 ${Math.round(RELOCATE_KEEP * 100)}%`
      : `🏚️ 放棄前哨站「${base.name}」，退還 ${Math.round(ABANDON_REFUND * 100)}% 建造資源`, 'danger');
    this.game.bus.emit('shelter:changed');
    return {
      ok: true, preview, msg: isShelter ? `已搬離「${base.name}」，請在地圖上選擇新的避難所（設施會保留）` : `已放棄前哨站「${base.name}」`,
    };
  }

  // ---------- 據點遭襲紀錄 ----------

  /**
   * 記錄一次據點遭襲（屍潮、NPC 掠奪、其他玩家突襲）：防禦成功或失敗、損失的資源、毀損的建築、受重傷的人。
   * @param {{base?:object, attacker:string, success:boolean, lost?:Record<string,number>, coins?:number,
   *   damaged?:string[], injured?:string[], kills?:number, waves?:number, wallLost?:number, note?:string}} e
   */
  recordDefense(e) {
    const st = this.game.state;
    const entry = {
      id: `df_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      at: Date.now(),
      baseName: e.base?.name || '據點',
      attacker: e.attacker,
      success: !!e.success,
      lost: Object.fromEntries(Object.entries(e.lost || {}).filter(([, v]) => v > 0).map(([k, v]) => [k, Math.floor(v)])),
      coins: Math.floor(e.coins || 0),
      damaged: e.damaged || [],
      injured: e.injured || [],
      kills: e.kills || 0,
      waves: e.waves || 0,
      wallLost: Math.round(e.wallLost || 0),
      note: e.note || '',
      // 友好協防（標籤顯示）：屍潮由呼叫端傳入；NPC／玩家攻打由協防系統暫存
      ...((() => { const list = e.assists || this.game.assist?.takePending?.() || []; return list.length ? { assists: list } : {}; })()),
      ...(e.siege ? { siege: e.siege } : {}),
      ...(e.battleIds?.length ? { battleIds: [...e.battleIds] } : {}),
      ...(e.reward ? { reward: e.reward } : {}),
    };
    st.defenseLog = [entry, ...(st.defenseLog || [])].slice(0, 30);
    const parts = [entry.success ? '防禦成功' : '防禦失敗'];
    if (entry.waves) parts.push(`擋下 ${entry.waves} 波`);
    if (entry.kills) parts.push(`擊殺 ${entry.kills}`);
    const lostTotal = Object.values(entry.lost).reduce((a, b) => a + b, 0);
    if (lostTotal || entry.coins) parts.push(`損失 ${lostTotal} 單位物資${entry.coins ? `與 💰${entry.coins}` : ''}`);
    if (entry.wallLost) parts.push(`圍牆 −${entry.wallLost}`);
    if (entry.damaged.length) parts.push(`${entry.damaged.length} 棟建築毀損`);
    if (entry.injured.length) parts.push(`重傷：${entry.injured.join('、')}`);
    this.game.log(`${entry.success ? '🛡️' : '💥'}「${entry.baseName}」遭${entry.attacker}攻擊：${parts.join('，')}`, entry.success ? 'success' : 'danger');
    this.game.bus.emit('defense:recorded', entry);
    return entry;
  }

  /** 掠奪隊在抵達前撤退（例如見屍潮來襲）：沒有交戰，只記一筆灰色的撤退紀錄 */
  recordRetreat(base, attacker) {
    const st = this.game.state;
    const entry = {
      id: `df_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      at: Date.now(), baseName: base?.name || '據點', attacker, retreat: true, success: true,
      lost: {}, coins: 0, damaged: [], injured: [], kills: 0, waves: 0, wallLost: 0, note: '',
    };
    st.defenseLog = [entry, ...(st.defenseLog || [])].slice(0, 30);
    this.game.bus.emit('defense:recorded', entry);
    return entry;
  }

  /** 防守前後比對，找出這次受重傷的人 */
  static newlySevere(before, survivors) {
    return survivors.filter((sv) => sv.severe && !before.has(sv.id)).map((sv) => sv.name);
  }

  // ---------- 折扣與加成 ----------

  /** 主要據點中工程師技能的最大效果 */
  engineerEffect(key) {
    let best = 0;
    // 工程師的折扣不因外出探索而消失（否則所需材料會忽多忽少）；重傷時不算
    this.game.state.survivors.forEach((sv) => {
      if (sv.classId !== 'engineer' || sv.severe) return;
      best = Math.max(best, this.game.survivors.skillEffects(sv)[key] || 0);
    });
    return best;
  }

  discounted(cost) {
    return scaleCost(cost, Math.max(0.3, 1 - this.engineerEffect('buildDiscount') - this.game.research.bonus('buildCostReduce')));
  }

  /** 施工秒數（研究「快速施工」縮短） */
  buildSeconds(seconds) {
    return seconds * Math.max(0.4, 1 - this.game.research.bonus('buildTimeReduce'));
  }

  wallMax(b) {
    const base = this.resolve(b);
    if (!base) return wallMaxHp(1);
    const barricade = base.defenses
      .filter((d) => d.type === 'barricade' && d.level > 0)
      .reduce((s, d) => s + DEFENSES.barricade.stats(d.level).wallBonus, 0);
    const pct = this.game.research.bonus('wallHpPct') + (base.kind === 'outpost' ? this.game.research.bonus('outpostWallPct') : 0);
    return Math.round(wallMaxHp(base.facilities.wall.level) * (1 + pct) + barricade);
  }

  wallHp(b) {
    const base = this.resolve(b);
    if (!base) return wallMaxHp(1);
    if (base.wallHp == null) base.wallHp = this.wallMax(base);
    // 圍牆耐久最低為 0（修正舊資料的負數）
    if (base.wallHp < 0) base.wallHp = 0;
    return Math.min(base.wallHp, this.wallMax(base));
  }

  wallReduction(b) {
    // 圍牆硬度：基本 10% 減傷，每級 +3%，加上「減傷結構」與「強化牆體」研究（上限 75%）
    const r = this.game.research;
    const reduce = 0.1 + this.resolve(b).facilities.wall.level * 0.03 + r.bonus('wallReduceAdd');
    return Math.min(0.75, 1 - (1 - reduce) * Math.max(0.4, 1 - r.bonus('wallHardPct')));
  }

  towerDamageMul(b) {
    const base = this.resolve(b);
    const gen = this.game.resources.generatorActive() ? base.facilities.generator.level * 0.06 * (1 + this.game.research.bonus('generatorPct')) : 0;
    const eng = this.isPrimary(base) ? this.engineerEffect('towerDmg') : 0;
    // 探照燈與「精準射擊」研究：照亮目標，提高防禦設施的傷害（防禦設施不論方向都會開火，沒有射程限制）
    return 1 + this.game.research.bonus('towerDmgPct') + gen + eng + (this.rangeMul(base) - 1);
  }

  /**
   * 地圖上屍潮（防禦）範圍的大小比例：預設較小，探照燈與「精準射擊」科技都升到最高級時才是完整大小。
   * 只影響地圖上的顯示大小，不影響防守強度。
   */
  siegeRangeScale(b) {
    const base = this.resolve(b);
    if (!base) return SIEGE_RANGE.min;
    const wt = Math.min(1, (base.facilities.watchtower?.level || 0) / FACILITY_MAX_LEVEL);
    const rs = RESEARCH.d_range ? Math.min(1, this.game.research.level('d_range') / RESEARCH.d_range.maxLevel) : 0;
    return SIEGE_RANGE.min + (1 - SIEGE_RANGE.min) * (wt * 0.6 + rs * 0.4);
  }

  /** 屍潮防禦範圍（地圖上最外層圓圈）的半徑（公尺） */
  siegeRangeMeters(b) {
    return SIEGE_RANGE.fullM * this.siegeRangeScale(b);
  }

  rangeMul(b) {
    return 1 + this.resolve(b).facilities.watchtower.level * 0.06 + this.game.research.bonus('towerRangePct');
  }

  // ---------- 佇列 ----------

  queueFull(b) {
    return this.resolve(b).buildQueue.length >= BUILD_QUEUE_SIZE;
  }

  isFacilityBusy(b, id) {
    return this.resolve(b).buildQueue.some((q) => q.kind === 'facility' && q.id === id);
  }

  isSlotBusy(b, slot) {
    return this.resolve(b).buildQueue.some((q) => q.kind === 'defense' && q.slot === slot);
  }

  // ---------- 設施 ----------

  facilityCost(b, id) {
    const lv = this.resolve(b).facilities[id].level + 1;
    return this.discounted(FACILITIES[id].cost(lv));
  }

  /** 設施最高等級：v14 起所有避難所都能升到最高等級（建築規模只影響探索、屍潮與警戒範圍） */
  facilityCap() {
    return FACILITY_MAX_LEVEL;
  }

  /** v14：所有避難所的防禦欄位都是最多的數量（舊存檔的避難所補足欄位） */
  ensureDefenseSlots() {
    const max = Math.max(...Object.values(BASE_SIZES).map((x) => x.slots));
    this.bases.forEach((b) => {
      if (b.kind === 'outpost' || !Array.isArray(b.defenses)) return;
      // v14：避難所沒有大小之分，屍潮強度與警戒範圍一律比照巨型
      b.size = 'huge';
      for (let i = b.defenses.length; i < max; i += 1) b.defenses.push({ slot: i, type: null, level: 0, garrisonId: null });
    });
  }

  /**
   * 超過據點規模上限的設施降到上限，降掉的等級退還 50% 建造材料。
   * @returns {{changes:{id:string, from:number, to:number}[], refund:object}}
   */
  capFacilities(b, { apply = true } = {}) {
    const base = this.resolve(b);
    const cap = this.facilityCap(base);
    const refund = {};
    const changes = [];
    Object.entries(base.facilities).forEach(([id, f]) => {
      if (f.level <= cap) return;
      for (let lv = cap + 1; lv <= f.level; lv += 1) {
        Object.entries(FACILITIES[id].cost(lv)).forEach(([k, v]) => { refund[k] = (refund[k] || 0) + v; });
      }
      changes.push({ id, from: f.level, to: cap });
      if (apply) f.level = cap;
    });
    Object.keys(refund).forEach((k) => { refund[k] = Math.floor(refund[k] * FACILITY_CAP_REFUND); if (!refund[k]) delete refund[k]; });
    if (apply && changes.length) {
      this.game.grant(refund);
      base.wallHp = null;
      this.game.civilization.invalidate();
    }
    return { changes, refund };
  }

  /** 搬遷到某個地點時，會被降級的設施（預覽） */
  relocationCapPreview(poi) {
    const reloc = this.game.state.relocation;
    if (!reloc?.facilities) return { changes: [], refund: {} };
    const cap = FACILITY_MAX_LEVEL;
    const base = { size: baseSizeOf(poi), facilities: JSON.parse(JSON.stringify(reloc.facilities)) };
    const changes = [];
    const refund = {};
    Object.entries(base.facilities).forEach(([id, f]) => {
      if (!FACILITIES[id] || f.level <= cap) return;
      for (let lv = cap + 1; lv <= f.level; lv += 1) {
        Object.entries(FACILITIES[id].cost(lv)).forEach(([k, v]) => { refund[k] = (refund[k] || 0) + v; });
      }
      changes.push({ id, from: f.level, to: cap });
    });
    Object.keys(refund).forEach((k) => { refund[k] = Math.floor(refund[k] * FACILITY_CAP_REFUND); if (!refund[k]) delete refund[k]; });
    return { changes, refund, cap };
  }

  canUpgradeFacility(b, id) {
    const base = this.resolve(b);
    if (!base) return { ok: false, reason: '尚未建立避難所' };
    const fac = base.facilities[id];
    if (!fac) return { ok: false, reason: '未知設施' };
    if (base.kind === 'outpost' && !OUTPOST_FACILITIES.includes(id)) return { ok: false, reason: '前哨站只有防禦功能，無法建造此設施' };
    if (fac.level >= FACILITY_MAX_LEVEL) return { ok: false, reason: '已達最高等級' };
    const cap = this.facilityCap(base);
    if (fac.level >= cap) return { ok: false, reason: `${BASE_SIZES[base.size]?.name || ''}據點設施最高 Lv${cap}（需要更大的據點）` };
    const req = FACILITIES[id]?.req;
    const miss = req && Object.entries(req).find(([k, lv]) => (base.facilities[k]?.level || 0) < lv);
    if (miss && fac.level === 0) return { ok: false, reason: `需要${FACILITIES[miss[0]]?.name || miss[0]} Lv${miss[1]}` };
    if (this.isFacilityBusy(base, id)) return { ok: false, reason: '施工中' };
    if (this.queueFull(base)) return { ok: false, reason: `施工佇列已滿（${BUILD_QUEUE_SIZE}）` };
    if (!canAfford(this.game.state, this.facilityCost(base, id))) return { ok: false, reason: '資源不足' };
    return { ok: true };
  }

  upgradeFacility(b, id) {
    const base = this.resolve(b);
    const check = this.canUpgradeFacility(base, id);
    if (!check.ok) return check;
    const cost = this.facilityCost(base, id);
    payCost(this.game.state, cost);
    const target = base.facilities[id].level + 1;
    base.buildQueue.push({
      kind: 'facility', id, targetLevel: target, startAt: Date.now(), endAt: Date.now() + this.buildSeconds(facilityBuildTime(target)) * 1000, cost,
    });
    return { ok: true, msg: `${FACILITIES[id].name} 開始${target === 1 ? '建造' : '升級'}` };
  }

  // ---------- 防禦建築 ----------

  isDefenseUnlocked(type) {
    const req = DEFENSES[type].requires;
    return !req || this.game.research.isDone(req);
  }

  defenseLockReason(type) {
    const req = DEFENSES[type].requires;
    return req && !this.game.research.isDone(req) ? `需研究「${RESEARCH[req].name}」` : '';
  }

  /** 數量限制（電磁塔、電網每個據點只能一座）：超過時回傳原因 */
  defenseLimitReason(b, slot, type) {
    const base = this.resolve(b);
    const limit = DEFENSES[type]?.limit;
    if (!base || !limit) return '';
    const n = base.defenses.filter((x, i) => i !== slot && x.type === type).length;
    return n >= limit ? `每個據點最多 ${limit} 座${DEFENSES[type].name}` : '';
  }

  /**
   * 舊存檔：超過數量限制的電磁塔、電網只保留等級最高的一座，其餘拆除並全額退還建造材料。
   * @returns {string[]} 拆除的說明
   */
  enforceDefenseLimits() {
    const notes = [];
    this.game.state.bases.forEach((base) => {
      Object.entries(DEFENSES).filter(([, def]) => def.limit).forEach(([type, def]) => {
        const slots = base.defenses.map((d, i) => ({ d, i })).filter(({ d }) => d.type === type)
          .sort((a, b) => b.d.level - a.d.level);
        slots.slice(def.limit).forEach(({ d, i }) => {
          const refund = {};
          const add = (cost) => Object.entries(cost || {}).forEach(([k, v]) => { refund[k] = (refund[k] || 0) + v; });
          for (let lv = 1; lv <= d.level; lv += 1) add(this.defenseCost(type, lv));
          // 施工中的升級：一併取消並退還
          base.buildQueue = (base.buildQueue || []).filter((q) => {
            if (q.kind === 'defense' && q.slot === i) { add(q.cost); return false; }
            return true;
          });
          this.game.grant(refund, true);
          notes.push(`「${base.name}」的${def.name} Lv${d.level}`);
          Object.assign(d, { type: null, level: 0, garrisonId: null });
        });
      });
    });
    if (notes.length) {
      this.game.civilization.invalidate();
      this.game.log(`🛡️ 電磁塔與電網每個據點限 1 座：已拆除多出的 ${notes.join('、')}，並全額退還建造材料`, 'info');
    }
    return notes;
  }

  defenseCost(type, level) {
    return this.discounted(DEFENSES[type].cost(level));
  }

  /** 在據點槽位建造新防禦或升級既有防禦 */
  buildDefense(b, slot, type) {
    const base = this.resolve(b);
    const d = base?.defenses[slot];
    if (!d) return { ok: false, reason: '無效槽位' };
    if (d.type && d.type !== type) return { ok: false, reason: '請先拆除原有建築' };
    if (!this.isDefenseUnlocked(type)) return { ok: false, reason: this.defenseLockReason(type) };
    const limitReason = this.defenseLimitReason(base, slot, type);
    if (limitReason) return { ok: false, reason: limitReason };
    if (d.level >= DEFENSE_MAX_LEVEL) return { ok: false, reason: '已達最高等級' };
    if (this.isSlotBusy(base, slot)) return { ok: false, reason: '施工中' };
    if (this.queueFull(base)) return { ok: false, reason: '施工佇列已滿' };
    const target = d.level + 1;
    const cost = this.defenseCost(type, target);
    if (!payCost(this.game.state, cost)) return { ok: false, reason: '資源不足' };
    d.type = type;
    base.buildQueue.push({
      kind: 'defense', slot, id: type, targetLevel: target, startAt: Date.now(), endAt: Date.now() + this.buildSeconds(defenseBuildTime(target)) * 1000, cost,
    });
    return { ok: true, msg: `${DEFENSES[type].name} ${target === 1 ? '建造' : '升級'}中` };
  }

  // ---------- 警戒模式 ----------

  /** 警戒中：全部倖存者暫時改為防禦駐守 */
  get alert() {
    return !!this.game.state.alert?.on;
  }

  /**
   * 切換警戒／正常。警戒時所有倖存者的工作暫時變為「防禦駐守」，切回正常時恢復原本的工作。
   */
  setAlert(on) {
    const st = this.game.state;
    if (on === this.alert) return { ok: true, msg: on ? '已經在警戒中' : '已經是正常狀態' };
    if (on) {
      const prev = {};
      st.survivors.forEach((sv) => { prev[sv.id] = sv.job; sv.job = 'guard'; });
      st.alert = { on: true, prev, at: Date.now() };
      this.game.log('🚨 進入警戒：全部倖存者暫時改為防禦駐守', 'danger');
      return { ok: true, msg: '🚨 警戒中：全部倖存者改為防禦駐守' };
    }
    const prev = st.alert?.prev || {};
    st.survivors.forEach((sv) => { if (prev[sv.id]) sv.job = prev[sv.id]; });
    st.alert = { on: false };
    this.game.log('✅ 解除警戒：倖存者恢復原本的工作', 'info');
    return { ok: true, msg: '已解除警戒，恢復原本的工作' };
  }

  /**
   * 取消施工：依完成度退還材料（完成度越高退得越少，最多退 90%）。
   * @returns {{ok:boolean, refund?:object, msg?:string, reason?:string}}
   */
  cancelBuild(b, index, now = Date.now()) {
    const base = this.resolve(b);
    const q = base?.buildQueue?.[index];
    if (!q) return { ok: false, reason: '找不到這項施工' };
    const refund = cancelRefund(q, now, () => (q.kind === 'facility' ? this.discounted(FACILITIES[q.id].cost(q.targetLevel)) : this.defenseCost(q.id, q.targetLevel)));
    base.buildQueue.splice(index, 1);
    if (q.kind === 'defense') {
      const d = base.defenses[q.slot];
      if (d && d.level < 1) Object.assign(d, { type: null, level: 0, garrisonId: null });
    }
    const got = this.game.grant(refund.cost);
    const name = q.kind === 'facility' ? FACILITIES[q.id].name : DEFENSES[q.id].name;
    this.game.log(`🚫 取消施工「${name}」Lv${q.targetLevel}，退還 ${Math.round(refund.ratio * 100)}% 材料`, 'info');
    return { ok: true, refund: got, msg: `已取消「${name}」，退還約 ${Math.round(refund.ratio * 100)}% 材料` };
  }

  demolish(b, slot) {
    const base = this.resolve(b);
    const d = base?.defenses[slot];
    if (!d?.type) return { ok: false, reason: '空地' };
    if (this.isSlotBusy(base, slot)) return { ok: false, reason: '施工中' };
    Object.assign(d, { type: null, level: 0, garrisonId: null });
    this.game.civilization.invalidate();
    return { ok: true, msg: '已拆除' };
  }

  /** 任一據點中是否駐守 */
  garrisonOf(survivorId) {
    for (const b of this.bases) {
      const d = b.defenses.find((x) => x.garrisonId === survivorId);
      if (d) return { base: b, slot: d.slot };
    }
    return null;
  }

  /**
   * 這個人目前是否在瞭望塔上（實際駐守、會射擊）。
   * 主要避難所：在避難所、沒有重傷，且警戒中或工作為「防禦駐守」才上塔；前哨站：設定了就一直駐守。
   */
  onTower(survivorId) {
    const at = this.garrisonOf(survivorId);
    if (!at) return false;
    if (!this.isPrimary(at.base)) return true;
    const sv = this.game.survivors.get(survivorId);
    return !!sv && sv.status === 'idle' && !sv.severe && (this.alert || sv.job === 'guard');
  }

  /**
   * 瞭望塔駐守狀態（介面顯示用）。
   * @returns {{state:'none'|'on'|'standby', sv?:object, why:string}}
   */
  towerStatus(base, d) {
    const sv = d?.garrisonId ? this.game.survivors.get(d.garrisonId) : null;
    if (!sv) return { state: 'none', why: '' };
    if (this.onTower(sv.id)) {
      return { state: 'on', sv, why: this.isPrimary(base) ? `${sv.name}${this.alert ? '：警戒中' : '：工作為「防禦駐守」'}，已上塔` : `${sv.name} 駐守前哨站` };
    }
    const why = sv.status === 'exploring' ? '外出中，回到避難所後依規則上塔'
      : sv.severe ? '重傷中，治好後依規則上塔'
        : `目前工作為「${JOBS[sv.job]?.name || '閒置'}」：切換警戒或指派「防禦駐守」時才會上塔`;
    return { state: 'standby', sv, why: `${sv.name} ${why}` };
  }

  /** 瞭望塔目前在塔上的人（沒有則 null） */
  towerGuard(d) {
    return d?.garrisonId && this.onTower(d.garrisonId) ? this.game.survivors.get(d.garrisonId) : null;
  }

  garrison(b, slot, survivorId) {
    const base = this.resolve(b);
    const d = base?.defenses[slot];
    if (d?.type !== 'watchPost' || d.level < 1) return { ok: false, reason: '只有瞭望塔可駐守' };
    if (!survivorId) {
      d.garrisonId = null;
      return { ok: true, msg: '已撤回駐守' };
    }
    const sv = this.game.survivors.get(survivorId);
    if (!sv || sv.status === 'exploring') return { ok: false, reason: '該倖存者無法駐守' };
    this.bases.forEach((x) => x.defenses.forEach((y) => { if (y.garrisonId === survivorId) y.garrisonId = null; }));
    d.garrisonId = survivorId;
    // 前哨站：設定後一直駐守；主要避難所：警戒中或工作為「防禦駐守」時才上塔（不強制改工作）
    if (!this.isPrimary(base)) return { ok: true, msg: `${sv.name} 駐守「${base.name}」瞭望塔` };
    return { ok: true, msg: this.onTower(sv.id) ? `${sv.name} 已上「${base.name}」瞭望塔` : `${sv.name} 設定為瞭望塔駐守人員（警戒中或工作為「防禦駐守」時自動上塔）` };
  }

  // ---------- 更新 ----------

  update(now, dtMs) {
    this.bases.forEach((base) => {
      const done = base.buildQueue.filter((q) => q.endAt <= now);
      if (done.length) {
        base.buildQueue = base.buildQueue.filter((q) => q.endAt > now);
        done.forEach((q) => this.completeBuild(base, q));
      }
    });
    this.repairWalls(dtMs);
  }

  /** 指派「修繕圍牆」的倖存者（在避難所、可行動、未駐守瞭望塔） */
  repairers() {
    return this.game.state.survivors.filter((s) => s.job === 'repair' && s.status === 'idle' && !s.severe && !this.game.survivors.isGarrisoned(s.id));
  }

  /** 每秒可修復的圍牆耐久 */
  repairRate() {
    const research = 1 + this.game.research.bonus('repairPct');
    return this.repairers().reduce((sum, sv) => {
      const cls = JOBS.repair.classBonus[sv.classId] || 1;
      const skill = 1 + (this.game.survivors.skillEffects(sv).repairBonus || 0);
      return sum + REPAIR.hpPerSec * (1 + sv.level * 0.03) * cls * skill;
    }, 0) * research;
  }

  /** 每點耐久的修繕材料（研究「快速修補」減少） */
  repairCostPerHp() {
    // 「快速修補」與「修補材料學」：每單位材料修復更多耐久
    const mul = Math.max(0.5, 1 - this.game.research.bonus('repairPct') * 0.3) / (1 + this.game.research.bonus('repairEffPct'));
    return Object.fromEntries(Object.entries(REPAIR.cost).map(([k, v]) => [k, v * mul]));
  }

  /** 純木材修繕（缺少釘子等零件時）：每點耐久的木材倍率與速度倍率 */
  static WOOD_ONLY = { woodMul: 1.5, speedMul: 0.5 };

  /** 目前的修繕狀態：normal 正常、woodOnly 缺零件改用純木材、noWood 木材不足、none 無人修繕 */
  repairStatus() {
    if (!this.repairers().length) return { mode: 'none' };
    const st = this.game.state;
    const per = this.repairCostPerHp();
    const have = (k) => (st.resources[k] !== undefined ? st.resources[k] : st.supplies?.[k] || 0) || 0;
    if (have('wood') < per.wood) return { mode: 'noWood' };
    const missing = Object.keys(per).filter((k) => k !== 'wood' && have(k) < 1);
    return missing.length ? { mode: 'woodOnly', missing } : { mode: 'normal' };
  }

  /**
   * 圍牆不會自行修復：由修繕人員修理並消耗木材與零件（釘子、廢鐵）。
   * 先修受損比例最高的據點；零件用完時改用純木材修繕（耗更多木材、速度減半），木材也不足時才停止。
   */
  repairWalls(dtMs) {
    let budget = this.repairRate() * (dtMs / 1000);
    if (budget <= 0) return;
    const st = this.game.state;
    st.supplies = st.supplies || {};
    const have = (k) => (st.resources[k] !== undefined ? st.resources[k] : st.supplies[k] || 0) || 0;
    const full = this.repairCostPerHp();
    const woodOnly = { wood: full.wood * ShelterSystem.WOOD_ONLY.woodMul };
    const spend = (per, hp) => Object.entries(per).forEach(([k, v]) => {
      if (st.resources[k] !== undefined) st.resources[k] = Math.max(0, st.resources[k] - hp * v);
      else {
        // 材料物品以整數計：累積小數，用滿 1 個才扣除
        st.repairAcc = st.repairAcc || {};
        st.repairAcc[k] = (st.repairAcc[k] || 0) + hp * v;
        const whole = Math.min(Math.floor(st.repairAcc[k]), st.supplies[k] || 0);
        st.repairAcc[k] -= whole;
        st.supplies[k] = (st.supplies[k] || 0) - whole;
        if (st.supplies[k] <= 0) delete st.supplies[k];
      }
    });
    const damaged = this.bases.map((b) => ({ b, ratio: this.wallHp(b) / this.wallMax(b) }))
      .filter((x) => x.ratio < 1).sort((a, c) => a.ratio - c.ratio);
    for (const { b } of damaged) {
      if (budget <= 0) break;
      let need = this.wallMax(b) - this.wallHp(b);
      // 先用完整材料修繕（零件以「還有幾個」計，小數累積到 1 才扣）
      const partsOk = Object.keys(full).every((k) => k === 'wood' || have(k) >= 1);
      if (partsOk) {
        const afford = Math.min(...Object.entries(full).map(([k, v]) => (v ? (have(k) - (k === 'wood' ? 0 : st.repairAcc?.[k] || 0)) / v : Infinity)));
        const hp = Math.max(0, Math.min(need, budget, afford));
        if (hp > 0) {
          b.wallHp = this.wallHp(b) + hp;
          spend(full, hp);
          budget -= hp;
          need -= hp;
        }
      }
      // 零件不足：剩下的修繕時間改用純木材（速度減半）
      if (budget > 0 && need > 0 && !Object.keys(full).every((k) => k === 'wood' || have(k) >= 1)) {
        const hp = Math.max(0, Math.min(need, budget * ShelterSystem.WOOD_ONLY.speedMul, have('wood') / woodOnly.wood));
        if (hp <= 0) break;
        b.wallHp = this.wallHp(b) + hp;
        spend(woodOnly, hp);
        budget -= hp / ShelterSystem.WOOD_ONLY.speedMul;
      }
      if (have('wood') <= 0) break;
    }
  }

  completeBuild(base, q) {
    if (q.kind === 'facility') {
      base.facilities[q.id].level = q.targetLevel;
      this.game.log(`🏗️ ${base.name}：${FACILITIES[q.id].name} 升到 Lv${q.targetLevel}`, 'success');
    } else {
      const d = base.defenses[q.slot];
      d.type = q.id;
      d.level = q.targetLevel;
      this.game.log(`🏗️ ${base.name}：${DEFENSES[q.id].name} 升到 Lv${q.targetLevel}`, 'success');
    }
    this.game.state.stats.upgrades += 1;
    this.game.civilization.invalidate();
    this.game.bus.emit('shelter:changed');
  }
}
