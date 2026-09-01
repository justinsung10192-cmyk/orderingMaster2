
alter table public.sessions add column if not exists is_deleted boolean not null default false;
alter table public.orders add column if not exists is_deleted boolean not null default false;
