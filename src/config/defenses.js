import { materialize, tierFromLevel } from './supplies.js';
import {
  MAX_LEVEL, timeCurve, costCurve, hardMul, HARD_PLAIN, HARD_MAT,
} from './leveling.js';

/**
 * 防禦建築。位於避難所外圍的槽位，在 SiegeSystem 中自動攻擊殭屍。
 * range 以「世界單位」表示（避難所中心到外圍約 100）。
 */
const scale = (base, lv, g = 1.7) =>
  Object.fromEntries(Object.entries(base).map(([k, v]) => [k, Math.round(v * costCurve(lv, g) * hardMul(lv, HARD_PLAIN))]));

export const DEFENSE_MAX_LEVEL = MAX_LEVEL;

/**
 * 升級費用：木材、燃料等依等級快速成長；抽象的金屬／布料／藥品換算成具體零件與布料，
 * 等級越高越需要高階零件（數量成長較慢，但高階零件難找）。
 */
const MAT_KEYS = ['metal', 'cloth', 'medicine'];
const mat = (key, tags, base, lv) => {
  const plain = scale(Object.fromEntries(Object.entries(base).filter(([k]) => !MAT_KEYS.includes(k))), lv);
  const abstract = Object.fromEntries(Object.entries(base).filter(([k]) => MAT_KEYS.includes(k)).map(([k, v]) => [k, v * costCurve(lv, 1.3) * hardMul(lv, HARD_MAT)]));
  return materialize({ ...plain, ...abstract }, { tier: tierFromLevel(lv, DEFENSE_MAX_LEVEL), tags, key });
};

export const DEFENSES = {
  barricade: {
    name: '路障', icon: '🚧', color: 0x8d6e63, requires: null,
    desc: '強化圍牆耐久，並使附近殭屍減速。',
    cost: (lv) => mat('barricade', ['struct'], { wood: 40, metal: 10 }, lv),
    stats: (lv) => ({ wallBonus: 120 * lv, slow: 0.25, range: 26, damage: 0, fireRate: 0 }),
  },
  trap: {
    name: '尖刺陷阱', icon: '🪤', color: 0x795548, requires: null,
    desc: '圍牆外的尖刺坑，對接近圍牆的殭屍造成持續傷害並緩速。',
    cost: (lv) => mat('trap', ['mech', 'struct'], { wood: 30, metal: 25 }, lv),
    stats: (lv) => ({ damage: 4 + lv * 3, fireRate: 2, range: 22, slow: 0.35, aoe: true }),
  },
  electricFence: {
    name: '電網', icon: '⚡', color: 0xffca28, requires: 'd_fence', power: true,
    desc: '通電的圍網，持續電擊貼近圍牆的所有殭屍並短暫麻痺。需要據點的發電機運轉（有燃料）才會作用。',
    cost: (lv) => mat('electricFence', ['elec', 'struct'], { metal: 100, fuel: 25 }, lv),
    stats: (lv) => ({ damage: 6 + lv * 4, fireRate: 1, range: 14, stun: 0.3, aoe: true }),
  },
  machineGun: {
    name: '機槍塔', icon: '🔫', color: 0x607d8b, requires: 'd_mg',
    desc: '高射速單體射擊。',
    cost: (lv) => mat('machineGun', ['mech'], { metal: 90, fuel: 15 }, lv),
    stats: (lv) => ({ damage: 6 + lv * 4, fireRate: 4, range: 70 }),
  },
  flameTower: {
    name: '火焰塔', icon: '🔥', color: 0xff7043, requires: 'd_flame',
    desc: '範圍火焰傷害，對群聚殭屍特別有效。',
    cost: (lv) => mat('flameTower', ['mech', 'elec'], { metal: 110, fuel: 40 }, lv),
    stats: (lv) => ({ damage: 10 + lv * 6, fireRate: 1.2, range: 45, aoe: true, aoeRadius: 18 }),
  },
  emTower: {
    name: '電磁塔', icon: '🌀', color: 0x29b6f6, requires: 'd_em',
    desc: '連鎖電擊並短暫麻痺目標。',
    cost: (lv) => mat('emTower', ['elec'], { metal: 140, fuel: 30, parts: 3 }, lv),
    stats: (lv) => ({ damage: 18 + lv * 9, fireRate: 0.8, range: 60, chain: 3, stun: 0.6 }),
  },
  watchPost: {
    name: '瞭望塔', icon: '🛖', color: 0xa1887f, requires: null,
    desc: '可派倖存者駐守，以其攻擊力狙擊殭屍。',
    cost: (lv) => mat('watchPost', ['struct', 'mech'], { wood: 70, metal: 30 }, lv),
    stats: (lv) => ({ damage: 0, fireRate: 0.8, range: 85 + lv * 3, garrison: true, garrisonMul: 0.8 + lv * 0.15 }),
  },
};

/** 施工秒數：Lv1 10 秒、Lv6 約 1 分、Lv10 約 2 小時、Lv15 約 20 天 */
export const defenseBuildTime = (lv) => Math.round(10 * timeCurve(lv, 1.5, 3.05));
