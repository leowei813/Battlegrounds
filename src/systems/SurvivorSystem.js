import {
  CLASSES, CLASS_KEYS, JOBS, SURVIVOR_NAMES, MAX_SURVIVOR_LEVEL, xpToNext, recruitCost,
} from '../config/survivors.js';
import { housingCap } from '../config/facilities.js';
import { SLOT_KEYS } from '../config/equipment.js';
import { createSurvivor } from '../core/GameState.js';
import { clamp, pick, randInt } from '../utils/math.js';
import { payCost } from './costUtils.js';

/**
 * 倖存者系統：屬性計算、經驗/升級、工作指派、招募、受傷。
 */
export class SurvivorSystem {
  constructor(game) {
    this.game = game;
  }

  get list() {
    return this.game.state.survivors;
  }

  get(id) {
    return this.list.find((s) => s.id === id) || null;
  }

  leader() {
    return this.list.find((s) => s.isLeader);
  }

  housing() {
    return housingCap(this.game.state.shelter.facilities.warehouse.level);
  }

  activeSkills(sv) {
    return CLASSES[sv.classId].skills.filter((sk) => sv.level >= sk.unlock);
  }

  /** 合併所有已解鎖技能效果 */
  skillEffects(sv) {
    const fx = {};
    this.activeSkills(sv).forEach((sk) => {
      Object.entries(sk.effect).forEach(([k, v]) => {
        fx[k] = typeof v === 'number' ? (fx[k] || 0) + v : v;
      });
    });
    return fx;
  }

  /**
   * 計算最終戰鬥屬性：職業基礎 + 等級成長 + 裝備 + 技能 + 研究。
   */
  stats(sv) {
    const cls = CLASSES[sv.classId];
    const lv = sv.level - 1;
    const s = {
      hp: cls.base.hp + cls.growth.hp * lv,
      atk: cls.base.atk + cls.growth.atk * lv,
      def: cls.base.def + cls.growth.def * lv,
      crit: cls.base.crit,
      critDmg: cls.base.critDmg,
      dodge: cls.base.dodge,
      atkSpeed: cls.base.atkSpeed,
      lootBonus: 0,
    };
    let atkPct = 0;
    let hpPct = 0;
    let defPct = 0;
    SLOT_KEYS.forEach((slot) => {
      const item = this.game.equipment.getItem(sv.equipment[slot]);
      if (!item) return;
      const st = this.game.equipment.itemStats(item);
      Object.entries(st).forEach(([k, v]) => {
        if (k === 'atkPct') atkPct += v;
        else if (k === 'hpPct') hpPct += v;
        else s[k] = (s[k] || 0) + v;
      });
    });
    const fx = this.skillEffects(sv);
    defPct += fx.defPct || 0;
    const rb = this.game.research.bonuses();
    atkPct += rb.atkPct || 0;
    hpPct += rb.hpPct || 0;
    s.crit += rb.critAdd || 0;
    s.critDmg += rb.critDmgAdd || 0;

    s.atk = Math.round(s.atk * (1 + atkPct));
    s.hp = Math.round(s.hp * (1 + hpPct));
    s.def = Math.round(s.def * (1 + defPct));
    s.crit = clamp(s.crit, 0, 0.75);
    s.dodge = clamp(s.dodge, 0, 0.6);
    s.atkSpeed = clamp(+s.atkSpeed.toFixed(2), 0.3, 3);
    s.critDmg = +s.critDmg.toFixed(2);
    s.power = Math.round(s.atk * s.atkSpeed * (1 + s.crit * (s.critDmg - 1)) * 4 + s.hp * 0.4 + s.def * 3);
    s.skills = fx;
    return s;
  }

  isAvailable(sv, now = Date.now()) {
    return sv.status === 'idle' && sv.injuredUntil <= now && !this.isGarrisoned(sv.id);
  }

  isGarrisoned(id) {
    return this.game.state.shelter.defenses.some((d) => d.garrisonId === id);
  }

  gainXp(sv, amount) {
    if (sv.level >= MAX_SURVIVOR_LEVEL) return;
    sv.xp += Math.round(amount);
    while (sv.level < MAX_SURVIVOR_LEVEL && sv.xp >= xpToNext(sv.level)) {
      sv.xp -= xpToNext(sv.level);
      sv.level += 1;
      this.game.log(`⬆️ ${sv.name} 升到 Lv${sv.level}`, 'success');
      const newSkill = CLASSES[sv.classId].skills.find((sk) => sk.unlock === sv.level);
      if (newSkill) this.game.toast(`${sv.name} 習得技能「${newSkill.name}」`, 'success');
    }
  }

  /** 受傷：teamInjuryReduce 來自隊伍中醫生的技能 */
  injure(sv, minutes, teamInjuryReduce = 0, at = Date.now()) {
    const reduce = clamp(this.game.research.bonus('injuryReduce') + teamInjuryReduce, 0, 0.85);
    sv.injuredUntil = at + minutes * 60000 * (1 - reduce);
    this.game.log(`🩸 ${sv.name} 受傷了，需要休養`, 'danger');
  }

  healCost() {
    return { medicine: 5 };
  }

  heal(id) {
    const sv = this.get(id);
    if (!sv || sv.injuredUntil <= Date.now()) return { ok: false, reason: '不需要治療' };
    if (!payCost(this.game.state, this.healCost())) return { ok: false, reason: '藥品不足' };
    sv.injuredUntil = 0;
    return { ok: true, msg: `${sv.name} 已痊癒` };
  }

  setJob(id, job) {
    const sv = this.get(id);
    if (!sv || !JOBS[job]) return { ok: false, reason: '無效指令' };
    if (sv.status === 'exploring') return { ok: false, reason: '探索中' };
    sv.job = job;
    return { ok: true };
  }

  randomName() {
    const used = new Set(this.list.map((s) => s.name));
    const free = SURVIVOR_NAMES.filter((n) => !used.has(n));
    return pick(free.length ? free : SURVIVOR_NAMES);
  }

  /** 生成候選倖存者（探索遭遇或招募所用） */
  makeCandidate(level = 1) {
    return createSurvivor(this.randomName(), pick(CLASS_KEYS), Math.max(1, level));
  }

  currentRecruitCost() {
    return recruitCost(this.list.length);
  }

  /** 花費金錢與食物，於避難所廣播招募 */
  recruitRandom() {
    if (this.list.length >= this.housing()) return { ok: false, reason: '床位不足，請升級倉庫' };
    if (!payCost(this.game.state, this.currentRecruitCost())) return { ok: false, reason: '資源不足' };
    const avgLv = Math.max(1, Math.round(this.list.reduce((s, v) => s + v.level, 0) / this.list.length) - 1);
    const sv = this.makeCandidate(randInt(Math.max(1, avgLv - 2), avgLv + 1));
    this.addSurvivor(sv);
    return { ok: true, msg: `${sv.name}（${CLASSES[sv.classId].name}）加入了避難所` };
  }

  addSurvivor(sv) {
    this.list.push(sv);
    this.game.state.stats.recruits += 1;
    this.game.log(`🤝 ${sv.name}（${CLASSES[sv.classId].name} Lv${sv.level}）加入`, 'success');
  }

  /** 接受探索中遇到的倖存者 */
  acceptCandidate(id) {
    const pool = this.game.state.recruitPool;
    const cand = pool.find((c) => c.id === id);
    if (!cand) return { ok: false, reason: '對方已離開' };
    if (this.list.length >= this.housing()) return { ok: false, reason: '床位不足，請升級倉庫' };
    this.game.state.recruitPool = pool.filter((c) => c.id !== id);
    this.addSurvivor(cand);
    return { ok: true, msg: `${cand.name} 加入了你的隊伍` };
  }

  rejectCandidate(id) {
    this.game.state.recruitPool = this.game.state.recruitPool.filter((c) => c.id !== id);
    return { ok: true };
  }

  dismiss(id) {
    const sv = this.get(id);
    if (!sv || sv.isLeader) return { ok: false, reason: '無法遣散領袖' };
    if (sv.status === 'exploring') return { ok: false, reason: '探索中' };
    SLOT_KEYS.forEach((slot) => { sv.equipment[slot] = null; });
    this.game.state.shelter.defenses.forEach((d) => {
      if (d.garrisonId === id) d.garrisonId = null;
    });
    this.game.state.survivors = this.list.filter((s) => s.id !== id);
    return { ok: true, msg: `${sv.name} 離開了避難所` };
  }

  update(now) {
    this.list.forEach((sv) => {
      if (sv.injuredUntil && sv.injuredUntil <= now) {
        sv.injuredUntil = 0;
        this.game.log(`💚 ${sv.name} 已康復`, 'info');
      }
    });
  }
}
