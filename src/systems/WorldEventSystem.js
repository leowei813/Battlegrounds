import { WORLD_EVENTS, WORLD_EVENT_KEYS } from '../config/worldEvents.js';
import { DG_TZ_MS } from '../config/dungeons.js';

const pad = (n) => String(n).padStart(2, '0');
/** 台灣日期 YYYYMMDD（與地下城同一天切換） */
export const eventDay = (now) => {
  const d = new Date(now + DG_TZ_MS);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
};
const hash = (s) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  // 最後再混合一次：相鄰日期的字串很像，讓結果分布更平均
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
};
const cache = new Map();

/**
 * v15.18：天候事件日。以台灣日期當亂數種子決定當天的事件，所有玩家算出來都一樣（不需要存檔或伺服器）。
 */
export class WorldEventSystem {
  /** 測試與開發用：強制指定的事件 ID（null 為依日期） */
  static force = null;

  constructor(game) {
    this.game = game;
  }

  /** 某天（YYYYMMDD）的事件 ID */
  static pick(day) {
    const list = WORLD_EVENT_KEYS.filter((k) => WORLD_EVENTS[k].weight > 0);
    const total = list.reduce((s, k) => s + WORLD_EVENTS[k].weight, 0);
    let x = (hash(`wx|${day}`) / 4294967296) * total;
    for (const k of list) {
      x -= WORLD_EVENTS[k].weight;
      if (x < 0) return k;
    }
    return list[list.length - 1];
  }

  /** 某時間的事件：{ id, day, ...設定 } */
  static at(now = Date.now()) {
    // 測試與開發用：強制指定事件
    if (WorldEventSystem.force) return { id: WorldEventSystem.force, day: eventDay(now), ...WORLD_EVENTS[WorldEventSystem.force] };
    const day = eventDay(now);
    if (!cache.has(day)) {
      if (cache.size > 20) cache.clear();
      const id = WorldEventSystem.pick(day);
      cache.set(day, { id, day, ...WORLD_EVENTS[id] });
    }
    return cache.get(day);
  }

  /** 某項效果的數值（倍率類沒有效果時 1；nightLevel 加值類沒有效果時 0） */
  static fx(key, now = Date.now()) {
    const v = WorldEventSystem.at(now).fx[key];
    if (v != null) return v;
    return key === 'nightLevel' ? 0 : 1;
  }

  today(now = Date.now()) {
    return WorldEventSystem.at(now);
  }

  mul(key, now = Date.now()) {
    return WorldEventSystem.fx(key, now);
  }
}
