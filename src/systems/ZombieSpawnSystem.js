import { ZOMBIE_REFRESH_MS, ZOMBIE_MAX_GROUPS, MAX_TEAM_SIZE } from '../config/constants.js';
import { POI_TYPES } from '../config/poiTypes.js';
import { zoneAt } from '../config/zones.js';
import { ALL_ENEMIES, BOSSES } from '../config/enemies.js';
import {
  withSeed,
  chance, pick, randInt, uid, weightedPick, haversine, offsetLatLon, randFloat,
} from '../utils/math.js';

/**
 * 地圖殭屍生成：依區域危險度、日夜時段定時刷新殭屍群，
 * 玩家可派隊伍主動攻擊以獲得經驗、材料與裝備。
 */
export class ZombieSpawnSystem {
  constructor(game) {
    this.game = game;
  }

  get groups() {
    return this.game.state.map.zombieGroups;
  }

  /** 區域危險度：建築類型 + 所在區域（安全區～深淵區）+ 距離避難所（越遠越危險） */
  areaDanger(poi) {
    const sh = this.game.shelter.primary();
    const base = Math.max(1, POI_TYPES[poi.type].danger + zoneAt(poi.lat, poi.lon).danger);
    if (!sh) return base;
    const km = haversine(sh.lat, sh.lon, poi.lat, poi.lon) / 1000;
    return base + Math.min(2, Math.floor(km / 0.6));
  }

  /** 區域敵人等級：區域危險度 + 文明度加成（不隨天數成長） */
  areaLevel(poi) {
    return Math.max(1, Math.round(this.areaDanger(poi) * 1.5 - 1) + this.game.civilization.levelBonus());
  }

  update(now) {
    const map = this.game.state.map;
    if (!map.pois.length) return;
    if (now - map.lastZombieRefresh < ZOMBIE_REFRESH_MS) return;
    map.lastZombieRefresh = now;
    this.refresh(now);
  }

  refresh(now = Date.now()) {
    const map = this.game.state.map;
    const phase = this.game.time.phase(now);
    // 白天殭屍躲在建築內：地圖上不出現殭屍群（只會在探索時遭遇）
    if (!phase.zombies) {
      map.zombieNight = null;
      if (map.zombieGroups.length) {
        map.zombieGroups = [];
        this.game.bus.emit('map:changed');
      }
      return;
    }
    // 每晚只在入夜時生成一次：午夜（00:00）、轉回夜晚（02:00）或定時檢查都不會補充，擊殺的殭屍群當晚不再出現
    const night = this.game.time.nightKey(now);
    if (map.zombieNight === night) return;
    if (!map.pois.length) return;
    map.zombieNight = night;
    map.zombieGroups = [];
    const target = Math.round(ZOMBIE_MAX_GROUPS * Math.min(1, 0.45 * phase.zombieMul));
    const candidates = map.pois.filter((p) => !this.game.shelter.baseAtPoi(p.id));
    let guard = 0;
    while (map.zombieGroups.length < target && candidates.length && guard < 200) {
      guard += 1;
      const poi = weightedPick(candidates.map((p) => ({ p, weight: POI_TYPES[p.type].danger })))?.p;
      if (!poi) break;
      map.zombieGroups.push(this.makeGroup(poi, phase, now));
    }
    this.game.bus.emit('map:changed');
  }

  /**
   * 區域安全程度對夜間殭屍的影響：越安全遇到的機率越低、殭屍越弱。
   * 安全區 ×0.4、一般區 ×0.6、警戒區 ×0.8、危險區 ×1.0、致死區 ×1.2、深淵區 ×1.5
   */
  encounterMul(lat, lon) {
    const z = zoneAt(lat, lon);
    return Math.min(1.5, Math.max(0.4, 0.6 + 0.2 * z.danger));
  }

  /**
   * 區域等級上限：越安全的區域殭屍越弱（白天、夜晚都適用）；午夜上限提高，但仍依區域拉開差距。
   * 安全區 3（午夜 4）、一般區 6（8）、警戒區 9（12）、危險區 12（16）、致死區 15（20）、深淵區 21（28），再加文明度加成。
   */
  zoneLevelCap(lat, lon, phase = null) {
    const z = zoneAt(lat, lon);
    const d = Math.max(-1, z.danger);
    return 3 + 3 * (d + 1) + (phase?.special ? 2 + Math.max(-1, d) + (d > 0 ? d : 0) : 0) + this.game.civilization.levelBonus();
  }

  /**
   * 殭屍等級：區域等級＋夜晚加成（午夜較高，加成依區域危險程度放大），並受區域上限限制。
   */
  nightLevel(poi, phase) {
    const z = zoneAt(poi.lat, poi.lon);
    const base = this.areaLevel(poi);
    const bonus = phase?.zombies ? Math.round(Math.max(0, phase.danger - 1) * 2 * (1 + Math.max(0, z.danger))) : 0;
    return Math.max(1, Math.min(base + bonus, this.zoneLevelCap(poi.lat, poi.lon, phase)));
  }

  makeGroup(poi, phase, now) {
    const pt = POI_TYPES[poi.type];
    const danger = this.areaDanger(poi);
    const zone = zoneAt(poi.lat, poi.lon);
    let enemyId = weightedPick(pt.enemies);
    let boss = false;
    // 夜行者只出現在警戒區以上（一般區午夜才有少量），安全區不會出現
    const stalker = zone.danger >= 1 ? (phase.special ? 0.35 : 0.15) : zone.danger === 0 && phase.special ? 0.08 : 0;
    if (phase.zombies && chance(stalker)) enemyId = 'nightStalker';
    // Boss 只在警戒區以上的特殊建築
    if (pt.special && zone.danger >= 1 && chance(0.06 + danger * 0.01)) {
      enemyId = pick(Object.keys(BOSSES));
      boss = true;
    }
    const count = boss ? 1 : Math.max(1, Math.round(randInt(1, 2 + danger) * Math.min(1.6, phase.zombieMul * 0.8) * this.encounterMul(poi.lat, poi.lon)));
    const pos = offsetLatLon(poi.lat, poi.lon, randFloat(15, 60), randFloat(0, Math.PI * 2));
    return {
      id: uid('zg'),
      poiId: poi.id,
      lat: pos.lat,
      lon: pos.lon,
      enemyId,
      count,
      level: Math.round(this.nightLevel(poi, phase) * (boss ? 1.2 : 1)),
      elite: !boss && zone.danger >= 0 && chance(0.05 * danger),
      boss,
      spawnedAt: now,
    };
  }

  groupLabel(g) {
    const e = ALL_ENEMIES[g.enemyId];
    return `${g.elite ? '精英' : ''}${e.name} ×${g.count}（Lv${g.level}）`;
  }

  /**
   * 派隊攻擊殭屍群。
   * @returns {{ok:boolean, reason?:string, result?:object, loot?:object}}
   */
  /** 攻擊殭屍群（使用存檔種子） */
  attack(groupId, memberIds, opts = {}) {
    return withSeed(this.game.state.rng, 'battle', () => this.attackNow(groupId, memberIds, opts));
  }

  /**
   * @param {{arrived?:boolean, at?:number}} [opts] arrived：派出的隊伍已抵達（隊員在外，不檢查是否在家）
   */
  attackNow(groupId, memberIds, { arrived = false, at = Date.now() } = {}) {
    const g = this.groups.find((x) => x.id === groupId);
    if (!g) return { ok: false, reason: '殭屍群已離開' };
    if (!this.game.time.phase(at).zombies) return { ok: false, reason: '天亮了，殭屍已躲回建築內' };
    const members = memberIds.map((id) => this.game.survivors.get(id)).filter(Boolean);
    if (!members.length) return { ok: false, reason: '請選擇隊員' };
    if (members.length > MAX_TEAM_SIZE) return { ok: false, reason: `隊伍最多 ${MAX_TEAM_SIZE} 人` };
    if (!arrived && members.some((m) => !this.game.survivors.isAvailable(m))) return { ok: false, reason: '有隊員無法出戰' };

    const enemies = Array.from({ length: g.count }, () => this.game.combat.createEnemy(g.enemyId, g.level, g.elite));
    const firstStrike = this.game.shelter.primary().facilities.watchtower.level * 0.04;
    const result = this.game.combat.simulate(members, enemies, { firstStrikeBonus: firstStrike });
    this.game.combat.applyOutcome(members, result, at);

    const loot = { items: [] };
    if (result.victory) {
      this.game.state.stats.battlesWon += 1;
      this.game.state.map.zombieGroups = this.groups.filter((x) => x.id !== groupId);
      const poi = this.game.state.map.pois.find((p) => p.id === g.poiId);
      const dropChance = (g.boss ? 1 : 0.12 * g.count) * (g.elite ? 2 : 1);
      if (chance(Math.min(1, dropChance))) {
        const item = this.game.equipment.generate({
          level: g.level,
          bias: poi ? POI_TYPES[poi.type].itemBias : undefined,
          boost: (g.boss ? 0.6 : g.elite ? 0.3 : 0.05) + (poi ? zoneAt(poi.lat, poi.lon).rarityBoost : 0),
          minRarity: g.boss ? 'rare' : undefined,
        });
        this.game.equipment.addItem(item, '戰鬥');
        loot.items.push(item);
      }
      // 殭屍身上的零碎物品：少量零件與布料
      const mats = { scrap: randInt(0, 2) * g.count, coarse: randInt(0, 1) * g.count, ...(chance(0.15) ? { bandage: 1 } : {}) };
      loot.resources = this.game.grant(mats);
    } else {
      this.game.state.stats.battlesLost += 1;
      g.count = Math.max(1, g.count - result.kills.length);
    }
    return { ok: true, result, loot, group: g };
  }
}
