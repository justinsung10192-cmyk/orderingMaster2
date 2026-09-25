# v4 強化分支說明（branch: feat/v4-hardening）

本分支只做「結構性強化」，**不改變任何既有功能行為**；所有變更皆為新增檔案或向後相容的修改。

## 1. 這次修掉的真實風險

### 1.1 授權預設放行（fail-open）— 已修正
舊版 api/gas.js 的判斷是：

    if (ADMIN.has(action) && ctx.user.role !== 'Admin') throw FORBIDDEN;

ADMIN 是手動維護的字串清單。只要有人新增 adminXxx 動作卻忘記登記，
該端點就會直接對「任何已登入的學生」開放。

v4 改為 api/_lib/policy.js 的 fail-closed 政策：admin* / ai* 前綴一律僅限 Admin，
新增端點**不必登記就自動上鎖**。已加入回歸測試（tests/policy.test.js）。

### 1.2 排程密鑰寫在 query string — 已修正
舊版 /api/cron?secret=CRON_SECRET 會讓密鑰落入 Vercel access log 與瀏覽器歷史。
v4 支援 Authorization: Bearer 與 x-cron-secret，並保留 ?secret= 相容既有 pg_cron job
（偵測到舊格式時輸出升級提醒）。未設定 CRON_SECRET 時一律拒絕。

### 1.3 請求大小未分級 — 已修正
舊版所有動作共用 12MB 上限，任何公開端點都能送 12MB。
v4 依動作分級：僅 AI 辨識／菜單匯入／備份還原為 12MB，其餘收斂到 256KB，
並在讀取 body 前先用 Content-Length 阻擋超大請求。

### 1.4 線上問題無法追蹤 — 已修正
每個請求帶入 requestId，錯誤回應加上 code，並輸出結構化 log：

    {"at":"api/gas","requestId":"...","action":"adminTopUp","ok":false,"code":"INSUFFICIENT_BALANCE","ms":83}

回應格式為向後相容的加法：{ ok, error, code, requestId }。

### 1.5 環境變數設定錯誤只有上線才會發現 — 已修正
api/_lib/env.js 在啟動時檢查必要與建議變數，並偵測仍是範例值的密鑰。
設計上只警告不中斷，避免單一變數缺失讓整個站台不可用。

## 2. 新增檔案

| 檔案 | 用途 |
| --- | --- |
| api/_lib/policy.js | 全站唯一授權真相來源（fail-closed、前綴保護、政策報表） |
| api/_lib/env.js | 環境變數自檢 |
| api/_lib/cronAuth.js | 排程密鑰驗證（Bearer / x-cron-secret / 相容 query） |
| tests/policy.test.js | 授權政策與 fail-closed 回歸測試 |
| tests/registry.test.js | 動作清單防護：新增特權動作會被強制審查 |
| tests/util.test.js | body 上限、週別工具 |
| tests/cronAuth.test.js | 排程密鑰驗證 |

## 3. 修改檔案

| 檔案 | 變更 |
| --- | --- |
| api/gas.js | 改為薄路由：政策呼叫、requestId、錯誤碼、body 分級、結構化 log |
| api/_lib/util.js | readRawBody 支援自訂上限；sendJson 支援狀態碼（皆有預設值，向後相容） |
| api/cron.js | 改用 verifyCronSecret（Bearer 優先，保留舊格式） |
| package.json | 新增 npm test（node --test，零外部依賴） |

## 4. 測試

本分支的測試刻意使用 Node 內建的 node:test，**不新增任何 npm 依賴**。

    npm test        # 或  node --test

測試涵蓋：

- 新增 admin* / ai* 動作不會外洩給學生或教師（fail-closed 回歸測試）
- 74 個既有管理員動作、13 個教師動作、4 個公開動作的權限與 v3.5.3 完全一致
- 授權清單與原始碼同步（清單腐化、漏登都會讓測試失敗）
- body 大小上限、週別日期一致性、排程密鑰驗證

## 5. 尚未處理（建議下一階段）

1. **schema.sql 沒有任何索引**：9 個效能索引只存在於 migration_perf_indexes.sql，
   依 SETUP_GUIDE 新建的環境會沒有索引而效能低落。建議把索引併入 schema.sql。
2. **19 個 migration 沒有編號、沒有 schema_migrations 表**：無法得知各環境套用到哪一版。
3. **金額 RPC 缺少冪等鍵**：網路重試可能重複扣款，建議加入 p_request_id + audit_log。
4. **RLS 未啟用**：目前僅靠 service_role 作為唯一出入口，缺少縱深防禦。
5. **明確的會員動作白名單**：目前非 admin/ai 的動作預設為「已登入即可用」，
   建議下一階段改為明確列舉，讓所有新動作都必須被分類。
6. **文件不一致**：SETUP_GUIDE 說用座號 01 當管理員，但 schema.sql 是把 05 設為 Admin、
   01 降為 Student；README 說 AI 使用 Gemini 1.5 Flash，實際程式碼是 gemini-3.x 系列。
