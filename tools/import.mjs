// import.mjs —— 一次性迁移：从三个现有页面抽取数据，生成单一数据源
//
// 用法：  node tools/import.mjs [--dry]
//
// 做四件事：
//   1. 把三个页面原样快照到 tools/baseline/（diff 基准，永不改动）
//   2. 定位数据区，在页面中插入 GEN 标记（幂等）
//   3. 解析出 tools/products.json 与 tools/sites.json
//   4. 语义自证：每个文件里每一条产品行（型号/名称/分类/图/是否注释）必须与主数据一一对应
//
// 关键：form / catalog 两个开关的初值完全照搬现状，本次迁移不改变任何一个型号的可见性。
// 说明：区段内的空行不保留（三个文件各自随手空行、互不一致），分节注释则改为挂在产品上统一还原。

import fs from 'node:fs';
import path from 'node:path';
import {
  ROOT, TOOLS, readFileLines, writeFileLines, locateRegion, ensureMarkers, regionContent,
  parseProducts, parseGroupMap, parseJsObjectBlock, dominantIndent, emitProducts,
  siteProductsOpts, groupLeafNames, MARK, MARK_END, parseTitle,
} from './lib.mjs';

const DRY = process.argv.includes('--dry');

const TARGETS = [
  { key: 'card-holder', file: 'card-holder/index.html', type: 'form' },
  { key: 'TPU', file: 'TPU/index.html', type: 'form' },
  { key: 'catalog', file: 'card-holder/product-catalog.html', type: 'catalog' },
];

function log(...a) { console.log(...a); }
function die(msg) { console.error('\n[中止] ' + msg); process.exit(1); }

// ---------------------------------------------------------------- 1. 快照

const baselineDir = path.join(TOOLS, 'baseline');
fs.mkdirSync(baselineDir, { recursive: true });
for (const t of TARGETS) {
  const src = path.join(ROOT, t.file);
  if (!fs.existsSync(src)) die(`找不到 ${t.file}`);
  const dst = path.join(baselineDir, `${t.key}.html`);
  if (!fs.existsSync(dst)) fs.copyFileSync(src, dst);
  log(`快照  ${t.file}  ->  tools/baseline/${t.key}.html`);
}

// ---------------------------------------------------------------- 2+3. 解析

const parsed = {};

for (const t of TARGETS) {
  const file = path.join(ROOT, t.file);
  const { lines, eol } = readFileLines(file);
  const names = t.type === 'form'
    ? ['TITLE', 'PROMO', 'PRODUCTS', 'DISABLED', 'GROUPMAP', 'STORAGE']
    : ['TITLE', 'WATERMARK', 'PRODUCTS'];

  const regions = {};
  for (const n of names) {
    const loc = locateRegion(lines, n);
    regions[n] = { ...loc, content: regionContent(lines, loc) };
  }
  // 逐个区段插入标记；每次插入都会改变下标，因此每次都重新定位
  let marked = lines;
  for (const n of names) {
    marked = ensureMarkers(marked, n, locateRegion(marked, n));
  }

  const { rows } = parseProducts(regions.PRODUCTS.content);
  parsed[t.key] = {
    file, eol, lines, marked, regions, rows,
    indent: dominantIndent(rows),
    cfg: {},
  };

  if (t.type === 'form') {
    parsed[t.key].cfg.promo = parseJsObjectBlock(regions.PROMO.content);
    parsed[t.key].cfg.groups = parseGroupMap(regions.GROUPMAP.content);
    const storageLine = regions.STORAGE.content.length ? regions.STORAGE.content.join('') : regions.STORAGE.anchorLine;
    const m1 = /'([^']*)'/.exec(storageLine);
    if (!m1) die(`${t.key}: STORAGE_KEY 行解析失败`);
    parsed[t.key].cfg.storageKey = m1[1];
    const disabledLine = regions.DISABLED.content.length ? regions.DISABLED.content.join('') : regions.DISABLED.anchorLine;
    parsed[t.key].cfg.disabled = [...disabledLine.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((q) => q[1]);
  } else {
    parsed[t.key].cfg.watermark = parseJsObjectBlock(regions.WATERMARK.content);
  }
}

// ---------------------------------------------------------------- 4. 语义自证 + 合并主数据

const master = [];
const byId = new Map();
const membership = { 'card-holder': new Set(), TPU: new Set(), catalog: new Set() };

for (const t of TARGETS) {
  for (const r of parsed[t.key].rows) {
    if (!byId.has(r.id)) {
      const rec = {
        id: r.id, name: r.name, category: r.category, image: r.image,
        notes: r.notes, form: 'normal', catalog: true, states: {},
      };
      byId.set(r.id, rec);
      master.push(rec);
    } else {
      const rec = byId.get(r.id);
      for (const f of ['name', 'category', 'image']) {
        if (rec[f] !== r[f]) die(`${r.id} 的 ${f} 在 ${t.key} 与主数据不一致：${JSON.stringify(rec[f])} vs ${JSON.stringify(r[f])}`);
      }
      if (!rec.notes.length && r.notes.length) rec.notes = r.notes;
    }
    rec_states(byId.get(r.id), t.key, r.commented);
    membership[t.key].add(r.id);
  }
}
function rec_states(rec, key, commented) { rec.states[key] = commented ? 'commented' : 'live'; }

const disabledSet = new Set(parsed['card-holder'].cfg.disabled);
for (const p of master) {
  const ch = p.states['card-holder'];
  const cat = p.states['catalog'];
  p.form = ch === 'commented' ? 'hidden' : (disabledSet.has(p.id) ? 'disabled' : 'normal');
  p.catalog = cat ? cat !== 'commented' : true;
  // 停用名单里的 id 必须是生效行，否则这条配置是空转
  if (disabledSet.has(p.id) && ch !== 'live') die(`${p.id} 被登记为停用，但在选款表里并非生效行，配置空转`);
}

// 顺序一致性：TPU 与画册都必须是主序的递增子序列，否则需要各自保存顺序
for (const key of ['TPU', 'catalog']) {
  const pos = new Map(master.map((p, i) => [p.id, i]));
  let last = -1;
  for (const r of parsed[key].rows) {
    const i = pos.get(r.id);
    if (i === undefined) die(`${key} 存在主数据没有的 id: ${r.id}`);
    if (i < last) die(`${key} 的产品顺序与 card-holder 不一致（${r.id} 处回退），需要为该站点单独保存顺序`);
    last = i;
  }
}

// ---------------------------------------------------------------- 5. 语义自证：条目行必须一一对应

function entryKeys(content) {
  return content.filter((l) => /^\s*(\/\/)?\{ id: /.test(l)).map((l) => l.trim());
}

const siteDefs = TARGETS.map((t) => {
  const p = parsed[t.key];
  const titleLine = (p.regions.TITLE.content.length ? p.regions.TITLE.content[0] : p.regions.TITLE.anchorLine) || '';
  const base = { key: t.key, type: t.type, file: t.file, title: parseTitle(titleLine) || '', productsIndent: p.indent };
  if (t.type === 'form') {
    return {
      ...base,
      storageKey: p.cfg.storageKey,
      filterToGroups: t.key === 'TPU',
      promo: p.cfg.promo,
      groups: p.cfg.groups,
      overrides: {},
      raw: {
        TITLE: [titleLine],
        PROMO: p.regions.PROMO.content,
        GROUPMAP: p.regions.GROUPMAP.content,
        DISABLED: p.regions.DISABLED.content.length ? p.regions.DISABLED.content : [p.regions.DISABLED.anchorLine],
        STORAGE: p.regions.STORAGE.content.length ? p.regions.STORAGE.content : [p.regions.STORAGE.anchorLine],
      },
    };
  }
  return { ...base, watermark: p.cfg.watermark, raw: { TITLE: [titleLine], WATERMARK: p.regions.WATERMARK.content } };
});

for (const s of siteDefs) {
  const leafSet = new Set(groupLeafNames(s.groups || []));
  const all = entryKeys(parsed[s.key].regions.PRODUCTS.content);
  // 摘取型站点：现状文件里本来就把非本分组的条目一并写进去（靠运行时 splice 过滤），
  // 校验时按同样的分组范围截断，保证“可见集合不变”这个不变量
  const original = s.filterToGroups
    ? parsed[s.key].rows.filter((r) => leafSet.has(r.category)).map((r) => entryKeyOf(r))
    : all;
  const emitted = entryKeys(emitProducts(master, siteProductsOpts(s, master)));
  const same = original.length === emitted.length && original.every((l, i) => l === emitted[i]);
  if (!same) {
    log(`\n[!] ${s.key} 条目行对不上：现状 ${original.length} 条 / 生成 ${emitted.length} 条`);
    for (let i = 0; i < Math.max(original.length, emitted.length); i++) {
      if (original[i] !== emitted[i]) {
        log(`   首个差异 第 ${i + 1} 条\n   现: ${original[i]}\n   新: ${emitted[i]}`);
        break;
      }
    }
    die('生成结果与现状不一致，请修正 parseProducts / emitProducts');
  }
  const note = s.filterToGroups ? `（已按分组截断；该文件原本写了 ${all.length} 行，其中 ${all.length - original.length} 行本来就被运行时过滤掉）` : '';
  log(`语义自证 ${s.key}：${original.length} 条产品行与主数据一一对应${note}`);
}

function entryKeyOf(r) {
  return (r.commented ? '//' : '') + `{ id: '${r.id}', category: '${r.category}', name: '${r.name}', image: '${r.image}' },`;
}

// ---------------------------------------------------------------- 6. 落盘

const productsOut = {
  _readme: '产品主数据（唯一权威）。数组顺序 = 选款表网格与画册的渲染顺序。form: normal=正常可选 / disabled=选款表置灰但图片可放大 / hidden=选款表不渲染。catalog: 是否出现在画册（导出的 PDF）里。notes 是分节注释，生成时还原在各型号上方。',
  products: master.map((p) => {
    const o = { id: p.id, name: p.name, category: p.category, image: p.image, form: p.form, catalog: p.catalog };
    if (p.notes && p.notes.length) o.notes = p.notes;
    return o;
  }),
};

const sitesOut = {
  _readme: '站点定义。type=form 的站点用 groups 决定侧边栏分组；filterToGroups=true 时产品数组只装本分组子集。raw 保存迁移时的原始区段文本：配置未被改动时生成器原样透传，改过之后按规范格式重写。',
  sites: siteDefs,
};

if (DRY) {
  log('\n[dry-run] 未写入任何文件。统计：');
  log(`  主数据产品数   = ${master.length}`);
  log(`  form=normal    = ${master.filter((p) => p.form === 'normal').length}`);
  log(`  form=disabled  = ${master.filter((p) => p.form === 'disabled').length}`);
  log(`  form=hidden    = ${master.filter((p) => p.form === 'hidden').length}`);
  log(`  catalog=true   = ${master.filter((p) => p.catalog).length}`);
  for (const s of siteDefs) {
    const n = emitProducts(master, siteProductsOpts(s, master)).filter((l) => /^\s*(\/\/)?\{ id: /.test(l)).length;
    log(`  ${s.key.padEnd(12)} 生成数组条目 = ${n}`);
  }
  process.exit(0);
}

fs.writeFileSync(path.join(TOOLS, 'products.json'), JSON.stringify(productsOut, null, 2) + '\n', 'utf8');
fs.writeFileSync(path.join(TOOLS, 'sites.json'), JSON.stringify(sitesOut, null, 2) + '\n', 'utf8');

for (const t of TARGETS) {
  const p = parsed[t.key];
  writeFileLines(path.join(ROOT, t.file), p.marked, p.eol);
  log(`标记  ${t.file}：已插入 ${Object.keys(p.regions).length} 组 GEN 标记`);
}

const afterDir = path.join(TOOLS, 'after-import');
fs.mkdirSync(afterDir, { recursive: true });
for (const t of TARGETS) fs.copyFileSync(path.join(ROOT, t.file), path.join(afterDir, `${t.key}.html`));
log('快照  标记后的三个页面 -> tools/after-import/');

log(`\n完成。主数据 ${master.length} 条 -> tools/products.json；站点 ${siteDefs.length} 个 -> tools/sites.json`);
log('下一步：node tools/build.mjs');
