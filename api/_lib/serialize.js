// 序列化層：把資料庫列轉成前端 JSON（所有 id 字串化）
import { sid, num, round2, todayString } from './util.js';
import { supabase, findOne, listRows, listRowsIn, listMenuItemsForStore, listStoresForClass } from './db.js';

export function publicUser(user) {
  return {
    id: sid(user.id),
    name: user.student_name,
    studentName: user.student_name,
    studentNo: user.student_no,
    seatNo: user.seat_no,
    email: user.email || '',
    role: user.role,
    walletBalance: num(user.wallet_balance),
    mustChangePassword: Boolean(user.must_change_password),
    isDisabled: Boolean(user.is_disabled),
  };
}

export function itemNameOf(order) {
  const items = Array.isArray(order.items) ? order.items : [];
  if (!items.length) return '（無餐點）';
  const label = (item) => `${Number(item.quantity) > 1 ? `${Number(item.quantity)}×` : ''}${item.itemName || ''}`;
  return items.map(label).join('、');
}

export function selectedOptionsOf(order) {
  const items = Array.isArray(order.items) ? order.items : [];
  if (items.length !== 1) return [];
  return (items[0].options || []).map((option) => ({ name: option.name, price: num(option.price) }));
}

export function outstandingOf(order) {
  if (order.payment_status === 'PaidWallet' || order.payment_status === 'PaidCash') return 0;
  return round2(num(order.total_price) - num(order.prior_paid));
}

export function publicOrder(order) {
  return {
    orderId: sid(order.id),
    sessionId: sid(order.session_id),
    items: (Array.isArray(order.items) ? order.items : []).map((item) => ({
      itemId: sid(item.itemId),
      itemName: item.itemName,
      quantity: num(item.quantity),
      unitPrice: num(item.unitPrice),
      options: (item.options || []).map((option) => ({ name: option.name, price: num(option.price) })),
    })),
    totalPrice: num(order.total_price),
    priorPaid: num(order.prior_paid),
    paymentStatus: order.payment_status,
    pickupStatus: order.pickup_status,
    note: order.note || '',
    createdAt: order.created_at,
  };
}

// 由資料庫重新計算訂單金額（不信任前端傳來的金額）
// menuItems: [{itemId, name, price, options:[{name,price}]}]
// selections: [{itemId, quantity, optionIndexes:[number]}]
export function computeOrderItems(menuItems, selections) {
  if (!Array.isArray(selections) || !selections.length) throw new Error('請至少選擇一項餐點。');
  if (selections.length > 20) throw new Error('單次最多可選擇 20 項餐點。');
  const byId = new Map(menuItems.map((item) => [String(item.itemId), item]));
  const used = new Set();
  const items = selections.map((selection) => {
    const itemId = String(selection?.itemId || '');
    const quantity = Number(selection?.quantity);
    const item = byId.get(itemId);
    if (!item) throw new Error('餐點資料不正確。');
    if (used.has(itemId)) throw new Error('相同餐點請直接調整數量。');
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) throw new Error('每項餐點數量須為 1–99。');
    used.add(itemId);
    const optionIndexes = Array.isArray(selection?.optionIndexes) ? selection.optionIndexes.map(Number) : [];
    if (new Set(optionIndexes).size !== optionIndexes.length) throw new Error('客製選項不可重複選擇。');
    const options = Array.isArray(item.options) ? item.options : [];
    const chosen = optionIndexes.map((idx) => {
      const option = options[idx];
      if (!option) throw new Error('客製選項資料不正確。');
      return { name: option.name, price: num(option.price) };
    });
    const unitPrice = round2(num(item.price) + chosen.reduce((sum, option) => sum + option.price, 0));
    if (unitPrice < 0) throw new Error('餐點金額不正確。');
    return {
      itemId,
      itemName: item.name,
      quantity,
      unitPrice,
      lineTotal: round2(unitPrice * quantity),
      options: chosen,
    };
  });
  return {
    items,
    totalQuantity: items.reduce((sum, item) => sum + item.quantity, 0),
    total: round2(items.reduce((sum, item) => sum + item.lineTotal, 0)),
  };
}

export async function loadSessionWithMenu(session) {
  const store = await findOne('stores', { id: session.store_id }, session.class_id);
  const menuItems = await listMenuItemsForStore(session.class_id, session.store_id, { includeInactive: false });
  return {
    session,
    storeName: store?.name || '未命名店家',
    menuItems: menuItems.map((item) => ({
      itemId: sid(item.id),
      name: item.name,
      price: num(item.price),
      options: (Array.isArray(item.options) ? item.options : []).map((option, index) => ({
        index,
        name: option.name,
        price: num(option.price),
      })),
    })),
  };
}

export function publicSession(session, storeName, menuItems, existingOrder, pureBalanceMode, walletBalance) {
  return {
    sessionId: sid(session.id),
    storeId: sid(session.store_id),
    storeName,
    orderDate: session.order_date,
    cutoffTime: session.cutoff_time,
    weekLabel: session.week_label || '',
    isOpen: Boolean(session.is_open),
    pureBalanceMode,
    walletBalance: num(walletBalance),
    menuItems,
    existingOrder: existingOrder ? publicOrder(existingOrder) : null,
  };
}

// 讀取使用者可見的場次（今天與未來；已截止但已有訂單者仍顯示以便查看）
export async function loadOpenSessions(user, { pureBalanceMode = false } = {}) {
  const classId = user.class_id;
  const { data: rawSessions, error } = await supabase
    .from('sessions')
    .select('*')
    .eq('class_id', classId)
    .gte('order_date', todayString())
    .order('order_date', { ascending: true })
    .order('cutoff_time', { ascending: true });
  if (error) throw new Error('讀取場次失敗。');
  const sessions = (rawSessions || []).filter((s) => !s.is_deleted);

  const orders = sessions.length
    ? await listRowsIn('orders', 'session_id', sessions.map((session) => session.id), { classId })
    : [];
  const userOrders = orders.filter((order) => String(order.user_id) === String(user.id));
  const orderBySession = new Map(userOrders.map((order) => [String(order.session_id), order]));

  const result = [];
  for (const session of sessions) {
    if (!session.is_open) continue; // 草稿場次學生不可見
    const existingOrder = orderBySession.get(String(session.id)) || null;
    const cutoffPassed = new Date(session.cutoff_time).getTime() < Date.now();
    if (cutoffPassed && !existingOrder) continue;
    const { storeName, menuItems } = await loadSessionWithMenu(session);
    result.push(publicSession(session, storeName, menuItems, existingOrder, pureBalanceMode, user.wallet_balance));
  }
  return { sessions: result, orders: userOrders.map(publicOrder) };
}

// 管理員儀表板用的扁平訂單列
export function dashboardOrderRow(order, session, storeName, user) {
  return {
    orderId: sid(order.id),
    sessionId: sid(order.session_id),
    orderDate: session.order_date,
    storeName,
    seatNo: user ? user.seat_no : '',
    studentName: user ? user.student_name : '已刪除帳號',
    studentNo: user ? user.student_no : '',
    itemName: itemNameOf(order),
    selectedOptions: selectedOptionsOf(order),
    note: order.note || '',
    totalPrice: num(order.total_price),
    paymentStatus: order.payment_status,
    pickupStatus: order.pickup_status,
    outstandingAmount: outstandingOf(order),
  };
}
