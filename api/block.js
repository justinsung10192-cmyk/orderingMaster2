// 管理員登入通知信中的「禁止登入」連結目標（GET /api/block?code=…）
// 點擊後：登出該管理員所有裝置，並封鎖登入 1 分鐘。
import { sha256Hex } from './_lib/util.js';
import { supabase, findOne } from './_lib/db.js';

export const config = { api: { bodyParser: false } };

function page(title, detail) {
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body style="margin:0;font-family:system-ui,-apple-system,sans-serif;background:#f8f5ee;display:grid;place-items:center;min-height:100vh"><div style="max-width:420px;width:100%;margin:24px;background:#fff;border-radius:20px;padding:32px;box-shadow:0 12px 40px rgba(22,48,42,.12);text-align:center"><h1 style="font-size:20px;margin:0 0 10px">${title}</h1><p style="color:#666;line-height:1.7;margin:0">${detail}</p></div></body></html>`;
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  try {
    const url = new URL(req.url, 'http://localhost');
    const code = url.searchParams.get('code') || '';
    if (!code) {
      res.status(400).send(page('連結不正確', '此連結缺少必要的參數。'));
      return;
    }
    const record = await findOne('auth_tokens', { token_hash: sha256Hex(code) });
    if (!record || new Date(record.expires_at).getTime() < Date.now()) {
      res.status(410).send(page('連結已失效', '此封鎖連結已過期或已被使用。'));
      return;
    }
    const blocked = new Date(Date.now() + 60 * 1000).toISOString();
    if (record.type === 'DevBlock' && record.developer_id) {
      // 登出開發者所有裝置並封鎖 1 分鐘
      await supabase.from('auth_tokens').delete().eq('developer_id', record.developer_id).eq('type', 'DevSession');
      await supabase.from('developers').update({ blocked_until: blocked }).eq('id', record.developer_id);
    } else if (record.type === 'AdminBlock' && record.user_id) {
      // 登出該管理員所有裝置並封鎖 1 分鐘
      await supabase.from('auth_tokens').delete().eq('user_id', record.user_id).eq('type', 'Session');
      await supabase.from('users').update({ admin_blocked_until: blocked }).eq('id', record.user_id);
    } else {
      res.status(410).send(page('連結已失效', '此封鎖連結已過期或已被使用。'));
      return;
    }
    // 使用過的封鎖連結即失效
    await supabase.from('auth_tokens').delete().eq('id', record.id);
    res.status(200).send(page('已封鎖該帳號', '該帳號的所有裝置已登出，並封鎖登入 1 分鐘。請確認實際操作者後再決定後續處置。'));
  } catch (error) {
    res.status(500).send(page('處理失敗', '請稍後再試。'));
  }
}
