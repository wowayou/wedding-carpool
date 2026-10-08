# SPDX-License-Identifier: AGPL-3.0-or-later
"""方案页：把选定的拼车方案排成每个人的时间线，生成可以直接发给同行的人的独立 HTML。

页面不依赖本地服务：文字内容是服务端写好的，没网也能看；地图（Leaflet + 高德瓦片）有网时才显示。
不开车的人的家庭位置不放进页面，只放车主出发地、用到的车站和目的地。
"""

from __future__ import annotations

import datetime as dt
import json
import re
from html import escape

import carpool

WEEKDAYS = "一二三四五六日"
BEIJING = dt.timezone(dt.timedelta(hours=8))  # 生成时间统一按北京时间，不依赖运行环境的时区
BLUR_START_KM = 2.0  # 方案页上，车主路线从出发地多远开始画
BLUR_HOME_KM = 1.5   # 「到家附近接」的点前后多远不画
COLORS = ["#c2410c", "#1d4ed8", "#7c3aed", "#0f766e", "#be185d", "#4d7c0f"]

# 设计变量：和 web/design.css 一致（test_carpool.py 解析 design.css 逐个比对）。
# 方案页在 CSP 沙箱里展示，不能引用 /design.css，所以把颜色变量内嵌在页面里。改颜色先改 design.css，再同步这里。
LIGHT = {
    "--bg": "#f7f4ee", "--surface": "#ffffff", "--surface-2": "#f1ebe1", "--line": "#e5ddd0", "--line-strong": "#cfc4b3",
    "--ink": "#221e1a", "--ink-2": "#5a5148", "--ink-3": "#857b70",
    "--accent": "#b4442c", "--accent-hover": "#9a3722", "--accent-soft": "#f7e8e2", "--on-accent": "#ffffff",
    "--drive": "#15803d", "--ride": "#c2620a", "--taxi": "#6b7280", "--dest": "#dc2626", "--station": "#2563eb",
    "--ok": "#15803d", "--ok-soft": "#ebf6ee", "--warn": "#b45309", "--warn-soft": "#fdf2e1",
    "--danger": "#b91c1c", "--danger-soft": "#fde9e7", "--info": "#1d4ed8", "--info-soft": "#e9effc",
    "--map-filter": "none",
}
DARK = {
    "--bg": "#161412", "--surface": "#1f1c19", "--surface-2": "#28241f", "--line": "#35302a", "--line-strong": "#4a443c",
    "--ink": "#efe9e1", "--ink-2": "#bdb4a8", "--ink-3": "#8f867b",
    "--accent": "#e47a5f", "--accent-hover": "#f08e74", "--accent-soft": "#3b241d", "--on-accent": "#1a0f0b",
    "--drive": "#4ade80", "--ride": "#f59e0b", "--taxi": "#9ca3af", "--dest": "#f87171", "--station": "#60a5fa",
    "--ok": "#4ade80", "--ok-soft": "#13291b", "--warn": "#fbbf24", "--warn-soft": "#33270f",
    "--danger": "#f87171", "--danger-soft": "#3a1715", "--info": "#93c5fd", "--info-soft": "#16213a",
    "--map-filter": "brightness(.82) contrast(1.05)",
}


# 页面图标内嵌成 data: 地址（和 web/favicon.svg 同款）：沙箱的内容安全策略只放行 data:、cdnjs 和高德瓦片，不能引用站点上的图片
ICON = ("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%23b4442c'/%3E"
        "%3Cg fill='none' stroke='%23fff' stroke-width='5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M12 15C28 15 28 32 42 32'/%3E"
        "%3Cpath d='M12 49C28 49 28 32 42 32'/%3E%3C/g%3E%3Ccircle cx='47' cy='32' r='9' fill='%23fff'/%3E%3Ccircle cx='47' cy='32' r='3.6' fill='%23b4442c'/%3E%3C/svg%3E")


def _css_vars(values: dict[str, str]) -> str:
    return " ".join(f"{k}: {v};" for k, v in values.items())


def _fill(template: str, values: dict[str, str]) -> str:
    """把模板里的 @@名字@@ 换成内容。一次扫描替换，内容里即使出现 @@x@@ 也不会被再次替换。"""
    return re.sub(r"@@(\w+)@@", lambda m: str(values[m.group(1)]), template)



def _date_label(travel_date: str) -> str:
    try:
        d = dt.date(*(int(x) for x in travel_date.split("-")))
    except ValueError:
        return travel_date
    return f"{d.month}月{d.day}日（周{WEEKDAYS[d.weekday()]}）"


def _blur(path: list[list[float]], homes: list[carpool.Place]) -> list[list[list[float]]]:
    """方案页的路线去掉开头一段和各个家附近的点（保护出发地和家的位置），返回若干段折线。"""
    places = [carpool.Place("", lng, lat) for lat, lng in path]
    walked, start = 0.0, len(places)
    for i in range(1, len(places)):
        walked += carpool.km_between(places[i - 1], places[i])
        if walked >= BLUR_START_KM:
            start = i
            break
    segments, current = [], []
    for point, place in zip(path[start:], places[start:]):
        if any(carpool.km_between(place, h) < BLUR_HOME_KM for h in homes):
            if len(current) > 1:
                segments.append(current)
            current = []
        else:
            current.append(point)
    if len(current) > 1:
        segments.append(current)
    return segments


def _share_nav(route: carpool.Route, pts: dict) -> list[tuple[str, str]]:
    """方案页的导航链接：不写起点（手机上用当前位置），途经点只放车站，不放成员的家。"""
    stops = [pts[s] for s in route.stops if s.startswith("st:")]
    venue = pts["venue"]
    if len(stops) <= 1:
        return [("一键导航", carpool.nav_url(None, venue, stops[0] if stops else None))]
    legs = [(None, stops[0]), *zip(stops, stops[1:]), (stops[-1], venue)]
    return [(f"导航到{b.name}", carpool.nav_url(a, b)) for a, b in legs]


def _step(time: str, text: str, link: tuple[str, str] | None = None) -> str:
    a = f' <a href="{escape(link[1])}" target="_blank" rel="noopener">{escape(link[0])}</a>' if link else ""
    return f'<li><span class="t">{escape(time) or "·"}</span><span>{text}{a}</span></li>'


def _card(kind: str, title: str, tag: str, steps: list[str], extra: str = "") -> str:
    tag_html = f'<span class="tag">{escape(tag)}</span>' if tag else ""
    return (f'<article class="card {kind}"><h3>{escape(title)}{tag_html}</h3>'
            f'<ol class="line">{"".join(steps)}</ol>{extra}</article>')


def _return_section(state: dict, index: int) -> str:
    """返程插件在方案页上的一段：每个人几点从目的地出发、送到哪、赶哪趟车。不写起点、不指向任何人的家。"""
    trip, pts, T = state["trip"], state["pts"], state["T"]
    if not trip.back or not trip.back_plans:
        return ""
    leg = trip.back
    plan = trip.back_plans[min(index, len(trip.back_plans) - 1)]
    people = {p.name: p for p in trip.people}
    clock = carpool.clock
    depart = clock(leg.depart)
    station_link = lambda s: ("车站地图", carpool.marker_url(pts[s])) if s.startswith("st:") else None  # noqa: E731
    cards = []
    for r in plan.routes:
        if not r.stops:
            cards.append(_card("driver", r.driver, "返程", [_step(depart, "从目的地直接回家，这次不用送人")]))
            continue
        times = carpool.stop_times(r, T, leg)
        steps = [_step(depart, "从目的地出发")]
        for s in r.stops:
            names = carpool.who([n for n, (d, st) in plan.rides.items() if d == r.driver and st == s], trip)
            place = escape(carpool.stop_label(s, pts)) + ("，具体地点在群里约" if not s.startswith("st:") else "")
            steps.append(_step(clock(times[s]), f"到 <b>{place}</b>，送 {escape(names)}", station_link(s)))
        steps.append(_step(clock(times[f"car:{r.driver}"]), "到家"))
        stations = [pts[s] for s in r.stops if s.startswith("st:")]
        navs = " ".join(f'<a class="btn" href="{escape(carpool.nav_url(a, b))}" target="_blank" rel="noopener">导航到{escape(b.name)}</a>'
                        for a, b in zip([None, *stations], stations))
        cards.append(_card("driver", r.driver, "返程", steps,
                           f'<p class="meta">比直接回家多绕 {carpool.fmt_min(r.detour)}</p><div class="navs">{navs}</div>'))
    for name, (driver, stop) in plan.rides.items():
        p = people[name]
        times = carpool.stop_times(next(r for r in plan.routes if r.driver == driver), T, leg)
        if stop.startswith("st:"):
            train = p.back_trains.get(pts[stop].name, "")
            first = carpool.train_times(train)
            steps = [_step(depart, f"上 <b>{escape(driver)}</b> 的车"),
                     _step(clock(times[stop]), f"到 <b>{escape(pts[stop].name)}</b>", station_link(stop)),
                     _step(clock(first[0]) if first else "", f"坐 <b>{escape(train)}</b>" if train else "坐车回家")]
        else:
            steps = [_step(depart, f"上 <b>{escape(driver)}</b> 的车"), _step(clock(times[stop]), "顺路送到家附近")]
        cards.append(_card("rider", name, f"搭 {driver} 的车", steps))
    for name, stop in plan.taxi.items():
        p = people[name]
        train = p.back_trains.get(pts[stop].name, "")
        first = carpool.train_times(train)
        others = [n for n, s in plan.taxi.items() if s == stop and n != name]
        ride = T.get(("venue", stop), carpool.INF)
        steps = [_step(depart, f"{('和 ' + escape('、'.join(others)) + ' ') if others else ''}从目的地打车去 <b>{escape(pts[stop].name)}</b>（约 {carpool.fmt_min(ride)}）",
                       station_link(stop)),
                 _step(clock(first[0]) if first else "", f"坐 <b>{escape(train)}</b>" if train else "坐车回家")]
        cards.append(_card("taxi", name, "打车", steps))
    for name in plan.stranded:
        cards.append(_card("taxi", name, "待安排", [_step(depart, "按这个散场时间赶不上候选站的车次，需要单独商量（提前离场或改签）")]))
    return f'<h2>返程 · {depart} 散场后出发</h2>{"".join(cards)}'


def render_share(state: dict, index: int, back_index: int = 0, generated: dt.datetime | None = None,
                 expires: dt.date | None = None) -> str:
    """expires：在线版里这个行程的自动删除日期，写进页脚；本地版没有保留期，不传。"""
    trip, pts, T = state["trip"], state["pts"], state["T"]
    plan: carpool.Plan = state["plans"][index]
    people = {p.name: p for p in trip.people}
    ready = carpool.pickup_ready(plan, trip)
    taxis = carpool.taxi_schedule(plan, trip, T)
    clock = carpool.clock
    venue = pts["venue"]
    venue_link = ("目的地位置", carpool.marker_url(venue))

    def stop_link(stop: str) -> tuple[str, str] | None:
        # 车站给地图链接；成员家附近不给精确位置，具体地点在群里约
        return ("接人点地图", carpool.marker_url(pts[stop])) if stop.startswith("st:") else None

    def note(name: str) -> str:
        return f'<p class="note">{escape(people[name].note)}</p>' if people[name].note else ""

    # 车主
    drivers, schedules = [], {}
    for r in plan.routes:
        sched = schedules[r.driver] = carpool.route_schedule(r, ready, T)
        at = (lambda key: clock(sched["times"][key])) if sched else (lambda key: "")
        steps = [_step(clock(sched["depart"]) if sched else "", "从出发地出发")]
        for s in r.stops:
            who = "、".join(n for n, (d, st) in plan.rides.items() if d == r.driver and st == s)
            steps.append(_step(at(s), f"到 <b>{escape(carpool.stop_label(s, pts))}</b>，接 {escape(who)}", stop_link(s)))
        steps.append(_step(at("venue"), f"到目的地 <b>{escape(venue.name)}</b>", venue_link))
        summary = (f"全程约 {carpool.fmt_min(r.minutes)}，比直达多绕 {carpool.fmt_min(r.detour)}"
                   if r.stops else f"直达，约 {carpool.fmt_min(r.minutes)}，这次不用接人")
        navs = " ".join(f'<a class="btn" href="{escape(url)}" target="_blank" rel="noopener">{escape(label)}</a>'
                        for label, url in _share_nav(r, pts))
        tag = f"空 {people[r.driver].seats} 座" if people[r.driver].seats else ""
        drivers.append(_card("driver", r.driver, tag, steps,
                             f'<p class="meta">{summary}</p><div class="navs">{navs}</div>{note(r.driver)}'))

    # 坐车的
    riders = []
    for name, (driver, stop) in plan.rides.items():
        p, sched = people[name], schedules.get(driver)
        board = clock(sched["times"][stop]) if sched else ""
        arrive = clock(sched["times"]["venue"]) if sched else ""
        if stop.startswith("st:"):
            station = pts[stop].name
            train = p.trains.get(station, "")
            times = carpool.train_times(train)
            steps = [_step(clock(times[0]) if times else "", f"坐 <b>{escape(train)}</b>" if train else f"坐高铁到 {escape(station)}"),
                     _step(clock(times[-1]) if times else "", f"到 <b>{escape(station)}</b>，出站去停车场或网约车上车点"),
                     _step(board, f"上 <b>{escape(driver)}</b> 的车", stop_link(stop))]
        else:
            steps = [_step(board, f"<b>{escape(driver)}</b> 到家附近接，具体地点在群里约")]
        steps.append(_step(arrive, "到目的地", venue_link))
        riders.append(_card("rider", name, f"搭 {driver} 的车", steps, note(name)))
    for stop, group in taxis.items():
        station = pts[stop].name
        for name in group["names"]:
            train = people[name].trains.get(station, "")
            times = carpool.train_times(train)
            others = [n for n in group["names"] if n != name]
            meet = f"和 {escape('、'.join(others))} 汇合，" if others else ""
            steps = [_step(clock(times[0]) if times else "", f"坐 <b>{escape(train)}</b>" if train else f"坐高铁到 {escape(station)}"),
                     _step(clock(group["ready"]) if group["ready"] is not None else "",
                           f"在 <b>{escape(station)}</b> {meet}打车（约 {carpool.fmt_min(T.get((stop, 'venue'), carpool.INF))}）",
                           ("车站地图", carpool.marker_url(pts[stop]))),
                     _step(clock(group["arrive"]) if group["arrive"] is not None else "", "到目的地", venue_link)]
            riders.append(_card("taxi", name, "打车", steps, note(name)))
    for name in plan.stranded:
        riders.append(_card("taxi", name, "待安排", [_step("", "没有可用的候选站，需要单独商量")], note(name)))

    # 地图数据：目的地、用到的车站，以及模糊处理后的车主路线。车主出发地和成员的家都不放精确位置
    used = {s for r in plan.routes for s in r.stops if s.startswith("st:")} | set(plan.taxi.values())
    homes = [pts[s] for r in plan.routes for s in r.stops if s.startswith("home:")]

    def line(driver: str, stops: tuple) -> list:
        path = (state["paths"].get((driver, stops))
                or [[pts[k].lat, pts[k].lng] for k in (f"car:{driver}", *stops, "venue")])
        return _blur(path, homes)

    detours: dict[str, list[str]] = {}  # 点 → ["车1 多绕 27分钟"]
    points, routes = [], []
    for i, r in enumerate(plan.routes):
        segments = line(r.driver, r.stops)
        routes.append({"color": COLORS[i % len(COLORS)], "label": r.driver, "path": segments,
                       "direct": line(r.driver, ()) if r.stops else None})
        start = f"start:{r.driver}"
        if segments:
            lat, lng = segments[0][0]
            points.append({"key": start, "name": f"{r.driver} 出发", "lat": lat, "lng": lng, "kind": "car"})
        if r.stops:
            at = r.stops[0] if r.stops[0].startswith("st:") else start
            detours.setdefault(at, []).append(f"{r.driver} 多绕 {carpool.fmt_min(r.detour)}")
    points += [{"key": k, "name": pts[k].name, "lat": pts[k].lat, "lng": pts[k].lng,
                "kind": "venue" if k == "venue" else "st"} for k in ["venue", *sorted(used)]]
    for pt in points:
        pt["notes"] = detours.get(pt.pop("key"), [])
    map_data = {"points": points, "routes": routes,
                "taxis": [[[pts[s].lat, pts[s].lng], [venue.lat, venue.lng]] for s in taxis]}
    taxi_people = sum(people[n].party for n in plan.taxi)
    summary = (f"{plan.carried} 人搭顺风车" + (f"，车主共多绕 {carpool.fmt_min(plan.detour)}" if plan.detour >= 1 else "")
               + (f"，{taxi_people} 人打车" if plan.taxi else "") + ("，含返程" if trip.back and trip.back_plans else ""))
    stamp = (generated or dt.datetime.now(BEIJING)).strftime("%m-%d %H:%M") + "（北京时间）"
    expire_note = f"<br>这一页会在 {expires.isoformat()} 前后自动删除" if expires else ""
    return _fill(TEMPLATE, dict(
        title=escape(f"{venue.name} 出行方案"),
        eyebrow=escape(f"{_date_label(trip.travel_date)} 出发 · 方案 {index + 1}"),
        venue=escape(venue.name),
        venue_url=escape(venue_link[1]),
        summary=escape(summary),
        description=escape(f"{_date_label(trip.travel_date)} 出发 · {summary}"),
        drivers="".join(drivers),
        riders="".join(riders) or '<p class="meta">这个方案里没有需要接的人。</p>',
        back=_return_section(state, back_index),
        buffer=round(trip.exit_buffer),
        stamp=escape(stamp),
        expire_note=expire_note,
        rules_version=carpool.RULES_VERSION,
        data=json.dumps(map_data, ensure_ascii=False).replace("</", "<\\/"),
        light=_css_vars(LIGHT),
        dark=_css_vars(DARK),
        icon=ICON,
    ))


TEMPLATE = """<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>@@title@@</title>
<meta name="description" content="@@description@@">
<meta property="og:title" content="@@title@@">
<meta property="og:description" content="@@description@@">
<link rel="icon" type="image/svg+xml" href="@@icon@@">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css" integrity="sha384-c6Rcwz4e4CITMbu/NBmnNS8yN2sC3cUElMEMfP3vqqKFp7GOYaaBBCqmaWBjmkjb" crossorigin="anonymous">
<style>
  /* 设计变量和 web/design.css 一致（test_carpool.py 会逐个比对）。方案页在沙箱里展示，不能引用站点的样式文件，所以内嵌 */
  :root { color-scheme: light; @@light@@ }
  @media (prefers-color-scheme: dark) { :root:not([data-theme=light]) { color-scheme: dark; @@dark@@ } }
  :root[data-theme=dark] { color-scheme: dark; @@dark@@ }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.65 -apple-system, "PingFang SC", "HarmonyOS Sans SC", "MiSans", "Microsoft YaHei", "Noto Sans CJK SC", system-ui, sans-serif; -webkit-text-size-adjust: 100%; }
  a { color: var(--accent); text-underline-offset: 3px; }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }
  .wrap { max-width: 720px; margin: 0 auto; padding: 0 16px 40px; }
  .wrap > header { padding: 28px 0 16px; }
  .eyebrow { color: var(--accent); font-size: 13px; font-weight: 600; letter-spacing: .06em; }
  h1 { margin: 4px 0 6px; font-size: 26px; line-height: 1.3; text-wrap: balance; }
  .sum { margin: 0 0 12px; color: var(--ink-2); font-variant-numeric: tabular-nums; }
  .draft { margin: -4px 0 12px; font-size: 13px; color: var(--ink-2); }
  .legend { color: var(--ink-2); font-size: 12px; margin: 6px 2px 0; }
  #map { height: 46vh; min-height: 260px; border-radius: 12px; border: 1px solid var(--line); background: var(--surface-2); }
  .leaflet-container { background: var(--surface-2); font: inherit; }
  .leaflet-tile-pane { filter: var(--map-filter); }
  .wrap h2 { font-size: 14px; color: var(--ink-2); margin: 28px 0 10px; letter-spacing: .04em; }
  .card { background: var(--surface); border: 1px solid var(--line); border-left: 5px solid var(--drive); border-radius: 12px; padding: 14px 16px; margin-bottom: 12px; }
  .card.rider { border-left-color: var(--ride); }
  .card.taxi { border-left-color: var(--taxi); }
  .card h3 { margin: 0 0 8px; font-size: 17px; line-height: 1.4; display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
  .tag { font-size: 12px; font-weight: 500; color: var(--ink-2); background: var(--surface-2); border-radius: 999px; padding: 1px 10px; line-height: 20px; }
  .line { list-style: none; margin: 0; padding: 0; }
  .line li { display: grid; grid-template-columns: 52px 1fr; gap: 10px; padding: 6px 0; border-top: 1px dashed var(--line); }
  .line li:first-child { border-top: 0; }
  .line li .t { font-variant-numeric: tabular-nums; font-weight: 600; }
  .line a, .note a { white-space: nowrap; margin-left: 4px; }
  .meta { color: var(--ink-2); font-size: 13px; margin: 8px 0 0; }
  .navs { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
  .btn { display: inline-flex; align-items: center; min-height: 36px; padding: 0 14px; border-radius: 8px; background: var(--accent); color: var(--on-accent); text-decoration: none; font-size: 14px; font-weight: 600; border: 1px solid var(--accent); }
  .btn:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
  .btn.ghost { background: var(--surface); color: var(--accent); border-color: var(--accent); }
  .btn.ghost:hover { background: var(--accent-soft); }
  .note { margin: 8px 0 0; padding: 8px 10px; background: var(--surface-2); border-radius: 8px; font-size: 13px; color: var(--ink-2); }
  .tips { font-size: 14px; color: var(--ink-2); padding-left: 20px; }
  .wrap > footer { color: var(--ink-3); font-size: 12px; margin-top: 24px; line-height: 1.8; }
  .wrap > footer a { color: var(--ink-2); }
  .leaflet-tooltip.lbl { font-size: 12px; padding: 1px 6px; background: var(--surface); color: var(--ink); border-color: var(--line-strong); box-shadow: none; }
  .leaflet-tooltip-top.lbl::before { border-top-color: var(--surface); }
  button.btn { font: inherit; font-size: 14px; font-weight: 600; cursor: pointer; }
  /* 打印 / 存为 PDF：强制浅色，去掉按钮，地图定高，卡片不跨页；颜色之外用线型和文字区分（开车实线、坐车双线、打车点线），黑白打印也能看 */
  @media print {
    @page { size: A4; margin: 14mm 12mm; }
    :root:root:root { color-scheme: light; @@light@@ }
    html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    body { background: #fff; color: #000; font-size: 13px; line-height: 1.55; }
    .wrap { max-width: none; padding: 0; }
    .wrap > header { padding: 0 0 8px; }
    .navs, .btn, .line a, .note a { display: none !important; }
    #map { height: 330px; min-height: 0; break-inside: avoid; border-color: #888; }
    .leaflet-tile-pane { filter: none; }
    .leaflet-control-container { display: none; }
    .wrap h2 { color: #000; break-after: avoid; margin: 16px 0 8px; }
    .card { background: #fff; break-inside: avoid; border-color: #888; border-left-width: 6px; border-left-color: #000; }
    .card.rider { border-left-style: double; border-left-width: 8px; border-left-color: #000; }
    .card.taxi { border-left-style: dotted; border-left-color: #000; }
    .tag { border: 1px solid #888; background: #fff; color: #000; }
    .sum, .draft, .meta, .legend, .tips, .wrap > footer, .wrap > footer a { color: #222; }
    .note { background: #fff; border: 1px solid #aaa; color: #000; }
    .eyebrow { color: #000; }
    .line li { border-top-color: #aaa; }
  }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="eyebrow">@@eyebrow@@</div>
    <h1>去 @@venue@@</h1>
    <p class="sum">@@summary@@</p>
    <p class="draft">这是先定大方向的初步方案：心里有个底，具体在哪接、几点到，大家在群里再商量。</p>
    <div class="navs">
      <a class="btn ghost" href="@@venue_url@@" target="_blank" rel="noopener">在高德里看目的地</a>
      <button class="btn ghost" id="printBtn" type="button">打印 / 存为 PDF</button>
    </div>
  </header>
  <div id="map"></div>
  <p class="legend">彩色线：接人后的实际路线；灰色虚线：不接人时的直达路线，两条线分开的那段就是绕的路。</p>
  <h2>开车的</h2>
  @@drivers@@
  <h2>坐车的</h2>
  @@riders@@
  @@back@@
  <h2>注意</h2>
  <ul class="tips">
    <li>时刻按车次到站后 @@buffer@@ 分钟出站推算，车主时间来自高德路况估算。路线和时间都只供参考，当天以实际路况和群里的实时位置为准，开车遵守交通规则。</li>
    <li>高铁站一般不能在送客平台停车，去停车场或网约车上车点接人；到了在群里发「共享实时位置」。</li>
    <li>车次、余票以 12306 为准，提前买票。</li>
  </ul>
  <footer>生成于 @@stamp@@ · 链接会打开高德地图@@expire_note@@<br>用 <a href="https://carpool.eigentime.org/" target="_blank" rel="noopener">拼车出行规划</a> 生成，免费，也可以用它安排你们的出行 · <a href="https://carpool.eigentime.org/privacy" target="_blank" rel="noopener">费用与隐私</a><br>按公开的计算规则（第 @@rules_version@@ 版）排序：先让尽量多的人搭上车，再让总用时最少 · <a href="https://carpool.eigentime.org/guide/method" target="_blank" rel="noopener">怎么算的</a></footer>
</div>
<script id="data" type="application/json">@@data@@</script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js" integrity="sha384-NElt3Op+9NBMCYaef5HxeJmU4Xeard/Lku8ek6hoPTvYkQPh3zLIrJP7KiRocsxO" crossorigin="anonymous"></script>
<script>
document.getElementById('printBtn').addEventListener('click', function () { window.print(); });
(function () {
  if (!window.L) { document.getElementById('map').style.display = 'none'; return; }
  var data = JSON.parse(document.getElementById('data').textContent);
  // 提示框里的文字（含成员名字）一律当纯文本，不当 HTML 解析
  function text(s) { var el = document.createElement('span'); el.textContent = s; return el; }
  // 标记颜色取自页面的设计变量，深色模式下自动换成深色的值
  var css = getComputedStyle(document.documentElement);
  function v(name) { return css.getPropertyValue(name).trim(); }
  var colors = { venue: v('--dest'), st: v('--station'), car: v('--drive'), home: v('--ride') };
  var map = L.map('map', { scrollWheelZoom: false });
  L.tileLayer('https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}',
    { subdomains: '1234', maxZoom: 18, attribution: '© 高德地图' }).addTo(map);
  var bounds = [];
  data.routes.forEach(function (r) {
    (r.direct || []).forEach(function (seg) {
      L.polyline(seg, { color: v('--taxi'), weight: 4, opacity: 0.8, dashArray: '6 8' }).bindTooltip(text(r.label + ' 不接人的直达路线'), { sticky: true }).addTo(map);
      bounds = bounds.concat(seg);
    });
  });
  data.routes.forEach(function (r) {
    r.path.forEach(function (seg) {
      L.polyline(seg, { color: r.color, weight: 5, opacity: 0.85 }).bindTooltip(text(r.label), { sticky: true }).addTo(map);
      bounds = bounds.concat(seg);
    });
  });
  data.taxis.forEach(function (t) { L.polyline(t, { color: v('--taxi'), weight: 3, dashArray: '4 6' }).addTo(map); });
  // 标签互相遮挡时按优先级（目的地 > 车站 > 出发地）只留前面的，点或移到点上再显示
  var labelled = [];
  function declutter() {
    var placed = [];
    labelled.forEach(function (m) {
      var el = m.getTooltip().getElement();
      if (!el) return;
      el.style.visibility = '';
      var r = el.getBoundingClientRect();
      var hit = placed.some(function (p) { return r.left < p.right && r.right > p.left && r.top < p.bottom && r.bottom > p.top; });
      if (hit) el.style.visibility = 'hidden'; else placed.push(r);
    });
  }
  data.points.forEach(function (p) {
    var el = document.createElement('span'); el.textContent = p.name;
    p.notes.forEach(function (n) { var b = document.createElement('b'); b.textContent = n; el.appendChild(document.createElement('br')); el.appendChild(b); });
    var m = L.circleMarker([p.lat, p.lng], { radius: p.kind === 'venue' ? 9 : 7, color: '#fff', weight: 2, fillColor: colors[p.kind], fillOpacity: 1 })
      .bindTooltip(el, { permanent: true, direction: 'top', offset: [0, -6], className: 'lbl' }).addTo(map);
    m.priority = p.kind === 'venue' ? 0 : p.kind === 'st' ? 1 : 2;
    m.on('mouseover click', function () { var t = m.getTooltip().getElement(); if (t) t.style.visibility = ''; });
    m.on('mouseout', declutter);
    labelled.push(m);
    bounds.push([p.lat, p.lng]);
  });
  labelled.sort(function (a, b) { return a.priority - b.priority; });
  map.fitBounds(L.latLngBounds(bounds).pad(0.08));
  map.on('zoomend moveend resize', declutter);
  setTimeout(declutter, 0);
})();
</script>
</body>
</html>
"""
