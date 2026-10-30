import { NPC_CONFIG, NPC_NAMES, npcAggression } from '../config/npcs.js';
import { RESOURCE_KEYS } from '../config/constants.js';
import { POI_TYPES } from '../config/poiTypes.js';
import { zoneAt } from '../config/zones.js';
import { stockOf, dayKey } from './LootStock.js';
import { tripProgress } from './ExplorationSystem.js';
import {
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

  /** 據點守備：掠奪者人數與等級 */
  garrison(n) {
    const count = Math.min(6, 2 + Math.floor(n.level / 5));
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

  spawn(now = Date.now()) {
    const o = this.origin();
    const used = new Set(this.list.map((n) => n.poiId));
    const candidates = this.game.state.map.pois.filter((p) => {
      if (used.has(p.id) || this.game.shelter.baseAtPoi(p.id)) return false;
      const d = haversine(o.lat, o.lon, p.lat, p.lon);
      return d >= NPC_CONFIG.spawnMinM && d <= NPC_CONFIG.spawnMaxM && POI_TYPES[p.type].danger >= 2;
    });
    const poi = pick(candidates);
    if (!poi) return null;
    const leader = this.game.survivors.leader();
    const zone = zoneAt(poi.lat, poi.lon);
    const level = Math.max(1, (leader?.level || 1) - 2 + randInt(0, 3) + Math.max(0, zone.danger));
    const n = {
      id: uid('npc'),
      name: pick(NPC_NAMES.filter((x) => !this.list.some((m) => m.name === x))) || pick(NPC_NAMES),
      poiId: poi.id,
      lat: poi.lat,
      lon: poi.lon,
      level,
      resources: { food: randInt(60, 160), wood: randInt(60, 200), metal: randInt(40, 150), fuel: randInt(10, 60) },
      coins: randInt(40, 120) * level,
      nextLevelAt: now + rand(NPC_CONFIG.levelUpMs),
      nextExploreAt: now + rand(NPC_CONFIG.exploreEveryMs) * 0.5,
      nextRaidAt: now + this.raidDelay(),
      trip: null,
    };
    this.list.push(n);
    this.game.log(`🏴‍☠️ NPC 勢力「${n.name}」在「${poi.name}」建立據點（Lv${n.level}）`, 'danger');
    this.game.bus.emit('npcs:changed');
    return n;
  }

  /** 下一次掠奪的間隔：積極度越高越頻繁 */
  raidDelay() {
    return (NPC_CONFIG.raidBaseMs / (0.3 + this.aggression())) * randFloat(0.7, 1.3);
  }

  // ---------- 更新 ----------

  update(now = Date.now()) {
    if (!this.game.state.map.pois.length || !this.game.shelter.hasShelter()) return;
    const st = this.state;
    if (this.list.length < NPC_CONFIG.count && now >= (st.nextSpawnAt || 0)) {
      this.spawn(now);
      st.nextSpawnAt = now + 60000;
    }
    this.list.forEach((n) => {
      // 升級
      let guard = 0;
      while (now >= n.nextLevelAt && guard < 20) {
        guard += 1;
        if (n.level < NPC_CONFIG.maxLevel) n.level += 1;
        n.nextLevelAt += rand(NPC_CONFIG.levelUpMs);
      }
      // 掠奪隊抵達時立即交戰，之後返回據點
      if (n.trip?.kind === 'raid' && !n.trip.resolved && now >= this.arriveAt(n.trip)) {
        n.trip.resolved = true;
        this.resolveIncoming(n, n.trip, now);
      }
      if (n.trip && now >= n.trip.endAt) this.finishTrip(n, now);
      if (!n.trip && now >= n.nextRaidAt) this.launchRaid(n, now);
      if (!n.trip && now >= n.nextExploreAt) this.launchExplore(n, now);
    });
  }

  tripTimes(n, to, searchMs) {
    const dist = haversine(n.lat, n.lon, to.lat, to.lon);
    const travelMs = Math.round((dist / 1000) * NPC_CONFIG.walkMinPerKm * 60000);
    return { travelMs, searchMs, distanceM: Math.round(dist) };
  }

  launchExplore(n, now) {
    n.nextExploreAt = now + rand(NPC_CONFIG.exploreEveryMs);
    const targets = this.game.state.map.pois.filter((p) => !this.game.shelter.baseAtPoi(p.id)
      && !this.list.some((m) => m.poiId === p.id)
      && p.lootedDay !== dayKey(now)
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
    const base = pick(bases);
    const t = this.tripTimes(n, base, 0);
    // 抵達時若已入夜（屍潮），NPC 會放棄這次掠奪
    n.trip = {
      kind: 'raid', baseId: base.id, target: base.name, from: { lat: n.lat, lon: n.lon }, to: { lat: base.lat, lon: base.lon },
      startAt: now, endAt: now + t.travelMs * 2, ...t,
    };
    this.game.log(`🏴‍☠️「${n.name}」的掠奪隊正朝「${base.name}」前進！`, 'danger');
    this.game.toast(`🏴‍☠️「${n.name}」（Lv${n.level}）的掠奪隊正朝「${base.name}」前進！`, 'danger');
  }

  /** NPC 行程抵達目的地的時間 */
  arriveAt(trip) {
    return trip.startAt + trip.travelMs;
  }

  finishTrip(n) {
    const trip = n.trip;
    n.trip = null;
    if (trip.kind === 'explore') {
      const poi = this.game.state.map.pois.find((p) => p.id === trip.poiId);
      const at = this.arriveAt(trip);
      if (!poi || poi.lootedDay === dayKey(at)) return;
      const stock = stockOf(poi, at);
      Object.entries(stock.resources).forEach(([k, v]) => { n.resources[k] = (n.resources[k] || 0) + Math.round(v * 0.6); });
      poi.lootedDay = dayKey(at);
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
    // 防禦塔先削減掠奪者，剩下的與據點中的倖存者交戰
    let enemies = this.garrison(n);
    const siege = g.siege.of(base.id);
    let towerDamage = siege.defenseDps() * 25 + g.shelter.wallHp(base) * 0.15;
    enemies = enemies.filter((e) => {
      if (towerDamage >= e.maxHp) {
        towerDamage -= e.maxHp;
        return false;
      }
      return true;
    });
    const defenders = this.defenders(base);
    let victory = !enemies.length;
    let result = null;
    if (!victory && defenders.length) {
      result = g.combat.simulate(defenders, enemies, { firstStrikeBonus: base.facilities.watchtower.level * 0.04 });
      g.combat.applyOutcome(defenders, result, now);
      victory = result.victory;
    }
    if (victory) {
      g.state.stats.battlesWon += 1;
      g.log(`🛡️「${base.name}」擊退了「${n.name}」的掠奪隊！`, 'success');
      g.toast(`🛡️「${base.name}」擊退了「${n.name}」的掠奪隊！`, 'success');
      n.level = Math.max(1, n.level - 1);
      g.bus.emit('npc:raid', { npcId: n.id, baseId: base.id, victory: true });
      return;
    }
    // 掠奪成功：搶走資源與部分金錢，圍牆受損
    const res = g.state.resources;
    const stolen = {};
    RESOURCE_KEYS.forEach((k) => {
      stolen[k] = Math.floor(res[k] * NPC_CONFIG.raidStealPct);
      res[k] -= stolen[k];
      n.resources[k] = (n.resources[k] || 0) + stolen[k];
    });
    const coins = Math.floor(g.state.player.coins * 0.1);
    g.state.player.coins -= coins;
    n.coins += coins;
    base.wallHp = g.shelter.wallHp(base) * (1 - NPC_CONFIG.raidWallDamage);
    g.state.stats.battlesLost += 1;
    const total = Object.values(stolen).reduce((s, v) => s + v, 0);
    g.log(`💀「${n.name}」掠奪了「${base.name}」：搶走 ${total} 單位物資與 💰${coins}`, 'danger');
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
    report.events.push(`⚔️ 攻打「${n.name}」（Lv${n.level}）：守軍 ${enemies.length} 人`);
    const result = g.combat.simulate(members, enemies);
    g.combat.applyOutcome(members, result, exp.endAt);
    report.kills += result.kills.length;
    report.xp += result.xp;
    if (!result.victory) {
      g.state.stats.battlesLost += 1;
      report.events.push('💀 攻打失敗，隊伍撤退！');
      return report;
    }
    // 勝利：搶走據點資源（受運載量限制），據點被摧毀
    g.state.stats.battlesWon += 1;
    report.success = true;
    const carry = exp.cargo || members.length * 40;
    const total = RESOURCE_KEYS.reduce((s, k) => s + (n.resources[k] || 0), 0);
    const ratio = total > carry ? carry / total : 1;
    const loot = Object.fromEntries(RESOURCE_KEYS.map((k) => [k, Math.floor((n.resources[k] || 0) * ratio)]));
    report.resources = g.grant({ ...loot, coins: n.coins });
    if (ratio < 1) report.events.push(`🎒 帶不走全部物資（運載量 ${carry}），留下約 ${Math.round(total - carry)} 單位`);
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
    this.state.nextSpawnAt = now + rand(NPC_CONFIG.respawnMs);
    this.game.bus.emit('npcs:changed');
  }

  /** 地圖顯示：所有 NPC 行程（含掠奪隊） */
  trips(now = Date.now()) {
    return this.list.filter((n) => n.trip && n.trip.endAt > now).map((n) => ({ npc: n, trip: n.trip, p: tripProgress(n.trip, now) }));
  }
}
