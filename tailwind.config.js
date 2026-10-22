/**
 * Tailwind 静态构建配置（方案 1：去除运行时 CDN 依赖）。
 *
 * 与原页面行为保持完全一致的两个关键点：
 *  1. important: true —— 原页面通过 `tailwind.config = { important: true }` 开启，
 *     使所有工具类带 !important 以覆盖 WordPress 样式；此处写入构建配置，效果相同。
 *  2. 版本锁定 3.4.x —— 与原 cdn.tailwindcss.com（Play CDN，v3 引擎）同代，
 *     保证生成的工具类与 Preflight 与原运行时输出一致。
 *
 * content 直接扫描 index.html 的原始文本：产品卡片由 JS 模板字符串渲染，
 * 类名以字面量存在于该文件中，因此一次扫描即可覆盖静态 + 动态全部类名。
 *
 * 重新生成命令（仓库根目录执行）：
 *   npx -y tailwindcss@3.4.17 -c tailwind.config.js -i tailwind.input.css -o card-holder/tailwind.css --minify
 */
/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./card-holder/index.html'],
  important: true,
  theme: {
    extend: {},
  },
  plugins: [],
};
