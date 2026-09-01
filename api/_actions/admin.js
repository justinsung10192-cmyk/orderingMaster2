// 動作：管理員（儀表板、菜單、帳號、設定、邀請碼）
import { appError, sid, num, round2, sha256Hex, todayString } from '../_lib/util.js';
import { supabase, findOne, listRows, listRowsIn, insertRow, updateRows, deleteRows, countRows, getAppSetting, setAppSetting, listStoresForClass, callRpc } from '../_lib/db.js';
import { bumpAuthVersion, createInviteCodeValue } from '../_lib/auth.js';
import { outstandingOf, dashboardOrderRow } from '../_lib/serialize.js';
import { mailConfigured } from '../_lib/mail.js';

export const actions = {
  async getAdminDashboard(data, ctx) {
    const classId = ctx.classId;
    const date = String(data.orderDate || todayString());
    const rawSessions = await listRows('sessions', { classId, filters: { order_date: date }, order: 'cutoff_time' });
    const sessions = rawSessions.filter(s => !s.is_deleted);
    const rawOrders = sessions.length ? await listRowsIn('orders', 'session_id', sessions.map(session => session.id), { classId }) : [];
    const orders = rawOrders.filter(o => !o.is_deleted);
    const userIds = [...new Set(orders.map(order => order.user_id).filter(value => value !== null && value !== undefined))];
    const users = userIds.length ? await listRowsIn('users', 'id', userIds.map(Number), { classId }) : [];
    const userById = new Map(users.map(user => [String(user.id), user]));
    const storeById = new Map((await listStoresForClass(ctx.classId)).map(store => [String(store.id), store]));
    const sessionById = new Map(sessions.map(session => [String(session.id), session]));

    let totalMeals = 0;
    let totalReceivable = 0;
    let pickedUp = 0;
    const unpaidByUser = new Map();
    orders.forEach(order => {
      const quantity = (order.items || []).reduce((sum, item) => sum + num(item.quantity), 0);
      totalMeals += quantity;
      totalReceivable += num(order.total_price);
      if (order.pickup_status === 'PickedUp') pickedUp += quantity;
      const outstanding = outstandingOf(order);
      if (outstanding > 0) unpaidByUser.set(String(order.user_id), (unpaidByUser.get(String(order.user_id)) || 0) + outstanding);
    });

    const rows = orders.map(order => {
      const session = sessionById.get(String(order.session_id));
      return dashboardOrderRow(order, session, storeById.get(String(session.store_id))?.name || '未命名店家', userById.get(String(order.user_id)));
    });
    rows.sort((a, b) => String(a.seatNo).localeCompare(String(b.seatNo), 'zh-Hant-TW', { numeric: true }));

    const summaries = sessions.map(session => {
      const sessionOrders = orders.filter(order => String(order.session_id) === String(session.id));
      const itemsMap = new Map();
      let orderCount = 0;
      let meals = 0;
      let unpaid = 0;
      let picked = 0;
      let receivable = 0;
      sessionOrders.forEach(order => {
        orderCount += 1;
        const quantity = (order.items || []).reduce((sum, item) => sum + num(item.quantity), 0);
        meals += quantity;
        receivable += num(order.total_price);
        if (order.pickup_status === 'PickedUp') picked += quantity;
        if (outstandingOf(order) > 0) unpaid += 1;
        (order.items || []).forEach(item => {
          const optionsText = (item.selectedOptions || []).map(option => option.name).join('、');
          const key = `${String(item.itemId)}|${optionsText}`;
          const entry = itemsMap.get(key) || {
            itemName: item.itemName,
            selectedOptions: optionsText,
            orderCount: 0,
            totalQuantity: 0,
          };
          entry.orderCount += 1;
          entry.totalQuantity += num(item.quantity);
          itemsMap.set(key, entry);
        });
      });
      return {
        sessionId: sid(session.id),
        storeName: storeById.get(String(session.store_id))?.name || '未命名店家',
        orderDate: session.order_date,
        cutoffTime: session.cutoff_time,
        paymentMode: session.payment_mode,
        stats: {
          orderCount,
          totalMeals: meals,
          unpaidStudents: unpaid,
          pickedUp: picked,
          totalReceivable: round2(receivable),
        },
        items: [...itemsMap.values()],
      };
    });

    const { data: allSessions } = await supabase.from('sessions').select('order_date').eq('class_id', classId);
    const availableDates = [...new Set((allSessions || []).map(session => session.order_date))].sort();

    return {
      stats: { totalMeals, totalReceivable: round2(totalReceivable), unpaidStudents: unpaidByUser.size, pickedUp },
      orders: rows,
      sessionSummaries: summaries,
      availableDates,
      date,
    };
  },

  async adminCatalog(_data, ctx) {
    const stores = await listStoresForClass(ctx.classId);
    const storeIds = stores.map(store => store.id);
    const items = storeIds.length ? await listRowsIn('menu_items', 'store_id', storeIds) : [];
    const itemIds = items.map(item => item.id);
    const options = itemIds.length ? await listRowsIn('item_options', 'menu_item_id', itemIds) : [];
    const sessions = await listRows('sessions', { classId: ctx.classId, order: 'order_date' });
    return {
      stores: stores.map(store => ({ storeId: sid(store.id), name: store.name, description: store.description || '', contact: store.contact || '', isGlobal: Boolean(store.is_global), isActive: store.is_active })),
      items: items.map(item => ({ storeId: sid(item.store_id), itemId: sid(item.id), name: item.name, basePrice: num(item.price) })),
      options: options.map(option => ({
        itemId: sid(option.menu_item_id),
        optionId: sid(option.id),
        name: option.name,
        priceAdjustment: num(option.price),
        maxSelect: num(option.max_select),
      })),
      sessions: sessions.map(session => ({
        sessionId: sid(session.id),
        storeId: sid(session.store_id),
        orderDate: session.order_date,
        cutoffTime: session.cutoff_time,
        paymentMode: session.payment_mode,
      })),
    };
  },

  async adminSaveStore(data, ctx) {
    const storeId = Number(data.storeId) || null;
    const name = String(data.name || '').trim();
    if (!name) throw appError('INVALID_INPUT', '請輸入店家名稱。');
    const description = String(data.description || '').trim().slice(0, 200);
    const contact = String(data.contact || '').trim().slice(0, 120);
    const merchantCode = String(data.merchantCode || '').trim();
    let merchantId = null;
    if (merchantCode) {
      const merchant = await findOne('merchants', { authorization_code_hash: sha256Hex(merchantCode) });
      if (!merchant) throw appError('INVALID_CODE', '店家合作授權碼不正確。');
      merchantId = merchant.id;
    }
    if (storeId) {
      const store = await findOne('stores', { id: storeId }, ctx.classId);
      if (!store) throw appError('NOT_FOUND', '店家不存在。');
      if (store.is_global) throw appError('FORBIDDEN', '全體共用店家由開發者管理。');
      const fields = { name, description, contact };
      if (merchantId) fields.merchant_id = merchantId;
      await updateRows('stores', { id: store.id }, fields);
    } else {
      const fields = { class_id: ctx.classId, name, description, contact };
      if (merchantId) fields.merchant_id = merchantId;
      await insertRow('stores', fields);
    }
    return { ok: true };
  },

  async adminDeductBalance(data, ctx) {
    const userId = Number(data.userId);
    const amount = Number(data.amount);
    if (!Number.isInteger(userId) || userId <= 0) throw appError('INVALID_INPUT', '使用者資料不正確。');
    if (!Number.isFinite(amount) || amount <= 0) throw appError('INVALID_INPUT', '請輸入正確的扣款金額。');
    const note = String(data.note || '').trim().slice(0, 120) || '管理員手動扣款';
    const user = await findOne('users', { id: userId }, ctx.classId);
    if (!user) throw appError('NOT_FOUND', '找不到使用者。');
    let result;
    try {
      result = await callRpc('fn_manual_balance', { p_class_id: ctx.classId, p_user_id: userId, p_amount: -amount, p_note: note });
    } catch (error) {
      if (String(error.message || '').includes('fn_manual_balance')) throw appError('DB_ERROR', '資料庫尚未建立餘額調整函式，請在 Supabase SQL Editor 執行 schema.sql 的 v2 擴充區塊。');
      throw error;
    }
    return { ok: true, walletBalance: num(result.wallet_balance), message: `已從錢包扣款 ${amount} 元。` };
  },

  async adminSaveMenuItem(data, ctx) {
    const store = await findOne('stores', { id: Number(data.storeId) }, ctx.classId);
    if (!store) throw appError('NOT_FOUND', '店家不存在。');
    if (store.is_global) throw appError('FORBIDDEN', '全體共用店家由開發者管理。');
    const name = String(data.name || '').trim();
    const basePrice = Number(data.basePrice);
    if (!name) throw appError('INVALID_INPUT', '請輸入餐點名稱。');
    if (!Number.isFinite(basePrice) || basePrice < 0) throw appError('INVALID_INPUT', '請輸入正確的價格。');
    await insertRow('menu_items', { class_id: ctx.classId, store_id: store.id, name, price: basePrice });
    return { ok: true };
  },

  async adminSaveItemOption(data, ctx) {
    const item = await findOne('menu_items', { id: Number(data.itemId) }, ctx.classId);
    if (!item) throw appError('NOT_FOUND', '餐點不存在。');
    const name = String(data.name || '').trim();
    const priceAdjustment = Number(data.priceAdjustment);
    if (!name) throw appError('INVALID_INPUT', '請輸入選項名稱。');
    if (!Number.isFinite(priceAdjustment)) throw appError('INVALID_INPUT', '請輸入正確的差額。');
    await insertRow('item_options', { class_id: ctx.classId, store_id: item.store_id, menu_item_id: item.id, name, price: priceAdjustment });
    return { ok: true };
  },

  async adminDeleteStore(data, ctx) {
    const store = await findOne('stores', { id: Number(data.storeId) }, ctx.classId);
    if (!store) throw appError('NOT_FOUND', '店家不存在。');
    if (store.is_global) throw appError('FORBIDDEN', '全體共用店家由開發者管理。');
    const sessions = await listRows('sessions', { classId: ctx.classId, filters: { store_id: store.id } });
    const orderCount = await countOrdersOfSessions(sessions, ctx.classId);
    if (orderCount > 0) throw appError('PROTECTED', '此店家已有訂單紀錄，基於帳務保護無法刪除。');
    for (const session of sessions) await deleteRows('sessions', { id: session.id });
    await deleteRows('stores', { id: store.id });
    return { ok: true };
  },

  async adminDeleteMenuItem(data, ctx) {
    const item = await findOne('menu_items', { id: Number(data.itemId) }, ctx.classId);
    if (!item) throw appError('NOT_FOUND', '餐點不存在。');
    if (await orderContainsItem(ctx.classId, String(item.id))) {
      throw appError('PROTECTED', '此餐點已有訂單使用，基於帳務保護無法刪除。');
    }
    await deleteRows('menu_items', { id: item.id });
    return { ok: true };
  },

  async adminDeleteItemOption(data, ctx) {
    const option = await findOne('item_options', { id: Number(data.optionId) }, ctx.classId);
    if (!option) throw appError('NOT_FOUND', '客製選項不存在。');
    if (await orderContainsOption(ctx.classId, String(option.id))) {
      throw appError('PROTECTED', '此選項已有訂單使用，基於帳務保護無法刪除。');
    }
    await deleteRows('item_options', { id: option.id });
    return { ok: true };
  },

  async adminListUsers(_data, ctx) {
    const users = await listRows('users', { classId: ctx.classId, order: 'seat_no' });
    return users.map(user => ({
      id: sid(user.id),
      seatNo: user.seat_no,
      name: user.student_name,
      studentNo: user.student_no,
      walletBalance: num(user.wallet_balance),
      role: user.role,
      isDisabled: user.is_disabled,
    }));
  },

  async adminSetUserDisabled(data, ctx) {
    const user = await findOne('users', { id: Number(data.userId) }, ctx.classId);
    if (!user) throw appError('NOT_FOUND', '找不到使用者。');
    await updateRows('users', { id: user.id }, { is_disabled: Boolean(data.isDisabled) });
    await bumpAuthVersion(user.id);
    return { ok: true };
  },

  async adminDeleteUser(data, ctx) {
    const user = await findOne('users', { id: Number(data.userId) }, ctx.classId);
    if (!user) throw appError('NOT_FOUND', '找不到使用者。');
    if (user.role === 'Admin') throw appError('PROTECTED', '不可刪除管理員帳號。');
    if (String(user.id) === String(ctx.user.id)) throw appError('PROTECTED', '不可刪除自己的帳號。');
    const retainedOrderCount = await countRowsWhere('orders', { user_id: user.id });
    const retainedTransactionCount = await countRowsWhere('transactions', { user_id: user.id });
    await deleteRows('users', { id: user.id });
    return { ok: true, retainedOrderCount, retainedTransactionCount };
  },

  async adminGetSettings(_data, ctx) {
    const classRow = await findOne('classes', { class_id: ctx.classId });
    return { className: classRow ? classRow.name : '本班' };
  },

  async adminSaveSettings() {
    return { ok: true };
  },

  async adminListInviteCodes(_data, ctx) {
    const codes = await listRows('invite_codes', { classId: ctx.classId, order: 'created_at' });
    return codes.map(code => ({ inviteCodeId: sid(code.id), label: code.label, isDisabled: code.is_disabled }));
  },

  async adminCreateInviteCode(data, ctx) {
    const label = String(data.label || '').trim().slice(0, 80) || '班級邀請碼';
    const code = createInviteCodeValue();
    await insertRow('invite_codes', { class_id: ctx.classId, code_hash: sha256Hex(code), label });
    return { code };
  },

  async adminDisableInviteCode(data, ctx) {
    const code = await findOne('invite_codes', { id: Number(data.inviteCodeId) }, ctx.classId);
    if (!code) throw appError('NOT_FOUND', '找不到邀請碼。');
    await updateRows('invite_codes', { id: code.id }, { is_disabled: true });
    return { ok: true };
  },

  // 班級管理者可直接指定或移除管理者（至少保留一位，不能變更自己）
  async adminSetRole(data, ctx) {
    const userId = Number(data.userId);
    const role = String(data.role || '');
    if (!['Admin', 'Student'].includes(role)) throw appError('INVALID_INPUT', '角色不正確。');
    if (userId === ctx.user.id) throw appError('PROTECTED', '不能變更自己的管理者角色。');
    const user = await findOne('users', { id: userId }, ctx.classId);
    if (!user) throw appError('NOT_FOUND', '找不到使用者。');
    if (user.role === role) throw appError('INVALID_INPUT', '該帳號已是此角色。');
    if (role === 'Student') {
      const adminCount = await countRows('users', { class_id: ctx.classId, role: 'Admin' });
      if (adminCount <= 1) throw appError('PROTECTED', '班級至少需要一位管理者，無法移除最後一位。');
    }
    await updateRows('users', { id: user.id }, { role });
    await bumpAuthVersion(user.id);
    return { ok: true, message: role === 'Admin' ? `${user.student_name} 已成為管理者。` : `${user.student_name} 已改為一般學生。` };
  },
};

async function countOrdersOfSessions(sessions, classId) {
  if (!sessions.length) return 0;
  const orders = await listRowsIn('orders', 'session_id', sessions.map(session => session.id), { classId });
  return orders.length;
}

async function orderContainsItem(classId, itemId) {
  const orders = await listRows('orders', { classId });
  return orders.some(order => (order.items || []).some(item => String(item.itemId) === itemId));
}

async function orderContainsOption(classId, optionId) {
  const orders = await listRows('orders', { classId });
  return orders.some(order =>
    (order.items || []).some(item => (item.selectedOptions || []).some(option => String(option.optionId) === optionId)),
  );
}

async function countRowsWhere(table, filters) {
  let query = supabase.from(table).select('id', { count: 'exact', head: true });
  Object.entries(filters).forEach(([column, value]) => {
    query = query.eq(column, value);
  });
  const result = await query;
  return result.count || 0;
}
