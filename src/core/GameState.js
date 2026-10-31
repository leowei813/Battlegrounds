import {
  SAVE_VERSION, STARTING_RESOURCES, STARTING_SUPPLIES, STARTING_COINS,
} from '../config/constants.js';
import { FACILITIES } from '../config/facilities.js';
import { CLASSES } from '../config/survivors.js';
import { emptyEquipment } from '../config/equipment.js';
import { BASE_SIZES, baseSizeOf } from '../config/civilization.js';
import { uid, newSeed } from '../utils/math.js';

/** 各類隨機結果的種子 */
export const newSeeds = () => Object.fromEntries(['craft', 'recruit', 'explore', 'battle', 'npc'].map((k) => [k, newSeed()]));

/** 統計欄位（任務、成就皆由此衍生） */
export const STAT_KEYS = [
  'kills', 'siegeKills', 'bossKills', 'eliteKills', 'explorations', 'battlesWon', 'battlesLost',
  'itemsFound', 'rareItems', 'legendaryItems', 'crafted', 'upgrades', 'recruits',
  'researchDone', 'breaches', 'daysSurvived', 'foodCollected', 'peakCivilization',
];

/**
 * 建立據點。避難所使用設施初始等級；前哨站只有 Lv1 圍牆（只能建造防禦設施）。
 * @param {{id:string, name:string, lat:number, lon:number}} poi
 * @param {'shelter'|'outpost'} kind
 */
export function createBase(poi, kind = 'shelter') {
  const isFirst = kind === 'shelter';
  return {
    id: uid('base'),
    kind,
    poiId: poi.id,
    name: poi.name,
    lat: poi.lat,
    lon: poi.lon,
    createdAt: Date.now(),
    facilities: Object.fromEntries(
      Object.entries(FACILITIES).map(([id, def]) => [id, { level: isFirst ? def.startLevel : id === 'wall' ? 1 : 0 }]),
    ),
    // 防禦建築欄位數依據點規模（小型 4～巨型 12）
    size: baseSizeOf(poi),
    defenses: Array.from({ length: BASE_SIZES[baseSizeOf(poi)].slots }, (_, slot) => ({ slot, type: null, level: 0, garrisonId: null })),
    wallHp: null, // null = 滿血（首次計算時填入）
    buildQueue: [],
  };
}

export function createLeader(name, classId = 'warrior') {
  return {
    id: 'leader',
    name,
    classId,
    level: 1,
    xp: 0,
    isLeader: true,
    rarity: null, // 主角沒有品級，能力成長比照稀有（橘）
    status: 'idle', // idle | exploring
    job: 'guard',
    hp: null, // 目前生命（null = 滿血）
    severe: false, // 重傷：生命歸零，無法行動
    zeroSince: 0, // 飢餓且生命為 0 的起始時間（永久死亡倒數）
    bag: {}, // 個人背包攜帶的資源
    equipment: emptyEquipment(),
  };
}

export function createSurvivor(name, classId, level = 1, rarity = 'common') {
  if (!CLASSES[classId]) throw new Error(`Unknown class ${classId}`);
  return {
    id: uid('sv'),
    name,
    classId,
    level,
    xp: 0,
    isLeader: false,
    rarity,
    status: 'idle',
    job: 'scavenge',
    hp: null,
    severe: false,
    zeroSince: 0,
    bag: {},
    equipment: emptyEquipment(),
  };
}

/**
 * 建立全新存檔狀態。這是整個遊戲唯一的資料來源（Single Source of Truth），
 * 所有欄位都可被 JSON 序列化以存入 LocalStorage。
 */
export function createInitialState({ playerName, classId, lat, lon }) {
  const now = Date.now();
  return {
    version: SAVE_VERSION,
    createdAt: now,
    lastSaveAt: now,
    lastTickAt: now,
    player: { name: playerName, coins: STARTING_COINS, parts: 0 },
    map: {
      center: { lat, lon },
      pois: [],
      source: 'none',
      fetchedAt: 0,
      zombieGroups: [],
      lastZombieRefresh: 0,
      detected: {}, // GPS 今日偵測過的建築
      markers: [], // 標記的建築（最多 5 個，保留建築資料方便日後建立避難所）
      remain: {}, // 建築內殘留的物資 { poiId: { day, res } }
    },
    bases: [], // 據點列表（見 createBase）
    primaryBaseId: null, // 主要據點

    resources: { ...STARTING_RESOURCES },
    supplies: { ...STARTING_SUPPLIES }, // 材料物品：零件、布料、藥品、彈藥（放在物品倉庫，可堆疊）
    inventory: { items: [], blueprints: [] },
    survivors: [createLeader(playerName, classId)],
    recruitPool: [],
    recruitOffer: null, // 招募中的三位候選人
    recruitBoard: { list: [], refreshAt: 0 }, // 每小時固定出現的可招募倖存者
    expeditions: [],
    reports: [],
    vehicles: [], // 車庫（見 VehicleSystem）
    rng: newSeeds(), // 製作、招募、探索、戰鬥的隨機種子（重新讀檔結果不變）
    npcs: { list: [], nextSpawnAt: 0 }, // NPC 據點（見 NpcSystem）
    relations: { players: {}, requestsIn: {}, requestsOut: {} }, // 與其他玩家的關係（見 TerritorySystem）
    research: { levels: {}, active: null }, // 科技等級（見 ResearchSystem）
    quests: { mainIndex: 0, mainClaimable: false, dailyDate: '', dailies: [], achievements: {} },
    stats: Object.fromEntries(STAT_KEYS.map((k) => [k, 0])),
    settings: { autoSave: true, showDamage: true },
    log: [],
  };
}
