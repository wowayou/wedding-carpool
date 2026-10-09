#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""拼车出行规划：多人从不同城市去同一个地方，用高德真实行车时间算哪个高铁站最顺路、谁搭谁的车。

    export AMAP_KEY=你的高德Web服务Key     # 或把 Key 存进同目录的 .amap_key
    python3 carpool.py trip.toml          # 报告同时打印并写到 trip-report.md
    python3 ui.py                         # 网页界面，见 ui.py

配置格式见 trip.example.toml。只依赖 Python 3.11+ 标准库。

这个文件是门面：计算核心按职责拆在下面几个模块里，这里把原来的名字都重新导出，
所以 service.py、share.py、browser.py、ui.py 和测试里的 carpool.X 照旧可用；命令行也从这里进。

    base       常量、配置项定义、进度回调（最底层，不依赖其他模块）
    geo        地点（Place）、高德客户端（Amap）、AmapLike 接口、错误类型、额度判断、找站时的 POI 过滤
    model      行程模型（Person、Trip、Leg）、读配置、估算公交用时、行车时间矩阵
    routes     候选路线（Route）、方案（Plan）、乘客分配
    taxi       打车安排（TaxiPool）
    solver     求解（solve）、plan_trip
    timetable  行程表（谁几点出发、几点到哪）
    reporting  报告（Markdown 文字）
    tomlio     配置写回 TOML

依赖是单向的：base、geo 在最底层；model → base、geo；routes → model；taxi → model、routes；
solver → model、routes、taxi；timetable → model、routes、taxi；reporting → model、routes、timetable；tomlio 不依赖其他模块。

模块级的可变全局（见 _LiveModule）：
    carpool.progress = 回调 / carpool.current_stage / carpool.TAXI_COMBO_LIMIT 等常量，
    读写这个门面和读写定义它的模块是同一回事。`from base import x` 式的拷贝只会拿到当时的值，
    所以拆分后给门面赋值也必须生效（browser.py 设置 progress、测试里改上限都靠它）。
"""

from __future__ import annotations

import argparse
import os
import sys
import time  # noqa: F401  测试里 mock.patch("carpool.time.sleep") 要能找到
import tomllib
import types
import urllib.error  # noqa: F401  同上，carpool.urllib.request.urlopen
import urllib.parse  # noqa: F401
import urllib.request  # noqa: F401
from pathlib import Path

import base
import geo
import model
import reporting
import routes
import solver
import taxi
import timetable
import tomlio
from base import defaults_from, load_fields, report
from geo import (Amap, AmapError, AmapLike, AmapPrefetch, Place, QuotaError, check_quota, km_between, parse_loc,
                 pick_stations, reject_reason, route_strategy, _text)
from model import (Leg, Person, Trip, back_leg, build_matrix, check_unique_names, clock, estimate_rail, leave_time,
                   load_places, load_trip, points_of, prefetch, resolve, train_times)
from routes import (Plan, Route, arrival_at, assign, _assign_groups, back_deadline, car_routes, leave_of, leg_minutes,
                    rider_options, stop_times)
from taxi import Arrangement, TaxiPool, pack_cars, taxi_cars, taxi_slot
from solver import evaluate, plan_trip, solve
from timetable import (CarTrip, Rider, Stop, Stranded, TaxiCar, Timeline, Timelines, pickup_ready, route_schedule,
                       timeline, timelines)
from reporting import (cost_parts, describe, describe_back, fmt_min, marker_url, nav_url, paragraphs, rail_section,
                       rank_basis, render, route_links, route_nav, station_table, stop_label, taxi_fare, who)
from tomlio import dump_toml, _toml_key, _toml_value

_OWNERS = (base, geo, model, routes, taxi, solver, timetable, reporting, tomlio)  # 依赖顺序：底层在前


def _live_names() -> dict[str, types.ModuleType]:
    """常量和可变全局（不是函数、类、模块）→ 定义它的模块。先到先得，所以 INF 这类被别的模块 import 的名字归 base。"""
    live: dict[str, types.ModuleType] = {}
    for mod in _OWNERS:
        for name, value in vars(mod).items():
            if (name.startswith("_") or name == "annotations" or isinstance(value, (types.FunctionType, type, types.ModuleType))
                    or name in live):
                continue
            live[name] = mod
    return live


_LIVE = _live_names()


class _LiveModule(types.ModuleType):
    """把对 _LIVE 里那些名字的读、写、删转给定义它们的模块，门面自己不存一份拷贝。"""

    def __setattr__(self, name: str, value) -> None:
        if name in _LIVE:
            setattr(_LIVE[name], name, value)
        else:
            super().__setattr__(name, value)

    def __delattr__(self, name: str) -> None:
        if name in _LIVE:  # mock.patch 退出时会先 delattr 再按需 setattr 还原
            delattr(_LIVE[name], name)
        else:
            super().__delattr__(name)


def __getattr__(name: str):
    if name in _LIVE:
        return getattr(_LIVE[name], name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


sys.modules[__name__].__class__ = _LiveModule


def run(cfg: dict, amap: AmapLike) -> str:
    trip, pts, T, plans = plan_trip(cfg, amap)
    return render(trip, pts, T, plans, timelines(trip, T, plans))


def default_key() -> str | None:
    if os.environ.get("AMAP_KEY"):
        return os.environ["AMAP_KEY"]
    path = Path(__file__).with_name(".amap_key")
    return path.read_text(encoding="utf-8").strip() if path.exists() else None


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description="用高德行车时间规划拼车和高铁站接驳")
    ap.add_argument("config", help="行程配置（TOML），格式见 trip.example.toml")
    ap.add_argument("-o", "--out", help="报告路径，默认 <配置名>-report.md")
    ap.add_argument("--key", default=default_key(),
                    help="高德 Web 服务 Key，默认读环境变量 AMAP_KEY，其次读同目录的 .amap_key")
    args = ap.parse_args(argv)
    if not args.key:
        ap.error("缺少高德 Key：先 export AMAP_KEY=你的Key，或存进 .amap_key，或加 --key")
    path = Path(args.config)
    cfg = tomllib.loads(path.read_text(encoding="utf-8"))
    amap = Amap(args.key)
    try:
        report = run(cfg, amap)
    except AmapError as e:
        sys.exit(f"高德接口报错：{e}")
    out = Path(args.out) if args.out else path.with_name(f"{path.stem}-report.md")
    out.write_text(report, encoding="utf-8")
    print(report)
    print(f"报告已写入 {out}（共调用高德接口 {amap.calls} 次）", file=sys.stderr)


if __name__ == "__main__":
    main()
