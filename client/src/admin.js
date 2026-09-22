/* ============================================================================
 * 訂餐通 — 管理後台（延遲載入 chunk）
 * 本模組只在進入「管理」分頁或觸發管理動作時才動態載入，學生端不載入此重碼。
 * ==========================================================================*/
import {
  money, fmtMoney, todayString, nextWeekLabel, weekLabelOf, weekDates,
  weekdayName, monthDay, weekFriendlyLabel, formatClock, cutoffRemaining,
  escapeHtml, paymentLabel, paymentColor, buildCsv,
} from './lunchDomain.js';

let state, api, busy, toast, closeModal, openConfirm, promptModal, modalRoot, refreshAdmin, render, renderView, bootstrap, loadScript, $, activityTime, compressImage;
export function initAdmin(ctx) {
  ({ state, api, busy, toast, closeModal, openConfirm, promptModal, modalRoot, refreshAdmin, render, renderView, bootstrap, loadScript, $, activityTime, compressImage } = ctx);
}

/* ============================ 管理（Admin） ============================ */
function renderAdminView(root) {
  const tabs = [
    { id: 'dashboard', label: '總覽' },
    { id: 'menu', label: '菜單' },
    { id: 'daily', label: '每日菜單' },
    { id: 'schedule', label: '排程' },
    { id: 'verify', label: '核銷' },
    { id: 'users', label: '帳號' },
    { id: 'activity', label: '歷程' },
    { id: 'leave', label: '請假' },
    { id: 'reco', label: '推薦' },
    { id: 'treat', label: '請客' },
    { id: 'settings', label: '設定' },
  ];
  root.innerHTML = `
    <section class="view-enter space-y-5">
      <div class="overflow-hidden rounded-[1.5rem] bg-ledger text-white shadow-paper">
        <div class="px-6 py-6">
          <p class="text-xs font-bold tracking-[.15em] text-blue-200">ADMIN DESK</p>
          <h1 class="mt-1 font-serif text-2xl font-black">管理員工作台</h1>
          <p class="mt-1 text-sm text-blue-100">菜單、排程、核銷與帳號管理，都在這裡完成。</p>
        </div>
      </div>
      <div class="scroll-hide flex gap-2 overflow-x-auto pb-1">
        ${tabs.map((tab) => `<button data-admin-tab="${tab.id}" class="shrink-0 rounded-xl px-4 py-2.5 text-sm font-bold ${state.adminTab === tab.id ? 'bg-ledger text-white' : 'bg-white text-ledger ring-1 ring-ledger/10'}">${tab.label}</button>`).join('')}
      </div>
      <div id="admin-content"></div>
    </section>`;
  renderAdminTab();
}

function renderAdminTab() {
  const content = $('#admin-content');
  if (!content) return;
  const handlers = {
    dashboard: renderAdminDashboard,
    menu: renderAdminMenu,
    daily: renderAdminDailyMenu,
    schedule: renderAdminSchedule,
    verify: renderAdminVerify,
    users: renderAdminUsers,
    activity: renderAdminActivity,
    leave: renderAdminLeave,
    reco: renderAdminReco,
    treat: renderAdminTreat,
    settings: renderAdminSettings,
  };
  const fn = handlers[state.adminTab];
  if (fn) {
    content.innerHTML = '<p class="py-10 text-center text-sm text-slate-400">載入中…</p>';
    fn(content);
  }
}

/* ----- 總覽 ----- */
async function renderAdminDashboard(content) {
  try {
    const data = await api('adminGetDashboard', { date: state.admin.dashboardDate });
    state.admin.dashboard = data;
    const totals = data.totals;
    content.innerHTML = `
      <div class="space-y-4">
        <div class="flex items-center justify-between">
          <div>
            <p class="text-xs text-slate-400">${data.weekday} ${data.monthDay}</p>
            <h2 class="font-serif text-xl font-black">今日訂單總覽</h2>
          </div>
          <div class="flex gap-2">
            <input type="date" id="dashboard-date" value="${data.date}" class="rounded-xl border border-slate-200 px-3 py-2 text-xs outline-none focus:border-ledger" />
            <button data-action="settle-week" class="rounded-xl bg-stamp px-3 py-2 text-xs font-bold text-white">本週結算</button>
            <button data-action="broadcast" class="rounded-xl bg-white px-3 py-2 text-xs font-bold text-ledger ring-1 ring-ledger/10">📢發送通知</button>
            <button data-action="export-csv" class="rounded-xl bg-white px-3 py-2 text-xs font-bold text-ledger ring-1 ring-ledger/10">匯出 CSV</button>
          </div>
        </div>
        <div class="grid grid-cols-2 gap-2 sm:grid-cols-4">
          ${statCard('訂單數', totals.orderCount)}
          ${statCard('總金額', `$${money(totals.totalAmount)}`)}
          ${statCard('未繳', `$${money(totals.unpaidAmount)}`)}
          ${statCard('已取餐', totals.pickedUp)}
        </div>
        ${data.debtors.length ? `
          <div class="overflow-hidden rounded-2xl bg-white shadow-paper ring-1 ring-ledger/5">
            <p class="border-b border-ledger/5 px-4 py-3 text-sm font-bold text-red-600">未繳總整理（按座號）</p>
            ${data.debtors.map((d) => `
              <div class="flex items-center justify-between border-b border-dashed border-ledger/10 px-4 py-2.5 last:border-b-0">
                <div class="min-w-0"><p class="text-sm font-bold text-ledger">${escapeHtml(d.seatNo)} ${escapeHtml(d.studentName)}</p><p class="text-[11px] text-slate-400">${d.orderCount} 筆待繳</p></div>
                <span class="ml-2 shrink-0 font-bold tabular-nums text-red-600">欠 ${fmtMoney(d.debt)}</span>
              </div>`).join('')}
          </div>` : ''}
                ${data.overdueCount ? `<button data-action="view-overdue" class="w-full rounded-xl bg-red-50 px-4 py-3 text-left text-sm font-bold text-red-600">⚠️ 有 ${data.overdueCount} 位同學尚未繳費，點此查看</button>` : ''}
                ${data.dutyStudents.length ? `
          <div class="rounded-2xl bg-gradient-to-r from-stamp to-ledger p-4 text-white shadow-paper">
            <div class="flex items-center justify-between">
              <div>
                <p class="text-[11px] font-bold tracking-[.13em] text-white/70">TODAY'S DUTY</p>
                <h3 class="font-serif text-lg font-black">今日值日生</h3>
              </div>
              <button data-action="set-duty" data-date="${data.date}" class="rounded-lg bg-white/20 px-2.5 py-1.5 text-[11px] font-bold text-white">設定值日生</button>
            </div>
            <div class="mt-2 flex flex-wrap gap-2">
              ${data.dutyStudents.map((u) => `<span class="rounded-full bg-white/20 px-3 py-1 text-sm font-bold">${escapeHtml(u.seatNo)} ${escapeHtml(u.name)}${u.manual ? ' · 手動' : ''}</span>`).join('')}
            </div>
          </div>` : `
          <div class="flex items-center justify-between rounded-2xl bg-white p-4 shadow-paper ring-1 ring-ledger/5">
            <p class="text-sm font-bold text-slate-500">今日放假或尚無值日生</p>
            <button data-action="set-duty" data-date="${data.date}" class="rounded-lg bg-mist px-2.5 py-1.5 text-[11px] font-bold text-ledger">設定值日生</button>
          </div>`}

        ${data.sessionStats.length ? data.sessionStats.map((session) => `
          <div class="rounded-2xl bg-white p-4 shadow-paper ring-1 ring-ledger/5">
            <div class="flex items-center justify-between">
              <p class="font-bold text-ledger">${escapeHtml(session.storeName)}</p>
              <div class="flex items-center gap-2">
                <span class="text-xs text-slate-400">截止 ${formatClock(session.cutoffTime)}</span>
                <button data-action="admin-add-order" data-session="${session.sessionId}" class="rounded-lg bg-stamp/10 px-2.5 py-1 text-[11px] font-bold text-stamp">＋補單</button>
              </div>
            </div>
            <div class="mt-2 grid grid-cols-4 gap-2 text-center">
              <div class="rounded-lg bg-mist py-2"><p class="text-[10px] text-slate-500">訂單</p><p class="font-black tabular-nums">${session.orderCount}</p></div>
              <div class="rounded-lg bg-mist py-2"><p class="text-[10px] text-slate-500">金額</p><p class="font-black tabular-nums">$${money(session.totalAmount)}</p></div>
              <div class="rounded-lg bg-mist py-2"><p class="text-[10px] text-slate-500">未繳</p><p class="font-black tabular-nums text-red-600">$${money(session.unpaidAmount)}</p></div>
              <div class="rounded-lg bg-mist py-2"><p class="text-[10px] text-slate-500">未取餐</p><p class="font-black tabular-nums text-amber-600">${session.notPickedUpCount}</p></div>
            </div>
            ${session.itemTotals.length ? `
              <div class="mt-3 border-t border-dashed border-ledger/10 pt-2">
                <p class="mb-1 text-[10px] font-bold tracking-[.13em] text-stamp">品項整理</p>
                ${session.itemTotals.map((item) => `
                  <div class="flex items-center justify-between py-1">
                    <span class="truncate text-xs text-slate-600">${escapeHtml(item.name)}${item.options.length ? '（' + escapeHtml(item.options.join('、')) + '）' : ''}</span>
                    <span class="ml-2 shrink-0 text-xs font-bold tabular-nums text-ledger">×${item.quantity}</span>
                  </div>`).join('')}
              </div>` : ''}
            ${session.notPickedUp.length ? `
              <div class="mt-2 border-t border-dashed border-ledger/10 pt-2">
                <p class="mb-1 text-[10px] font-bold tracking-[.13em] text-amber-600">尚未取餐</p>
                ${session.notPickedUp.map((u) => `
                  <div class="flex items-center justify-between py-1">
                    <span class="truncate text-xs text-slate-600">${escapeHtml(u.seatNo)} ${escapeHtml(u.studentName)} · ${escapeHtml(u.itemName)}</span>
                    <button data-action="cancel-order" data-order="${u.orderId}" class="ml-2 shrink-0 rounded-md bg-red-50 px-2 py-1 text-[10px] font-bold text-red-600">取消訂單</button>
                  </div>`).join('')}
              </div>` : ''}
          </div>`).join('') : '<p class="rounded-2xl bg-white/60 px-4 py-10 text-center text-sm text-slate-400">今天沒有排定場次。</p>'}

        ${data.orders.length ? `
          <div class="overflow-hidden rounded-2xl bg-white shadow-paper ring-1 ring-ledger/5">
            <p class="border-b border-ledger/5 px-4 py-3 text-sm font-bold">訂單明細</p>
            ${data.orders.map((order) => `
              <div class="flex items-center justify-between border-b border-dashed border-ledger/10 px-4 py-3 last:border-b-0">
                <div class="min-w-0">
                  <p class="text-sm font-bold text-ledger">${escapeHtml(order.seatNo)} ${escapeHtml(order.studentName)}</p>
                  <p class="break-words text-xs text-slate-500">${escapeHtml(order.itemName)}${order.selectedOptions.length ? '（' + escapeHtml(order.selectedOptions.map((o) => o.name).join('、')) + '）' : ''}</p>
                  ${order.note ? `<p class="mt-0.5 break-words text-xs font-bold text-stamp">備註：${escapeHtml(order.note)}</p>` : ''}
                </div>
                <div class="flex items-center gap-2">
                  <div class="text-right">
                    <p class="font-bold tabular-nums">$${money(order.totalPrice)}</p>
                    <span class="text-[10px] font-bold ${paymentColor(order.paymentStatus)}">${paymentLabel(order.paymentStatus)}</span>
                  </div>
                  ${order.outstandingAmount > 0 ? `<button data-action="pay-order" data-order="${order.orderId}" data-user="${order.userId}" class="rounded-lg bg-stamp px-2.5 py-1.5 text-[11px] font-bold text-white">繳費</button>` : ''}
                  <button data-action="cancel-order" data-order="${order.orderId}" class="rounded-lg bg-red-50 px-2.5 py-1.5 text-[11px] font-bold text-red-600">取消</button>
                </div>
              </div>`).join('')}
          </div>` : ''}
      </div>`;
    const dateInput = $('#dashboard-date');
    if (dateInput) dateInput.addEventListener('change', (event) => {
      state.admin.dashboardDate = event.target.value;
      renderAdminTab();
    });
  } catch (error) {
    content.innerHTML = `<p class="py-10 text-center text-sm text-red-500">${escapeHtml(error.message)}</p>`;
  }
}

function statCard(label, value) {
  return `<div class="rounded-xl bg-white p-3 shadow-paper ring-1 ring-ledger/5"><p class="text-[11px] font-bold text-slate-500">${label}</p><p class="mt-1 font-serif text-xl font-black tabular-nums text-ledger">${value}</p></div>`;
}

async function exportCsv() {
  try {
    const data = await api('adminGetDaySummary', { date: state.admin.dashboardDate });
    const csv = buildCsv(data.orders);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `訂單-${data.date}.csv`;
    link.click();
    URL.revokeObjectURL(url);
    toast('CSV 已匯出。', 'success');
  } catch (error) {
    toast(error.message, 'error');
  }
}

/* ----- 菜單（資料夾式 + AI 辨識） ----- */
async function renderAdminMenu(content) {
  try {
    const catalog = await api('adminCatalog');
    state.admin.catalog = catalog;
    content.innerHTML = `
      <div class="space-y-4">
        <div class="flex items-center justify-between">
          <h2 class="font-serif text-xl font-black">店家與菜單</h2>
          <button data-action="add-store" class="rounded-xl bg-ledger px-4 py-2.5 text-xs font-bold text-white">＋ 新增店家</button>
        </div>
        ${catalog.stores.map((store) => renderStoreFolder(store)).join('') || '<p class="rounded-2xl bg-white/60 px-4 py-10 text-center text-sm text-slate-400">尚無店家，請先新增。</p>'}
      </div>`;
  } catch (error) {
    content.innerHTML = `<p class="py-10 text-center text-sm text-red-500">${escapeHtml(error.message)}</p>`;
  }
}

function renderStoreFolder(store) {
  const isExpanded = state.expandedStores.has(store.storeId);
  return `
    <section class="overflow-hidden rounded-2xl bg-white shadow-paper ring-1 ring-ledger/5">
      <div class="flex items-center justify-between px-4 py-3.5">
        <button data-toggle-store="${store.storeId}" class="flex flex-1 items-center gap-2 text-left">
          <span class="text-ledger/60">${isExpanded ? '▾' : '▸'}</span>
          <span class="font-bold text-ledger">${escapeHtml(store.name)}</span>
          <span class="text-xs text-slate-400">${store.items.length} 品項</span>
        </button>
        <div class="flex gap-1.5">
          <button data-action="edit-store" data-store="${store.storeId}" class="rounded-lg bg-mist px-2.5 py-1.5 text-xs font-bold text-ledger">改名</button>
          <button data-action="del-store" data-store="${store.storeId}" class="rounded-lg bg-red-50 px-2.5 py-1.5 text-xs font-bold text-red-600">刪除</button>
        </div>
      </div>
      ${isExpanded ? `
        <div class="border-t border-dashed border-ledger/10 px-3 py-2">
          ${store.items.map((item) => `
            <div class="flex items-center justify-between rounded-xl px-2 py-2.5">
              <div class="min-w-0">
                <p class="text-sm font-bold text-ledger">${escapeHtml(item.name)}${item.vegetarian ? ' <span class="veg-badge">🌱</span>' : ''}${item.menuDate && item.menuDate !== '1970-01-01' ? ` <span class="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-bold text-amber-600">${monthDay(item.menuDate)}</span>` : ''}</p>
                <p class="text-xs text-slate-400">$${money(item.price)}${item.options.length ? ' · ' + escapeHtml(item.options.map((o) => o.name + (Number(o.price) ? `(+${money(o.price)})` : '') + (o.required ? '＊' : '')).join('、')) : ''}</p>
              </div>
              <div class="flex gap-1.5">
                <button data-action="edit-item" data-item="${item.itemId}" class="rounded-lg bg-mist px-2.5 py-1.5 text-xs font-bold text-ledger">編輯</button>
                <button data-action="del-item" data-item="${item.itemId}" class="rounded-lg bg-red-50 px-2.5 py-1.5 text-xs font-bold text-red-600">刪除</button>
              </div>
            </div>`).join('')}
          <div class="mt-2 flex gap-2">
            <button data-action="add-item" data-store="${store.storeId}" class="flex-1 rounded-xl bg-mist py-2.5 text-xs font-bold text-ledger">＋ 手動新增品項</button>
            <button data-action="ai-scan" data-store="${store.storeId}" class="flex-1 rounded-xl bg-stamp py-2.5 text-xs font-bold text-white">📷 AI 辨識菜單</button>
          </div>
        </div>` : ''}
    </section>`;
}

/* ----- 歷程記錄 ----- */
async function renderAdminActivity(content) {
  try {
    const data = await api('adminGetActivityLog', { limit: 300 });
    content.innerHTML = `
      <div class="space-y-4">
        <div class="flex items-center justify-between">
          <div>
            <p class="text-[11px] font-bold tracking-[.13em] text-stamp">ACTIVITY</p>
            <h2 class="font-serif text-xl font-black">歷程記錄</h2>
          </div>
          <button data-action="export-activity" class="rounded-xl bg-stamp px-3 py-2 text-xs font-bold text-white">匯出 CSV</button>
        </div>
        <p class="text-xs text-slate-400">所有人的活動紀錄（儲值、訂餐、現金結帳、取餐、退款等），共 ${data.total} 筆。</p>
        ${data.activities.length ? `
        <div class="overflow-hidden rounded-2xl bg-white shadow-paper ring-1 ring-ledger/5">
          <div class="max-h-[70dvh] overflow-y-auto">
          ${data.activities.map((a) => `
            <div class="flex items-center justify-between border-b border-dashed border-ledger/10 px-4 py-2.5 last:border-b-0">
              <div class="min-w-0">
                <p class="text-sm font-bold text-ledger">${escapeHtml(a.seatNo || a.studentNo || '')} ${escapeHtml(a.name)}</p>
                <p class="truncate text-xs text-slate-500">${escapeHtml(a.detail) || '—'}</p>
              </div>
              <div class="ml-3 shrink-0 text-right">
                <span class="rounded-full px-2 py-0.5 text-[10px] font-bold ${activityColor(a.type)}">${escapeHtml(a.type)}</span>
                <p class="mt-0.5 text-xs font-bold tabular-nums ${a.amount < 0 ? 'text-red-600' : 'text-ledger'}">${a.amount !== 0 ? (a.amount < 0 ? '-' : '+') + '$' + money(Math.abs(a.amount)) : ''}</p>
                <p class="text-[10px] text-slate-400">${activityTime(a.time)}</p>
              </div>
            </div>`).join('')}
          </div>
        </div>` : '<p class="rounded-2xl bg-white/60 px-4 py-12 text-center text-sm text-slate-400">尚無活動紀錄。</p>'}
      </div>`;
  } catch (error) {
    content.innerHTML = `<p class="py-10 text-center text-sm text-red-500">${escapeHtml(error.message)}</p>`;
  }
}

function activityColor(type) {
  if (type === '儲值') return 'bg-emerald-50 text-emerald-600';
  if (type === '現金結帳') return 'bg-stamp/10 text-stamp';
  if (type === '取餐') return 'bg-sky-50 text-sky-600';
  if (type === '訂餐') return 'bg-ledger/10 text-ledger';
  if (type === '退款') return 'bg-amber-50 text-amber-600';
  return 'bg-slate-100 text-slate-500';
}

async function exportActivity() {
  const data = await api('adminGetActivityLog', { limit: 500 });
  const rows = [['時間', '座號', '姓名', '類型', '內容', '金額']];
  data.activities.forEach((a) => {
    rows.push([activityTime(a.time), a.seatNo || a.studentNo, a.name, a.type, a.detail || '', String(a.amount)]);
  });
  const csv = rows.map((r) => r.map((c) => `"${String(c || '').replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `歷程記錄-${todayString()}.csv`;
  link.click();
  URL.revokeObjectURL(url);
  toast('歷程已匯出。', 'success');
}

/* ----- 每日菜單（內訂） ----- */
async function renderAdminDailyMenu(content) {
  try {
    const month = state.admin.dailyMonth || todayString().slice(0, 7);
    const data = await api('adminGetDailyMenus', { month });
    state.admin.dailyMonth = month;
    content.innerHTML = `
      <div class="space-y-4">
        <div class="rounded-2xl bg-white p-4 shadow-paper ring-1 ring-ledger/5">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p class="text-[11px] font-bold tracking-[.13em] text-stamp">DAILY MENU</p>
              <h2 class="font-serif text-xl font-black">每日菜單（內訂）</h2>
            </div>
            <div class="flex gap-2">
              <input id="daily-month" type="month" value="${month}" class="w-36 rounded-xl border border-slate-200 px-2 py-2 text-sm outline-none focus:border-ledger" />
              <button data-action="clear-daily" class="rounded-xl bg-red-50 px-3 py-2 text-xs font-bold text-red-600">一鍵刪除</button>
              <button data-action="monthly-menu" class="rounded-xl bg-stamp px-3 py-2 text-xs font-bold text-white">＋ 上傳菜單</button>
            </div>
          </div>
          <p class="mt-1 text-xs text-slate-400">上傳各廠商的每月菜單，系統會自動排成每天場次並顯示在「排程」中。</p>
        </div>
        ${data.days.length ? data.days.map((day) => `
          <div class="rounded-2xl bg-white p-4 shadow-paper ring-1 ring-ledger/5">
            <div class="flex items-center gap-2">
              <span class="rounded-lg bg-ledger px-2 py-1 text-xs font-bold text-white">${escapeHtml(monthDay(day.date))}</span>
              <span class="text-xs text-slate-400">${escapeHtml(day.weekday)}</span>
            </div>
            <div class="mt-2 space-y-1.5">
              ${day.items.length ? day.items.map((it) => `
                <div class="flex items-start justify-between rounded-lg bg-mist/50 px-3 py-2">
                  <div class="min-w-0">
                    <p class="text-sm font-bold text-ledger">${escapeHtml(it.name)}${it.dish ? `<span class="text-xs text-slate-400">（${escapeHtml(it.dish)}）</span>` : ''}</p>
                    <p class="mt-0.5 text-xs text-slate-500">$${money(it.price)}</p>
                  </div>
                  <button data-action="del-daily-item" data-item="${it.itemId}" class="ml-2 shrink-0 rounded-lg bg-red-50 px-2 py-1 text-[11px] font-bold text-red-600">刪除</button>
                </div>`).join('') : '<p class="text-xs text-slate-400">當天無餐點。</p>'}
            </div>
          </div>`).join('') : '<p class="rounded-2xl bg-white/60 px-4 py-12 text-center text-sm text-slate-400">這個月尚無每日菜單，點「＋ 上傳菜單」開始匯入。</p>'}
      </div>`;
    $('#daily-month').addEventListener('change', (event) => {
      state.admin.dailyMonth = event.target.value;
      renderAdminTab();
    });
  } catch (error) {
    content.innerHTML = `<p class="py-10 text-center text-sm text-red-500">${escapeHtml(error.message)}</p>`;
  }
}

/* ----- 排程 ----- */
async function renderAdminSchedule(content) {
  try {
    const week = state.admin.scheduleWeek;
    const data = await api('adminGetWeekSchedule', { weekLabel: week });
    state.admin.schedule = data;
    const dates = weekDates(week);
    const holidaySet = new Set(data.holidayDates);

    content.innerHTML = `
      <div class="space-y-4">
        <div class="flex items-center justify-between">
          <div class="flex gap-2">
            <button data-schedule-week="prev" class="rounded-xl bg-white px-3 py-2 text-xs font-bold text-ledger ring-1 ring-ledger/10">‹ 上週</button>
            <button data-schedule-week="next" class="rounded-xl bg-white px-3 py-2 text-xs font-bold text-ledger ring-1 ring-ledger/10">下週 ›</button>
          </div>
          <div class="flex flex-wrap gap-2">
            <button data-action="week-cutoff" class="rounded-xl bg-white px-3 py-2 text-xs font-bold text-ledger ring-1 ring-ledger/10">統一截止</button>
            <button data-action="publish-week" class="rounded-xl bg-stamp px-4 py-2.5 text-xs font-bold text-white">一鍵公布本週</button>
          </div>
        </div>
        <div class="rounded-2xl bg-white p-4 shadow-paper ring-1 ring-ledger/5">
          <h2 class="font-serif text-xl font-black">${escapeHtml(weekFriendlyLabel(week))}</h2>
          <div class="mt-3 space-y-2">
            ${dates.map((date) => {
              const isHoliday = holidaySet.has(date);
              const daySessions = data.sessions.filter((session) => session.orderDate === date);
              return `
                <div class="rounded-xl ${isHoliday ? 'bg-red-50' : 'bg-mist/60'} p-3">
                  <div class="flex items-center justify-between">
                    <div class="flex items-center gap-2">
                      <span class="font-bold text-ledger">${weekdayName(date)} ${monthDay(date)}</span>
                      ${isHoliday ? '<span class="rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-bold text-red-600">放假</span>' : ''}
                    </div>
                    <div class="flex gap-1.5">
                      <button data-action="toggle-holiday" data-date="${date}" class="rounded-lg ${isHoliday ? 'bg-stamp text-white' : 'bg-white text-slate-500 ring-1 ring-ledger/10'} px-2.5 py-1.5 text-[11px] font-bold">${isHoliday ? '取消放假' : '標記放假'}</button>
                      ${!isHoliday ? `<button data-action="add-session" data-date="${date}" class="rounded-lg bg-ledger px-2.5 py-1.5 text-[11px] font-bold text-white">＋ 場次</button>` : ''}
                    </div>
                  </div>
                  ${daySessions.length ? `<div class="mt-2 space-y-1.5">${daySessions.map((session) => `
                    <div class="flex items-center justify-between rounded-lg bg-white px-3 py-2 ring-1 ring-ledger/5">
                      <div>
                        <p class="text-sm font-bold text-ledger">${escapeHtml(session.storeName)}</p>
                        <p class="text-xs text-slate-400">截止 ${formatClock(session.cutoffTime)}</p>
                      </div>
                      <div class="flex gap-1.5">
                        <button data-action="edit-session" data-session="${session.sessionId}" class="rounded-md bg-mist px-2 py-1 text-[11px] font-bold text-ledger">改時間</button>
                        <button data-action="del-session" data-session="${session.sessionId}" class="rounded-md bg-red-50 px-2 py-1 text-[11px] font-bold text-red-600">刪除</button>
                      </div>
                    </div>`).join('')}</div>` : (!isHoliday ? '<p class="mt-2 text-xs text-slate-400">尚無場次</p>' : '')}
                </div>`;
            }).join('')}
          </div>
        </div>

        <div class="rounded-2xl bg-white p-4 shadow-paper ring-1 ring-ledger/5">
          <div class="flex items-center justify-between">
            <div>
              <p class="text-[11px] font-bold tracking-[.13em] text-stamp">RECURRING</p>
              <h2 class="font-serif text-xl font-black">每日固定店家</h2>
            </div>
            <div class="flex items-center gap-2">
              ${data.recurring.length ? '<button data-action="clear-recurring" class="rounded-xl bg-red-50 px-3 py-2 text-xs font-bold text-red-600">一鍵清除</button>' : ''}
              <button data-action="add-recurring" class="rounded-xl bg-ledger px-3 py-2 text-xs font-bold text-white">＋ 固定店家</button>
            </div>
          </div>
          <p class="mt-1 text-xs text-slate-400">設為固定的店家每天都會有場次（放假除外），學生可直接訂餐。</p>
          <div class="mt-3 space-y-2">
            ${data.recurring.length ? data.recurring.map((rec) => `
              <div class="flex items-center justify-between rounded-lg bg-mist/60 px-3 py-2.5">
                <div>
                  <p class="text-sm font-bold text-ledger">${escapeHtml(rec.storeName)}</p>
                  <p class="text-xs text-slate-400">每天截止 ${rec.cutoffTime}</p>
                </div>
                <button data-action="del-recurring" data-store="${rec.storeId}" class="rounded-lg bg-red-50 px-2.5 py-1.5 text-[11px] font-bold text-red-600">取消固定</button>
              </div>`).join('') : '<p class="text-xs text-slate-400">尚未設定固定店家。</p>'}
          </div>
        </div>
      </div>`;
  } catch (error) {
    content.innerHTML = `<p class="py-10 text-center text-sm text-red-500">${escapeHtml(error.message)}</p>`;
  }
}

/* ----- 核銷 ----- */
function renderAdminVerify(content) {
  content.innerHTML = `
    <div class="space-y-4">
      <div class="grid grid-cols-3 gap-2">
        <button data-action="open-scanner" class="rounded-xl bg-ledger py-3.5 text-sm font-bold text-white">📷 掃描</button>
        <button data-action="pin-input" class="rounded-xl bg-stamp py-3.5 text-sm font-bold text-white">🔢 PIN</button>
        <button data-action="seat-input" class="rounded-xl bg-apricot py-3.5 text-sm font-bold text-white">🔍 座號</button>
      </div>
      <div class="rounded-2xl bg-white p-4 shadow-paper ring-1 ring-ledger/5">
        <p class="text-xs text-slate-400">掃描 QR、輸入 6 位 PIN，或直接輸入座號，即可快速執行「儲值、扣款結帳、取餐標記」。</p>
      </div>
      ${state.admin.lastVerify ? verifyResultHtml(state.admin.lastVerify) : ''}
    </div>`;
}

/* ----- 帳號 ----- */
async function renderAdminUsers(content) {
  try {
    const data = await api('adminListUsers');
    state.admin.users = data.users;
    content.innerHTML = `
      <div class="space-y-4">
        <div class="flex items-center justify-between">
          <h2 class="font-serif text-xl font-black">帳號管理 <span class="text-sm font-normal text-slate-400">（管理者 ${data.adminCount} 位）</span></h2>
          <button data-action="add-user" class="rounded-xl bg-ledger px-4 py-2.5 text-xs font-bold text-white">＋ 新增帳號</button>
        </div>
        <div class="overflow-hidden rounded-2xl bg-white shadow-paper ring-1 ring-ledger/5">
          ${data.users.map((user) => `
            <div class="flex items-center justify-between border-b border-dashed border-ledger/10 px-4 py-3 last:border-b-0">
              <div class="flex items-center gap-3">
                <span class="grid h-9 w-9 place-items-center rounded-full ${user.role === 'Admin' ? 'bg-apricot/20 text-apricot' : 'bg-mist text-ledger'} text-sm font-black">${escapeHtml(user.seatNo || user.studentNo)}</span>
                <div>
                  <p class="text-sm font-bold text-ledger">${escapeHtml(user.name)} ${user.role === 'Admin' ? '<span class="rounded bg-apricot/15 px-1.5 py-0.5 text-[10px] font-bold text-apricot">管理</span>' : user.role === 'Teacher' ? '<span class="rounded bg-stamp/10 px-1.5 py-0.5 text-[10px] font-bold text-stamp">師長</span>' : ''}</p>
                  <p class="text-xs ${user.isDisabled ? 'text-red-400' : 'text-slate-400'}">座號 ${escapeHtml(user.studentNo)} · ${fmtMoney(user.walletBalance)} ${user.isDisabled ? '· 已停用' : ''}</p>
                </div>
              </div>
              <div class="flex gap-1.5">
                ${user.role === 'Admin' ? `<button data-action="demote" data-user="${user.id}" class="rounded-lg bg-mist px-2.5 py-1.5 text-[11px] font-bold text-ledger">移除管理</button>` : `<button data-action="promote" data-user="${user.id}" class="rounded-lg bg-mist px-2.5 py-1.5 text-[11px] font-bold text-stamp">設為管理</button>`}
                ${user.role !== 'Admin' ? (user.role === 'Teacher' ? `<button data-action="set-role-student" data-user="${user.id}" class="rounded-lg bg-mist px-2.5 py-1.5 text-[11px] font-bold text-slate-500">設為學生</button>` : `<button data-action="set-role-teacher" data-user="${user.id}" class="rounded-lg bg-mist px-2.5 py-1.5 text-[11px] font-bold text-slate-500">設為師長</button>`) : ''}
                <button data-action="toggle-user" data-user="${user.id}" data-disabled="${user.isDisabled}" class="rounded-lg bg-mist px-2.5 py-1.5 text-[11px] font-bold ${user.isDisabled ? 'text-stamp' : 'text-slate-500'}">${user.isDisabled ? '啟用' : '停用'}</button>
                <button data-action="toggle-duty" data-user="${user.id}" data-duty="${user.dutyExempt}" class="rounded-lg bg-mist px-2.5 py-1.5 text-[11px] font-bold ${user.dutyExempt ? 'text-stamp' : 'text-slate-500'}">${user.dutyExempt ? '恢復值日' : '免值日'}</button>
                <button data-action="topup" data-user="${user.id}" class="rounded-lg bg-mist px-2.5 py-1.5 text-[11px] font-bold text-stamp">儲值</button>
                <button data-action="adjust-balance" data-user="${user.id}" class="rounded-lg bg-mist px-2.5 py-1.5 text-[11px] font-bold text-slate-500">調整餘額</button>
                <button data-action="reset-pw" data-user="${user.id}" class="rounded-lg bg-mist px-2.5 py-1.5 text-[11px] font-bold text-slate-500">重設密碼</button>
                <button data-action="del-user" data-user="${user.id}" class="rounded-lg bg-red-50 px-2.5 py-1.5 text-[11px] font-bold text-red-600">刪除</button>
              </div>
            </div>`).join('')}
        </div>
      </div>`;
  } catch (error) {
    content.innerHTML = `<p class="py-10 text-center text-sm text-red-500">${escapeHtml(error.message)}</p>`;
  }
}

/* ----- 請假 ----- */
async function renderAdminLeave(content) {
  try {
    const data = await api('adminListLeave');
    const pending = data.requests.filter((r) => r.status === 'Pending');
    const resolved = data.requests.filter((r) => r.status !== 'Pending');
    const statusBadge = (s) => s === 'Approved' ? '<span class="rounded bg-emerald-50 px-2 py-0.5 text-[10px] font-bold text-emerald-600">已批准</span>' : s === 'Rejected' ? '<span class="rounded bg-red-50 px-2 py-0.5 text-[10px] font-bold text-red-500">未批准</span>' : '<span class="rounded bg-amber-50 px-2 py-0.5 text-[10px] font-bold text-amber-600">待審核</span>';
    const row = (r) => `
      <div class="flex items-center justify-between border-b border-dashed border-ledger/10 px-4 py-3 last:border-b-0">
        <div class="min-w-0">
          <p class="text-sm font-bold text-ledger">${escapeHtml(r.seatNo)} ${escapeHtml(r.studentName)} <span class="text-xs font-normal text-slate-400">請假 ${escapeHtml(r.leaveDate)}</span></p>
          ${r.reason ? `<p class="text-xs text-slate-500">${escapeHtml(r.reason)}</p>` : ''}
          <p class="mt-0.5 text-[10px] text-slate-400">${activityTime(r.requestedAt)}</p>
        </div>
        <div class="ml-3 flex shrink-0 items-center gap-1.5">
          ${r.status === 'Pending' ? `<button data-action="approve-leave" data-id="${r.id}" class="rounded-lg bg-stamp px-2.5 py-1.5 text-[11px] font-bold text-white">批准</button><button data-action="reject-leave" data-id="${r.id}" class="rounded-lg bg-red-50 px-2.5 py-1.5 text-[11px] font-bold text-red-600">駁回</button>` : statusBadge(r.status)}
        </div>
      </div>`;
    content.innerHTML = `
      <div class="space-y-4">
        <div class="flex items-center justify-between">
          <div><p class="text-[11px] font-bold tracking-[.13em] text-stamp">LEAVE</p><h2 class="font-serif text-xl font-black">請假申請</h2></div>
          <button data-action="refresh-admin" class="rounded-xl bg-mist px-3 py-2 text-xs font-bold text-ledger">重新整理</button>
        </div>
        <div class="overflow-hidden rounded-2xl bg-white shadow-paper ring-1 ring-ledger/5">
          <p class="border-b border-ledger/5 px-4 py-3 text-sm font-bold text-amber-600">待審核（${pending.length}）</p>
          ${pending.length ? pending.map(row).join('') : '<p class="px-4 py-6 text-center text-sm text-slate-400">目前沒有待審核的請假。</p>'}
        </div>
        ${resolved.length ? `<div class="overflow-hidden rounded-2xl bg-white shadow-paper ring-1 ring-ledger/5">
          <p class="border-b border-ledger/5 px-4 py-3 text-sm font-bold text-slate-500">已處理</p>
          ${resolved.map(row).join('')}
        </div>` : ''}
      </div>`;
  } catch (error) {
    content.innerHTML = `<p class="py-10 text-center text-sm text-red-500">${escapeHtml(error.message)}</p>`;
  }
}

/* ----- 推薦 ----- */
async function renderAdminReco(content) {
  try {
    const data = await api('listRecommendations');
    const list = data.recommendations || [];
    content.innerHTML = `
      <div class="space-y-4">
        <div class="flex items-center justify-between">
          <div><p class="text-[11px] font-bold tracking-[.13em] text-apricot">RECOMMEND</p><h2 class="font-serif text-xl font-black">店家推薦</h2></div>
          <button data-action="refresh-admin" class="rounded-xl bg-mist px-3 py-2 text-xs font-bold text-ledger">重新整理</button>
        </div>
        ${list.length ? `<div class="overflow-hidden rounded-2xl bg-white shadow-paper ring-1 ring-ledger/5">
          ${list.map((r) => `
            <div class="flex items-center justify-between border-b border-dashed border-ledger/10 px-4 py-3 last:border-b-0">
              <div class="min-w-0">
                <p class="text-sm font-bold text-ledger">🍜 ${escapeHtml(r.storeName)}</p>
                ${r.note ? `<p class="text-xs text-slate-500">${escapeHtml(r.note)}</p>` : ''}
                <p class="mt-0.5 text-[10px] text-slate-400">${escapeHtml(r.seatNo)} ${escapeHtml(r.studentName)} · ${activityTime(r.createdAt)}</p>
              </div>
              <button data-action="reco-delete" data-id="${r.id}" class="ml-3 shrink-0 rounded-lg bg-red-50 px-2.5 py-1.5 text-[11px] font-bold text-red-600">刪除</button>
            </div>`).join('')}
        </div>` : '<p class="rounded-2xl bg-white/60 px-4 py-10 text-center text-sm text-slate-400">尚無推薦。</p>'}
      </div>`;
  } catch (error) {
    content.innerHTML = `<p class="py-10 text-center text-sm text-red-500">${escapeHtml(error.message)}</p>`;
  }
}

/* ----- 請客 ----- */
async function renderAdminTreat(content) {
  try {
    const data = await api('adminGetTreatSessions');
    const sessions = data.sessions || [];
    const totalFree = Number(data.totalFree || 0);
    content.innerHTML = `
      <div class="space-y-4">
        <div class="flex items-center justify-between">
          <div><p class="text-[11px] font-bold tracking-[.13em] text-stamp">TREAT</p><h2 class="font-serif text-xl font-black">請客場次</h2></div>
          <button data-action="open-treat" class="rounded-xl bg-ledger px-4 py-2.5 text-xs font-bold text-white">＋ 建立請客場次</button>
        </div>
        <div class="rounded-2xl bg-gradient-to-r from-stamp to-ledger p-4 text-white shadow-paper">
          <p class="text-[11px] font-bold tracking-[.13em] text-white/70">TOTAL FREE</p>
          <p class="font-serif text-2xl font-black">累計免費 ${fmtMoney(totalFree)}</p>
        </div>
        ${sessions.length ? `<div class="space-y-2">
          ${sessions.map((t) => `
            <div class="rounded-2xl bg-white p-4 shadow-paper ring-1 ring-ledger/5">
              <div class="flex items-center justify-between">
                <p class="font-bold text-ledger">🎁 ${escapeHtml(t.orderDate)} ${escapeHtml(t.storeName)} ${t.isOpen ? '<span class="rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-bold text-emerald-600">開放中</span>' : '<span class="rounded bg-mist px-1.5 py-0.5 text-[10px] font-bold text-slate-500">草稿</span>'}</p>
              </div>
              <div class="mt-3 grid grid-cols-3 gap-2 text-center">
                <div class="rounded-lg bg-mist py-2"><p class="text-[10px] text-slate-500">免費上限</p><p class="font-black tabular-nums">${fmtMoney(t.treatCap)}</p></div>
                <div class="rounded-lg bg-mist py-2"><p class="text-[10px] text-slate-500">已免費</p><p class="font-black tabular-nums text-stamp">${fmtMoney(t.treatUsed)}</p></div>
                <div class="rounded-lg bg-mist py-2"><p class="text-[10px] text-slate-500">剩餘</p><p class="font-black tabular-nums text-apricot">${fmtMoney(t.treatRemaining)}</p></div>
              </div>
            </div>`).join('')}
        </div>` : '<p class="rounded-2xl bg-white/60 px-4 py-10 text-center text-sm text-slate-400">尚無請客場次。</p>'}
        <p class="px-1 text-xs leading-5 text-slate-400">請客場次與一般場次相同：同學下單時免費額度自動抵扣，超過上限的部分自補差價。</p>
      </div>`;
  } catch (error) {
    content.innerHTML = `<p class="py-10 text-center text-sm text-red-500">${escapeHtml(error.message)}</p>`;
  }
}

/* ============================ 請假／請客／欠費／更新日誌／AI 設定 Modal ============================ */
async function openLeaveModal() {
  let myRequests = [];
  try { myRequests = (await api('listLeave')).requests || []; } catch (_) { /* 忽略 */ }
  const statusBadge = (s) => s === 'Approved' ? '<span class="rounded bg-emerald-50 px-2 py-0.5 text-[10px] font-bold text-emerald-600">已批准</span>' : s === 'Rejected' ? '<span class="rounded bg-red-50 px-2 py-0.5 text-[10px] font-bold text-red-500">未批准</span>' : '<span class="rounded bg-amber-50 px-2 py-0.5 text-[10px] font-bold text-amber-600">待審核</span>';
  modalRoot.innerHTML = `
    <div class="fixed inset-0 z-50 flex items-end justify-center bg-ledger/50">
      <section class="sheet-enter flex max-h-[90dvh] w-full max-w-md flex-col overflow-hidden rounded-t-[1.5rem] bg-white">
        <div class="flex items-center justify-between border-b border-ledger/10 px-5 py-4">
          <div><p class="text-[11px] font-bold tracking-[.13em] text-stamp">LEAVE</p><h2 class="font-serif text-xl font-black">申請請假</h2></div>
          <button data-close-sheet class="grid h-9 w-9 place-items-center rounded-full bg-mist text-xl">×</button>
        </div>
        <div class="flex-1 overflow-y-auto px-5 py-4">
          <p class="rounded-lg bg-amber-50 px-3 py-2 text-xs font-bold text-amber-600">當天請假須於上午 9:00 前申請；批准後當日訂單將取消並退費（若已繳）。</p>
          <form id="leave-form" class="mt-3 space-y-3">
            <div><label class="mb-1 block text-xs font-bold text-slate-500">請假日期</label><input name="leaveDate" type="date" min="${todayString()}" value="${todayString()}" class="w-full rounded-xl border border-slate-200 px-3 py-2.5 outline-none focus:border-ledger" /></div>
            <div><label class="mb-1 block text-xs font-bold text-slate-500">原因（可選）</label><input name="reason" maxlength="120" placeholder="例如：感冒看醫生" class="w-full rounded-xl border border-slate-200 px-3 py-2.5 outline-none focus:border-ledger" /></div>
            <button type="submit" class="w-full rounded-xl bg-stamp py-3 text-sm font-bold text-white">送出申請</button>
          </form>
          ${myRequests.length ? `
          <p class="mb-2 mt-5 text-sm font-bold text-ledger">我的請假紀錄</p>
          <div class="space-y-2">
            ${myRequests.map((r) => `
              <div class="flex items-center justify-between rounded-xl bg-mist/50 px-3 py-2.5">
                <div><p class="text-sm font-bold text-ledger">${escapeHtml(r.leaveDate)}</p>${r.reason ? `<p class="text-xs text-slate-500">${escapeHtml(r.reason)}</p>` : ''}</div>
                ${statusBadge(r.status)}
              </div>`).join('')}
          </div>` : ''}
        </div>
      </section>
    </div>`;
  $('#leave-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await busy(async () => {
        await api('createLeave', { leaveDate: event.target.leaveDate.value, reason: event.target.reason.value });
        closeModal();
        toast('請假申請已送出，等待管理者處理。', 'success');
      });
    } catch (error) { toast(error.message, 'error'); }
  });
}

async function openTreatSessionModal() {
  let schedule = state.admin.schedule;
  try {
    if (!schedule || !schedule.stores) schedule = await api('adminGetWeekSchedule');
  } catch (error) { toast(error.message, 'error'); return; }
  const stores = schedule.stores || [];
  if (!stores.length) { toast('請先在「菜單」建立店家。', 'error'); return; }
  const storeOptions = stores.map((st) => `<option value="${st.storeId}">${escapeHtml(st.name)}</option>`).join('');
  modalRoot.innerHTML = `
    <div class="fixed inset-0 z-50 flex items-end justify-center bg-ledger/50">
      <section class="sheet-enter w-full max-w-md rounded-t-[1.5rem] bg-white p-6">
        <div class="flex items-center justify-between">
          <div><p class="text-[11px] font-bold tracking-[.13em] text-stamp">TREAT SESSION</p><h2 class="font-serif text-xl font-black">建立請客場次</h2></div>
          <button data-close-sheet class="grid h-9 w-9 place-items-center rounded-full bg-mist text-xl">×</button>
        </div>
        <p class="mt-3 rounded-lg bg-blue-50 px-3 py-2 text-xs font-bold text-blue-600">此場次由你請客：設定每人免費上限，同學下單超過上限的部分自補差價。建立後需「公布」同學才能下單。</p>
        <form id="treat-form" class="mt-4 space-y-3">
          <div><label class="mb-1 block text-xs font-bold text-slate-500">店家</label><select name="storeId" class="w-full rounded-xl border border-slate-200 px-3 py-2.5 outline-none focus:border-ledger">${storeOptions}</select></div>
          <div><label class="mb-1 block text-xs font-bold text-slate-500">訂餐日期</label><input name="orderDate" type="date" min="${todayString()}" value="${todayString()}" class="w-full rounded-xl border border-slate-200 px-3 py-2.5 outline-none focus:border-ledger" /></div>
          <div><label class="mb-1 block text-xs font-bold text-slate-500">截止時間</label><input name="cutoffTime" type="datetime-local" class="w-full rounded-xl border border-slate-200 px-3 py-2.5 outline-none focus:border-ledger" /></div>
          <div><label class="mb-1 block text-xs font-bold text-slate-500">每人免費上限（元）</label><input name="treatCap" type="number" inputmode="decimal" min="1" placeholder="例如 100" class="w-full rounded-xl border border-slate-200 px-3 py-2.5 outline-none focus:border-ledger" /></div>
          <button type="submit" class="w-full rounded-xl bg-stamp py-3 text-sm font-bold text-white">建立請客場次</button>
        </form>
      </section>
    </div>`;
  $('#treat-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await busy(async () => {
        await api('adminSaveSession', {
          storeId: event.target.storeId.value,
          orderDate: event.target.orderDate.value,
          cutoffTime: new Date(event.target.cutoffTime.value).toISOString(),
          isTreat: true,
          treatCap: Number(event.target.treatCap.value),
        });
        closeModal();
        toast('請客場次已建立（草稿），記得公布。', 'success');
        await refreshAdmin();
      });
    } catch (error) { toast(error.message, 'error'); }
  });
}
async function openDebtModal() {
  let data;
  try { data = await api('debtList'); } catch (error) { toast(error.message, 'error'); return; }
  const statusBadge = (r) => r.status === 'Settled' ? '<span class="rounded bg-emerald-50 px-2 py-0.5 text-[10px] font-bold text-emerald-600">已核銷</span>' : '<span class="rounded bg-amber-50 px-2 py-0.5 text-[10px] font-bold text-amber-600">待還</span>';
  const entry = (e, mine) => `
    <div class="flex items-center justify-between rounded-xl bg-mist/50 px-3 py-2.5">
      <div class="min-w-0">
        <p class="text-sm font-bold text-ledger">${mine ? `${escapeHtml(e.debtorSeat)} ${escapeHtml(e.debtorName)}` : `${escapeHtml(e.creditorSeat)} ${escapeHtml(e.creditorName)}`}</p>
        ${e.note ? `<p class="truncate text-xs text-slate-500">${escapeHtml(e.note)}</p>` : ''}
        <p class="text-[10px] text-slate-400">${activityTime(e.createdAt)}${e.settledAt ? ` · 核銷於 ${activityTime(e.settledAt)}` : ''}</p>
      </div>
      <div class="ml-2 flex shrink-0 items-center gap-2">
        <span class="font-bold tabular-nums ${e.status === 'Settled' ? 'text-slate-400 line-through' : 'text-red-600'}">${money(e.amount)}</span>
        ${statusBadge(e)}
        ${mine && e.status !== 'Settled' ? `<button data-action="settle-debt" data-id="${e.id}" class="rounded-lg bg-stamp px-2 py-1 text-[10px] font-bold text-white">核銷</button>` : ''}
        ${mine ? `<button data-action="del-debt" data-id="${e.id}" class="rounded-lg bg-red-50 px-2 py-1 text-[10px] font-bold text-red-600">刪除</button>` : ''}
      </div>
    </div>`;
  modalRoot.innerHTML = `
    <div class="fixed inset-0 z-50 flex items-end justify-center bg-ledger/50">
      <section class="sheet-enter flex max-h-[88dvh] w-full max-w-md flex-col overflow-hidden rounded-t-[1.5rem] bg-white">
        <div class="flex items-center justify-between border-b border-ledger/10 px-5 py-4">
          <div><p class="text-[11px] font-bold tracking-[.13em] text-apricot">IOU</p><h2 class="font-serif text-xl font-black">自訂欠費</h2></div>
          <button data-close-sheet class="grid h-9 w-9 place-items-center rounded-full bg-mist text-xl">×</button>
        </div>
        <div class="flex-1 overflow-y-auto px-4 py-4">
          <div class="rounded-xl border border-dashed border-ledger/20 p-3">
            <p class="text-xs font-bold text-slate-500">新增欠費（別人欠你）</p>
            <div class="mt-2 flex gap-2">
              <input id="debt-seat" maxlength="10" placeholder="座號" class="w-20 rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-ledger" />
              <input id="debt-amount" type="number" inputmode="decimal" placeholder="金額" class="min-w-0 flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-ledger" />
              <input id="debt-note" maxlength="120" placeholder="說明（可選）" class="min-w-0 flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-ledger" />
            </div>
            <button id="debt-add" class="mt-2 w-full rounded-xl bg-ledger py-2.5 text-sm font-bold text-white">新增</button>
          </div>

          <div class="mt-4 flex gap-2">
            <div class="flex-1 rounded-xl bg-red-50 px-3 py-2.5 text-center"><p class="text-[10px] text-red-500">別人欠我</p><p class="font-serif text-xl font-black text-red-600">${fmtMoney(data.receiveTotal)}</p></div>
            <div class="flex-1 rounded-xl bg-emerald-50 px-3 py-2.5 text-center"><p class="text-[10px] text-emerald-600">我欠別人</p><p class="font-serif text-xl font-black text-emerald-600">${fmtMoney(data.payTotal)}</p></div>
          </div>

          <p class="mb-1 mt-4 text-sm font-bold text-ledger">別人欠我（我可核銷）</p>
          <div class="space-y-2">${data.receivables.length ? data.receivables.map((e) => entry(e, true)).join('') : '<p class="py-4 text-center text-sm text-slate-400">無</p>'}</div>

          <p class="mb-1 mt-4 text-sm font-bold text-ledger">我欠別人</p>
          <div class="space-y-2">${data.payables.length ? data.payables.map((e) => entry(e, false)).join('') : '<p class="py-4 text-center text-sm text-slate-400">無</p>'}</div>
        </div>
      </section>
    </div>`;
  $('#debt-add').addEventListener('click', async () => {
    const seatNo = $('#debt-seat').value.trim();
    const amount = Number($('#debt-amount').value);
    const note = $('#debt-note').value.trim();
    if (!seatNo) return toast('請輸入座號。', 'error');
    if (!(amount > 0)) return toast('請輸入正確金額。', 'error');
    try {
      await busy(async () => {
        await api('debtCreate', { seatNo, amount, note });
        closeModal();
        toast('已新增欠費。', 'success');
        await openDebtModal();
      });
    } catch (error) { toast(error.message, 'error'); }
  });
}
function openPayModal(ctx) {
  const outstanding = Number(ctx.outstanding || 0);
  const label = String(ctx.label || '此筆訂單');
  modalRoot.innerHTML = `
    <div class="fixed inset-0 z-50 flex items-end justify-center bg-ledger/50">
      <section class="sheet-enter w-full max-w-md rounded-t-[1.5rem] bg-white p-6">
        <div class="flex items-center justify-between">
          <div><p class="text-[11px] font-bold tracking-[.13em] text-stamp">CASH PAYMENT</p><h2 class="font-serif text-xl font-black">繳費</h2></div>
          <button data-close-sheet class="grid h-9 w-9 place-items-center rounded-full bg-mist text-xl">×</button>
        </div>
        <div class="mt-3 rounded-xl bg-mist/60 px-4 py-3">
          <p class="break-words text-sm font-bold text-ledger">${escapeHtml(label)}</p>
          <p class="mt-1 text-xs text-slate-500">尚欠 <span id="pay-outstanding" class="font-black tabular-nums text-red-600">${fmtMoney(outstanding)}</span></p>
        </div>
        <button id="pay-full" class="mt-4 w-full rounded-xl bg-stamp py-3 text-sm font-bold text-white">全繳 ${fmtMoney(outstanding)}</button>
        <div class="mt-2 flex gap-2">
          <input id="pay-amount" type="number" inputmode="decimal" min="1" placeholder="自訂繳額" class="min-w-0 flex-1 rounded-xl border border-slate-200 px-3 py-2.5 outline-none focus:border-ledger" />
          <button id="pay-custom" class="shrink-0 rounded-xl bg-ledger px-5 py-2.5 text-sm font-bold text-white">自訂繳費</button>
        </div>
        <p class="mt-2 text-[11px] text-slate-400">「全繳」即結清此筆訂單；「自訂繳費」可先繳一部分，剩餘仍列為欠費。</p>
      </section>
    </div>`;
  $('#pay-full').addEventListener('click', async () => {
    try {
      await busy(async () => {
        const r = await api('adminSettleCash', { userId: ctx.userId, orderIds: [ctx.orderId] });
        closeModal();
        toast(r.walletUsed > 0 ? `已全額結清（餘額抵 $${money(r.walletUsed)}）。` : '已全額結清。', 'success');
        await refreshAdmin();
      });
    } catch (e) { toast(e.message, 'error'); }
  });
  $('#pay-custom').addEventListener('click', async () => {
    const amount = Number($('#pay-amount').value);
    if (!(amount > 0)) return toast('請輸入正確金額。', 'error');
    if (amount > outstanding) return toast('金額不可超過尚欠金額。', 'error');
    try {
      await busy(async () => {
        const r = await api('adminPartialPay', { userId: ctx.userId, orderId: ctx.orderId, amount });
        closeModal();
        toast(`已繳 $${money(r.applied)}，尚欠 $${money(r.outstanding)}。`, 'success');
        await refreshAdmin();
      });
    } catch (e) { toast(e.message, 'error'); }
  });
}

async function openChangelogModal() {
  try {
    const data = await api('getChangelog');
    const list = data.changelog || [];
    modalRoot.innerHTML = `
      <div class="fixed inset-0 z-50 flex items-end justify-center bg-ledger/50">
        <section class="sheet-enter flex max-h-[88dvh] w-full max-w-md flex-col overflow-hidden rounded-t-[1.5rem] bg-white">
          <div class="flex items-center justify-between border-b border-ledger/10 px-5 py-4">
            <div><p class="text-[11px] font-bold tracking-[.13em] text-stamp">CHANGELOG</p><h2 class="font-serif text-xl font-black">更新日誌</h2></div>
            <button data-close-sheet class="grid h-9 w-9 place-items-center rounded-full bg-mist text-xl">×</button>
          </div>
          <div class="flex-1 overflow-y-auto px-4 py-4">
            ${list.length ? list.map((c) => `
              <div class="mb-3 rounded-xl bg-mist/50 p-3.5">
                <div class="flex items-center gap-2">
                  <span class="rounded-full bg-ledger px-2 py-0.5 text-[10px] font-bold text-white">${escapeHtml(c.version)}${c.source === 'git' ? ' ·自動' : ''}</span>
                  <span class="font-bold text-ledger">${escapeHtml(c.title)}</span>
                </div>
                <p class="mt-1.5 whitespace-pre-line text-xs leading-5 text-slate-600">${escapeHtml(c.body)}</p>
                <p class="mt-1 text-[10px] text-slate-400">${activityTime(c.createdAt)}</p>
              </div>`).join('') : '<p class="py-8 text-center text-sm text-slate-400">尚無更新日誌。</p>'}
          </div>
        </section>
      </div>`;
  } catch (error) { toast(error.message, 'error'); }
}

async function openManageChangelogModal() {
  try {
    const data = await api('getChangelog');
    const list = data.changelog || [];
    const renderList = (l) => {
      const listEl = $('#cl-list');
      if (!listEl) return;
      listEl.innerHTML = l.length ? l.map((c) => `
        <div class="flex items-center justify-between rounded-xl bg-mist/50 px-3 py-2.5">
          <div class="min-w-0"><p class="text-sm font-bold text-ledger">${escapeHtml(c.version)} ${escapeHtml(c.title)}</p></div>
          <button data-action="del-changelog" data-id="${c.id}" class="ml-2 shrink-0 rounded-lg bg-red-50 px-2 py-1 text-[10px] font-bold text-red-600">刪除</button>
        </div>`).join('') : '<p class="py-6 text-center text-sm text-slate-400">尚無日誌。</p>';
    };
    modalRoot.innerHTML = `
      <div class="fixed inset-0 z-50 flex items-end justify-center bg-ledger/50">
        <section class="sheet-enter flex max-h-[88dvh] w-full max-w-md flex-col overflow-hidden rounded-t-[1.5rem] bg-white">
          <div class="flex items-center justify-between border-b border-ledger/10 px-5 py-4">
            <div><p class="text-[11px] font-bold tracking-[.13em] text-stamp">CHANGELOG</p><h2 class="font-serif text-xl font-black">更新日誌管理</h2></div>
            <button data-close-sheet class="grid h-9 w-9 place-items-center rounded-full bg-mist text-xl">×</button>
          </div>
          <div class="flex-1 overflow-y-auto px-4 py-4">
            <div class="rounded-xl border border-dashed border-ledger/20 p-3">
              <p class="text-xs font-bold text-slate-500">新增日誌</p>
              <input id="cl-version" maxlength="20" placeholder="版本（例如 v3.2.0）" class="mt-2 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-ledger" />
              <input id="cl-title" maxlength="60" placeholder="標題" class="mt-2 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-ledger" />
              <textarea id="cl-body" rows="3" maxlength="1000" placeholder="內容" class="mt-2 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-ledger"></textarea>
              <button id="cl-add" class="mt-2 w-full rounded-xl bg-ledger py-2.5 text-sm font-bold text-white">新增</button>
            </div>
            <div id="cl-list" class="mt-3 space-y-2"></div>
          </div>
        </section>
      </div>`;
    renderList(list);
    $('#cl-add').addEventListener('click', async () => {
      try {
        await busy(async () => {
          await api('adminAddChangelog', { version: $('#cl-version').value, title: $('#cl-title').value, body: $('#cl-body').value });
          const fresh = await api('getChangelog');
          renderList(fresh.changelog || []);
        });
        toast('日誌已新增。', 'success');
      } catch (error) { toast(error.message, 'error'); }
    });
  } catch (error) { toast(error.message, 'error'); }
}

async function openAiSettingsModal() {
  let s;
  try { s = await api('aiGetSettings'); } catch (e) { toast(e.message, 'error'); return; }
  const provider = s.provider || 'auto';
  modalRoot.innerHTML = `
    <div class="fixed inset-0 z-50 flex items-end justify-center bg-ledger/50">
      <section class="sheet-enter w-full max-w-md rounded-t-[1.5rem] bg-white p-6">
        <div class="flex items-center justify-between">
          <div><p class="text-[11px] font-bold tracking-[.13em] text-stamp">AI SETTINGS</p><h2 class="font-serif text-xl font-black">AI 圖片辨識設定</h2></div>
          <button data-close-sheet class="grid h-9 w-9 place-items-center rounded-full bg-mist text-xl">×</button>
        </div>
        <p class="mt-3 rounded-lg bg-mist/60 px-3 py-2 text-xs text-slate-500">用於菜單／行事曆圖片辨識。金鑰僅存於伺服器，不會回傳顯示。${s.envFallback ? '目前使用環境變數金鑰（備援）。' : ''}</p>
        <div class="mt-4 space-y-3">
          <div>
            <label class="mb-1 block text-xs font-bold text-slate-500">辨識供應商</label>
            <select id="ai-provider" class="w-full rounded-xl border border-slate-200 px-3 py-2.5 outline-none focus:border-ledger">
              <option value="auto" ${provider === 'auto' ? 'selected' : ''}>自動（有金鑰者優先）</option>
              <option value="gemini" ${provider === 'gemini' ? 'selected' : ''}>Google Gemini</option>
              <option value="openai" ${provider === 'openai' ? 'selected' : ''}>OpenAI</option>
            </select>
          </div>
          <div>
            <label class="mb-1 block text-xs font-bold text-slate-500">Gemini API 金鑰 ${s.geminiKeySet ? '（已設定）' : ''}</label>
            <input id="ai-gemini-key" type="password" placeholder="留空＝不變更" class="w-full rounded-xl border border-slate-200 px-3 py-2.5 outline-none focus:border-ledger" />
          </div>
          <div>
            <label class="mb-1 block text-xs font-bold text-slate-500">Gemini 模型（選用）</label>
            <input id="ai-gemini-model" value="${escapeHtml(s.geminiModel || '')}" placeholder="留空＝使用預設備援鏈" class="w-full rounded-xl border border-slate-200 px-3 py-2.5 outline-none focus:border-ledger" />
          </div>
          <div>
            <label class="mb-1 block text-xs font-bold text-slate-500">OpenAI API 金鑰 ${s.openaiKeySet ? '（已設定）' : ''}</label>
            <input id="ai-openai-key" type="password" placeholder="留空＝不變更" class="w-full rounded-xl border border-slate-200 px-3 py-2.5 outline-none focus:border-ledger" />
          </div>
          <div>
            <label class="mb-1 block text-xs font-bold text-slate-500">OpenAI 模型（選用）</label>
            <input id="ai-openai-model" value="${escapeHtml(s.openaiModel || '')}" placeholder="預設 gpt-4o-mini" class="w-full rounded-xl border border-slate-200 px-3 py-2.5 outline-none focus:border-ledger" />
          </div>
          <button id="ai-save" class="w-full rounded-xl bg-stamp py-3 text-sm font-bold text-white">儲存設定</button>
        </div>
      </section>
    </div>`;
  $('#ai-save').addEventListener('click', async () => {
    try {
      await busy(async () => {
        await api('aiSaveSettings', {
          provider: $('#ai-provider').value,
          geminiApiKey: $('#ai-gemini-key').value.trim(),
          openaiApiKey: $('#ai-openai-key').value.trim(),
          geminiModel: $('#ai-gemini-model').value.trim(),
          openaiModel: $('#ai-openai-model').value.trim(),
        });
        closeModal();
        toast('AI 辨識設定已儲存。', 'success');
      });
    } catch (error) { toast(error.message, 'error'); }
  });
}

/* ----- 設定 ----- */
async function renderAdminSettings(content) {
  try {
    state.admin.settings = await api('adminGetSettings');
    renderSettingsHtml(content);
  } catch (error) {
    content.innerHTML = `<p class="py-10 text-center text-sm text-red-500">${escapeHtml(error.message)}</p>`;
  }
}

function renderSettingsHtml(content) {
  const settings = state.admin.settings;
  content.innerHTML = `
    <div class="space-y-4">
      <div class="rounded-2xl bg-white p-5 shadow-paper ring-1 ring-ledger/5">
        <h2 class="font-serif text-lg font-black">班級設定</h2>
        <div class="mt-4 space-y-4">
          <div>
            <label class="mb-1 block text-xs font-bold text-slate-500">班級名稱</label>
            <input id="class-name" value="${escapeHtml(settings.className)}" class="w-full rounded-xl border border-slate-200 px-3 py-2.5 outline-none focus:border-ledger" />
          </div>
          <button id="toggle-pure" class="flex w-full items-center justify-between rounded-xl ${settings.pureBalanceMode ? 'bg-stamp text-white' : 'bg-mist text-ledger'} px-4 py-3.5 text-left">
            <span>
              <span class="block font-bold">純儲值模式</span>
              <span class="mt-0.5 block text-xs ${settings.pureBalanceMode ? 'text-emerald-50' : 'text-slate-500'}">開啟後，餘額不足將無法送出訂單。</span>
            </span>
            <span class="grid h-6 w-11 place-items-center rounded-full ${settings.pureBalanceMode ? 'bg-white/30' : 'bg-slate-300'}"><span class="h-4 w-4 rounded-full bg-white shadow transition ${settings.pureBalanceMode ? 'translate-x-2.5' : '-translate-x-2.5'}"></span></span>
          </button>
          <div>
            <label class="mb-1 block text-xs font-bold text-slate-500">欠繳催繳提醒頻率</label>
            <select id="remind-hours" class="w-full rounded-xl border border-slate-200 px-3 py-2.5 outline-none focus:border-ledger">
              ${[6, 12, 24].map((h) => `<option value="${h}" ${Number(settings.overdueRemindHours) === h ? 'selected' : ''}>每 ${h} 小時提醒一次</option>`).join('')}
            </select>
          </div>
          <div>
            <label class="mb-1 block text-xs font-bold text-slate-500">公告（顯示在學生「訂餐」頁上方）</label>
            <textarea id="announcement" rows="3" class="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-ledger" placeholder="例如：本週五中午前記得完成下週訂餐…">${escapeHtml(settings.announcement || '')}</textarea>
          </div>
          <button data-action="save-settings" class="w-full rounded-xl bg-ledger py-3 text-sm font-bold text-white">儲存設定</button>
        </div>
      </div>
      <button data-action="view-overdue" class="w-full rounded-2xl bg-white px-5 py-4 text-left shadow-paper ring-1 ring-ledger/5">
        <p class="font-bold text-red-600">欠繳催繳名單</p>
        <p class="mt-0.5 text-xs text-slate-500">顯示所有仍有現金欠款的同學</p>
      </button>
      <button data-action="ai-settings" class="w-full rounded-2xl bg-white px-5 py-4 text-left shadow-paper ring-1 ring-ledger/5">
        <p class="font-bold text-ledger">🤖 AI 辨識設定</p>
        <p class="mt-0.5 text-xs text-slate-500">設定圖片辨識的 AI 供應商與金鑰（Gemini／OpenAI）</p>
      </button>
      <button data-action="manage-changelog" class="w-full rounded-2xl bg-white px-5 py-4 text-left shadow-paper ring-1 ring-ledger/5">
        <p class="font-bold text-ledger">📝 更新日誌管理</p>
        <p class="mt-0.5 text-xs text-slate-500">新增／刪除功能更新紀錄</p>
      </button>
      <div class="rounded-2xl bg-red-50 p-5 ring-1 ring-red-100">
      <div class="rounded-2xl bg-white p-5 shadow-paper ring-1 ring-ledger/5">
        <h2 class="font-serif text-lg font-black">資料備份</h2>
        <p class="mt-1 text-xs leading-5 text-slate-500">匯出全部資料（帳號、店家、菜單、場次、訂單、交易、投票等）為 JSON 檔，供異動前備份。</p>
        <button data-action="export-backup" class="mt-3 w-full rounded-xl bg-stamp py-3 text-sm font-bold text-white">下載資料備份</button>
        <button data-action="restore-backup" class="mt-2 w-full rounded-xl bg-ledger py-3 text-sm font-bold text-white">還原資料（上傳備份檔）</button>
      </div>
      <div class="rounded-2xl bg-red-50 p-5 ring-1 ring-red-100">
        <h2 class="font-serif text-lg font-black text-red-600">危險區域</h2>
        <p class="mt-1 text-xs leading-5 text-red-400">刪除所有訂單、交易、場次、投票、放假、店家與菜單，並將所有帳號儲值餘額歸零。帳號本身會保留，此操作無法復原。</p>
        <button data-action="reset-all" class="mt-3 w-full rounded-xl bg-red-600 py-3 text-sm font-bold text-white">刪除所有資料</button>
      </div>
    </div>`;
  content.querySelector('#toggle-pure').addEventListener('click', () => {
    state.admin.settings.pureBalanceMode = !state.admin.settings.pureBalanceMode;
    renderSettingsHtml(content);
  });
}

async function viewOverdue() {
  try {
    const data = await api('adminGetOverdueList');
    modalRoot.innerHTML = `
      <div class="fixed inset-0 z-50 flex items-end justify-center bg-ledger/50">
        <section class="sheet-enter flex max-h-[85dvh] w-full max-w-md flex-col overflow-hidden rounded-t-[1.5rem] bg-white">
          <div class="flex items-center justify-between border-b border-ledger/10 px-5 py-4">
            <div><p class="text-[11px] font-bold tracking-[.13em] text-red-500">OVERDUE</p><h2 class="font-serif text-xl font-black">欠繳催繳名單</h2></div>
            <button data-close-sheet class="grid h-9 w-9 place-items-center rounded-full bg-mist text-xl">×</button>
          </div>
          <div class="flex-1 overflow-y-auto px-4 py-4">
            <p class="mb-3 rounded-lg bg-red-50 px-3 py-2 text-xs font-bold text-red-600">共 ${data.list.length} 人，總欠款 $${money(data.totalDebt)}</p>
            ${data.list.length ? data.list.map((user) => `
              <div class="mb-2 flex items-center justify-between rounded-xl bg-white p-3 shadow-sm ring-1 ring-ledger/5">
                <div><p class="text-sm font-bold text-ledger">${escapeHtml(user.seatNo)} ${escapeHtml(user.studentName)}</p><p class="text-xs text-slate-400">${user.orderCount} 筆訂單未結清</p></div>
                <span class="font-bold tabular-nums text-red-600">$${money(user.debt)}</span>
              </div>`).join('') : '<p class="py-10 text-center text-sm text-slate-400">目前沒有欠繳的同學。</p>'}
          </div>
          <div class="border-t border-ledger/10 px-5 py-4">
            <button data-action="copy-overdue" class="w-full rounded-xl bg-stamp py-3 text-sm font-bold text-white">複製文字明細（貼至班級群組）</button>
          </div>
        </section>
      </div>`;
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function copyOverdue() {
  try {
    const data = await api('adminGetOverdueList');
    const lines = [`📢 午餐費用催繳通知`, `應繳人數：${data.list.length} 人，總金額 $${money(data.totalDebt)}`, ''];
    data.list.forEach((user) => lines.push(`${user.seatNo}號 ${user.studentName}：$${money(user.debt)}`));
    const text = lines.join('\n');
    await navigator.clipboard.writeText(text);
    toast('已複製催繳明細。', 'success');
  } catch (error) {
    toast('複製失敗，請手動複製。', 'error');
  }
}


/* ============================ 核銷流程 ============================ */
function openScanner() {
  modalRoot.innerHTML = `
    <div class="fixed inset-0 z-50 flex items-end justify-center bg-ledger/60">
      <section class="sheet-enter w-full max-w-md overflow-hidden rounded-t-[1.5rem] bg-white">
        <div class="flex items-center justify-between px-5 py-4">
          <div><p class="text-[11px] font-bold tracking-[.13em] text-slate-500">CAMERA SCANNER</p><h2 class="font-serif text-xl font-black">掃描學生 QR</h2></div>
          <button data-close-sheet class="grid h-9 w-9 place-items-center rounded-full bg-mist text-xl">×</button>
        </div>
        <div id="qr-reader" class="mx-4 overflow-hidden rounded-xl bg-slate-100"></div>
        <div class="px-5 py-4">
          <p class="text-xs leading-5 text-slate-500">或手動輸入 6 位 PIN：</p>
          <div class="mt-2 flex gap-2">
            <input id="manual-pin" inputmode="numeric" maxlength="6" class="pin-box min-w-0 flex-1 rounded-xl border border-slate-200 px-3 py-2.5 text-center text-xl font-black outline-none focus:border-ledger" placeholder="••••" />
            <button data-action="submit-pin" class="rounded-xl bg-stamp px-4 text-xs font-bold text-white">驗證</button>
          </div>
        </div>
      </section>
    </div>`;

  $('#qr-reader').innerHTML = '<p class="p-6 text-center text-xs text-slate-400">掃描元件載入中…</p>';
  loadScript('https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js').then(() => {
    state.scanner = new window.Html5Qrcode('qr-reader');
    state.scanner.start(
      { facingMode: 'environment' },
      { fps: 15, qrbox: (w, h) => { const s = Math.floor(Math.min(w, h) * 0.7); return { width: s, height: s }; }, aspectRatio: 1.0, rememberLastUsedCamera: true, formatsToSupport: [window.Html5QrcodeSupportedFormats && window.Html5QrcodeSupportedFormats.QR_CODE].filter(Boolean) },
      onScanSuccess,
      () => {},
    ).catch(() => {
      const readerEl = $('#qr-reader');
      if (readerEl) readerEl.innerHTML = '<p class="p-6 text-center text-xs text-slate-400">無法啟動相機，請改用 PIN 輸入。</p>';
    });
  }).catch(() => {
    const readerEl = $('#qr-reader');
    if (readerEl) readerEl.innerHTML = '<p class="p-6 text-center text-xs text-slate-400">掃描元件載入失敗，請改用 PIN 輸入。</p>';
  });
}

async function onScanSuccess(decodedText) {
  if (state.scanner) { try { await state.scanner.stop(); } catch (_) {} state.scanner = null; }
  let payload;
  try { payload = JSON.parse(decodedText); } catch (_) { return toast('QR 內容不是有效的驗證資料。', 'error'); }
  // 一掃到就立即關閉相機並給回饋，查詢在背景進行，避免等待感
  closeModal();
  toast('掃描成功，載入中…', 'success');
  await resolveVerify(payload);
}

async function resolveVerify(payload) {
  try {
    const result = await api('adminResolveVerification', { payload });
    renderVerifyResult(result);
  } catch (error) {
    toast(error.message, 'error');
    openScanner();
  }
}

function renderVerifyResult(result) {
  state.admin.lastVerify = result;
  state.view = 'admin';
  state.adminTab = 'verify';
  render();
}

function verifyResultHtml(result) {
  const student = result.student;
  const head = (subtitle) => `
    <div class="rounded-2xl bg-white p-5 shadow-paper ring-1 ring-ledger/5">
      <div class="flex items-center gap-3">
        <span class="grid h-12 w-12 place-items-center rounded-xl bg-stamp text-lg font-black text-white">${escapeHtml(student.seatNo || '?')}</span>
        <div>
          <p class="font-serif text-lg font-black">${escapeHtml(student.name)}</p>
          <p class="text-xs text-slate-500">${subtitle}</p>
        </div>
      </div>`;

  // 取餐碼：只顯示今天點的餐 + 確定領取
  if (result.intent === 'pickup') {
    const rows = result.todayOrders.length ? result.todayOrders.map((order) => `
        <div class="mt-2 flex items-center justify-between rounded-xl bg-mist/60 px-3 py-2.5">
          <div class="min-w-0"><p class="text-sm font-bold text-ledger">${escapeHtml(order.storeName)}</p><p class="break-words text-xs text-slate-500">${escapeHtml(order.itemName)}${order.selectedOptions.length ? '（' + escapeHtml(order.selectedOptions.map((o) => o.name).join('、')) + '）' : ''} · $${money(order.totalPrice)}</p>${order.note ? `<p class="mt-0.5 break-words text-xs font-bold text-stamp">備註：${escapeHtml(order.note)}</p>` : ''}</div>
          <button data-action="confirm-pickup" data-order="${order.orderId}" data-user="${student.id}" class="ml-2 shrink-0 rounded-lg ${order.pickupStatus === 'PickedUp' ? 'bg-slate-200 text-slate-400' : 'bg-stamp text-white'} px-3 py-2 text-xs font-bold">${order.pickupStatus === 'PickedUp' ? '已取餐' : '確定領取'}</button>
        </div>`).join('') : '<p class="mt-3 rounded-xl bg-mist/60 px-3 py-8 text-center text-sm text-slate-400">今天沒有訂單。</p>';
    return `${head('取餐 · 餘額 ' + fmtMoney(result.walletBalance))}
      <p class="mb-1 mt-4 text-sm font-bold">今日訂單（領取餐點）</p>
      ${rows}
    </div>`;
  }

  // 繳費碼：只顯示欠費多少 + 確認繳款
  if (result.intent === 'pay') {
    const rows = result.unpaidOrders.length ? result.unpaidOrders.map((order) => `
        <div class="mt-2 flex items-center justify-between rounded-xl bg-amber-50 px-3 py-2.5">
          <div class="min-w-0"><p class="text-sm font-bold text-ledger">${escapeHtml(order.orderDate)} ${escapeHtml(order.storeName)}</p><p class="break-words text-xs text-slate-500">${escapeHtml(order.itemName)}${order.selectedOptions.length ? '（' + escapeHtml(order.selectedOptions.map((o) => o.name).join('、')) + '）' : ''}</p>${order.note ? `<p class="mt-0.5 break-words text-xs font-bold text-stamp">備註：${escapeHtml(order.note)}</p>` : ''}</div>
          <div class="ml-2 flex shrink-0 items-center gap-2">
            <span class="font-bold tabular-nums text-apricot">$${money(order.outstanding)}</span>
            <button data-action="pay-order" data-order="${order.orderId}" data-user="${student.id}" class="rounded-lg bg-white px-2 py-1 text-[10px] font-bold text-stamp ring-1 ring-stamp/20">繳費</button>
          </div>
        </div>`).join('') : '';
    return `${head('繳費 · 餘額 ' + fmtMoney(result.walletBalance))}
      <div class="mt-4 flex items-center justify-between rounded-xl bg-red-50 px-4 py-3">
        <div><p class="text-xs text-red-400">欠費總額</p><p class="font-serif text-2xl font-black text-red-600">${fmtMoney(result.totalDebt)}</p></div>
        <span class="text-xs text-red-400">${result.unpaidOrders.length} 筆待繳</span>
      </div>
      ${rows}
      ${result.totalDebt > 0 ? `<button data-action="settle-all" data-user="${student.id}" class="mt-4 w-full rounded-xl bg-stamp py-3 text-sm font-bold text-white">確認繳款（$${money(result.totalDebt)}）</button>` : '<p class="mt-4 rounded-xl bg-emerald-50 px-4 py-3 text-center text-sm font-bold text-emerald-600">已全數繳清，無欠費。</p>'}
    </div>`;
  }

  // 座號查詢：完整顯示（取餐 + 欠費 + 儲值）
  return `${head('查詢 · 餘額 ' + fmtMoney(result.walletBalance) + ' · 未繳 ' + fmtMoney(result.totalDebt))}
    ${result.todayOrders.length ? `
      <p class="mb-2 mt-4 text-sm font-bold">今日訂單（取餐標記）</p>
      ${result.todayOrders.map((order) => `
        <div class="mb-2 flex items-center justify-between rounded-xl bg-mist/60 px-3 py-2.5">
          <div class="min-w-0"><p class="text-sm font-bold text-ledger">${escapeHtml(order.storeName)}</p><p class="text-xs text-slate-500">${escapeHtml(order.itemName)}${order.selectedOptions.length ? '（' + escapeHtml(order.selectedOptions.map((o) => o.name).join('、')) + '）' : ''} · $${money(order.totalPrice)}</p>${order.note ? `<p class="mt-0.5 break-words text-xs font-bold text-stamp">備註：${escapeHtml(order.note)}</p>` : ''}</div>
          <button data-action="confirm-pickup" data-order="${order.orderId}" data-user="${student.id}" class="rounded-lg ${order.pickupStatus === 'PickedUp' ? 'bg-slate-200 text-slate-400' : 'bg-stamp text-white'} px-3 py-2 text-xs font-bold">${order.pickupStatus === 'PickedUp' ? '已取餐' : '標記取餐'}</button>
        </div>`).join('')}` : ''}

    ${result.unpaidOrders.length ? `
      <p class="mb-2 mt-4 text-sm font-bold">待結帳訂單</p>
      ${result.unpaidOrders.map((order) => `
        <div class="mb-2 flex items-center justify-between rounded-xl bg-amber-50 px-3 py-2.5">
          <div class="min-w-0"><p class="text-sm font-bold text-ledger">${escapeHtml(order.orderDate)} ${escapeHtml(order.storeName)}</p><p class="break-words text-xs text-slate-500">${escapeHtml(order.itemName)}${order.selectedOptions.length ? '（' + escapeHtml(order.selectedOptions.map((o) => o.name).join('、')) + '）' : ''}</p>${order.note ? `<p class="mt-0.5 break-words text-xs font-bold text-stamp">備註：${escapeHtml(order.note)}</p>` : ''}</div>
          <div class="ml-2 flex shrink-0 items-center gap-2">
            <span class="font-bold tabular-nums text-apricot">$${money(order.outstanding)}</span>
            <button data-action="pay-order" data-order="${order.orderId}" data-user="${student.id}" class="rounded-lg bg-white px-2 py-1 text-[10px] font-bold text-stamp ring-1 ring-stamp/20">繳費</button>
          </div>
        </div>`).join('')}
      <button data-action="settle-all" data-user="${student.id}" class="w-full rounded-xl bg-stamp py-3 text-sm font-bold text-white">現金結清全部（$${money(result.totalDebt)}）</button>` : ''}

    <div class="mt-4 flex gap-2">
      <button data-action="topup" data-user="${student.id}" class="flex-1 rounded-xl bg-ledger py-3 text-sm font-bold text-white">儲值</button>
    </div>
  </div>`;
}


/* ============================ 品項編輯 / AI 辨識 ============================ */
function openItemEditor(storeId, itemId) {
  let item = null;
  let resolvedStoreId = storeId;
  if (itemId) {
    const store = state.admin.catalog?.stores?.find((s) => s.items.some((it) => it.itemId === itemId));
    item = store?.items?.find((it) => it.itemId === itemId);
    resolvedStoreId = store?.storeId;
  }
  const optionsText = (item?.options || []).map((opt) => {
    const base = `${opt.name}${Number(opt.price) ? `:${opt.price}` : ''}`;
    return opt.required && opt.group ? `${base}:${opt.group}` : base;
  }).join('\n');

  modalRoot.innerHTML = `
    <div class="fixed inset-0 z-50 flex items-end justify-center bg-ledger/50">
      <section class="sheet-enter flex max-h-[92dvh] w-full max-w-md flex-col overflow-hidden rounded-t-[1.5rem] bg-paper">
        <div class="flex items-center justify-between border-b border-ledger/10 bg-white px-5 py-4">
          <h2 class="font-serif text-xl font-black">${item ? '編輯品項' : '新增品項'}</h2>
          <button data-close-sheet class="grid h-9 w-9 place-items-center rounded-full bg-mist text-xl">×</button>
        </div>
        <div class="flex-1 overflow-y-auto px-5 py-4">
          <input id="item-store" type="hidden" value="${resolvedStoreId || ''}" />
          <label class="mb-1 block text-xs font-bold text-slate-500">品項名稱</label>
          <input id="item-name" value="${escapeHtml(item?.name || '')}" class="mb-3 w-full rounded-xl border border-slate-200 px-3 py-2.5 outline-none focus:border-ledger" placeholder="例如 火腿蛋吐司" />
          <label class="mb-1 block text-xs font-bold text-slate-500">價格（元）</label>
          <input id="item-price" type="number" inputmode="decimal" value="${item ? item.price : ''}" class="mb-3 w-full rounded-xl border border-slate-200 px-3 py-2.5 outline-none focus:border-ledger" placeholder="例如 45" />
          <label class="mb-3 flex items-center gap-2 text-sm font-bold text-slate-600">
            <input id="item-vegetarian" type="checkbox" ${item?.vegetarian ? 'checked' : ''} class="h-5 w-5 accent-emerald-600" />
            <span>此品項為素食 <span class="veg-badge ml-1">🌱</span></span>
          </label>
          <label class="mb-1 block text-xs font-bold text-slate-500">選項（每行一個；加價用「名稱:價格」；必選（擇一）用「名稱:價格:群組」）</label>
          <textarea id="item-options" rows="4" class="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-ledger" placeholder="可選：加珍珠:10&#10;必選：大:10:大小&#10;必選：小:0:大小">${escapeHtml(optionsText)}</textarea>
        </div>
        <div class="border-t border-ledger/10 bg-white px-5 py-4">
          <button data-action="save-item" data-item="${itemId || ''}" class="w-full rounded-xl bg-ledger py-3 text-sm font-bold text-white">儲存品項</button>
        </div>
      </section>
    </div>`;
}

async function saveItem(itemId) {
  const name = $('#item-name').value.trim();
  const price = Number($('#item-price').value || 0);
  const options = $('#item-options').value.split('\n').map((line) => {
    const parts = line.trim().split(':');
    const name = (parts[0] || '').trim();
    const price = Number(parts[1] || 0);
    const group = (parts.slice(2).join(':') || '').trim();
    if (!name) return null;
    return group ? { name, price, required: true, group } : { name, price, required: false, group: '' };
  }).filter(Boolean);
  const storeId = $('#item-store').value;
  try {
    await busy(async () => {
      await api('adminSaveMenuItem', { storeId, itemId: itemId || undefined, name, price, options, isVegetarian: $('#item-vegetarian')?.checked || false });
      closeModal();
      renderView();
    });
  } catch (error) {
    toast(error.message, 'error');
  }
}

function openAiScan(storeId) {
  modalRoot.innerHTML = `
    <div class="fixed inset-0 z-50 flex items-end justify-center bg-ledger/50">
      <section class="sheet-enter w-full max-w-md rounded-t-[1.5rem] bg-white p-6">
        <div class="flex items-center justify-between">
          <div><p class="text-[11px] font-bold tracking-[.13em] text-stamp">AI OCR</p><h2 class="font-serif text-xl font-black">智慧菜單辨識</h2></div>
          <button data-close-sheet class="grid h-9 w-9 place-items-center rounded-full bg-mist text-xl">×</button>
        </div>
        <p class="mt-4 text-xs font-bold text-slate-500">選擇照片來源：</p>
        <div class="mt-2 grid grid-cols-2 gap-3">
          <label class="flex cursor-pointer flex-col items-center rounded-2xl border-2 border-dashed border-ledger/20 bg-mist/50 px-4 py-7">
            <span class="text-3xl">📷</span>
            <span class="mt-2 text-sm font-bold text-ledger">拍照</span>
            <span class="mt-1 text-xs text-slate-400">開啟相機</span>
            <input id="ai-file-camera" type="file" accept="image/*" capture="environment" class="hidden" />
          </label>
          <label class="flex cursor-pointer flex-col items-center rounded-2xl border-2 border-dashed border-ledger/20 bg-mist/50 px-4 py-7">
            <span class="text-3xl">🖼️</span>
            <span class="mt-2 text-sm font-bold text-ledger">上傳圖片</span>
            <span class="mt-1 text-xs text-slate-400">從相簿選擇</span>
            <input id="ai-file-upload" type="file" accept="image/*" class="hidden" />
          </label>
        </div>
        <p id="ai-status" class="mt-3 text-center text-xs text-slate-400">請選擇照片後開始辨識</p>
      </section>
    </div>`;
  $('#ai-file-camera').addEventListener('change', (event) => handleAiFile(event, storeId));
  $('#ai-file-upload').addEventListener('change', (event) => handleAiFile(event, storeId));
}


/* ============================ 每月菜單（內訂） ============================ */
function openMonthlyScan() {
  modalRoot.innerHTML = `
    <div class="fixed inset-0 z-50 flex items-end justify-center bg-ledger/50">
      <section class="sheet-enter w-full max-w-md rounded-t-[1.5rem] bg-white p-6">
        <div class="flex items-center justify-between">
          <div><p class="text-[11px] font-bold tracking-[.13em] text-stamp">AI OCR · 每月菜單</p><h2 class="font-serif text-xl font-black">上傳廠商每日菜單</h2></div>
          <button data-close-sheet class="grid h-9 w-9 place-items-center rounded-full bg-mist text-xl">×</button>
        </div>
        <div class="mt-4">
          <label class="mb-1 block text-xs font-bold text-slate-500">廠商名稱（店家）</label>
          <input id="monthly-store" placeholder="例如：正園便當、太師傅…" class="mb-3 w-full rounded-xl border border-slate-200 px-3 py-2.5 outline-none focus:border-ledger" />
          <label class="mb-1 block text-xs font-bold text-slate-500">菜單月份（決定日期年份）</label>
          <input id="monthly-month" type="month" value="${todayString().slice(0, 7)}" class="mb-3 w-full rounded-xl border border-slate-200 px-3 py-2.5 outline-none focus:border-ledger" />
        </div>
        <p class="text-xs font-bold text-slate-500">選擇檔案（PDF 或照片，可陸續上傳多家）：</p>
        <div class="mt-2 grid grid-cols-2 gap-3">
          <label class="flex cursor-pointer flex-col items-center rounded-2xl border-2 border-dashed border-ledger/20 bg-mist/50 px-4 py-6">
            <span class="text-3xl">📄</span><span class="mt-2 text-sm font-bold text-ledger">PDF 檔案</span>
            <span class="mt-1 text-xs text-slate-400">每月菜單</span>
            <input id="monthly-pdf" type="file" accept="application/pdf,.pdf" class="hidden" />
          </label>
          <label class="flex cursor-pointer flex-col items-center rounded-2xl border-2 border-dashed border-ledger/20 bg-mist/50 px-4 py-6">
            <span class="text-3xl">📷</span><span class="mt-2 text-sm font-bold text-ledger">拍照/圖片</span>
            <span class="mt-1 text-xs text-slate-400">相機或相簿</span>
            <input id="monthly-img" type="file" accept="image/*" capture="environment" class="hidden" />
          </label>
        </div>
        <p id="monthly-status" class="mt-3 text-center text-xs text-slate-400">每家廠商分別上傳一份菜單，AI 會辨識「每天（或星期一到五）」的餐點與價格。</p>
      </section>
    </div>`;
  const storeInput = $('#monthly-store');
  const monthInput = $('#monthly-month');
  $('#monthly-pdf').addEventListener('change', (event) => handleMonthlyFile(event, storeInput, monthInput));
  $('#monthly-img').addEventListener('change', (event) => handleMonthlyFile(event, storeInput, monthInput));
}

async function handleMonthlyFile(event, storeInput, monthInput) {
  const file = event.target.files?.[0];
  if (!file) return;
  const storeName = (storeInput?.value || '').trim();
  if (!storeName) return toast('請先輸入廠商名稱。', 'error');
  const month = (monthInput?.value || '').trim();
  if (!/^\d{4}-\d{2}$/.test(month)) return toast('請選擇菜單月份。', 'error');
  const statusEl = $('#monthly-status');
  if (statusEl) statusEl.textContent = '檔案處理中…';
  try {
    const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '');
    let imageBase64; let mimeType;
    if (isPdf) {
      imageBase64 = await fileToBase64(file);
      mimeType = 'application/pdf';
    } else {
      ({ imageBase64, mimeType } = await compressImage(file));
    }
    if (statusEl) statusEl.textContent = `辨識「${storeName}」每日菜單中，請稍候…`;
    const result = await api('aiRecognizeMonthlyMenu', { imageBase64, mimeType, month });
    showVendorPreview(storeName, result.entries);
  } catch (error) {
    if (statusEl) statusEl.textContent = error.message;
    else toast(error.message, 'error');
  }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || String(reader.result));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function showVendorPreview(storeName, entries) {
  if (!entries.length) { toast('沒有辨識到任何菜單資料。', 'error'); closeModal(); return; }
  state.monthlyStore = storeName;
  state.monthlyEntries = entries;
  modalRoot.innerHTML = `
    <div class="fixed inset-0 z-50 flex items-end justify-center bg-ledger/50">
      <section class="sheet-enter flex max-h-[92dvh] w-full max-w-md flex-col overflow-hidden rounded-t-[1.5rem] bg-paper">
        <div class="flex items-center justify-between border-b border-ledger/10 bg-white px-5 py-4">
          <div><p class="text-[11px] font-bold tracking-[.13em] text-stamp">PREVIEW</p><h2 class="font-serif text-xl font-black">${escapeHtml(storeName)} · ${entries.length} 天</h2></div>
          <button data-close-sheet class="grid h-9 w-9 place-items-center rounded-full bg-mist text-xl">×</button>
        </div>
        <div class="flex-1 overflow-y-auto px-4 py-3" id="monthly-list"></div>
        <div class="border-t border-ledger/10 bg-white px-5 py-4">
          <button data-action="save-vendor-items" class="w-full rounded-xl bg-stamp py-3 text-sm font-bold text-white">確認匯入（${entries.length} 天）</button>
        </div>
      </section>
    </div>`;
  renderMonthlyList();
}

function renderMonthlyList() {
  const listEl = $('#monthly-list');
  if (!listEl) return;
  if (!state.monthlyEntries.length) {
    listEl.innerHTML = '<p class="py-8 text-center text-sm text-slate-400">沒有辨識到任何資料。</p>';
    return;
  }
  listEl.innerHTML = state.monthlyEntries.map((entry, ei) => `
    <div class="mb-3 rounded-xl bg-white p-3 shadow-sm ring-1 ring-ledger/5">
      <div class="flex items-center justify-between gap-2">
        <label class="flex items-center gap-2 text-xs font-bold text-slate-400">日期
          <input data-entry-date="${ei}" type="date" value="${escapeHtml(entry.date)}" class="rounded-lg border border-slate-200 px-2 py-1.5 text-sm font-bold text-ledger outline-none focus:border-ledger" />
        </label>
        <button data-action="del-monthly-entry" data-index="${ei}" class="shrink-0 rounded-lg bg-red-50 px-2 py-1 text-[11px] font-bold text-red-600">刪除</button>
      </div>
      <div class="mt-2 flex items-center gap-1.5 text-[10px] font-bold text-slate-300">
        <span class="flex-1">種類</span><span class="flex-1">菜色</span><span class="w-16">價格</span><span class="w-7"></span>
      </div>
      <div class="mt-1 space-y-1.5">
        ${entry.items.map((it, ii) => {
          const missing = !it.price || Number(it.price) <= 0;
          return `
          <div class="flex items-center gap-1.5">
            <input data-item-name="${ei}-${ii}" value="${escapeHtml(it.name)}" placeholder="種類" class="min-w-0 flex-1 rounded-lg border border-slate-200 px-2 py-1.5 text-xs outline-none focus:border-ledger" />
            <input data-item-dish="${ei}-${ii}" value="${escapeHtml(it.dish || '')}" placeholder="菜色" class="min-w-0 flex-1 rounded-lg border border-slate-200 px-2 py-1.5 text-xs outline-none focus:border-ledger" />
            <input data-item-price="${ei}-${ii}" type="number" min="0" step="1" value="${it.price || ''}" placeholder="價格" class="w-16 rounded-lg border px-2 py-1.5 text-xs outline-none ${missing ? 'border-red-400 bg-red-50 font-bold text-red-600' : 'border-slate-200 focus:border-ledger'}" />
            <button data-action="del-monthly-item" data-index="${ei}" data-item="${ii}" class="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-slate-100 text-xs text-slate-400">×</button>
          </div>`;
        }).join('')}
      </div>
      <button data-action="add-monthly-item" data-index="${ei}" class="mt-2 rounded-lg bg-mist px-2 py-1 text-[11px] font-bold text-ledger">＋ 加品項</button>
    </div>`).join('');
  bindMonthlyEditors();
}

function bindMonthlyEditors() {
  const listEl = $('#monthly-list');
  if (!listEl) return;
  const pair = (value) => value.split('-').map(Number);
  listEl.querySelectorAll('input[data-entry-date]').forEach((el) => {
    el.addEventListener('input', () => { const i = Number(el.dataset.entryDate); if (state.monthlyEntries[i]) state.monthlyEntries[i].date = el.value; });
  });
  listEl.querySelectorAll('input[data-item-name]').forEach((el) => {
    el.addEventListener('input', () => { const [ei, ii] = pair(el.dataset.itemName); const it = state.monthlyEntries[ei]?.items?.[ii]; if (it) it.name = el.value; });
  });
  listEl.querySelectorAll('input[data-item-dish]').forEach((el) => {
    el.addEventListener('input', () => { const [ei, ii] = pair(el.dataset.itemDish); const it = state.monthlyEntries[ei]?.items?.[ii]; if (it) it.dish = el.value; });
  });
  listEl.querySelectorAll('input[data-item-price]').forEach((el) => {
    el.addEventListener('input', () => { const [ei, ii] = pair(el.dataset.itemPrice); const it = state.monthlyEntries[ei]?.items?.[ii]; if (it) it.price = Number(el.value) || 0; });
  });
}

async function saveVendorItems() {
  const storeName = state.monthlyStore || '';
  const entries = state.monthlyEntries || [];
  const missing = entries.reduce((acc, entry) => acc + (entry.items || []).filter((it) => !it.price || Number(it.price) <= 0).length, 0);
  const doSave = async () => {
    try {
      const result = await api('adminImportVendorMenu', { storeName, entries });
      closeModal();
      toast(`已匯入「${result.storeName}」：${result.createdItems} 個品項、${result.createdSessions} 個場次。`, 'success');
      await refreshAdmin();
    } catch (error) {
      toast(error.message, 'error');
    }
  };
  if (missing > 0) {
    openConfirm('仍有品項未填價格', `有 ${missing} 個品項的價格為 0（未辨識到）。確定仍要匯入嗎？`, doSave);
  } else {
    await busy(doSave);
  }
}

async function handleAiFile(event, storeId) {
  const file = event.target.files?.[0];
  if (!file) return;
  const statusEl = $('#ai-status');
  if (statusEl) statusEl.textContent = '圖片處理中…';
  try {
    const { imageBase64, mimeType } = await compressImage(file);
    if (statusEl) statusEl.textContent = '辨識中，請稍候…';
    const result = await api('aiRecognizeMenu', { imageBase64, mimeType });
    showAiPreview(storeId, result.items);
  } catch (error) {
    if (statusEl) statusEl.textContent = error.message;
    else toast(error.message, 'error');
  }
}

// 上傳前先壓縮（縮小到最大 1280px 的 JPEG），避免超過 Vercel 請求上限並加速辨識
function showAiPreview(storeId, items) {
  if (!items.length) {
    toast('沒有辨識到任何品項。', 'error');
    closeModal();
    return;
  }
  modalRoot.innerHTML = `
    <div class="fixed inset-0 z-50 flex items-end justify-center bg-ledger/50">
      <section class="sheet-enter flex max-h-[92dvh] w-full max-w-md flex-col overflow-hidden rounded-t-[1.5rem] bg-paper">
        <div class="flex items-center justify-between border-b border-ledger/10 bg-white px-5 py-4">
          <div><p class="text-[11px] font-bold tracking-[.13em] text-stamp">PREVIEW</p><h2 class="font-serif text-xl font-black">預覽與微調</h2></div>
          <button data-close-sheet class="grid h-9 w-9 place-items-center rounded-full bg-mist text-xl">×</button>
        </div>
        <div class="flex-1 overflow-y-auto px-4 py-3" id="ai-list"></div>
        <div class="border-t border-ledger/10 bg-white px-5 py-4">
          <button data-action="save-ai-items" data-store="${storeId}" class="w-full rounded-xl bg-stamp py-3 text-sm font-bold text-white">確認寫入（${items.length} 項）</button>
        </div>
      </section>
    </div>`;
  state.aiItems = items.map((item) => ({
    ...item,
    options: (item.options || []).map((opt) => (typeof opt === 'string' ? { name: opt, price: 0, required: false, group: '' } : { name: opt.name || '', price: Number(opt.price) || 0, required: Boolean(opt.required), group: String(opt.group || '') })),
  }));
  renderAiList();
}

function renderAiList() {
  const list = $('#ai-list');
  list.innerHTML = state.aiItems.map((item, index) => `
    <div class="mb-2 rounded-xl bg-white p-3 shadow-sm ring-1 ring-ledger/5">
      <div class="flex items-center gap-2">
        <input data-ai-name="${index}" value="${escapeHtml(item.name)}" class="min-w-0 flex-1 rounded-lg border border-slate-200 px-2.5 py-2 text-sm font-bold outline-none focus:border-ledger" />
        <input data-ai-price="${index}" type="number" inputmode="decimal" value="${item.price}" class="w-20 rounded-lg border border-slate-200 px-2.5 py-2 text-sm outline-none focus:border-ledger" />
        <button data-action="del-ai-item" data-index="${index}" class="grid h-9 w-9 place-items-center rounded-lg bg-red-50 text-red-500">✕</button>
      </div>
      ${(item.options && item.options.length) ? `
        <div class="mt-2 space-y-1.5">
          ${item.options.map((opt, oi) => `
            <div class="flex items-center gap-1.5">
              <label class="flex shrink-0 items-center gap-1 text-[10px] font-bold ${opt.required ? 'text-stamp' : 'text-slate-400'}"><input type="checkbox" data-ai-opt-req="${index}-${oi}" ${opt.required ? 'checked' : ''} class="h-3.5 w-3.5 accent-stamp" />必選</label>
              <input data-ai-opt-name="${index}-${oi}" value="${escapeHtml(opt.name || '')}" placeholder="選項" class="min-w-0 flex-1 rounded-lg border border-slate-200 px-2 py-1.5 text-xs outline-none focus:border-ledger" />
              <input data-ai-opt-price="${index}-${oi}" type="number" inputmode="decimal" value="${opt.price || 0}" placeholder="加價" class="w-14 rounded-lg border border-slate-200 px-2 py-1.5 text-xs outline-none focus:border-ledger" />
              ${opt.required ? `<input data-ai-opt-group="${index}-${oi}" value="${escapeHtml(opt.group || '')}" placeholder="群組" class="w-16 rounded-lg border border-slate-200 px-2 py-1.5 text-xs outline-none focus:border-ledger" />` : ''}
              <button data-action="del-ai-opt" data-index="${index}" data-opt="${oi}" class="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-slate-100 text-xs text-slate-400">×</button>
            </div>`).join('')}
        </div>` : ''}
      <button data-action="add-ai-opt" data-index="${index}" class="mt-2 rounded-lg bg-mist px-2.5 py-1 text-[11px] font-bold text-ledger">＋ 加選項</button>
    </div>`).join('');
  bindAiEditors(list);
}

function bindAiEditors(list) {
  const pair = (value) => value.split('-').map(Number);
  list.querySelectorAll('[data-ai-name]').forEach((el) => {
    el.addEventListener('input', () => { state.aiItems[Number(el.getAttribute('data-ai-name'))].name = el.value; });
  });
  list.querySelectorAll('[data-ai-price]').forEach((el) => {
    el.addEventListener('input', () => { state.aiItems[Number(el.getAttribute('data-ai-price'))].price = Number(el.value || 0); });
  });
  list.querySelectorAll('[data-ai-opt-name]').forEach((el) => {
    el.addEventListener('input', () => {
      const [i, oi] = pair(el.getAttribute('data-ai-opt-name'));
      const opt = state.aiItems[i]?.options?.[oi];
      if (opt) opt.name = el.value;
    });
  });
  list.querySelectorAll('[data-ai-opt-price]').forEach((el) => {
    el.addEventListener('input', () => {
      const [i, oi] = pair(el.getAttribute('data-ai-opt-price'));
      const opt = state.aiItems[i]?.options?.[oi];
      if (opt) opt.price = Number(el.value || 0);
    });
  });
  list.querySelectorAll('[data-ai-opt-req]').forEach((el) => {
    el.addEventListener('change', () => {
      const [i, oi] = pair(el.getAttribute('data-ai-opt-req'));
      const opt = state.aiItems[i]?.options?.[oi];
      if (opt) { opt.required = el.checked; if (el.checked && !opt.group) opt.group = '必選'; renderAiList(); }
    });
  });
  list.querySelectorAll('[data-ai-opt-group]').forEach((el) => {
    el.addEventListener('input', () => {
      const [i, oi] = pair(el.getAttribute('data-ai-opt-group'));
      const opt = state.aiItems[i]?.options?.[oi];
      if (opt) opt.group = el.value;
    });
  });
}

async function saveAiItems(storeId) {
  const items = state.aiItems
    .map((item) => ({
      name: String(item.name || '').trim(),
      price: Number(item.price) || 0,
      options: (item.options || [])
        .map((opt) => ({ name: String(opt.name || '').trim(), price: Number(opt.price) || 0, required: Boolean(opt.required), group: opt.required ? (String(opt.group || '').trim() || '必選') : '' }))
        .filter((opt) => opt.name),
    }))
    .filter((item) => item.name);
  try {
    await busy(async () => {
      const result = await api('adminBatchSaveMenuItems', { storeId, items });
      closeModal();
      toast(`已寫入 ${result.created} 個品項。`, 'success');
      renderView();
    });
  } catch (error) {
    toast(error.message, 'error');
  }
}


/* ============================ 排程場次編輯 ============================ */
function openSessionEditor(date, sessionId) {
  const storeOptions = (state.admin.schedule?.stores || []).map((store) => `<option value="${store.storeId}">${escapeHtml(store.name)}</option>`).join('');
  const existing = sessionId ? (state.admin.schedule?.sessions || []).find((s) => s.sessionId === sessionId) : null;
  const cutoffDefault = existing ? existing.cutoffTime.slice(0, 16) : `${date}T10:00`;

  modalRoot.innerHTML = `
    <div class="fixed inset-0 z-50 flex items-end justify-center bg-ledger/50">
      <section class="sheet-enter w-full max-w-md rounded-t-[1.5rem] bg-white p-6">
        <div class="flex items-center justify-between">
          <h2 class="font-serif text-xl font-black">${existing ? '編輯場次' : '新增場次'}</h2>
          <button data-close-sheet class="grid h-9 w-9 place-items-center rounded-full bg-mist text-xl">×</button>
        </div>
        <form id="session-form" class="mt-4 space-y-3">
          <input type="hidden" id="sess-id" value="${sessionId || ''}" />
          <input type="hidden" id="sess-date" value="${date || existing?.orderDate || ''}" />
          <div>
            <label class="mb-1 block text-xs font-bold text-slate-500">店家</label>
            <select id="sess-store" class="w-full rounded-xl border border-slate-200 px-3 py-2.5 outline-none focus:border-ledger">${storeOptions}</select>
          </div>
          <div>
            <label class="mb-1 block text-xs font-bold text-slate-500">訂購截止時間</label>
            <input id="sess-cutoff" type="datetime-local" value="${cutoffDefault}" class="w-full rounded-xl border border-slate-200 px-3 py-2.5 outline-none focus:border-ledger" />
          </div>
          <button type="submit" class="w-full rounded-xl bg-ledger py-3 text-sm font-bold text-white">儲存場次</button>
        </form>
      </section>
    </div>`;
  $('#session-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const sessionId2 = $('#sess-id').value;
    const orderDate = $('#sess-date').value;
    const storeId = $('#sess-store').value;
    const cutoffTime = new Date($('#sess-cutoff').value).toISOString();
    try {
      await busy(async () => {
        await api('adminSaveSession', { sessionId: sessionId2 || undefined, storeId, orderDate, cutoffTime });
        closeModal();
        await refreshAdmin();
      });
    } catch (error) {
      toast(error.message, 'error');
    }
  });
}


/* ============================ 儲值 / 新增帳號 / 改密碼 ============================ */
function openTopupModal(userId) {
  promptModal('儲值', [{ name: 'amount', label: '儲值金額（元）', type: 'number' }], async (v) => {
    const r = await api('adminTopUp', { userId, amount: Number(v.amount) });
    toast(`儲值完成：抵欠款 $${money(r.appliedToDebt)}，餘額 ${fmtMoney(r.walletBalance)}，尚欠 $${money(r.remainingDebt)}。`, 'success');
    await refreshAdmin();
  });
}

function openAdjustBalanceModal(userId) {
  promptModal('調整餘額（＋加值／－扣除）', [
    { name: 'amount', label: '金額（正數＝加值，負數＝扣除）', type: 'number', placeholder: '例如 -50 表示扣除 50 元' },
    { name: 'note', label: '備註（可選）', type: 'text', placeholder: '例如：代墊退款' },
  ], async (v) => {
    const amount = Number(v.amount);
    if (!Number.isFinite(amount) || amount === 0) return toast('請輸入正確金額。', 'error');
    const r = await api('adminManualBalance', { userId, amount, note: v.note });
    toast(`已調整，目前餘額 ${fmtMoney(r.walletBalance)}。`, 'success');
    await refreshAdmin();
  });
}

function openAddUserModal() {
  modalRoot.innerHTML = `
    <div class="fixed inset-0 z-50 flex items-end justify-center bg-ledger/50">
      <section class="sheet-enter w-full max-w-md rounded-t-[1.5rem] bg-white p-6">
        <div class="flex items-center justify-between">
          <h2 class="font-serif text-xl font-black">新增帳號</h2>
          <button data-close-sheet class="grid h-9 w-9 place-items-center rounded-full bg-mist text-xl">×</button>
        </div>
        <form id="add-user-form" class="mt-4 space-y-3">
          <div class="grid grid-cols-2 gap-2">
            <div><label class="mb-1 block text-xs font-bold text-slate-500">座號/學號</label><input name="studentNo" inputmode="numeric" class="w-full rounded-xl border border-slate-200 px-3 py-2.5 outline-none focus:border-ledger" /></div>
            <div><label class="mb-1 block text-xs font-bold text-slate-500">座號（排序用）</label><input name="seatNo" inputmode="numeric" class="w-full rounded-xl border border-slate-200 px-3 py-2.5 outline-none focus:border-ledger" /></div>
          </div>
          <div><label class="mb-1 block text-xs font-bold text-slate-500">姓名</label><input name="studentName" class="w-full rounded-xl border border-slate-200 px-3 py-2.5 outline-none focus:border-ledger" /></div>
          <div><label class="mb-1 block text-xs font-bold text-slate-500">初始密碼（至少 8 字元）</label><input name="password" type="password" class="w-full rounded-xl border border-slate-200 px-3 py-2.5 outline-none focus:border-ledger" /></div>
          <div><label class="mb-1 block text-xs font-bold text-slate-500">權限</label>
            <select name="role" class="w-full rounded-xl border border-slate-200 px-3 py-2.5 outline-none focus:border-ledger"><option value="Student">一般學生</option><option value="Admin">管理者</option></select>
          </div>
          <button type="submit" class="w-full rounded-xl bg-ledger py-3 text-sm font-bold text-white">建立帳號</button>
        </form>
      </section>
    </div>`;
  $('#add-user-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.target;
    try {
      await busy(async () => {
        await api('adminCreateUser', {
          studentNo: form.studentNo.value.trim(),
          seatNo: form.seatNo.value.trim(),
          studentName: form.studentName.value.trim(),
          password: form.password.value,
          role: form.role.value,
        });
        closeModal();
        await refreshAdmin();
      });
    } catch (error) {
      toast(error.message, 'error');
    }
  });
}

function promptChangePassword() {
  promptModal('修改密碼', [
    { name: 'oldPassword', label: '目前密碼', type: 'password' },
    { name: 'newPassword', label: '新密碼（至少 8 字元）', type: 'password' },
    { name: 'newPassword2', label: '再次輸入新密碼', type: 'password' },
  ], async (v) => {
    if (v.newPassword !== v.newPassword2) return toast('兩次密碼輸入不一致。', 'error');
    const r = await api('changePassword', { oldPassword: v.oldPassword, newPassword: v.newPassword });
    state.token = r.token;
    localStorage.setItem('meal.token', r.token);
    state.user = r.user;
    toast('密碼已更新。', 'success');
    render();
  });
}

export { renderAdminView };
export { renderAdminTab };
export { openScanner };
export { renderVerifyResult };
export { openTopupModal };
export { openPayModal };
export { openAdjustBalanceModal };
export { openSessionEditor };
export { openItemEditor };
export { openLeaveModal };
export { openTreatSessionModal };
export { openDebtModal };
export { openChangelogModal };
export { openManageChangelogModal };
export { openAiSettingsModal };
export { promptChangePassword };
export { openAddUserModal };
export { openAiScan };
export { openMonthlyScan };
export { exportActivity };
export { exportCsv };
export { viewOverdue };
export { copyOverdue };

export { saveVendorItems };
export { saveItem };
export { saveAiItems };
export { renderAiList };
export { renderMonthlyList };
