import { DEFENSES } from '../config/defenses.js';
import { ENEMIES, BOSSES } from '../config/enemies.js';
import { RESOURCE_KEYS, COIN_GAIN_MUL } from '../config/constants.js';
import {
  SIEGE_SCALING, BREACH_LOSS, BREACH_BUILDING_DAMAGE_CHANCE, BASE_SIZES,
} from '../config/civilization.js';
import { zoneAt } from '../config/zones.js';
import { SUPPLIES, AMMO_FOR, ammoPerShot } from '../config/supplies.js';
import { FACILITIES } from '../config/facilities.js';
import { TIME_PHASES, ZOMBIE_HOURS_FRACTION } from '../config/timePhases.js';
import {
  chance, pick, randFloat, weightedPick, clamp,
} from '../utils/math.js';

export const WORLD = {
  WALL_R: 42,
  SLOT_R: 30, // 防禦設施在據點內（只影響特效位置；攻打據點時不論方向都會開火）
  SPAWN_R: 150,
};
const MAX_ZOMBIES = 45;
/** 屍潮一波一波來襲：入夜後第一波的延遲、波與波之間的間隔（秒）、同一波殭屍的出現間隔 */
const FIRST_WAVE_DELAY = 8;
const WAVE_LULL = 40;
const WAVE_SPAWN_GAP = 0.45;
const MAX_FX = 250;
const BREACH_GRACE = 90;
/** 沒有彈藥時只能近戰：駐守人員只打得到貼在圍牆上的殭屍，瞭望塔只打得到塔旁的殭屍 */
const MELEE_REACH = WORLD.WALL_R + 8;
const MELEE_REACH_POST = 14;
/** 殭屍對圍牆的傷害係數（放置遊戲節奏：讓防線有時間反應） */
const WALL_DMG_MUL = 0.3;

/**
 * 單一據點的屍潮防守模擬。純邏輯，以「世界座標」運作（中心 0,0）。
 * 強度取決於「文明度」與「據點危險度」，與遊戲天數無關。
 */
export class BaseSiege {
  constructor(game, baseId) {
    this.game = game;
    this.baseId = baseId;
    this.zombies = [];
    this.fx = [];
    this.spawnTimer = 0;
    this.wave = 0; // 今晚第幾波
    this.waveLeft = 0; // 本波尚未出現的殭屍數
    this.lull = FIRST_WAVE_DELAY; // 距離下一波的秒數
    this.cooldowns = new Map();
    this.guardCd = 1;
    this.bossDay = 0;
    this.nextId = 1;
    this.wasActive = false;
    this.nightKills = 0;
    this.nightWallStart = 0;
    this.breachedTonight = false;
  }

  /** 今晚的編號（夜晚跨過午夜，以入夜那天計） */
  nightKey(now = Date.now()) {
    return this.game.time.nightKey(now);
  }

  /** 今晚已來過幾波（存在據點上，重新整理或離線再回來也不會重新計算） */
  savedWaves() {
    const n = this.base?.nightWaves;
    return n && n.night === this.nightKey() ? n.waves : 0;
  }

  /** 今晚友好玩家的協防紀錄（存在據點上，重新整理也不會遺失） */
  assistLog() {
    const night = this.nightKey();
    const b = this.base;
    if (b.assistLog?.night !== night) b.assistLog = { night, result: 'ongoing', list: {} };
    return b.assistLog;
  }

  /** 防守紀錄裡的協防說明 */
  assistNote(result) {
    const log = this.base?.assistLog;
    if (!log || !Object.keys(log.list).length) return '';
    if (log.result === 'ongoing') log.result = result;
    const parts = Object.values(log.list).map((x) => `「${x.name}」${x.kind === 'cover' ? '的防禦設施' : '的協防隊'}（傷害 ${x.dmg}、擊殺 ${x.kills}）`);
    return `🛡️ 友好協防：${parts.join('、')}`;
  }

  /** 入夜：開始統計今晚的防守 */
  startNight() {
    this.wave = Math.max(this.wave, this.savedWaves());
    this.nightKills = 0;
    this.nightWallStart = this.game.shelter.wallHp(this.base);
    this.breachedTonight = false;
  }

  /** 天亮：今晚有屍潮來襲且沒有被突破 → 記錄防禦成功 */
  endNight() {
    if (this.wave > 0 && !this.breachedTonight && this.base) {
      this.game.shelter.recordDefense({
        base: this.base, attacker: '屍潮', success: true, waves: this.wave, kills: this.nightKills,
        wallLost: Math.max(0, this.nightWallStart - this.game.shelter.wallHp(this.base)), note: this.assistNote('ok'),
      });
    }
  }

  slotPos(slot, total = this.base?.defenses.length || 8) {
    const a = (slot / total) * Math.PI * 2 - Math.PI / 2;
    return { x: Math.cos(a) * WORLD.SLOT_R, y: Math.sin(a) * WORLD.SLOT_R };
  }

  pushFx(e) {
    if (this.fx.length < MAX_FX) this.fx.push(e);
  }

  drainFx() {
    const out = this.fx;
    this.fx = [];
    return out;
  }

  get base() {
    return this.game.shelter.base(this.baseId);
  }

  danger() {
    return this.game.shelter.dangerLevel(this.base);
  }

  /** 據點所在區域（安全區～深淵區） */
  zone() {
    const b = this.base;
    return zoneAt(b.lat, b.lon);
  }

  /** 殭屍等級 = 1 + 文明度加成 + 據點危險度加成 + 區域加成（夜間 +1） */
  zombieLevel() {
    const phase = this.game.time.phase();
    const dangerBonus = Math.floor((this.danger() - 1) * SIEGE_SCALING.dangerLevelMul);
    return Math.max(1, 1 + this.game.civilization.levelBonus() + dangerBonus + this.zone().siegeLevel + (phase.danger > 1.5 ? 1 : 0));
  }

  /** 屍潮數量倍率：據點越大越難防守、區域越危險屍潮越多 */
  sizeMul() {
    return (BASE_SIZES[this.base.size]?.siegeMul || 1) * this.zone().siegeMul;
  }

  /** 每波殭屍數：讓整晚的平均強度等同「每 spawnInterval 秒一隻」 */
  waveSize() {
    // 文明度越低每波越少（新手只有一小波）
    const n = (WAVE_LULL / this.spawnInterval()) * (1 + Math.min(0.6, this.wave * 0.08)) * this.game.civilization.waveSizeMul();
    return Math.max(2, Math.round(n * randFloat(0.85, 1.15)));
  }

  /** 今晚最多幾波（依文明度） */
  maxWaves() {
    return this.game.civilization.maxWaves();
  }

  /** 今晚的屍潮是否已全部結束（所有波次都來過、殭屍也清光了） */
  nightOver() {
    return this.wave >= this.maxWaves() && this.waveLeft <= 0 && this.zombies.length === 0;
  }

  /** 屍潮波次資訊（UI 顯示） */
  waveInfo() {
    if (!this.active()) return { active: false };
    return {
      active: true, wave: this.wave, maxWaves: this.maxWaves(), over: this.nightOver(), attacking: this.waveLeft > 0 || this.zombies.length > 0, nextIn: Math.max(0, Math.ceil(this.lull)), left: this.waveLeft + this.zombies.length,
    };
  }

  /** 現在是否有屍潮：只在夜晚與午夜；防線被突破後，當晚不再來襲 */
  active() {
    return this.game.time.phase().zombies && !this.quiet();
  }

  /** 防線被突破後到天亮前的平靜期 */
  quiet(now = Date.now()) {
    return (this.base?.quietUntil || 0) > now;
  }

  /**
   * 屍潮間隔（秒）：文明度與據點危險度越高越密集。白天回傳 Infinity。
   * @param {object} [phase] 指定時段（離線估算用），預設為目前時段
   */
  spawnInterval(phase = this.game.time.phase()) {
    if (!phase.zombies) return Infinity;
    const dangerMul = 1 + (this.danger() - 1) * SIEGE_SCALING.dangerSpawn;
    return Math.max(0.5, 9 / (phase.zombieMul * this.game.civilization.spawnMul() * dangerMul * this.sizeMul()));
  }

  /** 敵人種類依文明度解鎖 */
  pickEnemy() {
    const civ = this.game.civilization;
    const phase = this.game.time.phase();
    return weightedPick({
      walker: 10,
      infected: civ.unlocked('infected') ? 6 : 1,
      berserker: civ.unlocked('berserker') || (phase.danger > 1.5 && civ.unlocked('infected')) ? 3 : 0,
      mutant: civ.unlocked('mutant') ? 2 : 0,
      nightStalker: phase.special && civ.unlocked('nightStalker') ? 3 : 0,
    });
  }

  spawn(enemyId, isBoss = false) {
    const def = isBoss ? BOSSES[enemyId] : ENEMIES[enemyId];
    const e = this.game.combat.createEnemy(enemyId, this.zombieLevel() + (isBoss ? 3 : 0));
    const a = randFloat(0, Math.PI * 2);
    // 屍潮殭屍額外受文明度強化（地圖戰鬥的敵人不受此影響）
    const hpMul = this.game.civilization.siegeHpMul();
    const atkMul = this.game.civilization.siegeAtkMul();
    this.zombies.push({
      id: this.nextId++,
      enemyId,
      boss: isBoss,
      x: Math.cos(a) * WORLD.SPAWN_R,
      y: Math.sin(a) * WORLD.SPAWN_R,
      hp: Math.round(e.maxHp * hpMul),
      maxHp: Math.round(e.maxHp * hpMul),
      atk: e.atk * atkMul,
      atkSpeed: def.atkSpeed,
      speed: def.speed * randFloat(0.85, 1.15),
      color: def.color,
      atkCd: 0,
      slow: 0,
      stunUntil: 0,
      xp: e.xp,
      coins: e.coins,
      partsChance: def.partsChance,
      t: 0,
    });
    if (isBoss) this.game.toast(`⚠️ Boss「${def.name}」正在接近「${this.base.name}」！`, 'danger');
  }

  startWave() {
    this.wave += 1;
    if (this.base) this.base.nightWaves = { night: this.nightKey(), waves: this.wave };
    this.waveLeft = this.waveSize();
    this.lull = WAVE_LULL * randFloat(0.8, 1.2);
    this.spawnTimer = 0;
    if (this.game.shelter.isPrimary(this.base)) this.game.log(`🧟 第 ${this.wave}/${this.maxWaves()} 波屍潮來襲「${this.base.name}」（${this.waveLeft} 隻）`, 'danger');
    this.game.bus.emit('siege:wave', { baseId: this.baseId, wave: this.wave, count: this.waveLeft });
  }

  /** dt：秒 */
  update(dt) {
    if (!this.base) return;
    let remain = Math.min(dt, 1);
    while (remain > 0) {
      const step = Math.min(remain, 0.1);
      this.step(step);
      remain -= step;
    }
  }

  step(dt) {
    const now = performance.now() / 1000;
    const sh = this.game.shelter;
    const base = this.base;
    const phase = this.game.time.phase();
    const day = this.game.time.day();

    // 生成（只在夜間）：一波一波來襲，波與波之間有喘息時間
    const active = this.active();
    // 入夜與天亮時統計今晚的防守結果
    if (active && !this.wasActive) this.startNight();
    if (!active && this.wasActive) this.endNight();
    this.wasActive = active;
    if (!active) {
      this.wave = 0;
      this.waveLeft = 0;
      this.lull = FIRST_WAVE_DELAY;
    } else if (this.waveLeft > 0) {
      this.spawnTimer -= dt;
      if (this.spawnTimer <= 0 && this.zombies.length < MAX_ZOMBIES) {
        this.spawnTimer = WAVE_SPAWN_GAP * randFloat(0.6, 1.4);
        this.spawn(this.pickEnemy());
        this.waveLeft -= 1;
      }
    } else if (this.wave < this.maxWaves()) {
      // 波數依文明度：最後一波結束後，今晚不再來襲
      this.lull -= dt;
      if (this.lull <= 0) this.startWave();
    }
    // Boss 只襲擊主要據點：文明度達門檻後，每 3 天的午夜來襲
    if (phase.special && sh.isPrimary(base) && this.game.civilization.unlocked('boss') && day % 3 === 0 && this.bossDay !== day) {
      this.bossDay = day;
      this.spawn(pick(Object.keys(BOSSES)), true);
    }

    // 減速光環（路障、陷阱）
    const defenses = base.defenses.filter((d) => d.type && d.level > 0);
    const auras = defenses
      .filter((d) => d.type === 'barricade' || d.type === 'trap')
      .map((d) => ({ ...this.slotPos(d.slot), ...DEFENSES[d.type].stats(d.level) }));

    // 移動與攻擊圍牆（圍牆耐久歸零時被殭屍攻擊 → 防線突破）
    const reduction = sh.wallReduction(base);
    let breached = false;
    for (const z of this.zombies) {
      z.t += dt;
      const dist = Math.hypot(z.x, z.y);
      z.slow = 0;
      // 路障、陷阱圍繞整座據點：接近圍牆的殭屍都會被減速
      auras.forEach((a) => {
        if (dist < WORLD.WALL_R + a.range) z.slow = Math.max(z.slow, a.slow);
      });
      if (now < z.stunUntil) continue;
      if (!active) {
        // 天亮：殭屍撤回建築內（往外退出地圖，不給獎勵）
        const v = z.speed * 1.4 * dt;
        z.x += (z.x / dist) * v;
        z.y += (z.y / dist) * v;
        if (dist > WORLD.SPAWN_R + 4) z.retreated = true;
      } else if (dist > WORLD.WALL_R + 2) {
        const v = z.speed * (1 - z.slow) * dt;
        z.x -= (z.x / dist) * v;
        z.y -= (z.y / dist) * v;
      } else {
        z.atkCd -= dt;
        if (z.atkCd <= 0) {
          z.atkCd = 1 / z.atkSpeed;
          const dmg = z.atk * WALL_DMG_MUL * (1 - reduction);
          base.wallHp = sh.wallHp(base) - dmg;
          if (sh.wallHp(base) <= 0) breached = true;
          this.pushFx({ type: 'wallHit', x: z.x, y: z.y, dmg: Math.round(dmg) });
        }
      }
    }

    // 防禦塔
    const dmgMul = sh.towerDamageMul(base);
    defenses.forEach((d) => {
      const def = DEFENSES[d.type];
      const st = def.stats(d.level);
      if (!st.fireRate) return;
      if (def.power && !this.powered()) return; // 電網：發電機沒運轉就不會作用
      const key = d.slot;
      const cd = (this.cooldowns.get(key) ?? 0) - dt;
      if (cd > 0) {
        this.cooldowns.set(key, cd);
        return;
      }
      const pos = this.slotPos(d.slot);
      // 攻打據點的殭屍都在防禦設施的火力範圍內（陷阱只作用在圍牆附近）
      const range = d.type === 'trap' || d.type === 'electricFence' ? WORLD.WALL_R + st.range : WORLD.SPAWN_R;
      const inRange = this.zombies.filter((z) => z.hp > 0 && Math.hypot(z.x, z.y) <= range);
      if (!inRange.length) {
        this.cooldowns.set(key, 0);
        return;
      }
      this.cooldowns.set(key, 1 / st.fireRate);
      const target = inRange.reduce((a, b) => (Math.hypot(a.x, a.y) < Math.hypot(b.x, b.y) ? a : b));
      this.fire(d, st, pos, target, inRange, dmgMul);
    });

    // 駐守（防禦駐守工作）的倖存者從中心開火
    this.guardCd -= dt;
    if (this.guardCd <= 0) {
      this.guardCd = 1;
      const guards = this.guards();
      guards.forEach(({ sv, stats }) => {
        // 有遠程武器與彈藥時從中心射擊；否則只能近戰，打得到貼在圍牆上的殭屍
        const reach = (z) => Math.hypot(z.x, z.y) < (this.canShoot(sv) ? 80 : MELEE_REACH);
        const targets = this.zombies.filter((z) => z.hp > 0 && reach(z));
        if (!targets.length) return;
        // 集火最靠近圍牆的目標
        const t = targets.reduce((a, b) => (Math.hypot(a.x, a.y) < Math.hypot(b.x, b.y) ? a : b));
        const atk = this.attackPower(sv, stats);
        const crit = chance(stats.crit);
        this.damage(t, atk.value * 0.6 * this.guardMul() * (crit ? stats.critDmg : 1), crit);
        this.pushFx({ type: 'shot', kind: atk.ranged ? 'guard' : 'melee', x1: 0, y1: 0, x2: t.x, y2: t.y });
      });
    }

    // 友好玩家前來協防：每秒依對方公開的火力攻擊最靠近圍牆的殭屍
    this.assistCd = (this.assistCd ?? 1) - dt;
    if (this.assistCd <= 0 && active && sh.isPrimary(base)) {
      this.assistCd = 1;
      (this.game.assist?.incoming() || []).forEach((h) => {
        const targets = this.zombies.filter((z) => z.hp > 0);
        if (!targets.length || !h.dps) return;
        const t = targets.reduce((a, b) => (Math.hypot(a.x, a.y) < Math.hypot(b.x, b.y) ? a : b));
        // 記錄每位協防玩家的傷害與擊殺（寫進防守紀錄，也公開給協防的人當戰報）
        const log = this.assistLog();
        const rec = log.list[h.id] || (log.list[h.id] = { name: h.name, kind: h.kind, dmg: 0, kills: 0 });
        const before = t.hp;
        this.damage(t, h.dps);
        rec.dmg += Math.round(Math.min(before, h.dps));
        if (t.hp <= 0) rec.kills += 1;
        const a = Math.atan2(t.y, t.x) + randFloat(-0.5, 0.5);
        this.pushFx({ type: 'shot', kind: 'guard', x1: Math.cos(a) * WORLD.WALL_R, y1: Math.sin(a) * WORLD.WALL_R, x2: t.x, y2: t.y });
      });
    }

    this.collectDead();
    if (!active) this.zombies = this.zombies.filter((z) => !z.retreated);

    if (breached) this.breach();
  }

  /** 防禦駐守的倖存者住在主要據點，只防衛主要據點 */
  guards() {
    if (!this.game.shelter.isPrimary(this.base)) return [];
    const away = this.game.assist?.assistingIds() || new Set(); // 正在協防友好玩家
    return this.game.state.survivors
      .filter((s) => s.job === 'guard' && s.status === 'idle' && !s.severe && !this.game.survivors.isGarrisoned(s.id) && !away.has(s.id))
      .map((s) => ({ sv: s, stats: this.game.survivors.stats(s) }));
  }

  /** 研究對個別防禦塔與駐守人員的傷害加成 */
  typeMul(type) {
    return 1 + this.game.research.bonus(`defDmg_${type}`);
  }

  guardMul() {
    return 1 + this.game.research.bonus('guardDmgPct');
  }

  fire(d, st, pos, target, inRange, dmgMul) {
    const base = st.damage * dmgMul * this.typeMul(d.type);
    switch (d.type) {
      case 'trap':
        inRange.forEach((z) => this.damage(z, base / st.fireRate));
        this.pushFx({ type: 'trap', x: pos.x, y: pos.y, r: st.range });
        break;
      case 'electricFence': {
        const nowS = performance.now() / 1000;
        inRange.forEach((z) => {
          this.damage(z, base);
          z.stunUntil = Math.max(z.stunUntil || 0, nowS + st.stun);
          this.pushFx({ type: 'shot', kind: 'em', x1: z.x * 0.9, y1: z.y * 0.9, x2: z.x, y2: z.y });
        });
        break;
      }
      case 'machineGun':
        this.damage(target, base);
        this.pushFx({ type: 'shot', kind: 'mg', x1: pos.x, y1: pos.y, x2: target.x, y2: target.y });
        break;
      case 'flameTower':
        this.zombies
          .filter((z) => Math.hypot(z.x - target.x, z.y - target.y) <= st.aoeRadius)
          .forEach((z) => this.damage(z, base));
        this.pushFx({ type: 'flame', x1: pos.x, y1: pos.y, x2: target.x, y2: target.y, r: st.aoeRadius });
        break;
      case 'emTower': {
        const chain = [target];
        let cur = target;
        for (let i = 1; i < st.chain; i += 1) {
          const next = inRange
            .filter((z) => !chain.includes(z))
            .sort((a, b) => Math.hypot(a.x - cur.x, a.y - cur.y) - Math.hypot(b.x - cur.x, b.y - cur.y))[0];
          if (!next) break;
          chain.push(next);
          cur = next;
        }
        const nowS = performance.now() / 1000;
        let from = pos;
        chain.forEach((z, i) => {
          this.damage(z, base * (1 - i * 0.2));
          z.stunUntil = nowS + st.stun;
          this.pushFx({ type: 'shot', kind: 'em', x1: from.x, y1: from.y, x2: z.x, y2: z.y });
          from = z;
        });
        break;
      }
      case 'watchPost': {
        const sv = this.game.survivors.get(d.garrisonId);
        if (!sv || sv.status !== 'idle') return;
        const s = this.game.survivors.stats(sv);
        // 沒有遠程武器或彈藥：只能近戰，打瞭望塔旁邊的殭屍
        let tgt = target;
        if (!this.canShoot(sv)) {
          tgt = inRange.find((z) => Math.hypot(z.x, z.y) <= WORLD.WALL_R + MELEE_REACH_POST);
          if (!tgt) return;
        }
        const atk = this.attackPower(sv, s);
        const crit = chance(s.crit);
        this.damage(tgt, atk.value * st.garrisonMul * dmgMul * this.guardMul() * (crit ? s.critDmg : 1), crit);
        this.pushFx({ type: 'shot', kind: atk.ranged ? 'sniper' : 'melee', x1: pos.x, y1: pos.y, x2: tgt.x, y2: tgt.y });
        break;
      }
      default:
        break;
    }
  }

  /**
   * 估算用的攻擊力（不消耗彈藥）：沒有彈藥時只算近戰，且打得到的機會較少。
   * @param {boolean} apparent 外人看到的強度：只看得到拿著什麼武器，不知道還有沒有彈藥
   */
  meleeOrRangedAtk(sv, apparent = false) {
    const s = this.game.survivors.stats(sv);
    const weapon = this.game.equipment.getItem(sv.equipment?.weapon);
    if (!weapon || !AMMO_FOR[weapon.type]) return s.atk * 0.5;
    if (apparent || this.canShoot(sv)) return s.atk;
    return Math.max(1, s.atk - (this.game.equipment.itemStats(weapon).atk || 0)) * 0.5;
  }

  /** 是否能遠程射擊：武器是槍械／弓弩，且身上或據點庫存有彈藥 */
  canShoot(sv) {
    const weapon = this.game.equipment.getItem(sv.equipment?.weapon);
    const need = weapon && AMMO_FOR[weapon.type];
    if (!need) return false;
    const perShot = ammoPerShot(weapon.type);
    return (sv.bag?.[need.ammo] || 0) + (this.game.state.supplies?.[need.ammo] || 0) >= perShot;
  }

  /**
   * 駐守人員一次攻擊的攻擊力：槍械／弓弩每次射擊消耗彈藥（先用身上的，再用據點庫存）；
   * 沒有彈藥時只能近戰，失去武器的攻擊力。
   * @returns {{value:number, ranged:boolean}}
   */
  attackPower(sv, stats) {
    const weapon = this.game.equipment.getItem(sv.equipment?.weapon);
    const need = weapon && AMMO_FOR[weapon.type];
    if (!need) return { value: stats.atk, ranged: false };
    let n = ammoPerShot(weapon.type);
    const bag = sv.bag || {};
    const store = this.game.state.supplies || {};
    if ((bag[need.ammo] || 0) + (store[need.ammo] || 0) < n) {
      if (!sv.noAmmo) this.game.log(`🎯 ${sv.name} 沒有${SUPPLIES[need.ammo].name}了，只能近戰防守`, 'danger');
      sv.noAmmo = need.ammo;
      return { value: Math.max(1, stats.atk - (this.game.equipment.itemStats(weapon).atk || 0)), ranged: false };
    }
    const fromBag = Math.min(n, bag[need.ammo] || 0);
    if (fromBag) {
      bag[need.ammo] -= fromBag;
      if (bag[need.ammo] <= 0) delete bag[need.ammo];
      n -= fromBag;
    }
    if (n > 0) {
      store[need.ammo] -= n;
      if (store[need.ammo] <= 0) delete store[need.ammo];
    }
    delete sv.noAmmo;
    return { value: stats.atk, ranged: true };
  }

  damage(z, amount, crit = false) {
    const dmg = Math.max(1, Math.round(amount));
    z.hp -= dmg;
    if (this.game.state.settings.showDamage) this.pushFx({ type: 'dmg', x: z.x, y: z.y, dmg, crit });
  }

  collectDead() {
    const dead = this.zombies.filter((z) => z.hp <= 0);
    if (!dead.length) return;
    this.zombies = this.zombies.filter((z) => z.hp > 0);
    const st = this.game.state.stats;
    let coins = 0;
    let parts = 0;
    let xp = 0;
    this.nightKills += dead.length;
    dead.forEach((z) => {
      st.kills += 1;
      st.siegeKills += 1;
      if (z.boss) st.bossKills += 1;
      coins += Math.ceil(z.coins * 0.5);
      xp += z.xp;
      if (chance(z.partsChance * 0.5)) parts += z.boss ? 5 : 1;
      this.pushFx({ type: 'death', x: z.x, y: z.y, color: z.color, boss: z.boss });
      if (z.boss) this.game.log(`👑 「${this.base.name}」防線擊殺了 Boss！`, 'success');
    });
    this.game.grant({ coins: Math.round(coins * COIN_GAIN_MUL), parts });
    // 經驗分給防守人員
    const defenders = [
      ...this.guards().map((g) => g.sv),
      ...this.base.defenses.map((d) => this.game.survivors.get(d.garrisonId)).filter(Boolean),
    ];
    const recipients = defenders.length ? defenders : [this.game.survivors.leader()];
    recipients.forEach((sv) => this.game.survivors.gainXp(sv, (xp * 0.5) / recipients.length));
  }

  breach() {
    const sh = this.game.shelter;
    const base = this.base;
    const rate = sh.isPrimary(base) ? BREACH_LOSS.primary : BREACH_LOSS.outpost;
    const pct = Math.round(rate * 100);
    const res = this.game.state.resources;
    const lost = {};
    RESOURCE_KEYS.forEach((k) => {
      lost[k] = Math.floor(sh.exposed(k) * rate); // 地窖裡的不會損失
      res[k] -= lost[k];
    });
    this.zombies.forEach((z) => this.pushFx({ type: 'death', x: z.x, y: z.y, color: z.color }));
    this.zombies = [];
    // 圍牆被打壞：耐久歸零，需指派修繕人員修理才會恢復
    base.wallHp = 0;
    this.waveLeft = 0;
    this.lull = BREACH_GRACE;
    // 防線被突破後，殭屍散去，當晚不再來襲
    base.quietUntil = this.game.time.nextDawn();
    this.game.state.stats.breaches += 1;
    const damaged = this.damageBuildings(base);
    this.breachedTonight = true;
    sh.recordDefense({
      base, attacker: '屍潮', success: false, lost, damaged, kills: this.nightKills, waves: this.wave,
      wallLost: Math.max(0, this.nightWallStart || sh.wallMax(base)), note: ['防線被突破，圍牆耐久歸零', this.assistNote('breached')].filter(Boolean).join('。'),
    });
    const dmgText = damaged.length ? `，${damaged.length} 棟建築損毀` : '';
    damaged.forEach((d) => this.game.log(`🏚️ ${base.name}：${d}`, 'danger'));
    this.game.toast(`💥 「${base.name}」防線被突破！損失 ${pct}% 資源${dmgText}，請強化圍牆與防禦塔`, 'danger');
    this.game.bus.emit('siege:breach', { baseId: base.id, lost, damaged });
    this.game.bus.emit('shelter:changed');
  }

  /**
   * 突破後建築損毀：每棟已建造的設施/防禦建築有機率降 1 級，1 級的會被拆除。
   * @returns {string[]} 損毀描述
   */
  damageBuildings(base) {
    const out = [];
    Object.entries(base.facilities).forEach(([id, f]) => {
      if (f.level < 1 || !chance(BREACH_BUILDING_DAMAGE_CHANCE)) return;
      if (id === 'wall' && f.level <= 1) return; // 圍牆最低保留 1 級
      f.level -= 1;
      out.push(f.level === 0 ? `${FACILITIES[id].name}被摧毀` : `${FACILITIES[id].name}損毀，降為 Lv${f.level}`);
    });
    base.defenses.forEach((d) => {
      if (!d.type || d.level < 1 || !chance(BREACH_BUILDING_DAMAGE_CHANCE)) return;
      const name = DEFENSES[d.type].name;
      if (d.level <= 1) {
        Object.assign(d, { type: null, level: 0, garrisonId: null });
        out.push(`${name}被拆毀`);
      } else {
        d.level -= 1;
        out.push(`${name}損毀，降為 Lv${d.level}`);
      }
    });
    if (out.length) this.game.civilization.invalidate();
    return out;
  }

  /**
   * 防禦總 DPS（離線估算與 UI 顯示）
   * @param {{apparent?:boolean}} [opts] apparent：從外面觀察到的強度（NPC 判斷是否繞路用，不知道彈藥存量）
   */
  /** 電網是否有電：據點有發電機且發電機有燃料運轉 */
  powered() {
    return !!this.base && (this.base.facilities.generator?.level || 0) > 0 && this.game.resources.generatorActive();
  }

  defenseDps({ apparent = false, towersOnly = false } = {}) {
    const sh = this.game.shelter;
    const base = this.base;
    if (!base) return 0;
    const mul = sh.towerDamageMul(base);
    let dps = 0;
    base.defenses.forEach((d) => {
      if (!d.type || d.level < 1) return;
      if (DEFENSES[d.type].power && !this.powered()) return;
      const st = DEFENSES[d.type].stats(d.level);
      if (d.type === 'watchPost') {
        const sv = this.game.survivors.get(d.garrisonId);
        if (sv) dps += this.meleeOrRangedAtk(sv, apparent) * st.garrisonMul * st.fireRate * mul * this.guardMul();
      } else {
        dps += st.damage * st.fireRate * mul * this.typeMul(d.type) * (st.aoe ? 1.8 : 1) * (st.chain ? 2 : 1);
      }
    });
    if (!towersOnly) this.guards().forEach(({ sv }) => { dps += this.meleeOrRangedAtk(sv, apparent) * 0.6 * this.guardMul(); });
    return Math.round(dps);
  }

  /** 離線時估算此據點的擊殺數（只計算夜間時段，以夜晚的屍潮頻率估算） */
  estimateOfflineKills(seconds) {
    const spawns = (seconds * ZOMBIE_HOURS_FRACTION) / this.spawnInterval(TIME_PHASES.night);
    const avgHp = this.game.combat.createEnemy('infected', this.zombieLevel()).maxHp;
    const capacity = (this.defenseDps() * seconds * ZOMBIE_HOURS_FRACTION * 0.25) / avgHp;
    return Math.floor(clamp(Math.min(spawns, capacity), 0, 5000));
  }
}

/**
 * 管理所有據點的屍潮。每個據點同時承受屍潮（背景據點不繪製但持續模擬），
 * ShelterScene 只繪製目前檢視的據點。
 */
export class SiegeSystem {
  constructor(game) {
    this.game = game;
    /** @type {Map<string, BaseSiege>} */
    this.sieges = new Map();
  }

  /** 取得據點的屍潮（省略為主要據點） */
  of(baseId) {
    const id = baseId || this.game.shelter.primary()?.id;
    if (!id) return null;
    if (!this.sieges.has(id)) this.sieges.set(id, new BaseSiege(this.game, id));
    return this.sieges.get(id);
  }

  /**
   * 推進所有據點的屍潮，並把本幀的特效以 `siege:fx` 事件廣播
   * （避難所場景與地圖圖層各自取用需要的據點）。
   */
  update(dt) {
    const ids = new Set(this.game.state.bases.map((b) => b.id));
    this.sieges.forEach((_, id) => { if (!ids.has(id)) this.sieges.delete(id); });
    const fx = [];
    ids.forEach((id) => {
      const s = this.of(id);
      s.update(dt);
      s.drainFx().forEach((e) => fx.push({ ...e, baseId: id }));
    });
    if (fx.length) this.game.bus.emit('siege:fx', fx);
  }

  /**
   * 離線防守收益（需研究解鎖）：以各據點防禦 DPS 估算可擊殺數量。
   */
  simulateOffline(ms) {
    if (!this.game.research.hasUnlock('offlineDefense')) return null;
    const seconds = ms / 1000;
    const kills = Math.floor(this.game.state.bases.reduce((s, b) => s + this.of(b.id).estimateOfflineKills(seconds), 0)
      * (1 + this.game.research.bonus('offlineDefPct')));
    if (!kills) return { kills: 0, coins: 0 };
    const coins = kills * 2;
    const parts = Math.floor(kills / 60);
    this.game.state.stats.kills += kills;
    this.game.state.stats.siegeKills += kills;
    this.game.grant({ coins, parts });
    return { kills, coins, parts };
  }
}
