'use strict';

// 生成应用图标（纯手写位图与 PNG 编码，不依赖任何第三方库）：
//   assets/chaogu.ico   多尺寸 Windows 图标（桌面快捷方式 / 安装包用）
//   assets/chaogu.png   256px PNG（Electron 窗口图标）
//   web/favicon.png     64px PNG（浏览器外壳的标签页图标）
// 图案：深色圆角底 + 顶部 K 线趋势 + 居中的 LYY 字标 + 底部蓝→红强调条。
// 用法: node scripts/make-icon.js

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const ASSET_DIR = path.join(ROOT, 'assets');
const WEB_DIR = path.join(ROOT, 'web');
const ICO_FILE = path.join(ASSET_DIR, 'chaogu.ico');
const PNG_FILE = path.join(ASSET_DIR, 'chaogu.png');
const FAVICON_FILE = path.join(WEB_DIR, 'favicon.png');

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const SS = 4; // 超采样倍数，用来做抗锯齿

function mix(a, b, t) {
  const k = Math.max(0, Math.min(1, t));
  return [
    Math.round(a[0] + (b[0] - a[0]) * k),
    Math.round(a[1] + (b[1] - a[1]) * k),
    Math.round(a[2] + (b[2] - a[2]) * k),
  ];
}

const BG_TOP = [16, 23, 36];
const BG_BOTTOM = [26, 37, 55];
const BORDER = [58, 78, 112];
const LINE = [79, 140, 255];
const UP = [240, 69, 58];
const DOWN = [33, 181, 115];
const TEXT = [242, 246, 255];

// 归一化坐标下判断点是否落在圆角矩形里
function insideRoundRect(x, y, r) {
  const cx = Math.min(Math.max(x, r), 1 - r);
  const cy = Math.min(Math.max(y, r), 1 - r);
  const dx = x - cx;
  const dy = y - cy;
  if (dx === 0 && dy === 0) return true;
  const inCornerBox = (x < r || x > 1 - r) && (y < r || y > 1 - r);
  if (!inCornerBox) return true;
  return Math.hypot(dx, dy) <= r;
}

function segmentDistance(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

// ---------------------------------------------------------------- LYY 字标
// 笔画式字母：局部坐标 y 0..1 = 字高，x 以字高为单位，圆头笔画。
const CAP = 0.27;         // 字高（归一化）
const STROKE = 0.058;     // 笔画粗细（归一化）
const TEXT_TOP = 0.415;   // 字标顶部
const LETTER_GAP = 0.22;  // 字距（以字高为单位）
const HALF = STROKE / CAP / 2;

const LETTER_Y = [
  [[HALF, HALF], [0.40, 0.62]],
  [[0.80 - HALF, HALF], [0.40, 0.62]],
  [[0.40, 0.62], [0.40, 1 - HALF]],
];

const LETTERS = [
  {
    w: 0.62,
    strokes: [
      [[HALF, HALF], [HALF, 1 - HALF]],
      [[HALF, 1 - HALF], [0.62 - HALF, 1 - HALF]],
    ],
  },
  { w: 0.80, strokes: LETTER_Y },
  { w: 0.80, strokes: LETTER_Y },
];

// 把字母笔画换算到画布坐标
const TEXT_SEGMENTS = (() => {
  const widths = LETTERS.map((l) => l.w * CAP);
  const total = widths.reduce((a, b) => a + b, 0) + LETTER_GAP * CAP * (LETTERS.length - 1);
  let x = (1 - total) / 2;
  const segs = [];
  LETTERS.forEach((letter, i) => {
    for (const [[ax, ay], [bx, by]] of letter.strokes) {
      segs.push([x + ax * CAP, TEXT_TOP + ay * CAP, x + bx * CAP, TEXT_TOP + by * CAP]);
    }
    x += widths[i] + LETTER_GAP * CAP;
  });
  return segs;
})();

function inText(x, y) {
  const half = STROKE / 2;
  for (const [x1, y1, x2, y2] of TEXT_SEGMENTS) {
    if (segmentDistance(x, y, x1, y1, x2, y2) <= half) return true;
  }
  return false;
}

// 单点采样（归一化坐标 0..1，y 向下），返回 [r,g,b,a]
function shade(x, y) {
  if (x < 0 || x > 1 || y < 0 || y > 1) return [0, 0, 0, 0];
  const r = 0.18;
  if (!insideRoundRect(x, y, r)) return [0, 0, 0, 0];

  let color = mix(BG_TOP, BG_BOTTOM, y);

  // 外圈描边
  if (!insideRoundRect(x, y, r * 0.78) && (x < 0.09 || x > 0.91 || y < 0.09 || y > 0.91)) {
    color = mix(color, BORDER, 0.55);
  }

  // 顶部：一红一绿两根小 K 线
  const sticks = [
    { cx: 0.21, bodyTop: 0.20, bodyBottom: 0.30, wickTop: 0.15, wickBottom: 0.34, c: UP },
    { cx: 0.34, bodyTop: 0.24, bodyBottom: 0.32, wickTop: 0.19, wickBottom: 0.35, c: DOWN },
  ];
  for (const s of sticks) {
    if (segmentDistance(x, y, s.cx, s.wickTop, s.cx, s.wickBottom) <= 0.017) color = s.c;
    if (Math.abs(x - s.cx) <= 0.036 && y >= s.bodyTop && y <= s.bodyBottom) color = s.c;
  }

  // 顶部：向上的趋势线
  const pts = [
    [0.17, 0.30],
    [0.36, 0.20],
    [0.53, 0.26],
    [0.70, 0.15],
    [0.84, 0.21],
  ];
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i += 1) {
    best = Math.min(best, segmentDistance(x, y, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]));
  }
  if (best <= 0.024) {
    color = mix(color, LINE, best > 0.015 ? 0.6 : 1);
  }

  // 底部：蓝 → 红强调条
  const barY = 0.785;
  const barHalf = 0.023;
  if (segmentDistance(x, y, 0.375, barY, 0.625, barY) <= barHalf) {
    color = mix(LINE, UP, (x - 0.375) / 0.25);
  }

  // LYY 字标压在最上层
  if (inText(x, y)) color = TEXT;

  return [color[0], color[1], color[2], 255];
}

// 超采样求平均：先按覆盖率加权平均颜色，再单独输出覆盖率作为 alpha，
// 这样边缘不会出现发黑的描边。
function sampleColor(u, v, size) {
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;
  let weight = 0;
  for (let sy = 0; sy < SS; sy += 1) {
    for (let sx = 0; sx < SS; sx += 1) {
      const x = u + (sx + 0.5) / SS / size;
      const y = v + (sy + 0.5) / SS / size;
      const c = shade(x, y);
      r += c[0] * c[3];
      g += c[1] * c[3];
      b += c[2] * c[3];
      a += c[3];
      weight += c[3];
    }
  }
  if (weight === 0) return [0, 0, 0, 0];
  return [r / weight, g / weight, b / weight, a / (SS * SS)];
}

function clamp255(v) {
  return Math.max(0, Math.min(255, Math.round(v)));
}

// RGBA 像素缓冲，自上而下（PNG 用）
function renderRgba(size) {
  const px = Buffer.alloc(size * size * 4);
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      const [r, g, b, a] = sampleColor((col + 0.5) / size, (row + 0.5) / size, size);
      const off = (row * size + col) * 4;
      px[off] = clamp255(r);
      px[off + 1] = clamp255(g);
      px[off + 2] = clamp255(b);
      px[off + 3] = clamp255(a);
    }
  }
  return px;
}

// 32bpp BMP 数据，自下而上（ICO 用）
function buildImage(size) {
  const xor = Buffer.alloc(size * size * 4);
  for (let row = 0; row < size; row += 1) {
    const y = 1 - (row + 0.5) / size;
    for (let col = 0; col < size; col += 1) {
      const [r, g, b, a] = sampleColor((col + 0.5) / size, y, size);
      const off = (row * size + col) * 4;
      xor[off] = clamp255(b);
      xor[off + 1] = clamp255(g);
      xor[off + 2] = clamp255(r);
      xor[off + 3] = clamp255(a);
    }
  }
  // AND 掩码：32bpp 下可以全 0，但必须存在，每行按 4 字节对齐
  const maskRow = Math.ceil(size / 32) * 4;
  const mask = Buffer.alloc(maskRow * size);

  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0); // biSize
  header.writeInt32LE(size, 4); // biWidth
  header.writeInt32LE(size * 2, 8); // biHeight（含掩码）
  header.writeUInt16LE(1, 12); // biPlanes
  header.writeUInt16LE(32, 14); // biBitCount
  header.writeUInt32LE(0, 16); // biCompression = BI_RGB
  header.writeUInt32LE(xor.length + mask.length, 20); // biSizeImage
  return Buffer.concat([header, xor, mask]);
}

function buildIco(images) {
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2); // type = icon
  dir.writeUInt16LE(images.length, 4);

  const entries = [];
  let offset = 6 + images.length * 16;
  for (const img of images) {
    const e = Buffer.alloc(16);
    e.writeUInt8(img.size >= 256 ? 0 : img.size, 0);
    e.writeUInt8(img.size >= 256 ? 0 : img.size, 1);
    e.writeUInt8(0, 2);
    e.writeUInt8(0, 3);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(img.data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += img.data.length;
    entries.push(e);
  }
  return Buffer.concat([dir, ...entries, ...images.map((i) => i.data)]);
}

// ------------------------------------------------------------- PNG 编码器
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, pixels) {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let row = 0; row < size; row += 1) {
    raw[row * (stride + 1)] = 0; // filter: none
    pixels.copy(raw, row * (stride + 1) + 1, row * stride, (row + 1) * stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ------------------------------------------------------------------- 输出
fs.mkdirSync(ASSET_DIR, { recursive: true });
fs.mkdirSync(WEB_DIR, { recursive: true });

const ico = buildIco(ICO_SIZES.map((size) => ({ size, data: buildImage(size) })));
fs.writeFileSync(ICO_FILE, ico);
fs.writeFileSync(PNG_FILE, encodePng(256, renderRgba(256)));
fs.writeFileSync(FAVICON_FILE, encodePng(64, renderRgba(64)));

console.log('图标已生成:');
console.log(`  ${ICO_FILE}（${ICO_SIZES.join('/')} px，${ico.length} 字节）`);
console.log(`  ${PNG_FILE}（256 px，${fs.statSync(PNG_FILE).size} 字节）`);
console.log(`  ${FAVICON_FILE}（64 px，${fs.statSync(FAVICON_FILE).size} 字节）`);
