import { RECRUIT_STAY_MS } from '../config/survivors.js';
import {
  MAX_TEAM_SIZE, MAX_EXPEDITIONS, OFFLINE_CAP_MS, RESOURCES,
} from '../config/constants.js';

/** 探索帶回的物資（基本資源與材料物品，受運載量限制） */
const isLootKey = (k) => !!RESOURCES[k] || !!SUPPLIES[k];
const nameOf = (k) => RESOURCES[k]?.name || SUPPLIES[k]?.name || k;
import { POI_TYPES } from '../config/poiTypes.js';
import { RARITIES } from '../config/equipment.js';
import {
  withSeed,
  chance, pick, randInt, uid, weightedPick, haversine, randFloat, lerp,
} from '../utils/math.js';
import { ALL_ENEMIES } from '../config/enemies.js';
import { stockOf, dayKey } from './LootStock.js';
import { zoneAt } from '../config/zones.js';
import { BASE_SIZES, baseSizeOf } from '../config/civilization.js';
import { pathLength, pointAlong } from '../map/routing.js';
import {
  SUPPLIES, AMMO_FOR, AMMO_PACK_FIGHTS, unitWeight,
} from '../config/supplies.js';

/** 每公里單程移動時間（分鐘，未套用速度加成） */
const MIN_PER_KM_ONE_WAY = 1.2;
/** 移動途中，殭屍群在此距離內（公尺）就可能發動襲擊 */
export const AMBUSH_RADIUS_M = 90;
/** 每個接近的殭屍群發動襲擊的基礎機率（偵察兵的尋路技能可降低） */
const AMBUSH_CHANCE = 0.6;

/**
 * 行程進度（純函式）：去程 → 搜索 → 返程。自己的探索隊與其他玩家的隊伍共用。
 * @param {{from?:{lat,lon}, to:{lat,lon}, startAt:number, endAt:number, travelMs?:number, searchMs?:number, distanceM?:number}} trip
 */
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

/**
 * 探索系統：派遣隊伍前往地圖建築，經過一段時間後結算事件。
 * 支援自動探索（研究解鎖）與離線結算。
 */
export class ExplorationSystem {
  constructor(game) {
    this.game = game;
  }

  get list() {
    return this.game.state.expeditions;
  }

  /** 目標地點：地圖建築，或 NPC 據點（攻打時） */
  poi(id) {
    return this.game.state.map.pois.find((p) => p.id === id) || this.game.npcs?.asPoi(id) || this.game.territory?.asPoi(id)
      || this.game.intercept?.asPoi(id) || this.game.trade?.asPoi(id) || this.game.demand?.asPoi(id) || this.huntPoi(id) || null;
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

  plan(poi, members, durationMin, at = Date.now(), vehicles = [], { avoidHostile = false } = {}) {
    const sh = this.game.shelter.primary();
    const from = sh ? { lat: sh.lat, lon: sh.lon } : { lat: poi.lat, lon: poi.lon };
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
    const travelMs = Math.round(((distanceM / 1000) * MIN_PER_KM_ONE_WAY / (speed * trip.speed)) * 60000);
    const searchMs = Math.round((durationMin / (speed * teamMul)) * 60000);
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
    return Math.max(1, Math.round(size.searchMin * (0.6 + 0.4 * Math.min(1, (danger - 1) / 5))));
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
    return tripProgress({ ...exp, to: { lat: poi.lat, lon: poi.lon } }, now);
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
   * 出發。
   * @param {{vehicleIds?:string[], kind?:'explore'|'raid'}} [opts] 載具；raid = 攻打 NPC 據點
   */
  start(poiId, memberIds, durationMin, auto = false, startAt = Date.now(), { vehicleIds = [], kind = 'explore', avoidHostile = false } = {}) {
    const v = this.validate(poiId, memberIds);
    if (!v.ok) return v;
    if (auto && !this.game.research.hasUnlock('autoExplore')) return { ok: false, reason: '需研究「斥候訓練」解鎖自動探索' };
    // 搜索時間由地點決定（攻打 NPC 為固定 5 分鐘）
    durationMin = kind === 'intercept' || kind === 'hunt' || kind === 'deliver' ? 0 : kind === 'raid' || kind === 'pvp' ? 2 : this.searchMinutes(v.poi);
    const draft = this.plan(v.poi, v.members, durationMin, startAt, [], { avoidHostile });
    const car = this.game.vehicles.validate(vehicleIds, v.members, draft.distanceM);
    if (!car.ok) return car;
    const plan = this.plan(v.poi, v.members, durationMin, startAt, car.vehicles, { avoidHostile });
    // 路線會經過的敵對警戒範圍（去程與返程各算一次）
    const ignore = this.targetZone(v.poi);
    const back = [...plan.path].reverse();
    const threats = [
      ...this.game.territory.threats(plan.path, ignore).map((th) => ({ ...th, leg: 'out', done: false })),
      ...this.game.territory.threats(back, ignore).map((th) => ({ ...th, leg: 'back', done: false })),
    ];
    const packed = this.packAmmo(v.members);
    v.members.forEach((m) => { m.status = 'exploring'; });
    this.game.vehicles.depart(car.vehicles, plan.trip.fuel);
    const exp = {
      id: uid('ex'), poiId, kind, memberIds: [...memberIds], durationMin, auto,
      startAt, endAt: startAt + plan.totalMs, phaseAtStart: this.game.time.phaseId(startAt),
      from: plan.from, distanceM: plan.distanceM, travelMs: plan.travelMs, searchMs: plan.searchMs,
      path: plan.path, avoidHostile, threats,
      ...(v.poi.pvp ? { pvpTarget: v.poi } : {}),
      ...(v.poi.intercept ? { icptTarget: v.poi.target } : {}),
      ...(v.poi.hunt ? { huntTarget: v.poi.target } : {}),
      ...(v.poi.trade ? { tradeTarget: v.poi.target } : {}),
      vehicleIds: [...vehicleIds], cargo: plan.trip.cargo, ambushes: 0,
      // 攻擊目標的殭屍群不算途中遭遇
      encountered: v.poi.hunt ? [v.poi.target.groupId] : [], travelEvents: [], travelKills: 0, travelXp: 0,
    };
    this.list.push(exp);
    const ride = car.vehicles.length ? `（${car.vehicles.map((x) => this.game.vehicles.def(x).icon).join('')}${plan.trip.fuel ? `・耗油 ${plan.trip.fuel}` : ''}）` : '';
    return { ok: true, exp, msg: `隊伍出發前往「${v.poi.name}」${ride}${packed}` };
  }

  /** 出發前：使用槍械／弓弩的隊員自動從倉庫補充彈藥（約 4 場戰鬥的量） */
  packAmmo(members) {
    const notes = [];
    members.forEach((m) => {
      const weapon = this.game.equipment.getItem(m.equipment?.weapon);
      const need = weapon && AMMO_FOR[weapon.type];
      if (!need) return;
      const want = need.perFight * AMMO_PACK_FIGHTS - (m.bag?.[need.ammo] || 0);
      if (want > 0 && (this.game.state.supplies?.[need.ammo] || 0) > 0) this.game.survivors.withdraw(m.id, need.ammo, want);
      if ((m.bag?.[need.ammo] || 0) < need.perFight) notes.push(`${m.name}沒有${SUPPLIES[need.ammo].name}`);
    });
    return notes.length ? `（⚠️ ${notes.join('、')}，無法使用武器）` : '';
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
    this.game.demand?.checkDeliveries(now);
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
    const ratio = exp.distanceM ? th.at / exp.distanceM : 0;
    return th.leg === 'out' ? exp.startAt + exp.travelMs * ratio : exp.startAt + exp.travelMs + exp.searchMs + exp.travelMs * ratio;
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
      const result = this.game.combat.simulate(members, this.game.territory.defenders(th));
      this.game.combat.applyOutcome(members, result, now);
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
    const report = {
      id: uid('rp'), poiName: poi?.name || '未知地點', poiType: poi?.type, at: now,
      events: [...exp.travelEvents, '🏳️ 隊伍帶著傷撤回據點，本次探索沒有收穫。', ...wear],
      resources: {}, items: [], blueprints: [], kills: exp.travelKills, xp: exp.travelXp, success: false,
      members: members.map((m) => m.name),
    };
    report.retreated = true;
    this.game.state.reports = [report, ...(this.game.state.reports || [])].slice(0, 20);
    this.game.bus.emit('expedition:done', [report]);
    return report;
  }

  /** 途中遭遇戰：勝利則消滅殭屍群繼續前進，失敗則全隊撤退、探索結束 */
  ambush(exp, g, members, now) {
    const poi = this.poi(exp.poiId);
    const enemies = Array.from({ length: g.count }, () => this.game.combat.createEnemy(g.enemyId, g.level, g.elite));
    const result = this.game.combat.simulate(members, enemies);
    this.game.combat.applyOutcome(members, result, now);
    const label = `${ALL_ENEMIES[g.enemyId].icon} ${this.game.zombies.groupLabel(g)}`;
    exp.travelKills += result.kills.length;
    exp.travelXp += result.xp;
    const where = this.progress(exp, now)?.phase === 'returning' ? '返程途中' : '前往途中';
    if (result.victory) {
      this.game.state.stats.battlesWon += 1;
      this.game.state.map.zombieGroups = this.game.state.map.zombieGroups.filter((x) => x.id !== g.id);
      exp.travelEvents.push(`⚔️ ${where}遭遇${label}，擊退！（擊殺 ${result.kills.length}，💰${result.coins}）`);
      this.game.toast(`⚔️ 前往「${poi?.name}」的隊伍${where}遭遇殭屍，成功擊退`, 'success');
      this.game.log(`⚔️ 探索隊${where}擊退${this.game.zombies.groupLabel(g)}`, 'success');
      this.game.bus.emit('map:changed');
      return { exp, group: g, result, aborted: false };
    }
    this.game.state.stats.battlesLost += 1;
    g.count = Math.max(1, g.count - result.kills.length);
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
    this.game.state.reports = [report, ...(this.game.state.reports || [])].slice(0, 20);
    this.game.bus.emit('expedition:done', [report]);
    return { exp, group: g, result, aborted: true };
  }

  /** 是否還能召回：已經在返程（或被擊敗撤回中）的隊伍不需要召回 */
  canRecall(exp, now = Date.now()) {
    if (!exp || exp.defeated || exp.recalled) return false;
    return this.progress(exp, now)?.phase !== 'returning';
  }

  /**
   * 隊伍立刻折返：從目前位置走回避難所（需要移動時間），途中的搜索、交戰都取消。
   * 召回與被攔截擊敗共用。
   */
  turnBack(exp, now = Date.now()) {
    const p = this.progress(exp, now);
    const home = this.game.shelter.primary() || exp.from;
    if (!p || !home) return false;
    const dist = haversine(p.pos.lat, p.pos.lon, home.lat, home.lon);
    const travelMs = exp.distanceM ? Math.round(exp.travelMs * (dist / exp.distanceM)) : 0;
    Object.assign(exp, {
      from: { lat: home.lat, lon: home.lon }, path: [{ lat: home.lat, lon: home.lon }, p.pos],
      distanceM: Math.round(dist), travelMs, searchMs: 0, startAt: now - travelMs, endAt: now + travelMs,
      threats: [], auto: false,
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
    if (!this.game.research.hasUnlock('autoExplore')) return { ok: false, reason: '需研究「斥候訓練」' };
    exp.auto = !exp.auto;
    return { ok: true, msg: exp.auto ? '已開啟自動探索' : '已關閉自動探索' };
  }

  free(exp) {
    exp.memberIds.forEach((id) => {
      const m = this.game.survivors.get(id);
      if (m && m.status === 'exploring') m.status = 'idle';
    });
    this.game.vehicles.release(exp.vehicleIds || []);
  }

  /**
   * 結算到期的探索；離線時可能一次結算多輪自動探索。
   * @returns {object[]} 報告列表
   */
  /** 結算探索（使用存檔種子） */
  update(now, { silent = false } = {}) {
    return withSeed(this.game.state.rng, 'explore', () => this.updateNow(now, { silent }));
  }

  updateNow(now, { silent = false } = {}) {
    const reports = [];
    this.game.demand?.checkDeliveries(now);
    let guard = 0;
    let due = this.list.filter((e) => e.endAt <= now);
    while (due.length && guard < 400) {
      guard += 1;
      due.forEach((exp) => {
        // 離線或背景時沒有即時判定的警戒範圍遭遇，結算前補算
        const retreated = this.checkThreats(exp, exp.endAt);
        if (retreated) {
          reports.push(retreated);
          return;
        }
        this.game.state.expeditions = this.list.filter((e) => e.id !== exp.id);
        const report = exp.kind === 'trade' && !exp.defeated ? this.game.trade.report(exp)
          : exp.kind === 'deliver' && !exp.defeated ? this.game.demand.report(exp)
          : exp.recalled ? (exp.kind === 'explore' ? this.finishExplore(exp, { recalled: true }) : this.recalledReport(exp))
          : exp.defeated ? this.game.intercept.defeatedReport(exp)
          : exp.kind === 'hunt' ? this.huntReport(exp)
          : exp.kind === 'intercept' ? this.game.intercept.report(exp)
            : exp.kind === 'raid' ? this.game.npcs.resolveRaid(exp)
              : exp.kind === 'pvp' ? this.game.territory.resolvePvp(exp) : this.resolve(exp);
        report.events.push(...this.game.vehicles.returnHome(exp.vehicleIds || [], exp.distanceM || 0, exp.ambushes || 0));
        reports.push(report);
        this.free(exp);
        // 自動探索：隊員健康且未超過離線上限則再次出發（燃料不足或載具損壞則停止）
        const healthy = exp.memberIds.every((id) => {
          const m = this.game.survivors.get(id);
          return m && !m.severe;
        });
        if (exp.kind === 'explore' && !exp.defeated && !exp.recalled && exp.auto && healthy && now - exp.endAt < OFFLINE_CAP_MS && this.game.research.hasUnlock('autoExplore')) {
          const r = this.start(exp.poiId, exp.memberIds, exp.durationMin, true, exp.endAt, { vehicleIds: exp.vehicleIds || [], avoidHostile: exp.avoidHostile });
          if (!r.ok) report.events.push(`⏹️ 自動探索停止：${r.reason}`);
        }
      });
      due = this.list.filter((e) => e.endAt <= now);
    }
    if (reports.length) {
      const st = this.game.state;
      // 撤退的報告已經記錄過，不重複加入
      st.reports = [...reports.filter((r) => !r.retreated).reverse(), ...(st.reports || [])].slice(0, 20);
      if (!silent) {
        reports.forEach((r) => this.game.toast(`${r.success ? '✅' : '⚠️'} ${r.poiName} 探索${r.success ? '完成' : '受挫'}`, r.success ? 'success' : 'danger'));
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
    const r = this.game.zombies.attack(t.groupId, exp.memberIds, { arrived: true, at });
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
        ? `⚔️ 擊退${t.label}！（擊殺 ${result.kills.length}，💰${result.coins}）`
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

  /** 記錄建築內殘留的物資（地圖會顯示剩餘數量）；沒有殘留則清除 */
  setRemain(poi, res, at = Date.now(), { hidden = false } = {}) {
    const map = this.game.state.map;
    map.remain = map.remain || {};
    const left = Object.fromEntries(Object.entries(res || {}).filter(([, v]) => v > 0));
    if (Object.keys(left).length) map.remain[poi.id] = { day: dayKey(at), res: left, ...(hidden ? { hidden: true } : {}) };
    else delete map.remain[poi.id];
    // 過期的殘留紀錄一併清掉
    const today = dayKey(at);
    Object.keys(map.remain).forEach((id) => { if (map.remain[id].day !== today) delete map.remain[id]; });
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
      level: this.game.zombies.nightLevel(poi, phase),
      zoneMul: phase.zombies ? this.game.zombies.encounterMul(poi.lat, poi.lon) : 1,
      phase,
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
      if (!exp.cp) {
        const stock = stockOf(ctx.poi, ctx.arriveAt, this.game.state.map.remain);
        exp.cp = {
          total: this.checkpointCount(ctx.poi), done: 0, searchMs: exp.searchMs || 0,
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

  /** 一個檢核點：搜刮一部分物資、可能遭遇事件，並檢查負重 */
  checkpoint(exp, ctx, k) {
    const cp = exp.cp;
    const {
      poi, members, pt, zone, danger, level, phase,
    } = ctx;
    const at = this.checkpointAt(exp, k);
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
      let v = share * ctx.lootMul;
      if (key === 'food') v *= 1 + ctx.forage;
      cp.gained[key] = (cp.gained[key] || 0) + v;
      found.push(nameOf(key));
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
    // 有找到東西才顯示
    if (found.length || extra.length) cp.events.push(`🔍 ${tag}找到 ${[...found, ...extra].join('、')}`);
    if (k === 1 && cp.stock.empty) cp.events.push('🕸️ 這裡已經被搜刮一空（每天 06:00、18:00 刷新）');

    // 2. 隨機事件
    const ev = weightedPick({
      none: 46, zombies: 28 * phase.zombieMul * ctx.zoneMul, survivor: 5 * (1 + this.game.research.bonus('survivorFindPct')), special: 10, elite: ctx.zone.danger < 0 ? 0 : (3 + danger * phase.danger) * ctx.zoneMul, // 安全區沒有精英怪
    });
    if (ev === 'survivor') {
      const cand = this.game.survivors.makeCandidate(randInt(1, Math.max(1, level - 1)));
      const pool = this.game.state.recruitPool;
      cand.leaveAt = Math.max(Date.now(), at) + RECRUIT_STAY_MS;
      if (pool.length < 5) pool.push(cand);
      cp.events.push(`🙋 ${tag}遇到倖存者 ${cand.name}，對方願意加入（會在避難所附近等 1 小時，請到倖存者頁面確認）`);
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
        enemies = [this.game.combat.createEnemy(weightedPick(pt.enemies), level + 2, true)];
        cp.events.push(`⚠️ ${tag}遭遇精英怪 ${enemies[0].name}！`);
      } else {
        const n = randInt(2, 2 + danger);
        enemies = Array.from({ length: n }, () => this.game.combat.createEnemy(weightedPick(pt.enemies), level));
        cp.events.push(`🧟 ${tag}遭遇 ${n} 隻殭屍`);
      }
      const fs = this.game.shelter.primary().facilities.watchtower.level * 0.04;
      const result = this.game.combat.simulate(members, enemies, { firstStrikeBonus: fs });
      this.game.combat.applyOutcome(members, result, at);
      cp.kills += result.kills.length;
      cp.xp += result.xp;
      if (result.victory) {
        cp.events.push(`  ↳ 勝利！擊殺 ${result.kills.length}，獲得 ${result.coins} 金錢`);
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
        cp.events.push(`🎒 ${tag}背包裝滿了（運載量 ${ctx.carry}），停止探索直接回家`);
        this.stopSearch(exp, at);
        return;
      }
      cp.events.push(`🎒 帶不動了！運載量 ${ctx.carry}，留下約 ${Math.round(weight - ctx.carry)} 重量的物資在建築裡（今天內可以再來拿，載具可以載更多）`);
    }
  }

  /** 提早結束搜索：從檢核點直接回家 */
  stopSearch(exp, at) {
    const cp = exp.cp;
    cp.stopped = true;
    const searched = Math.max(0, at - exp.startAt - (exp.travelMs || 0));
    exp.searchMs = searched;
    exp.endAt = exp.startAt + (exp.travelMs || 0) * 2 + searched;
    exp.auto = false;
  }

  /** 探索結束（完成、提早回家或中途召回）：把檢核點取得的物資帶回家 */
  finishExplore(exp, { recalled = false } = {}) {
    const poi = this.poi(exp.poiId);
    const members = exp.memberIds.map((id) => this.game.survivors.get(id)).filter(Boolean);
    const cp = exp.cp;
    const report = {
      id: uid('rp'), poiName: poi?.name || '未知地點', poiType: poi?.type, at: exp.endAt,
      events: [...(exp.travelEvents || []), ...(cp?.events || [])], resources: {}, items: [], blueprints: [],
      kills: (exp.travelKills || 0) + (cp?.kills || 0), xp: (exp.travelXp || 0) + (cp?.xp || 0),
      success: !!cp && !cp.failed && !recalled, members: members.map((m) => m.name),
    };
    if (!poi || !members.length) {
      report.success = false;
      report.events.push('目標地點已消失。');
      return report;
    }
    if (!cp || cp.done === 0) {
      report.success = false;
      report.events.push(recalled ? '🏠 隊伍回到避難所，還沒開始搜索，這趟沒有收穫。' : '🏠 隊伍回到避難所，這趟沒有收穫。');
      return report;
    }
    const complete = cp.done >= cp.total && !cp.stopped && !recalled;
    if (recalled) report.events.push(`↩️ 中途撤回（搜索 ${cp.done}/${cp.total}），帶回已經找到的物資`);
    // 最後再檢查一次運載量（例如戰敗撤退時沒有經過負重判斷）
    const carry = exp.cargo || this.game.vehicles.personCarry() * members.length;
    const weightNow = Object.entries(cp.gained).filter(([k]) => isLootKey(k)).reduce((sum, [k, v]) => sum + v * unitWeight(k), 0);
    if (weightNow > carry) {
      const ratio = carry / weightNow;
      Object.keys(cp.gained).filter(isLootKey).forEach((k) => {
        const keep = cp.gained[k] * ratio;
        cp.overflow[k] = (cp.overflow[k] || 0) + (cp.gained[k] - keep);
        cp.gained[k] = keep;
      });
    }
    const gained = {};
    // 取整數時無條件捨去，避免四捨五入後超過運載量
    Object.entries(cp.gained).forEach(([k, v]) => { const n = Math.floor(v + 1e-9); if (n > 0) gained[k] = n; });
    // 入帳：先放進倉庫，放不下的由隊員裝進自己的背包
    report.resources = this.game.grant(gained);
    const leftovers = Object.fromEntries(Object.entries(gained)
      .filter(([k]) => isLootKey(k)).map(([k, v]) => [k, v - (report.resources[k] || 0)]).filter(([, v]) => v > 0));
    if (Object.keys(leftovers).length) {
      const lost = this.game.survivors.stash(members, leftovers);
      const kept = Object.values(leftovers).reduce((sum, v) => sum + v, 0) - lost;
      Object.entries(leftovers).forEach(([k, v]) => { report.resources[k] = (report.resources[k] || 0) + v; });
      report.events.push(`📦 倉庫已滿：${kept} 個物資由隊員放進背包${lost ? `，${lost} 個帶不走被留下` : ''}`);
    }
    report.items = cp.items.filter((it) => {
      const ok = this.game.equipment.addItem(it, '探索', members);
      if (!ok) report.events.push(`📦 空間不足，「${it.name}」帶不回來`);
      return ok;
    });
    cp.vehicles.forEach((v) => this.game.vehicles.add(v, '探索'));
    report.vehicles = cp.vehicles;
    report.blueprints = cp.blueprints;
    this.game.state.inventory.blueprints.push(...cp.blueprints);
    members.forEach((m) => this.game.survivors.gainXp(m, Math.round((4 + exp.durationMin) * (cp.done / cp.total))));
    // 建築的剩餘物資：完整探索完只剩帶不走的（會顯示數量）；沒探索完的剩餘物資留在建築裡，但不知道有多少
    const arriveAt = exp.startAt + (exp.travelMs || 0);
    poi.lootedDay = dayKey(arriveAt);
    const overflow = Object.fromEntries(Object.entries(cp.overflow).map(([k, v]) => [k, Math.floor(v)]).filter(([, v]) => v > 0));
    if (complete) this.setRemain(poi, overflow, arriveAt);
    else {
      const rest = { ...overflow };
      Object.entries(cp.remaining).forEach(([k, v]) => { const n = Math.floor(v); if (n > 0) rest[k] = (rest[k] || 0) + n; });
      this.setRemain(poi, rest, arriveAt, { hidden: true });
    }
    delete poi.depletion;
    poi.lastVisit = exp.endAt;
    this.game.state.stats.explorations += 1;
    if (poi.type === 'forest') this.game.state.stats.forestVisits = (this.game.state.stats.forestVisits || 0) + 1;
    return report;
  }

  /** 結算一次探索（補算檢核點後帶回物資） */
  resolve(exp) {
    this.runCheckpoints(exp, this.checkpointAt(exp, exp.cp?.total || this.checkpointCount(this.poi(exp.poiId) || {})));
    return this.finishExplore(exp);
  }

}
