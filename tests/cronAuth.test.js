import test from 'node:test';
import assert from 'node:assert/strict';
import { cronSecretFrom, verifyCronSecret, usesLegacyQuerySecret, safeEqual } from '../api/_lib/cronAuth.js';

test('可從 Authorization: Bearer 取得密鑰', () => {
  assert.equal(cronSecretFrom({ headers: { authorization: 'Bearer s3cret' }, url: '/' }), 's3cret');
  assert.equal(cronSecretFrom({ headers: { authorization: 'bearer s3cret' }, url: '/' }), 's3cret');
});

test('可從 x-cron-secret 取得密鑰', () => {
  assert.equal(cronSecretFrom({ headers: { 'x-cron-secret': 'abc' }, url: '/' }), 'abc');
});

test('相容舊格式：?secret=', () => {
  const req = { headers: {}, url: '/api/cron?secret=abc&x=1' };
  assert.equal(cronSecretFrom(req), 'abc');
  assert.equal(verifyCronSecret(req, 'abc'), true);
  assert.equal(usesLegacyQuerySecret(req), true);
});

test('未設定 CRON_SECRET 時一律拒絕（fail-closed）', () => {
  assert.equal(verifyCronSecret({ headers: { authorization: 'Bearer abc' }, url: '/' }, ''), false);
  assert.equal(verifyCronSecret({ headers: { authorization: 'Bearer abc' }, url: '/' }, undefined), false);
});

test('密鑰錯誤時拒絕', () => {
  assert.equal(verifyCronSecret({ headers: { authorization: 'Bearer wrong' }, url: '/' }, 'right'), false);
  assert.equal(verifyCronSecret({ headers: {}, url: '/' }, 'right'), false);
  assert.equal(verifyCronSecret({ headers: { authorization: 'Bearer right' }, url: '/' }, 'right'), true);
  assert.equal(usesLegacyQuerySecret({ headers: { authorization: 'Bearer r' }, url: '/?secret=r' }), false);
});

test('safeEqual：長度不同不拋錯，只回 false', () => {
  assert.equal(safeEqual('a', 'ab'), false);
  assert.equal(safeEqual('ab', 'ab'), true);
});
