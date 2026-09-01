// 主路由器：取代舊的「GAS 代理」。
// 前端仍以 POST /api/gas（text/plain JSON {action, data, token}）呼叫，
// 此函式把動作轉發給 Supabase Postgres 處理，並回傳 {ok, data} 或 {ok:false, error}。
import { readRawBody, sendJson, appError } from './_lib/util.js';
import { getAppSetting } from './_lib/db.js';
import { validateSession, validateDeveloperSession } from './_lib/auth.js';
import { actions as authActions } from './_actions/auth.js';
import { actions as ordersActions } from './_actions/orders.js';
import { actions as walletActions } from './_actions/wallet.js';
import { actions as verificationActions } from './_actions/verification.js';
import { actions as sessionsActions } from './_actions/sessions.js';
import { actions as adminActions } from './_actions/admin.js';
import { actions as developerActions } from './_actions/developer.js';
import { actions as merchantActions, validateMerchantSession } from './_actions/merchant.js';
import { actions as pushActions } from './_actions/push.js';

const HANDLERS = {
  ...authActions,
  ...ordersActions,
  ...walletActions,
  ...verificationActions,
  ...sessionsActions,
  ...adminActions,
  ...developerActions,
  ...merchantActions,
  ...pushActions,
};

const PUBLIC = new Set([
  'getPublicConfig',
  'register',
  'verifyRegistration',
  'resendRegistrationVerification',
  'login',
  'requestPasswordReset',
  'resetPassword',
  'developerLogin',
  'developerRegister',
  'developerVerifyEmail',
  'developerResendVerification',
  'applyClassAdmin',
  'verifyClassAdminApplication',
  'merchantLogin',
  'merchantRegister',
  'merchantVerifyEmail',
]);

const DEVELOPER = new Set([
  'developerLogout',
  'developerListUsers',
  'developerListClassAdminCodes',
  'developerGetSettings',
  'developerSaveSettings',
  'developerIssueClassAdminCode',
  'developerRevokeClassAdminCode',
  'developerGetUserDetails',
  'developerSetUserDisabled',
  'developerDeleteUser',
  'developerGetEmailDiagnostics',
  'developerBroadcast',
  'developerSetMaintenance',
  'developerListDevelopers',
  'developerDeleteDeveloper',
  'developerListMenu',
  'developerSaveStore',
  'developerDeleteStore',
  'developerSaveMenuItem',
  'developerSaveItemOption',
  'developerDeleteMenuItem',
  'developerDeleteItemOption',
  'developerListSchools',
  'developerSaveSchool',
  'developerListApplications',
  'developerApproveApplication',
  'developerRejectApplication',
  'developerListMerchants',
  'developerSetMerchantDisabled',
  'developerApproveMerchant',
]);

const MERCHANT = new Set(['merchantLogout', 'merchantGetDashboard', 'merchantGetMenu', 'merchantSaveStore', 'merchantSaveMenuItem', 'merchantSaveItemOption', 'merchantDeleteMenuItem', 'merchantDeleteItemOption']);

const ADMIN = new Set([
  'getAdminDashboard',
  'adminCatalog',
  'adminSaveStore',
  'adminSaveMenuItem',
  'adminSaveItemOption',
  'adminDeleteStore',
  'adminDeleteMenuItem',
  'adminDeleteItemOption',
  'adminSaveSession',
  'adminUpdateSessionCutoff',
  'adminCloseSession',
  'adminDeleteSession',
  'adminListUsers',
  'adminSetUserDisabled',
  'adminDeleteUser',
  'adminGetSettings',
  'adminSaveSettings',
  'adminListInviteCodes',
  'adminCreateInviteCode',
  'adminDisableInviteCode',
  'adminResolveVerification',
  'adminConfirmPickup',
  'adminSettleCash',
  'adminTopUp',
]);

export const config = { api: { bodyParser: false } };

async function isMaintenance() {
  try { return (await getAppSetting('', 'maintenance', '')) === '1'; } catch (_) { return false; }
}

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
    const maintenance = await isMaintenance();
    if (PUBLIC.has(action)) {
      const devPublic = action === 'developerLogin' || action === 'developerRegister' || action === 'developerVerifyEmail' || action === 'developerResendVerification';
      if (maintenance && !devPublic && action !== 'getPublicConfig') throw appError('MAINTENANCE', '系統維修中，請稍後再來。');
    } else if (DEVELOPER.has(action)) {
      ctx.developer = await validateDeveloperSession(token);
    } else if (MERCHANT.has(action)) {
      ctx.merchant = await validateMerchantSession(token);
    } else {
      if (maintenance) throw appError('MAINTENANCE', '系統維修中，請稍後再來。');
      ctx.user = await validateSession(token);
      ctx.classId = ctx.user.class_id;
      if (ctx.user.role === 'Developer') throw appError('FORBIDDEN', '開發者帳號無法使用一般功能。');
      if (ADMIN.has(action) && ctx.user.role !== 'Admin') throw appError('FORBIDDEN', '需要管理員權限。');
    }

    const result = await HANDLERS[action](data, ctx);
    return sendJson(res, { ok: true, data: result });
  } catch (error) {
    return sendJson(res, { ok: false, error: error?.message || '系統暫時無法完成此操作。' });
  }
}
