// 動作：店家與菜單管理（資料夾式：店家 → 品項 → 客製選項）
import { appError, sid, num } from '../_lib/util.js';
import { findOne, listRows, insertRow, updateRows, deleteRows, listStoresForClass, listMenuItemsForStore } from '../_lib/db.js';

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
    const result = [];
    for (const store of stores) {
      const items = await listMenuItemsForStore(ctx.classId, store.id);
      result.push({
        storeId: sid(store.id),
        name: store.name,
        isActive: Boolean(store.is_active),
        items: items.map((item) => ({
          itemId: sid(item.id),
          name: item.name,
          price: num(item.price),
          options: (Array.isArray(item.options) ? item.options : []).map((option) => ({
            name: option.name,
            price: num(option.price),
          })),
          isActive: Boolean(item.is_active),
        })),
      });
    }
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
    await deleteRows('stores', { id: store.id });
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
};
