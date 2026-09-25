// 授權政策測試：這組測試是「fail-closed」保證的核心。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ADMIN_ACTIONS, TEACHER_ACTIONS, PUBLIC_ACTIONS,
  assertAllowed, isAdminOnly, isPublicAction, isTeacherAllowed, isPrefixedAdmin, policyReport,
} from '../api/_lib/policy.js';

const student = { id: 'u1', role: 'Student', class_id: 'C1' };
const teacher = { id: 'u2', role: 'Teacher', class_id: 'C1' };
const admin = { id: 'u3', role: 'Admin', class_id: 'C1' };
const throws = (fn) => {
  try { fn(); return ''; } catch (error) { return error.code || 'ERROR'; }
};

test('前綴判定：admin*/ai* 一律視為特權（含尚未登記的新動作）', () => {
  assert.equal(isPrefixedAdmin('adminSomethingBrandNew'), true);
  assert.equal(isPrefixedAdmin('aiWhatever'), true);
  assert.equal(isPrefixedAdmin('administrator'), false, '小寫接續不算特權');
  assert.equal(isPrefixedAdmin('calendarAiRecognize'), false, '不在開頭不算');
});

test('回歸測試：新增但忘記登記的 admin* 動作不會外洩給學生', () => {
  // v3.5.3 的 bug 形狀：新動作不在 ADMIN 清單 → 學生可呼叫。現在必須被擋。
  assert.equal(throws(() => assertAllowed('adminDeleteEverything', student)), 'FORBIDDEN');
  assert.equal(throws(() => assertAllowed('adminDeleteEverything', teacher)), 'FORBIDDEN');
  assert.equal(throws(() => assertAllowed('adminDeleteEverything', admin)), '');
  assert.equal(isAdminOnly('aiFutureFeature'), true);
});

test('所有既有管理員動作：僅 Admin 可通過（與 v3.5.3 行為一致）', () => {
  for (const action of ADMIN_ACTIONS) {
    assert.equal(throws(() => assertAllowed(action, student)), 'FORBIDDEN', action + ' 應擋學生');
    assert.equal(throws(() => assertAllowed(action, teacher)), 'FORBIDDEN', action + ' 應擋教師');
    assert.equal(throws(() => assertAllowed(action, admin)), '', action + ' 應允許管理員');
  }
});

test('公開動作不需要登入', () => {
  for (const action of PUBLIC_ACTIONS) {
    assert.equal(isPublicAction(action), true);
    assert.equal(throws(() => assertAllowed(action, null)), '');
  }
  assert.equal(isPublicAction('login'), true);
  assert.equal(isPublicAction('getBootstrap'), false);
});

test('教師僅能使用行事曆與個人設定', () => {
  for (const action of TEACHER_ACTIONS) {
    assert.equal(isTeacherAllowed(action), true);
    assert.equal(throws(() => assertAllowed(action, teacher)), '', action + ' 教師應可用');
  }
  assert.equal(throws(() => assertAllowed('placeOrder', teacher)), 'FORBIDDEN');
  assert.equal(throws(() => assertAllowed('debtCreate', teacher)), 'FORBIDDEN');
  assert.equal(throws(() => assertAllowed('placeOrder', student)), '', '學生不受教師限制');
});

test('未登入者呼叫非公開動作 → UNAUTHORIZED', () => {
  assert.equal(throws(() => assertAllowed('getBootstrap', null)), 'UNAUTHORIZED');
  assert.equal(throws(() => assertAllowed('getBootstrap', undefined)), 'UNAUTHORIZED');
});

test('policyReport：清單與原始碼同步檢查', () => {
  const report = policyReport([...PUBLIC_ACTIONS, ...ADMIN_ACTIONS, ...TEACHER_ACTIONS]);
  assert.deepEqual(report.staleInPolicy, []);
  assert.deepEqual(report.unlistedAdmin, []);
  assert.deepEqual(report.member, [...TEACHER_ACTIONS].sort(), '非公開、非管理員的動作即為教師可用動作');
});
