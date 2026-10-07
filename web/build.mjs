// SPDX-License-Identifier: AGPL-3.0-or-later
// 把网页版要用的静态文件收集到 dist/：界面、计算线程、Python 代码（和本地版是同一份）。
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { vendor } from './vendor.mjs';

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist/py', { recursive: true });
cpSync('web/landing.html', 'dist/index.html'); // 首页：新建行程、最近打开的行程
cpSync('ui.html', 'dist/edit.html'); // 行程编辑页，Worker 把 /t/<行程> 指到这里
cpSync('web/pyworker.js', 'dist/pyworker.js');
cpSync('web/stations12306.json', 'dist/stations12306.json');
cpSync('web/privacy.html', 'dist/privacy.html'); // 费用与隐私说明
cpSync('web/admin.html', 'dist/admin.html'); // 管理页：邀请码、用量
// 图标和首屏示例：站点根目录；/demo 是静态的示例方案页（虚构行程，由 demo 流程生成，不经过 Worker）
for (const name of ['favicon.svg', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'demo-shot.webp']) cpSync(`web/${name}`, `dist/${name}`);
cpSync('web/demo-shot.png', 'dist/demo-shot.png');
cpSync('web/demo.html', 'dist/demo.html');
for (const name of ['robots.txt', 'sitemap.xml', 'llms.txt']) cpSync(`web/${name}`, `dist/${name}`); // 搜索引擎和 AI 问答用
for (const name of ['carpool.py', 'share.py', 'service.py', 'browser.py']) cpSync(name, `dist/py/${name}`);
cpSync('web/_headers', 'dist/_headers'); // 静态文件的安全响应头；Worker 生成的响应在 worker.js 里加同一组

// 编辑页的前端依赖改为自己托管：下载并校验到 dist/vendor/，把 dist/edit.html、dist/pyworker.js 里的 CDN 地址换成 /vendor/…（见 web/vendor.mjs）
vendor();

// ---------- 构建时给每个页面生成 CSP ----------
// 内嵌脚本按内容的 sha256 放行（不用 'unsafe-inline'），改了脚本重新构建即可，不用手工更新哈希。
// 只改 dist/ 里的产物，源文件不动。CSP 放在 <meta> 里，紧跟 <meta charset>、在任何脚本之前。
// frame-ancestors 在 meta 里无效，由响应头负责（见 web/_headers 和 worker.js）。
const CDNJS = 'https://cdnjs.cloudflare.com';
const BASE = {
  'default-src': ["'self'"], 'base-uri': ["'none'"], 'object-src': ["'none'"], 'form-action': ["'self'"],
  'img-src': ["'self'", 'data:'], 'style-src': ["'self'", "'unsafe-inline'"], 'connect-src': ["'self'"],
  'font-src': ["'self'"], 'manifest-src': ["'self'"],
};
const LEAFLET = { 'script-src': [CDNJS], 'style-src': [CDNJS], 'img-src': [CDNJS, 'https://*.is.autonavi.com'] };
const PAGES = {
  'index.html': {},
  'admin.html': {},
  'privacy.html': { noScript: true }, // 没有脚本
  'demo.html': LEAFLET,
  // 编辑页：Leaflet、marked、Pyodide 都是自己托管的同源文件（见 web/vendor.mjs），不放行任何 CDN，只放行高德瓦片图片。
  // 计算线程是同源的模块 Worker：Worker 里 import 的脚本由 worker-src 管（Chromium 实测），wasm 编译要 script-src 里的 'wasm-unsafe-eval'
  'edit.html': {
    'worker-src': ["'self'"], 'script-src': ["'self'", "'wasm-unsafe-eval'"], 'img-src': ['https://*.is.autonavi.com'],
  },

};

// 可执行的内嵌脚本：没有 src，类型不是 JSON 数据块（application/json、application/ld+json）
function inlineScriptHashes(html) {
  const hashes = [];
  for (const [, attrs, body] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (/\bsrc\s*=/i.test(attrs)) continue;
    const type = /(?:^|\s)type\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1].toLowerCase();
    if (type && type !== 'module' && type !== 'text/javascript' && type !== 'application/javascript') continue;
    hashes.push(`'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`);
  }
  return hashes;
}

function buildCsp(html, { noScript, ...extra }) {
  const policy = Object.fromEntries(Object.entries(BASE).map(([k, v]) => [k, [...v]]));
  for (const [k, v] of Object.entries(extra)) policy[k] = [...(policy[k] || []), ...v];
  const hashes = inlineScriptHashes(html);
  if (noScript && hashes.length) throw new Error('这一页声明了没有脚本，但有内嵌脚本');
  policy['script-src'] = noScript ? ["'none'"] : [...(policy['script-src'] || []), ...hashes];
  return Object.entries(policy).map(([k, v]) => `${k} ${v.join(' ')}`).join('; ');
}

for (const [name, opts] of Object.entries(PAGES)) {
  const file = `dist/${name}`;
  const html = readFileSync(file, 'utf8');
  const csp = buildCsp(html, opts);
  if (/'unsafe-(inline|eval)'/.test(csp.split('; ').find((d) => d.startsWith('script-src ')))) throw new Error(`${name}：script-src 不能放开 unsafe-inline/eval`);
  const charset = /<meta\s+charset=[^>]*>/i.exec(html);
  if (!charset) throw new Error(`${name} 缺少 <meta charset>`);
  const at = charset.index + charset[0].length;
  writeFileSync(file, `${html.slice(0, at)}\n<meta http-equiv="Content-Security-Policy" content="${csp}">${html.slice(at)}`);
}
console.log('dist/ 已生成');
