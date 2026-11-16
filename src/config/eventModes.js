/**
 * v17.3：屍王降臨（全服共鬥世界王）與封鎖區撤離（高風險搜刮）。
 * 時間一律以台灣時間（UTC+8）計算。
 */

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
/** 台灣時區 */
export const EV_TZ_MS = 8 * HOUR;

// ---------- 屍王降臨 ----------

/**
 * 屍王降臨：每週三、六 20:00 出現，停留 24 小時，所有玩家共用同一條血量（共用資料種類 wb）。
 *  - tries：每次降臨每位玩家可出擊次數；fightSec：每場戰鬥秒數
 *  - hp0：第一次的血量；之後依上一次結果調整（fastMs 內被擊倒 ×fast、較晚擊倒 ×slow、沒擊倒＝總傷害 × fail）
 *  - boss：屍王數值（以坦克屍為底，攻擊 × atkMul）；power：建議隊伍總戰力
 */
export const WORLD_BOSS = {
  kind: 'wb',
  days: [3, 6],
  hour: 20,
  stayMs: 24 * HOUR,
  tries: 3,
  fightSec: 60,
  hp0: 15000000,
  hpMin: 3000000,
  adjust: { fastMs: 12 * HOUR, fast: 1.3, slow: 1.1, fail: 0.9 },
  boss: { base: 'tankBoss', level: 60, atkMul: 23 },
  power: 300000,
  /** 地點：落在這些區域的建築附近 */
  zones: ['alert', 'danger'],
  /** 結算等待：屍王倒下或離開後，等還在路上的資料寫入 */
  settleMs: 3 * MIN,
};

/** 依序輪流出現的屍王（名稱、圖案）：第一隻是骷髏王 */
export const WORLD_BOSS_ROSTER = [
  { name: '骷髏王', icon: '💀' },
  { name: '巨像屍王', icon: '🧟‍♂️' },
  { name: '惡鬼', icon: '👹' },
  { name: '巨猿屍', icon: '🦍' },
  { name: '觸手母體', icon: '🐙' },
  { name: '屍化巨獸', icon: '🦖' },
  { name: '屍蛛女王', icon: '🕷️' },
  { name: '屍眼', icon: '👁️' },
];

/**
 * 三個階段（依出擊當下全服剩餘血量）：
 *  - smash：重擊（攻擊 ×atk、攻速 ×spd，打得慢但很痛）
 *  - summon：召喚屍群（戰鬥開始時帶著 adds 隻屍群）
 *  - rage：狂暴（攻擊 ×atk、攻速 ×spd）
 */
export const WORLD_BOSS_PHASES = [
  { id: 'smash', from: 1, to: 0.7, icon: '🦍', name: '重擊', text: '每次攻擊更重（攻擊 +30%、攻速 −20%）', atk: 1.3, spd: 0.8 },
  { id: 'summon', from: 0.7, to: 0.4, icon: '🧟', name: '召喚', text: '帶著 4 隻屍群一起作戰', adds: 4, addId: 'berserker', addLv: 55, addMul: 6 },
  { id: 'rage', from: 0.4, to: 0, icon: '😡', name: '狂暴', text: '攻擊 +50%、攻速 +30%', atk: 1.5, spd: 1.3 },
];

/**
 * 獎勵：
 *  - hit：每場出擊結束立即獲得（每 100 萬傷害）：金錢、3 階與 4 階材料
 *  - box：屍王倒下（或離開）後依傷害排名發箱：kinds 材料種類、tiers 階級、mul 數量倍率（同空投的每階基本量）、
 *    coins 金錢、parts 稀有材料、bp 設計圖機率（bpMin 保底品級）
 *  - failMul：時間到沒擊倒，結算獎勵 × failMul
 *  - silverTop：第 2～silverTop 名銀箱
 */
export const WORLD_BOSS_REWARD = {
  hit: { coins: 80, t3: 4, t4: 1 },
  box: {
    gold: { name: '金箱', icon: '🟨', kinds: 6, tiers: [4, 5], mul: 2.5, coins: 1500, parts: 12, bp: 1, bpMin: 'rare' },
    silver: { name: '銀箱', icon: '⬜', kinds: 5, tiers: [3, 5], mul: 1.8, coins: 800, parts: 6, bp: 0.4, bpMin: 'rare' },
    bronze: { name: '銅箱', icon: '🟫', kinds: 4, tiers: [3, 4], mul: 1.2, coins: 400, parts: 3, bp: 0.1 },
  },
  failMul: 0.5,
  silverTop: 10,
  /** 銅箱數量依「自己的傷害 ÷ 平均傷害」調整（限制範圍） */
  bronzeShare: [0.5, 1.5],
};

// ---------- 封鎖區撤離 ----------

/**
 * 封鎖區：每天 12:00、21:00 開放 3 小時，地點隨機（危險區以上）。
 *  - roundMs：每輪搜刮時間；exitMs：撤離移動時間（之後打追擊戰）；closeExitMs：關閉前多久自動撤離
 *  - enterBeforeMs：關閉前多久停止進入
 *  - threat：每輪威脅上升＝base + load × 背包負重比例；夜晚 × night；到 100 被包圍強制撤離
 *  - grow：每多一輪收穫 +grow
 *  - enc／chase：遭遇戰與追擊戰的強度＝區域守衛 ×（min + span × 威脅值）
 *  - chaseKeep：追擊戰失敗時保留的比例
 */
export const BLOCKADE = {
  hours: [12, 21],
  openMs: 3 * HOUR,
  roundMs: 10 * MIN,
  exitMs: 5 * MIN,
  closeExitMs: 15 * MIN,
  enterBeforeMs: 30 * MIN,
  radiusM: 250,
  zones: { danger: 0.5, lethal: 0.35, abyss: 0.15 },
  threat: { base: 10, load: 5, night: 1.5, max: 100 },
  grow: 0.1,
  enc: { min: 0.35, span: 0.65 },
  chase: { min: 0.5, span: 0.7 },
  chaseKeep: 0.5,
  /** 預設的自動撤離條件 */
  auto: { threat: 70, down: true, full: true },
  threatChoices: [40, 50, 60, 70, 80, 90, 100],
  bpFrom: 6,
};

/**
 * 各區每輪（10 分鐘）的收穫：同區探索 10 分鐘收益（實測）的 1.2 倍。
 *  - part／fabric：各階數量（小數以機率進位）
 *  - coins：金錢；parts：稀有材料機率；bp：第 bpFrom 輪起每輪設計圖機率
 *  - guard：遭遇與追擊的屍群（同空投守衛：等級、數量、強度倍率）；power：建議隊伍總戰力
 */
export const BLOCKADE_ZONE = {
  danger: {
    part: { 1: 26, 2: 5.1, 3: 3.3, 4: 1.5 }, fabric: { 1: 4.3, 2: 1.9, 3: 1.1, 4: 0.2 },
    coins: 25, parts: 0.4, bp: 0.06, power: 120000, guard: { lv: 35, n: 7, mul: 30.04 },
  },
  lethal: {
    part: { 1: 21, 2: 6, 3: 2.9, 4: 1.8, 5: 0.8 }, fabric: { 1: 3.2, 2: 1.9, 3: 1.3, 4: 0.8, 5: 0.05 },
    coins: 35, parts: 0.6, bp: 0.1, bpMin: 'rare', power: 200000, guard: { lv: 43, n: 8, mul: 45.4 },
  },
  abyss: {
    part: { 1: 33, 2: 5.3, 3: 4.3, 4: 3.1, 5: 1.1 }, fabric: { 1: 5.7, 2: 4, 3: 1.4, 4: 2, 5: 0.2 },
    coins: 50, parts: 0.8, bp: 0.12, bpMin: 'rare', power: 300000, guard: { lv: 50, n: 8, mul: 59.2 },
  },
};
/** 遭遇的殭屍種類（依序輪替） */
export const BLOCKADE_MIX = ['infected', 'berserker', 'mutant', 'infected'];
