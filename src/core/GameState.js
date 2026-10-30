import {
  SAVE_VERSION, STARTING_RESOURCES, STARTING_COINS, DEFENSE_SLOTS,
} from '../config/constants.js';
import { FACILITIES } from '../config/facilities.js';
import { CLASSES } from '../config/survivors.js';
import { uid } from '../utils/math.js';

/** 統計欄位（任務、成就皆由此衍生） */
export const STAT_KEYS = [
  'kills', 'siegeKills', 'bossKills', 'eliteKills', 'explorations', 'battlesWon', 'battlesLost',
  'itemsFound', 'rareItems', 'legendaryItems', 'crafted', 'upgrades', 'recruits',
  'researchDone', 'breaches', 'daysSurvived', 'foodCollected',
];

export function createLeader(name, classId = 'warrior') {
  return {
    id: 'leader',
    name,
    classId,
    level: 1,
    xp: 0,
    isLeader: true,
    status: 'idle', // idle | exploring
    job: 'guard',
    injuredUntil: 0,
    equipment: { weapon: null, helmet: null, armor: null, legs: null, backpack: null },
  };
}

export function createSurvivor(name, classId, level = 1) {
  if (!CLASSES[classId]) throw new Error(`Unknown class ${classId}`);
  return {
    id: uid('sv'),
    name,
    classId,
    level,
    xp: 0,
    isLeader: false,
    status: 'idle',
    job: 'scavenge',
    injuredUntil: 0,
    equipment: { weapon: null, helmet: null, armor: null, legs: null, backpack: null },
  };
}

/**
 * 建立全新存檔狀態。這是整個遊戲唯一的資料來源（Single Source of Truth），
 * 所有欄位都可被 JSON 序列化以存入 LocalStorage。
 */
export function createInitialState({ playerName, classId, lat, lon }) {
  const now = Date.now();
  const facilities = Object.fromEntries(
    Object.entries(FACILITIES).map(([id, def]) => [id, { level: def.startLevel }]),
  );
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
    },
    shelter: {
      poiId: null,
      name: '',
      lat: null,
      lon: null,
      facilities,
      defenses: Array.from({ length: DEFENSE_SLOTS }, (_, slot) => ({ slot, type: null, level: 0, garrisonId: null })),
      wallHp: null, // null = 滿血（首次計算時填入）
      buildQueue: [],
    },
    resources: { ...STARTING_RESOURCES },
    inventory: { items: [], blueprints: [] },
    survivors: [createLeader(playerName, classId)],
    recruitPool: [],
    expeditions: [],
    reports: [],
    research: { completed: [], active: null },
    quests: { mainIndex: 0, mainClaimable: false, dailyDate: '', dailies: [], achievements: {} },
    stats: Object.fromEntries(STAT_KEYS.map((k) => [k, 0])),
    settings: { autoSave: true, showDamage: true },
    log: [],
  };
}
