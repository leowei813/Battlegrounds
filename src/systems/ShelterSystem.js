import { BUILD_QUEUE_SIZE } from '../config/constants.js';
import {
  FACILITIES, FACILITY_MAX_LEVEL, cellarCap, cellarCoins, facilityBuildTime, wallMaxHp, OUTPOST_FACILITIES, REPAIR,
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
import { canAfford, payCost, scaleCost } from './costUtils.js';

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
    return Math.min(MAX_OUTPOSTS, this.game.research.bonus('outposts'));
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
    return key === 'coins' ? cellarCoins(lv) : cellarCap(lv);
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
    if (this.primary()) {
      const limit = this.outpostLimit();
      if (!limit) return { ok: false, reason: '需研究「前哨站」科技' };
      if (this.outposts().length >= limit) return { ok: false, reason: `前哨站最多 ${limit} 座（研究可增加，最多 ${MAX_OUTPOSTS} 座）` };
    }
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
    this.game.bus.emit('shelter:changed');
    return { ok: true, base, msg: kind === 'shelter' ? `避難所設於 ${poi.name}` : `已在 ${poi.name} 建立前哨站` };
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
    const active = this.game.state.research.active;
    const research = active ? cancelRefund(active, now, () => this.game.research.cost(active.id, active.level)).cost : null;
    add(cancelled, research);
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
      relocate: true, research: active ? { id: active.id, level: active.level, refund: research } : null,
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
      if (this.game.state.research.active) this.game.research.cancel();
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

  /** 設施最高等級：依據點規模（小型 Lv8、中型 Lv11、大型 Lv13、巨型 Lv15） */
  facilityCap(b) {
    const base = this.resolve(b);
    return Math.min(FACILITY_MAX_LEVEL, BASE_SIZES[base?.size]?.facMax ?? FACILITY_MAX_LEVEL);
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
    const cap = Math.min(FACILITY_MAX_LEVEL, BASE_SIZES[baseSizeOf(poi)]?.facMax ?? FACILITY_MAX_LEVEL);
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
    sv.job = 'guard';
    return { ok: true, msg: `${sv.name} 駐守「${base.name}」瞭望塔` };
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
