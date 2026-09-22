// ============================================================================
// 訂餐通 — 完整資料庫備份腳本（唯讀）
// ----------------------------------------------------------------------------
// 用途：把 Supabase 全部資料表完整匯出為 JSON 檔（不刪除、不修改任何資料）。
// 執行方式（在專案根目錄）：
//   set SUPABASE_URL=https://xxxx.supabase.co
//   set SUPABASE_SERVICE_ROLE_KEY=eyJ...
//   node scripts/backup.js
//   （或先建立 .env 檔，本腳本會自動讀取 .env）
//
// 輸出：backups/backup-YYYYMMDD-HHmmss.json
// 內容：{ exportedAt, tables: { 資料表名: [row, ...] } }
// 注意：備份檔包含「密碼雜湊 / salt / Token 雜湊」等敏感資料，請妥善保管。
// ============================================================================
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

// ---- 簡易 .env 載入（不依賴第三方套件）----
function loadEnv() {
  const envFile = new URL('../.env', import.meta.url);
  try {
    const text = readFileSync(envFile, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
  } catch {
    // 無 .env 就靠 process.env
  }
}

// ---- 全部資料表（與 supabase/schema.sql 一致）----
const TABLES = [
  'classes',
  'users',
  'stores',
  'menu_items',
  'recurring_menu',
  'sessions',
  'holidays',
  'duty_assignments',
  'orders',
  'transactions',
  'verification_records',
  'votes',
  'auth_tokens',
  'push_subscriptions',
  'app_settings',
  'calendar_events',
  'calendar_event_logs',
  'custom_debts',
  'leave_requests',
  'menu_recommendations',
  'changelog',
];

// 分頁讀取整表（突破 PostgREST 預設 1000 列上限，確保「完整」）
async function dumpTable(supabase, table) {
  const rows = [];
  const pageSize = 1000;
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from(table)
      .select('*')
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    const chunk = data || [];
    rows.push(...chunk);
    if (chunk.length < pageSize) break;
    from += pageSize;
  }
  return rows;
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function main() {
  loadEnv();
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('[備份失敗] 缺少環境變數：請設定 SUPABASE_URL 與 SUPABASE_SERVICE_ROLE_KEY。');
    console.error('可在 Supabase Dashboard → Project Settings → API 找到這兩個值。');
    process.exit(1);
  }

  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const tables = {};
  const summary = {};
  let totalRows = 0;
  for (const table of TABLES) {
    try {
      const rows = await dumpTable(supabase, table);
      tables[table] = rows;
      summary[table] = rows.length;
      totalRows += rows.length;
      console.log(`  ${table.padEnd(22)} ${String(rows.length).padStart(6)} 列`);
    } catch (err) {
      console.error(`  ${table}: 讀取失敗 — ${err.message}`);
    }
  }

  const payload = {
    exportedAt: new Date().toISOString(),
    generatedBy: 'scripts/backup.js（訂餐通唯讀備份）',
    tableCount: Object.keys(tables).length,
    totalRows,
    summary,
    tables,
  };

  const dir = new URL('../backups/', import.meta.url);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const filePath = new URL(`backup-${timestamp()}.json`, dir);
  writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');

  console.log(`\n✅ 備份完成：${filePath.pathname}`);
  console.log(`   共 ${Object.keys(tables).length} 張表、${totalRows} 列資料。`);
  console.log('⚠️  備份檔含敏感資料（密碼雜湊、Token 雜湊），請妥善保存、勿上傳公開儲存庫。');
}

main().catch((err) => {
  console.error('[備份失敗]', err.message);
  process.exit(1);
});
