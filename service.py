"""界面用的计算服务：本地 ui.py 和网页版（浏览器里的 Pyodide）共用。"""

from __future__ import annotations

import carpool


def _path(amap, places: list[carpool.Place]) -> list | None:
    try:
        return amap.drive_path(places)
    except carpool.QuotaError:
        raise  # 配额用完要停下提示，不能悄悄改画直线
    except (carpool.AmapError, KeyError, IndexError):
        return None  # 取不到轨迹时界面画直线示意


def compute(cfg: dict, amap) -> dict:
    """算方案，并取车主路线的真实行车轨迹：接人后的路线，以及不接人时的直达路线（用来对比绕路）。"""
    trip, pts, T, plans = carpool.plan_trip(cfg, amap)
    paths: dict[tuple, list | None] = {}
    for plan in plans:
        for r in plan.routes:
            for key in ((r.driver, r.stops), (r.driver, ())):
                if key not in paths:
                    paths[key] = _path(amap, [pts[i] for i in (f"car:{key[0]}", *key[1], "venue")])
    return {"trip": trip, "pts": pts, "T": T, "plans": plans, "paths": paths}


def plan_payload(state: dict) -> dict:
    """给界面的 JSON：报告、坐标、各方案的路线（含直达对比）和时刻。"""
    trip, pts, T, plans, paths = (state[k] for k in ("trip", "pts", "T", "plans", "paths"))
    out = []
    for plan in plans:
        ready = carpool.pickup_ready(plan, trip)
        routes = []
        for r in plan.routes:
            sched = carpool.route_schedule(r, ready, T)
            routes.append({"driver": r.driver, "stops": list(r.stops), "minutes": round(r.minutes),
                           "detour": round(r.detour), "path": paths[(r.driver, r.stops)],
                           "direct_path": paths[(r.driver, ())] if r.stops else None,
                           "depart": carpool.clock(sched["depart"]) if sched else None})
        out.append({"rides": {k: list(v) for k, v in plan.rides.items()}, "taxi": plan.taxi,
                    "stranded": plan.stranded, "detour": round(plan.detour), "routes": routes})
    return {
        "report": carpool.render(trip, pts, T, plans),
        "warnings": trip.warnings,
        "points": {k: {"name": p.name, "lat": p.lat, "lng": p.lng} for k, p in pts.items()},
        "plans": out,
    }
