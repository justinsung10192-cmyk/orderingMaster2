// 前端共用純函式：金額、日期、週別、CSV、倒數等

export const money = (value) => {
  const n = Number(value || 0);
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.00$/, '');
};

export const fmtMoney = (value) => `$${money(value)}`;

export function todayString() {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function mondayOf(input = new Date()) {
  const d = new Date(input);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return dateString(d);
}

function dateString(d) {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function weekLabelOf(dateInput) {
  const monday = new Date(`${mondayOf(dateInput)}T00:00:00`);
  const jan1 = new Date(monday.getFullYear(), 0, 1);
  const firstMonday = new Date(jan1);
  firstMonday.setDate(jan1.getDate() + (1 - jan1.getDay()));
  const week = Math.floor((monday - firstMonday) / (7 * 86400000)) + 1;
  return `${monday.getFullYear()}-W${week}`;
}

export function nextWeekLabel() {
  const monday = new Date(`${mondayOf()}T00:00:00`);
  monday.setDate(monday.getDate() + 7);
  return weekLabelOf(monday);
}

// 週一～週日的 7 個日期
export function weekDates(weekLabel) {
  const match = /^(\d{4})-W(\d{1,2})$/.exec(String(weekLabel || ''));
  if (!match) return [];
  const year = Number(match[1]);
  const week = Number(match[2]);
  const jan1 = new Date(year, 0, 1);
  const monday = new Date(jan1);
  monday.setDate(jan1.getDate() + (1 - jan1.getDay()) + (week - 1) * 7);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return dateString(d);
  });
}

export function weekdayName(dateStringValue) {
  const d = new Date(`${dateStringValue}T00:00:00`);
  if (Number.isNaN(d.getTime())) return '';
  return ['週日', '週一', '週二', '週三', '週四', '週五', '週六'][d.getDay()];
}

export function monthDay(dateStringValue) {
  const d = new Date(`${dateStringValue}T00:00:00`);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export function weekFriendlyLabel(weekLabel) {
  const dates = weekDates(weekLabel);
  if (!dates.length) return weekLabel;
  const thisWeek = weekLabelOf(todayString());
  const nextWeek = nextWeekLabel();
  const prefix = weekLabel === thisWeek ? '本週' : weekLabel === nextWeek ? '下週' : '';
  return `${prefix} ${monthDay(dates[0])}–${monthDay(dates[6])}`;
}

export function formatClock(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function cutoffRemaining(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return { passed: true, text: '已截止' };
  const totalMinutes = Math.floor(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return { passed: false, text: `${hours} 小時 ${minutes} 分後截止` };
  return { passed: false, text: `${minutes} 分後截止` };
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const PAYMENT_LABEL = {
  PaidWallet: '儲值已付',
  PaidCash: '現金已付',
  PartiallyPaid: '部分已付',
  UnpaidCash: '現金未繳',
};

export function paymentLabel(status) {
  return PAYMENT_LABEL[status] || status;
}

export function paymentColor(status) {
  if (status === 'PaidWallet' || status === 'PaidCash') return 'text-stamp bg-emerald-50';
  if (status === 'PartiallyPaid') return 'text-apricot bg-amber-50';
  return 'text-red-600 bg-red-50';
}

// 將訂單列轉成 CSV 字串（Excel 相容，加 BOM）
export function buildCsv(rows) {
  const headers = ['日期', '店家', '座號', '姓名', '品項', '客製選項', '備註', '金額', '付款狀態', '取餐狀態'];
  const escape = (value) => {
    const s = String(value ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.map(escape).join(',')];
  rows.forEach((row) => {
    const options = (row.selectedOptions || []).map((option) => option.name).join(' / ');
    lines.push([
      row.orderDate,
      row.storeName,
      row.seatNo,
      row.studentName,
      row.itemName,
      options,
      row.note,
      row.totalPrice,
      paymentLabel(row.paymentStatus),
      row.pickupStatus === 'PickedUp' ? '已取餐' : '未取餐',
    ].map(escape).join(','));
  });
  return '\uFEFF' + lines.join('\r\n');
}
