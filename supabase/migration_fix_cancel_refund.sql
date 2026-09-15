-- ============================================================================
--  嚴重問題修正：取消場次退費錯誤 + 資料補退
--
--  問題：取消場次時退款邏輯錯誤，導致：
--    1) 已用儲值金付款者沒被退費到餘額；
--    2) 未繳費者反而被扣款；
--    3) 餘額錯亂，連帶導致其他場次也無法下單／修改（餘額不足）。
--
--  修正：
--    A. 重寫 fn_delete_session_and_refund（只退「儲值金」已付、絕不扣款、可重複執行不重複退）。
--    B. 重寫 fn_refund_order（單筆刪單，同樣只退儲值金）。
--    C. 重寫 fn_settle_order（統一版：請客場次 + 儲值金 + 現金保留 + 防並發）。
--    D. 資料補退：把「已取消場次」中被漏退的儲值金補回用戶餘額。
--
--  在 Supabase SQL Editor 執行一次即可（可重複執行，補退具冪等性）。
-- ============================================================================

-- 0. 確保請客／退款相關欄位存在（與 v3.2 遷移相容，尚未執行也能正常運作）----------
alter table public.sessions add column if not exists is_treat boolean not null default false;
alter table public.sessions add column if not exists treat_cap numeric(10,2) not null default 0;
alter table public.sessions add column if not exists treat_used numeric(10,2) not null default 0;
alter table public.orders add column if not exists treat_covered numeric(10,2) not null default 0;
alter table public.orders add column if not exists wallet_paid numeric(10,2) not null default 0;

-- A. 取消場次並退費（只退儲值金，絕不扣款；重複執行不重複退）--------------------
create or replace function public.fn_delete_session_and_refund(
  p_class_id text,
  p_session_id bigint
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_session record;
  v_order record;
  v_refund numeric;
  v_refunded_count int := 0;
  v_refunded_total numeric := 0;
  v_already int;
begin
  select * into v_session from sessions where id = p_session_id and class_id = p_class_id for update;
  if v_session.id is null then
    raise exception 'SESSION_NOT_FOUND';
  end if;

  if v_session.is_deleted then
    return jsonb_build_object('ok', true, 'refunded_count', 0, 'refunded_total', 0);
  end if;

  update sessions set is_deleted = true, closed_at = now() where id = p_session_id;

  -- 逐筆訂單：全部標記刪除；只退「儲值金（錢包）」已付金額，未付／現金者一律不動（絕不扣款）
  for v_order in
    select * from orders
    where session_id = p_session_id
      and coalesce(is_deleted, false) = false
    order by id
    for update
  loop
    v_refund := coalesce(v_order.wallet_paid, 0);
    if v_refund > 0 then
      -- 冪等防護：已退過（場次取消退款）就不再退
      select count(*) into v_already from transactions
      where order_id = v_order.id and kind = 'Refund' and note in ('場次取消退款', '場次取消退款（補退）');
      if v_already = 0 then
        update users set wallet_balance = wallet_balance + v_refund, updated_at = now()
        where id = v_order.user_id and class_id = p_class_id;
        insert into transactions (class_id, user_id, order_id, amount, kind, note)
        values (p_class_id, v_order.user_id, v_order.id, v_refund, 'Refund', '場次取消退款');
        v_refunded_total := v_refunded_total + v_refund;
      end if;
    end if;
    update orders set is_deleted = true, updated_at = now() where id = v_order.id;
    v_refunded_count := v_refunded_count + 1;
  end loop;

  -- 請客場次：釋放已用免費額度（歸零），統計才正確
  if v_session.is_treat then
    update sessions set treat_used = 0 where id = p_session_id;
  end if;

  return jsonb_build_object('ok', true, 'refunded_count', v_refunded_count, 'refunded_total', v_refunded_total);
end;
$$;

-- B. 單筆刪單退款（只退儲值金）--------------------------------------------------
create or replace function public.fn_refund_order(
  p_class_id text,
  p_user_id bigint,
  p_order_id bigint
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_balance numeric;
  v_order record;
  v_refund numeric;
begin
  select wallet_balance into v_balance
  from users where id = p_user_id and class_id = p_class_id
  for update;
  if v_balance is null then
    raise exception 'USER_NOT_FOUND';
  end if;

  select * into v_order from orders
  where id = p_order_id and user_id = p_user_id and class_id = p_class_id
  for update;
  if v_order.id is null then
    raise exception 'ORDER_NOT_FOUND';
  end if;

  v_refund := coalesce(v_order.wallet_paid, 0);
  if v_refund > 0 then
    update users set wallet_balance = wallet_balance + v_refund, updated_at = now()
    where id = p_user_id;
    insert into transactions (class_id, user_id, order_id, amount, kind, note)
    values (p_class_id, p_user_id, p_order_id, v_refund, 'Refund', '取消訂單退款');
  end if;

  -- 請客場次：釋放該單使用的免費額度
  if coalesce(v_order.treat_covered, 0) > 0 then
    update sessions set treat_used = greatest(0, treat_used - v_order.treat_covered)
    where id = v_order.session_id;
  end if;

  delete from orders where id = p_order_id;

  return jsonb_build_object('wallet_balance', v_balance + v_refund, 'refunded', v_refund);
end;
$$;

-- C. 統一版 fn_settle_order（請客場次 + 儲值金 + 現金保留 + 防並發）--------------
-- 先移除所有舊版多載，避免同名多載造成「Could not choose the best candidate function」
do $$
declare r record;
begin
  for r in
    select p.oid
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where p.proname = 'fn_settle_order' and n.nspname = 'public'
  loop
    execute 'drop function public.fn_settle_order(' || pg_get_function_identity_arguments(r.oid) || ') cascade';
  end loop;
end;
$$;

create or replace function public.fn_settle_order(
  p_class_id text,
  p_user_id bigint,
  p_session_id bigint,
  p_total numeric,
  p_wallet_paid numeric,
  p_cash_outstanding numeric,
  p_pure_mode boolean default false,
  p_prior_paid numeric default 0,
  p_order_id bigint default null,
  p_items jsonb default '[]',
  p_note text default '',
  p_treat_covered numeric default 0
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_balance numeric;
  v_status text;
  v_order_id bigint;
  v_wallet_paid numeric := 0;
  v_old_prior_paid numeric := 0;
  v_old_treat_covered numeric := 0;
  v_cash_paid numeric := 0;
  v_new_prior_paid numeric;
  v_new_cash_outstanding numeric;
  v_treat_covered numeric := 0;
  v_is_treat boolean := false;
  v_cap numeric := 0;
  v_used numeric := 0;
  v_remaining numeric;
begin
  select wallet_balance into v_balance
  from users where id = p_user_id and class_id = p_class_id
  for update;
  if v_balance is null then
    raise exception 'USER_NOT_FOUND';
  end if;

  -- 場次請客資訊（若尚未執行 v3.2 遷移，這些欄位不存在，此處用 try 語法防護）
  begin
    select coalesce(is_treat, false), coalesce(treat_cap, 0), coalesce(treat_used, 0)
    into v_is_treat, v_cap, v_used
    from sessions where id = p_session_id and class_id = p_class_id
    for update;
  exception when undefined_column then
    v_is_treat := false; v_cap := 0; v_used := 0;
  end;

  -- 更新訂單：鎖定訂單列並讀取資料庫內的 wallet_paid/prior_paid/treat_covered
  if p_order_id is not null then
    select wallet_paid, coalesce(prior_paid, 0), coalesce(treat_covered, 0)
    into v_wallet_paid, v_old_prior_paid, v_old_treat_covered
    from orders
    where id = p_order_id and user_id = p_user_id and class_id = p_class_id
    for update;
    if v_wallet_paid is null then
      raise exception 'ORDER_NOT_FOUND';
    end if;
    -- 釋放舊請客額度
    if v_old_treat_covered > 0 and v_is_treat then
      update sessions set treat_used = greatest(0, treat_used - v_old_treat_covered) where id = p_session_id;
      v_used := greatest(0, v_used - v_old_treat_covered);
    end if;
  end if;

  -- 舊單已繳現金（先繳的現金不能因為改單而消失）
  v_cash_paid := v_old_prior_paid - v_wallet_paid - v_old_treat_covered;
  if v_cash_paid < 0 then v_cash_paid := 0; end if;

  -- 請客場次：免費額度 = min(需求, 剩餘額度, 訂單總額)
  if v_is_treat and v_cap > 0 then
    v_remaining := greatest(0, v_cap - v_used);
    v_treat_covered := least(coalesce(p_treat_covered, 0), v_remaining, p_total);
    if v_treat_covered < 0 then v_treat_covered := 0; end if;
    if v_treat_covered > 0 then
      update sessions set treat_used = treat_used + v_treat_covered where id = p_session_id;
    end if;
  end if;

  if p_pure_mode then
    if p_cash_outstanding > 0 then
      raise exception 'PURE_MODE_NO_CASH';
    end if;
    if v_balance + v_wallet_paid < p_wallet_paid then
      raise exception 'INSUFFICIENT_BALANCE';
    end if;
  end if;

  -- 退回舊單錢包已付，再重新扣款
  v_balance := v_balance + v_wallet_paid;
  if p_wallet_paid > 0 then
    if v_balance < p_wallet_paid then
      raise exception 'INSUFFICIENT_BALANCE';
    end if;
    v_balance := v_balance - p_wallet_paid;
  end if;
  update users set wallet_balance = v_balance, updated_at = now() where id = p_user_id;

  v_new_prior_paid := p_wallet_paid + v_cash_paid + v_treat_covered;
  if v_new_prior_paid > p_total then v_new_prior_paid := p_total; end if;
  v_new_cash_outstanding := p_total - v_new_prior_paid;

  if v_new_cash_outstanding <= 0 then
    if v_cash_paid > 0 or v_treat_covered > 0 then v_status := 'PaidCash'; else v_status := 'PaidWallet'; end if;
  elsif v_new_prior_paid > 0 then
    v_status := 'PartiallyPaid';
  else
    v_status := 'UnpaidCash';
  end if;

  if p_order_id is not null then
    update orders
       set items = p_items, total_price = p_total, prior_paid = v_new_prior_paid, wallet_paid = p_wallet_paid,
           payment_status = v_status, note = p_note, treat_covered = v_treat_covered, updated_at = now()
     where id = p_order_id
    returning id into v_order_id;
  else
    insert into orders (class_id, session_id, user_id, items, total_price, prior_paid, wallet_paid, payment_status, pickup_status, note, treat_covered)
    values (p_class_id, p_session_id, p_user_id, p_items, p_total, v_new_prior_paid, p_wallet_paid, v_status, 'Pending', p_note, v_treat_covered)
    returning id into v_order_id;
  end if;

  if v_wallet_paid > 0 then
    insert into transactions (class_id, user_id, order_id, amount, kind, note)
    values (p_class_id, p_user_id, v_order_id, v_wallet_paid, 'Refund', '訂單修改退款');
  end if;
  if p_wallet_paid > 0 then
    insert into transactions (class_id, user_id, order_id, amount, kind, note)
    values (p_class_id, p_user_id, v_order_id, -p_wallet_paid, 'Wallet', '訂餐扣款');
  end if;
  if v_treat_covered > 0 then
    insert into transactions (class_id, user_id, order_id, amount, kind, note)
    values (p_class_id, p_user_id, v_order_id, -v_treat_covered, 'Treat', '請客折抵');
  end if;
  if v_new_cash_outstanding > 0 then
    insert into transactions (class_id, user_id, order_id, amount, kind, note)
    values (p_class_id, p_user_id, v_order_id, v_new_cash_outstanding, 'Cash', '現金未繳');
  end if;

  return jsonb_build_object('order_id', v_order_id, 'wallet_balance', v_balance, 'payment_status', v_status);
end;
$$;

-- D. 資料補退：把「已取消場次」中的儲值金補回（同時還原錯誤扣款；冪等）------------
do $$
declare
  v_order record;
  v_net numeric;
  v_wrong numeric;
  v_refund numeric;
  v_count int := 0;
begin
  for v_order in
    select o.id, o.user_id, o.class_id, coalesce(o.wallet_paid, 0) as wallet_paid,
           coalesce(o.total_price, 0) as total_price, coalesce(o.prior_paid, 0) as prior_paid,
           o.payment_status
    from orders o
    join sessions s on s.id = o.session_id
    where s.is_deleted = true
  loop
    -- 該單已記錄的「場次取消退款」淨額（正確退費為正，錯誤扣款為負）
    select coalesce(sum(t.amount), 0) into v_net
    from transactions t
    where t.order_id = v_order.id
      and t.kind = 'Refund'
      and t.note in ('場次取消退款', '場次取消退款（補退）');

    -- 1) 還原錯誤扣款（淨額為負 → 把被扣的金額加回）
    if v_net < 0 then
      v_wrong := -v_net;
      update users set wallet_balance = wallet_balance + v_wrong, updated_at = now()
      where id = v_order.user_id;
      insert into transactions (class_id, user_id, order_id, amount, kind, note)
      values (v_order.class_id, v_order.user_id, v_order.id, v_wrong, 'Refund', '場次取消退款（補退）');
      v_net := v_net + v_wrong;
    end if;

    -- 2) 補退應退的儲值金（舊資料若 wallet_paid 未追蹤，用 PaidWallet 的 prior_paid 推估）
    v_refund := v_order.wallet_paid;
    if v_refund = 0 and v_order.payment_status = 'PaidWallet' then
      v_refund := v_order.prior_paid;
    end if;
    v_refund := v_refund - coalesce(v_net, 0);
    if v_refund > 0 then
      update users set wallet_balance = wallet_balance + v_refund, updated_at = now()
      where id = v_order.user_id;
      insert into transactions (class_id, user_id, order_id, amount, kind, note)
      values (v_order.class_id, v_order.user_id, v_order.id, v_refund, 'Refund', '場次取消退款（補退）');
      v_count := v_count + 1;
    end if;
  end loop;

  raise notice '已補退／修正 % 筆訂單', v_count;
end;
$$;

-- E. 診斷（選用）：檢視仍有疑慮的用戶餘額與取消場次退款紀錄 ----------------------
-- 若執行完上面的補退後，仍有同學餘額異常，可手動用「設定 → 儲值」調整。
--
-- 查看所有取消場次退款交易：
--   select u.seat_no, u.student_name, t.amount, t.note, t.created_at
--   from transactions t join users u on u.id = t.user_id
--   where t.note like '場次取消退款%' order by t.created_at desc;
--
-- 查看「9/15 津川涼麵」場次每筆訂單的退款狀態（確認誰退了、誰漏退）：
--   select s.id as session_id, s.is_deleted as session_deleted, st.name as store,
--          o.id as order_id, u.seat_no, u.student_name,
--          o.total_price, o.wallet_paid, o.prior_paid, o.payment_status,
--          coalesce((select sum(t.amount) from transactions t
--                    where t.order_id = o.id and t.kind = 'Refund' and t.note like '場次取消退款%'), 0) as refunded_net
--   from sessions s
--   join stores st on st.id = s.store_id
--   join orders o on o.session_id = s.id
--   join users u on u.id = o.user_id
--   where st.name like '%津川涼麵%' and s.order_date = '2026-09-15'
--   order by o.id;
