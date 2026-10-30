import { BUILD_QUEUE_SIZE } from '../config/constants.js';
import {
  FACILITIES, FACILITY_MAX_LEVEL, facilityBuildTime, wallMaxHp,
} from '../config/facilities.js';
import { DEFENSES, DEFENSE_MAX_LEVEL, defenseBuildTime } from '../config/defenses.js';
import { RESEARCH } from '../config/research.js';
import { canAfford, payCost, scaleCost } from './costUtils.js';

/**
 * 避難所系統：選址、設施升級、防禦建築、施工佇列、圍牆耐久。
 */
export class ShelterSystem {
  constructor(game) {
    this.game = game;
  }

  get state() {
    return this.game.state.shelter;
  }

  hasShelter() {
    return !!this.state.poiId;
  }

  setShelter(poi) {
    const relocating = this.hasShelter();
    if (relocating && this.state.buildQueue.length) return { ok: false, reason: '施工中無法搬遷' };
    if (relocating && this.game.state.expeditions.length) return { ok: false, reason: '有隊伍在外，無法搬遷' };
    if (relocating && !payCost(this.game.state, { coins: 200, fuel: 50 })) {
      return { ok: false, reason: '搬遷需要 200 金錢與 50 燃料' };
    }
    Object.assign(this.state, { poiId: poi.id, name: poi.name, lat: poi.lat, lon: poi.lon });
    this.game.log(`🏠 ${relocating ? '搬遷' : '建立'}避難所於「${poi.name}」`, 'success');
    return { ok: true, msg: `避難所設於 ${poi.name}` };
  }

  // ---------- 折扣與加成 ----------

  /** 駐守中的工程師技能折扣 */
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

  wallMax() {
    const lv = this.state.facilities.wall.level;
    const barricade = this.state.defenses
      .filter((d) => d.type === 'barricade' && d.level > 0)
      .reduce((s, d) => s + DEFENSES.barricade.stats(d.level).wallBonus, 0);
    return Math.round(wallMaxHp(lv) * (1 + this.game.research.bonus('wallHpPct')) + barricade);
  }

  wallHp() {
    if (this.state.wallHp == null) this.state.wallHp = this.wallMax();
    return Math.min(this.state.wallHp, this.wallMax());
  }

  wallReduction() {
    return Math.min(0.5, this.state.facilities.wall.level * 0.03);
  }

  towerDamageMul() {
    const gen = this.game.resources.generatorActive() ? this.state.facilities.generator.level * 0.06 : 0;
    return 1 + this.game.research.bonus('towerDmgPct') + gen + this.engineerEffect('towerDmg');
  }

  rangeMul() {
    return 1 + this.state.facilities.watchtower.level * 0.06;
  }

  // ---------- 佇列 ----------

  queueFull() {
    return this.state.buildQueue.length >= BUILD_QUEUE_SIZE;
  }

  isFacilityBusy(id) {
    return this.state.buildQueue.some((q) => q.kind === 'facility' && q.id === id);
  }

  isSlotBusy(slot) {
    return this.state.buildQueue.some((q) => q.kind === 'defense' && q.slot === slot);
  }

  // ---------- 設施 ----------

  facilityCost(id) {
    const lv = this.state.facilities[id].level + 1;
    return this.discounted(FACILITIES[id].cost(lv));
  }

  canUpgradeFacility(id) {
    const fac = this.state.facilities[id];
    if (!fac) return { ok: false, reason: '未知設施' };
    if (!this.hasShelter()) return { ok: false, reason: '尚未建立避難所' };
    if (fac.level >= FACILITY_MAX_LEVEL) return { ok: false, reason: '已達最高等級' };
    if (this.isFacilityBusy(id)) return { ok: false, reason: '施工中' };
    if (this.queueFull()) return { ok: false, reason: `施工佇列已滿（${BUILD_QUEUE_SIZE}）` };
    if (!canAfford(this.game.state, this.facilityCost(id))) return { ok: false, reason: '資源不足' };
    return { ok: true };
  }

  upgradeFacility(id) {
    const check = this.canUpgradeFacility(id);
    if (!check.ok) return check;
    payCost(this.game.state, this.facilityCost(id));
    const target = this.state.facilities[id].level + 1;
    this.state.buildQueue.push({
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

  /** 在槽位建造新防禦或升級既有防禦 */
  buildDefense(slot, type) {
    const d = this.state.defenses[slot];
    if (!d) return { ok: false, reason: '無效槽位' };
    if (!this.hasShelter()) return { ok: false, reason: '尚未建立避難所' };
    if (d.type && d.type !== type) return { ok: false, reason: '請先拆除原有建築' };
    if (!this.isDefenseUnlocked(type)) return { ok: false, reason: this.defenseLockReason(type) };
    if (d.level >= DEFENSE_MAX_LEVEL) return { ok: false, reason: '已達最高等級' };
    if (this.isSlotBusy(slot)) return { ok: false, reason: '施工中' };
    if (this.queueFull()) return { ok: false, reason: '施工佇列已滿' };
    const target = d.level + 1;
    const cost = this.defenseCost(type, target);
    if (!payCost(this.game.state, cost)) return { ok: false, reason: '資源不足' };
    d.type = type;
    this.state.buildQueue.push({
      kind: 'defense', slot, id: type, targetLevel: target, startAt: Date.now(), endAt: Date.now() + defenseBuildTime(target) * 1000,
    });
    return { ok: true, msg: `${DEFENSES[type].name} ${target === 1 ? '建造' : '升級'}中` };
  }

  demolish(slot) {
    const d = this.state.defenses[slot];
    if (!d?.type) return { ok: false, reason: '空地' };
    if (this.isSlotBusy(slot)) return { ok: false, reason: '施工中' };
    Object.assign(d, { type: null, level: 0, garrisonId: null });
    return { ok: true, msg: '已拆除' };
  }

  garrison(slot, survivorId) {
    const d = this.state.defenses[slot];
    if (d?.type !== 'watchPost' || d.level < 1) return { ok: false, reason: '只有瞭望塔可駐守' };
    if (!survivorId) {
      d.garrisonId = null;
      return { ok: true, msg: '已撤回駐守' };
    }
    const sv = this.game.survivors.get(survivorId);
    if (!sv || sv.status === 'exploring') return { ok: false, reason: '該倖存者無法駐守' };
    this.state.defenses.forEach((x) => { if (x.garrisonId === survivorId) x.garrisonId = null; });
    d.garrisonId = survivorId;
    sv.job = 'guard';
    return { ok: true, msg: `${sv.name} 駐守瞭望塔` };
  }

  // ---------- 更新 ----------

  update(now, dtMs) {
    const done = this.state.buildQueue.filter((q) => q.endAt <= now);
    if (done.length) {
      this.state.buildQueue = this.state.buildQueue.filter((q) => q.endAt > now);
      done.forEach((q) => this.completeBuild(q));
    }
    // 圍牆自然修復：每秒 0.3%，工程師駐守額外加成
    const max = this.wallMax();
    const regen = (0.003 + this.engineerEffect('wallRegen')) * max * (dtMs / 1000);
    this.state.wallHp = Math.min(max, this.wallHp() + regen);
  }

  completeBuild(q) {
    const st = this.game.state;
    if (q.kind === 'facility') {
      st.shelter.facilities[q.id].level = q.targetLevel;
      this.game.log(`🏗️ ${FACILITIES[q.id].name} 升到 Lv${q.targetLevel}`, 'success');
    } else {
      const d = st.shelter.defenses[q.slot];
      d.type = q.id;
      d.level = q.targetLevel;
      this.game.log(`🏗️ ${DEFENSES[q.id].name} 升到 Lv${q.targetLevel}`, 'success');
    }
    st.stats.upgrades += 1;
    this.game.bus.emit('shelter:changed');
  }
}
