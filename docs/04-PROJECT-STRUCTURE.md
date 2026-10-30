# 第四階段：專案資料夾結構

```
Battlegrounds/
├── index.html                      # 入口 HTML：HUD / 舞台 / 導覽 / 彈窗容器
├── package.json                    # 相依套件與指令（dev / build / preview / check）
├── vite.config.js                  # Vite 設定（相對 base、手動切分 phaser/leaflet chunk）
├── .gitignore
├── README.md
│
├── public/
│   └── favicon.svg                 # 網站圖示
│
├── scripts/
│   └── check-data.js               # 設定檔參照檢查 + 無頭邏輯模擬（npm run check）
│
├── docs/
│   ├── 01-GDD.md                   # 第一階段：遊戲設計書
│   ├── 02-ARCHITECTURE.md          # 第二階段：系統架構圖
│   ├── 03-DATA-SCHEMA.md           # 第三階段：資料結構
│   ├── save-example.json           #   └ 實際存檔範例
│   ├── 04-PROJECT-STRUCTURE.md     # 第四階段：本文件
│   └── 05-DEPLOYMENT.md            # 第六階段：安裝與部署
│
└── src/
    ├── main.js                     # 進入點：讀檔/新遊戲 → 掃描地圖 → 啟動 Phaser + UI
    │
    ├── config/                     # 【資料層】所有平衡數值與靜態內容（純資料）
    │   ├── constants.js            #   全域常數、資源定義、初始值
    │   ├── timePhases.js           #   日夜時段與修正值
    │   ├── facilities.js           #   避難所設施（費用/效果公式）
    │   ├── defenses.js             #   防禦建築
    │   ├── poiTypes.js             #   地圖建築類型、資源表、敵人表
    │   ├── enemies.js              #   殭屍與 Boss
    │   ├── equipment.js            #   品質、裝備類型、詞綴
    │   ├── survivors.js            #   職業、技能、工作
    │   ├── research.js             #   研究樹
    │   └── quests.js               #   主線、每日、成就
    │
    ├── core/                       # 【核心層】
    │   ├── Game.js                 #   Facade：組合系統、主迴圈、離線結算、存檔排程
    │   ├── GameState.js            #   存檔結構工廠（Single Source of Truth）
    │   ├── SaveManager.js          #   LocalStorage、版本遷移、匯出/匯入
    │   └── EventBus.js             #   發佈/訂閱 + 事件常數
    │
    ├── systems/                    # 【領域邏輯】不依賴 DOM / Phaser，可在 Node 執行
    │   ├── TimeSystem.js           #   日夜
    │   ├── ResourceSystem.js       #   放置收益
    │   ├── ShelterSystem.js        #   避難所、施工、防禦建築
    │   ├── SurvivorSystem.js       #   倖存者屬性、經驗、招募、受傷
    │   ├── EquipmentSystem.js      #   裝備生成、詞綴、製作
    │   ├── CombatSystem.js         #   自動戰鬥
    │   ├── ExplorationSystem.js    #   探索與事件
    │   ├── ZombieSpawnSystem.js    #   地圖殭屍生成
    │   ├── SiegeSystem.js          #   屍潮防守模擬
    │   ├── ResearchSystem.js       #   研究
    │   ├── QuestSystem.js          #   任務與成就
    │   └── costUtils.js            #   成本/獎勵共用函式
    │
    ├── map/                        # 【真實地圖】
    │   ├── OverpassService.js      #   OSM Overpass 查詢與標籤分類
    │   ├── PoiGenerator.js         #   程序補足地點
    │   └── MapService.js           #   Leaflet 地圖與圖層
    │
    ├── scenes/                     # 【Phaser 場景】
    │   ├── BootScene.js            #   程式生成貼圖
    │   └── ShelterScene.js         #   避難所俯視圖、殭屍、特效、日夜濾鏡
    │
    ├── ui/                         # 【DOM UI】
    │   ├── UIManager.js            #   版面、HUD、導覽、分頁
    │   ├── SetupScreen.js          #   首次進入：名字/職業/座標
    │   ├── Modal.js                #   彈窗（支援 live 自動重繪）
    │   ├── Toast.js                #   通知
    │   ├── TeamPicker.js           #   隊伍選擇（探索/戰鬥共用）
    │   ├── BattleView.js           #   戰鬥紀錄播放
    │   ├── components.js           #   共用 HTML 片段
    │   └── panels/
    │       ├── MapPanel.js         #   地圖分頁 + POI/殭屍彈窗
    │       ├── ShelterPanel.js     #   避難所抽屜 + 防禦槽位彈窗
    │       ├── ExplorePanel.js     #   探索管理與報告
    │       ├── SurvivorPanel.js    #   倖存者、裝備、工作
    │       ├── InventoryPanel.js   #   背包與製作
    │       ├── ResearchPanel.js    #   研究樹
    │       ├── QuestPanel.js       #   任務
    │       └── SettingsPanel.js    #   存檔管理與統計
    │
    ├── utils/
    │   ├── math.js                 #   亂數、權重、格式化、地理距離
    │   └── dom.js                  #   DOM 輔助、HTML 跳脫、事件委派
    │
    └── styles/
        └── main.css                #   全域樣式（行動優先 + 桌機斷點 900px）
```

## 程式規範
- **ES Modules**，一檔一類別／一主題；類別 `PascalCase`、函式與變數 `camelCase`、常數 `UPPER_SNAKE_CASE`。
- 依賴方向只能「由上往下」：`ui / scenes → core → systems → config / utils`。`systems` 不可 import `ui`。
- 外部字串（OSM 名稱、玩家名稱）輸出成 HTML 前一律經過 `escapeHtml()`。
- 玩家動作一律回傳 `{ ok, msg?, reason? }`。
- 新增數值優先放 `config/`，避免魔術數字散落在系統中。
- 提交前執行 `npm run check` 與 `npm run build`。
