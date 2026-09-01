import path from "node:path";
import { defineConfig } from "vite";

// 精簡建置設定：只打包 client 的靜態前端（index.html + src/app.js）。
// 後端資料由 Google Apps Script 提供，透過 api/gas.js 同網域代理。
export default defineConfig({
  root: path.resolve(process.cwd(), "client"),
  publicDir: path.resolve(process.cwd(), "client", "public"),
  build: {
    outDir: path.resolve(process.cwd(), "dist/public"),
    emptyOutDir: true,
  },
});
