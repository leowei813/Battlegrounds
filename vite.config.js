import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

/** 建置時輸出 version.json，讓已開啟的舊版頁面偵測到有新版本 */
const versionFile = () => ({
  name: 'version-file',
  generateBundle() {
    this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ version: pkg.version }) });
  },
});

export default defineConfig({
  plugins: [versionFile()],
  // 版本號注入前端（顯示於首頁、狀態列與更新內容）
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  // 相對路徑，方便部署到 GitHub Pages 子目錄或任何靜態主機
  base: './',
  server: {
    host: true,
    port: 5173,
    // 開發時把雲端存檔 API 轉到 npm run server（預設 8787）
    proxy: {
      '/api': 'http://localhost:8787',
    },
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      output: {
        manualChunks: {
          phaser: ['phaser'],
          leaflet: ['leaflet'],
        },
      },
    },
  },
});
