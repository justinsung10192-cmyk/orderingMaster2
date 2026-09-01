// 共用工具：錯誤、ID 字串化、日期、隨機碼
import crypto from 'node:crypto';

export class AppError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export const appError = (code, message) => new AppError(code, message);

// 所有回傳給前端的 id 一律字串化（前端用嚴格等於比對 dataset）
export const sid = (value) => (value === null || value === undefined ? '' : String(value));

export const num = (value) => Number(value || 0);

export const round2 = (value) => Math.round(Number(value || 0) * 100) / 100;

export function randomHex(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

export function randomDigits(length = 6) {
  let result = '';
  for (let i = 0; i < length; i += 1) result += crypto.randomInt(0, 10).toString();
  return result;
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function randomCode(length = 8) {
  let result = '';
  for (let i = 0; i < length; i += 1) result += CODE_ALPHABET[crypto.randomInt(0, CODE_ALPHABET.length)];
  return result;
}

export function generateClassId() {
  return 'C' + randomCode(9).toLowerCase();
}

export function sha256Hex(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

// 本機日期（YYYY-MM-DD，與資料庫 order_date 一致）
export function todayString(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function toIso(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

export async function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function sendJson(res, payload) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).send(JSON.stringify(payload));
}
