-- ============================================================================
--  清理殘留的「內訂」場次：每個日期只保留一個（整合後的），其餘刪除
--  用途：整合每日菜單後，可能仍殘留舊的「內訂」場次（重複或已軟刪除），
--        造成排程重複、匯入時 unique 查詢異常。本腳本把同一日期的多個
--        「內訂」場次收斂成一個。
--  在 Supabase SQL Editor 執行一次即可（可重複執行）。
--
--  保留規則：優先「未刪除」且「未刪除訂單最多」的場次（即整合後的那個）；
--            其餘場次的訂單會先搬到保留者（同人重複者刪除來源），再硬刪除。
-- ============================================================================

do $$
declare
  c record;        -- 班級
  r record;        -- 每個有重複場次的日期
  r2 record;       -- 每個待刪除的場次
  internal_id bigint;
  keeper bigint;
begin
  for c in select class_id from public.classes loop
    select id into internal_id from public.stores
     where class_id = c.class_id and name = '內訂' and is_deleted = false
     order by id limit 1;

    -- 針對有「多個」內訂場次的日期
    for r in
      select order_date
        from public.sessions
       where class_id = c.class_id and store_id = internal_id
       group by order_date
      having count(*) > 1
    loop
      -- 保留者：優先「未刪除」、有最多「未刪除訂單」者；其次最早 id
      select id into keeper
        from public.sessions s
       where s.class_id = c.class_id and s.store_id = internal_id and s.order_date = r.order_date
       order by s.is_deleted asc,
                (select count(*) from public.orders o
                  where o.session_id = s.id and coalesce(o.is_deleted, false) = false) desc,
                s.id asc
       limit 1;

      -- 其餘場次：先處理訂單，再硬刪除場次
      for r2 in
        select s.id
          from public.sessions s
         where s.class_id = c.class_id and s.store_id = internal_id and s.order_date = r.order_date
           and s.id <> keeper
      loop
        -- 同人同場次的重複訂單：刪除來源場次裡的重複（保留目標場次的）
        delete from public.orders o
         where o.session_id = r2.id
           and exists (
             select 1 from public.orders o2
              where o2.session_id = keeper and o2.user_id = o.user_id
           );
        -- 其餘訂單搬到保留者
        update public.orders set session_id = keeper where session_id = r2.id;
        -- 清掉殘留訂單後，硬刪除殘留場次
        delete from public.orders where session_id = r2.id;
        delete from public.sessions where id = r2.id;
      end loop;
    end loop;
  end loop;
end;
$$;
