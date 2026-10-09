# SPDX-License-Identifier: AGPL-3.0-or-later
"""界面用的计算服务：本地 ui.py 和网页版（浏览器里的 Pyodide）共用。"""

from __future__ import annotations

import math
from collections import Counter

import carpool

# ---------- 推荐车站：搜索圈的几何 ----------
SEARCH_MAX_KM = 50.0   # 高德周边搜索半径上限
COVER_KM = 49.0        # 六边形网格里每个格点负责的半径：比搜索半径小 1 公里，留给经纬度换算的误差
KM_PER_DEG = 111.195   # 纬度 1 度的公里数
PAGES = 3              # 每个圈最多翻几页
KM_PER_MIN = 2.0       # 绕路上限换算：车速不超过 120 公里/小时
NEAR_KM = 1.0          # 备选路线的取样点离已有的圈这么近就不重复搜


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
    for plan in trip.back_plans:  # 返程插件：目的地 → 送人点 → 车主家
        for r in plan.routes:
            for stops in (r.stops, ()):
                places.setdefault(("back", r.driver, stops), [pts[i] for i in trip.back.sequence(r.driver, stops)])
    carpool.report("获取路线轨迹", 0, len(places))
    carpool.prefetch(amap, lambda: [amap.driving_query(ps) for ps in places.values()])
    paths = {}
    for i, (key, ps) in enumerate(places.items()):
        carpool.report("获取路线轨迹", i, len(places))
        paths[key] = _path(amap, ps)
    return {"trip": trip, "pts": pts, "T": T, "plans": plans, "paths": paths,
            "timelines": carpool.timelines(trip, T, plans)}  # 时刻只在这里算一次，报告、方案页、界面数据都读它


def _back_payload(trip, tls, paths) -> dict | None:
    if not trip.back:
        return None
    out = []
    for plan, tl in zip(trip.back_plans, tls.back):
        routes = [{"driver": r.driver, "stops": list(r.stops), "minutes": round(r.minutes), "detour": round(r.detour),
                   "path": paths.get(("back", r.driver, r.stops)),
                   "direct_path": paths.get(("back", r.driver, ())) if r.stops else None,
                   "depart": carpool.clock(car.depart)} for r, car in zip(plan.routes, tl.cars)]
        out.append({"rides": {k: list(v) for k, v in plan.rides.items()}, "taxi": plan.taxi, "stranded": plan.stranded,
                    "detour": round(plan.detour), "carried": plan.carried, "taxi_cars": plan.taxi_cars, "routes": routes})
    return {"depart": carpool.clock(trip.back.depart), "plans": out}


def plan_payload(state: dict) -> dict:
    """给界面的 JSON：报告、坐标、各方案的路线（含直达对比）和时刻；开了返程再带上返程方案。时刻都读行程表。"""
    trip, pts, T, plans, paths, tls = (state[k] for k in ("trip", "pts", "T", "plans", "paths", "timelines"))
    out = []
    for plan, tl in zip(plans, tls.out):
        routes = [{"driver": r.driver, "stops": list(r.stops), "minutes": round(r.minutes),
                   "detour": round(r.detour), "path": paths[(r.driver, r.stops)],
                   "direct_path": paths[(r.driver, ())] if r.stops else None,
                   "depart": carpool.clock(car.depart) if car.depart is not None else None} for r, car in zip(plan.routes, tl.cars)]
        out.append({"rides": {k: list(v) for k, v in plan.rides.items()}, "taxi": plan.taxi,
                    "stranded": plan.stranded, "detour": round(plan.detour), "carried": plan.carried, "taxi_cars": plan.taxi_cars, "routes": routes})
    return {
        "report": carpool.render(trip, pts, T, plans, tls),
        "outbound": trip.outbound,  # false：只规划返程，plans 为空
        "warnings": trip.warnings,
        "resolved": trip.resolved,  # 这次按文字定位到的坐标，界面写回配置，下次不再请求
        "points": {k: {"name": p.name, "lat": p.lat, "lng": p.lng} for k, p in pts.items()},
        "plans": out,
        "back": _back_payload(trip, tls, paths),
    }


def _place(lat: float, lng: float) -> carpool.Place:
    return carpool.Place("", lng, lat)


def hex_centers(anchor: carpool.Place, reach_km: float, keep) -> list[carpool.Place]:
    """六边形网格的圆心，圆心间距 √3·COVER_KM，保证 anchor 周围 reach_km 内的每个点离某个圆心不超过 COVER_KM。
    只留下 keep(圆心) 为真的；调用方负责把 keep 写成「离目标区域不超过 SEARCH_MAX_KM」的超集。"""
    rows = math.ceil(reach_km / (1.5 * COVER_KM)) + 1
    out = []
    for k in range(-rows, rows + 1):
        lat = anchor.lat + k * 1.5 * COVER_KM / KM_PER_DEG
        if abs(lat) > 85:
            continue
        step = math.sqrt(3) * COVER_KM / (KM_PER_DEG * math.cos(math.radians(lat)))  # 这一行的经度间距
        half = reach_km / (KM_PER_DEG * math.cos(math.radians(lat))) + step
        for j in range(-math.ceil(half / step), math.ceil(half / step) + 1):
            p = _place(lat, anchor.lng + (j + 0.5 * (k % 2)) * step)
            if keep(p):
                out.append(p)
    return out


def dest_circles(venue: carpool.Place, radius_km: float) -> list[tuple[carpool.Place, float]]:
    """目的地周边 radius_km 内的搜索圈 [(圆心, 半径)]：不超过 50 公里一个圈，再大就用 50 公里的圈铺满。"""
    if radius_km <= SEARCH_MAX_KM:
        return [(venue, radius_km)]
    reach = radius_km + SEARCH_MAX_KM
    centers = hex_centers(venue, reach, lambda p: carpool.km_between(venue, p) <= reach)
    centers.sort(key=lambda p: carpool.km_between(venue, p))
    return [(p, SEARCH_MAX_KM) for p in centers]


def route_samples(path: list[list[float]], step_km: float) -> list[carpool.Place]:
    """沿路线（[[lat, lng], ...]）从起点到终点，每隔 step_km 取一个点（首尾都取），相邻两点沿路线不超过 step_km。"""
    pts = [_place(lat, lng) for lat, lng in path]
    if not pts:
        return []
    out, since = [pts[0]], 0.0  # since：离上一个取样点沿路线走了多远
    for a, b in zip(pts, pts[1:]):
        seg = carpool.km_between(a, b)
        pos = 0.0
        while seg > 0 and since + seg - pos >= step_km:
            pos += step_km - since
            since = 0.0
            f = pos / seg
            out.append(_place(a.lat + (b.lat - a.lat) * f, a.lng + (b.lng - a.lng) * f))
        since += seg - pos
    if since > 1e-9:
        out.append(pts[-1])
    return out


def route_radius(step_km: float, radius_km: float) -> tuple[float, float]:
    """沿路搜索半径：要大于间隔的一半两圈才连得上，也不能超过 50 公里。返回（实际半径, 保证覆盖的路线两侧宽度）。"""
    r = min(radius_km, SEARCH_MAX_KM)
    if r <= step_km / 2:
        r = step_km / 2 + 1
    return r, math.sqrt(r * r - (step_km / 2) ** 2)


def detour_circles(home: carpool.Place, venue: carpool.Place, route_km: float, limit_min: float,
                   route_min: float | None = None) -> list[carpool.Place]:
    """绕路上限内全覆盖。绕路不超过 limit_min 分钟，约束的是时间：用时(家→站→目的地) ≤ 直达用时 + limit_min；
    直线距离之和不超过每分钟 2 公里 × 用时，所以「家到站 + 站到目的地」≤ 2·(直达用时 + limit_min)，
    是以家和目的地为焦点的椭圆。直达路线慢、经过站的路快时，按路程算会漏，所以两种取大。
    拿不到直达用时（route_min 为 None）就只能按路程算：路程 + 2·limit_min，可能不全。
    用 50 公里的圈把椭圆铺满：格点留下和 ≤ 上面的值再加 100 公里的。"""
    total = max(route_km, carpool.km_between(home, venue)) + KM_PER_MIN * limit_min
    if route_min is not None:
        total = max(total, KM_PER_MIN * (route_min + limit_min))
    total += 2 * SEARCH_MAX_KM
    mid = _place((home.lat + venue.lat) / 2, (home.lng + venue.lng) / 2)
    reach = total / 2 * 1.05 + 5  # 椭圆离中点最远 total/2，多留一点免得中点取得不准
    return hex_centers(mid, reach, lambda p: carpool.km_between(home, p) + carpool.km_between(p, venue) <= total)


def normalize_settings(raw) -> tuple[dict, list[str]]:
    """options.suggest 夹紧到 config-fields.json 定义的范围：非法值回落到默认，超范围的夹到边界，
    不合法的组合不报错，调整了什么写进说明。返回（实际生效的设置, 说明）。"""
    raw = raw if isinstance(raw, dict) else {}
    notes: list[str] = []
    out: dict = {}
    for path, f in carpool.FIELDS.items():
        if not path.startswith("options.suggest."):
            continue
        key, label, kind = path.rsplit(".", 1)[1], f["label"], f["type"]
        default, v = f.get("default", []), raw.get(key)
        if v is None:
            out[key] = default
        elif kind in ("number", "integer"):
            try:
                num = float(v) if isinstance(v, (int, float, str)) and not isinstance(v, bool) else math.nan
            except ValueError:
                num = math.nan
            if not math.isfinite(num):
                notes.append(f"「{label}」的值不合法，改用默认的 {default}")
                out[key] = default
                continue
            lo, hi = f.get("min", -math.inf), f.get("max", math.inf)
            clamped = min(max(num, lo), hi)
            if kind == "integer":
                clamped = round(clamped)
            if clamped != num:
                notes.append(f"「{label}」{num:g} 超出 {lo:g} 到 {hi:g}，已调为 {clamped:g}")
            out[key] = int(clamped) if kind == "integer" else clamped
        elif kind == "choice":
            hit = [c["value"] for c in f["choices"] if not isinstance(v, bool) and (c["value"] == v or str(c["value"]) == str(v))]
            if not hit:
                notes.append(f"「{label}」的值不合法，改用默认的「{next(c['label'] for c in f['choices'] if c['value'] == default)}」")
            out[key] = hit[0] if hit else default
        elif kind == "multi":
            valid = [c["value"] for c in f["choices"]]
            if not isinstance(v, list):
                notes.append(f"「{label}」的值不合法，改用默认")
                out[key] = default
                continue
            out[key] = [c for c in valid if c in v]
            if extra := [x for x in v if x not in valid]:
                notes.append(f"「{label}」里有不认识的项，已忽略：{'、'.join(str(x) for x in extra)}")
            if not out[key]:
                notes.append(f"「{label}」一项都没选，这次不会搜索任何地方")
        elif kind == "boolean":
            if not isinstance(v, bool):
                notes.append(f"「{label}」的值不合法，改用默认的{'开' if default else '关'}")
            out[key] = v if isinstance(v, bool) else default
        else:  # list：车主名单
            if not isinstance(v, list):
                notes.append(f"「{label}」的值不合法，改用默认（全部车主）")
            out[key] = [str(x) for x in v] if isinstance(v, list) else default
    if out["checked_count"] > out["show_count"]:
        notes.append(f"默认勾选个数不能超过显示个数，已调为 {out['show_count']}")
        out["checked_count"] = out["show_count"]
    r, _ = route_radius(out["route_step_km"], out["route_radius_km"])
    if r != out["route_radius_km"]:
        if "owner_route" in out["areas"] and out["route_cover"] == "along":
            why = "高德周边搜索半径最大 50 公里" if r < out["route_radius_km"] else "相邻两圈才连得上"
            notes.append(f"沿路范围从 {out['route_radius_km']:g} 公里调到 {r:g} 公里（{why}）")
        out["route_radius_km"] = r
    if out["sort"] == "rider_home" and "rider_home" not in out["areas"]:
        notes.append("「离乘客家最近」只在找了乘客出发地附近时有效，改按车主最少绕路排序")
        out["sort"] = "detour"
    return out, notes


def _detour_table(amap, venue, drivers, stations, back_only) -> tuple[dict, dict]:
    """各站到目的地的车程（返程是目的地到站），以及每位车主「家 → 站 → 目的地」比直达多绕多久（量不出来是 None）。
    返回（{站名: 分钟}, {(车主, 站名): 分钟}）。"""
    carpool.report("测算各站顺不顺路", 0, len(stations))
    names = [st.name for st in stations]
    detours: dict[tuple, float | None] = {}
    if not back_only:
        # 到目的地车程：一次查完；车主到各站：每站一次（批量预取）
        to_venue = dict(zip(names + [f"car:{d.name}" for d in drivers], amap.drive_minutes(stations + [d.home for d in drivers], venue)))
        carpool.prefetch(amap, lambda: [amap.distance_query([d.home for d in drivers], st) for st in stations] if drivers else [])
        for i, st in enumerate(stations):
            carpool.report("测算各站顺不顺路", i, len(stations))
            if not drivers:
                continue
            for d, m in zip(drivers, amap.drive_minutes([d.home for d in drivers], st)):
                direct = to_venue.get(f"car:{d.name}")
                ok = not (m is None or direct is None or to_venue.get(st.name) is None)
                detours[(d.name, st.name)] = max(0.0, m + to_venue[st.name] - direct) if ok else None
        return {n: to_venue.get(n) for n in names}, detours
    carpool.prefetch(amap, lambda: [*(amap.distance_query([venue], st) for st in stations), *(amap.distance_query([venue], d.home) for d in drivers),
                                    *(amap.distance_query(stations, d.home) for d in drivers if len(stations) <= 100)])
    from_venue = {st.name: amap.drive_minutes([venue], st)[0] for st in stations}
    direct = {d.name: amap.drive_minutes([venue], d.home)[0] for d in drivers}
    for d in drivers:
        for st, m in zip(stations, amap.drive_minutes(stations, d.home)):
            back = direct.get(d.name)
            ok = not (m is None or back is None or from_venue.get(st.name) is None)
            detours[(d.name, st.name)] = max(0.0, from_venue[st.name] + m - back) if ok else None
    return from_venue, detours


def _row(st, where, minutes, drivers, detours, limit_of, rider_homes) -> dict:
    items = []
    for d in drivers:
        m = detours.get((d.name, st.name))
        m = None if m is None else round(m)
        items.append({"driver": d.name, "minutes": m, "limit": round(limit_of(d)), "over": m is not None and m > round(limit_of(d))})
    known = [i for i in items if i["minutes"] is not None]
    best = min(known, key=lambda i: i["minutes"], default=None)
    return {"name": st.name, "location": st.loc, "city": st.city, "where": where,
            "to_venue": None if minutes is None else round(minutes),
            "best": None if best is None else {"driver": best["driver"], "detour": best["minutes"]},
            "detours": items, "over_all": bool(known) and all(i["over"] for i in known), "checked": False,
            "rider_km": min((carpool.km_between(st, h) for h in rider_homes), default=None)}


def _sort_key(sort: str):
    inf = math.inf
    best = lambda r: (r["best"] or {}).get("detour", inf)
    dest = lambda r: r["to_venue"] if r["to_venue"] is not None else inf
    rider = lambda r: r["rider_km"] if r["rider_km"] is not None else inf
    # 所有车主都超过上限的站，不论怎么排都在可用的站后面
    return {"detour": lambda r: (r["over_all"], best(r), dest(r)),
            "dest": lambda r: (r["over_all"], dest(r), best(r)),
            "rider_home": lambda r: (r["over_all"], rider(r), best(r), dest(r))}[sort]


def suggest_stations(cfg: dict, amap, valid_names: set[str] | None = None, plan_only: bool = False) -> dict:
    """推荐候选车站。在 options.suggest 设定的范围里找（目的地周边、车主和乘客出发地附近、车主路上），
    用 12306 站名过滤，按设定排序；每个站带每位车主各自的绕路分钟数。去掉的站留痕，搜索圈和路线也返回给界面画出来。
    plan_only：只查车主路线、算出全部搜索圈和估算，不做地点搜索。"""
    resolved: list[dict] = []
    venue, people = carpool.load_places(cfg, amap, resolved)
    opt = cfg.get("options") or {}
    st, notes = normalize_settings(opt.get("suggest"))
    areas = st["areas"]
    existing = {s.get("name") for s in cfg.get("stations") or []}
    back_only = opt.get("outbound") is False  # 只规划返程：顺路是指「目的地 → 站 → 车主家」
    drives = (lambda p: p.drives and p.back_drives) if back_only else (lambda p: p.drives)
    limit_of = (lambda p: p.back_max_detour if p.back_max_detour is not None else p.max_detour) if back_only else (lambda p: p.max_detour)
    all_drivers = [p for p in people if drives(p)]
    drivers = [d for d in all_drivers if not st["drivers"] or d.name in st["drivers"]]
    if unknown := [n for n in st["drivers"] if n not in {d.name for d in all_drivers}]:
        notes.append(f"「用哪几位车主的路线」里的 {'、'.join(unknown)} 不是车主，已忽略")
    riders = [p for p in people if not drives(p)]
    if st["sort"] == "rider_home" and not riders:
        notes.append("没有不开车的成员，「离乘客家最近」没有意义，改按车主最少绕路排序")
        st["sort"] = "detour"
    if not drivers:
        notes.append("没有车主，无法判断绕路" + ("，改按到目的地的车程排序" if st["sort"] == "detour" else ""))
        st["sort"] = "dest" if st["sort"] == "detour" else st["sort"]
    if not st["filter_12306"]:
        notes.append("已关闭 12306 站名表过滤，结果里可能有货运站")
    elif valid_names is None:
        notes.append("没有拿到 12306 站名表，没有按它过滤")

    circles: list[dict] = []
    absorbed: list[dict] = []

    def add(p, radius, where, kind):
        if any(carpool.km_between(p, _place(c["lat"], c["lng"])) + radius <= c["radius_km"] for c in circles):
            absorbed.append({"lat": p.lat, "lng": p.lng, "radius_km": radius, "where": where, "kind": kind, "searched": True})
            return  # 被已有的圈完全包住，不用再搜（只记下来，给目的地圈搜到的站归属用）
        circles.append({"lat": p.lat, "lng": p.lng, "radius_km": round(radius, 3), "where": where, "kind": kind})

    if "dest" in areas:
        for p, r in dest_circles(venue, st["dest_radius_km"]):
            add(p, r, "目的地周边" if circles else "目的地附近", "dest")
        if st["dest_radius_km"] > SEARCH_MAX_KM:
            notes.append(f"目的地周边 {st['dest_radius_km']:g} 公里超过高德单次搜索的 50 公里，用 {len(circles)} 个 50 公里的圈铺满")
    if "owner_home" in areas:
        for d in drivers:
            add(d.home, st["home_radius_km"], f"{d.name}出发地附近", "home")

    # 车主路线：只有要沿路找时才查
    routes: list[dict] = []
    skipped: list[dict] = []
    corridor = None
    ways = (lambda d: [venue, d.home]) if back_only else (lambda d: [d.home, venue])
    if "owner_route" in areas and drivers:
        carpool.report("获取车主路线")
        along = st["route_cover"] == "along"
        alt = st["alt_routes"] and along
        strategy = carpool.route_strategy(st["route_strategy"], alt)
        carpool.prefetch(amap, lambda: [amap.driving_query(ways(d), strategy) for d in drivers])
        for d in drivers:
            try:
                got = amap.drive_routes(ways(d), st["route_strategy"], alt)
            except carpool.QuotaError:
                raise  # 配额用完要停下提示，不能悄悄跳过
            except (carpool.AmapError, KeyError, IndexError):
                got = []
            if not got:
                skipped.append({"driver": d.name, "reason": "车主路线查不到，没有沿这位车主的路线找站"})
                continue
            for k, route in enumerate(got, 1):
                routes.append({"driver": d.name, "path": route["path"], "alt": k, "km": round(route["km"], 1),
                               "minutes": None if route.get("minutes") is None else round(route["minutes"], 1)})
            if along:
                r, corridor = route_radius(st["route_step_km"], st["route_radius_km"])
                mine: list[carpool.Place] = []
                for k, route in enumerate(got, 1):
                    for p in route_samples(route["path"], st["route_step_km"]):
                        if not any(carpool.km_between(p, q) < NEAR_KM for q in mine):
                            mine.append(p)
                            add(p, r, f"{d.name}路上" if k == 1 else f"{d.name}路上（备选路线{k}）", "route")
            else:
                if got[0].get("minutes") is None:
                    notes.append(f"{d.name}的路线没有用时，绕路范围按路程估算，可能不全")
                for p in detour_circles(d.home, venue, got[0]["km"], limit_of(d), got[0].get("minutes")):
                    add(p, SEARCH_MAX_KM, f"{d.name}绕路范围内", "detour")
        if corridor is not None:
            notes.append(f"沿路搜索保证路线两侧至少 {math.floor(corridor)} 公里内没有遗漏")
    if "rider_home" in areas:
        for p in riders:
            add(p.home, st["home_radius_km"], f"{p.name}出发地附近", "rider")

    cap = st["max_searches"]
    n = len(circles)
    estimate = {"circles": n, "searches_min": n, "searches_max": n * PAGES, "routes": len(drivers) if "owner_route" in areas else 0,
                "matrix": 1 + min(3 * n, 100), "over_cap": n > cap, "may_exceed": n * PAGES > cap}
    trace = {"routes": routes, "circles": circles, "corridor_km": None if corridor is None else round(corridor, 1)}
    summary = {"circles": n, "searches": 0, "found": 0, "dropped": {}, "truncated": [], "cap_hit": False,
               "skipped_drivers": skipped, "unsearched": [], "more": {}}
    out = {"stations": [], "more": [], "dropped": [], "summary": summary, "trace": trace, "estimate": estimate,
           "settings": st, "notes": notes, "resolved": resolved}
    if estimate["over_cap"]:
        notes.append(f"这次至少要 {n} 次地点搜索，超过单次上限 {cap} 次；把范围调小，或者调高上限")
    if plan_only:
        return out

    # 地点搜索：先批量取每个圈的第一页，满页的再批量取下一页
    pois_by: list[list[dict]] = [[] for _ in circles]
    truncated: list[str] = []
    pending, page, searches = list(range(n)), 1, 0
    carpool.report("搜索附近的火车站", 0, n)
    while pending and page <= PAGES:
        batch, cut = pending[:max(0, cap - searches)], pending[max(0, cap - searches):]
        carpool.prefetch(amap, lambda: [amap.around_query(_place(circles[i]["lat"], circles[i]["lng"]), circles[i]["radius_km"], page) for i in batch])
        full = []
        for i in batch:
            carpool.report("搜索附近的火车站", searches, n)
            c = circles[i]
            pois = amap.stations_around(_place(c["lat"], c["lng"]), c["radius_km"], page)
            searches += 1
            c["searched"] = True
            pois_by[i] += pois
            if len(pois) >= carpool.PAGE_SIZE:
                full.append(i)
        if cut:
            summary["cap_hit"] = True
            if page == 1:
                summary["unsearched"] += [circles[i]["where"] for i in cut]
            else:
                truncated += [circles[i]["where"] for i in cut]  # 本该翻页却没搜
        if page == PAGES:
            truncated += [circles[i]["where"] for i in full]
        pending, page = full, page + 1
    for c in circles:
        c.setdefault("searched", False)
    summary["searches"] = searches
    summary["truncated"] = list(dict.fromkeys(truncated))
    summary["unsearched"] = list(dict.fromkeys(summary["unsearched"]))
    if summary["cap_hit"]:
        notes.append(f"搜索到单次上限 {cap} 次就停了，结果可能不全")
    if summary["truncated"]:
        notes.append(f"这些圈翻到第 {PAGES} 页还是满的，可能没列全：{'、'.join(summary['truncated'])}")

    # 过滤，留痕
    found: dict[str, tuple[carpool.Place, str]] = {}
    dropped: dict[str, dict] = {}

    def drop(name, reason, where):
        dropped.setdefault(name, {"name": name, "reason": reason, "where": where})

    for d in skipped:
        drop(d["driver"], d["reason"], "车主路线")
    for c, pois in zip(circles, pois_by):
        ok = []
        for poi in pois:
            if not poi.get("name"):
                continue
            if reason := carpool.reject_reason(poi):
                drop(poi["name"], reason, c["where"])
            else:
                ok.append(poi)
        for place in carpool.pick_stations(ok, _place(c["lat"], c["lng"]), c["radius_km"], len(ok)):
            where = c["where"]
            if c["kind"] == "dest" and carpool.km_between(place, venue) > st["dest_radius_km"]:
                # 网格的圈会伸到设定范围之外：只有同时落在别的圈里（比如车主路上）才留下
                other = next((o for o in [*circles, *absorbed] if o["kind"] != "dest" and o["searched"]
                              and carpool.km_between(place, _place(o["lat"], o["lng"])) <= o["radius_km"]), None)
                if other is None:
                    continue
                where = other["where"]
            if place.name in found:
                continue
            if place.name in existing:
                drop(place.name, "已经在候选站里", where)
            elif st["filter_12306"] and valid_names is not None and place.name.removesuffix("站") not in valid_names:
                drop(place.name, "12306 站名表里没有（多半是货运站或线路所，也可能是新站）", where)
            else:
                found[place.name] = (place, where)
    out["dropped"] = list(dropped.values())
    summary["dropped"] = dict(Counter(x["reason"].split("，")[0].split("（")[0] for x in dropped.values()))
    summary["found"] = len(found)

    if found:
        stations = [p for p, _ in found.values()]
        minutes, detours = _detour_table(amap, venue, drivers, stations, back_only)
        rider_homes = [p.home for p in riders] if "rider_home" in areas else []
        rows = [_row(p, where, minutes.get(p.name), drivers, detours, limit_of, rider_homes) for p, where in found.values()]
        rows.sort(key=_sort_key(st["sort"]))
        more = []
        if st["over_limit"] == "hide":
            more = [{**r, "reason": "所有车主绕路都超过各自的上限（设置为不显示）"} for r in rows if r["over_all"]]
            rows = [r for r in rows if not r["over_all"]]
        more += [{**r, "reason": f"超过显示个数（最多显示 {st['show_count']} 个）"} for r in rows[st["show_count"]:]]
        rows = rows[:st["show_count"]]
        for r in [r for r in rows if not r["over_all"]][:st["checked_count"]]:
            r["checked"] = True
        out["stations"], out["more"] = rows, more
        summary["more"] = dict(Counter(r["reason"].split("（")[0] for r in more))
    return out
