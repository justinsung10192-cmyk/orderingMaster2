# ADR 0003：資料庫變更一律走編號遷移，`schema.sql` 不得成為唯一真相

- 狀態：已採用（v4 分支）
- 日期：2026-09-25

## 背景

原本的資料庫變更流程是：`supabase/schema.sql`（新建資料庫用）＋ 19 個沒有編號的
`supabase/migration_*.sql`（既有資料庫升級用）。實際後果：

1. **順序靠記憶**：19 個檔案沒有編號，新環境要跑哪些、先後如何，只能問人。
2. **跑過沒不知道**：沒有 `schema_migrations` 之類的紀錄。
3. **檔案被偷改沒人知道**：改掉已上線的遷移，舊庫不會跟著改，於是線上與檔案分叉。
4. **真的出事了**：`migration_perf_indexes.sql` 的 8 個索引沒有同步回 `schema.sql`，
   導致「照 schema.sql 新建的資料庫特別慢」，而且沒人查得出原因。

## 決策

1. 新增 `supabase/migrations/NNNN_lower_snake_case.sql` 作為**唯一變更來源**。
2. 編號必須從 `0001` 起**連續**、不重複；已存在的遷移檔**不可修改**，要改就新增下一號。
3. 每個遷移都必須 **idempotent**（`if not exists` / `create or replace`）且**不含破壞性語法**
   （`drop table` / `drop column` / `truncate` / 無條件 `delete`）。
4. 以 `scripts/lib/migrations.mjs` 把上述規則寫成**程式碼**（可被 `tests/migrations.test.js` 測試），
   而不是只寫在文件裡的約定。
5. `npm run db:bundle` 產生 `_generated_bundle.sql`（含各檔 sha256，並自動寫入 `schema_migrations`），
   供使用者一次貼進 Supabase SQL Editor 執行；CI 檢查產生檔與遷移是否同步。
6. 19 個舊的 `migration_*.sql` **保留不動**（歷史紀錄），不重新命名、不刪除。
7. `schema.sql` 仍需保持可用，並補上遺漏的 8 個索引；`tests/consistency.test.js`
   強制「遷移中的索引都必須出現在 `schema.sql`」。

## 理由

- 規則寫成程式碼＋測試，才不會隨時間鬆掉（這次的索引分叉就是「只靠自律」的結果）。
- checksum 讓「偷改已上線檔案」從隱形變成可發現。
- bundle 讓「不會用 CLI 的人」也能安全執行（貼上即可，可重複執行）。

## 後續

終極狀態是「`schema.sql` 由遷移產生」（`npm run db:generate-schema`），
讓兩者不可能分叉。現階段先以 CI 比對取代。
