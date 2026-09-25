-- ============================================================================
-- 0001_schema_migrations.sql
-- 目的：建立遷移追蹤表，讓「哪一版跑過了」變成可查詢的事實，而不是記憶。
-- 風險：無。純新增資料表，不影響任何既有功能。
-- 可重複執行：是。
-- ============================================================================

create table if not exists public.schema_migrations (
  version    text primary key,
  name       text not null,
  checksum   text not null,
  applied_at timestamptz not null default now()
);

comment on table public.schema_migrations is
  '已套用的資料庫遷移。version 為檔名前綴（如 0002），checksum 為該遷移檔內容的 sha256，用於偵測「已套用的檔案被偷改」。';

create index if not exists idx_schema_migrations_applied_at
  on public.schema_migrations (applied_at desc);

-- 若這個資料庫是用舊流程（手動跑 schema.sql + migration_*.sql）建起來的，
-- 這裡補一筆「建庫基線」紀錄，代表 0001 之前的狀態。
insert into public.schema_migrations (version, name, checksum)
values ('0000', 'legacy_baseline_schema_sql', 'n/a')
on conflict (version) do nothing;
