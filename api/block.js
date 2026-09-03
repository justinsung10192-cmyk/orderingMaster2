// 舊版「禁止登入」端點已移除。保留為空函式，避免路由 404。
export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.status(410).send('此功能已停用。');
}
