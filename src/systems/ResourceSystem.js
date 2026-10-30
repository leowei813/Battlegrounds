import { RESOURCE_KEYS } from '../config/constants.js';
import { storageCap } from '../config/facilities.js';
import { JOBS, FOOD_PER_SURVIVOR_HOUR } from '../config/survivors.js';

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
  rates() {
    const st = this.game.state;
    const rb = this.game.research.bonuses();
    const gross = Object.fromEntries(RESOURCE_KEYS.map((k) => [k, 0]));
    const upkeep = Object.fromEntries(RESOURCE_KEYS.map((k) => [k, 0]));
    const now = Date.now();

    // 各據點設施產出加總；發電機只加成所在據點，並消耗燃料
    const genOn = this.generatorActive();
    let foodPct = rb.foodPct || 0;
    st.bases.forEach((b) => {
      const f = b.facilities;
      const mul = genOn ? 1 + f.generator.level * 0.06 : 1;
      gross.food += f.farm.level * 18 * (1 + f.rainCollector.level * 0.1) * mul;
      gross.medicine += f.rainCollector.level * 1.5 * mul;
      gross.wood += f.workbench.level * 8 * mul;
      gross.metal += f.workbench.level * 5 * mul;
      gross.cloth += f.workbench.level * 4 * mul;
      if (genOn) upkeep.fuel += f.generator.level * 2;
    });
    gross.medicine += rb.medicinePerHour || 0;
    gross.fuel += rb.fuelPerHour || 0;

    // 倖存者工作
    st.survivors.forEach((sv) => {
      if (sv.status !== 'idle' || sv.injuredUntil > now) return;
      if (this.game.survivors.isGarrisoned(sv.id)) return;
      const job = JOBS[sv.job] || JOBS.idle;
      const mul = (job.classBonus?.[sv.classId] || 1) * (1 + sv.level * 0.03);
      Object.entries(job.produce).forEach(([k, v]) => { gross[k] += v * mul; });
      const fx = this.game.survivors.skillEffects(sv);
      if (sv.job !== 'idle') gross.medicine += fx.medicinePerHour || 0;
      if (sv.job === 'farm') foodPct += fx.foodPct || 0;
    });
    gross.food *= 1 + foodPct;

    upkeep.food += st.survivors.length * FOOD_PER_SURVIVOR_HOUR;

    const net = Object.fromEntries(RESOURCE_KEYS.map((k) => [k, gross[k] - upkeep[k]]));
    return { net, gross, upkeep };
  }

  /** 套用 dtMs 時間的生產，回傳實際變化量 */
  apply(dtMs) {
    const { net } = this.rates();
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
    if (delta.food > 0) this.game.state.stats.foodCollected += delta.food;
    return delta;
  }
}
