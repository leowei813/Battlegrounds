import { RESOURCE_KEYS } from '../config/constants.js';
import {
  storageCap, FARM_FOOD, RAIN_MEDICINE, WORKBENCH,
} from '../config/facilities.js';
import { JOBS, FOOD_PER_SURVIVOR_HOUR, FOOD_PER_SURVIVOR_HOUR_OFFLINE } from '../config/survivors.js';
import { isSupply } from '../config/supplies.js';

/**
 * 資源系統：計算每小時產出/消耗並套用到狀態上。
 * 線上每秒呼叫 apply(dt)；離線時以同一函式一次套用經過時間（上限 24 小時）。
 */
export class ResourceSystem {
  constructor(game) {
    this.game = game;
  }

  /** 資源上限：所有據點倉庫容量加總 */
  storageCap() {
    const sum = this.game.state.bases.reduce((s, b) => s + (b.facilities.warehouse.level > 0 ? storageCap(b.facilities.warehouse.level) : 0), 0);
    return Math.round(Math.max(storageCap(0), sum) * (1 + this.game.research.bonus('storagePct')));
  }

  /** 發電機是否有燃料可運作 */
  generatorActive() {
    return this.game.state.resources.fuel > 0.5;
  }

  /**
   * @returns {{net: Record<string,number>, gross: Record<string,number>, upkeep: Record<string,number>}}
   */
  /** @param {{offline?:boolean}} [opts] offline：離線期間的食物消耗較低 */
  rates({ offline = false } = {}) {
    const st = this.game.state;
    const rb = this.game.research.bonuses();
    // 可能含材料物品（例如紗布、釘子），不在表中的鍵視為 0
    const zero = () => new Proxy(Object.fromEntries(RESOURCE_KEYS.map((k) => [k, 0])), {
      get: (t, k) => (k in t ? t[k] : 0),
    });
    const gross = zero();
    const upkeep = zero();

    // 只有避難所會生產（前哨站只有防禦功能）；發電機消耗燃料加成產出
    const genOn = this.generatorActive();
    let foodPct = rb.foodPct || 0;
    st.bases.filter((b) => b.kind !== 'outpost').forEach((b) => {
      const f = b.facilities;
      const mul = genOn ? 1 + f.generator.level * 0.06 * (1 + (rb.generatorPct || 0)) : 1;
      const rain = 1 + (rb.rainPct || 0);
      const wb = 1 + (rb.workbenchPct || 0);
      gross.food += f.farm.level * (FARM_FOOD + (rb.farmFlat || 0)) * (1 + f.rainCollector.level * 0.1 * rain) * mul;
      gross.gauze += f.rainCollector.level * RAIN_MEDICINE * rain * mul;
      Object.entries(WORKBENCH).forEach(([k, v]) => { gross[k] += f.workbench.level * v * wb * mul; });
      if (genOn) upkeep.fuel += f.generator.level * 2 * Math.max(0.3, 1 - (rb.generatorFuelReduce || 0));
    });
    gross.gauze += rb.medicinePerHour || 0;
    gross.fuel += rb.fuelPerHour || 0;

    // 倖存者工作
    st.survivors.forEach((sv) => {
      if (sv.status !== 'idle' || sv.severe) return;
      if (this.game.survivors.isGarrisoned(sv.id)) return;
      const job = JOBS[sv.job] || JOBS.idle;
      const mul = (job.classBonus?.[sv.classId] || 1) * (1 + sv.level * 0.03);
      Object.entries(job.produce).forEach(([k, v]) => { gross[k] += v * mul; });
      const fx = this.game.survivors.skillEffects(sv);
      if (sv.job !== 'idle') gross.gauze += fx.medicinePerHour || 0;
      if (sv.job === 'farm') foodPct += fx.foodPct || 0;
    });
    gross.food *= 1 + foodPct;

    const perHead = offline ? FOOD_PER_SURVIVOR_HOUR_OFFLINE : FOOD_PER_SURVIVOR_HOUR;
    upkeep.food += st.survivors.length * perHead * Math.max(0.5, 1 - (rb.foodUpkeepReduce || 0));

    const keys = [...new Set([...RESOURCE_KEYS, ...Object.keys(gross), ...Object.keys(upkeep)])].filter((k) => gross[k] || upkeep[k] || RESOURCE_KEYS.includes(k));
    const plain = (o) => Object.fromEntries(keys.map((k) => [k, o[k]]));
    const net = Object.fromEntries(keys.map((k) => [k, gross[k] - upkeep[k]]));
    return { net, gross: plain(gross), upkeep: plain(upkeep) };
  }

  /**
   * 套用 dtMs 時間的生產，回傳實際變化量。
   * 同時計算飢餓：食物見底且淨收入為負時，所有人員進入飢餓狀態；
   * `lastStarvingMs` 為本區間內處於飢餓的時間（飢餓發生在區間末段）。
   */
  apply(dtMs, { offline = false } = {}) {
    const { net } = this.rates({ offline });
    const foodBefore = this.game.state.resources.food;
    const cap = this.storageCap();
    const res = this.game.state.resources;
    const hours = dtMs / 3600000;
    const delta = {};
    RESOURCE_KEYS.forEach((k) => {
      const before = res[k];
      let after = before + net[k] * hours;
      // 若原本就超過上限（例如任務獎勵），不再增加但也不扣除
      after = Math.max(0, net[k] > 0 ? Math.min(Math.max(cap, before), after) : after);
      res[k] = after;
      delta[k] = after - before;
    });
    // 材料物品（紗布、釘子…）：累積小數，滿 1 個才放進物品倉庫
    const st = this.game.state;
    st.prodAcc = st.prodAcc || {};
    Object.entries(net).forEach(([k, v]) => {
      if (!isSupply(k) || v <= 0) return;
      st.prodAcc[k] = (st.prodAcc[k] || 0) + v * hours;
      const whole = Math.floor(st.prodAcc[k]);
      if (whole < 1) return;
      st.prodAcc[k] -= whole;
      const got = this.game.equipment.addSupplies({ [k]: whole });
      delta[k] = got[k] || 0;
    });
    if (delta.food > 0) this.game.state.stats.foodCollected += delta.food;
    if (net.food < 0) {
      const msToEmpty = (foodBefore / -net.food) * 3600000;
      this.lastStarvingMs = Math.max(0, dtMs - msToEmpty);
    } else {
      this.lastStarvingMs = 0;
    }
    const starving = res.food <= 0.01 && net.food < 0;
    if (starving && !this.game.state.starving) this.game.log('🍽️ 食物耗盡，所有人員進入飢餓狀態！', 'danger');
    if (!starving && this.game.state.starving) this.game.log('🥫 恢復食物供給，飢餓解除', 'success');
    this.game.state.starving = starving;
    return delta;
  }
}
