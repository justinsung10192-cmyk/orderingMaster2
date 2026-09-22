-- ============================================================================
-- RFID 卡片系統（純新增，不影響任何既有功能）
-- 硬體：D1 Mini (ESP8266) + RC522 (MFRC522)
-- 用途：感應卡片等同於「掃碼」，管理者手機即時顯示該生座號與餐點資訊。
-- 全部使用 CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS，可重複執行、不刪任何資料。
-- ============================================================================

-- 卡片綁定：卡片 UID → 使用者（座號）
create table if not exists public.rfid_cards (
  id            bigint generated always as identity primary key,
  class_id      text not null,
  uid           text not null,
  user_id       bigint not null references public.users(id) on delete cascade,
  registered_at timestamptz not null default now(),
  unique (class_id, uid)
);
create index if not exists idx_rfid_cards_user on public.rfid_cards (user_id);

-- 感應事件紀錄（scan = 感應核銷 / registered = 註冊綁定 / unknown = 未綁定卡片）
create table if not exists public.rfid_events (
  id           bigint generated always as identity primary key,
  class_id     text not null,
  uid          text,
  user_id      bigint,
  seat_no      text,
  student_name text,
  kind         text not null default 'scan',
  created_at   timestamptz not null default now()
);
create index if not exists idx_rfid_events_class_time on public.rfid_events (class_id, created_at desc);
create index if not exists idx_rfid_events_user on public.rfid_events (user_id);

-- 待註冊狀態（每班一筆：管理員先選座號，再感應新卡片完成綁定）
create table if not exists public.rfid_pending (
  class_id   text primary key,
  user_id    bigint not null,
  seat_no    text not null,
  created_at timestamptz not null default now()
);

-- 說明：本系統所有資料存取皆經伺服器端 service_role，前端不直接連資料庫。
-- 因此上述新表無需 RLS policy 即可正常運作；若你有啟用 RLS 的習慣，可自行執行：
--   alter table public.rfid_cards enable row level security;
--   alter table public.rfid_events enable row level security;
--   alter table public.rfid_pending enable row level security;
-- （service_role 會繞過 RLS，不影響功能。）
