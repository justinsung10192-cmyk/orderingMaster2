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
    vegetarian: Boolean(item.is_vegetarian),
    price: num(item.price),
    options: Array.isArray(item.options) ? item.options : [],
  }));
  return { session, menuItems };
}

// 依座號／學號找出同學（數字會自動補零：'5' → '05'）
async function resolveUserBySeat(classId, raw) {
  const value = String(raw || '').trim();
  if (!value) throw appError('INVALID_INPUT', '請輸入座號或學號。');
  const candidates = [value];
  if (/^\d+$/.test(value)) {
    const padded = value.padStart(2, '0');
    if (padded !== value) candidates.push(padded);
  }
  for (const no of candidates) {
    let user = await findOne('users', { seat_no: no, is_disabled: false }, classId);
    if (user) return user;
    user = await findOne('users', { student_no: no, is_disabled: false }, classId);
    if (user) return user;
  }
  throw appError('NOT_FOUND', '找不到此座號／學號的同學。');
}

// 管理者補單：載入場次＋菜單＋目標同學（不受截止時間限制）
async function loadAdminOrderContext(classId, sessionId, seatNo) {
  const session = await findOne('sessions', { id: Number(sessionId) }, classId);
  if (!session || session.is_deleted) throw appError('NOT_FOUND', '找不到場次。');
  const user = await resolveUserBySeat(classId, seatNo);
  const menuItems = (await listMenuItemsForStore(classId, session.store_id, { includeInactive: false }))
    .filter((item) => !item.menu_date || item.menu_date === '1970-01-01' || item.menu_date === session.order_date)
    .map((item) => ({
      itemId: sid(item.id),
      name: item.name,
      dish: item.dish || '',
      vegetarian: Boolean(item.is_vegetarian),
      price: num(item.price),
      options: Array.isArray(item.options) ? item.options : [],
    }));
  return { session, user, menuItems };
}

// 計算請客折抵：請客場次下，免費額度 = min(訂單總額, 場次剩餘額度)
function computeTreatFromSession(session, total) {
  if (!session || !session.is_treat) return 0;
  const remaining = Math.max(0, num(session.treat_cap) - num(session.treat_used));
  return round2(Math.min(total, remaining));
}

export const actions = {
  async placeOrder(data, ctx) {
    const { session, menuItems } = await loadOrderContext(data, ctx);
    const computed = computeOrderItems(menuItems, data.selections);
    const note = String(data.note || '').slice(0, 120);

    const pureMode = await isPureBalanceMode(ctx.classId);
    const freshUser = await findOne('users', { id: ctx.user.id }, ctx.classId);
    const balance = num(freshUser.wallet_balance);
    const treatCovered = computeTreatFromSession(session, computed.total);
    const netTotal = round2(Math.max(0, computed.total - treatCovered));

    let walletPaid = 0;
    let cashOutstanding = 0;
    if (pureMode) {
      walletPaid = netTotal;
    } else if (data.useWallet !== false) {
      walletPaid = round2(Math.min(balance, netTotal));
      cashOutstanding = round2(netTotal - walletPaid);
    } else {
      cashOutstanding = netTotal;
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
      p_treat_covered: treatCovered,
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
    const treatCovered = computeTreatFromSession(session, computed.total);
    const netTotal = round2(Math.max(0, computed.total - treatCovered));

    let walletPaid = 0;
    let cashOutstanding = 0;
    if (pureMode) {
      walletPaid = netTotal;
    } else {
      walletPaid = data.useWallet !== false ? round2(Math.min(balance, netTotal)) : 0;
      if (walletPaidSoFar > 0) walletPaid = round2(Math.max(walletPaid, Math.min(walletPaidSoFar, netTotal)));
      cashOutstanding = round2(netTotal - walletPaid);
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
      p_treat_covered: treatCovered,
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

  // 管理者補單：依座號載入某場次的訂餐內容（含該同學既有訂單）
  async adminGetOrderContext(data, ctx) {
    const { session, user, menuItems } = await loadAdminOrderContext(ctx.classId, data.sessionId, data.seatNo);
    const store = await findOne('stores', { id: session.store_id }, ctx.classId);
    const pureMode = await isPureBalanceMode(ctx.classId);
    const existing = await findOne('orders', { session_id: session.id, user_id: user.id }, ctx.classId);
    return {
      user: { id: sid(user.id), seatNo: user.seat_no || user.student_no, name: user.student_name },
      session: {
        sessionId: sid(session.id),
        storeId: sid(session.store_id),
        storeName: store?.name || '未命名店家',
        orderDate: session.order_date,
        cutoffTime: session.cutoff_time,
        pureBalanceMode: pureMode,
        walletBalance: num(user.wallet_balance),
        menuItems: menuItems.map((item) => ({
          ...item,
          options: item.options.map((option, index) => ({ index, name: option.name, price: num(option.price), required: Boolean(option.required), group: String(option.group || '') })),
        })),
        existingOrder: existing ? publicOrder(existing) : null,
      },
    };
  },

  // 管理者補單：建立／修改指定同學的訂單（截止後亦可）
  async adminEditOrder(data, ctx) {
    const { session, user, menuItems } = await loadAdminOrderContext(ctx.classId, data.sessionId, data.seatNo);
    const computed = computeOrderItems(menuItems, data.selections);
    const note = String(data.note || '').slice(0, 120);
    const pureMode = await isPureBalanceMode(ctx.classId);
    const existing = await findOne('orders', { session_id: session.id, user_id: user.id }, ctx.classId);
    const balance = num(user.wallet_balance);
    const walletPaidSoFar = round2(num(existing?.wallet_paid || 0));

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
      p_user_id: user.id,
      p_session_id: session.id,
      p_total: computed.total,
      p_wallet_paid: walletPaid,
      p_cash_outstanding: cashOutstanding,
      p_pure_mode: pureMode,
      p_order_id: existing?.id || null,
      p_items: JSON.stringify(computed.items),
      p_note: note,
    });
    return {
      ok: true,
      orderId: sid(result.order_id),
      walletBalance: num(result.wallet_balance),
      paymentStatus: result.payment_status,
      seatNo: user.seat_no || user.student_no,
      name: user.student_name,
    };
  },
};
