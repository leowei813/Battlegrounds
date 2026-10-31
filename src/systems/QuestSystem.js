import {
  MAIN_QUESTS, DAILY_POOL, DAILY_COUNT, ACHIEVEMENTS, DAILY_CHEST,
} from '../config/quests.js';
import { RARITIES, ITEM_TYPES } from '../config/equipment.js';
import { SUPPLIES, SUPPLY_KEYS, medWeight } from '../config/supplies.js';
import {
  withSeed, weightedPick, randInt, pick, randFloat,
} from '../utils/math.js';

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
    if (this.chestReady()) n += 1;
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

  // ---------- 每日物資箱 ----------

  /** 今天的每日任務是否都已領取 */
  allDailiesClaimed() {
    const list = this.dailyDefs();
    return list.length > 0 && list.every((d) => d.claimed);
  }

  chestReady() {
    return this.allDailiesClaimed() && this.state.chestDate !== this.state.dailyDate;
  }

  /** 物資箱裡各材料的權重：越高階越稀有 */
  static supplyWeights() {
    return Object.fromEntries(SUPPLY_KEYS.map((k) => {
      const sp = SUPPLIES[k];
      const w = sp.cat === 'med' ? medWeight(k) / 2 : 6 * 0.45 ** (sp.tier - 1);
      return [k, w];
    }));
  }

  /** 開啟每日物資箱（使用存檔種子：重新讀檔結果不變） */
  openChest() {
    if (!this.chestReady()) return { ok: false, reason: this.allDailiesClaimed() ? '今天已經開過了' : '請先完成並領取今天全部的每日任務' };
    return withSeed(this.game.state.rng, 'craft', () => this.openChestNow());
  }

  openChestNow() {
    const g = this.game;
    this.state.chestDate = this.state.dailyDate;
    const level = (g.survivors.leader()?.level || 1) + 2;
    const supplies = {};
    const items = [];
    const blueprints = [];
    const n = randInt(DAILY_CHEST.rolls[0], DAILY_CHEST.rolls[1]);
    const weights = QuestSystem.supplyWeights();
    for (let i = 0; i < n; i += 1) {
      const kind = weightedPick(DAILY_CHEST.kinds);
      if (kind === 'supply') {
        const k = weightedPick(weights);
        const sp = SUPPLIES[k];
        const amount = Math.max(1, Math.round((sp.cat === 'ammo' ? 12 : sp.cat === 'med' ? 1.5 : 5) * (6 - sp.tier) / 3 * randFloat(0.6, 1.4)));
        supplies[k] = (supplies[k] || 0) + amount;
      } else if (kind === 'gear') {
        items.push(g.equipment.generate({ level, type: pick(Object.keys(ITEM_TYPES)), rarity: weightedPick(DAILY_CHEST.gearRarity) }));
      } else {
        blueprints.push(g.equipment.makeBlueprint(level));
      }
    }
    const got = g.grant(supplies);
    const kept = items.filter((it) => g.equipment.addItem(it, '每日物資箱'));
    g.state.inventory.blueprints.push(...blueprints);
    g.state.stats.chestsOpened = (g.state.stats.chestsOpened || 0) + 1;
    const lines = [
      ...Object.entries(got).filter(([, v]) => v > 0).map(([k, v]) => `${SUPPLIES[k].icon} ${SUPPLIES[k].name} ×${v}`),
      ...kept.map((it) => `🎁 ${RARITIES[it.rarity].name}「${it.name}」`),
      ...blueprints.map(() => '📜 設計圖'),
    ];
    g.log(`🎁 開啟每日物資箱：${lines.join('、') || '（倉庫已滿，什麼都放不下）'}`, 'loot');
    return { ok: true, lines, items: kept, msg: '🎁 每日物資箱已開啟' };
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
