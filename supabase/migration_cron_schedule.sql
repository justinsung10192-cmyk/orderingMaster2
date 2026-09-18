-- ============================================================================
-- 排程設定：讓 Supabase pg_cron 每小時呼叫 /api/cron 端點
-- （訂餐開始／截止／欠繳催繳／行事曆提醒 都靠這個端點觸發）
--
-- 使用方式：
--   1. 確認已設定環境變數 CRON_SECRET（在 Vercel 專案設定）。
--   2. 把下面網址與 secret 換成你自己的，再於 Supabase SQL Editor 執行。
--   3. 若要移除排程：select cron.unschedule('meal-reminders');
-- ============================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'meal-reminders',
  '0 * * * *',
  $$ select net.http_post(
       url := 'https://ordering-master-pro.vercel.app/cron?secret=12345678',
       headers := jsonb_build_object('Content-Type', 'application/json'),
       body := '{}'
     ) $$
);
