// 排程端點：由 Supabase pg_cron 每小時呼叫（?secret=CRON_SECRET）。
// 1) 訂餐開始推播（補漏） 2) 即將截止推播 3) 每日欠繳催繳推播
import { readRawBody, sendJson } from './_lib/util.js';
import { supabase, findOne, listRowsIn, updateRows, getAppSetting, setAppSetting } from './_lib/db.js';
import { sendPushToUser, sendPushToClass } from './_lib/push.js';
import { outstandingOf } from './_lib/serialize.js';
import { materializeRecurring } from './_actions/sessions.js';

export const config = { api: { bodyParser: false } };

function fmtTime(iso) {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export default async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const secret = url.searchParams.get('secret');
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return sendJson(res, { ok: false, error: 'unauthorized' });
  }
  try {
    await readRawBody(req);
    const now = Date.now();
    const result = { startNotices: 0, cutoffReminders: 0, overdueReminders: 0, materialized: 0 };

    // 1) 訂餐開始（補漏：已開放但未通知）
    const { data: startSessions, error: startErr } = await supabase
      .from('sessions')
      .select('*')
      .eq('is_open', true)
      .eq('is_deleted', false)
      .eq('start_notice_sent', false);
    if (!startErr) {
      for (const session of startSessions || []) {
        const store = await findOne('stores', { id: session.store_id }, session.class_id);
        await sendPushToClass(session.class_id, {
          title: '訂餐開始囉！',
          body: `「${store?.name || '訂餐'}」${session.order_date} 已開放訂餐。`,
          url: '/',
        });
        await updateRows('sessions', { id: session.id }, { start_notice_sent: true });
        result.startNotices += 1;
      }
    }

    // 2) 即將截止（1 小時內截止且尚未提醒）
    const horizon = new Date(now + 60 * 60 * 1000).toISOString();
    const { data: cutoffSessions, error: cutoffErr } = await supabase
      .from('sessions')
      .select('*')
      .eq('is_open', true)
      .eq('is_deleted', false)
      .eq('cutoff_reminder_sent', false)
      .lte('cutoff_time', horizon)
      .gte('cutoff_time', new Date(now).toISOString());
    if (!cutoffErr) {
      for (const session of cutoffSessions || []) {
        const orders = await listRowsIn('orders', 'session_id', [session.id], { classId: session.class_id });
        const userIds = [...new Set(orders.map((order) => order.user_id).filter((value) => value != null))];
        const store = await findOne('stores', { id: session.store_id }, session.class_id);
        for (const userId of userIds) {
          await sendPushToUser(Number(userId), {
            title: '訂餐即將截止',
            body: `「${store?.name || '訂餐'}」將於 ${fmtTime(session.cutoff_time)} 截止，記得確認訂單。`,
            url: '/',
          });
          result.cutoffReminders += 1;
        }
        await updateRows('sessions', { id: session.id }, { cutoff_reminder_sent: true });
      }
    }

    // 3) 欠繳催繳（頻率 6/12/24 小時；只通知「截止後超過 24 小時仍未結清」者）
    const classRow = await findOne('classes', { class_id: 'demo' });
    const remindHours = Number(classRow?.overdue_remind_hours) || 24;
    const lastOverdue = await getAppSetting('', 'last_overdue_reminder', '');
    const lastTs = lastOverdue ? Date.parse(lastOverdue) : 0;
    if (!lastTs || now - lastTs >= remindHours * 3600 * 1000) {
      // 找出「截止時間已超過 24 小時」的場次，再抓其未結清訂單
      const cutoffThreshold = new Date(now - 24 * 3600 * 1000).toISOString();
      const { data: expiredSessions, error: sessErr } = await supabase
        .from('sessions')
        .select('id')
        .eq('class_id', 'demo')
        .eq('is_deleted', false)
        .lt('cutoff_time', cutoffThreshold);
      if (!sessErr && (expiredSessions || []).length) {
        const sessionIds = expiredSessions.map((session) => session.id);
        const { data: unpaidOrders } = await supabase
          .from('orders')
          .select('*')
          .in('session_id', sessionIds)
          .in('payment_status', ['UnpaidCash', 'PartiallyPaid'])
          .eq('is_deleted', false);
        const userIds = [...new Set(
          (unpaidOrders || [])
            .filter((order) => outstandingOf(order) > 0)
            .map((order) => order.user_id)
            .filter((value) => value != null),
        )];
        for (const userId of userIds) {
          await sendPushToUser(Number(userId), {
            title: '午餐費用提醒',
            body: '你還有超過 24 小時未結清的午餐費用，請記得繳交。',
            url: '/',
          });
          result.overdueReminders += 1;
        }
      }
      await setAppSetting('', 'last_overdue_reminder', new Date(now).toISOString());
    }

    result.materialized = await materializeRecurring('demo');
    return sendJson(res, { ok: true, data: result });
  } catch (error) {
    return sendJson(res, { ok: false, error: error?.message || '排程執行失敗。' });
  }
}
