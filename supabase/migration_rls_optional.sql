-- ============================================================================
-- RLS（Row Level Security）啟用遷移 — 選用、可逆、不碰資料
-- ----------------------------------------------------------------------------
-- 現況：
--   - 所有資料表皆「未啟用 RLS」，存取全部經由伺服器端 service_role 金鑰（api/）。
--   - service_role 會「繞過 RLS」，因此啟用 RLS 不會影響系統正常運作。
--   - 前端完全沒有直接使用 anon 金鑰（所有請求經 /api/gas 代理），
--     因此「啟用 RLS 但不建立任何 policy」＝ anon 金鑰完全無法讀寫，
--     service_role 照常，等於多一道防護（防 anon 金鑰外洩被濫用）。
--
-- 安全性說明：
--   - 這是不具破壞性的變更（ENABLE ROW LEVEL SECURITY 只改存取控制，不改資料）。
--   - 可隨時反向執行：ALTER TABLE ... DISABLE ROW LEVEL SECURITY;
--   - 若日後要讓「前端直接以 anon 金鑰」讀取，必須另外建立對應的 policy，
--     否則會讀不到任何資料（這是刻意設計的預設安全狀態）。
--
-- 建議：先執行 migration_perf_indexes.sql（索引），確認無誤後再執行本檔。
-- ============================================================================

-- 對所有業務資料表啟用 RLS（不建立 policy，service_role 不受影響）
alter table public.classes                enable row level security;
alter table public.users                  enable row level security;
alter table public.stores                 enable row level security;
alter table public.menu_items             enable row level security;
alter table public.recurring_menu         enable row level security;
alter table public.sessions               enable row level security;
alter table public.holidays               enable row level security;
alter table public.duty_assignments       enable row level security;
alter table public.orders                 enable row level security;
alter table public.transactions           enable row level security;
alter table public.verification_records   enable row level security;
alter table public.votes                  enable row level security;
alter table public.auth_tokens            enable row level security;
alter table public.push_subscriptions     enable row level security;
alter table public.app_settings           enable row level security;
alter table public.calendar_events        enable row level security;
alter table public.calendar_event_logs    enable row level security;
alter table public.custom_debts           enable row level security;
alter table public.leave_requests         enable row level security;
alter table public.menu_recommendations   enable row level security;
alter table public.changelog              enable row level security;

-- ============================================================================
-- 完成。以上僅「啟用 RLS」，未建立 policy。
-- 驗證（確認 service_role 仍可讀寫）：
--   select count(*) from public.users;   -- 以 service_role 執行仍回傳完整筆數
-- ============================================================================
