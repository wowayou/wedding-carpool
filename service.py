"""界面用的计算服务：本地 ui.py 和网页版（浏览器里的 Pyodide）共用。"""

from __future__ import annotations

import math

import carpool

SAMPLE_EVERY_KM = 30  # 沿车主路线每隔多远找一次附近的火车站
ROUTE_RADIUS_KM = 25  # 每个取样点搜多大范围：比间隔的一半大，保证相邻两圈有重叠


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
    places: dict[tuple, list[carpool.Place]] = {}
    for plan in plans:
        for r in plan.routes:
            for key in ((r.driver, r.stops), (r.driver, ())):
                places.setdefault(key, [pts[i] for i in (f"car:{key[0]}", *key[1], "venue")])
    carpool.report("获取路线轨迹", 0, len(places))
    carpool.prefetch(amap, lambda: [amap.driving_query(ps) for ps in places.values()])
    paths = {}
    for i, (key, ps) in enumerate(places.items()):
        carpool.report("获取路线轨迹", i, len(places))
        paths[key] = _path(amap, ps)
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
        "resolved": trip.resolved,  # 这次按文字定位到的坐标，界面写回配置，下次不再请求
        "points": {k: {"name": p.name, "lat": p.lat, "lng": p.lng} for k, p in pts.items()},
        "plans": out,
    }


def _samples(path: list[list[float]], every_km: float) -> list[carpool.Place]:
    """沿路线（[[lat, lng], ...]）每隔 every_km 取一个点。"""
    out, walked = [], 0.0
    for (lat1, lng1), (lat2, lng2) in zip(path, path[1:]):
        walked += carpool.km_between(carpool.Place("", lng1, lat1), carpool.Place("", lng2, lat2))
        if walked >= every_km:
            out.append(carpool.Place("", lng2, lat2))
            walked = 0.0
    return out


def suggest_stations(cfg: dict, amap, valid_names: set[str] | None = None, limit: int = 15) -> dict:
    """推荐候选车站：目的地周边、各车主出发地附近、沿各车主路线找火车站，
    用 12306 站名过滤掉不办客运的站，按「车主最少绕路」和「到目的地车程」排序。"""
    resolved: list[dict] = []
    venue, people = carpool.load_places(cfg, amap, resolved)
    drivers = [p for p in people if p.drives]
    existing = {s.get("name") for s in cfg.get("stations") or []}

    # 车主直达路线，沿途取点
    carpool.report("获取车主路线，沿途取点")
    carpool.prefetch(amap, lambda: [amap.driving_query([d.home, venue]) for d in drivers])
    # 高德周边搜索半径最大 50 公里：目的地本身搜 50 公里，再在周围 60 公里处补一圈，覆盖到约 100 公里
    centers: list[tuple[carpool.Place, float, str]] = [(venue, 50, "目的地附近")]
    for k in range(6):
        angle = math.radians(60 * k)
        dlat = 60 / 111.0 * math.cos(angle)
        dlng = 60 / (111.0 * math.cos(math.radians(venue.lat))) * math.sin(angle)
        centers.append((carpool.Place("", venue.lng + dlng, venue.lat + dlat), 45, "目的地周边"))
    for d in drivers:
        centers.append((d.home, 30, f"{d.name}出发地附近"))
        try:
            path = amap.drive_path([d.home, venue])
        except carpool.QuotaError:
            raise
        except (carpool.AmapError, KeyError, IndexError):
            path = []
        centers += [(pt, ROUTE_RADIUS_KM, f"{d.name}路上") for pt in _samples(path, SAMPLE_EVERY_KM)]
    carpool.report("搜索附近的火车站", 0, len(centers))
    carpool.prefetch(amap, lambda: [amap.around_query(c, r) for c, r, _ in centers])

    found: dict[str, tuple[carpool.Place, str]] = {}
    for i, (center, radius, where) in enumerate(centers):
        carpool.report("搜索附近的火车站", i, len(centers))
        for st in carpool.pick_stations(amap.stations_around(center, radius), center, radius, 25):
            if st.name in found or st.name in existing:
                continue
            if valid_names is not None and st.name.removesuffix("站") not in valid_names:
                continue  # 12306 里没有的多半是货运站或线路所
            found[st.name] = (st, where)
    if not found:
        return {"stations": [], "resolved": resolved}

    stations = [st for st, _ in found.values()]
    # 到目的地车程：一次查完；车主到各站：每站一次（批量预取）
    origins = stations + [d.home for d in drivers]
    to_venue = dict(zip([st.name for st in stations] + [f"car:{d.name}" for d in drivers],
                        amap.drive_minutes(origins, venue)))
    carpool.report("测算各站顺不顺路", 0, len(stations))
    carpool.prefetch(amap, lambda: [amap.distance_query([d.home for d in drivers], st) for st in stations] if drivers else [])
    rows = []
    for i, st in enumerate(stations):
        carpool.report("测算各站顺不顺路", i, len(stations))
        best = None
        if drivers:
            for d, m in zip(drivers, amap.drive_minutes([d.home for d in drivers], st)):
                direct = to_venue.get(f"car:{d.name}")
                if m is None or direct is None or to_venue.get(st.name) is None:
                    continue
                detour = max(0.0, m + to_venue[st.name] - direct)
                if best is None or detour < best["detour"]:
                    best = {"driver": d.name, "detour": round(detour)}
        rows.append({
            "name": st.name, "location": st.loc, "city": st.city, "where": found[st.name][1],
            "to_venue": None if to_venue.get(st.name) is None else round(to_venue[st.name]),
            "best": best,
        })
    rows.sort(key=lambda r: ((r["best"] or {}).get("detour", math.inf), r["to_venue"] or math.inf))
    return {"stations": rows[:limit], "resolved": resolved}
