// 排程端點：由 Supabase pg_cron 每小時呼叫（?secret=CRON_SECRET）。
// 1) 訂餐開始推播（補漏） 2) 即將截止推播 3) 每日欠繳催繳推播
import { readRawBody, sendJson } from './_lib/util.js';
import { supabase, findOne, listRowsIn, updateRows, getAppSetting, setAppSetting } from './_lib/db.js';
import { sendPushToUser, sendPushToClass } from './_lib/push.js';
import { outstandingOf } from './_lib/serialize.js';
import { materializeRecurring } from './_actions/sessions.js';

export const config = { api: { bodyParser: false } };

export const maxDuration = 60;

function fmtTime(iso) {
  // 通知內顯示「台灣時間」（伺服器可能跑在 UTC）
  const d = new Date(new Date(iso).getTime() + 8 * 60 * 60 * 1000);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
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
    const result = { startNotices: 0, cutoffReminders: 0, overdueReminders: 0, calendarReminders: 0, materialized: 0 };

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
      // 依「台灣時間 HH:MM」分組：同時截止的多個場次只對每個人發一則通知
      const groups = new Map(); // time -> { sessions: [], userIds: Set }
      for (const session of cutoffSessions || []) {
        const time = fmtTime(session.cutoff_time);
        if (!groups.has(time)) groups.set(time, { sessions: [], userIds: new Set() });
        const group = groups.get(time);
        group.sessions.push(session);
        const orders = await listRowsIn('orders', 'session_id', [session.id], { classId: session.class_id });
        for (const order of orders) {
          if (order.user_id != null) group.userIds.add(order.user_id);
        }
      }
      for (const [time, group] of groups) {
        for (const userId of group.userIds) {
          await sendPushToUser(Number(userId), {
            title: '訂餐即將截止',
            body: `你的訂餐將於 ${time} 截止，記得確認訂單。`,
            url: '/',
          });
          result.cutoffReminders += 1;
        }
        for (const session of group.sessions) {
          await updateRows('sessions', { id: session.id }, { cutoff_reminder_sent: true });
        }
      }
    }

    // 3) 欠繳催繳（頻率 6/12/24 小時；只通知「截止後超過 24 小時仍未結清」者）
    const { data: classes } = await supabase.from('classes').select('*');
    for (const cls of classes || []) {
      const remindHours = Number(cls.overdue_remind_hours) || 24;
      const lastOverdue = await getAppSetting(cls.class_id, 'last_overdue_reminder', '');
      const lastTs = lastOverdue ? Date.parse(lastOverdue) : 0;
      if (!lastTs || now - lastTs >= remindHours * 3600 * 1000) {
        // 找出「截止時間已超過 24 小時」的場次，再抓其未結清訂單
        const cutoffThreshold = new Date(now - 24 * 3600 * 1000).toISOString();
        const { data: expiredSessions, error: sessErr } = await supabase
          .from('sessions')
          .select('id')
          .eq('class_id', cls.class_id)
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
        await setAppSetting(cls.class_id, 'last_overdue_reminder', new Date(now).toISOString());
      }
    }

    // 4) 行事曆提醒：考試／作業「前一天上午 8:00 後」（台灣時間）推播一次
    const taiwanNow = new Date(now + 8 * 60 * 60 * 1000);
    if (taiwanNow.getUTCHours() >= 8) {
      const tomorrow = new Date(now + 8 * 60 * 60 * 1000);
      tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
      const tomorrowDate = `${tomorrow.getUTCFullYear()}-${String(tomorrow.getUTCMonth() + 1).padStart(2, '0')}-${String(tomorrow.getUTCDate()).padStart(2, '0')}`;
      for (const cls of classes || []) {
        const lastCalendar = await getAppSetting(cls.class_id, 'last_calendar_reminder', '');
        if (lastCalendar !== tomorrowDate) {
          const { data: events } = await supabase
            .from('calendar_events')
            .select('*')
            .eq('class_id', cls.class_id)
            .eq('event_date', tomorrowDate)
            .in('category', ['考試', '作業']);
          if ((events || []).length) {
            const titles = [...new Set((events || []).map((event) => event.title))].slice(0, 5).join('、');
            await sendPushToClass(cls.class_id, {
              title: '明天有考試／作業',
              body: `${tomorrowDate.slice(5).replace('-', '/')}：${titles}${(events || []).length > 5 ? ' 等' : ''}`,
              url: '/',
            });
            result.calendarReminders += (events || []).length;
          }
          await setAppSetting(cls.class_id, 'last_calendar_reminder', tomorrowDate);
        }
      }
    }

    for (const cls of classes || []) {
      result.materialized += await materializeRecurring(cls.class_id);
    }
    return sendJson(res, { ok: true, data: result });
  } catch (error) {
    return sendJson(res, { ok: false, error: error?.message || '排程執行失敗。' });
  }
}
