/**
 * 自有意識的 NPC 據點：隨機出現在地圖上，會升級、外出探索（搶先搜刮建築），
 * 也會掠奪玩家據點。玩家文明度越高，NPC 越積極。屍潮來襲（夜晚）時 NPC 不會出動攻擊。
 */
export const NPC_CONFIG = {
  perCell: 2, // 每個格子（約 0.9 公里見方）內的 NPC 據點數
  cellKm: 0.9, // 格子大小（約 0.9 公里見方）
  keepRatio: 2 / 3, // 每個名額有此機率出現 NPC（依格子種子固定，所有玩家相同）：密度約每平方公里 1.6 個
  minFromShelterM: 300, // 不會出現在避難所旁邊
  respawnMs: [30 * 60000, 60 * 60000], // 被摧毀後重新出現的時間
  levelUpMs: [90 * 60000, 150 * 60000], // 升級間隔
  maxLevel: 40,
  exploreEveryMs: [30 * 60000, 55 * 60000], // 外出探索間隔（回來後休息一段時間才再出發）
  exploreRadiusM: 900,
  raidBaseMs: 3 * 3600000, // 每 3 個 NPC 的掠奪基礎間隔（NPC 越多，個別越少出手；依積極度縮短）
  walkMinPerKm: 4, // NPC 隊伍移動速度（每公里分鐘）
  searchMs: 10 * 60000,
  raidStealPct: 0.15, // 掠奪成功時搶走的資源比例
  raidWallDamage: 0.3, // 掠奪成功時圍牆損失
  /**
   * NPC 只掠奪等級在「倖存者中等級最高 6 人的平均等級 × 倍率」以內（最多高出 raidLevelGap 級）的玩家。
   * 倍率隨平均等級提高：0.8 + 平均等級 × 0.18（Lv4.5 約 ×1.6、Lv7.5 約 ×2.2、Lv10 約 ×2.6）。
   */
  raidLevelMul: { base: 0.8, perLevel: 0.18 },
  raidLevelGap: 20,
  /** 高等級 NPC 的人數：from 級起每 step 級多 1 人 */
  lateGarrison: { from: 28, step: 2 },
  woundHealMs: 20 * 60000, // NPC 傷亡人員每隔多久補回 1 人
  /** 同時有其他 NPC 正在掠奪玩家時，再發動掠奪的機率（文明度達到 concurrentCiv 後才逐漸提高） */
  concurrentChance: 0.05,
  concurrentCiv: 350,
  concurrentMax: 0.5,
  /** NPC 探索時遭遇殭屍而受傷的基礎機率（依區域安全程度與夜晚調整） */
  exploreInjuryChance: 0.25,
  /** 玩家防守成功時，與掠奪隊交火造成的損傷：每位防守人員損失最大生命的比例範圍、圍牆損失比例（依掠奪者人數） */
  skirmishHp: [0.05, 0.18],
  skirmishWall: 0.012,
};

export const NPC_NAMES = ['鐵狼幫', '紅蠍團', '黑鴉會', '血月營', '禿鷹隊', '野犬幫', '灰燼兄弟', '毒牙團', '荒原騎士', '碎骨幫', '夜梟會', '鏽刃團'];

/**
 * 積極度（0.1～1）：玩家文明度越高，NPC 越常來掠奪。
 * @param {number} civ 文明度
 */
export const npcAggression = (civ) => Math.min(1, Math.max(0.1, civ / 200));
