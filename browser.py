# SPDX-License-Identifier: AGPL-3.0-or-later
"""网页版的胶水代码：在浏览器的 Pyodide 里运行，由 web/pyworker.js 调用。

高德请求改发到同域的 Worker 代理（/api/t/<行程>/amap/...），Key 由 Worker 加上，不进浏览器；
编辑链接换来的 Cookie 会随同域请求自动带上。
"""

from __future__ import annotations

import datetime as dt
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
    def __init__(self, base: str = "/api", pause: float = 0.35):
        super().__init__("", pause=pause)
        self.base = base  # 行程的接口前缀，如 /api/t/abcdefghij

    def _url(self, path: str, query: str) -> str:
        return f"{self.base}/amap{path}?{query}"

    def _fetch(self, url: str) -> dict:
        # 单个请求也走 POST 批量接口（一批一个）：地点文字放在请求体里，不出现在网址上，也就不会进访问日志
        path, _, query = url[len(f"{self.base}/amap"):].partition("?")
        try:
            data = self._post_json(f"{self.base}/amap-batch", {"requests": [{"path": path, "query": query}]})
        except ValueError as e:  # 返回的不是 JSON（比如网关出错页）
            raise ConnectionError(str(e)) from e
        if "results" not in data:  # 整个请求被拒（未登录、格式不对等），把原因交给上层
            return {"status": "0", "info": str(data.get("info") or "REQUEST_FAILED"), "error": data.get("error")}
        result = data["results"][0]
        if result.get("info") == "NETWORK_ERROR":  # Worker 连不上高德：当作可重试的连接错误
            raise ConnectionError(str(result.get("error") or "NETWORK_ERROR"))
        return result

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
        stage = carpool.current_stage
        batches = (len(todo) + BATCH_LIMIT - 1) // BATCH_LIMIT
        for i in range(0, len(todo), BATCH_LIMIT):
            chunk = todo[i:i + BATCH_LIMIT]
            # 一批要按高德的频率上限慢慢发，可能要十几秒；告诉页面在等什么
            _post_progress(f"{stage}（批量请求 {len(todo)} 个，第 {i // BATCH_LIMIT + 1}/{batches} 批）", None, None)
            try:
                results = self._post_json(f"{self.base}/amap-batch", {"requests": [{"path": p, "query": q} for _, p, q in chunk]})["results"]
            except (ConnectionError, KeyError, ValueError):
                return  # 预取只是加速，失败了就逐个请求
            for (key, _, _), data in zip(chunk, results):
                carpool.check_quota(str(data.get("info")), carpool._text(data.get("error")))
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


class TryAmap:
    """试玩模式（/try）用的计算后端：不碰网络，也不继承 BrowserAmap 的请求代码。
    行车时间按直线距离估算，路线画成直线；查地点、查车站、查公交一律报错（试玩只能改已有的内容）。"""

    is_try = True  # carpool.plan_trip 据此给报告加试玩的说明
    DETOUR = 1.3  # 直线距离到路程的折算系数
    SPEED_KMH = 75.0
    CITY_MIN = 10.0  # 进出城的固定耗时
    REFUSE = "试玩模式不能查新地点和公交；想用真实地点，请新建行程"

    def __init__(self):
        self.calls = 0
        self.cache: dict[str, dict] = {}

    def _refuse(self, *_args, **_kwargs):
        raise carpool.AmapError(self.REFUSE)

    geocode = search = find_station = stations_near = stations_around = transit = _refuse

    def drive_minutes(self, origins: list[carpool.Place], dest: carpool.Place) -> list[float | None]:
        out = []
        for o in origins:
            km = carpool.km_between(o, dest)
            out.append(0.0 if km == 0 else km * self.DETOUR / self.SPEED_KMH * 60 + self.CITY_MIN)
        return out

    def drive_path(self, places: list[carpool.Place], max_points: int = 600) -> list[list[float]]:
        return [[p.lat, p.lng] for p in places]


BATCH_LIMIT = 40  # Worker 免费套餐单次请求最多 50 个子请求


def _post_progress(label: str, done, total) -> None:
    """把进度发给页面（Web Worker 的 postMessage，页面在计算进行中也能收到）。"""
    try:
        from js import Object, postMessage
        from pyodide.ffi import to_js
    except ImportError:  # 不在浏览器里（测试）
        return
    postMessage(to_js({"progress": {"label": label, "done": done, "total": total}}, dict_converter=Object.fromEntries))


carpool.progress = _post_progress
amap: carpool.Amap = BrowserAmap()
_last: dict | None = None


def handle(method: str, args_json: str) -> str:
    """JS 调用入口：方法名 + JSON 参数，返回 JSON 字符串；出错时返回 {"error": ...}。"""
    global _last, amap
    args = json.loads(args_json)
    try:
        if method == "init":  # 打开行程时设定接口前缀
            amap = TryAmap() if args.get("try") else BrowserAmap(args["base"])
            _last = None
            result = {"ok": True}
        elif method == "suggest":
            valid = set(args["valid_names"]) if args.get("valid_names") else None
            result = service.suggest_stations(args["config"], amap, valid)
        elif method == "plan":
            _last = service.compute(args["config"], amap)
            result = service.plan_payload(_last)
        elif method == "search":
            types = carpool.STATION_TYPE if args.get("station") else None
            result = {"results": amap.search(args["q"], args.get("city") or None, types)}
        elif method == "share":
            if _last is None:
                raise SystemExit("先点「计算方案」，再生成方案页")
            index, back_index = int(args.get("plan", 0)), int(args.get("back_plan", 0))
            share.check_choice(_last, index, back_index)
            expires = args.get("expires")  # 行程的自动删除时间（毫秒时间戳），按北京时间取日期
            expires_date = dt.datetime.fromtimestamp(expires / 1000, dt.timezone(dt.timedelta(hours=8))).date() if expires else None
            result = {"html": share.render_share(_last, index, back_index, expires=expires_date)}
        else:
            raise SystemExit(f"未知操作：{method}")
    except SystemExit as e:
        result = {"error": str(e.code)}
    except carpool.AmapError as e:
        result = {"error": str(e) if getattr(amap, "is_try", False) else f"高德接口报错：{e}"}
    except Exception as e:  # noqa: BLE001 —— 错误要显示在界面上
        result = {"error": f"{type(e).__name__}: {e}"}
    return json.dumps(result, ensure_ascii=False, default=str)


if sys.platform == "emscripten":  # 只在浏览器里替换
    time.sleep = _busy_sleep
