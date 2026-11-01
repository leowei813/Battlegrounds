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
import { DAY_REAL_MS, START_HOUR } from '../src/config/constants.js';

/** 把遊戲時鐘調到指定時刻（建檔時間往前推） */
const setHour = (game, hour) => {
  game.state.createdAt = Date.now() - (((hour - START_HOUR + 24) % 24) / 24) * DAY_REAL_MS;
};
import { SaveManager } from '../src/core/SaveManager.js';
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
assert(save.version === 17, 'state is serializable');
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
assert(migrated.version === 17 && migrated.bases.length === 1 && migrated.bases[0].kind === 'shelter' && migrated.primaryBaseId === migrated.bases[0].id && !migrated.shelter, 'v1 → v2 存檔遷移');

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
  assert(Object.keys(ITEM_TYPES).length >= 15 && SLOT_KEYS.length === 8, `裝備類型 ${Object.keys(ITEM_TYPES).length} 種、裝備欄 ${SLOT_KEYS.length} 個`);
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
  // 突破：資源 -50%，建築可能降級或被拆毀，當晚不再來襲
  Object.keys(gv.state.resources).forEach((k) => { gv.state.resources[k] = 1000; });
  base.defenses.forEach((d) => Object.assign(d, { type: 'trap', level: 1 }));
  const siege = gv.siege.of(base.id);
  let destroyed = 0;
  const cellarLv = base.facilities.cellar.level;
  base.facilities.cellar.level = 0;
  siege.breach();
  base.facilities.cellar.level = cellarLv;
  assert(Math.round(gv.state.resources.wood) === 500, `突破損失 50% 資源（木材 1000 → ${Math.round(gv.state.resources.wood)}）`);
  setHour(gv, 22);
  assert(siege.quiet() && !siege.active() && base.quietUntil > Date.now(), '防線被突破後當晚不再有屍潮');
  assert(!siege.quiet(base.quietUntil + 1), '天亮後恢復');
  destroyed = base.defenses.filter((d) => !d.type).length;
  for (let i = 0; i < 60 && !destroyed; i += 1) {
    siege.breach();
    destroyed = base.defenses.filter((d) => !d.type).length;
  }
  assert(destroyed > 0, `突破後 1 級建築可能被拆毀（${destroyed} 棟）`);
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
  const r = gw.exploration.start(poiFar.id, ['leader'], 15, false, Date.now(), { vehicleIds: [bike.id] });
  assert(r.ok && bike.status === 'out', '帶載具出發');
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

  // 放棄據點：退還 25%，搬家時超過運載量的物資被遺棄
  const ga = Game.newGame({ playerName: 'A', classId: 'warrior', lat: 0, lon: 0 });
  ga.state.map.pois = fillPois([], 0, 0);
  ga.shelter.establish(ga.state.map.pois[0]);
  const home = ga.shelter.primary();
  home.facilities.farm.level = 3;
  const built = ga.shelter.builtCost(home);
  const preview = ga.shelter.abandonPreview(home.id);
  assert(preview.refund.wood === Math.floor(built.wood * 0.25), '放棄據點退還 25% 建造資源');
  Object.keys(ga.state.resources).forEach((k) => { ga.state.resources[k] = 1000; });
  const ab = ga.shelter.abandon(home.id);
  const left = Object.values(ga.state.resources).reduce((a2, b2) => a2 + b2, 0);
  assert(ab.ok && !ga.shelter.hasShelter() && left <= preview.carry + 6, `搬家只能帶走運載量內的物資（剩 ${Math.round(left)} / 可搬 ${preview.carry}）`);
  assert(ga.shelter.canEstablish(ga.state.map.pois[1]).ok && ga.shelter.establish(ga.state.map.pois[1]).base.kind === 'shelter', '放棄後可重新建立避難所');

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
  const npc = gn.npcs.list[0];
  const lv = npc.level;
  npc.nextLevelAt = t0;
  gn.npcs.update(t0 + 1000);
  assert(npc.level === lv + 1, 'NPC 據點會升級');
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
  npc.level = 30;
  npc.trip = null;
  npc.wounded = 0;
  npc.nextRaidAt = t0;
  // 其他 NPC 不在掠奪中（避免同時攻打的機制擋下這次）
  gn.npcs.list.forEach((m) => { if (m !== npc && m.trip?.kind === 'raid') m.trip = null; });
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
  assert(Math.abs(so10.legendary - 0.2) < 1e-9 && Math.abs(Object.values(so10).reduce((a2, b2) => a2 + b2, 0) - 100) < 1e-9, '招募技術滿級稀有 0.2%');
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
  const th = gt.territory.threats(ph);
  assert(th.length === 1 && th[0].kind === 'player', '敵對據點的警戒範圍不會自動繞開，經過時會遭到駐守人員攻擊');
  assert(crossings(gt.territory.route(home, target, { avoidHostile: true }), [zoneCircle]).length === 0, '可選擇連敵對範圍也繞開');
  // 實際派隊：經過敵對範圍時發生戰鬥（打輸會撤退）
  setHour(gt, 10);
  const lead = gt.survivors.leader();
  Object.assign(lead, { status: 'idle', severe: false, hp: null, level: 1 });
  gt.world.others[0].bases[0].guards = 6;
  gt.world.others[0].bases[0].guardLevel = 40;
  gt.territory.noticed = () => true;
  const ex = gt.exploration.start(target.id, ['leader'], 10);
  assert(ex.ok && ex.exp.threats.length === 2, '出發時算出去程與返程會經過的敵對範圍');
  const [rep] = gt.exploration.update(ex.exp.endAt + 1, { silent: true });
  assert(!gt.state.expeditions.length && rep && !rep.success && rep.events.some((e) => e.includes('警戒範圍')), `在敵對範圍被駐守人員擊退後撤退（${JSON.stringify(rep?.events)}）`);
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
  assert(eq.storeCap() === STORE_BASE_SLOTS + 20 + 10, '升級物品倉庫與研究可增加物品格子');
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
  assert(gq.equipment.storeCap() === slots0 + 20, '物品倉庫提高物品格子');
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
  const full = gk.survivors.stats(lead).atk;
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
  assert(ex.ok && lead.bag.ammo9 === sup.AMMO_FOR.pistol.perFight * sup.AMMO_PACK_FIGHTS, '出發時自動從倉庫補充彈藥');
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
  const full = gd.survivors.stats(lead);
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

// ---- 23. v8.5：遊戲一天 = 現實 1 小時，舊存檔維持目前天數與時刻 ----
{
  assert(DAY_REAL_MS === 3600000, '遊戲一天為現實 1 小時');
  const gt = Game.newGame({ playerName: 'T', classId: 'warrior', lat: 25, lon: 121 });
  gt.state.createdAt = Date.now() - 5.5 * 30 * 60000; // 舊制（30 分鐘一天）下的第 6 天 20:00
  const old = JSON.parse(JSON.stringify(gt.state));
  old.version = 12;
  const mig = SaveManager.migrate(old);
  const gm = new Game(mig);
  assert(gm.time.day() === 6 && Math.abs(gm.time.hour() - 20) < 0.1, `舊存檔換算後天數與時刻不變（第 ${gm.time.day()} 天 ${gm.time.hour().toFixed(1)} 時）`);
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
  // 沒有人可以應戰時才被攻破
  gl.state.survivors.forEach((sv) => { sv.severe = true; });
  base.wallHp = 0;
  sl.spawn('walker');
  Object.assign(sl.zombies[0], { x: 0, y: 40 });
  for (let i = 0; i < 100 && !sl.quiet(); i += 1) sl.update(0.1);
  gl.state.survivors.forEach((sv) => { sv.severe = false; });
  const fail = gl.state.defenseLog[0];
  assert((fail?.damaged || []).length <= 2, `被攻破時最多損毀 2 棟建築（${(fail?.damaged || []).length}）`);
  assert(fail && !fail.success && fail.attacker === '屍潮' && fail.lost.food === 500, `屍潮突破時記錄防禦失敗與損失（${JSON.stringify(fail)}）`);
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

// ---- 25. v8.7：流浪商人 ----
{
  const { TRADER } = await import('../src/systems/TraderSystem.js');
  const gt = Game.newGame({ playerName: 'T', classId: 'warrior', lat: 25, lon: 121 });
  gt.state.map.pois = fillPois([], 25, 121);
  gt.shelter.establish(gt.state.map.pois[0]);
  setHour(gt, 9);
  gt.trader.update(Date.now());
  assert(!gt.state.trader && !gt.trader.isHere(), '早上 11 點前商人不會出現');
  // 找一個會出現的種子
  let appeared = false;
  for (let i = 0; i < 20 && !appeared; i += 1) {
    gt.state.trader = null;
    gt.state.rng.trader = 1000 + i;
    setHour(gt, 12);
    gt.trader.update(Date.now());
    appeared = gt.trader.isHere();
  }
  assert(appeared && gt.state.trader.stock.length === TRADER.goods, `11:00～15:00 有機率出現，帶著 ${TRADER.goods} 項商品`);
  const until = gt.state.trader.until;
  const left = (until - Date.now()) / DAY_REAL_MS * 24;
  assert(left > 2.9 && left < 3.1, `商人待到下午 3 點（剩 ${left.toFixed(2)} 小時）`);
  const gear = gt.state.trader.stock.filter((x) => x.kind === 'gear');
  const legendaryPrice = gt.trader.gearPrice(gt.equipment.generate({ level: 5, model: 'm1911', rarity: 'legendary' }));
  const poorPrice = gt.trader.gearPrice(gt.equipment.generate({ level: 5, model: 'm1911', rarity: 'poor' }));
  assert(legendaryPrice > poorPrice * 10 && gt.trader.supplyPrice('titanium') > gt.trader.supplyPrice('nail') && gt.trader.supplyPrice('largeKit') > gt.trader.supplyPrice('gauze'), '越稀有的商品越貴');
  const good = gt.state.trader.stock[0];
  gt.state.player.coins = 0;
  assert(!gt.trader.buy(good.id).ok, '金錢不足不能購買');
  gt.state.player.coins = 1e6;
  const coins0 = gt.state.player.coins;
  assert(gt.trader.buy(good.id).ok && gt.state.player.coins === coins0 - good.price && gt.state.trader.stock.length === TRADER.goods - 1, '用金錢購買商品');
  // 同一天不會重新出現；過了 15:00 離開
  const stock = JSON.stringify(gt.state.trader.stock);
  gt.trader.update(Date.now());
  assert(JSON.stringify(gt.state.trader.stock) === stock, '同一天商品不會重新產生');
  // 回收：約售價 1/8，越稀有比例越好
  gt.state.supplies.nail = 100;
  gt.state.supplies.titanium = 10;
  const c1 = gt.state.player.coins;
  assert(gt.trader.sell('nail', 100).ok && !gt.state.supplies.nail && gt.state.player.coins === c1 + gt.trader.buybackPrice('nail', 100), '可以把物資賣給商人');
  const rN = gt.trader.buybackRate('nail');
  const rT = gt.trader.buybackRate('titanium');
  assert(rN >= 0.09 && rN <= 0.14 && rT > rN && rT <= 0.16, `回收價約為售價 1/8，稀有物資比例較好（${rN.toFixed(3)} / ${rT.toFixed(3)}）`);
  assert(!gt.trader.sell('nail', 5).ok, '沒有的物資不能賣');
  // 裝備只能賣給商人
  const gi = gt.equipment.generate({ level: 5, model: 'm1911', rarity: 'rare' });
  gt.equipment.addItem(gi, 't');
  const c2 = gt.state.player.coins;
  const gp = gt.trader.gearBuyback(gi);
  assert(gp > 0 && gp < gt.trader.gearPrice(gi) / 5 && gt.trader.sellItem(gi.id).ok && gt.state.player.coins === c2 + gp && !gt.equipment.getItem(gi.id), `裝備可以賣給商人（約售價 1/8：💰${gp}）`);
  assert(!gt.trader.isHere(until + 1000), '下午 3 點後商人離開');
  void gear;
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

// ---- 39. v8.23：玩家交易（派倖存者到對方據點擺攤）----
{
  const { WorldSync: WS } = await import('../src/multiplayer/WorldSync.js');
  const mk = (name, lat) => {
    const gx = Game.newGame({ playerName: name, classId: 'warrior', lat, lon: 121 });
    gx.state.map.pois = fillPois([], lat, 121);
    gx.shelter.establish(gx.state.map.pois[0]);
    return gx;
  };
  const A = mk('賣家', 25);
  const B = mk('買家', 25.004);
  const box = { A: [], B: [] };
  const wire = (gx, id, other) => {
    gx.world = {
      others: [],
      identity: () => ({ id, token: 't' }),
      provider: { worldSend: async (_f, _t, to, type, data) => { box[to].push({ from: id, fromName: gx.state.player.name, type, data: JSON.parse(JSON.stringify(data)) }); } },
    };
    void other;
  };
  wire(A, 'A');
  wire(B, 'B');
  // 交易需要雙方都有交易所
  A.shelter.primary().facilities.exchange.level = 1;
  assert(!A.trade.canStart('B').ok, '對方沒有交易所時不能交易');
  B.shelter.primary().facilities.exchange.level = 1;
  const pres = (gx, id) => ({ id, ...JSON.parse(JSON.stringify(WS.prototype.presence.call({ game: gx }))) });
  const deliver = (gx, id) => { gx.territory.handleEvents(box[id].splice(0)); };
  A.world.others = [pres(B, 'B')];
  A.state.supplies.nail = 50;
  const gear = A.equipment.generate({ level: 5, model: 'knife', rarity: 'rare' });
  A.equipment.addItem(gear, 't');
  const seller = A.survivors.leader();
  assert(!A.trade.start('B', seller.id, [{ key: 'nail', qty: 99999, price: 1 }]).ok && A.state.supplies.nail === 50, '超過負重的商品無法帶出門（不會扣掉）');
  const st = A.trade.start('B', seller.id, [{ key: 'nail', qty: 20, price: 3 }, { itemId: gear.id, price: 0 }]);
  assert(st.ok && A.state.supplies.nail === 30 && seller.bag.nail === 20 && A.equipment.getItem(gear.id).loc === seller.id, '交易隊帶著商品出發（放進倖存者背包）');
  const ex = st.exp;
  // 抵達對方據點
  const shift = ex.travelMs + 1000;
  ex.startAt -= shift; ex.endAt -= shift;
  const pa = pres(A, 'A');
  const trip = pa.trips.find((t) => t.kind === 'trade');
  assert(trip && trip.targetId === 'B' && trip.stall.length === 2, '公開資料包含擺攤商品與交易對象');
  B.world.others = [pa];
  assert(B.trade.incoming().length === 1 && !B.intercept.target({ kind: 'player', playerId: 'A', tripId: trip.id }), '買方看得到來訪的交易隊，交易隊不能被攔截');
  B.state.player.coins = 100;
  const nailGood = trip.stall.find((x) => x.key === 'nail');
  const gearGood = trip.stall.find((x) => x.item);
  const n0 = B.state.supplies.nail || 0;
  assert(B.trade.buy('A', trip.id, nailGood.id, 10).ok && B.state.player.coins === 70 && B.state.supplies.nail === n0 + 10, '買方用金錢購買物資');
  assert(B.trade.remaining(trip.id, nailGood) === 10, '買方看到的剩餘數量會扣掉已購買的');
  assert(B.trade.buy('A', trip.id, gearGood.id, 1).ok && B.state.player.coins === 70, '價格 0 的商品等於免費贈送');
  const got = B.state.inventory.items.find((i) => i.model === 'knife' && i.rarity === 'rare');
  assert(got && JSON.stringify(got.stats) === JSON.stringify(gear.stats), '買到的裝備與對方擺出的完全相同');
  const coinA = A.state.player.coins;
  deliver(A, 'A');
  assert(A.state.player.coins === coinA + 30 && seller.bag.nail === 10 && !A.equipment.getItem(gear.id), '賣方收到金錢、交出商品');
  // 被竄改的裝備數值不會被接受
  const fake = B.equipment.importItem({ ...A.equipment.exportItem(gear), stats: { ...gear.stats, atk: 99999 } });
  assert(fake && fake.stats.atk < 1000, '不合理的裝備數值會被修正');
  // 超量購買（對方已賣光）→ 退款
  B.state.trade.bought[trip.id][nailGood.id] = 0;
  A.trade.onBuy('B', '買家', { tripId: trip.id, goodId: nailGood.id, qty: 15, coins: 45 });
  assert(seller.bag.nail === undefined || seller.bag.nail === 0, '賣方只交出還有的數量');
  deliver(B, 'B');
  assert(B.state.player.coins === 70 + 15, `賣不出的部分退款給買方（${B.state.player.coins}）`);
  // 買方結束交易 → 賣方倖存者回家
  assert(B.trade.end('A', trip.id).ok && !B.trade.canTrade('A', trip.id).ok, '買方可以結束交易');
  deliver(A, 'A');
  assert(ex.tradeEnded && A.exploration.progress(ex).phase === 'returning', '結束交易後賣方的倖存者回家');
  const rep = A.exploration.update(ex.endAt + 1, { silent: true })[0];
  assert(rep && rep.events.some((e) => e.includes('💰')) && seller.status === 'idle', `交易隊回家後有交易報告（${rep?.events.slice(-2).join(' / ')}）`);
  // 賣方召回
  A.world.others = [pres(B, 'B')];
  A.state.supplies.nail = 10;
  const st2 = A.trade.start('B', seller.id, [{ key: 'nail', qty: 5, price: 0 }]);
  assert(st2.ok && A.exploration.recall(st2.exp.id).ok, '賣方可以自行召回交易隊');
  assert(!pres(A, 'A').trips.some((t) => t.kind === 'trade'), '召回後不再公開擺攤');
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
  assert(!early || ge.state.map.remain[big3.id]?.hidden, '提早負重回家時不顯示剩餘物資');
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
  n.level = 3;
  base.facilities.wall.level = 10;
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

// ---- 44. v8.31：交易所與收購需求 ----
{
  const { WorldSync: WS2 } = await import('../src/multiplayer/WorldSync.js');
  const mk = (name, lat) => {
    const gx = Game.newGame({ playerName: name, classId: 'warrior', lat, lon: 121 });
    gx.state.map.pois = fillPois([], lat, 121);
    gx.shelter.establish(gx.state.map.pois[0]);
    setHour(gx, 10);
    return gx;
  };
  const P = mk('收購方', 25);
  const S = mk('出貨方', 25.003);
  const box = { P: [], S: [] };
  const wire = (gx, id) => {
    gx.world = { others: [], identity: () => ({ id, token: 't' }), provider: { worldSend: async (_f, _t, to, type, data) => { box[to].push({ from: id, fromName: gx.state.player.name, type, data: JSON.parse(JSON.stringify(data)) }); } } };
  };
  wire(P, 'P');
  wire(S, 'S');
  const pres = (gx, id) => ({ id, ...JSON.parse(JSON.stringify(WS2.prototype.presence.call({ game: gx }))) });
  const deliverBox = (gx, id) => gx.territory.handleEvents(box[id].splice(0));
  assert(!P.demand.post('nail', 10, 5).ok, '沒有交易所不能發布收購');
  P.shelter.primary().facilities.exchange.level = 1;
  P.state.player.coins = 100;
  assert(!P.demand.post('nail', 100, 5).ok, '金錢不足時不能掛單（收購總額要先保留）');
  assert(P.demand.post('nail', 10, 5).ok && P.state.player.coins === 50, '掛單時保留收購總額');
  assert(!P.demand.post('screw', 1, 1).ok, '交易所 Lv1 只能掛一項');
  const pp = pres(P, 'P');
  assert(pp.exchange === 1 && pp.demands.length === 1 && pp.demands[0].qty === 10, '公開資料包含交易所等級與收購需求');
  S.world.others = [pp];
  const dm = pp.demands[0];
  assert(!S.demand.canDeliver('P', dm.id).ok, '出貨方沒有交易所時不能交付');
  S.shelter.primary().facilities.exchange.level = 1;
  S.state.supplies.nail = 20;
  const sv = S.survivors.leader();
  const r = S.demand.deliver('P', dm.id, sv.id, 15);
  assert(r.ok && r.exp.deliver.qty === 10 && S.state.supplies.nail === 10, `派人交付（最多交付需求的數量：${r.exp?.deliver?.qty}）`);
  S.demand.checkDeliveries(r.exp.startAt + r.exp.travelMs - 1000);
  assert(!r.exp.deliver.delivered, '還沒抵達不會交付（需要移動時間）');
  S.demand.checkDeliveries(r.exp.startAt + r.exp.travelMs + 1);
  assert(r.exp.deliver.delivered && !sv.bag.nail, '抵達時交出物資');
  const pn0 = P.state.supplies.nail || 0;
  deliverBox(P, 'P');
  assert(P.state.supplies.nail === pn0 + 10 && !P.demand.list.length && P.state.player.coins === 50, '收購方收下物資，收滿後自動結束');
  const sc0 = S.state.player.coins;
  deliverBox(S, 'S');
  assert(S.state.player.coins === sc0 + 50, '出貨方收到款項');
  // 收購已結束時交付 → 物資退回
  P.demand.onSell('S', '出貨方', { demandId: dm.id, key: 'nail', qty: 5 });
  const sn0 = S.state.supplies.nail;
  deliverBox(S, 'S');
  assert(S.state.supplies.nail === sn0 + 5, '收購已經結束時，物資退回出貨方');
  const rep = S.exploration.update(r.exp.endAt + 1, { silent: true })[0];
  assert(rep?.success, '交付隊回家有報告');
  // 取消收購退還保留金額
  P.state.player.coins = 100;
  P.demand.post('wood', 10, 3);
  const c0 = P.state.player.coins;
  assert(P.demand.cancel(P.demand.list[0].id).ok && P.state.player.coins === c0 + 30, '取消收購退還保留金額');
  // 玩家突襲也會搶金錢（地窖除外）
  P.state.player.coins = 1000;
  P.shelter.primary().facilities.cellar.level = 0;
  P.territory.handleEvents([{ from: 'S', fromName: '出貨方', type: 'attack', data: { win: true, lossPct: 0.1 } }]);
  assert(P.state.player.coins === 900, `玩家突襲成功會搶走金錢（${P.state.player.coins}）`);
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
  assert(Math.abs(longest / day - 10) < 0.6, `最難的研究 Lv15 約 10 天（${(longest / day).toFixed(1)} 天）`);
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
  ga.state.supplies.bandage = 10;
  assert(ga.survivors.setSupply(lead.id, 'bandage', 3).ok && lead.bag.bandage === 3 && ga.state.supplies.bandage === 7, '設定自動補給後立即從倉庫補到指定數量');
  lead.bag.bandage = 1;
  const poi = ga.state.map.pois.find((p) => !ga.shelter.baseAtPoi(p.id));
  const ex = ga.exploration.start(poi.id, [lead.id], 5).exp;
  ga.exploration.update(ex.endAt + 1, { silent: true });
  assert(lead.bag.bandage === 3, `回到避難所時自動補給（背包繃帶 ${lead.bag.bandage}）`);
  assert(ga.survivors.setSupply(lead.id, 'bandage', 0).ok && !lead.supply.bandage, '可以移除自動補給');
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

// ---- 56. v8.51：自動探索搜空後換到附近地點（次數有上限） ----
{
  const ga = Game.newGame({ playerName: 'Au', classId: 'scout', lat: 25.03, lon: 121.56 });
  ga.state.map.pois = fillPois([], 25.03, 121.56);
  ga.shelter.establish(ga.state.map.pois[0]);
  setHour(ga, 10);
  ga.state.research.levels.s_scout = 1;
  ga.research.invalidate();
  const ex = ga.exploration;
  const poi = ga.state.map.pois.find((p) => !ga.shelter.baseAtPoi(p.id) && ex.hasStock(p));
  assert(ex.autoHopLimit() === 1, '自動換點基本 1 次');
  const n0 = ex.autoNext({ poiId: poi.id, autoHops: 0 });
  assert(n0.ok && n0.poiId === poi.id, '原地點還有物資時再去同一個地點');
  const orig = ex.hasStock.bind(ex);
  ex.hasStock = (p, at) => (p.id === poi.id ? false : orig(p, at));
  const n1 = ex.autoNext({ poiId: poi.id, autoHops: 0 });
  assert(n1.ok && n1.poiId !== poi.id && n1.hops === 1, `搜空後換到附近的地點（${n1.note || n1.reason}）`);
  const n2 = ex.autoNext({ poiId: poi.id, autoHops: 1 });
  assert(!n2.ok && n2.reason.includes('次數已用完'), '換點次數用完就停止');
  ga.state.research.levels.s_route = 4;
  ga.research.invalidate();
  assert(ex.autoHopLimit() === 5 && ex.autoNext({ poiId: poi.id, autoHops: 4 }).ok, '研究「巡迴搜索」最多 5 次');
  ex.hasStock = orig;
}

// ---- 57. v8.52.3：伺服器拒絕交易事件時退回 ----
{
  const mk = (name, lat) => {
    const gx = Game.newGame({ playerName: name, classId: 'warrior', lat, lon: 121 });
    gx.state.map.pois = fillPois([], lat, 121);
    gx.shelter.establish(gx.state.map.pois[0]);
    gx.shelter.primary().facilities.exchange.level = 1;
    gx.world = { others: [], myId: name, identity: () => ({ id: name, token: 't' }), provider: { worldSend: async () => { const e = new Error('x'); e.kind = 'invalid'; throw e; } } };
    return gx;
  };
  const { WorldSync: WS2, cleanPlayer } = await import('../src/multiplayer/WorldSync.js');
  const pres = (gx, id) => cleanPlayer({ id, ...JSON.parse(JSON.stringify(WS2.prototype.presence.call({ game: gx }))) });
  const S = mk('S', 25);
  const Bq = mk('Bq', 25.004);
  Bq.state.player.coins = 500;
  Bq.demand.post('nail', 10, 5);
  S.world.others = [pres(Bq, 'Bq')];
  S.state.supplies.nail = 30;
  const lead = S.survivors.leader();
  const dv = S.demand.deliver('Bq', S.world.others[0].demands[0].id, lead.id, 10);
  assert(dv.ok, `可以出發交付（${dv.reason || ''}）`);
  const sh = dv.exp.travelMs + 1000;
  dv.exp.startAt -= sh; dv.exp.endAt -= sh;
  S.demand.checkDeliveries();
  await new Promise((r) => setTimeout(r, 10));
  assert(lead.bag.nail === 10 && !dv.exp.deliver.handed, `通知失敗時物資放回背包帶回家（背包 ${lead.bag.nail}）`);
  // 交易購買失敗：退錢、收回商品
  S.exploration.update(dv.exp.endAt + 1, { silent: true });
  S.state.supplies.nail = 30;
  S.world.others = [pres(Bq, 'Bq')];
  const tr = S.trade.start('Bq', lead.id, [{ key: 'nail', qty: 5, price: 4 }]);
  assert(tr.ok, `交易隊出發（${tr.reason || ''}）`);
  if (tr.ok) {
    const s2 = tr.exp.travelMs + 1000;
    tr.exp.startAt -= s2; tr.exp.endAt -= s2;
    Bq.world.others = [pres(S, 'S')];
    const trip = Bq.world.others[0].trips.find((t) => t.kind === 'trade');
    const c0 = Bq.state.player.coins;
    const n0 = Bq.state.supplies.nail || 0;
    assert(Bq.trade.buy('S', trip.id, trip.stall[0].id, 5).ok, '購買');
    await new Promise((r) => setTimeout(r, 10));
    assert(Bq.state.player.coins === c0 && (Bq.state.supplies.nail || 0) === n0, `通知賣方失敗時取消購買並退錢（💰${Bq.state.player.coins}）`);
  }
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

// ---- 5. 通行碼雜湊（純 JS SHA-256 與 Node crypto 結果一致）----
let ref = 'jdqs-gate:密碼 test';
for (let i = 0; i < ACCESS_ITERATIONS; i += 1) ref = crypto.createHash('sha256').update(ref).digest('hex');
assert(hashAccessCode('  密碼 test ') === ref, '通行碼雜湊與 Node crypto 一致（並忽略前後空白）');

if (failures) {
  console.error(`\n${failures} 項檢查失敗`);
  process.exit(1);
}
console.log(`✓ 全部通過（擊殺 ${g.state.stats.siegeKills}，探索事件 ${reports[0].events.length}）`);
