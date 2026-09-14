// 動作：v3.2 新功能 — AI 圖片辨識設定、請假、推薦菜單、自訂欠費（使用者彼此）、更新日誌、請客場次
import { appError, sid, num, round2, todayString } from '../_lib/util.js';
import { findOne, listRows, listRowsIn, insertRow, updateRows, deleteRows, callRpc, getAppSetting, setAppSetting } from '../_lib/db.js';
import { sendPushToUser } from '../_lib/push.js';

/* ============================ AI 辨識設定 ============================ */
export const AI_KEYS = {
  provider: 'ai_provider',        // auto | gemini | openai
  geminiKey: 'ai_gemini_key',
  openaiKey: 'ai_openai_key',
  geminiModel: 'ai_gemini_model',
  openaiModel: 'ai_openai_model',
};

async function aiSettings(classId) {
  const provider = (await getAppSetting(classId, AI_KEYS.provider, 'auto')) || 'auto';
  const geminiKey = await getAppSetting(classId, AI_KEYS.geminiKey, '');
  const openaiKey = await getAppSetting(classId, AI_KEYS.openaiKey, '');
  const geminiModel = await getAppSetting(classId, AI_KEYS.geminiModel, '');
  const openaiModel = await getAppSetting(classId, AI_KEYS.openaiModel, '');
  return { provider, geminiKey, openaiKey, geminiModel, openaiModel };
}

// 依座號／學號找同學（數字自動補零）
async function resolveUserBySeat(classId, raw) {
  const value = String(raw || '').trim();
  if (!value) throw appError('INVALID_INPUT', '請輸入座號或學號。');
  const candidates = [value];
  if (/^\d+$/.test(value)) {
    const padded = value.padStart(2, '0');
    if (padded !== value) candidates.push(padded);
  }
  for (const no of candidates) {
    let user = await findOne('users', { seat_no: no, is_disabled: false }, classId);
    if (user) return user;
    user = await findOne('users', { student_no: no, is_disabled: false }, classId);
    if (user) return user;
  }
  throw appError('NOT_FOUND', '找不到此座號／學號的同學。');
}

export const actions = {
  /* ---------- AI 設定（管理員） ---------- */
  async aiGetSettings(_data, ctx) {
    const s = await aiSettings(ctx.classId);
    const envGemini = Boolean(process.env.GEMINI_API_KEY);
    const envOpenAI = Boolean(process.env.OPENAI_API_KEY);
    return {
      provider: s.provider,
      geminiKeySet: Boolean(s.geminiKey) || envGemini,
      openaiKeySet: Boolean(s.openaiKey) || envOpenAI,
      geminiModel: s.geminiModel,
      openaiModel: s.openaiModel,
      envFallback: !s.geminiKey && !s.openaiKey && (envGemini || envOpenAI),
    };
  },

  async aiSaveSettings(data, ctx) {
    const provider = ['auto', 'gemini', 'openai'].includes(data.provider) ? data.provider : 'auto';
    const geminiKey = String(data.geminiApiKey || '').trim();
    const openaiKey = String(data.openaiApiKey || '').trim();
    const geminiModel = String(data.geminiModel || '').trim().slice(0, 80);
    const openaiModel = String(data.openaiModel || '').trim().slice(0, 80);

    await setAppSetting(ctx.classId, AI_KEYS.provider, provider);
    if (geminiKey) await setAppSetting(ctx.classId, AI_KEYS.geminiKey, geminiKey);
    if (openaiKey) await setAppSetting(ctx.classId, AI_KEYS.openaiKey, openaiKey);
    if (geminiModel) await setAppSetting(ctx.classId, AI_KEYS.geminiModel, geminiModel);
    else await setAppSetting(ctx.classId, AI_KEYS.geminiModel, '');
    if (openaiModel) await setAppSetting(ctx.classId, AI_KEYS.openaiModel, openaiModel);
    else await setAppSetting(ctx.classId, AI_KEYS.openaiModel, '');

    return { ok: true };
  },

  /* ---------- 請假 ---------- */
  // 使用者申請請假（當天需於 9:00 前）
  async createLeave(data, ctx) {
    const leaveDate = String(data.leaveDate || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(leaveDate)) throw appError('INVALID_INPUT', '請選擇請假日期。');
    if (leaveDate < todayString()) throw appError('INVALID_INPUT', '請假日期不可在過去。');
    if (leaveDate === todayString()) {
      const tw = new Date(Date.now() + 8 * 60 * 60 * 1000);
      if (tw.getUTCHours() >= 9) throw appError('CUTOFF_PASSED', '當天請假須於上午 9:00 前申請。');
    }
    const reason = String(data.reason || '').trim().slice(0, 120);
    const existing = await findOne('leave_requests', { class_id: ctx.classId, user_id: ctx.user.id, leave_date: leaveDate, status: 'Pending' });
    if (existing) throw appError('DUPLICATE', '此日期已有待審核的請假申請。');

    await insertRow('leave_requests', {
      class_id: ctx.classId,
      user_id: ctx.user.id,
      leave_date: leaveDate,
      reason,
      status: 'Pending',
    });

    const admins = await listRows('users', { classId: ctx.classId, filters: { role: 'Admin', is_disabled: false } });
    for (const admin of admins) {
      await sendPushToUser(admin.id, { title: '收到請假申請', body: `${ctx.user.student_name}（${ctx.user.seat_no}）申請 ${leaveDate} 請假，請處理。`, url: '/' });
    }
    return { ok: true };
  },

  async listLeave(_data, ctx) {
    const rows = await listRows('leave_requests', { classId: ctx.classId, filters: { user_id: ctx.user.id }, order: 'leave_date', orderAscending: false });
    return { requests: rows.map((r) => ({ id: sid(r.id), leaveDate: r.leave_date, reason: r.reason, status: r.status, requestedAt: r.requested_at })) };
  },

  async adminListLeave(_data, ctx) {
    const rows = await listRows('leave_requests', { classId: ctx.classId, order: 'leave_date', orderAscending: false });
    const userIds = [...new Set(rows.map((r) => r.user_id).filter(Boolean))];
    const users = userIds.length ? await listRowsIn('users', 'id', userIds, { classId: ctx.classId }) : [];
    const userById = new Map(users.map((u) => [String(u.id), u]));
    const list = rows.map((r) => {
      const u = userById.get(String(r.user_id));
      return { id: sid(r.id), userId: sid(r.user_id), seatNo: u?.seat_no || u?.student_no || '', studentName: u?.student_name || '已刪除帳號', leaveDate: r.leave_date, reason: r.reason, status: r.status, requestedAt: r.requested_at };
    });
    return { requests: list };
  },

  async adminResolveLeave(data, ctx) {
    const req = await findOne('leave_requests', { id: Number(data.id) }, ctx.classId);
    if (!req) throw appError('NOT_FOUND', '找不到請假申請。');
    if (req.status !== 'Pending') throw appError('INVALID_INPUT', '此申請已處理。');
    const approve = data.approve === true;
    const result = { ok: true, cancelled: 0, refunded: 0 };

    await updateRows('leave_requests', { id: req.id }, {
      status: approve ? 'Approved' : 'Rejected',
      resolved_at: new Date().toISOString(),
      resolved_by: ctx.user.id,
    });

    const user = await findOne('users', { id: req.user_id }, ctx.classId);

    if (approve) {
      const sessions = await listRows('sessions', { classId: ctx.classId, filters: { order_date: req.leave_date } });
      const sessionIds = sessions.filter((s) => !s.is_deleted).map((s) => s.id);
      if (sessionIds.length) {
        const orders = await listRowsIn('orders', 'session_id', sessionIds, { classId: ctx.classId });
        for (const order of orders.filter((o) => !o.is_deleted && String(o.user_id) === String(req.user_id))) {
          const refund = await callRpc('fn_refund_order', { p_class_id: ctx.classId, p_user_id: req.user_id, p_order_id: order.id });
          result.cancelled += 1;
          result.refunded = round2(result.refunded + num(refund.refunded));
        }
      }
      if (user) {
        await sendPushToUser(user.id, {
          title: '請假已批准',
          body: `你於 ${req.leave_date} 的請假已批准${result.cancelled ? `，已取消 ${result.cancelled} 筆訂單${result.refunded > 0 ? `並退費 $${result.refunded}` : ''}` : ''}。`,
          url: '/',
        });
      }
    } else if (user) {
      await sendPushToUser(user.id, { title: '請假未批准', body: `你於 ${req.leave_date} 的請假未獲批准。`, url: '/' });
    }
    return result;
  },

  /* ---------- 推薦菜單 ---------- */
  async createRecommendation(data, ctx) {
    const storeName = String(data.storeName || '').trim().slice(0, 60);
    if (!storeName) throw appError('INVALID_INPUT', '請輸入店家名稱。');
    const note = String(data.note || '').trim().slice(0, 200);
    await insertRow('menu_recommendations', { class_id: ctx.classId, user_id: ctx.user.id, store_name: storeName, note });
    return { ok: true };
  },

  async listRecommendations(_data, ctx) {
    const rows = await listRows('menu_recommendations', { classId: ctx.classId, order: 'created_at', orderAscending: false, limit: 100 });
    const userIds = [...new Set(rows.map((r) => r.user_id).filter(Boolean))];
    const users = userIds.length ? await listRowsIn('users', 'id', userIds, { classId: ctx.classId }) : [];
    const userById = new Map(users.map((u) => [String(u.id), u]));
    return {
      recommendations: rows.map((r) => {
        const u = userById.get(String(r.user_id));
        return { id: sid(r.id), storeName: r.store_name, note: r.note, seatNo: u?.seat_no || u?.student_no || '', studentName: u?.student_name || '已刪除帳號', createdAt: r.created_at };
      }),
    };
  },

  async adminDeleteRecommendation(data, ctx) {
    await deleteRows('menu_recommendations', { id: Number(data.id) });
    return { ok: true };
  },

  /* ---------- 自訂欠費（使用者彼此新增，新增者自行核銷） ---------- */
  async debtList(_data, ctx) {
    const rows = await listRows('custom_debts', { classId: ctx.classId, order: 'created_at', orderAscending: false });
    const mine = rows.filter((r) => String(r.creditor_id) === String(ctx.user.id) || String(r.debtor_id) === String(ctx.user.id));
    const userIds = [...new Set(mine.flatMap((r) => [r.creditor_id, r.debtor_id]).filter(Boolean))];
    const users = userIds.length ? await listRowsIn('users', 'id', userIds, { classId: ctx.classId }) : [];
    const userById = new Map(users.map((u) => [String(u.id), u]));
    const map = (r) => {
      const creditor = userById.get(String(r.creditor_id));
      const debtor = userById.get(String(r.debtor_id));
      return {
        id: sid(r.id),
        amount: num(r.amount),
        note: r.note || '',
        status: r.status || 'Outstanding',
        createdAt: r.created_at,
        settledAt: r.settled_at,
        creditorSeat: creditor?.seat_no || creditor?.student_no || '',
        creditorName: creditor?.student_name || '已刪除帳號',
        debtorSeat: debtor?.seat_no || debtor?.student_no || '',
        debtorName: debtor?.student_name || '已刪除帳號',
      };
    };
    const receivables = mine.filter((r) => String(r.creditor_id) === String(ctx.user.id)).map(map);
    const payables = mine.filter((r) => String(r.debtor_id) === String(ctx.user.id)).map(map);
    const sum = (list) => round2(list.filter((e) => e.status === 'Outstanding').reduce((s, e) => s + e.amount, 0));
    return { receivables, payables, receiveTotal: sum(receivables), payTotal: sum(payables) };
  },

  async debtCreate(data, ctx) {
    const debtor = await resolveUserBySeat(ctx.classId, data.seatNo);
    if (String(debtor.id) === String(ctx.user.id)) throw appError('INVALID_INPUT', '不能對自己新增欠費。');
    const amount = num(data.amount);
    if (!(amount > 0) || amount > 100000) throw appError('INVALID_INPUT', '請輸入正確的金額。');
    const note = String(data.note || '').trim().slice(0, 120);
    await insertRow('custom_debts', { class_id: ctx.classId, creditor_id: ctx.user.id, debtor_id: debtor.id, amount, note, status: 'Outstanding' });
    return { ok: true };
  },

  async debtSettle(data, ctx) {
    const debt = await findOne('custom_debts', { id: Number(data.id) }, ctx.classId);
    if (!debt) throw appError('NOT_FOUND', '找不到此筆欠費。');
    if (String(debt.creditor_id) !== String(ctx.user.id)) throw appError('FORBIDDEN', '只有新增者可以核銷。');
    await updateRows('custom_debts', { id: debt.id }, { status: 'Settled', settled_at: new Date().toISOString() });
    return { ok: true };
  },

  async debtDelete(data, ctx) {
    const debt = await findOne('custom_debts', { id: Number(data.id) }, ctx.classId);
    if (!debt) throw appError('NOT_FOUND', '找不到此筆欠費。');
    if (String(debt.creditor_id) !== String(ctx.user.id)) throw appError('FORBIDDEN', '只有新增者可以刪除。');
    await deleteRows('custom_debts', { id: debt.id });
    return { ok: true };
  },

  /* ---------- 更新日誌 ---------- */
  async getChangelog(_data, ctx) {
    const rows = await listRows('changelog', { classId: '', order: 'created_at', orderAscending: false, limit: 100 });
    return {
      changelog: rows.map((r) => ({ id: sid(r.id), version: r.version, title: r.title, body: r.body, createdAt: r.created_at })),
    };
  },

  async adminAddChangelog(data, ctx) {
    const version = String(data.version || '').trim().slice(0, 20) || 'v';
    const title = String(data.title || '').trim().slice(0, 60);
    const body = String(data.body || '').trim().slice(0, 1000);
    if (!title && !body) throw appError('INVALID_INPUT', '請填寫日誌內容。');
    await insertRow('changelog', { class_id: '', version, title, body });
    return { ok: true };
  },

  async adminDeleteChangelog(data, ctx) {
    await deleteRows('changelog', { id: Number(data.id) });
    return { ok: true };
  },

  /* ---------- 請客場次（管理員） ---------- */
  async adminGetTreatSessions(_data, ctx) {
    const sessions = await listRows('sessions', { classId: ctx.classId, filters: { is_treat: true, is_deleted: false }, order: 'order_date', orderAscending: false });
    const storeIds = [...new Set(sessions.map((s) => s.store_id))];
    const stores = storeIds.length ? await listRowsIn('stores', 'id', storeIds, { classId: ctx.classId }) : [];
    const storeById = new Map(stores.map((s) => [String(s.id), s]));
    const list = sessions.map((s) => ({
      sessionId: sid(s.id),
      storeName: storeById.get(String(s.store_id))?.name || '未命名店家',
      orderDate: s.order_date,
      cutoffTime: s.cutoff_time,
      isOpen: Boolean(s.is_open),
      treatCap: num(s.treat_cap),
      treatUsed: num(s.treat_used),
      treatRemaining: round2(Math.max(0, num(s.treat_cap) - num(s.treat_used))),
    }));
    return { sessions: list, totalFree: round2(sessions.reduce((sum, s) => sum + num(s.treat_used), 0)) };
  },
};
