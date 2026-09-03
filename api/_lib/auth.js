// 認證層：PBKDF2 密碼雜湊、登入 Token
import crypto from 'node:crypto';
import { appError, randomHex, sha256Hex } from './util.js';
import { findOne, insertRow, deleteRows, updateRows } from './db.js';

export const SESSION_SECONDS = 6 * 60 * 60; // 六小時
export const DEFAULT_PASSWORD = 'lunch1234';

export function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(String(password), salt, 100000, 32, 'sha256').toString('hex');
}

export function createPassword(password) {
  if (!password || String(password).length < 8) throw appError('WEAK_PASSWORD', '密碼至少須為 8 個字元。');
  const salt = randomHex(16);
  return { salt, hash: hashPassword(password, salt) };
}

export function verifyPassword(user, password) {
  if (!user || !user.password_hash || !user.salt) return false;
  const expected = hashPassword(password, user.salt);
  const actual = user.password_hash;
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex'));
}

// 產生預設帳號的密碼雜湊（與 schema.sql 種子資料一致）
export function defaultPasswordCredentials() {
  const salt = '3f9c2e7a1b5d8f0e6a4c2b8d9e7f1a3c';
  return { salt, hash: hashPassword(DEFAULT_PASSWORD, salt) };
}

// ---- 登入 Session Token（隨機 Token，資料庫只存雜湊，可隨時撤銷） ----
export async function createSession(user) {
  const rawToken = randomHex(32);
  await insertRow('auth_tokens', {
    class_id: user.class_id || '',
    user_id: user.id,
    type: 'Session',
    token_hash: sha256Hex(rawToken),
    expires_at: new Date(Date.now() + SESSION_SECONDS * 1000).toISOString(),
  });
  return rawToken;
}

export async function validateSession(token) {
  if (!token) throw appError('UNAUTHORIZED', '請先登入。');
  const record = await findOne('auth_tokens', { token_hash: sha256Hex(String(token)), type: 'Session' });
  if (!record || new Date(record.expires_at).getTime() < Date.now()) {
    throw appError('UNAUTHORIZED', '登入狀態已失效，請重新登入。');
  }
  const user = await findOne('users', { id: record.user_id });
  if (!user) throw appError('UNAUTHORIZED', '帳號不存在，請重新登入。');
  if (user.is_disabled) throw appError('DISABLED', '此帳號已停用。');
  return user;
}

export async function destroySession(token) {
  if (!token) return;
  await deleteRows('auth_tokens', { token_hash: sha256Hex(String(token)), type: 'Session' });
}

// 每次改密碼／停用／升級時，讓舊 Token 全部失效
export async function bumpAuthVersion(userId) {
  const user = await findOne('users', { id: userId });
  if (!user) return;
  await updateRows('users', { id: userId }, { auth_version: Number(user.auth_version || 0) + 1 });
  await deleteRows('auth_tokens', { user_id: userId });
}
