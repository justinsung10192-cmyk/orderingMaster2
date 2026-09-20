/* ============================================================================
 * 訂餐通 — 前端（Mobile-First PWA）
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
  expandedStores: new Set(),
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
  calendar: { month: todayString().slice(0, 7), events: [], logs: [], showLogs: false, showPast: false },
  calendarEditingId: null,
  calendarCategory: '其他',
  calendarAiEvents: [],
  busy: false,
  treats: [],
  changelog: [],
  showChangelog: false,
};

const ICONS = { order: '⌑', vote: '♡', calendar: '▦', wallet: '¤', admin: '✓', settings: '☷' };

const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '3.2.0'; // 由 vite.config.ts 於建置時注入

/* ============================ API ============================ */
async function api(action, data = {}, onProgress) {
  const res = await fetch(window.LUNCH_CONFIG.apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, data, token: state.token }),
  });
  // 若傳入 onProgress，則以串流讀取回應，回報「真實」下載進度（依 Content-Length）
  if (typeof onProgress === 'function' && res.body && typeof ReadableStream !== 'undefined') {
    const reader = res.body.getReader();
    // 若回應被 gzip/br 壓縮，Content-Length 為「壓縮後」大小，與解壓後位元組不符；
    // 僅在未壓縮時才用真實百分比，否則保持不確定進度直到完成。
    const encoding = (res.headers.get('Content-Encoding') || '').toLowerCase();
    const total = encoding ? 0 : Number(res.headers.get('Content-Length') || 0);
    const parts = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      size += value.length;
      if (total > 0) onProgress(Math.min(100, Math.round((size / total) * 100)));
    }
    const buf = new Uint8Array(size);
    let off = 0;
    for (const part of parts) { buf.set(part, off); off += part.length; }
    const json = JSON.parse(new TextDecoder().decode(buf));
    onProgress(100);
    if (!json.ok) throw new Error(json.error || '操作失敗，請稍後再試。');
    return json.data;
  }
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

let busyDepth = 0;

async function busy(fn) {
  busyDepth += 1;
  document.body.classList.add('is-busy');
  try { await fn(); } finally {
    busyDepth -= 1;
    if (busyDepth <= 0) {
      busyDepth = 0;
      document.body.classList.remove('is-busy');
    }
  }
}

/* ============================ 啟動流程 ============================ */
function renderLoader() {
  app.innerHTML = `
    <div id="boot-loader" class="fixed inset-0 z-[100] grid place-items-center bg-paper">
      <div class="flex w-full max-w-xs flex-col items-center px-8">
        <img src="/icons/loading.gif" alt="載入中" class="h-44 w-auto object-contain" />
        <p class="mt-3 font-serif text-lg font-black tracking-wide text-ledger">訂餐通</p>
        <p class="mt-1 text-xs text-slate-400">正在為你準備午餐手帳…</p>
        <div class="relative mt-5 h-2 w-full overflow-hidden rounded-full bg-mist">
          <div id="boot-shimmer" class="absolute inset-0"></div>
          <div id="boot-progress" class="relative h-full w-0 rounded-full bg-gradient-to-r from-apricot to-stamp transition-[width] duration-300 ease-out"></div>
        </div>
        <p id="boot-percent" class="mt-1.5 text-xs font-bold tabular-nums text-ledger">連線中…</p>
      </div>
    </div>`;
}

// 載入進度：以「真實」下載位元組回報（有 Content-Length 且未壓縮時顯示百分比）
function updateBootProgress(pct) {
  const bar = document.getElementById('boot-progress');
  const pctEl = document.getElementById('boot-percent');
  const shimmer = document.getElementById('boot-shimmer');
  if (shimmer) shimmer.style.display = 'none';
  if (!bar) return;
  bar.style.width = `${Math.min(100, pct)}%`;
  if (pctEl) pctEl.textContent = `${Math.round(pct)}%`;
}

function finishBootProgress() {
  const bar = document.getElementById('boot-progress');
  const pct = document.getElementById('boot-percent');
  const shimmer = document.getElementById('boot-shimmer');
  if (shimmer) shimmer.style.display = 'none';
  if (bar) bar.style.width = '100%';
  if (pct) pct.textContent = '100%';
}

async function bootstrap() {
  renderLoader();
  initScrollbar();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    state.deferredInstall = event;
    if (state.user) render();
  });
  if (state.token) {
    try {
      state.boot = await api('getBootstrap', {}, updateBootProgress);
      state.user = state.boot.user;
      finishBootProgress();
      render();
      return;
    } catch (_) {
      state.token = '';
      localStorage.removeItem('meal.token');
    }
  }
  state.user = null;
  finishBootProgress();
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
  let remember = null;
  try { remember = JSON.parse(localStorage.getItem('meal.remember') || 'null'); } catch (_) {}
  app.innerHTML = `
    <main class="min-h-dvh bg-paper relative overflow-hidden">
      <div class="absolute inset-x-0 top-0 h-[34%] bg-ledger"></div>
      <section class="safe-top relative mx-auto flex min-h-dvh max-w-md flex-col px-6 pb-8">
        <div class="flex items-center gap-3 pt-2 text-white">
          <span class="grid h-14 w-14 place-items-center rounded-2xl border border-white/20 bg-white/10 font-serif text-2xl">⌑</span>
          <div><p class="font-serif text-xl font-black tracking-wide">訂餐通</p><p class="text-xs text-blue-100">午間事務，清楚完成</p></div>
        </div>
        <div class="relative mt-8 overflow-hidden rounded-[1.35rem] bg-white shadow-lift">
          <div class="bg-ledger px-7 py-5 text-white">
            <p class="text-xs font-bold tracking-[.16em] text-blue-200">SIGN IN</p>
            <h1 class="mt-1 font-serif text-2xl font-black">登入</h1>
          </div>
          <form id="login-form" class="space-y-4 px-7 py-7">
            <div>
              <label class="mb-1 block text-xs font-bold text-slate-500">座號</label>
              <input name="studentNo" inputmode="numeric" value="${escapeHtml(remember?.studentNo || '')}" class="w-full rounded-xl border border-slate-200 px-4 py-3 text-lg outline-none focus:border-ledger" placeholder="例如 01" autocomplete="username" />
            </div>
            <div>
              <label class="mb-1 block text-xs font-bold text-slate-500">密碼</label>
              <input name="password" type="password" value="${escapeHtml(remember?.password || '')}" class="w-full rounded-xl border border-slate-200 px-4 py-3 text-lg outline-none focus:border-ledger" placeholder="••••••••" autocomplete="current-password" />
            </div>
            <label class="flex items-center gap-2 text-xs font-bold text-slate-500">
              <input type="checkbox" id="remember-pw" class="h-4 w-4 accent-ledger" ${remember ? 'checked' : ''} />記住密碼（下次自動帶入）
            </label>
            <button type="submit" class="w-full rounded-xl bg-ledger py-3.5 text-sm font-bold text-white">登入</button>
            <p class="text-center text-xs leading-5 text-slate-400">首次登入請使用預設密碼，登入後系統會要求你修改。</p>
          </form>
        </div>
              <p class="mt-6 text-center text-[11px] text-slate-400">訂餐通 v${APP_VERSION}</p>
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
      const rememberPw = $('#remember-pw')?.checked || false;
      if (rememberPw) localStorage.setItem('meal.remember', JSON.stringify({ studentNo, password }));
      else localStorage.removeItem('meal.remember');
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
  if (state.user.role === 'Teacher' && ['order', 'vote', 'wallet', 'admin'].includes(state.view)) state.view = 'calendar';

  const isTeacher = state.user.role === 'Teacher';
  const navItems = [
    ...(isTeacher ? [] : [
      { id: 'order', label: '訂餐', icon: ICONS.order },
      { id: 'vote', label: '投票', icon: ICONS.vote },
      { id: 'wallet', label: '個人', icon: ICONS.wallet },
    ]),
    { id: 'calendar', label: '行事曆', icon: ICONS.calendar },
    ...(state.user.role === 'Admin' ? [{ id: 'admin', label: '管理', icon: ICONS.admin }] : []),
    { id: 'settings', label: '設定', icon: ICONS.settings },
  ];

  const headerWallet = (state.user.role === 'Admin' || isTeacher) ? '' :
    `<span id="header-wallet" class="pr-1 text-xs font-bold tabular-nums text-stamp">${fmtMoney(state.user.walletBalance)}</span>`;

  app.innerHTML = `
    <div class="min-h-dvh bg-paper pb-24">
      <header class="safe-top sticky top-0 z-30 border-b border-ledger/5 bg-paper/95 px-4 pb-3 backdrop-blur-lg">
        <div class="mx-auto flex max-w-3xl items-center justify-between">
          <button data-nav="order" class="flex items-center gap-2 text-left">
            <span class="grid h-11 w-11 place-items-center rounded-xl bg-ledger font-serif text-xl text-white">⌑</span>
            <div><p class="font-serif text-base font-black leading-5">訂餐通</p><p id="header-subtitle" class="text-[11px] text-slate-500">${headerSubtitle()}</p></div>
          </button>
          <div class="flex items-center gap-2">
            <button data-action="manual-refresh" class="grid h-9 w-9 place-items-center rounded-full bg-white text-lg font-black text-ledger shadow-sm ring-1 ring-ledger/5" title="重新整理"><span id="refresh-icon" class="inline-block">↻</span></button>
            <button data-nav="settings" class="flex items-center gap-2 rounded-full bg-white px-2 py-1.5 shadow-sm ring-1 ring-ledger/5">
              <span class="grid h-7 w-7 place-items-center rounded-full bg-ledger text-xs font-bold text-white">${escapeHtml((state.user.seatNo || '?').slice(-2))}</span>
              ${headerWallet}
            </button>
          </div>
        </div>
      </header>
      <main id="view" class="mx-auto max-w-3xl px-4 py-5"></main>
      <footer class="mx-auto max-w-3xl px-4 pb-2 pt-1 text-center text-[11px] leading-5 text-slate-400">
        訂餐通 <span class="font-semibold text-slate-500">v${APP_VERSION}</span>
      </footer>
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

// 管理後台延遲載入：需要時才 import admin.js
let adminModPromise = null;
async function getAdmin() {
  if (!adminModPromise) {
    adminModPromise = import('./admin.js').then(async (m) => {
      await m.initAdmin({ state, api, busy, toast, closeModal, openConfirm, promptModal, modalRoot, refreshAdmin, render, renderView, bootstrap, loadScript });
      return m;
    });
  }
  return adminModPromise;
}

function renderView() {
  const view = $('#view');
  if (!view) return;
  if (state.view === 'order') return renderOrderView(view);
  if (state.view === 'vote') return renderVoteView(view);
  if (state.view === 'calendar') return renderCalendarView(view);
  if (state.view === 'wallet') return renderWalletView(view);
  if (state.view === 'admin') { view.innerHTML = '<p class="p-8 text-center text-sm text-slate-400">管理後台載入中…</p>'; getAdmin().then((m) => m.renderAdminView(view)); return; }
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
      ${state.boot?.announcement ? `
      <div class="rounded-2xl bg-amber-50 px-4 py-3 ring-1 ring-amber-200">
        <p class="text-[11px] font-bold tracking-[.13em] text-amber-600">📢 公告</p>
        <p class="mt-1 whitespace-pre-line text-sm font-bold leading-6 text-amber-800">${escapeHtml(state.boot.announcement)}</p>
      </div>` : ''}
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
        ${session.isTreat ? '<span class="rounded-full bg-amber-100 px-2 py-1 text-[11px] font-bold text-amber-700">🎁請客</span>' : ''}
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
    expandedOptions: new Set(),
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

// 增量更新訂單表單：只更新總計／品項小計／數量／選項狀態，不重建整棵 DOM
function refreshOrderSheet() {
  const draft = state.orderDraft;
  const session = draft.session;
  const { total, count } = draftTotal();
  const isTreat = Boolean(session.isTreat);
  const covered = isTreat ? Math.min(total, Math.max(0, Number(session.treatRemaining || 0))) : 0;
  const netTotal = Math.max(0, total - covered);

  const countEl = document.getElementById('sheet-total-count');
  const amountEl = document.getElementById('sheet-total-amount');
  const extraEl = document.getElementById('sheet-total-extra');
  if (countEl) countEl.textContent = '共 ' + count + ' 份' + (covered > 0 ? ' · 請客折抵 ' + fmtMoney(covered) : '');
  if (amountEl) amountEl.textContent = fmtMoney(total);
  if (extraEl) { extraEl.style.display = covered > 0 ? 'block' : 'none'; extraEl.textContent = '實付 ' + fmtMoney(netTotal); }

  for (const item of session.menuItems || []) {
    const sel = draft.selections[item.itemId];
    const quantity = sel?.quantity || 0;
    const optionIndexes = sel?.optionIndexes || [];
    const optionTotal = optionIndexes.reduce((sum, idx) => sum + Number(item.options[idx]?.price || 0), 0);
    const subEl = document.querySelector('[data-item-subtotal="' + item.itemId + '"]');
    if (subEl) subEl.textContent = fmtMoney(Number(item.price) + optionTotal);
    const qtyEl = document.querySelector('[data-qty-num="' + item.itemId + '"]');
    if (qtyEl) qtyEl.textContent = quantity;
  }

  document.querySelectorAll('[data-option]').forEach((btn) => {
    const itemId = btn.getAttribute('data-option');
    const optIdx = Number(btn.getAttribute('data-opt-idx'));
    const active = (draft.selections[itemId]?.optionIndexes || []).includes(optIdx);
    btn.classList.toggle('bg-stamp', active);
    btn.classList.toggle('text-white', active);
    btn.classList.toggle('ring-stamp', active);
    btn.classList.toggle('bg-mist', !active);
    btn.classList.toggle('text-ledger', !active);
    btn.classList.toggle('ring-ledger/10', !active);
  });
}

function renderOrderSheet() {
  const draft = state.orderDraft;
  const session = draft.session;
  const { total, count } = draftTotal();
  const balance = Number(session.walletBalance || 0);
  const isAdmin = Boolean(draft.adminFor);
  const isTreat = Boolean(session.isTreat);
  const covered = isTreat ? Math.min(total, Math.max(0, Number(session.treatRemaining || 0))) : 0;
  const netTotal = Math.max(0, total - covered);
  const insufficient = session.pureBalanceMode && netTotal > balance;
  const cutoffPassed = !isAdmin && cutoffRemaining(session.cutoffTime).passed;
  const prevScroll = document.getElementById('sheet-scroll')?.scrollTop || 0;

  modalRoot.innerHTML = `
    <div class="fixed inset-0 z-50 flex items-end justify-center bg-ledger/50">
      <section class="sheet-enter flex max-h-[92dvh] w-full max-w-md flex-col overflow-hidden rounded-t-[1.5rem] bg-paper">
        <div class="flex items-center justify-between border-b border-ledger/10 bg-white px-5 py-4">
          <div>
            <p class="text-[11px] font-bold tracking-[.13em] text-slate-500">ORDER SHEET</p>
            <h2 class="font-serif text-xl font-black">${escapeHtml(session.storeName)}</h2>
            ${isAdmin ? `<p class="mt-0.5 text-xs font-bold text-stamp">補單對象：${escapeHtml(draft.adminFor.seatNo)} ${escapeHtml(draft.adminFor.name)}</p>` : ''}
            <p class="text-xs text-slate-500">${session.orderDate} · 截止 <span data-cutoff="${session.cutoffTime}">${cutoffRemaining(session.cutoffTime).text}</span></p>
          </div>
          <button data-close-sheet class="grid h-9 w-9 place-items-center rounded-full bg-mist text-xl">×</button>
        </div>

        <div id="sheet-scroll" class="flex-1 overflow-y-auto px-4 py-4">
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
            ${isAdmin ? `<p class="mb-2 rounded-lg bg-blue-50 px-3 py-2 text-xs font-bold text-blue-600">管理員補單：為 ${escapeHtml(draft.adminFor.seatNo)} ${escapeHtml(draft.adminFor.name)} 修改／新增訂單（截止後亦可）。</p>` : ''}
            ${isTreat ? `<p class="mb-2 rounded-lg bg-amber-50 px-3 py-2 text-xs font-bold text-amber-600">🎁 此為請客場次：免費上限 ${fmtMoney(session.treatCap)}，已用 ${fmtMoney(session.treatUsed)}，剩 ${fmtMoney(session.treatRemaining)}，超過部分由你自補差價。</p>` : ''}
                        <input id="order-note" maxlength="120" value="${escapeHtml(draft.note)}" placeholder="備註（可選）" class="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-ledger" />
            <div class="flex items-center justify-between">
              <div>
                <p id="sheet-total-count" class="text-xs text-slate-500">共 ${count} 份${covered > 0 ? ` · 請客折抵 ${fmtMoney(covered)}` : ''}</p>
                <p id="sheet-total-amount" class="font-serif text-2xl font-black tabular-nums">${fmtMoney(total)}</p>
                <p id="sheet-total-extra" class="text-[11px] font-bold text-stamp" style="display:${covered > 0 ? 'block' : 'none'}">實付 ${fmtMoney(netTotal)}</p>
              </div>
              <button id="submit-order" class="rounded-xl ${insufficient ? 'bg-slate-300' : 'bg-ledger'} px-8 py-3.5 text-sm font-bold text-white">${isAdmin ? (session.existingOrder ? '更新補單' : '送出補單') : (session.existingOrder ? '更新訂單' : '送出訂單')}</button>
            </div>
            ${session.existingOrder && !isAdmin ? '<button id="delete-order" class="mt-2 w-full rounded-xl bg-red-50 py-2.5 text-xs font-bold text-red-600">刪除此訂單</button>' : ''}
          `}
        </div>
      </section>
    </div>`;

  const scrollEl = document.getElementById('sheet-scroll');
  if (scrollEl) scrollEl.scrollTop = prevScroll;

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
  const hasOptions = (item.options || []).length > 0;
  const optionsExpanded = quantity > 0 || state.orderDraft.expandedOptions.has(item.itemId);
  const requiredGroups = new Map();
  const optional = [];
  (item.options || []).forEach((opt, idx) => {
    if (opt.required && opt.group) {
      if (!requiredGroups.has(opt.group)) requiredGroups.set(opt.group, []);
      requiredGroups.get(opt.group).push({ ...opt, idx });
    } else {
      optional.push({ ...opt, idx });
    }
  });
  const optionBtn = (opt) => {
    const active = optionIndexes.includes(opt.idx);
    return `<button data-option="${item.itemId}" data-opt-idx="${opt.idx}" class="rounded-full px-3 py-1.5 text-xs font-bold ring-1 ${active ? 'bg-stamp text-white ring-stamp' : 'bg-mist text-ledger ring-ledger/10'}">${escapeHtml(opt.name)}${Number(opt.price) ? ` +${money(opt.price)}` : ''}</button>`;
  };
  const requiredHtml = [...requiredGroups.entries()].map(([group, opts]) => `
      <div class="mt-2.5">
        <p class="mb-1.5 text-[10px] font-bold tracking-[.1em] text-stamp">${escapeHtml(group)}（必選）</p>
        <div class="flex flex-wrap gap-2">${opts.map(optionBtn).join('')}</div>
      </div>`).join('');
  const optionalHtml = optional.length ? `
      <div class="mt-2.5">
        <p class="mb-1.5 text-[10px] font-bold tracking-[.1em] text-slate-400">加點／備註（可多選）</p>
        <div class="flex flex-wrap gap-2">${optional.map(optionBtn).join('')}</div>
      </div>` : '';
  return `
    <div class="mb-2 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-ledger/5">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <p class="font-bold text-ledger">${escapeHtml(item.name)}${item.vegetarian ? ' <span class="veg-badge">🌱 素</span>' : ''}${item.dish ? ` <span class="rounded bg-amber-50 px-1.5 py-0.5 text-[11px] font-bold text-amber-600">${escapeHtml(item.dish)}</span>` : ''}</p>
          <p data-item-subtotal="${item.itemId}" class="mt-0.5 text-sm font-bold tabular-nums text-stamp">${fmtMoney(Number(item.price) + optionTotal)}</p>
        </div>
        <div class="flex items-center gap-2">
          <button data-qty="${item.itemId}" data-delta="-1" class="grid h-8 w-8 place-items-center rounded-lg bg-mist text-lg font-bold text-ledger ${quantity < 1 ? 'opacity-40' : ''}">−</button>
          <span data-qty-num="${item.itemId}" class="w-6 text-center text-lg font-black tabular-nums">${quantity}</span>
          <button data-qty="${item.itemId}" data-delta="1" class="grid h-8 w-8 place-items-center rounded-lg bg-ledger text-lg font-bold text-white">＋</button>
        </div>
      </div>
      ${hasOptions && !optionsExpanded ? `<button data-toggle-options="${item.itemId}" class="mt-2 rounded-lg bg-mist px-2.5 py-1 text-[11px] font-bold text-ledger">＋ 選項（${item.options.length}）</button>` : ''}
      ${hasOptions && optionsExpanded ? `${requiredHtml}${optionalHtml}` : ''}
    </div>`;
}

async function submitOrder() {
  const draft = state.orderDraft;
  const selections = Object.entries(draft.selections)
    .filter(([, sel]) => sel.quantity >= 1)
    .map(([itemId, sel]) => ({ itemId, quantity: sel.quantity, optionIndexes: sel.optionIndexes }));
  if (!selections.length) return toast('請至少選擇一項餐點。', 'error');

  // 必選選項：每組必須擇一
  for (const item of draft.session.menuItems) {
    const sel = draft.selections[item.itemId];
    if (!sel || sel.quantity < 1) continue;
    const groups = new Map();
    (item.options || []).forEach((opt, idx) => {
      if (opt.required && opt.group) {
        if (!groups.has(opt.group)) groups.set(opt.group, []);
        groups.get(opt.group).push(idx);
      }
    });
    for (const [group, idxs] of groups) {
      const picked = idxs.filter((idx) => sel.optionIndexes.includes(idx)).length;
      if (picked !== 1) return toast(`「${item.name}」的必選選項「${group}」請擇一。`, 'error');
    }
  }

  try {
    await busy(async () => {
      const action = draft.adminFor ? 'adminEditOrder' : (draft.session.existingOrder ? 'updateOrder' : 'placeOrder');
      const payload = { sessionId: draft.session.sessionId, selections, note: draft.note, useWallet: draft.useWallet };
      if (draft.adminFor) payload.seatNo = draft.adminFor.seatNo;
      await api(action, payload);
      if (draft.adminFor) await refreshAdmin(); else await refreshBoot();
      closeModal();
      toast(draft.adminFor ? '補單已送出。' : '訂單已送出。', 'success');
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

/* 管理員補單：依座號開啟指定同學的訂餐表單（不受截止時間限制） */
async function openAdminOrderSheet(sessionId, seatNo) {
  if (!seatNo) return toast('請輸入座號或學號。', 'error');
  try {
    const data = await api('adminGetOrderContext', { sessionId, seatNo });
    const session = data.session;
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
      adminFor: { seatNo: data.user.seatNo, name: data.user.name },
      expandedOptions: new Set(),
    };
    renderOrderSheet();
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

      <div class="rounded-2xl bg-white p-4 shadow-paper ring-1 ring-ledger/5">
        <p class="font-bold text-ledger">🍜 推薦店家</p>
        <p class="mt-0.5 text-xs text-slate-500">想吃某家店？推薦給全班，供管理者參考。</p>
        <input id="reco-store" maxlength="60" placeholder="店家名稱（例如：麥當勞）" class="mt-3 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-ledger" />
        <input id="reco-note" maxlength="200" placeholder="備註（可選）" class="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-ledger" />
        <button data-action="submit-recommendation" class="mt-2 w-full rounded-xl bg-apricot py-2.5 text-sm font-bold text-white">送出推薦</button>
      </div>
    </section>`;
}

async function toggleVote(storeId) {
  const myVotes = new Set(state.boot?.myVotes || []);
  const store = state.boot?.stores?.find((s) => s.storeId === storeId);
  try {
    await busy(async () => {
      let r;
      if (myVotes.has(storeId)) {
        r = await api('removeVote', { storeId });
        toast(`已取消「${store.name}」的票。`);
      } else {
        r = await api('castVote', { storeId });
        toast(`已投給「${store.name}」！`);
      }
      // 以 API 回傳直接更新，避免重新載入整包 getBootstrap
      state.boot.myVotes = r.myVotes || [];
      state.boot.voteTally = r.tally || {};
      renderView();
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
        <div class="mt-3 flex items-center justify-between rounded-xl bg-white/15 px-3 py-2.5">
          <span class="text-sm text-emerald-50">現金欠費（待繳）</span>
          <span id="wallet-debt" class="font-bold tabular-nums text-red-100">--</span>
        </div>
        <div class="mt-4 grid grid-cols-2 gap-2">
          <button data-action="show-qr-pay" class="rounded-xl bg-white/20 py-3 text-sm font-bold text-white">💰 繳費 QR</button>
          <button data-action="show-qr-pickup" class="rounded-xl bg-white/20 py-3 text-sm font-bold text-white">🍱 取餐 QR</button>
        </div>
        <div class="mt-2 grid grid-cols-2 gap-2">
          <button data-action="open-leave" class="rounded-xl bg-white/20 py-3 text-sm font-bold text-white">🏠 請假</button>
          <button data-action="open-debt" class="rounded-xl bg-white/20 py-3 text-sm font-bold text-white">🧾 欠費</button>
        </div>
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
    const debtEl = $('#wallet-debt');
    if (!balanceEl || !ordersEl || !txsEl) return; // 畫面已切換，忽略本次結果
    balanceEl.textContent = fmtMoney(data.user.walletBalance);
    if (debtEl) debtEl.textContent = data.cashUnpaid > 0 ? fmtMoney(data.cashUnpaid) : '無';
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
        ${order.outstandingAmount > 0 ? `<p class="mt-1.5 text-xs font-bold text-red-600">尚欠 ${fmtMoney(order.outstandingAmount)}</p>` : ''}
      </div>`).join('') : '<p class="rounded-xl bg-white/60 px-4 py-8 text-center text-sm text-slate-400">尚無訂單。</p>';

    txsEl.innerHTML = data.transactions.length ? data.transactions.map((tx) => `
      <div class="flex items-center justify-between rounded-xl bg-white px-4 py-3 shadow-sm ring-1 ring-ledger/5">
        <div><p class="text-sm font-bold text-ledger">${escapeHtml(tx.type)}</p><p class="text-xs text-slate-400">${escapeHtml(tx.note) || new Date(tx.timestamp).toLocaleString('zh-TW')}</p></div>
        <span class="font-bold tabular-nums ${Number(tx.amount) >= 0 ? 'text-stamp' : 'text-red-600'}">${Number(tx.amount) >= 0 ? '+' : ''}${money(tx.amount)}</span>
      </div>`).join('') : '<p class="rounded-xl bg-white/60 px-4 py-8 text-center text-sm text-slate-400">尚無交易紀錄。</p>';
  } catch (error) {
    toast(error.message, 'error');
  }
}

/* ============================ 我的 QR / PIN ============================ */
async // 用到時才動態載入外部腳本（掃碼／QR 庫），避免冷啟動就載入 1.3MB 重庫
const scriptCache = {};
function loadScript(src) {
  if (scriptCache[src]) return scriptCache[src];
  scriptCache[src] = new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.async = true;
    el.onload = () => resolve();
    el.onerror = () => { delete scriptCache[src]; reject(new Error('載入失敗。')); };
    document.head.appendChild(el);
  });
  return scriptCache[src];
}

function showMyQr(type) {
  try {
    const isPay = type === 'pay';
    const result = await api('createVerification', { type: isPay ? 'pay' : 'pickup' });
    modalRoot.innerHTML = `
      <div class="fixed inset-0 z-50 flex items-end justify-center bg-ledger/50">
        <section class="sheet-enter w-full max-w-md rounded-t-[1.5rem] bg-white p-6">
          <div class="flex items-center justify-between">
            <div><p class="text-[11px] font-bold tracking-[.13em] ${isPay ? 'text-apricot' : 'text-stamp'}">${isPay ? 'PAYMENT' : 'PICKUP'}</p><h2 class="font-serif text-xl font-black">${isPay ? '繳費 QR' : '取餐 QR'}</h2></div>
            <button data-close-sheet class="grid h-9 w-9 place-items-center rounded-full bg-mist text-xl">×</button>
          </div>
          <div class="mt-4 flex flex-col items-center">
            <div id="my-qr" class="rounded-2xl border-2 border-dashed border-ledger/20 p-3"></div>
            <p class="mt-3 text-xs text-slate-400">6 位數 PIN 碼（5 分鐘後失效）</p>
            <p class="pin-box mt-1 font-serif text-4xl font-black text-ledger">${result.pin}</p>
            <p data-cutoff="${result.expiresAt}" class="mt-2 text-xs font-bold text-apricot">${cutoffRemaining(result.expiresAt).text}</p>
          </div>
          <p class="mt-4 rounded-xl bg-mist/60 px-3 py-2.5 text-center text-xs text-slate-500">${isPay ? '出示給管理者結帳付款（一次繳清欠費）。' : '出示給管理者標記取餐。'}</p>
          <button data-close-sheet class="mt-4 w-full rounded-xl bg-ledger py-3 text-sm font-bold text-white">完成</button>
        </section>
      </div>`;
    try {
      await loadScript('https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js');
      new window.QRCode($('#my-qr'), { text: JSON.stringify(result.payload), width: 280, height: 280, colorDark: '#000000', colorLight: '#ffffff', correctLevel: (window.QRCode.CorrectLevel && window.QRCode.CorrectLevel.H) || 2 });
    } catch (_) {
      const el = $('#my-qr'); if (el) el.textContent = 'QR 庫載入失敗，請改用 PIN。';
    }
  } catch (error) {
    toast(error.message, 'error');
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
          <div><h1 class="font-serif text-xl font-black">${escapeHtml(user.name)}</h1><p class="mt-1 text-sm text-slate-500">座號 ${escapeHtml(user.studentNo)} · ${user.role === 'Admin' ? '管理者' : user.role === 'Teacher' ? '師長' : '一般學生'}</p></div>
        </div>
        <div class="mt-5 grid grid-cols-2 gap-2">
          <div class="rounded-xl bg-mist px-3 py-3"><p class="text-[11px] font-bold text-slate-500">儲值餘額</p><p class="mt-1 font-bold tabular-nums text-stamp">${fmtMoney(user.walletBalance)}</p></div>
          <div class="rounded-xl bg-mist px-3 py-3"><p class="text-[11px] font-bold text-slate-500">帳號權限</p><p class="mt-1 font-bold text-ledger">${user.role === 'Admin' ? '管理者' : user.role === 'Teacher' ? '師長' : '學生'}</p></div>
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
        <button data-action="open-changelog" class="flex w-full items-center justify-between px-5 py-4 text-left">
          <span><span class="block font-bold">更新日誌</span><span class="mt-1 block text-xs text-slate-500">查看訂餐通的功能更新紀錄。</span></span><span class="text-ledger">›</span>
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

function headerSubtitle() {
  if (state.user?.role === 'Teacher') return '師長';
  return state.boot?.pureBalanceMode ? '純儲值模式' : '訂餐手帳';
}

// 可拉動捲軸：右側浮動拖曳列，可快速滑動長頁面
function initScrollbar() {
  if (document.getElementById('scroll-drag')) return;
  const bar = document.createElement('div');
  bar.id = 'scroll-drag';
  bar.innerHTML = '<div id="scroll-drag-thumb"></div>';
  document.body.appendChild(bar);
  const thumb = bar.querySelector('#scroll-drag-thumb');
  let dragging = false;

  const update = () => {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    if (max <= 60) { bar.classList.add('hidden'); return; }
    bar.classList.remove('hidden');
    const trackH = bar.clientHeight - 48;
    const pct = window.scrollY / max;
    thumb.style.transform = `translateY(${pct * trackH}px)`;
  };
  const moveTo = (clientY) => {
    const rect = bar.getBoundingClientRect();
    const max = document.documentElement.scrollHeight - window.innerHeight;
    const trackH = rect.height - 48;
    if (trackH <= 0) return;
    const pct = Math.max(0, Math.min(1, (clientY - rect.top - 24) / trackH));
    window.scrollTo(0, pct * max);
  };
  window.addEventListener('scroll', update, { passive: true });
  window.addEventListener('resize', update);
  if (window.ResizeObserver) new ResizeObserver(update).observe(document.body);
  thumb.addEventListener('pointerdown', (e) => { dragging = true; thumb.setPointerCapture(e.pointerId); moveTo(e.clientY); });
  thumb.addEventListener('pointermove', (e) => { if (dragging) moveTo(e.clientY); });
  thumb.addEventListener('pointerup', () => { dragging = false; });
  thumb.addEventListener('pointercancel', () => { dragging = false; });
  update();
}

function syncHeader() {
  const walletEl = $('#header-wallet');
  if (walletEl) walletEl.textContent = fmtMoney(state.user.walletBalance);
  const subEl = $('#header-subtitle');
  if (subEl) subEl.textContent = headerSubtitle();
}

async function refreshBoot() {
  state.boot = await api('getBootstrap');
  state.user = state.boot.user;
  syncHeader();
}

async function withAdminRefresh(fn) {
  await busy(async () => {
    await fn();
    state.boot = await api('getBootstrap');
    syncHeader();
    renderView();
  });
}

/* ============================ 事件委派 ============================ */
document.addEventListener('click', onClick);

async function onClick(event) {
  const target = event.target.closest('[data-action], [data-nav], [data-admin-tab], [data-toggle-week], [data-toggle-date], [data-toggle-store], [data-toggle-options], [data-open-session], [data-close-sheet], [data-qty], [data-option], [data-vote], [data-schedule-week], [data-store], [data-item], [data-user], [data-date], [data-session], [data-order], [data-disabled]');
  if (!target) return;

  const action = target.getAttribute('data-action');
  const nav = target.getAttribute('data-nav');
  const adminTab = target.getAttribute('data-admin-tab');
  const toggleWeek = target.getAttribute('data-toggle-week');
  const toggleDate = target.getAttribute('data-toggle-date');
  const toggleStore = target.getAttribute('data-toggle-store');
  const openSession = target.getAttribute('data-open-session');
  const toggleOptions = target.getAttribute('data-toggle-options');
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
      .then(() => { if (state.view === nav && state.user) renderView(); })
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
    if (state.expandedStores.has(toggleStore)) state.expandedStores.delete(toggleStore); else state.expandedStores.add(toggleStore);
    (await getAdmin()).renderAdminTab();
    return;
  }
  if (toggleOptions) {
    if (state.orderDraft.expandedOptions.has(toggleOptions)) state.orderDraft.expandedOptions.delete(toggleOptions); else state.orderDraft.expandedOptions.add(toggleOptions);
    renderOrderSheet();
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
    const prevQty = sel.quantity;
    sel.quantity = Math.max(0, Math.min(99, sel.quantity + delta));
    if (sel.quantity > 0) state.orderDraft.selections[qty] = sel; else delete state.orderDraft.selections[qty];
    if (prevQty === 0 || sel.quantity === 0) renderOrderSheet(); else refreshOrderSheet();
    return;
  }
  if (option) {
    const optIdx = Number(target.getAttribute('data-opt-idx'));
    const sel = state.orderDraft.selections[option] || { quantity: 1, optionIndexes: [] };
    if (sel.quantity < 1) sel.quantity = 1;
    const item = state.orderDraft.session.menuItems.find((it) => it.itemId === option);
    const opt = item?.options?.[optIdx];
    const idx = sel.optionIndexes.indexOf(optIdx);
    if (idx >= 0) {
      sel.optionIndexes.splice(idx, 1);
    } else {
      if (opt?.required && opt.group) {
        item.options.forEach((o, i) => {
          if (i !== optIdx && o.required && o.group === opt.group) {
            const j = sel.optionIndexes.indexOf(i);
            if (j >= 0) sel.optionIndexes.splice(j, 1);
          }
        });
      }
      sel.optionIndexes.push(optIdx);
    }
    state.orderDraft.selections[option] = sel;
    refreshOrderSheet();
    return;
  }
  if (vote) { await toggleVote(vote); return; }
  if (scheduleWeek) {
    const dates = weekDates(state.admin.scheduleWeek);
    if (!dates.length) return;
    const base = new Date(`${dates[0]}T00:00:00`);
    base.setDate(base.getDate() + (scheduleWeek === 'next' ? 7 : -7));
    state.admin.scheduleWeek = weekLabelOf(base);
    (await getAdmin()).renderAdminTab();
    return;
  }
  if (target.hasAttribute('data-close-sheet')) { closeModal(); return; }

  if (!action) return;
  await handleAction(action, target);
}

function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function openDutyEditor(date) {
  const res = await api('adminListUsers');
  const eligible = res.users.filter((u) => u.role !== 'Admin');
  modalRoot.innerHTML = `
    <div class="fixed inset-0 z-50 flex items-end justify-center bg-ledger/50">
      <section class="sheet-enter flex max-h-[85dvh] w-full max-w-md flex-col overflow-hidden rounded-t-[1.5rem] bg-white">
        <div class="flex items-center justify-between border-b border-ledger/10 px-5 py-4">
          <div><p class="text-[11px] font-bold tracking-[.13em] text-stamp">DUTY SETUP</p><h2 class="font-serif text-xl font-black">設定值日生（${date}）</h2></div>
          <button data-close-sheet class="grid h-9 w-9 place-items-center rounded-full bg-mist text-xl">×</button>
        </div>
        <div class="flex-1 overflow-y-auto px-4 py-4">
          <p class="mb-2 text-xs leading-5 text-slate-500">勾選要指派的值日生（不勾選任何一人並儲存＝清除手動指派、回到自動輪值）：</p>
          <div class="space-y-1.5">
            ${eligible.map((u) => `<label class="flex items-center gap-2 rounded-lg bg-mist/50 px-3 py-2"><input type="checkbox" value="${u.id}" class="h-4 w-4 accent-stamp"><span class="text-sm font-bold text-ledger">${escapeHtml(u.seatNo)} ${escapeHtml(u.name)}</span>${u.dutyExempt ? '<span class="ml-1 text-[10px] text-slate-400">免值日</span>' : ''}</label>`).join('')}
          </div>
        </div>
        <div class="border-t border-ledger/10 px-5 py-4">
          <button id="save-duty" class="w-full rounded-xl bg-ledger py-3 text-sm font-bold text-white">儲存</button>
        </div>
      </section>
    </div>`;
  $('#save-duty').addEventListener('click', async () => {
    const userIds = [...modalRoot.querySelectorAll('input[type="checkbox"]:checked')].map((el) => el.value);
    await busy(async () => {
      if (userIds.length) await api('adminSetDuty', { date, userIds });
      else await api('adminClearDuty', { date });
      closeModal();
      toast('值日生已更新。', 'success');
      renderView();
    });
  });
}

function openRestoreModal() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json';
  input.onchange = async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const backup = JSON.parse(text);
      await busy(async () => {
        const r = await api('adminRestoreBackup', { backup });
        toast(`已還原：${r.usersRestored} 個帳號、${r.storesRestored} 個店家（訂單/場次為暫時資料，未還原）。`, 'success');
        await refreshAdmin();
      });
    } catch (error) {
      toast('還原失敗：' + error.message, 'error');
    }
  };
  input.click();
}

async function handleAction(action, target) {
  switch (action) {
    // 學生
    case 'show-qr-pay': await showMyQr('pay'); break;
    case 'show-qr-pickup': await showMyQr('pickup'); break;
    case 'refresh-wallet': await loadWalletDetail(); break;
    case 'manual-refresh': await manualRefresh(); break;
    case 'toggle-notifications': await toggleNotifications(); break;
    case 'install-app': if (state.deferredInstall) state.deferredInstall.prompt(); break;
    case 'change-password': await (await getAdmin()).promptChangePassword(); break;
    case 'change-name': promptModal('修改姓名', [{ name: 'studentName', label: '姓名', value: state.user.name }], async (v) => { const r = await api('updateProfile', { studentName: v.studentName }); state.user = r.user; render(); toast('姓名已更新。', 'success'); }); break;
    case 'logout': doLogout(); break;

    // 行事曆
    case 'calendar-add': openCalendarEventModal(); break;
    case 'calendar-edit': openCalendarEventModal(target.getAttribute('data-id')); break;
    case 'calendar-del': openConfirm('刪除事件', '確定要刪除這個事件嗎？', async () => { await api('calendarDelete', { id: target.getAttribute('data-id') }); toast('事件已刪除。', 'success'); await renderCalendarView($('#view')); }); break;
    case 'calendar-save': await saveCalendarEvent(); break;
    case 'calendar-ai': openCalendarAi(); break;
    case 'calendar-logs': state.calendar.showLogs = !state.calendar.showLogs; await renderCalendarView($('#view')); break;
    case 'calendar-toggle-past': state.calendar.showPast = !state.calendar.showPast; renderCalendarContent($('#view')); break;
    case 'save-calendar-ai': await saveCalendarAiEvents(); break;
    case 'del-calendar-ai': { const idx = Number(target.getAttribute('data-index')); state.calendarAiEvents.splice(idx, 1); renderCalendarAiList(); break; }
    // 管理員 - 菜單
    case 'add-store': promptModal('新增店家', [{ name: 'name', label: '店家名稱' }], async (v) => { await api('adminSaveStore', { name: v.name }); render(); }); break;
    case 'edit-store': {
      const store = state.admin.catalog?.stores?.find((s) => s.storeId === target.getAttribute('data-store'));
      promptModal('修改店家名稱', [{ name: 'name', label: '店家名稱', value: store?.name }], async (v) => { await api('adminSaveStore', { storeId: store.storeId, name: v.name }); render(); });
      break;
    }
    case 'del-store': openConfirm('刪除店家', '刪除後該店家的菜單會隱藏，但既有場次與訂單紀錄仍會保留。確定嗎？', async () => { await api('adminDeleteStore', { storeId: target.getAttribute('data-store') }); toast('店家已刪除。', 'success'); render(); }); break;
    case 'add-item': (await getAdmin()).openItemEditor(target.getAttribute('data-store')); break;
    case 'edit-item': (await getAdmin()).openItemEditor(null, target.getAttribute('data-item')); break;
    case 'del-item': openConfirm('刪除品項', '確定要刪除這個品項嗎？', async () => { await api('adminDeleteMenuItem', { itemId: target.getAttribute('data-item') }); render(); }); break;
    case 'ai-scan': (await getAdmin()).openAiScan(target.getAttribute('data-store')); break;
    case 'monthly-menu': (await getAdmin()).openMonthlyScan(); break;
    case 'save-vendor-items': await saveVendorItems(); break;
    case 'del-daily-item': openConfirm('刪除此品項', '將刪除此每日菜單品項，確定嗎？', async () => { await api('adminDeleteDailyMenuItem', { itemId: target.getAttribute('data-item') }); toast('已刪除。', 'success'); await refreshAdmin(); }); break;
    case 'clear-daily': { const month = state.admin.dailyMonth || todayString().slice(0, 7); openConfirm('一鍵刪除每日菜單', `將刪除 ${month} 月所有每日菜單（品項與對應場次），確定嗎？`, async () => { const r = await api('adminClearDailyMenus', { month }); toast(`已刪除 ${r.deletedItems} 個品項、${r.deletedSessions} 個場次${r.refundedOrders ? `、退款 ${r.refundedOrders} 筆訂單` : ''}。`, 'success'); await refreshAdmin(); }); break; }
    case 'del-monthly-entry': { const idx = Number(target.getAttribute('data-index')); if (Number.isInteger(idx)) state.monthlyEntries.splice(idx, 1); renderMonthlyList(); break; }
    case 'del-monthly-item': { const ei = Number(target.getAttribute('data-index')); const ii = Number(target.getAttribute('data-item')); const entry = state.monthlyEntries[ei]; if (entry?.items) { entry.items.splice(ii, 1); renderMonthlyList(); } break; }
    case 'add-monthly-item': { const ei = Number(target.getAttribute('data-index')); const entry = state.monthlyEntries[ei]; if (entry) { entry.items.push({ name: '', price: 0, dish: '' }); renderMonthlyList(); } break; }
    case 'save-item': await saveItem(target.getAttribute('data-item')); break;
    case 'save-ai-items': await saveAiItems(target.getAttribute('data-store')); break;
    case 'del-ai-item': {
      state.aiItems.splice(Number(target.getAttribute('data-index')), 1);
      renderAiList();
      break;
    }
    case 'del-ai-opt': {
      const idx = Number(target.getAttribute('data-index'));
      const oi = Number(target.getAttribute('data-opt'));
      const item = state.aiItems[idx];
      if (item?.options) { item.options.splice(oi, 1); renderAiList(); }
      break;
    }
    case 'add-ai-opt': {
      const idx = Number(target.getAttribute('data-index'));
      const item = state.aiItems[idx];
      if (item) { item.options = item.options || []; item.options.push({ name: '', price: 0 }); renderAiList(); }
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
    case 'add-session': (await getAdmin()).openSessionEditor(target.getAttribute('data-date')); break;
    case 'edit-session': (await getAdmin()).openSessionEditor(null, target.getAttribute('data-session')); break;
    case 'del-session': openConfirm('刪除場次', '刪除後將自動退還已付款項，確定嗎？', async () => { const r = await api('adminDeleteSession', { sessionId: target.getAttribute('data-session') }); toast(`場次已刪除，退還儲值金 $${money(r.refundedTotal || 0)}。`, 'success'); await refreshAdmin(); }); break;
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
    case 'clear-recurring': openConfirm('一鍵清除固定店家', '將取消所有固定店家設定，並刪除其「今天起」的預排場次（已付款訂單會自動退款）。確定嗎？', async () => {
      const r = await api('adminClearRecurring');
      toast(`已取消 ${r.clearedRecurring} 個固定店家、刪除 ${r.deletedSessions} 個預排場次${r.refundedOrders ? `（退款 ${r.refundedOrders} 筆訂單）` : ''}。`, 'success');
      await refreshAdmin();
    }); break;

    // 管理員 - 核銷
    case 'open-scanner': (await getAdmin()).openScanner(); break;
    case 'pin-input': {
      promptModal('輸入 PIN 碼', [{ name: 'pin', label: '6 位數 PIN', type: 'text' }], async (v) => { const r = await api('adminResolvePin', { pin: v.pin }); closeModal(); (await getAdmin()).renderVerifyResult(r); });
      break;
    }
    case 'seat-input': {
      promptModal('查詢當天訂單', [{ name: 'seatNo', label: '座號／學號', type: 'text', placeholder: '例如 05' }], async (v) => { const r = await api('adminResolveSeat', { seatNo: v.seatNo }); closeModal(); (await getAdmin()).renderVerifyResult(r); });
      break;
    }
    case 'submit-pin': {
      const pin = $('#manual-pin')?.value.trim();
      if (!pin) return;
      closeModal();
      try { const r = await api('adminResolvePin', { pin }); (await getAdmin()).renderVerifyResult(r); } catch (e) { toast(e.message, 'error'); (await getAdmin()).openScanner(); }
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
        renderView();
      });
      break;
    }
    case 'settle-all': {
      const userId = target.getAttribute('data-user');
      const orderIds = (state.admin.lastVerify?.unpaidOrders || []).map((order) => order.orderId);
      if (!orderIds.length) return;
      await busy(async () => {
        const r = await api('adminSettleCash', { userId, orderIds });
        const last = state.admin.lastVerify;
        if (last) { last.unpaidOrders = []; last.totalDebt = 0; }
        toast(r.walletUsed > 0 ? `已結清：餘額抵 $${money(r.walletUsed)}，現金 $${money((r.settled || 0) - (r.walletUsed || 0))}。` : '已現金結清。', 'success');
        renderView();
      });
      break;
    }
    case 'topup': (await getAdmin()).openTopupModal(target.getAttribute('data-user')); break;
    case 'adjust-balance': (await getAdmin()).openAdjustBalanceModal(target.getAttribute('data-user')); break;
    case 'pay-order': {
      const orderId = target.getAttribute('data-order');
      const userId = target.getAttribute('data-user');
      const dashboardOrder = (state.admin.dashboard?.orders || []).find((o) => o.orderId === orderId);
      const verifyOrder = (state.admin.lastVerify?.unpaidOrders || []).find((o) => o.orderId === orderId);
      let outstanding = 0;
      let label = '此筆訂單';
      if (dashboardOrder) {
        outstanding = Number(dashboardOrder.outstandingAmount || 0);
        label = `${dashboardOrder.seatNo || ''} ${dashboardOrder.studentName || ''} · ${dashboardOrder.itemName || ''}`;
      } else if (verifyOrder) {
        outstanding = Number(verifyOrder.outstanding || 0);
        const st = state.admin.lastVerify?.student;
        label = `${st?.seatNo || ''} ${st?.name || ''} · ${verifyOrder.storeName || ''} ${verifyOrder.itemName || ''}`;
      }
      (await getAdmin()).openPayModal({ userId, orderId, outstanding, label });
      break;
    }
    case 'cancel-order': openConfirm('取消訂單', '將取消此訂單，已付儲值金會退回該同學錢包。確定嗎？', async () => { const r = await api('adminCancelOrder', { orderId: target.getAttribute('data-order') }); toast(r.refunded > 0 ? ('已取消，退款 ' + money(r.refunded) + ' 元。') : '已取消訂單（無退款）。', 'success'); await refreshAdmin(); }); break;

    // 管理員 - 帳號
    case 'add-user': (await getAdmin()).openAddUserModal(); break;
    case 'promote': await withAdminRefresh(async () => { await api('adminSetRole', { userId: target.getAttribute('data-user'), role: 'Admin' }); toast('已設為管理。', 'success'); }); break;
    case 'demote': await withAdminRefresh(async () => { await api('adminSetRole', { userId: target.getAttribute('data-user'), role: 'Student' }); toast('已移除管理權限。', 'success'); }); break;
    case 'toggle-user': {
      const disabled = target.getAttribute('data-disabled') === 'true';
      await withAdminRefresh(async () => { await api('adminSetUserDisabled', { userId: target.getAttribute('data-user'), disabled: !disabled }); toast(disabled ? '帳號已啟用。' : '帳號已停用。', 'success'); });
      break;
    }
    case 'reset-pw': openConfirm('重設密碼', '將該同學的密碼重設為預設值，下次登入需重新設定。', async () => { await api('adminResetPassword', { userId: target.getAttribute('data-user') }); toast('已重設密碼。', 'success'); await refreshAdmin(); }); break;
    case 'toggle-duty': {
      const exempt = target.getAttribute('data-duty') === 'true';
      await withAdminRefresh(async () => { await api('adminSetDutyExempt', { userId: target.getAttribute('data-user'), dutyExempt: !exempt }); toast(exempt ? '已恢復值日。' : '已設為免值日。', 'success'); });
      break;
    }
    case 'set-duty': await openDutyEditor(target.getAttribute('data-date') || state.admin.dashboardDate); break;
    case 'reset-pw': openConfirm('重設密碼', '將該同學的密碼重設為預設值，下次登入需重新設定。', async () => { await api('adminResetPassword', { userId: target.getAttribute('data-user') }); toast('已重設密碼。', 'success'); await refreshAdmin(); }); break;
    case 'del-user': openConfirm('刪除帳號', '刪除後不可復原（該同學的歷史訂單會保留）。', async () => { await api('adminDeleteUser', { userId: target.getAttribute('data-user') }); await refreshAdmin(); }); break;

    // 管理員 - 設定
    case 'save-settings': {
      const className = $('#class-name')?.value.trim();
      const overdueRemindHours = Number($('#remind-hours')?.value || 24);
      const announcement = ($('#announcement')?.value || '').trim();
      await withAdminRefresh(async () => { await api('adminSaveSettings', { className, pureBalanceMode: state.admin.settings.pureBalanceMode, overdueRemindHours, announcement }); toast('設定已儲存。', 'success'); });
      break;
    }
    case 'view-overdue': await (await getAdmin()).viewOverdue(); break;
    case 'copy-overdue': await (await getAdmin()).copyOverdue(); break;
    case 'reset-all': openConfirm('刪除所有資料', '這會清除所有訂單、交易、場次、投票、放假、店家與菜單，並歸零儲值餘額。此操作無法復原！', async () => { await api('adminResetAllData'); toast('已刪除所有資料。', 'success'); await refreshAdmin(); }); break;
    case 'export-backup': await busy(async () => { const r = await api('adminExportBackup'); downloadJson(`訂餐通備份-${r.exportedAt.slice(0, 10)}.json`, r.backup); toast('備份已下載。', 'success'); }); break;
    case 'restore-backup': openRestoreModal(); break;

    // 總覽
    case 'settle-week': {
      const date = state.admin.dashboardDate || todayString();
      const weekLabel = weekLabelOf(new Date(`${date}T00:00:00`));
      openConfirm('本週結算', '將結清本週所有「現金未繳」的訂單（等同一次收齊本週餐費），確定嗎？', async () => {
        const r = await api('adminSettleWeek', { weekLabel });
        toast(`已結算 ${r.settledOrders} 筆訂單，共收現金 $${money(r.settledAmount)}。`, 'success');
        await refreshAdmin();
      });
      break;
    }
    case 'export-csv': await (await getAdmin()).exportCsv(); break;
    case 'export-activity': await (await getAdmin()).exportActivity(); break;
    case 'broadcast': openBroadcastModal(); break;
    case 'send-broadcast': {
      const title = ($('#broadcast-title')?.value || '').trim() || '訂餐通通知';
      const body = ($('#broadcast-body')?.value || '').trim();
      if (!body) return toast('請輸入通知內容。', 'error');
      await busy(async () => {
        const r = await api('adminBroadcast', { title, body });
        closeModal();
        toast(`已發送通知給 ${r.sent}／${r.attempted} 個裝置。`, 'success');
      });
      break;
    }
    case 'admin-add-order': {
      const sessionId = target.getAttribute('data-session');
      promptModal('管理員補單', [{ name: 'seatNo', label: '座號／學號', type: 'text', placeholder: '例如 05' }], async (v) => {
        await openAdminOrderSheet(sessionId, String(v.seatNo || '').trim());
      });
      break;
    }

    // 推薦菜單
    case 'submit-recommendation': {
      const storeName = $('#reco-store')?.value.trim();
      if (!storeName) return toast('請輸入店家名稱。', 'error');
      await busy(async () => {
        await api('createRecommendation', { storeName, note: ($('#reco-note')?.value || '').trim() });
        const storeEl = $('#reco-store'); const noteEl = $('#reco-note');
        if (storeEl) storeEl.value = '';
        if (noteEl) noteEl.value = '';
        toast('已送出推薦！', 'success');
      });
      break;
    }
    case 'reco-delete': openConfirm('刪除推薦', '確定刪除此推薦嗎？', async () => { await api('adminDeleteRecommendation', { id: target.getAttribute('data-id') }); await refreshAdmin(); }); break;

    // 請假
    case 'open-leave': await busy(() => (await getAdmin()).openLeaveModal()); break;
    case 'approve-leave': openConfirm('批准請假', '批准後將取消該日訂單並退費（若已繳）。確定嗎？', async () => { await api('adminResolveLeave', { id: target.getAttribute('data-id'), approve: true }); toast('已批准請假。', 'success'); await refreshAdmin(); }); break;
    case 'reject-leave': openConfirm('駁回請假', '確定駁回此請假申請嗎？申請者會收到通知。', async () => { await api('adminResolveLeave', { id: target.getAttribute('data-id'), approve: false }); toast('已駁回請假。', 'success'); await refreshAdmin(); }); break;

    // 請客場次（管理員）
    case 'open-treat': await busy(() => (await getAdmin()).openTreatSessionModal()); break;

    // 自訂欠費（使用者彼此）
    case 'open-debt': await busy(() => (await getAdmin()).openDebtModal()); break;
    case 'settle-debt': openConfirm('核銷欠費', '確定已收到這筆錢並核銷嗎？', async () => { await api('debtSettle', { id: target.getAttribute('data-id') }); toast('已核銷。', 'success'); await (await getAdmin()).openDebtModal(); }); break;
    case 'del-debt': openConfirm('刪除欠費', '確定刪除此筆欠費紀錄嗎？', async () => { await api('debtDelete', { id: target.getAttribute('data-id') }); toast('已刪除。', 'success'); await (await getAdmin()).openDebtModal(); }); break;

    // 更新日誌
    case 'open-changelog': await busy(() => (await getAdmin()).openChangelogModal()); break;
    case 'manage-changelog': await busy(() => (await getAdmin()).openManageChangelogModal()); break;
    case 'del-changelog': openConfirm('刪除日誌', '確定刪除此更新日誌嗎？', async () => { await api('adminDeleteChangelog', { id: target.getAttribute('data-id') }); await (await getAdmin()).openManageChangelogModal(); }); break;

    // AI 設定
    case 'ai-settings': await busy(() => (await getAdmin()).openAiSettingsModal()); break;

    // 部分繳費
    // 師長角色
    case 'set-role-teacher': await withAdminRefresh(async () => { await api('adminSetRole', { userId: target.getAttribute('data-user'), role: 'Teacher' }); toast('已設為師長。', 'success'); }); break;
    case 'set-role-student': await withAdminRefresh(async () => { await api('adminSetRole', { userId: target.getAttribute('data-user'), role: 'Student' }); toast('已設為學生。', 'success'); }); break;

    // 重新整理管理頁
    case 'refresh-admin': await busy(refreshAdmin); break;

    default: break;
  }
}

async function refreshAdmin() {
  state.boot = await api('getBootstrap');
  state.user = state.boot.user;
  syncHeader();
  renderView();
}

async function manualRefresh() {
  const icon = $('#refresh-icon');
  if (icon) icon.classList.add('spin');
  try {
    await busy(async () => {
      await refreshBoot();
      renderView();
    });
    toast('已重新整理。', 'success');
  } catch (error) {
    toast(error?.message || '重新整理失敗，請再試一次。', 'error');
  } finally {
    if (icon) icon.classList.remove('spin');
  }
}

function openWeekCutoffModal() {
  const dates = weekDates(state.admin.scheduleWeek);
  const defaultVal = dates.length ? `${dates[0]}T10:00` : '';
  promptModal('設定本週統一截止時間', [
    { name: 'cutoff', label: '截止時間（套用到本週所有場次）', type: 'datetime-local', value: defaultVal },
  ], async (v) => {
    const cutoffTime = new Date(v.cutoff).toISOString();
    const r = await api('adminSetWeekCutoff', { weekLabel: state.admin.scheduleWeek, cutoffTime });
    toast(`已更新 ${r.updated} 個場次的截止時間。`, 'success');
    await refreshAdmin();
  });
}

async function openBroadcastModal() {
  let statusLine = '查詢推播訂閱中…';
  try {
    const status = await api('adminGetPushStatus');
    statusLine = status.configured
      ? `目前已有 ${status.userCount} 人開啟通知（${status.deviceCount} 台裝置）。`
      : '伺服器尚未設定推播金鑰，無法發送通知。';
  } catch (_) {
    statusLine = '無法查詢推播訂閱狀態。';
  }
  modalRoot.innerHTML = `
    <div class="fixed inset-0 z-50 flex items-end justify-center bg-ledger/50">
      <section class="sheet-enter flex w-full max-w-md flex-col overflow-hidden rounded-t-[1.5rem] bg-paper">
        <div class="flex items-center justify-between border-b border-ledger/10 bg-white px-5 py-4">
          <div>
            <p class="text-[11px] font-bold tracking-[.13em] text-slate-500">BROADCAST</p>
            <h2 class="font-serif text-xl font-black">發送全服通知</h2>
          </div>
          <button data-close-sheet class="grid h-9 w-9 place-items-center rounded-full bg-mist text-xl">×</button>
        </div>
        <div class="px-5 py-4">
          <label class="mb-1 block text-xs font-bold text-slate-500">標題</label>
          <input id="broadcast-title" maxlength="60" value="訂餐通通知" class="mb-3 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-ledger" />
          <label class="mb-1 block text-xs font-bold text-slate-500">內容</label>
          <textarea id="broadcast-body" rows="4" maxlength="200" class="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-ledger" placeholder="例如：明天記得帶餐盒…"></textarea>
          <p class="mt-2 text-xs text-slate-400">${escapeHtml(statusLine)}</p>
        </div>
        <div class="border-t border-ledger/10 bg-white px-5 py-4">
          <button data-action="send-broadcast" class="w-full rounded-xl bg-stamp py-3 text-sm font-bold text-white">發送通知</button>
        </div>
      </section>
    </div>`;
}

/* ============================ 班級行事曆 ============================ */
function categoryBadge(category) {
  const map = { '考試': 'bg-red-50 text-red-600', '作業': 'bg-amber-50 text-amber-600', '活動': 'bg-emerald-50 text-emerald-600', '其他': 'bg-slate-100 text-slate-500' };
  return map[category] || map['其他'];
}

function calendarActionLabel(action) {
  return { create: '新增', update: '修改', delete: '刪除' }[action] || action;
}

async function renderCalendarView(root) {
  const prevScroll = window.scrollY;
  try {
    const data = await api('calendarList', { month: state.calendar.month });
    state.calendar.events = data.events || [];
    if (state.user.role === 'Admin' && state.calendar.showLogs) {
      const logs = await api('calendarLogs', { limit: 100 });
      state.calendar.logs = logs.logs || [];
    }
  } catch (error) {
    root.innerHTML = `<p class="py-10 text-center text-sm text-red-500">${escapeHtml(error.message)}</p>`;
    return;
  }
  try {
    renderCalendarContent(root);
  } catch (error) {
    root.innerHTML = `<p class="py-10 text-center text-sm text-red-500">${escapeHtml(error.message)}</p>`;
  }
  requestAnimationFrame(() => window.scrollTo(0, prevScroll));
}

function renderCalendarContent(root) {
  const isAdmin = state.user.role === 'Admin';
  const month = state.calendar.month;
  const events = state.calendar.events || [];
  const showLogs = isAdmin && state.calendar.showLogs;
  const today = todayString();

  const upcoming = events.filter((e) => e.date >= today);
  const past = events.filter((e) => e.date < today).sort((a, b) => b.date.localeCompare(a.date));
  const showPast = state.calendar.showPast;

  const group = (list) => {
    const dates = [...new Set(list.map((e) => e.date))].sort();
    return dates.map((date) => ({ date, items: list.filter((e) => e.date === date) }));
  };

  let body;
  if (showLogs) {
    body = renderCalendarLogsHtml();
  } else if (!events.length) {
    body = '<p class="rounded-2xl bg-white/60 px-4 py-12 text-center text-sm text-slate-400">這個月尚無事件，點「＋ 新增事件」或「AI 辨識」開始。</p>';
  } else {
    body = `
      ${upcoming.length ? renderCalendarEventsHtml(group(upcoming)) : '<p class="rounded-2xl bg-white/60 px-4 py-8 text-center text-sm text-slate-400">本月沒有未來的活動。</p>'}
      ${past.length ? `
      <button data-action="calendar-toggle-past" class="flex w-full items-center justify-between rounded-2xl bg-white/80 px-4 py-3 text-sm font-bold text-slate-500 ring-1 ring-ledger/10">
        <span>${showPast ? '▾ 隱藏已過期事件' : `▸ 已過期事件（${past.length}）`}</span>
      </button>
      ${showPast ? renderCalendarEventsHtml(group(past)) : ''}` : ''}
    `;
  }

  root.innerHTML = `
    <section class="view-enter space-y-4">
      <div class="flex items-center justify-between">
        <div>
          <p class="text-[11px] font-bold tracking-[.13em] text-stamp">CALENDAR</p>
          <h2 class="font-serif text-xl font-black">班級行事曆</h2>
        </div>
        <button data-action="calendar-add" class="rounded-xl bg-stamp px-4 py-2.5 text-xs font-bold text-white">＋ 新增事件</button>
      </div>
      <div class="flex flex-wrap gap-2">
        <input id="calendar-month" type="month" value="${escapeHtml(month)}" class="w-36 rounded-xl border border-slate-200 px-2 py-2 text-sm outline-none focus:border-ledger" />
        <button data-action="calendar-ai" class="rounded-xl bg-white px-3 py-2 text-xs font-bold text-ledger ring-1 ring-ledger/10">📷 AI 辨識新增</button>
        ${isAdmin ? `<button data-action="calendar-logs" class="rounded-xl bg-white px-3 py-2 text-xs font-bold text-ledger ring-1 ring-ledger/10">${showLogs ? '← 返回行事曆' : '歷史紀錄'}</button>` : ''}
      </div>
      ${body}
    </section>`;
  $('#calendar-month')?.addEventListener('change', async (e) => {
    state.calendar.month = e.target.value;
    await renderCalendarView($('#view'));
  });
}

function renderCalendarEventsHtml(grouped) {
  if (!grouped.length) return '<p class="rounded-2xl bg-white/60 px-4 py-12 text-center text-sm text-slate-400">這個月尚無事件，點「＋ 新增事件」或「AI 辨識」開始。</p>';
  return grouped.map((group) => `
    <div>
      <p class="mb-1.5 text-xs font-bold text-slate-500">${escapeHtml(monthDay(group.date))} ${escapeHtml(weekdayName(group.date))}</p>
      <div class="space-y-2">
        ${group.items.map((ev) => {
          const canEdit = state.user.role === 'Admin' || (state.user.role !== 'Teacher' && String(ev.userId) === String(state.user.id));
          return `
          <div class="rounded-2xl bg-white p-4 shadow-paper ring-1 ring-ledger/5">
            <div class="flex items-start justify-between gap-2">
              <div class="min-w-0">
                <p class="font-bold leading-6 text-ledger">${escapeHtml(ev.title)} <span class="ml-1 rounded-full px-2 py-0.5 text-[10px] font-bold ${categoryBadge(ev.category)}">${escapeHtml(ev.category)}</span></p>
                ${ev.description ? `<p class="mt-0.5 whitespace-pre-line text-xs leading-5 text-slate-500">${escapeHtml(ev.description)}</p>` : ''}
                <p class="mt-1 text-[11px] text-slate-400">由 ${escapeHtml(ev.ownerSeat || '')}${ev.ownerSeat && ev.ownerName ? ' ' : ''}${escapeHtml(ev.ownerName || '')} 新增</p>
              </div>
              ${canEdit ? `
              <div class="flex shrink-0 gap-1.5">
                <button data-action="calendar-edit" data-id="${ev.id}" class="grid h-8 w-8 place-items-center rounded-lg bg-mist text-sm text-ledger">✎</button>
                <button data-action="calendar-del" data-id="${ev.id}" class="grid h-8 w-8 place-items-center rounded-lg bg-red-50 text-sm text-red-600">✕</button>
              </div>` : ''}
            </div>
          </div>`;
        }).join('')}
      </div>
    </div>`).join('');
}

function renderCalendarLogsHtml() {
  const logs = state.calendar.logs || [];
  if (!logs.length) return '<p class="rounded-2xl bg-white/60 px-4 py-12 text-center text-sm text-slate-400">尚無歷史紀錄。</p>';
  return `<div class="overflow-hidden rounded-2xl bg-white shadow-paper ring-1 ring-ledger/5">
    ${logs.map((log) => `
    <div class="flex items-center justify-between border-b border-dashed border-ledger/10 px-4 py-2.5 last:border-b-0">
      <div class="min-w-0">
        <p class="text-sm font-bold text-ledger">${escapeHtml(log.userLabel || '已刪除帳號')} <span class="text-xs font-normal text-slate-400">${calendarActionLabel(log.action)}</span></p>
        <p class="truncate text-xs text-slate-500">${escapeHtml(log.detail)}</p>
      </div>
      <span class="ml-3 shrink-0 text-[10px] text-slate-400">${activityTime(log.time)}</span>
    </div>`).join('')}
  </div>`;
}

function openCalendarEventModal(id) {
  const events = state.calendar.events || [];
  const ev = id ? events.find((e) => String(e.id) === String(id)) : null;
  const date = ev?.date || todayString();
  const cats = ['考試', '作業', '活動', '其他'];
  state.calendarEditingId = id || null;
  state.calendarCategory = ev?.category || '其他';
  modalRoot.innerHTML = `
    <div class="fixed inset-0 z-50 flex items-end justify-center bg-ledger/50">
      <section class="sheet-enter flex max-h-[92dvh] w-full max-w-md flex-col overflow-hidden rounded-t-[1.5rem] bg-paper">
        <div class="flex items-center justify-between border-b border-ledger/10 bg-white px-5 py-4">
          <div><p class="text-[11px] font-bold tracking-[.13em] text-stamp">EVENT</p><h2 class="font-serif text-xl font-black">${ev ? '編輯事件' : '新增事件'}</h2></div>
          <button data-close-sheet class="grid h-9 w-9 place-items-center rounded-full bg-mist text-xl">×</button>
        </div>
        <div class="flex-1 overflow-y-auto px-5 py-4">
          <label class="mb-1 block text-xs font-bold text-slate-500">事件名稱</label>
          <input id="calendar-title" maxlength="80" value="${escapeHtml(ev?.title || '')}" placeholder="例如：第二次段考" class="mb-3 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-ledger" />
          <label class="mb-1 block text-xs font-bold text-slate-500">日期</label>
          <input id="calendar-date" type="date" value="${escapeHtml(date)}" class="mb-3 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-ledger" />
          <label class="mb-1 block text-xs font-bold text-slate-500">類別</label>
          <div class="mb-3 flex flex-wrap gap-2" id="calendar-cats">
            ${cats.map((c) => `<button type="button" data-cat="${c}" class="rounded-full px-3 py-1.5 text-xs font-bold ring-1 ${state.calendarCategory === c ? 'bg-stamp text-white ring-stamp' : 'bg-mist text-ledger ring-ledger/10'}">${c}</button>`).join('')}
          </div>
          <label class="mb-1 block text-xs font-bold text-slate-500">說明（可選）</label>
          <textarea id="calendar-desc" rows="3" maxlength="300" placeholder="例如：考國文、英文" class="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-ledger">${escapeHtml(ev?.description || '')}</textarea>
        </div>
        <div class="border-t border-ledger/10 bg-white px-5 py-4">
          <button data-action="calendar-save" class="w-full rounded-xl bg-stamp py-3 text-sm font-bold text-white">${ev ? '儲存修改' : '新增事件'}</button>
        </div>
      </section>
    </div>`;
  modalRoot.querySelectorAll('#calendar-cats [data-cat]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.calendarCategory = btn.getAttribute('data-cat');
      modalRoot.querySelectorAll('#calendar-cats [data-cat]').forEach((b) => {
        const active = b.getAttribute('data-cat') === state.calendarCategory;
        b.className = `rounded-full px-3 py-1.5 text-xs font-bold ring-1 ${active ? 'bg-stamp text-white ring-stamp' : 'bg-mist text-ledger ring-ledger/10'}`;
      });
    });
  });
}

async function saveCalendarEvent() {
  const title = ($('#calendar-title')?.value || '').trim();
  const date = ($('#calendar-date')?.value || '').trim();
  const description = ($('#calendar-desc')?.value || '').trim();
  const id = state.calendarEditingId;
  closeModal();
  try {
    await busy(async () => {
      if (id) await api('calendarUpdate', { id, title, date, description, category: state.calendarCategory });
      else await api('calendarCreate', { title, date, description, category: state.calendarCategory });
      await renderCalendarView($('#view'));
    });
    toast(id ? '事件已更新。' : '事件已新增。', 'success');
  } catch (error) {
    toast(error.message, 'error');
    await renderCalendarView($('#view'));
  }
}

function openCalendarAi() {
  modalRoot.innerHTML = `
    <div class="fixed inset-0 z-50 flex items-end justify-center bg-ledger/50">
      <section class="sheet-enter w-full max-w-md rounded-t-[1.5rem] bg-white p-6">
        <div class="flex items-center justify-between">
          <div><p class="text-[11px] font-bold tracking-[.13em] text-stamp">AI OCR · 行事曆</p><h2 class="font-serif text-xl font-black">AI 辨識事件</h2></div>
          <button data-close-sheet class="grid h-9 w-9 place-items-center rounded-full bg-mist text-xl">×</button>
        </div>
        <div class="mt-4">
          <label class="mb-1 block text-xs font-bold text-slate-500">資料月份（決定日期年份）</label>
          <input id="calai-month" type="month" value="${state.calendar.month}" class="mb-3 w-full rounded-xl border border-slate-200 px-3 py-2.5 outline-none focus:border-ledger" />
        </div>
        <p class="text-xs font-bold text-slate-500">選擇照片（行事曆、班級通知、課表…）：</p>
        <div class="mt-2 grid grid-cols-2 gap-3">
          <label class="flex cursor-pointer flex-col items-center rounded-2xl border-2 border-dashed border-ledger/20 bg-mist/50 px-4 py-7">
            <span class="text-3xl">📷</span><span class="mt-2 text-sm font-bold text-ledger">拍照</span><span class="mt-1 text-xs text-slate-400">開啟相機</span>
            <input id="calai-camera" type="file" accept="image/*" capture="environment" class="hidden" />
          </label>
          <label class="flex cursor-pointer flex-col items-center rounded-2xl border-2 border-dashed border-ledger/20 bg-mist/50 px-4 py-7">
            <span class="text-3xl">🖼️</span><span class="mt-2 text-sm font-bold text-ledger">上傳圖片</span><span class="mt-1 text-xs text-slate-400">從相簿選擇</span>
            <input id="calai-upload" type="file" accept="image/*" class="hidden" />
          </label>
        </div>
        <p id="calai-status" class="mt-3 text-center text-xs text-slate-400">AI 會辨識事件名稱、日期與類別（考試／作業／活動／其他）。</p>
      </section>
    </div>`;
  $('#calai-camera').addEventListener('change', (e) => handleCalendarAiFile(e));
  $('#calai-upload').addEventListener('change', (e) => handleCalendarAiFile(e));
}

async function handleCalendarAiFile(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  const month = ($('#calai-month')?.value || state.calendar.month).trim();
  if (!/^\d{4}-\d{2}$/.test(month)) return toast('請選擇月份。', 'error');
  const statusEl = $('#calai-status');
  if (statusEl) statusEl.textContent = '圖片處理中…';
  try {
    const { imageBase64, mimeType } = await compressImage(file);
    if (statusEl) statusEl.textContent = '辨識中，請稍候…';
    const result = await api('calendarAiRecognize', { imageBase64, mimeType, month });
    showCalendarAiPreview(result.events);
  } catch (error) {
    if (statusEl) statusEl.textContent = error.message;
    else toast(error.message, 'error');
  }
}

function showCalendarAiPreview(events) {
  if (!events.length) { toast('沒有辨識到任何事件。', 'error'); closeModal(); return; }
  state.calendarAiEvents = events.map((ev) => ({ ...ev, category: ev.category || '其他' }));
  modalRoot.innerHTML = `
    <div class="fixed inset-0 z-50 flex items-end justify-center bg-ledger/50">
      <section class="sheet-enter flex max-h-[92dvh] w-full max-w-md flex-col overflow-hidden rounded-t-[1.5rem] bg-paper">
        <div class="flex items-center justify-between border-b border-ledger/10 bg-white px-5 py-4">
          <div><p class="text-[11px] font-bold tracking-[.13em] text-stamp">PREVIEW</p><h2 class="font-serif text-xl font-black">辨識結果（${state.calendarAiEvents.length}）</h2></div>
          <button data-close-sheet class="grid h-9 w-9 place-items-center rounded-full bg-mist text-xl">×</button>
        </div>
        <div class="flex-1 overflow-y-auto px-4 py-3" id="calai-list"></div>
        <div class="border-t border-ledger/10 bg-white px-5 py-4">
          <button data-action="save-calendar-ai" class="w-full rounded-xl bg-stamp py-3 text-sm font-bold text-white">確認新增（${state.calendarAiEvents.length} 個事件）</button>
        </div>
      </section>
    </div>`;
  renderCalendarAiList();
}

function renderCalendarAiList() {
  const listEl = $('#calai-list');
  if (!listEl) return;
  const cats = ['考試', '作業', '活動', '其他'];
  listEl.innerHTML = state.calendarAiEvents.map((ev, i) => `
    <div class="mb-3 rounded-xl bg-white p-3 shadow-sm ring-1 ring-ledger/5">
      <div class="flex items-center gap-1.5">
        <input data-calai-date="${i}" type="date" value="${escapeHtml(ev.date)}" class="w-36 rounded-lg border border-slate-200 px-2 py-1.5 text-xs font-bold text-ledger outline-none focus:border-ledger" />
        <input data-calai-title="${i}" value="${escapeHtml(ev.title)}" placeholder="事件名稱" class="min-w-0 flex-1 rounded-lg border border-slate-200 px-2 py-1.5 text-xs outline-none focus:border-ledger" />
        <button data-action="del-calendar-ai" data-index="${i}" class="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-red-50 text-xs text-red-500">×</button>
      </div>
      <div class="mt-1.5 flex flex-wrap gap-1.5">
        ${cats.map((c) => `<button type="button" data-calai-cat="${i}-${c}" class="rounded-full px-2.5 py-1 text-[11px] font-bold ring-1 ${ev.category === c ? 'bg-stamp text-white ring-stamp' : 'bg-mist text-ledger ring-ledger/10'}">${c}</button>`).join('')}
      </div>
      <input data-calai-desc="${i}" value="${escapeHtml(ev.description || '')}" placeholder="說明（可選）" class="mt-1.5 w-full rounded-lg border border-slate-200 px-2 py-1.5 text-xs outline-none focus:border-ledger" />
    </div>`).join('');
  listEl.querySelectorAll('input[data-calai-date]').forEach((el) => { el.addEventListener('input', () => { state.calendarAiEvents[Number(el.dataset.calaiDate)].date = el.value; }); });
  listEl.querySelectorAll('input[data-calai-title]').forEach((el) => { el.addEventListener('input', () => { state.calendarAiEvents[Number(el.dataset.calaiTitle)].title = el.value; }); });
  listEl.querySelectorAll('input[data-calai-desc]').forEach((el) => { el.addEventListener('input', () => { state.calendarAiEvents[Number(el.dataset.calaiDesc)].description = el.value; }); });
  listEl.querySelectorAll('button[data-calai-cat]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const [i, c] = btn.getAttribute('data-calai-cat').split('-');
      state.calendarAiEvents[Number(i)].category = c;
      renderCalendarAiList();
    });
  });
}

async function saveCalendarAiEvents() {
  const events = (state.calendarAiEvents || []).filter((ev) => ev.title && /^\d{4}-\d{2}-\d{2}$/.test(ev.date));
  if (!events.length) return toast('沒有可新增的事件。', 'error');
  closeModal();
  let created = 0;
  let failed = 0;
  await busy(async () => {
    const results = await Promise.all(events.map(async (ev) => {
      try {
        await api('calendarCreate', { title: ev.title, date: ev.date, category: ev.category, description: ev.description || '' });
        return true;
      } catch (_) { return false; }
    }));
    created = results.filter(Boolean).length;
    failed = results.filter((r) => !r).length;
    await renderCalendarView($('#view'));
  });
  toast(`已新增 ${created} 個事件${failed ? `、${failed} 個失敗` : ''}。`, failed ? 'info' : 'success');
}

