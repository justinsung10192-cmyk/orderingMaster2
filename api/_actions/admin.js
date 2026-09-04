// 動作：管理員儀表板、帳號管理（含管理者安全防呆）、系統設定、匯總、催繳
import { appError, sid, num, round2, todayString, weekdayName, monthDay, mondayOf } from '../_lib/util.js';
import { findOne, listRows, listRowsIn, insertRow, updateRows, deleteRows, getClass, listStoresForClass } from '../_lib/db.js';
import { defaultPasswordCredentials, createPassword } from '../_lib/auth.js';
import { dashboardOrderRow, outstandingOf, publicUser, orderItems } from '../_lib/serialize.js';

// 班級至少保留一位管理者
async function ensureNotLastAdmin(classId, userId) {
  const admins = await listRows('users', { classId, filters: { role: 'Admin', is_disabled: false } });
  if (admins.length <= 1 && admins.some((admin) => String(admin.id) === String(userId))) {
    throw appError('LAST_ADMIN', '系統必須至少保留一位管理者。若要移除，請先將另一位同學設為管理。');
  }
}

async function loadDaySummary(classId, date) {
  const sessions = (await listRows('sessions', { classId, filters: { order_date: date }, order: 'cutoff_time' }))
    .filter((session) => !session.is_deleted);
  const stores = await listStoresForClass(classId);
  const storeById = new Map(stores.map((store) => [String(store.id), store]));

  let orders = [];
  if (sessions.length) {
    const allOrders = await listRowsIn('orders', 'session_id', sessions.map((session) => session.id), { classId });
    orders = allOrders.filter((order) => !order.is_deleted);
  }
  const userIds = [...new Set(orders.map((order) => order.user_id).filter((id) => id != null))];
  const users = userIds.length ? await listRowsIn('users', 'id', userIds, { classId }) : [];
  const userById = new Map(users.map((user) => [String(user.id), user]));

  const sessionById = new Map(sessions.map((session) => [String(session.id), session]));

  const rows = orders.map((order) => {
    const session = sessionById.get(String(order.session_id));
    return dashboardOrderRow(order, session, storeById.get(String(session?.store_id))?.name || '未命名店家', userById.get(String(order.user_id)));
  });

  const sessionStats = sessions.map((session) => {
    const sessionOrders = orders.filter((order) => String(order.session_id) === String(session.id));
    return {
      sessionId: sid(session.id),
      storeName: storeById.get(String(session.store_id))?.name || '未命名店家',
      cutoffTime: session.cutoff_time,
      orderCount: sessionOrders.length,
      totalAmount: round2(sessionOrders.reduce((sum, order) => sum + num(order.total_price), 0)),
      pickedUp: sessionOrders.filter((order) => order.pickup_status === 'PickedUp').length,
      unpaidAmount: round2(sessionOrders.reduce((sum, order) => sum + outstandingOf(order), 0)),
    };
  });

  const itemMap = new Map();
  orders.forEach((order) => {
    orderItems(order).forEach((item) => {
      const optKey = (item.options || []).map((option) => option.name).join('、');
      const key = `${item.itemName}|||${optKey}`;
      const entry = itemMap.get(key) || { name: item.itemName, options: (item.options || []).map((option) => option.name), quantity: 0 };
      entry.quantity += Number(item.quantity) || 0;
      itemMap.set(key, entry);
    });
  });
  const itemTotals = [...itemMap.values()].sort((a, b) => b.quantity - a.quantity);

  // 當天欠費名單（依座號排序，只列出仍有現金欠款的同學）
  const debtorMap = new Map();
  orders.forEach((order) => {
    const out = outstandingOf(order);
    if (out <= 0) return;
    const uid = String(order.user_id);
    const user = userById.get(uid);
    const entry = debtorMap.get(uid) || { userId: uid, seatNo: user?.seat_no || '', studentNo: user?.student_no || '', studentName: user?.student_name || '已刪除帳號', debt: 0 };
    entry.debt = round2(entry.debt + out);
    debtorMap.set(uid, entry);
  });
  const debtors = [...debtorMap.values()].sort((a, b) => num(a.seatNo) - num(b.seatNo));

  return {
    date,
    weekday: weekdayName(date),
    monthDay: monthDay(date),
    sessionStats,
    orders: rows,
    itemTotals,
    debtors,
    totals: {
      orderCount: rows.length,
      totalAmount: round2(rows.reduce((sum, row) => sum + row.totalPrice, 0)),
      unpaidAmount: round2(rows.reduce((sum, row) => sum + row.outstandingAmount, 0)),
      pickedUp: rows.filter((row) => row.pickupStatus === 'PickedUp').length,
    },
  };
}

export const actions = {
  async adminGetDashboard(data, ctx) {
    const date = String(data.date || todayString());
    const summary = await loadDaySummary(ctx.classId, date);
    // 催繳人數
    const monday = mondayOf();
    const overdue = await listRows('orders', { classId: ctx.classId });
    const overdueUserIds = new Set(
      overdue
        .filter((order) => !order.is_deleted && order.order_date < monday && outstandingOf(order) > 0)
        .map((order) => order.user_id),
    );
    return { ...summary, overdueCount: overdueUserIds.size };
  },

  async adminGetDaySummary(data, ctx) {
    const date = String(data.date || todayString());
    return loadDaySummary(ctx.classId, date);
  },

  // ---- 帳號管理 ----
  async adminListUsers(_data, ctx) {
    const users = await listRows('users', { classId: ctx.classId, order: 'seat_no' });
    const adminCount = users.filter((user) => user.role === 'Admin' && !user.is_disabled).length;
    return {
      adminCount,
      users: users.map((user) => publicUser(user)),
    };
  },

  async adminCreateUser(data, ctx) {
    const studentNo = String(data.studentNo || '').trim();
    const seatNo = String(data.seatNo || '').trim();
    const studentName = String(data.studentName || '').trim();
    const password = String(data.password || '');
    const role = data.role === 'Admin' ? 'Admin' : 'Student';
    if (!/^\d{1,30}$/.test(studentNo)) throw appError('INVALID_INPUT', '座號/學號格式不正確。');
    if (!studentName) throw appError('INVALID_INPUT', '請填寫姓名。');
    if (!password || password.length < 8) throw appError('WEAK_PASSWORD', '初始密碼至少須為 8 個字元。');

    const duplicate = await findOne('users', { class_id: ctx.classId, student_no: studentNo });
    if (duplicate) throw appError('DUPLICATE', '此座號/學號已存在。');

    const { salt, hash } = createPassword(password);
    const user = await insertRow('users', {
      class_id: ctx.classId,
      student_no: studentNo,
      seat_no: seatNo,
      student_name: studentName,
      password_hash: hash,
      salt,
      role,
      must_change_password: false,
    });
    return { ok: true, user: publicUser(user) };
  },

  async adminSetUserDisabled(data, ctx) {
    const target = await findOne('users', { id: Number(data.userId) }, ctx.classId);
    if (!target) throw appError('NOT_FOUND', '找不到使用者。');
    if (data.disabled && target.role === 'Admin') {
      await ensureNotLastAdmin(ctx.classId, target.id);
    }
    await updateRows('users', { id: target.id }, { is_disabled: Boolean(data.disabled) });
    return { ok: true };
  },

  async adminDeleteUser(data, ctx) {
    const target = await findOne('users', { id: Number(data.userId) }, ctx.classId);
    if (!target) throw appError('NOT_FOUND', '找不到使用者。');
    if (String(target.id) === String(ctx.user.id)) throw appError('FORBIDDEN', '無法刪除自己的帳號。');
    if (target.role === 'Admin') {
      await ensureNotLastAdmin(ctx.classId, target.id);
    }
    await deleteRows('users', { id: target.id });
    return { ok: true };
  },

  async adminResetPassword(data, ctx) {
    const target = await findOne('users', { id: Number(data.userId) }, ctx.classId);
    if (!target) throw appError('NOT_FOUND', '找不到使用者。');
    const { salt, hash } = defaultPasswordCredentials();
    await updateRows('users', { id: target.id }, {
      password_hash: hash,
      salt,
      must_change_password: true,
      updated_at: new Date().toISOString(),
    });
    return { ok: true, message: '已重設為預設密碼，該同學下次登入需重新設定。' };
  },

  async adminSetRole(data, ctx) {
    const target = await findOne('users', { id: Number(data.userId) }, ctx.classId);
    if (!target) throw appError('NOT_FOUND', '找不到使用者。');
    const role = data.role === 'Admin' ? 'Admin' : 'Student';
    if (role === 'Student' && target.role === 'Admin') {
      await ensureNotLastAdmin(ctx.classId, target.id);
    }
    await updateRows('users', { id: target.id }, { role });
    return { ok: true };
  },

  // ---- 系統設定 ----
  async adminGetSettings(_data, ctx) {
    const classRow = await getClass(ctx.classId);
    return {
      className: classRow.name,
      pureBalanceMode: Boolean(classRow.pure_balance_mode),
      overdueRemindDays: Number(classRow.overdue_remind_days) || 1,
    };
  },

  async adminSaveSettings(data, ctx) {
    const className = String(data.className || '').trim();
    if (className) {
      await updateRows('classes', { class_id: ctx.classId }, { name: className });
    }
    await updateRows('classes', { class_id: ctx.classId }, { pure_balance_mode: Boolean(data.pureBalanceMode) });
    const remindDays = Number(data.overdueRemindDays);
    if (Number.isFinite(remindDays) && remindDays >= 1 && remindDays <= 30) {
      await updateRows('classes', { class_id: ctx.classId }, { overdue_remind_days: Math.round(remindDays) });
    }
    return { ok: true };
  },

  // ---- 催繳 ----
  async adminGetOverdueList(_data, ctx) {
    const monday = mondayOf();
    const orders = (await listRows('orders', { classId: ctx.classId })).filter(
      (order) => !order.is_deleted && order.order_date < monday && outstandingOf(order) > 0,
    );
    const userIds = [...new Set(orders.map((order) => order.user_id).filter((id) => id != null))];
    const users = userIds.length ? await listRowsIn('users', 'id', userIds, { classId }) : [];
    const userById = new Map(users.map((user) => [String(user.id), user]));

    const byUser = new Map();
    orders.forEach((order) => {
      const uid = String(order.user_id);
      const entry = byUser.get(uid) || { userId: uid, orders: [], debt: 0 };
      entry.orders.push({ orderDate: order.order_date, totalPrice: num(order.total_price), outstanding: outstandingOf(order) });
      entry.debt = round2(entry.debt + outstandingOf(order));
      byUser.set(uid, entry);
    });

    const list = [...byUser.values()]
      .map((entry) => {
        const user = userById.get(entry.userId);
        return {
          userId: entry.userId,
          seatNo: user?.seat_no || '',
          studentNo: user?.student_no || '',
          studentName: user?.student_name || '已刪除帳號',
          debt: entry.debt,
          orderCount: entry.orders.length,
        };
      })
      .sort((a, b) => num(a.seatNo) - num(b.seatNo));

    return { monday, list, totalDebt: round2(list.reduce((sum, row) => sum + row.debt, 0)) };
  },

  // 刪除所有業務資料（訂單/交易/場次/投票/放假/店家/菜單），並將儲值餘額歸零。帳號保留。
  async adminResetAllData(_data, ctx) {
    const classId = ctx.classId;
    // 依外鍵順序清除（先 orders 再 sessions，避免 sessions.store_id 被擋）
    for (const table of ['orders', 'transactions', 'verification_records', 'votes', 'sessions', 'holidays', 'menu_items', 'recurring_menu', 'stores']) {
      await deleteRows(table, { class_id: classId });
    }
    await updateRows('users', { class_id: classId }, { wallet_balance: 0, updated_at: new Date().toISOString() });
    return { ok: true };
  },
};
