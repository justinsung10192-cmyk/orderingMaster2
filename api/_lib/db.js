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
  if (error?.message?.includes('PURE_MODE_NO_CASH')) throw appError('PURE_MODE_NO_CASH', '目前為純儲值模式，餘額不足無法訂餐。');
  if (error?.message?.includes('USER_NOT_FOUND')) throw appError('USER_NOT_FOUND', '找不到使用者。');
  if (error?.message?.includes('ORDER_NOT_FOUND')) throw appError('ORDER_NOT_FOUND', '找不到訂單。');
  if (error?.message?.includes('SESSION_NOT_FOUND')) throw appError('SESSION_NOT_FOUND', '找不到場次。');
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
  if (!values || !values.length) return [];
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

// 讀取班級資料（含純儲值模式開關）
export async function getClass(classId) {
  const row = await findOne('classes', { class_id: classId });
  if (!row) throw appError('NOT_FOUND', '找不到班級資料。');
  return row;
}

export async function isPureBalanceMode(classId) {
  try {
    const row = await getClass(classId);
    return Boolean(row.pure_balance_mode);
  } catch (_) {
    return false;
  }
}

export async function listStoresForClass(classId, { includeInactive = true } = {}) {
  const filters = includeInactive ? {} : { is_active: true };
  const stores = await listRows('stores', { classId, filters, order: 'sort_order' });
  return stores;
}

export async function listMenuItemsForStore(classId, storeId, { includeInactive = true } = {}) {
  const filters = { store_id: storeId };
  if (!includeInactive) filters.is_active = true;
  return listRows('menu_items', { classId, filters, order: 'sort_order' });
}
