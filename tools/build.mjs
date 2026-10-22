// build.mjs —— 单一数据源生成器
//
// 用法：
//   node tools/build.mjs            生成并写盘
//   node tools/build.mjs --check    只在内存里生成并与现有文件比对，不写盘；
//                                   只要有任何一个产物与当前数据不同步就 exit 1
//   node tools/build.mjs --restore   回滚专用：只放宽「页面独有内容」这一条护栏（见下）
//   node tools/build.mjs --force    忽略校验错误继续（仅用于排查）
//
// 只重写 GEN 标记区内的内容；标记区以外的字节原样保留。

import fs from 'node:fs';
import path from 'node:path';
import {
  ROOT, TOOLS, readFileLines, writeFileLines, locateRegion, regionContent,
  ensureMarkers, indentOf,
  emitProducts, emitGroupMap, emitPromo, emitDisabled, emitStorage, emitWatermark,
  emitSitePatch, sitePatchOf,
  emitTitle, parseTitle,
  parseGroupMap, parseJsObjectBlock, parseProducts, groupLeafNames, effectiveIds, siteProductsOpts,
  validate, normalizeCfg,
} from './lib.mjs';

const CHECK = process.argv.includes('--check');
const FORCE = process.argv.includes('--force');
/**
 * 回滚专用。回滚把主数据换回旧版后，页面里必然还留着「刚被退掉的那些型号」，
 * 它们在主数据里查不到——看起来和「有人沿旧习惯直接往 HTML 里加产品」一模一样。
 * 护栏照原样拦就会把一次正常回滚拦成「生成中止」，留下数据是旧的、页面是新的
 * 这种最难察觉的半吊子状态（dist 又因为是旧版而看着正常）。所以这里只放宽这一条
 * 护栏，并且把丢了哪些型号大声打出来；数据本身的校验错误仍然致命。
 */
const RESTORE = process.argv.includes('--restore');

function loadJson(name, optional = false, fallback = null) {
  const p = path.join(TOOLS, name);
  if (!fs.existsSync(p)) {
    if (optional) return fallback;
    console.error(`[中止] 缺少 tools/${name}，请先运行 node tools/import.mjs`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

const products = loadJson('products.json').products;
const sitesDoc = loadJson('sites.json');
const sites = sitesDoc.sites;

// ---------------------------------------------------------------- 校验

const errors = validate(products, sites);
if (errors.length) {
  console.log(`\n校验发现 ${errors.length} 个问题：`);
  for (const e of errors.slice(0, 40)) console.log(`  - ${e.msg}`);
  if (errors.length > 40) console.log(`  ... 其余 ${errors.length - 40} 条`);
  if (!FORCE) { console.error('\n[中止] 修正数据后重试，或加 --force 强行生成'); process.exit(1); }
  console.log('\n(--force) 忽略以上问题继续生成');
}

// ---------------------------------------------------------------- 透传判定
// 配置区在数值未被改动时原样输出「迁移时」的文本，保证产物与今日逐字节一致；
// 一旦后台改过配置，则按规范格式重写（注释由生成器内置）。
// 基准必须取自 site.raw（迁移原文快照）而不是文件当前内容：否则第一次改配置后
// 区块就永久停在生成器排版上，之后哪怕把值改回去也恢复不了当初的注释与空格。

function pick(rawLines, parsedEqualNow, canonical) {
  if (!rawLines) return canonical;
  return parsedEqualNow(rawLines) ? rawLines : canonical;
}

/** 配置区语义是否等价：忽略键顺序、注释、空格排版，只比数值本身 */
function cfgEqual(baseLines, cfg) {
  return JSON.stringify(normalizeCfg(parseJsObjectBlock(baseLines)))
    === JSON.stringify(normalizeCfg(cfg));
}

function idsFromLine(lines) {
  const text = (lines || []).join('');
  return [...text.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1]);
}

function keyFromLine(lines) {
  const m = /'([^']*)'/.exec((lines || []).join(''));
  return m ? m[1] : null;
}

// ---------------------------------------------------------------- 逐站点生成

/**
 * 上一轮生成往每个页面里写了哪些型号。
 * 没有这份名单，护栏分不开两种长得一模一样的情况：
 *   人直接往 HTML 里加了产品（必须拦住，不然一扫就没了）
 *   上一次保存自己写进去的型号，这次被人在后台删了（必须放行，不然就永久卡住）
 * 第二种是真的会发生的：新增一个型号→保存→数字锚点报红（本来就该报，等你确认）
 * →反悔删掉→再保存，就会被当成第一种拦下，而界面上没有 --force，用户自救不了。
 */
const PREV_FILE = path.join(TOOLS, 'last-build.json');
let lastGen = {};
try {
  lastGen = JSON.parse(fs.readFileSync(PREV_FILE, 'utf8'));
} catch {
  lastGen = {};   // 第一次跑、或这份记录被删过：不知道上次写了什么，保守起见一律当「手改」
}
const genIds = {};

const report = [];
// --check 发现的差异：收集文件名，末尾据此置错退出码
const checkDiff = [];

for (const site of sites) {
  const abs = path.join(ROOT, site.file);
  if (!fs.existsSync(abs)) scaffold(site);
  const { lines, eol } = readFileLines(abs);

  let cur = lines;
  const changes = [];

  // ---- TITLE
  {
    const at = regionAt(cur, 'TITLE');
    cur = at.lines;
    const loc = at.loc;
    const orig = regionContent(cur, loc);
    const canonical = emitTitle(site.title, indentOf(cur[loc.begin + 1]));
    const content = pick(site.raw && site.raw.TITLE, (base) => parseTitle(base.join('\n')) === site.title, canonical);
    changes.push(['TITLE', orig, content]);
    cur = replaceBetween(cur, loc, content);
  }

  // ---- PRODUCTS
  {
    const at = regionAt(cur, 'PRODUCTS');
    cur = at.lines;
    const loc = at.loc;

    // 护栏：区段里出现「主数据没登记的型号」，分两种（见上面 lastGen 的说明）
    const here = parseProducts(regionContent(cur, loc)).rows;
    const known = new Set(products.map((p) => p.id));
    const handAdded = here.filter((r) => !known.has(r.id));
    const lastTime = new Set(lastGen[site.file] || []);
    const ours = handAdded.filter((r) => lastTime.has(r.id));       // 上次生成器自己写的
    const human = handAdded.filter((r) => !lastTime.has(r.id));     // 真的只有页面里有
    if (ours.length) {
      console.error(`\n[注意] ${site.file}：${ours.length} 个型号只在页面里、主数据已没有，是上一轮生成写进去的，按主数据丢弃：`);
      for (const o of ours.slice(0, 10)) console.error(`        ${o.id}   ${o.name}`);
      if (ours.length > 10) console.error(`        ...其余 ${ours.length - 10} 条`);
      console.error('        （后台里删掉的产品走到这一步就该被抹掉，这里不需要你做任何事）');
    }
    if (human.length) {
      const drop = RESTORE || FORCE;
      console.error(`\n${RESTORE ? '[注意]' : drop ? '[警告]' : '[中止]'} ${site.file}：有 ${human.length} 条只写在页面里、主数据没登记的型号，生成会把它们抹掉：`);
      for (const o of human.slice(0, 10)) console.error(`        ${o.id}   ${o.name}`);
      if (human.length > 10) console.error(`        ...其余 ${human.length - 10} 条`);
      if (RESTORE) {
        console.error('        (--restore) 这是回滚：主数据已换回旧版，页面里这些是刚被退掉的条目，按主数据丢弃');
      } else {
        console.error('        要保留：先在后台「＋新增产品」把这些型号登记进去；');
        console.error('        确定可以丢：重跑一次加上 --force');
        if (!drop) process.exit(1);
        console.error('\n(--force) 忽略这些手工条目，按主数据覆盖区段');
      }
    }

    // 画册站的成员范围与排除表跟随 owner 选款站；没配 owner 时退回旧行为（用自身定义）
    const owner = site.type === 'catalog' && site.owner ? sites.find((x) => x.key === site.owner) : null;
    const content = emitProducts(products, siteProductsOpts(site, products, owner));
    genIds[site.file] = parseProducts(content).rows.map((r) => r.id);
    changes.push(['PRODUCTS', regionContent(cur, loc), content]);
    cur = replaceBetween(cur, loc, content);
  }

  // ---- GROUPMAP
  if (site.type === 'form') {
    const at = regionAt(cur, 'GROUPMAP');
    cur = at.lines;
    const loc = at.loc;
    const orig = regionContent(cur, loc);
    const canonical = emitGroupMap(site.groups);
    const content = pick(site.raw && site.raw.GROUPMAP,
      (base) => sameGroups(parseGroupMap(base), site.groups), canonical);
    changes.push(['GROUPMAP', orig, content]);
    cur = replaceBetween(cur, loc, content);
  }

  // ---- PROMO
  if (site.type === 'form') {
    const at = regionAt(cur, 'PROMO');
    cur = at.lines;
    const loc = at.loc;
    const orig = regionContent(cur, loc);
    const canonical = emitPromo(site.promo);
    const content = pick(site.raw && site.raw.PROMO, (base) => cfgEqual(base, site.promo), canonical);
    changes.push(['PROMO', orig, content]);
    cur = replaceBetween(cur, loc, content);
  }

  // ---- DISABLED
  if (site.type === 'form') {
    const at = regionAt(cur, 'DISABLED');
    cur = at.lines;
    const loc = at.loc;
    const orig = regionContent(cur, loc);
    const leafSet = new Set(groupLeafNames(site.groups));
    const ids = effectiveIds(products, {
      surface: 'form', filterToGroups: Boolean(site.filterToGroups), leafSet, overrides: site.overrides || {},
    }).filter((id) => {
      const p = products.find((x) => x.id === id);
      const ov = (site.overrides || {})[id];
      return ((ov && ov.form) || p.form) === 'disabled';
    });
    const canonical = emitDisabled(ids);
    const content = pick(site.raw && site.raw.DISABLED, (base) => sameSet(idsFromLine(base), ids), canonical);
    changes.push(['DISABLED', orig, content]);
    cur = replaceBetween(cur, loc, content);
  }

  // ---- SITEPATCH（只有选款页有：产品行只写产品库默认值，本站差异集中到这一块）
  // 发射经 sitePatchOf，与页面运行时的 Object.assign 是同一张表：两边算法不同的话，
  // 页面上看的与产品库定的就会两套口径，而这不会报错，只会默默算错。
  if (site.type === 'form') {
    const at = regionAt(cur, 'SITEPATCH');
    cur = at.lines;
    const loc = at.loc;
    const orig = regionContent(cur, loc);
    const opts = siteProductsOpts(site, products);
    const canonical = emitSitePatch(sitePatchOf(products, opts), products,
      indentOf(cur[loc.begin + 1]) || '        ');
    changes.push(['SITEPATCH', orig, canonical]);
    cur = replaceBetween(cur, loc, canonical);
  }

  // ---- STORAGE
  if (site.type === 'form') {
    const at = regionAt(cur, 'STORAGE');
    cur = at.lines;
    const loc = at.loc;
    const orig = regionContent(cur, loc);
    const content = pick(site.raw && site.raw.STORAGE,
      (base) => keyFromLine(base) === site.storageKey, emitStorage(site.storageKey));
    changes.push(['STORAGE', orig, content]);
    cur = replaceBetween(cur, loc, content);
  }

  // ---- WATERMARK
  if (site.type === 'catalog') {
    const at = regionAt(cur, 'WATERMARK');
    cur = at.lines;
    const loc = at.loc;
    const orig = regionContent(cur, loc);
    const canonical = emitWatermark(site.watermark);
    const content = pick(site.raw && site.raw.WATERMARK, (base) => cfgEqual(base, site.watermark), canonical);
    changes.push(['WATERMARK', orig, content]);
    cur = replaceBetween(cur, loc, content);
  }

  const changedRegions = changes.filter(([, a, b]) => !sameLines(a, b));
  report.push({ site: site.key, file: site.file, changed: changedRegions.map((r) => r[0]), lines: cur.length });

  if (CHECK) {
    if (!sameLines(lines, cur)) {
      checkDiff.push(site.file);
      const d = firstDiff(lines, cur);
      console.log(`[check] ${site.file} 会有变化：区段 ${changedRegions.map((r) => r[0]).join(',') || '-'}`);
      if (d) console.log(`        第 ${d.i + 1} 行\n        现: ${JSON.stringify(d.a)}\n        新: ${JSON.stringify(d.b)}`);
    } else {
      console.log(`[check] ${site.file} 零变化`);
    }
    continue;
  }

  writeFileLines(abs, cur, eol);
}

function replaceBetween(lines, loc, content) {
  return [...lines.slice(0, loc.begin + 1), ...content, ...lines.slice(loc.end)];
}

/**
 * 定位区段，未托管则现场补上标记。
 * 这让托管区可以增量扩展（比如后来加的 TITLE）而不必重跑 import 去改主数据。
 */
function regionAt(lines, name) {
  let loc = locateRegion(lines, name);
  if (loc.marked) return { lines, loc };
  const marked = ensureMarkers(lines, name, loc);
  return { lines: marked, loc: locateRegion(marked, name) };
}

/** 新建摘取型站点：从模板克隆页面，并补齐静态资源 */
function scaffold(site) {
  const tplKey = site.template || 'card-holder';
  const tpl = sites.find((s) => s.key === tplKey);
  if (!tpl) throw new Error(`模板站点 ${tplKey} 不存在`);
  const srcAbs = path.join(ROOT, tpl.file);
  if (!fs.existsSync(srcAbs)) throw new Error(`模板文件缺失：${tpl.file}`);
  const dstAbs = path.join(ROOT, site.file);
  fs.mkdirSync(path.dirname(dstAbs), { recursive: true });
  fs.copyFileSync(srcAbs, dstAbs);
  // tailwind.css 与字体目录直接复用模板站点的（都是成品静态资源）
  for (const rel of ['tailwind.css']) {
    const from = path.join(ROOT, path.dirname(tpl.file), rel);
    const to = path.join(ROOT, path.dirname(site.file), rel);
    if (fs.existsSync(from) && !fs.existsSync(to)) fs.copyFileSync(from, to);
  }
  const vendorFrom = path.join(ROOT, path.dirname(tpl.file), 'vendor');
  const vendorTo = path.join(ROOT, path.dirname(site.file), 'vendor');
  if (fs.existsSync(vendorFrom) && !fs.existsSync(vendorTo)) fs.cpSync(vendorFrom, vendorTo, { recursive: true });
  console.log(`  新建站点 ${site.key}：已从 ${tpl.file} 克隆 ${site.file}`);
}

function sameLines(a, b) {
  return a.length === b.length && a.every((l, i) => l === b[i]);
}
function sameSet(a, b) {
  const s1 = [...new Set(a)].sort(), s2 = [...new Set(b)].sort();
  return JSON.stringify(s1) === JSON.stringify(s2);
}
function sameGroups(parsedFrom, cfgGroups) {
  const norm = (gs) => gs.map((g) => ({ name: g.name, entries: (g.entries || []).map((e) => typeof e === 'string' ? e : { name: e.name, children: e.children }) }));
  return JSON.stringify(norm(parsedFrom)) === JSON.stringify(norm(cfgGroups));
}
function firstDiff(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) return { i, a: a[i], b: b[i] };
  }
  return null;
}

// ---------------------------------------------------------------- 汇总

console.log('');
for (const r of report) {
  console.log(`  ${String(r.site).padEnd(12)} ${r.file.padEnd(36)} ${r.lines} 行  ${r.changed.length ? '重写区段: ' + r.changed.join(', ') : '全部区段零变化'}`);
}
const counts = {
  form: products.filter((p) => p.form === 'normal').length,
  disabled: products.filter((p) => p.form === 'disabled').length,
  hidden: products.filter((p) => p.form === 'hidden').length,
};
console.log(`\n主数据 ${products.length} 条：正常 ${counts.form} / 置灰 ${counts.disabled} / 选款表隐藏 ${counts.hidden}`);
// 画册归属已经是站点属性、不再是产品字段，所以按本报数，不给一个“全局画册数”
const albums = sites.filter((s) => s.type === 'catalog');
if (albums.length) {
  console.log('各本画册生效条数：' + albums.map((a) => {
    const owner = sites.find((x) => x.key === a.owner);
    return `${a.key} ${effectiveIds(products, siteProductsOpts(a, products, owner)).length}`;
  }).join(' / '));
}
console.log(CHECK ? '(--check) 未写盘' : '已写盘');

// 记下这一轮往每个页面里写了哪些型号，下一轮护栏据此区分「我们自己写的」与「人手加的」。
// 纯派生文件，不进版本库；删掉它只会让护栏退回「一律当手改」的保守行为。
if (!CHECK) fs.writeFileSync(PREV_FILE, JSON.stringify(genIds));

// 发现差异却 exit 0，会让“只看退出码”的脚本与我把过期产物误判成通过；
// 与 check.mjs 的行为对齐：产物与数据不同步就是失败。
if (CHECK && checkDiff.length) {
  console.error(`[中止] ${checkDiff.length} 个产物与当前数据不同步（需跑 node tools/build.mjs 写盘）：${checkDiff.join(', ')}`);
  process.exit(1);
}
