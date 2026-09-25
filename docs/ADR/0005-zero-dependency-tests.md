# ADR 0005：測試使用 Node 內建 `node:test`，不引入 jest / vitest

- 狀態：已採用（v4 分支）
- 日期：2026-09-25

## 背景

這個專案原本**完全沒有測試**，也沒有 CI。要開始補測試時，第一個決定是「用哪個測試框架」。

專案目前 dependencies 只有 2 個（`@supabase/supabase-js`、`web-push`），
devDependencies 只有 3 個（vite、tailwind 相關）。

## 決策

使用 Node 內建的 `node:test` + `node:assert`，`package.json` 的測試指令為 `node --test`。

## 理由

1. **零新增依賴**：不需要下載數百個套件，供應鏈風險不變、`node_modules` 不變大、
   Vercel 建置時間不變。
2. **執行速度快**：沒有 transform、沒有 bundler，秒級回饋。
3. **規則寫成程式碼**：`scripts/lib/migrations.mjs` 這類「規則實作」可以被測試，
   讓「靠自律」變成「靠機制」。
4. 現階段測的是**純邏輯**（授權決策、body 上限、時間週別、遷移規則、文件一致性），
   完全不需要框架的 mock/stub 生態。

## 取捨

| 取捨 | 說明 |
| --- | --- |
| 沒有內建 mock / spy | 目前不需要；需要時用最小手寫 stub（如 `util.test.js` 的假 `res`） |
| 沒有覆蓋率報告 | 之後可用 `node --test --experimental-test-coverage`（同樣零依賴） |
| 不適合元件/E2E 測試 | 前端 DOM 測試與 E2E 需要時再評估（playwright 屬獨立決策） |

## 後續

若未來要測 React/DOM 元件或做 E2E，再以**另一個 ADR** 決定是否引入依賴，
而不是默默把 jest/vitest 加進 package.json。
