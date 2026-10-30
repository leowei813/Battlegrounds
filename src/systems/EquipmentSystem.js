import {
  RARITIES, RARITY_ORDER, ITEM_TYPES, AFFIXES, RARITY_PREFIX, SLOT_KEYS, rarityIndex,
} from '../config/equipment.js';
import { weightedPick, pick, randFloat, uid, clamp } from '../utils/math.js';
import { canAfford, payCost, grant } from './costUtils.js';

/** 整數顯示的屬性（其餘為小數/百分比） */
const INT_STATS = new Set(['atk', 'def', 'hp']);

/**
 * 裝備系統：隨機生成（品質 + 詞綴）、穿脫、出售、拆解、製作。
 */
export class EquipmentSystem {
  constructor(game) {
    this.game = game;
  }

  get items() {
    return this.game.state.inventory.items;
  }

  getItem(id) {
    return this.items.find((i) => i.id === id) || null;
  }

  /** boost 0~1：提升高品質機率 */
  rollRarity(boost = 0) {
    const table = Object.fromEntries(
      RARITY_ORDER.map((r, i) => [r, RARITIES[r].weight * (1 + boost * i * 1.5)]),
    );
    return weightedPick(table);
  }

  /**
   * 產生一件裝備。
   * @param {{level:number, type?:string, rarity?:string, minRarity?:string, bias?:object, boost?:number}} opts
   */
  generate({ level = 1, type, rarity, minRarity, bias, boost = 0 }) {
    const typeId = type || weightedPick(bias || Object.fromEntries(Object.keys(ITEM_TYPES).map((k) => [k, 1])));
    const def = ITEM_TYPES[typeId];
    let rar = rarity || this.rollRarity(boost);
    if (minRarity && RARITY_ORDER.indexOf(rar) < RARITY_ORDER.indexOf(minRarity)) rar = minRarity;
    const rdef = RARITIES[rar];
    const lv = clamp(Math.round(level), 1, 60);
    // 每項數值各自在品級範圍內擲一次素質倍率；範圍互不重疊，保證高品級最低值 ≥ 低品級最高值
    const rolls = [];
    const roll = () => {
      const q = randFloat(rdef.min, rdef.max);
      rolls.push(q);
      return q;
    };
    const round = (k, v) => (INT_STATS.has(k) ? Math.round(v) : +v.toFixed(3));

    const stats = {};
    Object.entries(def.base).forEach(([k, v]) => {
      const grown = v + (def.perLevel[k] || 0) * (lv - 1);
      // 負面屬性（例如散彈槍的攻速懲罰）不隨品級放大
      stats[k] = round(k, grown > 0 ? grown * roll() : grown);
    });

    const affixPool = Object.keys(AFFIXES);
    const affixes = [];
    for (let i = 0; i < rdef.affixes && affixPool.length; i += 1) {
      const idx = Math.floor(Math.random() * affixPool.length);
      const aid = affixPool.splice(idx, 1)[0];
      const a = AFFIXES[aid];
      affixes.push({ id: aid, value: round(a.stat, (a.value + (a.perLevel || 0) * (lv - 1)) * roll()) });
    }

    const item = {
      id: uid('it'),
      type: typeId,
      slot: def.slot,
      rarity: rar,
      level: lv,
      name: `${pick(RARITY_PREFIX[rar])}${pick(def.names)}`,
      stats,
      affixes,
      // 素質：所有數值素質倍率的平均（%），供玩家比較同品級裝備
      quality: Math.round((rolls.reduce((s, q) => s + q, 0) / Math.max(1, rolls.length)) * 100),
      locked: false,
    };
    item.power = this.itemPower(item);
    return item;
  }

  /** 加總裝備提供的屬性（基礎 + 詞綴） */
  itemStats(item) {
    const out = { ...item.stats };
    item.affixes.forEach(({ id, value }) => {
      const stat = AFFIXES[id].stat;
      out[stat] = (out[stat] || 0) + value;
    });
    return out;
  }

  itemPower(item) {
    const s = this.itemStats(item);
    return Math.round(
      (s.atk || 0) * 3 + (s.def || 0) * 4 + (s.hp || 0) * 0.5 +
      ((s.crit || 0) + (s.dodge || 0)) * 300 + (s.critDmg || 0) * 100 +
      (s.atkSpeed || 0) * 120 + ((s.atkPct || 0) + (s.hpPct || 0) + (s.defPct || 0)) * 400 + (s.lootBonus || 0) * 200
      + (s.lifeSteal || 0) * 500 + (s.exploreSpeed || 0) * 250,
    );
  }

  /** 加入背包並更新統計 */
  addItem(item, source = '') {
    this.items.push(item);
    const st = this.game.state.stats;
    st.itemsFound += 1;
    if (rarityIndex(item.rarity) >= rarityIndex('rare')) st.rareItems += 1;
    if (item.rarity === 'legendary') {
      st.legendaryItems += 1;
      this.game.toast(`🌟 獲得稀有（橘色）裝備「${item.name}」！`, 'legendary');
    }
    if (rarityIndex(item.rarity) >= rarityIndex('epic')) {
      this.game.log(`${source}獲得 ${RARITIES[item.rarity].name}裝備「${item.name}」`, 'loot');
    }
    return item;
  }

  equip(survivorId, itemId) {
    const sv = this.game.survivors.get(survivorId);
    const item = this.getItem(itemId);
    if (!sv || !item) return { ok: false, reason: '找不到目標' };
    if (sv.status === 'exploring') return { ok: false, reason: '探索中無法更換裝備' };
    // 從其他人身上卸下
    this.game.state.survivors.forEach((s) => {
      SLOT_KEYS.forEach((slot) => {
        if (s.equipment[slot] === itemId) s.equipment[slot] = null;
      });
    });
    sv.equipment[item.slot] = itemId;
    return { ok: true };
  }

  unequip(survivorId, slot) {
    const sv = this.game.survivors.get(survivorId);
    if (!sv) return { ok: false, reason: '找不到倖存者' };
    sv.equipment[slot] = null;
    return { ok: true };
  }

  equippedBy(itemId) {
    return this.game.state.survivors.find((s) => Object.values(s.equipment).includes(itemId)) || null;
  }

  sellValue(item) {
    return Math.round(RARITIES[item.rarity].sell * (1 + item.level * 0.08));
  }

  dismantleValue(item) {
    const idx = RARITY_ORDER.indexOf(item.rarity);
    return { metal: 10 + item.level * 3, cloth: 4 + item.level, parts: [0, 0, 0, 1, 3, 8][idx] || 0 };
  }

  removeItem(itemId) {
    const item = this.getItem(itemId);
    if (!item) return { ok: false, reason: '找不到裝備' };
    if (item.locked) return { ok: false, reason: '裝備已上鎖' };
    if (this.equippedBy(itemId)) return { ok: false, reason: '請先卸下裝備' };
    this.game.state.inventory.items = this.items.filter((i) => i.id !== itemId);
    return { ok: true, item };
  }

  sell(itemId) {
    const item = this.getItem(itemId);
    const res = this.removeItem(itemId);
    if (!res.ok) return res;
    const coins = this.sellValue(item);
    grant(this.game.state, { coins });
    return { ok: true, msg: `出售獲得 ${coins} 金錢` };
  }

  dismantle(itemId) {
    const item = this.getItem(itemId);
    const res = this.removeItem(itemId);
    if (!res.ok) return res;
    const gain = this.dismantleValue(item);
    grant(this.game.state, gain, this.game.resources.storageCap());
    return { ok: true, msg: `拆解獲得 金屬${gain.metal} 布料${gain.cloth}${gain.parts ? ` 稀有材料${gain.parts}` : ''}` };
  }

  toggleLock(itemId) {
    const item = this.getItem(itemId);
    if (item) item.locked = !item.locked;
    return { ok: !!item };
  }

  // ---- 製作 ----

  /** 製作的高品級加成：工作台等級越高越容易做出好裝備；品級與素質仍然隨機 */
  craftBoost(withBlueprint = false) {
    return this.game.shelter.maxLevel('workbench') * 0.03 + (withBlueprint ? 0.3 : 0);
  }

  /** 製作出各品級的機率（UI 顯示用） */
  rarityOdds(boost) {
    const w = RARITY_ORDER.map((r, i) => RARITIES[r].weight * (1 + boost * i * 1.5));
    const sum = w.reduce((a, b) => a + b, 0);
    return Object.fromEntries(RARITY_ORDER.map((r, i) => [r, w[i] / sum]));
  }

  craftLevel() {
    return Math.max(1, this.game.shelter.maxLevel('workbench') * 5);
  }

  canCraftType(typeId) {
    const req = ITEM_TYPES[typeId]?.requires;
    return !req || this.game.research.isDone(req);
  }

  craftCost(typeId, withBlueprint = false) {
    const lv = this.craftLevel();
    const isWeapon = ITEM_TYPES[typeId].slot === 'weapon';
    const cost = isWeapon
      ? { metal: 40 + lv * 10, wood: 15 + lv * 3, fuel: 5 + lv }
      : { metal: 20 + lv * 6, cloth: 25 + lv * 6, wood: 10 + lv * 2 };
    if (withBlueprint) cost.parts = 1 + Math.floor(lv / 10);
    return cost;
  }

  craft(typeId, blueprintId = null) {
    if (!ITEM_TYPES[typeId]) return { ok: false, reason: '未知裝備類型' };
    if (this.game.shelter.maxLevel('workbench') < 1) return { ok: false, reason: '需要工作台' };
    const bpList = this.game.state.inventory.blueprints;
    const bp = blueprintId ? bpList.find((b) => b.id === blueprintId) : null;
    if (blueprintId && !bp) return { ok: false, reason: '找不到設計圖' };
    if (bp && bp.itemType !== typeId) return { ok: false, reason: '設計圖類型不符' };
    if (!bp && !this.canCraftType(typeId)) return { ok: false, reason: '尚未研究此裝備' };
    const cost = this.craftCost(typeId, !!bp);
    if (!payCost(this.game.state, cost)) return { ok: false, reason: '資源不足' };
    if (bp) this.game.state.inventory.blueprints = bpList.filter((b) => b.id !== bp.id);
    const item = this.generate({
      level: this.craftLevel(), type: typeId, minRarity: bp?.rarity, boost: this.craftBoost(!!bp),
    });
    this.addItem(item, '製作');
    this.game.state.stats.crafted += 1;
    return { ok: true, item, msg: `製作完成：${RARITIES[item.rarity].name}「${item.name}」` };
  }

  /** 生成設計圖 */
  makeBlueprint(level) {
    const types = Object.keys(ITEM_TYPES);
    const rarity = level > 15 && Math.random() < 0.3 ? 'epic' : 'rare';
    return { id: uid('bp'), itemType: pick(types), rarity };
  }

  canAffordCraft(typeId, bp) {
    return canAfford(this.game.state, this.craftCost(typeId, bp));
  }
}
