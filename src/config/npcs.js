/**
 * 自有意識的 NPC 據點：隨機出現在地圖上，會升級、外出探索（搶先搜刮建築），
 * 也會掠奪玩家據點。玩家文明度越高，NPC 越積極。屍潮來襲（夜晚）時 NPC 不會出動攻擊。
 */
export const NPC_CONFIG = {
  perCell: 2, // 每個格子（約 0.9 公里見方）內的 NPC 據點數
  cellKm: 0.9, // 格子大小（約 0.9 公里見方）
  keepRatio: 2 / 3, // 每個名額有此機率出現 NPC（依格子種子固定，所有玩家相同）：密度約每平方公里 1.6 個
  minFromShelterM: 300, // 不會出現在避難所旁邊
  respawnMs: [30 * 60000, 60 * 60000], // （舊）被摧毀後重新出現的時間；現在改為隔天中午刷新
  respawnHour: 12, // （舊）被擊敗的 NPC 據點在下一個中午 12:00 重新出現；v12 改為 respawnAfterMs
  respawnAfterMs: 36 * 3600000, // v12：被消滅的 NPC 據點 36 小時（現實時間）後才重新出現
  levelUpMs: [90 * 60000, 150 * 60000], // 升級間隔
  maxLevel: 40,
  respawnMinLevel: 35, // 被攻陷後重生的 NPC 據點至少這個等級（被擊退的等級損失也不會低於此）
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
  /** 擊退 NPC 掠奪隊的獎勵：賞金（擊倒人數 × NPC 等級 × bounty）、遺落裝備（首領／每名掠奪者的機率）、參與防守的人獲得升級所需經驗的 xpPct */
  raidReward: { bounty: 0.5, chiefGear: 0.3, raiderGear: 0.05, xpPct: 0.03 },
  woundHealMs: 20000, // v15.8：攻打據點時的守軍每 20 秒補回 1 名（傷亡以「份」計，1 份＝攻打時 NPC_ASSAULT.count 名守軍，每次補回 1/count 份）
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

/**
 * 攻打 NPC 據點時的守軍強度（v10）：一支隊伍很難單獨打下，需要找其他玩家集結。
 * 只影響攻打 NPC 據點（含集結），NPC 出來掠奪的隊伍強度不變。
 */
export const NPC_ASSAULT = { hp: 22.5, atk: 11.25, count: 2, wall: 1.5, dps: 1.2 }; // v10.14：生命、攻擊 ×2.5（Lv30 以上需要集結）
/** 攻陷 NPC 據點的獎勵倍率（金錢、物資、裝備數量） */
export const NPC_REWARD_MUL = 4;
/** 集結攻陷時的分配：保底比例（平均分給每支隊伍），其餘依造成的傷害分配 */
export const RALLY_SHARE_FLOOR = 0.2;
/** 集結戰鬥的經驗：打贏時沒倒下的隊員額外獲得「自己升級所需經驗」的 winPct；倒下的懲罰改為升級所需經驗的 downPct（一般為 10%） */
export const RALLY_XP = { winPct: 0.03, downPct: 0.03 };

/**
 * NPC 勢力名稱（v12 中二風格）：前綴 × 後綴組合，共 640 種；同一張地圖上不會重複（見 NpcSystem.uniqueNames）。
 */
export const NPC_NAME_PREFIX = [
  '漆黑', '深淵', '赤月', '黑炎', '永夜', '血色', '冥府', '虛空', '終焉', '墮天', '煉獄', '闇影', '斷罪', '天譴', '黑曜', '灰燼',
  '狂嵐', '碎星', '寂滅', '禁忌', '噬魂', '鋼鐵', '嗜血', '黃昏', '末日', '破曉', '冰霜', '雷鳴', '毒霧', '骸骨', '夜鴉', '鏽蝕',
  '審判', '輪迴', '混沌', '業火', '修羅', '魔眼', '星墜', '絕望',
];
export const NPC_NAME_SUFFIX = [
  '騎士團', '教團', '兄弟會', '傭兵團', '獵犬', '軍團', '王庭', '議會', '之牙', '之刃', '使徒', '行者', '十字軍', '狼群', '戰團', '叛軍',
];
export const NPC_NAMES = NPC_NAME_PREFIX.flatMap((p) => NPC_NAME_SUFFIX.map((x) => `${p}${x}`));

/**
 * 積極度（0.1～1）：玩家文明度越高，NPC 越常來掠奪。
 * @param {number} civ 文明度
 */
export const npcAggression = (civ) => Math.min(1, Math.max(0.1, civ / 200));

/** v15.8：現實凌晨（台灣時間 00:00～08:00）NPC 停止掠奪玩家據點、勢力停止進攻控制點；抵達時間落在這段時間的部隊也不出發 */
export const NPC_QUIET = { from: 0, to: 8, tzHours: 8 };
/** 某個時刻是否在 NPC 休息時段（以台灣時間計） */
export const npcQuietAt = (t) => {
  const h = new Date(t + NPC_QUIET.tzHours * 3600000).getUTCHours();
  return h >= NPC_QUIET.from && h < NPC_QUIET.to;
};
/** 從 start 出發、end 抵達的行動是否碰到休息時段（出發或抵達在時段內，或整段跨過時段） */
export const npcQuietSpan = (start, end) => {
  if (npcQuietAt(start) || npcQuietAt(end)) return true;
  // 長途跨過整段休息時段：檢查中間每小時
  for (let t = start + 3600000; t < end; t += 3600000) if (npcQuietAt(t)) return true;
  return false;
};
