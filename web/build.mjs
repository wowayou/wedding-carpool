// 把网页版要用的静态文件收集到 dist/：界面、计算线程、Python 代码（和本地版是同一份）。
import { cpSync, mkdirSync, rmSync } from 'node:fs';

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist/py', { recursive: true });
cpSync('web/landing.html', 'dist/index.html'); // 首页：新建行程、最近打开的行程
cpSync('ui.html', 'dist/edit.html'); // 行程编辑页，Worker 把 /t/<行程> 指到这里
cpSync('web/pyworker.js', 'dist/pyworker.js');
cpSync('web/stations12306.json', 'dist/stations12306.json');
for (const name of ['carpool.py', 'share.py', 'service.py', 'browser.py']) cpSync(name, `dist/py/${name}`);
console.log('dist/ 已生成');
