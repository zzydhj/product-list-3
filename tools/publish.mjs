// publish.mjs —— 组装上线目录 dist/
//
// 用法：  node tools/publish.mjs
//
// 为什么要有这一步：仓库里同时存在后台（tools/）、数据（products.json / sites.json）、
// 备份页（product-catalog.backup.html）和迁移快照（tools/baseline/）。
// 若把仓库根直接当部署目录，这些全都会被公开 —— 而你要的是「上线后必须是干净的」。
// 所以只把 sites.json 里登记过的页面 + 它们各自用到的静态资源 + 根级两个文件放进 dist/，
// 其余一律不进部署目录。Cloudflare Pages 的输出目录填 dist 即可。

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, TOOLS, FORBIDDEN_OUTPUT } from './lib.mjs';
import { sitesFrom } from './store.mjs';

const OUT = path.join(ROOT, 'dist');

// ---------------------------------------------------------------- 1) 先生成成品页

const b = spawnSync(process.execPath, [path.join(TOOLS, 'build.mjs')], { cwd: ROOT, encoding: 'utf8' });
process.stdout.write(b.stdout || '');
if (b.stderr) process.stderr.write(b.stderr);
if (b.status !== 0) { console.error('[中止] 生成失败，dist 未产出'); process.exit(1); }

// ---------------------------------------------------------------- 2) 清空重建

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const copied = [];
const missing = [];

/** 按白名单把仓库里的相对路径搬进 dist，保持同样的相对层级 */
function put(rel) {
  const from = path.join(ROOT, rel.split('/').join(path.sep));
  if (!fs.existsSync(from)) { missing.push(rel); return; }
  const to = path.join(OUT, rel.split('/').join(path.sep));
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true });
  copied.push(rel);
}

const sites = sitesFrom();
for (const s of sites) {
  const dir = s.file.includes('/') ? s.file.slice(0, s.file.lastIndexOf('/')) : '.';
  put(s.file);                              // 页面本体
  put(`${dir}/tailwind.css`);               // 该页自己的样式副本（HTML 用相对路径引用）
  put(`${dir}/vendor`);                     // Font Awesome 字体
}
// 根级静态资源：页面里用绝对路径引它们，必须与页面同层放进 dist
for (const rel of ['_redirects', 'favicon.svg', 'favicon.png', 'apple-touch-icon.png']) put(rel);

// ---------------------------------------------------------------- 3) 自检：dist 里不该有任何后台痕迹

const FORBIDDEN_IN_NAME = /(\.mjs$|\.bak-|products\.json$|sites\.json$|baseline|after-import|admin|\.backup\.html$|\.gitignore$|tools[\\/])/;
// 黑名单文本规则与 check.mjs 共用 lib.mjs 里同一张表，避免两处各自演化
const FORBIDDEN_IN_TEXT = FORBIDDEN_OUTPUT;

function walk(dir, base = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(path.join(dir, e.name), rel));
    else out.push({ rel, abs: path.join(dir, e.name) });
  }
  return out;
}

const files = walk(OUT);
const problems = [];

for (const f of files) {
  if (FORBIDDEN_IN_NAME.test(f.rel)) problems.push(`文件名可疑：${f.rel}`);
}
for (const f of files.filter((x) => /\.(html|css|js)$/i.test(x.rel))) {
  const text = fs.readFileSync(f.abs, 'utf8');
  const hits = FORBIDDEN_IN_TEXT.filter((re) => re.test(text));
  if (hits.length) problems.push(`${f.rel} 含禁止字样：${hits.map(String).join(' , ')}`);
}

// ---------------------------------------------------------------- 4) 汇总

const bytes = files.reduce((n, f) => n + fs.statSync(f.abs).size, 0);
console.log(`\ndist/ 已产出：${files.length} 个文件，${(bytes / 1024).toFixed(0)} KB`);
for (const s of sites) {
  const dir = s.file.includes('/') ? s.file.slice(0, s.file.lastIndexOf('/')) : '.';
  const own = files.filter((f) => f.rel === s.file || f.rel.startsWith(`${dir}/`));
  console.log(`  ${String(s.key).padEnd(12)} ${String(own.length).padStart(3)} 个文件  ${s.file}`);
}
const rootFiles = files.filter((f) => !f.rel.includes('/'));
console.log(`  根级文件     ${rootFiles.length} 个  ${rootFiles.map((f) => f.rel).join(', ')}`);

if (missing.length) {
  console.log(`\n[提示] 白名单里登记但仓库中不存在的路径（未拷贝）：\n  ${missing.join('\n  ')}`);
}
if (problems.length) {
  console.log('\n[失败] dist 内容不干净：');
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(1);
}
console.log('\n[ok] dist 内无任何后台 / 工具 / 备份文件，可直接作为部署输出目录');
