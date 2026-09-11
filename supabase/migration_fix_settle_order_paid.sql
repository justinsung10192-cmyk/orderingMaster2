-- ============================================================================
--  修復：管理員補單（修改既有訂單）後，已繳現金被歸零 → 顯示「全部未繳」
--  原因：fn_settle_order 更新訂單時把 prior_paid 直接設為「本次錢包支付額」，
--        丟掉了先前已繳的現金（prior_paid - wallet_paid）。
--  在 Supabase SQL Editor 執行一次即可（可重複執行）。
-- ============================================================================

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
  v_old_prior_paid numeric := 0;
  v_cash_paid numeric := 0;
  v_new_prior_paid numeric;
  v_new_cash_outstanding numeric;
begin
  select wallet_balance into v_balance
  from users where id = p_user_id and class_id = p_class_id
  for update;
  if v_balance is null then
    raise exception 'USER_NOT_FOUND';
  end if;

  -- 更新訂單：鎖定訂單列並讀取「資料庫內」的 wallet_paid 與 prior_paid
  -- （只退錢包已付、保留已繳現金，避免改單後已繳現金消失）
  if p_order_id is not null then
    select wallet_paid, coalesce(prior_paid, 0) into v_wallet_paid, v_old_prior_paid from orders
    where id = p_order_id and user_id = p_user_id and class_id = p_class_id
    for update;
    if v_wallet_paid is null then
      raise exception 'ORDER_NOT_FOUND';
    end if;
  end if;

  -- 舊單已繳現金（先繳的現金不能因為改單而消失）
  v_cash_paid := v_old_prior_paid - v_wallet_paid;
  if v_cash_paid < 0 then v_cash_paid := 0; end if;

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

  -- 新的已付總額 = 錢包新付 + 已繳現金（不超過新總額）
  v_new_prior_paid := p_wallet_paid + v_cash_paid;
  if v_new_prior_paid > p_total then v_new_prior_paid := p_total; end if;
  v_new_cash_outstanding := p_total - v_new_prior_paid;

  if v_new_cash_outstanding <= 0 then
    if v_cash_paid > 0 then v_status := 'PaidCash'; else v_status := 'PaidWallet'; end if;
  elsif v_new_prior_paid > 0 then
    v_status := 'PartiallyPaid';
  else
    v_status := 'UnpaidCash';
  end if;

  if p_order_id is not null then
    update orders
       set items = p_items, total_price = p_total, prior_paid = v_new_prior_paid, wallet_paid = p_wallet_paid,
           payment_status = v_status, note = p_note, updated_at = now()
     where id = p_order_id
    returning id into v_order_id;
  else
    insert into orders (class_id, session_id, user_id, items, total_price, prior_paid, wallet_paid, payment_status, pickup_status, note)
    values (p_class_id, p_session_id, p_user_id, p_items, p_total, v_new_prior_paid, p_wallet_paid, v_status, 'Pending', p_note)
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
  if v_new_cash_outstanding > 0 then
    insert into transactions (class_id, user_id, order_id, amount, kind, note)
    values (p_class_id, p_user_id, v_order_id, v_new_cash_outstanding, 'Cash', '現金未繳');
  end if;

  return jsonb_build_object(
    'order_id', v_order_id,
    'wallet_balance', v_balance,
    'payment_status', v_status
  );
end;
$$;
