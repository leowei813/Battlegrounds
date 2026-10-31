import { BUILD_QUEUE_SIZE } from '../config/constants.js';
import {
  FACILITIES, FACILITY_MAX_LEVEL, facilityBuildTime, wallMaxHp, OUTPOST_FACILITIES, REPAIR,
} from '../config/facilities.js';
import { RESOURCE_KEYS } from '../config/constants.js';
import { JOBS } from '../config/survivors.js';
import { DEFENSES, DEFENSE_MAX_LEVEL, defenseBuildTime } from '../config/defenses.js';
import { RESEARCH } from '../config/research.js';
import { POI_TYPES } from '../config/poiTypes.js';
import {
  PRIMARY_DANGER_COEF, baseEstablishCost, BASE_SIZES, FACILITY_COUNT, baseSizeOf, ABANDON_REFUND, MAX_OUTPOSTS,
} from '../config/civilization.js';
import { createBase } from '../core/GameState.js';
import { canAfford, payCost, scaleCost } from './costUtils.js';

/**
 * 據點系統：
 *  - 避難所（只能一座）：倖存者居住、生產、探索出發、駐守倖存者防衛的地方。
 *  - 前哨站（研究「前哨站」科技解鎖，最多 3 座）：只有圍牆、探照燈與防禦建築，不能生產。
 * 每個據點有自己的設施、防禦建築、圍牆與施工佇列；據點可以放棄，退還 25% 建造資源。
 *
 * 大多數方法第一個參數為據點（物件或 ID），省略時代表避難所。
 */
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
    this.bases.push(base);
    if (kind === 'shelter') this.game.state.primaryBaseId = base.id;
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

  /**
   * 放棄據點的結果預覽。
   * 放棄避難所＝搬家：所有資源只能帶走「人 + 有人駕駛的載具」載得動的量，其餘直接遺棄。
   * @returns {{refund:object, carry?:number, keep?:object, lost?:object}}
   */
  abandonPreview(id) {
    const base = this.base(id);
    if (!base) return null;
    const refund = Object.fromEntries(Object.entries(this.builtCost(base))
      .map(([k, v]) => [k, Math.floor(v * ABANDON_REFUND)]).filter(([, v]) => v > 0));
    if (base.kind === 'outpost') return { refund };
    const res = this.game.state.resources;
    const after = Object.fromEntries(RESOURCE_KEYS.map((k) => [k, Math.floor(res[k] + (refund[k] || 0))]));
    const total = RESOURCE_KEYS.reduce((s, k) => s + after[k], 0);
    const cap = this.game.vehicles.relocationCapacity();
    const ratio = total > cap.cargo ? cap.cargo / total : 1;
    const keep = Object.fromEntries(RESOURCE_KEYS.map((k) => [k, Math.floor(after[k] * ratio)]));
    const lost = Object.fromEntries(RESOURCE_KEYS.map((k) => [k, after[k] - keep[k]]).filter(([, v]) => v > 0));
    return {
      refund, carry: cap.cargo, people: cap.people, vehicles: cap.vehicles, keep, lost,
    };
  }

  abandon(id) {
    const base = this.base(id);
    if (!base) return { ok: false, reason: '找不到據點' };
    if (base.buildQueue.length) return { ok: false, reason: '施工中無法放棄' };
    const isShelter = base.kind !== 'outpost';
    if (isShelter && this.game.state.expeditions.length) return { ok: false, reason: '有隊伍在外，無法放棄避難所' };
    const preview = this.abandonPreview(id);
    base.defenses.forEach((d) => { d.garrisonId = null; });
    this.game.state.bases = this.bases.filter((b) => b.id !== id);
    if (isShelter) {
      // 搬家：資源只保留帶得走的部分（退還的建材也要搬）
      Object.assign(this.game.state.resources, preview.keep);
      // 退還的零件與布料放進物品倉庫（物品倉庫跟著搬家）
      this.game.grant(Object.fromEntries(Object.entries(preview.refund).filter(([k]) => !RESOURCE_KEYS.includes(k))));
      this.game.state.primaryBaseId = null;
    } else {
      this.game.grant(preview.refund);
    }
    this.game.civilization.invalidate();
    const lostTotal = Object.values(preview.lost || {}).reduce((s, v) => s + v, 0);
    this.game.log(`🏚️ 放棄${isShelter ? '避難所' : '前哨站'}「${base.name}」，退還 ${Math.round(ABANDON_REFUND * 100)}% 建造資源${lostTotal ? `，帶不走的 ${lostTotal} 單位物資被遺棄` : ''}`, 'danger');
    this.game.bus.emit('shelter:changed');
    return {
      ok: true, preview, msg: isShelter ? `已放棄避難所「${base.name}」，請在地圖上選擇新的避難所` : `已放棄前哨站「${base.name}」`,
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
    this.game.state.survivors.forEach((sv) => {
      if (sv.classId !== 'engineer' || sv.status === 'exploring') return;
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
    return Math.min(base.wallHp, this.wallMax(base));
  }

  wallReduction(b) {
    return Math.min(0.6, this.resolve(b).facilities.wall.level * 0.03 + this.game.research.bonus('wallReduceAdd'));
  }

  towerDamageMul(b) {
    const base = this.resolve(b);
    const gen = this.game.resources.generatorActive() ? base.facilities.generator.level * 0.06 * (1 + this.game.research.bonus('generatorPct')) : 0;
    const eng = this.isPrimary(base) ? this.engineerEffect('towerDmg') : 0;
    return 1 + this.game.research.bonus('towerDmgPct') + gen + eng;
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

  canUpgradeFacility(b, id) {
    const base = this.resolve(b);
    if (!base) return { ok: false, reason: '尚未建立避難所' };
    const fac = base.facilities[id];
    if (!fac) return { ok: false, reason: '未知設施' };
    if (base.kind === 'outpost' && !OUTPOST_FACILITIES.includes(id)) return { ok: false, reason: '前哨站只有防禦功能，無法建造此設施' };
    if (fac.level >= FACILITY_MAX_LEVEL) return { ok: false, reason: '已達最高等級' };
    if (this.isFacilityBusy(base, id)) return { ok: false, reason: '施工中' };
    if (this.queueFull(base)) return { ok: false, reason: `施工佇列已滿（${BUILD_QUEUE_SIZE}）` };
    if (!canAfford(this.game.state, this.facilityCost(base, id))) return { ok: false, reason: '資源不足' };
    return { ok: true };
  }

  upgradeFacility(b, id) {
    const base = this.resolve(b);
    const check = this.canUpgradeFacility(base, id);
    if (!check.ok) return check;
    payCost(this.game.state, this.facilityCost(base, id));
    const target = base.facilities[id].level + 1;
    base.buildQueue.push({
      kind: 'facility', id, targetLevel: target, startAt: Date.now(), endAt: Date.now() + this.buildSeconds(facilityBuildTime(target)) * 1000,
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
    if (!payCost(this.game.state, this.defenseCost(type, target))) return { ok: false, reason: '資源不足' };
    d.type = type;
    base.buildQueue.push({
      kind: 'defense', slot, id: type, targetLevel: target, startAt: Date.now(), endAt: Date.now() + this.buildSeconds(defenseBuildTime(target)) * 1000,
    });
    return { ok: true, msg: `${DEFENSES[type].name} ${target === 1 ? '建造' : '升級'}中` };
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
    const mul = Math.max(0.5, 1 - this.game.research.bonus('repairPct') * 0.3);
    return Object.fromEntries(Object.entries(REPAIR.cost).map(([k, v]) => [k, v * mul]));
  }

  /**
   * 圍牆不會自行修復：由修繕人員修理並消耗木材與金屬。
   * 先修受損比例最高的據點；材料不足時只修得了一部分。
   */
  repairWalls(dtMs) {
    let budget = this.repairRate() * (dtMs / 1000);
    if (budget <= 0) return;
    const st = this.game.state;
    const pool = (k) => (st.resources[k] !== undefined ? st.resources : (st.supplies = st.supplies || {}));
    const per = this.repairCostPerHp();
    const damaged = this.bases.map((b) => ({ b, ratio: this.wallHp(b) / this.wallMax(b) }))
      .filter((x) => x.ratio < 1).sort((a, c) => a.ratio - c.ratio);
    for (const { b } of damaged) {
      if (budget <= 0) break;
      const need = this.wallMax(b) - this.wallHp(b);
      const affordable = Math.min(...Object.entries(per).map(([k, v]) => (v ? (pool(k)[k] || 0) / v : Infinity)));
      const hp = Math.min(need, budget, affordable);
      if (hp <= 0) break;
      b.wallHp = this.wallHp(b) + hp;
      // 材料物品以整數計：累積小數，用滿 1 個才扣除
      Object.entries(per).forEach(([k, v]) => {
        if (st.resources[k] !== undefined) st.resources[k] -= hp * v;
        else {
          st.repairAcc = st.repairAcc || {};
          st.repairAcc[k] = (st.repairAcc[k] || 0) + hp * v;
          const whole = Math.min(Math.floor(st.repairAcc[k]), st.supplies[k] || 0);
          st.repairAcc[k] -= whole;
          st.supplies[k] -= whole;
          if (st.supplies[k] <= 0) delete st.supplies[k];
        }
      });
      budget -= hp;
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
