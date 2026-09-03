# 班級訂餐管理系統（Class Meal Ordering PWA）

手機優先（Mobile-First）的班級訂餐管理系統：訂餐、下週店家投票、儲值錢包、掃碼核銷、AI 菜單辨識與推播通知。
前端為原生 HTML + Vanilla JS（Vercel 靜態部署），後端為 **Supabase（PostgreSQL）**，通知使用 **Web Push（PWA 釘選桌面）**。

## 技術架構

```
瀏覽器（Vercel 靜態前端，可釘選到桌面 + Service Worker）
   │ POST /api/gas（{action, data, token} 統一合約）
   ▼
Vercel Serverless 函式（api/gas.js、api/cron.js）
   │
   ▼
Supabase PostgreSQL ──┬─ 金流原子運算（fn_settle_order / fn_topup / fn_settle_cash / fn_refund_order）
                      ├─ 登入 Token（PBKDF2 密碼雜湊，資料庫只存雜湊）
                      ├─ 37 組預設帳號（首次登入強制改密碼與姓名）
                      ├─ QR + 4 位 PIN 核銷（verification_records）
                      └─ pg_cron 每小時：截止提醒 → /api/cron
AI 辨識（Gemini 1.5 Flash / GPT-4o-mini）：api/_actions/ai.js（Server 端持金鑰）
推播（Web Push／VAPID）：訂餐開始、即將截止、每日欠繳催繳
即時同步：前端背景自動輪詢（30 秒）＋ 操作後立即刷新，資料更新時不中斷使用者操作
```

## 核心功能

- **帳號與權限**：37 組預設帳號、首次登入強制改密碼/姓名；「一般學生」與「管理者」權限、多位管理者、防呆（僅剩 1 位管理者不可移除自己）；管理者可新增/停用/刪除/重設密碼帳號。
- **純儲值模式**：開啟後餘額不足即禁止送出訂單；關閉時可「儲值金＋現金欠款」混合。
- **現場核銷**：每位使用者 x 場次產生「臨時 QR + 4 位 PIN」，管理者掃碼或輸入 PIN 快速執行儲值、扣款結帳、取餐標記。
- **菜單管理（資料夾式）**：店家 → 品項 → 客製選項（甜度/冰塊/加料，可加價）；支援 **AI 智慧辨識**（拍照 → Base64 → Gemini/GPT → 結構化 JSON → 預覽微調後寫入）。
- **排程與投票**：下週一～日多場次、各場次獨立截止時間、放假標記、一鍵公布；「下週店家許願投票」每人每週 3 票。
- **訂單**：同場次多品項、多數量、客製選項；截止前可自由修改/刪除；管理者即時匯總。
- **統計與催繳**：當日/單場次匯總、一鍵匯出 CSV、超過星期一未繳費自動名單 + 每日催繳推播 + 複製文字明細。

## 資料夾結構

| 路徑 | 說明 |
| --- | --- |
| `client/` | 前端（index.html、src/app.js、src/lunchDomain.js、PWA：manifest.json、sw.js、icons） |
| `api/` | Vercel 函式：`gas.js`（主路由器）、`cron.js`（排程）、`_actions/*`（動作）、`_lib/*`（共用層） |
| `supabase/schema.sql` | 資料庫 Schema＋37 組帳號種子＋金流函式 |
| `scripts/` | `generate-vapid.js`（VAPID 金鑰） |

> 註：`api/_actions/developer.js`、`merchant.js`、`api/_lib/mail.js`、`api/block.js`、`scripts/smoke-test.js` 為舊版殘留檔案，本版已不使用，可忽略或手動刪除。

## 本機預覽

```bash
npm install
npm run dev
```

完整建置步驟請見 **`SETUP_GUIDE.md`**。
