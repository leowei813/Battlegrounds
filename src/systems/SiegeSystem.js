import { DEFENSES } from '../config/defenses.js';
import { ENEMIES, BOSSES, ZOMBIE_VS_SURVIVOR, defReduce } from '../config/enemies.js';
import { RESOURCE_KEYS, COIN_GAIN_MUL } from '../config/constants.js';
import {
  SIEGE_SCALING, BREACH_LOSS, BASE_SIZES, SIEGE_REWARD, SIEGE_PENALTY,
} from '../config/civilization.js';
import { zoneAt } from '../config/zones.js';
import {
  SUPPLIES, AMMO_FOR, ammoPerShot, suppliesOf, AMMO_RECOVER, recoverKeyOf, rollRecover,
} from '../config/supplies.js';
import { ITEM_MODELS } from '../config/equipment.js';
import { xpToNext } from '../config/survivors.js';
import { FACILITIES, cellarShelter } from '../config/facilities.js';
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
/** v15.7：波與波之間的等待秒數（原本 40 秒） */
const WAVE_LULL = 15;
/** 每波殭屍數量的計算基準（維持原本 40 秒，改等待時間不影響每波數量） */
const WAVE_SIZE_SECS = 40;
const WAVE_SPAWN_GAP = 0.45;
const MAX_FX = 250;
const BREACH_GRACE = 90;
/** 沒有彈藥時只能近戰：駐守人員只打得到貼在圍牆上的殭屍，瞭望塔只打得到塔旁的殭屍 */
const MELEE_REACH = WORLD.WALL_R + 8;
const MELEE_REACH_POST = 14;
/** 殭屍對圍牆的傷害係數（放置遊戲節奏：讓防線有時間反應） */
const WALL_DMG_MUL = 0.25;
/** 近戰防守時被殭屍反擊的傷害倍率 */
const MELEE_COUNTER = 0.35;
/** 圍牆被打破後，每隔幾秒與衝進來的殭屍交戰一次 */
const GATE_FIGHT_EVERY = 3;
/** 防守失敗時 1 棟防禦設施損毀（降 1 級）的機率 */
const BREACH_DAMAGE = { chance: 0.35 };

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
    this.gateLogged = false;
    /** 沒有據點時的暫存（今晚統計平常存在據點上） */
    this.tmpNight = { kills: 0, recover: {}, wallStart: 0, breached: false, boss: null, waves: 0 };
  }

  /**
   * 今晚的防守統計（擊殺、城牆起始耐久、回收的彈殼箭矢、是否被突破、Boss 戰利品、波數）。
   * 存在據點上：夜裡重新整理不會歸零；天亮前離開遊戲，回來時也會補記防守結果與獎勵。
   */
  nightStats() {
    return this.base?.nightStats || this.tmpNight;
  }

  get nightKills() { return this.nightStats().kills || 0; }

  set nightKills(v) { this.nightStats().kills = v; }

  get nightRecover() { return this.nightStats().recover || (this.nightStats().recover = {}); }

  set nightRecover(v) { this.nightStats().recover = v; }

  get nightWallStart() { return this.nightStats().wallStart || 0; }

  set nightWallStart(v) { this.nightStats().wallStart = v; }

  get breachedTonight() { return !!this.nightStats().breached; }

  set breachedTonight(v) { this.nightStats().breached = !!v; }

  get nightBoss() { return this.nightStats().boss || null; }

  set nightBoss(v) { this.nightStats().boss = v; }

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

  /** 防守紀錄裡的協防清單（標籤顯示）；同時把這一晚的協防結果定案。只算結算的那一晚（前幾晚的協防不會帶進來） */
  assistList(result, night = this.nightKey()) {
    const log = this.base?.assistLog;
    if (!log || log.night !== night || !Object.keys(log.list).length) return [];
    if (log.result === 'ongoing') log.result = result;
    return Object.values(log.list).map((x) => ({
      name: x.name, dmg: Math.round(x.dmg || 0), kills: x.kills || 0, ...(x.kind === 'cover' ? { cover: true } : {}),
    }));
  }

  /** 今晚屍潮的戰鬥明細（存在據點上，天亮或被突破時記到避難所紀錄） */
  nightBattles() {
    const b = this.base;
    const night = this.nightKey();
    if (b.nightBattles?.night !== night) b.nightBattles = { night, battleIds: [] };
    return b.nightBattles;
  }

  /** 取出今晚的戰鬥明細並清空 */
  takeNightBattles() {
    const ids = this.base?.nightBattles?.battleIds || [];
    if (this.base) this.base.nightBattles = null;
    return ids;
  }

  /** 入夜：開始統計今晚的防守（同一晚重新整理時沿用已存的統計） */
  startNight() {
    this.gateLogged = false;
    const night = this.nightKey();
    // 上一晚沒結算（天亮前離開遊戲）：先補記，再開始今晚
    if (this.base?.nightStats && this.base.nightStats.night !== night) {
      this.wave = 0;
      this.endNight();
      this.wave = 0;
    }
    this.wave = Math.max(this.wave, this.savedWaves());
    if (!this.base) return;
    if (!this.base.nightStats) {
      this.base.nightStats = { night, kills: 0, recover: {}, wallStart: this.game.shelter.wallHp(this.base), breached: false, boss: null, waves: this.wave };
    }
  }

  /** 今晚射擊後回收的彈殼與箭矢：放回物品倉庫，回傳實際放入的數量 */
  collectRecovered() {
    const got = this.game.equipment.addSupplies(rollRecover(this.nightRecover || {}));
    this.nightRecover = {};
    return Object.fromEntries(Object.entries(got || {}).filter(([, v]) => v > 0));
  }

  /** 天亮：今晚有屍潮來襲且沒有被突破 → 記錄防禦成功（天亮時不在遊戲中的話，回來時補記） */
  endNight() {
    const st = this.base?.nightStats;
    const waves = Math.max(this.wave, st?.waves || 0);
    if (waves > 0 && !this.breachedTonight && this.base) {
      this.wave = waves;
      const reward = this.dawnReward();
      reward.recovered = this.collectRecovered();
      const entry = this.game.shelter.recordDefense({
        base: this.base, attacker: '屍潮', success: true, waves: this.wave, kills: this.nightKills,
        wallLost: Math.max(0, this.nightWallStart - this.game.shelter.wallHp(this.base)), assists: this.assistList('ok', st?.night ?? this.nightKey()),
        siege: reward, battleIds: this.takeNightBattles(),
      });
      this.game.bus.emit('siege:result', entry);
    }
    if (this.base) delete this.base.nightStats;
  }

  /** 零件的品階範圍（依文明度） */
  partTiers() {
    const max = clamp(1 + Math.floor(this.game.civilization.value() / 150), 1, 5);
    return { max, min: Math.max(1, max - 2) };
  }

  /** 從清單隨機分配 n 個材料 */
  rollSupplies(keys, n) {
    const out = {};
    if (!keys.length) return out;
    for (let i = 0; i < n; i += 1) {
      const k = pick(keys);
      out[k] = (out[k] || 0) + 1;
    }
    return out;
  }

  /**
   * 天亮守住的結算：依城牆剩餘給評價倍率，發放金幣、零件、彈藥（優秀時有機率得到設計圖），
   * 整晚駐守的人額外獲得經驗；今晚擊殺 Boss 另有戰利品。
   */
  dawnReward() {
    const g = this.game;
    const R = SIEGE_REWARD;
    const base = this.base;
    const wallPct = clamp(g.shelter.wallHp(base) / Math.max(1, g.shelter.wallMax(base)), 0, 1);
    const grade = R.grades.find((x) => wallPct >= x.min) || R.grades[R.grades.length - 1];
    const waves = this.wave;
    const coins = Math.round(this.nightKills * R.coinsPerKill * grade.mul);
    const { min, max } = this.partTiers();
    const parts = this.rollSupplies(suppliesOf('part', max, min), Math.round(waves * R.partsPerWave * grade.mul));
    // 彈藥：依駐守人員使用的子彈種類（沒有槍的話給 9mm）
    const guards = this.guards().map(({ sv }) => sv);
    const ammoKeys = [...new Set(guards.map((sv) => g.survivors.ammoNeed(sv)?.ammo).filter(Boolean))];
    const ammo = this.rollSupplies(ammoKeys.length ? ammoKeys : ['ammo9'], Math.round(waves * R.ammoPerWave * grade.mul));
    const blueprints = [];
    if (grade.id === 'excellent' && chance(R.blueprintChance)) blueprints.push(g.equipment.makeBlueprint(this.zombieLevel()));
    const items = { ...parts };
    Object.entries(ammo).forEach(([k, v]) => { items[k] = (items[k] || 0) + v; });
    const got = g.grant({ coins, ...items }, true);
    const gained = Object.fromEntries(Object.entries(items).map(([k]) => [k, got[k] || 0]).filter(([, v]) => v > 0));
    g.state.inventory.blueprints.push(...blueprints);
    // 駐守經驗：這一晚有參與防守的人（任一波來襲時在駐守或在瞭望塔上）
    // v10.16：依結算的那一晚比對紀錄（天亮後才上線補結算也算），結算時已經出門探索的人也拿得到
    const rec = this.base.nightDefenders;
    const night = this.base.nightStats?.night ?? this.nightKey();
    const ids = rec?.night === night && rec.ids?.length ? rec.ids : this.defenderIds();
    const xp = [...new Set(ids)].map((id) => g.survivors.get(id)).filter(Boolean).map((sv) => {
      const amount = Math.round(xpToNext(sv.level) * R.guardXpPct);
      g.survivors.gainXp(sv, amount);
      return { name: sv.name, level: sv.level, xp: amount };
    });
    const out = {
      grade: grade.id, gradeName: grade.name, mul: grade.mul, wallPct: Math.round(wallPct * 100),
      coins, items: gained, blueprints: blueprints.map((b) => ITEM_MODELS[b.model]?.name || '設計圖'), xp,
      boss: this.nightBoss,
    };
    const list = [`💰${coins}`, ...Object.entries(gained).map(([k, v]) => `${SUPPLIES[k].icon}${SUPPLIES[k].name}×${v}`)];
    if (out.blueprints.length) list.push(`📜${out.blueprints.join('、')}`);
    g.log(`🌅 「${base.name}」守住屍潮（評價 ${grade.name} ×${grade.mul}）：獲得 ${list.join('、')}${xp.length ? `；${xp.length} 名駐守人員獲得經驗` : ''}`, 'success');
    return out;
  }

  /** 擊殺 Boss 的戰利品：高階零件，並有機率掉落罕見以上裝備或設計圖 */
  bossLoot(z) {
    const g = this.game;
    const B = SIEGE_REWARD.boss;
    const { max } = this.partTiers();
    const items = this.rollSupplies(suppliesOf('part', 5, Math.max(3, max)), B.parts);
    const got = g.grant(items, true);
    const loot = { name: BOSSES[z.enemyId]?.name || 'Boss', items: Object.fromEntries(Object.entries(got).filter(([k, v]) => SUPPLIES[k] && v > 0)), gear: null, blueprint: null };
    if (chance(B.gearChance)) {
      const item = g.equipment.generate({ level: this.zombieLevel(), minRarity: 'epic' });
      if (g.equipment.addItem(item, 'Boss 戰利品')) loot.gear = { name: item.name, rarity: item.rarity };
    }
    if (chance(B.blueprintChance)) {
      const bp = g.equipment.makeBlueprint(this.zombieLevel());
      g.state.inventory.blueprints.push(bp);
      loot.blueprint = ITEM_MODELS[bp.model]?.name || '設計圖';
    }
    this.nightBoss = loot;
    const list = Object.entries(loot.items).map(([k, v]) => `${SUPPLIES[k].icon}${SUPPLIES[k].name}×${v}`);
    if (loot.gear) list.push(`🎁${loot.gear.name}`);
    if (loot.blueprint) list.push(`📜${loot.blueprint}`);
    g.log(`👑 Boss「${loot.name}」的戰利品：${list.join('、')}`, 'loot');
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
    const lv = 1 + this.game.civilization.levelBonus() + dangerBonus + this.zone().siegeLevel + (phase.danger > 1.5 ? 1 : 0);
    return Math.max(1, Math.min(SIEGE_SCALING.maxZombieLevel ?? Infinity, lv));
  }

  /** 屍潮數量倍率：據點越大越難防守、區域越危險屍潮越多 */
  sizeMul() {
    return (BASE_SIZES[this.base.size]?.siegeMul || 1) * this.zone().siegeMul;
  }

  /** 每波殭屍數：讓整晚的平均強度等同「每 spawnInterval 秒一隻」 */
  waveSize() {
    // 文明度越低每波越少（新手只有一小波）
    const n = (WAVE_SIZE_SECS / this.spawnInterval()) * (1 + Math.min(0.6, this.wave * (SIEGE_SCALING.waveGrowth ?? 0.08))) * this.game.civilization.waveSizeMul();
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

  /**
   * 地圖頁的屍潮狀態：wait（第一波未到）、attack（進攻中）、lull（波次空檔）、done（今夜結束）、broke（防線被突破）；白天為 null
   */
  nightState() {
    if (this.quiet()) return { state: 'broke', wave: this.base?.quietWave || 0 };
    const info = this.waveInfo();
    if (!info.active) return null;
    const left = Math.max(0, info.maxWaves - info.wave);
    if (info.over) return { ...info, state: 'done', leftWaves: 0 };
    if (info.attacking) return { ...info, state: 'attack', leftWaves: left };
    return { ...info, state: info.wave > 0 ? 'lull' : 'wait', leftWaves: left };
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
    // Boss 另乘 bossMul，抵銷文明度加成，維持原本強度
    const bossMul = isBoss ? (SIEGE_SCALING.bossMul ?? 1) : 1;
    const zm = SIEGE_SCALING.zombieMul || { hp: 1, atk: 1 };
    const hpMul = this.game.civilization.siegeHpMul() * bossMul * zm.hp;
    const atkMul = this.game.civilization.siegeAtkMul() * bossMul * zm.atk;
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

  /** 目前在防守的人：防禦駐守的人與在瞭望塔上的人 */
  defenderIds() {
    const tower = (this.base?.defenses || []).map((d) => this.game.shelter.towerGuard(d)?.id).filter(Boolean);
    return [...new Set([...this.guards().map(({ sv }) => sv.id), ...tower])];
  }

  /**
   * 記下今晚參與防守的人（存在據點上，重新整理也不會遺失）：每波來襲時，以及場上有殭屍時每隔幾秒記一次
   * （v10.16：中途才開始駐守的人，只要殭屍還在場上、有參與迎戰就算）
   */
  markDefenders() {
    if (!this.base) return;
    const night = this.base.nightStats?.night ?? this.nightKey();
    const cur = this.base.nightDefenders?.night === night ? this.base.nightDefenders.ids : [];
    const ids = [...new Set([...cur, ...this.defenderIds()])];
    if (ids.length !== cur.length || this.base.nightDefenders?.night !== night) this.base.nightDefenders = { night, ids };
  }

  startWave() {
    this.wave += 1;
    if (this.base) this.base.nightWaves = { night: this.nightKey(), waves: this.wave };
    if (this.base?.nightStats) this.base.nightStats.waves = this.wave;
    this.markDefenders();
    this.waveLeft = this.waveSize();
    this.lull = WAVE_LULL * randFloat(0.8, 1.2);
    this.spawnTimer = 0;
    if (this.game.shelter.isPrimary(this.base)) this.game.log(`🧟 第 ${this.wave}/${this.maxWaves()} 波屍潮來襲「${this.base.name}」（${this.waveLeft} 隻）`, 'danger');
    this.game.bus.emit('siege:wave', { baseId: this.baseId, wave: this.wave, count: this.waveLeft });
  }

  /** dt：秒 */
  update(dt) {
    if (!this.base) return;
    // 背景分頁回來時可能一次補算較長的時間（由 Game 限制上限）
    let remain = Math.max(0, dt);
    while (remain > 0) {
      const step = Math.min(remain, 0.1);
      this.step(step);
      remain -= step;
    }
  }

  step(dt) {
    // 模擬時鐘（秒）：跟著模擬推進，補算背景時間時暈眩等效果也正確
    this.clock = (this.clock || 0) + dt;
    const now = this.clock;
    const sh = this.game.shelter;
    const base = this.base;
    const phase = this.game.time.phase();
    const day = this.game.time.day();

    // 生成（只在夜間）：一波一波來襲，波與波之間有喘息時間
    const active = this.active();
    // 場上有殭屍時，每 3 秒記一次正在防守的人（中途加入駐守也算參與）
    if (active && this.zombies.length && (this.clock || 0) - (this.markAt || 0) >= 3) {
      this.markAt = this.clock || 0;
      this.markDefenders();
    }
    // 入夜與天亮時統計今晚的防守結果
    if (active && !this.wasActive) this.startNight();
    // 天亮（或白天回到遊戲時還有沒結算的夜晚）：結算防守結果
    if (!active && (this.wasActive || base?.nightStats)) this.endNight();
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
          base.wallHp = Math.max(0, sh.wallHp(base) - dmg);
          if (sh.wallHp(base) <= 0) breached = true; // 圍牆被打破：還要打贏據點裡的人員才算攻破
          this.pushFx({ type: 'wallHit', x: z.x, y: z.y, dmg: Math.round(dmg) });
        }
      }
    }

    // 防禦塔
    const dmgMul = sh.towerDamageMul(base) * (SIEGE_SCALING.towerDmgMul ?? 1);
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
        // 近戰防守的人會被貼在牆邊的殭屍反擊受傷（即使圍牆還在）
        if (!atk.ranged && t.hp > 0) {
          const hurt = Math.max(1, t.atk * MELEE_COUNTER * defReduce(stats.def) * (chance(stats.dodge) ? 0 : 1));
          if (hurt > 0) this.game.survivors.damage(sv, hurt, '近戰防守屍潮時受傷');
        }
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

    // 圍牆已破：衝到牆邊的殭屍與據點裡的人員交戰，人員戰敗才算防線被攻破
    this.gateCd = (this.gateCd ?? 0) - dt;
    if (active && sh.wallHp(base) <= 0 && this.gateCd <= 0) {
      const atGate = this.zombies.filter((z) => z.hp > 0 && Math.hypot(z.x, z.y) <= WORLD.WALL_R + 3);
      if (atGate.length) {
        this.gateCd = GATE_FIGHT_EVERY;
        this.gateFight(atGate.slice(0, 8));
      }
    }
    void breached;
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

  /** 駐守人員的傷害倍率（研究加成 × 屍潮駐守倍率；raw：不含屍潮倍率，用於 NPC／玩家攻打） */
  guardMul(raw = false) {
    return (1 + this.game.research.bonus('guardDmgPct')) * (raw ? 1 : (SIEGE_SCALING.guardDmgMul ?? 1));
  }

  fire(d, st, pos, target, inRange, dmgMul) {
    const base = st.damage * dmgMul * this.typeMul(d.type);
    switch (d.type) {
      case 'trap':
        inRange.forEach((z) => this.damage(z, base / st.fireRate));
        this.pushFx({ type: 'trap', x: pos.x, y: pos.y, r: st.range });
        break;
      case 'electricFence': {
        const nowS = this.clock;
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
        const nowS = this.clock;
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
        const sv = this.game.shelter.towerGuard(d);
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
   * 估算用的攻擊力（不消耗彈藥）：有遠程武器與彈藥時用遠程，否則用近戰武器（打得到的機會較少）。
   * @param {boolean} apparent 外人看到的強度：只看得到拿著什麼武器，不知道還有沒有彈藥
   */
  meleeOrRangedAtk(sv, apparent = false) {
    const svs = this.game.survivors;
    if (sv.equipment?.weapon && (apparent || this.canShoot(sv))) return svs.stats(sv, 'ranged').atk;
    return svs.stats(sv, 'melee').atk * 0.5;
  }

  /** 是否能遠程射擊：有遠程武器，且彈藥欄、背包或據點庫存有彈藥 */
  canShoot(sv) {
    const weapon = this.game.equipment.getItem(sv.equipment?.weapon);
    const need = weapon && AMMO_FOR[weapon.type];
    if (!need) return false;
    return this.game.survivors.ammoAvailable(sv, need.ammo) >= ammoPerShot(weapon.type);
  }

  /**
   * 駐守人員一次攻擊的攻擊力：遠程武器每次射擊消耗彈藥（彈藥欄→背包→據點庫存）；
   * 沒有彈藥時改用近戰武器。
   * @returns {{value:number, ranged:boolean}}
   */
  attackPower(sv) {
    const svs = this.game.survivors;
    const weapon = this.game.equipment.getItem(sv.equipment?.weapon);
    const need = weapon && AMMO_FOR[weapon.type];
    if (need && svs.ammoAvailable(sv, need.ammo) >= ammoPerShot(weapon.type)) {
      svs.useAmmo(sv, need.ammo, ammoPerShot(weapon.type));
      const rk = recoverKeyOf(need.ammo);
      this.nightRecover = this.nightRecover || {};
      this.nightRecover[rk] = (this.nightRecover[rk] || 0) + ammoPerShot(weapon.type) * AMMO_RECOVER;
      delete sv.noAmmo;
      return { value: svs.stats(sv, 'ranged').atk, ranged: true };
    }
    if (need && !sv.noAmmo) {
      this.game.log(`🎯 ${sv.name} 沒有${SUPPLIES[need.ammo].name}了，改用近戰武器防守`, 'danger');
      sv.noAmmo = need.ammo;
    }
    return { value: svs.stats(sv, 'melee').atk, ranged: false };
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
      if (!z.boss && chance(z.partsChance * 0.5)) parts += 1;
      this.pushFx({ type: 'death', x: z.x, y: z.y, color: z.color, boss: z.boss });
      if (z.boss) {
        this.game.log(`👑 「${this.base.name}」防線擊殺了 Boss！`, 'success');
        this.bossLoot(z);
      }
    });
    this.game.grant({ coins: Math.round(coins * COIN_GAIN_MUL), parts });
    // 經驗分給防守人員
    const defenders = [
      ...this.guards().map((g) => g.sv),
      ...this.base.defenses.map((d) => this.game.shelter.towerGuard(d)).filter(Boolean),
    ];
    const recipients = defenders.length ? defenders : [this.game.survivors.leader()];
    recipients.forEach((sv) => this.game.survivors.gainXp(sv, (xp * 0.5) / recipients.length));
  }

  /**
   * 圍牆被打破：衝到牆邊的殭屍與據點裡的人員（含友好協防隊）交戰。
   * 人員打贏就擋下這批殭屍；沒有人可以應戰或戰敗才算防線被攻破。
   */
  gateFight(zombies) {
    const g = this.game;
    const base = this.base;
    const defenders = g.npcs.defenders(base);
    const allies = g.shelter.isPrimary(base) ? (g.assist?.allyUnits() || []) : [];
    if (!defenders.length && !allies.length) {
      this.breach('圍牆被打破；據點裡沒有人可以防守');
      return;
    }
    const foes = zombies.map((z) => {
      const e = g.combat.createEnemy(z.enemyId, this.zombieLevel(), false, ZOMBIE_VS_SURVIVOR);
      return { ...e, id: `z${z.id}`, maxHp: Math.max(1, Math.round(z.hp)), atk: z.atk, xp: 0, coins: 0, partsChance: 0 };
    });
    const result = g.combat.simulate(defenders, foes, { allies, ref: this.nightBattles(), merge: `wave${this.wave}`, title: `🧱 「${base.name}」圍牆被破，迎戰屍潮（第 ${this.wave} 波）` });
    // 套用人員傷勢（殭屍的擊殺獎勵由屍潮結算，不重複給）
    defenders.forEach((sv) => {
      const u = result.team.find((x) => x.id === sv.id);
      if (!u) return;
      g.combat.consumeMeds(sv, u);
      if (u.down) g.survivors.battleDown(sv, '在據點內迎戰屍潮', Date.now());
      else g.survivors.setHp(sv, u.hp);
    });
    result.foes.forEach((f) => {
      const z = zombies.find((x) => `z${x.id}` === f.id);
      if (z) z.hp = f.down ? 0 : Math.min(z.hp, f.hp);
    });
    zombies.forEach((z) => { if (z.hp <= 0) this.pushFx({ type: 'shot', kind: 'melee', x1: 0, y1: 0, x2: z.x, y2: z.y }); });
    if (!result.victory) {
      this.breach(`圍牆被打破；防守人員（${[...defenders.map((d) => d.name), ...allies.map((a) => a.name)].join('、')}）戰敗`);
      return;
    }
    if (!this.gateLogged) {
      this.gateLogged = true;
      g.log(`🧱 「${base.name}」圍牆被打破！據點裡的人員正在迎戰衝進來的殭屍`, 'danger');
      g.toast(`🧱 「${base.name}」圍牆被打破，人員正在迎戰！請盡快修繕圍牆`, 'danger');
    }
  }

  breach(note = '防線被突破，圍牆耐久歸零') {
    const sh = this.game.shelter;
    const base = this.base;
    const P = SIEGE_PENALTY;
    // 越早被突破損失越重：撐過的波數比例越高，資源損失越少（55% → 約 26%）
    const progress = clamp((this.wave - 1) / Math.max(1, this.maxWaves()), 0, 1);
    const rate = P.lossMax - P.lossSpan * progress;
    void BREACH_LOSS;
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
    base.quietWave = this.wave;
    this.game.state.stats.breaches += 1;
    const damaged = this.damageBuildings(base, P.defenseBase + P.defenseSpan * (1 - progress));
    const materials = this.loseMaterials();
    const injuries = this.injureGuards();
    const recovered = this.collectRecovered();
    this.breachedTonight = true;
    const entry = sh.recordDefense({
      base, attacker: '屍潮', success: false, lost, damaged, kills: this.nightKills, waves: Math.max(0, this.wave - 1), battleIds: this.takeNightBattles(),
      injured: injuries.filter((x) => x.severe).map((x) => x.name),
      wallLost: Math.max(0, this.nightWallStart || sh.wallMax(base)), note, assists: this.assistList('breached'),
      siege: {
        lossPct: pct, wave: this.wave, maxWaves: this.maxWaves(), materials, injuries, boss: this.nightBoss, recovered,
      },
    });
    const dmgText = damaged.length ? `，${damaged.length} 棟建築損毀` : '';
    damaged.forEach((d) => this.game.log(`🏚️ ${base.name}：${d}`, 'danger'));
    const matList = Object.entries(materials).map(([k, v]) => `${SUPPLIES[k].icon}${SUPPLIES[k].name}−${v}`);
    if (matList.length) this.game.log(`🧰 「${base.name}」的材料被奪走或損壞：${matList.join('、')}`, 'danger');
    injuries.forEach((x) => {
      if (x.cellar) this.game.log(`🕳️ ${x.name}在防線被突破時撤進地窖，沒有受傷`, 'info');
      else if (x.severe || x.light) this.game.log(`🩹 ${x.name}在防線被突破時${x.severe ? '受了重傷，需要醫療站治療' : '受了輕傷'}`, 'danger');
    });
    this.game.toast(`💥 「${base.name}」防線在第 ${this.wave}/${this.maxWaves()} 波被突破！損失 ${pct}% 資源${dmgText}，請強化圍牆與防禦塔`, 'danger');
    this.game.bus.emit('siege:breach', { baseId: base.id, lost, damaged });
    this.game.bus.emit('siege:result', entry);
    this.game.bus.emit('shelter:changed');
  }

  /** 突破時：倉庫裡每種零件、布料各有機率被奪走或損壞一部分 */
  loseMaterials() {
    const P = SIEGE_PENALTY;
    const sup = this.game.state.supplies || {};
    const out = {};
    Object.keys(sup).forEach((k) => {
      const def = SUPPLIES[k];
      // 地窖藏起的部分不會損失
      const open = Math.max(0, (sup[k] || 0) - this.game.shelter.cellarProtect(k));
      if (!def || (def.cat !== 'part' && def.cat !== 'fabric') || !(open > 0) || !chance(P.materialChance)) return;
      const n = Math.min(open, Math.max(1, Math.floor(open * randFloat(P.materialMin, P.materialMax))));
      sup[k] -= n;
      out[k] = n;
    });
    return out;
  }

  /** 突破時：駐守人員有機率輕傷或重傷（已重傷的不重複計算） */
  injureGuards() {
    const P = SIEGE_PENALTY;
    const g = this.game;
    // 地窖：等級最高的幾位駐守者撤進地窖，不會受傷
    const list = this.guards().map(({ sv }) => sv);
    const n = cellarShelter(g.shelter.maxLevel('cellar'));
    const safe = new Set([...list].sort((a, b) => (b.level || 0) - (a.level || 0)).slice(0, n).map((sv) => sv.id));
    return list.map((sv) => {
      if (safe.has(sv.id)) return { name: sv.name, ok: true, cellar: true };
      const r = Math.random();
      if (r < P.severeChance) {
        g.survivors.becomeSevere(sv, '防線被突破時受傷', Date.now());
        return { name: sv.name, severe: true };
      }
      if (r < P.severeChance + P.lightChance) {
        g.survivors.damage(sv, g.survivors.maxHp(sv) * P.lightHpPct, '防線被突破時受傷');
        return { name: sv.name, severe: !!sv.severe, light: !sv.severe };
      }
      return { name: sv.name, ok: true };
    });
  }

  /**
   * 突破後建築損毀：每棟已建造的設施/防禦建築有機率降 1 級，1 級的會被拆除。
   * @returns {string[]} 損毀描述
   */
  /** 防守失敗：有機率讓 1 棟防禦設施降 1 級（1 級的會被拆毀；一般設施不受影響） */
  damageBuildings(base, prob = BREACH_DAMAGE.chance) {
    const out = [];
    const list = base.defenses.filter((d) => d.type && d.level >= 1);
    if (!list.length || !chance(prob)) return out;
    // 降 1 級；原本只有 1 級的才會被拆毀
    const d = pick(list);
    const name = DEFENSES[d.type].name;
    if (d.level <= 1) {
      out.push(`${name}被拆毀`);
      Object.assign(d, { type: null, level: 0, garrisonId: null });
    } else {
      d.level -= 1;
      out.push(`${name}損毀，降為 Lv${d.level}`);
    }
    this.game.civilization.invalidate();
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

  defenseDps({ apparent = false, towersOnly = false, raw = false } = {}) {
    const sh = this.game.shelter;
    const base = this.base;
    if (!base) return 0;
    // raw：NPC／玩家攻打與協防範圍用的原始火力（不含屍潮專用的設施、駐守倍率）
    const mul = sh.towerDamageMul(base) * (raw ? 1 : (SIEGE_SCALING.towerDmgMul ?? 1));
    const gm = this.guardMul(raw);
    let dps = 0;
    base.defenses.forEach((d) => {
      if (!d.type || d.level < 1) return;
      if (DEFENSES[d.type].power && !this.powered()) return;
      const st = DEFENSES[d.type].stats(d.level);
      if (d.type === 'watchPost') {
        const sv = this.game.shelter.towerGuard(d);
        if (sv) dps += this.meleeOrRangedAtk(sv, apparent) * st.garrisonMul * st.fireRate * mul * gm;
      } else {
        dps += st.damage * st.fireRate * mul * this.typeMul(d.type) * (st.aoe ? 1.8 : 1) * (st.chain ? 2 : 1);
      }
    });
    if (!towersOnly) this.guards().forEach(({ sv }) => { dps += this.meleeOrRangedAtk(sv, apparent) * 0.6 * gm; });
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

  /** v15.7 省電：有任何據點正在屍潮中（夜晚來襲或場上還有殭屍）才需要逐幀模擬與繪製 */
  live() {
    return this.game.state.bases.some((b) => { const s = this.of(b.id); return s.zombies.length > 0 || s.active(); });
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
    const coins = Math.round(kills * 2 * COIN_GAIN_MUL); // 與戰鬥金錢一樣套用調降
    const parts = Math.floor(kills / 60);
    this.game.state.stats.kills += kills;
    this.game.state.stats.siegeKills += kills;
    this.game.grant({ coins, parts });
    return { kills, coins, parts };
  }
}
