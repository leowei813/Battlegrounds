import { dormCap, clinicRegen } from '../config/facilities.js';
import {
  CLASSES, CLASS_KEYS, JOBS, SURVIVOR_NAMES, MAX_SURVIVOR_LEVEL, xpToNext, recruitCost,
  SURVIVOR_RARITY, survivorRarityTable, hireFee, RECRUIT_BOARD_SIZE, RECRUIT_BOARD_MS, RECRUIT_STAY_MS, MAX_SURVIVORS, BASE_SURVIVOR_CAP, LEADER_LEVELS_PER_SLOT, RECRUIT_CHOICES, VITALS,
} from '../config/survivors.js';
import { DAY_REAL_MS } from '../config/constants.js';
import { SLOT_KEYS, RARITIES, STACK_MAX } from '../config/equipment.js';
import {
  SUPPLIES, isSupply, unitWeight, suppliesOf,
} from '../config/supplies.js';
import { createSurvivor } from '../core/GameState.js';
import {
  withSeed,
  clamp, pick, randInt, weightedPick, chance,
} from '../utils/math.js';
import { canAfford, payCost, scaleCost } from './costUtils.js';

/**
 * 倖存者系統：屬性計算、經驗/升級、工作指派、招募（三選一）、
 * 生命值 / 重傷 / 飢餓 / 永久死亡、驅逐。
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

  /** 人員上限：3 + 領袖等級 ÷ 5 + 各據點等級總和，最多 10 人（含領袖），且不超過宿舍可住人數 */
  housing() {
    return Math.min(this.rankCap(), this.dormCap());
  }

  /** 領袖等級與據點規模決定的上限 */
  rankCap() {
    const leaderLv = this.leader()?.level || 1;
    const baseLv = this.game.state.bases.reduce((s, b) => s + this.game.shelter.baseLevel(b), 0);
    return Math.min(MAX_SURVIVORS, BASE_SURVIVOR_CAP + Math.floor(leaderLv / LEADER_LEVELS_PER_SLOT) + baseLv);
  }

  /** 宿舍可住人數（避難所的宿舍） */
  dormCap() {
    return dormCap(this.game.shelter.maxLevel('dormitory'));
  }

  /** 人數已滿時的原因說明 */
  fullReason() {
    const dorm = this.game.shelter.maxLevel('dormitory');
    if (this.dormCap() <= this.rankCap()) {
      return dorm ? `宿舍只能住 ${this.dormCap()} 人，請升級宿舍` : `沒有宿舍最多只能有 ${this.dormCap()} 人，請在避難所建造宿舍`;
    }
    return `人數已達上限（${this.housing()} 人），提升領袖等級或據點等級可增加上限`;
  }

  /** 上限明細（UI 說明用） */
  housingBreakdown() {
    const leaderLv = this.leader()?.level || 1;
    return {
      base: BASE_SURVIVOR_CAP,
      leader: Math.floor(leaderLv / LEADER_LEVELS_PER_SLOT),
      bases: this.game.state.bases.reduce((s, b) => s + this.game.shelter.baseLevel(b), 0),
      max: MAX_SURVIVORS,
      rank: this.rankCap(),
      dorm: this.dormCap(),
      dormLv: this.game.shelter.maxLevel('dormitory'),
    };
  }

  growthMul(sv) {
    // 主角沒有品級，成長比照最高品級「稀有」
    if (sv.isLeader) return SURVIVOR_RARITY.legendary.growth;
    return SURVIVOR_RARITY[sv.rarity]?.growth ?? 1;
  }

  /** 品級資料（主角沒有品級，比照最高品級） */
  rarityDef(sv) {
    return sv.isLeader ? SURVIVOR_RARITY.legendary : SURVIVOR_RARITY[sv.rarity] || SURVIVOR_RARITY.common;
  }

  /** 可解放的技能數：依品級（劣質 1 → 稀有 6） */
  skillSlots(sv) {
    return this.rarityDef(sv).skills;
  }

  /** 已解放的技能：品級允許的前幾個技能中，等級已達到的 */
  activeSkills(sv) {
    return CLASSES[sv.classId].skills.slice(0, this.skillSlots(sv)).filter((sk) => sv.level >= sk.unlock);
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
    // 品級越高，每級提升的能力越多
    const lv = (sv.level - 1) * this.growthMul(sv);
    const bm = this.rarityDef(sv).base; // 品級越高，基礎能力越好
    const s = {
      hp: cls.base.hp * bm + cls.growth.hp * lv,
      atk: cls.base.atk * bm + cls.growth.atk * lv,
      def: cls.base.def * bm + cls.growth.def * lv,
      crit: cls.base.crit,
      critDmg: cls.base.critDmg,
      dodge: cls.base.dodge,
      atkSpeed: cls.base.atkSpeed,
      lootBonus: 0,
      lifeSteal: 0,
      exploreSpeed: 0,
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
        else if (k === 'defPct') defPct += v;
        else s[k] = (s[k] || 0) + v;
      });
    });
    const fx = this.skillEffects(sv);
    defPct += fx.defPct || 0;
    atkPct += fx.atkPct || 0;
    hpPct += fx.hpPct || 0;
    s.crit += fx.critAdd || 0;
    s.dodge += fx.dodgeAdd || 0;
    s.lifeSteal += fx.lifeStealAdd || 0;
    const rb = this.game.research.bonuses();
    const weapon = this.game.equipment.getItem(sv.equipment.weapon);
    atkPct += (rb.atkPct || 0) + (weapon ? rb[`catAtk_${weapon.cat}`] || 0 : 0);
    hpPct += rb.hpPct || 0;
    defPct += rb.defPct || 0;
    s.crit += rb.critAdd || 0;
    s.critDmg += rb.critDmgAdd || 0;
    s.dodge += rb.dodgeAdd || 0;
    s.atkSpeed += rb.atkSpeedAdd || 0;
    s.lifeSteal += rb.lifeStealAdd || 0;

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

  isAvailable(sv) {
    return sv.status === 'idle' && !sv.severe && !this.isGarrisoned(sv.id);
  }

  // ---------------- 生命值 / 重傷 / 飢餓 ----------------

  maxHp(sv) {
    return this.stats(sv).hp;
  }

  /** 目前生命（null 代表滿血） */
  hpOf(sv) {
    const max = this.maxHp(sv);
    return sv.hp == null ? max : clamp(sv.hp, 0, max);
  }

  setHp(sv, value) {
    const max = this.maxHp(sv);
    sv.hp = value >= max ? null : Math.max(0, Math.round(value * 10) / 10);
  }

  isStarving() {
    return !!this.game.state.starving;
  }

  /**
   * 重傷（生命歸零）：無法行動，並扣除經驗（可能降級）。
   * @param {string} reason 顯示原因
   */
  becomeSevere(sv, reason = '', at = Date.now()) {
    sv.hp = 0;
    if (sv.severe) return;
    sv.severe = true;
    const lost = this.penalizeXp(sv);
    this.game.log(`🩸 ${sv.name} ${reason}重傷倒地，經驗 -${lost.xp}${lost.levelDown ? `，降為 Lv${sv.level}` : ''}`, 'danger');
    if (this.isStarving()) sv.zeroSince = sv.zeroSince || at;
  }

  /**
   * 重傷懲罰：扣除「目前等級升級所需經驗」的 10%；經驗不足時降一級並從上一級扣除。
   * @returns {{xp:number, levelDown:boolean}}
   */
  penalizeXp(sv) {
    const loss = Math.max(1, Math.round(xpToNext(sv.level) * VITALS.xpPenaltyPct));
    if (sv.xp >= loss) {
      sv.xp -= loss;
      return { xp: loss, levelDown: false };
    }
    if (sv.level <= 1) {
      const xp = sv.xp;
      sv.xp = 0;
      return { xp, levelDown: false };
    }
    sv.level -= 1;
    sv.xp = Math.max(0, xpToNext(sv.level) + sv.xp - loss);
    return { xp: loss, levelDown: true };
  }

  /** 醫生的照護速度（每分鐘最大生命比例）：比診療室慢，醫生等級越高越快 */
  medicRate(medic) {
    return medic ? VITALS.medicCarePctPerMin * (1 + (medic.level - 1) * 0.03) : 0;
  }

  /** 身邊能照顧這位倖存者的醫生（不含自己、不能是重傷者）：在據點時找據點內的醫生，外出時找同一支隊伍的醫生 */
  caringMedic(sv) {
    const out = sv.status === 'exploring';
    const team = out ? this.game.state.expeditions.find((e) => e.memberIds.includes(sv.id))?.memberIds || [] : null;
    return this.list.filter((m) => m.id !== sv.id && m.classId === 'medic' && !m.severe
      && (out ? team.includes(m.id) : m.status !== 'exploring'))
      .sort((a, b) => b.level - a.level)[0] || null;
  }

  /** 這位倖存者目前的回復速度：據點內＝診療室＋醫生照護；外出＝隊伍中醫生的照護 */
  healRate(sv) {
    const medic = this.medicRate(this.caringMedic(sv));
    if (sv.status === 'exploring') return medic;
    return this.clinicRate() + medic;
  }

  /** 診療室的休息回復速度（每分鐘最大生命比例） */
  clinicRate() {
    return clinicRegen(this.game.shelter.maxLevel('clinic'));
  }

  /** 醫療站工作的醫生提高全員回復速度 */
  regenMul() {
    const medics = this.list.filter((s) => s.classId === 'medic' && s.job === 'clinic' && s.status === 'idle' && !s.severe).length;
    return 1 + Math.min(1, medics * VITALS.medicRegenBonus) + this.game.research.bonus('regenPct');
  }

  /**
   * 推進生命狀態。
   * @param {number} dtMs 經過時間
   * @param {number} starvingMs 其中處於飢餓狀態的時間（資源系統計算，飢餓發生在區間末段）
   */
  updateVitals(now, dtMs, starvingMs = 0) {
    const fedMin = Math.max(0, dtMs - starvingMs) / 60000;
    const starveMin = Math.min(dtMs, starvingMs) / 60000;
    const regenMul = this.regenMul();
    [...this.list].forEach((sv) => {
      const max = this.maxHp(sv);
      let hp = this.hpOf(sv);
      // 有食物的時段：在據點有診療室、或身邊有醫生（據點內或同一支隊伍）時才會回復
      if (fedMin > 0) {
        const base = this.healRate(sv);
        const rate = sv.severe ? base * VITALS.severeClinicMul * (1 + this.game.research.bonus('severeRegenPct')) : base;
        hp = Math.min(max, hp + max * rate * regenMul * fedMin);
        sv.zeroSince = 0;
        if (sv.severe && hp >= max * VITALS.severeRecoverRatio) {
          sv.severe = false;
          this.game.log(`💚 ${sv.name} 已脫離重傷`, 'info');
        }
      }
      // 飢餓的時段：持續扣血，直到重傷
      if (starveMin > 0) {
        const drain = max * VITALS.starveDrainPctPerMin * Math.max(0.3, 1 - this.game.research.bonus('starveResist'));
        const minToZero = hp / drain;
        hp = Math.max(0, hp - drain * starveMin);
        if (hp <= 0) {
          const zeroAt = now - (starveMin - minToZero) * 60000;
          if (!sv.severe) this.becomeSevere(sv, '因飢餓', zeroAt);
          sv.zeroSince = sv.zeroSince || zeroAt;
        }
      }
      this.setHp(sv, hp);
      // 飢餓且生命為 0 持續遊戲內 3 天 → 永久死亡（領袖不會死亡）
      if (!sv.isLeader && sv.severe && hp <= 0 && sv.zeroSince && this.isStarving()
        && now - sv.zeroSince >= VITALS.deathGameDays * DAY_REAL_MS) {
        this.kill(sv, '因長期飢餓');
      }
    });
  }

  /** 距離永久死亡的剩餘時間（毫秒）；不在死亡倒數中則為 null */
  deathCountdown(sv, now = Date.now()) {
    if (sv.isLeader || !sv.severe || !sv.zeroSince || !this.isStarving()) return null;
    return Math.max(0, sv.zeroSince + VITALS.deathGameDays * DAY_REAL_MS - now);
  }

  kill(sv, reason = '') {
    this.removeSurvivor(sv.id);
    this.game.state.stats.deaths = (this.game.state.stats.deaths || 0) + 1;
    this.game.log(`⚰️ ${sv.name} ${reason}永久死亡`, 'danger');
    this.game.toast(`⚰️ ${sv.name} ${reason}永久死亡…`, 'danger');
  }

  /** 移出名單（驅逐或死亡）：卸下裝備（留在背包）、撤回駐守 */
  removeSurvivor(id) {
    const sv = this.get(id);
    if (!sv) return;
    SLOT_KEYS.forEach((slot) => { sv.equipment[slot] = null; });
    // 攜帶的物資與物品留在倉庫
    Object.entries(sv.bag || {}).forEach(([k, v]) => {
      const pool = isSupply(k) ? this.game.state.supplies : this.game.state.resources;
      pool[k] = (pool[k] || 0) + v;
    });
    this.game.equipment.items.forEach((it) => { if (it.loc === id) it.loc = 'store'; });
    this.game.state.bases.forEach((b) => b.defenses.forEach((d) => {
      if (d.garrisonId === id) d.garrisonId = null;
    }));
    this.game.state.survivors = this.list.filter((s) => s.id !== id);
  }

  isGarrisoned(id) {
    return !!this.game.shelter.garrisonOf(id);
  }

  gainXp(sv, amount) {
    if (sv.level >= MAX_SURVIVOR_LEVEL) return;
    sv.xp += Math.round(amount * (1 + this.game.research.bonus('xpPct')));
    while (sv.level < MAX_SURVIVOR_LEVEL && sv.xp >= xpToNext(sv.level)) {
      sv.xp -= xpToNext(sv.level);
      sv.level += 1;
      this.game.log(`⬆️ ${sv.name} 升到 Lv${sv.level}`, 'success');
      const newSkill = CLASSES[sv.classId].skills.find((sk) => sk.unlock === sv.level);
      if (newSkill) this.game.toast(`${sv.name} 習得技能「${newSkill.name}」`, 'success');
    }
  }

  /** 受到傷害（探索陷阱等）；歸零則重傷 */
  damage(sv, amount, reason = '', at = Date.now()) {
    const hp = this.hpOf(sv) - amount;
    if (hp <= 0) this.becomeSevere(sv, reason, at);
    else this.setHp(sv, hp);
  }

  /** 可用的藥品（倉庫 + 該隊員背包），依回復量由低到高 */
  medicines(sv = null) {
    const st = this.game.state;
    return suppliesOf('med').map((k) => ({
      key: k, ...SUPPLIES[k], store: st.supplies?.[k] || 0, bag: sv?.bag?.[k] || 0,
    })).filter((m) => m.store + m.bag > 0);
  }

  /** 藥品回復量（研究「醫療」加成） */
  healAmount(sv, key) {
    return this.maxHp(sv) * Math.min(1, (SUPPLIES[key]?.heal || 0) * (1 + this.game.research.bonus('healPct')));
  }

  /**
   * 使用藥品治療：依藥品回復不同比例的生命（大型醫藥箱 100%）；飢餓中無法治療。
   * 先用隊員自己背包裡的，再用倉庫的（倉庫需在避難所）。研究「藥品節約」有機率不消耗。
   * @param {string} [key] 藥品；未指定時用最小但足以補滿（或回復量最高）的藥品
   */
  heal(id, key = null) {
    const sv = this.get(id);
    if (!sv) return { ok: false, reason: '找不到倖存者' };
    if (this.isStarving()) return { ok: false, reason: '飢餓中無法治療，請先補充食物' };
    const max = this.maxHp(sv);
    const lost = max - this.hpOf(sv);
    if (lost <= 0) return { ok: false, reason: '生命已滿' };
    const meds = this.medicines(sv).filter((m) => m.bag > 0 || this.atShelter(sv));
    if (!meds.length) return { ok: false, reason: '沒有藥品（探索可找到紗布、繃帶、醫藥箱等）' };
    const med = key ? meds.find((m) => m.key === key) : (meds.find((m) => this.healAmount(sv, m.key) >= lost) || meds[meds.length - 1]);
    if (!med) return { ok: false, reason: '沒有這種藥品' };
    const saved = chance(Math.min(0.5, this.game.research.bonus('healCostReduce')));
    if (!saved) {
      const pool = med.bag > 0 ? sv.bag : this.game.state.supplies;
      pool[med.key] -= 1;
      if (pool[med.key] <= 0) delete pool[med.key];
    }
    const hp = Math.min(max, this.hpOf(sv) + this.healAmount(sv, med.key));
    this.setHp(sv, hp);
    if (sv.severe && hp >= max * VITALS.severeRecoverRatio) sv.severe = false;
    sv.zeroSince = 0;
    this.game.state.stats.healed = (this.game.state.stats.healed || 0) + 1;
    return { ok: true, msg: `${sv.name} 使用${med.name}恢復了生命${saved ? '（藥品節約：沒有消耗）' : ''}${sv.severe ? '' : '，已可行動'}` };
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

  /** 各品級出現機率（%）：研究「招募技術」提升高品級機率 */
  rarityOdds() {
    return survivorRarityTable(this.game.research.level('r_tech'));
  }

  rollRarity() {
    return weightedPick(this.rarityOdds());
  }

  /** 生成候選倖存者（探索遭遇或招募所用），品級隨機；研究「老手」提高等級 */
  makeCandidate(level = 1) {
    const lv = Math.max(1, level + Math.floor(this.game.research.bonus('recruitLevelAdd')));
    return createSurvivor(this.randomName(), pick(CLASS_KEYS), lv, this.rollRarity());
  }

  currentRecruitCost() {
    return scaleCost(recruitCost(this.list.length), Math.max(0.3, 1 - this.game.research.bonus('recruitCostReduce')));
  }

  /** 招募候選人的等級：目前隊伍平均等級附近 */
  candidateLevel() {
    const avgLv = Math.max(1, Math.round(this.list.reduce((s, v) => s + v.level, 0) / Math.max(1, this.list.length)) - 1);
    return randInt(Math.max(1, avgLv - 2), avgLv + 1);
  }

  // ---------- 每小時固定出現的倖存者 ----------

  /** 招募任何倖存者都要支付的雇用費（研究「招募宣傳」可降低） */
  hireCost(sv) {
    return { coins: Math.max(1, Math.round(hireFee(sv) * Math.max(0.3, 1 - this.game.research.bonus('recruitCostReduce')))) };
  }

  boardSize() {
    return RECRUIT_BOARD_SIZE + Math.floor(this.game.research.bonus('boardSlots'));
  }

  /** 到整點更新名單 */
  /** 附近的倖存者（使用存檔種子） */
  updateBoard(now = Date.now()) {
    this.expireCandidates(now);
    return withSeed(this.game.state.rng, 'recruit', () => this.updateBoardNow(now));
  }

  updateBoardNow(now = Date.now()) {
    const st = this.game.state;
    const board = st.recruitBoard;
    if (now < (board.refreshAt || 0) && board.list.length) return;
    board.list = Array.from({ length: this.boardSize() }, () => this.makeCandidate(this.candidateLevel()));
    board.refreshAt = (Math.floor(now / RECRUIT_BOARD_MS) + 1) * RECRUIT_BOARD_MS;
    this.game.bus.emit('recruit:board');
  }

  hireFromBoard(id) {
    const board = this.game.state.recruitBoard;
    const sv = board.list.find((c) => c.id === id);
    if (!sv) return { ok: false, reason: '對方已離開' };
    if (this.isFull()) return { ok: false, reason: this.fullReason() };
    if (!payCost(this.game.state, this.hireCost(sv))) return { ok: false, reason: '金錢不足' };
    board.list = board.list.filter((c) => c.id !== id);
    this.addSurvivor(sv);
    return { ok: true, msg: `${sv.name}（${RARITIES[sv.rarity].name}・${CLASSES[sv.classId].name}）加入了避難所` };
  }

  isFull() {
    return this.list.length >= this.housing();
  }

  /**
   * 廣播招募：支付費用後出現 3 位候選人，可選擇其中一位或放棄（放棄不退費）。
   * @returns {{ok:boolean, offer?:object[], reason?:string}}
   */
  /** 廣播招募（使用存檔種子） */
  recruitRoll() {
    return withSeed(this.game.state.rng, 'recruit', () => this.recruitRollNow());
  }

  recruitRollNow(now = Date.now()) {
    this.expireCandidates(now);
    if (this.game.state.recruitOffer?.length) return { ok: true, offer: this.game.state.recruitOffer };
    // 人數已滿也可以廣播：候選人會停留 1 小時，期間擴充宿舍或空出位置後再雇用
    if (!canAfford(this.game.state, this.currentRecruitCost())) return { ok: false, reason: '資源不足' };
    payCost(this.game.state, this.currentRecruitCost());
    this.game.state.recruitOffer = Array.from({ length: RECRUIT_CHOICES }, () => this.makeCandidate(this.candidateLevel()));
    this.game.state.recruitOfferUntil = now + RECRUIT_STAY_MS;
    return { ok: true, offer: this.game.state.recruitOffer };
  }

  /** 候選人停留時間到期就離開（廣播招募的三人、探索遇到的倖存者） */
  expireCandidates(now = Date.now()) {
    const st = this.game.state;
    if (st.recruitOffer?.length) {
      st.recruitOfferUntil = st.recruitOfferUntil || now + RECRUIT_STAY_MS;
      if (now >= st.recruitOfferUntil) {
        st.recruitOffer = null;
        st.recruitOfferUntil = 0;
        this.game.log('📻 廣播招募的候選人等不到回覆，已經離開了', 'info');
      }
    }
    const pool = st.recruitPool || [];
    pool.forEach((c) => { c.leaveAt = c.leaveAt || now + RECRUIT_STAY_MS; });
    const left = pool.filter((c) => now >= c.leaveAt);
    if (left.length) {
      st.recruitPool = pool.filter((c) => now < c.leaveAt);
      this.game.log(`🚶 ${left.map((c) => c.name).join('、')} 等不到回覆，已經離開了`, 'info');
    }
  }

  pickRecruit(id) {
    const offer = this.game.state.recruitOffer || [];
    const sv = offer.find((c) => c.id === id);
    if (!sv) return { ok: false, reason: '候選人已離開' };
    if (this.isFull()) return { ok: false, reason: `${this.fullReason()}（候選人會停留到時間結束）` };
    if (!payCost(this.game.state, this.hireCost(sv))) return { ok: false, reason: '金錢不足，無法支付雇用費' };
    this.game.state.recruitOffer = null;
    this.game.state.recruitOfferUntil = 0;
    this.addSurvivor(sv);
    return { ok: true, msg: `${sv.name}（${RARITIES[sv.rarity].name}・${CLASSES[sv.classId].name}）加入了避難所` };
  }

  /** 放棄此次招募（費用不退還） */
  abandonRecruit() {
    this.game.state.recruitOffer = null;
    this.game.state.recruitOfferUntil = 0;
    return { ok: true, msg: '已放棄此次招募' };
  }

  addSurvivor(sv) {
    this.list.push(sv);
    this.game.state.stats.recruits += 1;
    this.game.log(`🤝 ${sv.name}（${RARITIES[sv.rarity]?.name || ''}${CLASSES[sv.classId].name} Lv${sv.level}）加入`, 'success');
  }

  /** 接受探索中遇到的倖存者 */
  acceptCandidate(id) {
    const pool = this.game.state.recruitPool;
    const cand = pool.find((c) => c.id === id);
    if (!cand) return { ok: false, reason: '對方已離開' };
    if (this.isFull()) return { ok: false, reason: `${this.fullReason()}（對方會停留到時間結束）` };
    this.game.state.recruitPool = pool.filter((c) => c.id !== id);
    this.addSurvivor(cand);
    return { ok: true, msg: `${cand.name} 加入了你的隊伍` };
  }

  rejectCandidate(id) {
    this.game.state.recruitPool = this.game.state.recruitPool.filter((c) => c.id !== id);
    return { ok: true };
  }

  // ---------------- 個人背包（攜帶的資源） ----------------

  /** 背包內容（資源） */
  bagOf(sv) {
    if (!sv.bag) sv.bag = {};
    return sv.bag;
  }

  /** 目前負重（攜帶資源總量） */
  bagLoad(sv) {
    return Object.entries(this.bagOf(sv)).reduce((s, [k, v]) => s + v * unitWeight(k), 0) + this.game.equipment.bagItemWeight(sv);
  }

  /** 倉庫：基本資源在消耗品倉庫，材料物品在物品倉庫 */
  storePool(key) {
    const st = this.game.state;
    if (isSupply(key)) {
      st.supplies = st.supplies || {};
      return st.supplies;
    }
    return st.resources;
  }

  /** 倉庫還能放多少 */
  storeRoom(key) {
    if (isSupply(key)) return this.game.equipment.supplyRoom(key);
    return Math.max(0, this.game.resources.storageCap() - this.game.state.resources[key]);
  }

  /** 負重上限：徒步運載量 + 背包容量 */
  bagCap(sv) {
    return this.game.vehicles.memberCarry(sv);
  }

  /** 在避難所裡才能存取倉庫 */
  atShelter(sv) {
    return !!sv && sv.status === 'idle' && this.game.shelter.hasShelter();
  }

  /** 所有隊員攜帶的某種資源總量 */
  carried(key) {
    return this.list.reduce((s, sv) => s + (sv.bag?.[key] || 0), 0);
  }

  /** 從背包存入倉庫（受倉庫上限限制） */
  deposit(id, key, amount) {
    const sv = this.get(id);
    if (!this.atShelter(sv)) return { ok: false, reason: '不在避難所，無法存取倉庫' };
    const bag = this.bagOf(sv);
    const res = this.storePool(key);
    const room = this.storeRoom(key);
    const n = Math.floor(Math.min(amount, bag[key] || 0, room));
    if (n <= 0) return { ok: false, reason: room <= 0 ? '倉庫已滿' : '背包裡沒有這項物資' };
    bag[key] -= n;
    if (bag[key] <= 0) delete bag[key];
    res[key] = (res[key] || 0) + n;
    return { ok: true, n };
  }

  /** 這種消耗品還能放多少（只看格子：每格堆疊 999） */
  stackRoom(sv, key) {
    const eq = this.game.equipment;
    const cur = this.bagOf(sv)[key] || 0;
    const otherSlots = eq.bagSlotsUsed(sv) - Math.ceil(cur / STACK_MAX);
    return Math.max(0, (eq.bagSlotCap(sv) - otherSlots) * STACK_MAX - cur);
  }

  /** 從倉庫取出放進背包（受負重上限限制） */
  withdraw(id, key, amount) {
    const sv = this.get(id);
    if (!this.atShelter(sv)) return { ok: false, reason: '不在避難所，無法存取倉庫' };
    const bag = this.bagOf(sv);
    const res = this.storePool(key);
    // 同種類消耗品堆疊（每格最多 999），需要新格子時要有空格
    const slotRoom = this.stackRoom(sv, key);
    if (slotRoom <= 0) return { ok: false, reason: '背包格子已滿' };
    const room = Math.floor(Math.max(0, this.bagCap(sv) - this.bagLoad(sv)) / unitWeight(key));
    const n = Math.floor(Math.min(amount, res[key] || 0, room, slotRoom));
    if (n <= 0) return { ok: false, reason: room <= 0 ? '負重已滿' : '倉庫沒有這項物資' };
    res[key] -= n;
    if (isSupply(key) && res[key] <= 0) delete res[key];
    bag[key] = (bag[key] || 0) + n;
    return { ok: true, n };
  }

  /** 全部存入倉庫 */
  depositAll(id) {
    const sv = this.get(id);
    if (!this.atShelter(sv)) return { ok: false, reason: '不在避難所，無法存取倉庫' };
    let total = 0;
    Object.keys(this.bagOf(sv)).forEach((k) => { total += this.deposit(id, k, Infinity).n || 0; });
    return total ? { ok: true, msg: `存入 ${total} 單位物資` } : { ok: false, reason: '沒有可存入的物資（或倉庫已滿）' };
  }

  /**
   * 探索帶回的物資：倉庫放不下的部分由隊員裝進自己的背包，背包也滿了才會遺棄。
   * @returns {number} 遺棄的數量
   */
  stash(members, leftovers) {
    let lost = 0;
    Object.entries(leftovers).forEach(([k, v]) => {
      let rest = Math.floor(v);
      members.forEach((sv) => {
        if (rest <= 0) return;
        const n = Math.min(rest, Math.floor(Math.max(0, this.bagCap(sv) - this.bagLoad(sv)) / unitWeight(k)), this.stackRoom(sv, k));
        if (n <= 0) return;
        this.bagOf(sv)[k] = (this.bagOf(sv)[k] || 0) + n;
        rest -= n;
      });
      lost += rest;
    });
    return lost;
  }

  /** 驅逐隊員（裝備留在背包） */
  dismiss(id) {
    const sv = this.get(id);
    if (!sv || sv.isLeader) return { ok: false, reason: '無法驅逐領袖' };
    if (sv.status === 'exploring') return { ok: false, reason: '探索中無法驅逐' };
    this.removeSurvivor(id);
    this.game.log(`🚪 ${sv.name} 被驅逐出避難所`, 'info');
    return { ok: true, msg: `${sv.name} 已被驅逐` };
  }
}
