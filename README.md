# 班級訂午餐系統 v2（Supabase 雲端版）

手機優先的班級訂午餐、儲值錢包與取餐核對系統。前端為原生 HTML + Vanilla JS（Vercel 靜態部署），
後端為 **Supabase（PostgreSQL）**，通知使用 **Web Push（PWA 釘選到桌面）**，Email 僅用於驗證信與密碼重設信。

## 技術架構

```
瀏覽器（Vercel 靜態前端，可釘選到桌面）
   │ POST /api/gas（同一套 action 合約）
   ▼
Vercel Serverless 函式（api/gas.js、api/cron.js）
   │
   ▼
Supabase PostgreSQL ──┬─ 金流原子運算（fn_settle_order / fn_topup / fn_settle_cash / fn_refund_order）
                      ├─ 登入 Token、驗證碼、重設碼（資料庫只存雜湊）
                      ├─ 推播訂閱（push_subscriptions）
                      └─ pg_cron 每小時截止提醒 → /api/cron
Email（Resend）：只有註冊驗證信、密碼重設信
推播（Web Push／VAPID）：新場次開放、截止提醒、餐點可取餐
```

## 資料夾結構

| 路徑 | 說明 |
| --- | --- |
| `client/` | 前端（index.html、src/app.js、PWA：manifest.json、sw.js、icons） |
| `api/` | Vercel 函式：`gas.js`（主路由器）、`cron.js`（排程）、`_actions/*`（動作）、`_lib/*`（共用層） |
| `supabase/schema.sql` | 資料庫 Schema＋金流函式＋pg_cron 排程範例 |
| `scripts/` | `generate-vapid.js`（VAPID 金鑰）、`smoke-test.js`（上線測試） |

## 本機預覽

```bash
npm install
npm run dev
```

完整建置步驟請見 **`SETUP_GUIDE.md`**。
