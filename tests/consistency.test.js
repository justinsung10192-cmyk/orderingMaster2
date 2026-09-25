// 一致性檢查的測試。這些檢查之所以存在，是因為每一條都對應一個「真的發生過」的錯誤。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  indexParityGaps,
  migrationIndexes,
  migrationIndexNames,
  runChecks,
  schemaIndexNames,
  schemaTableNames,
} from '../scripts/check-consistency.mjs';
import { stripLineComments } from '../scripts/lib/migrations.mjs';

test('一致性檢查全部通過', () => {
  const failed = runChecks().filter((result) => !result.ok);
  assert.deepEqual(
    failed.map((result) => `${result.id}: ${result.detail}`),
    [],
    '一致性檢查失敗時，CI 會擋下這個分支',
  );
});

test('遷移檔中「既有資料表」的索引都已寫進 schema.sql（新安裝不會漏效能索引）', () => {
  const all = migrationIndexes();
  assert.ok(all.length > 0, '至少應從遷移檔抽到一個索引');
  assert.deepEqual(
    indexParityGaps().map((index) => index.name),
    [],
    '這些索引只在遷移檔裡，schema.sql 沒有 → 照 schema.sql 新建的資料庫會漏索引',
  );
  // 這些就是曾經漏掉的那批（原本只在 migration_perf_indexes.sql）
  const names = migrationIndexNames();
  for (const name of ['idx_users_student_no', 'idx_users_seat_no', 'idx_orders_class_updated']) {
    assert.ok(names.has(name), `遷移檔應包含 ${name}`);
    assert.ok(schemaIndexNames().has(name), `schema.sql 應包含 ${name}`);
  }
});

test('部分索引與新表索引不列入 schema.sql 比對（避免假警報）', () => {
  const all = migrationIndexes();
  const partial = all.filter((index) => index.partial).map((index) => index.name);
  assert.ok(partial.includes('uq_transactions_class_request'), 'request_id 冪等鍵應是部分索引');
  const newTables = all.filter((index) => !schemaTableNames().has(index.table)).map((index) => index.table);
  assert.ok(newTables.includes('audit_log'), 'audit_log 只由遷移建立，不應列入比對');
});

test('schema.sql 仍保有原有的索引（沒有被這次改動移除）', () => {
  const names = schemaIndexNames();
  const originals = [
    'idx_users_class',
    'idx_orders_session',
    'idx_transactions_class',
    'idx_auth_tokens_hash',
    'idx_calendar_class_date',
    'idx_changelog',
  ];
  for (const name of originals) {
    assert.ok(names.has(name), `原有索引 ${name} 不應該消失`);
  }
  assert.ok(names.size >= 30, `索引總數應 ≥ 30，實際 ${names.size}`);
});

test('schema.sql 沒有「未註解」的破壞性語法（開頭的重建清單是註解，屬正常）', () => {
  const raw = readFileSync('supabase/schema.sql', 'utf8');
  assert.ok(/drop\s+table/i.test(raw), '（前提）原文的註解區塊確實提到 drop table');
  const code = stripLineComments(raw);
  for (const keyword of ['drop table', 'truncate', 'drop column']) {
    const pattern = new RegExp(`\\b${keyword.replace(' ', '\\s+')}\\b`, 'i');
    assert.ok(!pattern.test(code), `未註解的 ${keyword} 不應存在於 schema.sql`);
  }
});
