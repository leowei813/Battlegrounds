import { defineConfig } from 'vite';

export default defineConfig({
  // 相對路徑，方便部署到 GitHub Pages 子目錄或任何靜態主機
  base: './',
  server: {
    host: true,
    port: 5173,
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
