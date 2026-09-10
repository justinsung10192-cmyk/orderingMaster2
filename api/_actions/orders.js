// 動作：下單、修改、刪除訂單（截止前可自由修改）
import { appError, sid, num, round2, todayString } from '../_lib/util.js';
import { findOne, callRpc, listMenuItemsForStore, isPureBalanceMode } from '../_lib/db.js';
import { computeOrderItems, publicOrder } from '../_lib/serialize.js';

async function loadOrderContext(data, ctx) {
  const session = await findOne('sessions', { id: Number(data.sessionId) }, ctx.classId);
  if (!session || session.is_deleted) throw appError('NOT_FOUND', '找不到場次。');
  if (!session.is_open) throw appError('CLOSED', '此場次尚未開放或已結束。');
  if (session.order_date < todayString()) throw appError('CLOSED', '此場次日期已過，無法訂餐。');
  if (new Date(session.cutoff_time).getTime() < Date.now()) {
    throw appError('CUTOFF_PASSED', '已超過截止時間，無法修改訂單。');
  }
  const menuItems = (await listMenuItemsForStore(ctx.classId, session.store_id, { includeInactive: false }))
    .filter((item) => !item.menu_date || item.menu_date === '1970-01-01' || item.menu_date === session.order_date)
    .map((item) => ({
    itemId: sid(item.id),
    name: item.name,
    dish: item.dish || '',
    price: num(item.price),
    options: Array.isArray(item.options) ? item.options : [],
  }));
  return { session, menuItems };
}

export const actions = {
  async placeOrder(data, ctx) {
    const { session, menuItems } = await loadOrderContext(data, ctx);
    const computed = computeOrderItems(menuItems, data.selections);
    const note = String(data.note || '').slice(0, 120);

    const pureMode = await isPureBalanceMode(ctx.classId);
    const freshUser = await findOne('users', { id: ctx.user.id }, ctx.classId);
    const balance = num(freshUser.wallet_balance);

    let walletPaid = 0;
    let cashOutstanding = 0;
    if (pureMode) {
      walletPaid = computed.total;
    } else if (data.useWallet !== false) {
      walletPaid = round2(Math.min(balance, computed.total));
      cashOutstanding = round2(computed.total - walletPaid);
    } else {
      cashOutstanding = computed.total;
    }

    const existing = await findOne('orders', { session_id: session.id, user_id: ctx.user.id }, ctx.classId);
    if (existing) throw appError('DUPLICATE', '此場次已有訂單，請直接修改。');

    const result = await callRpc('fn_settle_order', {
      p_class_id: ctx.classId,
      p_user_id: ctx.user.id,
      p_session_id: session.id,
      p_total: computed.total,
      p_wallet_paid: walletPaid,
      p_cash_outstanding: cashOutstanding,
      p_pure_mode: pureMode,
      p_items: JSON.stringify(computed.items),
      p_note: note,
    });
    return { ok: true, orderId: sid(result.order_id), walletBalance: num(result.wallet_balance), paymentStatus: result.payment_status };
  },

  async updateOrder(data, ctx) {
    const { session, menuItems } = await loadOrderContext(data, ctx);
    const existing = await findOne('orders', { session_id: session.id, user_id: ctx.user.id }, ctx.classId);
    if (!existing) throw appError('NOT_FOUND', '找不到原訂單。');

    const computed = computeOrderItems(menuItems, data.selections);
    const note = String(data.note || '').slice(0, 120);

    const pureMode = await isPureBalanceMode(ctx.classId);
    const freshUser = await findOne('users', { id: ctx.user.id }, ctx.classId);
    const balance = num(freshUser.wallet_balance);
    // 已用儲值金支付的部分不得退回現金（避免把錢包餘額轉成現金欠款）
    const walletPaidSoFar = round2(num(existing.wallet_paid));

    let walletPaid = 0;
    let cashOutstanding = 0;
    if (pureMode) {
      walletPaid = computed.total;
    } else {
      walletPaid = data.useWallet !== false ? round2(Math.min(balance, computed.total)) : 0;
      if (walletPaidSoFar > 0) walletPaid = round2(Math.max(walletPaid, Math.min(walletPaidSoFar, computed.total)));
      cashOutstanding = round2(computed.total - walletPaid);
    }

    const result = await callRpc('fn_settle_order', {
      p_class_id: ctx.classId,
      p_user_id: ctx.user.id,
      p_session_id: session.id,
      p_total: computed.total,
      p_wallet_paid: walletPaid,
      p_cash_outstanding: cashOutstanding,
      p_pure_mode: pureMode,
      p_order_id: existing.id,
      p_items: JSON.stringify(computed.items),
      p_note: note,
    });
    return { ok: true, orderId: sid(result.order_id), walletBalance: num(result.wallet_balance), paymentStatus: result.payment_status };
  },

  async deleteOrder(data, ctx) {
    const session = await findOne('sessions', { id: Number(data.sessionId) }, ctx.classId);
    if (!session || session.is_deleted) throw appError('NOT_FOUND', '找不到場次。');
    if (!session.is_open) throw appError('CLOSED', '此場次尚未開放或已結束。');
    if (session.order_date < todayString()) throw appError('CLOSED', '此場次日期已過，無法刪除訂單。');
    if (new Date(session.cutoff_time).getTime() < Date.now()) {
      throw appError('CUTOFF_PASSED', '已超過截止時間，無法刪除訂單。');
    }
    const existing = await findOne('orders', { session_id: session.id, user_id: ctx.user.id }, ctx.classId);
    if (!existing) throw appError('NOT_FOUND', '找不到訂單。');

    const result = await callRpc('fn_refund_order', {
      p_class_id: ctx.classId,
      p_user_id: ctx.user.id,
      p_order_id: existing.id,
    });
    return { ok: true, walletBalance: num(result.wallet_balance), refunded: num(result.refunded) };
  },

  // 管理者幫某位同學取消訂單並退款（已付儲值金者會退回錢包）
  async adminCancelOrder(data, ctx) {
    const order = await findOne('orders', { id: Number(data.orderId) }, ctx.classId);
    if (!order) throw appError('NOT_FOUND', '找不到訂單。');
    const result = await callRpc('fn_refund_order', {
      p_class_id: ctx.classId,
      p_user_id: order.user_id,
      p_order_id: order.id,
    });
    return { ok: true, refunded: num(result.refunded), walletBalance: num(result.wallet_balance) };
  },
};
