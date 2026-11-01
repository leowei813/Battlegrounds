import { BASE_SIZES } from '../config/civilization.js';
import { RESOURCE_KEYS } from '../config/constants.js';
import { planRoute, crossings } from '../map/routing.js';
import { uid, chance, randFloat } from '../utils/math.js';

/** NPC 據點的警戒範圍（公尺） */
export const npcAlert = (n) => 60 + n.level;
/** 攻擊其他玩家成功時，對方損失的資源比例 */
export const PVP_LOSS = 0.1;

/**
 * 領地與外交：
 *  - 每個據點（玩家與 NPC）都有警戒範圍。
 *  - 玩家之間預設中立；攻擊後雙方敵對；可以互相提出並接受友好。NPC 一律敵對。
 *  - 探索路線預設繞開「非敵對」據點的警戒範圍；經過敵對且有駐守人員的據點範圍時會遭到攻擊。
 */
export class TerritorySystem {
  constructor(game) {
    this.game = game;
  }

  get rel() {
    return this.game.state.relations;
  }

  // ---------- 警戒範圍 ----------

  /** 自己據點的警戒範圍：依規模，探照燈每級 +3 公尺 */
  alertRadius(base) {
    return (BASE_SIZES[base.size]?.alert || 55) + base.facilities.watchtower.level * 3;
  }

  /** 自己據點的駐守人員：避難所為「防禦駐守」工作的人與瞭望塔駐守；前哨站只有瞭望塔駐守 */
  garrison(base) {
    const g = this.game;
    const list = g.state.survivors.filter((s) => s.status === 'idle' && !s.severe && (
      g.shelter.garrisonOf(s.id)?.base.id === base.id
      || (g.shelter.isPrimary(base) && s.job === 'guard' && !g.survivors.isGarrisoned(s.id))));
    const level = list.length ? Math.round(list.reduce((s, v) => s + v.level, 0) / list.length) : 1;
    return { list, count: list.length, level };
  }

  /** 與其他玩家的關係：neutral | hostile | friend（NPC 一律 hostile） */
  relation(playerId) {
    return this.rel.players[playerId]?.status || 'neutral';
  }

  /** 所有其他據點的警戒範圍 */
  zones() {
    const out = this.game.npcs.list.map((n) => ({
      id: n.id, kind: 'npc', name: n.name, baseName: n.name, lat: n.lat, lon: n.lon, r: npcAlert(n),
      relation: 'hostile', guards: this.game.npcs.garrison(n).length, level: n.level,
    }));
    (this.game.world?.others || []).forEach((p) => p.bases.forEach((b, i) => {
      out.push({
        id: `${p.id}#${i}`, kind: 'player', playerId: p.id, name: p.name, baseName: b.name, lat: b.lat, lon: b.lon,
        r: b.alert || BASE_SIZES[b.size]?.alert || 80, relation: this.relation(p.id), guards: b.guards || 0, level: b.guardLevel || 1,
        wall: b.wall || 0, dps: b.dps || 0,
      });
    }));
    return out;
  }

  /**
   * 規劃探索路線：預設繞開非敵對據點的警戒範圍；avoidHostile 時連敵對範圍也繞開。
   * @param {string[]} ignore 不需要繞開的範圍（例如攻擊目標本身）
   */
  route(from, to, { avoidHostile = false, ignore = [] } = {}) {
    const avoid = this.zones().filter((z) => !ignore.includes(z.id) && (avoidHostile || z.relation !== 'hostile'));
    return planRoute(from, to, avoid);
  }

  /** 路線會經過的「敵對且有駐守人員」的警戒範圍（依經過順序） */
  threats(path, ignore = []) {
    const zones = this.zones().filter((z) => z.relation === 'hostile' && z.guards > 0 && !ignore.includes(z.id));
    return crossings(path, zones).map(({ index, at }) => ({
      zoneId: zones[index].id, kind: zones[index].kind, name: zones[index].baseName, owner: zones[index].name,
      guards: Math.min(6, zones[index].guards), level: zones[index].level, at,
    }));
  }

  /** 駐守人員化為戰鬥中的敵人 */
  defenders(threat) {
    const n = Math.max(1, Math.min(6, threat.guards));
    return Array.from({ length: n }, (_, i) => this.game.combat.createEnemy(i === 0 && threat.kind === 'npc' ? 'raiderChief' : 'raider', threat.level));
  }

  // ---------- 攻擊其他玩家 ----------

  /** 讓探索系統把其他玩家的據點當成目的地：id = pvp:玩家ID#據點索引 */
  asPoi(id) {
    if (!String(id).startsWith('pvp:')) return null;
    const zone = this.zones().find((z) => `pvp:${z.id}` === id);
    return zone && {
      id, name: `${zone.name}・${zone.baseName}`, lat: zone.lat, lon: zone.lon, type: 'military', icon: '⚔️', pvp: true, zoneId: zone.id, playerId: zone.playerId,
    };
  }

  /** 探索系統結算「攻擊其他玩家的據點」 */
  resolvePvp(exp) {
    const g = this.game;
    const poi = this.asPoi(exp.poiId) || exp.pvpTarget;
    const members = exp.memberIds.map((id) => g.survivors.get(id)).filter(Boolean);
    const report = {
      id: uid('rp'), poiName: `⚔️ ${poi?.name || '其他玩家的據點'}`, poiType: 'military', at: exp.endAt,
      events: [...(exp.travelEvents || [])], resources: {}, items: [], blueprints: [],
      kills: exp.travelKills || 0, xp: exp.travelXp || 0, success: false, members: members.map((m) => m.name),
    };
    if (!poi || !members.length) {
      report.events.push('🏚️ 目標據點已經不在了。');
      return report;
    }
    this.setHostile(poi.playerId, poi.name.split('・')[0]);
    const zone = this.zones().find((z) => z.id === poi.zoneId) || { guards: exp.pvpGuards || 0, level: exp.pvpLevel || 1, kind: 'player', wall: 0, dps: 0 };
    let win = true;
    // 1. 先打破圍牆：期間對方的防禦設施持續射擊，被擊倒的隊員重傷
    const attackers = members.map((m) => {
      const st = g.survivors.stats(m);
      return { sv: m, maxHp: Math.max(1, g.survivors.hpOf(m)), atk: st.atk };
    });
    const as = g.combat.wallAssault(attackers, zone.wall || 0, zone.dps || 0);
    attackers.forEach((a) => {
      if (!as.alive.includes(a)) g.survivors.becomeSevere(a.sv, '在突襲中被防禦設施擊倒', exp.endAt);
      else g.survivors.setHp(a.sv, a.hp);
    });
    if (zone.wall > 0) report.events.push(`🧱 攻擊圍牆 ${as.sec} 秒（耐久 −${Math.round(as.wallLost)}）${as.killed ? `，${as.killed} 名隊員被防禦設施擊倒` : ''}`);
    const fighters = as.alive.map((a) => a.sv);
    if (zone.wall > 0 && !as.breached) {
      win = false;
      report.events.push(fighters.length ? '🧱 圍牆太堅固，久攻不下只好撤退' : '💀 隊員全被防禦設施擊倒');
    } else if (zone.guards > 0) {
      // 2. 圍牆被打破後才能和駐守人員交戰，打贏才可掠奪
      const result = g.combat.simulate(fighters, this.defenders(zone));
      g.combat.applyOutcome(fighters, result, exp.endAt);
      report.kills += result.kills.length;
      win = result.victory;
      report.events.push(`⚔️ 圍牆被打破！對方據點有 ${zone.guards} 名駐守人員迎戰`);
    } else report.events.push('🏃 圍牆被打破，對方據點沒有駐守人員');
    if (win) {
      // 搶奪：依運載量取得物資與金錢（對方會損失 10% 資源）
      const carry = exp.cargo || members.length * 40;
      const each = Math.floor(carry / RESOURCE_KEYS.length);
      const loot = Object.fromEntries(RESOURCE_KEYS.map((k) => [k, Math.round(each * randFloat(0.5, 1))]));
      report.resources = g.grant({ ...loot, coins: 30 + Math.round(zone.level * 10) });
      report.success = true;
      report.events.push(`🏆 突襲成功，搶走了物資（對方損失 ${Math.round(PVP_LOSS * 100)}% 資源）`);
    } else {
      report.events.push('💀 突襲失敗，隊伍撤退！');
    }
    this.send(poi.playerId, 'attack', { base: poi.name.split('・')[1] || '', win, lossPct: win ? PVP_LOSS : 0, wallLost: Math.round(as.wallLost) });
    g.log(`⚔️ 攻擊玩家「${poi.name}」${win ? '成功' : '失敗'}，雙方進入敵對`, win ? 'success' : 'danger');
    return report;
  }

  // ---------- 關係 ----------

  setHostile(playerId, name) {
    if (!playerId) return;
    this.rel.players[playerId] = { status: 'hostile', name, since: Date.now() };
    delete this.rel.requestsIn[playerId];
    delete this.rel.requestsOut[playerId];
    this.game.bus.emit('relations:changed');
  }

  async send(playerId, type, data = {}) {
    const w = this.game.world;
    if (!w?.provider?.worldSend) return false;
    const { id, token } = w.identity();
    try {
      await w.provider.worldSend(id, token, playerId, type, data);
      return true;
    } catch {
      return false;
    }
  }

  async requestFriend(playerId, name) {
    if (this.relation(playerId) === 'friend') return { ok: false, reason: '已經是友好關係' };
    const sent = await this.send(playerId, 'friendRequest');
    if (!sent) return { ok: false, reason: '無法送出（對方離線太久或連線失敗）' };
    // 對方先提出過：直接成為友好
    if (this.rel.requestsIn[playerId]) return this.acceptFriend(playerId, name);
    this.rel.requestsOut[playerId] = { name, at: Date.now() };
    this.game.changed();
    return { ok: true, msg: `已向「${name}」提出友好` };
  }

  async acceptFriend(playerId, name) {
    await this.send(playerId, 'friendAccept');
    this.rel.players[playerId] = { status: 'friend', name: name || this.rel.requestsIn[playerId]?.name || '', since: Date.now() };
    delete this.rel.requestsIn[playerId];
    delete this.rel.requestsOut[playerId];
    this.game.log(`🤝 與「${this.rel.players[playerId].name}」建立友好關係`, 'success');
    this.game.bus.emit('relations:changed');
    return { ok: true, msg: '已建立友好關係' };
  }

  declineFriend(playerId) {
    delete this.rel.requestsIn[playerId];
    this.game.changed();
    return { ok: true, msg: '已拒絕' };
  }

  async removeFriend(playerId) {
    await this.send(playerId, 'friendRemove');
    delete this.rel.players[playerId];
    this.game.bus.emit('relations:changed');
    return { ok: true, msg: '已解除友好，回到中立' };
  }

  /** 處理收到的事件（攻擊、友好請求…） */
  handleEvents(events = []) {
    const g = this.game;
    events.forEach((e) => {
      const name = String(e.fromName || '某位玩家').slice(0, 16);
      if (e.type === 'attack') {
        this.setHostile(e.from, name);
        const base = g.state.bases.find((b) => b.name === e.data?.base) || g.shelter.primary();
        // 圍牆被攻擊的損傷（被打破時歸零）
        const wallLost = e.data?.win ? Infinity : Math.min(g.shelter.wallMax(base), Math.max(0, Number(e.data?.wallLost) || 0));
        const wallBefore = g.shelter.wallHp(base);
        base.wallHp = Math.max(0, wallBefore - wallLost);
        if (e.data?.win) {
          const pct = Math.min(0.3, Math.max(0, Number(e.data.lossPct) || PVP_LOSS));
          const lost = {};
          RESOURCE_KEYS.forEach((k) => {
            lost[k] = Math.floor(g.shelter.exposed(k) * pct); // 地窖裡的搶不走
            g.state.resources[k] -= lost[k];
          });
          g.shelter.recordDefense({ base, attacker: `玩家「${name}」`, success: false, lost, wallLost: wallBefore - base.wallHp, note: `圍牆被打破，被搶走 ${Math.round(pct * 100)}% 資源` });
          g.log(`💀 玩家「${name}」突襲了「${e.data.base || '你的據點'}」，搶走 ${Math.round(pct * 100)}% 資源！雙方進入敵對`, 'danger');
          g.toast(`💀 玩家「${name}」突襲成功，搶走 ${Math.round(pct * 100)}% 資源！`, 'danger');
        } else {
          g.shelter.recordDefense({ base, attacker: `玩家「${name}」`, success: true, wallLost: wallBefore - base.wallHp, note: base.wallHp > 0 ? '圍牆撐住了，對方久攻不下撤退' : '圍牆被打破，駐守人員擊退了突襲' });
          g.log(`🛡️ 擊退了玩家「${name}」的突襲！雙方進入敵對`, 'success');
          g.toast(`🛡️ 擊退了玩家「${name}」的突襲`, 'success');
        }
      } else if (e.type === 'friendRequest') {
        if (this.rel.requestsOut[e.from]) {
          this.rel.players[e.from] = { status: 'friend', name, since: Date.now() };
          delete this.rel.requestsOut[e.from];
        } else {
          this.rel.requestsIn[e.from] = { name, at: e.at || Date.now() };
          g.toast(`🤝 玩家「${name}」想與你建立友好關係`, 'info');
        }
      } else if (e.type === 'friendAccept') {
        this.rel.players[e.from] = { status: 'friend', name, since: Date.now() };
        delete this.rel.requestsOut[e.from];
        g.log(`🤝 「${name}」接受了友好請求`, 'success');
      } else if (e.type === 'intercept') {
        g.intercept.handleIntercept(e);
      } else if (e.type === 'plunder') {
        g.intercept.handlePlunder(e);
      } else if (e.type === 'tradeBuy') {
        g.trade.onBuy(e.from, name, e.data);
      } else if (e.type === 'tradeEnd') {
        g.trade.onEnd(e.from, name, e.data);
      } else if (e.type === 'tradeRefund') {
        g.trade.onRefund(name, e.data);
      } else if (e.type === 'friendRemove') {
        if (this.relation(e.from) === 'friend') delete this.rel.players[e.from];
        g.log(`「${name}」解除了友好關係`, 'info');
      }
    });
    if (events.length) g.bus.emit('relations:changed');
  }

  /** 戰鬥是否成功觸發（敵對據點的駐守人員主動攻擊；有機率沒注意到） */
  noticed(threat) {
    return chance(threat.kind === 'npc' ? 0.85 : 0.75);
  }
}
