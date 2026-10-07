// 把网页版要用的静态文件收集到 dist/：界面、计算线程、Python 代码（和本地版是同一份）。
import { cpSync, mkdirSync, rmSync } from 'node:fs';

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist/py', { recursive: true });
cpSync('ui.html', 'dist/index.html');
cpSync('web/pyworker.js', 'dist/pyworker.js');
for (const name of ['carpool.py', 'share.py', 'service.py', 'browser.py']) cpSync(name, `dist/py/${name}`);
console.log('dist/ 已生成');
