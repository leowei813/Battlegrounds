import {
  withOwnSeed, chance, pick, weightedPick, randFloat, randInt, uid,
} from '../utils/math.js';
import { SUPPLIES, SUPPLY_KEYS, AMMO_PRICE, AMMO_SELL_MUL } from '../config/supplies.js';
import {
  RARITIES, RARITY_ORDER, ITEM_TYPES, ITEM_MODELS, tierMul,
} from '../config/equipment.js';
import { sha256 } from '../utils/sha256.js';
import { RESOURCES } from '../config/constants.js';
import { exchangeValues, scarcity } from './MaterialBalance.js';
import { baseSupplyWeight } from './LootStock.js';
import { WorldEventSystem } from './WorldEventSystem.js';

/** 設計圖回收價：同型號、同保底品級裝備回收價的倍數 */
export const BLUEPRINT_PRICE_MUL = 1.5;
/** 副本圖紙的回收價（固定） */
export const BLUEPRINT_DUNGEON_PRICE = 5000;

/** 價格基準（沿用過去流浪商人的定價，回收價也以此計算） */
/** v15.11：黑市收購基礎物資（每個的價格），每種每天（台灣時間）最多收 dailyMax 個 */
export const RESOURCE_BUYBACK = { price: { food: 0.1, wood: 0.1, fuel: 0.15 }, dailyMax: 5000 };
const twDay = (t) => new Date(t + 8 * 3600000).toISOString().slice(0, 10);

export const TRADER = {
  /** 材料每個的基本價格（依階級 1～5） */
  supplyPrice: [0, 3, 8, 20, 50, 120],
  /** 裝備價格 = 出售價 × 倍率 */
  gearMarkup: 4,
  sellMul: 2,
  /** 材料、藥品、彈藥依階級（1～5）的售價倍率 */
  supplySellMul: [1, 2, 2.6, 3.6, 5, 7],
  /** 裝備依品級的售價倍率 */
  gearSellMul: {
    poor: 2, common: 2.5, uncommon: 3.5, rare: 5, epic: 7, legendary: 10,
  },
};

/**
 * 黑市「交換物資」：用倉庫裡的零件或布料換成想要的材料（同類別才能換）。
 * 價值點數依階級與材料需求與掉落配比表的稀缺度計算；黑市抽成：同價值 5 換 1，低一階換高一階再 ×2。
 * 只能用同階或低一階的材料交換，最高階（★5）不開放，不限制交換次數。
 */
export const EXCHANGE = {
  /** v13.3：同價值 5 換 1（原本 10 換 1） */
  rate: 5,
  crossMul: 2,
  maxTier: 4,
  /** 價值點數：依材料需求與掉落配比表（MaterialBalance）即時計算，新增研究或建築後會自動更新 */
  get value() {
    if (!exchangeCache) exchangeCache = exchangeValues(baseSupplyWeight, EXCHANGE.maxTier);
    return exchangeCache;
  },
};
let exchangeCache = null;

/**
 * 黑市：全體玩家共用的 20 格商品，每 30 分鐘全部一起換新（同一時間大家看到的商品相同）。
 * 有人買走後其他人就買不到（伺服器先到先得）；每位玩家每一輪最多買 BLACK_MARKET.perRound 件。價格比過去的流浪商人更高。
 */
export const BLACK_MARKET = {
  slots: 20,
  rotateMs: 30 * 60 * 1000,
  /** 每位玩家每一輪可以買幾件 */
  perRound: 1,
  /** 子彈類每格的基礎數量（再依階級與隨機調整） */
  ammoQty: 90,
  /** 裝備所占比例（其餘為消耗品：材料、藥品、彈藥） */
  gearShare: 0.15,
  /** 售價倍率（相對於過去流浪商人的價格） */
  priceMul: 1.6,
  /** 品級機率（%）；消耗品依品級對應 1～5 階 */
  rarity: {
    poor: 40, common: 28, uncommon: 16, rare: 8, epic: 2.5, legendary: 0.5,
  },
  /** 裝備等級範圍 */
  gearLevel: [3, 35],
};


/** 字串 → 32 位元種子 */
const seedOf = (str) => parseInt(sha256(str).slice(0, 8), 16) >>> 0;

export class BlackMarketSystem {
  constructor(game) {
    this.game = game;
    this.goodsCache = new Map();
    game.shared?.watch('bm', 1);
  }

  /** 目前的輪替序號 */
  tick(now = Date.now()) {
    return Math.floor(now / BLACK_MARKET.rotateMs);
  }

  /** 某一格目前的世代：每 10 分鐘全部一起換新，所以就是目前的輪替序號 */
  genOf(slot, now = Date.now()) {
    void slot;
    return this.tick(now);
  }

  /** 下一次全部換貨的時間 */
  nextRotate(now = Date.now()) {
    return { at: (this.tick(now) + 1) * BLACK_MARKET.rotateMs };
  }

  /** 這一輪自己買過的商品編號（每輪最多 perRound 件） */
  boughtIds(now = Date.now()) {
    const b = this.game.state.bmBought;
    if (!b || b.tick !== this.tick(now)) return [];
    return Array.isArray(b.ids) ? b.ids : b.id ? [b.id] : [];
  }

  /** 這一輪是否已經買滿 */
  boughtThisRound(now = Date.now()) {
    return this.boughtIds(now).length >= BLACK_MARKET.perRound;
  }

  /** 由（格子, 世代）決定性產生商品：所有玩家看到的完全相同 */
  good(slot, gen, now = Date.now()) {
    const id = `${slot}:${gen}`;
    let good = this.goodsCache.get(id);
    if (!good) {
      good = withOwnSeed(seedOf(`jdqs-bm:${id}`), () => this.makeGood(id, slot, gen));
      if (this.goodsCache.size > 200) this.goodsCache.clear();
      this.goodsCache.set(id, good);
    }
    // v15.18：黑市大促：售價 −20%
    const sale = WorldEventSystem.fx('bmSell', now);
    return sale === 1 ? good : { ...good, price: Math.max(1, Math.round(good.price * sale)), basePrice: good.price };
  }

  /** 隨機產生一項商品（種類、品級機率與價格：一般黑市與專屬保留區相同） */
  makeGood(id, slot, gen) {
    const g = this.game;
    const rarity = weightedPick(BLACK_MARKET.rarity);
    if (chance(BLACK_MARKET.gearShare)) {
      const item = g.equipment.generate({
        level: randInt(...BLACK_MARKET.gearLevel), type: pick(Object.keys(ITEM_TYPES).sort()), rarity,
      });
      item.id = `bm_${slot}_${gen}`;
      return { id, slot, gen, kind: 'gear', item, price: Math.round(this.gearPrice(item) * BLACK_MARKET.priceMul) };
    }
    const tier = Math.min(5, RARITY_ORDER.indexOf(rarity) + 1);
    const keys = SUPPLY_KEYS.filter((k) => SUPPLIES[k].tier === tier);
    // v13.3：比較缺的零件與布料比較常上架（依材料需求與掉落配比表）
    const sc = scarcity(baseSupplyWeight);
    const key = keys.length ? weightedPick(Object.fromEntries([...keys].sort().map((k) => [k, sc[k] ? Math.min(3, Math.max(0.5, sc[k])) : 1]))) : pick(SUPPLY_KEYS);
    const sp = SUPPLIES[key];
    // 子彈類一格的數量（v10.7.1 起 ×3，單價不變，總價跟著數量計算）
    const qty = Math.max(1, Math.round((sp.cat === 'ammo' ? BLACK_MARKET.ammoQty : sp.cat === 'med' ? 2 : 10) * ((6 - sp.tier) / 3) * randFloat(0.6, 1.4)));
    return {
      id, slot, gen, kind: 'supply', key, qty, rarity, price: Math.max(1, Math.round(this.supplyPrice(key) * qty * BLACK_MARKET.priceMul)),
    };
  }

  /** 已售出的商品（共用） */
  soldMap() {
    return this.game.shared.get('bm', 'sold')?.sold || {};
  }

  /** 目前架上的 20 格（含已售出標記） */
  shelf(now = Date.now()) {
    const sold = this.soldMap();
    return Array.from({ length: BLACK_MARKET.slots }, (_, slot) => {
      const gd = this.good(slot, this.genOf(slot, now), now);
      return { ...gd, soldTo: sold[gd.id] || null };
    });
  }

  /** 重新讀取共用的售出紀錄 */
  refresh() {
    return this.game.shared.list('bm', 1).catch(() => []);
  }

  /** 購買：先扣錢，伺服器確認是第一位買家才交貨，否則退錢 */
  async buy(goodId, now = Date.now()) {
    const g = this.game;
    const [slot, gen] = String(goodId).split(':').map(Number);
    if (!(slot >= 0 && slot < BLACK_MARKET.slots) || this.genOf(slot, now) !== gen) return { ok: false, reason: '這項商品已經下架了' };
    const good = this.good(slot, gen, now);
    if (this.soldMap()[good.id]) return { ok: false, reason: '已經被其他玩家買走了' };
    if (this.boughtThisRound(now)) return { ok: false, reason: `這一輪已經買了 ${BLACK_MARKET.perRound} 件，下次換貨後可以再買` };
    if (g.state.player.coins < good.price) return { ok: false, reason: `金錢不足（需要 💰${good.price}）` };
    if (good.kind === 'gear') {
      if (!g.equipment.fits(good.item, 'store')) return { ok: false, reason: '倉庫空間不足' };
    } else if (g.equipment.supplyRoom(good.key) < good.qty) return { ok: false, reason: '倉庫空間不足' };
    g.state.player.coins -= good.price;
    const minGen = this.tick(now) - 1;
    const r = await g.shared.update('bm', 'sold', (d) => {
      const data = d && typeof d === 'object' && d.sold ? d : { sold: {} };
      if (data.sold[good.id]) return { fail: '已經被其他玩家買走了' };
      // 清掉過期的紀錄（含換貨週期調整前留下、世代編號不在目前範圍內的紀錄）
      Object.keys(data.sold).forEach((k) => { const gn = Number(k.split(':')[1]); if (gn < minGen || gn > minGen + 2) delete data.sold[k]; });
      data.sold[good.id] = g.state.player.name || '倖存者';
      return { data };
    });
    if (!r.ok) {
      g.state.player.coins += good.price;
      g.bus.emit('trader:changed');
      return r;
    }
    g.state.bmBought = { tick: this.tick(now), ids: [...this.boughtIds(now), good.id] };
    if (good.kind === 'gear') g.equipment.addItem({ ...JSON.parse(JSON.stringify(good.item)), id: uid('it') }, '黑市');
    else g.equipment.addSupplies({ [good.key]: good.qty });
    const name = good.kind === 'gear' ? `「${good.item.name}」` : `${SUPPLIES[good.key].name} ×${good.qty}`;
    g.log(`🕶️ 在黑市買了${name}（💰${good.price}）`, 'loot');
    g.bus.emit('trader:changed');
    g.changed?.();
    return { ok: true, msg: `購買${name}` };
  }

  /** 基準價（回收價以此計算） */
  baseSupplyPrice(key) {
    const sp = SUPPLIES[key];
    if (sp.cat === 'med') return Math.round(15 + 300 * (sp.heal || 0.1) ** 1.6);
    if (sp.cat === 'ammo') return AMMO_PRICE[key] || 2;
    // v13.3：零件與布料依稀缺度調整（越缺越貴，限制在 ×0.7～×1.5）
    const sc = scarcity(baseSupplyWeight)[key];
    const f = sc ? Math.min(1.5, Math.max(0.7, Math.sqrt(sc))) : 1;
    return Math.round(TRADER.supplyPrice[sp.tier] * f * 10) / 10;
  }

  /** 商人的售價（基準價 × 售價倍率） */
  supplyPrice(key) {
    const tier = SUPPLIES[key]?.tier || 1;
    if (SUPPLIES[key]?.cat === 'ammo') return Math.max(1, Math.round(this.baseSupplyPrice(key) * AMMO_SELL_MUL));
    return Math.max(1, Math.round(this.baseSupplyPrice(key) * (TRADER.supplySellMul[tier] || TRADER.sellMul)));
  }

  baseGearPrice(item) {
    return RARITIES[item.rarity].sell * TRADER.gearMarkup * (1 + item.level * 0.08) * tierMul(item.tier || 1);
  }

  gearPrice(item) {
    return Math.round(this.baseGearPrice(item) * (TRADER.gearSellMul[item.rarity] || TRADER.sellMul));
  }

  /** 回收比例：約為販售價的 1/8，越稀有（階級越高）比例越好（1 階 10% → 5 階 15%） */
  buybackRate(key) {
    const tier = SUPPLIES[key]?.cat === 'ammo' ? 1 : SUPPLIES[key]?.tier || 1;
    return (0.8 + 0.1 * (tier - 1)) / 8;
  }

  /** 回收單價（可能有小數，成交時總價取整數）；研究「以物易物」提高回收價 */
  buybackUnit(key) {
    return this.baseSupplyPrice(key) * this.buybackRate(key) * (1 + this.game.research.bonus('sellPct')) * WorldEventSystem.fx('bmBuy'); // v15.18：黑市大促收購 +20%
  }

  /** 裝備回收價：約為商人賣價的 1/8，品級越高比例越好（劣質 10% → 傳奇 15%） */
  gearBuyback(item) {
    const idx = Math.max(0, RARITY_ORDER.indexOf(item.rarity));
    const rate = (0.8 + 0.08 * idx) / 8;
    return Math.max(1, Math.round(this.baseGearPrice(item) * rate * (1 + this.game.research.bonus('sellPct')) * WorldEventSystem.fx('bmBuy')));
  }

  /**
   * 設計圖回收價：一般設計圖為「同型號、同保底品級裝備」回收價的 1.5 倍（以該型號通常出現的等級估算）；
   * 副本圖紙固定 BLUEPRINT_DUNGEON_PRICE。研究「以物易物」提高回收價。
   */
  blueprintBuyback(bp) {
    const bonus = (1 + this.game.research.bonus('sellPct')) * WorldEventSystem.fx('bmBuy'); // v15.18：黑市大促收購 +20%
    if (bp?.dg) return Math.round(BLUEPRINT_DUNGEON_PRICE * bonus);
    const md = ITEM_MODELS[bp?.model];
    if (!md || !RARITIES[bp.rarity]) return 0;
    const level = Math.max(1, (md.tier - 1) * 5);
    const idx = Math.max(0, RARITY_ORDER.indexOf(bp.rarity));
    const base = RARITIES[bp.rarity].sell * TRADER.gearMarkup * (1 + level * 0.08) * tierMul(md.tier);
    return Math.max(1, Math.round(base * ((0.8 + 0.08 * idx) / 8) * BLUEPRINT_PRICE_MUL * bonus));
  }

  /** 把設計圖賣給黑市 */
  sellBlueprint(id) {
    const g = this.game;
    const bp = g.state.inventory.blueprints.find((b) => b.id === id);
    if (!bp) return { ok: false, reason: '找不到設計圖' };
    const price = this.blueprintBuyback(bp);
    if (price <= 0) return { ok: false, reason: '黑市不收這張設計圖' };
    const name = g.equipment.blueprintInfo(bp)?.name || bp.model;
    g.state.inventory.blueprints = g.state.inventory.blueprints.filter((b) => b.id !== id);
    g.state.player.coins += price;
    g.log(`🕶️ 把設計圖「${name}」賣到黑市（💰${price}）`, 'loot');
    return { ok: true, msg: `賣出設計圖「${name}」，得到 💰${price}` };
  }

  /** v15.15.1：一次出售多張設計圖（同型號、同保底品級合併的卡片「全部出售」） */
  sellBlueprints(ids) {
    const g = this.game;
    const want = new Set(ids);
    const list = g.state.inventory.blueprints.filter((b) => want.has(b.id) && this.blueprintBuyback(b) > 0);
    if (!list.length) return { ok: false, reason: '找不到設計圖' };
    const coins = list.reduce((t, b) => t + this.blueprintBuyback(b), 0);
    const sold = new Set(list.map((b) => b.id));
    g.state.inventory.blueprints = g.state.inventory.blueprints.filter((b) => !sold.has(b.id));
    g.state.player.coins += coins;
    const name = g.equipment.blueprintInfo(list[0])?.name || list[0].model;
    g.log(`🕶️ 把 ${list.length} 張設計圖「${name}」賣到黑市（💰${coins.toLocaleString()}）`, 'loot');
    return { ok: true, n: list.length, coins, msg: `賣出 ${list.length} 張設計圖「${name}」，得到 💰${coins.toLocaleString()}` };
  }

  /**
   * 設計圖自動出售設定：保底品級「r 以下」、星級「s 以下」（null＝不設定）。
   * 設定任一項就啟用；兩項都設定時符合其中一項就出售（或）
   * @returns {{r:string|null, s:number|null}}
   */
  bpAutoSell() {
    const a = this.game.state.bpAutoSell;
    const r = a && RARITY_ORDER.includes(a.r) ? a.r : null;
    const n = Math.floor(Number(a?.s));
    return { r, s: n >= 1 && n <= 5 ? n : null };
  }

  /** 設計圖的星級（與卡片上的 ★ 相同：強度每 2 階一顆星） */
  static bpStars(bp) {
    return Math.ceil((ITEM_MODELS[bp.model]?.tier || 1) / 2);
  }

  /**
   * 符合條件的設計圖（不含副本圖紙、交易所買來或撤回的）。
   * @param {{r:string|null, s:number|null}} cfg
   * @param {boolean} [onlyNew] 只算設定之後新拿到的（自動出售用；一鍵出售包含現有的）
   */
  bpAutoTargets(cfg = this.bpAutoSell(), onlyNew = false) {
    if (!cfg.r && !cfg.s) return [];
    const max = cfg.r ? RARITY_ORDER.indexOf(cfg.r) : -1;
    return this.game.state.inventory.blueprints.filter((b) => !b.dg && !b.keep && !(onlyNew && b.held) && RARITY_ORDER.includes(b.rarity)
      && ((cfg.r && RARITY_ORDER.indexOf(b.rarity) <= max) || (cfg.s && BlackMarketSystem.bpStars(b) <= cfg.s)) && this.blueprintBuyback(b) > 0);
  }

  /** 變更自動出售設定：不賣任何東西；現有的設計圖標記為「設定前就有」，之後只自動出售新拿到的 */
  setBpAutoSell(cfg) {
    const cur = this.bpAutoSell();
    const r = cfg.r === undefined ? cur.r : (RARITY_ORDER.includes(cfg.r) ? cfg.r : null);
    const n = cfg.s === undefined ? cur.s : Math.floor(Number(cfg.s));
    this.game.state.bpAutoSell = { r, s: n >= 1 && n <= 5 ? n : null };
    this.game.state.inventory.blueprints.forEach((b) => { b.held = true; });
    return { ok: true };
  }

  /** 一鍵出售：依目前的品級＋星級條件，把現有符合的設計圖一起賣掉 */
  sellBpByRule() {
    const list = this.bpAutoTargets(this.bpAutoSell(), false);
    if (!list.length) return { ok: false, reason: '沒有符合條件的設計圖' };
    return this.sellBlueprints(list.map((b) => b.id));
  }

  /** 把符合自動出售設定的設計圖賣到黑市（每秒檢查；有賣出才記錄） */
  autoSellBlueprints() {
    const g = this.game;
    const list = this.bpAutoTargets(this.bpAutoSell(), true);
    if (!list.length) return { ok: true, n: 0, coins: 0 };
    let coins = 0;
    list.forEach((b) => { coins += this.blueprintBuyback(b); });
    const ids = new Set(list.map((b) => b.id));
    g.state.inventory.blueprints = g.state.inventory.blueprints.filter((b) => !ids.has(b.id));
    g.state.player.coins += coins;
    const msg = `🕶️ 自動出售 ${list.length} 張設計圖（💰${coins.toLocaleString()}）`;
    g.log(msg, 'loot');
    return { ok: true, n: list.length, coins, msg };
  }

  /** 把倉庫裡的裝備賣到黑市（上鎖、穿戴中的不能賣） */
  sellItem(itemId) {
    const g = this.game;
    const item = g.equipment.getItem(itemId);
    if (!item) return { ok: false, reason: '找不到裝備' };
    const price = this.gearBuyback(item);
    const res = g.equipment.removeItem(itemId);
    if (!res.ok) return res;
    g.state.player.coins += price;
    g.log(`🕶️ 賣到黑市「${item.name}」（💰${price}）`, 'loot');
    return { ok: true, msg: `賣出「${item.name}」，得到 💰${price}` };
  }

  /** 一鍵賣出倉庫裡未上鎖的劣質／一般裝備 */
  sellCommonGear() {
    const g = this.game;
    const list = g.equipment.storeItems().filter((i) => (i.rarity === 'poor' || i.rarity === 'common') && !i.locked);
    let coins = 0;
    list.forEach((i) => { const r = this.sellItem(i.id); if (r.ok) coins += this.gearBuyback(i); });
    return list.length ? { ok: true, msg: `賣出 ${list.length} 件裝備，得到 💰${coins}` } : { ok: false, reason: '倉庫沒有可賣的劣質／一般裝備' };
  }

  /** 回收總價 */
  buybackPrice(key, qty) {
    return Math.floor(this.buybackUnit(key) * qty);
  }

  /** 把倉庫裡的材料物品賣到黑市 */
  sell(key, qty) {
    const g = this.game;
    if (!SUPPLIES[key]) return { ok: false, reason: '黑市不收這種東西' };
    const have = g.state.supplies?.[key] || 0;
    const n = Math.min(have, Math.max(0, Math.floor(qty)));
    if (n <= 0) return { ok: false, reason: '倉庫裡沒有這項物資' };
    const price = this.buybackPrice(key, n);
    if (price <= 0) return { ok: false, reason: '數量太少，黑市不收（多賣一些才值錢）' };
    g.state.supplies[key] = have - n;
    if (g.state.supplies[key] <= 0) delete g.state.supplies[key];
    g.state.player.coins += price;
    g.log(`🕶️ 賣到黑市 ${SUPPLIES[key].name} ×${n}（💰${price}）`, 'loot');
    return { ok: true, msg: `賣出 ${SUPPLIES[key].name} ×${n}，得到 💰${price}` };
  }

  /** v15.11：今天（台灣時間）這種基礎物資還能賣幾個 */
  resourceLeft(key, now = Date.now()) {
    const st = this.game.state;
    const day = twDay(now);
    if (st.bmResSold?.day !== day) st.bmResSold = { day };
    return Math.max(0, RESOURCE_BUYBACK.dailyMax - (st.bmResSold[key] || 0));
  }

  /** 基礎物資賣出總價（研究「以物易物」提高回收價） */
  resourcePrice(key, qty) {
    return Math.floor((RESOURCE_BUYBACK.price[key] || 0) * qty * (1 + this.game.research.bonus('sellPct')) * WorldEventSystem.fx('bmBuy'));
  }

  /** v15.11：把基礎物資（食物、木材、燃料）賣到黑市 */
  sellResource(key, qty, now = Date.now()) {
    const g = this.game;
    if (!RESOURCE_BUYBACK.price[key]) return { ok: false, reason: '黑市不收這種東西' };
    const have = Math.floor(g.state.resources[key] || 0);
    const left = this.resourceLeft(key, now);
    const n = Math.min(have, left, Math.max(0, Math.floor(qty)));
    if (left <= 0) return { ok: false, reason: `今天的${RESOURCES[key].name}已經收滿 ${RESOURCE_BUYBACK.dailyMax.toLocaleString()} 個，明天再來` };
    if (n <= 0) return { ok: false, reason: `倉庫裡沒有${RESOURCES[key].name}` };
    const price = this.resourcePrice(key, n);
    if (price <= 0) return { ok: false, reason: '數量太少，黑市不收（多賣一些才值錢）' };
    g.state.resources[key] -= n;
    g.state.bmResSold[key] = (g.state.bmResSold[key] || 0) + n;
    g.state.player.coins += price;
    g.log(`🕶️ 賣到黑市 ${RESOURCES[key].name} ×${n.toLocaleString()}（💰${price}）`, 'loot');
    return { ok: true, msg: `賣出 ${RESOURCES[key].name} ×${n.toLocaleString()}，得到 💰${price}` };
  }

  /** v15.11：目前的交換倍率（研究「黑市人脈」每級 −3%，Lv10 為 3.5 換 1） */
  exchangeRate() {
    return EXCHANGE.rate * (1 - Math.min(0.5, this.game.research.bonus('exchangeRateReduce')));
  }

  /** 可以拿來交換（換入或換出）的材料 */
  exchangeable(key) {
    const sp = SUPPLIES[key];
    return !!(sp && ['part', 'fabric'].includes(sp.cat) && sp.tier <= EXCHANGE.maxTier && EXCHANGE.value[key]);
  }

  /** 想換到 want 時，可以拿來換的材料（同類別、同階或低一階） */
  exchangeSources(want) {
    const w = SUPPLIES[want];
    if (!this.exchangeable(want)) return [];
    return Object.keys(EXCHANGE.value).filter((k) => k !== want && this.exchangeable(k)
      && SUPPLIES[k].cat === w.cat && (SUPPLIES[k].tier === w.tier || SUPPLIES[k].tier === w.tier - 1));
  }

  /** 換到 1 個 want 需要幾個 give（可能不是整數） */
  exchangeCostPer(give, want) {
    const cross = SUPPLIES[give].tier < SUPPLIES[want].tier ? EXCHANGE.crossMul : 1;
    return (EXCHANGE.value[want] / EXCHANGE.value[give]) * this.exchangeRate() * cross;
  }

  /**
   * 試算：拿 qty 個 give 能換到幾個 want、實際只會用掉幾個（不到 1 個的部分不換）。
   * @returns {{ok:boolean, reason?:string, get?:number, used?:number, per?:number}}
   */
  exchangeQuote(give, want, qty) {
    if (!this.exchangeable(want) || !this.exchangeable(give)) return { ok: false, reason: '黑市不交換這種材料' };
    if (!this.exchangeSources(want).includes(give)) return { ok: false, reason: '只能用同類別、同階或低一階的材料交換' };
    const per = this.exchangeCostPer(give, want);
    const have = this.game.state.supplies?.[give] || 0;
    const n = Math.min(have, Math.max(0, Math.floor(qty)));
    const get = Math.floor(n / per + 1e-9);
    const used = get > 0 ? Math.min(n, Math.ceil(get * per - 1e-9)) : 0;
    return { ok: get > 0, reason: get > 0 ? undefined : `至少要 ${Math.ceil(per - 1e-9)} 個${SUPPLIES[give].name}才能換到 1 個`, get, used, per };
  }

  /** 交換：扣掉 give，加入 want（倉庫放不下時取消並退回） */
  exchange(give, want, qty) {
    const g = this.game;
    const q = this.exchangeQuote(give, want, qty);
    if (!q.ok) return q;
    const st = g.state;
    st.supplies[give] -= q.used;
    if (st.supplies[give] <= 0) delete st.supplies[give];
    const added = g.equipment.addSupplies({ [want]: q.get })[want] || 0;
    if (added < q.get) {
      // 倉庫放不下：退回這次交換
      if (added) { st.supplies[want] -= added; if (st.supplies[want] <= 0) delete st.supplies[want]; }
      st.supplies[give] = (st.supplies[give] || 0) + q.used;
      return { ok: false, reason: '倉庫空間不足，放不下換到的材料' };
    }
    st.stats.bmExchanges = (st.stats.bmExchanges || 0) + 1;
    g.log(`🕶️ 黑市交換：${SUPPLIES[give].name} ×${q.used} → ${SUPPLIES[want].name} ×${q.get}`, 'loot');
    return { ok: true, msg: `用 ${SUPPLIES[give].name} ×${q.used} 換到 ${SUPPLIES[want].name} ×${q.get}` };
  }
}
