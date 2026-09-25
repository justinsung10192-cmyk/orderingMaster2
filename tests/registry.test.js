// 動作清單防護：從原始碼抽出所有 action，驗證授權政策沒有漏登或腐化。
// 這支測試就是「新增特權動作時會被強制審查」的機制。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { policyReport } from '../api/_lib/policy.js';

const ACTIONS_DIR = path.join(process.cwd(), 'api', '_actions');

function extractActionNames() {
  const names = new Set();
  for (const file of fs.readdirSync(ACTIONS_DIR).filter((f) => f.endsWith('.js'))) {
    const source = fs.readFileSync(path.join(ACTIONS_DIR, file), 'utf8');
    // 簡寫方法：  async adminXxx(data, ctx) {
    for (const m of source.matchAll(/^ {2}(?:async )?([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/gm)) names.add(m[1]);
    // 屬性箭頭： adminXxx: async (data, ctx) => {
    for (const m of source.matchAll(/^ {2}([A-Za-z_$][A-Za-z0-9_$]*)\s*:\s*(?:async\s*)?\(/gm)) names.add(m[1]);
  }
  return [...names].sort();
}

const actions = extractActionNames();

test('確實抽得到動作（防呆：解析失敗要立刻知道）', () => {
  assert.ok(actions.length >= 60, '只抽到 ' + actions.length + ' 個動作，解析規則可能失效');
});

test('政策清單沒有腐化（政策裡寫的動作都存在於原始碼）', () => {
  const report = policyReport(actions);
  assert.deepEqual(report.staleInPolicy, []);
});

test('所有 admin*/ai* 動作都已明確登記在 ADMIN_ACTIONS', () => {
  const report = policyReport(actions);
  assert.deepEqual(report.unlistedAdmin, [], '以下動作請補進 api/_lib/policy.js 的 ADMIN_ACTIONS');
});

test('每個動作都必須落在某一層權限（不得未分類）', () => {
  const report = policyReport(actions);
  const classified = new Set([...report.public, ...report.admin, ...report.teacher, ...report.member]);
  const unclassified = actions.filter((name) => !classified.has(name));
  assert.deepEqual(unclassified, []);
});

test('權限分佈快照（數量變動時請確認是刻意新增）', () => {
  const report = policyReport(actions);
  assert.ok(report.public.length >= 4, '公開動作不應少於 4 個');
  assert.ok(report.admin.length >= 70, '管理員動作不應少於 70 個，實際 ' + report.admin.length);
  assert.ok(report.member.length >= 5, '一般會員動作不應少於 5 個，實際 ' + report.member.length);
});
