-- ============================================================================
-- 從「目前線上的資料庫」dump 出金額函式的真實定義
-- ============================================================================
-- 為什麼需要這支查詢：
--
-- supabase/schema.sql 裡面有 7 支函式、共 16 份定義（同一支函式被重複定義 3 次），
-- 而且 supabase/ 底下有 9 個舊的 migration_*.sql 也各自重新定義了同樣的函式：
--
--   fn_settle_order                 x3 (schema.sql) + 6 個舊 migration 也改過
--   fn_refund_order                 x3
--   fn_settle_cash                  x3
--   fn_delete_session_and_refund    x3
--   fn_topup                        x2
--
-- Postgres 的 create or replace 是「後面覆蓋前面」，所以：
--   * 只跑 schema.sql        → 得到 schema.sql 內「最後一份」定義
--   * 線上正式環境           → 可能被某個舊 migration 覆蓋成別的版本
--
-- 也就是說：**沒人知道線上實際跑的是哪一版**，這正是「重建新資料庫」最大的風險。
-- 不要用猜的，直接把真相 dump 出來。
--
-- 使用方式：
--   1. 到「目前線上」的 Supabase 專案 → SQL Editor → 執行下面查詢。
--   2. 結果每一列都是一段完整的 create or replace function ... 語法。
--   3. 把這些內容依序貼進新檔案 supabase/migrations/0006_money_functions_from_production.sql，
--      然後執行 `npm run db:bundle` 重新產生總包。
--
-- 為什麼要放進 0006 而不是改 schema.sql：
--   新資料庫的套用順序是 schema.sql → 0001～0006。
--   0006 會用 create or replace 蓋掉 schema.sql 內的舊版本，
--   因此「新資料庫跑的行為」＝「線上實際跑的行為」，而且是可稽核、可重現的。
-- ============================================================================

select p.proname as function_name,
       pg_get_functiondef(p.oid) as definition
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname like 'fn_%'
order by p.proname;

-- 附帶建議：順便確認索引是否都存在於線上（與 supabase/migrations/0002 比對）
-- select tablename, indexname from pg_indexes where schemaname = 'public' order by tablename, indexname;
