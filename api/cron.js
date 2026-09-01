// 排程端點：由 Supabase pg_cron 每小時呼叫（?secret=CRON_SECRET），
// 檢查 2 小時內截止且尚未提醒的場次，對已訂餐的學生推送通知。
import { readRawBody, sendJson } from './_lib/util.js';
import { supabase, findOne, listRowsIn, updateRows } from './_lib/db.js';
import { sendPushToUser } from './_lib/push.js';

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const secret = url.searchParams.get('secret');
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return sendJson(res, { ok: false, error: 'unauthorized' });
  }
  try {
    await readRawBody(req);
    const now = Date.now();
    const horizon = new Date(now + 2 * 60 * 60 * 1000).toISOString();
    const { data: sessions, error } = await supabase
      .from('sessions')
      .select('*')
      .eq('is_open', true)
      .eq('cutoff_reminder_sent', false)
      .lte('cutoff_time', horizon)
      .gte('cutoff_time', new Date(now).toISOString());
    if (error) throw new Error('讀取場次失敗。');

    let reminded = 0;
    for (const session of sessions || []) {
      const orders = await listRowsIn('orders', 'session_id', [session.id], { classId: session.class_id });
      const userIds = [...new Set(orders.map(order => order.user_id).filter(value => value !== null && value !== undefined))];
      const store = await findOne('stores', { id: session.store_id }, session.class_id);
      const time = new Date(session.cutoff_time);
      const timeText = `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`;
      for (const userId of userIds) {
        await sendPushToUser(Number(userId), {
          title: '訂餐即將截止',
          body: `「${store ? store.name : '訂餐'}」場次將於 ${timeText} 截止，記得確認你的訂單。`,
          url: '/',
        });
        reminded += 1;
      }
      await updateRows('sessions', { id: session.id }, { cutoff_reminder_sent: true });
    }
    return sendJson(res, { ok: true, data: { reminded } });
  } catch (error) {
    return sendJson(res, { ok: false, error: error?.message || '排程執行失敗。' });
  }
}
