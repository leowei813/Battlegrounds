import {
  RARITIES, RARITY_ORDER, ITEM_TYPES, AFFIXES, RARITY_PREFIX, SLOT_KEYS, rarityIndex,
  ITEM_MODELS, tierMul, benchFor, craftRarityTable,
  BAG_BASE_SLOTS, STORE_BASE_SLOTS, STORE_SLOTS_PER_LEVEL, STACK_MAX, itemSize, itemWeight,
} from '../config/equipment.js';
import {
  withSeed,
  weightedPick, pick, randFloat, uid, clamp, chance,
} from '../utils/math.js';
import { canAfford, payCost, grant } from './costUtils.js';
import { SUPPLIES, AMMO_RECIPES } from '../config/supplies.js';

/** 防護裝備依強度使用的板材與布料（索引為型號強度 1～10） */
const PLATE = [null, null, null, 'ironWire', 'ironPlate', 'ironPlate', 'steelPlate', 'steelPlate', 'alloyPlate', 'alloyPlate', 'titanium'];
const FABRIC = [null, 'coarse', 'cotton', 'leather', 'techCotton', 'techCotton', 'ballistic', 'reinforced', 'reinforced', 'kevlar', 'kevlar'];
const FABRIC2 = [null, 'linen', 'linen', 'canvas', 'nylon', 'nylon', 'techCotton', 'ballistic', 'ballistic', 'reinforced', 'reinforced'];
const ELEC = [null, 'wire', 'wire', 'battery', 'battery', 'circuit', 'circuit', 'icBoard', 'sensor', 'chip', 'chip'];

/**
 * 製作配方：依裝備類別與強度消耗不同的零件與布料。
 * 例：一級甲（強度 4）= 鐵板 + 科技棉；二級甲（強度 7）= 鋼板 + 強化布料。
 */
export function craftRecipe(md) {
  const t = md.tier;
  const q = (n) => Math.max(1, Math.round(n * (1 + (t - 1) * 0.35)));
  const out = {};
  const add = (k, n) => { if (k && n > 0) out[k] = (out[k] || 0) + n; };
  const type = ITEM_TYPES[md.type];
  if (type.gun && md.type !== 'crossbow') {
    add('wood', q(6));
    add(t >= 4 ? 'barrel' : 'steelPipe', Math.ceil(t / 3));
    add(t >= 3 ? 'firingPin' : 'spring', Math.ceil(t / 4));
    add('spring', q(2));
    add('screw', q(4));
    if (t >= 6) add('steelPlate', Math.ceil(t / 3));
    if (t >= 8) add('precision', t - 7);
    if (md.type === 'lmg' || md.type === 'smg') add('gear', q(1));
  } else if (md.type === 'crossbow') {
    add('wood', q(12));
    add(t <= 2 ? 'linen' : 'nylon', q(1));
    add('spring', t >= 3 ? q(1) : 0);
    add(t >= 6 ? 'aluminum' : 'screw', q(2));
    if (t >= 8) add('precision', t - 7);
  } else if (md.type === 'melee') {
    if (md.fuel) { add('motor', 2); add('chain', 4); add('gear', 4); add('steelPlate', 3); }
    else {
      add('wood', q(4));
      add(t <= 2 ? 'scrap' : t <= 5 ? 'steelPipe' : t <= 7 ? 'steelPlate' : 'alloyPlate', Math.ceil(q(2) / (t <= 2 ? 1 : 2)));
      add('tape', q(1));
      if (t >= 3) add('leather', Math.ceil(t / 3));
    }
  } else if (['helmet', 'armor', 'legs'].includes(md.type)) {
    const k = md.type === 'armor' ? 1.5 : 1;
    add(PLATE[t], Math.ceil(q(1.5) * k / 2));
    add(FABRIC[t], Math.ceil(q(3) * k / 2));
    add(FABRIC2[t], Math.ceil(q(2) * k / 3));
    add(t <= 3 ? 'nail' : 'screw', q(2));
    if (t >= 9) add('precision', 1);
  } else if (md.type === 'gloves' || md.type === 'boots') {
    add(FABRIC[t], Math.ceil(q(2) / 2));
    add(t <= 2 ? 'cotton' : 'leather', q(1));
    if (md.type === 'boots') add('rubber', q(1));
    if (t >= 6) add(PLATE[t], Math.ceil(t / 4));
    if (t >= 10) add('hydraulic', 1);
  } else if (md.type === 'backpack') {
    add(t <= 2 ? 'coarse' : t <= 5 ? 'canvas' : 'nylon', q(3));
    add(FABRIC[t], Math.ceil(q(1) / 2));
    add('ironWire', q(1));
  } else {
    add(ELEC[t], q(1));
    add(t <= 3 ? 'ironWire' : 'plastic', q(1));
    add('cotton', q(1));
  }
  return out;
}

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

  /** 物品倉庫格子：初始 30，物品倉庫每升一級 +10，研究「物品倉儲」再增加 */
  storeCap() {
    const lv = this.game.shelter.primary()?.facilities.itemStore?.level || 1;
    return STORE_BASE_SLOTS + Math.max(0, lv - 1) * STORE_SLOTS_PER_LEVEL + Math.floor(this.game.research.bonus('storeSlots'));
  }

  storeItems() {
    return this.items.filter((i) => (i.loc || 'store') === 'store' && !this.isWorn(i));
  }

  /** 物品倉庫已用格數：每件裝備 1 格，每種材料物品每 999 個 1 格 */
  storeUsed() {
    return this.storeItems().reduce((s, i) => s + itemSize(i), 0) + this.supplySlots();
  }

  supplySlots(except = null) {
    return Object.entries(this.game.state.supplies || {})
      .reduce((s, [k, v]) => s + (k !== except && v > 0 ? Math.ceil(v / STACK_MAX) : 0), 0);
  }

  /** 物品倉庫還能放多少個某種材料物品 */
  supplyRoom(key) {
    const cur = this.game.state.supplies?.[key] || 0;
    const other = this.storeUsed() - Math.ceil(cur / STACK_MAX);
    return Math.max(0, (this.storeCap() - other) * STACK_MAX - cur);
  }

  /**
   * 把材料物品放進物品倉庫（受格子限制）。
   * @returns {Record<string, number>} 實際放入的數量
   */
  addSupplies(gains = {}) {
    const st = this.game.state;
    st.supplies = st.supplies || {};
    const out = {};
    Object.entries(gains).forEach(([k, v]) => {
      if (!SUPPLIES[k] || !(v > 0)) return;
      const n = Math.min(Math.floor(v), this.supplyRoom(k));
      if (n <= 0) return;
      st.supplies[k] = (st.supplies[k] || 0) + n;
      out[k] = n;
    });
    return out;
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
    const stacks = Object.values(sv.bag || {}).reduce((s, v) => s + (v > 0 ? Math.ceil(v / STACK_MAX) : 0), 0);
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
    // 拆解回收約三成的製作材料（至少 1 個），高品級另外回收稀有材料
    const recipe = craftRecipe(ITEM_MODELS[item.model] || { type: item.type, tier: item.tier || 1 });
    const gain = {};
    Object.entries(recipe).forEach(([k, v]) => {
      if (k === 'wood') return;
      const n = Math.max(1, Math.round(v * 0.3 * mul));
      gain[k] = n;
    });
    const parts = [0, 0, 0, 1, 3, 8][idx] || 0;
    if (parts) gain.parts = parts;
    return gain;
  }

  removeItem(itemId) {
    const item = this.getItem(itemId);
    if (!item) return { ok: false, reason: '找不到裝備' };
    if (item.locked) return { ok: false, reason: '裝備已上鎖' };
    if (this.equippedBy(itemId)) return { ok: false, reason: '請先卸下裝備' };
    this.game.state.inventory.items = this.items.filter((i) => i.id !== itemId);
    return { ok: true, item };
  }

  /** 丟棄倉庫裡的材料物品（指定數量，Infinity 為全部） */
  discardSupply(key, qty) {
    const sup = this.game.state.supplies || {};
    const have = sup[key] || 0;
    const n = Math.min(have, Math.max(0, Math.floor(qty === Infinity ? have : Number(qty) || 0)));
    if (n <= 0) return { ok: false, reason: have ? '請輸入要丟棄的數量' : '倉庫裡沒有這項物資' };
    sup[key] = have - n;
    if (sup[key] <= 0) delete sup[key];
    this.game.log(`🗑️ 丟棄 ${SUPPLIES[key]?.name || key} ×${n}`, 'info');
    return { ok: true, msg: `丟棄 ${SUPPLIES[key]?.name || key} ×${n}` };
  }

  /** 丟棄一件裝備（上鎖或穿戴中的不能丟） */
  discardItem(itemId) {
    const res = this.removeItem(itemId);
    if (!res.ok) return res;
    this.game.log(`🗑️ 丟棄「${res.item.name}」`, 'info');
    return { ok: true, msg: `丟棄「${res.item.name}」` };
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
    const got = this.game.grant(gain);
    const text = Object.entries(got).filter(([, v]) => v > 0).map(([k, v]) => `${SUPPLIES[k]?.name || '稀有材料'}×${v}`).join('、');
    return { ok: true, msg: `拆解獲得 ${text || '（倉庫已滿，沒有回收到材料）'}` };
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
    const mul = Math.max(0.4, 1 - this.game.research.bonus('craftCostReduce'));
    const cost = Object.fromEntries(Object.entries(craftRecipe(md)).map(([k, v]) => [k, Math.max(1, Math.round(v * mul))]));
    const parts = Math.floor((md.tier - 3) / 2) + (withBlueprint ? 1 : 0);
    if (parts > 0) cost.parts = parts;
    return cost;
  }

  /**
   * 製作出來的能力範圍（不分品級）：以可能做出的最低與最高品級素質計算每項基礎屬性的最小值與最大值。
   * 隨機詞綴不列入。
   * @returns {Record<string, [number, number]>}
   */
  craftStatRange(modelId, withBlueprint = null) {
    const md = ITEM_MODELS[modelId];
    const def = ITEM_TYPES[md.type];
    const lv = clamp(Math.round(this.craftLevel(modelId)), 1, 60);
    const table = craftRarityTable(this.craftTech());
    const possible = RARITY_ORDER.filter((r) => table[r] > 0 && (!withBlueprint || rarityIndex(r) >= rarityIndex(withBlueprint)));
    const lo = RARITIES[possible[0]];
    const hi = RARITIES[possible[possible.length - 1]];
    const q0 = clamp(this.game.research.bonus('craftQualityAdd'), 0, 0.9);
    const qMin = lo.min + (lo.max - lo.min) * q0;
    const qMax = hi.max;
    const tm = tierMul(md.tier);
    const round = (k, v) => (INT_STATS.has(k) ? Math.round(v) : +v.toFixed(3));
    const out = {};
    Object.entries(def.base).forEach(([k, v]) => {
      const grown = v + (def.perLevel[k] || 0) * (lv - 1);
      out[k] = grown > 0 ? [round(k, grown * tm * qMin), round(k, grown * tm * qMax)] : [round(k, grown), round(k, grown)];
    });
    Object.entries(md.extra || {}).forEach(([k, v]) => { out[k] = [Math.round(v * qMin), Math.round(v * qMax)]; });
    return out;
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

  // ---- 彈藥製作 ----

  /** @returns {{ok:boolean, reason?:string}} */
  canCraftAmmo(key) {
    const rc = AMMO_RECIPES[key];
    if (!rc) return { ok: false, reason: '無法製作' };
    if (rc.bench > 0 && this.workbench() < rc.bench) return { ok: false, reason: this.workbench() < 1 ? '需要建造工作台' : `需要工作台 Lv${rc.bench}` };
    if (rc.gun && this.game.research.level('c_gun') < rc.gun) return { ok: false, reason: `需研究「槍械製造」Lv${rc.gun}` };
    return { ok: true };
  }

  /** 製作彈藥或箭矢（一次一批） */
  craftAmmo(key) {
    const check = this.canCraftAmmo(key);
    if (!check.ok) return check;
    const rc = AMMO_RECIPES[key];
    if (this.supplyRoom(key) < rc.batch) return { ok: false, reason: `物品倉庫空間不足（${this.storeUsed()}/${this.storeCap()} 格）` };
    if (!payCost(this.game.state, rc.cost)) return { ok: false, reason: '材料不足' };
    this.addSupplies({ [key]: rc.batch });
    this.game.state.stats.ammoCrafted = (this.game.state.stats.ammoCrafted || 0) + 1;
    return { ok: true, msg: `製作完成：${SUPPLIES[key].name} ×${rc.batch}` };
  }

  canAffordCraft(modelId, bp) {
    return canAfford(this.game.state, this.craftCost(modelId, bp));
  }
}
