// 動作：產生臨時 QR + 4 位 PIN、管理者掃碼/輸入 PIN 核銷、取餐標記
import { appError, sid, num, round2, randomDigits, sha256Hex, todayString } from '../_lib/util.js';
import { findOne, listRows, listRowsIn, insertRow, updateRows } from '../_lib/db.js';
import { outstandingOf } from '../_lib/serialize.js';
import { sendPushToUser } from '../_lib/push.js';

const VERIFY_MINUTES = 5;

async function resolveContext(classId, userId) {
  const [student, allOrdersRaw] = await Promise.all([
    findOne('users', { id: Number(userId) }, classId),
    listRows('orders', { classId, filters: { user_id: Number(userId) } }),
  ]);
  if (!student) throw appError('NOT_FOUND', '找不到學生帳號。');
  const allOrders = allOrdersRaw.filter((order) => !order.is_deleted);
  const sessionIds = [...new Set(allOrders.map((order) => order.session_id))];
  const sessions = sessionIds.length ? await listRowsIn('sessions', 'id', sessionIds, { classId }) : [];
  const sessionById = new Map(sessions.map((session) => [String(session.id), session]));
  const storeIds = [...new Set(sessions.map((session) => session.store_id))];
  const stores = storeIds.length ? await listRowsIn('stores', 'id', storeIds, { classId }) : [];
  const storeById = new Map(stores.map((store) => [String(store.id), store]));

  const today = todayString();
  const todayOrders = [];
  const unpaidOrders = [];
  let totalDebt = 0;

  allOrders.forEach((order) => {
    const session = sessionById.get(String(order.session_id));
    const store = session ? storeById.get(String(session.store_id)) : null;
    const outstanding = outstandingOf(order);
    totalDebt += outstanding;
    const row = {
      orderId: sid(order.id),
      sessionId: sid(order.session_id),
      orderDate: session?.order_date || '',
      storeName: store?.name || '未指定店家',
      itemName: (order.items || []).map((item) => `${Number(item.quantity) > 1 ? `${Number(item.quantity)}×` : ''}${item.itemName}`).join('、'),
      totalPrice: num(order.total_price),
      paymentStatus: order.payment_status,
      pickupStatus: order.pickup_status,
      outstanding,
    };
    if (session?.order_date === today) todayOrders.push(row);
    if (outstanding > 0) unpaidOrders.push(row);
  });

  return {
    student: { id: sid(student.id), name: student.student_name, studentNo: student.student_no, seatNo: student.seat_no },
    walletBalance: num(student.wallet_balance),
    totalDebt: round2(totalDebt),
    todayOrders,
    unpaidOrders,
  };
}

export const actions = {
  async createVerification(data, ctx) {
    const sessionId = Number(data.sessionId) || null;
    if (sessionId) {
      const session = await findOne('sessions', { id: sessionId }, ctx.classId);
      if (!session) throw appError('NOT_FOUND', '找不到場次。');
    }
    const pin = randomDigits(4);
    const exp = Date.now() + VERIFY_MINUTES * 60 * 1000;
    const payload = { v: 1, uid: sid(ctx.user.id), pin, type: 'verify', exp, sid: sessionId ? sid(sessionId) : '' };
    await insertRow('verification_records', {
      class_id: ctx.classId,
      session_id: sessionId,
      user_id: ctx.user.id,
      payload: JSON.stringify(payload),
      pin_hash: sha256Hex(pin),
      status: 'Pending',
      expires_at: new Date(exp).toISOString(),
    });
    return { payload, pin, expiresAt: new Date(exp).toISOString() };
  },

  async adminResolveVerification(data, ctx) {
    const payload = data.payload;
    if (!payload || typeof payload !== 'object' || !payload.uid || !payload.exp) {
      throw appError('INVALID_QR', 'QR Code 不是有效的驗證資料。');
    }
    if (new Date(payload.exp).getTime() < Date.now()) throw appError('EXPIRED', 'QR Code 已失效，請學生重新產生。');

    const record = await findOne('verification_records', { payload: JSON.stringify(payload) });
    if (!record || record.status !== 'Pending') throw appError('EXPIRED', '此憑證已使用或已失效。');
    if (new Date(record.expires_at).getTime() < Date.now()) throw appError('EXPIRED', 'QR Code 已過期，請學生重新產生。');

    await updateRows('verification_records', { id: record.id }, { status: 'Resolved', resolved_at: new Date().toISOString() });
    return resolveContext(ctx.classId, payload.uid);
  },

  async adminResolvePin(data, ctx) {
    const pin = String(data.pin || '').trim();
    if (!/^\d{4}$/.test(pin)) throw appError('INVALID_PIN', '請輸入 4 位數 PIN 碼。');

    const record = await findOne('verification_records', { class_id: ctx.classId, pin_hash: sha256Hex(pin), status: 'Pending' });
    if (!record) throw appError('INVALID_PIN', '找不到對應的 PIN，或此 PIN 已失效。');
    if (new Date(record.expires_at).getTime() < Date.now()) throw appError('EXPIRED', '此 PIN 已過期，請學生重新產生。');

    let payload = null;
    try { payload = JSON.parse(record.payload); } catch (_) { /* 忽略 */ }
    if (!payload || !payload.uid) throw appError('INVALID_PIN', 'PIN 資料不正確。');

    await updateRows('verification_records', { id: record.id }, { status: 'Resolved', resolved_at: new Date().toISOString() });
    return resolveContext(ctx.classId, payload.uid);
  },

  // 直接輸入座號／學號查詢當天訂單（不需掃碼或 PIN）
  async adminResolveSeat(data, ctx) {
    const raw = String(data.seatNo || '').trim();
    if (!raw) throw appError('INVALID_INPUT', '請輸入座號或學號。');
    const candidates = [raw];
    if (/^\d+$/.test(raw)) {
      const padded = raw.padStart(2, '0');
      if (padded !== raw) candidates.push(padded);
    }
    let student = null;
    for (const no of candidates) {
      student = await findOne('users', { seat_no: no }, ctx.classId);
      if (student) break;
      student = await findOne('users', { student_no: no }, ctx.classId);
      if (student) break;
    }
    if (!student) throw appError('NOT_FOUND', '找不到此座號／學號的同學。');
    return resolveContext(ctx.classId, student.id);
  },

  async adminConfirmPickup(data, ctx) {
    const orderIds = (data.orderIds || []).map(Number).filter(Boolean);
    if (!orderIds.length) throw appError('INVALID_INPUT', '沒有可取餐的訂單。');
    const target = await findOne('users', { id: Number(data.userId) }, ctx.classId);
    if (!target) throw appError('NOT_FOUND', '找不到使用者。');

    let updated = 0;
    for (const orderId of orderIds) {
      const order = await findOne('orders', { id: orderId, user_id: target.id }, ctx.classId);
      if (order && order.pickup_status !== 'PickedUp') {
        await updateRows('orders', { id: order.id }, { pickup_status: 'PickedUp', updated_at: new Date().toISOString() });
        updated += 1;
      }
    }
    if (updated > 0) {
      await sendPushToUser(target.id, { title: '餐點已可取餐', body: '你的餐點已標記為可取餐，請到取餐處領取。', url: '/' });
    }
    return { ok: true, updated };
  },
};
