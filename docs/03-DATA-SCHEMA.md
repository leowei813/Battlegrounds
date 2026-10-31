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
{ "food": 200, "wood": 150, "fuel": 40 }
```
v12 起金屬、布料、藥品不再是基本資源，改為 `supplies` 內的材料物品（見文末 v12）。

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
  "rarity": "common",           // poor|common|uncommon|rare|epic|legendary（升級成長倍率）
  "hp": 150,                    // 目前生命，null = 滿血
  "severe": false,              // 重傷：無法行動，生命回到 30% 解除
  "zeroSince": 0,               // 重傷且飢餓的起始時間（滿遊戲內 3 天死亡）
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

## v5 新增欄位（v2.0.0）
| 位置 | 欄位 | 說明 |
|---|---|---|
| `recruitOffer` | `Survivor[] \| null` | 廣播招募的 3 位候選人，選擇或放棄後清空 |
| `starving` | `boolean` | 目前是否飢餓 |
| `bases[].size` | `small\|medium\|large\|huge` | 據點規模，決定防禦欄位數（4／6／9／12） |
| `map.pois[].lootedDay` | `number` | 最後被搜刮的日期編號（當地日期），與今天相同代表已清空 |
| `player.worldId` / `worldSecret` | `string` | 多人互動的公開身分（只上傳雜湊後的 token） |

舊存檔遷移（v4 → v5）：補上品級（一般）、生命、重傷欄位，依建築類型決定據點規模並保留已建造的防禦，舊的建築枯竭度忽略。

## v6 新增欄位（v4.0.0）
| 位置 | 欄位 | 說明 |
|---|---|---|
| `bases[].kind` | `shelter\|outpost` | 避難所只有一座（`primaryBaseId` 指向它），其餘為前哨站 |
| `vehicles[]` | `{ id, type, durability, status: idle\|out }` | 車庫 |
| `expeditions[]` | `kind`, `vehicleIds`, `cargo`, `ambushes` | `kind=raid` 為攻打 NPC 據點（`poiId` 為 NPC id） |
| `npcs` | `{ list: Npc[], nextSpawnAt }` | NPC 據點：`{ id, name, poiId, lat, lon, level, resources, coins, nextLevelAt, nextExploreAt, nextRaidAt, trip }` |

舊存檔遷移（v5 → v6）：原主要據點變成避難所，其他據點轉為前哨站（保留，但超過上限時不能再新建）。區域危險度由座標計算，不存檔。

## v7 新增欄位（v5.0.0）
| 位置 | 欄位 | 說明 |
|---|---|---|
| `research` | `{ levels: { 科技ID: 等級 }, active: { id, level, startAt, endAt } }` | 研究改為等級制（取代 `completed`） |
| `inventory.items[]` | `model`, `cat`, `tier` | 具體型號、類別、強度 T1～10 |
| `inventory.blueprints[]` | `model` | 設計圖對應的型號 |
| `recruitBoard` | `{ list: Survivor[], refreshAt }` | 每小時固定出現的倖存者 |
| `survivors[].job` | 新增 `repair` | 修繕圍牆 |

舊存檔遷移（v6 → v7）：已完成的研究轉換為新科技等級；舊裝備依名稱對應型號（找不到則用該類最低型號）。

## v8 新增欄位（v6.0.0）
| 位置 | 欄位 | 說明 |
|---|---|---|
| `rng` | `{ craft, recruit, explore, battle, npc }` | 隨機結果的種子，隨存檔保存（重新讀檔結果相同） |
| `survivors[].bag` | `{ 資源: 數量 }` | 個人背包攜帶的資源 |
| `bases[].quietUntil` | `number` | 防線被突破後，到天亮前不再有屍潮 |
| `npcs.cellNext` | `{ 格子: 時間 }` | 各 1 公里格子 NPC 重生時間；NPC 新增 `cell` |
| 雲端主存檔 `map` | `poisExternal`, `looted` | 建築清單另存（`id = sha256("jdqs-map:" + 帳號 id)`），主存檔只記錄今日搜刮紀錄 |

## v10 新增欄位（v7.0.0）
| 位置 | 欄位 | 說明 |
|---|---|---|
| `relations` | `{ players: { 玩家ID: { status: hostile\|friend, name } }, requestsIn, requestsOut }` | 外交關係與友好請求 |
| `expeditions[]` | `path`, `threats`, `avoidHostile`, `kind: pvp` | 繞路折線、會經過的敵對警戒範圍、突襲玩家 |
| `npcs.list[].trip` | `path`, `crossings` | NPC 路線與會穿過的玩家警戒範圍 |
| `inventory.items[].loc` | `store` 或倖存者 ID | 物品放在倉庫或某位隊員的背包 |
| 公開資料 `bases[]` | `alert`, `guards`, `guardLevel` | 警戒範圍、駐守人數與等級 |

## v11 新增欄位（v7.2.0）
| 位置 | 欄位 | 說明 |
|---|---|---|
| `bases[].facilities.itemStore` | `{ level }` | 物品倉庫（舊存檔沿用原倉庫等級） |
| `map.detected` | `{ 建築ID: 日期編號 }` | GPS 今日偵測過的建築 |
| `settings.gps` | `boolean` | 是否開啟 GPS 偵測 |

## v12 新增欄位（v8.0.0）
| 位置 | 欄位 | 說明 |
|---|---|---|
| `supplies` | `{ 材料ID: 數量 }` | 物品倉庫內的材料物品：零件（38 種）、布料（10 種）、藥品（8 種）、彈藥（6 種），定義在 `src/config/supplies.js`；同種類每 999 個佔 1 格 |
| `survivors[].bag` | `{ 資源或材料ID: 數量 }` | 背包也可放材料物品，負重依各材料的重量計算 |
| `map.markers` | `[{ id, type, name, lat, lon, osm, at }]` | 標記的建築（最多 5 個），重新掃描後仍保留在建築清單 |
| `map.remain` | `{ 建築ID: { day, res } }` | 探索帶不走而殘留在建築內的物資（當天有效） |
| `expeditions[]` | `kind: intercept`, `icptTarget`, `icptDone`, `icptResult`, `defeated`, `defeatLoss` | 攔截野外隊伍；被攔截擊敗後折返的隊伍 |
| `npcs.list[].trip` | `kind: return`, `hidden` | 被攔截後撤回據點的 NPC 隊伍（不顯示在地圖上） |
| `quests.chestDate` | 日期字串 | 今天是否已開啟每日物資箱 |
| `stats` | `healed`, `ammoCrafted`, `intercepts`, `chestsOpened`, `forestVisits` | 新任務與成就使用的統計 |
| `prodAcc`, `repairAcc` | `{ 材料ID: 小數 }` | 生產與修繕的材料小數累積（滿 1 個才增減） |
| 公開資料 `trips[]` | `id`, `level`, `defeated` | 讓其他玩家可以點選並攔截隊伍；`defeated` 為被擊敗撤回中（不能攔截、不顯示時間） |
| 事件信箱 | `intercept`, `plunder` | 攔截結果與戰利品（需重新執行 `supabase/schema.sql`） |

**v11 → v12 遷移**：`resources.metal / cloth / medicine`（含隊員背包、NPC 資源）依比例換算成螺絲、釘子、廢鐵、螺栓、電線、鐵板、粗布、棉布、麻布、繃帶、紗布；主線任務進度依任務 ID 換算到新的位置。

## v13（v8.5.0）
遊戲一天由現實 30 分鐘改為 1 小時（`DAY_REAL_MS`）。遷移時把 `createdAt` 往前調整為「現在 − 已經過時間 × 2」，讓舊存檔目前的天數與時刻維持不變。

## 新增欄位（v8.7.0，不需遷移）
| 位置 | 欄位 | 說明 |
|---|---|---|
| `defenseLog` | `[{ at, baseName, attacker, success, lost, coins, damaged, injured, kills, waves, wallLost, note }]` | 據點遭襲紀錄（最多 30 筆） |
| `trader` | `{ day, active, lat, lon, until, stock: [{ id, kind: supply\|gear, key?, qty?, item?, price }] }` | 今天的流浪商人 |
| `rng.trader` | 數字 | 流浪商人的隨機種子 |
