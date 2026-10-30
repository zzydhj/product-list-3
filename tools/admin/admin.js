// admin.js —— 后台界面逻辑（只与本地 serve.mjs 的 /api 打交道）
//
// 职责边界：本文件只管「内存里的数据 + 交互」，落盘与生成全部交给服务端，
// 页面产物由 tools/build.mjs 负责，界面永远不直接改 HTML。

const S = {
  products: [],
  sites: [],
  siteKey: '',
  selId: null,
  checked: new Set(),
  filter: { q: '', status: 'all', cat: '' },
  undo: [],
  redo: [],
  bad: new Set(),      // 图片检测失败的 url
  saved: '',           // 上一次落盘时的数据快照，用于判断「有无未保存修改」
};

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

let previewWin = null;      // 预览标签的句柄，开过就复用，不重复弹窗

async function api(path, body) {
  const opt = body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : undefined;
  const r = await fetch(path, opt);
  const data = await r.json().catch(() => ({}));
  noteStale(data);          // 任何一次响应发现服务端代码过期，立刻挂横幅
  if (!r.ok) throw Object.assign(new Error(data.error || `请求失败 ${r.status}`), { data });
  return data;
}

/**
 * 后台界面是静态文件（刷新即最新），但 serve 进程内存里的 lib.mjs 是启动时加载的。
 * 两者不一致时就会出现「界面能选预售、服务端却判它非法」这种错位，必须明说让人重启。
 */
function noteStale(data) {
  const b = $('#staleWarn');
  if (!b || !data) return;
  if ('stale' in data) { b.hidden = data.stale === false; return; }   // 新版 serve：按它报的算
  // /api/state 能认但没带 stale 字段 = 这个 serve 比检测逻辑还旧，更该重启
  if ('products' in data) b.hidden = false;
}

function toast(msg, kind = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast ' + kind;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, 3200);
}

/**
 * 日志按次追加：每条一个标题行（时间 + 做了什么 + 成败）加一段正文，新的排最上面。
 * 为什么不再整块替换纯文本：那个后台的成败直接决定人要不要继续改，
 * 而旧版一次成功之后屏幕上可能还挂着上一次失败的那段 400，看着就像「还是被拒」。
 */
const LOG_MAX = 30;
const LOG_KIND_TEXT = { ok: '成功', bad: '失败', info: '记录' };
const logEntries = [];
const hhmmss = (d) => [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');

function printLog(label, kind, text) {
  logEntries.unshift({
    t: new Date(), label,
    kind: LOG_KIND_TEXT[kind] ? kind : 'info',
    text: (text === undefined || text === null || text === '') ? '（无输出）' : String(text),
  });
  if (logEntries.length > LOG_MAX) logEntries.length = LOG_MAX;
  const box = $('#log');
  box.innerHTML = '';
  for (const e of logEntries) {
    box.append(
      el('div', 'log-head ' + e.kind, `${hhmmss(e.t)}  ${e.label} · ${LOG_KIND_TEXT[e.kind]}`),
      el('div', 'log-body', e.text)
    );
  }
  $('#backupList').textContent = '';
}

// ---------------------------------------------------------------- 站点辅助

/**
 * 产品库不是一个站点，但整套界面是一套「按当前上下文渲染」的代码，
 * 所以给它一个不落库的合成定义：type='library' 时各处走产品库分支。
 * 产品库只管型号本身（名称 / 图片 / 分类 / 默认状态 / 默认起订量 / 真删除）。
 */
const LIBRARY_KEY = '__library';
const LIBRARY_SITE = { key: '产品库', type: 'library', file: '', title: '', groups: [], overrides: {}, filterToGroups: false };
const isLibrary = () => S.siteKey === LIBRARY_KEY;
const site = () => (isLibrary() ? LIBRARY_SITE : (S.sites.find((s) => s.key === S.siteKey) || S.sites[0]));
const isForm = () => site().type === 'form';
const leafSet = () => new Set(groupLeaves(site().groups || []));
/** 某型号是否已被任意站点收录（产品库视图用它判断「未加入站点」）*/
const inAnySite = (id) => S.sites.some((s) => Array.isArray(s.members) && s.members.includes(id));
/**
 * 当前视图的成员名单该看哪个站点。画册站自己没有名单，看它 owner 的；
 * 网格范围、统计行、勾选弹窗的可添加池全部走这一个函数，免得各算一套对不上。
 */
function memberSource() {
  const s = site();
  return s.type === 'catalog' ? (S.sites.find((x) => x.key === s.owner) || s) : s;
}

// ---------------------------------------------------------- 本站覆盖（状态 / 起订量）
// 原则：产品库存默认值，站点只存「与默认值不同的那一部分」。
// 选「跟随产品库」或填成与默认值一样的数，都不写覆盖，sites.json 保持干净。

const FORM_LABEL = { normal: '正常', disabled: '置灰', presale: '预售', hidden: '下架' };
/**
 * 本站的覆盖写在哪张定义上。画册视图操作的是它 owner 的选款页（与 catalogOff 同一套
 * 规矩），所以在「TPU 的画册」里看到的状态与在 TPU 里看到的必须一致。
 */
const ovSite = () => albumSite();
/**
 * 本站对某型号「真正与产品库不同」的覆盖（没有就返回空对象，省掉一堆判空）。
 * 与默认值同值的条目不算例外：你先在站点把它改成正常、之后回产品库把它上架，
 * 那条覆盖就不再有语义（生成时 {...p, ...ov} 输出完全一样），但它会让卡片一直挂着
 * 「本站改为正常」、把状态单选钉在「正常可选」而不是「跟随产品库」。写盘时由
 * store.saveState 调用 lib.pruneOverrides 删掉，这里的判读口径与它一致：
 * 未保存前界面也不能骗人。
 */
const moqNum = (v) => (Number.isInteger(v) && v > 0 ? v : undefined);
const SAME_AS_LIB = {
  form: (p, v) => v === p.form,
  moq: (p, v) => moqNum(v) === moqNum(p.moq),
};
const ovOf = (p) => {
  const s = ovSite();
  const raw = (s && s.overrides ? s.overrides[p.id] : null) || {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    const same = SAME_AS_LIB[k];
    if (!same || !same(p, v)) out[k] = v;      // 不认识的键一律算例外，别把以后新增的字段吞了
  }
  return out;
};
/** 某型号在某个站点生效的状态：本站覆盖优先于产品库默认值 */
function stateAt(p, s) {
  const src = s && s.type === 'catalog' ? (S.sites.find((x) => x.key === s.owner) || s) : s;
  const ov = src && src.overrides ? src.overrides[p.id] : null;
  return (ov && ov.form) || p.form;
}
/** 当前上下文下生效的状态 */
function effState(p) { return isLibrary() ? p.form : stateAt(p, ovSite()); }
/** 当前上下文下生效的起订量；undefined = 不限 */
function effMoq(p) {
  const v = isLibrary() ? p.moq : (ovOf(p).moq !== undefined ? ovOf(p).moq : p.moq);
  return Number.isInteger(v) && v > 0 ? v : undefined;
}
/** 本站是否为该型号记了例外（「本站有例外」筛选用它）*/
const hasOverride = (p) => !isLibrary() && Object.keys(ovOf(p)).length > 0;
/** 写一条本站覆盖；选「跟随」或填成与默认值一样，就把这条覆盖删掉，sites.json 保持干净 */
function setOverride(p, key, value) {
  const s = ovSite();
  if (!s || isLibrary()) return;
  const ov = s.overrides[p.id] || {};
  if (value === 'inherit' || value === undefined || value === p[key]) delete ov[key];
  else ov[key] = value;
  if (Object.keys(ov).length) s.overrides[p.id] = ov;
  else delete s.overrides[p.id];
}
/** 写起订量：产品库改默认值，站点改本站覆盖 */
function setMoq(p, v) {
  if (isLibrary()) { if (v === undefined) delete p.moq; else p.moq = v; return; }
  setOverride(p, 'moq', v);
}

// ---------------------------------------------------------- 本站顺序

/** 首次拖动时把当前成员顺序物化成显式名单 */
function materialiseOrder(s) { if (!Array.isArray(s.order)) s.order = membersAsOf(s); }
/** 本站成员的排列：按本站 order，没排进去的接在后面 */
function orderedMembers(s) {
  const ids = membersAsOf(s);
  if (!Array.isArray(s.order)) return ids;
  const listed = s.order.filter((id) => ids.includes(id));
  const rest = ids.filter((id) => !listed.includes(id));
  return [...listed, ...rest];
}

/**
 * 把各站对某个型号的引用从旧 id 搬到新 id：members / order / catalogOff 里存的是 id 字符串而不是对象，
 * 改完产品 id 不动这几份名单的话，旧 id 就地变成幽灵条目（保存被校验拦住），
 * 而改名后的型号会因为「不在本站名单里」直接从页面上消失 —— 后者比报错难得查得多。
 * 只改写已经存在的名单：没物化过 order 的站点不能被这里无中生有写出一个 419 条的数组（那是个大 diff）。
 */
function moveSiteRefs(oldId, newId) {
  if (!oldId || !newId || oldId === newId) return;
  for (const s of S.sites) {
    for (const key of ['members', 'order', 'catalogOff']) {
      if (!Array.isArray(s[key])) continue;
      const i = s[key].indexOf(oldId);
      if (i === -1) continue;
      // 新 id 已在名单里（往一个已存在的型号名字上改）：丢旧留新，别写出重复条目
      if (s[key].includes(newId)) s[key].splice(i, 1);
      else s[key][i] = newId;
    }
    if (s.overrides && s.overrides[oldId]) {
      if (!s.overrides[newId]) s.overrides[newId] = s.overrides[oldId];
      delete s.overrides[oldId];
    }
  }
}

function groupLeaves(groups) {
  const out = [];
  for (const g of groups) for (const e of g.entries) out.push(...(typeof e === 'string' ? [e] : e.children || []));
  return out;
}

/**
 * 当前站点对应的「选款站」：画册站操作的是它 owner 的排除表，
 * 所以在「TPU 的画册」视图里勾选与在 TPU 视图里勾选改的是同一份数据。
 */
function albumSite() {
  const s = site();
  if (!s) return null;
  return s.type === 'catalog' ? (S.sites.find((x) => x.key === s.owner) || null) : s;
}

/**
 * 本站画册实际会印多少条 = 配套画册站的渲染成员数。
 * 不能简单数「没被 catalogOff 排除的产品」：那会把不属于本站分组的产品也算进去
 * （TPU 只有 182 款，却会报成 420）。分组范围只有走 siteProducts 才算得对。
 */
function albumCount() {
  const s = site();
  if (!s) return 0;
  const album = s.type === 'catalog' ? s : S.sites.find((x) => x.type === 'catalog' && x.owner === s.key);
  return album ? siteProducts(album).length : 0;
}

/** 某产品是否在指定选款站的画册里。站点没有 catalogOff 时回退旧的产品级布尔（迁移兼容）*/
function inAlbum(s, p) {
  if (!s) return p.catalog !== false;
  if (Array.isArray(s.catalogOff)) return !s.catalogOff.includes(p.id);
  return p.catalog !== false;
}

/** 改某产品在指定选款站的画册归属。老站点第一次改动时先把产品级布尔物化成排除表 */
function setInAlbum(s, p, on) {
  if (!s) return;
  if (!Array.isArray(s.catalogOff)) s.catalogOff = S.products.filter((x) => x.catalog === false).map((x) => x.id);
  const i = s.catalogOff.indexOf(p.id);
  if (on && i !== -1) s.catalogOff.splice(i, 1);
  else if (!on && i === -1) s.catalogOff.push(p.id);
}

/** 某站点当前的成员名单（只读）：已物化的直接拿，未物化的按旧规则算一遍 */
function membersAsOf(s) {
  if (Array.isArray(s.members)) return s.members.slice();
  const leaves = new Set(groupLeaves(s.groups || []));
  return S.products.filter((p) => !s.filterToGroups || leaves.has(p.category)).map((p) => p.id);
}

/**
 * 把未物化站点的成员名单补成显式表。算法与当初的迁移一致：取「现在会出现在 PRODUCTS
 * 区里的全部型号」，包含下架的（它们在页面里是注释行）。只取未下架的那些会把
 * 注释行弄丢，产物就变了。只在用户真的动成员时才调用（渲染路径上不能改数据）。
 */
function materialiseMembers(s) {
  if (!Array.isArray(s.members)) s.members = membersAsOf(s);
}

/** 把若干型号加入当前站点。只改本站 members，产品库与其他站不受影响 */
function addMembers(ids) {
  const s = site();
  if (!ids.length) return;
  if (!ownsMembers(s)) {
    return toast(`${s.key} 没有自己的成员名单，不能往这里加型号（画册的成员跟随它的选款站）`, 'bad');
  }
  snapshot();
  materialiseMembers(s);
  const added = ids.filter((id) => !s.members.includes(id));
  s.members.push(...added);
  renderAll();
  toast(added.length ? `已把 ${added.length} 个型号加入 ${s.key}` : '这些型号已在本站', added.length ? '' : 'bad');
}

/**
 * 当前站点是否拥有自己的成员名单：只有选款站有。画册站的成员从 owner 派生，
 * LIBRARY_SITE 是合成对象同样没有。面板按钮、右键菜单与下面两个写入函数共用这一个判据 ——
 * 入口各算一套口径的话，就会留下「菜单给了、按钮没给」那种静默写错数据的口子。
 */
const ownsMembers = (s) => s.type === 'form';
const canRemoveMember = (p) => ownsMembers(site()) && membersAsOf(site()).includes(p.id);

/** 移出本站：只删本站名单里的这一条，产品库里还在，别的站也在 */
function removeMember(p) {
  const s = site();
  // 画册站身上写 members：生成器不读（它只从 owner 取成员），validate 对画册站又直接 continue，
  // 结果是「弹了成功、页面一个字没变、sites.json 多出一份 400 条的没人用的数组」。
  if (!ownsMembers(s)) {
    return toast(`${s.key} 没有自己的成员名单：请到它对应的选款站点里移出成员`, 'bad');
  }
  snapshot();
  materialiseMembers(s);
  s.members = s.members.filter((x) => x !== p.id);
  // 本站覆盖与画册排除表里它的条目一起带走：它已不是本站成员，这些配置永远轮不到执行；
  // 留着不但没人看得懂，将来把型号加回本站时还会悄悄复活一份他自己都忘了的旧设置。
  const hadOv = Boolean(s.overrides && s.overrides[p.id]);
  if (hadOv) delete s.overrides[p.id];
  const hadOff = Array.isArray(s.catalogOff) && s.catalogOff.includes(p.id);
  if (hadOff) s.catalogOff = s.catalogOff.filter((x) => x !== p.id);
  S.checked.delete(p.id);
  // 与真删除同一套处理：卡片已从本站网格消失，右侧就不能再停在一个左边选不中的型号上，
  // 否则覆盖控件会静默回落到默认值，看着像“覆盖还在、只是表单脏了”。
  if (S.selId === p.id) S.selId = null;
  renderAll();
  const cleaned = hadOv && hadOff ? '，本站覆盖与画册排除里的它一并清掉了'
    : hadOv ? '，本站覆盖也一并清掉了' : hadOff ? '，画册排除里的它也一并清掉了' : '';
  toast(`已把 ${p.id} 移出 ${s.key}（产品库和其他站点未受影响${cleaned}）`);
}

// ---------------------------------------------------------------- 从产品库挑型号（勾选式）

const pickerSel = new Set();

function openPicker() {
  const s = site();
  if (isLibrary() || s.type === 'catalog') return toast('请先在上方选一个选款站点', 'bad');
  pickerSel.clear();
  $('#picker').hidden = false;
  $('#picker-title').textContent = `从产品库添加型号到「${s.key}」`;
  $('#picker-search').value = '';
  renderPicker();
  $('#picker-search').focus();
}

function renderPicker() {
  const box = $('#picker-list');
  box.innerHTML = '';
  const have = new Set(membersAsOf(memberSource()));
  const q = $('#picker-search').value.trim().toLowerCase();
  const pool = S.products.filter((p) => !have.has(p.id) && (!q || `${p.id} ${p.name} ${p.category}`.toLowerCase().includes(q)));
  $('#picker-count').textContent = `已选 ${pickerSel.size} 个 · 本站已有 ${have.size} 个 · 可添加 ${pool.length} 个`;
  $('#picker-ok').disabled = pickerSel.size === 0;   // 一个没选时不给点，避免空操作
  if (!pool.length) { box.appendChild(el('div', 'empty', '没有可添加的型号了（产品库里的都已在本站）')); return; }
  for (const p of pool) {
    const row = el('label', 'pick-row' + (pickerSel.has(p.id) ? ' on' : ''));
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = pickerSel.has(p.id);
    cb.onchange = () => { if (cb.checked) pickerSel.add(p.id); else pickerSel.delete(p.id); renderPicker(); };
    const img = document.createElement('img');
    img.src = p.image;
    img.loading = 'lazy';
    img.alt = '';
    row.append(cb, img, el('span', 'pick-id', p.id), el('span', 'pick-meta', `${p.name} · ${p.category}`));
    box.appendChild(row);
  }
}

function closePicker() { const m = $('#picker'); if (m) m.hidden = true; }

/** 该站点实际会渲染出来的产品（画册站的成员范围与排除表全部来自 owner）*/
function siteProducts(s) {
  // 成员来源与生成器同语义：显式 members 名单优先，没有名单才退回「按分组自动摘取」
  const memberOk = (src, p) => {
    if (Array.isArray(src.members)) return src.members.includes(p.id);
    if (src.filterToGroups) return new Set(groupLeaves(src.groups || [])).has(p.category);
    return true;
  };
  if (s.type === 'catalog') {
    const owner = S.sites.find((x) => x.key === s.owner) || null;
    if (!owner) return S.products.filter((p) => inAlbum(null, p));
    return S.products.filter((p) => memberOk(owner, p) && inAlbum(owner, p));
  }
  return S.products.filter((p) => memberOk(s, p) && stateAt(p, s) !== 'hidden');
}

// ---------------------------------------------------------------- 变更与撤销

// 键序必须固定：delete 再加回同一个字段（清空起订量又填回去）会让 JSON 文本变了样，
// 不固定键序的话值其实一模一样，却被判成「有未保存的修改」。
// 这里用「人读得顺的固定字段序」而不是 Object.keys().sort()，因为同一个键序还得是
// 落盘时的键序：以前撤销是从排过序的快照字符串 JSON.parse 回来的，内存里的对象就此
// 变成字母序，下一次保存把 420 条整体重排写回 products.json——数据一个字没错，但整
// 个文件全是 diff，备份列表与人工比对都看不出改了啥。内存、快照、磁盘三处必须同一个顺序。
const PFIELDS = ['id', 'name', 'category', 'image', 'form', 'moq', 'notes', 'catalog'];
const canon = (p) => Object.fromEntries([
  ...PFIELDS.filter((k) => k in p),
  ...Object.keys(p).filter((k) => !PFIELDS.includes(k)),
].map((k) => [k, p[k]]));

const serialize = () => JSON.stringify({ products: S.products.map(canon), sites: S.sites });
const isDirty = () => serialize() !== S.saved;

function snapshot() {
  const cur = serialize();
  if (S.undo[S.undo.length - 1] === cur) return;   // 连续聚焦不重复入栈
  S.undo.push(cur);
  if (S.undo.length > 60) S.undo.shift();
  S.redo.length = 0;
}

/** 顶栏与历史按钮状态集中同步：dirty 由「与磁盘快照比」得出，避免撤销回去后还挂着未保存 */
function syncBars() {
  $('#dirtyFlag').hidden = !isDirty();
  $('#btnUndo').disabled = S.undo.length === 0;
  $('#btnRedo').disabled = S.redo.length === 0;
}

function restore(stateStr) {
  const st = JSON.parse(stateStr);
  // 快照里的对象也得过一遍 canon：新增/复制出来的条目键序不一定与固定顺序一致
  S.products = st.products.map(canon);
  S.sites = st.sites;
  if (st.siteKey) S.siteKey = st.siteKey;
}

/**
 * 撤销 / 重做前先跳过「退回去和现在一模一样」的空档。
 * 输入框获得焦点就留快照，但焦点之后不一定要改东西（点了一下没动、
 * 或者把值改回原样），栈里就会留下一条与当前完全相同的快照：不跳的话
 * 按一次 Ctrl+Z 看着什么也没发生，得再按一次，用起来像按键不灵。
 */
function undo() {
  const cur = serialize();
  while (S.undo.length && S.undo[S.undo.length - 1] === cur) S.undo.pop();
  if (!S.undo.length) return;
  S.redo.push(cur);
  restore(S.undo.pop());
  if (S.selId && !findProduct(S.selId)) S.selId = null;
  renderAll();
  toast('已撤销');
}

function redo() {
  const cur = serialize();
  while (S.redo.length && S.redo[S.redo.length - 1] === cur) S.redo.pop();
  if (!S.redo.length) return;
  S.undo.push(cur);
  restore(S.redo.pop());
  if (S.selId && !findProduct(S.selId)) S.selId = null;
  renderAll();
  toast('已重做');
}

// ---------------------------------------------------------------- 渲染

function renderAll() {
  renderSiteSelect();
  renderSiteTools();
  renderCats();
  renderStats();
  renderGrid();
  renderContextLabels();
  renderEditor();
  renderSiteForm();
  syncBars();
}

/**
 * 产品库字段在站点视图里锁为只读。id / name / category / image / notes 存在 products.json，
 * 全局只有一份：在站点视图里编辑它们改的也是这一份，所有卖这个型号的站一起变（不是「只改本站」）。
 * 以前这里能编辑，歧义直接导致事故：改完 id 在各站 members / order 里留下幽灵条目被校验拦住；
 * 而万一放过去，改名后的型号又会因为不在本站名单里而静默从页面上消失。
 */
const LIB_ONLY_FIELDS = ['#f-id', '#f-name', '#f-cat', '#f-image', '#f-notes'];
function lockLibraryFields(lib) {
  for (const sel of LIB_ONLY_FIELDS) {
    const e = $(sel);
    if (e) e.disabled = !lib;
  }
  const fill = $('#btnFillImage');      // 它按 ID 反推图片地址，同样是在写产品库字段
  if (fill) fill.disabled = !lib;
  // 新增 / 复制 / 真删都是往全局那一份 products.json 写记录：在某个站点里点，别的站会一起多出一条，
  // 而 addProduct 还拿当前站点的分组去定新型号的默认分类 —— 同一个动作在两个视图里结果并不一样。
  // 与字段锁同一口径：入口也只在产品库开（「从产品库删除」原本就已按 isLibrary 隐藏）。
  const add = $('#btnAdd');
  if (add) {
    add.disabled = !lib;
    add.title = lib
      ? '在产品库新增一条型号记录（默认正常状态，且还不属于任何站点）'
      : '新增产品只能在「产品库」视图做：它写的是全局那一份记录，不是本站';
  }
  const note = $('#liblock-note');
  if (!note) return;
  note.hidden = lib;
  if (!lib) {
    note.textContent = '型号 ID、显示名称、分类、图片、注释都是产品库字段：全局只有一份，' +
      '在任何站点视图里改它们，所有卖这个型号的站点会一起变。所以这里只读 —— ' +
      '要改请用左上「正在编辑」切到「产品库」，新增 / 复制 / 删除型号也只能在那里做。'
      + '本站能改的只有：本站状态、本站起订量、本站画册归属、成员与顺序。';
  }
}

/**
 * 面板标题与区块可见性只取决于「当前上下文」，与选中哪一条无关，所以单独一个函数
 * 放在 renderAll 里算：以前只在 renderEditor 里改，未选中产品时（面板整块隐藏）DOM
 * 里留的是 HTML 初值，面板一变可见就会闪出旧文案。
 */
function renderContextLabels() {
  const lib = isLibrary();
  const s = site();
  const albumView = s.type === 'catalog';
  lockLibraryFields(lib);
  // 同一块面板在产品库里是「默认值」、在站点里是「本站覆盖」，标题要说清楚这是哪回事
  $('#state-title').textContent = lib ? '选款表里的默认状态' : '本站状态（只影响本站）';
  $('#moq-label-text').textContent = lib ? '起订量（留空 = 不限）' : '本站起订量（留空 = 跟随产品库）';
  // 画册页不读 form / moq（成品页里查过了）：在画册视图里给说明，不给改了其实不会生效的控件；
  // 两个危险操作按钮在画册视图也全不适用，整块收起不然只剩个光秃秃的标题
  $('#state-moq-group').hidden = albumView;
  $('#state-moq-note').hidden = !albumView;
  $('#danger-zone').hidden = albumView;
  // 「跟随产品库」只在站点视图有意义：产品库里改的就是默认值本身，没有可跟随的对象
  $('#form-inherit').hidden = lib;
  // 画册归属是站点属性：产品库视图下没有「本站」可说，整块隐藏（只禁用会留下上一个站的残值，更误导）
  $('#album-group').hidden = lib;
  // 排序提示按上下文说清「这一拖拖的是谁」：产品库拖 = 改主数据默认顺序，站点拖 = 只改本站。
  // 画册视图里以前只有一句「拖动卡片可调整顺序」，与同一屏那句「请到 TPU 站里改」摆在一起
  // 看着像互相打脸，其实拖的就是 owner 站的顺序（成员与顺序都从 owner 派生）——直接说破。
  const oh = $('#orderHint');
  if (oh) {
    oh.textContent = lib
      ? '拖动卡片改的是产品库的默认顺序：没单独排过序的站点都跟着它走；右键卡片出更多操作。'
      : albumView
        ? `画册没有自己的名单与顺序：在这里拖动 / 上下移动，改的是「${s.owner || '?'}」站的顺序（它的选款页与本画册一起跟着变）。`
        : `拖动卡片只改「${s.key}」自己的顺序（产品库与其他站点一律不动），本站画册也按这个顺序渲染；右键卡片出更多操作。`;
  }
}

/** 只在一个上下文里成立的筛选项：切了视图得归位，不然切过去是个空网格 */
function filterOkHere(st) {
  if (st === 'unassigned') return isLibrary();
  if (st === 'nocat' || st === 'exception') return !isLibrary();
  return true;
}

function syncChips() {
  for (const c of document.querySelectorAll('#statusFilters .chip')) {
    c.classList.toggle('active', c.dataset.status === S.filter.status);
  }
}

/** 中栏顶部那行成员入口：产品库视图隐藏，画册站则告诉你去哪儿改 */
function renderSiteTools() {
  const bar = $('#sitetools');
  if (!bar) return;
  // 站点专属与产品库专属的按钮、chip：按上下文收起来（只改可见性，不改数据）
  document.querySelectorAll('#batchbar [data-batch^="catalog"]').forEach((b) => { b.hidden = isLibrary(); });
  document.querySelectorAll('#statusFilters [data-status]').forEach((b) => { b.hidden = !filterOkHere(b.dataset.status); });

  if (isLibrary()) { bar.hidden = true; return; }
  bar.hidden = false;
  const s = site();
  const btn = $('#btnAddMembers');
  const tip = $('#membertip');
  if (s.type === 'catalog') {
    btn.disabled = true;
    // 不说「请到那个站里改」：这里本来就能改（只是全部写到 owner 身上），说得不一致反而让人不敢动
    tip.textContent = `画册没有自己的名单与顺序：成员、画册归属与排序全部跟随「${s.owner || '?'}」站，在这里改也是改到那个站`;
    return;
  }
  btn.disabled = false;
  tip.textContent = `本站成员 ${membersAsOf(s).length} 个 · 将渲染 ${siteProducts(s).length} 个`;
}

function renderSiteSelect() {
  const sel = $('#siteSelect');
  sel.innerHTML = '';
  // 两个分组把「维护型号本身」与「维护某个站点」分开，避免在站点视图里误改全局
  const gLib = el('optgroup', '');
  gLib.label = '产品库';
  const oLib = el('option', '', '全部型号（维护产品本身）');
  oLib.value = LIBRARY_KEY;
  gLib.appendChild(oLib);
  sel.appendChild(gLib);

  const gSite = el('optgroup', '');
  gSite.label = '站点工作台';
  for (const s of S.sites) {
    const o = el('option', '', `${s.key}${s.type === 'catalog' ? `（${s.owner || ''} 的画册）` : ''}`);
    o.value = s.key;
    gSite.appendChild(o);
  }
  sel.appendChild(gSite);
  sel.value = S.siteKey;
}

function renderCats() {
  const box = $('#catList');
  box.innerHTML = '';
  const s = site();
  const counts = new Map();
  for (const p of S.products) counts.set(p.category, (counts.get(p.category) || 0) + 1);

  const mkAll = el('div', 'cat-item' + (S.filter.cat === '' ? ' active' : ''));
  mkAll.append(el('span', '', '全部分类'), el('span', 'n', String(S.products.length)));
  mkAll.onclick = () => { S.filter.cat = ''; renderAll(); };
  box.appendChild(mkAll);

  if (s.type === 'form') {
    for (const g of s.groups || []) {
      box.appendChild(el('div', 'cat-group', g.name));
      for (const leaf of (g.entries || []).filter((e) => typeof e === 'string')) {
        const d = el('div', 'cat-item' + (S.filter.cat === leaf ? ' active' : ''));
        d.append(el('span', '', leaf), el('span', 'n', String(counts.get(leaf) || 0)));
        d.onclick = () => { S.filter.cat = S.filter.cat === leaf ? '' : leaf; renderAll(); };
        box.appendChild(d);
      }
    }
    const orphans = [...new Set(S.products.map((p) => p.category))].filter((c) => !leafSet().has(c) && s.filterToGroups !== true);
    if (orphans.length) {
      box.appendChild(el('div', 'cat-group', '未归属（会永久不可见）'));
      for (const c of orphans) {
        const d = el('div', 'cat-item');
        d.append(el('span', '', c), el('span', 'n', String(counts.get(c) || 0)));
        d.onclick = () => { S.filter.cat = c; renderAll(); };
        box.appendChild(d);
      }
    }
  } else {
    for (const c of [...new Set(S.products.map((p) => p.category))]) {
      const d = el('div', 'cat-item' + (S.filter.cat === c ? ' active' : ''));
      d.append(el('span', '', c), el('span', 'n', String(counts.get(c) || 0)));
      d.onclick = () => { S.filter.cat = S.filter.cat === c ? '' : c; renderAll(); };
      box.appendChild(d);
    }
  }
}

function renderStats() {
  const box = $('#stats');
  box.innerHTML = '';
  // 产品库视图数的是全库；站点视图数的是本站成员按本站生效值（含覆盖）。
  // 两边共用一个 pool，否则「可选 350」配着一个只有一百多张卡片的网格，读数对不上。
  const pool = isLibrary() ? S.products : membersAsOf(memberSource()).map(findProduct).filter(Boolean);
  const n = (f) => pool.filter(f).length;
  const rows = [
    isLibrary() ? ['产品库型号总数', S.products.length] : [`${site().key} 成员`, pool.length],
    ['可选（正常）', n((p) => effState(p) === 'normal')],
    ['置灰', n((p) => effState(p) === 'disabled')],
    ['预售 Pre Sale', n((p) => effState(p) === 'presale')],
    ['设了起订量', n((p) => effMoq(p) !== undefined)],
    ['已下架', n((p) => effState(p) === 'hidden')],
  ];
  // 产品库视图与站点视图关心的是两件不同的事，不拼在一起显示
  if (isLibrary()) {
    rows.push(['未加入任何站点', n((p) => !inAnySite(p.id))]);
  } else {
    rows.push(['本站有例外', n(hasOverride)]);
    rows.push(['本站画册', albumCount()]);
    rows.push([`${site().key} 将渲染`, siteProducts(site()).length]);
  }
  rows.push(['分类数', new Set(pool.map((p) => p.category)).size]);
  for (const [k, v] of rows) {
    const d = el('div');
    d.append(document.createTextNode(k + ' '), el('b', '', String(v)));
    box.appendChild(d);
  }
}

function visible() {
  const q = S.filter.q.trim().toLowerCase();
  // 站点视图只列本站成员（「进哪个站只操作哪个站」）；画册站按 owner 的名单与顺序收，
  // 否则你在画册视图看到 420 个却不知道画册其实只有 182 个。产品库视图列全部型号。
  // 排序走本站自己的 order：在 TPU 里拖动不会把主站顺序也拖改了。
  const list = isLibrary() ? S.products.slice() : orderedMembers(memberSource()).map(findProduct).filter(Boolean);
  return list.filter((p) => {
    if (S.filter.status === 'unassigned' && inAnySite(p.id)) return false;
    if (S.filter.status === 'exception' && !hasOverride(p)) return false;
    if (S.filter.cat && p.category !== S.filter.cat) return false;
    if (S.filter.status === 'normal' && effState(p) !== 'normal') return false;
    if (S.filter.status === 'disabled' && effState(p) !== 'disabled') return false;
    if (S.filter.status === 'hidden' && effState(p) !== 'hidden') return false;
    if (S.filter.status === 'nocat' && inAlbum(albumSite(), p)) return false;
    if (q && !(`${p.id} ${p.name} ${p.category}`.toLowerCase().includes(q))) return false;
    return true;
  });
}

function renderGrid() {
  const grid = $('#grid');
  grid.innerHTML = '';
  const list = visible();
  $('#empty').hidden = list.length > 0;
  const frag = document.createDocumentFragment();

  for (const p of list) {
    const f = effState(p);
    const card = el('div', 'card' + (p.id === S.selId ? ' sel' : ''));
    if (f === 'disabled') card.classList.add('state-disabled');
    if (f === 'hidden') card.classList.add('state-hidden');
    if (S.bad.has(p.image)) card.classList.add('badimg');
    card.dataset.id = p.id;
    card.draggable = true;

    const thumb = el('div', 'thumb');
    const img = el('img');
    img.loading = 'lazy';
    img.src = p.image;
    img.onerror = () => { img.remove(); thumb.style.background = '#fee2e2'; };
    const badge = el('span', 'badge', p.id);
    thumb.append(img, badge);

    const pick = el('input', 'pick');
    pick.type = 'checkbox';
    pick.checked = S.checked.has(p.id);
    pick.onchange = () => { pick.checked ? S.checked.add(p.id) : S.checked.delete(p.id); renderBatch(); };
    pick.onclick = (e) => e.stopPropagation();
    thumb.appendChild(pick);

    const meta = el('div', 'meta');
    meta.append(el('div', 'name', p.name), el('div', 'cat', p.category));
    const tags = el('div', 'tags');
    // 被本站覆盖过的，徽标直接写「本站改为 X」：只加个后缀容易被当成产品库给的状态
    const ovr = isLibrary() ? {} : ovOf(p);
    const moq = effMoq(p);
    const mk = (cls, text) => tags.append(el('span', 'tag ' + cls,
      ovr.form ? `本站改为${FORM_LABEL[ovr.form] || ovr.form}` : text));
    if (f === 'normal') mk('on', '正常');
    if (f === 'disabled') mk('grey', '置灰');
    if (f === 'presale') mk('pre', 'Pre Sale');
    if (moq !== undefined) tags.append(el('span', 'tag moq', 'MOQ ' + moq + (ovr.moq !== undefined ? '（本站）' : '')));
    if (f === 'hidden') mk('out', '下架');
    // 产品库视图关心「它被哪些站收录」；站点视图已在某个站里，关心的是「在本站画册里吗」
    if (isLibrary()) {
      const n = S.sites.filter((x) => Array.isArray(x.members) && x.members.includes(p.id)).length;
      tags.append(n ? el('span', 'tag lib-in', `${n} 个站点`) : el('span', 'tag none', '未加入站点'));
    } else {
      const alb = inAlbum(albumSite(), p);
      tags.append(el('span', 'tag' + (alb ? ' on' : ''), alb ? '画册' : '不在画册'));
    }
    meta.append(tags);

    card.append(thumb, meta);
    card.onclick = () => { S.selId = p.id; renderGrid(); renderEditor(); };
    card.oncontextmenu = (e) => { e.preventDefault(); S.selId = p.id; renderGrid(); renderEditor(); openCtx(e.clientX, e.clientY, p); };
    attachDnd(card);
    frag.appendChild(card);
  }
  grid.appendChild(frag);
  renderBatch();
}

function renderBatch() {
  const bar = $('#batchbar');
  bar.hidden = S.checked.size === 0;
  $('#batchCount').textContent = String(S.checked.size);
}

function findProduct(id) { return S.products.find((p) => p.id === id); }

function renderEditor() {
  const p = S.selId ? findProduct(S.selId) : null;
  if (S.selId && !p) S.selId = null;      // 产品已被撤销/删除，不要把空值留在面板里
  $('#noSel').hidden = !!p;
  $('#editor').hidden = !p;
  if (!p) {
    // 面板虽然整块隐藏了，输入框里的值还留着；不清空的话下一次选中旧数据会闪一下
    for (const sel of ['#f-id', '#f-name', '#f-image', '#f-notes', '#f-moq']) $(sel).value = '';
    // radio 和复选框同理：不取消勾选的话，面板重新显示的那一瞬间会停在上一个型号的选项上
    for (const rad of document.querySelectorAll('#f-form input[name=form]')) rad.checked = false;
    $('#f-catalog').checked = false;
    $('#e-id').textContent = '';
    $('#e-moq').textContent = '';
    return;
  }
  $('#f-id').value = p.id;
  $('#f-name').value = p.name;
  $('#f-image').value = p.image;
  $('#f-catalog').checked = isLibrary() ? true : inAlbum(albumSite(), p);
  // 起订量只有正整数才有意义，不设就留空（空 = 不限，生成时也不会写进产品行）
  const moqNow = effMoq(p);
  $('#f-moq').value = moqNow === undefined ? '' : moqNow;
  // 站点视图下留空就是「跟随产品库」，把默认值写在占位里，不然你不知道会跟到多少
  $('#f-moq').placeholder = isLibrary() ? '不限制'
    : `跟随产品库（${Number.isInteger(p.moq) && p.moq > 0 ? p.moq : '不限'}）`;
  $('#e-moq').textContent = '';
  $('#f-notes').value = (p.notes || []).join('\n');
  $('#e-id').textContent = idProblem(p.id) || '';

  const catSel = $('#f-cat');
  catSel.innerHTML = '';
  for (const c of [...new Set(S.products.map((x) => x.category))].sort()) {
    const o = el('option', '', c);
    o.value = c;
    catSel.appendChild(o);
  }
  if (![...catSel.options].some((o) => o.value === p.category)) {
    const o = el('option', '', p.category);
    o.value = p.category;
    catSel.appendChild(o);
  }
  catSel.value = p.category;

  // 状态单选：产品库视图不给「跟随」选项；站点视图把默认值写在占位里，不然你不知道会跟到多少
  const inheritLab = $('#form-inherit');
  if (inheritLab) $('#form-inherit-text').textContent = `跟随产品库（当前：${FORM_LABEL[p.form] || p.form}）`;
  const wantState = isLibrary() ? p.form : (ovOf(p).form || 'inherit');
  for (const r of document.querySelectorAll('#f-form input[name=form]')) r.checked = r.value === wantState;
  // 真删只能在产品库；站点视图只给「移出本站」（且仅选款站自己持有成员名单）
  // 这两个跟选中项有关，留在本函数里；上下文相关的标题与分区可见性在 renderContextLabels
  $('#btnDelete').hidden = !isLibrary();
  $('#btnRemoveMember').hidden = !canRemoveMember(p);
  const pv = $('#previewImg');
  pv.src = p.image;
  pv.onerror = () => { pv.alt = '这张图打不开'; };
}

function idProblem(id) {
  if (!id) return 'ID 不能为空';
  if (/['"]/.test(id)) return "ID 里不能有引号，会让页面报错";
  if (/,/.test(id)) return 'ID 里不能有逗号，会错位导出的 CSV';
  if (/\s/.test(id)) return 'ID 里有空格，属于旧数据可继续用，但新建型号建议去掉';
  const dup = S.products.filter((p) => p.id === id).length;
  if (dup > 1) return 'ID 重复';
  return '';
}

// ---------------------------------------------------------------- 站点面板

function renderSiteForm() {
  const s = site();
  const box = $('#siteForm');
  box.innerHTML = '';
  if (isLibrary()) {
    box.appendChild(el('div', 'hint', '当前是产品库视图，没有站点设置。要改某个站的成员、分组、画册或水印，请在上方「站点工作台」里选中那个站。'));
    return;
  }

  const head = el('div', 'group-title', '基本信息');
  box.appendChild(head);
  // key 是站点的身份：画册站的 owner、侧栏下拉、报错文案都拿它认人。
  // 只改 s.key 不跟着改引用的话，一改名字它的画册就断开了。
  box.appendChild(field('站点 key', 'text', s.key, (v) => {
    const old = s.key;
    s.key = v;
    if (S.siteKey === old) S.siteKey = v;
    for (const x of S.sites) if (x.owner === old) x.owner = v;
    renderSiteSelect();
    renderAll();
  }));
  box.appendChild(field('产物路径', 'text', s.file, (v) => { s.file = v; }));
  box.appendChild(field('页面标题（浏览器标签页 / 收藏夹）', 'text', s.title, (v) => {
    s.title = v;
  }));
  if (s.type === 'form') box.appendChild(field('暂存 key（localStorage）', 'text', s.storageKey, (v) => { s.storageKey = v; }));

  if (s.type === 'form') {
    const en = el('label', 'switch');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = !!s.filterToGroups;
    cb.onchange = () => { snapshot(); s.filterToGroups = cb.checked; renderAll(); };
    en.append(cb, document.createTextNode(' 只装本分组的产品（摘取型站点，如 TPU）'));
    box.appendChild(en);

    box.appendChild(el('div', 'group-title', '顶部跑马灯'));
    const sp = el('label', '', '滚动一圈秒数');
    const spi = el('input');
    spi.type = 'number';
    spi.min = '5';
    spi.step = '1';
    spi.value = String((s.promo && s.promo.speed) || 25);
    spi.onchange = () => { snapshot(); s.promo = s.promo || {}; s.promo.speed = Number(spi.value) || 25; syncBars(); };
    sp.appendChild(spi);
    box.appendChild(sp);

    const enb = el('label', 'switch');
    const cb2 = el('input');
    cb2.type = 'checkbox';
    cb2.checked = !(s.promo && s.promo.enabled === false);
    cb2.onchange = () => { snapshot(); s.promo = s.promo || {}; s.promo.enabled = cb2.checked; syncBars(); };
    enb.append(cb2, document.createTextNode(' 显示通知栏'));
    box.appendChild(enb);

    const it = el('label', '', '通知文案（一行一条）');
    const ta = el('textarea');
    ta.rows = 3;
    ta.value = ((s.promo && s.promo.items) || []).join('\n');
    ta.onchange = () => { snapshot(); s.promo = s.promo || {}; s.promo.items = ta.value.split('\n').map((x) => x.trim()).filter(Boolean); syncBars(); };
    it.appendChild(ta);
    box.appendChild(it);

    box.appendChild(el('div', 'group-title', '分组（点 ↑↓ 换序；点 × 把分类移出分组）'));
    for (const g of s.groups) box.appendChild(groupBlock(s, g));

    const unassigned = [...new Set(S.products.map((p) => p.category))].filter((c) => !groupLeaves(s.groups).includes(c));
    if (unassigned.length) {
      box.appendChild(el('div', 'group-title', '尚未归属任何分组的分类'));
      const wrap = el('div', 'leaves');
      for (const c of unassigned) {
        const leaf = el('span', 'leaf', c);
        const b = el('button', '', '+');
        b.title = '加入下面的分组';
        b.onclick = async () => {
          const name = await askText('加入分组', `把「${c}」加入哪个分组？（输入一个没见过的名字会自动创建分组）`, s.groups[0]?.name || '');
          if (!name) return;
          let g = s.groups.find((x) => x.name === name);
          if (!g) { g = { name, entries: [] }; s.groups.push(g); }
          snapshot();
          g.entries.push(c);
          renderAll();
        };
        leaf.appendChild(b);
        wrap.appendChild(leaf);
      }
      box.appendChild(wrap);
    }

    const nb = el('button', '', '新增分组');
    nb.onclick = async () => {
      const name = await askText('新增分组', '分组名称', '新分组');
      if (!name) return;
      snapshot();
      s.groups.push({ name, entries: [] });
      renderAll();
    };
    box.appendChild(nb);
  }

  if (s.type === 'catalog') {
    box.appendChild(el('div', 'group-title', '水印'));
    const w = () => (s.watermark = s.watermark || {});
    const mk = (label, key, kind, attrs) => {
      box.appendChild(field(label, kind, s.watermark ? s.watermark[key] : '', (v) => {
        w()[key] = kind === 'number' ? Number(v) : v;
        renderStats();
      }, attrs));
    };
    const en = el('label', 'switch');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = (s.watermark || {}).enabled !== false;
    cb.onchange = () => { snapshot(); w().enabled = cb.checked; syncBars(); };
    en.append(cb, document.createTextNode(' 显示水印'));
    box.appendChild(en);
    // 字段名必须与 lib.mjs 的 WATERMARK_KEYS 逐一对应（build 发射时用的就是这张表）
    // number 框必须给 step/min/max：不给的话浏览器会按 step=1 判 0.3 非法，一直挂红
    mk('水印文字', 'text', 'text');
    mk('颜色', 'color', 'text');
    mk('透明度 0~1', 'opacity', 'number', { min: 0, max: 1, step: 0.01 });
    mk('字号 px', 'fontSize', 'number', { min: 1, max: 400, step: 1 });
    mk('字重', 'fontWeight', 'number', { min: 100, max: 900, step: 100 });
    mk('斜向角度（负值左上到右下）', 'angle', 'number', { min: -90, max: 90, step: 1 });
    mk('瓦片宽 px', 'tileWidth', 'number', { min: 20, max: 2000, step: 1 });
    mk('瓦片高 px', 'tileHeight', 'number', { min: 20, max: 2000, step: 1 });
    mk('字体栈', 'fontFamily', 'text');
  }

  box.appendChild(el('div', 'group-title', '危险操作'));
  const del = el('button', '', '删除本站点定义（不删文件）');
  del.onclick = async () => {
    if (!(await askOk('删除本站点定义', `确认从 sites.json 里移除 ${s.key}？产物文件不会被删除。`))) return;
    snapshot();
    S.sites = S.sites.filter((x) => x.key !== s.key);
    S.siteKey = S.sites[0].key;
    renderAll();
    toast('已移除站点定义，记得点保存', 'bad');
  };
  box.appendChild(del);

  const add = el('button', '', '从当前站点摘出一个新站点');
  add.onclick = () => openNewSiteDialog(s);
  box.appendChild(add);
}

function field(label, type, value, onChange, attrs) {
  const l = el('label', '', label);
  const i = el('input');
  i.type = type;
  i.value = value ?? '';
  if (attrs) for (const [k, v] of Object.entries(attrs)) i.setAttribute(k, String(v));
  // 快照与顶栏提示统一在这里做：以前要每个字段自己记一份，
  // 漏了的话改完既撤销不了也不显示「有未保存的修改」，只能靠运气。
  i.onchange = () => { snapshot(); onChange(i.value); syncBars(); };
  l.appendChild(i);
  return l;
}

function groupBlock(s, g) {
  const box = el('div', 'grp');
  const head = el('div', 'head');
  const name = el('input');
  name.value = g.name;
  name.onchange = () => { snapshot(); g.name = name.value; renderAll(); };
  const up = el('button', '', '↑');
  const down = el('button', '', '↓');
  const rm = el('button', '', '删除分组');
  const idx = () => s.groups.indexOf(g);
  up.onclick = () => { const i = idx(); if (i > 0) { snapshot(); [s.groups[i - 1], s.groups[i]] = [s.groups[i], s.groups[i - 1]]; renderAll(); } };
  down.onclick = () => { const i = idx(); if (i < s.groups.length - 1) { snapshot(); [s.groups[i + 1], s.groups[i]] = [s.groups[i], s.groups[i + 1]]; renderAll(); } };
  rm.onclick = async () => {
    if (!(await askOk('删除分组', `删除分组「${g.name}」？里面的分类会变成未归属，产品不会被删。`))) return;
    snapshot();
    s.groups.splice(idx(), 1);
    renderAll();
  };
  head.append(name, up, down, rm);
  box.appendChild(head);

  const leaves = el('div', 'leaves');
  for (const e of g.entries || []) {
    if (typeof e !== 'string') continue;
    const leaf = el('span', 'leaf', e);
    const up = el('button', '', '↑');
    up.title = '组内前移（决定侧栏里分类的先后）';
    up.onclick = () => moveLeaf(g, e, -1);
    const dn = el('button', '', '↓');
    dn.title = '组内后移';
    dn.onclick = () => moveLeaf(g, e, +1);
    const x = el('button', '', '×');
    x.title = '从该分组移除';
    x.onclick = () => {
      snapshot();
      g.entries.splice(g.entries.indexOf(e), 1);
      renderAll();
    };
    const mv = el('button', '', '→');
    mv.title = '移到其它分组';
    mv.onclick = async () => {
      const target = await askText('移到其它分组', `把「${e}」移到哪个分组？（输入一个没见过的名字会自动创建分组）`, s.groups.find((x2) => x2 !== g)?.name || '');
      if (!target) return;
      let t = s.groups.find((x2) => x2.name === target);
      if (!t) { t = { name: target, entries: [] }; s.groups.push(t); }
      snapshot();
      g.entries.splice(g.entries.indexOf(e), 1);
      t.entries.push(e);
      renderAll();
    };
    leaf.append(up, dn, mv, x);
    leaves.appendChild(leaf);
  }
  box.appendChild(leaves);

  const rn = el('button', '', '重命名其中的分类');
  rn.onclick = async () => {
    const old = await askText('重命名分类', '要改哪个分类名？（会同步改所有产品）', g.entries.find((e) => typeof e === 'string') || '');
    if (!old) return;
    const nw = await askText('重命名分类', `把「${old}」改成什么？`, old);
    if (!nw || nw === old) return;
    snapshot();
    for (const p of S.products) if (p.category === old) p.category = nw;
    for (const gg of s.groups) gg.entries = gg.entries.map((e) => (e === old ? nw : e));
    renderAll();
    toast(`分类「${old}」已改名，涉及产品已同步`);
  };
  box.appendChild(rn);
  return box;
}

function moveLeaf(g, e, delta) {
  const i = g.entries.indexOf(e);
  const j = i + delta;
  if (i === -1 || j < 0 || j >= g.entries.length) return;   // 到头就什么都不做
  snapshot();
  g.entries.splice(i, 1);
  g.entries.splice(j, 0, e);
  renderAll();
}

/**
 * 通用的页内输入 / 确认弹窗。以前这些入口全用 window.prompt / window.confirm，而调用点一律写成
 * `if (!x) return;` —— 宿主拿不到原生模态的返回值时（内嵌预览、弹窗被拦），整条动作静默停在
 * 第一步，不报错也不提示，看上去就是「点了没反应」。页内弹窗不吃宿主能力。
 * askText 确认给字符串、取消给 null；askOk 给布尔。
 */
let dlgResolve = null;
let dlgMode = 'text';

function openDlg({ title, msg, value, danger = true }) {
  dlgMode = value === undefined ? 'ok' : 'text';
  $('#dlg-title').textContent = title || '';
  $('#dlg-msg').textContent = msg || '';
  const inp = $('#dlg-input');
  inp.hidden = dlgMode === 'ok';
  inp.value = dlgMode === 'text' ? String(value || '') : '';
  $('#dlg-ok').textContent = dlgMode === 'ok' ? '确认' : '确定';
  // 不可逆的动作不给蓝色主按钮：它和「取消」只隔几个像素，误点一次要靠撤销或备份才能恢复
  $('#dlg-ok').className = dlgMode === 'ok' && danger ? 'danger' : 'primary';
  $('#dlg').hidden = false;
  if (dlgMode === 'text') { inp.focus(); inp.select(); } else $('#dlg-ok').focus();
  return new Promise((resolve) => { dlgResolve = resolve; });
}

function dlgDone(val) {
  const r = dlgResolve;
  dlgResolve = null;
  $('#dlg').hidden = true;
  if (r) r(val);
}

const askText = (title, msg, value) => openDlg({ title, msg, value });
const askOk = (title, msg, danger) => openDlg({ title, msg, danger });

/** 只绑一次：两个弹窗的按钮、遮罩、Enter 提交、Esc 取消 */
function dlgWire() {
  $('#dlg-ok').onclick = () => dlgDone(dlgMode === 'text' ? $('#dlg-input').value.trim() : true);
  $('#dlg-cancel').onclick = () => dlgDone(dlgMode === 'text' ? null : false);
  $('#dlg').onclick = (e) => { if (e.target.id === 'dlg') dlgDone(dlgMode === 'text' ? null : false); };
  $('#dlg-input').onkeydown = (e) => { if (e.key === 'Enter') dlgDone($('#dlg-input').value.trim()); };
  // 建站点那个表单弹窗：合法才让点（按钮平时是灰的），遮罩与 Esc 都算取消
  $('#ns-ok').onclick = nsCreate;
  $('#ns-cancel').onclick = closeNewSiteDialog;
  $('#newsites').onclick = (e) => { if (e.target.id === 'newsites') closeNewSiteDialog(); };
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('#dlg').hidden) dlgDone(dlgMode === 'text' ? null : false);
    if (!$('#newsites').hidden) closeNewSiteDialog();
  });
}

/**
 * 摘出一个新站点。以前这一步串了三次 window.prompt()：目录名、分组名（要人手回忆名字还得打逗号）、
 * 页面标题，而第一个的取消分支直接 return，什么反馈都没有。
 * 现在换成页内表单：分组用勾选、三个校验各自标红、成员数与克隆来源实时预览 ——
 * 这些恰好就是建站时最容易写错的几处。
 */
let nsTpl = null;
const nsChecked = () => [...document.querySelectorAll('#ns-groups input:checked')].map((c) => c.value);
const nsGroups = () => ((nsTpl && nsTpl.groups) || []).filter((g) => nsChecked().includes(g.name));

function openNewSiteDialog(tpl) {
  nsTpl = tpl;
  $('#newsites').hidden = false;
  $('#ns-key').value = '';
  $('#ns-title').value = tpl.title || 'Selection and Order Form';
  const box = $('#ns-groups');
  box.innerHTML = '';
  for (const g of tpl.groups || []) {
    const lab = el('label', 'switch');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.value = g.name;
    cb.checked = true;                     // 默认全勾 = 复制当前站点的分组
    cb.onchange = nsCheck;
    lab.append(cb, document.createTextNode(` ${g.name}（${(g.entries || []).length} 个分类）`));
    box.appendChild(lab);
  }
  if (!(tpl.groups || []).length) box.appendChild(el('div', 'hint', '当前站点没有分组'));
  $('#ns-key').oninput = nsCheck;
  $('#ns-title').oninput = nsCheck;
  nsCheck();
  $('#ns-key').focus();
}

function closeNewSiteDialog() { $('#newsites').hidden = true; nsTpl = null; }

/**
 * 返回 { field, msg } 说清哪一格填错了，返回 null 表示可以建。
 * 判据必须与 lib.mjs 的 validate 同一把尺（key 要能当目录名、两个站不能撞同一个产物路径、
 * 标题不能含尖括号）：等到保存那一步才被拒更坑 —— 那时站点已经建出来了，人还会以为是自己写错了。
 */
function nsProblem() {
  const key = $('#ns-key').value.trim();
  const title = $('#ns-title').value.trim();
  if (!key) return { field: 'key', msg: '目录名必填：它同时是站点 key 和页面所在目录' };
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(key)) {
    return { field: 'key', msg: '只能用英文字母、数字、- 和 _，且以字母或数字开头（要当目录名用）' };
  }
  if (S.sites.some((s) => s.key === key)) return { field: 'key', msg: `已有同名站点 ${key}` };
  if (S.sites.some((s) => s.file === `${key}/index.html`)) return { field: 'key', msg: `产物路径已被占用：${key}/index.html` };
  if (!title) return { field: 'title', msg: '标题必填，浏览器标签页不能没有名字' };
  if (/[<>]/.test(title)) return { field: 'title', msg: '标题不能含尖括号' };
  if (!nsChecked().length) return { field: 'groups', msg: '至少勾一个分组，不然新站点一个型号都不会有' };
  return null;
}

/** 校验 + 刷预览；返回 nsProblem 的结果，建站点那一步用它的返回值拦下非法输入 */
function nsCheck() {
  const bad = nsProblem();
  const msg = { key: '', title: '', groups: '' };
  if (bad) msg[bad.field] = bad.msg;
  $('#e-ns-key').textContent = msg.key;
  $('#e-ns-title').textContent = msg.title;
  $('#e-ns-groups').textContent = msg.groups;
  const key = $('#ns-key').value.trim();
  const leaves = new Set(groupLeaves(nsGroups()));
  const n = nsTpl ? S.products.filter((p) => leaves.has(p.category)).length : 0;
  // 把「点下去到底会发生什么」摆在点之前：克隆哪个页面、纳入多少型号、存档键叫什么。
  // 型号数含下架的那些（它们在页面上是注释行），与 build 物化成员的口径一致。
  $('#ns-preview').textContent = (bad || !nsTpl) ? '' :
    `将创建 ${key}/index.html（从 ${nsTpl.file} 克隆），成员 ${n} 个型号（含下架的注释行）；` +
    `存档键 ${key.replace(/[^A-Za-z0-9]+/g, '_')}_order_form_data_v1`;
  $('#ns-ok').disabled = Boolean(bad) || !nsTpl;
  return bad;
}

function nsCreate() {
  const tpl = nsTpl;
  if (!tpl || nsCheck()) return;
  const key = $('#ns-key').value.trim();
  const title = $('#ns-title').value.trim();
  const final = nsGroups().map((g) => ({ name: g.name, entries: [...(g.entries || [])] }));
  snapshot();
  // 成员名单在建站那一刻就物化。不写 members 的话，新站会走「按分组自动摘取」的旧回退
  // 路径：以后产品库新增一个属于这些分类的型号，它会自己冒进新站，与主站、TPU 的行为不
  // 一致（你定的是新产品一律手动勾选）。物化后当场产物必须一模一样，所以取的必须
  // 是「此刻属于这些分类的全部型号」，包含下架的（它们在页面上是注释行）。
  const leaves = new Set(groupLeaves(final));
  S.sites.push({
    type: 'form',
    key,
    file: `${key}/index.html`,
    title,
    productsIndent: tpl.productsIndent || '            ',
    storageKey: `${key.replace(/[^A-Za-z0-9]+/g, '_')}_order_form_data_v1`,
    filterToGroups: true,
    members: S.products.filter((p) => leaves.has(p.category)).map((p) => p.id),
    template: tpl.key,
    promo: { enabled: true, speed: 25, items: ((tpl.promo || {}).items || []).slice() },
    groups: final,
    overrides: {},
    raw: {},
  });
  closeNewSiteDialog();
  S.siteKey = key;
  renderAll();
  toast(`已加入站点 ${key}（还在内存里）。点「保存并生成」会从 ${tpl.file} 克隆出 ${key}/index.html 并跑门禁`);
}

// ---------------------------------------------------------------- 拖拽排序

let dragId = null;

function attachDnd(card) {
  card.addEventListener('dragstart', (e) => {
    dragId = card.dataset.id;
    e.dataTransfer.effectAllowed = 'move';
  });
  card.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (card.dataset.id === dragId) return;
    const r = card.getBoundingClientRect();
    const after = (e.clientX - r.left) > r.width / 2;
    card.classList.toggle('drop-after', after);
    card.classList.toggle('drop-before', !after);
  });
  card.addEventListener('dragleave', () => card.classList.remove('drop-before', 'drop-after'));
  card.addEventListener('drop', (e) => {
    e.preventDefault();
    card.classList.remove('drop-before', 'drop-after');
    if (!dragId || dragId === card.dataset.id) return;
    const r = card.getBoundingClientRect();
    const after = (e.clientX - r.left) > r.width / 2;
    moveBefore(dragId, card.dataset.id, after);
    dragId = null;
  });
}

/**
 * 调整顺序。产品库视图改的是主数据顺序（各站的默认顺序跟着走）；
 * 站点视图只写本站 order——主数据和其他站一律不动（首次动时把当前名单物化成顺序表）。
 */
function moveBefore(srcId, targetId, after) {
  snapshot();
  if (isLibrary()) {
    const from = S.products.findIndex((p) => p.id === srcId);
    const [rec] = S.products.splice(from, 1);
    let to = S.products.findIndex((p) => p.id === targetId);
    if (to === -1) { S.products.splice(from, 0, rec); return renderAll(); }
    if (after) to++;
    S.products.splice(to, 0, rec);
    renderAll();
    return;
  }
  const s = memberSource();
  materialiseOrder(s);
  const ids = orderedMembers(s);
  const from = ids.indexOf(srcId);
  if (from === -1) return renderAll();
  ids.splice(from, 1);
  const anchor = ids.indexOf(targetId);
  if (anchor === -1) ids.push(srcId);
  else ids.splice(after ? anchor + 1 : anchor, 0, srcId);
  s.order = ids;
  renderAll();
}

// ---------------------------------------------------------------- 右键菜单

function openCtx(x, y, p) {
  const menu = $('#ctx');
  menu.innerHTML = '';
  const item = (label, fn) => {
    const d = el('div', '', label);
    d.onclick = () => { menu.hidden = true; fn(); };
    menu.appendChild(d);
  };
  const sep = () => menu.appendChild(el('hr'));

  item('编辑这个产品', () => { S.selId = p.id; renderGrid(); renderEditor(); $('.tab[data-tab=product]').click(); });
  // 复制是往全局的 products.json 添一条，改图片链接写的是 image 字段：两个都属于产品库动作，
  // 站点视图里留着会和字段锁互相打脸（那条菜单还会去聚焦一个已经禁用的输入框）。
  if (isLibrary()) {
    item('复制为一个新条目', () => duplicate(p));
    item('改图片链接', () => { S.selId = p.id; renderGrid(); renderEditor(); $('#f-image').focus(); });
  }
  sep();
  item('上移一位', () => step(p, -1));
  item('下移一位', () => step(p, +1));
  sep();
  const cur = effState(p);
  // 站点视图下这三个开关写的是本站覆盖，不能把产品库默认值与其他站一起改了
  const setState = (v) => {
    if (isLibrary()) { setField(p, 'form', v); return; }
    snapshot(); setOverride(p, 'form', v); renderAll();
  };
  item(cur === 'disabled' ? '取消置灰（变正常可选）' : '置灰（图片可放大、数量不可填）', () => setState(cur === 'disabled' ? 'normal' : 'disabled'));
  item(cur === 'presale' ? '取消预售（恢复正常可选）' : '设为预售（数量框显示 Pre Sale）', () => setState(cur === 'presale' ? 'normal' : 'presale'));
  item(cur === 'hidden' ? '恢复上架' : '下架（选款表里不出现）', () => setState(cur === 'hidden' ? 'normal' : 'hidden'));
  // 与面板那个按钮同一个判据：以前菜单在画册视图里也给「移出本站」，那是一个静默写错数据的入口
  if (canRemoveMember(p)) {
    sep();
    item(`移出本站（${site().key}）`, () => removeMember(p));
  }
  // 画册归属是站点属性：产品库视图没有“本站画册”可说；而且 LIBRARY_SITE 是合成对象，
  // 让它走 setInAlbum 会把 catalogOff 写到一个不落库的常量上，看起来生效其实全丢。
  if (!isLibrary()) {
    item(inAlbum(albumSite(), p) ? '从本站画册移除' : '加入本站画册', () => {
      const s = albumSite();
      if (!s) return;
      snapshot(); setInAlbum(s, p, !inAlbum(s, p)); renderAll();
    });
  }
  if (isLibrary()) {
    sep();
    item('删除这个产品（图片链接会丢）', () => deleteProduct(p));
  }

  menu.hidden = false;
  const w = 210, h = menu.offsetHeight;
  menu.style.left = Math.min(x, innerWidth - w) + 'px';
  menu.style.top = Math.min(y, innerHeight - h - 8) + 'px';
}

document.addEventListener('click', () => { $('#ctx').hidden = true; });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#ctx').hidden = true; });   // 右键菜单也要能用 Esc 关掉

/**
 * 彻底删除一个型号。和「下架」的区别必须让用户看清楚：
 * 下架只是页面不出现，图片链接留在主数据里随时能恢复；删除是连记录一起没了。
 * 删完进撤销栈，Ctrl+Z 直接回来；再不行还有保存前的自动备份。
 */
async function deleteProduct(p) {
  const sure = await askOk('从产品库删除这个产品',
    `确认从产品库彻底删除 ${p.id}？\n\n` +
    `这条记录会消失，图片链接一起丢失：\n${p.image}\n` +
    `各站的成员名单、本站顺序、画册排除表与本站覆盖里的它也会一并清掉。\n\n` +
    `只想让某个站不卖它：用「移出本站」，产品库和其他站不受影响。\n` +
    `只想让它不出现：用「下架」更安全（记录保留，随时能恢复）。\n` +
    `删了可以按 Ctrl+Z 撤销，或在「备份列表」回滚。`
  );
  if (!sure) return;
  snapshot();
  const i = S.products.findIndex((x) => x.id === p.id);
  if (i === -1) return;
  S.products.splice(i, 1);
  // 各站的引用必须跟着清，否则 members / order / catalogOff 里留下幽灵 id，校验会一直报错
  for (const s of S.sites) {
    if (Array.isArray(s.members)) s.members = s.members.filter((x) => x !== p.id);
    if (Array.isArray(s.order)) s.order = s.order.filter((x) => x !== p.id);
    if (Array.isArray(s.catalogOff)) s.catalogOff = s.catalogOff.filter((x) => x !== p.id);
    if (s.overrides && s.overrides[p.id]) delete s.overrides[p.id];
  }
  if (S.selId === p.id) S.selId = null;
  S.checked.delete(p.id);
  renderAll();
  toast(`已从产品库删除 ${p.id}（各站引用已清理），Ctrl+Z 可撤销`, 'bad');
}

function setField(p, key, val) {
  snapshot();
  p[key] = val;
  renderAll();
}

/** 上移 / 下移：与拖拽同一套规则，站点视图在本站名单里挪 */
function step(p, delta) {
  if (isLibrary()) {
    const i = S.products.indexOf(p);
    const j = i + delta;
    if (j < 0 || j >= S.products.length) return;
    snapshot();
    S.products.splice(i, 1);
    S.products.splice(j, 0, p);
    renderAll();
    return;
  }
  const s = memberSource();
  const ids = orderedMembers(s);
  const i = ids.indexOf(p.id);
  const j = i + delta;
  if (i === -1 || j < 0 || j >= ids.length) return;
  snapshot();
  ids.splice(i, 1);
  ids.splice(j, 0, p.id);
  s.order = ids;
  renderAll();
}

function duplicate(p) {
  snapshot();
  const base = p.id.replace(/-\d+$/, '');
  let n = 2, id;
  do { id = `${base}-${n++}`; } while (findProduct(id));
  const rec = { ...p, id, name: p.name, notes: [], image: p.image.replace(p.id, id) };
  if (rec.image === p.image) rec.image = `https://hande.zzydhj.com/hande/${id}.jpg`;
  S.products.splice(S.products.indexOf(p) + 1, 0, rec);
  S.selId = rec.id;
  renderAll();
  toast(`已复制为 ${id}，请补图片`);
}

function addProduct() {
  const cat = S.filter.cat || (site().groups?.[0]?.entries || []).find((e) => typeof e === 'string') || '新分类';
  snapshot();
  let n = 1, id;
  do { id = `NEW-${String(n++).padStart(3, '0')}`; } while (findProduct(id));
  const rec = {
    id, name: id, category: cat,
    image: `https://hande.zzydhj.com/hande/${id}.jpg`,
    form: 'normal', notes: [],
  };
  // 插到同分类最后一个型号后面，而不是丢到队尾
  let last = -1;
  S.products.forEach((p, i) => { if (p.category === cat) last = i; });
  S.products.splice(last === -1 ? S.products.length : last + 1, 0, rec);
  S.selId = rec.id;
  renderAll();
  $('.tab[data-tab=product]').click();
  toast(`已把 ${id} 加入产品库。它还不属于任何站点——请在需要的站点里勾选添加，页面上才会出现`);
}

// ---------------------------------------------------------------- 保存 / 检测

async function save() {
  try {
    const prev = snapshotIds();   // 记住改动前的名单：万一要采纳基线，靠它说清「这次做了什么」
    // 发出去之前统一整成固定键序：磁盘上的 products.json 才不会因为条目来源不同而整体重排
    const r = await api('/api/state', { products: S.products.map(canon), sites: S.sites });
    printLog('保存并生成（写盘 → 生成页面 → 回归校验 → dist）', r.ok ? 'ok' : 'bad', threeStage(r));
    S.saved = serialize();          // 数据已落盘，内存与磁盘一致，dirty 该消
    syncBars();
    let bad = resultNote(r);
    // 只卡在人工基线：不是出事了，是问你一句。弹一次确认，点完就继续，不用人碰源码
    if (bad && r.anchorPrompt && r.anchorPrompt.length) bad = await adoptAnchors(r, prev);
    toast(bad || '已保存，dist 交付包也一起更新了', bad ? 'bad' : 'good');
  } catch (e) {
    printLog('保存被拦下：数据校验未通过，未写盘', 'bad', e.message + '\n' + JSON.stringify(e.data?.errors || e.data, null, 2));
    toast('保存被拒绝：数据有问题，见日志', 'bad');
  }
}

/** 改动前的型号名单与各站成员名单（浅拷贝，只用于事后算差异） */
function snapshotIds() {
  return {
    products: S.products.map((p) => p.id),
    members: Object.fromEntries(S.sites.map((s) => [s.key, Array.isArray(s.members) ? [...s.members] : null])),
  };
}

/** 把这次保存到底做了什么写成一句人话，进 anchors.json 的 _history 当凭证 */
function reasonOf(prev) {
  const cut = (a) => a.slice(0, 6).join(', ') + (a.length > 6 ? ` 等 ${a.length} 个` : '');
  const nowP = S.products.map((p) => p.id);
  const bits = [];
  const gone = prev.products.filter((i) => !nowP.includes(i));
  const added = nowP.filter((i) => !prev.products.includes(i));
  if (gone.length) bits.push(`产品库删除 ${cut(gone)}`);
  if (added.length) bits.push(`产品库新增 ${cut(added)}`);
  for (const s of S.sites) {
    const was = prev.members[s.key];
    if (!was || !Array.isArray(s.members)) continue;
    const g = was.filter((i) => !s.members.includes(i));
    const a = s.members.filter((i) => !was.includes(i));
    if (g.length) bits.push(`${s.key} 移出本站 ${cut(g)}`);
    if (a.length) bits.push(`${s.key} 加入本站 ${cut(a)}`);
  }
  return bits.join('；') || '未检测到型号或站点成员的增删（改的是状态、起订量、画册、顺序，或者只是重复保存）';
}

/**
 * 只卡在人工基线时走这里。这类失败的意思就是「你有意识地改了内容」，
 * 该问一句“是有意的吗”，而不是让人去编辑 tools/check.mjs 里的数字。
 * 非基线类失败（主数据复算不一致、区段外被手改、产物混进后台痕迹）根本不会到这里。
 */
async function adoptAnchors(r, prev) {
  const fmt = (v) => (typeof v === 'object' ? JSON.stringify(v) : String(v));
  const lines = r.anchorPrompt.map((f) => `  ${f.site}.${f.field} → ${fmt(f.value)}`).join('\n');
  const reason = reasonOf(prev);
  const sure = await askOk('采纳人工基线',
    '数据与页面都已保存，回归校验只卡在「人工基线」这一类（主数据独立复算是一致的）。\n\n' +
    '需要更新的数字：\n' + lines + '\n\n' +
    '这次做的事：' + reason + '\n\n' +
    '是有意的改动吗？确认后我把新数字写进 tools/anchors.json（附一行历史）并继续更新 dist。',
    false
  );
  if (!sure) return '未采纳基线：数据与页面已保存，但 dist 没更新。反悔可用顶部「撤销」或「备份列表」回滚。';
  const a = await api('/api/anchors', { reason });
  printLog('采纳人工基线并重跑', a.adopted ? 'ok' : 'bad', (a.out || '') + (a.build ? '\n—— 重新跑一遍 ——\n' + threeStage(a) : ''));
  if (!a.adopted) return '基线采纳被拒：还有非基线类的失败，见日志';
  return resultNote(a);
}

/** 三段输出的共同排版 */
function threeStage(r) {
  return r.build + '\n—— 回归校验 ——\n' + r.check + '\n—— 交付包 dist ——\n' + r.publish;
}

/**
 * 生成、校验、组装 dist 是三件事，必须分开报。
 * 生成器中止时成品页根本没变；校验不过时 dist 压根没动 ——
 * 这两种情况如果还说「成功」，就是拿着旧交付包去上线。
 */
function resultNote(r) {
  if (r.ok) return null;
  if (r.buildCode !== 0) return '数据已落盘，但生成器中止，成品页未更新，见日志';
  if (r.checkCode !== 0) return '页面已生成，但回归校验未通过，dist 没更新，见日志';
  if (r.publishCode !== 0) return '页面与校验都通过，但交付包 dist 组装失败，见日志';
  return '流程未完全通过，见日志';
}

async function validateOnly() {
  try {
    const r = await api('/api/validate', { products: S.products, sites: S.sites });
    printLog('校验（只看数据，不写盘）', r.errors.length ? 'bad' : 'ok',
      r.errors.length ? r.errors.map((x) => '- ' + x.msg).join('\n') : '校验通过，没有发现问题');
    toast(r.errors.length ? `${r.errors.length} 个问题` : '校验通过', r.errors.length ? 'bad' : 'good');
  } catch (e) { toast(e.message, 'bad'); }
}

async function checkImages() {
  toast('正在检测图片…');
  try {
    const urls = [...new Set(S.products.map((p) => p.image))];
    const r = await api('/api/images', { urls });
    S.bad = new Set(r.bad.map((b) => b.url));
    renderGrid();
    printLog('图片可达性检测', r.bad.length ? 'bad' : 'ok',
      `共检测 ${r.total} 个唯一 URL，失败 ${r.bad.length} 个\n\n` + (r.bad.map((b) => `${b.status || b.error}  ${b.url}`).join('\n') || '全部可达'));
    toast(r.bad.length ? `${r.bad.length} 张图有问题` : '图片全部可达', r.bad.length ? 'bad' : 'good');
  } catch (e) { toast(e.message, 'bad'); }
}

async function runCheck() {
  // /api/check 只注册了 POST，不能不传 body（上轮就是这里 404 且异常没人接，按钮按下去一点反应都没有）
  try {
    const r = await api('/api/check', {});
    printLog('回归校验', r.code === 0 ? 'ok' : 'bad', r.out);
    toast(r.code === 0 ? '回归校验通过' : '回归校验失败，见日志', r.code === 0 ? 'good' : 'bad');
  } catch (e) {
    printLog('回归校验请求失败', 'bad', e.message);
    toast('回归校验请求失败：' + e.message, 'bad');
  }
}

async function listBackups() {
  const r = await api('/api/backups');
  const box = $('#backupList');
  box.innerHTML = '';
  for (const b of r.backups) {
    const row = el('div', 'row-btns');
    row.append(el('span', '', b));
    const btn = el('button', '', '回滚');
    btn.onclick = async () => {
      if (!(await askOk('回滚到这份备份', `用 ${b} 覆盖当前主数据？`))) return;
      api('/api/restore', { file: b }).then(async (r) => {
        await boot();
        // 回滚前的那一刻另存了一份安全快照，但它故意不进上面这张列表（中间态被当成
        // 「最新备份」会让人一滚就滚回脏状态），所以把它的文件名写在这里说清
        const note = r.preRestore
          ? '\n（回滚前那一刻已另存为：' + r.preRestore.join(' 与 ') + '；这类快照不进上面列表，最多留 5 组）'
          : '';
        printLog('回滚到备份并重新生成', r.ok ? 'ok' : 'bad', threeStage(r) + note);
        const scope = r.sitesRestored ? '（产品与站点配置一起）' : '（仅产品数据，那份备份没有站点配置）';
        const bad = resultNote(r);
        toast(bad ? '已回滚' + scope + '，' + bad : '已回滚并重新生成' + scope + '，回归校验通过', bad ? 'bad' : 'good');
      }).catch((e) => toast(e.message, 'bad'));
    };
    row.appendChild(btn);
    box.appendChild(row);
  }
  if (!r.backups.length) box.textContent = '还没有备份';
  else box.appendChild(el('div', 'hint', '回滚会把产品数据与站点配置一起拉回那一时刻，并自动重新生成＋跑回归校验。'));
}

// ---------------------------------------------------------------- 启动

async function boot() {
  const st = await api('/api/state');
  S.products = st.products.map(canon);   // 读盘第一件事就是整键序，免得旧文件的乱序一路带到下一次保存
  S.sites = st.sites;
  S.siteKey = (S.sites.find((s) => s.key === 'card-holder') || S.sites[0]).key;
  S.checked.clear();
  S.selId = null;
  S.undo.length = 0;
  S.redo.length = 0;
  S.saved = serialize();              // 以刚读盘的内容为基准判 dirty
  renderAll();
}

function wire() {
  $('#siteSelect').onchange = (e) => {
    S.siteKey = e.target.value;
    S.filter.cat = '';
    // 选中态不跟着跳站点：上一个站选中的型号很可能根本不在本站名单里，
    // 留着它就能给一个本站不渲染的型号写覆盖，那份配置永远不生效。
    // 必须用 memberSource()：画册站自己没有 members，直接看 site() 会退成「全库」，
    // 于是画册视图里这条判不永远不会触发——而那恰好是最容易误写的入口。
    if (S.selId && !isLibrary()) {
      const cur = memberSource();
      if (!cur || !membersAsOf(cur).includes(S.selId)) S.selId = null;
    }
    // 只在上一个视图里成立的筛选项（如「未加入站点」）拿到新视图会查出一片空，先归位
    if (!filterOkHere(S.filter.status)) S.filter.status = 'all';
    syncChips();
    renderAll();
  };
  $('#search').oninput = (e) => { S.filter.q = e.target.value; renderGrid(); };
  for (const c of document.querySelectorAll('#statusFilters .chip')) {
    c.onclick = () => {
      document.querySelectorAll('#statusFilters .chip').forEach((x) => x.classList.remove('active'));
      c.classList.add('active');
      S.filter.status = c.dataset.status;
      renderGrid();
    };
  }
  for (const t of document.querySelectorAll('.tab')) {
    t.onclick = () => {
      document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
      t.classList.add('active');
      for (const n of ['product', 'site', 'log']) $('#tab-' + n).hidden = t.dataset.tab !== n;
    };
  }
  $('#btnUndo').onclick = undo;
  $('#btnRedo').onclick = redo;
  $('#btnAdd').onclick = addProduct;
  $('#btnSave').onclick = save;
  $('#btnValidate').onclick = validateOnly;
  $('#btnImages').onclick = checkImages;
  $('#btnCheck').onclick = runCheck;
  $('#btnBackups').onclick = listBackups;
  dlgWire();                            // 页内输入 / 确认弹窗的按钮与键盘，只绑一次

  for (const b of document.querySelectorAll('#batchbar button')) {
    b.onclick = () => {
      const act = b.dataset.batch;
      if (act === 'clear') { S.checked.clear(); renderGrid(); return; }
      snapshot();
      for (const id of S.checked) {
        const p = findProduct(id);
        if (!p) continue;
        if (act === 'catalog-on' || act === 'catalog-off') setInAlbum(albumSite(), p, act === 'catalog-on');
        // 批量也要按上下文分流：在 TPU 里批量置灰不能把主站也置灰了
        else if (isLibrary()) p.form = act;
        else setOverride(p, 'form', act);
      }
      renderAll();
      toast(`已批量修改 ${S.checked.size} 项`);
    };
  }

  // 编辑面板：文本类输入在「获得焦点时」压一次历史，这样连续敲字整体只算一步撤销
  const p = () => (S.selId ? findProduct(S.selId) : null);
  const undoableText = (sel) => {
    const node = $(sel);
    node.addEventListener('focus', () => snapshot());
    // oninput 属性是在下面才挂上的，监听器按注册顺序跑，直接在这里 syncBars 会读到旧模型，
    // 导致 dirty 标记比首次击键慢一拍；推后一轮再同步。
    node.addEventListener('input', () => setTimeout(syncBars, 0));
  };
  ['#f-id', '#f-name', '#f-image', '#f-notes'].forEach(undoableText);

  // 改 ID 要记住「本次编辑开始前」的值：逐字符键入时把引用一步步搬过去，
  // 中途清空输入框就会把空字符串写进成员名单；拖到鼠标离开（change）时一次性从旧 id 搬到新 id 才不会。
  let idBase;
  $('#f-id').addEventListener('focus', () => { const r = p(); idBase = r ? r.id : ''; });
  $('#f-id').oninput = (e) => {
    const r = p();
    if (!r) return;
    const old = r.id;
    r.id = e.target.value;
    // 改 ID 必须同时把选中态带走：p() 是按 id 精确查的，不跟进的话接下来
    // 所有「对当前产品做点什么」的按钮都会静默失效（包括按 ID 生成链接）
    if (S.selId === old) S.selId = r.id;
    if (S.checked.has(old)) { S.checked.delete(old); S.checked.add(r.id); }
    $('#e-id').textContent = idProblem(r.id) || '';
  };
  $('#f-id').onchange = () => {
    const r = p();
    // 各站名单跟着走；没真改名（包括敲了又删回去）时 idBase 与新 id 相同，moveSiteRefs 自己跳过
    if (r) moveSiteRefs(idBase, r.id);
    renderAll();
  };
  $('#f-name').oninput = (e) => { const r = p(); if (r) r.name = e.target.value; };
  $('#f-name').onchange = () => renderGrid();
  $('#f-cat').onchange = (e) => { const r = p(); if (r) { snapshot(); r.category = e.target.value; renderAll(); } };
  $('#f-image').oninput = (e) => { const r = p(); if (r) { r.image = e.target.value; $('#previewImg').src = e.target.value; } };
  $('#f-catalog').onchange = (e) => {
    const r = p(); const s = albumSite();
    if (!r || !s) return;
    snapshot(); setInAlbum(s, r, e.target.checked); renderAll();
  };
  // 逐字符键入时要先记住本次编辑开始前的值，遇到非法输入才能退回去
  let moqBase;
  $('#f-moq').addEventListener('focus', () => { const r = p(); moqBase = r ? effMoq(r) : undefined; });
  $('#f-moq').oninput = (e) => {
    const r = p(); if (!r) return;
    const v = e.target.value;
    // 留空：产品库视图是「不限」，站点视图是「跟随产品库」（两种情况都不写进数据）
    if (v === '') { setMoq(r, undefined); $('#e-moq').textContent = ''; }
    else if (!/^\d+$/.test(v) || Number(v) < 1) {
      // 判据用的是输入框里的原始字符串，不是 Number(v)：“1.” 会被 Number 当成 1，
      // 按数值判合法的话，逐字符敲 1.5 时中途的 1 就真进了数据（徽标会变成 MOQ 1）。
      setMoq(r, moqBase);                                     // 退回本次编辑开始前的值
      $('#e-moq').textContent = '起订量只能是正整数，当前不会保存';
    } else {
      setMoq(r, Number(v));
      $('#e-moq').textContent = '';
    }
    renderGrid();
    renderStats();            // 统计区跟着编辑走，不然「设了起订量」会停在旧数字
    setTimeout(syncBars, 0);
  };
  $('#f-moq').onchange = (e) => {
    const r = p(); if (!r) return;
    // 失焦后把框里的值对齐到真正生效的那个（非法输入已被回退，不能让它显示着回不去的脏值）
    const now = effMoq(r);
    e.target.value = now === undefined ? '' : now;
    $('#e-moq').textContent = '';
  };
  $('#f-notes').onchange = (e) => { const r = p(); if (r) { r.notes = e.target.value.split('\n').map((x) => x.trim()).filter(Boolean); renderAll(); } };
  for (const rad of document.querySelectorAll('#f-form input[name=form]')) {
    rad.onchange = () => {
      const r = p(); if (!r) return;
      snapshot();
      // 产品库视图改默认值；站点视图只写本站覆盖，选「跟随产品库」则把覆盖删掉
      if (isLibrary()) r.form = rad.value;
      else setOverride(r, 'form', rad.value);
      renderAll();
    };
  }
  // 输入框获得焦点时留一份快照：这样「改完一撤销」能回到改之前，
  // 以前只有下拉、复选框、按钮类操作入栈，手打文本是不可撤销的。
  for (const sel of ['#f-id', '#f-name', '#f-image', '#f-notes', '#f-moq']) {
    $(sel).addEventListener('focus', snapshot);
  }
  $('#btnPreview').onclick = () => {
    const s = site();
    if (!s) return toast('先选一个站点', 'bad');
    // 成品页一变，serve 会通过 SSE 让这个标签自己刷新，所以这里只负责打开与聚焦
    if (previewWin && !previewWin.closed) { previewWin.focus(); return; }
    previewWin = window.open('/preview/' + s.file, '_blank');
    if (!previewWin) toast('浏览器拦住了弹窗，请允许本站弹窗或手动开一个标签页', 'bad');
  };
  // 删除与右键菜单走同一个函数：两个入口，一套确认与撤销逻辑，不各写一份
  $('#btnDelete').onclick = () => { const r = p(); if (r) deleteProduct(r); };
  $('#btnRemoveMember').onclick = () => { const r = p(); if (r) removeMember(r); };
  $('#btnAddMembers').onclick = openPicker;
  $('#picker-search').oninput = renderPicker;
  $('#picker-cancel').onclick = closePicker;
  $('#picker-ok').onclick = () => { const ids = [...pickerSel]; closePicker(); addMembers(ids); };
  // 点遮罩空白处也能关，点盒子内部不算
  $('#picker').onclick = (e) => { if (e.target.id === 'picker') closePicker(); };
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#picker').hidden) closePicker(); });
  $('#btnFillImage').onclick = () => {
    const r = p();
    if (!r) return;
    snapshot();
    r.image = `https://hande.zzydhj.com/hande/${r.id}.jpg`;
    $('#f-image').value = r.image;
    $('#previewImg').src = r.image;
    renderGrid();
    syncBars();
    // 中文型号的真图文件名往往跟 ID 不一致，不提醒的话很容易静静生成一个 404 地址
    if (/[\u4e00-\u9fa5]/.test(r.id)) toast('这个 ID 含中文，生成出的链接十有八九打不开，请点「测试这张图」确认', 'bad');
  };
  $('#btnTestImage').onclick = async () => {
    const r = p();
    if (!r) return;
    const r2 = await api('/api/images', { urls: [r.image] });
    if (r2.bad.length) { S.bad.add(r.image); toast(`这张图打不开：${r2.bad[0].status || r2.bad[0].error}`, 'bad'); }
    else toast('这张图可以正常访问', 'good');
    renderGrid();
  };

  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    // 按住 Shift 时 e.key 是大写字母，不归一化的话 Ctrl+Shift+Z 匹配不到任何分支，重做只能点按钮
    const k = (e.key || '').toLowerCase();
    if (k === 's') { e.preventDefault(); save(); }
    if (k === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
    if (k === 'y') { e.preventDefault(); redo(); }
  });
  window.addEventListener('beforeunload', (e) => {
    if (isDirty()) { e.preventDefault(); e.returnValue = '有未保存的数据改动，确定离开？'; }
  });
}

wire();
boot().then(() => toast('数据已载入', 'good')).catch((e) => toast('载入失败：' + e.message, 'bad'));
