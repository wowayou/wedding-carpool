// SPDX-License-Identifier: AGPL-3.0-or-later
// 把地图页面的脚本（ES 模块，从 frame.js 起按 import 关系）并成一个普通脚本。
// 为什么不直接用模块：方案页在沙箱里，页面来源是 null，ES 模块脚本要 CORS 才能加载；普通脚本不用。
// 约定：被并入的文件只能用单行的 `import { … } from './x.js';`，导出只能写成 `export const/function/class …`，各文件的顶层名字不能重名。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));

export function bundleMap(entry = 'frame.js') {
  const order = [], seen = new Set();
  const visit = (name) => {
    if (seen.has(name)) return;
    seen.add(name);
    const src = readFileSync(join(DIR, name), 'utf8');
    for (const [, dep] of src.matchAll(/^import\s[^;]*?from\s+'\.\/([\w-]+\.js)';$/gm)) visit(dep);
    order.push([name, src]);
  };
  visit(entry);
  const parts = order.map(([name, src]) => {
    const body = src.replace(/^import\s[^;]*?from\s+'\.\/[\w-]+\.js';$/gm, '').replace(/^export\s+(?=(?:const|let|function|class|async)\b)/gm, '');
    if (/^\s*(?:import|export)\b/m.test(body)) throw new Error(`${name}：并入脚本的文件只能用单行 import 和 export const/function/class`);
    return `// ---- ${name} ----\n${body}`;
  });
  return `// 由 web/map/bundle.mjs 生成，不要手改\n(() => {\n'use strict';\n${parts.join('\n')}\n})();\n`;
}
