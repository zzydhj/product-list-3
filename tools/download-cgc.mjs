// 一次性脚本：从 tools/products.json 提取所有 CGC 产品图片并下载到 CGC-images/
// 用法：node tools/download-cgc.mjs（可重复跑，已下的文件会跳过）；输出目录已在 .gitignore 里忽略
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import https from 'node:https';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'CGC-images');
// 目录不存在就得先建：这个目录本来就不在仓库里，缺这一句的话
// 从干净克隆跑第一次，会在第一张图的 writeFileSync 上直接 ENOENT 抛掉
mkdirSync(outDir, { recursive: true });
const products = JSON.parse(readFileSync(join(root, 'tools', 'products.json'), 'utf8'));

const cgc = products.products
  ? products.products.filter(p => String(p.id).startsWith('CGC'))
  : Object.values(products).flat().filter(p => p && typeof p === 'object' && String(p.id).startsWith('CGC'));

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const get = (u, depth) => https.get(u, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && depth < 3) {
        return get(res.headers.location, depth + 1);
      }
      if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode + ' ' + u));
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        if (body.length < 1000) return reject(new Error('响应过小，可能不是图片: ' + u));
        writeFileSync(dest, body);
        resolve(body.length);
      });
      res.on('error', reject);
    }).on('error', reject);
    get(url, 0);
  });
}

let ok = 0, fail = 0;
for (const p of cgc) {
  const fileName = new URL(p.image).pathname.split('/').pop();
  const dest = join(outDir, fileName);
  if (existsSync(dest)) { console.log('跳过(已存在): ' + fileName); ok++; continue; }
  try {
    const size = await download(p.image, dest);
    console.log('完成: ' + fileName + ' (' + (size / 1024).toFixed(1) + ' KB)');
    ok++;
  } catch (e) {
    console.error('失败: ' + p.image + ' -> ' + e.message);
    fail++;
  }
}
console.log('CGC 产品数: ' + cgc.length + ', 成功: ' + ok + ', 失败: ' + fail);
