# 建置步驟（約 30–40 分鐘，照順序做）

> 目標：Vercel（前端＋API）＋ Supabase（資料庫）＋ Gmail SMTP（Email）＋ Web Push（手機通知）。
> 舊的 Google 試算表／Apps Script 不再需要；既有資料不保留，全新開始。

---

## 第 1 步：建立 Supabase 專案（約 10 分鐘）

1. 到 https://supabase.com 註冊（免費）→ **New project**
   - Name：`class-lunch`，密碼自訂並**保存**，Region 選最接近你的（如 Singapore / Tokyo）
2. 建立後，到 **SQL Editor**，把 `supabase/schema.sql` 的內容**整段貼上執行**（建立資料表＋金流函式）
3. 到 **Project Settings → API** 複製兩樣東西：
   - `Project URL`（形如 `https://xxxx.supabase.co`）
   - `service_role` key（形如 `eyJ...`，**等同資料庫管理員權限，只放伺服器端**）
4. 到 **Project Settings → Database → Connection string**（選 **Transaction pooler**）複製備用（本機測試時用）

## 第 2 步：產生 VAPID 金鑰（推播用）

在專案資料夾本機執行（已安裝 Node 的話）：

```bash
npm install
npm run generate:vapid
```

會印出兩行 `VAPID_PUBLIC_KEY=...` 與 `VAPID_PRIVATE_KEY=...`，留著下一步用。

## 第 3 步：部署到 Vercel

1. 把這個資料夾推上 GitHub（`git add . && git commit && git push`）
2. 到 https://vercel.com/new 匯入儲存庫（設定已寫在 `vercel.json`，不用改）
3. 在 **Settings → Environment Variables** 新增：

| 變數 | 值 |
| --- | --- |
| `SUPABASE_URL` | 第 1 步的 Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | 第 1 步的 service_role key（新版介面為 Secret key） |
| `APP_URL` | 你的 Vercel 網址（如 `https://class-lunch.vercel.app`，不加斜線） |
| `SMTP_HOST` | `smtp.gmail.com` |
| `SMTP_PORT` | `465` |
| `SMTP_USER` | 你的 Gmail 帳號（第 4 步） |
| `SMTP_PASS` | Gmail 應用程式密碼 16 碼（第 4 步） |
| `EMAIL_FROM` | 如 `訂餐通 <你的gmail@gmail.com>`（必須與 SMTP_USER 同一帳號） |
| `VAPID_PUBLIC_KEY` | 第 2 步產生 |
| `VAPID_PRIVATE_KEY` | 第 2 步產生 |
| `CRON_SECRET` | 自訂一串隨機字元（排程保護用） |
| `DEVELOPER_MASTER_KEY` | 自訂另一串隨機字元（開發者註冊用） |

4. 按 **Deploy**，等建置完成。

## 第 4 步：Email（Gmail SMTP，免費、免網域，只有驗證信／重設信）

1. 用你的 Gmail 帳號：
   - 到「Google 帳戶 → 安全性」開啟**兩步驟驗證**
   - 搜尋「**應用程式密碼**」→ 新增（選「郵件」）→ 得到 16 碼密碼（記下來）
2. 把以下值填入 Vercel 環境變數：

| 變數 | 值 |
| --- | --- |
| `SMTP_HOST` | `smtp.gmail.com` |
| `SMTP_PORT` | `465` |
| `SMTP_USER` | 你的 Gmail 帳號 |
| `SMTP_PASS` | 16 碼應用程式密碼（不含空格） |
| `EMAIL_FROM` | `訂餐通 <你的gmail@gmail.com>`（必須是同一帳號） |

3. 重新部署後，管理員可到「管理 → 系統設定」看郵件狀態是否正常。

## 第 5 步：啟用截止提醒排程（選用）

部署完成後，到 Supabase **SQL Editor** 執行（把網址與 CRON_SECRET 換成你的）：

```sql
-- 先啟用擴充（只需一次）
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 再建立排程
select cron.schedule(
  'cutoff-reminders',
  '0 * * * *',
  $$ select net.http_post(
       url := 'https://你的-app.vercel.app/api/cron?secret=你的CRON_SECRET',
       headers := jsonb_build_object('Content-Type','application/json'),
       body := '{}'
     ) $$
);
```

> 若報 `schema "cron" does not exist`：表示 pg_cron 未啟用，先執行上面的 `create extension` 再試。
> 若報 `schema "net" does not exist`：表示 pg_net 未啟用，同樣先執行 `create extension`。

移除排程：`select cron.unschedule('cutoff-reminders');`

> **升級提醒**：若你的 Supabase 已執行過舊版 schema.sql（還沒有 `pin_hash` 欄位），請在 SQL Editor 額外執行：
> ```sql
> alter table public.verification_records add column if not exists pin_hash text not null default '';
> ```

> **升級提醒 2**：開發者信箱驗證與登入封鎖功能需要以下欄位，請額外執行：
> ```sql
> alter table public.developers add column if not exists email_verified boolean not null default false;
> alter table public.developers add column if not exists blocked_until timestamptz;
> alter table public.auth_tokens add column if not exists developer_id bigint references public.developers(id) on delete cascade;
> ```
> **升級提醒 3**：全體共用菜單與店家資訊需要以下欄位，請額外執行：
> ```sql
> alter table public.stores add column if not exists description text not null default '';
> alter table public.stores add column if not exists contact text not null default '';
> alter table public.stores add column if not exists is_global boolean not null default false;
> ```

## 第 6 步：建立第一個帳號（開發者）

1. 打開你的 Vercel 網址 → 登入頁最下方「**開發者入口**」→「註冊開發者帳號」
2. 輸入帳號／Email／密碼／**開發者金鑰**（＝Vercel 的 `DEVELOPER_MASTER_KEY`）
3. 登入開發者工作台 →「**核發代碼**」→ 輸入班級名稱（例如「三年甲班」）→ 彈出**班級管理者代碼**視窗（有「複製代碼」「分享」按鈕，**確認已複製才能關閉**）
4. 回到一般登入頁 →「註冊帳號」→ 填學號／座號／姓名／Email／密碼，**班級管理者代碼欄**貼上第 3 步的代碼
5. 收信輸入驗證碼 → 登入 → 此帳號即為**管理員**（可建立場次、菜單、掃碼、儲值）

## 第 7 步：學生加入（邀請碼）

1. 管理員 → 管理 →「設定」→「產生邀請碼」→ 彈出**邀請碼視窗**（有「複製代碼」「分享」按鈕，可直接分享到 LINE／Messenger 等，確認已複製才能關閉）
2. 學生註冊時在「邀請碼」欄貼上即可（一般使用者）
3. 學生登入後 → 右上角頭像（設定）→「**手機通知**」開啟 → 依提示把網站**釘選到桌面**（「釘選到桌面」會顯示逐步引導，iPhone：Safari「加入主畫面」；Android：Chrome「加到主畫面」）

## 第 8 步：更換班級管理者

1. 現任管理者 → 管理 →「帳號」分頁
2. 找到要升為管理者的學生 → 按「**設為管理**」
3. 班級有第二位管理者後，即可對另一位管理者按「**移除管理**」（系統保證至少保留一位管理者）

## 第 8 步：上線檢查

```bash
# 本機有 Node 的話：
API_BASE=https://你的-app.vercel.app/api/gas node scripts/smoke-test.js
```

接著實際測試：建立店家與餐點 → 建立場次 → 學生下單（純儲值／混合）→ QR 取餐 → 儲值抵欠款 → 匯出 CSV。

---

## 常見問題

- **手機收不到通知？** ① 需用 Chrome／Edge 並允許通知權限；② iPhone 需 iOS 16.4+ 且加入主畫面；③ 檢查 VAPID 金鑰是否已設定；④ 通知只會送到「已開啟通知」的裝置。
- **Email 寄不出去？** ① 確認 Gmail 已開「兩步驟驗證」並產生「應用程式密碼」（一般登入密碼不行）；② `SMTP_PASS` 為 16 碼、不含空格；③ `EMAIL_FROM` 必須是同一 Gmail 帳號；④ 管理員 →「系統設定」可看郵件狀態。Gmail SMTP 每日約 500 封上限（驗證信足夠）。
- **資料庫會休眠？** Supabase 免費層閒置 7 天才休眠；學生天天使用不會觸發，喚醒只要幾秒。
- **免費配額夠嗎？** 一個班級（50 人）每天數百次 API 呼叫，遠低於免費層上限。
