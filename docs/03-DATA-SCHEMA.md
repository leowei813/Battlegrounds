# 第三階段：資料庫結構（JSON）

遊戲以 **LocalStorage** 作為資料庫，key 為 `jdqs_save_v1`，值為下列結構的 JSON 字串。
完整範例見 [`save-example.json`](./save-example.json)（由實際遊戲狀態產生）。

> 所有時間欄位皆為 **Unix 毫秒時間戳**（`Date.now()`）。資源數量以浮點數保存，顯示時取整。

## 1. 根結構

```jsonc
{
  "version": 3,               // 存檔版本，SaveManager.migrate() 依此升級
  "createdAt": 0,             // 建檔時間（同時是遊戲時鐘的基準）
  "lastSaveAt": 0,            // 最後存檔時間
  "lastTickAt": 0,            // 最後一次邏輯更新時間（離線結算依據）
  "player":       { /* §2 */ },
  "map":          { /* §3 地圖進度 */ },
  "bases":        [ /* §4 據點（建築資料） */ ],
  "primaryBaseId": "base_xxx",  // ⭐ 主要據點
  "resources":    { /* §5 */ },
  "inventory":    { /* §6 裝備資料 */ },
  "survivors":    [ /* §7 倖存者資料 */ ],
  "recruitPool":  [ /* §7 等待加入者（同倖存者結構） */ ],
  "expeditions":  [ /* §8 探索隊伍 */ ],
  "reports":      [ /* §8 探索報告（最多 20 筆） */ ],
  "research":     { /* §9 */ },
  "quests":       { /* §10 */ },
  "stats":        { /* §11 */ },
  "settings":     { "autoSave": true, "showDamage": true },
  "log":          [ { "t": 0, "msg": "string", "type": "info|success|danger|loot|legendary" } ]  // 最多 80 筆
}
```

## 2. player — 玩家資料
| 欄位 | 型別 | 說明 |
|---|---|---|
| `name` | string | 玩家名稱（≤16 字） |
| `coins` | number | 💰 金錢 |
| `parts` | number | ⚙️ 稀有材料 |

## 3. map — 地圖進度
```jsonc
{
  "center": { "lat": 25.0339, "lon": 121.5645 },   // 掃描中心
  "source": "overpass | generated | none",           // 建築資料來源
  "fetchedAt": 0,
  "pois": [{
    "id": "osm_w123456",        // osm_{n|w|r}{osmId}，或 gen_{type}_{i}_{rand}
    "type": "shop",             // residential|shop|hospital|school|factory|gasStation|police|military|warehouse
    "name": "全聯福利中心",
    "lat": 25.0341, "lon": 121.5651,
    "osm": true,                // false = 程序生成
    "depletion": 0.08,          // 物資枯竭度 0~0.6（選填）
    "lastVisit": 0              // 最後探索時間（選填）
  }],
  "zombieGroups": [{
    "id": "zg_xxx", "poiId": "osm_w123456",
    "lat": 25.0343, "lon": 121.5649,
    "enemyId": "walker",        // 對應 config/enemies.js
    "count": 3, "level": 2,
    "elite": false, "boss": false,
    "spawnedAt": 0
  }],
  "lastZombieRefresh": 0
}
```

> **v3 儲存格式**：上面是載入後的記憶體結構。寫入 LocalStorage、匯出字串與雲端時，`map.pois` 會改存為精簡的 `map.poiPack`：
> ```jsonc
> "poiPack": {
>   "types": ["residential", "shop", "hospital", ...],      // 類型對照表
>   "rows": [["osm_w123456", 1, "全聯福利中心", 25.0341, 121.5651, 1, 0.08, 0]]
>   //        id,           類型索引, 名稱,   緯度,     經度,  OSM, 枯竭度, 最後探索時間
> }
> ```
> 由 `SaveManager.pack()` 產生、`SaveManager.migrate()` 還原。

## 4. bases — 據點（建築資料）
最多 5 個；`primaryBaseId` 指向主要據點。每個據點各自擁有設施、防禦建築、圍牆與施工佇列。
```jsonc
[{
  "id": "base_xxx",
  "poiId": "osm_w123456",       // 據點所在的地圖建築
  "name": "全聯福利中心", "lat": 25.0341, "lon": 121.5651,
  "createdAt": 0,
  "facilities": {               // key 對應 config/facilities.js
    "wall": { "level": 1 }, "warehouse": { "level": 1 }, "watchtower": { "level": 0 },
    "farm": { "level": 1 }, "generator": { "level": 0 }, "rainCollector": { "level": 0 },
    "workbench": { "level": 1 }, "researchCenter": { "level": 0 }
  },
  "defenses": [                 // 固定 8 個槽位
    { "slot": 0, "type": "barricade", "level": 1, "garrisonId": null },
    { "slot": 1, "type": null, "level": 0, "garrisonId": null }
  ],
  "wallHp": 790.0,              // null = 滿血
  "buildQueue": [{              // 每個據點最多 2 筆
    "kind": "facility | defense",
    "id": "farm",               // 設施 ID 或防禦類型
    "slot": 0,                  // 僅 defense
    "targetLevel": 2,
    "startAt": 0, "endAt": 0
  }]
}]
```

> **文明度不存檔**：由 bases、領袖等級與已裝備裝備即時計算（`CivilizationSystem`），統計 `stats.peakCivilization` 記錄歷史最高值。
> **v1 → v2 遷移**：舊版單一 `shelter` 物件會被轉成 `bases[0]` 並設為主要據點。

## 5. resources — 資源
```json
{ "food": 200, "wood": 150, "metal": 80, "cloth": 60, "fuel": 40, "medicine": 15 }
```

## 6. inventory — 裝備資料
```jsonc
{
  "items": [{
    "id": "it_xxx",
    "type": "rifle",            // pistol|rifle|shotgun|sniper|helmet|armor|legs|backpack
    "slot": "weapon",           // weapon|helmet|armor|legs|backpack
    "rarity": "rare",           // common|uncommon|rare|epic|legendary
    "level": 5,
    "name": "精良的M4A1",
    "stats": { "atk": 37, "atkSpeed": 0.15, "crit": 0.06 },   // 基礎屬性
    "affixes": [ { "id": "critDmg", "value": 0.168 }, { "id": "hpFlat", "value": 49 } ],  // 隨機詞綴
    "power": 214,               // 戰力評分（排序用）
    "locked": false
  }],
  "blueprints": [ { "id": "bp_xxx", "itemType": "sniper", "rarity": "rare" } ]
}
```

## 7. survivors — 倖存者資料
```jsonc
{
  "id": "leader",               // 領袖固定為 "leader"，其他為 sv_xxx
  "name": "阿傑",
  "classId": "warrior",         // warrior|medic|engineer|farmer|scout
  "level": 1, "xp": 0,
  "isLeader": true,
  "status": "idle | exploring",
  "job": "idle | scavenge | farm | workshop | clinic | guard",
  "injuredUntil": 0,            // > now 代表受傷中
  "equipment": { "weapon": "it_xxx", "helmet": null, "armor": null, "legs": null, "backpack": null }
}
```

## 8. expeditions / reports — 探索隊伍
```jsonc
// expeditions[]
{
  "id": "ex_xxx", "poiId": "gen_residential_1_xxx",
  "memberIds": ["sv_xxx"],
  "durationMin": 15,            // 玩家選擇的時長 5|15|30|60
  "auto": false,                // 自動探索
  "startAt": 0, "endAt": 0,     // 實際時間（含路程與加成）
  "phaseAtStart": "day"
}
// reports[]
{
  "id": "rp_xxx", "poiName": "燒毀的醫院", "poiType": "hospital", "at": 0,
  "events": ["🔍 搜刮到 藥品、布料"],
  "resources": { "medicine": 18, "cloth": 9 },
  "items": [ /* 裝備物件 */ ], "blueprints": [],
  "kills": 0, "xp": 0, "success": true, "members": ["阿傑"]
}
```

## 9. research
```jsonc
{
  "completed": ["srv1"],                                   // 已完成研究 ID
  "active": { "id": "def1", "startAt": 0, "endAt": 0 }     // 或 null
}
```

## 10. quests
```jsonc
{
  "mainIndex": 0,                         // 目前主線索引（MAIN_QUESTS）
  "dailyDate": "2026-10-30",              // 每日任務日期（本地時區）
  "dailies": [ { "id": "d_kill", "baseline": { /* 當日 stats 快照 */ }, "claimed": false } ],
  "achievements": { "a_kill100": 1793343169172 }   // 已領取的成就與時間
}
```

## 11. stats — 統計（任務/成就依據）
| key | 說明 | key | 說明 |
|---|---|---|---|
| `kills` | 總擊殺 | `siegeKills` | 防線擊殺 |
| `bossKills` | Boss 擊殺 | `eliteKills` | 精英擊殺 |
| `explorations` | 探索次數 | `battlesWon` / `battlesLost` | 地圖戰鬥勝/敗 |
| `itemsFound` | 獲得裝備 | `rareItems` / `legendaryItems` | 稀有以上 / 傳說 |
| `crafted` | 製作次數 | `upgrades` | 建築升級 |
| `recruits` | 招募人數 | `researchDone` | 完成研究 |
| `breaches` | 防線失守 | `daysSurvived` | 存活天數 |
| `foodCollected` | 累計產出食物 | `peakCivilization` | 歷史最高文明度 |

## 12. 靜態設定資料（config/，不存檔）

| 檔案 | 內容 | 主鍵 |
|---|---|---|
| `constants.js` | 全域常數、資源定義、初始值 | — |
| `civilization.js` | 文明度權重、階段、屍潮係數、主要據點危險度係數、據點上限與費用 | — |
| `timePhases.js` | 日夜時段修正 | `day/dusk/night/midnight` |
| `facilities.js` | 設施費用、效果公式 | `wall/warehouse/...` |
| `defenses.js` | 防禦建築數值 | `barricade/trap/machineGun/flameTower/emTower/watchPost` |
| `poiTypes.js` | 地點類型、資源表、敵人表 | `residential/...` |
| `enemies.js` | 敵人與 Boss | `walker/infected/berserker/mutant/nightStalker/tankBoss/...` |
| `equipment.js` | 品質、裝備類型、詞綴 | `common.../pistol.../atkFlat...` |
| `survivors.js` | 職業、技能、工作、命名 | `warrior/medic/engineer/farmer/scout` |
| `research.js` | 研究樹 | `wpn1..4/def1..4/med1..4/agr1..4/srv1..4` |
| `quests.js` | 主線、每日、成就 | `m1../d_*/a_*` |

## 13. 版本遷移策略
1. 變更 state 結構時將 `SAVE_VERSION` +1。
2. 在 `SaveManager.migrate(data)` 中以 `if (v < N) { ... }` 逐版升級。
3. 新增的統計欄位會由 `STAT_KEYS` 自動補 0，無需手寫遷移。
