import {
  withSeed, chance, pick, uid, weightedPick, haversine, offsetLatLon, randFloat,
} from '../utils/math.js';
import { SUPPLIES, SUPPLY_KEYS, medWeight } from '../config/supplies.js';
import {
  RARITIES, RARITY_ORDER, ITEM_TYPES, tierMul,
} from '../config/equipment.js';
import { DAY_REAL_MS } from '../config/constants.js';

/**
 * 流浪商人：遊戲時間每天 11:00 有機率出現在避難所附近，待到 15:00 離開。
 * 身上有 10 項隨機物品（材料與裝備），用金錢購買；越稀有價格越貴。
 */
export const TRADER = {
  openHour: 11,
  closeHour: 15,
  chance: 0.6, // 每天出現的機率
  goods: 10,
  radiusM: [250, 900], // 出現在避難所周圍的距離
  /** 材料每個的基本價格（依階級 1～5） */
  supplyPrice: [0, 3, 8, 20, 50, 120],
  /** 裝備價格 = 出售價 × 倍率 */
  gearMarkup: 4,
  /** 出現的裝備品級權重（越高越少見） */
  gearRarity: {
    poor: 18, common: 34, uncommon: 28, rare: 14, epic: 5, legendary: 1,
  },
};

export class TraderSystem {
  constructor(game) {
    this.game = game;
  }

  get state() {
    return this.game.state.trader || null;
  }

  /** 今天商人離開的現實時間 */
  leaveAt(now = Date.now()) {
    const h = this.game.time.hour(now);
    return now + ((TRADER.closeHour - h) / 24) * DAY_REAL_MS;
  }

  /** 商人是否在場 */
  isHere(now = Date.now()) {
    const t = this.state;
    return !!(t?.active && now < t.until && t.day === this.game.time.day(now));
  }

  /** 每秒檢查：11:00 時決定今天是否出現（使用存檔種子，重新讀檔結果不變） */
  update(now = Date.now()) {
    const g = this.game;
    const sh = g.shelter.primary();
    if (!sh) return;
    const day = g.time.day(now);
    const h = g.time.hour(now);
    const t = this.state;
    if (t?.day === day) {
      if (t.active && now >= t.until && !t.leftNotified) {
        t.leftNotified = true;
        g.log('🧳 流浪商人離開了', 'info');
        g.bus.emit('trader:changed');
      }
      return;
    }
    if (h < TRADER.openHour || h >= TRADER.closeHour) return;
    withSeed(g.state.rng, 'trader', () => {
      if (!chance(TRADER.chance)) {
        g.state.trader = { day, active: false };
        return;
      }
      const dist = randFloat(...TRADER.radiusM);
      const pos = offsetLatLon(sh.lat, sh.lon, dist, randFloat(0, Math.PI * 2));
      g.state.trader = {
        day, active: true, lat: pos.lat, lon: pos.lon, until: this.leaveAt(now), stock: this.makeStock(),
      };
    });
    if (g.state.trader.active) {
      g.log('🧳 流浪商人出現在附近！帶著 10 項物品，下午 3 點前離開（到地圖點選商人交易）', 'loot');
      g.toast('🧳 流浪商人出現了！到地圖點選商人交易', 'success');
      g.bus.emit('trader:changed');
    }
  }

  /** 隨機 10 項商品：材料（數量與價格依階級）與裝備（價格依品級與強度） */
  makeStock() {
    const g = this.game;
    const level = (g.survivors.leader()?.level || 1) + 2;
    const supplyW = Object.fromEntries(SUPPLY_KEYS.map((k) => {
      const sp = SUPPLIES[k];
      return [k, sp.cat === 'med' ? medWeight(k) / 2 : 6 * 0.5 ** (sp.tier - 1)];
    }));
    const out = [];
    const used = new Set();
    while (out.length < TRADER.goods) {
      if (chance(0.35)) {
        const item = g.equipment.generate({ level, type: pick(Object.keys(ITEM_TYPES)), rarity: weightedPick(TRADER.gearRarity) });
        out.push({ id: uid('tg'), kind: 'gear', item, price: this.gearPrice(item) });
      } else {
        const key = weightedPick(supplyW);
        if (used.has(key)) continue;
        used.add(key);
        const sp = SUPPLIES[key];
        const qty = Math.max(1, Math.round((sp.cat === 'ammo' ? 30 : sp.cat === 'med' ? 2 : 10) * (6 - sp.tier) / 3 * randFloat(0.6, 1.4)));
        out.push({ id: uid('tg'), kind: 'supply', key, qty, price: this.supplyPrice(key) * qty });
      }
    }
    return out;
  }

  supplyPrice(key) {
    const sp = SUPPLIES[key];
    if (sp.cat === 'med') return Math.round(15 + 300 * (sp.heal || 0.1) ** 1.6);
    if (sp.cat === 'ammo') return Math.max(1, Math.round(TRADER.supplyPrice[sp.tier] / 3));
    return TRADER.supplyPrice[sp.tier];
  }

  gearPrice(item) {
    return Math.round(RARITIES[item.rarity].sell * TRADER.gearMarkup * (1 + item.level * 0.08) * tierMul(item.tier || 1));
  }

  /** 回收比例：約為販售價的 1/8，越稀有（階級越高）比例越好（1 階 10% → 5 階 15%） */
  buybackRate(key) {
    const tier = SUPPLIES[key]?.tier || 1;
    return (0.8 + 0.1 * (tier - 1)) / 8;
  }

  /** 回收單價（可能有小數，成交時總價取整數）；研究「以物易物」提高回收價 */
  buybackUnit(key) {
    return this.supplyPrice(key) * this.buybackRate(key) * (1 + this.game.research.bonus('sellPct'));
  }

  /** 裝備回收價：約為商人賣價的 1/8，品級越高比例越好（劣質 10% → 稀有 15%） */
  gearBuyback(item) {
    const idx = Math.max(0, RARITY_ORDER.indexOf(item.rarity));
    const rate = (0.8 + 0.08 * idx) / 8;
    return Math.max(1, Math.round(this.gearPrice(item) * rate * (1 + this.game.research.bonus('sellPct'))));
  }

  /** 把倉庫裡的裝備賣給商人（上鎖、穿戴中的不能賣） */
  sellItem(itemId) {
    const g = this.game;
    if (!this.isHere()) return { ok: false, reason: '流浪商人已經離開了' };
    const item = g.equipment.getItem(itemId);
    if (!item) return { ok: false, reason: '找不到裝備' };
    const price = this.gearBuyback(item);
    const res = g.equipment.removeItem(itemId);
    if (!res.ok) return res;
    g.state.player.coins += price;
    g.log(`🧳 賣給流浪商人「${item.name}」（💰${price}）`, 'loot');
    return { ok: true, msg: `賣出「${item.name}」，得到 💰${price}` };
  }

  /** 一鍵賣出倉庫裡未上鎖的劣質／一般裝備 */
  sellCommonGear() {
    const g = this.game;
    if (!this.isHere()) return { ok: false, reason: '流浪商人已經離開了' };
    const list = g.equipment.storeItems().filter((i) => (i.rarity === 'poor' || i.rarity === 'common') && !i.locked);
    let coins = 0;
    list.forEach((i) => { const r = this.sellItem(i.id); if (r.ok) coins += this.gearBuyback(i); });
    return list.length ? { ok: true, msg: `賣出 ${list.length} 件裝備，得到 💰${coins}` } : { ok: false, reason: '倉庫沒有可賣的劣質／一般裝備' };
  }

  /** 回收總價 */
  buybackPrice(key, qty) {
    return Math.floor(this.buybackUnit(key) * qty);
  }

  /** 把倉庫裡的材料物品賣給商人 */
  sell(key, qty) {
    const g = this.game;
    if (!this.isHere()) return { ok: false, reason: '流浪商人已經離開了' };
    if (!SUPPLIES[key]) return { ok: false, reason: '商人不收這種東西' };
    const have = g.state.supplies?.[key] || 0;
    const n = Math.min(have, Math.max(0, Math.floor(qty)));
    if (n <= 0) return { ok: false, reason: '倉庫裡沒有這項物資' };
    const price = this.buybackPrice(key, n);
    if (price <= 0) return { ok: false, reason: '數量太少，商人不收（多賣一些才值錢）' };
    g.state.supplies[key] = have - n;
    if (g.state.supplies[key] <= 0) delete g.state.supplies[key];
    g.state.player.coins += price;
    g.log(`🧳 賣給流浪商人 ${SUPPLIES[key].name} ×${n}（💰${price}）`, 'loot');
    return { ok: true, msg: `賣出 ${SUPPLIES[key].name} ×${n}，得到 💰${price}` };
  }

  /** 購買一項商品 */
  buy(goodId) {
    const g = this.game;
    if (!this.isHere()) return { ok: false, reason: '流浪商人已經離開了' };
    const t = this.state;
    const good = t.stock.find((x) => x.id === goodId);
    if (!good) return { ok: false, reason: '這項商品已經賣完了' };
    if (g.state.player.coins < good.price) return { ok: false, reason: `金錢不足（需要 💰${good.price}）` };
    if (good.kind === 'gear') {
      if (!g.equipment.fits(good.item, 'store')) return { ok: false, reason: '物品倉庫空間不足' };
    } else if (g.equipment.supplyRoom(good.key) < good.qty) return { ok: false, reason: '物品倉庫空間不足' };
    g.state.player.coins -= good.price;
    t.stock = t.stock.filter((x) => x.id !== goodId);
    if (good.kind === 'gear') g.equipment.addItem(good.item, '流浪商人');
    else g.equipment.addSupplies({ [good.key]: good.qty });
    const name = good.kind === 'gear' ? `「${good.item.name}」` : `${SUPPLIES[good.key].name} ×${good.qty}`;
    g.log(`🧳 向流浪商人買了${name}（💰${good.price}）`, 'loot');
    return { ok: true, msg: `購買${name}` };
  }

  /** 商人與避難所的距離（公尺） */
  distance() {
    const sh = this.game.shelter.primary();
    const t = this.state;
    return sh && t?.active ? Math.round(haversine(sh.lat, sh.lon, t.lat, t.lon)) : null;
  }

  /** 剩餘停留時間（毫秒） */
  remainingMs(now = Date.now()) {
    return this.isHere(now) ? this.state.until - now : 0;
  }
}
