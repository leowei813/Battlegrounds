import { AssistSystem } from './AssistSystem.js';
import { NPC_CONFIG, NPC_NAMES, npcAggression } from '../config/npcs.js';
import { RESOURCE_KEYS, RAID_TRAVEL } from '../config/constants.js';
import { ShelterSystem } from './ShelterSystem.js';
import { unitWeight } from '../config/supplies.js';
import { POI_TYPES } from '../config/poiTypes.js';
import { zoneAt } from '../config/zones.js';
import { stockOf, dayKey } from './LootStock.js';
import { tripProgress } from './ExplorationSystem.js';
import { planRoute, pathLength, crossings } from '../map/routing.js';
import {
  withSeed,
  uid, pick, randFloat, randInt, haversine, chance,
} from '../utils/math.js';

const rand = ([a, b]) => randFloat(a, b);

/**
 * NPC 據點：自己升級、外出探索（會搶先搜刮建築），並依玩家文明度積極掠奪玩家據點。
 * 玩家可以派隊攻打 NPC 據點搶奪資源；據點被摧毀後會在別處重新出現。
 * 夜晚屍潮期間 NPC 不會出動掠奪。
 */
export class NpcSystem {
  constructor(game) {
    this.game = game;
  }

  get state() {
    return this.game.state.npcs;
  }

  get list() {
    return this.state.list;
  }

  get(id) {
    return this.list.find((n) => n.id === id) || null;
  }

  /** 讓探索系統把 NPC 據點當成目的地 */
  asPoi(id) {
    const n = this.get(id);
    return n && {
      id: n.id, name: n.name, lat: n.lat, lon: n.lon, type: 'military', icon: '🏴‍☠️', npc: true,
    };
  }

  /** 滿編時的掠奪者人數（不含首領） */
  fullCount(n) {
    return Math.min(6, 2 + Math.floor(n.level / 5));
  }

  /** 據點守備：掠奪者人數（扣除傷亡）與等級 */
  garrison(n) {
    const count = Math.max(0, this.fullCount(n) - (n.wounded || 0));
    const enemies = Array.from({ length: count }, () => this.game.combat.createEnemy('raider', n.level));
    enemies.push(this.game.combat.createEnemy('raiderChief', n.level));
    return enemies;
  }

  power(n) {
    return this.garrison(n).reduce((s, e) => s + e.maxHp * 0.1 + e.atk, 0);
  }

  aggression() {
    return npcAggression(this.game.civilization.value());
  }

  // ---------- 生成 ----------

  origin() {
    return this.game.shelter.primary() || this.game.state.map.center;
  }

  /** 建築所在的 1 公里格子 */
  cellOf(lat, lon) {
    const dLat = NPC_CONFIG.cellKm / 111.32;
    const dLon = dLat / Math.cos((this.origin().lat * Math.PI) / 180);
    return `${Math.floor(lat / dLat)}:${Math.floor(lon / dLon)}`;
  }

  /**
   * 每個有建築的 1 公里格子維持 3 個 NPC 據點（被摧毀的格子要等重生時間）。
   * @returns {number} 本次新增的數量
   */
  fillCells(now = Date.now(), { silent = false } = {}) {
    const st = this.state;
    st.cellNext = st.cellNext || {};
    const o = this.origin();
    const used = new Set(this.list.map((n) => n.poiId));
    // 不會生成在任何警戒範圍內：自己的據點、其他玩家的據點、其他 NPC 據點
    const zones = this.alertZones();
    const inAlert = (p) => zones.some((z) => haversine(z.lat, z.lon, p.lat, p.lon) <= z.r);
    const cells = new Map();
    this.game.state.map.pois.forEach((p) => {
      if (used.has(p.id) || this.game.shelter.baseAtPoi(p.id) || POI_TYPES[p.type].danger < 2) return;
      if (haversine(o.lat, o.lon, p.lat, p.lon) < NPC_CONFIG.minFromShelterM) return;
      if (inAlert(p)) return;
      const key = this.cellOf(p.lat, p.lon);
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key).push(p);
    });
    let added = 0;
    cells.forEach((pois, key) => {
      if ((st.cellNext[key] || 0) > now) return;
      let need = NPC_CONFIG.perCell - this.list.filter((n) => n.cell === key).length;
      const pool = [...pois];
      while (need > 0 && pool.length) {
        const poi = pool.splice(Math.floor(randFloat(0, pool.length)), 1)[0];
        if (inAlert(poi)) continue; // 同一輪剛生成的 NPC 範圍也要避開
        const n = this.spawnAt(poi, key, now, silent);
        zones.push({ lat: n.lat, lon: n.lon, r: 60 + n.level });
        need -= 1;
        added += 1;
      }
    });
    if (added) this.game.bus.emit('npcs:changed');
    return added;
  }

  /** 所有警戒範圍（公尺）：自己的據點、其他玩家的據點、NPC 據點 */
  alertZones() {
    const g = this.game;
    return [
      ...g.state.bases.map((b) => ({ lat: b.lat, lon: b.lon, r: g.territory.alertRadius(b) })),
      ...(g.world?.others || []).flatMap((p) => p.bases.map((b) => ({ lat: b.lat, lon: b.lon, r: b.alert || 80 }))),
      ...this.list.map((n) => ({ lat: n.lat, lon: n.lon, r: 60 + n.level })),
    ];
  }

  spawnAt(poi, cell, now = Date.now(), silent = false) {
    const leader = this.game.survivors.leader();
    const zone = zoneAt(poi.lat, poi.lon);
    const level = Math.max(1, (leader?.level || 1) - 2 + randInt(0, 3) + Math.max(0, zone.danger));
    const n = {
      id: uid('npc'),
      name: pick(NPC_NAMES.filter((x) => !this.list.some((m) => m.name === x))) || pick(NPC_NAMES),
      poiId: poi.id,
      cell,
      lat: poi.lat,
      lon: poi.lon,
      level,
      resources: {
        food: randInt(60, 160), wood: randInt(60, 200), fuel: randInt(10, 60), scrap: randInt(10, 40), nail: randInt(10, 40), bandage: randInt(0, 4),
      },
      coins: randInt(40, 120) * level,
      nextLevelAt: now + rand(NPC_CONFIG.levelUpMs),
      nextExploreAt: now + rand(NPC_CONFIG.exploreEveryMs) * randFloat(0.3, 1),
      nextRaidAt: now + this.raidDelay(),
      trip: null,
    };
    this.list.push(n);
    if (!silent) this.game.log(`🏴‍☠️ NPC 勢力「${n.name}」在「${poi.name}」建立據點（Lv${n.level}）`, 'danger');
    return n;
  }

  /** 下一次掠奪的間隔：積極度越高越頻繁 */
  raidDelay() {
    const crowd = Math.max(1, this.list.length / 3);
    return (NPC_CONFIG.raidBaseMs * crowd / (0.3 + this.aggression())) * randFloat(0.7, 1.3);
  }

  // ---------- 更新 ----------

  /** NPC 行動（使用存檔種子） */
  update(now = Date.now()) {
    return withSeed(this.game.state.rng, 'npc', () => this.updateNow(now));
  }

  updateNow(now = Date.now()) {
    if (!this.game.state.map.pois.length || !this.game.shelter.hasShelter()) return;
    const st = this.state;
    if (now >= (st.nextSpawnAt || 0)) {
      // 第一次（或重新掃描後）一次補齊，不逐一記錄
      const first = !this.list.length;
      const added = this.fillCells(now, { silent: first });
      if (first && added) this.game.log(`🏴‍☠️ 附近出現 ${added} 個 NPC 勢力據點（每平方公里約 ${NPC_CONFIG.perCell} 個）`, 'danger');
      st.nextSpawnAt = now + 60000;
    }
    const phase = this.game.time.phase(now);
    const night = this.game.time.nightKey(now);
    this.list.forEach((n) => {
      // 傷亡人員逐漸補回
      if (n.wounded > 0) {
        n.healAt = n.healAt || now + NPC_CONFIG.woundHealMs;
        while (n.wounded > 0 && now >= n.healAt) {
          n.wounded -= 1;
          n.healAt += NPC_CONFIG.woundHealMs;
        }
        if (!n.wounded) n.healAt = 0;
      }
      // 夜晚：NPC 據點也要抵禦屍群（每晚一次）
      if (phase.zombies && n.siegeNight !== night) this.nightSiege(n, night, now);
      // 升級
      let guard = 0;
      while (now >= n.nextLevelAt && guard < 20) {
        guard += 1;
        if (n.level < NPC_CONFIG.maxLevel) n.level += 1;
        n.nextLevelAt += rand(NPC_CONFIG.levelUpMs);
      }
      if (n.trip) this.checkCrossings(n, now);
      // 掠奪隊抵達時立即交戰，之後返回據點
      if (n.trip?.kind === 'raid' && !n.trip.resolved && now >= this.arriveAt(n.trip)) {
        n.trip.resolved = true;
        this.resolveIncoming(n, n.trip, now);
      }
      if (!this.list.includes(n)) return;
      if (n.trip && now >= n.trip.endAt) this.finishTrip(n, now);
      // 有傷員時要先治療（補回人手）才會外出探索或掠奪
      if (n.wounded > 0) return;
      if (!n.trip && now >= n.nextRaidAt) this.launchRaid(n, now);
      if (!n.trip && now >= n.nextExploreAt) this.launchExplore(n, now);
    });
  }

  /** NPC 人員傷亡（每人 20 分鐘補回） */
  wound(n, count, now = Date.now()) {
    if (count <= 0) return;
    n.wounded = Math.min(this.fullCount(n), (n.wounded || 0) + count);
    if (!n.healAt || n.healAt < now) n.healAt = now + NPC_CONFIG.woundHealMs;
  }

  /**
   * NPC 據點抵禦屍群（每晚一次）：依區域危險度、等級與目前傷亡判定結果。
   * 守住會有少量傷亡；被突破會損失物資、人員與等級；本來就元氣大傷的據點可能被屍群攻陷。
   */
  nightSiege(n, night, now) {
    n.siegeNight = night;
    const zone = zoneAt(n.lat, n.lon);
    const weak = (n.wounded || 0) / Math.max(1, this.fullCount(n));
    const r = randFloat(0.5, 1.5) * (1 + Math.max(0, zone.danger) * 0.08) + weak * 0.6;
    let result;
    if (r < 0.85) {
      result = 'held';
      this.wound(n, chance(0.4) ? 1 : 0, now);
    } else if (r < 1.3) {
      result = 'hurt';
      this.wound(n, randInt(1, 2), now);
      Object.keys(n.resources).forEach((k) => { n.resources[k] = Math.floor(n.resources[k] * 0.9); });
    } else {
      result = 'breached';
      this.wound(n, randInt(2, 3), now);
      Object.keys(n.resources).forEach((k) => { n.resources[k] = Math.floor(n.resources[k] * 0.7); });
      n.level = Math.max(1, n.level - 1);
    }
    n.lastSiege = { night, result };
    // 人員全數倒下：據點被屍群攻陷
    if (result === 'breached' && this.garrison(n).length <= 1 && r > 1.6) {
      if (this.intel() >= 1) this.game.log(`🧟 NPC 勢力「${n.name}」的據點被屍群攻陷了`, 'info');
      this.destroy(n, now);
    }
  }

  /** 偵查等級（研究「偵查」）：越高可得知越詳細的 NPC 情報 */
  intel() {
    return this.game.research.level('s_recon');
  }

  /**
   * 依偵查等級顯示的 NPC 情報。
   *  0：只知道名稱；1：大約等級；3：確切等級、守軍與傷亡；5：大約物資；7：確切物資與建議戰力；9：下次掠奪時間
   */
  intelView(n, now = Date.now()) {
    const lv = this.intel();
    const approx = (v, step) => `約 ${Math.max(0, Math.round(v / step) * step)}`;
    const low = Math.max(1, Math.floor((n.level - 1) / 5) * 5 + 1);
    const view = {
      lv,
      level: lv >= 3 ? `Lv${n.level}` : lv >= 1 ? `Lv${low}～${low + 4}` : 'Lv?',
      levelShort: lv >= 3 ? `Lv${n.level}` : lv >= 1 ? `Lv${low}+` : 'Lv?',
      garrison: null,
      wounded: null,
      siege: null,
      resources: null,
      coins: null,
      power: null,
      nextRaid: null,
    };
    if (lv >= 3) {
      const g = this.garrison(n);
      view.garrison = g;
      view.wounded = n.wounded || 0;
      const s = n.lastSiege;
      if (s) view.siege = { held: '守住了屍群', hurt: '守住屍群但有傷亡', breached: '被屍群突破、損失慘重' }[s.result];
    }
    if (lv >= 5) {
      view.resources = Object.entries(n.resources).filter(([, v]) => v > 0).map(([k, v]) => [k, lv >= 7 ? `${Math.floor(v)}` : approx(v, 50)]);
      view.coins = lv >= 7 ? `${n.coins}` : approx(n.coins, 100);
    }
    if (lv >= 7) view.power = Math.round(this.power(n));
    if (lv >= 9) view.nextRaid = Math.max(0, n.nextRaidAt - now);
    return view;
  }

  /** 玩家據點看起來的防禦強度（防禦塔與駐守人員的武器）；NPC 不知道據點還有沒有彈藥 */
  baseDefense(base) {
    const g = this.game;
    const guards = g.territory.garrison(base).list.reduce((s, sv) => s + g.survivors.stats(sv).power, 0);
    return g.siege.of(base.id).defenseDps({ apparent: true }) * 8 + guards;
  }

  /**
   * NPC 行程：自動判斷玩家據點的警戒範圍是否有威脅——防禦強過自己就繞路，
   * 否則直接穿過（若該據點有駐守人員會遭到攻擊）。
   * @param {string} [targetBaseId] 掠奪目標（不繞開）
   */
  tripTimes(n, to, searchMs, targetBaseId = null) {
    const g = this.game;
    const power = this.power(n);
    const zones = g.state.bases.filter((b) => b.id !== targetBaseId).map((b) => ({
      base: b, lat: b.lat, lon: b.lon, r: g.territory.alertRadius(b), defense: this.baseDefense(b),
    }));
    const avoid = zones.filter((z) => z.defense > power * 0.7);
    const from = { lat: n.lat, lon: n.lon };
    const path = planRoute(from, to, avoid);
    const dist = pathLength(path);
    const through = zones.filter((z) => !avoid.includes(z) && g.territory.garrison(z.base).count > 0);
    const back = [...path].reverse();
    const crossingsList = [
      ...crossings(path, through).map(({ index, at }) => ({ baseId: through[index].base.id, at, leg: 'out', done: false })),
      ...crossings(back, through).map(({ index, at }) => ({ baseId: through[index].base.id, at, leg: 'back', done: false })),
    ];
    const travelMs = Math.round((dist / 1000) * NPC_CONFIG.walkMinPerKm * 60000);
    return {
      travelMs, searchMs, distanceM: Math.round(dist), path, crossings: crossingsList, avoided: avoid.length,
    };
  }

  /** NPC 隊伍穿過有駐守人員的玩家據點範圍：駐守人員主動攻擊 */
  checkCrossings(n, now) {
    const trip = n.trip;
    for (const c of trip?.crossings || []) {
      const ratio = trip.distanceM ? c.at / trip.distanceM : 0;
      const at = c.leg === 'out' ? trip.startAt + trip.travelMs * ratio : trip.startAt + trip.travelMs + trip.searchMs + trip.travelMs * ratio;
      if (c.done || at > now) continue;
      c.done = true;
      const g = this.game;
      const base = g.shelter.base(c.baseId);
      const guards = base ? g.territory.garrison(base).list : [];
      if (!guards.length) continue;
      const enemies = Array.from({ length: Math.min(4, 2 + Math.floor(n.level / 8)) }, () => g.combat.createEnemy('raider', n.level));
      const result = g.combat.simulate(guards, enemies);
      g.combat.applyOutcome(guards, result, now);
      if (result.victory) {
        g.log(`🛡️「${base.name}」的駐守人員擊退了路過的「${n.name}」隊伍`, 'success');
        g.toast(`🛡️「${base.name}」擊退了路過的「${n.name}」隊伍`, 'success');
        n.trip = null;
        n.level = Math.max(1, n.level - 1);
        g.bus.emit('npcs:changed');
        return;
      }
      g.log(`⚠️「${n.name}」的隊伍強行穿過「${base.name}」的警戒範圍`, 'danger');
    }
  }

  launchExplore(n, now) {
    n.nextExploreAt = now + rand(NPC_CONFIG.exploreEveryMs);
    const targets = this.game.state.map.pois.filter((p) => !this.game.shelter.baseAtPoi(p.id)
      && !this.list.some((m) => m.poiId === p.id)
      && (p.lootedDay !== dayKey(now) || this.game.state.map.remain?.[p.id])
      && haversine(n.lat, n.lon, p.lat, p.lon) <= NPC_CONFIG.exploreRadiusM);
    const poi = pick(targets);
    if (!poi) return;
    const t = this.tripTimes(n, poi, NPC_CONFIG.searchMs);
    n.trip = {
      kind: 'explore', poiId: poi.id, target: poi.name, from: { lat: n.lat, lon: n.lon }, to: { lat: poi.lat, lon: poi.lon },
      startAt: now, endAt: now + t.travelMs * 2 + t.searchMs, ...t,
    };
  }

  /** 屍潮期間（夜晚）不出動；文明度越高越常來 */
  launchRaid(n, now) {
    n.nextRaidAt = now + this.raidDelay();
    if (this.game.time.phase(now).zombies) return;
    const bases = this.game.state.bases;
    if (!bases.length) return;
    // 盡量避免多個 NPC 同時攻打玩家：已經有掠奪隊在路上時大多會放棄，玩家文明度很高時才比較常發生
    if (!this.allowConcurrentRaid(now)) return;
    const base = pick(bases);
    const t = this.tripTimes(n, base, 0, base.id);
    // 掠奪避難所的移動時間較長，讓玩家有時間準備防守
    t.travelMs = Math.round(Math.max(t.travelMs * RAID_TRAVEL.npcMul, RAID_TRAVEL.minMin * 60000));
    // 抵達時若已入夜（屍潮），NPC 會放棄這次掠奪
    n.trip = {
      kind: 'raid', baseId: base.id, target: base.name, from: { lat: n.lat, lon: n.lon }, to: { lat: base.lat, lon: base.lon },
      startAt: now, endAt: now + t.travelMs * 2, ...t,
    };
    const eta = `約 ${Math.max(1, Math.round(t.travelMs / 60000))} 分鐘後抵達`;
    this.game.log(`🏴‍☠️「${n.name}」的掠奪隊正朝「${base.name}」前進！（${eta}）`, 'danger');
    this.game.toast(`🏴‍☠️「${n.name}」（${this.intelView(n).levelShort}）的掠奪隊正朝「${base.name}」前進！（${eta}）`, 'danger');
  }

  /** 正在前往玩家據點的 NPC 掠奪隊數量 */
  activeRaids(now = Date.now()) {
    return this.list.filter((m) => m.trip?.kind === 'raid' && !m.trip.resolved && !m.trip.hidden && now < m.trip.endAt).length;
  }

  /** 已經有掠奪隊時，是否還要再發動（機率很低，文明度很高時才提高） */
  allowConcurrentRaid(now = Date.now()) {
    const active = this.activeRaids(now);
    if (!active) return true;
    const civ = this.game.civilization.value();
    const c = NPC_CONFIG;
    const p = civ < c.concurrentCiv ? c.concurrentChance : Math.min(c.concurrentMax, c.concurrentChance + (civ - c.concurrentCiv) / 1000);
    return chance(p / active);
  }

  /** NPC 行程抵達目的地的時間 */
  arriveAt(trip) {
    return trip.startAt + trip.travelMs;
  }

  finishTrip(n, now = Date.now()) {
    const trip = n.trip;
    n.trip = null;
    // 回到據點後先休息一段時間，不會一直外出
    n.nextExploreAt = Math.max(n.nextExploreAt || 0, now + rand(NPC_CONFIG.exploreEveryMs));
    if (trip.kind === 'explore') {
      const poi = this.game.state.map.pois.find((p) => p.id === trip.poiId);
      const at = this.arriveAt(trip);
      // 探索途中遭遇殭屍：可能有人受傷，要治療（補回人手）後才能再外出
      if (poi) {
        const night = this.game.time.phase(at).zombies ? 1.6 : 1;
        if (chance(NPC_CONFIG.exploreInjuryChance * this.game.zombies.encounterMul(poi.lat, poi.lon) * night)) this.wound(n, chance(0.3) ? 2 : 1, now);
      }
      const remain = this.game.state.map.remain || {};
      if (!poi || (poi.lootedDay === dayKey(at) && !remain[poi.id])) return;
      const stock = stockOf(poi, at, remain);
      Object.entries(stock.resources).forEach(([k, v]) => { n.resources[k] = (n.resources[k] || 0) + Math.round(v * 0.6); });
      // NPC 探索過的建築資源一併消失（包含殘留的物資）
      poi.lootedDay = dayKey(at);
      delete remain[poi.id];
      this.game.bus.emit('map:changed');
    }
  }

  /** NPC 掠奪隊抵達玩家據點 */
  resolveIncoming(n, trip, now) {
    const g = this.game;
    const base = g.shelter.base(trip.baseId);
    const arrive = this.arriveAt(trip);
    if (!base) return;
    if (g.time.phase(arrive).zombies) {
      g.log(`🏴‍☠️「${n.name}」的掠奪隊見屍潮來襲，撤退了`, 'info');
      return;
    }
    // 1. 掠奪者要先打破圍牆，期間防禦設施持續射擊
    const all = this.garrison(n);
    const raiders = all.length;
    const siege = g.siege.of(base.id);
    const wallBefore = g.shelter.wallHp(base);
    // 友好玩家的協防隊：守城時一起射擊，圍牆被打破後一起迎戰
    const isHome = g.shelter.isPrimary(base);
    const helpers = isHome ? g.assist.incoming().filter((h) => h.kind === 'team') : [];
    const allies = isHome ? g.assist.allyUnits() : [];
    const helpDps = helpers.reduce((s, h) => s + (h.dps || 0), 0);
    const as = g.combat.wallAssault(all, wallBefore, siege.defenseDps() * (1 + g.research.bonus('raidDefensePct')) + helpDps);
    base.wallHp = as.wallLeft;
    const enemies = as.alive;
    const defenders = this.defenders(base);
    const severeBefore = new Set(g.state.survivors.filter((sv) => sv.severe).map((sv) => sv.id));
    // 2. 圍牆被打破後，與據點中的人員交戰；打贏才能掠奪
    let victory = !as.breached;
    let result = null;
    if (as.breached && (defenders.length || allies.length)) {
      result = g.combat.simulate(defenders, enemies, { firstStrikeBonus: base.facilities.watchtower.level * 0.04, allies });
      g.combat.applyOutcome(defenders, result, now);
      victory = result.victory;
    }
    const label0 = `NPC「${n.name}」`;
    const helperNames = Object.fromEntries(helpers.map((h) => [h.id, h.name]));
    const helperSum = AssistSystem.summarize(result ? result.team : [], helperNames);
    helpers.forEach((h) => { if (!helperSum[h.id]) helperSum[h.id] = { name: h.name, kills: 0, units: [] }; });
    const assistNote = g.assist.recordRaid(base, label0, victory, helperSum);
    const kills = as.killed + (result?.kills.length || 0);
    // NPC 的傷亡：被防禦設施或防守人員擊倒的掠奪者，需要時間補回
    this.wound(n, Math.min(kills, this.fullCount(n)), now);
    const label = `NPC「${n.name}」（${this.intelView(n).levelShort}）`;
    if (victory) {
      const injured = ShelterSystem.newlySevere(severeBefore, defenders);
      g.state.stats.battlesWon += 1;
      const how = !as.breached
        ? (enemies.length ? `圍牆撐住了 ${as.sec} 秒，掠奪隊放棄撤退` : '防禦設施在圍牆被打破前擊退了掠奪隊')
        : `圍牆被打破，防守人員（${defenders.map((d) => d.name).join('、')}）擊退了掠奪隊`;
      g.shelter.recordDefense({
        base, attacker: label, success: true, kills, injured, wallLost: as.wallLost, note: [how, assistNote].filter(Boolean).join('。'),
      });
      g.toast(`🛡️「${base.name}」擊退了「${n.name}」的掠奪隊！`, 'success');
      n.level = Math.max(1, n.level - 1);
      g.bus.emit('npc:raid', { npcId: n.id, baseId: base.id, victory: true });
      return;
    }
    void raiders;
    // 掠奪成功：搶走資源與部分金錢，圍牆受損
    const res = g.state.resources;
    const stolen = {};
    RESOURCE_KEYS.forEach((k) => {
      stolen[k] = Math.floor(g.shelter.exposed(k) * NPC_CONFIG.raidStealPct); // 地窖裡的搶不走
      res[k] -= stolen[k];
      n.resources[k] = (n.resources[k] || 0) + stolen[k];
    });
    const coins = Math.floor(g.shelter.exposed('coins') * 0.1);
    g.state.player.coins -= coins;
    n.coins += coins;
    g.state.stats.battlesLost += 1;
    const damaged = siege.damageBuildings(base);
    g.shelter.recordDefense({
      base, attacker: label, success: false, lost: stolen, coins, kills, damaged, injured: ShelterSystem.newlySevere(severeBefore, defenders),
      wallLost: as.wallLost, note: [`圍牆被打破；${defenders.length || allies.length ? `防守人員（${[...defenders.map((d) => d.name), ...allies.map((a) => a.name)].join('、')}）戰敗` : '據點裡沒有人可以防守'}`, assistNote].filter(Boolean).join('。'),
    });
    const total = Object.values(stolen).reduce((s, v) => s + v, 0);
    g.toast(`💀「${n.name}」掠奪了「${base.name}」！搶走 ${total} 單位物資`, 'danger');
    g.bus.emit('npc:raid', {
      npcId: n.id, baseId: base.id, victory: false, stolen, coins,
    });
  }

  /** 防守的倖存者：避難所為所有在家的可行動人員；前哨站只有駐守瞭望塔的人 */
  defenders(base) {
    const g = this.game;
    const home = g.state.survivors.filter((s) => s.status === 'idle' && !s.severe);
    if (g.shelter.isPrimary(base)) return home.filter((s) => !g.survivors.isGarrisoned(s.id) || g.shelter.garrisonOf(s.id)?.base.id === base.id).slice(0, 6);
    return home.filter((s) => g.shelter.garrisonOf(s.id)?.base.id === base.id);
  }

  // ---------- 玩家攻打 ----------

  /** 探索系統結算「攻打 NPC 據點」 */
  resolveRaid(exp) {
    const g = this.game;
    const n = this.get(exp.poiId);
    const members = exp.memberIds.map((id) => g.survivors.get(id)).filter(Boolean);
    const report = {
      id: uid('rp'), poiName: n ? `🏴‍☠️ ${n.name}` : 'NPC 據點', poiType: 'military', at: exp.endAt,
      events: [...(exp.travelEvents || [])], resources: {}, items: [], blueprints: [],
      kills: exp.travelKills || 0, xp: exp.travelXp || 0, success: false, members: members.map((m) => m.name),
    };
    if (!n || !members.length) {
      report.events.push('🏚️ 抵達時據點已經人去樓空。');
      return report;
    }
    const enemies = this.garrison(n);
    report.events.push(`⚔️ 攻打「${n.name}」（Lv${n.level}）：守軍 ${enemies.length} 人${n.wounded ? `（另有 ${n.wounded} 人傷亡中）` : ''}`);
    const result = g.combat.simulate(members, enemies);
    g.combat.applyOutcome(members, result, exp.endAt);
    report.kills += result.kills.length;
    report.xp += result.xp;
    if (!result.victory) {
      g.state.stats.battlesLost += 1;
      this.wound(n, Math.min(result.kills.length, this.fullCount(n)), exp.endAt);
      report.events.push(`💀 攻打失敗，隊伍撤退！${result.kills.length ? `（擊倒對方 ${result.kills.length} 人，對方需要時間補回人手）` : ''}`);
      return report;
    }
    // 勝利：搶走據點資源（受運載量限制），據點被摧毀
    g.state.stats.battlesWon += 1;
    report.success = true;
    const carry = exp.cargo || members.length * 40;
    const total = Object.entries(n.resources).reduce((s, [k, v]) => s + (v || 0) * unitWeight(k), 0);
    const ratio = total > carry ? carry / total : 1;
    const loot = Object.fromEntries(Object.entries(n.resources).map(([k, v]) => [k, Math.floor((v || 0) * ratio)]));
    report.resources = g.grant({ ...loot, coins: n.coins });
    if (ratio < 1) report.events.push(`🎒 帶不走全部物資（運載量 ${carry}），留下約 ${Math.round(total - carry)} 重量的物資`);
    if (chance(0.6)) {
      const item = g.equipment.generate({ level: n.level, boost: 0.3 + zoneAt(n.lat, n.lon).rarityBoost });
      report.items.push(item);
      g.equipment.addItem(item, '攻打 NPC');
    }
    report.events.push(`🏆 攻陷「${n.name}」，據點被摧毀！`);
    g.log(`🏆 攻陷 NPC 據點「${n.name}」`, 'success');
    this.destroy(n, exp.endAt);
    return report;
  }

  destroy(n, now = Date.now()) {
    this.state.list = this.list.filter((x) => x.id !== n.id);
    this.state.cellNext = this.state.cellNext || {};
    this.state.cellNext[n.cell || this.cellOf(n.lat, n.lon)] = now + rand(NPC_CONFIG.respawnMs);
    this.game.bus.emit('npcs:changed');
  }

  /** 地圖顯示：所有 NPC 行程（含掠奪隊） */
  trips(now = Date.now()) {
    // 被擊敗後撤回的隊伍（hidden）仍顯示移動，但不能再被攔截
    return this.list.filter((n) => n.trip && n.trip.endAt > now).map((n) => ({ npc: n, trip: n.trip, p: tripProgress(n.trip, now) }));
  }
}
