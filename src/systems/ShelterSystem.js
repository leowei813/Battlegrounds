import { BUILD_QUEUE_SIZE } from '../config/constants.js';
import {
  FACILITIES, FACILITY_MAX_LEVEL, facilityBuildTime, wallMaxHp,
} from '../config/facilities.js';
import { DEFENSES, DEFENSE_MAX_LEVEL, defenseBuildTime } from '../config/defenses.js';
import { RESEARCH } from '../config/research.js';
import { POI_TYPES } from '../config/poiTypes.js';
import {
  MAX_BASES, PRIMARY_DANGER_COEF, baseEstablishCost, BASE_SIZES, FACILITY_COUNT, baseSizeOf,
} from '../config/civilization.js';
import { createBase } from '../core/GameState.js';
import { canAfford, payCost, scaleCost } from './costUtils.js';

/**
 * 據點系統：多個據點（每個據點有自己的設施、防禦建築、圍牆與施工佇列），
 * 其中一個為「主要據點」——倖存者居住、探索出發、駐守倖存者防衛的地方。
 *
 * 大多數方法第一個參數為據點（物件或 ID），省略時代表主要據點。
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

  primary() {
    return this.base(this.game.state.primaryBaseId) || this.bases[0] || null;
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
    return this.bases.length > 0;
  }

  baseAtPoi(poiId) {
    return this.bases.find((b) => b.poiId === poiId) || null;
  }

  poiOf(b) {
    return this.game.state.map.pois.find((p) => p.id === b.poiId) || null;
  }

  // ---------- 跨據點彙總 ----------

  /** 所有據點中該設施的最高等級（研究中心、工作台等「解鎖型」設施使用） */
  maxLevel(fid) {
    return this.bases.reduce((m, b) => Math.max(m, b.facilities[fid].level), 0);
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

  // ---------- 建立 / 主要據點 / 放棄 ----------

  establishCost() {
    return this.bases.length ? baseEstablishCost(this.bases.length) : {};
  }

  canEstablish(poi) {
    if (!poi) return { ok: false, reason: '找不到地點' };
    if (this.baseAtPoi(poi.id)) return { ok: false, reason: '這裡已經是你的據點' };
    if (this.bases.length >= MAX_BASES) return { ok: false, reason: `最多 ${MAX_BASES} 個據點` };
    if (!canAfford(this.game.state, this.establishCost())) return { ok: false, reason: '資源不足' };
    return { ok: true };
  }

  /** 在地點建立據點；第一個據點免費且自動成為主要據點 */
  establish(poi) {
    const check = this.canEstablish(poi);
    if (!check.ok) return check;
    payCost(this.game.state, this.establishCost());
    const first = !this.bases.length;
    const base = createBase(poi, first);
    this.bases.push(base);
    if (first) this.game.state.primaryBaseId = base.id;
    this.game.civilization.invalidate();
    this.game.log(`🏠 ${first ? '建立避難所' : '建立前哨據點'}於「${poi.name}」`, 'success');
    this.game.bus.emit('shelter:changed');
    return { ok: true, base, msg: first ? `避難所設於 ${poi.name}` : `已在 ${poi.name} 建立新據點` };
  }

  /** 舊 API 相容 */
  setShelter(poi) {
    return this.establish(poi);
  }

  setPrimary(id) {
    const base = this.base(id);
    if (!base) return { ok: false, reason: '找不到據點' };
    if (this.isPrimary(base)) return { ok: false, reason: '已經是主要據點' };
    if (this.game.state.expeditions.length) return { ok: false, reason: '有隊伍在外，無法遷移主要據點' };
    this.game.state.primaryBaseId = base.id;
    this.game.log(`⭐ 主要據點遷移至「${base.name}」`, 'info');
    this.game.bus.emit('shelter:changed');
    return { ok: true, msg: `「${base.name}」成為主要據點，危險度將隨文明度提升` };
  }

  abandon(id) {
    const base = this.base(id);
    if (!base) return { ok: false, reason: '找不到據點' };
    if (this.isPrimary(base)) return { ok: false, reason: '無法放棄主要據點，請先指定其他主要據點' };
    if (base.buildQueue.length) return { ok: false, reason: '施工中無法放棄' };
    this.game.state.bases = this.bases.filter((b) => b.id !== id);
    this.game.civilization.invalidate();
    this.game.log(`🏚️ 放棄據點「${base.name}」`, 'danger');
    this.game.bus.emit('shelter:changed');
    return { ok: true, msg: `已放棄「${base.name}」` };
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
    return scaleCost(cost, 1 - this.engineerEffect('buildDiscount'));
  }

  wallMax(b) {
    const base = this.resolve(b);
    if (!base) return wallMaxHp(1);
    const barricade = base.defenses
      .filter((d) => d.type === 'barricade' && d.level > 0)
      .reduce((s, d) => s + DEFENSES.barricade.stats(d.level).wallBonus, 0);
    return Math.round(wallMaxHp(base.facilities.wall.level) * (1 + this.game.research.bonus('wallHpPct')) + barricade);
  }

  wallHp(b) {
    const base = this.resolve(b);
    if (!base) return wallMaxHp(1);
    if (base.wallHp == null) base.wallHp = this.wallMax(base);
    return Math.min(base.wallHp, this.wallMax(base));
  }

  wallReduction(b) {
    return Math.min(0.5, this.resolve(b).facilities.wall.level * 0.03);
  }

  towerDamageMul(b) {
    const base = this.resolve(b);
    const gen = this.game.resources.generatorActive() ? base.facilities.generator.level * 0.06 : 0;
    const eng = this.isPrimary(base) ? this.engineerEffect('towerDmg') : 0;
    return 1 + this.game.research.bonus('towerDmgPct') + gen + eng;
  }

  rangeMul(b) {
    return 1 + this.resolve(b).facilities.watchtower.level * 0.06;
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
      kind: 'facility', id, targetLevel: target, startAt: Date.now(), endAt: Date.now() + facilityBuildTime(target) * 1000,
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
      kind: 'defense', slot, id: type, targetLevel: target, startAt: Date.now(), endAt: Date.now() + defenseBuildTime(target) * 1000,
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
      // 圍牆自然修復：每秒 0.2%，主要據點的工程師額外加成
      const max = this.wallMax(base);
      const eng = this.isPrimary(base) ? this.engineerEffect('wallRegen') : 0;
      base.wallHp = Math.min(max, this.wallHp(base) + (0.002 + eng) * max * (dtMs / 1000));
    });
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
