// 排程端點密鑰驗證。
// 舊版以 ?secret=CRON_SECRET 傳遞，密鑰會落進 Vercel access log；
// 新版優先採用 Authorization: Bearer，並保留舊格式以相容既有 pg_cron job。
import crypto from 'node:crypto';

export const CRON_AUTH_HEADER = 'Authorization: Bearer <CRON_SECRET>';

export function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export function cronSecretFrom(req) {
  const headers = req?.headers || {};
  const authorization = String(headers.authorization || headers.Authorization || '');
  if (/^bearer\s+/i.test(authorization)) return authorization.replace(/^bearer\s+/i, '').trim();
  const custom = headers['x-cron-secret'] || headers['X-Cron-Secret'];
  if (custom) return String(custom).trim();
  try {
    const url = new URL(String(req?.url || '/'), 'http://localhost');
    return String(url.searchParams.get('secret') || '');
  } catch (_) {
    return '';
  }
}

// 未設定 CRON_SECRET 時一律拒絕（fail-closed）
export function verifyCronSecret(req, expected = process.env.CRON_SECRET) {
  const secret = String(expected || '');
  if (!secret) return false;
  return safeEqual(cronSecretFrom(req), secret);
}

// 是否仍以 query string 傳遞密鑰（用於提示升級）
export function usesLegacyQuerySecret(req) {
  const authorization = String(req?.headers?.authorization || '');
  const custom = req?.headers?.['x-cron-secret'];
  return !/^bearer\s+/i.test(authorization) && !custom && String(req?.url || '').includes('secret=');
}
