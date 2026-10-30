/**
 * 防禦建築。位於避難所外圍的槽位，在 SiegeSystem 中自動攻擊殭屍。
 * range 以「世界單位」表示（避難所中心到外圍約 100）。
 */
const scale = (base, lv, g = 1.5) =>
  Object.fromEntries(Object.entries(base).map(([k, v]) => [k, Math.round(v * g ** (lv - 1))]));

export const DEFENSE_MAX_LEVEL = 10;

export const DEFENSES = {
  barricade: {
    name: '路障', icon: '🚧', color: 0x8d6e63, requires: null,
    desc: '強化圍牆耐久，並使附近殭屍減速。',
    cost: (lv) => scale({ wood: 40, metal: 10 }, lv),
    stats: (lv) => ({ wallBonus: 120 * lv, slow: 0.25, range: 26, damage: 0, fireRate: 0 }),
  },
  trap: {
    name: '陷阱', icon: '🪤', color: 0x795548, requires: null,
    desc: '對經過的殭屍造成持續傷害並緩速。',
    cost: (lv) => scale({ wood: 30, metal: 25 }, lv),
    stats: (lv) => ({ damage: 4 + lv * 3, fireRate: 2, range: 22, slow: 0.35, aoe: true }),
  },
  machineGun: {
    name: '機槍塔', icon: '🔫', color: 0x607d8b, requires: 'def1',
    desc: '高射速單體射擊。',
    cost: (lv) => scale({ metal: 90, fuel: 15 }, lv),
    stats: (lv) => ({ damage: 6 + lv * 4, fireRate: 4, range: 70 }),
  },
  flameTower: {
    name: '火焰塔', icon: '🔥', color: 0xff7043, requires: 'def2',
    desc: '範圍火焰傷害，對群聚殭屍特別有效。',
    cost: (lv) => scale({ metal: 110, fuel: 40 }, lv),
    stats: (lv) => ({ damage: 10 + lv * 6, fireRate: 1.2, range: 45, aoe: true, aoeRadius: 18 }),
  },
  emTower: {
    name: '電磁塔', icon: '🌀', color: 0x29b6f6, requires: 'def3',
    desc: '連鎖電擊並短暫麻痺目標。',
    cost: (lv) => scale({ metal: 140, fuel: 30, parts: 3 }, lv),
    stats: (lv) => ({ damage: 18 + lv * 9, fireRate: 0.8, range: 60, chain: 3, stun: 0.6 }),
  },
  watchPost: {
    name: '瞭望塔', icon: '🛖', color: 0xa1887f, requires: null,
    desc: '可派倖存者駐守，以其攻擊力狙擊殭屍。',
    cost: (lv) => scale({ wood: 70, metal: 30 }, lv),
    stats: (lv) => ({ damage: 0, fireRate: 0.8, range: 85 + lv * 3, garrison: true, garrisonMul: 0.8 + lv * 0.15 }),
  },
};

export const defenseBuildTime = (lv) => Math.round(6 * 1.55 ** (lv - 1));
