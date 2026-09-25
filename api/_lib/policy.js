// 授權政策（Authorization Policy）— 全站唯一的權限真相來源。
//
// 設計原則：fail-closed（預設拒絕）。
//   1) 特權動作以「名稱前綴」判定（admin* / ai*）：新增端點不必登記就自動鎖定為 Admin，
//      修正舊版「新增 adminXxx 卻忘記加進 ADMIN 清單 → 學生可直接呼叫」的 fail-open 漏洞。
//   2) 明確清單為審查與文件來源；tests/registry.test.js 會驗證清單與原始碼同步，避免腐化。
//   3) 本檔只依賴 util.js，可獨立單元測試。
import { appError } from './util.js';

// 不需登入即可呼叫（login 必須公開；rfid 掃卡為硬體直呼）
export const PUBLIC_ACTIONS = Object.freeze([
  'getPublicConfig',
  'login',
  'rfidScan',
  'rfidHeartbeat',
]);

// 特權前綴：任何以此開頭且接大寫字母的動作，一律僅限 Admin
export const ADMIN_PREFIXES = Object.freeze(['admin', 'ai']);

// 明確的管理員動作清單（與 v3.5.3 gas.js 完全一致，行為不變）
export const ADMIN_ACTIONS = Object.freeze([
  'adminSaveSession', 'adminUpdateSessionCutoff', 'adminSetWeekCutoff', 'adminCloseSession',
  'adminDeleteSession', 'adminPublishWeek', 'adminSetHoliday', 'adminRemoveHoliday',
  'adminGetWeekSchedule', 'adminCatalog', 'adminSaveStore', 'adminDeleteStore',
  'adminSaveMenuItem', 'adminDeleteMenuItem', 'adminSetItemActive', 'adminBatchSaveMenuItems',
  'adminTopUp', 'adminSettleCash', 'adminPartialPay', 'adminSettleWeek', 'adminManualBalance',
  'adminResolveVerification', 'adminResolvePin', 'adminConfirmPickup', 'adminGetDashboard',
  'adminGetDaySummary', 'adminGetActivityLog', 'adminListUsers', 'adminCreateUser',
  'adminSetUserDisabled', 'adminDeleteUser', 'adminResetPassword', 'adminSetRole',
  'adminGetSettings', 'adminSaveSettings', 'adminGetOverdueList', 'adminResetAllData',
  'adminResolveSeat', 'adminSaveRecurring', 'adminClearRecurring',
  'aiRecognizeMenu', 'aiRecognizeMonthlyMenu', 'adminImportMonthlyMenu', 'adminImportVendorMenu',
  'adminGetDailyMenus', 'adminDeleteDailyMenu', 'adminDeleteDailyMenuItem', 'adminClearDailyMenus',
  'adminCancelOrder', 'adminGetOrderContext', 'adminEditOrder', 'adminExportBackup',
  'adminSetDutyExempt', 'adminSetDuty', 'adminClearDuty', 'adminRestoreBackup',
  'adminBroadcast', 'adminGetPushStatus', 'calendarLogs', 'aiGetSettings', 'aiSaveSettings',
  'adminGetTreatSessions', 'adminListLeave', 'adminResolveLeave', 'adminDeleteRecommendation',
  'adminAddChangelog', 'adminDeleteChangelog',
  'rfidGetConfig', 'rfidListCards', 'rfidStartRegister', 'rfidCancelRegister',
  'rfidUnregisterCard', 'rfidPoll', 'rfidLive',
]);

// 教師（Teacher）僅能使用行事曆與個人設定（加法模型，不再使用「除…之外全開」）
export const TEACHER_ACTIONS = Object.freeze([
  'getBootstrap', 'getSession',
  'calendarList', 'calendarCreate', 'calendarUpdate', 'calendarDelete',
  'completeSetup', 'updateProfile', 'changePassword', 'logout',
  'pushSubscribe', 'pushUnsubscribe', 'getChangelog',
]);

export const ROLES = Object.freeze(['Admin', 'Teacher', 'Student']);

const PUBLIC = new Set(PUBLIC_ACTIONS);
const ADMIN = new Set(ADMIN_ACTIONS);
const TEACHER = new Set(TEACHER_ACTIONS);

// adminFoo / aiFoo → true；admin / adminfoo / administrator → false（需大寫接續）
export function isPrefixedAdmin(action) {
  const name = String(action || '');
  return ADMIN_PREFIXES.some((prefix) => (
    name.length > prefix.length
    && name.startsWith(prefix)
    && /[A-Z]/.test(name.charAt(prefix.length))
  ));
}

export const isPublicAction = (action) => PUBLIC.has(String(action || ''));
export const isAdminOnly = (action) => ADMIN.has(String(action || '')) || isPrefixedAdmin(action);
export const isTeacherAllowed = (action) => TEACHER.has(String(action || ''));

// 唯一的授權判斷入口。與 v3.5.3 行為相容，但多出「前綴保護」。
export function assertAllowed(action, user) {
  if (isPublicAction(action)) return;
  if (!user) throw appError('UNAUTHORIZED', '請先登入。');
  if (isAdminOnly(action) && user.role !== 'Admin') {
    throw appError('FORBIDDEN', '需要管理員權限。');
  }
  if (user.role === 'Teacher' && !isTeacherAllowed(action)) {
    throw appError('FORBIDDEN', '教師帳號僅能使用行事曆與個人設定。');
  }
}

// 供 CI／測試與線上診斷使用的政策報表
export function policyReport(actionNames = []) {
  const names = [...new Set(actionNames.map((n) => String(n)))].sort();
  return {
    total: names.length,
    public: names.filter(isPublicAction),
    admin: names.filter(isAdminOnly),
    teacher: names.filter(isTeacherAllowed),
    member: names.filter((n) => !isPublicAction(n) && !isAdminOnly(n)),
    // 政策有寫、原始碼卻找不到 → 清單腐化
    staleInPolicy: [...new Set([...PUBLIC, ...ADMIN, ...TEACHER])].filter((n) => !names.includes(n)).sort(),
    // 原始碼有 admin*/ai* 動作卻沒列進明確清單 → 請補登（前綴仍會擋，但清單要完整）
    unlistedAdmin: names.filter((n) => isPrefixedAdmin(n) && !ADMIN.has(n)),
  };
}
