// 環境變數自檢：把設定問題在啟動時就講清楚，而不是線上才噴 500。
// 設計上「只警告、不中斷」——避免單一變數缺失造成整個站台不可用。
const REQUIRED = Object.freeze(['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']);
const RECOMMENDED = Object.freeze(['APP_URL', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'CRON_SECRET']);
const SECRET_KEY_PATTERN = /SUPABASE|VAPID|GEMINI|OPENAI|CRON/;
const PLACEHOLDER_PATTERN = /^(your[-_]|xxx|changeme|placeholder|example)/i;

export function checkEnv(env = process.env) {
  const read = (key) => String(env[key] || '').trim();
  const missingRequired = REQUIRED.filter((key) => !read(key));
  const missingRecommended = RECOMMENDED.filter((key) => !read(key));
  const placeholders = Object.keys(env)
    .filter((key) => SECRET_KEY_PATTERN.test(key))
    .filter((key) => PLACEHOLDER_PATTERN.test(read(key)));
  return { ok: missingRequired.length === 0, missingRequired, missingRecommended, placeholders };
}

export function reportEnv(env = process.env) {
  const report = checkEnv(env);
  if (report.missingRequired.length) {
    console.error('[env] 缺少必要環境變數：' + report.missingRequired.join(', '));
  }
  if (report.missingRecommended.length) {
    console.warn('[env] 缺少建議環境變數（對應功能將停用）：' + report.missingRecommended.join(', '));
  }
  if (report.placeholders.length) {
    console.warn('[env] 疑似仍為範例值：' + report.placeholders.join(', '));
  }
  return report;
}

export function assertEnv(env = process.env) {
  const report = checkEnv(env);
  if (!report.ok) throw new Error('環境變數設定不完整，缺少：' + report.missingRequired.join(', '));
  return report;
}
