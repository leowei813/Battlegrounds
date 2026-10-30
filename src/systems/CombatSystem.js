import { ALL_ENEMIES, ELITE_MUL } from '../config/enemies.js';
import { chance, randFloat, pick, uid } from '../utils/math.js';

const STEP = 0.1; // 秒
const MAX_TIME = 90;

/**
 * 自動戰鬥系統（純邏輯、可測試）。
 * 以固定時間步模擬雙方依攻速輪流攻擊，回傳結果與戰鬥紀錄。
 */
export class CombatSystem {
  constructor(game) {
    this.game = game;
  }

  /** 建立敵人實例 */
  createEnemy(enemyId, level = 1, elite = false) {
    const def = ALL_ENEMIES[enemyId];
    const l = Math.max(1, level) - 1;
    const e = {
      id: uid('en'),
      enemyId,
      name: `${elite ? '精英' : ''}${def.name}`,
      icon: def.icon,
      level: level,
      boss: !!def.boss,
      elite,
      maxHp: Math.round(def.hp * (1 + 0.2 * l)),
      atk: Math.round(def.atk * (1 + 0.13 * l)),
      def: Math.round(def.def * (1 + 0.11 * l)),
      crit: def.crit,
      critDmg: 1.5,
      dodge: def.dodge,
      atkSpeed: def.atkSpeed,
      xp: Math.round(def.xp * (1 + 0.25 * l)),
      coins: Math.round(def.coins * (1 + 0.2 * l)),
      partsChance: def.partsChance,
    };
    if (elite) {
      e.maxHp = Math.round(e.maxHp * ELITE_MUL.hp);
      e.atk = Math.round(e.atk * ELITE_MUL.atk);
      e.def = Math.round(e.def * ELITE_MUL.def);
      e.xp *= ELITE_MUL.xp;
      e.coins *= ELITE_MUL.coins;
    }
    return e;
  }

  /** 把倖存者轉成戰鬥單位 */
  unitFromSurvivor(sv) {
    const s = this.game.survivors.stats(sv);
    return {
      id: sv.id, name: sv.name, side: 'team', classId: sv.classId,
      // 以目前生命出戰（受過傷的隊員不會回滿血）
      maxHp: s.hp, hp: this.game.survivors.hpOf(sv), atk: s.atk, def: s.def, crit: s.crit, critDmg: s.critDmg,
      dodge: s.dodge, atkSpeed: s.atkSpeed, skills: s.skills, lifeSteal: Math.min(0.5, s.lifeSteal || 0),
      cd: randFloat(0, 0.3), healCd: s.skills.healEvery || 0, firstHit: true,
    };
  }

  /**
   * @param {object[]} survivors 倖存者資料
   * @param {object[]} enemies   createEnemy 產生的敵人
   * @param {{firstStrikeBonus?:number}} opts
   */
  simulate(survivors, enemies, opts = {}) {
    const team = survivors.map((sv) => this.unitFromSurvivor(sv));
    const foes = enemies.map((e) => ({ ...e, side: 'enemy', hp: e.maxHp, cd: randFloat(0.3, 1), skills: {} }));
    const log = [];
    const push = (t, msg, type = '') => { if (log.length < 140) log.push({ t: +t.toFixed(1), msg, type }); };

    // 先手：監視塔加成讓隊伍首輪攻擊提前
    if (chance(opts.firstStrikeBonus || 0)) {
      team.forEach((u) => { u.cd = 0; });
      push(0, '🗡️ 偵查成功，隊伍取得先手！', 'info');
    }

    let t = 0;
    const alive = (arr) => arr.filter((u) => u.hp > 0);
    const kills = [];

    const attack = (atkUnit, targets) => {
      const target = atkUnit.side === 'enemy'
        ? pick(targets)
        : targets.reduce((a, b) => (a.hp < b.hp ? a : b)); // 隊伍集火殘血
      if (chance(target.dodge)) {
        push(t, `${atkUnit.name} 的攻擊被 ${target.name} 閃避`, 'miss');
        return;
      }
      let atk = atkUnit.atk;
      if (atkUnit.skills.rage && atkUnit.hp / atkUnit.maxHp < 0.3) atk *= 1 + atkUnit.skills.rage;
      const crit = (atkUnit.firstHit && atkUnit.skills.firstStrikeCrit) || chance(atkUnit.crit);
      atkUnit.firstHit = false;
      const raw = atk * randFloat(0.9, 1.1) * (crit ? atkUnit.critDmg : 1);
      const dmg = Math.max(1, Math.round(raw * (100 / (100 + target.def * 2))));
      target.hp -= dmg;
      push(t, `${atkUnit.name} ${crit ? '💥暴擊' : '攻擊'} ${target.name} -${dmg}`, atkUnit.side === 'team' ? (crit ? 'crit' : 'hit') : 'hurt');
      if (atkUnit.lifeSteal) {
        const heal = Math.round(dmg * atkUnit.lifeSteal);
        if (heal > 0) atkUnit.hp = Math.min(atkUnit.maxHp, atkUnit.hp + heal);
      }
      if (target.hp <= 0) {
        push(t, `☠️ ${target.name} 倒下`, target.side === 'enemy' ? 'kill' : 'down');
        if (target.side === 'enemy') kills.push(target);
      }
      // 戰士橫掃
      if (atkUnit.skills.cleaveChance && chance(atkUnit.skills.cleaveChance)) {
        const others = alive(targets).filter((x) => x !== target);
        if (others.length) {
          const o = pick(others);
          const cdmg = Math.max(1, Math.round(dmg * 0.6));
          o.hp -= cdmg;
          push(t, `${atkUnit.name} 橫掃波及 ${o.name} -${cdmg}`, 'hit');
          if (o.hp <= 0) {
            push(t, `☠️ ${o.name} 倒下`, 'kill');
            kills.push(o);
          }
        }
      }
    };

    while (t < MAX_TIME && alive(team).length && alive(foes).length) {
      t += STEP;
      for (const u of [...team, ...foes]) {
        if (u.hp <= 0) continue;
        const opponents = alive(u.side === 'team' ? foes : team);
        if (!opponents.length) break;
        // 醫生治療
        if (u.skills.healEvery) {
          u.healCd -= STEP;
          if (u.healCd <= 0) {
            u.healCd = u.skills.healEvery;
            const hurt = alive(team).reduce((a, b) => (a.hp / a.maxHp < b.hp / b.maxHp ? a : b));
            if (hurt.hp < hurt.maxHp) {
              const amt = Math.round(hurt.maxHp * u.skills.healPct + u.atk * 0.5);
              hurt.hp = Math.min(hurt.maxHp, hurt.hp + amt);
              push(t, `⚕️ ${u.name} 治療 ${hurt.name} +${amt}`, 'heal');
            }
          }
        }
        u.cd -= STEP;
        if (u.cd <= 0) {
          u.cd += 1 / u.atkSpeed;
          attack(u, opponents);
        }
      }
    }

    const victory = alive(foes).length === 0 && alive(team).length > 0;
    push(t, victory ? '🏆 戰鬥勝利！' : '💀 戰鬥失敗，隊伍撤退…', victory ? 'win' : 'lose');

    return {
      victory,
      duration: +t.toFixed(1),
      log,
      kills,
      team: team.map((u) => ({ id: u.id, name: u.name, hp: Math.max(0, Math.round(u.hp)), maxHp: u.maxHp, down: u.hp <= 0 })),
      enemies: foes.map((f) => ({ name: f.name, icon: f.icon, hp: Math.max(0, Math.round(f.hp)), maxHp: f.maxHp })),
      xp: kills.reduce((s, k) => s + k.xp, 0),
      coins: kills.reduce((s, k) => s + k.coins, 0),
      parts: kills.reduce((s, k) => s + (chance(k.partsChance) ? (k.boss ? 3 : 1) : 0), 0),
      bossKills: kills.filter((k) => k.boss).length,
      eliteKills: kills.filter((k) => k.elite).length,
    };
  }

  /**
   * 結算戰鬥對倖存者的影響：經驗、剩餘生命、重傷、統計。
   * 生命歸零的隊員重傷並扣除經驗（可能降級），且不獲得本場經驗。
   * 由探索與地圖戰鬥共用。
   */
  applyOutcome(survivors, result, at = Date.now()) {
    const st = this.game.state.stats;
    st.kills += result.kills.length;
    st.bossKills += result.bossKills;
    st.eliteKills += result.eliteKills;
    const xpEach = Math.round(result.xp / Math.max(1, survivors.length)) + (result.victory ? 5 : 0);
    survivors.forEach((sv) => {
      const u = result.team.find((x) => x.id === sv.id);
      if (u?.down) {
        this.game.survivors.becomeSevere(sv, '在戰鬥中', at);
        return;
      }
      this.game.survivors.gainXp(sv, xpEach);
      if (u) this.game.survivors.setHp(sv, u.hp);
    });
    this.game.grant({ coins: result.coins, parts: result.parts });
  }
}
