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
