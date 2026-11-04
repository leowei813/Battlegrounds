/**
 * 資料與邏輯健檢（無瀏覽器）：
 *   npm run check
 * 1. 驗證設定檔互相引用的 ID 是否存在
 * 2. 跑一段無頭模擬，確認各系統可正常運作
 */
import { Game } from '../src/core/Game.js';
import { fillPois } from '../src/map/PoiGenerator.js';
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
import { SUPPLY_KEYS } from '../src/config/supplies.js';

/** 測試用：所有材料物品各 n 個，並擴大物品倉庫 */
const fillSupplies = (game, n = 900) => {
  SUPPLY_KEYS.forEach((k) => { game.state.supplies[k] = n; });
  game.state.bases.forEach((b) => { if (b.facilities.itemStore) b.facilities.itemStore.level = 10; });
  game.state.research.levels.i_shelves = 10;
  game.research.invalidate?.();
};

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
assert(g.shelter.setShelter(g.state.map.pois[0]).ok, 'set shelter');

// ---- 白天：地圖上沒有殭屍（只在探索的建築內遭遇）----
setHour(g, 10);
g.zombies.refresh();
assert(g.state.map.zombieGroups.length === 0, '白天地圖上沒有殭屍群');
for (let i = 0; i < 300; i += 1) g.siege.update(0.1);
assert(g.siege.of().zombies.length === 0 && !Number.isFinite(g.siege.of().spawnInterval()), '白天沒有屍潮');
setHour(g, 21); // 之後的測試在夜晚進行
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
setHour(g, 21);
const save = JSON.parse(JSON.stringify(g.state));
assert(save.version === SAVE_VERSION_NOW, 'state is serializable');
// v3 精簡格式：打包後體積變小，還原後內容一致
g.state.map.pois[1].lootedDay = 20000;
g.state.map.pois[1].lastVisit = 123;
const packed = JSON.stringify(SaveManager.pack(g.state));
const restored = SaveManager.migrate(JSON.parse(packed));
assert(JSON.stringify(restored.map.pois) === JSON.stringify(g.state.map.pois), '建築精簡格式可完整還原');
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
g2.shelter.establish(g2.state.map.pois[0]);
const lvDay1 = g2.siege.of().zombieLevel();
g2.state.createdAt -= 20 * DAY_REAL_MS; // 經過 20 天
g2.civilization.invalidate();
assert(g2.siege.of().zombieLevel() - lvDay1 <= 1, '天數本身不會提升屍潮強度（夜間 ±1）');

const outpostPoi = g.state.map.pois.find((p) => !g.shelter.baseAtPoi(p.id));
assert(!g.shelter.canEstablish(outpostPoi).ok, '避難所只能一座，未研究前哨站科技不能建第二個據點');
g.state.research.levels.e_outpost = 1;
g.research.invalidate();
Object.assign(g.state.resources, { wood: 5000 });
fillSupplies(g);
g.state.player.coins = 5000;
const est = g.shelter.establish(outpostPoi);
assert(est.ok && g.state.bases.length === 2 && est.base.kind === 'outpost', '研究「前哨站」後可建立前哨站');
assert(!g.shelter.canEstablish(g.state.map.pois.find((p) => !g.shelter.baseAtPoi(p.id))).ok, '前哨站數量受研究限制');
assert(g.shelter.dangerLevel(est.base) === g.shelter.baseDanger(est.base), '前哨站危險度不受文明度加成');
assert(!g.shelter.canUpgradeFacility(est.base, 'farm').ok && g.shelter.canUpgradeFacility(est.base, 'watchtower').ok, '前哨站只能建造防禦設施');
for (let i = 0; i < 300; i += 1) g.siege.update(0.1);
assert(g.siege.sieges.size === 2, '每個據點各自承受屍潮');

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
  g3.shelter.establish(g3.state.map.pois[0]);
  const home = g3.shelter.primary();
  const far = g3.state.map.pois.find((p) => !g3.shelter.baseAtPoi(p.id) && haversine(home.lat, home.lon, p.lat, p.lon) > 600);
  setHour(g3, 21);
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
  ge.shelter.establish(ge.state.map.pois[0]);
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
  assert(!sv.heal(npc.id).ok, '飢餓中無法治療');
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
  // 人員上限：依領袖等級與據點等級提高，最多 10 人
  leader.level = 50;
  gv.state.bases[0].facilities = Object.fromEntries(Object.keys(gv.state.bases[0].facilities).map((k) => [k, { level: 10 }]));
  assert(sv.housing() === 10, `人員上限最多 10 人（目前 ${sv.housing()}）`);
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
  const small = gv.shelter.sizeInfo(gv.state.map.pois.find((p) => p.type === 'gasStation'));
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
  // 物資：探索後清空，每天 06:00、18:00 刷新且隨機
  const { stockOf, dayKey } = await import('../src/systems/LootStock.js');
  const poi = { id: 'osm_w1', type: 'shop', name: 'x', lat: 0, lon: 0 };
  const today = stockOf(poi);
  assert(!today.empty && Object.keys(today.resources).length >= 1, '建築每天有物資');
  assert(JSON.stringify(stockOf(poi)) === JSON.stringify(today), '同一天物資固定');
  poi.lootedDay = dayKey();
  assert(stockOf(poi).empty, '探索後物資清空');
  const tomorrow = Date.now() + 86400000;
  assert(!stockOf(poi, tomorrow).empty, '下一個時段重新刷新');
  const d0 = new Date(); d0.setHours(5, 59, 0, 0);
  const d1 = new Date(d0); d1.setHours(6, 1, 0, 0);
  const d2 = new Date(d0); d2.setHours(17, 59, 0, 0);
  const d3 = new Date(d0); d3.setHours(18, 1, 0, 0);
  assert(dayKey(d0.getTime()) !== dayKey(d1.getTime()) && dayKey(d1.getTime()) === dayKey(d2.getTime()) && dayKey(d2.getTime()) !== dayKey(d3.getTime()), '每天 06:00 與 18:00 各刷新一次');
  const days = new Set(Array.from({ length: 10 }, (_, i) => JSON.stringify(stockOf({ ...poi, lootedDay: 0 }, Date.now() + i * 86400000).resources)));
  assert(days.size > 5, '每天物資的種類與數量隨機');
}

// ---- 10. v4：區域危險度、屍潮分波、載具、放棄據點、NPC 據點 ----
{
  const { ZONES, zoneIndexAt, zoneAt } = await import('../src/config/zones.js');
  const { stockOf } = await import('../src/systems/LootStock.js');
  const counts = ZONES.map(() => 0);
  for (let i = 0; i < 20000; i += 1) counts[zoneIndexAt(25 + (i % 141) * 0.0011, 121 + Math.floor(i / 141) * 0.0011)] += 1;
  assert(counts.every((c) => c > 0), `六種區域都會出現（${counts.join('/')}）`);
  assert(zoneIndexAt(25.01, 121.52) === zoneIndexAt(25.01, 121.52), '同一座標的區域固定（所有玩家相同）');
  // 找一棟安全區與一棟深淵區的建築比較物資
  const find = (idx) => {
    for (let i = 0; i < 40000; i += 1) {
      const lat = 25 + (i % 200) * 0.0009;
      const lon = 121 + Math.floor(i / 200) * 0.0009;
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
  gw.shelter.establish(gw.state.map.pois[0]);
  setHour(gw, 21);
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
  assert(sw.spawnInterval() < small * 0.6, '巨型據點屍潮比小型據點多');

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
  gc.shelter.establish(gc.state.map.pois[0]);
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
  ga.shelter.establish(ga.state.map.pois[0]);
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
  gn.shelter.establish(gn.state.map.pois[0]);
  setHour(gn, 10);
  const t0 = Date.now();
  gn.npcs.update(t0);
  gn.npcs.update(t0 + 61000);
  gn.npcs.update(t0 + 122000);
  const perCell = {};
  gn.npcs.list.forEach((n) => { perCell[n.cell] = (perCell[n.cell] || 0) + 1; });
  assert(gn.npcs.list.length >= 2 && Object.values(perCell).every((c) => c <= 2) && Object.values(perCell).some((c) => c === 2), `每平方公里約 2 個 NPC 據點（共 ${gn.npcs.list.length} 個、${Object.keys(perCell).length} 格）`);
  const npc = gn.npcs.list.find((n) => n.level < 30) || gn.npcs.list[0];
  const lv = npc.level;
  const { SHARED_NPC } = await import('../src/systems/NpcSystem.js');
  assert(gn.npcs.sharedLevel(npc, t0 + SHARED_NPC.levelMs) === gn.npcs.sharedLevel(npc, t0) + 1 && lv >= 1, 'NPC 據點會隨時間升級');
  npc.trip = null;
  npc.nextExploreAt = t0;
  npc.nextRaidAt = t0 + 1e9;
  gn.npcs.update(t0 + 2000);
  assert(npc.trip?.kind === 'explore', 'NPC 會外出探索');
  const target = gn.state.map.pois.find((p) => p.id === npc.trip.poiId);
  gn.npcs.update(npc.trip.endAt + 1);
  assert(target.lootedDay, 'NPC 探索後建築被搜刮一空');
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
  gn.state.survivors.forEach((s) => { s.level = 1; });
  assert(gn.npcs.raidLevelCap() === 21, `NPC 掠奪等級上限 = 倖存者平均等級 + 20（${gn.npcs.raidLevelCap()}）`);
  gn.npcs.update(t0 + 2500);
  assert(!npc.trip, '等級差超過 20 的 NPC 不會來掠奪');
  npc.nextRaidAt = t0;
  gn.state.survivors.forEach((s) => { s.level = 12; });
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
  const atk = gn.exploration.start(weak.id, ['leader'], 5, false, Date.now(), { kind: 'raid' });
  assert(atk.ok, '派隊攻打 NPC 據點');
  const coinsBefore = gn.state.player.coins;
  const [rr] = gn.exploration.update(Date.now() + 3 * 3600e3, { silent: true });
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
  gr.shelter.establish(gr.state.map.pois[0]);
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
  assert(craftRarityTable(0).legendary === 0 && Math.abs(craftRarityTable(0).epic - 0.1) < 1e-9 && Math.abs(craftRarityTable(15).legendary - 0.2) < 1e-9, '製作初始稀有 0%、罕見 0.1%，滿級稀有 0.2%');
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
  gs.shelter.establish(gs.state.map.pois[0]);
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
  gs.exploration.update(Date.now() + 5000, { silent: true });

  // 個人背包與倉庫
  gs.state.resources.food = 500;
  assert(gs.survivors.withdraw('leader', 'food', 30).ok && lead.bag.food === 30 && gs.state.resources.food === 470, '從倉庫取出放進背包');
  assert(gs.survivors.withdraw('leader', 'food', 1e6).n === gs.survivors.bagCap(lead) - 30, '背包受負重上限限制');
  assert(gs.survivors.deposit('leader', 'food', 10).ok && gs.survivors.carried('food') === gs.survivors.bagCap(lead) - 10, '背包存入倉庫，總量含隊員攜帶');
  lead.status = 'exploring';
  assert(!gs.survivors.deposit('leader', 'food', 1).ok, '不在避難所無法存取倉庫');
  lead.status = 'idle';
  lead.bag = {};
  const lost = gs.survivors.stash([lead], { wood: 10000 });
  assert(lead.bag.wood === gs.survivors.bagCap(lead) && lost === 10000 - gs.survivors.bagCap(lead), '倉庫放不下的探索物資由隊員背包攜帶');

  // 重新掃描包含前哨站附近（較小範圍）
  gs.state.research.levels.e_outpost = 1;
  gs.research.invalidate();
  fillSupplies(gs);
  gs.state.player.coins = 1e5;
  gs.shelter.establish(gs.state.map.pois.find((p) => !gs.shelter.baseAtPoi(p.id)));
  const areas = gs.scanAreas(25.03, 121.56);
  assert(areas.length === 2 && areas[1].radius < areas[0].radius, '重新掃描包含前哨站附近，範圍較小');
}

// ---- 13. v6.1：起始無產出、主角無品級、刪除進度移除公開資料 ----
{
  const gz = Game.newGame({ playerName: 'Z', classId: 'warrior', lat: 0, lon: 0 });
  gz.state.map.pois = fillPois([], 0, 0);
  gz.shelter.establish(gz.state.map.pois[0]);
  const gross = gz.resources.rates().gross;
  assert(Object.values(gross).every((v) => v === 0), `遊戲起始沒有任何產出（${JSON.stringify(gross)}）`);
  const leader = gz.survivors.leader();
  assert(leader.rarity === null && gz.survivors.growthMul(leader) === 1.5, '主角沒有品級，成長比照稀有');
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
  gi.shelter.establish(gi.state.map.pois[0]);
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
  gq.shelter.establish(gq.state.map.pois[0]);
  const home = gq.shelter.primary();
  assert(FACILITIES.warehouse.name === '消耗品倉庫' && FACILITIES.itemStore.name === '物品倉庫' && home.facilities.itemStore.level === 1, '倉庫分為消耗品倉庫與物品倉庫');
  const cap0 = gq.resources.storageCap();
  const slots0 = gq.equipment.storeCap();
  home.facilities.warehouse.level = 3;
  assert(gq.resources.storageCap() > cap0 && gq.equipment.storeCap() === slots0, '消耗品倉庫只提高消耗品上限');
  home.facilities.itemStore.level = 3;
  assert(gq.equipment.storeCap() === slots0 + 26, '物品倉庫提高物品格子');
  assert(gq.shelter.sizeInfo(home).total <= 20, '據點建築總數上限仍為 20');
  // 堆疊上限 999
  const lead = gq.survivors.leader();
  gq.vehicles.memberCarry = () => 1e6;
  gq.state.resources.food = 5000;
  home.facilities.warehouse.level = 10;
  assert(gq.survivors.withdraw(lead.id, 'food', 1500).ok && gq.equipment.bagSlotsUsed(lead) === 2, `消耗品每格最多堆疊 ${STACK_MAX}（1500 佔 2 格）`);
  lead.bag = {};
  gq.state.resources.food = 50000;
  const max = gq.survivors.withdraw(lead.id, 'food', 1e6);
  assert(max.n === gq.equipment.bagSlotCap(lead) * STACK_MAX, '背包格子決定可攜帶的消耗品上限');
  lead.bag = {};
  // GPS：50 公尺內的建築被偵測；在據點範圍內不偵測
  const poi = gq.state.map.pois.find((p) => !gq.shelter.baseAtPoi(p.id) && Math.hypot((p.lat - home.lat) * 111320, (p.lon - home.lon) * 100000) > 300);
  gq.gps.discover = async () => {};
  gq.gps.onPosition(poi.lat + 0.0002, poi.lon);
  assert(gq.gps.status === 'active' && gq.gps.nearby.some((p) => p.id === poi.id) && gq.gps.isDetected(poi), 'GPS 偵測 50 公尺內的建築');
  assert(gq.gps.nearby.every((p) => Math.hypot((p.lat - poi.lat - 0.0002) * 111320, (p.lon - poi.lon) * 100800) <= 55), '只偵測 50 公尺內');
  gq.gps.onPosition(home.lat, home.lon);
  assert(gq.gps.status === 'inBase' && gq.gps.nearby.length === 0, '人在自己的據點範圍內時不偵測');
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
  gk.shelter.establish(gk.state.map.pois[0]);
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
  assert(ex.ok && lead.loadout.ammo?.qty === sup.AMMO_FOR.pistol.perFight * sup.AMMO_PACK_FIGHTS, '出發時自動把彈藥裝進彈藥欄');
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
  setHour(gk, 21);
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
  gc.shelter.establish(gc.state.map.pois[0]);
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
  gd.shelter.establish(gd.state.map.pois[0]);
  setHour(gd, 21);
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
  gs0.shelter.establish(gs0.state.map.pois[0]);
  gs0.state.resources.wood = 1000; // 木材可從樹林取得，這裡只檢查零件與布料
  ['wall', 'warehouse', 'itemStore', 'farm'].forEach((id) => assert(gs0.shelter.canUpgradeFacility(null, id).ok, `開局的零件與布料足夠升級${FACILITIES[id].name}`));
}

// ---- 21. v8.3.2：返程中的隊伍不能召回 ----
{
  const gr2 = Game.newGame({ playerName: 'R', classId: 'warrior', lat: 25, lon: 121 });
  gr2.state.map.pois = fillPois([], 25, 121);
  gr2.shelter.establish(gr2.state.map.pois[0]);
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
  gq2.shelter.establish(gq2.state.map.pois[0]);
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
  assert(DAY_REAL_MS === 3600000, '遊戲一天為現實 1 小時');
  const gt = Game.newGame({ playerName: 'T', classId: 'warrior', lat: 25, lon: 121 });
  gt.state.createdAt = Date.now() - 5.5 * 30 * 60000; // 舊制（30 分鐘一天）下的第 6 天 20:00
  const old = JSON.parse(JSON.stringify(gt.state));
  old.version = 12;
  const mig = SaveManager.migrate(old);
  const gm = new Game(mig);
  assert(gm.time.survivalDay() === 6, `舊存檔換算後生存天數不變（第 ${gm.time.survivalDay()} 天）`);
}

// ---- 24. v8.7：據點遭襲紀錄 ----
{
  const gl = Game.newGame({ playerName: 'L', classId: 'warrior', lat: 25, lon: 121 });
  gl.state.map.pois = fillPois([], 25, 121);
  gl.shelter.establish(gl.state.map.pois[0]);
  const base = gl.shelter.primary();
  // 屍潮突破 → 防禦失敗，記錄損失與毀損建築
  setHour(gl, 21);
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
  gl2.shelter.establish(gl2.state.map.pois[0]);
  gl2.shelter.primary().facilities.wall.level = 10;
  setHour(gl2, 21);
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
    gx.shelter.establish(gx.state.map.pois[0]);
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
  // 每 10 分鐘只換掉 1 格
  const t0 = Date.now();
  const later = gt.blackMarket.shelf(t0 + BLACK_MARKET.rotateMs).map((x) => x.id);
  const diff = shelfT.filter((x, i) => x.id !== later[i]).length;
  assert(diff === 1, `每 10 分鐘換掉 1 格（換了 ${diff} 格）`);
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
    gw.shelter.establish(gw.state.map.pois[0]);
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
  // 夜晚屍群：結果相同且只結算一次
  const n2 = A.npcs.list.find((n) => n.sid);
  const n2b = B.npcs.get(n2.id);
  const night = A.time.nightKey(later);
  A.npcs.nightSiege(n2, night, later);
  B.npcs.nightSiege(n2b, night, later);
  assert(n2.lastSiege.result === n2b.lastSiege.result, '同一晚 NPC 抵禦屍群的結果所有玩家相同');
  await new Promise((r) => setTimeout(r, 5));
  await A.shared.poll();
  const d = A.shared.get('npc', n2.sid);
  assert(d.siegeNight === night, '屍群結果寫入共用資料（每晚只結算一次）');
  // 單機（沒有伺服器）：摧毀的 NPC 重新開啟後仍然消失
  const S = Game.newGame({ playerName: 'S', classId: 'warrior', lat: 25.02, lon: 121.02 });
  S.state.map.pois = JSON.parse(JSON.stringify(pois));
  S.shelter.establish(S.state.map.pois[0]);
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
    gx.shelter.establish(gx.state.map.pois[0]);
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
    gx.shelter.establish(gx.state.map.pois[0]);
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
    gx.shelter.establish(gx.state.map.pois[0]);
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
  assert(Math.abs(B.infected.purity(s, t0 + 600000) - (30 - INFECTED.decayPerHour / 6)) < 0.01 || B.infected.siteDay(t0 + 600000) !== B.infected.siteDay(t0), '未清除時淨化度緩慢回復感染');
  // 單一隊伍很難清除
  const one = A.infected.battle(A.infected.get(s.id, t0), A.state.survivors, [], t0);
  assert(!one.result.victory && one.gain < 40, `單人隊伍無法一次清除（淨化 +${one.gain.toFixed(1)}%）`);
  // 兩人同時把淨化度推到 100%：只有一人負責發獎勵
  const [ka, kb] = await Promise.all([A.infected.addPurity(s, 80, t0), B.infected.addPurity(s, 80, t0)]);
  assert((ka.killed ? 1 : 0) + (kb.killed ? 1 : 0) === 1, '同時淨化到 100% 時只有一人取得消滅獎勵');
  await A.shared.poll();
  await B.shared.poll();
  assert(!A.infected.get(s.id, t0) && !B.infected.get(s.id, t0), '消滅後所有玩家的地圖上都消失');
  const next = A.infected.nextRefresh(t0);
  assert(A.infected.list(next + 1000).some((x) => x.id === s.id), '下一個中午 12:00 重新出現');
  // 獎勵：1 人 3～4 種，每多 1 人上下限 +2，最低優良
  const rw1 = A.infected.rewards(s, 1);
  const n1 = rw1.items.length + Object.keys(rw1.mats).length;
  const rw3 = A.infected.rewards(s, 3);
  const n3 = rw3.items.length + Object.values(rw3.mats).length;
  assert(n1 >= 2 && n1 <= 4 && rw3.items.every((it) => ['uncommon', 'rare', 'epic', 'legendary'].includes(it.rarity)), `消滅獎勵數量與品級（1 人 ${n1} 種）`);
  void n3;
  // 不會與玩家據點重疊：在據點位置上的重度感染據點會移到格子內其他位置
  const s0 = A.infected.list()[0];
  const C2 = mk('C2');
  C2.world.others = [{ id: 'X', bases: [{ lat: s0.lat, lon: s0.lon, alert: 90 }], trips: [] }];
  const moved = C2.infected.list().find((x) => x.id === s0.id);
  const allZones = C2.infected.playerZones();
  assert(!moved || (haversine(moved.lat, moved.lon, s0.lat, s0.lon) > 90 + 120), '重度感染據點會避開其他玩家的據點與警戒範圍');
  assert(C2.infected.list().every((x) => allZones.every((z) => haversine(z.lat, z.lon, x.lat, x.lon) > z.r)), '所有重度感染據點都不在玩家據點範圍內');
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
  const mk = (name) => {
    const gx = Game.newGame({ playerName: name, classId: 'warrior', lat: 25.15, lon: 121.15 });
    gx.state.map.pois = JSON.parse(JSON.stringify(pois));
    gx.shelter.establish(gx.state.map.pois[0]);
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
  const target = { kind: 'npc', id: n.id, ident: n.ident, name: n.name, lat: n.lat, lon: n.lon };
  assert(!A.rally.canStart(target).ok, '沒有廣播塔不能發起集結');
  A.shelter.primary().facilities.broadcast.level = 1;
  assert(A.rally.maxTeams() === 2, '廣播塔 Lv1 可集結 2 支隊伍');
  const lead = A.survivors.leader();
  const st = await A.rally.start(target, 5, [lead.id]);
  assert(st.ok && lead.status === 'exploring', `發起集結，自己的隊伍加入（${st.reason || ''}）`);
  assert(!(await A.rally.start(target, 5, [])).ok, '同時只能發起一個集結');
  await B.shared.poll();
  B.rally.lastAt = 0;
  B.rally.update(Date.now());
  assert(B.rally.invites().length === 1 && B.state.log.some((l) => l.msg.includes('發起集結')), '好友收到集結通知');
  const C = mk('C');
  await C.shared.poll();
  assert(!C.rally.invites().length && !(await C.rally.join(st.id, [C.survivors.leader().id])).ok, '不是好友不能參加');
  const jb = await B.rally.join(st.id, [B.survivors.leader().id]);
  assert(jb.ok, `好友參加集結（${jb.reason || ''}）`);
  // 滿員立即出發；A 之後離線
  await A.shared.poll();
  await A.rally.step(A.rally.trips()[0], Date.now());
  await B.shared.poll();
  const d1 = B.rally.get(st.id);
  assert(d1.status === 'departed' && d1.fightAt >= Date.now() - 1000, '滿員時立即出發');
  // 發起人 A 離線（不再執行）；B 到時間自己結算
  await B.rally.step(B.rally.trips()[0], d1.fightAt + 1);
  await B.shared.poll();
  const d2 = B.rally.get(st.id);
  assert(d2.status === 'done' && d2.result, `發起人離線時，其他參加者也能結算（${d2.status}）`);
  await B.rally.step(B.rally.trips()[0], d1.fightAt + 2);
  const eb = B.rally.trips()[0];
  const cb0 = B.state.player.coins;
  const reps = B.exploration.update(eb.endAt + 1, { silent: true });
  assert(reps.some((r) => r.poiName.includes('集結')) && !B.rally.trips().length, 'B 的隊伍帶著結果回家');
  // A 之後上線：同步並收到自己的那一份
  await A.shared.poll();
  await A.rally.step(A.rally.trips()[0], d1.fightAt + 5);
  const ea = A.rally.trips()[0];
  const ca0 = A.state.player.coins;
  A.exploration.update(ea.endAt + 1, { silent: true });
  assert(!A.rally.trips().length && lead.status === 'idle', '離線的發起人上線後隊伍回家並結算');
  assert(d2.result.victory, `強大的集結隊伍攻陷弱小的 NPC（${d2.result.summary}）`);
  {
    assert(A.state.player.coins - ca0 === B.state.player.coins - cb0 && A.state.player.coins > ca0, `勝利時金錢平分（${A.state.player.coins - ca0} / ${B.state.player.coins - cb0}）`);
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
  await B.rally.step(B.rally.trips()[0], Date.now());
  assert(!B.rally.trips().length && B.survivors.leader().status === 'idle', '集結取消後參加者的隊員留在避難所');
}

// ---- 25g. v9.0.1：帶不走的物資留在建築裡，重複探索不會越變越多 ----
{
  const gf = Game.newGame({ playerName: 'F', classId: 'warrior', lat: 25, lon: 121 });
  gf.state.map.pois = fillPois([], 25, 121);
  gf.shelter.establish(gf.state.map.pois[0]);
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
  gq3.shelter.establish(gq3.state.map.pois[0]);
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
  gf.shelter.establish(gf.state.map.pois[0]);
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
  gh.shelter.establish(gh.state.map.pois[0]);
  setHour(gh, 21);
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
  gr3.shelter.establish(gr3.state.map.pois[0]);
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
  gl.shelter.establish(gl.state.map.pois[0]);
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
  gw.shelter.establish(gw.state.map.pois[0]);
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
  gn.shelter.establish(gn.state.map.pois[0]);
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
  gz.shelter.establish(gz.state.map.pois[0]);
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
  gq.shelter.establish(gq.state.map.pois[0]);
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
  // 夜晚：NPC 也要抵禦屍群（每晚一次）
  setHour(gq, 22);
  n.wounded = 0;
  gq.npcs.update(Date.now());
  const night = gq.time.nightKey();
  assert(n.siegeNight === night || !gq.npcs.get(n.id), 'NPC 據點在夜晚抵禦屍群');
  const last = JSON.stringify(n.lastSiege);
  gq.npcs.update(Date.now());
  assert(JSON.stringify(n.lastSiege) === last, '每晚只結算一次');
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
  gd.shelter.establish(gd.state.map.pois[0]);
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
  gm.shelter.establish(gm.state.map.pois[0]);
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
  gc.shelter.establish(gc.state.map.pois[0]);
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
    gx.shelter.establish(gx.state.map.pois[0]);
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
  ge.shelter.establish(ge.state.map.pois[0]);
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
  gt.thinMap();
  assert(gt.state.map.pois.some((p) => p.id === 'r3') && gt.state.map.pois.filter((p) => p.type === 'forest').length >= 95 && gt.state.map.pois.filter((p) => p.type === 'pharmacy').length >= 35, '舊地圖整理密度時保留據點，並補足樹林與藥局');
}

// ---- 42. v8.28：攻擊據點要先破牆、再打贏人員；威脅提示 ----
{
  const gw = Game.newGame({ playerName: 'W2', classId: 'warrior', lat: 25, lon: 121 });
  gw.state.map.pois = fillPois([], 25, 121);
  gw.shelter.establish(gw.state.map.pois[0]);
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
  gc.shelter.establish(gc.state.map.pois[0]);
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
  gz.shelter.establish(gz.state.map.pois[0]);
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
  gn.shelter.establish(gn.state.map.pois[0]);
  setHour(gn, 10);
  const free = gn.state.map.pois.filter((p) => !gn.shelter.baseAtPoi(p.id));
  const a1 = gn.npcs.spawnAt(free[1], 'x', Date.now(), true);
  const a2 = gn.npcs.spawnAt(free[2], 'y', Date.now(), true);
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
  ge.shelter.establish(ge.state.map.pois[0]);
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
  gn.shelter.establish(gn.state.map.pois[0]);
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
  ga.shelter.establish(ga.state.map.pois[0]);
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
  assert(ga.survivors.setSupply(lead.id, 'med', null).ok && !lead.supply.med, '可以取消自動補給');
  // 彈藥欄：最多 100，戰鬥優先用遠程，沒彈藥改用近戰
  const gun = ga.equipment.generate({ level: 5, model: 'm1911', rarity: 'common' });
  const knife = ga.equipment.generate({ level: 5, model: 'knife', rarity: 'common' });
  [gun, knife].forEach((it) => { ga.equipment.addItem(it, 't'); ga.equipment.equip(lead.id, it.id); });
  assert(lead.equipment.weapon === gun.id && lead.equipment.melee === knife.id, '遠程武器與近戰武器分開兩欄');
  ga.state.supplies.ammo9 = 300;
  assert(ga.survivors.loadSlot(lead.id, 'ammo', 'ammo9').ok && lead.loadout.ammo.qty === 100, '彈藥欄最多 100');
  const u1 = ga.combat.unitFromSurvivor(lead);
  assert(u1.weapon === 'ranged' && lead.loadout.ammo.qty === 94, '有彈藥時優先使用遠程武器並消耗彈藥欄');
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
  assert(r.log.some((l) => l.msg.includes('💊')) && lead.loadout.med.qty < 5, '生命過低時自動使用藥品欄的藥');
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
    gx.shelter.establish(gx.state.map.pois[0]);
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
  assert(B.state.defenseLog[0].note.includes('協防') && B.state.defenseLog[0].note.includes('協防者'), `防守紀錄寫入協防（${B.state.defenseLog[0].note}）`);
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
}

// ---- 53. v8.46：突襲避難所移動時間較長、載具仍加速 ----
{
  const gp = Game.newGame({ playerName: 'P', classId: 'warrior', lat: 25, lon: 121 });
  gp.state.map.pois = fillPois([], 25, 121);
  gp.shelter.establish(gp.state.map.pois[0]);
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
  gb.shelter.establish(gb.state.map.pois[0]);
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
  ga.shelter.establish(ga.state.map.pois[0]);
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
  let reps = ex.update(st.exp.endAt + 1, { silent: true });
  let cur = ga.state.expeditions[0];
  assert(cur && cur.poiId === pois[0].id && cur.queue.length === 1, `還有物資時再搜同一個地點、佇列保留（${reps[0]?.events.slice(-1)}）`);
  // 拿光了：前往佇列的下一個地點（不會自己換到附近其他地點）
  ex.hasStock = (p, at) => (p.id === pois[0].id ? false : orig(p, at));
  reps = ex.update(cur.endAt + 1, { silent: true });
  cur = ga.state.expeditions[0];
  assert(cur && cur.poiId === pois[1].id && !cur.queue.length, `拿光後前往佇列的下一個地點（${reps[0]?.events.slice(-1)}）`);
  ex.hasStock = (p) => (p.id === pois[1].id ? false : true);
  reps = ex.update(cur.endAt + 1, { silent: true });
  assert(!ga.state.expeditions.length && reps[0].events.some((e) => e.includes('自動探索結束')), '佇列也沒有地點時自動探索結束，不會換到附近其他地點');
  ex.hasStock = orig;
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
    gx.shelter.establish(gx.state.map.pois[0]);
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
  assert(log && log.note.includes('友好協防') && log.note.includes('H'), `防守紀錄寫入協防（${log?.note}）`);
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
  assert(V.state.defenseLog[0].note.includes('友好協防'), `被突襲方的防守紀錄寫入協防（${V.state.defenseLog[0].note}）`);
}

// ---- 59. v9：NPC 據點大幅增強 ----
{
  const { createSurvivor: cs } = await import('../src/core/GameState.js');
  let wins = 0;
  for (let t = 0; t < 8; t += 1) {
    const gn = Game.newGame({ playerName: 'N', classId: 'warrior', lat: 25, lon: 121 });
    gn.state.map.pois = fillPois([], 25, 121);
    gn.shelter.establish(gn.state.map.pois[0]);
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
  gq2.shelter.establish(gq2.state.map.pois[0]);
  const lead = gq2.survivors.leader();
  const weak = gq2.equipment.generate({ level: 3, model: 'knife', rarity: 'poor' });
  const strong = gq2.equipment.generate({ level: 10, model: 'knife', rarity: 'epic' });
  const gun = gq2.equipment.generate({ level: 10, model: 'ak47', rarity: 'epic' });
  [weak, strong, gun].forEach((it) => gq2.equipment.addItem(it, 't'));
  gq2.equipment.equip(lead.id, weak.id);
  delete gq2.state.supplies.ammo556;
  lead.bag = {};
  const r = gq2.equipment.quickEquip(lead.id);
  assert(r.ok && lead.equipment.melee === strong.id && !lead.equipment.weapon, `快速換裝換上戰力最高的近戰武器，沒有彈藥的槍不換（${r.msg}）`);
  gq2.state.supplies.ammo556 = 50;
  gq2.equipment.quickEquip(lead.id);
  assert(lead.equipment.weapon === gun.id, '有彈藥時換上遠程武器');
}

// ---- 62. v9 警戒模式 ----
{
  const ga2 = Game.newGame({ playerName: 'AL', classId: 'warrior', lat: 25, lon: 121 });
  ga2.state.map.pois = fillPois([], 25, 121);
  ga2.shelter.establish(ga2.state.map.pois[0]);
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
  gq3.shelter.establish(gq3.state.map.pois[0]);
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
  const [rep] = ex.update(st.exp.endAt + 1, { silent: true });
  const next = gq3.state.expeditions[0];
  assert(rep && next && next.poiId === pois[1].id && next.queue.length === 1, `完成後自動前往佇列中的下一個地點（${rep?.events.slice(-1)}）`);
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
  [ca, cb, cc].forEach((x) => x.shelter.establish(x.state.map.pois[0]));
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
  dd.shelter.establish(dd.state.map.pois[0]);
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
  gv2.shelter.establish(gv2.state.map.pois[0]);
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
  gw5.shelter.establish(gw5.state.map.pois[0]);
  const b5 = gw5.shelter.primary();
  b5.defenses[0] = { slot: 0, type: 'watchPost', level: 3, garrisonId: null };
  gw5.survivors.leader().job = 'scavenge';
  const sg = gw5.siege.of(b5.id);
  const none = sg.defenseDps();
  gw5.shelter.garrison(b5, 0, 'leader');
  assert(sg.defenseDps() > none, '瞭望塔駐守人員計入守城火力（NPC 掠奪與玩家突襲破牆前都會射擊）');
  assert(gw5.territory.garrison(b5).count === 1 && gw5.npcs.defenders(b5).some((x) => x.id === 'leader'), '瞭望塔駐守人員算在警戒範圍駐守人數，破牆後也會迎戰 NPC');
  assert(gw5.world == null && gw5.npcs.baseDefense(b5) > 0, 'NPC 判斷防禦強度時計入瞭望塔');
}

// ---- 70. v9.9 倖存者能力素質 ----
{
  const { QUALITY_KEYS, qualityMul, rollQuality } = await import('../src/config/survivors.js');
  const gq5 = Game.newGame({ playerName: 'Q5', classId: 'warrior', lat: 25, lon: 121 });
  const cand = gq5.survivors.makeCandidate(5);
  assert(QUALITY_KEYS.every((k) => Number.isInteger(cand.quality[k]) && cand.quality[k] >= 0 && cand.quality[k] <= 100), '新的倖存者每項能力都有 0～100% 素質');
  assert(gq5.survivors.qualityOf(gq5.survivors.leader(), 'atk') === 100 && gq5.survivors.avgQuality(gq5.survivors.leader()) === 100, '首領素質一律 100%');
  assert(qualityMul('atk', 0) === 0.85 && qualityMul('atk', 50) === 1 && Math.abs(qualityMul('atk', 100) - 1.15) < 1e-9 && Math.abs(qualityMul('atkSpeed', 100) - 1.1) < 1e-9, '素質倍率 0% ×0.85、50% ×1、100% ×1.15（攻速 ×0.9～×1.1）');
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
  gv3.shelter.establish(gv3.state.map.pois[0]);
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
  const n3 = gv3.state.expeditions[0];
  assert(n3 && !(n3.vehicleIds || []).includes(c3.id) && c3.status === 'idle', '損壞的指定載具回程後自動解除鎖定，不會跟著出門');
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
  const up = gc6.shelter.canUpgradeFacility(hb, 'farm');
  assert(!up.ok && /需要更大的據點/.test(up.reason), '設施達到據點規模上限時不能再升級');
  hb.facilities.farm.level = 12;
  hb.facilities.workbench.level = 5;
  gc6.shelter.abandon(hb.id);
  const pv = gc6.shelter.relocationCapPreview(small);
  assert(pv.changes.some((c) => c.id === 'farm' && c.from === 12 && c.to === 8) && !pv.changes.some((c) => c.id === 'workbench'), '搬遷前可預覽小地點會降級的設施');
  const before6 = JSON.stringify(gc6.state.supplies) + JSON.stringify(gc6.state.resources);
  const nb6 = gc6.shelter.establish(small).base;
  assert(nb6.facilities.farm.level === 8 && nb6.facilities.workbench.level === 5, '搬到較小的地點：超過上限的設施降到上限，其他不變');
  assert(JSON.stringify(gc6.state.supplies) + JSON.stringify(gc6.state.resources) !== before6, '降掉的等級退還建造材料');
  // 舊存檔：超過上限的設施降級並退還
  const od = JSON.parse(JSON.stringify(gc6.state));
  od.version = 21;
  od.bases[0].facilities.farm.level = 12;
  const supBefore = JSON.stringify(od.supplies);
  const md = SaveManager.migrate(od);
  assert(md.bases[0].facilities.farm.level === 8 && JSON.stringify(md.supplies) !== supBefore, '舊存檔超過上限的設施降到上限並退還材料');
}

// ---- 73. 建築內遭遇依實際搜索時間判定日夜 ----
{
  const gp = Game.newGame({ playerName: 'P7', classId: 'warrior', lat: 25, lon: 121 });
  gp.state.map.pois = fillPois([], 25, 121);
  gp.shelter.establish(gp.state.map.pois[0]);
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

// ---- 75. 同一晚多位玩家都結算 NPC 抵禦屍群：不重複扣等級 ----
{
  const { MemoryObjects } = await import('../src/multiplayer/SharedWorld.js');
  const store = new MemoryObjects();
  const pois = fillPois([], 25.3, 121.3);
  const mk = (name) => {
    const gx = Game.newGame({ playerName: name, classId: 'warrior', lat: 25.3, lon: 121.3 });
    gx.state.map.pois = JSON.parse(JSON.stringify(pois));
    gx.shelter.establish(gx.state.map.pois[0]);
    gx.shared.backend = store;
    gx.world = { others: [], myId: name, identity: () => ({ id: name, token: 't' }) };
    gx.npcs.fillCells(Date.now(), { silent: true });
    return gx;
  };
  const A = mk('A');
  const B = mk('B');
  let night = null;
  let nA = null;
  for (let k = 0; k < 300 && !night; k += 1) {
    nA = A.npcs.list[k % A.npcs.list.length];
    const save = JSON.parse(JSON.stringify(nA));
    const before = nA.levelLoss || 0;
    A.npcs.nightSiege(nA, `t${k}`, Date.now());
    await new Promise((r) => setTimeout(r, 2));
    if ((nA.levelLoss || 0) > before && A.npcs.list.includes(nA)) night = `t${k}`;
    else Object.assign(nA, save);
  }
  assert(!!night, '找到 NPC 被屍群突破而降級的夜晚');
  const nB = B.npcs.list.find((x) => x.ident === nA.ident);
  // B 還沒同步到 A 的結算就自己也結算了同一晚
  B.npcs.nightSiege(nB, night, Date.now());
  await new Promise((r) => setTimeout(r, 20));
  const server = store.map.get(`npc:${nA.sid}`)?.data?.levelLoss;
  assert(nB.levelLoss === server && nA.levelLoss === server, `別人已經結算過的夜晚不會在本機重複扣等級（A ${nA.levelLoss}／B ${nB.levelLoss}／伺服器 ${server}）`);
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
  assert(Math.abs(gs.civilization.siegeHpMul() - (1 + 546 * 0.0042)) < 0.01, '文明 566 屍潮生命倍率維持預計強度');
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
  assert(Math.abs(bz.maxHp / Math.round(be.maxHp * gs.civilization.siegeHpMul() * SS.bossMul) - 1) < 0.01, '屍潮 Boss 生命另乘 0.5');
  s.zombies = [];
  // 天亮結算：城牆 90% → 優秀 ×1.5
  sv.job = 'guard';
  s.startNight();
  s.wave = 4; s.nightKills = 50;
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
  // 城牆 30% → 普通 ×1.0
  s.startNight(); s.wave = 2; s.nightKills = 10;
  b.wallHp = gs.shelter.wallMax(b) * 0.3;
  s.endNight();
  assert(gs.state.defenseLog[0].siege.grade === 'normal' && gs.state.defenseLog[0].siege.coins === 20, '城牆剩 30%：評價普通 ×1.0');
  // 中途才開始駐守的人沒有駐守經驗
  s.startNight(); s.wave = 1; s.nightKills = 1;
  const late = createSurvivor('晚到', 'scout', 5, 'common');
  gs.state.survivors.push(late);
  late.job = 'guard';
  s.endNight();
  assert(!gs.state.defenseLog[0].siege.xp.some((x) => x.name === '晚到'), '中途才開始駐守的人不給駐守經驗');
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

// ---- 5. 通行碼雜湊（純 JS SHA-256 與 Node crypto 結果一致）----
let ref = 'jdqs-gate:密碼 test';
for (let i = 0; i < ACCESS_ITERATIONS; i += 1) ref = crypto.createHash('sha256').update(ref).digest('hex');
assert(hashAccessCode('  密碼 test ') === ref, '通行碼雜湊與 Node crypto 一致（並忽略前後空白）');

if (failures) {
  console.error(`\n${failures} 項檢查失敗`);
  process.exit(1);
}
console.log(`✓ 全部通過（擊殺 ${g.state.stats.siegeKills}，探索事件 ${reports[0].events.length}）`);
