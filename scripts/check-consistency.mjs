#!/usr/bin/env node
// 一致性檢查（零依賴）：抓出「文件/設定/資料庫 schema 互相說法不一致」的漂移。
//
// 這些檢查對應的都是過去真的發生過的錯誤，例如：
//   * SETUP_GUIDE 說用座號 01 當管理者，但 schema.sql 其實把 05 升成 Admin
//   * README 說用 Gemini 1.5 Flash，但程式碼跑的是 gemini-3.x-flash 模型鏈
//   * migration_perf_indexes.sql 有 8 個索引，schema.sql 卻沒有 → 新安裝特別慢
//
// 任何一項失敗都會以非零狀態碼結束，讓 CI 擋下來。
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { inspectMigrations, stripLineComments } from './lib/migrations.mjs';

export const ROOT = process.cwd();

const read = (relative) => readFileSync(join(ROOT, relative), 'utf8');
const readJson = (relative) => JSON.parse(read(relative));
const exists = (relative) => existsSync(join(ROOT, relative));

/** schema.sql 內宣告的資料表名稱。 */
export function schemaTableNames() {
  const names = new Set();
  for (const match of stripLineComments(read('supabase/schema.sql')).matchAll(
    /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?([a-z0-9_]+)/gi,
  )) {
    names.add(match[1]);
  }
  return names;
}

/** schema.sql 內建立的所有索引名稱。 */
export function schemaIndexNames() {
  const names = new Set();
  for (const match of stripLineComments(read('supabase/schema.sql')).matchAll(
    /create\s+(?:unique\s+)?index\s+(?:if\s+not\s+exists\s+)?([a-z0-9_]+)/gi,
  )) {
    names.add(match[1]);
  }
  return names;
}

/**
 * 從 supabase/migrations/*.sql 抽出所有索引，回傳 [{ name, table, partial, file }]。
 * partial = 帶 where 條件的部分索引（例如只約束非 null 的冪等鍵）。
 */
export function migrationIndexes(dir = 'supabase/migrations') {
  const found = [];
  if (!existsSync(join(ROOT, dir))) return found;
  for (const file of readdirSync(join(ROOT, dir)).filter((name) => name.endsWith('.sql') && !name.startsWith('_'))) {
    const code = stripLineComments(read(join(dir, file)));
    for (const match of code.matchAll(
      /create\s+(?:unique\s+)?index\s+if\s+not\s+exists\s+([a-z0-9_]+)\s+on\s+(?:public\.)?([a-z0-9_]+)([^;]*);/gi,
    )) {
      found.push({
        name: match[1],
        table: match[2],
        partial: /\bwhere\b/i.test(match[3]),
        file,
      });
    }
  }
  return found;
}

/** 為了相容與測試方便：所有索引名稱。 */
export const migrationIndexNames = (dir) => new Set(migrationIndexes(dir).map((index) => index.name));

/**
 * 哪些索引「應該」出現在 schema.sql 卻沒有？
 * 規則：只要求「目標資料表本身由 schema.sql 建立」且「不是部分索引」的索引。
 * 理由：新表（schema_migrations / audit_log）與 partsal index（request_id）本來就
 * 只存在於遷移中；把它們算成缺漏會產生假警報，反而讓檢查被忽略。
 */
export function indexParityGaps(dir = 'supabase/migrations') {
  const tables = schemaTableNames();
  const present = schemaIndexNames();
  return migrationIndexes(dir)
    .filter((index) => !index.partial && tables.has(index.table))
    .filter((index) => !present.has(index.name));
}

function checkIndexParity() {
  const all = migrationIndexes();
  const scoped = all.filter((index) => !index.partial && schemaTableNames().has(index.table));
  const missing = indexParityGaps();
  return {
    id: 'db-index-parity',
    title: '版本化遷移中「既有資料表」的索引都存在於 schema.sql（新安裝不漏索引）',
    ok: all.length > 0 && missing.length === 0,
    detail: missing.length
      ? `schema.sql 缺少：${missing.map((index) => index.name).join(', ')}`
      : `比對 ${scoped.length} 個索引（另有 ${all.length - scoped.length} 個屬新表/部分索引，不列入）`,
  };
}

function checkAppVersion() {
  const version = readJson('package.json').version;
  const source = read('client/src/app.js');
  const match = /const APP_VERSION\s*=[^\n]*?'([0-9]+\.[0-9]+\.[0-9]+)'/.exec(source);
  if (!match) {
    return { id: 'app-version', title: 'app.js 版本號 fallback 與 package.json 一致', ok: false, detail: '找不到 APP_VERSION fallback' };
  }
  return {
    id: 'app-version',
    title: 'app.js 版本號 fallback 與 package.json 一致',
    ok: match[1] === version,
    detail: `app.js=${match[1]} package.json=${version}`,
  };
}

function checkAiModels() {
  const readme = read('README.md');
  const aiSource = read('api/_actions/ai.js');
  const chainMatch = /GEMINI_MODEL_CHAIN\s*=\s*\[([^\]]*)\]/.exec(aiSource);
  const chain = chainMatch ? [...chainMatch[1].matchAll(/'([^']+)'/g)].map((match) => match[1]) : [];
  const mentioned = [...readme.matchAll(/\bgemini-[0-9][0-9a-z.\-]*/gi)].map((match) => match[0].toLowerCase());
  const unknown = [...new Set(mentioned)].filter((model) => !chain.includes(model));
  const staleLegacy = /Gemini\s+1\.5/i.test(readme);
  const ok = chain.length > 0 && unknown.length === 0 && !staleLegacy;
  return {
    id: 'ai-model-docs',
    title: 'README 提到的 Gemini 模型與程式碼模型鏈一致',
    ok,
    detail: ok
      ? `模型鏈 ${chain.join(' > ')}`
      : [unknown.length ? `README 提到不存在的模型：${unknown.join(', ')}` : '', staleLegacy ? 'README 仍寫 Gemini 1.5' : '']
          .filter(Boolean)
          .join('；'),
  };
}

function checkAdminSeat() {
  const schema = read('supabase/schema.sql');
  const promoted = /update\s+(?:public\.)?users\s+set\s+role\s*=\s*'Admin'[^;]*?student_no\s*=\s*'(\d+)'/i.exec(schema);
  const demoted = /update\s+(?:public\.)?users\s+set\s+role\s*=\s*'Student'[^;]*?student_no\s*=\s*'(\d+)'/i.exec(schema);
  const guide = read('SETUP_GUIDE.md');
  const documented = /座號\s*`(\d+)`\s*登入[^\n]*管理者/.exec(guide);
  const ok = Boolean(promoted && documented && promoted[1] === documented[1]);
  return {
    id: 'admin-seat',
    title: 'SETUP_GUIDE 的管理者座號與 schema.sql 一致',
    ok,
    detail: ok
      ? `schema.sql 升 ${promoted[1]} 為 Admin、降 ${demoted?.[1] ?? '?'} 為 Student；文件寫 ${documented[1]}`
      : `schema.sql 升 ${promoted?.[1] ?? '?'}、文件寫 ${documented?.[1] ?? '未標示'}`,
  };
}

function checkNoGasLegacy() {
  const source = read('vite.config.ts');
  const ok = !/Google Apps Script/i.test(source);
  return {
    id: 'no-gas-legacy',
    title: 'vite.config.ts 不再宣稱後端是 Google Apps Script',
    ok,
    detail: ok ? '無殘留敘述' : '仍寫「後端資料由 Google Apps Script 提供」',
  };
}

function checkMigrationRules() {
  const { ok, migrations, problems } = inspectMigrations('supabase/migrations');
  return {
    id: 'migration-rules',
    title: '遷移檔命名/編號/無破壞性語法',
    ok,
    detail: ok ? `${migrations.length} 個遷移通過` : problems.join('；'),
  };
}

function checkMigrationBundle() {
  const { problems } = inspectMigrations('supabase/migrations');
  return {
    id: 'migration-bundle',
    title: '產生檔 _generated_bundle.sql 與遷移同步（由 npm run db:verify 完整檢查）',
    ok: problems.length === 0,
    detail: problems.length ? problems.join('；') : '遷移規則通過（bundle 同步由 db:verify 檢查）',
  };
}

function checkArchitectureDoc() {
  const required = ['docs/ARCHITECTURE.md', 'docs/ADR/0001-single-api-entrypoint.md'];
  const missing = required.filter((file) => !exists(file));
  return {
    id: 'architecture-doc',
    title: '架構文件存在',
    ok: missing.length === 0,
    detail: missing.length ? `缺少 ${missing.join(', ')}` : `${required.length} 份文件存在`,
  };
}

function checkNoDestructiveInSchema() {
  const code = stripLineComments(read('supabase/schema.sql'));
  const hits = ['drop table', 'truncate', 'drop column'].filter((keyword) =>
    new RegExp(`\\b${keyword.replace(' ', '\\s+')}\\b`, 'i').test(code),
  );
  return {
    id: 'schema-not-destructive',
    title: 'schema.sql 沒有未註解的破壞性語法（註解區塊不算）',
    ok: hits.length === 0,
    detail: hits.length ? `出現 ${hits.join(', ')}` : '只有註解區塊提到（安全）',
  };
}

export function runChecks() {
  return [
    checkMigrationRules(),
    checkMigrationBundle(),
    checkIndexParity(),
    checkAppVersion(),
    checkAiModels(),
    checkAdminSeat(),
    checkNoGasLegacy(),
    checkNoDestructiveInSchema(),
    checkArchitectureDoc(),
  ];
}

function main() {
  const results = runChecks();
  console.log('一致性檢查（scripts/check-consistency.mjs）\n');
  for (const result of results) {
    console.log(`  ${result.ok ? '✓' : '✗'} ${result.title}`);
    if (result.detail) console.log(`      ${result.detail}`);
  }
  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通過`);
  process.exit(failed.length === 0 ? 0 : 1);
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('scripts/check-consistency.mjs')) {
  main();
}
