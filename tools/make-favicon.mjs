// make-favicon.mjs —— 从一张形状表生成 favicon.png 与 apple-touch-icon.png
//
// 为什么要脚本而不是直接放一张二进制图：项目零依赖，没有 ImageMagick / sharp，
// 而图标几何必须和手写的 favicon.svg 一模一样，否则两种格式会慢慢长得不像。
// 改这里的 SHAPES 之后：① 重跑本脚本生成两张 PNG ② 把同一份几何同步进 favicon.svg。
//
// 用法：  node tools/make-favicon.mjs
//
// 设计：蓝色渐变圆角底 + 一张评级板（Grading Slab）轮廓，金色是顶部标签区，
// 深蓝那块是板里的卡片。尺寸全部按 32 网格取整到 0.5，保证缩到 16px 还能看清
// ——16px 下 1 个网格单位只有 0.5 物理像素，细于 1 单位的线条会变成灰雾。

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { ROOT } from './lib.mjs';

// 32×32 设计网格。type 决定圆角怎么长：rect 四角同半径，caseTop 只有上面两角圆。
const SHAPES = [
  { type: 'rect', x: 0, y: 0, w: 32, h: 32, r: 7, grad: ['#3b82f6', '#1d4ed8'] },  // 底板
  { type: 'caseTop', x: 8.5, y: 5, w: 15, h: 22, r: 2.5, fill: '#ffffff' },        // 板体外框
  { type: 'caseTop', x: 8.5, y: 5, w: 15, h: 6, r: 2.5, fill: '#fbbf24' },          // 顶部标签区
  { type: 'rect', x: 11, y: 13.5, w: 9, h: 10.5, r: 1.5, fill: '#dbeafe' },      // 观察窗
  { type: 'rect', x: 12.5, y: 15, w: 6, h: 7.5, r: 1, fill: '#1d4ed8' },          // 窗里的卡片
];

const GRID = 32;

// ---------------------------------------------------------------- 画布

/** 简单 RGBA 画布，逐像素写，最后按行加过滤字节交给 zlib */
function canvas(size) {
  return { size, data: new Uint8Array(size * size * 4) };
}

const hex = (s) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];

/**
 * 该点是否落在形状里。圆角矩形用「把角切掉」的显式判定：
 * rect 四角都圆，caseTop 只圆上面两角（评级板的标签区就是上圆下方）。
 */
function inside(sh, gx, gy) {
  if (gx < sh.x || gx > sh.x + sh.w || gy < sh.y || gy > sh.y + sh.h) return false;
  const r = sh.r || 0;
  const out2 = (cx, cy) => Math.hypot(gx - cx, gy - cy) > r;   // 在该角区且超出半径 = 被切掉
  if (r > 0 && gy < sh.y + r && (out2(sh.x + r, sh.y + r) && gx < sh.x + r || out2(sh.x + sh.w - r, sh.y + r) && gx > sh.x + sh.w - r)) return false;
  if (sh.type === 'rect' && r > 0 && gy > sh.y + sh.h - r && (out2(sh.x + r, sh.y + sh.h - r) && gx < sh.x + r || out2(sh.x + sh.w - r, sh.y + sh.h - r) && gx > sh.x + sh.w - r)) return false;
  return true;
}

/**
 * 画一个形状：颜色可以是纯色 fill，也可以是从左上到右下的 grad 渐变。
 * 逐像素做 4×4 超采样算覆盖率，边缘就能抗锯齿；新颜色按覆盖率与原像素做 alpha 混合。
 */
function paint(c, sh, bleed) {
  const n = c.size;
  // 底板在 apple-touch-icon 上要铺满整张图：iOS 会自己裁圆角，透明角会变成白边
  const shape = bleed && sh === SHAPES[0] ? { ...sh, x: 0, y: 0, w: GRID, h: GRID, r: 0 } : sh;
  const flat = hex(shape.fill || shape.grad[0]);
  const to = shape.grad ? hex(shape.grad[1]) : null;
  for (let py = 0; py < n; py++) {
    for (let px = 0; px < n; px++) {
      let cover = 0;
      for (let sy = 0; sy < 4; sy++) {
        for (let sx = 0; sx < 4; sx++) {
          if (inside(shape, ((px + (sx + 0.5) / 4) / n) * GRID, ((py + (sy + 0.5) / 4) / n) * GRID)) cover++;
        }
      }
      if (!cover) continue;
      const a = cover / 16;
      let col = flat;
      if (to) {   // 渐变：按对角线位置在两色之间插值，与 SVG 的 x1y1→x2y2 一致
        const gx = (px + 0.5) / n * GRID, gy = (py + 0.5) / n * GRID;
        const t = Math.min(1, Math.max(0, (gx + gy) / (GRID * 1.4142136)));
        col = flat.map((v, i) => Math.round(v + (to[i] - v) * t));
      }
      const i = (py * n + px) * 4;
      const oa = c.data[i + 3] / 255;
      const na = a + oa * (1 - a);
      for (let k = 0; k < 3; k++) c.data[i + k] = Math.round((col[k] * a + c.data[i + k] * oa * (1 - a)) / (na || 1));
      c.data[i + 3] = Math.round(na * 255);
    }
  }
}

// ---------------------------------------------------------------- PNG 封装

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** 只写 RGBA、8 位深、逐行 filter 0，再整体 deflate —— 够用且完全无依赖 */
function encodePng(c) {
  const n = c.size;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(n, 0);
  ihdr.writeUInt32BE(n, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type: RGBA
  const raw = Buffer.alloc(n * (n * 4 + 1));
  for (let y = 0; y < n; y++) {
    raw[y * (n * 4 + 1)] = 0;                        // filter: none
    Buffer.from(c.data.buffer, y * n * 4, n * 4).copy(raw, y * (n * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- 产出

function build(size, bleed) {
  const c = canvas(size);
  for (const sh of SHAPES) paint(c, sh, bleed);
  return encodePng(c);
}

const out = [
  ['favicon.png', build(32, false)],
  ['apple-touch-icon.png', build(180, true)],
];
for (const [name, buf] of out) {
  const f = path.join(ROOT, name);
  fs.writeFileSync(f, buf);
  console.log(`  ${name.padEnd(22)} ${buf.length} 字节  ${f.replace(ROOT, '.')}`);
}
console.log('\n改过 SHAPES 之后记得把同一份几何同步进 favicon.svg。');
