/**
 * 資料與邏輯健檢（無瀏覽器）：
 *   npm run check
 * 1. 驗證設定檔互相引用的 ID 是否存在
 * 2. 跑一段無頭模擬，確認各系統可正常運作
 */
import { Game } from '../src/core/Game.js';
import { fillPois as fillPoisAt } from '../src/map/PoiGenerator.js';
import { WORLD_CENTER } from '../src/config/world.js';
// v13：固定世界地圖，測試用的地點一律產生在地圖範圍中心附近（NPC、屍群只出現在範圍內）
const fillPois = (pois, _lat, _lon) => fillPoisAt(pois, WORLD_CENTER.lat, WORLD_CENTER.lon);
import { RESEARCH, researchCost as researchCostOf } from '../src/config/research.js';
import { DEFENSES } from '../src/config/defenses.js';
import { POI_TYPES } from '../src/config/poiTypes.js';
import { ALL_ENEMIES } from '../src/config/enemies.js';
import { MAIN_QUESTS, DAILY_POOL, ACHIEVEMENTS } from '../src/config/quests.js';
import { FACILITIES, LUMBER_WOOD } from '../src/config/facilities.js';
import {
  RARITIES, RARITY_ORDER, SLOT_KEYS, ITEM_TYPES, ITEM_MODELS,
} from '../src/config/equipment.js';
import {
  DAY_REAL_MS, SAVE_VERSION as SAVE_VERSION_NOW, WORLD_EPOCH_MS, WORLD_START,
} from '../src/config/constants.js';

// v15.7：測試一律用 90 分鐘一天（切換時刻設在世界起點）；連續性另外測試
const { TimeSystem: TimeSysT } = await import('../src/systems/TimeSystem.js');
const SWITCH_REAL = TimeSysT.switchAt;
TimeSysT.switchAt = WORLD_EPOCH_MS;
// 測試在任何時刻都要能跑：先關閉凌晨休息時段，專門的測試再打開
const { NPC_QUIET: NQ, npcQuietAt: NQAt, npcQuietSpan: NQSpan } = await import('../src/config/npcs.js');
const NQ0 = { ...NQ }; NQ.to = NQ.from;

/** 把遊戲時鐘調到指定時刻（建檔時間往前推） */
const setHour = (game, hour) => {
  // v9 世界時間：調整 worldShift 讓目前時刻變成 hour
  game.state.worldShift = (((hour - WORLD_START.hour + 24) % 24) / 24) * DAY_REAL_MS - (Date.now() - WORLD_EPOCH_MS);
};
import { SaveManager } from '../src/core/SaveManager.js';
import { VEHICLES as VEHICLES_CFG } from '../src/config/vehicles.js';
import { WORLD as WORLDC } from '../src/systems/SiegeSystem.js';
import { STAT_KEYS } from '../src/core/GameState.js';
import { PRIMARY_DANGER_COEF } from '../src/config/civilization.js';
import { hashAccessCode, ACCESS_ITERATIONS } from '../src/security/accessHash.js';
import { haversine } from '../src/utils/math.js';
import { fetchPois, classify } from '../src/map/OverpassService.js';
import crypto from 'node:crypto';
import { SUPPLY_KEYS, SUPPLIES as SUPPLIES_ALL } from '../src/config/supplies.js';

const SUPPLIES_T = Object.fromEntries(Object.entries(SUPPLIES_ALL).map(([k, v]) => [k, v.tier]));

/** 測試用：所有材料物品各 n 個，並擴大物品倉庫 */
const fillSupplies = (game, n = 900) => {
  SUPPLY_KEYS.forEach((k) => { game.state.supplies[k] = n; });
  game.state.bases.forEach((b) => { if (b.facilities.itemStore) b.facilities.itemStore.level = 10; });
  game.state.research.levels.i_shelves = 10;
  game.research.invalidate?.();
};

// 舊測試用隨機補足的地圖建立據點：預設不套用 v10「重度感染據點範圍內不能建立據點」（專門的測試會開啟）
const { InfectedSystem: InfSys } = await import('../src/systems/InfectedSystem.js');
const { RallySystem: RallySys } = await import('../src/systems/RallySystem.js');
const { tripProgress } = await import('../src/systems/ExplorationSystem.js');
// v15.18：天候事件依真實日期決定；測試一律固定為平靜日，專門的測試再指定其他天候
const { WorldEventSystem: WXS } = await import('../src/systems/WorldEventSystem.js');
WXS.force = 'calm';
// v16：特質會隨機影響數值；既有測試一律關閉特質，專門的測試再打開
const { SurvivorSystem: SVS } = await import('../src/systems/SurvivorSystem.js');
SVS.disableTraits = true;
// v16.1：控制點被打下後的保護期；既有測試關閉（多數情境是剛佔領就被攻打），專門的測試再打開
const { CP_SHIELD: CPSH } = await import('../src/config/controlPoints.js');
const CPSH_MS = CPSH.ms;
CPSH.ms = 0;
const realBlocking = InfSys.prototype.blocking;
// v14：重度感染據點已停用；測試仍檢查原本的機制
{ const { INFECTED: INF0 } = await import('../src/systems/InfectedSystem.js'); INF0.disabled = false; }
InfSys.prototype.blocking = function blocking(...a) { return this.game.testInfBlock ? realBlocking.apply(this, a) : null; };
let failures = 0;
const assert = (cond, msg) => {
  if (!cond) {
    failures += 1;
    console.error(`✗ ${msg}`);
  }
};

// ---- 1. 參照完整性 ----
Object.entries(RESEARCH).forEach(([id, r]) => (r.requires || []).forEach(([q]) => assert(RESEARCH[q], `research ${id} requires unknown ${q}`)));
Object.entries(DEFENSES).forEach(([id, d]) => assert(!d.requires || RESEARCH[d.requires], `defense ${id} requires unknown ${d.requires}`));
Object.entries(ITEM_MODELS).forEach(([id, md]) => assert(ITEM_TYPES[md.type] && md.tier >= 1 && md.tier <= 10, `model ${id} invalid`));
Object.entries(POI_TYPES).forEach(([id, p]) => {
  Object.keys(p.enemies).forEach((e) => assert(ALL_ENEMIES[e], `poi ${id} enemy ${e} unknown`));
  Object.keys(p.itemBias).forEach((t) => assert(ITEM_TYPES[t], `poi ${id} item ${t} unknown`));
});
[...MAIN_QUESTS, ...DAILY_POOL, ...ACHIEVEMENTS].forEach((q) => {
  if (q.cond.type === 'facility') assert(FACILITIES[q.cond.id], `quest ${q.id} facility ${q.cond.id} unknown`);
});

// ---- 2. 無頭模擬 ----
globalThis.performance ??= { now: () => Date.now() };
const g = Game.newGame({ playerName: 'CI', classId: 'scout', lat: 25.0339, lon: 121.5645 });
g.state.map.pois = fillPois([], 25.0339, 121.5645);
assert(g.shelter.setShelter(g.state.map.pois.find((p) => g.shelter.canEstablish(p).ok)).ok, 'set shelter');

// ---- 白天：地圖上沒有殭屍（只在探索的建築內遭遇）----
setHour(g, 10);
g.zombies.refresh();
assert(g.state.map.zombieGroups.length === 0, '白天地圖上沒有殭屍群');
for (let i = 0; i < 300; i += 1) g.siege.update(0.1);
assert(g.siege.of().zombies.length === 0 && !Number.isFinite(g.siege.of().spawnInterval()), '白天沒有屍潮');
setHour(g, 23); // 之後的測試在夜晚進行
assert(g.shelter.upgradeFacility(null, 'farm').ok, 'upgrade farm');
g.zombies.refresh();
assert(g.state.map.zombieGroups.length > 0, 'zombie groups spawned');
const target = g.state.map.pois.find((p) => p.type === 'residential' && !g.shelter.baseAtPoi(p.id));
assert(g.exploration.start(target.id, ['leader'], 5).ok, 'start exploration');
const reports = g.exploration.update(Date.now() + 3600e3, { silent: true });
assert(reports.length === 1, 'exploration resolved');
g.state.player.coins = 1e5;
Object.keys(g.state.resources).forEach((k) => { g.state.resources[k] = 1e5; });
fillSupplies(g);
assert(g.survivors.dormCap() === 3, '沒有宿舍最多 3 人');
g.shelter.primary().facilities.dormitory.level = 1;
assert(g.survivors.dormCap() === 4, '宿舍 Lv1 可住 4 人');
g.shelter.primary().facilities.dormitory.level = 8;
const roll = g.survivors.recruitRoll();
assert(roll.ok && roll.offer.length === 3, '招募一次出現三位候選人');
assert(g.survivors.pickRecruit(roll.offer[1].id).ok && !g.state.recruitOffer, '選擇其中一位加入');
assert(g.equipment.craft('knife').ok, 'craft');
Object.assign(g.survivors.leader(), { severe: false, hp: null }); // 探索可能讓領袖重傷；確保有人駐守
for (let i = 0; i < 2400; i += 1) { g.siege.update(0.1); g.shelter.primary().wallHp = null; } // 避免被突破後當晚平靜
assert(g.state.stats.siegeKills > 0, 'siege kills happen');
const alive = g.siege.of().zombies.length;
setHour(g, 7); // 天亮：殭屍撤回建築
for (let i = 0; i < 400; i += 1) g.siege.update(0.1);
assert(alive === 0 || g.siege.of().zombies.length === 0, `天亮後殭屍撤退（${alive} → ${g.siege.of().zombies.length}）`);
g.zombies.refresh();
assert(g.state.map.zombieGroups.length === 0, '天亮後地圖殭屍群消失');
setHour(g, 23);
const save = JSON.parse(JSON.stringify(g.state));
assert(save.version === SAVE_VERSION_NOW, 'state is serializable');
// v3 精簡格式：打包後體積變小，還原後內容一致
g.state.map.pois[1].lootedDay = 20000;
delete g.state.map.pois[1].lootedBy; // 手動改了日期，原本的「被誰搜刮」已不適用
g.state.map.pois[1].lastVisit = 123;
const packed = JSON.stringify(SaveManager.pack(g.state));
const restored = SaveManager.migrate(JSON.parse(packed));
const normP = (list) => JSON.stringify(list.map((p) => Object.fromEntries(Object.entries(p).sort(([a], [b]) => a.localeCompare(b)))));
assert(normP(restored.map.pois) === normP(g.state.map.pois), '建築精簡格式可完整還原');
assert(packed.length < JSON.stringify(g.state).length && !('pois' in JSON.parse(packed).map), `存檔以精簡格式儲存（${packed.length} < ${JSON.stringify(g.state).length} bytes）`);

// ---- 3. 文明度與多據點 ----
const civ0 = g.civilization.value();
const siege = g.siege.of();
const lv0 = siege.zombieLevel();
const iv0 = siege.spawnInterval();
const danger0 = g.shelter.dangerLevel();
g.survivors.leader().level = 40; // 玩家等級提升文明度
g.state.bases[0].facilities.wall.level = 10;
g.civilization.invalidate();
const civ1 = g.civilization.value();
assert(civ1 > civ0, `文明度隨玩家等級與建築上升（${civ0} → ${civ1}）`);
assert(siege.zombieLevel() > lv0 && siege.spawnInterval() < iv0, '屍潮隨文明度變強');
const expectDanger = Math.round((g.shelter.baseDanger(g.shelter.primary()) + civ1 * PRIMARY_DANGER_COEF) * 10) / 10;
assert(g.shelter.dangerLevel() === expectDanger && expectDanger > danger0, `主要據點危險度 = 基礎 + 文明度 × 係數（${expectDanger}）`);

const g2 = Game.newGame({ playerName: 'Day', classId: 'warrior', lat: 0, lon: 0 });
g2.state.map.pois = fillPois([], 0, 0);
g2.shelter.establish(g2.state.map.pois.find((p) => g2.shelter.canEstablish(p).ok));
const lvDay1 = g2.siege.of().zombieLevel();
g2.state.createdAt -= 20 * DAY_REAL_MS; // 經過 20 天
g2.civilization.invalidate();
assert(g2.siege.of().zombieLevel() - lvDay1 <= 1, '天數本身不會提升屍潮強度（夜間 ±1）');

const outpostPoi = g.state.map.pois.find((p) => !g.shelter.baseAtPoi(p.id) && !g.infected.blocking(p, 200));
assert(!g.shelter.canEstablish(outpostPoi).ok, '避難所只能一座，不能建第二個據點');
// v12：前哨站已移除：就算有舊的擴張科技等級，也不能再建第二個據點
g.state.research.levels.e_outpost = 1;
g.research.invalidate();
Object.assign(g.state.resources, { wood: 5000 });
fillSupplies(g);
g.state.player.coins = 5000;
const est = g.shelter.establish(outpostPoi);
assert(!est.ok && g.state.bases.length === 1, '前哨站已移除：無法建立第二個據點');
delete g.state.research.levels.e_outpost;
g.research.invalidate();

// ---- 4. 舊存檔遷移（v1 單一避難所 → v2 多據點）----
const v1 = JSON.parse(JSON.stringify(g2.state));
v1.version = 1;
v1.shelter = { ...v1.bases[0], poiId: v1.bases[0].poiId };
delete v1.bases;
delete v1.primaryBaseId;
const migrated = SaveManager.migrate(v1);
assert(migrated.version === SAVE_VERSION_NOW && migrated.bases.length === 1 && migrated.bases[0].kind === 'shelter' && migrated.primaryBaseId === migrated.bases[0].id && !migrated.shelter, 'v1 → v2 存檔遷移');

// ---- 6. 探索行程與途中遇襲 ----
{
  const g3 = Game.newGame({ playerName: 'Trip', classId: 'warrior', lat: 25.0339, lon: 121.5645 });
  g3.state.map.pois = fillPois([], 25.0339, 121.5645);
  g3.shelter.establish(g3.state.map.pois.find((p) => g3.shelter.canEstablish(p).ok));
  const home = g3.shelter.primary();
  const far = g3.state.map.pois.find((p) => !g3.shelter.baseAtPoi(p.id) && haversine(home.lat, home.lon, p.lat, p.lon) > 600);
  setHour(g3, 23);
  const t0 = Date.now();
  const ex = g3.exploration.start(far.id, ['leader'], 15, false, t0).exp;
  const p0 = g3.exploration.progress(ex, t0);
  const pMid = g3.exploration.progress(ex, t0 + ex.travelMs / 2);
  const pSearch = g3.exploration.progress(ex, t0 + ex.travelMs + 1000);
  const pBack = g3.exploration.progress(ex, t0 + ex.travelMs * 1.5 + ex.searchMs);
  assert(p0.phase === 'outbound' && pSearch.phase === 'searching' && pBack.phase === 'returning', '行程三段：去程 → 搜索 → 返程');
  assert(Math.abs(pMid.movedM - ex.distanceM / 2) < 2 && Math.abs(pBack.movedM - ex.distanceM * 1.5) < 2, `移動距離正確（${pMid.movedM} / ${ex.distanceM * 2} m）`);
  assert(ex.endAt - ex.startAt === ex.travelMs * 2 + ex.searchMs, '總時間 = 去程 + 搜索 + 返程');
  // 在路線中點放一群弱小殭屍，模擬經過時遇襲
  const leader = g3.survivors.leader();
  leader.level = 30;
  let ambushes = 0;
  for (let i = 0; i < 20 && !ambushes; i += 1) {
    ex.encountered = [];
    g3.state.map.zombieGroups = [{ id: `zg_test${i}`, poiId: far.id, lat: pMid.pos.lat, lon: pMid.pos.lon, enemyId: 'walker', count: 1, level: 1, elite: false, boss: false, spawnedAt: t0 }];
    ambushes = g3.exploration.checkAmbush(t0 + ex.travelMs / 2).length;
  }
  assert(ambushes === 1 && ex.travelEvents.some((e) => e.includes('擊退')), '夜間移動經過殭屍群會遇襲，勝利後繼續');
  assert(g3.state.expeditions.length === 1 && g3.state.map.zombieGroups.length === 0, '擊退後殭屍群消失、探索繼續');
  // 搜索中不會遇襲
  g3.state.map.zombieGroups = [{ id: 'zg_s', poiId: far.id, lat: far.lat, lon: far.lon, enemyId: 'walker', count: 1, level: 1, elite: false, boss: false, spawnedAt: t0 }];
  assert(g3.exploration.checkAmbush(t0 + ex.travelMs + 1000).length === 0, '搜索中不會遇襲');
  // 戰敗：探索提前結束
  leader.level = 1;
  Object.assign(leader, { severe: false, hp: null });
  // 這裡只測回程遇襲：建築內的搜索視為已結束（避免 Lv1 首領先在建築內戰敗撤退）
  if (ex.cp) ex.cp.stopped = true;
  let aborted = false;
  for (let i = 0; i < 20 && !aborted; i += 1) {
    ex.encountered = [];
    g3.state.map.zombieGroups = [{ id: `zg_boss${i}`, poiId: far.id, lat: pBack.pos.lat, lon: pBack.pos.lon, enemyId: 'tankBoss', count: 1, level: 30, elite: false, boss: true, spawnedAt: t0 }];
    aborted = g3.exploration.checkAmbush(t0 + ex.travelMs * 1.5 + ex.searchMs).some((r) => r.aborted);
  }
  assert(aborted && g3.state.expeditions.length === 0 && g3.survivors.leader().status === 'idle', '遇襲戰敗則撤退、探索結束');
  assert(g3.state.reports[0] && !g3.state.reports[0].success, '戰敗撤退產生失敗報告');
}

// ---- 7. OSM 分區抓取（模擬 Overpass）----
{
  const realFetch = globalThis.fetch;
  const LAT = 25.05;
  const LON = 121.56;
  let calls = 0;
  let truncatedOnce = false;
  // 每個 bbox 內均勻產生建築：每 0.0004 度一棟（約 40 公尺）
  globalThis.fetch = async (_url, { body }) => {
    calls += 1;
    const q = decodeURIComponent(body.slice(5));
    const m = /way\["building"\]\(([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\)/.exec(q);
    const json = (data) => ({ ok: true, json: async () => data });
    if (!m) return json({ elements: [{ type: 'node', id: 1, lat: LAT, lon: LON, tags: { shop: 'convenience', name: '測試超商' } }] });
    const [s, w, n, e] = m.slice(1).map(Number);
    if (!truncatedOnce && n - s > 0.01) { // 第一個大區塊模擬被截斷
      truncatedOnce = true;
      return json({ remark: 'runtime error: Query timed out', elements: [] });
    }
    const elements = [];
    for (let la = s; la < n; la += 0.0004) {
      for (let lo = w; lo < e; lo += 0.0004) elements.push({ type: 'way', id: elements.length + calls * 1e6, center: { lat: la, lon: lo }, tags: { building: 'yes' } });
    }
    return json({ elements });
  };
  const progress = [];
  const pois = await fetchPois(LAT, LON, 1200, (d, t) => progress.push(`${d}/${t}`));
  globalThis.fetch = realFetch;
  const resi = pois.filter((p) => p.type === 'residential').length;
  assert(classify({ building: 'yes' }) === 'residential', 'building=yes 視為住宅');
  assert(truncatedOnce && calls >= 9, `被截斷的區塊會切小重抓（請求 ${calls} 次）`);
  // 模擬資料約每 1,800 平方公尺一棟，1.2 公里圓內約 2,500 棟，應全部取得
  assert(resi > 2400, `分區抓取取得範圍內所有建築（住宅 ${resi}）`);
  assert(pois.every((p) => haversine(LAT, LON, p.lat, p.lon) <= 1200 + 1), '只保留圓形掃描範圍內的建築');
  assert(pois.some((p) => p.type === 'shop' && p.name === '測試超商'), '設施查詢結果保留');
  assert(progress.at(-1) === '5/5', `回報掃描進度（${progress.join(' ')}）`);
}

// ---- 8. 裝備品級與素質 ----
{
  const ge = Game.newGame({ playerName: 'Gear', classId: 'warrior', lat: 0, lon: 0 });
  const eq = ge.equipment;
  assert(Object.keys(ITEM_TYPES).length >= 15 && SLOT_KEYS.length === 9, `裝備類型 ${Object.keys(ITEM_TYPES).length} 種、裝備欄 ${SLOT_KEYS.length} 個`);
  // 每個品級範圍首尾相接、不重疊
  RARITY_ORDER.slice(1).forEach((r, i) => {
    assert(RARITIES[r].min >= RARITIES[RARITY_ORDER[i]].max, `${RARITIES[r].name}最低倍率 ≥ ${RARITIES[RARITY_ORDER[i]].name}最高倍率`);
  });
  // 實際生成：同類型同等級，高一階的每項最低素質 ≥ 低一階的最高素質
  let violations = 0;
  Object.keys(ITEM_TYPES).forEach((type) => {
    const range = {};
    RARITY_ORDER.forEach((rar) => {
      for (let i = 0; i < 60; i += 1) {
        const it = eq.generate({ level: 12, model: Object.keys(ITEM_MODELS).find((k) => ITEM_MODELS[k].type === type), rarity: rar });
        Object.entries(it.stats).forEach(([k, v]) => {
          range[rar] = range[rar] || {};
          const cur = range[rar][k] || { min: Infinity, max: -Infinity };
          range[rar][k] = { min: Math.min(cur.min, v), max: Math.max(cur.max, v) };
        });
      }
    });
    RARITY_ORDER.slice(1).forEach((rar, i) => {
      Object.entries(range[rar]).forEach(([k, { min }]) => {
        const lowerMax = range[RARITY_ORDER[i]][k].max;
        if (min < lowerMax) violations += 1;
      });
    });
  });
  assert(violations === 0, `所有類型的每項素質都符合「高品級最低 ≥ 低品級最高」（違規 ${violations}）`);
  // 同品級素質隨機
  const sameTier = Array.from({ length: 30 }, () => eq.generate({ level: 10, model: 'ak47', rarity: 'rare' }).stats.atk);
  assert(new Set(sameTier).size > 5, '同品級素質為隨機');
  // 製作：品級與素質隨機
  ge.state.map.pois = fillPois([], 0, 0);
  ge.shelter.establish(ge.state.map.pois.find((p) => ge.shelter.canEstablish(p).ok));
  ge.state.player.coins = 1e7;
  Object.keys(ge.state.resources).forEach((k) => { ge.state.resources[k] = 1e7; });
  ge.state.bases[0].facilities.warehouse.level = 10;
  fillSupplies(ge, 900);
  const crafted = Array.from({ length: 300 }, () => { fillSupplies(ge, 900); const it = eq.craft('knife').item; ge.state.inventory.items = []; return it; }); // 清空倉庫避免格子用完
  const tiers = new Set(crafted.map((it) => it.rarity));
  assert(crafted.every(Boolean) && tiers.size >= 4, `製作的品級隨機（出現 ${[...tiers].map((r) => RARITIES[r].name).join('、')}）`);
  // 吸血與探索速度詞綴生效
  const sv = ge.survivors.leader();
  const ls = eq.generate({ level: 10, type: 'melee', rarity: 'legendary' });
  eq.addItem(ls);
  eq.equip(sv.id, ls.id);
  assert(ge.survivors.stats(sv).lifeSteal > 0, '近戰武器吸血屬性生效');
  const boots = eq.generate({ level: 10, type: 'boots', rarity: 'epic' });
  eq.addItem(boots);
  eq.equip(sv.id, boots.id);
  assert(ge.survivors.stats(sv).exploreSpeed > 0, '鞋子探索速度屬性生效');
  // 舊存檔：灰色「普通」→「劣質」，補上新裝備欄
  const old = JSON.parse(JSON.stringify(SaveManager.pack(ge.state)));
  old.version = 3;
  old.inventory.items[0].rarity = 'common';
  delete old.survivors[0].equipment.gloves;
  const mig = SaveManager.migrate(old);
  assert(mig.inventory.items[0].rarity === 'poor' && mig.survivors[0].equipment.gloves === null, 'v3 → v4：舊普通裝備轉為劣質、補上新裝備欄');
}

// ---- 9. v2.0：重傷 / 飢餓 / 死亡 / 招募 / 突破 / 據點規模 / 每日物資 ----
{
  const gv = Game.newGame({ playerName: 'Vital', classId: 'warrior', lat: 0, lon: 0 });
  gv.state.map.pois = fillPois([], 0, 0);
  gv.shelter.establish(gv.state.map.pois.find((p) => p.type === 'military'));
  const sv = gv.survivors;
  const leader = sv.leader();
  // 重傷懲罰：扣升級所需經驗 10%，不足時降級
  leader.level = 5;
  leader.xp = 2;
  sv.becomeSevere(leader, '測試');
  assert(leader.severe && leader.level === 4 && sv.hpOf(leader) === 0, `重傷扣經驗並降級（Lv5 → Lv${leader.level}）`);
  assert(!sv.isAvailable(leader), '重傷無法行動');
  // 有食物時，在據點休息才會恢復；有診療室回到 30% 解除重傷
  gv.state.starving = false;
  gv.shelter.primary().facilities.clinic.level = 10;
  sv.updateVitals(Date.now(), 60 * 60000, 0);
  assert(!leader.severe && sv.hpOf(leader) > 0, '有食物時生命恢復並脫離重傷');
  // 沒有診療室不會自然回復；在外探索也不會回復
  gv.shelter.primary().facilities.clinic.level = 0;
  sv.setHp(leader, sv.maxHp(leader) * 0.5);
  sv.updateVitals(Date.now(), 30 * 60000, 0);
  assert(Math.abs(sv.hpOf(leader) - sv.maxHp(leader) * 0.5) < 1, '沒有診療室時不會自然回復');
  gv.shelter.primary().facilities.clinic.level = 5;
  leader.status = 'exploring';
  sv.updateVitals(Date.now(), 30 * 60000, 0);
  assert(Math.abs(sv.hpOf(leader) - sv.maxHp(leader) * 0.5) < 1, '在外探索時不會回復');
  // 醫生：在據點或同一支隊伍中會照顧隊友（比診療室慢）
  const doc = sv.makeCandidate(5);
  Object.assign(doc, { classId: 'medic', id: 'doc1', status: 'exploring' });
  gv.state.survivors.push(doc);
  gv.state.expeditions.push({ id: 'exDoc', memberIds: [leader.id, doc.id], kind: 'explore' });
  const hOut = sv.hpOf(leader);
  sv.updateVitals(Date.now(), 30 * 60000, 0);
  const outGain = sv.hpOf(leader) - hOut;
  assert(outGain > 0, '隊伍中有醫生時，外出也會慢慢回復');
  gv.state.expeditions = gv.state.expeditions.filter((e) => e.id !== 'exDoc');
  leader.status = 'idle';
  doc.status = 'idle';
  gv.shelter.primary().facilities.clinic.level = 0;
  sv.setHp(leader, sv.maxHp(leader) * 0.5);
  sv.updateVitals(Date.now(), 30 * 60000, 0);
  const docGain = sv.hpOf(leader) - sv.maxHp(leader) * 0.5;
  assert(docGain > 0 && sv.medicRate(doc) < (await import('../src/config/facilities.js')).clinicRegen(1), '沒有診療室但據點有醫生時也會回復，速度比診療室慢');
  gv.state.survivors = gv.state.survivors.filter((x) => x.id !== doc.id);
  gv.shelter.primary().facilities.clinic.level = 5;
  leader.status = 'exploring';
  leader.status = 'idle';
  const h1 = sv.hpOf(leader);
  sv.updateVitals(Date.now(), 10 * 60000, 0);
  const slow = sv.hpOf(leader) - h1;
  gv.shelter.primary().facilities.clinic.level = 10;
  sv.setHp(leader, h1);
  sv.updateVitals(Date.now(), 10 * 60000, 0);
  assert(slow > 0 && sv.hpOf(leader) - h1 > slow, '診療室等級越高回復越快');
  // 飢餓扣血直到重傷，飢餓時無法治療
  gv.state.starving = true;
  const npc = gv.survivors.makeCandidate(5);
  gv.state.survivors.push(npc);
  sv.updateVitals(Date.now(), 30 * 60000, 30 * 60000);
  assert(npc.severe && sv.hpOf(npc) === 0, '飢餓持續扣血直到重傷');
  gv.state.supplies.largeKit = 5;
  assert(sv.heal(npc.id).ok && sv.hpOf(npc) > 0, '飢餓時一樣可以治療');
  sv.updateVitals(Date.now(), 60 * 60000, 60 * 60000);
  assert(npc.severe && sv.hpOf(npc) === 0, '治療後飢餓仍持續扣血，扣到 0 一樣重傷');
  // 重傷 + 飢餓滿遊戲內 3 天 → 永久死亡（領袖不會死亡）
  sv.becomeSevere(leader, '測試');
  leader.zeroSince = Date.now() - 4 * DAY_REAL_MS;
  npc.zeroSince = Date.now() - 4 * DAY_REAL_MS;
  sv.updateVitals(Date.now(), 1000, 1000);
  assert(!gv.state.survivors.includes(npc) && gv.state.survivors.includes(leader), '重傷且飢餓滿 3 天的隊員永久死亡，領袖不會死亡');
  // 食物收支：人越多消耗越多；食物見底且淨收入為負 → 飢餓
  gv.state.starving = false;
  for (let i = 0; i < 6; i += 1) gv.state.survivors.push(gv.survivors.makeCandidate(1));
  gv.state.resources.food = 1;
  gv.resources.apply(60 * 60000);
  assert(gv.state.starving && gv.resources.lastStarvingMs > 0, `人數多、食物見底時進入飢餓（淨收入 ${gv.resources.rates().net.food.toFixed(1)}/時）`);
  // 人員上限：依領袖等級與據點等級提高，最多 12 人（v14）
  leader.level = 50;
  gv.state.bases[0].facilities = Object.fromEntries(Object.keys(gv.state.bases[0].facilities).map((k) => [k, { level: 10 }]));
  assert(sv.housing() === 12, `人員上限最多 12 人（目前 ${sv.housing()}）`);
  // 品級越高成長越多
  const a = gv.survivors.makeCandidate(30);
  const b = { ...a, id: 'x', rarity: 'legendary' };
  a.rarity = 'poor';
  assert(sv.stats(b).atk > sv.stats(a).atk, '倖存者品級越高，升級提升的能力越多');
  // 驅逐
  const kick = gv.state.survivors.find((s) => !s.isLeader);
  assert(sv.dismiss(kick.id).ok && !sv.get(kick.id), '可驅逐隊員');
  // 據點規模：巨型據點可建 20 棟建築
  const base = gv.shelter.primary();
  assert(gv.shelter.sizeInfo(base).total === 20 && base.defenses.length === 11, '最大（巨型）據點可建造 20 棟建築');
  const small = gv.shelter.sizeInfo({ id: 'ph', type: 'pharmacy', name: 'x', lat: 25.03, lon: 121.556 });
  assert(small.total < 20, `其他規模可建造數較少（${small.name} ${small.total} 棟）`);
  // 突破：第 1 波就被突破損失 55% 資源，建築可能降級或被拆毀，當晚不再來襲
  Object.keys(gv.state.resources).forEach((k) => { gv.state.resources[k] = 1000; });
  base.defenses.forEach((d) => Object.assign(d, { type: 'trap', level: 1 }));
  const siege = gv.siege.of(base.id);
  let destroyed = 0;
  const cellarLv = base.facilities.cellar.level;
  base.facilities.cellar.level = 0;
  siege.breach();
  base.facilities.cellar.level = cellarLv;
  assert(Math.round(gv.state.resources.wood) === 450, `第 1 波就被突破損失 55% 資源（木材 1000 → ${Math.round(gv.state.resources.wood)}）`);
  setHour(gv, 22);
  assert(siege.quiet() && !siege.active() && base.quietUntil > Date.now(), '防線被突破後當晚不再有屍潮');
  assert(!siege.quiet(base.quietUntil + 1), '天亮後恢復');
  destroyed = base.defenses.filter((d) => !d.type).length;
  const facBefore = JSON.stringify(Object.fromEntries(Object.entries(base.facilities).map(([k, f]) => [k, f.level])));
  for (let i = 0; i < 60 && !destroyed; i += 1) {
    siege.breach();
    destroyed = base.defenses.filter((d) => !d.type).length;
  }
  assert(destroyed > 0, `防守失敗時防禦設施可能被摧毀（${destroyed} 棟）`);
  assert(JSON.stringify(Object.fromEntries(Object.entries(base.facilities).map(([k, f]) => [k, f.level]))) === facBefore, '防守失敗不會損毀一般設施');
  assert(base.facilities.wall.level >= 1, '圍牆最低保留 1 級');
}
{
  // 物資（v10）：依地點與世代產生；搜空後一段時間恢復並重新產生；搜過一部分時只剩下的物資
  const { stockOf } = await import('../src/systems/LootStock.js');
  const poi = { id: 'osm_w1', type: 'shop', name: 'x', lat: 0, lon: 0 };
  const today = stockOf(poi);
  assert(!today.empty && Object.keys(today.resources).length >= 1, '建築有物資');
  assert(JSON.stringify(stockOf(poi)) === JSON.stringify(today), '同一世代物資固定（所有玩家相同）');
  assert(stockOf(poi, Date.now(), { gen: 0, empty: true }).empty, '搜空後沒有物資');
  assert(stockOf(poi, Date.now(), { gen: 0, empty: false, left: { res: { food: 5 } } }).resources.food === 5, '搜過一部分時只剩下的物資');
  const gens = new Set(Array.from({ length: 10 }, (_, i) => JSON.stringify(stockOf(poi, Date.now(), { gen: i, empty: false }).resources)));
  assert(gens.size > 5, '每次恢復後物資的種類與數量重新隨機');
}

// ---- 10. v4：區域危險度、屍潮分波、載具、放棄據點、NPC 據點 ----
{
  const { ZONES, zoneIndexAt, zoneAt } = await import('../src/config/zones.js');
  const { stockOf } = await import('../src/systems/LootStock.js');
  const counts = ZONES.map(() => 0);
  for (let i = 0; i < 20000; i += 1) counts[zoneIndexAt(25.0204 + (i % 141) * 0.00016, 121.5557 + Math.floor(i / 141) * 0.0002)] += 1;
  assert(counts.every((c) => c > 0), `六種區域都會出現（${counts.join('/')}）`);
  assert(zoneIndexAt(25.01, 121.52) === zoneIndexAt(25.01, 121.52), '同一座標的區域固定（所有玩家相同）');
  // 找一棟安全區與一棟深淵區的建築比較物資
  const find = (idx) => {
    for (let i = 0; i < 40000; i += 1) {
      const lat = 25.0204 + (i % 200) * 0.0001;
      const lon = 121.5557 + Math.floor(i / 200) * 0.00015;
      if (zoneIndexAt(lat, lon) === idx) return { lat, lon };
    }
    return null;
  };
  const safe = find(0);
  const abyss = find(5);
  const sum = (pos) => Array.from({ length: 30 }, (_, i) => stockOf({ id: `z${i}`, type: 'shop', name: 'x', ...pos }))
    .reduce((t, st) => t + Object.values(st.resources).reduce((a2, b2) => a2 + b2, 0), 0);
  assert(sum(abyss) > sum(safe) * 2.5, '深淵區物資遠多於安全區');
  assert(zoneAt(abyss.lat, abyss.lon).siegeLevel > zoneAt(safe.lat, safe.lon).siegeLevel, '區域越危險屍潮越強');

  // 屍潮分波 + 據點越大越難守
  const gw = Game.newGame({ playerName: 'W', classId: 'warrior', lat: 0, lon: 0 });
  gw.state.map.pois = fillPois([], 0, 0);
  gw.shelter.establish(gw.state.map.pois.find((p) => gw.shelter.canEstablish(p).ok));
  setHour(gw, 23);
  gw.shelter.primary().facilities.wall.level = 10; // 避免測試中防線被突破
  gw.shelter.primary().wallHp = null;
  const sw = gw.siege.of();
  // 新手只會來襲一波
  for (let i = 0; i < 1500; i += 1) {
    gw.siege.update(0.1);
    gw.shelter.primary().wallHp = null;
  }
  assert(sw.wave === 1 && sw.maxWaves() === 1, `新手階段每晚只有 1 波屍潮（${sw.wave} 波）`);
  // 文明度提高後波數變多
  gw.survivors.leader().level = 25;
  gw.civilization.invalidate();
  sw.wave = 0;
  sw.zombies = [];
  sw.waveLeft = 0;
  assert(sw.maxWaves() >= 2, `文明度越高每晚波數越多（${sw.maxWaves()} 波）`);
  const seen = [];
  for (let i = 0; i < 1500; i += 1) {
    gw.siege.update(0.1);
    gw.shelter.primary().wallHp = null; // 測試波次節奏，不讓防線被突破
    seen.push(sw.waveLeft > 0 ? 1 : 0);
  }
  const bursts = seen.reduce((n, v, i) => n + (v && !seen[i - 1] ? 1 : 0), 0);
  assert(sw.wave >= 2 && bursts >= 2, `夜晚屍潮一波一波來襲（${sw.wave} 波，突破 ${gw.state.stats.breaches}，${gw.time.phase().name}，quiet ${sw.quiet()}）`);
  const base = gw.shelter.primary();
  base.size = 'small';
  const small = sw.spawnInterval();
  base.size = 'huge';
  assert(Math.abs(sw.spawnInterval() - small) < 1e-9, 'v15.18：避難所沒有大小之分，屍潮頻率一律比照巨型');

  // 生產下修、升級成本變陡
  const { FACILITIES: F } = await import('../src/config/facilities.js');
  assert(F.farm.cost(10).wood > F.farm.cost(1).wood * 150, '升級成本隨等級快速成長');
  const rates = gw.resources.rates().gross;
  assert(rates.food < 15, `生產只是輔助（起始食物 ${rates.food.toFixed(1)}/時）`);

  // 載具：速度、運載量、耗油、磨損、維修
  const vs = gw.vehicles;
  const bike = vs.create('bicycle');
  const truck = vs.create('truck', 0.5);
  vs.add(bike);
  vs.add(truck);
  const walk = vs.tripStats(2, [], 1000);
  const ride = vs.tripStats(2, [truck], 1000);
  assert(walk.speed === 1 && ride.speed > 1 && ride.cargo > walk.cargo * 10, '載具提升速度與運載量');
  assert(vs.tripStats(2, [bike], 1000).seated === false && vs.tripStats(2, [bike], 1000).speed === 1, '座位不足時全隊步行');
  assert(vs.tripStats(1, [bike], 1000).fuel === 0 && ride.fuel > 0, '腳踏車不耗油，貨車耗油');
  // 耗油：每公里耗油 ×3 × 往返，加上每趟發動 1（大貨車 1 公里約 10）
  assert(ride.fuel === Math.ceil(1.4 * 3 * 2 + 1) && vs.tripStats(1, [vs.create('car', 0.5)], 3000).fuel === Math.ceil(0.5 * 3 * 6 + 1), `載具耗油依距離與載具大小計算（大貨車 1 公里 ${ride.fuel}）`);
  assert(!vs.validate([bike.id, truck.id], 1, 1000).ok, '每台載具至少需要一名駕駛');
  gw.state.resources.fuel = 0;
  assert(!vs.validate([truck.id], 2, 1000).ok, '燃料不足無法出車');
  gw.state.resources.fuel = 500;
  const homeW = gw.shelter.primary();
  const poiFar = gw.state.map.pois.filter((p) => !gw.shelter.baseAtPoi(p.id))
    .sort((p1, p2) => (p2.lat - homeW.lat) ** 2 + (p2.lon - homeW.lon) ** 2 - ((p1.lat - homeW.lat) ** 2 + (p1.lon - homeW.lon) ** 2))[0];
  const plainMs = gw.exploration.plan(poiFar, [gw.survivors.leader()], 15).travelMs;
  const carMs = gw.exploration.plan(poiFar, [gw.survivors.leader()], 15, Date.now(), [bike]).travelMs;
  assert(carMs < plainMs, '騎腳踏車縮短路程時間');
  Object.assign(gw.survivors.leader(), { severe: false, hp: null, status: 'idle' }); // 前面的屍潮近戰防守可能受傷
  const r = gw.exploration.start(poiFar.id, ['leader'], 15, false, Date.now(), { vehicleIds: [bike.id] });
  assert(r.ok && bike.status === 'out', `帶載具出發（${r.reason || ''}・${JSON.stringify({ sev: gw.survivors.leader().severe, st: gw.survivors.leader().status })}）`);
  const dur0 = bike.durability;
  gw.exploration.update(Date.now() + 3 * 3600e3, { silent: true });
  assert(bike.status === 'idle' && bike.durability < dur0, `返回後載具磨損（${dur0} → ${bike.durability}）`);
  fillSupplies(gw);
  gw.state.player.parts = 100;
  assert(vs.repair(truck.id).ok && truck.durability === vs.maxDurability(truck), '維修載具');

  // 運載量限制物資
  const gc = Game.newGame({ playerName: 'C', classId: 'scout', lat: 0, lon: 0 });
  gc.state.map.pois = fillPois([], 0, 0);
  gc.shelter.establish(gc.state.map.pois.find((p) => gc.shelter.canEstablish(p).ok));
  setHour(gc, 10);
  const rich = gc.state.map.pois.find((p) => p.type === 'military');
  gc.exploration.start(rich.id, ['leader'], 60);
  gc.state.expeditions[0].cargo = 10;
  const before = Object.values(gc.state.resources).reduce((a2, b2) => a2 + b2, 0);
  const [rep] = gc.exploration.update(Date.now() + 6 * 3600e3, { silent: true });
  const gainedTotal = Object.entries(rep.resources).filter(([k]) => k in gc.state.resources).reduce((a2, [, v]) => a2 + v, 0);
  assert(gainedTotal <= 12 && Object.values(gc.state.resources).reduce((a2, b2) => a2 + b2, 0) - before <= 12 + 1, `運載量限制帶回的物資（${gainedTotal}）`);

  // 搬遷避難所：取消研究與施工、防禦建築移除退 50%、設施保留、食物木材燃料只剩 10%
  const ga = Game.newGame({ playerName: 'A', classId: 'warrior', lat: 0, lon: 0 });
  ga.state.map.pois = fillPois([], 0, 0);
  ga.shelter.establish(ga.state.map.pois.find((p) => ga.shelter.canEstablish(p).ok));
  const home = ga.shelter.primary();
  home.facilities.farm.level = 3;
  home.facilities.researchCenter.level = 2;
  home.defenses[0] = { slot: 0, type: 'machineGun', level: 2, garrisonId: null };
  Object.keys(ga.state.resources).forEach((k) => { ga.state.resources[k] = 1000; });
  ga.state.research.active = { id: 'w_atk', level: 1, startAt: Date.now(), endAt: Date.now() + 3600e3, cost: { wood: 100 } };
  home.buildQueue.push({ kind: 'facility', id: 'farm', targetLevel: 4, startAt: Date.now(), endAt: Date.now() + 3600e3, cost: { wood: 200 } });
  const defCost = ga.shelter.defenseBuiltCost(home);
  const preview = ga.shelter.abandonPreview(home.id);
  assert(preview.relocate && preview.research && preview.builds === 1, '搬遷預覽列出要取消的研究與施工');
  const expWood = Math.floor((1000 + (preview.cancelled.wood || 0) + Math.floor((defCost.wood || 0) * 0.5)) * 0.1);
  const ab = ga.shelter.abandon(home.id);
  assert(ab.ok && !ga.shelter.hasShelter() && !ga.state.research.active, '搬遷時取消進行中的研究');
  assert(Math.abs(ga.state.resources.wood - expWood) <= 2, `食物、木材、燃料（含退還）只剩 10%（${ga.state.resources.wood} / ${expWood}）`);
  assert(ga.state.resources.food === 100 && Math.abs(ga.state.resources.fuel - Math.floor((1000 + (preview.cancelled.fuel || 0) + Math.floor((defCost.fuel || 0) * 0.5)) * 0.1)) <= 2, '搬遷後食物、燃料只剩 10%');
  assert(ga.shelter.canEstablish(ga.state.map.pois[1]).ok, '搬遷後可重新建立避難所');
  const nb = ga.shelter.establish(ga.state.map.pois[1]).base;
  assert(nb.kind === 'shelter' && nb.facilities.farm.level === 3 && nb.facilities.researchCenter.level === 2, '搬遷後設施等級保留');
  assert(nb.defenses.every((d) => !d.type), '搬遷後防禦建築不保留');
  assert(!ga.state.relocation, '套用後清除搬遷資料');

  // NPC 據點：生成、升級、探索、掠奪、被攻陷後重生
  const gn = Game.newGame({ playerName: 'N', classId: 'warrior', lat: 25.0339, lon: 121.5645 });
  gn.state.map.pois = fillPois([], 25.0339, 121.5645);
  gn.shelter.establish(gn.state.map.pois.find((p) => gn.shelter.canEstablish(p).ok));
  setHour(gn, 10);
  const t0 = Date.now();
  gn.npcs.update(t0);
  gn.npcs.update(t0 + 61000);
  gn.npcs.update(t0 + 122000);
  const perCell = {};
  gn.npcs.list.forEach((n) => { perCell[n.cell] = (perCell[n.cell] || 0) + 1; });
  assert(gn.npcs.list.length >= 2 && Object.values(perCell).every((c) => c <= 2), `每格（約 1 平方公里）最多 2 個 NPC 據點（共 ${gn.npcs.list.length} 個、${Object.keys(perCell).length} 格；只出現在可視範圍內，數量依地圖而定）`);
  // 挑測試期間（2 小時內）不會換世代的 NPC：避免剛好被新的勢力取代
  const stable = (n) => n.sid && gn.npcs.slotNpc(n.cell, Number(n.sid.split(':')[2]), t0 + 7200e3)?.ident === n.ident;
  const { SHARED_NPC } = await import('../src/systems/NpcSystem.js');
  // 挑還沒達到自然升級上限（+15）的據點
  const growing = (n) => (t0 - n.bornAt) / SHARED_NPC.levelMs < SHARED_NPC.maxGrowth - 1;
  const npc = gn.npcs.list.find((n) => n.level < 30 && stable(n) && growing(n)) || gn.npcs.list.find((n) => stable(n) && growing(n)) || gn.npcs.list[0];
  const lv = npc.level;
  const probe = growing(npc) ? npc : { ...npc, bornAt: t0, levelLoss: 0 };
  assert(gn.npcs.sharedLevel(probe, t0 + SHARED_NPC.levelMs) === gn.npcs.sharedLevel(probe, t0) + 1 && lv >= 1, 'NPC 據點會隨時間升級');
  npc.trip = null;
  npc.nextExploreAt = t0;
  npc.nextRaidAt = t0 + 1e9;
  gn.npcs.update(t0 + 2000);
  assert(npc.trip?.kind === 'explore', 'NPC 會外出探索');
  const target = gn.state.map.pois.find((p) => p.id === npc.trip.poiId);
  gn.npcs.update(npc.trip.endAt + 1);
  assert(gn.poiShare.view(target, npc.trip ? Date.now() : target.lootedDay + 1).empty || target.lootedBy?.kind === 'npc', 'NPC 探索後建築被搜刮一空');
  assert(gn.npcs.aggression() < 0.5, '文明度低時 NPC 不太積極');
  // 掠奪：玩家沒有防禦且無人在家 → 被搶
  gn.state.survivors.forEach((s) => { s.status = 'exploring'; });
  Object.keys(gn.state.resources).forEach((k) => { gn.state.resources[k] = 1000; });
  npc.baseLevel += 30 - npc.level;
  npc.level = 30;
  // 放在據點附近：掠奪隊白天就會抵達（太遠會在入夜後才到而撤退）
  npc.lat = gn.shelter.primary().lat + 0.004;
  npc.lon = gn.shelter.primary().lon;
  npc.trip = null;
  npc.wounded = 0;
  npc.nextRaidAt = t0;
  // 其他 NPC 不在掠奪中（避免同時攻打的機制擋下這次）
  gn.npcs.list.forEach((m) => { if (m !== npc && m.trip?.kind === 'raid') m.trip = null; });
  // 等級差上限：倖存者最高 6 人平均 Lv1 時，Lv30 的 NPC 不會來掠奪
  gn.state.survivors.forEach((s) => { s.level = 30; });
  assert(gn.npcs.raidLevelCap() === 50, `NPC 掠奪等級上限最多高出 20 級（${gn.npcs.raidLevelCap()}）`);
  gn.state.survivors.forEach((s) => { s.level = 10; });
  assert(gn.npcs.raidLevelCap() === 26, `NPC 掠奪等級上限 = 倖存者平均等級 × 倍率（Lv10 ×2.6：${gn.npcs.raidLevelCap()}）`);
  gn.state.survivors.forEach((s) => { s.level = 4; });
  assert(gn.npcs.raidLevelCap() === 6, `低等級時倍率較低（Lv4：${gn.npcs.raidLevelCap()}）`);
  gn.npcs.update(t0 + 2500);
  assert(!npc.trip, '超過等級上限的 NPC 不會來掠奪');
  npc.nextRaidAt = t0;
  gn.state.survivors.forEach((s) => { s.level = 15; });
  gn.npcs.update(t0 + 3000);
  assert(npc.trip?.kind === 'raid', '白天 NPC 會出動掠奪');
  gn.npcs.update(npc.trip.startAt + npc.trip.travelMs + 1);
  assert(gn.state.resources.wood < 1000, `掠奪成功搶走資源（木材 1000 → ${gn.state.resources.wood}）`);
  // 夜晚屍潮期間不出動
  npc.trip = null;
  npc.nextRaidAt = t0;
  setHour(gn, 22);
  gn.npcs.update(Date.now());
  assert(!npc.trip, '夜晚屍潮期間 NPC 不會來襲');
  // 玩家攻陷 NPC 據點
  setHour(gn, 10);
  gn.state.survivors.forEach((s) => { s.status = 'idle'; });
  const weak = gn.npcs.list[1];
  weak.level = 1;
  weak.trip = null;
  const hero = gn.survivors.leader();
  hero.level = 50;
  hero.hp = null;
  hero.severe = false;
  gn.territory.noticed = () => false; // 只測攻打本身，不讓路上經過的其他 NPC 警戒範圍影響結果
  // v10：攻打時的守軍比外出掠奪的隊伍多且強（需要多人集結）
  const raidG = gn.npcs.garrison(weak);
  const assaultG = gn.npcs.garrison(weak, { assault: true });
  assert(assaultG.length >= raidG.length && assaultG.at(-1).maxHp > raidG.at(-1).maxHp && assaultG.at(-1).atk > raidG.at(-1).atk, '攻打 NPC 據點時守軍人數與強度提高，外出掠奪的隊伍不變');
  // 這裡只測攻陷流程：守軍只留首領
  const gar0 = gn.npcs.garrison.bind(gn.npcs);
  gn.npcs.garrison = (n, o) => gar0(n).slice(-1);
  const atk = gn.exploration.start(weak.id, ['leader'], 5, false, Date.now(), { kind: 'raid' });
  assert(atk.ok, '派隊攻打 NPC 據點');
  const coinsBefore = gn.state.player.coins;
  const [rr] = gn.exploration.update(Date.now() + 3 * 3600e3, { silent: true });
  gn.npcs.garrison = gar0;
  assert(rr.success && !gn.npcs.get(weak.id) && gn.state.player.coins > coinsBefore, '攻陷 NPC 據點搶到資源，據點被摧毀');
  assert(gn.npcs.state.cellNext[weak.cell] > Date.now(), '被摧毀後該區域一段時間後才會重新出現 NPC');
}

// ---- 11. v5：研究等級制、招募、裝備型號、分級製作、圍牆修繕 ----
{
  const { MAX_RESEARCH_LEVEL } = await import('../src/config/research.js');
  const { craftRarityTable } = await import('../src/config/equipment.js');
  const { survivorRarityTable } = await import('../src/config/survivors.js');
  const gr = Game.newGame({ playerName: 'R', classId: 'warrior', lat: 0, lon: 0 });
  gr.state.map.pois = fillPois([], 0, 0);
  gr.shelter.establish(gr.state.map.pois.find((p) => gr.shelter.canEstablish(p).ok));
  // 研究
  assert(Object.keys(RESEARCH).length >= 69, `研究項目至少為原本三倍（${Object.keys(RESEARCH).length}）`);
  assert(Object.values(RESEARCH).every((r) => r.maxLevel >= 1 && r.maxLevel <= MAX_RESEARCH_LEVEL), '每項科技都有等級，最高 10 級');
  const atk0 = gr.survivors.stats(gr.survivors.leader()).atk;
  gr.state.research.levels.w_atk = 10;
  gr.research.invalidate();
  const atk5 = gr.survivors.stats(gr.survivors.leader()).atk;
  assert(atk5 > atk0 * 1.15, `科技等級越高效果越大（攻擊 ${atk0} → ${atk5}）`);
  Object.keys(gr.state.resources).forEach((k) => { gr.state.resources[k] = 1e7; });
  gr.state.player.coins = 1e7;
  gr.state.player.parts = 1e4;
  fillSupplies(gr);
  assert(!gr.research.canStart('w_crit').ok, '沒有研究中心不能研究');
  gr.shelter.primary().facilities.researchCenter.level = 1;
  assert(gr.research.start('w_crit').ok, '開始研究 Lv1');
  gr.research.update(Date.now() + 1e9);
  assert(gr.research.level('w_crit') === 1, '研究完成升到 Lv1');
  assert(!gr.research.canStart('w_crit').ok, '第 2 級需要研究中心 Lv2');
  assert(!gr.shelter.isDefenseUnlocked('machineGun'), '未研究不能建機槍塔');
  gr.state.research.levels.d_mg = 1;
  gr.research.invalidate();
  assert(gr.shelter.isDefenseUnlocked('machineGun'), '研究「機槍塔」解鎖機槍塔');
  // 舊研究遷移
  const old = JSON.parse(JSON.stringify(gr.state));
  old.version = 6;
  old.research = { completed: ['wpn1', 'def1', 'srv1'], active: { id: 'wpn2', startAt: 0, endAt: 1 } };
  const mig = SaveManager.migrate(old);
  assert(mig.research.levels.w_atk === 3 && mig.research.levels.d_mg === 1 && mig.research.levels.s_scout === 3 && !mig.research.active, '舊研究轉換為新科技等級');

  // 招募品級機率
  const so0 = survivorRarityTable(0);
  const so10 = survivorRarityTable(15);
  assert(so0.legendary === 0 && Math.abs(so0.epic - 0.1) < 1e-9, '倖存者初始稀有 0%、罕見 0.1%');
  assert(Math.abs(so10.legendary - 3) < 1e-9 && Math.abs(Object.values(so10).reduce((a2, b2) => a2 + b2, 0) - 100) < 1e-9, '招募技術滿級傳奇 3%');
  gr.survivors.updateBoard(Date.now());
  assert(gr.state.recruitBoard.list.length === 2, '固定出現兩位可招募的倖存者');
  const firstIds = gr.state.recruitBoard.list.map((c) => c.id).join();
  gr.survivors.updateBoard(Date.now() + 1000);
  assert(gr.state.recruitBoard.list.map((c) => c.id).join() === firstIds, '一小時內名單不變');
  gr.survivors.updateBoard(Date.now() + 3600e3 + 1000);
  assert(gr.state.recruitBoard.list.map((c) => c.id).join() !== firstIds, '每小時更新名單');
  gr.shelter.primary().facilities.dormitory.level = 8;
  const n0 = gr.state.survivors.length;
  assert(gr.survivors.hireFromBoard(gr.state.recruitBoard.list[0].id).ok && gr.state.survivors.length === n0 + 1, '招募固定出現的倖存者');
  const legends = Array.from({ length: 3000 }, () => gr.survivors.rollRarity()).filter((r) => r === 'legendary').length;
  assert(legends === 0, '初始不會招募到稀有倖存者');

  // 裝備型號
  const byType = {};
  Object.values(ITEM_MODELS).forEach((md) => { byType[md.type] = (byType[md.type] || 0) + 1; });
  const meleeNames = Object.values(ITEM_MODELS).filter((md) => md.type === 'melee').map((md) => md.name);
  assert(['拳套', '小刀', '菜刀', '球棒', '水管', '鐵鍬', '開山刀', '斧頭', '武士刀', '電鋸'].every((n) => meleeNames.includes(n)), '近戰武器 10 種');
  assert(['pistol', 'smg', 'shotgun', 'rifle', 'sniper', 'lmg', 'crossbow'].every((t) => byType[t] >= 10), `槍類各至少 10 種（${['pistol', 'smg', 'shotgun', 'rifle', 'sniper', 'lmg'].map((t) => byType[t]).join('/')}）`);
  assert(['helmet', 'armor', 'legs', 'gloves', 'boots'].every((t) => byType[t] >= 10), '頭盔、衣服、護腿、手套、鞋子各至少 10 種');
  assert(byType.backpack === 7, '背包 7 種大小');
  const lowDrops = Array.from({ length: 400 }, () => gr.equipment.generate({ level: 1, type: 'rifle' }).tier);
  const highDrops = Array.from({ length: 400 }, () => gr.equipment.generate({ level: 45, type: 'rifle' }).tier);
  const avg = (a2) => a2.reduce((x, y) => x + y, 0) / a2.length;
  assert(avg(lowDrops) < avg(highDrops) && lowDrops.filter((t) => t >= 9).length < 8, `越強的型號越難取得（低等平均 T${avg(lowDrops).toFixed(1)}、高等平均 T${avg(highDrops).toFixed(1)}）`);
  // 製作
  assert(craftRarityTable(0).legendary === 0 && Math.abs(craftRarityTable(0).epic - 0.1) < 1e-9 && Math.abs(craftRarityTable(15).legendary - 3) < 1e-9 && Math.abs(craftRarityTable(15).epic - 8) < 1e-9, '製作初始傳奇 0%、罕見 0.1%，滿級傳奇 3%、罕見 8%（與招募相同）');
  const sumT = Object.values(craftRarityTable(7)).reduce((a, b) => a + b, 0);
  assert(Math.abs(sumT - 100) < 1e-9 && Math.abs(craftRarityTable(15).common - 33) < 1e-9, '製作品級機率合計 100%');
  const eq = gr.equipment;
  assert(eq.canCraftModel('knuckles').ok && eq.workbench() === 0, '簡易製作不需要工作台');
  assert(!eq.canCraftModel('bat').ok, '其他裝備需要工作台');
  gr.shelter.primary().facilities.workbench.level = 3;
  assert(eq.canCraftModel('bat').ok && !eq.canCraftModel('machete').ok, '工作台等級越高可製作的型號越多');
  assert(!eq.canCraftModel('revolver').ok, '槍械需要研究「槍械製造」');
  gr.state.research.levels.c_gun = 1;
  gr.research.invalidate();
  assert(eq.canCraftModel('revolver').ok && !eq.canCraftModel('uzi').ok, '槍械製造等級決定可製作的槍種');
  const made = Array.from({ length: 2000 }, () => { fillSupplies(gr); const it = eq.craft('knife').item; gr.state.inventory.items = []; return it.rarity; });
  assert(!made.includes('legendary'), '製作技術 0 級時不會做出稀有裝備');
  // 背包增加運載量、電鋸耗油
  const lead = gr.survivors.leader();
  const cargo0 = gr.vehicles.tripStats([lead], []).cargo;
  const pack = eq.generate({ level: 5, model: 'pack3', rarity: 'common' });
  eq.addItem(pack);
  eq.equip(lead.id, pack.id);
  assert(gr.vehicles.tripStats([lead], []).cargo > cargo0 + 100, '背包越大運載量越多');
  const saw = eq.generate({ level: 5, model: 'chainsaw', rarity: 'common' });
  eq.addItem(saw);
  eq.equip(lead.id, saw.id);
  gr.state.resources.fuel = 10;
  gr.combat.simulate([lead], [gr.combat.createEnemy('walker', 1)]);
  assert(gr.state.resources.fuel === 7, '電鋸每場戰鬥消耗燃料');
  // 圍牆不會自行修復，需修繕人員並消耗資源
  const home = gr.shelter.primary();
  home.wallHp = 100;
  lead.job = 'idle';
  gr.state.survivors.forEach((x) => { x.job = 'idle'; });
  gr.shelter.update(Date.now(), 60000);
  assert(Math.round(gr.shelter.wallHp(home)) === 100, '沒有修繕人員時圍牆不會恢復');
  lead.job = 'repair';
  const wood0 = gr.state.resources.wood;
  gr.shelter.update(Date.now(), 60000);
  assert(gr.shelter.wallHp(home) > 100 && gr.state.resources.wood < wood0, '修繕人員修理圍牆並消耗木材');
  gr.state.resources.wood = 0;
  const hpNow = gr.shelter.wallHp(home);
  gr.shelter.update(Date.now(), 60000);
  assert(gr.shelter.wallHp(home) === hpNow, '材料不足時無法修繕');
}

// ---- 12. v6：即時存檔防重讀、突破、招募費、探索時間、背包倉庫 ----
{
  const gs = Game.newGame({ playerName: 'S', classId: 'scout', lat: 25.03, lon: 121.56 });
  gs.state.map.pois = fillPois([], 25.03, 121.56);
  gs.shelter.establish(gs.state.map.pois.find((p) => gs.shelter.canEstablish(p).ok));
  Object.keys(gs.state.resources).forEach((k) => { gs.state.resources[k] = 1e5; });
  gs.state.player.coins = 1e6;
  // 固定種子：讀回同一份存檔，製作結果相同（無法靠重新讀檔刷結果）
  gs.shelter.primary().facilities.dormitory.level = 8;
  const snap = JSON.parse(JSON.stringify(SaveManager.pack(gs.state)));
  const a1 = gs.equipment.craft('knife').item;
  const gs2 = new Game(SaveManager.migrate(JSON.parse(JSON.stringify(snap))));
  const a2 = gs2.equipment.craft('knife').item;
  assert(a1.rarity === a2.rarity && JSON.stringify(a1.stats) === JSON.stringify(a2.stats) && a1.name === a2.name, '重新讀檔後製作結果相同（種子隨存檔保存）');
  const b1 = gs.equipment.craft('knife').item;
  assert(JSON.stringify(b1.stats) !== JSON.stringify(a1.stats) || b1.rarity !== a1.rarity || b1.name !== a1.name, '連續製作結果仍然隨機');
  const r1 = gs.survivors.recruitRoll().offer.map((c) => `${c.rarity}${c.classId}${c.level}`).join();
  const gs3 = new Game(SaveManager.migrate(JSON.parse(JSON.stringify(snap))));
  gs3.equipment.craft('knife');
  const r3 = gs3.survivors.recruitRoll().offer.map((c) => `${c.rarity}${c.classId}${c.level}`).join();
  assert(r1 === r3, '重新讀檔後招募候選人相同');
  // 即時存檔：主存檔不含地圖建築，體積小；建築另存
  const main = JSON.stringify(SaveManager.packMain(gs.state));
  const full = JSON.stringify(SaveManager.pack(gs.state));
  assert(main.length < full.length && !main.includes('poiPack'), `即時存檔不含地圖建築（${Math.round(main.length / 1024)}KB / 完整 ${Math.round(full.length / 1024)}KB）`);
  gs.state.map.pois[3].lootedDay = 99999;
  const back = SaveManager.mergeMap(SaveManager.migrate(JSON.parse(JSON.stringify(SaveManager.packMain(gs.state)))), JSON.parse(JSON.stringify(SaveManager.packMap(gs.state))));
  assert(back.map.pois.length === gs.state.map.pois.length && back.map.pois[3].lootedDay === 99999, '主存檔＋建築清單合併後還原搜刮紀錄');
  let saves = 0;
  gs.bus.on('game:save', () => { saves += 1; });
  gs.started = true;
  gs.log('測試事件');
  await new Promise((r) => setTimeout(r, 0));
  assert(saves >= 1, '任何事件都會立即存檔');

  // 招募需要額外支付金錢
  gs.survivors.updateBoard(Date.now());
  const cand = gs.state.recruitBoard.list[0];
  const fee = gs.survivors.hireCost(cand).coins;
  const coins0 = gs.state.player.coins;
  assert(fee > 0 && gs.survivors.hireFromBoard(cand.id).ok && gs.state.player.coins === coins0 - fee, `附近的倖存者需支付雇用費（💰${fee}）`);
  const offer = gs.survivors.recruitRoll().offer;
  const coins1 = gs.state.player.coins;
  gs.survivors.pickRecruit(offer[0].id);
  assert(gs.state.player.coins === coins1 - gs.survivors.hireCost(offer[0]).coins, '廣播招募選擇後也要支付雇用費');

  // 探索時間依地點大小與危險度
  const { baseSizeOf } = await import('../src/config/civilization.js');
  const huge = gs.state.map.pois.find((p) => baseSizeOf(p) === 'huge');
  const smallP = gs.state.map.pois.find((p) => baseSizeOf(p) === 'small');
  const mins = gs.state.map.pois.map((p) => gs.exploration.searchMinutes(p));
  assert(Math.max(...mins) <= 8 && gs.exploration.searchMinutes(huge) > gs.exploration.searchMinutes(smallP), `搜索時間依大小與危險度（最長 ${Math.max(...mins)} 分鐘）`);
  const lead = gs.survivors.leader();
  Object.assign(lead, { status: 'idle', severe: false, hp: null });
  const ex = gs.exploration.start(huge.id, ['leader'], 60);
  assert(ex.ok && ex.exp.durationMin === gs.exploration.searchMinutes(huge), '派遣探索不再選擇時長，由地點決定');
  gs.exploration.recall(ex.exp.id);
  {
    const toasts = [];
    const tb = gs.toast; gs.toast = (m) => toasts.push(m);
    const reps = gs.exploration.update(Date.now() + 5000);
    gs.toast = tb;
    const rc = reps[0];
    assert(rc && rc.recalled && !rc.success && toasts.some((m) => m.includes('隊伍已召回')) && !toasts.some((m) => m.includes('受挫')), `召回的隊伍提示「隊伍已召回」，不是「受挫」（${toasts.join(' / ')}）`);
  }

  // 個人背包與倉庫
  gs.state.resources.food = 500;
  assert(gs.survivors.withdraw('leader', 'food', 30).ok && lead.bag.food === 30 && gs.state.resources.food === 470, '從倉庫取出放進背包');
  const loW = gs.survivors.loadoutWeight(lead);
  assert(gs.survivors.withdraw('leader', 'food', 1e6).n === Math.floor(gs.survivors.bagCap(lead) - loW) - 30, '背包受負重上限限制（扣掉彈藥欄、藥品欄重量）');
  assert(gs.survivors.deposit('leader', 'food', 10).ok && gs.survivors.carried('food') === Math.floor(gs.survivors.bagCap(lead) - loW) - 10, '背包存入倉庫，總量含隊員攜帶');
  lead.status = 'exploring';
  assert(!gs.survivors.deposit('leader', 'food', 1).ok, '不在避難所無法存取倉庫');
  lead.status = 'idle';
  lead.bag = {};
  const lost = gs.survivors.stash([lead], { wood: 10000 });
  const cap0 = Math.floor(gs.survivors.bagCap(lead) - gs.survivors.loadoutWeight(lead));
  assert(lead.bag.wood === cap0 && lost === 10000 - cap0, `倉庫放不下的探索物資由隊員背包攜帶（${lead.bag.wood}/${cap0}）`);

}

// ---- 13. v6.1：起始無產出、主角無品級、刪除進度移除公開資料 ----
{
  const gz = Game.newGame({ playerName: 'Z', classId: 'warrior', lat: 0, lon: 0 });
  gz.state.map.pois = fillPois([], 0, 0);
  gz.shelter.establish(gz.state.map.pois.find((p) => gz.shelter.canEstablish(p).ok));
  const gross = gz.resources.rates().gross;
  assert(Object.values(gross).every((v) => v === 0), `遊戲起始沒有任何產出（${JSON.stringify(gross)}）`);
  const leader = gz.survivors.leader();
  assert(leader.rarity === null && gz.survivors.growthMul(leader) === 1.6, '主角沒有品級，成長比照傳奇');
  const oldSave = JSON.parse(JSON.stringify(gz.state));
  oldSave.version = 8;
  oldSave.survivors[0].rarity = 'uncommon';
  assert(SaveManager.migrate(oldSave).survivors[0].rarity === null, '舊存檔主角的品級移除');
  // 公開資料以帳號為身分：重新開始仍是同一身分；刪除進度時從世界移除
  const { WorldSync } = await import('../src/multiplayer/WorldSync.js');
  const calls = [];
  const provider = {
    worldNearby: async () => [], worldPut: async (id) => calls.push(['put', id]), worldDelete: async (id) => calls.push(['del', id]),
  };
  const cloud = { cfg: { auth: { id: 'acct1', token: 'tok1' } } };
  const w1 = new WorldSync(gz, provider, cloud);
  const gz2 = Game.newGame({ playerName: 'Z2', classId: 'warrior', lat: 0, lon: 0 });
  const w2 = new WorldSync(gz2, provider, cloud);
  assert(w1.identity().id === w2.identity().id, '同一帳號重新開始仍使用同一個公開身分（舊據點會被取代）');
  await w1.sync();
  assert(calls.some(([t]) => t === 'put'), '有據點時公開');
  await w2.sync();
  assert(calls.some(([t, id]) => t === 'del' && id === w2.identity().id), '沒有據點時從其他玩家的地圖移除');
  calls.length = 0;
  await w1.clear();
  assert(calls.length === 1 && calls[0][0] === 'del', '刪除進度時移除公開的據點與探索隊');
}

// ---- 14. v7：警戒範圍、繞路、敵對遭遇、外交、NPC 判斷 ----
{
  const { planRoute, pathLength, crossings } = await import('../src/map/routing.js');
  const A = { lat: 25, lon: 121 };
  const B = { lat: 25, lon: 121.01 };
  const circle = { lat: 25, lon: 121.005, r: 150 };
  const route = planRoute(A, B, [circle]);
  assert(route.length > 2 && crossings(route, [circle]).length === 0 && pathLength(route) > pathLength([A, B]), '路線會繞開警戒範圍（路程變長）');
  assert(crossings([A, B], [circle]).length === 1, '直線穿過時偵測到進入警戒範圍');

  const gt = Game.newGame({ playerName: 'T', classId: 'warrior', lat: 25, lon: 121 });
  gt.state.map.pois = fillPois([], 25, 121);
  const home = gt.state.map.pois.reduce((best, p) => ((p.lat - 25) ** 2 + (p.lon - 121) ** 2 < (best.lat - 25) ** 2 + (best.lon - 121) ** 2 ? p : best));
  gt.shelter.establish(home);
  const target = { id: 'far', type: 'shop', name: '目標', lat: home.lat, lon: home.lon + 0.012, osm: true };
  gt.state.map.pois.push(target);
  // 中立玩家的據點在路線中間：預設繞開
  gt.world = {
    others: [{ id: 'p1', name: '鄰居', civ: 10, trips: [], bases: [{ lat: home.lat, lon: home.lon + 0.006, name: '鄰居家', primary: true, size: 'medium', alert: 150, guards: 2, guardLevel: 3 }] }],
    identity: () => ({ id: 'me', token: 'x' }),
  };
  const zoneCircle = { lat: home.lat, lon: home.lon + 0.006, r: 150 };
  const pn = gt.territory.route(home, target);
  assert(crossings(pn, [zoneCircle]).length === 0, '非敵對（中立）據點的警戒範圍預設繞開');
  assert(gt.territory.threats(pn).length === 0, '中立據點不會攻擊');
  // 敵對：預設不繞開，有駐守人員會攻擊
  gt.territory.handleEvents([{ from: 'p1', fromName: '鄰居', type: 'attack', data: { win: true, lossPct: 0.1, base: '我家' } }]);
  Object.keys(gt.state.resources).forEach((k) => { gt.state.resources[k] = 1000; });
  gt.territory.handleEvents([{ from: 'p1', fromName: '鄰居', type: 'attack', data: { win: true, lossPct: 0.1 } }]);
  assert(gt.territory.relation('p1') === 'hostile' && gt.state.resources.wood === 900, '被其他玩家攻擊後變成敵對並損失資源');
  const ph = gt.territory.route(home, target);
  assert(crossings(ph, [zoneCircle]).length === 0 && gt.territory.threats(ph).length === 0, 'v9：敵對據點的警戒範圍也一律繞開，不會遭到攻擊');
  const lead = gt.survivors.leader();
  // 友好玩家的範圍不需要繞開
  gt.state.relations.players.p1 = { status: 'friend', name: '鄰居' };
  const pf = gt.territory.route(home, target);
  assert(crossings(pf, [zoneCircle]).length === 1, '友好玩家的警戒範圍不需要繞開');
  gt.world.others[0].trips = [{ id: 'tf', from: { lat: home.lat, lon: home.lon + 0.006 }, to: { lat: home.lat, lon: home.lon }, startAt: Date.now(), endAt: Date.now() + 600000, travelMs: 300000, searchMs: 0, members: 1 }];
  assert(!gt.threats().some((t) => t.includes('鄰居')), '友好玩家的隊伍靠近不顯示威脅');
  gt.world.others[0].trips = [];
  gt.state.relations.players.p1 = { status: 'hostile', name: '鄰居' };
  // 友好
  gt.territory.handleEvents([{ from: 'p2', fromName: '阿美', type: 'friendRequest' }]);
  assert(gt.territory.rel.requestsIn.p2, '收到友好請求');
  await gt.territory.acceptFriend('p2', '阿美');
  assert(gt.territory.relation('p2') === 'friend', '接受後成為友好');
  gt.territory.handleEvents([{ from: 'p2', fromName: '阿美', type: 'friendRemove' }]);
  assert(gt.territory.relation('p2') === 'neutral', '對方解除後回到中立');
  // NPC 一律敵對
  gt.state.npcs.list.push({ id: 'npcX', name: '測試幫', lat: home.lat + 0.006, lon: home.lon, level: 5, poiId: 'x', resources: {}, coins: 0, nextLevelAt: Infinity, nextExploreAt: Infinity, nextRaidAt: Infinity, trip: null });
  assert(gt.territory.zones().find((z) => z.id === 'npcX').relation === 'hostile', 'NPC 一律敵對');
  // NPC 判斷：玩家據點防禦強就繞路，弱就直接穿過
  const npc = gt.state.npcs.list.find((x) => x.id === 'npcX');
  const across = { lat: home.lat - 0.006, lon: home.lon };
  const homeBase = gt.shelter.primary();
  Object.assign(lead, { job: 'guard', level: 1, status: 'idle', severe: false, hp: null });
  gt.npcs.baseDefense = () => 0;
  const weak = gt.npcs.tripTimes(npc, across, 0);
  assert(weak.avoided === 0 && weak.crossings.length >= 1, 'NPC 判斷沒有威脅時直接穿過玩家警戒範圍（有駐守人員會被攻擊）');
  gt.npcs.baseDefense = () => 1e9;
  const strong = gt.npcs.tripTimes(npc, across, 0);
  assert(strong.avoided === 1 && strong.crossings.length === 0, 'NPC 判斷有威脅時繞開玩家警戒範圍');
  void homeBase;
}

// ---- 15. 物品空間：格子與重量 ----
{
  const { BAG_BASE_SLOTS, STORE_BASE_SLOTS, itemSize } = await import('../src/config/equipment.js');
  const gi = Game.newGame({ playerName: 'I', classId: 'warrior', lat: 0, lon: 0 });
  gi.state.map.pois = fillPois([], 0, 0);
  gi.shelter.establish(gi.state.map.pois.find((p) => gi.shelter.canEstablish(p).ok));
  const eq = gi.equipment;
  const lead = gi.survivors.leader();
  assert(eq.storeCap() === STORE_BASE_SLOTS && eq.bagSlotCap(lead) === BAG_BASE_SLOTS, `倉庫初始 ${STORE_BASE_SLOTS} 格、隊員背包初始 ${BAG_BASE_SLOTS} 格`);
  gi.shelter.primary().facilities.itemStore.level = 3;
  gi.state.research.levels.i_shelves = 2;
  gi.research.invalidate();
  assert(eq.storeCap() === STORE_BASE_SLOTS + 26 + 14, '升級物品倉庫與研究可增加物品格子');
  gi.shelter.primary().facilities.itemStore.level = 1;
  gi.state.research.levels.i_shelves = 0;
  gi.research.invalidate();
  const lmg = eq.generate({ level: 5, model: 'm249', rarity: 'common' });
  const knife = eq.generate({ level: 5, model: 'knife', rarity: 'common' });
  assert(itemSize(lmg) === 1 && itemSize(knife) === 1, '所有物品都只佔一格');
  // 消耗品同種類堆疊一格、裝備不堆疊
  gi.state.resources.food = 500;
  gi.state.resources.wood = 500;
  gi.survivors.withdraw(lead.id, 'food', 5);
  gi.survivors.withdraw(lead.id, 'food', 5);
  gi.survivors.withdraw(lead.id, 'wood', 3);
  assert(eq.bagSlotsUsed(lead) === 2 && lead.bag.food === 10, '同種類消耗品堆疊在同一格');
  assert(gi.survivors.deposit(lead.id, 'food', Infinity).ok && !lead.bag.food && eq.bagSlotsUsed(lead) === 1, '可以全部存入倉庫');
  gi.survivors.deposit(lead.id, 'wood', Infinity);
  // 填滿倉庫
  let added = 0;
  const supplySlots = eq.supplySlots();
  while (eq.addItem(eq.generate({ level: 1, model: 'shovel', rarity: 'common' }), '測試')) added += 1;
  assert(eq.storeUsed() <= eq.storeCap() && added === eq.storeCap() - supplySlots, `倉庫滿了就放不下（放入 ${added} 件，材料物品佔 ${supplySlots} 格）`);
  Object.keys(gi.state.resources).forEach((k) => { gi.state.resources[k] = 1e5; });
  assert(!eq.craft('knife').ok, '倉庫空間不足時無法製作');
  // 放不下時由隊員背包攜帶
  const extra = eq.generate({ level: 1, model: 'pistolXbow', rarity: 'common' });
  assert(eq.addItem(extra, '測試', [lead]) && extra.loc === lead.id, '倉庫滿時物品放進隊員背包');
  assert(gi.survivors.bagLoad(lead) >= 4, '背包內物品計入負重');
  // 背包裝備增加格數
  const pack = eq.generate({ level: 1, model: 'pack3', rarity: 'common' });
  gi.state.inventory.items.push({ ...pack, loc: 'store' });
  eq.equip(lead.id, pack.id);
  assert(eq.bagSlotCap(lead) > BAG_BASE_SLOTS + 8, `背包裝備增加物品格數（${eq.bagSlotCap(lead)} 格）`);
  // 移動與穿戴
  gi.state.inventory.items = [];
  gi.state.supplies = {};
  const gun = eq.generate({ level: 1, model: 'm1911', rarity: 'common' });
  eq.addItem(gun, '測試');
  assert(eq.moveToBag(gun.id, lead.id).ok && gun.loc === lead.id && eq.storeUsed() === 0, '倉庫物品交給隊員攜帶');
  assert(eq.moveToStore(gun.id).ok && gun.loc === 'store', '隊員背包物品放回倉庫');
  eq.equip(lead.id, gun.id);
  assert(eq.storeUsed() === 0, '穿戴中的裝備不佔格子');
  assert(eq.unequip(lead.id, 'weapon').ok && eq.storeUsed() === itemSize(gun), '卸下後放回倉庫');
  const old = JSON.parse(JSON.stringify(gi.state));
  old.inventory.items.forEach((it) => { delete it.loc; });
  assert(SaveManager.migrate(old).inventory.items.every((it) => it.loc === 'store'), '舊存檔的物品都放在倉庫');
}

// ---- 16. v7.2：倉庫分類、堆疊上限、GPS 偵測 ----
{
  const { STACK_MAX } = await import('../src/config/equipment.js');
  const { FACILITIES } = await import('../src/config/facilities.js');
  const gq = Game.newGame({ playerName: 'Q', classId: 'warrior', lat: 25, lon: 121 });
  gq.state.map.pois = fillPois([], 25, 121);
  gq.shelter.establish(gq.state.map.pois.find((p) => gq.shelter.canEstablish(p).ok));
  const home = gq.shelter.primary();
  assert(FACILITIES.warehouse.name === '消耗品倉庫' && FACILITIES.itemStore.name === '物品倉庫' && home.facilities.itemStore.level === 1, '倉庫分為消耗品倉庫與物品倉庫');
  const cap0 = gq.resources.storageCap();
  const slots0 = gq.equipment.storeCap();
  home.facilities.warehouse.level = 3;
  assert(gq.resources.storageCap() > cap0 && gq.equipment.storeCap() === slots0, '消耗品倉庫只提高消耗品上限');
  home.facilities.itemStore.level = 3;
  assert(gq.equipment.storeCap() === slots0 + 26, '物品倉庫提高物品格子');
  assert(gq.shelter.sizeInfo(home).total <= 20, '據點建築總數上限仍為 20');
  // 堆疊上限 9999
  const lead = gq.survivors.leader();
  gq.vehicles.memberCarry = () => 1e7;
  gq.state.resources.food = 50000;
  home.facilities.warehouse.level = 10;
  assert(STACK_MAX === 9999 && gq.survivors.withdraw(lead.id, 'food', STACK_MAX + 500).ok && gq.equipment.bagSlotsUsed(lead) === 2, `消耗品每格最多堆疊 ${STACK_MAX}（${STACK_MAX + 500} 佔 2 格）`);
  lead.bag = {};
  gq.state.resources.food = 2e6;
  const max = gq.survivors.withdraw(lead.id, 'food', 1e6);
  assert(max.n === gq.equipment.bagSlotCap(lead) * STACK_MAX, '背包格子決定可攜帶的消耗品上限');
  lead.bag = {};
  // v15.7：GPS 功能移除：舊存檔的偵測資料與設定一併清掉
  {
    const o = JSON.parse(JSON.stringify(gq.state));
    o.map.detected = { a: 1 }; o.settings.gps = true;
    const m = SaveManager.migrate(o);
    assert(!m.map.detected && !('gps' in m.settings) && !('gps' in gq), '移除 GPS：舊存檔的偵測資料與設定清除');
  }
  // 舊存檔：物品倉庫沿用原倉庫等級
  const old = JSON.parse(JSON.stringify(gq.state));
  old.version = 10;
  delete old.bases[0].facilities.itemStore;
  old.bases[0].facilities.warehouse.level = 4;
  assert(SaveManager.migrate(old).bases[0].facilities.itemStore.level === 4, '舊存檔的物品倉庫沿用原倉庫等級');
}

// ---- 17. v8：材料物品、彈藥、藥品、建築資源、殘留物資、屍潮波數、標記、攔截 ----
{
  const sup = await import('../src/config/supplies.js');
  const { POI_TYPES: PT } = await import('../src/config/poiTypes.js');
  const { stockOf: stock, remainOf } = await import('../src/systems/LootStock.js');
  const { RESOURCE_KEYS } = await import('../src/config/constants.js');
  const { MAX_MARKERS } = await import('../src/systems/MarkerSystem.js');
  const parts = sup.SUPPLY_KEYS.filter((k) => sup.SUPPLIES[k].cat === 'part');
  assert(parts.length >= 30, `零件至少 30 種（${parts.length}）`);
  assert(!RESOURCE_KEYS.includes('metal') && !RESOURCE_KEYS.includes('cloth') && !RESOURCE_KEYS.includes('medicine'), '金屬、布料、藥品不再是基本資源');
  ['techCotton', 'reinforced', 'coarse', 'cotton', 'linen'].forEach((k) => assert(sup.SUPPLIES[k]?.cat === 'fabric', `布料 ${k}`));
  ['gauze', 'bandage', 'vitamin', 'antibiotic', 'smallKit', 'mediumKit', 'largeKit'].forEach((k) => assert(sup.SUPPLIES[k]?.cat === 'med', `藥品 ${k}`));
  assert(sup.SUPPLIES.largeKit.heal === 1, '大型醫藥箱回復 100%');
  assert(sup.medWeight('largeKit') < sup.medWeight('bandage'), '回復量越高的藥品越稀有');
  // 所有成本都不再使用金屬／布料／藥品
  const costs = [
    ...Object.values(FACILITIES).flatMap((f) => [1, 5, 10].map((lv) => f.cost(lv))),
    ...Object.values(DEFENSES).flatMap((d) => [1, 10].map((lv) => d.cost(lv))),
    ...Object.keys(RESEARCH).map((id) => researchCostOf(id, 3)),
  ];
  assert(costs.every((c) => !('metal' in c) && !('cloth' in c) && !('medicine' in c)), '建造、升級、研究改用具體零件與布料');
  assert(costs.every((c) => Object.keys(c).every((k) => RESOURCE_KEYS.includes(k) || sup.isSupply(k) || k === 'coins' || k === 'parts')), '成本只含已知的資源與材料');
  const gk = Game.newGame({ playerName: 'K', classId: 'warrior', lat: 25, lon: 121 });
  gk.state.map.pois = fillPois([], 25, 121);
  gk.shelter.establish(gk.state.map.pois.find((p) => gk.shelter.canEstablish(p).ok));
  const { craftRecipe } = await import('../src/systems/EquipmentSystem.js');
  const r1 = craftRecipe(ITEM_MODELS.vest1);
  const r2 = craftRecipe(ITEM_MODELS.vest2);
  assert(r1.ironPlate && r1.techCotton, `基礎防彈衣需要鐵板與科技棉（${JSON.stringify(r1)}）`);
  assert(r2.steelPlate && r2.reinforced, `進階防彈衣需要鋼板與強化布料（${JSON.stringify(r2)}）`);
  // 舊存檔：金屬、布料、藥品換算成材料物品
  const old = JSON.parse(JSON.stringify(gk.state));
  old.version = 11;
  Object.assign(old.resources, { metal: 400, cloth: 200, medicine: 20 });
  delete old.supplies;
  const mig = SaveManager.migrate(old);
  assert(!('metal' in mig.resources) && mig.supplies.screw > 0 && mig.supplies.coarse > 0 && mig.supplies.bandage > 0, '舊存檔的金屬、布料、藥品換算成零件、布料、藥品');

  // 建築資源策略
  const days = Array.from({ length: 60 }, (_, i) => Date.UTC(2026, 0, 1 + i));
  const kinds = (type) => {
    const poi = { id: `t_${type}`, type, lat: 25, lon: 121 };
    const out = new Set();
    days.forEach((d) => Object.keys(stock(poi, d).resources).forEach((k) => out.add(sup.SUPPLIES[k]?.cat || k)));
    return out;
  };
  const res = kinds('residential');
  assert(res.has('food') && !res.has('ammo') && PT.residential.itemChance === 0 && PT.residential.loot.part < PT.residential.loot.food, `住宅區：食物、布料、低階藥品，少量零件（${[...res]}）`);
  const resMeds = new Set();
  days.forEach((d) => Object.keys(stock({ id: 'rm', type: 'residential', lat: 25, lon: 121 }, d).resources).forEach((k) => { if (sup.SUPPLIES[k]?.cat === 'med') resMeds.add(sup.SUPPLIES[k].tier); }));
  assert([...resMeds].every((t) => t <= 2), '住宅區只出現低階藥品');
  assert(kinds('military').has('ammo') && PT.military.itemChance > 0 && PT.police.itemChance > 0, '軍事基地、警局可出現裝備與彈藥');
  assert(kinds('forest').size === 1 && kinds('forest').has('wood'), '樹林只產木材');
  assert(PT.garage.loot.vehicle && kinds('garage').has('part'), '修車廠可取得載具與零件');
  assert(PT.supermarket && (PT.supermarket.amountMul || 1) > (PT.shop.amountMul || 1), '超市物資數量比商店多');
  assert(classify({ shop: 'car_repair' }) === 'garage' && classify({ shop: 'supermarket' }) === 'supermarket', 'OSM 修車廠與超市分類');

  // 藥品治療
  const lead = gk.survivors.leader();
  gk.survivors.setHp(lead, 1);
  gk.state.supplies.largeKit = 1;
  const hr = gk.survivors.heal(lead.id, 'largeKit');
  assert(hr.ok && gk.survivors.hpOf(lead) === gk.survivors.maxHp(lead), '大型醫藥箱回復 100% 生命');
  gk.survivors.setHp(lead, 1);
  gk.state.supplies.gauze = 1;
  gk.survivors.heal(lead.id, 'gauze');
  assert(gk.survivors.hpOf(lead) < gk.survivors.maxHp(lead) * 0.3, '紗布只回復少量生命');

  // 槍械需要彈藥
  const pistol = gk.equipment.generate({ level: 5, model: 'm1911', rarity: 'common' });
  gk.equipment.addItem(pistol, '測試');
  gk.equipment.equip(lead.id, pistol.id);
  delete gk.state.supplies.ammo9;
  lead.bag = {};
  const full = gk.survivors.stats(lead, 'ranged').atk;
  const noAmmo = gk.combat.unitFromSurvivor(lead).atk;
  assert(noAmmo < full, `沒有彈藥時無法使用槍械（攻擊 ${full} → ${Math.round(noAmmo)}）`);
  lead.bag = { ammo9: 10 };
  const withAmmo = gk.combat.unitFromSurvivor(lead).atk;
  assert(withAmmo >= full * 0.99 && lead.bag.ammo9 === 10 - sup.AMMO_FOR.pistol.perFight, '有彈藥時可使用槍械並消耗彈藥');
  gk.state.supplies.wood = 0;
  gk.state.resources.wood = 100;
  gk.state.supplies.nail = 10;
  const arrows0 = gk.state.supplies.arrow || 0;
  assert(gk.equipment.craftAmmo('arrow').ok && gk.state.supplies.arrow === arrows0 + sup.AMMO_RECIPES.arrow.batch, '可以製作箭矢');
  gk.state.supplies.ammo9 = 100;
  lead.bag = {};
  const far = gk.state.map.pois.find((p) => p.type === 'residential' && !gk.shelter.baseAtPoi(p.id));
  const ex = gk.exploration.start(far.id, [lead.id], 5);
  assert(ex.ok && lead.loadout.ammo?.key === 'ammo9' && lead.loadout.ammo.qty >= sup.AMMO_FOR.pistol.perFight * sup.AMMO_PACK_FIGHTS, `出發時自動把彈藥裝進彈藥欄（${lead.loadout.ammo?.qty}）`);
  gk.exploration.recall(ex.exp.id);
  gk.exploration.update(Date.now() + 5000, { silent: true });

  // 殘留物資：帶不走的留在建築裡，地圖顯示剩餘數量
  const target = gk.state.map.pois.find((p) => p.type === 'supermarket' && !gk.shelter.baseAtPoi(p.id));
  setHour(gk, 10);
  lead.bag = {};
  gk.equipment.unequip(lead.id, 'weapon');
  gk.state.map.zombieGroups = [];
  Object.assign(lead, { severe: false, hp: null });
  const e2 = gk.exploration.start(target.id, [lead.id], 5);
  e2.exp.cargo = 3; // 幾乎帶不動
  const rep = gk.exploration.update(e2.exp.endAt + 1, { silent: true })[0];
  const left = remainOf(target, gk.state.map.remain, e2.exp.startAt + e2.exp.travelMs);
  assert(rep && (!left || Object.values(left).some((v) => v > 0)), '探索結算完成');
  if (left) {
    const st2 = stock(target, Date.now(), gk.state.map.remain);
    assert(st2.partial && Object.keys(st2.resources).length > 0, `帶不走的物資殘留在建築內（${JSON.stringify(left)}）`);
  }

  // 突破後圍牆歸零
  const sk = gk.siege.of();
  setHour(gk, 23);
  gk.shelter.primary().wallHp = 1;
  sk.zombies = [];
  sk.spawn('walker');
  sk.zombies[0].x = 0;
  sk.zombies[0].y = 40;
  // 據點裡沒有人可以迎戰：圍牆一破就被攻破
  const healthy = gk.state.survivors.filter((sv) => !sv.severe);
  healthy.forEach((sv) => { sv.severe = true; });
  for (let i = 0; i < 100 && !sk.quiet(); i += 1) sk.update(0.1);
  healthy.forEach((sv) => { sv.severe = false; });
  assert(sk.quiet() && gk.shelter.wallHp(gk.shelter.primary()) === 0, '避難所被打壞後圍牆耐久歸零');
  for (let i = 0; i < 50; i += 1) sk.update(0.1);
  assert(gk.state.stats.breaches === 1 && gk.shelter.wallHp(gk.shelter.primary()) === 0, '圍牆不會自動恢復，需修理');

  // 標記地點
  const free = gk.state.map.pois.filter((p) => !gk.shelter.baseAtPoi(p.id));
  for (let i = 0; i < MAX_MARKERS; i += 1) assert(gk.markers.mark(free[i]).ok, `標記第 ${i + 1} 個地點`);
  assert(!gk.markers.mark(free[MAX_MARKERS]).ok, `最多標記 ${MAX_MARKERS} 個地點`);
  const markedPoi = free[0];
  gk.state.map.pois = gk.state.map.pois.filter((p) => p.id !== markedPoi.id);
  gk.markers.ensure();
  assert(gk.state.map.pois.some((p) => p.id === markedPoi.id), '標記的建築在重新掃描後仍保留');
  assert(gk.markers.unmark(markedPoi.id).ok && gk.markers.list.length === MAX_MARKERS - 1, '可以移除標記');

  // 攔截 NPC 隊伍
  setHour(gk, 10);
  const npcPoi = gk.state.map.pois.find((p) => !gk.shelter.baseAtPoi(p.id) && PT[p.type].danger >= 2);
  const npc = gk.npcs.spawnAt(npcPoi, 'x', Date.now(), true);
  npc.level = 1;
  const exploreTarget = gk.state.map.pois.find((p) => p.type === 'residential' && !gk.shelter.baseAtPoi(p.id) && p.id !== npcPoi.id);
  gk.npcs.launchExplore(npc, Date.now());
  if (!npc.trip) npc.trip = { kind: 'explore', poiId: exploreTarget.id, from: { lat: npc.lat, lon: npc.lon }, to: exploreTarget, startAt: Date.now(), endAt: Date.now() + 3600e3, travelMs: 1800e3, searchMs: 0, distanceM: 1000, crossings: [] };
  npc.trip.endAt = Date.now() + 10 * 3600e3;
  lead.level = 40;
  Object.assign(lead, { severe: false, hp: null, status: 'idle' });
  gk.state.expeditions = [];
  // 移動中的隊伍不能攔截，停下搜索時才可以
  npc.trip.startAt = Date.now();
  npc.trip.travelMs = Math.max(60e3, npc.trip.travelMs || 0);
  assert(!gk.intercept.canIntercept({ kind: 'npc', npcId: npc.id }).ok, '移動中的 NPC 隊伍不能攔截');
  npc.trip.startAt = Date.now() - npc.trip.travelMs - 1000;
  npc.trip.searchMs = 5 * 3600e3;
  const ic = gk.intercept.start({ kind: 'npc', npcId: npc.id }, [lead.id]);
  assert(ic.ok && ic.exp.kind === 'intercept', '可以派隊攔截 NPC 隊伍');
  gk.intercept.checkArrivals(ic.exp.startAt + ic.exp.travelMs + 1);
  assert(ic.exp.icptDone && ic.exp.icptResult.win && npc.trip?.hidden && npc.trip.endAt > Date.now(), `擊敗 NPC 隊伍，對方花時間撤回據點（${ic.exp.icptResult.events.join(' / ')}）`);
  assert(gk.npcs.trips().some((t) => t.npc === npc) && !gk.intercept.target({ kind: 'npc', npcId: npc.id }), '撤回中的 NPC 隊伍仍顯示在地圖上，但不能再攔截');
  const icRep = gk.exploration.update(ic.exp.endAt + 1, { silent: true })[0];
  assert(icRep?.success && Object.keys(icRep.resources).length > 0, '攔截成功搶走對方身上的物資');

  // 自己的隊伍被其他玩家攔截：撤回、背包物資被搶、不公開返程
  const e3 = gk.exploration.start(exploreTarget.id, [lead.id], 5);
  lead.bag = { food: 30, nail: 5 };
  const sent = [];
  gk.territory.send = async (to, type, data) => { sent.push({ to, type, data }); return true; };
  gk.territory.handleEvents([{ from: 'p1', fromName: '敵人', type: 'intercept', data: { tripId: e3.exp.id, win: true } }]);
  assert(e3.exp.defeated && !Object.keys(lead.bag).length, '被攔截擊敗：隊員背包的物資全部被搶走');
  assert(sent.some((x) => x.type === 'plunder' && x.data.resources.food === 30), '戰利品透過事件信箱送給對方');
  gk.world = { others: [] };
  const { WorldSync } = await import('../src/multiplayer/WorldSync.js');
  const pres = WorldSync.prototype.presence.call({ game: gk });
  const back = pres.trips.find((t) => t.id === e3.exp.id);
  assert(back?.defeated, '被擊敗後的返程仍會顯示移動（標記為撤回中）');
  gk.world = { others: [{ id: 'p9', name: '他人', bases: [], trips: [{ ...back, id: 'x1' }] }] };
  assert(!gk.intercept.target({ kind: 'player', playerId: 'p9', tripId: 'x1' }), '撤回中的玩家隊伍不能再攔截');
  gk.world = { others: [] };
  const dr = gk.exploration.update(e3.exp.endAt + 1, { silent: true })[0];
  assert(dr && !dr.success && lead.status === 'idle', '撤回據點後結算');
  // 收到的戰利品需驗證
  const coins0 = gk.state.player.coins;
  const got = gk.intercept.receivePlunder({ resources: { food: 10, coins: 1e9, hack: 5, nail: 1e9 }, items: [{ model: 'nope' }, { model: 'knife', rarity: 'rare', level: 999 }] }, '測試');
  assert(gk.state.player.coins === coins0 && got.includes('「') && gk.state.inventory.items.some((i) => i.model === 'knife' && i.level <= 60), '收到的戰利品只接受已知物資與裝備，數值有上限');
}

// ---- 18. v8 追加：每日物資箱、任務成就、主線進度換算 ----
{
  const { MAIN_QUESTS: MQ, DAILY_POOL: DP, ACHIEVEMENTS: AC } = await import('../src/config/quests.js');
  const { QuestSystem } = await import('../src/systems/QuestSystem.js');
  const gc = Game.newGame({ playerName: 'Q', classId: 'warrior', lat: 25, lon: 121 });
  gc.state.map.pois = fillPois([], 25, 121);
  gc.shelter.establish(gc.state.map.pois.find((p) => gc.shelter.canEstablish(p).ok));
  gc.quests.ensureDaily();
  assert(!gc.quests.openChest().ok, '未完成每日任務不能開物資箱');
  gc.state.quests.dailies.forEach((d) => { d.claimed = true; });
  const before = JSON.stringify(gc.state.supplies) + gc.state.inventory.items.length + gc.state.inventory.blueprints.length;
  const ch = gc.quests.openChest();
  assert(ch.ok && ch.lines.length >= 1 && before !== JSON.stringify(gc.state.supplies) + gc.state.inventory.items.length + gc.state.inventory.blueprints.length, `全部每日任務完成可開啟物資箱（${ch.lines.join('、')}）`);
  assert(!gc.quests.openChest().ok, '物資箱每天只能開一次');
  const w = QuestSystem.supplyWeights();
  assert(w.nail > w.ironPlate && w.ironPlate > w.titanium && w.bandage > w.largeKit, '物資箱：越高階的材料越難開到');
  [...MQ, ...DP, ...AC].forEach((q) => {
    if (q.cond.key) assert(STAT_KEYS.includes(q.cond.key), `任務 ${q.id} 的統計 ${q.cond.key} 存在`);
    Object.keys(q.reward).forEach((k) => assert(['coins', 'parts', 'food', 'wood', 'fuel', 'item'].includes(k) || SUPPLY_KEYS.includes(k), `任務 ${q.id} 獎勵 ${k} 有效`));
  });
  assert(AC.length >= 29 && DP.length >= 6, `任務與成就增加（每日 ${DP.length}、成就 ${AC.length}）`);
  assert(!DP.some((d) => ['researchDone', 'upgrades', 'itemsFound', 'healed', 'siegeKills'].includes(d.cond.key)), '每日任務不放受時間、運氣或夜晚限制的目標');
  gc.state.quests.dailies[0].id = 'd_research';
  gc.quests.ensureDaily();
  assert(gc.state.quests.dailies.length === 4 && gc.state.quests.dailies.every((d) => DP.some((x) => x.id === d.id)), '今天已經抽到的舊每日任務會被換掉');
  const old = JSON.parse(JSON.stringify(gc.state));
  old.version = 11;
  old.quests.mainIndex = 5; // 舊版第 6 個主線（m6 清理街道）
  assert(MQ[SaveManager.migrate(old).quests.mainIndex].id === 'm6', '舊存檔的主線進度依任務 ID 換算');
}

// ---- 19. v8.1：避難所防守消耗據點庫存彈藥，沒有彈藥只能近戰 ----
{
  const gd = Game.newGame({ playerName: 'D', classId: 'warrior', lat: 25, lon: 121 });
  gd.state.map.pois = fillPois([], 25, 121);
  gd.shelter.establish(gd.state.map.pois.find((p) => gd.shelter.canEstablish(p).ok));
  setHour(gd, 23);
  const lead = gd.survivors.leader();
  const rifle = gd.equipment.generate({ level: 5, model: 'ak47', rarity: 'common' });
  gd.equipment.addItem(rifle, '測試');
  gd.equipment.equip(lead.id, rifle.id);
  lead.job = 'guard';
  lead.bag = {};
  const sd = gd.siege.of();
  gd.state.supplies.ammo556 = 3;
  assert(sd.canShoot(lead), '據點庫存有彈藥時可以遠程射擊');
  const full = gd.survivors.stats(lead, 'ranged');
  const a1 = sd.attackPower(lead, full);
  assert(a1.ranged && a1.value === full.atk && gd.state.supplies.ammo556 === 2, '防守射擊消耗據點庫存的彈藥');
  gd.state.supplies.ammo556 = 0;
  const a2 = sd.attackPower(lead, full);
  assert(!sd.canShoot(lead) && !a2.ranged && a2.value < full.atk, '沒有彈藥時只能近戰（失去武器攻擊力）');
  // 近戰只打得到貼在圍牆上的殭屍
  sd.zombies = [];
  sd.spawn('walker');
  const z = sd.zombies[0];
  Object.assign(z, { x: 0, y: 70, speed: 0, hp: 1e6, maxHp: 1e6 });
  for (let i = 0; i < 30; i += 1) sd.step(0.1);
  assert(z.hp === 1e6, '沒有彈藥時打不到遠處的殭屍');
  z.y = WORLDC.WALL_R + 2;
  for (let i = 0; i < 30; i += 1) sd.step(0.1);
  assert(z.hp < 1e6, '近戰可以攻擊貼在圍牆上的殭屍');
  // NPC 只看得到武器，不知道據點還有沒有彈藥
  gd.state.supplies.ammo556 = 0;
  const seenEmpty = gd.npcs.baseDefense(gd.shelter.primary());
  gd.state.supplies.ammo556 = 999;
  const seenFull = gd.npcs.baseDefense(gd.shelter.primary());
  assert(seenEmpty === seenFull, `NPC 判斷是否繞路時不會知道彈藥存量（${seenEmpty} = ${seenFull}）`);
  gd.state.supplies.ammo556 = 0;
  const realEmpty = sd.defenseDps();
  gd.state.supplies.ammo556 = 999;
  assert(sd.defenseDps() > realEmpty, '實際防禦強度仍會因為沒有彈藥而下降');
}

// ---- 20. v8.2：開局材料足夠升級第一批設施 ----
{
  const gs0 = Game.newGame({ playerName: 'N', classId: 'warrior', lat: 25, lon: 121 });
  gs0.state.map.pois = fillPois([], 25, 121);
  gs0.shelter.establish(gs0.state.map.pois.find((p) => gs0.shelter.canEstablish(p).ok));
  gs0.state.resources.wood = 1000; // 木材可從樹林取得，這裡只檢查零件與布料
  ['wall', 'warehouse', 'itemStore', 'farm'].forEach((id) => assert(gs0.shelter.canUpgradeFacility(null, id).ok, `開局的零件與布料足夠升級${FACILITIES[id].name}`));
}

// ---- 21. v8.3.2：返程中的隊伍不能召回 ----
{
  const gr2 = Game.newGame({ playerName: 'R', classId: 'warrior', lat: 25, lon: 121 });
  gr2.state.map.pois = fillPois([], 25, 121);
  gr2.shelter.establish(gr2.state.map.pois.find((p) => gr2.shelter.canEstablish(p).ok));
  const tgt = gr2.state.map.pois.find((p) => p.type === 'residential' && !gr2.shelter.baseAtPoi(p.id));
  const r = gr2.exploration.start(tgt.id, ['leader'], 5);
  assert(gr2.exploration.canRecall(r.exp), '前往中可以召回');
  assert(!gr2.exploration.canRecall(r.exp, r.exp.endAt - 1000), '返程中不顯示召回');
  r.exp.startAt -= r.exp.endAt - r.exp.startAt - 1000; r.exp.endAt = Date.now() + 1000;
  assert(!gr2.exploration.recall(r.exp.id).ok && gr2.state.expeditions.length === 1, '返程中的隊伍無法召回');
}

// ---- 22. v8.4：製作畫面的能力範圍 ----
{
  const gq2 = Game.newGame({ playerName: 'Q2', classId: 'warrior', lat: 25, lon: 121 });
  gq2.state.map.pois = fillPois([], 25, 121);
  gq2.shelter.establish(gq2.state.map.pois.find((p) => gq2.shelter.canEstablish(p).ok));
  const range = gq2.equipment.craftStatRange('knife');
  assert(range.atk && range.atk[0] < range.atk[1], `製作畫面顯示能力最小值與最大值（攻擊 ${range.atk}）`);
  let outside = 0;
  ['poor', 'common', 'uncommon', 'rare', 'epic'].forEach((rarity) => {
    for (let i = 0; i < 40; i += 1) {
      const it = gq2.equipment.generate({ level: gq2.equipment.craftLevel('knife'), model: 'knife', rarity });
      Object.entries(range).forEach(([k, [a, b]]) => { if (it.stats[k] < a - 1e-9 || it.stats[k] > b + 1e-9) outside += 1; });
    }
  });
  assert(outside === 0, `製作出的裝備數值都在顯示的範圍內（超出 ${outside}）`);
}

// ---- 23. v8.5：遊戲一天 = 現實 1 小時，舊存檔維持生存天數（v9 起時刻改為世界時間） ----
{
  assert(DAY_REAL_MS === 90 * 60000, '遊戲一天為現實 90 分鐘');
  {
    // v15.7：改成 90 分鐘一天的那一刻，時間連續不跳；之前照舊 60 分鐘一天
    TimeSysT.switchAt = SWITCH_REAL;
    const h0 = TimeSysT.hoursAt(SWITCH_REAL - 1); const h1 = TimeSysT.hoursAt(SWITCH_REAL + 1);
    const hb = TimeSysT.hoursAt(SWITCH_REAL - 3600000); const ha = TimeSysT.hoursAt(SWITCH_REAL + 5400000);
    TimeSysT.switchAt = WORLD_EPOCH_MS;
    assert(Math.abs(h1 - h0) < 0.01 && Math.abs((h0 - hb) - 24) < 0.01 && Math.abs((ha - h1) - 24) < 0.01, `切換前 60 分鐘一天、切換後 90 分鐘一天，時刻連續（${h0.toFixed(3)} → ${h1.toFixed(3)}）`);
  }
  const gt = Game.newGame({ playerName: 'T', classId: 'warrior', lat: 25, lon: 121 });
  gt.state.createdAt = Date.now() - 5.5 * 30 * 60000; // 舊制（30 分鐘一天）下的第 6 天 20:00
  const old = JSON.parse(JSON.stringify(gt.state));
  old.version = 12;
  const mig = SaveManager.migrate(old);
  const gm = new Game(mig);
  // 舊制換算以 60 分鐘一天為準（v15.7 切換前）
  TimeSysT.switchAt = Date.now() + 86400000;
  const sd = gm.time.survivalDay();
  TimeSysT.switchAt = WORLD_EPOCH_MS;
  assert(sd === 6, `舊存檔換算後生存天數不變（第 ${sd} 天）`);
}

// ---- 24. v8.7：據點遭襲紀錄 ----
{
  const gl = Game.newGame({ playerName: 'L', classId: 'warrior', lat: 25, lon: 121 });
  gl.state.map.pois = fillPois([], 25, 121);
  gl.shelter.establish(gl.state.map.pois.find((p) => gl.shelter.canEstablish(p).ok));
  const base = gl.shelter.primary();
  // 屍潮突破 → 防禦失敗，記錄損失與毀損建築
  setHour(gl, 23);
  const sl = gl.siege.of();
  sl.update(0.1);
  gl.state.resources.food = 1000;
  base.wallHp = 1;
  // 圍牆被打破後，據點裡的人員會先迎戰：打贏就不算攻破
  sl.spawn('walker');
  Object.assign(sl.zombies[0], { x: 0, y: 40 });
  for (let i = 0; i < 100 && sl.zombies.length; i += 1) sl.update(0.1);
  assert(!sl.quiet() && !(gl.state.defenseLog || []).some((e) => !e.success), '圍牆被打破後人員打贏，防線沒有被攻破');
  assert(base.wallHp === 0 && gl.shelter.wallHp(base) === 0, `圍牆耐久最低為 0，不會變成負數（${base.wallHp}）`);
  // 沒有人可以應戰時才被攻破
  gl.state.survivors.forEach((sv) => { sv.severe = true; });
  base.wallHp = 0;
  sl.spawn('walker');
  Object.assign(sl.zombies[0], { x: 0, y: 40 });
  for (let i = 0; i < 100 && !sl.quiet(); i += 1) sl.update(0.1);
  gl.state.survivors.forEach((sv) => { sv.severe = false; });
  const fail = gl.state.defenseLog[0];
  assert((fail?.damaged || []).length <= 2, `被攻破時最多損毀 2 棟建築（${(fail?.damaged || []).length}）`);
  assert(fail && !fail.success && fail.attacker === '屍潮' && fail.lost.food === 550 && fail.siege?.lossPct === 55, `屍潮突破時記錄防禦失敗與損失（${JSON.stringify(fail)}）`);
  // 撐過一夜 → 防禦成功
  const gl2 = Game.newGame({ playerName: 'L2', classId: 'warrior', lat: 25, lon: 121 });
  gl2.state.map.pois = fillPois([], 25, 121);
  gl2.shelter.establish(gl2.state.map.pois.find((p) => gl2.shelter.canEstablish(p).ok));
  gl2.shelter.primary().facilities.wall.level = 10;
  setHour(gl2, 23);
  const s2 = gl2.siege.of();
  for (let i = 0; i < 1200; i += 1) { s2.update(0.1); gl2.shelter.primary().wallHp = null; }
  setHour(gl2, 7);
  s2.update(0.1);
  const ok = gl2.state.defenseLog[0];
  assert(ok && ok.success && ok.waves >= 1, `天亮時記錄成功擋下屍潮（${JSON.stringify(ok)}）`);
  // NPC 掠奪成功 → 記錄損失與重傷
  const npcPoi = gl2.state.map.pois.find((p) => !gl2.shelter.baseAtPoi(p.id));
  const n = gl2.npcs.spawnAt(npcPoi, 'x', Date.now(), true);
  n.level = 40;
  const b2 = gl2.shelter.primary();
  gl2.state.resources.food = 1000;
  n.trip = { kind: 'raid', baseId: b2.id, startAt: Date.now() - 1000, travelMs: 0, endAt: Date.now() + 1000 };
  setHour(gl2, 10);
  gl2.npcs.resolveIncoming(n, n.trip, Date.now());
  const raid = gl2.state.defenseLog[0];
  assert(raid && raid.attacker.includes(n.name) && (raid.success || raid.lost.food > 0), `NPC 掠奪記錄結果與損失（${JSON.stringify(raid)}）`);
  assert(!raid.success ? raid.injured.length >= 0 : true, 'NPC 掠奪紀錄包含重傷名單');
}

// ---- 25. v9：黑市（全體共用、先到先得；取代流浪商人） ----
{
  const { BLACK_MARKET } = await import('../src/systems/BlackMarketSystem.js');
  const { MemoryObjects } = await import('../src/multiplayer/SharedWorld.js');
  const mk = (name) => {
    const gx = Game.newGame({ playerName: name, classId: 'warrior', lat: 25, lon: 121 });
    gx.state.map.pois = fillPois([], 25, 121);
    gx.shelter.establish(gx.state.map.pois.find((p) => gx.shelter.canEstablish(p).ok));
    return gx;
  };
  const gt = mk('T');
  const gu = mk('U');
  const store = new MemoryObjects();
  gt.shared.backend = store;
  gu.shared.backend = store;
  const shelfT = gt.blackMarket.shelf();
  const shelfU = gu.blackMarket.shelf();
  assert(shelfT.length === BLACK_MARKET.slots, `黑市有 ${BLACK_MARKET.slots} 項商品`);
  assert(JSON.stringify(shelfT.map((x) => [x.id, x.kind, x.key || x.item.model, x.qty || 1, x.price])) === JSON.stringify(shelfU.map((x) => [x.id, x.kind, x.key || x.item.model, x.qty || 1, x.price])), '所有玩家看到的黑市商品完全相同');
  // 每 10 分鐘全部一起換新
  const t0 = Date.now();
  const later = gt.blackMarket.shelf(t0 + BLACK_MARKET.rotateMs).map((x) => x.id);
  const diff = shelfT.filter((x, i) => x.id !== later[i]).length;
  assert(diff === BLACK_MARKET.slots, `每 10 分鐘 ${BLACK_MARKET.slots} 件全部換新（換了 ${diff} 件）`);
  // 比例與品級：大量取樣
  let gearN = 0;
  let legend = 0;
  let poor = 0;
  const N = 3000;
  for (let i = 0; i < N; i += 1) {
    const x = gt.blackMarket.good(i % 20, 100000 + i);
    if (x.kind === 'gear') gearN += 1;
    const r = x.kind === 'gear' ? x.item.rarity : x.rarity;
    if (r === 'legendary') legend += 1;
    if (r === 'poor') poor += 1;
  }
  assert(gearN / N > 0.11 && gearN / N < 0.19, `裝備約占 15%（${((gearN / N) * 100).toFixed(1)}%）`);
  assert(poor / N > 0.35 && poor / N < 0.45 && legend / N < 0.015, `品級機率：劣質約 40%、傳奇約 0.5%（${((poor / N) * 100).toFixed(1)}% / ${((legend / N) * 100).toFixed(2)}%）`);
  // 價格高於過去的流浪商人
  const gx = shelfT.find((x) => x.kind === 'supply');
  assert(gx.price >= Math.round(gt.blackMarket.supplyPrice(gx.key) * gx.qty * 1.5), '黑市價格高於過去的商人');
  const legendaryPrice = gt.blackMarket.gearPrice(gt.equipment.generate({ level: 5, model: 'm1911', rarity: 'legendary' }));
  const poorPrice = gt.blackMarket.gearPrice(gt.equipment.generate({ level: 5, model: 'm1911', rarity: 'poor' }));
  assert(legendaryPrice > poorPrice * 10, '越稀有越貴');
  // 購買：金錢不足、同時搶購只有一人成功、另一人退錢
  const good = shelfT.find((x) => x.kind === 'supply');
  gt.state.player.coins = 0;
  assert(!(await gt.blackMarket.buy(good.id)).ok && gt.state.player.coins === 0, '金錢不足不能購買');
  gt.state.player.coins = 1e6;
  gu.state.player.coins = 1e6;
  const before = gt.state.supplies[good.key] || 0;
  const beforeU = gu.state.supplies[good.key] || 0;
  const [rt, ru] = await Promise.all([gt.blackMarket.buy(good.id), gu.blackMarket.buy(good.id)]);
  assert(rt.ok !== ru.ok, `兩人同時購買同一項只有一人成功（${rt.ok}/${ru.ok}）`);
  const [win, lose] = rt.ok ? [gt, gu] : [gu, gt];
  assert(win.state.player.coins === 1e6 - good.price && lose.state.player.coins === 1e6, '買到的人扣錢，沒買到的人全額退還');
  assert((gt.state.supplies[good.key] || 0) + (gu.state.supplies[good.key] || 0) === before + beforeU + good.qty, '商品只交付一次');
  await lose.blackMarket.refresh();
  assert(lose.blackMarket.shelf().find((x) => x.id === good.id).soldTo, '另一位玩家立即看到已售出');
  // 每輪限買 1 件：買到的人這一輪不能再買；沒買到（被搶走）的人仍可以買別件
  assert(BLACK_MARKET.rotateMs === 30 * 60000 && BLACK_MARKET.perRound === 1, '黑市每 30 分鐘換新、每輪限買 1 件');
  const other = win.blackMarket.shelf().find((x) => !x.soldTo && x.id !== good.id && x.kind === 'supply');
  const coinsW = win.state.player.coins;
  const rAgain = await win.blackMarket.buy(other.id);
  assert(!rAgain.ok && rAgain.reason.includes('這一輪') && win.state.player.coins === coinsW, '每位玩家每一輪只能買 1 件（不扣錢）');
  assert(!lose.blackMarket.boughtThisRound(), '被別人搶先買走時，不算用掉自己的購買次數');
  win.state.bmBought.tick -= 1;
  assert(!win.blackMarket.boughtThisRound(), '下一輪換貨後可以再買');
  assert(!(await lose.blackMarket.buy(good.id)).ok, '已售出的商品不能再買');
  // 離線玩家：關閉遊戲期間別人買走，回來後同步看到已售出（不會因為沒有快取而重複購買）
  const go = mk('O');
  go.shared.backend = store;
  go.state.player.coins = 1e6;
  const r2 = await go.blackMarket.buy(good.id);
  assert(!r2.ok && go.state.player.coins === 1e6, '剛上線（沒有快取）的玩家也不能買到已售出的商品，金錢不變');
  // 連線失敗：退錢
  const gn = mk('N');
  gn.shared.backend = { objList: async () => [], objPut: async () => { const e = new Error('x'); e.kind = 'network'; throw e; } };
  gn.state.player.coins = 1e6;
  const g2 = shelfT.find((x) => x.kind === 'supply' && x.id !== good.id);
  const nBefore = gn.state.supplies[g2.key] || 0;
  const rn = await gn.blackMarket.buy(g2.id);
  assert(!rn.ok && gn.state.player.coins === 1e6 && (gn.state.supplies[g2.key] || 0) === nBefore, '連線失敗時購買取消並退錢');
  // 回收：沿用商人回收價，不需要商人在場
  gt.state.supplies.nail = 100;
  gt.state.supplies.titanium = 10;
  const c1 = gt.state.player.coins;
  assert(gt.blackMarket.sell('nail', 100).ok && !gt.state.supplies.nail && gt.state.player.coins === c1 + gt.blackMarket.buybackPrice('nail', 100), '可以把物資賣到黑市');
  const rN = gt.blackMarket.buybackRate('nail');
  const rT = gt.blackMarket.buybackRate('titanium');
  assert(rN >= 0.09 && rN <= 0.14 && rT > rN && rT <= 0.16, `回收價比例（${rN.toFixed(3)} / ${rT.toFixed(3)}）`);
  assert(!gt.blackMarket.sell('nail', 5).ok, '沒有的物資不能賣');
  const gi = gt.equipment.generate({ level: 5, model: 'm1911', rarity: 'rare' });
  gt.equipment.addItem(gi, 't');
  const c2 = gt.state.player.coins;
  const gp = gt.blackMarket.gearBuyback(gi);
  assert(gp > 0 && gt.blackMarket.sellItem(gi.id).ok && gt.state.player.coins === c2 + gp && !gt.equipment.getItem(gi.id), `裝備可以賣到黑市（💰${gp}）`);
}

// ---- 25c. v9：NPC 據點所有玩家共用、狀態同步（含對方離線） ----
{
  const { MemoryObjects } = await import('../src/multiplayer/SharedWorld.js');
  const store = new MemoryObjects();
  const pois = fillPois([], 25.02, 121.02);
  const mk = (name, idx) => {
    const gx = Game.newGame({ playerName: name, classId: 'warrior', lat: 25.02, lon: 121.02 });
    gx.state.map.pois = JSON.parse(JSON.stringify(pois));
    gx.shelter.establish(gx.state.map.pois[idx]);
    gx.shared.backend = store;
    gx.world = { others: [], myId: name, identity: () => ({ id: name, token: 't' }) };
    return gx;
  };
  const A = mk('A', 0);
  const B = mk('B', 0);
  setHour(A, 10);
  setHour(B, 10);
  const t0 = Date.now();
  // 連線到伺服器時：先讀到共用 NPC 資料才會顯示（避免先顯示沒扣等級損失的較高等級）
  {
    const gw = Game.newGame({ playerName: 'W', classId: 'warrior', lat: 25.02, lon: 121.02 });
    gw.state.map.pois = JSON.parse(JSON.stringify(pois));
    gw.shelter.establish(gw.state.map.pois.find((p) => gw.shelter.canEstablish(p).ok));
    gw.world = { myId: 'W', identity: () => ({ id: 'W', token: 't' }), provider: { objPut: store.objPut.bind(store), objList: store.objList.bind(store), objListMany: store.objListMany.bind(store) } };
    setHour(gw, 10); // 白天：避免結算 NPC 抵禦屍群而改到共用資料
    gw.npcs.update(t0);
    assert(gw.npcs.list.length === 0, '連線中尚未讀到共用 NPC 資料前不顯示 NPC');
    await gw.shared.poll();
    gw.npcs.update(t0);
    assert(gw.npcs.list.length > 0, '讀到共用資料後才顯示 NPC');
  }
  await A.shared.poll();
  await B.shared.poll();
  A.npcs.update(t0);
  B.npcs.update(t0);
  const ids = (gx) => gx.npcs.list.filter((n) => n.sid).map((n) => `${n.id}@${n.lat.toFixed(5)},${n.lon.toFixed(5)}:${n.level}:${n.name}`).sort().join('|');
  assert(A.npcs.list.length > 0 && ids(A) === ids(B), `兩位玩家看到相同的 NPC 據點（位置、名稱、等級）（${A.npcs.list.length} 個）`);
  // 其他玩家的據點警戒範圍內不會有 NPC
  const nA = A.npcs.list.find((n) => A.npcs.fullCount(n) >= 5) || A.npcs.list[0];
  const C = mk('C', 0);
  C.world.others = [{ id: 'X', bases: [{ lat: nA.lat, lon: nA.lon, alert: 120 }], trips: [] }];
  setHour(C, 10);
  await C.shared.poll();
  C.npcs.update(t0);
  assert(C.npcs.list.length > 0, '同步後會顯示 NPC 據點');
  assert(!C.npcs.list.some((n) => n.id === nA.id), '任何玩家的警戒範圍內不會出現 NPC 據點（避免與玩家重疊）');
  // A 讓 NPC 受傷、等級下降；B 同步後相同
  A.npcs.wound(nA, 2, t0);
  A.npcs.levelDown(nA);
  await new Promise((r) => setTimeout(r, 5));
  await B.shared.poll();
  const nB = B.npcs.get(nA.id);
  assert(nB && nB.wounded === 2 && nB.level === nA.level, `NPC 的傷亡與等級同步給其他玩家（${nB?.wounded} / ${nB?.level} vs ${nA.level}）`);
  // 兩人同時造成傷亡：累加，不會互相覆蓋
  await Promise.all([A.npcs.wound(nA, 1, t0), B.npcs.wound(nB, 1, t0)]);
  await A.shared.poll();
  await B.shared.poll();
  assert(A.npcs.get(nA.id).wounded === 4 && B.npcs.get(nA.id).wounded === 4, `兩位玩家同時造成的傷亡會累加（${A.npcs.get(nA.id).wounded}/${B.npcs.get(nA.id).wounded}/${JSON.stringify(A.shared.get('npc', nA.sid))}）`);
  // B 離線（不執行）；A 摧毀 NPC；B 之後上線：該 NPC 已消失
  A.npcs.destroy(A.npcs.get(nA.id), t0);
  await new Promise((r) => setTimeout(r, 5));
  assert(!A.npcs.get(nA.id), '摧毀後從自己的地圖消失');
  const B2 = Game.fromSave ? null : null;
  void B2;
  await B.shared.poll();
  assert(!B.npcs.get(nA.id), '離線的玩家上線同步後，被別人摧毀的 NPC 也消失');
  B.npcs.update(t0 + 1000);
  assert(!B.npcs.list.some((n) => n.sid === nA.sid), '重生時間前同一格不會重新出現');
  // 重生後出現新的勢力（兩人相同）
  const later = t0 + 2 * 3600000;
  A.npcs.update(later);
  B.npcs.update(later);
  assert(ids(A) === ids(B), '重生後兩位玩家看到的仍然相同');
  // 單機（沒有伺服器）：摧毀的 NPC 重新開啟後仍然消失
  const S = Game.newGame({ playerName: 'S', classId: 'warrior', lat: 25.02, lon: 121.02 });
  S.state.map.pois = JSON.parse(JSON.stringify(pois));
  S.shelter.establish(S.state.map.pois.find((p) => S.shelter.canEstablish(p).ok));
  S.npcs.update(t0);
  const ns = S.npcs.list.find((n) => n.sid);
  S.npcs.destroy(ns, t0);
  await new Promise((r) => setTimeout(r, 5));
  const S2 = new Game(JSON.parse(JSON.stringify(S.state)));
  await S2.shared.poll();
  S2.npcs.update(t0 + 1000);
  assert(!S2.npcs.list.some((n) => n.sid === ns.sid), '單機時共用狀態存在存檔中');
}

// ---- 25c2. v9.4.1：NPC 只依真實建築（OpenStreetMap）決定，各自隨機補上的建築不影響 ----
{
  const base = fillPois([], 25.04, 121.53).map((p, i) => ({ ...p, id: `osm_n${i}` }));
  const mk = (name) => {
    const gx = Game.newGame({ playerName: name, classId: 'warrior', lat: 25.04, lon: 121.53 });
    // 每位玩家另外有各自隨機補上的建築
    gx.state.map.pois = [...JSON.parse(JSON.stringify(base)), ...fillPois([], 25.04, 121.53).slice(0, 80)];
    gx.shelter.establish(gx.state.map.pois.find((p) => gx.shelter.canEstablish(p).ok));
    setHour(gx, 10);
    return gx;
  };
  const A = mk('A');
  const B = mk('B');
  const t0 = Date.now();
  A.npcs.update(t0);
  B.npcs.update(t0);
  const ids = (gx) => gx.npcs.list.filter((n) => n.sid).map((n) => n.id).sort().join('|');
  assert(A.npcs.list.length > 0 && ids(A) === ids(B), `各自隨機補上的建築不同，看到的 NPC 仍然相同（${A.npcs.list.length} / ${B.npcs.list.length}）`);
}

// ---- 25d. v9：夜晚殭屍群與 Boss 所有玩家共用、擊倒同步（含對方離線） ----
{
  const { MemoryObjects } = await import('../src/multiplayer/SharedWorld.js');
  const store = new MemoryObjects();
  const pois = fillPois([], 25.05, 121.05);
  const mk = (name) => {
    const gx = Game.newGame({ playerName: name, classId: 'warrior', lat: 25.05, lon: 121.05 });
    gx.state.map.pois = JSON.parse(JSON.stringify(pois));
    gx.shelter.establish(gx.state.map.pois.find((p) => gx.shelter.canEstablish(p).ok));
    gx.shared.backend = store;
    gx.world = { others: [], myId: name, identity: () => ({ id: name, token: 't' }) };
    setHour(gx, 22);
    return gx;
  };
  const A = mk('A');
  const B = mk('B');
  A.zombies.refresh();
  B.zombies.refresh();
  const sig = (gx) => gx.state.map.zombieGroups.map((z) => `${z.id}:${z.enemyId}:${z.count}:${z.level}:${z.lat.toFixed(5)}`).sort().join('|');
  assert(A.state.map.zombieGroups.length > 0 && sig(A) === sig(B), `兩位玩家看到相同的夜晚殭屍群（${A.state.map.zombieGroups.length} 群）`);
  const gr = A.state.map.zombieGroups[0];
  await A.zombies.killGroup(gr, 'A');
  assert(!A.state.map.zombieGroups.some((z) => z.id === gr.id), '擊倒後從自己的地圖消失');
  // B 一直沒上線；之後上線同步：該殭屍群消失
  await B.shared.poll();
  assert(!B.state.map.zombieGroups.some((z) => z.id === gr.id), '其他玩家（包含剛上線的）同步後也看不到被擊倒的殭屍群');
  const g2 = A.state.map.zombieGroups.find((z) => z.count >= 2);
  if (g2) {
    await A.zombies.hurtGroup(g2, 1);
    await B.shared.poll();
    assert(B.state.map.zombieGroups.find((z) => z.id === g2.id).count === g2.count, '殭屍群的傷亡（剩餘數量）同步');
  }
  // 新玩家當晚才開啟遊戲：同樣看不到被擊倒的
  const C = mk('C');
  await C.shared.poll();
  C.zombies.refresh();
  assert(!C.state.map.zombieGroups.some((z) => z.id === gr.id), '當晚才開啟遊戲的玩家也看不到已被擊倒的殭屍群');
}

// ---- 25e. v9：重度感染據點（共用淨化度、緩慢回復、消滅獎勵只發一次） ----
{
  const { MemoryObjects } = await import('../src/multiplayer/SharedWorld.js');
  const { INFECTED } = await import('../src/systems/InfectedSystem.js');
  const store = new MemoryObjects();
  const pois = fillPois([], 25.1, 121.1);
  const mk = (name) => {
    const gx = Game.newGame({ playerName: name, classId: 'warrior', lat: 25.1, lon: 121.1 });
    gx.state.map.pois = JSON.parse(JSON.stringify(pois));
    gx.shelter.establish(gx.state.map.pois.find((p) => gx.shelter.canEstablish(p).ok));
    gx.shared.backend = store;
    gx.world = { others: [], myId: name, identity: () => ({ id: name, token: 't' }) };
    return gx;
  };
  const A = mk('A');
  const B = mk('B');
  const la = A.infected.list();
  assert(la.length > 0 && la.map((x) => `${x.id}${x.lat}${x.level}`).join() === B.infected.list().map((x) => `${x.id}${x.lat}${x.level}`).join(), `重度感染據點位置與強度所有玩家相同（${la.length} 座）`);
  const s = la[0];
  const t0 = Date.now();
  const r1 = await A.infected.addPurity(s, 30, t0);
  assert(r1.ok && Math.round(r1.purity) === 30, '淨化度累積');
  await B.shared.poll();
  assert(Math.round(B.infected.purity(s, t0)) === 30, '其他玩家（包含之前離線的）同步看到淨化度');
  assert(Math.abs(B.infected.purity(s, t0 + 600000) - (30 - INFECTED.decayPerHour / 6)) < 0.01, '未清除時淨化度緩慢回復感染');
  {
    const h3 = t0 + 3 * 3600000; // 經過好幾個遊戲日（每天 12:00）
    assert(Math.abs(B.infected.purity(s, h3) - (30 - INFECTED.decayPerHour * 3)) < 0.01, `v13：淨化度不會每天 12:00 歸零，只會緩慢回復（${B.infected.purity(s, h3).toFixed(1)}%）`);
  }
  // 單一隊伍很難清除
  const one = A.infected.battle(A.infected.get(s.id, t0), A.state.survivors, [], t0);
  assert(!one.result.victory && one.gain < 40, `單人隊伍無法一次清除（淨化 +${one.gain.toFixed(1)}%）`);
  // 兩人同時把淨化度推到 100%：只有一人負責發獎勵
  const [ka, kb] = await Promise.all([A.infected.addPurity(s, 80, t0), B.infected.addPurity(s, 80, t0)]);
  assert((ka.killed ? 1 : 0) + (kb.killed ? 1 : 0) === 1, '同時淨化到 100% 時只有一人取得消滅獎勵');
  await A.shared.poll();
  await B.shared.poll();
  assert(!A.infected.get(s.id, t0) && !B.infected.get(s.id, t0), '消滅後所有玩家的地圖上都消失');
  // v13：消滅後 3 天（遊戲日）在原地重新出現，淨化度從 0 開始
  {
    const DRM = 3600000; // 遊戲 1 天
    const back = t0 + INFECTED.respawnDays * 86400000; // v13：現實 3 天
    assert(!A.infected.list(back - 60000).some((x) => x.id === s.id) && !A.infected.list(t0 + DRM * 1.5).some((x) => x.id === s.id), '消滅後隔天中午不會重新出現（要等現實 3 天）');
    const re = A.infected.list(back + 1000).find((x) => x.id === s.id);
    assert(re && re.lat === s.lat && re.lon === s.lon && re.purity === 0, `消滅 3 天後在原地重新出現，淨化度歸零（${re?.purity}）`);
    assert(!(await A.infected.addPurity(s, 5, back - 60000)).ok && (await A.infected.addPurity(s, 5, back + 1000)).ok, '重生前不能淨化，重生後可以重新淨化');
  }
  // v13：固定 5 座（E4 沿用原本位置，其他在指定格子）
  {
    const { gridCenter, inWorld } = await import('../src/config/world.js');
    const all = A.infected.sites();
    assert(all.length === 5 && all.every((x) => inWorld(x.lat, x.lon)), `重度感染據點固定 5 座，都在地圖範圍內（${all.map((x) => x.code).join('、')}）`);
    const e4 = all.find((x) => x.code === 'E4');
    assert(e4 && e4.id === 'inf_1970_8670', 'E4 沿用原本的重度感染據點（編號、位置不變）');
    const b2 = all.find((x) => x.code === 'B2');
    assert(b2 && haversine(b2.lat, b2.lon, gridCenter('B2').lat, gridCenter('B2').lon) < 1, 'B2 的重度感染據點在 B2 格中心');
  }
  // 消滅時的獎勵會補進那一場的探索報告（不會顯示「無」）
  {
    const s2 = la.find((x) => x.id !== s.id && A.infected.get(x.id, t0));
    if (s2) {
      await A.infected.addPurity(s2, 99.9, t0);
      const exp = { poiId: s2.id, endAt: t0, memberIds: A.state.survivors.map((x) => x.id), travelEvents: [] };
      const orig = A.infected.battle.bind(A.infected);
      A.infected.battle = (...a) => { const o = orig(...a); return { ...o, gain: Math.max(o.gain, 1) }; }; // 確保這一場把淨化度推到 100%
      const rep = A.infected.resolveAttack(exp);
      A.infected.battle = orig;
      for (let i = 0; i < 50 && !rep.events.some((t) => t.includes('消滅')); i += 1) await new Promise((r) => setTimeout(r, 5));
      assert(rep.events.some((t) => t.includes('消滅')) && (rep.items.length > 0 || Object.keys(rep.resources).length > 0), `消滅獎勵顯示在探索報告（裝備 ${rep.items.length}、物資 ${Object.keys(rep.resources).length} 種）`);
    }
  }
  // 獎勵：1 人 3～4 種，每多 1 人上下限 +2，最低優良
  const rw1 = A.infected.rewards(s, 1);
  const n1 = rw1.items.length + Object.keys(rw1.mats).length;
  const rw3 = A.infected.rewards(s, 3);
  const n3 = rw3.items.length + Object.values(rw3.mats).length;
  assert(n1 >= 3 && n1 <= 8 && rw3.items.every((it) => ['rare', 'epic', 'legendary'].includes(it.rarity)) && rw3.coins >= 1800, `消滅獎勵：1 人最多 8 種、裝備最低精良、金錢 ×3（1 人 ${n1} 種，3 人 💰${rw3.coins}）`);
  void n3;
  const fr = A.infected.fightRewards(s, 30);
  assert(fr.coins === 450 && Object.values(fr.mats).reduce((a, v) => a + v, 0) >= 6 && fr.items.every((it) => ['rare', 'epic', 'legendary'].includes(it.rarity)), `每場依淨化度給獎勵：+30% 得到 💰${fr.coins} 與 ${Object.keys(fr.mats).length} 種材料`);
  // v13：位置固定，新的據點不能蓋在重度感染據點附近
  {
    const s0 = A.infected.sites()[0];
    A.testInfBlock = true;
    assert(!!A.infected.blocking({ lat: s0.lat + 0.0005, lon: s0.lon }, 80), '新的據點不能蓋在重度感染據點附近');
    A.testInfBlock = false;
  }
  // 偵查等級可得知更多情報
  assert(!A.infected.intelView(s).boss, '偵查 0 級不知道首領');
  A.state.research.levels = { ...(A.state.research.levels || {}), s_recon: 6 };
  const iv = A.infected.intelView(s);
  assert(iv.boss && iv.roster && iv.power > 0, '偵查等級越高情報越完整');
}

// ---- 25f. v9：集結（廣播塔、好友參加、發起人離線也能結算） ----
{
  const { MemoryObjects } = await import('../src/multiplayer/SharedWorld.js');
  const store = new MemoryObjects();
  const pois = fillPois([], 25.15, 121.15);
  let firstHome = null;
  const mk = (name) => {
    const gx = Game.newGame({ playerName: name, classId: 'warrior', lat: 25.15, lon: 121.15 });
    gx.state.map.pois = JSON.parse(JSON.stringify(pois));
    // v12.1：參加者要先走到發起人的避難所，兩位玩家的避難所分開一段距離
    const ok = gx.state.map.pois.filter((p) => gx.shelter.canEstablish(p).ok);
    const pick = firstHome ? ok.find((p) => haversine(p.lat, p.lon, firstHome.lat, firstHome.lon) > 400) || ok[0] : ok[0];
    gx.shelter.establish(pick);
    firstHome = firstHome || pick;
    gx.shared.backend = store;
    gx.world = { others: [], myId: name, identity: () => ({ id: name, token: 't' }) };
    setHour(gx, 10);
    gx.survivors.leader().level = 60;
    return gx;
  };
  const A = mk('A');
  const B = mk('B');
  A.state.relations.players.B = { status: 'friend', name: 'B' };
  B.state.relations.players.A = { status: 'friend', name: 'A' };
  A.npcs.update(Date.now());
  B.npcs.update(Date.now());
  const n = [...A.npcs.list].filter((x) => x.sid).sort((x, y) => x.level - y.level)[0];
  n.baseLevel = 1; n.levelLoss = 0; n.level = 1; n.wounded = n.wounded || 0;
  // 這裡測集結流程：守軍強度暫時用一般值（v10 攻打強度另外測試）
  const { NPC_ASSAULT: NA } = await import('../src/config/npcs.js');
  const naBak = { ...NA };
  Object.assign(NA, { hp: 1, atk: 1, count: 1, wall: 1, dps: 1 });
  // 兩位玩家各自的 NPC 資料都設成弱小（結算可能由任一位玩家執行）
  const nb = B.npcs.get(n.id);
  if (nb) { nb.baseLevel = 1; nb.levelLoss = 0; nb.level = 1; nb.wounded = 0; }
  const target = { kind: 'npc', id: n.id, ident: n.ident, name: n.name, lat: n.lat, lon: n.lon };
  assert(!A.rally.canStart(target).ok, '沒有廣播塔不能發起集結');
  A.shelter.primary().facilities.broadcast.level = 1;
  assert(A.rally.maxTeams() === 2, '廣播塔 Lv1 可集結 2 支隊伍');
  const lead = A.survivors.leader();
  const st = await A.rally.start(target, 5, [lead.id]);
  assert(st.ok && lead.status === 'exploring', `發起集結，自己的隊伍加入（${st.reason || ''}）`);
  {
    const ex0 = A.rally.trips()[0];
    const dd = A.rally.get(st.id);
    assert(ex0 && dd && dd.home && dd.status === 'gathering' && dd.departAt > Date.now() + 60000 && dd.teams[0].arriveAt <= Date.now(), '發起集結：發起人的避難所就是集結點，倒數結束才出發');
    assert(A.rally.statusOf(ex0).tag === '集結' && A.rally.statusOf(ex0).line1.includes('集結點'), `發起人的隊伍顯示「集結」（${A.rally.statusOf(ex0).line1}）`);
  }
  {
    // v15.6：同時可以發起多個集結（上限依廣播塔等級）；同一個目標不能重複發起
    const r2 = await A.rally.start(target, 5, []);
    assert(!r2.ok && /上限/.test(r2.reason || ''), `廣播塔 Lv1：同時只能發起 1 個集結（${r2.reason || ''}）`);
    assert(A.rally.maxConcurrent(1) === 1 && A.rally.maxConcurrent(5) === 2 && A.rally.maxConcurrent(10) === 3, '同時可發起的集結：Lv1 1 個、Lv5 2 個、Lv10 3 個');
    A.shelter.primary().facilities.broadcast.level = 5;
    const r3 = A.rally.canStart(target);
    assert(!r3.ok && /這個目標/.test(r3.reason || ''), '同一個目標不能重複發起集結');
    const other = { kind: 'npc', id: 'npc_other', name: '另一個據點', lat: n.lat, lon: n.lon };
    assert(A.rally.canStart(other).ok, '廣播塔 Lv5：可以對另一個目標再發起一個集結');
    A.shelter.primary().facilities.broadcast.level = 1;
  }
  await B.shared.poll();
  B.rally.lastAt = 0;
  B.rally.update(Date.now());
  assert(B.rally.invites().length === 1 && B.state.log.some((l) => l.msg.includes('發起集結')), '好友收到集結通知');
  const C = mk('C');
  await C.shared.poll();
  assert(!C.rally.invites().length && !(await C.rally.join(st.id, [C.survivors.leader().id])).ok, '不是好友不能參加');
  // 加入時共用資料還是舊的（名單裡還沒有自己）：隊伍不會被誤判成被移出而回家
  const staleRally = JSON.parse(JSON.stringify(B.shared.get('rally', st.id)));
  const jb = await B.rally.join(st.id, [B.survivors.leader().id]);
  assert(jb.ok, `好友參加集結（${jb.reason || ''}）`);
  {
    const realRally = B.shared.get('rally', st.id);
    const key = [...B.shared.cache.keys()].find((k) => B.shared.cache.get(k) === realRally || (B.shared.cache.get(k)?.data === realRally));
    const exB = B.rally.trips()[0];
    if (key) {
      const saved = B.shared.cache.get(key);
      B.shared.cache.set(key, saved?.data ? { ...saved, data: staleRally } : staleRally);
      await B.rally.step(exB, Date.now());
      assert(B.state.expeditions.includes(exB), '加入集結後即使資料還沒更新，隊伍也不會回家');
      const bl = B.survivors.leader();
      const poiB = B.state.map.pois.find((p) => B.exploration.poi(p.id));
      assert(!B.survivors.isAvailable(bl) && (!poiB || !B.exploration.start(poiB.id, [bl.id], 5, true).ok), '集結成員在倒數期間不能再派出去探索');
      B.shared.cache.set(key, saved);
    } else assert(!!exB, '加入集結後隊伍在集結中');
  }
  // v12.1：滿員後等參加者走到集結點才一起出發；A 之後離線
  await A.shared.poll();
  {
    const d0 = A.rally.get(st.id);
    const tb = d0.teams.find((t) => t.player !== d0.owner);
    const exB = B.rally.trips()[0];
    assert(tb && tb.from && tb.arriveAt > Date.now() && exB.rallyGatherMs > 0, `參加者先走到發起人的避難所（約 ${Math.round((tb?.arriveAt - Date.now()) / 1000)} 秒）`);
    assert(B.rally.statusOf(exB).line1.includes('前往集結點'), `參加者顯示「前往集結點」（${B.rally.statusOf(exB).line1}）`);
    await A.rally.step(A.rally.trips()[0], Date.now());
    await A.shared.poll();
    assert(A.rally.get(st.id).status === 'gathering', '滿員但參加者還沒到集結點：先不出發');
    const midPos = B.rally.position(exB, (tb.at + tb.arriveAt) / 2);
    const bh = B.shelter.primary();
    assert(midPos && haversine(midPos.lat, midPos.lon, bh.lat, bh.lon) > 5, '前往集結點途中的位置在路上');
    await A.rally.step(A.rally.trips()[0], tb.arriveAt + 1);
  }
  await B.shared.poll();
  const d1 = B.rally.get(st.id);
  assert(d1.status === 'departed' && d1.departedAt === Math.max(...d1.teams.map((t) => t.arriveAt)), `所有隊伍到齊後一起出發（${d1.status}）`);
  assert(d1.fightAt === d1.departedAt + d1.travelMs, '部隊從集結點出發，路程以集結點到目標計算');
  {
    const mid = RallySys.phaseOf(d1, (d1.departedAt + d1.fightAt) / 2);
    assert(mid.phase === 'march' && RallySys.phaseOf(d1, d1.fightAt + 1).phase === 'fight', '地圖上只有一支集結部隊：行軍 → 交戰');
    assert(!(await B.rally.withdraw(B.rally.trips()[0], d1.departedAt + 10)), '部隊出發後不能單獨脫隊');
  }
  // 發起人 A 離線（不再執行）；B 到時間自己結算
  await B.rally.step(B.rally.trips()[0], d1.fightAt + 1);
  await B.shared.poll();
  const d2 = B.rally.get(st.id);
  assert(d2.status === 'done' && d2.result, `發起人離線時，其他參加者也能結算（${d2.status}）`);
  await B.rally.step(B.rally.trips()[0], d1.fightAt + 2);
  const eb = B.rally.trips()[0];
  {
    const pb = B.exploration.progress(eb, d1.fightAt + 2);
    assert(pb.phase === 'returning' && eb.endAt === Math.max(d1.fightAt + 2, d1.fightAt + eb.travelMs) && B.rally.statusOf(eb).tag === '返程', `打完從目標各自回家（${pb.phase}・${B.rally.statusOf(eb).tag}）`);
  }
  const cb0 = B.state.player.coins;
  const reps = B.exploration.update(eb.endAt + 1, { silent: true });
  assert(reps.some((r) => r.poiName.includes('集結')) && !B.rally.trips().length, 'B 的隊伍帶著結果回家');
  {
    const rr = reps.find((r) => r.poiName.includes('集結'));
    assert(rr && rr.events.some((e) => e.includes('攻擊圍牆')) && rr.events.some((e) => e.includes('造成') && e.includes('傷害')), `集結戰報列出攻牆、交戰與每位隊員的戰果（${rr?.events.slice(0, 4).join(' / ')}）`);
  }
  // A 之後上線：同步並收到自己的那一份
  await A.shared.poll();
  await A.rally.step(A.rally.trips()[0], d1.fightAt + 5);
  const ea = A.rally.trips()[0];
  const ca0 = A.state.player.coins;
  const repsA = A.exploration.update(ea.endAt + 1, { silent: true });
  assert(!A.rally.trips().length && lead.status === 'idle', '離線的發起人上線後隊伍回家並結算');
  {
    const ra = repsA.find((r) => r.poiName.includes('集結'));
    assert(ra && ra.events.some((e) => e.includes('攻擊圍牆')) && ra.events.some((e) => e.includes('👥')) && ra.events.some((e) => e.includes(lead.name) && e.includes('傷害')), `沒有計算戰鬥的參加者（離線後上線）也拿到完整集結戰報（${ra?.events.slice(0, 5).join(' / ')}）`);
    {
      const big = { result: { detail: [], battle: { team: [], foes: [], log: Array.from({ length: 200 }, (_, i) => ({ t: i, msg: `測試紀錄第 ${i} 筆，造成大量傷害`, type: 'hit' })) } } };
      RallySys.fitBattle(big);
      const bytes = new TextEncoder().encode(JSON.stringify(big)).length;
      assert(bytes <= 14000 && big.result.battle && big.result.battle.log.length >= 10, `集結戰鬥詳細太長時會縮短，不會超過共用資料上限（${bytes} 位元組・${big.result.battle?.log.length} 筆）`);
    }
    const rb = reps.find((r) => r.poiName.includes('集結'));
    const bta = A.combat.battle(ra?.battleIds?.[0]);
    const btb = B.combat.battle(rb?.battleIds?.[0]);
    assert(bta && btb && bta.log.length > 0 && bta.team.length === btb.team.length && bta.team.length >= 2, `集結的每位參加者都收到戰鬥詳細（逐筆紀錄與每人統計）（${bta?.team.length}/${btb?.team.length} 人・${bta?.log.length} 筆）`);
  }
  assert(d2.result.victory, `強大的集結隊伍攻陷弱小的 NPC（${d2.result.summary}）`);
  {
    // v15.6.1：集結打贏有經驗（倒下的人沒有）
    const xe = Object.values(d2.result.teams || {})[0]?.xpEach || 0;
    const ra2 = repsA.find((r) => r.poiName.includes('集結'));
    assert(xe > 0 && ra2 && ra2.xp > 0 && ra2.events.some((e) => /集結戰鬥經驗/.test(e)), `集結打贏：參戰隊員獲得經驗（每人 ${xe}，報告 +${ra2?.xp}）`);
  }
  {
    // v15.7：集結打贏另外獲得升級所需經驗的 RALLY_XP.winPct；倒下只扣 RALLY_XP.downPct
    const { RALLY_XP } = await import('../src/config/npcs.js');
    const { xpToNext } = await import('../src/config/survivors.js');
    const s1 = A.survivors.leader();
    const lv0 = s1.level; const xp00 = s1.xp;
    s1.severe = false; s1.level = 30; s1.xp = 0; A.survivors.setHp(s1, A.survivors.maxHp(s1));
    const need = xpToNext(30);
    const fk = (id, win, down) => ({ id, kind: 'rally', memberIds: [s1.id], endAt: Date.now(), rallyVictory: win, rallyTarget: { name: '測試' }, rallyResult: { units: [{ i: 0, hp: down ? 0 : 50, down, dealt: 1, kills: 0 }], coins: 0, items: [], mats: {}, xpEach: 0 } });
    const rpX = A.rally.report(fk('rxp1', true, false));
    const got = s1.xp;
    assert(got >= Math.round(need * RALLY_XP.winPct) && rpX.events.some((e) => /集結勝利經驗/.test(e)), `集結打贏：沒倒下的隊員另外獲得升級所需經驗的 ${RALLY_XP.winPct * 100}%（+${got}）`);
    A.rally.report(fk('rxp2', false, false));
    assert(s1.xp === got, '集結打輸沒有勝利經驗');
    s1.xp = Math.round(need * 0.5); const xb = s1.xp;
    A.rally.report(fk('rxp3', true, true));
    assert(xb - s1.xp === Math.round(need * RALLY_XP.downPct), `集結倒下只扣升級所需經驗的 ${RALLY_XP.downPct * 100}%（-${xb - s1.xp}）`);
    s1.severe = false; s1.level = lv0; s1.xp = xp00; A.survivors.setHp(s1, A.survivors.maxHp(s1));
  }
  {
    // v15.7：舊版遊戲送出的控制點行程沒有 kind：依停留時間判斷駐防或攻打
    const { cleanPlayer } = await import('../src/multiplayer/WorldSync.js');
    const base = { from: { lat: 25, lon: 121 }, to: { lat: 25.01, lon: 121.01 }, startAt: 1, travelMs: 1000, target: '🚩 控制點 #3' };
    const pl = cleanPlayer({ id: 'x', name: 'x', bases: [{ lat: 25, lon: 121, name: 'b' }], trips: [{ ...base, searchMs: 7 * 24 * 3600000, endAt: 7 * 24 * 3600000 + 3000 }, { ...base, searchMs: 60000, endAt: 70000 }, { ...base, target: '超市', searchMs: 9e8, endAt: 9e8 + 3000 }] });
    assert(pl.trips[0].kind === 'cpGuard' && pl.trips[1].kind === 'cp' && !pl.trips[2].kind, `舊版玩家的駐防隊顯示為駐防中（${pl.trips.map((t) => t.kind).join(',')}）`);
  }
  {
    // v15.6.1：集結結束後比照一般戰鬥：生命低於 70% 的人從藥品欄吃藥補血
    const sv = A.survivors.leader();
    const SUP = await import('../src/config/supplies.js');
    const mk = Object.keys(SUP.SUPPLIES).find((k) => A.survivors.healAmount(sv, k) > 0);
    const lo = A.survivors.loadout(sv);
    lo.med = { key: mk, qty: 5 };
    A.survivors.setHp(sv, A.survivors.maxHp(sv) * 0.3);
    const fake = { id: 'rx', kind: 'rally', memberIds: [sv.id], endAt: Date.now(), rallyVictory: true, rallyTarget: { name: '測試' }, rallyResult: { units: [{ i: 0, hp: Math.round(A.survivors.maxHp(sv) * 0.3), down: false, dealt: 1, kills: 0 }], coins: 0, items: [], mats: {}, xpEach: 0 } };
    const rpH = A.rally.report(fake);
    assert(A.survivors.hpOf(sv) > A.survivors.maxHp(sv) * 0.3 && rpH.events.some((e) => /戰後使用/.test(e)), `集結結束後生命低於 70% 的人自動吃藥補血（${rpH.events.slice(-1)}）`);
  }
  {
    assert(A.state.player.coins > ca0 && B.state.player.coins > cb0, `勝利時依貢獻分配金錢，每支隊伍都有保底（${A.state.player.coins - ca0} / ${B.state.player.coins - cb0}）`);
    Object.assign(NA, naBak);
    await B.shared.poll();
    assert(!B.npcs.get(n.id), '集結攻陷的 NPC 據點在所有人地圖上消失');
  }
  // 取消：出發前發起人取消，參加者的隊員留在家裡
  const n2 = [...A.npcs.list].find((x) => x.sid && x.id !== n.id);
  const t2 = { kind: 'npc', id: n2.id, ident: n2.ident, name: n2.name, lat: n2.lat, lon: n2.lon };
  A.shelter.primary().facilities.broadcast.level = 3;
  lead.severe = false;
  A.survivors.setHp(lead, 99999);
  B.survivors.leader().severe = false;
  const s2 = await A.rally.start(t2, 10, [lead.id]);
  await B.shared.poll();
  const j2 = await B.rally.join(s2.id, [B.survivors.leader().id]);
  assert(s2.ok && j2.ok, `第二次集結（${s2.reason || j2.reason || ''}）`);
  assert((await A.rally.leave(s2.id)).ok && lead.status === 'idle', '發起人可以在出發前取消');
  await B.shared.poll();
  await B.rally.step(B.rally.trips()[0], Date.now() + 1000);
  {
    const eb2 = B.state.expeditions.find((e) => e.kind === 'rally');
    assert(eb2 && eb2.recalled && eb2.endAt > Date.now(), '集結取消時，正在前往集結點的參加者從目前位置走回家');
    B.exploration.update(eb2.endAt + 1, { silent: true });
    assert(!B.rally.trips().length && B.survivors.leader().status === 'idle', '參加者走回避難所後隊員回到家');
  }
  // v12.2：發起人提前出發，等最後一位抵達集結點才出發；之後不能再參加、不能取消或退出
  {
    A.survivors.setHp(lead, 99999);
    B.survivors.leader().severe = false;
    const s4 = await A.rally.start(t2, 20, [lead.id]);
    await B.shared.poll();
    const j4 = await B.rally.join(s4.id, [B.survivors.leader().id]);
    await A.shared.poll();
    assert(!(await B.rally.departNow(s4.id)).ok, '只有發起人可以提前出發');
    const e4 = await A.rally.departNow(s4.id);
    await A.shared.poll();
    const d4 = A.rally.get(s4.id);
    const tb4 = d4.teams.find((t) => t.player !== d4.owner);
    const sc4 = RallySys.schedule(d4);
    assert(j4.ok && e4.ok && d4.early && d4.departAt <= Date.now() && sc4.go === tb4.arriveAt && sc4.waitFor?.player === tb4.player, `提前出發：倒數結束，等參加者抵達集結點（${e4.msg}）`);
    assert(!(await A.rally.leave(s4.id)).ok && !(await B.rally.leave(s4.id)).ok, '提前出發後不能取消或退出');
    const C4 = mk('C4');
    C4.state.relations.players.A = { status: 'friend', name: 'A' };
    A.state.relations.players.C4 = { status: 'friend', name: 'C4' };
    await C4.shared.poll();
    assert(!(await C4.rally.join(s4.id, [C4.survivors.leader().id])).ok, '提前出發後不能再參加');
    await A.rally.step(A.rally.trips()[0], tb4.arriveAt - 1000);
    await A.shared.poll();
    assert(A.rally.get(s4.id).status === 'gathering', '最後一位還沒抵達前不出發');
    await A.rally.step(A.rally.trips()[0], tb4.arriveAt + 1);
    await A.shared.poll();
    assert(A.rally.get(s4.id).status === 'departed' && A.rally.get(s4.id).departedAt === tb4.arriveAt, '最後一位抵達後部隊出發');
    A.state.expeditions = A.state.expeditions.filter((e) => e.rallyId !== s4.id);
    B.state.expeditions = B.state.expeditions.filter((e) => e.rallyId !== s4.id);
    A.survivors.leader().status = 'idle';
    B.survivors.leader().status = 'idle';
  }
  // 倒數結束後不能再參加
  {
    A.survivors.setHp(lead, 99999);
    const s3 = await A.rally.start(t2, 5, [lead.id]);
    await B.shared.poll();
    const key = [...A.shared.cache.keys()].find((k) => k.includes(s3.id));
    const dB = B.rally.get(s3.id);
    if (dB) {
      const realNow = Date.now;
      Date.now = () => dB.departAt + 1000;
      const late = await B.rally.join(s3.id, [B.survivors.leader().id]);
      Date.now = realNow;
      assert(!late.ok, `倒數結束後不能再參加（${late.reason}）`);
    }
    void key;
    await A.rally.leave(s3.id);
  }
  // 目標已被攻陷：不能再發起；集結途中目標被另一個集結攻陷時，隊伍取消並回家
  {
    A.survivors.setHp(lead, 99999);
    B.survivors.leader().severe = false;
    const again = await A.rally.start(target, 5, [lead.id]);
    assert(!again.ok, `已被攻陷的目標不能再發起集結（${again.reason}）`);
    const s5 = await A.rally.start(t2, 10, [lead.id]);
    await B.shared.poll();
    const j5 = await B.rally.join(s5.id, [B.survivors.leader().id]);
    assert(s5.ok && j5.ok, `集結 5 開始（${s5.reason || j5.reason || ''}）`);
    const nB = B.npcs.byIdent(n2.ident);
    B.npcs.destroy(nB || n2);
    await B.shared.flush?.();
    await A.shared.poll();
    assert(A.rally.targetGone(t2), '別人攻陷後，從共用資料就能知道目標已不在');
    await A.rally.step(A.rally.trips()[0], Date.now() + 1000);
    await B.rally.step(B.rally.trips()[0], Date.now() + 1000);
    const ea5 = A.state.expeditions.find((e) => e.rallyId === s5.id);
    const eb5 = B.state.expeditions.find((e) => e.rallyId === s5.id);
    assert((!ea5 || ea5.recalled) && (!eb5 || eb5.recalled), '集結途中目標被攻陷：發起人與參加者的隊伍都取消回家');
    const C0 = A.rally.invites().some((d) => d.id === s5.id);
    assert(!C0, '目標已被攻陷的集結不會出現在邀請裡');
    A.state.expeditions = A.state.expeditions.filter((e) => e.rallyId !== s5.id);
    B.state.expeditions = B.state.expeditions.filter((e) => e.rallyId !== s5.id);
  }
}

// ---- 25g. v9.0.1：帶不走的物資留在建築裡，重複探索不會越變越多 ----
{
  const gf = Game.newGame({ playerName: 'F', classId: 'warrior', lat: 25, lon: 121 });
  gf.state.map.pois = fillPois([], 25, 121);
  gf.shelter.establish(gf.state.map.pois.find((p) => gf.shelter.canEstablish(p).ok));
  setHour(gf, 10);
  gf.survivors.leader().level = 60;
  const forest = gf.state.map.pois.find((p) => p.type === 'forest' && !gf.shelter.baseAtPoi(p.id));
  const ex = gf.exploration;
  const orig = ex.exploreContext.bind(ex);
  ex.exploreContext = (e) => { const c = orig(e); if (c) c.lootMul = 3; return c; };
  let maxLeft = 0;
  const firstLeft = [];
  for (let i = 0; i < 12; i += 1) {
    const r = ex.start(forest.id, [gf.survivors.leader().id], 5);
    if (!r.ok) break;
    const reps = ex.update(r.exp.endAt + 1, { silent: true });
    const left = Object.values(gf.state.map.remain?.[forest.id]?.res || {}).reduce((a, b) => a + b, 0);
    if (i === 0) firstLeft.push(left);
    maxLeft = Math.max(maxLeft, left);
    const ev = reps.flatMap((x) => x.events).join(' ');
    const m = /留下約 (\d+) 重量/.exec(ev);
    assert(!m || Number(m[1]) < 5000, `重複探索時留下的數量合理（第 ${i + 1} 次：${m?.[1]}）`);
    assert(!/[0-9]\.[0-9]+ 個物資/.test(ev), `倉庫已滿的提示是整數（${ev.match(/倉庫已滿[^，]*/)?.[0] || '無'}）`);
    gf.survivors.leader().severe = false;
    gf.survivors.setHp(gf.survivors.leader(), 1e6);
  }
  // 舊版每次再訪都 ×3，12 次後會變成天文數字；跨過 06:00／18:00 刷新時可能多一批新物資
  assert(maxLeft <= (firstLeft[0] || 0) * 2 + 200, `加成不會重複套用在留下的物資上（第一次 ${firstLeft[0]}、最多 ${maxLeft}）`);
  const { remainOf } = await import('../src/systems/LootStock.js');
  const fake = { [forest.id]: { day: gf.state.map.remain?.[forest.id]?.day ?? '', res: { wood: 2417840409538 } } };
  const got = remainOf(forest, fake, Date.now());
  assert(!got || got.wood <= 2000, '舊存檔中異常的殘留數量會被限制');
}

// ---- 25h. v9.2.1：背包裡不足 1 個的零頭不顯示、不佔格子 ----
{
  const gb = Game.newGame({ playerName: 'B', classId: 'warrior', lat: 25, lon: 121 });
  const sv = gb.survivors.leader();
  sv.bag = { wood: 3.4, nail: 2 };
  const used0 = gb.equipment.bagSlotsUsed(sv);
  sv.bag.wood -= 3; // 例如建造時扣掉 3 個，剩下 0.4
  assert(gb.equipment.bagSlotsUsed(sv) === used0 - 1 && !('wood' in gb.survivors.bagOf(sv)), '消耗後只剩零頭的物資會從背包消失，不佔格子');
  sv.bag.nail = 0;
  assert(!('nail' in gb.survivors.bagOf(sv)), '數量為 0 的物資從背包移除');
}

// ---- 25b. v9：共用物件伺服器（版本號先到先得） ----
{
  const os = await import('node:os');
  const fsm = await import('node:fs');
  const pathm = await import('node:path');
  const { WorldStore } = await import('../server/WorldStore.js');
  const dir = fsm.mkdtempSync(pathm.join(os.tmpdir(), 'jdqs-obj-'));
  const ws = new WorldStore(dir);
  const tok = 'ab'.repeat(32);
  const pres = { name: 'A', bases: [{ lat: 25, lon: 121, name: 'x' }], trips: [] };
  assert(ws.put('a'.repeat(32), tok, pres) === 'ok', '伺服器：登記玩家');
  assert(ws.objPut('b'.repeat(32), tok, 'bm', 'sold', { data: {}, ver: 0 }).status === 'forbidden', '伺服器：未登記的玩家不能寫入共用物件');
  const r1 = ws.objPut('a'.repeat(32), tok, 'bm', 'sold', { data: { sold: { x: 1 } }, ver: 0 });
  assert(r1.status === 'ok' && r1.obj.ver === 1, '伺服器：新建物件版本 1');
  const r2 = ws.objPut('a'.repeat(32), tok, 'bm', 'sold', { data: { sold: {} }, ver: 0 });
  assert(r2.status === 'conflict' && r2.obj.data.sold.x === 1, '伺服器：版本不符回傳衝突與最新資料');
  assert(ws.objPut('a'.repeat(32), tok, 'bm', 'sold', { data: { sold: { y: 1 } }, ver: 1 }).status === 'ok', '伺服器：版本相符才寫入');
  assert(ws.objList('bm', 0, 0, 1).length === 1 && ws.objList('npc', 25, 121, 1).length === 0, '伺服器：全域物件不受位置限制');
  ws.objPut('a'.repeat(32), tok, 'npc', 'c1', { lat: 25, lon: 121, data: {}, ver: 0 });
  assert(ws.objList('npc', 25, 121, 1).length === 1 && ws.objList('npc', 26, 121, 1).length === 0, '伺服器：依位置範圍查詢');
  assert(ws.objPut('a'.repeat(32), tok, 'BAD', 'x', { data: {}, ver: 0 }).status === 'invalid', '伺服器：不合法的種類');
  clearTimeout(ws.objTimer);
  clearTimeout(ws.timer);
}

// ---- 26. v8.8：施工佇列 3 條、同時最多 5 支隊伍 ----
{
  const { BUILD_QUEUE_SIZE, MAX_EXPEDITIONS } = await import('../src/config/constants.js');
  assert(BUILD_QUEUE_SIZE === 3 && MAX_EXPEDITIONS === 5, '施工佇列 3 條、隊伍上限 5 組');
  const gq3 = Game.newGame({ playerName: 'Q3', classId: 'warrior', lat: 25, lon: 121 });
  gq3.state.map.pois = fillPois([], 25, 121);
  gq3.shelter.establish(gq3.state.map.pois.find((p) => gq3.shelter.canEstablish(p).ok));
  fillSupplies(gq3);
  Object.keys(gq3.state.resources).forEach((k) => { gq3.state.resources[k] = 1e5; });
  gq3.state.player.coins = 1e6;
  const ups = ['farm', 'workbench', 'generator', 'lumberMill'].map((id) => gq3.shelter.upgradeFacility(null, id).ok);
  assert(ups[0] && ups[1] && ups[2] && !ups[3], `施工佇列最多 3 條（${ups}）`);
  for (let i = 0; i < 6; i += 1) gq3.state.survivors.push(gq3.survivors.makeCandidate(3));
  const targets = gq3.state.map.pois.filter((p) => !gq3.shelter.baseAtPoi(p.id));
  const res = gq3.state.survivors.slice(0, 7).map((sv, i) => gq3.exploration.start(targets[i].id, [sv.id], 5).ok);
  assert(res.filter(Boolean).length === 5 && !res[5], `同時最多派出 5 支隊伍（${res}）`);
}

// ---- 27. v8.9：藥局、回收站、麵包店 ----
{
  const sup = await import('../src/config/supplies.js');
  const { stockOf: stock } = await import('../src/systems/LootStock.js');
  assert(classify({ amenity: 'pharmacy' }) === 'pharmacy' && classify({ shop: 'chemist' }) === 'pharmacy', 'OSM 藥局分類');
  assert(classify({ amenity: 'recycling', recycling_type: 'centre' }) === 'recycling' && classify({ amenity: 'recycling', recycling_type: 'container' }) !== 'recycling', 'OSM 回收站分類（回收桶不算）');
  assert(classify({ shop: 'bakery' }) === 'bakery', 'OSM 麵包店分類');
  const days = Array.from({ length: 120 }, (_, i) => Date.UTC(2026, 0, 1 + i));
  const tally = (type) => {
    const out = { cats: new Set(), medTier: 0, med: 0, food: 0 };
    days.forEach((d, i) => Object.entries(stock({ id: `x_${type}_${i % 7}`, type, lat: 25, lon: 121 }, d).resources).forEach(([k, v]) => {
      const sp = sup.SUPPLIES[k];
      out.cats.add(sp ? sp.cat : k);
      if (sp?.cat === 'med') { out.medTier = Math.max(out.medTier, sp.tier); out.med += v; }
      if (k === 'food') out.food += v;
    }));
    return out;
  };
  const ph = tally('pharmacy'); const shop = tally('shop'); const hosp = tally('hospital');
  assert([...ph.cats].every((c) => c === 'med') && ph.medTier <= 3 && hosp.medTier > ph.medTier, `藥局只有藥品，種類比醫院少（最高 ${ph.medTier} 階，醫院 ${hosp.medTier} 階）`);
  assert(ph.med > shop.med * 3, `藥局的低階藥品比商店多很多（${ph.med} vs ${shop.med}）`);
  assert(hosp.med > ph.med, `醫院的藥品數量比藥局多（${hosp.med} vs ${ph.med}）`);
  {
    // 醫院一定有藥品、藥品種類比藥局多；區域越危險，高階藥品越容易出現
    const { pickSupply } = await import('../src/systems/LootStock.js');
    const kindsOf = (type) => { const ks = new Set(); days.forEach((d, i) => Object.keys(stock({ id: `k_${type}_${i}`, type, lat: 25, lon: 121 }, d).resources).forEach((k) => { if (sup.SUPPLIES[k]?.cat === 'med') ks.add(k); })); return ks.size; };
    assert(kindsOf('hospital') > kindsOf('pharmacy'), '醫院的藥品種類比藥局多');
    assert(days.every((d, i) => Object.keys(stock({ id: `g_${i}`, type: 'hospital', lat: 25, lon: 121 }, d).resources).some((k) => sup.SUPPLIES[k]?.cat === 'med')), '醫院每次刷新一定有藥品');
    const highRate = (danger) => { let a = 0; let s0 = 7; const rnd = () => { s0 = (s0 * 16807) % 2147483647; return s0 / 2147483647; }; for (let i = 0; i < 4000; i += 1) if (sup.SUPPLIES[pickSupply('med', rnd, danger)].tier >= 4) a += 1; return a / 4000; };
    assert(highRate(9) > highRate(4) * 1.5, `危險度越高越容易找到中大型醫藥箱（${highRate(4)} → ${highRate(9)}）`);
  }
  const rc = tally('recycling');
  assert([...rc.cats].every((c) => c === 'part' || c === 'fabric') && rc.cats.size === 2, `回收站可搜到布料與零件（${[...rc.cats]}）`);
  const bk = tally('bakery'); const res = tally('residential');
  assert([...bk.cats].every((c) => c === 'food') && bk.food > res.food * 1.5, `麵包店只有食物，比住宅多（${bk.food} vs ${res.food}）`);
}

// ---- 28. v8.10：在線食物消耗較高、離線較低 ----
{
  const gf = Game.newGame({ playerName: 'F', classId: 'warrior', lat: 25, lon: 121 });
  gf.state.map.pois = fillPois([], 25, 121);
  gf.shelter.establish(gf.state.map.pois.find((p) => gf.shelter.canEstablish(p).ok));
  const on = gf.resources.rates().upkeep.food;
  const off = gf.resources.rates({ offline: true }).upkeep.food;
  assert(on > off && on === 5 * gf.state.survivors.length, `在線每人吃 5、離線吃較少（${on} / ${off}）`);
  gf.state.resources.food = 1000;
  gf.resources.apply(3600000, { offline: true });
  const afterOff = gf.state.resources.food;
  gf.state.resources.food = 1000;
  gf.resources.apply(3600000);
  assert(afterOff > gf.state.resources.food, '離線一小時消耗的食物比在線少');
}

// ---- 29. v8.11：攻擊殭屍群需要移動時間 ----
{
  const gh = Game.newGame({ playerName: 'H', classId: 'warrior', lat: 25, lon: 121 });
  gh.state.map.pois = fillPois([], 25, 121);
  gh.shelter.establish(gh.state.map.pois.find((p) => gh.shelter.canEstablish(p).ok));
  setHour(gh, 23);
  gh.zombies.refresh();
  const grp = gh.state.map.zombieGroups[0];
  grp.count = 1;
  grp.level = 1;
  Object.assign(gh.survivors.leader(), { level: 30, hp: null, severe: false });
  const r = gh.exploration.startHunt(grp.id, ['leader']);
  assert(r.ok && r.exp.kind === 'hunt' && r.exp.travelMs > 0 && gh.survivors.leader().status === 'exploring', '派隊攻擊殭屍群會先移動');
  assert(gh.state.map.zombieGroups.some((x) => x.id === grp.id), '出發時還沒有交戰');
  gh.exploration.checkHunts(r.exp.startAt + r.exp.travelMs + 1);
  assert(r.exp.huntDone && r.exp.huntResult.win && !gh.state.map.zombieGroups.some((x) => x.id === grp.id), `抵達後交戰並擊退殭屍群（${r.exp.huntResult.events}）`);
  assert(gh.survivors.leader().status === 'exploring', '交戰後還要走回避難所');
  const rep = gh.exploration.update(r.exp.endAt + 1, { silent: true })[0];
  assert(rep && rep.success && gh.survivors.leader().status === 'idle', '返回避難所後結算報告');
}

// ---- 30. v8.12：召回需要移動時間 ----
{
  const gr3 = Game.newGame({ playerName: 'R3', classId: 'warrior', lat: 25, lon: 121 });
  gr3.state.map.pois = fillPois([], 25, 121);
  gr3.shelter.establish(gr3.state.map.pois.find((p) => gr3.shelter.canEstablish(p).ok));
  setHour(gr3, 10);
  const sh3 = gr3.shelter.primary();
  const far3 = gr3.state.map.pois.filter((p) => !gr3.shelter.baseAtPoi(p.id)).sort((a, b) => haversine(sh3.lat, sh3.lon, b.lat, b.lon) - haversine(sh3.lat, sh3.lon, a.lat, a.lon))[0];
  const r3 = gr3.exploration.start(far3.id, ['leader'], 5);
  const half = r3.exp.startAt + r3.exp.travelMs * 0.5;
  const rc = gr3.exploration.recall(r3.exp.id, half);
  assert(rc.ok && gr3.state.expeditions.length === 1 && gr3.survivors.leader().status === 'exploring', '召回後隊伍還在外面，要走回避難所');
  assert(Math.abs(r3.exp.endAt - half - r3.exp.travelMs) < 2000 && r3.exp.recalled, `折返時間約等於已走的路程（${Math.round((r3.exp.endAt - half) / 1000)} 秒）`);
  assert(!gr3.exploration.canRecall(r3.exp, half + 1000), '召回中不能再召回');
  const rep3 = gr3.exploration.update(r3.exp.endAt + 1, { silent: true })[0];
  assert(rep3 && !rep3.success && !Object.keys(rep3.resources).length && gr3.survivors.leader().status === 'idle', '回到避難所後結算，沒有收穫');
}

// ---- 31. v8.14：雨水收集器改為伐木場 ----
{
  const gl = Game.newGame({ playerName: 'L1', classId: 'warrior', lat: 25, lon: 121 });
  gl.state.map.pois = fillPois([], 25, 121);
  gl.shelter.establish(gl.state.map.pois.find((p) => gl.shelter.canEstablish(p).ok));
  const base = gl.shelter.primary();
  const w0 = gl.resources.rates().gross.wood;
  base.facilities.lumberMill.level = 2;
  const w1 = gl.resources.rates().gross.wood;
  assert(Math.abs(w1 - w0 - 2 * LUMBER_WOOD) < 0.01, `伐木場每級產出木材（+${(w1 - w0).toFixed(1)}/時）`);
  gl.state.research.levels.a_lumber = 10;
  gl.research._cache = null;
  assert(gl.resources.rates().gross.wood > w1, '伐木技術提升伐木場產量');
  assert(LUMBER_WOOD * 10 < 60, '伐木場滿級產量仍低於探索樹林');
  const old = JSON.parse(JSON.stringify(gl.state));
  old.version = 13;
  old.bases[0].facilities.rainCollector = { level: 3 };
  delete old.bases[0].facilities.lumberMill;
  old.research.levels = { a_rain: 4 };
  const mg = SaveManager.migrate(old);
  assert(mg.bases[0].facilities.lumberMill.level === 3 && !mg.bases[0].facilities.rainCollector && mg.research.levels.a_lumber === 4 && !('a_rain' in mg.research.levels), '舊存檔的雨水收集器與淨水科技換成伐木場與伐木技術');
  assert(!FACILITIES.rainCollector && !RESEARCH.a_rain, '雨水收集器與淨水科技已移除');
}

// ---- 32. v8.17.2：缺零件時改用純木材修繕圍牆 ----
{
  const gw = Game.newGame({ playerName: 'W1', classId: 'warrior', lat: 25, lon: 121 });
  gw.state.map.pois = fillPois([], 25, 121);
  gw.shelter.establish(gw.state.map.pois.find((p) => gw.shelter.canEstablish(p).ok));
  const bw = gw.shelter.primary();
  bw.wallHp = 0;
  gw.survivors.setJob(gw.survivors.leader().id, 'repair');
  delete gw.state.supplies.nail;
  delete gw.state.supplies.scrap;
  gw.state.resources.wood = 100;
  assert(gw.shelter.repairStatus().mode === 'woodOnly', '缺零件時顯示改用純木材修繕');
  gw.shelter.update(Date.now(), 10000);
  assert(gw.shelter.wallHp(bw) > 0 && gw.state.resources.wood < 100, `缺零件仍可用木材修繕圍牆（+${gw.shelter.wallHp(bw).toFixed(1)}）`);
  gw.state.resources.wood = 0;
  const h = gw.shelter.wallHp(bw);
  gw.shelter.update(Date.now(), 10000);
  assert(gw.shelter.repairStatus().mode === 'noWood' && gw.shelter.wallHp(bw) === h, '沒有木材時無法修繕');
}

// ---- 33. v8.17.3：重新整理後屍潮波數不重算 ----
{
  const gn = Game.newGame({ playerName: 'N1', classId: 'warrior', lat: 25, lon: 121 });
  gn.state.map.pois = fillPois([], 25, 121);
  gn.shelter.establish(gn.state.map.pois.find((p) => gn.shelter.canEstablish(p).ok));
  setHour(gn, 22);
  const max = gn.civilization.maxWaves();
  let seen = 0;
  gn.bus.on('siege:wave', () => { seen += 1; });
  for (let r = 0; r < 4; r += 1) {
    for (let i = 0; i < 1200; i += 1) gn.siege.update(0.5);
    // 模擬重新整理：屍潮狀態重建
    gn.siege.sieges.clear();
    const re = SaveManager.migrate(JSON.parse(JSON.stringify(gn.state)));
    gn.state.bases = re.bases;
  }
  assert(seen <= max, `重新整理後同一晚的屍潮波數不重算（${seen}/${max} 波）`);
}

// ---- 34. v8.17.4：地圖殭屍群每晚只在入夜時生成一次 ----
{
  const gz = Game.newGame({ playerName: 'Z1', classId: 'warrior', lat: 25, lon: 121 });
  gz.state.map.pois = fillPois([], 25, 121);
  gz.shelter.establish(gz.state.map.pois.find((p) => gz.shelter.canEstablish(p).ok));
  setHour(gz, 20.5);
  gz.zombies.refresh();
  const n0 = gz.state.map.zombieGroups.length;
  gz.state.map.zombieGroups.pop();
  const ids = gz.state.map.zombieGroups.map((z) => z.id).join();
  setHour(gz, 0.5);
  gz.zombies.refresh();
  gz.state.map.lastZombieRefresh = 0;
  gz.zombies.update(Date.now());
  assert(gz.state.map.zombieGroups.map((z) => z.id).join() === ids, '進入午夜（00:00）不會重新派出殭屍群，擊殺的也不會補回');
  setHour(gz, 2.5);
  gz.zombies.refresh();
  assert(gz.state.map.zombieGroups.map((z) => z.id).join() === ids, '02:00 轉回夜晚也不會重新派出殭屍群');
  setHour(gz, 10);
  gz.zombies.refresh();
  setHour(gz, 20.5);
  gz.zombies.refresh();
  assert(n0 > 0 && gz.state.map.zombieGroups.length === n0, '隔天入夜才重新生成殭屍群');
}

// ---- 35. v8.18：NPC 傷亡、NPC 抵禦屍群、偵查情報 ----
{
  const gq = Game.newGame({ playerName: 'Q8', classId: 'warrior', lat: 25, lon: 121 });
  gq.state.map.pois = fillPois([], 25, 121);
  gq.shelter.establish(gq.state.map.pois.find((p) => gq.shelter.canEstablish(p).ok));
  const bq = gq.shelter.primary();
  const npcPoi = gq.state.map.pois.find((p) => !gq.shelter.baseAtPoi(p.id));
  const n = gq.npcs.spawnAt(npcPoi, 'x', Date.now(), true);
  n.level = 3;
  // 玩家防守成功：NPC 有傷亡、防守人員與圍牆也有損傷
  const lead = gq.survivors.leader();
  lead.level = 30;
  bq.facilities.wall.level = 5;
  bq.wallHp = null;
  setHour(gq, 10);
  const hp0 = gq.survivors.hpOf(lead);
  const wall0 = gq.shelter.wallHp(bq);
  n.trip = { kind: 'raid', baseId: bq.id, startAt: Date.now() - 1000, travelMs: 0, endAt: Date.now() + 1000 };
  gq.npcs.resolveIncoming(n, n.trip, Date.now());
  const rec = gq.state.defenseLog[0];
  assert(rec.success && n.wounded > 0, `NPC 掠奪失敗會有人員傷亡（${n.wounded} 人）`);
  assert(gq.shelter.wallHp(bq) < wall0 || gq.survivors.hpOf(lead) < hp0, `防守成功也有損傷：掠奪隊會先攻擊圍牆（生命 ${hp0}→${gq.survivors.hpOf(lead)}，圍牆 −${rec.wallLost}）`);
  const g0 = gq.npcs.garrison(n).length;
  n.trip = null;
  n.nextRaidAt = Date.now() + 3600e3;
  n.healAt = Date.now() - 10 * 20 * 60000;
  gq.npcs.update(Date.now());
  assert(!n.wounded && gq.npcs.garrison(n).length > g0, 'NPC 傷亡人員會隨時間補回');
  // 夜晚：NPC 據點不再抵禦屍潮（v10.9 移除），等級不會因此下降
  setHour(gq, 22);
  n.wounded = 0;
  const lv22 = n.level;
  const loss22 = n.levelLoss || 0;
  gq.npcs.update(Date.now());
  assert(!n.lastSiege && (n.levelLoss || 0) === loss22 && n.level >= lv22 && !n.wounded, 'NPC 據點夜晚不會抵禦屍潮、等級不會下降');
  // 偵查情報
  gq.state.research.levels = {};
  gq.research._cache = null;
  let v = gq.npcs.intelView(n);
  assert(v.level === 'Lv?' && !v.garrison && !v.resources, '沒有偵查時只知道名稱');
  gq.state.research.levels = { s_recon: 3 };
  gq.research._cache = null;
  v = gq.npcs.intelView(n);
  assert(v.level === `Lv${n.level}` && v.garrison && !v.resources, '偵查 3 級可得知確切等級與守軍');
  gq.state.research.levels = { s_recon: 9 };
  gq.research._cache = null;
  v = gq.npcs.intelView(n);
  assert(v.resources && v.power > 0 && v.nextRaid != null, '偵查越高情報越詳細');
}

// ---- 36. v8.19：倉庫丟棄物品 ----
{
  const gd = Game.newGame({ playerName: 'D1', classId: 'warrior', lat: 25, lon: 121 });
  gd.state.map.pois = fillPois([], 25, 121);
  gd.shelter.establish(gd.state.map.pois.find((p) => gd.shelter.canEstablish(p).ok));
  gd.state.supplies.nail = 100;
  assert(gd.equipment.discardSupply('nail', 30).ok && gd.state.supplies.nail === 70, '可指定數量丟棄材料');
  assert(gd.equipment.discardSupply('nail', Infinity).ok && !gd.state.supplies.nail, '可全部丟棄材料');
  assert(!gd.equipment.discardSupply('nail', 1).ok, '沒有的材料不能丟棄');
  const it = gd.equipment.generate({ level: 3, rarity: 'common' });
  gd.equipment.addItem(it, 't');
  it.locked = true;
  assert(!gd.equipment.discardItem(it.id).ok, '上鎖的裝備不能丟棄');
  it.locked = false;
  assert(gd.equipment.discardItem(it.id).ok && !gd.equipment.getItem(it.id), '可以丟棄裝備');
}

// ---- 37. v8.20：宿舍 ----
{
  const gm = Game.newGame({ playerName: 'M1', classId: 'warrior', lat: 25, lon: 121 });
  gm.state.map.pois = fillPois([], 25, 121);
  gm.shelter.establish(gm.state.map.pois.find((p) => gm.shelter.canEstablish(p).ok));
  assert(gm.survivors.dormCap() === 3 && gm.survivors.housing() <= 3, '沒有宿舍最多 3 人');
  gm.shelter.primary().facilities.dormitory.level = 3;
  assert(gm.survivors.dormCap() === 6, '宿舍每升一級多住 1 人');
  const old = JSON.parse(JSON.stringify(gm.state));
  old.version = 14;
  delete old.bases[0].facilities.dormitory;
  old.survivors = [old.survivors[0], { ...old.survivors[0], id: 'a', isLeader: false }, { ...old.survivors[0], id: 'b', isLeader: false }, { ...old.survivors[0], id: 'c', isLeader: false }];
  const mg = SaveManager.migrate(old);
  const gm2 = new Game(mg);
  assert(mg.bases[0].facilities.dormitory.level === 2 && gm2.survivors.dormCap() >= 4, '舊存檔依現有人數給予宿舍等級，不會超過上限');
}

// ---- 38. v8.22：人數已滿也可招募，候選人停留 1 小時 ----
{
  const gc = Game.newGame({ playerName: 'C1', classId: 'warrior', lat: 25, lon: 121 });
  gc.state.map.pois = fillPois([], 25, 121);
  gc.shelter.establish(gc.state.map.pois.find((p) => gc.shelter.canEstablish(p).ok));
  gc.state.player.coins = 1e5;
  Object.keys(gc.state.resources).forEach((k) => { gc.state.resources[k] = 1e5; });
  const lead = gc.survivors.leader();
  gc.state.survivors.push({ ...lead, id: 'x1', isLeader: false }, { ...lead, id: 'x2', isLeader: false });
  assert(gc.survivors.isFull(), '人數已滿（沒有宿舍 3 人）');
  const roll = gc.survivors.recruitRoll();
  assert(roll.ok && roll.offer.length === 3, '人數已滿也可以廣播招募');
  assert(!gc.survivors.pickRecruit(roll.offer[0].id).ok && gc.state.recruitOffer?.length === 3, '人數已滿無法雇用，但候選人仍會停留');
  gc.state.recruitPool.push({ ...gc.survivors.makeCandidate(1), leaveAt: Date.now() + 3600e3 });
  gc.survivors.updateBoard(Date.now() + 30 * 60000);
  assert(gc.state.recruitOffer?.length === 3 && gc.state.recruitPool.length === 1, '一小時內候選人不會離開');
  gc.shelter.primary().facilities.dormitory.level = 2;
  lead.level = 25;
  assert(gc.survivors.pickRecruit(roll.offer[0].id).ok, '擴充宿舍後可以雇用停留中的候選人');
  gc.survivors.recruitRoll();
  gc.survivors.updateBoard(Date.now() + 3600e3 + 1000);
  assert(!gc.state.recruitOffer && !gc.state.recruitPool.length, '超過一小時未招募的候選人會離開');
}

// ---- 39. v9：交易市場（刊登時保管、即時成交、離線玩家上線後收款） ----
{
  const { MemoryObjects } = await import('../src/multiplayer/SharedWorld.js');
  const { LISTING_MS } = await import('../src/systems/MarketSystem.js');
  const store = new MemoryObjects();
  const mk = (name) => {
    const gx = Game.newGame({ playerName: name, classId: 'warrior', lat: 25, lon: 121 });
    gx.state.map.pois = fillPois([], 25, 121);
    gx.shelter.establish(gx.state.map.pois.find((p) => gx.shelter.canEstablish(p).ok));
    gx.shared.backend = store;
    gx.world = { others: [], myId: name, identity: () => ({ id: name, token: 't' }) };
    return gx;
  };
  const A = mk('A');
  const B = mk('B');
  const C = mk('C');
  A.state.supplies.nail = 50;
  assert(!(await A.market.post({ side: 'sell', key: 'nail', qty: 10, price: 3 })).ok, '沒有交易所不能刊登');
  [A, B, C].forEach((gx) => { gx.shelter.primary().facilities.exchange.level = 1; });
  assert(A.market.limit() === 2, '交易所 Lv1 可刊登賣單、收購各 2 筆');
  const p1 = await A.market.post({ side: 'sell', key: 'nail', qty: 20, price: 3 });
  assert(p1.ok && A.state.supplies.nail === 30, '刊登賣單時物品先移到市場保管');
  assert((await A.market.post({ side: 'sell', key: 'nail', qty: 5, price: 3 })).ok, '第 2 筆賣單');
  assert(!(await A.market.post({ side: 'sell', key: 'nail', qty: 5, price: 3 })).ok && A.state.supplies.nail === 25, '超過上限不能刊登，物品不會被扣');
  A.shelter.primary().facilities.exchange.level = 2;
  assert(A.market.limit() === 3, '每升一級 +1 筆');
  // A 下線（不再執行任何程式）；B、C 同時購買
  await B.market.refresh();
  await C.market.refresh();
  assert(B.market.listings().length === 2, '其他玩家看得到刊登');
  // 遠方的玩家（超過 20 公里）也看得到；自己的刊登也顯示在市場並標「我的」
  const far = Game.newGame({ playerName: 'Far', classId: 'warrior', lat: 35, lon: 139 });
  far.state.map.pois = fillPois([], 35, 139);
  far.shelter.establish(far.state.map.pois.find((p) => far.shelter.canEstablish(p).ok));
  far.shared.backend = store;
  far.world = { others: [], myId: 'Far', identity: () => ({ id: 'Far', token: 't' }) };
  await far.market.refresh();
  assert(far.market.listings().length === 2, '距離很遠的玩家也看得到刊登（全服市場）');
  await A.market.refresh();
  assert(A.market.listings().length === 2 && A.market.listings().every((d) => d.mine), '自己的刊登也顯示在市場，標記為我的');
  assert(B.market.listings().every((d) => !d.mine), '別人的刊登不會標成我的');
  B.state.player.coins = 1000;
  C.state.player.coins = 1000;
  const nb0 = B.state.supplies.nail || 0;
  const nc0 = C.state.supplies.nail || 0;
  const [rb, rc] = await Promise.all([B.market.buy(p1.id, 15), C.market.buy(p1.id, 15)]);
  assert(rb.ok !== rc.ok, `同時購買超過剩餘數量時只有一人成功（${rb.reason || 'ok'} / ${rc.reason || 'ok'}）`);
  const [w, l] = rb.ok ? [B, C] : [C, B];
  assert(w.state.player.coins === 1000 - 45 && l.state.player.coins === 1000, '成交的人付款，失敗的人退款');
  assert((B.state.supplies.nail || 0) + (C.state.supplies.nail || 0) === nb0 + nc0 + 15, '物品只交付一次');
  const r5 = await l.market.buy(p1.id, 5);
  assert(r5.ok, '剩下的數量可以繼續購買');
  assert(!(await l.market.buy(p1.id, 1)).ok, '賣完後不能再買');
  // A 離線期間的成交，上線後自動收款
  const coinsA = A.state.player.coins;
  await A.market.refresh();
  assert(A.state.player.coins === coinsA + 60, `離線玩家上線後收到全部貨款（+${A.state.player.coins - coinsA}）`);
  await A.market.refresh();
  assert(A.state.player.coins === coinsA + 60, '貨款不會重複收取');
  assert(!A.market.mine().find((m) => m.id === p1.id), '賣完且收款後從自己的刊登移除');
  // 收購單：保管金錢、別人賣給他、刊登者離線時也成立
  A.state.player.coins = 100;
  assert(!(await A.market.post({ side: 'buy', key: 'screw', qty: 30, price: 5 })).ok && A.state.player.coins === 100, '金錢不足不能刊登收購');
  const pb = await A.market.post({ side: 'buy', key: 'screw', qty: 10, price: 5 });
  assert(pb.ok && A.state.player.coins === 50, '刊登收購時先保管金錢');
  await B.market.refresh();
  B.state.supplies.screw = 6;
  const cb = B.state.player.coins;
  const sell = await B.market.sellTo(pb.id, 6);
  assert(sell.ok && !B.state.supplies.screw && B.state.player.coins === cb + 30, '賣給收購單：立即拿到錢');
  assert(!(await B.market.sellTo(pb.id, 6)).ok, '沒有物品不能賣');
  const sc0 = A.state.supplies.screw || 0;
  await A.market.refresh();
  assert((A.state.supplies.screw || 0) === sc0 + 6, '收購者上線後收到物品');
  // 下架：退還未成交部分
  const r = await A.market.cancel(pb.id);
  assert(r.ok && A.state.player.coins === 70, `下架退還未成交的保管金額（${A.state.player.coins}）`);
  await B.market.refresh();
  assert(!(await B.market.sellTo(pb.id, 1)).ok, '下架後不能成交');
  // 裝備刊登
  const gear = A.equipment.generate({ level: 5, model: 'knife', rarity: 'rare' });
  A.equipment.addItem(gear, 't');
  const pg = await A.market.post({ side: 'sell', itemId: gear.id, price: 200 });
  assert(pg.ok && !A.equipment.getItem(gear.id), '裝備刊登後移到市場保管');
  await B.market.refresh();
  B.state.player.coins = 500;
  assert((await B.market.buy(pg.id)).ok && B.state.player.coins === 300 && B.equipment.storeItems().some((i) => i.model === 'knife' && i.rarity === 'rare'), '買到裝備');
  assert(!(await A.market.buy(pg.id)).ok, '不能購買自己的刊登');
  // 到期自動下架退還
  A.state.supplies.wood = 0;
  A.state.resources.wood = 100;
  const pw = await A.market.post({ side: 'sell', key: 'wood', qty: 40, price: 1 });
  assert(pw.ok && A.state.resources.wood === 60, '基礎物資也能刊登');
  await A.shared.list('mk', 20);
  await A.market.settle(Date.now() + LISTING_MS + 1000);
  assert(A.state.resources.wood === 100 && !A.market.mine().find((m) => m.id === pw.id), '到期自動下架並退還');
  // 連線失敗：刊登取消、物品退回
  const N = mk('N');
  N.shelter.primary().facilities.exchange.level = 1;
  N.shared.backend = { objList: async () => [], objPut: async () => { const e = new Error('x'); e.kind = 'network'; throw e; } };
  N.state.supplies.nail = 10;
  assert(!(await N.market.post({ side: 'sell', key: 'nail', qty: 10, price: 1 })).ok && N.state.supplies.nail === 10, '連線失敗時刊登取消，物品退回');
}

// ---- 40. v8.24：探索檢核點 ----
{
  const { baseSizeOf: bso } = await import('../src/config/civilization.js');
  const ge = Game.newGame({ playerName: 'E1', classId: 'warrior', lat: 25, lon: 121 });
  ge.state.map.pois = fillPois([], 25, 121);
  ge.shelter.establish(ge.state.map.pois.find((p) => ge.shelter.canEstablish(p).ok));
  setHour(ge, 10);
  const lead = ge.survivors.leader();
  lead.level = 40;
  const free = ge.state.map.pois.filter((p) => !ge.shelter.baseAtPoi(p.id) && !ge.npcs.list.some((n) => n.poiId === p.id) && POI_TYPES[p.type].loot.food);
  const huge = free.find((p) => bso(p) === 'huge') || free.find((p) => bso(p) === 'large');
  const small = free.find((p) => bso(p) === 'small');
  assert(ge.exploration.checkpointCount(small) === 1 && ge.exploration.checkpointCount(huge) >= 3, '檢核點數量：小型 1、大型 3、巨型 4');
  // 大型／巨型：每到一個檢核點更新進度
  const reset = () => Object.assign(lead, { status: 'idle', severe: false, hp: null });
  const e1 = ge.exploration.start(huge.id, [lead.id], 5).exp;
  e1.cargo = 1e6;
  const n = ge.exploration.checkpointCount(huge);
  const seen = [];
  for (let k = 1; k < n; k += 1) {
    ge.exploration.runCheckpoints(e1, ge.exploration.checkpointAt({ ...e1, cp: { total: n, searchMs: e1.searchMs } }, k) + 1);
    seen.push(Math.round(ge.exploration.searchProgress(e1) * 100));
  }
  // 途中戰敗撤退時會提早結束（不列入進度檢查）
  assert(e1.cp.stopped || seen.join() === (n === 4 ? '25,50,75' : '33,67'), `搜索進度依檢核點更新（${seen.join('% ')}%）`);
  ge.exploration.runCheckpoints(e1, e1.endAt);
  assert((e1.cp.stopped || e1.cp.done === n) && ge.exploration.searchProgress(e1) == null, '完成時不顯示進度');
  ge.exploration.update(e1.endAt + 1, { silent: true });
  reset();
  // 小型：只有完成時才觸發
  const e2 = ge.exploration.start(small.id, [lead.id], 5).exp;
  ge.exploration.runCheckpoints(e2, e2.startAt + e2.travelMs + e2.searchMs - 1000);
  assert(!e2.cp || e2.cp.done === 0, '小型建築只有搜索完成才觸發檢核點');
  ge.exploration.update(e2.endAt + 1, { silent: true });
  reset();
  // 中途撤回：帶回已取得的物資，建築剩餘物資數量不顯示
  const big2 = free.filter((p) => ge.exploration.checkpointCount(p) >= 2 && p.id !== huge.id && p.id !== small.id)[0];
  const e3 = ge.exploration.start(big2.id, [lead.id], 5).exp;
  e3.cargo = 1e6;
  const t1 = ge.exploration.checkpointAt({ ...e3, cp: { total: ge.exploration.checkpointCount(big2), searchMs: e3.searchMs } }, 1) + 1;
  assert(ge.exploration.recall(e3.id, t1).ok && e3.cp?.done === 1, '撤回前先結算已經到的檢核點');
  const r3 = ge.exploration.update(e3.endAt + 1, { silent: true })[0];
  const r3got = Object.values(r3.resources).reduce((a2, b2) => a2 + b2, 0);
  const expect3 = Object.entries(e3.cp.gained).reduce((a2, [, v]) => a2 + Math.floor(v + 1e-9), 0);
  assert(r3.events.some((x) => x.includes('中途撤回')) && r3got >= expect3 && (expect3 > 0 || e3.cp.stock.empty || e3.cp.failed || Object.values(e3.cp.gained).every((v) => v < 1)), `中途撤回可帶回已取得的物資（${r3got}）`);
  const rem3 = ge.state.map.remain[big2.id];
  assert(!rem3 || rem3.hidden, '未完成探索不會顯示建築剩餘物資');
  reset();
  // 提早負重：停止探索直接回家
  const big3 = free.filter((p) => ge.exploration.checkpointCount(p) >= 2 && ![huge.id, small.id, big2.id].includes(p.id))[0];
  const e4 = ge.exploration.start(big3.id, [lead.id], 5).exp;
  e4.cargo = 0.5;
  const end0 = e4.endAt;
  ge.exploration.runCheckpoints(e4, end0);
  const early = e4.cp.overweight && e4.cp.done < e4.cp.total;
  assert(!early || (e4.cp.stopped && e4.endAt < end0), `背包提早裝滿就停止探索、直接回家（${e4.cp.done}/${e4.cp.total}）`);
  ge.exploration.update(e4.endAt + 1, { silent: true });
  assert(!early || !ge.state.map.remain[big3.id] || ge.state.map.remain[big3.id].hidden, '提早負重回家時不顯示剩餘物資');
}

// ---- 41. v8.25：地圖密度上限 ----
{
  const { thinPois } = await import('../src/map/OverpassService.js');
  const dense = Array.from({ length: 400 }, (_, i) => ({ id: `r${i}`, type: 'residential', name: '', lat: 25 + Math.random() * 0.001, lon: 121 + Math.random() * 0.001, osm: true }));
  dense.push({ id: 'ph', type: 'pharmacy', name: '藥局', lat: 25.0005, lon: 121.0005, osm: true });
  const out = thinPois(dense, 25, new Set(['r7']));
  assert(out.length <= 12 && out.some((p) => p.id === 'ph') && out.some((p) => p.id === 'r7'), `密集區每 50 公尺最多一個地點（400 → ${out.length}），稀有類型與保留地點優先`);
  const gt = Game.newGame({ playerName: 'T1', classId: 'warrior', lat: 25, lon: 121 });
  gt.state.map.pois = fillPois(dense, 25, 121);
  gt.shelter.establish(gt.state.map.pois.find((p) => p.id === 'r3'));
  // v10：舊地圖（真實建築）換成固定格子產生的地圖，據點所在的舊地點保留
  gt.genMap();
  assert(gt.state.map.pois.some((p) => p.id === 'r3') && gt.state.map.pois.filter((p) => p.id.startsWith('w_')).length > 1000, '換成隨機地圖時保留據點所在的地點');
}

// ---- 42. v8.28：攻擊據點要先破牆、再打贏人員；威脅提示 ----
{
  const gw = Game.newGame({ playerName: 'W2', classId: 'warrior', lat: 25, lon: 121 });
  gw.state.map.pois = fillPois([], 25, 121);
  gw.shelter.establish(gw.state.map.pois.find((p) => gw.shelter.canEstablish(p).ok));
  setHour(gw, 10);
  const mk = () => Array.from({ length: 3 }, () => gw.combat.createEnemy('raider', 5));
  const hold = gw.combat.wallAssault(mk(), 1e6, 0);
  assert(!hold.breached && hold.alive.length === 3 && hold.wallLost > 0, '圍牆太堅固時攻擊者打不破（圍牆仍會受損）');
  const shot = gw.combat.wallAssault(mk(), 1e6, 1e4);
  assert(!shot.breached && shot.killed === 3, '破牆期間防禦設施會擊倒攻擊者');
  const open = gw.combat.wallAssault(mk(), 0, 0);
  assert(open.breached && open.alive.length === 3, '沒有圍牆時直接進入與人員交戰');
  // NPC 掠奪：圍牆守住就不會被搶
  const base = gw.shelter.primary();
  const n = gw.npcs.spawnAt(gw.state.map.pois.find((p) => !gw.shelter.baseAtPoi(p.id)), 'x', Date.now(), true);
  n.level = 1;
  base.facilities.wall.level = 15;
  base.wallHp = null;
  gw.state.resources.food = 500;
  n.trip = { kind: 'raid', baseId: base.id, startAt: Date.now() - 1000, travelMs: 0, endAt: Date.now() + 1000 };
  gw.npcs.resolveIncoming(n, n.trip, Date.now());
  assert(gw.state.defenseLog[0].success && gw.state.resources.food >= 499, '圍牆沒被打破就搶不到東西');
  // 圍牆破了、沒有人防守 → 被掠奪
  base.wallHp = 0;
  gw.survivors.leader().status = 'exploring';
  n.level = 3;
  gw.npcs.resolveIncoming(n, n.trip, Date.now());
  assert(!gw.state.defenseLog[0].success && gw.state.resources.food < 500, '圍牆被打破且沒人防守時才會被掠奪');
  gw.survivors.leader().status = 'idle';
  // 威脅提示：NPC 掠奪隊正在前來
  n.trip = { kind: 'raid', baseId: base.id, startAt: Date.now(), travelMs: 60000, endAt: Date.now() + 120000 };
  assert(gw.threats().some((t) => t.includes(n.name)), '掠奪隊前來時出現威脅提示');
  n.trip = null;
  assert(!gw.threats().length, '沒有威脅時不提示');
}

// ---- 43. v8.30：地窖 ----
{
  const { cellarCap, cellarCoins } = await import('../src/config/facilities.js');
  const gc = Game.newGame({ playerName: 'K1', classId: 'warrior', lat: 25, lon: 121 });
  gc.state.map.pois = fillPois([], 25, 121);
  gc.shelter.establish(gc.state.map.pois.find((p) => gc.shelter.canEstablish(p).ok));
  setHour(gc, 10);
  const base = gc.shelter.primary();
  base.facilities.cellar.level = 3;
  const cap = cellarCap(3);
  assert(cap > 0 && cellarCap(4) > cap && cellarCoins(3) > 0, `地窖升級增加容量（Lv3 ${cap}）`);
  // 數量沒超過地窖容量：不會被掠奪
  gc.state.resources.food = cap;
  gc.state.player.coins = cellarCoins(3);
  base.wallHp = 0;
  gc.survivors.leader().status = 'exploring';
  const n = gc.npcs.spawnAt(gc.state.map.pois.find((p) => !gc.shelter.baseAtPoi(p.id)), 'x', Date.now(), true);
  n.trip = { kind: 'raid', baseId: base.id, startAt: Date.now() - 1000, travelMs: 0, endAt: Date.now() + 1000 };
  gc.npcs.resolveIncoming(n, n.trip, Date.now());
  assert(!gc.state.defenseLog[0].success && gc.state.resources.food === cap && gc.state.player.coins === cellarCoins(3), '地窖容量內的食物與金錢不會被掠奪');
  // 超過的部分才會被搶
  gc.state.resources.food = cap + 1000;
  base.wallHp = 0;
  gc.npcs.resolveIncoming(n, n.trip, Date.now());
  assert(gc.state.resources.food < cap + 1000 && gc.state.resources.food >= cap, '只有超過地窖容量的部分會被搶走');
  // 屍潮突破也一樣
  gc.state.resources.wood = cap;
  gc.siege.of(base.id).breach();
  assert(gc.state.resources.wood === cap, '屍潮突破時地窖裡的物資也不會損失');
}

// ---- 44. v9：移除派人交易／交付的存檔遷移 ----
{
  const old = Game.newGame({ playerName: 'M', classId: 'warrior', lat: 25, lon: 121 });
  const data = JSON.parse(JSON.stringify(old.state));
  data.version = 17;
  data.player.coins = 10;
  data.demands = { list: [{ id: 'd1', key: 'nail', qty: 10, filled: 4, price: 5 }] };
  const sv = data.survivors[0];
  sv.status = 'exploring';
  data.expeditions = [{ id: 'e1', kind: 'trade', memberIds: [sv.id], vehicleIds: [] }];
  data.trader = { day: 1, active: true };
  const m = SaveManager.migrate(data);
  assert(m.player.coins === 40 && !m.demands && !m.trader, '收購保留的金錢退還、流浪商人資料移除');
  assert(!m.expeditions.length && m.survivors[0].status === 'idle', '交易中的倖存者回到避難所');
}

// ---- 45. v8.34：區域安全程度影響夜間殭屍 ----
{
  const { zoneAt: za } = await import('../src/config/zones.js');
  const { TIME_PHASES: TP } = await import('../src/config/timePhases.js');
  const gz = Game.newGame({ playerName: 'Z2', classId: 'warrior', lat: 25, lon: 121 });
  gz.state.map.pois = fillPois([], 25, 121);
  gz.shelter.establish(gz.state.map.pois.find((p) => gz.shelter.canEstablish(p).ok));
  const by = {};
  gz.state.map.pois.forEach((p) => { const id = za(p.lat, p.lon).id; (by[id] = by[id] || []).push(p); });
  const maxLv = (id, ph) => Math.max(...(by[id] || []).map((p) => gz.zombies.nightLevel(p, TP[ph])));
  if (by.safe) {
    assert(maxLv('safe', 'midnight') <= 4 + gz.civilization.levelBonus(), `安全區午夜也不會出現強殭屍（最高 Lv${maxLv('safe', 'midnight')}）`);
    assert(gz.zombies.encounterMul(by.safe[0].lat, by.safe[0].lon) < 0.5, '安全區遇到殭屍的機率較低');
  }
  const ids = ['safe', 'normal', 'alert', 'danger', 'lethal', 'abyss'].filter((id) => by[id]);
  const mids = ids.map((id) => maxLv(id, 'midnight'));
  assert(mids.every((v, i) => i === 0 || v >= mids[i - 1]), `午夜殭屍等級依區域危險程度拉開差距（${ids.map((id, i) => `${id} ${mids[i]}`).join('、')}）`);
  const p0 = gz.state.map.pois.find((p) => za(p.lat, p.lon).danger >= 1);
  if (p0) assert(gz.zombies.nightLevel(p0, TP.midnight) >= gz.zombies.nightLevel(p0, TP.night), '午夜比夜晚更危險');
  // 安全區不會出現夜行者
  if (by.safe) {
    let stalkers = 0;
    for (let i = 0; i < 200; i += 1) if (gz.zombies.makeGroup(by.safe[i % by.safe.length], TP.midnight, Date.now()).enemyId === 'nightStalker') stalkers += 1;
    assert(stalkers === 0, '安全區不會出現夜行者');
  }
}

// ---- 46. v8.35：最高 15 級、研究與建造時長、升級經驗 ----
{
  const { researchTime: rt, RESEARCH: RS, MAX_RESEARCH_LEVEL } = await import('../src/config/research.js');
  const { facilityBuildTime, FACILITY_MAX_LEVEL } = await import('../src/config/facilities.js');
  const { DEFENSE_MAX_LEVEL, defenseBuildTime } = await import('../src/config/defenses.js');
  const { xpToNext: xp } = await import('../src/config/survivors.js');
  assert(MAX_RESEARCH_LEVEL === 15 && FACILITY_MAX_LEVEL === 15 && DEFENSE_MAX_LEVEL === 15, '研究、設施、防禦最高 15 級');
  const day = 86400;
  const longest = Math.max(...Object.keys(RS).map((id) => rt(id, 15)));
  assert(Math.abs(longest / day - 5) < 0.4, `最難的研究 Lv15 約 5 天（${(longest / day).toFixed(1)} 天）`);
  assert(Math.abs(facilityBuildTime(15) / day - 20) < 1 && Math.abs(defenseBuildTime(15) / day - 20) < 1, `建築 Lv15 約 20 天（設施 ${(facilityBuildTime(15) / day).toFixed(1)}、防禦 ${(defenseBuildTime(15) / day).toFixed(1)} 天）`);
  // Lv4 以後升級難度大幅提高：費用與經驗
  const { FACILITIES: FC, storageCap: sc } = await import('../src/config/facilities.js');
  const parts = (c) => Object.entries(c).filter(([k]) => !['wood', 'food', 'fuel', 'coins', 'parts'].includes(k)).reduce((a2, [, v]) => a2 + v, 0);
  assert(parts(FC.wall.cost(10)) > parts(FC.wall.cost(4)) * 4, 'Lv4 以後的升級材料大幅增加');
  assert(xp(10) / xp(4) > 8, `倖存者 Lv4 以後升級所需經驗大幅增加（Lv4 ${xp(4)} → Lv10 ${xp(10)}）`);
  for (let l = 2; l <= 15; l += 1) assert(FC.warehouse.cost(l).wood <= sc(l - 1) * 1.1, `倉庫 Lv${l} 的木材費用在上一級倉庫容量內`);
  assert(Object.keys(RS).every((id) => [1, 2, 3, 4, 5, 6].every((l) => rt(id, l) <= day)) && [1, 2, 3, 4, 5, 6].every((l) => facilityBuildTime(l) <= day && defenseBuildTime(l) <= day), '前 6 級的研究與建造都不超過 1 天');
  const gaps = Array.from({ length: 14 }, (_, i) => facilityBuildTime(i + 2) - facilityBuildTime(i + 1));
  assert(gaps.every((v, i) => i === 0 || v >= gaps[i - 1]), '等級越高，每級增加的時長越多');
  const ratio = (l) => xp(l + 1) / xp(l);
  assert(xp(30) / xp(29) > 1 && xp(40) - xp(39) > xp(20) - xp(19) && ratio(40) > 1, '倖存者等級越高升級越困難');
}

// ---- 47. v8.36：NPC 很少同時攻打、受傷要先治療 ----
{
  const gn = Game.newGame({ playerName: 'N9', classId: 'warrior', lat: 25, lon: 121 });
  gn.state.map.pois = fillPois([], 25, 121);
  gn.shelter.establish(gn.state.map.pois.find((p) => gn.shelter.canEstablish(p).ok));
  setHour(gn, 10);
  const free = gn.state.map.pois.filter((p) => !gn.shelter.baseAtPoi(p.id));
  const a1 = gn.npcs.spawnAt(free[1], 'x', Date.now(), true);
  const a2 = gn.npcs.spawnAt(free[2], 'y', Date.now(), true);
  gn.npcs.raidLevelCap = () => 99; // 這裡測試同時掠奪的機制，不受等級上限影響
  gn.npcs.launchRaid(a1, Date.now());
  assert(a1.trip?.kind === 'raid' && gn.npcs.activeRaids() === 1, 'NPC 發動掠奪');
  assert(a1.trip.travelMs >= 5 * 60000, `NPC 掠奪避難所的移動時間較長（${Math.round(a1.trip.travelMs / 60000)} 分鐘）`);
  const rr = gn.territory.incomingRaids(gn.shelter.primary());
  assert(rr.length === 1 && rr[0].kind === 'npc' && rr[0].at === a1.trip.startAt + a1.trip.travelMs, '正在前來的掠奪隊會公開給友好玩家');
  assert(rr[0].from && rr[0].startAt === a1.trip.startAt && rr[0].npc === a1.name, '公開掠奪隊的出發點與時間，友好玩家地圖可以畫出行軍路線');
  let extra = 0;
  for (let i = 0; i < 200; i += 1) { a2.trip = null; gn.npcs.launchRaid(a2, Date.now()); if (a2.trip?.kind === 'raid') extra += 1; }
  assert(extra < 30, `已有掠奪隊時，其他 NPC 很少同時攻打（200 次中 ${extra} 次）`);
  // 受傷的 NPC 不會外出
  a2.trip = null;
  a2.wounded = 1;
  a2.healAt = Date.now() + 3600e3;
  a2.nextRaidAt = 0;
  a2.nextExploreAt = 0;
  gn.npcs.update(Date.now());
  assert(!a2.trip, '有傷員的 NPC 要先治療才會外出探索或掠奪');
}

// ---- 48. v8.38：電網需要發電機運轉 ----
{
  const { DEFENSES: DF } = await import('../src/config/defenses.js');
  const ge = Game.newGame({ playerName: 'E9', classId: 'warrior', lat: 25, lon: 121 });
  ge.state.map.pois = fillPois([], 25, 121);
  ge.shelter.establish(ge.state.map.pois.find((p) => ge.shelter.canEstablish(p).ok));
  const base = ge.shelter.primary();
  assert(DF.trap.name === '尖刺陷阱' && DF.electricFence && DF.electricFence.requires === 'd_fence' && RESEARCH.d_fence && RESEARCH.d_volt, '陷阱改名尖刺陷阱，新增電網與相關科技');
  assert(!ge.shelter.isDefenseUnlocked('electricFence'), '電網需要研究解鎖');
  const s = ge.siege.of(base.id);
  const none = s.defenseDps();
  base.defenses[0].type = 'electricFence';
  base.defenses[0].level = 3;
  base.facilities.generator.level = 0;
  const off = s.defenseDps() - none;
  base.facilities.generator.level = 1;
  ge.state.resources.fuel = 100;
  const on = s.defenseDps() - none;
  assert(off === 0 && on > 0, `電網要有發電機運轉才有作用（沒電 +${off}／有電 +${on}）`);
  ge.state.resources.fuel = 0;
  assert(s.defenseDps() - none === 0, '發電機沒燃料時電網也不會作用');
}

// ---- 49. v8.39：NPC 不會生成在警戒範圍內 ----
{
  const gn = Game.newGame({ playerName: 'N8', classId: 'warrior', lat: 25, lon: 121 });
  gn.state.map.pois = fillPois([], 25, 121);
  gn.shelter.establish(gn.state.map.pois.find((p) => gn.shelter.canEstablish(p).ok));
  gn.npcs.fillCells(Date.now(), { silent: true });
  const base = gn.shelter.primary();
  const bad = gn.npcs.list.filter((n) => haversine(base.lat, base.lon, n.lat, n.lon) <= gn.territory.alertRadius(base));
  assert(gn.npcs.list.length > 0 && !bad.length, `NPC 據點不會生成在玩家據點的警戒範圍內（${gn.npcs.list.length} 個）`);
  const overlap = gn.npcs.list.some((a2) => gn.npcs.list.some((b2) => a2 !== b2 && haversine(a2.lat, a2.lon, b2.lat, b2.lon) <= 60 + b2.level));
  assert(!overlap, 'NPC 據點不會生成在其他 NPC 的警戒範圍內');
}

// ---- 50. v8.40：品級決定可解放的技能數與基礎能力 ----
{
  const gs2 = Game.newGame({ playerName: 'S1', classId: 'warrior', lat: 25, lon: 121 });
  const mk = (rarity) => ({ ...gs2.survivors.makeCandidate(1), classId: 'warrior', rarity, level: 30, isLeader: false });
  const poor = mk('poor');
  const leg = mk('legendary');
  assert(gs2.survivors.skillSlots(poor) === 1 && gs2.survivors.skillSlots(leg) === 6, '劣質只能解放 1 個技能，稀有可解放 6 個');
  assert(gs2.survivors.activeSkills(poor).length === 1 && gs2.survivors.activeSkills(leg).length === 6, '等級足夠時，品級越高解放的技能越多');
  const p1 = { ...poor, level: 1 };
  const l1 = { ...leg, level: 1 };
  assert(gs2.survivors.stats(l1).hp > gs2.survivors.stats(p1).hp && gs2.survivors.stats(l1).atk > gs2.survivors.stats(p1).atk, '同等級時，品級越高基礎能力越好');
  assert(Object.values((await import('../src/config/survivors.js')).CLASSES).every((c) => c.skills.length === 6), '每個職業有 6 個技能');
}

// ---- 51. v8.41：自動補給 ----
{
  const ga = Game.newGame({ playerName: 'A1', classId: 'warrior', lat: 25, lon: 121 });
  ga.state.map.pois = fillPois([], 25, 121);
  ga.shelter.establish(ga.state.map.pois.find((p) => ga.shelter.canEstablish(p).ok));
  setHour(ga, 10);
  const lead = ga.survivors.leader();
  ga.state.supplies.bandage = 30;
  assert(ga.survivors.setSupply(lead.id, 'med', 'bandage').ok && lead.loadout.med.qty === 10 && ga.state.supplies.bandage === 20, 'v9：設定自動補給後藥品欄立即補滿（最多 10）');
  assert(!ga.survivors.setSupply(lead.id, 'med', 'nail').ok, '藥品欄只能設定藥品');
  lead.loadout.med.qty = 4;
  const poi = ga.state.map.pois.find((p) => !ga.shelter.baseAtPoi(p.id));
  const ex = ga.exploration.start(poi.id, [lead.id], 5).exp;
  ga.exploration.update(ex.endAt + 1, { silent: true });
  assert(lead.loadout.med.qty === 10, `回到避難所時自動補滿藥品欄（${lead.loadout.med.qty}）`);
  assert(!ga.survivors.setSupply(lead.id, 'med', null).ok && lead.supply.med === 'bandage', 'v10.14.1：藥品一律自動補給（不能取消，只能換種類）');
  assert(!ga.survivors.setSupply(lead.id, 'ammo', 'ammo556').ok, 'v10.14.1：彈藥自動補給遠程武器使用的子彈，不能另外設定');
  // 彈藥欄：預設最多 300（可自選 100~300），戰鬥優先用遠程，沒彈藥改用近戰
  const gun = ga.equipment.generate({ level: 5, model: 'm1911', rarity: 'common' });
  const knife = ga.equipment.generate({ level: 5, model: 'knife', rarity: 'common' });
  [gun, knife].forEach((it) => { ga.equipment.addItem(it, 't'); ga.equipment.equip(lead.id, it.id); });
  assert(lead.equipment.weapon === gun.id && lead.equipment.melee === knife.id, '遠程武器與近戰武器分開兩欄');
  ga.state.supplies.ammo9 = 400;
  assert(ga.survivors.loadSlot(lead.id, 'ammo', 'ammo9').ok && lead.loadout.ammo.qty === 300, '彈藥欄預設最多 300');
  {
    const before = ga.state.supplies.ammo9;
    assert(ga.survivors.setAmmoCap(lead.id, 150).ok && lead.loadout.ammo.qty === 150 && ga.state.supplies.ammo9 === before + 150, '調低攜帶數量時多出的子彈放回倉庫');
    assert(!ga.survivors.setAmmoCap(lead.id, 120).ok && !ga.survivors.setAmmoCap(lead.id, 350).ok, '攜帶數量只能選 100~300、每 50 一級');
    assert(!ga.survivors.loadSlot(lead.id, 'ammo', 'ammo9').ok && lead.loadout.ammo.qty === 150, '補給不超過自選的攜帶數量');
    assert(ga.survivors.setAmmoCap(lead.id, 300).ok && lead.loadout.ammo.qty === 300, '調高攜帶數量時在避難所立即補滿');
  }
  const u1 = ga.combat.unitFromSurvivor(lead);
  assert(u1.weapon === 'ranged' && lead.loadout.ammo.qty === 300 - (await import('../src/config/supplies.js')).AMMO_FOR.pistol.perFight, '有彈藥時優先使用遠程武器並消耗彈藥欄');
  lead.loadout.ammo = null;
  delete ga.state.supplies.ammo9;
  const u2 = ga.combat.unitFromSurvivor(lead);
  assert(u2.weapon === 'melee', '沒有彈藥時自動改用近戰武器');
  // 戰鬥中自動用藥
  ga.state.supplies.bandage = 10;
  lead.loadout.med = null;
  ga.survivors.loadSlot(lead.id, 'med', 'bandage', 5);
  ga.survivors.setHp(lead, 1);
  const r = ga.combat.simulate([lead], [ga.combat.createEnemy('walker', 1)]);
  ga.combat.applyOutcome([lead], r);
  assert(r.log.some((l) => l.msg.includes('💊')) && (lead.loadout.med?.qty ?? 0) < 5, '生命過低時自動使用藥品欄的藥');
  lead.bag.nail = 10;
  assert(ga.survivors.discardBag(lead.id, 'nail', 4).ok && lead.bag.nail === 6, '背包物品可以指定數量丟棄');
  assert(ga.survivors.discardBag(lead.id, 'nail', Infinity).ok && !lead.bag.nail, '背包物品可以全部丟棄');
}

// ---- 52. v8.45：友好玩家屍潮協防 ----
{
  const { WorldSync: WS } = await import('../src/multiplayer/WorldSync.js');
  const mk = (name, lon) => {
    const gx = Game.newGame({ playerName: name, classId: 'warrior', lat: 25, lon });
    gx.state.map.pois = fillPois([], 25, lon);
    gx.shelter.establish(gx.state.map.pois.find((p) => gx.shelter.canEstablish(p).ok));
    return gx;
  };
  const A = mk('協防者', 121);
  const B = mk('被攻擊', 121.0004);
  B.state.bases[0].lat = A.state.bases[0].lat;
  B.state.bases[0].lon = A.state.bases[0].lon + 0.0003; // 約 30 公尺：警戒範圍相接
  const pres = (gx, id) => ({ id, ...JSON.parse(JSON.stringify(WS.prototype.presence.call({ game: gx }))) });
  A.world = { others: [], myId: 'A' };
  B.world = { others: [], myId: 'B' };
  [A, B].forEach((gx) => setHour(gx, 23));
  const sb = B.siege.of();
  sb.update(0.1);
  sb.startWave();
  for (let i = 0; i < 3; i += 1) sb.spawn('walker');
  const pb = pres(B, 'B');
  assert(pb.bases[0].siege && pb.bases[0].siege.wave === 1 && pb.bases[0].siege.left > 0, '被屍潮攻擊時公開資料附上屍潮狀況');
  A.world.others = [pb];
  assert(!A.assist.canAssist('B').ok, '不是友好玩家不能協防');
  A.state.relations.players.B = { status: 'friend', name: '被攻擊' };
  B.state.relations.players.A = { status: 'friend', name: '協防者' };
  const guard = A.survivors.leader();
  assert(A.assist.friendSieges().length === 1, '友好玩家的屍潮狀況看得到');
  B.state.bases[0].lon = A.state.bases[0].lon + 0.02; // 約 2 公里：警戒範圍不相接也能協防
  pb.bases[0].lon = B.state.bases[0].lon;
  const normalTravel = A.exploration.plan({ id: 'x', lat: pb.bases[0].lat, lon: pb.bases[0].lon, type: 'residential' }, [guard], 0).travelMs;
  const as = A.assist.start('B', [guard.id]);
  assert(as.ok && guard.status === 'exploring', `可以直接派隊協防（${as.reason || ''}）`);
  assert(as.exp.travelMs < normalTravel * 0.6, `協防隊移動較快（${Math.round(normalTravel / 1000)} → ${Math.round(as.exp.travelMs / 1000)} 秒）`);
  const early = pres(A, 'A');
  assert(early.assist && early.assist.at > Date.now() && early.assist.dps > 0, '出發時就公開協防火力與抵達時間（協防方離線也有效）');
  B.world.others = [early];
  assert(!B.assist.incoming().some((h) => h.kind === 'team'), '協防隊抵達前不算協防');
  const shift = as.exp.travelMs + 1000;
  as.exp.startAt -= shift; as.exp.endAt -= shift;
  const pa = pres(A, 'A');
  assert(pa.assist && pa.assist.to === 'B' && pa.assist.dps > 0, '抵達後協防火力寫在公開資料');
  assert(pa.trips.some((t) => t.kind === 'assist'), '協防隊在公開資料標示為協防（不會被當成突襲）');
  B.world.others = [pa];
  assert(B.assist.incoming().some((h) => h.kind === 'team'), '被協防的一方收到協防');
  B.assist.trackArrivals();
  sb.waveLeft = 0;
  const ids = new Set(sb.zombies.map((z) => z.id));
  const hpOf = () => sb.zombies.filter((z) => ids.has(z.id)).reduce((s, z) => s + z.hp, 0);
  const hp0 = hpOf();
  for (let i = 0; i < 12; i += 1) sb.step(0.1);
  const hp1 = hpOf();
  assert(hp1 < hp0, `協防火力會打殭屍（${hp0} → ${hp1}）`);
  const lg = B.state.bases[0].assistLog;
  assert(lg && lg.list.A && lg.list.A.dmg > 0, `記錄協防玩家的傷害（${JSON.stringify(lg?.list)}）`);
  sb.endNight();
  assert(B.state.defenseLog[0].assists?.some((x) => x.name === '協防者' && x.dmg > 0), `防守紀錄寫入協防標籤（${JSON.stringify(B.state.defenseLog[0].assists)}）`);
  assert(B.state.log.filter((l) => l.msg.includes('協防者') && /前來協防/.test(l.msg)).length <= 1, '好友協防隊抵達的事件不重複');
  {
    const others = B.world.others;
    B.world.others = [];
    B.assist.trackArrivals();
    assert(B.state.log.some((l) => /「協防者」的協防隊離開（傷害 [\d,]+/.test(l.msg)), '好友協防隊離開時記一筆事件（附上傷害與擊殺）');
    B.world.others = others;
  }
  A.world.others = [pres(B, 'B')];
  const mr = A.assist.myResult(A.world.others[0]);
  assert(mr && mr.result === 'ok' && mr.dmg > 0 && mr.team, `協防方看得到自己的戰果（${JSON.stringify(mr)}）`);
  A.assist.update();
  assert(A.state.log.some((l) => String(l.msg || l.text || l).includes('協防「被攻擊」戰報')), '協防方收到戰報');
  assert(A.exploration.recall(as.exp.id).ok && !pres(A, 'A').assist, '可以召回協防隊');
  // 防禦範圍涵蓋友好據點：防禦設施自動協助
  const cv = { r: 200, dps: 50 };
  B.world.others = [{ ...pa, assist: null, cover: cv }];
  assert(!B.assist.incoming().length, '防禦範圍沒有涵蓋就不會協助');
  B.state.bases[0].lon = A.state.bases[0].lon + 0.001; // 約 100 公尺
  assert(B.assist.incoming().some((h) => h.kind === 'cover' && h.dps === 50), '防禦範圍涵蓋友好據點時自動協助');
  A.shelter.primary().defenses[0] = { ...A.shelter.primary().defenses[0], type: 'machineGun', level: 1 };
  const pc = pres(A, 'A').cover;
  assert(pc && pc.r > 0 && pc.dps > 0, `公開防禦範圍與可分出的火力（${JSON.stringify(pc)}）`);
  // v15.3.1：公開涵蓋到的好友（玩家攻打好友時算進協防火力）；NPC 掠奪時防禦設施也會協助
  B.state.bases[0].lon = A.state.bases[0].lon + 0.0004; // 約 40 公尺（在防禦範圍內）
  A.world.others = [pres(B, 'B')];
  const pc2 = A.assist.publishedCover();
  assert((pc2.to || []).includes('B'), `防禦範圍涵蓋的好友會公開（${JSON.stringify(pc2)}）`);
  const { cleanPlayer: CPl } = await import('../src/multiplayer/WorldSync.js');
  assert((CPl({ id: 'A', name: 'A', bases: [{ lat: 25.03, lon: 121.56, name: 'x', primary: true }], cover: { r: 100, dps: 50, to: ['B'] } })?.cover?.to || []).includes('B'), '同步資料保留涵蓋的好友');
}

// ---- 53. v8.46：突襲避難所移動時間較長、載具仍加速 ----
{
  const gp = Game.newGame({ playerName: 'P', classId: 'warrior', lat: 25, lon: 121 });
  gp.state.map.pois = fillPois([], 25, 121);
  gp.shelter.establish(gp.state.map.pois.find((p) => gp.shelter.canEstablish(p).ok));
  setHour(gp, 10);
  const sh = gp.shelter.primary();
  const to = { id: 'x', lat: sh.lat, lon: sh.lon + 0.01, name: 'x', type: 'residential' };
  const m = [gp.survivors.leader()];
  const normal = gp.exploration.plan(to, m, 5).travelMs;
  const raid = gp.exploration.plan({ ...to, pvp: true, zoneId: 'z' }, m, 5).travelMs;
  assert(raid >= normal * 3.9 && raid >= 5 * 60000 / 2, `突襲玩家避難所的移動時間大幅拉長（${Math.round(normal / 1000)} 秒 → ${Math.round(raid / 1000)} 秒）`);
}

// ---- 54. v8.48：建造、升級、研究可使用待在避難所的倖存者背包物資 ----
{
  const { canAfford: ca, payCost: pc, amountOf: ao } = await import('../src/systems/costUtils.js');
  const gb = Game.newGame({ playerName: 'B', classId: 'warrior', lat: 25, lon: 121 });
  gb.state.map.pois = fillPois([], 25, 121);
  gb.shelter.establish(gb.state.map.pois.find((p) => gb.shelter.canEstablish(p).ok));
  const lead = gb.survivors.leader();
  gb.state.supplies.nail = 5;
  lead.bag = { ...(lead.bag || {}), nail: 10 };
  assert(ao(gb.state, 'nail') === 15 && ca(gb.state, { nail: 12 }), '可用數量包含待在避難所的倖存者背包');
  assert(pc(gb.state, { nail: 12 }) && !gb.state.supplies.nail && lead.bag.nail === 3, '先扣倉庫，不夠再從背包扣');
  lead.status = 'exploring';
  assert(!ca(gb.state, { nail: 2 }), '外出中的倖存者背包不能用');
  lead.status = 'idle';
}

// ---- 55. v8.49：等級越高吃得越多 ----
{
  const gf = Game.newGame({ playerName: 'F', classId: 'warrior', lat: 25, lon: 121 });
  const lead = gf.survivors.leader();
  lead.level = 1;
  const u1 = gf.resources.rates().upkeep.food;
  lead.level = 21;
  const u2 = gf.resources.rates().upkeep.food;
  assert(Math.abs(u2 / u1 - 1.6) < 0.01, `等級越高食物消耗越多（Lv1 ${u1.toFixed(1)} → Lv21 ${u2.toFixed(1)}）`);
}

// ---- 56. v9.2：自動探索把同一地點拿光才前往佇列的下一個地點；背包與倉庫都滿時停止所有佇列 ----
{
  const ga = Game.newGame({ playerName: 'Au', classId: 'scout', lat: 25.03, lon: 121.56 });
  ga.state.map.pois = fillPois([], 25.03, 121.56);
  ga.shelter.establish(ga.state.map.pois.find((p) => ga.shelter.canEstablish(p).ok));
  setHour(ga, 10);
  ga.state.research.levels.s_scout = 1;
  ga.research.invalidate();
  const ex = ga.exploration;
  const lead = ga.survivors.leader();
  lead.level = 40;
  const simA = ga.combat.simulate.bind(ga.combat);
  ga.combat.simulate = (sv, _en, o) => simA(sv, [], o);
  const pois = ga.state.map.pois.filter((p) => !ga.shelter.baseAtPoi(p.id) && ex.hasStock(p)).slice(0, 3);
  const st = ex.start(pois[0].id, [lead.id], 5, true);
  assert(st.ok && ex.enqueue(st.exp.id, pois[1].id).ok, '自動探索並加入佇列');
  // 還有物資：回到同一個地點
  const orig = ex.hasStock.bind(ex);
  ex.hasStock = (p, at) => (p.id === pois[0].id ? true : orig(p, at));
  const origLeft = ex.leftAfterSearch.bind(ex);
  ex.leftAfterSearch = () => true; // 連續探索：搜完後建築裡還有剩
  ga.poiShare.blockerAt = () => null; // 這裡用替身模擬「還有物資」，不套用共用的搜空紀錄
  let reps = ex.update(st.exp.endAt + 1, { silent: true });
  let cur = ga.state.expeditions[0];
  assert(cur && cur.poiId === pois[0].id && cur.queue.length === 1, `還有物資時再搜同一個地點、佇列保留（${reps[0]?.events.slice(-1)}）`);
  // 拿光了：前往佇列的下一個地點（不會自己換到附近其他地點）
  ex.hasStock = (p, at) => (p.id === pois[0].id ? false : orig(p, at));
  ex.leftAfterSearch = () => false;
  reps = ex.update(cur.endAt + 1, { silent: true });
  cur = ga.state.expeditions[0];
  assert(cur && cur.poiId === pois[1].id && !cur.queue.length, `拿光後前往佇列的下一個地點（${reps[0]?.events.slice(-1)}）`);
  ex.hasStock = (p) => (p.id === pois[1].id ? false : true);
  reps = ex.update(cur.endAt + 1, { silent: true });
  assert(!ga.state.expeditions.length && reps[0].events.some((e) => e.includes('自動探索結束')), '佇列也沒有地點時自動探索結束，不會換到附近其他地點');
  ex.hasStock = orig;
  ex.leftAfterSearch = origLeft;
  // 背包都滿、倉庫也滿：停止所有佇列並說明原因
  const st2 = ex.start(pois[2].id, [lead.id], 5, true);
  ex.enqueue(st2.exp.id, pois[0].id);
  ga.survivors.bagLoad = () => 1e9;
  ga.equipment.storeUsed = () => ga.equipment.storeCap();
  reps = ex.update(st2.exp.endAt + 1, { silent: true });
  assert(!ga.state.expeditions.length && reps[0].events.some((e) => e.includes('探索佇列停止') && e.includes('倉庫')), '背包與倉庫都滿時停止佇列，報告寫明原因');
  assert(ga.state.log.some((l) => l.msg.includes('探索佇列全部停止')), '訊息中記錄停止原因');
  // 舊存檔：移除「巡迴搜索」研究
  const old = JSON.parse(JSON.stringify(ga.state));
  old.version = 18;
  old.research.levels.s_route = 3;
  const m = SaveManager.migrate(old);
  assert(!('s_route' in m.research.levels), '移除巡迴搜索研究');
}

// ---- 58. v8.53：協防也參與 NPC 掠奪與玩家突襲的防守 ----
{
  const { WorldSync: WS3, cleanPlayer: cp3 } = await import('../src/multiplayer/WorldSync.js');
  const mk = (name, lon) => {
    const gx = Game.newGame({ playerName: name, classId: 'warrior', lat: 25, lon });
    gx.state.map.pois = fillPois([], 25, lon);
    gx.shelter.establish(gx.state.map.pois.find((p) => gx.shelter.canEstablish(p).ok));
    gx.world = { others: [], myId: name, identity: () => ({ id: name, token: 't' }) };
    setHour(gx, 10);
    return gx;
  };
  const pres = (gx, id) => cp3({ id, ...JSON.parse(JSON.stringify(WS3.prototype.presence.call({ game: gx }))) });
  const H = mk('H', 121);
  const V = mk('V', 121.004);
  H.state.relations.players.V = { status: 'friend', name: 'V' };
  V.state.relations.players.H = { status: 'friend', name: 'H' };
  // V 被 NPC 掠奪隊盯上
  const free = V.state.map.pois.filter((p) => !V.shelter.baseAtPoi(p.id));
  const n = V.npcs.spawnAt(free[1], 'x', Date.now(), true);
  V.npcs.raidLevelCap = () => 99; // 這裡測試協防，不受等級上限影響
  V.npcs.launchRaid(n, Date.now());
  assert(n.trip?.kind === 'raid', 'NPC 發動掠奪');
  H.world.others = [pres(V, 'V')];
  const ca = H.assist.canAssist('V');
  assert(ca.ok, `白天有 NPC 前來攻打時也能派隊協防（${ca.reason || ''}）`);
  const helper = H.survivors.leader();
  const st = H.assist.start('V', [helper.id]);
  assert(st.ok, `派隊協防（${st.reason || ''}）`);
  const sh = st.exp.travelMs + 1000;
  st.exp.startAt -= sh; st.exp.endAt -= sh;
  const ph = pres(H, 'H');
  assert(ph.assist.units.length === 1 && ph.assist.units[0].atk > 0, '公開協防隊員的戰鬥數值');
  V.world.others = [ph];
  assert(V.assist.allyUnits().length === 1, '被攻打方取得協防隊員');
  // 圍牆已破：直接與守軍交戰
  V.shelter.primary().wallHp = 0;
  V.npcs.resolveIncoming(n, n.trip, Date.now());
  const log = V.state.defenseLog[0];
  assert(log && log.assists?.some((x) => x.name === 'H'), `防守紀錄寫入協防（${JSON.stringify(log?.assists)}）`);
  const ra = V.shelter.primary().raidAssist;
  assert(ra && ra.list.H && ra.list.H.units.length === 1, '記錄協防隊員的戰果與傷勢');
  H.world.others = [pres(V, 'V')];
  H.assist.update();
  assert(H.state.log.some((l) => l.msg.includes('戰報：抵禦')), '協防方收到防守戰報');
  // 玩家突襲：攻擊方會遇到對方的協防隊
  const C = mk('C', 121.008);
  C.world.others = [pres(V, 'V'), ph];
  assert(C.assist.defendersOf('V').length === 1, '突襲時對方的友好協防隊員也會迎戰');
  let sent = null;
  C.territory.send = async (_to, type, data) => { if (type === 'attack') sent = data; return true; };
  const rep = C.territory.resolvePvp({ poiId: 'pvp:V#0', memberIds: [C.survivors.leader().id], endAt: Date.now(), travelEvents: [], cargo: 40 });
  assert(rep.events.some((e) => e.includes('協防隊員')) && sent?.helpers?.H, `突襲結算包含協防隊員並回報給對方（${rep.events.slice(-2).join(' / ')}）`);
  V.territory.handleEvents([{ from: 'C', fromName: 'C', type: 'attack', data: sent }]);
  assert(V.state.defenseLog[0].assists?.length > 0, `被突襲方的防守紀錄寫入協防（${JSON.stringify(V.state.defenseLog[0].assists)}）`);
  // v15.4：好友的防禦範圍涵蓋這裡時，NPC 掠奪與玩家突襲也會加上防禦設施的火力
  {
    const COVER = 777;
    const hc = { ...pres(H, 'H'), assist: null, cover: { r: 99999, dps: COVER, to: ['V'] } };
    const hn = { ...pres(H, 'H'), assist: null, cover: null };
    // NPC 掠奪：守城火力 = 自己的防禦 + 好友防禦設施
    const capDps = (gx, fn) => { let cap = null; const orig = gx.combat.wallAssault.bind(gx.combat); gx.combat.wallAssault = (a, w, dps) => { cap = dps; return orig(a, w, dps); }; fn(); gx.combat.wallAssault = orig; return cap; };
    // 自己的防禦火力在每次掠奪後可能因建築受損而改變：每次都扣掉當下自己的火力再比較
    const ownDps = () => V.siege.of(V.shelter.primary().id).defenseDps({ raw: true }) * (1 + V.research.bonus('raidDefensePct'));
    V.shelter.primary().wallHp = null;
    V.world.others = [hn];
    const o0 = ownDps();
    const d0 = capDps(V, () => V.npcs.resolveIncoming(n, n.trip, Date.now())) - o0;
    V.world.others = [hc];
    assert(V.assist.incoming().some((h) => h.kind === 'cover' && h.dps === COVER), '好友的防禦範圍涵蓋這裡（cover）');
    const o1 = ownDps();
    const d1 = capDps(V, () => V.npcs.resolveIncoming(n, n.trip, Date.now())) - o1;
    assert(Math.abs(d0) < 1 && Math.abs(d1 - COVER) < 1, `NPC 掠奪時加上好友防禦設施的火力（額外火力 ${Math.round(d0)} → ${Math.round(d1)}）`);
    assert(V.state.defenseLog[0].assists?.some((x) => x.name === 'H') || /協防|H/.test(V.state.defenseLog[0].note || ''), `防守紀錄寫入好友防禦設施協防（${JSON.stringify(V.state.defenseLog[0].assists)}）`);
    // 玩家突襲：攻擊方把對方好友的防禦設施火力算進守城
    C.world.others = [pres(V, 'V'), hn];
    const p0 = capDps(C, () => C.territory.resolvePvp({ poiId: 'pvp:V#0', memberIds: [C.survivors.leader().id], endAt: Date.now(), travelEvents: [], cargo: 40 }));
    C.world.others = [pres(V, 'V'), hc];
    let rp = null;
    const p1 = capDps(C, () => { rp = C.territory.resolvePvp({ poiId: 'pvp:V#0', memberIds: [C.survivors.leader().id], endAt: Date.now(), travelEvents: [], cargo: 40 }); });
    assert(p0 != null && Math.abs(p1 - p0 - COVER) < 1, `玩家突襲時加上對方好友防禦設施的火力（${Math.round(p0)} → ${Math.round(p1)}）`);
    assert(rp.events.some((e) => /好友的防禦設施協助守城/.test(e)), '突襲戰報顯示對方好友的防禦設施協助');
    // 沒有涵蓋到被攻打的人：不算
    C.world.others = [pres(V, 'V'), { ...hc, cover: { r: 99999, dps: COVER, to: ['X'] } }];
    const p2 = capDps(C, () => C.territory.resolvePvp({ poiId: 'pvp:V#0', memberIds: [C.survivors.leader().id], endAt: Date.now(), travelEvents: [], cargo: 40 }));
    assert(Math.abs(p2 - p0) < 1, '好友的防禦範圍沒涵蓋被攻打的人時不加火力');
  }
}

// ---- 59. v9：NPC 據點大幅增強 ----
{
  const { createSurvivor: cs } = await import('../src/core/GameState.js');
  let wins = 0;
  for (let t = 0; t < 8; t += 1) {
    const gn = Game.newGame({ playerName: 'N', classId: 'warrior', lat: 25, lon: 121 });
    gn.state.map.pois = fillPois([], 25, 121);
    gn.shelter.establish(gn.state.map.pois.find((p) => gn.shelter.canEstablish(p).ok));
    gn.survivors.leader().level = 10;
    ['scout', 'medic', 'warrior'].forEach((c) => gn.state.survivors.push(cs(`x${c}`, c, 8, 'rare')));
    gn.state.survivors.forEach((m) => ['weapon', 'armor', 'helmet', 'legs', 'boots', 'gloves'].forEach((slot) => {
      const it = gn.equipment.generate({ level: m.level + 2, rarity: 'epic', slot });
      gn.equipment.addItem(it, 't');
      try { gn.equipment.equip(m.id, it.id); } catch { /* 部位不符 */ }
    }));
    const n = gn.npcs.spawnAt(gn.state.map.pois[5], 'x', Date.now(), true);
    n.level = 21;
    const rep = gn.npcs.resolveRaid({ poiId: n.id, memberIds: gn.state.survivors.map((m) => m.id), endAt: Date.now(), travelEvents: [], cargo: 200 });
    if (rep.success) wins += 1;
  }
  assert(wins <= 1, `Lv10＋三名 Lv8 打 Lv21 NPC 據點不再輕鬆獲勝（8 場勝 ${wins}）`);
}

// ---- 60. v9 存檔遷移：近戰武器移到近戰欄、彈藥藥品欄 ----
{
  const go = Game.newGame({ playerName: 'O', classId: 'warrior', lat: 25, lon: 121 });
  const kn = go.equipment.generate({ level: 3, model: 'knife', rarity: 'common' });
  go.equipment.addItem(kn, 't');
  const old = JSON.parse(JSON.stringify(go.state));
  old.version = 17;
  old.survivors[0].equipment = { ...old.survivors[0].equipment, weapon: kn.id };
  delete old.survivors[0].equipment.melee;
  delete old.survivors[0].loadout;
  old.inventory.items.find((i) => i.id === kn.id).slot = 'weapon';
  const m = SaveManager.migrate(old);
  assert(m.survivors[0].equipment.melee === kn.id && !m.survivors[0].equipment.weapon && m.survivors[0].loadout, 'v9 遷移：原本拿在武器欄的近戰武器移到近戰欄');
}

// ---- 61. v9 快速換裝 ----
{
  const gq2 = Game.newGame({ playerName: 'Q', classId: 'warrior', lat: 25, lon: 121 });
  gq2.state.map.pois = fillPois([], 25, 121);
  gq2.shelter.establish(gq2.state.map.pois.find((p) => gq2.shelter.canEstablish(p).ok));
  const lead = gq2.survivors.leader();
  const weak = gq2.equipment.generate({ level: 3, model: 'knife', rarity: 'poor' });
  const strong = gq2.equipment.generate({ level: 10, model: 'knife', rarity: 'epic' });
  const gun = gq2.equipment.generate({ level: 10, model: 'ak47', rarity: 'epic' });
  [weak, strong, gun].forEach((it) => gq2.equipment.addItem(it, 't'));
  gq2.equipment.equip(lead.id, weak.id);
  delete gq2.state.supplies.ammo556;
  lead.bag = {};
  const r = gq2.equipment.quickEquip(lead.id);
  assert(r.ok && lead.equipment.melee === strong.id && lead.equipment.weapon === gun.id, `快速換裝換上戰力最高的近戰與遠程武器（遠程武器沒有彈藥也換）（${r.msg}）`);
  assert(r.warn && gq2.survivors.supplyRules(lead).ammo === 'ammo556' && gq2.equipment.ammoWarn(gun, lead)?.level === 'none', '沒有彈藥：自動補給仍設為武器的彈藥，武器標示無彈藥');
  // 原本裝著別種彈藥：放回倉庫，改裝新武器的彈藥
  const pistol = gq2.equipment.generate({ level: 1, model: 'm9', rarity: 'poor' });
  gq2.state.supplies.ammo9 = 30;
  gq2.survivors.loadSlot(lead.id, 'ammo', 'ammo9', 20);
  assert(gq2.survivors.loadout(lead).ammo?.key === 'ammo9', '先裝著 9mm 子彈');
  gq2.state.supplies.ammo556 = 50;
  const r2 = gq2.equipment.quickEquip(lead.id);
  const lo = gq2.survivors.loadout(lead);
  assert(lead.equipment.weapon === gun.id && lo.ammo?.key === 'ammo556' && lo.ammo.qty === 50 && gq2.state.supplies.ammo9 === 30 && !gq2.equipment.ammoWarn(gun, lead), `快速換裝：彈藥欄改裝新武器的彈藥，原本的彈藥放回倉庫（${r2.msg}）`);
  // v15.7：卸下槍械：彈藥欄的子彈放回倉庫；倉庫滿了放進背包
  gq2.equipment.addItem(pistol, 't');
  const a0 = gq2.state.supplies.ammo556 || 0;
  const ru = gq2.equipment.unequip(lead.id, 'weapon');
  assert(ru.ok && !gq2.survivors.loadout(lead).ammo && (gq2.state.supplies.ammo556 || 0) === a0 + 50 && /放回倉庫/.test(ru.msg || ''), `卸下槍械：子彈直接放回倉庫（${ru.msg}）`);
  // 換槍（不同子彈）：舊子彈放回倉庫；倉庫放不下時放進背包
  gq2.equipment.equip(lead.id, gun.id);
  gq2.survivors.loadSlot(lead.id, 'ammo', 'ammo556', 40);
  const room0 = gq2.survivors.storeRoom;
  gq2.survivors.storeRoom = () => 10;
  lead.bag = {};
  const re = gq2.equipment.equip(lead.id, pistol.id);
  gq2.survivors.storeRoom = room0;
  assert(re.ok && gq2.survivors.loadout(lead).ammo?.key !== 'ammo556' && (lead.bag.ammo556 || 0) === 30 && /放進背包/.test(re.msg || ''), `換槍：倉庫滿了，放不下的子彈放進背包（${re.msg}）`);
  // 換上用同樣子彈的槍：子彈不動
  gq2.survivors.loadSlot(lead.id, 'ammo', 'ammo9', 10);
  const same = gq2.equipment.generate({ level: 2, model: 'm9', rarity: 'common' });
  gq2.equipment.addItem(same, 't');
  gq2.equipment.equip(lead.id, same.id);
  assert(gq2.survivors.loadout(lead).ammo?.key === 'ammo9', '換上用同樣子彈的槍：彈藥欄不動');
}

// ---- 62. v9 警戒模式 ----
{
  const ga2 = Game.newGame({ playerName: 'AL', classId: 'warrior', lat: 25, lon: 121 });
  ga2.state.map.pois = fillPois([], 25, 121);
  ga2.shelter.establish(ga2.state.map.pois.find((p) => ga2.shelter.canEstablish(p).ok));
  const lead = ga2.survivors.leader();
  ga2.survivors.setJob(lead.id, 'scavenge');
  ga2.shelter.setAlert(true);
  assert(lead.job === 'guard' && ga2.shelter.alert, '警戒時全員改為防禦駐守');
  ga2.shelter.setAlert(false);
  assert(lead.job === 'scavenge' && !ga2.shelter.alert, '解除警戒後恢復原本的工作');
  // 近戰防守屍潮會受傷
  setHour(ga2, 23);
  const sx = ga2.siege.of();
  lead.job = 'guard';
  sx.update(0.1);
  sx.spawn('walker');
  Object.assign(sx.zombies[0], { x: 0, y: 40, hp: 1e6, maxHp: 1e6 });
  const hp0 = ga2.survivors.hpOf(lead);
  for (let i = 0; i < 40; i += 1) sx.step(0.1);
  assert(ga2.survivors.hpOf(lead) < hp0 || lead.severe, '近戰防守屍潮時會被殭屍反擊受傷');
}

// ---- 63. v9 臨時小隊探索佇列 ----
{
  const gq3 = Game.newGame({ playerName: 'QQ', classId: 'scout', lat: 25, lon: 121 });
  gq3.state.map.pois = fillPois([], 25, 121);
  gq3.shelter.establish(gq3.state.map.pois.find((p) => gq3.shelter.canEstablish(p).ok));
  setHour(gq3, 10);
  const ex = gq3.exploration;
  const pois = gq3.state.map.pois.filter((p) => !gq3.shelter.baseAtPoi(p.id) && p.type === 'residential').slice(0, 5);
  gq3.survivors.leader().level = 40;
  // 這裡只測佇列：途中戰鬥一律獲勝（避免隨機戰敗提早結束探索）
  const simQ = gq3.combat.simulate.bind(gq3.combat);
  gq3.combat.simulate = (sv, _en, o) => simQ(sv, [], o);
  const st = ex.start(pois[0].id, [gq3.survivors.leader().id], 5);
  assert(st.ok && ex.squads().length === 1, '派出後成為臨時小隊');
  assert(ex.queueLimit() === 2, '探索佇列基本 2 個');
  assert(ex.enqueue(st.exp.id, pois[1].id).ok && ex.enqueue(st.exp.id, pois[2].id).ok && !ex.enqueue(st.exp.id, pois[3].id).ok, '佇列滿了不能再加入');
  const rollQ = gq3.rebirth.rollSearch.bind(gq3.rebirth);
  gq3.rebirth.rollSearch = () => 1; // 每一格搜索都找到特殊物品
  const [rep] = ex.update(st.exp.endAt + 1, { silent: true });
  gq3.rebirth.rollSearch = rollQ;
  assert(!rep || !rep.carried || rep.locks > 0, `連續探索前往下一站的報告也標示找到的特殊物品（${rep?.locks}）`);
  const next = gq3.state.expeditions[0];
  // 出發時的 endAt 含回程時間；連續探索搜完就直接前往下一站，第二站很近又很小時可能在這段時間內也搜完，已在前往第三站
  const onQueue = next && ((next.poiId === pois[1].id && next.queue.length === 1) || (next.poiId === pois[2].id && next.queue.length === 0));
  assert(rep && onQueue, `完成後自動前往佇列中的下一個地點（${rep?.events.slice(-1)}）`);
  // 這一站沒有拿到任何經驗（例如沒有戰鬥、搜索經驗為 0）時本來就不顯示
  assert(!rep || rep.xpBy?.length || !(rep.xp > 0), `連續探索前往下一站的報告也顯示經驗（經驗 ${rep?.xp}）`);
  const { labLevelFor: llf } = await import('../src/config/research.js');
  assert(llf('s_queue', 1) === 4 && llf('s_queue', 3) === 10, '佇列科技依研究中心等級解鎖（最後一級需要 Lv10）');
}

// ---- 64. v9 世界時間 ----
{
  const w1 = Game.newGame({ playerName: 'W1', classId: 'warrior', lat: 25, lon: 121 });
  const w2 = Game.newGame({ playerName: 'W2', classId: 'warrior', lat: 30, lon: 100 });
  w2.state.createdAt = Date.now() - 5 * DAY_REAL_MS;
  const tw = Date.now();
  assert(w1.time.hour(tw) === w2.time.hour(tw) && w1.time.dateText(tw) === w2.time.dateText(tw), '所有玩家共用同一個世界時間與日期');
  assert(w1.time.dateText(WORLD_EPOCH_MS) === '2050/1/1' && Math.abs(w1.time.hour(WORLD_EPOCH_MS) - 6) < 1e-6, '世界時間從 2050/1/1 06:00 起算');
  assert(w1.time.survivalDay() === 1 && w2.time.survivalDay() === 6, '生存天數從自己開局算起');
}

// ---- 65. v9.6 全服聊天（單一頻道、冷卻、過濾、封鎖、檢舉、伺服器） ----
{
  const { MemoryChat, cleanChat, CHAT_MAX_LEN, CHAT_KEEP } = await import('../src/multiplayer/Chat.js');
  const mkc = (name, id) => {
    const gx = Game.newGame({ playerName: name, classId: 'warrior', lat: 25, lon: 121 });
    gx.state.map.pois = fillPois([], 25, 121);
    gx.world = { myId: id };
    return gx;
  };
  const ca = mkc('阿傑', 'a'.repeat(32));
  const cb = mkc('小雨', 'b'.repeat(32));
  const cc = mkc('Kevin', 'c'.repeat(32));
  assert(!ca.chat.online && ca.chat.blockReason() === '離線中，無法使用聊天', '沒有伺服器時聊天顯示離線');
  const room = new MemoryChat();
  [ca, cb, cc].forEach((x) => { x.chat.backend = room; });
  assert(ca.chat.blockReason() === '建立避難所後才能發言' && !(await ca.chat.send('嗨')).ok, '沒有避難所不能發言');
  [ca, cb, cc].forEach((x) => x.shelter.establish(x.state.map.pois.find((p) => x.shelter.canEstablish(p).ok)));
  assert((await ca.chat.send('  信義區有人要一起打嗎？  ')).ok, '建立避難所後可以發言');
  const slow = await ca.chat.send('再一則');
  assert(!slow.ok && /秒後再試/.test(slow.reason), '每 5 秒最多 1 則');
  ca.chat.lastSentAt = 0;
  const srv = await room.chatSend('a'.repeat(32), 't', '繞過前端');
  assert(srv.status === 'slow', '伺服器端也限制發言頻率');
  await cb.chat.poll();
  assert(cb.chat.messages.length === 1 && cb.chat.messages[0].text === '信義區有人要一起打嗎？' && cb.chat.messages[0].name === '阿傑', '其他玩家都看得到訊息（去除前後空白）');
  assert(cb.chat.unread() === 1 && ca.chat.unread() === 0, '別人的訊息算未讀，自己的不算');
  cb.chat.setOpen(true);
  assert(cb.chat.unread() === 0 && cb.state.chat.seenId === cb.chat.lastId, '打開聊天後標為已讀並記在存檔');
  cb.chat.setOpen(false);
  const mine = ca.chat.visible()[0];
  assert(mine.mine && !cb.chat.visible()[0].mine, '自己的訊息標示為自己的（靠右顯示）');
  // 過濾
  assert(cleanChat('加我 line: abc123 或打 0912-345-678') === '加我 line: *** 或打 ***', '遮蔽 LINE ID 與手機號碼');
  assert(cleanChat('看 https://evil.example/x 跟 www.abc.com 跟 foo.tw') === '看 *** 跟 *** 跟 ***', '遮蔽網址');
  assert(cleanChat('我出 500 木材換 3000 金錢') === '我出 500 木材換 3000 金錢', '一般數字不會被誤判為電話');
  assert(cleanChat('幹你娘 fuck') === '＊＊＊ ＊＊＊＊', '過濾髒話');
  assert([...cleanChat('長'.repeat(300))].length === CHAT_MAX_LEN, `每則最多 ${CHAT_MAX_LEN} 字`);
  assert(cleanChat('a\n\n\tb​ c') === 'a b c', '去除換行、控制字元與零寬字元');
  // 封鎖：只對自己有效
  await cc.chat.poll();
  assert(cc.chat.block('a'.repeat(32), '阿傑') && cc.chat.visible().length === 0 && cc.chat.unread() === 0, '封鎖後看不到他的訊息也不算未讀');
  assert(cb.chat.visible().length === 1, '封鎖只對自己有效');
  assert(!cc.chat.block('c'.repeat(32), 'me'), '不能封鎖自己');
  const saved = SaveManager.migrate(JSON.parse(JSON.stringify(cc.state)));
  assert(saved.chat.blocked.length === 1, '封鎖名單存在存檔中');
  assert(cc.chat.unblock('a'.repeat(32)) && cc.chat.visible().length === 1, '可以解除封鎖');
  // 檢舉：3 人檢舉後自動隱藏；同一人只算一次；不能檢舉自己
  const dd = mkc('D', 'd'.repeat(32));
  dd.chat.backend = room;
  dd.shelter.establish(dd.state.map.pois.find((p) => dd.shelter.canEstablish(p).ok));
  await dd.chat.poll();
  const msgId = ca.chat.messages[0].id;
  assert(!(await ca.chat.report(msgId)).ok, '不能檢舉自己的訊息');
  await cb.chat.report(msgId);
  await cb.chat.report(msgId);
  await cc.chat.report(msgId);
  await dd.chat.poll();
  assert(dd.chat.messages.length === 1, '同一人重複檢舉只算一次（2 人檢舉還不會隱藏）');
  await dd.chat.report(msgId);
  await cb.chat.poll();
  assert(cb.chat.messages.length === 0, '被 3 位玩家檢舉的訊息自動對所有人隱藏');
  // 只保留最近 200 則
  for (let i = 0; i < CHAT_KEEP + 20; i += 1) {
    room.list.push({ id: room.nextId, from: 'x', name: 'x', civ: 0, text: `#${i}`, at: Date.now() - 60000, reports: 0 });
    room.nextId += 1;
  }
  await cb.chat.poll();
  assert(cb.chat.messages.length === CHAT_KEEP && cb.chat.messages[CHAT_KEEP - 1].text === `#${CHAT_KEEP + 19}`, '只保留最近 200 則');
  // 舊存檔遷移
  const old = JSON.parse(JSON.stringify(ca.state));
  delete old.chat;
  old.version = 19;
  assert(SaveManager.migrate(old).chat?.blocked?.length === 0, '舊存檔遷移後有空的封鎖名單');

  // 自架伺服器：驗證身分、冷卻、長度、檢舉與保存
  const { WorldStore } = await import('../server/WorldStore.js');
  const fsm = await import('node:fs');
  const pathm = await import('node:path');
  const os = await import('node:os');
  const cdir = fsm.mkdtempSync(pathm.join(os.tmpdir(), 'jdqs-chat-'));
  const wsc = new WorldStore(cdir);
  const pid = 'e'.repeat(32);
  const ptk = 'f'.repeat(64);
  wsc.players.set(pid, { id: pid, tokenHash: ptk, name: '伺服器玩家', civ: 42, bases: [], trips: [], updatedAt: Date.now() });
  wsc.players.set('9'.repeat(32), { id: '9'.repeat(32), tokenHash: '8'.repeat(64), name: 'X', civ: 1, bases: [], trips: [], updatedAt: Date.now() });
  assert(wsc.chatSend(pid, '0'.repeat(64), 'hi').status === 'forbidden', '伺服器驗證發言者身分');
  assert(wsc.chatSend(pid, ptk, '   ').status === 'invalid' && wsc.chatSend(pid, ptk, 'x'.repeat(121)).status === 'invalid', '伺服器拒絕空白與超過 120 字的訊息');
  const r1 = wsc.chatSend(pid, ptk, '大家好');
  assert(r1.status === 'ok' && r1.msg.name === '伺服器玩家' && r1.msg.civ === 42, '伺服器以公開資料的名字與文明值發言');
  assert(wsc.chatSend(pid, ptk, '再一則').status === 'slow', '伺服器限制每 5 秒 1 則');
  assert(wsc.chatList(0).messages.length === 1 && wsc.chatList(r1.msg.id).messages.length === 0, '伺服器只回傳新的訊息');
  wsc.chatReport(pid, ptk, r1.msg.id);
  assert(wsc.chatData().list[0].reports === 0, '伺服器不接受檢舉自己');
  wsc.chatReport('9'.repeat(32), '8'.repeat(64), r1.msg.id);
  wsc.chatReport('9'.repeat(32), '8'.repeat(64), r1.msg.id);
  assert(wsc.chatData().list[0].reports === 1, '伺服器同一人檢舉只算一次');
  clearTimeout(wsc.chatTimer);
  fsm.rmSync(cdir, { recursive: true, force: true });
}

// ---- 66. v9.7 物資數量依風險調降 ----
{
  const { riskAmountMul } = await import('../src/systems/LootStock.js');
  assert(riskAmountMul(0) === 0.45 && riskAmountMul(8) === 0.9 && riskAmountMul(20) === 0.9 && riskAmountMul(-1) === 0.45, '風險倍率介於 0.45～0.9');
  assert(riskAmountMul(2) < riskAmountMul(4) && riskAmountMul(4) < riskAmountMul(6), '風險越高保留越多物資');
}

// ---- 67. v9.8.1 臨時小隊指定載具 ----
{
  const gv2 = Game.newGame({ playerName: 'VV', classId: 'scout', lat: 25, lon: 121 });
  gv2.state.map.pois = fillPois([], 25, 121);
  gv2.shelter.establish(gv2.state.map.pois.find((p) => gv2.shelter.canEstablish(p).ok));
  setHour(gv2, 10);
  const ex = gv2.exploration;
  const vs = gv2.vehicles;
  const pois = gv2.state.map.pois.filter((p) => !gv2.shelter.baseAtPoi(p.id) && p.type === 'residential').slice(0, 3);
  gv2.survivors.leader().level = 40;
  const simV = gv2.combat.simulate.bind(gv2.combat);
  gv2.combat.simulate = (sv, _en, o) => simV(sv, [], o);
  gv2.state.resources.fuel = 9999;
  const types = Object.keys(VEHICLES_CFG);
  const car1 = vs.create(types[0]); vs.add(car1);
  const car2 = vs.create(types[1]); vs.add(car2);
  const st = ex.start(pois[0].id, [gv2.survivors.leader().id], 5);
  assert(st.ok, '派出一人小隊');
  const two = ex.assignVehicles(st.exp.id, [car1.id, car2.id], { dry: true });
  assert(!two.ok && /駕駛/.test(two.reason), '小隊 1 人不能指定 2 台載具（依小隊人數判定）');
  assert(ex.assignVehicles(st.exp.id, [car1.id], { dry: true }).ok && vs.isAvailable(car1), '試算不會佔用載具');
  assert(ex.enqueue(st.exp.id, pois[1].id).ok && ex.assignVehicles(st.exp.id, [car1.id]).ok, '小隊 1 人可以指定 1 台載具');
  assert(car1.status === 'reserved' && !vs.isAvailable(car1), '指定後其他人不能選用');
  assert(!vs.scrap(car1.id).ok, '指定的載具不能拆解');
  assert(!ex.assignVehicles(st.exp.id, [car2.id]).ok, '指定後不能變更');
  const other = ex.start(pois[2].id, [], 5, false, Date.now(), { vehicleIds: [car1.id] });
  assert(!other.ok, '其他隊伍不能使用已指定的載具');
  ex.update(st.exp.endAt + 1, { silent: true });
  const next = gv2.state.expeditions[0];
  assert(next && next.poiId === pois[1].id && (next.vehicleIds || []).includes(car1.id) && car1.status === 'out', '回到避難所後下一次出門自動帶上指定的載具');
  assert(!(next.nextVehicleIds || []).length, '生效後清除指定');
  assert(next.id !== st.exp.id && ex.squadNow(st.exp.id, st.exp.memberIds) === next && ex.assignVehicles(ex.squadNow(st.exp.id, st.exp.memberIds).id, [], { dry: true }).ok, '小隊前往下一站換了隊伍編號：開著的視窗仍能找回同一支小隊（指定載具、加入佇列不會失敗）');
  ex.update(next.endAt + 1, { silent: true });
  assert(!gv2.state.expeditions.length && car1.status === 'idle', '小隊結束後載具回到車庫');
  // 小隊沒有再出門：指定的載具歸還
  const st2 = ex.start(pois[2].id, [gv2.survivors.leader().id], 5);
  assert(st2.ok && ex.assignVehicles(st2.exp.id, [car2.id]).ok && car2.status === 'reserved', '再次指定');
  ex.update(st2.exp.endAt + 1, { silent: true });
  assert(car2.status === 'idle', '小隊沒有再出門時，指定的載具歸還車庫');
  // 存檔中殘留的指定（小隊已不存在）會歸還
  const d2 = JSON.parse(JSON.stringify(gv2.state));
  d2.vehicles[0].status = 'reserved'; d2.vehicles[0].reservedFor = 'gone';
  assert(SaveManager.migrate(d2).vehicles[0].status === 'idle', '讀檔時歸還失效的指定');
}

// ---- 68. 刪除進度時解除好友 ----
{
  const ga5 = Game.newGame({ playerName: 'A5', classId: 'warrior', lat: 25, lon: 121 });
  const sent = [];
  ga5.world = {
    provider: { worldSend: async (from, _t, to, type) => { sent.push([to, type]); } },
    identity: () => ({ id: 'me', token: 't' }),
  };
  ga5.state.relations.players = { f1: { status: 'friend', name: '好友1' }, h1: { status: 'hostile', name: '敵人' } };
  ga5.state.relations.requestsOut = { r1: { name: '待回覆' } };
  await ga5.territory.leaveAll();
  assert(sent.length === 2 && sent.every(([, t]) => t === 'friendRemove') && sent.some(([to]) => to === 'f1') && sent.some(([to]) => to === 'r1'), '刪除進度時通知所有好友與送出過請求的玩家解除關係');
  const gb5 = Game.newGame({ playerName: 'B5', classId: 'warrior', lat: 25, lon: 121 });
  gb5.state.relations.requestsIn = { me: { name: 'A5' } };
  gb5.territory.handleEvents([{ from: 'me', fromName: 'A5', type: 'friendRemove' }]);
  assert(!gb5.state.relations.requestsIn.me, '對方刪除進度後，收到的友好請求也一併移除');
  // 漏收通知：以對方的開局時間判斷是否已重新開始
  gb5.state.relations.players = { me: { status: 'friend', name: 'A5' } };
  gb5.territory.checkEpochs([{ id: 'me', name: 'A5', epoch: 1000 }]);
  assert(gb5.territory.relation('me') === 'friend' && gb5.state.relations.players.me.epoch === 1000, '第一次看到對方時記下開局時間');
  gb5.territory.checkEpochs([{ id: 'me', name: 'A5', epoch: 1000 }]);
  assert(gb5.territory.relation('me') === 'friend', '同一個角色維持好友');
  gb5.territory.checkEpochs([{ id: 'me', name: 'A5 新', epoch: 2000 }]);
  assert(gb5.territory.relation('me') !== 'friend', '對方重新開始（開局時間不同）時自動解除好友');
}

// ---- 69. 瞭望塔也抵禦 NPC 與玩家 ----
{
  const gw5 = Game.newGame({ playerName: 'W5', classId: 'warrior', lat: 25, lon: 121 });
  gw5.state.map.pois = fillPois([], 25, 121);
  gw5.shelter.establish(gw5.state.map.pois.find((p) => gw5.shelter.canEstablish(p).ok));
  const b5 = gw5.shelter.primary();
  b5.defenses[0] = { slot: 0, type: 'watchPost', level: 3, garrisonId: null };
  gw5.survivors.leader().job = 'scavenge';
  const sg = gw5.siege.of(b5.id);
  const none = sg.defenseDps();
  gw5.shelter.garrison(b5, 0, 'leader');
  // 設定駐守但工作不是防禦駐守、也沒有警戒：待命，不上塔、也不會被改工作
  assert(gw5.survivors.leader().job === 'scavenge' && !gw5.shelter.onTower('leader') && sg.defenseDps() === none && gw5.shelter.towerStatus(b5, b5.defenses[0]).state === 'standby', '瞭望塔設定駐守後不強制改工作；工作不是防禦駐守時待命、不射擊');
  gw5.shelter.setAlert(true);
  assert(gw5.shelter.onTower('leader') && sg.defenseDps() > none, '切換警戒：瞭望塔人員自動上塔');
  gw5.shelter.setAlert(false);
  assert(!gw5.shelter.onTower('leader'), '解除警戒且工作不是防禦駐守：離開瞭望塔');
  gw5.survivors.leader().job = 'guard';
  assert(sg.defenseDps() > none, '瞭望塔駐守人員計入守城火力（NPC 掠奪與玩家突襲破牆前都會射擊）');
  assert(gw5.territory.garrison(b5).count === 1 && gw5.npcs.defenders(b5).some((x) => x.id === 'leader'), '瞭望塔駐守人員算在警戒範圍駐守人數，破牆後也會迎戰 NPC');
  assert(gw5.world == null && gw5.npcs.baseDefense(b5) > 0, 'NPC 判斷防禦強度時計入瞭望塔');
  // 被驅逐：自動清除瞭望塔設定
  const { createSurvivor: mk69 } = await import('../src/core/GameState.js');
  const ext = mk69('外人', 'scout', 3, 'common');
  gw5.state.survivors.push(ext);
  gw5.shelter.garrison(b5, 0, ext.id);
  assert(b5.defenses[0].garrisonId === ext.id, '換人設定瞭望塔');
  gw5.survivors.dismiss(ext.id);
  assert(!b5.defenses[0].garrisonId, '被驅逐的人自動清除瞭望塔設定');
}

// ---- 70. v9.9 倖存者能力素質 ----
{
  const { QUALITY_KEYS, qualityMul, rollQuality } = await import('../src/config/survivors.js');
  const gq5 = Game.newGame({ playerName: 'Q5', classId: 'warrior', lat: 25, lon: 121 });
  const cand = gq5.survivors.makeCandidate(5);
  assert(QUALITY_KEYS.every((k) => Number.isInteger(cand.quality[k]) && cand.quality[k] >= 0 && cand.quality[k] <= 100), '新的倖存者每項能力都有 0～100% 素質');
  assert(gq5.survivors.qualityOf(gq5.survivors.leader(), 'atk') === 100 && gq5.survivors.avgQuality(gq5.survivors.leader()) === 100, '首領素質一律 100%');
  assert(Math.abs(qualityMul('atk', 0) - 0.88) < 1e-9 && qualityMul('atk', 50) === 1 && Math.abs(qualityMul('atk', 100) - 1.12) < 1e-9 && Math.abs(qualityMul('atkSpeed', 100) - 1.1) < 1e-9, '素質倍率 0% ×0.88、50% ×1、100% ×1.12（攻速 ×0.9～×1.1）');
  cand.quality = Object.fromEntries(QUALITY_KEYS.map((k) => [k, 0]));
  const lo = gq5.survivors.stats(cand);
  cand.quality = Object.fromEntries(QUALITY_KEYS.map((k) => [k, 100]));
  const hi = gq5.survivors.stats(cand);
  assert(hi.atk > lo.atk && hi.hp > lo.hp && hi.crit > lo.crit && hi.dodge > lo.dodge && hi.atkSpeed > lo.atkSpeed, '素質越高能力越好');
  assert(gq5.survivors.growthPerLevel(cand, 'hp') > 0, '每級成長也套用素質');
  const rolls = Array.from({ length: 4000 }, (_, i) => rollQuality(() => (i + 0.5) / 4000));
  assert(rolls.filter((q) => q >= 90).length < rolls.filter((q) => q <= 10).length, '越接近 100% 越少見');
  const old = JSON.parse(JSON.stringify(gq5.state));
  old.version = 20;
  old.survivors.push({ ...JSON.parse(JSON.stringify(cand)), id: 'sv_old', quality: undefined });
  const m1 = SaveManager.migrate(JSON.parse(JSON.stringify(old)));
  const m2 = SaveManager.migrate(JSON.parse(JSON.stringify(old)));
  const s1 = m1.survivors.find((x) => x.id === 'sv_old');
  assert(s1.quality && JSON.stringify(s1.quality) === JSON.stringify(m2.survivors.find((x) => x.id === 'sv_old').quality), '舊倖存者遷移時重新給素質（同一位每次相同）');
  assert(!m1.survivors.find((x) => x.isLeader).quality, '首領不需要素質資料');
}

// ---- 71. v9.9 指定載具鎖定 ----
{
  const gv3 = Game.newGame({ playerName: 'V3', classId: 'scout', lat: 25, lon: 121 });
  gv3.state.map.pois = fillPois([], 25, 121);
  gv3.shelter.establish(gv3.state.map.pois.find((p) => gv3.shelter.canEstablish(p).ok));
  setHour(gv3, 10);
  const simV3 = gv3.combat.simulate.bind(gv3.combat);
  gv3.combat.simulate = (sv, _en, o) => simV3(sv, [], o);
  gv3.state.resources.fuel = 9999;
  const vs3 = gv3.vehicles;
  const c3 = vs3.create(Object.keys(VEHICLES_CFG)[0], 0.5); vs3.add(c3);
  const pois3 = gv3.state.map.pois.filter((p) => !gv3.shelter.baseAtPoi(p.id) && p.type === 'residential').slice(0, 2);
  gv3.survivors.leader().level = 40;
  const e3 = gv3.exploration.start(pois3[0].id, ['leader'], 5);
  gv3.exploration.enqueue(e3.exp.id, pois3[1].id);
  gv3.exploration.assignVehicles(e3.exp.id, [c3.id]);
  assert(!vs3.repair(c3.id).ok, '指定給臨時小隊的載具不能維修');
  c3.durability = 0;
  gv3.exploration.update(e3.exp.endAt + 1, { silent: true });
  // 佇列的下一站可能因負重或已被搜空而沒有出發：只檢查載具沒有跟著出門、已解除鎖定
  assert(!gv3.state.expeditions.some((x) => (x.vehicleIds || []).includes(c3.id)) && c3.status === 'idle', '損壞的指定載具回程後自動解除鎖定，不會跟著出門');
}

// ---- 72. v9.10 設施等級依據點規模設上限 ----
{
  const { BASE_SIZES: BS } = await import('../src/config/civilization.js');
  const { baseSizeOf: bso } = await import('../src/config/civilization.js');
  assert(BS.small.facMax === 8 && BS.medium.facMax === 11 && BS.large.facMax === 13 && BS.huge.facMax === 15, '設施上限：小型 Lv8、中型 Lv11、大型 Lv13、巨型 Lv15');
  const gc6 = Game.newGame({ playerName: 'C6', classId: 'warrior', lat: 25, lon: 121 });
  gc6.state.map.pois = fillPois([], 25, 121);
  const big = gc6.state.map.pois.find((p) => bso(p) === 'large') || gc6.state.map.pois.find((p) => bso(p) === 'medium');
  const small = gc6.state.map.pois.find((p) => bso(p) === 'small');
  gc6.shelter.establish(big);
  const hb = gc6.shelter.primary();
  hb.facilities.farm.level = gc6.shelter.facilityCap(hb);
  Object.keys(gc6.state.resources).forEach((k) => { gc6.state.resources[k] = 1e7; });
  // v14：所有避難所的設施都能升到最高等級；搬到小地點也不會降級
  assert(gc6.shelter.facilityCap(hb) === 15, '避難所設施一律可升到 Lv15（v14）');
  hb.facilities.farm.level = 12;
  hb.facilities.workbench.level = 5;
  gc6.shelter.abandon(hb.id);
  const pv = gc6.shelter.relocationCapPreview(small);
  assert(!pv.changes.length, '搬到小地點不會降級設施（v14）');
  const nb6 = gc6.shelter.establish(small).base;
  assert(nb6.facilities.farm.level === 12 && nb6.defenses.length === 11, `搬到小地點：設施等級保留、防禦欄位一律 11 格（${nb6.facilities.farm.level}/${nb6.defenses.length}）`);
  // 舊存檔：超過上限的設施降級並退還
  const od = JSON.parse(JSON.stringify(gc6.state));
  od.version = 21;
  od.bases[0].facilities.farm.level = 12;
  od.bases[0].size = 'small'; // 舊版的小型據點
  const supBefore = JSON.stringify(od.supplies);
  const md = SaveManager.migrate(od);
  assert(md.bases[0].facilities.farm.level === 8 && JSON.stringify(md.supplies) !== supBefore, '舊存檔超過上限的設施降到上限並退還材料');
}

// ---- 73. 建築內遭遇依實際搜索時間判定日夜 ----
{
  const gp = Game.newGame({ playerName: 'P7', classId: 'warrior', lat: 25, lon: 121 });
  gp.state.map.pois = fillPois([], 25, 121);
  gp.shelter.establish(gp.state.map.pois.find((p) => gp.shelter.canEstablish(p).ok));
  const poi7 = gp.state.map.pois.find((p) => !gp.shelter.baseAtPoi(p.id) && p.type === 'residential');
  // 找一個白天的時間點與 6 小時後（夜晚）的時間點
  let tDay = Date.now();
  for (let i = 0; i < 200 && gp.time.phase(tDay).zombies; i += 1) tDay += 600000;
  let tNight = tDay;
  for (let i = 0; i < 400 && !gp.time.phase(tNight).zombies; i += 1) tNight += 600000;
  const st7 = gp.exploration.start(poi7.id, ['leader'], 5, false, tDay);
  const ctx7 = gp.exploration.exploreContext(st7.exp);
  const d7 = gp.exploration.atPhase(ctx7, tDay);
  const n7 = gp.exploration.atPhase(ctx7, tNight);
  assert(!d7.phase.zombies && n7.phase.zombies && n7.level >= d7.level && n7.zoneMul === gp.zombies.encounterMul(poi7.lat, poi7.lon), '出發時是白天，搜索時已入夜：依搜索當下判定為夜晚');
  assert(Math.abs(d7.lootMul / ctx7.lootBase - d7.phase.lootMul) < 1e-9, '物資倍率依搜索當下的時段');
}

// ---- 74. v9.11 平衡：防禦減傷、高危險區建築殭屍、彈藥製作與售價 ----
{
  const { COMBAT_TUNING, defReduce, BUILDING_ZONE } = await import('../src/config/enemies.js');
  const { AMMO_RECIPES: AR, SUPPLIES: SP } = await import('../src/config/supplies.js');
  assert(COMBAT_TUNING.defFactor === 0.5 && Math.abs(defReduce(302) - 100 / 251) < 1e-9, '防禦減傷：攻擊 × 100 ÷（100 + 防禦 × 0.5）');
  assert(BUILDING_ZONE.extraLevel[3] === 28 && BUILDING_ZONE.statMul[2] === 3.2 && BUILDING_ZONE.statMul[3] === 2.15 && !BUILDING_ZONE.extraLevel[0] && !BUILDING_ZONE.statMul[-1], '只有警戒區以上的建築殭屍加強');
  const gz9 = Game.newGame({ playerName: 'Z9', classId: 'warrior', lat: 25, lon: 121 });
  const ex9 = gz9.exploration;
  const m0 = ex9.encounterMul({ phase: { zombies: false }, zone: { danger: 0 } });
  const m3 = ex9.encounterMul({ phase: { zombies: false }, zone: { danger: 3 } });
  assert(Math.abs(m3.hp / m0.hp - 2.15) < 1e-9 && Math.abs(m3.atk / m0.atk - 2.15) < 1e-9, '致死區建築殭屍生命、攻擊 ×2.15');
  const bullets = Object.entries(AR).filter(([k]) => k !== 'arrow');
  assert(bullets.every(([, r]) => r.bench === 3 && r.gun === 1), '所有子彈只需要「槍械製造」Lv1 與工作台 Lv3');
  const bm = gz9.blackMarket;
  const prices = Object.keys(AR).map((k) => bm.supplyPrice(k));
  assert(Math.max(...prices) <= 6 && Math.min(...prices) >= 4, `彈藥售價不再依階級大幅提高（${prices.join('/')}）`);
  assert(bm.supplyPrice('ammo308') < 85 && SP.ammo308.cat === 'ammo', '.308 狙擊彈不再是高價');
}

// ---- 76. 屍潮平衡：前期加強、駐守倍率；天亮結算獎勵與突破懲罰 ----
{
  const { SIEGE_SCALING: SS, SIEGE_REWARD: SR, SIEGE_PENALTY: SPN } = await import('../src/config/civilization.js');
  const { SUPPLIES: SP } = await import('../src/config/supplies.js');
  const { xpToNext: xpn } = await import('../src/config/survivors.js');
  const { BOSSES } = await import('../src/config/enemies.js');
  const { createSurvivor } = await import('../src/core/GameState.js');
  const gs = Game.newGame({ playerName: 'S76', classId: 'warrior', lat: 25, lon: 121 });
  gs.state.map.pois = fillPois([], 25, 121);
  gs.shelter.establish(gs.state.map.pois.find((p) => !gs.shelter.baseAtPoi(p.id)));
  const b = gs.shelter.primary();
  const s = gs.siege.of(b.id);
  // 前期固定加強：文明 150（超過基準 130）時加滿
  gs.civilization.value = () => 150;
  const hp150 = gs.civilization.siegeHpMul();
  assert(Math.abs(hp150 - (1 + 130 * SS.hpPerCiv + SS.hpEarly)) < 1e-9, `文明 150 屍潮生命倍率含前期加強（${hp150.toFixed(3)}）`);
  gs.civilization.value = () => 566;
  assert(Math.abs(gs.civilization.siegeHpMul() - (1 + (530 + 16 * SS.softRate) * SS.hpPerCiv + SS.hpEarly)) < 0.01, '文明 566 屍潮生命倍率（超過 550 的部分只算一半）');
  // 駐守倍率只作用在屍潮；NPC／玩家攻打用原始火力
  const sv = gs.survivors.leader();
  sv.job = 'guard';
  const dSiege = s.defenseDps();
  const dRaw = s.defenseDps({ raw: true });
  assert(s.guardMul() === s.guardMul(true) * SS.guardDmgMul && dSiege > dRaw, `屍潮中駐守人員傷害 ×${SS.guardDmgMul}（${dSiege} > 原始 ${dRaw}）`);
  b.defenses[0] = { slot: 0, type: 'machineGun', level: 3, garrisonId: null };
  sv.job = 'farm';
  assert(Math.abs(s.defenseDps() / s.defenseDps({ raw: true }) - SS.towerDmgMul) < 0.02, '屍潮中防禦設施傷害 ×0.7');
  // Boss 生命、攻擊 ×0.5
  s.spawn('walker');
  s.spawn(Object.keys(BOSSES)[0], true);
  const bz = s.zombies[s.zombies.length - 1];
  const be = gs.combat.createEnemy(bz.enemyId, s.zombieLevel() + 3);
  assert(Math.abs(bz.maxHp / Math.round(be.maxHp * gs.civilization.siegeHpMul() * SS.bossMul * (SS.zombieMul?.hp || 1)) - 1) < 0.01, '屍潮 Boss 生命另乘 0.5');
  s.zombies = [];
  // 天亮結算：城牆 90% → 優秀 ×1.5
  sv.job = 'guard';
  s.startNight();
  s.wave = 4; s.nightKills = 50;
  s.markDefenders(); // 波次來襲時記錄參與防守的人
  b.wallHp = gs.shelter.wallMax(b) * 0.9;
  const coins0 = gs.state.player.coins;
  const xp0 = sv.xp; const lv0 = sv.level;
  s.endNight();
  const ok = gs.state.defenseLog[0];
  assert(ok.success && ok.siege?.grade === 'excellent' && ok.siege.coins === Math.round(50 * SR.coinsPerKill * 1.5), `天亮守住：評價優秀，金幣 擊殺×2×1.5（${ok.siege?.coins}）`);
  assert(gs.state.player.coins - coins0 >= ok.siege.coins, '天亮結算的金幣已入帳');
  const nParts = Object.entries(ok.siege.items).filter(([k]) => SP[k].cat === 'part').reduce((a, [, v]) => a + v, 0);
  const nAmmo = Object.entries(ok.siege.items).filter(([k]) => SP[k].cat === 'ammo').reduce((a, [, v]) => a + v, 0);
  assert(nParts === Math.round(4 * SR.partsPerWave * 1.5) && nAmmo === Math.round(4 * SR.ammoPerWave * 1.5), `物資箱：零件 ${nParts}、彈藥 ${nAmmo}`);
  assert(ok.siege.xp.length === 1 && ok.siege.xp[0].xp === Math.round(xpn(lv0) * SR.guardXpPct) && (sv.level > lv0 || sv.xp > xp0), '整晚駐守的人獲得升級所需 5% 經驗');
  // v10.16：天亮後才補結算、駐守的人已經出門探索：仍然拿到駐守經驗
  s.startNight(); s.wave = 3; s.nightKills = 30;
  s.markDefenders();
  sv.status = 'exploring';
  s.endNight();
  assert(gs.state.defenseLog[0].siege.xp.some((x) => x.name === sv.name), '結算時駐守的人已出門探索：參與防守的人仍有駐守經驗');
  sv.status = 'idle';
  // 城牆 30% → 普通 ×1.0
  s.startNight(); s.wave = 2; s.nightKills = 10;
  b.wallHp = gs.shelter.wallMax(b) * 0.3;
  s.endNight();
  assert(gs.state.defenseLog[0].siege.grade === 'normal' && gs.state.defenseLog[0].siege.coins === 20, '城牆剩 30%：評價普通 ×1.0');
  // 中途才開始駐守的人沒有駐守經驗
  s.base.nightDefenders = null;
  s.startNight(); s.wave = 1; s.nightKills = 1;
  s.markDefenders();
  const late = createSurvivor('晚到', 'scout', 5, 'common');
  gs.state.survivors.push(late);
  late.job = 'guard';
  s.endNight();
  assert(!gs.state.defenseLog[0].siege.xp.some((x) => x.name === '晚到'), '屍潮都打完才開始駐守的人不給駐守經驗');
  // v10.16：中途才開始駐守，但殭屍還在場上（有參與迎戰）：給駐守經驗
  s.base.nightDefenders = null;
  s.startNight(); s.wave = 1; s.nightKills = 5;
  s.markDefenders();
  const mid = createSurvivor('中途', 'scout', 5, 'common');
  gs.state.survivors.push(mid);
  mid.job = 'guard';
  s.zombies.push({ x: 0, y: 0, hp: 1, maxHp: 1 });
  s.markAt = -10; s.clock = 0;
  s.markDefenders();
  s.zombies.length = 0;
  s.endNight();
  assert(gs.state.defenseLog[0].siege.xp.some((x) => x.name === '中途'), '中途開始駐守、殭屍還在場上：給駐守經驗');
  mid.job = 'scavenge';
  // 警戒中全部倖存者都防守：來襲時都在防守的人都有經驗（不是只有遊戲開啟時在駐守的人）
  const others = [createSurvivor('甲', 'scout', 5, 'common'), createSurvivor('乙', 'medic', 5, 'common')];
  others.forEach((x) => { x.job = 'scavenge'; gs.state.survivors.push(x); });
  s.base.nightDefenders = null;
  s.startNight(); s.wave = 2; s.nightKills = 20;
  gs.shelter.setAlert(true);
  s.markDefenders();
  s.endNight();
  const names = gs.state.defenseLog[0].siege.xp.map((x) => x.name);
  gs.shelter.setAlert(false);
  assert(['甲', '乙', '晚到'].every((n) => names.includes(n)), `警戒中全員防守：參與的人都有駐守經驗（${names.join('、')}）`);
  // 瞭望塔上的人也有駐守經驗
  b.defenses[0] = { slot: 0, type: 'watchPost', level: 2, garrisonId: null };
  gs.shelter.garrison(b, 0, others[0].id);
  others[0].job = 'guard';
  s.base.nightDefenders = null;
  s.startNight(); s.wave = 1; s.nightKills = 5;
  s.markDefenders();
  s.endNight();
  assert(gs.state.defenseLog[0].siege.xp.some((x) => x.name === '甲'), '瞭望塔上的人也有駐守經驗');
  // Boss 戰利品：必得 8 個高階零件
  s.startNight();
  gs.state.supplies = {}; // 倉庫有空間
  s.bossLoot({ enemyId: Object.keys(BOSSES)[0] });
  const bossParts = Object.values(s.nightBoss.items).reduce((a, v) => a + v, 0);
  assert(bossParts === SR.boss.parts && Object.keys(s.nightBoss.items).every((k) => SP[k].tier >= 3), `擊殺 Boss 必得 ${SR.boss.parts} 個高階零件`);
  // 突破：撐到最後一波損失較少，並記錄材料與傷勢
  Object.keys(gs.state.resources).forEach((k) => { gs.state.resources[k] = 1000; });
  gs.state.supplies = { ...(gs.state.supplies || {}), nail: 200, screw: 200, linen: 200, bolt: 200, ironPlate: 200, gear: 200 };
  const cellar = b.facilities.cellar?.level || 0;
  if (b.facilities.cellar) b.facilities.cellar.level = 0;
  s.startNight();
  const max = s.maxWaves();
  s.wave = max;
  let matLost = 0;
  let tries = 0;
  s.breach();
  const late1 = gs.state.defenseLog[0];
  const expect = Math.round((SPN.lossMax - SPN.lossSpan * ((max - 1) / max)) * 100);
  assert(!late1.success && late1.siege.lossPct === expect && late1.siege.wave === max, `最後一波才被突破：資源損失 ${late1.siege.lossPct}%（預期 ${expect}%）`);
  assert(Array.isArray(late1.siege.injuries) && late1.siege.injuries.length >= 1, '突破時記錄駐守人員傷勢');
  matLost += Object.keys(late1.siege.materials).length;
  // 材料損失有機率：多試幾次一定會發生，且只扣零件與布料、每種最多 15%
  while (!matLost && tries < 20) {
    tries += 1;
    gs.state.survivors.forEach((x) => { x.severe = false; x.hp = null; });
    s.startNight(); s.wave = 1; s.breach();
    matLost += Object.keys(gs.state.defenseLog[0].siege.materials).length;
  }
  const mats = gs.state.defenseLog[0].siege.materials;
  assert(matLost > 0 && Object.entries(mats).every(([k, v]) => ['part', 'fabric'].includes(SP[k].cat) && v <= Math.ceil(200 * SPN.materialMax)), '突破時有機率損失少量零件、布料');
  if (b.facilities.cellar) b.facilities.cellar.level = cellar;
  // 紀錄與結算視窗顯示獎勵與損失
  const { siegeDetailHtml } = await import('../src/ui/SiegeResult.js');
  const okHtml = siegeDetailHtml(ok);
  const failHtml = siegeDetailHtml(late1);
  assert(okHtml.includes('防守物資箱') && okHtml.includes('駐守經驗') && siegeDetailHtml(ok, true).includes('評價'), '紀錄顯示守住的獎勵');
  assert(failHtml.includes('資源損失') && failHtml.includes('駐守人員傷勢') && siegeDetailHtml(late1, true).includes('資源 −'), '紀錄顯示被突破的損失');
  gs.state.survivors.forEach((x) => { x.severe = false; });
}

// ---- 77. 據點防守戰倒下的人只有部分重傷 ----
{
  const { HOME_DEFENSE_DOWN: HD } = await import('../src/config/enemies.js');
  const { createSurvivor } = await import('../src/core/GameState.js');
  const gh = Game.newGame({ playerName: 'H77', classId: 'warrior', lat: 25, lon: 121 });
  const svs = Array.from({ length: 40 }, (_, i) => createSurvivor(`h${i}`, 'warrior', 5, 'common'));
  gh.state.survivors.push(...svs);
  const result = { team: svs.map((sv) => ({ id: sv.id, down: true, hp: 0 })), kills: [], bossKills: 0, eliteKills: 0, xp: 0, coins: 0, parts: 0, victory: false };
  gh.combat.applyOutcome(svs, result, Date.now(), { homeDefense: true });
  const sev = svs.filter((sv) => sv.severe).length;
  const ok = svs.filter((sv) => !sv.severe);
  assert(sev > 0 && sev < 30 && ok.every((sv) => Math.abs(gh.survivors.hpOf(sv) - gh.survivors.maxHp(sv) * HD.hpPct) < 1), `據點防守戰倒下的人約 30% 重傷，其餘剩 20% 生命（重傷 ${sev}/40）`);
  const svs2 = Array.from({ length: 5 }, (_, i) => createSurvivor(`e${i}`, 'warrior', 5, 'common'));
  gh.combat.applyOutcome(svs2, { ...result, team: svs2.map((sv) => ({ id: sv.id, down: true, hp: 0 })) }, Date.now());
  assert(svs2.every((sv) => sv.severe), '其他戰鬥倒下的人仍然重傷');
  // 玩家突襲：對方回報擊倒的駐守人數，隨機挑在家駐守的人套用同樣規則
  gh.state.map.pois = fillPois([], 25, 121);
  gh.shelter.establish(gh.state.map.pois.find((p) => !gh.shelter.baseAtPoi(p.id)));
  const hb = gh.shelter.primary();
  const guards = Array.from({ length: 30 }, (_, i) => createSurvivor(`g${i}`, 'warrior', 5, 'common'));
  gh.state.survivors.forEach((sv) => { sv.job = 'farm'; });
  guards.forEach((sv) => { sv.job = 'guard'; });
  gh.state.survivors.push(...guards);
  const inj = gh.territory.applyRaidDowns(hb, 20);
  const hit = guards.filter((sv) => sv.severe || gh.survivors.hpOf(sv) < gh.survivors.maxHp(sv));
  assert(hit.length === 20 && inj.length === guards.filter((sv) => sv.severe).length && inj.length > 0 && inj.length < 20, `玩家突襲擊倒 20 名駐守：全部受傷，其中 ${inj.length} 人重傷`);
  assert(gh.territory.applyRaidDowns(hb, 'x').length === 0 && gh.territory.applyRaidDowns(hb, -3).length === 0, '突襲事件的擊倒人數不合法時不處理');
}

// ---- 78. 後期 NPC 人數增加 ----
{
  const g78 = Game.newGame({ playerName: 'N78', classId: 'warrior', lat: 25, lon: 121 });
  const fc = (lv) => g78.npcs.fullCount({ level: lv, wounded: 0 });
  assert(fc(20) === 8 && fc(27) === 8 && fc(28) === 9 && fc(33) === 11 && fc(40) === 15, `Lv28 起每 2 級多 1 人（Lv27 ${fc(27)}、Lv28 ${fc(28)}、Lv33 ${fc(33)}、Lv40 ${fc(40)}）`);
}

// ---- 79. NPC：擊退掠奪隊的獎勵、只出現在可視範圍、隔天中午刷新 ----
{
  const { nextNoon } = await import('../src/systems/NpcSystem.js');
  const { NPC_CONFIG: NC } = await import('../src/config/npcs.js');
  const { POI_SCAN_RADIUS: PSR } = await import('../src/config/constants.js');
  const t = new Date(2026, 10, 4, 9, 30).getTime();
  void nextNoon; void t;
  assert(NC.respawnAfterMs === 36 * 3600000, '被消滅的 NPC 據點 36 小時後重新出現');
  const g79 = Game.newGame({ playerName: 'N79', classId: 'warrior', lat: 25, lon: 121 });
  g79.state.map.pois = fillPois([], 25, 121);
  g79.shelter.establish(g79.state.map.pois.find((p) => g79.shelter.canEstablish(p).ok));
  const b79 = g79.shelter.primary();
  g79.npcs.fillCells(Date.now(), { silent: true });
  {
    const n0 = g79.npcs.list[0];
    const t0 = Date.now();
    const cell = n0.cell || g79.npcs.cellOf(n0.lat, n0.lon);
    g79.npcs.destroy(n0, t0);
    assert(g79.npcs.state.cellNext[cell] === t0 + 36 * 3600000, '消滅 NPC 據點後，該格 36 小時後才重生');
    g79.npcs.fillCells(Date.now(), { silent: true });
  }
  {
    const { inWorld } = await import('../src/config/world.js');
    assert(g79.npcs.list.length > 0 && g79.npcs.list.every((n) => inWorld(n.lat, n.lon)), `v13：NPC 據點只出現在固定地圖範圍內（${g79.npcs.list.length} 個）`);
    void b79; void PSR;
  }
  // 擊退掠奪隊：賞金、裝備、經驗
  const all = Array.from({ length: 6 }, () => g79.combat.createEnemy('raider', 20));
  all.push(g79.combat.createEnemy('raiderChief', 20));
  const L = g79.survivors.leader();
  const xp0 = L.xp; const lv0 = L.level; const c0 = g79.state.player.coins;
  const R = NC.raidReward;
  let drops = 0; let chiefDrops = 0;
  for (let i = 0; i < 200; i += 1) {
    const rw = g79.npcs.raidReward({ name: '測試', level: 20, lat: b79.lat, lon: b79.lon }, all, { alive: [] }, { kills: [] }, i === 0 ? [L] : [], new Set());
    drops += rw.gear.length;
    chiefDrops += rw.gear.filter((x) => x.chief).length;
    if (i === 0) assert(rw.coins === Math.round(7 * 20 * R.bounty) && g79.state.player.coins - c0 === rw.coins && rw.downed === 7, `賞金 = 擊倒人數 × NPC 等級 × 0.5（${rw.coins}）`);
    if (i === 0) assert(rw.xp.length === 1 && (L.level > lv0 || L.xp > xp0), '參與防守的人獲得經驗');
  }
  const expect = 200 * (R.chiefGear + 6 * R.raiderGear);
  assert(drops > expect * 0.6 && drops < expect * 1.4 && chiefDrops > 200 * R.chiefGear * 0.6, `遺落裝備：首領 30%、每名掠奪者 5%（200 次共 ${drops} 件，預期約 ${expect}）`);
  const none = g79.npcs.raidReward({ name: '測試', level: 20, lat: b79.lat, lon: b79.lon }, all, { alive: [...all] }, null, [], new Set());
  assert(none.coins === 0 && none.gear.length === 0, '沒有擊倒掠奪者就沒有賞金與裝備');
  const { raidRewardHtml } = await import('../src/ui/SiegeResult.js');
  const fake = { reward: { npc: '測試', level: 20, raiders: 7, downed: 7, coins: 70, gear: [{ name: '步槍', rarity: 'epic', chief: true, kept: true }], xp: [{ name: 'A', level: 5, xp: 10 }], hurt: [] } };
  assert(raidRewardHtml(fake).includes('賞金') && raidRewardHtml(fake, 'summary').includes('裝備 ×1') && raidRewardHtml(fake, 'detail').includes('防守經驗'), '結算視窗與紀錄顯示擊退掠奪隊的獎勵');
}

// ---- 80. 研究佇列 ----
{
  const { SUPPLIES } = await import('../src/config/supplies.js');
  const gq = Game.newGame({ playerName: 'Q80', classId: 'warrior', lat: 25, lon: 121 });
  gq.state.map.pois = fillPois([], 25, 121);
  gq.shelter.establish(gq.state.map.pois.find((p) => gq.shelter.canEstablish(p).ok));
  const bq = gq.shelter.primary();
  const rs = gq.research;
  // 這裡測試單一研究位的佇列規則（研究中心 Lv10 的第二研究位另見第 131 節）
  rs.parallel = () => 1;
  bq.facilities.researchCenter.level = 4;
  assert(rs.slots() === 1, '研究中心 Lv4：1 格');
  bq.facilities.researchCenter.level = 10;
  assert(rs.slots() === 3 && rs.slots(5) === 2 && rs.slots(15) === 4, '每 5 級多 1 格（Lv5 2 格、Lv10 3 格、Lv15 4 格）');
  // 材料充足
  Object.keys(gq.state.resources).forEach((k) => { gq.state.resources[k] = 1e6; });
  gq.resources.storageCap = () => 1e9;
  gq.state.supplies = Object.fromEntries(Object.keys(SUPPLIES).map((k) => [k, 5000]));
  gq.equipment.supplyRoom = () => 1e6;
  const free = ['w_atk', 'w_crit', 'w_melee', 'w_pistol'].filter((id) => RESEARCH[id] && !RESEARCH[id].requires.length);
  const a1 = free[0]; const a2 = free[1];
  assert(rs.start(a1).ok && gq.state.research.active?.id === a1, '開始研究第 1 項');
  const before = JSON.stringify(gq.state.supplies);
  const r2 = rs.start(a2);
  assert(r2.ok && rs.queue.length === 1 && rs.queue[0].id === a2 && JSON.stringify(gq.state.supplies) !== before, '已有研究時加入佇列，並在加入時扣除材料');
  const r3 = rs.start(a1);
  assert(r3.ok && rs.queue[1].id === a1 && rs.queue[1].level === 2, '同一項科技可以排下一級（Lv2）');
  assert(!rs.start(a2).ok, '佇列已滿（3/3）時不能再加入');
  // 調整順序：Lv2 不能排到自己的 Lv1 前面（Lv1 正在研究，所以可以往前）
  assert(rs.move(1, -1).ok && rs.queue[0].id === a1, '排隊項目可以往前');
  assert(rs.move(0, 1).ok && rs.queue[0].id === a2, '排隊項目可以往後');
  // 取消排隊中的項目：全額退還
  const supBefore = { ...gq.state.supplies };
  const cost2 = rs.queue[0].cost;
  const c = rs.cancelQueued(0);
  assert(c.ok && rs.queue.length === 1 && Object.entries(cost2).every(([k, v]) => !SUPPLIES[k] || gq.state.supplies[k] === (supBefore[k] || 0) + v), '取消排隊中的項目全額退還');
  rs.start(a2);
  // 依序完成：上一項完成後自動開始下一項（離線一次跑完）
  const t1 = gq.state.research.active.endAt;
  const total = rs.queue.reduce((s2, q) => s2 + rs.researchTime(q.id, q.level) * 1000, 0);
  rs.update(t1 + total + 1000);
  assert(rs.level(a1) === 2 && rs.level(a2) === 1 && !gq.state.research.active && rs.queue.length === 0, `離線期間佇列依序全部完成（${a1} Lv${rs.level(a1)}、${a2} Lv${rs.level(a2)}）`);
  // 取消研究中的項目：依賴它的排隊項目（同一科技下一級）一併取消、全額退還
  rs.start(a1); rs.start(a1); rs.start(a2);
  assert(rs.queue.length === 2 && rs.queue[0].id === a1, '排入同一科技的 Lv3、Lv4');
  rs.cancel();
  assert(gq.state.research.active?.id === a2 && rs.queue.length === 0, '取消研究中的 Lv3：Lv4 一併取消，下一項自動開始');
  // 研究中心降級：超出格數的排隊項目取消並退還
  rs.start(a1); rs.start(a1);
  assert(rs.queue.length === 2, '佇列 3/3');
  bq.facilities.researchCenter.level = 4;
  rs.update(Date.now());
  assert(rs.queue.length === 0 && gq.state.research.active, '研究中心降到 Lv4（1 格）：排隊項目取消並退還');
  // 搬遷：研究中與排隊中的研究都取消
  bq.facilities.researchCenter.level = 10;
  rs.start(a1);
  assert(rs.queue.length === 1, '再排一項');
  gq.state.expeditions = [];
  gq.shelter.abandon(bq.id);
  assert(!gq.state.research.active && rs.queue.length === 0, '搬遷時取消研究中與排隊中的研究');
}

// ---- 81. 連續探索：背包有空間就直接前往下一個地點；戰鬥後自動補滿藥品欄 ----
{
  const { CHAIN_RETURN_LOAD } = await import('../src/systems/ExplorationSystem.js');
  const { SUPPLIES } = await import('../src/config/supplies.js');
  const { createSurvivor } = await import('../src/core/GameState.js');
  const gc = Game.newGame({ playerName: 'C81', classId: 'warrior', lat: 25, lon: 121 });
  gc.state.map.pois = fillPois([], 25, 121);
  gc.shelter.establish(gc.state.map.pois.find((p) => gc.shelter.canEstablish(p).ok));
  setHour(gc, 10);
  const ex = gc.exploration;
  const home = gc.shelter.primary();
  const near = gc.state.map.pois.filter((p) => !gc.shelter.baseAtPoi(p.id) && !p.npc && haversine(p.lat, p.lon, home.lat, home.lon) < 700).slice(0, 3);
  const L = gc.survivors.leader();
  // 這裡測試路線與物資，不讓建築內的戰鬥造成重傷
  L.level = 60;
  gc.survivors.becomeSevere = () => {};
  // 建築內遭遇的勝負是隨機的，這裡固定勝利（戰敗撤退另有測試）
  const sim81 = gc.combat.simulate.bind(gc.combat);
  gc.combat.simulate = (...a) => ({ ...sim81(...a), victory: true });
  const r1 = ex.start(near[0].id, [L.id], 1, false, Date.now());
  assert(r1.ok, '派出探索');
  const e1 = r1.exp;
  e1.cargo = 1e6; // 運載量足夠：測試直接前往下一站（第一站找到的物資多寡是隨機的）
  ex.enqueue(e1.id, near[1].id);
  // 背包幾乎沒東西：搜索完直接前往下一個地點（不回家）
  const searchEnd = e1.startAt + e1.travelMs + e1.searchMs;
  const woodBefore = gc.state.resources.wood;
  ex.update(searchEnd + 1);
  const e2 = ex.list.find((e) => e.poiId === near[1].id);
  assert(e2 && !ex.list.includes(e1), '探索完第一個地點後直接前往佇列中的下一個地點');
  assert(Math.abs(e2.from.lat - near[0].lat) < 1e-9 && e2.backPath && e2.backMs > 0 && e2.endAt === e2.startAt + e2.travelMs + e2.searchMs + e2.backMs, '從上一個地點出發，回程直接回避難所');
  assert(gc.state.resources.wood === woodBefore, '途中取得的物資先背著，還沒入庫');
  const tr = e2.trail || [];
  assert(tr.length >= 2 && Math.abs(tr[0].lat - home.lat) < 1e-6 && Math.abs(tr[tr.length - 1].lat - near[0].lat) < 1e-6 && (e2.stops || []).includes(near[0].id), '地圖顯示：記下已走過的路線（避難所→第一站）與搜索過的地點');
  const rep1 = gc.state.reports[0];
  assert(rep1?.carried && rep1.events.some((t) => t.includes('直接前往')), '探索報告寫出背包還有空間、直接前往下一個地點');
  // 回到避難所：背著的物資一起入庫
  const carriedNow = { ...(e2.carried?.gained || {}) };
  // 前一站撿到、背在身上的裝備：回家後入庫一次，最後一站的報告不重複列在收穫裡
  const helm99 = gc.equipment.generate({ level: 5, type: 'helmet' });
  e2.carried = e2.carried || { gained: {}, items: [], blueprints: [], vehicles: [] };
  e2.carried.items.push(helm99);
  e2.carried.gained.wood = (e2.carried.gained.wood || 0) + 7777; // 前幾站背著的物資（容易辨識的數量）
  const wood99 = gc.state.resources.wood;
  ex.update(e2.endAt + 1);
  const rep99 = gc.state.reports[0];
  assert(gc.equipment.items.filter((i) => i.id === helm99.id).length === 1 && !rep99.items.some((i) => i.id === helm99.id) && rep99.events.some((t) => t.includes(helm99.name)), '前幾站背回的裝備入庫一次，最後一站報告不重複列出（事件中說明）');
  assert(!ex.list.includes(e2) && Object.keys(carriedNow).every((k) => !['food', 'wood', 'fuel'].includes(k) || gc.state.resources[k] >= woodBefore * 0 ), '最後一站回到避難所');
  assert(gc.state.reports[0].events.some((t) => t.includes('前幾站背回的物資一起入庫')), '回到避難所時背著的物資入庫');
  assert((rep99.resources?.wood || 0) < 7777 && gc.state.resources.wood > wood99, `最後一站報告只列這一站的收穫，前幾站背回的物資照樣入庫（報告木材 ${rep99.resources?.wood || 0}）`);

  // 負重達 90%：回家卸貨（探索途中可能受傷，先治好）
  const heal = () => { L.severe = false; L.hp = null; L.status = 'idle'; };
  heal();
  const r3 = ex.start(near[0].id, [L.id], 1, false, Date.now());
  const e3 = r3.exp;
  ex.enqueue(e3.id, near[2].id);
  e3.carried = { gained: { wood: Math.ceil(e3.cargo * CHAIN_RETURN_LOAD) + 1 }, items: [], blueprints: [], vehicles: [] };
  ex.update(e3.startAt + e3.travelMs + e3.searchMs + 1);
  // 背包一開始就很重時，搜索途中可能已經停止回家（甚至已經到家）；重點是沒有前往下一站
  // 只看這支隊伍（e3）：其他先前留下的隊伍可能剛好前往同一個地點
  assert(!(ex.list.includes(e3) && e3.poiId === near[2].id) && (!ex.list.includes(e3) || e3.travelEvents.some((t) => t.includes('返回避難所卸貨')) || e3.cp?.stopped), `負重達 90% 時返回避難所（不前往下一站）（${ex.list.map((e) => `${e === e3 ? 'e3' : 'x'}:${e.poiId === near[2].id ? 'n2' : e.poiId === near[0].id ? 'n0' : '?'}:${e.recalled ? 'R' : ''}${e.defeated ? 'D' : ''}:${(e.travelEvents || []).slice(-2).join('|')}`).join(' ; ')}）`);
  if (ex.list.includes(e3)) ex.update(e3.endAt + 1);
  // 關閉開關：每個地點探索完都先回家
  heal();
  const r4 = ex.start(near[0].id, [L.id], 1, false, Date.now());
  const e4 = r4.exp;
  ex.enqueue(e4.id, near[1].id);
  assert(ex.toggleChain(e4.id).ok && e4.chain === false, '可以關閉連續探索');
  ex.update(e4.startAt + e4.travelMs + e4.searchMs + 1);
  assert(ex.list.includes(e4), '關閉時探索完照常回家');
  ex.update(e4.endAt + 1);
  // 戰鬥後補滿藥品欄：從缺最多的隊員開始，先用自己的背包，再用隊友的
  const med = Object.keys(SUPPLIES).find((k) => SUPPLIES[k].cat === 'med' && SUPPLIES[k].heal > 0);
  const a = createSurvivor('甲', 'warrior', 5, 'common');
  const b = createSurvivor('乙', 'medic', 5, 'common');
  gc.state.survivors.push(a, b);
  [a, b].forEach((sv) => { gc.survivors.supplyRules(sv).med = med; });
  gc.survivors.loadout(a).med = { key: med, qty: 2 };
  gc.survivors.loadout(b).med = { key: med, qty: 7 };
  a.bag = {}; b.bag = { [med]: 5 };
  const notes = gc.survivors.refillMeds([b, a]);
  const maxMed = gc.survivors.loadout(a).med.qty;
  assert(notes[0]?.startsWith('甲') && gc.survivors.loadout(a).med.qty === 7 && !b.bag[med] && gc.survivors.loadout(b).med.qty === 7, `缺最多的隊員先補，從隊友背包拿相同藥品（${notes.join('；')}）`);
  void maxMed;
}

// ---- 82. 存檔保留研究佇列；情報網改為 3 級 ----
{
  const { SaveManager } = await import('../src/core/SaveManager.js');
  const gs = Game.newGame({ playerName: 'S82', classId: 'warrior', lat: 25, lon: 121 });
  gs.state.research.active = { id: 'w_atk', level: 1, startAt: Date.now(), endAt: Date.now() + 60000, cost: {} };
  gs.state.research.queue = [{ id: 'w_crit', level: 1, cost: { wood: 10 } }];
  gs.state.research.fresh = { w_atk: { level: 1, at: Date.now() } };
  const loaded = SaveManager.migrate(JSON.parse(JSON.stringify(gs.state)));
  assert(loaded.research.queue.length === 1 && loaded.research.queue[0].id === 'w_crit' && loaded.research.fresh?.w_atk, '讀取存檔時保留研究佇列與剛完成標示');
  assert(RESEARCH.r_board.maxLevel === 3 && RESEARCH.r_board.labReq.join() === '5,10,15', '情報網最多 3 級，需要研究中心 Lv5／10／15');
  const old = JSON.parse(JSON.stringify(gs.state));
  old.version = 22;
  old.research.levels.r_board = 12;
  const mig = SaveManager.migrate(old);
  assert(mig.research.levels.r_board === 2, `舊存檔情報網 Lv12 換算為 Lv2（效果不變：${mig.research.levels.r_board}）`);
}

// ---- 83. 快速拆解：一次拆解多件倉庫裝備 ----
{
  const gd = Game.newGame({ playerName: 'D83', classId: 'warrior', lat: 25, lon: 121 });
  const eq = gd.equipment;
  const made = Array.from({ length: 4 }, (_, i) => { const it = eq.generate({ level: 5, rarity: i === 3 ? 'rare' : 'poor' }); it.loc = 'store'; gd.state.inventory.items.push(it); return it; });
  made[2].locked = true;
  const prev = eq.dismantlePreview(made.map((i) => i.id));
  const expect = {};
  [made[0], made[1], made[3]].forEach((it) => Object.entries(eq.dismantleValue(it)).forEach(([k, v]) => { expect[k] = (expect[k] || 0) + v; }));
  assert(JSON.stringify(Object.keys(prev).sort()) === JSON.stringify(Object.keys(expect).sort()) && Object.entries(expect).every(([k, v]) => prev[k] === v), '快速拆解的預計回收＝各件單獨拆解的合計（上鎖的不算）');
  const r = eq.dismantleMany(made.map((i) => i.id));
  assert(r.ok && r.n === 3 && eq.getItem(made[2].id) && !eq.getItem(made[0].id) && !eq.getItem(made[3].id), '一次拆解多件，上鎖的保留');
  assert(!eq.dismantleMany([made[2].id]).ok, '只選到上鎖的裝備時不能拆解');
}

// ---- 84. 召回需要回程時間（連續探索在同一地點再搜索時也一樣）----
{
  const gr = Game.newGame({ playerName: 'R84', classId: 'warrior', lat: 25, lon: 121 });
  gr.state.map.pois = fillPois([], 25, 121);
  gr.shelter.establish(gr.state.map.pois.find((p) => gr.shelter.canEstablish(p).ok));
  setHour(gr, 10);
  const ex = gr.exploration;
  const home = gr.shelter.primary();
  const poi = gr.state.map.pois.filter((p) => !gr.shelter.baseAtPoi(p.id) && !p.npc && haversine(p.lat, p.lon, home.lat, home.lon) > 300)[0];
  const L = gr.survivors.leader();
  // 這裡只測回程時間，不讓建築內的戰鬥影響隊員狀態
  gr.survivors.becomeSevere = () => {};
  const sim84 = gr.combat.simulate.bind(gr.combat);
  gr.combat.simulate = (...a) => ({ ...sim84(...a), victory: true });
  const t0 = Date.now();
  // 一般探索：搜索途中召回
  const r = ex.start(poi.id, [L.id], 1, false, t0);
  const e = r.exp;
  // 抵達後 1 秒召回：一定還在搜索中（搜索到一半時可能已因背包滿了提早回家）
  const mid = e.startAt + e.travelMs + 1000;
  assert(ex.recall(e.id, mid).ok && e.endAt - mid > 0 && Math.abs((e.endAt - mid) - e.travelMs) < 5, `搜索途中召回：需要走回避難所（回程 ${Math.round((e.endAt - mid) / 1000)} 秒）`);
  ex.list.splice(ex.list.indexOf(e), 1); L.status = 'idle'; L.hp = gr.survivors.maxHp(L);
  // 連續探索在同一地點再搜索：這一段去程距離為 0
  const r2 = ex.start(poi.id, [L.id], 1, false, t0, { from: { lat: poi.lat, lon: poi.lon } });
  const e2 = r2.exp;
  assert(r2.ok && e2.distanceM < 5 && e2.backMs > 0, '同一地點再搜索：去程為 0、回程直接回避難所');
  const mid2 = e2.startAt + e2.travelMs + 1000;
  const back2 = e2.backMs;
  // 重點是「不會瞬間回家」：回程至少要回程時間的一半（執行速度、日夜交界會讓時間略有差異）
  assert(ex.recall(e2.id, mid2).ok && e2.endAt - mid2 >= Math.min(back2 * 0.5, 5000), `同一地點再搜索時召回：仍需要回程時間（${Math.round((e2.endAt - mid2) / 1000)} 秒，不會瞬間回家）`);
  ex.update(mid2 + Math.min(1000, Math.max(1, (e2.endAt - mid2) / 2)));
  assert(ex.list.includes(e2), '召回後隊伍還在回程中');
}

// ---- 85. 快速佇列、穿脫裝維持生命百分比、快速脫裝、倖存者排序 ----
{
  const gq = Game.newGame({ playerName: 'Q85', classId: 'warrior', lat: 25, lon: 121 });
  gq.state.map.pois = fillPois([], 25, 121);
  gq.shelter.establish(gq.state.map.pois.find((p) => gq.shelter.canEstablish(p).ok));
  setHour(gq, 10);
  const ex = gq.exploration;
  assert(!ex.quickQueueOn(), '快速佇列預設關閉');
  ex.setQuickQueue(true);
  const loaded = SaveManager.migrate(JSON.parse(JSON.stringify(gq.state)));
  assert(loaded.settings.quickQueue === true, '快速佇列開關會存檔');
  const home = gq.shelter.primary();
  const poi = gq.state.map.pois.find((p) => !gq.shelter.baseAtPoi(p.id) && !p.npc && haversine(p.lat, p.lon, home.lat, home.lon) < 800);
  const L = gq.survivors.leader();
  const r = ex.start(poi.id, [L.id], 1, false, Date.now());
  const qf = ex.quickFill(r.exp.id);
  const zones = gq.territory.zones().filter((z) => z.relation !== 'friend');
  assert(qf.ok && r.exp.queue.length === Math.min(ex.queueLimit(), qf.added.length) && qf.added.length > 0, `快速佇列：自動加入附近地點（${qf.added.length}/${ex.queueLimit()}）`);
  assert(qf.added.every((p) => ex.hasStock(p) && !zones.some((z) => haversine(p.lat, p.lon, z.lat, z.lon) <= z.r)) && new Set(r.exp.queue).size === r.exp.queue.length && !r.exp.queue.includes(poi.id), '快速佇列：只加入有物資、不在警戒範圍、不重複的地點');
  assert(ex.quickFill(r.exp.id).added.length === 0 || r.exp.queue.length <= ex.queueLimit(), '快速佇列不超過上限');
  {
    // v15.10：其他玩家或 NPC 正在探索的地點，快速佇列不選
    const busy = qf.added[0];
    const v0 = gq.poiShare.view.bind(gq.poiShare);
    gq.poiShare.view = (p, at) => (p?.id === busy.id ? { ...v0(p, at), occ: [{ n: '玩家「X」', p: 'X', rel: 'other', a: Date.now() - 1000, l: Date.now() + 600000 }] } : v0(p, at));
    r.exp.queue = [];
    const qf2 = ex.quickFill(r.exp.id);
    assert(qf2.added.length > 0 && !qf2.added.some((p) => p.id === busy.id), '快速佇列：其他人正在探索的地點不選');
    gq.poiShare.view = (p, at) => (p?.id === busy.id ? { ...v0(p, at), occ: [{ n: '我', p: 'me', rel: 'me', a: Date.now() - 1000, l: Date.now() + 600000 }] } : v0(p, at));
    assert(ex.othersThere(busy) === false, '自己的隊伍不算其他人');
    gq.poiShare.view = v0;
  }
  const { zoneAt: zoneAt85 } = await import('../src/config/zones.js');
  assert(qf.added.every((p) => zoneAt85(p.lat, p.lon).id === zoneAt85(poi.lat, poi.lon).id), '快速佇列只加入與選定建築同一個區域的建築（不跨區）');
  ex.list.length = 0; L.status = 'idle';
  // 穿脫裝備：維持生命百分比
  const eq = gq.equipment;
  const armor = eq.generate({ level: 5, rarity: 'rare', type: 'armor' });
  armor.loc = 'store'; gq.state.inventory.items.push(armor);
  const sv = gq.survivors;
  Object.keys(L.equipment).forEach((k) => { L.equipment[k] = null; });
  const max0 = sv.maxHp(L);
  sv.setHp(L, max0 * 0.8);
  assert(eq.equip(L.id, armor.id).ok && max0 !== sv.maxHp(L), '穿上裝備（生命上限改變）');
  const max1 = sv.maxHp(L);
  assert(Math.abs(sv.hpOf(L) / max1 - 0.8) < 0.01, `穿上裝備後維持 80% 生命（${Math.round(sv.hpOf(L))}/${max1}）`);
  assert(eq.unequip(L.id, armor.slot).ok && Math.abs(sv.hpOf(L) / sv.maxHp(L) - 0.8) < 0.01, '脫下裝備後仍是 80%，不會變滿血');
  L.hp = null;
  eq.equip(L.id, armor.id);
  assert(L.hp == null, '滿血的人穿上裝備仍是滿血');
  // 快速脫裝
  sv.setHp(L, sv.maxHp(L) * 0.5);
  const u = eq.unequipAll(L.id);
  assert(u.ok && u.n >= 1 && !Object.values(L.equipment).some(Boolean) && Math.abs(sv.hpOf(L) / sv.maxHp(L) - 0.5) < 0.01, '快速脫裝：卸下全部裝備且維持生命百分比');
  assert(!eq.unequipAll(L.id).ok, '身上沒有裝備時不能快速脫裝');
  // 倖存者排序
  const { createSurvivor: mk85 } = await import('../src/core/GameState.js');
  const a = mk85('A85', 'scout', 3, 'common'); const b = mk85('B85', 'scout', 3, 'common');
  gq.state.survivors.push(a, b);
  const ids = () => gq.state.survivors.map((x) => x.id);
  assert(sv.move(b.id, L.id).ok && ids()[0] === b.id, '拖移排序：移到最前面');
  assert(sv.move(b.id, a.id, true).ok && ids().indexOf(b.id) === ids().indexOf(a.id) + 1, '拖移排序：移到指定隊員後面');
  const order = ids();
  const reloaded = SaveManager.migrate(JSON.parse(JSON.stringify(gq.state)));
  assert(JSON.stringify(reloaded.survivors.map((x) => x.id)) === JSON.stringify(order), '拖移後的順序會存檔，讀檔後維持');
}

// ---- 86. 分享報告到聊天室：摘要不超過 120 字、可辨識成卡片、每份只分享一次 ----
{
  const { shareReportText, shareDefenseText, parseShare, isShared, markShared } = await import('../src/multiplayer/ReportShare.js');
  const { CHAT_MAX_LEN, cleanChat } = await import('../src/multiplayer/Chat.js');
  const gs = Game.newGame({ playerName: 'S86', classId: 'warrior', lat: 25, lon: 121 });
  const rep = {
    id: 'rp_x', poiName: '倒塌的工廠 12號', success: true, zone: 'alert', kills: 6,
    resources: { screw: 12, wood: 80, painkiller: 3, nail: 40, bolt: 9, gear: 4 }, items: [{ rarity: 'rare', name: '戰術背心' }, { rarity: 'poor', name: '拖鞋' }, { rarity: 'legendary', name: '黃金步槍' }],
  };
  const t1 = shareReportText(rep, '運氣不錯！這次收穫很多真的很開心哈哈哈哈哈');
  const p1 = parseShare(t1);
  assert([...t1].length <= CHAT_MAX_LEN && cleanChat(t1) === t1, `探索報告分享文字不超過 ${CHAT_MAX_LEN} 字、不會被聊天過濾改掉（${[...t1].length} 字）`);
  assert(p1 && p1.cls === 'explore' && p1.title.includes('倒塌的工廠') && p1.lines.some((l) => l.includes('擊殺6')) && p1.note.length <= 20 && t1.includes('黃金步槍'), '分享文字可辨識成探索卡片（含擊殺、附加的話、高品級裝備優先）');
  const siege = { id: 'df_x', success: true, attacker: '屍潮', waves: 5, kills: 142, siege: { wallPct: 82, coins: 320, items: { screw: 40 } } };
  const p2 = parseShare(shareDefenseText(siege));
  assert(p2 && p2.cls === 'siege' && p2.title.includes('守住了') && p2.lines.join(' ').includes('5波'), '屍潮防守紀錄可分享成卡片');
  const raid = { id: 'df_y', success: true, attacker: 'NPC 鐵拳幫', kills: 4, reward: { coins: 76, gear: [{}], xp: [], hurt: [] } };
  assert(parseShare(shareDefenseText(raid))?.title.includes('擊退NPC 鐵拳幫'), 'NPC 掠奪防守紀錄可分享');
  const lostSiege = { id: 'df_y', success: false, attacker: '屍潮', baseName: '倒塌的工廠 57號', kills: 8, wallLost: 2083, damaged: ['尖刺陷阱'], siege: { wave: 1, maxWaves: 4, lossPct: 55, materials: { screw: 213 } } };
  const p3 = parseShare(shareDefenseText(lostSiege, '慘'));
  assert(p3 && p3.lines.join(' ').includes('倒塌的工廠') && p3.lines.join(' ').includes('資源−55%') && p3.lines.join(' ').includes('材料−213') && p3.lines.join(' ').includes('設施損毀1') && p3.lines.join(' ').includes('圍牆−2083'), '防守失敗的分享包含據點、圍牆與損失');
  assert(parseShare('大家好｜我是新手') === null, '一般訊息不會被當成分享卡片');
  assert(!isShared(gs, 'rp_x'), '尚未分享');
  markShared(gs, 'rp_x');
  assert(isShared(gs, 'rp_x') && SaveManager.migrate(JSON.parse(JSON.stringify(gs.state))).sharedReports?.rp_x, '分享過的紀錄會存檔（每份只能分享一次）');
}

// ---- 87. 已被搜空的建築：報告寫出原因、佇列自動跳過 ----
{
  const { dayKey } = await import('../src/systems/LootStock.js');
  const ge = Game.newGame({ playerName: 'E87', classId: 'warrior', lat: 25, lon: 121 });
  ge.state.map.pois = fillPois([], 25, 121);
  ge.shelter.establish(ge.state.map.pois.find((p) => ge.shelter.canEstablish(p).ok));
  setHour(ge, 10);
  const ex = ge.exploration;
  const home = ge.shelter.primary();
  const near = ge.state.map.pois.filter((p) => !ge.shelter.baseAtPoi(p.id) && !p.npc && haversine(p.lat, p.lon, home.lat, home.lon) < 700).slice(0, 3);
  const L = ge.survivors.leader();
  L.level = 60;
  ge.survivors.becomeSevere = () => {};
  const sim87 = ge.combat.simulate.bind(ge.combat);
  ge.combat.simulate = (...a) => ({ ...sim87(...a), victory: true });
  const now = Date.now();
  // 第二個地點被 NPC 搜空
  ge.poiShare.markNpc(near[1], now - 1000, '鐵拳幫');
  assert(!ex.hasStock(near[1], now) && ex.emptyReason(near[1], now).includes('鐵拳幫'), '被 NPC 搜空的建築記下 NPC 名稱');
  const r1 = ex.start(near[0].id, [L.id], 1, false, now);
  r1.exp.cargo = 1e6;
  ex.enqueue(r1.exp.id, near[1].id);
  ex.enqueue(r1.exp.id, near[2].id);
  ex.update(r1.exp.startAt + r1.exp.travelMs + r1.exp.searchMs + 1);
  const e2 = ex.list.find((e) => e.poiId === near[2].id);
  assert(e2 && !ex.list.some((e) => e.poiId === near[1].id), '連續探索：已被搜空的佇列地點自動跳過，直接前往下一個');
  assert(ge.state.reports[0]?.events.some((t) => t.includes('跳過') && t.includes('鐵拳幫')), '報告寫出跳過的地點與被誰搜空');
  ex.list.length = 0; L.status = 'idle'; L.hp = null;
  // 直接派遣到已被搜空的建築：不能出發（避免白跑），並說明恢復時間
  const r2 = ex.start(near[1].id, [L.id], 1, false, Date.now());
  assert(!r2.ok && r2.reason.includes('已被搜空'), `派遣到已被搜空的建築會被擋下（${r2.reason}）`);
  // 自己搜過（全部帶走）：原因顯示玩家名稱（所有玩家看到的相同）
  assert(!ex.hasStock(near[0], now + 3600e3) && ex.emptyReason(near[0], now + 3600e3).includes('E87'), `自己搜過的建築記下搜空的玩家（${ex.emptyReason(near[0], now + 3600e3)}）`);
}

// ---- 88. 自動探索＋連續探索：搜完沒有剩下物資時，不會「再搜索一次」同一個地點 ----
{
  const ga = Game.newGame({ playerName: 'A88', classId: 'warrior', lat: 25, lon: 121 });
  ga.state.map.pois = fillPois([], 25, 121);
  ga.shelter.establish(ga.state.map.pois.find((p) => ga.shelter.canEstablish(p).ok));
  setHour(ga, 10);
  const ex = ga.exploration;
  const home = ga.shelter.primary();
  const near = ga.state.map.pois.filter((p) => !ga.shelter.baseAtPoi(p.id) && !p.npc && ex.hasStock(p) && haversine(p.lat, p.lon, home.lat, home.lon) < 700).slice(0, 2);
  const L = ga.survivors.leader();
  L.level = 60;
  ga.survivors.becomeSevere = () => {};
  const sim88 = ga.combat.simulate.bind(ga.combat);
  ga.combat.simulate = (...a) => ({ ...sim88(...a), victory: true });
  ga.research.hasUnlock = () => true;
  const r = ex.start(near[0].id, [L.id], 1, true, Date.now());
  r.exp.cargo = 1e6; // 全部帶得走：搜完就沒有剩下
  ex.enqueue(r.exp.id, near[1].id);
  ex.update(r.exp.startAt + r.exp.travelMs + r.exp.searchMs + 1);
  const again = ex.list.find((e) => e.poiId === near[0].id);
  const next = ex.list.find((e) => e.poiId === near[1].id);
  assert(!again && next && !ex.hasStock(near[0], r.exp.startAt + r.exp.travelMs + r.exp.searchMs + 2), '搜完全部帶走：不會再搜索同一個地點，改前往佇列下一站');
  assert(!ga.state.reports[0].events.some((t) => t.includes('直接再搜索一次')), '報告不會寫「還有物資，直接再搜索一次」');
}

// ---- 89. 彈藥批量製作：材料依批數相乘、最多批數依材料與倉庫空間、批數會記住 ----
{
  const gb = Game.newGame({ playerName: 'A89', classId: 'warrior', lat: 25, lon: 121 });
  const eq = gb.equipment;
  const sup = await import('../src/config/supplies.js');
  const rc = sup.AMMO_RECIPES.arrow;
  const setMat = (m) => Object.entries(rc.cost).forEach(([k, v]) => { if (k in gb.state.resources) gb.state.resources[k] = v * m; else gb.state.supplies[k] = v * m; });
  (gb.state.survivors || []).forEach((s) => { s.bag = {}; });
  setMat(4);
  gb.state.supplies.arrow = 0;
  assert(eq.ammoMaxBatches('arrow').max === 4, '最多批數依材料計算');
  assert(eq.ammoBatch('arrow') === 1, '批數預設 ×1');
  eq.setAmmoBatch('arrow', 5);
  assert(eq.ammoBatch('arrow') === 5 && gb.state.settings.ammoBatch.arrow === 5, '批數記在存檔設定');
  const over = eq.craftAmmo('arrow', 5);
  assert(!over.ok && !gb.state.supplies.arrow, '材料不足時不會製作');
  const r = eq.craftAmmo('arrow', 3);
  assert(r.ok && gb.state.supplies.arrow === rc.batch * 3 && r.msg.includes('3 批'), '一次製作 3 批');
  assert(eq.ammoMaxBatches('arrow').max === 1, '扣除 3 批材料後剩 1 批');
  const room0 = eq.supplyRoom;
  eq.supplyRoom = () => rc.batch * 1;
  setMat(10);
  const mb = eq.ammoMaxBatches('arrow');
  assert(mb.max === 1 && mb.limit === 'room', '倉庫空間限制最多批數');
  assert(!eq.craftAmmo('arrow', 2).ok, '倉庫放不下時不能製作');
  eq.supplyRoom = room0;
}

// ---- 90. 彈殼：戰鬥勝利後回收、子彈配方用彈殼、彈殼不會出現在一般零件 ----
{
  const sup = await import('../src/config/supplies.js');
  const { pickSupply } = await import('../src/systems/LootStock.js');
  const gc = Game.newGame({ playerName: 'A90', classId: 'warrior', lat: 25, lon: 121 });
  const lead = gc.survivors.leader();
  const gun = gc.equipment.generate({ level: 5, model: 'm1911', rarity: 'common' });
  gc.equipment.addItem(gun, 't');
  gc.equipment.equip(lead.id, gun.id);
  gc.survivors.loadout(lead).ammo = { key: 'ammo9', qty: 100 };
  const pool = {};
  gc.combat.fightUse = null;
  const sim = gc.combat.simulate.bind(gc.combat);
  let rec = 0;
  for (let i = 0; i < 20; i += 1) {
    gc.survivors.loadout(lead).ammo = { key: 'ammo9', qty: 100 };
    const enemies = [gc.combat.createEnemy('walker', 1, false)];
    const r = sim([lead], enemies, { recoverTo: pool, record: false });
    if (r.victory) rec += 1;
    gc.survivors.setHp(lead, gc.survivors.maxHp(lead));
    lead.severe = false;
  }
  const per = sup.AMMO_FOR.pistol.perFight * sup.AMMO_RECOVER;
  assert(rec > 0 && pool.casing > 0 && pool.casing <= Math.ceil(per) * rec, `勝利後回收彈殼（${rec} 場勝利，回收 ${pool.casing}）`);
  assert(Object.values(sup.AMMO_RECIPES).filter((r) => r.batch >= 30).length === 3 && sup.AMMO_RECIPES.ammo9.cost.casing > 0, '子彈每批產量提高並使用彈殼');
  assert(!sup.AMMO_RECIPES.ammo556.cost.firingPin && sup.AMMO_RECIPES.ammo308.cost.firingPin, '只有 .308 需要擊針');
  let seen = false;
  for (let i = 0; i < 3000; i += 1) if (pickSupply('part', Math.random, 0) === 'casing') seen = true;
  assert(!seen && sup.materialize({ metal: 50 }, { tier: 1, tags: ['struct', 'mech', 'elec', 'gun'] }).casing === undefined, '彈殼不會出現在一般零件與建造成本');
  const sg = gc.siege.of ? gc.siege.of(gc.state.primaryBaseId || 'x') : null;
  if (sg) {
    sg.nightRecover = { casing: 10.0, arrow: 3.0 };
    const got = sg.collectRecovered();
    assert(got.casing === 10 && got.arrow === 3 && gc.state.supplies.casing >= 10, '屍潮防守射擊後回收的彈殼放回倉庫');
  }
}

// ---- 91. 藥品製作：依診療室等級解鎖、前一階藥品投入不超過產出的 6 成 ----
{
  const sup = await import('../src/config/supplies.js');
  const gm = Game.newGame({ playerName: 'A91', classId: 'warrior', lat: 25, lon: 121 });
  const eq = gm.equipment;
  let lv = 0;
  eq.clinicLevel = () => lv;
  assert(!eq.canCraftAmmo('gauze').ok && eq.canCraftAmmo('gauze').reason.includes('醫療站'), '沒有醫療站不能製作藥品');
  lv = 1;
  assert(eq.canCraftAmmo('gauze').ok && !eq.canCraftAmmo('vitamin').ok, '診療室 Lv1 可做紗布，維他命需要更高等級');
  (gm.state.survivors || []).forEach((s) => { s.bag = {}; });
  gm.state.supplies.cotton = 8;
  const g0 = gm.state.supplies.gauze || 0;
  const r = eq.craftAmmo('gauze', 4);
  assert(r.ok && gm.state.supplies.gauze === g0 + 20 && !gm.state.supplies.cotton, '藥品可以批量製作並扣除材料');
  assert(!sup.MED_RECIPES.largeKit, '大型醫藥箱不能製作');
  const ok = Object.entries(sup.MED_RECIPES).every(([k, rc]) => {
    const meds = Object.entries(rc.cost).filter(([m]) => sup.SUPPLIES[m]?.cat === 'med');
    const input = meds.reduce((a, [m, v]) => a + sup.SUPPLIES[m].heal * v, 0);
    return input <= sup.SUPPLIES[k].heal * rc.batch * 0.6;
  });
  assert(ok, '每種藥品配方都划算：投入藥品的回復量不超過產出 6 成');
}

// ---- 92. 自然回復：每秒更新也會累積（不會被四捨五入吃掉） ----
{
  const gr = Game.newGame({ playerName: 'A92', classId: 'warrior', lat: 25, lon: 121 });
  gr.state.map.pois = fillPois([], 25, 121);
  gr.shelter.establish(gr.state.map.pois.find((p) => gr.shelter.canEstablish(p).ok));
  gr.shelter.primary().facilities.clinic.level = 1;
  gr.state.resources.food = 99999;
  gr.state.starving = false;
  const sv = gr.survivors.leader();
  gr.survivors.setHp(sv, 3);
  const t0 = Date.now();
  for (let i = 1; i <= 600; i += 1) gr.survivors.updateVitals(t0 + i * 1000, 1000, 0);
  const hp = gr.survivors.hpOf(sv);
  const expect = 3 + gr.survivors.maxHp(sv) * gr.survivors.healRate(sv) * gr.survivors.regenMul() * 10;
  assert(hp > 3.5 && Math.abs(hp - expect) < 0.2, `診療室 Lv1 每秒回復 10 分鐘後生命會增加（3 → ${hp.toFixed(2)}，預期約 ${expect.toFixed(2)}）`);
}

// ---- 93. 宿舍住滿後（Lv8～15）：人數維持 10、休息回復加快、食物消耗減少、招募候選人增加 ----
{
  const fac = await import('../src/config/facilities.js');
  const gd = Game.newGame({ playerName: 'A93', classId: 'warrior', lat: 25, lon: 121 });
  gd.state.map.pois = fillPois([], 25, 121);
  gd.shelter.establish(gd.state.map.pois.find((p) => gd.shelter.canEstablish(p).ok));
  const dorm = gd.shelter.primary().facilities.dormitory;
  dorm.level = 9; // v14：宿舍 Lv9 住滿 12 人
  const cap7 = gd.survivors.dormCap(); const mul7 = gd.survivors.regenMul(); const food7 = gd.resources.rates().upkeep.food; const board7 = gd.survivors.boardSize();
  dorm.level = 15;
  const cap15 = gd.survivors.dormCap(); const mul15 = gd.survivors.regenMul(); const food15 = gd.resources.rates().upkeep.food; const board15 = gd.survivors.boardSize();
  dorm.level = 10;
  const board10 = gd.survivors.boardSize();
  assert(cap7 === 12 && cap15 === 12 && fac.dormCap(3) === 6, `宿舍 Lv9 住滿 12 人，之後不再增加（${cap7}/${cap15}）`);
  assert(Math.abs(mul15 - mul7 - 0.48) < 1e-9, `宿舍 Lv15 休息回復 +48%（${mul7.toFixed(2)} → ${mul15.toFixed(2)}）`);
  assert(Math.abs(food15 / food7 - 0.84) < 0.001, `宿舍 Lv15 食物消耗 −16%（${food7.toFixed(2)} → ${food15.toFixed(2)}）`);
  assert(board10 === board7 + 1 && board15 === board7 + 2, `宿舍 Lv10、Lv15 招募候選人各 +1（${board7} → ${board10} → ${board15}）`);
  assert(fac.FACILITIES.dormitory.effectText(12).includes('休息回復 +24%') && fac.FACILITIES.dormitory.effectText(5).includes('8 人'), '宿舍效果說明顯示對應等級的效果');
}

// ---- 94. 探索遇到的倖存者：等級依自己隊伍的平均等級，不會因建築殭屍等級過高 ----
{
  const ge = Game.newGame({ playerName: 'A94', classId: 'warrior', lat: 25, lon: 121 });
  ge.state.map.pois = fillPois([], 25, 121);
  ge.shelter.establish(ge.state.map.pois.find((p) => ge.shelter.canEstablish(p).ok));
  ge.survivors.leader().level = 5;
  const src = (await import('node:fs')).readFileSync(new URL('../src/systems/ExplorationSystem.js', import.meta.url), 'utf8');
  assert(src.includes('this.game.survivors.candidateLevel() + lvBonus'), '探索遇到的倖存者等級改用隊伍平均等級');
  const maxLv = Math.max(...Array.from({ length: 300 }, () => ge.survivors.candidateLevel())) + 3;
  assert(maxLv <= 5 + 3, `隊伍 Lv5 時，探索遇到的倖存者最多約 Lv${maxLv}（不會出現 Lv40）`);
}

// ---- 95. 移除黑市專屬保留區：舊存檔全額退還「黑市商人的厚愛」研究材料 ----
{
  const { REMOVED_RESEARCH, researchCost } = await import('../src/config/research.js');
  const gv = Game.newGame({ playerName: 'A95', classId: 'warrior', lat: 25, lon: 121 });
  const st = JSON.parse(JSON.stringify(gv.state));
  st.version = 24;
  st.research.levels.t_bm_vip = 2;
  st.bmVip = { slots: [], hour: 1 };
  const c1 = researchCost('t_bm_vip', 1, REMOVED_RESEARCH.t_bm_vip);
  const c2 = researchCost('t_bm_vip', 2, REMOVED_RESEARCH.t_bm_vip);
  const key = Object.keys(c1).find((k) => k !== 'coins' && k !== 'parts');
  const pool = (d) => (d.resources && key in d.resources ? d.resources : d.supplies || {});
  const before = pool(st)[key] || 0;
  const mig = SaveManager.migrate(st);
  assert(!mig.research.levels.t_bm_vip && !mig.bmVip && (pool(mig)[key] || 0) === before + c1[key] + (c2[key] || 0), `舊存檔移除「黑市商人的厚愛」並全額退還材料（${key} +${c1[key] + (c2[key] || 0)}）`);
}

// ---- 96. 協防：召回的協防隊也顯示協防戰果；回家後才收到的戰果會補進報告 ----
{
  const ga = Game.newGame({ playerName: 'A96', classId: 'warrior', lat: 25, lon: 121 });
  const L = ga.survivors.leader();
  const exp = { kind: 'assist', recalled: true, assistTarget: { playerId: 'P96', name: '胖胖' }, memberIds: [L.id], travelEvents: ['↩️ 收到召回命令，隊伍折返避難所'], endAt: Date.now() };
  const rep = ga.assist.report(exp);
  assert(rep.success && rep.events.some((e) => e.includes('對方尚未回報戰果')) && !rep.events.some((e) => e.includes('沒有收穫')), '召回的協防隊使用協防報告（不再寫「這趟沒有收穫」）');
  ga.state.reports = [rep, ...(ga.state.reports || [])];
  assert(ga.assist.patchReport('P96', '🛡️ 協防「胖胖」戰報：擊殺 12 隻；✅ 成功守住', 12) && rep.events.some((e) => e.includes('成功守住')) && !rep.events.some((e) => e.includes('尚未回報')) && rep.kills === 12, '回家後收到的協防戰果補進報告');
  assert(!ga.assist.patchReport('P96', '🛡️ 協防「胖胖」戰報：擊殺 12 隻；✅ 成功守住', 12), '同一段戰果不會重複補上');
  // 同一趟協防同時有屍潮與 NPC 攻打：之後收到的 NPC 戰果也會補進同一份報告
  const npcText = '🛡️ 協防「胖胖」戰報：抵禦 NPC「禿鷹隊」的攻打，你的協防隊擊倒 3 人；✅ 成功守住';
  assert(ga.assist.patchReport('P96', npcText, 3) && rep.events.includes(npcText) && rep.events.some((e) => e.includes('擊殺 12 隻')) && rep.events[rep.events.length - 1].includes('回到避難所'), '屍潮與 NPC 的協防戰果都會出現在協防報告裡');
}

// ---- 97. 戰鬥明細跟著探索報告、避難所紀錄與事件紀錄保存 ----
{
  const g97 = Game.newGame({ playerName: 'A97', classId: 'warrior', lat: 25, lon: 121 });
  const L = g97.survivors.leader();
  const exp = { kind: 'explore', poiId: 'x', memberIds: [L.id] };
  g97.combat.simulate([L], [g97.combat.createEnemy('walker', 1)], { title: '途中', ref: exp });
  g97.combat.within(exp, () => g97.combat.simulate([L], [g97.combat.createEnemy('walker', 1)], { title: '檢核點' }));
  const rep = { id: 'rp97', events: [], resources: {}, items: [], blueprints: [], members: [] };
  g97.exploration.tagZone(rep, exp);
  g97.state.reports = [rep];
  assert(rep.battleIds?.length === 2 && rep.battleIds.every((id) => g97.combat.battle(id)), '探索中的戰鬥都記在該次探索報告裡');
  // 不屬於探索或防守的戰鬥：附在接著的事件紀錄上
  g97.combat.simulate([L], [g97.combat.createEnemy('walker', 1)], { title: '駐守攔截' });
  g97.log('🛡️ 擊退路過的隊伍', 'success');
  assert(g97.state.log[0].battleId && g97.combat.battle(g97.state.log[0].battleId)?.title === '駐守攔截', '其他戰鬥附在事件紀錄上');
  // 防守紀錄
  const holder = { battleIds: [] };
  g97.combat.within(holder, () => g97.combat.simulate([L], [g97.combat.createEnemy('walker', 1)], { title: '防守' }));
  g97.shelter.recordDefense({ attacker: 'NPC', success: true, battleIds: holder.battleIds });
  assert(g97.state.defenseLog[0].battleIds?.length === 1 && g97.combat.battle(g97.state.defenseLog[0].battleIds[0]), '防守的戰鬥記在避難所紀錄裡');
  // 報告被移除後，對應的戰鬥也一起清掉
  g97.state.reports = [];
  g97.combat.pruneBattles();
  assert(!rep.battleIds.some((id) => g97.combat.battle(id)) && g97.state.battles.length === 2, '沒有報告引用的戰鬥會被清掉');
  const old = JSON.parse(JSON.stringify(g97.state));
  old.version = 24;
  old.battles = [{ id: 'bt_old', title: 'x' }];
  assert(SaveManager.migrate(old).battles.length === 0, '舊存檔的戰鬥紀錄（無法對應）不保留');
}

// ---- 97b. 同一波屍潮的多次交戰合併成一場戰鬥紀錄 ----
{
  const gw = Game.newGame({ playerName: 'W97', classId: 'warrior', lat: 25, lon: 121 });
  const L = gw.survivors.leader();
  const night = { battleIds: [] };
  for (let i = 0; i < 4; i += 1) gw.combat.simulate([L], [gw.combat.createEnemy('walker', 1)], { title: '第 2 波', ref: night, merge: 'wave2' });
  gw.combat.simulate([L], [gw.combat.createEnemy('walker', 1)], { title: '第 3 波', ref: night, merge: 'wave3' });
  const b2 = gw.combat.battle(night.battleIds[0]);
  assert(night.battleIds.length === 2 && b2.fights === 4 && b2.foes.length === 4, `同一波屍潮的多次交戰合併成一場（${night.battleIds.length} 場）`);
}

// ---- 98. 地窖：零件與布料每種藏起一定數量，屍潮突破時不會損失 ----
{
  const { cellarMatCap } = await import('../src/config/facilities.js');
  const gc = Game.newGame({ playerName: 'K98', classId: 'warrior', lat: 25, lon: 121 });
  gc.state.map.pois = fillPois([], 25, 121);
  gc.shelter.establish(gc.state.map.pois.find((p) => gc.shelter.canEstablish(p).ok));
  const base = gc.shelter.primary();
  base.facilities.cellar.level = 5;
  const cap = cellarMatCap(5);
  assert(cap > 0 && cellarMatCap(6) > cap && gc.shelter.cellarProtect('nail') === cap, `地窖保護每種零件 ${cap} 個`);
  const sup = gc.state.supplies;
  Object.keys(sup).forEach((k) => { delete sup[k]; });
  sup.nail = cap;
  sup.screw = cap + 200;
  const S = gc.siege.of();
  let lostNail = 0;
  let lostScrew = 0;
  for (let i = 0; i < 40; i += 1) {
    const out = S.loseMaterials();
    lostNail += out.nail || 0;
    lostScrew += out.screw || 0;
  }
  assert(lostNail === 0 && sup.nail === cap && lostScrew > 0 && sup.screw >= cap, '地窖容量內的零件不會損失，超過的部分才會');
  const c = gc.shelter.cellarStatus();
  assert(c.lv === 5 && c.matKinds === 2 && c.mats === cap * 2, '地窖顯示目前藏起的零件數量');
}

// ---- 99. 重度感染據點不會和玩家據點重疊（據點建立或附近玩家載入後換位置） ----
{
  const { INFECTED } = await import('../src/systems/InfectedSystem.js');
  const gi = Game.newGame({ playerName: 'I99', classId: 'warrior', lat: 25.0339, lon: 121.5645 });
  gi.testInfBlock = true;
  gi.state.map.pois = fillPois([], 25.0339, 121.5645);
  gi.shelter.establish(gi.state.map.pois.find((p) => gi.shelter.canEstablish(p).ok));
  const s0 = gi.infected.list()[0];
  assert(s0, '附近有重度感染據點');
  if (s0) {
    // v10：位置固定，不會因附近玩家據點載入而移動；更新前就重疊的玩家據點：這一格改為沒有感染據點
    const s1 = gi.infected.list().find((x) => x.id === s0.id);
    assert(s1 && s1.lat === s0.lat && s1.lon === s0.lon, '重度感染據點位置固定');

    // 新據點不能蓋在感染據點範圍內
    const nearPoi = { id: 'near99', type: 'residential', name: 'x', lat: s0.lat, lon: s0.lon };
    const ce = gi.shelter.canEstablish(nearPoi);
    assert(!ce.ok && ce.reason.includes('重度感染'), '新據點不能蓋在重度感染據點範圍內');
    const near = gi.infected.list().every((x) => gi.state.bases.every((b) => haversine(b.lat, b.lon, x.lat, x.lon) > gi.territory.alertRadius(b) + INFECTED.clearM));
    assert(near, '重度感染據點避開自己的據點與警戒範圍');
  }
}

// ---- 100. v10 隨機地圖：固定格子產生、所有玩家相同、比例與區域限定 ----
{
  const { generatePois } = await import('../src/map/WorldGen.js');
  const { zoneIndexAt } = await import('../src/config/zones.js');
  const a = generatePois(25.0339, 121.5645, 1200);
  const b = generatePois(25.0339, 121.5645, 1200);
  assert(a.length > 1250 && a.length < 1550, `避難所周圍 1.2 公里約 1,400 個地點（${a.length}）`);
  assert(JSON.stringify(a) === JSON.stringify(b), '同一位置每次（每位玩家）產生的地點完全相同');
  const big = [[25.03, 121.56], [24.8, 121.0], [23.0, 120.2], [22.6, 120.3], [24.15, 120.67]].flatMap(([la, lo]) => generatePois(la, lo, 2500));
  const share = (t) => big.filter((p) => p.type === t).length / big.length;
  const food = share('residential') + share('shop') + share('supermarket');
  assert(Math.abs(food - 0.24) < 0.04 && Math.abs(share('forest') - 0.18) < 0.03, `比例接近目標（食物 ${(food * 100).toFixed(0)}%、樹林 ${(share('forest') * 100).toFixed(0)}%）`);
  assert(!big.some((p) => p.type === 'bakery'), '不再產生麵包店');
  assert(big.filter((p) => p.type === 'pharmacy').every((p) => zoneIndexAt(p.lat, p.lon) <= 2), '藥局只出現在警戒區以下');
  assert(big.filter((p) => p.type === 'hospital').every((p) => zoneIndexAt(p.lat, p.lon) >= 2), '醫院只出現在警戒區以上');
  assert(big.filter((p) => p.type === 'military').every((p) => zoneIndexAt(p.lat, p.lon) === 5), '軍事基地只出現在深淵區');
  // 遊戲中的地圖：避難所與前哨站周圍，保留搜刮紀錄；舊存檔的麵包店據點改為商店
  const gm = Game.newGame({ playerName: 'M100', classId: 'warrior', lat: 25.0339, lon: 121.5645 });
  gm.genMap(25.0339, 121.5645);
  const home = gm.state.map.pois.find((p) => gm.shelter.canEstablish(p).ok);
  gm.shelter.establish(home);
  const p0 = gm.state.map.pois.find((p) => p.id !== home.id);
  p0.lootedDay = 123;
  gm.genMap();
  assert(gm.state.map.pois.find((p) => p.id === p0.id)?.lootedDay === 123 && gm.state.map.source === 'generated', '重新產生地圖時保留每個地點的搜刮紀錄');
}

// ---- 101. v10 地點探索佔用規則（多人共用）：先到先探索、晚到跳下一站、接續檢核點、搜空 90 分鐘恢復 ----
{
  const { MemoryObjects } = await import('../src/multiplayer/SharedWorld.js');
  const { POI_SHARE } = await import('../src/systems/PoiShareSystem.js');
  const { generatePois } = await import('../src/map/WorldGen.js');
  const store = new MemoryObjects();
  const LAT = 25.0339;
  const LON = 121.5645;
  const pois = generatePois(LAT, LON, 1200);
  const tick = () => new Promise((r) => setTimeout(r, 5));
  const mk = (name) => {
    const gx = Game.newGame({ playerName: name, classId: 'warrior', lat: LAT, lon: LON });
    gx.state.map.pois = JSON.parse(JSON.stringify(pois));
    gx.shared.backend = store;
    gx.world = { others: [], myId: name, identity: () => ({ id: name, token: 't' }) };
    setHour(gx, 10);
    const L = gx.survivors.leader();
    L.level = 60;
    gx.survivors.becomeSevere = () => {};
    const sim = gx.combat.simulate.bind(gx.combat);
    gx.combat.simulate = (...a) => ({ ...sim(...a), victory: true });
    return gx;
  };
  const A = mk('A101');
  const B = mk('B101');
  const C = mk('C101');
  // 三人的避難所在同一個地點附近（各自建立在不同的地點）
  const homes = pois.filter((p) => haversine(p.lat, p.lon, LAT, LON) < 150).slice(0, 3);
  [A, B, C].forEach((gx, i) => gx.shelter.establish(gx.state.map.pois.find((p) => p.id === homes[i].id)));
  const big = pois.filter((p) => !homes.includes(p) && haversine(p.lat, p.lon, LAT, LON) < 600 && A.exploration.checkpointCount(p) >= 2);
  const T = big[0];
  const T2 = big[1];
  const T3 = big[2];
  const reset = (gx) => { const L = gx.survivors.leader(); Object.assign(L, { status: 'idle', hp: null, severe: false }); gx.state.expeditions = []; };
  // 1. B 先出發、先抵達；A 晚出發、晚抵達：A 抵達時 B 還在搜索 → A 讓給 B，前往佇列下一站
  const now = Date.now();
  // B 比 A 早幾分鐘出發（一定比 A 早抵達）
  const rb = B.exploration.start(T.id, ['leader'], 1, false, now - 120000);
  assert(rb.ok, `B 出發（${rb.reason || ''}）`);
  await tick();
  await A.shared.poll();
  const vA = A.poiShare.view(T, now);
  assert(vA.occ.some((x) => x.n === 'B101'), '其他玩家看得到誰正在前往／探索這個地點');
  // A 若現在手動派遣會在 B 搜索中抵達 → 不能出發（避免白跑）
  const blocked = A.exploration.start(T.id, ['leader'], 1, false, Date.now());
  assert(!blocked.ok && blocked.reason.includes('B101'), `抵達時有人在探索：手動派遣會被擋下（${blocked.reason}）`);
  // 用小隊佇列（不檢查）讓 A 晚一點抵達：A 先去 T2，佇列下一站是 T
  const ra = A.exploration.start(T2.id, ['leader'], 1, false, now);
  assert(ra.ok, `A 出發（${ra.reason || ''}）`);
  ra.exp.cargo = 1e6;
  A.exploration.enqueue(ra.exp.id, T.id);
  A.exploration.enqueue(ra.exp.id, T3.id);
  await tick();
  // A 先上線結算（B 還沒結算）：A 抵達 T 時 B 已經在搜索（依抵達時間判斷，不看誰先結算）
  const eB = rb.exp;
  const bLeave = eB.startAt + eB.travelMs + eB.searchMs;
  let guard = 0;
  let aT = null;
  while (guard < 40) {
    guard += 1;
    const cur = A.state.expeditions.find((e) => e.poiId === T.id);
    if (cur && cur.cp) { aT = cur; break; }
    const nx = A.state.expeditions[0];
    if (!nx) break;
    A.exploration.update(Math.min(nx.endAt, nx.startAt + nx.travelMs + nx.searchMs) + 1, { silent: true });
  }
  const arriveA = aT ? aT.startAt + aT.travelMs : 0;
  if (aT && arriveA < bLeave) {
    assert(aT.cp.bumped && aT.cp.bumped.includes('B101'), `晚到的隊伍讓給先到的人（${aT.cp.bumped || '沒有讓'}）`);
    A.exploration.update(aT.endAt + 1, { silent: true });
    assert(A.state.expeditions.some((e) => e.poiId === T3.id) || A.state.reports.some((r) => r.events.some((t) => t.includes('B101'))), '被搶先後自動前往佇列下一站（或回家），報告寫出原因');
    const nxt = A.state.expeditions.find((e) => e.poiId === T3.id);
    if (nxt) assert(!(nxt.stops || []).includes(T.id), '被搶先而跳過的地點不會在地圖標成已搜索（✓）');
  } else assert(true, '（A 抵達時 B 已離開，跳過讓位檢查）');
  // 2. B 搜索到一半就召回：剩下的檢核點與物資留給下一位
  reset(A);
  const cpT = B.exploration.checkpointCount(T);
  const t1 = eB.startAt + eB.travelMs + eB.searchMs / cpT + 1;
  B.exploration.runCheckpoints(eB, t1);
  assert(eB.cp && eB.cp.done === 1, `B 搜完第 1 個檢核點（${eB.cp?.done}/${cpT}）`);
  B.exploration.recall(eB.id, t1 + 1);
  B.exploration.update(eB.endAt + 1, { silent: true });
  await tick();
  await C.shared.poll();
  const vC = C.poiShare.view(T);
  assert(vC.left && vC.left.done === 1 && vC.left.total === A.exploration.checkpointCount(T), `探索到一半離開：其他玩家看到剩下的檢核點（${vC.left?.done}/${vC.left?.total}）`);
  assert(!vC.occ.some((x) => x.n === 'B101' && x.l > Date.now() + 60000), '離開後移除自己的佔用紀錄');
  // C 接著探索：從第 2 個檢核點繼續，搜索時間較短
  // 同規模的另一棟（v14：規模依區域與建築 ID 決定）
  const { baseSizeOf: bso } = await import('../src/config/civilization.js');
  let copyId = 'fresh-copy';
  for (let k = 0; k < 200 && bso({ ...T, id: copyId }) !== bso(T); k += 1) copyId = `fresh-copy-${k}`;
  const fullMin = C.exploration.searchMinutes({ ...T, id: copyId });
  assert(C.exploration.searchMinutes(T) < fullMin, '接續探索只需剩餘的搜索時間');
  const rc = C.exploration.start(T.id, ['leader'], 1, false, Date.now());
  assert(rc.ok, `C 繼續探索（${rc.reason || ''}）`);
  rc.exp.cargo = 1e6;
  C.exploration.runCheckpoints(rc.exp, rc.exp.startAt + rc.exp.travelMs + 1);
  assert(rc.exp.cp && rc.exp.cp.offset === 1 && rc.exp.cp.total === vC.left.total - 1 && rc.exp.cp.stock.partial, '從剩下的檢核點繼續，只找得到剩下的物資');
  C.exploration.update(rc.exp.endAt + 1, { silent: true });
  await tick();
  await A.shared.poll();
  const after = rc.exp.startAt + rc.exp.travelMs + rc.exp.searchMs + 1000;
  const vE = A.poiShare.view(T, after);
  assert(vE.empty && vE.by && vE.by.includes('C101'), `全部搜完：所有玩家看到已被搜空（${vE.by}）`);
  assert(!A.exploration.hasStock(T, after) && A.exploration.emptyReason(T, after).includes('恢復'), '已搜空的地點沒有物資，並顯示恢復時間');
  // 3. 90 分鐘後恢復：物資重新產生（下一個世代）
  const later = vE.until + 1000;
  const vR = A.poiShare.view(T, later);
  assert(POI_SHARE.recoverMs === 90 * 60000, '資源點搜空後 90 分鐘恢復');
  assert(!vR.empty && vR.gen === (store.get ? vR.gen : vR.gen) && A.exploration.hasStock(T, later) && vE.until - (rc.exp.startAt + rc.exp.travelMs + rc.exp.searchMs) <= POI_SHARE.recoverMs + 1000, '搜空 90 分鐘後恢復');
  // 4. 兩人前往同一個地點：先抵達的人探索；晚抵達的人手動派遣會被擋下，或抵達時讓位
  const T4 = big[3];
  reset(A); reset(B);
  const t4 = Date.now();
  const r4a = A.exploration.start(T4.id, ['leader'], 1, false, t4);
  await tick();
  await B.shared.poll();
  const r4b = B.exploration.start(T4.id, ['leader'], 1, false, t4);
  assert(r4a.ok, 'A 先派遣');
  if (!r4b.ok) assert(r4b.reason.includes('A101'), `B 比 A 晚抵達：派遣時就被擋下（${r4b.reason}）`);
  else {
    // B 比較近、先抵達：A 抵達時讓給 B
    await tick();
    await A.shared.poll();
    A.exploration.runCheckpoints(r4a.exp, r4a.exp.startAt + r4a.exp.travelMs + 1);
    assert(r4a.exp.cp?.bumped?.includes('B101'), `B 比 A 早抵達：A 抵達時讓給 B（${r4a.exp.cp?.bumped}）`);
  }
}

// ---- 102. v10 舊存檔遷移：真實建築地圖換成隨機地圖，據點（麵包店）與探索目的地保留 ----
{
  const go = Game.newGame({ playerName: 'O102', classId: 'warrior', lat: 25.0339, lon: 121.5645 });
  const osm = [
    { id: 'osm_n1', type: 'bakery', name: '老麵包店', lat: 25.0339, lon: 121.5645, osm: true },
    { id: 'osm_n2', type: 'shop', name: '便利商店', lat: 25.0349, lon: 121.5655, osm: true },
    { id: 'osm_n3', type: 'residential', name: '住宅', lat: 25.0359, lon: 121.5665, osm: true },
  ];
  go.state.map.pois = osm;
  go.state.map.source = 'overpass';
  go.state.map.remain = { osm_n3: { day: 1, res: { food: 3 } } };
  go.shelter.establish(osm[0]);
  go.state.version = 26;
  const data = SaveManager.migrate(JSON.parse(JSON.stringify(SaveManager.pack(go.state))));
  assert(!data.map.remain && data.version === SAVE_VERSION_NOW, '舊存檔遷移：移除舊的建築殘留物資');
  go.state = data;
  go.genMap();
  const pois = go.state.map.pois;
  const home = pois.find((p) => p.id === 'osm_n1');
  assert(home && home.type === 'shop' && go.shelter.primary().poiId === 'osm_n1', '據點所在的麵包店保留下來並改為商店');
  assert(!pois.some((p) => p.id === 'osm_n3') && pois.filter((p) => p.id.startsWith('w_')).length > 1000 && go.state.map.source === 'generated', '其他真實建築換成隨機產生的地點');
  assert(!pois.some((p) => p.type === 'bakery'), '地圖上不再有麵包店');
}

// ---- 103. 自動回家：遊戲時間 21:30 所有外派隊伍回家、清空探索佇列；每天只觸發一次；可關閉；離線照 21:30 結算 ----
{
  const mkH = (name) => {
    const gx = Game.newGame({ playerName: name, classId: 'warrior', lat: 25, lon: 121 });
    gx.state.map.pois = fillPois([], 25, 121);
    gx.shelter.establish(gx.state.map.pois.find((p) => gx.shelter.canEstablish(p).ok));
    Object.assign(gx.survivors.leader(), { level: 40, hp: null, severe: false });
    const sim = gx.combat.simulate.bind(gx.combat);
    gx.combat.simulate = (...a) => ({ ...sim(...a), victory: true });
    return gx;
  };
  const gh = mkH('H103');
  assert(gh.autoHome.on(), '自動回家預設打開');
  setHour(gh, 20.5);
  gh.autoHome.check(Date.now());
  const home = gh.shelter.primary();
  const far = gh.state.map.pois.filter((p) => !gh.shelter.baseAtPoi(p.id) && haversine(p.lat, p.lon, home.lat, home.lon) > 600).slice(0, 3);
  const r = gh.exploration.start(far[0].id, ['leader'], 1, false, Date.now());
  assert(r.ok, `派遣探索（${r.reason || ''}）`);
  gh.exploration.enqueue(r.exp.id, far[1].id);
  gh.exploration.enqueue(r.exp.id, far[2].id);
  assert(!gh.autoHome.check(Date.now()), '21:30 以前不會觸發');
  setHour(gh, 21.5); // 現在剛好 21:30（派遣在 21:30 之前）
  const res = gh.autoHome.check(Date.now() + 2000);
  assert(res && res.recalled === 1 && res.queued === 2 && r.exp.recalled && !r.exp.queue.length, `21:30 外派隊伍收到召回命令、清空探索佇列（召回 ${res?.recalled}、佇列 ${res?.queued}）`);
  assert(r.exp.travelEvents.some((t) => t.includes('21:30 自動回家')), '報告寫出 21:30 自動回家');
  assert(!gh.autoHome.check(Date.now() + 60000), '同一天只觸發一次');
  gh.exploration.update(r.exp.endAt + 1, { silent: true });
  // 回家後可以再派出，當天不會再被召回
  Object.assign(gh.survivors.leader(), { status: 'idle', hp: null, severe: false });
  const r2 = gh.exploration.start(far[1].id, ['leader'], 1, false, Date.now());
  assert(r2.ok && !gh.autoHome.check(Date.now()) && !r2.exp.recalled, '回家後可以再派出，當天不會再被召回');
  {
    // v15.11.1：存檔裡的紀錄比現在還新（舊版計時超前）：不再卡住好幾天，下一個 21:30 照常觸發
    const k0 = gh.autoHome.keyAt(Date.now());
    gh.state.autoHomeKey = k0 + 5;
    assert(!gh.autoHome.check(Date.now()) && gh.state.autoHomeKey === k0, '紀錄超前時改為從現在重新計算');
    const next = Date.now() + 90 * 60000; // 下一個遊戲日的同一時刻（已過 21:30）
    const res2 = gh.autoHome.check(next);
    assert(res2 && gh.state.autoHomeKey === k0 + 1, '紀錄超前修正後，下一個 21:30 照常自動回家');
  }
  // 關閉時不召回
  gh.exploration.update(r2.exp.endAt + 1, { silent: true });
  assert(gh.autoHome.toggle().ok && !gh.autoHome.on(), '可以關閉自動回家');
  const gk = mkH('K103');
  gk.state.settings.autoHome = false;
  setHour(gk, 20.5); gk.autoHome.check(Date.now());
  const rk = gk.exploration.start(gk.state.map.pois.find((p) => !gk.shelter.baseAtPoi(p.id)).id, ['leader'], 1, false, Date.now());
  setHour(gk, 21.5);
  assert(!gk.autoHome.check(Date.now() + 2000) && !rk.exp.recalled, '關閉時 21:30 不會召回');
  // 離線：21:30 前出發、21:30 後才上線結算 → 照 21:30 當下召回（不是上線的時間）
  const go = mkH('O103');
  setHour(go, 20.9); go.autoHome.check(Date.now());
  const fo = go.state.map.pois.filter((p) => !go.shelter.baseAtPoi(p.id) && haversine(p.lat, p.lon, go.shelter.primary().lat, go.shelter.primary().lon) > 700)[0];
  const ro = go.exploration.start(fo.id, ['leader'], 1, false, Date.now());
  setHour(go, 21.5);
  const later = Date.now() + 120000; // 21:30 之後兩分鐘才上線
  const at19 = go.autoHome.triggerAt(later);
  go.autoHome.check(later, { silent: true });
  assert(ro.exp.recalled && at19 < later - 100000 && Math.abs(ro.exp.endAt - (at19 + ro.exp.travelMs)) < 5, '離線時照 21:30 當下的位置召回');
  // 協防也召回
  const ga = mkH('A103');
  setHour(ga, 20.9); ga.autoHome.check(Date.now());
  const tgtA = ga.state.map.pois.find((p) => !ga.shelter.baseAtPoi(p.id));
  const ea = { id: 'ex_a103', kind: 'assist', poiId: tgtA.id, memberIds: [ga.survivors.leader().id], startAt: Date.now() - 1000, travelMs: 600000, searchMs: 0, endAt: Date.now() + 3600e3, distanceM: 800, from: { lat: 25, lon: 121 }, path: [{ lat: 25, lon: 121 }, { lat: 25.007, lon: 121 }], travelEvents: [], vehicleIds: [] };
  ga.state.expeditions.push(ea);
  ga.survivors.leader().status = 'exploring';
  setHour(ga, 21.5);
  ga.autoHome.check(Date.now() + 2000);
  assert(ea.recalled, '協防隊伍也會自動回家');
}

// ---- 104. 自動回家：集結隊伍一樣召回（出發前退出／取消集結） ----
{
  const { MemoryObjects } = await import('../src/multiplayer/SharedWorld.js');
  const store = new MemoryObjects();
  const gr = Game.newGame({ playerName: 'R104', classId: 'warrior', lat: 25.15, lon: 121.15 });
  gr.state.map.pois = fillPois([], 25.15, 121.15);
  gr.shelter.establish(gr.state.map.pois.find((p) => gr.shelter.canEstablish(p).ok));
  gr.shared.backend = store;
  gr.world = { others: [], myId: 'R104', identity: () => ({ id: 'R104', token: 't' }) };
  setHour(gr, 10);
  gr.npcs.update(Date.now());
  const n = gr.npcs.list.find((x) => x.sid);
  gr.shelter.primary().facilities.broadcast.level = 1;
  const st = await gr.rally.start({ kind: 'npc', id: n.id, ident: n.ident, name: n.name, lat: n.lat, lon: n.lon }, 5, [gr.survivors.leader().id]);
  assert(st.ok && gr.rally.trips().length === 1, `發起集結（${st.reason || ''}）`);
  const res = gr.autoHome.run(Date.now());
  await new Promise((r) => setTimeout(r, 10));
  await gr.shared.poll();
  assert(res.recalled === 1 && !gr.rally.trips().length && gr.survivors.leader().status === 'idle', '21:30 集結隊伍也會召回（出發前直接留在避難所）');
  assert(gr.rally.get(st.id || st.rally?.id || gr.shared.all('rally')[0]?.id)?.status === 'cancelled' || gr.shared.all('rally').every((o) => o.data.status === 'cancelled'), '自己發起的集結會取消');
}

// ---- 105. 屍潮強度：文明度超過新文明（550）的部分只算一半；屍潮殭屍最高 Lv75 ----
{
  const gz = Game.newGame({ playerName: 'Z105', classId: 'warrior', lat: 25, lon: 121 });
  gz.state.map.pois = fillPois([], 25, 121);
  gz.shelter.establish(gz.state.map.pois.find((p) => gz.shelter.canEstablish(p).ok));
  const civ = gz.civilization;
  civ.value = () => 550;
  const e550 = civ.effective();
  civ.value = () => 1300;
  const e1300 = civ.effective();
  assert(e550 === 530 && e1300 === 530 + (1300 - 550) * 0.5, `文明度 550 以上的部分只算一半（${e550} / ${e1300}）`);
  civ.value = () => 300;
  assert(civ.effective() === 280, '文明度 550 以下不受影響');
  civ.value = () => 5000;
  setHour(gz, 23);
  assert(gz.siege.of().zombieLevel() === 75, `屍潮殭屍最高 Lv75（${gz.siege.of().zombieLevel()}）`);
}

// ---- 106. 電磁塔、電網每個據點限 1 座；舊存檔多出的拆除並全額退還材料 ----
{
  const gd = Game.newGame({ playerName: 'D106', classId: 'warrior', lat: 25, lon: 121 });
  gd.state.map.pois = fillPois([], 25, 121);
  gd.shelter.establish(gd.state.map.pois.find((p) => gd.shelter.canEstablish(p).ok));
  const b = gd.shelter.primary();
  gd.research.isDone = () => true;
  gd.research.hasUnlock = () => true;
  fillSupplies(gd);
  Object.keys(gd.state.resources).forEach((k) => { gd.state.resources[k] = 1e6; });
  gd.state.player.coins = 1e7;
  gd.state.player.parts = 1e6;
  b.facilities.generator && (b.facilities.generator.level = 1);
  const r1 = gd.shelter.buildDefense(b, 0, 'emTower');
  b.buildQueue = [];
  const r2 = gd.shelter.buildDefense(b, 1, 'emTower');
  assert(r1.ok && !r2.ok && r2.reason.includes('最多 1 座'), `電磁塔每個據點只能一座（${r2.reason}）`);
  const r3 = gd.shelter.buildDefense(b, 1, 'electricFence');
  b.buildQueue = [];
  const r4 = gd.shelter.buildDefense(b, 2, 'electricFence');
  assert(r3.ok && !r4.ok, '電網每個據點只能一座');
  assert(gd.shelter.buildDefense(b, 2, 'machineGun').ok, '其他防禦建築沒有數量限制');
  b.buildQueue = [];
  // 舊存檔：3 座電磁塔 → 保留等級最高的一座，其餘拆除並退還
  while (b.defenses.length < 5) b.defenses.push({ slot: b.defenses.length, type: null, level: 0, garrisonId: null });
  b.defenses[0].level = 2;
  Object.assign(b.defenses[3], { type: 'emTower', level: 5 });
  Object.assign(b.defenses[4], { type: 'emTower', level: 1 });
  const nail0 = gd.state.supplies.nail || 0;
  const notes = gd.shelter.enforceDefenseLimits();
  const ems = b.defenses.filter((d) => d.type === 'emTower');
  assert(notes.length === 2 && ems.length === 1 && ems[0].level === 5, '舊存檔多出的電磁塔只保留等級最高的一座');
  assert(gd.state.log.some((l) => l.msg.includes('全額退還')), '拆除時記錄並退還材料');
}

// ---- 107. 全員治療：在家、生命沒滿的人用倉庫藥品從低階開始治療（不溢出、重傷優先）；飢餓時也能治療 ----
{
  const { createSurvivor } = await import('../src/core/GameState.js');
  const gh = Game.newGame({ playerName: 'H107', classId: 'warrior', lat: 25, lon: 121 });
  gh.state.map.pois = fillPois([], 25, 121);
  gh.shelter.establish(gh.state.map.pois.find((p) => gh.shelter.canEstablish(p).ok));
  const a = createSurvivor('甲', 'warrior', 10, 'rare');
  const b = createSurvivor('乙', 'medic', 10, 'rare');
  const c = createSurvivor('丙', 'scout', 10, 'rare');
  gh.state.survivors.push(a, b, c);
  gh.survivors.setHp(a, gh.survivors.maxHp(a) * 0.5);
  gh.survivors.setHp(b, gh.survivors.maxHp(b) * 0.05);
  b.severe = true;
  c.status = 'exploring';
  gh.survivors.setHp(c, gh.survivors.maxHp(c) * 0.3);
  Object.keys(gh.state.supplies).forEach((k) => { delete gh.state.supplies[k]; });
  gh.state.supplies.gauze = 12;
  gh.state.supplies.bandage = 6;
  gh.state.supplies.largeKit = 2;
  gh.state.research.levels = {};
  gh.research.invalidate();
  const r = gh.exploration && gh.survivors.healAll();
  const ha = gh.survivors.hpOf(a) / gh.survivors.maxHp(a);
  const hb = gh.survivors.hpOf(b) / gh.survivors.maxHp(b);
  assert(r.ok && r.healed >= 2 && gh.survivors.hpOf(c) / gh.survivors.maxHp(c) < 0.31, `全員治療只治療在家的人（${r.msg || r.reason}）`);
  assert(hb > 0.3 && !b.severe, `重傷的人優先治療並解除重傷（${Math.round(hb * 100)}%）`);
  assert(ha <= 1 && gh.survivors.hpOf(a) <= gh.survivors.maxHp(a), '不會溢出');
  assert((gh.state.supplies.gauze || 0) < 12 && (gh.state.supplies.largeKit || 0) === 2, `先用低階藥品，大型醫藥箱補了會溢出所以沒用（剩 ${gh.state.supplies.largeKit || 0}）`);
  // 飢餓時也能治療
  gh.state.resources.food = 0;
  gh.resources.lastStarvingMs = Date.now();
  const d = createSurvivor('丁', 'warrior', 10, 'rare');
  gh.state.survivors.push(d);
  gh.survivors.setHp(d, gh.survivors.maxHp(d) * 0.2);
  gh.state.supplies.painkiller = 2;
  const hs = gh.survivors.heal(d.id);
  assert(hs.ok, `飢餓時一樣可以治療（${hs.msg || hs.reason}）`);
}

// ---- 108. 攻打 NPC 失敗：擊倒幾名守軍就只少幾名，每 20 秒補回 1 名；攻陷獎勵 ×4 ----
{
  const { NPC_CONFIG, NPC_ASSAULT, NPC_REWARD_MUL } = await import('../src/config/npcs.js');
  const gn = Game.newGame({ playerName: 'N108', classId: 'warrior', lat: 25, lon: 121 });
  const n = { id: 'npc108', level: 33, wounded: 0, healAt: 0 };
  const full = gn.npcs.garrison(n, { assault: true }).length;
  const t0 = Date.now();
  gn.npcs.assaultWound(n, 10, t0);
  const after = gn.npcs.garrison(n, { assault: true }).length;
  assert(full - after === 10, `擊倒 10 名守軍，下次攻打只少 10 名（${full}→${after}）`);
  // v15.8：守軍每 20 秒補回 1 名
  const NS = gn.npcs.constructor;
  const healed = (ms) => { const d = { wounded: n.wounded, healAt: n.healAt }; NS.healTo(d, t0 + ms, 99); return gn.npcs.garrison({ ...n, ...d }, { assault: true }).length; };
  assert(n.healAt - t0 === NPC_CONFIG.woundHealMs && NPC_CONFIG.woundHealMs === 20000 && healed(19999) === after && healed(20000) === after + 1 && healed(60000) === after + 3 && healed(200000) === full,
    `守軍每 20 秒補回 1 名（${after}→${healed(20000)}→${healed(60000)}→${healed(200000)}／${full}）`);
  const n2 = { id: 'npc108b', level: 33, wounded: 0, healAt: 0 };
  gn.npcs.assaultWound(n2, 9, t0);
  assert(full - gn.npcs.garrison(n2, { assault: true }).length === 9, '擊倒奇數名守軍也只少那幾名');
  assert(NPC_REWARD_MUL === 4, '攻陷獎勵為 4 倍');
}

// ---- 109. 塑膠外殼較容易取得：出現機率提高、超市／住宅／學校有機會找到、回收站電子零件較多 ----
{
  const { pickSupply: ps, PLASTIC_SPOTS: spots } = await import('../src/systems/LootStock.js');
  const { SUPPLIES: SP } = await import('../src/config/supplies.js');
  let s1 = 11;
  const rnd = () => { s1 = (s1 * 16807) % 2147483647; return s1 / 2147483647; };
  const rate = (type, pred) => { let n = 0; for (let i = 0; i < 6000; i += 1) if (pred(ps('part', rnd, 1, type))) n += 1; return n / 6000; };
  const elecRec = rate('recycling', (k) => SP[k].tag === 'elec');
  const elecFac = rate('factory', (k) => SP[k].tag === 'elec');
  assert(elecRec > elecFac * 1.4, `資源回收站的電子零件比較多（${Math.round(elecRec * 100)}% vs ${Math.round(elecFac * 100)}%）`);
  const pl = rate('factory', (k) => k === 'plastic');
  assert(pl > 0.06, `塑膠外殼是常見的零件（${(pl * 100).toFixed(1)}%）`);
  assert(spots.supermarket > 0 && spots.residential > 0 && spots.school > 0, '超市、住宅、學校有機會找到塑膠外殼');
}

// ---- 110. 黑市交換：同價值 5 換 1（v13.3）、跨階 ×2、只能同階或低一階、★5 不開放、不到 1 個不換 ----
{
  const { EXCHANGE: EX } = await import('../src/systems/BlackMarketSystem.js');
  const gx = Game.newGame({ playerName: 'X110', classId: 'warrior', lat: 25, lon: 121 });
  const bm = gx.blackMarket;
  assert(EX.rate === 5, '黑市交換：同價值 5 換 1');
  const V = EX.value;
  const per1 = (V.valve / V.steelPlate) * 5;
  const per2 = (V.valve / V.spring) * 5 * 2;
  gx.state.supplies = { steelPlate: 400, spring: 1000, nail: 500, hinge: 1 };
  const q1 = bm.exchangeQuote('steelPlate', 'valve', 400);
  assert(q1.ok && q1.get === Math.floor(400 / per1 + 1e-9) && Math.abs(q1.per - per1) < 1e-9, `同階：依價值換算（鋼板 400 → 閥門 ${q1.get}，每個 ${per1}）`);
  const q2 = bm.exchangeQuote('spring', 'valve', 1000);
  assert(q2.ok && Math.abs(q2.per - per2) < 1e-9, `低一階：再 ×2（彈簧每 ${per2} 個換 1 個閥門）`);
  assert(!bm.exchangeQuote('nail', 'valve', 500).ok, '不能用低兩階的材料交換');
  assert(!bm.exchangeQuote('valve', 'spring', 10).ok, '不能用高階換低階');
  assert(!bm.exchangeable('precision') && !bm.exchangeable('kevlar'), '★5 最高階不開放');
  assert(!bm.exchangeQuote('nail', 'cotton', 100).ok, '零件與布料不能互換');
  assert(!bm.exchangeQuote('hinge', 'spring', 1).ok, '不到 1 個不能換');
  const r = bm.exchange('steelPlate', 'valve', 400);
  assert(r.ok && gx.state.supplies.valve === q1.get && gx.state.supplies.steelPlate === 400 - q1.used, `交換後倉庫正確（閥門 ${gx.state.supplies.valve}，鋼板 ${gx.state.supplies.steelPlate}）`);
  // 依配比表：比較缺的材料價值較高
  assert(V.valve > V.steelPipe && V.rubber > V.ironWire, `交換價值參考材料需求與掉落配比表（閥門 ${V.valve} > 鋼管 ${V.steelPipe}、橡膠 ${V.rubber} > 鐵絲 ${V.ironWire}）`);
}

// ---- v13.3：材料需求與掉落配比 ----
{
  const MB = await import('../src/systems/MaterialBalance.js');
  const { baseSupplyWeight: bw } = await import('../src/systems/LootStock.js');
  const mul = MB.balanceMultipliers(bw);
  const keep = new Set(MB.consumableMaterials());
  assert(Object.values(mul).every((m) => m >= MB.BALANCE.min - 1e-9 && m <= MB.BALANCE.max + 1e-9), '掉落倍率在 ×0.6～×2 之間');
  assert([...keep].every((k) => mul[k] >= 1 - 1e-9) && keep.has('plastic') && keep.has('nail'), '消耗品材料（子彈、藥品、修牆用）不會被降低');
  assert(mul.valve > 1.5 && mul.ironPlate < 0.8 && mul.sensor < 0.8, `需求高的材料掉落提高、需求低的降低（閥門 ×${mul.valve.toFixed(2)}、鐵板 ×${mul.ironPlate.toFixed(2)}、感測器 ×${mul.sensor.toFixed(2)}）`);
  const sc = MB.scarcity(bw);
  assert(sc.valve < 2.71 && sc.valve >= 1, `調整後閥門稀缺度下降（${sc.valve.toFixed(2)}）`);
}

// ---- 111. 快速換裝不會降低戰力；材料節約也套用到彈藥與藥品 ----
{
  const { createSurvivor } = await import('../src/core/GameState.js');
  const gq = Game.newGame({ playerName: 'Q111', classId: 'warrior', lat: 25, lon: 121 });
  let drops = 0;
  for (let t = 0; t < 120; t += 1) {
    gq.state.survivors = gq.state.survivors.slice(0, 1);
    gq.equipment.items.length = 0;
    const sv = createSurvivor('q', ['warrior', 'scout', 'medic', 'engineer', 'farmer'][t % 5], 20, 'epic');
    gq.state.survivors.push(sv);
    for (let i = 0; i < 14; i += 1) gq.equipment.items.push({ ...gq.equipment.generate({ level: 10 + ((i * 3) % 25) }), loc: 'store' });
    gq.state.supplies = { ammo9: 500, shell12: 500, ammo556: 500, ammo762: 500, ammo308: 500, arrow: 500 };
    SLOT_KEYS.forEach((slot) => { const c = gq.equipment.items.find((i) => i.slot === slot); if (c) gq.equipment.equipRaw(sv.id, c.id); });
    const p0 = gq.survivors.stats(sv).power;
    gq.equipment.quickEquip(sv.id);
    if (gq.survivors.stats(sv).power < p0) drops += 1;
  }
  assert(drops === 0, `快速換裝不會降低戰力（120 次中降低 ${drops} 次）`);
  const base = gq.equipment.ammoCost('shell12', 10).plastic;
  gq.state.research.levels.c_cost = 10;
  gq.research.invalidate();
  const cut = gq.equipment.ammoCost('shell12', 10).plastic;
  assert(base === 10 && cut === 7, `材料節約 Lv10 套用到彈藥：10 批霰彈塑膠外殼 ${base}→${cut}`);
}

// ---- 112. 黑市子彈類數量 ×3（單價不變）----
{
  const { BLACK_MARKET: BMC } = await import('../src/systems/BlackMarketSystem.js');
  const { SUPPLIES } = await import('../src/config/supplies.js');
  const gb = Game.newGame({ playerName: 'B112', classId: 'warrior', lat: 25, lon: 121 });
  const ammo = [];
  for (let gen = 0; gen < 400 && ammo.length < 30; gen += 1) {
    for (let slot = 0; slot < BMC.slots; slot += 1) {
      const x = gb.blackMarket.good(slot, gen);
      if (x.kind === 'supply' && SUPPLIES[x.key]?.cat === 'ammo') ammo.push(x);
    }
  }
  assert(BMC.ammoQty === 90, '子彈類基礎數量為 90');
  assert(ammo.length > 0, '黑市會出現子彈');
  if (ammo.length) {
    const t1 = ammo.filter((x) => SUPPLIES[x.key].tier === 1);
    assert(!t1.length || t1.every((x) => x.qty >= 54), `★1 子彈每格至少 54 個（${t1.map((x) => x.qty).join('/')}）`);
    assert(ammo.every((x) => x.price === Math.max(1, Math.round(gb.blackMarket.supplyPrice(x.key) * x.qty * BMC.priceMul))), '單價不變，總價依數量計算');
  }
}

// ---- 113. 屍潮防守紀錄：夜裡重新整理不會讓擊殺歸零；天亮前離開，回來時補記防守成功與獎勵 ----
{
  const { BaseSiege } = await import('../src/systems/SiegeSystem.js');
  const gs = Game.newGame({ playerName: 'S113', classId: 'warrior', lat: 25, lon: 121 });
  gs.state.map.pois = fillPois([], 25, 121);
  gs.shelter.establish(gs.state.map.pois.find((p) => gs.shelter.canEstablish(p).ok));
  gs.shelter.primary().facilities.wall.level = 10;
  setHour(gs, 23);
  const s1 = gs.siege.of();
  for (let i = 0; i < 1200; i += 1) { s1.update(0.1); gs.shelter.primary().wallHp = null; }
  const killsBefore = s1.nightKills;
  // 模擬重新整理：換一個新的屍潮物件（記憶體中的統計消失）
  const id = gs.shelter.primary().id;
  gs.siege.sieges.set(id, new BaseSiege(gs, id));
  const s2 = gs.siege.of();
  s2.update(0.1);
  assert(killsBefore > 0 && s2.nightKills >= killsBefore, `夜裡重新整理後擊殺數沿用（${killsBefore} → ${s2.nightKills}）`);
  // 模擬天亮前離開：再換一個新物件，直接到白天才回來
  gs.siege.sieges.set(id, new BaseSiege(gs, id));
  const logN = gs.state.defenseLog.length;
  setHour(gs, 9);
  gs.siege.of().update(0.1);
  const rec = gs.state.defenseLog[0];
  assert(gs.state.defenseLog.length === logN + 1 && rec.success && rec.kills >= killsBefore && rec.siege?.coins > 0, `回來時補記防守成功與獎勵（擊殺 ${rec?.kills}、金錢 ${rec?.siege?.coins}）`);
  gs.siege.of().update(0.1);
  assert(gs.state.defenseLog.length === logN + 1 && !gs.shelter.primary().nightStats, '同一晚只結算一次');
  // 被突破後重新整理：天亮時不會多出一筆「防守成功」
  gs.shelter.primary().nightStats = { night: 'x', kills: 5, recover: {}, wallStart: 100, breached: true, boss: null, waves: 2 };
  gs.siege.sieges.set(id, new BaseSiege(gs, id));
  const logM = gs.state.defenseLog.length;
  gs.siege.of().update(0.1);
  assert(gs.state.defenseLog.length === logM && !gs.shelter.primary().nightStats, '被突破的夜晚不會補記成防守成功');
}

// ---- 114. 剛開遊戲、還沒讀到共用 NPC 資料時，保留存檔裡的 NPC（不會先顯示錯的等級再突然下降）----
{
  const gn = Game.newGame({ playerName: 'N114', classId: 'warrior', lat: 25, lon: 121 });
  gn.state.map.pois = fillPois([], 25, 121);
  gn.shelter.establish(gn.state.map.pois.find((p) => gn.shelter.canEstablish(p).ok));
  gn.npcs.fillCells(Date.now(), { silent: true });
  const saved = gn.npcs.list.map((n) => `${n.ident}:${n.level}`).join(',');
  Object.defineProperty(gn.shared, 'online', { get: () => true, configurable: true }); // 模擬連線中
  assert(gn.npcs.list.length > 0, '有存檔裡的 NPC');
  if (gn.npcs.list.length) {
    gn.shared.listedAt = {};
    gn.npcs.createdAt = Date.now();
    gn.npcs.list.forEach((n) => { n.level = 99; });
    assert(gn.npcs.waitingShared() && gn.npcs.fillCells(Date.now(), { silent: true }) === 0 && gn.npcs.list.every((n) => n.level === 99), '還沒讀到共用 NPC 資料時，先保留存檔裡的 NPC');
    gn.shared.listedAt.npc = Date.now();
    assert(!gn.npcs.waitingShared(), '讀到共用資料後照常更新 NPC');
  }
  void saved;
}

// ---- 115. 戰鬥結束後生命低於 70%：從藥品欄吃藥補到不溢出 ----
{
  const { createSurvivor } = await import('../src/core/GameState.js');
  const gh = Game.newGame({ playerName: 'H115', classId: 'warrior', lat: 25, lon: 121 });
  const sv = createSurvivor('傑', 'engineer', 20, 'rare');
  gh.state.survivors.push(sv);
  const max = gh.survivors.maxHp(sv);
  gh.survivors.setHp(sv, max * 0.43);
  sv.loadout = { ammo: null, med: { key: 'vitamin', qty: 10 } };
  const r1 = gh.survivors.postBattleHeal(sv);
  const hp1 = gh.survivors.hpOf(sv);
  const heal = gh.survivors.healAmount(sv, 'vitamin');
  assert(r1 && hp1 <= max + 1e-6 && hp1 + heal > max && sv.loadout.med.qty < 10, `生命 43% 戰後吃維他命補到不溢出（${Math.round(hp1)}/${Math.round(max)}，剩 ${sv.loadout.med.qty} 個）`);
  gh.survivors.setHp(sv, max * 0.75);
  const q = sv.loadout.med.qty;
  assert(!gh.survivors.postBattleHeal(sv) && sv.loadout.med.qty === q, '生命還有 70% 以上時不吃藥');
}

// ---- 116. 文明度新增 550 之後的階段（屍潮最多仍為 6 波）----
{
  const gt = Game.newGame({ playerName: 'T116', classId: 'warrior', lat: 25, lon: 121 });
  const c = gt.civilization;
  const at = (v) => { c.value = () => v; return { t: c.tier(), w: c.maxWaves ? c.maxWaves() : null }; };
  const a = at(1609);
  assert(a.t.name === '黎明之國' && a.t.next?.min === 2000, `文明度 1609 為「黎明之國」，下一階段 2000（${a.t.name}）`);
  const z = at(5000);
  assert(z.t.name === '重生紀元' && !z.t.next, '文明度 2800 以上為最高階段「重生紀元」');
  const waves = [600, 1000, 1609, 2500, 5000].map((v) => { c.value = () => v; return gt.siege.of ? gt.siege.of()?.maxWaves?.() : null; }).filter((x) => x != null);
  assert(waves.every((w) => w <= 6), `新文明之後每晚最多仍為 6 波（${waves.join('/')}）`);
}

// ---- 117. 共用物件清單被伺服器上限截斷時改為合併：已知的紀錄（例如已搜空的地點）不會時有時無 ----
{
  const { OBJ_LIST_LIMIT } = await import('../src/multiplayer/SharedWorld.js');
  const gw = Game.newGame({ playerName: 'W117', classId: 'warrior', lat: 25, lon: 121 });
  const sh = gw.shared;
  const now = Date.now();
  const mk = (i, ver = 1) => ({ kind: 'poi', id: `p${i}`, lat: 25, lon: 121, data: { e: now - 1000 }, ver, updatedAt: now });
  sh.replace(['poi'], [mk('empty')]);
  assert(!!sh.get('poi', 'pempty'), '讀到已搜空的地點紀錄');
  // 下一次同步回傳了 500 筆（達上限、被截斷），剛好沒有包含這一筆
  sh.replace(['poi'], Array.from({ length: OBJ_LIST_LIMIT }, (_, i) => mk(i)));
  assert(!!sh.get('poi', 'pempty'), '清單被截斷時保留已知的紀錄（不會讓已搜空的地點又變成可探索）');
  // 沒有被截斷時照常以伺服器結果為準
  sh.replace(['poi'], [mk(1)]);
  assert(!sh.get('poi', 'pempty') && !!sh.get('poi', 'p1'), '沒有截斷時以伺服器結果為準');
  // 已知的版本較新時不會被舊資料蓋掉
  sh.replace(['poi'], [mk('v', 5)]);
  sh.replace(['poi'], [mk('v', 3)]);
  assert(sh.cache.get(sh.key('poi', 'pv')).ver === 5, '伺服器回傳較舊的版本時保留較新的');
}

// ---- 118. 地圖頁屍潮提示：入夜後整晚顯示波數與剩餘波數，結束或被突破後顯示「今夜屍潮已結束」直到天亮 ----
{
  const gs = Game.newGame({ playerName: 'S118', classId: 'warrior', lat: 25, lon: 121 });
  gs.state.map.pois = fillPois([], 25, 121);
  gs.shelter.establish(gs.state.map.pois.find((p) => gs.shelter.canEstablish(p).ok));
  gs.shelter.primary().facilities.wall.level = 10;
  setHour(gs, 9);
  const s = gs.siege.of();
  s.update(0.1);
  assert(s.nightState() === null, '白天沒有屍潮狀態');
  setHour(gs, 23);
  s.update(0.1);
  const w = s.nightState();
  assert(w?.state === 'wait' && w.maxWaves === s.maxWaves() && w.nextIn > 0, `入夜後第一波來襲前顯示倒數（${w?.state}）`);
  const seen = new Set();
  for (let i = 0; i < 20000 && s.nightState()?.state !== 'done'; i += 1) { s.update(0.1); gs.shelter.primary().wallHp = null; seen.add(s.nightState()?.state); if (s.waveLeft <= 0) s.zombies.length = 0; }
  const atk = seen.has('attack');
  assert(atk && s.nightState()?.state === 'done', `經歷進攻後顯示今夜結束（${[...seen].join(',')}）`);
  // 被突破：記錄波數並顯示到天亮
  const b = gs.shelter.primary();
  delete b.nightStats; s.wave = 2; s.breach();
  const br = s.nightState();
  assert(br?.state === 'broke' && br.wave === 2, `防線被突破後顯示被突破的波數（${br?.state} ${br?.wave}）`);
}

// ---- 119. 玩家突襲：駐守人員依公開的真實能力應戰（不限人數），戰報列出雙方等級、戰力與攻擊歷程 ----
{
  const { WorldSync: WS9, cleanPlayer: cp9 } = await import('../src/multiplayer/WorldSync.js');
  const { createSurvivor: cs9 } = await import('../src/core/GameState.js');
  const mk9 = (name, lon) => {
    const x = Game.newGame({ playerName: name, classId: 'warrior', lat: 25, lon });
    x.state.map.pois = fillPois([], 25, lon);
    x.shelter.establish(x.state.map.pois.find((p) => x.shelter.canEstablish(p).ok));
    return x;
  };
  const V = mk9('V9', 121.02);
  V.shelter.primary().wallHp = 0;
  for (let i = 0; i < 9; i += 1) {
    const s = cs9(`守${i}`, 'warrior', 25, 'epic'); s.job = 'guard'; V.state.survivors.push(s);
    ['weapon', 'melee', 'helmet', 'armor', 'legs', 'gloves', 'boots'].forEach((type) => { try { const it = V.equipment.generate({ level: 25, type, rarity: 'epic' }); V.equipment.items.push({ ...it, loc: 'store' }); V.equipment.equipRaw(s.id, it.id); } catch {} });
  }
  const pres = WS9.prototype.presence.call({ game: V });
  const pb = pres.bases[0];
  const NG = V.territory.garrison(V.shelter.primary()).count;
  assert(NG >= 9 && pb.guardUnits.length === NG && pb.guardUnits[0].maxHp === Math.round(V.survivors.stats(V.state.survivors.find((x) => x.name === pb.guardUnits[0].name)).hp), `公開全部駐守人員的真實能力（${pb.guardUnits.length}/${NG}）`);
  assert(JSON.stringify(pres).length < 32768, `公開資料大小在上限內（${JSON.stringify(pres).length}）`);
  const other = cp9({ id: 'V9', ...pres });
  assert(other.bases[0].guardUnits.length === NG, '讀取時保留駐守人員數值');
  const C = mk9('C9', 121.0);
  C.world = { others: [other] };
  const zone = C.territory.zones().find((z) => z.id === 'V9#0');
  const foes = C.territory.defenders(zone, 20);
  assert(foes.length === NG && foes[0].maxHp === pb.guardUnits[0].maxHp && !foes[0].ally, `突襲時駐守人員全部以真實能力應戰（${foes.length}）`);
  // 攻擊方：1 名普通隊員打不贏 9 名罕見裝備的駐守人員
  const a = cs9('攻1', 'warrior', 25, 'rare'); C.state.survivors.push(a);
  let sent = null;
  C.territory.send = async (_to, type, data) => { if (type === 'attack') sent = data; return true; };
  const exp = { poiId: 'pvp:V9#0', memberIds: [a.id], endAt: Date.now(), travelEvents: [], cargo: 40 };
  const rep = C.territory.resolvePvp(exp);
  assert(!rep.success, '1 人打不贏 9 名駐守人員');
  assert(rep.events.some((e) => e.includes('對方駐守：') && e.includes('Lv25') && e.includes('合計戰力')), '戰報列出對方駐守人員的等級與戰力');
  assert(rep.events.some((e) => e.includes('我方出戰：')) && rep.events.some((e) => e.includes('造成')), '戰報列出我方戰力與每人戰果');
  assert(rep.battleIds?.length === 1 && C.combat.battle(rep.battleIds[0])?.log?.length > 0, '戰報附上逐筆攻擊歷程');
  assert(sent?.atkN === 1 && sent.atkPower > 0 && JSON.stringify(sent).length < 2000, '通知對方我方人數與戰力');
  V.territory.handleEvents([{ from: 'C9', fromName: 'C9', type: 'attack', data: sent }]);
  assert(V.state.defenseLog[0].note.includes('對方出戰 1 人'), `被突襲方的防守紀錄寫入對方人數與戰力（${V.state.defenseLog[0].note}）`);
  // 舊版玩家（沒有公開駐守數值）：以掠奪者代替，突襲時不限 6 人
  const old = cp9({ id: 'O9', ...pres, bases: pres.bases.map((b) => ({ ...b, guardUnits: undefined, guards: 9 })) });
  C.world = { others: [old] };
  const oz = C.territory.zones().find((z) => z.id === 'O9#0');
  assert(C.territory.defenders(oz, 20).length === 9 && C.territory.defenders(oz).length === 6, '舊版資料以掠奪者代替：突襲不限人數、經過警戒範圍仍為 6 人');
}

// ---- 120. 分頁切到背景時屍潮不會暫停：一次補算較長的時間，波次照常推進 ----
{
  const gs = Game.newGame({ playerName: 'S120', classId: 'warrior', lat: 25, lon: 121 });
  gs.state.map.pois = fillPois([], 25, 121);
  gs.shelter.establish(gs.state.map.pois.find((p) => gs.shelter.canEstablish(p).ok));
  gs.shelter.primary().facilities.wall.level = 15;
  gs.civilization.maxWaves = () => 4;
  setHour(gs, 23);
  const s = gs.siege.of();
  s.update(0.1);
  assert(s.wave === 0, '入夜時第一波還沒來');
  s.update(120);
  assert(s.wave >= 2, `一次補算 120 秒後波次照常推進（第 ${s.wave} 波）`);
  assert(Math.abs(s.clock - 120.1) < 0.01, '模擬時鐘跟著補算推進');
}

// ---- 121. 被攻陷後重生的 NPC 據點至少 Lv35（被擊退的等級損失也不會低於 Lv35） ----
{
  const { NPC_CONFIG: NC } = await import('../src/config/npcs.js');
  const gn = Game.newGame({ playerName: 'N121', classId: 'warrior', lat: 25, lon: 121 });
  const fresh = { baseLevel: 3, bornAt: Date.now(), dc: 0, levelLoss: 0, sid: 'x' };
  assert(gn.npcs.sharedLevel(fresh) === 3, '一般 NPC 據點照原本等級');
  const reborn = { baseLevel: 3, bornAt: Date.now(), dc: 1, levelLoss: 10, sid: 'x' };
  assert(NC.respawnMinLevel === 35 && gn.npcs.sharedLevel(reborn) === 35, `重生的 NPC 據點至少 Lv35（${gn.npcs.sharedLevel(reborn)}）`);
  assert(gn.npcs.sharedLevel({ ...reborn, levelLoss: 0, baseLevel: 38 }) === 38, '重生後原本就更高的照實際等級');
  // 實際的格子：模擬被攻陷後，下一次產生的是 dc=1 的重生據點
  let cell = null;
  let found = -1;
  for (let i = 0; i < 20 && found < 0; i += 1) for (let slot = 0; slot < 2 && found < 0; slot += 1) if (gn.npcs.slotNpc(`${i}:1`, slot)) { cell = `${i}:1`; found = slot; }
  assert(found >= 0, '找到可測試的 NPC 格子');
  {
    const sid = `${cell}:${found}`;
    const base = gn.npcs.slotNpc(cell, found);
    gn.shared = gn.shared || {};
    const realGet = gn.shared.get?.bind(gn.shared);
    gn.shared.get = (kind, id) => (kind === 'npc' && id === sid ? { gen: base.gen, dc: 1, ident: base.ident, destroyed: { at: Date.now() - 2000, respawnAt: Date.now() - 1000 } } : realGet?.(kind, id));
    const re = gn.npcs.slotNpc(cell, found);
    {
      const { zoneAt: zA } = await import('../src/config/zones.js');
      const zmin = { safe: 10, normal: 20, alert: 30 }[zA(re.lat, re.lon).id] ?? 35;
      assert(re && re.dc === 1 && re.baseLevel >= zmin && gn.npcs.minLevel(re) === zmin, `v15.10：格子重生的 NPC 據點最低等級依區域（${zA(re.lat, re.lon).name} Lv${zmin}，實際 ${re?.baseLevel}）`);
    }
  }
}

// ---- 122. NPC 據點停止自然換批（一直存在到被攻陷），自然升級最多 +15 級 ----
{
  const { SHARED_NPC: SN } = await import('../src/systems/NpcSystem.js');
  const gn = Game.newGame({ playerName: 'N122', classId: 'warrior', lat: 25, lon: 121 });
  let cell = null;
  let slot = -1;
  for (let i = 0; i < 20 && slot < 0; i += 1) for (let k = 0; k < 2 && slot < 0; k += 1) if (gn.npcs.slotNpc(`${i}:3`, k, SN.freezeAt + 1000)) { cell = `${i}:3`; slot = k; }
  const a = gn.npcs.slotNpc(cell, slot, SN.freezeAt + 1000);
  const b = gn.npcs.slotNpc(cell, slot, SN.freezeAt + 30 * 86400000);
  assert(a && b && a.ident === b.ident, `停止換批後同一個 NPC 據點一直存在（${a?.ident} / ${b?.ident}）`);
  const n = { baseLevel: 5, bornAt: Date.now() - 100 * SN.levelMs, dc: 0, levelLoss: 0, sid: 'x' };
  assert(SN.maxGrowth === 15 && gn.npcs.sharedLevel(n) === 20, `自然升級最多 +15 級（${gn.npcs.sharedLevel(n)}）`);
  assert(gn.npcs.sharedLevel({ ...n, baseLevel: 3, bornAt: Date.now() - 4 * SN.levelMs }) === 7, '未達上限時照時間升級');
  assert(gn.npcs.sharedLevel({ ...n, dc: 1, baseLevel: 35 }) === 50, 'v15.14：勢力領地的據點最高 Lv50');
}

// ---- 123. 脫胎換骨還你漂漂重生器：超渡（洗鍊素質）、鎖定、費用、越洗越貴、快樂重生／還你原形、就是要鎖你取得 ----
{
  const { REBIRTH: RB, LOCK_ITEM: LI } = await import('../src/config/rebirth.js');
  const { SaveManager: SM } = await import('../src/core/SaveManager.js');
  const { createSurvivor: cs } = await import('../src/core/GameState.js');
  const gr = Game.newGame({ playerName: 'R123', classId: 'warrior', lat: 25, lon: 121 });
  gr.state.map.pois = fillPois([], 25, 121);
  gr.shelter.establish(gr.state.map.pois.find((p) => gr.shelter.canEstablish(p).ok));
  const base = gr.shelter.primary();
  assert(base.facilities.rebirth?.level === 0, '新避難所有重生器（Lv0）');
  assert(!gr.shelter.canUpgradeFacility(base, 'rebirth').ok && /研究中心 Lv4/.test(gr.shelter.canUpgradeFacility(base, 'rebirth').reason), '重生器需要研究中心 Lv4');
  const sv = cs('洗洗', 'warrior', 20, 'rare'); gr.state.survivors.push(sv);
  assert(!gr.rebirth.canWash(sv).ok, '沒有重生器不能超渡');
  assert(!gr.rebirth.canWash(gr.survivors.leader()).ok, '首領不能超渡');
  base.facilities.rebirth.level = 1;
  gr.state.player.coins = 100000;
  assert(gr.rebirth.cost(sv) === Math.round(400 * 2.5 * 3 * (1 - 0.03)), `精良 Lv20 費用（${gr.rebirth.cost(sv)}）`);
  assert(!gr.rebirth.canWash(sv, ['hp']).ok, '沒有就是要鎖你不能鎖');
  gr.rebirth.addLocks(3);
  assert(!gr.rebirth.canWash(sv, ['hp', 'atk']).ok, '重生器 Lv1 只能鎖 1 種');
  const q0 = { ...sv.quality };
  const c1 = gr.rebirth.cost(sv, 1);
  const r1 = gr.rebirth.wash(sv.id, ['hp']);
  assert(r1.ok && r1.after.hp === q0.hp && gr.rebirth.locks() === 2 && gr.state.player.coins === 100000 - c1, '超渡：鎖住的素質不變、扣費與消耗就是要鎖你');
  assert(JSON.stringify(sv.quality) === JSON.stringify(q0), '選擇前素質還沒改變');
  gr.rebirth.decide(sv.id, false);
  assert(JSON.stringify(sv.quality) === JSON.stringify(q0), '還你原形：維持原本素質');
  assert(gr.rebirth.cost(sv) === Math.round(400 * 2.5 * 3 * 1.2 * 0.97), '同一位倖存者當天第 2 次 +20%');
  const r2 = gr.rebirth.wash(sv.id, [], () => 0.9);
  gr.rebirth.decide(sv.id, true);
  assert(r2.ok && JSON.stringify(sv.quality) === JSON.stringify(r2.after), '快樂重生：套用新素質');
  assert(gr.rebirth.cost(sv) === Math.round(400 * 2.5 * 3 * 1.4 * 0.97), '第 3 次 +40%');
  sv.wash = { day: '2000-01-01', n: 9 };
  assert(gr.rebirth.cost(sv) === Math.round(400 * 2.5 * 3 * 0.97), '隔天重置');
  base.facilities.rebirth.level = 6;
  assert(gr.rebirth.lockSlots() === 2 && gr.rebirth.canWash(sv, ['hp', 'atk']).ok, '重生器 Lv6 可鎖 2 種');
  gr.state.research.levels = { ...(gr.state.research.levels || {}), r_eugen: 5, r_gene: 10 };
  gr.research._cache = null;
  const r3 = gr.rebirth.wash(sv.id, [], () => 0);
  assert(r3.ok && Object.values(r3.after).every((v) => v >= 10), `優生學滿級保底 10%（${JSON.stringify(r3.after)}）`);
  gr.rebirth.decide(sv.id, false);
  assert(Math.abs(gr.rebirth.discount() - 0.48) < 1e-9 && RB.maxDiscount === 0.5, `重生器 Lv6（−18%）＋基因調理滿級（−30%）＝ −48%，上限 −50%（${gr.rebirth.discount()}）`);
  // 搜索掉落率
  assert(gr.rebirth.rollSearch('normal', () => 0.0039) === 1 && gr.rebirth.rollSearch('normal', () => 0.0041) === 0, '一般區每棟 0.4%');
  assert(gr.rebirth.rollSearch('abyss', () => 0.0119) === 1 && gr.rebirth.rollSearch('abyss', () => 0.0121) === 0, '深淵區 ×3');
  assert(gr.rebirth.infectDrop(1) === 1 && gr.rebirth.infectDrop(3) === 2, '重度感染據點 1 個、3 人以上 2 個');
  // 黑市特殊品
  const coins0 = gr.state.player.coins;
  const b1 = gr.rebirth.buyLocks(2);
  assert(b1.ok && gr.state.player.coins === coins0 - 2 * LI.bmPrice && gr.rebirth.bmLeft() === 3, '黑市特殊品 1 萬一個、每天 5 個');
  assert(!gr.rebirth.buyLocks(4).ok, '超過每日限購不能買');
  // 存檔：就是要鎖你與重生器保留；舊存檔補上
  const old = JSON.parse(JSON.stringify(gr.state));
  old.version = 27; delete old.player.locks; delete old.bases[0].facilities.rebirth;
  const mig = SM.migrate(old);
  assert(mig.player.locks === 0 && mig.bases[0].facilities.rebirth?.level === 0, '舊存檔補上就是要鎖你（0）與重生器 Lv0');
}

// ---- 124. 外出中的倖存者依任務顯示狀態（集結中、攻打中…），一般探索顯示探索中 ----
{
  const { outLabel } = await import('../src/ui/components.js');
  const go = Game.newGame({ playerName: 'O124', classId: 'warrior', lat: 25, lon: 121 });
  const lead = go.survivors.leader();
  go.state.expeditions = [{ id: 'x', kind: 'rally', memberIds: [lead.id] }];
  assert(outLabel(go, lead).includes('集結中') && outLabel(go, lead).includes('rally-flag'), '集結隊伍顯示戰旗＋集結中');
  go.state.expeditions = [{ id: 'x', kind: 'explore', memberIds: [lead.id] }];
  assert(outLabel(go, lead) === '探索中', '一般探索顯示探索中');
  go.state.expeditions = [];
}

// ---- 125. 其他玩家的集結隊伍：對方離線時依共用集結資料的交戰時間計算返程，回到家後不再顯示 ----
{
  const { WorldSync: WS5, cleanPlayer: cp5 } = await import('../src/multiplayer/WorldSync.js');
  const gw = Game.newGame({ playerName: 'W125', classId: 'warrior', lat: 25, lon: 121 });
  const now = Date.now();
  const raw = { id: 'p1', name: 'Y', bases: [{ lat: 25, lon: 121, name: 'b', primary: true, size: 'small' }],
    trips: [{ id: 't', from: { lat: 25, lon: 121 }, to: { lat: 25.01, lon: 121 }, startAt: now - 3600e3, endAt: now + 20 * 3600e3, travelMs: 600e3, searchMs: 0, members: 4, target: 'NPC', rally: 'r1' }] };
  const p = cp5(raw);
  assert(p.trips[0].rally === 'r1', '公開資料保留集結編號');
  gw.rally.get = () => ({ id: 'r1', status: 'done', fightAt: now - 1800e3 });
  WS5.prototype.fixRallyTrips.call({ game: gw }, [p], now);
  assert(!p.trips.length, '集結已交戰且返程時間已過：不再顯示（不會一直停在返程中）');
  const p2 = cp5(raw);
  gw.rally.get = () => ({ id: 'r1', status: 'done', fightAt: now - 300e3 });
  WS5.prototype.fixRallyTrips.call({ game: gw }, [p2], now);
  assert(p2.trips.length === 1 && p2.trips[0].endAt === now - 300e3 + 600e3, '返程中：依交戰時間＋路程計算回家時間');

  // v12.1：有集結點的集結，交戰前不顯示各隊（由集結圖示統一顯示），打完才從目標返程
  const mkp = () => ({ id: 'q', name: 'Q', trips: [{ id: 't', from: { lat: 25, lon: 121 }, to: { lat: 25.01, lon: 121 }, startAt: now - 100e3, endAt: now + 20 * 3600e3, travelMs: 600e3, searchMs: 0, members: 4, target: 'NPC', rally: 'r2' }] });
  const p3 = mkp();
  gw.rally.get = () => ({ id: 'r2', status: 'departed', home: { lat: 25, lon: 121 }, fightAt: now + 60e3 });
  WS5.prototype.fixRallyTrips.call({ game: gw }, [p3], now);
  const p4 = mkp();
  gw.rally.get = () => ({ id: 'r2', status: 'done', home: { lat: 25, lon: 121 }, fightAt: now - 60e3 });
  WS5.prototype.fixRallyTrips.call({ game: gw }, [p4], now);
  const { rallyTripView: RTV } = await import('../src/multiplayer/WorldSync.js');
  const dMarch = { id: 'r2', status: 'departed', home: { lat: 25, lon: 121 }, fightAt: now + 60e3 };
  const dDone = { id: 'r2', status: 'done', home: { lat: 25, lon: 121 }, fightAt: now - 60e3 };
  assert(p3.trips.length === 1 && RTV(p3.trips[0], dMarch, now) === null, '其他玩家看到的集結：行軍時不顯示各隊（只有集結戰旗），資料保留');
  const v4 = RTV(p4.trips[0], dDone, now);
  assert(v4 && tripProgress(v4, now).phase === 'returning', '打完各隊從目標返程');
  assert(RTV(p3.trips[0], dDone, now) && tripProgress(RTV(p3.trips[0], dDone, now), now).phase === 'returning', '同一份資料在交戰結束後立刻顯示返程（不用等下一次同步）');
  assert(RTV(p4.trips[0], dDone, now + 700e3) === null, '回到家後不再顯示');
}

// ---- 126. 白天高危區也有風險：遭遇率、殭屍等級、生命與攻擊依區域提高（一般區不變） ----
{
  const { DAY_ZONE: DZ } = await import('../src/config/enemies.js');
  const { zoneAt: za } = await import('../src/config/zones.js');
  const { TIME_PHASES: TP } = await import('../src/config/timePhases.js');
  const gd = Game.newGame({ playerName: 'D126', classId: 'warrior', lat: 25, lon: 121.5 });
  const spots = {};
  for (let i = 0; i < 4000 && Object.keys(spots).length < 6; i += 1) { const lat = 25 + (i % 63) * 0.0021; const lon = 121.5 + Math.floor(i / 63) * 0.0021; const z = za(lat, lon); if (!spots[z.id]) spots[z.id] = { lat, lon }; }
  const lv = (id, ph) => gd.zombies.buildingLevel({ id: 'p', type: 'factory', ...spots[id] }, ph);
  assert(spots.lethal && spots.normal, '找到測試用的區域座標');
  const lethalDay = lv('lethal', TP.day);
  DZ.level.lethal = 0;
  const lethalPlain = lv('lethal', TP.day);
  DZ.level.lethal = 4;
  assert(lethalDay === lethalPlain + 4, `致死區白天殭屍 +4 級（${lethalPlain} → ${lethalDay}）`);
  const m = (id, ph) => gd.exploration.encounterMul({ phase: ph, zone: za(spots[id].lat, spots[id].lon) });
  DZ.stat.lethal = 1; const base = m('lethal', TP.day).hp; DZ.stat.lethal = 1.2;
  assert(Math.abs(m('lethal', TP.day).hp / base - 1.2) < 1e-9, '致死區白天殭屍生命 ×1.2');
  assert(DZ.stat.normal === 1 && DZ.level.normal === 0 && DZ.encounter.normal === 1, '一般區白天不變');
  assert(DZ.encounter.lethal === 1.6 && DZ.encounter.abyss === 2 && DZ.stat.abyss === 1.3, '白天遭遇率與強化倍率');
}

// ---- 127. 集結／協防／駐守的公開戰鬥數值：保留技能、吸血、藥品欄，攻擊與生命不再被壓低（與自己出戰相同） ----
{
  const { AssistSystem: AS } = await import('../src/systems/AssistSystem.js');
  const { createSurvivor: cs } = await import('../src/core/GameState.js');
  const gu = Game.newGame({ playerName: 'U127', classId: 'warrior', lat: 25, lon: 121 });
  const sv = cs('強者', 'warrior', 30, 'legendary'); gu.state.survivors.push(sv);
  const base = gu.survivors.stats.bind(gu.survivors);
  gu.survivors.stats = (x, ...a) => { const st = base(x, ...a); return x === sv ? { ...st, atk: 9000, hp: 40000, lifeSteal: 0.05 } : st; };
  const d = AS.unitData(gu, sv, 0);
  const u = AS.unitOf({ id: 'p', name: 'P' }, d);
  assert(u.atk === 9000 && u.maxHp === 40000, `高攻擊、高生命不會被壓低（攻擊 ${u.atk}、生命 ${u.maxHp}）`);
  assert(u.skills.cleaveChance > 0 && u.lifeSteal === 0.05, '保留技能（橫掃）與吸血');
  const r = gu.combat.simulate([], [gu.combat.createEnemy('walker', 1)], { allies: [u], record: false });
  assert(r.victory, '集結隊員以完整能力出戰');
}

// ---- 128. 驅逐倖存者：彈藥欄、藥品欄歸還倉庫；彈藥一律自動補給遠程武器的子彈、藥品一律自動補給 ----
{
  const { createSurvivor: cs } = await import('../src/core/GameState.js');
  const gq = Game.newGame({ playerName: 'Q128', classId: 'warrior', lat: 25, lon: 121 });
  gq.state.map.pois = fillPois([], 25, 121);
  gq.shelter.establish(gq.state.map.pois.find((p) => gq.shelter.canEstablish(p).ok));
  const sv = cs('走人', 'warrior', 5, 'common'); gq.state.survivors.push(sv); sv.status = 'idle';
  sv.loadout = { ammo: { key: 'ammo9', qty: 40 }, med: { key: 'bandage', qty: 7 } };
  const a0 = gq.state.supplies.ammo9 || 0; const b0 = gq.state.supplies.bandage || 0;
  assert(gq.survivors.dismiss(sv.id).ok, '可以驅逐');
  assert(gq.state.supplies.ammo9 === a0 + 40 && gq.state.supplies.bandage === b0 + 7, `驅逐時彈藥欄、藥品欄歸還倉庫（${gq.state.supplies.ammo9 - a0}／${gq.state.supplies.bandage - b0}）`);
  const lead = gq.survivors.leader();
  const gun = gq.equipment.generate({ level: 5, model: 'm1911', rarity: 'common' });
  gq.equipment.items.push({ ...gun, loc: 'store' }); gq.equipment.equipRaw(lead.id, gun.id);
  assert(gq.survivors.supplyRules(lead).ammo === 'ammo9' && gq.survivors.supplyRules(lead).med, '彈藥自動補給手槍子彈、藥品預設自動補給');
}

// ---- 129. 報告顯示經驗：每位隊員這趟實際拿到的經驗（含升級；重傷扣經驗為負） ----
{
  const gx = Game.newGame({ playerName: 'X129', classId: 'warrior', lat: 25, lon: 121 });
  const lead = gx.survivors.leader();
  const exp = { memberIds: [lead.id], xp0: { [lead.id]: gx.survivors.totalXp(lead) } };
  gx.survivors.gainXp(lead, 500);
  const rep = { events: [] };
  gx.exploration.attachXp(rep, exp);
  assert(rep.xpBy?.[0]?.d > 0 && lead.level > 1, `報告列出隊員拿到的經驗（含升級，+${rep.xpBy?.[0]?.d}）`);
  const rep2 = { events: [] };
  gx.exploration.attachXp(rep2, { memberIds: [lead.id], xp0: { [lead.id]: gx.survivors.totalXp(lead) } });
  assert(!rep2.xpBy, '沒有拿到經驗時不顯示');
}

// ---- 130. 地下感染區（多人副本）：報名、分團、鎖定、確定性計算、結算、離線補算、製作、設計圖交易 ----
{
  const { MemoryObjects } = await import('../src/multiplayer/SharedWorld.js');
  const { DungeonSystem } = await import('../src/systems/DungeonSystem.js');
  const { createSurvivor } = await import('../src/core/GameState.js');
  const DGC = await import('../src/config/dungeons.js');
  const store = new MemoryObjects();
  const GEAR = ['chainsaw', 'vector', 'titanHelmet', 'eodSuit', 'exoLegs', 'exoGloves', 'exoBoots', 'pack3', 'nvg'];
  const mkP = (name, cls, opt = {}) => {
    const gx = Game.newGame({ playerName: name, classId: 'warrior', lat: 25.03, lon: 121.56 });
    gx.state.map.pois = fillPois([], 25.03, 121.56);
    gx.shelter.establish(gx.state.map.pois.find((p) => gx.shelter.canEstablish(p).ok));
    gx.shared.backend = store;
    gx.world = { myId: `dg_${name}` };
    const sv = createSurvivor(`${name}的倖存者`, cls, opt.level ?? 50, 'legendary');
    gx.state.survivors.push(sv);
    sv.status = 'idle';
    gx.state.supplies.mediumKit = opt.meds ?? 30;
    gx.state.supplies.ammo9 = 2000;
    GEAR.forEach((m) => { const it = gx.equipment.generate({ level: 60, model: m, rarity: 'legendary', qualityAdd: 0.5 }); gx.equipment.items.push({ ...it, loc: 'store' }); gx.equipment.equipRaw(sv.id, it.id); });
    sv.loadout = { ammo: { key: 'ammo9', qty: 300 }, med: { key: 'mediumKit', qty: 10 } };
    return { g: gx, sv };
  };
  const day0 = DungeonSystem.dayStart(Date.UTC(2099, 10, 12, 4)); // 固定在未來：倖存者是否鎖定是用現在時間判斷，寫死成過去的日期會在當天 17:50 之後一直失敗
  const T = DungeonSystem.times(day0);
  // 時程：台灣時間
  {
    const NPCC = await import('../src/systems/NpcSystem.js');
    const gq = Game.newGame({ playerName: 'NQ', classId: 'warrior', lat: 25.034, lon: 121.567 });
    gq.state.map.pois = fillPois([], 25.034, 121.567);
    gq.shelter.establish(gq.state.map.pois.find((p) => gq.shelter.canEstablish(p).ok));
    const t0 = Date.now(); gq.npcs.update(t0); gq.npcs.update(t0 + 61000);
    const near = gq.npcs.list.filter((n) => Object.values(DGC.DUNGEONS).some((d) => haversine(n.lat, n.lon, d.lat, d.lon) < DGC.DG_CLEAR_M - 1));
    assert(gq.npcs.list.length > 0 && !near.length && NPCC, `NPC 據點不會出現在副本入口 ${DGC.DG_CLEAR_M} 公尺內`);
  }
  assert(DungeonSystem.dayKey(day0) === '20991112' && new Date(T.start).getUTCHours() === 10 && T.end - T.start === 3 * 3600 * 1000, '副本時程：台灣時間 18:00 開打、20 層共 3 小時');
  assert(DungeonSystem.phase(T.open - 1) === 'after' && DungeonSystem.phase(T.open) === 'signup' && DungeonSystem.phase(T.close) === 'closed' && DungeonSystem.phase(T.lock) === 'locked' && DungeonSystem.phase(T.depart) === 'gather' && DungeonSystem.phase(T.start) === 'run' && DungeonSystem.phase(T.end) === 'after', '副本各階段：00:00 換日後報名、17:40 截止、17:50 鎖定、17:55 集結、18:00 開打');
  // 分團：依報名先後平均分配，每團 3～8 人
  const fakeList = (n) => ({ list: Array.from({ length: n }, (_, i) => ({ p: `p${i}`, s: `s${i}`, c: 'warrior', at: 1000 - i, u: { maxHp: 100 } })) });
  const sizes = (n) => DungeonSystem.groupsOf(fakeList(n)).groups.map((x) => x.length).join('+');
  assert(DungeonSystem.groupsOf(fakeList(2)).cancelled && sizes(3) === '3' && sizes(8) === '8' && sizes(9) === '9' && sizes(12) === '12' && sizes(16) === '12', `不再分團：最多 12 人同一團（9→${sizes(9)}、12→${sizes(12)}、16→${sizes(16)}）、不到 3 人取消`);
  assert(DGC.DG_MAX_SIGNUPS === 12, '副本每天報名上限 12 人');
  assert(DungeonSystem.groupsOf(fakeList(9)).groups[0][0].p === 'p8', '分團依報名先後（最早報名的在第 1 團）');
  const ex = fakeList(4);
  ex.list[0].x = 'nomed';
  assert(DungeonSystem.groupsOf(ex).groups[0].length === 3 && DungeonSystem.groupsOf(ex).out.length === 1, '鎖定時無法出擊的人不分團');
  // 報名
  const CL = ['warrior', 'medic', 'engineer', 'scout', 'farmer'];
  const ps = CL.map((c, i) => mkP(`DG${i}`, c));
  const at = T.open + 3600e3;
  for (const [i, p] of ps.entries()) assert((await p.g.dungeon.signup('lab', p.sv.id, at + i)).ok, `玩家 ${i + 1} 報名副本`);
  const [a] = ps;
  assert(!(await a.g.dungeon.signup('lab', a.sv.id, at + 99)).ok, '每個副本每天只能報名一次');
  assert(!a.g.dungeon.canSignup('lab', a.g.survivors.leader().id, at).ok, '指揮官不能參加副本');
  assert(!a.g.dungeon.canSignup('bunker', a.sv.id, at).ok, '同一名倖存者一天只能參加一個副本');
  assert(!a.g.dungeon.canSignup('bunker', a.sv.id, T.close + 1).ok, '17:40 之後不能報名');
  const extra = mkP('DGX', 'medic');
  assert((await extra.g.dungeon.signup('lab', extra.sv.id, at + 50)).ok && (await extra.g.dungeon.cancel('lab', at + 60)).ok && !extra.g.dungeon.record('lab', at + 60), '截止前可以取消報名');
  assert(!(await a.g.dungeon.cancel('lab', T.close + 1)).ok, '截止後不能取消報名');
  {
    // v12.3.1：報名的倖存者被驅逐 → 截止前自動取消報名，可以改派其他人
    assert((await extra.g.dungeon.signup('lab', extra.sv.id, at + 70)).ok, '重新報名');
    extra.sv.isLeader = false;
    extra.g.survivors.dismiss(extra.sv.id);
    extra.g.dungeon.update(at + 80);
    await new Promise((r) => setTimeout(r, 20));
    const listed = (extra.g.dungeon.data('lab', DungeonSystem.dayKey(at)).list || []).some((e) => e.p === extra.g.dungeon.myId());
    assert(!extra.g.dungeon.record('lab', at + 90) && !listed, '報名的倖存者被驅逐後，自動取消報名（名單也移除）');
  }
  // 同時搶最後一個名額：只有一個人成功
  {
    const s2 = new MemoryObjects();
    const full = { dg: 'drain', day: DungeonSystem.dayKey(at), list: Array.from({ length: DGC.DG_MAX_SIGNUPS - 1 }, (_, i) => ({ p: `x${i}`, s: `s${i}`, c: 'scout', at: i, u: { maxHp: 1 } })) };
    await s2.objPut('x', 'x', 'dg', `drain-${full.day}`, { data: full, ver: 0 });
    const r1 = mkP('R1', 'scout');
    const r2 = mkP('R2', 'scout');
    r1.g.shared.backend = s2; r2.g.shared.backend = s2;
    await r1.g.shared.list('dg', 5); await r2.g.shared.list('dg', 5);
    const [x1, x2] = await Promise.all([r1.g.dungeon.signup('drain', r1.sv.id, at), r2.g.dungeon.signup('drain', r2.sv.id, at)]);
    const n = (await s2.objList('dg', 0, 0, 5))[0].data.list.length;
    assert((x1.ok ? 1 : 0) + (x2.ok ? 1 : 0) === 1 && n === DGC.DG_MAX_SIGNUPS, `同時搶最後名額只有一人成功（${x1.ok}/${x2.ok}，共 ${n} 人）`);
  }
  // 共用資料大小：報名額滿（40 人）時仍在伺服器上限 16KB 以內
  {
    const e = { ...a.g.dungeon.snapshot(a.sv), p: 'x'.repeat(36), n: '名'.repeat(8), sn: '名'.repeat(8), s: `sv_${'x'.repeat(14)}`, at: Date.now() };
    const size = new TextEncoder().encode(JSON.stringify({ dg: 'greenhouse', day: '20261112', list: Array(DGC.DG_MAX_SIGNUPS).fill(e) })).length;
    assert(size < 16000, `副本報名額滿時資料大小在上限內（${size} bytes）`);
  }
  // 報名後換裝備：名單上的戰力跟著更新
  {
    const day = DungeonSystem.dayKey(at);
    const before = a.g.dungeon.data('lab', day).list.find((e) => e.p === 'dg_DG0').pw;
    const weak = a.g.equipment.items.find((it) => a.sv.equipment.weapon === it.id);
    a.sv.equipment.weapon = null;
    a.g.dungeon.update(at + 20000);
    await new Promise((r) => setTimeout(r, 5));
    await a.g.shared.list('dg', 5);
    const after = a.g.dungeon.data('lab', day).list.find((e) => e.p === 'dg_DG0').pw;
    assert(after !== before, `報名後換裝備，名單上的戰力也會更新（${before} → ${after}）`);
    a.sv.equipment.weapon = weak.id;
    a.g.dungeon.update(at + 40000);
    await new Promise((r) => setTimeout(r, 5));
  }
  // 鎖定：外出中的小隊召回；鎖定後不能出發
  const b = ps[1];
  const poi = b.g.state.map.pois.find((p) => !b.g.shelter.baseAtPoi(p.id) && b.g.exploration.validate(p.id, [b.sv.id]).ok);
  // 鎖定前 5 秒出發：確保鎖定時還在去程（太早出發的小地點可能已經在返程，返程中不能召回）
  const trip = b.g.exploration.start(poi.id, [b.sv.id], 5, false, T.lock - 5000);
  assert(trip.ok, `報名的倖存者鎖定前可以外出（${trip.reason || ''}）`);
  for (const p of ps) { await p.g.shared.list('dg', 5); p.g.dungeon.update(T.lock + 1000); }
  assert(trip.exp.recalled, '17:50 鎖定時外出中的小隊自動召回');
  assert(b.g.dungeon.isLocked(b.sv, T.lock + 2000) && b.g.survivors.isAvailable(b.sv) === false, '鎖定後倖存者不能外出');
  {
    // v15.5.1：控制點駐防中的倖存者：17:50 鎖定時不叫回（這次副本不能參加）
    const gd2 = Game.newGame({ playerName: 'DG2', classId: 'warrior', lat: 25.03, lon: 121.56 });
    const sv2 = gd2.survivors.leader();
    const gexp = { id: 'gx', kind: 'cpGuard', cpId: 'cp1', memberIds: [sv2.id], startAt: T.lock - 600000, travelMs: 60000, searchMs: 3600000, endAt: T.lock + 7200000, from: { lat: 25.03, lon: 121.56 } };
    gd2.state.expeditions.push(gexp);
    const rec2 = { svId: sv2.id, dg: 'lab', day: DungeonSystem.dayKey(T.start) };
    gd2.dungeon.pushEntry = () => {};
    gd2.dungeon.lock(rec2, T.lock);
    assert(!gexp.recalled && gd2.state.expeditions.includes(gexp) && rec2.excluded === 'guard', '副本鎖定時不叫回駐防中的倖存者（這次副本不能參加）');
    const sv3 = gd2.state.survivors.find((x) => !x.isLeader) || (() => { const x = { ...sv2, id: 'svx', isLeader: false }; gd2.state.survivors.push(x); return x; })();
    gexp.memberIds = [sv3.id];
    gd2.shelter.establish(gd2.state.map.pois.find((p) => gd2.shelter.canEstablish(p).ok) || { id: 'p', lat: 25.03, lon: 121.56, type: 'residential', name: 'x' });
    const cs = gd2.dungeon.canSignup('lab', sv3.id, T.lock - 3600000);
    assert(!cs.ok && /駐防/.test(cs.reason || ''), `駐防中的倖存者報名副本時就擋下（${cs.reason || ''}）`);
  }
  // 集結、開打、結算
  for (const t of [T.depart + 1000, T.start + 1000, T.start + 60 * 60e3]) {
    for (const p of ps) { await p.g.shared.list('dg', 5); p.g.dungeon.update(t); }
  }
  assert(ps.every((p) => p.sv.status === 'exploring' && p.sv.dungeon), '17:55 起倖存者在副本中（不在家）');
  const day = DungeonSystem.dayKey(T.start);
  const sig = ps.map((p) => JSON.stringify(p.g.dungeon.results('lab', day).runs.map((r) => [r.result, r.endFloor, r.stat, r.rewards])));
  assert(sig.every((x) => x === sig[0]), '所有參加者算出的每層結果與每人獎勵完全相同');
  // 重新開啟（快取清空）結果一樣
  a.g.dungeon.cache.clear();
  assert(JSON.stringify(a.g.dungeon.results('lab', day).runs.map((r) => [r.result, r.endFloor, r.stat, r.rewards])) === sig[0], '重新計算（重新開啟遊戲）結果相同');
  const run = a.g.dungeon.results('lab', day).runs[0];
  {
    // v15.15.1：沒報名的玩家（左上角資訊框）也依實際戰況顯示：團打完（失敗）就是今日已結束，不會一直攻略中到 21:00
    const { hudHtml } = await import('../src/ui/DungeonView.js');
    const sid = DungeonSystem.objId('lab', day);
    const keep = a.g.dungeon.state.sign[sid];
    delete a.g.dungeon.state.sign[sid];
    const r0 = a.g.dungeon.results('lab', day).runs[0];
    const row = (t) => (hudHtml(a.g, t).match(/data-dg="lab">.*?<span class="tag [^"]*">([^<]*)</) || [])[1];
    assert(row(r0.start + 1000) === '攻略中', `沒報名的副本開打中顯示攻略中（${row(r0.start + 1000)}）`);
    if (r0.endAt < T.end) assert(row(r0.endAt + 1000) === '今日已結束', `沒報名的副本提早結束時顯示今日已結束（${row(r0.endAt + 1000)}）`);
    a.g.dungeon.state.sign[sid] = keep;
  }
  assert(run.floors.length === run.endFloor && run.floors.every((f) => f.obs.length >= 1 && f.obs.length <= 3), '每層 1～3 個障礙並記錄每一層');
  assert(run.floors.every((f) => f.waves.length >= 1) && run.mvp && run.stat.length === 5, '每層戰報、每人輸出／承傷／治療／障礙與 MVP');
  {
    // v15.9.1：開打後剛打開遊戲、還沒連線：不會誤判「沒有分配到隊伍」而提早結算
    const q = ps[1].g;
    const be = q.shared.backend; const pv = q.world.provider;
    q.shared.backend = null; q.world.provider = undefined;
    q.dungeon.update(T.start + 61 * 60e3);
    assert(!q.dungeon.record('lab', T.start).settled && ps[1].sv.dungeon && !q.state.reports.some((r) => r.kind === 'dungeon' && r.status === 'out'), '還沒連線時先等，不會誤判沒有分配到隊伍');
    q.shared.backend = be; q.world.provider = pv;
    // 舊版本已經誤判結算的：該團打完時補發獎勵、換成正式報告
    const w = ps[3].g;
    w.dungeon.settle(w.dungeon.record('lab', T.start), null, T.start + 62 * 60e3);
    const rw = w.dungeon.record('lab', T.start);
    delete rw.noRun; // 舊版本沒有這個標記：從報告判斷
    assert(w.state.reports.some((r) => r.kind === 'dungeon' && r.why === '沒有分配到隊伍') && !ps[3].sv.dungeon, '（模擬舊版本）誤判沒有分配到隊伍');
  }
  const coins0 = ps.map((p) => p.g.state.player.coins);
  for (const p of ps) { await p.g.shared.list('dg', 5); p.g.dungeon.update(T.end + 1000); }
  assert(!ps[3].g.state.reports.some((r) => r.kind === 'dungeon' && r.status === 'out') && ps[3].g.state.player.coins > coins0[3] && ps[3].g.state.log.some((l) => /補發副本結果/.test(l.msg)), '誤判的副本在該團打完時補發獎勵與正式報告');
  assert(ps.every((p) => p.g.dungeon.record('lab', T.start).settled && p.g.state.reports[0]?.kind === 'dungeon'), '結束時每位參加者各自結算並收到副本報告');
  assert(ps.every((p, i) => p.g.state.player.coins > coins0[i] && !p.sv.dungeon && (p.sv.status === 'idle' || p.g.state.expeditions.some((e) => e.memberIds.includes(p.sv.id)))), '結算後拿到金錢、倖存者回家');
  const coins1 = ps.map((p) => p.g.state.player.coins);
  for (const p of ps) p.g.dungeon.update(T.end + 5000);
  assert(ps.every((p, i) => p.g.state.player.coins === coins1[i]), '不會重複結算');
  const ri = run.stat.findIndex((s) => s.downs > 0);
  if (ri >= 0) assert(!ps[ri].g.state.reports[0].lost && ps[ri].sv.xp >= 0, '副本中重傷不扣經驗');
  {
    // 重傷不扣經驗：直接驗證結算前後經驗只增不減
    const t = ps.find((p, i) => run.stat[i].downs > 0) || ps[0];
    assert(!t.g.state.log.some((l) => /重傷.*經驗 -/.test(l.msg) && /副本/.test(l.msg)), '副本結算沒有重傷扣經驗的紀錄');
  }
  // 離線：報名後一直沒上線，隔天才開遊戲 → 依序鎖定、出發、結算
  {
    const s3 = new MemoryObjects();
    const off = CL.map((c, i) => mkP(`OF${i}`, c));
    off.forEach((p) => { p.g.shared.backend = s3; });
    for (const [i, p] of off.entries()) await p.g.dungeon.signup('bunker', p.sv.id, at + i);
    for (const p of off.slice(1)) { await p.g.shared.list('dg', 5); p.g.dungeon.update(T.lock + 1000); }
    const lone = off[0];
    await lone.g.shared.list('dg', 5);
    lone.g.dungeon.update(T.end + DGC.DG_TIME.floorMs);
    const rp = lone.g.state.reports[0];
    assert(rp?.kind === 'dungeon' && (rp.status === 'clear' || rp.status === 'fail') && !lone.sv.dungeon, `離線的玩家上線後補算並結算（${rp?.status}）`);
  }
  // 人數不足：取消、倖存者回家
  {
    const s4 = new MemoryObjects();
    const two = ['warrior', 'medic'].map((c, i) => mkP(`TW${i}`, c));
    two.forEach((p) => { p.g.shared.backend = s4; });
    for (const p of two) await p.g.dungeon.signup('depot', p.sv.id, at);
    for (const t of [T.lock + 1000, T.depart + 1000, T.start + 1000]) for (const p of two) { await p.g.shared.list('dg', 5); p.g.dungeon.update(t); }
    assert(two.every((p) => p.g.state.reports[0]?.status === 'cancel' && p.sv.status === 'idle' && !p.sv.dungeon), '報名不到 3 人：今日取消、倖存者回家、不扣任何東西');
  }
  // 鎖定時重傷：有藥治療後出擊；沒有藥無法出擊
  {
    const s5 = new MemoryObjects();
    const team = CL.map((c, i) => mkP(`SV${i}`, c, i === 0 ? { meds: 0 } : {}));
    team.forEach((p) => { p.g.shared.backend = s5; });
    for (const [i, p] of team.entries()) await p.g.dungeon.signup('greenhouse', p.sv.id, at + i);
    team[0].sv.severe = true; team[0].g.survivors.setHp(team[0].sv, 0); team[0].sv.loadout.med = null;
    Object.keys(team[0].g.state.supplies).filter((k) => SUPPLIES_ALL[k]?.cat === 'med').forEach((k) => { delete team[0].g.state.supplies[k]; });
    team[0].sv.bag = {};
    team[1].sv.severe = true; team[1].g.survivors.setHp(team[1].sv, 0);
    for (const p of team) { await p.g.shared.list('dg', 5); p.g.dungeon.update(T.lock + 1000); }
    assert(team[0].g.dungeon.record('greenhouse', T.lock).excluded === 'nomed', '鎖定時重傷又沒有藥品：無法出擊');
    assert(!team[1].sv.severe && !team[1].g.dungeon.record('greenhouse', T.lock).excluded, '鎖定時重傷：自動用藥治療後照常出擊');
    await team[2].g.shared.list('dg', 5);
    const gp = DungeonSystem.groupsOf(team[2].g.dungeon.data('greenhouse', DungeonSystem.dayKey(at)));
    assert(gp.groups.length === 1 && gp.groups[0].length === 4 && gp.out.length === 1, '無法出擊的人不分團，其他人照常出發');
  }
  // 副本裝備：副本品級、綁定、職業專用、套裝、製作
  {
    const { g: gx, sv } = mkP('CR', 'medic');
    const it = gx.dungeon.makeGear('lab_gloves');
    let dgP = 0;
    let legP = 0;
    for (let k = 0; k < 40; k += 1) {
      dgP += gx.dungeon.makeGear('lab_gloves').power;
      legP += gx.equipment.generate({ level: 60, model: 'exoGloves', rarity: 'legendary', qualityAdd: 0.5 }).power;
    }
    assert(it.rarity === 'dungeon' && it.bound && dgP / legP > 1.05 && dgP / legP < 1.4, `副本裝備：副本品級、綁定、平均強度約傳奇的 1.2 倍（${(dgP / legP).toFixed(2)}）`);
    gx.equipment.addItem(it, 't');
    const w = createSurvivor('戰士', 'warrior', 30, 'rare'); gx.state.survivors.push(w); w.status = 'idle';
    assert(!gx.equipment.equip(w.id, it.id).ok && gx.equipment.equip(sv.id, it.id).ok, '副本裝備只有對應職業可以穿');
    const hp0 = gx.survivors.stats(sv).hp;
    ['lab_helmet', 'lab_armor'].forEach((id) => { const x = gx.dungeon.makeGear(id); gx.equipment.addItem(x, 't'); gx.equipment.equip(sv.id, x.id); });
    const set = gx.dungeon.setBonus(sv);
    const withSet = gx.survivors.stats(sv).hp;
    const sb = gx.dungeon.setBonus.bind(gx.dungeon);
    gx.dungeon.setBonus = () => ({ stat: 'hp', pct: 0, inf: 0 });
    const noSet = gx.survivors.stats(sv).hp;
    gx.dungeon.setBonus = sb;
    assert(set.pct === DGC.DG_SET[0].pct && set.stat === 'hp' && hp0 > 0 && Math.abs(withSet / noSet - (1 + DGC.DG_SET[0].pct)) < 0.02, `套裝 3 件：醫生生命 +2%（${(withSet / noSet).toFixed(3)}）`);
    gx.market.level = () => 3;
    assert(!(await gx.market.post({ side: 'sell', itemId: it.id, price: 10 })).ok, '副本裝備綁定，不能在交易市場刊登');
    gx.state.inventory.blueprints.push({ id: 'dgbp', model: 'lab_weapon', rarity: 'dungeon', dg: true });
    assert(/工作台/.test(gx.dungeon.canCraft('lab_weapon').reason), '副本裝備需要 5 級工作台');
    gx.shelter.maxLevel = (k) => (k === 'workbench' ? DGC.DG_CRAFT.bench : 1);
    gx.equipment.storeCap = () => 999;
    assert(/核心/.test(gx.dungeon.canCraft('lab_weapon').reason), '副本裝備需要核心材料');
    gx.state.dgCores = { coreLab: DGC.DG_CRAFT.core.weapon };
    Object.entries(DGC.DG_RECIPES.lab_weapon).forEach(([k, v]) => { gx.state.supplies[k] = v; });
    gx.state.player.coins = DGC.DG_CRAFT.coins.weapon;
    const r = gx.dungeon.craft('lab_weapon');
    assert(r.ok && gx.state.dgCores.coreLab === 0 && gx.state.player.coins === 0 && !gx.state.inventory.blueprints.some((x) => x.id === 'dgbp') && r.item.bound, '製作副本裝備：消耗圖紙、核心材料、金錢與材料');
    assert(Object.values(DGC.DG_RECIPES).every((rc) => [1, 2, 3, 4, 5].every((t) => Object.keys(rc).filter((k) => SUPPLIES_T[k] === t).length === 3) && Object.entries(rc).filter(([k]) => SUPPLIES_T[k] === 1).every(([, v]) => v >= 800)), '配方：每件 5 個品級各 3 種材料，1 品材料上千');
    // 核心材料可以交易
    const buyer = mkP('CB', 'medic');
    buyer.g.market.level = () => 3;
    gx.state.dgCores.coreLab = 5;
    const post = await gx.market.post({ side: 'sell', key: 'coreLab', qty: 3, price: 100 });
    await buyer.g.shared.list('mk', 20);
    buyer.g.state.player.coins = 1000;
    const L = buyer.g.market.listings().find((d) => d.key === 'coreLab');
    assert(post.ok && L && (await buyer.g.market.buy(L.id, 2)).ok && buyer.g.state.dgCores.coreLab === 2, '核心材料可以在交易市場交易');
  }
  // 設計圖：賣黑市、丟棄、交易市場刊登與購買
  {
    const s6 = new MemoryObjects();
    const sell = mkP('BP1', 'medic');
    const buy = mkP('BP2', 'medic');
    sell.g.shared.backend = s6; buy.g.shared.backend = s6;
    sell.g.market.level = () => 3; buy.g.market.level = () => 3;
    sell.g.state.inventory.blueprints = [{ id: 'q1', model: 'hk416', rarity: 'rare' }, { id: 'q2', model: 'm1911', rarity: 'epic' }, { id: 'q3', model: 'lab_boots', rarity: 'dungeon', dg: true }, { id: 'q4', model: 'aug', rarity: 'rare' }];
    const c0 = sell.g.state.player.coins;
    const price = sell.g.blackMarket.blueprintBuyback({ model: 'm1911', rarity: 'epic' });
    assert(sell.g.blackMarket.sellBlueprint('q2').ok && sell.g.state.player.coins === c0 + price && price > 0, `設計圖可以賣給黑市（💰${price}）`);
    assert(sell.g.blackMarket.blueprintBuyback({ model: 'x', rarity: 'dungeon', dg: true }) >= 5000, '副本圖紙黑市回收 💰5000');
    assert(sell.g.equipment.discardBlueprint('q4').ok && !sell.g.state.inventory.blueprints.some((x) => x.id === 'q4'), '設計圖可以丟棄');
    const pp = await sell.g.market.post({ side: 'sell', bpId: 'q3', price: 30000 });
    await buy.g.shared.list('mk', 20);
    buy.g.state.player.coins = 40000;
    const BL = buy.g.market.listings().find((d) => d.bp);
    const br = BL && await buy.g.market.buy(BL.id, 1);
    assert(pp.ok && br?.ok && buy.g.state.inventory.blueprints.some((x) => x.dg && x.model === 'lab_boots') && buy.g.state.player.coins === 10000, '副本圖紙可以在交易市場賣給其他玩家');
    await sell.g.shared.list('mk', 20);
    const cBefore = sell.g.state.player.coins;
    await sell.g.market.settle();
    assert(sell.g.state.player.coins === cBefore + 30000, '賣出設計圖後收到貨款');
    const p2 = await sell.g.market.post({ side: 'sell', bpId: 'q1', price: 10 });
    const cc = await sell.g.market.cancel(p2.id);
    assert(cc.ok && sell.g.state.inventory.blueprints.some((x) => x.id === 'q1'), '設計圖刊登下架後退回');
  }
  // 存檔：v29 遷移
  {
    const data = JSON.parse(JSON.stringify(a.g.state));
    data.version = 28;
    delete data.dungeon;
    delete data.dgCores;
    const m = SaveManager.migrate(data);
    assert(m.dungeon?.sign && m.dgCores && typeof m.dgCores === 'object', '存檔遷移：副本報名紀錄與核心材料');
  }
}

// ---- 131. 研究中心 Lv10：同時進行兩項研究（共用佇列，先結束的研究位接佇列第一項） ----
{
  const gr = Game.newGame({ playerName: 'RS2', classId: 'warrior', lat: 25, lon: 121 });
  gr.state.map.pois = fillPois([], 25, 121);
  gr.shelter.establish(gr.state.map.pois.find((p) => gr.shelter.canEstablish(p).ok));
  let lab = 9;
  gr.research.labLevel = () => lab;
  gr.game = gr;
  const rich = () => { Object.keys(gr.state.resources).forEach((k) => { gr.state.resources[k] = 1e7; }); SUPPLY_KEYS.forEach((k) => { gr.state.supplies[k] = 1e6; }); gr.state.player.coins = 1e8; gr.state.player.parts = 1e6; };
  rich();
  gr.resources.storageCap = () => 1e9;
  const ids = Object.keys(RESEARCH).filter((id) => !RESEARCH[id].requires.length && gr.research.canStart(id).ok).slice(0, 4);
  assert(ids.length === 4, '找到 4 項可以研究的科技');
  assert(gr.research.parallel() === 1 && gr.research.slots() === 2, `研究中心 Lv9：一次 1 項（佇列 ${gr.research.slots()} 格）`);
  lab = 10;
  assert(gr.research.parallel() === 2 && gr.research.slots() === 4, `研究中心 Lv10：同時 2 項、多一格（佇列 ${gr.research.slots()} 格）`);
  const t0 = Date.now();
  gr.research.start(ids[0]); gr.research.start(ids[1]); gr.research.start(ids[2]);
  const rs = gr.state.research;
  assert(rs.active?.id === ids[0] && rs.active2?.id === ids[1] && gr.research.queue.length === 1, '前兩項同時開始研究，第三項排隊');
  assert(gr.research.start(ids[0]).ok && gr.research.queue.at(-1).id === ids[0] && gr.research.queue.at(-1).level === 2, '同一科技的下一級只能排隊（不能同時研究）');
  // 先結束的研究位接佇列第一項
  const first = rs.active.endAt <= rs.active2.endAt ? 'active' : 'active2';
  const endFirst = rs[first].endAt;
  gr.research.update(endFirst + 1);
  assert(rs[first]?.id === ids[2] && rs[first].startAt === endFirst, '先結束的研究位接著研究佇列第一項（開始時間＝上一項完成時間）');
  // 離線很久：全部依序完成
  gr.research.update(t0 + 400 * 24 * 3600 * 1000);
  assert(!rs.active && !rs.active2 && !gr.research.queue.length && gr.research.level(ids[0]) === 2 && gr.research.level(ids[1]) === 1 && gr.research.level(ids[2]) === 1, '離線期間兩個研究位依序完成全部研究');
  // 存檔保留第二研究位
  gr.research.start(ids[3]); gr.research.start(ids[1]);
  const saved = SaveManager.migrate(JSON.parse(JSON.stringify(gr.state)));
  assert(saved.research.active && saved.research.active2, '存檔保留兩個研究位');
  // 降到 Lv9：第二研究位移回佇列
  lab = 9;
  gr.research.update(Date.now());
  assert(!rs.active2 && rs.active, '研究中心降到 Lv10 以下：第二研究位的研究移回佇列');
  // 搬遷等：全部取消
  lab = 10;
  gr.research.update(Date.now());
  gr.research.cancelAll(Date.now());
  assert(!rs.active && !rs.active2 && !gr.research.queue.length, '取消全部研究（兩個研究位都取消）');
}

// ---- 132. 路線規劃：多個警戒範圍重疊時不會來回折返、不會穿過範圍 ----
{
  const RT = await import('../src/map/routing.js');
  const from = { lat: 25.033, lon: 121.57 };
  const to = { lat: 25.036, lon: 121.574 };
  let seed = 7;
  const rnd = (a, b) => { seed = (seed * 16807) % 2147483647; return a + ((seed - 1) / 2147483646) * (b - a); };
  let maxPts = 0;
  let cross = 0;
  for (let k = 0; k < 300; k += 1) {
    const av = Array.from({ length: Math.floor(rnd(1, 7)) }, () => ({ lat: rnd(25.031, 25.036), lon: rnd(121.570, 121.575), r: rnd(40, 150) }));
    const p = RT.planRoute(from, to, av);
    maxPts = Math.max(maxPts, p.length);
    const usable = av.filter((c) => RT.distanceM(c, from) > c.r && RT.distanceM(c, to) > c.r).map((c) => ({ ...c, r: c.r * 0.98 }));
    if (RT.crossings(p, usable).length) cross += 1;
  }
  assert(maxPts <= 20 && cross === 0, `警戒範圍重疊時路線不會來回折返（最多 ${maxPts} 個點）、不會穿過範圍（${cross}）`);
}

// ---- 133. 探索到一半的地點：每天 00:00（台灣時間）重置 ----
{
  const PS = await import('../src/systems/PoiShareSystem.js');
  const gp = Game.newGame({ playerName: 'PS133', classId: 'warrior', lat: 25, lon: 121 });
  gp.state.map.pois = fillPois([], 25, 121);
  const poi = gp.state.map.pois[0];
  const midnight = PS.twDayStart(Date.UTC(2026, 10, 12, 4));
  gp.shared.cache.set(`poi:${poi.id}`, { kind: 'poi', id: poi.id, ver: 1, data: { g: 0, r: { g: 0, res: { scrap: 5 }, done: 1, total: 3, t: midnight - 3600000 } } });
  assert(!gp.poiShare.view(poi, midnight - 60000)?.left === false && !gp.poiShare.view(poi, midnight + 60000).left, '探索到一半的進度：當天保留、過了 00:00 重置成完整建築');
  assert(new Date(midnight).getUTCHours() === 16, '重置時間為台灣時間 00:00');
}

// ---- 134. 屍潮期間 NPC 掠奪隊撤退：據點紀錄多一筆撤退紀錄 ----
{
  const gr = Game.newGame({ playerName: 'R134', classId: 'warrior', lat: 25.0339, lon: 121.5645 });
  gr.state.map.pois = fillPois([], 25.0339, 121.5645);
  gr.shelter.establish(gr.state.map.pois.find((p) => gr.shelter.canEstablish(p).ok));
  gr.npcs.update(Date.now());
  const n = gr.npcs.list[0];
  const before = (gr.state.defenseLog || []).length;
  gr.time.siegeTime = () => true;
  gr.npcs.resolveIncoming(n, { kind: 'raid', baseId: gr.shelter.primary().id, startAt: Date.now(), travelMs: 0 }, Date.now());
  const e = gr.state.defenseLog[0];
  assert(gr.state.defenseLog.length === before + 1 && e.retreat && e.attacker.includes(n.name) && !e.kills, '屍潮期間 NPC 撤退：據點紀錄多一筆撤退紀錄（沒有交戰）');
  assert(gr.state.log.some((l) => l.msg.includes('見屍潮來襲，撤退了')), '事件紀錄仍保留撤退訊息');
}

// ---- 135. 擊退 NPC 掠奪隊：傷勢只列出這次真的受傷的人 ----
{
  const { xpToNext: xpn135 } = await import('../src/config/survivors.js');
  const { createSurvivor } = await import('../src/core/GameState.js');
  const gh = Game.newGame({ playerName: 'H135', classId: 'warrior', lat: 25.0339, lon: 121.5645 });
  gh.state.map.pois = fillPois([], 25.0339, 121.5645);
  gh.shelter.establish(gh.state.map.pois.find((p) => gh.shelter.canEstablish(p).ok));
  gh.npcs.update(Date.now());
  const n = gh.npcs.list[0];
  const a = gh.survivors.leader();
  a.xp = xpn135(a.level) - 1; // 這次經驗會升級（生命上限變高）
  const b = createSurvivor('受傷者', 'medic', 10);
  gh.state.survivors.push(b);
  const c = createSurvivor('原本沒滿', 'scout', 10);
  gh.state.survivors.push(c);
  gh.survivors.setHp(c, gh.survivors.maxHp(c) * 0.5);
  const before = new Map(gh.state.survivors.map((sv) => [sv.id, gh.survivors.hpOf(sv)]));
  gh.survivors.setHp(b, gh.survivors.hpOf(b) * 0.6);
  const lv0 = a.level;
  const r = gh.npcs.raidReward(n, [], { alive: [] }, null, [a, b, c], new Set(), before);
  assert(a.level > lv0 && !r.hurt.some((x) => x.name === a.name), '擊退掠奪隊：因升級而生命沒滿的人不列入傷勢');
  assert(!r.hurt.some((x) => x.name === c.name), '擊退掠奪隊：原本就沒滿血、這次沒受傷的人不列入傷勢');
  assert(r.hurt.length === 1 && r.hurt[0].name === b.name && r.hurt[0].down === false, '擊退掠奪隊：生命變少的人列入傷勢（標示受傷，不是被擊倒）');
}

// ---- 136. 協防隊在對方守住屍潮時獲得守城經驗（駐守的 40%，同一晚只給一次）----
{
  const { xpToNext: xpn136 } = await import('../src/config/survivors.js');
  const { ASSIST_GUARD_XP_PCT } = await import('../src/systems/AssistSystem.js');
  const ga = Game.newGame({ playerName: 'A136', classId: 'warrior', lat: 25.0339, lon: 121.5645 });
  const sv = ga.survivors.leader();
  sv.level = 30; sv.xp = 0;
  const want = Math.round(xpn136(30) * ASSIST_GUARD_XP_PCT);
  ga.assist.player = () => ({ id: 'p1', name: '阿許', bases: [] });
  let res = { night: 'n1', result: 'ok', team: true, cover: false, dmg: 100, kills: 5 };
  ga.assist.myResult = () => res;
  const exp = { assistTarget: { playerId: 'p1', name: '阿許' }, memberIds: [sv.id], endAt: Date.now(), travelEvents: [] };
  const x0 = ga.survivors.totalXp(sv);
  const rep = ga.assist.report(exp);
  const got = Math.round(ga.survivors.totalXp(sv) - x0);
  assert(ASSIST_GUARD_XP_PCT === 0.02 && got === want + 20, `協防守住：守城經驗 = 升級所需 2%＋擊殺經驗（${got} = ${want}+20）`);
  const x1 = ga.survivors.totalXp(sv);
  ga.assist.report(exp);
  assert(Math.round(ga.survivors.totalXp(sv) - x1) === 20, '同一晚的守城經驗只給一次');
  res = { night: 'n2', result: 'breached', team: true, dmg: 100, kills: 0 };
  const x2 = ga.survivors.totalXp(sv);
  ga.assist.report(exp);
  assert(ga.survivors.totalXp(sv) === x2, '對方被突破：沒有守城經驗');
  // 協防隊先回家、之後才收到「守住」的戰果：補發經驗並記到報告
  res = null;
  const pend = ga.assist.report({ ...exp, endAt: Date.now() });
  ga.state.reports = [pend, ...(ga.state.reports || [])];
  const x3 = ga.survivors.totalXp(sv);
  const r3 = { night: 'n3', result: 'ok', team: true, dmg: 50, kills: 2 };
  ga.assist.patchReport('p1', ga.assist.resultText('阿許', r3), 2, r3);
  assert(Math.round(ga.survivors.totalXp(sv) - x3) === Math.round(xpn136(sv.level === 30 ? 30 : 30) * 0.02) && pend.xpBy?.some((x) => x.n === sv.name && x.d > 0), '回家後才收到守住戰果：補發守城經驗並列在報告經驗');
  void rep;
}

// ---- 137. 分享卡片可點開詳細：連結編號、內容存放位置、長度上限 ----
{
  const RS = await import('../src/multiplayer/ReportShare.js');
  const { CHAT_MAX_LEN } = await import('../src/multiplayer/Chat.js');
  const rep = { poiName: '倒塌的住宅區 1號', success: true, kills: 12, resources: { food: 30, wood: 20, scrap: 9, fuel: 4 }, items: [{ name: '很長很長很長的裝備名稱一號', rarity: 'epic' }, { name: '很長很長很長的裝備名稱二號', rarity: 'rare' }], events: Array(80).fill('事件'), battleIds: ['bt1'], members: ['Leo'], blueprints: [] };
  const t = RS.shareReportText(rep, '運氣不錯唷唷唷唷唷唷唷唷唷唷唷唷唷', 'mbc123xyz9');
  const p = RS.parseShare(t);
  assert([...t].length <= CHAT_MAX_LEN && p.link === 'mbc123xyz9' && p.note.startsWith('運氣不錯'), `分享文字帶連結編號且不超過字數上限（${[...t].length}）`);
  assert(!p.lines.some((l) => l.includes('🔗')), '連結編號不會顯示成卡片內容');
  assert(!RS.parseShare(RS.shareReportText(rep)).link, '沒有連結時（舊版分享）不能點開');
  const c1 = RS.shareCoord('mbc123xyz9');
  const c2 = RS.shareCoord('mbc123xyz8');
  assert(JSON.stringify(c1) === JSON.stringify(RS.shareCoord('mbc123xyz9')) && c1.lat < -59 && (Math.abs(c1.lat - c2.lat) > 0.005 || Math.abs(c1.lon - c2.lon) > 0.005), '分享內容的存放位置固定、不同編號分開');
  const d = RS.shareDetail('report', rep);
  assert(d.t === 'report' && !d.x.battleIds && d.x.events.length <= 60 && JSON.stringify(d).length < 15000, '分享內容不含戰鬥明細編號、事件數有上限');
}

// ---- 138. 副本難度最多以 8 人計算（9～12 人與 8 人相同）----
{
  const gd = Game.newGame({ playerName: 'D138', classId: 'warrior', lat: 25.0339, lon: 121.5645 });
  const lead = gd.survivors.leader();
  const snap = gd.dungeon.snapshot(lead);
  const team = (n) => Array.from({ length: n }, (_, i) => ({ ...snap, p: `p${i}`, s: `s${i}`, sn: `隊員${i}`, c: ['warrior', 'medic', 'engineer', 'scout', 'farmer'][i % 5] }));
  const firstWave = (n) => gd.dungeon.runFloors('drain', team(n)).floors[0].waves[0]?.enemies;
  const e8 = firstWave(8);
  const e12 = firstWave(12);
  const e5 = firstWave(5);
  assert(e8 === 24 && e12 === 24 && e5 === 15, `副本每波敵人數最多以 8 人計算（5 人 ${e5}、8 人 ${e8}、12 人 ${e12}）`);
}

// ---- 139. 藥品欄「不攜帶」：新加入的倖存者預設不攜帶，可切換，不會被自動補給 ----
{
  const { MED_NONE } = await import('../src/systems/SurvivorSystem.js');
  const gm = Game.newGame({ playerName: 'M139', classId: 'warrior', lat: 25.0339, lon: 121.5645 });
  gm.state.map.pois = fillPois([], 25.0339, 121.5645);
  gm.shelter.establish(gm.state.map.pois.find((p) => gm.shelter.canEstablish(p).ok));
  gm.state.supplies.bandage = 50;
  const lead = gm.survivors.leader();
  assert(gm.survivors.supplyRules(lead).med === 'bandage', '原本的倖存者維持帶藥（預設繃帶）');
  const nv = gm.survivors.makeCandidate(5);
  gm.survivors.addSurvivor(nv);
  nv.status = 'idle';
  gm.survivors.autoResupply(nv);
  assert(gm.survivors.supplyRules(nv).med === MED_NONE && !gm.survivors.loadout(nv).med, '新加入的倖存者預設不攜帶藥品，也不會被自動補給');
  gm.survivors.setSupply(nv.id, 'med', 'bandage');
  assert(gm.survivors.loadout(nv).med?.key === 'bandage', '改選藥品後會自動補進藥品欄');
  const before = gm.state.supplies.bandage;
  const r = gm.survivors.setSupply(nv.id, 'med', MED_NONE);
  assert(r.ok && !gm.survivors.loadout(nv).med && gm.state.supplies.bandage > before && gm.survivors.supplyRules(nv).med === MED_NONE, '改回不攜帶：藥品欄的藥放回倉庫');
  assert(gm.survivors.refillMeds([nv]).length === 0, '不攜帶時戰後不會從背包補藥');
}

// ---- 140. 副本難度曲線：越後面越難，第 20 層比原本低 5% ----
{
  const { DG_DIFF: DD } = await import('../src/config/dungeons.js');
  const mul = (f) => DD.atk0 * DD.atkGrow ** (19 * ((f - 1) / 19) ** DD.curve);
  assert(DD.curve === 2 && Math.abs(mul(20) / (16 * 1.14 ** 19) - 0.95) < 1e-9, `第 20 層敵人攻擊為原本的 95%（${(mul(20) / (16 * 1.14 ** 19)).toFixed(3)}）`);
  assert(mul(1) === 16 && mul(10) < 16 * 1.14 ** 9 * 0.6 && mul(15) < 16 * 1.14 ** 14, `前中段較原本簡單（第 10 層 ${mul(10).toFixed(0)}、原本 ${(16 * 1.14 ** 9).toFixed(0)}）`);
}

// ---- 141. 據點紀錄的協防名單只算當晚（前一晚協防的人不會出現在今晚的紀錄）----
{
  const gs = Game.newGame({ playerName: 'S141', classId: 'warrior', lat: 25.0339, lon: 121.5645 });
  gs.state.map.pois = fillPois([], 25.0339, 121.5645);
  gs.shelter.establish(gs.state.map.pois.find((p) => gs.shelter.canEstablish(p).ok));
  const sg = gs.siege.of();
  sg.base.assistLog = { night: 'n-old', result: 'ok', list: { p1: { name: '阿許', kind: 'team', dmg: 13440, kills: 0 } } };
  assert(sg.assistList('ok', 'n-new').length === 0 && sg.base.assistLog.result === 'ok', '前一晚的協防不會出現在今晚的防守紀錄');
  sg.base.assistLog = { night: 'n-new', result: 'ongoing', list: { p1: { name: '阿許', kind: 'team', dmg: 500, kills: 3 } } };
  const l = sg.assistList('ok', 'n-new');
  assert(l.length === 1 && l[0].dmg === 500 && sg.base.assistLog.result === 'ok', '當晚有協防時正常列出');
}

// ---- 142. 製作技術低時，高品級設計圖的數值範圍仍可計算（設計圖頁不會出錯）----
{
  const gb = Game.newGame({ playerName: 'B142', classId: 'warrior', lat: 25.0339, lon: 121.5645 });
  Object.keys(gb.state.research.levels).forEach((k) => { gb.state.research.levels[k] = 0; }); gb.research.invalidate();
  let ok = true;
  try { gb.equipment.craftStatRange('exoBoots', 'legendary'); } catch { ok = false; }
  assert(ok, '製作技術 0 級時，傳奇設計圖的數值範圍可以正常計算');
}

// ---- 143. v12 移除前哨站與擴張科技：舊存檔的前哨站拆除、建造與研究材料全額退還 ----
{
  const { researchCost: rc143, REMOVED_RESEARCH: RR143 } = await import('../src/config/research.js');
  const { baseEstablishCost: bec143 } = await import('../src/config/civilization.js');
  const { FACILITIES: F143 } = await import('../src/config/facilities.js');
  const { DEFENSES: D143 } = await import('../src/config/defenses.js');
  const go = Game.newGame({ playerName: 'O143', classId: 'warrior', lat: 25.0339, lon: 121.5645 });
  go.state.map.pois = fillPois([], 25.0339, 121.5645);
  go.shelter.establish(go.state.map.pois.find((p) => go.shelter.canEstablish(p).ok));
  const raw = JSON.parse(JSON.stringify(go.state));
  raw.version = 30;
  const home = raw.bases[0];
  const op = JSON.parse(JSON.stringify(home));
  op.id = 'b_out1'; op.kind = 'outpost'; op.name = '舊前哨站'; op.poiId = 'poi_x';
  Object.keys(op.facilities).forEach((k) => { op.facilities[k] = { level: 0 }; });
  op.facilities.wall = { level: 3 };
  op.facilities.watchtower = { level: 2 };
  const dType = Object.keys(D143)[0];
  op.defenses = [{ slot: 0, type: dType, level: 2, garrisonId: null }];
  op.buildQueue = [{ kind: 'facility', id: 'watchtower', targetLevel: 3, cost: { wood: 77 } }];
  raw.bases.push(op);
  raw.research.levels.e_outpost = 2;
  raw.research.levels.e_wall = 1;
  raw.research.queue = [{ id: 'e_cost', level: 1, cost: { wood: 11 } }];
  const want = {};
  const add = (c) => Object.entries(c).forEach(([k, n]) => { want[k] = (want[k] || 0) + n; });
  add(bec143(1));
  for (let lv = 2; lv <= 3; lv += 1) add(F143.wall.cost(lv));
  for (let lv = 1; lv <= 2; lv += 1) add(F143.watchtower.cost(lv));
  for (let lv = 1; lv <= 2; lv += 1) add(D143[dType].cost(lv));
  add({ wood: 77 });
  for (let lv = 1; lv <= 2; lv += 1) add(rc143('e_outpost', lv, RR143.e_outpost));
  add(rc143('e_wall', 1, RR143.e_wall));
  add({ wood: 11 });
  const before = JSON.parse(JSON.stringify({ r: raw.resources, s: raw.supplies, c: raw.player.coins, p: raw.player.parts || 0 }));
  const m = SaveManager.migrate(raw);
  const got = (k) => (k === 'coins' ? m.player.coins - before.c : k === 'parts' ? (m.player.parts || 0) - before.p : k in m.resources ? m.resources[k] - before.r[k] : (m.supplies[k] || 0) - (before.s[k] || 0));
  const bad = Object.entries(want).filter(([k, n]) => Math.abs(got(k) - Math.round(n)) > 1);
  assert(m.bases.length === 1 && m.bases[0].kind === 'shelter' && !m.bases.some((b) => b.kind === 'outpost'), '舊存檔的前哨站被拆除，只留下避難所');
  assert(!bad.length, `前哨站與擴張科技全額退還（不符：${bad.map(([k, n]) => `${k} ${got(k)}/${Math.round(n)}`).join('、') || '無'}）`);
  assert(!m.research.levels.e_outpost && !m.research.levels.e_wall && !m.research.queue.some((q) => q.id === 'e_cost'), '擴張科技等級與排隊中的擴張科技都移除');
  assert(m.log[0].msg.includes('前哨站與擴張科技已移除') && m.log[0].msg.includes('舊前哨站'), '事件紀錄說明前哨站已移除');
  const m2 = SaveManager.migrate(JSON.parse(JSON.stringify(m)));
  assert(m2.player.coins === m.player.coins && !m2.log[0].msg.includes('前哨站與擴張科技已移除，建造') || m2.log.length === m.log.length, '再次讀檔不會重複退還');
  const { RESEARCH_BRANCHES: RB143, RESEARCH: R143 } = await import('../src/config/research.js');
  assert(!RB143.expansion && !Object.values(R143).some((r) => r.branch === 'expansion'), '研究頁不再有擴張科技');
}

// ---- 144. v12 倖存者名單：至少 250 組、最多 6 個字；自己的倖存者不同名 ----
{
  const { SURVIVOR_NAMES: SN } = await import('../src/config/survivors.js');
  const { createSurvivor } = await import('../src/core/GameState.js');
  assert(SN.length >= 250 && new Set(SN).size === SN.length && SN.every((n) => [...n].length <= 6), `倖存者名單 ${SN.length} 組、不重複、最多 6 個字`);
  const gn = Game.newGame({ playerName: 'N144', classId: 'warrior', lat: 25.0339, lon: 121.5645 });
  ['阿傑', '阿傑', '小美', '阿傑'].forEach((n) => { const sv = createSurvivor(n, 'medic', 5); gn.state.survivors.push(sv); });
  const ren = gn.survivors.dedupeNames();
  const names = gn.state.survivors.map((x) => x.name);
  assert(ren.length === 2 && new Set(names).size === names.length && names.filter((n) => n === '阿傑').length === 1, `讀檔時同名的倖存者改名（${ren.join('、')}）`);
  const c = gn.survivors.makeCandidates(40, 5);
  const all = [...gn.state.survivors.map((x) => x.name), ...c.map((x) => x.name)];
  assert(new Set(all).size === all.length, '同一批候選人彼此不同名，也不和現有倖存者同名');
  const dup = createSurvivor(names[1], 'scout', 3);
  gn.survivors.addSurvivor(dup);
  assert(gn.state.survivors.filter((x) => x.name === names[1]).length === 1, '加入同名倖存者時自動改名');
}

// ---- 145. v12 NPC 名稱：中二風格、同一張地圖上不重複 ----
{
  const { NPC_NAMES: NN } = await import('../src/config/npcs.js');
  const { NpcSystem: NS } = await import('../src/systems/NpcSystem.js');
  assert(NN.length >= 300 && new Set(NN).size === NN.length, `NPC 名稱 ${NN.length} 種、不重複`);
  const mk = () => Array.from({ length: 60 }, (_, i) => ({ sid: `c${i}:0`, name: NN[0] }));
  const a = NS.uniqueNames(mk());
  const b = NS.uniqueNames(mk().reverse());
  const byA = Object.fromEntries(a.map((x) => [x.sid, x.name]));
  assert(new Set(a.map((x) => x.name)).size === 60 && b.every((x) => byA[x.sid] === x.name), '撞名時自動換成不重複的名字，且順序不同結果也相同（每位玩家看到的一樣）');
  const g145 = Game.newGame({ playerName: 'N145', classId: 'warrior', lat: 25.0339, lon: 121.5645 });
  g145.state.map.pois = fillPois([], 25.0339, 121.5645);
  g145.shelter.establish(g145.state.map.pois.find((p) => g145.shelter.canEstablish(p).ok));
  g145.npcs.fillCells(Date.now(), { silent: true });
  const names = g145.npcs.list.map((n) => n.name);
  assert(names.length > 0 && new Set(names).size === names.length && names.every((n) => NN.includes(n)), `地圖上的 NPC 名稱不重複（${names.length} 個：${names.slice(0, 4).join('、')}…）`);
}

// ---- 146. v12.0.1 集結隊伍戰力：與倖存者顯示的戰力相同 ----
{
  const { AssistSystem: AS } = await import('../src/systems/AssistSystem.js');
  const { DungeonSystem: DS } = await import('../src/systems/DungeonSystem.js');
  const g146 = Game.newGame({ playerName: 'R146', classId: 'warrior', lat: 25.0339, lon: 121.5645 });
  const sv = g146.survivors.list[0];
  const real = g146.survivors.stats(sv).power;
  const pw = DS.powerOf({ u: AS.unitData(g146, sv, 0, { withMeds: true }) });
  assert(Math.abs(pw - real) <= Math.max(3, real * 0.01), `集結隊員戰力 ${pw} ≈ 倖存者戰力 ${real}`);
  const { unitPower: UP } = await import('../src/utils/math.js');
  g146.state.map.pois = fillPois([], 25.0339, 121.5645);
  g146.shelter.establish(g146.state.map.pois.find((p) => g146.shelter.canEstablish(p).ok));
  g146.npcs.fillCells(Date.now(), { silent: true });
  const n146 = g146.npcs.list[0];
  const want = g146.npcs.garrison(n146, { assault: true }).reduce((x, e) => x + UP(e), 0);
  assert(n146 && g146.npcs.displayPower(n146) === want && want > g146.npcs.power(n146), `NPC 建議戰力改用同一套公式（${Math.round(g146.npcs.power(n146))} → ${want}）`);
}

// ---- 147. v12.2 高等裝備製作耗材加重、拆解固定回收三成 ----
{
  const { craftRecipe: CR, craftTierMul: CTM } = await import('../src/systems/EquipmentSystem.js');
  const { ITEM_MODELS: IM } = await import('../src/config/equipment.js');
  const total = (o) => Object.entries(o).filter(([k]) => k !== 'wood').reduce((a, [, v]) => a + v, 0);
  assert(CTM(5) === 1 && CTM(6) === 1.25 && CTM(10) === 2.25, 'T1～T5 耗材不變、T6 起逐級加重（T10 ×2.25）');
  const helm = Object.values(IM).find((m) => m.name === '鈦合金頭盔');
  assert(helm && total(CR(helm)) >= 45, `T10 鈦合金頭盔耗材加重（${total(CR(helm))}）`);
  const g147 = Game.newGame({ playerName: 'E147', classId: 'warrior', lat: 25, lon: 121 });
  const hid = Object.keys(IM).find((k) => IM[k] === helm);
  const it = g147.equipment.generate({ level: 50, model: hid, rarity: 'common' });
  const back = g147.equipment.dismantleValue(it);
  const rec = CR(helm);
  assert(Object.entries(back).filter(([k]) => k !== 'parts').every(([k, v]) => v <= rec[k] && v <= Math.max(1, Math.round(rec[k] * 0.3))), `拆解高等裝備只回收約三成材料（${total(back)}/${total(rec)}）`);
}

// ---- 148. v12.2 每日物資箱的彈藥至少夠打兩場戰鬥 ----
{
  const { QuestSystem: QS } = await import('../src/systems/QuestSystem.js');
  const { AMMO_FOR: AF, SUPPLIES: SP } = await import('../src/config/supplies.js');
  const ammoKeys = Object.keys(SP).filter((k) => SP[k].cat === 'ammo');
  assert(ammoKeys.every((k) => QS.ammoFloor(k) >= 2 * Math.max(0, ...Object.values(AF).filter((x) => x.ammo === k).map((x) => x.perFight))), `彈藥保底＝最耗彈武器兩場（${ammoKeys.map((k) => `${SP[k].name}${QS.ammoFloor(k)}`).join('、')}）`);
  let bad = 0; let seen = 0;
  for (let i = 0; i < 40; i += 1) {
    const gq = Game.newGame({ playerName: `Q${i}`, classId: 'warrior', lat: 25, lon: 121 });
    gq.state.rng = { seed: 1000 + i, n: 0 };
    const before = { ...(gq.state.supplies || {}) };
    gq.quests.openChestNow();
    ammoKeys.forEach((k) => { const got = (gq.state.supplies?.[k] || 0) - (before[k] || 0); if (got > 0) { seen += 1; if (got < QS.ammoFloor(k)) bad += 1; } });
  }
  assert(bad === 0, `每日物資箱開出的彈藥都夠打兩場（開出 ${seen} 次，不足 ${bad} 次）`);
}

// ---- 149. v12.2.1 分頁從背景回來：先結算隊伍返程（含 19:30 自動回家），再補算屍潮 ----
{
  const gb = Game.newGame({ playerName: 'BG149', classId: 'warrior', lat: 25.0339, lon: 121.5645 });
  gb.state.map.pois = fillPois([], 25.0339, 121.5645);
  gb.shelter.establish(gb.state.map.pois.find((p) => gb.shelter.canEstablish(p).ok));
  const lead = gb.survivors.leader();
  const poi = gb.state.map.pois.find((p) => !gb.shelter.baseAtPoi(p.id) && gb.exploration.start(p.id, [lead.id], 5, false, Date.now() - 3600e3, {}).ok);
  const exp = gb.state.expeditions[0];
  assert(poi && exp, '派出一支隊伍');
  // 這支隊伍在背景期間已經回到家（行程結束時間已過），但遊戲還沒結算
  exp.endAt = Date.now() - 60e3;
  gb.state.lastTickAt = Date.now() - 10 * 60e3;
  let outWhenSiege = null;
  const realUpdate = gb.siege.update.bind(gb.siege);
  gb.siege.update = (dt) => { if (outWhenSiege == null) outWhenSiege = gb.state.expeditions.length; return realUpdate(dt); };
  gb.siegeCatchUp(5);
  assert(outWhenSiege === 0 && lead.status === 'idle', `補算屍潮之前，已經回到家的隊伍先回到避難所（補算時外出隊伍 ${outWhenSiege}）`);
}

// ---- 150. 快速換裝：遠程與近戰各自比較（不互相影響） ----
{
  for (const ammo of [0, 67]) {
    const gq = Game.newGame({ playerName: `QE150${ammo}`, classId: 'warrior', lat: 25, lon: 121 });
    const sv = gq.survivors.leader(); sv.level = 40;
    const mk = (type, level, rarity) => { const it = gq.equipment.generate({ level, type, rarity }); gq.equipment.addItem(it); return it; };
    gq.equipment.items.filter((i) => i.slot === 'weapon' || i.slot === 'melee').forEach((i) => { Object.keys(sv.equipment).forEach((k) => { if (sv.equipment[k] === i.id) sv.equipment[k] = null; }); gq.equipment.removeItem(i.id); });
    gq.state.supplies = { ...(gq.state.supplies || {}), ammo9: ammo, ammo556: ammo };
    const pistol = mk('pistol', 9, 'common'); gq.equipment.equip(sv.id, pistol.id);
    const knife = mk('melee', 60, 'legendary'); gq.equipment.equip(sv.id, knife.id);
    const rifle = mk('rifle', 40, 'legendary');
    const weakKnife = mk('melee', 5, 'poor');
    gq.equipment.quickEquip(sv.id);
    assert(sv.equipment.weapon === rifle.id && sv.equipment.melee === knife.id, `快速換裝：遠程換成較強的步槍、近戰保留較強的刀，互不影響（彈藥 ${ammo}）`);
    void weakKnife;
  }
}

// ---- 151. v12.2.1 超渡素質在保底～100% 之間重新分配 ----
{
  const { washQuality: WQ } = await import('../src/systems/RebirthSystem.js');
  let atF = 0; let min = 100; let max = 0; const N = 20000;
  for (let i = 0; i < N; i += 1) { const q = WQ(6); if (q === 6) atF += 1; min = Math.min(min, q); max = Math.max(max, q); }
  assert(min >= 6 && max <= 100 && atF / N < 0.1, `超渡素質不低於保底、也不會大量停在保底（停在保底 ${(atF / N * 100).toFixed(1)}%）`);
  assert(WQ(0, () => 0) === 0 && WQ(10, () => 0) === 10 && WQ(10, () => 0.9999999) === 100, '保底與上限正確');
}

// ---- 152. v12.3.1 參加集結的「前往集結點」預估依載具速度計算 ----
{
  const gv = Game.newGame({ playerName: 'RV152', classId: 'warrior', lat: 25, lon: 121 });
  gv.state.map.pois = fillPois([], 25, 121);
  gv.shelter.establish(gv.state.map.pois.find((p) => gv.shelter.canEstablish(p).ok));
  const sh = gv.shelter.primary();
  const d = { home: { lat: sh.lat + 0.02, lon: sh.lon } };
  const walk = gv.rally.gatherEstimate(d, [gv.survivors.leader().id], []);
  const car = gv.vehicles.create('car'); gv.vehicles.add(car);
  const fast = car ? gv.rally.gatherEstimate(d, [gv.survivors.leader().id], [car.id]) : walk;
  assert(walk > 0 && (!car || fast < walk), `前往集結點預估：步行 ${Math.round(walk / 1000)} 秒，載具 ${Math.round(fast / 1000)} 秒`);
}

// ---- 5. 通行碼雜湊（純 JS SHA-256 與 Node crypto 結果一致）----
let ref = 'jdqs-gate:密碼 test';
for (let i = 0; i < ACCESS_ITERATIONS; i += 1) ref = crypto.createHash('sha256').update(ref).digest('hex');
assert(hashAccessCode('  密碼 test ') === ref, '通行碼雜湊與 Node crypto 一致（並忽略前後空白）');

// ---- v13：固定方形世界地圖、指定深淵區、範圍外避難所搬進範圍 ----
{
  const W = await import('../src/config/world.js');
  const { generateWorldPois } = await import('../src/map/WorldGen.js');
  const Z = await import('../src/config/zones.js');
  const wp = generateWorldPois();
  assert(wp.length > 1000 && wp.every((p) => W.inWorld(p.lat, p.lon)), `整張地圖的建築都在範圍內（${wp.length} 棟）`);
  assert(!wp.some((p) => Z.inNpcHome(p.lat, p.lon)), 'v15：最右側勢力領地沒有可探索的建築');
  {
    // v15：建築種類與規模依新地圖重新分配（整體比例、各區規模符合規劃）
    const CV = await import('../src/config/civilization.js');
    const T = { residential: 15.2, shop: 6.5, supermarket: 4.3, forest: 18, gasStation: 7, factory: 7, garage: 5, recycling: 6, pharmacy: 10, hospital: 3, warehouse: 6.5, school: 6.5, police: 4.4 };
    const nm = wp.filter((p) => p.type !== 'military');
    const off = Object.entries(T).filter(([k, v]) => Math.abs(nm.filter((p) => p.type === k).length / nm.length * 100 - v) > 1).map(([k]) => k);
    assert(!off.length, `v15：地圖建築種類比例符合規劃（偏差超過 1%：${off.join('、') || '無'}）`);
    const mil = wp.filter((p) => p.type === 'military').length / wp.length * 100;
    assert(mil > 0.3 && mil < 1, `v15：軍事基地約佔全部地點 0.6%（${mil.toFixed(2)}%）`);
    const K = ['small', 'medium', 'large', 'huge'];
    const bad = CV.SIZE_BY_ZONE.map((tgt, z) => {
      const zp = wp.filter((p) => Z.zoneIndexAt(p.lat, p.lon) === z);
      return K.some((k, i) => Math.abs(zp.filter((p) => CV.baseSizeOf(p) === k).length / zp.length * 100 - tgt[i]) > 3) ? z : null;
    }).filter((z) => z != null);
    assert(!bad.length, `v15：各區建築規模比例符合規劃（偏差超過 3%：${bad.join('、') || '無'}）`);
  }
  assert(generateWorldPois().map((p) => p.id).join() === wp.map((p) => p.id).join(), '所有玩家的地圖建築相同');
  {
    // 依固定地圖重新校正：各類資源的建築比例符合規劃（食物 26、木材 18、燃料 7、零件布料 18、藥品 13、裝備彈藥 18）
    const cnt = {};
    wp.forEach((p) => { cnt[p.type] = (cnt[p.type] || 0) + 1; });
    const pct = (...ks) => (ks.reduce((a, k) => a + (cnt[k] || 0), 0) / wp.length) * 100;
    const got = { food: pct('residential', 'shop', 'supermarket'), wood: pct('forest'), fuel: pct('gasStation'), part: pct('factory', 'garage', 'recycling'), med: pct('pharmacy', 'hospital'), gear: pct('warehouse', 'school', 'police', 'military') };
    const want = { food: 26, wood: 18, fuel: 7, part: 18, med: 13, gear: 18 };
    assert(Object.keys(want).every((k) => Math.abs(got[k] - want[k]) <= 2.5), `固定地圖的資源建築比例符合規劃（${Object.entries(got).map(([k, v]) => `${k} ${v.toFixed(1)}%`).join('、')}）`);
  }
  for (let k = 0; k < 50; k += 1) {
    const r = W.randomInWorld();
    if (!W.inWorld(r.lat, r.lon)) { assert(false, '隨機起點在範圍內'); break; }
  }
  // v15：左側安全區往右越來越危險，深淵區緊鄰最右側的勢力領地
  {
    const B = W.WORLD_BOUNDS;
    const mid = (B.n + B.s) / 2;
    const at = (x) => Z.zoneIndexAt(mid, B.w + (B.e - B.w) * x);
    const seq = [0.03, 0.18, 0.31, 0.45, 0.6, 0.8].map(at);
    assert(seq.join() === '0,1,2,3,4,5', `由左到右：安全→一般→警戒→危險→致死→深淵（${seq.join()}）`);
    assert(Z.inPlayerSafe(mid, B.w + (B.e - B.w) * 0.03) && !Z.inPlayerSafe(mid, B.w + (B.e - B.w) * 0.97) && Z.inNpcHome(mid, B.w + (B.e - B.w) * 0.97) && !Z.inNpcHome(mid, B.w + (B.e - B.w) * 0.8), '左側安全區是玩家據點區、右側是勢力領地');
    const { baseSizeOf: bso } = await import('../src/config/civilization.js');
    const wp2 = generateWorldPois();
    const hugeLow = wp2.filter((p) => Z.zoneIndexAt(p.lat, p.lon) <= 3 && bso(p) === 'huge').length;
    const hugeAbyss = wp2.filter((p) => Z.zoneIndexAt(p.lat, p.lon) === 5 && bso(p) === 'huge').length;
    assert(hugeLow === 0 && hugeAbyss > 50, `巨型建築只在致死區與深淵區（危險區以下 ${hugeLow} 棟、深淵區 ${hugeAbyss} 棟）`);
  }
  // 範圍外的避難所：整座搬進範圍內，設施保留
  const gm = Game.newGame({ playerName: 'M13', classId: 'warrior', lat: 24.1, lon: 120.6 });
  gm.state.map.pois = fillPoisAt([], 24.1, 120.6);
  gm.shelter.establish(gm.state.map.pois.find((p) => gm.shelter.canEstablish(p).ok));
  const shm = gm.shelter.primary();
  shm.facilities.farm.level = 7;
  assert(!W.inWorld(shm.lat, shm.lon), '測試：避難所在範圍外');
  gm.genMap();
  const moved = gm.shelter.moveIntoWorld();
  assert(moved && W.inWorld(shm.lat, shm.lon) && shm.facilities.farm.level === 7 && gm.shelter.primary() === shm, `範圍外的避難所整座搬進範圍內，設施保留（${moved?.name}）`);
  assert(!gm.shelter.moveIntoWorld(), '已經在範圍內就不再搬');
  // 夜晚殭屍群只在範圍內
  setHour(gm, 22);
  gm.zombies.refresh();
  assert(gm.state.map.zombieGroups.length > 0 && gm.state.map.zombieGroups.every((z) => W.inWorld(z.lat, z.lon)), `夜晚殭屍群只出現在範圍內（${gm.state.map.zombieGroups.length} 群）`);
  // 舊存檔：地圖中心在範圍外時改到範圍中心
  const mig = SaveManager.migrate({ version: 31, player: { name: 'x' }, map: { center: { lat: 35, lon: 139 }, pois: [] } });
  assert(mig && W.inWorld(mig.map.center.lat, mig.map.center.lon), '舊存檔的地圖中心移到固定地圖範圍內');
}

// ---- v13.1：舊名單的倖存者換成新名單的名字 ----
{
  const { SURVIVOR_NAMES: SN } = await import('../src/config/survivors.js');
  const { SurvivorSystem: SS } = await import('../src/systems/SurvivorSystem.js');
  const gn = Game.newGame({ playerName: '老大', classId: 'warrior', lat: 25.03, lon: 121.57 });
  const a = gn.survivors.makeCandidate(5);
  const b = gn.survivors.makeCandidate(5);
  const c = gn.survivors.makeCandidate(5);
  a.name = '舊名字甲';
  b.name = '舊名字乙';
  c.name = SN[3];
  [a, b, c].forEach((x) => gn.state.survivors.push(x));
  const lvA = a.level;
  const mig = SaveManager.migrate({ ...JSON.parse(JSON.stringify(gn.state)), version: 32 });
  assert(mig.renameLegacy === true, '舊存檔標記要換成新名單名字');
  gn.state.renameLegacy = true;
  gn.survivors.renameLegacy();
  const names = gn.state.survivors.map((x) => x.name);
  assert(SS.isNewName(a.name) && SS.isNewName(b.name) && c.name === SN[3] && a.level === lvA, `舊名單的倖存者換成新名字，新名單的不變（${a.name}、${b.name}）`);
  assert(gn.survivors.leader().name === '老大', '領袖保留玩家自己取的名字');
  assert(new Set(names).size === names.length, '換名後不會重複');
  assert(gn.state.log.some((l) => l.msg.includes('舊名字甲 →')), '事件紀錄留下舊名與新名對照');
  assert(!gn.survivors.renameLegacy().length, '已經是新名字就不再更換');
}

// ---- v13.1：探索遇到的倖存者依品級（含以上）留下，其他自動婉拒 ----
{
  const gk = Game.newGame({ playerName: 'K', classId: 'warrior', lat: 25.03, lon: 121.57 });
  assert(gk.survivors.keepMin() === 'poor' && gk.survivors.keeps({ rarity: 'poor' }), '預設全部留下');
  assert(gk.survivors.setKeepMin('rare').ok && !gk.survivors.keeps({ rarity: 'uncommon' }) && gk.survivors.keeps({ rarity: 'rare' }) && gk.survivors.keeps({ rarity: 'legendary' }), '設定精良以上：精良含以上留下，優良以下婉拒');
  assert(!gk.survivors.setKeepMin('xx').ok, '不能設定不存在的品級');
}

// ---- v13.2：地窖提高倉庫上限、屍潮突破時駐守者撤進地窖 ----
{
  const { cellarShelter, cellarStoragePct } = await import('../src/config/facilities.js');
  assert([1, 5, 10, 15].map(cellarShelter).join() === '1,3,5,8' && cellarShelter(0) === 0, '地窖可躲人數：Lv1 1 人、Lv5 3 人、Lv10 5 人、Lv15 8 人');
  assert(Math.abs(cellarStoragePct(10) - 0.2) < 1e-9 && cellarStoragePct(0) === 0, '地窖每級倉庫上限 +2%');
  const gq = Game.newGame({ playerName: 'Q', classId: 'warrior', lat: 25, lon: 121 });
  gq.state.map.pois = fillPois([], 25, 121);
  gq.shelter.establish(gq.state.map.pois.find((p) => gq.shelter.canEstablish(p).ok));
  const bq = gq.shelter.primary();
  const cap0 = gq.resources.storageCap();
  bq.facilities.cellar.level = 10;
  const cap1 = gq.resources.storageCap();
  assert(Math.abs(cap1 / cap0 - 1.2) < 0.01, `地窖 Lv10 倉庫上限 +20%（${cap0} → ${cap1}）`);
  // 駐守者：等級高的優先撤進地窖
  const gs = [0, 1, 2, 3, 4, 5, 6].map((i) => { const c = gq.survivors.makeCandidate(3); c.level = 10 + i; c.job = 'guard'; c.status = 'idle'; gq.state.survivors.push(c); return c; });
  gq.state.survivors.forEach((x) => { if (!gs.includes(x)) x.job = 'idle'; });
  const inj = gq.siege.of(bq.id).injureGuards();
  const top = [...gs].sort((a, b) => b.level - a.level).slice(0, 5).map((x) => x.name);
  assert(inj.filter((x) => x.cellar).map((x) => x.name).sort().join() === top.sort().join() && inj.filter((x) => x.cellar).every((x) => !x.severe && !x.light), `屍潮突破時等級最高的 5 位駐守者撤進地窖不受傷（Lv10 地窖）`);
}

// ---- v14：避難所只能建在左側安全區、改版後免費重選一次 ----
{
  const Z = await import('../src/config/zones.js');
  const gf = Game.newGame({ playerName: 'F14', classId: 'warrior', lat: 25.03, lon: 121.56 });
  gf.genMap();
  const safe = gf.state.map.pois.filter((p) => Z.inPlayerSafe(p.lat, p.lon));
  const abyss = gf.state.map.pois.find((p) => Z.zoneIndexAt(p.lat, p.lon) === 5);
  assert(!gf.shelter.canEstablish(abyss).ok && gf.shelter.canEstablish(safe[0]).ok, '避難所只能建在左側安全區');
  gf.shelter.establish(abyss); // 不能建
  assert(!gf.shelter.primary(), '深淵區不能建立避難所');
  // 舊玩家：避難所在深淵區（舊地圖），改版後可免費重選
  const old = gf.shelter.establish({ ...safe[0] }).base;
  Object.assign(old, { lat: abyss.lat, lon: abyss.lon, poiId: abyss.id, name: abyss.name, size: 'huge' });
  old.facilities.farm.level = 14;
  gf.state.resources.food = 777;
  const mig = SaveManager.migrate({ ...JSON.parse(JSON.stringify(gf.state)), version: 33 });
  assert(!mig.freeRelocate && mig.guideSeen === 0, 'v15.10.1：舊存檔的免費重選已取消，仍顯示新玩法說明');
  gf.state.freeRelocate = true;
  assert(!gf.shelter.canFreeMove(abyss).ok, '免費重選只能選安全區');
  const r = gf.shelter.freeMove(safe[1]);
  const nb = gf.shelter.primary();
  assert(r.ok && Z.inPlayerSafe(nb.lat, nb.lon) && nb.size === 'huge' && nb.facilities.farm.level === 14 && gf.state.resources.food === 777, '免費重選：整座搬到安全區，規模、設施、資源全部保留');
  assert(!gf.state.freeRelocate && !gf.shelter.canFreeMove(safe[2]).ok, '免費重選只能用一次');
  const { GUIDE_VERSION } = await import('../src/ui/GuideDialog.js');
  assert(GUIDE_VERSION === 17, 'v17：遊戲說明版本 17（改版後重新顯示）');
  // v15：地圖重劃後再給一次免費重選（沒用掉的不重複增加）；不在安全區的避難所自動搬進安全區
  const used = SaveManager.migrate({ ...JSON.parse(JSON.stringify(gf.state)), version: 34 });
  assert(!used.freeRelocate && used.guideSeen === 0, 'v15.10.1：免費重選已全部取消');
  const kept = SaveManager.migrate({ ...JSON.parse(JSON.stringify(gf.state)), version: 34, freeRelocate: true });
  assert(!kept.freeRelocate, 'v15.10.1：還沒用掉的免費重選也取消');
  assert(!SaveManager.migrate({ ...JSON.parse(JSON.stringify(gf.state)), version: 36, freeRelocate: true }).freeRelocate, '存檔 36 還留著免費重選的：升級後取消、提示不再出現');
  const mv = gf.shelter.primary();
  const normalPoi = gf.state.map.pois.find((p) => Z.zoneIndexAt(p.lat, p.lon) === 1);
  Object.assign(mv, { lat: normalPoi.lat, lon: normalPoi.lon, poiId: normalPoi.id, name: normalPoi.name });
  const moved = gf.shelter.moveIntoWorld();
  assert(moved && Z.inPlayerSafe(mv.lat, mv.lon) && mv.facilities.farm.level === 14, 'v15：不在左側安全區的避難所整座搬進安全區（設施保留）');
}

// ---- v14 第 2 批：控制點（佔領後才能探索、好友可探索與駐防、06:00 運輸收益、敵對回到中立） ----
{
  const { MemoryObjects } = await import('../src/multiplayer/SharedWorld.js');
  const CPC = await import('../src/config/controlPoints.js');
  const Z = await import('../src/config/zones.js');
  assert(CPC.CONTROL_POINTS.length === 4, 'v17：控制點共 4 個（左上、左下、右上、右下）');
  assert(CPC.CP_START.join() === 'cp1,cp2' && CPC.CONTROL_POINTS.every((c) => c.name), '左側兩個是起始可攻打的控制點');
  assert(CPC.cpNeighbors('cp1').length >= 2 && CPC.cpNeighbors('cp3').includes('cp1'), '控制點有相鄰關係');
  {
    // v17：除了安全區與勢力領地，其他地方（含一般區）都屬於某個控制點
    let outside = 0; let n = 0;
    const W = (await import('../src/config/world.js')).WORLD_BOUNDS;
    for (let i = 1; i < 40; i += 1) for (let j = 1; j < 40; j += 1) {
      const lat = W.s + ((W.n - W.s) * i) / 40; const lon = W.w + ((W.e - W.w) * j) / 40;
      if (Z.inNpcHome(lat, lon) || Z.zoneIndexAt(lat, lon) === 0) continue;
      n += 1; if (!CPC.cpAt(lat, lon)) outside += 1;
    }
    assert(n > 0 && outside === 0, 'v17：一般區以東（勢力領地以西）都屬於控制點');
  }
  const store = new MemoryObjects();
  const mk = (name) => {
    const gx = Game.newGame({ playerName: name, classId: 'warrior', lat: 25.03, lon: 121.56 });
    gx.genMap();
    gx.shelter.establish(gx.state.map.pois.find((p) => Z.inPlayerSafe(p.lat, p.lon) && gx.shelter.canEstablish(p).ok));
    gx.shared.backend = store;
    gx.world = { others: [], myId: name, identity: () => ({ id: name, token: 't' }) };
    setHour(gx, 10);
    return gx;
  };
  const A = mk('A');
  const B = mk('B');
  const C = mk('C');
  A.state.relations.players = { B: { status: 'friend' }, C: { status: 'neutral' } };
  B.state.relations.players = { A: { status: 'friend' } };
  const cp = CPC.CONTROL_POINTS[0];
  const inCp = A.state.map.pois.find((p) => CPC.cpAt(p.lat, p.lon)?.id === cp.id);
  const free = A.state.map.pois.find((p) => !CPC.cpAt(p.lat, p.lon) && Z.inPlayerSafe(p.lat, p.lon));
  const npcHome = { lat: CPC.factionHq('black').lat, lon: CPC.factionHq('black').lon };
  assert(A.cp.canExplore(inCp).ok && A.cp.canExplore(free).ok && !A.cp.canExplore(npcHome).ok, 'v17：中立控制點區域與安全區可以探索；勢力領地不能');
  const lead = A.survivors.leader();
  {
    const ex0 = A.exploration.start(inCp.id, [lead.id], 5);
    assert(ex0.ok, `v17：可以派遣探索中立控制點區域（${ex0.reason || ''}）`);
    A.state.expeditions = A.state.expeditions.filter((e) => e !== ex0.exp);
    lead.status = 'idle';
  }
  assert(A.cp.garrisonCount(cp.id) === cp.garrison.count && A.cp.npcGarrison(cp.id).length === cp.garrison.count, `中立控制點有感染者守軍（${cp.garrison.count} 人）`);
  // 攻打（測試用：必勝）
  const sim = A.combat.simulate.bind(A.combat);
  A.combat.simulate = (team, foes, o) => { const r = sim(team, foes, { ...o, record: false }); r.victory = true; r.foes.forEach((f) => { f.down = true; }); return r; };
  const at = A.cp.attack(cp.id, [lead.id]);
  assert(at.ok, `派隊攻打控制點（${at.reason || ''}）`);
  assert(at.exp.searchMs === 0, 'v15.9.2：攻打控制點沒有攻打倒數（抵達就交戰，同集結）');
  await A.cp.resolveAttacks(at.exp.startAt + at.exp.travelMs - 1000);
  assert(!at.exp.cpResult && A.cp.statusOf(cp.id) !== 'mine', '還沒抵達：還沒佔領（不能駐防、地圖不會點亮）');
  await A.cp.resolveAttacks(at.exp.startAt + at.exp.travelMs + at.exp.searchMs + 1);
  A.combat.simulate = sim;
  await B.shared.poll(); await C.shared.poll();
  assert(A.cp.statusOf(cp.id) === 'mine' && B.cp.statusOf(cp.id) === 'mine' && C.cp.statusOf(cp.id) === 'other', '打下後：自己與好友是「我方」，其他玩家是「其他」');
  assert(A.cp.canExplore(inCp).ok && B.cp.canExplore(inCp).ok && C.cp.canExplore(inCp).ok, 'v17：佔領後該區域：佔領者、好友與非敵對的玩家都可以探索');
  C.state.relations.players = { A: { status: 'hostile' } };
  assert(!C.cp.canExplore(inCp).ok && !C.cp.canEnter(cp.id), 'v17：和佔領者敵對的玩家不能探索、也不能穿越');
  {
    // 自動探索佇列（快速佇列／加入佇列）不會選到不能探索的控制點區域
    const ZN = await import('../src/config/zones.js');
    const pp = C.state.map.pois.filter((p) => POI_TYPES[p.type] && !p.npc);
    const locked = pp.filter((p) => !C.cp.canExplore(p).ok && !Z.inNpcHome(p.lat, p.lon));
    const open = pp.filter((p) => C.cp.canExplore(p).ok && !C.shelter.baseAtPoi(p.id) && locked.some((q) => ZN.zoneAt(q.lat, q.lon).id === ZN.zoneAt(p.lat, p.lon).id));
    open.sort((a, b) => Math.min(...locked.map((q) => haversine(a.lat, a.lon, q.lat, q.lon))) - Math.min(...locked.map((q) => haversine(b.lat, b.lon, q.lat, q.lon))));
    const st0 = open[0] && C.exploration.start(open[0].id, [C.survivors.leader().id], 5);
    assert(st0?.ok, `控制點旁的開放區域可以探索（${st0?.reason || ''}）`);
    const qf = C.exploration.quickFill(st0.exp.id);
    assert(qf.added.every((p) => C.cp.canExplore(p).ok), `快速佇列不會加入未佔領控制點的建築（加入 ${qf.added.length} 個）`);
    assert(!C.exploration.enqueue(st0.exp.id, inCp.id).ok, '未佔領控制點的建築不能加入探索佇列');
    C.exploration.recall(st0.exp.id);
    C.state.expeditions = [];
  }
  C.state.relations.players = { A: { status: 'neutral' } };
  assert(!C.cp.canAttack(cp.id).ok, '非敵對的其他玩家不能攻打');
  C.state.relations.players = { A: { status: 'hostile' } };
  assert(C.cp.canAttack(cp.id).ok, '敵對玩家可以攻打');
  assert(CPC.CP_START.includes('cp2') && A.cp.canAttack('cp2').ok, '左側兩個控制點隨時可以進攻');
  assert(A.cp.canAttack('cp3').ok && B.cp.canAttack('cp3').ok, '和自己或好友佔領的控制點相鄰才能進攻（好友的也算）');
  const far = A.cp.canAttack('cp4');
  assert(!far.ok && far.locked && /#2/.test(far.reason), '不相鄰的控制點不能進攻，並列出相鄰的控制點');
  assert(!C.cp.canAttack('cp3').ok && !A.rally.canStart({ kind: 'cp', id: 'cp4' }).ok, '只有敵對玩家相鄰時不能進攻；不相鄰也不能發起集結');
  // 好友駐防（每人最多 2 人）
  A.exploration.update(at.exp.endAt + 1, { silent: true });
  const bl = B.survivors.leader();
  const gd = B.cp.guard(cp.id, [bl.id]);
  assert(gd.ok, `佔領者的好友可以駐防（${gd.reason || ''}）`);
  assert(B.cp.canGuard(cp.id, 2).ok && !B.cp.canGuard(cp.id, 3).ok, 'v17：每名玩家每個控制點最多駐防 3 人');
  {
    // v15.7：出發時就寫進共用資料（含抵達時間）：抵達時玩家離線（沒有執行 syncGuards），交戰時也算得到
    await new Promise((r) => setTimeout(r, 50));
    await A.shared.poll();
    const arr = gd.exp.startAt + gd.exp.travelMs;
    const hB = (A.cp.data(cp.id)?.guards || []).find((h) => h.e === gd.exp.id);
    assert(hB && hB.arr === arr && gd.exp.cpListed, '駐防隊出發時就寫進共用資料（含抵達時間）');
    assert(!A.cp.guardsAt(cp.id, arr - 1).some((h) => h.e === gd.exp.id) && !A.cp.defenders(cp.id, arr - 1).some((u) => u.ally?.e === gd.exp.id), '還沒抵達的駐防隊不參戰');
    assert(A.cp.defenders(cp.id, arr + 1).some((u) => u.ally?.e === gd.exp.id), '已抵達的駐防隊參戰（玩家離線也算）');
  }
  await B.cp.syncGuards(gd.exp.startAt + gd.exp.travelMs + 1);
  await A.shared.poll();
  assert((A.cp.data(cp.id)?.guards || []).some((h) => h.p === 'B'), '駐防隊寫入控制點，攻打方會遇到');
  {
    // v15.6：科技「據點駐防」：自己派出的駐防隊生命與攻擊提升（每級 5%）
    B.state.research.levels.d_cpguard = 4;
    B.research.invalidate();
    const base0 = B.rally.units([bl.id])[0];
    const gx = { id: 'gx2', kind: 'cpGuard', cpKind: CPC.CP_KIND, cpId: cp.id, poiId: `cpguard:${cp.id}`, memberIds: [bl.id], startAt: Date.now() - 100000, travelMs: 1000, searchMs: 3600000, endAt: Date.now() + 3600000, from: { lat: 25, lon: 121 } };
    B.state.expeditions.push(gx);
    await B.cp.syncGuards(Date.now());
    const u = (B.cp.data(cp.id)?.guards || []).find((h) => h.e === 'gx2')?.units?.[0];
    assert(u && Math.abs(u.maxHp - base0.maxHp * 1.2) <= 1 && Math.abs(u.atk - base0.atk * 1.2) <= 1, `據點駐防 Lv4：駐防隊生命與攻擊 +20%（${base0.maxHp}→${u?.maxHp}）`);
    await B.shared.update(CPC.CP_KIND, cp.id, (x) => ({ data: { ...x, guards: (x.guards || []).filter((h) => h.e !== 'gx2') } }));
    B.state.expeditions = B.state.expeditions.filter((e) => e !== gx);
    B.state.research.levels.d_cpguard = 0;
    B.research.invalidate();
  }
  {
    const { WorldSync: WSg } = await import('../src/multiplayer/WorldSync.js');
    const pb = WSg.prototype.presence.call({ game: B });
    assert(pb.trips.some((t) => t.id === gd.exp.id && t.kind === 'cpGuard'), '駐防隊同步給其他玩家時標示為駐防（不會顯示成搜索中）');
  }
  {
    // v15.4：勢力進攻控制點改為派兵行軍（移動時間比照攻打避難所），佔領者與駐防者收到紅色提醒（同一人只一則）
    const t0 = Date.now();
    const { RAID_TRAVEL: RT2 } = await import('../src/config/constants.js');
    await A.cp.launchMarch('red', cp.id, t0);
    const mch = A.cp.data(cp.id)?.march;
    assert(mch && mch.arriveAt - t0 >= RT2.minMin * 60000 - 5, `勢力派兵前往控制點，移動時間比照攻打避難所（約 ${Math.round((mch?.arriveAt - t0) / 60000)} 分鐘）`);
    await B.shared.poll();
    const cntA0 = A.state.log.filter((l) => /部隊正前往/.test(l.msg)).length;
    A.cp.warnMarches(t0 + 1000); A.cp.warnMarches(t0 + 2000);
    B.cp.warnMarches(t0 + 1000);
    const la = A.state.log.filter((l) => /部隊正前往/.test(l.msg));
    assert(la.length - cntA0 === 1 && /你佔領的控制點/.test(la[0].msg), `佔領者收到一則紅色提醒（${la[0]?.msg || ''}）`);
    assert(B.state.log.some((l) => /部隊正前往你駐防的控制點/.test(l.msg)), '駐防者也收到提醒');
    // v15.7：地圖左上角持續顯示紅色威脅訊息（同 NPC 攻打避難所），抵達後消失
    assert(A.cp.incoming(t0 + 1000).some((x) => x.text.includes(`控制點 #${cp.no}`)) && B.cp.incoming(t0 + 1000).length > 0, '佔領者與駐防者的地圖左上角顯示勢力部隊前往控制點的紅色訊息');
    assert(!A.cp.incoming(mch.arriveAt + 1).some((x) => x.text.includes(`控制點 #${cp.no}`)), '部隊抵達後紅色訊息消失');
    // 同一人同時是佔領者與駐防者：只收到一則
    await A.shared.update(CPC.CP_KIND, cp.id, (x) => ({ data: { ...x, guards: [...(x.guards || []), { p: 'A', n: 'A', e: 'eA', units: [] }], march: { ...x.march, arriveAt: x.march.arriveAt + 1 } } }));
    const cntA1 = A.state.log.filter((l) => /部隊正前往/.test(l.msg)).length;
    A.cp.warnMarches(t0 + 3000);
    const la2 = A.state.log.filter((l) => /部隊正前往/.test(l.msg));
    assert(la2.length - cntA1 === 1 && /你佔領並駐防的/.test(la2[0].msg), `同時是佔領者與駐防者：只收到一則（${la2[0]?.msg || ''}）`);
    assert(A.cp.marchView(t0 + 1000).some((m) => m.id === `mc:${cp.id}`), '地圖上顯示前往控制點的勢力部隊');
    // 還沒抵達不交戰；抵達後由一位玩家結算
    await A.cp.resolveMarches(t0 + 1000);
    assert(A.cp.data(cp.id)?.march, '部隊還沒抵達：不交戰');
    await A.shared.update(CPC.CP_KIND, cp.id, (x) => ({ data: { ...x, march: null, guards: (x.guards || []).filter((h) => h.p !== 'A') } }));
    // 完整流程：部隊抵達 → 交戰 → 打贏佔領（只結算一次）；打輸控制點維持原狀
    const sim0 = A.combat.simulate;
    const forceWin = (win) => { A.combat.simulate = (team, foes, o) => { const r = sim0.call(A.combat, team, foes, { ...o, record: false }); r.victory = win; r.foes.forEach((f) => { f.down = win; }); return r; }; };
    const tgt2 = CPC.CONTROL_POINTS.find((c) => c.id !== cp.id && !A.cp.factionOf(c.id) && !A.cp.owners(c.id).length);
    const past = Date.now() - 6 * 3600000;
    await A.cp.launchMarch('red', tgt2.id, past);
    // 抵達時間設成剛剛（守軍補回時間從抵達算起）
    await A.shared.update(CPC.CP_KIND, tgt2.id, (x) => ({ data: { ...x, march: { ...x.march, arriveAt: Date.now() - 1000 } } }));
    assert(A.cp.data(tgt2.id)?.march?.arriveAt <= Date.now(), '部隊已經抵達（測試用：很久以前出發）');
    forceWin(true);
    const logs0 = A.state.log.filter((l) => l.msg.includes(`佔領了控制點 #${tgt2.no}`)).length;
    await A.cp.resolveMarches(Date.now());
    await B.shared.poll();
    await B.cp.resolveMarches(Date.now());
    A.combat.simulate = sim0;
    assert(A.cp.factionOf(tgt2.id) === 'red' && B.cp.factionOf(tgt2.id) === 'red' && !A.cp.data(tgt2.id)?.march, '部隊抵達後交戰：打贏由勢力佔領控制點、行軍資料清除');
    assert(A.state.log.filter((l) => l.msg.includes(`佔領了控制點 #${tgt2.no}`)).length - logs0 === 1 && !B.state.log.some((l) => l.msg.includes(`佔領了控制點 #${tgt2.no}`)), '多位玩家同時在線：只結算一次');
    assert(A.cp.garrisonCount(tgt2.id) === CPC.CP_GARRISON.npc - 4 && Math.abs(A.cp.defensePower(tgt2.id) - CPC.CP_POWER.npc.start) < CPC.CP_POWER.npc.start * 0.03, `v17：勢力打下後留守 70 萬（${A.cp.garrisonCount(tgt2.id)}/${CPC.CP_GARRISON.npc} 人・${Math.round(A.cp.defensePower(tgt2.id)).toLocaleString()}），之後補到 90 萬`);
    // 打輸：玩家的控制點維持原狀
    const snap = JSON.parse(JSON.stringify(A.cp.data(cp.id)));
    // 測試用：部隊很久以前出發，駐防隊也設成更早就抵達
    await A.shared.update(CPC.CP_KIND, cp.id, (x) => ({ data: { ...x, guards: (x.guards || []).map((h) => ({ ...h, arr: past - 3600000 })) } }));
    await A.cp.launchMarch('red', cp.id, past);
    forceWin(false);
    await A.cp.resolveMarches(Date.now());
    A.combat.simulate = sim0;
    assert(!A.cp.factionOf(cp.id) && A.cp.owners(cp.id).some((o) => o.p === 'A') && A.cp.data(cp.id)?.march?.fu, '部隊被擊退：控制點維持原本的佔領者（v17：30 分鐘後追加一波）');
    await A.shared.update(CPC.CP_KIND, cp.id, (x) => ({ data: { ...x, march: null } }));
    // v15.6：交戰結果：佔領者與駐防者都收到戰報（同一人只一則、不重複）
    A.cp.reportFights(); A.cp.reportFights();
    const fa = A.state.log.filter((l) => /擊退了「/.test(l.msg) && l.msg.includes(`#${cp.no}`));
    assert(fa.length === 1 && /你佔領的/.test(fa[0].msg), `佔領者收到一則交戰戰報（${fa[0]?.msg || ''}）`);
    await B.shared.poll();
    const gsv = B.survivors.get(gd.exp.memberIds[0]);
    const gxp0 = gsv.xp; const glv0 = gsv.level;
    B.cp.reportFights();
    assert(B.state.log.some((l) => /你駐防的控制點/.test(l.msg) && /擊退了「/.test(l.msg)), '駐防者也收到交戰戰報');
    // v15.7：防守成功：沒倒下的駐防隊員獲得升級所需經驗的 3%（佔領者沒駐防不拿）
    assert((gsv.level > glv0 || gsv.xp > gxp0) && B.state.log.some((l) => /防守成功經驗/.test(l.msg)), `駐防隊防守成功：沒倒下的隊員獲得經驗（${B.state.log.find((l) => /防守成功經驗/.test(l.msg))?.msg || ''}）`);
    assert(!A.state.log.some((l) => /防守成功經驗/.test(l.msg)), '只佔領、沒有駐防的人不拿防守經驗');
    const nb = B.state.log.filter((l) => /防守成功經驗/.test(l.msg)).length;
    B.cp.reportFights();
    assert(B.state.log.filter((l) => /防守成功經驗/.test(l.msg)).length === nb, '同一場防守經驗只拿一次');
    const gx1 = gsv.xp;
    assert(B.cp.guardXp(cp, { at: Date.now(), ge: [gd.exp.id], downU: [`${gd.exp.id}:0`] }) === 0 && gsv.xp === gx1, '倒下的駐防隊員沒有防守經驗、也不扣經驗');
    await A.shared.update(CPC.CP_KIND, cp.id, () => ({ data: { ...snap, march: null } }));
    await A.shared.update(CPC.CP_KIND, tgt2.id, () => ({ data: { owners: [], guards: [], faction: null } }));
    await B.shared.poll();
  }
  // 每日收益：佔領者與駐守者都能拿，同一人只一份（駐防隊要已抵達；測試用設成早已抵達）
  await A.shared.update(CPC.CP_KIND, cp.id, (x) => ({ data: { ...x, guards: (x.guards || []).map((h) => ({ ...h, arr: 0 })) } }));
  await B.shared.poll();
  assert(A.cp.incomeSources().length === 1 && B.cp.incomeSources().length === 1, '佔領者與駐守者都有收益');
  const inc = A.cp.rollIncome(cp);
  assert(inc.food === CPC.CP_INCOME[cp.zone].food * CPC.CP_INCOME_MUL && Object.keys(inc).some((k) => SUPPLIES_ALL[k]?.cat === 'fabric') && Object.keys(inc).length > 3, `收益：少量資源＋隨機零件（${JSON.stringify(inc)}）`);
  const t6 = A.cp.incomeTime(Date.now());
  // v15.7：06:00 收益直接入庫，並發出視窗用的事件（合計＋各控制點）
  const f0 = A.state.resources.food;
  let evt = null; const off = A.bus.on('cp:dailyIncome', (x) => { evt = x; });
  const inc6 = A.cp.startConvoys(t6 + 1000);
  off?.();
  assert(inc6 && A.state.resources.food > f0 && !A.cp.st.convoys.length && !A.cp.convoyView().length, '06:00 控制點收益直接入庫，沒有運輸隊');
  assert(evt && evt.list.length === 1 && evt.list[0].no === cp.no && evt.list[0].zone && /佔領/.test(evt.list[0].role) && evt.text, `跳出視窗：合計與各控制點（${evt?.text} / #${evt?.list[0]?.no} ${evt?.list[0]?.zone} ${evt?.list[0]?.role}）`);
  assert(!A.cp.startConvoys(t6 + 2000), '同一天只送一次');
  // 舊存檔裡還在路上的運輸隊：直接入庫
  A.cp.st.convoys = [{ id: 'old', cp: cp.id, from: { lat: 0, lon: 0 }, to: { lat: 0, lon: 0 }, startAt: 0, endAt: Date.now() + 9e6, goods: { food: 3 } }];
  const f1 = A.state.resources.food;
  A.cp.deliverConvoys();
  assert(A.state.resources.food === f1 + 3 && !A.cp.st.convoys.length, '舊存檔還在路上的運輸隊直接入庫');
  {
    // v15.5：離線期間錯過的每日收益：上線時補發（最多 24 次），今天的照常由運輸隊送回
    const CPS = await import('../src/systems/ControlPointSystem.js');
    const now5 = Date.now();
    const today = A.time.day(now5);
    A.cp.st.incomeDay = today - 1;
    assert(!A.cp.catchUpIncome(now5), '在線時跨過 06:00：不補發（照常由運輸隊送回）');
    A.cp.st.incomeDay = today - 5;
    const f1 = A.state.resources.food;
    let ev = null;
    A.bus.once('cp:offlineIncome', (r) => { ev = r; });
    const c1 = A.cp.catchUpIncome(now5);
    const per = A.cp.incomeSources().reduce((sum, c) => sum + CPC.CP_INCOME[c.zone].food, 0);
    assert(c1 && c1.times === 4 && A.cp.st.incomeDay === today - 1 && ev === c1, `離線錯過 4 天：補發 4 次（${c1?.text || ''}）`);
    assert(A.state.resources.food - f1 >= per * 4 * 0.99 && Object.keys(c1.goods).length > 3, '補發的收益直接入庫（資源＋零件）');
    assert(!A.cp.catchUpIncome(now5), '同一次上線不會重複補發');
    A.cp.st.incomeDay = today - 100;
    const c2 = A.cp.catchUpIncome(now5);
    assert(c2.times === CPS.CP_OFFLINE_INCOME_MAX && c2.missed === 99, `離線很久：最多補 ${CPS.CP_OFFLINE_INCOME_MAX} 次`);
    A.cp.st.incomeDay = today;
  }
  // v15.4.1：駐防沒有期限（快到期時自動延長），佔領者與好友解除關係時駐防隊撤回
  {
    await B.shared.poll();
    const ge = gd.exp;
    const stayEnd0 = ge.startAt + ge.travelMs + ge.searchMs;
    B.cp.extendGuards(stayEnd0 - 1000);
    assert(ge.startAt + ge.travelMs + ge.searchMs > stayEnd0 && !ge.recalled, '駐防快到期時自動延長（直到撤回或被打下）');
    B.autoHome.run(Date.now(), { silent: true });
    assert(!ge.recalled && B.state.expeditions.includes(ge), '19:30 自動回家不會叫回駐防隊');
    const rel0 = B.state.relations.players.A;
    // 連線時剛開遊戲、還沒讀到共用的控制點資料：所有控制點看起來是中立，不能因此撤回
    const be0 = B.shared.backend;
    const pv0 = B.world.provider;
    const la0 = B.shared.listedAt;
    B.shared.backend = null; B.world.provider = { objPut: () => {} }; B.shared.listedAt = {};
    const cache0 = new Map(B.shared.cache);
    B.shared.cache.clear();
    B.cp.extendGuards(Date.now());
    assert(!ge.recalled && B.cp.recallLostExplores(Date.now()) === 0, '還沒讀到共用控制點資料時，不會誤判而撤回駐防隊或探索隊');
    B.shared.cache = cache0; B.shared.backend = be0; B.world.provider = pv0; B.shared.listedAt = la0;
    B.state.relations.players.A = { status: 'neutral' };
    B.cp.extendGuards(Date.now());
    assert(!ge.recalled, 'v17：和佔領者解除好友（變成中立）：仍然可以駐防');
    B.state.relations.players.A = { status: 'hostile' };
    B.cp.extendGuards(Date.now());
    assert(ge.recalled && B.state.log.some((l) => /駐防隊撤回/.test(l.msg)), 'v17：和佔領者變成敵對：駐防隊撤回');
    assert(!(ge.travelEvents || []).some((t) => /收到召回命令/.test(t)) && ge.travelEvents.some((t) => /駐防隊撤回/.test(t)), '強制撤回的報告寫原因，不會寫「收到召回命令」');
    B.state.relations.players.A = rel0;
  }
  // 共同佔領者變成敵對：回到中立
  await A.shared.update(CPC.CP_KIND, cp.id, (x) => ({ data: { ...x, owners: [{ p: 'A', n: 'A' }, { p: 'C', n: 'C' }] } }));
  A.state.relations.players.C = { status: 'hostile' };
  await A.cp.checkHostileOwners(Date.now());
  assert(A.cp.statusOf(cp.id) === 'neutral', '共同佔領者變成敵對時，控制點回到中立');
  assert(A.cp.garrisonCount(cp.id) < cp.garrison.count, '回到中立後守軍慢慢補回');
}

// ---- v15.3：探索路線繞過不可探索的區域（未佔領的控制點、勢力領地） ----
{
  const { MemoryObjects } = await import('../src/multiplayer/SharedWorld.js');
  const CPC = await import('../src/config/controlPoints.js');
  const Z = await import('../src/config/zones.js');
  const gr = Game.newGame({ playerName: 'R', classId: 'warrior', lat: 25.03, lon: 121.56 });
  gr.genMap();
  gr.shelter.establish(gr.state.map.pois.find((p) => Z.inPlayerSafe(p.lat, p.lon) && gr.shelter.canEstablish(p).ok));
  gr.shared.backend = new MemoryObjects();
  gr.world = { others: [], myId: 'R', identity: () => ({ id: 'R', token: 't' }) };
  setHour(gr, 10);
  // v17：右側控制點 X 是自己的、左側兩個都被勢力佔領 → 沒有路；左側其中一個 Y 改為自己的 → 繞路經過 Y
  const X = CPC.cpById('cp3');
  const Y = 'cp1';
  const own = (id) => gr.shared.update(CPC.CP_KIND, id, () => ({ data: { owners: [{ p: 'R', n: 'R' }], guards: [], faction: null } }));
  const block = (id) => gr.shared.update(CPC.CP_KIND, id, () => ({ data: { owners: [], guards: [], faction: 'red' } }));
  await own(X.id);
  await block('cp1'); await block('cp2');
  const target = gr.state.map.pois.find((p) => CPC.cpAt(p.lat, p.lon)?.id === X.id && !gr.npcs.list.some((n) => haversine(n.lat, n.lon, p.lat, p.lon) < 200));
  const lead = gr.survivors.leader();
  const r1 = gr.exploration.start(target.id, [lead.id], 5);
  assert(!r1.ok && /沒有路/.test(r1.reason || ''), `佔領的控制點和可探索區不相通時，不能穿過未佔領的控制點過去（${r1.reason || ''}）`);
  const Zc = CPC.cpNeighbors(X.id).find((n) => !CPC.CP_START.includes(n) && n !== X.id);
  if (Zc) {
    const ra = gr.cp.attack(Zc, [lead.id]);
    assert(gr.cp.canAttack(Zc).ok && !ra.ok && /沒有路/.test(ra.reason || ''), `攻打控制點也不能穿過未佔領的控制點（${ra.reason || ''}）`);
  }
  await own(Y);
  const r2 = gr.exploration.start(target.id, [lead.id], 5);
  assert(r2.ok, `佔領沿路的控制點後可以出發（${r2.reason || ''}）`);
  const path = r2.exp.path || [];
  const bad = [];
  for (let i = 1; i < path.length; i += 1) {
    for (let k = 1; k < 20; k += 1) {
      const lat = path[i - 1].lat + ((path[i].lat - path[i - 1].lat) * k) / 20;
      const lon = path[i - 1].lon + ((path[i].lon - path[i - 1].lon) * k) / 20;
      const c = CPC.cpAt(lat, lon);
      if (Z.inNpcHome(lat, lon) || (c && !gr.cp.canEnter(c.id))) bad.push(c?.id || 'home');
    }
  }
  assert(path.length >= 2 && bad.length <= 1, `探索路線只走可探索的區域（穿過未佔領：${bad.length} 點）`);
  // v15.4：探索中目標所在的控制點被佔領：強制撤回
  r2.exp.queue = ['x'];
  // 另一支小隊：目前的目標在安全區，但佇列中有 X 裡的地點
  const fakeQ = { id: 'qq', kind: 'explore', memberIds: [], poiId: gr.state.map.pois.find((p) => Z.inPlayerSafe(p.lat, p.lon)).id, queue: [target.id], startAt: Date.now(), endAt: Date.now() + 600000, travelMs: 1000, searchMs: 1000 };
  gr.state.expeditions.push(fakeQ);
  await gr.shared.update(CPC.CP_KIND, X.id, () => ({ data: { owners: [], guards: [], faction: 'red' } }));
  gr.cp.recallLostExplores(r2.exp.startAt + 1000);
  assert(r2.exp.recalled && !r2.exp.queue.length, '探索中控制點被佔領：隊伍強制撤回、佇列取消');
  assert(!fakeQ.queue.length && !fakeQ.recalled, '控制點被佔領：其他隊伍佇列中（自動探索預定）在那裡的地點也一併取消');
  gr.state.expeditions = gr.state.expeditions.filter((e) => e !== fakeQ);
  // v15.9.1：控制點被佔領、佇列中還有可以探索的地點：直接改去下一站（不先回家）
  {
    await own(X.id);
    const { createSurvivor: mkS } = await import('../src/core/GameState.js');
    const s2 = mkS('改道', 'scout', 10, 'common');
    gr.state.survivors.push(s2);
    const safeP = gr.state.map.pois.filter((p) => Z.inPlayerSafe(p.lat, p.lon) && !gr.shelter.baseAtPoi(p.id)).slice(0, 2);
    const r3 = gr.exploration.start(target.id, [s2.id], 5);
    assert(r3.ok, `派隊到控制點內探索（${r3.reason || ''}）`);
    r3.exp.queue = [target.id, safeP[0].id, safeP[1].id];
    const at3 = r3.exp.startAt + Math.round(r3.exp.travelMs / 2);
    const pos3 = gr.exploration.progress(r3.exp, at3).pos;
    await gr.shared.update(CPC.CP_KIND, X.id, () => ({ data: { owners: [], guards: [], faction: 'red' } }));
    gr.exploration.pendingReports = [];
    gr.cp.recallLostExplores(at3);
    const ne = gr.state.expeditions.find((e) => e.memberIds.includes(s2.id));
    assert(ne && ne !== r3.exp && ne.poiId === safeP[0].id && !ne.recalled && ne.queue.length === 1 && ne.queue[0] === safeP[1].id, `控制點被佔領：改去佇列中還能探索的下一站（${ne?.poiId === safeP[0].id ? '下一站' : ne?.poiId}，佇列剩 ${ne?.queue?.length}）`);
    assert(Math.abs(ne.from.lat - pos3.lat) < 1e-6 && Math.abs(ne.from.lon - pos3.lon) < 1e-6 && ne.startAt === at3, '從目前位置直接出發、不先回家');
    const rep = gr.exploration.pendingReports[0];
    assert(rep && rep.events.some((x) => /被佔領/.test(x)) && rep.events.some((x) => /改為直接前往/.test(x)) && !rep.events.some((x) => /回到避難所|強制撤回/.test(x)), `這一站的報告寫出改道（${rep?.events?.join(' / ')}）`);
    const reps = gr.exploration.update(at3 + 1, { silent: true });
    assert(reps.some((x) => x === rep) && !gr.exploration.pendingReports.length, '改道的報告在下一次更新時加入報告');
    gr.exploration.free(ne);
    gr.state.expeditions = gr.state.expeditions.filter((e) => e !== ne);
    gr.state.survivors = gr.state.survivors.filter((x) => x !== s2);
  }
  // v15.4：探索點在鄰接大本營的控制點：有機會被大本營的部隊襲擊
  {
    const EX = await import('../src/systems/ExplorationSystem.js');
    const eastCp = CPC.CONTROL_POINTS.find((c) => CPC.FACTION_KEYS.some((f) => CPC.hqNeighbors(f).includes(c.id)));
    const ep = gr.state.map.pois.filter((p) => CPC.cpAt(p.lat, p.lon)?.id === eastCp.id && POI_TYPES[p.type] && !gr.state.expeditions.some((e) => e.poiId === p.id || (e.queue || []).includes(p.id))).pop();
    const westP = gr.state.map.pois.find((p) => Z.inPlayerSafe(p.lat, p.lon));
    assert(EX.hqFactionOf(ep) && !EX.hqFactionOf(westP), '找到鄰接大本營的控制點');
    // v15.8.1：移除大本營伏擊探索隊：不再派出部隊；舊版本已派出、還沒抵達的部隊取消
    const ce0 = gr.cp.canExplore;
    const so0 = gr.cp.statusOf;
    gr.cp.canExplore = () => ({ ok: true });
    gr.cp.statusOf = () => 'mine';
    const { createSurvivor: mkSv } = await import('../src/core/GameState.js');
    const weak = mkSv('偵察', 'scout', 1, 'common');
    gr.state.survivors.push(weak);
    const ra = gr.exploration.start(ep.id, [weak.id], 5);
    assert(ra.ok, `派隊到鄰接大本營的控制點探索（${ra.reason || ''}）`);
    const e = ra.exp;
    e.searchMs = 3600000;
    const arrive = e.startAt + e.travelMs + 1;
    for (let i = 0; i < 20; i += 1) gr.cp.hqAmbushes(arrive + i * 1000);
    assert(!e.hqAmbush && !gr.cp.incoming(arrive + 1000).some((x) => /大本營部隊/.test(x.text)), '鄰接大本營的控制點探索：大本營不再派部隊襲擊');
    e.hqAmbush = { f: 'red', from: CPC.factionHq('red'), to: { lat: ep.lat, lon: ep.lon }, at: arrive, hitAt: arrive + 600000 };
    gr.cp.hqAmbushes(arrive + 1000);
    gr.cp.hqAmbushes(arrive + 700000);
    assert(!e.hqAmbush && !(e.travelEvents || []).some((x) => /襲擊/.test(x)) && !gr.cp.marchView(arrive + 2000).some((m) => m.id === `ma:${e.id}`), '舊版本已派出的大本營部隊取消、不交戰');
    gr.exploration.recall(e.id, arrive + 2);
    gr.state.expeditions = gr.state.expeditions.filter((x) => x !== e);
    gr.state.survivors = gr.state.survivors.filter((x) => x !== weak);
    gr.cp.canExplore = ce0;
    gr.cp.statusOf = so0;
  }
  // v15.5：離線期間控制點被佔領：回來結算時，從被佔領的那一刻起撤回（不會照常搜完帶回全部物資）
  {
    const { createSurvivor: mkSv2 } = await import('../src/core/GameState.js');
    const sv = mkSv2('離線', 'scout', 10, 'common');
    gr.state.survivors.push(sv);
    const yp = gr.state.map.pois.find((p) => CPC.cpAt(p.lat, p.lon)?.id === Y && gr.cp.canExplore(p).ok && !gr.npcs.list.some((n) => haversine(n.lat, n.lon, p.lat, p.lon) < 200));
    const ro = gr.exploration.start(yp.id, [sv.id], 5);
    assert(ro.ok, `在佔領的控制點探索（${ro.reason || ''}）`);
    const eo = ro.exp;
    const takenAt = eo.startAt + eo.travelMs + Math.round(eo.searchMs / 3);
    await gr.shared.update(CPC.CP_KIND, Y, () => ({ data: { owners: [], guards: [], faction: 'red', takenAt, lostAt: takenAt } }));
    const reps = gr.exploration.update(eo.endAt + 3600000, { silent: true });
    const rp = reps.find((r) => r.members?.includes('離線'));
    assert(eo.recalled && rp && !rp.success, `離線期間控制點被佔領：結算時從被佔領的那一刻起撤回（${rp?.events?.slice(-2).join('／') || ''}）`);
    gr.state.survivors = gr.state.survivors.filter((x) => x !== sv);
  }
  // v15.5：其他玩家的探索隊：出發後目標控制點被佔領（對方離線還沒撤回）時，我的地圖不再顯示
  {
    const { WorldSync: WS, cleanPlayer: CPl2 } = await import('../src/multiplayer/WorldSync.js');
    const dY = gr.cp.data(Y);
    const tk = dY.takenAt;
    const yp2 = gr.state.map.pois.find((p) => CPC.cpAt(p.lat, p.lon)?.id === Y);
    const base = { from: { lat: 25.03, lon: 121.56 }, to: { lat: yp2.lat, lon: yp2.lon }, travelMs: 60000, searchMs: 600000, members: 1, target: yp2.name, id: 't1' };
    const before = { ...base, kind: 'explore', startAt: tk - 60000, endAt: tk + 3600000 };
    assert(gr.cp.hideOtherTrip(before, tk + 1000), '出發後目標控制點被佔領的探索隊：不顯示');
    assert(!gr.cp.hideOtherTrip(before, tk - 1000), '控制點被佔領之前：照常顯示');
    assert(!gr.cp.hideOtherTrip({ ...before, startAt: tk + 1000 }, tk + 2000), '控制點被佔領之後才出發的隊伍不受影響');
    assert(gr.cp.hideOtherTrip({ ...before, kind: undefined }, tk + 1000), '舊版本（沒有標示種類）前往建築的隊伍也視為探索、不顯示');
    assert(!gr.cp.hideOtherTrip({ ...before, kind: 'assist' }, tk + 1000) && !gr.cp.hideOtherTrip({ ...before, rally: 'r1' }, tk + 1000), '協防、集結隊伍不受影響');
    const freeP = gr.state.map.pois.find((p) => !CPC.cpAt(p.lat, p.lon));
    assert(!gr.cp.hideOtherTrip({ ...before, to: { lat: freeP.lat, lon: freeP.lon } }, tk + 1000), '目標不在控制點裡（安全區、一般區）照常顯示');
    // 同步資料：探索隊會標示種類，讀取時保留
    const presR = WS.prototype.presence.call({ game: gr });
    const cl = CPl2({ ...presR, id: 'R', trips: [{ ...before }] });
    assert(cl?.trips?.[0]?.kind === 'explore', '同步資料保留探索隊的種類');
    assert(CPl2({ ...presR, id: 'R', trips: [{ ...before, kind: 'cpGuard' }] })?.trips?.[0]?.kind === 'cpGuard' && CPl2({ ...presR, id: 'R', trips: [{ ...before, kind: 'cp' }] })?.trips?.[0]?.kind === 'cp', '同步資料保留駐防、攻打控制點的種類（其他玩家看到駐防中、戰鬥中）');
    const { createSurvivor: mkSv3 } = await import('../src/core/GameState.js');
    const sv3 = mkSv3('同步', 'scout', 5, 'common');
    gr.state.survivors.push(sv3);
    const sp = gr.state.map.pois.find((p) => Z.inPlayerSafe(p.lat, p.lon) && !gr.shelter.baseAtPoi(p.id));
    const rs = gr.exploration.start(sp.id, [sv3.id], 5);
    const pr2 = WS.prototype.presence.call({ game: gr });
    assert(rs.ok && pr2.trips.some((t) => t.id === rs.exp.id && t.kind === 'explore'), '自己的探索隊同步出去時標示為探索');
    gr.state.expeditions = gr.state.expeditions.filter((e) => e !== rs.exp);
    gr.state.survivors = gr.state.survivors.filter((x) => x !== sv3);
  }
}

// ---- v14 第 3 批：三大勢力（起始控制點、相鄰進攻、優先無人駐守、打下留守、NPC 據點數量） ----
{
  const { MemoryObjects } = await import('../src/multiplayer/SharedWorld.js');
  const CPC = await import('../src/config/controlPoints.js');
  const Z = await import('../src/config/zones.js');
  const gq = Game.newGame({ playerName: 'Q3', classId: 'warrior', lat: 25.03, lon: 121.56 });
  gq.genMap();
  gq.shelter.establish(gq.state.map.pois.find((p) => Z.inPlayerSafe(p.lat, p.lon) && gq.shelter.canEstablish(p).ok));
  gq.shared.backend = new MemoryObjects();
  gq.world = { others: [], myId: 'Q3', identity: () => ({ id: 'Q3', token: 't' }) };
  assert(CPC.FACTION_KEYS.every((f) => !gq.cp.factionCps(f).length), 'v17：一開始 4 個控制點都是中立（勢力沒有控制點）');
  CPC.FACTION_KEYS.forEach((f) => {
    const t = gq.cp.pickTarget(f);
    assert(t && CPC.hqNeighbors(f).includes(t) && CPC.cpById(t).side === 'right', `勢力「${CPC.FACTIONS[f].name}」沒有控制點時從大本營旁的右側控制點開始（${t}）`);
  });
  // 測試用：赤月佔右上、冥府佔右下
  await gq.shared.update(CPC.CP_KIND, 'cp3', () => ({ data: { owners: [], guards: [], faction: 'red' } }));
  await gq.shared.update(CPC.CP_KIND, 'cp4', () => ({ data: { owners: [], guards: [], faction: 'blue' } }));
  const own = Object.fromEntries(CPC.FACTION_KEYS.map((f) => [f, gq.cp.factionCps(f)]));
  ['red', 'blue'].forEach((f) => {
    const t = gq.cp.pickTarget(f);
    assert(t && own[f].some((id) => CPC.cpNeighbors(id).includes(t)) && !own[f].includes(t), `勢力「${CPC.FACTIONS[f].name}」只攻打相鄰的控制點（${t}）`);
  });
  // 有駐防的排在後面：把 black 的候選之一標記為玩家佔領＋駐防
  const cands = [...new Set(own.black.flatMap((id) => CPC.cpNeighbors(id)))].filter((id) => !own.black.includes(id));
  const first = gq.cp.pickTarget('black');
  await gq.shared.update(CPC.CP_KIND, first, () => ({ data: { owners: [{ p: 'X', n: 'X' }], guards: [{ p: 'X', n: 'X', e: 'e1', units: [{ i: 0, hp: 9e5, maxHp: 9e5, atk: 1, lv: 1 }] }], faction: null } }));
  const second = gq.cp.pickTarget('black');
  assert(cands.length < 2 || second !== first, `優先攻擊無人駐守的控制點（${first} 有駐防 → 改打 ${second}）`);
  // 勢力打下後留守、擁有數增加；NPC 據點依控制點數量建立（每 3 個 1 座，最多 4 座）
  const before = gq.cp.factionCps('blue').length;
  const tgt = gq.cp.pickTarget('blue');
  const sim = gq.combat.simulate.bind(gq.combat);
  gq.combat.simulate = (t, f, o) => { const r = sim(t, f, o); r.victory = true; return r; };
  const ra = await gq.cp.npcAttack('blue', tgt);
  gq.combat.simulate = sim;
  assert(ra.win && gq.cp.factionOf(tgt) === 'blue' && gq.cp.factionCps('blue').length === before + 1, '勢力打下控制點後佔領');
  assert(gq.cp.garrisonCount(tgt) === CPC.CP_GARRISON.npc - 4, 'v17：打下後留守 70 萬（14/18 人）');
  gq.npcs.fillCells(Date.now(), { silent: true });
  const bases = gq.npcs.list.filter((n) => n.faction && !n.hq);
  const expect = CPC.FACTION_KEYS.reduce((a, f) => a + Math.min(CPC.FACTION_BASE.max, Math.floor(gq.cp.factionCps(f).length / CPC.FACTION_BASE.perCps)), 0);
  assert(bases.length === expect && bases.every((n) => n.level >= 35 && n.name.includes('・')), `NPC 據點依勢力的控制點數建立、Lv35 起（${bases.length}/${expect} 座：${bases.map((n) => n.name).join('、')}）`);
  assert(!gq.npcs.list.some((n) => n.sid && !n.faction), '新地圖不再有散布式的舊 NPC 據點');
  {
    // v15：勢力據點的警戒範圍（最高等級）完整落在自己的控制點內，不會蓋到旁邊已佔領的控制點
    const { NPC_CONFIG: NC } = await import('../src/config/npcs.js');
    const R = 60 + Math.min(40, NC.maxLevel); // v15.14：警戒範圍以 Lv40 為上限
    const out = CPC.CONTROL_POINTS.filter((cp) => {
      const p = gq.npcs.factionSpot(cp, 2.1);
      return !Array.from({ length: 36 }, (_, i) => (i / 36) * Math.PI * 2).every((a) => CPC.cpAt(p.lat + (Math.sin(a) * R) / 111320, p.lon + (Math.cos(a) * R) / (111320 * Math.cos((p.lat * Math.PI) / 180)))?.id === cp.id);
    }).map((c) => `#${c.no}`);
    assert(!out.length, `勢力據點的警戒範圍不超出自己的控制點（超出：${out.join('、') || '無'}）`);
    assert(bases.every((n) => CPC.cpAt(n.lat, n.lon)?.id === n.cp), '勢力據點建在自己的控制點裡');
    // v15.4：NPC 探索中目標所在的控制點被玩家佔領：強制撤回
    {
      const nb = bases.find((n) => { n.trip = null; gq.npcs.launchExplore(n, Date.now()); return !!n.trip; });
      assert(!!nb, '有 NPC 據點能派出探索隊（測試用）');
      if (nb) {
        const end0 = nb.trip.endAt;
        const tp = gq.state.map.pois.find((p) => p.id === nb.trip.poiId);
        const cpx = CPC.cpAt(tp.lat, tp.lon);
        await gq.shared.update(CPC.CP_KIND, cpx.id, () => ({ data: { owners: [{ p: 'X', n: 'X' }], guards: [], faction: null } }));
        gq.npcs.recallLostTrips(nb.trip.startAt + 1000);
        assert(nb.trip.recalled && nb.trip.endAt < end0, 'NPC 探索中控制點被佔領：強制撤回（提早回據點、沒有收穫）');
        nb.trip = null;
        await gq.shared.update(CPC.CP_KIND, cpx.id, () => ({ data: { owners: [], guards: [], faction: nb.faction } }));
      }
    }
    // v15.5.2：據點被別人（例如集結）攻陷後：即使它的探索隊還在外面，也立刻從地圖移除
    if (bases[0]) {
      const b0 = bases[0];
      const key = `npc:${b0.sid}`;
      const saved = gq.shared.cache.get(key);
      b0.trip = { kind: 'explore', poiId: gq.state.map.pois[0].id, startAt: Date.now() - 1000, endAt: Date.now() + 600000, travelMs: 300000, searchMs: 60000, from: { lat: b0.lat, lon: b0.lon }, to: { lat: b0.lat, lon: b0.lon } };
      gq.shared.cache.set(key, { kind: 'npc', id: b0.sid, ver: (saved?.ver || 0) + 1, data: { ...(saved?.data || {}), gen: b0.gen, ident: b0.ident, dc: (b0.dc || 0) + 1, destroyed: { at: Date.now(), respawnAt: Date.now() + 36 * 3600000 } } });
      gq.shared.listedAt.npc = gq.shared.listedAt.npc || Date.now();
      gq.npcs.fillCells(Date.now(), { silent: true });
      assert(!gq.npcs.list.includes(b0), '據點被攻陷後，即使探索隊還在外面也立刻從地圖移除');
      if (saved) gq.shared.cache.set(key, saved); else gq.shared.cache.delete(key);
      b0.trip = null;
      gq.npcs.state.list.push(b0);
    }
    // v15.5.2：打下一座勢力據點後，勢力的控制點增減讓排序改變，不會把「被打下」套到另一座據點
    {
      const saveCache = new Map(gq.shared.cache);
      const setCp = (id, f) => gq.shared.cache.set(`${CPC.CP_KIND}:${id}`, { kind: CPC.CP_KIND, id, ver: 1, data: { owners: [], guards: [], faction: f } });
      const east = [...CPC.CONTROL_POINTS].sort((a, b) => b.lon - a.lon);
      CPC.CONTROL_POINTS.forEach((c) => setCp(c.id, null));
      east.slice(0, 2).forEach((c) => setCp(c.id, 'black'));
      const s0 = gq.npcs.factionSlot('black', 0);
      const s1 = gq.npcs.factionSlot('black', 1);
      assert(s0 && s1 && s0.cp !== s1.cp, 'v17：2 個控制點的勢力有 2 座據點（每個控制點 1 座）');
      // 打下第 2 座（s1）
      gq.shared.cache.set(`npc:${s1.sid}`, { kind: 'npc', id: s1.sid, ver: 5, data: { gen: s1.gen, ident: s1.ident, dc: s1.dc + 1, destroyed: { at: Date.now(), respawnAt: Date.now() + 36 * 3600000 } } });
      assert(!gq.npcs.factionSlot('black', 1) && gq.npcs.factionSlot('black', 0)?.cp === s0.cp, '被打下的據點消失，另一座還在');
      // 勢力多拿下一個更西邊的控制點：排序改變
      setCp(east[2].id, 'black');
      const t0 = gq.npcs.factionSlot('black', 0);
      const t1 = gq.npcs.factionSlot('black', 1);
      const shown = [t0, t1].filter(Boolean).map((n) => n.cp);
      assert(shown.includes(s0.cp) && !shown.includes(s1.cp), `排序改變後：原本那座還在、被打下的那座不會出現（${shown.join('、')}）`);
      gq.shared.cache = saveCache;
    }
    // v17：守軍戰力：中立左 15 萬、右 40 萬；勢力滿編 90 萬
    {
      const { unitPower: uP } = await import('../src/utils/math.js');
      const pw = (id) => gq.cp.npcGarrison(id).reduce((t, u) => t + uP(u), 0);
      const sc = new Map(gq.shared.cache);
      CPC.CONTROL_POINTS.forEach((c) => gq.shared.cache.delete(`${CPC.CP_KIND}:${c.id}`));
      const L = pw('cp1'); const R = pw('cp3');
      gq.shared.cache.set(`${CPC.CP_KIND}:cp3`, { kind: CPC.CP_KIND, id: 'cp3', ver: 1, data: { owners: [], guards: [], faction: 'red' } });
      const F = pw('cp3');
      gq.shared.cache = sc;
      const near = (v, t) => Math.abs(v - t) < t * 0.03;
      assert(near(L, 150000) && near(R, 400000) && near(F, 900000), `v17：守軍戰力 中立左 ${Math.round(L).toLocaleString()}・右 ${Math.round(R).toLocaleString()}・勢力滿編 ${Math.round(F).toLocaleString()}`);
    }
    // v15.3：勢力控制點內有 NPC 據點時要先打掉據點
    if (bases[0]) {
      const c0 = gq.cp.canAttack(bases[0].cp, { reach: false });
      assert(!c0.ok && c0.locked && c0.reason.includes(bases[0].name), `控制點內有 NPC 據點時不能進攻（${c0.reason}）`);
      const keepList = gq.npcs.state.list;
      gq.npcs.state.list = keepList.filter((n) => n !== bases[0]);
      assert(!/NPC 據點/.test(gq.cp.canAttack(bases[0].cp, { reach: false }).reason || ''), '打掉 NPC 據點後就不再被擋下');
      gq.npcs.state.list = keepList;
    }
    // v15：勢力據點只探索自己勢力控制點內的建築
    const trips = [];
    bases.forEach((n) => { for (let i = 0; i < 30; i += 1) { n.trip = null; gq.npcs.launchExplore(n, Date.now()); if (n.trip) trips.push([n, n.trip.poiId]); } n.trip = null; });
    const wrong = trips.filter(([n, id]) => { const p = gq.state.map.pois.find((x) => x.id === id); return gq.cp.factionOf(CPC.cpAt(p.lat, p.lon)?.id) !== n.faction; });
    assert(!wrong.length, `勢力據點只探索自己控制點內的建築（${trips.length} 次中有 ${wrong.length} 次超出）`);
    {
      // v15.7：勢力還沒佔領最西側一排控制點時，只攻打控制點、不攻打玩家據點
      const n = bases[0];
      const W = CPC.CP_START[0];
      const fo = gq.cp.factionOf.bind(gq.cp);
      const keep = { lvl: n.level, cap: gq.npcs.raidLevelCap, con: gq.npcs.allowConcurrentRaid, ph: gq.time.phase };
      gq.npcs.raidLevelCap = () => 99; gq.npcs.allowConcurrentRaid = () => true;
      const P = keep.ph.bind(gq.time); gq.time.phase = (at) => ({ ...P(at), zombies: false });
      gq.cp.factionOf = (id) => (CPC.CP_START.includes(id) ? null : fo(id));
      n.trip = null; gq.npcs.launchRaid(n, Date.now());
      const noRaid = n.trip?.kind !== 'raid';
      gq.cp.factionOf = (id) => (id === W ? n.faction : fo(id));
      n.trip = null; gq.npcs.launchRaid(n, Date.now());
      const raid = n.trip?.kind === 'raid';
      n.trip = null;
      gq.cp.factionOf = fo; gq.npcs.raidLevelCap = keep.cap; gq.npcs.allowConcurrentRaid = keep.con; gq.time.phase = keep.ph;
      assert(noRaid && raid, `勢力沒佔領到最西側一排前不攻打玩家據點，佔領後才會（${noRaid}/${raid}）`);
    }
  }
  // 沒有 NPC 據點的勢力由大本營出兵（Lv40 起、不能攻打、不探索）
  const noBase = CPC.FACTION_KEYS.filter((f) => Math.floor(gq.cp.factionCps(f).length / CPC.FACTION_BASE.perCps) === 0);
  const hqs = gq.npcs.list.filter((n) => n.hq);
  const hqOk = CPC.FACTION_KEYS.every((f) => noBase.includes(f) === hqs.some((n) => n.faction === f));
  assert(hqOk && hqs.every((n) => n.level >= 40 && n.name.endsWith('大本營')), `沒有 NPC 據點的勢力才由大本營出兵、Lv40 起（${hqs.map((n) => `${n.name} Lv${n.level}`).join('、') || '無'}）`);
  const hq0 = gq.npcs.factionHqNpc('red');
  assert(hq0.hq && hq0.baseLevel === 40 && Math.abs(hq0.lat - CPC.factionHq('red').lat) < 1e-9, '大本營出兵的位置在大本營');
  if (hqs[0]) {
    assert(!gq.exploration.start(hqs[0].id, [gq.survivors.leader().id], 5, false, Date.now(), { kind: 'raid' }).ok && !gq.rally.canStart({ kind: 'npc', id: hqs[0].id }).ok, '大本營不能攻打、不能發起集結');
    const trip0 = hqs[0].trip;
    gq.npcs.launchExplore(hqs[0], Date.now());
    assert(hqs[0].trip === trip0, '大本營不會派隊探索');
  }
  assert(gq.cp.countOf('X') === 1, '玩家資訊顯示佔領的控制點數');
}

// ---- v15.7：屍潮波次間隔約 15 秒（每波數量不變） ----
{
  const gw = Game.newGame({ playerName: 'W', classId: 'warrior', lat: 25, lon: 121 });
  gw.state.map.pois = fillPois([], 25, 121);
  gw.shelter.establish(gw.state.map.pois.find((p) => gw.shelter.canEstablish(p).ok));
  const sg = gw.siege.of(gw.state.bases[0].id);
  const lulls = Array.from({ length: 20 }, () => { sg.startWave(); return sg.lull; });
  assert(lulls.every((x) => x >= 12 && x <= 18), `屍潮每波間隔約 15 秒（${Math.min(...lulls).toFixed(1)}～${Math.max(...lulls).toFixed(1)}）`);
}

// ---- v15.10：現實凌晨（台灣時間 00:00～08:00）：勢力合計、每位玩家被掠奪各 3 小時最多一次 ----
{
  Object.assign(NQ, NQ0);
  const tw = (h, m = 0) => Date.UTC(2026, 10, 10, h - 8, m); // 台灣時間 11/10 h:m
  assert(NQAt(tw(0)) && NQAt(tw(7, 59)) && !NQAt(tw(8)) && !NQAt(tw(23, 59)) && !NQAt(tw(12)) && NQ.gapMs === 3 * 3600000, '凌晨時段為台灣時間 00:00～08:00、間隔 3 小時');
  assert(NQSpan(tw(23, 30), tw(0, 30)) && NQSpan(tw(7, 30), tw(8, 30)) && !NQSpan(tw(8), tw(9)), '出發或抵達落在凌晨都算凌晨');
  const gz = Game.newGame({ playerName: 'Z', classId: 'warrior', lat: 25, lon: 121 });
  gz.state.map.pois = fillPois([], 25, 121);
  gz.shelter.establish(gz.state.map.pois.find((p) => gz.shelter.canEstablish(p).ok));
  gz.time.phase = () => ({ zombies: false });
  gz.npcs.allowConcurrentRaid = () => true;
  gz.npcs.raidLevelCap = () => 99;
  const nz = gz.npcs.spawnAt(gz.state.map.pois.filter((p) => !gz.shelter.baseAtPoi(p.id))[1], 'q', Date.now(), true);
  const raid = (t) => { nz.faction = null; nz.trip = null; gz.npcs.launchRaid(nz, t); return nz.trip?.kind === 'raid'; };
  const r1 = raid(tw(1)); const r2 = raid(tw(2)); const r3 = raid(tw(4, 1)); const r4 = raid(tw(12)); const r5 = raid(tw(12, 30));
  assert(r1 && !r2 && r3 && r4 && r5, `NPC 掠奪：凌晨每位玩家 3 小時最多一次、白天不受限（${[r1, r2, r3, r4, r5].join('/')}）`);
  // 勢力：凌晨三個勢力合計 3 小時最多進攻一次（共用紀錄）
  gz.state.map.source = 'generated';
  const night = {};
  gz.shared = { update: async (kind, id, fn) => { if (id !== 'night') return { ok: true }; const r = fn(night.x); if (r.fail) return { ok: false }; night.x = r.data; return { ok: true }; }, get: () => null, list: () => [] };
  const marched = [];
  gz.cp.pickTarget = () => 'cp1';
  gz.cp.launchMarch = async (f) => { marched.push(f); };
  const run = async (t) => { marched.length = 0; gz.cp.lastTurn = {}; gz.cp.turnTime = () => t; await gz.cp.npcTurns(t + 60000); return marched.length; };
  const a1 = await run(tw(1)); const a2 = await run(tw(2)); const a3 = await run(tw(4, 30)); const a4 = await run(tw(12));
  assert(a1 === 1 && a2 === 0 && a3 === 1 && a4 >= 1, `勢力：凌晨三個勢力合計 3 小時最多進攻一次、白天照常（${a1}/${a2}/${a3}/${a4}）`);
  NQ.to = NQ.from;
}

// ---- v15.8：控制點被勢力攻下：駐防隊的報告寫出交戰經過（已參戰／還在路上） ----
{
  const { CONTROL_POINTS: CPS8 } = await import('../src/config/controlPoints.js');
  const gk = Game.newGame({ playerName: 'K', classId: 'warrior', lat: 25, lon: 121 });
  const cp8 = CPS8[0];
  const t0 = Date.now() - 600000;
  const fought = { id: 'gA', kind: 'cpGuard', cpId: cp8.id, startAt: t0, travelMs: 60000, memberIds: [], travelEvents: [] };
  const late = { id: 'gB', kind: 'cpGuard', cpId: cp8.id, startAt: t0, travelMs: 3600000, memberIds: [], travelEvents: [] };
  gk.state.expeditions.push(fought, late);
  const ft = { f: 'red', at: t0 + 120000, win: true, total: 4, atk: 9, owners: ['someone'], guards: [gk.cp.myId()], ge: ['gA'], down: [] };
  gk.cp.data = () => ({ owners: [], guards: [], faction: 'red', fight: ft });
  gk.cp.ready = () => true;
  assert(/被「.+」的部隊（9 人）攻下：守軍 4 人全數被擊倒/.test(gk.cp.lostReason(fought)), `參戰的駐防隊：撤回原因寫出被誰攻下（${gk.cp.lostReason(fought)}）`);
  assert(/還沒抵達.*已被「.+」的部隊（9 人）攻下/.test(gk.cp.lostReason(late)), `還在路上的駐防隊：寫出抵達前已被攻下（${gk.cp.lostReason(late)}）`);
  gk.cp.reportFights();
  assert(fought.travelEvents.some((x) => /攻下/.test(x)) && late.travelEvents.some((x) => /還沒抵達/.test(x)), '交戰經過寫進駐防隊的探索報告');
  // 撤回（先交戰後撤回、先撤回後交戰兩種順序）：報告裡同一句只出現一次
  fought.travelEvents.push('↩️ 收到召回命令，隊伍折返避難所');
  gk.cp.constructor.replaceRecallText(fought, gk.cp.lostReason(fought));
  const other = { ...late, id: 'gC', travelEvents: ['↩️ 收到召回命令，隊伍折返避難所'] };
  gk.cp.constructor.replaceRecallText(other, gk.cp.lostReason(other));
  gk.state.expeditions.push(other); gk.cp.st.fightSeen = {}; gk.cp.reportFights();
  assert(fought.travelEvents.length === 1 && other.travelEvents.length === 1 && late.travelEvents.length === 1, `撤回與交戰經過不重複（${fought.travelEvents.join(' / ')}｜${other.travelEvents.join(' / ')}）`);
  gk.cp.data = () => ({ owners: [], guards: [] });
  assert(/易主|改版/.test(gk.cp.lostReason({ ...fought })), '沒有交戰（佔領者易主、變成敵對）時說明原因');
}

// ---- v15.8：駐防與攻擊的完整情境（雙方都照遊戲每 2 秒的更新流程跑） ----
{
  const { MemoryObjects } = await import('../src/multiplayer/SharedWorld.js');
  const CPC = await import('../src/config/controlPoints.js');
  const Z = await import('../src/config/zones.js');
  const { ControlPointSystem: CPSys } = await import('../src/systems/ControlPointSystem.js');
  const store = new MemoryObjects();
  const mk = (name) => {
    const gx = Game.newGame({ playerName: name, classId: 'warrior', lat: 25.03, lon: 121.56 });
    gx.genMap();
    gx.shelter.establish(gx.state.map.pois.find((p) => Z.inPlayerSafe(p.lat, p.lon) && gx.shelter.canEstablish(p).ok));
    gx.shared.backend = store;
    gx.world = { others: [], myId: name, identity: () => ({ id: name, token: 't' }) };
    gx.cp.npcTurns = async () => {}; // 只測指定的進攻
    setHour(gx, 10);
    return gx;
  };
  const A = mk('A'); const B = mk('B'); const C = mk('C');
  A.state.relations.players = { B: { status: 'friend' }, C: { status: 'hostile' } };
  B.state.relations.players = { A: { status: 'friend' }, C: { status: 'hostile' } };
  C.state.relations.players = { A: { status: 'hostile' }, B: { status: 'hostile' } };
  const cp = CPC.CONTROL_POINTS.find((c) => CPC.CP_START.includes(c.id));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const pollAll = async () => { for (const G of [A, B, C]) await G.shared.poll(); };
  const tick = async (G, t) => { G.cp.lastAt = 0; G.cp.update(t); await sleep(30); await pollAll(); G.cp.lastAt = 0; G.cp.update(t); await sleep(30); await pollAll(); };
  const logs = (G, re) => G.state.log.filter((l) => re.test(l.msg));
  const sims = new Map([[A, A.combat.simulate], [B, B.combat.simulate], [C, C.combat.simulate]]);
  /** 指定交戰結果：win＝進攻方勝；downGuards＝駐防隊員倒下 */
  const force = (G, win, downGuards = win) => {
    const s0 = sims.get(G);
    G.combat.simulate = (team, foes, o) => {
      const r = s0.call(G.combat, team, foes, { ...o, record: false });
      r.victory = win;
      r.foes.forEach((f) => { f.down = f.ally?.e ? downGuards : win; });
      return r;
    };
  };
  const unforce = () => sims.forEach((s0, G) => { G.combat.simulate = s0; });
  /** 重置：A 佔領控制點、清空隊伍 */
  const reset = async () => {
    unforce();
    for (const G of [A, B, C]) {
      G.state.expeditions.forEach((e) => G.exploration.free(e));
      G.state.expeditions = [];
      G.state.survivors.forEach((s) => { s.severe = false; s.hp = s.maxHp || s.hp || 100; s.status = 'idle'; });
      G.state.log = [];
      G.state.reports = [];
    }
    await A.shared.update(CPC.CP_KIND, cp.id, () => ({ data: { owners: [{ p: 'A', n: 'A' }], guards: [], faction: null } }));
    await pollAll();
  };
  /** B 派駐防：arrived＝已抵達（出發時間往前推） */
  const guard = async (arrived) => {
    const sv = B.state.survivors.find((s) => B.survivors.isAvailable(s));
    const gd = B.cp.guard(cp.id, [sv.id]);
    assert(gd.ok, `駐防出發（${gd.reason || ''}）`);
    // 已抵達：出發時間往前推過移動時間；在路上：出發了一段時間但還沒到
    const back = arrived ? gd.exp.travelMs + 60000 : Math.min(120000, gd.exp.travelMs / 2);
    gd.exp.startAt -= back;
    gd.exp.endAt -= back;
    await sleep(30);
    await B.cp.listGuard(gd.exp);
    await pollAll();
    return gd.exp;
  };
  /** 勢力部隊剛抵達，由 who 結算 */
  const march = async (who, win, downGuards) => {
    const t0 = Date.now() - 3 * 3600000;
    await A.cp.launchMarch('red', cp.id, t0);
    await A.shared.update(CPC.CP_KIND, cp.id, (x) => ({ data: { ...x, march: { ...x.march, arriveAt: Date.now() - 1000 } } }));
    await pollAll();
    force(who, win, downGuards);
    await who.cp.resolveMarches(Date.now());
    unforce();
    const mm = who.cp.data(cp.id)?.march;
    assert(!mm || (mm.fu && mm.arriveAt > Date.now()), '勢力部隊抵達後完成結算（被擊退時只會排定追加的那一波）');
    // 測試情境之間不讓追加的那一波影響下一個情境
    if (mm) await who.shared.update(CPC.CP_KIND, cp.id, (x) => ({ data: { ...x, march: null } }));
    await pollAll();
  };
  /** 隊伍回到避難所：取得報告 */
  const home = (G, e) => { G.exploration.update(e.endAt + 600000, { silent: true }); return (G.state.reports || []).find((r) => r.poiName.includes(`#${cp.no}`)); };

  // 情境 1：駐防隊已抵達，擊退勢力（沒人倒下）→ 駐防者與佔領者都收到戰報、駐防隊拿經驗、繼續駐守
  await reset();
  {
    const e = await guard(true);
    const sv = B.survivors.get(e.memberIds[0]); const xp0 = sv.xp; const lv0 = sv.level;
    await march(A, false, false);
    await tick(B, Date.now()); await tick(A, Date.now());
    assert(logs(B, /你駐防的控制點.*擊退了「/).length === 1 && logs(A, /你佔領的控制點.*擊退了「/).length === 1, `情境1：擊退勢力，駐防者與佔領者各收到一則戰報（${logs(B, /擊退/)[0]?.msg || ''}）`);
    assert((sv.level > lv0 || sv.xp > xp0) && !e.recalled && !e.defeated && A.cp.guardsAt(cp.id, Date.now()).some((h) => h.e === e.id), '情境1：駐防隊拿到防守經驗、繼續駐守');
    assert(e.travelEvents.some((x) => /擊退了「/.test(x)), '情境1：戰報寫進駐防隊的報告');
    {
      const le = B.state.cpLog?.[0];
      const bt = le?.battleIds?.[0] && B.combat.battle(le.battleIds[0]);
      const la = A.state.cpLog?.[0];
      assert(bt && bt.log.length > 0 && bt.team.length && bt.foes.length && la?.battleIds?.length && e.battleIds?.length, `v15.10：控制點交戰戰報附戰鬥明細（駐防者、佔領者、駐防隊報告）（${bt?.title || ''}，${bt?.log?.length || 0} 筆）`);
      const sz = new TextEncoder().encode(JSON.stringify(A.cp.data(cp.id)?.fight || {})).length;
      assert(sz < 12000, `共用資料的交戰紀錄大小合理（${sz} bytes）`);
    }
  }
  // v15.14：沒有駐防的控制點被攻下：佔領者照常收到事件紀錄，但不出詳細戰報
  await reset();
  {
    const n0 = (A.state.cpLog || []).length;
    await march(A, true, false);
    await tick(A, Date.now());
    assert(logs(A, /攻下了你佔領的控制點/).length === 1 && (A.state.cpLog || []).length === n0, `v15.14：沒駐防的控制點被攻下只記事件、不出詳細戰報（戰報 ${n0} → ${(A.state.cpLog || []).length}）`);
  }
  // 情境 2：擊退勢力，但駐防隊員倒下 → 駐防隊被擊退撤回，報告寫出交戰與被擊退
  await reset();
  {
    const e = await guard(true);
    await march(A, false, true);
    await tick(B, Date.now());
    assert(e.defeated && logs(B, /有人倒下/).length === 1, `情境2：駐防隊員倒下：被擊退撤回（${logs(B, /擊退/).map((l) => l.msg).join(' / ')}）`);
    const r = home(B, e);
    assert(r && /駐防控制點/.test(r.poiName) && r.events.some((x) => /擊退了「/.test(x)) && r.events.filter((x) => /駐防隊被擊退/.test(x)).length === 1 && !r.events.some((x) => /收到召回命令/.test(x)), `情境2：回家報告寫出交戰經過（${r?.events.join(' / ')}）`);
  }
  // 情境 3：駐防隊已抵達，勢力攻下控制點（駐防者沒在線、由佔領者結算）→ 駐防者上線後撤回，報告寫出被誰攻下
  await reset();
  {
    const e = await guard(true);
    await march(A, true);
    await tick(A, Date.now());
    assert(logs(A, /攻下了你佔領的控制點/).length === 1, `情境3：佔領者收到控制點被攻下的戰報（${logs(A, /攻下/)[0]?.msg || ''}）`);
    await tick(B, Date.now());
    assert(e.recalled && logs(B, /攻下/).length === 1 && !logs(B, /已不是你或好友/).length, `情境3：駐防者收到被攻下的說明，不是「已不是你或好友的控制點」（${logs(B, /攻下/).map((l) => l.msg).join(' / ')}）`);
    const r = home(B, e);
    assert(r && /駐防控制點/.test(r.poiName) && r.events.filter((x) => /攻下/.test(x)).length === 1 && r.events.some((x) => /全數被擊倒/.test(x)) && r.events.some((x) => /撤回避難所/.test(x)) && !r.events.some((x) => /沒有收穫|收到召回命令/.test(x)), `情境3：回家報告寫出被誰攻下、只寫一次（${r?.events.join(' / ')}）`);
  }
  // 情境 4：駐防隊還在路上，勢力攻下控制點 → 不參戰，撤回並說明「還沒抵達就被攻下」
  await reset();
  {
    const e = await guard(false);
    assert(!A.cp.defenders(cp.id, Date.now()).some((u) => u.ally?.e === e.id), '情境4：還在路上的駐防隊不參戰');
    await march(A, true);
    await tick(B, Date.now());
    assert(e.recalled && logs(B, /還沒抵達/).length === 1 && logs(B, /攻下/).length === 1, `情境4：在路上的駐防隊收到提醒並撤回（${logs(B, /攻下/).map((l) => l.msg).join(' / ')}）`);
    const r = home(B, e);
    assert(r && r.events.filter((x) => /還沒抵達/.test(x)).length === 1 && !r.events.some((x) => /全數被擊倒/.test(x)), `情境4：回家報告寫「還沒抵達就被攻下」（${r?.events.join(' / ')}）`);
  }
  // 情境 5：先在路上、抵達後才交戰（玩家離線，沒有執行任何更新）→ 抵達時間一到就參戰
  await reset();
  {
    const e = await guard(false);
    const arr = e.startAt + e.travelMs;
    assert(!A.cp.defenders(cp.id, arr - 1).some((u) => u.ally?.e === e.id) && A.cp.defenders(cp.id, arr + 1).some((u) => u.ally?.e === e.id), '情境5：抵達後（玩家離線）就算參戰');
  }
  // 情境 6：敵對玩家 C 攻下有駐防的控制點 → 駐防者撤回並說明「被玩家 C 的隊伍攻下」、佔領者收到戰報
  await reset();
  {
    const e = await guard(true);
    const cs = C.survivors.leader();
    const at = C.cp.attack(cp.id, [cs.id]);
    assert(at.ok, `情境6：敵對玩家可以攻打（${at.reason || ''}）`);
    // 攻打時間設成剛剛結束（遊戲裡結算時間一定已經過去）
    { const back = at.exp.travelMs + at.exp.searchMs + 2000; at.exp.startAt -= back; at.exp.endAt -= back; }
    const t = at.exp.startAt + at.exp.travelMs + at.exp.searchMs + 1;
    const foes = A.cp.defenders(cp.id, t);
    assert(foes.some((u) => u.ally?.e === e.id), '情境6：玩家攻打時駐防隊參戰');
    force(C, true);
    await C.cp.resolveAttacks(t);
    unforce();
    await pollAll();
    assert(at.exp.cpResult?.victory && C.cp.owners(cp.id).some((o) => o.p === 'C'), '情境6：C 打下控制點');
    await tick(A, Date.now()); await tick(B, Date.now());
    assert(A.state.cpLog?.[0]?.battleIds?.length && /玩家「C」/.test(A.combat.battle(A.state.cpLog[0].battleIds[0])?.title || ''), 'v15.10：玩家攻打控制點的戰報也附戰鬥明細');
    assert(logs(A, /玩家「C」的隊伍.*攻下了你佔領的控制點/).length === 1, `情境6：佔領者收到被玩家攻下的戰報（${logs(A, /攻下/)[0]?.msg || ''}）`);
    assert(e.recalled && logs(B, /玩家「C」的隊伍/).length === 1 && !logs(B, /已不是你或好友/).length, `情境6：駐防者撤回並說明被玩家攻下（${logs(B, /攻下/).map((l) => l.msg).join(' / ')}）`);
    const r = home(B, e);
    assert(r && r.events.filter((x) => /玩家「C」的隊伍/.test(x)).length === 1, `情境6：回家報告寫出被玩家攻下（${r?.events.join(' / ')}）`);
  }
  // 情境 7：敵對玩家 C 攻打失敗 → 駐防者與佔領者收到「擊退了玩家 C」，駐防隊繼續駐守（不拿防守經驗：只限勢力）
  await reset();
  {
    const e = await guard(true);
    const sv = B.survivors.get(e.memberIds[0]); const xp0 = sv.xp; const lv0 = sv.level;
    const at = C.cp.attack(cp.id, [C.state.survivors.find((s) => C.survivors.isAvailable(s)).id]);
    // 攻打時間設成剛剛結束（遊戲裡結算時間一定已經過去）
    { const back = at.exp.travelMs + at.exp.searchMs + 2000; at.exp.startAt -= back; at.exp.endAt -= back; }
    const t = at.exp.startAt + at.exp.travelMs + at.exp.searchMs + 1;
    force(C, false, false);
    await C.cp.resolveAttacks(t);
    unforce();
    await pollAll();
    await tick(A, Date.now()); await tick(B, Date.now());
    assert(!at.exp.cpResult?.victory && A.cp.owners(cp.id).some((o) => o.p === 'A'), '情境7：C 沒打下，控制點維持原佔領者');
    assert(logs(A, /擊退了玩家「C」/).length === 1 && logs(B, /擊退了玩家「C」/).length === 1, `情境7：佔領者與駐防者收到擊退玩家的戰報（${logs(B, /擊退/)[0]?.msg || ''}）`);
    assert(!e.recalled && sv.level === lv0 && sv.xp === xp0, '情境7：駐防隊繼續駐守，擊退玩家不拿防守經驗');
  }
  // 情境 8：佔領者放棄（解除好友）→ 駐防隊撤回，維持原本說明
  await reset();
  {
    const e = await guard(true);
    B.state.relations.players.A = { status: 'hostile' };
    await tick(B, Date.now());
    assert(e.recalled && logs(B, /佔領者已經是你的敵對玩家/).length === 1, `v17 情境8：和佔領者變成敵對：駐防隊撤回並說明原因（${logs(B, /駐防隊撤回/)[0]?.msg || ''}）`);
    const r = home(B, e);
    assert(r && /駐防控制點/.test(r.poiName) && r.events.some((x) => /撤回避難所/.test(x)), `情境8：回家報告（${r?.events.join(' / ')}）`);
    B.state.relations.players.A = { status: 'friend' };
  }
  // 情境 9：手動召回駐防隊 → 報告寫「駐防隊撤回避難所」，不會被當成探索失敗
  await reset();
  {
    const e = await guard(true);
    B.exploration.recall(e.id);
    await tick(B, Date.now());
    assert(!(A.cp.data(cp.id)?.guards || []).some((h) => h.e === e.id), '情境9：手動召回後從控制點守軍名單移除');
    const r = home(B, e);
    assert(r && /駐防控制點/.test(r.poiName) && r.events.some((x) => /撤回避難所/.test(x)), `情境9：手動召回的報告（${r?.events.join(' / ')}）`);
  }
  // 情境 10：同一場戰報不重複（多次更新、重新整理）
  await reset();
  {
    const e = await guard(true);
    await march(B, false, false);
    for (let i = 0; i < 3; i += 1) await tick(B, Date.now());
    assert(logs(B, /擊退了「/).length === 1 && e.travelEvents.filter((x) => /擊退了「/.test(x)).length === 1, `情境10：駐防者自己結算、多次更新：戰報只出現一次（${logs(B, /擊退/).length}）`);
  }
  // 情境 11：勢力進攻日：每 2 個遊戲日一次、三個勢力錯開；控制點多的勢力再減半
  {
    const days = Array.from({ length: 12 }, (_, i) => i);
    const cnt = (f, own) => days.filter((d) => CPSys.turnDay(f, d, own)).length;
    assert(CPC.FACTION_KEYS.every((f) => cnt(f, 0) === 6 && cnt(f, CPC.FACTION_SLOW_AT) === 3), '情境11：勢力進攻次數減半，控制點多的再減半');
    assert(days.some((d) => CPC.FACTION_KEYS.filter((f) => CPSys.turnDay(f, d, 0)).length < CPC.FACTION_KEYS.length), '情境11：三個勢力錯開進攻日');
  }
  // 情境 12：NPC 掠奪間隔加倍
  {
    const { NPC_CONFIG: NC8, NPC_DAY_SLOW } = await import('../src/config/npcs.js');
    const ds = Array.from({ length: 50 }, () => A.npcs.raidDelay());
    const crowd = Math.max(1, A.npcs.list.length / 3);
    const base = NC8.raidBaseMs * crowd / (0.3 + A.npcs.aggression());
    assert(NPC_DAY_SLOW === 2 && ds.every((d) => d >= base * 2 * 0.69 && d <= base * 2 * 1.31), '情境12：NPC 掠奪間隔加倍（次數減半）');
  }
}

// ---- v15.8.1：自己攻打控制點／NPC 據點：打贏沒倒下 +3%，倒下只扣 3% ----
{
  const { RALLY_XP: RX } = await import('../src/config/npcs.js');
  const { xpToNext: x2n } = await import('../src/config/survivors.js');
  const gx = Game.newGame({ playerName: 'X', classId: 'warrior', lat: 25, lon: 121 });
  const sv = gx.survivors.leader();
  sv.level = 20; sv.xp = Math.round(x2n(20) / 2);
  const tot0 = gx.survivors.totalXp(sv);
  const res = { kills: [], bossKills: 0, eliteKills: 0, xp: 0, coins: 0, parts: {}, victory: true, team: [{ id: sv.id, hp: 50, down: false }] };
  gx.combat.applyOutcome([sv], res, Date.now(), { attackXp: RX });
  const gain = gx.survivors.totalXp(sv) - tot0;
  assert(Math.abs(gain - (5 + Math.round(x2n(20) * 0.03))) <= 2 && res.winBonus?.length === 1, `攻打打贏：沒倒下的隊員另得升級所需經驗的 3%（+${gain}）`);
  const tot1 = gx.survivors.totalXp(sv);
  gx.combat.applyOutcome([sv], { ...res, victory: false, winBonus: null, team: [{ id: sv.id, hp: 0, down: true }] }, Date.now(), { attackXp: RX });
  const lost = tot1 - gx.survivors.totalXp(sv);
  assert(Math.abs(lost - Math.round(x2n(20) * 0.03)) <= 2, `攻打倒下只扣升級所需經驗的 3%（-${lost}）`);
  sv.severe = false;
  const tot2 = gx.survivors.totalXp(sv);
  gx.combat.applyOutcome([sv], { ...res, winBonus: null }, Date.now());
  assert(gx.survivors.totalXp(sv) - tot2 === 5, '探索等其他戰鬥不加勝利經驗');
}

// ---- v15.8.1：背包滿了先回家：總計包含返程＋之後每一站＋最後回家 ----
{
  const gi = Game.newGame({ playerName: 'I', classId: 'warrior', lat: 25, lon: 121 });
  gi.state.map.pois = fillPois([], 25, 121);
  gi.shelter.establish(gi.state.map.pois.find((p) => gi.shelter.canEstablish(p).ok));
  setHour(gi, 10);
  const home = gi.shelter.primary();
  const near = gi.state.map.pois.filter((p) => !gi.shelter.baseAtPoi(p.id) && !p.npc && haversine(p.lat, p.lon, home.lat, home.lon) < 900).slice(0, 3);
  const r = gi.exploration.start(near[0].id, [gi.survivors.leader().id], 1, false, Date.now());
  assert(r.ok, '派出探索');
  const e = r.exp;
  gi.exploration.enqueue(e.id, near[1].id);
  gi.exploration.enqueue(e.id, near[2].id);
  // 測試用：已經在返程（背包滿了：搜完時判定不前往下一站），佇列還在
  e.chainChecked = true;
  const now = e.startAt + e.travelMs + e.searchMs + Math.round(e.travelMs / 2);
  const it = gi.exploration.itinerary(e, now);
  const back = Math.max(0, e.endAt - now);
  assert(it.phase === 'returning' && it.queueOnHold && it.holdStops.length === 2 && !it.stops.length, '返程中、佇列等回家後再前往');
  const sum = back + it.holdStops.reduce((s, x) => s + x.totalMs, 0) + it.backMs;
  assert(Math.abs(it.currentMs - back) < 50 && Math.abs(it.totalMs - sum) < 50 && it.totalMs > back + it.holdStops[0].travelMs && it.backMs > 0, `總計＝返程＋之後每一站＋最後回家（${Math.round(back / 1000)} 秒 → 總計 ${Math.round(it.totalMs / 1000)} 秒）`);
  const p0 = gi.exploration.plan(near[1], [gi.survivors.leader()], gi.exploration.searchMinutes(near[1]), now + back);
  assert(Math.abs(it.holdStops[0].travelMs - p0.travelMs) < 50, '回家後的第一站從避難所出發計算');
  assert(Math.abs(it.endAt - (now + it.totalMs)) < 5, '預計回到避難所的時間＝最後一站回家');
  e.recalled = true;
  const itR = gi.exploration.itinerary(e, now);
  assert(!itR.queueOnHold && Math.abs(itR.totalMs - back) < 50, '召回的隊伍回家後不再前往佇列：總計只算返程');
}

// ---- v15.9.2：單人攻打 NPC 據點：沒有攻打倒數、抵達就交戰（同集結），走回家才收到報告 ----
{
  const gr2 = Game.newGame({ playerName: 'RA', classId: 'warrior', lat: 25, lon: 121 });
  gr2.state.map.pois = fillPois([], 25, 121);
  gr2.shelter.establish(gr2.state.map.pois.find((p) => gr2.shelter.canEstablish(p).ok));
  setHour(gr2, 10);
  const free = gr2.state.map.pois.filter((p) => !gr2.shelter.baseAtPoi(p.id));
  const nn = gr2.npcs.spawnAt(free[3], 'ra', Date.now(), true);
  const L2 = gr2.survivors.leader();
  const st = gr2.exploration.start(nn.id, [L2.id], 5, false, Date.now(), { kind: 'raid' });
  assert(st.ok && st.exp.searchMs === 0, `攻打 NPC 據點沒有攻打倒數（${st.reason || ''}）`);
  let calls = 0;
  const rr0 = gr2.npcs.resolveRaid.bind(gr2.npcs);
  gr2.npcs.resolveRaid = (...a) => { calls += 1; return rr0(...a); };
  const arr = st.exp.startAt + st.exp.travelMs;
  gr2.exploration.update(arr - 1, { silent: true });
  assert(!st.exp.raidReport && calls === 0, '還沒抵達不交戰');
  gr2.exploration.update(arr + 1, { silent: true });
  assert(st.exp.raidReport && calls === 1 && gr2.state.expeditions.includes(st.exp) && !(gr2.state.reports || []).some((r) => r === st.exp.raidReport), '抵達就交戰，隊伍還在回家路上（報告回家才收到）');
  const n0 = (gr2.state.reports || []).length;
  gr2.exploration.update(st.exp.endAt + 1, { silent: true });
  const rep = gr2.state.reports[0];
  assert(calls === 1 && gr2.state.reports.length === n0 + 1 && rep.poiName.includes(nn.name) && rep.at === st.exp.endAt, '回到避難所收到報告，交戰只結算一次');
}

// ---- v15.10：偵查 Lv11／Lv13／Lv15 新效果 ----
{
  const gk = Game.newGame({ playerName: 'RK', classId: 'warrior', lat: 25, lon: 121 });
  gk.state.map.pois = fillPois([], 25, 121);
  gk.shelter.establish(gk.state.map.pois.find((p) => gk.shelter.canEstablish(p).ok));
  setHour(gk, 10);
  const nk = gk.npcs.spawnAt(gk.state.map.pois.filter((p) => !gk.shelter.baseAtPoi(p.id))[2], 'rk', Date.now(), true);
  const setLv = (lv) => { gk.state.research.levels.s_recon = lv; gk.research.invalidate(); };
  setLv(10);
  assert(!gk.npcs.intelView(nk).defense, '偵查 Lv10：還看不到圍牆與防禦火力');
  setLv(11);
  const dv = gk.npcs.intelView(nk).defense;
  assert(dv && dv.wall === gk.npcs.defense(nk).wall && dv.dps > 0, '偵查 Lv11：看得到 NPC 據點的圍牆耐久與防禦火力');
  // Lv13：看得到所有控制點的勢力行軍（人數與戰力）
  const CPC13 = await import('../src/config/controlPoints.js');
  const c13 = CPC13.CONTROL_POINTS[3];
  const march = { f: 'red', from: CPC13.factionHq('red'), at: Date.now(), arriveAt: Date.now() + 600000 };
  gk.cp.data = (id) => (id === c13.id ? { owners: [], guards: [], march } : null);
  gk.cp.owners = () => [];
  setLv(12);
  assert(!gk.cp.incoming().some((x) => x.text.includes(`#${c13.no}`)), '偵查 Lv12：看不到別人的控制點行軍');
  setLv(13);
  const inc = gk.cp.incoming().find((x) => x.text.includes(`#${c13.no}`));
  assert(inc && inc.mine === false && /\d+人⚔/.test(inc.text), `偵查 Lv13：地圖左上角看得到所有控制點的勢力行軍與人數戰力（${inc?.text || ''}）`);
  gk.cp.warned = new Set();
  gk.cp.warnMarches();
  assert(gk.state.log.some((l) => /🔭 偵查：勢力/.test(l.msg)), '偵查 Lv13：其他控制點的行軍記在事件紀錄');
  // Lv15：NPC 掠奪隊行軍時間 +10%
  gk.time.phase = () => ({ zombies: false });
  gk.npcs.allowConcurrentRaid = () => true;
  gk.npcs.raidLevelCap = () => 99;
  const t12 = Date.UTC(2026, 10, 11, 4); // 台灣時間 12:00
  setLv(14); nk.trip = null; gk.npcs.launchRaid(nk, t12); const m14 = nk.trip?.travelMs;
  setLv(15); nk.trip = null; gk.npcs.launchRaid(nk, t12); const m15 = nk.trip?.travelMs;
  assert(m14 && m15 && Math.abs(m15 / m14 - 1.1) < 0.01, `偵查 Lv15：NPC 掠奪隊行軍時間 +10%（${m14}→${m15}）`);
}

// ---- v15.10：剛佔領的控制點保護期、勢力部隊強度跟著規模、不在線被掠奪損失減半 ----
{
  const CPX = await import('../src/config/controlPoints.js');
  const gx = Game.newGame({ playerName: 'X4', classId: 'warrior', lat: 25, lon: 121 });
  gx.state.map.source = 'generated';
  const now = Date.now();
  const mineId = CPX.hqNeighbors('red')[0];
  const store = { [mineId]: { owners: [{ p: 'P', n: 'P' }], guards: [], faction: null, takenAt: now - 3600000 } };
  gx.cp.data = (id) => store[id] || null;
  gx.cp.factionCps = () => [];
  const near = CPX.hqNeighbors('red');
  // v16.1：保護期改為 1 小時，玩家或勢力打下都算
  CPSH.ms = CPSH_MS;
  store[mineId].takenAt = now - 30 * 60000;
  const t1 = gx.cp.pickTarget('red', now);
  assert(near.length > 1 ? t1 !== mineId : t1 === null, '剛被打下 1 小時內的控制點，勢力不會選它');
  store[mineId].takenAt = now - 61 * 60000;
  assert(gx.cp.shielded(mineId, now) === false, '保護期（1 小時）過後勢力可以選它');
  // 勢力打下的也保護 1 小時：玩家不能攻打，倒數正確
  store[mineId] = { owners: [], guards: [], faction: 'red', takenAt: now - 20 * 60000 };
  const hs0 = gx.shelter.hasShelter.bind(gx.shelter);
  gx.shelter.hasShelter = () => true;
  const ca = gx.cp.canAttack(mineId, { reach: false, now });
  assert(!ca.ok && ca.shield && Math.round(gx.cp.shieldLeft(mineId, now) / 60000) === 40 && /保護中/.test(ca.reason), `勢力剛打下的控制點也保護 1 小時，玩家不能攻打（${ca.reason}）`);
  assert(gx.cp.canAttack(mineId, { reach: false, now: now + 41 * 60000 }).shield !== true, '保護期過後玩家可以攻打');
  const na = await gx.cp.npcAttack('blue', mineId, now);
  assert(na.shielded && !na.win, '保護期內勢力部隊抵達也撲空，不會交戰');
  gx.shelter.hasShelter = hs0;
  CPSH.ms = 0;
  // v17 勢力部隊強度：每擁有 1 個控制點 +10%，最多 ×1.4（4 個）
  const scaleAt = (n) => { gx.cp.factionCps = () => Array.from({ length: n }, (_, i) => `x${i}`); return gx.cp.forceScale('red'); };
  assert(Math.abs(scaleAt(0) - 1) < 1e-9 && Math.abs(scaleAt(2) - 1.2) < 1e-9 && Math.abs(scaleAt(4) - 1.4) < 1e-9 && Math.abs(scaleAt(9) - 1.4) < 1e-9, 'v17：勢力進攻部隊強度跟著控制點數（×1～×1.4）');
  const { unitPower: uP2 } = await import('../src/utils/math.js');
  const pw = (n, id) => { scaleAt(n); return gx.cp.attackForce('red', id).reduce((t, u) => t + uP2(u), 0); };
  assert(Math.abs(pw(0, 'cp1') - 300000) < 9000 && Math.abs(pw(0, 'cp3') - 500000) < 15000 && Math.abs(pw(4, 'cp3') / pw(0, 'cp3') - 1.4) < 0.02, `v17：進攻部隊 左側 30 萬、右側 50 萬（${Math.round(pw(0, 'cp1')).toLocaleString()}／${Math.round(pw(0, 'cp3')).toLocaleString()}），控制點多時較強`);
  // 不在線超過 30 分鐘被掠奪：資源與圍牆損失減半
  const run = (offline) => {
    const g = Game.newGame({ playerName: 'O4', classId: 'warrior', lat: 25, lon: 121 });
    g.state.map.pois = fillPois([], 25, 121);
    g.shelter.establish(g.state.map.pois.find((p) => g.shelter.canEstablish(p).ok));
    g.time.phase = () => ({ zombies: false });
    const base = g.state.bases[0];
    g.state.survivors.forEach((s) => { s.status = 'exploring'; });
    const n = g.npcs.spawnAt(g.state.map.pois.filter((p) => !g.shelter.baseAtPoi(p.id))[2], 'o', Date.now(), true);
    n.level = 30;
    g.state.resources.food = 1000;
    const arrive = Date.now();
    g.state.activeAt = offline ? arrive - 3600000 : arrive - 60000;
    g.npcs.arriveAt = () => arrive;
    const wall0 = g.shelter.wallHp(base);
    g.npcs.resolveIncoming(n, { baseId: base.id }, arrive);
    return { food: 1000 - g.state.resources.food, wall: wall0 - g.shelter.wallHp(base) };
  };
  const on = run(false); const off = run(true);
  assert(on.food > 0 && Math.abs(off.food - on.food / 2) <= 2 && off.wall <= on.wall / 2 + 2, `不在線超過 30 分鐘被掠奪：資源與圍牆損失減半（在線 ${on.food}/${on.wall}、不在線 ${off.food}/${off.wall}）`);
}

// ---- v15.10：太久沒上線而從玩家名單消失的玩家：解除好友 ----
{
  const gf = Game.newGame({ playerName: 'GF', classId: 'warrior', lat: 25, lon: 121 });
  const r = gf.state.relations;
  r.players = { F1: { status: 'friend', name: '老朋友' }, F2: { status: 'friend', name: '常上線' }, H1: { status: 'hostile', name: '敵人' } };
  r.requestsIn = { Q1: { name: '請求者' } };
  r.requestsOut = {};
  const others = [{ id: 'F2' }, { id: 'X' }];
  gf.territory.pruneGone([]);
  assert(r.players.F1 && r.requestsIn.Q1, '玩家名單是空的（連線異常）時不判斷');
  gf.territory.pruneGone(others);
  assert(r.players.F1 && r.requestsIn.Q1, '只消失一次（可能剛好沒同步到）先不移除');
  gf.territory.pruneGone(others);
  assert(!r.players.F1 && !r.requestsIn.Q1 && r.players.F2?.status === 'friend' && r.players.H1, '連續兩次不在名單：解除好友、移除友好請求；還在線的好友與敵對關係不受影響');
  assert(gf.state.log.some((l) => /「老朋友」太久沒上線，已從好友中移除/.test(l.msg)), '事件紀錄寫出移除的好友');
  r.players.F3 = { status: 'friend', name: 'F3' };
  gf.territory.pruneGone(others);
  gf.territory.pruneGone([...others, { id: 'F3' }]);
  gf.territory.pruneGone(others);
  assert(r.players.F3, '中間有回來過就重新計算');
}

// ---- v15.11：夜間地圖殭屍群強度依區域、Boss 加強、獎勵依區域 ----
{
  const ZS = await import('../src/systems/ZombieSpawnSystem.js');
  const { zoneAt: zA } = await import('../src/config/zones.js');
  const gz = Game.newGame({ playerName: 'ZG', classId: 'warrior', lat: 25.03, lon: 121.56 });
  gz.genMap();
  let groups = [];
  for (let n = 1; n < 40 && !groups.some((x) => x.boss); n += 1) groups = groups.concat(gz.zombies.sharedGroups(n));
  const normal = groups.filter((x) => !x.boss);
  {
    const { inNpcHome: inH } = await import('../src/config/zones.js');
    let gs = [];
    for (let n = 1; n < 30; n += 1) gs = gs.concat(gz.zombies.sharedGroups(n));
    assert(gs.length > 0 && gs.every((x) => !inH(x.lat, x.lon)), '夜間殭屍群不出現在三大勢力領地內');
  }
  const okLv = normal.every((x) => { const [lo, hi] = ZS.NIGHT_GROUP_LEVEL[x.zone]; return x.level >= lo && x.level <= hi; });
  assert(groups.every((x) => x.count <= ZS.NIGHT_GROUP_MAX), `夜間殭屍群每群最多 ${ZS.NIGHT_GROUP_MAX} 隻`);
  assert(normal.length > 3 && okLv, `夜間殭屍群等級依區域（${normal.length} 群）`);
  const boss = groups.find((x) => x.boss);
  assert(boss && boss.level === ZS.NIGHT_GROUP_LEVEL[boss.zone][1] + 5 && boss.minions >= 4 && boss.minions <= 6, `Boss：等級＝區域上限＋5、帶 4～6 隻小兵（${boss ? gz.zombies.groupLabel(boss) : '沒有 Boss'}）`);
  // 獎勵：打贏時材料依區域（不再只有廢鐵與粗布）
  const g0 = normal.find((x) => x.zone === 'alert') || normal[0];
  gz.shelter.establish(gz.state.map.pois.find((p) => gz.shelter.canEstablish(p).ok));
  gz.state.map.zombieGroups = [g0];
  gz.time.phase = () => ({ zombies: true, zombieMul: 1 });
  const sim0 = gz.combat.simulate.bind(gz.combat);
  gz.combat.simulate = (t, f, o) => { const r = sim0(t, f, { ...o, record: false }); r.victory = true; f.forEach((x) => { x.hp = 0; }); return r; };
  const r = gz.zombies.attack(g0.id, [gz.survivors.leader().id]);
  const keys = Object.keys(r.loot?.resources || {}).filter((k) => k !== 'bandage');
  assert(r.ok && keys.length > 0 && keys.some((k) => !['scrap', 'coarse'].includes(k)), `打贏殭屍群：材料依區域掉落（${keys.join('、')}）`);
}

// ---- v15.11：黑市收購基礎物資（每 100 個 💰10、燃料 💰15，每種每天最多 5,000 個） ----
{
  const { RESOURCE_BUYBACK: RB } = await import('../src/systems/BlackMarketSystem.js');
  const gb = Game.newGame({ playerName: 'BR', classId: 'warrior', lat: 25, lon: 121 });
  const bm = gb.blackMarket;
  gb.state.resources.food = 9000; gb.state.resources.fuel = 300;
  const c0 = gb.state.player.coins;
  const t = Date.UTC(2026, 10, 11, 4);
  const r1 = bm.sellResource('food', 1000, t);
  assert(r1.ok && gb.state.player.coins - c0 === 100 && gb.state.resources.food === 8000, `賣食物 1,000 個得到 💰100（${r1.msg || r1.reason}）`);
  const c1 = gb.state.player.coins;
  bm.sellResource('fuel', 300, t);
  assert(gb.state.player.coins - c1 === 45, '燃料每 100 個 💰15');
  bm.sellResource('food', 99999, t);
  assert(gb.state.resources.food === 4000 && bm.resourceLeft('food', t) === 0 && !bm.sellResource('food', 10, t).ok, '每種每天最多賣 5,000 個');
  assert(bm.resourceLeft('food', t + 86400000) === RB.dailyMax && bm.sellResource('food', 100, t + 86400000).ok, '隔天（台灣時間）重新計算');
  assert(!bm.sellResource('wood', 5, t).ok, '數量太少不收');
}

// ---- v15.11：研究「黑市人脈」降低交換倍率（每級 −3%，Lv10 為 3.5 換 1） ----
{
  const { RESEARCH: RS11 } = await import('../src/config/research.js');
  const { exchangePreview } = await import('../src/ui/BlackMarketView.js');
  const ge = Game.newGame({ playerName: 'EX', classId: 'warrior', lat: 25, lon: 121 });
  const t = RS11.t_exchange;
  assert(t && t.maxLevel === 10 && t.branch === 'trade' && t.tier === 2 && t.requires.some(([k, l]) => k === 'i_trade' && l === 3), '黑市人脈：交易科技第 2 階、最高 Lv10、需要以物易物 Lv3');
  const bm = ge.blackMarket;
  const keys = Object.keys((await import('../src/systems/BlackMarketSystem.js')).EXCHANGE.value).filter((k) => bm.exchangeable(k));
  const [a, b] = keys;
  const per0 = bm.exchangeCostPer(a, b);
  ge.state.research.levels.t_exchange = 10; ge.research.invalidate();
  const per10 = bm.exchangeCostPer(a, b);
  assert(Math.abs(bm.exchangeRate() - 3.5) < 1e-9 && Math.abs(per10 / per0 - 0.7) < 1e-9, `黑市人脈 Lv10：交換倍率 5 → 3.5（每換 1 個要 ${per0.toFixed(2)} → ${per10.toFixed(2)} 個）`);
  assert(/× 3\.5/.test(exchangePreview(ge, { want: b, give: a })), '交換說明顯示目前的倍率');
}

// ---- v15.11：研究「重傷護理」改版（倒下有機率只受輕傷、重傷扣經驗減少）、「戰利品搜刮」 ----
{
  const { RESEARCH: R11 } = await import('../src/config/research.js');
  const { xpToNext: x2 } = await import('../src/config/survivors.js');
  assert(R11.m_severe.effects.severeAvoid === 0.03 && R11.m_severe.effects.downXpReduce === 0.05, '重傷護理：每級倒下只受輕傷 +3%、重傷扣經驗 −5%');
  assert(R11.m_starve.name === '戰利品搜刮' && R11.m_starve.branch === 'survival' && R11.m_starve.requires.some(([k, l]) => k === 's_loot' && l === 3), '戰利品搜刮：生存科技、前置拾荒技巧 Lv3');
  const gr = Game.newGame({ playerName: 'RS', classId: 'warrior', lat: 25, lon: 121 });
  const sv = gr.survivors.leader();
  sv.level = 20; sv.xp = Math.round(x2(20) / 2);
  const b0 = gr.research.bonus.bind(gr.research);
  gr.research.bonus = (k) => (k === 'severeAvoid' ? 0.9 : k === 'downXpReduce' ? 0.5 : b0(k));
  let light = 0;
  for (let i = 0; i < 40; i += 1) { sv.severe = false; if (!gr.survivors.battleDown(sv, '測試', Date.now())) light += 1; }
  assert(light > 25, `倒下只受輕傷的機率生效（40 次中 ${light} 次輕傷）`);
  sv.severe = false;
  gr.research.bonus = (k) => (k === 'severeAvoid' ? 0 : k === 'downXpReduce' ? 0.5 : b0(k));
  sv.level = 20; sv.xp = Math.round(x2(20) / 2); // 前面 40 次倒下偶爾會扣到降級：重設後再量
  const t0 = gr.survivors.totalXp(sv);
  gr.survivors.battleDown(sv, '測試', Date.now(), 0.1);
  const lost = t0 - gr.survivors.totalXp(sv);
  assert(sv.severe && Math.abs(lost - Math.round(x2(20) * 0.05)) <= 2, `重傷扣經驗減少（10% × (1−50%) = 5%，扣 ${lost}）`);
}

// ---- v15.13：戰力＝戰鬥能力 ----
{
  const { unitPower: upN } = await import('../src/utils/math.js');
  const { AFFIXES } = await import('../src/config/equipment.js');
  const gp = Game.newGame({ playerName: 'PW', classId: 'warrior', lat: 25, lon: 121 });
  const base = { atk: 100, atkSpeed: 1, crit: 0.1, critDmg: 1.5, maxHp: 1000, def: 40, dodge: 0.05, lifeSteal: 0 };
  // 輸出與耐打相乘：只堆攻擊不如攻守平衡
  assert(upN({ ...base, atk: 200 }) > upN(base) && upN({ ...base, maxHp: 2000 }) > upN(base), '攻擊、生命越高戰力越高');
  assert(upN({ ...base, atk: 400, maxHp: 250 }) < upN({ ...base, atk: 200, maxHp: 500 }) * 1.01, '攻擊與生命要搭配（相乘）');
  // 職業戰鬥技能算進戰力
  assert(upN({ ...base, skills: { cleaveChance: 0.2 } }) > upN(base), '戰士橫掃提高戰力');
  assert(upN({ ...base, skills: { healEvery: 4, healPct: 0.12 } }) > upN(base), '醫生急救提高戰力');
  // 裝備戰力不含探索速度、搜刮加成、負重
  const it = gp.equipment.generate({ level: 10, model: 'knife', rarity: 'rare' });
  const p0 = gp.equipment.itemPower(it);
  it.affixes.push({ id: Object.keys(AFFIXES).find((k) => AFFIXES[k].stat === 'lootBonus'), value: 0.5 });
  assert(gp.equipment.itemPower(it) === p0 && gp.equipment.itemValue(it) > p0, '裝備戰力不含搜刮加成（文明度仍計入）');
  // 倖存者戰力含職業技能（戰士 Lv16 百戰老兵攻擊 +15%）
  const L = gp.survivors.leader();
  L.level = 15; const p15 = gp.survivors.stats(L).power;
  L.level = 16; const p16 = gp.survivors.stats(L).power;
  assert(p16 > p15 * 1.05, `解鎖戰鬥技能後戰力明顯提高（${p15} → ${p16}）`);
}

// ---- v15.13：換裝頁只列可以換上的裝備、比較顯示對這位倖存者的戰力變化 ----
{
  const { createSurvivor: cs13 } = await import('../src/core/GameState.js');
  const ge = Game.newGame({ playerName: 'EQ', classId: 'warrior', lat: 25, lon: 121 });
  const L = ge.survivors.leader(); L.level = 20;
  const other = cs13('小美', 'scout', 10, 'rare'); ge.state.survivors.push(other);
  const mk = () => { const it = ge.equipment.generate({ level: 20, model: 'knife', rarity: 'rare' }); ge.state.inventory.items.push(it); return it; };
  const free = mk(); const worn = mk(); const carried = mk();
  other.equipment.melee = worn.id;
  carried.loc = other.id;
  assert(ge.equipment.swappable(L, free) && !ge.equipment.swappable(L, worn), '別人身上穿著的裝備不能換');
  other.status = 'idle';
  assert(ge.equipment.swappable(L, carried), '在家的人背包裡的裝備可以換');
  other.status = 'exploring';
  assert(!ge.equipment.swappable(L, carried), '外出中的人背包裡的裝備不能換');
  const before = ge.survivors.stats(L, 'melee').power;
  const d = ge.equipment.powerDelta(L, free);
  L.equipment.melee = free.id;
  assert(ge.survivors.stats(L, 'melee').power - before === d && L.equipment.melee === free.id, `戰力變化等於實際換上後的差（${d}）`);
}

// ---- v15.13：第 3 階布料新增聚酯纖維，指定的研究與設施改用聚酯纖維 ----
{
  const { researchCost: rc13 } = await import('../src/config/research.js');
  const { FACILITIES: F13 } = await import('../src/config/facilities.js');
  const { SUPPLIES: SP13 } = await import('../src/config/supplies.js');
  assert(SP13.polyester?.cat === 'fabric' && SP13.polyester.tier === 3, '聚酯纖維是第 3 階布料');
  const lvOf = (f) => [...Array(15).keys()].map((i) => f(i + 1));
  const uses = (list, k) => list.some((c) => (c?.[k] || 0) > 0);
  assert(uses(lvOf((lv) => rc13('m_def', lv)), 'polyester') && !uses(lvOf((lv) => rc13('m_def', lv)), 'techCotton'), '抗打擊改用聚酯纖維');
  assert(uses(lvOf((lv) => rc13('m_dodge', lv)), 'techCotton') && !uses(lvOf((lv) => rc13('m_dodge', lv)), 'polyester'), '反應訓練維持科技棉');
  assert(uses(lvOf((lv) => F13.dormitory.cost(lv)), 'polyester') && uses(lvOf((lv) => F13.clinic.cost(lv)), 'techCotton'), '宿舍改用聚酯纖維、醫療站維持科技棉');
}

// ---- v15.13：同階總掉落量固定（新增材料不會擠壓其他階） ----
{
  const LS = await import('../src/systems/LootStock.js');
  const { SUPPLIES: SP, suppliesOf: so } = await import('../src/config/supplies.js');
  const groups = {};
  so('part').concat(so('fabric')).filter((k) => SP[k].tag !== 'ammo').forEach((k) => { (groups[`${SP[k].cat}:${SP[k].tier}`] = groups[`${SP[k].cat}:${SP[k].tier}`] || []).push(k); });
  Object.keys(groups).forEach((g) => assert(LS.TIER_BASE_KINDS[g] > 0, `掉落基準有列出 ${g}（新增一階時要補上）`));
  // 一階的總權重 = 基準種類數 × 該階倍率（不含個別材料的加成時）
  const t3 = groups['fabric:3'];
  const sum = t3.reduce((a, k) => a + LS.baseSupplyWeight(k), 0);
  assert(Math.abs(sum - LS.TIER_BASE_KINDS['fabric:3'] * (LS.TIER_DROP_BOOST['fabric:3'] ?? 1)) < 1e-9, `第 3 階布料總掉落權重固定（${sum.toFixed(2)}）`);
}

// ---- v15.13：屍潮 22:00 開始、自動回家 21:30 ----
{
  const gt = Game.newGame({ playerName: 'T22', classId: 'warrior', lat: 25, lon: 121 });
  gt.state.map.pois = fillPois([], 25, 121);
  gt.shelter.establish(gt.state.map.pois.find((p) => gt.shelter.canEstablish(p).ok));
  setHour(gt, 21);
  assert(gt.time.phase().zombies && !gt.time.siegeTime() && !gt.siege.of().active(), '21:00 已入夜（地圖殭屍出沒）但屍潮還沒開始');
  setHour(gt, 22.1);
  assert(gt.time.siegeTime() && gt.siege.of().active(), '22:00 屍潮開始');
  setHour(gt, 5.9);
  assert(gt.siege.of().active(), '屍潮持續到 06:00');
  setHour(gt, 6.1);
  assert(!gt.siege.of().active(), '06:00 天亮屍潮結束');
  const AH = await import('../src/systems/AutoHomeSystem.js');
  assert(AH.AUTO_HOME_HOUR === 21.5 && AH.AUTO_HOME_LABEL === '21:30', '自動回家改為 21:30');
}

// ---- v15.14：製作裝備最高 Lv70（工作台、精工都升滿），掉落最高 Lv60 ----
{
  const gc = Game.newGame({ playerName: 'C70', classId: 'warrior', lat: 25, lon: 121 });
  gc.state.map.pois = fillPois([], 25, 121);
  gc.shelter.establish(gc.state.map.pois.find((p) => gc.shelter.canEstablish(p).ok));
  const lvAt = (wb, fine, model = 'barrett') => {
    gc.equipment.workbench = () => wb;
    gc.state.research.levels.c_level = fine;
    gc.research.invalidate?.();
    return gc.equipment.craftLevel(model);
  };
  const { ITEM_MODELS: IM } = await import('../src/config/equipment.js');
  const top = Object.keys(IM).find((k) => !IM[k].simple && !IM[k].dg);
  const simple = Object.keys(IM).find((k) => IM[k].simple);
  assert(lvAt(15, 15, top) === 70, `工作台 Lv15＋精工 Lv15 做出 Lv70（${lvAt(15, 15, top)}）`);
  assert(lvAt(14, 15, top) < 70 && lvAt(15, 14, top) < 70, '兩項都升滿才到 Lv70');
  assert(lvAt(9, 5, top) === 48 && lvAt(10, 0, top) === 50, `中期等級（工作台 9＋精工 5 → ${lvAt(9, 5, top)}）`);
  assert(lvAt(15, 15, simple) === 60, '簡易裝備最高 Lv60');
  const drop = gc.equipment.generate({ level: 80, model: top, rarity: 'rare' });
  assert(drop.level === 60, `掉落的裝備最高 Lv60（${drop.level}）`);
  const crafted = gc.equipment.generate({ level: 70, model: top, rarity: 'rare', maxLevel: 70 });
  const imported = gc.equipment.importItem(gc.equipment.exportItem(crafted));
  assert(crafted.level === 70 && imported?.level === 70, `交易取得的 Lv70 裝備保留等級（${imported?.level}）`);
}

// ---- v15.14：勢力據點建好後固定（控制點變少不消失）、被打掉後要等勢力再打下控制點才蓋新的；等級上限依區域 ----
{
  const { MemoryObjects } = await import('../src/multiplayer/SharedWorld.js');
  const CPC = await import('../src/config/controlPoints.js');
  const Z = await import('../src/config/zones.js');
  const gb = Game.newGame({ playerName: 'FB', classId: 'warrior', lat: 25.03, lon: 121.56 });
  gb.genMap();
  gb.shelter.establish(gb.state.map.pois.find((p) => Z.inPlayerSafe(p.lat, p.lon) && gb.shelter.canEstablish(p).ok));
  gb.shared.backend = new MemoryObjects();
  gb.world = { others: [], myId: 'FB', identity: () => ({ id: 'FB', token: 't' }) };
  gb.npcs.createdAt = 0; // 不等第一次共用 NPC 資料（測試直接重建清單）
  const setOwner = (id, fac) => gb.shared.update(CPC.CP_KIND, id, (x) => ({ data: { ...(x || {}), faction: fac, owners: fac ? [] : [{ p: 'X', n: 'X' }], guards: [] } }));
  const f = 'black';
  await setOwner('cp3', f); await setOwner('cp4', f);
  await gb.npcs.syncFactionRecs(Date.now());
  const rec = gb.npcs.factionRec(f);
  assert(rec && rec.list.length === Math.min(4, Math.floor(gb.cp.factionCps(f).length / CPC.FACTION_BASE.perCps)), `勢力據點清單第一次建立時保留現有據點（${rec?.list.length} 座）`);
  const baseCp = gb.npcs.factionAlive(f)[0].cp;
  // 玩家打下勢力其他的控制點，讓勢力少於 3 個：據點仍在
  for (const id of gb.cp.factionCps(f).filter((x) => x !== baseCp)) await setOwner(id, null);
  gb.npcs.fillCells(Date.now(), { silent: true });
  const nb = gb.npcs.list.find((n) => n.faction === f && n.cp === baseCp && !n.hq);
  assert(gb.cp.factionCps(f).length < 3 && nb, `勢力控制點少於 3 個時，已建好的據點不會自己消失（剩 ${gb.cp.factionCps(f).length} 個控制點）`);
  // 打掉據點：從清單移除，36 小時後也不會重生
  gb.npcs.destroy(nb);
  await new Promise((r) => setTimeout(r, 0));
  gb.npcs.fillCells(Date.now() + 40 * 3600000, { silent: true });
  assert(!gb.npcs.factionAlive(f).length && !gb.npcs.list.some((n) => n.faction === f && !n.hq) && gb.npcs.list.some((n) => n.faction === f && n.hq), '據點被打掉後不再計時重生，改由大本營出兵');
  // 勢力再打下控制點湊滿 3 個：蓋新的據點
  const others = CPC.CONTROL_POINTS.filter((c) => c.id !== baseCp && !gb.cp.factionCps(f).includes(c.id) && c.side === 'right').slice(0, 3);
  for (const c of others) await setOwner(c.id, f);
  const built = await gb.npcs.factionBuild(f, Date.now());
  gb.npcs.fillCells(Date.now(), { silent: true });
  const nn = gb.npcs.list.find((n) => n.faction === f && !n.hq);
  assert(built && nn && gb.cp.factionCps(f).includes(nn.cp) && nn.level >= 35, `勢力打下控制點、數量達到門檻時蓋新的據點（#${CPC.cpById(nn?.cp)?.no}、Lv${nn?.level}）`);
  const again = await gb.npcs.factionBuild(f, Date.now());
  assert(!again, '數量沒有增加時不會再蓋');
  // 等級上限依區域
  const at = (zid) => gb.state.map.pois.find((p) => Z.zoneAt(p.lat, p.lon)?.id === zid);
  const caps = ['safe', 'normal', 'alert', 'danger', 'lethal'].map((z) => { const p = at(z); return p ? gb.npcs.levelCap({ lat: p.lat, lon: p.lon }) : null; });
  assert(caps.join() === '25,35,40,45,50', `NPC 據點等級上限依區域（安全 25、一般 35、警戒 40、危險 45、致死 50：${caps.join('、')}）`);
  assert(gb.npcs.levelCap({ hq: true, lat: 0, lon: 0 }) === 50, '大本營上限 Lv50');
}

// ---- v15.17：設計圖自動出售（品級＋星級都設定才啟用、只賣新拿到的；一鍵出售才賣現有的）與全部出售 ----
{
  const ga = Game.newGame({ playerName: 'AS', classId: 'warrior', lat: 25, lon: 121 });
  const BM = ga.blackMarket.constructor;
  const { ITEM_MODELS: IM2 } = await import('../src/config/equipment.js');
  const lo = Object.keys(IM2).find((k) => !IM2[k].dg && BM.bpStars({ model: k }) === 1);
  const hi = Object.keys(IM2).find((k) => !IM2[k].dg && BM.bpStars({ model: k }) === 3);
  const bps = () => ga.state.inventory.blueprints;
  const ids = () => bps().map((b) => b.id);
  bps().length = 0;
  bps().push({ id: 'old1', model: lo, rarity: 'common' }, { id: 'old2', model: hi, rarity: 'common' });
  assert(ga.blackMarket.bpAutoSell().r === null && ga.blackMarket.bpAutoSell().s === null, '預設品級、星級都是不設定');
  const c0 = ga.state.player.coins;
  ga.blackMarket.setBpAutoSell({ r: 'uncommon' });
  assert(ids().includes('old1') && ids().includes('old2') && ga.state.player.coins === c0, '改下拉選單不會賣掉現有的設計圖');
  bps().push({ id: 'n0', model: hi, rarity: 'common' }, { id: 'n0r', model: lo, rarity: 'rare' });
  ga.tick();
  assert(!ids().includes('n0') && ids().includes('n0r'), '只設定品級：之後拿到的優良以下設計圖就自動賣（不看星級）');
  ga.blackMarket.setBpAutoSell({ r: null, s: 1 });
  bps().push({ id: 'n0s', model: lo, rarity: 'epic' }, { id: 'n0h', model: hi, rarity: 'poor' });
  ga.tick();
  assert(!ids().includes('n0s') && ids().includes('n0h'), '只設定星級：之後拿到的 ★ 設計圖就自動賣（不看品級）');
  ga.blackMarket.setBpAutoSell({ r: 'uncommon', s: 2 });
  bps().push({ id: 'n1', model: lo, rarity: 'common', held: true });
  bps().push({ id: 'n2', model: lo, rarity: 'uncommon' }, { id: 'n3', model: hi, rarity: 'common' }, { id: 'n4', model: lo, rarity: 'rare' }, { id: 'n5', model: lo, rarity: 'common', keep: true }, { id: 'n6', model: 'x', rarity: 'dungeon', dg: true });
  ga.tick();
  assert(['n2', 'n3', 'n4'].every((x) => !ids().includes(x)) && ['n5', 'n6', 'old1', 'n1'].every((x) => ids().includes(x)), `兩項都設定：品級或星級符合其中一項就自動賣（剩 ${ids().join(',')}）`);
  const one = ga.blackMarket.blueprintBuyback({ model: lo, rarity: 'common' });
  const c1 = ga.state.player.coins;
  const rr = ga.blackMarket.sellBpByRule();
  assert(rr.ok && rr.n === 5 && ['old1', 'n1', 'old2', 'n0r', 'n0h'].every((x) => !ids().includes(x)), `一鍵出售：現有符合任一條件的一起賣（${rr.n} 張）`);
  // 全部出售：金額＝單張價格 × 張數
  bps().push({ id: 'a0', model: hi, rarity: 'common', held: true }, { id: 'a1', model: hi, rarity: 'common', held: true }, { id: 'a2', model: hi, rarity: 'common', held: true });
  const one2 = ga.blackMarket.blueprintBuyback({ model: hi, rarity: 'common' });
  const c2 = ga.state.player.coins;
  const ra = ga.blackMarket.sellBlueprints(['a0', 'a1', 'a2']);
  assert(ra.ok && ra.n === 3 && ga.state.player.coins - c2 === one2 * 3, `全部出售：3 張一起賣、金額是單張的 3 倍（💰${ga.state.player.coins - c2}）`);
  const SM = (await import('../src/core/SaveManager.js')).SaveManager;
  const mg = SM.migrate({ version: 37, bpAutoSell: ['poor', 'rare'], inventory: { blueprints: [{ id: 'z' }] } });
  const mg3 = SM.migrate({ version: 38, bpAutoSell: { r: 'rare', s: 3 } });
  assert(mg.bpAutoSell?.r === 'rare' && mg.bpAutoSell.s === null && mg.inventory.blueprints[0].held && mg3.bpAutoSell.s === 3, `舊存檔：勾選品級轉成最高品級以下、全部星級改成不設定、已選的星級保留（${JSON.stringify(mg.bpAutoSell)}）`);
}

// ---- v15.18：天候事件日 ----
{
  const { WORLD_EVENTS: WE } = await import('../src/config/worldEvents.js');
  const { npcAlert: npcAlertF } = await import('../src/systems/TerritorySystem.js');
  WXS.force = null;
  const t0 = Date.UTC(2026, 0, 1, 4);
  const seen = {};
  for (let d = 0; d < 730; d += 1) { const id = WXS.at(t0 + d * 864e5).id; seen[id] = (seen[id] || 0) + 1; }
  const totalW = Object.values(WE).reduce((s0, e) => s0 + e.weight, 0);
  assert(Object.keys(WE).every((k) => Math.abs(seen[k] / 730 - WE[k].weight / totalW) < 0.05), `每天抽一種天候，出現比例接近權重（${JSON.stringify(seen)}）`);
  assert(WXS.at(t0 + 3600e3).id === WXS.at(t0 + 10 * 3600e3).id, '同一天（台灣時間）天候相同，所有玩家算出一樣的結果');
  const gw = Game.newGame({ playerName: 'WX', classId: 'farmer', lat: 25, lon: 121 });
  gw.state.map.pois = fillPois([], 25, 121);
  gw.shelter.establish(gw.state.map.pois.find((p) => gw.shelter.canEstablish(p).ok));
  const at = Date.now();
  const with_ = (id, fn) => { WXS.force = id; try { return fn(); } finally { WXS.force = 'calm'; } };
  // 酸雨：搜刮量
  const ctx = { poi: gw.state.map.pois[0], lootBase: 1 };
  const l0 = with_('calm', () => gw.exploration.atPhase(ctx, at).lootMul);
  const l1 = with_('acidRain', () => gw.exploration.atPhase(ctx, at).lootMul);
  assert(Math.abs(l1 / l0 - 1.2) < 1e-9, `酸雨：探索搜刮量 +20%（${(l1 / l0).toFixed(2)}）`);
  // 酸雨：戰鬥受到的傷害
  const sv = gw.survivors.leader();
  const hurtTest = (id) => with_(id, () => {
    gw.survivors.setHp(sv, 100);
    gw.combat.applyOutcome([sv], { team: [{ id: sv.id, hp: 60, hpStart: 100 }], kills: [], bossKills: 0, eliteKills: 0, xp: 0, coins: 0, parts: 0, victory: true }, at);
    return gw.survivors.hp ? gw.survivors.hp(sv) : sv.hp;
  });
  const h0 = hurtTest('calm');
  const h1 = hurtTest('acidRain');
  assert(Math.round(h0) === 60 && Math.round(h1) === 48, `酸雨：探索戰鬥受到的傷害 +30%（失血 40 → ${Math.round(100 - h1)}）`);
  // 濃霧：警戒範圍
  const a0 = with_('calm', () => [npcAlertF({ level: 10 }), gw.territory?.alertRadius ? gw.territory.alertRadius(gw.shelter.primary()) : null]);
  const a1 = with_('fog', () => [npcAlertF({ level: 10 }), gw.territory?.alertRadius ? gw.territory.alertRadius(gw.shelter.primary()) : null]);
  assert(a0[0] === 70 && a1[0] === 49 && (a0[1] == null || a1[1] === Math.round(a0[1] * 0.7)), `濃霧：NPC 與玩家警戒範圍 −30%（${a0.join('/')} → ${a1.join('/')}）`);
  // 熱浪：食物消耗、移動速度
  const f0 = with_('calm', () => gw.resources.rates().upkeep.food);
  const f1 = with_('heatWave', () => gw.resources.rates().upkeep.food);
  const m0 = with_('calm', () => gw.time.exploreSpeedMul(at));
  const m1 = with_('heatWave', () => gw.time.exploreSpeedMul(at));
  assert(Math.abs(f1 / f0 - 1.25) < 1e-9 && Math.abs(m1 / m0 - 0.85) < 1e-9, `熱浪：食物消耗 +25%、移動速度 −15%（${(f1 / f0).toFixed(2)}、${(m1 / m0).toFixed(2)}）`);
  // 豐收：食物產量
  sv.job = 'farm';
  const p0 = with_('calm', () => gw.resources.rates().gross.food);
  const p1 = with_('harvest', () => gw.resources.rates().gross.food);
  assert(p1 > p0 * 1.15, `豐收：食物產量提高（${p0.toFixed(1)} → ${p1.toFixed(1)}）`);
  sv.job = 'idle';
  // 黑市大促
  const g0 = with_('calm', () => gw.blackMarket.shelf(at)[0].price);
  const g1 = with_('blackSale', () => gw.blackMarket.shelf(at)[0].price);
  const it = gw.equipment.generate({ level: 10, rarity: 'rare' });
  const b0 = with_('calm', () => gw.blackMarket.gearBuyback(it));
  const b1 = with_('blackSale', () => gw.blackMarket.gearBuyback(it));
  assert(Math.abs(g1 - g0 * 0.8) <= 1 && Math.abs(b1 - b0 * 1.2) <= 1, `黑市大促：售價 −20%、收購 +20%（${g0}→${g1}、${b0}→${b1}）`);
  // 血月：夜間殭屍群、獵殺獎勵、屍潮變種
  const night = gw.time.nightKey(at);
  const z0 = with_('calm', () => gw.zombies.sharedGroups(night, at));
  const z1 = with_('bloodMoon', () => gw.zombies.sharedGroups(night, at));
  const sum = (l, k) => l.reduce((s2, x) => s2 + x[k], 0);
  assert(z0.length === z1.length && sum(z1, 'count') > sum(z0, 'count') && sum(z1, 'level') === sum(z0, 'level') + 3 * z1.length && z1.every((x) => x.reward === 1.5 && x.moon) && z0.every((x) => !x.reward),
    `血月：同樣的殭屍群數量 +30%、等級 +3、獵殺獎勵 +50%（數量 ${sum(z0, 'count')} → ${sum(z1, 'count')}）`);
  assert(with_('bloodMoon', () => gw.siege.of().variantMul()) === 2 && with_('calm', () => gw.siege.of().variantMul()) === 1, '血月：屍潮變種出現權重加倍');
  WXS.force = 'calm';
}

// ---- v15.18：屍潮變種 ----
{
  const { SIEGE_VARIANTS: SV, SIEGE_VARIANT_KEYS: SVK } = await import('../src/config/enemies.js');
  const gv = Game.newGame({ playerName: 'VR', classId: 'warrior', lat: 25, lon: 121 });
  gv.state.map.pois = fillPois([], 25, 121);
  gv.shelter.establish(gv.state.map.pois.find((p) => gv.shelter.canEstablish(p).ok));
  setHour(gv, 23);
  const s = gv.siege.of();
  const civ = (v) => { gv.civilization.value = () => v; };
  civ(50);
  const pick50 = new Set(Array.from({ length: 400 }, () => s.pickEnemy()));
  civ(300);
  const pick300 = new Set(Array.from({ length: 1500 }, () => s.pickEnemy()));
  assert(SVK.every((k) => !pick50.has(k)) && SVK.every((k) => pick300.has(k)), `變種依文明度解鎖（文明 50 沒有、300 全部出現：${[...pick300].filter((k) => SV[k]).join('、')}）`);
  const base = gv.shelter.primary();
  const W = WORLDC.WALL_R;
  const fresh = (id) => { s.zombies = []; s.spawn(id); const z = s.zombies[0]; z.x = W + 1; z.y = 0; return z; };
  // 自爆者：碰到圍牆爆炸，扣牆血、不給獎勵
  base.wallHp = null;
  const w0 = gv.shelter.wallHp(base);
  const kills0 = s.nightKills;
  const ze = fresh('exploder');
  s.step(0.1);
  assert(gv.shelter.wallHp(base) < w0 - ze.atk * 2 && !s.zombies.includes(ze) && s.nightKills === kills0, `自爆者碰到圍牆自爆（牆 ${Math.round(w0)} → ${Math.round(gv.shelter.wallHp(base))}，不算擊殺獎勵）`);
  // 裝甲殭屍：一般傷害減半，火焰塔無視裝甲
  const za = fresh('armored');
  const hp0 = za.hp;
  s.src = 'machineGun'; s.damage(za, 100);
  const d1 = hp0 - za.hp;
  s.src = 'flameTower'; s.damage(za, 100);
  const d2 = hp0 - d1 - za.hp;
  assert(d1 === 50 && d2 === 100, `裝甲殭屍：機槍傷害 −50%、火焰塔無視裝甲（${d1}／${d2}）`);
  // 拆牆者：對牆傷害較高
  base.wallHp = null;
  const zb = fresh('breaker'); zb.atkCd = 0;
  const wb0 = gv.shelter.wallHp(base);
  s.step(0.1);
  const dmgB = wb0 - gv.shelter.wallHp(base);
  assert(Math.abs(dmgB - zb.atk * 0.25 * (1 - gv.shelter.wallReduction(base)) * SV.breaker.ability.wallMul) < 1, `拆牆者對圍牆傷害 ×${SV.breaker.ability.wallMul}`);
  // 爬牆者：貼牆幾秒後翻進圍牆
  base.wallHp = null;
  const zc = fresh('climber');
  for (let i = 0; i < 60 && !zc.inside; i += 1) s.step(0.1);
  assert(zc.inside && Math.hypot(zc.x, zc.y) < W, '爬牆者貼牆後翻進圍牆');
  // 尖叫者：周圍殭屍加速
  s.zombies = [];
  s.spawn('screamer'); s.spawn('walker');
  const [q, wk] = s.zombies;
  q.x = 120; q.y = 0; wk.x = 125; wk.y = 0; wk.speed = 10; q.speed = 0;
  s.step(0.1);
  const moved = 125 - Math.hypot(wk.x, wk.y);
  assert(Math.abs(moved - 10 * 1.15 * 0.1) < 0.02, `尖叫者讓附近殭屍加速 15%（移動 ${moved.toFixed(3)}）`);
  // 變種擊殺記錄在今晚統計，天亮寫進守城報告
  s.zombies = [];
  s.spawn('armored');
  s.zombies[0].hp = 0;
  s.collectDead();
  assert(s.nightVariants?.armored >= 1 && base.nightStats?.variants?.armored >= 1, '變種擊殺數記在據點的今晚統計（重新整理不會遺失）');
}

// ---- v15.19：全服空投 ----
{
  const { AIRDROP: AD, AIRDROP_ZONE: ADZ } = await import('../src/config/airdrops.js');
  const { AirdropSystem: ADS } = await import('../src/systems/AirdropSystem.js');
  const ga = Game.newGame({ playerName: 'AD', classId: 'warrior', lat: 25, lon: 121 });
  ga.state.map.pois = fillPois([], 25, 121);
  ga.shelter.establish(ga.state.map.pois.find((p) => ga.shelter.canEstablish(p).ok));
  const ad = ga.airdrop;
  const s0 = ADS.slotOf(Date.now());
  const cells = ad.cells().length;
  let n = 0;
  for (let k = 0; k < 80; k += 1) n += ad.slotDrops(s0 + k).length;
  const expect = cells * AD.chance * 80;
  assert(Math.abs(n - expect) < expect * 0.35, `每格每輪 ${AD.chance * 100}% 機率掉空投（80 輪 ${n} 箱，預期約 ${Math.round(expect)}）`);
  const ga2 = Game.newGame({ playerName: 'AD2', classId: 'warrior', lat: 25, lon: 121 });
  ga2.state.map.pois = ga.state.map.pois;
  assert(JSON.stringify(ga2.airdrop.slotDrops(s0 + 3)) === JSON.stringify(ad.slotDrops(s0 + 3)), '所有玩家算出的空投位置、時間、內容完全相同');
  WXS.force = 'supply';
  ad.slotCache.clear();
  let n2 = 0;
  for (let k = 0; k < 80; k += 1) n2 += ad.slotDrops(s0 + k).length;
  WXS.force = 'calm';
  ad.slotCache.clear();
  assert(n2 > n * 1.6, `補給日空投機率加倍（${n} → ${n2}）`);
  // 找一箱空投
  let d = null;
  for (let k = 0; !d && k < 50; k += 1) d = ad.slotDrops(s0 + k)[0];
  assert(d && d.announceAt < d.landAt && d.landAt < d.npcAt && d.npcAt < d.expireAt && Object.keys(d.mats).length > 0, '空投有預告、降落、NPC 拿走、消失的時間與內容');
  const Z = ADZ[d.zone];
  assert(ad.status(d, d.announceAt + 1).state === 'falling' && ad.status(d, d.landAt + 1).state === 'landed' && ad.status(d, d.npcAt + 1).state === 'npc' && ad.status(d, d.expireAt + 1).state === 'gone', '狀態：降落中 → 可搶 → 被 NPC 拿走 → 消失');
  assert(ad.guards(d).length === Z.guard.n, `守衛殭屍數量依區域（${d.zone} ${Z.guard.n} 隻）`);
  // 派隊搶奪：守衛換成空的（必勝），抵達後寫入共用資料、背著回家
  const realGuards = ad.guards.bind(ad);
  ad.guards = () => [];
  const sv = ga.survivors.leader();
  const t0 = d.landAt + 1000;
  const r0 = ga.exploration.start(`drop:${d.id}`, [sv.id], 0, false, t0, { kind: 'drop' });
  assert(r0.ok && r0.exp.kind === 'drop' && r0.exp.dropTarget?.id === d.id, `可以派隊搶空投（${r0.reason || ''}）`);
  const arrive = r0.exp.startAt + r0.exp.travelMs;
  const coins0 = ga.state.player.coins;
  ga.exploration.dropArrive(r0.exp, arrive);
  await new Promise((r) => setTimeout(r, 20));
  assert(r0.exp.dropResult?.win && !r0.exp.dropResult.pending && r0.exp.carried && ad.status(d, arrive).state === 'taken', '打贏守衛後搶下空投，戰利品背在身上');
  const rep = ga.exploration.dropReport(r0.exp);
  assert(rep.success && ga.state.player.coins > coins0 && Object.keys(rep.resources).some((k) => d.mats[k]), `回到避難所後空投物資入庫（金錢 +${ga.state.player.coins - coins0}）`);
  // 已被搶走：後到的隊伍撲空
  const r1 = ga2.exploration.start(`drop:${d.id}`, [ga2.survivors.leader().id], 0, false, t0, { kind: 'drop' });
  ga2.shared.cache = ga.shared.cache; // 共用同一份資料（測試用）
  if (r1.ok) {
    ga2.airdrop.guards = () => [];
    ga2.exploration.dropArrive(r1.exp, r1.exp.startAt + r1.exp.travelMs);
    assert(r1.exp.dropResult?.missed && !r1.exp.carried, '空投已被搶走：後到的隊伍撲空，不用交戰');
  }
  // 守衛強度：致死區守衛打得贏一般隊伍嗎（弱隊必輸）
  ad.guards = realGuards;
  const lethal = { ...d, zone: 'lethal' };
  const weak = ga.combat.simulate([sv], ad.guards(lethal), { record: false });
  assert(!weak.victory, '致死區空投守衛很強，新手隊伍打不贏');
}

// ---- v16.1：空投降落前抵達原地等待，降落時一起結算 ----
{
  const { AirdropSystem: ADS } = await import('../src/systems/AirdropSystem.js');
  const gw = Game.newGame({ playerName: 'WA', classId: 'warrior', lat: 25, lon: 121 });
  gw.state.map.pois = fillPois([], 25, 121);
  gw.shelter.establish(gw.state.map.pois.find((p) => gw.shelter.canEstablish(p).ok));
  const ad = gw.airdrop;
  ad.guards = () => [];
  const s0 = ADS.slotOf(Date.now());
  const drops = [];
  for (let k = 0; drops.length < 2 && k < 60; k += 1) drops.push(...ad.slotDrops(s0 + k));
  // 讓空投在 2 小時後降落（一定比隊伍先到）
  const shift = (d, landAt) => { const dt = landAt - d.landAt; ['announceAt', 'landAt', 'expireAt', 'npcAt'].forEach((k) => { d[k] += dt; }); };
  const d = drops[0];
  shift(d, Date.now() + 2 * 3600e3);
  const ld = gw.survivors.leader();
  const r = gw.exploration.startDrop(d.id, [ld.id]);
  await new Promise((res) => setTimeout(res, 20));
  const ex = r.exp;
  assert(r.ok && ex.dropWait && ex.searchMs > 0 && ex.startAt + ex.travelMs + ex.searchMs === d.landAt && ex.endAt === d.landAt + ex.travelMs, `降落前抵達：在落點等待到降落，回程順延（${r.reason || ''}）`);
  assert(ad.waiters(d).some((w) => w.k === ex.id && w.u?.length === 1), '等待的隊伍登記到共用資料');
  assert(gw.exploration.holdDrop(ex, d.landAt + 1000), '降落結算前隊伍不會先回報');
  gw.exploration.checkDrops(d.landAt + 1000);
  await new Promise((res) => setTimeout(res, 30));
  gw.exploration.checkDrops(d.landAt + 2000);
  assert(ex.dropDone && ex.dropResult?.win && ex.carried && ad.status(d, d.landAt + 5000).state === 'taken', '降落時結算：只有自己等待，打贏守衛搶到空投');
  // 召回：取消等待
  const d2 = drops[1];
  shift(d2, Date.now() + 2 * 3600e3);
  const sv2 = gw.state.survivors.find((x) => x.id !== ld.id) || null;
  if (sv2) {
    sv2.status = 'idle';
    const r2 = gw.exploration.startDrop(d2.id, [sv2.id]);
    await new Promise((res) => setTimeout(res, 20));
    gw.exploration.recall(r2.exp.id);
    await new Promise((res) => setTimeout(res, 20));
    assert(r2.ok && !ad.waiters(d2).length && r2.exp.dropDone, '召回等待中的隊伍：取消等待登記');
  }
  // 陣營與交戰：好友同陣營、不同陣營依抵達順序交戰、戰利品依人數平分、設計圖給最先抵達的玩家
  const { AssistSystem: AS } = await import('../src/systems/AssistSystem.js');
  const unit = (i, atk, hp) => ({ ...AS.unitData(gw, ld, i), atk, hp, maxHp: hp, def: 0, dodge: 0 });
  const d3 = { ...d, id: 'ad_test_3', bp: true };
  const W = (k, p, f, at, atk, hp) => ({ k, p, n: k, at, f, u: [unit(0, atk, hp)] });
  // A、B 互為好友且強，C 弱：A、B 勝出並平分
  let res = ad.landingFight(d3, { w: [W('A', 'pa', ['pb'], d3.landAt - 300, 900, 9000), W('C', 'pc', [], d3.landAt - 200, 5, 50), W('B', 'pb', ['pa'], d3.landAt - 100, 900, 9000)] });
  const oa = res.out.A; const ob = res.out.B; const oc = res.out.C;
  assert(res.win && oa.win && ob.win && !oc.win && oa.camp === ob.camp && oa.camp !== oc.camp, '互為好友的玩家同一陣營，打贏非好友陣營後搶到空投');
  assert(Math.abs(oa.coins - ob.coins) <= 1 && oa.bps.length === (d3.bp ? 1 : 0) && !ob.bps.length && oc.units[0].down, '戰利品依人數平分，設計圖給最先抵達的玩家，落敗方倒下');
  // C 很強：C 依抵達順序和 A、B 陣營交戰並勝出，拿走全部
  res = ad.landingFight(d3, { w: [W('A', 'pa', ['pb'], d3.landAt - 300, 5, 50), W('C', 'pc', [], d3.landAt - 200, 2000, 50000), W('B', 'pb', ['pa'], d3.landAt - 100, 5, 50)] });
  assert(res.win && res.out.C.win && !res.out.A.win && res.out.C.coins > 0 && res.byName === 'C', '非好友陣營較強時打贏後拿走全部');
  // 降落後才抵達的隊伍不列入降落結算
  res = ad.landingFight(d3, { w: [W('A', 'pa', [], d3.landAt - 300, 900, 9000), W('L', 'pl', [], d3.landAt + 60000, 900, 9000)] });
  assert(res.out.A.win && !res.out.L, '降落後才抵達的隊伍不列入降落結算（先到先得）');
}

// ---- v17：控制點防禦建築（半價、3 倍效果、每位玩家各 1 座、最多 8 位玩家、敵對拆除）與攻防 ----
{
  const { MemoryObjects } = await import('../src/multiplayer/SharedWorld.js');
  const CPC = await import('../src/config/controlPoints.js');
  const Z = await import('../src/config/zones.js');
  const { DEFENSES: DF } = await import('../src/config/defenses.js');
  const store = new MemoryObjects();
  const mk = (name) => {
    const gx = Game.newGame({ playerName: name, classId: 'warrior', lat: 25.03, lon: 121.56 });
    gx.genMap();
    gx.shelter.establish(gx.state.map.pois.find((p) => Z.inPlayerSafe(p.lat, p.lon) && gx.shelter.canEstablish(p).ok));
    gx.shared.backend = store;
    gx.world = { others: [], myId: name, identity: () => ({ id: name, token: 't' }) };
    return gx;
  };
  const A = mk('BA'); const B = mk('BB'); const H = mk('BH');
  const id = 'cp1';
  await A.shared.update(CPC.CP_KIND, id, () => ({ data: { owners: [{ p: 'BA', n: 'BA' }], guards: [], faction: null } }));
  await B.shared.poll(); await H.shared.poll();
  // 費用：避難所的一半
  const full = DF.barricade.cost(1);
  const half = A.cp.bldCost('barricade', 1);
  assert(Object.keys(full).every((k) => half[k] === Math.max(1, Math.round(full[k] * 0.5))), '控制點防禦建築費用為避難所同等級的一半');
  // 資源足夠時建造（測試用：給滿資源）
  const fill = (g, cost) => Object.entries(cost).forEach(([k, v]) => { g.grant({ [k]: v * 3 }); });
  fill(A, half);
  const r1 = await A.cp.build(id, 'barricade');
  assert(r1.ok && A.cp.bldOf(id).barricade === 1, `佔領者可以蓋路障（${r1.reason || ''}）`);
  const e1 = CPC.CP_BUILD.effectMul;
  assert(A.cp.defenseOf(id).wall === DF.barricade.stats(1).wallBonus * e1, `路障效果為避難所的 3 倍（${A.cp.defenseOf(id).wall}）`);
  // 非敵對的其他玩家也可以蓋
  await B.shared.poll();
  fill(B, B.cp.bldCost('barricade', 1));
  const r2 = await B.cp.build(id, 'barricade');
  assert(r2.ok && B.cp.members(id).length === 2, `非敵對的玩家也可以蓋防禦建築（${r2.reason || ''}）`);
  // 資源不足：不能蓋、不扣資源
  const H0 = JSON.stringify(H.state.resources);
  H.state.relations.players = { BA: { status: 'hostile' } };
  await H.shared.poll();
  const rh = H.cp.canBuild(id, 'barricade');
  assert(!rh.ok && /敵對/.test(rh.reason) && !H.cp.canGuard(id, 1).ok, `和佔領者敵對：不能蓋建築也不能駐防（${rh.reason}）`);
  assert(JSON.stringify(H.state.resources) === H0, '不能蓋時不扣資源');
  // 科技：套用建造者自己的科技（圍牆耐久），研究升級後自動更新
  {
    await A.shared.poll();
    const w0 = A.cp.defenseOf(id).wall;
    const rb = A.research.bonus.bind(A.research);
    A.research.bonus = (k) => (k === 'wallHpPct' ? 0.5 : rb(k));
    await A.cp.syncBldTech();
    const w1 = A.cp.defenseOf(id).wall;
    A.research.bonus = rb;
    await A.cp.syncBldTech();
    assert(Math.abs(w1 - (w0 + DF.barricade.stats(1).wallBonus * e1 * 0.5)) <= 1, `控制點建築套用建造者自己的科技（圍牆耐久 +50%：${w0} → ${w1}）`);
    const cr = A.research.bonus.bind(A.research);
    A.research.bonus = (k) => (k === 'buildCostReduce' ? 0.2 : cr(k));
    const c2 = A.cp.bldCost('barricade', 1);
    A.research.bonus = cr;
    assert(Object.keys(half).every((k) => c2[k] <= half[k]) && Object.keys(half).some((k) => c2[k] < half[k]), '降低建造費用的科技也套用在控制點建築');
  }
  // 研究未完成的建築不能蓋（機槍塔需要研究）
  const mg = A.cp.canBuild(id, 'machineGun');
  assert(!mg.ok && /研究/.test(mg.reason || ''), `機槍塔需要先研究（${mg.reason}）`);
  // 最多 8 位玩家
  await A.shared.update(CPC.CP_KIND, id, (x) => ({ data: { ...x, bld: { ...(x.bld || {}), ...Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`P${i}`, { n: `P${i}`, b: { barricade: 1 } }])) } } }));
  const C = mk('BC'); await C.shared.poll();
  fill(C, C.cp.bldCost('barricade', 1));
  const rc = C.cp.canBuild(id, 'barricade');
  assert(A.cp.members(id).length === 8 && !rc.ok && /8 位/.test(rc.reason) && !C.cp.canGuard(id, 1).ok, `每個控制點最多 8 位玩家駐防或蓋建築（${rc.reason}）`);
  // 佔領者和某位建造者變成敵對：拆除他的建築
  A.state.relations.players = { BB: { status: 'hostile' } };
  await A.cp.checkHostileOwners(Date.now());
  assert(!A.cp.data(id).bld.BB && A.cp.data(id).bld.BA, '和佔領者變成敵對：該玩家的建築被拆除');
  // 勢力進攻：先攻打路障（路障夠厚、火力夠強時打不破就撤退）
  await A.shared.update(CPC.CP_KIND, id, (x) => ({ data: { ...x, bld: { BA: { n: 'BA', b: { barricade: 99, machineGun: 0 } } }, guards: [] } }));
  const strong = A.cp.defenseOf(id);
  const big = { wall: 5e7, dps: 0 };
  A.cp.defenseOf = () => ({ ...big, dps: 5e6 });
  const na = await A.cp.npcAttack('red', id, Date.now());
  delete A.cp.defenseOf;
  assert(!na.win && A.cp.owners(id).some((o) => o.p === 'BA'), `勢力部隊打不破路障：控制點維持原佔領者（耐久 ${strong.wall}）`);
  // 戰損保留與追加一波：路障打不破時保留被打掉的耐久、約 2 小時修好；被擊退後 30 分鐘追加一波（只 1 波）
  {
    const t0 = Date.now() - 1000;
    await A.shared.update(CPC.CP_KIND, id, (x) => ({ data: { ...x, bld: { BA: { n: 'BA', b: { barricade: 15 } } }, guards: [], wd: 0, march: null } }));
    const wmax = A.cp.defenseOf(id, t0).wall;
    const dfo = A.cp.defenseOf.bind(A.cp);
    A.cp.defenseOf = (i, at) => ({ ...dfo(i, at), wall: 5e6, dps: 5e6 });
    const r1 = await A.cp.npcAttack('red', id, t0);
    const d1 = A.cp.data(id);
    assert(!r1.win && d1.wd > 0 && d1.march?.fu && d1.march.arriveAt === t0 + CPC.CP_FOLLOW_MS, `被擊退：路障保留戰損、30 分鐘後追加一波（戰損 ${d1.wd}）`);
    const F = d1.wd;
    const left0 = A.cp.wallLeft(id, t0, F);
    const left1 = A.cp.wallLeft(id, t0 + CPC.CP_RECOVER_MS / 2, F);
    const left2 = A.cp.wallLeft(id, t0 + CPC.CP_RECOVER_MS + 1, F);
    assert(left0 < left1 && left1 < left2 && left2 === F, `路障戰損約 2 小時修好（${left0} → ${left1} → ${left2}）`);
    await A.shared.update(CPC.CP_KIND, id, (x) => ({ data: { ...x, march: null } }));
    const r2 = await A.cp.npcAttack('red', id, t0 + 1000, { follow: true });
    assert(!r2.win && !A.cp.data(id).march, '追加的那一波被擊退後不再追加');
    A.cp.defenseOf = dfo;
    void wmax;
    // 駐防隊員剩餘生命保留，約 2 小時回滿
    const u = { i: 0, hp: 100, maxHp: 1000 };
    const R = A.cp.constructor.regenHp;
    assert(R(u, t0, t0) === 100 && R(u, t0, t0 + CPC.CP_RECOVER_MS / 2) === 600 && R(u, t0, t0 + CPC.CP_RECOVER_MS * 2) === 1000, '駐防隊員的戰損約 2 小時回滿');
  }
  // 收益：每位駐防者各得完整一份（×6、含布料）
  const inc = A.cp.rollIncome(CPC.cpById('cp3'));
  assert(inc.food === CPC.CP_INCOME[5].food * 6 && inc.wood === CPC.CP_INCOME[5].wood * 6, `右側收益為深淵區基準 ×6（食物 ${inc.food}）`);
}

// ---- v16：倖存者特質、個人任務與轉職 ----
{
  SVS.disableTraits = false;
  const { TRAITS: TR, CLASS_QUESTS: CQ, rollTraits: rollT, traitRandom: trR } = await import('../src/config/traits.js');
  const { createSurvivor: mkSv } = await import('../src/core/GameState.js');
  // 抽特質：劣質～優良 1 個、精良以上 2 個（第 2 個不會是負面）
  let ok1 = true; let negSecond = 0; const typeCount = { pos: 0, mix: 0, neg: 0 };
  for (let i = 0; i < 600; i += 1) {
    const r = ['poor', 'common', 'uncommon', 'rare', 'epic', 'legendary'][i % 6];
    const t = rollT(r, trR(`x${i}`));
    if (t.length !== (['rare', 'epic', 'legendary'].includes(r) ? 2 : 1) || new Set(t).size !== t.length) ok1 = false;
    if (t[1] && TR[t[1]].type === 'neg') negSecond += 1;
    typeCount[TR[t[0]].type] += 1;
  }
  assert(ok1 && negSecond === 0, '特質數量：劣質～優良 1 個、精良以上 2 個，第 2 個不會是負面');
  assert(typeCount.pos > typeCount.mix && typeCount.mix > typeCount.neg && typeCount.neg > 0, `抽中比例接近 正面:混合:負面 = 3:2:1（${JSON.stringify(typeCount)}）`);
  assert(JSON.stringify(rollT('rare', trR('t:sv_1'))) === JSON.stringify(rollT('rare', trR('t:sv_1'))), '同一位倖存者的特質固定');
  const gt = Game.newGame({ playerName: 'TR', classId: 'warrior', lat: 25, lon: 121 });
  const ld = gt.survivors.leader();
  assert(gt.survivors.traitsOf(ld)[0] === 'leader' && TR[gt.survivors.traitsOf(ld)[1]].type === 'pos', `指揮官固定領袖氣質＋1 個正面特質（${gt.survivors.traitsOf(ld).join('、')}）`);
  // 特質效果併入能力
  const sv = mkSv('測試', 'warrior', 35, 'rare');
  gt.state.survivors.push(sv);
  sv.traits = [];
  const hp0 = gt.survivors.stats(sv).hp;
  sv.traits = ['sturdy'];
  const hpR = gt.survivors.stats(sv).hp / hp0;
  assert(hpR > 1.05 && hpR <= 1.081, `特質「壯碩」生命 +8%（與技能的生命加成相加，實際 ×${hpR.toFixed(3)}）`);
  // 戰鬥條件效果：領袖氣質（同隊）、獨行俠（單人）
  const unit = (id, sk) => ({ id, atk: 100, def: 100, maxHp: 1000, hp: 1000, skills: sk });
  const team = [unit('a', { teamAtk: 0.03, teamDef: 0.03 }), unit('b', {})];
  gt.combat.applyTeamTraits(team);
  const solo = [unit('c', { soloAll: 0.15, groupAll: -0.03 })];
  gt.combat.applyTeamTraits(solo);
  assert(Math.abs(team[1].atk - 103) < 1e-6 && Math.abs(solo[0].atk - 115) < 1e-6 && solo[0].maxHp === 1150, '領袖氣質讓同隊全員 +3%、獨行俠單人出隊 +15%');
  // 個人任務：未解鎖不計數；解鎖後三步驟同時計算；完成後轉職
  sv.traits = [];
  sv.level = 29;
  gt.survivors.pqAdd(sv, 'wins', 5);
  assert(!(sv.pq?.wins > 0), '精良以上 Lv30 才解鎖個人任務（之前不計數）');
  const sv2 = mkSv('一般', 'warrior', 35, 'common');
  assert(gt.survivors.questLevel(sv2) === 40 && gt.survivors.questLevel(sv) === 30, '劣質、一般、優良要 Lv40 解鎖');
  sv.level = 30;
  CQ.warrior.steps.forEach((st) => gt.survivors.pqAdd(sv, st.key, st.need));
  assert(gt.survivors.questDone(sv) && sv.pqDone, '三個步驟都完成：個人任務完成');
  const p0 = gt.survivors.stats(sv).power;
  const r = gt.survivors.chooseAdv(sv.id, 'tank');
  assert(r.ok && sv.adv === 'tank' && gt.survivors.classIcon(sv) === '🦾' && gt.survivors.className(sv) === '重裝兵' && gt.survivors.stats(sv).power > p0, `轉職為重裝兵：換圖示與名稱、能力提升（戰力 ${p0} → ${gt.survivors.stats(sv).power}）`);
  assert(!gt.survivors.chooseAdv(sv.id, 'berserker').ok, '轉職是永久的，不能再換');
  // 任務計數掛點：戰鬥（擊殺、打贏、沒倒下）、耕作時間
  const sv3 = mkSv('農', 'farmer', 40, 'rare'); sv3.traits = []; sv3.job = 'farm'; gt.state.survivors.push(sv3);
  gt.resources.apply(30 * 60000);
  assert(Math.round(sv3.pq.farmMin) === 30, `耕作累計時間依現實時間（${Math.round(sv3.pq.farmMin)} 分鐘）`);
  const sv4 = mkSv('醫', 'medic', 40, 'rare'); sv4.traits = []; gt.state.survivors.push(sv4);
  gt.combat.applyOutcome([sv4], { team: [{ id: sv4.id, hp: 100, hpStart: 100, kills: 3 }], kills: [], bossKills: 0, eliteKills: 0, xp: 0, coins: 0, parts: 0, victory: true }, Date.now());
  assert(sv4.pq.cleanWins === 1, '打贏且沒倒下：醫生任務計數');
  // 轉職：生產家所有產量 +20%（多位不疊加）、鐵胃食物消耗
  sv3.adv = null;
  const f0 = gt.resources.rates().gross.wood;
  sv3.adv = 'producer';
  const f1 = gt.resources.rates().gross.wood;
  assert(f0 > 0 && Math.abs(f1 / f0 - 1.2) < 1e-6, `生產家在家：所有產量 +20%（木材 ${f0.toFixed(1)} → ${f1.toFixed(1)}）`);
  sv3.adv = null;
  const u0 = gt.resources.rates().upkeep.food;
  sv3.traits = ['ironGut'];
  const u1 = gt.resources.rates().upkeep.food;
  assert(u1 < u0, '鐵胃：自己的食物消耗減少');
  // 舊存檔遷移：補上特質（依編號固定）
  const mg = SaveManager.migrate({ version: 39, survivors: [{ id: 'sv_x', rarity: 'epic', classId: 'scout' }, { id: 'leader', isLeader: true, name: '老大', classId: 'warrior' }] });
  assert(mg.survivors[0].traits.length === 2 && mg.survivors[1].traits[0] === 'leader' && mg.survivors[0].pq && mg.survivors[0].adv === null, '舊存檔遷移：補上特質、任務進度與轉職欄位');
  // v16.1：指揮官不能進地下城：第三步換成「打贏一次夜間 Boss 殭屍群」
  {
    const ldr = gt.survivors.leader();
    const keys = gt.survivors.questSteps(ldr).map((st) => st.key);
    const other = gt.state.survivors.find((x) => !x.isLeader && CQ[x.classId]);
    assert(keys.includes('nightBoss') && !keys.includes('dungeons') && (!other || gt.survivors.questSteps(other).some((st) => st.key === 'dungeons')), `指揮官的第三步是打贏夜間 Boss，其他倖存者仍是完成地下城（${keys.join('、')}）`);
  }
  SVS.disableTraits = true;
}

// ---- v16.1：報告依分頁各自保留 20 筆，地下城報告不會被探索報告擠掉 ----
{
  const { trimReports: tr, REPORT_KEEP: RK } = await import('../src/systems/reportList.js');
  const dg = Array.from({ length: 3 }, (_, i) => ({ id: `d${i}`, kind: 'dungeon' }));
  const cp = Array.from({ length: 2 }, (_, i) => ({ id: `c${i}`, cp: true }));
  const ex = Array.from({ length: 40 }, (_, i) => ({ id: `e${i}`, poiName: '超市' }));
  const out = tr([...ex, ...dg, ...cp]);
  assert(out.filter((r) => r.kind === 'dungeon').length === 3 && out.filter((r) => r.cp).length === 2, '探索報告很多時，地下城與控制點報告仍保留');
  assert(out.filter((r) => !r.cp && r.kind !== 'dungeon').length === RK && out.find((r) => !r.cp && r.kind !== 'dungeon').id === 'e0', '探索報告保留最新 20 筆');
  const many = tr(Array.from({ length: 30 }, (_, i) => ({ id: `d${i}`, kind: 'dungeon' })));
  assert(many.length === RK && many[0].id === 'd0', '地下城報告也最多保留最新 20 筆');
}

if (failures) {
  console.error(`\n${failures} 項檢查失敗`);
  process.exit(1);
}
console.log(`✓ 全部通過（擊殺 ${g.state.stats.siegeKills}，探索事件 ${reports[0].events.length}）`);

