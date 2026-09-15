-- ============================================================================
-- 修正退款金額：取消訂單／取消場次時，退還「學生實際支付」的金額。
--   實際支付 = prior_paid（儲值金＋現金）− treat_covered（請客免費額度）
-- 先前版本只退「儲值金（wallet_paid）」，導致「已用現金繳費」的訂單被取消後
-- 沒有任何退款。本版本修正為完整退還（現金部分以錢包餘額方式退回）。
-- 在 Supabase SQL Editor 執行一次即可（冪等，create or replace）。
-- ============================================================================

-- 1. 單筆取消訂單退款 ---------------------------------------------------------
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

  -- 退還「學生實際支付」：已付總額（儲值金＋現金）− 請客免費額度
  v_refund := coalesce(v_order.prior_paid, 0) - coalesce(v_order.treat_covered, 0);
  if v_refund < 0 then v_refund := 0; end if;

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

-- 2. 取消場次退款 -------------------------------------------------------------
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

  -- 逐筆訂單：全部標記刪除；退還「學生實際支付」（儲值金＋現金，排除請客免費額度）
  for v_order in
    select * from orders
    where session_id = p_session_id
      and coalesce(is_deleted, false) = false
    order by id
    for update
  loop
    v_refund := coalesce(v_order.prior_paid, 0) - coalesce(v_order.treat_covered, 0);
    if v_refund < 0 then v_refund := 0; end if;

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
