
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
    v_refund := coalesce(v_order.prior_paid, 0);
    
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
