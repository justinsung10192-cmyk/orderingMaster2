# 資料庫架構檢核報告（訂餐通 / Supabase PostgreSQL）

> 檢核日期：依現有 `supabase/schema.sql`、全部遷移檔與 `api/` 查詢程式碼分析。
> 原則：**只做加法（新增索引）、絕不刪改資料、不採用 DROP / TRUNCATE / DELETE 等破壞性語法。**

---

## 1. 架構總覽（21 張表）

| 群組 | 資料表 |
|---|---|
| 核心 | classes, users, stores, menu_items, sessions, orders, transactions |
| 排程 | recurring_menu, holidays, duty_assignments |
| 核銷 | verification_records, votes |
| 認證/推播 | auth_tokens, push_subscriptions |
| 設定/日誌 | app_settings, changelog |
| 行事曆 | calendar_events, calendar_event_logs |
| v3.2 功能 | custom_debts, leave_requests, menu_recommendations |

金流以 `security definer` 的 RPC 函式（`fn_settle_order`、`fn_topup`、`fn_settle_cash`、`fn_refund_order`、`fn_delete_session_and_refund`、`fn_manual_balance`、`fn_partial_pay`）原子化處理，並以 `FOR UPDATE` 列鎖防止並發扣款錯誤。

---

## 2. 索引檢核

### 既有（良好）
- orders：`(session_id)`、`(user_id)`、`(class_id, is_deleted, payment_status)`＋唯一 `(session_id, user_id)`
- transactions：`(user_id, created_at)`、`(class_id, created_at)`
- sessions：`(class_id, order_date)`、`(class_id, week_label)`、`(cutoff_time)`
- menu_items：`(store_id)`＋唯一 `(class_id, store_id, name, menu_date)`
- users：`(class_id)`、`(class_id, role)`＋唯一 `(class_id, student_no)`
- verification_records：`(user_id, status, expires_at)`＋部分索引 `(pin_hash) WHERE status='Pending'`

### 缺失（本次補上，見 `migration_perf_indexes.sql`）
1. `users(student_no)` — 登入熱點（login 只依 student_no 查詢，未帶 class_id）
2. `users(seat_no)` — 核銷端依座號查詢
3. `menu_items(class_id, store_id)` — 菜單載入熱點
4. `orders(class_id, updated_at DESC)` — 歷程記錄排序
5. `transactions(order_id)` — 退款/取消場次冪等檢查
6. `auth_tokens(user_id)` — 改密碼/停用時撤銷 Token
7. `push_subscriptions(class_id)` — 推播目標查詢
8. `push_subscriptions(user_id)` — 推播目標查詢

---

## 3. RLS 檢核

**現況**：所有表皆「未啟用 RLS」，存取全部經伺服器端 `service_role`（`api/`），前端無直接使用 anon 金鑰（所有請求經 `/api/gas` 代理）。

**結論**：功能正常、但缺少「防禦縱深」。因 `service_role` 會繞過 RLS，可安全地「啟用 RLS 但不建立 policy」——anon 金鑰即完全無法讀寫，系統照常運作。

→ 見 `migration_rls_optional.sql`（選用、可逆）。

---

## 4. N+1 查詢檢核

### 熱路徑（已批次化，良好）
- `getBootstrap`：場次/店家/投票/放假/公告以 `Promise.all` 並行＋`listMenuItemsForStores` 一次載入多店家菜單。
- 儀表板 `loadDaySummary`：`listRowsIn('orders', 'session_id', ...)` 批次載入。
- 歷程 `adminGetActivityLog`：transactions + orders 並行，再以 `listRowsIn('users', 'id', ...)` 批次補使用者。
- 核銷 `resolveContext`：student/orders/stores 並行＋sessions 批次。

### 仍存在但低頻、小資料量（可接受，如需極致可再批次化）
1. `adminConfirmPickup`：逐筆 order 查詢＋更新（一次取餐的筆數極少）。
2. `adminSetWeekCutoff` / `adminPublishWeek`：逐 session 更新（一週 ≤ 14 場）。
3. `materializeRecurring`：逐筆 insert 未來 14 天場次（店家數 × 14，量小）。
4. `adminClearRecurring`：逐場次呼叫 RPC 退款（場次數少）。
5. `cron.js` 截止提醒：逐 session 查 orders（每小時、量小）。

> 以上均為管理端或每小時排程，不影響學生端毫秒級體驗。

---

## 5. 並發與鎖定（良好）

- 金流函式以 `FOR UPDATE` 鎖 user / session / order 列，鎖定順序大致一致（users → orders），死鎖風險低。
- `fn_topup` 抵欠款迴圈 `FOR UPDATE OF o`，避免與結帳並發重複抵銷。
- 小提醒（低風險、未更動）：`fn_delete_session_and_refund` 鎖定順序為 sessions → orders → users，與其他函式（users → …）不同，單班級低並發下無實質影響。

---

## 6. 其他觀察

- `login` 以 `student_no` 查詢但未帶 `class_id`：單班級下正常；若未來多班級且座號重複，`.maybeSingle()` 會因多列而報錯。建議未來改帶 class_id。
- `adminExportBackup`（既有 UI 備份）會移除密碼雜湊/salt，適合一般備份；完整備份請用 `scripts/backup.js`（含全欄位，需妥善保管）。

---

## 7. 交付物

| 檔案 | 用途 | 是否破壞資料 |
|---|---|---|
| `supabase/migration_perf_indexes.sql` | 新增 8 個索引（`CREATE INDEX IF NOT EXISTS`） | 否（純加法、可重複執行） |
| `supabase/migration_rls_optional.sql` | 選用：啟用 RLS（無 policy） | 否（可逆） |
| `scripts/backup.js`（`npm run backup`） | 唯讀完整備份為 JSON | 否（僅 SELECT） |
