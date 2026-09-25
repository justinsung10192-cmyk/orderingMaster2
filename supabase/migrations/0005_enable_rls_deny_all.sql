-- ============================================================================
-- 0005_enable_rls_deny_all.sql
--
-- 目的：啟用 RLS（Row Level Security）並「不建立任何政策」＝預設全部拒絕。
--
-- 為什麼現在可以做：這個系統的前端完全不碰 Supabase（沒有任何 createClient、
-- 沒有 anon key；所有請求都經過 /api/gas 這個伺服器端入口），
-- 資料庫只由伺服器端的 service_role 存取 —— 而 service_role 會繞過 RLS。
-- 因此啟用 RLS 對現有功能零影響，卻能擋掉「anon key 外洩就全表可讀」這個風險。
--
-- 前提（請務必確認）：若未來有任何前端 / 第三方直接用 anon key 讀資料，
-- 這支遷移會讓那些請求全部失敗。要還原請執行本檔最下方的 rollback 語法。
--
-- 風險：低（僅影響 anon / authenticated 角色；service_role 不受影響）。
-- 可重複執行：是。
-- ============================================================================

do $$
declare
  target text;
begin
  for target in
    select tablename from pg_tables where schemaname = 'public'
  loop
    execute format('alter table public.%I enable row level security', target);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 為什麼「不寫 policy」就是 deny-all：
--   RLS 開啟後，沒有匹配政策的存取一律被拒。
--   service_role（伺服器端）具備 bypassrls 權限，因此 api/gas.js 完全不受影響。
-- 為什麼不用 force row level security：
--   那會連 table owner 一起限制，會影響維護用 SQL，且對 service_role 無實益。
-- ---------------------------------------------------------------------------

-- 回滾（必要時在 SQL Editor 單獨執行）：
--   do $$ declare t text; begin
--     for t in select tablename from pg_tables where schemaname='public' loop
--       execute format('alter table public.%I disable row level security', t);
--     end loop;
--   end $$;

-- 驗證（應全部顯示 rowsecurity = true）：
--   select tablename, rowsecurity from pg_tables where schemaname='public' order by tablename;
