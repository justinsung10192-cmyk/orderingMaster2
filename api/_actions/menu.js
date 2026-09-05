// 動作：店家與菜單管理（資料夾式：店家 → 品項 → 客製選項）
import { appError, sid, num, weekLabelOf } from '../_lib/util.js';
import { findOne, listRows, insertRow, updateRows, deleteRows, listStoresForClass, listMenuItemsForStore, listMenuItemsForStores } from '../_lib/db.js';

function normalizeOptions(options) {
  if (!Array.isArray(options)) return [];
  return options
    .map((option) => ({
      name: String(option?.name || '').trim(),
      price: num(option?.price),
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
      items: (itemsByStore.get(String(store.id)) || []).map((item) => ({
        itemId: sid(item.id),
        name: item.name,
        price: num(item.price),
        menuDate: item.menu_date || '',
        options: (Array.isArray(item.options) ? item.options : []).map((option) => ({
          name: option.name,
          price: num(option.price),
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
    const item = await insertRow('menu_items', {
      class_id: ctx.classId,
      store_id: store.id,
      name,
      price,
      options,
      sort_order: 0,
    });
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
      await insertRow('menu_items', {
        class_id: ctx.classId,
        store_id: store.id,
        name,
        price,
        options: normalizeOptions(item.options),
        sort_order: 0,
      });
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

  // 匯入廠商每月菜單：依「廠商名稱」建立/更新店家、日期專屬品項與每天場次
  async adminImportVendorMenu(data, ctx) {
    const storeName = String(data.storeName || '').trim();
    if (!storeName) throw appError('INVALID_INPUT', '請輸入廠商名稱。');
    const entries = Array.isArray(data.entries) ? data.entries : [];
    if (!entries.length) throw appError('INVALID_INPUT', '沒有可匯入的菜單資料。');
    if (entries.length > 200) throw appError('INVALID_INPUT', '單次最多匯入 200 天。');

    const storeResult = await findOrCreateStore(ctx.classId, storeName);
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
        const itemResult = await findOrCreateMenuItem(ctx.classId, storeResult.store.id, name, num(item?.price), normalizeOptions(item.options), date);
        if (itemResult.created) createdItems += 1;
      }
      const sessionResult = await findOrCreateSession(ctx.classId, storeResult.store.id, date);
      if (sessionResult.created) createdSessions += 1;
    }
    return { ok: true, storeId: sid(storeResult.store.id), storeName: storeResult.store.name, createdItems, createdSessions };
  },
};

// ---- 每月菜單匯入輔助 ----
async function findOrCreateStore(classId, name) {
  const existing = await findOne('stores', { name, is_deleted: false }, classId);
  if (existing) return { store: existing, created: false };
  return { store: await insertRow('stores', { class_id: classId, name, sort_order: 0 }), created: true };
}

async function findOrCreateMenuItem(classId, storeId, name, price, options, menuDate = '1970-01-01') {
  const existing = await findOne('menu_items', { store_id: storeId, name, menu_date: menuDate }, classId);
  if (existing) return { item: existing, created: false };
  return { item: await insertRow('menu_items', { class_id: classId, store_id: storeId, name, price, options, menu_date: menuDate, sort_order: 0 }), created: true };
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
