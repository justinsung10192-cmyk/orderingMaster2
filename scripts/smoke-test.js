// 上線冒煙測試：對已部署的 /api/gas 做基本動作測試
// 用法：API_BASE=https://你的-app.vercel.app/api/gas node scripts/smoke-test.js
const base = process.env.API_BASE || 'http://localhost:3000/api/gas';

async function call(action, data = {}, token = '') {
  const response = await fetch(base, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action, data, token }),
  });
  const json = await response.json();
  return json;
}

function log(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) process.exitCode = 1;
}

const results = {};

// 1. 公開設定
const config = await call('getPublicConfig');
results.config = config.ok && typeof config.data.vapidPublicKey === 'string' && config.data.vapidPublicKey.length > 10;
log('getPublicConfig（含 VAPID 公鑰）', results.config);

// 2. 未登入應被拒絕
const denied = await call('getBootstrap', {}, '');
results.denied = !denied.ok && denied.error;
log('未登入被拒絕', results.denied, denied.error || '');

// 3. 錯誤密碼登入應被拒絕
const badLogin = await call('login', { studentNo: '0000000', password: 'wrongpass' });
results.badLogin = !badLogin.ok;
log('錯誤學號登入被拒絕', results.badLogin, badLogin.error || '');

console.log('\n說明：');
console.log('- 若以上通過，表示 API 已連上 Supabase 並正常回應。');
console.log('- 註冊／下單等完整流程請在網站上實際操作驗證（需先建立邀請碼）。');
