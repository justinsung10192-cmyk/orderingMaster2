// 動作：產生 QR 驗證憑證、掃碼核對（含 PIN 替代輸入）、確認取餐
import { appError, sid, num, round2, randomDigits, todayString, sha256Hex } from '../_lib/util.js';
import { findOne, listRows, listRowsIn, insertRow, updateRows } from '../_lib/db.js';
import { outstandingOf, itemNameOf } from '../_lib/serialize.js';
import { sendPushToUser } from '../_lib/push.js';

const VERIFY_MINUTES = 5;

function scanOrderShape(order, session) {
  return {
    orderId: sid(order.id),
    sessionId: sid(order.session_id),
    orderDate: session ? session.order_date : '',
    itemName: itemNameOf(order),
    totalPrice: num(order.total_price),
    selectedOptions: (() => {
      const items = Array.isArray(order.items) ? order.items : [];
      if (items.length !== 1) return [];
      return (items[0].selectedOptions || []).map(option => ({ name: option.name }));
    })(),
  };
}

// 共用：依已驗證的 payload 解析學生、訂單與待收金額（掃碼與 PIN 皆使用）
async function resolveByPayload(mode, payload, ctx, scopeSessionId = null) {
  const student = await findOne('users', { id: Number(payload.uid) }, ctx.classId);
  if (!student) throw appError('NOT_FOUND', '找不到學生帳號。');

  let orders = [];
  let outstandingAmount = 0;
  const walletBalance = num(student.wallet_balance);

  if (mode === 'pickup') {
    let sessions;
    if (scopeSessionId) {
      const scoped = await findOne('sessions', { id: scopeSessionId }, ctx.classId);
      sessions = scoped ? [scoped] : [];
    } else {
      sessions = await listRows('sessions', { classId: ctx.classId, filters: { order_date: todayString() } });
    }
    const sessionIds = sessions.map(session => session.id);
    const userOrders = sessionIds.length
      ? (await listRowsIn('orders', 'session_id', sessionIds, { classId: ctx.classId })).filter(
          order => String(order.user_id) === String(student.id) && order.pickup_status !== 'PickedUp',
        )
      : [];
    const sessionById = new Map(sessions.map(session => [String(session.id), session]));
    orders = userOrders.map(order => scanOrderShape(order, sessionById.get(String(order.session_id))));
  } else if (mode === 'checkout') {
    const userOrders = await listRows('orders', { classId: ctx.classId, filters: { user_id: student.id } });
    const unpaid = userOrders.filter(order => outstandingOf(order) > 0 && (!scopeSessionId || String(order.session_id) === String(scopeSessionId)));
    const sessionIds = [...new Set(unpaid.map(order => order.session_id))];
    const sessions = sessionIds.length ? await listRowsIn('sessions', 'id', sessionIds, { classId: ctx.classId }) : [];
    const sessionById = new Map(sessions.map(session => [String(session.id), session]));
    orders = unpaid.map(order => scanOrderShape(order, sessionById.get(String(order.session_id))));
    outstandingAmount = round2(unpaid.reduce((sum, order) => sum + outstandingOf(order), 0));
  } else {
    const userOrders = await listRows('orders', { classId: ctx.classId, filters: { user_id: student.id } });
    outstandingAmount = round2(userOrders.reduce((sum, order) => sum + outstandingOf(order), 0));
  }

  return {
    mode,
    student: { id: sid(student.id), name: student.student_name, studentNo: student.student_no, seatNo: student.seat_no },
    orders,
    outstandingAmount,
    walletBalance,
  };
}

export const actions = {
  async createVerification(data, ctx) {
    const type = String(data.type || '');
    if (!['pickup', 'checkout', 'topup'].includes(type)) throw appError('INVALID_INPUT', '驗證類型不正確。');
    const pin = randomDigits(6);
    const exp = Date.now() + VERIFY_MINUTES * 60 * 1000;
    const payload = { v: 1, uid: sid(ctx.user.id), pin, type, exp };
    await insertRow('verification_records', {
      class_id: ctx.classId,
      user_id: ctx.user.id,
      payload: JSON.stringify(payload),
      pin_hash: sha256Hex(pin),
      status: 'Pending',
      expires_at: new Date(exp).toISOString(),
    });
    return { payload, pin, expiresAt: new Date(exp).toISOString() };
  },

  async adminResolveVerification(data, ctx) {
    const mode = String(data.mode || '');
    const payload = data.payload;
    if (!payload || typeof payload !== 'object') throw appError('INVALID_QR', 'QR Code 不是有效的驗證資料。');
    if (!payload.uid || !payload.pin || !payload.type || !payload.exp) throw appError('INVALID_QR', 'QR Code 缺少必要的驗證資料。');
    if (!['pickup', 'checkout', 'topup'].includes(payload.type)) throw appError('INVALID_QR', 'QR Code 的驗證類型不正確。');
    if (payload.type !== mode) throw appError('INVALID_QR', 'QR 類型與掃描作業不符，請確認掃描類別。');
    if (new Date(payload.exp).getTime() < Date.now()) throw appError('EXPIRED', 'QR Code 已失效，請學生重新產生。');

    const record = await findOne('verification_records', { payload: JSON.stringify(payload) });
    if (!record || record.status !== 'Pending') throw appError('EXPIRED', '此憑證已使用或已失效。');
    if (new Date(record.expires_at).getTime() < Date.now()) throw appError('EXPIRED', 'QR Code 已過期，請學生重新產生。');

    let storedPayload = null;
    try { storedPayload = JSON.parse(record.payload); } catch (_) { /* 忽略 */ }
    if (!storedPayload || String(storedPayload.pin) !== String(payload.pin)) throw appError('INVALID_QR', 'PIN 碼不正確。');

    await updateRows('verification_records', { id: record.id }, { status: 'Resolved', resolved_at: new Date().toISOString() });
    return resolveByPayload(mode, payload, ctx, Number(data.sessionId) || null);
  },

  // 相機無法使用時，以 6 位 PIN 取代 QR 驗證
  async adminResolvePin(data, ctx) {
    const mode = String(data.mode || '');
    const pin = String(data.pin || '').trim();
    if (!/^\d{6}$/.test(pin)) throw appError('INVALID_PIN', '請輸入 6 位數 PIN 碼。');
    if (!['pickup', 'checkout', 'topup'].includes(mode)) throw appError('INVALID_PIN', '不支援的作業類型。');

    const record = await findOne('verification_records', { class_id: ctx.classId, pin_hash: sha256Hex(pin), status: 'Pending' });
    if (!record) throw appError('INVALID_PIN', '找不到對應的 PIN，或此 PIN 已失效。');
    if (new Date(record.expires_at).getTime() < Date.now()) throw appError('EXPIRED', '此 PIN 已過期，請學生重新產生。');

    let payload = null;
    try { payload = JSON.parse(record.payload); } catch (_) { /* 忽略 */ }
    if (!payload || !['pickup', 'checkout', 'topup'].includes(payload.type)) throw appError('INVALID_PIN', 'PIN 資料不正確。');
    if (payload.type !== mode) {
      const label = payload.type === 'pickup' ? '取餐' : payload.type === 'checkout' ? '結帳' : '儲值';
      throw appError('INVALID_PIN', `此 PIN 是「${label}」用途，與目前作業不符。`);
    }

    await updateRows('verification_records', { id: record.id }, { status: 'Resolved', resolved_at: new Date().toISOString() });
    return resolveByPayload(mode, payload, ctx, Number(data.sessionId) || null);
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
      await sendPushToUser(target.id, { title: '餐點已可取餐', body: '你的午餐已經準備好了，請到取餐處核對 QR 取餐。', url: '/' });
    }
    return { ok: true, updated };
  },
};
