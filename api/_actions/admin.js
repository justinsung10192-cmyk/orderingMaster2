// 動作：管理員儀表板、帳號管理（含管理者安全防呆）、系統設定、匯總、催繳
import { appError, sid, num, round2, todayString, weekdayName, monthDay } from '../_lib/util.js';
import { findOne, listRows, listRowsIn, insertRow, updateRows, deleteRows, getClass, listStoresForClass, supabase } from '../_lib/db.js';
import { defaultPasswordCredentials, createPassword } from '../_lib/auth.js';
import { dashboardOrderRow, outstandingOf, publicUser, orderItems, itemNameOf } from '../_lib/serialize.js';

// 班級至少保留一位管理者
async function ensureNotLastAdmin(classId, userId) {
  const admins = await listRows('users', { classId, filters: { role: 'Admin', is_disabled: false } });
  if (admins.length <= 1 && admins.some((admin) => String(admin.id) === String(userId))) {
    throw appError('LAST_ADMIN', '系統必須至少保留一位管理者。若要移除，請先將另一位同學設為管理。');
  }
}

// 今日值日生：手動指派優先，否則依座號輪值（自最早場次日起算、假日不排也不計）
async function computeDuty(classId, date) {
  // 手動指派優先
  const manual = await listRows('duty_assignments', { classId, filters: { duty_date: date } });
  if (manual.length) {
    const userIds = manual.map((m) => m.user_id);
    const users = userIds.length ? await listRowsIn('users', 'id', userIds, { classId }) : [];
    const userById = new Map(users.map((u) => [String(u.id), u]));
    return manual.map((m) => { const u = userById.get(String(m.user_id)); return { id: sid(u?.id), seatNo: u?.seat_no || '', name: u?.student_name || '已刪除帳號', manual: true }; });
  }
  // 假日不排值日
  const holidays = await listRows('holidays', { classId });
  const holidayDates = new Set(holidays.map((h) => h.holiday_date));
  if (holidayDates.has(date)) return [];
  const allUsers = await listRows('users', { classId });
  const eligible = allUsers
    .filter((user) => !user.is_disabled && !user.duty_exempt)
    .sort((a, b) => num(a.seat_no) - num(b.seat_no));
  if (!eligible.length) return [];
  // 參考日 = 最早場次日期（第一個上課日，由 1、2 號開始）
  const { data: firstSessions, error: fsErr } = await supabase
    .from('sessions')
    .select('order_date')
    .eq('class_id', classId)
    .eq('is_deleted', false)
    .order('order_date', { ascending: true })
    .limit(1);
  const refDate = (!fsErr && firstSessions?.[0]?.order_date) || date;
  let dayIndex = 0;
  const d = new Date(`${refDate}T00:00:00`);
  const target = new Date(`${date}T00:00:00`);
  while (d < target) {
    d.setDate(d.getDate() + 1);
    const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (holidayDates.has(ds)) continue;
    dayIndex += 1;
  }
  const count = eligible.length;
  const take = count >= 2 ? 2 : 1;
  const out = [];
  for (let i = 0; i < take; i += 1) {
    const u = eligible[(dayIndex + i) % count];
    out.push({ id: sid(u.id), seatNo: u.seat_no, name: u.student_name });
  }
  return out;
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
    // 本場次品項彙總（分場次，不混在一起）
    const itemMap = new Map();
    sessionOrders.forEach((order) => {
      orderItems(order).forEach((item) => {
        const optKey = (item.options || []).map((option) => option.name).sort().join('、');
        const key = `${item.itemName}|||${optKey}`;
        const entry = itemMap.get(key) || { name: item.itemName, options: (item.options || []).map((option) => option.name).sort(), quantity: 0 };
        entry.quantity += Number(item.quantity) || 0;
        itemMap.set(key, entry);
      });
    });
    const itemTotals = [...itemMap.values()].sort((a, b) => b.quantity - a.quantity);
    // 尚未取餐名單（依座號排序）
    const notPickedUp = sessionOrders
      .filter((order) => order.pickup_status !== 'PickedUp')
      .map((order) => {
        const user = userById.get(String(order.user_id));
        return { orderId: sid(order.id), userId: sid(order.user_id), seatNo: user?.seat_no || '', studentName: user?.student_name || '已刪除帳號', itemName: itemNameOf(order) };
      })
      .sort((a, b) => num(a.seatNo) - num(b.seatNo));
    return {
      sessionId: sid(session.id),
      storeName: storeById.get(String(session.store_id))?.name || '未命名店家',
      cutoffTime: session.cutoff_time,
      orderCount: sessionOrders.length,
      totalAmount: round2(sessionOrders.reduce((sum, order) => sum + num(order.total_price), 0)),
      pickedUp: sessionOrders.filter((order) => order.pickup_status === 'PickedUp').length,
      notPickedUpCount: notPickedUp.length,
      notPickedUp,
      unpaidAmount: round2(sessionOrders.reduce((sum, order) => sum + outstandingOf(order), 0)),
      itemTotals,
    };
  });

  const itemMap = new Map();
  orders.forEach((order) => {
    orderItems(order).forEach((item) => {
      const optKey = (item.options || []).map((option) => option.name).sort().join('、');
      const key = `${item.itemName}|||${optKey}`;
      const entry = itemMap.get(key) || { name: item.itemName, options: (item.options || []).map((option) => option.name).sort(), quantity: 0 };
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
    // 效能優化：只載入「未結清」訂單（避免全表掃描已結清歷史）
    const { data: unpaidRows, error } = await supabase
      .from('orders')
      .select('*')
      .eq('class_id', ctx.classId)
      .eq('is_deleted', false)
      .in('payment_status', ['UnpaidCash', 'PartiallyPaid']);
    if (error) throw appError('DB_ERROR', error.message);
    const activeOrders = unpaidRows || [];

    // 未繳總整理：所有仍有現金欠款的同學（不限日期），依座號排序
    const debtorUserIds = [...new Set(activeOrders.map((order) => order.user_id).filter((id) => id != null))];
    const debtorUsers = debtorUserIds.length ? await listRowsIn('users', 'id', debtorUserIds, { classId: ctx.classId }) : [];
    const debtorUserById = new Map(debtorUsers.map((user) => [String(user.id), user]));
    const debtMap = new Map();
    activeOrders.forEach((order) => {
      const out = outstandingOf(order);
      if (out <= 0) return;
      const uid = String(order.user_id);
      const user = debtorUserById.get(uid);
      const entry = debtMap.get(uid) || { userId: uid, seatNo: user?.seat_no || '', studentNo: user?.student_no || '', studentName: user?.student_name || '已刪除帳號', debt: 0, orderCount: 0 };
      entry.debt = round2(entry.debt + out);
      entry.orderCount += 1;
      debtMap.set(uid, entry);
    });
    const debtors = [...debtMap.values()].sort((a, b) => num(a.seatNo) - num(b.seatNo));

    // 今日值日生：手動指派優先，否則依座號輪值（假日不排、不計）
    const dutyStudents = await computeDuty(ctx.classId, date);

    return { ...summary, debtors, overdueCount: debtors.length, dutyStudents };
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
    // 使該同學現有的登入 Token 全部失效
    await deleteRows('auth_tokens', { user_id: target.id });
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
      overdueRemindHours: Number(classRow.overdue_remind_hours) || 24,
    };
  },

  async adminSaveSettings(data, ctx) {
    const className = String(data.className || '').trim();
    if (className) {
      await updateRows('classes', { class_id: ctx.classId }, { name: className });
    }
    await updateRows('classes', { class_id: ctx.classId }, { pure_balance_mode: Boolean(data.pureBalanceMode) });
    const remindHours = Number(data.overdueRemindHours);
    if ([6, 12, 24].includes(remindHours)) {
      await updateRows('classes', { class_id: ctx.classId }, { overdue_remind_hours: remindHours });
    }
    return { ok: true };
  },

  // ---- 催繳 ----
  async adminGetOverdueList(_data, ctx) {
    // 只查未結清訂單（與儀表板「未繳總整理」一致且更快速）
    const { data: unpaidRows, error } = await supabase
      .from('orders')
      .select('*')
      .eq('class_id', ctx.classId)
      .eq('is_deleted', false)
      .in('payment_status', ['UnpaidCash', 'PartiallyPaid']);
    if (error) throw appError('DB_ERROR', error.message);
    const orders = (unpaidRows || []).filter((order) => outstandingOf(order) > 0);
    const userIds = [...new Set(orders.map((order) => order.user_id).filter((id) => id != null))];
    const users = userIds.length ? await listRowsIn('users', 'id', userIds, { classId }) : [];
    const userById = new Map(users.map((user) => [String(user.id), user]));

    const byUser = new Map();
    orders.forEach((order) => {
      const uid = String(order.user_id);
      const entry = byUser.get(uid) || { userId: uid, orderCount: 0, debt: 0 };
      entry.orderCount += 1;
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
          orderCount: entry.orderCount,
        };
      })
      .sort((a, b) => num(a.seatNo) - num(b.seatNo));

    return { list, totalDebt: round2(list.reduce((sum, row) => sum + row.debt, 0)) };
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

  // 設定/取消「免值日」
  async adminSetDutyExempt(data, ctx) {
    const target = await findOne('users', { id: Number(data.userId) }, ctx.classId);
    if (!target) throw appError('NOT_FOUND', '找不到使用者。');
    await updateRows('users', { id: target.id }, { duty_exempt: Boolean(data.dutyExempt) });
    return { ok: true };
  },

  // 匯出完整資料備份（JSON）
  async adminExportBackup(_data, ctx) {
    const tables = ['classes', 'users', 'stores', 'menu_items', 'sessions', 'orders', 'transactions', 'verification_records', 'votes', 'holidays', 'recurring_menu', 'app_settings'];
    const dump = {};
    for (const table of tables) {
      const { data, error } = await supabase.from(table).select('*').eq('class_id', ctx.classId);
      if (error) throw appError('DB_ERROR', error.message);
      dump[table] = data || [];
    }
    // 全域設定（class_id=''）一併備份
    const { data: globalSettings, error: gErr } = await supabase.from('app_settings').select('*').eq('class_id', '');
    if (!gErr) dump.app_settings = [...(dump.app_settings || []), ...(globalSettings || [])];
    // 移除敏感欄位（密碼雜湊、salt、auth_version），避免備份檔外洩登入憑證
    if (Array.isArray(dump.users)) {
      dump.users = dump.users.map(({ password_hash, salt, auth_version, ...rest }) => rest);
    }
    return { exportedAt: new Date().toISOString(), classId: ctx.classId, backup: dump };
  },

  // 手動指派值日生（某日）
  async adminSetDuty(data, ctx) {
    const date = String(data.date || '').trim();
    const userIds = Array.isArray(data.userIds) ? data.userIds.map(Number).filter(Boolean) : [];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw appError('INVALID_INPUT', '日期不正確。');
    await deleteRows('duty_assignments', { class_id: ctx.classId, duty_date: date });
    for (const userId of userIds) {
      await insertRow('duty_assignments', { class_id: ctx.classId, duty_date: date, user_id: userId });
    }
    return { ok: true };
  },

  // 清除某日手動指派（回到自動輪值）
  async adminClearDuty(data, ctx) {
    const date = String(data.date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw appError('INVALID_INPUT', '日期不正確。');
    await deleteRows('duty_assignments', { class_id: ctx.classId, duty_date: date });
    return { ok: true };
  },

  // 還原資料備份（帳號/店家/菜單/放假/固定店家/設定；訂單與場次為暫時資料不還原）
  async adminRestoreBackup(data, ctx) {
    const dump = data?.backup;
    if (!dump || !dump.tables || !Array.isArray(dump.tables.users)) throw appError('INVALID_INPUT', '備份資料格式不正確。');
    const tables = dump.tables;
    const classId = ctx.classId;

    // 1) 還原帳號（依 student_no 對應，保留原 id）：錢包、角色、停用、免值日
    let usersRestored = 0;
    for (const row of tables.users.filter((r) => r.class_id === classId)) {
      if (!row.student_no) continue;
      const { error } = await supabase.from('users').update({
        wallet_balance: num(row.wallet_balance),
        role: row.role === 'Admin' ? 'Admin' : 'Student',
        is_disabled: Boolean(row.is_disabled),
        duty_exempt: Boolean(row.duty_exempt),
        student_name: row.student_name || '',
        seat_no: row.seat_no || '',
      }).eq('class_id', classId).eq('student_no', row.student_no);
      if (!error) usersRestored += 1;
    }

    // 2) 清空可重建表
    for (const t of ['orders', 'transactions', 'verification_records', 'votes', 'sessions', 'holidays', 'menu_items', 'recurring_menu', 'stores', 'duty_assignments']) {
      await deleteRows(t, { class_id: classId });
    }

    // 3) 店家（建立舊→新 id 對照）
    const storeIdMap = new Map();
    for (const row of tables.stores.filter((r) => r.class_id === classId)) {
      const { data: ns, error } = await supabase.from('stores').insert({ class_id: classId, name: row.name, is_active: Boolean(row.is_active), sort_order: num(row.sort_order) }).select('id').single();
      if (!error && ns) storeIdMap.set(String(row.id), ns.id);
    }

    // 4) 菜單
    for (const row of tables.menu_items.filter((r) => r.class_id === classId)) {
      const newStoreId = storeIdMap.get(String(row.store_id));
      if (!newStoreId) continue;
      await supabase.from('menu_items').insert({ class_id: classId, store_id: newStoreId, name: row.name, dish: row.dish || '', price: num(row.price), options: row.options || [], menu_date: row.menu_date || '1970-01-01', sort_order: num(row.sort_order), is_active: Boolean(row.is_active) });
    }

    // 5) 放假
    for (const row of tables.holidays.filter((r) => r.class_id === classId)) {
      await supabase.from('holidays').insert({ class_id: classId, holiday_date: row.holiday_date, note: row.note || '' });
    }

    // 6) 固定店家
    for (const row of tables.recurring_menu.filter((r) => r.class_id === classId)) {
      const newStoreId = storeIdMap.get(String(row.store_id));
      if (!newStoreId) continue;
      await supabase.from('recurring_menu').insert({ class_id: classId, store_id: newStoreId, cutoff_time: row.cutoff_time || '10:00', is_active: Boolean(row.is_active) });
    }

    // 7) 設定
    for (const row of tables.app_settings.filter((r) => r.class_id === classId || r.class_id === '')) {
      await supabase.from('app_settings').upsert({ class_id: row.class_id || '', key: row.key, value: row.value || '' }, { onConflict: 'class_id,key' });
    }

    return { ok: true, usersRestored, storesRestored: storeIdMap.size };
  },
};
