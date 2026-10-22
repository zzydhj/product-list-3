// store.mjs —— 数据读写与校验的唯一入口（import / build / serve 都走这里）

import fs from 'node:fs';
import path from 'node:path';
import { TOOLS, validate } from './lib.mjs';

export const PRODUCTS_FILE = path.join(TOOLS, 'products.json');
export const SITES_FILE = path.join(TOOLS, 'sites.json');
const KEEP_BACKUPS = 20;

// 两份说明文案只写这一次：saveState 与任何直接改文件的脚本都引用这里，不会各说一套
export const PRODUCTS_README = '产品主数据（唯一权威）。数组顺序 = 选款表网格与画册的默认渲染顺序。form: normal=正常可选 / disabled=选款表置灰但图片可放大 / presale=预售（数量框不可填）/ hidden=选款表不渲染。moq 是起订量（可选）。notes 是分节注释，生成时还原在各型号上方。画册归属不再存在这里，改由 sites.json 各选款站的 catalogOff 决定（每本画册只管自己）。';
export const SITES_README = '站点定义。members 是本站的成员名单（分组只管侧栏结构与顺序，不再决定成员）；order 是本站自己的渲染顺序（可选，未列出的型号按产品库顺序接在后面）；overrides 是本站对某个型号的状态/起订量覆盖，只写与产品库不同的那一部分，不写就是跟随默认值（画册页不读这两项，所以覆盖只影响选款页）。catalogOff 是本站画册的排除名单（空数组=全进）。filterToGroups 是站点还没写 members 时的旧回退路径。type=catalog 的画册站靠 owner 跟随某个选款站，成员范围、顺序与排除名单全部从 owner 派生，自己只管标题与水印。raw 保存迁移时的原始区段文本：配置未被改动时生成器原样透传，改过之后按规范格式重写。';

export function productsFrom() {
  return JSON.parse(fs.readFileSync(PRODUCTS_FILE, 'utf8')).products;
}

export function sitesFrom() {
  return JSON.parse(fs.readFileSync(SITES_FILE, 'utf8')).sites;
}

export function runValidation(products, sites) {
  return validate(products, sites);
}

/** 写盘前先备份，最多留 KEEP_BACKUPS 份，误操作可以回滚 */
export function saveState(products, sites) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backups = [];
  if (fs.existsSync(PRODUCTS_FILE)) {
    const f = `products.json.bak-${stamp}`;
    fs.copyFileSync(PRODUCTS_FILE, path.join(TOOLS, f));
    backups.push(f);
    prune('products.json.bak-');
  }
  if (fs.existsSync(SITES_FILE)) {
    const f = `sites.json.bak-${stamp}`;
    fs.copyFileSync(SITES_FILE, path.join(TOOLS, f));
    backups.push(f);
    prune('sites.json.bak-');
  }
  fs.writeFileSync(PRODUCTS_FILE, JSON.stringify({
    _readme: PRODUCTS_README,
    products,
  }, null, 2) + '\n', 'utf8');
  fs.writeFileSync(SITES_FILE, JSON.stringify({
    _readme: SITES_README,
    sites,
  }, null, 2) + '\n', 'utf8');
  return backups;
}

function prune(prefix) {
  const list = fs.readdirSync(TOOLS).filter((f) => f.startsWith(prefix)).sort();
  while (list.length > KEEP_BACKUPS) {
    fs.rmSync(path.join(TOOLS, list.shift()));
  }
}
