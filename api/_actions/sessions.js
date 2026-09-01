// 動作：場次管理（建立、改截止、提前結束、刪除）＋推播通知
import { appError, sid, num } from '../_lib/util.js';
import { findOne, listRows, listRowsIn, insertRow, updateRows, deleteRows, findStoreForClass, callRpc } from '../_lib/db.js';
import { sendPushToClass, sendPushToUser } from '../_lib/push.js';

function formatTime(iso) {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export const actions = {
  async adminSaveSession(data, ctx) {
    const store = await findStoreForClass(Number(data.storeId), ctx.classId);
    if (!store) throw appError('NOT_FOUND', '店家不存在。');
    const orderDate = String(data.orderDate || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(orderDate)) throw appError('INVALID_INPUT', '請選擇訂餐日期。');
    const cutoff = new Date(data.cutoffTime);
    if (!Number.isFinite(cutoff.getTime())) throw appError('INVALID_INPUT', '請選擇截止時間。');
    if (cutoff.getTime() < Date.now()) throw appError('INVALID_INPUT', '截止時間必須在現在之後。');
    const paymentMode = data.paymentMode === 'Hybrid' ? 'Hybrid' : 'Stored-value Only';

    const session = await insertRow('sessions', {
      class_id: ctx.classId,
      store_id: store.id,
      order_date: orderDate,
      cutoff_time: cutoff.toISOString(),
      payment_mode: paymentMode,
    });

    const notification = await sendPushToClass(ctx.classId, {
      title: '新的訂餐場次已開放',
      body: `「${store.name}」${orderDate} 開始訂餐，截止 ${formatTime(cutoff.toISOString())}。`,
      url: '/',
    });
    return { ok: true, sessionId: sid(session.id), notification };
  },

  async adminUpdateSessionCutoff(data, ctx) {
    const session = await findOne('sessions', { id: Number(data.sessionId) }, ctx.classId);
    if (!session) throw appError('NOT_FOUND', '場次不存在。');
    if (!session.is_open) throw appError('CLOSED', '此場次已結束，無法修改。');
    const cutoff = new Date(data.cutoffTime);
    if (!Number.isFinite(cutoff.getTime()) || cutoff.getTime() < Date.now()) {
      throw appError('INVALID_INPUT', '新的截止時間必須在現在之後。');
    }
    await updateRows('sessions', { id: session.id }, { cutoff_time: cutoff.toISOString(), cutoff_reminder_sent: false });
    return { ok: true };
  },

  async adminCloseSession(data, ctx) {
    const session = await findOne('sessions', { id: Number(data.sessionId) }, ctx.classId);
    if (!session) throw appError('NOT_FOUND', '場次不存在。');
    if (!session.is_open) throw appError('CLOSED', '此場次已結束。');
    await updateRows('sessions', { id: session.id }, { is_open: false, closed_at: new Date().toISOString(), cutoff_reminder_sent: true });

    const orders = await listRowsIn('orders', 'session_id', [session.id], { classId: ctx.classId });
    const userIds = [...new Set(orders.map(order => order.user_id).filter(value => value !== null && value !== undefined))];
    for (const userId of userIds) {
      await sendPushToUser(Number(userId), { title: '訂餐場次已截止', body: '此場次已提前結束，訂單與帳務維持不變。', url: '/' });
    }
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
};
