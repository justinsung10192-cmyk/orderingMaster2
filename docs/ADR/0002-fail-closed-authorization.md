# ADR 0002：授權採 fail-closed，`admin*` / `ai*` 前綴一律視為特權

- 狀態：已採用（v4 分支）
- 日期：2026-09-25

## 背景

舊版 `api/gas.js` 的授權邏輯是：

```js
const ADMIN = new Set(['adminSaveSession', 'adminTopUp', /* …72 個字串… */]);
if (ADMIN.has(action) && ctx.user.role !== 'Admin') throw appError('FORBIDDEN', …);
```

這是 **fail-open**：只要某個特權動作**沒有被列進清單**，任何已登入的學生都能呼叫它。
新增功能時最常見的失誤就是「忘記把動作加進清單」，而失誤的後果是權限外洩，不是功能壞掉。

## 決策

1. `api/_lib/policy.js` 成為授權的唯一真相（single source of truth）。
2. 加入**前綴規則**：動作名稱以 `admin` 或 `ai` 開頭、且下一個字元是大寫字母者，
   **一律視為 Admin-only**，不需要登記。
   - `adminDeleteEverything` → Admin-only（即使沒登記）
   - `calendarAiRecognize` → 不是（`ai` 沒有出現在開頭）
   - `administrator` → 不是（下一個字元不是大寫）
3. 保留 `ADMIN_ACTIONS` 明確清單，用途改為「審查與文件」，並由 `tests/registry.test.js`
   檢查清單沒有腐化（幽靈動作、漏登記）。
4. 三層模型：Public（免登入）→ Teacher（白名單）→ Admin（清單＋前綴）；
   其餘已登入者為 Member（學生）。

## 理由

- 失誤方向改變：忘記登記的代價從「權限外洩」變成「管理員不能用（立刻被發現）」。
- 命名慣例成為安全機制，新動作只要照慣例命名就自動受保護。
- 顯式清單仍在，讓「誰能做什麼」可被 review 與 diff。

## 測試

`tests/policy.test.js` 固化以下行為：

- 未登記的 `adminXxx` / `aiXxx` → 學生與教師 `FORBIDDEN`、管理員可通過。
- 74 個既有 admin 動作、13 個教師動作、4 個公開動作的行為與 v3.5.3 **完全一致**（向後相容）。
- 未登入呼叫非公開動作 → `UNAUTHORIZED`。

## 已知限制（後續）

學生（Member）動作目前是「非 Public、非 Teacher、非 Admin 的所有動作」，也就是**隱含放行**。
方向是改為 `MEMBER_ACTIONS` 明確白名單，但需要先盤點前端實際使用的動作，避免上線即壞。
