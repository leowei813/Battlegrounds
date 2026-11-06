/**
 * 🧬 脫胎換骨還你漂漂重生器：花金幣重新洗鍊倖存者的六項素質（v10.12）。
 *  - 費用 = base × 品級倍率 × (1 + 倖存者等級 × perLevel)
 *  - 每鎖住 1 種素質費用 +lockMul，並消耗 1 個「就是要鎖你」
 *  - 同一位倖存者當天每多洗一次 +dailyStep（台灣時間 00:00 重置）
 *  - 重生器每級 −facDiscount、研究「基因調理」每級 −4%，合計最多 −maxDiscount
 *  - 洗完可選「快樂重生」（採用新素質）或「還你原形」（維持原本），費用不退
 */
export const REBIRTH = {
  base: 100,
  perLevel: 0.1,
  rarityMul: { poor: 0.5, common: 1, uncommon: 1.5, rare: 2.5, epic: 4, legendary: 6 },
  lockMul: 0.5,
  dailyStep: 0.2,
  facDiscount: 0.03,
  maxDiscount: 0.7,
  /** 可鎖住的素質數：重生器 Lv1 可鎖 1 種、Lv6 起可鎖 2 種 */
  lockSlots: (lv) => (lv >= 6 ? 2 : lv >= 1 ? 1 : 0),
  /** 建造需要研究中心等級 */
  labReq: 4,
};

/** 「就是要鎖你」的取得 */
export const LOCK_ITEM = {
  name: '就是要鎖你',
  icon: '🔒',
  /** 搜索建築：每搜完一棟的基礎機率（× 區域倍率 ×（1 + 鎖定雷達）） */
  searchChance: 0.01,
  zoneMul: { safe: 0.6, normal: 1, alert: 1.3, danger: 1.7, lethal: 2.2, abyss: 3 },
  /** 攻陷 NPC 據點的機率 */
  npcChance: 0.4,
  /** 消滅重度感染據點：必得 1 個，參戰 bonusAt 人以上得 2 個 */
  infectBase: 1,
  infectBonusAt: 3,
  /** 黑市特殊品：價格與每日限購（台灣時間 00:00 重置） */
  bmPrice: 10000,
  bmDaily: 5,
};

/** 台灣時間的日期（YYYY-MM-DD），用於每日重置 */
export const twDay = (at = Date.now()) => new Date(at + 8 * 3600000).toISOString().slice(0, 10);
