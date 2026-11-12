import { RESOURCE_KEYS } from '../config/constants.js';
import { SUPPLIES, isSupply } from '../config/supplies.js';
import { LOOT_CATS } from '../config/poiTypes.js';
import { uid } from '../utils/math.js';
import { OBJ_KEEP_MS } from '../multiplayer/SharedWorld.js';
import { DG_CORES, isDgCore } from '../config/dungeons.js';

/** 交易市場查詢範圍（公里） */
export const MARKET_KM = 20;
/** 刊登有效時間：到期自動下架並退還 */
export const LISTING_MS = 3 * 24 * 3600 * 1000;
/** 單筆刊登的數量與單價上限 */
export const MAX_LISTING_QTY = 9999;
export const MAX_LISTING_PRICE = 1000000;

export const goodName = (k) => SUPPLIES[k]?.name || DG_CORES[k]?.name || LOOT_CATS[k]?.name || k;
export const goodIcon = (k) => SUPPLIES[k]?.icon || DG_CORES[k]?.icon || LOOT_CATS[k]?.icon || '📦';
/** 可以交易的東西：基礎物資、材料、副本核心材料 */
export const isGood = (k) => RESOURCE_KEYS.includes(k) || isSupply(k) || isDgCore(k);

/** 裝備／設計圖刊登的名稱（材料刊登回傳空字串） */
export const listingName = (d) => (d?.bp ? `📜「${d.bpName || '設計圖'}」` : d?.item ? `「${d.item.name}」` : '');

const int = (v, min, max) => Math.min(max, Math.max(min, Math.floor(Number(v) || 0)));

/**
 * 交易市場（交易所設施）：刊登賣單或收購單，其他玩家即時成交。
 *  - 刊登時物品（賣單）或金錢（收購單）先保管在市場上。
 *  - 成交以伺服器「先到先得」更新，兩人同時購買不會超賣。
 *  - 對方不在線上也能成交；刊登者下次上線時自動收到貨款或物品。
 *  - 交易所 Lv1 可同時刊登賣單 2 筆、收購 2 筆，每升一級各 +1。
 */
export class MarketSystem {
  constructor(game) {
    this.game = game;
    this.settledAt = 0;
    this.busy = false;
    game.shared?.watch('mk', MARKET_KM);
  }

  get state() {
    const st = this.game.state;
    st.market = st.market || { mine: {} };
    st.market.mine = st.market.mine || {};
    return st.market;
  }

  myId() {
    try {
      return this.game.shared.store().me;
    } catch {
      return 'local';
    }
  }

  level() {
    return this.game.shelter.maxLevel('exchange');
  }

  /** 每一邊可同時刊登的筆數 */
  limit() {
    const lv = this.level();
    return lv > 0 ? lv + 1 : 0;
  }

  /** 自己的刊登（本機紀錄） */
  mine() {
    return Object.entries(this.state.mine).map(([id, m]) => ({ id, ...m, live: this.game.shared.get('mk', id) }));
  }

  openCount(side) {
    return this.mine().filter((m) => m.side === side && !m.closed && (!m.live || m.live.status === 'open')).length;
  }

  /** 市場上的有效刊登（所有玩家，含自己的；自己的標 mine） */
  listings(now = Date.now()) {
    const me = this.myId();
    return this.game.shared.all('mk').map((o) => ({ id: o.id, ...o.data, mine: o.data?.owner === me }))
      .filter((d) => d && d.status === 'open' && d.qty > d.filled && now < (d.at || 0) + LISTING_MS
        && (d.item || (d.bp && typeof d.bp.model === 'string') || isGood(d.key)))
      .sort((a, b) => (b.mine ? 1 : 0) - (a.mine ? 1 : 0) || (a.key || a.item?.name || a.bpName || '').localeCompare(b.key || b.item?.name || b.bpName || '') || a.price - b.price || a.at - b.at);
  }

  refresh() {
    return this.game.shared.list('mk', MARKET_KM).then(() => this.settle()).catch(() => {});
  }

  /** 從倉庫取出物品（資源或材料） */
  take(key, n) {
    const st = this.game.state;
    const pool = this.poolOf(key);
    if ((pool[key] || 0) < n) return false;
    pool[key] -= n;
    if (pool !== st.resources && pool[key] <= 0) delete pool[key];
    return true;
  }

  /** 放入倉庫（保管中的東西退回時不受空間限制，避免消失） */
  give(key, n) {
    const st = this.game.state;
    if (n <= 0) return;
    const pool = this.poolOf(key);
    pool[key] = (pool[key] || 0) + n;
  }

  /** 物品存放處：資源、副本核心材料（不佔倉庫格子）、材料 */
  poolOf(key) {
    const st = this.game.state;
    if (RESOURCE_KEYS.includes(key)) return st.resources;
    if (isDgCore(key)) return (st.dgCores = st.dgCores || {});
    return (st.supplies = st.supplies || {});
  }

  /** 買進的物品要有空間 */
  room(key) {
    const g = this.game;
    if (isDgCore(key)) return MAX_LISTING_QTY;
    if (RESOURCE_KEYS.includes(key)) return Math.max(0, g.resources.storageCap() - Math.floor(g.state.resources[key] || 0));
    return g.equipment.supplyRoom(key);
  }

  /**
   * 刊登。賣單：{ side:'sell', key, qty, price } 或 { side:'sell', itemId, price }；收購：{ side:'buy', key, qty, price }。
   * price 為單價（裝備為總價）。
   */
  async post({
    side, key, itemId, bpId, qty, price,
  }) {
    const g = this.game;
    const sh = g.shelter.primary();
    if (!sh) return { ok: false, reason: '需要先有避難所' };
    if (this.level() < 1) return { ok: false, reason: '需要先建造🏪交易所' };
    if (side !== 'sell' && side !== 'buy') return { ok: false, reason: '請選擇賣出或收購' };
    if (this.openCount(side) >= this.limit()) return { ok: false, reason: `${side === 'sell' ? '賣單' : '收購'}已達上限（${this.limit()} 筆），升級交易所可增加` };
    const p = int(price, 0, MAX_LISTING_PRICE);
    let data;
    let undo;
    if (side === 'sell' && bpId) {
      const list = g.state.inventory.blueprints;
      const bp = list.find((b) => b.id === bpId);
      const info = g.equipment.blueprintInfo(bp);
      if (!bp || !info) return { ok: false, reason: '找不到設計圖' };
      if (p <= 0) return { ok: false, reason: '請輸入價格' };
      const copy = { ...bp };
      g.state.inventory.blueprints = list.filter((b) => b.id !== bpId);
      undo = () => { g.state.inventory.blueprints.push({ ...copy, keep: true }); };
      data = { bp: copy, bpName: info.name, qty: 1, price: p };
    } else if (side === 'sell' && itemId) {
      const it = g.equipment.getItem(itemId);
      if (it?.bound) return { ok: false, reason: '副本裝備製作後綁定，不能交易' };
      if (!it || it.locked || g.equipment.equippedBy(it.id) || (it.loc || 'store') !== 'store') return { ok: false, reason: '只能刊登倉庫裡、未上鎖且沒有穿戴的裝備' };
      if (p <= 0) return { ok: false, reason: '請輸入價格' };
      const copy = JSON.parse(JSON.stringify(it));
      const r = g.equipment.removeItem(it.id);
      if (!r.ok) return r;
      undo = () => { copy.loc = 'store'; g.equipment.items.push(copy); };
      data = { item: copy, qty: 1, price: p };
    } else {
      if (!isGood(key)) return { ok: false, reason: '請選擇物品' };
      const n = int(qty, 1, MAX_LISTING_QTY);
      if (side === 'sell') {
        if (!this.take(key, n)) return { ok: false, reason: `倉庫裡的${goodName(key)}不足 ${n}` };
        undo = () => this.give(key, n);
      } else {
        if (p <= 0) return { ok: false, reason: '收購單價至少 💰1' };
        const escrow = n * p;
        if (g.state.player.coins < escrow) return { ok: false, reason: `金錢不足：收購總額 💰${escrow} 會先保管在市場` };
        g.state.player.coins -= escrow;
        undo = () => { g.state.player.coins += escrow; };
      }
      data = { key, qty: n, price: p };
    }
    const id = uid('mk');
    const now = Date.now();
    const body = {
      side, owner: this.myId(), ownerName: g.state.player.name || '倖存者', ...data, filled: 0, paid: 0, status: 'open', at: now, fills: [],
    };
    const r = await g.shared.update('mk', id, (cur) => (cur ? { fail: '刊登編號重複，請再試一次' } : { data: body }), { lat: null, lon: null }); // 全服可見（不限距離）
    if (!r.ok) { undo(); return r; }
    this.state.mine[id] = {
      side, key: data.key || null, item: data.item || null, bp: data.bp || null, bpName: data.bpName || null, qty: data.qty, price: p, at: now, filled: 0, paid: 0,
    };
    const what = listingName(data) || `${goodName(key)}×${data.qty}`;
    g.log(`🏪 在交易市場刊登${side === 'sell' ? '賣出' : '收購'}${what}（${data.item || data.bp ? `💰${p}` : `每個 💰${p}`}）`, 'info');
    g.changed?.();
    return { ok: true, id, msg: `已刊登${side === 'sell' ? '賣出' : '收購'}${what}` };
  }

  /**
   * 與別人的刊登成交：賣單＝我購買 n 個；收購單＝我賣給對方 n 個。
   * 先扣掉自己的錢或物品，伺服器確認成交後交貨，失敗則退回。
   */
  async take_(id, qty) {
    const g = this.game;
    const cur = g.shared.get('mk', id);
    if (!cur || cur.status !== 'open' || cur.qty <= cur.filled) return { ok: false, reason: '這筆刊登已經結束了' };
    if (cur.owner === this.myId()) return { ok: false, reason: '不能和自己交易' };
    if (Date.now() >= (cur.at || 0) + LISTING_MS) return { ok: false, reason: '這筆刊登已經過期了' };
    const n = cur.item || cur.bp ? 1 : int(qty, 1, cur.qty - cur.filled);
    const total = n * cur.price;
    let undo;
    let deliver;
    if (cur.side === 'sell') {
      if (g.state.player.coins < total) return { ok: false, reason: `金錢不足（需要 💰${total}）` };
      if (cur.bp ? false : cur.item ? !g.equipment.fits(cur.item, 'store') : this.room(cur.key) < n) return { ok: false, reason: '倉庫空間不足' };
      g.state.player.coins -= total;
      undo = () => { g.state.player.coins += total; };
      deliver = (d) => {
        // 交易買來的設計圖不會被自動出售
        if (d.bp) g.state.inventory.blueprints.push({ ...d.bp, id: uid('bp'), keep: true });
        else if (d.item) g.equipment.addItem({ ...JSON.parse(JSON.stringify(d.item)), id: uid('it') }, '交易市場');
        else this.give(d.key, n);
      };
    } else {
      if (!this.take(cur.key, n)) return { ok: false, reason: `倉庫裡的${goodName(cur.key)}不足 ${n}` };
      undo = () => this.give(cur.key, n);
      deliver = () => { g.state.player.coins += total; };
    }
    const name = g.state.player.name || '倖存者';
    const r = await g.shared.update('mk', id, (d) => {
      if (!d || d.status !== 'open') return { fail: '這筆刊登已經結束了' };
      if (d.qty - d.filled < n) return { fail: d.qty > d.filled ? `剩下的數量不足（只剩 ${d.qty - d.filled}）` : '已經被其他玩家買走了' };
      d.filled += n;
      if (d.filled >= d.qty) d.status = 'closed';
      d.fills = [...(d.fills || []), { name, n, at: Date.now() }].slice(-10);
      return { data: d, result: d };
    });
    if (!r.ok) { undo(); g.changed?.(); return r; }
    deliver(r.data);
    const what = listingName(cur) || `${goodName(cur.key)}×${n}`;
    const msg = cur.side === 'sell' ? `向「${cur.ownerName}」買了${what}（💰${total}）` : `把${what}賣給「${cur.ownerName}」（💰${total}）`;
    g.log(`🏪 交易市場：${msg}`, 'loot');
    g.changed?.();
    return { ok: true, msg };
  }

  /** 購買別人的賣單 */
  buy(id, qty) {
    return this.take_(id, qty);
  }

  /** 賣給別人的收購單 */
  sellTo(id, qty) {
    return this.take_(id, qty);
  }

  /** 收取自己刊登已成交的部分（賣單收錢、收購單收貨）；close=true 同時下架並退還未成交的部分 */
  async collect(id, close = false) {
    const g = this.game;
    const m = this.state.mine[id];
    if (!m) return { ok: false, reason: '找不到這筆刊登' };
    const me = this.myId();
    const r = await g.shared.update('mk', id, (d) => {
      if (!d) return { fail: '市場上找不到這筆刊登' };
      if (d.owner !== me) return { fail: '這不是你的刊登' };
      const pending = d.filled - (d.paid || 0);
      const remain = close && d.status === 'open' ? d.qty - d.filled : 0;
      if (pending <= 0 && !remain && !(close && d.status === 'open')) return { fail: 'nothing' };
      d.paid = d.filled;
      if (close) d.status = 'closed';
      return { data: d, result: { pending, remain } };
    });
    if (!r.ok) return r;
    const { pending, remain } = r.result;
    this.credit(m, pending, remain);
    m.filled = r.data.filled;
    m.paid = r.data.paid;
    if (r.data.status !== 'open') m.closed = true;
    if (m.closed && m.paid >= m.filled) delete this.state.mine[id];
    g.changed?.();
    return { ok: true, pending, remain };
  }

  /** 把成交所得與退還物交給自己 */
  credit(m, pending, remain) {
    const g = this.game;
    const what = listingName(m) || goodName(m.key);
    if (pending > 0) {
      if (m.side === 'sell') {
        g.state.player.coins += pending * m.price;
        g.log(`🏪 交易市場：${what}${m.item || m.bp ? '' : `×${pending}`} 已售出，收到 💰${pending * m.price}`, 'loot');
      } else {
        this.give(m.key, pending);
        g.log(`🏪 交易市場：收購到 ${what}×${pending}`, 'loot');
      }
    }
    if (remain > 0) {
      if (m.side === 'sell') {
        if (m.bp) {
          if (!g.state.inventory.blueprints.some((b) => b.id === m.bp.id)) g.state.inventory.blueprints.push({ ...m.bp, keep: true }); // 撤回的設計圖不會被自動出售
        } else if (m.item) {
          const copy = { ...JSON.parse(JSON.stringify(m.item)), loc: 'store' };
          if (!g.equipment.getItem(copy.id)) g.equipment.items.push(copy);
        } else this.give(m.key, remain);
        g.log(`🏪 交易市場：${what}${m.item || m.bp ? '' : `×${remain}`} 下架並退回${m.bp ? '設計圖' : '倉庫'}`, 'info');
      } else {
        g.state.player.coins += remain * m.price;
        g.log(`🏪 交易市場：收購 ${what} 下架，退還 💰${remain * m.price}`, 'info');
      }
    }
  }

  /** 下架（退還未成交的部分，並收取已成交的部分） */
  async cancel(id) {
    const r = await this.collect(id, true);
    if (!r.ok) return r.reason === 'nothing' ? { ok: false, reason: '這筆刊登已經結束了' } : r;
    return { ok: true, msg: `已下架${r.remain ? '並退還未成交的部分' : ''}` };
  }

  /**
   * 結算自己的刊登：上線同步後自動收取已成交的部分；到期的自動下架；
   * 市場上已經被清除（長時間沒有更新）的刊登依本機紀錄退還。
   */
  async settle(now = Date.now()) {
    const g = this.game;
    if (this.busy) return;
    this.busy = true;
    try {
      for (const [id, m] of Object.entries(this.state.mine)) {
        const d = g.shared.get('mk', id);
        if (!d) {
          if (now > m.at + OBJ_KEEP_MS && g.shared.listedAt.mk) {
            this.credit(m, 0, m.closed ? 0 : m.qty - (m.filled || 0));
            delete this.state.mine[id];
          }
          continue;
        }
        if (d.status !== 'open' && (d.paid || 0) >= d.filled) {
          delete this.state.mine[id];
          continue;
        }
        const expired = d.status === 'open' && now >= d.at + LISTING_MS;
        if (d.filled > (d.paid || 0) || expired) {
          // eslint-disable-next-line no-await-in-loop
          await this.collect(id, expired);
        }
      }
    } finally {
      this.busy = false;
    }
  }

  /** 每秒檢查：共用資料更新後結算一次 */
  update() {
    const at = this.game.shared.listedAt.mk || 0;
    if (at && at !== this.settledAt) {
      this.settledAt = at;
      this.settle();
    }
  }
}
