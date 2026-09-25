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
