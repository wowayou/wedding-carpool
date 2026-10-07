// SPDX-License-Identifier: AGPL-3.0-or-later
// 把网页版要用的静态文件收集到 dist/：界面、计算线程、Python 代码（和本地版是同一份）。
import { cpSync, mkdirSync, rmSync } from 'node:fs';

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
console.log('dist/ 已生成');
