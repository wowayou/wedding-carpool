"""网页版的胶水代码：在浏览器的 Pyodide 里运行，由 web/pyworker.js 调用。

高德请求改发到同域的 Worker 代理（/api/amap/...），Key 由 Worker 加上，不进浏览器；
登录口令对应的 Cookie 会随同域请求自动带上。
"""

from __future__ import annotations

import json
import sys
import time

import carpool
import service
import share


def _busy_sleep(seconds: float) -> None:
    # Pyodide 的 Web Worker 里 time.sleep 不保证真的等待；接口限速和重试需要真等
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        pass


class BrowserAmap(carpool.Amap):
    def _url(self, path: str, query: str) -> str:
        return f"/api/amap{path}?{query}"

    def _fetch(self, url: str) -> dict:
        from pyodide.http import open_url  # 同步 XHR，只能在 Web Worker 里用

        try:
            text = open_url(url).getvalue()
        except Exception as e:  # noqa: BLE001 —— 浏览器网络错误统一当作可重试的连接错误
            raise ConnectionError(str(e)) from e
        return json.loads(text)


amap: carpool.Amap = BrowserAmap("", pause=0.35)
_last: dict | None = None


def handle(method: str, args_json: str) -> str:
    """JS 调用入口：方法名 + JSON 参数，返回 JSON 字符串；出错时返回 {"error": ...}。"""
    global _last
    args = json.loads(args_json)
    try:
        if method == "plan":
            _last = service.compute(args["config"], amap)
            result = service.plan_payload(_last)
        elif method == "search":
            types = carpool.STATION_TYPE if args.get("station") else None
            result = {"results": amap.search(args["q"], args.get("city") or None, types)}
        elif method == "share":
            if _last is None:
                raise SystemExit("先点「计算方案」，再生成方案页")
            index = int(args.get("plan", 0))
            if not 0 <= index < len(_last["plans"]):
                raise SystemExit(f"没有方案 {index + 1}")
            result = {"html": share.render_share(_last, index)}
        else:
            raise SystemExit(f"未知操作：{method}")
    except SystemExit as e:
        result = {"error": str(e.code)}
    except carpool.AmapError as e:
        result = {"error": f"高德接口报错：{e}"}
    except Exception as e:  # noqa: BLE001 —— 错误要显示在界面上
        result = {"error": f"{type(e).__name__}: {e}"}
    return json.dumps(result, ensure_ascii=False, default=str)


if sys.platform == "emscripten":  # 只在浏览器里替换
    time.sleep = _busy_sleep
