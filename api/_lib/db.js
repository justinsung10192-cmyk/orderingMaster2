// 資料庫層：Supabase Admin Client + 查詢輔助
import { createClient } from '@supabase/supabase-js';
import { appError } from './util.js';

const supabaseUrl = process.env.SUPABASE_URL || '';
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

export const supabase = createClient(supabaseUrl, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

export function throwDb(error, fallback = '資料庫操作失敗。') {
  if (error?.message?.includes('INSUFFICIENT_BALANCE')) throw appError('INSUFFICIENT_BALANCE', '儲值餘額不足，無法完成此操作。');
  if (error?.message?.includes('USER_NOT_FOUND')) throw appError('USER_NOT_FOUND', '找不到使用者。');
  if (error?.message?.includes('ORDER_NOT_FOUND')) throw appError('ORDER_NOT_FOUND', '找不到訂單。');
  if (error?.message) throw appError('DB_ERROR', error.message);
  throw appError('DB_ERROR', fallback);
}

export async function listRows(table, options = {}) {
  const { classId, filters = {}, order = null, orderAscending = true, limit = null, columns = '*' } = options;
  let query = supabase.from(table).select(columns);
  if (classId) query = query.eq('class_id', classId);
  Object.entries(filters).forEach(([column, value]) => {
    if (value !== undefined && value !== null) query = query.eq(column, value);
  });
  if (order) query = query.order(order, { ascending: orderAscending });
  if (limit) query = query.limit(limit);
  const { data, error } = await query;
  if (error) throwDb(error);
  return data || [];
}

export async function listRowsIn(table, column, values, options = {}) {
  const { classId, order = null, orderAscending = true } = options;
  let query = supabase.from(table).select('*').in(column, values);
  if (classId) query = query.eq('class_id', classId);
  if (order) query = query.order(order, { ascending: orderAscending });
  const { data, error } = await query;
  if (error) throwDb(error);
  return data || [];
}

export async function findOne(table, filters = {}, classId = null) {
  let query = supabase.from(table).select('*');
  if (classId) query = query.eq('class_id', classId);
  Object.entries(filters).forEach(([column, value]) => {
    if (value !== undefined && value !== null) query = query.eq(column, value);
  });
  const { data, error } = await query.maybeSingle();
  if (error) throwDb(error);
  return data || null;
}

export async function insertRow(table, values) {
  const { data, error } = await supabase.from(table).insert(values).select().single();
  if (error) throwDb(error);
  return data;
}

export async function updateRows(table, filters, values) {
  let query = supabase.from(table).update(values);
  Object.entries(filters).forEach(([column, value]) => {
    query = query.eq(column, value);
  });
  const { data, error } = await query.select();
  if (error) throwDb(error);
  return data || [];
}

export async function deleteRows(table, filters) {
  let query = supabase.from(table).delete();
  Object.entries(filters).forEach(([column, value]) => {
    query = query.eq(column, value);
  });
  const { data, error } = await query.select();
  if (error) throwDb(error);
  return data || [];
}

export async function countRows(table, filters = {}) {
  let query = supabase.from(table).select('id', { count: 'exact', head: true });
  Object.entries(filters).forEach(([column, value]) => {
    query = query.eq(column, value);
  });
  const { count, error } = await query;
  if (error) throwDb(error);
  return count || 0;
}

export async function callRpc(name, params = {}) {
  const { data, error } = await supabase.rpc(name, params);
  if (error) throwDb(error);
  return data;
}

// 目前所有讀寫皆經由 API 的 service role 進行（RLS 關閉也不影響安全）。
// 班級可用的店家 = 本班店家 + 全體共用店家

export async function listStoresForClass(classId) {
  const classRow = await findOne('classes', { class_id: classId });
  const schoolId = classRow && classRow.school_id ? String(classRow.school_id) : null;
  const { data, error } = await supabase
    .from('stores')
    .select('*')
    .or(`class_id.eq.${classId},is_global.eq.true`)
    .order('sort_order');
  if (error) throwDb(error);
  // 全體店家：全區(all)全部分享；學校專屬(school)僅該學校班級可見
  return (data || []).filter(store => !store.is_global || store.scope !== 'school' || (schoolId && String(store.school_id) === schoolId));
}

export async function findStoreForClass(storeId, classId) {
  const store = await findOne('stores', { id: Number(storeId) });
  if (!store) return null;
  if (String(store.class_id) === String(classId) || store.is_global) return store;
  return null;
}
export async function getAppSetting(classId, key, defaultValue = '') {
  const row = await findOne('app_settings', { class_id: classId, key });
  return row ? row.value : defaultValue;
}

export async function setAppSetting(classId, key, value) {
  const existing = await findOne('app_settings', { class_id: classId, key });
  if (existing) {
    await updateRows('app_settings', { id: existing.id }, { value: String(value ?? '') });
  } else {
    await insertRow('app_settings', { class_id: classId, key, value: String(value ?? '') });
  }
}
