// SPDX-License-Identifier: AGPL-3.0-or-later
// 编辑页用到的前端依赖（Pyodide、Leaflet、marked）：构建时下载固定版本，逐个校验 sha256，
// 缓存在 .cache/vendor/，拷到 dist/vendor/，再把 dist/edit.html 和 dist/pyworker.js 里的 CDN 地址改成同源的 /vendor/…。
// 下载失败或哈希不对一律让构建报错，不会回退到 CDN。源文件（ui.html、web/pyworker.js）不动，本地版 ui.py 继续用 CDN。
// 升级版本：改下面的 URL，把 sha256 换成新文件的（先看过文件内容再 sha256sum），再同步 web/pyworker.js 和 ui.html 里的版本号。
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const PYODIDE_VERSION = 'v314.0.7';
const PYODIDE = `https://cdn.jsdelivr.net/pyodide/${PYODIDE_VERSION}/full`;
const LEAFLET = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4';
const MAX_BYTES = 25 * 1024 * 1024; // Cloudflare 静态资源单个文件上限 25 MiB

// out 是 dist/vendor/ 下的路径。许可证文本也一起下载并校验
export const FILES = [
  { url: `${PYODIDE}/pyodide.mjs`, out: 'pyodide/pyodide.mjs', sha256: '6f1d60f7bf529beb300f0f47983c921d3982363640ba20af0e38efdddbc66109' },
  { url: `${PYODIDE}/pyodide.asm.mjs`, out: 'pyodide/pyodide.asm.mjs', sha256: 'f7cdc8ece80678ceb712f8e65ebe6d3a83203a180c399865f49612a051693635' },
  { url: `${PYODIDE}/pyodide.asm.wasm`, out: 'pyodide/pyodide.asm.wasm', sha256: 'cc36e3cab04fdfc9a63ff13eb52eae2b911bf46c025cc7b281f394bd3de1d5e6' },
  { url: `${PYODIDE}/python_stdlib.zip`, out: 'pyodide/python_stdlib.zip', sha256: 'fa1957e5777068fc4f7437f96d860ae2fbe9c19732ba06c84e004ec16dd7dd7a' },
  { url: `${PYODIDE}/pyodide-lock.json`, out: 'pyodide/pyodide-lock.json', sha256: '5dc2fc119108bc148c7457dc86e7675b5c87e1cafd420b9c34c1eaef7b36c010' },
  { url: `https://cdn.jsdelivr.net/gh/pyodide/pyodide@${PYODIDE_VERSION.slice(1)}/LICENSE`, out: 'pyodide/LICENSE', sha256: '1f256ecad192880510e84ad60474eab7589218784b9a50bc7ceee34c2b91f1d5' }, // MPL-2.0
  { url: `${LEAFLET}/leaflet.min.js`, out: 'leaflet/leaflet.js', sha256: '5c9aecfc30e4564519dbdcddcc53a418227dcc7568e619e9762ddcec7609ed47' },
  { url: `${LEAFLET}/leaflet.min.css`, out: 'leaflet/leaflet.css', sha256: 'b570abbda963c60b4de4b4ff4b26f9326f53fb2ccf1461fdf0955ca094fb2539' },
  { url: `${LEAFLET}/images/layers.png`, out: 'leaflet/images/layers.png', sha256: '1dbbe9d028e292f36fcba8f8b3a28d5e8932754fc2215b9ac69e4cdecf5107c6' },
  { url: `${LEAFLET}/images/layers-2x.png`, out: 'leaflet/images/layers-2x.png', sha256: '066daca850d8ffbef007af00b06eac0015728dee279c51f3cb6c716df7c42edf' },
  { url: `${LEAFLET}/images/marker-icon.png`, out: 'leaflet/images/marker-icon.png', sha256: '574c3a5cca85f4114085b6841596d62f00d7c892c7b03f28cbfa301deb1dc437' },
  { url: `${LEAFLET}/images/marker-icon-2x.png`, out: 'leaflet/images/marker-icon-2x.png', sha256: '00179c4c1ee830d3a108412ae0d294f55776cfeb085c60129a39aa6fc4ae2528' },
  { url: `${LEAFLET}/images/marker-shadow.png`, out: 'leaflet/images/marker-shadow.png', sha256: '264f5c640339f042dd729062cfc04c17f8ea0f29882b538e3848ed8f10edb4da' },
  { url: 'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/LICENSE', out: 'leaflet/LICENSE', sha256: '53e8dc25862014e4324741ca18fbe3611e11d42ef69f59f86ea8c5389647d4cb' }, // BSD-2-Clause
  { url: 'https://cdnjs.cloudflare.com/ajax/libs/marked/12.0.2/marked.min.js', out: 'marked/marked.min.js', sha256: '15fabce5b65898b32b03f5ed25e9f891a729ad4c0d6d877110a7744aa847a894' },
  { url: 'https://cdn.jsdelivr.net/npm/marked@12.0.2/LICENSE.md', out: 'marked/LICENSE.md', sha256: '8e3a3f82f59a60958f56ca08f445647c32a4733dc7ca6c2c46f6eb898471ab9c' }, // MIT
];

// 编辑页和计算线程里的 CDN 地址 → 同源地址。每一条都必须命中，否则说明源文件改了，构建报错
export const EDIT_HTML_REWRITES = [
  [`${LEAFLET}/leaflet.min.css`, '/vendor/leaflet/leaflet.css'],
  [`${LEAFLET}/leaflet.min.js`, '/vendor/leaflet/leaflet.js'],
  ['https://cdnjs.cloudflare.com/ajax/libs/marked/12.0.2/marked.min.js', '/vendor/marked/marked.min.js'],
];
export const PYWORKER_REWRITES = [
  [`${PYODIDE}/pyodide.mjs`, '/vendor/pyodide/pyodide.mjs'],
  [`${PYODIDE}/`, '/vendor/pyodide/'],
];

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// 用 curl 下载：Node 的 fetch 不读 HTTPS_PROXY，curl 会读
function download(url, file) {
  mkdirSync(dirname(file), { recursive: true });
  try {
    execFileSync('curl', ['-fsSL', '--retry', '2', '--connect-timeout', '20', '--max-time', '300', '-o', file, url], { stdio: ['ignore', 'inherit', 'inherit'] });
  } catch (err) {
    rmSync(file, { force: true });
    throw new Error(`下载 ${url} 失败：${err.message}`);
  }
}

// 返回校验过的缓存文件路径（按哈希命名）：缓存里的文件哈希不对就重新下载，下载后还不对就报错
function fetchVerified({ url, sha256: want }, cache) {
  const file = join(cache, want);
  if (existsSync(file) && sha256(readFileSync(file)) === want) return file;
  download(url, file);
  const got = sha256(readFileSync(file));
  if (got !== want) {
    rmSync(file, { force: true });
    throw new Error(`${url} 的 sha256 不对：期望 ${want}，实际 ${got}`);
  }
  return file;
}

function rewrite(file, rules) {
  let text = readFileSync(file, 'utf8');
  for (const [from, to] of rules) {
    if (!text.includes(from)) throw new Error(`${file} 里找不到要改写的地址：${from}`);
    text = text.split(from).join(to);
  }
  if (/cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com/.test(text)) throw new Error(`${file} 里还有 CDN 地址`);
  writeFileSync(file, text);
}

// 返回 [[文件, 字节数], …]
export function vendor({ dist = 'dist', cache = '.cache/vendor' } = {}) {
  const sizes = [];
  for (const entry of FILES) {
    const src = fetchVerified(entry, cache);
    const size = statSync(src).size;
    if (size > MAX_BYTES) throw new Error(`${entry.out} 超过 25 MiB（${size}）`);
    const out = join(dist, 'vendor', entry.out);
    mkdirSync(dirname(out), { recursive: true });
    cpSync(src, out);
    sizes.push([entry.out, size]);
  }
  rewrite(join(dist, 'edit.html'), EDIT_HTML_REWRITES);
  rewrite(join(dist, 'pyworker.js'), PYWORKER_REWRITES);
  return sizes;
}
