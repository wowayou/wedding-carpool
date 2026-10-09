#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""拼车出行规划的本地网页界面：在浏览器里填人、地点和车站，点一下算方案，结果画在高德地图上。

    python3 ui.py                 # 编辑 trip.toml，打开 http://127.0.0.1:8765
    python3 ui.py other.toml --port 9000

只监听本机；高德 Key 留在服务端（环境变量 AMAP_KEY 或同目录 .amap_key），不会发到浏览器。
保存会覆盖配置文件里的手写注释，第一次保存前把原文件备份成 <配置>.bak。
「生成方案页」把当前方案写成 <配置名>-plan.html（见 share.py），可以直接发给同行的人。
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import tomllib
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import carpool
import share
from service import compute, plan_payload, suggest_stations

HERE = Path(__file__).parent
STATIONS_12306 = HERE / "web" / "stations12306.json"
CONFIG_FIELDS = HERE / "config-fields.json"  # 配置项定义：编辑页取占位、范围、中文名
VALID_STATIONS = set(json.loads(STATIONS_12306.read_text(encoding="utf-8"))["stations"]) if STATIONS_12306.exists() else None
# 页面用到的静态文件：设计系统样式、图标集、站点图标（网页版由 Cloudflare 的静态资源提供，本地版由这里提供）
STATIC_FILES = {
    "/design.css": (HERE / "web" / "design.css", "text/css; charset=utf-8"),
    "/icons.svg": (HERE / "web" / "partials" / "icons.svg", "image/svg+xml"),
    "/favicon.svg": (HERE / "web" / "favicon.svg", "image/svg+xml"),
    "/apple-touch-icon.png": (HERE / "web" / "apple-touch-icon.png", "image/png"),
}
# 编辑页的脚本模块（web/editor/*.js）：浏览器要求模块的 MIME 是 JavaScript。只开放这个目录下现有的 .js 文件（逐个列出，请求路径必须正好等于键），不按请求路径去拼文件路径
STATIC_FILES.update({f"/editor/{p.name}": (p, "text/javascript; charset=utf-8") for p in sorted((HERE / "web" / "editor").glob("*.js"))})
SAVE_HEADER = "# 由 ui.py 保存。手写注释不会保留，第一次保存前的原文件在同名 .bak 里\n"


class App:
    def __init__(self, config: Path, amap):
        self.config = config
        self.amap = amap
        self.backed_up = False
        self.last: dict | None = None  # 最近一次计算结果，生成方案页用

    @property
    def share_path(self) -> Path:
        return self.config.with_name(f"{self.config.stem}-plan.html")

    def plan(self, cfg: dict) -> dict:
        self.last = compute(cfg, self.amap)
        return plan_payload(self.last)

    def share(self, plan: int = 0, back_plan: int = 0) -> dict:
        if not self.last:
            raise SystemExit("先点「计算方案」，再生成方案页")
        share.check_choice(self.last, plan, back_plan)
        self.share_path.write_text(share.render_share(self.last, plan, back_plan), encoding="utf-8")
        return {"file": self.share_path.name, "url": "/share"}

    def load(self) -> dict:
        src = self.config if self.config.exists() else HERE / "trip.example.toml"
        return tomllib.loads(src.read_text(encoding="utf-8"))

    def save(self, cfg: dict) -> None:
        if self.config.exists() and not self.backed_up:
            shutil.copyfile(self.config, self.config.with_name(self.config.name + ".bak"))
        self.backed_up = True
        self.config.write_text(carpool.dump_toml(cfg, SAVE_HEADER), encoding="utf-8")


def make_handler(app: App):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):  # 安静一点，只打印出错
            pass

        def _send(self, status: int, body: bytes, ctype: str) -> None:
            self.send_response(status)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _json(self, data, status: int = 200) -> None:
            body = json.dumps(data, ensure_ascii=False, default=str)  # TOML 日期字面量转成字符串
            self._send(status, body.encode(), "application/json; charset=utf-8")

        def _body(self) -> dict:
            return json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")

        def _guard(self, fn) -> None:
            try:
                self._json(fn())
            except SystemExit as e:  # load_trip 用 SystemExit 报配置错误
                self._json({"error": str(e.code)}, 400)
            except carpool.AmapError as e:
                self._json({"error": f"高德接口报错：{e}"}, 502)
            except Exception as e:  # noqa: BLE001 —— 界面需要看到出错原因
                print(f"出错：{e!r}", file=sys.stderr)
                self._json({"error": f"{type(e).__name__}: {e}"}, 500)

        def do_GET(self):
            url = urllib.parse.urlsplit(self.path)
            if url.path in ("/", "/index.html"):
                self._send(200, (HERE / "ui.html").read_bytes(), "text/html; charset=utf-8")
            elif url.path in STATIC_FILES and STATIC_FILES[url.path][0].exists():
                path, ctype = STATIC_FILES[url.path]
                self._send(200, path.read_bytes(), ctype)
            elif url.path == "/stations12306.json" and STATIONS_12306.exists():
                self._send(200, STATIONS_12306.read_bytes(), "application/json; charset=utf-8")
            elif url.path == "/config-fields.json" and CONFIG_FIELDS.exists():
                self._send(200, CONFIG_FIELDS.read_bytes(), "application/json; charset=utf-8")
            elif url.path == "/share":
                if app.share_path.exists():
                    self._send(200, app.share_path.read_bytes(), "text/html; charset=utf-8")
                else:
                    self._send(404, "还没有生成方案页".encode(), "text/plain; charset=utf-8")
            elif url.path == "/api/env":
                self._json({"mode": "local"})
            elif url.path == "/api/config":
                self._guard(lambda: {"config": app.load(), "file": app.config.name})
            elif url.path == "/api/search":
                q = urllib.parse.parse_qs(url.query)
                types = carpool.STATION_TYPE if q.get("station") else None  # 车站只搜火车站，免得排出汽车站
                self._guard(lambda: {"results": app.amap.search(q["q"][0], (q.get("city") or [None])[0], types)})
            else:
                self._json({"error": "not found"}, 404)

        def do_POST(self):
            if self.path == "/api/config":
                self._guard(lambda: (app.save(self._body()["config"]), {"saved": app.config.name})[1])
            elif self.path == "/api/plan":
                self._guard(lambda: app.plan(self._body()["config"]))
            elif self.path == "/api/suggest":
                self._guard(lambda: (lambda b: suggest_stations(b["config"], app.amap, VALID_STATIONS, plan_only=bool(b.get("plan_only"))))(self._body()))
            elif self.path == "/api/share":
                self._guard(lambda: app.share(**{k: int(v) for k, v in self._body().items() if k in ("plan", "back_plan")}))
            else:
                self._json({"error": "not found"}, 404)

    return Handler


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description="拼车出行规划的本地网页界面")
    ap.add_argument("config", nargs="?", default=str(HERE / "trip.toml"), help="配置文件，默认 trip.toml")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--key", default=carpool.default_key(), help="高德 Web 服务 Key")
    args = ap.parse_args(argv)
    if not args.key:
        ap.error("缺少高德 Key：先 export AMAP_KEY=你的Key，或存进 .amap_key")
    app = App(Path(args.config), carpool.Amap(args.key))
    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(app))
    print(f"打开 http://127.0.0.1:{args.port}  （编辑 {app.config}，Ctrl+C 退出）")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
