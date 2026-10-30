# 第六階段：安裝與部署教學

## 1. 環境需求
| 項目 | 版本 |
|---|---|
| Node.js | 18 以上（建議 20 LTS / 22） |
| npm | 9 以上 |
| 瀏覽器 | Chrome / Edge / Safari / Firefox 近兩年版本（需支援 ES2020、LocalStorage） |

## 2. 本機開發

```bash
git clone https://github.com/leowei813/Battlegrounds.git
```

```bash
cd Battlegrounds
```

```bash
npm install
```

```bash
npm run dev
```

開啟終端機顯示的網址（預設 <http://localhost:5173>）。`vite.config.js` 已設定 `host: true`，同一個 Wi-Fi 下的手機可用 `http://<電腦區網IP>:5173` 連線測試。

> **手機定位注意**：瀏覽器只允許在 **HTTPS 或 localhost** 使用 Geolocation。用區網 IP 在手機測試時定位會被拒絕，可改用手動座標／預設城市，或使用下方任一 HTTPS 部署方式。

### 常用指令
| 指令 | 說明 |
|---|---|
| `npm run dev` | 開發伺服器（熱更新） |
| `npm run build` | 產生正式版到 `dist/` |
| `npm run preview` | 本機預覽 `dist/` |
| `npm run check` | 設定資料檢查 + 無頭邏輯模擬（CI 可用） |
| `npm run server` | 雲端存檔伺服器，並提供 `dist/`（見 [06-CLOUD-SAVE.md](06-CLOUD-SAVE.md)） |
| `npm run start` | 建置後啟動伺服器 |

## 3. 正式建置

```bash
npm run build
```

`dist/` 為純靜態檔案（HTML/JS/CSS），可放在任何靜態主機。`base: './'` 讓它可以部署在子路徑（例如 GitHub Pages 的 `/Battlegrounds/`）。

## 4. 部署方式

### A. GitHub Pages（GitHub Actions）
專案已內建 [`.github/workflows/deploy-pages.yml`](../.github/workflows/deploy-pages.yml)：每次推送到 `main`（或在 Actions 頁手動執行），會依序跑資料檢查、雲端存檔測試、建置，然後發佈。

首次設定：
1. repo **Settings → Pages → Build and deployment → Source** 選 **GitHub Actions**。
2. 到 **Actions** 頁重新執行「部署到 GitHub Pages」（或推送任一 commit 到 `main`）。
3. 網址為 `https://<帳號>.github.io/<repo>/`。

> **私有 repo**：GitHub 免費方案只能為**公開** repo 開啟 Pages；私有 repo 需要 GitHub Pro / Team / Enterprise。另外，除了 Enterprise 之外，私有 repo 發佈的 Pages 網站本身仍是**公開**的。

**雲端存檔**：Pages 只有靜態檔，預設建置時會關閉雲端存檔（`VITE_CLOUD_PROVIDER=none`）。要啟用時，請到 **Settings → Secrets and variables → Actions → Variables** 新增：

| 變數 | 值 |
|---|---|
| `VITE_CLOUD_PROVIDER` | `selfhost` 或 `supabase` |
| `VITE_CLOUD_URL` | 自架 `server/` 的 HTTPS 網址（selfhost） |
| `VITE_SUPABASE_URL`、`VITE_SUPABASE_ANON_KEY` | Supabase 專案設定（supabase） |

自架伺服器時，伺服器的 `CORS_ORIGIN` 請設為 `https://<帳號>.github.io`。

### B. Vercel / Netlify / Cloudflare Pages
| 設定 | 值 |
|---|---|
| Build command | `npm run build` |
| Output directory | `dist` |
| Node version | 20 |

### C. 自架 Nginx

```nginx
server {
  listen 443 ssl http2;
  server_name game.example.com;
  root /var/www/jdqs/dist;
  index index.html;

  location /assets/ {
    expires 1y;
    add_header Cache-Control "public, immutable";
  }
  location / {
    try_files $uri $uri/ /index.html;
  }
}
```

### D. Docker

```dockerfile
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
```

```bash
docker build -t jdqs .
```

```bash
docker run -p 8080:80 jdqs
```

## 5. 雲端存檔
純靜態部署（A、B）預設會嘗試同網域的 `/api`；沒有後端時雲端功能會顯示「無法連線」，其餘遊戲正常。
要啟用跨裝置存檔，請依 [06-CLOUD-SAVE.md](06-CLOUD-SAVE.md) 選擇「內建伺服器」（C/D 方式改用 `npm run start` 一個 Node 程序即可同時提供前端與 API）或 Supabase。

## 6. OpenStreetMap 使用規範（上線前務必閱讀）
- 地圖圖磚來自 `tile.openstreetmap.org`，須遵守 [OSM Tile Usage Policy](https://operations.osmfoundation.org/policies/tiles/)：保留版權標示（已內建於地圖右下角）、不可大量預抓。**流量較大的正式營運請改用商用圖磚**（MapTiler、Stadia Maps、Thunderforest 等），只需修改 `src/map/MapService.js` 中 `L.tileLayer` 的網址與 attribution。
- 建築資料來自公共 Overpass API（`src/map/OverpassService.js` 的 `ENDPOINTS`，會依序容錯）。遊戲只在**新建存檔**或玩家按「🔄 重新掃描」時查詢一次，結果存入存檔。大量玩家時建議自架 Overpass 或加一層快取代理。
- Overpass 無法連線時，遊戲會自動以程序生成地點繼續運作（地圖資訊列顯示「程序生成」）。

## 7. 疑難排解
| 症狀 | 原因與處理 |
|---|---|
| 地圖一片灰色 | 圖磚被網路阻擋（公司防火牆、擋廣告外掛）。遊戲仍可遊玩，可改用其他圖磚來源。 |
| 「程序生成（OSM 無法連線）」 | Overpass 逾時或被擋。稍後在地圖頁按 🔄 重新掃描。 |
| 定位失敗 | 非 HTTPS、使用者拒絕權限，或裝置未開定位。改用手動座標。 |
| 進度消失 | 清除瀏覽器資料或無痕模式會清空 LocalStorage。請定期在「設定 → 匯出存檔」備份。 |
| 想重新開始 | 設定 → 🗑️ 刪除存檔重新開始。 |
| 開發時想查看狀態 | 開發模式下可在 Console 使用 `window.__game`（例如 `__game.state.resources.wood = 9999`）。 |
