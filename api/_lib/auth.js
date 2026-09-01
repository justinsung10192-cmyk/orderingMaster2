// 認證層：PBKDF2 密碼雜湊、登入 Token、Email 驗證碼、重設碼
import crypto from 'node:crypto';
import { appError, randomHex, randomDigits, sha256Hex, randomCode, generateClassId, num } from './util.js';
import { supabase, findOne, insertRow, deleteRows, updateRows } from './db.js';

export const SESSION_SECONDS = 6 * 60 * 60; // 六小時
export const EMAIL_CODE_MINUTES = 15;

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

export async function createDeveloperSession(developer) {
  const rawToken = randomHex(32);
  await insertRow('auth_tokens', {
    class_id: 'developer',
    user_id: null,
    developer_id: developer.id,
    type: 'DevSession',
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

export async function validateDeveloperSession(token) {
  if (!token) throw appError('UNAUTHORIZED', '請先登入開發者工作台。');
  const record = await findOne('auth_tokens', { token_hash: sha256Hex(String(token)), type: 'DevSession' });
  if (!record || new Date(record.expires_at).getTime() < Date.now()) {
    throw appError('UNAUTHORIZED', '開發者登入已失效，請重新登入。');
  }
  const developer = await findOne('developers', { id: record.developer_id });
  if (!developer || developer.is_disabled) throw appError('UNAUTHORIZED', '開發者帳號不存在或已停用。');
  return developer;
}

export async function destroySession(token, type = 'Session') {
  if (!token) return;
  await deleteRows('auth_tokens', { token_hash: sha256Hex(String(token)), type });
}

// 每次改密碼／停用／升級時，讓舊 Token 全部失效
export async function bumpAuthVersion(userId) {
  const user = await findOne('users', { id: userId });
  if (!user) return;
  await updateRows('users', { id: userId }, { auth_version: num(user.auth_version) + 1 });
  await deleteRows('auth_tokens', { user_id: userId });
}

// ---- Email 驗證碼 / 重設碼（6 位數，資料庫存雜湊） ----
export async function issueEmailCode(user, type, minutes = EMAIL_CODE_MINUTES) {
  const code = randomDigits(6);
  await insertRow('auth_tokens', {
    class_id: user.class_id,
    user_id: user.id,
    type,
    token_hash: sha256Hex(code),
    expires_at: new Date(Date.now() + minutes * 60 * 1000).toISOString(),
  });
  return code;
}

export async function consumeEmailCode(userId, type, code) {
  if (!code || !/^\d{6}$/.test(String(code))) throw appError('INVALID_CODE', '驗證碼格式不正確。');
  const record = await findOne('auth_tokens', { user_id: userId, type, token_hash: sha256Hex(String(code)) });
  if (!record || new Date(record.expires_at).getTime() < Date.now()) {
    throw appError('INVALID_CODE', '驗證碼不正確或已過期，請重新索取。');
  }
  await deleteRows('auth_tokens', { id: record.id });
  return true;
}

// ---- 邀請碼 / 班級管理者代碼 ----
export function createInviteCodeValue() {
  return randomCode(8);
}

export function createClassAdminCodeValue() {
  return randomCode(12);
}

export async function findOrCreateClass(className, schoolId = null) {
  // 管理者註冊時建立班級（class_id 為隨機值，避免被猜測）
  const classId = generateClassId();
  const row = { class_id: classId, name: className || '未命名班級' };
  if (schoolId) row.school_id = Number(schoolId);
  await supabase.from('classes').insert(row).select().single();
  return classId;
}

export { generateClassId };
