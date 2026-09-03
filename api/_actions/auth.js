// 動作：登入、首次設定（強制改密碼與姓名）、改密碼、Bootstrap
import { appError, sid, num, nextWeekLabel } from '../_lib/util.js';
import { findOne, updateRows, deleteRows, getClass, isPureBalanceMode, listStoresForClass, listRows, listRowsIn } from '../_lib/db.js';
import { verifyPassword, createPassword, createSession, destroySession, bumpAuthVersion } from '../_lib/auth.js';
import { getVapidPublicKey } from '../_lib/push.js';
import { publicUser, publicOrder, loadOpenSessions, loadSessionWithMenu, publicSession } from '../_lib/serialize.js';

function cleanStudentNo(value) {
  return String(value || '').trim();
}

export const actions = {
  async getPublicConfig() {
    let className = '三年甲班';
    let pureBalanceMode = false;
    try {
      const classRow = await getClass('demo');
      className = classRow.name;
      pureBalanceMode = Boolean(classRow.pure_balance_mode);
    } catch (_) { /* 預設值 */ }
    return {
      appName: '班級訂餐管理系統',
      className,
      pureBalanceMode,
      vapidPublicKey: getVapidPublicKey(),
      defaultPasswordHint: true, // 首次登入前提示預設密碼
    };
  },

  async login(data) {
    const user = await findOne('users', { student_no: cleanStudentNo(data.studentNo) });
    if (!user) throw appError('INVALID_CREDENTIALS', '座號或密碼不正確。');
    if (user.is_disabled) throw appError('DISABLED', '此帳號已停用，請聯絡管理者。');
    if (!verifyPassword(user, String(data.password || ''))) throw appError('INVALID_CREDENTIALS', '座號或密碼不正確。');
    const token = await createSession(user);
    return { token, user: publicUser(user) };
  },

  // 首次登入：強制設定姓名與新密碼
  async completeSetup(data, ctx) {
    const studentName = String(data.studentName || '').trim();
    const password = String(data.password || '');
    if (!studentName) throw appError('INVALID_INPUT', '請填寫你的姓名。');
    if (!password || password.length < 8) throw appError('WEAK_PASSWORD', '密碼至少須為 8 個字元。');

    const { salt, hash } = createPassword(password);
    await updateRows('users', { id: ctx.user.id }, {
      student_name: studentName,
      password_hash: hash,
      salt,
      must_change_password: false,
      updated_at: new Date().toISOString(),
    });
    const fresh = await findOne('users', { id: ctx.user.id });
    return { user: publicUser(fresh) };
  },

  // 自願修改密碼（登入後）
  async changePassword(data, ctx) {
    const oldPassword = String(data.oldPassword || '');
    const newPassword = String(data.newPassword || '');
    if (!verifyPassword(ctx.user, oldPassword)) throw appError('INVALID_CREDENTIALS', '目前密碼不正確。');
    if (!newPassword || newPassword.length < 8) throw appError('WEAK_PASSWORD', '新密碼至少須為 8 個字元。');

    const { salt, hash } = createPassword(newPassword);
    await updateRows('users', { id: ctx.user.id }, { password_hash: hash, salt, updated_at: new Date().toISOString() });
    await deleteRows('auth_tokens', { user_id: ctx.user.id });

    const fresh = await findOne('users', { id: ctx.user.id });
    const token = await createSession(fresh);
    return { token, user: publicUser(fresh) };
  },

  async logout(_data, ctx) {
    await destroySession(ctx.token);
    return { ok: true };
  },

  // 登入後一次性載入所有需要的資料
  async getBootstrap(_data, ctx) {
    const user = ctx.user;
    const classId = user.class_id;
    const classRow = await getClass(classId);
    const pureBalanceMode = Boolean(classRow.pure_balance_mode);

    const { sessions, orders } = await loadOpenSessions(user, { pureBalanceMode });

    // 店家（供投票）
    const stores = (await listStoresForClass(classId)).map((store) => ({
      storeId: sid(store.id),
      name: store.name,
      isActive: Boolean(store.is_active),
    }));

    // 下週投票
    const voteWeek = nextWeekLabel();
    const myVotes = await listRows('votes', { classId, filters: { user_id: user.id, week_label: voteWeek } });
    const allVotes = await listRows('votes', { classId, filters: { week_label: voteWeek } });
    const tally = {};
    allVotes.forEach((vote) => {
      tally[String(vote.store_id)] = (tally[String(vote.store_id)] || 0) + 1;
    });

    const holidays = await listRows('holidays', { classId });

    return {
      user: publicUser(user),
      isAdmin: user.role === 'Admin',
      pureBalanceMode,
      sessions,
      orders,
      stores,
      voteWeek,
      votesPerWeek: 3,
      myVotes: myVotes.map((vote) => String(vote.store_id)),
      voteTally: tally,
      holidays: holidays.map((holiday) => holiday.holiday_date),
    };
  },

  // 讀取單一場次詳情（含菜單）
  async getSession(data, ctx) {
    const session = await findOne('sessions', { id: Number(data.sessionId) }, ctx.classId);
    if (!session) throw appError('NOT_FOUND', '找不到場次。');
    if (!session.is_open && ctx.user.role !== 'Admin') throw appError('CLOSED', '此場次尚未開放。');
    const classRow = await getClass(ctx.classId);
    const pureBalanceMode = Boolean(classRow.pure_balance_mode);
    const { storeName, menuItems } = await loadSessionWithMenu(session);
    const existingOrder = await findOne('orders', { session_id: session.id, user_id: ctx.user.id }, ctx.classId);
    return publicSession(session, storeName, menuItems, existingOrder, pureBalanceMode, ctx.user.wallet_balance);
  },
};
