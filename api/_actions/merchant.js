//動作：店家合作（商家）——註冊／驗證／登入／訂單檢視／菜單管理／營業設定
import { randomBytes } from 'node:crypto';
import { appError, sid, num, randomDigits, sha256Hex } from '../_lib/util.js';
import { supabase, findOne, listRows, listRowsIn, insertRow, updateRows, deleteRows } from '../_lib/db.js';
import { createPassword, verifyPassword } from '../_lib/auth.js';
import { sendMail, verificationEmailHtml } from '../_lib/mail.js';

export function publicMerchant(merchant) {
  return {
    id: sid(merchant.id),
    merchantName: merchant.merchant_name,
    email: merchant.email,
    address: merchant.address || '',
    phone: merchant.phone || '',
    ownerName: merchant.owner_name || '',
    ownerPhone: merchant.owner_phone || '',
  };
}

export async function validateMerchantSession(token) {
  if (!token) throw appError('UNAUTHORIZED', '請先登入店家帳號。');
  const record = await findOne('auth_tokens', { token_hash: sha256Hex(token), type: 'MerchantSession' });
  if (!record || new Date(record.expires_at).getTime() < Date.now()) throw appError('UNAUTHORIZED', '登入已失效，請重新登入。');
  const merchant = await findOne('merchants', { id: record.merchant_id });
  if (!merchant || merchant.is_disabled) throw appError('UNAUTHORIZED', '店家帳號不可用。');
  return merchant;
}

async function createMerchantSession(merchant) {
  const rawToken = randomBytes(32).toString('hex');
  await insertRow('auth_tokens', {
    type: 'MerchantSession',
    merchant_id: merchant.id,
    token_hash: sha256Hex(rawToken),
    expires_at: new Date(Date.now() + 12 * 3600 * 1000).toISOString(),
  });
  return rawToken;
}

async function loadMerchantStore(merchantId) {
  return await findOne('stores', { merchant_id: merchantId });
}

export const actions = {
  async merchantRegister(data) {
    const merchantName = String(data.merchantName || '').trim();
    const address = String(data.address || '').trim();
    const phone = String(data.phone || '').trim();
    const ownerName = String(data.ownerName || '').trim();
    const ownerPhone = String(data.ownerPhone || '').trim();
    const email = String(data.email || '').trim().toLowerCase();
    const password = String(data.password || '');
    if (!merchantName || !ownerName || !ownerPhone) throw appError('INVALID_INPUT', '請填寫店家名稱、負責人姓名與負責人手機。');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw appError('INVALID_INPUT', '電子郵件格式不正確。');
    const existing = await findOne('merchants', { email });
    if (existing) throw appError('DUPLICATE', '此信箱已註冊店家帳號。');
    const { salt, hash } = createPassword(password);
    const merchant = await insertRow('merchants', {
      merchant_name: merchantName,
      address,
      phone,
      owner_name: ownerName,
      owner_phone: ownerPhone,
      email,
      password_hash: hash,
      salt,
    });
    const code = randomDigits(6);
    await insertRow('auth_tokens', {
      type: 'MerchantVerify',
      merchant_id: merchant.id,
      token_hash: sha256Hex(code),
      expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    });
    const delivery = await sendMail({ to: email, subject: '【訂餐通】店家信箱驗證碼', html: verificationEmailHtml(code) });
    return { message: '店家帳號已建立，請先完成信箱驗證（驗證碼已寄出），再登入。', delivery };
  },

  async merchantVerifyEmail(data) {
    const merchant = await findOne('merchants', { email: String(data.email || '').trim().toLowerCase() });
    if (!merchant) throw appError('NOT_FOUND', '找不到此信箱的店家帳號。');
    if (merchant.email_verified) return { message: '此店家已完成信箱驗證。' };
    const code = String(data.code || '').trim();
    const record = await findOne('auth_tokens', { type: 'MerchantVerify', merchant_id: merchant.id, token_hash: sha256Hex(code) });
    if (!record || new Date(record.expires_at).getTime() < Date.now()) throw appError('INVALID_CODE', '驗證碼不正確或已過期。');
    await updateRows('merchants', { id: merchant.id }, { email_verified: true });
    await deleteRows('auth_tokens', { id: record.id });
    return { message: '信箱驗證完成，請登入店家工作台。' };
  },

  async merchantLogin(data) {
    const merchant = await findOne('merchants', { email: String(data.email || '').trim().toLowerCase() });
    if (!merchant || merchant.is_disabled) throw appError('INVALID_CREDENTIALS', '店家帳號或密碼不正確。');
    if (!verifyPassword(merchant, String(data.password || ''))) throw appError('INVALID_CREDENTIALS', '店家帳號或密碼不正確。');
    if (!merchant.email_verified) throw appError('NOT_VERIFIED', '請先完成信箱驗證後再登入。');
    if (merchant.blocked_until && new Date(merchant.blocked_until).getTime() > Date.now()) throw appError('BLOCKED', '此店家帳號暫時被封鎖，請稍後再試。');
    const token = await createMerchantSession(merchant);
    return { token, merchant: publicMerchant(merchant) };
  },

  async merchantLogout(_data, ctx) {
    if (ctx.token) await deleteRows('auth_tokens', { token_hash: sha256Hex(ctx.token), type: 'MerchantSession' });
    return { ok: true };
  },

  async merchantGetDashboard(_data, ctx) {
    const store = await loadMerchantStore(ctx.merchant.id);
    if (!store) {
      return { store: null, pendingApproval: !ctx.merchant.is_approved, orders: [] };
    }
    const { data: sessions } = await supabase.from('sessions').select('*').eq('store_id', store.id);
    const sessionIds = (sessions || []).map(session => session.id);
    const orders = sessionIds.length ? await listRowsIn('orders', 'session_id', sessionIds) : [];
    const sessionById = new Map((sessions || []).map(session => [String(session.id), session]));
    const userIds = [...new Set(orders.map(order => order.user_id).filter(value => value !== null && value !== undefined))];
    const users = userIds.length
      ? await supabase.from('users').select('id, student_name, seat_no').in('id', userIds.map(Number)).then(result => result.data || [])
      : [];
    const userById = new Map(users.map(user => [String(user.id), user]));
    const ordered = orders
      .map(order => {
        const session = sessionById.get(String(order.session_id));
        const user = userById.get(String(order.user_id));
        return {
          orderId: sid(order.id),
          sessionId: sid(order.session_id),
          orderDate: session?.order_date || '',
          cutoffTime: session?.cutoff_time || '',
          studentName: user?.student_name || '已刪除帳號',
          seatNo: user?.seat_no || '',
          items: (order.items || []).map(item => `${Number(item.quantity) > 1 ? `${Number(item.quantity)}×` : ''}${item.itemName}`).join('、'),
          totalPrice: num(order.total_price),
          paymentStatus: order.payment_status,
          pickupStatus: order.pickup_status,
          note: order.note || '',
          createdAt: order.created_at,
        };
      })
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return {
      store: {
        storeId: sid(store.id),
        name: store.name,
        businessHours: store.business_hours || '',
        orderingOpen: Boolean(store.ordering_open),
        description: store.description || '',
        contact: store.contact || '',
      },
      orders: ordered,
    };
  },

  async merchantGetMenu(_data, ctx) {
    const store = await loadMerchantStore(ctx.merchant.id);
    if (!store) {
      return { store: null, pendingApproval: !ctx.merchant.is_approved, items: [], options: [] };
    }
    const items = await listRows('menu_items', { classId: store.class_id, filters: { store_id: store.id }, order: 'sort_order' });
    const options = items.length ? await listRowsIn('item_options', 'menu_item_id', items.map(item => item.id), { classId: store.class_id }) : [];
    return {
      store: { storeId: sid(store.id), name: store.name, businessHours: store.business_hours || '', orderingOpen: Boolean(store.ordering_open) },
      items: items.map(item => ({ itemId: sid(item.id), name: item.name, basePrice: num(item.price) })),
      options: options.map(option => ({ itemId: sid(option.menu_item_id), optionId: sid(option.id), name: option.name, priceAdjustment: num(option.price), maxSelect: num(option.max_select) })),
    };
  },

  async merchantSaveStore(data, ctx) {
    const store = await loadMerchantStore(ctx.merchant.id);
    if (!store) throw appError('NOT_FOUND', '尚未有綁定的店家。');
    await updateRows('stores', { id: store.id }, {
      name: String(data.name || store.name).trim().slice(0, 60),
      description: String(data.description || '').trim().slice(0, 200),
      contact: String(data.contact || '').trim().slice(0, 120),
      business_hours: String(data.businessHours || '').trim().slice(0, 60),
      ordering_open: data.orderingOpen === undefined ? store.ordering_open : Boolean(data.orderingOpen),
    });
    return { ok: true };
  },

  async merchantSaveMenuItem(data, ctx) {
    const store = await loadMerchantStore(ctx.merchant.id);
    if (!store) throw appError('NOT_FOUND', '尚未有綁定的店家。');
    const name = String(data.name || '').trim();
    const basePrice = Number(data.basePrice);
    if (!name) throw appError('INVALID_INPUT', '請輸入餐點名稱。');
    if (!Number.isFinite(basePrice) || basePrice < 0 || basePrice > 100000) throw appError('INVALID_INPUT', '餐點價格不正確。');
    await insertRow('menu_items', { class_id: store.class_id, store_id: store.id, name, price: basePrice });
    return { ok: true };
  },

  async merchantSaveItemOption(data, ctx) {
    const store = await loadMerchantStore(ctx.merchant.id);
    if (!store) throw appError('NOT_FOUND', '尚未有綁定的店家。');
    const item = await findOne('menu_items', { id: Number(data.itemId) }, store.class_id);
    if (!item || item.store_id !== store.id) throw appError('NOT_FOUND', '餐點不存在。');
    const name = String(data.name || '').trim();
    const priceAdjustment = Number(data.priceAdjustment);
    if (!name) throw appError('INVALID_INPUT', '請輸入選項名稱。');
    if (!Number.isFinite(priceAdjustment)) throw appError('INVALID_INPUT', '選項差額不正確。');
    await insertRow('item_options', { class_id: store.class_id, store_id: store.id, menu_item_id: item.id, name, price: priceAdjustment, max_select: Number(data.maxSelect) || 1 });
    return { ok: true };
  },

  async merchantDeleteMenuItem(data, ctx) {
    const store = await loadMerchantStore(ctx.merchant.id);
    if (!store) throw appError('NOT_FOUND', '尚未有綁定的店家。');
    const item = await findOne('menu_items', { id: Number(data.itemId) }, store.class_id);
    if (!item || item.store_id !== store.id) throw appError('NOT_FOUND', '餐點不存在。');
    const { data: orders } = await supabase.from('orders').select('items').limit(1000);
    const inUse = (orders || []).some(order => (order.items || []).some(entry => String(entry.itemId) === String(item.id)));
    if (inUse) throw appError('PROTECTED', '此餐點已有訂單使用，無法刪除。');
    await deleteRows('menu_items', { id: item.id });
    return { ok: true };
  },

  async merchantDeleteItemOption(data, ctx) {
    const store = await loadMerchantStore(ctx.merchant.id);
    if (!store) throw appError('NOT_FOUND', '尚未有綁定的店家。');
    const option = await findOne('item_options', { id: Number(data.optionId) }, store.class_id);
    if (!option || option.store_id !== store.id) throw appError('NOT_FOUND', '選項不存在。');
    const { data: orders } = await supabase.from('orders').select('items').limit(1000);
    const inUse = (orders || []).some(order => (order.items || []).some(entry => (entry.selectedOptions || []).some(optionEntry => String(optionEntry.optionId) === String(option.id))));
    if (inUse) throw appError('PROTECTED', '此選項已有訂單使用，無法刪除。');
    await deleteRows('item_options', { id: option.id });
    return { ok: true };
  },
};
