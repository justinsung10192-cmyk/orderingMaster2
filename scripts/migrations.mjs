#!/usr/bin/env node
// 資料庫遷移 CLI（零依賴）。
//
//   node scripts/migrations.mjs list            列出遷移與 checksum
//   node scripts/migrations.mjs verify [--bundle] 檢查檔名/編號/破壞性語法（可含 bundle 同步）
//   node scripts/migrations.mjs bundle          產生 supabase/migrations/_generated_bundle.sql
//   node scripts/migrations.mjs bundle --check  只檢查產生檔是否為最新（CI 用）
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BUNDLE_FILENAME,
  MIGRATIONS_DIR,
  buildBundle,
  inspectMigrations,
  summarizeMigrations,
  verifyBundle,
} from './lib/migrations.mjs';

const [, , command = 'list', ...flags] = process.argv;
const withBundle = flags.includes('--bundle') || command === 'verify-bundle';
const checkOnly = flags.includes('--check');

function printProblems(problems, prefix = '  ✗ ') {
  for (const problem of problems) console.log(prefix + problem);
}

function cmdList() {
  const { migrations, problems, warnings } = inspectMigrations(MIGRATIONS_DIR);
  if (migrations.length === 0) {
    console.log('（沒有任何遷移檔）');
  } else {
    console.log(`遷移清單（${migrations.length} 個）：`);
    for (const migration of migrations) {
      console.log(
        `  ${migration.version} ${migration.name.padEnd(34)} ${String(migration.bytes).padStart(6)} B  ${migration.checksum.slice(0, 12)}`,
      );
    }
  }
  printProblems(warnings, '  ! ');
  printProblems(problems);
  return problems.length === 0 ? 0 : 1;
}

function cmdVerify() {
  const { ok, migrations, problems, warnings } = inspectMigrations(MIGRATIONS_DIR);
  console.log(`遷移檢查：${migrations.length} 個檔案`);
  printProblems(warnings, '  ! ');
  printProblems(problems);

  let bundleOk = true;
  if (withBundle) {
    const bundle = verifyBundle(MIGRATIONS_DIR);
    bundleOk = bundle.ok;
    if (!bundle.ok) printProblems(bundle.problems);
    else console.log(`  ✓ ${bundle.path} 與遷移檔同步`);
  }

  if (ok && bundleOk) {
    console.log('  ✓ 命名/編號/內容規則全部通過');
    return 0;
  }
  return 1;
}

function cmdBundle() {
  if (checkOnly) {
    const { ok, path, problems } = verifyBundle(MIGRATIONS_DIR);
    printProblems(problems);
    if (ok) console.log(`  ✓ ${path} 已是最新`);
    return ok ? 0 : 1;
  }
  const sql = buildBundle(MIGRATIONS_DIR);
  const target = join(MIGRATIONS_DIR, BUNDLE_FILENAME);
  writeFileSync(target, sql, 'utf8');
  const summary = summarizeMigrations(MIGRATIONS_DIR);
  console.log(`已產生 ${target}（${summary.length} 個遷移、${Buffer.byteLength(sql, 'utf8')} bytes）`);
  console.log('用法：整段貼進 Supabase「SQL Editor」執行即可（可重複執行）。');
  return 0;
}

const COMMANDS = {
  list: cmdList,
  verify: cmdVerify,
  bundle: cmdBundle,
};

const handler = COMMANDS[command];
if (!handler) {
  console.log(`未知指令：${command}\n可用指令：${Object.keys(COMMANDS).join(' / ')}`);
  process.exit(2);
}
process.exit(handler());
