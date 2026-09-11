-- ============================================================================
-- 修正：fn_topup 抵欠款迴圈鎖定訂單列（for update），避免與結帳並發時重複抵銷
-- 效能：新增「未繳訂單查詢」與「歷程紀錄」用的索引
-- 在 Supabase SQL Editor 執行一次即可（可重複執行）。
-- ============================================================================

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
begin
  select wallet_balance into v_balance
  from users where id = p_user_id and class_id = p_class_id
  for update;
  if v_balance is null then
    raise exception 'USER_NOT_FOUND';
  end if;

  for v_order in
    select o.id, o.total_price, o.prior_paid
    from orders o
    where o.class_id = p_class_id and o.user_id = p_user_id
      and o.payment_status in ('UnpaidCash', 'PartiallyPaid')
    order by o.created_at
    for update
  loop
    if v_remaining <= 0 then exit; end if;
    v_outstanding := v_order.total_price - v_order.prior_paid;
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
    'remaining_debt', (select coalesce(sum(o.total_price - o.prior_paid), 0) from orders o
                        where o.class_id = p_class_id and o.user_id = p_user_id
                          and o.payment_status in ('UnpaidCash', 'PartiallyPaid'))
  );
end;
$$;

create index if not exists idx_orders_status on public.orders (class_id, is_deleted, payment_status);
create index if not exists idx_transactions_class on public.transactions (class_id, created_at);
