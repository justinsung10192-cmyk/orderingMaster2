/* ============================================================================
 * 班級訂餐管理系統 — 前端（Mobile-First PWA）
 * Vanilla JS + Tailwind（CDN）。所有資料經 /api/gas 代理至 Supabase。
 * ==========================================================================*/
import {
  money, fmtMoney, todayString, nextWeekLabel, weekLabelOf, weekDates,
  weekdayName, monthDay, weekFriendlyLabel, formatClock, cutoffRemaining,
  escapeHtml, paymentLabel, paymentColor, buildCsv,
} from './lunchDomain.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const app = $('#app');
const modalRoot = $('#modal-root');
const toastRoot = $('#toast-root');

const state = {
  token: localStorage.getItem('meal.token') || '',
  user: null,
  view: 'order',
  adminTab: 'dashboard',
  boot: null, // getBootstrap 結果
  collapsedWeeks: new Set(),
  collapsedDates: new Set(),
  collapsedStores: new Set(),
  orderDraft: null,
  admin: {
    dashboard: null, dashboardDate: todayString(),
    catalog: null, schedule: null, scheduleWeek: nextWeekLabel(),
    users: null, settings: null, overdue: null,
    verify: null, verifyMode: 'scan',
  },
  scanner: null,
  deferredInstall: null,
  push: { supported: false, subscribed: false },
  busy: false,
};

const ICONS = { order: '⌑', vote: '♡', wallet: '¤', admin: '✓', settings: '☷' };

/* ============================ API ============================ */
async function api(action, data = {}) {
  const res = await fetch(window.LUNCH_CONFIG.apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, data, token: state.token }),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(json.error || '操作失敗，請稍後再試。');
  return json.data;
}

function toast(message, type = 'info') {
  const color = type === 'error' ? 'bg-red-600' : type === 'success' ? 'bg-stamp' : 'bg-ledger';
  const el = document.createElement('div');
  el.className = `view-enter rounded-xl ${color} px-4 py-3 text-sm font-bold text-white shadow-lift`;
  el.textContent = message;
  toastRoot.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

async function busy(fn) {
  if (state.busy) return;
  state.busy = true;
  document.body.classList.add('is-busy');
  try { await fn(); } finally { state.busy = false; document.body.classList.remove('is-busy'); }
}

/* ============================ 啟動流程 ============================ */
async function bootstrap() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    state.deferredInstall = event;
    if (state.user) render();
  });
  if (state.token) {
    try {
      state.boot = await api('getBootstrap');
      state.user = state.boot.user;
      render();
      return;
    } catch (_) {
      state.token = '';
      localStorage.removeItem('meal.token');
    }
  }
  state.user = null;
  render();
}

setInterval(tickCountdowns, 1000);

function tickCountdowns() {
  $$('[data-cutoff]').forEach((el) => {
    const iso = el.getAttribute('data-cutoff');
    if (!iso) return;
    const { passed, text } = cutoffRemaining(iso);
    el.textContent = text;
    el.classList.toggle('text-red-600', passed);
  });
}

/* ============================ 登入 / 首次設定 ============================ */
function renderAuth() {
  app.innerHTML = `
    <main class="min-h-dvh bg-paper relative overflow-hidden">
      <div class="absolute inset-x-0 top-0 h-[34%] bg-ledger"></div>
      <section class="safe-top relative mx-auto flex min-h-dvh max-w-md flex-col px-6 pb-8">
        <div class="flex items-center gap-3 pt-2 text-white">
          <span class="grid h-14 w-14 place-items-center rounded-2xl border border-white/20 bg-white/10 font-serif text-2xl">⌑</span>
          <div><p class="font-serif text-xl font-black tracking-wide">班級訂餐</p><p class="text-xs text-blue-100">午間事務，清楚完成</p></div>
        </div>
        <div class="relative mt-8 overflow-hidden rounded-[1.35rem] bg-white shadow-lift">
          <div class="bg-ledger px-7 py-5 text-white">
            <p class="text-xs font-bold tracking-[.16em] text-blue-200">SIGN IN</p>
            <h1 class="mt-1 font-serif text-2xl font-black">登入</h1>
          </div>
          <form id="login-form" class="space-y-4 px-7 py-7">
            <div>
              <label class="mb-1 block text-xs font-bold text-slate-500">座號</label>
              <input name="studentNo" inputmode="numeric" class="w-full rounded-xl border border-slate-200 px-4 py-3 text-lg outline-none focus:border-ledger" placeholder="例如 01" autocomplete="username" />
            </div>
            <div>
              <label class="mb-1 block text-xs font-bold text-slate-500">密碼</label>
              <input name="password" type="password" class="w-full rounded-xl border border-slate-200 px-4 py-3 text-lg outline-none focus:border-ledger" placeholder="••••••••" autocomplete="current-password" />
            </div>
            <button type="submit" class="w-full rounded-xl bg-ledger py-3.5 text-sm font-bold text-white">登入</button>
            <p class="text-center text-xs leading-5 text-slate-400">首次登入請使用預設密碼，登入後系統會要求你修改。</p>
          </form>
        </div>
      </section>
    </main>`;
  $('#login-form').addEventListener('submit', onLogin);
}

async function onLogin(event) {
  event.preventDefault();
  const studentNo = $('input[name="studentNo"]').value.trim();
  const password = $('input[name="password"]').value;
  try {
    await busy(async () => {
      const result = await api('login', { studentNo, password });
      state.token = result.token;
      state.user = result.user;
      localStorage.setItem('meal.token', result.token);
      if (result.user.mustChangePassword) {
        renderSetup();
      } else {
        state.boot = await api('getBootstrap');
        state.user = state.boot.user;
        render();
      }
    });
  } catch (error) {
    toast(error.message, 'error');
  }
}

function renderSetup() {
  app.innerHTML = `
    <main class="min-h-dvh bg-paper relative overflow-hidden">
      <div class="absolute inset-x-0 top-0 h-[30%] bg-ledger"></div>
      <section class="safe-top relative mx-auto flex min-h-dvh max-w-md flex-col px-6 pb-8">
        <div class="text-white pt-2">
          <p class="text-xs font-bold tracking-[.16em] text-blue-200">FIRST LOGIN</p>
          <h1 class="mt-1 font-serif text-2xl font-black">第一次使用</h1>
          <p class="mt-1 text-sm text-blue-100">為保護帳號安全，請設定你的姓名與新密碼。</p>
        </div>
        <div class="mt-6 rounded-[1.35rem] bg-white p-7 shadow-lift">
          <form id="setup-form" class="space-y-4">
            <div>
              <label class="mb-1 block text-xs font-bold text-slate-500">你的姓名</label>
              <input name="studentName" class="w-full rounded-xl border border-slate-200 px-4 py-3 text-lg outline-none focus:border-ledger" placeholder="真實姓名" />
            </div>
            <div>
              <label class="mb-1 block text-xs font-bold text-slate-500">新密碼（至少 8 字元）</label>
              <input name="password" type="password" class="w-full rounded-xl border border-slate-200 px-4 py-3 text-lg outline-none focus:border-ledger" placeholder="••••••••" />
            </div>
            <div>
              <label class="mb-1 block text-xs font-bold text-slate-500">再次輸入新密碼</label>
              <input name="password2" type="password" class="w-full rounded-xl border border-slate-200 px-4 py-3 text-lg outline-none focus:border-ledger" placeholder="••••••••" />
            </div>
            <button type="submit" class="w-full rounded-xl bg-stamp py-3.5 text-sm font-bold text-white">完成設定</button>
          </form>
        </div>
      </section>
    </main>`;
  $('#setup-form').addEventListener('submit', onSetup);
}

async function onSetup(event) {
  event.preventDefault();
  const studentName = $('input[name="studentName"]').value.trim();
  const password = $('input[name="password"]').value;
  const password2 = $('input[name="password2"]').value;
  if (password !== password2) return toast('兩次密碼輸入不一致。', 'error');
  try {
    await busy(async () => {
      const result = await api('completeSetup', { studentName, password });
      state.user = result.user;
      state.boot = await api('getBootstrap');
      state.user = state.boot.user;
      render();
    });
    toast('設定完成，歡迎使用！', 'success');
  } catch (error) {
    toast(error.message, 'error');
  }
}

/* ============================ 主畫面（Shell） ============================ */
function render() {
  if (!state.user) return renderAuth();
  if (state.user.mustChangePassword) return renderSetup();

  const navItems = [
    { id: 'order', label: '訂餐', icon: ICONS.order },
    { id: 'vote', label: '投票', icon: ICONS.vote },
    { id: 'wallet', label: '錢包', icon: ICONS.wallet },
    ...(state.user.role === 'Admin' ? [{ id: 'admin', label: '管理', icon: ICONS.admin }] : []),
    { id: 'settings', label: '設定', icon: ICONS.settings },
  ];

  const headerWallet = state.user.role === 'Admin' ? '' :
    `<span id="header-wallet" class="pr-1 text-xs font-bold tabular-nums text-stamp">${fmtMoney(state.user.walletBalance)}</span>`;

  app.innerHTML = `
    <div class="min-h-dvh bg-paper pb-24">
      <header class="safe-top sticky top-0 z-30 border-b border-ledger/5 bg-paper/95 px-4 pb-3 backdrop-blur-lg">
        <div class="mx-auto flex max-w-3xl items-center justify-between">
          <button data-nav="order" class="flex items-center gap-2 text-left">
            <span class="grid h-11 w-11 place-items-center rounded-xl bg-ledger font-serif text-xl text-white">⌑</span>
            <div><p class="font-serif text-base font-black leading-5">班級訂餐</p><p id="header-subtitle" class="text-[11px] text-slate-500">${state.boot?.pureBalanceMode ? '純儲值模式' : '訂餐手帳'}</p></div>
          </button>
          <div class="flex items-center gap-2">
            <button data-action="manual-refresh" class="grid h-9 w-9 place-items-center rounded-full bg-white text-lg font-black text-ledger shadow-sm ring-1 ring-ledger/5" title="重新整理">↻</button>
            <button data-nav="settings" class="flex items-center gap-2 rounded-full bg-white px-2 py-1.5 shadow-sm ring-1 ring-ledger/5">
              <span class="grid h-7 w-7 place-items-center rounded-full bg-ledger text-xs font-bold text-white">${escapeHtml((state.user.seatNo || '?').slice(-2))}</span>
              ${headerWallet}
            </button>
          </div>
        </div>
      </header>
      <main id="view" class="mx-auto max-w-3xl px-4 py-5"></main>
      <nav class="safe-bottom fixed inset-x-0 bottom-0 z-40 border-t border-ledger/10 bg-white/95 px-2 pt-2 backdrop-blur-xl">
        <div class="mx-auto flex max-w-md items-center justify-around">
          ${navItems.map((item) => `
            <button data-nav="${item.id}" class="flex min-w-14 flex-col items-center gap-0.5 rounded-xl px-3 py-1 ${state.view === item.id ? 'text-ledger' : 'text-slate-400'}">
              <span class="text-xl leading-6">${item.icon}</span>
              <span class="text-[11px] font-bold">${item.label}</span>
            </button>`).join('')}
        </div>
      </nav>
    </div>`;

  renderView();
}

function renderView() {
  const view = $('#view');
  if (!view) return;
  if (state.view === 'order') return renderOrderView(view);
  if (state.view === 'vote') return renderVoteView(view);
  if (state.view === 'wallet') return renderWalletView(view);
  if (state.view === 'admin') return renderAdminView(view);
  if (state.view === 'settings') return renderSettingsView(view);
}

/* ============================ 訂餐（資料夾式收納） ============================ */
function groupSessionsByWeek(sessions) {
  const byWeek = new Map();
  sessions.forEach((session) => {
    const week = session.weekLabel || 'other';
    if (!byWeek.has(week)) byWeek.set(week, []);
    byWeek.get(week).push(session);
  });
  return [...byWeek.entries()].sort((a, b) => (a[0] === 'other' ? 1 : b[0] === 'other' ? -1 : a[0].localeCompare(b[0])));
}

function sessionStatus(session) {
  if (session.existingOrder) return '已訂';
  if (cutoffRemaining(session.cutoffTime).passed) return '已截止';
  return '未訂';
}

function renderOrderView(root) {
  const sessions = state.boot?.sessions || [];
  const grouped = groupSessionsByWeek(sessions);
  const openCount = sessions.filter((session) => session.isOpen && !cutoffRemaining(session.cutoffTime).passed).length;

  root.innerHTML = `
    <section class="view-enter space-y-5">
      <div class="relative overflow-hidden rounded-[1.5rem] bg-ledger px-6 py-6 text-white shadow-paper">
        <div class="relative">
          <p class="text-xs font-bold tracking-[.16em] text-blue-200">TODAY'S NOTE</p>
          <h1 class="mt-1 font-serif text-2xl font-black">嗨，${escapeHtml(state.user.name)}</h1>
          <p class="mt-2 text-sm leading-6 text-blue-100">${openCount ? `目前有 ${openCount} 個場次開放訂餐，記得在截止前送出。` : '目前沒有開放訂餐的場次，稍後再來看看。'}</p>
        </div>
      </div>

      <a data-nav="vote" class="flex items-center justify-between rounded-2xl bg-white px-5 py-4 shadow-paper ring-1 ring-ledger/5">
        <div class="flex items-center gap-3">
          <span class="grid h-10 w-10 place-items-center rounded-xl bg-apricot/15 text-apricot">♡</span>
          <div><p class="font-bold">下週店家許願投票</p><p class="text-xs text-slate-500">每週 3 票，投給想吃的店</p></div>
        </div>
        <span class="text-ledger">›</span>
      </a>

      ${grouped.length ? grouped.map(([week, weekSessions]) => {
        const isCollapsed = state.collapsedWeeks.has(week);
        const dates = groupSessionsByDate(weekSessions);
        return `
          <section class="overflow-hidden rounded-2xl bg-white shadow-paper ring-1 ring-ledger/5">
            <button data-toggle-week="${week}" class="flex w-full items-center justify-between px-5 py-4 text-left">
              <div class="flex items-center gap-2">
                <span class="text-xl ${isCollapsed ? '' : ''}">${isCollapsed ? '▸' : '▾'}</span>
                <span class="font-serif text-lg font-black">${escapeHtml(weekFriendlyLabel(week))}</span>
              </div>
              <span class="text-xs text-slate-400">${weekSessions.length} 場次</span>
            </button>
            ${!isCollapsed ? `<div class="border-t border-dashed border-ledger/10">${dates.map(([date, dateSessions]) => renderDateFolder(week, date, dateSessions)).join('')}</div>` : ''}
          </section>`;
      }).join('') : `
        <div class="rounded-2xl border border-dashed border-ledger/20 bg-white/60 px-6 py-12 text-center">
          <p class="text-3xl">🍱</p>
          <p class="mt-3 font-bold text-ledger">尚無開放訂餐的場次</p>
          <p class="mt-1 text-xs text-slate-400">管理者公布菜單後，這裡會依「週別 → 日期」整理呈現。</p>
        </div>`}
    </section>`;
}

function groupSessionsByDate(sessions) {
  const byDate = new Map();
  sessions.forEach((session) => {
    if (!byDate.has(session.orderDate)) byDate.set(session.orderDate, []);
    byDate.get(session.orderDate).push(session);
  });
  return [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

function renderDateFolder(week, date, dateSessions) {
  const key = `${week}|${date}`;
  const isCollapsed = state.collapsedDates.has(key);
  const hasOrder = dateSessions.some((session) => session.existingOrder);
  return `
    <div class="border-b border-dashed border-ledger/10 last:border-b-0">
      <button data-toggle-date="${key}" class="flex w-full items-center justify-between bg-mist/60 px-5 py-2.5 text-left">
        <div class="flex items-center gap-2">
          <span class="text-sm text-ledger/60">${isCollapsed ? '▸' : '▾'}</span>
          <span class="text-sm font-bold text-ledger">${weekdayName(date)} ${monthDay(date)}</span>
          ${hasOrder ? '<span class="rounded-full bg-stamp/10 px-2 py-0.5 text-[10px] font-bold text-stamp">已訂</span>' : ''}
        </div>
        <span class="text-xs text-slate-400">${dateSessions.length} 家</span>
      </button>
      ${!isCollapsed ? `<div class="space-y-1 px-3 py-2">${dateSessions.map(renderSessionRow).join('')}</div>` : ''}
    </div>`;
}

function renderSessionRow(session) {
  const status = sessionStatus(session);
  const passed = cutoffRemaining(session.cutoffTime).passed;
  const badgeColor = session.existingOrder ? 'bg-stamp/10 text-stamp' : passed ? 'bg-slate-100 text-slate-400' : 'bg-apricot/15 text-apricot';
  return `
    <button data-open-session="${session.sessionId}" class="flex w-full items-center justify-between rounded-xl bg-white px-3 py-3 ring-1 ring-ledger/5">
      <div class="min-w-0 text-left">
        <p class="truncate font-bold text-ledger">${escapeHtml(session.storeName)}</p>
        <p class="mt-0.5 text-xs text-slate-500">截止 <span data-cutoff="${session.cutoffTime}">${cutoffRemaining(session.cutoffTime).text}</span></p>
        ${session.existingOrder ? `<p class="mt-0.5 text-xs text-stamp">${fmtMoney(session.existingOrder.totalPrice)} · ${paymentLabel(session.existingOrder.paymentStatus)}</p>` : ''}
      </div>
      <div class="flex items-center gap-2">
        <span class="rounded-full px-2.5 py-1 text-[11px] font-bold ${badgeColor}">${status}</span>
        <span class="text-ledger/40">›</span>
      </div>
    </button>`;
}

/* ============================ 訂餐表單（Bottom Sheet） ============================ */
function openOrderSheet(session) {
  const existing = session.existingOrder;
  const selections = {};
  session.menuItems.forEach((item) => {
    if (existing) {
      const found = existing.items.find((it) => it.itemId === item.itemId);
      if (found) {
        selections[item.itemId] = {
          quantity: found.quantity,
          optionIndexes: found.options.map((option) => item.options.findIndex((opt) => opt.name === option.name)).filter((idx) => idx >= 0),
        };
      }
    }
  });
  state.orderDraft = {
    session,
    selections,
    note: existing?.note || '',
    useWallet: existing ? existing.priorPaid > 0 : true,
  };
  renderOrderSheet();
}

function draftTotal() {
  const draft = state.orderDraft;
  let total = 0;
  let count = 0;
  draft.session.menuItems.forEach((item) => {
    const sel = draft.selections[item.itemId];
    if (!sel || sel.quantity < 1) return;
    const optionTotal = sel.optionIndexes.reduce((sum, idx) => sum + Number(item.options[idx]?.price || 0), 0);
    total += (Number(item.price) + optionTotal) * sel.quantity;
    count += sel.quantity;
  });
  return { total, count };
}

function renderOrderSheet() {
  const draft = state.orderDraft;
  const session = draft.session;
  const { total, count } = draftTotal();
  const balance = Number(session.walletBalance || 0);
  const insufficient = session.pureBalanceMode && total > balance;
  const cutoffPassed = cutoffRemaining(session.cutoffTime).passed;

  modalRoot.innerHTML = `
    <div class="fixed inset-0 z-50 flex items-end justify-center bg-ledger/50">
      <section class="sheet-enter flex max-h-[92dvh] w-full max-w-md flex-col overflow-hidden rounded-t-[1.5rem] bg-paper">
        <div class="flex items-center justify-between border-b border-ledger/10 bg-white px-5 py-4">
          <div>
            <p class="text-[11px] font-bold tracking-[.13em] text-slate-500">ORDER SHEET</p>
            <h2 class="font-serif text-xl font-black">${escapeHtml(session.storeName)}</h2>
            <p class="text-xs text-slate-500">${session.orderDate} · 截止 <span data-cutoff="${session.cutoffTime}">${cutoffRemaining(session.cutoffTime).text}</span></p>
          </div>
          <button data-close-sheet class="grid h-9 w-9 place-items-center rounded-full bg-mist text-xl">×</button>
        </div>

        <div class="flex-1 overflow-y-auto px-4 py-4">
          ${session.menuItems.length ? session.menuItems.map((item) => renderMenuItem(item)).join('') : '<p class="py-10 text-center text-sm text-slate-400">此店家尚無餐點。</p>'}
        </div>

        <div class="border-t border-ledger/10 bg-white px-5 py-4">
          ${cutoffPassed ? `
            <p class="mb-2 rounded-lg bg-amber-50 px-3 py-2 text-xs font-bold text-amber-600">已超過截止時間，訂單不可再修改或刪除。</p>
            <div class="flex items-center justify-between">
              <div><p class="text-xs text-slate-500">共 ${count} 份</p><p class="font-serif text-2xl font-black tabular-nums">${fmtMoney(total)}</p></div>
              <span class="rounded-full bg-slate-100 px-3 py-1 text-xs font-bold text-slate-500">已截止</span>
            </div>
          ` : `
            ${session.pureBalanceMode ? `
              <div class="mb-3 flex items-center justify-between text-sm">
                <span class="text-slate-500">錢包餘額</span>
                <span class="font-bold tabular-nums ${insufficient ? 'text-red-600' : 'text-stamp'}">${fmtMoney(balance)}</span>
              </div>
              ${insufficient ? '<p class="mb-2 rounded-lg bg-red-50 px-3 py-2 text-xs font-bold text-red-600">純儲值模式：餘額不足，無法送出訂單。</p>' : ''}
            ` : `
              <label class="mb-3 flex items-center justify-between text-sm">
                <span class="text-slate-600">使用儲值金支付</span>
                <input type="checkbox" id="use-wallet" ${draft.useWallet ? 'checked' : ''} class="h-5 w-5 accent-stamp" />
              </label>
            `}
            <input id="order-note" maxlength="120" value="${escapeHtml(draft.note)}" placeholder="備註（可選）" class="mb-3 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-ledger" />
            <div class="flex items-center justify-between">
              <div><p class="text-xs text-slate-500">共 ${count} 份</p><p class="font-serif text-2xl font-black tabular-nums">${fmtMoney(total)}</p></div>
              <button id="submit-order" class="rounded-xl ${insufficient ? 'bg-slate-300' : 'bg-ledger'} px-8 py-3.5 text-sm font-bold text-white">${session.existingOrder ? '更新訂單' : '送出訂單'}</button>
            </div>
            ${session.existingOrder ? '<button id="delete-order" class="mt-2 w-full rounded-xl bg-red-50 py-2.5 text-xs font-bold text-red-600">刪除此訂單</button>' : ''}
          `}
        </div>
      </section>
    </div>`;

  $('#use-wallet')?.addEventListener('change', (event) => { state.orderDraft.useWallet = event.target.checked; });
  $('#order-note')?.addEventListener('input', (event) => { state.orderDraft.note = event.target.value; });
  $('#submit-order')?.addEventListener('click', () => { if (!insufficient) submitOrder(); });
  $('#delete-order')?.addEventListener('click', () => openConfirm('刪除訂單', '刪除後已扣儲值金將自動退回。', deleteCurrentOrder));
}

function renderMenuItem(item) {
  const sel = state.orderDraft.selections[item.itemId];
  const quantity = sel?.quantity || 0;
  const optionIndexes = sel?.optionIndexes || [];
  const optionTotal = optionIndexes.reduce((sum, idx) => sum + Number(item.options[idx]?.price || 0), 0);
  return `
    <div class="mb-2 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-ledger/5">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <p class="font-bold text-ledger">${escapeHtml(item.name)}</p>
          <p class="mt-0.5 text-sm font-bold tabular-nums text-stamp">${fmtMoney(Number(item.price) + optionTotal)}</p>
          ${item.options.length ? `<p class="mt-0.5 truncate text-xs text-slate-400">${item.options.map((option) => option.name).join('、')}</p>` : ''}
        </div>
        <div class="flex items-center gap-2">
          <button data-qty="${item.itemId}" data-delta="-1" class="grid h-8 w-8 place-items-center rounded-lg bg-mist text-lg font-bold text-ledger ${quantity < 1 ? 'opacity-40' : ''}">−</button>
          <span class="w-6 text-center text-lg font-black tabular-nums">${quantity}</span>
          <button data-qty="${item.itemId}" data-delta="1" class="grid h-8 w-8 place-items-center rounded-lg bg-ledger text-lg font-bold text-white">＋</button>
        </div>
      </div>
      ${item.options.length ? `
        <div class="mt-3 flex flex-wrap gap-2">
          ${item.options.map((option, idx) => {
            const active = optionIndexes.includes(idx);
            return `<button data-option="${item.itemId}" data-opt-idx="${idx}" class="rounded-full px-3 py-1.5 text-xs font-bold ring-1 ${active ? 'bg-stamp text-white ring-stamp' : 'bg-mist text-ledger ring-ledger/10'}">${escapeHtml(option.name)}${Number(option.price) ? ` +${money(option.price)}` : ''}</button>`;
          }).join('')}
        </div>` : ''}
    </div>`;
}

async function submitOrder() {
  const draft = state.orderDraft;
  const selections = Object.entries(draft.selections)
    .filter(([, sel]) => sel.quantity >= 1)
    .map(([itemId, sel]) => ({ itemId, quantity: sel.quantity, optionIndexes: sel.optionIndexes }));
  if (!selections.length) return toast('請至少選擇一項餐點。', 'error');

  try {
    await busy(async () => {
      const action = draft.session.existingOrder ? 'updateOrder' : 'placeOrder';
      await api(action, { sessionId: draft.session.sessionId, selections, note: draft.note, useWallet: draft.useWallet });
      await refreshBoot();
      closeModal();
      toast('訂單已送出。', 'success');
    });
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function deleteCurrentOrder() {
  const session = state.orderDraft.session;
  try {
    await busy(async () => {
      await api('deleteOrder', { sessionId: session.sessionId });
      await refreshBoot();
      closeModal();
      toast('訂單已刪除。', 'success');
    });
  } catch (error) {
    toast(error.message, 'error');
  }
}

/* ============================ 投票 ============================ */
function renderVoteView(root) {
  const voteWeek = state.boot?.voteWeek || nextWeekLabel();
  const myVotes = new Set(state.boot?.myVotes || []);
  const tally = state.boot?.voteTally || {};
  const stores = state.boot?.stores || [];
  const remaining = 3 - myVotes.size;

  root.innerHTML = `
    <section class="view-enter space-y-5">
      <div class="relative overflow-hidden rounded-[1.5rem] bg-stamp px-6 py-6 text-white shadow-paper">
        <p class="text-xs font-bold tracking-[.16em] text-emerald-100">WISH LIST</p>
        <h1 class="mt-1 font-serif text-2xl font-black">下週店家許願</h1>
        <p class="mt-2 text-sm text-emerald-50">每人每週 3 票，投給你想吃的店家，供管理者參考。</p>
        <div class="mt-4 inline-flex items-center gap-2 rounded-full bg-white/15 px-4 py-2 text-sm font-bold">
          剩餘票數 <span class="text-xl tabular-nums">${remaining}</span> / 3
        </div>
      </div>

      <div class="space-y-2">
        ${stores.map((store) => {
          const voted = myVotes.has(store.storeId);
          const votes = Number(tally[store.storeId] || 0);
          const maxTally = Math.max(1, ...Object.values(tally).map(Number));
          const width = Math.round((votes / maxTally) * 100);
          return `
            <button data-vote="${store.storeId}" class="w-full rounded-2xl bg-white p-4 text-left shadow-paper ring-1 ring-ledger/5">
              <div class="flex items-center justify-between">
                <div class="flex items-center gap-3">
                  <span class="grid h-10 w-10 place-items-center rounded-xl ${voted ? 'bg-stamp text-white' : 'bg-mist text-ledger'}">${voted ? '♥' : '♡'}</span>
                  <div><p class="font-bold text-ledger">${escapeHtml(store.name)}</p><p class="text-xs text-slate-400">${votes} 票</p></div>
                </div>
                ${voted ? '<span class="rounded-full bg-stamp/10 px-3 py-1 text-xs font-bold text-stamp">已投</span>' : '<span class="text-slate-300">›</span>'}
              </div>
              <div class="mt-3 h-1.5 overflow-hidden rounded-full bg-mist">
                <div class="h-full rounded-full bg-stamp" style="width:${width}%"></div>
              </div>
            </button>`;
        }).join('')}
      </div>
    </section>`;
}

async function toggleVote(storeId) {
  const myVotes = new Set(state.boot?.myVotes || []);
  const store = state.boot?.stores?.find((s) => s.storeId === storeId);
  try {
    await busy(async () => {
      if (myVotes.has(storeId)) {
        await api('removeVote', { storeId });
        toast(`已取消「${store.name}」的票。`);
      } else {
        await api('castVote', { storeId });
        toast(`已投給「${store.name}」！`);
      }
      state.boot = await api('getBootstrap');
      render();
    });
  } catch (error) {
    toast(error.message, 'error');
  }
}

/* ============================ 錢包 ============================ */
function renderWalletView(root) {
  const user = state.user;
  root.innerHTML = `
    <section class="view-enter space-y-5">
      <div class="rounded-[1.5rem] bg-stamp px-6 py-6 text-white shadow-paper">
        <p class="text-xs font-bold tracking-[.15em] text-emerald-100">STORED VALUE</p>
        <div class="mt-2 flex items-end justify-between">
          <div><p class="text-sm text-emerald-100">目前儲值餘額</p><p id="wallet-balance" class="mt-1 font-serif text-4xl font-black tabular-nums">${fmtMoney(user.walletBalance)}</p></div>
          <span class="rounded-full bg-white/15 px-3 py-1.5 text-xs font-bold">我的錢包</span>
        </div>
        <button data-action="show-qr" class="mt-4 w-full rounded-xl bg-white/20 py-3 text-sm font-bold text-white">出示取餐 QR / PIN</button>
      </div>

      <section>
        <h1 class="mb-3 font-serif text-xl font-black">我的訂單</h1>
        <div id="wallet-orders" class="space-y-2"></div>
      </section>

      <section>
        <div class="mb-3 flex items-center justify-between">
          <h1 class="font-serif text-xl font-black">交易紀錄</h1>
          <button data-action="refresh-wallet" class="text-xs font-bold text-ledger underline underline-offset-4">重新整理</button>
        </div>
        <div id="wallet-txs" class="space-y-2"></div>
      </section>
    </section>`;
  loadWalletDetail();
}

async function loadWalletDetail() {
  try {
    const data = await api('getWalletHistory');
    state.user = { ...state.user, walletBalance: data.user.walletBalance };
    const balanceEl = $('#wallet-balance');
    const ordersEl = $('#wallet-orders');
    const txsEl = $('#wallet-txs');
    if (!balanceEl || !ordersEl || !txsEl) return; // 畫面已切換，忽略本次結果
    balanceEl.textContent = fmtMoney(data.walletBalance);
    ordersEl.innerHTML = data.orders.length ? data.orders.map((order) => `
      <div class="rounded-xl bg-white p-3.5 shadow-sm ring-1 ring-ledger/5">
        <div class="flex items-center justify-between">
          <p class="font-bold text-ledger">${escapeHtml(order.storeName)}</p>
          <span class="text-sm font-bold tabular-nums">${fmtMoney(order.totalPrice)}</span>
        </div>
        <p class="mt-1 text-xs text-slate-500">${order.orderDate} · ${escapeHtml(order.itemName)}</p>
        <div class="mt-2 flex gap-2">
          <span class="rounded-full px-2 py-0.5 text-[10px] font-bold ${paymentColor(order.paymentStatus)}">${paymentLabel(order.paymentStatus)}</span>
          <span class="rounded-full px-2 py-0.5 text-[10px] font-bold ${order.pickupStatus === 'PickedUp' ? 'bg-stamp/10 text-stamp' : 'bg-slate-100 text-slate-500'}">${order.pickupStatus === 'PickedUp' ? '已取餐' : '未取餐'}</span>
        </div>
      </div>`).join('') : '<p class="rounded-xl bg-white/60 px-4 py-8 text-center text-sm text-slate-400">尚無訂單。</p>';

    txsEl.innerHTML = data.transactions.length ? data.transactions.map((tx) => `
      <div class="flex items-center justify-between rounded-xl bg-white px-4 py-3 shadow-sm ring-1 ring-ledger/5">
        <div><p class="text-sm font-bold text-ledger">${escapeHtml(tx.type)}</p><p class="text-xs text-slate-400">${tx.note || new Date(tx.timestamp).toLocaleString('zh-TW')}</p></div>
        <span class="font-bold tabular-nums ${Number(tx.amount) >= 0 ? 'text-stamp' : 'text-red-600'}">${Number(tx.amount) >= 0 ? '+' : ''}${money(tx.amount)}</span>
      </div>`).join('') : '<p class="rounded-xl bg-white/60 px-4 py-8 text-center text-sm text-slate-400">尚無交易紀錄。</p>';
  } catch (error) {
    toast(error.message, 'error');
  }
}

/* ============================ 我的 QR / PIN ============================ */
async function showMyQr() {
  try {
    const result = await api('createVerification', {});
    const payloadText = JSON.stringify(result.payload);
    modalRoot.innerHTML = `
      <div class="fixed inset-0 z-50 flex items-end justify-center bg-ledger/50">
        <section class="sheet-enter w-full max-w-md rounded-t-[1.5rem] bg-white p-6">
          <div class="flex items-center justify-between">
            <div><p class="text-[11px] font-bold tracking-[.13em] text-slate-500">VERIFICATION PASS</p><h2 class="font-serif text-xl font-black">我的核銷通行證</h2></div>
            <button data-close-sheet class="grid h-9 w-9 place-items-center rounded-full bg-mist text-xl">×</button>
          </div>
          <div class="mt-4 flex flex-col items-center">
            <div id="my-qr" class="rounded-2xl border-2 border-dashed border-ledger/20 p-3"></div>
            <p class="mt-3 text-xs text-slate-400">4 位數 PIN 碼（臨時，5 分鐘後失效）</p>
            <p class="pin-box mt-1 font-serif text-4xl font-black text-ledger">${result.pin}</p>
            <p data-cutoff="${result.expiresAt}" class="mt-2 text-xs font-bold text-apricot">${cutoffRemaining(result.expiresAt).text}</p>
          </div>
          <button data-close-sheet class="mt-5 w-full rounded-xl bg-ledger py-3 text-sm font-bold text-white">完成</button>
        </section>
      </div>`;
    if (window.QRCode) new window.QRCode($('#my-qr'), { text: payloadText, width: 180, height: 180 });
    else $('#my-qr').textContent = 'QR 庫載入中，請稍後重試。';
  } catch (error) {
    toast(error.message, 'error');
  }
}

/* ============================ 管理（Admin） ============================ */
function renderAdminView(root) {
  const tabs = [
    { id: 'dashboard', label: '總覽' },
    { id: 'menu', label: '菜單' },
    { id: 'schedule', label: '排程' },
    { id: 'verify', label: '核銷' },
    { id: 'users', label: '帳號' },
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
    schedule: renderAdminSchedule,
    verify: renderAdminVerify,
    users: renderAdminUsers,
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
            <button data-action="export-csv" class="rounded-xl bg-stamp px-3 py-2 text-xs font-bold text-white">匯出 CSV</button>
          </div>
        </div>
        <div class="grid grid-cols-2 gap-2 sm:grid-cols-4">
          ${statCard('訂單數', totals.orderCount)}
          ${statCard('總金額', `$${money(totals.totalAmount)}`)}
          ${statCard('未繳', `$${money(totals.unpaidAmount)}`)}
          ${statCard('已取餐', totals.pickedUp)}
        </div>
        ${data.overdueCount ? `<button data-action="view-overdue" class="w-full rounded-xl bg-red-50 px-4 py-3 text-left text-sm font-bold text-red-600">⚠️ 有 ${data.overdueCount} 位同學尚未繳費，點此查看</button>` : ''}

        ${data.sessionStats.length ? data.sessionStats.map((session) => `
          <div class="rounded-2xl bg-white p-4 shadow-paper ring-1 ring-ledger/5">
            <div class="flex items-center justify-between">
              <p class="font-bold text-ledger">${escapeHtml(session.storeName)}</p>
              <span class="text-xs text-slate-400">截止 ${formatClock(session.cutoffTime)}</span>
            </div>
            <div class="mt-2 grid grid-cols-3 gap-2 text-center">
              <div class="rounded-lg bg-mist py-2"><p class="text-[10px] text-slate-500">訂單</p><p class="font-black tabular-nums">${session.orderCount}</p></div>
              <div class="rounded-lg bg-mist py-2"><p class="text-[10px] text-slate-500">金額</p><p class="font-black tabular-nums">$${money(session.totalAmount)}</p></div>
              <div class="rounded-lg bg-mist py-2"><p class="text-[10px] text-slate-500">未繳</p><p class="font-black tabular-nums text-red-600">$${money(session.unpaidAmount)}</p></div>
            </div>
          </div>`).join('') : '<p class="rounded-2xl bg-white/60 px-4 py-10 text-center text-sm text-slate-400">今天沒有排定場次。</p>'}

        ${data.orders.length ? `
          <div class="overflow-hidden rounded-2xl bg-white shadow-paper ring-1 ring-ledger/5">
            <p class="border-b border-ledger/5 px-4 py-3 text-sm font-bold">訂單明細</p>
            ${data.orders.map((order) => `
              <div class="flex items-center justify-between border-b border-dashed border-ledger/10 px-4 py-3 last:border-b-0">
                <div class="min-w-0">
                  <p class="text-sm font-bold text-ledger">${escapeHtml(order.seatNo)} ${escapeHtml(order.studentName)}</p>
                  <p class="truncate text-xs text-slate-500">${escapeHtml(order.itemName)}${order.selectedOptions.length ? '（' + escapeHtml(order.selectedOptions.map((o) => o.name).join('、')) + '）' : ''}</p>
                </div>
                <div class="flex items-center gap-2">
                  <div class="text-right">
                    <p class="font-bold tabular-nums">$${money(order.totalPrice)}</p>
                    <span class="text-[10px] font-bold ${paymentColor(order.paymentStatus)}">${paymentLabel(order.paymentStatus)}</span>
                  </div>
                  ${order.outstandingAmount > 0 ? `<button data-action="settle-order" data-order="${order.orderId}" data-user="${order.userId}" class="rounded-lg bg-stamp px-2.5 py-1.5 text-[11px] font-bold text-white">結帳</button>` : ''}
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
  const isCollapsed = state.collapsedStores.has(store.storeId);
  return `
    <section class="overflow-hidden rounded-2xl bg-white shadow-paper ring-1 ring-ledger/5">
      <div class="flex items-center justify-between px-4 py-3.5">
        <button data-toggle-store="${store.storeId}" class="flex flex-1 items-center gap-2 text-left">
          <span class="text-ledger/60">${isCollapsed ? '▸' : '▾'}</span>
          <span class="font-bold text-ledger">${escapeHtml(store.name)}</span>
          <span class="text-xs text-slate-400">${store.items.length} 品項</span>
        </button>
        <div class="flex gap-1.5">
          <button data-action="edit-store" data-store="${store.storeId}" class="rounded-lg bg-mist px-2.5 py-1.5 text-xs font-bold text-ledger">改名</button>
          <button data-action="del-store" data-store="${store.storeId}" class="rounded-lg bg-red-50 px-2.5 py-1.5 text-xs font-bold text-red-600">刪除</button>
        </div>
      </div>
      ${!isCollapsed ? `
        <div class="border-t border-dashed border-ledger/10 px-3 py-2">
          ${store.items.map((item) => `
            <div class="flex items-center justify-between rounded-xl px-2 py-2.5">
              <div class="min-w-0">
                <p class="text-sm font-bold text-ledger">${escapeHtml(item.name)}</p>
                <p class="text-xs text-slate-400">$${money(item.price)}${item.options.length ? ' · ' + escapeHtml(item.options.map((o) => o.name + (Number(o.price) ? `(+${money(o.price)})` : '')).join('、')) : ''}</p>
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
          <div class="flex gap-2">
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
            <button data-action="add-recurring" class="rounded-xl bg-ledger px-3 py-2 text-xs font-bold text-white">＋ 固定店家</button>
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
        <p class="text-xs text-slate-400">掃描 QR、輸入 4 位 PIN，或直接輸入座號，即可快速執行「儲值、扣款結帳、取餐標記」。</p>
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
                  <p class="text-sm font-bold text-ledger">${escapeHtml(user.name)} ${user.role === 'Admin' ? '<span class="rounded bg-apricot/15 px-1.5 py-0.5 text-[10px] font-bold text-apricot">管理</span>' : ''}</p>
                  <p class="text-xs ${user.isDisabled ? 'text-red-400' : 'text-slate-400'}">座號 ${escapeHtml(user.studentNo)} · ${fmtMoney(user.walletBalance)} ${user.isDisabled ? '· 已停用' : ''}</p>
                </div>
              </div>
              <div class="flex gap-1.5">
                ${user.role === 'Admin' ? `<button data-action="demote" data-user="${user.id}" class="rounded-lg bg-mist px-2.5 py-1.5 text-[11px] font-bold text-ledger">移除管理</button>` : `<button data-action="promote" data-user="${user.id}" class="rounded-lg bg-mist px-2.5 py-1.5 text-[11px] font-bold text-stamp">設為管理</button>`}
                <button data-action="toggle-user" data-user="${user.id}" data-disabled="${user.isDisabled}" class="rounded-lg bg-mist px-2.5 py-1.5 text-[11px] font-bold ${user.isDisabled ? 'text-stamp' : 'text-slate-500'}">${user.isDisabled ? '啟用' : '停用'}</button>
                <button data-action="topup" data-user="${user.id}" class="rounded-lg bg-mist px-2.5 py-1.5 text-[11px] font-bold text-stamp">儲值</button>
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
            <select id="remind-days" class="w-full rounded-xl border border-slate-200 px-3 py-2.5 outline-none focus:border-ledger">
              ${[1, 2, 3, 7, 14].map((n) => `<option value="${n}" ${Number(settings.overdueRemindDays) === n ? 'selected' : ''}>每 ${n} 天提醒一次</option>`).join('')}
            </select>
          </div>
          <button data-action="save-settings" class="w-full rounded-xl bg-ledger py-3 text-sm font-bold text-white">儲存設定</button>
        </div>
      </div>
      <button data-action="view-overdue" class="w-full rounded-2xl bg-white px-5 py-4 text-left shadow-paper ring-1 ring-ledger/5">
        <p class="font-bold text-red-600">欠繳催繳名單</p>
        <p class="mt-0.5 text-xs text-slate-500">自動辨識超過星期一仍未繳費的同學</p>
      </button>
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
    const lines = [`📢 午餐費用催繳通知（超過星期一尚未繳費）`, `應繳人數：${data.list.length} 人，總金額 $${money(data.totalDebt)}`, ''];
    data.list.forEach((user) => lines.push(`${user.seatNo}號 ${user.studentName}：$${money(user.debt)}`));
    const text = lines.join('\n');
    await navigator.clipboard.writeText(text);
    toast('已複製催繳明細。', 'success');
  } catch (error) {
    toast('複製失敗，請手動複製。', 'error');
  }
}

/* ============================ 設定（個人） ============================ */
function renderSettingsView(root) {
  const user = state.user;
  root.innerHTML = `
    <section class="view-enter space-y-5">
      <div class="rounded-[1.5rem] bg-white p-5 shadow-paper ring-1 ring-ledger/5">
        <div class="flex items-center gap-4">
          <span class="grid h-14 w-14 place-items-center rounded-2xl bg-ledger text-xl font-black text-white">${escapeHtml((user.seatNo || '?').slice(-2))}</span>
          <div><h1 class="font-serif text-xl font-black">${escapeHtml(user.name)}</h1><p class="mt-1 text-sm text-slate-500">座號 ${escapeHtml(user.studentNo)} · ${user.role === 'Admin' ? '管理者' : '一般學生'}</p></div>
        </div>
        <div class="mt-5 grid grid-cols-2 gap-2">
          <div class="rounded-xl bg-mist px-3 py-3"><p class="text-[11px] font-bold text-slate-500">儲值餘額</p><p class="mt-1 font-bold tabular-nums text-stamp">${fmtMoney(user.walletBalance)}</p></div>
          <div class="rounded-xl bg-mist px-3 py-3"><p class="text-[11px] font-bold text-slate-500">帳號權限</p><p class="mt-1 font-bold text-ledger">${user.role === 'Admin' ? '管理者' : '學生'}</p></div>
        </div>
      </div>

      <div class="overflow-hidden rounded-[1.35rem] bg-white shadow-paper ring-1 ring-ledger/5">
        <button data-action="toggle-notifications" class="flex w-full items-center justify-between px-5 py-4 text-left">
          <span><span class="block font-bold">手機通知</span><span id="notification-status" class="mt-1 block text-xs text-slate-500">檢查中…</span></span>
          <span id="notification-switch" class="grid h-6 w-11 shrink-0 place-items-center rounded-full bg-slate-200 transition"><span class="h-4 w-4 rounded-full bg-white shadow"></span></span>
        </button>
        <div class="mx-5 h-px bg-slate-100"></div>
        <button data-action="install-app" id="install-app-button" class="hidden w-full items-center justify-between px-5 py-4 text-left">
          <span><span class="block font-bold">釘選到桌面</span><span class="mt-1 block text-xs text-slate-500">像 App 一樣使用，通知更可靠。</span></span><span class="text-ledger">›</span>
        </button>
        <div class="mx-5 h-px bg-slate-100"></div>
        <button data-action="change-password" class="flex w-full items-center justify-between px-5 py-4 text-left">
          <span><span class="block font-bold">修改密碼</span><span class="mt-1 block text-xs text-slate-500">定期更新你的登入密碼。</span></span><span class="text-ledger">›</span>
        </button>
        <div class="mx-5 h-px bg-slate-100"></div>
        <button data-action="change-name" class="flex w-full items-center justify-between px-5 py-4 text-left">
          <span><span class="block font-bold">修改姓名</span><span class="mt-1 block text-xs text-slate-500">更新你顯示在系統中的姓名。</span></span><span class="text-ledger">›</span>
        </button>
        <div class="mx-5 h-px bg-slate-100"></div>
        <button data-action="logout" class="flex w-full items-center justify-between px-5 py-4 text-left text-red-600">
          <span><span class="block font-bold">登出</span><span class="mt-1 block text-xs text-red-400">清除本機的登入憑證。</span></span><span>›</span>
        </button>
      </div>
    </section>`;
  initPushUI();
}

function initPushUI() {
  state.push.supported = 'serviceWorker' in navigator && 'PushManager' in window;
  if (!state.push.supported) {
    const statusEl = $('#notification-status');
    if (statusEl) statusEl.textContent = '此瀏覽器不支援推播通知。';
    return;
  }
  navigator.serviceWorker.ready.then(async (registration) => {
    const subscription = await registration.pushManager.getSubscription();
    state.push.subscribed = Boolean(subscription);
    updateNotificationUI();
  });
  if (state.deferredInstall) $('#install-app-button').classList.remove('hidden');
}

function updateNotificationUI() {
  const status = $('#notification-status');
  const toggle = $('#notification-switch');
  if (!status || !toggle) return;
  status.textContent = state.push.subscribed ? '已開啟' : '未開啟';
  toggle.className = `grid h-6 w-11 shrink-0 place-items-center rounded-full transition ${state.push.subscribed ? 'bg-stamp' : 'bg-slate-200'}`;
  toggle.innerHTML = `<span class="h-4 w-4 rounded-full bg-white shadow transition ${state.push.subscribed ? 'translate-x-2.5' : '-translate-x-2.5'}"></span>`;
}

async function toggleNotifications() {
  if (!state.push.supported) return;
  try {
    if (state.push.subscribed) {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        await subscription.unsubscribe();
        api('pushUnsubscribe', { endpoint: subscription.endpoint }).catch(() => {});
      }
      state.push.subscribed = false;
      updateNotificationUI();
      toast('已關閉通知。');
      return;
    }
    const config = await api('getPublicConfig');
    const key = config.vapidPublicKey;
    if (!key) return toast('伺服器尚未設定 VAPID 金鑰。', 'error');
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(key),
    });
    await api('pushSubscribe', { endpoint: subscription.endpoint, keys: subscription.toJSON().keys, deviceLabel: navigator.userAgent.slice(0, 60) });
    state.push.subscribed = true;
    updateNotificationUI();
    toast('通知已開啟！', 'success');
  } catch (error) {
    toast('無法開啟通知：請確認已允許通知權限。', 'error');
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i += 1) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
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
          <p class="text-xs leading-5 text-slate-500">或手動輸入 4 位 PIN：</p>
          <div class="mt-2 flex gap-2">
            <input id="manual-pin" inputmode="numeric" maxlength="4" class="pin-box min-w-0 flex-1 rounded-xl border border-slate-200 px-3 py-2.5 text-center text-xl font-black outline-none focus:border-ledger" placeholder="••••" />
            <button data-action="submit-pin" class="rounded-xl bg-stamp px-4 text-xs font-bold text-white">驗證</button>
          </div>
        </div>
      </section>
    </div>`;

  if (window.Html5Qrcode) {
    state.scanner = new window.Html5Qrcode('qr-reader');
    state.scanner.start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: { width: 220, height: 220 } },
      onScanSuccess,
      () => {},
    ).catch(() => {
      const readerEl = $('#qr-reader');
      if (readerEl) readerEl.innerHTML = '<p class="p-6 text-center text-xs text-slate-400">無法啟動相機，請改用 PIN 輸入。</p>';
    });
  } else {
    $('#qr-reader').innerHTML = '<p class="p-6 text-center text-xs text-slate-400">掃描元件載入中…</p>';
  }
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
  return `
    <div class="rounded-2xl bg-white p-5 shadow-paper ring-1 ring-ledger/5">
      <div class="flex items-center gap-3">
        <span class="grid h-12 w-12 place-items-center rounded-xl bg-stamp text-lg font-black text-white">${escapeHtml(result.student.seatNo || '?')}</span>
        <div>
          <p class="font-serif text-lg font-black">${escapeHtml(result.student.name)}</p>
          <p class="text-xs text-slate-500">餘額 ${fmtMoney(result.walletBalance)} · 未繳 ${fmtMoney(result.totalDebt)}</p>
        </div>
      </div>

      ${result.todayOrders.length ? `
        <p class="mb-2 mt-4 text-sm font-bold">今日訂單（取餐標記）</p>
        ${result.todayOrders.map((order) => `
          <div class="mb-2 flex items-center justify-between rounded-xl bg-mist/60 px-3 py-2.5">
            <div><p class="text-sm font-bold text-ledger">${escapeHtml(order.storeName)}</p><p class="text-xs text-slate-500">${escapeHtml(order.itemName)} · $${money(order.totalPrice)}</p></div>
            <button data-action="confirm-pickup" data-order="${order.orderId}" data-user="${result.student.id}" class="rounded-lg ${order.pickupStatus === 'PickedUp' ? 'bg-slate-200 text-slate-400' : 'bg-stamp text-white'} px-3 py-2 text-xs font-bold">${order.pickupStatus === 'PickedUp' ? '已取餐' : '標記取餐'}</button>
          </div>`).join('')}` : ''}

      ${result.unpaidOrders.length ? `
        <p class="mb-2 mt-4 text-sm font-bold">待結帳訂單</p>
        ${result.unpaidOrders.map((order) => `
          <div class="mb-2 flex items-center justify-between rounded-xl bg-amber-50 px-3 py-2.5">
            <div><p class="text-sm font-bold text-ledger">${escapeHtml(order.orderDate)} ${escapeHtml(order.storeName)}</p><p class="text-xs text-slate-500">${escapeHtml(order.itemName)}</p></div>
            <span class="font-bold tabular-nums text-apricot">$${money(order.outstanding)}</span>
          </div>`).join('')}
        <button data-action="settle-all" data-user="${result.student.id}" class="w-full rounded-xl bg-stamp py-3 text-sm font-bold text-white">現金結清全部（$${money(result.totalDebt)}）</button>` : ''}

      <div class="mt-4 flex gap-2">
        <button data-action="topup" data-user="${result.student.id}" class="flex-1 rounded-xl bg-ledger py-3 text-sm font-bold text-white">儲值</button>
      </div>
    </div>`;
}

/* ============================ 各種 Modal 與動作 ============================ */
function openConfirm(title, body, onConfirm) {
  modalRoot.innerHTML = `
    <div class="fixed inset-0 z-50 flex items-center justify-center bg-ledger/50 p-5">
      <section class="view-enter w-full max-w-sm rounded-[1.35rem] bg-white p-5 shadow-lift">
        <p class="text-[11px] font-bold tracking-[.13em] text-slate-500">CONFIRM</p>
        <h2 class="mt-1 font-serif text-lg font-black">${title}</h2>
        <p class="mt-2 text-sm leading-6 text-slate-600">${body}</p>
        <div class="mt-5 flex gap-2">
          <button data-close-sheet class="flex-1 rounded-xl bg-mist py-3 text-sm font-bold text-ledger">取消</button>
          <button id="confirm-ok" class="flex-1 rounded-xl bg-red-600 py-3 text-sm font-bold text-white">確認</button>
        </div>
      </section>
    </div>`;
  $('#confirm-ok').addEventListener('click', async () => {
    closeModal();
    await busy(onConfirm);
  });
}

function promptModal(title, fields, onSubmit) {
  modalRoot.innerHTML = `
    <div class="fixed inset-0 z-50 flex items-end justify-center bg-ledger/50">
      <section class="sheet-enter w-full max-w-md rounded-t-[1.5rem] bg-white p-6">
        <div class="flex items-center justify-between">
          <div><p class="text-[11px] font-bold tracking-[.13em] text-slate-500">INPUT</p><h2 class="font-serif text-xl font-black">${title}</h2></div>
          <button data-close-sheet class="grid h-9 w-9 place-items-center rounded-full bg-mist text-xl">×</button>
        </div>
        <form id="prompt-form" class="mt-4 space-y-3">
          ${fields.map((field) => `
            <div>
              <label class="mb-1 block text-xs font-bold text-slate-500">${field.label}</label>
              ${field.type === 'select' ? `<select name="${field.name}" class="w-full rounded-xl border border-slate-200 px-3 py-2.5 outline-none focus:border-ledger">${(field.options || []).map((opt) => `<option value="${escapeHtml(opt.value)}">${escapeHtml(opt.label)}</option>`).join('')}</select>` : `<input name="${field.name}" type="${field.type || 'text'}" ${field.value !== undefined ? `value="${escapeHtml(field.value)}"` : ''} placeholder="${field.placeholder || ''}" class="w-full rounded-xl border border-slate-200 px-3 py-2.5 outline-none focus:border-ledger" />`}
            </div>`).join('')}
          <button type="submit" class="w-full rounded-xl bg-ledger py-3 text-sm font-bold text-white">確定</button>
        </form>
      </section>
    </div>`;
  $('#prompt-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const values = {};
    fields.forEach((field) => { values[field.name] = $(`[name="${field.name}"]`).value; });
    closeModal();
    await busy(() => onSubmit(values));
  });
}

function closeModal() {
  modalRoot.innerHTML = '';
  if (state.scanner) { try { state.scanner.stop(); } catch (_) {} state.scanner = null; }
}

async function refreshBoot() {
  state.boot = await api('getBootstrap');
  state.user = state.boot.user;
}

async function withAdminRefresh(fn) {
  await busy(async () => {
    await fn();
    state.boot = await api('getBootstrap');
    render();
  });
}

/* ============================ 事件委派 ============================ */
document.addEventListener('click', onClick);

async function onClick(event) {
  const target = event.target.closest('[data-action], [data-nav], [data-admin-tab], [data-toggle-week], [data-toggle-date], [data-toggle-store], [data-open-session], [data-close-sheet], [data-qty], [data-option], [data-vote], [data-schedule-week], [data-store], [data-item], [data-user], [data-date], [data-session], [data-order], [data-disabled]');
  if (!target) return;

  const action = target.getAttribute('data-action');
  const nav = target.getAttribute('data-nav');
  const adminTab = target.getAttribute('data-admin-tab');
  const toggleWeek = target.getAttribute('data-toggle-week');
  const toggleDate = target.getAttribute('data-toggle-date');
  const toggleStore = target.getAttribute('data-toggle-store');
  const openSession = target.getAttribute('data-open-session');
  const qty = target.getAttribute('data-qty');
  const option = target.getAttribute('data-option');
  const vote = target.getAttribute('data-vote');
  const scheduleWeek = target.getAttribute('data-schedule-week');

  if (nav) {
    if (nav === 'settings' && !state.user) return;
    state.view = nav;
    if (nav === 'admin') state.adminTab = 'dashboard';
    render();
    refreshBoot()
      .then(() => { if (state.view === nav && state.user) render(); })
      .catch(() => {});
    return;
  }
  if (adminTab) {
    state.adminTab = adminTab;
    render();
    return;
  }
  if (toggleWeek) {
    const week = toggleWeek;
    if (state.collapsedWeeks.has(week)) state.collapsedWeeks.delete(week); else state.collapsedWeeks.add(week);
    renderView();
    return;
  }
  if (toggleDate) {
    if (state.collapsedDates.has(toggleDate)) state.collapsedDates.delete(toggleDate); else state.collapsedDates.add(toggleDate);
    renderView();
    return;
  }
  if (toggleStore) {
    if (state.collapsedStores.has(toggleStore)) state.collapsedStores.delete(toggleStore); else state.collapsedStores.add(toggleStore);
    renderAdminTab();
    return;
  }
  if (openSession) {
    const session = (state.boot?.sessions || []).find((s) => s.sessionId === openSession);
    if (session) openOrderSheet(session);
    return;
  }
  if (qty) {
    const delta = Number(target.getAttribute('data-delta'));
    const sel = state.orderDraft.selections[qty] || { quantity: 0, optionIndexes: [] };
    sel.quantity = Math.max(0, Math.min(99, sel.quantity + delta));
    if (sel.quantity > 0) state.orderDraft.selections[qty] = sel; else delete state.orderDraft.selections[qty];
    renderOrderSheet();
    return;
  }
  if (option) {
    const optIdx = Number(target.getAttribute('data-opt-idx'));
    const sel = state.orderDraft.selections[option] || { quantity: 1, optionIndexes: [] };
    if (sel.quantity < 1) sel.quantity = 1;
    const idx = sel.optionIndexes.indexOf(optIdx);
    if (idx >= 0) sel.optionIndexes.splice(idx, 1); else sel.optionIndexes.push(optIdx);
    state.orderDraft.selections[option] = sel;
    renderOrderSheet();
    return;
  }
  if (vote) { await toggleVote(vote); return; }
  if (scheduleWeek) {
    const dates = weekDates(state.admin.scheduleWeek);
    if (!dates.length) return;
    const base = new Date(`${dates[0]}T00:00:00`);
    base.setDate(base.getDate() + (scheduleWeek === 'next' ? 7 : -7));
    state.admin.scheduleWeek = weekLabelOf(base);
    renderAdminTab();
    return;
  }
  if (target.hasAttribute('data-close-sheet')) { closeModal(); return; }

  if (!action) return;
  await handleAction(action, target);
}

async function handleAction(action, target) {
  switch (action) {
    // 學生
    case 'show-qr': await showMyQr(); break;
    case 'refresh-wallet': await loadWalletDetail(); break;
    case 'manual-refresh': await manualRefresh(); break;
    case 'toggle-notifications': await toggleNotifications(); break;
    case 'install-app': if (state.deferredInstall) state.deferredInstall.prompt(); break;
    case 'change-password': await promptChangePassword(); break;
    case 'change-name': promptModal('修改姓名', [{ name: 'studentName', label: '姓名', value: state.user.name }], async (v) => { const r = await api('updateProfile', { studentName: v.studentName }); state.user = r.user; render(); toast('姓名已更新。', 'success'); }); break;
    case 'logout': doLogout(); break;

    // 管理員 - 菜單
    case 'add-store': promptModal('新增店家', [{ name: 'name', label: '店家名稱' }], async (v) => { await api('adminSaveStore', { name: v.name }); await refreshAdmin(); }); break;
    case 'edit-store': {
      const store = state.admin.catalog?.stores?.find((s) => s.storeId === target.getAttribute('data-store'));
      promptModal('修改店家名稱', [{ name: 'name', label: '店家名稱', value: store?.name }], async (v) => { await api('adminSaveStore', { storeId: store.storeId, name: v.name }); await refreshAdmin(); });
      break;
    }
    case 'del-store': openConfirm('刪除店家', '刪除後該店家的菜單會隱藏，但既有場次與訂單紀錄仍會保留。確定嗎？', async () => { await api('adminDeleteStore', { storeId: target.getAttribute('data-store') }); toast('店家已刪除。', 'success'); await refreshAdmin(); }); break;
    case 'add-item': openItemEditor(target.getAttribute('data-store')); break;
    case 'edit-item': openItemEditor(null, target.getAttribute('data-item')); break;
    case 'del-item': openConfirm('刪除品項', '確定要刪除這個品項嗎？', async () => { await api('adminDeleteMenuItem', { itemId: target.getAttribute('data-item') }); await refreshAdmin(); }); break;
    case 'ai-scan': openAiScan(target.getAttribute('data-store')); break;
    case 'save-item': await saveItem(target.getAttribute('data-item')); break;
    case 'save-ai-items': await saveAiItems(target.getAttribute('data-store')); break;
    case 'del-ai-item': {
      state.aiItems.splice(Number(target.getAttribute('data-index')), 1);
      renderAiList();
      break;
    }

    // 管理員 - 排程
    case 'toggle-holiday': {
      const date = target.getAttribute('data-date');
      const isHoliday = (state.admin.schedule?.holidayDates || []).includes(date);
      if (isHoliday) await api('adminRemoveHoliday', { date }); else await api('adminSetHoliday', { date });
      await refreshAdmin();
      break;
    }
    case 'add-session': openSessionEditor(target.getAttribute('data-date')); break;
    case 'edit-session': openSessionEditor(null, target.getAttribute('data-session')); break;
    case 'del-session': openConfirm('刪除場次', '刪除後將自動退還已付款項，確定嗎？', async () => { await api('adminDeleteSession', { sessionId: target.getAttribute('data-session') }); await refreshAdmin(); }); break;
    case 'publish-week': openConfirm('公布本週菜單', '公布後學生即可開始訂餐，並會推播通知。', async () => { const r = await api('adminPublishWeek', { weekLabel: state.admin.scheduleWeek }); toast(`已公布 ${r.published} 個場次。`, 'success'); await refreshAdmin(); }); break;
    case 'week-cutoff': openWeekCutoffModal(); break;
    case 'add-recurring': {
      const storeOpts = (state.admin.schedule?.stores || []).map((s) => ({ value: s.storeId, label: s.name }));
      promptModal('新增每日固定店家', [
        { name: 'storeId', label: '店家', type: 'select', options: storeOpts },
        { name: 'cutoffTime', label: '每天截止時間', type: 'time', value: '10:00' },
      ], async (v) => { await api('adminSaveRecurring', { storeId: v.storeId, cutoffTime: v.cutoffTime, enabled: true }); toast('已設定固定店家。', 'success'); await refreshAdmin(); });
      break;
    }
    case 'del-recurring': openConfirm('取消固定店家', '取消後將不再自動產生新場次（已產生的場次保留）。', async () => { await api('adminSaveRecurring', { storeId: target.getAttribute('data-store'), enabled: false }); toast('已取消固定。', 'success'); await refreshAdmin(); }); break;

    // 管理員 - 核銷
    case 'open-scanner': openScanner(); break;
    case 'pin-input': {
      promptModal('輸入 PIN 碼', [{ name: 'pin', label: '4 位數 PIN', type: 'text' }], async (v) => { const r = await api('adminResolvePin', { pin: v.pin }); closeModal(); renderVerifyResult(r); });
      break;
    }
    case 'seat-input': {
      promptModal('查詢當天訂單', [{ name: 'seatNo', label: '座號／學號', type: 'text', placeholder: '例如 05' }], async (v) => { const r = await api('adminResolveSeat', { seatNo: v.seatNo }); closeModal(); renderVerifyResult(r); });
      break;
    }
    case 'submit-pin': {
      const pin = $('#manual-pin')?.value.trim();
      if (!pin) return;
      closeModal();
      try { const r = await api('adminResolvePin', { pin }); renderVerifyResult(r); } catch (e) { toast(e.message, 'error'); openScanner(); }
      break;
    }
    case 'confirm-pickup': {
      const orderId = target.getAttribute('data-order');
      const userId = target.getAttribute('data-user');
      await busy(async () => {
        await api('adminConfirmPickup', { userId, orderIds: [orderId] });
        const last = state.admin.lastVerify;
        if (last) last.todayOrders.forEach((order) => { if (order.orderId === orderId) order.pickupStatus = 'PickedUp'; });
        toast('已標記取餐。', 'success');
        render();
      });
      break;
    }
    case 'settle-all': {
      const userId = target.getAttribute('data-user');
      const orderIds = (state.admin.lastVerify?.unpaidOrders || []).map((order) => order.orderId);
      if (!orderIds.length) return;
      await busy(async () => {
        await api('adminSettleCash', { userId, orderIds });
        const last = state.admin.lastVerify;
        if (last) { last.unpaidOrders = []; last.totalDebt = 0; }
        toast('已現金結清。', 'success');
        render();
      });
      break;
    }
    case 'topup': openTopupModal(target.getAttribute('data-user')); break;
    case 'settle-order': openConfirm('現金結帳', '確認已收取此筆訂單現金並結清？', async () => { await api('adminSettleCash', { userId: target.getAttribute('data-user'), orderIds: [target.getAttribute('data-order')] }); toast('已結帳。', 'success'); await refreshAdmin(); }); break;

    // 管理員 - 帳號
    case 'add-user': openAddUserModal(); break;
    case 'promote': await withAdminRefresh(async () => { await api('adminSetRole', { userId: target.getAttribute('data-user'), role: 'Admin' }); toast('已設為管理。', 'success'); }); break;
    case 'demote': await withAdminRefresh(async () => { await api('adminSetRole', { userId: target.getAttribute('data-user'), role: 'Student' }); toast('已移除管理權限。', 'success'); }); break;
    case 'toggle-user': {
      const disabled = target.getAttribute('data-disabled') === 'true';
      await withAdminRefresh(async () => { await api('adminSetUserDisabled', { userId: target.getAttribute('data-user'), disabled: !disabled }); toast(disabled ? '帳號已啟用。' : '帳號已停用。', 'success'); });
      break;
    }
    case 'reset-pw': openConfirm('重設密碼', '將該同學的密碼重設為預設值，下次登入需重新設定。', async () => { await api('adminResetPassword', { userId: target.getAttribute('data-user') }); toast('已重設密碼。', 'success'); await refreshAdmin(); }); break;
    case 'del-user': openConfirm('刪除帳號', '刪除後不可復原（該同學的歷史訂單會保留）。', async () => { await api('adminDeleteUser', { userId: target.getAttribute('data-user') }); await refreshAdmin(); }); break;

    // 管理員 - 設定
    case 'save-settings': {
      const className = $('#class-name')?.value.trim();
      const overdueRemindDays = Number($('#remind-days')?.value || 1);
      await withAdminRefresh(async () => { await api('adminSaveSettings', { className, pureBalanceMode: state.admin.settings.pureBalanceMode, overdueRemindDays }); toast('設定已儲存。', 'success'); });
      break;
    }
    case 'view-overdue': await viewOverdue(); break;
    case 'copy-overdue': await copyOverdue(); break;
    case 'reset-all': openConfirm('刪除所有資料', '這會清除所有訂單、交易、場次、投票、放假、店家與菜單，並歸零儲值餘額。此操作無法復原！', async () => { await api('adminResetAllData'); toast('已刪除所有資料。', 'success'); await refreshAdmin(); }); break;

    // 總覽
    case 'export-csv': await exportCsv(); break;

    default: break;
  }
}

async function refreshAdmin() {
  state.boot = await api('getBootstrap');
  state.user = state.boot.user;
  render();
}

async function manualRefresh() {
  try {
    await refreshBoot();
  } catch (_) {}
  render();
  toast('已重新整理。', 'success');
}

function openWeekCutoffModal() {
  const dates = weekDates(state.admin.scheduleWeek);
  const defaultVal = dates.length ? `${dates[0]}T09:30` : '';
  promptModal('設定本週統一截止時間', [
    { name: 'cutoff', label: '截止時間（套用到本週所有場次）', type: 'datetime-local', value: defaultVal },
  ], async (v) => {
    const cutoffTime = new Date(v.cutoff).toISOString();
    const r = await api('adminSetWeekCutoff', { weekLabel: state.admin.scheduleWeek, cutoffTime });
    toast(`已更新 ${r.updated} 個場次的截止時間。`, 'success');
    await refreshAdmin();
  });
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
  const optionsText = (item?.options || []).map((opt) => `${opt.name}${Number(opt.price) ? `:${opt.price}` : ''}`).join('\n');

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
          <label class="mb-1 block text-xs font-bold text-slate-500">客製選項（每行一個；加價用「名稱:價格」，例如 加起司:10）</label>
          <textarea id="item-options" rows="4" class="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-ledger" placeholder="無糖&#10;半糖&#10;加珍珠:10">${escapeHtml(optionsText)}</textarea>
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
    const [n, p] = line.trim().split(':');
    return { name: n.trim(), price: Number(p || 0) };
  }).filter((opt) => opt.name);
  const storeId = $('#item-store').value;
  try {
    await busy(async () => {
      await api('adminSaveMenuItem', { storeId, itemId: itemId || undefined, name, price, options });
      closeModal();
      await refreshAdmin();
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
async function compressImage(file) {
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
  const img = await new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = dataUrl;
  });
  const maxDim = 1280;
  let { width, height } = img;
  if (Math.max(width, height) > maxDim) {
    const scale = maxDim / Math.max(width, height);
    width = Math.round(width * scale);
    height = Math.round(height * scale);
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').drawImage(img, 0, 0, width, height);
  const compressed = canvas.toDataURL('image/jpeg', 0.85);
  return { imageBase64: compressed.split(',')[1], mimeType: 'image/jpeg' };
}

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
  state.aiItems = items.map((item) => ({ ...item }));
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
      ${item.options.length ? `<p class="mt-1.5 text-xs text-slate-400">選項：${escapeHtml(item.options.join('、'))}</p>` : ''}
    </div>`).join('');
  $$('[data-ai-name]', list).forEach((el) => el.addEventListener('input', () => { state.aiItems[Number(el.getAttribute('data-ai-name'))].name = el.value; }));
  $$('[data-ai-price]', list).forEach((el) => el.addEventListener('input', () => { state.aiItems[Number(el.getAttribute('data-ai-price'))].price = Number(el.value || 0); }));
}

async function saveAiItems(storeId) {
  const items = state.aiItems.filter((item) => item.name.trim());
  try {
    await busy(async () => {
      const result = await api('adminBatchSaveMenuItems', { storeId, items });
      closeModal();
      toast(`已寫入 ${result.created} 個品項。`, 'success');
      await refreshAdmin();
    });
  } catch (error) {
    toast(error.message, 'error');
  }
}

/* ============================ 排程場次編輯 ============================ */
function openSessionEditor(date, sessionId) {
  const storeOptions = (state.admin.schedule?.stores || []).map((store) => `<option value="${store.storeId}">${escapeHtml(store.name)}</option>`).join('');
  const existing = sessionId ? (state.admin.schedule?.sessions || []).find((s) => s.sessionId === sessionId) : null;
  const cutoffDefault = existing ? existing.cutoffTime.slice(0, 16) : `${date}T09:30`;

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
    toast(`儲值完成，已抵欠款 $${money(r.appliedToDebt)}。`, 'success');
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

function doLogout() {
  api('logout').catch(() => {});
  state.token = '';
  state.user = null;
  state.boot = null;
  localStorage.removeItem('meal.token');
  render();
}

bootstrap();
