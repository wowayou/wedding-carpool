"""方案页：把选定的拼车方案排成每个人的时间线，生成可以直接发给舍友的独立 HTML。

页面不依赖本地服务：文字内容是服务端写好的，没网也能看；地图（Leaflet + 高德瓦片）有网时才显示。
不开车的人的家庭位置不放进页面，只放车主出发地、用到的车站和场地。
"""

from __future__ import annotations

import datetime as dt
import json
from html import escape

import carpool

WEEKDAYS = "一二三四五六日"
COLORS = ["#c2410c", "#1d4ed8", "#7c3aed", "#0f766e", "#be185d", "#4d7c0f"]


def _date_label(travel_date: str) -> str:
    try:
        d = dt.date(*(int(x) for x in travel_date.split("-")))
    except ValueError:
        return travel_date
    return f"{d.month}月{d.day}日（周{WEEKDAYS[d.weekday()]}）"


def _step(time: str, text: str, link: tuple[str, str] | None = None) -> str:
    a = f' <a href="{escape(link[1])}" target="_blank" rel="noopener">{escape(link[0])}</a>' if link else ""
    return f'<li><span class="t">{escape(time) or "·"}</span><span>{text}{a}</span></li>'


def _card(kind: str, title: str, tag: str, steps: list[str], extra: str = "") -> str:
    tag_html = f'<span class="tag">{escape(tag)}</span>' if tag else ""
    return (f'<article class="card {kind}"><h3>{escape(title)}{tag_html}</h3>'
            f'<ol class="line">{"".join(steps)}</ol>{extra}</article>')


def render_share(state: dict, index: int, generated: dt.datetime | None = None) -> str:
    trip, pts, T = state["trip"], state["pts"], state["T"]
    plan: carpool.Plan = state["plans"][index]
    people = {p.name: p for p in trip.people}
    ready = carpool.pickup_ready(plan, trip)
    taxis = carpool.taxi_schedule(plan, trip, T)
    clock = carpool.clock
    venue = pts["venue"]
    venue_link = ("场地位置", carpool.marker_url(venue))

    def stop_link(stop: str) -> tuple[str, str]:
        return ("接人点地图", carpool.marker_url(pts[stop]))

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
        steps.append(_step(at("venue"), f"到场地 <b>{escape(venue.name)}</b>", venue_link))
        summary = (f"全程约 {carpool.fmt_min(r.minutes)}，比直达多绕 {carpool.fmt_min(r.detour)}"
                   if r.stops else f"直达，约 {carpool.fmt_min(r.minutes)}，这次不用接人")
        navs = " ".join(f'<a class="btn" href="{escape(url)}" target="_blank" rel="noopener">{escape(label)}</a>'
                        for label, url in carpool.route_nav(r, pts))
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
            steps = [_step(board, f"<b>{escape(driver)}</b> 到家附近接")]
        steps.append(_step(arrive, "到场地", venue_link))
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
                     _step(clock(group["arrive"]) if group["arrive"] is not None else "", "到场地", venue_link)]
            riders.append(_card("taxi", name, "打车", steps, note(name)))
    for name in plan.stranded:
        riders.append(_card("taxi", name, "待安排", [_step("", "没有可用的候选站，需要单独商量")], note(name)))

    # 地图数据：车主出发地、用到的接人点、场地
    used = {s for r in plan.routes for s in r.stops} | set(plan.taxi.values())
    keep = ["venue", *(f"car:{r.driver}" for r in plan.routes), *sorted(used)]
    def line(driver: str, stops: tuple) -> list:
        return (state["paths"].get((driver, stops))
                or [[pts[k].lat, pts[k].lng] for k in (f"car:{driver}", *stops, "venue")])

    detours: dict[str, list[str]] = {}  # 接人点 → ["车1 多绕 27分钟"]
    for r in plan.routes:
        if r.stops:
            detours.setdefault(r.stops[0], []).append(f"{r.driver} 多绕 {carpool.fmt_min(r.detour)}")
    map_data = {
        "points": [{"name": pts[k].name, "lat": pts[k].lat, "lng": pts[k].lng, "notes": detours.get(k, []),
                    "kind": "venue" if k == "venue" else k.split(":")[0]} for k in keep],
        "routes": [{"color": COLORS[i % len(COLORS)], "label": r.driver, "path": line(r.driver, r.stops),
                    "direct": line(r.driver, ()) if r.stops else None}
                   for i, r in enumerate(plan.routes)],
        "taxis": [[[pts[s].lat, pts[s].lng], [venue.lat, venue.lng]] for s in taxis],
    }
    rides = len(plan.rides)
    summary = (f"{rides} 人搭顺风车" + (f"，车主共多绕 {carpool.fmt_min(plan.detour)}" if plan.detour >= 1 else "")
               + (f"，{len(plan.taxi)} 人打车" if plan.taxi else ""))
    stamp = (generated or dt.datetime.now()).strftime("%m-%d %H:%M")
    return TEMPLATE.format(
        title=escape(f"{venue.name} 出行方案"),
        eyebrow=escape(f"{_date_label(trip.travel_date)} 出发 · 方案 {index + 1}"),
        venue=escape(venue.name),
        venue_url=escape(venue_link[1]),
        summary=escape(summary),
        drivers="".join(drivers),
        riders="".join(riders) or '<p class="meta">这个方案里没有需要接的人。</p>',
        buffer=round(trip.exit_buffer),
        stamp=escape(stamp),
        data=json.dumps(map_data, ensure_ascii=False).replace("</", "<\\/"),
    )


TEMPLATE = """<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css">
<style>
  :root {{ --bg: #faf7f2; --card: #fff; --ink: #24201c; --muted: #7a7168; --line: #ebe4da; --accent: #b4442c; --drive: #15803d; --ride: #d97706; --taxi: #6b7280; }}
  * {{ box-sizing: border-box; }}
  body {{ margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.6 -apple-system, "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif; }}
  .wrap {{ max-width: 720px; margin: 0 auto; padding: 0 16px 40px; }}
  header {{ padding: 28px 0 16px; }}
  .eyebrow {{ color: var(--accent); font-size: 13px; letter-spacing: .06em; }}
  h1 {{ margin: 4px 0 6px; font-size: 24px; line-height: 1.3; }}
  .sum {{ margin: 0 0 12px; color: var(--muted); }}
  .legend {{ color: var(--muted); font-size: 12px; margin: 6px 2px 0; }}
  #map {{ height: 46vh; min-height: 260px; border-radius: 14px; border: 1px solid var(--line); background: #eee; }}
  h2 {{ font-size: 14px; color: var(--muted); margin: 26px 0 10px; letter-spacing: .04em; }}
  .card {{ background: var(--card); border: 1px solid var(--line); border-left: 5px solid var(--drive); border-radius: 12px; padding: 14px 16px; margin-bottom: 12px; }}
  .card.rider {{ border-left-color: var(--ride); }}
  .card.taxi {{ border-left-color: var(--taxi); }}
  .card h3 {{ margin: 0 0 8px; font-size: 17px; display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }}
  .tag {{ font-size: 12px; font-weight: normal; color: var(--muted); background: #f3eee7; border-radius: 999px; padding: 1px 8px; }}
  .line {{ list-style: none; margin: 0; padding: 0; }}
  .line li {{ display: grid; grid-template-columns: 50px 1fr; gap: 10px; padding: 6px 0; border-top: 1px dashed var(--line); }}
  .line li:first-child {{ border-top: 0; }}
  .line li .t {{ font-variant-numeric: tabular-nums; font-weight: 600; }}
  .line a, .note a {{ color: var(--accent); white-space: nowrap; margin-left: 4px; }}
  .meta {{ color: var(--muted); font-size: 13px; margin: 8px 0 0; }}
  .navs {{ display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }}
  .btn {{ display: inline-block; padding: 6px 12px; border-radius: 8px; background: var(--accent); color: #fff; text-decoration: none; font-size: 14px; }}
  .btn.ghost {{ background: #fff; color: var(--accent); border: 1px solid var(--accent); }}
  .note {{ margin: 8px 0 0; padding: 8px 10px; background: #f7f3ec; border-radius: 8px; font-size: 13px; color: #5b524a; }}
  .tips {{ font-size: 14px; color: #4b443d; padding-left: 20px; }}
  footer {{ color: var(--muted); font-size: 12px; margin-top: 24px; }}
  .leaflet-tooltip.lbl {{ font-size: 12px; padding: 1px 6px; }}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="eyebrow">{eyebrow}</div>
    <h1>去 {venue}</h1>
    <p class="sum">{summary}</p>
    <a class="btn ghost" href="{venue_url}" target="_blank" rel="noopener">在高德里看场地</a>
  </header>
  <div id="map"></div>
  <p class="legend">彩色线：接人后的实际路线；灰色虚线：不接人时的直达路线，两条线分开的那段就是绕的路。</p>
  <h2>开车的</h2>
  {drivers}
  <h2>坐车的</h2>
  {riders}
  <h2>注意</h2>
  <ul class="tips">
    <li>时刻按车次到站后 {buffer} 分钟出站推算，车主时间来自高德路况估算，当天以群里实时位置为准。</li>
    <li>高铁站一般不能在送客平台停车，去停车场或网约车上车点接人；到了在群里发「共享实时位置」。</li>
    <li>车次、余票以 12306 为准，提前买票。</li>
  </ul>
  <footer>生成于 {stamp} · 链接会打开高德地图</footer>
</div>
<script id="data" type="application/json">{data}</script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js"></script>
<script>
(function () {{
  if (!window.L) {{ document.getElementById('map').style.display = 'none'; return; }}
  var data = JSON.parse(document.getElementById('data').textContent);
  var colors = {{ venue: '#dc2626', st: '#2563eb', car: '#15803d', home: '#d97706' }};
  var map = L.map('map', {{ scrollWheelZoom: false }});
  L.tileLayer('https://webrd0{{s}}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={{x}}&y={{y}}&z={{z}}',
    {{ subdomains: '1234', maxZoom: 18, attribution: '© 高德地图' }}).addTo(map);
  var bounds = [];
  data.routes.forEach(function (r) {{
    if (r.direct) {{
      L.polyline(r.direct, {{ color: '#6b7280', weight: 4, opacity: 0.65, dashArray: '6 8' }}).bindTooltip(r.label + ' 不接人的直达路线', {{ sticky: true }}).addTo(map);
      bounds = bounds.concat(r.direct);
    }}
  }});
  data.routes.forEach(function (r) {{
    L.polyline(r.path, {{ color: r.color, weight: 5, opacity: 0.85 }}).bindTooltip(r.label, {{ sticky: true }}).addTo(map);
    bounds = bounds.concat(r.path);
  }});
  data.taxis.forEach(function (t) {{ L.polyline(t, {{ color: '#6b7280', weight: 3, dashArray: '4 6' }}).addTo(map); }});
  data.points.forEach(function (p) {{
    var el = document.createElement('span'); el.textContent = p.name;
    p.notes.forEach(function (n) {{ var b = document.createElement('b'); b.textContent = n; el.appendChild(document.createElement('br')); el.appendChild(b); }});
    L.circleMarker([p.lat, p.lng], {{ radius: p.kind === 'venue' ? 9 : 7, color: '#fff', weight: 2, fillColor: colors[p.kind], fillOpacity: 1 }})
      .bindTooltip(el, {{ permanent: true, direction: 'top', offset: [0, -6], className: 'lbl' }}).addTo(map);
    bounds.push([p.lat, p.lng]);
  }});
  map.fitBounds(L.latLngBounds(bounds).pad(0.08));
}})();
</script>
</body>
</html>
"""
