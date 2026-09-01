// 郵件層：Gmail SMTP（免費、免網域）——只用於驗證信與密碼重設信
// 設定方式：
//   1) Gmail「帳戶安全性」開啟兩步驟驗證
//   2) 產生「應用程式密碼」(16 碼，僅限郵件)
//   3) 填入環境變數 SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS（EMAIL_FROM 可選）
import nodemailer from 'nodemailer';

let transporter = null;

export function mailConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function getTransporter() {
  if (transporter) return transporter;
  const port = Number(process.env.SMTP_PORT || 465);
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port,
    secure: port === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
  return transporter;
}

function senderAddress() {
  if (process.env.EMAIL_FROM) return process.env.EMAIL_FROM;
  return `訂餐通 <${process.env.SMTP_USER}>`;
}

export async function sendMail({ to, subject, html }) {
  if (!mailConfigured()) return { sent: false, message: '郵件服務尚未設定（請設定 SMTP_USER / SMTP_PASS）。' };
  if (!to || !String(to).includes('@')) return { sent: false, message: '電子郵件地址不正確。' };
  try {
    await getTransporter().sendMail({ from: senderAddress(), to, subject, html });
    return { sent: true, message: '已寄出。' };
  } catch (error) {
    return { sent: false, message: `郵件寄送失敗：${error.message || '請稍後再試。'}` };
  }
}

export function verificationEmailHtml(code) {
  return `
  <div style="font-family:'Noto Sans TC',sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#173B62">
    <h2 style="margin:0 0 16px;color:#173B62">班級訂午餐系統 — 信箱驗證</h2>
    <p style="line-height:1.8">你的驗證碼是：</p>
    <div style="margin:16px 0;padding:16px;background:#EEF3F5;border-radius:12px;text-align:center;font-size:28px;font-weight:900;letter-spacing:8px;color:#173B62">${code}</div>
    <p style="line-height:1.8;color:#5b6b7a;font-size:14px">驗證碼 15 分鐘內有效。若這不是你本人操作，請忽略此信。</p>
    <p style="margin-top:24px;font-size:12px;color:#9aa8b5">班級訂午餐系統</p>
  </div>`;
}

export function resetEmailHtml(code) {
  return `
  <div style="font-family:'Noto Sans TC',sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#173B62">
    <h2 style="margin:0 0 16px;color:#173B62">班級訂午餐系統 — 密碼重設</h2>
    <p style="line-height:1.8">你的密碼重設碼是：</p>
    <div style="margin:16px 0;padding:16px;background:#EEF3F5;border-radius:12px;text-align:center;font-size:28px;font-weight:900;letter-spacing:8px;color:#173B62">${code}</div>
    <p style="line-height:1.8;color:#5b6b7a;font-size:14px">重設碼 15 分鐘內有效，請回到「登入 → 忘記密碼」頁面輸入重設碼並設定新密碼。若這不是你本人操作，請忽略此信。</p>
    <p style="margin-top:24px;font-size:12px;color:#9aa8b5">班級訂午餐系統</p>
  </div>`;
}

export function adminLoginAlertHtml({ name, studentNo, className, time, blockUrl }) {
  return `
  <div style="font-family:'Noto Sans TC',sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#173B62">
    <h2 style="margin:0 0 8px;color:#173B62">管理員登入通知</h2>
    <p style="margin:0 0 16px;color:#5b6b7a;line-height:1.8">偵測到管理員帳號登入。若這不是本人操作，請立即封鎖。</p>
    <table style="width:100%;border-collapse:collapse;font-size:14px;line-height:1.8">${[['登入者', name], ['學號', studentNo], ['班級', className], ['時間', time]].map(([key, value]) => `<tr><td style="padding:6px 8px;color:#8a97a5">${key}</td><td style="padding:6px 8px;font-weight:700">${value}</td></tr>`).join('')}</table>
    <a href="${blockUrl}" style="display:block;margin-top:20px;text-align:center;background:#b3261e;color:#fff;text-decoration:none;padding:14px;border-radius:12px;font-weight:700">🔒 禁止此管理員登入（登出所有裝置，封鎖 1 分鐘）</a>
    <p style="margin-top:16px;font-size:12px;color:#9aa8b5">此封鎖連結 30 分鐘內有效。緊急事件請使用開發者工作台處理。</p>
  </div>`;
}

export function developerLoginAlertHtml({ name, email, time, blockUrl }) {
  return `<div style="font-family:'Noto Sans TC',sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#173B62">
    <h2 style="margin:0 0 8px;color:#173B62">開發者登入通知</h2>
    <p style="margin:0 0 16px;color:#5b6b7a;line-height:1.8">偵測到開發者帳號登入。若這不是本人操作，請立即封鎖。</p>
    <table style="width:100%;border-collapse:collapse;font-size:14px;line-height:1.8">${[['登入者', name], ['Email', email], ['時間', time]].map(([key, value]) => `<tr><td style="padding:6px 8px;color:#8a97a5">${key}</td><td style="padding:6px 8px;font-weight:700">${value}</td></tr>`).join('')}</table>
    <a href="${blockUrl}" style="display:block;margin-top:20px;text-align:center;background:#b3261e;color:#fff;text-decoration:none;padding:14px;border-radius:12px;font-weight:700">🔒 禁止此開發者登入（登出所有裝置，封鎖 1 分鐘）</a>
    <p style="margin-top:16px;font-size:12px;color:#9aa8b5">此封鎖連結 30 分鐘內有效。</p>
  </div>`;
}
export function classAdminCodeEmailHtml({ name, className, code, frontendUrl = '' }) {
  return `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;background:#f8f5ee;border-radius:16px;padding:24px;color:#16302a"><h2 style="margin:0 0 8px">班級管理者代碼已核發</h2><p style="margin:0 0 16px;color:#666">${name}（${className}）：你的班級管理者代碼已審核通過。</p><div style="background:#fff;border-radius:12px;padding:20px;text-align:center;border:1px dashed #1c4a2e"><p style="margin:0 0 8px;font-size:12px;color:#888">一次性管理者代碼（僅顯示一次）</p><code style="font-size:24px;font-weight:800;letter-spacing:.12em;color:#1c4a2e">${code}</code></div><p style="margin:16px 0 0;font-size:13px;line-height:1.8;color:#5b6b7a">請到 ${frontendUrl} 的「註冊帳號」頁，選擇「班級管理者註冊」並輸入此代碼完成註冊。請勿將代碼貼到公開群組。</p></div>`;
}
export function resetLinkEmailHtml({ link, minutes = 15 }) {
  return `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;background:#f8f5ee;border-radius:16px;padding:24px;color:#16302a"><h2 style="margin:0 0 8px">重設你的登入密碼</h2><p style="margin:0 0 16px;color:#666">有人請求重設你的訂餐通密碼。點下方按鈕即可設定新密碼。</p><a href="${link}" style="display:block;text-align:center;background:#1c4a2e;color:#fff;text-decoration:none;padding:14px;border-radius:12px;font-weight:bold">設定新密碼</a><p style="margin:16px 0 0;font-size:12px;color:#999">此連結 ${minutes} 分鐘內有效；若這不是你本人操作，請忽略此信。</p></div>`;
}
