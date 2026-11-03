import { BOSSES, ALL_ENEMIES, ZOMBIE_VS_SURVIVOR } from '../config/enemies.js';
import { SUPPLIES, SUPPLY_KEYS } from '../config/supplies.js';
import { zoneAt } from '../config/zones.js';
import { DAY_REAL_MS } from '../config/constants.js';
import {
  randInt, randFloat, pick, chance, uid, haversine,
} from '../utils/math.js';
import { seeded, cellOf, cellBox, cellsAround } from '../multiplayer/worldGrid.js';

/**
 * 重度感染據點：每 2 平方公里一座，所有玩家共用（位置、強度、淨化度相同）。
 *  - 守軍是 Boss、精英與大量殭屍；一支隊伍很難單獨清除，淨化度會累積（未清除時緩慢回復感染）。
 *  - 每場戰鬥打到全員倒下或淨化 100%。
 *  - 淨化 100% 時消滅據點：依最後一場的參戰人數發放獎勵（1 人 3～4 種，每多 1 人上下限 +2，最低優良品級）。
 *  - 被消滅後在下一個中午 12:00（世界時間）重新出現。
 */
export const INFECTED = {
  /** 每格約 2 平方公里 */
  cellKm: Math.SQRT2,
  /** 顯示與同步範圍（公里） */
  km: 3.5,
  /** 未清除時每小時回復的感染（淨化度 %） */
  decayPerHour: 3,
  /** 每天重生的時間（世界時間） */
  refreshHour: 12,
  /** 守軍組成 */
  roster: { boss: 2, elite: 12, normal: 48 },
  /** 守軍強度倍率 */
  mul: { hp: 2.6, atk: 1.9 },
  bossMul: { hp: 4, atk: 2.2 },
  /** 圖示大小（比巨型據點略大） */
  pin: 48,
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

  /** 某一格的據點（固定位置與強度） */
  siteAt(i, j, key) {
    const box = cellBox(i, j, INFECTED.cellKm);
    return seeded(`inf:${key}`, () => {
      const lat = box.lat0 + box.dLat * randFloat(0.15, 0.85);
      const lon = box.lon0 + box.dLon * randFloat(0.15, 0.85);
      const zone = zoneAt(lat, lon);
      const d = Math.max(0, zone.danger);
      return {
        id: `inf_${key.replace(':', '_')}`, cell: key, lat, lon,
        name: pick(NAMES), level: randInt(18, 24) + d * 3, bossId: pick(Object.keys(BOSSES).sort()),
      };
    });
  }

  /** 避難所附近的重度感染據點（被消滅等待重生的不顯示） */
  list(now = Date.now()) {
    const g = this.game;
    const c = g.shelter.primary() || g.state.map?.center;
    if (!c || !g.state.map?.pois?.length) return [];
    const cells = new Set(g.state.map.pois.map((p) => cellOf(p.lat, p.lon, INFECTED.cellKm).key));
    const day = this.siteDay(now);
    return cellsAround(c.lat, c.lon, INFECTED.cellKm, INFECTED.km)
      .filter(({ key }) => cells.has(key))
      .map(({ i, j, key }) => this.siteAt(i, j, key))
      .filter((s) => haversine(c.lat, c.lon, s.lat, s.lon) <= INFECTED.km * 1000)
      .map((s) => ({ ...s, day, purity: this.purity(s, now), cleared: this.cleared(s, now) }))
      .filter((s) => !s.cleared);
  }

  get(id, now = Date.now()) {
    return this.list(now).find((s) => s.id === id) || null;
  }

  /** 依編號找回據點（不在自己附近時也能重建，例如集結時） */
  byId(id, now = Date.now()) {
    const m = /^inf_(-?\d+)_(-?\d+)$/.exec(String(id));
    if (!m) return null;
    const key = `${m[1]}:${m[2]}`;
    const s = this.siteAt(Number(m[1]), Number(m[2]), key);
    if (this.cleared(s, now)) return null;
    return { ...s, day: this.siteDay(now), purity: this.purity(s, now), cleared: false };
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

  /** 今天是否已被消滅 */
  cleared(s, now = Date.now()) {
    const d = this.shared(s);
    return !!d && d.killedDay === this.siteDay(now);
  }

  /** 目前淨化度（%）：未清除時隨時間緩慢回復感染 */
  purity(s, now = Date.now()) {
    const d = this.shared(s);
    if (!d || d.day !== this.siteDay(now)) return 0;
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
      power: lv >= 6 ? Math.round(this.roster(s, 0).list.reduce((sum, e) => sum + e.maxHp * 0.1 + e.atk, 0)) : null,
      decay: lv >= 2 ? INFECTED.decayPerHour : null,
    };
  }

  /**
   * 一場戰鬥（自己的倖存者＋其他玩家的隊員 allies）。
   * @returns {{result:object, gain:number, before:number}}
   */
  battle(s, members, allies = [], at = Date.now()) {
    const g = this.game;
    const before = this.purity(s, at);
    const { list, total } = this.roster(s, before);
    const hp0 = list.reduce((sum, e) => sum + e.maxHp, 0);
    const result = g.combat.simulate(members, list, { allies, title: `☣️ 淨化「${s.name}」` });
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
      const data = d && d.day === day ? d : { day, pur: 0, at };
      if (data.killedDay === day) return { fail: '已經被消滅了' };
      const cur = InfectedSystem.decayed(data, at);
      data.pur = Math.min(100, cur + gain);
      data.at = at;
      let killed = false;
      if (data.pur >= 99.95) {
        data.pur = 100;
        data.killedDay = day;
        killed = true;
      }
      return { data, result: { purity: data.pur, killed } };
    }, { lat: s.lat, lon: s.lon });
    if (!r.ok) return { ok: false, reason: r.reason, purity: this.purity(s, at), killed: false };
    return { ok: true, ...r.result };
  }

  /** 消滅獎勵：1 人 3～4 種，每多 1 人上下限 +2；最低優良品級 */
  rewards(s, people) {
    const g = this.game;
    const n = Math.max(1, people);
    const kinds = randInt(3 + 2 * (n - 1), 4 + 2 * (n - 1));
    const items = [];
    const mats = {};
    const pool = SUPPLY_KEYS.filter((k) => SUPPLIES[k].tier >= 3);
    for (let i = 0; i < kinds; i += 1) {
      if (chance(0.5)) items.push(g.equipment.generate({ level: s.level, boost: 0.7, minRarity: 'uncommon' }));
      else {
        const k = pick(pool);
        mats[k] = (mats[k] || 0) + (SUPPLIES[k].cat === 'med' ? randInt(2, 4) : randInt(3, 8));
      }
    }
    return { items, mats, coins: randInt(200, 400) * n };
  }

  /** 把獎勵交給自己 */
  grantRewards(rw, source = '重度感染據點') {
    const g = this.game;
    rw.items.forEach((it) => g.equipment.addItem(it, source));
    const got = g.grant({ ...rw.mats, coins: rw.coins });
    return got;
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
      if (!r.ok) return;
      if (r.killed) {
        const rw = this.rewards(s, people);
        this.grantRewards(rw);
        g.log(`🏆 消滅重度感染據點「${s.name}」！獲得 ${rw.items.length} 件裝備、${Object.keys(rw.mats).length} 種高階材料與 💰${rw.coins}`, 'success');
        g.toast(`🏆 消滅重度感染據點「${s.name}」！`, 'success');
      }
      g.bus.emit('npcs:changed');
    });
    return report;
  }
}
