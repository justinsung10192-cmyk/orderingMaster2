// 動作：店家與菜單管理（資料夾式：店家 → 品項 → 客製選項）
import { appError, sid, num, weekLabelOf, weekdayName } from '../_lib/util.js';
import { findOne, listRows, listRowsIn, insertRow, updateRows, deleteRows, callRpc, listStoresForClass, listMenuItemsForStore, listMenuItemsForStores, supabase } from '../_lib/db.js';

function normalizeOptions(options) {
  if (!Array.isArray(options)) return [];
  return options
    .map((option) => ({
      name: String(option?.name || '').trim(),
      price: num(option?.price),
      required: Boolean(option?.required),
      group: String(option?.group || ''),
    }))
    .filter((option) => option.name)
    .slice(0, 30);
}

export const actions = {
  // 完整菜單目錄（資料夾視圖用）
  async adminCatalog(_data, ctx) {
    const stores = await listStoresForClass(ctx.classId);
    const storeIds = stores.map((store) => store.id);
    const allItems = storeIds.length ? await listMenuItemsForStores(ctx.classId, storeIds) : [];
    const itemsByStore = new Map();
    for (const item of allItems) {
      if (!itemsByStore.has(String(item.store_id))) itemsByStore.set(String(item.store_id), []);
      itemsByStore.get(String(item.store_id)).push(item);
    }
    const result = stores.map((store) => ({
      storeId: sid(store.id),
      name: store.name,
      isActive: Boolean(store.is_active),
      items: (itemsByStore.get(String(store.id)) || [])
        .filter((item) => !item.menu_date || item.menu_date === '1970-01-01')
        .map((item) => ({
          itemId: sid(item.id),
          name: item.name,
          dish: item.dish || '',
          price: num(item.price),
          menuDate: item.menu_date || '',
          options: (Array.isArray(item.options) ? item.options : []).map((option) => ({
            name: option.name,
            price: num(option.price),
            required: Boolean(option.required),
            group: String(option.group || ''),
          })),
          isActive: Boolean(item.is_active),
        })),
    }));
    return { stores: result };
  },

  async adminSaveStore(data, ctx) {
    const name = String(data.name || '').trim();
    if (!name) throw appError('INVALID_INPUT', '請輸入店家名稱。');
    if (data.storeId) {
      const existing = await findOne('stores', { id: Number(data.storeId) }, ctx.classId);
      if (!existing) throw appError('NOT_FOUND', '店家不存在。');
      await updateRows('stores', { id: existing.id }, { name });
      return { ok: true, storeId: sid(existing.id) };
    }
    const store = await insertRow('stores', { class_id: ctx.classId, name, sort_order: 0 });
    return { ok: true, storeId: sid(store.id) };
  },

  async adminDeleteStore(data, ctx) {
    const store = await findOne('stores', { id: Number(data.storeId) }, ctx.classId);
    if (!store) throw appError('NOT_FOUND', '店家不存在。');
    // 軟刪除：保留外鍵關聯的既有場次/訂單，並釋放店家名稱以便重新新增
    await updateRows('stores', { id: store.id }, {
      is_deleted: true,
      is_active: false,
      name: `${store.name} (已刪除#${store.id})`,
    });
    return { ok: true };
  },

  async adminSaveMenuItem(data, ctx) {
    const store = await findOne('stores', { id: Number(data.storeId) }, ctx.classId);
    if (!store) throw appError('NOT_FOUND', '店家不存在。');
    const name = String(data.name || '').trim();
    const price = num(data.price);
    if (!name) throw appError('INVALID_INPUT', '請輸入品項名稱。');
    if (price < 0 || price > 100000) throw appError('INVALID_INPUT', '價格不正確。');
    const options = normalizeOptions(data.options);

    if (data.itemId) {
      const existing = await findOne('menu_items', { id: Number(data.itemId) }, ctx.classId);
      if (!existing) throw appError('NOT_FOUND', '品項不存在。');
      await updateRows('menu_items', { id: existing.id }, { name, price, options });
      return { ok: true, itemId: sid(existing.id) };
    }
    // 同名品項以 upsert 更新（避免 unique constraint 錯誤）
    const { data: item, error } = await supabase
      .from('menu_items')
      .upsert({ class_id: ctx.classId, store_id: store.id, name, price, options, menu_date: '1970-01-01', sort_order: 0 }, { onConflict: 'class_id,store_id,name,menu_date' })
      .select()
      .single();
    if (error) throw appError('DB_ERROR', error.message);
    return { ok: true, itemId: sid(item.id) };
  },

  async adminDeleteMenuItem(data, ctx) {
    const item = await findOne('menu_items', { id: Number(data.itemId) }, ctx.classId);
    if (!item) throw appError('NOT_FOUND', '品項不存在。');
    await deleteRows('menu_items', { id: item.id });
    return { ok: true };
  },

  async adminSetItemActive(data, ctx) {
    const item = await findOne('menu_items', { id: Number(data.itemId) }, ctx.classId);
    if (!item) throw appError('NOT_FOUND', '品項不存在。');
    await updateRows('menu_items', { id: item.id }, { is_active: Boolean(data.isActive) });
    return { ok: true };
  },

  // 供 AI OCR 預覽後一次寫入多個品項
  async adminBatchSaveMenuItems(data, ctx) {
    const store = await findOne('stores', { id: Number(data.storeId) }, ctx.classId);
    if (!store) throw appError('NOT_FOUND', '店家不存在。');
    const items = Array.isArray(data.items) ? data.items : [];
    if (!items.length) throw appError('INVALID_INPUT', '沒有可寫入的品項。');
    if (items.length > 100) throw appError('INVALID_INPUT', '單次最多寫入 100 個品項。');

    let count = 0;
    for (const item of items) {
      const name = String(item?.name || '').trim();
      if (!name) continue;
      const price = num(item?.price);
      const { error } = await supabase
        .from('menu_items')
        .upsert({ class_id: ctx.classId, store_id: store.id, name, price, options: normalizeOptions(item.options), menu_date: '1970-01-01', sort_order: 0 }, { onConflict: 'class_id,store_id,name,menu_date' });
      if (error) throw appError('DB_ERROR', error.message);
      count += 1;
    }
    return { ok: true, created: count };
  },

  // 匯入整月內訂菜單：建立/更新店家、品項與每天場次（草稿）
  async adminImportMonthlyMenu(data, ctx) {
    const entries = Array.isArray(data.entries) ? data.entries : [];
    if (!entries.length) throw appError('INVALID_INPUT', '沒有可匯入的菜單資料。');
    const cutoffTime = String(data.defaultCutoffTime || '').trim();
    if (!/^\d{2}:\d{2}$/.test(cutoffTime)) throw appError('INVALID_INPUT', '請選擇每天截止時間。');

    let stores = 0, items = 0, sessions = 0;
    for (const entry of entries) {
      const storeName = String(entry?.store || '').trim();
      const date = String(entry?.date || '').trim();
      if (!storeName || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      const storeResult = await findOrCreateStore(ctx.classId, storeName);
      if (storeResult.created) stores += 1;
      if (Array.isArray(entry.items)) {
        for (const item of entry.items) {
          const name = String(item?.name || '').trim();
          if (!name) continue;
          const itemResult = await findOrCreateMenuItem(ctx.classId, storeResult.store.id, name, num(item?.price), normalizeOptions(item.options), date);
          if (itemResult.created) items += 1;
        }
      }
      const sessionResult = await findOrCreateSession(ctx.classId, storeResult.store.id, date, cutoffTime);
      if (sessionResult.created) sessions += 1;
    }
    return { ok: true, stores, items, sessions };
  },

  // 匯入廠商每月菜單：整合至「內訂」合併店家，每天一個場次（品項名稱加廠商前綴，如「正園-B餐」）
  async adminImportVendorMenu(data, ctx) {
    const storeName = String(data.storeName || '').trim();
    if (!storeName) throw appError('INVALID_INPUT', '請輸入廠商名稱。');
    const entries = Array.isArray(data.entries) ? data.entries : [];
    if (!entries.length) throw appError('INVALID_INPUT', '沒有可匯入的菜單資料。');
    if (entries.length > 200) throw appError('INVALID_INPUT', '單次最多匯入 200 天。');

    const dailyStore = await findOrCreateDailyStore(ctx.classId);
    let createdItems = 0;
    let createdSessions = 0;
    for (const entry of entries) {
      const date = String(entry?.date || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      const items = Array.isArray(entry?.items) ? entry.items : [];
      if (!items.length) continue;
      for (const item of items) {
        const name = String(item?.name || '').trim();
        if (!name) continue;
        const itemResult = await findOrCreateMenuItem(ctx.classId, dailyStore.id, `${storeName}-${name}`, num(item?.price), normalizeOptions(item.options), date, String(item?.dish || '').trim());
        if (itemResult.created) createdItems += 1;
      }
      const sessionResult = await findOrCreateSession(ctx.classId, dailyStore.id, date);
      if (sessionResult.created) createdSessions += 1;
    }
    return { ok: true, storeId: sid(dailyStore.id), storeName: dailyStore.name, createdItems, createdSessions };
  },

  // 每日菜單專屬介面：依月份列出每天各店家的餐點
  async adminGetDailyMenus(data, ctx) {
    const month = String(data.month || '').trim();
    if (!/^\d{4}-\d{2}$/.test(month)) throw appError('INVALID_INPUT', '請選擇月份。');
    const [year, mon] = month.split('-').map(Number);
    const nextMonth = mon === 12 ? `${year + 1}-01` : `${year}-${String(mon + 1).padStart(2, '0')}`;
    const { data: rangeItems, error } = await supabase
      .from('menu_items')
      .select('*')
      .eq('class_id', ctx.classId)
      .gte('menu_date', `${month}-01`)
      .lt('menu_date', `${nextMonth}-01`);
    if (error) throw appError('DB_ERROR', error.message);
    const datedItems = (rangeItems || []).filter((item) => item.menu_date !== '1970-01-01');
    const storeIds = [...new Set(datedItems.map((item) => item.store_id))];
    const stores = storeIds.length ? await listRowsIn('stores', 'id', storeIds, { classId: ctx.classId }) : [];
    const storeById = new Map(stores.map((store) => [String(store.id), store]));
    const byDate = new Map();
    for (const item of datedItems) {
      if (!byDate.has(item.menu_date)) byDate.set(item.menu_date, []);
      byDate.get(item.menu_date).push(item);
    }
    // 全部集中顯示於「內訂」：非內訂店家的品項自動加「廠商-」前綴
    const days = [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, items]) => {
      const list = items
        .map((item) => {
          const storeName = storeById.get(String(item.store_id))?.name || '未命名店家';
          const name = storeName === '內訂' ? item.name : `${storeName}-${item.name}`;
          return { itemId: sid(item.id), storeId: String(item.store_id), name, dish: item.dish || '', price: num(item.price) };
        })
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'));
      return { date, weekday: weekdayName(date), items: list };
    });
    return { month, days };
  },

  // 刪除某天的某店家每日菜單（品項 + 場次）
  async adminDeleteDailyMenu(data, ctx) {
    const storeId = Number(data.storeId);
    const date = String(data.date || '').trim();
    if (!storeId) throw appError('INVALID_INPUT', '店家不正確。');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw appError('INVALID_INPUT', '日期不正確。');
    await deleteRows('menu_items', { class_id: ctx.classId, store_id: storeId, menu_date: date });
    const session = await findOne('sessions', { store_id: storeId, order_date: date }, ctx.classId);
    if (session && !session.is_deleted) {
      await callRpc('fn_delete_session_and_refund', { p_class_id: ctx.classId, p_session_id: session.id });
    }
    return { ok: true };
  },

  // 刪除單一每日菜單品項
  async adminDeleteDailyMenuItem(data, ctx) {
    const item = await findOne('menu_items', { id: Number(data.itemId) }, ctx.classId);
    if (!item) throw appError('NOT_FOUND', '找不到此品項。');
    await deleteRows('menu_items', { id: item.id });
    return { ok: true };
  },

  // 一鍵刪除每日菜單：刪除指定月份（未指定則全部）的日期品項，並軟刪除對應場次
  async adminClearDailyMenus(data, ctx) {
    const month = String(data.month || '').trim();
    let query = supabase
      .from('menu_items')
      .select('id, store_id, menu_date')
      .eq('class_id', ctx.classId)
      .neq('menu_date', '1970-01-01');
    if (/^\d{4}-\d{2}$/.test(month)) {
      const [year, mon] = month.split('-').map(Number);
      const next = mon === 12 ? `${year + 1}-01` : `${year}-${String(mon + 1).padStart(2, '0')}`;
      query = query.gte('menu_date', `${month}-01`).lt('menu_date', `${next}-01`);
    }
    const { data: items, error } = await query;
    if (error) throw appError('DB_ERROR', error.message);
    const dated = (items || []).filter((item) => item.menu_date !== '1970-01-01');
    if (!dated.length) return { ok: true, deletedItems: 0, deletedSessions: 0 };

    const ids = dated.map((item) => item.id);
    const { error: delErr } = await supabase.from('menu_items').delete().in('id', ids).eq('class_id', ctx.classId);
    if (delErr) throw appError('DB_ERROR', delErr.message);

    const pairs = [...new Set(dated.map((item) => `${item.store_id}|${item.menu_date}`))];
    let deletedSessions = 0;
    let refundedOrders = 0;
    for (const pair of pairs) {
      const [storeId, date] = pair.split('|');
      const session = await findOne('sessions', { store_id: Number(storeId), order_date: date }, ctx.classId);
      if (session && !session.is_deleted) {
        const result = await callRpc('fn_delete_session_and_refund', { p_class_id: ctx.classId, p_session_id: session.id });
        deletedSessions += 1;
        refundedOrders += num(result?.refunded_count);
      }
    }
    return { ok: true, deletedItems: dated.length, deletedSessions, refundedOrders };
  },
};

// ---- 每月菜單匯入輔助 ----
async function findOrCreateStore(classId, name) {
  const existing = await findOne('stores', { name, is_deleted: false }, classId);
  if (existing) return { store: existing, created: false };
  return { store: await insertRow('stores', { class_id: classId, name, sort_order: 0 }), created: true };
}

// 「內訂」合併店家：所有廠商的每日菜單整合到這個店家，每天一個場次
async function findOrCreateDailyStore(classId) {
  const existing = await findOne('stores', { name: '內訂', is_deleted: false }, classId);
  if (existing) return existing;
  return insertRow('stores', { class_id: classId, name: '內訂', sort_order: 999 });
}

async function findOrCreateMenuItem(classId, storeId, name, price, options, menuDate = '1970-01-01', dish = '') {
  const existing = await findOne('menu_items', { store_id: storeId, name, menu_date: menuDate }, classId);
  // 以 upsert（ON CONFLICT）寫入，避免並發或重複匯入時觸發 unique constraint 錯誤
  const row = {
    class_id: classId,
    store_id: storeId,
    name,
    menu_date: menuDate,
    price: existing ? (price > 0 ? price : num(existing.price)) : price,
    dish: dish || (existing?.dish || ''),
    options,
    sort_order: 0,
  };
  const { data: item, error } = await supabase
    .from('menu_items')
    .upsert(row, { onConflict: 'class_id,store_id,name,menu_date' })
    .select()
    .single();
  if (error) throw appError('DB_ERROR', error.message);
  return { item, created: !existing };
}

async function findOrCreateSession(classId, storeId, date, cutoffTime = '09:30') {
  const existing = await findOne('sessions', { store_id: storeId, order_date: date }, classId);
  if (existing) return { session: existing, created: false }; // 含已刪除，尊重管理者手動刪除
  const cutoff = new Date(`${date}T${cutoffTime}:00`);
  const session = await insertRow('sessions', {
    class_id: classId,
    store_id: storeId,
    order_date: date,
    cutoff_time: cutoff.toISOString(),
    week_label: weekLabelOf(`${date}T00:00:00`),
    is_open: false, // 草稿，待管理者公布
    start_notice_sent: false,
  });
  return { session, created: true };
}
