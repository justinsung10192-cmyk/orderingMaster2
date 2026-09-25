# 資料庫遷移（Numbered Migrations）

這個資料夾是**唯一的資料庫變更來源**。從現在開始，任何資料庫變更都必須是「新增一個編號檔」，
而不是去改已經跑過的檔案。

## 為什麼要這樣做

舊的做法是 `supabase/migration_*.sql` 一堆沒有編號的檔案，加上一個手動維護的 `schema.sql`。
問題是：

1. **看不出誰先誰後** — 19 個檔案沒有編號，新環境要靠人的記憶排序。
2. **不知道跑過了沒** — 沒有 `schema_migrations` 紀錄，只能靠「應該跑過了吧」。
3. **改過的檔案沒人知道** — 檔案內容被改掉，已經上線的資料庫不會跟著改，於是線上與 schema.sql 分叉。
4. **`schema.sql` 與 migrations 不一致** — 例如 `migration_perf_indexes.sql` 的 8 個索引，新安裝的
   資料庫（只跑 `schema.sql`）完全沒有，於是「新環境特別慢」卻查不出原因。

## 規則

| 規則 | 說明 |
| --- | --- |
| 檔名格式 | `NNNN_lower_snake_case.sql`，例如 `0005_add_leave_approver.sql` |
| 編號連續 | 從 `0001` 起連續遞增，不可跳號、不可重複 |
| 已跑過的檔案不可修改 | 要改就新增下一個編號（`verify` 會用 checksum 抓出竄改） |
| 必須可重複執行 | 一律使用 `if not exists` / `if exists` / `create or replace` |
| 不可破壞既有資料 | 不得出現 `drop table` / `truncate` / 無條件 `delete` |
| 回報紀錄 | 執行後（透過 bundle）會自動寫入 `public.schema_migrations` |

舊的 `supabase/migration_*.sql` **不會被刪除或改名**，它們保留為歷史紀錄；
等編號版跑上線後，就不再使用它們。

## 怎麼跑

```bash
# 1) 看目前有哪些遷移、checksum 是多少
npm run db:list

# 2) 檢查編號/命名是否合法、bundle 是否為最新
npm run db:verify

# 3) 產生「一次貼進 Supabase SQL Editor」的完整 bundle
npm run db:bundle
#    → supabase/migrations/_generated_bundle.sql
```

`_generated_bundle.sql` 是**產生檔，請勿手改**（CI 會檢查它與原始遷移是否同步）。

## 檔案清單

| 編號 | 檔案 | 內容 | 風險 |
| --- | --- | --- | --- |
| 0001 | `0001_schema_migrations.sql` | 遷移追蹤表 | 無（純新增） |
| 0002 | `0002_performance_indexes.sql` | 補齊 8 個缺失索引（原本只存在於舊的 perf 檔案） | 無（純新增索引） |
| 0003 | `0003_audit_log.sql` | 可稽核的 append-only 事件紀錄 + 防呆 trigger | 低（trigger 內建錯誤吞除） |
| 0004 | `0004_request_id_idempotency.sql` | 金流冪等鍵欄位（`request_id`）與唯一索引 | 無（可為 null 的欄位） |
