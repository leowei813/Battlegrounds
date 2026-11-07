/**
 * 材料物品（v8）：零件、布料、藥品、彈藥。
 *
 * 這些都是「可堆疊的一般物品」：放在物品倉庫或隊員背包，同種類每格最多堆疊 9999。
 * 建造、升級、研究、製作與維修會消耗相關的零件與布料；藥品用來治療；槍械需要彈藥、弓弩需要箭矢。
 *
 *  - cat     類別：part 零件、fabric 布料、med 藥品、ammo 彈藥
 *  - tier    1～5：越高越稀有，越常用在高階建築與裝備
 *  - tag     零件用途：struct 結構、mech 機械、elec 電子、gun 槍械（決定哪些建築與裝備會用到）
 *  - weight  每個的重量（計入負重）
 *  - heal    藥品回復最大生命的比例
 */
const s = (cat, name, icon, tier, weight, opts = {}) => ({
  cat, name, icon, tier, weight, ...opts,
});

export const SUPPLY_CATS = {
  part: { name: '零件', icon: '🔩' },
  fabric: { name: '布料', icon: '🧵' },
  med: { name: '藥品', icon: '💊' },
  ammo: { name: '彈藥', icon: '🎯' },
};

export const SUPPLIES = {
  // ---- 零件：結構 ----
  nail: s('part', '釘子', '📌', 1, 0.02, { tag: 'struct' }),
  screw: s('part', '螺絲', '🔩', 1, 0.02, { tag: 'struct' }),
  scrap: s('part', '廢鐵', '🥫', 1, 0.5, { tag: 'struct' }),
  ironWire: s('part', '鐵絲', '➰', 1, 0.1, { tag: 'struct' }),
  glass: s('part', '玻璃片', '🪟', 1, 0.3, { tag: 'struct' }),
  hinge: s('part', '鉸鍊', '🚪', 2, 0.2, { tag: 'struct' }),
  ironPlate: s('part', '鐵板', '⬛', 2, 1, { tag: 'struct' }),
  rebar: s('part', '鋼筋', '🦯', 2, 1, { tag: 'struct' }),
  steelPipe: s('part', '鋼管', '🪈', 3, 1, { tag: 'struct' }),
  steelPlate: s('part', '鋼板', '🛡️', 3, 1.5, { tag: 'struct' }),
  aluminum: s('part', '鋁板', '🔲', 3, 0.5, { tag: 'struct' }),
  alloyPlate: s('part', '合金板', '💠', 4, 1.2, { tag: 'struct' }),
  titanium: s('part', '鈦合金', '🔷', 5, 0.8, { tag: 'struct' }),
  // ---- 零件：機械 ----
  bolt: s('part', '螺栓', '🔧', 1, 0.05, { tag: 'mech' }),
  rubber: s('part', '橡膠', '⚫', 1, 0.2, { tag: 'mech' }),
  spring: s('part', '彈簧', '🌀', 2, 0.05, { tag: 'mech' }),
  gear: s('part', '齒輪', '⚙️', 2, 0.2, { tag: 'mech' }),
  chain: s('part', '鏈條', '⛓️', 2, 0.5, { tag: 'mech' }),
  bearing: s('part', '軸承', '🛞', 3, 0.3, { tag: 'mech' }),
  valve: s('part', '閥門', '🚰', 3, 0.4, { tag: 'mech' }),
  firingPin: s('part', '擊針', '📍', 3, 0.05, { tag: 'gun' }),
  piston: s('part', '活塞', '🔨', 4, 0.8, { tag: 'mech' }),
  hydraulic: s('part', '液壓缸', '🧯', 4, 1.5, { tag: 'mech' }),
  barrel: s('part', '槍管', '🔫', 4, 0.8, { tag: 'gun' }),
  precision: s('part', '精密零件', '🎛️', 5, 0.1, { tag: 'mech' }),
  // ---- 零件：彈藥材料（只用在子彈製作，不會出現在建造與裝備的成本） ----
  casing: s('part', '彈殼', '🥉', 1, 0.005, { tag: 'ammo' }),
  // ---- 零件：電子 ----
  tape: s('part', '絕緣膠帶', '🩹', 1, 0.05, { tag: 'elec' }),
  wire: s('part', '電線', '🔌', 1, 0.1, { tag: 'elec' }),
  bulb: s('part', '燈泡', '💡', 1, 0.1, { tag: 'elec' }),
  plastic: s('part', '塑膠外殼', '📦', 1, 0.2, { tag: 'elec' }),
  battery: s('part', '電池', '🔋', 2, 0.2, { tag: 'elec' }),
  copperCoil: s('part', '銅線圈', '🧲', 2, 0.3, { tag: 'elec' }),
  switch: s('part', '開關', '🎚️', 2, 0.1, { tag: 'elec' }),
  circuit: s('part', '電路板', '🟩', 3, 0.2, { tag: 'elec' }),
  motor: s('part', '馬達', '🌪️', 3, 1.5, { tag: 'elec' }),
  icBoard: s('part', 'IC 板', '🧮', 4, 0.1, { tag: 'elec' }),
  sensor: s('part', '感測器', '📡', 4, 0.2, { tag: 'elec' }),
  solarCell: s('part', '太陽能板', '☀️', 5, 1, { tag: 'elec' }),
  chip: s('part', '晶片', '💾', 5, 0.05, { tag: 'elec' }),
  // ---- 布料 ----
  coarse: s('fabric', '粗布', '🟫', 1, 0.2),
  cotton: s('fabric', '棉布', '⬜', 1, 0.2),
  linen: s('fabric', '麻布', '🟨', 1, 0.2),
  canvas: s('fabric', '帆布', '⛺', 2, 0.3),
  nylon: s('fabric', '尼龍布', '🟦', 2, 0.15),
  leather: s('fabric', '皮革', '🟤', 2, 0.4),
  techCotton: s('fabric', '科技棉', '🧊', 3, 0.15),
  ballistic: s('fabric', '防彈纖維', '🦺', 4, 0.3),
  reinforced: s('fabric', '強化布料', '🧶', 4, 0.3),
  kevlar: s('fabric', '克維拉', '🛡️', 5, 0.25),
  // ---- 藥品（回復最大生命的比例） ----
  gauze: s('med', '紗布', '🩹', 1, 0.05, { heal: 0.1 }),
  bandage: s('med', '繃帶', '🩹', 1, 0.05, { heal: 0.15 }),
  vitamin: s('med', '維他命', '💊', 1, 0.02, { heal: 0.12 }),
  painkiller: s('med', '止痛藥', '💊', 2, 0.02, { heal: 0.22 }),
  antibiotic: s('med', '抗生素', '💉', 3, 0.05, { heal: 0.35 }),
  smallKit: s('med', '小型醫藥箱', '🩺', 3, 0.5, { heal: 0.45 }),
  mediumKit: s('med', '中型醫藥箱', '🧰', 4, 1, { heal: 0.7 }),
  largeKit: s('med', '大型醫藥箱', '🏥', 5, 2, { heal: 1 }),
  // ---- 彈藥 ----
  ammo9: s('ammo', '9mm 子彈', '🟡', 1, 0.01),
  shell12: s('ammo', '12 號霰彈', '🔴', 2, 0.04),
  ammo556: s('ammo', '5.56 步槍彈', '🟠', 3, 0.012),
  ammo762: s('ammo', '7.62 機槍彈', '🟤', 3, 0.015),
  ammo308: s('ammo', '.308 狙擊彈', '⚪', 4, 0.025),
  arrow: s('ammo', '箭矢', '🏹', 1, 0.03),
};
export const SUPPLY_KEYS = Object.keys(SUPPLIES);
export const isSupply = (k) => !!SUPPLIES[k];
/** 每單位重量：材料物品依設定，基本資源每單位 1 */
export const unitWeight = (k) => SUPPLIES[k]?.weight ?? 1;
export const suppliesOf = (cat, maxTier = 5, minTier = 1) => SUPPLY_KEYS
  .filter((k) => SUPPLIES[k].cat === cat && SUPPLIES[k].tier <= maxTier && SUPPLIES[k].tier >= minTier);

/** 各武器類別使用的彈藥，與每場戰鬥消耗的數量 */
export const AMMO_FOR = {
  pistol: { ammo: 'ammo9', perFight: 4 },
  smg: { ammo: 'ammo9', perFight: 9 },
  shotgun: { ammo: 'shell12', perFight: 3 },
  rifle: { ammo: 'ammo556', perFight: 6 },
  sniper: { ammo: 'ammo308', perFight: 2 },
  lmg: { ammo: 'ammo762', perFight: 14 },
  crossbow: { ammo: 'arrow', perFight: 3 },
};
/** 避難所防守時每次射擊消耗的彈藥（衝鋒槍、輕機槍連發較耗彈） */
export const ammoPerShot = (type) => Math.max(1, Math.round((AMMO_FOR[type]?.perFight || 6) / 6));

/** 出發時自動從倉庫補給的彈藥（場數） */
export const AMMO_PACK_FIGHTS = 4;

/** 彈藥製作（工作台）：一次產出 batch 個。子彈以彈殼為主要材料，只有 .308 需要稀有零件 */
export const AMMO_RECIPES = {
  arrow: { bench: 0, batch: 15, cost: { wood: 6, nail: 2 } },
  // 子彈：研究「槍械製造」Lv1、工作台 Lv3 即可製作全部種類
  casing: { bench: 3, batch: 10, cost: { scrap: 2 }, gun: 1 },
  ammo9: { bench: 3, batch: 30, cost: { casing: 15, scrap: 1, fuel: 2 }, gun: 1 },
  shell12: { bench: 3, batch: 15, cost: { casing: 8, plastic: 1, fuel: 3 }, gun: 1 },
  ammo556: { bench: 3, batch: 30, cost: { casing: 15, scrap: 2, screw: 2, fuel: 4 }, gun: 1 },
  ammo762: { bench: 3, batch: 30, cost: { casing: 15, scrap: 2, screw: 2, fuel: 5 }, gun: 1 },
  ammo308: { bench: 3, batch: 10, cost: { casing: 5, steelPipe: 1, firingPin: 1, fuel: 5 }, gun: 1 },
};

/**
 * 藥品製作（診療室）：依診療室等級解鎖，一次產出 batch 個。
 * 投入的藥品回復量不超過產出的約 6 成，確保製作划算。大型醫藥箱不能製作。
 */
export const MED_RECIPES = {
  gauze: { clinic: 1, batch: 5, cost: { cotton: 2 } },
  bandage: { clinic: 1, batch: 5, cost: { cotton: 2, coarse: 1 } },
  vitamin: { clinic: 3, batch: 5, cost: { food: 15 } },
  painkiller: { clinic: 5, batch: 3, cost: { vitamin: 1, plastic: 1 } },
  antibiotic: { clinic: 7, batch: 2, cost: { painkiller: 1, glass: 1, fuel: 3 } },
  smallKit: { clinic: 9, batch: 2, cost: { bandage: 2, gauze: 2, canvas: 1, plastic: 1 } },
  mediumKit: { clinic: 12, batch: 2, cost: { smallKit: 1, antibiotic: 1, canvas: 1, plastic: 2 } },
};

/** 用掉的子彈回收成彈殼、射出的箭矢回收的比例 */
export const AMMO_RECOVER = 0.3;
/** 用掉某種彈藥後回收的物品：箭矢直接回收，子彈回收彈殼 */
export const recoverKeyOf = (ammoKey) => (ammoKey === 'arrow' ? 'arrow' : 'casing');
/** 把小數的回收量依機率取整數 */
export const rollRecover = (map, rnd = Math.random) => Object.fromEntries(Object.entries(map)
  .map(([k, v]) => [k, Math.floor(v) + (rnd() < v - Math.floor(v) ? 1 : 0)]).filter(([, v]) => v > 0));

/** 彈藥的基準價（不再依階級大幅提高）：黑市售價 = 基準價 × AMMO_SELL_MUL */
export const AMMO_PRICE = { casing: 1, arrow: 2, ammo9: 2, ammo556: 2, ammo762: 2, shell12: 3, ammo308: 3 };
export const AMMO_SELL_MUL = 2;

/** 治療藥品的出現權重（回復量越高越稀有） */
export const medWeight = (k) => {
  const h = SUPPLIES[k].heal || 0.1;
  return Math.max(0.15, 10 * (0.12 / h) ** 2);
};

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** 依階級挑選固定的材料（同一用途同一階級結果固定，費用顯示不會跳動） */
function pickFixed(list, seed, n) {
  const pool = [...list];
  const out = [];
  let h = hash(seed);
  while (out.length < n && pool.length) {
    out.push(pool.splice(h % pool.length, 1)[0]);
    h = hash(`${h}`);
  }
  return out;
}

/** 階級：依建築／裝備的等級換算 1～5 */
export const tierFromLevel = (lv, maxLv = 10) => Math.max(1, Math.min(5, Math.ceil((lv / maxLv) * 5)));

/**
 * 把抽象的「金屬／布料／藥品」需求換算成具體零件、布料與藥品。
 * 例如 { wood: 80, metal: 40 } 在 3 階結構用途 → { wood: 80, steelPlate: 3, rebar: 4, nail: 6 }。
 *
 * @param {Record<string, number>} cost  可含 metal / cloth / medicine（抽象量）與其他資源
 * @param {{tier?:number, tags?:string[], key?:string}} opts 階級、零件用途、固定挑選用的種子
 */
export function materialize(cost, { tier = 1, tags = ['struct'], key = '' } = {}) {
  const out = {};
  const add = (k, v) => { if (v > 0) out[k] = (out[k] || 0) + v; };
  Object.entries(cost).forEach(([k, v]) => {
    if (k === 'metal') {
      // 主要零件取當前階級，次要零件取低一階（數量較多）
      const main = SUPPLY_KEYS.filter((x) => SUPPLIES[x].cat === 'part' && tags.includes(SUPPLIES[x].tag) && SUPPLIES[x].tier === tier);
      const low = SUPPLY_KEYS.filter((x) => SUPPLIES[x].cat === 'part' && tags.includes(SUPPLIES[x].tag) && SUPPLIES[x].tier === Math.max(1, tier - 1));
      const [a, b] = pickFixed(main.length ? main : low, `${key}|m|${tier}`, 2);
      const [c] = pickFixed(low, `${key}|l|${tier}`, 1);
      const units = v / (2 + tier * 1.5); // 高階零件單價高，需要的數量較少
      add(a, Math.max(1, Math.round(units * 0.5)));
      if (b) add(b, Math.round(units * 0.3));
      if (c && c !== a && c !== b) add(c, Math.round(units * 0.8));
    } else if (k === 'cloth') {
      const main = suppliesOf('fabric', tier, tier);
      const low = suppliesOf('fabric', Math.max(1, tier - 1), Math.max(1, tier - 1));
      const [a] = pickFixed(main.length ? main : low, `${key}|f|${tier}`, 1);
      const [c] = pickFixed(low, `${key}|fl|${tier}`, 1);
      const units = v / (2 + tier);
      add(a, Math.max(1, Math.round(units * 0.6)));
      if (c && c !== a) add(c, Math.round(units * 0.6));
    } else if (k === 'medicine') {
      const meds = suppliesOf('med', tier, Math.max(1, tier - 1));
      const [a] = pickFixed(meds, `${key}|md|${tier}`, 1);
      add(a, Math.max(1, Math.round(v / (2 + tier * 2))));
    } else add(k, v);
  });
  return out;
}

/** 舊存檔：金屬、布料、藥品換算成材料物品 */
export function legacyToSupplies({ metal = 0, cloth = 0, medicine = 0 } = {}) {
  const out = {};
  const add = (k, v) => { const n = Math.floor(v); if (n > 0) out[k] = (out[k] || 0) + n; };
  add('screw', metal * 0.25);
  add('nail', metal * 0.25);
  add('scrap', metal * 0.2);
  add('bolt', metal * 0.15);
  add('wire', metal * 0.1);
  add('ironPlate', metal * 0.05);
  add('coarse', cloth * 0.3);
  add('cotton', cloth * 0.3);
  add('linen', cloth * 0.2);
  add('bandage', medicine * 0.5);
  add('gauze', medicine * 0.5);
  return out;
}
