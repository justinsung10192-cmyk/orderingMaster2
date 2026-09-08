-- 修復：fn_settle_order 並發重複退款（TOCTOU）
-- 在 Supabase SQL Editor 執行一次即可（可重複執行）。

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
  v_prior_paid numeric := 0;
begin
  select wallet_balance into v_balance
  from users where id = p_user_id and class_id = p_class_id
  for update;
  if v_balance is null then
    raise exception 'USER_NOT_FOUND';
  end if;

  -- 更新訂單時：鎖定訂單列並讀取「資料庫內」的 prior_paid（不信任呼叫端傳值），
  -- 避免並發修改造成重複退款（TOCTOU）。新增時 v_prior_paid 保持 0。
  if p_order_id is not null then
    select prior_paid into v_prior_paid from orders
    where id = p_order_id and user_id = p_user_id and class_id = p_class_id
    for update;
    if v_prior_paid is null then
      raise exception 'ORDER_NOT_FOUND';
    end if;
  end if;

  -- 純儲值模式：錢包必須足以支付全額，禁止現金欠款
  if p_pure_mode then
    if p_cash_outstanding > 0 then
      raise exception 'PURE_MODE_NO_CASH';
    end if;
    if v_balance + v_prior_paid < p_wallet_paid then
      raise exception 'INSUFFICIENT_BALANCE';
    end if;
  end if;

  -- 退回原單實際已付金額，再重新結算
  v_balance := v_balance + v_prior_paid;

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
       set items = p_items, total_price = p_total, prior_paid = p_wallet_paid,
           payment_status = v_status, note = p_note, updated_at = now()
     where id = p_order_id
    returning id into v_order_id;
  else
    insert into orders (class_id, session_id, user_id, items, total_price, prior_paid, payment_status, pickup_status, note)
    values (p_class_id, p_session_id, p_user_id, p_items, p_total, p_wallet_paid, v_status, 'Pending', p_note)
    returning id into v_order_id;
  end if;

  if v_prior_paid > 0 then
    insert into transactions (class_id, user_id, order_id, amount, kind, note)
    values (p_class_id, p_user_id, v_order_id, v_prior_paid, 'Refund', '訂單修改退款');
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
