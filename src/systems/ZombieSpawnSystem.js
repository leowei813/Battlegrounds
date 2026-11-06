import { SUPPLIES, SUPPLY_KEYS } from '../config/supplies.js';
import { ZOMBIE_REFRESH_MS, ZOMBIE_MAX_GROUPS, MAX_TEAM_SIZE } from '../config/constants.js';
import { POI_TYPES } from '../config/poiTypes.js';
import { zoneAt } from '../config/zones.js';
import {
  ALL_ENEMIES, BOSSES, ZOMBIE_VS_SURVIVOR, NIGHT_MUL, MAP_GROUP_MUL, BUILDING_ZONE, DAY_ZONE, mulOf,
} from '../config/enemies.js';
import {
  withSeed,
  chance, pick, randInt, uid, weightedPick, haversine, offsetLatLon, randFloat,
} from '../utils/math.js';
import { seeded, cellOf, cellBox, cellsAround } from '../multiplayer/worldGrid.js';

/**
 * 夜晚地圖殭屍群：依「格子＋夜晚編號」決定（所有玩家看到相同的殭屍群、精英與 Boss），
 * 被擊倒或打傷的狀態寫入共用物件 zk:<夜晚>:<大格子>，大家同步。
 */
export const SHARED_ZOMBIES = {
  cellKm: 0.6,
  /** 共用紀錄的大格子（公里） */
  groupKm: 3,
  /** 顯示避難所周圍多遠的殭屍群（公里） */
  radiusKm: 2.2,
};

/**
 * 地圖殭屍生成：依區域危險度、日夜時段定時刷新殭屍群，
 * 玩家可派隊伍主動攻擊以獲得經驗、材料與裝備。
 */
export class ZombieSpawnSystem {
  constructor(game) {
    this.game = game;
    game.shared?.watch('zk', SHARED_ZOMBIES.radiusKm + SHARED_ZOMBIES.groupKm);
    game.bus?.on?.('shared:changed', () => this.applyShared());
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
    // 每晚只在入夜時生成一次（所有玩家相同）：擊倒的殭屍群當晚不再出現
    const night = this.game.time.nightKey(now);
    if (map.zombieNight === night) {
      this.applyShared();
      return;
    }
    if (!map.pois.length) return;
    map.zombieNight = night;
    map.zombieGroups = this.sharedGroups(night);
    this.applyShared();
    this.game.bus.emit('map:changed');
  }

  /** 決定性產生某一晚避難所附近的殭屍群 */
  sharedGroups(night) {
    const map = this.game.state.map;
    const c = this.game.shelter.primary() || map.center;
    if (!c) return [];
    const Z = SHARED_ZOMBIES;
    // 只在有建築的格子（避免出現在海上、山區）；最近的建築作為掉落物的參考
    const near = new Map();
    map.pois.forEach((p) => {
      const k = cellOf(p.lat, p.lon, Z.cellKm).key;
      if (!near.has(k)) near.set(k, p);
    });
    const out = [];
    cellsAround(c.lat, c.lon, Z.cellKm, Z.radiusKm).forEach(({ i, j, key }) => {
      const poi = near.get(key);
      if (!poi) return;
      const box = cellBox(i, j, Z.cellKm);
      if (haversine(c.lat, c.lon, box.lat, box.lon) > Z.radiusKm * 1000) return;
      seeded(`zg:${night}:${key}`, () => {
        const zone = zoneAt(box.lat, box.lon);
        const d = Math.max(0, zone.danger);
        const p = Math.min(0.9, 0.32 + 0.14 * d);
        const n = (chance(p) ? 1 : 0) + (chance(p * 0.45) ? 1 : 0);
        for (let k = 0; k < n; k += 1) {
          const lat = box.lat0 + box.dLat * randFloat(0.05, 0.95);
          const lon = box.lon0 + box.dLon * randFloat(0.05, 0.95);
          let enemyId = weightedPick({
            walker: 6, infected: 4, berserker: 1 + d, mutant: d * 0.7,
          });
          const stalker = zone.danger >= 1 ? 0.18 : zone.danger === 0 ? 0.04 : 0;
          if (chance(stalker)) enemyId = 'nightStalker';
          const boss = zone.danger >= 1 && chance(0.03 + d * 0.01);
          if (boss) enemyId = pick(Object.keys(BOSSES).sort());
          const count = boss ? 1 : Math.max(1, Math.round(randInt(1, 2 + d + 1) * this.encounterMul(lat, lon)));
          const cap = 3 + 3 * (Math.max(-1, zone.danger) + 1) + 2;
          const level = Math.max(1, Math.min(cap, Math.round((2 + d) * 1.5) + randInt(0, 2) + d * 2));
          out.push({
            id: `zg_${night}_${key.replace(':', '_')}_${k}`,
            cell: key,
            poiId: poi.id,
            lat,
            lon,
            enemyId,
            count,
            level: Math.round(level * (boss ? 1.2 : 1)),
            elite: !boss && zone.danger >= 0 && chance(0.05 * (2 + d)),
            boss,
            night,
          });
        }
      });
    });
    return out.slice(0, ZOMBIE_MAX_GROUPS);
  }

  /** 共用紀錄的編號（每晚、每個大格子一筆） */
  recordId(gr) {
    const lat = gr.lat;
    const lon = gr.lon;
    return `${gr.night}:${cellOf(lat, lon, SHARED_ZOMBIES.groupKm).key}`;
  }

  /** 套用其他玩家的擊倒與傷亡紀錄 */
  applyShared() {
    const map = this.game.state.map;
    if (!map?.zombieGroups?.length) return;
    let changed = false;
    map.zombieGroups = map.zombieGroups.filter((gr) => {
      if (gr.night == null) return true;
      const d = this.game.shared?.get('zk', this.recordId(gr));
      if (!d) return true;
      if (d.k?.[gr.id]) {
        changed = true;
        return false;
      }
      const left = d.c?.[gr.id];
      if (left != null && left < gr.count) {
        gr.count = Math.max(1, left);
        changed = true;
      }
      return true;
    });
    if (changed) this.game.bus.emit('map:changed');
  }

  /** 殭屍群被擊倒：從地圖移除並通知所有玩家 */
  killGroup(gr, by = '') {
    const map = this.game.state.map;
    map.zombieGroups = map.zombieGroups.filter((x) => x.id !== gr.id);
    if (gr.night == null) return null;
    const rec = this.recordId(gr);
    return this.game.shared?.update('zk', rec, (d) => {
      const data = d || { k: {}, c: {} };
      data.k = data.k || {};
      if (data.k[gr.id]) return { fail: 'done' };
      data.k[gr.id] = by || 1;
      if (data.c) delete data.c[gr.id];
      return { data };
    }, { lat: gr.lat, lon: gr.lon });
  }

  /** 殭屍群被打傷（攻擊失敗）：剩餘數量同步 */
  hurtGroup(gr, kills) {
    gr.count = Math.max(1, gr.count - kills);
    if (gr.night == null || kills <= 0) return null;
    const left = gr.count;
    return this.game.shared?.update('zk', this.recordId(gr), (d) => {
      const data = d || { k: {}, c: {} };
      data.c = data.c || {};
      if (data.k?.[gr.id]) return { fail: 'done' };
      data.c[gr.id] = Math.min(data.c[gr.id] ?? left, left);
      return { data };
    }, { lat: gr.lat, lon: gr.lon });
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

  /** 建築內遭遇的殭屍等級：夜晚等級＋高危險區的額外等級（上限也一起提高） */
  buildingLevel(poi, phase) {
    const z = zoneAt(poi.lat, poi.lon);
    const extra = BUILDING_ZONE.extraLevel[Math.min(3, Math.max(-1, z.danger || 0))] || 0;
    const base = this.areaLevel(poi) + extra;
    const bonus = phase?.zombies ? Math.round(Math.max(0, phase.danger - 1) * 2 * (1 + Math.max(0, z.danger))) : 0;
    // 白天：高危區的殭屍等級加成（上限一起提高）
    const day = phase && !phase.zombies ? DAY_ZONE.level[z.id] || 0 : 0;
    return Math.max(1, Math.min(base + bonus + day, this.zoneLevelCap(poi.lat, poi.lon, phase) + extra + day));
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

  /** 夜晚地圖殭屍群的強度：一般、精英、Boss 依序更強，夜晚更危險的區域再加強 */
  groupMul(g) {
    const poi = this.game.state.map.pois.find((p) => p.id === g.poiId);
    const z = poi ? zoneAt(poi.lat, poi.lon) : { danger: 0 };
    const night = { hp: NIGHT_MUL.hp + NIGHT_MUL.perDanger * Math.max(0, z.danger), atk: NIGHT_MUL.atk + NIGHT_MUL.perDanger * Math.max(0, z.danger) };
    return mulOf(ZOMBIE_VS_SURVIVOR, night, MAP_GROUP_MUL[g.boss ? 'boss' : g.elite ? 'elite' : 'normal']);
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

    const enemies = Array.from({ length: g.count }, () => this.game.combat.createEnemy(g.enemyId, g.level, g.elite, this.groupMul(g)));
    const firstStrike = this.game.shelter.primary().facilities.watchtower.level * 0.04;
    const result = this.game.combat.simulate(members, enemies, { firstStrikeBonus: firstStrike, title: `🧟 攻擊 ${this.groupLabel(g)}` });
    this.game.combat.applyOutcome(members, result, at);

    const loot = { items: [] };
    if (result.victory) {
      this.game.state.stats.battlesWon += 1;
      this.killGroup(g, this.game.state.player.name);
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
      // Boss 額外掉落：多件裝備與多種高階材料
      if (g.boss) {
        const extra = randInt(1, 2);
        for (let i = 0; i < extra; i += 1) {
          const it = this.game.equipment.generate({ level: g.level, boost: 0.4 + (poi ? zoneAt(poi.lat, poi.lon).rarityBoost : 0), minRarity: 'uncommon' });
          if (this.game.equipment.addItem(it, 'Boss')) loot.items.push(it);
        }
      }
      // 殭屍身上的零碎物品：少量零件與布料（Boss 掉落多種高階材料與藥品）
      const mats = { scrap: randInt(0, 2) * g.count, coarse: randInt(0, 1) * g.count, ...(chance(0.15) ? { bandage: 1 } : {}) };
      if (g.boss) {
        const pool = SUPPLY_KEYS.filter((k) => ['part', 'fabric', 'med'].includes(SUPPLIES[k].cat) && SUPPLIES[k].tier >= 2);
        for (let i = 0; i < randInt(4, 6); i += 1) {
          const k = pick(pool);
          mats[k] = (mats[k] || 0) + (SUPPLIES[k].cat === 'med' ? randInt(1, 2) : randInt(3, 8));
        }
      }
      loot.resources = this.game.grant(mats);
    } else {
      this.game.state.stats.battlesLost += 1;
      this.hurtGroup(g, result.kills.length);
    }
    return { ok: true, result, loot, group: g };
  }
}
