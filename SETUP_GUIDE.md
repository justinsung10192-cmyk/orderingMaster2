# 建置步驟（約 20–30 分鐘，照順序做）

> 目標：Vercel（前端＋API）＋ Supabase（資料庫）＋ Web Push（手機通知）＋ AI 菜單辨識（選用）。

---

## 第 1 步：建立 Supabase 專案（約 5 分鐘）

> ⚠️ **請使用「全新的 Supabase 專案」**，不要沿用舊版（v2 商家/學校/開發者版）的資料庫。舊資料不保留，全新開始。

1. 到 https://supabase.com 註冊（免費）→ **New project**（Region 選最接近你的，如 Singapore / Tokyo）
2. 建立後，到 **SQL Editor**，把 `supabase/schema.sql` 的內容**整段貼上執行**。
   - 這會建立所有資料表、金流函式，並**自動建立 demo 班級 + 37 組預設帳號 + 示範店家/菜單**。
3. 到 **Project Settings → API** 複製兩樣：
   - `Project URL`（形如 `https://xxxx.supabase.co`）
   - `service_role` key（形如 `eyJ...`，**等同資料庫管理員權限，只放伺服器端**）

## 第 2 步：產生 VAPID 金鑰（推播用）

```bash
npm install
npm run generate:vapid
```

印出 `VAPID_PUBLIC_KEY=` 與 `VAPID_PRIVATE_KEY=`，留著下一步用。

## 第 3 步：部署到 Vercel

1. 把這個資料夾推上 GitHub（`git add . && git commit && git push`）
2. 到 https://vercel.com/new 匯入儲存庫（設定已寫在 `vercel.json`，不用改）
3. 在 **Settings → Environment Variables** 新增：

| 變數 | 值 |
| --- | --- |
| `SUPABASE_URL` | 第 1 步的 Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | 第 1 步的 service_role key |
| `APP_URL` | 你的 Vercel 網址（如 `https://class-meal.vercel.app`，不加斜線） |
| `VAPID_PUBLIC_KEY` | 第 2 步產生 |
| `VAPID_PRIVATE_KEY` | 第 2 步產生 |
| `CRON_SECRET` | 自訂一串隨機字元（排程保護用） |
| `GEMINI_API_KEY` | （選用）AI 菜單辨識，https://aistudio.google.com/apikey |
| `OPENAI_API_KEY` | （選用）AI 菜單辨識，Gemini 未設定時自動改用 |

4. 按 **Deploy**，等建置完成。

## 第 4 步：啟用排程（截止提醒 / 催繳推播，選用但建議）

部署完成後，到 Supabase **SQL Editor** 執行（把網址與 CRON_SECRET 換成你的）：

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'meal-reminders',
  '0 * * * *',
  $$ select net.http_post(
       url := 'https://你的-app.vercel.app/api/cron?secret=你的CRON_SECRET',
       headers := jsonb_build_object('Content-Type','application/json'),
       body := '{}'
     ) $$
);
```

移除排程：`select cron.unschedule('meal-reminders');`

## 第 5 步：登入與初始設定

**37 組預設帳號**：座號 `01`～`37`，預設密碼一律 `lunch1234`。

1. 用座號 `01` 登入（預設為**管理者**）。
2. 首次登入會強制要求設定**姓名**與**新密碼**，完成後即可進入系統。
3. 其他同學以各自座號登入，同樣需設定姓名與密碼。

> 變更密碼後請記得：預設密碼 `lunch1234` 僅供第一次登入使用。

## 第 6 步：管理者初始化菜單與排程

1. 進入「**管理 → 菜單**」：新增店家 → 手動新增品項，或按「**📷 AI 辨識菜單**」拍照/上傳，AI 會自動抓品項與價格，確認後寫入。
2. 進入「**管理 → 排程**」：切換到「下週」，逐日新增場次（店家 + 截止時間），需要放假的日子標記「放假」。
3. 排定後按「**一鍵公布本週**」→ 學生即可開始訂餐（會推播通知）。

## 第 7 步：學生使用

1. 學生登入後於「**訂餐**」頁依「週別 → 日期 → 店家」資料夾找到場次，點入下單（多品項、數量、客製選項）。
2. 「**投票**」頁每週 3 票，投給下週想吃的店家。
3. 「**錢包**」頁可查看餘額、交易紀錄，並「出示取餐 QR / PIN」。
4. 「**設定**」頁開啟「**手機通知**」並依提示把網站**釘選到桌面**（iPhone：Safari「加入主畫面」；Android：Chrome「加到主畫面」）。

## 第 8 步：管理者核銷與收款

1. 「**管理 → 核銷**」：掃學生 QR 或輸入 4 位 PIN，即可：
   - **儲值**：輸入金額，系統先抵最舊欠款、剩餘入錢包。
   - **扣款結帳**：現金結清未繳訂單。
   - **取餐標記**：標記今日訂單為已取餐。
2. 「**管理 → 總覽**」：當日訂單匯總，一鍵「**匯出 CSV**」。
3. 「**管理 → 設定 → 欠繳催繳名單**」：查看超過星期一仍未繳費名單，一鍵「複製文字明細」貼至班級群組；系統每日自動發送催繳推播。

## 常見問題

- **手機收不到通知？** ① 需用 Chrome／Edge 並允許通知權限；② iPhone 需 iOS 16.4+ 且「加入主畫面」；③ 確認 VAPID 金鑰已設定；④ 通知只會送到「已開啟通知」的裝置。
- **AI 辨識失敗？** ① 確認已設定 `GEMINI_API_KEY` 或 `OPENAI_API_KEY`；② 照片務必清晰、正對菜單；③ 若完全辨識不到會回傳空清單，可改手動新增。
- **純儲值模式**：於「管理 → 設定」開啟；開啟後學生餘額不足即無法送出訂單。
- **免費配額夠嗎？** 一個班級（37 人）每天數百次 API 呼叫，遠低於免費層上限；Gemini 1.5 Flash 免費層亦足夠日常使用。
