-- 修復：退款只退「儲值金（錢包）」已付金額，不把現金算入退款（避免取消場次/刪單時餘額錯誤）
-- 在 Supabase SQL Editor 執行一次即可（可重複執行）。

alter table public.orders add column if not exists wallet_paid numeric(10,2) not null default 0;
update public.orders set wallet_paid = prior_paid where wallet_paid = 0 and prior_paid > 0;

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
  p_note text default ''
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_balance numeric;
  v_status text;
  v_order_id bigint;
  v_wallet_paid numeric := 0;
begin
  select wallet_balance into v_balance
  from users where id = p_user_id and class_id = p_class_id
  for update;
  if v_balance is null then
    raise exception 'USER_NOT_FOUND';
  end if;

  -- 更新訂單：鎖定訂單列並讀取「資料庫內」的 wallet_paid（只退錢包已付，不把現金算入退款）
  if p_order_id is not null then
    select wallet_paid into v_wallet_paid from orders
    where id = p_order_id and user_id = p_user_id and class_id = p_class_id
    for update;
    if v_wallet_paid is null then
      raise exception 'ORDER_NOT_FOUND';
    end if;
  end if;

  -- 純儲值模式：錢包必須足以支付全額，禁止現金欠款
  if p_pure_mode then
    if p_cash_outstanding > 0 then
      raise exception 'PURE_MODE_NO_CASH';
    end if;
    if v_balance + v_wallet_paid < p_wallet_paid then
      raise exception 'INSUFFICIENT_BALANCE';
    end if;
  end if;

  -- 退回舊單的錢包已付金額，再重新扣款
  v_balance := v_balance + v_wallet_paid;

  if p_wallet_paid > 0 then
    if v_balance < p_wallet_paid then
      raise exception 'INSUFFICIENT_BALANCE';
    end if;
    v_balance := v_balance - p_wallet_paid;
  end if;

  update users set wallet_balance = v_balance, updated_at = now()
  where id = p_user_id;

  if p_cash_outstanding > 0 and p_wallet_paid > 0 then
    v_status := 'PartiallyPaid';
  elsif p_cash_outstanding > 0 then
    v_status := 'UnpaidCash';
  else
    v_status := 'PaidWallet';
  end if;

  if p_order_id is not null then
    update orders
       set items = p_items, total_price = p_total, prior_paid = p_wallet_paid, wallet_paid = p_wallet_paid,
           payment_status = v_status, note = p_note, updated_at = now()
     where id = p_order_id
    returning id into v_order_id;
  else
    insert into orders (class_id, session_id, user_id, items, total_price, prior_paid, wallet_paid, payment_status, pickup_status, note)
    values (p_class_id, p_session_id, p_user_id, p_items, p_total, p_wallet_paid, p_wallet_paid, v_status, 'Pending', p_note)
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
  if p_cash_outstanding > 0 then
    insert into transactions (class_id, user_id, order_id, amount, kind, note)
    values (p_class_id, p_user_id, v_order_id, p_cash_outstanding, 'Cash', '現金未繳');
  end if;

  return jsonb_build_object(
    'order_id', v_order_id,
    'wallet_balance', v_balance,
    'payment_status', v_status
  );
end;
$$;

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
  where id = p_order_id and user_id = p_user_id and class_id = p_class_id;
  if v_order.id is null then
    raise exception 'ORDER_NOT_FOUND';
  end if;

  v_refund := coalesce(v_order.wallet_paid, 0);
  v_balance := v_balance + v_refund;

  update users set wallet_balance = v_balance, updated_at = now()
  where id = p_user_id;

  if v_refund > 0 then
    insert into transactions (class_id, user_id, order_id, amount, kind, note)
    values (p_class_id, p_user_id, p_order_id, v_refund, 'Refund', '取消訂單退款');
  end if;

  delete from orders where id = p_order_id;

  return jsonb_build_object('wallet_balance', v_balance, 'refunded', v_refund);
end;
$$;

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
begin
  select * into v_session from sessions where id = p_session_id and class_id = p_class_id for update;
  if v_session.id is null then
    raise exception 'SESSION_NOT_FOUND';
  end if;

  if v_session.is_deleted then
    return jsonb_build_object('ok', true, 'refunded_count', 0);
  end if;

  update sessions set is_deleted = true, closed_at = now() where id = p_session_id;

  for v_order in select * from orders where session_id = p_session_id and (is_deleted is null or is_deleted = false) loop
    v_refund := coalesce(v_order.wallet_paid, 0);

    if v_refund > 0 then
      update users set wallet_balance = wallet_balance + v_refund, updated_at = now()
      where id = v_order.user_id;

      insert into transactions (class_id, user_id, order_id, amount, kind, note)
      values (p_class_id, v_order.user_id, v_order.id, v_refund, 'Refund', '場次取消退款');
    end if;

    update orders set is_deleted = true where id = v_order.id;
    v_refunded_count := v_refunded_count + 1;
  end loop;

  return jsonb_build_object('ok', true, 'refunded_count', v_refunded_count);
end;
$$;