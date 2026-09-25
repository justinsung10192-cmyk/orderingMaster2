-- ============================================================================
-- 資料庫遷移總包（generated file — 請勿手動編輯）
--
-- 產生方式： npm run db:bundle
-- 用途：把 supabase/migrations/*.sql 依編號順序合併成一段可直接貼進
--       Supabase SQL Editor 執行的 SQL，並自動寫入 schema_migrations 紀錄。
-- 特性：全部檔案都必須可重複執行（idempotent），重跑不會壞資料。
-- ============================================================================

-- >>> 0001_schema_migrations.sql  (sha256 365e3698281b2bae31908203517b9872f6f143f2d9e33f4444c101f0dbb1bf15)
begin;
-- ============================================================================
-- 0001_schema_migrations.sql
-- 目的：建立遷移追蹤表，讓「哪一版跑過了」變成可查詢的事實，而不是記憶。
-- 風險：無。純新增資料表，不影響任何既有功能。
-- 可重複執行：是。
-- ============================================================================

create table if not exists public.schema_migrations (
  version    text primary key,
  name       text not null,
  checksum   text not null,
  applied_at timestamptz not null default now()
);

comment on table public.schema_migrations is
  '已套用的資料庫遷移。version 為檔名前綴（如 0002），checksum 為該遷移檔內容的 sha256，用於偵測「已套用的檔案被偷改」。';

create index if not exists idx_schema_migrations_applied_at
  on public.schema_migrations (applied_at desc);

-- 若這個資料庫是用舊流程（手動跑 schema.sql + migration_*.sql）建起來的，
-- 這裡補一筆「建庫基線」紀錄，代表 0001 之前的狀態。
insert into public.schema_migrations (version, name, checksum)
values ('0000', 'legacy_baseline_schema_sql', 'n/a')
on conflict (version) do nothing;
insert into public.schema_migrations (version, name, checksum) values ('0001', 'schema_migrations', '365e3698281b2bae31908203517b9872f6f143f2d9e33f4444c101f0dbb1bf15') on conflict (version) do update set name = excluded.name, checksum = excluded.checksum;
commit;

-- >>> 0002_performance_indexes.sql  (sha256 d584f6d1ddbcb398a83ab9a310f1f06f582948bc15c0a51d68764466b7eca3e9)
begin;
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
insert into public.schema_migrations (version, name, checksum) values ('0002', 'performance_indexes', 'd584f6d1ddbcb398a83ab9a310f1f06f582948bc15c0a51d68764466b7eca3e9') on conflict (version) do update set name = excluded.name, checksum = excluded.checksum;
commit;

-- >>> 0003_audit_log.sql  (sha256 879c86b9931b3915997a369e879548232da8f4aaf3826bd04030c263278e3c8a)
begin;
-- ============================================================================
-- 0003_audit_log.sql
-- 目的：建立 append-only 的事件紀錄表，讓「誰在什麼時候改了哪一筆錢/哪一張單」
--       變成資料庫層級的事實，而不是只存在於 Vercel 的 console log（會被輪替掉）。
-- 風險：低。所有 trigger 內的錯誤都會被吞掉（見下方 exception 區塊），
--       因此「稽核寫入失敗」永遠不會讓訂單或金流交易失敗。
-- 可重複執行：是（create table/trigger if not exists 或先 drop trigger）。
-- ============================================================================

create table if not exists public.audit_log (
  id          bigserial   primary key,
  at          timestamptz not null default now(),
  class_id    text,
  actor_id    text,
  actor_role  text,
  table_name  text        not null,
  op          text        not null,
  row_id      text,
  before      jsonb,
  after       jsonb,
  request_id  text,
  source      text        not null default 'trigger'
);

comment on table public.audit_log is
  '僅供新增的事件紀錄（append-only）。由 trigger 自動寫入，應用層不直接寫。';

create index if not exists idx_audit_log_at        on public.audit_log (at desc);
create index if not exists idx_audit_log_class_at  on public.audit_log (class_id, at desc);
create index if not exists idx_audit_log_row       on public.audit_log (table_name, row_id);
create index if not exists idx_audit_log_actor_at  on public.audit_log (actor_id, at desc);

-- ---------------------------------------------------------------------------
-- 通用稽核 trigger 函式
-- ---------------------------------------------------------------------------
-- 說明：
--   * 會嘗試讀取 request 級別的變數（app.actor_id / app.actor_role / app.request_id），
--     應用層若沒有設定，這些欄位就是 null，不影響寫入。
--   * 整個 insert 包在 begin ... exception when others then null; end; 之中：
--     稽核失敗「絕不」影響主交易。這是刻意的取捨——可觀測性不能反過來成為故障源。
--   * 使用 security definer + 固定 search_path，避免被惡意 schema 覆蓋。
create or replace function public.fn_audit_row()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_class_id   text;
  v_row_id     text;
  v_before     jsonb;
  v_after      jsonb;
  v_actor_id   text;
  v_actor_role text;
  v_request_id text;
begin
  begin
    if tg_op = 'DELETE' then
      v_row_id := old.id::text;
      v_class_id := old.class_id;
      v_before := to_jsonb(old);
      v_after := null;
    elsif tg_op = 'UPDATE' then
      v_row_id := new.id::text;
      v_class_id := new.class_id;
      v_before := to_jsonb(old);
      v_after := to_jsonb(new);
    else
      v_row_id := new.id::text;
      v_class_id := new.class_id;
      v_before := null;
      v_after := to_jsonb(new);
    end if;

    v_actor_id   := nullif(current_setting('app.actor_id', true), '');
    v_actor_role := nullif(current_setting('app.actor_role', true), '');
    v_request_id := nullif(current_setting('app.request_id', true), '');

    insert into public.audit_log (
      class_id, actor_id, actor_role, table_name, op, row_id, before, after, request_id, source
    ) values (
      v_class_id, v_actor_id, v_actor_role, tg_table_name, tg_op, v_row_id, v_before, v_after, v_request_id, 'trigger'
    );
  exception when others then
    null;  -- 稽核失敗必須靜默：不可以讓既有功能因此壞掉
  end;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 掛載點：只掛在「錢」與「訂單」上。刻意不掛 users / stores 等低風險表，
-- 避免不必要的寫入放大。
-- ---------------------------------------------------------------------------
drop trigger if exists trg_audit_transactions_ins on public.transactions;
create trigger trg_audit_transactions_ins
  after insert on public.transactions
  for each row execute function public.fn_audit_row();

drop trigger if exists trg_audit_orders_ins on public.orders;
create trigger trg_audit_orders_ins
  after insert on public.orders
  for each row execute function public.fn_audit_row();

drop trigger if exists trg_audit_orders_upd on public.orders;
create trigger trg_audit_orders_upd
  after update on public.orders
  for each row execute function public.fn_audit_row();

-- 注意：刻意「不」建立「禁止 UPDATE/DELETE audit_log」的保護 trigger。
-- 原因：adminResetAllData 這類既有功能會清理資料表，若在此擋下刪除會讓現有功能故障。
-- append-only 目前以慣例 + 權限維持；等 reset 流程也納入稽核後再開啟（見 docs/ADR/0004）。
insert into public.schema_migrations (version, name, checksum) values ('0003', 'audit_log', '879c86b9931b3915997a369e879548232da8f4aaf3826bd04030c263278e3c8a') on conflict (version) do update set name = excluded.name, checksum = excluded.checksum;
commit;

-- >>> 0004_request_id_idempotency.sql  (sha256 b96def6e408496017d4b2f3affc50d085a2a339d85b419cf55a10a4123dc15f7)
begin;
-- ============================================================================
-- 0004_request_id_idempotency.sql
-- 目的：為金流/訂單加上「冪等鍵」欄位，讓「重試」不會變成「重複扣款」。
--       目前只是先把地基鋪好：欄位可為 null、沒有唯一限制到既有資料，
--       既有的 RPC（fn_settle_order / fn_topup / ...）行為完全不變。
-- 風險：無。新增可為 null 的欄位 + partial unique index（只約束非 null 值）。
-- 可重複執行：是。
-- ============================================================================

alter table public.transactions add column if not exists request_id text;
alter table public.orders       add column if not exists request_id text;

comment on column public.transactions.request_id is
  '同一筆請求的唯一鍵（上層 api/gas.js 產生）。相同 request_id 重複送出時，RPC 應回傳第一次的結果而非再扣一次款。';
comment on column public.orders.request_id is
  '建立訂單的請求唯一鍵，用於護欄式重送（雙擊送出、行動網路逾時重試）。';

-- 冪等保證：同一班級內，同一個 request_id 只能對應一筆交易。
-- 使用 partial index（where request_id is not null），既有資料不受影響。
create unique index if not exists uq_transactions_class_request
  on public.transactions (class_id, request_id)
  where request_id is not null;

create unique index if not exists uq_orders_class_request
  on public.orders (class_id, request_id)
  where request_id is not null;

-- 由 request_id 反查（客服/對帳用）。
create index if not exists idx_transactions_request
  on public.transactions (request_id)
  where request_id is not null;

-- ---------------------------------------------------------------------------
-- 待辦（下一階段，本次刻意不做）：
--   1. 讓 fn_settle_order / fn_topup / fn_settle_cash / fn_refund_order /
--      fn_manual_balance / fn_partial_pay 接受 p_request_id 參數，
--      並在函式開頭先查 request_id 是否已存在（存在就回傳既有結果）。
--   2. api/gas.js 為每個寫入型動作產生 requestId 並往下傳。
--   3. 呼叫端（前端）在重試時沿用同一個 requestId。
-- 為什麼現在不做：動到金額函式屬於高風險變更，需要真實資料庫的整合測試把關，
-- 不能只靠單元測試。詳見 docs/ARCHITECTURE.md「金流冪等：分階段落地」。
-- ---------------------------------------------------------------------------
insert into public.schema_migrations (version, name, checksum) values ('0004', 'request_id_idempotency', 'b96def6e408496017d4b2f3affc50d085a2a339d85b419cf55a10a4123dc15f7') on conflict (version) do update set name = excluded.name, checksum = excluded.checksum;
commit;

-- >>> 0005_enable_rls_deny_all.sql  (sha256 c109a9aec7658157e8e8b45d69cce5ad5e6eeeaa932c593659da9386d7b68bab)
begin;
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
insert into public.schema_migrations (version, name, checksum) values ('0005', 'enable_rls_deny_all', 'c109a9aec7658157e8e8b45d69cce5ad5e6eeeaa932c593659da9386d7b68bab') on conflict (version) do update set name = excluded.name, checksum = excluded.checksum;
commit;
