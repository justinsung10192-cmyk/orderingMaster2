// 動作：場次排程（下週一～日、多場次、放假）、一鍵公布、截止管理
import { appError, sid, num, weekLabelOf, weekdayName, monthDay, nextWeekLabel, todayString } from '../_lib/util.js';
import { findOne, listRows, listRowsIn, insertRow, updateRows, deleteRows, callRpc, listStoresForClass } from '../_lib/db.js';
import { sendPushToClass, sendPushToUser } from '../_lib/push.js';

function formatTime(iso) {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export const actions = {
  // 建立或更新單一場次（草稿狀態，需「公布」後學生才能看到）
  async adminSaveSession(data, ctx) {
    const store = await findOne('stores', { id: Number(data.storeId) }, ctx.classId);
    if (!store) throw appError('NOT_FOUND', '店家不存在。');
    const orderDate = String(data.orderDate || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(orderDate)) throw appError('INVALID_INPUT', '請選擇訂餐日期。');
    const cutoff = new Date(data.cutoffTime);
    if (!Number.isFinite(cutoff.getTime())) throw appError('INVALID_INPUT', '請選擇截止時間。');

    const weekLabel = weekLabelOf(`${orderDate}T00:00:00`);
    const values = {
      store_id: store.id,
      order_date: orderDate,
      cutoff_time: cutoff.toISOString(),
      week_label: weekLabel,
    };

    if (data.sessionId) {
      const existing = await findOne('sessions', { id: Number(data.sessionId) }, ctx.classId);
      if (!existing) throw appError('NOT_FOUND', '場次不存在。');
      await updateRows('sessions', { id: existing.id }, values);
      return { ok: true, sessionId: sid(existing.id) };
    }
    // 若該週已公布（有任一已開放場次），新增場次自動開放，學生可立即訂餐
    const weekOpen = await listRows('sessions', { classId: ctx.classId, filters: { week_label: weekLabel, is_open: true, is_deleted: false } });
    const autoOpen = weekOpen.length > 0;
    const session = await insertRow('sessions', {
      ...values,
      class_id: ctx.classId,
      is_open: autoOpen,
      start_notice_sent: autoOpen,
    });
    return { ok: true, sessionId: sid(session.id), autoOpen };
  },

  // 設定整週統一截止時間（套用到該週所有場次）
  async adminSetWeekCutoff(data, ctx) {
    const weekLabel = String(data.weekLabel || '');
    if (!/^\d{4}-W\d{1,2}$/.test(weekLabel)) throw appError('INVALID_INPUT', '週別格式不正確。');
    const cutoff = new Date(data.cutoffTime);
    if (!Number.isFinite(cutoff.getTime())) throw appError('INVALID_INPUT', '請選擇截止時間。');
    const sessions = await listRows('sessions', { classId: ctx.classId, filters: { week_label: weekLabel, is_deleted: false } });
    for (const session of sessions) {
      await updateRows('sessions', { id: session.id }, { cutoff_time: cutoff.toISOString(), cutoff_reminder_sent: false });
    }
    return { ok: true, updated: sessions.length };
  },

  async adminUpdateSessionCutoff(data, ctx) {
    const session = await findOne('sessions', { id: Number(data.sessionId) }, ctx.classId);
    if (!session) throw appError('NOT_FOUND', '場次不存在。');
    const cutoff = new Date(data.cutoffTime);
    if (!Number.isFinite(cutoff.getTime())) throw appError('INVALID_INPUT', '請選擇截止時間。');
    await updateRows('sessions', { id: session.id }, { cutoff_time: cutoff.toISOString(), cutoff_reminder_sent: false });
    return { ok: true };
  },

  async adminCloseSession(data, ctx) {
    const session = await findOne('sessions', { id: Number(data.sessionId) }, ctx.classId);
    if (!session) throw appError('NOT_FOUND', '場次不存在。');
    await updateRows('sessions', { id: session.id }, { is_open: false, closed_at: new Date().toISOString() });
    return { ok: true };
  },

  async adminDeleteSession(data, ctx) {
    const session = await findOne('sessions', { id: Number(data.sessionId) }, ctx.classId);
    if (!session) throw appError('NOT_FOUND', '場次不存在。');
    const result = await callRpc('fn_delete_session_and_refund', {
      p_class_id: ctx.classId,
      p_session_id: session.id,
    });
    return { ok: true, refundedCount: result.refunded_count };
  },

  // 一鍵公布某週所有場次，並推播「訂餐開始」
  async adminPublishWeek(data, ctx) {
    const weekLabel = String(data.weekLabel || '');
    if (!/^\d{4}-W\d{1,2}$/.test(weekLabel)) throw appError('INVALID_INPUT', '週別格式不正確。');
    const sessions = await listRows('sessions', { classId: ctx.classId, filters: { week_label: weekLabel } });
    const drafts = sessions.filter((session) => !session.is_deleted && !session.is_open);
    for (const session of drafts) {
      await updateRows('sessions', { id: session.id }, { is_open: true, start_notice_sent: true, cutoff_reminder_sent: false });
    }
    if (drafts.length) {
      await sendPushToClass(ctx.classId, {
        title: '訂餐開始囉！',
        body: `${weekLabel} 本週菜單已公布，快來訂餐吧。`,
        url: '/',
      });
    }
    await materializeRecurring(ctx.classId);
    return { ok: true, published: drafts.length };
  },

  // 標記／取消放假
  async adminSetHoliday(data, ctx) {
    const date = String(data.date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw appError('INVALID_INPUT', '日期格式不正確。');
    const note = String(data.note || '').slice(0, 60);
    await supabaseUpsertHoliday(ctx.classId, date, note);
    return { ok: true };
  },

  async adminRemoveHoliday(data, ctx) {
    const date = String(data.date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw appError('INVALID_INPUT', '日期格式不正確。');
    await deleteRows('holidays', { class_id: ctx.classId, holiday_date: date });
    return { ok: true };
  },

  // 取得某週排程（含放假與場次）
  async adminGetWeekSchedule(data, ctx) {
    const weekLabel = String(data.weekLabel || nextWeekLabel());
    const sessions = await listRows('sessions', {
      classId: ctx.classId,
      filters: { week_label: weekLabel },
      order: 'order_date',
    });
    const stores = await listStoresForClass(ctx.classId);
    const storeById = new Map(stores.map((store) => [String(store.id), store]));
    const holidays = await listRows('holidays', { classId: ctx.classId });
    const holidayDates = new Set(holidays.map((holiday) => holiday.holiday_date));
    const recurringRows = await listRows('recurring_menu', { classId: ctx.classId, filters: { is_active: true } });

    return {
      weekLabel,
      stores: stores.map((store) => ({ storeId: sid(store.id), name: store.name, isActive: Boolean(store.is_active) })),
      holidayDates: [...holidayDates],
      recurring: recurringRows.map((row) => ({
        storeId: sid(row.store_id),
        storeName: storeById.get(String(row.store_id))?.name || '未命名店家',
        cutoffTime: row.cutoff_time,
      })),
      sessions: sessions
        .filter((session) => !session.is_deleted)
        .map((session) => ({
          sessionId: sid(session.id),
          storeId: sid(session.store_id),
          storeName: storeById.get(String(session.store_id))?.name || '未命名店家',
          orderDate: session.order_date,
          weekday: weekdayName(session.order_date),
          monthDay: monthDay(session.order_date),
          cutoffTime: session.cutoff_time,
          isOpen: Boolean(session.is_open),
        })),
    };
  },

  // 設定每日固定店家（固定菜單）
  async adminSaveRecurring(data, ctx) {
    const store = await findOne('stores', { id: Number(data.storeId) }, ctx.classId);
    if (!store) throw appError('NOT_FOUND', '店家不存在。');
    const enabled = data.enabled !== false;
    const existing = await findOne('recurring_menu', { store_id: store.id }, ctx.classId);
    if (enabled) {
      const cutoffTime = String(data.cutoffTime || '').trim();
      if (!/^\d{2}:\d{2}$/.test(cutoffTime)) throw appError('INVALID_INPUT', '請選擇每天截止時間。');
      if (existing) {
        await updateRows('recurring_menu', { id: existing.id }, { cutoff_time: cutoffTime, is_active: true });
      } else {
        await insertRow('recurring_menu', { class_id: ctx.classId, store_id: store.id, cutoff_time: cutoffTime, is_active: true });
      }
      await materializeRecurring(ctx.classId);
    } else if (existing) {
      await updateRows('recurring_menu', { id: existing.id }, { is_active: false });
    }
    return { ok: true };
  },
};

// 將固定店家展開成未來 N 天的場次（放假除外；已有場次的日期不重複建立）
export async function materializeRecurring(classId, { days = 14 } = {}) {
  const recurring = await listRows('recurring_menu', { classId, filters: { is_active: true } });
  if (!recurring.length) return 0;
  const holidays = await listRows('holidays', { classId });
  const holidaySet = new Set(holidays.map((holiday) => holiday.holiday_date));

  const dates = [];
  for (let i = 0; i < days; i += 1) {
    const d = new Date(`${todayString()}T00:00:00`);
    d.setDate(d.getDate() + i);
    dates.push(localDateString(d));
  }
  const existingSessions = await listRowsIn('sessions', 'order_date', dates, { classId });
  const existingKeys = new Set(existingSessions.map((session) => `${session.store_id}:${session.order_date}`));

  let created = 0;
  for (const rec of recurring) {
    for (const date of dates) {
      if (holidaySet.has(date)) continue;
      if (existingKeys.has(`${rec.store_id}:${date}`)) continue;
      const cutoff = new Date(`${date}T${rec.cutoff_time}:00`);
      await insertRow('sessions', {
        class_id: classId,
        store_id: rec.store_id,
        order_date: date,
        cutoff_time: cutoff.toISOString(),
        week_label: weekLabelOf(`${date}T00:00:00`),
        is_open: true,
        start_notice_sent: true,
      });
      existingKeys.add(`${rec.store_id}:${date}`);
      created += 1;
    }
  }
  return created;
}

function localDateString(d) {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

async function supabaseUpsertHoliday(classId, date, note) {
  const existing = await findOne('holidays', { class_id: classId, holiday_date: date });
  if (existing) {
    await updateRows('holidays', { id: existing.id }, { note });
  } else {
    await insertRow('holidays', { class_id: classId, holiday_date: date, note });
  }
}
