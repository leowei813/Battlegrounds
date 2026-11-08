import { REBIRTH, LOCK_ITEM, twDay } from '../config/rebirth.js';
import { QUALITY_KEYS, QUALITY_NAMES } from '../config/survivors.js';
import { chance } from '../utils/math.js';

/**
 * 🧬 脫胎換骨還你漂漂重生器：花金幣重新洗鍊倖存者素質；可用「就是要鎖你」鎖住素質。
 * 洗鍊結果先放在 pending，玩家選「快樂重生」才套用，「還你原形」或關閉視窗則維持原本（費用不退）。
 */
/**
 * 超渡素質（v12.2.1）：在「保底～100%」之間重新隨機（與招募相同的偏低分佈），
 * 不再把低於保底的直接拉到保底（避免很多項都停在同一個數字）。
 */
export function washQuality(floor, rnd = Math.random) {
  const fl = Math.max(0, Math.min(100, floor || 0));
  return Math.min(100, fl + Math.floor((100 - fl + 1) * rnd() ** 1.6));
}

export class RebirthSystem {
  constructor(game) {
    this.game = game;
    /** 尚未決定的洗鍊結果 { svId: { quality, at } }（不存檔：重新整理等於還你原形） */
    this.pending = {};
  }

  /** 主要避難所的重生器等級 */
  level() {
    return this.game.shelter.primary()?.facilities?.rebirth?.level || 0;
  }

  locks() {
    return Math.max(0, Math.floor(this.game.state.player.locks || 0));
  }

  addLocks(n) {
    if (!(n > 0)) return 0;
    this.game.state.player.locks = this.locks() + n;
    return n;
  }

  lockSlots() {
    return REBIRTH.lockSlots(this.level());
  }

  /** 今天已經洗過這位幾次 */
  todayCount(sv) {
    return sv?.wash?.day === twDay() ? sv.wash.n || 0 : 0;
  }

  /** 費用折扣：重生器每級 −3%、基因調理每級 −4%，最多 −70% */
  discount() {
    return Math.min(REBIRTH.maxDiscount, this.level() * REBIRTH.facDiscount + this.game.research.bonus('washCostReduce'));
  }

  /** 洗鍊費用（金幣） */
  cost(sv, lockN = 0) {
    const mul = REBIRTH.rarityMul[sv?.rarity] ?? 1;
    const raw = REBIRTH.base * mul * (1 + (sv?.level || 1) * REBIRTH.perLevel)
      * (1 + lockN * REBIRTH.lockMul) * (1 + this.todayCount(sv) * REBIRTH.dailyStep);
    return Math.max(1, Math.round(raw * (1 - this.discount())));
  }

  /** 每項素質的最低保底（研究「優生學」） */
  floor() {
    return Math.max(0, Math.min(100, Math.round(this.game.research.bonus('washFloor'))));
  }

  canWash(sv, lockKeys = []) {
    if (!sv) return { ok: false, reason: '找不到這位倖存者' };
    if (sv.isLeader) return { ok: false, reason: '首領的素質固定 100%，不需要超渡' };
    if (this.level() < 1) return { ok: false, reason: '需要先在避難所建造「脫胎換骨還你漂漂重生器」' };
    if (sv.status !== 'idle') return { ok: false, reason: '倖存者要在避難所內才能超渡' };
    const locks = [...new Set(lockKeys)].filter((k) => QUALITY_KEYS.includes(k));
    if (locks.length > this.lockSlots()) return { ok: false, reason: `重生器 Lv${this.level()} 最多鎖 ${this.lockSlots()} 種素質` };
    if (locks.length >= QUALITY_KEYS.length) return { ok: false, reason: '至少要留一種素質重新洗鍊' };
    if (locks.length > this.locks()) return { ok: false, reason: `「${LOCK_ITEM.name}」不足（需要 ${locks.length}，持有 ${this.locks()}）` };
    const cost = this.cost(sv, locks.length);
    if ((this.game.state.player.coins || 0) < cost) return { ok: false, reason: `金錢不足（需要 ${cost}）` };
    return { ok: true, cost, locks };
  }

  /** 進行超渡：扣費、隨機新素質（結果先放 pending，等玩家選擇） */
  wash(svId, lockKeys = [], rnd = Math.random) {
    const g = this.game;
    const sv = g.survivors.get(svId);
    const c = this.canWash(sv, lockKeys);
    if (!c.ok) return c;
    g.state.player.coins -= c.cost;
    g.state.player.locks = this.locks() - c.locks.length;
    const day = twDay();
    sv.wash = { day, n: this.todayCount(sv) + 1 };
    const before = { ...this.qualityOf(sv) };
    const fl = this.floor();
    const after = Object.fromEntries(QUALITY_KEYS.map((k) => [k, c.locks.includes(k) ? before[k] : washQuality(fl, rnd)]));
    this.pending[sv.id] = { quality: after, at: Date.now() };
    g.state.stats.washes = (g.state.stats.washes || 0) + 1;
    g.changed?.();
    return {
      ok: true, cost: c.cost, locks: c.locks, before, after,
      powerBefore: g.survivors.stats(sv).power, powerAfter: this.powerWith(sv, after),
    };
  }

  qualityOf(sv) {
    return Object.fromEntries(QUALITY_KEYS.map((k) => [k, this.game.survivors.qualityOf(sv, k)]));
  }

  /** 套用某組素質時的戰力 */
  powerWith(sv, quality) {
    const old = sv.quality;
    sv.quality = { ...quality };
    const p = this.game.survivors.stats(sv).power;
    sv.quality = old;
    return p;
  }

  /** 快樂重生（accept=true）或還你原形 */
  decide(svId, accept) {
    const g = this.game;
    const p = this.pending[svId];
    delete this.pending[svId];
    const sv = g.survivors.get(svId);
    if (!p || !sv) return { ok: false, reason: '沒有待確認的超渡結果' };
    if (!accept) return { ok: true, msg: `${sv.name} 還你原形，素質維持不變` };
    const hp = g.survivors.hpOf(sv) / Math.max(1, g.survivors.maxHp(sv));
    sv.quality = { ...p.quality };
    g.survivors.setHp(sv, Math.round(g.survivors.maxHp(sv) * hp));
    g.log(`🧬 ${sv.name} 快樂重生：平均素質 ${g.survivors.avgQuality(sv)}%`, 'success');
    g.changed?.();
    return { ok: true, msg: `🎉 ${sv.name} 快樂重生！` };
  }

  /** 搜索完一棟建築：抽一次「就是要鎖你」 */
  rollSearch(zoneId, rnd = Math.random) {
    const p = LOCK_ITEM.searchChance * (LOCK_ITEM.zoneMul[zoneId] ?? 1) * (1 + this.game.research.bonus('lockDropAdd'));
    return rnd() < p ? 1 : 0;
  }

  /** 攻陷 NPC 據點 */
  rollNpc() {
    return chance(LOCK_ITEM.npcChance) ? 1 : 0;
  }

  /** 消滅重度感染據點（依參戰人數） */
  infectDrop(people) {
    return LOCK_ITEM.infectBase + (people >= LOCK_ITEM.infectBonusAt ? 1 : 0);
  }

  // ---------- 黑市特殊品 ----------

  bmBoughtToday() {
    const r = this.game.state.bmSpecial;
    return r?.day === twDay() ? r.n || 0 : 0;
  }

  bmLeft() {
    return Math.max(0, LOCK_ITEM.bmDaily - this.bmBoughtToday());
  }

  buyLocks(n = 1) {
    const g = this.game;
    const qty = Math.max(1, Math.floor(n));
    if (qty > this.bmLeft()) return { ok: false, reason: `今天最多還能買 ${this.bmLeft()} 個` };
    const cost = qty * LOCK_ITEM.bmPrice;
    if ((g.state.player.coins || 0) < cost) return { ok: false, reason: `金錢不足（需要 ${cost}）` };
    g.state.player.coins -= cost;
    this.addLocks(qty);
    g.state.bmSpecial = { day: twDay(), n: this.bmBoughtToday() + qty };
    g.changed?.();
    return { ok: true, msg: `🔒 買到 ${qty} 個「${LOCK_ITEM.name}」` };
  }
}

export { QUALITY_NAMES };
