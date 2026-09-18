-- ============================================================================
-- 錢包系統修正：結清欠費時，優先以「錢包餘額」主動扣抵，不足部分才收現金。
-- 在 Supabase SQL Editor 執行一次即可（可重複執行）。
-- ============================================================================

create or replace function public.fn_settle_cash(
  p_class_id text,
  p_user_id bigint,
  p_order_ids bigint[]
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_balance numeric;
  v_order_id bigint;
  v_order record;
  v_outstanding numeric;
  v_wallet_use numeric;
  v_cash numeric;
  v_total_settled numeric := 0;
  v_wallet_used numeric := 0;
begin
  select wallet_balance into v_balance
  from users where id = p_user_id and class_id = p_class_id
  for update;
  if v_balance is null then raise exception 'USER_NOT_FOUND'; end if;

  foreach v_order_id in array p_order_ids loop
    select * into v_order from orders
    where id = v_order_id and user_id = p_user_id and class_id = p_class_id
      and coalesce(is_deleted, false) = false;
    if v_order.id is not null then
      v_outstanding := v_order.total_price - coalesce(v_order.prior_paid, 0);
      if v_outstanding > 0 then
        -- 主動以錢包餘額抵欠費，不足部分才以現金結清
        v_wallet_use := least(v_balance, v_outstanding);
        if v_wallet_use < 0 then v_wallet_use := 0; end if;
        v_cash := v_outstanding - v_wallet_use;

        if v_wallet_use > 0 then
          v_balance := v_balance - v_wallet_use;
          v_wallet_used := v_wallet_used + v_wallet_use;
          insert into transactions (class_id, user_id, order_id, amount, kind, note)
          values (p_class_id, p_user_id, v_order.id, -v_wallet_use, 'Wallet', '餘額抵欠費');
        end if;

        if v_cash > 0 then
          insert into transactions (class_id, user_id, order_id, amount, kind, note)
          values (p_class_id, p_user_id, v_order.id, -v_cash, 'Cash', '現金結清');
        end if;

        update orders
        set prior_paid = total_price,
            wallet_paid = coalesce(wallet_paid, 0) + v_wallet_use,
            payment_status = case when v_cash > 0 then 'PaidCash' else 'PaidWallet' end,
            updated_at = now()
        where id = v_order.id;

        v_total_settled := v_total_settled + v_outstanding;
      end if;
    end if;
  end loop;

  update users set wallet_balance = v_balance, updated_at = now()
  where id = p_user_id;

  return jsonb_build_object('settled', v_total_settled, 'wallet_used', v_wallet_used);
end;
$$;
