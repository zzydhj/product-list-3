// serve.mjs —— 本地管理后台服务（零依赖，只用 Node 内置模块）
//
// 用法：  node tools/serve.mjs [端口]      默认 8766
//
// 路由：
//   /                 -> 后台界面（tools/admin/）
//   /preview/<路径>    -> 直接托管项目根，用于在后台里预览三个成品页面
//   /api/state        GET  读取 products.json + sites.json
//   /api/state        POST 校验 + 备份 + 写盘 + 调用生成器
//   /api/build        POST 只重新生成成品页面
//   /api/check        POST 跑 tools/check.mjs，返回回归校验结果
//   /api/images       POST 批量 HEAD 检测图片可达性
//   /api/backups      GET  列出 products.json 的历史备份
//   /api/restore      POST 回滚到指定备份
//   /__live           GET  SSE 通道：成品页一变就通知预览页自动刷新
//
// 注意：本文件与 tools/ 整个目录都不参与线上部署，线上产物里没有任何后台痕迹。

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, TOOLS } from './lib.mjs';
import { productsFrom, sitesFrom, runValidation, saveState } from './store.mjs';

const PORT = Number(process.argv[2] || 8766);
const ADMIN = path.join(TOOLS, 'admin');

/**
 * 本进程内存里的模块是启动时加载的。改了它们却没重启服务，就会出现
 * 「界面能选预售、服务端却判它非法」这种错位。发现磁盘上的版本与本进程加载的
 * 不是同一份就大声提示。
 *
 * 只列被本文件 import 的模块：build.mjs / check.mjs / publish.mjs 是每次 spawn
 * 新子进程跑的，改完立即生效，把它们算进来会让人白白重启。serve.mjs 自身也算：
 * 它的路由与注入逻辑同样驻留在本进程内存里。
 *
 * 判定用「启动时快照的 mtime 与当前是否一致」，而不是「mtime 是否晚于启动时刻」：
 * 后者在改完文件与启动服务几乎同时发生时会误报（实测踩过），靠加容差治不了本。
 */
const CODE_FILES = ['lib.mjs', 'store.mjs', 'serve.mjs'];
const CODE_MTIME = {};
for (const f of CODE_FILES) {
  try { CODE_MTIME[f] = fs.statSync(path.join(TOOLS, f)).mtimeMs; } catch { CODE_MTIME[f] = 0; }
}
function staleCode() {
  return CODE_FILES.some((f) => {
    try { return fs.statSync(path.join(TOOLS, f)).mtimeMs !== CODE_MTIME[f]; } catch { return false; }
  });
}

// ---------------------------------------------------------------- 预览热重载
// 给预览响应注入一段极小的脚本，成品页一变就自动刷新。注入只发生在响应内容里，
// 磁盘上的成品文件一个字节不动（回归校验读的是磁盘文件，不会因此报区段外差异）。
const LIVE = '<script>(()=>{const es=new EventSource("/__live");es.onmessage=()=>location.reload();})();</script>';
const clients = new Set();
const watched = new Set();

function broadcast() { for (const res of clients) res.write('data: reload\n\n'); }

function injectLive(text) {
  const i = text.lastIndexOf('</body>');
  return i === -1 ? text + LIVE : text.slice(0, i) + LIVE + text.slice(i);
}

/** 监听各站点的成品页；新建站点后重复调用即可补上，已监过的跳过 */
function watchProducts() {
  for (const s of sitesFrom()) {
    const f = path.join(ROOT, s.file);
    if (watched.has(f)) continue;
    watched.add(f);
    fs.watchFile(f, { interval: 300 }, () => broadcast());
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
};

function send(res, code, body, type = 'application/json; charset=utf-8') {
  const buf = type.startsWith('application/json') ? JSON.stringify(body, null, 2) : body;
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(buf);
}

/**
 * 收请求体：必须先把块存成 Buffer 数组、最后一次性按 UTF-8 解码。
 * 以前写的是 `s += c`，那相当于每收到一块就单独解码一次：一个中文字符（3 字节）
 * 正好被 TCP 块边界切开时，两边各自解码都会变成一个 U+FFFD，型号 id 就跳了。
 * 难的是 body 里 products 与 members 会被同一切点切坏，两边“一致地错”反而能过校验，
 * 坏字符就始终落盘了。420 条型号、带中文名、体积近 80KB 的请求止不住碰上切点。
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 8e6) { reject(new Error('body 过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const s = Buffer.concat(chunks).toString('utf8');
      try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function run(script, args = []) {
  const r = spawnSync(process.execPath, [path.join(TOOLS, script), ...args], { cwd: ROOT, encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

/**
 * 回滚前的安全快照不进备份列表，但也不能无限堆积：只留最近 5 组。
 * 文件名里是等长的 13 位毫秒时间戳，字典序就是时间序。
 */
function prunePreRestore() {
  for (const prefix of ['products.json.pre-restore-', 'sites.json.pre-restore-']) {
    const list = fs.readdirSync(TOOLS).filter((f) => f.startsWith(prefix)).sort().reverse();
    while (list.length > 5) fs.rmSync(path.join(TOOLS, list.pop()));
  }
}

/** 对远程图片发 HEAD（部分服务器不支持 HEAD，失败时退回 GET 只取头部） */
function probe(url) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https:') ? https : http;
    const go = (method) => {
      const req = mod.request(url, { method, timeout: 8000 }, (res) => {
        res.resume();
        resolve({ url, status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 400 });
      });
      req.on('timeout', () => { req.destroy(new Error('timeout')); });
      req.on('error', (e) => {
        if (method === 'HEAD') return go('GET');
        resolve({ url, status: 0, ok: false, error: e.code || e.message });
      });
      req.end();
    };
    go('HEAD');
  });
}

function serveStatic(base, relPath, res, opts = {}) {
  const p = path.normalize(path.join(base, relPath));
  if (!p.startsWith(base)) return send(res, 403, { error: '越界' });
  if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) return send(res, 404, 'not found', 'text/plain; charset=utf-8');
  const ext = path.extname(p).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  if (opts.live && ext === '.html') return send(res, 200, injectLive(fs.readFileSync(p, 'utf8')), type);
  send(res, 200, fs.readFileSync(p), type);
}

/**
 * 一步到位：生成页面 → 回归校验 → 组装交付包 dist/。
 * 三段串行且后两段以前一段成功为前提：
 *  - ok 必须同时看 build 与 check：只看过 check 会假绿（build 因数据非法而中止时
 *    产物根本没更新，check 却对着旧产物报「全部通过」）。
 *  - 校验不通过就不碰 dist，避免把没过门禁的内容做成部署产物。
 * buildArgs：回滚那条路要传 ['--restore']。回滚后页面里必然还留着刚被退掉的型号，
 * 不放宽这一条护栏就会把一次正常回滚拦成「数据已回到旧版、页面还是新版」的错位状态。
 */
function generateAndPack(buildArgs = []) {
  const b = run('build.mjs', buildArgs);
  const c = run('check.mjs');
  const pagesOk = b.code === 0 && c.code === 0;
  const p = pagesOk ? run('publish.mjs') : null;
  return {
    ok: pagesOk && p.code === 0,
    buildCode: b.code,
    checkCode: c.code,
    publishCode: p ? p.code : null,
    build: b.out,
    check: c.out,
    publish: p ? p.out : '（回归校验未通过，dist 保持上一个版本）',
    stale: staleCode(),
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = decodeURIComponent(url.pathname);

  try {
    // ---------------- API
    if (p === '/api/state' && req.method === 'GET') {
      return send(res, 200, { products: productsFrom(), sites: sitesFrom(), stale: staleCode() });
    }
    if (p === '/api/state' && req.method === 'POST') {
      const body = await readBody(req);
      const errors = runValidation(body.products || [], body.sites || []);
      if (errors.length) return send(res, 400, { ok: false, errors, stale: staleCode() });
      const backups = saveState(body.products || [], body.sites || []);
      watchProducts();   // 新建的站点也要开始监听，否则它的预览页不会自动刷新
      return send(res, 200, { backups, ...generateAndPack() });
    }
    if (p === '/api/validate' && req.method === 'POST') {
      const body = await readBody(req);
      return send(res, 200, { errors: runValidation(body.products || [], body.sites || []) });
    }
    if (p === '/api/sites' && req.method === 'POST') {
      // 只改站点定义（新建摘取型站点走这里）
      const body = await readBody(req);
      const errors = runValidation(productsFrom(), body.sites || []);
      if (errors.length) return send(res, 400, { ok: false, errors });
      saveState(productsFrom(), body.sites || []);
      return send(res, 200, generateAndPack());
    }
    if (p === '/api/build' && req.method === 'POST') {
      return send(res, 200, generateAndPack());
    }
    if (p === '/api/check' && req.method === 'POST') {
      const c = run('check.mjs');
      return send(res, 200, { code: c.code, out: c.out });
    }
    if (p === '/api/images' && req.method === 'POST') {
      const body = await readBody(req);
      const urls = [...new Set((body.urls || []).filter((u) => /^https?:\/\//.test(u)))];
      const results = [];
      // 并发 8 路，避免把图床打爆
      for (let i = 0; i < urls.length; i += 8) {
        const batch = urls.slice(i, i + 8);
        results.push(...await Promise.all(batch.map(probe)));
      }
      return send(res, 200, { total: results.length, bad: results.filter((r) => !r.ok) });
    }
    if (p === '/api/backups' && req.method === 'GET') {
      const list = fs.readdirSync(TOOLS).filter((f) => f.startsWith('products.json.bak-')).sort().reverse();
      return send(res, 200, { backups: list.slice(0, 20) });
    }
    if (p === '/api/restore' && req.method === 'POST') {
      const body = await readBody(req);
      const name = String(body.file || '');
      if (!/^products\.json\.bak-[\w-]+$/.test(name) || !fs.existsSync(path.join(TOOLS, name))) {
        return send(res, 400, { ok: false, error: '备份名不合法' });
      }
      const stamp = name.replace(/^products\.json\.bak-/, '');
      // 一次保存会同时留 products 与 sites 两份同时间戳的备份，回滚必须两个一起回到那个时刻，
      // 否则会出现「产品是旧的、站点配置是新的」的错位状态。
      const sitesBak = path.join(TOOLS, `sites.json.bak-${stamp}`);
      // 先给「此刻」留一份安全快照，回滚回错了还能再回去。名字用 pre-restore 而不是 bak-：
      // 它是中间态快照，混进 /api/backups 的列表里会被当成「最新备份」（按名倒序它恰好排第一），
      // 谁顺着点「回滚最新一份」就正好滚进这个半吊子状态。只写在日志里，不进列表。
      const now = String(Date.now());
      const preProducts = `products.json.pre-restore-${now}`;
      const preSites = `sites.json.pre-restore-${now}`;
      fs.copyFileSync(path.join(TOOLS, 'products.json'), path.join(TOOLS, preProducts));
      if (fs.existsSync(sitesBak)) fs.copyFileSync(path.join(TOOLS, 'sites.json'), path.join(TOOLS, preSites));
      fs.copyFileSync(path.join(TOOLS, name), path.join(TOOLS, 'products.json'));
      if (fs.existsSync(sitesBak)) fs.copyFileSync(sitesBak, path.join(TOOLS, 'sites.json'));
      prunePreRestore();
      return send(res, 200, {
        sitesRestored: fs.existsSync(sitesBak),
        preRestore: fs.existsSync(sitesBak) ? [preProducts, preSites] : [preProducts],
        ...generateAndPack(['--restore']),
      });
    }

    // ---------------- 预览热重载通道（SSE）
    if (p === '/__live' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write('retry: 2000\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    // ---------------- 预览成品页面
    if (p.startsWith('/preview/')) return serveStatic(ROOT, p.slice('/preview/'.length), res, { live: true });

    // ---------------- 后台静态文件
    if (p === '/' || p === '/index.html') return serveStatic(ADMIN, 'index.html', res);
    return serveStatic(ADMIN, p.slice(1), res);
  } catch (e) {
    return send(res, 500, { error: String(e && e.message || e) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  watchProducts();
  console.log(`后台已启动：  http://127.0.0.1:${PORT}/`);
  console.log(`预览选款表：  http://127.0.0.1:${PORT}/preview/card-holder/index.html`);
  console.log(`预览 TPU：    http://127.0.0.1:${PORT}/preview/TPU/index.html`);
  console.log(`预览画册：    http://127.0.0.1:${PORT}/preview/card-holder/product-catalog.html`);
  console.log('成品页一变，上面这些预览页会自动刷新');
  if (staleCode()) console.log('\n[!!] 生成器代码比本进程新，请重启本服务，否则新状态会被旧校验逻辑拒绝。\n');
});
