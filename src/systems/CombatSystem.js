import { COIN_GAIN_MUL } from '../config/constants.js';
import { ITEM_MODELS } from '../config/equipment.js';
import { SUPPLIES, AMMO_RECOVER, recoverKeyOf, rollRecover } from '../config/supplies.js';
import { ALL_ENEMIES, ELITE_MUL, defReduce, HOME_DEFENSE_DOWN } from '../config/enemies.js';
import { chance, randFloat, pick, uid } from '../utils/math.js';
import { xpToNext } from '../config/survivors.js';

const STEP = 0.1; // 秒
const MAX_TIME = 90;

/**
 * 自動戰鬥系統（純邏輯、可測試）。
 * 以固定時間步模擬雙方依攻速輪流攻擊，回傳結果與戰鬥紀錄。
 */
/** 戰鬥明細最多保留幾場；最新幾場保留逐筆過程；每份報告最多掛幾場 */
const BATTLE_KEEP = 60;
const BATTLE_FULL_LOG = 25;
const BATTLES_PER_REF = 20;

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
      ranged: !!def.ranged,
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
      if (this.fightUse) {
        const rk = recoverKeyOf(need.ammo);
        this.fightUse[rk] = (this.fightUse[rk] || 0) + need.perFight * AMMO_RECOVER;
      }
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
    // 記下這場用掉的彈藥：勝利後回收部分彈殼與箭矢
    this.fightUse = {};
    this.pendingBattle = null;
    // allies：友好玩家的協防隊員（不是自己的倖存者，戰後由對方自行套用傷勢）
    const team = [...survivors.map((sv) => this.unitFromSurvivor(sv)), ...(opts.allies || []).map((a) => ({
      ...a, side: 'team', skills: a.skills || {}, cd: randFloat(0, 0.3), healCd: a.skills?.healEvery || 0, firstHit: true, lifeSteal: a.lifeSteal || 0, medsUsed: 0,
    }))];
    const foes = enemies.map((e) => ({ ...e, side: 'enemy', hp: e.maxHp, cd: randFloat(0.3, 1), skills: {} }));
    // 戰前生命（戰鬥紀錄顯示戰前→戰後）
    [...team, ...foes].forEach((u) => { u.hpStart = u.hp; });
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
      const dmg = Math.max(1, Math.round(raw * defReduce(target.def)));
      target.hp -= dmg;
      // 傷害統計
      atkUnit.dealt = (atkUnit.dealt || 0) + dmg;
      target.taken = (target.taken || 0) + dmg;
      if (crit) atkUnit.crits = (atkUnit.crits || 0) + 1;
      atkUnit.hits = (atkUnit.hits || 0) + 1;
      push(t, `${atkUnit.name} ${crit ? '💥暴擊' : '攻擊'} ${target.name} -${dmg}`, atkUnit.side === 'team' ? (crit ? 'crit' : 'hit') : 'hurt');
      if (atkUnit.lifeSteal) {
        const heal = Math.round(dmg * atkUnit.lifeSteal);
        if (heal > 0) {
          const before = atkUnit.hp;
          atkUnit.hp = Math.min(atkUnit.maxHp, atkUnit.hp + heal);
          atkUnit.healed = (atkUnit.healed || 0) + Math.max(0, atkUnit.hp - before);
        }
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

    // 時間上限：一般 90 秒；副本首領戰可指定較長的時間（opts.maxTime）
    const maxT = opts.maxTime || MAX_TIME;
    while (t < maxT && alive(team).length && alive(foes).length) {
      t += STEP;
      for (const u of [...team, ...foes]) {
        if (u.hp <= 0) continue;
        const opponents = alive(u.side === 'team' ? foes : team);
        if (!opponents.length) break;
        // 生命低於 35% 時自動使用藥品欄的藥
        if (u.meds && u.meds.qty > 0 && u.hp < u.maxHp * 0.35) {
          u.meds.qty -= 1;
          u.medsUsed += 1;
          const before = u.hp;
          u.hp = Math.min(u.maxHp, u.hp + u.meds.heal);
          u.healed = (u.healed || 0) + Math.max(0, u.hp - before);
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
              const before = hurt.hp;
              hurt.hp = Math.min(hurt.maxHp, hurt.hp + amt);
              hurt.healed = (hurt.healed || 0) + Math.max(0, hurt.hp - before);
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
    const recovered = victory ? rollRecover(this.fightUse) : {};
    this.fightUse = null;
    // 回收物：探索搜刮時放進隊伍的收穫（一起帶回家），其他戰鬥直接放回物品倉庫
    if (opts.recoverTo) Object.entries(recovered).forEach(([k, v]) => { opts.recoverTo[k] = (opts.recoverTo[k] || 0) + v; });
    else if (Object.keys(recovered).length) this.game.equipment?.addSupplies(recovered);
    push(t, victory ? '🏆 戰鬥勝利！' : '💀 戰鬥失敗，隊伍撤退…', victory ? 'win' : 'lose');
    // 記錄這場戰鬥的詳細資料（逐筆傷害、暴擊與每人傷害統計），在「消息 → 戰鬥紀錄」查看
    if (opts.record !== false && survivors.length) this.record(opts.title, victory, t, log, team, foes, opts.ref || this.scope, opts.merge || null);
    // 集結：戰鬥詳細不存進自己的紀錄，而是放進結果分給每位參加的玩家
    const entry = opts.capture ? this.entry(opts.title, victory, t, log, team, foes, opts.capture) : null;

    return {
      victory,
      recovered,
      ...(entry ? { entry } : {}),
      duration: +t.toFixed(1),
      log,
      kills,
      team: team.map((u) => ({
        id: u.id, name: u.name, hp: Math.max(0, Math.round(u.hp)), maxHp: u.maxHp, down: u.hp <= 0, kills: u.kills || 0, ally: u.ally, medsUsed: u.medsUsed || 0, weapon: u.weapon, dealt: Math.round(u.dealt || 0),
        taken: Math.round(u.taken || 0), healed: Math.round(u.healed || 0),
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
  /**
   * 守城期間防守人員的傷勢：近戰防守的人一定會被攻擊者打到；
   * 攻擊方有遠程武器時，使用遠程武器的防守人員也有機率中彈。
   * @param {object[]} defenders 倖存者
   * @param {object[]} attackers 攻擊者（含 atk、ranged）
   * @param {number} sec 攻城秒數
   * @returns {string[]} 受傷的人
   */
  wallDefenseHurt(defenders, attackers, sec, reason = '守城時受傷') {
    const svs = this.game.survivors;
    if (!attackers.length || !sec) return [];
    const avgAtk = attackers.reduce((s, a) => s + (a.atk || 0), 0) / attackers.length;
    const ranged = attackers.some((a) => a.ranged);
    const hurt = [];
    defenders.forEach((sv) => {
      const st = svs.stats(sv);
      const usesRanged = st.weaponMode === 'ranged';
      if (usesRanged && (!ranged || !chance(0.35))) return;
      const hits = usesRanged ? 1 + Math.floor(sec / 30) : Math.max(1, Math.round(sec / 8));
      const dmg = hits * avgAtk * (usesRanged ? 0.6 : 0.5) * defReduce(st.def);
      if (dmg <= 0) return;
      svs.damage(sv, dmg, reason);
      hurt.push(sv.name);
    });
    return hurt;
  }

  /**
   * 在 fn 執行期間發生的戰鬥都歸到 target（探索隊、防守紀錄等）的 battleIds，
   * 讓戰鬥明細顯示在該次探索報告或避難所紀錄裡。
   */
  within(target, fn) {
    const prev = this.scope;
    this.scope = target;
    try { return fn(); } finally { this.scope = prev; }
  }

  /**
   * 只保留還有報告、避難所紀錄或事件紀錄引用的戰鬥（最多 BATTLE_KEEP 場）；
   * 較舊的只留統計、不留逐筆過程，避免存檔過大。
   */
  pruneBattles(keep = []) {
    const st = this.game.state;
    const used = new Set(keep);
    const add = (ids) => (ids || []).forEach((id) => used.add(id));
    (st.reports || []).forEach((r) => add(r.battleIds));
    (st.defenseLog || []).forEach((e) => add(e.battleIds));
    (st.expeditions || []).forEach((e) => add(e.battleIds));
    (st.log || []).forEach((l) => l.battleId && used.add(l.battleId));
    (st.bases || []).forEach((b) => add(b.nightBattles?.battleIds));
    if (this.pendingBattle) used.add(this.pendingBattle);
    st.battles = (st.battles || []).filter((b) => used.has(b.id)).slice(0, BATTLE_KEEP);
    st.battles.forEach((b, i) => { if (i >= BATTLE_FULL_LOG && b.log?.length) b.log = []; });
  }

  /** 把同一波的新交戰併入既有的戰鬥紀錄：每人數據累加、生命取最新、過程接在後面 */
  mergeBattle(prev, entry) {
    const SUM = ['dealt', 'taken', 'crits', 'hits', 'kills', 'healed', 'meds'];
    const mergeUnits = (a, b) => {
      b.forEach((u) => {
        const o = a.find((x) => x.name === u.name);
        if (!o) { a.push({ ...u }); return; }
        SUM.forEach((k) => { o[k] = (o[k] || 0) + (u[k] || 0); });
        o.hpEnd = u.hpEnd;
        o.down = u.down;
        if (u.maxHp) o.maxHp = u.maxHp;
      });
    };
    mergeUnits(prev.team, entry.team);
    prev.foes = [...prev.foes, ...entry.foes].slice(-60);
    prev.fights = (prev.fights || 1) + 1;
    prev.duration = +(prev.duration + entry.duration).toFixed(1);
    prev.victory = entry.victory;
    prev.at = entry.at;
    const sep = { t: -1, msg: `── 第 ${prev.fights} 次交戰 ──`, type: 'info' };
    prev.log = [...(prev.log || []), sep, ...entry.log].slice(-120);
  }

  /** 依 id 取出戰鬥紀錄 */
  battle(id) {
    return (this.game.state.battles || []).find((b) => b.id === id) || null;
  }

  /** 保存戰鬥詳細（每場最多 120 筆紀錄）；ref 是這場戰鬥所屬的探索隊或防守紀錄 */
  /** 戰鬥詳細的資料（maxLog：最多保留幾筆紀錄） */
  entry(title, victory, duration, log, team, foes, maxLog = 120) {
    const unit = (u) => ({
      name: u.name, side: u.side, dealt: Math.round(u.dealt || 0), taken: Math.round(u.taken || 0), crits: u.crits || 0, hits: u.hits || 0,
      kills: u.kills || 0, down: u.hp <= 0, weapon: u.weapon || '', meds: u.medsUsed || 0,
      healed: Math.round(u.healed || 0), hpStart: Math.round(u.hpStart ?? 0), hpEnd: Math.max(0, Math.round(u.hp)), maxHp: Math.round(u.maxHp || 0),
    });
    const entry = {
      id: uid('bt'), at: Date.now(), title: String(title || '戰鬥').slice(0, 40), victory, duration: +duration.toFixed(1),
      team: team.map(unit), foes: foes.map(unit),
      log: (log.length > maxLog ? [...log.slice(0, maxLog - 20), { t: -1, msg: `…（中間省略 ${log.length - maxLog} 筆）`, type: 'info' }, ...log.slice(-20)] : log),
    };
    return entry;
  }

  /** 把別處產生的戰鬥詳細（例如集結）加進自己的戰鬥紀錄，記在 ref 底下 */
  adopt(entry, ref) {
    if (!entry || !ref) return null;
    const st = this.game.state;
    const e = { ...entry, id: uid('bt') };
    st.battles = [e, ...(st.battles || [])];
    ref.battleIds = [...(ref.battleIds || []), e.id].slice(-BATTLES_PER_REF);
    this.pruneBattles(ref.battleIds);
    return e.id;
  }

  record(title, victory, duration, log, team, foes, ref = null, merge = null) {
    const st = this.game.state;
    const entry = this.entry(title, victory, duration, log, team, foes);
    // 同一波屍潮在圍牆缺口的多次交戰：合併成同一場（避免一晚出現幾十場）
    const prevId = merge && ref?.battleIds?.length ? ref.battleIds[ref.battleIds.length - 1] : null;
    const prev = prevId ? this.battle(prevId) : null;
    if (prev && prev.merge === merge) {
      this.mergeBattle(prev, entry);
      this.lastBattleId = prev.id;
      return;
    }
    if (merge) entry.merge = merge;
    st.battles = [entry, ...(st.battles || [])];
    this.lastBattleId = entry.id;
    // 歸屬：有所屬的探索或防守就記在那裡；沒有的話附在下一筆事件紀錄上
    if (ref) ref.battleIds = [...(ref.battleIds || []), entry.id].slice(-BATTLES_PER_REF);
    else this.pendingBattle = entry.id;
    this.pruneBattles(ref?.battleIds || []);
  }

  /** 扣掉戰鬥中用掉的藥品欄藥品 */
  consumeMeds(sv, u) {
    if (!u?.medsUsed) return;
    const lo = this.game.survivors.loadout(sv);
    if (!lo.med) return;
    lo.med.qty -= u.medsUsed;
    if (lo.med.qty <= 0) lo.med = null;
  }

  /**
   * @param {object} [opts]
   * @param {boolean} [opts.homeDefense] 據點防守戰：倒下的人只有部分重傷，其餘以低生命撐住
   */
  /**
   * @param {object} [opts]
   * @param {boolean} [opts.homeDefense]
   * @param {{winPct:number, downPct:number}} [opts.attackXp] v15.8：攻打控制點／NPC 據點：打贏時沒倒下的人另得升級所需經驗的 winPct，倒下只扣 downPct
   */
  applyOutcome(survivors, result, at = Date.now(), { homeDefense = false, attackXp = null } = {}) {
    const st = this.game.state.stats;
    st.kills += result.kills.length;
    st.bossKills += result.bossKills;
    st.eliteKills += result.eliteKills;
    const xpEach = Math.round(result.xp / Math.max(1, survivors.length)) + (result.victory ? 5 : 0);
    result.xpEach = Math.round(xpEach * (1 + this.game.research.bonus('xpPct')));
    survivors.forEach((sv) => {
      const u = result.team.find((x) => x.id === sv.id);
      this.consumeMeds(sv, u);
      if (u?.down) {
        if (homeDefense && !chance(HOME_DEFENSE_DOWN.severeChance)) {
          this.game.survivors.setHp(sv, Math.max(1, this.game.survivors.maxHp(sv) * HOME_DEFENSE_DOWN.hpPct));
          return;
        }
        this.game.survivors.becomeSevere(sv, '在戰鬥中', at, ...(attackXp ? [attackXp.downPct] : []));
        return;
      }
      const bonus = attackXp && result.victory ? Math.round(xpToNext(sv.level) * attackXp.winPct) : 0;
      if (bonus > 0) (result.winBonus = result.winBonus || []).push(`${sv.name} +${bonus.toLocaleString()}`);
      this.game.survivors.gainXp(sv, xpEach + bonus);
      if (u) this.game.survivors.setHp(sv, u.hp);
    });
    this.game.grant({ coins: Math.round(result.coins * COIN_GAIN_MUL), parts: result.parts });
    // 戰鬥後：生命低於 70% 的人從藥品欄吃藥補到不溢出
    const healed = survivors.map((sv) => this.game.survivors.postBattleHeal(sv)).filter(Boolean);
    // 藥品欄用掉的部分，從隊伍背包裡相同的藥品自動補滿（缺最多的人先補）
    const notes = [...healed, ...this.game.survivors.refillMeds(survivors)];
    if (notes.length) result.refills = notes;
  }
}
