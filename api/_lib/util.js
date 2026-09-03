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

// ===== 週別工具（週一至週日，ISO 週） =====

// 取得某日所屬週一的本地日期（YYYY-MM-DD）
export function mondayOf(input = new Date()) {
  const d = new Date(input);
  const day = d.getDay(); // 0=Sun, 1=Mon ...
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return todayStringOffset(d);
}

function todayStringOffset(d) {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// 某日所屬的 ISO 週標籤，例：'2026-W37'
export function weekLabelOf(dateInput = new Date()) {
  const monday = new Date(mondayOf(dateInput));
  const year = monday.getFullYear();
  const week = Math.ceil((((monday - new Date(year, 0, 1)) / 86400000) + 1) / 7);
  return `${year}-W${week}`;
}

// 下週標籤（下週一所在的週）
export function nextWeekLabel() {
  const nextMonday = new Date(mondayOf());
  nextMonday.setDate(nextMonday.getDate() + 7);
  return weekLabelOf(nextMonday);
}

// 某週的 7 天日期（週一～週日，YYYY-MM-DD）
export function weekDates(weekLabel) {
  const match = /^(\d{4})-W(\d{1,2})$/.exec(String(weekLabel || ''));
  if (!match) return [];
  const year = Number(match[1]);
  const week = Number(match[2]);
  const jan1 = new Date(year, 0, 1);
  const monday = new Date(jan1);
  monday.setDate(jan1.getDate() + (1 - jan1.getDay()) + (week - 1) * 7);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return todayStringOffset(d);
  });
}

// 台灣星期名稱
export function weekdayName(dateString) {
  const d = new Date(`${dateString}T00:00:00`);
  if (Number.isNaN(d.getTime())) return '';
  return ['週日', '週一', '週二', '週三', '週四', '週五', '週六'][d.getDay()];
}

export function monthDay(dateString) {
  const d = new Date(`${dateString}T00:00:00`);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
