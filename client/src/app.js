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

function renderView() {
  const view = $('#view');
  if (!view) return;
  if (state.view === 'order') return renderOrderView(view);
  if (state.view === 'vote') return renderVoteView(view);
  if (state.view === 'calendar') return renderCalendarView(view);
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
                <p class="text-xs text-slate-500">共 ${count} 份${covered > 0 ? ` · 請客折抵 ${fmtMoney(covered)}` : ''}</p>
                <p class="font-serif text-2xl font-black tabular-nums">${fmtMoney(total)}</p>
                ${covered > 0 ? `<p class="text-[11px] font-bold text-stamp">實付 ${fmtMoney(netTotal)}</p>` : ''}
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
          <p class="mt-0.5 text-sm font-bold tabular-nums text-stamp">${fmtMoney(Number(item.price) + optionTotal)}</p>
        </div>
        <div class="flex items-center gap-2">
          <button data-qty="${item.itemId}" data-delta="-1" class="grid h-8 w-8 place-items-center rounded-lg bg-mist text-lg font-bold text-ledger ${quantity < 1 ? 'opacity-40' : ''}">−</button>
          <span class="w-6 text-center text-lg font-black tabular-nums">${quantity}</span>
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
      if (myVotes.has(storeId)) {
        await api('removeVote', { storeId });
        toast(`已取消「${store.name}」的票。`);
      } else {
        await api('castVote', { storeId });
        toast(`已投給「${store.name}」！`);
      }
      state.boot = await api('getBootstrap');
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
async function showMyQr(type) {
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
    if (window.QRCode) new window.QRCode($('#my-qr'), { text: JSON.stringify(result.payload), width: 200, height: 200 });
    else { const el = $('#my-qr'); if (el) el.textContent = 'QR 庫載入中，請稍後重試。'; }
  } catch (error) {
    toast(error.message, 'error');
  }
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

function activityTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
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
        await api('adminSettleCash', { userId: ctx.userId, orderIds: [ctx.orderId] });
        closeModal();
        toast('已全額結清。', 'success');
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
                  <span class="rounded-full bg-ledger px-2 py-0.5 text-[10px] font-bold text-white">${escapeHtml(c.version)}</span>
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

  if (window.Html5Qrcode) {
    state.scanner = new window.Html5Qrcode('qr-reader');
    state.scanner.start(
      { facingMode: 'environment' },
      { fps: 15, qrbox: { width: 260, height: 260 }, aspectRatio: 1.0, rememberLastUsedCamera: true },
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
    renderAdminTab();
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
    sel.quantity = Math.max(0, Math.min(99, sel.quantity + delta));
    if (sel.quantity > 0) state.orderDraft.selections[qty] = sel; else delete state.orderDraft.selections[qty];
    renderOrderSheet();
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
    case 'change-password': await promptChangePassword(); break;
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
    case 'add-item': openItemEditor(target.getAttribute('data-store')); break;
    case 'edit-item': openItemEditor(null, target.getAttribute('data-item')); break;
    case 'del-item': openConfirm('刪除品項', '確定要刪除這個品項嗎？', async () => { await api('adminDeleteMenuItem', { itemId: target.getAttribute('data-item') }); render(); }); break;
    case 'ai-scan': openAiScan(target.getAttribute('data-store')); break;
    case 'monthly-menu': openMonthlyScan(); break;
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
    case 'add-session': openSessionEditor(target.getAttribute('data-date')); break;
    case 'edit-session': openSessionEditor(null, target.getAttribute('data-session')); break;
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
    case 'open-scanner': openScanner(); break;
    case 'pin-input': {
      promptModal('輸入 PIN 碼', [{ name: 'pin', label: '6 位數 PIN', type: 'text' }], async (v) => { const r = await api('adminResolvePin', { pin: v.pin }); closeModal(); renderVerifyResult(r); });
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
        renderView();
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
        renderView();
      });
      break;
    }
    case 'topup': openTopupModal(target.getAttribute('data-user')); break;
    case 'adjust-balance': openAdjustBalanceModal(target.getAttribute('data-user')); break;
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
      openPayModal({ userId, orderId, outstanding, label });
      break;
    }
    case 'cancel-order': openConfirm('取消訂單', '將取消此訂單，已付儲值金會退回該同學錢包。確定嗎？', async () => { const r = await api('adminCancelOrder', { orderId: target.getAttribute('data-order') }); toast(r.refunded > 0 ? ('已取消，退款 ' + money(r.refunded) + ' 元。') : '已取消訂單（無退款）。', 'success'); await refreshAdmin(); }); break;

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
    case 'view-overdue': await viewOverdue(); break;
    case 'copy-overdue': await copyOverdue(); break;
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
    case 'export-csv': await exportCsv(); break;
    case 'export-activity': await exportActivity(); break;
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
    case 'open-leave': await busy(() => openLeaveModal()); break;
    case 'approve-leave': openConfirm('批准請假', '批准後將取消該日訂單並退費（若已繳）。確定嗎？', async () => { await api('adminResolveLeave', { id: target.getAttribute('data-id'), approve: true }); toast('已批准請假。', 'success'); await refreshAdmin(); }); break;
    case 'reject-leave': openConfirm('駁回請假', '確定駁回此請假申請嗎？申請者會收到通知。', async () => { await api('adminResolveLeave', { id: target.getAttribute('data-id'), approve: false }); toast('已駁回請假。', 'success'); await refreshAdmin(); }); break;

    // 請客場次（管理員）
    case 'open-treat': await busy(() => openTreatSessionModal()); break;

    // 自訂欠費（使用者彼此）
    case 'open-debt': await busy(() => openDebtModal()); break;
    case 'settle-debt': openConfirm('核銷欠費', '確定已收到這筆錢並核銷嗎？', async () => { await api('debtSettle', { id: target.getAttribute('data-id') }); toast('已核銷。', 'success'); await openDebtModal(); }); break;
    case 'del-debt': openConfirm('刪除欠費', '確定刪除此筆欠費紀錄嗎？', async () => { await api('debtDelete', { id: target.getAttribute('data-id') }); toast('已刪除。', 'success'); await openDebtModal(); }); break;

    // 更新日誌
    case 'open-changelog': await busy(() => openChangelogModal()); break;
    case 'manage-changelog': await busy(() => openManageChangelogModal()); break;
    case 'del-changelog': openConfirm('刪除日誌', '確定刪除此更新日誌嗎？', async () => { await api('adminDeleteChangelog', { id: target.getAttribute('data-id') }); await openManageChangelogModal(); }); break;

    // AI 設定
    case 'ai-settings': await busy(() => openAiSettingsModal()); break;

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

function doLogout() {
  api('logout').catch(() => {});
  state.token = '';
  state.user = null;
  state.boot = null;
  localStorage.removeItem('meal.token');
  render();
}

bootstrap();
