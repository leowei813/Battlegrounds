import { MAX_TEAM_SIZE, OFFLINE_CAP_MS, RESOURCES } from '../config/constants.js';
import { POI_TYPES } from '../config/poiTypes.js';
import { RARITIES } from '../config/equipment.js';
import {
  chance, pick, randInt, uid, weightedPick, haversine, clamp, randFloat,
} from '../utils/math.js';

const SPECIAL_EVENTS = [
  { id: 'cache', text: '發現一個隱藏的物資箱！', reward: () => ({ coins: randInt(20, 60), parts: chance(0.5) ? 1 : 0 }) },
  { id: 'trader', text: '遇到一名流浪商人，用雜物換到了金錢。', reward: () => ({ coins: randInt(30, 90) }) },
  { id: 'radio', text: '從無線電聽到補給投放的位置，順利取回。', reward: () => ({ food: randInt(30, 80), medicine: randInt(3, 10) }) },
  { id: 'car', text: '找到一輛廢棄汽車，抽出了油箱裡的燃料。', reward: () => ({ fuel: randInt(20, 50) }) },
  { id: 'trap', text: '踩中前人留下的陷阱，一名隊員受了輕傷。', injure: true, reward: () => ({}) },
  { id: 'diary', text: '在屍體旁撿到一本日記，記錄著研究資料。', reward: () => ({ parts: randInt(1, 2) }) },
];

/**
 * 探索系統：派遣隊伍前往地圖建築，經過一段時間後結算事件。
 * 支援自動探索（研究解鎖）與離線結算。
 */
export class ExplorationSystem {
  constructor(game) {
    this.game = game;
  }

  get list() {
    return this.game.state.expeditions;
  }

  poi(id) {
    return this.game.state.map.pois.find((p) => p.id === id) || null;
  }

  /** 計算實際探索時間（毫秒） */
  actualDurationMs(poi, members, durationMin, at = Date.now()) {
    // 探索隊從主要據點出發
    const sh = this.game.shelter.primary();
    const km = sh ? haversine(sh.lat, sh.lon, poi.lat, poi.lon) / 1000 : 0;
    const travelMin = km * 4; // 單程 + 回程，約每公里 4 分鐘
    const scout = Math.max(0, ...members.map((m) => this.game.survivors.skillEffects(m).exploreSpeed || 0));
    const speed = this.game.time.exploreSpeedMul(at) * (1 + scout + this.game.research.bonus('exploreSpeed'));
    return Math.round(((durationMin + travelMin) / speed) * 60000);
  }

  validate(poiId, memberIds) {
    const poi = this.poi(poiId);
    if (!poi) return { ok: false, reason: '找不到地點' };
    if (!this.game.shelter.hasShelter()) return { ok: false, reason: '請先建立避難所' };
    if (!memberIds.length) return { ok: false, reason: '請至少選擇一名隊員' };
    if (memberIds.length > MAX_TEAM_SIZE) return { ok: false, reason: `隊伍最多 ${MAX_TEAM_SIZE} 人` };
    const members = memberIds.map((id) => this.game.survivors.get(id));
    if (members.some((m) => !m || !this.game.survivors.isAvailable(m))) return { ok: false, reason: '有隊員無法出發' };
    return { ok: true, poi, members };
  }

  start(poiId, memberIds, durationMin, auto = false, startAt = Date.now()) {
    const v = this.validate(poiId, memberIds);
    if (!v.ok) return v;
    if (auto && !this.game.research.hasUnlock('autoExplore')) return { ok: false, reason: '需研究「斥候訓練」解鎖自動探索' };
    const ms = this.actualDurationMs(v.poi, v.members, durationMin, startAt);
    v.members.forEach((m) => { m.status = 'exploring'; });
    const exp = {
      id: uid('ex'), poiId, memberIds: [...memberIds], durationMin, auto,
      startAt, endAt: startAt + ms, phaseAtStart: this.game.time.phaseId(startAt),
    };
    this.list.push(exp);
    return { ok: true, exp, msg: `隊伍出發前往「${v.poi.name}」` };
  }

  recall(expId) {
    const exp = this.list.find((e) => e.id === expId);
    if (!exp) return { ok: false, reason: '找不到隊伍' };
    this.free(exp);
    this.game.state.expeditions = this.list.filter((e) => e.id !== expId);
    return { ok: true, msg: '隊伍已召回（無收穫）' };
  }

  toggleAuto(expId) {
    const exp = this.list.find((e) => e.id === expId);
    if (!exp) return { ok: false };
    if (!this.game.research.hasUnlock('autoExplore')) return { ok: false, reason: '需研究「斥候訓練」' };
    exp.auto = !exp.auto;
    return { ok: true, msg: exp.auto ? '已開啟自動探索' : '已關閉自動探索' };
  }

  free(exp) {
    exp.memberIds.forEach((id) => {
      const m = this.game.survivors.get(id);
      if (m && m.status === 'exploring') m.status = 'idle';
    });
  }

  /**
   * 結算到期的探索；離線時可能一次結算多輪自動探索。
   * @returns {object[]} 報告列表
   */
  update(now, { silent = false } = {}) {
    const reports = [];
    let guard = 0;
    let due = this.list.filter((e) => e.endAt <= now);
    while (due.length && guard < 400) {
      guard += 1;
      due.forEach((exp) => {
        this.game.state.expeditions = this.list.filter((e) => e.id !== exp.id);
        const report = this.resolve(exp);
        reports.push(report);
        this.free(exp);
        // 自動探索：隊員健康且未超過離線上限則再次出發
        const healthy = exp.memberIds.every((id) => {
          const m = this.game.survivors.get(id);
          return m && m.injuredUntil <= exp.endAt;
        });
        if (exp.auto && healthy && now - exp.endAt < OFFLINE_CAP_MS && this.game.research.hasUnlock('autoExplore')) {
          this.start(exp.poiId, exp.memberIds, exp.durationMin, true, exp.endAt);
        }
      });
      due = this.list.filter((e) => e.endAt <= now);
    }
    if (reports.length) {
      const st = this.game.state;
      st.reports = [...reports.reverse(), ...(st.reports || [])].slice(0, 20);
      if (!silent) {
        reports.forEach((r) => this.game.toast(`${r.success ? '✅' : '⚠️'} ${r.poiName} 探索${r.success ? '完成' : '受挫'}`, r.success ? 'success' : 'danger'));
      }
      this.game.bus.emit('expedition:done', reports);
    }
    return reports;
  }

  /** 結算一次探索 */
  resolve(exp) {
    const poi = this.poi(exp.poiId);
    const members = exp.memberIds.map((id) => this.game.survivors.get(id)).filter(Boolean);
    const report = {
      id: uid('rp'), poiName: poi?.name || '未知地點', poiType: poi?.type, at: exp.endAt,
      events: [], resources: {}, items: [], blueprints: [], kills: 0, xp: 0, success: true, members: members.map((m) => m.name),
    };
    if (!poi || !members.length) {
      report.success = false;
      report.events.push('目標地點已消失。');
      return report;
    }
    const pt = POI_TYPES[poi.type];
    const danger = this.game.zombies.areaDanger(poi);
    const level = this.game.zombies.areaLevel(poi);
    const phase = this.game.time.phase(exp.startAt);
    const memberStats = members.map((m) => this.game.survivors.stats(m));
    const fx = members.map((m) => this.game.survivors.skillEffects(m));
    const lootMul = phase.lootMul * (1 + this.game.research.bonus('lootPct'))
      * (1 + Math.max(0, ...fx.map((f) => f.lootPct || 0)))
      * (1 + memberStats.reduce((s, x) => s + (x.lootBonus || 0), 0))
      * (1 - (poi.depletion || 0));
    const itemMul = 1 + Math.max(0, ...fx.map((f) => f.itemPct || 0));
    const forage = Math.max(0, ...fx.map((f) => f.forage || 0));

    const eventCount = Math.max(1, Math.round(exp.durationMin / 8));
    const gained = {};
    for (let i = 0; i < eventCount; i += 1) {
      const ev = weightedPick({
        loot: 46, zombies: 28 * phase.zombieMul, survivor: 5, special: 10, elite: 3 + danger * phase.danger,
      });
      if (ev === 'loot') {
        const amount = (10 + danger * 6) * lootMul * randFloat(0.7, 1.3);
        const picks = [weightedPick(pt.loot), weightedPick(pt.loot)];
        picks.forEach((k) => {
          let v = amount / 2;
          if (k === 'food') v *= 1 + forage;
          gained[k] = (gained[k] || 0) + v;
        });
        report.events.push(`🔍 搜刮到 ${picks.map((k) => RESOURCES[k].name).join('、')}`);
        if (chance(pt.itemChance * itemMul)) {
          const item = this.game.equipment.generate({ level, bias: pt.itemBias, boost: danger * 0.05 });
          report.items.push(item);
          report.events.push(`🎁 找到 ${RARITIES[item.rarity].name}「${item.name}」`);
        }
        if (chance(pt.blueprintChance)) {
          const bp = this.game.equipment.makeBlueprint(level);
          report.blueprints.push(bp);
          report.events.push('📜 找到一張設計圖！');
        }
      } else if (ev === 'survivor') {
        const cand = this.game.survivors.makeCandidate(randInt(1, Math.max(1, level - 1)));
        const pool = this.game.state.recruitPool;
        if (pool.length < 5) pool.push(cand);
        report.events.push(`🙋 遇到倖存者 ${cand.name}，對方願意加入（請到倖存者頁面確認）`);
      } else if (ev === 'special') {
        const sp = pick(SPECIAL_EVENTS);
        report.events.push(`✨ ${sp.text}`);
        Object.entries(sp.reward()).forEach(([k, v]) => { if (v) gained[k] = (gained[k] || 0) + v; });
        if (sp.injure) this.game.survivors.injure(pick(members), 5, 0, exp.endAt);
      } else {
        const isElite = ev === 'elite';
        let enemies;
        if (isElite) {
          const enemyId = weightedPick(pt.enemies);
          enemies = [this.game.combat.createEnemy(enemyId, level + 2, true)];
          report.events.push(`⚠️ 遭遇精英怪 ${enemies[0].name}！`);
        } else {
          const n = randInt(2, 2 + danger);
          enemies = Array.from({ length: n }, () => this.game.combat.createEnemy(weightedPick(pt.enemies), level));
          report.events.push(`🧟 遭遇 ${n} 隻殭屍`);
        }
        const fs = this.game.shelter.primary().facilities.watchtower.level * 0.04;
        const result = this.game.combat.simulate(members, enemies, { firstStrikeBonus: fs });
        this.game.combat.applyOutcome(members, result, exp.endAt);
        report.kills += result.kills.length;
        report.xp += result.xp;
        if (result.victory) {
          report.events.push(`  ↳ 勝利！擊殺 ${result.kills.length}，獲得 ${result.coins} 金錢`);
          if (isElite) {
            const item = this.game.equipment.generate({ level: level + 2, bias: pt.itemBias, boost: 0.5, minRarity: 'uncommon' });
            report.items.push(item);
            report.events.push(`  ↳ 精英掉落 ${RARITIES[item.rarity].name}「${item.name}」`);
          }
        } else {
          report.success = false;
          report.events.push('  ↳ 戰鬥失敗，隊伍帶著部分物資撤退！');
          Object.keys(gained).forEach((k) => { gained[k] *= 0.5; });
          break;
        }
      }
    }

    // 入帳
    const rounded = Object.fromEntries(Object.entries(gained).map(([k, v]) => [k, Math.round(v)]));
    report.resources = this.game.grant(rounded);
    report.items.forEach((it) => this.game.equipment.addItem(it, '探索'));
    this.game.state.inventory.blueprints.push(...report.blueprints);
    members.forEach((m) => this.game.survivors.gainXp(m, 4 + exp.durationMin));
    poi.depletion = clamp((poi.depletion || 0) + 0.08, 0, 0.6);
    poi.lastVisit = exp.endAt;
    this.game.state.stats.explorations += 1;
    return report;
  }

  /** 地點物資隨時間恢復 */
  regenerate(dtMs) {
    const rate = (dtMs / 1800000) * 0.08; // 每 30 分鐘恢復 8%
    this.game.state.map.pois.forEach((p) => {
      if (p.depletion) p.depletion = Math.max(0, p.depletion - rate);
    });
  }
}
