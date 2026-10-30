import { DEFENSES } from '../config/defenses.js';
import { ENEMIES, BOSSES } from '../config/enemies.js';
import { RESOURCE_KEYS } from '../config/constants.js';
import {
  chance, pick, randFloat, weightedPick, clamp,
} from '../utils/math.js';

export const WORLD = {
  WALL_R: 42,
  SLOT_R: 62,
  SPAWN_R: 150,
};
const MAX_ZOMBIES = 45;
const MAX_FX = 250;
const BREACH_LOSS = 0.08;
const BREACH_GRACE = 90;
/** 殭屍對圍牆的傷害係數（放置遊戲節奏：讓防線有時間反應） */
const WALL_DMG_MUL = 0.3;

/**
 * 避難所防守（屍潮）模擬。純邏輯，以「世界座標」運作（中心 0,0），
 * 由 ShelterScene 每幀呼叫 update(dt) 並讀取 zombies / 消耗 fx 來繪製。
 */
export class SiegeSystem {
  constructor(game) {
    this.game = game;
    this.zombies = [];
    this.fx = [];
    this.spawnTimer = 4;
    this.cooldowns = new Map();
    this.guardCd = 1;
    this.bossDay = 0;
    this.nextId = 1;
  }

  slotPos(slot, total = 8) {
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

  zombieLevel() {
    const phase = this.game.time.phase();
    return Math.max(1, 1 + Math.floor(this.game.time.day() / 2) + (phase.danger > 1.5 ? 1 : 0));
  }

  spawnInterval() {
    const phase = this.game.time.phase();
    const day = Math.min(this.game.time.day(), 40);
    return Math.max(0.6, 9 / (phase.zombieMul * (1 + day * 0.06)));
  }

  pickEnemy() {
    const day = this.game.time.day();
    const phase = this.game.time.phase();
    return weightedPick({
      walker: 10,
      infected: day >= 2 ? 6 : 1,
      berserker: day >= 3 || phase.danger > 1.5 ? 3 : 0,
      mutant: day >= 5 ? 2 : 0,
      nightStalker: phase.special ? 3 : 0,
    });
  }

  spawn(enemyId, isBoss = false) {
    const def = isBoss ? BOSSES[enemyId] : ENEMIES[enemyId];
    const e = this.game.combat.createEnemy(enemyId, this.zombieLevel() + (isBoss ? 3 : 0));
    const a = randFloat(0, Math.PI * 2);
    this.zombies.push({
      id: this.nextId++,
      enemyId,
      boss: isBoss,
      x: Math.cos(a) * WORLD.SPAWN_R,
      y: Math.sin(a) * WORLD.SPAWN_R,
      hp: e.maxHp,
      maxHp: e.maxHp,
      atk: e.atk,
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
    if (isBoss) this.game.toast(`⚠️ Boss「${def.name}」正在接近避難所！`, 'danger');
  }

  /** dt：秒 */
  update(dt) {
    if (!this.game.shelter.hasShelter()) return;
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
    const phase = this.game.time.phase();
    const day = this.game.time.day();

    // 生成
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      this.spawnTimer = this.spawnInterval() * randFloat(0.7, 1.3);
      if (this.zombies.length < MAX_ZOMBIES) this.spawn(this.pickEnemy());
    }
    if (phase.special && day >= 3 && day % 3 === 0 && this.bossDay !== day) {
      this.bossDay = day;
      this.spawn(pick(Object.keys(BOSSES)), true);
    }

    // 減速光環（路障、陷阱）
    const defenses = sh.state.defenses.filter((d) => d.type && d.level > 0);
    const auras = defenses
      .filter((d) => d.type === 'barricade' || d.type === 'trap')
      .map((d) => ({ ...this.slotPos(d.slot), ...DEFENSES[d.type].stats(d.level) }));

    // 移動與攻擊圍牆
    const reduction = sh.wallReduction();
    for (const z of this.zombies) {
      z.t += dt;
      const dist = Math.hypot(z.x, z.y);
      z.slow = 0;
      auras.forEach((a) => {
        if (Math.hypot(z.x - a.x, z.y - a.y) < a.range) z.slow = Math.max(z.slow, a.slow);
      });
      if (now < z.stunUntil) continue;
      if (dist > WORLD.WALL_R + 2) {
        const v = z.speed * (1 - z.slow) * dt;
        z.x -= (z.x / dist) * v;
        z.y -= (z.y / dist) * v;
      } else {
        z.atkCd -= dt;
        if (z.atkCd <= 0) {
          z.atkCd = 1 / z.atkSpeed;
          const dmg = z.atk * WALL_DMG_MUL * (1 - reduction);
          sh.state.wallHp = sh.wallHp() - dmg;
          this.pushFx({ type: 'wallHit', x: z.x, y: z.y, dmg: Math.round(dmg) });
        }
      }
    }

    // 防禦塔
    const dmgMul = sh.towerDamageMul();
    const rangeMul = sh.rangeMul();
    defenses.forEach((d) => {
      const def = DEFENSES[d.type];
      const st = def.stats(d.level);
      if (!st.fireRate) return;
      const key = d.slot;
      const cd = (this.cooldowns.get(key) ?? 0) - dt;
      if (cd > 0) {
        this.cooldowns.set(key, cd);
        return;
      }
      const pos = this.slotPos(d.slot);
      const range = st.range * (d.type === 'trap' ? 1 : rangeMul);
      const inRange = this.zombies.filter((z) => z.hp > 0 && Math.hypot(z.x - pos.x, z.y - pos.y) <= range);
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
      guards.forEach(({ stats }) => {
        const targets = this.zombies.filter((z) => z.hp > 0 && Math.hypot(z.x, z.y) < 80);
        if (!targets.length) return;
        // 集火最靠近圍牆的目標
        const t = targets.reduce((a, b) => (Math.hypot(a.x, a.y) < Math.hypot(b.x, b.y) ? a : b));
        const crit = chance(stats.crit);
        this.damage(t, stats.atk * 0.6 * (crit ? stats.critDmg : 1), crit);
        this.pushFx({ type: 'shot', kind: 'guard', x1: 0, y1: 0, x2: t.x, y2: t.y });
      });
    }

    this.collectDead();

    if (sh.wallHp() <= 0) this.breach();
  }

  guards() {
    const now = Date.now();
    return this.game.state.survivors
      .filter((s) => s.job === 'guard' && s.status === 'idle' && s.injuredUntil <= now && !this.game.survivors.isGarrisoned(s.id))
      .map((s) => ({ sv: s, stats: this.game.survivors.stats(s) }));
  }

  fire(d, st, pos, target, inRange, dmgMul) {
    const base = st.damage * dmgMul;
    switch (d.type) {
      case 'trap':
        inRange.forEach((z) => this.damage(z, base / st.fireRate));
        this.pushFx({ type: 'trap', x: pos.x, y: pos.y, r: st.range });
        break;
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
        const crit = chance(s.crit);
        this.damage(target, s.atk * st.garrisonMul * dmgMul * (crit ? s.critDmg : 1), crit);
        this.pushFx({ type: 'shot', kind: 'sniper', x1: pos.x, y1: pos.y, x2: target.x, y2: target.y });
        break;
      }
      default:
        break;
    }
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
    dead.forEach((z) => {
      st.kills += 1;
      st.siegeKills += 1;
      if (z.boss) st.bossKills += 1;
      coins += Math.ceil(z.coins * 0.5);
      xp += z.xp;
      if (chance(z.partsChance * 0.5)) parts += z.boss ? 5 : 1;
      this.pushFx({ type: 'death', x: z.x, y: z.y, color: z.color, boss: z.boss });
      if (z.boss) this.game.log('👑 避難所防線擊殺了 Boss！', 'success');
    });
    this.game.grant({ coins, parts });
    // 經驗分給防守人員
    const defenders = [
      ...this.guards().map((g) => g.sv),
      ...this.game.state.shelter.defenses.map((d) => this.game.survivors.get(d.garrisonId)).filter(Boolean),
    ];
    const recipients = defenders.length ? defenders : [this.game.survivors.leader()];
    recipients.forEach((sv) => this.game.survivors.gainXp(sv, (xp * 0.5) / recipients.length));
  }

  breach() {
    const sh = this.game.shelter;
    const res = this.game.state.resources;
    const lost = {};
    RESOURCE_KEYS.forEach((k) => {
      lost[k] = Math.floor(res[k] * BREACH_LOSS);
      res[k] -= lost[k];
    });
    this.zombies.forEach((z) => this.pushFx({ type: 'death', x: z.x, y: z.y, color: z.color }));
    this.zombies = [];
    sh.state.wallHp = sh.wallMax() * 0.3;
    this.spawnTimer = BREACH_GRACE;
    this.game.state.stats.breaches += 1;
    this.game.log('💥 避難所防線被突破！損失 8% 資源', 'danger');
    this.game.toast('💥 防線被突破！損失 8% 資源，請強化圍牆與防禦塔', 'danger');
    this.game.bus.emit('siege:breach', lost);
  }

  /** 防禦總 DPS（離線估算與 UI 顯示） */
  defenseDps() {
    const sh = this.game.shelter;
    const mul = sh.towerDamageMul();
    let dps = 0;
    sh.state.defenses.forEach((d) => {
      if (!d.type || d.level < 1) return;
      const st = DEFENSES[d.type].stats(d.level);
      if (d.type === 'watchPost') {
        const sv = this.game.survivors.get(d.garrisonId);
        if (sv) dps += this.game.survivors.stats(sv).atk * st.garrisonMul * st.fireRate * mul;
      } else {
        dps += st.damage * st.fireRate * mul * (st.aoe ? 1.8 : 1) * (st.chain ? 2 : 1);
      }
    });
    this.guards().forEach(({ stats }) => { dps += stats.atk * 0.6; });
    return Math.round(dps);
  }

  /**
   * 離線防守收益（需研究解鎖）：以防禦 DPS 估算可擊殺數量。
   */
  simulateOffline(ms) {
    if (!this.game.research.hasUnlock('offlineDefense')) return null;
    const seconds = ms / 1000;
    const avgInterval = 9 / (1.4 * (1 + Math.min(this.game.time.day(), 40) * 0.06));
    const spawns = seconds / avgInterval;
    const avgHp = this.game.combat.createEnemy('infected', this.zombieLevel()).maxHp;
    const capacity = (this.defenseDps() * seconds * 0.25) / avgHp;
    const kills = Math.floor(clamp(Math.min(spawns, capacity), 0, 5000));
    if (!kills) return { kills: 0, coins: 0 };
    const coins = kills * 2;
    this.game.state.stats.kills += kills;
    this.game.state.stats.siegeKills += kills;
    this.game.grant({ coins, parts: Math.floor(kills / 60) });
    return { kills, coins, parts: Math.floor(kills / 60) };
  }
}
