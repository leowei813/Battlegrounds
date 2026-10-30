import {
  VEHICLES, PERSON_CARRY, GARAGE_SIZE, WEAR_PER_KM, AMBUSH_WEAR, repairCost, VEHICLE_FIND_BY_POI,
} from '../config/vehicles.js';
import { canAfford, payCost } from './costUtils.js';
import {
  uid, randFloat, weightedPick, randInt,
} from '../utils/math.js';

/**
 * 載具系統：車庫、維修、製作、探索時的速度／運載量／耗油／磨損。
 */
export class VehicleSystem {
  constructor(game) {
    this.game = game;
  }

  get list() {
    return this.game.state.vehicles;
  }

  get(id) {
    return this.list.find((v) => v.id === id) || null;
  }

  def(v) {
    return VEHICLES[v.type];
  }

  maxDurability(v) {
    return this.def(v).durability;
  }

  isBroken(v) {
    return v.durability <= 0;
  }

  /** 可以出車：在車庫、未損壞 */
  isAvailable(v) {
    return v.status === 'idle' && !this.isBroken(v);
  }

  /** 車庫容量（研究「車庫擴建」增加） */
  garageSize() {
    return GARAGE_SIZE + Math.floor(this.game.research.bonus('garageSlots'));
  }

  isFull() {
    return this.list.length >= this.garageSize();
  }

  /** 每人徒步運載量（研究「負重訓練」與背包增加；背包在探索時另計） */
  personCarry() {
    return Math.round(PERSON_CARRY * (1 + this.game.research.bonus('carryPct')));
  }

  /** 隊員運載量：徒步基準 + 背包容量 */
  memberCarry(sv) {
    const bag = this.game.equipment.getItem(sv?.equipment?.backpack);
    return this.personCarry() + (bag?.stats?.carry || 0);
  }

  create(type, durabilityRatio = 1) {
    const def = VEHICLES[type];
    return {
      id: uid('vh'), type, durability: Math.max(1, Math.round(def.durability * durabilityRatio)), status: 'idle',
    };
  }

  /** 加入車庫（滿了則回傳 false） */
  add(v, source = '') {
    if (this.isFull()) return false;
    this.list.push(v);
    this.game.log(`🚗 獲得載具 ${this.def(v).icon} ${this.def(v).name}${source ? `（${source}）` : ''}`, 'success');
    this.game.bus.emit('vehicles:changed');
    return true;
  }

  /** 探索時找到的載具（依建築類型），耐久 20～70% */
  rollFind(poiType) {
    const mul = VEHICLE_FIND_BY_POI[poiType] ?? 1;
    const type = weightedPick(Object.fromEntries(Object.entries(VEHICLES).map(([k, d]) => [k, d.find])));
    return { type, chance: 0.06 * mul * (1 + this.game.research.bonus('vehicleFindPct')), vehicle: this.create(type, randFloat(0.2, 0.7)) };
  }

  scrap(id) {
    const v = this.get(id);
    if (!v) return { ok: false, reason: '找不到載具' };
    if (v.status !== 'idle') return { ok: false, reason: '載具出勤中' };
    this.game.state.vehicles = this.list.filter((x) => x.id !== id);
    const metal = Math.round(this.def(v).durability * 0.3);
    this.game.grant({ metal });
    this.game.bus.emit('vehicles:changed');
    return { ok: true, msg: `已拆解 ${this.def(v).name}，回收金屬 ${metal}` };
  }

  // ---------- 維修 / 製作 ----------

  repairCostOf(v) {
    const mul = Math.max(0.3, 1 - this.game.research.bonus('repairCostReduce'));
    return Object.fromEntries(Object.entries(repairCost(v.type, this.maxDurability(v) - v.durability)).map(([k, n]) => [k, Math.max(1, Math.ceil(n * mul))]));
  }

  repair(id) {
    const v = this.get(id);
    if (!v) return { ok: false, reason: '找不到載具' };
    if (v.status !== 'idle') return { ok: false, reason: '載具出勤中' };
    if (v.durability >= this.maxDurability(v)) return { ok: false, reason: '不需要維修' };
    if (!payCost(this.game.state, this.repairCostOf(v))) return { ok: false, reason: '資源不足' };
    v.durability = this.maxDurability(v);
    this.game.bus.emit('vehicles:changed');
    return { ok: true, msg: `${this.def(v).name} 已修好` };
  }

  canCraft(type) {
    const c = VEHICLES[type].craft;
    if (!c) return { ok: false, reason: '無法製作' };
    if (this.game.shelter.maxLevel('workbench') < c.workbench) return { ok: false, reason: `需工作台 Lv${c.workbench}` };
    if (this.isFull()) return { ok: false, reason: `車庫已滿（${this.garageSize()}）` };
    if (!canAfford(this.game.state, c.cost)) return { ok: false, reason: '資源不足' };
    return { ok: true };
  }

  craft(type) {
    const check = this.canCraft(type);
    if (!check.ok) return check;
    payCost(this.game.state, VEHICLES[type].craft.cost);
    this.add(this.create(type), '製作');
    return { ok: true, msg: `製作完成：${VEHICLES[type].name}` };
  }

  // ---------- 探索 ----------

  /**
   * 隊伍的移動與運載。
   * @param {number} members 人數
   * @param {object[]} vehicles 載具
   * @param {number} distanceM 單程距離
   */
  tripStats(members, vehicles, distanceM = 0) {
    const rb = this.game.research.bonuses();
    const defs = vehicles.map((v) => this.def(v));
    // members 可以是人數或隊員陣列（陣列時計入背包容量）
    const list = Array.isArray(members) ? members : null;
    const count = list ? list.length : members;
    const seats = defs.reduce((s, d) => s + d.seats, 0);
    const seated = vehicles.length > 0 && seats >= count;
    const people = list ? list.reduce((s, m) => s + this.memberCarry(m), 0) : count * this.personCarry();
    return {
      seats,
      seated,
      // 所有隊員都有座位才能以載具速度移動（取最慢的一台），否則全隊步行
      speed: seated ? +(Math.min(...defs.map((d) => d.speed)) * (1 + (rb.vehicleSpeedPct || 0))).toFixed(2) : 1,
      cargo: Math.round(people + defs.reduce((s, d) => s + d.cargo, 0) * (1 + (rb.vehicleCargoPct || 0))),
      fuel: Math.ceil(defs.reduce((s, d) => s + d.fuelPerKm, 0) * (distanceM / 1000) * 2 * Math.max(0.3, 1 - (rb.vehicleFuelReduce || 0))),
    };
  }

  /**
   * 檢查出車：每台需要一名駕駛、不可損壞、油量足夠。
   * @returns {{ok:boolean, reason?:string, vehicles?:object[], stats?:object}}
   */
  validate(vehicleIds, members, distanceM) {
    const vehicles = vehicleIds.map((id) => this.get(id));
    if (vehicles.some((v) => !v || !this.isAvailable(v))) return { ok: false, reason: '有載具無法出車' };
    const count = Array.isArray(members) ? members.length : members;
    if (vehicles.length > count) return { ok: false, reason: '每台載具至少需要一名駕駛' };
    const stats = this.tripStats(members, vehicles, distanceM);
    if (stats.fuel > this.game.state.resources.fuel) return { ok: false, reason: `燃料不足（需要 ${stats.fuel}）` };
    return { ok: true, vehicles, stats };
  }

  depart(vehicles, fuel) {
    this.game.state.resources.fuel -= fuel;
    vehicles.forEach((v) => { v.status = 'out'; });
  }

  /** 返回車庫並計算磨損 */
  returnHome(vehicleIds, distanceM, ambushes = 0) {
    const out = [];
    vehicleIds.forEach((id) => {
      const v = this.get(id);
      if (!v) return;
      v.status = 'idle';
      let wear = (distanceM / 1000) * 2 * WEAR_PER_KM * randFloat(0.7, 1.3) * Math.max(0.3, 1 - this.game.research.bonus('vehicleWearReduce'));
      for (let i = 0; i < ambushes; i += 1) wear += randInt(...AMBUSH_WEAR);
      v.durability = Math.max(0, Math.round(v.durability - wear));
      if (v.durability <= 0) out.push(`🔧 ${this.def(v).name} 損壞了，需要維修才能再出車`);
    });
    if (vehicleIds.length) this.game.bus.emit('vehicles:changed');
    return out;
  }

  /** 撤退或召回：載具回到車庫（不計磨損以外的損失） */
  release(vehicleIds) {
    vehicleIds.forEach((id) => {
      const v = this.get(id);
      if (v) v.status = 'idle';
    });
  }

  /**
   * 搬家（放棄避難所）時能帶走的資源量：所有可行動的人 + 有人駕駛且未損壞的載具。
   */
  relocationCapacity() {
    const able = this.game.state.survivors.filter((s) => !s.severe);
    const people = able.length;
    const usable = this.list.filter((v) => !this.isBroken(v))
      .sort((a, b) => this.def(b).cargo - this.def(a).cargo)
      .slice(0, people);
    return { people, vehicles: usable, cargo: this.tripStats(able, usable).cargo };
  }
}
