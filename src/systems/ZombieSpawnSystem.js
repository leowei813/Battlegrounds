import { ZOMBIE_REFRESH_MS, ZOMBIE_MAX_GROUPS, MAX_TEAM_SIZE } from '../config/constants.js';
import { POI_TYPES } from '../config/poiTypes.js';
import { ALL_ENEMIES, BOSSES } from '../config/enemies.js';
import {
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

  /** 依距離避難所增加危險度（越遠越危險） */
  areaDanger(poi) {
    const sh = this.game.shelter.primary();
    const base = POI_TYPES[poi.type].danger;
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
      if (map.zombieGroups.length) {
        map.zombieGroups = [];
        this.game.bus.emit('map:changed');
      }
      return;
    }
    // 過期的群體散去
    map.zombieGroups = this.groups.filter((g) => now - g.spawnedAt < ZOMBIE_REFRESH_MS * 3);
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

  makeGroup(poi, phase, now) {
    const pt = POI_TYPES[poi.type];
    const danger = this.areaDanger(poi);
    let enemyId = weightedPick(pt.enemies);
    let boss = false;
    if (phase.special && chance(0.35)) enemyId = 'nightStalker';
    if (pt.special && chance(0.06 + danger * 0.01)) {
      enemyId = pick(Object.keys(BOSSES));
      boss = true;
    }
    const count = boss ? 1 : Math.max(1, Math.round(randInt(1, 2 + danger) * Math.min(1.6, phase.zombieMul * 0.8)));
    const pos = offsetLatLon(poi.lat, poi.lon, randFloat(15, 60), randFloat(0, Math.PI * 2));
    return {
      id: uid('zg'),
      poiId: poi.id,
      lat: pos.lat,
      lon: pos.lon,
      enemyId,
      count,
      level: Math.round(this.areaLevel(poi) * phase.danger * (boss ? 1.2 : 1)),
      elite: !boss && chance(0.05 * danger),
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
  attack(groupId, memberIds) {
    const g = this.groups.find((x) => x.id === groupId);
    if (!g) return { ok: false, reason: '殭屍群已離開' };
    if (!this.game.time.phase().zombies) return { ok: false, reason: '天亮了，殭屍已躲回建築內' };
    const members = memberIds.map((id) => this.game.survivors.get(id)).filter(Boolean);
    if (!members.length) return { ok: false, reason: '請選擇隊員' };
    if (members.length > MAX_TEAM_SIZE) return { ok: false, reason: `隊伍最多 ${MAX_TEAM_SIZE} 人` };
    if (members.some((m) => !this.game.survivors.isAvailable(m))) return { ok: false, reason: '有隊員無法出戰' };

    const enemies = Array.from({ length: g.count }, () => this.game.combat.createEnemy(g.enemyId, g.level, g.elite));
    const firstStrike = this.game.shelter.primary().facilities.watchtower.level * 0.04;
    const result = this.game.combat.simulate(members, enemies, { firstStrikeBonus: firstStrike });
    this.game.combat.applyOutcome(members, result);

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
          boost: g.boss ? 0.6 : g.elite ? 0.3 : 0.05,
          minRarity: g.boss ? 'rare' : undefined,
        });
        this.game.equipment.addItem(item, '戰鬥');
        loot.items.push(item);
      }
      const mats = { metal: randInt(2, 6) * g.count, cloth: randInt(1, 4) * g.count };
      loot.resources = this.game.grant(mats);
    } else {
      this.game.state.stats.battlesLost += 1;
      g.count = Math.max(1, g.count - result.kills.length);
    }
    return { ok: true, result, loot, group: g };
  }
}
