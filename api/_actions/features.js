// 動作：v3.2 新功能 — AI 圖片辨識設定、請客、請假、推薦菜單、自訂欠費、更新日誌
import { appError, sid, num, round2, todayString } from '../_lib/util.js';
import { findOne, listRows, listRowsIn, insertRow, updateRows, deleteRows, callRpc, supabase, getAppSetting, setAppSetting } from '../_lib/db.js';
import { sendPushToUser, sendPushToClass } from '../_lib/push.js';

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

/* ============================ 請客 ============================ */
async function treatListFor(classId) {
  const treats = await listRows('treats', { classId, filters: { is_active: true }, order: 'created_at', orderAscending: false });
  const hostIds = [...new Set(treats.map((t) => t.host_user_id).filter(Boolean))];
  const hosts = hostIds.length ? await listRowsIn('users', 'id', hostIds, { classId }) : [];
  const hostById = new Map(hosts.map((u) => [String(u.id), u]));
  return treats.map((t) => {
    const host = hostById.get(String(t.host_user_id));
    return {
      treatId: sid(t.id),
      title: t.title,
      hostName: host?.student_name || '已刪除帳號',
      hostSeat: host?.seat_no || host?.student_no || '',
      capAmount: num(t.cap_amount),
      usedAmount: num(t.used_amount),
      remaining: round2(Math.max(0, num(t.cap_amount) - num(t.used_amount))),
    };
  });
}

/* ============================ 自訂欠費 ============================ */
async function myCustomDebt(classId, userId) {
  const rows = await listRows('custom_debts', { classId, filters: { user_id: userId } });
  return round2(rows.reduce((sum, row) => sum + num(row.amount), 0));
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

  /* ---------- 請客 ---------- */
  // 列出進行中的請客（所有人）
  async treatList(_data, ctx) {
    return { treats: await treatListFor(ctx.classId) };
  },

  // 建立請客（任何使用者都可當主人；管理員可替全班管理）
  async treatCreate(data, ctx) {
    const title = String(data.title || '請客').trim().slice(0, 40) || '請客';
    const capAmount = num(data.capAmount);
    if (!(capAmount > 0) || capAmount > 100000) throw appError('INVALID_INPUT', '請輸入正確的請客上限金額。');
    await insertRow('treats', {
      class_id: ctx.classId,
      host_user_id: ctx.user.id,
      title,
      cap_amount: capAmount,
      is_active: true,
    });
    return { ok: true, treats: await treatListFor(ctx.classId) };
  },

  // 關閉請客（主人或管理員）
  async treatClose(data, ctx) {
    const treat = await findOne('treats', { id: Number(data.treatId) }, ctx.classId);
    if (!treat) throw appError('NOT_FOUND', '找不到此請客。');
    const isAdmin = ctx.user.role === 'Admin';
    const isHost = String(treat.host_user_id) === String(ctx.user.id);
    if (!isAdmin && !isHost) throw appError('FORBIDDEN', '只能關閉自己建立的請客。');
    await updateRows('treats', { id: treat.id }, { is_active: false, updated_at: new Date().toISOString() });
    return { ok: true, treats: await treatListFor(ctx.classId) };
  },

  /* ---------- 請假 ---------- */
  // 使用者申請請假（當天需於 9:00 前）
  async createLeave(data, ctx) {
    const leaveDate = String(data.leaveDate || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(leaveDate)) throw appError('INVALID_INPUT', '請選擇請假日期。');
    if (leaveDate < todayString()) throw appError('INVALID_INPUT', '請假日期不可在過去。');
    // 台灣時間 9:00 截止（當天申請）
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

    // 通知管理員
    const admins = await listRows('users', { classId: ctx.classId, filters: { role: 'Admin', is_disabled: false } });
    for (const admin of admins) {
      await sendPushToUser(admin.id, { title: '收到請假申請', body: `${ctx.user.student_name}（${ctx.user.seat_no}）申請 ${leaveDate} 請假，請處理。`, url: '/' });
    }
    return { ok: true };
  },

  // 我的請假紀錄
  async listLeave(_data, ctx) {
    const rows = await listRows('leave_requests', { classId: ctx.classId, filters: { user_id: ctx.user.id }, order: 'leave_date', orderAscending: false });
    return { requests: rows.map((r) => ({ id: sid(r.id), leaveDate: r.leave_date, reason: r.reason, status: r.status, requestedAt: r.requested_at })) };
  },

  // 管理員：全部請假（含歷史）
  async adminListLeave(data, ctx) {
    const status = data.status === 'Pending' ? 'Pending' : null;
    const rows = await listRows('leave_requests', { classId: ctx.classId, order: 'leave_date', orderAscending: false });
    const userIds = [...new Set(rows.map((r) => r.user_id).filter(Boolean))];
    const users = userIds.length ? await listRowsIn('users', 'id', userIds, { classId: ctx.classId }) : [];
    const userById = new Map(users.map((u) => [String(u.id), u]));
    const list = rows
      .filter((r) => (status ? r.status === status : true))
      .map((r) => {
        const u = userById.get(String(r.user_id));
        return { id: sid(r.id), userId: sid(r.user_id), seatNo: u?.seat_no || u?.student_no || '', studentName: u?.student_name || '已刪除帳號', leaveDate: r.leave_date, reason: r.reason, status: r.status, requestedAt: r.requested_at };
      });
    return { requests: list };
  },

  // 管理員批准/駁回請假；批准時取消該日訂單並退費（已繳者）
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
      // 找出該日該同學的場次與訂單，逐筆退款（已付儲值金退回錢包）
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

  /* ---------- 自訂欠費 ---------- */
  // 使用者自己的自訂欠費（含各筆明細）
  async myDebt(_data, ctx) {
    const rows = await listRows('custom_debts', { classId: ctx.classId, filters: { user_id: ctx.user.id }, order: 'created_at', orderAscending: false });
    return {
      total: round2(rows.reduce((sum, r) => sum + num(r.amount), 0)),
      entries: rows.map((r) => ({ id: sid(r.id), amount: num(r.amount), note: r.note, createdAt: r.created_at })),
    };
  },

  // 管理員：某位同學的自訂欠費明細 + 加減
  async adminListDebts(data, ctx) {
    const target = await findOne('users', { id: Number(data.userId) }, ctx.classId);
    if (!target) throw appError('NOT_FOUND', '找不到使用者。');
    const rows = await listRows('custom_debts', { classId: ctx.classId, filters: { user_id: target.id }, order: 'created_at', orderAscending: false });
    return {
      userId: sid(target.id),
      studentName: target.student_name,
      seatNo: target.seat_no || target.student_no,
      total: round2(rows.reduce((sum, r) => sum + num(r.amount), 0)),
      entries: rows.map((r) => ({ id: sid(r.id), amount: num(r.amount), note: r.note, createdAt: r.created_at })),
    };
  },

  async adminAddDebt(data, ctx) {
    const target = await findOne('users', { id: Number(data.userId) }, ctx.classId);
    if (!target) throw appError('NOT_FOUND', '找不到使用者。');
    const amount = num(data.amount);
    if (!Number.isFinite(amount) || amount === 0 || Math.abs(amount) > 100000) throw appError('INVALID_INPUT', '請輸入正確的金額（正數=增加欠費，負數=還款/減免）。');
    const note = String(data.note || '').trim().slice(0, 120) || (amount > 0 ? '自訂欠費' : '還款/減免');
    await insertRow('custom_debts', { class_id: ctx.classId, user_id: target.id, amount, note, created_by: ctx.user.id });
    const rows = await listRows('custom_debts', { classId: ctx.classId, filters: { user_id: target.id } });
    return { ok: true, total: round2(rows.reduce((sum, r) => sum + num(r.amount), 0)) };
  },

  async adminDeleteDebt(data, ctx) {
    await deleteRows('custom_debts', { id: Number(data.id) });
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
};
