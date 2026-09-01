// 動作：開發者工作台（班級管理者代碼、跨班級帳號管理、系統設定）
import { randomBytes } from 'node:crypto';
import { appError, sid, num, sha256Hex, randomDigits } from '../_lib/util.js';
import { supabase, findOne, listRows, listRowsIn, insertRow, updateRows, deleteRows, countRows, getAppSetting, setAppSetting, throwDb, callRpc } from '../_lib/db.js';
import { verifyPassword, createPassword, createDeveloperSession, destroySession, bumpAuthVersion, createClassAdminCodeValue } from '../_lib/auth.js';
import { mailConfigured, sendMail, verificationEmailHtml, developerLoginAlertHtml, classAdminCodeEmailHtml } from '../_lib/mail.js';
import { sendPushToAll } from '../_lib/push.js';

function publicDeveloper(developer) {
  return { id: sid(developer.id), username: developer.username, name: developer.username, email: developer.email };
}

export const actions = {
  async developerRegister(data) {
    const masterKey = process.env.DEVELOPER_MASTER_KEY || '';
    if (!masterKey) throw appError('NOT_CONFIGURED', '開發者金鑰尚未設定（DEVELOPER_MASTER_KEY）。');
    if (String(data.activationKey || '') !== masterKey) throw appError('INVALID_KEY', '開發者金鑰不正確。');
    const username = String(data.username || '').trim();
    if (!/^[A-Za-z0-9._-]{3,40}$/.test(username)) throw appError('INVALID_INPUT', '開發者帳號格式不正確。');
    const email = String(data.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw appError('INVALID_INPUT', '電子郵件格式不正確。');
    const existing = await findOne('developers', { username });
    if (existing) throw appError('DUPLICATE', '此開發者帳號已存在。');
    const existingEmail = await findOne('developers', { email });
    if (existingEmail) throw appError('DUPLICATE', '此信箱已被使用。');
    const { salt, hash } = createPassword(String(data.password || ''));
    const developer = await insertRow('developers', { username, email, password_hash: hash, salt });
    const code = randomDigits(6);
    await insertRow('auth_tokens', {
      type: 'DevVerify',
      developer_id: developer.id,
      token_hash: sha256Hex(code),
      expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    });
    const delivery = await sendMail({ to: email, subject: '【訂餐通】開發者信箱驗證碼', html: verificationEmailHtml(code) });
    return { message: '開發者帳號已建立。請先完成信箱驗證（驗證碼已寄出），再登入。', delivery };
  },

  async developerVerifyEmail(data) {
    const developer = await findOne('developers', { username: String(data.username || '').trim() });
    if (!developer) throw appError('NOT_FOUND', '找不到此開發者帳號。');
    if (developer.email_verified) return { message: '此帳號已完成信箱驗證。' };
    const code = String(data.code || '').trim();
    const record = await findOne('auth_tokens', { type: 'DevVerify', developer_id: developer.id, token_hash: sha256Hex(code) });
    if (!record || new Date(record.expires_at).getTime() < Date.now()) throw appError('INVALID_CODE', '驗證碼不正確或已過期。');
    await updateRows('developers', { id: developer.id }, { email_verified: true });
    await deleteRows('auth_tokens', { id: record.id });
    return { message: '信箱驗證完成，請登入開發者工作台。' };
  },

  async developerLogin(data) {
    const developer = await findOne('developers', { username: String(data.username || '').trim() });
    if (!developer || developer.is_disabled) throw appError('INVALID_CREDENTIALS', '開發者帳號或密碼不正確。');
    if (!verifyPassword(developer, String(data.password || ''))) throw appError('INVALID_CREDENTIALS', '開發者帳號或密碼不正確。');
    if (!developer.email_verified) throw appError('NOT_VERIFIED', '請先完成信箱驗證後再登入。');
    if (developer.blocked_until && new Date(developer.blocked_until).getTime() > Date.now()) {
      throw appError('BLOCKED', '此開發者帳號暫時被封鎖，請約 1 分鐘後再試。');
    }
    const token = await createDeveloperSession(developer);
    let loginAlert = { sent: false };
    try {
      const alertEmail = process.env.ADMIN_ALERT_EMAIL || 'justinsung1019.2@gmail.com';
      const appUrl = (process.env.APP_URL || '').replace(/\/+$/, '');
      const blockToken = randomBytes(24).toString('hex');
      await insertRow('auth_tokens', {
        type: 'DevBlock',
        developer_id: developer.id,
        token_hash: sha256Hex(blockToken),
        expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      });
      const time = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
      loginAlert = await sendMail({
        to: alertEmail,
        subject: `【訂餐通】開發者登入通知：${developer.username}`,
        html: developerLoginAlertHtml({ name: developer.username, email: developer.email, time, blockUrl: `${appUrl}/api/block?code=${blockToken}` }),
      });
    } catch (_) { /* 通知失敗不阻擋登入 */ }
    return { token, developer: publicDeveloper(developer), loginAlert };
  },

  async developerLogout(_data, ctx) {
    await destroySession(ctx.token, 'DevSession');
    return { ok: true };
  },

  async developerListUsers() {
    const users = await listRows('users', { order: 'created_at' });
    const classIds = [...new Set(users.map(user => user.class_id))];
    const classes = classIds.length ? await listRowsIn('classes', 'class_id', classIds) : [];
    const classByName = new Map(classes.map(classRow => [String(classRow.class_id), classRow.name]));
    return users.map(user => ({
      id: sid(user.id),
      name: user.student_name,
      studentNo: user.student_no,
      email: user.email,
      role: user.role,
      walletBalance: num(user.wallet_balance),
      isDisabled: user.is_disabled,
      emailVerified: user.email_verified,
      className: classByName.get(String(user.class_id)) || '未指定班級',
      classId: sid(user.class_id),
    }));
  },

  async developerListClassAdminCodes() {
    const codes = await listRows('class_admin_codes', { order: 'created_at' });
    return codes.map(code => ({
      codeId: sid(code.id),
      className: code.label,
      createdAt: code.created_at,
      isUsed: code.is_used,
      usedBy: code.is_used ? code.used_by : '',
    }));
  },

  async developerIssueClassAdminCode(data) {
    const className = String(data.className || '').trim().slice(0, 80);
    if (!className) throw appError('INVALID_INPUT', '請輸入班級名稱。');
    const code = createClassAdminCodeValue();
    await insertRow('class_admin_codes', { code_hash: sha256Hex(code), label: className });
    return { code };
  },

  async developerRevokeClassAdminCode(data) {
    const code = await findOne('class_admin_codes', { id: Number(data.codeId) });
    if (!code) throw appError('NOT_FOUND', '找不到管理者代碼。');
    if (code.is_used) throw appError('PROTECTED', '已使用的代碼不可撤銷。');
    await updateRows('class_admin_codes', { id: code.id }, { is_used: true, used_by: 'developer-revoked' });
    return { ok: true };
  },

  async developerGetUserDetails(data) {
    const user = await findOne('users', { id: Number(data.userId) });
    if (!user) throw appError('NOT_FOUND', '找不到使用者。');
    const classRow = await findOne('classes', { class_id: user.class_id });

    const orders = await listRows('orders', { classId: user.class_id, filters: { user_id: user.id }, order: 'created_at', orderAscending: false, limit: 50 });
    const sessionIds = [...new Set(orders.map(order => order.session_id))];
    const sessions = sessionIds.length ? await listRowsIn('sessions', 'id', sessionIds, { classId: user.class_id }) : [];
    const sessionById = new Map(sessions.map(session => [String(session.id), session]));

    const transactions = await listRows('transactions', { classId: user.class_id, filters: { user_id: user.id }, order: 'created_at', orderAscending: false, limit: 50 });

    return {
      name: user.student_name,
      studentNo: user.student_no,
      className: classRow ? classRow.name : '未指定',
      email: user.email,
      emailVerified: user.email_verified,
      seatNo: user.seat_no,
      role: user.role,
      walletBalance: num(user.wallet_balance),
      isDisabled: user.is_disabled,
      orders: orders.map(order => ({
        itemName: (order.items || []).map(item => `${Number(item.quantity) > 1 ? `${Number(item.quantity)}×` : ''}${item.itemName}`).join('、'),
        totalPrice: num(order.total_price),
        orderDate: sessionById.get(String(order.session_id))?.order_date || '',
        paymentStatus: order.payment_status,
      })),
      transactions: transactions.map(transaction => ({ type: transaction.kind, amount: num(transaction.amount) })),
    };
  },

  async developerSetUserDisabled(data) {
    const user = await findOne('users', { id: Number(data.userId) });
    if (!user) throw appError('NOT_FOUND', '找不到使用者。');
    await updateRows('users', { id: user.id }, { is_disabled: Boolean(data.isDisabled) });
    await bumpAuthVersion(user.id);
    return { ok: true };
  },

  async developerDeleteUser(data) {
    const user = await findOne('users', { id: Number(data.userId) });
    if (!user) throw appError('NOT_FOUND', '找不到使用者。');
    const retainedOrderCount = await countWhere('orders', { user_id: user.id });
    const retainedTransactionCount = await countWhere('transactions', { user_id: user.id });
    await deleteRows('users', { id: user.id });
    return { ok: true, retainedOrderCount, retainedTransactionCount };
  },

  async developerResendVerification(data) {
    const developer = await findOne('developers', { username: String(data.username || '').trim() });
    if (!developer) throw appError('NOT_FOUND', '找不到此開發者帳號。');
    if (developer.email_verified) throw appError('ALREADY', '此帳號已完成信箱驗證。');
    await deleteRows('auth_tokens', { type: 'DevVerify', developer_id: developer.id });
    const code = randomDigits(6);
    await insertRow('auth_tokens', {
      type: 'DevVerify',
      developer_id: developer.id,
      token_hash: sha256Hex(code),
      expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    });
    const delivery = await sendMail({ to: developer.email, subject: '【訂餐通】開發者信箱驗證碼', html: verificationEmailHtml(code) });
    return { message: delivery.sent ? '驗證碼已重新寄出，請檢查信箱。' : '驗證碼寄送失敗，請稍後再試。', delivery };
  },

  async developerListDevelopers() {
    const developers = await listRows('developers', { order: 'created_at' });
    return developers.map(developer => ({
      id: sid(developer.id),
      username: developer.username,
      email: developer.email,
      isDisabled: developer.is_disabled,
      emailVerified: developer.email_verified,
    }));
  },

  async developerDeleteDeveloper(data, ctx) {
    const target = await findOne('developers', { id: Number(data.developerId) });
    if (!target) throw appError('NOT_FOUND', '找不到開發者帳號。');
    if (target.id === ctx.developer.id) throw appError('PROTECTED', '不能刪除自己正在使用的開發者帳號。');
    const count = await countRows('developers', {});
    if (count <= 1) throw appError('PROTECTED', '系統至少需要保留一位開發者。');
    await deleteRows('developers', { id: target.id });
    return { ok: true, message: `開發者 ${target.username} 已刪除。` };
  },

  async developerListMenu() {
    const { data: stores, error } = await supabase.from('stores').select('*').eq('is_global', true).order('sort_order');
    if (error) throw new Error('讀取全體菜單失敗。');
    const items = stores.length ? await listRowsIn('menu_items', 'store_id', stores.map(store => store.id)) : [];
    const options = items.length ? await listRowsIn('item_options', 'menu_item_id', items.map(item => item.id)) : [];
    const schoolIds = [...new Set(stores.map(store => store.school_id).filter(Boolean))];
    const schools = schoolIds.length ? await listRowsIn('schools', 'id', schoolIds) : [];
    const schoolById = new Map(schools.map(school => [String(school.id), school]));
    return {
      stores: stores.map(store => ({
        storeId: sid(store.id),
        name: store.name,
        description: store.description || '',
        contact: store.contact || '',
        scope: store.scope || 'all',
        schoolId: sid(store.school_id),
        schoolName: (store.school_id && schoolById.get(String(store.school_id))?.name) || '',
        isActive: store.is_active,
      })),
      items: items.map(item => ({ storeId: sid(item.store_id), itemId: sid(item.id), name: item.name, basePrice: num(item.price) })),
      options: options.map(option => ({ itemId: sid(option.menu_item_id), optionId: sid(option.id), name: option.name, priceAdjustment: num(option.price), maxSelect: num(option.max_select) })),
    };
  },

  async developerSaveStore(data) {
    const storeId = Number(data.storeId) || null;
    const name = String(data.name || '').trim();
    if (!name) throw appError('INVALID_INPUT', '請輸入店家名稱。');
    const description = String(data.description || '').trim().slice(0, 200);
    const contact = String(data.contact || '').trim().slice(0, 120);
    const scope = String(data.scope || 'all') === 'school' ? 'school' : 'all';
    const schoolId = scope === 'school' ? (Number(data.schoolId) || null) : null;
    if (scope === 'school' && !schoolId) throw appError('INVALID_INPUT', '學校專屬菜單需選擇學校。');
    if (storeId) {
      const store = await findOne('stores', { id: storeId });
      if (!store || !store.is_global) throw appError('NOT_FOUND', '全體店家不存在。');
      await updateRows('stores', { id: store.id }, { name, description, contact, scope, school_id: schoolId });
    } else {
      await insertRow('stores', { class_id: 'global', name, description, contact, is_global: true, scope, school_id: schoolId });
    }
    return { ok: true };
  },

  async developerListSchools() {
    const { data, error } = await supabase.from('schools').select('*').order('name');
    if (error) throwDb(error);
    return (data || []).map(school => ({
      schoolId: sid(school.id),
      name: school.name,
      emailDomain: school.email_domain || '',
      isActive: Boolean(school.is_active),
    }));
  },

  async developerSaveSchool(data) {
    const schoolId = Number(data.schoolId) || null;
    const name = String(data.name || '').trim();
    if (!name) throw appError('INVALID_INPUT', '請輸入學校名稱。');
    const emailDomain = String(data.emailDomain || '').trim();
    if (schoolId) {
      const school = await findOne('schools', { id: schoolId });
      if (!school) throw appError('NOT_FOUND', '學校不存在。');
      await updateRows('schools', { id: school.id }, { name, email_domain: emailDomain });
    } else {
      await insertRow('schools', { name, email_domain: emailDomain });
    }
    return { ok: true };
  },

  async developerListApplications() {
    const { data, error } = await supabase.from('class_admin_applications').select('*').order('created_at', { ascending: false });
    if (error) throwDb(error);
    const schoolIds = [...new Set((data || []).map(application => application.school_id).filter(Boolean))];
    const schools = schoolIds.length ? await listRowsIn('schools', 'id', schoolIds) : [];
    const schoolById = new Map(schools.map(school => [String(school.id), school]));
    return (data || []).map(application => ({
      applicationId: sid(application.id),
      schoolId: sid(application.school_id),
      schoolName: (application.school_id && schoolById.get(String(application.school_id))?.name) || '未指定學校',
      studentName: application.student_name,
      studentNo: application.student_no,
      className: application.class_name,
      contactPhone: application.contact_phone,
      email: application.email,
      emailVerified: Boolean(application.email_verified),
      status: application.status,
      createdAt: application.created_at,
    }));
  },

  async developerApproveApplication(data) {
    const application = await findOne('class_admin_applications', { id: Number(data.applicationId) });
    if (!application) throw appError('NOT_FOUND', '找不到此申請。');
    if (application.status !== 'Pending') throw appError('INVALID_INPUT', '此申請已處理。');
    if (!application.email_verified) throw appError('INVALID_INPUT', '申請人尚未完成信箱驗證，無法核准。');
    const code = createClassAdminCodeValue();
    await insertRow('class_admin_codes', { code_hash: sha256Hex(code), label: application.class_name || '未命名班級' });
    await updateRows('class_admin_applications', { id: application.id }, { status: 'Approved', reviewed_at: new Date().toISOString() });
    const appUrl = (process.env.APP_URL || '').replace(/\/+$/, '');
    const delivery = await sendMail({
      to: application.email,
      subject: '【訂餐通】班級管理者代碼已核發',
      html: classAdminCodeEmailHtml({ name: application.student_name, className: application.class_name, code, frontendUrl: appUrl }),
    });
    return { ok: true, emailed: delivery.sent };
  },

  async developerRejectApplication(data) {
    const application = await findOne('class_admin_applications', { id: Number(data.applicationId) });
    if (!application || application.status !== 'Pending') throw appError('INVALID_INPUT', '此申請已處理。');
    await updateRows('class_admin_applications', { id: application.id }, { status: 'Rejected', reviewed_at: new Date().toISOString() });
    return { ok: true };
  },

  async developerListMerchants() {
    const { data, error } = await supabase.from('merchants').select('*').order('created_at', { ascending: false });
    if (error) throwDb(error);
    const merchantIds = (data || []).map(merchant => merchant.id);
    const stores = merchantIds.length ? await supabase.from('stores').select('id, name, merchant_id').in('merchant_id', merchantIds).then(result => result.data || []) : [];
    const storeByMerchant = new Map();
    stores.forEach(store => storeByMerchant.set(String(store.merchant_id), store));
    return (data || []).map(merchant => ({
      merchantId: sid(merchant.id),
      merchantName: merchant.merchant_name,
      email: merchant.email,
      ownerName: merchant.owner_name,
      ownerPhone: merchant.owner_phone,
      isDisabled: Boolean(merchant.is_disabled),
      emailVerified: Boolean(merchant.email_verified),
      isApproved: Boolean(merchant.is_approved),
      storeName: storeByMerchant.get(String(merchant.id))?.name || '尚未開店',
    }));
  },

  async developerSetMerchantDisabled(data) {
    const merchant = await findOne('merchants', { id: Number(data.merchantId) });
    if (!merchant) throw appError('NOT_FOUND', '找不到店家帳號。');
    await updateRows('merchants', { id: merchant.id }, { is_disabled: Boolean(data.isDisabled) });
    return { ok: true };
  },

  async developerApproveMerchant(data) {
    const merchant = await findOne('merchants', { id: Number(data.merchantId) });
    if (!merchant) throw appError('NOT_FOUND', '找不到店家帳號。');
    if (merchant.is_disabled) throw appError('INVALID_INPUT', '此店家帳號已停用，無法核准。');
    if (!merchant.email_verified) throw appError('INVALID_INPUT', '店家尚未完成信箱驗證，無法核准。');
    const existingStore = await findOne('stores', { merchant_id: merchant.id });
    if (!existingStore) {
      await insertRow('stores', {
        class_id: 'global',
        name: merchant.merchant_name,
        description: merchant.address || '',
        contact: merchant.phone || merchant.owner_phone || '',
        is_global: true,
        scope: 'all',
        merchant_id: merchant.id,
        business_hours: '',
      });
    }
    await updateRows('merchants', { id: merchant.id }, { is_approved: true });
    return { ok: true, message: '已核准，店家已自動加入場次的店家選擇清單。' };
  },

  async developerDeleteStore(data) {
    const store = await findOne('stores', { id: Number(data.storeId) });
    if (!store || !store.is_global) throw appError('NOT_FOUND', '全體店家不存在。');
    const { data: storeSessions } = await supabase.from('sessions').select('id').eq('store_id', store.id).limit(1);
    if (storeSessions && storeSessions.length) throw appError('PROTECTED', '此全體店家已被場次使用，無法刪除。');
    await deleteRows('stores', { id: store.id });
    return { ok: true };
  },

  async developerSaveMenuItem(data) {
    const store = await findOne('stores', { id: Number(data.storeId) });
    if (!store || !store.is_global) throw appError('NOT_FOUND', '全體店家不存在。');
    const name = String(data.name || '').trim();
    const basePrice = Number(data.basePrice);
    if (!name) throw appError('INVALID_INPUT', '請輸入餐點名稱。');
    if (!Number.isFinite(basePrice) || basePrice < 0 || basePrice > 100000) throw appError('INVALID_INPUT', '餐點價格不正確。');
    await insertRow('menu_items', { class_id: 'global', store_id: store.id, name, price: basePrice });
    return { ok: true };
  },

  async developerSaveItemOption(data) {
    const item = await findOne('menu_items', { id: Number(data.itemId) });
    if (!item) throw appError('NOT_FOUND', '餐點不存在。');
    const store = await findOne('stores', { id: item.store_id });
    if (!store || !store.is_global) throw appError('FORBIDDEN', '僅能為全體共用餐點新增選項。');
    const name = String(data.name || '').trim();
    const priceAdjustment = Number(data.priceAdjustment);
    if (!name) throw appError('INVALID_INPUT', '請輸入選項名稱。');
    if (!Number.isFinite(priceAdjustment)) throw appError('INVALID_INPUT', '選項差額不正確。');
    await insertRow('item_options', { class_id: 'global', store_id: store.id, menu_item_id: item.id, name, price: priceAdjustment, max_select: Number(data.maxSelect) || 1 });
    return { ok: true };
  },

  async developerDeleteMenuItem(data) {
    const item = await findOne('menu_items', { id: Number(data.itemId) });
    if (!item) throw appError('NOT_FOUND', '餐點不存在。');
    const store = await findOne('stores', { id: item.store_id });
    if (!store || !store.is_global) throw appError('FORBIDDEN', '僅能刪除全體共用餐點。');
    const { data: orders } = await supabase.from('orders').select('items').limit(1000);
    const inUse = (orders || []).some(order => (order.items || []).some(entry => String(entry.itemId) === String(item.id)));
    if (inUse) throw appError('PROTECTED', '此餐點已有訂單使用，基於帳務保護無法刪除。');
    await deleteRows('menu_items', { id: item.id });
    return { ok: true };
  },

  async developerDeleteItemOption(data) {
    const option = await findOne('item_options', { id: Number(data.optionId) });
    if (!option) throw appError('NOT_FOUND', '選項不存在。');
    const store = await findOne('stores', { id: option.store_id });
    if (!store || !store.is_global) throw appError('FORBIDDEN', '僅能刪除全體共用選項。');
    const { data: orders } = await supabase.from('orders').select('items').limit(1000);
    const inUse = (orders || []).some(order => (order.items || []).some(entry => (entry.selectedOptions || []).some(optionEntry => String(optionEntry.optionId) === String(option.id))));
    if (inUse) throw appError('PROTECTED', '此選項已有訂單使用，基於帳務保護無法刪除。');
    await deleteRows('item_options', { id: option.id });
    return { ok: true };
  },

  async developerGetSettings() {
    let maintenance = false;
    try { maintenance = (await getAppSetting('', 'maintenance', '')) === '1'; } catch (_) { /* 忽略 */ }
    return { maintenance };
  },

  async developerSaveSettings() {
    return { ok: true };
  },

  async developerGetEmailDiagnostics() {
    const configured = mailConfigured();
    return {
      message: configured
        ? `郵件服務正常（Gmail SMTP：${process.env.SMTP_USER}，僅用於驗證信與重設信）。`
        : '郵件服務尚未設定（請設定 SMTP_USER / SMTP_PASS，並在 Gmail 產生應用程式密碼）。',
      gmailAuthorized: configured,
      remainingDailyQuota: configured ? 500 : 0,
    };
  },

  async developerBroadcast(data) {
    const message = String(data.message || '').trim().slice(0, 200);
    if (!message) throw appError('INVALID_INPUT', '請輸入廣播內容。');
    const result = await sendPushToAll({ title: '系統廣播', body: message, url: '/' });
    return { ok: true, sent: result.sent, attempted: result.attempted };
  },

  
  async developerRequestWipeData(data, ctx) {
    if (ctx.role !== 'Developer') throw appError('FORBIDDEN', '僅開發者可執行此操作。');
    const dev = await findOne('developers', { id: ctx.developerId });
    if (!dev) throw appError('NOT_FOUND', '開發者不存在。');

    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    await updateRows('developers', { id: ctx.developerId }, { wipe_token: token, wipe_token_expires_at: expiresAt });

    const appUrl = (process.env.APP_URL || '').replace(/\/+$/, '');
    const wipeUrl = `${appUrl}/?action=wipe_data&token=${token}`;

    await sendMail(dev.email, '【危險】確認刪除所有系統資料', `
      <h1>刪除所有資料確認</h1>
      <p>開發者 ${dev.username}，你剛剛請求了刪除系統所有的班級、使用者、訂單與交易紀錄。</p>
      <p style="color:red; font-weight:bold;">警告：這將會清空除了學校、合作店家與開發者帳號外的所有營運資料，且無法復原！</p>
      <p>如果確定要執行，請在 15 分鐘內點擊下方按鈕：</p>
      <a href="${wipeUrl}" style="display:inline-block;padding:12px 24px;background:#dc2626;color:white;text-decoration:none;border-radius:8px;font-weight:bold;">確認並永久刪除所有資料</a>
    `);

    return { ok: true, message: '確認信已寄至開發者信箱，請在 15 分鐘內點擊確認連結。' };
  },

  async developerExecuteWipeData(data) {
    const token = String(data.token || '').trim();
    if (!token) throw appError('INVALID_TOKEN', '驗證碼無效。');
    const dev = await findOne('developers', { wipe_token: token });
    if (!dev) throw appError('INVALID_TOKEN', '驗證碼無效或已過期。');
    if (new Date(dev.wipe_token_expires_at).getTime() < Date.now()) throw appError('EXPIRED', '驗證碼已過期。');

    await updateRows('developers', { id: dev.id }, { wipe_token: null, wipe_token_expires_at: null });

    await callRpc('fn_wipe_all_data', {});
    return { ok: true };
  },
async developerSetMaintenance(data) {
    await setAppSetting('', 'maintenance', Boolean(data.enabled) ? '1' : '0');
    return { ok: true, maintenance: Boolean(data.enabled) };
  },
};

async function countWhere(table, filters) {
  let query = supabase.from(table).select('id', { count: 'exact', head: true });
  Object.entries(filters).forEach(([column, value]) => {
    query = query.eq(column, value);
  });
  const result = await query;
  return result.count || 0;
}
