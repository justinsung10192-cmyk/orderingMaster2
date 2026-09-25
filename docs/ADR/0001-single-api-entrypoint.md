# ADR 0001：所有前端請求走單一入口 `POST /api/gas`

- 狀態：已採用（現行架構，v4 分支強化）
- 日期：2026-09-25

## 背景

前端需要存取數十種後端操作（登入、訂單、錢包、菜單、排程、AI 辨識、RFID 等）。
常見做法是為每個資源開一條 REST 路徑（`POST /orders`、`POST /wallet/topup` …）。

## 決策

維持單一入口 `POST /api/gas`，body 為 `{ action, data, token }`，並使用
`Content-Type: text/plain` 傳送 JSON 字串，且 `export const config = { api: { bodyParser: false } }`。

## 理由

1. **橫切關注點只需做對一次**：授權、body 大小上限、錯誤格式、請求追蹤（`requestId`）、
   結構化 log，全部集中在一個檔案。
2. **避開瀏覽器 preflight**：`text/plain` 不會觸發 CORS OPTIONS，行動網路下少一趟往返。
3. **前端只有一個呼叫慣例**，離線/重試/錯誤處理可以寫一次。
4. 新增功能＝新增一個 `api/_actions/*.js` 動作，路由零改動。

## 代價與緩解

| 代價 | 緩解 |
| --- | --- |
| 無法用 HTTP 快取語意（GET/ETag） | 版號條件式抓取（`api/version.js`、`getBootstrap`） |
| 授權清單必須完整且正確 | fail-closed 政策（ADR 0002）＋ `registry.test.js` 防清單腐化 |
| 一個大 body 可能被塞爆 | body 上限分級（預設 256KB、AI/備份 12MB） |
| 路由是動態查表，非編譯期檢查 | 啟動時檢查 `HANDLERS[action]` 存在，未知動作回 `UNKNOWN_ACTION` |

## 後續

導入 Action Registry（見 `docs/ARCHITECTURE.md` §10）後，`gas.js` 會縮到約 45 行，
每個動作改為宣告式（角色、能力、驗證、限流、稽核、冪等）。
