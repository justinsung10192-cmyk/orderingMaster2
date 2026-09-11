-- ============================================================================
--  最終清理：徹底清除殘留的「原內訂場次」與每日菜單廠商店家
--  說明：先前的整合腳本「先搬品項、後合併場次」，導致搬完品項後，廠商店家
--        已無日期品項，場次合併的判斷（exists 日期品項）全部落空，殘留了一堆
--        廠商場次。本腳本以「店家是否已無一般品項」來判斷純每日菜單廠商，
--        徹底收斂並清除。
--  在 Supabase SQL Editor 執行一次即可（可重複執行）。
-- ============================================================================

do $$
declare
  c record;      -- 班級
  r record;      -- 待處理的品項/場次/日期
  r2 record;     -- 待刪除的場次
  internal_id bigint;
  keeper bigint;
begin
  for c in select class_id from public.classes loop
    -- 1) 確保「內訂」店家存在（舊的「每日菜單」直接改名）
    select id into internal_id from public.stores
     where class_id = c.class_id and name = '內訂' and is_deleted = false
     order by id limit 1;
    if internal_id is null then
      update public.stores set name = '內訂'
       where class_id = c.class_id and name = '每日菜單' and is_deleted = false
         and not exists (select 1 from public.stores where class_id = c.class_id and name = '內訂');
      select id into internal_id from public.stores
       where class_id = c.class_id and name = '內訂' and is_deleted = false
       order by id limit 1;
    end if;
    if internal_id is null then
      insert into public.stores (class_id, name, is_active, is_deleted, sort_order)
      values (c.class_id, '內訂', true, false, 999) returning id into internal_id;
    end if;

    -- 2) 把殘留的日期品項搬到「內訂」（名稱加「店家-」前綴）
    for r in
      select mi.id, mi.name, mi.menu_date, s.name as store_name
        from public.menu_items mi join public.stores s on s.id = mi.store_id
       where mi.class_id = c.class_id and mi.menu_date <> '1970-01-01' and mi.store_id <> internal_id
    loop
      delete from public.menu_items
       where class_id = c.class_id and store_id = internal_id and menu_date = r.menu_date
         and name = (r.store_name || '-' || r.name);
      update public.menu_items set store_id = internal_id, name = (r.store_name || '-' || r.name) where id = r.id;
    end loop;

    -- 3) 合併「純每日菜單廠商」（已無一般品項）的場次到「內訂」
    for r in
      select s.id, s.store_id, s.order_date
        from public.sessions s
       where s.class_id = c.class_id and s.store_id <> internal_id and s.is_deleted = false
         and not exists (
           select 1 from public.menu_items mi
            where mi.store_id = s.store_id and (mi.menu_date = '1970-01-01')
         )
    loop
      select id into keeper from public.sessions
       where class_id = c.class_id and store_id = internal_id and order_date = r.order_date and is_deleted = false
       order by id limit 1;
      if keeper is null then
        -- 內訂尚無該日場次：直接把這個場次改成內訂
        update public.sessions set store_id = internal_id where id = r.id;
      else
        -- 同人同場次的重複訂單：刪除來源（保留目標）
        delete from public.orders o
         where o.session_id = r.id and exists (
           select 1 from public.orders o2 where o2.session_id = keeper and o2.user_id = o.user_id
         );
        update public.orders set session_id = keeper where session_id = r.id;
        delete from public.orders where session_id = r.id;
        delete from public.sessions where id = r.id;
      end if;
    end loop;

    -- 4) 去重複：每個日期只保留一個「內訂」場次
    for r in
      select order_date from public.sessions
       where class_id = c.class_id and store_id = internal_id
       group by order_date having count(*) > 1
    loop
      select id into keeper from public.sessions s
       where s.class_id = c.class_id and s.store_id = internal_id and s.order_date = r.order_date
       order by s.is_deleted asc,
                (select count(*) from public.orders o where o.session_id = s.id and coalesce(o.is_deleted, false) = false) desc,
                s.id asc limit 1;
      for r2 in
        select s.id from public.sessions s
         where s.class_id = c.class_id and s.store_id = internal_id and s.order_date = r.order_date and s.id <> keeper
      loop
        delete from public.orders o
         where o.session_id = r2.id and exists (
           select 1 from public.orders o2 where o2.session_id = keeper and o2.user_id = o.user_id
         );
        update public.orders set session_id = keeper where session_id = r2.id;
        delete from public.orders where session_id = r2.id;
        delete from public.sessions where id = r2.id;
      end loop;
    end loop;

    -- 5) 軟刪除「已無品項、也無場次」的廠商店家
    for r in
      select s.id from public.stores s
       where s.class_id = c.class_id and s.id <> internal_id and s.is_deleted = false
         and not exists (select 1 from public.menu_items mi where mi.store_id = s.id)
         and not exists (select 1 from public.sessions se where se.store_id = s.id and se.is_deleted = false)
    loop
      update public.stores set is_deleted = true, is_active = false where id = r.id;
    end loop;
  end loop;
end;
$$;
