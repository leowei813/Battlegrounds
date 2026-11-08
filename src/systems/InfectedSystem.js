import { unitPower } from '../utils/math.js';
import { BOSSES, ALL_ENEMIES, ZOMBIE_VS_SURVIVOR } from '../config/enemies.js';
import { SUPPLIES, SUPPLY_KEYS } from '../config/supplies.js';
import { zoneAt } from '../config/zones.js';
import { DAY_REAL_MS } from '../config/constants.js';
import {
  randInt, randFloat, pick, chance, uid, haversine,
} from '../utils/math.js';
import { seeded, cellBox } from '../multiplayer/worldGrid.js';
import { gridCenter } from '../config/world.js';

/**
 * 重度感染據點：v13 起固定 5 座（位置見 INFECTED.sites），所有玩家共用（位置、強度、淨化度相同）。
 *  - 守軍是 Boss、精英與大量殭屍；一支隊伍很難單獨清除，淨化度會累積（未清除時緩慢回復感染）。
 *  - 每場戰鬥打到全員倒下或淨化 100%。
 *  - 每場依推進的淨化度給少量獎勵；淨化 100% 時消滅據點：依最後一場的參戰人數發放大獎勵（1 人 6～8 種，每多 1 人上下限 +4，最低精良品級）。
 *  - 被消滅後 3 天（現實時間）在原地重新出現；未被消滅時淨化度每天 12:00 歸零。
 */
export const INFECTED = {
  /** 每格約 2 平方公里 */
  cellKm: Math.SQRT2,
  /** 顯示與同步範圍（公里） */
  km: 3.5,
  /** 未清除時每小時回復的感染（淨化度 %） */
  decayPerHour: 3,
  /** 淨化度每天重置的時間（世界時間）；未被消滅時每天 12:00 淨化度歸零 */
  refreshHour: 12,
  /** v13：被消滅後幾天（現實天數）在原地重新出現 */
  respawnDays: 3,
  /**
   * v13：固定位置（格線代號見 config/world.js）。E4 沿用原本的據點（位置、名稱、強度不變）。
   * key 同時是共用資料的編號。
   */
  sites: [
    { code: 'E4', key: '1970:8670', cell: [1970, 8670] },
    { code: 'B2', key: 'fx:B2' },
    { code: 'E7', key: 'fx:E7' },
    { code: 'B6', key: 'fx:B6' },
    { code: 'F2', key: 'fx:F2' },
  ],
  /** 守軍組成 */
  roster: { boss: 2, elite: 12, normal: 48 },
  /** 守軍強度倍率（v10.9：生命 ×2、攻擊 ×1.5，強隊約需 2～5 場或多人累積才能消滅） */
  mul: { hp: 5.2, atk: 2.85 },
  bossMul: { hp: 8, atk: 3.3 },
  /** 與玩家據點警戒範圍至少保持的距離（公尺） */
  clearM: 120,
  /** 圖示大小（比巨型據點略大） */
  pin: 48,
  /** 每場依推進的淨化度給的獎勵：每 10% 一份 */
  perFight: { coinsPer10: 150, matMin: 4, matMax: 8, gearChance: 0.2 },
  /** 消滅時的獎勵：種類 ×2、材料數量 ×3、金錢 ×3，裝備最低精良，有機率多一張設計圖 */
  kill: { kindsMul: 2, matMul: 3, coinsMul: 3, minRarity: 'rare', blueprintChance: 0.3 },
};

const NAMES = ['腐化醫院', '屍巢', '感染源', '黑霧區', '變異溫床', '血肉工廠', '哀嚎迷宮', '孢子塔'];

export class InfectedSystem {
  constructor(game) {
    this.game = game;
    game.shared?.watch('inf', INFECTED.km + INFECTED.cellKm);
  }

  /** 世代：每天 12:00 換一次 */
  siteDay(now = Date.now()) {
    return Math.floor((this.game.time.totalHours(now) - INFECTED.refreshHour) / 24);
  }

  /** 下一次重生（12:00）的現實時間 */
  nextRefresh(now = Date.now()) {
    const h = this.game.time.totalHours(now) - INFECTED.refreshHour;
    const left = (Math.floor(h / 24) + 1) * 24 - h;
    return now + (left / 24) * DAY_REAL_MS;
  }

  /** 某個固定據點的位置：E4 沿用舊格子算出的位置，其他在格線中心 */
  spotOf(def) {
    if (def.cell) {
      const [i, j] = def.cell;
      const box = cellBox(i, j, INFECTED.cellKm);
      return seeded(`inf:${def.key}`, () => ({
        lat: box.lat0 + box.dLat * randFloat(0.15, 0.85),
        lon: box.lon0 + box.dLon * randFloat(0.15, 0.85),
      }));
    }
    return gridCenter(def.code);
  }

  /** 固定據點的資料（名稱、等級、首領依種子決定，所有玩家相同） */
  siteOf(def) {
    const spot = this.spotOf(def);
    return seeded(`inf:${def.key}`, () => {
      randFloat(0, 1);
      randFloat(0, 1);
      const { lat, lon } = spot;
      const zone = zoneAt(lat, lon);
      const d = Math.max(0, zone.danger);
      return {
        id: `inf_${def.key.replace(':', '_')}`, cell: def.key, code: def.code, lat, lon,
        name: pick(NAMES), level: randInt(18, 24) + d * 3, bossId: pick(Object.keys(BOSSES).sort()),
      };
    });
  }

  /** 全部固定據點（含已被消滅、等待重生的） */
  sites() {
    if (!this.siteCache) this.siteCache = INFECTED.sites.map((def) => this.siteOf(def));
    return this.siteCache;
  }

  /**
   * 在 poi 建立據點會不會跟重度感染據點重疊（含新據點的警戒範圍）。
   * @param {number} alertM 新據點的警戒範圍（公尺）
   * @returns {{name:string}|null} 重疊的感染據點
   */
  blocking(poi, alertM = 80) {
    if (!poi || !Number.isFinite(poi.lat)) return null;
    const r = alertM + INFECTED.clearM;
    return this.sites().find((s) => haversine(poi.lat, poi.lon, s.lat, s.lon) <= r) || null;
  }

  /** 地圖上的重度感染據點（被消滅等待重生的不顯示） */
  list(now = Date.now()) {
    const day = this.siteDay(now);
    return this.sites()
      .map((s) => ({ ...s, day, purity: this.purity(s, now), cleared: this.cleared(s, now) }))
      .filter((s) => !s.cleared);
  }

  get(id, now = Date.now()) {
    return this.list(now).find((s) => s.id === id) || null;
  }

  /** 依編號找回據點（被消滅等待重生時回傳 null） */
  byId(id, now = Date.now()) {
    const s = this.sites().find((x) => x.id === id);
    if (!s || this.cleared(s, now)) return null;
    return { ...s, day: this.siteDay(now), purity: this.purity(s, now), cleared: false };
  }

  /** 依編號找固定據點（不論是否被消滅） */
  siteById(id) {
    return this.sites().find((x) => x.id === id) || null;
  }

  /** 被消滅後重新出現的時間（沒被消滅回傳 0） */
  respawnAt(s) {
    const d = this.shared(s);
    return d?.killedAt ? d.killedAt + INFECTED.respawnDays * 86400000 : 0;
  }

  /** 讓探索系統把據點當成目的地 */
  asPoi(id) {
    const s = this.get(id);
    return s && {
      id: s.id, name: `☣️ ${s.name}`, lat: s.lat, lon: s.lon, type: 'hospital', icon: '☣️', infected: true,
    };
  }

  shared(s) {
    return this.game.shared?.get('inf', s.cell) || null;
  }

  /** 是否已被消滅、還在等待重生（v13：消滅後 3 天在原地重新出現） */
  cleared(s, now = Date.now()) {
    const t = this.respawnAt(s);
    return t > 0 && now < t;
  }

  /** 目前淨化度（%）：未清除時隨時間緩慢回復感染 */
  purity(s, now = Date.now()) {
    const d = this.shared(s);
    if (!d || d.day !== this.siteDay(now)) return 0;
    if (d.killedAt && now >= d.killedAt + INFECTED.respawnDays * 86400000) return 0; // 重生後重新計算
    return InfectedSystem.decayed(d, now);
  }

  static decayed(d, now) {
    return Math.max(0, Math.min(100, (d.pur || 0) - (INFECTED.decayPerHour * Math.max(0, now - (d.at || now))) / 3600000));
  }

  static otherBoss(id) {
    const keys = Object.keys(BOSSES).sort();
    return keys[(keys.indexOf(id) + 1) % keys.length];
  }

  /** 守軍（依淨化度扣除已清除的部分：先清一般殭屍，再來精英，最後 Boss） */
  roster(s, purity = this.purity(s)) {
    const cb = this.game.combat;
    const r = INFECTED.roster;
    const mul = { hp: INFECTED.mul.hp, atk: ZOMBIE_VS_SURVIVOR.atk * INFECTED.mul.atk };
    const list = [
      ...Array.from({ length: r.normal }, (_, k) => cb.createEnemy(['walker', 'infected', 'berserker', 'mutant'][k % 4], s.level, false, mul)),
      ...Array.from({ length: r.elite }, (_, k) => cb.createEnemy(['berserker', 'mutant', 'nightStalker'][k % 3], s.level, true, mul)),
      ...Array.from({ length: r.boss }, (_, k) => cb.createEnemy(k ? InfectedSystem.otherBoss(s.bossId) : s.bossId, s.level + 3, false, INFECTED.bossMul)),
    ];
    const total = list.reduce((sum, e) => sum + e.maxHp, 0);
    let gone = (total * purity) / 100;
    const left = [];
    list.forEach((e) => {
      if (gone >= e.maxHp) {
        gone -= e.maxHp;
        return;
      }
      if (gone > 0) {
        e.maxHp = Math.max(1, Math.round(e.maxHp - gone));
        e.hp = e.maxHp;
        gone = 0;
      }
      left.push(e);
    });
    return { list: left, total };
  }

  /** 依偵查等級可得知的情報 */
  intelView(s) {
    const lv = this.game.research.level('s_recon');
    const r = INFECTED.roster;
    return {
      lv,
      boss: lv >= 1 ? ALL_ENEMIES[s.bossId]?.name : null,
      level: lv >= 3 ? `Lv${s.level}` : lv >= 1 ? `Lv${Math.floor(s.level / 10) * 10}+` : 'Lv?',
      roster: lv >= 3 ? `Boss ${r.boss}・精英 ${r.elite}・殭屍 ${r.normal}` : null,
      power: lv >= 6 ? Math.round(this.roster(s, 0).list.reduce((sum, e) => sum + unitPower(e), 0)) : null,
      decay: lv >= 2 ? INFECTED.decayPerHour : null,
    };
  }

  /**
   * 一場戰鬥（自己的倖存者＋其他玩家的隊員 allies）。
   * @returns {{result:object, gain:number, before:number}}
   */
  battle(s, members, allies = [], at = Date.now(), extra = {}) {
    const g = this.game;
    const before = this.purity(s, at);
    const { list, total } = this.roster(s, before);
    const hp0 = list.reduce((sum, e) => sum + e.maxHp, 0);
    const result = g.combat.simulate(members, list, { allies, title: `☣️ 淨化「${s.name}」`, ...extra });
    const hp1 = result.enemies.reduce((sum, e) => sum + e.hp, 0);
    const gain = result.victory ? 100 - before : Math.max(0, ((hp0 - hp1) / total) * 100);
    return { result, gain, before };
  }

  /**
   * 寫入淨化度（先到先得）：達到 100% 的那一位負責發獎勵。
   * @returns {Promise<{ok:boolean, purity:number, killed:boolean}>}
   */
  async addPurity(s, gain, at = Date.now()) {
    const day = this.siteDay(at);
    const r = await this.game.shared.update('inf', s.cell, (d) => {
      const respawn = d?.killedAt ? d.killedAt + INFECTED.respawnDays * 86400000 : 0;
      if (respawn && at < respawn) return { fail: '已經被消滅了' };
      // 新的一天（12:00）或重生後：淨化度從 0 開始
      const data = d && d.day === day && !respawn ? d : { day, pur: 0, at };
      const cur = InfectedSystem.decayed(data, at);
      data.pur = Math.min(100, cur + gain);
      data.at = at;
      let killed = false;
      if (data.pur >= 99.95) {
        data.pur = 100;
        data.killedDay = day;
        data.killedAt = at;
        killed = true;
      }
      return { data, result: { purity: data.pur, killed } };
    }, { lat: s.lat, lon: s.lon });
    if (!r.ok) return { ok: false, reason: r.reason, purity: this.purity(s, at), killed: false };
    return { ok: true, ...r.result };
  }

  /** 消滅獎勵：1 人 6～8 種，每多 1 人上下限 +4；裝備最低精良；材料與金錢 ×3；有機率得到設計圖 */
  rewards(s, people) {
    const g = this.game;
    const K = INFECTED.kill;
    const n = Math.max(1, people);
    const kinds = randInt((3 + 2 * (n - 1)) * K.kindsMul, (4 + 2 * (n - 1)) * K.kindsMul);
    const items = [];
    const mats = {};
    const pool = SUPPLY_KEYS.filter((k) => SUPPLIES[k].tier >= 3);
    for (let i = 0; i < kinds; i += 1) {
      if (chance(0.5)) items.push(g.equipment.generate({ level: s.level, boost: 0.7, minRarity: K.minRarity }));
      else {
        const k = pick(pool);
        mats[k] = (mats[k] || 0) + (SUPPLIES[k].cat === 'med' ? randInt(2, 4) : randInt(3, 8)) * K.matMul;
      }
    }
    const blueprints = chance(K.blueprintChance) ? [g.equipment.makeBlueprint(s.level)] : [];
    return { items, mats, blueprints, coins: randInt(200, 400) * n * K.coinsMul };
  }

  /** 每場依推進的淨化度給的少量獎勵：每 10% 一份（不足 10% 的部分依比例機率） */
  fightRewards(s, gain) {
    const g = this.game;
    const P = INFECTED.perFight;
    const parts = Math.floor(gain / 10) + (chance((gain % 10) / 10) ? 1 : 0);
    const items = [];
    const mats = {};
    const pool = SUPPLY_KEYS.filter((k) => SUPPLIES[k].tier >= 3 && SUPPLIES[k].cat !== 'ammo');
    for (let i = 0; i < parts; i += 1) {
      const k = pick(pool);
      mats[k] = (mats[k] || 0) + (SUPPLIES[k].cat === 'med' ? Math.ceil(randInt(P.matMin, P.matMax) / 2) : randInt(P.matMin, P.matMax));
      if (chance(P.gearChance)) items.push(g.equipment.generate({ level: s.level, boost: 0.5, minRarity: 'rare' }));
    }
    return { items, mats, blueprints: [], coins: Math.round(P.coinsPer10 * (gain / 10)) };
  }

  /** 把獎勵交給自己 */
  grantRewards(rw, source = '重度感染據點') {
    const g = this.game;
    rw.items.forEach((it) => g.equipment.addItem(it, source));
    if (rw.blueprints?.length) g.state.inventory.blueprints.push(...rw.blueprints);
    const got = g.grant({ ...rw.mats, coins: rw.coins });
    return got;
  }

  /** 獎勵補進探索報告 */
  addToReport(report, rw, got) {
    Object.entries(got || {}).forEach(([k, v]) => { if (v > 0) report.resources[k] = (report.resources[k] || 0) + v; });
    report.items = [...(report.items || []), ...rw.items];
    report.blueprints = [...(report.blueprints || []), ...(rw.blueprints || [])];
  }

  /** 探索系統結算「淨化重度感染據點」 */
  resolveAttack(exp) {
    const g = this.game;
    const at = exp.endAt;
    const s = this.get(exp.poiId, at) || this.list(at).find((x) => x.id === exp.poiId);
    const members = exp.memberIds.map((id) => g.survivors.get(id)).filter(Boolean);
    const report = {
      id: uid('rp'), poiName: s ? `☣️ ${s.name}` : '重度感染據點', poiType: 'hospital', at,
      events: [...(exp.travelEvents || [])], resources: {}, items: [], blueprints: [],
      kills: exp.travelKills || 0, xp: exp.travelXp || 0, success: false, members: members.map((m) => m.name),
    };
    if (!s || !members.length) {
      report.events.push('🏚️ 抵達時據點已經被淨化了。');
      return report;
    }
    const { result, gain, before } = this.battle(s, members, [], at);
    g.combat.applyOutcome(members, result, at);
    report.kills += result.kills.length;
    report.xp += result.xp;
    report.events.push(`☣️ 與「${s.name}」的守軍激戰 ${Math.round(result.duration)} 秒：淨化度 ${before.toFixed(1)}% → ${Math.min(100, before + gain).toFixed(1)}%`);
    report.success = gain > 0;
    const people = members.length;
    this.addPurity(s, gain, at).then((r) => {
      if (!r.ok) {
        report.events.push(`⚠️ 淨化度沒有寫入（${r.reason || '連線失敗'}），這一場不計入`);
        g.bus.emit('expedition:done', { reports: [] });
        return;
      }
      // 這一場推進的淨化度：每 10% 一份少量獎勵（獎勵在寫入淨化度之後才決定，補進這一場的探索報告）
      const fr = this.fightRewards(s, gain);
      if (fr.coins > 0 || fr.items.length || Object.keys(fr.mats).length) {
        this.addToReport(report, fr, this.grantRewards(fr));
        report.events.push(`☣️ 淨化獎勵（+${gain.toFixed(1)}%）：💰${fr.coins}、${Object.keys(fr.mats).length} 種高階材料${fr.items.length ? `、${fr.items.length} 件裝備` : ''}`);
      }
      if (r.killed) {
        const rw = this.rewards(s, people);
        this.addToReport(report, rw, this.grantRewards(rw));
        const lockN = g.rebirth?.infectDrop(people) || 0;
        if (lockN) {
          g.rebirth.addLocks(lockN);
          report.locks = lockN;
          report.events.push(`🔒 在感染源深處找到「就是要鎖你」×${lockN}`);
        }
        report.events.push(`🏆 消滅「${s.name}」！獲得 ${rw.items.length} 件裝備、${Object.keys(rw.mats).length} 種高階材料、💰${rw.coins}${rw.blueprints.length ? '、1 張設計圖' : ''}`);
        g.log(`🏆 消滅重度感染據點「${s.name}」！獲得 ${rw.items.length} 件裝備、${Object.keys(rw.mats).length} 種高階材料與 💰${rw.coins}`, 'success');
        g.toast(`🏆 消滅重度感染據點「${s.name}」！`, 'success');
      }
      g.requestSave?.();
      g.bus.emit('npcs:changed');
      g.bus.emit('expedition:done', { reports: [] });
    });
    return report;
  }
}
