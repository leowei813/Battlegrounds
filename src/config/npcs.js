/**
 * 自有意識的 NPC 據點：隨機出現在地圖上，會升級、外出探索（搶先搜刮建築），
 * 也會掠奪玩家據點。玩家文明度越高，NPC 越積極。屍潮來襲（夜晚）時 NPC 不會出動攻擊。
 */
export const NPC_CONFIG = {
  perCell: 3, // 每 1 平方公里（1 公里格子）內的 NPC 據點數
  cellKm: 1,
  minFromShelterM: 300, // 不會出現在避難所旁邊
  respawnMs: [30 * 60000, 60 * 60000], // 被摧毀後重新出現的時間
  levelUpMs: [90 * 60000, 150 * 60000], // 升級間隔
  maxLevel: 40,
  exploreEveryMs: [20 * 60000, 40 * 60000], // 外出探索間隔
  exploreRadiusM: 900,
  raidBaseMs: 3 * 3600000, // 每 3 個 NPC 的掠奪基礎間隔（NPC 越多，個別越少出手；依積極度縮短）
  walkMinPerKm: 4, // NPC 隊伍移動速度（每公里分鐘）
  searchMs: 10 * 60000,
  raidStealPct: 0.15, // 掠奪成功時搶走的資源比例
  raidWallDamage: 0.3, // 掠奪成功時圍牆損失
};

export const NPC_NAMES = ['鐵狼幫', '紅蠍團', '黑鴉會', '血月營', '禿鷹隊', '野犬幫', '灰燼兄弟', '毒牙團', '荒原騎士', '碎骨幫', '夜梟會', '鏽刃團'];

/**
 * 積極度（0.1～1）：玩家文明度越高，NPC 越常來掠奪。
 * @param {number} civ 文明度
 */
export const npcAggression = (civ) => Math.min(1, Math.max(0.1, civ / 200));
