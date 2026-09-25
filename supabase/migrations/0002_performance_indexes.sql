-- ============================================================================
-- 0002_performance_indexes.sql
-- 目的：把「只存在於 supabase/migration_perf_indexes.sql、但沒有寫進 schema.sql」
--       的 8 個索引，正式納入版本化遷移。
-- 背景：新環境若只跑 supabase/schema.sql，這 8 個索引全部不存在，
--       會出現「新裝的站特別慢」但查不出原因的狀況。
-- 風險：無。CREATE INDEX IF NOT EXISTS 純新增，不改變任何查詢結果。
-- 可重複執行：是。
-- ============================================================================

-- 1) 登入熱點：login 以「座號 student_no」單獨查詢。
--    原唯一鍵是 (class_id, student_no)，無法服務「只帶 student_no」的查詢。
create index if not exists idx_users_student_no on public.users (student_no);

-- 2) 核銷端依座號/學號查詢：adminResolveSeat 以 seat_no 查詢。
create index if not exists idx_users_seat_no on public.users (seat_no);

-- 3) 菜單載入熱點：listMenuItemsForStore(s) 以 class_id + store_id 查詢。
--    原有 idx_menu_items_store 只有 store_id，缺少 class_id 前置欄。
create index if not exists idx_menu_items_class_store on public.menu_items (class_id, store_id);

-- 4) 歷程記錄：adminGetActivityLog 對 orders 依 class_id 過濾並以 updated_at desc 排序取 limit。
create index if not exists idx_orders_class_updated on public.orders (class_id, updated_at desc);

-- 5) 退款/取消場次的冪等檢查：fn_delete_session_and_refund 以 order_id 查 transactions(kind='Refund')。
create index if not exists idx_transactions_order on public.transactions (order_id);

-- 6) 改密碼/停用/重置時使 Token 全部失效：deleteRows('auth_tokens', {user_id})。
--    原本只有 token_hash 索引，用 user_id 刪除會全表掃描。
create index if not exists idx_auth_tokens_user on public.auth_tokens (user_id);

-- 7) 推播目標查詢：sendPushToClass / sendPushToUser 以 class_id / user_id 查 push_subscriptions。
create index if not exists idx_push_subs_class on public.push_subscriptions (class_id);
create index if not exists idx_push_subs_user  on public.push_subscriptions (user_id);

-- 8) 稽核/對帳查詢用：transactions 依 class_id + created_at 已存在
--    （idx_transactions_class），此處僅補 request_id 的反查（見 0004）。
--    這行保留為說明用，不建立索引。
