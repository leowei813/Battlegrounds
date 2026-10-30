import {
  RARITIES, RARITY_ORDER, ITEM_TYPES, AFFIXES, RARITY_PREFIX, SLOT_KEYS, rarityIndex,
  ITEM_MODELS, tierMul, benchFor, craftRarityTable,
  BAG_BASE_SLOTS, STORE_BASE_SLOTS, STORE_SLOTS_PER_LEVEL, itemSize, itemWeight,
} from '../config/equipment.js';
import {
  withSeed,
  weightedPick, pick, randFloat, uid, clamp, chance,
} from '../utils/math.js';
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
   * 依等級挑選型號：越強（tier 越高）越難取得；等級越高可能出現的強度上限越高。
   * @param {string} type 類別
   * @param {number} level 掉落等級
   * @param {number} [tierBoost] 額外提高強度上限（精英、Boss）
   */
  pickModel(type, level, tierBoost = 0) {
    const cap = clamp(1 + level / 5 + tierBoost, 1, 10);
    const table = Object.fromEntries(Object.entries(ITEM_MODELS)
      .filter(([, md]) => md.type === type)
      .map(([id, md]) => [id, 0.7 ** (md.tier - 1) * (md.tier <= cap ? 1 : 0.1 ** (md.tier - cap))]));
    return weightedPick(table);
  }

  /**
   * 產生一件裝備。
   * @param {{level:number, model?:string, type?:string, rarity?:string, minRarity?:string, bias?:object,
   *   boost?:number, tierBoost?:number, qualityAdd?:number}} opts
   */
  generate({
    level = 1, model, type, rarity, minRarity, bias, boost = 0, tierBoost = 0, qualityAdd = 0,
  }) {
    const typeId = model ? ITEM_MODELS[model].type : type || weightedPick(bias || Object.fromEntries(Object.keys(ITEM_TYPES).map((k) => [k, 1])));
    const lv = clamp(Math.round(level), 1, 60);
    const modelId = model || this.pickModel(typeId, lv, tierBoost);
    const md = ITEM_MODELS[modelId];
    const def = ITEM_TYPES[typeId];
    let rar = rarity || this.rollRarity(boost);
    if (minRarity && RARITY_ORDER.indexOf(rar) < RARITY_ORDER.indexOf(minRarity)) rar = minRarity;
    const rdef = RARITIES[rar];
    const tm = tierMul(md.tier);
    // 每項數值各自在品級範圍內擲一次素質倍率；範圍互不重疊，保證高品級最低值 ≥ 低品級最高值
    const rolls = [];
    const q0 = clamp(qualityAdd, 0, 0.9);
    const roll = () => {
      const q = randFloat(rdef.min + (rdef.max - rdef.min) * q0, rdef.max);
      rolls.push(q);
      return q;
    };
    const round = (k, v) => (INT_STATS.has(k) ? Math.round(v) : +v.toFixed(3));

    const stats = {};
    Object.entries(def.base).forEach(([k, v]) => {
      const grown = v + (def.perLevel[k] || 0) * (lv - 1);
      // 負面屬性（例如散彈槍的攻速懲罰）不隨品級與強度放大
      stats[k] = round(k, grown > 0 ? grown * tm * roll() : grown);
    });
    Object.entries(md.extra || {}).forEach(([k, v]) => { stats[k] = Math.round(v * roll()); });

    const affixPool = Object.keys(AFFIXES);
    const affixes = [];
    for (let i = 0; i < rdef.affixes && affixPool.length; i += 1) {
      const idx = Math.floor(randFloat(0, affixPool.length));
      const aid = affixPool.splice(idx, 1)[0];
      const a = AFFIXES[aid];
      affixes.push({ id: aid, value: round(a.stat, (a.value + (a.perLevel || 0) * (lv - 1)) * roll()) });
    }

    const item = {
      id: uid('it'),
      model: modelId,
      type: typeId,
      cat: typeId,
      tier: md.tier,
      slot: def.slot,
      rarity: rar,
      level: lv,
      name: `${pick(RARITY_PREFIX[rar])}${md.name}`,
      stats,
      affixes,
      // 素質：所有數值素質倍率的平均（%），供玩家比較同品級裝備
      quality: Math.round((rolls.reduce((sum, q) => sum + q, 0) / Math.max(1, rolls.length)) * 100),
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
      + (s.lifeSteal || 0) * 500 + (s.exploreSpeed || 0) * 250 + (s.carry || 0) * 2,
    );
  }

  // ---------- 物品空間（格子與重量） ----------

  /** 是否穿戴中（穿戴中的裝備不佔格子） */
  isWorn(item) {
    return !!this.equippedBy(item.id);
  }

  /** 倉庫格子：初始 30，倉庫每升一級 +10，研究「倉儲擴建」再增加 */
  storeCap() {
    const wh = this.game.shelter.primary()?.facilities.warehouse.level || 1;
    return STORE_BASE_SLOTS + Math.max(0, wh - 1) * STORE_SLOTS_PER_LEVEL + Math.floor(this.game.research.bonus('storeSlots'));
  }

  storeItems() {
    return this.items.filter((i) => (i.loc || 'store') === 'store' && !this.isWorn(i));
  }

  storeUsed() {
    return this.storeItems().reduce((s, i) => s + itemSize(i), 0);
  }

  /** 隊員背包的物品格子：初始 10，加上背包裝備的格數 */
  bagSlotCap(sv) {
    const bag = this.getItem(sv?.equipment?.backpack);
    return BAG_BASE_SLOTS + (bag?.stats?.slots || 0);
  }

  bagItems(sv) {
    return this.items.filter((i) => i.loc === sv.id && !this.isWorn(i));
  }

  /** 背包已用格數：每件裝備 1 格，每種消耗品（堆疊）1 格 */
  bagSlotsUsed(sv) {
    const stacks = Object.values(sv.bag || {}).filter((v) => v > 0).length;
    return this.bagItems(sv).length + stacks;
  }

  /** 背包物品的總重量（計入負重） */
  bagItemWeight(sv) {
    return this.bagItems(sv).reduce((s, i) => s + itemWeight(i), 0);
  }

  /** 能否放進某處：倉庫看格子；隊員背包看格子與負重 */
  fits(item, loc) {
    const size = itemSize(item);
    if (loc === 'store') return this.storeUsed() + size <= this.storeCap();
    const sv = this.game.survivors.get(loc);
    if (!sv) return false;
    return this.bagSlotsUsed(sv) + size <= this.bagSlotCap(sv)
      && this.game.survivors.bagLoad(sv) + itemWeight(item) <= this.game.survivors.bagCap(sv);
  }

  /** 找位置放：先倉庫，再依序放進 members 的背包；都放不下回傳 null */
  placeFor(item, members = []) {
    if (this.fits(item, 'store')) return 'store';
    const sv = members.find((m) => this.fits(item, m.id));
    return sv ? sv.id : null;
  }

  /** 移到倉庫（需在避難所） */
  moveToStore(itemId) {
    const item = this.getItem(itemId);
    if (!item) return { ok: false, reason: '找不到物品' };
    const owner = this.game.survivors.get(item.loc);
    if (owner && !this.game.survivors.atShelter(owner)) return { ok: false, reason: '攜帶者不在避難所' };
    if (!this.fits(item, 'store')) return { ok: false, reason: '倉庫空間不足' };
    item.loc = 'store';
    return { ok: true, msg: `「${item.name}」已放入倉庫` };
  }

  /** 交給隊員攜帶（需在避難所） */
  moveToBag(itemId, svId) {
    const item = this.getItem(itemId);
    const sv = this.game.survivors.get(svId);
    if (!item || !sv) return { ok: false, reason: '找不到目標' };
    if (!this.game.survivors.atShelter(sv)) return { ok: false, reason: '不在避難所' };
    if (this.isWorn(item)) return { ok: false, reason: '請先卸下裝備' };
    if (!this.fits(item, svId)) return { ok: false, reason: '背包格子或負重不足' };
    item.loc = svId;
    return { ok: true, msg: `${sv.name} 攜帶了「${item.name}」` };
  }

  /**
   * 加入物品並更新統計。倉庫放不下時，放進 members 的背包；都放不下則遺棄。
   * @returns {boolean} 是否成功放入
   */
  addItem(item, source = '', members = []) {
    const loc = this.placeFor(item, members);
    if (!loc) {
      this.game.log(`📦 倉庫與背包都沒有空間，${source}獲得的「${item.name}」被留下了`, 'danger');
      this.game.toast(`📦 空間不足，「${item.name}」被留下了（擴充倉庫或攜帶更大的背包）`, 'danger');
      return false;
    }
    item.loc = loc;
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
    return true;
  }

  equip(survivorId, itemId) {
    const sv = this.game.survivors.get(survivorId);
    const item = this.getItem(itemId);
    if (!sv || !item) return { ok: false, reason: '找不到目標' };
    if (sv.status === 'exploring') return { ok: false, reason: '探索中無法更換裝備' };
    const prevLoc = item.loc || 'store';
    const old = this.getItem(sv.equipment[item.slot]);
    const owners = [];
    // 從其他人身上卸下
    this.game.state.survivors.forEach((s) => {
      SLOT_KEYS.forEach((slot) => {
        if (s.equipment[slot] === itemId) {
          s.equipment[slot] = null;
          owners.push([s, slot]);
        }
      });
    });
    sv.equipment[item.slot] = itemId;
    // 換下來的裝備放回新裝備原本的位置；放不下就放倉庫或自己的背包
    if (old && old.id !== itemId) {
      const loc = this.fits(old, prevLoc) ? prevLoc : this.placeFor(old, [sv]);
      if (!loc) {
        sv.equipment[item.slot] = old.id;
        owners.forEach(([s, slot]) => { s.equipment[slot] = itemId; });
        return { ok: false, reason: '換下的裝備沒有地方放（倉庫與背包已滿）' };
      }
      old.loc = loc;
    }
    return { ok: true };
  }

  /** 卸下：放回倉庫，倉庫滿了放進自己的背包 */
  unequip(survivorId, slot) {
    const sv = this.game.survivors.get(survivorId);
    if (!sv) return { ok: false, reason: '找不到倖存者' };
    const item = this.getItem(sv.equipment[slot]);
    if (item) {
      sv.equipment[slot] = null;
      const loc = this.game.survivors.atShelter(sv) ? this.placeFor(item, [sv]) : (this.fits(item, sv.id) ? sv.id : null);
      if (!loc) {
        sv.equipment[slot] = item.id;
        return { ok: false, reason: '倉庫與背包都沒有空間' };
      }
      item.loc = loc;
    }
    return { ok: true };
  }

  equippedBy(itemId) {
    return this.game.state.survivors.find((s) => Object.values(s.equipment).includes(itemId)) || null;
  }

  sellValue(item) {
    return Math.round(RARITIES[item.rarity].sell * (1 + item.level * 0.08) * tierMul(item.tier || 1) * (1 + this.game.research.bonus('sellPct')));
  }

  dismantleValue(item) {
    const idx = RARITY_ORDER.indexOf(item.rarity);
    const mul = tierMul(item.tier || 1) * (1 + this.game.research.bonus('dismantlePct'));
    return { metal: Math.round((10 + item.level * 3) * mul), cloth: Math.round((4 + item.level) * mul), parts: [0, 0, 0, 1, 3, 8][idx] || 0 };
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

  /** 製作技術等級（研究） */
  craftTech() {
    return this.game.research.level('c_tech');
  }

  /** 製作出各品級的機率（0～1，UI 顯示用）：只受研究「製作技術」影響 */
  rarityOdds() {
    const t = craftRarityTable(this.craftTech());
    return Object.fromEntries(RARITY_ORDER.map((r) => [r, t[r] / 100]));
  }

  workbench() {
    return this.game.shelter.maxLevel('workbench');
  }

  /** 製作的裝備等級：簡易製作較低；工作台等級與研究「精工」提高 */
  craftLevel(modelId) {
    const md = modelId ? ITEM_MODELS[modelId] : null;
    const wb = this.workbench();
    const base = md?.simple ? Math.max(1, wb * 3) : Math.max(1, wb * 5);
    return base + Math.floor(this.game.research.bonus('craftLevelAdd'));
  }

  /** @returns {{ok:boolean, reason?:string}} */
  canCraftModel(modelId, withBlueprint = false) {
    const md = ITEM_MODELS[modelId];
    if (!md) return { ok: false, reason: '未知裝備' };
    const bench = benchFor(md);
    if (bench > 0 && this.workbench() < bench) return { ok: false, reason: this.workbench() < 1 ? '需要建造工作台' : `需要工作台 Lv${bench}` };
    const gun = ITEM_TYPES[md.type].gun;
    if (gun && !withBlueprint && this.game.research.level('c_gun') < gun) return { ok: false, reason: `需研究「槍械製造」Lv${gun}` };
    return { ok: true };
  }

  craftCost(modelId, withBlueprint = false) {
    const md = ITEM_MODELS[modelId];
    const t = 1 + (md.tier - 1) * 0.8;
    const mul = t * Math.max(0.4, 1 - this.game.research.bonus('craftCostReduce'));
    const isWeapon = ITEM_TYPES[md.type].slot === 'weapon';
    const isGun = !!ITEM_TYPES[md.type].gun && md.type !== 'crossbow';
    const base = isWeapon
      ? { metal: isGun ? 50 : 25, wood: 20, ...(isGun ? { fuel: 8 } : {}) }
      : { cloth: 30, metal: 12, wood: 8 };
    const cost = Object.fromEntries(Object.entries(base).map(([k, v]) => [k, Math.round(v * mul)]));
    const parts = Math.floor((md.tier - 3) / 2) + (withBlueprint ? 1 : 0);
    if (parts > 0) cost.parts = parts;
    return cost;
  }

  /** 製作（使用存檔種子：重新讀檔不會改變結果） */
  craft(modelId, blueprintId = null) {
    return withSeed(this.game.state.rng, 'craft', () => this.craftNow(modelId, blueprintId));
  }

  craftNow(modelId, blueprintId = null) {
    const md = ITEM_MODELS[modelId];
    if (!md) return { ok: false, reason: '未知裝備' };
    const bpList = this.game.state.inventory.blueprints;
    const bp = blueprintId ? bpList.find((b) => b.id === blueprintId) : null;
    if (blueprintId && !bp) return { ok: false, reason: '找不到設計圖' };
    if (bp && bp.model !== modelId) return { ok: false, reason: '設計圖型號不符' };
    const check = this.canCraftModel(modelId, !!bp);
    if (!check.ok) return check;
    if (!this.fits({ model: modelId, type: md.type }, 'store')) return { ok: false, reason: `倉庫空間不足（${this.storeUsed()}/${this.storeCap()} 格）` };
    const cost = this.craftCost(modelId, !!bp);
    if (!payCost(this.game.state, cost)) return { ok: false, reason: '資源不足' };
    if (bp) this.game.state.inventory.blueprints = bpList.filter((b) => b.id !== bp.id);
    // 品級：依製作技術的機率表；設計圖保底，並有機會再升一階
    let rarity = weightedPick(craftRarityTable(this.craftTech()));
    if (bp && rarityIndex(rarity) < rarityIndex(bp.rarity)) rarity = bp.rarity;
    if (bp && chance(this.game.research.bonus('craftBpBoost'))) rarity = RARITY_ORDER[Math.min(RARITY_ORDER.length - 1, rarityIndex(rarity) + 1)];
    const item = this.generate({
      level: this.craftLevel(modelId), model: modelId, rarity, qualityAdd: this.game.research.bonus('craftQualityAdd'),
    });
    this.addItem(item, '製作');
    this.game.state.stats.crafted += 1;
    return { ok: true, item, msg: `製作完成：${RARITIES[item.rarity].name}「${item.name}」` };
  }

  /** 生成設計圖（指定型號，保底精良以上） */
  makeBlueprint(level) {
    const type = pick(Object.keys(ITEM_TYPES));
    const rarity = level > 15 && chance(0.3) ? 'epic' : 'rare';
    return { id: uid('bp'), model: this.pickModel(type, level, 1), rarity };
  }

  canAffordCraft(modelId, bp) {
    return canAfford(this.game.state, this.craftCost(modelId, bp));
  }
}
