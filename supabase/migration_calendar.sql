-- ============================================================================
-- 班級行事曆：事件表 + 歷史紀錄表
-- 在 Supabase SQL Editor 執行一次即可（可重複執行）。
-- ============================================================================

create table if not exists public.calendar_events (
  id          bigint generated always as identity primary key,
  class_id    text not null references public.classes(class_id) on delete cascade,
  user_id     bigint not null references public.users(id) on delete cascade,
  title       text not null,
  description text not null default '',
  category    text not null default '其他',
  event_date  date not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists idx_calendar_class_date on public.calendar_events (class_id, event_date);

create table if not exists public.calendar_event_logs (
  id         bigint generated always as identity primary key,
  class_id   text not null,
  event_id   bigint,
  user_id    bigint,
  user_label text not null default '',
  action     text not null,
  detail     text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists idx_calendar_logs_class on public.calendar_event_logs (class_id, created_at desc);
