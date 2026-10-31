import { CIV_WEIGHTS, CIV_TIERS, SIEGE_SCALING } from '../config/civilization.js';
import { SLOT_KEYS } from '../config/equipment.js';

const CACHE_MS = 1000;

/**
 * 文明度系統：彙總建築、玩家等級、裝備，並提供屍潮強度所需的係數。
 */
export class CivilizationSystem {
  constructor(game) {
    this.game = game;
    this.cache = null;
    this.cachedAt = 0;
  }

  /** @returns {{total:number, buildings:number, player:number, equipment:number}} */
  breakdown() {
    const now = Date.now();
    if (this.cache && now - this.cachedAt < CACHE_MS) return this.cache;
    const st = this.game.state;
    let facilityLevels = 0;
    let defenseLevels = 0;
    st.bases.forEach((b) => {
      Object.values(b.facilities).forEach((f) => { facilityLevels += f.level; });
      b.defenses.forEach((d) => { defenseLevels += d.level; });
    });
    const buildings = facilityLevels * CIV_WEIGHTS.facilityLevel + defenseLevels * CIV_WEIGHTS.defenseLevel;
    const player = (this.game.survivors.leader()?.level || 1) * CIV_WEIGHTS.playerLevel;
    let power = 0;
    st.survivors.forEach((sv) => SLOT_KEYS.forEach((slot) => {
      power += this.game.equipment.getItem(sv.equipment[slot])?.power || 0;
    }));
    const equipment = power * CIV_WEIGHTS.equipmentPower;
    const total = Math.round(buildings + player + equipment);
    this.cache = {
      total, buildings: Math.round(buildings), player: Math.round(player), equipment: Math.round(equipment),
    };
    this.cachedAt = now;
    if (total > (st.stats.peakCivilization || 0)) st.stats.peakCivilization = total;
    return this.cache;
  }

  value() {
    return this.breakdown().total;
  }

  invalidate() {
    this.cache = null;
  }

  tier(v = this.value()) {
    let t = CIV_TIERS[0];
    CIV_TIERS.forEach((x) => { if (v >= x.min) t = x; });
    const next = CIV_TIERS.find((x) => x.min > v) || null;
    return { ...t, next };
  }

  /** 超過開局基準的文明度 */
  effective() {
    return Math.max(0, this.value() - SIEGE_SCALING.civBaseline);
  }

  /** 文明度帶來的殭屍等級加成 */
  levelBonus() {
    return Math.floor(this.effective() / SIEGE_SCALING.civPerLevel);
  }

  /** 文明度帶來的屍潮頻率倍率 */
  spawnMul() {
    return Math.min(SIEGE_SCALING.maxSpawnMul, 1 + this.effective() * SIEGE_SCALING.spawnPerCiv);
  }

  /** 文明度低時屍潮殭屍較弱的倍率（0.6～1） */
  weakMul() {
    const S = SIEGE_SCALING;
    return S.weakMin + (1 - S.weakMin) * Math.min(1, this.value() / S.weakCiv);
  }

  /** 屍潮殭屍的生命倍率 */
  siegeHpMul() {
    return this.weakMul() * (1 + this.effective() * SIEGE_SCALING.hpPerCiv);
  }

  /** 屍潮殭屍的攻擊倍率 */
  siegeAtkMul() {
    return this.weakMul() * (1 + this.effective() * SIEGE_SCALING.atkPerCiv);
  }

  /** 每晚最多幾波屍潮：新手（文明度未達門檻）只有 1 波，文明度階級越高波數越多 */
  maxWaves() {
    if (this.effective() <= 0) return 1;
    const idx = CIV_TIERS.indexOf(CIV_TIERS.filter((t) => this.value() >= t.min).pop());
    return SIEGE_SCALING.wavesByTier[Math.max(0, idx)] || 1;
  }

  /** 每波殭屍數量倍率：文明度越低越少 */
  waveSizeMul() {
    const S = SIEGE_SCALING;
    return S.waveSizeMin + (S.waveSizeMax - S.waveSizeMin) * Math.min(1, this.value() / S.waveSizeCiv);
  }

  unlocked(enemyKey) {
    return this.value() >= (SIEGE_SCALING.unlock[enemyKey] ?? 0);
  }
}
