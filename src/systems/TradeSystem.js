import { RESOURCE_KEYS } from '../config/constants.js';
import { SUPPLIES, isSupply, unitWeight } from '../config/supplies.js';
import { LOOT_CATS } from '../config/poiTypes.js';
import { tripProgress } from './ExplorationSystem.js';
import { uid } from '../utils/math.js';

/** 交易隊在對方據點最多停留的時間（現實時間），之後自動回家 */
export const TRADE_STAY_MS = 2 * 60 * 60 * 1000;
/** 一次最多擺幾項商品 */
export const MAX_TRADE_GOODS = 12;
/** 單價上限 */
export const MAX_TRADE_PRICE = 100000;
/** 交易完成後保留紀錄的時間（處理離線期間延遲送達的購買） */
const LEDGER_MS = 24 * 3600 * 1000;

const nameOf = (k) => SUPPLIES[k]?.name || LOOT_CATS[k]?.name || k;
const iconOf = (k) => SUPPLIES[k]?.icon || LOOT_CATS[k]?.icon || '📦';
const isGood = (k) => RESOURCE_KEYS.includes(k) || isSupply(k);

/**
 * 玩家交易：賣方派一位倖存者帶著訂好數量與價格的商品，走到對方（買方）的據點擺攤。
 *  - 可攜帶的數量受倖存者負重與背包格子限制。
 *  - 買方在自己的據點點選商隊即可選購，只能用金錢（價格可為 0，等於免費贈送）。
 *  - 買方可按「結束交易」讓對方回家；賣方也可以隨時召回。
 *  - 兩邊的資料透過公開資料（擺攤清單）與事件信箱（tradeBuy／tradeEnd／tradeRefund）同步。
 */
export class TradeSystem {
  constructor(game) {
    this.game = game;
    this.cache = new Map();
  }

  get state() {
    const st = this.game.state;
    st.trade = st.trade || { bought: {}, ended: {}, seen: {}, ledger: {} };
    return st.trade;
  }

  myId() {
    try {
      return this.game.world?.identity?.().id || null;
    } catch {
      return null;
    }
  }

  // ================= 賣方 =================

  /** 讓探索系統把對方據點當成目的地：id = trade:玩家ID */
  asPoi(id) {
    if (!String(id).startsWith('trade:')) return null;
    const t = this.cache.get(id) || this.game.state.expeditions.find((e) => e.poiId === id)?.tradeTarget;
    return t && {
      id, name: `🤝 ${t.name}的據點`, lat: t.lat, lon: t.lon, type: 'residential', icon: '🤝', trade: true, target: t,
    };
  }

  player(playerId) {
    return (this.game.world?.others || []).find((p) => p.id === playerId) || null;
  }

  /** 已派往這位玩家的交易隊 */
  activeTo(playerId) {
    return this.game.state.expeditions.find((e) => e.kind === 'trade' && e.trade?.playerId === playerId) || null;
  }

  canStart(playerId) {
    const g = this.game;
    if (!g.shelter.hasShelter()) return { ok: false, reason: '請先建立避難所' };
    const p = this.player(playerId);
    if (!p) return { ok: false, reason: '找不到這位玩家（可能已離線）' };
    if (g.territory.relation(playerId) === 'hostile') return { ok: false, reason: '敵對玩家無法交易' };
    if (this.activeTo(playerId)) return { ok: false, reason: '已經有交易隊前往這位玩家的據點' };
    return { ok: true, player: p };
  }

  /**
   * 派倖存者出發交易。
   * @param {{key?:string, itemId?:string, qty?:number, price:number}[]} goods 材料／資源以 key＋數量＋單價；裝備以 itemId＋價格
   */
  start(playerId, svId, goods) {
    const g = this.game;
    const check = this.canStart(playerId);
    if (!check.ok) return check;
    const sv = g.survivors.get(svId);
    if (!sv || !g.survivors.isAvailable(sv)) return { ok: false, reason: '這位倖存者現在無法出發' };
    const list = (goods || []).filter((x) => (x.itemId || (isGood(x.key) && x.qty > 0))).slice(0, MAX_TRADE_GOODS);
    if (!list.length) return { ok: false, reason: '請至少選擇一項商品' };
    const price = (v) => Math.min(MAX_TRADE_PRICE, Math.max(0, Math.floor(Number(v) || 0)));
    // 先把商品放進背包（受負重與格子限制），失敗就全部放回
    const moved = [];
    const undo = () => moved.forEach((m) => {
      if (m.itemId) g.equipment.moveToStore(m.itemId);
      else g.survivors.deposit(svId, m.key, m.n);
    });
    const stall = [];
    for (const x of list) {
      if (x.itemId) {
        const it = g.equipment.getItem(x.itemId);
        if (!it || it.locked || g.equipment.equippedBy(it.id)) { undo(); return { ok: false, reason: '上鎖或穿戴中的裝備不能交易' }; }
        const r = g.equipment.moveToBag(it.id, svId);
        if (!r.ok) { undo(); return { ok: false, reason: `「${it.name}」放不進背包：${r.reason}` }; }
        moved.push({ itemId: it.id });
        stall.push({ id: uid('tg'), itemId: it.id, qty: 1, sold: 0, price: price(x.price) });
      } else {
        const want = Math.floor(x.qty);
        const r = g.survivors.withdraw(svId, x.key, want);
        if (!r.ok || r.n < want) {
          if (r.ok) moved.push({ key: x.key, n: r.n });
          undo();
          return { ok: false, reason: `${nameOf(x.key)} 帶不了 ${want} 個（${r.ok ? `負重或格子只夠 ${r.n} 個` : r.reason}）` };
        }
        moved.push({ key: x.key, n: r.n });
        stall.push({ id: uid('tg'), key: x.key, qty: r.n, sold: 0, price: price(x.price) });
      }
    }
    const id = `trade:${playerId}`;
    const base = check.player.bases.find((b) => b.primary) || check.player.bases[0];
    const target = { playerId, name: check.player.name, lat: base.lat, lon: base.lon };
    this.cache.set(id, target);
    const r = g.exploration.start(id, [svId], 0, false, Date.now(), { kind: 'trade' });
    if (!r.ok) { undo(); return r; }
    // 停留時間固定（不受探索速度影響）
    r.exp.searchMs = TRADE_STAY_MS;
    r.exp.endAt = r.exp.startAt + r.exp.travelMs * 2 + TRADE_STAY_MS;
    r.exp.tradeTarget = target;
    r.exp.trade = { playerId, name: check.player.name, goods: stall, earned: 0, log: [] };
    g.log(`🤝 ${sv.name} 帶著 ${stall.length} 項商品前往「${check.player.name}」的據點交易`, 'info');
    return { ok: true, exp: r.exp, msg: `${sv.name} 出發前往「${check.player.name}」的據點擺攤` };
  }

  /** 公開給其他玩家的擺攤資料（presence trips 使用） */
  stallOf(exp) {
    const g = this.game;
    return (exp.trade?.goods || []).map((x) => {
      if (x.itemId) {
        const it = g.equipment.getItem(x.itemId);
        return it ? { id: x.id, item: g.equipment.exportItem(it), qty: 1, sold: x.sold, price: x.price } : null;
      }
      return { id: x.id, key: x.key, qty: x.qty, sold: x.sold, price: x.price };
    }).filter(Boolean);
  }

  /** 交易隊回家時的報告；保留紀錄以處理延遲送達的購買 */
  report(exp) {
    const g = this.game;
    const t = exp.trade || {};
    const members = exp.memberIds.map((id) => g.survivors.get(id)).filter(Boolean);
    this.state.ledger[exp.id] = { svId: exp.memberIds[0], goods: t.goods || [], playerId: t.playerId, until: Date.now() + LEDGER_MS };
    const sold = (t.goods || []).filter((x) => x.sold > 0).map((x) => `${this.goodName(x)}×${x.sold}`);
    return {
      id: uid('rp'), poiName: `🤝 ${t.name || '玩家'}的據點`, poiType: 'residential', at: exp.endAt,
      events: [
        ...(exp.travelEvents || []),
        ...(t.log || []),
        sold.length ? `💰 賣出：${sold.join('、')}，共得到 💰${t.earned || 0}` : '🤷 這趟沒有賣出任何東西',
        '🎒 沒賣完的商品還在倖存者背包裡，回到避難所可存回倉庫。',
      ],
      resources: {}, items: [], blueprints: [], kills: exp.travelKills || 0, xp: exp.travelXp || 0, success: true,
      members: members.map((m) => m.name),
    };
  }

  goodName(x) {
    if (x.itemId) return `「${this.game.equipment.getItem(x.itemId)?.name || '裝備'}」`;
    return nameOf(x.key);
  }

  /** 找交易：進行中的交易隊，或剛回家的紀錄 */
  findTrade(tripId) {
    const exp = this.game.state.expeditions.find((e) => e.id === tripId && e.kind === 'trade');
    if (exp) return { exp, goods: exp.trade.goods, svId: exp.memberIds[0], trade: exp.trade };
    const led = this.state.ledger[tripId];
    return led ? { exp: null, goods: led.goods, svId: led.svId, trade: null } : null;
  }

  /** 賣方收到買方的購買：交出商品、收下金錢；商品已經不見時退款 */
  onBuy(from, fromName, data) {
    const g = this.game;
    const tr = this.findTrade(String(data?.tripId || ''));
    const good = tr?.goods.find((x) => x.id === data?.goodId);
    const want = Math.max(0, Math.floor(Number(data?.qty) || 0));
    const paid = Math.max(0, Math.floor(Number(data?.coins) || 0));
    if (!tr || !good || !want) {
      if (paid) g.territory.send(from, 'tradeRefund', { coins: paid, note: '找不到這筆交易' });
      return;
    }
    if ((tr.trade?.playerId || this.state.ledger[data.tripId]?.playerId) !== from) return;
    const left = Math.max(0, good.qty - good.sold);
    let n = Math.min(want, left);
    // 從倖存者背包（或已經回家存進倉庫的）取出
    if (good.itemId) {
      const it = g.equipment.getItem(good.itemId);
      if (n > 0 && it && !g.equipment.equippedBy(it.id)) {
        it.locked = false;
        g.equipment.removeItem(it.id);
      } else n = 0;
    } else if (n > 0) {
      const sv = g.survivors.get(tr.svId);
      const bag = sv?.bag || {};
      const fromBag = Math.min(n, bag[good.key] || 0);
      if (fromBag) { bag[good.key] -= fromBag; if (bag[good.key] <= 0) delete bag[good.key]; }
      let rest = n - fromBag;
      const pool = RESOURCE_KEYS.includes(good.key) ? g.state.resources : g.state.supplies;
      const fromStore = Math.min(rest, Math.floor(pool[good.key] || 0));
      if (fromStore) { pool[good.key] -= fromStore; if (isSupply(good.key) && pool[good.key] <= 0) delete pool[good.key]; }
      rest -= fromStore;
      n -= rest;
    }
    good.sold += n;
    const due = good.price * n;
    const got = Math.min(paid, due);
    g.state.player.coins += got;
    if (tr.trade) tr.trade.earned = (tr.trade.earned || 0) + got;
    const refund = paid - got;
    if (refund > 0) g.territory.send(from, 'tradeRefund', { coins: refund, note: n < want ? '部分商品已經沒有了' : '多付的金額' });
    if (n > 0) {
      const text = `🤝 玩家「${fromName}」買了 ${this.goodName(good)}×${n}${got ? `，付了 💰${got}` : '（免費贈送）'}`;
      tr.trade?.log.push(text);
      g.log(text, 'loot');
      g.toast(text, 'success');
    }
  }

  /** 買方結束交易：交易隊回家 */
  onEnd(from, fromName, data) {
    const g = this.game;
    const exp = g.state.expeditions.find((e) => e.id === data?.tripId && e.kind === 'trade');
    if (!exp || exp.trade?.playerId !== from || exp.recalled || exp.tradeEnded) return;
    exp.tradeEnded = true;
    g.exploration.turnBack(exp);
    exp.trade.log.push(`👋 「${fromName}」結束了交易，倖存者動身回家`);
    g.log(`🤝 玩家「${fromName}」結束了交易，${g.survivors.get(exp.memberIds[0])?.name || '倖存者'}正在回家`, 'info');
  }

  /** 清掉過期的交易紀錄 */
  prune(now = Date.now()) {
    const led = this.state.ledger;
    Object.keys(led).forEach((k) => { if (led[k].until < now) delete led[k]; });
    const ended = this.state.ended;
    Object.keys(ended).forEach((k) => { if (ended[k] < now - LEDGER_MS) delete ended[k]; });
  }

  // ================= 買方 =================

  /** 來到自己據點的交易隊（對方已抵達、還在擺攤、沒被我結束） */
  incoming(now = Date.now()) {
    const me = this.myId();
    if (!me) return [];
    const out = [];
    (this.game.world?.others || []).forEach((p) => (p.trips || []).forEach((t) => {
      if (t.kind !== 'trade' || t.targetId !== me || this.state.ended[t.id]) return;
      const ph = tripProgress(t, now).phase;
      out.push({ player: p, trip: t, arrived: ph === 'searching' });
    }));
    return out;
  }

  /** 新抵達的交易隊：通知一次 */
  notifyArrivals(now = Date.now()) {
    this.incoming(now).forEach(({ player, trip, arrived }) => {
      if (!arrived || this.state.seen[trip.id]) return;
      this.state.seen[trip.id] = now;
      this.game.log(`🤝 玩家「${player.name}」的交易隊抵達你的據點，到地圖點選商隊即可交易`, 'loot');
      this.game.toast(`🤝「${player.name}」的交易隊來到你的據點！到地圖點選商隊交易`, 'success');
    });
  }

  find(playerId, tripId) {
    const p = this.player(playerId);
    const t = p?.trips.find((x) => x.id === tripId && x.kind === 'trade');
    return t ? { player: p, trip: t } : null;
  }

  /** 買方看到的商品剩餘數量 */
  remaining(tripId, good) {
    const mine = this.state.bought[tripId]?.[good.id] || 0;
    return Math.max(0, good.qty - Math.max(good.sold || 0, mine));
  }

  canTrade(playerId, tripId, now = Date.now()) {
    const f = this.find(playerId, tripId);
    if (!f) return { ok: false, reason: '交易隊已經離開了' };
    if (f.trip.targetId !== this.myId()) return { ok: false, reason: '這支交易隊不是來找你的' };
    if (this.state.ended[tripId]) return { ok: false, reason: '你已經結束這次交易' };
    if (tripProgress(f.trip, now).phase !== 'searching') return { ok: false, reason: '交易隊還在路上（或已經離開）' };
    return { ok: true, ...f };
  }

  /** 買方購買（只能用金錢；價格 0 等於免費贈送） */
  buy(playerId, tripId, goodId, qty = 1) {
    const g = this.game;
    const c = this.canTrade(playerId, tripId);
    if (!c.ok) return c;
    const good = (c.trip.stall || []).find((x) => x.id === goodId);
    if (!good) return { ok: false, reason: '找不到這項商品' };
    const left = this.remaining(tripId, good);
    const n = Math.min(left, Math.max(1, Math.floor(Number(qty) || 1)));
    if (n <= 0) return { ok: false, reason: '已經賣完了' };
    const cost = good.price * n;
    if (g.state.player.coins < cost) return { ok: false, reason: `金錢不足（需要 💰${cost}）` };
    let label;
    if (good.item) {
      const it = g.equipment.importItem(good.item);
      if (!it) return { ok: false, reason: '這件裝備的資料有誤' };
      if (!g.equipment.fits(it, 'store')) return { ok: false, reason: '物品倉庫空間不足' };
      g.equipment.addItem(it, `玩家「${c.player.name}」`);
      label = `「${it.name}」`;
    } else {
      if (!isGood(good.key)) return { ok: false, reason: '不明的商品' };
      if (isSupply(good.key) && g.equipment.supplyRoom(good.key) < n) return { ok: false, reason: '物品倉庫空間不足' };
      g.grant({ [good.key]: n });
      label = `${iconOf(good.key)}${nameOf(good.key)}×${n}`;
    }
    g.state.player.coins -= cost;
    const b = this.state.bought;
    b[tripId] = b[tripId] || {};
    b[tripId][goodId] = Math.max(good.sold || 0, b[tripId][goodId] || 0) + n;
    g.territory.send(playerId, 'tradeBuy', { tripId, goodId, qty: n, coins: cost });
    g.log(`🤝 向玩家「${c.player.name}」買了 ${label}${cost ? `（💰${cost}）` : '（免費）'}`, 'loot');
    return { ok: true, msg: `買到 ${label}${cost ? `，花了 💰${cost}` : '（免費）'}` };
  }

  /** 買方結束交易：通知對方，交易隊回家 */
  end(playerId, tripId) {
    const f = this.find(playerId, tripId);
    if (!f) return { ok: false, reason: '交易隊已經離開了' };
    this.state.ended[tripId] = Date.now();
    this.game.territory.send(playerId, 'tradeEnd', { tripId });
    return { ok: true, msg: `已結束與「${f.player.name}」的交易，對方的倖存者會回家` };
  }

  /** 收到賣方的退款（商品已經沒有了） */
  onRefund(fromName, data) {
    const coins = Math.min(MAX_TRADE_PRICE * 999, Math.max(0, Math.floor(Number(data?.coins) || 0)));
    if (!coins) return;
    this.game.state.player.coins += coins;
    this.game.log(`🤝 玩家「${fromName}」退還了 💰${coins}（${String(data?.note || '').slice(0, 30)}）`, 'info');
  }

  /** 商品顯示用 */
  goodLabel(good) {
    if (good.item) return good.item.name;
    return `${iconOf(good.key)} ${nameOf(good.key)}`;
  }

  weightOf(key, n) {
    return unitWeight(key) * n;
  }
}
