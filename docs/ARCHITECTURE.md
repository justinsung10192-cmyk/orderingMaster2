# 系統架構（v4 分支）

> 本文件描述「現在的架構長什麼樣」、「這次改了什麼」、「接下來要往哪裡走」。
> 相關決策記錄在 [`docs/ADR/`](ADR/)。
>
> 適用版本：`3.5.3` + `feat/v4-hardening` 分支的架構強化。

---

## 1. 一句話總結

一個給單一班級使用的訂餐 PWA：前端是靜態網頁（Vite + Vanilla JS + Tailwind），
後端是三個 Vercel Serverless Function（`api/gas.js`、`api/cron.js`、`api/version.js`），
資料放在 Supabase PostgreSQL，所有寫入都經過 server 端的 `service_role` 與金額 RPC。

**核心設計原則（這次強化的重點）**

| 原則 | 意思 | 落地方式 |
| --- | --- | --- |
| Fail-closed | 不確定時，拒絕 | 授權政策：`admin*` / `ai*` 前綴一律視為特權（ADR 0002） |
| Single source of truth | 同一件事只有一份定義 | `api/_lib/policy.js`、`supabase/migrations/`（ADR 0003） |
| 正確性由結構保證 | 靠機制而不是靠自律 | 遷移規則檢查、一致性檢查、CI（ADR 0003 / 0005） |

---

## 2. 分層與檔案地圖

```text
ORDERING-MASTER-main/
├── api/                          ← 後端（Vercel Functions，Node ESM）
│   ├── gas.js                    ← 唯一 API 入口：POST /api/gas
│   ├── cron.js                   ← 排程入口：POST /api/cron（Bearer CRON_SECRET）
│   ├── version.js                ← 版本探測（快取用）
│   ├── _lib/                     ← 後端共用層（不屬於任何業務）
│   │   ├── db.js                 ← Supabase admin client + query helper
│   │   ├── auth.js               ← PBKDF2 密碼、session token、auth_version
│   │   ├── policy.js             ← ★ 授權唯一真相：PUBLIC / TEACHER / ADMIN / 前綴
│   │   ├── util.js               ← AppError、body 讀取、時間週別工具
│   │   ├── push.js               ← Web Push / VAPID
│   │   ├── env.js                ← 環境變數自我檢查
│   │   └── cronAuth.js           ← 排程密鑰驗證（Bearer / header / 舊 query）
│   └── _actions/                 ← 業務動作（依領域拆分，回傳純資料）
│       ├── auth.js orders.js wallet.js sessions.js menu.js votes.js
│       ├── verification.js admin.js ai.js push.js calendar.js
│       ├── features.js rfid.js
│
├── client/                       ← 前端（Vite 建置，輸出 dist/public）
│   ├── index.html sw.js manifest.webmanifest
│   └── src/
│       ├── app.js                ← 主程式與狀態（學生端）
│       ├── admin.js              ← 管理端（目前最大的一支）
│       └── styles.css
│
├── supabase/
│   ├── schema.sql                ← 新環境建庫用（現在已含全部索引）
│   ├── migrations/               ← ★ 版本化遷移（0001～），唯一變更來源
│   └── migration_*.sql           ← 舊流程的歷史檔案（保留，不再新增）
│
├── scripts/
│   ├── lib/migrations.mjs        ← 遷移規則的實作（可被測試）
│   ├── migrations.mjs            ← CLI：list / verify / bundle
│   ├── check-consistency.mjs     ← 文件/程式碼/Schema 一致性檢查
│   ├── backup.js generate-vapid.js generate-icons.mjs smoke-test.js
│
├── tests/                        ← 零依賴單元測試（node:test）
│   ├── policy.test.js registry.test.js util.test.js cronAuth.test.js
│   └── migrations.test.js consistency.test.js
│
└── .github/workflows/ci.yml      ← ★ CI：測試 + 遷移檢查 + 一致性 + 建置
```

---

## 3. 請求生命週期（`POST /api/gas`）

```text
瀏覽器
  │  POST /api/gas            body: { action, data, token }（text/plain，避免 preflight）
  ▼
api/gas.js
  1. 產生 requestId (uuid)
  2. 檢查 content-length；讀 body（上限分級：預設 256KB，AI/備份類 12MB）
  3. 解析 action → 查 HANDLERS（未知動作 → UNKNOWN_ACTION）
  4. 若 action 非公開 → validateSession(token) → ctx.user / ctx.classId
  5. assertAllowed(action, user)   ← api/_lib/policy.js（fail-closed）
  6. handler(data, ctx)            ← api/_actions/*.js（只處理業務，回傳純資料）
  7. 結構化 log（JSON 單行，含 requestId / action / 是否成功 / 耗時 / userId / role）
  8. 回應 { ok: true, data, requestId } 或 { ok: false, error, code, requestId }
```

**為什麼只有一個入口**：授權、body 上限、錯誤格式、稽核紀錄都只需要在一個地方做對一次。
新增功能時只增加 `api/_actions/<領域>.js` 的一個動作，不必碰路由（見 ADR 0001）。

### 三個權限層級

| 層級 | 誰可以呼叫 | 來源 | 例子 |
| --- | --- | --- | --- |
| Public | 任何人（不需 token） | `PUBLIC_ACTIONS` | `login`, `getPublicConfig`, `rfidScan` |
| Teacher | 已登入且非 Admin 的教師 | `TEACHER_ACTIONS`（白名單） | `calendarList`, `changePassword` |
| Admin | `role === 'Admin'` | `ADMIN_ACTIONS` ＋ **`admin*` / `ai*` 前綴** | `adminTopUp`, `aiRecognizeMenu` |
| Member | 其他已登入者（學生） | 隱含（非以上三類） | `placeOrder`, `debtCreate` |

> **關鍵修正**：舊版是「列出 admin 動作清單，沒列到的就放行」（fail-open）——
> 只要有人新增 `adminDeleteEverything` 而忘記登記，學生就能呼叫。
> 現在改成：**名字以 `admin` / `ai` 開頭的一律視為特權動作**，忘記登記最多是「管理員不能用」，
> 而不是「學生可以用」。見 [ADR 0002](ADR/0002-fail-closed-authorization.md)。

---

## 4. 資料庫與遷移流程

### 現況

- 21 張表，金額相關的重點表：`orders`、`transactions`、`auth_tokens`、`push_subscriptions`。
- **金額正確性放在資料庫**：`fn_settle_order`、`fn_topup`、`fn_settle_cash`、`fn_refund_order`、
  `fn_delete_session_and_refund`、`fn_manual_balance`、`fn_partial_pay` 都是
  `security definer` + `for update` 鎖列。這是對的設計，**不要改掉**。
- 服務端只使用 `service_role` key；前端永遠拿不到。

### 這次新增的遷移流程

```text
supabase/migrations/0001_schema_migrations.sql      追蹤表（哪一版跑過了）
supabase/migrations/0002_performance_indexes.sql    補齊 8 個缺失索引
supabase/migrations/0003_audit_log.sql              append-only 事件紀錄
supabase/migrations/0004_request_id_idempotency.sql 金流冪等鍵（地基）
```

```bash
npm run db:list              # 看有哪些遷移與 checksum
npm run db:verify            # 命名/編號/無破壞性語法 + bundle 是否同步（CI 會跑）
npm run db:bundle            # 產生 supabase/migrations/_generated_bundle.sql
# → 把 bundle 整段貼進 Supabase「SQL Editor」執行（可重複執行）
```

規則：**已跑過的遷移檔不可修改**，要改就新增下一個編號。`checksum` 會被寫進
`schema_migrations`，因此「偷改已上線的遷移」是可被發現的。

### 為什麼要補索引

原本 `migration_perf_indexes.sql` 有 8 個索引，但 `schema.sql` 沒有：
用舊資料庫升級的人很快，**照 `schema.sql` 新建資料庫的人特別慢**，而且查不出原因。
現在兩邊都有（`consistency.test.js` 會強制這件事）。

---

## 5. 金流冪等：分階段落地

| 階段 | 內容 | 狀態 |
| --- | --- | --- |
| ① 地基 | `transactions` / `orders` 加 `request_id`（可為 null）+ partial unique index | ✅ 本次完成（0004） |
| ② 稽核 | `audit_log` + trigger 記錄每一筆交易與訂單變更 | ✅ 本次完成（0003） |
| ③ 應用層 | `api/gas.js` 為寫入型動作產生 `requestId` 並往下傳 | ⏳ 待做 |
| ④ RPC 層 | 金額 RPC 接受 `p_request_id`，重複時回傳首次結果 | ⏳ 待做（需真實資料庫整合測試） |

**為什麼③④沒有一次做完**：改動金額函式是這個系統風險最高的變更，而且 `schema.sql` 內同一支
函式有多份定義（靠最後一份覆蓋），靜態閱讀很容易看錯。這種改動必須有真資料庫的整合測試
（同一 request_id 送兩次，驗證只扣一次款）才准上線。

---

## 6. 可觀測性

| 來源 | 內容 | 保留期 |
| --- | --- | --- |
| Vercel Function log | 結構化 JSON：`requestId / action / ok / code / ms / userId / role` | 短期（會被輪替） |
| `audit_log`（新） | 交易與訂單的 before/after、操作者、requestId | 永久（append-only 慣例） |
| `schema_migrations`（新） | 哪一版遷移在什麼時候被套用 | 永久 |
| `calendar_event_logs`、`changelog` | calendar 相關與版本紀錄 | 既有 |

排程 `api/cron.js` 使用 `Authorization: Bearer <CRON_SECRET>`；為了相容舊的 pg_cron 設定，
仍接受 `?secret=` 但會在 log 發出警告（密鑰會留在 access log，建議盡快改掉）。

環境變數由 `api/_lib/env.js` 在啟動時檢查：缺必要變數會 `console.error`，
缺建議變數（`VAPID_*`、`CRON_SECRET`、`APP_URL`）會 `console.warn`；值像 `your-xxx`、`changeme`
這類佔位字串也會被抓出來。

---

## 7. 測試策略

| 測試檔 | 守住的東西 |
| --- | --- |
| `tests/policy.test.js` | 授權 fail-closed；所有既有 admin/teacher/public 動作行為與 v3.5.3 一致 |
| `tests/registry.test.js` | 政策清單與 `api/_actions/*.js` 不會腐化（漏登記、幽靈動作） |
| `tests/util.test.js` | body 上限、`sendJson` 狀態碼、週別工具 |
| `tests/cronAuth.test.js` | 排程密鑰（Bearer/header/舊 query/未設定時一律拒絕） |
| `tests/migrations.test.js` | 遷移命名、編號連續、無破壞性語法、bundle 決定性 |
| `tests/consistency.test.js` | 索引同步、版本號、AI 模型、管理者座號、文件存在 |

```bash
npm test                 # node --test "tests/**/*.test.js"（零外部依賴）
npm run check            # db:verify + check:consistency
```

`npm test` 明確只掃 `tests/**/*.test.js`：`scripts/smoke-test.js` 不在其中，
因為它需要一個正在執行的服務（`node --test` 的預設樣式會把它當成測試檔而失敗）。
`scripts/smoke-test.js` 屬於「對真實站台的手動煙霧測試」，由人決定何時執行。

刻意使用 Node 內建的 `node:test`：這個專案的 dependencies 只有 2 個（`@supabase/supabase-js`、
`web-push`），導入 jest/vitest 會為了測試而讓部署體積與供應鏈風險增加。見 [ADR 0005](ADR/0005-zero-dependency-tests.md)。

---

## 8. 部署

```text
GitHub ──push──▶ Vercel
                  ├── 靜態：dist/public（vite build）＋ rewrite 全部路徑到 /index.html
                  └── 函式：api/**.js（maxDuration 60）
Supabase ◀── service_role（僅伺服器端）
   ▲
   └── pg_cron ──pg_net──▶ POST /api/cron（每小時）
```

`.github/workflows/ci.yml` 只做檢查，**不部署**：`npm ci` → `npm test` →
`npm run db:verify` → `npm run check:consistency` → `npm run build`。

---

## 9. 尚未處理（照風險排序）

| # | 問題 | 影響 | 建議 |
| --- | --- | --- | --- |
| 1 | `schema.sql` 內多支金額函式重複定義（16 份 `create or replace function`） | 難以確知線上實際跑的是哪一版 | 用 `pg_get_functiondef` 從線上 dump 出真實定義，改成單一定義 |
| 2 | `adminResetAllData` 會清資料，但沒有二次確認/稽核 | 誤操作不可回復 | 加 `audit_log` 紀錄 + 需輸入確認字串 |
| 3 | RLS 未啟用（`migration_rls_optional.sql` 是選配） | 若 anon key 外洩則全表可讀 | 確認前端未使用 anon key 後啟用 deny-all RLS |
| 4 | 會員（學生）動作仍是「隱含」而非白名單 | 新動作可能默認對學生開放 | 改成 `MEMBER_ACTIONS` 明確白名單（需先盤點） |
| 5 | 前端 `admin.js` 2,019 行、`app.js` 1,967 行 | 改一處易傷另一處 | 拆成 `features/` 模組 + 同步引擎（見 §10） |
| 6 | 前端輪詢流量大 | 手機耗電、Supabase 用量 | 抽換為 visibility 暫停 + 指數量退 + 條件式抓取 |
| 7 | `api/version.js` 以外無快取策略 | 每次載入都打 API | 版號條件式抓取（ETag / `?v=`） |

---

## 10. 目標架構（下一階段）

### 後端：動作註冊表（Action Registry）

現在 `policy.js` 已是授權的唯一真相，下一步是把「每個動作的完整契約」集中成一份宣告：

```js
defineAction({
  name: 'adminTopUp',
  roles: ['Admin'],                 // 誰可以呼叫
  capabilities: ['wallet:write'],   // 需要什麼能力（角色 → 能力為加法模型）
  scope: 'class',                   // 租戶隔離方式
  schema: { userId: 'string', amount: 'number>0' },  // 參數驗證
  rateLimit: '30/min',
  audit: true,                      // 是否寫 audit_log
  idempotent: true,                 // 是否需要 requestId 冪等
  handler,                          // 實作
});
```

好處：授權、驗證、限流、稽核、冪等全部由路由器統一執行，動作本身只寫業務邏輯；
新增動作時不可能「忘記加授權」。這是本次已鋪好的路（`policy.js` + `registry.test.js`）的自然終點。

### 資料庫：遷移即真相

`schema.sql` 之後應改為「由遷移產生」（`npm run db:generate-schema`），CI 比對是否同步，
如此就不會再出現「文件說有索引、新建的庫卻沒有」這類分叉。

### 前端：功能模組 + 同步引擎

```text
client/src/
├── core/        api.js（單一入口 + requestId + 重試）、store.js（狀態）、time.js
├── ui/          toast、modal、表格、表單驗證
└── features/    orders/ wallet/ menu/ sessions/ calendar/ rfid/ admin/
                 ↑ 每個功能自己一個資料夾（view + actions + 輪詢策略）
```

同步引擎統一處理：頁面隱藏時暫停輪詢、指數量退、`getBootstrapVersion` 條件式抓取（沒變就不傳資料）。

---

## 11. 請不要動的清單

以下設計是對的，重構時應保留：

1. 金額正確性放在資料庫 RPC（`security definer` + `for update`）。
2. Session token 只存 `sha256(token)`，不存明文；6 小時到期。
3. `auth_version`：改密碼 / 停用時一次讓所有 token 失效。
4. 單一入口 `POST /api/gas` + `config.api.bodyParser = false`（避免 preflight 與 body 解析衝突）。
5. 所有查詢都帶 `class_id`（多班級租戶隔離靠這一條）。
6. RFID 掃卡 fire-and-forget + `rfid_pending` 補送。
7. AI 金鑰只放 `app_settings`（DB）或環境變數，永不回傳給前端。
