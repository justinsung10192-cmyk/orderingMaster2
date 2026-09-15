-- ============================================================================
-- 全面審查修正（v3.2.x）：帳務／欠費／備份相關
--   1. fn_topup：只抵「已到期（order_date <= 今天）」且未刪除的訂單，未來未到期不抵。
--   2. fn_settle_cash：排除已刪除（is_deleted）訂單，避免誤結幽靈訂單。
--   3. 還原被誤刪的未繳訂單（還原為未刪除，讓管理員仍能看到未繳款）。
-- 在 Supabase SQL Editor 執行一次即可（冪等）。
-- ============================================================================

-- 1. fn_topup（儲值：先抵已到期欠款，剩餘進錢包；不抵未來未到期訂單）----------
create or replace function public.fn_topup(
  p_class_id text,
  p_user_id bigint,
  p_amount numeric
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_balance numeric;
  v_remaining numeric := p_amount;
  v_order record;
  v_outstanding numeric;
  v_applied numeric := 0;
  v_today date := (now() + interval '8 hours')::date;
begin
  select wallet_balance into v_balance
  from users where id = p_user_id and class_id = p_class_id
  for update;
  if v_balance is null then
    raise exception 'USER_NOT_FOUND';
  end if;

  -- 只抵「已到期（order_date <= 今天）」且未刪除的訂單，未來未到期不抵
  for v_order in
    select o.id, o.total_price, o.prior_paid
    from orders o
    join sessions s on s.id = o.session_id
    where o.class_id = p_class_id and o.user_id = p_user_id
      and coalesce(o.is_deleted, false) = false
      and o.payment_status in ('UnpaidCash', 'PartiallyPaid')
      and s.order_date <= v_today
    order by o.created_at
    for update of o
  loop
    if v_remaining <= 0 then exit; end if;
    v_outstanding := v_order.total_price - coalesce(v_order.prior_paid, 0);
    if v_outstanding > 0 then
      if v_remaining >= v_outstanding then
        update orders set prior_paid = total_price, payment_status = 'PaidCash', updated_at = now()
        where id = v_order.id;
        insert into transactions (class_id, user_id, order_id, amount, kind, note)
        values (p_class_id, p_user_id, v_order.id, -v_outstanding, 'Cash', '儲值抵欠款');
        v_remaining := v_remaining - v_outstanding;
        v_applied := v_applied + v_outstanding;
      else
        update orders set prior_paid = prior_paid + v_remaining, payment_status = 'PartiallyPaid', updated_at = now()
        where id = v_order.id;
        insert into transactions (class_id, user_id, order_id, amount, kind, note)
        values (p_class_id, p_user_id, v_order.id, -v_remaining, 'Cash', '儲值抵欠款');
        v_applied := v_applied + v_remaining;
        v_remaining := 0;
      end if;
    end if;
  end loop;

  if v_remaining > 0 then
    v_balance := v_balance + v_remaining;
    update users set wallet_balance = v_balance, updated_at = now()
    where id = p_user_id;
  end if;

  insert into transactions (class_id, user_id, order_id, amount, kind, note)
  values (p_class_id, p_user_id, null, p_amount, 'TopUp', '管理員儲值');

  return jsonb_build_object(
    'wallet_balance', v_balance,
    'applied_to_debt', v_applied,
    'remaining_debt', (select coalesce(sum(o.total_price - coalesce(o.prior_paid, 0)), 0) from orders o
                        join sessions s on s.id = o.session_id
                        where o.class_id = p_class_id and o.user_id = p_user_id
                          and coalesce(o.is_deleted, false) = false
                          and o.payment_status in ('UnpaidCash', 'PartiallyPaid')
                          and s.order_date <= v_today)
  );
end;
$$;

-- 2. fn_settle_cash（排除已刪除訂單，避免誤結幽靈訂單）--------------------------
create or replace function public.fn_settle_cash(
  p_class_id text,
  p_user_id bigint,
  p_order_ids bigint[]
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_order_id bigint;
  v_order record;
  v_outstanding numeric;
  v_total_settled numeric := 0;
begin
  perform 1 from users
  where id = p_user_id and class_id = p_class_id
  for update;

  foreach v_order_id in array p_order_ids loop
    select * into v_order from orders
    where id = v_order_id and user_id = p_user_id and class_id = p_class_id
      and coalesce(is_deleted, false) = false;
    if v_order.id is not null then
      v_outstanding := v_order.total_price - coalesce(v_order.prior_paid, 0);
      if v_outstanding > 0 then
        update orders set prior_paid = total_price, payment_status = 'PaidCash', updated_at = now()
        where id = v_order.id;
        insert into transactions (class_id, user_id, order_id, amount, kind, note)
        values (p_class_id, p_user_id, v_order.id, -v_outstanding, 'Cash', '現金結清');
        v_total_settled := v_total_settled + v_outstanding;
      end if;
    end if;
  end loop;

  return jsonb_build_object('settled', v_total_settled);
end;
$$;

-- 3. 還原被誤刪的未繳訂單：已刪除場次中仍有現金欠款的訂單還原為未刪除------------------
-- （註：先前版本會把這類訂單一併標記刪除，導致「未繳費的被消掉」；
--   本段改為還原，讓管理員仍能看到並收帳，可自行決定是否清理）
update orders o
set is_deleted = false, updated_at = now()
from sessions s
where s.id = o.session_id and s.is_deleted = true
  and o.is_deleted = true
  and (o.total_price - coalesce(o.prior_paid, 0)) > 0;
