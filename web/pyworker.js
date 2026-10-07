// 网页版的计算线程：在 Web Worker 里加载 Pyodide，运行和本地版相同的 Python 代码（见 browser.py）。
// 放在 Worker 里是因为高德请求用同步 XHR，不能卡住页面。
// 用模块 Worker + import：经代理的环境里 importScripts 跨域加载会失败，import 走 CORS 没问题。
import { loadPyodide } from 'https://cdn.jsdelivr.net/pyodide/v314.0.7/full/pyodide.mjs';

const PYODIDE = 'https://cdn.jsdelivr.net/pyodide/v314.0.7/full/';

const ready = (async () => {
  const py = await loadPyodide({ indexURL: PYODIDE }); // Worker 里推断不出文件位置，要显式给
  for (const name of ['carpool.py', 'share.py', 'service.py', 'browser.py']) {
    const res = await fetch('py/' + name, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`加载 ${name} 失败（${res.status}）`);
    py.FS.writeFile(name, await res.text());
  }
  py.runPython('import sys\nif "." not in sys.path: sys.path.insert(0, ".")');
  return py.pyimport('browser').handle;
})();

self.onmessage = async (event) => {
  const { id, method, args } = event.data;
  try {
    const handle = await ready;
    self.postMessage({ id, result: JSON.parse(handle(method, JSON.stringify(args))) });
  } catch (err) {
    self.postMessage({ id, result: { error: `计算环境出错：${err && err.message ? err.message : err}` } });
  }
};
