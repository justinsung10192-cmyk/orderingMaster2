import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readRawBody, sendJson, weekDates, weekLabelOf, mondayOf } from '../api/_lib/util.js';

const makeReq = (buffer) => Readable.from([buffer]);

test('readRawBody：正常讀取', async () => {
  const text = await readRawBody(makeReq(Buffer.from('{"action":"login"}')));
  assert.equal(text, '{"action":"login"}');
});

test('readRawBody：超過自訂上限時以 INVALID_INPUT 拒絕', async () => {
  await assert.rejects(
    () => readRawBody(makeReq(Buffer.alloc(64)), 10),
    (error) => error.code === 'INVALID_INPUT',
  );
});

test('readRawBody：預設上限為 12MB', async () => {
  const text = await readRawBody(makeReq(Buffer.alloc(2048)));
  assert.equal(text.length, 2048);
});

test('sendJson：可指定狀態碼（未指定時維持 200）', () => {
  const calls = [];
  const res = {
    setHeader: (...args) => calls.push(args),
    status: (code) => ({ send: (body) => calls.push(['send', code, body]) }),
  };
  sendJson(res, { ok: false }, 401);
  const statusCall = calls.find((c) => Array.isArray(c) && c[0] === 'send');
  assert.equal(statusCall[1], 401);
});

test('週別工具：mondayOf / weekLabelOf / weekDates 彼此一致', () => {
  const label = weekLabelOf('2026-09-25');
  const dates = weekDates(label);
  assert.equal(dates.length, 7);
  assert.equal(dates[0], mondayOf('2026-09-25'));
  assert.ok(dates.includes('2026-09-25'), label + ' 應包含 2026-09-25，實際 ' + dates.join(','));
  assert.equal(weekLabelOf(dates[6]), label, '同一週的週日應回到同一標籤');
});
