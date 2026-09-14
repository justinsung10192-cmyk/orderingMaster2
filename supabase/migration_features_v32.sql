-- ============================================================================
--  v3.2.0 功能遷移：素食標示、請客、自訂欠費、請假、推薦菜單、更新日誌、部分繳費
--  在 Supabase SQL Editor 依序執行（可重複執行）。
-- ============================================================================

-- 1) 餐點素食標示 ------------------------------------------------------------
alter table public.menu_items add column if not exists is_vegetarian boolean not null default false;

-- 2) 請客（主人設定每人/每單上限金額，超過由收受者自補差價）-----------------
create table if not exists public.treats (
  id            bigint generated always as identity primary key,
  class_id      text not null references public.classes(class_id) on delete cascade,
  host_user_id  bigint not null references public.users(id) on delete cascade,
  title         text not null default '請客',
  cap_amount    numeric(10,2) not null default 0,   -- 每人/每單免費上限（元）
  used_amount   numeric(10,2) not null default 0,   -- 已累計免費金額
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_treats_class on public.treats (class_id, is_active);

-- 3) 訂單加請客欄位 ----------------------------------------------------------
alter table public.orders add column if not exists treat_id bigint references public.treats(id) on delete set null;
alter table public.orders add column if not exists treat_covered numeric(10,2) not null default 0;

-- 4) 自訂欠費（管理員可加/減，正數=欠費，負數=還款或減免）-------------------
create table if not exists public.custom_debts (
  id         bigint generated always as identity primary key,
  class_id   text not null references public.classes(class_id) on delete cascade,
  user_id    bigint not null references public.users(id) on delete cascade,
  amount     numeric(10,2) not null,                 -- 正=欠費增加，負=還款/減免
  note       text not null default '',
  created_by bigint references public.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists idx_custom_debts_user on public.custom_debts (class_id, user_id);

-- 5) 請假申請 ----------------------------------------------------------------
create table if not exists public.leave_requests (
  id           bigint generated always as identity primary key,
  class_id     text not null references public.classes(class_id) on delete cascade,
  user_id      bigint not null references public.users(id) on delete cascade,
  leave_date   date not null,
  reason       text not null default '',
  status       text not null default 'Pending',       -- Pending/Approved/Rejected
  requested_at timestamptz not null default now(),
  resolved_at  timestamptz,
  resolved_by  bigint references public.users(id) on delete set null
);
create index if not exists idx_leave_class on public.leave_requests (class_id, status, leave_date);

-- 6) 使用者推薦菜單（提供店家名稱）-------------------------------------------
create table if not exists public.menu_recommendations (
  id         bigint generated always as identity primary key,
  class_id   text not null references public.classes(class_id) on delete cascade,
  user_id    bigint not null references public.users(id) on delete cascade,
  store_name text not null,
  note       text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists idx_reco_class on public.menu_recommendations (class_id, created_at desc);

-- 7) 更新日誌 -----------------------------------------------------------------
create table if not exists public.changelog (
  id         bigint generated always as identity primary key,
  class_id   text not null default '',                 -- '' = 全域
  version    text not null default '',
  title      text not null default '',
  body       text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists idx_changelog on public.changelog (class_id, created_at desc);

-- 8) 部分繳費（現金，可只繳一部分）------------------------------------------
create or replace function public.fn_partial_pay(
  p_class_id text,
  p_user_id bigint,
  p_order_id bigint,
  p_amount numeric
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_order record;
  v_outstanding numeric;
  v_apply numeric;
  v_new_paid numeric;
begin
  select * into v_order from orders
  where id = p_order_id and user_id = p_user_id and class_id = p_class_id
  for update;
  if v_order.id is null then
    raise exception 'ORDER_NOT_FOUND';
  end if;
  if v_order.is_deleted then
    raise exception 'ORDER_NOT_FOUND';
  end if;

  v_outstanding := coalesce(v_order.total_price, 0) - coalesce(v_order.prior_paid, 0);
  if v_outstanding <= 0 then
    return jsonb_build_object('ok', true, 'applied', 0, 'outstanding', 0, 'payment_status', v_order.payment_status);
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'INVALID_AMOUNT';
  end if;

  v_apply := least(p_amount, v_outstanding);
  v_new_paid := coalesce(v_order.prior_paid, 0) + v_apply;

  if v_new_paid >= v_order.total_price then
    update orders set prior_paid = total_price, payment_status = 'PaidCash', updated_at = now()
    where id = p_order_id;
  else
    update orders set prior_paid = v_new_paid, payment_status = 'PartiallyPaid', updated_at = now()
    where id = p_order_id;
  end if;

  insert into transactions (class_id, user_id, order_id, amount, kind, note)
  values (p_class_id, p_user_id, p_order_id, -v_apply, 'Cash', '部分繳費');

  return jsonb_build_object(
    'ok', true,
    'applied', v_apply,
    'outstanding', round((v_order.total_price - v_new_paid)::numeric, 2),
    'payment_status', (v_new_paid >= v_order.total_price)::boolean
  );
end;
$$;

-- 9) 重建 fn_settle_order：支援請客（treat）----------------------------------
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
  p_note text default '',
  p_treat_id bigint default null,
  p_treat_covered numeric default 0
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_balance numeric;
  v_status text;
  v_order_id bigint;
  v_wallet_paid numeric := 0;
  v_old_prior_paid numeric := 0;
  v_old_treat_id bigint := null;
  v_old_treat_covered numeric := 0;
  v_cash_paid numeric := 0;
  v_new_prior_paid numeric;
  v_new_cash_outstanding numeric;
  v_treat_id bigint := null;
  v_treat_covered numeric := 0;
  v_cap numeric;
  v_used numeric;
  v_remaining numeric;
  v_host_name text;
begin
  select wallet_balance into v_balance
  from users where id = p_user_id and class_id = p_class_id
  for update;
  if v_balance is null then
    raise exception 'USER_NOT_FOUND';
  end if;

  -- 鎖定舊訂單並讀取資料庫內的金流欄位（只退錢包已付、釋放舊請客額度、保留已繳現金）
  if p_order_id is not null then
    select wallet_paid, coalesce(prior_paid, 0), treat_id, coalesce(treat_covered, 0)
    into v_wallet_paid, v_old_prior_paid, v_old_treat_id, v_old_treat_covered
    from orders
    where id = p_order_id and user_id = p_user_id and class_id = p_class_id
    for update;
    if v_wallet_paid is null then
      raise exception 'ORDER_NOT_FOUND';
    end if;
    -- 釋放舊請客額度
    if v_old_treat_id is not null and v_old_treat_covered > 0 then
      update treats set used_amount = greatest(0, used_amount - v_old_treat_covered), updated_at = now()
      where id = v_old_treat_id;
    end if;
  end if;

  -- 舊單已繳現金（先繳的現金不能因為改單而消失）
  v_cash_paid := v_old_prior_paid - v_wallet_paid - v_old_treat_covered;
  if v_cash_paid < 0 then v_cash_paid := 0; end if;

  -- 解析新請客（若指定）：免費額度 = min(需求, 剩餘預算, 訂單總額)
  if p_treat_id is not null then
    select cap_amount, coalesce(used_amount, 0) into v_cap, v_used
    from treats where id = p_treat_id and class_id = p_class_id and is_active = true
    for update;
    if v_cap is null then
      raise exception 'TREAT_NOT_FOUND';
    end if;
    v_remaining := greatest(0, v_cap - v_used);
    v_treat_covered := least(coalesce(p_treat_covered, 0), v_remaining, p_total);
    if v_treat_covered < 0 then v_treat_covered := 0; end if;
    if v_treat_covered > 0 then
      update treats set used_amount = used_amount + v_treat_covered, updated_at = now()
      where id = p_treat_id;
      v_treat_id := p_treat_id;
    end if;
  end if;

  -- 純儲值模式：現金欠款須為 0（請客額度可折抵，其餘須由錢包支付）
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

  -- 新的已付總額 = 錢包新付 + 已繳現金 + 請客免費（不超過新總額）
  v_new_prior_paid := p_wallet_paid + v_cash_paid + v_treat_covered;
  if v_new_prior_paid > p_total then v_new_prior_paid := p_total; end if;
  v_new_cash_outstanding := p_total - v_new_prior_paid;

  if v_new_cash_outstanding <= 0 then
    if v_cash_paid > 0 or v_treat_covered > 0 then v_status := 'PaidCash'; else v_status := 'PaidWallet'; end if;
  elsif v_new_prior_paid > 0 then
    v_status := 'PartiallyPaid';
  else
    v_status := 'UnpaidCash';
  end if;

  if p_order_id is not null then
    update orders
       set items = p_items, total_price = p_total, prior_paid = v_new_prior_paid, wallet_paid = p_wallet_paid,
           payment_status = v_status, note = p_note, treat_id = v_treat_id, treat_covered = v_treat_covered,
           updated_at = now()
     where id = p_order_id
    returning id into v_order_id;
  else
    insert into orders (class_id, session_id, user_id, items, total_price, prior_paid, wallet_paid, payment_status, pickup_status, note, treat_id, treat_covered)
    values (p_class_id, p_session_id, p_user_id, p_items, p_total, v_new_prior_paid, p_wallet_paid, v_status, 'Pending', p_note, v_treat_id, v_treat_covered)
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
  if v_treat_covered > 0 then
    select coalesce(u.student_name, '') into v_host_name from users u where u.id = (select host_user_id from treats where id = v_treat_id);
    insert into transactions (class_id, user_id, order_id, amount, kind, note)
    values (p_class_id, p_user_id, v_order_id, -v_treat_covered, 'Treat', coalesce(v_host_name, '同學') || ' 請客折抵');
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

-- 10) 種子更新日誌 ------------------------------------------------------------
insert into public.changelog (class_id, version, title, body)
values
('', 'v3.2.0', '請客／請假／推薦菜單／自訂欠費',
 '新增：請客功能（設定上限、超出自補差價、免費統計）、請假取消（9:00 前申請、管理員批准後退費）、使用者推薦菜單、自訂欠費（管理員）、部分繳費、素食標示、AI 圖片辨識設定、可拉動捲軸、師長帳號、載入動畫。'),
('', 'v3.1.0', '行事曆與通知優化',
 '新增班級行事曆（AI 辨識、歷史紀錄、過期收合）、全服通知、台灣時間顯示、補單修正。'),
('', 'v3.0.0', 'AI 菜單辨識與每日菜單',
 '智慧菜單辨識（必選/可選選項、飲料甜度冰量）、每日菜單整合內訂、一鍵公布本週。')
on conflict do nothing;
