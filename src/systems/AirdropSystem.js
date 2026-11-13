import {
  AIRDROP, AIRDROP_ZONE, AIRDROP_AMOUNT, AIRDROP_GUARD_MIX, AIRDROP_FABRIC_MUL,
} from '../config/airdrops.js';
import { SUPPLIES, SUPPLY_KEYS } from '../config/supplies.js';
import { RARITY_ORDER } from '../config/equipment.js';
import { zoneAt } from '../config/zones.js';
import { inWorld } from '../config/world.js';
import { seeded, cellOf } from '../multiplayer/worldGrid.js';
import { generateWorldPois } from '../map/WorldGen.js';
import {
  chance, randFloat, randInt, weightedPick, uid, haversine,
} from '../utils/math.js';
import { baseSupplyWeight } from './LootStock.js';
import { WorldEventSystem } from './WorldEventSystem.js';

/**
 * v15.19：全服空投。位置、時間、內容與守衛都由「輪次＋格子」決定，所有玩家相同；
 * 誰搶走寫在共用資料（種類 ad，先到先得）。降落後一段時間沒人搶走，視為被 NPC 勢力拿走。
 */
export class AirdropSystem {
  constructor(game) {
    this.game = game;
    this.slotCache = new Map();
    game.shared?.watch(AIRDROP.kind, 5);
  }

  /** 有建築的格子（地圖固定，第一次用到時計算）：{ key, pois } */
  cells() {
    if (this.cellList) return this.cellList;
    // 用固定世界地圖的建築（所有玩家相同；不含存檔裡保留的舊地點）
    const pois = AirdropSystem.worldPois || (AirdropSystem.worldPois = generateWorldPois());
    const km = AIRDROP.cellKm;
    const map = new Map();
    pois.filter((p) => inWorld(p.lat, p.lon)).forEach((p) => {
      const k = cellOf(p.lat, p.lon, km).key;
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(p);
    });
    this.cellList = [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, list]) => ({ key, pois: list.sort((x, y) => String(x.id).localeCompare(String(y.id))) }));
    return this.cellList;
  }

  static slotOf(t) {
    return Math.floor(t / AIRDROP.slotMs);
  }

  /** 某一輪的全部空投（決定性） */
  slotDrops(slot) {
    if (this.slotCache.has(slot)) return this.slotCache.get(slot);
    const t0 = slot * AIRDROP.slotMs;
    // 補給日：空投機率加倍
    const p = Math.min(0.9, AIRDROP.chance * WorldEventSystem.fx('drop', t0));
    const out = [];
    this.cells().forEach(({ key, pois }) => {
      seeded(`ad:${slot}:${key}`, () => {
        if (!chance(p)) return;
        // 落在格子內某棟建築附近（約 60 公尺內），一定在地圖上
        const base = pois[randInt(0, pois.length - 1)];
        let lat = base.lat + randFloat(-0.0005, 0.0005);
        let lon = base.lon + randFloat(-0.0006, 0.0006);
        if (!inWorld(lat, lon)) { lat = base.lat; lon = base.lon; }
        const zone = zoneAt(lat, lon).id;
        const Z = AIRDROP_ZONE[zone] || AIRDROP_ZONE.safe;
        const landAt = t0 + AIRDROP.announceMs + randFloat(0, AIRDROP.slotMs - AIRDROP.stayMs - AIRDROP.announceMs);
        const mats = {};
        for (let k = 0; k < Z.kinds; k += 1) {
          const tier = randInt(Z.tiers[0], Z.tiers[1]);
          const cat = chance(0.65) ? 'part' : 'fabric';
          const keys = SUPPLY_KEYS.filter((s) => SUPPLIES[s].cat === cat && SUPPLIES[s].tier === tier && SUPPLIES[s].tag !== 'ammo').sort();
          if (!keys.length) continue;
          const sk = weightedPick(Object.fromEntries(keys.map((s) => [s, baseSupplyWeight(s)])));
          const n = Math.max(1, Math.round(AIRDROP_AMOUNT[tier] * (cat === 'fabric' ? AIRDROP_FABRIC_MUL[tier] ?? 1 : 1) * Z.mul * randFloat(0.8, 1.2)));
          mats[sk] = (mats[sk] || 0) + n;
        }
        out.push({
          id: `ad_${slot}_${key.replace(':', '_')}`, slot, lat, lon, zone,
          announceAt: landAt - AIRDROP.announceMs, landAt, expireAt: landAt + AIRDROP.stayMs,
          npcAt: landAt + randInt(AIRDROP.npcMin[0], AIRDROP.npcMin[1]) * 60000,
          mats, coins: randInt(Z.coins[0], Z.coins[1]), parts: randInt(Z.parts[0], Z.parts[1]), bp: chance(Z.bp),
        });
      });
    });
    if (this.slotCache.size > 12) this.slotCache.clear();
    this.slotCache.set(slot, out);
    return out;
  }

  /** 地圖上目前看得到的空投（預告中、已降落、剛被搶走）：前一輪與這一輪 */
  list(now = Date.now()) {
    const s = AirdropSystem.slotOf(now);
    return [...this.slotDrops(s - 1), ...this.slotDrops(s)].filter((d) => now >= d.announceAt && now < d.expireAt);
  }

  get(id, now = Date.now()) {
    const m = String(id).match(/^ad_(-?\d+)_/);
    if (!m) return null;
    return this.slotDrops(Number(m[1])).find((d) => d.id === id) || null;
  }

  /** 狀態：falling（預告中）、landed（可以搶）、taken（被玩家搶走）、npc（被 NPC 勢力拿走）、gone（消失） */
  status(d, now = Date.now()) {
    if (!d) return { state: 'gone' };
    const rec = this.game.shared?.get(AIRDROP.kind, d.id);
    if (rec?.by) return { state: 'taken', by: rec.by, at: rec.at };
    if (now >= d.expireAt) return { state: 'gone' };
    if (now >= d.npcAt) return { state: 'npc' };
    if (now < d.landAt) return { state: 'falling' };
    return { state: 'landed' };
  }

  zoneOf(d) {
    return AIRDROP_ZONE[d.zone] || AIRDROP_ZONE.safe;
  }

  /** 守衛殭屍（強度依區域） */
  guards(d) {
    const G = this.zoneOf(d).guard;
    return Array.from({ length: G.n }, (_, i) => this.game.combat.createEnemy(AIRDROP_GUARD_MIX[i % AIRDROP_GUARD_MIX.length], G.lv, false, { hp: G.mul, atk: G.mul }));
  }

  /** 顯示用：距離與步行時間 */
  distanceTo(d) {
    const sh = this.game.shelter.primary();
    return sh ? Math.round(haversine(sh.lat, sh.lon, d.lat, d.lon)) : 0;
  }

  /** 打贏後拿到的東西（設計圖在搶到時才產生） */
  loot(d) {
    const Z = this.zoneOf(d);
    const blueprints = [];
    if (d.bp) {
      const lv = Z.guard.lv;
      const bp = this.game.equipment.makeBlueprint(lv);
      if (Z.bpMin && RARITY_ORDER.indexOf(bp.rarity) < RARITY_ORDER.indexOf(Z.bpMin)) bp.rarity = Z.bpMin;
      blueprints.push(bp);
    }
    return {
      gained: { ...d.mats, coins: d.coins, parts: d.parts }, items: [], blueprints,
    };
  }

  /** 搶走空投（先到先得）：成功回傳 true */
  async claim(d, name, now = Date.now()) {
    const r = await this.game.shared.update(AIRDROP.kind, d.id, (cur) => {
      if (cur?.by) return { fail: `已經被「${cur.by}」搶走了` };
      if (now >= d.npcAt) return { fail: '已經被 NPC 勢力拿走了' };
      return { data: { by: name, at: now } };
    }, { lat: null, lon: null }).catch((e) => ({ ok: false, reason: e?.message || '連線失敗' }));
    return r;
  }

  /** 集結戰鬥用的目標資訊 */
  asTarget(d) {
    return d && { kind: AIRDROP.kind, id: d.id, name: `📦 空投（${zoneAt(d.lat, d.lon).name}）`, lat: d.lat, lon: d.lon };
  }

  /** 唯一編號（報告用） */
  static reportId() {
    return uid('rp');
  }
}
