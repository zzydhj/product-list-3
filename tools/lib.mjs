// lib.mjs —— 数据单源化的核心共享库
//
// 职责：
//   1. 在页面文件里定位「数据区」（先找 GEN 标记，找不到再按锚点行识别）
//   2. 解析 / 发射 products 数组（逐字节还原原始缩进、空行与分节注释）
//   3. 发射站点配置区（TITLE / PROMO / GROUPMAP / DISABLED / STORAGE / WATERMARK）
//
// 铁律：本库只重写标记区内的内容，标记区以外的字节永不触碰。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 不用 import.meta.dirname：它要 Node 20.11+，而部署平台（Cloudflare Pages）的构建容器版本不受我们控制，
// 版本不够时整个生成链会当场崩在这行。fileURLToPath 在所有 ESM 环境下行为一致。
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TOOLS = path.join(ROOT, 'tools');

// ---------------------------------------------------------------- 区段定义与标记

export const REGION_SPECS = {
  // html: true 的区段在标记区外，注释必须用 HTML 形式（页面 head 里放 JS 注释会被当成文本）
  TITLE: { kind: 'line', html: true, anchor: /^(\s*)<title>(.*)<\/title>$/ },
  PRODUCTS: { kind: 'block', anchor: /^\s*const products = \[$/, end: /^\s*\];$/ },
  GROUPMAP: { kind: 'block', anchor: /^\s*const categoryGroupMap = \{$/, end: /^\s*\};$/ },
  PROMO: { kind: 'block', anchor: /^\s*const PROMO_CONFIG = \{$/, end: /^\s*\};$/ },
  WATERMARK: { kind: 'block', anchor: /^\s*const WATERMARK_CONFIG = \{$/, end: /^\s*\};$/ },
  DISABLED: { kind: 'line', anchor: /^(\s*)const DISABLED_PRODUCT_IDS = \[[^\]]*\];$/ },
  STORAGE: { kind: 'line', anchor: /^(\s*)const STORAGE_KEY = '[^']*';$/ },
};

const isHtml = (name) => Boolean(REGION_SPECS[name] && REGION_SPECS[name].html);
const DOC = '此区块由生成工具托管，请勿手改';

export const MARK = (name) => isHtml(name)
  ? `<!-- GEN:${name} BEGIN ${DOC} -->`
  : `/* GEN:${name} BEGIN ${DOC} */`;
export const MARK_END = (name) => isHtml(name) ? `<!-- GEN:${name} END -->` : `/* GEN:${name} END */`;

// ---------------------------------------------------------------- 文件读写

export function readFileLines(file) {
  const text = fs.readFileSync(file, 'utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  return { text, eol, lines: text.split(/\r\n|\n/) };
}

export function writeFileLines(file, lines, eol) {
  fs.writeFileSync(file, lines.join(eol), 'utf8');
}

// ---------------------------------------------------------------- 区段定位

/**
 * 找到某个区段在 lines 中的位置。
 * 优先使用已插入的 GEN 标记（幂等重建），否则回落到锚点行识别。
 * 返回 { begin, end }：begin/end 为标记行或锚点行的下标，内容区为 (begin, end) 开区间。
 * 对 kind:'line' 的单行区，begin === end（同一行），内容区为空。
 */
export function locateRegion(lines, name) {
  const b = lines.findIndex((l) => l.includes(MARK(name)));
  const e = lines.findIndex((l) => l.includes(MARK_END(name)));
  if (b !== -1 && e !== -1) {
    if (e <= b) throw new Error(`${name}: 标记顺序错乱 END(${e}) <= BEGIN(${b})`);
    return { begin: b, end: e, marked: true, indent: indentOf(lines[b]) };
  }
  if (b !== -1 || e !== -1) throw new Error(`${name}: GEN 标记不完整，只有单边`);

  const spec = REGION_SPECS[name];
  if (!spec) throw new Error(`未知区段 ${name}`);
  if (spec.kind === 'line') {
    const i = lines.findIndex((l) => spec.anchor.test(l));
    if (i === -1) throw new Error(`${name}: 找不到锚点行`);
    const m = spec.anchor.exec(lines[i]);
    return { begin: i, end: i, marked: false, indent: m[1], anchorLine: lines[i] };
  }
  const begin = lines.findIndex((l) => spec.anchor.test(l));
  if (begin === -1) throw new Error(`${name}: 找不到锚点行`);
  let end = -1;
  for (let i = begin + 1; i < lines.length; i++) {
    if (spec.end.test(lines[i])) { end = i; break; }
  }
  if (end === -1) throw new Error(`${name}: 找不到区段结束行`);
  return { begin, end, marked: false, indent: indentOf(lines[begin]), anchorLine: lines[begin] };
}

export function indentOf(line) {
  const m = /^(\s*)/.exec(line);
  return m ? m[1] : '';
}

/** 把 lines 中 [begin,end] 区段整体替换为 replacement 行（不含 begin/end 自身） */
export function replaceRegion(lines, begin, end, content) {
  return [...lines.slice(0, begin + 1), ...content, ...lines.slice(end + 1)];
}

/** 若尚未标记，则在区段外围插入 GEN 标记，返回新的 lines */
export function ensureMarkers(lines, name, loc) {
  if (loc.marked) return lines;
  const pad = loc.indent;
  const open = `${pad}${MARK(name)}`;
  const close = `${pad}${MARK_END(name)}`;
  if (REGION_SPECS[name].kind === 'line') {
    // 单行语句无法拆分，标记包在该行上下
    return [...lines.slice(0, loc.begin), open, lines[loc.begin], close, ...lines.slice(loc.end + 1)];
  }
  // 块区：标记插在开括号行与闭括号行之间，保证「区段内容」始终等于可变量本身
  return [
    ...lines.slice(0, loc.begin + 1),
    open,
    ...lines.slice(loc.begin + 1, loc.end),
    close,
    ...lines.slice(loc.end),
  ];
}

/** 取出区段内容行（不含标记/锚点） */
export function regionContent(lines, loc) {
  if (!loc.marked && loc.begin === loc.end) return [];
  return lines.slice(loc.begin + 1, loc.end);
}

// ---------------------------------------------------------------- products 解析

// 前四个字段顺序固定（迁移原文就是这样），尾部允许可选扩展字段：
//   form: 'presale'  预售（数量框不可填，框里显示 Pre Sale）
//   moq: 10          起订量
// 默认状态（normal、不设起订量）一律不写，保证未设置的产品行与今天逐字节相同。
const PRODUCT_LINE = /^(\s*)(\/\/)?\{ id: '([^']*)', category: '([^']*)', name: '([^']*)', image: '([^']*)'((?:, (?:form|moq): (?:'[^']*'|\d+))*) \},$/;
const PRODUCT_EXTRA = /, (form|moq): ('[^']*'|\d+)/g;

/**
 * 解析 products 区段内容。
 * 返回 rows: [{ id, category, name, image, commented, form, moq, notes }]
 * notes = 紧接在该条目上方的分节注释（去掉缩进与 // 后的正文），用于可读性还原。
 * 空行不保留：那是人手排版的噪声，三个文件各不相同，不能当产品属性。
 */
export function parseProducts(content) {
  const rows = [];
  let notes = [];
  for (const raw of content) {
    const m = PRODUCT_LINE.exec(raw);
    if (!m) {
      const c = /^(\s*)\/\/\s*(.*)$/.exec(raw);
      if (raw.trim() === '') continue;                     // 空行：丢弃
      if (c && c[2]) notes.push(c[2]);                     // 分节注释
      else if (raw.trim()) throw new Error('products 区段有无法识别的行: ' + JSON.stringify(raw));
      continue;
    }
    const extra = {};
    for (const e of String(m[7] || '').matchAll(PRODUCT_EXTRA)) {
      extra[e[1]] = e[2].charAt(0) === "'" ? e[2].slice(1, -1) : Number(e[2]);
    }
    rows.push({
      indent: m[1],
      commented: Boolean(m[2]),
      id: m[3], category: m[4], name: m[5], image: m[6],
      form: extra.form || 'normal',
      moq: extra.moq === undefined ? null : extra.moq,
      notes,
    });
    notes = [];
  }
  if (notes.length) throw new Error('products 区段末尾有孤立注释，请把它挂到下一个型号上');
  return { rows };
}

/** 统计某文件 products 行最常用的缩进 */
export function dominantIndent(rows) {
  const c = new Map();
  for (const r of rows) c.set(r.indent, (c.get(r.indent) || 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

export function emitProductLine(p, indent, commented) {
  const parts = [`id: '${p.id}'`, `category: '${p.category}'`, `name: '${p.name}'`, `image: '${p.image}'`];
  // 只写非默认值：normal 和「不设起订量」是默认状态，写出来会让 420 行全变长变乱
  if (p.form === 'presale') parts.push(`form: 'presale'`);
  if (Number.isInteger(p.moq) && p.moq > 0) parts.push(`moq: ${p.moq}`);
  return indent + (commented ? '//' : '') + `{ ${parts.join(', ')} },`;
}

/**
 * 某产品在画册面是否被排除。
 * 站点带了自家的 catalogOff（本站画册排除表）就以它为准；没带就回退到旧的产品级
 * catalog 布尔。迁移期间两条路径必须算出同样结果，否则现有产物会变。
 */
function catalogOut(p, opts) {
  if (opts.catalogOff) return opts.catalogOff.has(p.id);
  return p.catalog === false;
}

/**
 * 按站点自己的顺序排。名单里没写的型号按主数据顺序接在后面，
 * 所以产品库新增一个型号不会因为它不在 order 里就凭空消失。
 */
export function reorderBy(order, master) {
  const byId = new Map(master.map((p) => [p.id, p]));
  const listed = order.map((id) => byId.get(id)).filter(Boolean);
  const known = new Set(listed.map((p) => p.id));
  return [...listed, ...master.filter((p) => !known.has(p.id))];
}

/**
 * 发射 products 区段内容。
 * opts: { surface:'form'|'catalog', indent, filterToGroups?, leafSet?, overrides?, membership?, catalogOff?, order? }
 *   form 面：form==='hidden' 输出注释行；站点 override 优先于主数据
 *   catalog 面：被本站画册排除的型号输出注释行
 * 每个带 notes 的型号前会空一行 + 重新输出注释，与现状风格一致且不依赖人手空行。
 */
export function emitProducts(master, opts = {}) {
  const indent = opts.indent || '            ';
  const list = opts.order ? reorderBy(opts.order, master) : master;
  const out = [];
  let emittedAny = false;
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    if (opts.membership && !opts.membership.has(p.id)) continue;
    const ov = opts.overrides && opts.overrides[p.id];
    // 本站覆盖过的字段合成一张「本站视图」，产品行就按这张视图发射：
    // 产品库里 form 写 normal、本站覆盖成 presale，页面上那一行就带 form: 'presale'
    const view = ov ? { ...p, ...ov } : p;
    if (opts.filterToGroups && !opts.leafSet.has(p.category)) continue;
    const commented = opts.surface === 'catalog' ? catalogOut(p, opts) : view.form === 'hidden';
    const notes = p.notes || [];
    if (notes.length) {
      if (emittedAny) out.push('');
      for (const n of notes) out.push(`${indent}// ${n}`);
    } else if (opts.surface === 'catalog' && p.category !== (list[i - 1] || {}).category) {
      // 画册没有分节注释，靠分类切换处空一行保持可读（按排好的顺序看上一个）
      if (emittedAny) out.push('');
    }
    out.push(emitProductLine(view, indent, commented));
    emittedAny = true;
  }
  return out;
}

/** 某站点某面生效（会真正被渲染）的产品 id 列表 */
export function effectiveIds(master, opts = {}) {
  const out = [];
  for (const p of master) {
    if (opts.membership && !opts.membership.has(p.id)) continue;
    const ov = opts.overrides && opts.overrides[p.id];
    const form = (ov && ov.form) || p.form;
    if (opts.filterToGroups && !opts.leafSet.has(p.category)) continue;
    if (opts.surface === 'catalog' ? catalogOut(p, opts) : form === 'hidden') continue;
    out.push(p.id);
  }
  return out;
}

/**
 * 由站点定义推出 products 区的发射参数（import 与 build 共用，保证两边一致）。
 *
 * 成员来源有两种，按优先级：
 *   1. site.members 显式名单——你在工作台「从产品库添加 / 移出本站」维护的那张表，
 *      有它就完全按它走，分组不再决定成员（只管侧栏结构与顺序）。
 *   2. 没有 members 时退回旧的「按分组自动摘取」（filterToGroups），保证未迁移的站点行为不变。
 *
 * 画册站的成员范围与排除表全部跟随它的 owner 选款站派生，不在两处各存一份：
 * 这样「TPU 站有什么」与「TPU 画册有什么」永远不会对不上。
 * 不传 owner 时退回旧行为（画册站用自身定义），保证 import.mjs 等旧调用点不受影响。
 */
export function siteProductsOpts(site, master, owner) {
  const isCatalog = site.type === 'catalog';
  const src = isCatalog && owner ? owner : site;
  const members = Array.isArray(src.members) ? new Set(src.members) : null;
  return {
    surface: isCatalog ? 'catalog' : 'form',
    indent: site.productsIndent || '            ',
    membership: members,
    filterToGroups: members ? false : Boolean(src.filterToGroups),
    leafSet: new Set(groupLeafNames(src.groups || [])),
    // 覆盖也取 src：画册站自己没有 overrides，写成 site.overrides 的话，
    // 同一型号在选款页是本站覆盖值、在它自己的画册页却是产品库默认值，两套口径对不上
    //（今天靠 catalogOff 管画册、画册页也不读这两项，看不出差别，但数据是错的）。
    overrides: src.overrides || {},
    order: Array.isArray(src.order) ? src.order : null,
    catalogOff: isCatalog && src.catalogOff ? new Set(src.catalogOff) : null,
  };
}

// ---------------------------------------------------------------- 配置区解析 / 发射

export function parseJsObjectBlock(content) {
  // 只支持我们关心的几种简单字面量：标量 + 字符串数组
  const text = content.join('\n').replace(/\/\/[^\n]*/g, '');
  const body = text.replace(/^\s*\{/, '').replace(/\}\s*$/, '');
  const obj = {};
  // 布尔字面量必须出现在值分支里，否则 enabled: true 这类字段会被整条跳过（曾经导致水印配置丢字段）
  const re = /(enabled|speed|items|storageKey|text|color|opacity|fontSize|fontWeight|angle|tileWidth|tileHeight|fontFamily)\s*:\s*(\[[^\]]*\]|'[^']*'|"[^"]*"|true|false|-?[\d.]+)/g;
  let m;
  while ((m = re.exec(body))) {
    const key = m[1];
    const raw = m[2].trim();
    if (raw.startsWith('[')) {
      obj[key] = [...raw.matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g)].map((q) => unquoteJS(q[1] ?? q[2]));
    } else if (raw === 'true') obj[key] = true;
    else if (raw === 'false') obj[key] = false;
    else if (/^-?[\d.]+$/.test(raw)) obj[key] = Number(raw);
    else obj[key] = unquoteJS(raw.slice(1, -1));
  }
  return obj;
}

function quoteJS(s) {
  return `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}
function unquoteJS(s) {
  return String(s).replace(/\\'/g, "'").replace(/\\\\/g, '\\');
}

export function emitPromo(cfg) {
  const items = (cfg.items || []).map((t, i, a) => `                ${quoteJS(t)}${i < a.length - 1 ? ',' : ''}`);
  return [
    `            // 1) 是否显示通知栏：true = 显示，false = 隐藏（隐藏后页面自动回到无栏状态）`,
    `            enabled: ${cfg.enabled !== false},`,
    ``,
    `            // 2) 滚动速度：数字 = 滚一轮所需的秒数。`,
    `            //    数字越小越快，越大越慢（推荐 15~40，默认 25）`,
    `            speed: ${Number(cfg.speed) || 25},`,
    ``,
    `            // 3) 通知内容：数组里每一项会首尾相连循环滚动，可只写一条，也可写多条。`,
    `            //    文案中用 <b></b> 包裹的部分会高亮成黄色（例：“<b>50% OFF</b>”）。`,
    `            items: [`,
    ...items,
    `            ]`,
  ];
}

export function emitStorage(key) {
  return [`        const STORAGE_KEY = ${quoteJS(key)};`];
}

/** 从一行 <title>…</title> 里取出标题文本（不是 title 行则返回 null） */
export function parseTitle(line) {
  const m = /^\s*<title>(.*)<\/title>\s*$/.exec(String(line || ''));
  return m ? m[1] : null;
}

export function emitTitle(title, indent) {
  return [`${indent}<title>${title}</title>`];
}

export function emitDisabled(ids) {
  const list = ids.map((i) => quoteJS(i)).join(', ');
  return [`        const DISABLED_PRODUCT_IDS = [${list}];`];
}

const WATERMARK_DOC = {
  enabled: '一键开关：false = 不显示水印',
  text: '水印文字（英文通用字样）',
  color: '白色：产品图为黑底，白字在黑底/深色区最清晰',
  opacity: '透明度，建议 0.15 ~ 0.25',
  fontSize: '字号（px）',
  fontWeight: '加粗：低透明度下仍清晰可辨',
  angle: '斜向角度（度），负值 = 左上到右下',
  tileWidth: '平铺单元宽度（px）',
  tileHeight: '平铺单元高度（px）',
  fontFamily: '字体栈',
};

// 水印字段全集：build 发射、admin 面板、validate 校验共用这一张表，避免三处各写一份而漂移
export const WATERMARK_KEYS = ['enabled', 'text', 'color', 'opacity', 'fontSize', 'fontWeight', 'angle', 'tileWidth', 'tileHeight', 'fontFamily'];

export function emitWatermark(w) {
  const src = w || {};
  // enabled 之外的字段缺失一律当场报错：写出去会是 `fontSize: undefined`，
  // 产物页面看着正常，水印却会静默消失或渲染出错，这类问题必须拦在生成之前。
  const missing = WATERMARK_KEYS.filter((k) => k !== 'enabled' && src[k] === undefined);
  if (missing.length) throw new Error(`watermark 缺少字段：${missing.join('、')}`);
  return WATERMARK_KEYS.map((k) => {
    const raw = k === 'enabled' ? String(src.enabled !== false)
      : typeof src[k] === 'string' ? quoteJS(src[k])
        : String(src[k]);
    const head = `            ${k}: ${raw},`;
    // 长值（如 fontFamily）超出对齐宽度时也要留出一个空格，不然注释会紧贴到逗号后面
    return head.padEnd(Math.max(44, head.length + 1), ' ') + '// ' + WATERMARK_DOC[k];
  });
}

// 分组值：字符串 = 二级叶子分类；{name, children} = 二级子组（三级能力，目前线上未使用）
export function groupLeafNames(groups) {
  const out = [];
  for (const g of groups || []) {
    for (const e of g.entries || []) {
      if (typeof e === 'string') out.push(e);
      else out.push(...(e.children || []));
    }
  }
  return out;
}

export function emitGroupMap(groups) {
  return (groups || []).map((g, i, arr) => {
    const parts = (g.entries || []).map((e) => typeof e === 'string'
      ? quoteJS(e)
      : `{ name: ${quoteJS(e.name)}, children: [${(e.children || []).map(quoteJS).join(', ')}] }`);
    return `            ${quoteJS(g.name)}: [${parts.join(', ')}]${i < arr.length - 1 ? ',' : ''}`;
  });
}

/** 解析 categoryGroupMap 区段为 [{ name, entries }] */
export function parseGroupMap(content) {
  const groups = [];
  // 线上格式固定为每个分组一行，故按行解析
  for (const line of content) {
    const m = /^\s*'([^']+)':\s*\[(.*)\]\s*,?$/.exec(line);
    if (!m) continue;
    const entries = [];
    const inner = m[2];
    const reObj = /\{\s*name:\s*'([^']*)',\s*children:\s*\[([^\]]*)\]\s*\}/g;
    const reStr = /'((?:[^'\\]|\\.)*)'/g;
    // 先摘对象，再摘剩余字符串
    const objs = [...inner.matchAll(reObj)].map((q) => ({
      name: unquoteJS(q[1]),
      children: [...q[2].matchAll(reStr)].map((s) => unquoteJS(s[1])),
    }));
    const withoutObjs = inner.replace(reObj, '');
    for (const s of withoutObjs.matchAll(reStr)) {
      if (!objs.some((o) => o.name === s[1])) entries.push(unquoteJS(s[1]));
    }
    for (const o of objs) entries.push(o);
    groups.push({ name: unquoteJS(m[1]), entries });
  }
  if (!groups.length) throw new Error('GROUPMAP 解析结果为空，请检查格式');
  return groups;
}

// 允许调用方把整段原始文本直接透传（配置未被改动时，产物与今日逐字节一致）
export function shouldPassthrough(parsedRawObj, currentCfg) {
  return JSON.stringify(normalizeCfg(parsedRawObj)) === JSON.stringify(normalizeCfg(currentCfg));
}

export function normalizeCfg(o) {
  if (!o || typeof o !== 'object') return o;
  const keys = Object.keys(o).sort();
  const out = {};
  for (const k of keys) out[k] = Array.isArray(o[k]) ? o[k].map((x) => String(x)) : o[k];
  return out;
}

// ---------------------------------------------------------------- 校验

// normal 正常可选 / disabled 置灰可看 / presale 预售（显示 Pre Sale、不可填）/ hidden 下架（写成注释行）
export const FORM_STATES = ['normal', 'disabled', 'presale', 'hidden'];

/**
 * 产物纯净黑名单：线上文件里不该出现的后台痕迹（check.mjs 与 publish.mjs 共用）。
 * tools 只查路径形式（tools/ 或 tools\）：Font Awesome 自带 .fa-tools 图标类，
 * 写成 \btools\b 会把 vendor 的 CSS 整个误判为脏。
 */
export const FORBIDDEN_OUTPUT = [/admin/i, /tools[\\/]/, /\/api\//, /\.mjs\b/, /products\.json/, /sites\.json/];

export function validate(products, sites) {
  const errors = [];
  const seen = new Set();
  products.forEach((p, i) => {
    if (!p.id) errors.push({ index: i, field: 'id', msg: 'id 为空' });
    if (seen.has(p.id)) errors.push({ index: i, field: 'id', msg: `id 重复: ${p.id}` });
    seen.add(p.id);
    if (/['"]/.test(p.id)) errors.push({ index: i, field: 'id', msg: `id 含引号，会截断内联 oninput: ${p.id}` });
    if (/['"]/.test(p.name)) errors.push({ index: i, field: 'name', msg: `name 含引号: ${p.name}` });
    if (/,/.test(p.id)) errors.push({ index: i, field: 'id', msg: `id 含逗号，会错位 CSV 列: ${p.id}` });
    if (!/^(https?:\/\/|data:|\/)/.test(p.image)) errors.push({ index: i, field: 'image', msg: `image 不是合法 URL: ${p.image}` });
    if (!/\.(jpg|jpeg|png|webp|avif|gif)$/i.test(p.image.split('?')[0])) {
      errors.push({ index: i, field: 'image', msg: `image 扩展名异常: ${p.image}` });
    }
    if (!FORM_STATES.includes(p.form)) errors.push({ index: i, field: 'form', msg: `form 非法: ${p.form}` });
    // 起订量：留空 / null 表示不限；写了就必须是正整数（不接受小数与负数）
    if (p.moq !== undefined && p.moq !== null && p.moq !== '') {
      if (!Number.isInteger(p.moq) || p.moq < 1) {
        errors.push({ index: i, field: 'moq', msg: `moq 起订量必须是正整数或留空：${p.id} = ${JSON.stringify(p.moq)}` });
      }
    }
    // catalog 已退役成「站点级 catalogOff」，这里只作迁移期兼容：有值就仍要求是布尔，没有也合法
    if (p.catalog !== undefined && typeof p.catalog !== 'boolean') {
      errors.push({ index: i, field: 'catalog', msg: `catalog 必须是布尔: ${p.id}` });
    }
    if (!p.category) errors.push({ index: i, field: 'category', msg: `category 为空: ${p.id}` });
  });

  // key 与产物路径是站点的身份和落点：写坏了不会当场报错，只会互相覆盖
  // 或者在别处新建一个垃圾目录（真正的页面停在旧内容），所以这里就拦住
  const seenKeys = new Set();
  const seenFiles = new Set();
  for (const s of sites) {
    if (!s.key) errors.push({ index: -1, field: 'key', msg: '有一个站点没写 key（侧栏下拉与画册 owner 都靠它认人）' });
    else if (seenKeys.has(s.key)) errors.push({ index: -1, field: 'key', msg: `站点 key 重复：${s.key}` });
    seenKeys.add(s.key);
    const f = String(s.file || '');
    const parts = f.split('/');
    if (!f.endsWith('.html') || parts.length < 2 || parts.some((x) => !x || x === '..')) {
      errors.push({ index: -1, field: 'file', msg: `站点 ${s.key}: 产物路径要写成「目录/名字.html」（例如 TPU/index.html），当前是 ${JSON.stringify(s.file)}；照这样的生成器会把那个位置当成新站点去建目录，真页面却停在旧内容` });
    } else if (seenFiles.has(f)) {
      errors.push({ index: -1, field: 'file', msg: `两个站点的产物路径撞了：${f}（后生成的那个会把前一个抹掉）` });
    }
    seenFiles.add(f);
    if (!s.title) errors.push({ index: -1, field: 'title', msg: `站点 ${s.key}: 页面标题为空，浏览器标签页会没有名字` });
    else if (/[<>]/.test(s.title)) errors.push({ index: -1, field: 'title', msg: `站点 ${s.key}: 页面标题不能含尖括号：${s.title}` });
    if (s.type === 'catalog') {
      // 画册站的成员与排除表全部来自 owner，指错了不会报错、只会静默按旧行为跑，必须校住
      if (!s.owner) errors.push({ index: -1, field: 'owner', msg: `站点 ${s.key}: 画册站没有 owner，不知道跟随哪个选款站` });
      else if (!sites.find((x) => x.key === s.owner)) {
        errors.push({ index: -1, field: 'owner', msg: `站点 ${s.key}: owner 指向不存在的站点 ${s.owner}` });
      }
      const w = s.watermark || {};
      const missing = WATERMARK_KEYS.filter((k) => w[k] === undefined);
      if (missing.length) errors.push({ index: -1, field: 'watermark', msg: `站点 ${s.key}: watermark 缺少字段 ${missing.join('、')}，生成会失败` });
      else if (typeof w.enabled !== 'boolean') errors.push({ index: -1, field: 'watermark', msg: `站点 ${s.key}: watermark.enabled 必须是布尔，当前是 ${JSON.stringify(w.enabled)}` });
      else if (typeof w.opacity !== 'number' || w.opacity < 0 || w.opacity > 1) errors.push({ index: -1, field: 'watermark', msg: `站点 ${s.key}: watermark.opacity 需在 0~1 之间，当前是 ${w.opacity}` });
      continue;
    }
    // 站点的成员名单、顺序、画册排除表：里面的型号必须在产品库里存在，否则就是删产品留下的幽灵条目
    for (const [field, list] of [['members', s.members], ['catalogOff', s.catalogOff], ['order', s.order]]) {
      for (const id of list || []) {
        if (!products.some((p) => p.id === id)) {
          errors.push({ index: -1, field, msg: `站点 ${s.key}: ${field} 里的 ${id} 在产品库中不存在` });
        }
      }
    }
    // 本站覆盖：状态必须是四态之一，起订量写了就必须是正整数；写坏了不会报错只会静默出错页
    for (const [id, ov] of Object.entries(s.overrides || {})) {
      if (!products.some((p) => p.id === id)) {
        errors.push({ index: -1, field: 'overrides', msg: `站点 ${s.key}: overrides 里的 ${id} 在产品库中不存在` });
      }
      // 覆盖是给「本站要显示的型号」用的：不是成员的话这条配置永远轮不到执行。
      // 留着不但没人看得懂，将来把型号加回本站时还会悄悄复活一份旧设置。
      // 只在它确实存在于产品库时才查成员关系：删产品留下的幽灵 id 上面已经报得更准，不刷两条。
      if (Array.isArray(s.members) && products.some((p) => p.id === id) && !s.members.includes(id)) {
        errors.push({ index: -1, field: 'overrides', msg: `站点 ${s.key}: ${id} 不是本站成员，这条本站覆盖永远不会生效（要它在本站卖就先「从产品库添加型号到本站」，不然就删掉这条覆盖）` });
      }
      if (ov.form !== undefined && !FORM_STATES.includes(ov.form)) {
        errors.push({ index: -1, field: 'overrides', msg: `站点 ${s.key}: ${id} 的本站状态非法：${ov.form}` });
      }
      if (ov.moq !== undefined && (!Number.isInteger(ov.moq) || ov.moq < 1)) {
        errors.push({ index: -1, field: 'overrides', msg: `站点 ${s.key}: ${id} 的本站起订量需是正整数：${JSON.stringify(ov.moq)}` });
      }
    }
    // 画册排除表里的非成员同样是死配置：画册先按成员过滤，轮不到它（幽灵 id 上面已报）
    if (Array.isArray(s.members)) {
      for (const id of s.catalogOff || []) {
        if (products.some((p) => p.id === id) && !s.members.includes(id)) {
          errors.push({ index: -1, field: 'catalogOff', msg: `站点 ${s.key}: 画册排除表里的 ${id} 不是本站成员，这条排除没有作用，可以直接删掉` });
        }
      }
    }
    // 摘取型站点（如 TPU）本来就只装部分分组，不报未归属
    if (s.type !== 'form' || s.filterToGroups) continue;
    const leaves = new Set(groupLeafNames(s.groups));
    for (const p of products) {
      if (!leaves.has(p.category) && p.form !== 'hidden') {
        errors.push({ index: products.indexOf(p), field: 'category', msg: `站点 ${s.key}: 分类「${p.category}」未挂在任何分组，产品 ${p.id} 将永久不可见` });
      }
    }
  }
  // 去重（同一分类会命中多条产品）
  const uniq = [];
  const key = (e) => `${e.field}|${e.msg}`;
  const seenMsg = new Set();
  for (const e of errors) { if (!seenMsg.has(key(e))) { seenMsg.add(key(e)); uniq.push(e); } }
  return uniq;
}
