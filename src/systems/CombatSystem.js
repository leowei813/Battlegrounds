import { COIN_GAIN_MUL } from '../config/constants.js';
import { ITEM_MODELS } from '../config/equipment.js';
import { SUPPLIES } from '../config/supplies.js';
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
  /**
   * 攻城：攻擊者先破壞圍牆，期間防禦設施持續射擊（集中火力擊倒一個再換下一個）。
   * 圍牆被打破後才能和據點裡的人員交戰；撐過 maxSec 秒或攻擊者全滅就算守住。
   * @param {object[]} enemies 攻擊者（maxHp、atk）
   * @returns {{alive:object[], killed:number, breached:boolean, wallLeft:number, wallLost:number, sec:number}}
   */
  wallAssault(enemies, wallHp, towerDps, { maxSec = 120, wallMul = 0.8 } = {}) {
    const alive = enemies.map((e) => ({ e, hp: e.maxHp }));
    let wall = Math.max(0, wallHp);
    let sec = 0;
    while (alive.length && wall > 0 && sec < maxSec) {
      sec += 1;
      wall -= alive.reduce((s, a) => s + a.e.atk * wallMul, 0);
      let shot = towerDps;
      while (shot > 0 && alive.length) {
        const t = alive[0];
        const d = Math.min(shot, t.hp);
        t.hp -= d;
        shot -= d;
        if (t.hp <= 0) alive.shift();
      }
    }
    wall = Math.max(0, wall);
    return {
      alive: alive.map((a) => Object.assign(a.e, { hp: Math.max(1, Math.round(a.hp)) })),
      killed: enemies.length - alive.length,
      breached: wall <= 0 && alive.length > 0,
      wallLeft: wall,
      wallLost: Math.max(0, wallHp - wall),
      sec,
    };
  }

  /** @param {{hp?:number, atk?:number}} [mul] 額外強度倍率（夜晚、地圖殭屍群等） */
  createEnemy(enemyId, level = 1, elite = false, mul = null) {
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
    if (mul) {
      e.maxHp = Math.round(e.maxHp * (mul.hp || 1));
      e.atk = Math.round(e.atk * (mul.atk || 1));
    }
    return e;
  }

  /** 把倖存者轉成戰鬥單位 */
  /** 需要燃料的武器（電鋸，近戰）：每場戰鬥耗油，燃料不足時只剩 30% 攻擊 */
  weaponFuelMul(sv, mode) {
    const weapon = this.game.equipment.getItem(sv.equipment?.[mode === 'ranged' ? 'weapon' : 'melee']);
    const fuel = ITEM_MODELS[weapon?.model]?.fuel;
    if (!fuel) return 1;
    const res = this.game.state.resources;
    if (res.fuel < fuel) return 0.3;
    res.fuel -= fuel;
    return 1;
  }

  /**
   * 決定這場戰鬥用哪把武器：遠程武器有足夠彈藥（彈藥欄→背包→在家時的倉庫）就用遠程並消耗彈藥，
   * 否則自動改用近戰武器。
   * @returns {'ranged'|'melee'}
   */
  pickWeapon(sv) {
    const svs = this.game.survivors;
    const need = svs.ammoNeed(sv);
    if (need && svs.ammoAvailable(sv, need.ammo) >= need.perFight) {
      svs.useAmmo(sv, need.ammo, need.perFight);
      delete sv.noAmmo;
      return 'ranged';
    }
    if (need) sv.noAmmo = need.ammo;
    return 'melee';
  }

  unitFromSurvivor(sv) {
    const mode = this.pickWeapon(sv);
    const s = this.game.survivors.stats(sv, mode);
    const lo = this.game.survivors.loadout(sv);
    return {
      id: sv.id, name: sv.name, side: 'team', classId: sv.classId, weapon: mode,
      // 以目前生命出戰（受過傷的隊員不會回滿血）
      maxHp: s.hp, hp: this.game.survivors.hpOf(sv), atk: s.atk * this.weaponFuelMul(sv, mode), def: s.def, crit: s.crit, critDmg: s.critDmg,
      // 藥品欄：生命低於 35% 時自動使用
      meds: lo.med ? { key: lo.med.key, qty: lo.med.qty, heal: Math.round(this.game.survivors.healAmount(sv, lo.med.key)) } : null,
      medsUsed: 0,
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
    // allies：友好玩家的協防隊員（不是自己的倖存者，戰後由對方自行套用傷勢）
    const team = [...survivors.map((sv) => this.unitFromSurvivor(sv)), ...(opts.allies || []).map((a) => ({
      ...a, side: 'team', skills: {}, cd: randFloat(0, 0.3), healCd: 0, firstHit: true, lifeSteal: 0,
    }))];
    const foes = enemies.map((e) => ({ ...e, side: 'enemy', hp: e.maxHp, cd: randFloat(0.3, 1), skills: {} }));
    const log = [];
    const push = (t, msg, type = '') => { if (log.length < 400) log.push({ t: +t.toFixed(1), msg, type }); };

    // 先手：探照燈加成讓隊伍首輪攻擊提前
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
      // 傷害統計
      atkUnit.dealt = (atkUnit.dealt || 0) + dmg;
      target.taken = (target.taken || 0) + dmg;
      if (crit) atkUnit.crits = (atkUnit.crits || 0) + 1;
      atkUnit.hits = (atkUnit.hits || 0) + 1;
      push(t, `${atkUnit.name} ${crit ? '💥暴擊' : '攻擊'} ${target.name} -${dmg}`, atkUnit.side === 'team' ? (crit ? 'crit' : 'hit') : 'hurt');
      if (atkUnit.lifeSteal) {
        const heal = Math.round(dmg * atkUnit.lifeSteal);
        if (heal > 0) atkUnit.hp = Math.min(atkUnit.maxHp, atkUnit.hp + heal);
      }
      if (target.hp <= 0) {
        push(t, `☠️ ${target.name} 倒下`, target.side === 'enemy' ? 'kill' : 'down');
        if (target.side === 'enemy') kills.push(target);
        atkUnit.kills = (atkUnit.kills || 0) + 1;
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
        // 生命低於 35% 時自動使用藥品欄的藥
        if (u.meds && u.meds.qty > 0 && u.hp < u.maxHp * 0.35) {
          u.meds.qty -= 1;
          u.medsUsed += 1;
          u.hp = Math.min(u.maxHp, u.hp + u.meds.heal);
          push(t, `💊 ${u.name} 使用 ${SUPPLIES[u.meds.key]?.name || '藥品'} +${u.meds.heal}`, 'heal');
        }
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
    // 記錄這場戰鬥的詳細資料（逐筆傷害、暴擊與每人傷害統計），在「消息 → 戰鬥紀錄」查看
    if (opts.record !== false && survivors.length) this.record(opts.title, victory, t, log, team, foes);

    return {
      victory,
      duration: +t.toFixed(1),
      log,
      kills,
      team: team.map((u) => ({
        id: u.id, name: u.name, hp: Math.max(0, Math.round(u.hp)), maxHp: u.maxHp, down: u.hp <= 0, kills: u.kills || 0, ally: u.ally, medsUsed: u.medsUsed || 0, weapon: u.weapon,
      })),
      foes: foes.map((u) => ({ id: u.id, ally: u.ally, down: u.hp <= 0, hp: Math.max(0, Math.round(u.hp)), kills: u.kills || 0 })),
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
  /** 保存最近的戰鬥詳細（最多 10 場，每場最多 120 筆紀錄） */
  record(title, victory, duration, log, team, foes) {
    const st = this.game.state;
    const unit = (u) => ({
      name: u.name, side: u.side, dealt: Math.round(u.dealt || 0), taken: Math.round(u.taken || 0), crits: u.crits || 0, hits: u.hits || 0,
      kills: u.kills || 0, down: u.hp <= 0, weapon: u.weapon || '', meds: u.medsUsed || 0,
    });
    const entry = {
      id: uid('bt'), at: Date.now(), title: String(title || '戰鬥').slice(0, 40), victory, duration: +duration.toFixed(1),
      team: team.map(unit), foes: foes.map(unit),
      log: (log.length > 120 ? [...log.slice(0, 100), { t: -1, msg: `…（中間省略 ${log.length - 120} 筆）`, type: 'info' }, ...log.slice(-20)] : log),
    };
    st.battles = [entry, ...(st.battles || [])].slice(0, 10);
    this.lastBattleId = entry.id;
  }

  /** 扣掉戰鬥中用掉的藥品欄藥品 */
  consumeMeds(sv, u) {
    if (!u?.medsUsed) return;
    const lo = this.game.survivors.loadout(sv);
    if (!lo.med) return;
    lo.med.qty -= u.medsUsed;
    if (lo.med.qty <= 0) lo.med = null;
  }

  applyOutcome(survivors, result, at = Date.now()) {
    const st = this.game.state.stats;
    st.kills += result.kills.length;
    st.bossKills += result.bossKills;
    st.eliteKills += result.eliteKills;
    const xpEach = Math.round(result.xp / Math.max(1, survivors.length)) + (result.victory ? 5 : 0);
    survivors.forEach((sv) => {
      const u = result.team.find((x) => x.id === sv.id);
      this.consumeMeds(sv, u);
      if (u?.down) {
        this.game.survivors.becomeSevere(sv, '在戰鬥中', at);
        return;
      }
      this.game.survivors.gainXp(sv, xpEach);
      if (u) this.game.survivors.setHp(sv, u.hp);
    });
    this.game.grant({ coins: Math.round(result.coins * COIN_GAIN_MUL), parts: result.parts });
  }
}
