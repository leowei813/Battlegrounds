import {
  MAIN_QUESTS, DAILY_POOL, DAILY_COUNT, ACHIEVEMENTS,
} from '../config/quests.js';
import { RARITIES } from '../config/equipment.js';
import { SUPPLIES } from '../config/supplies.js';

const todayKey = (d = new Date()) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;

/**
 * 任務系統：主線（依序）、每日（每天重置 3 個）、成就（一次性）。
 */
export class QuestSystem {
  constructor(game) {
    this.game = game;
  }

  get state() {
    return this.game.state.quests;
  }

  /** 計算條件進度 */
  progress(cond, baseline = null) {
    const st = this.game.state;
    switch (cond.type) {
      case 'shelterSet':
        return { cur: st.bases.length ? 1 : 0, max: 1 };
      case 'facility':
        return { cur: this.game.shelter.maxLevel(cond.id), max: cond.value };
      case 'bases':
        return { cur: st.bases.length, max: cond.value };
      case 'civilization':
        return { cur: this.game.civilization.value(), max: cond.value };
      case 'stat':
        return { cur: st.stats[cond.key] || 0, max: cond.value };
      case 'statDelta':
        return { cur: (st.stats[cond.key] || 0) - (baseline?.[cond.key] || 0), max: cond.value };
      case 'survivors':
        return { cur: st.survivors.length, max: cond.value };
      case 'defenses':
        return { cur: this.game.shelter.defenseCount(), max: cond.value };
      case 'research':
        return { cur: Object.values(st.research.levels).reduce((s, v) => s + v, 0), max: cond.value };
      default:
        return { cur: 0, max: 1 };
    }
  }

  isDone(cond, baseline) {
    const p = this.progress(cond, baseline);
    return p.cur >= p.max;
  }

  currentMain() {
    return MAIN_QUESTS[this.state.mainIndex] || null;
  }

  ensureDaily() {
    const key = todayKey();
    if (this.state.dailyDate === key) return;
    const pool = [...DAILY_POOL];
    const picks = [];
    while (picks.length < DAILY_COUNT && pool.length) {
      picks.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0].id);
    }
    const baseline = { ...this.game.state.stats };
    this.state.dailyDate = key;
    this.state.dailies = picks.map((id) => ({ id, baseline, claimed: false }));
    if (this.game.started) this.game.toast('📅 每日任務已刷新', 'info');
  }

  dailyDefs() {
    return this.state.dailies.map((d) => ({ ...d, def: DAILY_POOL.find((x) => x.id === d.id) })).filter((d) => d.def);
  }

  /** 可領取數量（UI 徽章） */
  claimableCount() {
    let n = 0;
    const main = this.currentMain();
    if (main && this.isDone(main.cond)) n += 1;
    this.dailyDefs().forEach((d) => { if (!d.claimed && this.isDone(d.def.cond, d.baseline)) n += 1; });
    ACHIEVEMENTS.forEach((a) => { if (!this.state.achievements[a.id] && this.isDone(a.cond)) n += 1; });
    return n;
  }

  giveReward(reward) {
    const { item, ...rest } = reward;
    this.game.grant(rest, true);
    if (item) {
      const level = this.game.survivors.leader().level + 2;
      const it = this.game.equipment.generate({ level, rarity: item });
      this.game.equipment.addItem(it, '任務');
    }
  }

  claimMain() {
    const q = this.currentMain();
    if (!q || !this.isDone(q.cond)) return { ok: false, reason: '尚未完成' };
    this.giveReward(q.reward);
    this.state.mainIndex += 1;
    this.game.log(`📜 主線完成：「${q.name}」`, 'success');
    return { ok: true, msg: `完成主線「${q.name}」` };
  }

  claimDaily(id) {
    const d = this.dailyDefs().find((x) => x.id === id);
    if (!d || d.claimed || !this.isDone(d.def.cond, d.baseline)) return { ok: false, reason: '尚未完成' };
    this.state.dailies.find((x) => x.id === id).claimed = true;
    this.giveReward(d.def.reward);
    return { ok: true, msg: `完成每日「${d.def.name}」` };
  }

  claimAchievement(id) {
    const a = ACHIEVEMENTS.find((x) => x.id === id);
    if (!a || this.state.achievements[id] || !this.isDone(a.cond)) return { ok: false, reason: '尚未達成' };
    this.state.achievements[id] = Date.now();
    this.giveReward(a.reward);
    this.game.log(`🏅 成就解鎖：「${a.name}」`, 'legendary');
    return { ok: true, msg: `成就「${a.name}」` };
  }

  rewardText(reward) {
    const names = { coins: '💰', parts: '⚙️', food: '🥫', wood: '🪵', fuel: '⛽' };
    return Object.entries(reward)
      .map(([k, v]) => (k === 'item' ? `🎁${RARITIES[v]?.name || v}裝備` : `${names[k] || (SUPPLIES[k] ? `${SUPPLIES[k].icon}${SUPPLIES[k].name}` : k)}${v}`))
      .join(' ');
  }

  update() {
    this.ensureDaily();
    this.game.state.stats.daysSurvived = Math.max(this.game.state.stats.daysSurvived, this.game.time.day() - 1);
  }
}
