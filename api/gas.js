// 主路由器：前端以 POST /api/gas（text/plain JSON {action, data, token}）呼叫，
// 轉發至 Supabase PostgreSQL 處理，回傳 {ok, data} 或 {ok:false, error}。
import { readRawBody, sendJson, appError } from './_lib/util.js';
import { validateSession } from './_lib/auth.js';
import { actions as authActions } from './_actions/auth.js';
import { actions as ordersActions } from './_actions/orders.js';
import { actions as walletActions } from './_actions/wallet.js';
import { actions as verificationActions } from './_actions/verification.js';
import { actions as sessionsActions } from './_actions/sessions.js';
import { actions as menuActions } from './_actions/menu.js';
import { actions as votesActions } from './_actions/votes.js';
import { actions as adminActions } from './_actions/admin.js';
import { actions as aiActions } from './_actions/ai.js';
import { actions as pushActions } from './_actions/push.js';

const HANDLERS = {
  ...authActions,
  ...ordersActions,
  ...walletActions,
  ...verificationActions,
  ...sessionsActions,
  ...menuActions,
  ...votesActions,
  ...adminActions,
  ...aiActions,
  ...pushActions,
};

const PUBLIC = new Set(['getPublicConfig', 'login']);

const ADMIN = new Set([
  'adminSaveSession',
  'adminUpdateSessionCutoff',
  'adminSetWeekCutoff',
  'adminCloseSession',
  'adminDeleteSession',
  'adminPublishWeek',
  'adminSetHoliday',
  'adminRemoveHoliday',
  'adminGetWeekSchedule',
  'adminCatalog',
  'adminSaveStore',
  'adminDeleteStore',
  'adminSaveMenuItem',
  'adminDeleteMenuItem',
  'adminSetItemActive',
  'adminBatchSaveMenuItems',
  'adminTopUp',
  'adminSettleCash',
  'adminManualBalance',
  'adminResolveVerification',
  'adminResolvePin',
  'adminConfirmPickup',
  'adminGetDashboard',
  'adminGetDaySummary',
  'adminListUsers',
  'adminCreateUser',
  'adminSetUserDisabled',
  'adminDeleteUser',
  'adminResetPassword',
  'adminSetRole',
  'adminGetSettings',
  'adminSaveSettings',
  'adminGetOverdueList',
  'adminResetAllData',
  'adminResolveSeat',
  'adminSaveRecurring',
  'aiRecognizeMenu',
]);

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  try {
    const body = await readRawBody(req);
    const parsed = JSON.parse(body || '{}');
    const action = parsed?.action;
    const data = parsed?.data || {};
    const token = parsed?.token || '';

    if (!action || typeof action !== 'string' || !HANDLERS[action]) {
      return sendJson(res, { ok: false, error: '未知的動作。' });
    }

    const ctx = { token };
    if (!PUBLIC.has(action)) {
      ctx.user = await validateSession(token);
      ctx.classId = ctx.user.class_id;
      if (ADMIN.has(action) && ctx.user.role !== 'Admin') {
        throw appError('FORBIDDEN', '需要管理員權限。');
      }
    }

    const result = await HANDLERS[action](data, ctx);
    return sendJson(res, { ok: true, data: result });
  } catch (error) {
    return sendJson(res, { ok: false, error: error?.message || '系統暫時無法完成此操作。' });
  }
}
