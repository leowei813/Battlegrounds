import { cpAt as hqCpAt, hqNeighbors, FACTIONS, FACTION_KEYS, FACTION_BASE, factionHq } from '../config/controlPoints.js';
import { ASSIST_TRAVEL_MUL } from './AssistSystem.js';

/** 再次探索同一地點：剩餘搜索時間的下限比例、回去拿帶不走物資的時間（分鐘） */
const REVISIT = { minFrac: 0.2, pickupMin: 0.3 };

/** 自動探索換點次數上限 */
import { COIN_GAIN_MUL, RAID_TRAVEL } from '../config/constants.js';
import { RECRUIT_STAY_MS } from '../config/survivors.js';
import {
  MAX_TEAM_SIZE, MAX_EXPEDITIONS, OFFLINE_CAP_MS, RESOURCES,
} from '../config/constants.js';

/** 探索帶回的物資（基本資源與材料物品，受運載量限制） */
const isLootKey = (k) => !!RESOURCES[k] || !!SUPPLIES[k];
const lootLabel = (k) => { const m = RESOURCES[k] || SUPPLIES[k]; return m ? `${m.icon}${m.name}` : k; };
/** 連續探索時背著的物資重量 */
const carriedWeight = (c) => Object.entries(c?.gained || {}).filter(([k]) => isLootKey(k)).reduce((s, [k, v]) => s + v * unitWeight(k), 0);
/** 連續探索：負重達到運載量的此比例就回家 */
export const CHAIN_RETURN_LOAD = 0.9;
/** 快速佇列：每一站最多往外找多遠的下一個地點（公尺） */
export const QUICK_QUEUE_HOP_M = 600;
const nameOf = (k) => RESOURCES[k]?.name || SUPPLIES[k]?.name || k;
import { POI_TYPES } from '../config/poiTypes.js';
import { RARITIES } from '../config/equipment.js';
import {
  withSeed,
  chance, pick, randInt, uid, weightedPick, haversine, randFloat, lerp,
} from '../utils/math.js';
import {
  ALL_ENEMIES, ZOMBIE_VS_SURVIVOR, NIGHT_MUL, BUILDING_ZONE, DAY_ZONE, mulOf,
} from '../config/enemies.js';
import {
  stockOf, dayKey, pickSupply, remainOf,
} from './LootStock.js';
import { zoneAt } from '../config/zones.js';
import { BASE_SIZES, baseSizeOf } from '../config/civilization.js';
import { pathLength, pointAlong } from '../map/routing.js';
import {
  SUPPLIES, AMMO_FOR, AMMO_PACK_FIGHTS, unitWeight,
} from '../config/supplies.js';

/** 每公里單程移動時間（分鐘，未套用速度加成） */
const MIN_PER_KM_ONE_WAY = 1.2;
/** 搜完整棟建築的經驗倍率（相對建築等級的普通殭屍經驗） */
const SEARCH_XP_MUL = 0.5;

/** 移動途中，殭屍群在此距離內（公尺）就可能發動襲擊 */
export const AMBUSH_RADIUS_M = 90;
/** 每個接近的殭屍群發動襲擊的基礎機率（偵察兵的尋路技能可降低） */
const AMBUSH_CHANCE = 0.6;

/**
 * 行程進度（純函式）：去程 → 搜索 → 返程。自己的探索隊與其他玩家的隊伍共用。
 * @param {{from?:{lat,lon}, to:{lat,lon}, startAt:number, endAt:number, travelMs?:number, searchMs?:number, distanceM?:number}} trip
 */
/** v15.4：鄰接大本營的控制點，探索時被大本營襲擊 */
export const HQ_AMBUSH = { chance: 0.25, lootLoss: 0.5 };

/** 建築所在的控制點鄰接哪個勢力的大本營（最東側一排；都不是時回傳 null） */
export function hqFactionOf(poi) {
  const c = poi && hqCpAt(poi.lat, poi.lon);
  if (!c) return null;
  const list = FACTION_KEYS.filter((f) => hqNeighbors(f).includes(c.id));
  if (!list.length) return null;
  const d = (f) => { const h = factionHq(f); return Math.hypot(h.lat - c.lat, h.lon - c.lon); };
  return list.sort((a, b) => d(a) - d(b))[0];
}

export function tripProgress(trip, now = Date.now()) {
  const { to } = trip;
  // 舊存檔沒有行程資料：視為一直在目標地點搜索
  const travelMs = trip.travelMs || 0;
  const from = trip.from || to;
  const t = Math.max(0, now - trip.startAt);
  const searchEnd = travelMs + (trip.searchMs ?? trip.endAt - trip.startAt);
  // 繞路的折線路線（避開警戒範圍）；沒有時為直線
  const path = Array.isArray(trip.path) && trip.path.length >= 2 ? trip.path : null;
  const dist = path ? Math.round(pathLength(path)) : trip.distanceM ?? Math.round(haversine(from.lat, from.lon, to.lat, to.lon));
  const at = (r) => (path ? pointAlong(path, dist * r) : { lat: lerp(from.lat, to.lat, r), lon: lerp(from.lon, to.lon, r) });
  let phase;
  let ratio;
  let movedM;
  let phaseRemainingMs;
  if (t < travelMs) {
    phase = 'outbound';
    ratio = t / travelMs;
    movedM = dist * ratio;
    phaseRemainingMs = travelMs - t;
  } else if (t < searchEnd) {
    phase = 'searching';
    ratio = 1;
    movedM = dist;
    phaseRemainingMs = searchEnd - t;
  } else {
    phase = 'returning';
    // 連續探索：回程是從這個地點直接回避難所（與去程不同的路線）
    if (Array.isArray(trip.backPath) && trip.backPath.length >= 2) {
      const bd = Math.round(pathLength(trip.backPath));
      const back = trip.backMs ? Math.min(1, (t - searchEnd) / trip.backMs) : 1;
      return {
        phase, pos: pointAlong(trip.backPath, bd * back), from, to, path,
        movedM: Math.round(dist + bd * back), totalM: dist + bd, remainingMs: Math.max(0, trip.endAt - now), phaseRemainingMs: Math.max(0, trip.endAt - now),
      };
    }
    const back = travelMs ? Math.min(1, (t - searchEnd) / travelMs) : 1;
    ratio = 1 - back;
    movedM = dist * (1 + back);
    phaseRemainingMs = trip.endAt - now;
  }
  return {
    phase, pos: at(ratio), from, to, path,
    movedM: Math.round(movedM), totalM: dist * 2, remainingMs: Math.max(0, trip.endAt - now), phaseRemainingMs: Math.max(0, phaseRemainingMs),
  };
}

export const EXP_PHASES = {
  outbound: { name: '前往中', icon: '🚶' },
  searching: { name: '搜索中', icon: '🔍' },
  returning: { name: '返程中', icon: '🏃' },
};

const SPECIAL_EVENTS = [
  { id: 'cache', text: '發現一個隱藏的物資箱！', reward: () => ({ coins: randInt(20, 60), parts: chance(0.5) ? 1 : 0 }) },
  { id: 'trader', text: '遇到一名流浪商人，用雜物換到了金錢。', reward: () => ({ coins: randInt(30, 90) }) },
  { id: 'radio', text: '從無線電聽到補給投放的位置，順利取回。', reward: () => ({ food: randInt(22, 60), bandage: randInt(1, 3), painkiller: chance(0.3) ? 1 : 0 }) },
  { id: 'car', text: '找到一輛廢棄汽車，抽出了油箱裡的燃料。', reward: () => ({ fuel: randInt(20, 50) }) },
  { id: 'trap', text: '踩中前人留下的陷阱，一名隊員受了輕傷。', injure: true, reward: () => ({}) },
  { id: 'diary', text: '在屍體旁撿到一本日記，記錄著研究資料。', reward: () => ({ parts: randInt(1, 2) }) },
];

/** 時刻（HH:MM） */
const hhmm = (t) => { const d = new Date(t); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

/**
 * 探索系統：派遣隊伍前往地圖建築，經過一段時間後結算事件。
 * 探索一律自動進行（同一地點搜光才結束、有佇列時接著前往下一站），支援離線結算。
 */
export class ExplorationSystem {
  constructor(game) {
    this.game = game;
  }

  get list() {
    return this.game.state.expeditions;
  }

  /** 搜完整棟建築的經驗：建築殭屍等級的普通殭屍經驗 × 0.5 × 大小倍率（小 1／中 1.25／大 1.5／巨 1.75） */
  searchXp(poi) {
    if (!poi) return 0;
    const lv = this.game.zombies.buildingLevel(poi, this.game.time.phase());
    const base = this.game.combat.createEnemy('walker', lv).xp;
    const size = { small: 1, medium: 1.25, large: 1.5, huge: 1.75 }[baseSizeOf(poi)] || 1;
    return Math.max(1, Math.round(base * SEARCH_XP_MUL * size));
  }

  /** 報告附上每位隊員這趟實際拿到的經驗（出發時與回來時的累計經驗差；重傷扣經驗時為負） */
  attachXp(report, exp) {
    if (!report || !exp?.xp0) return;
    const sv = this.game.survivors;
    const list = exp.memberIds.map((id) => sv.get(id)).filter(Boolean)
      .map((m) => ({ n: m.name, d: Math.round(sv.totalXp(m) - (exp.xp0[m.id] ?? sv.totalXp(m))) }));
    if (list.some((x) => x.d !== 0)) report.xpBy = list;
  }

  /** 目標地點：地圖建築，或 NPC 據點（攻打時） */
  /** 探索報告記下目的地所在區域的危險等級（安全區～深淵區） */
  tagZone(report, exp) {
    // 這次外出的戰鬥明細跟著報告一起保存
    if (report && exp?.battleIds?.length && !report.battleIds) report.battleIds = [...exp.battleIds];
    if (!report || report.zone) return;
    const p = this.poi(exp?.poiId) || this.game.npcs.get?.(exp?.poiId);
    if (p && Number.isFinite(p.lat)) report.zone = zoneAt(p.lat, p.lon).id;
  }

  poi(id) {
    return this.game.state.map.pois.find((p) => p.id === id) || this.game.npcs?.asPoi(id) || this.game.territory?.asPoi(id)
      || this.game.intercept?.asPoi(id) || this.game.assist?.asPoi(id) || this.game.infected?.asPoi(id) || this.game.rally?.asPoi(id) || this.game.cp?.asPoi(id) || this.huntPoi(id) || null;
  }

  /**
   * 規劃行程：去程 → 搜索 → 返程。探索隊從主要據點出發。
   * @returns {{from:{lat,lon}, distanceM:number, travelMs:number, searchMs:number, totalMs:number}}
   */
  /** 攻擊目標本身的警戒範圍不需要繞開，也不另外觸發遭遇 */
  targetZone(poi) {
    if (poi?.npc) return [poi.id];
    if (poi?.pvp) return [poi.zoneId];
    return [];
  }

  plan(poi, members, durationMin, at = Date.now(), vehicles = [], { avoidHostile = false, from: fromAt = null } = {}) {
    const sh = this.game.shelter.primary();
    const home = sh ? { lat: sh.lat, lon: sh.lon } : { lat: poi.lat, lon: poi.lon };
    // 連續探索：從上一個地點出發，回程直接回避難所
    const from = fromAt || home;
    // 路線：預設繞開非敵對據點的警戒範圍
    const path = this.game.territory.route(from, poi, { avoidHostile, ignore: this.targetZone(poi) });
    const distanceM = Math.round(pathLength(path));
    const trip = this.game.vehicles.tripStats(members, vehicles, distanceM);
    // 隊伍速度取最快成員的「技能 + 裝備」探索速度
    const scout = Math.max(0, ...members.map((m) => (this.game.survivors.skillEffects(m).exploreSpeed || 0)
      + (this.game.survivors.stats(m).exploreSpeed || 0)));
    // 偵察兵（技能「尋路」）與裝備、研究加快速度；隊員越多搜索越快
    const speed = this.game.time.exploreSpeedMul(at) * (1 + scout + this.game.research.bonus('exploreSpeed'));
    const teamMul = 1 + 0.1 * Math.max(0, members.length - 1);
    // 載具只加快路程，不影響搜索時間
    // 突襲玩家避難所：路程大幅拉長（防守方有時間準備），載具仍然加速
    let walkMin = (distanceM / 1000) * MIN_PER_KM_ONE_WAY;
    if (poi?.pvp) walkMin = Math.max(walkMin * RAID_TRAVEL.playerMul, RAID_TRAVEL.minMin);
    // 協防友好玩家：趕路較快
    if (poi?.assist) walkMin *= ASSIST_TRAVEL_MUL;
    const travelMs = Math.round((walkMin / (speed * trip.speed)) * 60000);
    const searchMs = Math.round((durationMin / (speed * teamMul)) * 60000);
    if (fromAt) {
      const backPath = this.game.territory.route(poi, home, { avoidHostile, ignore: this.targetZone(poi) });
      const backDistanceM = Math.round(pathLength(backPath));
      const backMs = Math.round((((backDistanceM / 1000) * MIN_PER_KM_ONE_WAY) / (speed * trip.speed)) * 60000);
      return {
        from, path, distanceM, travelMs, searchMs, backPath, backDistanceM, backMs, totalMs: travelMs + searchMs + backMs, trip,
      };
    }
    return {
      from, path, distanceM, travelMs, searchMs, totalMs: travelMs * 2 + searchMs, trip,
    };
  }

  /**
   * 搜索時間（分鐘，未套用速度加成）：依建築大小與危險度，最大型、最危險的地點需要 8 分鐘。
   */
  searchMinutes(poi) {
    if (!poi || poi.npc) return 2;
    const size = BASE_SIZES[baseSizeOf(poi)];
    const danger = this.game.zombies.areaDanger(poi);
    const full = Math.max(1, Math.round(size.searchMin * (0.6 + 0.4 * Math.min(1, (danger - 1) / 5))));
    // 搜過一部分（v10 共用）：只需剩餘檢核點的搜索時間；已經搜完、只是帶不走留下的：只需很短的時間
    const left = this.game.poiShare?.view(poi).left;
    if (left) {
      if (left.done >= left.total) return REVISIT.pickupMin;
      return Math.max(REVISIT.pickupMin, +(full * Math.max(REVISIT.minFrac, 1 - left.done / Math.max(1, left.total))).toFixed(2));
    }
    return full;
  }

  /** 計算實際探索時間（毫秒） */
  actualDurationMs(poi, members, durationMin, at = Date.now(), vehicles = [], opts = {}) {
    return this.plan(poi, members, durationMin, at, vehicles, opts).totalMs;
  }

  /**
   * 隊伍目前的行程狀態（地圖與探索頁即時顯示用）。
   * @returns {{phase:string, pos:{lat,lon}, movedM:number, totalM:number, remainingMs:number, phaseRemainingMs:number}|null}
   */
  progress(exp, now = Date.now()) {
    const poi = this.poi(exp.poiId);
    if (!poi) return null;
    // 連續探索：搜完後要不要直接前往下一站，在下一次更新時才決定；決定前先停在建築裡，
    // 避免地圖上先往回家的方向走一小段、再跳回來前往下一站
    const searchEnd = exp.startAt + (exp.travelMs || 0) + (exp.searchMs || 0);
    const chainable = exp.kind === 'explore' && exp.chain !== false && !exp.chainChecked && !exp.recalled && !exp.defeated
      && ((exp.queue || []).length || exp.auto) && !(exp.nextVehicleIds || []).length;
    const at = chainable && now > searchEnd ? Math.max(searchEnd - 1, exp.startAt) : now;
    return tripProgress({ ...exp, to: { lat: poi.lat, lon: poi.lon } }, at);
  }

  validate(poiId, memberIds) {
    const poi = this.poi(poiId);
    if (!poi) return { ok: false, reason: '找不到地點' };
    if (!this.game.shelter.hasShelter()) return { ok: false, reason: '請先建立避難所' };
    if (!memberIds.length) return { ok: false, reason: '請至少選擇一名隊員' };
    if (this.list.length >= MAX_EXPEDITIONS) return { ok: false, reason: `同時最多派出 ${MAX_EXPEDITIONS} 支隊伍` };
    if (memberIds.length > MAX_TEAM_SIZE) return { ok: false, reason: `隊伍最多 ${MAX_TEAM_SIZE} 人` };
    const members = memberIds.map((id) => this.game.survivors.get(id));
    if (members.some((m) => !m || !this.game.survivors.isAvailable(m))) return { ok: false, reason: '有隊員無法出發' };
    return { ok: true, poi, members };
  }

  /**
   * 行程預估：目前這一站、佇列每一站（從上一站移動＋搜索）、最後回家，與總剩餘時間。
   * 用和出發時相同的公式估算；途中戰鬥或背包裝滿提早回家時會有變動。
   * @returns {{phase:string, currentMs:number, stops:{poi:object, travelMs:number, searchMs:number, totalMs:number}[], backMs:number, totalMs:number, endAt:number}}
   */
  itinerary(exp, now = Date.now()) {
    const p = this.progress(exp, now);
    const remaining = p ? p.remainingMs : Math.max(0, exp.endAt - now);
    const phase = exp.defeated || exp.recalled ? 'returning' : p?.phase || 'searching';
    const queue = (exp.queue || []).map((id) => this.poi(id)).filter(Boolean);
    // 返程中、召回、或沒有佇列：剩餘時間就是到家的時間
    if (phase === 'returning' || !queue.length || exp.kind !== 'explore') {
      return { phase, currentMs: remaining, stops: [], backMs: phase === 'returning' ? remaining : 0, totalMs: remaining, endAt: now + remaining, queueOnHold: phase === 'returning' && queue.length > 0 };
    }
    const currentMs = Math.max(0, exp.startAt + (exp.travelMs || 0) + (exp.searchMs || 0) - now);
    const members = exp.memberIds.map((id) => this.game.survivors.get(id)).filter(Boolean);
    const vehicles = (exp.vehicleIds || []).map((id) => this.game.vehicles.get(id)).filter(Boolean);
    let from = this.poi(exp.poiId);
    let t = now + currentMs;
    let backMs = 0;
    const stops = queue.map((poi) => {
      const pl = this.plan(poi, members, this.searchMinutes(poi), t, vehicles, { from: { lat: from.lat, lon: from.lon } });
      const totalMs = pl.travelMs + pl.searchMs;
      t += totalMs;
      backMs = pl.backMs;
      from = poi;
      return { poi, travelMs: pl.travelMs, searchMs: pl.searchMs, totalMs };
    });
    const totalMs = currentMs + stops.reduce((sum, x) => sum + x.totalMs, 0) + backMs;
    return { phase, currentMs, stops, backMs, totalMs, endAt: now + totalMs };
  }

  /** 每支臨時小隊的探索佇列上限：基本 2 個，研究「行動規劃」每級 +1（最多 5 個） */
  queueLimit() {
    return Math.min(5, 2 + Math.floor(this.game.research.bonus('queueSlots')));
  }

  /** 可以加入佇列的臨時小隊（探索中、沒有召回或撤退） */
  squads() {
    return this.list.filter((e) => e.kind === 'explore' && !e.recalled && !e.defeated);
  }

  /** 把地點加入臨時小隊的探索佇列 */
  enqueue(expId, poiId) {
    const exp = this.list.find((e) => e.id === expId);
    if (!exp || exp.kind !== 'explore' || exp.recalled || exp.defeated) return { ok: false, reason: '這支小隊無法加入佇列' };
    const poi = this.poi(poiId);
    if (!poi || !POI_TYPES[poi.type] || poi.npc || poi.pvp) return { ok: false, reason: '只能加入一般建築的探索' };
    if (!this.explorable(poi)) return this.game.cp.canExplore(poi);
    exp.queue = exp.queue || [];
    if (exp.queue.length >= this.queueLimit()) return { ok: false, reason: `探索佇列已滿（${this.queueLimit()} 個，研究「行動規劃」可增加）` };
    if (exp.poiId === poiId || exp.queue.includes(poiId)) return { ok: false, reason: '這個地點已經在佇列中' };
    exp.queue.push(poiId);
    return { ok: true, msg: `已加入探索佇列（${exp.queue.length}/${this.queueLimit()}）：${poi.name}` };
  }

  /** v14：這棟建築目前能不能探索（控制點要自己或好友佔領、勢力領地不能探索；舊地圖一律可以） */
  explorable(poi) {
    if (this.game.state.map?.source !== 'generated' || !this.game.cp) return true;
    return this.game.cp.canExplore(poi).ok;
  }

  /** 從佇列移除 */
  /** 快速佇列開關（記在存檔設定，預設關閉） */
  quickQueueOn() {
    return !!this.game.state.settings?.quickQueue;
  }

  setQuickQueue(on) {
    this.game.state.settings = this.game.state.settings || {};
    this.game.state.settings.quickQueue = !!on;
  }

  /**
   * 快速佇列：從小隊目前（或佇列最後）的地點開始，依序把最近、還有物資的一般建築加入佇列直到上限。
   * 只選與選定建築同一個區域的建築（不跨區）。
   * 不選 NPC 與非友好玩家警戒範圍內的地點、據點，以及其他隊伍正要去的地點。
   * @returns {{ok:boolean, added:object[], msg?:string}}
   */
  quickFill(expId, now = Date.now()) {
    const exp = this.list.find((e) => e.id === expId);
    if (!exp || exp.kind !== 'explore' || exp.recalled || exp.defeated) return { ok: false, added: [], reason: '這支小隊無法加入佇列' };
    exp.queue = exp.queue || [];
    const room = this.queueLimit() - exp.queue.length;
    if (room <= 0) return { ok: true, added: [] };
    const taken = new Set(this.list.flatMap((e) => [e.poiId, ...(e.queue || [])]));
    const zones = this.game.territory.zones().filter((z) => z.relation !== 'friend');
    const pool = this.game.state.map.pois.filter((p) => POI_TYPES[p.type] && !p.npc && !p.pvp && !taken.has(p.id)
      && !this.game.shelter.baseAtPoi(p.id) && this.hasStock(p, now)
      && !zones.some((z) => haversine(p.lat, p.lon, z.lat, z.lon) <= z.r)
      && this.explorable(p));
    let last = this.poi(exp.queue[exp.queue.length - 1] || exp.poiId);
    // 只選與選定建築同一個區域（危險等級）的建築，不跨區
    const base = this.poi(exp.poiId) || last;
    const zoneId = base ? zoneAt(base.lat, base.lon).id : null;
    for (let i = pool.length - 1; i >= 0; i -= 1) if (zoneAt(pool[i].lat, pool[i].lon).id !== zoneId) pool.splice(i, 1);
    const added = [];
    while (last && added.length < room && pool.length) {
      let best = -1;
      let bestD = QUICK_QUEUE_HOP_M;
      pool.forEach((p, i) => {
        const d = haversine(last.lat, last.lon, p.lat, p.lon);
        if (d <= bestD) { bestD = d; best = i; }
      });
      if (best < 0) break;
      const [p] = pool.splice(best, 1);
      exp.queue.push(p.id);
      added.push(p);
      last = p;
    }
    return { ok: true, added, msg: added.length ? `⚡ 快速佇列：自動加入附近 ${added.length} 個地點（${added.map((p) => p.name).join('、')}）` : '⚡ 快速佇列：附近沒有可以加入的地點' };
  }

  dequeue(expId, index) {
    const exp = this.list.find((e) => e.id === expId);
    if (!exp?.queue?.[index]) return { ok: false, reason: '找不到這個地點' };
    exp.queue.splice(index, 1);
    return { ok: true, msg: '已從佇列移除' };
  }

  /** 建築已被搜空的原因（報告顯示用） */
  emptyReason(poi, at = Date.now()) {
    const v = this.game.poiShare?.view(poi, at);
    const until = v?.until ? `，${hhmm(v.until)} 恢復` : '';
    return v?.by ? `被${v.by}搜過${until}` : `已經被搜過${until}`;
  }

  /**
   * 從佇列前端移除已被搜空的地點，並記下跳過的原因。
   * @returns {number} 跳過的數量
   */
  skipEmpty(queue, at, events) {
    let n = 0;
    while (queue.length) {
      const p = this.poi(queue[0]);
      if (!p || !POI_TYPES[p.type] || this.hasStock(p, at)) break;
      queue.shift();
      n += 1;
      events.push(`⏭️ 「${p.name}」已被搜空（${this.emptyReason(p, at)}），跳過`);
    }
    return n;
  }

  /** 這趟搜索完之後建築裡是否還有物資（沒搜完的部分或帶不走留下的） */
  leftAfterSearch(cp) {
    if (!cp || cp.stock?.empty) return false;
    const rest = cp.done < cp.total ? Object.values(cp.remaining || {}) : [];
    return [...rest, ...Object.values(cp.overflow || {})].some((v) => v >= 1);
  }

  /** 地點目前是否還有物資（今日物資或上次留下的） */
  hasStock(poi, at = Date.now()) {
    return !!poi && POI_TYPES[poi.type] && !stockOf(poi, at, this.game.poiShare?.view(poi, at)).empty;
  }

  /**
   * 隊員背包都裝滿、倉庫也滿了：再出發也帶不回任何東西。
   * @returns {string|null} 停止原因
   */
  overloadReason(memberIds) {
    const g = this.game;
    const members = memberIds.map((id) => g.survivors.get(id)).filter(Boolean);
    if (!members.length) return null;
    const bagsFull = members.every((m) => g.survivors.bagCap(m) - g.survivors.bagLoad(m) < 1);
    const storeFull = g.equipment.storeUsed() >= g.equipment.storeCap();
    return bagsFull && storeFull ? `隊員背包都已裝滿、倉庫也滿了（${g.equipment.storeUsed()}/${g.equipment.storeCap()} 格），再出發也帶不回物資` : null;
  }

  /** 停止所有臨時小隊的探索佇列與自動探索（記錄原因） */
  stopAllQueues(reason) {
    let n = 0;
    this.list.forEach((e) => {
      if (e.kind !== 'explore') return;
      if ((e.queue || []).length || e.auto) n += 1;
      e.queue = [];
      e.auto = false;
    });
    this.game.log(`⏹️ 探索佇列全部停止：${reason}。請整理倉庫（出售、拆解或擴充）後再派出。`, 'danger');
    this.game.toast('⏹️ 倉庫與背包都滿了，探索佇列已全部停止（詳見消息）', 'danger');
    return n;
  }

  /**
   * 出發。
   * @param {{vehicleIds?:string[], kind?:'explore'|'raid'}} [opts] 載具；raid = 攻打 NPC 據點
   */
  start(poiId, memberIds, durationMin, auto = false, startAt = Date.now(), {
    vehicleIds = [], kind = 'explore', avoidHostile = false, from = null, carried = null,
  } = {}) {
    const v = this.validate(poiId, memberIds);
    if (!v.ok) return v;
    if (kind === 'raid' && this.game.npcs.get?.(poiId)?.hq) return { ok: false, reason: '大本營不能攻打' };
    // 搜索時間由地點決定（攻打 NPC 為固定 5 分鐘）
    durationMin = kind === 'intercept' || kind === 'hunt' || kind === 'assist' || kind === 'rally' || kind === 'cpGuard' ? 0 : kind === 'raid' || kind === 'pvp' || kind === 'infect' || kind === 'cp' ? 2 : this.searchMinutes(v.poi);
    const draft = this.plan(v.poi, v.members, durationMin, startAt, [], { avoidHostile, from });
    const car = this.game.vehicles.validate(vehicleIds, v.members, draft.distanceM);
    if (!car.ok) return car;
    const plan = this.plan(v.poi, v.members, durationMin, startAt, car.vehicles, { avoidHostile, from });
    // v14：控制點區域要自己或好友佔領才能探索；勢力領地不能探索
    if (kind === 'explore' && POI_TYPES[v.poi.type] && !v.poi.npc && this.game.state.map?.source === 'generated') {
      const ce = this.game.cp?.canExplore(v.poi);
      if (ce && !ce.ok) return ce;
    }
    // v15.3：路線只能走可探索的區域，完全繞不過去就不能出發（集結另外判斷：參加者到集結點、發起人從集結點到目標）
    if (plan.path?.noWay && kind !== 'rally') return { ok: false, reason: `沒有路可以到「${v.poi.name}」：中間被未佔領的控制點擋住，要先佔領沿路的控制點` };
    // v10 佔用規則：玩家手動派遣時，確定會撲空（已搜空、或抵達時有人在搜索）就不出發，避免白跑
    if (kind === 'explore' && !from && !carried && Math.abs(startAt - Date.now()) < 5000 && POI_TYPES[v.poi.type] && !v.poi.npc) {
      const block = this.game.poiShare?.blockerAt(v.poi, startAt + plan.travelMs);
      if (block?.reason === 'empty') return { ok: false, reason: `「${v.poi.name}」已被搜空，${hhmm(block.until)} 恢復` };
      if (block) return { ok: false, reason: `抵達時${block.npc ? block.who : `玩家「${block.who}」`}還在探索「${v.poi.name}」（${hhmm(block.l)} 離開），晚一點再派遣` };
    }
    // 路線會經過的敵對警戒範圍（去程與返程各算一次）
    const ignore = this.targetZone(v.poi);
    const back = plan.backPath || [...plan.path].reverse();
    const threats = [
      ...this.game.territory.threats(plan.path, ignore).map((th) => ({ ...th, leg: 'out', done: false })),
      ...this.game.territory.threats(back, ignore).map((th) => ({ ...th, leg: 'back', done: false })),
    ];
    // 連續探索途中不經過避難所，不會從倉庫補給
    const packed = from ? '' : this.packAmmo(v.members);
    v.members.forEach((m) => { m.status = 'exploring'; });
    this.game.vehicles.depart(car.vehicles, plan.trip.fuel);
    const exp = {
      id: uid('ex'), poiId, kind, memberIds: [...memberIds], durationMin, auto,
      // 出發時的累計經驗：報告列出每位隊員這趟拿到的經驗
      xp0: Object.fromEntries(memberIds.map((id) => [id, this.game.survivors.totalXp(this.game.survivors.get(id))])),
      startAt, endAt: startAt + plan.totalMs, phaseAtStart: this.game.time.phaseId(startAt),
      from: plan.from, distanceM: plan.distanceM, travelMs: plan.travelMs, searchMs: plan.searchMs,
      path: plan.path, avoidHostile, threats,
      ...(plan.backPath ? { backPath: plan.backPath, backDistanceM: plan.backDistanceM, backMs: plan.backMs } : {}),
      ...(carried ? { carried } : {}),
      ...(v.poi.pvp ? { pvpTarget: v.poi } : {}),
      ...(v.poi.intercept ? { icptTarget: v.poi.target } : {}),
      ...(v.poi.hunt ? { huntTarget: v.poi.target } : {}),
      ...(v.poi.trade ? { tradeTarget: v.poi.target } : {}),
      vehicleIds: [...vehicleIds], cargo: plan.trip.cargo, ambushes: 0,
      // 攻擊目標的殭屍群不算途中遭遇
      encountered: v.poi.hunt ? [v.poi.target.groupId] : [], travelEvents: [], travelKills: 0, travelXp: 0,
    };
    this.list.push(exp);
    // v10 佔用規則：登記預計抵達與離開的時間（所有玩家共用）
    if (kind === 'explore' && !v.poi.npc && POI_TYPES[v.poi.type]) this.game.poiShare?.claim(exp, v.poi);
    const ride = car.vehicles.length ? `（${car.vehicles.map((x) => this.game.vehicles.def(x).icon).join('')}${plan.trip.fuel ? `・耗油 ${plan.trip.fuel}` : ''}）` : '';
    return { ok: true, exp, msg: `隊伍出發前往「${v.poi.name}」${ride}${packed}` };
  }

  /** 出發前：使用槍械／弓弩的隊員自動從倉庫補充彈藥（約 4 場戰鬥的量） */
  packAmmo(members) {
    const notes = [];
    const svs = this.game.survivors;
    members.forEach((m) => {
      svs.autoResupply(m);
      const need = svs.ammoNeed(m);
      if (!need) return;
      // 沒設定自動補給：出發時把對應彈藥裝進彈藥欄（約 4 場戰鬥）
      const lo = svs.loadout(m);
      const have = lo.ammo?.key === need.ammo ? lo.ammo.qty : 0;
      const want = Math.min(svs.slotMax(m, 'ammo'), need.perFight * AMMO_PACK_FIGHTS) - have;
      if (want > 0 && (!lo.ammo || lo.ammo.key === need.ammo) && (this.game.state.supplies?.[need.ammo] || 0) > 0) svs.loadSlot(m.id, 'ammo', need.ammo, want);
      if (svs.ammoAvailable(m, need.ammo) - (svs.atShelter(m) ? Math.floor(this.game.state.supplies?.[need.ammo] || 0) : 0) < need.perFight) notes.push(`${m.name}沒有${SUPPLIES[need.ammo].name}`);
    });
    return notes.length ? `（⚠️ ${notes.join('、')}，會改用近戰武器）` : '';
  }

  /**
   * 移動途中遇襲：去程或返程經過殭屍群附近時，可能被攻擊（每群只判定一次）。
   * 只在線上每秒檢查；殭屍群只在夜間出現，所以白天移動是安全的。
   * @returns {object[]} 本次發生的遭遇
   */
  /** 途中遇襲（使用存檔種子） */
  checkAmbush(now = Date.now()) {
    return withSeed(this.game.state.rng, 'battle', () => this.checkAmbushNow(now));
  }

  checkAmbushNow(now = Date.now()) {
    [...this.list].forEach((exp) => this.checkThreats(exp, now));
    this.game.intercept?.checkArrivals(now);
    this.checkHunts(now);
    this.list.forEach((exp) => this.runCheckpoints(exp, now));
    const out = [];
    const groups = this.game.state.map.zombieGroups;
    if (!groups.length) return out;
    [...this.list].forEach((exp) => {
      const p = this.progress(exp, now);
      if (!p || p.phase === 'searching' || !exp.encountered) return;
      groups.forEach((g) => {
        if (!this.list.includes(exp) || exp.encountered.includes(g.id)) return;
        if (haversine(p.pos.lat, p.pos.lon, g.lat, g.lon) > AMBUSH_RADIUS_M) return;
        exp.encountered.push(g.id);
        const members = exp.memberIds.map((id) => this.game.survivors.get(id)).filter(Boolean);
        const evade = Math.max(0, ...members.map((m) => this.game.survivors.skillEffects(m).exploreSpeed || 0));
        // 越安全的區域越不容易被殭屍群襲擊
        const zoneMul = this.game.zombies.encounterMul(g.lat, g.lon);
        if (!chance(AMBUSH_CHANCE * zoneMul * (1 - evade * 1.5) * Math.max(0.2, 1 - this.game.research.bonus('ambushReduce')))) {
          exp.travelEvents.push(`👣 悄悄避開了附近的${this.game.zombies.groupLabel(g)}`);
          return;
        }
        exp.ambushes = (exp.ambushes || 0) + 1;
        out.push(this.ambush(exp, g, members, now));
      });
    });
    return out;
  }

  /** 經過敵對據點警戒範圍的時間 */
  threatTime(exp, th) {
    if (th.leg === 'out') return exp.startAt + exp.travelMs * (exp.distanceM ? th.at / exp.distanceM : 0);
    const bd = exp.backDistanceM || exp.distanceM;
    return exp.startAt + exp.travelMs + exp.searchMs + (exp.backMs ?? exp.travelMs) * (bd ? th.at / bd : 0);
  }

  /**
   * 經過敵對（NPC、敵對玩家）且有駐守人員的據點警戒範圍：駐守人員主動攻擊。
   * 勝利則繼續前進；失敗則撤退、本次探索沒有收穫。
   * @returns {object|null} 撤退時的報告
   */
  checkThreats(exp, now) {
    for (const th of exp.threats || []) {
      if (th.done || this.threatTime(exp, th) > now) continue;
      th.done = true;
      if (!this.game.territory.noticed(th)) {
        exp.travelEvents.push(`👣 悄悄穿過「${th.name}」的警戒範圍，沒有被發現`);
        continue;
      }
      const members = exp.memberIds.map((id) => this.game.survivors.get(id)).filter(Boolean);
      const result = this.game.combat.simulate(members, this.game.territory.defenders(th), { title: `⚔️ 經過「${th.name}」的警戒範圍`, ref: exp });
      this.game.combat.applyOutcome(members, result, now);
      if (result.refills) exp.travelEvents.push(`💊 ${result.refills.join('；')}`);
      exp.travelKills += result.kills.length;
      exp.travelXp += result.xp;
      exp.ambushes = (exp.ambushes || 0) + 1;
      const who = th.kind === 'npc' ? `NPC「${th.name}」` : `玩家「${th.owner}」的「${th.name}」`;
      if (result.victory) {
        exp.travelEvents.push(`⚔️ 進入${who}的警戒範圍，擊退駐守人員`);
        this.game.log(`⚔️ 探索隊擊退了${who}的駐守人員`, 'success');
        continue;
      }
      return this.retreat(exp, `💀 進入${who}的警戒範圍，被駐守人員擊退`, now);
    }
    return null;
  }

  /** 撤退：探索提前結束、沒有收穫 */
  retreat(exp, text, now) {
    const poi = this.poi(exp.poiId);
    const members = exp.memberIds.map((id) => this.game.survivors.get(id)).filter(Boolean);
    this.game.state.stats.battlesLost += 1;
    exp.travelEvents.push(text);
    this.game.toast(`${text}（前往「${poi?.name || '目的地'}」的隊伍撤退）`, 'danger');
    this.game.log(text, 'danger');
    this.game.state.expeditions = this.list.filter((e) => e.id !== exp.id);
    this.free(exp);
    const wear = this.game.vehicles.returnHome(exp.vehicleIds || [], exp.distanceM || 0, exp.ambushes || 0);
    const carriedNote = this.bringCarried(exp, 1, members);
    const report = {
      id: uid('rp'), poiName: poi?.name || '未知地點', poiType: poi?.type, at: now,
      events: [...exp.travelEvents, '🏳️ 隊伍帶著傷撤回據點，這個地點沒有收穫。', ...(carriedNote ? [carriedNote] : []), ...wear],
      resources: {}, items: [], blueprints: [], kills: exp.travelKills, xp: exp.travelXp, success: false,
      members: members.map((m) => m.name),
    };
    report.retreated = true;
    this.tagZone(report, exp);
    this.attachXp(report, exp);
    this.game.state.reports = [report, ...(this.game.state.reports || [])].slice(0, 20);
    this.game.bus.emit('expedition:done', [report]);
    return report;
  }

  /** 建築內遭遇殭屍的強度：對倖存者的攻擊較強，夜晚更危險（區域越危險越強） */
  encounterMul(ctx) {
    const night = ctx.phase?.zombies ? {
      hp: NIGHT_MUL.hp + NIGHT_MUL.perDanger * Math.max(0, ctx.zone.danger || 0),
      atk: NIGHT_MUL.atk + NIGHT_MUL.perDanger * Math.max(0, ctx.zone.danger || 0),
    } : null;
    // 高危險區的建築內殭屍更強（不分日夜）
    const zm = BUILDING_ZONE.statMul[Math.min(3, ctx.zone?.danger || 0)] || 1;
    // 白天：高危區的殭屍生命、攻擊加成
    const dm = !ctx.phase?.zombies ? DAY_ZONE.stat[ctx.zone?.id] || 1 : 1;
    return mulOf(ZOMBIE_VS_SURVIVOR, night, { hp: zm * dm, atk: zm * dm });
  }

  /** 途中遭遇戰：勝利則消滅殭屍群繼續前進，失敗則全隊撤退、探索結束 */
  ambush(exp, g, members, now) {
    const poi = this.poi(exp.poiId);
    const enemies = Array.from({ length: g.count }, () => this.game.combat.createEnemy(g.enemyId, g.level, g.elite, this.game.zombies.groupMul(g)));
    const result = this.game.combat.simulate(members, enemies, { title: `🧟 途中遭遇 ${this.game.zombies.groupLabel(g)}`, ref: exp });
    this.game.combat.applyOutcome(members, result, now);
    if (result.refills) exp.travelEvents.push(`💊 ${result.refills.join('；')}`);
    const label = `${ALL_ENEMIES[g.enemyId].icon} ${this.game.zombies.groupLabel(g)}`;
    exp.travelKills += result.kills.length;
    exp.travelXp += result.xp;
    const where = this.progress(exp, now)?.phase === 'returning' ? '返程途中' : '前往途中';
    if (result.victory) {
      this.game.state.stats.battlesWon += 1;
      this.game.zombies.killGroup(g, this.game.state.player.name);
      exp.travelEvents.push(`⚔️ ${where}遭遇${label}，擊退！（擊殺 ${result.kills.length}，💰${Math.round(result.coins * COIN_GAIN_MUL)}）`);
      this.game.toast(`⚔️ 前往「${poi?.name}」的隊伍${where}遭遇殭屍，成功擊退`, 'success');
      this.game.log(`⚔️ 探索隊${where}擊退${this.game.zombies.groupLabel(g)}`, 'success');
      this.game.bus.emit('map:changed');
      return { exp, group: g, result, aborted: false };
    }
    this.game.state.stats.battlesLost += 1;
    this.game.zombies.hurtGroup(g, result.kills.length);
    exp.travelEvents.push(`💀 ${where}遭遇${label}，戰敗撤退`);
    this.game.toast(`💀 前往「${poi?.name}」的隊伍${where}遭到襲擊，被迫撤退！`, 'danger');
    this.game.log(`💀 探索隊${where}遭${this.game.zombies.groupLabel(g)}襲擊，撤退`, 'danger');
    // 撤退：探索提前結束，沒有收穫
    this.game.state.expeditions = this.list.filter((e) => e.id !== exp.id);
    this.free(exp);
    const wear = this.game.vehicles.returnHome(exp.vehicleIds || [], exp.distanceM || 0, exp.ambushes || 0);
    const report = {
      id: uid('rp'), poiName: poi?.name || '未知地點', poiType: poi?.type, at: now,
      events: [...exp.travelEvents, '🏳️ 隊伍帶著傷撤回據點，本次探索沒有收穫。', ...wear],
      resources: {}, items: [], blueprints: [], kills: exp.travelKills, xp: exp.travelXp, success: false,
      members: members.map((m) => m.name),
    };
    this.tagZone(report, exp);
    this.attachXp(report, exp);
    this.game.state.reports = [report, ...(this.game.state.reports || [])].slice(0, 20);
    this.game.bus.emit('expedition:done', [report]);
    return { exp, group: g, result, aborted: true };
  }

  /** 是否還能召回：已經在返程（或被擊敗撤回中）的隊伍不需要召回 */
  canRecall(exp, now = Date.now()) {
    if (!exp || exp.defeated || exp.recalled || exp.kind === 'rally') return false;
    return this.progress(exp, now)?.phase !== 'returning';
  }

  /** 沒有可參考的路程時，依隊伍目前的步行速度估算每公尺需要的毫秒數 */
  walkRate(exp, now = Date.now()) {
    const members = exp.memberIds.map((id) => this.game.survivors.get(id)).filter(Boolean);
    const vehicles = (exp.vehicleIds || []).map((id) => this.game.vehicles.get(id)).filter(Boolean);
    const scout = Math.max(0, ...members.map((m) => (this.game.survivors.skillEffects(m).exploreSpeed || 0)
      + (this.game.survivors.stats(m).exploreSpeed || 0)));
    const speed = this.game.time.exploreSpeedMul(now) * (1 + scout + this.game.research.bonus('exploreSpeed'));
    const trip = this.game.vehicles.tripStats(members, vehicles, 1000);
    return (MIN_PER_KM_ONE_WAY / 1000) * 60000 / (speed * (trip?.speed || 1));
  }

  /**
   * 隊伍立刻折返：從目前位置走回避難所（需要移動時間），途中的搜索、交戰都取消。
   * 召回與被攔截擊敗共用。
   */
  turnBack(exp, now = Date.now(), at = null) {
    // at：指定目前位置（集結隊伍在集結點時，位置不在原本的去程路線上）
    const p = at ? { pos: at } : this.progress(exp, now);
    const home = this.game.shelter.primary() || exp.from;
    if (!p || !home) return false;
    // 回程路線同樣繞開警戒範圍
    const route = this.game.territory?.route ? this.game.territory.route(p.pos, home, { avoidHostile: exp.avoidHostile }) : null;
    const dist = route?.length > 1 ? pathLength(route) : haversine(p.pos.lat, p.pos.lon, home.lat, home.lon);
    // 移動速度（毫秒/公尺）：取這趟去程或回程的速度；連續探索在同一地點再搜索時去程距離為 0，
    // 以前用去程換算會得到 0 而瞬間回家
    const rate = exp.distanceM > 0 && exp.travelMs > 0 ? exp.travelMs / exp.distanceM
      : exp.backDistanceM > 0 && exp.backMs > 0 ? exp.backMs / exp.backDistanceM
        : this.walkRate(exp, now);
    const travelMs = Math.round(dist * rate);
    const back = route?.length > 1 ? [...route].reverse() : [{ lat: home.lat, lon: home.lon }, p.pos];
    Object.assign(exp, {
      from: { lat: home.lat, lon: home.lon }, path: back,
      distanceM: Math.round(dist), travelMs, searchMs: 0, startAt: now - travelMs, endAt: now + travelMs,
      threats: [], auto: false, backPath: null, backMs: null, backDistanceM: null,
    });
    return true;
  }

  /** 召回：隊伍從目前位置走回避難所，這趟沒有收穫 */
  recall(expId, now = Date.now()) {
    const exp = this.list.find((e) => e.id === expId);
    if (!exp) return { ok: false, reason: '找不到隊伍' };
    if (!this.canRecall(exp, now)) return { ok: false, reason: '隊伍已經在返程中' };
    // 已經到達的檢核點先結算，撤回時帶回已取得的物資
    this.runCheckpoints(exp, now);
    if (!this.turnBack(exp, now)) return { ok: false, reason: '找不到隊伍的位置' };
    exp.recalled = true;
    // 還沒抵達的攔截、獵殺不再交戰
    exp.icptDone = true;
    exp.huntDone = true;
    exp.travelEvents = [...(exp.travelEvents || []), '↩️ 收到召回命令，隊伍折返避難所'];
    const keep = exp.kind === 'explore' && exp.cp?.done > 0;
    return { ok: true, msg: `隊伍折返中，約 ${Math.max(1, Math.round(exp.travelMs / 60000))} 分鐘後回到避難所${keep ? '（帶回已找到的物資）' : '（無收穫）'}` };
  }

  /** 召回的隊伍回到避難所時的報告 */
  recalledReport(exp) {
    const poi = this.poi(exp.poiId);
    const members = exp.memberIds.map((id) => this.game.survivors.get(id)).filter(Boolean);
    return {
      id: uid('rp'), poiName: poi?.name || exp.huntTarget?.label || exp.icptTarget?.name || '未知地點', poiType: poi?.type, at: exp.endAt,
      events: [...(exp.travelEvents || []), '🏠 隊伍回到避難所，這趟沒有收穫。'],
      resources: {}, items: [], blueprints: [], kills: exp.travelKills || 0, xp: exp.travelXp || 0, success: false,
      members: members.map((m) => m.name),
    };
  }

  toggleAuto(expId) {
    const exp = this.list.find((e) => e.id === expId);
    if (!exp) return { ok: false };
    exp.auto = !exp.auto;
    return { ok: true, msg: exp.auto ? '已開啟自動探索' : '已關閉自動探索' };
  }

  free(exp) {
    // 還留著的佔用紀錄（撤退、被擊敗、還沒搜索就回家）一併移除
    if (exp.claimed) this.game.poiShare?.release(exp, this.poi(exp.poiId), null);
    exp.memberIds.forEach((id) => {
      const m = this.game.survivors.get(id);
      // 副本中的倖存者（17:50 召回後還在回家路上）不改回在家
      if (m && m.status === 'exploring' && !m.dungeon) m.status = 'idle';
      // 回到避難所：依自動補給設定從倉庫補貨
      const got = m && this.game.survivors.autoResupply(m);
      if (got) this.game.log(`🔄 ${m.name} 回到避難所，自動補給 ${got}`, 'info');
    });
    this.game.vehicles.release(exp.vehicleIds || []);
    // 指定給這支小隊的載具：先回到可出車狀態（接著再出門時一起出車；小隊結束則歸還車庫）
    this.game.vehicles.unreserve(exp.nextVehicleIds || []);
  }

  /** 小隊下一次出門使用的載具：目前的載具 + 指定的載具 */
  nextVehicles(exp) {
    // 回程時損壞的載具（包含目前使用中的）這次不帶，回到車庫後可以維修
    return [...new Set([...(exp.vehicleIds || []), ...(exp.nextVehicleIds || [])])]
      .filter((id) => { const v = this.game.vehicles.get(id); return v && !this.game.vehicles.isBroken(v); });
  }

  /**
   * 指定載具給臨時小隊：回到避難所後、下一次出門時自動生效。確認後不可取消或變更，其他人也不能選用、拆解。
   * @param {{dry?:boolean}} [opts] dry = 只檢查不套用
   */
  /**
   * 臨時小隊目前的隊伍編號：小隊每到下一站會換成新的隊伍編號，畫面上還開著的視窗可能拿著上一站的編號。
   * 依原本的編號找不到時，改找成員相同、還在外面的探索隊。
   */
  squadNow(expId, memberIds = null) {
    const cur = this.list.find((e) => e.id === expId);
    if (cur) return cur;
    const ids = memberIds || [];
    if (!ids.length) return null;
    const key = [...ids].sort().join(',');
    return this.list.find((e) => e.kind === 'explore' && !e.recalled && !e.defeated && [...e.memberIds].sort().join(',') === key) || null;
  }

  assignVehicles(expId, vehicleIds, { dry = false } = {}) {
    const exp = this.list.find((e) => e.id === expId);
    if (!exp || exp.kind !== 'explore' || exp.recalled || exp.defeated) return { ok: false, reason: '這支小隊無法指定載具' };
    if (!vehicleIds.length) return { ok: true };
    if ((exp.nextVehicleIds || []).length) return { ok: false, reason: '這支小隊已經指定過載具，無法變更' };
    const vs = this.game.vehicles;
    const list = vehicleIds.map((id) => vs.get(id));
    if (list.some((v) => !v || !vs.isAvailable(v))) return { ok: false, reason: '有載具無法使用（出勤中、已被指定或損壞）' };
    const total = new Set([...(exp.vehicleIds || []), ...vehicleIds]).size;
    if (total > exp.memberIds.length) return { ok: false, reason: `每台載具至少需要一名駕駛（小隊 ${exp.memberIds.length} 人，載具共 ${total} 台）` };
    if (dry) return { ok: true };
    exp.nextVehicleIds = [...vehicleIds];
    vs.reserve(vehicleIds, exp.id);
    return { ok: true, msg: `已指定載具：${list.map((v) => vs.def(v).name).join('、')}（回到避難所後下一次出門時生效）` };
  }

  /**
   * 結算到期的探索；離線時可能一次結算多輪自動探索。
   * @returns {object[]} 報告列表
   */
  /** 結算探索（使用存檔種子） */
  update(now, { silent = false } = {}) {
    return withSeed(this.game.state.rng, 'explore', () => this.updateNow(now, { silent }));
  }

  /** 隊伍目前背著的重量（前幾站帶著的＋這一站找到的）與運載量 */
  teamLoad(exp) {
    const cap = exp.cargo || this.game.vehicles.personCarry() * exp.memberIds.length;
    const here = Object.entries(exp.cp?.gained || {}).filter(([k]) => isLootKey(k)).reduce((s, [k, v]) => s + v * unitWeight(k), 0);
    return { used: carriedWeight(exp.carried) + here, cap };
  }

  /** 連續探索開關（預設開啟） */
  toggleChain(expId) {
    const exp = this.list.find((e) => e.id === expId);
    if (!exp) return { ok: false, reason: '找不到隊伍' };
    exp.chain = exp.chain === false;
    return { ok: true, msg: exp.chain ? '已開啟：背包有空間就直接前往下一個地點' : '已關閉：每個地點探索完都先回避難所' };
  }

  /**
   * 連續探索：搜索完一個地點時，背包還有空間（負重未達 90%）且佇列還有地點，就直接從這裡前往下一個地點。
   * @returns {object[]} 這次產生的報告
   */
  chainHops(now) {
    const out = [];
    for (const exp of [...this.list]) {
      if (exp.kind !== 'explore' || exp.chain === false || exp.recalled || exp.defeated) continue;
      let searchEnd = exp.startAt + (exp.travelMs || 0) + (exp.searchMs || 0);
      if (now < searchEnd || exp.chainChecked) continue;
      const poi = this.poi(exp.poiId);
      const queue = [...(exp.queue || [])];
      const autoOn = !!exp.auto;
      if (!poi || (!queue.length && !autoOn)) continue;
      // 有指定給小隊的載具在家等著：先回家換車
      if ((exp.nextVehicleIds || []).length) continue;
      this.runCheckpoints(exp, this.checkpointAt(exp, exp.cp?.total || this.checkpointCount(poi)));
      const cp = exp.cp;
      exp.chainChecked = true;
      // 抵達時被搶先：沒有搜索，直接從這裡前往下一站
      searchEnd = exp.startAt + (exp.travelMs || 0) + (exp.searchMs || 0);
      if (!cp || cp.stopped || cp.failed || cp.done < cp.total) continue;
      const members = exp.memberIds.map((id) => this.game.survivors.get(id));
      if (members.some((m) => !m || m.severe)) continue;
      const cap = exp.cargo || this.game.vehicles.personCarry() * members.length;
      const load = carriedWeight(exp.carried) + Object.entries(cp.gained).filter(([k]) => isLootKey(k)).reduce((s, [k, v]) => s + v * unitWeight(k), 0);
      const pct = Math.round((load / Math.max(1, cap)) * 100);
      // 「還有物資」要看這趟搜索完之後建築裡剩下的（帶不走留下的），不能用搜索前的庫存判斷
      const again = autoOn && this.leftAfterSearch(cp);
      // 佇列中已被搜空的地點直接跳過（例如加入後被 NPC 搜走）
      // 跳過的紀錄接在這個地點的搜索紀錄後面
      if (!again) this.skipEmpty(queue, searchEnd, cp.events);
      exp.queue = [...queue];
      const nextId = again ? poi.id : queue[0];
      if (!nextId) continue;
      if (load >= cap * CHAIN_RETURN_LOAD || this.overloadReason(exp.memberIds)) {
        exp.travelEvents = [...(exp.travelEvents || []), `🎒 負重已達 ${pct}%（${Math.round(load)}/${cap}），返回避難所卸貨`];
        continue;
      }
      // 先確認下一個地點能出發（不能的話照原本回家）
      members.forEach((m) => { if (!m.dungeon) m.status = 'idle'; });
      const check = this.validate(nextId, exp.memberIds);
      if (!check.ok) {
        members.forEach((m) => { m.status = 'exploring'; });
        exp.travelEvents = [...(exp.travelEvents || []), `⏭️ 無法直接前往下一個地點（${check.reason}），先返回避難所`];
        continue;
      }
      members.forEach((m) => { m.status = 'exploring'; });
      const report = this.finishExplore(exp, { carry: true });
      report.at = searchEnd;
      const nextPoi = this.poi(nextId);
      this.list.splice(this.list.indexOf(exp), 1);
      members.forEach((m) => { if (!m.dungeon) m.status = 'idle'; });
      this.game.vehicles.release(exp.vehicleIds || []);
      const r = this.start(nextId, exp.memberIds, exp.durationMin, exp.auto, searchEnd, {
        vehicleIds: (exp.vehicleIds || []).filter((id) => { const v = this.game.vehicles.get(id); return v && !this.game.vehicles.isBroken(v); }),
        avoidHostile: exp.avoidHostile, from: { lat: poi.lat, lon: poi.lon }, carried: exp.carried,
      });
      if (!r.ok) {
        // 理論上已檢查過；萬一失敗，物資照樣帶回避難所
        members.forEach((m) => { if (!m.dungeon) m.status = 'idle'; });
        report.carried = false;
        this.game.grant(exp.carried?.gained || {}); // 報告仍只列這一站的收穫
        report.events.push(`⏭️ 無法前往下一個地點（${r.reason}），物資已帶回避難所`);
      } else {
        const ne = r.exp;
        ne.queue = nextId === poi.id ? queue : queue.slice(1);
        ne.nextVehicleIds = exp.nextVehicleIds;
        // 地圖顯示用：記下這趟已經走過的路線與搜索過的地點
        const leg = Array.isArray(exp.path) && exp.path.length >= 2 ? exp.path : [exp.from || poi, poi];
        const trail = [...(exp.trail || [])];
        leg.forEach((q) => {
          const last = trail[trail.length - 1];
          if (!last || Math.abs(last.lat - q.lat) > 1e-7 || Math.abs(last.lon - q.lon) > 1e-7) trail.push({ lat: q.lat, lon: q.lon });
        });
        ne.trail = trail.length > 300 ? trail.filter((_, i) => i === 0 || i === trail.length - 1 || i % Math.ceil(trail.length / 300) === 0) : trail;
        // 搜索過的地點標 ✓；抵達時被別人搶先或已被搜空而跳過的不算（地圖改顯示該地點目前的實際狀態）
        ne.stops = exp.cp?.bumped ? [...(exp.stops || [])] : [...new Set([...(exp.stops || []), poi.id])];
        report.events.push(nextId === poi.id
          ? `🎒 背包還有空間（負重 ${Math.round(load)}/${cap}），「${poi.name}」還有物資，直接再搜索一次`
          : `🎒 背包還有空間（負重 ${Math.round(load)}/${cap}），直接前往「${nextPoi?.name || ''}」${ne.queue.length ? `（佇列還有 ${ne.queue.length} 個）` : ''}`);
      }
      this.tagZone(report, exp);
      this.attachXp(report, exp);
      out.push(report);
    }
    return out;
  }

  updateNow(now, { silent = false } = {}) {
    const reports = [];
    let guard = 0;
    // 連續探索：一次處理到目前時間為止的所有轉站（離線時可能連續好幾站）
    for (let k = 0; k < 20; k += 1) {
      const hops = this.chainHops(now);
      if (!hops.length) break;
      reports.push(...hops);
    }
    let due = this.list.filter((e) => e.endAt <= now);
    while (due.length && guard < 400) {
      guard += 1;
      due.forEach((exp) => {
        // 離線或背景時沒有即時判定的警戒範圍遭遇，結算前補算
        const retreated = this.checkThreats(exp, exp.endAt);
        if (retreated) {
          this.attachXp(retreated, exp);
          reports.push(retreated);
          return;
        }
        this.game.state.expeditions = this.list.filter((e) => e.id !== exp.id);
        const report = this.game.combat.within(exp, () => (exp.kind === 'rally' ? this.game.rally.report(exp)
          : exp.kind === 'assist' && !exp.defeated ? this.game.assist.report(exp)
          : exp.recalled ? (exp.kind === 'explore' ? this.finishExplore(exp, { recalled: true }) : this.recalledReport(exp))
          : exp.defeated ? this.game.intercept.defeatedReport(exp)
          : exp.kind === 'hunt' ? this.huntReport(exp)
          : exp.kind === 'intercept' ? this.game.intercept.report(exp)
            : exp.kind === 'raid' ? this.game.npcs.resolveRaid(exp)
            : exp.kind === 'infect' ? this.game.infected.resolveAttack(exp)
            : exp.kind === 'cp' ? this.game.cp.report(exp)
            : exp.kind === 'cpGuard' ? this.game.cp.guardReport(exp)
              : exp.kind === 'pvp' ? this.game.territory.resolvePvp(exp) : this.resolve(exp)));
        // 召回（手動召回、自動回家、集結取消走回家）：標記為召回，不是探索失敗
        if (exp.recalled && !report.success && !exp.defeated) report.recalled = true;
        report.events.push(...this.game.vehicles.returnHome(exp.vehicleIds || [], exp.distanceM || 0, exp.ambushes || 0));
        this.tagZone(report, exp);
        this.attachXp(report, exp);
        reports.push(report);
        this.free(exp);
        // 自動探索：隊員健康且未超過離線上限則再次出發（燃料不足或載具損壞則停止）
        const healthy = exp.memberIds.every((id) => {
          const m = this.game.survivors.get(id);
          return m && !m.severe;
        });
        if (exp.kind !== 'explore' || exp.defeated || exp.recalled || !healthy || now - exp.endAt >= OFFLINE_CAP_MS) return;
        const queue = [...(exp.queue || [])];
        const autoOn = !!exp.auto;
        if (!queue.length && !autoOn) return;
        // 隊員背包都滿、倉庫也滿：停止所有佇列並說明原因
        const full = this.overloadReason(exp.memberIds);
        if (full) {
          report.events.push(`⏹️ 探索佇列停止：${full}`);
          this.stopAllQueues(full);
          return;
        }
        // 自動探索：同一個地點的物資拿光才前往下一個地點
        const poiNow = this.poi(exp.poiId);
        if (autoOn && this.hasStock(poiNow, exp.endAt)) {
          const r = this.start(exp.poiId, exp.memberIds, exp.durationMin, true, exp.endAt, { vehicleIds: this.nextVehicles(exp), avoidHostile: exp.avoidHostile });
          if (r.ok) {
            r.exp.queue = queue;
            report.events.push(`🔁 「${poiNow?.name || ''}」還有物資，自動再搜索一次`);
            return;
          }
          report.events.push(`⏹️ 自動探索無法再出發：${r.reason}`);
        }
        // 臨時小隊的探索佇列：前往佇列中的下一個地點
        let started = null;
        while (queue.length && !started) {
          if (this.skipEmpty(queue, exp.endAt, report.events) && !queue.length) break;
          const poiId = queue.shift();
          const r = this.start(poiId, exp.memberIds, exp.durationMin, exp.auto, exp.endAt, { vehicleIds: this.nextVehicles(exp) });
          if (r.ok) started = r.exp;
          else report.events.push(`⏭️ 佇列中的地點無法前往：${r.reason}`);
        }
        if (started) {
          started.queue = queue;
          report.events.push(`➡️ 依探索佇列前往下一個地點「${this.poi(started.poiId)?.name || ''}」${queue.length ? `（佇列還有 ${queue.length} 個）` : ''}`);
          return;
        }
        if (autoOn) report.events.push(`⏹️ 自動探索結束：「${poiNow?.name || '這裡'}」的物資已經拿光，佇列中也沒有下一個地點`);
      });
      due = this.list.filter((e) => e.endAt <= now);
    }
    if (reports.length) {
      const st = this.game.state;
      // 撤退的報告已經記錄過，不重複加入
      st.reports = [...reports.filter((r) => !r.retreated).reverse(), ...(st.reports || [])].slice(0, 20);
      if (!silent) {
        reports.forEach((r) => this.game.toast(r.success ? `✅ ${r.poiName} 探索完成` : r.recalled ? `🏠 ${r.poiName} 隊伍已召回` : `⚠️ ${r.poiName} 探索受挫`, r.success ? 'success' : r.recalled ? 'info' : 'danger'));
      }
      this.game.bus.emit('expedition:done', reports);
    }
    return reports;
  }

  // ---------- 攻擊地圖上的殭屍群：移動 → 抵達交戰 → 返回 ----------

  /** 殭屍群當成目的地：id = hunt:殭屍群ID */
  huntPoi(id) {
    if (!String(id).startsWith('hunt:')) return null;
    this.huntCache = this.huntCache || new Map();
    const t = this.huntCache.get(id) || this.list.find((e) => e.poiId === id)?.huntTarget;
    return t && {
      id, name: t.label, lat: t.lat, lon: t.lon, type: 'military', icon: '🧟', hunt: true, target: t,
    };
  }

  /** 派隊攻擊殭屍群 */
  startHunt(groupId, memberIds, opts = {}) {
    const g = this.game.state.map.zombieGroups.find((x) => x.id === groupId);
    if (!g) return { ok: false, reason: '殭屍群已離開' };
    if (!this.game.time.phase().zombies) return { ok: false, reason: '天亮了，殭屍已躲回建築內' };
    const id = `hunt:${groupId}`;
    if (this.list.some((e) => e.poiId === id)) return { ok: false, reason: '已經有隊伍前往攻擊這群殭屍' };
    this.huntCache = this.huntCache || new Map();
    this.huntCache.set(id, { groupId, lat: g.lat, lon: g.lon, label: `🧟 ${this.game.zombies.groupLabel(g)}` });
    return this.start(id, memberIds, 0, false, Date.now(), { ...opts, kind: 'hunt' });
  }

  /** 攻擊隊抵達殭屍群時交戰（線上每秒、離線結算時檢查） */
  checkHunts(now = Date.now()) {
    this.list.forEach((exp) => {
      if (exp.kind !== 'hunt' || exp.huntDone) return;
      const at = exp.startAt + (exp.travelMs || 0);
      if (now >= at) this.huntArrive(exp, at);
    });
  }

  huntArrive(exp, at) {
    exp.huntDone = true;
    const t = exp.huntTarget || {};
    const r = this.game.combat.within(exp, () => this.game.zombies.attack(t.groupId, exp.memberIds, { arrived: true, at }));
    if (!r.ok) {
      exp.huntResult = { win: false, missed: true, events: [`🏳️ 抵達時${r.reason}，撲空了。`] };
      return;
    }
    const { result, loot } = r;
    exp.travelKills = (exp.travelKills || 0) + result.kills.length;
    exp.travelXp = (exp.travelXp || 0) + result.xp;
    exp.huntResult = {
      win: result.victory,
      resources: loot.resources || {},
      items: (loot.items || []).map((it) => ({ name: it.name, rarity: it.rarity })),
      events: [result.victory
        ? `⚔️ 擊退${t.label}！（擊殺 ${result.kills.length}，💰${Math.round(result.coins * COIN_GAIN_MUL)}）`
        : `💀 攻擊${t.label}失敗，隊伍撤退`],
    };
    const msg = result.victory ? `⚔️ 攻擊隊擊退了${t.label}` : `💀 攻擊隊被${t.label}擊退`;
    this.game.log(msg, result.victory ? 'success' : 'danger');
    this.game.toast(msg, result.victory ? 'success' : 'danger');
    this.game.bus.emit('map:changed');
  }

  /** 攻擊殭屍群的隊伍返回時的報告 */
  huntReport(exp) {
    if (!exp.huntDone) this.huntArrive(exp, exp.startAt + (exp.travelMs || 0));
    const r = exp.huntResult;
    const members = exp.memberIds.map((id) => this.game.survivors.get(id)).filter(Boolean);
    return {
      id: uid('rp'), poiName: exp.huntTarget?.label || '殭屍群', poiType: 'military', at: exp.endAt,
      events: [...(exp.travelEvents || []), ...r.events], resources: r.resources || {}, items: r.items || [], blueprints: [],
      kills: exp.travelKills || 0, xp: exp.travelXp || 0, success: !!r.win, members: members.map((m) => m.name),
    };
  }

  // ---------- 探索檢核點：小型 1 次、中型 2 次、大型 3 次、巨型 4 次 ----------

  /** 這個地點的檢核點數量（依建築大小） */
  checkpointCount(poi) {
    const order = ['small', 'medium', 'large', 'huge'];
    return Math.max(1, order.indexOf(baseSizeOf(poi)) + 1);
  }

  /** 第 k 個檢核點的時間：搜索時間平均分配，最後一個在搜索完成時 */
  checkpointAt(exp, k) {
    const total = exp.cp?.total || 1;
    return exp.startAt + (exp.travelMs || 0) + ((exp.cp?.searchMs ?? exp.searchMs) || 0) * (k / total);
  }

  /** 搜索進度（0～1）；沒有在搜索或已完成時為 null */
  searchProgress(exp) {
    const cp = exp.cp;
    if (!cp || cp.done <= 0 || cp.done >= cp.total || cp.stopped) return null;
    return cp.done / cp.total;
  }

  /** 探索的共用資料（物資、加成），抵達時判定一次 */
  exploreContext(exp) {
    const poi = this.poi(exp.poiId);
    const members = exp.memberIds.map((id) => this.game.survivors.get(id)).filter(Boolean);
    if (!poi || !members.length || !POI_TYPES[poi.type]) return null;
    const phase = this.game.time.phase(exp.startAt);
    const memberStats = members.map((m) => this.game.survivors.stats(m));
    const fx = members.map((m) => this.game.survivors.skillEffects(m));
    return {
      poi,
      members,
      pt: POI_TYPES[poi.type],
      zone: zoneAt(poi.lat, poi.lon),
      danger: this.game.zombies.areaDanger(poi),
      // 夜晚遭遇的殭屍依區域安全程度調整等級（午夜較強，但安全區有上限）
      level: this.game.zombies.buildingLevel(poi, phase),
      zoneMul: phase.zombies ? this.game.zombies.encounterMul(poi.lat, poi.lon) : DAY_ZONE.encounter[zoneAt(poi.lat, poi.lon).id] ?? 1,
      phase,
      // 不含日夜的物資倍率（日夜依每段搜索的實際時間另外套用，見 atPhase）
      lootBase: (1 + this.game.research.bonus('lootPct'))
        * (1 + Math.max(0, ...fx.map((f) => f.lootPct || 0)))
        * (1 + memberStats.reduce((sum, x) => sum + (x.lootBonus || 0), 0)),
      lootMul: phase.lootMul * (1 + this.game.research.bonus('lootPct'))
        * (1 + Math.max(0, ...fx.map((f) => f.lootPct || 0)))
        * (1 + memberStats.reduce((sum, x) => sum + (x.lootBonus || 0), 0)),
      forage: Math.max(0, ...fx.map((f) => f.forage || 0)) + this.game.research.bonus('forageAdd'),
      itemBoost: 1 + Math.max(0, ...fx.map((f) => f.itemPct || 0)) + this.game.research.bonus('itemFindPct'),
      arriveAt: exp.startAt + (exp.travelMs || 0),
      carry: exp.cargo || this.game.vehicles.personCarry() * members.length,
    };
  }

  /** 處理到 now 為止的檢核點（線上每秒、離線結算與召回前都會補算） */
  runCheckpoints(exp, now = Date.now()) {
    if (exp.kind !== 'explore' || exp.defeated || exp.recalled) return;
    return withSeed(this.game.state.rng, 'explore', () => {
      const ctx = this.exploreContext(exp);
      if (!ctx) return;
      // 抵達前不開始搜索（抵達時才判斷是否被搶先）
      if (!exp.cp && now < ctx.arriveAt) return;
      if (!exp.cp) {
        // v10 佔用規則：比自己早抵達、還在搜索的隊伍優先；已搜空也不搜索。自動前往下一個地點或回家
        const block = this.game.poiShare?.blockerAt(ctx.poi, ctx.arriveAt, exp.id);
        if (block) {
          const text = block.reason === 'empty'
            ? `🕸️ 抵達時「${ctx.poi.name}」已被搜空（${block.by ? `被${block.by}搜過，` : ''}${hhmm(block.until)} 恢復）`
            : `🔍 抵達時${block.npc ? block.who : `玩家「${block.who}」`}正在探索「${ctx.poi.name}」（比你早抵達），這裡先讓給對方`;
          exp.cp = {
            emptyBy: null, total: 0, done: 0, searchMs: 0, bumped: text, stock: { resources: {}, empty: true }, remaining: {}, gained: {}, items: [], blueprints: [], vehicles: [], events: [text], kills: 0, xp: 0, failed: false, stopped: false, overflow: {},
          };
          exp.searchMs = 0;
          exp.endAt = ctx.arriveAt + (exp.backMs ?? (exp.travelMs || 0));
          this.game.poiShare.release(exp, ctx.poi, null);
          return;
        }
        const view = this.game.poiShare?.view(ctx.poi, ctx.arriveAt);
        const stock = stockOf(ctx.poi, ctx.arriveAt, view);
        // 研究「零件辨識」：有機率在建築裡多找到一種零件
        const pk = this.game.research.bonus('partKindPct');
        if (pk > 0 && !stock.partial && !stock.empty && Object.keys(stock.resources).some((k) => SUPPLIES[k]?.cat === 'part') && chance(pk)) {
          const zone = zoneAt(ctx.poi.lat, ctx.poi.lon);
          const k = pickSupply('part', Math.random, ctx.pt.danger + Math.max(0, zone.danger || 0), ctx.poi.type);
          stock.resources[k] = (stock.resources[k] || 0) + randInt(2, 6);
        }
        exp.cp = {
          emptyBy: stock.empty ? this.emptyReason(ctx.poi, ctx.arriveAt) : null,
          // 搜過一部分：從剩下的檢核點繼續（offset＝前一位已經搜完的數量）
          total: view?.left ? Math.max(1, (view.left.total || 1) - (view.left.done || 0)) : this.checkpointCount(ctx.poi),
          offset: view?.left ? Math.min(view.left.done || 0, (view.left.total || 1) - 1) : 0,
          allTotal: view?.left ? view.left.total || 1 : this.checkpointCount(ctx.poi),
          gen: view?.gen || 0,
          done: 0, searchMs: exp.searchMs || 0,
          stock: { resources: { ...stock.resources }, itemMul: stock.itemMul, gear: stock.gear, vehicle: stock.vehicle, empty: stock.empty, partial: !!stock.partial },
          remaining: { ...stock.resources }, gained: {}, items: [], blueprints: [], vehicles: [], events: [], kills: 0, xp: 0, failed: false, stopped: false, overflow: {},
        };
      }
      const cp = exp.cp;
      while (!cp.stopped && cp.done < cp.total && now >= this.checkpointAt(exp, cp.done + 1)) {
        this.checkpoint(exp, ctx, cp.done + 1);
      }
    });
  }

  /** 依實際搜索時間的日夜：殭屍等級、遭遇倍率與物資倍率 */
  atPhase(ctx, at) {
    const phase = this.game.time.phase(at);
    const { poi } = ctx;
    return {
      ...ctx,
      phase,
      level: this.game.zombies.buildingLevel(poi, phase),
      zoneMul: phase.zombies ? this.game.zombies.encounterMul(poi.lat, poi.lon) : DAY_ZONE.encounter[zoneAt(poi.lat, poi.lon).id] ?? 1,
      lootMul: phase.lootMul * ctx.lootBase,
    };
  }

  /** 一個檢核點：搜刮一部分物資、可能遭遇事件，並檢查負重（日夜依這一段搜索的實際時間判定） */
  checkpoint(exp, ctx0, k) {
    const cp = exp.cp;
    const at = this.checkpointAt(exp, k);
    const ctx = this.atPhase(ctx0, at);
    const {
      poi, members, pt, zone, danger, level, phase,
    } = ctx;
    cp.done = k;
    const tag = cp.total > 1 ? `［搜索 ${k}/${cp.total}］` : '';
    const last = k === cp.total;
    // 1. 搜刮：今日物資平均分到每個檢核點（殘留物資一次全部找到）
    const found = [];
    Object.keys(cp.remaining).forEach((key) => {
      const left = cp.remaining[key];
      const share = cp.stock.partial || last ? left : Math.min(left, (cp.stock.resources[key] / cp.total) * randFloat(0.8, 1.25));
      if (share < 1) return;
      cp.remaining[key] = left - share;
      const mul = ctx.lootMul * (key === 'food' ? 1 + ctx.forage : 1);
      // 記下加成倍率：帶不走的部分換回原始數量留在建築裡，下次再來才不會重複加成
      cp.mul = cp.mul || {};
      cp.mul[key] = mul;
      cp.gained[key] = (cp.gained[key] || 0) + share * mul;
      found.push(nameOf(key));
    });
    // 探索取得自動補給設定的彈藥或藥品：直接補進隊員的彈藥欄／藥品欄
    ctx.members.forEach((m) => {
      const rules = this.game.survivors.supplyRules(m);
      ['ammo', 'med'].forEach((kind) => {
        const key = rules[kind];
        if (!key || !(cp.gained[key] >= 1)) return;
        const lo = this.game.survivors.loadout(m);
        if (lo[kind] && lo[kind].key !== key) return;
        const n = Math.min(Math.floor(cp.gained[key]), this.game.survivors.slotMax(m, kind) - (lo[kind]?.qty || 0));
        if (n <= 0) return;
        cp.gained[key] -= n;
        lo[kind] = { key, qty: (lo[kind]?.qty || 0) + n };
      });
    });
    const share = (1 + 0.25 * (cp.total - 1)) / cp.total; // 大建築總機率略高
    const extra = [];
    if (cp.stock.gear && chance(pt.itemChance * ctx.itemBoost * cp.stock.itemMul * share)) {
      const item = this.game.equipment.generate({ level, bias: pt.itemBias, boost: danger * 0.05 + zone.rarityBoost });
      cp.items.push(item);
      extra.push(`🎁 ${RARITIES[item.rarity].name}「${item.name}」`);
    }
    if (cp.stock.vehicle) {
      const find = this.game.vehicles.rollFind(poi.type);
      if (chance(find.chance * share) && !this.game.vehicles.isFull() && !cp.vehicles.length) {
        cp.vehicles.push(find.vehicle);
        extra.push(`🚗 ${this.game.vehicles.def(find.vehicle).name}（耐久 ${find.vehicle.durability}）`);
      }
    }
    if (!cp.stock.empty && !cp.stock.partial && chance(pt.blueprintChance * (1 + this.game.research.bonus('blueprintPct')) * share)) {
      cp.blueprints.push(this.game.equipment.makeBlueprint(level));
      extra.push('📜 設計圖');
    }
    // 搜完一棟（最後一個檢核點）：有機會找到「就是要鎖你」（直接放進持有數，不佔背包）
    if (last && !cp.stock.empty) {
      const locks = this.game.rebirth?.rollSearch(zone?.id) || 0;
      if (locks) {
        this.game.rebirth.addLocks(locks);
        cp.locks = (cp.locks || 0) + locks;
        extra.push(`🔒 就是要鎖你 ×${locks}`);
      }
    }
    // 有找到東西才顯示
    if (found.length || extra.length) cp.events.push(`🔍 ${tag}找到 ${[...found, ...extra].join('、')}`);
    if (k === 1 && cp.stock.empty) cp.events.push(`🕸️ 這裡已經被搜刮一空（${cp.emptyBy || '這個時段已經有人搜過'}；每天 06:00、18:00 刷新）`);

    // 2. 隨機事件
    const ev = weightedPick({
      none: 46, zombies: 28 * phase.zombieMul * ctx.zoneMul, survivor: 5 * (1 + this.game.research.bonus('survivorFindPct')), special: 10, elite: ctx.zone.danger < 0 ? 0 : (3 + danger * phase.danger) * ctx.zoneMul, // 安全區沒有精英怪
    });
    if (ev === 'survivor') {
      // 等級依自己隊伍的平均等級（和招募相同），越危險的區域略高，但不超過這棟建築的殭屍等級
      const lvBonus = Math.max(0, Math.min(3, ctx.zone.danger || 0));
      const cand = this.game.survivors.makeCandidate(Math.min(Math.max(1, level - 1), this.game.survivors.candidateLevel() + lvBonus));
      const pool = this.game.state.recruitPool;
      const rname = RARITIES[cand.rarity]?.name || '';
      if (!this.game.survivors.keeps(cand)) {
        // 品級低於設定：自動婉拒，不進入等待名單
        cp.events.push(`🙋 ${tag}遇到倖存者 ${cand.name}（${rname}），不符合停留品級，已婉拒`);
      } else {
        cand.leaveAt = Math.max(Date.now(), at) + RECRUIT_STAY_MS;
        if (pool.length < 5) pool.push(cand);
        cp.events.push(`🙋 ${tag}遇到倖存者 ${cand.name}（${rname}），對方願意加入（會在避難所附近等 1 小時，請到倖存者頁面確認）`);
      }
    } else if (ev === 'special') {
      const sp = pick(SPECIAL_EVENTS);
      cp.events.push(`✨ ${tag}${sp.text}`);
      Object.entries(sp.reward()).forEach(([key, v]) => { if (v) cp.gained[key] = (cp.gained[key] || 0) + v; });
      if (sp.injure) {
        const victim = pick(members);
        this.game.survivors.damage(victim, this.game.survivors.maxHp(victim) * 0.3, '踩中陷阱', at);
      }
    } else if (ev === 'zombies' || ev === 'elite') {
      const isElite = ev === 'elite';
      let enemies;
      if (isElite) {
        enemies = [this.game.combat.createEnemy(weightedPick(pt.enemies), level + 2, true, this.encounterMul(ctx))];
        cp.events.push(`⚠️ ${tag}遭遇精英怪 ${enemies[0].name}！`);
      } else {
        const n = randInt(2, 2 + danger);
        enemies = Array.from({ length: n }, () => this.game.combat.createEnemy(weightedPick(pt.enemies), level, false, this.encounterMul(ctx)));
        cp.events.push(`🧟 ${tag}遭遇 ${n} 隻殭屍`);
      }
      const fs = this.game.shelter.primary().facilities.watchtower.level * 0.04;
      const result = this.game.combat.simulate(members, enemies, { firstStrikeBonus: fs, recoverTo: cp.gained, ref: exp, title: `🔍 ${ctx.poi.name}：${enemies[0]?.name || '殭屍'}${enemies.length > 1 ? ` ×${enemies.length}` : ''}` });
      this.game.combat.applyOutcome(members, result, at);
      if (result.refills) cp.events.push(`💊 ${result.refills.join('；')}`);
      cp.kills += result.kills.length;
      cp.xp += result.xp;
      if (result.victory) {
        cp.events.push(`  ↳ 勝利！擊殺 ${result.kills.length}，獲得 ${Math.round(result.coins * COIN_GAIN_MUL)} 金錢${result.xpEach ? `、每人經驗 +${result.xpEach}` : ''}`);
        const rec = Object.entries(result.recovered || {}).map(([k, v]) => `${SUPPLIES[k].icon} ${k === 'arrow' ? '回收箭矢' : `回收${SUPPLIES[k].name}`} +${v}`);
        if (rec.length) cp.events.push(`  ↳ ${rec.join('、')}`);
        if (isElite) {
          const item = this.game.equipment.generate({ level: level + 2, bias: pt.itemBias, boost: 0.5 + zone.rarityBoost, minRarity: 'uncommon' });
          cp.items.push(item);
          cp.events.push(`  ↳ 精英掉落 ${RARITIES[item.rarity].name}「${item.name}」`);
        }
      } else {
        cp.failed = true;
        cp.events.push('  ↳ 戰鬥失敗，隊伍帶著部分物資撤退！');
        Object.keys(cp.gained).forEach((key) => { cp.gained[key] *= 0.5; });
        this.stopSearch(exp, at);
        return;
      }
    }

    // 3. 負重：超過運載量就停止探索、直接回家（帶不走的留在建築裡）
    const weight = Object.entries(cp.gained).filter(([key]) => isLootKey(key)).reduce((sum, [key, v]) => sum + v * unitWeight(key), 0);
    if (weight > ctx.carry) {
      const ratio = ctx.carry / weight;
      Object.keys(cp.gained).filter(isLootKey).forEach((key) => {
        const keep = cp.gained[key] * ratio;
        cp.overflow[key] = (cp.overflow[key] || 0) + (cp.gained[key] - keep);
        cp.gained[key] = keep;
      });
      cp.overweight = true;
      if (!last) {
        cp.events.push(`🎒 ${tag}背包裝滿了（運載量 ${ctx.carry}），停止探索直接回家${exp.auto ? '（卸貨後自動回來繼續搜索）' : ''}`);
        this.stopSearch(exp, at, { keepAuto: true });
        return;
      }
      cp.events.push(`🎒 帶不動了！運載量 ${ctx.carry}，留下約 ${Math.round(weight - ctx.carry)} 重量的物資在建築裡（今天內可以再來拿，載具可以載更多）`);
    }
  }

  /** 提早結束搜索：從檢核點直接回家 */
  stopSearch(exp, at, { keepAuto = false } = {}) {
    const cp = exp.cp;
    cp.stopped = true;
    const searched = Math.max(0, at - exp.startAt - (exp.travelMs || 0));
    exp.searchMs = searched;
    exp.endAt = exp.startAt + (exp.travelMs || 0) + searched + (exp.backMs ?? (exp.travelMs || 0));
    // 戰敗撤退：停止自動探索；只是背包裝滿：回家卸貨後繼續（同一地點還有物資就再來）
    if (!keepAuto) exp.auto = false;
  }

  /** 探索結束（完成、提早回家或中途召回）：把檢核點取得的物資帶回家 */
  finishExplore(exp, { recalled = false, carry = false } = {}) {
    const poi = this.poi(exp.poiId);
    const members = exp.memberIds.map((id) => this.game.survivors.get(id)).filter(Boolean);
    const cp = exp.cp;
    const report = {
      id: uid('rp'), poiName: poi?.name || '未知地點', poiType: poi?.type, at: exp.endAt,
      events: [...(exp.travelEvents || []), ...(cp?.events || [])], resources: {}, items: [], blueprints: [],
      kills: (exp.travelKills || 0) + (cp?.kills || 0), xp: (exp.travelXp || 0) + (cp?.xp || 0),
      success: !!cp && !cp.failed && !recalled, members: members.map((m) => m.name),
    };
    if (cp?.stock?.empty) report.emptied = cp.emptyBy || '這個時段已經有人搜過';
    if (!poi || !members.length) {
      report.success = false;
      report.events.push('目標地點已消失。');
      return report;
    }
    if (cp?.bumped) {
      // 被搶先或已搜空：沒有搜索。回家時把前幾站背著的物資帶回
      report.success = false;
      if (!carry) {
        const note = this.bringCarried(exp, 1, members);
        if (note) report.events.push(note);
      }
      return report;
    }
    if (!cp || cp.done === 0) {
      report.success = false;
      report.events.push(recalled ? '🏠 隊伍回到避難所，還沒開始搜索，這趟沒有收穫。' : '🏠 隊伍回到避難所，這趟沒有收穫。');
      return report;
    }
    const complete = cp.done >= cp.total && !cp.stopped && !recalled;
    if (recalled) report.events.push(`↩️ 中途撤回（搜索 ${cp.done}/${cp.total}），帶回已經找到的物資`);
    // 最後再檢查一次運載量（例如戰敗撤退時沒有經過負重判斷）；連續探索時扣掉前幾站已經背著的物資
    const carryCap = Math.max(0, (exp.cargo || this.game.vehicles.personCarry() * members.length) - carriedWeight(exp.carried));
    const weightNow = Object.entries(cp.gained).filter(([k]) => isLootKey(k)).reduce((sum, [k, v]) => sum + v * unitWeight(k), 0);
    if (weightNow > carryCap) {
      const ratio = carryCap / Math.max(1e-9, weightNow);
      Object.keys(cp.gained).filter(isLootKey).forEach((k) => {
        const keep = cp.gained[k] * ratio;
        cp.overflow[k] = (cp.overflow[k] || 0) + (cp.gained[k] - keep);
        cp.gained[k] = keep;
      });
    }
    const gained = {};
    // 取整數時無條件捨去，避免四捨五入後超過運載量
    Object.entries(cp.gained).forEach(([k, v]) => { const n = Math.floor(v + 1e-9); if (n > 0) gained[k] = n; });
    if (carry) {
      // 連續探索：物資先背著，前往下一個地點（回到避難所才入庫）
      const c = exp.carried || { gained: {}, items: [], blueprints: [], vehicles: [] };
      Object.entries(gained).forEach(([k, v]) => { c.gained[k] = (c.gained[k] || 0) + v; });
      c.items.push(...cp.items);
      c.blueprints.push(...cp.blueprints);
      c.vehicles.push(...cp.vehicles);
      exp.carried = c;
      report.resources = gained;
      report.items = [...cp.items];
      report.blueprints = [...cp.blueprints];
      report.carried = true;
      if (cp.locks) report.locks = cp.locks;
      this.markVisited(exp, poi, cp, complete);
      if (cp.searchXp) report.events.push(`⭐ 搜完「${poi.name}」：每人經驗 +${cp.searchXp}`);
      return report;
    }
    // 這一站自己的收穫（報告只列這一站，前幾站的收穫已在各自的報告列出）
    const own = { ...gained };
    const ownBlueprints = [...cp.blueprints];
    const ownVehicles = [...cp.vehicles];
    // 前幾站背著的物資一起入庫
    const prev = exp.carried;
    if (prev) {
      Object.entries(prev.gained || {}).forEach(([k, v]) => { gained[k] = (gained[k] || 0) + v; });
      cp.blueprints.unshift(...(prev.blueprints || []));
      cp.vehicles.unshift(...(prev.vehicles || []));
      const list = Object.entries(prev.gained || {}).filter(([, v]) => v > 0).map(([k, v]) => `${lootLabel(k)}×${v}`).join('、');
      report.events.push(`🏠 回到避難所，前幾站背回的物資一起入庫：${list || '（沒有物資）'}`);
    }
    // 入帳：先放進倉庫，放不下的由隊員裝進自己的背包
    const stored = this.game.grant(gained);
    const leftovers = Object.fromEntries(Object.entries(gained)
      .filter(([k]) => isLootKey(k)).map(([k, v]) => [k, Math.floor(v - (stored[k] || 0) + 1e-9)]).filter(([, v]) => v > 0));
    if (Object.keys(leftovers).length) {
      const lost = this.game.survivors.stash(members, leftovers);
      const kept = Object.values(leftovers).reduce((sum, v) => sum + v, 0) - lost;
      report.events.push(`📦 倉庫已滿：${kept} 個物資由隊員放進背包${lost ? `，${lost} 個帶不走被留下` : ''}`);
    }
    report.resources = prev ? own : { ...stored, ...Object.fromEntries(Object.entries(leftovers).map(([k, v]) => [k, (stored[k] || 0) + v])) };
    // 前幾站背著的裝備：前幾站的報告已經列過，這裡只在事件中說明入庫結果（不重複列在收穫裡）
    const prevItems = prev?.items || [];
    if (prevItems.length) {
      const kept = prevItems.filter((it) => this.game.equipment.addItem(it, '探索', members));
      const lostItems = prevItems.filter((it) => !kept.includes(it));
      report.events.push(`🎒 前幾站背回的裝備入庫：${kept.map((it) => `「${it.name}」`).join('、') || '（沒有）'}${lostItems.length ? `；空間不足帶不回來：${lostItems.map((it) => `「${it.name}」`).join('、')}` : ''}`);
    }
    report.items = cp.items.filter((it) => {
      const ok = this.game.equipment.addItem(it, '探索', members);
      if (!ok) report.events.push(`📦 空間不足，「${it.name}」帶不回來`);
      return ok;
    });
    cp.vehicles.forEach((v) => this.game.vehicles.add(v, '探索'));
    report.vehicles = ownVehicles;
    report.blueprints = ownBlueprints;
    if (cp.locks) report.locks = cp.locks;
    this.game.state.inventory.blueprints.push(...cp.blueprints);
    this.markVisited(exp, poi, cp, complete);
    if (cp.searchXp) report.events.push(`⭐ 搜完「${poi.name}」：每人經驗 +${cp.searchXp}`);
    return report;
  }

  /**
   * 連續探索途中撤退或被擊敗：先前地點取得、還背在身上的物資帶回避難所（keep 為保留比例）。
   * @returns {string} 報告事件文字（沒有背著物資時為空字串）
   */
  bringCarried(exp, keep = 1, members = []) {
    const c = exp.carried;
    if (!c) return '';
    exp.carried = null;
    const take = Object.fromEntries(Object.entries(c.gained || {}).map(([k, v]) => [k, Math.floor(v * keep)]).filter(([, v]) => v > 0));
    const got = this.game.grant(take);
    const all = c.items || [];
    const items = keep >= 1 ? all : all.filter(() => Math.random() < keep);
    const kept = items.filter((it) => this.game.equipment.addItem(it, '探索', members));
    const dropped = all.filter((it) => !kept.includes(it));
    const itemNote = all.length ? `；裝備：${kept.map((it) => `「${it.name}」`).join('、') || '（沒有）'}${dropped.length ? `，遺失或放不下：${dropped.map((it) => `「${it.name}」`).join('、')}` : ''}` : '';
    (c.vehicles || []).forEach((v) => this.game.vehicles.add(v, '探索'));
    this.game.state.inventory.blueprints.push(...(c.blueprints || []));
    const list = Object.entries(got).filter(([, v]) => v > 0).map(([k, v]) => `${lootLabel(k)}×${v}`).join('、');
    return keep >= 1
      ? `🎒 先前地點取得的物資帶回避難所：${list || '（沒有物資）'}${itemNote}`
      : `🎒 被擊敗時掉了一部分背著的物資，帶回避難所：${list || '（沒有物資）'}${itemNote}`;
  }

  /** 探索完一個地點：經驗、建築剩餘物資、統計 */
  markVisited(exp, poi, cp, complete) {
    const members = exp.memberIds.map((id) => this.game.survivors.get(id)).filter(Boolean);
    // 經驗主要來自戰鬥；探索本身只給一點點經驗
    // 搜完整棟建築：依建築殭屍等級與大小給經驗（普通殭屍經驗 × 0.5 × 大小倍率；少於一場戰鬥）
    if (cp.done >= cp.total) {
      const sxp = this.searchXp(poi);
      members.forEach((m) => this.game.survivors.gainXp(m, sxp));
      cp.searchXp = Math.round(sxp * (1 + this.game.research.bonus('xpPct')));
    }
    // 建築的剩餘物資：完整探索完只剩帶不走的（會顯示數量）；沒探索完的剩餘物資留在建築裡，但不知道有多少
    // v10 共用：離開地點時記下結果（搜空、或剩下的物資與檢核點），所有玩家看到的相同
    const leaveAt = exp.startAt + (exp.travelMs || 0) + (exp.searchMs || 0);
    const overflow = Object.fromEntries(Object.entries(cp.overflow).map(([k, v]) => [k, Math.floor(v / Math.max(1, cp.mul?.[k] || 1))]).filter(([, v]) => v > 0));
    const offset = cp.offset || 0;
    const allTotal = cp.allTotal || cp.total;
    if (complete) this.game.poiShare?.release(exp, poi, { at: leaveAt, complete: true, rest: overflow, done: allTotal, total: allTotal });
    else {
      const rest = { ...overflow };
      Object.entries(cp.remaining).forEach(([k, v]) => { const n = Math.floor(v); if (n > 0) rest[k] = (rest[k] || 0) + n; });
      // 記下已經搜完幾個檢核點：下一位從剩下的檢核點繼續，只需剩餘的搜索時間
      this.game.poiShare?.release(exp, poi, { at: leaveAt, complete: false, rest, done: Math.min(allTotal, offset + cp.done), total: allTotal });
    }
    delete poi.depletion;
    poi.lastVisit = exp.endAt;
    this.game.state.stats.explorations += 1;
    if (poi.type === 'forest') this.game.state.stats.forestVisits = (this.game.state.stats.forestVisits || 0) + 1;
  }

  /** 結算一次探索（補算檢核點後帶回物資） */
  /**
   * v15.4：大本營的部隊抵達探索點（由 ControlPointSystem.hqAmbushes 排程，移動時間比照攻打玩家避難所）。
   * 敵人：隊伍人數 +1 名、大本營出兵等級的掠奪者。打贏繼續探索並得到經驗；打輸這一站目前找到的資源被搶走一半，倒下的人重傷。
   */
  hqAmbushFight(exp, poi, a) {
    const g = this.game;
    const members = exp.memberIds.map((id) => g.survivors.get(id)).filter(Boolean);
    if (!members.length) return null;
    const f = a.f;
    const cb = g.combat;
    const level = Math.max(FACTION_BASE.hqLevel, g.npcs?.list?.find((n) => n.hq && n.faction === f)?.level || 0);
    const foes = Array.from({ length: members.length + 1 }, (_, i) => {
      const e = cb.createEnemy(i === 0 ? 'raiderChief' : 'raider', level);
      e.name = `${FACTIONS[f].name}${e.name}`;
      return e;
    });
    const result = cb.within(exp, () => cb.simulate(members, foes, { title: `🏯 ${FACTIONS[f].name}大本營的部隊襲擊探索隊`, ref: exp }));
    cb.applyOutcome(members, result, a.hitAt);
    exp.travelKills = (exp.travelKills || 0) + result.kills.length;
    exp.travelXp = (exp.travelXp || 0) + (result.xpEach || 0);
    let msg;
    if (result.victory) {
      msg = `🏯 ${FACTIONS[f].name}大本營的部隊（${foes.length} 人・Lv${level}）襲擊「${poi?.name || ''}」的探索隊，被擊退了！每人經驗 +${result.xpEach || 0}`;
    } else {
      Object.keys(exp.cp?.gained || {}).filter(isLootKey).forEach((k) => { exp.cp.gained[k] *= HQ_AMBUSH.lootLoss; });
      const down = result.team.filter((u) => u.down).length;
      msg = `🏯 ${FACTIONS[f].name}大本營的部隊（${foes.length} 人・Lv${level}）襲擊「${poi?.name || ''}」的探索隊，我方戰敗：目前找到的資源被搶走一半${down ? `，${down} 人重傷` : ''}`;
    }
    exp.travelEvents = [...(exp.travelEvents || []), msg];
    g.log(msg, result.victory ? 'success' : 'danger');
    return result;
  }

  resolve(exp) {
    this.runCheckpoints(exp, this.checkpointAt(exp, exp.cp?.total || this.checkpointCount(this.poi(exp.poiId) || {})));
    return this.finishExplore(exp);
  }

}
