// check.mjs —— 回归校验（改完之后拿它证明「前端没被动过」）
//
// 用法：  node tools/check.mjs
//
// 四道关卡：
//   A. 标记区以外的字节必须与 tools/baseline/ 一致，只允许 WHITELIST 登记过的改动
//   B. 页面里的内联 <script> 必须能被 JS 引擎解析（语法完整）
//   C. 产物纯净：不得出现后台 / 工具相关字样
//   D. 数字断言：产品条数、分组可见数、分类条数、停用名单必须命中基线
//
// 站点表不写死：从 sites.json 派生，新建的站点自动进入四道关卡。

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {
  ROOT, TOOLS, readFileLines, locateRegion, REGION_SPECS,
  parseProducts, groupLeafNames, FORBIDDEN_OUTPUT,
} from './lib.mjs';
import { sitesFrom } from './store.mjs';

/** A 关卡的比对基准：本站点快照优先，新站点没有自己的快照则退回模板站点的 */
function pickBaseline(s) {
  const own = `${s.key}.html`;
  if (fs.existsSync(path.join(TOOLS, 'baseline', own))) return own;
  return `${s.template || 'card-holder'}.html`;
}

/** 该站点有哪些可变配置区（生成器托管的区段） */
const regionNames = (s) => s.type === 'catalog'
  ? ['TITLE', 'WATERMARK', 'PRODUCTS']
  : ['TITLE', 'PROMO', 'PRODUCTS', 'DISABLED', 'GROUPMAP', 'STORAGE'];

const SITES = sitesFrom().map((s) => ({
  key: s.key,
  file: s.file,
  baseline: pickBaseline(s),
  names: regionNames(s),
  def: s,
}));

// 已获授权的画面修复，逐条登记。add / del 一律写「去掉行首缩进后的整行」
const WHITELIST = [
  {
    id: 'P0-1',
    why: '移动端抽屉滚动区底部避让（修 PP Card Binder / PP Card Divider 永远点不到）',
    sites: ['card-holder', 'TPU'],
    blockAdd: { start: '.sidebar-scroll {', end: '}', contains: 'calc(96px + env(safe-area-inset-bottom, 0px))' },
  },
  {
    id: 'P0-2',
    why: '底栏预留高度随 env(safe-area-inset-bottom) 浮动（修 iPhone 最后一行输入框被盖）',
    sites: ['card-holder', 'TPU'],
    del: ['padding-bottom: 70px !important;'],
    add: ['padding-bottom: calc(96px + env(safe-area-inset-bottom, 0px)) !important;'],
  },
  {
    id: 'P2',
    why: '取消 5 秒全量拉图，改为空闲分片预加载（画面无差异，只改网络时序）',
    sites: ['card-holder', 'TPU'],
    blockDel: { start: 'setTimeout(() => {', end: '}, 5000);' },
    blockAdd: { start: 'function idlePreload() {', end: 'idlePreload();' },
  },
  {
    // 2026-10 你授权的功能改动，一次登记在这里：数量只能正整数、起订量校验、Pre Sale 预售状态。
    // 数据不另开表，就写在每个产品那一行里（moq: 10 / form: 'presale'），所以页面上只需读 products。
    id: 'P3',
    why: '数量规则三件套：边输边只保证正整数、离开输入框才查起订量（否则 10、25 这类数量打不出来）、Pre Sale 预售不可填数量',
    sites: ['card-holder', 'TPU'],
    del: [
      "if (disabledIdSet.has(id)) return 0;",
      "<div class=\"product-card bg-white border border-gray-200 rounded-lg overflow-hidden flex flex-col ${(product.category === currentCategory || currentCategory === null) && getGroupForCategory(product.category) === currentGroup ? '' : 'hidden'} ${isDisabled(product.id) ? 'disabled' : ''}\"",
      "placeholder=\"0\"",
      "${isDisabled(product.id) ? 'disabled' : ''}",
      "if (isDisabled(id)) return; // 停用型号不恢复历史数量",
    ],
    add: [
      "if (isNoQty(id)) return 0;",
      "<div class=\"product-card bg-white border border-gray-200 rounded-lg overflow-hidden flex flex-col ${(product.category === currentCategory || currentCategory === null) && getGroupForCategory(product.category) === currentGroup ? '' : 'hidden'} ${isNoQty(product.id) ? 'disabled' : ''}\"",
      "step=\"1\"",
      "placeholder=\"${phOf(product)}\"",
      "onblur=\"handleBlur('${product.id}', this)\"",
      "${isNoQty(product.id) ? 'disabled' : ''}",
      "if (isNoQty(id)) return; // 停用与预售型号不恢复历史数量",
      "fmtInput(input);            // 缓存里的小数、负数当场抹平",
      "enforceMin(id, input, false); // 缓存里不足起订量的数量静默清掉（不弹窗打扰）",
      "saveToStorage(); // 清洗过的数量回写，免得每次加载都重复处理一遍",
    ],
    blockAdd: { start: '// ================= 数量规则：正整数、起订量、预售 =================', end: '// ================= 数量规则结束 =================' },
  },
  {
    // 2026-10 你批准「每个站点自己定义分组」之后拆的雷。这段硬编码在运行时又把非
    // Grading Slab Protection 的产品砍一遍：数据层早就按分组只发射 182 条，它本身冗余；
    // 真正的害处是一旦给 TPU 加第二个分组，新分组的产品会被静默清空且不报任何错。
    id: 'P4',
    why: '删掉 TPU 页面里硬编码的大分组二次过滤（数据层已过滤，它会让 TPU 永远只能有一个分组）',
    sites: ['TPU'],
    // 那两行 // 注释也得单独列：stripComments 只剥 /* */ 块注释，行注释会作为净内容留下来
    del: [
      '// TPU 站点：就地过滤 products 数组，仅保留 Grading Slab Protection 大分组下的产品，',
      '// 确保网格渲染、导出订单、数量统计等所有逻辑都只包含该分组的产品',
    ],
    blockDel: { start: 'for (let i = products.length - 1; i >= 0; i--) {', end: '}', contains: "products[i].category0 !== 'Grading Slab Protection'" },
  },
  {
    // 2026-10-22 你要求把起订量提示从浏览器顶部那个原生框换成页面居中、与页面同风格的弹窗。
    // 弹窗结构与动效照抄下载弹窗，用的类全部是页面里已有的，tailwind.css 不需要重新编译。
    id: 'P5',
    why: '新增提示弹窗的 HTML 结构',
    sites: ['card-holder', 'TPU'],
    blockAdd: { start: '<!-- 提示弹窗（替代浏览器原生 alert）开始 -->', end: '<!-- 提示弹窗（替代浏览器原生 alert）结束 -->' },
  },
  {
    id: 'P6',
    why: '新增提示弹窗的 JS 实现，并把两处原生 alert 调用换成它（起订量那处在 P3 已登记的新增块内，不用单独登记）',
    sites: ['card-holder', 'TPU'],
    blockAdd: { start: '// ================= 提示弹窗：替代浏览器原生 alert =================', end: '// ================= 提示弹窗结束 =================' },
    del: [
      'alert("Please select at least one product! (请至少输入一个产品的数量)");',
      'alert("Please enter your name. (请输入您的名字)");',
    ],
    add: [
      "showNotice('Nothing selected', 'Please enter a quantity for at least one product. (请至少为一个产品填写数量)');",
      "showNotice('Name required', 'Please enter your name before exporting. (导出前请先填写名字)');",
    ],
  },
  {
    // 2026-10-22 你要求预售在页面上看得出来：整卡淡灰 + Pre Sale 用主题渐变文字。
    // 渐变直接复用 .sidebar-title 那支（深藏青 → #3b82f6 → 亮蓝），不另造颜色。
    // placeholder 里画不出渐变（::placeholder 不支持 background-clip: text），
    // 所以改成在数量框上叠一层真文字，视觉位置与原来一致。
    id: 'P7',
    why: '预售/停用卡片整卡可见化 + Pre Sale 渐变文字样式',
    sites: ['card-holder', 'TPU'],
    blockAdd: { start: '/* 预售与停用可见化样式：开始 */', end: '/* 预售与停用可见化样式：结束 */' },
  },
  {
    id: 'P8',
    why: '数量框外包一层定位参照 .qty-wrap 并叠预售文字；updateVisuals / handleInput 加 isNoQty 守卫（脚本塞值不再亮起假选中蓝框）',
    sites: ['card-holder', 'TPU'],
    add: [
      '<div class="qty-wrap">',
      '</div><!-- qty-wrap -->',
      "${isPreSale(product.id) ? '<span class=\"presale-flag\">Pre Sale</span>' : ''}",
      'if (isNoQty(id)) return; // 停用与预售不参与选中态：脚本塞值也不该亮起蓝框',
      'if (isNoQty(id)) return; // 同上，且不把填不进去的数量写进暂存与统计',
    ],
  },
];

const PH = '@@GEN@@';
let failed = 0;
// 失败分两类：gate = 生成器或产物坏了，必须查；anchor = 只是人工基线旧了，
// 可以由人确认后采纳。两者都拦住 dist，但只有后者能一键放过（见 badAnchor）。
let gateFail = 0;
const anchorFix = [];
const ok = (m) => console.log('  [ok] ' + m);
const bad = (m) => { console.log('  [!!] ' + m); failed++; gateFail++; };
const badAnchor = (m, site, field, value) => { console.log('  [!!] ' + m); failed++; anchorFix.push({ site, field, value }); };
const trim = (l) => l.trim();

/** 剔除块注释与行尾注释，返回每行的净内容（注释是给人看的，不该参与一致性比对） */
function stripComments(lines) {
  let inBlock = false;
  return lines.map((l) => {
    let out = '', i = 0;
    while (i < l.length) {
      if (inBlock) {
        const e = l.indexOf('*/', i);
        if (e === -1) { i = l.length; } else { inBlock = false; i = e + 2; }
        continue;
      }
      const b = l.indexOf('/*', i);
      const s = l.indexOf('//', i);
      if (b === -1 && s === -1) { out += l.slice(i); break; }
      if (b !== -1 && (s === -1 || b < s)) { out += l.slice(i, b); inBlock = true; i = b + 2; continue; }
      out += l.slice(i); i = l.length; // 行尾注释
    }
    return out;
  });
}
const net = (l) => l.trim();

/** 现文件：把标记包住的区段内容压成占位行 */
function collapseMarked(lines) {
  const out = [];
  let depth = 0;
  for (const l of lines) {
    // 只认 GEN: 不认前缀 /*：标记有两种写法，JS 区用块注释，HTML 区（TITLE）用页面注释
    if (l.includes('GEN:') && l.includes('BEGIN')) { depth++; out.push(PH); continue; }
    if (l.includes('GEN:') && l.includes('END')) { depth--; continue; }
    if (depth === 0) out.push(l);
  }
  return out;
}

/** 基线文件：按锚点把可变的「内容」压成占位行，形式与标记后一致 */
function collapseAnchored(lines, names) {
  let cur = [...lines];
  for (const n of names) {
    const spec = REGION_SPECS[n];
    if (!spec) continue;
    const loc = locateRegion(cur, n);
    const from = spec.kind === 'line' ? loc.begin : loc.begin + 1;
    const to = spec.kind === 'line' ? loc.end : loc.end - 1;
    cur = [...cur.slice(0, from), PH, ...cur.slice(to + 1)];
  }
  return cur;
}

/** 找出「等于 start 行到第一个等于 end 的行」这一段；会遍历所有同名的 start，直到 contains 命中 */
function findBlock(lines, start, end, contains) {
  for (let s = 0; s < lines.length; s++) {
    if (trim(lines[s]) !== start) continue;
    for (let i = s + 1; i < lines.length; i++) {
      if (trim(lines[i]) !== end) continue;
      if (contains && !lines.slice(s, i + 1).some((l) => l.includes(contains))) break;
      return [s, i];
    }
  }
  return null;
}

function dropLines(lines, set) {
  return lines.filter((l) => !set.has(trim(l)));
}

console.log('\n=== A. 标记区以外的字节一致性 ===');
for (const s of SITES) {
  const names = s.names;
  const B0 = collapseMarked(readFileLines(path.join(ROOT, s.file)).lines);
  const A0 = collapseAnchored(readFileLines(path.join(TOOLS, 'baseline', s.baseline)).lines, names);
  // 新站点是从模板逐字节克隆的，模板上登记过的授权修复对它同样适用
  const mine = WHITELIST.filter((w) => (w.sites || []).includes(s.key)
    || (s.def.template && (w.sites || []).includes(s.def.template)));

  let A = A0, B = B0;
  const notes = [];

  // 1) 登记过的整块删除：从基线里摘掉（按行集合删除会误伤同名行，故只按连续块）
  for (const w of mine) {
    if (w.blockDel) {
      const range = findBlock(A, w.blockDel.start, w.blockDel.end, w.blockDel.contains);
      if (!range) { bad(`${s.file} 白名单 ${w.id} 声明的待删代码块在基线里没找到`); continue; }
      if (findBlock(B, w.blockDel.start, w.blockDel.end, w.blockDel.contains)) { bad(`${s.file} 白名单 ${w.id} 要删的代码块在产物里还在`); continue; }
      A = [...A.slice(0, range[0]), ...A.slice(range[1] + 1)];
      notes.push(`${w.id} 删块 ${range[0] + 1}-${range[1] + 1} 行`);
    }
    for (const d of w.del || []) {
      if (!A0.some((l) => trim(l) === d)) { bad(`${s.file} 白名单 ${w.id} 要删的行在基线里找不到: ${d}`); continue; }
      if (B0.some((l) => trim(l) === d)) { bad(`${s.file} 白名单 ${w.id} 要删的行仍然残留: ${d}`); continue; }
      notes.push(`${w.id} 删 ${d}`);
    }
    A = dropLines(A, new Set(w.del || []));
  }

  // 2) 登记过的整块新增：从现文件里摘掉，剩下才该与基线一致
  for (const w of mine) {
    if (w.blockAdd) {
      const range = findBlock(B, w.blockAdd.start, w.blockAdd.end, w.blockAdd.contains);
      if (!range) { bad(`${s.file} 白名单 ${w.id} 声明的新增代码块没找到（${w.blockAdd.start} ... ${w.blockAdd.end}）`); continue; }
      B = [...B.slice(0, range[0]), ...B.slice(range[1] + 1)];
      notes.push(`${w.id} 增块 ${range[0] + 1}-${range[1] + 1} 行`);
    }
    if (w.add) {
      for (const a of w.add) if (!B0.some((l) => trim(l) === a)) bad(`${s.file} 白名单 ${w.id} 要加的行不在产物里: ${a}`);
      B = dropLines(B, new Set(w.add));
      notes.push(`${w.id} 增 ${w.add.length} 行`);
    }
  }

  // 3) 剩下的应当逐行相同（注释是给人看的，允许随改动补写，因此两边都剔掉再比）
  const An = stripComments(A).map(net).filter((l) => l !== '');
  const Bn = stripComments(B).map(net).filter((l) => l !== '');
  if (JSON.stringify(An) === JSON.stringify(Bn)) {
    ok(`${s.file} 区段外仅有白名单改动${notes.length ? '：' + notes.join(' | ') : '（零改动）'}`);
  } else {
    let i = 0;
    while (i < An.length && i < Bn.length && An[i] === Bn[i]) i++;
    bad(`${s.file} 区段外有未登记差异（第 ${i + 1} 处起）`);
    console.log(`          基线: ${JSON.stringify(trim(An[i] || ''))}`);
    console.log(`          现状: ${JSON.stringify(trim(Bn[i] || ''))}`);
    console.log(`          行数 基线 ${An.length} / 现状 ${Bn.length}`);
  }
}

console.log('\n=== B. 内联脚本可解析 ===');
for (const s of SITES) {
  const text = fs.readFileSync(path.join(ROOT, s.file), 'utf8');
  const blocks = [...text.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  let errs = 0;
  blocks.forEach((code, i) => {
    try { new vm.Script(code, { filename: `${s.file}#script${i}` }); } catch (e) { errs++; console.log(`        块 ${i}: ${e.message}`); }
  });
  errs ? bad(`${s.file} 有 ${errs} 个 script 块语法错误`) : ok(`${s.file} ${blocks.length} 个 script 块语法通过`);
}

console.log('\n=== C. 产物纯净 ===');
const FORBIDDEN = FORBIDDEN_OUTPUT;
for (const s of SITES) {
  const text = fs.readFileSync(path.join(ROOT, s.file), 'utf8');
  const hits = FORBIDDEN.filter((re) => re.test(text));
  hits.length ? bad(`${s.file} 含禁止字样: ${hits.map(String)}`) : ok(`${s.file} 无后台痕迹`);
}

console.log('\n=== D. 数字断言 ===');
const products = JSON.parse(fs.readFileSync(path.join(TOOLS, 'products.json'), 'utf8')).products;

// 人工基线放在 tools/anchors.json 里，而不是写死在本文件源码里。
// 为什么搬出去：只有基线对不上（而主数据独立复算仍一致）意味着“你有意识地改了内容”，
// 这种时候让人去改一段生成器源码是把顺序搞反了 —— 应该它问你一句、你点一下。
// 下划线开头的键（_readme / _history）不是站点，跳过。
const ANCHOR_FILE = path.join(TOOLS, 'anchors.json');
const ADOPT = process.argv.includes('--adopt');
const AS_JSON = process.argv.includes('--json');
const optVal = (name, dft) => { const i = process.argv.indexOf(name); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dft; };
let ANCHORS = {};
try {
  const rawAnchors = JSON.parse(fs.readFileSync(ANCHOR_FILE, 'utf8'));
  for (const [k, v] of Object.entries(rawAnchors)) if (!k.startsWith('_')) ANCHORS[k] = v;
} catch (e) {
  bad(`读不到 ${path.relative(ROOT, ANCHOR_FILE)}：${e.message}（人工基线丢了就没人能判断数字对不对，先把它补回来）`);
}

/**
 * 用主数据独立走一遍「该站点应渲染哪些型号」。
 * 这里故意不复用 lib.mjs 里生成器用的 siteProductsOpts / effectiveIds：
 * 两边写成同一函数就只能自证，拿不到「发射逻辑写错」这个信号。
 */
function shouldBeLive(site, master) {
  // 成员来源与生成器同语义、但独立写一遍：显式 members 名单优先，没有名单才退回
  // 旧的「按分组自动摘取」。两边写成同一函数就只能自证，拿不到发射逻辑写错的信号。
  const leavesOf = (src) => new Set(groupLeafNames(src.groups || []));
  const memberOk = (src, p) => {
    if (Array.isArray(src.members)) return src.members.includes(p.id);
    if (src.filterToGroups) return leavesOf(src).has(p.category);
    return true;
  };
  if (site.type === 'catalog') {
    // 画册跟随它的 owner 选款站：成员范围与排除表都取 owner 的。
    // 没配 owner 时退回旧行为（全库范围 + 产品级 catalog 布尔）。
    const owner = SITES.map((x) => x.def).find((d) => d.key === site.owner);
    if (!owner) return master.filter((p) => p.catalog !== false).map((p) => p.id);
    const hasOff = Array.isArray(owner.catalogOff);
    const off = new Set(hasOff ? owner.catalogOff : []);
    return master.filter((p) => {
      if (!memberOk(owner, p)) return false;
      if (hasOff ? off.has(p.id) : p.catalog === false) return false;
      return true;
    }).map((p) => p.id);
  }
  return master.filter((p) => {
    if (!memberOk(site, p)) return false;
    const ov = (site.overrides || {})[p.id];
    const form = (ov && ov.form) || p.form;
    return form !== 'hidden';
  }).map((p) => p.id);
}

const sorted = (a) => [...a].sort();
const sameList = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
/**
 * 人工基线不符与「与主数据不符」是两类完全不同的问题：后者是生成器坏了，
 * 前者通常是你有意改了数据（本站下架一个型号、删一个分组）。两者都拦住 dist，
 * 但只有前者需要确认采纳，所以提示里直接说清「哪个站、哪个字段、该改成多少」。
 */
const hintNum = (key, field, value) => `\n        → 这一般是有意改动：点一下后台的「保存并生成」会问你确认（确认后自动写进 tools/anchors.json）；\n          也可以在命令行跑：node tools/check.mjs --adopt --reason "为什么改"。要把 ${key}.${field} 采纳为 ${value}`;
const hintObj = (key, field, value) => `\n        → 这一般是有意改动：点一下后台的「保存并生成」会问你确认（确认后自动写进 tools/anchors.json）；\n          也可以在命令行跑：node tools/check.mjs --adopt --reason "为什么改"。要把 ${key}.${field} 采纳为 ${JSON.stringify(value)}`;
const byId = new Map(products.map((p) => [p.id, p]));

for (const s of SITES) {
  const def = s.def;
  const anchor = ANCHORS[def.key] || {};
  const { lines } = readFileLines(path.join(ROOT, s.file));
  const loc = locateRegion(lines, 'PRODUCTS');
  const { rows } = parseProducts(lines.slice(loc.begin + 1, loc.end));
  const liveRows = rows.filter((r) => !r.commented);
  const live = liveRows.map((r) => r.id);
  const want = shouldBeLive(def, products);

  if (sameList(live, want)) {
    ok(`${s.file} 生效条目 ${live.length} 条，与主数据独立复算一致`);
  } else {
    const miss = want.filter((id) => !live.includes(id));
    const extra = live.filter((id) => !want.includes(id));
    bad(`${s.file} 生效条目与主数据不符：应渲染 ${want.length}，实际 ${live.length}（缺失 ${miss.slice(0, 5).join(',') || '无'}；多余 ${extra.slice(0, 5).join(',') || '无'}）`);
  }
  if (anchor.live !== undefined && live.length !== anchor.live) {
    badAnchor(`${s.file} 生效条目 ${live.length} != 人工基线 ${anchor.live}${hintNum(def.key, 'live', live.length)}`, def.key, 'live', live.length);
  }

  if (def.type === 'catalog') continue;

  // 统计单位：普通站点按分组；TPU 这类摘取型站点的分组表就是分类列表，按分类逐条统计
  const units = anchor.perGroupIsPerCategory
    ? groupLeafNames(def.groups).map((leaf) => ({ name: leaf, leaves: [leaf] }))
    : def.groups.map((g) => ({ name: g.name, leaves: groupLeafNames([g]) }));
  const inUnit = (u) => new Set(u.leaves);
  const wantSet = new Set(want);
  const gotDist = units.map((u) => {
    const ls = inUnit(u);
    return liveRows.filter((r) => ls.has(r.category)).length;
  });
  const wantDist = units.map((u) => {
    const ls = inUnit(u);
    return products.filter((p) => wantSet.has(p.id) && ls.has(p.category)).length;
  });
  // 分组顺序在页面上有语义，所以这里比的是严格序列而非集合
  if (JSON.stringify(gotDist) !== JSON.stringify(wantDist)) {
    bad(`${s.file} 各分组可见分布 ${gotDist.join('/')} != 主数据复算 ${wantDist.join('/')}`);
  } else {
    ok(`${def.key} 各分组可见卡片 ${gotDist.join('/')}`);
  }
  if (anchor.perGroup) {
    // 按名字对锚点，顺带发现「基线里某个单位已从站点分组中消失」
    const gotByName = Object.fromEntries(units.map((u, i) => [u.name, gotDist[i]]));
    const drift = Object.entries(anchor.perGroup).filter(([k, v]) => gotByName[k] !== v);
    const gone = Object.keys(anchor.perGroup).filter((k) => !(k in gotByName));
    if (drift.length || gone.length) {
      badAnchor(`${s.file} 可见分布与人工基线不符：${drift.map(([k, v]) => `${k} ${gotByName[k]}≠${v}`).join(', ') || '数量均一致'}${gone.length ? '；基线里的这些单位已不在本站点分组中：' + gone.join(', ') : ''}${hintObj(def.key, 'perGroup', gotByName)}`, def.key, 'perGroup', gotByName);
    } else {
      ok(`${def.key} 各分组可见卡片与人工基线逐项一致`);
    }
  }

  // 分类数
  const gotCats = [...new Set(liveRows.map((r) => r.category))];
  const wantCats = [...new Set(products.filter((p) => wantSet.has(p.id)).map((p) => p.category))];
  sameList(gotCats, wantCats)
    ? ok(`分类数 ${gotCats.length}`)
    : bad(`分类数 ${gotCats.length} != 主数据复算 ${wantCats.length}`);
  if (anchor.categories !== undefined && gotCats.length !== anchor.categories) {
    badAnchor(`${s.file} 分类数 ${gotCats.length} != 人工基线 ${anchor.categories}${hintNum(def.key, 'categories', gotCats.length)}`, def.key, 'categories', gotCats.length);
  }

  // 停用名单（页面里的 DISABLED_PRODUCT_IDS 必须等于主数据里该站点置灰的那些）
  const dloc = locateRegion(lines, 'DISABLED');
  const txt = lines.slice(dloc.begin + 1, dloc.end).join('');
  const gotDisabled = [...txt.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1]).sort();
  const wantDisabled = want.filter((id) => {
    const p = byId.get(id);
    const ov = (def.overrides || {})[id];
    return ((ov && ov.form) || p.form) === 'disabled';
  }).sort();
  // 名单在代码里是 Set，顺序无语义
  sameList(gotDisabled, wantDisabled)
    ? ok(`停用名单 ${gotDisabled.join(', ') || '（空）'}`)
    : bad(`停用名单 ${gotDisabled.join(', ')} != 主数据复算 ${wantDisabled.join(', ')}`);
  if (anchor.disabled && !sameList(gotDisabled, anchor.disabled)) {
    badAnchor(`${s.file} 停用名单 ${gotDisabled.join(', ')} != 人工基线 ${anchor.disabled.join(', ')}${hintObj(def.key, 'disabled', gotDisabled)}`, def.key, 'disabled', gotDisabled);
  }
}

// 采纳人工基线：只有「基线旧了」这一类失败能走这条路。任何 gate 类失败都直接拒，
// 否则就是给一个坏结果盖章。改完追一行 _history，谁在什么时候把哪个数字从几改到几可回看。
if (ADOPT) {
  const fmt = (v) => (typeof v === 'object' ? JSON.stringify(v) : String(v));
  if (!anchorFix.length) {
    console.log('\n没有可采纳的人工基线项（要么全过，要么失败的不是基线类）\n');
    process.exit(failed ? 1 : 0);
  }
  if (gateFail) {
    console.log(`\n[拒绝] 还有 ${gateFail} 项不是基线问题：那说明生成器或产物本身不对，采纳基线等于给坏结果盖章。先把那些查清楚。\n`);
    process.exit(1);
  }
  const raw = JSON.parse(fs.readFileSync(ANCHOR_FILE, 'utf8'));
  const changed = [];
  for (const f of anchorFix) {
    raw[f.site] = raw[f.site] || {};
    const before = raw[f.site][f.field];
    if (JSON.stringify(before) === JSON.stringify(f.value)) continue;
    raw[f.site][f.field] = f.value;
    changed.push(`${f.site}.${f.field} ${fmt(before)} → ${fmt(f.value)}`);
  }
  if (!changed.length) { console.log('\n基线已经是当前值，无需改写\n'); process.exit(0); }
  raw._history = Array.isArray(raw._history) ? raw._history : [];
  raw._history.push(`${new Date().toISOString().slice(0, 10)} 采纳：${changed.join('；')}（原因：${optVal('--reason', '（未注明原因）')}）`);
  fs.writeFileSync(ANCHOR_FILE, JSON.stringify(raw, null, 2) + '\n', 'utf8');
  console.log(`\n[已更新] tools/anchors.json：${changed.join('；')}`);
  console.log('  再跑一次回归校验确认全绿，dist 才会跟着更新。\n');
  process.exit(0);
}

console.log(failed ? `\n校验失败 ${failed} 项\n` : '\n全部校验通过\n');
// --json：供后台保存流程判断「是不是只卡在基线上」，从而弹一次确认而不是一片红字
if (AS_JSON) {
  console.log('===JSON===\n' + JSON.stringify({
    ok: !failed, failed, gateFail,
    anchorOnly: failed > 0 && gateFail === 0,
    anchorFix,
  }));
}
process.exit(failed ? 1 : 0);
