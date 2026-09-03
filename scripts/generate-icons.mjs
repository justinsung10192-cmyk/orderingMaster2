// 產生網站圖標：favicon.svg（含「雄中」文字）＋ PWA PNG（192 / 512 / apple-touch 180）
// 執行：node scripts/generate-icons.mjs
// 若你有真實 logo，直接把 client/public/icons/ 下的圖檔覆蓋成你的圖片即可（保持檔名與尺寸）。
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'client', 'public', 'icons');

const THEME = [23, 59, 98]; // #173B62
const WHITE = [255, 255, 255];

// ---- 最小 PNG 編碼器（RGBA，零相依）----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}
function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0;
    rgba.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4);
  }
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function insideRoundedRect(px, py, x0, y0, x1, y1, r) {
  if (px < x0 || px > x1 || py < y0 || py > y1) return false;
  const cx = Math.max(x0 + r, Math.min(px, x1 - r));
  const cy = Math.max(y0 + r, Math.min(py, y1 - r));
  const dx = px - cx, dy = py - cy;
  return dx * dx + dy * dy <= r * r;
}

// 圓角方形＋白色「餐盤」環
function renderIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const r = Math.round(size * 0.22);
  const cx = (size - 1) / 2, cy = (size - 1) / 2;
  const R1 = size * 0.28, R2 = size * 0.16;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5, py = y + 0.5;
      const i = (y * size + x) * 4;
      if (!insideRoundedRect(px, py, 0, 0, size - 1, size - 1, r)) { rgba[i + 3] = 0; continue; }
      const d = Math.hypot(px - cx, py - cy);
      const color = d <= R1 && d >= R2 ? WHITE : THEME;
      rgba[i] = color[0]; rgba[i + 1] = color[1]; rgba[i + 2] = color[2]; rgba[i + 3] = 255;
    }
  }
  return encodePng(size, rgba);
}

const favicon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect width="100" height="100" rx="22" fill="#173B62"/>
  <text x="50" y="54" text-anchor="middle" dominant-baseline="central" font-family="'Noto Sans TC','PingFang TC','Microsoft JhengHei','Heiti TC',sans-serif" font-size="40" font-weight="900" fill="#ffffff">雄中</text>
</svg>`;

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'favicon.svg'), favicon);
writeFileSync(join(OUT, 'icon-192.png'), renderIcon(192));
writeFileSync(join(OUT, 'icon-512.png'), renderIcon(512));
writeFileSync(join(OUT, 'apple-touch-icon.png'), renderIcon(180));
console.log('已產生 favicon.svg、icon-192.png、icon-512.png、apple-touch-icon.png');
