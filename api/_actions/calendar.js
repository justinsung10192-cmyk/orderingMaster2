// 動作：班級行事曆
// 權限：所有人可新增；管理員可編輯/刪除全部，一般使用者僅能修改/刪除自己新增的事件。
// 每個變更都會寫入 calendar_event_logs，供管理員查看歷史紀錄。
import { appError, sid } from '../_lib/util.js';
import { supabase, findOne, listRowsIn, updateRows, deleteRows } from '../_lib/db.js';

const CATEGORIES = ['考試', '作業', '活動', '其他'];

function userLabel(user) {
  return `${user?.seat_no || ''} ${user?.student_name || ''}`.trim();
}

async function logCalendar(classId, eventId, userId, label, action, detail) {
  await supabase.from('calendar_event_logs').insert({
    class_id: classId,
    event_id: eventId,
    user_id: userId,
    user_label: label,
    action,
    detail,
  }).catch(() => {});
}

function validatePayload(data) {
  const title = String(data.title || '').trim().slice(0, 80);
  const date = String(data.date || '').trim();
  const category = CATEGORIES.includes(data.category) ? data.category : '其他';
  const description = String(data.description || '').trim().slice(0, 300);
  if (!title) throw appError('INVALID_INPUT', '請輸入事件名稱。');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw appError('INVALID_INPUT', '請選擇日期。');
  return { title, date, category, description };
}

export const actions = {
  // 列出某月份的事件（所有人）
  async calendarList(data, ctx) {
    const month = String(data.month || '').trim();
    if (!/^\d{4}-\d{2}$/.test(month)) throw appError('INVALID_INPUT', '請選擇月份。');
    const [year, mon] = month.split('-').map(Number);
    const next = mon === 12 ? `${year + 1}-01` : `${year}-${String(mon + 1).padStart(2, '0')}`;
    const { data: events, error } = await supabase
      .from('calendar_events')
      .select('*')
      .eq('class_id', ctx.classId)
      .gte('event_date', `${month}-01`)
      .lt('event_date', `${next}-01`);
    if (error) throw appError('DB_ERROR', error.message);

    const rows = events || [];
    const userIds = [...new Set(rows.map((event) => event.user_id).filter(Boolean))];
    const users = userIds.length ? await listRowsIn('users', 'id', userIds, { classId: ctx.classId }) : [];
    const userById = new Map(users.map((user) => [String(user.id), user]));

    const list = rows
      .sort((a, b) => (a.event_date === b.event_date ? Number(a.id) - Number(b.id) : String(a.event_date).localeCompare(String(b.event_date))))
      .map((event) => {
        const owner = userById.get(String(event.user_id));
        return {
          id: sid(event.id),
          userId: event.user_id ? sid(event.user_id) : null,
          ownerSeat: owner?.seat_no || '',
          ownerName: owner?.student_name || '',
          title: event.title,
          description: event.description || '',
          category: event.category || '其他',
          date: event.event_date,
        };
      });
    return { month, events: list };
  },

  // 新增事件（所有人）
  async calendarCreate(data, ctx) {
    const payload = validatePayload(data);
    const { data: event, error } = await supabase
      .from('calendar_events')
      .insert({
        class_id: ctx.classId,
        user_id: ctx.user.id,
        title: payload.title,
        description: payload.description,
        category: payload.category,
        event_date: payload.date,
      })
      .select()
      .single();
    if (error) throw appError('DB_ERROR', error.message);
    await logCalendar(ctx.classId, event.id, ctx.user.id, userLabel(ctx.user), 'create', payload.title);
    return { ok: true, id: sid(event.id) };
  },

  // 修改事件（管理員或建立者）
  async calendarUpdate(data, ctx) {
    const event = await findOne('calendar_events', { id: Number(data.id) }, ctx.classId);
    if (!event) throw appError('NOT_FOUND', '找不到此事件。');
    const isAdmin = ctx.user.role === 'Admin';
    const isOwner = String(event.user_id) === String(ctx.user.id);
    if (!isAdmin && !isOwner) throw appError('FORBIDDEN', '只能修改自己新增的事件。');
    const payload = validatePayload(data);
    await updateRows('calendar_events', { id: event.id }, {
      title: payload.title,
      description: payload.description,
      category: payload.category,
      event_date: payload.date,
      updated_at: new Date().toISOString(),
    });
    await logCalendar(ctx.classId, event.id, ctx.user.id, userLabel(ctx.user), 'update', payload.title);
    return { ok: true };
  },

  // 刪除事件（管理員或建立者）
  async calendarDelete(data, ctx) {
    const event = await findOne('calendar_events', { id: Number(data.id) }, ctx.classId);
    if (!event) throw appError('NOT_FOUND', '找不到此事件。');
    const isAdmin = ctx.user.role === 'Admin';
    const isOwner = String(event.user_id) === String(ctx.user.id);
    if (!isAdmin && !isOwner) throw appError('FORBIDDEN', '只能刪除自己新增的事件。');
    await deleteRows('calendar_events', { id: event.id });
    await logCalendar(ctx.classId, event.id, ctx.user.id, userLabel(ctx.user), 'delete', event.title);
    return { ok: true };
  },

  // 歷史紀錄（管理員）
  async calendarLogs(data, ctx) {
    const limit = Math.min(Number(data.limit) || 100, 300);
    const { data: logs, error } = await supabase
      .from('calendar_event_logs')
      .select('*')
      .eq('class_id', ctx.classId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw appError('DB_ERROR', error.message);
    return {
      logs: (logs || []).map((log) => ({
        id: sid(log.id),
        action: log.action,
        detail: log.detail || '',
        userLabel: log.user_label || '',
        time: log.created_at,
      })),
    };
  },
};
