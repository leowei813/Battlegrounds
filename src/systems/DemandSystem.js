import { RESOURCE_KEYS } from '../config/constants.js';
import { SUPPLIES, isSupply } from '../config/supplies.js';
import { LOOT_CATS } from '../config/poiTypes.js';
import { uid } from '../utils/math.js';

/** 一筆收購的上限 */
export const MAX_DEMAND_QTY = 9999;
export const MAX_DEMAND_PRICE = 10000;

const nameOf = (k) => SUPPLIES[k]?.name || LOOT_CATS[k]?.name || k;
const iconOf = (k) => SUPPLIES[k]?.icon || LOOT_CATS[k]?.icon || '📦';
export const isDemandGood = (k) => RESOURCE_KEYS.includes(k) || isSupply(k);

/**
 * 交易所：收購需求（發布需求）。
 *  - 有交易所的玩家可以掛上想收購的物資、數量與單價；交易所每一級可以同時掛 1 項。
 *  - 掛單時先把收購金額保留起來（取消時退還），保證交付的人一定拿得到錢。
 *  - 其他玩家在地圖上看到據點的 📢 圖示，可以派倖存者帶著物資走過去交付（需要移動時間）。
 *  - 抵達時交出物資並透過事件信箱通知對方；對方上線後收下物資並付款，收不下的部分退回。
 */
export class DemandSystem {
  constructor(game) {
    this.game = game;
    this.cache = new Map();
  }

  get state() {
    const st = this.game.state;
    st.demands = st.demands || { list: [] };
    return st.demands;
  }

  get list() {
    return this.state.list;
  }

  exchangeLevel() {
    return this.game.shelter.maxLevel('exchange');
  }

  /** 交易所等級＝可同時掛的收購數量 */
  maxDemands() {
    return this.exchangeLevel();
  }

  // ================= 掛單（收購方） =================

  post(key, qty, price) {
    const g = this.game;
    if (this.exchangeLevel() < 1) return { ok: false, reason: '需要先在避難所建造交易所' };
    if (this.list.length >= this.maxDemands()) return { ok: false, reason: `交易所 Lv${this.exchangeLevel()} 最多同時掛 ${this.maxDemands()} 項收購（升級可增加）` };
    if (!isDemandGood(key)) return { ok: false, reason: '請選擇要收購的物資' };
    if (this.list.some((d) => d.key === key)) return { ok: false, reason: '這項物資已經在收購中' };
    const n = Math.floor(Number(qty) || 0);
    const p = Math.floor(Number(price) || 0);
    if (n < 1 || n > MAX_DEMAND_QTY) return { ok: false, reason: `數量需在 1～${MAX_DEMAND_QTY}` };
    if (p < 0 || p > MAX_DEMAND_PRICE) return { ok: false, reason: `單價需在 0～${MAX_DEMAND_PRICE}` };
    const escrow = n * p;
    if (g.state.player.coins < escrow) return { ok: false, reason: `金錢不足：收購總額 💰${escrow} 會先保留起來` };
    g.state.player.coins -= escrow;
    const d = { id: uid('dm'), key, qty: n, filled: 0, price: p, at: Date.now() };
    this.list.push(d);
    g.log(`📢 交易所掛出收購：${nameOf(key)}×${n}，每個 💰${p}（保留 💰${escrow}）`, 'info');
    return { ok: true, msg: `已掛出收購 ${nameOf(key)}×${n}` };
  }

  cancel(id) {
    const g = this.game;
    const d = this.list.find((x) => x.id === id);
    if (!d) return { ok: false, reason: '找不到這筆收購' };
    const refund = (d.qty - d.filled) * d.price;
    g.state.player.coins += refund;
    this.state.list = this.list.filter((x) => x.id !== id);
    return { ok: true, msg: `已取消收購，退還保留的 💰${refund}` };
  }

  /** 公開給其他玩家的收購清單 */
  published() {
    return this.list.map((d) => ({ id: d.id, key: d.key, qty: d.qty - d.filled, price: d.price })).filter((d) => d.qty > 0);
  }

  /** 收到交付：收下物資、付款；收不下或已經收滿的部分退回 */
  onSell(from, fromName, data) {
    const g = this.game;
    const key = String(data?.key || '');
    const want = Math.min(MAX_DEMAND_QTY, Math.max(0, Math.floor(Number(data?.qty) || 0)));
    if (!isDemandGood(key) || !want) return;
    const d = this.list.find((x) => x.id === data?.demandId && x.key === key);
    let n = d ? Math.min(want, d.qty - d.filled) : 0;
    if (n > 0 && isSupply(key)) n = Math.min(n, g.equipment.supplyRoom(key));
    if (n > 0) {
      g.grant({ [key]: n });
      d.filled += n;
      const coins = n * d.price;
      g.territory.send(from, 'demandPay', { demandId: d.id, key, qty: n, coins });
      const text = `📢 玩家「${fromName}」交付了 ${iconOf(key)}${nameOf(key)}×${n}，付出 💰${coins}`;
      g.log(text, 'loot');
      g.toast(text, 'success');
      if (d.filled >= d.qty) {
        this.state.list = this.list.filter((x) => x.id !== d.id);
        g.log(`📢 收購 ${nameOf(key)} 已經收滿`, 'info');
      }
    }
    if (want - n > 0) g.territory.send(from, 'demandReturn', { key, qty: want - n, note: d ? '倉庫放不下或已經收滿' : '對方已經取消收購' });
  }

  // ================= 交付（出貨方） =================

  player(playerId) {
    return (this.game.world?.others || []).find((p) => p.id === playerId) || null;
  }

  /** 讓探索系統把交付目的地當成地點：id = deliver:玩家ID:需求ID */
  asPoi(id) {
    if (!String(id).startsWith('deliver:')) return null;
    const t = this.cache.get(id) || this.game.state.expeditions.find((e) => e.poiId === id)?.deliverTarget;
    return t && {
      id, name: `📢 ${t.name}的據點`, lat: t.lat, lon: t.lon, type: 'residential', icon: '📢', deliver: true, target: t,
    };
  }

  canDeliver(playerId, demandId) {
    const g = this.game;
    if (!g.shelter.hasShelter()) return { ok: false, reason: '請先建立避難所' };
    if (this.exchangeLevel() < 1) return { ok: false, reason: '需要先在避難所建造交易所才能交易' };
    const p = this.player(playerId);
    if (!p) return { ok: false, reason: '找不到這位玩家（可能已離線）' };
    if (g.territory.relation(playerId) === 'hostile') return { ok: false, reason: '敵對玩家無法交易' };
    const d = (p.demands || []).find((x) => x.id === demandId);
    if (!d || d.qty <= 0) return { ok: false, reason: '這筆收購已經結束了' };
    if (g.state.expeditions.some((e) => e.kind === 'deliver' && e.deliver?.demandId === demandId)) return { ok: false, reason: '已經有人在路上交付這筆收購' };
    return { ok: true, player: p, demand: d };
  }

  /** 派倖存者帶著物資前往交付 */
  deliver(playerId, demandId, svId, qty) {
    const g = this.game;
    const c = this.canDeliver(playerId, demandId);
    if (!c.ok) return c;
    const sv = g.survivors.get(svId);
    if (!sv || !g.survivors.isAvailable(sv)) return { ok: false, reason: '這位倖存者現在無法出發' };
    const want = Math.min(c.demand.qty, Math.max(1, Math.floor(Number(qty) || 0)));
    const r = g.survivors.withdraw(svId, c.demand.key, want);
    if (!r.ok) return r;
    const id = `deliver:${playerId}:${demandId}`;
    const base = c.player.bases.find((b) => b.primary) || c.player.bases[0];
    const target = { playerId, name: c.player.name, lat: base.lat, lon: base.lon };
    this.cache.set(id, target);
    const st = g.exploration.start(id, [svId], 0, false, Date.now(), { kind: 'deliver' });
    if (!st.ok) {
      g.survivors.deposit(svId, c.demand.key, r.n);
      return st;
    }
    st.exp.deliverTarget = target;
    st.exp.deliver = {
      playerId, name: c.player.name, demandId, key: c.demand.key, qty: r.n, price: c.demand.price, delivered: false,
    };
    const short = r.n < want ? `（負重只夠帶 ${r.n} 個）` : '';
    return { ok: true, exp: st.exp, msg: `${sv.name} 帶著 ${nameOf(c.demand.key)}×${r.n} 前往「${c.player.name}」的據點交付${short}` };
  }

  /** 抵達時交出物資並通知對方（線上每秒、離線結算前補算） */
  checkDeliveries(now = Date.now()) {
    const g = this.game;
    g.state.expeditions.forEach((exp) => {
      const dv = exp.deliver;
      if (exp.kind !== 'deliver' || !dv || dv.delivered || exp.recalled || exp.defeated) return;
      if (now < exp.startAt + (exp.travelMs || 0)) return;
      dv.delivered = true;
      const sv = g.survivors.get(exp.memberIds[0]);
      const bag = sv?.bag || {};
      const n = Math.min(dv.qty, Math.floor(bag[dv.key] || 0));
      if (n > 0) {
        bag[dv.key] -= n;
        if (bag[dv.key] <= 0) delete bag[dv.key];
        g.territory.send(dv.playerId, 'demandSell', { demandId: dv.demandId, key: dv.key, qty: n });
      }
      dv.handed = n;
      exp.travelEvents = [...(exp.travelEvents || []), n
        ? `📦 交出 ${nameOf(dv.key)}×${n}，對方上線後會付款（約 💰${n * dv.price}）`
        : '📦 身上的物資已經不見了，沒有交付'];
    });
  }

  /** 收到付款 */
  onPay(fromName, data) {
    const coins = Math.min(MAX_DEMAND_QTY * MAX_DEMAND_PRICE, Math.max(0, Math.floor(Number(data?.coins) || 0)));
    const qty = Math.max(0, Math.floor(Number(data?.qty) || 0));
    this.game.state.player.coins += coins;
    const text = `📢 玩家「${fromName}」收下 ${nameOf(data?.key)}×${qty}，付了 💰${coins}`;
    this.game.log(text, 'loot');
    this.game.toast(text, 'success');
  }

  /** 收不下的物資退回倉庫 */
  onReturn(fromName, data) {
    const key = String(data?.key || '');
    const qty = Math.min(MAX_DEMAND_QTY, Math.max(0, Math.floor(Number(data?.qty) || 0)));
    if (!isDemandGood(key) || !qty) return;
    const got = this.game.grant({ [key]: qty });
    this.game.log(`📢 玩家「${fromName}」退回了 ${nameOf(key)}×${got[key] || 0}（${String(data?.note || '').slice(0, 30)}）`, 'info');
  }

  /** 交付隊回家的報告 */
  report(exp) {
    const g = this.game;
    const dv = exp.deliver || {};
    const members = exp.memberIds.map((id) => g.survivors.get(id)).filter(Boolean);
    return {
      id: uid('rp'), poiName: `📢 ${dv.name || '玩家'}的據點`, poiType: 'residential', at: exp.endAt,
      events: [...(exp.travelEvents || []), dv.handed ? '🏠 交付完成，回到避難所（款項在對方上線後送達）' : '🏠 回到避難所，這趟沒有交付'],
      resources: {}, items: [], blueprints: [], kills: exp.travelKills || 0, xp: exp.travelXp || 0, success: !!dv.handed,
      members: members.map((m) => m.name),
    };
  }

  label(key) {
    return `${iconOf(key)} ${nameOf(key)}`;
  }
}
