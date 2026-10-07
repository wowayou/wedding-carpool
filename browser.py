"""网页版的胶水代码：在浏览器的 Pyodide 里运行，由 web/pyworker.js 调用。

高德请求改发到同域的 Worker 代理（/api/amap/...），Key 由 Worker 加上，不进浏览器；
登录口令对应的 Cookie 会随同域请求自动带上。
"""

from __future__ import annotations

import json
import sys
import time
import urllib.parse

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

    def prefetch(self, queries: list[tuple[str, dict]]) -> None:
        """把一组请求一次发给 Worker 并发去取，结果放进缓存；之后逐个调用直接命中。

        取失败的不缓存，留给逐个调用按原来的重试逻辑处理；配额用完则立即停下。
        """
        todo, seen = [], set()
        for path, params in queries:
            query = urllib.parse.urlencode(params)
            key = f"{path}?{query}"
            if key not in self.cache and key not in seen:
                seen.add(key)
                todo.append((key, path, query))
        for i in range(0, len(todo), BATCH_LIMIT):
            chunk = todo[i:i + BATCH_LIMIT]
            try:
                results = self._post_json("/api/amap-batch", {"requests": [{"path": p, "query": q} for _, p, q in chunk]})["results"]
            except (ConnectionError, KeyError, ValueError):
                return  # 预取只是加速，失败了就逐个请求
            for (key, _, _), data in zip(chunk, results):
                carpool.check_quota(str(data.get("info")))
                if str(data.get("status")) == "1":
                    self.cache[key] = data

    def _post_json(self, url: str, payload: dict) -> dict:
        from js import XMLHttpRequest  # 同步 POST；pyodide.http.open_url 只支持 GET

        xhr = XMLHttpRequest.new()
        xhr.open("POST", url, False)
        xhr.setRequestHeader("Content-Type", "application/json")
        try:
            xhr.send(json.dumps(payload))
        except Exception as e:  # noqa: BLE001
            raise ConnectionError(str(e)) from e
        return json.loads(xhr.responseText)


BATCH_LIMIT = 40  # Worker 免费套餐单次请求最多 50 个子请求
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
