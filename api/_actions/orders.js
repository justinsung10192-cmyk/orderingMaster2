// 動作：下單、修改訂單、取消訂單
import { appError, sid, num, round2 } from '../_lib/util.js';
import { findOne, callRpc, findStoreForClass } from '../_lib/db.js';
import { computeOrderItems, loadSessionWithMenu } from '../_lib/serialize.js';

function walletSplit(paymentMode, total, balance) {
  if (paymentMode === 'Stored-value Only') {
    if (balance < total) throw appError('INSUFFICIENT_BALANCE', '儲值餘額不足，無法送出訂單。');
    return { walletPaid: total, cashOutstanding: 0 };
  }
  const walletPaid = Math.min(total, Math.max(0, balance));
  return { walletPaid: round2(walletPaid), cashOutstanding: round2(total - walletPaid) };
}

async function assertCanOrder(session, ctx) {
  if (!session) throw appError('NOT_FOUND', '場次不存在。');
  if (String(session.class_id) !== String(ctx.classId)) throw appError('FORBIDDEN', '場次不屬於本班。');
  if (!session.is_open) throw appError('CLOSED', '此場次已停止接受訂單。');
  if (new Date(session.cutoff_time).getTime() < Date.now()) throw appError('CLOSED', '此場次已截止。');
  const orderStore = await findStoreForClass(session.store_id, ctx.classId);
  if (orderStore && orderStore.ordering_open === false) throw appError('CLOSED', '店家目前暫停訂購，請稍後再試。');
}

export const actions = {
  async placeOrder(data, ctx) {
    const session = await findOne('sessions', { id: Number(data.sessionId) }, ctx.classId);
    await assertCanOrder(session, ctx);
    const existing = await findOne('orders', { session_id: session.id, user_id: ctx.user.id });
    if (existing) throw appError('DUPLICATE', '你已在此場次訂餐，請直接修改訂單。');

    const { menuItems } = await loadSessionWithMenu(session);
    const summary = computeOrderItems(menuItems, data.items);
    const freshUser = await findOne('users', { id: ctx.user.id });
    const { walletPaid, cashOutstanding } = walletSplit(session.payment_mode, summary.total, num(freshUser.wallet_balance));

    const result = await callRpc('fn_settle_order', {
      p_class_id: ctx.classId,
      p_user_id: ctx.user.id,
      p_session_id: session.id,
      p_total: summary.total,
      p_wallet_paid: walletPaid,
      p_cash_outstanding: cashOutstanding,
      p_prior_paid: 0,
      p_order_id: null,
      p_items: summary.items,
      p_note: String(data.note || '').slice(0, 200),
    });
    return {
      ok: true,
      orderId: sid(result.order_id),
      walletBalance: num(result.wallet_balance),
      paymentStatus: result.payment_status,
    };
  },

  async updateOwnOrder(data, ctx) {
    const order = await findOne('orders', { id: Number(data.orderId), user_id: ctx.user.id }, ctx.classId);
    if (!order) throw appError('ORDER_NOT_FOUND', '找不到訂單。');
    const session = await findOne('sessions', { id: order.session_id }, ctx.classId);
    await assertCanOrder(session, ctx);
    if (order.pickup_status === 'PickedUp') throw appError('CLOSED', '餐點已取餐，無法修改。');
    if (order.payment_status === 'PaidCash') throw appError('CLOSED', '現金已結清，無法修改。');

    const { menuItems } = await loadSessionWithMenu(session);
    const summary = computeOrderItems(menuItems, data.items);
    const freshUser = await findOne('users', { id: ctx.user.id });
    const balance = num(freshUser.wallet_balance) + num(order.prior_paid);
    const { walletPaid, cashOutstanding } = walletSplit(session.payment_mode, summary.total, balance);

    const result = await callRpc('fn_settle_order', {
      p_class_id: ctx.classId,
      p_user_id: ctx.user.id,
      p_session_id: session.id,
      p_total: summary.total,
      p_wallet_paid: walletPaid,
      p_cash_outstanding: cashOutstanding,
      p_prior_paid: num(order.prior_paid),
      p_order_id: order.id,
      p_items: summary.items,
      p_note: String(data.note || '').slice(0, 200),
    });
    return {
      ok: true,
      orderId: sid(result.order_id),
      walletBalance: num(result.wallet_balance),
      paymentStatus: result.payment_status,
    };
  },

  async deleteOwnOrder(data, ctx) {
    const order = await findOne('orders', { id: Number(data.orderId), user_id: ctx.user.id }, ctx.classId);
    if (!order) throw appError('ORDER_NOT_FOUND', '找不到訂單。');
    const session = await findOne('sessions', { id: order.session_id }, ctx.classId);
    if (session && (!session.is_open || new Date(session.cutoff_time).getTime() < Date.now())) throw appError('CLOSED', '已截止，無法取消訂單。');
    if (order.pickup_status === 'PickedUp') throw appError('CLOSED', '餐點已取餐，無法取消。');

    const result = await callRpc('fn_refund_order', {
      p_class_id: ctx.classId,
      p_user_id: ctx.user.id,
      p_order_id: order.id,
    });
    return { ok: true, walletBalance: num(result.wallet_balance), refunded: num(result.refunded) };
  },
};
