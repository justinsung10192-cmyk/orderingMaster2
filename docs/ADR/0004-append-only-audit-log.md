# ADR 0004：稽核紀錄為 append-only，且「絕不影響主交易」

- 狀態：已採用（v4 分支，見 `supabase/migrations/0003_audit_log.sql`）
- 日期：2026-09-25

## 背景

這個系統會動到錢（儲值、結清、退款、部分付款）。目前唯一的痕跡是：

- `transactions` 表（業務欄位，不是稽核紀錄）
- Vercel Function log（會被輪替、無法查「上個月誰改了這筆」）

發生爭議時無法回答「誰、什麼時候、把哪一筆從什麼改成什麼」。

## 決策

建立 `public.audit_log`（append-only 慣例）並以 trigger 自動寫入：

- 掛載點：`transactions`（insert）、`orders`（insert / update）。刻意不掛全表，避免寫入放大。
- 欄位：`at, class_id, actor_id, actor_role, table_name, op, row_id, before, after, request_id, source`。
- 應用層可透過 `set local app.actor_id = …` 等變數帶入操作者與 `request_id`；未設定時為 null。
- **trigger 內所有錯誤都被吞掉**（`exception when others then null;`），
  且函式為 `security definer` + 固定 `search_path`。

## 理由

1. **可觀測性不可以反過來成為故障源**：稽核寫入失敗（欄位不合、權限問題、鎖等待）
   絕不能讓學生訂不了餐、讓結清失敗。
2. trigger 而非應用層寫入：應用層有 83 個動作，掛在應用層就一定會有漏掛的；
   trigger 是資料庫層級的保證。
3. `before` / `after` 存 `jsonb`，事後可用 SQL 還原爭議過程。

## 已知取捨

- **刻意不建立「禁止 UPDATE / DELETE audit_log」的保護 trigger**：
  `adminResetAllData` 這類既有功能會清理資料表，加了保護會讓現有功能故障。
  append-only 目前靠慣例＋（未來的）權限控管維持。等重置流程本身納入稽核後，再開啟保護。
- 儲存量會成長（每筆交易一列）。班級規模（數十人）下可接受；若成長過快，
  之後可加上「超過 N 天歸檔到冷表」。

## 後續

1. `api/gas.js` 在呼叫 handler 前 `set local app.actor_id / app.actor_role / app.request_id`。
2. 管理端新增「稽核紀錄查詢」（目前尚無 UI）。
