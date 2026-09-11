-- ============================================================================
--  整合既有「每日菜單」資料到「內訂」店家（品項 + 場次 + 訂單）
--  用途：先前每日菜單可能是以「各廠商分開店家（如正園、米寶）」的方式排程，
--        本腳本把它們全部集中到單一「內訂」店家，每天一個場次。
--  在 Supabase SQL Editor 執行一次即可（可重複執行）。
--
--  注意：
--  1. 品項名稱會加「店家-」前綴（例：正園-B餐）；原本就在「內訂」的品項不受影響。
--  2. 同一天的多個場次會合併成一個「內訂」場次；若同一同學在合併前於不同廠商
--     場次各有一筆訂單，會保留「內訂」場次的那一筆、刪除重複（此為極少數情況）。
--  3. 合併後若留下空的廠商店家，可在後台「菜單」用刪除功能手動移除。
-- ============================================================================

do $$
declare
  c record;               -- 班級
  internal_id bigint;     -- 該班「內訂」店家 id
  old_internal_id bigint; -- 舊的「每日菜單」店家 id（若有）
  r record;
  target_session bigint;
begin
  for c in select class_id from public.classes loop

    -- 1) 確保「內訂」店家存在；若只有舊的「每日菜單」，直接改名為「內訂」
    select id into internal_id from public.stores
     where class_id = c.class_id and name = '內訂' and is_deleted = false
     order by id limit 1;

    if internal_id is null then
      select id into old_internal_id from public.stores
       where class_id = c.class_id and name = '每日菜單' and is_deleted = false
       order by id limit 1;
      if old_internal_id is not null then
        update public.stores set name = '內訂' where id = old_internal_id;
        internal_id := old_internal_id;
      else
        insert into public.stores (class_id, name, is_active, is_deleted, sort_order)
        values (c.class_id, '內訂', true, false, 999)
        returning id into internal_id;
      end if;
    end if;

    -- 2) 把其他店家的「日期品項」搬進「內訂」（名稱加「店家-」前綴）
    for r in
      select mi.id, mi.name, mi.menu_date, s.name as store_name
        from public.menu_items mi
        join public.stores s on s.id = mi.store_id
       where mi.class_id = c.class_id
         and mi.menu_date <> '1970-01-01'
         and mi.store_id <> internal_id
    loop
      -- 若「內訂」已有同名同日期品項，先刪掉舊的避免衝突
      delete from public.menu_items
       where class_id = c.class_id and store_id = internal_id
         and name = (r.store_name || '-' || r.name) and menu_date = r.menu_date;

      update public.menu_items
         set store_id = internal_id,
             name = r.store_name || '-' || r.name
       where id = r.id;
    end loop;

    -- 3) 合併場次到「內訂」（同一日期一個場次）
    for r in
      select s.id, s.store_id, s.order_date
        from public.sessions s
       where s.class_id = c.class_id
         and s.store_id <> internal_id
         and s.is_deleted = false
         and exists (
           select 1 from public.menu_items mi
            where mi.store_id = s.store_id and mi.menu_date = s.order_date
              and mi.menu_date <> '1970-01-01'
         )
    loop
      select id into target_session from public.sessions
       where class_id = c.class_id and store_id = internal_id
         and order_date = r.order_date and is_deleted = false
       order by id limit 1;

      if target_session is null then
        -- 「內訂」尚無該日場次：直接把這個場次改成「內訂」
        update public.sessions set store_id = internal_id where id = r.id;
      else
        -- 同人同場次的重複訂單：刪除來源場次裡的重複（保留目標場次的）
        delete from public.orders o
         where o.session_id = r.id
           and exists (
             select 1 from public.orders o2
              where o2.session_id = target_session and o2.user_id = o.user_id
           );
        -- 其餘訂單搬到目標場次
        update public.orders set session_id = target_session where session_id = r.id;
        -- 軟刪除舊場次
        update public.sessions set is_deleted = true, closed_at = now() where id = r.id;
      end if;
    end loop;

  end loop;
end;
$$;
