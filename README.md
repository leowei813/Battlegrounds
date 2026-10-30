# ☣️ 絕地求生 — 真實地圖殭屍放置生存 RPG

在**你所在城市的真實街道**上建立避難所，派遣倖存者搜刮醫院、警局、加油站，研究科技、打造裝備、架設防禦塔，在日夜循環的屍潮中活下去。離線最多累積 24 小時收益。

**技術**：Vite · Phaser 3 · JavaScript (ES Modules) · Leaflet + OpenStreetMap / Overpass API · LocalStorage · 響應式（桌機與手機）

目前版本：**v1.9.0**（各版本改動見 [CHANGELOG.md](CHANGELOG.md)）

## 快速開始

```bash
npm install
```

```bash
npm run dev
```

開啟 <http://localhost:5173>，輸入名字、選擇職業與位置即可開始。

## 文件
| 階段 | 文件 |
|---|---|
| 一、遊戲設計書（GDD） | [docs/01-GDD.md](docs/01-GDD.md) |
| 二、系統架構圖 | [docs/02-ARCHITECTURE.md](docs/02-ARCHITECTURE.md) |
| 三、資料庫結構（JSON） | [docs/03-DATA-SCHEMA.md](docs/03-DATA-SCHEMA.md)・[範例存檔](docs/save-example.json) |
| 四、專案資料夾結構 | [docs/04-PROJECT-STRUCTURE.md](docs/04-PROJECT-STRUCTURE.md) |
| 五、程式碼 | [`src/`](src) |
| 六、安裝與部署 | [docs/05-DEPLOYMENT.md](docs/05-DEPLOYMENT.md) |
| 雲端存檔 | [docs/06-CLOUD-SAVE.md](docs/06-CLOUD-SAVE.md) |
| 更新日誌 | [CHANGELOG.md](CHANGELOG.md) |

## 功能一覽
- 🗺️ **真實地圖**：定位或手動座標，OSM 建築自動分類為 9 種地點（住宅、商店、醫院、學校、工廠、加油站、警局、軍事基地、倉庫）
- 🏠 **多據點**：最多 5 個據點，各有 8 種可升級設施（圍牆、倉庫、監視塔、農場、發電機、雨水收集器、工作台、研究中心）與防線，可指定主要據點
- 🏛️ **文明度**：建築、玩家等級、裝備提升文明度；屍潮強度隨文明度（而非天數）成長，主要據點危險度依文明度 × 係數提升
- ⏳ **放置收益**：6 種資源，離線最多 24 小時
- 🧭 **探索**：5~60 分鐘，物資／倖存者／殭屍／特殊事件／精英怪，可自動探索
- 🎒 **裝備**：5 種品質、8 種類型、10 種隨機詞綴、設計圖製作
- ⚔️ **自動戰鬥**：HP／攻擊／防禦／暴擊／閃避／攻速，職業技能
- 🧟 **殭屍生成**：依區域危險度與日夜刷新，特殊區域有 Boss
- 🛡️ **防禦建築**：路障、陷阱、機槍塔、火焰塔、電磁塔、可駐守的瞭望塔，Phaser 即時屍潮防守
- 👥 **倖存者**：戰士、醫生、工程師、農夫、偵察兵，技能與等級
- 🌗 **日夜系統**：現實 30 分鐘 = 遊戲 1 天（白天／黃昏／夜晚／午夜）
- 🔬 **研究**：5 分支 20 項，解鎖新建築、新裝備、新功能
- 📜 **任務**：15 章主線、每日任務、17 項成就
- 💾 **存檔**：LocalStorage 自動存檔、版本遷移、匯出／匯入
- ☁️ **雲端存檔**：同步碼跨裝置接續，開啟即讀取最新進度，多裝置即時鎖定防覆蓋（內建伺服器或 Supabase）

## 指令
| 指令 | 說明 |
|---|---|
| `npm run dev` | 開發伺服器 |
| `npm run build` | 建置到 `dist/` |
| `npm run preview` | 預覽建置結果 |
| `npm run check` | 資料檢查與無頭邏輯模擬 |
| `npm run server` | 雲端存檔伺服器（同時提供 `dist/`） |
| `npm run start` | 建置並啟動伺服器（一鍵正式環境） |
| `npm run test:cloud` | 雲端存檔整合測試 |

## 版權
© 2026 leowei813 版權所有。本專案原始碼公開供瀏覽，但**未授予任何授權**；未經書面同意，禁止複製、修改、散布或商業使用。詳見 [LICENSE](LICENSE)。

地圖資料 © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors。
