import path from "node:path";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { defineConfig } from "vite";

// 自動版本號：package.json 的語意版號 + 建置當下的 git commit 短碼。
// 每次 push 部署（commit 變更）都會自動產生新版本，不需手動修改。
function resolveVersion() {
  const pkg = JSON.parse(readFileSync(path.resolve(process.cwd(), "package.json"), "utf8"));
  const base = pkg.version || "0.0.0";
  let hash = String(process.env.VERCEL_GIT_COMMIT_SHA || "").slice(0, 7);
  if (!hash) {
    try {
      hash = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
    } catch {
      hash = "";
    }
  }
  if (!hash) hash = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `${base}+${hash}`;
}

// 精簡建置設定：只打包 client 的靜態前端（index.html + src/app.js）。
// 後端資料由 Google Apps Script 提供，透過 api/gas.js 同網域代理。
export default defineConfig({
  root: path.resolve(process.cwd(), "client"),
  publicDir: path.resolve(process.cwd(), "client", "public"),
  define: {
    __APP_VERSION__: JSON.stringify(resolveVersion()),
  },
  build: {
    outDir: path.resolve(process.cwd(), "dist/public"),
    emptyOutDir: true,
  },
});
