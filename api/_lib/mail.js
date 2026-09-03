// 本版已移除 Email 功能（37 組預設帳號由管理者直接管理，無需信箱驗證）。
// 此檔保留為空模組，避免舊程式碼引用時出錯。
export const mailConfigured = () => false;
export async function sendMail() {
  return { sent: false, message: 'Email 功能已停用。' };
}
export function verificationEmailHtml() { return ''; }
export function resetLinkEmailHtml() { return ''; }
