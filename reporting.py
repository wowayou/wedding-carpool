# SPDX-License-Identifier: AGPL-3.0-or-later
"""报告：把求解结果和行程表写成 Markdown 文字（方案页、界面数据在 share.py、service.py）。"""

from __future__ import annotations

import urllib.parse

from base import INF, RULES_VERSION
from geo import Place
from model import OUT, Leg, Trip, clock
from routes import Plan, Route, leg_minutes
from timetable import Timeline, Timelines


def fmt_min(m: float) -> str:
    if m == INF:
        return "无法到达"
    m = round(m)
    return f"{m // 60}小时{m % 60:02d}分" if m >= 60 else f"{m}分钟"


def marker_url(p: Place) -> str:
    q = urllib.parse.urlencode({"position": p.loc, "name": p.name, "src": "wedding-carpool",
                                "coordinate": "gaode", "callnative": 1}, safe=",")
    return f"https://uri.amap.com/marker?{q}"


def nav_url(a: Place | None, b: Place, via: Place | None = None) -> str:
    """高德导航链接。a 为空时不写起点：手机上打开会用当前位置（方案页用它，不暴露出发地）。"""
    params = {**({"from": f"{a.loc},{a.name}"} if a else {}), "to": f"{b.loc},{b.name}"}
    if via:
        params["via"] = f"{via.loc},{via.name}"  # 高德 URI 只支持一个途经点
    params.update(mode="car", src="wedding-carpool", coordinate="gaode", callnative=1)
    return f"https://uri.amap.com/navigation?{urllib.parse.urlencode(params, safe=',')}"


def route_nav(route: Route, pts: dict[str, Place]) -> list[tuple[str, str]]:
    """车主路线的高德导航链接：最多一个途经点时一条链接走完，否则按段给。"""
    ids = [f"car:{route.driver}", *route.stops, "venue"]
    if len(ids) <= 3:
        via = pts[ids[1]] if len(ids) == 3 else None
        return [("一键导航", nav_url(pts[ids[0]], pts[ids[-1]], via))]
    return [(f"第{i}段导航", nav_url(pts[a], pts[b])) for i, (a, b) in enumerate(zip(ids, ids[1:]), 1)]


def route_links(route: Route, pts: dict[str, Place]) -> str:
    return " ".join(f"[{label}]({url})" for label, url in route_nav(route, pts))


def stop_label(stop: str, pts: dict[str, Place]) -> str:
    return pts[stop].name if stop.startswith("st:") else f"{stop[5:]}家附近"


def who(names, trip: Trip) -> str:
    """名字列表，多人同行的标上人数：小陈（3 人）。"""
    party = {p.name: p.party for p in trip.people}
    return "、".join(f"{n}（{party[n]} 人）" if party.get(n, 1) > 1 else n for n in names)


def taxi_fare(minutes: float, people: int) -> str:
    """打车费按车程粗估：平均时速约 60 公里，每公里 2–3 元；超过 4 人要两辆车或包商务车。"""
    if minutes == INF:
        return ""
    km = minutes  # 约 1 公里/分钟
    cars = (people + 3) // 4
    low, high = round(km * 2 * cars, -1), round(km * 3 * cars, -1)
    return f"，打车粗估约 {low:.0f}–{high:.0f} 元{f'（{cars} 辆车）' if cars > 1 else ''}，以实际为准"


def describe(plan: Plan, tl: Timeline, pts: dict[str, Place], trip: Trip) -> list[str]:
    """去程方案的文字说明。时刻都读行程表 tl；plan 只用来生成导航链接。"""
    seats = {p.name: p.seats for p in trip.people if p.drives}
    lines = []
    for r, car in zip(plan.routes, tl.cars):
        if not car.stops:
            lines.append(f"- **{car.driver}**（空 {seats[car.driver]} 座）：直接开到目的地，"
                         f"约 {fmt_min(car.minutes)}，不接人。")
            continue
        legs = []
        for s in car.stops:
            at = f" {clock(s.time)}" if s.time is not None else ""
            legs.append(f"{stop_label(s.point, pts)}{at}（接 {who(s.people, trip)}）")
        if car.depart is not None:
            timing = (f"建议 **{clock(car.depart)} 出发** → {' → '.join(legs)} → "
                      f"约 {clock(car.arrive)} 到目的地；")
        else:
            timing = f"出发 → {' → '.join(legs)} → 目的地；出发后约 {fmt_min(car.first_leg)} 到第一个接人点；"
        lines.append(f"- **{car.driver}**（空 {seats[car.driver]} 座）：{timing}"
                     f"全程约 {fmt_min(car.minutes)}，比直达多绕 **{fmt_min(car.detour)}**。{route_links(r, pts)}")
    for car in tl.taxis:
        s, ride, ready = car.stop, car.ride, car.time
        timing = (f"约 {clock(ready)} 在站汇合，{clock(ready + ride)} 左右到目的地" if ready is not None else f"车程约 {fmt_min(ride)}")
        if car.unknown and ready is not None:
            timing += f"（{who(car.unknown, trip)}没填车次，按同一时间算）"
        lines.append(f"- **打车/包车组**：{who(car.names, trip)} 坐高铁到 **{pts[s].name}**，"
                     f"一起打车到目的地，{timing}{taxi_fare(ride, car.n)}。[导航]({nav_url(pts[s], pts['venue'])})")
    for st in tl.stranded:
        lines.append(f"- **{st.name}**：没有可用的候选站，需要单独安排。")
    return lines


def describe_back(tl: Timeline, pts: dict[str, Place], trip: Trip) -> list[str]:
    """返程（插件）：车主几点从目的地出发、几点送到哪、几点到家；乘客等多久；打车组几点出发赶哪趟车。时刻都读行程表 tl。"""
    seats = {p.name: p.seats for p in trip.people if p.drives}
    riders = {rd.name: rd for rd in tl.riders}
    lines = []
    for car in tl.cars:
        if not car.stops:
            lines.append(f"- **{car.driver}**：{clock(car.depart)} 从目的地直接回家，约 {fmt_min(car.minutes)}，不送人。")
            continue
        legs = []
        for s in car.stops:
            trains = [riders[n].train for n in s.people if s.point.startswith("st:")]
            catch = f"，赶 {'、'.join(t for t in trains if t)}" if any(trains) else ""
            waits = "".join(f"，{n}等 {fmt_min(riders[n].wait)}" for n in s.people if riders[n].wait >= 1)
            legs.append(f"{stop_label(s.point, pts)} {clock(s.time)}（送 {who(s.people, trip)}{catch}{waits}）")
        lines.append(f"- **{car.driver}**（空 {seats[car.driver]} 座）：{clock(car.depart)} 从目的地出发 → {' → '.join(legs)} → "
                     f"约 {clock(car.arrive)} 到家；全程约 {fmt_min(car.minutes)}，比直达多绕 **{fmt_min(car.detour)}**。")
    for car in tl.taxis:
        s, ride, t = car.stop, car.ride, car.time
        trains = [m.train for m in car.members]
        catch = f"，赶 {'、'.join(x for x in trains if x)}" if any(trains) else ""
        waits = "".join(f"，{m.name}等 {fmt_min(m.wait)}" for m in car.members if m.wait >= 1)
        lines.append(f"- **打车组**：{who(car.names, trip)} {clock(t)} 从目的地一起打车去 **{pts[s].name}**，"
                     f"约 {clock(t + ride)} 到{catch}{waits}{taxi_fare(ride, car.n)}。")
    for st in tl.stranded:
        lines.append(f"- **{st.name}**：按 {clock(st.leave)} 离场，赶不上任何一个候选站的车次，需要单独安排（提前离场或改签）。")
    return lines


def cost_parts(plan: Plan) -> tuple[int, int, int, int]:
    """(总分钟, 车主多绕, 乘客到上车点, 打车组)：分项先四舍五入，总分钟取三项之和，显示的算式才对得上。"""
    d, r, t = round(plan.detour), round(plan.rider_min), round(plan.taxi_min)
    return d + r + t, d, r, t


COST_NAMES = ("车主多绕", "乘客到上车点", "打车组")


def rank_basis(plan: Plan, best: Plan | None = None) -> list[str]:
    """每个方案下面的「排序依据」；备选方案再加一行和推荐方案的差别。"""
    total, *parts = cost_parts(plan)
    terms = " + ".join(f"{n} {v}" for n, v in zip(COST_NAMES, parts))
    lines = [f"排序依据：{plan.carried} 人搭车；总分钟 {total} = {terms}"]
    if plan.taxi_cars:  # 打车费只用来选站，不参与方案之间的排序
        lines.append(f"打车：{plan.taxi_cars} 辆，粗估 {round(plan.taxi_ride * 2, -1):.0f}–{round(plan.taxi_ride * 3, -1):.0f} 元")
    if best is None or best is plan:
        return lines
    if plan.carried != best.carried:
        diff = best.carried - plan.carried
        lines.append(f"和推荐方案比：{'少' if diff > 0 else '多'} {abs(diff)} 人搭车")
        return lines
    best_total, *best_parts = cost_parts(best)
    delta = total - best_total
    changes = [f"{n} {'+' if v - b > 0 else '−'}{abs(v - b)}" for n, v, b in zip(COST_NAMES, parts, best_parts) if v != b]
    stops, best_stops = (sum(len(r.stops) for r in x.routes) for x in (plan, best))
    head = f"总分钟{'多' if delta > 0 else '少'} {abs(delta)}" if delta else "总分钟相同"
    if not delta and not changes and stops != best_stops:
        head += f"，停车{'多' if stops > best_stops else '少'} {abs(stops - best_stops)} 次"
    lines.append(f"和推荐方案比：{head}" + (f"（{'，'.join(changes)}）" if changes else ""))
    return lines


def paragraphs(lines: list[str]) -> list[str]:
    """每行各成一段（Markdown 里相邻的行会并成一段）。"""
    return [x for line in lines for x in (line, "")]


def station_table(trip: Trip, pts: dict[str, Place], T, leg: Leg = OUT) -> list[str]:
    """每个车主「只在这个站停一次」时的绕路。去程：车主家 → 站 → 目的地；返程：目的地 → 站 → 车主家。"""
    drivers = [p for p in trip.people if p.drives]
    rows = []
    for s in trip.stations:
        sid = f"st:{s.name}"
        cells, ok = [], []
        for d in drivers:
            start, end = leg.ends(d.name)
            detour = leg_minutes(T, [start, sid, end]) - T.get((start, end), INF)
            limit = d.back_max_detour if leg.reverse and d.back_max_detour is not None else d.max_detour
            fits = detour <= limit and (not leg.reverse or d.back_drives)
            cells.append(("✅ " if fits else "") + fmt_min(max(detour, 0.0)))
            if fits:
                ok.append(detour)
        ride = leg.station_to_venue(T, sid)
        rows.append(((-len(ok), min(ok, default=INF), ride), [s.name, fmt_min(ride), *cells]))
    rows.sort(key=lambda r: r[0])
    head = ["候选站", "目的地→站车程" if leg.reverse else "站→目的地车程", *[f"{d.name}绕路" for d in drivers]]
    out = ["| " + " | ".join(head) + " |", "|" + "---|" * len(head)]
    out += ["| " + " | ".join(cells) + " |" for _, cells in rows]
    return out


def rail_section(trip: Trip) -> list[str]:
    lines = []
    for p in trip.people:
        if p.drives:
            continue
        if p.rail_min:
            items = [(m, s, p.trains.get(s) or "手填") for s, m in p.rail_min.items()]
        else:
            items = [(m, s, desc) for s, (m, desc) in p.rail_est.items()]
        if items:
            lines.append(f"- **{p.name}**：" + "；".join(
                f"{s} {fmt_min(m)}（{desc}）" for m, s, desc in sorted(items)))
    if not lines:
        return []
    return ["## 不开车的人到各站要多久", "",
            "括号里是配置里填的车次（标「手填」的只填了分钟数）。试玩里的车次和时刻都是示意，不是真实车次。"
            if trip.try_mode else
            "括号里是配置里填的车次（标「手填」的只填了分钟数）；其余按 "
            f"{trip.travel_date} {trip.travel_time} 出发，用高德公共交通最快方案估算。"
            "高德跨城只给直达火车，不含火车换乘和刚开通的线路，估算可能偏差很大，请用 12306 核对。",
            "", *lines, ""]


def render(trip: Trip, pts: dict[str, Place], T, plans: list[Plan], tls: Timelines) -> str:
    """tls：这次计算的行程表（carpool.timelines），报告里的时刻都从它读。"""
    L = [f"# 拼车方案：{trip.venue.name}" if trip.outbound else f"# 返程方案：{trip.venue.name}", ""]
    if trip.warnings:
        L += ["> ⚠️ " + w for w in trip.warnings] + [""]
    if not trip.outbound:
        pass  # 只规划返程：下面直接从返程开始
    elif not plans:
        L += ["没有找到可行方案。", ""]
    else:
        best = plans[0]
        used = {s for r in best.routes for s in r.stops if s.startswith("st:")} | set(best.taxi.values())
        riders = [p for p in trip.people if not p.drives]
        total = sum(p.party for p in riders)
        L += ["## 结论", "",
              f"- 不开车的 {total} 人里，**{best.carried} 人能搭上顺风车**，"
              f"车主合计多绕 {fmt_min(best.detour)}。",
              f"- 建议坐到的站：**{'、'.join(pts[s].name for s in sorted(used)) or '不需要坐到站'}**。",
              "", "## 推荐方案", "", *describe(best, tls.out[0], pts, trip), "",
              *paragraphs(rank_basis(best))]
        for i, pl in enumerate(plans[1:], 2):
            L += [f"## 备选方案 {i}（{pl.carried} 人搭车，车主合计多绕 {fmt_min(pl.detour)}）", "",
                  *describe(pl, tls.out[i - 1], pts, trip), "", *paragraphs(rank_basis(pl, best))]
    if trip.back:
        L += [f"## 返程（{clock(trip.back.depart)} 散场后出发，发车前 {trip.back.margin:.0f} 分钟到站）", ""]
        if not trip.back_plans:
            L += ["没有找到可行的返程方案。", ""]
        for i, pl in enumerate(trip.back_plans, 1):
            L += [f"### 返程方案 {i}（{pl.carried} 人搭车，车主合计多绕 {fmt_min(pl.detour)}）", "",
                  *describe_back(tls.back[i - 1], pts, trip), "", *paragraphs(rank_basis(pl, trip.back_plans[0]))]
    if trip.outbound:
        L += ["## 候选站对比", "",
              "每个车主「只在这个站停一次」时比直达多绕多久；✅ 表示在他能接受的绕路范围内。", "",
              *station_table(trip, pts, T), "", *rail_section(trip)]
    else:
        L += ["## 候选站对比", "",
              "每个车主「只在这个站送一次」时比直接回家多绕多久；✅ 表示在他能接受的绕路范围内。", "",
              *station_table(trip, pts, T, trip.back), ""]
    if trip.discovered:
        L += ["> 候选站是自动搜出来的（含普速站）。确认后把需要的站写进配置的 `[[stations]]`，"
              "可以去掉没有高铁的站、补上漏掉的站。", ""]
    L += ["## 地点核对与高德链接", "", "先确认「解析结果」对得上，链接可直接发群里，手机点开会跳到高德。", "",
          "| 地点 | 解析结果 | 链接 |", "|---|---|---|"]
    L += [f"| {p.name} | {p.note} | [打开]({marker_url(p)}) |" for p in pts.values()]
    L += ["", "## 说明", ""]
    if trip.try_mode:
        L += ["- 试玩模式：地点和车次都是虚构的示意；行车时间按直线距离估算（直线公里数 × 1.3 ÷ 75 公里/小时，再加 10 分钟进出城），不是真实路况。"]
    else:
        L += ["- 时间来自高德驾车测距，接近查询时的路况，当天可能有出入；车次和到站时间请在 12306 核对。"]
    if trip.outbound:
        L += ["- 不开车的人到各站的用时：用配置里填的车次和分钟数；没填的按默认每站 "
              f"{trip.station_cost:.0f} 分钟算。"] if trip.try_mode else [
              "- 不开车的人到各站的用时：优先用配置里手填的 `rail_min`，否则用高德公共交通估算；"
              "估算不准或想排除某些站时，给他填 `stations` 或 `rail_min`。"]
    else:
        L += ["- 乘客从各站坐的车：用配置里填的回程车次（`return_trains`）；没填的人不限制赶车，到站用时按默认每站 "
              f"{trip.station_cost:.0f} 分钟算。"]
    L += [f"- 方案按计算规则第 {RULES_VERSION} 版排序，规则和默认值见 https://carpool.eigentime.org/guide/method"]
    if trip.outbound:
        L += ["- 高铁站一般要到停车场或网约车上车点接人，约定时说到具体停车场和区域。"]
    return "\n".join(L) + "\n"
