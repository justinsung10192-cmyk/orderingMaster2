/* 校務手帳風格：以清楚的任務順序、語意色彩與大觸控範圍，完成手機午餐行政流程。 */

import { getVerificationCountdown, parseVerificationPayload, passwordsMatch, refreshVerificationState, reduceScanState, resolveAuthMode, serializeTemplateChildren, summarizeCart } from './lunchDomain.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const app = $('#app');

const state = {
  token: localStorage.getItem('classLunch.token') || '',
  user: readLocal('classLunch.user'),
  developerToken: readSession('classLunch.developerToken') || '',
  developer: readSession('classLunch.developer'),
  view: 'lunch',
  authMode: 'login',
  publicConfig: { emailDomain: '' },
  sessions: [],
  orders: [],
  selectedSessionId: '',
  selectedItemId: '',
  wallet: null,
  verification: { type: 'pickup', data: null, interval: null },
  pendingVerification: null,
  orderDrafts: {},
  editingOrderId: '',
  operationPending: false,
  admin: { tab: 'dashboard', dashboard: null, selectedDate: toDateInput(new Date()), catalog: null, users: [], scanResult: null, scanError: '', scanSessionId: '', orderFilter: 'all', orderQuery: '' },
  developerUsers: [],
  developerCodes: [],
  developerSettings: null,
  developerTab: 'overview',
  scanner: null,
  scannerMode: '',
  scannerProcessing: false,
  confirmAction: null,
  countdownTimer: null,
  closedSessionIds: new Set(),
  autoRefreshTimer: null,
  push: { supported: false, subscribed: false },
  merchant: null,
  merchantToken: '',
  merchantTab: 'orders',
  merchantPendingEmail: '',
  classAdminApplication: null
};

const ICONS = {
  lunch: '⌑', verify: '▦', wallet: '¤', admin: '✓', settings: '☷'
};

document.addEventListener('click', onClick);
document.addEventListener('submit', onSubmit);
document.addEventListener('change', onChange);
document.addEventListener('input', onInput);
window.addEventListener('popstate', bootstrap);

bootstrap();

async function bootstrap() {
  state.countdownTimer = setInterval(updateLunchCountdowns, 1000);
  state.publicConfig = await loadPublicConfig();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  window.addEventListener('beforeinstallprompt', (event) => { event.preventDefault(); deferredInstallPrompt = event; renderInstallButton(); });
  startAutoRefresh();
  const savedMerchant = (() => { try { return JSON.parse(localStorage.getItem('classLunch.merchant') || 'null'); } catch (_) { return null; } })();
  if (savedMerchant && savedMerchant.token) {
    state.merchant = savedMerchant.merchant;
    state.merchantToken = savedMerchant.token;
    renderMerchantShell();
    return;
  }
  const params = new URLSearchParams(location.search);
  const resetToken = params.get('resetToken');
  const wipeToken = params.get('action') === 'wipe_data' ? params.get('token') : null;

  if (wipeToken) {
    if (!state.developerToken) {
      alert('請先以開發者身分登入後，再次點擊信件中的刪除連結。');
      state.authMode = 'developerLogin';
      renderAuth();
      return;
    }
    await busy(document.body, async () => {
      try {
        await developerApi('developerExecuteWipeData', { token: wipeToken });
        alert('系統資料已全數清空。');
        location.href = location.pathname;
      } catch (err) {
        alert(err.message || '刪除失敗或驗證碼已過期。');
        location.href = location.pathname;
      }
    });
    return;
  }

  if (resetToken) {
    state.token = '';
    state.user = null;
    state.authMode = 'reset';
    renderAuth();
    return;
  }
  if (state.developerToken && state.developer) {
    await loadDeveloperApp();
    return;
  }
  if (!state.token || !state.user) {
    state.authMode = 'login';
    renderAuth();
    return;
  }
  await loadApp();
}

async function loadPublicConfig() {
  if (!apiConfigured()) return { emailDomain: '' };
  try {
    return await api('getPublicConfig', {}, '', false);
  } catch (_) {
    return { emailDomain: '' };
  }
}

async function loadDeveloperApp() {
  try {
    renderDeveloperShell();
    await refreshDeveloperData();
  } catch (error) {
    clearDeveloperSession();
    state.authMode = 'developerLogin';
    renderAuth();
    toast(error.message, 'error');
  }
}

async function loadApp() {
  try {
    const data = await api('getBootstrap');
    state.user = data.user;
    state.sessions = data.sessions || [];
    state.orders = data.orders || [];
    localStorage.setItem('classLunch.user', JSON.stringify(state.user));
    if (!state.selectedSessionId && state.sessions.length) state.selectedSessionId = state.sessions[0].sessionId;
    renderShell();
  } catch (error) {
    clearSession();
    state.authMode = 'login';
    renderAuth();
    toast(error.message, 'error');
  }
}

function renderDeveloperShell() {
  app.innerHTML = `<div class="min-h-dvh bg-paper pb-8"><header class="safe-top sticky top-0 z-30 border-b border-ledger/10 bg-ledger px-4 pb-4 text-white shadow-paper"><div class="mx-auto flex max-w-3xl items-center justify-between"><div><p class="text-[11px] font-bold tracking-[.16em] text-blue-200">DEVELOPER CONSOLE</p><h1 class="mt-1 font-serif text-xl font-black">系統開發者工作台</h1><p class="mt-1 text-xs text-blue-100">${escapeHtml(state.developer?.username || '')} · 跨班級管理</p></div><button data-action="developer-logout" class="rounded-xl bg-white/15 px-3 py-2 text-xs font-bold text-white">登出</button></div></header><main id="developer-root" class="mx-auto max-w-3xl px-4 py-5"></main></div><div id="modal-root"></div><div id="toast-root" class="pointer-events-none fixed inset-x-0 top-4 z-[70] mx-auto flex max-w-sm flex-col gap-2 px-4"></div>`;
  renderDeveloperView();
}

async function refreshDeveloperData() {
  const [users, codes, settings] = await Promise.all([developerApi('developerListUsers'), developerApi('developerListClassAdminCodes'), developerApi('developerGetSettings')]);
  state.developerUsers = users || [];
  state.developerCodes = codes || [];
  state.developerSettings = settings || null;
  renderDeveloperView();
}

function renderDeveloperView() {
  const root = $('#developer-root'); if (!root) return;
  const activeUsers = state.developerUsers.filter(user => !user.isDisabled).length;
  const disabledUsers = state.developerUsers.length - activeUsers;
  const unusedCodes = state.developerCodes.filter(code => !code.isUsed).length;
  root.innerHTML = `<section class="view-enter space-y-5"><div class="rounded-[1.5rem] bg-white p-5 shadow-paper ring-1 ring-ledger/5"><div class="flex items-start justify-between gap-3"><div><p class="text-[11px] font-bold tracking-[.15em] text-stamp">SYSTEM OVERVIEW</p><h2 class="mt-1 font-serif text-2xl font-black text-ledger">開發者總覽</h2><p class="mt-2 text-sm leading-6 text-slate-500">集中管理班級管理者代碼與所有使用者帳號。密碼雜湊、驗證碼及開發者金鑰永不顯示。</p></div><button data-action="developer-refresh" class="rounded-xl bg-mist px-3 py-2 text-xs font-bold text-ledger">重新整理</button></div><div class="mt-5 grid grid-cols-3 gap-2"><div class="rounded-xl bg-mist px-3 py-3"><p class="text-[10px] font-bold text-slate-500">帳號總數</p><p class="mt-1 text-xl font-black tabular-nums text-ledger">${state.developerUsers.length}</p></div><div class="rounded-xl bg-mist px-3 py-3"><p class="text-[10px] font-bold text-slate-500">啟用中</p><p class="mt-1 text-xl font-black tabular-nums text-stamp">${activeUsers}</p></div><div class="rounded-xl bg-mist px-3 py-3"><p class="text-[10px] font-bold text-slate-500">待使用代碼</p><p class="mt-1 text-xl font-black tabular-nums text-apricot">${unusedCodes}</p></div></div>${disabledUsers ? `<p class="mt-3 rounded-xl bg-[#FFF6E8] px-3 py-2 text-xs text-[#805820]">目前有 ${disabledUsers} 個停用帳號。</p>` : ''}</div><div class="flex flex-wrap gap-2"><button data-action="developer-tab" data-tab="overview" class="flex-1 min-w-[86px] rounded-xl px-3 py-3 text-xs font-bold ${state.developerTab === 'overview' ? 'bg-ledger text-white' : 'bg-white text-ledger ring-1 ring-ledger/10'}">管理者代碼</button><button data-action="developer-tab" data-tab="users" class="flex-1 rounded-xl px-3 py-3 text-xs font-bold ${state.developerTab === 'users' ? 'bg-ledger text-white' : 'bg-white text-ledger ring-1 ring-ledger/10'}">所有帳號</button><button data-action="developer-tab" data-tab="settings" class="flex-1 rounded-xl px-3 py-3 text-xs font-bold ${state.developerTab === 'settings' ? 'bg-ledger text-white' : 'bg-white text-ledger ring-1 ring-ledger/10'}">系統設定</button><button data-action="developer-tab" data-tab="menu" class="flex-1 min-w-[86px] rounded-xl px-3 py-3 text-xs font-bold ${state.developerTab === 'menu' ? 'bg-ledger text-white' : 'bg-white text-ledger ring-1 ring-ledger/10'}">全體菜單</button><button data-action="developer-tab" data-tab="schools" class="flex-1 min-w-[86px] rounded-xl px-3 py-3 text-xs font-bold ${state.developerTab === 'schools' ? 'bg-ledger text-white' : 'bg-white text-ledger ring-1 ring-ledger/10'}">學校</button><button data-action="developer-tab" data-tab="applications" class="flex-1 min-w-[86px] rounded-xl px-3 py-3 text-xs font-bold ${state.developerTab === 'applications' ? 'bg-ledger text-white' : 'bg-white text-ledger ring-1 ring-ledger/10'}">申請</button><button data-action="developer-tab" data-tab="merchants" class="flex-1 min-w-[86px] rounded-xl px-3 py-3 text-xs font-bold ${state.developerTab === 'merchants' ? 'bg-ledger text-white' : 'bg-white text-ledger ring-1 ring-ledger/10'}">店家</button></div><div id="developer-content"></div></section>`;
  const content = $('#developer-content');
  if (state.developerTab === 'users') return renderDeveloperUsers(content);
  if (state.developerTab === 'settings') return renderDeveloperSettings(content);
  if (state.developerTab === 'menu') return renderDeveloperMenu(content);
  if (state.developerTab === 'schools') return renderDeveloperSchools(content);
  if (state.developerTab === 'applications') return renderDeveloperApplications(content);
  if (state.developerTab === 'merchants') return renderDeveloperMerchants(content);
  return renderDeveloperCodes(content);
}

function renderDeveloperSettings(root) {
  const maintenance = Boolean(state.developerSettings?.maintenance);
  root.innerHTML = `<div class="rounded-[1.5rem] bg-white p-5 shadow-paper"><p class="text-[11px] font-bold tracking-[.13em] text-stamp">SYSTEM OWNER SETTINGS</p><h2 class="mt-1 font-serif text-xl font-black text-ledger">開發者系統設定</h2><p class="mt-2 text-sm leading-6 text-slate-500">跨班級的系統與安全設定。各班管理者由各班在「帳號」頁自行維護。</p><section class="mt-4 rounded-xl border border-apricot/20 bg-[#FFF8EC] p-3"><p class="text-xs font-bold text-[#805820]">全服廣播通知</p><p class="mt-1 text-xs leading-5 text-slate-500">傳送自訂訊息給所有班級已開啟通知的裝置。</p><textarea id="developer-broadcast-message" maxlength="200" rows="2" class="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-ledger" placeholder="例如：明天校外教學，暫停訂餐一天。"></textarea><button type="button" data-action="developer-broadcast" class="mt-2 w-full rounded-lg bg-ledger px-3 py-2.5 text-xs font-bold text-white">傳送全服廣播</button></section><section class="mt-3 rounded-xl border border-red-100 bg-red-50/60 p-3"><p class="text-xs font-bold text-red-700">維修模式</p><p class="mt-1 text-xs leading-5 text-slate-500">開啟後，一般使用者與管理員無法登入（登入頁顯示維修中）；開發者可正常登入以關閉。</p><button type="button" data-action="developer-maintenance" data-enabled="${maintenance ? 'false' : 'true'}" class="mt-2 w-full rounded-lg px-3 py-2.5 text-xs font-bold text-white ${maintenance ? 'bg-ledger' : 'bg-red-700'}">${maintenance ? '目前維修中 · 點我恢復' : '開啟維修模式'}</button></section><section class="mt-3 rounded-xl border border-red-100 bg-red-50 p-3"><p class="text-xs font-bold text-red-700">危險區域：清空系統</p><p class="mt-1 text-xs leading-5 text-slate-500">刪除所有班級、使用者、訂單與交易（保留學校、全區菜單與開發者帳號）。需三重確認與信箱驗證。</p><button type="button" data-action="developer-wipe-data" class="mt-2 w-full rounded-lg bg-red-700 px-3 py-2.5 text-xs font-bold text-white">刪除所有資料</button></section><section class="mt-3 rounded-xl border border-apricot/20 bg-[#FFF8EC] p-3"><p class="text-xs font-bold text-[#805820]">郵件服務檢查（驗證信／重設信）</p><p id="developer-email-diagnostics" class="mt-1 text-xs leading-5 text-slate-500">檢查 Gmail SMTP 授權與寄送狀態。</p><button type="button" data-action="developer-check-email" class="mt-2 w-full rounded-lg bg-white px-3 py-2.5 text-xs font-bold text-ledger ring-1 ring-ledger/10">檢查郵件服務</button></section><section class="mt-3 rounded-xl border border-ledger/10 bg-mist/40 p-3"><p class="text-xs font-bold text-ledger">開發者帳號</p><p class="mt-1 text-xs leading-5 text-slate-500">管理開發者帳號；不能刪除自己，且系統至少保留一位開發者。</p><div id="developer-accounts" class="mt-2 space-y-2">${skeletonLines(1)}</div></section></div>`;
  loadDeveloperAccounts().catch(() => {});
}

async function renderDeveloperMenu(root) {
  root.innerHTML = `<section class="rounded-[1.5rem] bg-white p-5 shadow-paper ring-1 ring-ledger/5"><div class="flex items-start justify-between gap-3"><div><p class="text-[11px] font-bold tracking-[.13em] text-stamp">GLOBAL MENU</p><h2 class="mt-1 font-serif text-xl font-black text-ledger">全體共用菜單</h2><p class="mt-2 text-xs leading-5 text-slate-500">所有班級都可使用的店家、餐點與選項（各班仍可建立自己的菜單）。</p></div><button data-action="developer-refresh-menu" class="shrink-0 rounded-xl bg-mist px-3 py-2.5 text-xs font-bold text-ledger">重新整理</button></div><div id="developer-menu-data" class="mt-4">${skeletonLines(5)}</div></section>`;
  try {
    state.developerMenu = await developerApi('developerListMenu');
    renderDeveloperMenuData();
  } catch (error) { $('#developer-menu-data').innerHTML = errorBlock(error.message); }
}

function renderDeveloperMenuData() {
  const root = $('#developer-menu-data'); const c = state.developerMenu; if (!root || !c) return;
  root.innerHTML = `<form id="store-form-dev" class="rounded-xl bg-mist p-3"><p class="text-xs font-black text-ledger">新增全體店家</p><div class="mt-2 grid grid-cols-2 gap-2"><input name="name" required maxlength="60" class="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-ledger" placeholder="店家名稱"/><input name="contact" maxlength="120" class="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-ledger" placeholder="聯絡資訊（選填）"/></div><textarea name="description" maxlength="200" rows="2" class="mt-2 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-ledger" placeholder="店家簡介（選填）"></textarea><div class="mt-2 grid grid-cols-2 gap-2"><select name="scope" id="dev-store-scope" class="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-ledger"><option value="all">範圍：全區</option><option value="school">範圍：學校專屬</option></select><select name="schoolId" id="dev-store-school" class="hidden rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-ledger"><option value="">選擇學校…</option>${((state.developerSchools && state.developerSchools.length ? state.developerSchools : state.publicConfig?.schools) || []).map(school => `<option value="${escapeAttr(school.schoolId)}">${escapeHtml(school.name)}</option>`).join('')}</select></div><button class="mt-2 w-full rounded-lg bg-ledger px-3 py-2.5 text-xs font-bold text-white">新增店家</button></form><div class="mt-4">${c.stores.length ? c.stores.map(s => `<article class="mb-3 rounded-xl border border-slate-100 p-3"><div class="flex items-start justify-between gap-2"><div class="min-w-0"><p class="text-sm font-black">${escapeHtml(s.name)}</p>${s.description ? `<p class="mt-1 text-[11px] leading-5 text-slate-500">${escapeHtml(s.description)}</p>` : ''}${s.contact ? `<p class="mt-1 text-[11px] text-slate-500">聯絡：${escapeHtml(s.contact)}</p>` : ''}</div><div class="flex shrink-0 gap-1.5"><button type="button" data-action="developer-edit-store" data-id="${s.storeId}" class="rounded-lg bg-mist px-2.5 py-2 text-[11px] font-bold text-ledger">店家資訊</button><button type="button" data-action="developer-delete-store" data-id="${s.storeId}" class="rounded-lg bg-red-50 px-2.5 py-2 text-[11px] font-bold text-red-700">刪除</button></div></div><form id="menu-item-form-dev" class="mt-3 grid grid-cols-[1fr_70px_auto] gap-2"><input type="hidden" name="storeId" value="${s.storeId}"/><input name="name" required maxlength="80" class="min-w-0 rounded-lg border border-slate-200 px-2 py-2 text-xs outline-none focus:border-ledger" placeholder="餐點名稱"/><input name="basePrice" required type="number" min="0" class="min-w-0 rounded-lg border border-slate-200 px-2 py-2 text-xs outline-none focus:border-ledger" placeholder="價格"/><button class="rounded-lg bg-stamp px-2 text-xs font-bold text-white">新增餐點</button></form><div class="mt-3 space-y-2">${c.items.filter(i => i.storeId === s.storeId).map(i => `<div class="rounded-lg bg-paper p-2.5"><div class="flex items-start justify-between text-sm"><b>${escapeHtml(i.name)}</b><span class="shrink-0">${money(i.basePrice)} <button type="button" data-action="developer-delete-item" data-id="${i.itemId}" class="ml-1 text-[10px] font-bold text-red-700 underline">刪除</button></span></div><form id="item-option-form-dev" class="mt-2 grid grid-cols-[1fr_64px_auto] gap-2"><input type="hidden" name="itemId" value="${i.itemId}"/><input name="name" required maxlength="80" class="min-w-0 rounded-md border border-slate-200 bg-white px-2 py-1.5 text-xs outline-none focus:border-ledger" placeholder="加飯、大辣…"/><input name="priceAdjustment" required type="number" class="min-w-0 rounded-md border border-slate-200 bg-white px-2 py-1.5 text-xs outline-none focus:border-ledger" placeholder="差額"/><button class="rounded-md bg-white px-2 text-xs font-bold text-ledger ring-1 ring-ledger/10">加選項</button></form>${c.options.filter(o => o.itemId === i.itemId).length ? `<p class="mt-2 text-[11px] text-slate-500">${c.options.filter(o => o.itemId === i.itemId).map(o => `<span class="mr-1 inline-flex items-center gap-1 rounded bg-white px-1.5 py-0.5 text-[10px] ring-1 ring-ledger/10">${escapeHtml(o.name)} (${signedMoney(o.priceAdjustment)})<button type="button" data-action="developer-delete-option" data-id="${o.optionId}" class="text-red-700">✕</button></span>`).join('')}</p>` : ''}</div>`).join('') || '<p class="py-2 text-xs text-slate-500">尚未建立餐點。</p>'}</div></article>`).join('') : emptyState('先新增一間全體店家', '全體店家與餐點會出現在所有班級的菜單與場次中。')}</div>`;
}

async function submitDeveloperSave(action, form, message, rerender) {
  const data = formData(form);
  await busy(form, async () => { const result = await developerApi(action, data); toast(typeof message === 'function' ? message(result) : message, 'success'); await rerender(); });
}

function openDeveloperStoreInfoModal(storeId) {
  const store = state.developerMenu?.stores?.find(item => item.storeId === storeId);
  if (!store) return;
  openConfirmModal({
    eyebrow: 'GLOBAL STORE INFO',
    title: `店家資訊：${store.name}`,
    body: `<label class="block"><span class="mb-1.5 block text-xs font-bold text-slate-600">店家名稱</span><input id="dev-store-info-name" maxlength="60" value="${escapeAttr(store.name)}" class="w-full rounded-xl border border-slate-200 px-3 py-3 outline-none focus:border-ledger"/></label><label class="block mt-3"><span class="mb-1.5 block text-xs font-bold text-slate-600">聯絡資訊（電話／LINE，選填）</span><input id="dev-store-info-contact" maxlength="120" value="${escapeAttr(store.contact || '')}" class="w-full rounded-xl border border-slate-200 px-3 py-3 outline-none focus:border-ledger"/></label><label class="block mt-3"><span class="mb-1.5 block text-xs font-bold text-slate-600">店家簡介（選填）</span><textarea id="dev-store-info-description" maxlength="200" rows="2" class="w-full rounded-xl border border-slate-200 px-3 py-3 outline-none focus:border-ledger">${escapeHtml(store.description || '')}</textarea></label>`,
    submitLabel: '儲存店家資訊',
    onConfirm: async () => {
      const name = String($('#dev-store-info-name')?.value || '').trim();
      if (!name) throw new Error('請輸入店家名稱。');
      await developerApi('developerSaveStore', { storeId, name, description: $('#dev-store-info-description')?.value || '', contact: $('#dev-store-info-contact')?.value || '' });
      closeModal();
      await renderDeveloperMenu($('#developer-content'));
      toast('店家資訊已更新。', 'success');
    },
  });
}

function confirmDeveloperStoreDelete(storeId) {
  const store = state.developerMenu?.stores?.find(item => item.storeId === storeId);
  openConfirmModal({ eyebrow: 'DELETE GLOBAL STORE', title: `刪除全體店家「${store ? store.name : ''}」？`, body: '<p>刪除後所有班級都無法再使用這間店家；已被場次使用的店家無法刪除。</p>', submitLabel: '確認刪除', onConfirm: async () => { await developerApi('developerDeleteStore', { storeId }); closeModal(); await renderDeveloperMenu($('#developer-content')); toast('全體店家已刪除。', 'success'); } });
}

function confirmDeveloperItemDelete(itemId) {
  const item = (state.developerMenu?.items || []).find(entry => entry.itemId === itemId);
  openConfirmModal({ eyebrow: 'DELETE GLOBAL ITEM', title: `刪除餐點「${item ? item.name : ''}」？`, body: '<p>已有訂單使用的餐點會受到帳務保護而無法刪除。</p>', submitLabel: '確認刪除', onConfirm: async () => { await developerApi('developerDeleteMenuItem', { itemId }); closeModal(); await renderDeveloperMenu($('#developer-content')); toast('餐點已刪除。', 'success'); } });
}

function confirmDeveloperOptionDelete(optionId) {
  openConfirmModal({ eyebrow: 'DELETE GLOBAL OPTION', title: '刪除此客製選項？', body: '<p>已有訂單使用的選項會受到帳務保護而無法刪除。</p>', submitLabel: '確認刪除', onConfirm: async () => { await developerApi('developerDeleteItemOption', { optionId }); closeModal(); await renderDeveloperMenu($('#developer-content')); toast('選項已刪除。', 'success'); } });
}

function renderDeveloperCodes(root) {
  root.innerHTML = `<section class="rounded-[1.5rem] bg-white p-5 shadow-paper ring-1 ring-ledger/5"><div class="flex items-start justify-between gap-3"><div><p class="text-[11px] font-bold tracking-[.13em] text-stamp">CLASS ADMIN ACCESS</p><h2 class="mt-1 font-serif text-xl font-black text-ledger">班級管理者代碼</h2><p class="mt-2 text-xs leading-5 text-slate-500">產生後只顯示一次原始代碼；資料表只保存雜湊，遺失時請重新核發。</p></div><button data-action="developer-create-code" class="shrink-0 rounded-xl bg-ledger px-3 py-2.5 text-xs font-bold text-white">核發代碼</button></div><div class="mt-4 space-y-2">${state.developerCodes.length ? state.developerCodes.map(code => `<article class="rounded-xl border ${code.isUsed ? 'border-slate-100 bg-slate-50' : 'border-ledger/10 bg-mist/50'} p-3"><div class="flex items-start justify-between gap-3"><div><p class="text-sm font-black text-ledger">${escapeHtml(code.className)}</p><p class="mt-1 text-[11px] text-slate-500">建立：${formatDateTime(code.createdAt)}${code.isUsed ? ` · ${code.usedBy === 'developer-revoked' ? '已撤銷' : `已使用（${escapeHtml(code.usedBy)}）`}` : ' · 尚未使用'}</p></div>${code.isUsed ? '<span class="status-stamp rounded-md px-2 py-1 text-slate-500">不可用</span>' : `<button data-action="developer-revoke-code" data-id="${escapeAttr(code.codeId)}" class="rounded-lg bg-red-50 px-2.5 py-2 text-[11px] font-bold text-red-700">撤銷</button>`}</div></article>`).join('') : emptyState('尚未核發班級管理者代碼', '按下右上角「核發代碼」即可建立第一組代碼。')}</div></section>`;
}

function renderDeveloperUsers(root) {
  const groups = new Map();
  (state.developerUsers || []).forEach(user => {
    const key = String(user.classId || 'none');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(user);
  });
  const sections = [...groups.entries()].map(([classId, users]) => {
    const adminCount = users.filter(user => user.role === 'Admin').length;
    return `<section><div class="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-xl bg-ledger px-3 py-2 text-white"><p class="text-xs font-black">${escapeHtml(users[0].className || '未指定班級')}</p><p class="text-[10px] font-bold text-white/85">${users.length} 人 · 管理員 ${adminCount} 人</p></div><div class="mt-2 space-y-2">${users.map(user => `<article class="rounded-xl border border-ledger/10 bg-mist/40 p-3"><div class="flex items-start justify-between gap-3"><div class="min-w-0"><p class="truncate text-sm font-black ${user.isDisabled ? 'text-slate-400 line-through' : 'text-ledger'}">${escapeHtml(user.name)} <span class="font-normal text-slate-500">${user.role === 'Admin' ? '管理員' : '學生'}</span></p><p class="mt-1 truncate text-[11px] text-slate-500">${escapeHtml(user.studentNo)} · ${escapeHtml(user.email)}</p><p class="mt-1 text-[11px] ${user.emailVerified ? 'text-stamp' : 'text-apricot'}">Email ${user.emailVerified ? '已驗證' : '未驗證'} · 錢包 ${money(user.walletBalance)}${user.isDisabled ? ' · 已停用' : ''}</p></div><div class="flex shrink-0 flex-col gap-1.5"><button data-action="developer-view-user" data-id="${escapeAttr(user.id)}" class="rounded-lg bg-white px-2.5 py-2 text-[11px] font-bold text-ledger ring-1 ring-ledger/10">查看</button><button data-action="developer-toggle-user" data-id="${escapeAttr(user.id)}" data-disabled="${user.isDisabled ? 'false' : 'true'}" class="rounded-lg px-2.5 py-2 text-[11px] font-bold ${user.isDisabled ? 'bg-stamp/10 text-stamp' : 'bg-red-50 text-red-700'}">${user.isDisabled ? '恢復' : '停用'}</button><button data-action="developer-delete-user" data-id="${escapeAttr(user.id)}" class="rounded-lg bg-red-700 px-2.5 py-2 text-[11px] font-bold text-white">刪除</button></div></div></article>`).join('')}</div></section>`;
  });
  root.innerHTML = `<section class="rounded-[1.5rem] bg-white p-5 shadow-paper ring-1 ring-ledger/5"><div class="flex items-start justify-between gap-3"><div><p class="text-[11px] font-bold tracking-[.13em] text-stamp">ALL ACCOUNTS</p><h2 class="mt-1 font-serif text-xl font-black text-ledger">所有班級帳號</h2><p class="mt-2 text-xs leading-5 text-slate-500">依班級分類；可查看公開帳務摘要、停用／恢復或刪除帳號。</p></div><button data-action="developer-refresh" class="shrink-0 rounded-xl bg-mist px-3 py-2.5 text-xs font-bold text-ledger">重新整理</button></div>${sections.length ? sections.join('') : emptyState('目前沒有帳號', '班級管理者註冊後，帳號會出現在這裡。')}</section>`;
}

function renderAuth() {
  app.innerHTML = htmlFromTemplate('auth-template');
  const host = $('#auth-content');
  if (state.publicConfig?.maintenance && state.authMode !== 'developerLogin' && state.authMode !== 'developerRegister' && state.authMode !== 'developerVerify') {
    host.innerHTML = `<div class="text-center"><div class="mx-auto grid h-16 w-16 place-items-center rounded-2xl bg-red-50 text-3xl">🔧</div><h1 class="mt-4 font-serif text-2xl font-black text-ledger">系統維修中</h1><p class="mt-2 text-sm leading-6 text-slate-500">系統正在進行維護，暫時無法登入與下單。請稍後再來，謝謝。</p><button data-auth="developerLogin" class="mt-6 w-full border-t border-dashed border-ledger/15 pt-4 text-center text-xs font-bold text-slate-500 underline underline-offset-4">開發者入口</button></div>`;
    return;
  }
  if (state.authMode === 'register') host.innerHTML = renderRegisterForm();
  else if (state.authMode === 'verifyEmail') host.innerHTML = renderVerifyEmailForm();
  else if (state.authMode === 'forgot') host.innerHTML = renderForgotForm();
  else if (state.authMode === 'reset') host.innerHTML = renderResetForm();
  else if (state.authMode === 'developerLogin') host.innerHTML = renderDeveloperLoginForm();
  else if (state.authMode === 'developerRegister') host.innerHTML = renderDeveloperRegisterForm();
  else if (state.authMode === 'developerVerify') host.innerHTML = renderDeveloperVerifyForm();
  else if (state.authMode === 'classAdminApply') host.innerHTML = renderClassAdminApplyForm();
  else if (state.authMode === 'classAdminVerify') host.innerHTML = renderClassAdminVerifyForm();
  else if (state.authMode === 'merchantLogin') host.innerHTML = renderMerchantLoginForm();
  else if (state.authMode === 'merchantRegister') host.innerHTML = renderMerchantRegisterForm();
  else if (state.authMode === 'merchantVerify') host.innerHTML = renderMerchantVerifyForm();
  else host.innerHTML = renderLoginForm();
}

function renderClassAdminApplyForm() {
  return `<p class="text-[11px] font-extrabold tracking-[.15em] text-apricot">CLASS ADMIN APPLY</p><h1 class="mt-1 font-serif text-2xl font-black text-ledger">申請班級管理者代碼</h1><p class="mt-2 text-sm leading-6 text-slate-500">填寫真實資料並完成信箱驗證；審核通過後，開發者會核發一組班級管理者代碼。</p>${configNote()}<form id="class-admin-apply-form" class="task-rule mt-6 space-y-3 pt-5">${schoolSelectHtml('schoolId', false)}<label class="block"><span class="mb-1.5 block text-xs font-bold text-slate-600">真實姓名</span><input name="studentName" required maxlength="40" class="w-full rounded-xl border border-slate-200 px-3 py-3 outline-none focus:border-ledger" /></label><div class="grid grid-cols-2 gap-3"><label class="block"><span class="mb-1.5 block text-xs font-bold text-slate-600">學號</span><input name="studentNo" inputmode="numeric" required maxlength="30" class="w-full rounded-xl border border-slate-200 px-3 py-3 outline-none focus:border-ledger" /></label><label class="block"><span class="mb-1.5 block text-xs font-bold text-slate-600">班級</span><input name="className" required maxlength="40" placeholder="例如 三年甲班" class="w-full rounded-xl border border-slate-200 px-3 py-3 outline-none focus:border-ledger" /></label></div><label class="block"><span class="mb-1.5 block text-xs font-bold text-slate-600">聯絡電話</span><input name="contactPhone" type="tel" inputmode="tel" required maxlength="20" class="w-full rounded-xl border border-slate-200 px-3 py-3 outline-none focus:border-ledger" placeholder="09xxxxxxxx" /></label><label class="block"><span class="mb-1.5 block text-xs font-bold text-slate-600">電子郵件（接收驗證碼）</span><input name="email" type="email" required maxlength="120" class="w-full rounded-xl border border-slate-200 px-3 py-3 outline-none focus:border-ledger" /></label><button class="w-full rounded-xl bg-ledger px-4 py-3.5 text-sm font-bold text-white shadow-paper" type="submit">送出申請並寄驗證碼</button></form><div class="mt-5 flex justify-between text-sm"><button data-auth="login" class="font-bold text-ledger underline underline-offset-4">←回到登入</button></div>`;
}

function renderClassAdminVerifyForm() {
  const prefilledEmail = String(state.classAdminApplication?.email || '');
  return `<p class="text-[11px] font-extrabold tracking-[.15em] text-apricot">CLASS ADMIN APPLY · VERIFY</p><h1 class="mt-1 font-serif text-2xl font-black text-ledger">驗證申請信箱</h1><p class="mt-2 text-sm leading-6 text-slate-500">6位數驗證碼已寄到申請信箱（15分鐘內有效）。</p>${configNote()}<form id="class-admin-verify-form" class="task-rule mt-6 space-y-3 pt-5"><label class="block"><span class="mb-1.5 block text-xs font-bold text-slate-600">申請信箱</span><input name="email" type="email" required value="${escapeAttr(prefilledEmail)}" class="w-full rounded-xl border border-slate-200 px-3 py-3 outline-none focus:border-ledger" /></label><label class="block"><span class="mb-1.5 block text-xs font-bold text-slate-600">6位數驗證碼</span><input name="code" inputmode="numeric" required pattern="[0-9]{6}" maxlength="6" class="w-full rounded-xl border border-slate-200 px-3 py-3 text-center font-serif text-2xl font-black tracking-[.35em] outline-none focus:border-ledger" /></label><button class="w-full rounded-xl bg-ledger px-4 py-3.5 text-sm font-bold text-white shadow-paper" type="submit">驗證並送出申請</button></form><div class="mt-5 flex justify-between text-sm"><button data-auth="classAdminApply" class="font-bold text-apricot underline underline-offset-4">重新填寫申請</button><button data-auth="login" class="font-bold text-ledger underline underline-offset-4">←回到登入</button></div>`;
}

function renderMerchantLoginForm() {
  return `<p class="text-[11px] font-extrabold tracking-[.15em] text-stamp">MERCHANT PARTNER</p><h1 class="mt-1 font-serif text-2xl font-black text-ledger">店家工作台登入</h1><p class="mt-2 text-sm leading-6 text-slate-500">店家合作夥伴請用登記的 Email 登入，查看訂單與管理菜單。</p>${configNote()}<form id="merchant-login-form" class="task-rule mt-6 space-y-4 pt-5"><label class="block"><span class="mb-1.5 block text-xs font-bold text-slate-600">Email</span><input name="email" type="email" autocomplete="username" required class="w-full rounded-xl border border-slate-200 px-3 py-3 outline-none focus:border-ledger" /></label><label class="block"><span class="mb-1.5 block text-xs font-bold text-slate-600">密碼</span><input name="password" type="password" autocomplete="current-password" required class="w-full rounded-xl border border-slate-200 px-3 py-3 outline-none focus:border-ledger" /></label><button class="w-full rounded-xl bg-stamp px-4 py-3.5 text-sm font-bold text-white shadow-paper" type="submit">登入店家工作台</button></form><div class="mt-5 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-sm"><button data-auth="merchantRegister" class="font-bold text-apricot underline underline-offset-4">註冊店家帳號</button><button data-auth="merchantVerify" class="font-bold text-[#A45A13] underline underline-offset-4">輸入信箱驗證碼</button><button data-auth="login" class="font-bold text-ledger underline underline-offset-4">←回到一般登入</button></div>`;
}

function renderMerchantRegisterForm() {
  return `<p class="text-[11px] font-extrabold tracking-[.15em] text-stamp">MERCHANT SIGNUP</p><h1 class="mt-1 font-serif text-2xl font-black text-ledger">店家合作註冊</h1><p class="mt-2 text-sm leading-6 text-slate-500">完成註冊後會寄出信箱驗證碼；「店家授權碼」可交給班級管理者綁定店家，或提供開發者協助設定菜單。</p>${configNote()}<form id="merchant-register-form" class="task-rule mt-5 space-y-3 pt-5"><label class="block"><span class="mb-1.5 block text-xs font-bold text-slate-600">店家名稱</span><input name="merchantName" required maxlength="60" class="w-full rounded-xl border border-slate-200 px-3 py-3 outline-none focus:border-ledger" /></label><label class="block"><span class="mb-1.5 block text-xs font-bold text-slate-600">店家地址</span><input name="address" maxlength="160" class="w-full rounded-xl border border-slate-200 px-3 py-3 outline-none focus:border-ledger" /></label><div class="grid grid-cols-2 gap-3"><label class="block"><span class="mb-1.5 block text-xs font-bold text-slate-600">店家電話</span><input name="phone" type="tel" maxlength="20" class="w-full rounded-xl border border-slate-200 px-3 py-3 outline-none focus:border-ledger" /></label><label class="block"><span class="mb-1.5 block text-xs font-bold text-slate-600">負責人手機</span><input name="ownerPhone" type="tel" required maxlength="20" class="w-full rounded-xl border border-slate-200 px-3 py-3 outline-none focus:border-ledger" /></label></div><label class="block"><span class="mb-1.5 block text-xs font-bold text-slate-600">負責人姓名</span><input name="ownerName" required maxlength="40" class="w-full rounded-xl border border-slate-200 px-3 py-3 outline-none focus:border-ledger" /></label><label class="block"><span class="mb-1.5 block text-xs font-bold text-slate-600">Email（登入帳號）</span><input name="email" type="email" required maxlength="120" class="w-full rounded-xl border border-slate-200 px-3 py-3 outline-none focus:border-ledger" /></label><label class="block"><span class="mb-1.5 block text-xs font-bold text-slate-600">密碼</span><input name="password" type="password" autocomplete="new-password" minlength="8" required class="w-full rounded-xl border border-slate-200 px-3 py-3 outline-none focus:border-ledger" placeholder="至少 8 個字元" /></label><label class="block"><span class="mb-1.5 block text-xs font-bold text-slate-600">確認密碼</span><input name="confirmPassword" type="password" autocomplete="new-password" minlength="8" required class="w-full rounded-xl border border-slate-200 px-3 py-3 outline-none focus:border-ledger" placeholder="再輸入一次密碼" /></label><button class="w-full rounded-xl bg-stamp px-4 py-3.5 text-sm font-bold text-white shadow-paper" type="submit">註冊並寄驗證碼</button></form><div class="mt-5 flex justify-between text-sm"><button data-auth="merchantLogin" class="font-bold text-ledger underline underline-offset-4">←回到店家登入</button></div>`;
}

function renderMerchantVerifyForm() {
  const prefilledEmail = String(state.merchantPendingEmail || '');
  return `<p class="text-[11px] font-extrabold tracking-[.15em] text-stamp">MERCHANT VERIFY</p><h1 class="mt-1 font-serif text-2xl font-black text-ledger">驗證店家信箱</h1><p class="mt-2 text-sm leading-6 text-slate-500">6位數驗證碼已寄到你的 Email（15分鐘內有效）。</p>${configNote()}<form id="merchant-verify-form" class="task-rule mt-6 space-y-3 pt-5"><label class="block"><span class="mb-1.5 block text-xs font-bold text-slate-600">Email</span><input name="email" type="email" required value="${escapeAttr(prefilledEmail)}" class="w-full rounded-xl border border-slate-200 px-3 py-3 outline-none focus:border-ledger" /></label><label class="block"><span class="mb-1.5 block text-xs font-bold text-slate-600">6位數驗證碼</span><input name="code" inputmode="numeric" required pattern="[0-9]{6}" maxlength="6" class="w-full rounded-xl border border-slate-200 px-3 py-3 text-center font-serif text-2xl font-black tracking-[.35em] outline-none focus:border-ledger" /></label><button class="w-full rounded-xl bg-stamp px-4 py-3.5 text-sm font-bold text-white shadow-paper" type="submit">驗證並前往登入</button></form><div class="mt-5 flex justify-between text-sm"><button data-auth="merchantRegister" class="font-bold text-apricot underline underline-offset-4">重新註冊</button><button data-auth="merchantLogin" class="font-bold text-ledger underline underline-offset-4">←回到店家登入</button></div>`;
}

function schoolSelectHtml(name = 'schoolId', required = true) {
  const schools = state.publicConfig?.schools || [];
  if (!schools.length) return '';
  return `<label class="block"><span class="mb-1.5 block text-xs font-bold text-slate-600">學校</span><select name="${name}" ${required ? 'required' : ''} class="w-full rounded-xl border border-slate-200 bg-white px-3 py-3 text-sm outline-none focus:border-ledger"><option value="">選擇學校…</option>${schools.map(school => `<option value="${escapeAttr(school.schoolId)}">${escapeHtml(school.name)}</option>`).join('')}</select></label>`;
}

function renderLoginForm() {
  return `
    <p class="text-[11px] font-extrabold tracking-[.15em] text-ledger">LUNCH LEDGER · 01</p>
    <h1 class="mt-1 font-serif text-2xl font-black text-ledger">登入，查看今天的待辦</h1>
    <p class="mt-2 text-sm leading-6 text-slate-500">用學號登入，訂餐、錢包與取餐憑證都會在這裡。</p>
    ${configNote()}
    <form id="login-form" class="task-rule mt-6 space-y-4 pt-5">
      ${schoolSelectHtml()}
      <label class="block"><span class="mb-1.5 block text-xs font-bold text-slate-600">學號</span><input name="studentNo" inputmode="numeric" autocomplete="username" required class="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 outline-none transition focus:border-ledger focus:ring-4 focus:ring-ledger/10" placeholder="例如 1130001" /></label>
      <label class="block"><span class="mb-1.5 block text-xs font-bold text-slate-600">密碼</span><input name="password" type="password" autocomplete="current-password" required class="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 outline-none transition focus:border-ledger focus:ring-4 focus:ring-ledger/10" placeholder="輸入你的密碼" /></label>
      <button class="w-full rounded-xl bg-ledger px-4 py-3.5 text-sm font-bold text-white shadow-paper transition hover:bg-ledger/90" type="submit">登入並開啟午餐手帳</button>
    </form>
    <div class="mt-5 flex flex-wrap items-center justify-between gap-x-4 gap-y-3 text-sm"><button data-auth="forgot" class="font-bold text-ledger underline underline-offset-4">忘記密碼</button><button data-auth="verifyEmail" class="font-bold text-apricot underline underline-offset-4">輸入信箱驗證碼</button><button data-auth="register" class="font-bold text-stamp underline underline-offset-4">註冊帳號</button><button data-auth="classAdminApply" class="font-bold text-apricot underline underline-offset-4">申請管理者代碼</button><button data-auth="merchantLogin" class="font-bold text-[#A45A13] underline underline-offset-4">店家合作</button></div></div><button data-auth="developerLogin" class="mt-5 w-full border-t border-dashed border-ledger/15 pt-4 text-center text-xs font-bold text-slate-500 underline underline-offset-4">開發者入口</button>`;
}

function renderDeveloperLoginForm() {
  return `<p class="text-[11px] font-extrabold tracking-[.15em] text-apricot">DEVELOPER CONSOLE</p><h1 class="mt-1 font-serif text-2xl font-black text-ledger">開發者登入</h1><p class="mt-2 text-sm leading-6 text-slate-500">開發者可管理所有班級、核發管理者代碼及處理帳號狀態。</p>${configNote()}<form id="developer-login-form" class="task-rule mt-6 space-y-4 pt-5"><label class="block"><span class="mb-1.5 block text-xs font-bold text-slate-600">開發者帳號</span><input name="username" autocomplete="username" required class="w-full rounded-xl border border-slate-200 px-4 py-3 outline-none focus:border-ledger" /></label><label class="block"><span class="mb-1.5 block text-xs font-bold text-slate-600">密碼</span><input name="password" type="password" autocomplete="current-password" required class="w-full rounded-xl border border-slate-200 px-4 py-3 outline-none focus:border-ledger" /></label><button class="w-full rounded-xl bg-ledger px-4 py-3.5 text-sm font-bold text-white shadow-paper" type="submit">登入開發者工作台</button></form><div class="mt-5 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-sm"><button data-auth="developerRegister" class="font-bold text-apricot underline underline-offset-4">註冊開發者帳號</button><button data-auth="developerVerify" class="font-bold text-[#A45A13] underline underline-offset-4">輸入信箱驗證碼</button><button data-auth="login" class="font-bold text-ledger underline underline-offset-4">回到一般登入</button></div>`;
}

function renderDeveloperRegisterForm() {
  return `<p class="text-[11px] font-extrabold tracking-[.15em] text-apricot">DEVELOPER ACTIVATION</p><h1 class="mt-1 font-serif text-2xl font-black text-ledger">開通開發者帳號</h1><p class="mt-2 text-sm leading-6 text-slate-500">請輸入開發者金鑰建立開發者帳號。金鑰不會儲存在前端。</p>${configNote()}<form id="developer-register-form" class="task-rule mt-5 space-y-3 pt-5"><label class="block"><span class="mb-1.5 block text-xs font-bold text-slate-600">開發者帳號</span><input name="username" autocomplete="username" pattern="[A-Za-z0-9._-]{3,40}" required class="w-full rounded-xl border border-slate-200 px-3 py-3 outline-none focus:border-ledger" /></label><label class="block"><span class="mb-1.5 block text-xs font-bold text-slate-600">電子郵件</span><input name="email" type="email" autocomplete="email" required class="w-full rounded-xl border border-slate-200 px-3 py-3 outline-none focus:border-ledger" /></label><label class="block"><span class="mb-1.5 block text-xs font-bold text-slate-600">密碼</span><input name="password" type="password" minlength="8" autocomplete="new-password" required class="w-full rounded-xl border border-slate-200 px-3 py-3 outline-none focus:border-ledger" /></label><label class="block"><span class="mb-1.5 block text-xs font-bold text-slate-600">開發者金鑰</span><input name="activationKey" type="password" autocomplete="off" required class="w-full rounded-xl border border-slate-200 px-3 py-3 outline-none focus:border-ledger" /></label><button class="w-full rounded-xl bg-ledger px-4 py-3.5 text-sm font-bold text-white shadow-paper" type="submit">驗證金鑰並建立帳號</button></form><button data-auth="developerLogin" class="mt-5 text-sm font-bold text-ledger underline underline-offset-4">← 回到開發者登入</button>`;
}

function renderDeveloperVerifyForm() {
  return `<p class="text-[11px] font-extrabold tracking-[.15em] text-apricot">DEVELOPER VERIFY</p><h1 class="mt-1 font-serif text-2xl font-black text-ledger">驗證開發者信箱</h1><p class="mt-2 text-sm leading-6 text-slate-500">6 位數驗證碼已寄到你的信箱（15 分鐘內有效），驗證完成後才能登入開發者工作台。</p>${configNote()}<form id="developer-verify-form" class="task-rule mt-6 space-y-4 pt-5"><label class="block"><span class="mb-1.5 block text-xs font-bold text-slate-600">開發者帳號</span><input name="username" autocomplete="username" required class="w-full rounded-xl border border-slate-200 px-4 py-3 outline-none focus:border-ledger" /></label><label class="block"><span class="mb-1.5 block text-xs font-bold text-slate-600">6 位數驗證碼</span><input name="code" inputmode="numeric" autocomplete="one-time-code" required pattern="[0-9]{6}" maxlength="6" class="w-full rounded-xl border border-slate-200 px-4 py-3 text-center font-serif text-2xl font-black tracking-[.35em] outline-none focus:border-ledger" placeholder="000000" /></label><button class="w-full rounded-xl bg-ledger px-4 py-3.5 text-sm font-bold text-white shadow-paper" type="submit">驗證並前往登入</button></form><button type="button" data-action="developer-resend-verify" class="mt-3 w-full rounded-xl bg-mist px-4 py-3 text-sm font-bold text-ledger">重寄驗證碼</button><div class="mt-4 flex justify-between text-sm"><button data-auth="developerRegister" class="font-bold text-apricot underline underline-offset-4">重新註冊</button><button data-auth="developerLogin" class="font-bold text-ledger underline underline-offset-4">← 回到開發者登入</button></div>`;
}

function renderRegisterForm() {
  return `
    <p class="text-[11px] font-extrabold tracking-[.15em] text-ledger">NEW ACCOUNT · 01</p>
    <h1 class="mt-1 font-serif text-2xl font-black text-ledger">建立你的午餐手帳</h1>
    <p class="mt-2 text-sm leading-6 text-slate-500">學號是登入帳號；請填寫一般電子郵件接收驗證碼、密碼重設與班級通知。</p>
    ${configNote()}
    <form id="register-form" class="task-rule mt-5 space-y-3 pt-5">
      <div class="grid grid-cols-[1.5fr_1fr] gap-3"><label class="block"><span class="mb-1.5 block text-xs font-bold text-slate-600">學號（登入帳號）</span><input name="studentNo" inputmode="numeric" autocomplete="username" required pattern="[0-9]{3,30}" class="w-full rounded-xl border border-slate-200 px-3 py-3 outline-none focus:border-ledger" /></label><label class="block"><span class="mb-1.5 block text-xs font-bold text-slate-600">座號</span><input name="seatNo" inputmode="numeric" required maxlength="10" class="w-full rounded-xl border border-slate-200 px-3 py-3 outline-none focus:border-ledger" /></label></div>
      <label class="block"><span class="mb-1.5 block text-xs font-bold text-slate-600">真實姓名</span><input name="name" autocomplete="name" required maxlength="40" class="w-full rounded-xl border border-slate-200 px-3 py-3 outline-none focus:border-ledger" /></label>
      <label class="block"><span class="mb-1.5 block text-xs font-bold text-slate-600">電子郵件</span><input name="email" type="email" autocomplete="email" required maxlength="120" class="w-full rounded-xl border border-slate-200 px-3 py-3 outline-none focus:border-ledger" /></label>
      <label class="block"><span class="mb-1.5 block text-xs font-bold text-slate-600">密碼</span><input name="password" type="password" autocomplete="new-password" minlength="8" required class="w-full rounded-xl border border-slate-200 px-3 py-3 outline-none focus:border-ledger" placeholder="至少 8 個字元" /></label>
      <label class="block"><span class="mb-1.5 block text-xs font-bold text-slate-600">再次確認密碼</span><input name="confirmPassword" type="password" autocomplete="new-password" minlength="8" required class="w-full rounded-xl border border-slate-200 px-3 py-3 outline-none focus:border-ledger" /></label>
      <label class="block"><span class="mb-1.5 block text-xs font-bold text-slate-600">邀請碼（一般使用者）</span><input name="inviteCode" autocomplete="off" class="w-full rounded-xl border border-slate-200 px-3 py-3 outline-none focus:border-ledger" placeholder="由班級管理者提供" /></label>
      <label class="block"><span class="mb-1.5 block text-xs font-bold text-slate-600">班級管理者代碼（管理者）</span><input name="classAdminCode" autocomplete="off" class="w-full rounded-xl border border-slate-200 px-3 py-3 outline-none focus:border-ledger" placeholder="只有管理者註冊時填寫" /></label>
      <p class="rounded-xl bg-mist px-3 py-2.5 text-xs leading-5 text-slate-500">一般使用者填邀請碼；建立新班級的第一位管理者填管理者代碼，兩者擇一。</p>
      <button class="mt-2 w-full rounded-xl bg-ledger px-4 py-3.5 text-sm font-bold text-white shadow-paper disabled:cursor-not-allowed disabled:opacity-60" type="submit">建立帳號並寄送驗證碼</button>
    </form>
    <button data-auth="login" class="mt-5 text-sm font-bold text-ledger underline underline-offset-4">← 回到登入</button>`;
}

function renderVerifyEmailForm() {
  const pending = state.pendingVerification || {};
  return `
    <p class="text-[11px] font-extrabold tracking-[.15em] text-apricot">EMAIL VERIFICATION</p>
    <h1 class="mt-1 font-serif text-2xl font-black text-ledger">驗證校務信箱</h1>
    <p class="mt-2 text-sm leading-6 text-slate-500">請輸入寄到 <b>${escapeHtml(pending.email || '你的校務信箱')}</b> 的 6 位數驗證碼。驗證完成後才可以登入。</p>
    ${configNote()}
    <form id="verify-email-form" class="task-rule mt-6 space-y-4 pt-5">
      <label class="block"><span class="mb-1.5 block text-xs font-bold text-slate-600">學號</span><input name="studentNo" inputmode="numeric" required pattern="[0-9]{3,30}" value="${escapeAttr(pending.studentNo || '')}" class="w-full rounded-xl border border-slate-200 px-4 py-3 outline-none focus:border-ledger" /></label>
      <label class="block"><span class="mb-1.5 block text-xs font-bold text-slate-600">6 位數驗證碼</span><input name="code" inputmode="numeric" autocomplete="one-time-code" required pattern="[0-9]{6}" maxlength="6" class="w-full rounded-xl border border-slate-200 px-4 py-3 text-center font-serif text-2xl font-black tracking-[.35em] outline-none focus:border-ledger" placeholder="000000" /></label>
      <button class="w-full rounded-xl bg-ledger px-4 py-3.5 text-sm font-bold text-white shadow-paper disabled:cursor-not-allowed disabled:opacity-60" type="submit">確認驗證</button>
    </form>
    <form id="resend-verification-form" class="mt-3"><input type="hidden" name="studentNo" value="${escapeAttr(pending.studentNo || '')}"/><button class="w-full rounded-xl bg-mist px-4 py-3 text-sm font-bold text-ledger disabled:cursor-not-allowed disabled:opacity-60" type="submit">重新寄送驗證碼</button></form>
    <button data-auth="login" class="mt-5 text-sm font-bold text-ledger underline underline-offset-4">← 回到登入</button>`;
}

function renderForgotForm() {
  return `
    <p class="text-[11px] font-extrabold tracking-[.15em] text-apricot">PASSWORD RESET</p>
    <h1 class="mt-1 font-serif text-2xl font-black text-ledger">取回登入密碼</h1>
    <p class="mt-2 text-sm leading-6 text-slate-500">輸入學號後，系統會把 15 分鐘有效的重設連結寄到你的校務信箱。</p>
    ${configNote()}
    <form id="forgot-form" class="task-rule mt-6 space-y-4 pt-5"><label class="block"><span class="mb-1.5 block text-xs font-bold text-slate-600">學號</span><input name="studentNo" inputmode="numeric" required class="w-full rounded-xl border border-slate-200 px-4 py-3 outline-none focus:border-ledger" /></label><button class="w-full rounded-xl bg-ledger px-4 py-3.5 text-sm font-bold text-white" type="submit">寄送重設連結</button></form>
    <button data-auth="login" class="mt-5 text-sm font-bold text-ledger underline underline-offset-4">← 回到登入</button>`;
}

function renderResetForm() {
  return `
    <p class="text-[11px] font-extrabold tracking-[.15em] text-apricot">RESET LINK</p>
    <h1 class="mt-1 font-serif text-2xl font-black text-ledger">設定新密碼</h1>
    <p class="mt-2 text-sm leading-6 text-slate-500">此連結只有 15 分鐘有效。新密碼至少要有 8 個字元。</p>
    ${configNote()}
    <form id="reset-form" class="task-rule mt-6 space-y-4 pt-5"><label class="block"><span class="mb-1.5 block text-xs font-bold text-slate-600">新密碼</span><input name="password" type="password" autocomplete="new-password" minlength="8" required class="w-full rounded-xl border border-slate-200 px-4 py-3 outline-none focus:border-ledger" /></label><label class="block"><span class="mb-1.5 block text-xs font-bold text-slate-600">確認新密碼</span><input name="confirmPassword" type="password" autocomplete="new-password" minlength="8" required class="w-full rounded-xl border border-slate-200 px-4 py-3 outline-none focus:border-ledger" /></label><button class="w-full rounded-xl bg-ledger px-4 py-3.5 text-sm font-bold text-white" type="submit">更新密碼</button></form>`;
}

function renderShell() {
  clearVerificationTimer();
  app.innerHTML = htmlFromTemplate('shell-template');
  $('#avatar').textContent = initial(state.user.name);
  $('#header-wallet').textContent = money(state.user.walletBalance);
  $('#header-subtitle').textContent = state.user.role === 'Admin' ? '管理員工作台已啟用' : '我的午餐手帳';
  if (!apiConfigured()) {
    $('#api-banner').classList.remove('hidden');
    $('#api-banner').innerHTML = `<div class="rounded-xl border border-apricot/30 bg-[#FFF6E8] px-4 py-3 text-xs leading-5 text-[#885A1C]"><b>尚未設定後端：</b>請在 <code>client/index.html</code> 的 <code>LUNCH_CONFIG.apiUrl</code> 填入已部署的 Google Apps Script Web App URL。介面可以預覽，但資料不會寫入。</div>`;
  }
  renderNav();
  renderView();
}

function renderNav() {
  const items = [
    ['lunch', '訂餐'], ['verify', '憑證'], ['wallet', '錢包'],
    ...(state.user.role === 'Admin' ? [['admin', '管理']] : []), ['settings', '設定']
  ];
  $('#main-nav').innerHTML = items.map(([view, label]) => `
    <button data-nav="${view}" class="flex min-w-[58px] flex-col items-center gap-1 rounded-xl px-2 py-1.5 text-[10px] font-bold transition ${state.view === view ? 'bg-ledger text-white shadow-sm' : 'text-slate-500'}">
      <span class="grid h-5 place-items-center text-base leading-none">${ICONS[view]}</span><span>${label}</span>
    </button>`).join('');
}

function renderView() {
  if (!state.user) return;
  const scrollY = window.scrollY; // 記錄捲動位置，防止背景更新時頁面跳動
  const root = $('#view');
  const templateName = state.view === 'lunch' ? 'lunch-view' : state.view === 'verify' ? 'verify-view' : state.view === 'wallet' ? 'wallet-view' : state.view === 'admin' ? 'admin-view' : 'settings-view';
  root.innerHTML = htmlFromTemplate(templateName);
  if (state.view === 'lunch') renderLunch();
  if (state.view === 'verify') renderVerification();
  if (state.view === 'wallet') renderWallet();
  if (state.view === 'admin') renderAdmin();
  if (state.view === 'settings') renderSettings();
  window.scrollTo(0, scrollY); // 恢復捲動位置
}

function renderLunch() {
  const todayOrder = state.orders.find(o => o.orderDate === toDateInput(new Date()));
  $('#lunch-greeting').textContent = `${state.user.name}，午餐安排好了嗎？`;
  $('#lunch-summary').textContent = todayOrder ? `你今天已選擇「${todayOrder.itemName}」，可隨時在憑證頁出示取餐 QR。` : '瀏覽開放中的日期，提前把午餐待辦勾起來。';
  const sessions = state.sessions;
  const tabs = $('#session-tabs');
  if (!sessions.length) {
    tabs.innerHTML = '';
    $('#lunch-content').innerHTML = emptyState('目前沒有開放中的訂餐日期', '請留意管理員後續開放的場次。');
    return;
  }
  if (!sessions.some(s => s.sessionId === state.selectedSessionId)) state.selectedSessionId = sessions[0].sessionId;
  tabs.innerHTML = sessions.map(s => {
    const selected = s.sessionId === state.selectedSessionId;
    const date = new Date(s.orderDate + 'T12:00:00');
    return `<button data-action="select-session" data-id="${s.sessionId}" class="min-w-28 shrink-0 rounded-xl border px-3 py-2 text-left transition ${selected ? 'border-ledger bg-ledger text-white shadow-paper' : 'border-ledger/10 bg-white text-ledger'}"><span class="block text-[10px] font-bold ${selected ? 'text-blue-200' : 'text-slate-500'}">${weekDay(date)} · ${date.getMonth() + 1}/${date.getDate()}</span><span class="mt-0.5 block truncate text-sm font-black">${escapeHtml(s.storeName)}</span><span class="mt-0.5 block text-[10px] ${selected ? 'text-blue-100' : 'text-slate-500'}">截止 ${formatDateTime(s.cutoffTime)}</span></button>`;
  }).join('');
  const session = sessions.find(s => s.sessionId === state.selectedSessionId);
  $('#lunch-content').innerHTML = session.existingOrder && state.editingOrderId !== session.existingOrder.orderId ? renderExistingOrder(session) : renderMultiOrderForm(session);
}

function renderExistingOrder(session) {
  const order = session.existingOrder;
  const payment = paymentBadge(order.paymentStatus);
  const pickup = pickupBadge(order.pickupStatus);
  const items = order.items?.length ? order.items : [{ itemName: order.itemName, quantity: order.quantity || 1, selectedOptions: order.selectedOptions || [] }];
  const editable = orderCanBeChanged(session, order);
  return `<article class="binder-edge overflow-hidden rounded-[1.5rem] bg-white px-7 py-6 shadow-paper ring-1 ring-ledger/5"><p class="text-[11px] font-bold tracking-[.13em] text-stamp">ORDER RECORDED</p><div class="mt-2 flex items-start justify-between gap-3"><div><h2 class="font-serif text-xl font-black">已完成訂餐</h2><p class="mt-1 text-sm text-slate-500">${escapeHtml(session.storeName)} · ${formatDate(session.orderDate)} · 共 ${order.quantity || items.reduce((sum, item) => sum + Number(item.quantity || 1), 0)} 份</p></div><b class="text-xl text-ledger tabular-nums">${money(order.totalPrice)}</b></div><div class="mt-4 space-y-2">${items.map(item => `<div class="rounded-xl bg-mist px-3 py-2.5"><p class="text-sm font-black text-ledger">${escapeHtml(item.itemName)}${Number(item.quantity || 1) > 1 ? ` × ${Number(item.quantity)}` : ''}</p>${item.selectedOptions?.length ? `<p class="mt-1 text-xs text-slate-500">${item.selectedOptions.map(option => `${escapeHtml(option.name)} ${signedMoney(option.priceAdjustment)}`).join('、')}</p>` : ''}</div>`).join('')}</div>${order.outstandingAmount > 0 ? `<p class="mt-3 rounded-xl bg-[#FFF8EC] px-3 py-2 text-xs leading-5 text-[#805820]">尚有現金未繳：${money(order.outstandingAmount)}</p>` : ''}${order.note ? `<p class="mt-3 rounded-xl bg-[#FFF8EC] px-3 py-2 text-xs leading-5 text-[#805820]">備註：${escapeHtml(order.note)}</p>` : ''}<div class="mt-5 flex gap-2">${payment}${pickup}</div><div class="mt-4"><button data-action="copy-my-order" data-session-id="${session.sessionId}" class="w-full rounded-xl bg-mist px-3 py-3 text-sm font-bold text-ledger">複製訂單文字（分享給家人）</button></div>${editable ? `<div class="mt-5 grid grid-cols-2 gap-2 border-t border-slate-100 pt-4"><button data-action="edit-own-order" data-session-id="${session.sessionId}" data-order-id="${order.orderId}" class="rounded-xl bg-ledger px-3 py-3 text-sm font-bold text-white">修改訂單</button><button data-action="delete-own-order" data-order-id="${order.orderId}" class="rounded-xl bg-red-50 px-3 py-3 text-sm font-bold text-red-700">取消訂單</button></div><p class="mt-3 text-xs leading-5 text-slate-500">截止前可調整餐點、數量與備註，或取消本場次訂單。</p>` : `<p class="mt-5 border-t border-slate-100 pt-4 text-xs leading-5 text-slate-500">此訂單已截止、已取餐或已現金結清，不能再自行修改。</p>`}</article>`;
}

function renderOrderForm(session) {
  const items = session.menuItems || [];
  if (!items.length) return emptyState('本場次尚未設定餐點', '請通知管理員在店家菜單中新增項目。');
  if (!state.selectedItemId || !items.some(i => i.itemId === state.selectedItemId)) state.selectedItemId = items[0].itemId;
  const item = items.find(i => i.itemId === state.selectedItemId);
  return `<form id="order-form" data-session-id="${session.sessionId}" class="space-y-4"><article class="binder-edge overflow-hidden rounded-[1.5rem] bg-white px-7 py-6 shadow-paper ring-1 ring-ledger/5"><div class="flex items-start justify-between gap-3"><div><p class="text-[11px] font-bold tracking-[.13em] text-slate-500">${escapeHtml(session.storeName)}</p><h2 class="mt-1 font-serif text-xl font-black">${formatDate(session.orderDate)} 的午餐</h2></div><span class="rounded-lg bg-[#FFF6E8] px-2.5 py-1.5 text-[10px] font-bold text-[#885A1C]">${session.paymentMode === 'Stored-value Only' ? '僅限儲值金' : '混合支付'}</span></div><p class="mt-3 border-l-2 border-apricot pl-3 text-xs leading-5 text-slate-500">截止時間：<b class="text-ledger">${formatDateTime(session.cutoffTime)}</b></p></article><article class="rounded-[1.5rem] bg-white p-5 shadow-paper ring-1 ring-ledger/5"><h3 class="font-serif text-lg font-black">先選一份主餐</h3><div class="mt-4 space-y-2">${items.map(i => `<label class="flex cursor-pointer items-center justify-between rounded-xl border p-3 transition ${i.itemId === item.itemId ? 'border-ledger bg-mist' : 'border-slate-100'}"><span class="flex items-center gap-3"><input class="h-4 w-4 accent-ledger" type="radio" name="itemId" value="${i.itemId}" ${i.itemId === item.itemId ? 'checked' : ''}/><span class="text-sm font-bold">${escapeHtml(i.name)}</span></span><b class="text-sm tabular-nums text-ledger">${money(i.basePrice)}</b></label>`).join('')}</div></article><article class="rounded-[1.5rem] bg-white p-5 shadow-paper ring-1 ring-ledger/5"><div class="flex items-end justify-between"><h3 class="font-serif text-lg font-black">客製選項</h3><p class="text-xs text-slate-500">可複選</p></div><div class="mt-4 space-y-2">${item.options.length ? item.options.map(o => `<label class="flex cursor-pointer items-center justify-between rounded-xl border border-slate-100 px-3 py-3"><span class="flex items-center gap-3"><input class="h-4 w-4 rounded accent-ledger" type="checkbox" name="optionId" value="${o.optionId}" data-price="${o.priceAdjustment}"/><span class="text-sm font-medium">${escapeHtml(o.name)}</span></span><b class="text-xs tabular-nums ${o.priceAdjustment > 0 ? 'text-apricot' : 'text-stamp'}">${signedMoney(o.priceAdjustment)}</b></label>`).join('') : '<p class="rounded-xl bg-mist px-3 py-3 text-sm text-slate-500">此主餐沒有額外選項。</p>'}</div><label class="mt-4 block"><span class="mb-1.5 block text-xs font-bold text-slate-600">備註</span><textarea name="note" maxlength="200" rows="2" class="w-full resize-none rounded-xl border border-slate-200 px-3 py-3 text-sm outline-none focus:border-ledger" placeholder="例如：不要蔥、餐點分開裝"></textarea></label></article><div class="sticky bottom-[68px] z-20 -mx-4 border-y border-ledger/10 bg-paper/95 px-4 py-3 backdrop-blur"><div class="flex items-center justify-between"><div><p class="text-[11px] font-bold text-slate-500">本次應付</p><p id="order-total" class="text-2xl font-black tabular-nums text-ledger">${money(item.basePrice)}</p></div><button type="submit" class="rounded-xl bg-ledger px-5 py-3 text-sm font-bold text-white shadow-paper">確認送出</button></div></div></form>`;
}

function getOrderDraft(session) {
  if (!state.orderDrafts[session.sessionId]) state.orderDrafts[session.sessionId] = { items: [], note: '' };
  return state.orderDrafts[session.sessionId];
}

function renderMultiOrderForm(session) {
  const draft = getOrderDraft(session);
  const editing = state.editingOrderId && session.existingOrder && state.editingOrderId === session.existingOrder.orderId;
  const items = session.menuItems || [];
  if (!items.length) return emptyState('本場次尚未設定餐點', '請通知管理員在店家菜單中新增項目。');
  let summary = { total: 0, totalQuantity: 0, items: [] };
  try { if (draft.items.length) summary = summarizeCart(items, draft.items); } catch (_) { state.orderDrafts[session.sessionId] = { items: [], note: draft.note || '' }; }
  const balanceAmount = Number(state.user.walletBalance) || 0;
  const balanceShort = session.paymentMode === 'Stored-value Only' && !editing && summary.totalQuantity > 0 && summary.total > balanceAmount;
  const balanceNote = session.paymentMode === 'Stored-value Only'
    ? (summary.total > balanceAmount ? `<span class="ml-1 text-red-600">· 餘額不足 ${money(summary.total - balanceAmount)}</span>` : '')
    : (summary.total > balanceAmount && summary.totalQuantity ? `<span class="ml-1 text-[#A45A13]">· 差額將記為現金未繳</span>` : '');
  const canSubmit = summary.totalQuantity > 0 && !balanceShort;
  return `<form id="order-form" data-session-id="${session.sessionId}" data-order-id="${editing ? state.editingOrderId : ''}" class="space-y-4"><article class="binder-edge overflow-hidden rounded-[1.5rem] bg-white px-7 py-6 shadow-paper ring-1 ring-ledger/5"><div class="flex items-start justify-between gap-3"><div><p class="text-[11px] font-bold tracking-[.13em] text-slate-500">${editing ? 'EDIT ORDER' : escapeHtml(session.storeName)}</p><h2 class="mt-1 font-serif text-xl font-black">${editing ? '修改本場次訂單' : `${formatDate(session.orderDate)} 的午餐`}</h2></div><span class="rounded-lg bg-[#FFF6E8] px-2.5 py-1.5 text-[10px] font-bold text-[#885A1C]">${session.paymentMode === 'Stored-value Only' ? '僅限儲值金' : '混合支付'}</span></div><p class="mt-3 border-l-2 border-apricot pl-3 text-xs leading-5 text-slate-500">可同時勾選多種餐點，並個別設定數量與客製選項。截止：<b class="text-ledger" data-countdown="${session.cutoffTime}" data-session-id="${session.sessionId}">${formatDateTime(session.cutoffTime)}</b></p></article>${renderFavoriteChips(items)}<article class="rounded-[1.5rem] bg-white p-5 shadow-paper ring-1 ring-ledger/5"><div class="flex items-end justify-between"><h3 class="font-serif text-lg font-black">選擇餐點</h3><p class="text-xs text-slate-500">可複選、每項最多 99 份</p></div><div class="mt-4 space-y-4">${items.map(item => { const line = draft.items.find(entry => entry.itemId === item.itemId); const selected = !!line; return `<div class="overflow-hidden rounded-2xl border ${selected ? 'border-ledger bg-mist/60' : 'border-slate-100 bg-white'}"><label class="flex cursor-pointer items-center justify-between gap-3 p-4"><span class="flex items-center gap-3"><input data-cart-item="${item.itemId}" class="h-5 w-5 rounded accent-ledger" type="checkbox" ${selected ? 'checked' : ''}/><span><span class="block text-sm font-bold">${escapeHtml(item.name)}</span><span class="mt-0.5 block text-xs text-slate-500">可選客製項目</span></span></span><b class="shrink-0 text-sm tabular-nums text-ledger">${money(item.basePrice)}</b></label>${selected ? `<div class="border-t border-ledger/10 px-4 pb-4 pt-3"><div class="flex items-center justify-between"><p class="text-xs font-bold text-slate-600">數量</p><div class="flex items-center gap-2 rounded-xl bg-white p-1 ring-1 ring-ledger/10"><button data-action="adjust-cart-quantity" data-item-id="${item.itemId}" data-delta="-1" ${line.quantity <= 1 ? 'disabled' : ''} type="button" class="grid h-8 w-8 place-items-center rounded-lg bg-mist font-black text-ledger disabled:opacity-35">−</button><b class="w-7 text-center text-sm tabular-nums text-ledger">${line.quantity}</b><button data-action="adjust-cart-quantity" data-item-id="${item.itemId}" data-delta="1" ${line.quantity >= 99 ? 'disabled' : ''} type="button" class="grid h-8 w-8 place-items-center rounded-lg bg-ledger font-black text-white disabled:opacity-35">＋</button></div></div><div class="mt-4 space-y-2">${item.options.length ? item.options.map(option => `<label class="flex cursor-pointer items-center justify-between rounded-xl bg-white px-3 py-2.5 ring-1 ring-ledger/5"><span class="flex items-center gap-2"><input data-cart-option="${option.optionId}" data-item-id="${item.itemId}" type="checkbox" class="h-4 w-4 rounded accent-ledger" ${line.optionIds.includes(option.optionId) ? 'checked' : ''}/><span class="text-sm">${escapeHtml(option.name)}</span></span><b class="text-xs tabular-nums ${option.priceAdjustment > 0 ? 'text-apricot' : 'text-stamp'}">${signedMoney(option.priceAdjustment)}</b></label>`).join('') : '<p class="rounded-xl bg-white px-3 py-2.5 text-xs text-slate-500">此餐點沒有額外選項。</p>'}</div><p class="mt-3 text-right text-sm font-black tabular-nums text-ledger">小計 ${money(summary.items.find(entry => entry.itemId === item.itemId)?.lineTotal || 0)}</p></div>` : ''}</div>`; }).join('')}</div><label class="mt-5 block"><span class="mb-1.5 block text-xs font-bold text-slate-600">整筆訂單備註</span><textarea name="note" maxlength="200" rows="2" class="w-full resize-none rounded-xl border border-slate-200 px-3 py-3 text-sm outline-none focus:border-ledger" placeholder="例如：請將全部餐點分開裝">${escapeHtml(draft.note || '')}</textarea></label></article><div class="sticky bottom-[68px] z-20 -mx-4 border-y border-ledger/10 bg-paper/95 px-4 py-3 backdrop-blur"><div class="flex items-center justify-between gap-3"><div><p class="text-[11px] font-bold text-slate-500">本次共 ${summary.totalQuantity} 份</p><p id="order-total" class="text-2xl font-black tabular-nums text-ledger">${money(summary.total)}</p><p class="mt-0.5 text-[10px] font-bold ${balanceShort ? 'text-red-600' : 'text-slate-400'}">儲值餘額 ${money(balanceAmount)}${balanceNote}</p></div><button type="submit" ${canSubmit ? '' : 'disabled'} class="rounded-xl bg-ledger px-5 py-3 text-sm font-bold text-white shadow-paper disabled:cursor-not-allowed disabled:opacity-40">${editing ? '儲存修改' : '確認送出'}</button></div></div></form>`;
}

function setCartItemSelected(sessionId, itemId, selected) {
  const draft = getOrderDraft({ sessionId });
  const index = draft.items.findIndex(item => item.itemId === itemId);
  if (selected && index < 0) draft.items.push({ itemId, quantity: 1, optionIds: [] });
  if (!selected && index >= 0) draft.items.splice(index, 1);
}

function adjustCartQuantity(sessionId, itemId, delta) {
  const draft = getOrderDraft({ sessionId });
  const item = draft.items.find(entry => entry.itemId === itemId);
  if (!item) return;
  item.quantity = Math.max(1, Math.min(99, Number(item.quantity) + Number(delta)));
}

function setCartOption(sessionId, itemId, optionId, selected) {
  const draft = getOrderDraft({ sessionId });
  const item = draft.items.find(entry => entry.itemId === itemId);
  if (!item) return;
  const index = item.optionIds.indexOf(optionId);
  if (selected && index < 0) item.optionIds.push(optionId);
  if (!selected && index >= 0) item.optionIds.splice(index, 1);
}

function renderVerification() {
  const root = $('#verify-content');
  const types = [['pickup', '取餐 QR', '管理員核對今日餐點並確認取餐'], ['checkout', '結帳 QR', '管理員核對你的現金未繳金額'], ['topup', '儲值 QR', '管理員輸入儲值金額並立即更新餘額']];
  root.innerHTML = `<div class="scroll-hide flex gap-2 overflow-x-auto pb-1">${types.map(([type, label]) => `<button data-action="verify-type" data-type="${type}" class="shrink-0 rounded-xl px-3 py-2 text-xs font-bold ${state.verification.type === type ? 'bg-ledger text-white' : 'bg-mist text-ledger'}">${label}</button>`).join('')}</div><div id="qr-stage" class="mt-5"></div>`;
  generateVerification();
}

async function generateVerification() {
  clearVerificationTimer();
  const stage = $('#qr-stage');
  if (!stage) return;
  stage.innerHTML = `<div class="grid min-h-64 place-items-center rounded-2xl bg-mist"><span class="text-sm font-bold text-slate-500">正在產生安全通行證…</span></div>`;
  try {
    const data = await api('createVerification', { type: state.verification.type });
    state.verification = refreshVerificationState(state.verification, data);
    const labels = { pickup: ['取餐 QR', '出示給管理員掃描，核對今天尚未取餐的項目。'], checkout: ['結帳 QR', '出示給管理員掃描，核對所有未結清的現金訂單。'], topup: ['儲值 QR', '出示給管理員掃描，再由管理員輸入本次收款金額。'] };
    const [title, detail] = labels[state.verification.type];
    stage.innerHTML = `<div class="rounded-2xl border border-ledger/10 bg-[#FFFDF8] p-5 text-center notebook-lines"><p class="text-[11px] font-bold tracking-[.13em] text-stamp">${title}</p><div id="qr-code" class="mx-auto mt-4 grid h-48 w-48 place-items-center rounded-xl bg-white p-3 shadow-paper"></div><p class="mt-4 text-sm leading-6 text-slate-600">${detail}</p><div class="mt-4 rounded-xl bg-ledger px-4 py-3 text-white"><p class="text-[10px] font-bold tracking-[.12em] text-blue-200">6-DIGIT PIN</p><p class="mt-0.5 font-serif text-3xl font-black tracking-[.23em]">${data.pin}</p></div><p id="qr-expiry" class="mt-3 text-xs font-bold text-slate-500"></p><button data-action="refresh-verification" class="mt-3 text-xs font-bold text-ledger underline underline-offset-4">重新產生 QR</button></div>`;
    if (!window.QRCode) throw new Error('QR 程式庫尚未載入，請稍後重新產生。');
    new window.QRCode($('#qr-code'), { text: typeof data.payload === 'string' ? data.payload : JSON.stringify(data.payload), width: 168, height: 168, colorDark: '#173B62', colorLight: '#ffffff', correctLevel: window.QRCode.CorrectLevel.M });
    updateVerificationCountdown();
    state.verification.interval = setInterval(updateVerificationCountdown, 1000);
  } catch (error) {
    stage.innerHTML = `<div class="rounded-2xl border border-red-100 bg-red-50 p-5 text-center text-sm leading-6 text-red-700">無法產生通行證：${escapeHtml(error.message)}<br><button data-action="refresh-verification" class="mt-3 font-bold underline">重新嘗試</button></div>`;
  }
}

function updateVerificationCountdown() {
  const label = $('#qr-expiry');
  if (!label || !state.verification.data) return;
  const countdown = getVerificationCountdown(state.verification.data.expiresAt);
  if (countdown.expired) { label.textContent = '此通行證已失效，請重新產生。'; clearVerificationTimer(); return; }
  label.textContent = `有效時間還有 ${countdown.remainingSeconds} 秒`;
}

function clearVerificationTimer() { if (state.verification.interval) clearInterval(state.verification.interval); state.verification.interval = null; }

async function renderWallet() {
  $('#wallet-balance').textContent = money(state.user.walletBalance);
  $('#wallet-unpaid').textContent = '正在整理未繳金額…';
  $('#transaction-list').innerHTML = skeletonLines(4);
  try {
    state.wallet = await api('getWalletHistory');
    state.user = state.wallet.user;
    syncUser();
    $('#wallet-balance').textContent = money(state.user.walletBalance);
    $('#wallet-unpaid').innerHTML = state.wallet.cashUnpaid > 0 ? `目前另有 <b class="tabular-nums">${money(state.wallet.cashUnpaid)}</b> 現金未繳，請出示「結帳 QR」供管理員核對。` : '目前沒有現金未繳款項。';
    $('#transaction-list').innerHTML = state.wallet.transactions.length ? state.wallet.transactions.map(t => `<div class="flex items-center justify-between rounded-xl bg-white px-4 py-3 shadow-sm ring-1 ring-ledger/5"><div><p class="text-sm font-bold">${t.type === 'TopUp' ? '儲值入帳' : t.type === 'Manual' ? '手動調整' : '訂餐扣款'}</p><p class="mt-0.5 text-[11px] text-slate-500">${formatDateTime(t.timestamp)}</p></div><b class="text-sm tabular-nums ${t.amount >= 0 ? 'text-stamp' : 'text-apricot'}">${signedMoney(t.amount)}</b></div>`).join('') : emptyState('還沒有交易紀錄', '儲值或以餘額完成訂餐後，紀錄會出現在這裡。');
    $('#wallet-orders').innerHTML = (state.wallet.orders || []).length ? state.wallet.orders.map(order => `<div class="flex items-center justify-between rounded-xl bg-white px-4 py-3 shadow-sm ring-1 ring-ledger/5 ${order.isDeleted ? 'opacity-50' : ''}"><div><p class="text-sm font-bold ${order.isDeleted ? 'line-through text-slate-400' : ''}">${escapeHtml(order.itemName || '訂單')}</p><p class="mt-0.5 text-[11px] text-slate-500">${escapeHtml(order.orderDate || '')} · ${escapeHtml(order.storeName || '')}${order.isDeleted ? ' · <span class="text-red-500">場次已取消</span>' : (order.paymentStatus === 'PaidWallet' ? '' : ' · 未結清')}</p></div><b class="text-sm tabular-nums text-ledger ${order.isDeleted ? 'line-through text-slate-400' : ''}">${money(order.totalPrice)}</b></div>`).join('') : '';
  } catch (error) {
    $('#wallet-unpaid').textContent = '暫時無法讀取錢包資料。';
    $('#transaction-list').innerHTML = errorBlock(error.message);
    const walletOrders = $('#wallet-orders'); if (walletOrders) walletOrders.innerHTML = '';
  }
}

async function renderSettings() {
  $('#settings-avatar').textContent = initial(state.user.name);
  $('#settings-name').textContent = state.user.name;
  $('#settings-meta').textContent = `${state.user.studentNo} · ${state.user.email}`;
  $('#settings-balance').textContent = money(state.user.walletBalance);
  $('#settings-role').textContent = state.user.role === 'Admin' ? '管理員' : '學生';
  await updateNotificationUI();
  renderInstallButton();
}

function renderAdmin() {
  if (state.user.role !== 'Admin') { state.view = 'settings'; renderShell(); return; }
  const tabs = [['dashboard', '統計'], ['scan', '掃碼'], ['catalog', '菜單'], ['sessions', '場次'], ['users', '帳號'], ['system', '設定']];
  $('#admin-tabs').innerHTML = tabs.map(([tab, label]) => `<button data-action="admin-tab" data-tab="${tab}" class="shrink-0 rounded-xl px-3 py-2 text-xs font-bold ${state.admin.tab === tab ? 'bg-ledger text-white' : 'bg-white text-ledger ring-1 ring-ledger/5'}">${label}</button>`).join('');
  const root = $('#admin-content');
  if (state.admin.tab === 'dashboard') return renderAdminDashboard(root);
  if (state.admin.tab === 'scan') {
    renderAdminScan(root);
    if (state.admin.scanError) root.insertAdjacentHTML('afterbegin', errorBlock(state.admin.scanError));
    return;
  }
  if (state.admin.tab === 'catalog') return renderAdminCatalog(root);
  if (state.admin.tab === 'sessions') return renderAdminSessions(root);
  if (state.admin.tab === 'users') return renderAdminUsers(root);
  return renderAdminSystem(root);
}

async function renderAdminDashboard(root) {
  root.innerHTML = `<div class="space-y-4"><div class="rounded-xl bg-white p-4 shadow-paper"><label class="block"><span class="mb-1.5 block text-xs font-bold text-slate-600">統計日期</span><select id="dashboard-date" class="w-full rounded-xl border border-slate-200 bg-white px-3 py-3 outline-none focus:border-ledger"><option value="${state.admin.selectedDate}">${state.admin.selectedDate}</option></select></label></div><div id="dashboard-data">${skeletonLines(5)}</div></div>`;
  try {
    const data = await api('getAdminDashboard', { orderDate: state.admin.selectedDate });
    state.admin.dashboard = data;
    const select = $('#dashboard-date');
    select.innerHTML = (data.availableDates.length ? data.availableDates : [state.admin.selectedDate]).map(date => `<option value="${date}" ${date === state.admin.selectedDate ? 'selected' : ''}>${date}</option>`).join('');
    renderDashboardData();
  } catch (error) { $('#dashboard-data').innerHTML = errorBlock(error.message); }
}

function renderDashboardData() {
  const root = $('#dashboard-data');
  const d = state.admin.dashboard;
  if (!root || !d) return;
  const st = d.stats || {};
  const cards = [['總份數', st.totalMeals || 0, '份'], ['總應收', money(st.totalReceivable), ''], ['未結清', st.unpaidStudents || 0, '人'], ['已取餐', st.pickedUp || 0, '份']];
  root.innerHTML = `<div class="grid grid-cols-2 gap-3">${cards.map(([label, value, unit], index) => `<div class="rounded-2xl ${index === 1 ? 'bg-apricot text-white' : index === 3 ? 'bg-stamp text-white' : 'bg-white text-ledger'} p-4 shadow-paper"><p class="text-[11px] font-bold ${index === 1 || index === 3 ? 'text-white/75' : 'text-slate-500'}">${label}</p><p class="mt-1 font-serif text-2xl font-black tabular-nums">${value}<span class="ml-1 text-xs">${unit}</span></p></div>`).join('')}</div><div class="mt-4 flex gap-2"><button data-action="copy-order-text" class="flex-1 rounded-xl bg-white px-3 py-3 text-xs font-bold text-ledger shadow-sm ring-1 ring-ledger/5">複製電話訂餐格式</button><button data-action="export-csv" class="flex-1 rounded-xl bg-ledger px-3 py-3 text-xs font-bold text-white shadow-paper">匯出 CSV</button></div><section class="mt-5"><div class="flex items-center justify-between gap-2"><h2 class="font-serif text-lg font-black">當日訂單</h2><input id="order-search" type="search" value="${escapeAttr(state.admin.orderQuery)}" placeholder="搜尋姓名／座號／餐點" class="w-36 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs outline-none focus:border-ledger"/></div><div class="mt-2 flex gap-1.5">${[['all','全部'],['unpicked','待取餐'],['unpaid','未繳'],['picked','已取餐'],['paid','已結清']].map(([value,label]) => `<button type="button" data-action="admin-filter" data-filter="${value}" class="rounded-lg px-2.5 py-1.5 text-[11px] font-bold ${state.admin.orderFilter === value ? 'bg-ledger text-white' : 'bg-white text-ledger ring-1 ring-ledger/10'}">${label}</button>`).join('')}</div><div id="dashboard-orders" class="mt-3 space-y-2"></div></section>`;
  renderDashboardOrderList();
  root.insertAdjacentHTML('beforeend', renderSessionSummaryTables(d.sessionSummaries || []));
}

function renderSessionSummaryTables(summaries) {
  return `<section class="mt-5"><div class="mb-3"><p class="text-[11px] font-bold tracking-[.13em] text-stamp">SESSION ORDER SHEETS</p><h2 class="mt-1 font-serif text-lg font-black">各場次訂購總表</h2><p class="mt-1 text-xs leading-5 text-slate-500">每張總表僅統計一個店家與截止時間，方便直接核對備餐數量。</p></div><div class="space-y-4">${summaries.length ? summaries.map(summary => `<article data-session-summary="${escapeAttr(summary.sessionId)}" class="overflow-hidden rounded-2xl bg-white shadow-paper ring-1 ring-ledger/5"><header class="bg-ledger px-4 py-3 text-white"><div class="flex items-start justify-between gap-3"><div><h3 class="font-serif text-lg font-black">${escapeHtml(summary.storeName)}</h3><p class="mt-1 text-[11px] text-blue-100">${formatDate(summary.orderDate)} · 截止 ${formatDateTime(summary.cutoffTime)}</p></div><span class="rounded-md bg-white/15 px-2 py-1 text-[10px] font-bold">${summary.paymentMode === 'Stored-value Only' ? '純儲值' : '混合支付'}</span></div></header><div class="grid grid-cols-4 divide-x divide-ledger/10 bg-mist/60 text-center">${[['訂單', summary.stats.orderCount || 0], ['總份', summary.stats.totalMeals || 0], ['未繳', summary.stats.unpaidStudents || 0], ['已取', summary.stats.pickedUp || 0]].map(([label, value]) => `<div class="px-1 py-3"><p class="text-[10px] font-bold text-slate-500">${label}</p><p class="mt-1 text-base font-black tabular-nums text-ledger">${value}</p></div>`).join('')}</div><div class="p-4"><div class="mb-2 flex items-baseline justify-between"><h4 class="text-sm font-black text-ledger">餐點數量</h4><b class="text-sm tabular-nums text-apricot">${money(summary.stats.totalReceivable)}</b></div>${summary.items.length ? `<div class="divide-y divide-slate-100">${summary.items.map(item => `<div class="flex items-center justify-between gap-3 py-2.5"><div class="min-w-0"><p class="truncate text-sm font-bold text-ledger">${escapeHtml(item.itemName)}</p><p class="mt-0.5 truncate text-[11px] text-slate-500">${item.selectedOptions ? escapeHtml(item.selectedOptions) : '無加選項'} · ${item.orderCount} 筆訂單</p></div><b class="shrink-0 rounded-lg bg-stamp/10 px-3 py-1.5 text-sm tabular-nums text-stamp">${item.totalQuantity} 份</b></div>`).join('')}</div>` : `<p class="rounded-xl bg-mist px-3 py-4 text-center text-sm text-slate-500">此場次尚無訂單。</p>`}</div></article>`).join('') : emptyState('這一天沒有已建立的場次', '建立場次後，這裡會依店家與截止時間顯示獨立總表。')}</div></section>`;
}

async function renderAdminScan(root) {
  const result = state.admin.scanResult;
  root.innerHTML = `<div class="space-y-4"><div class="rounded-[1.5rem] bg-white p-5 shadow-paper ring-1 ring-ledger/5"><p class="text-[11px] font-bold tracking-[.13em] text-ledger">THREE-LANE CHECK</p><h2 class="mt-1 font-serif text-xl font-black">掃碼核對中心</h2><p class="mt-2 text-sm leading-6 text-slate-500">一天可能有多個場次；先選「核對場次」（或全部），再掃描學生憑證頁的動態 QR Code（也可輸入 PIN）。</p><div id="scan-session-area">${skeletonLines(1)}</div><div class="mt-3 grid grid-cols-3 gap-2">${[['pickup','取餐','bg-stamp'],['checkout','結帳','bg-apricot'],['topup','儲值','bg-ledger']].map(([mode,label,color]) => `<button data-action="open-scanner" data-mode="${mode}" class="rounded-xl ${color} px-2 py-3 text-xs font-bold text-white shadow-sm">${label}<span class="mt-1 block text-[10px] font-normal text-white/80">掃描 QR</span></button>`).join('')}</div></div>${result ? renderScanResult(result) : `<div class="binder-edge rounded-xl border border-dashed border-ledger/20 bg-white px-7 py-8 text-center text-sm leading-6 text-slate-500">尚未掃描憑證。學生的 QR 與 PIN 有效時間為 5 分鐘。</div>`}</div>`;
  try {
    if (!state.admin.catalog) state.admin.catalog = await api('adminCatalog');
    renderScanSessionArea();
  } catch (_) { const area = $('#scan-session-area'); if (area) area.innerHTML = ''; }
}

function renderScanSessionArea() {
  const area = $('#scan-session-area'); if (!area) return;
  const catalog = state.admin.catalog;
  const sessions = (catalog?.sessions || []).slice().sort((a, b) => a.orderDate.localeCompare(b.orderDate) || new Date(a.cutoffTime) - new Date(b.cutoffTime));
  area.innerHTML = sessions.length
    ? `<label class="mt-3 block"><span class="mb-1 block text-xs font-bold text-slate-600">核對場次（一天多場次時指定）</span><select id="scan-session" class="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-ledger"><option value="">全部場次</option>${sessions.map(s => `<option value="${escapeAttr(s.sessionId)}" ${state.admin.scanSessionId === s.sessionId ? 'selected' : ''}>${escapeHtml(formatDate(s.orderDate))} · ${escapeHtml((catalog.stores.find(x => x.storeId === s.storeId) || {}).name || '未命名店家')} · 截止 ${escapeHtml(formatDateTime(s.cutoffTime))}</option>`).join('')}</select></label>`
    : '<p class="mt-3 rounded-xl bg-mist px-3 py-2 text-xs text-slate-500">目前沒有場次可選；預設核對全部場次。</p>';
}

function renderScanResult(result) {
  const student = result.student;
  const heading = result.mode === 'pickup' ? '確認取餐' : result.mode === 'checkout' ? '標記已結清' : '確認儲值';
  let detail = '';
  if (result.mode === 'pickup') detail = result.orders.length ? `<ul class="mt-3 space-y-2">${result.orders.map(o => `<li class="rounded-xl bg-mist px-3 py-2 text-sm"><b>${escapeHtml(o.itemName)}</b><span class="float-right tabular-nums">${money(o.totalPrice)}</span><p class="mt-1 text-xs text-slate-500">${o.selectedOptions.map(x => escapeHtml(x.name)).join('、') || '無加選項'}</p></li>`).join('')}</ul>` : '<p class="mt-3 rounded-xl bg-mist px-3 py-3 text-sm text-slate-500">今天沒有待取餐的項目。</p>';
  if (result.mode === 'checkout') detail = `<div class="mt-3 rounded-xl bg-[#FFF6E8] px-4 py-3 text-sm">待收現金：<b class="float-right text-lg tabular-nums text-[#885A1C]">${money(result.outstandingAmount)}</b></div>${result.orders.length ? `<p class="mt-2 text-xs text-slate-500">${result.orders.map(o => escapeHtml(o.itemName)).join('、')}</p>` : ''}`;
  if (result.mode === 'topup') detail = `<div class="mt-3 rounded-xl bg-mist px-4 py-3 text-sm">目前餘額：<b class="float-right text-lg tabular-nums text-stamp">${money(result.walletBalance)}</b></div>`;
  const disabled = (result.mode === 'pickup' || result.mode === 'checkout') && !result.orders.length;
  return `<article class="rounded-[1.5rem] border border-ledger/10 bg-white p-5 shadow-paper"><p class="text-[11px] font-bold tracking-[.13em] text-stamp">QR VERIFIED</p><div class="mt-2 flex items-center justify-between"><div><h2 class="font-serif text-xl font-black">${escapeHtml(student.name)}</h2><p class="text-sm text-slate-500">${escapeHtml(student.studentNo)} · ${escapeHtml(student.seatNo)} 號</p></div><span class="status-stamp rounded-md px-2 py-1 text-stamp">驗證通過</span></div>${detail}<button data-action="confirm-scan-action" ${disabled ? 'disabled' : ''} class="mt-5 w-full rounded-xl bg-ledger px-4 py-3.5 text-sm font-bold text-white disabled:cursor-not-allowed disabled:opacity-40">${heading}</button></article>`;
}

async function renderAdminCatalog(root) {
  root.innerHTML = `<div class="space-y-4"><div class="rounded-[1.5rem] bg-white p-5 shadow-paper"><p class="text-[11px] font-bold tracking-[.13em] text-stamp">MENU MANAGEMENT</p><h2 class="mt-1 font-serif text-xl font-black">店家與餐點</h2><div id="catalog-data" class="mt-4">${skeletonLines(5)}</div></div></div>`;
  try { state.admin.catalog = await api('adminCatalog'); renderCatalogData(); $('#catalog-data').insertAdjacentHTML('beforeend', renderCatalogDeletePanel(state.admin.catalog)); } catch (error) { $('#catalog-data').innerHTML = errorBlock(error.message); }
}

function renderCatalogData() {
  const root = $('#catalog-data'); const c = state.admin.catalog; if (!root || !c) return;
  root.innerHTML = `<form id="store-form" class="rounded-xl bg-mist p-3"><p class="text-xs font-black text-ledger">新增店家</p><div class="mt-2 grid grid-cols-2 gap-2"><input name="name" required maxlength="60" class="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-ledger" placeholder="店家名稱"/><input name="contact" maxlength="120" class="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-ledger" placeholder="聯絡資訊（電話／LINE，選填）"/></div><textarea name="description" maxlength="200" rows="2" class="mt-2 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-ledger" placeholder="店家簡介（選填）"></textarea><button class="mt-2 w-full rounded-lg bg-ledger px-3 py-2.5 text-xs font-bold text-white">新增店家</button></form><div class="mt-4">${c.stores.length ? c.stores.map(s => `<article class="mb-3 rounded-xl border border-slate-100 p-3"><div class="flex items-start justify-between gap-2"><div class="min-w-0"><p class="text-sm font-black">${escapeHtml(s.name)}${s.isGlobal ? ' <span class="ml-1 rounded bg-ledger/10 px-1.5 py-0.5 text-[9px] font-black text-ledger">全體共用</span>' : ''}</p>${s.description ? `<p class="mt-1 text-[11px] leading-5 text-slate-500">${escapeHtml(s.description)}</p>` : ''}${s.contact ? `<p class="mt-1 text-[11px] text-slate-500">聯絡：${escapeHtml(s.contact)}</p>` : ''}</div>${s.isGlobal ? '' : `<button type="button" data-action="edit-store-info" data-id="${s.storeId}" class="shrink-0 rounded-lg bg-mist px-2.5 py-2 text-[11px] font-bold text-ledger">店家資訊</button>`}</div>${s.isGlobal ? '' : `<form id="menu-item-form" class="mt-3 grid grid-cols-[1fr_70px_auto] gap-2"><input type="hidden" name="storeId" value="${s.storeId}"/><input name="name" required maxlength="80" class="min-w-0 rounded-lg border border-slate-200 px-2 py-2 text-xs outline-none focus:border-ledger" placeholder="餐點名稱"/><input name="basePrice" required type="number" min="0" class="min-w-0 rounded-lg border border-slate-200 px-2 py-2 text-xs outline-none focus:border-ledger" placeholder="價格"/><button class="rounded-lg bg-stamp px-2 text-xs font-bold text-white">新增餐點</button></form>`}<div class="mt-3 space-y-2">${c.items.filter(i => i.storeId === s.storeId).map(i => `<div class="rounded-lg bg-paper p-2.5"><div class="flex justify-between text-sm"><b>${escapeHtml(i.name)}</b><span>${money(i.basePrice)}</span></div>${s.isGlobal ? '' : `<form id="item-option-form" class="mt-2 grid grid-cols-[1fr_64px_auto] gap-2"><input type="hidden" name="itemId" value="${i.itemId}"/><input name="name" required maxlength="80" class="min-w-0 rounded-md border border-slate-200 bg-white px-2 py-1.5 text-xs outline-none focus:border-ledger" placeholder="加飯、大辣…"/><input name="priceAdjustment" required type="number" class="min-w-0 rounded-md border border-slate-200 bg-white px-2 py-1.5 text-xs outline-none focus:border-ledger" placeholder="差額"/><button class="rounded-md bg-white px-2 text-xs font-bold text-ledger ring-1 ring-ledger/10">加選項</button></form>`}${c.options.filter(o => o.itemId === i.itemId).length ? `<p class="mt-2 text-[11px] text-slate-500">${c.options.filter(o => o.itemId === i.itemId).map(o => `${escapeHtml(o.name)} (${signedMoney(o.priceAdjustment)})`).join(' · ')}</p>` : ''}</div>`).join('') || '<p class="py-2 text-xs text-slate-500">尚未建立餐點。</p>'}</div></article>`).join('') : emptyState('先新增一間店家', '建立店家後才可新增餐點與客製選項。')}</div>`;
}

function renderCatalogDeletePanel(catalog) {
  const stores = (catalog.stores || []).filter(store => !store.isGlobal);
  const items = (catalog.items || []).filter(item => !((catalog.stores || []).find(store => store.storeId === item.storeId) || {}).isGlobal);
  const options = catalog.options || [];
  return `<section class="mt-5 rounded-xl border border-red-100 bg-red-50/50 p-4"><p class="text-xs font-black text-red-700">刪除菜單資料</p><p class="mt-1 text-xs leading-5 text-red-600">刪除店家會一併移除尚無訂單紀錄的場次、餐點與選項；已有訂單的店家會受到帳務保護而無法刪除。</p><div class="mt-3 space-y-2">${stores.map(store => `<div class="flex items-center justify-between gap-2 rounded-lg bg-white px-3 py-2"><span class="min-w-0 truncate text-sm font-bold">${escapeHtml(store.name)}</span><button data-action="delete-store" data-id="${store.storeId}" type="button" class="shrink-0 rounded-lg bg-red-50 px-2.5 py-1.5 text-xs font-bold text-red-700">刪除店家</button></div>`).join('') || '<p class="text-xs text-slate-500">尚無店家資料。</p>'}</div><details class="mt-3 rounded-lg bg-white p-3"><summary class="cursor-pointer text-xs font-bold text-ledger">刪除特定餐點或客製選項</summary><div class="mt-3 space-y-2">${items.map(item => `<div class="rounded-lg bg-mist p-2.5"><div class="flex items-center justify-between gap-2"><span class="min-w-0 truncate text-sm font-bold">${escapeHtml(item.name)}</span><button data-action="delete-menu-item" data-id="${item.itemId}" type="button" class="shrink-0 rounded-lg bg-red-50 px-2 py-1.5 text-xs font-bold text-red-700">刪除餐點</button></div>${options.filter(option => option.itemId === item.itemId).map(option => `<div class="mt-2 flex items-center justify-between gap-2 border-t border-ledger/10 pt-2"><span class="min-w-0 truncate text-xs text-slate-600">${escapeHtml(option.name)} (${signedMoney(option.priceAdjustment)})</span><button data-action="delete-item-option" data-id="${option.optionId}" type="button" class="shrink-0 text-xs font-bold text-red-700 underline">刪除選項</button></div>`).join('')}</div>`).join('') || '<p class="text-xs text-slate-500">尚無餐點資料。</p>'}</div></details></section>`;
}

async function renderAdminSessions(root) {
  root.innerHTML = `<div class="space-y-4"><form id="session-form" class="rounded-[1.5rem] bg-white p-5 shadow-paper"><p class="text-[11px] font-bold tracking-[.13em] text-stamp">OPEN A SESSION</p><h2 class="mt-1 font-serif text-xl font-black">建立訂餐場次</h2><div id="session-form-fields" class="mt-4">${skeletonLines(4)}</div></form><div id="session-list">${skeletonLines(3)}</div></div>`;
  try { state.admin.catalog = state.admin.catalog || await api('adminCatalog'); renderSessionData(); } catch (error) { $('#session-form-fields').innerHTML = errorBlock(error.message); $('#session-list').innerHTML = ''; }
}

function renderSessionData() {
  const c = state.admin.catalog; const fields = $('#session-form-fields'); const list = $('#session-list'); if (!c || !fields || !list) return;
  fields.innerHTML = c.stores.length ? `<div class="space-y-3"><label class="block"><span class="mb-1 block text-xs font-bold text-slate-600">訂餐日期</span><input name="orderDate" type="date" min="${toDateInput(new Date())}" required class="w-full rounded-xl border border-slate-200 px-3 py-3 text-sm outline-none focus:border-ledger" value="${toDateInput(new Date())}" /></label><label class="block"><span class="mb-1 block text-xs font-bold text-slate-600">店家</span><input type="hidden" name="storeId" id="session-store-id" required/><button type="button" data-action="browse-stores" class="w-full rounded-xl border border-slate-200 bg-white px-3 py-3 text-left text-sm outline-none focus:border-ledger"><span id="session-store-label" class="text-slate-400">點此選擇店家（可查看店家資訊與菜單）</span></button></label><label class="block"><span class="mb-1 block text-xs font-bold text-slate-600">截止時間</span><input name="cutoffTime" type="datetime-local" required class="w-full rounded-xl border border-slate-200 px-3 py-3 text-sm outline-none focus:border-ledger" value="${defaultCutoff()}" /></label><label class="block"><span class="mb-1 block text-xs font-bold text-slate-600">支付模式</span><select name="paymentMode" class="w-full rounded-xl border border-slate-200 bg-white px-3 py-3 text-sm outline-none focus:border-ledger"><option value="Hybrid">混合模式（餘額不足轉現金未繳）</option><option value="Stored-value Only">純儲值模式（餘額不足禁止下單）</option></select></label><button class="w-full rounded-xl bg-ledger px-4 py-3.5 text-sm font-bold text-white">建立訂餐場次</button></div>` : `<div class="rounded-xl bg-[#FFF6E8] p-4 text-sm leading-6 text-[#885A1C]">請先在「菜單」新增至少一間店家。</div>`;
  const sessions = [...c.sessions].sort((a, b) => a.orderDate.localeCompare(b.orderDate) || new Date(a.cutoffTime) - new Date(b.cutoffTime));
  list.innerHTML = `<section><h2 class="mb-3 font-serif text-lg font-black">已建立場次</h2><p class="mb-3 text-xs leading-5 text-slate-500">同一天可建立多個獨立場次，例如飲料與主食；每個場次各自設定截止時間並獨立接單。</p><div class="space-y-2">${sessions.length ? sessions.map(s => { const isOpen = new Date(s.cutoffTime) > new Date(); return `<article class="rounded-xl bg-white p-4 shadow-sm ring-1 ring-ledger/5"><div class="flex justify-between gap-3"><div><p class="font-bold">${formatDate(s.orderDate)} · ${escapeHtml((c.stores.find(x => x.storeId === s.storeId) || {}).name || '未命名店家')}</p><p class="mt-1 text-xs text-slate-500">截止：${formatDateTime(s.cutoffTime)} · ${s.paymentMode === 'Stored-value Only' ? '純儲值' : '混合支付'}</p></div><span class="status-stamp h-fit rounded-md px-2 py-1 ${isOpen ? 'text-ledger' : 'text-slate-500'}">${isOpen ? '開放中' : '已截止'}</span></div><div class="mt-3 grid grid-cols-3 gap-2"><button type="button" data-action="edit-session-cutoff" data-id="${s.sessionId}" ${isOpen ? '' : 'disabled'} class="rounded-lg bg-mist px-2 py-2 text-xs font-bold text-ledger disabled:cursor-not-allowed disabled:opacity-40">修改截止</button><button type="button" data-action="close-session" data-id="${s.sessionId}" ${isOpen ? '' : 'disabled'} class="rounded-lg bg-[#FFF6E8] px-2 py-2 text-xs font-bold text-[#885A1C] disabled:cursor-not-allowed disabled:opacity-40">提前結束</button><button type="button" data-action="delete-session" data-id="${s.sessionId}" class="rounded-lg bg-red-50 px-2 py-2 text-xs font-bold text-red-700">刪除</button></div></article>`; }).join('') : emptyState('還沒有訂餐場次', '建立場次後，學生就會在訂餐頁看到日期票籤。')}</div></section>`;
}

async function renderAdminUsers(root) {
  root.innerHTML = `<div><div class="mb-3 flex items-center justify-between"><h2 class="font-serif text-lg font-black">學生帳號</h2><button data-action="refresh-users" class="text-xs font-bold text-ledger underline underline-offset-4">重新整理</button></div><div id="user-list">${skeletonLines(5)}</div></div>`;
  try { state.admin.users = await api('adminListUsers'); renderUserList(); } catch (error) { $('#user-list').innerHTML = errorBlock(error.message); }
}

function renderUserList() {
  const root = $('#user-list'); if (!root) return;
  root.innerHTML = `<div class="space-y-2">${state.admin.users.map(u => `<article class="flex items-center justify-between rounded-xl bg-white px-4 py-3 shadow-sm ring-1 ring-ledger/5"><div><p class="text-sm font-bold ${u.isDisabled ? 'text-slate-400 line-through' : ''}">${escapeHtml(u.seatNo)}號 ${escapeHtml(u.name)} ${u.role === 'Admin' ? '<span class="ml-1 text-[10px] text-ledger">ADMIN</span>' : ''}</p><p class="mt-1 text-[11px] text-slate-500">${escapeHtml(u.studentNo)} · 餘額 ${money(u.walletBalance)}</p></div><div class="flex shrink-0 flex-wrap justify-end gap-1.5"><button data-action="direct-topup" data-id="${u.id}" ${u.isDisabled ? 'disabled' : ''} class="rounded-lg bg-stamp/10 px-2.5 py-2 text-xs font-bold text-stamp disabled:opacity-35">儲值</button><button data-action="manual-deduct" data-id="${u.id}" ${u.isDisabled ? 'disabled' : ''} class="rounded-lg bg-[#FFF6E8] px-2.5 py-2 text-xs font-bold text-[#885A1C] disabled:opacity-35">扣款</button><button data-action="toggle-user" data-id="${u.id}" data-disabled="${u.isDisabled ? 'false' : 'true'}" class="rounded-lg px-2.5 py-2 text-xs font-bold ${u.isDisabled ? 'bg-stamp/10 text-stamp' : 'bg-red-50 text-red-600'}">${u.isDisabled ? '恢復' : '停用'}</button>${u.role === 'Admin' ? (u.id !== state.user.id ? `<button data-action="remove-admin" data-id="${u.id}" class="rounded-lg bg-[#FFF6E8] px-2.5 py-2 text-xs font-bold text-[#885A1C]">移除管理</button>` : '') : `<button data-action="set-admin" data-id="${u.id}" class="rounded-lg bg-ledger/10 px-2.5 py-2 text-xs font-bold text-ledger">設為管理</button>`}</div></article>`).join('')}</div>`;
  state.admin.users.filter(user => user.role !== 'Admin' && user.id !== state.user.id).forEach(user => {
    const toggle = root.querySelector(`[data-action="toggle-user"][data-id="${cssEscape(user.id)}"]`);
    toggle?.insertAdjacentHTML('afterend', `<button data-action="delete-user" data-id="${escapeAttr(user.id)}" class="rounded-lg bg-red-700 px-2.5 py-2 text-xs font-bold text-white">刪除</button>`);
  });
}

async function renderAdminSystem(root) {
  root.innerHTML = `<div class="space-y-4"><div class="rounded-[1.5rem] bg-white p-5 shadow-paper"><p class="text-[11px] font-bold tracking-[.13em] text-stamp">CLASS SETTINGS</p><h2 class="mt-1 font-serif text-xl font-black">本班設定</h2><div id="system-fields" class="mt-4">${skeletonLines(3)}</div></div></div>`;
  try {
    const settings = await api('adminGetSettings');
    $('#system-fields').innerHTML = `<div class="space-y-3"><p class="rounded-xl bg-mist px-3 py-3 text-xs leading-5 text-slate-500"><b>${escapeHtml(settings.className || '本班')}</b> 的管理者與學生帳號，請到「帳號」分頁管理；更換管理者時，由現任管理者在「帳號」頁新增或移除其他管理者即可。</p><section id="invite-code-section" class="rounded-xl border border-ledger/10 bg-mist p-3"><p class="text-xs font-bold text-ledger">班級邀請碼</p><p class="mt-1 text-xs leading-5 text-slate-500">提供給同班一般使用者註冊；停用後不可再加入。</p><div id="invite-code-list" class="mt-3 space-y-2"><p class="text-xs text-slate-400">載入中…</p></div><button type="button" data-action="create-invite-code" class="mt-3 w-full rounded-lg bg-white px-3 py-2.5 text-xs font-bold text-ledger ring-1 ring-ledger/10">產生邀請碼</button></section></div>`;
    await loadAdminInviteCodes();
  } catch (error) { $('#system-fields').innerHTML = errorBlock(error.message); }
}

async function loadAdminInviteCodes() {
  const root = $('#invite-code-list'); if (!root) return;
  try {
    const codes = await api('adminListInviteCodes');
    root.innerHTML = codes.length ? codes.map(code => `<div class="flex items-center justify-between gap-2 rounded-lg bg-white px-3 py-2"><span class="text-xs font-bold text-ledger">${escapeHtml(code.label)}<small class="ml-2 font-normal text-slate-400">${code.isDisabled ? '已停用' : '啟用中'}</small></span>${code.isDisabled ? '' : `<button data-action="disable-invite-code" data-id="${escapeAttr(code.inviteCodeId)}" class="rounded-md bg-red-50 px-2 py-1 text-[10px] font-bold text-red-600">停用</button>`}</div>`).join('') : '<p class="text-xs text-slate-400">尚未建立邀請碼。</p>';
  } catch (error) { root.innerHTML = errorBlock(error.message); }
}

async function createAdminInviteCode() {
  const label = window.prompt('請輸入邀請碼用途（例如：三年甲班）', '班級邀請碼');
  if (label === null) return;
  await busy($('#invite-code-section'), async () => {
    const result = await api('adminCreateInviteCode', { label });
    await loadAdminInviteCodes();
    openCodeRevealModal({ eyebrow: 'CLASS INVITE', title: '班級邀請碼已產生', code: result.code, note: '<p class="text-sm leading-6 text-slate-600">請把邀請碼發送給同班一般使用者，他們註冊時需要輸入。</p>' });
  });
}

async function disableAdminInviteCode(id) {
  openConfirmModal({ eyebrow: 'DISABLE INVITE', title: '停用此邀請碼？', body: '<p>停用後，尚未註冊的使用者將不能再使用它加入班級。</p>', submitLabel: '確認停用', onConfirm: async () => { await api('adminDisableInviteCode', { inviteCodeId: id }); closeModal(); await loadAdminInviteCodes(); toast('邀請碼已停用。', 'success'); } });
}

async function onClick(event) {
  const button = event.target.closest('button');
  if (!button || button.disabled) return;
  if (button.dataset.auth) { state.authMode = resolveAuthMode(button.dataset.auth); renderAuth(); return; }
  if (button.dataset.nav) { state.view = button.dataset.nav; renderNav(); renderView(); return; }
  const action = button.dataset.action;
  if (!action) return;
  const run = async () => {
    if (action === 'select-session') { state.selectedSessionId = button.dataset.id; state.selectedItemId = ''; renderLunch(); return; }
    if (action === 'quick-add-favorite') { quickAddFavorite(state.selectedSessionId, button.dataset.itemId, (button.dataset.optionIds || '').split(',').filter(Boolean)); renderLunch(); return; }
    if (action === 'clear-favorites') { localStorage.removeItem('classLunch.favorites'); toast('已清空常點清單。', 'success'); renderLunch(); return; }
    if (action === 'copy-my-order') return copyMyOrder(button.dataset.sessionId);
    if (action === 'toggle-notifications') {
      const subscription = await currentPushSubscription();
      if (subscription) return unsubscribeFromPush();
      return subscribeToPush();
    }
    if (action === 'install-app') return openInstallGuideModal();
    if (action === 'install-app-confirm') {
      const promptEvent = deferredInstallPrompt;
      deferredInstallPrompt = null;
      closeModal();
      if (promptEvent) { promptEvent.prompt(); await promptEvent.userChoice.catch(() => {}); }
      else toast('請依照上方步驟，用瀏覽器選單釘選到桌面。', 'success');
      renderInstallButton();
      return;
    }
    if (action === 'admin-filter') { state.admin.orderFilter = button.dataset.filter || 'all'; renderDashboardOrderList(); return; }
    if (action === 'adjust-cart-quantity') { adjustCartQuantity(state.selectedSessionId, button.dataset.itemId, button.dataset.delta); renderLunch(); return; }
    if (action === 'verify-type') { state.verification.type = button.dataset.type; renderVerification(); return; }
    if (action === 'refresh-verification') return generateVerification();
    if (action === 'refresh-wallet') return renderWallet();
    if (action === 'logout') return logout();
    if (action === 'developer-logout') return developerLogout();
    if (action === 'developer-tab') { state.developerTab = button.dataset.tab || 'overview'; renderDeveloperView(); return; }
  if (action === 'merchant-tab') { state.merchantTab = button.dataset.tab; renderMerchantShell(); return; }
  if (action === 'merchant-refresh') return renderMerchantContent();
  if (action === 'merchant-logout') { merchantApi('merchantLogout').catch(() => {}); clearMerchantSession(); state.authMode = 'merchantLogin'; renderAuth(); toast('店家帳號已登出。', 'success'); return; }
  if (action === 'merchant-toggle-ordering') return merchantToggleOrdering();
  if (action === 'merchant-delete-item') return confirmMerchantItemDelete(button.dataset.id);
  if (action === 'merchant-delete-option') return confirmMerchantOptionDelete(button.dataset.id);
  if (action === 'browse-stores') return openStoreBrowserModal();
  if (action === 'pick-store') { const id = button.dataset.id; const hidden = $('#session-store-id'); if (hidden) hidden.value = id; const label = $('#session-store-label'); if (label) label.textContent = button.dataset.name; closeModal(); return; }
  if (action === 'manual-deduct') return openDeductModal(button.dataset.id);
  if (action === 'delete-item') return confirmAdminItemDelete(button.dataset.id);
  if (action === 'delete-option') return confirmAdminOptionDelete(button.dataset.id);
  if (action === 'store-details') return openStoreDetailsModal(button.dataset.id);
  if (action === 'developer-approve-application') return confirmApplicationApprove(button.dataset.id);
  if (action === 'developer-reject-application') return confirmApplicationReject(button.dataset.id);
  if (action === 'developer-toggle-merchant') return developerToggleMerchant(button.dataset.id, button.dataset.disabled === 'true');
  if (action === 'developer-approve-merchant') return confirmMerchantApprove(button.dataset.id);
    if (action === 'developer-refresh') return refreshDeveloperData();
    if (action === 'developer-create-code') return createDeveloperClassAdminCode();
    if (action === 'developer-revoke-code') return confirmDeveloperCodeRevoke(button.dataset.id);
    if (action === 'developer-view-user') return openDeveloperUserDetails(button.dataset.id);
    if (action === 'developer-toggle-user') return toggleDeveloperUser(button.dataset.id, button.dataset.disabled === 'true');
    if (action === 'developer-delete-user') return confirmDeveloperUserDelete(button.dataset.id);
    if (action === 'admin-tab') { state.admin.tab = button.dataset.tab; state.admin.scanResult = null; state.admin.scanError = ''; renderAdmin(); return; }
    if (action === 'open-scanner') { state.admin.scanSessionId = $('#scan-session')?.value || ''; return openScanner(button.dataset.mode); }
    if (action === 'close-scanner') return closeScanner();
    if (action === 'submit-manual-qr') return processManualQr();
    if (action === 'submit-pin') return processManualPin();
    if (action === 'copy-reveal-code') return copyRevealCode(button.dataset.code);
    if (action === 'share-reveal-code') return shareRevealCode(button.dataset.title, button.dataset.code);
    if (action === 'reveal-done') return closeModal();
    if (action === 'set-admin') return confirmAdminRoleChange(button.dataset.id, 'Admin');
    if (action === 'remove-admin') return confirmAdminRoleChange(button.dataset.id, 'Student');
    if (action === 'developer-check-email') return developerCheckEmail();
    if (action === 'developer-broadcast') return developerBroadcast();
    if (action === 'developer-maintenance') return developerSetMaintenance(button.dataset.enabled === 'true', button);
    if (action === 'developer-wipe-data') return confirmDeveloperWipeData();
    if (action === 'developer-resend-verify') return developerResendVerificationCode();
    if (action === 'developer-delete-developer') return confirmDeveloperDelete(button.dataset.id);
    if (action === 'developer-refresh-menu') return renderDeveloperMenu($('#developer-content'));
    if (action === 'developer-edit-store') return openDeveloperStoreInfoModal(button.dataset.id);
    if (action === 'developer-delete-store') return confirmDeveloperStoreDelete(button.dataset.id);
    if (action === 'developer-delete-item') return confirmDeveloperItemDelete(button.dataset.id);
    if (action === 'developer-delete-option') return confirmDeveloperOptionDelete(button.dataset.id);
    if (action === 'confirm-scan-action') return openScanConfirmation();
    if (action === 'close-modal') return closeModal();
    if (action === 'copy-order-text') return copyOrderText();
    if (action === 'export-csv') return exportCsv();
    if (action === 'create-invite-code') return createAdminInviteCode();
    if (action === 'edit-store-info') return openStoreInfoModal(button.dataset.id);
    if (action === 'disable-invite-code') return disableAdminInviteCode(button.dataset.id);
    if (action === 'refresh-users') return renderAdminUsers($('#admin-content'));
    if (action === 'toggle-user') return toggleUser(button.dataset.id, button.dataset.disabled === 'true');
    if (action === 'direct-topup') return openDirectTopUp(button.dataset.id);
    if (action === 'delete-store') return confirmCatalogDelete('adminDeleteStore', { storeId: button.dataset.id }, '刪除店家？', '將一併移除該店家無訂單紀錄的場次、餐點與客製選項。');
    if (action === 'delete-menu-item') return confirmCatalogDelete('adminDeleteMenuItem', { itemId: button.dataset.id }, '刪除餐點？', '此餐點與其客製選項將從往後可選菜單中移除；既有訂單仍保留當時餐點資訊。');
    if (action === 'delete-item-option') return confirmCatalogDelete('adminDeleteItemOption', { optionId: button.dataset.id }, '刪除客製選項？', '此選項將從往後可選菜單中移除；既有訂單仍保留當時選項資訊。');
    if (action === 'edit-session-cutoff') return openSessionCutoffEditor(button.dataset.id);
    if (action === 'close-session') return confirmSessionClose(button.dataset.id);
    if (action === 'delete-session') return confirmSessionDelete(button.dataset.id);
    if (action === 'edit-own-order') return startOwnOrderEdit(button.dataset.sessionId, button.dataset.orderId);
    if (action === 'delete-own-order') return confirmOwnOrderDelete(button.dataset.orderId);
    if (action === 'delete-user') return confirmUserDelete(button.dataset.id);
  };
  const lockable = ['refresh-verification', 'refresh-wallet', 'logout', 'developer-logout', 'developer-refresh', 'copy-order-text', 'export-csv', 'refresh-users', 'developer-check-email'];
  return lockable.includes(action) ? busy(button, run) : run();
}

async function onSubmit(event) {
  event.preventDefault();
  const form = event.target;
  if (form.id === 'login-form') return submitLogin(form);
  if (form.id === 'developer-login-form') return submitDeveloperLogin(form);
  if (form.id === 'developer-register-form') return submitDeveloperRegister(form);
  if (form.id === 'developer-verify-form') return submitDeveloperVerify(form);
  if (form.id === 'store-form-dev') return submitDeveloperSave('developerSaveStore', form, '全體店家已新增。', () => renderDeveloperMenu($('#developer-content')));
  if (form.id === 'menu-item-form-dev') return submitDeveloperSave('developerSaveMenuItem', form, '全體餐點已新增。', () => renderDeveloperMenu($('#developer-content')));
  if (form.id === 'item-option-form-dev') return submitDeveloperSave('developerSaveItemOption', form, '全體選項已新增。', () => renderDeveloperMenu($('#developer-content')));
  if (form.id === 'register-form') return submitRegister(form);
  if (form.id === 'class-admin-apply-form') return submitClassAdminApply(form);
  if (form.id === 'class-admin-verify-form') return submitClassAdminVerify(form);
  if (form.id === 'merchant-login-form') return submitMerchantLogin(form);
  if (form.id === 'merchant-register-form') return submitMerchantRegister(form);
  if (form.id === 'merchant-verify-form') return submitMerchantVerify(form);
  if (form.id === 'merchant-settings-form') return submitMerchantSave('merchantSaveStore', form, '店家設定已儲存。', () => renderMerchantContent());
  if (form.id === 'merchant-item-form') return submitMerchantSave('merchantSaveMenuItem', form, '餐點已新增。', () => renderMerchantMenu($('#merchant-content')));
  if (form.id === 'merchant-option-form') return submitMerchantSave('merchantSaveItemOption', form, '選項已新增。', () => renderMerchantMenu($('#merchant-content')));
  if (form.id === 'school-form-dev') return submitDeveloperSave('developerSaveSchool', form, '學校已儲存。', () => renderDeveloperSchools($('#developer-content')));
  if (form.id === 'verify-email-form') return submitVerifyRegistration(form);
  if (form.id === 'resend-verification-form') return submitResendVerification(form);
  if (form.id === 'forgot-form') return submitForgot(form);
  if (form.id === 'reset-form') return submitReset(form);
  if (form.id === 'order-form') return submitOrder(form);
  if (form.id === 'store-form') return submitAdminSave('adminSaveStore', form, '已新增店家。', async () => { state.admin.catalog = null; await refreshOrders(true); });
  if (form.id === 'menu-item-form') return submitAdminSave('adminSaveMenuItem', form, '已新增餐點。', async () => { state.admin.catalog = null; await refreshOrders(true); });
  if (form.id === 'item-option-form') return submitAdminSave('adminSaveItemOption', form, '已新增客製選項。', async () => { state.admin.catalog = null; await refreshOrders(true); });
  if (form.id === 'session-form') return submitAdminSave('adminSaveSession', form, result => result.notification ? `已建立訂餐場次，通知寄送：${result.notification.sent}/${result.notification.attempted} 位使用者。` : '已建立訂餐場次。', async () => { state.admin.catalog = null; await refreshOrders(true); });
  if (form.id === 'developer-settings-form') return submitAdminSave('developerSaveSettings', form, '開發者系統設定已儲存。', () => { state.developerSettings = null; return refreshDeveloperData(); });
}

function onChange(event) {
  if (event.target.matches('[data-cart-item]')) { setCartItemSelected(state.selectedSessionId, event.target.dataset.cartItem, event.target.checked); renderLunch(); return; }
  if (event.target.matches('[data-cart-option]')) { setCartOption(state.selectedSessionId, event.target.dataset.itemId, event.target.dataset.cartOption, event.target.checked); renderLunch(); return; }
  if (event.target.id === 'dashboard-date') { state.admin.selectedDate = event.target.value; busy(event.target, async () => { await renderAdminDashboard($('#admin-content')); }); }
}

function onInput(event) {
  if (event.target.id === 'order-search') { state.admin.orderQuery = event.target.value; renderDashboardOrderList(); return; }
  if (event.target.matches('#dev-store-scope')) {
    const schoolSelect = $('#dev-store-school');
    if (schoolSelect) schoolSelect.classList.toggle('hidden', event.target.value !== 'school');
  }
  if (event.target.matches('#order-form textarea[name="note"]')) {
    const session = state.sessions.find(item => item.sessionId === state.selectedSessionId);
    if (session) getOrderDraft(session).note = event.target.value.slice(0, 200);
  }
}

async function submitDeveloperLogin(form) {
  const data = formData(form);
  if (!String(data.username || '').trim()) return toast('請輸入開發者帳號。', 'error');
  if (!String(data.password || '')) return toast('請輸入密碼。', 'error');
  await busy(form, async () => { const result = await api('developerLogin', data, '', true); saveDeveloperSession(result); if (result.loginAlert && result.loginAlert.sent) toast('開發者登入已通知管理者信箱。', 'success'); await loadDeveloperApp(); toast('開發者登入成功。', 'success'); });
}

async function submitDeveloperRegister(form) {
  const data = formData(form);
  if (!String(data.username || '').trim()) return toast('請輸入開發者帳號。', 'error');
  if (!String(data.email || '').trim()) return toast('請輸入電子郵件。', 'error');
  if (!String(data.password || '') || data.password.length < 8) return toast('密碼至少須為 8 個字元。', 'error');
  await busy(form, async () => { const result = await api('developerRegister', data, '', true); state.authMode = 'developerVerify'; renderAuth(); toast(result.message || '開發者帳號已建立，請先完成信箱驗證。', 'success'); });
}

async function submitDeveloperVerify(form) {
  const data = formData(form);
  if (!String(data.username || '').trim()) return toast('請輸入開發者帳號。', 'error');
  if (!/^\d{6}$/.test(String(data.code || '').trim())) return toast('請輸入 6 位數驗證碼。', 'error');
  await busy(form, async () => { const result = await api('developerVerifyEmail', { username: data.username, code: String(data.code).trim() }); state.authMode = 'developerLogin'; renderAuth(); toast(result.message || '信箱驗證完成，請登入。', 'success'); });
}

async function submitClassAdminApply(form) {
  const data = formData(form);
  if (!String(data.studentName || '').trim() || !String(data.studentNo || '').trim() || !String(data.className || '').trim()) return toast('請完整填寫姓名、學號與班級。', 'error');
  if (!String(data.contactPhone || '').trim() || String(data.contactPhone).trim().length < 8) return toast('請填寫正確的聯絡電話。', 'error');
  await busy(form, async () => { const result = await api('applyClassAdmin', data); state.classAdminApplication = { email: result.email || data.email }; state.authMode = 'classAdminVerify'; renderAuth(); toast(result.message || '申請已送出，驗證碼已寄出。', 'success'); });
}

async function submitClassAdminVerify(form) {
  const data = formData(form);
  if (!/^\d{6}$/.test(String(data.code || '').trim())) return toast('請輸入 6 位數驗證碼。', 'error');
  await busy(form, async () => { const result = await api('verifyClassAdminApplication', data); state.authMode = 'login'; renderAuth(); toast(result.message || '驗證完成，申請已送出。', 'success'); });
}

async function submitMerchantLogin(form) {
  const data = formData(form);
  await busy(form, async () => { const result = await api('merchantLogin', data); saveMerchantSession(result); renderMerchantShell(); toast('店家工作台已開啟。', 'success'); });
}

async function submitMerchantRegister(form) {
  const data = formData(form);
  if (!passwordsMatch(data.password, data.confirmPassword)) return toast('兩次輸入的密碼不一致。', 'error');
  await busy(form, async () => { const result = await api('merchantRegister', data); state.merchantPendingEmail = data.email; state.authMode = 'merchantVerify'; renderAuth(); toast(result.message || '請完成信箱驗證。', 'success'); });
}

async function submitMerchantVerify(form) {
  const data = formData(form);
  if (!/^\d{6}$/.test(String(data.code || '').trim())) return toast('請輸入 6 位數驗證碼。', 'error');
  await busy(form, async () => { const result = await api('merchantVerifyEmail', data); state.authMode = 'merchantLogin'; renderAuth(); toast(result.message || '驗證完成，請登入。', 'success'); });
}

function merchantApi(action, data = {}) { return api(action, data, state.merchantToken); }

function saveMerchantSession(result) {
  state.merchant = result.merchant;
  state.merchantToken = result.token;
  state.merchantTab = 'orders';
  try { localStorage.setItem('classLunch.merchant', JSON.stringify({ token: result.token, merchant: result.merchant })); } catch (_) {}
}

function clearMerchantSession() {
  state.merchant = null;
  state.merchantToken = '';
  try { localStorage.removeItem('classLunch.merchant'); } catch (_) {}
}

function renderMerchantShell() {
  stopLunchCountdown();
  app.innerHTML = `<div class="min-h-dvh bg-paper pb-10"><header class="sticky top-0 z-40 border-b border-ledger/10 bg-paper/95 px-4 py-3 backdrop-blur"><div class="mx-auto flex max-w-md items-center justify-between"><div><p class="text-[11px] font-bold tracking-[.13em] text-stamp">MERCHANT CONSOLE</p><h1 class="font-serif text-lg font-black text-ledger">店家工作台</h1></div><button data-action="merchant-logout" class="rounded-xl bg-white px-3 py-2 text-xs font-bold text-ledger ring-1 ring-ledger/10">登出</button></div></header><main class="mx-auto max-w-md px-4 pt-4"><div class="flex gap-2">${[['orders', '訂單'], ['menu', '菜單'], ['settings', '設定']].map(([tab, label]) => `<button data-action="merchant-tab" data-tab="${tab}" class="flex-1 rounded-xl px-3 py-3 text-xs font-bold ${state.merchantTab === tab ? 'bg-stamp text-white' : 'bg-white text-stamp ring-1 ring-stamp/10'}">${label}</button>`).join('')}</div><div id="merchant-content" class="mt-4 space-y-4">${skeletonLines(5)}</div></main></div><div id="modal-root"></div><div id="toast-root"></div>`;
  renderMerchantContent();
}

function renderMerchantContent() {
  const root = $('#merchant-content');
  if (!root) return;
  if (state.merchantTab === 'orders') return renderMerchantOrders(root);
  if (state.merchantTab === 'menu') return renderMerchantMenu(root);
  return renderMerchantSettings(root);
}

async function renderMerchantOrders(root) {
  root.innerHTML = `${skeletonLines(4)}`;
  try {
    const data = await merchantApi('merchantGetDashboard');
    if (!data.store) { root.innerHTML = data.pendingApproval ? emptyState('店家待審核', '你的店家帳號已送出審核，核准後即可開始接單（開發者核准後會自動開設店家）。') : emptyState('尚未開設店家', '開發者核准後會自動建立店家並加入場次選擇。'); return; }
    const orders = data.orders || [];
    const today = toDateInput(new Date());
    const todayOrders = orders.filter(order => order.orderDate === today);
    const pastOrders = orders.filter(order => order.orderDate !== today);
    root.innerHTML = `<div class="rounded-[1.5rem] bg-white p-4 shadow-paper ring-1 ring-ledger/5"><div class="flex items-center justify-between"><div><p class="text-sm font-black text-ledger">${escapeHtml(data.store.name)}</p><p class="mt-0.5 text-[11px] text-slate-500">營業時間 ${escapeHtml(data.store.businessHours || '未設定')} · ${data.store.orderingOpen ? '訂購中' : '已暫停訂購'}</p></div><button data-action="merchant-refresh" class="rounded-lg bg-mist px-2.5 py-2 text-xs font-bold text-ledger">重新整理</button></div></div>${renderMerchantOrderList('今日訂單', todayOrders)}${renderMerchantOrderList('歷史訂單', pastOrders.slice(0, 30))}`;
  } catch (error) { root.innerHTML = errorBlock(error.message); }
}

function renderMerchantOrderList(title, orders) {
  return `<section class="mt-4"><h2 class="mb-2 font-serif text-lg font-black">${title}（${orders.length}）</h2><div class="space-y-2">${orders.length ? orders.map(order => `<article class="rounded-xl bg-white p-3 shadow-sm ring-1 ring-ledger/5"><div class="flex items-start justify-between gap-2"><div class="min-w-0"><p class="text-sm font-black">${escapeHtml(order.studentName)} ${order.seatNo ? `<span class="font-normal text-slate-500">${escapeHtml(order.seatNo)}號</span>` : ''}</p><p class="mt-1 text-sm text-ledger">${escapeHtml(order.items)}</p>${order.note ? `<p class="mt-1 text-[11px] text-slate-500">備註：${escapeHtml(order.note)}</p>` : ''}</div><div class="text-right"><b class="block text-sm tabular-nums text-ledger">${money(order.totalPrice)}</b><span class="mt-1 inline-block rounded px-1.5 py-0.5 text-[10px] font-bold ${order.pickupStatus === 'PickedUp' ? 'bg-stamp/10 text-stamp' : 'bg-apricot/15 text-apricot'}">${order.pickupStatus === 'PickedUp' ? '已取餐' : '待取餐'}</span></div></div></article>`).join('') : `<p class="rounded-xl bg-white px-4 py-6 text-center text-xs text-slate-400 ring-1 ring-ledger/5">尚無訂單。</p>`}</div></section>`;
}

async function renderMerchantMenu(root) {
  root.innerHTML = `${skeletonLines(4)}`;
  try {
    const data = await merchantApi('merchantGetMenu');
    if (!data.store) { root.innerHTML = data.pendingApproval ? emptyState('店家待審核', '核准後即可管理菜單。') : emptyState('尚未開設店家', '開發者核准後會自動建立店家。'); return; }
    const store = data.store;
    const items = data.items || [];
    const options = data.options || [];
    root.innerHTML = `<section class="rounded-[1.5rem] bg-white p-4 shadow-paper ring-1 ring-ledger/5"><p class="text-sm font-black text-ledger">${escapeHtml(store.name)}</p><form id="merchant-item-form" class="mt-3 grid grid-cols-[1fr_70px_auto] gap-2"><input name="name" required maxlength="80" class="min-w-0 rounded-lg border border-slate-200 px-2 py-2 text-xs outline-none focus:border-ledger" placeholder="餐點名稱"/><input name="basePrice" required type="number" min="0" class="min-w-0 rounded-lg border border-slate-200 px-2 py-2 text-xs outline-none focus:border-ledger" placeholder="價格"/><button class="rounded-lg bg-stamp px-2 text-xs font-bold text-white">新增餐點</button></form><div class="mt-3 space-y-2">${items.length ? items.map(item => `<div class="rounded-lg bg-paper p-2.5"><div class="flex justify-between text-sm"><b>${escapeHtml(item.name)}</b><div class="flex items-center gap-2"><span>${money(item.basePrice)}</span><button type="button" data-action="merchant-delete-item" data-id="${escapeAttr(item.itemId)}" class="text-[10px] font-bold text-red-700 underline">刪除</button></div></div><form id="merchant-option-form" class="mt-2 grid grid-cols-[1fr_64px_auto] gap-2"><input type="hidden" name="itemId" value="${escapeAttr(item.itemId)}"/><input name="name" required maxlength="80" class="min-w-0 rounded-md border border-slate-200 bg-white px-2 py-1.5 text-xs outline-none focus:border-ledger" placeholder="加飯、大辣…"/><input name="priceAdjustment" required type="number" class="min-w-0 rounded-md border border-slate-200 bg-white px-2 py-1.5 text-xs outline-none focus:border-ledger" placeholder="差額"/><button class="rounded-md bg-white px-2 text-xs font-bold text-ledger ring-1 ring-ledger/10">加選項</button></form>${options.filter(option => option.itemId === item.itemId).length ? `<p class="mt-2 text-[11px] text-slate-500">${options.filter(option => option.itemId === item.itemId).map(option => `${escapeHtml(option.name)} (${signedMoney(option.priceAdjustment)})<button type="button" data-action="merchant-delete-option" data-id="${escapeAttr(option.optionId)}" class="ml-1 text-red-700">✕</button>`).join(' · ')}</p>` : ''}</div>`).join('') : '<p class="py-3 text-xs text-slate-500">尚未建立餐點。</p>'}</div></section>`;
  } catch (error) { root.innerHTML = errorBlock(error.message); }
}

async function renderMerchantSettings(root) {
  root.innerHTML = `${skeletonLines(4)}`;
  try {
    const data = await merchantApi('merchantGetMenu');
    if (!data.store) { root.innerHTML = data.pendingApproval ? emptyState('店家待審核', '核准後即可修改店家設定。') : emptyState('尚未開設店家', '開發者核准後會自動建立店家。'); return; }
    const store = data.store;
    root.innerHTML = `<form id="merchant-settings-form" class="rounded-[1.5rem] bg-white p-5 shadow-paper ring-1 ring-ledger/5"><p class="text-[11px] font-bold tracking-[.13em] text-stamp">STORE SETTINGS</p><h2 class="mt-1 font-serif text-xl font-black">店家設定</h2><div class="mt-4 space-y-3"><label class="block"><span class="mb-1.5 block text-xs font-bold text-slate-600">店家名稱</span><input name="name" required maxlength="60" value="${escapeAttr(store.name)}" class="w-full rounded-xl border border-slate-200 px-3 py-3 text-sm outline-none focus:border-ledger"/></label><label class="block"><span class="mb-1.5 block text-xs font-bold text-slate-600">營業時間</span><input name="businessHours" maxlength="60" value="${escapeAttr(store.businessHours)}" placeholder="例如 11:00–13:30" class="w-full rounded-xl border border-slate-200 px-3 py-3 text-sm outline-none focus:border-ledger"/></label><label class="block"><span class="mb-1.5 block text-xs font-bold text-slate-600">店家簡介</span><textarea name="description" maxlength="200" rows="2" class="w-full rounded-xl border border-slate-200 px-3 py-3 text-sm outline-none focus:border-ledger">${escapeHtml(store.description || '')}</textarea></label><label class="block"><span class="mb-1.5 block text-xs font-bold text-slate-600">聯絡資訊</span><input name="contact" maxlength="120" value="${escapeAttr(store.contact)}" class="w-full rounded-xl border border-slate-200 px-3 py-3 text-sm outline-none focus:border-ledger"/></label><button data-action="merchant-toggle-ordering" class="w-full rounded-xl px-4 py-3.5 text-sm font-bold text-white ${store.orderingOpen ? 'bg-red-700' : 'bg-stamp'}">${store.orderingOpen ? '暫停訂購（學生將無法下單）' : '開啟訂購（學生可下單）'}</button><button class="w-full rounded-xl bg-ledger px-4 py-3.5 text-sm font-bold text-white" type="submit">儲存店家設定</button></div></form>`;
  } catch (error) { root.innerHTML = errorBlock(error.message); }
}


async function submitLogin(form) {
  const data = formData(form);
  if (!String(data.studentNo || '').trim()) return toast('請輸入學號。', 'error');
  if (!String(data.password || '')) return toast('請輸入密碼。', 'error');
  await busy(form, async () => { const result = await api('login', data); saveSession(result); if (result.adminAlert && result.adminAlert.sent) toast('管理員登入已通知管理者信箱。', 'success'); await loadApp(); toast('登入成功，午餐手帳已開啟。', 'success'); });
}

async function submitRegister(form) {
  const data = formData(form);
  if (!passwordsMatch(data.password, data.confirmPassword)) return toast('兩次輸入的密碼不一致。', 'error');
  await busy(form, async () => {
    const result = await api('register', data);
    state.pendingVerification = { studentNo: result.studentNo || data.studentNo, email: result.email || data.email };
    state.authMode = 'verifyEmail';
    renderAuth();
    toast(result.delivery?.sent === false ? result.delivery.message : '驗證碼已寄至校務信箱，請完成驗證後再登入。', result.delivery?.sent === false ? 'error' : 'success');
  });
}

async function submitVerifyRegistration(form) {
  const data = formData(form);
  await busy(form, async () => {
    const result = await api('verifyRegistration', data, '', true);
    state.pendingVerification = null;
    state.authMode = 'login';
    renderAuth();
    toast(result.message, 'success');
  });
}

async function submitResendVerification(form) {
  const data = formData(form);
  if (!data.studentNo) return toast('請先輸入學號。', 'error');
  await busy(form, async () => {
    const result = await api('resendRegistrationVerification', data, '', true);
    toast(result.delivery?.sent === false ? result.delivery.message : result.message, result.delivery?.sent === false ? 'error' : 'success');
  });
}

async function submitForgot(form) {
  const data = formData(form);
  await busy(form, async () => { const result = await api('requestPasswordReset', data, '', true); toast(result.message, 'success'); state.authMode = 'login'; renderAuth(); });
}

async function submitReset(form) {
  const data = formData(form); if (!passwordsMatch(data.password, data.confirmPassword)) return toast('兩次輸入的密碼不一致。', 'error');
  data.token = new URLSearchParams(location.search).get('resetToken');
  await busy(form, async () => { const result = await api('resetPassword', data, '', true); toast(result.message, 'success'); history.replaceState({}, '', location.pathname); state.authMode = 'login'; renderAuth(); });
}

async function submitOrder(form) {
  const session = state.sessions.find(s => s.sessionId === form.dataset.sessionId);
  const draft = getOrderDraft(session);
  const note = String($('textarea[name="note"]', form)?.value || '').trim();
  const orderId = form.dataset.orderId;
  let summary;
  try { summary = summarizeCart(session.menuItems, draft.items); } catch (error) { return toast(error.message, 'error'); }
  const action = orderId ? 'updateOwnOrder' : 'placeOrder';
  openConfirmModal({ eyebrow: orderId ? 'ORDER EDIT REVIEW' : '送出前核對', title: orderId ? '確認儲存訂單修改？' : `確認 ${formatDate(session.orderDate)} 的訂餐？`, body: `<div class="space-y-2 rounded-xl bg-mist p-3">${summary.items.map(item => `<div class="flex justify-between gap-3"><span><b>${escapeHtml(item.itemName)}</b>${item.quantity > 1 ? ` × ${item.quantity}` : ''}</span><b class="tabular-nums text-ledger">${money(item.lineTotal)}</b></div>`).join('')}</div><p class="mt-3 text-xs">共 ${summary.totalQuantity} 份，總額 ${money(summary.total)}。${orderId ? '系統會依更新後金額重新核對儲值餘額與未繳金額。' : '混合模式餘額不足時，未付部分會列為現金未繳。'}</p>`, submitLabel: orderId ? '確認儲存修改' : '確認送出', onConfirm: async () => { const result = await api(action, { ...(orderId ? { orderId } : { sessionId: form.dataset.sessionId }), items: summary.items.map(item => ({ itemId: item.itemId, quantity: item.quantity, optionIds: item.optionIds })), note }); if (result.walletBalance !== undefined) { state.user.walletBalance = result.walletBalance; syncUser(); } recordFavorites(summary.items); delete state.orderDrafts[form.dataset.sessionId]; state.editingOrderId = ''; closeModal(); toast(orderId ? '訂單已更新。' : '訂餐已送出並完成記錄。', 'success'); await refreshOrders(); } });
}

function startOwnOrderEdit(sessionId, orderId) {
  const session = state.sessions.find(item => item.sessionId === sessionId);
  if (!session?.existingOrder || !orderCanBeChanged(session, session.existingOrder)) return toast('此訂單目前無法修改。', 'error');
  const order = session.existingOrder;
  state.orderDrafts[sessionId] = { items: (order.items || []).map(item => ({ itemId: item.itemId, quantity: Number(item.quantity || 1), optionIds: (item.selectedOptions || []).map(option => option.optionId) })), note: order.note || '' };
  state.editingOrderId = orderId;
  renderLunch();
}

function confirmOwnOrderDelete(orderId) {
  openConfirmModal({ eyebrow: 'CANCEL ORDER', title: '取消這筆訂單？', body: '<p>只要尚未截止，便可取消本場次訂單。已從錢包扣除的金額會自動退回；現金未繳訂單則不會產生退款。</p>', submitLabel: '確認取消訂單', onConfirm: async () => { const result = await api('deleteOwnOrder', { orderId }); if (result.walletBalance !== undefined) { state.user.walletBalance = result.walletBalance; syncUser(); } state.editingOrderId = ''; closeModal(); toast(result.refunded ? `訂單已取消，已退回 ${money(result.refunded)}。` : '訂單已取消。', 'success'); await refreshOrders(); } });
}

async function submitAdminSave(action, form, message, rerender) {
  const data = formData(form);
  await busy(form, async () => { const result = await api(action, data); toast(typeof message === 'function' ? message(result) : message, 'success'); await rerender(); });
}

function openSessionCutoffEditor(sessionId) {
  const session = state.admin.catalog?.sessions?.find(item => item.sessionId === sessionId);
  if (!session) return;
  openConfirmModal({ eyebrow: 'EDIT CUTOFF', title: '修改場次截止時間', body: `<p class="text-sm leading-6 text-slate-500">新的截止時間必須在現在之後；若要立刻停止接單，請使用「提前結束」。</p><label class="mt-4 block"><span class="mb-1.5 block text-xs font-bold text-slate-600">新的截止時間</span><input id="session-cutoff-input" type="datetime-local" value="${escapeAttr(toDateTimeInput(session.cutoffTime))}" class="w-full rounded-xl border border-slate-200 px-3 py-3 outline-none focus:border-ledger"/></label>`, submitLabel: '儲存截止時間', onConfirm: async () => { const cutoffTime = $('#session-cutoff-input')?.value; if (!cutoffTime) throw new Error('請選擇新的截止時間。'); await api('adminUpdateSessionCutoff', { sessionId, cutoffTime }); closeModal(); state.admin.catalog = null; await refreshOrders(true); toast('場次截止時間已更新。', 'success'); } });
}

function confirmSessionClose(sessionId) {
  openConfirmModal({ eyebrow: 'CLOSE SESSION', title: '提前結束此場次？', body: '<p>提前結束後，學生無法再送出新訂單；已送出的訂單與帳務資料會完整保留。</p>', submitLabel: '確認提前結束', onConfirm: async () => { await api('adminCloseSession', { sessionId }); closeModal(); state.admin.catalog = null; await refreshOrders(true); toast('場次已提前結束，停止接受新訂單。', 'success'); } });
}

function confirmSessionDelete(sessionId) {
  openConfirmModal({ eyebrow: 'DELETE SESSION', title: '刪除此場次？', body: '<p>僅能刪除尚未有訂單的場次；已有訂單時系統會保留帳務資料並拒絕刪除。</p>', submitLabel: '確認刪除場次', onConfirm: async () => { await api('adminDeleteSession', { sessionId }); closeModal(); state.admin.catalog = null; await refreshOrders(true); toast('場次已刪除。', 'success'); } });
}

function updateOrderTotal() {
  const form = $('#order-form'); const totalEl = $('#order-total'); if (!form || !totalEl) return;
  const item = state.sessions.find(s => s.sessionId === form.dataset.sessionId).menuItems.find(i => i.itemId === state.selectedItemId);
  try { totalEl.textContent = money(calculateOrderTotal(item, item.options, $$('input[name="optionId"]:checked', form).map(input => input.value))); } catch (_) { totalEl.textContent = '資料錯誤'; }
}

async function refreshOrders(silent = false) {
  // 效能：只呼叫一次 getBootstrap（已含 user、sessions 與 orders），省下原本額外的一次請求。
  const data = await api('getBootstrap');
  state.sessions = data.sessions || [];
  state.orders = data.orders || [];
  state.user = data.user;
  syncUser();
  if (!silent) {
    renderShell();
  } else {
    renderView();
  }
}

// ----自動刷新：新增場次、儲值、訂單異動會自動同步，不需手動重新載入----
// 只在「切回分頁／視窗聚焦」時同步，不做定時輪詢
function startAutoRefresh() {
  window.addEventListener('focus', autoRefreshTick);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) autoRefreshTick(); });
  setInterval(autoRefreshTick, 15000); // 恢復 15 秒輕量輪詢，保持畫面即時同步
}

function stopLunchCountdown() {
  if (state.countdownTimer) { clearInterval(state.countdownTimer); state.countdownTimer = null; }
}

async function autoRefreshTick() {
  if (state.merchantToken) {
    if (document.hidden || state.operationPending || state.confirmAction) return;
    try {
      const content = $('#merchant-content');
      if (content) {
        const activeBtn = document.querySelector('[data-tab].bg-ledger');
        const tab = activeBtn ? activeBtn.dataset.tab : 'orders';
        if (tab === 'orders') await renderMerchantDashboard(content);
        else if (tab === 'menu') await renderMerchantMenu(content);
        else if (tab === 'settings') await renderMerchantSettings(content);
      }
    } catch (_) {}
    return;
  }

  // 核心保護：如果學生正開著「憑證 QR Code」頁面，絕對不要在背景同步！
  // 否則背景刷新會重新呼叫後端 API 產生新的 Token 繪製新的 QR Code，導致剛好在掃碼的管理員相機讀到不匹配的舊資料。
  if (state.view === 'verify') return;

  if (!state.token || !apiConfigured() || document.hidden || state.operationPending || state.confirmAction || state.scannerMode) return;
  if (state.view === 'admin' && (state.admin.scanResult || document.querySelector('#scanner-container'))) return;
  if (document.querySelector('#confirm-modal.active') || document.querySelector('#merchant-option-form') || state.editingOrderId) return;
  try { await refreshOrders(true); } catch (_) { /* 背景刷新失敗時靜默，下一次再試。 */ }
}

async function logout() {
  try { if (state.token && apiConfigured()) await api('logout', {}, state.token, false); } catch (_) { /* 本機登出仍應完成。 */ }
  // 登出時一併解除推播訂閱，避免已登出的使用者繼續收到班級通知
  try {
    const subscription = await currentPushSubscription();
    if (subscription) {
      await api('pushUnsubscribe', { endpoint: subscription.endpoint }, state.token, false).catch(() => {});
      await subscription.unsubscribe().catch(() => {});
    }
  } catch (_) {}
  clearSession(); clearVerificationTimer(); stopLunchCountdown(); state.authMode = 'login'; renderAuth(); toast('已安全登出。', 'success');
}

function openConfirmModal({ eyebrow, title, body, submitLabel, onConfirm }) {
  closeModal();
  const root = $('#modal-root'); root.innerHTML = htmlFromTemplate('confirm-modal-template');
  $('#confirm-eyebrow').textContent = eyebrow || '請確認'; $('#confirm-title').textContent = title; $('#confirm-body').innerHTML = body; $('#confirm-submit').textContent = submitLabel || '確認';
  state.confirmAction = onConfirm;
  $('#confirm-submit').addEventListener('click', async () => { await busy($('#confirm-submit'), async () => { try { await state.confirmAction(); } catch (error) { toast(error.message, 'error'); } }); });
}

function closeModal() { closeScanner(); const root = $('#modal-root'); if (root) root.innerHTML = ''; state.confirmAction = null; }

function openScanner(mode) {
  closeModal(); state.scannerMode = mode; state.admin.scanError = ''; const root = $('#modal-root'); root.innerHTML = htmlFromTemplate('scanner-modal-template');
  const label = { pickup: '掃描取餐 QR', checkout: '掃描結帳 QR', topup: '掃描儲值 QR' }[mode];
  $('#scanner-title').textContent = label; $('#scanner-help').textContent = '將學生畫面的 QR Code 對準鏡頭。掃描成功後，系統會自動驗證 PIN 與作業類型。';
  if (!window.Html5Qrcode) { $('#scanner-help').textContent = '相機元件尚未載入，請使用下方手動貼上 QR JSON 的方式驗證。'; return; }
  state.scanner = new window.Html5Qrcode('qr-reader');
  state.scanner.start({ facingMode: 'environment' }, { fps: 10, qrbox: { width: 220, height: 220 }, aspectRatio: 1 }, async text => { await processScannedQr(text); }, () => {}).catch(() => { $('#scanner-help').textContent = '無法開啟相機。請確認瀏覽器已允許相機權限，或使用下方手動驗證。'; });
}

async function closeScanner() {
  if (state.scanner) { try { await state.scanner.stop(); } catch (_) {} try { await state.scanner.clear(); } catch (_) {} state.scanner = null; }
  const root = $('#modal-root'); if (root) root.innerHTML = '';
}

async function processManualQr() { const raw = $('#manual-qr')?.value.trim(); if (!raw) return toast('請貼上 QR JSON。', 'error'); await processScannedQr(raw); }

async function processScannedQr(raw) {
  if (state.scannerProcessing || state.operationPending) return;
  state.scannerProcessing = true;
  setOperationLock(true);
  try {
    const payload = parseVerificationPayload(raw);
    const sessionId = $('#scan-session')?.value || state.admin.scanSessionId || '';
    const result = await api('adminResolveVerification', { mode: state.scannerMode, payload, sessionId: sessionId || null });
    await closeScanner();
    applyScanResult(result);
    toast('驗證成功，請核對後再確認。', 'success');
  } catch (error) {
    state.admin = reduceScanState(state.admin, { ok: false, errorMessage: error.message });
    await closeScanner();
    renderAdmin();
    toast(error.message, 'error');
  } finally {
    state.scannerProcessing = false;
    setOperationLock(false);
  }
}

function applyScanResult(result) {
  state.admin = reduceScanState(state.admin, { ok: true, result });
  renderAdmin();
}

// 相機無法使用時，直接輸入學生畫面顯示的 6 位 PIN 驗證
async function processManualPin() {
  const pin = String($('#manual-pin')?.value || '').trim();
  if (!/^\d{6}$/.test(pin)) return toast('請輸入 6 位數 PIN 碼。', 'error');
  await busy($('#manual-pin'), async () => {
    const result = await api('adminResolvePin', { mode: state.scannerMode, pin, sessionId: state.admin.scanSessionId || null });
    await closeScanner();
    applyScanResult(result);
    toast('驗證成功，請核對後再確認。', 'success');
  });
}

function openScanConfirmation() {
  const result = state.admin.scanResult; if (!result) return;
  const names = result.orders ? result.orders.map(o => escapeHtml(o.itemName)).join('、') : '';
  if (result.mode === 'pickup') return openConfirmModal({ eyebrow: 'PICKUP CONFIRMATION', title: `確認 ${result.student.name} 取餐？`, body: `<p>將標記以下餐點為已取餐：</p><p class="mt-2 rounded-xl bg-mist p-3 font-bold">${names}</p>`, submitLabel: '確認取餐', onConfirm: async () => { await api('adminConfirmPickup', { userId: result.student.id, orderIds: result.orders.map(o => o.orderId) }); closeModal(); state.admin.scanResult = null; await refreshOrders(true); toast('已完成取餐核銷。', 'success'); } });
  if (result.mode === 'checkout') return openConfirmModal({ eyebrow: 'CASH SETTLEMENT', title: `確認 ${result.student.name} 已結清？`, body: `<p>將以現金結清 <b class="text-apricot">${money(result.outstandingAmount)}</b>。</p><p class="mt-2 rounded-xl bg-mist p-3 text-xs">${names}</p>`, submitLabel: '標記已結清', onConfirm: async () => { await api('adminSettleCash', { userId: result.student.id, orderIds: result.orders.map(o => o.orderId) }); closeModal(); state.admin.scanResult = null; await refreshOrders(true); toast('已完成現金結清。', 'success'); } });
  return openConfirmModal({ eyebrow: 'TOP-UP CONFIRMATION', title: `為 ${result.student.name} 儲值`, body: `<p>目前餘額：<b class="text-stamp">${money(result.walletBalance)}</b></p><p class="mt-2 text-xs leading-5 text-slate-500">儲值金會先抵扣既有現金未繳；不足時餘額將維持 0 元，尚未抵完的金額會保留為欠款。</p><label class="mt-4 block"><span class="mb-1.5 block text-xs font-bold text-slate-600">本次實收金額</span><div class="relative"><input id="topup-amount" type="number" inputmode="decimal" min="1" max="100000" class="w-full rounded-xl border border-slate-200 px-3 py-3 pr-10 outline-none focus:border-ledger" placeholder="例如 100"/><span class="absolute right-3 top-3 text-sm text-slate-500">元</span></div></label>`, submitLabel: '確認儲值', onConfirm: async () => { const amount = Number($('#topup-amount').value); if (!amount || amount <= 0) throw new Error('請輸入正確的儲值金額。'); const data = await api('adminTopUp', { userId: result.student.id, amount }); closeModal(); state.admin.scanResult = null; await refreshOrders(true); toast(`${data.message}${data.appliedToDebt ? ` 已抵扣 ${money(data.appliedToDebt)} 欠款，剩餘欠款 ${money(data.remainingDebt)}。` : ''}`, 'success'); } });
}

function createDeveloperClassAdminCode() {
  if ($('#developer-class-name')) return;
  openConfirmModal({ eyebrow: 'CLASS ADMIN ACCESS', title: '核發班級管理者代碼', body: '<p class="text-sm leading-6 text-slate-600">輸入班級名稱後，系統會產生一組只能使用一次的管理者代碼。</p><label class="mt-4 block"><span class="mb-1.5 block text-xs font-bold text-slate-600">班級名稱</span><input id="developer-class-name" maxlength="80" class="w-full rounded-xl border border-slate-200 px-3 py-3 outline-none focus:border-ledger" placeholder="例如 三年甲班" autocomplete="off" /></label><p class="mt-3 text-xs leading-5 text-slate-500">代碼原文只會在核發成功的下一個視窗顯示一次。</p>', submitLabel: '核發代碼', onConfirm: async () => {
    const className = String($('#developer-class-name')?.value || '').trim();
    if (!className) throw new Error('請輸入班級名稱。');
    const result = await developerApi('developerIssueClassAdminCode', { className });
    await refreshDeveloperData();
    openCodeRevealModal({ eyebrow: 'ONE-TIME CLASS ACCESS', title: '班級管理者代碼已核發', code: result.code, note: '<p class="text-sm leading-6 text-slate-600">請立即複製並私下交給該班第一位管理者。原始代碼不會再次顯示，資料表只保存雜湊。</p><p class="mt-2 rounded-xl bg-red-50 px-3 py-2 text-xs font-bold leading-5 text-red-700">請勿把代碼貼到公開群組。</p>' });
  } });
}

function confirmDeveloperCodeRevoke(codeId) {
  const code = state.developerCodes.find(item => item.codeId === codeId); if (!code) return;
  openConfirmModal({ eyebrow: 'REVOKE CLASS ACCESS', title: `撤銷「${escapeHtml(code.className)}」管理者代碼？`, body: '<p>撤銷後此代碼不能再註冊班級管理者。已使用的代碼不可撤銷，既有班級與帳號不受影響。</p>', submitLabel: '確認撤銷', onConfirm: async () => { await developerApi('developerRevokeClassAdminCode', { codeId }); closeModal(); await refreshDeveloperData(); toast('班級管理者代碼已撤銷。', 'success'); } });
}

async function openDeveloperUserDetails(userId) {
  await busy($('#developer-root'), async () => {
    const user = await developerApi('developerGetUserDetails', { userId });
    const orderRows = (user.orders || []).map(order => `<li class="rounded-lg bg-mist px-3 py-2"><span class="font-bold">${escapeHtml(order.itemName || '餐點')}</span><span class="float-right tabular-nums">${money(order.totalPrice)}</span><p class="mt-1 text-[11px] text-slate-500">${escapeHtml(order.orderDate || '')} · ${escapeHtml(order.paymentStatus || '')}</p></li>`).join('') || '<li class="text-xs text-slate-500">尚無訂單紀錄。</li>';
    const transactionRows = (user.transactions || []).map(transaction => `<li class="flex justify-between gap-3 rounded-lg bg-mist px-3 py-2"><span>${escapeHtml(transaction.type || '')}</span><b class="tabular-nums">${money(transaction.amount)}</b></li>`).join('') || '<li class="text-xs text-slate-500">尚無交易紀錄。</li>';
    openConfirmModal({ eyebrow: 'ACCOUNT DETAILS', title: `${escapeHtml(user.name)} · ${escapeHtml(user.studentNo)}`, body: `<div class="space-y-3 text-sm"><div class="rounded-xl bg-mist px-3 py-3"><p><b>班級：</b>${escapeHtml(user.className || '未指定')}</p><p class="mt-1"><b>Email：</b>${escapeHtml(user.email || '')} · ${user.emailVerified ? '已驗證' : '未驗證'}</p><p class="mt-1"><b>座號：</b>${escapeHtml(user.seatNo || '')} · <b>角色：</b>${escapeHtml(user.role || '')}</p><p class="mt-1"><b>餘額：</b>${money(user.walletBalance)} · <b>狀態：</b>${user.isDisabled ? '已停用' : '啟用中'}</p></div><div><p class="mb-1 text-xs font-black text-ledger">訂單紀錄（${(user.orders || []).length}）</p><ul class="space-y-1">${orderRows}</ul></div><div><p class="mb-1 text-xs font-black text-ledger">交易紀錄（${(user.transactions || []).length}）</p><ul class="space-y-1">${transactionRows}</ul></div><p class="text-xs leading-5 text-slate-500">密碼雜湊、信箱驗證碼與登入憑證不會顯示。</p></div>`, submitLabel: '關閉', onConfirm: async () => { closeModal(); } });
  });
}

function toggleDeveloperUser(userId, isDisabled) {
  const user = state.developerUsers.find(item => item.id === userId); if (!user) return;
  openConfirmModal({ eyebrow: 'DEVELOPER ACCOUNT CONTROL', title: `${isDisabled ? '停用' : '恢復'} ${escapeHtml(user.name)}？`, body: `<p>${isDisabled ? '停用後此帳號無法登入、訂餐或使用 QR 驗證。既有訂單與交易紀錄仍會保留。' : '恢復後此帳號可以重新登入，但既有帳務資料不會變更。'}</p>`, submitLabel: isDisabled ? '確認停用' : '確認恢復', onConfirm: async () => { await developerApi('developerSetUserDisabled', { userId, isDisabled }); closeModal(); await refreshDeveloperData(); toast(`帳號已${isDisabled ? '停用' : '恢復'}。`, 'success'); } });
}

function confirmDeveloperUserDelete(userId) {
  const user = state.developerUsers.find(item => item.id === userId); if (!user) return;
  openConfirmModal({ eyebrow: 'PERMANENT ACCOUNT DELETE', title: `永久刪除 ${escapeHtml(user.name)}？`, body: '<p>這會刪除帳號個資、登入憑證、驗證資料與重設 Token。既有訂單與交易紀錄會保留為帳務紀錄，且此操作無法復原。</p><p class="mt-3 rounded-xl bg-red-50 px-3 py-3 text-xs font-bold leading-5 text-red-700">請先確認你選取的是正確帳號；刪除後只能重新註冊新帳號。</p>', submitLabel: '確認永久刪除', onConfirm: async () => { const result = await developerApi('developerDeleteUser', { userId }); closeModal(); await refreshDeveloperData(); toast(`帳號已刪除；保留 ${result.retainedOrderCount} 筆訂單與 ${result.retainedTransactionCount} 筆交易。`, 'success'); } });
}

async function developerLogout() {
  try { if (state.developerToken && apiConfigured()) await developerApi('developerLogout'); } catch (_) { /* 本機登出仍應完成。 */ }
  clearDeveloperSession(); state.authMode = 'developerLogin'; renderAuth(); toast('已登出開發者工作台。', 'success');
}

async function toggleUser(id, isDisabled) {
  const user = state.admin.users.find(u => u.id === id); if (!user) return;
  openConfirmModal({ eyebrow: '帳號管理', title: `${isDisabled ? '停用' : '恢復'} ${user.name} 的帳號？`, body: `<p>${isDisabled ? '停用後將不能登入與使用 QR 驗證。' : '恢復後將可以重新登入與使用系統。'}</p>`, submitLabel: isDisabled ? '確認停用' : '確認恢復', onConfirm: async () => { await api('adminSetUserDisabled', { userId: id, isDisabled }); closeModal(); toast('帳號狀態已更新。', 'success'); await refreshOrders(true); } });
}

function confirmUserDelete(id) {
  const user = state.admin.users.find(item => item.id === id); if (!user) return;
  openConfirmModal({ eyebrow: 'DELETE ACCOUNT', title: `刪除 ${user.name} 的帳號？`, body: '<p>此操作會刪除帳號個資、登入憑證與未使用驗證碼.既有訂單與交易會保留為帳務紀錄，並以「已刪除帳號」顯示。</p>', submitLabel: '確認永久刪除', onConfirm: async () => { const result = await api('adminDeleteUser', { userId: id }); closeModal(); toast(`帳號已刪除；保留 ${result.retainedOrderCount} 筆訂單與 ${result.retainedTransactionCount} 筆交易紀錄。`, 'success'); await refreshOrders(true); } });
}

function openDirectTopUp(id) {
  const user = state.admin.users.find(u => u.id === id); if (!user) return;
  openConfirmModal({ eyebrow: 'MANUAL TOP-UP', title: `為 ${user.name} 手動儲值`, body: `<p>目前餘額：<b class="text-stamp">${money(user.walletBalance)}</b></p><p class="mt-2 text-xs leading-5 text-slate-500">儲值金會優先抵扣既有現金未繳款項。</p><label class="mt-4 block"><span class="mb-1.5 block text-xs font-bold text-slate-600">本次實收金額</span><div class="relative"><input id="topup-amount" type="number" inputmode="decimal" min="1" max="100000" class="w-full rounded-xl border border-slate-200 px-3 py-3 pr-10 outline-none focus:border-ledger" placeholder="例如 100"/><span class="absolute right-3 top-3 text-sm text-slate-500">元</span></div></label>`, submitLabel: '確認儲值', onConfirm: async () => { const amount = Number($('#topup-amount').value); if (!amount || amount <= 0) throw new Error('請輸入正確的儲值金額。'); const data = await api('adminTopUp', { userId: user.id, amount }); closeModal(); toast(`${data.message}${data.appliedToDebt ? ` 已抵扣 ${money(data.appliedToDebt)} 欠款，剩餘欠款 ${money(data.remainingDebt)}。` : ''}`, 'success'); await refreshOrders(true); } });
}

function confirmCatalogDelete(action, data, title, description) {
  openConfirmModal({ eyebrow: '刪除確認', title, body: `<p>${escapeHtml(description)}</p>`, submitLabel: '確認刪除', onConfirm: async () => { await api(action, data); closeModal(); state.admin.catalog = null; await refreshOrders(true); toast('菜單資料已刪除。', 'success'); } });
}

async function copyOrderText() {
  const d = state.admin.dashboard; if (!d) return;
  const text = d.orders.map(o => `${o.seatNo}號 ${o.studentName} ${o.itemName}${o.selectedOptions.length ? '（' + o.selectedOptions.map(x => x.name).join('、') + '）' : ''}${o.note ? '｜' + o.note : ''}`).join('\n');
  try { await navigator.clipboard.writeText(text || '本日尚無訂單'); toast('電話訂餐格式已複製。', 'success'); } catch (_) { toast('無法直接複製，請確認瀏覽器權限。', 'error'); }
}

function exportCsv() {
  const d = state.admin.dashboard; if (!d) return;
  const headers = ['訂餐日期','店家','座號','姓名','學號','餐點','客製選項','備註','金額','付款狀態','取餐狀態'];
  const rows = d.orders.map(o => [o.orderDate, o.storeName, o.seatNo, o.studentName, o.studentNo, o.itemName, o.selectedOptions.map(x => x.name).join('、'), o.note, o.totalPrice, o.paymentStatus, o.pickupStatus]);
  const csv = '\uFEFF' + [headers, ...rows].map(row => row.map(value => `"${String(value ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' })); link.download = `班級訂午餐_${d.date}.csv`; document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(link.href); toast('CSV 已開始下載。', 'success');
}

function readFavorites() { try { const value = JSON.parse(localStorage.getItem('classLunch.favorites') || '[]'); return Array.isArray(value) ? value : []; } catch (_) { return []; } }
function saveFavorites(list) { try { localStorage.setItem('classLunch.favorites', JSON.stringify(list.slice(0, 12))); } catch (_) {} }
function recordFavorites(items) {
  const list = readFavorites();
  (items || []).forEach(item => {
    const key = String(item.itemId) + '|' + (item.optionIds || []).slice().sort().join(',');
    const existing = list.find(favorite => (String(favorite.itemId) + '|' + (favorite.optionIds || []).slice().sort().join(',')) === key);
    if (existing) { existing.count += 1; existing.lastAt = Date.now(); }
    else list.push({ itemId: item.itemId, optionIds: (item.optionIds || []).slice(), count: 1, lastAt: Date.now() });
  });
  list.sort((a, b) => (b.count - a.count) || (b.lastAt - a.lastAt));
  saveFavorites(list);
}
function quickAddFavorite(sessionId, itemId, optionIds) {
  const draft = getOrderDraft({ sessionId });
  if (!draft.items.some(entry => entry.itemId === itemId)) draft.items.push({ itemId, quantity: 1, optionIds: [] });
  const entry = draft.items.find(selected => selected.itemId === itemId);
  entry.optionIds = [...new Set([...(entry.optionIds || []), ...(optionIds || [])])];
}
function renderFavoriteChips(menuItems) {
  const favorites = readFavorites().filter(favorite => menuItems.some(item => item.itemId === favorite.itemId)).slice(0, 5);
  if (!favorites.length) return '';
  const chips = favorites.map(favorite => {
    const item = menuItems.find(candidate => candidate.itemId === favorite.itemId);
    const options = (favorite.optionIds || []).map(id => (item.options || []).find(option => option.optionId === id)).filter(Boolean);
    const label = `${escapeHtml(item.name)}${options.length ? '（' + options.map(option => escapeHtml(option.name)).join('、') + '）' : ''}`;
    return `<button type="button" data-action="quick-add-favorite" data-item-id="${escapeAttr(favorite.itemId)}" data-option-ids="${escapeAttr((favorite.optionIds || []).join(','))}" class="rounded-xl border border-ledger/15 bg-mist/60 px-3 py-2 text-left text-xs font-bold text-ledger">${label}<span class="ml-1 text-[10px] font-normal text-slate-400">×${favorite.count}</span></button>`;
  }).join('');
  return `<article class="rounded-[1.5rem] bg-white p-4 shadow-paper ring-1 ring-ledger/5"><div class="flex items-center justify-between"><p class="text-[11px] font-bold tracking-[.13em] text-stamp">常點的餐點</p><button type="button" data-action="clear-favorites" class="text-[10px] font-bold text-slate-400 underline underline-offset-4">清空</button></div><div class="mt-3 flex flex-wrap gap-2">${chips}</div><p class="mt-2 text-[10px] leading-4 text-slate-400">點一下直接加入購物車；只儲存在這台裝置。</p></article>`;
}
async function copyMyOrder(sessionId) {
  const session = state.sessions.find(candidate => candidate.sessionId === sessionId);
  const order = session?.existingOrder;
  if (!order) return toast('找不到訂單資料。', 'error');
  const items = (order.items || []).map(item => `${item.itemName}${Number(item.quantity || 1) > 1 ? `×${Number(item.quantity)}` : ''}${(item.selectedOptions || []).length ? `（${item.selectedOptions.map(option => option.name).join('、')}）` : ''}`).join('、');
  const statusText = order.paymentStatus === 'PaidWallet' ? '' : order.paymentStatus === 'PaidCash' ? '，現金已結清' : order.paymentStatus === 'PartiallyPaid' ? '，部分抵扣' : '，現金未繳';
  const text = `${formatDate(session.orderDate)}午餐：${items}｜合計 ${money(order.totalPrice)}${statusText}`;
  try { await navigator.clipboard.writeText(text); toast('訂單文字已複製。', 'success'); }
  catch (_) { toast('無法直接複製，請檢查瀏覽器權限。', 'error'); }
}
function updateLunchCountdowns() {
  if (state.view !== 'lunch' || state.operationPending) return;
  const now = Date.now();
  let expiredFound = false;
  $$('[data-countdown]').forEach(el => {
    const cutoff = new Date(el.dataset.countdown).getTime();
    if (!Number.isFinite(cutoff)) return;
    const remaining = cutoff - now;
    if (remaining <= 0) {
      el.textContent = '已截止';
      const sessionId = el.dataset.sessionId;
      if (sessionId && !state.closedSessionIds.has(sessionId)) { state.closedSessionIds.add(sessionId); expiredFound = true; }
    } else if (remaining < 60 * 60 * 1000) {
      el.textContent = `剩 ${Math.floor(remaining / 60000)} 分 ${String(Math.floor((remaining % 60000) / 1000)).padStart(2, '0')} 秒`;
    } else {
      el.textContent = `剩 ${Math.floor(remaining / 3600000)} 小時 ${Math.floor((remaining % 3600000) / 60000)} 分`;
    }
  });
  if (expiredFound) refreshOrders().catch(() => {});
}
function filteredDashboardOrders() {
  const d = state.admin.dashboard; if (!d) return [];
  const query = String(state.admin.orderQuery || '').trim().toLowerCase();
  return d.orders.filter(order => {
    if (state.admin.orderFilter === 'unpicked' && order.pickupStatus === 'PickedUp') return false;
    if (state.admin.orderFilter === 'picked' && order.pickupStatus !== 'PickedUp') return false;
    if (state.admin.orderFilter === 'unpaid' && !(Number(order.outstandingAmount) > 0)) return false;
    if (state.admin.orderFilter === 'paid' && Number(order.outstandingAmount) > 0) return false;
    if (query && !`${order.seatNo} ${order.studentName} ${order.studentNo} ${order.itemName} ${order.storeName}`.toLowerCase().includes(query)) return false;
    return true;
  });
}
function renderDashboardOrderList() {
  const root = $('#dashboard-orders'); if (!root) return;
  const orders = filteredDashboardOrders();
  root.innerHTML = orders.length ? orders.map(orderCard).join('') : emptyState('沒有符合條件的訂單', '試著調整篩選條件或搜尋關鍵字。');
}
function orderCard(order) {
  return `<article class="rounded-xl bg-white p-4 shadow-sm ring-1 ring-ledger/5"><div class="flex items-start justify-between gap-3"><div><p class="text-sm font-black">${escapeHtml(order.seatNo)}號 ${escapeHtml(order.studentName)} <span class="font-normal text-slate-500">${escapeHtml(order.studentNo)}</span></p><p class="mt-1 text-sm text-ledger">${escapeHtml(order.itemName)}${order.selectedOptions.length ? ` · ${order.selectedOptions.map(x => escapeHtml(x.name)).join('、')}` : ''}</p><p class="mt-1 text-xs text-slate-500">${escapeHtml(order.storeName)}${order.note ? ` · 備註：${escapeHtml(order.note)}` : ''}</p></div><div class="text-right"><b class="block text-sm tabular-nums text-ledger">${money(order.totalPrice)}</b><div class="mt-2 flex flex-wrap justify-end gap-1">${paymentBadge(order.paymentStatus)}${pickupBadge(order.pickupStatus)}</div></div></div></article>`;
}
// ---- 推播通知（Web Push / PWA 釘選到桌面）----
let deferredInstallPrompt = null;

function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i += 1) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

async function currentPushSubscription() {
  try {
    const registration = await navigator.serviceWorker.ready;
    return await registration.pushManager.getSubscription();
  } catch (_) { return null; }
}

function pushKeysOf(subscription) {
  return {
    endpoint: subscription.endpoint,
    keys: {
      p256dh: btoa(String.fromCharCode(...new Uint8Array(subscription.getKey('p256dh')))),
      auth: btoa(String.fromCharCode(...new Uint8Array(subscription.getKey('auth')))),
    },
  };
}

async function subscribeToPush() {
  if (!pushSupported()) return toast('此瀏覽器不支援推播通知；請改用 Chrome／Edge，並把網站釘選到桌面。', 'error');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') { await updateNotificationUI(); return toast('通知權限未開啟，將無法收到提醒。', 'error'); }
  const publicKey = state.publicConfig?.vapidPublicKey;
  if (!publicKey) return toast('推播服務尚未設定（缺少 VAPID 金鑰）。', 'error');
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
    await api('pushSubscribe', { ...pushKeysOf(subscription), deviceLabel: `${navigator.platform || ''} ${/iPhone|iPad|iPod/i.test(navigator.userAgent) ? 'iOS' : ''}`.trim() });
    await updateNotificationUI();
    toast('已開啟手機通知：新場次、截止與取餐提醒會直接送到這裡。', 'success');
  } catch (error) {
    await updateNotificationUI();
    toast(error.message || '開啟通知失敗，請稍後再試。', 'error');
  }
}

async function unsubscribeFromPush() {
  const subscription = await currentPushSubscription();
  if (subscription) {
    try { await api('pushUnsubscribe', { endpoint: subscription.endpoint }); } catch (_) { /* 本機取消仍應完成。 */ }
    await subscription.unsubscribe();
  }
  await updateNotificationUI();
  toast('已關閉手機通知。', 'success');
}

async function updateNotificationUI() {
  const status = $('#notification-status');
  const sw = $('#notification-switch');
  if (!status || !sw) return;
  if (!pushSupported()) {
    status.textContent = '此瀏覽器不支援（請用 Chrome／Edge 並釘選到桌面）';
    sw.className = 'grid h-6 w-11 shrink-0 place-items-center rounded-full bg-slate-200 transition';
    sw.innerHTML = '<span class="h-4 w-4 rounded-full bg-white shadow"></span>';
    return;
  }
  const subscription = await currentPushSubscription();
  const enabled = Boolean(subscription);
  status.textContent = enabled ? '已開啟：新場次、截止與取餐提醒' : '未開啟：新場次、截止與取餐提醒';
  sw.className = `grid h-6 w-11 shrink-0 place-items-center rounded-full transition ${enabled ? 'bg-stamp' : 'bg-slate-200'}`;
  sw.innerHTML = `<span class="h-4 w-4 rounded-full bg-white shadow transition ${enabled ? 'translate-x-3' : ''}"></span>`;
  // 同一裝置換人登入時，把訂閱對應到目前使用者
  if (enabled && state.token) {
    try { await api('pushSubscribe', { ...pushKeysOf(subscription), deviceLabel: '同步裝置訂閱' }); } catch (_) { /* 忽略 */ }
  }
}

function renderInstallButton() {
  const button = $('#install-app-button');
  if (!button) return;
  button.classList.remove('hidden');
  button.classList.add('flex');
}

// ----代碼顯示視窗（必須確認已複製才能關閉）----
function openCodeRevealModal({ eyebrow, title, code, note = '' }) {
  closeModal();
  const root = $('#modal-root');
  root.innerHTML = `<div class="fixed inset-0 z-50 flex items-end bg-ledger/60 p-3 sm:items-center sm:justify-center"><section class="modal-enter w-full max-w-md rounded-[1.5rem] bg-white p-5 shadow-lift"><p class="text-[11px] font-bold tracking-[.13em] text-slate-500">${escapeHtml(eyebrow || 'ONE-TIME CODE')}</p><h2 class="mt-1 font-serif text-xl font-black">${escapeHtml(title)}</h2><div class="mt-3 text-sm leading-6 text-slate-600">${note}</div><div class="mt-4 rounded-xl bg-mist px-4 py-5 text-center"><code id="reveal-code" class="break-all text-2xl font-black tracking-[.16em] text-ledger">${escapeHtml(code)}</code></div><div class="mt-4 grid grid-cols-2 gap-2"><button data-action="copy-reveal-code" data-code="${escapeAttr(code)}" class="rounded-xl bg-mist px-4 py-3 text-sm font-bold text-ledger">複製代碼</button><button data-action="share-reveal-code" data-code="${escapeAttr(code)}" data-title="${escapeAttr(title)}" class="rounded-xl bg-stamp px-4 py-3 text-sm font-bold text-white">分享</button></div><button data-action="reveal-done" class="mt-2 w-full rounded-xl bg-ledger px-4 py-3.5 text-sm font-bold text-white">我已複製代碼</button><p class="mt-3 text-center text-xs text-slate-400">請先複製或分享，再關閉此視窗。</p></section></div>`;
}

async function copyRevealCode(code) {
  try { await navigator.clipboard.writeText(code); toast('代碼已複製。', 'success'); }
  catch (_) {
    try {
      const textarea = document.createElement('textarea');
      textarea.value = code; textarea.style.position = 'fixed'; textarea.style.opacity = '0';
      document.body.appendChild(textarea); textarea.select(); document.execCommand('copy'); textarea.remove();
      toast('代碼已複製。', 'success');
    } catch (__) { toast('無法自動複製，請長按選取代碼後手動複製。', 'error'); }
  }
}

async function shareRevealCode(title, code) {
  const text = `${title}：${code}（訂餐通）`;
  if (navigator.share) {
    try { await navigator.share({ title: '訂餐通', text }); return; } catch (_) { /* 使用者取消或失敗，改為複製。 */ }
  }
  await copyRevealCode(code);
  toast('已複製，可貼到 LINE／Messenger 等平台。', 'success');
}

// ----釘選到桌面引導（不會自動消失）----
function openInstallGuideModal() {
  closeModal();
  const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
  const isAndroid = /Android/i.test(navigator.userAgent);
  const steps = isIOS
    ? ['在 Safari 開啟本網站', '點下方「分享」按鈕（⬆️ 圖示）', '選擇「加入主畫面」', '從主畫面開啟後，即可接收通知']
    : isAndroid
      ? ['在 Chrome 開啟本網站', '點右上角「⋮」選單', '選擇「加到主畫面」或「安裝應用程式」', '從主畫面開啟後，即可接收通知']
      : ['在網址列右側找「安裝」圖示（⊕ 或下載圖示）', '點「安裝」', '安裝後即可像 App 一樣使用並接收通知'];
  const root = $('#modal-root');
  root.innerHTML = `<div class="fixed inset-0 z-50 flex items-end bg-ledger/60 p-3 sm:items-center sm:justify-center"><section class="modal-enter w-full max-w-md rounded-[1.5rem] bg-white p-5 shadow-lift"><p class="text-[11px] font-bold tracking-[.13em] text-slate-500">INSTALL GUIDE</p><h2 class="mt-1 font-serif text-xl font-black">把訂餐通釘選到桌面</h2><p class="mt-2 text-sm leading-6 text-slate-500">釘選後就像手機 App 一樣使用；手機通知也需在釘選後開啟。${isIOS ? '<b class="text-red-600">iPhone 需 iOS 16.4 以上。</b>' : ''}</p><ol class="mt-4 space-y-2">${steps.map((step, index) => `<li class="flex items-center gap-3 rounded-xl bg-mist px-3 py-3 text-sm"><b class="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-ledger text-xs text-white">${index + 1}</b><span>${step}</span></li>`).join('')}</ol>${deferredInstallPrompt ? '<button data-action="install-app-confirm" class="mt-4 w-full rounded-xl bg-ledger px-4 py-3.5 text-sm font-bold text-white">立即安裝</button>' : ''}<button data-action="close-modal" class="mt-2 w-full rounded-xl bg-mist px-4 py-3.5 text-sm font-bold text-ledger">我了解了，稍後再裝</button></section></div>`;
}

// ----管理員角色管理（指定／移除管理者）----
function confirmAdminRoleChange(userId, role) {
  const user = state.admin.users.find(item => item.id === userId); if (!user) return;
  const isPromote = role === 'Admin';
  openConfirmModal({
    eyebrow: isPromote ? 'PROMOTE ADMIN' : 'DEMOTE ADMIN',
    title: `${isPromote ? '將' : '移除'} ${user.name} 的管理者權限？`,
    body: isPromote
      ? '<p>對方將可建立場次、掃碼核銷、儲值、管理菜單與班級設定。</p>'
      : '<p>移除後對方回到一般學生權限，無法再使用管理工作台。</p><p class="mt-2 rounded-xl bg-mist px-3 py-2 text-xs leading-5 text-slate-500">系統會保留至少一位管理者，也不能移除自己的管理權限。</p>',
    submitLabel: isPromote ? '確認設為管理者' : '確認移除管理者',
    onConfirm: async () => {
      const result = await api('adminSetRole', { userId, role });
      closeModal();
      toast(result.message || '角色已更新。', 'success');
      await renderAdminUsers($('#admin-content'));
    },
  });
}

// ----開發者郵件服務檢查----
async function developerCheckEmail() {
  const target = $('#developer-email-diagnostics');
  if (target) target.textContent = '檢查中…';
  try {
    const diagnostics = await developerApi('developerGetEmailDiagnostics');
    if (target) { target.textContent = diagnostics.message; target.className = `mt-1 text-xs leading-5 ${diagnostics.gmailAuthorized ? 'text-stamp' : 'text-red-600'}`; }
  } catch (error) { if (target) { target.textContent = error.message; target.className = 'mt-1 text-xs leading-5 text-red-600'; } }
}

async function developerBroadcast() {
  const message = String($('#developer-broadcast-message')?.value || '').trim();
  if (!message) return toast('請輸入廣播內容。', 'error');
  await busy($('#developer-broadcast-message'), async () => {
    const result = await developerApi('developerBroadcast', { message });
    toast(`廣播已送出：成功 ${result.sent}/${result.attempted} 台裝置。`, 'success');
    const input = $('#developer-broadcast-message');
    if (input) input.value = '';
  });
}

async function developerSetMaintenance(enabled, button = null) {
  await busy(button || $('#developer-maintenance'), async () => {
    await developerApi('developerSetMaintenance', { enabled });
    toast(enabled ? '已開啟維修模式。' : '維修模式已關閉。', 'success');
    await refreshDeveloperData();
  });
}

let developerAccountsCache = [];

async function developerResendVerificationCode() {
  const username = String($('#developer-verify-form [name="username"]')?.value || '').trim();
  if (!username) return toast('請先輸入開發者帳號。', 'error');
  await busy($('#developer-verify-form'), async () => {
    const result = await api('developerResendVerification', { username });
    toast(result.message || '驗證碼已重新寄出。', 'success');
  });
}

async function loadDeveloperAccounts() {
  const container = $('#developer-accounts');
  if (!container) return;
  try {
    const developers = await developerApi('developerListDevelopers');
    developerAccountsCache = developers;
    const selfId = state.developer && state.developer.id;
    container.innerHTML = developers.map(developer => {
      const isSelf = String(developer.id) === String(selfId);
      const canDelete = !isSelf && developers.length > 1;
      return `<div class="flex items-center justify-between gap-2 rounded-xl bg-white px-3 py-2.5 ring-1 ring-ledger/5"><div class="min-w-0"><p class="truncate text-xs font-black ${isSelf ? 'text-stamp' : 'text-ledger'}">${escapeHtml(developer.username)}${isSelf ? ' <span class="font-normal text-slate-400">（目前帳號）</span>' : ''}</p><p class="mt-0.5 truncate text-[10px] text-slate-500">${escapeHtml(developer.email)} · Email ${developer.emailVerified ? '已驗證' : '未驗證'}${developer.isDisabled ? ' · 已停用' : ''}</p></div><button type="button" data-action="developer-delete-developer" data-id="${escapeAttr(developer.id)}" ${canDelete ? '' : 'disabled'} class="shrink-0 rounded-lg px-2.5 py-2 text-[11px] font-bold ${canDelete ? 'bg-red-50 text-red-700' : 'bg-slate-100 text-slate-400'}">刪除</button></div>`;
    }).join('');
  } catch (_) {
    container.innerHTML = '<p class="text-xs text-slate-400">暫時無法載入。</p>';
  }
}


function confirmDeveloperWipeData() {
  openConfirmModal({
    eyebrow: 'WIPE DATA (1/3)',
    title: '警告：你即將刪除所有營運資料',
    body: '<p class="text-sm">這會刪除系統內所有的班級、使用者、訂單與交易紀錄。這是無法復原的毀滅性操作。</p>',
    submitLabel: '我了解，繼續 (1/3)',
    onConfirm: async () => {
      closeModal();
      setTimeout(() => {
        openConfirmModal({
          eyebrow: 'WIPE DATA (2/3)',
          title: '再次確認：資料將永久遺失',
          body: '<p class="text-sm">請再次確認，除了學校與店家外，所有的學生個資與歷史訂單都會被直接清空。</p>',
          submitLabel: '確認，下一步 (2/3)',
          onConfirm: async () => {
            closeModal();
            setTimeout(() => {
              openConfirmModal({
                eyebrow: 'WIPE DATA (3/3)',
                title: '最終確認：發送刪除信',
                body: '<p class="text-sm">為了安全，我們將發送一封附帶執行連結的信件到你的開發者信箱，你必須點擊該連結才能真正刪除資料。</p>',
                submitLabel: '發送刪除確認信',
                onConfirm: async () => {
                  const result = await developerApi('developerRequestWipeData', {});
                  closeModal();
                  toast(result.message || '已發送確認信，請查收。', 'success');
                }
              });
            }, 300);
          }
        });
      }, 300);
    }
  });
}
function confirmDeveloperDelete(developerId) {
  const target = developerAccountsCache.find(item => String(item.id) === String(developerId));
  openConfirmModal({
    eyebrow: 'DELETE DEVELOPER',
    title: `刪除開發者「${target ? target.username : ''}」？`,
    body: '<p>刪除後該開發者無法再登入；其已核發的班級管理者代碼與班級資料不受影響。</p><p class="mt-2 rounded-xl bg-red-50 px-3 py-2 text-xs font-bold leading-5 text-red-700">此動作無法復原，系統至少需保留一位開發者。</p>',
    submitLabel: '確認刪除開發者',
    onConfirm: async () => {
      const result = await developerApi('developerDeleteDeveloper', { developerId });
      closeModal();
      toast(result.message || '開發者帳號已刪除。', 'success');
      await refreshDeveloperData();
      await loadDeveloperAccounts();
    },
  });
}

async function submitMerchantSave(action, form, message, rerender) {
  const data = formData(form);
  await busy(form, async () => { const result = await merchantApi(action, data); toast(typeof message === 'function' ? message(result) : message, 'success'); await rerender(); });
}

async function merchantToggleOrdering() {
  await busy($('#merchant-content'), async () => {
    const data = await merchantApi('merchantGetMenu');
    if (!data.store) return toast('尚未綁定店家。', 'error');
    await merchantApi('merchantSaveStore', { orderingOpen: !data.store.orderingOpen });
    toast(data.store.orderingOpen ? '已暫停訂購。' : '已開啟訂購。', 'success');
    renderMerchantContent();
  });
}

function confirmMerchantItemDelete(itemId) {
  openConfirmModal({ eyebrow: 'DELETE ITEM', title: '刪除餐點？', body: '<p>已有訂單使用的餐點無法刪除。</p>', submitLabel: '確認刪除', onConfirm: async () => { await merchantApi('merchantDeleteMenuItem', { itemId }); closeModal(); toast('餐點已刪除。', 'success'); renderMerchantMenu($('#merchant-content')); } });
}

function confirmMerchantOptionDelete(optionId) {
  openConfirmModal({ eyebrow: 'DELETE OPTION', title: '刪除選項？', body: '<p>已有訂單使用的選項無法刪除。</p>', submitLabel: '確認刪除', onConfirm: async () => { await merchantApi('merchantDeleteItemOption', { optionId }); closeModal(); toast('選項已刪除。', 'success'); renderMerchantMenu($('#merchant-content')); } });
}

function openStoreBrowserModal() {
  const catalog = state.admin.catalog;
  if (!catalog || !catalog.stores || !catalog.stores.length) return toast('尚無店家可選，請先建立店家。', 'error');
  closeModal();
  const root = $('#modal-root');
  const stores = catalog.stores;
  root.innerHTML = `<div class="fixed inset-0 z-50 flex items-end bg-ledger/60 p-3 sm:items-center sm:justify-center"><section class="modal-enter flex max-h-[85dvh] w-full max-w-md flex-col rounded-[1.5rem] bg-paper p-4 shadow-lift"><p class="text-[11px] font-bold tracking-[.13em] text-stamp">PICK A STORE</p><h2 class="mt-1 font-serif text-xl font-black">選擇店家</h2><p class="mt-1 text-xs text-slate-500">店家數量多時可上下滑動瀏覽；點「詳細資訊」查看菜單。</p><div class="mt-3 flex-1 space-y-3 overflow-y-auto pb-2">${stores.map(store => { const items = catalog.items.filter(item => item.storeId === store.storeId); return `<article class="rounded-xl bg-white p-3 shadow-sm ring-1 ring-ledger/5"><div class="flex items-start justify-between gap-2"><div class="min-w-0"><p class="text-sm font-black">${escapeHtml(store.name)}${store.isGlobal ? ' <span class="ml-1 rounded bg-ledger/10 px-1.5 py-0.5 text-[9px] font-black text-ledger">全體共用</span>' : ''}${store.businessHours ? ` <span class="text-[10px] font-normal text-slate-400">${escapeHtml(store.businessHours)}</span>` : ''}</p>${store.description ? `<p class="mt-0.5 text-[11px] leading-5 text-slate-500">${escapeHtml(store.description)}</p>` : ''}${store.contact ? `<p class="mt-0.5 text-[11px] text-slate-500">聯絡：${escapeHtml(store.contact)}</p>` : ''}</div><div class="flex shrink-0 flex-col gap-1.5"><button data-action="store-details" data-id="${escapeAttr(store.storeId)}" class="rounded-lg bg-mist px-3 py-2 text-[11px] font-bold text-ledger">詳細資訊</button><button data-action="pick-store" data-id="${escapeAttr(store.storeId)}" data-name="${escapeAttr(store.name)}" class="rounded-lg bg-ledger px-3 py-2 text-[11px] font-bold text-white">使用此店家</button></div></div><p class="mt-1 text-[10px] text-slate-400">共 ${items.length} 項品項</p></article>`; }).join('')}</div><button data-action="close-modal" class="mt-2 w-full rounded-xl bg-mist px-4 py-3 text-sm font-bold text-ledger">取消</button></section></div>`;
}

function openStoreDetailsModal(storeId) {
  const catalog = state.admin.catalog;
  const store = catalog?.stores?.find(item => item.storeId === storeId);
  if (!store) return;
  const items = (catalog.items || []).filter(item => item.storeId === storeId);
  const options = catalog.options || [];
  closeModal();
  const root = $('#modal-root');
  root.innerHTML = `<div class="fixed inset-0 z-50 flex items-end bg-ledger/60 p-3 sm:items-center sm:justify-center"><section class="modal-enter flex max-h-[85dvh] w-full max-w-md flex-col rounded-[1.5rem] bg-paper p-4 shadow-lift"><p class="text-[11px] font-bold tracking-[.13em] text-stamp">STORE DETAILS</p><h2 class="mt-1 font-serif text-xl font-black">${escapeHtml(store.name)}</h2>${store.description ? `<p class="mt-2 text-sm leading-6 text-slate-600">${escapeHtml(store.description)}</p>` : ''}<div class="mt-2 space-y-1 text-xs text-slate-500">${store.contact ? `<p>聯絡：${escapeHtml(store.contact)}</p>` : ''}${store.businessHours ? `<p>營業時間：${escapeHtml(store.businessHours)}</p>` : ''}</div><div class="mt-3 flex-1 space-y-2 overflow-y-auto pb-2">${items.length ? items.map(item => `<div class="rounded-xl bg-white p-3 shadow-sm ring-1 ring-ledger/5"><div class="flex justify-between text-sm"><b>${escapeHtml(item.name)}</b><span>${money(item.basePrice)}</span></div>${options.filter(option => option.itemId === item.itemId).length ? `<p class="mt-1 text-[11px] text-slate-500">${options.filter(option => option.itemId === item.itemId).map(option => `${escapeHtml(option.name)} (${signedMoney(option.priceAdjustment)})`).join(' · ')}</p>` : ''}</div>`).join('') : '<p class="rounded-xl bg-white px-4 py-6 text-center text-xs text-slate-400">這間店家還沒有餐點。</p>'}</div><div class="mt-2 flex gap-2"><button data-action="pick-store" data-id="${escapeAttr(store.storeId)}" data-name="${escapeAttr(store.name)}" class="flex-1 rounded-xl bg-ledger px-4 py-3 text-sm font-bold text-white">使用此店家</button><button data-action="close-modal" class="rounded-xl bg-mist px-4 py-3 text-sm font-bold text-ledger">關閉</button></div></section></div>`;
}

function confirmAdminItemDelete(itemId) {
  const item = state.admin.catalog?.items?.find(entry => entry.itemId === itemId);
  openConfirmModal({ eyebrow: 'DELETE ITEM', title: `刪除餐點「${item ? item.name : ''}」？`, body: '<p>已有訂單使用的餐點無法刪除。</p>', submitLabel: '確認刪除', onConfirm: async () => { await api('adminDeleteMenuItem', { itemId }); closeModal(); state.admin.catalog = null; await renderAdminCatalog($('#admin-content')); toast('餐點已刪除。', 'success'); } });
}

function confirmAdminOptionDelete(optionId) {
  openConfirmModal({ eyebrow: 'DELETE OPTION', title: '刪除客製選項？', body: '<p>已有訂單使用的選項無法刪除。</p>', submitLabel: '確認刪除', onConfirm: async () => { await api('adminDeleteItemOption', { optionId }); closeModal(); state.admin.catalog = null; await renderAdminCatalog($('#admin-content')); toast('選項已刪除。', 'success'); } });
}
function openDeductModal(userId) {
  const user = state.admin.users.find(item => item.id === userId);
  if (!user) return;
  openConfirmModal({
    eyebrow: 'MANUAL DEDUCT',
    title: `從 ${user.name} 的錢包扣款`, body: `<p class="text-sm text-slate-500">目前餘額 <b class="text-ledger">${money(user.walletBalance)}</b>。扣款不可超過餘額。</p><label class="mt-4 block"><span class="mb-1.5 block text-xs font-bold text-slate-600">扣款金額</span><input id="deduct-amount" type="number" min="1" step="1" inputmode="numeric" required class="w-full rounded-xl border border-slate-200 px-3 py-3 outline-none focus:border-ledger"/></label><label class="mt-3 block"><span class="mb-1.5 block text-xs font-bold text-slate-600">原因（選填）</span><input id="deduct-note" maxlength="120" placeholder="例如：代訂書籍扣款" class="w-full rounded-xl border border-slate-200 px-3 py-3 outline-none focus:border-ledger"/></label>`, submitLabel: '確認扣款', onConfirm: async () => {
      const amount = Number($('#deduct-amount')?.value);
      if (!Number.isFinite(amount) || amount <= 0) throw new Error('請輸入正確的扣款金額。');
      const result = await api('adminDeductBalance', { userId, amount, note: $('#deduct-note')?.value || '' });
      closeModal();
      toast(result.message || '扣款完成。', 'success');
      await refreshOrders(true);
    },
  });
}

function confirmApplicationApprove(applicationId) {
  openConfirmModal({ eyebrow: 'APPROVE', title: '核准此申請？', body: '<p>核准後系統會自動產生一組管理者代碼，並<strong>寄送至申請人的 Email</strong>。</p>', submitLabel: '核准並寄送代碼', onConfirm: async () => {
    const result = await developerApi('developerApproveApplication', { applicationId });
    closeModal();
    toast(result.emailed ? '已核准，管理者代碼已寄送至申請人信箱。' : '已核准，但代碼寄送失敗（請檢查郵件設定）。', result.emailed ? 'success' : 'error');
    renderDeveloperApplications($('#developer-content'));
  } });
}

function confirmApplicationReject(applicationId) {
  openConfirmModal({ eyebrow: 'REJECT', title: '駁回此申請？', body: '<p>申請人不會收到通知，此操作無法復原。</p>', submitLabel: '確認駁回', onConfirm: async () => { await developerApi('developerRejectApplication', { applicationId }); closeModal(); toast('申請已駁回。', 'success'); renderDeveloperApplications($('#developer-content')); } });
}

async function developerToggleMerchant(merchantId, isDisabled) {
  await busy($('#developer-content'), async () => { await developerApi('developerSetMerchantDisabled', { merchantId, isDisabled }); toast(isDisabled ? '店家帳號已停用。' : '店家帳號已恢復。', 'success'); renderDeveloperMerchants($('#developer-content')); });
}

function confirmMerchantApprove(merchantId) {
  openConfirmModal({ eyebrow: 'APPROVE MERCHANT', title: '核准此店家？', body: '<p>核准後系統會自動為店家建立共用店家，並<strong>直接加入所有班級的場次店家選擇清單</strong>。</p>', submitLabel: '核准店家', onConfirm: async () => { const result = await developerApi('developerApproveMerchant', { merchantId }); closeModal(); toast(result.message || '店家已核准。', 'success'); renderDeveloperMerchants($('#developer-content')); } });
}

async function renderDeveloperSchools(root) {
  root.innerHTML = `<section class="rounded-[1.5rem] bg-white p-5 shadow-paper ring-1 ring-ledger/5"><div class="flex items-start justify-between gap-3"><div><p class="text-[11px] font-bold tracking-[.13em] text-stamp">SCHOOLS</p><h2 class="mt-1 font-serif text-xl font-black text-ledger">學校管理</h2><p class="mt-2 text-xs leading-5 text-slate-500">學校清單會出現在註冊、登入與申請介面；全體菜單可設定為學校專屬。</p></div><button data-action="developer-refresh" class="shrink-0 rounded-xl bg-mist px-3 py-2.5 text-xs font-bold text-ledger">重新整理</button></div><form id="school-form-dev" class="mt-4 rounded-xl bg-mist p-3"><p class="text-xs font-black text-ledger">新增／編輯學校</p><div class="mt-2 grid grid-cols-[1fr_1fr_auto] gap-2"><input name="schoolId" type="hidden"/><input name="name" required maxlength="80" class="min-w-0 rounded-lg border border-slate-200 bg-white px-2 py-2 text-xs outline-none focus:border-ledger" placeholder="學校名稱"/><input name="emailDomain" maxlength="80" class="min-w-0 rounded-lg border border-slate-200 bg-white px-2 py-2 text-xs outline-none focus:border-ledger" placeholder="Email後綴（選填）"/><button class="rounded-lg bg-ledger px-3 text-xs font-bold text-white">儲存</button></div></form><div id="school-list" class="mt-4 space-y-2">${skeletonLines(2)}</div></section>`;
  try {
    const schools = await developerApi('developerListSchools');
    $('#school-list').innerHTML = schools.length ? schools.map(school => `<div class="flex items-center justify-between rounded-xl border border-ledger/10 bg-mist/40 px-3 py-2.5"><div><p class="text-sm font-black">${escapeHtml(school.name)}</p><p class="mt-0.5 text-[11px] text-slate-500">${escapeHtml(school.emailDomain || '未設定 Email 後綴')}${school.isActive ? '' : ' ·已停用'}</p></div><button type="button" data-action="developer-edit-school" data-id="${escapeAttr(school.schoolId)}" data-name="${escapeAttr(school.name)}" data-domain="${escapeAttr(school.emailDomain)}" class="rounded-lg bg-white px-2.5 py-2 text-[11px] font-bold text-ledger ring-1 ring-ledger/10">編輯</button></div>`).join('') : emptyState('尚未新增學校', '新增學校後，使用者註冊與登入時即可選擇學校。');
  } catch (error) { $('#school-list').innerHTML = errorBlock(error.message); }
}

async function renderDeveloperApplications(root) {
  root.innerHTML = `<section class="rounded-[1.5rem] bg-white p-5 shadow-paper ring-1 ring-ledger/5"><div class="flex items-start justify-between gap-3"><div><p class="text-[11px] font-bold tracking-[.13em] text-stamp">APPLICATIONS</p><h2 class="mt-1 font-serif text-xl font-black text-ledger">管理者代碼申請</h2><p class="mt-2 text-xs leading-5 text-slate-500">申請人完成信箱驗證後才會出現在待審核清單；核准即核發一組管理者代碼。</p></div><button data-action="developer-refresh" class="shrink-0 rounded-xl bg-mist px-3 py-2.5 text-xs font-bold text-ledger">重新整理</button></div><div id="application-list" class="mt-4 space-y-2">${skeletonLines(3)}</div></section>`;
  try {
    const applications = await developerApi('developerListApplications');
    $('#application-list').innerHTML = applications.length ? applications.map(application => `<article class="rounded-xl border border-ledger/10 bg-mist/40 p-3"><div class="flex items-start justify-between gap-3"><div class="min-w-0"><p class="text-sm font-black">${escapeHtml(application.studentName)} <span class="font-normal text-slate-500">${escapeHtml(application.studentNo)}</span></p><p class="mt-1 text-[11px] text-slate-500">${escapeHtml(application.className)} · ${escapeHtml(application.schoolName)} · ${escapeHtml(application.email)} · ${escapeHtml(application.contactPhone)}</p><p class="mt-1 text-[11px] ${application.emailVerified ? 'text-stamp' : 'text-apricot'}">Email ${application.emailVerified ? '已驗證' : '未驗證'} · ${application.status === 'Pending' ? '待審核' : application.status === 'Approved' ? '已核准' : '已駁回'}</p></div>${application.status === 'Pending' ? `<div class="flex shrink-0 flex-col gap-1.5"><button data-action="developer-approve-application" data-id="${escapeAttr(application.applicationId)}" ${application.emailVerified ? '' : 'disabled'} class="rounded-lg bg-ledger px-2.5 py-2 text-[11px] font-bold text-white disabled:opacity-40">核准</button><button data-action="developer-reject-application" data-id="${escapeAttr(application.applicationId)}" class="rounded-lg bg-red-50 px-2.5 py-2 text-[11px] font-bold text-red-700">駁回</button></div>` : ''}</div></article>`).join('') : emptyState('目前沒有申請', '申請人送出申請並完成信箱驗證後會出現在這裡。');
  } catch (error) { $('#application-list').innerHTML = errorBlock(error.message); }
}

async function renderDeveloperMerchants(root) {
  root.innerHTML = `<section class="rounded-[1.5rem] bg-white p-5 shadow-paper ring-1 ring-ledger/5"><div class="flex items-start justify-between gap-3"><div><p class="text-[11px] font-bold tracking-[.13em] text-stamp">MERCHANTS</p><h2 class="mt-1 font-serif text-xl font-black text-ledger">店家合作帳號</h2><p class="mt-2 text-xs leading-5 text-slate-500">店家可自行管理菜單與訂單；開發者可在此停用或恢復店家帳號。</p></div><button data-action="developer-refresh" class="shrink-0 rounded-xl bg-mist px-3 py-2.5 text-xs font-bold text-ledger">重新整理</button></div><div id="merchant-list" class="mt-4 space-y-2">${skeletonLines(3)}</div></section>`;
  try {
    const merchants = await developerApi('developerListMerchants');
    $('#merchant-list').innerHTML = merchants.length ? merchants.map(merchant => `<div class="flex items-center justify-between rounded-xl border border-ledger/10 bg-mist/40 px-3 py-2.5"><div class="min-w-0"><p class="text-sm font-black">${escapeHtml(merchant.merchantName)} ${merchant.isApproved ? '<span class="ml-1 rounded bg-stamp/10 px-1.5 py-0.5 text-[9px] font-bold text-stamp">已核准</span>' : '<span class="ml-1 rounded bg-apricot/15 px-1.5 py-0.5 text-[9px] font-bold text-apricot">待審核</span>'}</p><p class="mt-0.5 truncate text-[11px] text-slate-500">${escapeHtml(merchant.ownerName)} · ${escapeHtml(merchant.ownerPhone)} · ${escapeHtml(merchant.email)}${merchant.emailVerified ? '' : ' ·未驗證'}</p><p class="mt-0.5 text-[11px] text-slate-400">店家：${escapeHtml(merchant.storeName || '尚未開店')}${merchant.isDisabled ? ' ·已停用' : ''}</p></div><div class="flex shrink-0 flex-col gap-1.5">${merchant.isApproved ? '' : `<button data-action="developer-approve-merchant" data-id="${escapeAttr(merchant.merchantId)}" ${merchant.emailVerified ? '' : 'disabled'} class="rounded-lg bg-ledger px-2.5 py-2 text-[11px] font-bold text-white disabled:opacity-40">核准</button>`}<button data-action="developer-toggle-merchant" data-id="${escapeAttr(merchant.merchantId)}" data-disabled="${merchant.isDisabled ? 'false' : 'true'}" class="rounded-lg px-2.5 py-2 text-[11px] font-bold ${merchant.isDisabled ? 'bg-stamp/10 text-stamp' : 'bg-red-50 text-red-700'}">${merchant.isDisabled ? '恢復' : '停用'}</button></div></div>`).join('') : emptyState('尚無店家帳號', '店家在登入頁「店家合作」註冊後會出現在這裡。');
  } catch (error) { $('#merchant-list').innerHTML = errorBlock(error.message); }
}

async function api(action, data = {}, token = state.token, throwWhenUnconfigured = true) {
  if (!apiConfigured()) { if (throwWhenUnconfigured) throw new Error('尚未連接後端服務。'); return {}; }
  const response = await fetch(window.LUNCH_CONFIG.apiUrl, { method: 'POST', redirect: 'follow', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action, data, token }) });
  if (!response.ok) throw new Error(`伺服器連線失敗（${response.status}）。`);
  let json; try { json = await response.json(); } catch (_) { throw new Error('伺服器回傳格式無法辨識，請確認 Web App 已部署為可存取。'); }
  if (!json.ok) throw new Error(json.error || '系統暫時無法完成此操作。');
  return json.data;
}

function apiConfigured() { const url = window.LUNCH_CONFIG && window.LUNCH_CONFIG.apiUrl || ''; return url === '/api/gas' || /^https:\/\/script\.google\.com\//.test(url); }
function saveSession(result) { state.token = result.token; state.user = result.user; localStorage.setItem('classLunch.token', state.token); localStorage.setItem('classLunch.user', JSON.stringify(state.user)); }
function saveDeveloperSession(result) { state.developerToken = result.token; state.developer = result.developer; const store = sessionStore(); if (store) { store.setItem('classLunch.developerToken', state.developerToken); store.setItem('classLunch.developer', JSON.stringify(state.developer)); } }
function clearDeveloperSession() { state.developerToken = ''; state.developer = null; state.developerUsers = []; state.developerCodes = []; const store = sessionStore(); if (store) { store.removeItem('classLunch.developerToken'); store.removeItem('classLunch.developer'); } }
function developerApi(action, data = {}) { return api(action, data, state.developerToken); }
function syncUser() { localStorage.setItem('classLunch.user', JSON.stringify(state.user)); const h = $('#header-wallet'); if (h) h.textContent = money(state.user.walletBalance); }
function clearSession() { state.token = ''; state.user = null; localStorage.removeItem('classLunch.token'); localStorage.removeItem('classLunch.user'); }
function formData(form) { return Object.fromEntries(new FormData(form).entries()); }
function readLocal(key) { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (_) { return null; } }
function sessionStore() { try { return window.sessionStorage; } catch (_) { return null; } }
function readSession(key) { try { const store = sessionStore(); const value = store?.getItem(key); if (!value) return null; try { return JSON.parse(value); } catch (_) { return value; } } catch (_) { return null; } }
function htmlFromTemplate(id) { return serializeTemplateChildren($(`#${id}`).content.cloneNode(true).children); }
function money(value) { return `NT$ ${Math.round(Number(value || 0)).toLocaleString('zh-TW')}`; }
function signedMoney(value) { const n = Number(value || 0); return `${n >= 0 ? '+' : '−'}${Math.abs(n)} 元`; }
function initial(name) { return String(name || '午').trim().slice(0, 1); }
function toDateInput(date) { const d = new Date(date); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function toDateTimeInput(value) { const d = new Date(value); const offset = d.getTimezoneOffset(); return new Date(d.getTime() - offset * 60000).toISOString().slice(0, 16); }
function formatDate(value) { const d = new Date(String(value).length === 10 ? `${value}T12:00:00` : value); return `${d.getFullYear()} 年 ${d.getMonth()+1} 月 ${d.getDate()} 日`; }
function formatDateTime(value) { const d = new Date(value); return `${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`; }
function weekDay(date) { return ['週日','週一','週二','週三','週四','週五','週六'][date.getDay()]; }
function defaultCutoff() { const d = new Date(); d.setDate(d.getDate()+1); d.setHours(9, 0, 0, 0); const offset = d.getTimezoneOffset(); return new Date(d.getTime() - offset * 60000).toISOString().slice(0,16); }
function paymentBadge(status) { const map = { PaidWallet: ['儲值已扣', 'text-stamp'], PaidCash: ['現金已結', 'text-stamp'], PartiallyPaid: ['部分抵扣', 'text-[#A45A13]'], UnpaidCash: ['現金未繳', 'text-[#A45A13]'] }; const [label, cls] = map[status] || [status, 'text-slate-500']; return `<span class="status-stamp rounded-md px-2 py-1 ${cls}">${label}</span>`; }
function pickupBadge(status) { return `<span class="status-stamp rounded-md px-2 py-1 ${status === 'PickedUp' ? 'text-stamp' : 'text-slate-500'}">${status === 'PickedUp' ? '已取餐' : '待取餐'}</span>`; }
function emptyState(title, description) { return `<div class="rounded-[1.5rem] border border-dashed border-ledger/20 bg-white px-6 py-10 text-center"><p class="font-serif text-lg font-black text-ledger">${escapeHtml(title)}</p><p class="mt-2 text-sm leading-6 text-slate-500">${escapeHtml(description)}</p></div>`; }
function errorBlock(text) { return `<div class="rounded-xl border border-red-100 bg-red-50 p-4 text-sm leading-6 text-red-700">${escapeHtml(text)}</div>`; }
function skeletonLines(count) { return `<div class="space-y-3">${Array.from({length: count}, () => '<div class="h-16 animate-pulse rounded-xl bg-slate-100"></div>').join('')}</div>`; }
function configNote() { return !apiConfigured() ? '<div class="mt-4 rounded-xl border border-apricot/30 bg-[#FFF6E8] px-3 py-2.5 text-xs leading-5 text-[#885A1C]">目前為介面預覽。請確認後端服務（/api/gas）已部署。</div>' : ''; }
function toast(message, type = 'success') { let root = $('#toast-root'); if (!root) { root = document.createElement('div'); root.id = 'toast-root'; root.className = 'pointer-events-none fixed inset-x-0 top-4 z-[70] mx-auto flex max-w-sm flex-col gap-2 px-4'; document.body.appendChild(root); } const item = document.createElement('div'); item.className = `pointer-events-auto rounded-xl px-4 py-3 text-sm font-bold text-white shadow-lift ${type === 'error' ? 'bg-red-700' : 'bg-ledger'}`; item.textContent = message; root.appendChild(item); setTimeout(() => item.remove(), 3500); }
function setOperationLock(locked) {
  state.operationPending = locked;
  $$('button, input, select, textarea').forEach(control => {
    if (locked) { control.dataset.operationDisabled = control.disabled ? 'true' : 'false'; control.disabled = true; }
    else if (control.dataset.operationDisabled !== undefined) { control.disabled = control.dataset.operationDisabled === 'true'; delete control.dataset.operationDisabled; }
  });
}
async function busy(element, task) { if (state.operationPending) return; const button = element?.matches?.('button') ? element : (element ? $('button[type="submit"]', element) : null); const original = button ? button.innerHTML : ''; setOperationLock(true); if (button) { button.dataset.busy = 'true'; button.innerHTML = '處理中…'; } try { await task(); } catch (error) { toast(error.message || '系統暫時無法完成此操作。', 'error'); } finally { if (button && document.body.contains(button)) { button.innerHTML = original; delete button.dataset.busy; } setOperationLock(false); } }
function orderCanBeChanged(session, order) { return session.isOpen && new Date(session.cutoffTime) > new Date() && order.pickupStatus !== 'PickedUp' && order.paymentStatus !== 'PaidCash'; }
function escapeHtml(value) { return String(value ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;'); }
function escapeAttr(value) { return escapeHtml(value).replace(/`/g,'&#096;'); }
function cssEscape(value) { return window.CSS && window.CSS.escape ? window.CSS.escape(value) : String(value).replace(/(["\\])/g, '\\$1'); }
