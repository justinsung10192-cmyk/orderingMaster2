// 遷移系統的單元測試（node:test，零依賴）。
// 這裡測的是「規則」，不是「某個檔案的內容」——規則有測試，才不會隨著時間腐化。
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  BUNDLE_FILENAME,
  buildBundle,
  inspectMigrations,
  listMigrationFiles,
  sha256Hex,
  verifyBundle,
} from '../scripts/lib/migrations.mjs';

const REAL_DIR = 'supabase/migrations';

function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), 'migrations-'));
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), body, 'utf8');
  }
  return dir;
}

test('真實遷移資料夾通過所有規則', () => {
  const { ok, migrations, problems, warnings } = inspectMigrations(REAL_DIR);
  assert.equal(ok, true, problems.join('; '));
  assert.deepEqual(warnings, [], '遷移檔必須可以重複執行');
  assert.ok(migrations.length >= 4, `至少應有 4 個遷移，實際 ${migrations.length}`);
});

test('編號從 0001 起連續且不重複', () => {
  const { migrations } = inspectMigrations(REAL_DIR);
  const versions = migrations.map((migration) => migration.version);
  assert.deepEqual(versions, [...versions].sort(), '必須依編號排序');
  versions.forEach((version, index) => {
    assert.equal(version, String(index + 1).padStart(4, '0'));
  });
});

test('每個遷移都有 checksum，且 checksum 對應檔案內容', () => {
  const files = listMigrationFiles(REAL_DIR);
  const { migrations } = inspectMigrations(REAL_DIR);
  for (const migration of migrations) {
    assert.ok(files.includes(migration.file));
    const onDisk = readFileSync(join(REAL_DIR, migration.file), 'utf8').replace(/\r\n/g, '\n');
    assert.equal(migration.checksum, sha256Hex(onDisk));
    assert.match(migration.checksum, /^[0-9a-f]{64}$/);
  }
});

test('破壞性語法會被擋下（遷移只能往前加）', () => {
  const cases = [
    'drop table public.orders;',
    'truncate public.transactions;',
    'drop column request_id;',
    'delete from public.orders;',
  ];
  for (const body of cases) {
    const { ok, problems } = inspectMigrations(fixture({ '0001_bad.sql': body }));
    assert.equal(ok, false, `應擋下：${body}`);
    assert.ok(
      problems.some((problem) => problem.includes('破壞性語法')),
      `問題描述應指出破壞性語法，實際：${problems.join('; ')}`,
    );
  }
});

test('檔名不符 NNNN_lower_snake_case.sql 會被擋下', () => {
  const { ok, problems } = inspectMigrations(fixture({ '1_bad.sql': 'select 1;' }));
  assert.equal(ok, false);
  assert.ok(problems.some((problem) => problem.includes('檔名不符規則')));
});

test('編號重複會被擋下', () => {
  const { ok, problems } = inspectMigrations(
    fixture({ '0001_a.sql': 'select 1;', '0001_b.sql': 'select 1;' }),
  );
  assert.equal(ok, false);
  assert.ok(problems.some((problem) => problem.includes('編號重複')), problems.join('; '));
});

test('編號跳號會被擋下', () => {
  const { ok, problems } = inspectMigrations(
    fixture({ '0001_a.sql': 'select 1;', '0003_c.sql': 'select 1;' }),
  );
  assert.equal(ok, false);
  assert.ok(problems.some((problem) => problem.includes('編號不連續')), problems.join('; '));
});

test('空的遷移檔會被擋下', () => {
  const { ok, problems } = inspectMigrations(fixture({ '0001_empty.sql': '   \n\n' }));
  assert.equal(ok, false);
  assert.ok(problems.some((problem) => problem.includes('空的')));
});

test('buildBundle 是決定性的，且包含每個遷移與其 checksum', () => {
  const dir = fixture({
    '0001_a.sql': 'create table if not exists public.t (id int);\n',
    '0002_b.sql': 'create index if not exists idx_t on public.t (id);\n',
  });
  const first = buildBundle(dir);
  const second = buildBundle(dir);
  assert.equal(first, second, '同樣輸入必須產生同樣位元組（CI 才能用檔案比對抓漂移）');

  const { migrations } = inspectMigrations(dir);
  for (const migration of migrations) {
    assert.ok(first.includes(migration.file), `bundle 應包含 ${migration.file}`);
    assert.ok(first.includes(migration.checksum), `bundle 應記錄 ${migration.file} 的 checksum`);
    assert.ok(
      first.includes(`'${migration.version}', '${migration.name}'`),
      'bundle 應寫入 schema_migrations 紀錄',
    );
  }
  assert.ok(first.includes('begin;') && first.includes('commit;'), '每個遷移應包在交易中');
});

test('bundle 有問題的遷移時會拒絕產生（不會默默產出半套）', () => {
  const dir = fixture({ '0001_bad.sql': 'drop table public.orders;' });
  assert.throws(() => buildBundle(dir), /無法產生 bundle/);
});

test('verifyBundle：缺少、過期、同步三種狀態都能判別', () => {
  const dir = fixture({
    '0001_a.sql': 'create table if not exists public.t (id int);\n',
    '0002_b.sql': 'create index if not exists idx_t on public.t (id);\n',
  });

  assert.equal(verifyBundle(dir).ok, false, '沒有產生檔時應失敗');

  writeFileSync(join(dir, BUNDLE_FILENAME), buildBundle(dir), 'utf8');
  const synced = verifyBundle(dir);
  assert.equal(synced.ok, true, synced.problems.join('; '));

  writeFileSync(join(dir, '0002_b.sql'), 'create index if not exists idx_t2 on public.t (id);\n', 'utf8');
  const drifted = verifyBundle(dir);
  assert.equal(drifted.ok, false, '遷移改過但沒重跑產生時應失敗');
  assert.ok(drifted.problems.some((problem) => problem.includes('不同步')));
});
