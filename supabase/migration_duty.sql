-- 值日生功能遷移：免值日欄位 + 手動指派表
-- 在 Supabase SQL Editor 執行一次即可（可重複執行）。

alter table public.users add column if not exists duty_exempt boolean not null default false;

create table if not exists public.duty_assignments (
  id          bigint generated always as identity primary key,
  class_id    text not null references public.classes(class_id) on delete cascade,
  duty_date   date not null,
  user_id     bigint not null references public.users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  unique (class_id, duty_date, user_id)
);
create index if not exists idx_duty_class_date on public.duty_assignments (class_id, duty_date);
