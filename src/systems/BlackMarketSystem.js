import {
  withOwnSeed, chance, pick, weightedPick, randFloat, randInt, uid,
} from '../utils/math.js';
import { SUPPLIES, SUPPLY_KEYS, AMMO_PRICE, AMMO_SELL_MUL } from '../config/supplies.js';
import {
  RARITIES, RARITY_ORDER, ITEM_TYPES, tierMul,
} from '../config/equipment.js';
import { sha256 } from '../utils/sha256.js';

/** 價格基準（沿用過去流浪商人的定價，回收價也以此計算） */
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
 * 黑市：全體玩家共用的 20 格商品，每 10 分鐘全部一起換新（同一時間大家看到的商品相同）。
 * 有人買走後其他人就買不到（伺服器先到先得）；每位玩家每一輪只能買 1 件。價格比過去的流浪商人更高。
 */
export const BLACK_MARKET = {
  slots: 20,
  rotateMs: 10 * 60 * 1000,
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

  /** 這一輪自己買過的商品編號（每輪只能買 1 件）；沒買過回傳 null */
  boughtThisRound(now = Date.now()) {
    const b = this.game.state.bmBought;
    return b && b.tick === this.tick(now) ? b.id : null;
  }

  /** 由（格子, 世代）決定性產生商品：所有玩家看到的完全相同 */
  good(slot, gen) {
    const id = `${slot}:${gen}`;
    if (this.goodsCache.has(id)) return this.goodsCache.get(id);
    const good = withOwnSeed(seedOf(`jdqs-bm:${id}`), () => this.makeGood(id, slot, gen));
    if (this.goodsCache.size > 200) this.goodsCache.clear();
    this.goodsCache.set(id, good);
    return good;
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
    const key = pick(keys.length ? keys : SUPPLY_KEYS);
    const sp = SUPPLIES[key];
    const qty = Math.max(1, Math.round((sp.cat === 'ammo' ? 30 : sp.cat === 'med' ? 2 : 10) * ((6 - sp.tier) / 3) * randFloat(0.6, 1.4)));
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
      const gd = this.good(slot, this.genOf(slot, now));
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
    const good = this.good(slot, gen);
    if (this.soldMap()[good.id]) return { ok: false, reason: '已經被其他玩家買走了' };
    if (this.boughtThisRound(now)) return { ok: false, reason: '這一輪已經買過 1 件了，下次換貨後可以再買' };
    if (g.state.player.coins < good.price) return { ok: false, reason: `金錢不足（需要 💰${good.price}）` };
    if (good.kind === 'gear') {
      if (!g.equipment.fits(good.item, 'store')) return { ok: false, reason: '倉庫空間不足' };
    } else if (g.equipment.supplyRoom(good.key) < good.qty) return { ok: false, reason: '倉庫空間不足' };
    g.state.player.coins -= good.price;
    const minGen = this.tick(now) - 1;
    const r = await g.shared.update('bm', 'sold', (d) => {
      const data = d && typeof d === 'object' && d.sold ? d : { sold: {} };
      if (data.sold[good.id]) return { fail: '已經被其他玩家買走了' };
      Object.keys(data.sold).forEach((k) => { if (Number(k.split(':')[1]) < minGen) delete data.sold[k]; });
      data.sold[good.id] = g.state.player.name || '倖存者';
      return { data };
    });
    if (!r.ok) {
      g.state.player.coins += good.price;
      g.bus.emit('trader:changed');
      return r;
    }
    g.state.bmBought = { tick: this.tick(now), id: good.id };
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
    return TRADER.supplyPrice[sp.tier];
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
    return this.baseSupplyPrice(key) * this.buybackRate(key) * (1 + this.game.research.bonus('sellPct'));
  }

  /** 裝備回收價：約為商人賣價的 1/8，品級越高比例越好（劣質 10% → 傳奇 15%） */
  gearBuyback(item) {
    const idx = Math.max(0, RARITY_ORDER.indexOf(item.rarity));
    const rate = (0.8 + 0.08 * idx) / 8;
    return Math.max(1, Math.round(this.baseGearPrice(item) * rate * (1 + this.game.research.bonus('sellPct'))));
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
}
