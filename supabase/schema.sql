-- ============================================================================
--  班級訂餐管理系統 (Class Meal Ordering PWA) — Supabase / PostgreSQL Schema
--  在 Supabase 專案的「SQL Editor」整段貼上並執行即可（可重複執行）。
--  資料存取一律經由伺服器端 service_role（api/），RLS 不影響安全。
--
--  ⚠️ 重要：請在「全新的 Supabase 專案」執行本檔。
--     若你曾在同一個專案執行過舊版 schema（v2 商家/學校/開發者版），
--     先執行下方註解掉的 drop 段落清空舊表，再執行本檔。
-- ============================================================================

-- ===== 清除舊版資料表（從舊版 v2 升級時，取消註解並執行一次）=====
-- drop table if exists public.class_admin_applications cascade;
-- drop table if exists public.item_options cascade;
-- drop table if exists public.menu_items cascade;
-- drop table if exists public.stores cascade;
-- drop table if exists public.sessions cascade;
-- drop table if exists public.orders cascade;
-- drop table if exists public.transactions cascade;
-- drop table if exists public.verification_records cascade;
-- drop table if exists public.votes cascade;
-- drop table if exists public.holidays cascade;
-- drop table if exists public.invite_codes cascade;
-- drop table if exists public.class_admin_codes cascade;
-- drop table if exists public.push_subscriptions cascade;
-- drop table if exists public.auth_tokens cascade;
-- drop table if exists public.users cascade;
-- drop table if exists public.classes cascade;
-- drop table if exists public.merchants cascade;
-- drop table if exists public.schools cascade;
-- drop table if exists public.developers cascade;
-- drop table if exists public.app_settings cascade;

-- 啟用擴充：pg_cron（排程）＋ pg_net（排程呼叫 HTTP 端點）
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 班級（單一班級；純儲值模式開關放這裡）----------------------------------------
create table if not exists public.classes (
  id                bigint generated always as identity primary key,
  class_id          text not null unique,
  name              text not null default '三年甲班',
  pure_balance_mode boolean not null default false,   -- true = 純儲值模式（餘額不足禁止下單）
  created_at        timestamptz not null default now()
);

-- 帳號 ----------------------------------------------------------------------
create table if not exists public.users (
  id                   bigint generated always as identity primary key,
  class_id             text not null references public.classes(class_id) on delete cascade,
  student_no           text not null,
  seat_no              text not null default '',
  student_name         text not null,
  email                text not null default '',
  password_hash        text not null,
  salt                 text not null,
  role                 text not null default 'Student',   -- 'Student' | 'Admin'
  wallet_balance       numeric(10,2) not null default 0,
  is_disabled          boolean not null default false,
  must_change_password boolean not null default false,    -- 首次登入強制改密碼/姓名
  auth_version         int not null default 0,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (class_id, student_no)
);
create index if not exists idx_users_class on public.users (class_id);
create index if not exists idx_users_role on public.users (class_id, role);

-- 店家 ----------------------------------------------------------------------
create table if not exists public.stores (
  id         bigint generated always as identity primary key,
  class_id   text not null references public.classes(class_id) on delete cascade,
  name       text not null,
  is_active  boolean not null default true,
  is_deleted boolean not null default false,   -- 軟刪除：避免破壞既有場次/訂單外鍵
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  unique (class_id, name)
);
create index if not exists idx_stores_class on public.stores (class_id);
-- 既有資料庫升級用：補上 is_deleted 欄位（全新專案可略過）
alter table public.stores add column if not exists is_deleted boolean not null default false;

-- 餐點（客製選項直接內嵌為 jsonb，支援「甜度/冰塊/加料」與加價）------------------
create table if not exists public.menu_items (
  id         bigint generated always as identity primary key,
  class_id   text not null references public.classes(class_id) on delete cascade,
  store_id   bigint not null references public.stores(id) on delete cascade,
  name       text not null,
  price      numeric(10,2) not null default 0,
  options    jsonb not null default '[]',   -- [{"name":"加珍珠","price":5}, ...]
  is_active  boolean not null default true,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  unique (class_id, store_id, name)
);
create index if not exists idx_menu_items_store on public.menu_items (store_id);

-- 訂餐場次（一天可多場次；個別場次各自有截止時間）--------------------------------
create table if not exists public.sessions (
  id                    bigint generated always as identity primary key,
  class_id              text not null references public.classes(class_id) on delete cascade,
  store_id              bigint not null references public.stores(id),
  order_date            date not null,
  cutoff_time           timestamptz not null,
  week_label            text not null default '',          -- 例：'2026-W37'（ISO 週）
  is_open               boolean not null default false,    -- false=草稿, true=已公布
  is_deleted            boolean not null default false,
  cutoff_reminder_sent  boolean not null default false,
  start_notice_sent     boolean not null default false,
  created_at            timestamptz not null default now(),
  closed_at             timestamptz
);
create index if not exists idx_sessions_class_date on public.sessions (class_id, order_date);
create index if not exists idx_sessions_week on public.sessions (class_id, week_label);
create index if not exists idx_sessions_cutoff on public.sessions (cutoff_time);

-- 放假日期（標記後當天不訂餐）--------------------------------------------------
create table if not exists public.holidays (
  id           bigint generated always as identity primary key,
  class_id     text not null references public.classes(class_id) on delete cascade,
  holiday_date date not null,
  note         text not null default '',
  created_at   timestamptz not null default now(),
  unique (class_id, holiday_date)
);
create index if not exists idx_holidays_class on public.holidays (class_id);

-- 訂單 ----------------------------------------------------------------------
create table if not exists public.orders (
  id             bigint generated always as identity primary key,
  class_id       text not null references public.classes(class_id) on delete cascade,
  session_id     bigint not null references public.sessions(id),
  user_id        bigint references public.users(id) on delete set null,
  items          jsonb not null default '[]',
  total_price    numeric(10,2) not null default 0,
  prior_paid     numeric(10,2) not null default 0,         -- 已由儲值金支付
  payment_status text not null default 'UnpaidCash',
  is_deleted     boolean not null default false,
  pickup_status  text not null default 'Pending',
  note           text not null default '',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (session_id, user_id)
);
create index if not exists idx_orders_session on public.orders (session_id);
create index if not exists idx_orders_user on public.orders (user_id);

-- 交易帳目 ------------------------------------------------------------------
create table if not exists public.transactions (
  id         bigint generated always as identity primary key,
  class_id   text not null references public.classes(class_id) on delete cascade,
  user_id    bigint references public.users(id) on delete set null,
  order_id   bigint references public.orders(id) on delete set null,
  amount     numeric(10,2) not null,                        -- 正=入帳, 負=扣款
  kind       text not null,                                 -- TopUp/Wallet/Cash/Refund/Manual
  note       text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists idx_transactions_user on public.transactions (user_id, created_at);

-- QR / PIN 核銷憑證（每位使用者 x 場次，產生臨時 QR 與 4 位 PIN）------------------
create table if not exists public.verification_records (
  id          bigint generated always as identity primary key,
  class_id    text not null references public.classes(class_id) on delete cascade,
  session_id  bigint references public.sessions(id) on delete set null,
  user_id     bigint references public.users(id) on delete set null,
  payload     text not null,                                -- QR 內容（JSON 字串）
  pin_hash    text not null default '',                     -- 4 位 PIN 的 sha256
  status      text not null default 'Pending',              -- Pending/Resolved
  expires_at  timestamptz not null,
  resolved_at timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists idx_verification_user on public.verification_records (user_id, status, expires_at);
create index if not exists idx_verification_pin on public.verification_records (pin_hash) where status = 'Pending';

-- 下週店家許願投票（每人每週 3 票）---------------------------------------------
create table if not exists public.votes (
  id         bigint generated always as identity primary key,
  class_id   text not null references public.classes(class_id) on delete cascade,
  user_id    bigint not null references public.users(id) on delete cascade,
  store_id   bigint not null references public.stores(id) on delete cascade,
  week_label text not null,
  created_at timestamptz not null default now(),
  unique (class_id, user_id, store_id, week_label)
);
create index if not exists idx_votes_week on public.votes (class_id, week_label);

-- 登入 Session Token（資料庫只存雜湊）-----------------------------------------
create table if not exists public.auth_tokens (
  id         bigint generated always as identity primary key,
  class_id   text not null default '',
  user_id    bigint references public.users(id) on delete cascade,
  type       text not null,
  token_hash text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_auth_tokens_hash on public.auth_tokens (token_hash);

-- Web Push 訂閱 --------------------------------------------------------------
create table if not exists public.push_subscriptions (
  id           bigint generated always as identity primary key,
  class_id     text not null default '',
  user_id      bigint references public.users(id) on delete cascade,
  endpoint     text not null unique,
  p256dh       text not null,
  auth         text not null,
  device_label text not null default '',
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

-- 系統設定（鍵值）--------------------------------------------------------------
create table if not exists public.app_settings (
  id       bigint generated always as identity primary key,
  class_id text not null default '',
  key      text not null,
  value    text not null default '',
  unique (class_id, key)
);

-- ============================================================================
-- 種子資料：建立 demo 班級 + 37 組預設帳號
-- 預設密碼一律為「lunch1234」，首次登入強制修改密碼與姓名。
-- 座號 01 預設為管理員（保證系統至少有一位管理者）。
-- ============================================================================

insert into public.classes (class_id, name, pure_balance_mode)
values ('demo', '三年甲班', false)
on conflict (class_id) do nothing;

-- 固定 salt 與 PBKDF2-SHA256(100000 次) 雜湊（密碼 = lunch1234）
insert into public.users
  (class_id, student_no, seat_no, student_name, email, password_hash, salt, role, wallet_balance, is_disabled, must_change_password)
values
('demo','01','01','同學01','','ebcc41fc7a43d42d6b6b61b1817574e0ec01880db44ae9a58c926b883d03e537','3f9c2e7a1b5d8f0e6a4c2b8d9e7f1a3c','Student',0,false,true),
('demo','02','02','同學02','','ebcc41fc7a43d42d6b6b61b1817574e0ec01880db44ae9a58c926b883d03e537','3f9c2e7a1b5d8f0e6a4c2b8d9e7f1a3c','Student',0,false,true),
('demo','03','03','同學03','','ebcc41fc7a43d42d6b6b61b1817574e0ec01880db44ae9a58c926b883d03e537','3f9c2e7a1b5d8f0e6a4c2b8d9e7f1a3c','Student',0,false,true),
('demo','04','04','同學04','','ebcc41fc7a43d42d6b6b61b1817574e0ec01880db44ae9a58c926b883d03e537','3f9c2e7a1b5d8f0e6a4c2b8d9e7f1a3c','Student',0,false,true),
('demo','05','05','同學05','','ebcc41fc7a43d42d6b6b61b1817574e0ec01880db44ae9a58c926b883d03e537','3f9c2e7a1b5d8f0e6a4c2b8d9e7f1a3c','Admin',0,false,true),
('demo','06','06','同學06','','ebcc41fc7a43d42d6b6b61b1817574e0ec01880db44ae9a58c926b883d03e537','3f9c2e7a1b5d8f0e6a4c2b8d9e7f1a3c','Student',0,false,true),
('demo','07','07','同學07','','ebcc41fc7a43d42d6b6b61b1817574e0ec01880db44ae9a58c926b883d03e537','3f9c2e7a1b5d8f0e6a4c2b8d9e7f1a3c','Student',0,false,true),
('demo','08','08','同學08','','ebcc41fc7a43d42d6b6b61b1817574e0ec01880db44ae9a58c926b883d03e537','3f9c2e7a1b5d8f0e6a4c2b8d9e7f1a3c','Student',0,false,true),
('demo','09','09','同學09','','ebcc41fc7a43d42d6b6b61b1817574e0ec01880db44ae9a58c926b883d03e537','3f9c2e7a1b5d8f0e6a4c2b8d9e7f1a3c','Student',0,false,true),
('demo','10','10','同學10','','ebcc41fc7a43d42d6b6b61b1817574e0ec01880db44ae9a58c926b883d03e537','3f9c2e7a1b5d8f0e6a4c2b8d9e7f1a3c','Student',0,false,true),
('demo','11','11','同學11','','ebcc41fc7a43d42d6b6b61b1817574e0ec01880db44ae9a58c926b883d03e537','3f9c2e7a1b5d8f0e6a4c2b8d9e7f1a3c','Student',0,false,true),
('demo','12','12','同學12','','ebcc41fc7a43d42d6b6b61b1817574e0ec01880db44ae9a58c926b883d03e537','3f9c2e7a1b5d8f0e6a4c2b8d9e7f1a3c','Student',0,false,true),
('demo','13','13','同學13','','ebcc41fc7a43d42d6b6b61b1817574e0ec01880db44ae9a58c926b883d03e537','3f9c2e7a1b5d8f0e6a4c2b8d9e7f1a3c','Student',0,false,true),
('demo','14','14','同學14','','ebcc41fc7a43d42d6b6b61b1817574e0ec01880db44ae9a58c926b883d03e537','3f9c2e7a1b5d8f0e6a4c2b8d9e7f1a3c','Student',0,false,true),
('demo','15','15','同學15','','ebcc41fc7a43d42d6b6b61b1817574e0ec01880db44ae9a58c926b883d03e537','3f9c2e7a1b5d8f0e6a4c2b8d9e7f1a3c','Student',0,false,true),
('demo','16','16','同學16','','ebcc41fc7a43d42d6b6b61b1817574e0ec01880db44ae9a58c926b883d03e537','3f9c2e7a1b5d8f0e6a4c2b8d9e7f1a3c','Student',0,false,true),
('demo','17','17','同學17','','ebcc41fc7a43d42d6b6b61b1817574e0ec01880db44ae9a58c926b883d03e537','3f9c2e7a1b5d8f0e6a4c2b8d9e7f1a3c','Student',0,false,true),
('demo','18','18','同學18','','ebcc41fc7a43d42d6b6b61b1817574e0ec01880db44ae9a58c926b883d03e537','3f9c2e7a1b5d8f0e6a4c2b8d9e7f1a3c','Student',0,false,true),
('demo','19','19','同學19','','ebcc41fc7a43d42d6b6b61b1817574e0ec01880db44ae9a58c926b883d03e537','3f9c2e7a1b5d8f0e6a4c2b8d9e7f1a3c','Student',0,false,true),
('demo','20','20','同學20','','ebcc41fc7a43d42d6b6b61b1817574e0ec01880db44ae9a58c926b883d03e537','3f9c2e7a1b5d8f0e6a4c2b8d9e7f1a3c','Student',0,false,true),
('demo','21','21','同學21','','ebcc41fc7a43d42d6b6b61b1817574e0ec01880db44ae9a58c926b883d03e537','3f9c2e7a1b5d8f0e6a4c2b8d9e7f1a3c','Student',0,false,true),
('demo','22','22','同學22','','ebcc41fc7a43d42d6b6b61b1817574e0ec01880db44ae9a58c926b883d03e537','3f9c2e7a1b5d8f0e6a4c2b8d9e7f1a3c','Student',0,false,true),
('demo','23','23','同學23','','ebcc41fc7a43d42d6b6b61b1817574e0ec01880db44ae9a58c926b883d03e537','3f9c2e7a1b5d8f0e6a4c2b8d9e7f1a3c','Student',0,false,true),
('demo','24','24','同學24','','ebcc41fc7a43d42d6b6b61b1817574e0ec01880db44ae9a58c926b883d03e537','3f9c2e7a1b5d8f0e6a4c2b8d9e7f1a3c','Student',0,false,true),
('demo','25','25','同學25','','ebcc41fc7a43d42d6b6b61b1817574e0ec01880db44ae9a58c926b883d03e537','3f9c2e7a1b5d8f0e6a4c2b8d9e7f1a3c','Student',0,false,true),
('demo','26','26','同學26','','ebcc41fc7a43d42d6b6b61b1817574e0ec01880db44ae9a58c926b883d03e537','3f9c2e7a1b5d8f0e6a4c2b8d9e7f1a3c','Student',0,false,true),
('demo','27','27','同學27','','ebcc41fc7a43d42d6b6b61b1817574e0ec01880db44ae9a58c926b883d03e537','3f9c2e7a1b5d8f0e6a4c2b8d9e7f1a3c','Student',0,false,true),
('demo','28','28','同學28','','ebcc41fc7a43d42d6b6b61b1817574e0ec01880db44ae9a58c926b883d03e537','3f9c2e7a1b5d8f0e6a4c2b8d9e7f1a3c','Student',0,false,true),
('demo','29','29','同學29','','ebcc41fc7a43d42d6b6b61b1817574e0ec01880db44ae9a58c926b883d03e537','3f9c2e7a1b5d8f0e6a4c2b8d9e7f1a3c','Student',0,false,true),
('demo','30','30','同學30','','ebcc41fc7a43d42d6b6b61b1817574e0ec01880db44ae9a58c926b883d03e537','3f9c2e7a1b5d8f0e6a4c2b8d9e7f1a3c','Student',0,false,true),
('demo','31','31','同學31','','ebcc41fc7a43d42d6b6b61b1817574e0ec01880db44ae9a58c926b883d03e537','3f9c2e7a1b5d8f0e6a4c2b8d9e7f1a3c','Student',0,false,true),
('demo','32','32','同學32','','ebcc41fc7a43d42d6b6b61b1817574e0ec01880db44ae9a58c926b883d03e537','3f9c2e7a1b5d8f0e6a4c2b8d9e7f1a3c','Student',0,false,true),
('demo','33','33','同學33','','ebcc41fc7a43d42d6b6b61b1817574e0ec01880db44ae9a58c926b883d03e537','3f9c2e7a1b5d8f0e6a4c2b8d9e7f1a3c','Student',0,false,true),
('demo','34','34','同學34','','ebcc41fc7a43d42d6b6b61b1817574e0ec01880db44ae9a58c926b883d03e537','3f9c2e7a1b5d8f0e6a4c2b8d9e7f1a3c','Student',0,false,true),
('demo','35','35','同學35','','ebcc41fc7a43d42d6b6b61b1817574e0ec01880db44ae9a58c926b883d03e537','3f9c2e7a1b5d8f0e6a4c2b8d9e7f1a3c','Student',0,false,true),
('demo','36','36','同學36','','ebcc41fc7a43d42d6b6b61b1817574e0ec01880db44ae9a58c926b883d03e537','3f9c2e7a1b5d8f0e6a4c2b8d9e7f1a3c','Student',0,false,true),
('demo','37','37','同學37','','ebcc41fc7a43d42d6b6b61b1817574e0ec01880db44ae9a58c926b883d03e537','3f9c2e7a1b5d8f0e6a4c2b8d9e7f1a3c','Student',0,false,true)
on conflict (class_id, student_no) do nothing;

-- 既有資料庫升級：預設管理者改為 5 號（1 號降為一般學生）
update public.users set role = 'Student' where class_id = 'demo' and student_no = '01' and role = 'Admin';
update public.users set role = 'Admin' where class_id = 'demo' and student_no = '05';

-- 示範店家（供投票與排程立即使用）----------------------------------------------
insert into public.stores (class_id, name, sort_order) values
('demo','麥味登', 1),
('demo','八方雲集', 2),
('demo','五十嵐', 3)
on conflict (class_id, name) do nothing;

-- 示範菜單（內含客製選項範例）--------------------------------------------------
insert into public.menu_items (class_id, store_id, name, price, options, sort_order)
select 'demo', s.id, v.name, v.price, v.options::jsonb, v.sort_order
from public.stores s,
     (values
       ('麥味登', '火腿蛋吐司', 45, '[{"name":"不加美乃滋","price":0},{"name":"加起司","price":10}]', 1),
       ('麥味登', '奶茶', 30, '[{"name":"無糖","price":0},{"name":"半糖","price":0},{"name":"全糖","price":0},{"name":"去冰","price":0}]', 2),
       ('八方雲集', '招牌鍋貼(10顆)', 70, '[{"name":"加辣","price":0}]', 1),
       ('八方雲集', '酸辣湯', 35, '[]', 2),
       ('五十嵐', '珍珠奶茶', 55, '[{"name":"無糖","price":0},{"name":"微糖","price":0},{"name":"半糖","price":0},{"name":"加布丁","price":15}]', 1)
     ) as v(store_name, name, price, options, sort_order)
where s.class_id = 'demo' and s.name = v.store_name
on conflict (class_id, store_id, name) do nothing;

-- ============================================================================
-- 金流原子運算（由 API 以 supabase.rpc 呼叫，避免並發扣款錯誤）
-- ============================================================================

-- 建立／更新訂單並結算（純儲值模式下餘額不足直接拒絕）
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
  v_owned bigint;
begin
  select wallet_balance into v_balance
  from users where id = p_user_id and class_id = p_class_id
  for update;
  if v_balance is null then
    raise exception 'USER_NOT_FOUND';
  end if;

  -- 純儲值模式：錢包必須足以支付全額，禁止現金欠款
  if p_pure_mode then
    if p_cash_outstanding > 0 then
      raise exception 'PURE_MODE_NO_CASH';
    end if;
    if v_balance + coalesce(p_prior_paid, 0) < p_wallet_paid then
      raise exception 'INSUFFICIENT_BALANCE';
    end if;
  end if;

  -- 更新訂單時：先退回原單已付金額，再重新結算
  v_balance := v_balance + coalesce(p_prior_paid, 0);

  if p_wallet_paid > 0 then
    if v_balance < p_wallet_paid then
      raise exception 'INSUFFICIENT_BALANCE';
    end if;
    v_balance := v_balance - p_wallet_paid;
  end if;

  update users set wallet_balance = v_balance, updated_at = now()
  where id = p_user_id;

  if p_cash_outstanding > 0 and p_wallet_paid > 0 then
    v_status := 'PartiallyPaid';
  elsif p_cash_outstanding > 0 then
    v_status := 'UnpaidCash';
  else
    v_status := 'PaidWallet';
  end if;

  if p_order_id is not null then
    select id into v_owned from orders
    where id = p_order_id and user_id = p_user_id and class_id = p_class_id;
    if v_owned is null then
      raise exception 'ORDER_NOT_FOUND';
    end if;
    update orders
       set items = p_items, total_price = p_total, prior_paid = p_wallet_paid,
           payment_status = v_status, note = p_note, updated_at = now()
     where id = p_order_id
    returning id into v_order_id;
  else
    insert into orders (class_id, session_id, user_id, items, total_price, prior_paid, payment_status, pickup_status, note)
    values (p_class_id, p_session_id, p_user_id, p_items, p_total, p_wallet_paid, v_status, 'Pending', p_note)
    returning id into v_order_id;
  end if;

  if p_prior_paid > 0 then
    insert into transactions (class_id, user_id, order_id, amount, kind, note)
    values (p_class_id, p_user_id, v_order_id, p_prior_paid, 'Refund', '訂單修改退款');
  end if;
  if p_wallet_paid > 0 then
    insert into transactions (class_id, user_id, order_id, amount, kind, note)
    values (p_class_id, p_user_id, v_order_id, -p_wallet_paid, 'Wallet', '訂餐扣款');
  end if;
  if p_cash_outstanding > 0 then
    insert into transactions (class_id, user_id, order_id, amount, kind, note)
    values (p_class_id, p_user_id, v_order_id, p_cash_outstanding, 'Cash', '現金未繳');
  end if;

  return jsonb_build_object(
    'order_id', v_order_id,
    'wallet_balance', v_balance,
    'payment_status', v_status
  );
end;
$$;

-- 刪除訂單並退回已扣儲值金
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
  where id = p_order_id and user_id = p_user_id and class_id = p_class_id;
  if v_order.id is null then
    raise exception 'ORDER_NOT_FOUND';
  end if;

  v_refund := coalesce(v_order.prior_paid, 0);
  v_balance := v_balance + v_refund;

  update users set wallet_balance = v_balance, updated_at = now()
  where id = p_user_id;

  if v_refund > 0 then
    insert into transactions (class_id, user_id, order_id, amount, kind, note)
    values (p_class_id, p_user_id, p_order_id, v_refund, 'Refund', '取消訂單退款');
  end if;

  delete from orders where id = p_order_id;

  return jsonb_build_object('wallet_balance', v_balance, 'refunded', v_refund);
end;
$$;

-- 管理員儲值：先抵最舊的現金未繳訂單，剩餘入錢包
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

-- 管理員現金結清指定訂單
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
  select wallet_balance from users
  where id = p_user_id and class_id = p_class_id
  for update;

  foreach v_order_id in array p_order_ids loop
    select * into v_order from orders
    where id = v_order_id and user_id = p_user_id and class_id = p_class_id;
    if v_order.id is not null then
      v_outstanding := v_order.total_price - v_order.prior_paid;
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

-- 刪除場次並退款
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

-- 餘額手動調整（正數=加值，負數=扣款；不可低於 0）
create or replace function public.fn_manual_balance(
  p_class_id text,
  p_user_id bigint,
  p_amount numeric,
  p_note text
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare v_balance numeric;
begin
  select wallet_balance into v_balance from public.users
    where id = p_user_id and class_id = p_class_id for update;
  if v_balance is null then raise exception 'USER_NOT_FOUND'; end if;
  if v_balance + p_amount < 0 then raise exception 'INSUFFICIENT_BALANCE'; end if;
  v_balance := v_balance + p_amount;
  update public.users set wallet_balance = v_balance, updated_at = now() where id = p_user_id;
  insert into public.transactions (class_id, user_id, order_id, amount, kind, note)
    values (p_class_id, p_user_id, null, p_amount, 'Manual', coalesce(p_note, '手動調整'));
  return jsonb_build_object('wallet_balance', v_balance);
end;
$$;

-- ============================================================================
-- 排程（選用）：部署完成後在 SQL Editor 執行並替換網址與 CRON_SECRET：
--   create extension if not exists pg_cron;
--   create extension if not exists pg_net;
--   select cron.schedule(
--     'meal-reminders',
--     '0 * * * *',
--     $$ select net.http_post(
--          url := 'https://你的-app.vercel.app/api/cron?secret=你的CRON_SECRET',
--          headers := jsonb_build_object('Content-Type','application/json'),
--          body := '{}'
--        ) $$
--   );
-- 移除排程：select cron.unschedule('meal-reminders');
-- ============================================================================
