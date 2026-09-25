// 主路由器（v4 強化版）：前端以 POST /api/gas（text/plain JSON {action, data, token}）呼叫。
// 回應：{ ok:true, data, requestId } / { ok:false, error, code, requestId }
//
// v4 變更重點：
//   1) 權限集中到 _lib/policy.js（fail-closed：admin* / ai* 前綴一律僅限 Admin）
//   2) 每個請求帶 requestId、錯誤帶 code，並輸出結構化 log（Vercel 可直接搜尋）
//   3) body 大小分級：AI／備份類 12MB，其餘 256KB
import { randomUUID } from 'node:crypto';
import { readRawBody, sendJson, appError } from './_lib/util.js';
import { validateSession } from './_lib/auth.js';
import { assertAllowed, isPublicAction } from './_lib/policy.js';
import { reportEnv } from './_lib/env.js';
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
import { actions as calendarActions } from './_actions/calendar.js';
import { actions as featuresActions } from './_actions/features.js';
import { actions as rfidActions } from './_actions/rfid.js';

reportEnv();

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
  ...calendarActions,
  ...featuresActions,
  ...rfidActions,
};

// 需要大 body 的動作（圖片辨識／菜單匯入／備份還原）；其餘收斂到 256KB
const LARGE_BODY_ACTIONS = new Set([
  'aiRecognizeMenu', 'aiRecognizeMonthlyMenu', 'calendarAiRecognize',
  'adminImportMonthlyMenu', 'adminImportVendorMenu',
  'adminSaveMenuItem', 'adminBatchSaveMenuItems', 'adminRestoreBackup',
]);
const BODY_LIMIT_LARGE = 12 * 1024 * 1024;
const BODY_LIMIT_DEFAULT = 256 * 1024;

export const config = { api: { bodyParser: false } };

export const maxDuration = 60;

function logRequest(entry) {
  console.log(JSON.stringify({ at: 'api/gas', ...entry }));
}

export default async function handler(req, res) {
  const startedAt = Date.now();
  const requestId = randomUUID();
  let action = '';
  let ctx = { token: '', requestId };

  try {
    const declared = Number(req.headers?.['content-length'] || 0);
    if (declared && declared > BODY_LIMIT_LARGE) throw appError('INVALID_INPUT', '請求內容過大，請縮小圖片後再試。');

    const raw = await readRawBody(req, BODY_LIMIT_LARGE);
    const parsed = JSON.parse(raw || '{}');
    action = String(parsed?.action || '');
    const data = parsed?.data || {};
    const token = parsed?.token || '';

    if (!action || !HANDLERS[action]) throw appError('UNKNOWN_ACTION', '不支援的操作。');
    if (!LARGE_BODY_ACTIONS.has(action) && raw.length > BODY_LIMIT_DEFAULT) {
      throw appError('INVALID_INPUT', '請求內容過大。');
    }

    ctx = { token, requestId };
    if (!isPublicAction(action)) {
      ctx.user = await validateSession(token);
      ctx.classId = ctx.user.class_id;
      assertAllowed(action, ctx.user);
    }

    const result = await HANDLERS[action](data, ctx);
    logRequest({
      requestId,
      action,
      ok: true,
      ms: Date.now() - startedAt,
      userId: ctx.user?.id ?? null,
      role: ctx.user?.role ?? 'Public',
    });
    return sendJson(res, { ok: true, data: result, requestId });
  } catch (error) {
    const code = error?.code || 'INTERNAL';
    logRequest({
      requestId,
      action,
      ok: false,
      code,
      ms: Date.now() - startedAt,
      message: error?.message || '',
    });
    return sendJson(res, {
      ok: false,
      error: error?.message || '系統暫時無法完成此操作。',
      code,
      requestId,
    });
  }
}
