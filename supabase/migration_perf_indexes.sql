-- ============================================================================
-- 資料庫效能優化遷移（純加法、可重複執行、絕不刪除任何資料）
-- ----------------------------------------------------------------------------
-- 本檔只做兩件事：
--   1) 新增缺失的查詢索引（CREATE INDEX IF NOT EXISTS，重複執行安全）
--   2) 不加任何 DROP / TRUNCATE / DELETE / UPDATE 等可能破壞資料的語法
-- 在 Supabase「SQL Editor」整段貼上執行即可。
-- ============================================================================

-- 1) 登入熱點：login 以「座號（student_no）」單獨查詢（未帶 class_id）
--    原唯一鍵是 (class_id, student_no)，無法服務「只依 student_no」的查詢。
create index if not exists idx_users_student_no on public.users (student_no);

-- 2) 核銷端「依座號/學號查詢」：adminResolveSeat 以 seat_no 查詢
create index if not exists idx_users_seat_no on public.users (seat_no);

-- 3) 菜單載入熱點：listMenuItemsForStore(s) 以 class_id + store_id 查詢
--    原 idx_menu_items_store 只有 store_id，缺少 class_id 前置。
create index if not exists idx_menu_items_class_store on public.menu_items (class_id, store_id);

-- 4) 歷程記錄：adminGetActivityLog 對 orders 依 class_id 排序 updated_at desc 取 limit
--    原無 (class_id, updated_at) 索引，會觸發整班級排序。
create index if not exists idx_orders_class_updated on public.orders (class_id, updated_at desc);

-- 5) 退款/取消場次的冪等檢查：fn_delete_session_and_refund 以 order_id 查 transactions
--    （kind='Refund'）原無 order_id 索引。
create index if not exists idx_transactions_order on public.transactions (order_id);

-- 6) 改密碼/停用/重置時使 Token 全部失效：deleteRows('auth_tokens', {user_id})
--    原只有 token_hash 索引，user_id 刪除會全表掃描。
create index if not exists idx_auth_tokens_user on public.auth_tokens (user_id);

-- 7) 推播目標查詢：sendPushToClass / sendPushToUser 以 class_id / user_id 查 push_subscriptions
--    原只有 endpoint 唯一鍵，無 class_id / user_id 索引。
create index if not exists idx_push_subs_class on public.push_subscriptions (class_id);
create index if not exists idx_push_subs_user  on public.push_subscriptions (user_id);

-- ============================================================================
-- 完成。以上 8 個索引皆為「新增」，不影響既有資料與查詢結果。
-- 若要確認索引已建立，可執行：
--   select tablename, indexname from pg_indexes where schemaname='public' order by tablename, indexname;
-- ============================================================================
