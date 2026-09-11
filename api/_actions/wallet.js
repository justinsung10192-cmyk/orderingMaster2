// 動作：錢包歷史、管理員儲值、現金結清、餘額手動調整
import { appError, sid, num, round2 } from '../_lib/util.js';
import { findOne, listRows, listRowsIn, callRpc, listStoresForClass } from '../_lib/db.js';
import { publicUser, outstandingOf, itemNameOf } from '../_lib/serialize.js';

const KIND_LABEL = {
  TopUp: '儲值',
  Wallet: '訂餐扣款',
  Cash: '現金',
  Refund: '退款',
  Manual: '手動調整',
};

export const actions = {
  async getWalletHistory(_data, ctx) {
    const transactions = await listRows('transactions', {
      classId: ctx.classId,
      filters: { user_id: ctx.user.id },
      order: 'created_at',
      orderAscending: false,
      limit: 200,
    });
    const allOrders = await listRows('orders', { classId: ctx.classId, filters: { user_id: ctx.user.id } });
    const activeOrders = allOrders.filter((order) => !order.is_deleted);
    const cashUnpaid = round2(activeOrders.reduce((sum, order) => sum + outstandingOf(order), 0));
    const freshUser = await findOne('users', { id: ctx.user.id });

    const sessionIds = [...new Set(activeOrders.map((order) => order.session_id))];
    const sessions = sessionIds.length ? await listRowsIn('sessions', 'id', sessionIds, { classId: ctx.classId }) : [];
    const sessionById = new Map(sessions.map((session) => [String(session.id), session]));
    const stores = await listStoresForClass(ctx.classId);
    const storeById = new Map(stores.map((store) => [String(store.id), store]));

    const recentOrders = activeOrders
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, 30);

    return {
      user: publicUser(freshUser),
      cashUnpaid,
      transactions: transactions.map((transaction) => ({
        type: KIND_LABEL[transaction.kind] || transaction.kind,
        amount: num(transaction.amount),
        note: transaction.note || '',
        timestamp: transaction.created_at,
      })),
      orders: recentOrders.map((order) => {
        const session = sessionById.get(String(order.session_id));
        const store = session ? storeById.get(String(session.store_id)) : null;
        return {
          orderId: sid(order.id),
          sessionId: sid(order.session_id),
          orderDate: session?.order_date || '',
          storeName: store?.name || '未指定店家',
          itemName: itemNameOf(order),
          totalPrice: num(order.total_price),
          outstandingAmount: outstandingOf(order),
          paymentStatus: order.payment_status,
          pickupStatus: order.pickup_status,
        };
      }),
    };
  },

  async adminTopUp(data, ctx) {
    const amount = Number(data.amount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 100000) throw appError('INVALID_INPUT', '請輸入正確的儲值金額。');
    const target = await findOne('users', { id: Number(data.userId) }, ctx.classId);
    if (!target) throw appError('NOT_FOUND', '找不到使用者。');
    const result = await callRpc('fn_topup', {
      p_class_id: ctx.classId,
      p_user_id: target.id,
      p_amount: amount,
    });
    return {
      ok: true,
      walletBalance: num(result.wallet_balance),
      appliedToDebt: num(result.applied_to_debt),
      remainingDebt: num(result.remaining_debt),
      message: '儲值完成。',
    };
  },

  async adminSettleCash(data, ctx) {
    const target = await findOne('users', { id: Number(data.userId) }, ctx.classId);
    if (!target) throw appError('NOT_FOUND', '找不到使用者。');
    const orderIds = (data.orderIds || []).map(Number).filter(Boolean);
    if (!orderIds.length) throw appError('INVALID_INPUT', '沒有可結清的訂單。');
    const result = await callRpc('fn_settle_cash', {
      p_class_id: ctx.classId,
      p_user_id: target.id,
      p_order_ids: orderIds,
    });
    return { ok: true, settled: num(result.settled) };
  },

  // 一週結算：把該週所有「現金未繳」的訂單一次結清（與一般場次一樣每週收一次錢）
  async adminSettleWeek(data, ctx) {
    const weekLabel = String(data.weekLabel || '').trim();
    if (!/^\d{4}-W\d{1,2}$/.test(weekLabel)) throw appError('INVALID_INPUT', '週別格式不正確。');
    const sessions = await listRows('sessions', { classId: ctx.classId, filters: { week_label: weekLabel, is_deleted: false } });
    if (!sessions.length) throw appError('NOT_FOUND', '該週沒有場次。');
    const sessionIds = sessions.map((session) => session.id);
    const orders = await listRowsIn('orders', 'session_id', sessionIds, { classId: ctx.classId });
    const unpaid = orders.filter((order) => !order.is_deleted && order.user_id && (order.payment_status === 'UnpaidCash' || order.payment_status === 'PartiallyPaid'));
    if (!unpaid.length) throw appError('NOT_FOUND', '該週沒有待結算的訂單。');

    // 按使用者分組，逐人呼叫 fn_settle_cash
    const byUser = new Map();
    for (const order of unpaid) {
      if (!byUser.has(order.user_id)) byUser.set(order.user_id, []);
      byUser.get(order.user_id).push(order.id);
    }
    let settledAmount = 0;
    for (const [userId, orderIds] of byUser) {
      const result = await callRpc('fn_settle_cash', { p_class_id: ctx.classId, p_user_id: userId, p_order_ids: orderIds });
      settledAmount += num(result.settled);
    }
    return { ok: true, weekLabel, settledOrders: unpaid.length, settledAmount };
  },

  async adminManualBalance(data, ctx) {
    const amount = Number(data.amount);
    if (!Number.isFinite(amount) || amount === 0 || Math.abs(amount) > 100000) throw appError('INVALID_INPUT', '請輸入正確的調整金額。');
    const target = await findOne('users', { id: Number(data.userId) }, ctx.classId);
    if (!target) throw appError('NOT_FOUND', '找不到使用者。');
    const note = String(data.note || '').slice(0, 120) || '餘額手動調整';
    const result = await callRpc('fn_manual_balance', {
      p_class_id: ctx.classId,
      p_user_id: target.id,
      p_amount: amount,
      p_note: note,
    });
    return { ok: true, walletBalance: num(result.wallet_balance) };
  },
};
