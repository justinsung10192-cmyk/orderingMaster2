// 資料庫遷移的核心邏輯（零依賴，只使用 node: 內建模組）。
// 這個檔案被 scripts/migrations.mjs（CLI）與 tests/migrations.test.js 共用，
// 目的是讓「遷移檔案的規則」是可以被測試的程式碼，而不是只寫在文件裡的約定。
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const MIGRATIONS_DIR = 'supabase/migrations';
export const BUNDLE_FILENAME = '_generated_bundle.sql';

/** 檔名規則：0001_lower_snake_case.sql */
export const FILENAME_PATTERN = /^(\d{4})_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/;

/** 產生檔不列入搬移清單。 */
const IGNORED_FILES = new Set([BUNDLE_FILENAME]);

/** 破壞性語法黑名單：遷移檔只能往前加，不可以偷偷砍資料。 */
const DESTRUCTIVE_PATTERNS = [
  { pattern: /\bdrop\s+table\b/i, label: 'drop table' },
  { pattern: /\bdrop\s+column\b/i, label: 'drop column' },
  { pattern: /\bdrop\s+schema\b/i, label: 'drop schema' },
  { pattern: /\btruncate\b/i, label: 'truncate' },
  { pattern: /^\s*delete\s+from\s+[a-z_."]+\s*;/im, label: 'delete from（無 where）' },
];

export const normalizeNewlines = (text) => String(text).replace(/\r\n/g, '\n');

export const sha256Hex = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * 去掉 `--` 行註解（字串常值內的 `--` 不會被誤刪）。
 * 為什麼需要：schema.sql 開頭就有一段被註解掉的 `-- drop table ...` 重建清單，
 * 直接對原文做關鍵字掃描會把「註解」誤判成「程式碼」。
 */
export function stripLineComments(source) {
  let out = '';
  let inString = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === "'") {
      inString = !inString;
      out += char;
      continue;
    }
    if (!inString && char === '-' && source[index + 1] === '-') {
      while (index < source.length && source[index] !== '\n') index += 1;
      out += '\n';
      continue;
    }
    out += char;
  }
  return out;
}

/** 列出資料夾內所有遷移檔（已排序、排除產生檔）。 */
export function listMigrationFiles(dir = MIGRATIONS_DIR) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith('.sql') && !IGNORED_FILES.has(file))
    .sort();
}

/**
 * 檢查遷移資料夾，回傳 { ok, migrations, problems, warnings }。
 * migrations 每筆包含 { version, name, file, checksum, bytes, source }。
 */
export function inspectMigrations(dir = MIGRATIONS_DIR) {
  const problems = [];
  const warnings = [];
  const migrations = [];

  if (!existsSync(dir)) {
    problems.push(`找不到遷移資料夾：${dir}`);
    return { ok: false, migrations, problems, warnings };
  }

  for (const file of listMigrationFiles(dir)) {
    const fullPath = join(dir, file);
    const source = normalizeNewlines(readFileSync(fullPath, 'utf8'));
    const code = stripLineComments(source); // 註解不算語法：避免註解裡的 drop table 誤判
    const match = FILENAME_PATTERN.exec(file);

    if (!match) {
      problems.push(`檔名不符規則 NNNN_lower_snake_case.sql：${file}`);
      continue;
    }
    if (!source.trim()) {
      problems.push(`遷移檔內容是空的：${file}`);
    }
    if (statSync(fullPath).size === 0) {
      problems.push(`遷移檔大小為 0：${file}`);
    }
    for (const { pattern, label } of DESTRUCTIVE_PATTERNS) {
      if (pattern.test(code)) {
        problems.push(`${file} 含破壞性語法（${label}）：遷移檔只能往前加，需人手確認`);
      }
    }
    if (/create\s+index\s+(?!if\s+not\s+exists)/i.test(code)) {
      warnings.push(`${file} 有未加 if not exists 的 create index（重跑會失敗）`);
    }

    migrations.push({
      version: match[1],
      name: match[2],
      file,
      dir,
      checksum: sha256Hex(source),
      bytes: Buffer.byteLength(source, 'utf8'),
      source,
    });
  }

  // 編號唯一性
  const seen = new Map();
  for (const migration of migrations) {
    if (seen.has(migration.version)) {
      problems.push(`編號重複：${migration.version}（${seen.get(migration.version)} 與 ${migration.file}）`);
    } else {
      seen.set(migration.version, migration.file);
    }
  }

  // 編號必須從 0001 起連續
  const sorted = [...seen.keys()].sort();
  sorted.forEach((version, index) => {
    const expected = String(index + 1).padStart(4, '0');
    if (version !== expected) {
      problems.push(`編號不連續：預期 ${expected}，實際 ${version}（${seen.get(version)}）`);
    }
  });

  if (migrations.length === 0) problems.push('遷移資料夾內沒有任何遷移檔');

  return { ok: problems.length === 0, migrations, problems, warnings };
}

/** 取搬移清單並以 { version, name, file, checksum } 摘要輸出（給驗證/報告用）。 */
export function summarizeMigrations(dir = MIGRATIONS_DIR) {
  return inspectMigrations(dir).migrations.map(({ version, name, file, checksum, bytes }) => ({
    version,
    name,
    file,
    checksum,
    bytes,
  }));
}

const BUNDLE_HEADER = [
  '-- ============================================================================',
  '-- 資料庫遷移總包（generated file — 請勿手動編輯）',
  '--',
  '-- 產生方式： npm run db:bundle',
  '-- 用途：把 supabase/migrations/*.sql 依編號順序合併成一段可直接貼進',
  '--       Supabase SQL Editor 執行的 SQL，並自動寫入 schema_migrations 紀錄。',
  '-- 特性：全部檔案都必須可重複執行（idempotent），重跑不會壞資料。',
  '-- ============================================================================',
  '',
].join('\n');

/**
 * 產生可一次執行的 bundle。輸出必須是「內容決定」的（同樣的輸入永遠得到同樣的位元組），
 * 才能用檔案比對來偵測漂移。
 */
export function buildBundle(dir = MIGRATIONS_DIR) {
  const { migrations, problems } = inspectMigrations(dir);
  if (problems.length > 0) {
    throw new Error(`遷移檔有問題，無法產生 bundle：\n- ${problems.join('\n- ')}`);
  }
  const parts = [BUNDLE_HEADER];
  for (const migration of migrations) {
    parts.push(`-- >>> ${migration.file}  (sha256 ${migration.checksum})`);
    parts.push('begin;');
    parts.push(migration.source.trimEnd());
    parts.push(
      'insert into public.schema_migrations (version, name, checksum) values (' +
        `'${migration.version}', '${migration.name}', '${migration.checksum}') ` +
        'on conflict (version) do update set name = excluded.name, checksum = excluded.checksum;',
    );
    parts.push('commit;');
    parts.push('');
  }
  return parts.join('\n');
}

/** 比對磁碟上的 bundle 與即時產生的結果，回傳 { ok, problems, path }。 */
export function verifyBundle(dir = MIGRATIONS_DIR) {
  const path = join(dir, BUNDLE_FILENAME);
  const problems = [];
  let expected;
  try {
    expected = buildBundle(dir);
  } catch (error) {
    return { ok: false, path, problems: [error.message] };
  }
  if (!existsSync(path)) {
    problems.push(`缺少產生檔 ${path}，請執行 npm run db:bundle`);
    return { ok: false, path, problems };
  }
  const actual = normalizeNewlines(readFileSync(path, 'utf8'));
  if (actual !== expected) {
    problems.push(`${path} 與遷移檔不同步（遷移改過但沒重跑 npm run db:bundle）`);
  }
  return { ok: problems.length === 0, path, problems };
}
