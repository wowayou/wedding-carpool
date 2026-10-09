# SPDX-License-Identifier: AGPL-3.0-or-later
"""行程模型和读配置：Person、Trip、Leg，把配置（dict）解析成 Trip，估算公交用时，建行车时间矩阵。"""

from __future__ import annotations

import datetime as dt
import re
import sys
from dataclasses import dataclass, field

from base import DEFAULTS, INF, report
from geo import AmapError, Place, QuotaError, parse_loc, pick_stations


@dataclass
class Person:
    name: str
    home: Place
    seats: int | None = None  # None = 不开车；数字 = 开车，且有几个空座
    max_detour: float = 30
    pickup_at_home: bool = True
    stations: list[str] | None = None  # 只考虑这些站
    rail_min: dict[str, float] = field(default_factory=dict)  # 到各站用时（分钟），手填或按车次算
    trains: dict[str, str] = field(default_factory=dict)  # 到各站坐的车，如 "G1234 08:00→11:30"
    note: str = ""
    party: int = 1  # 同行人数：一组人要么一起上同一辆车，要么一起打车
    # 返程插件用：从各站坐的车（首个时刻是发车时间）、用时；车主返程是否开车送人、最多绕路
    back_trains: dict[str, str] = field(default_factory=dict)
    back_rail_min: dict[str, float] = field(default_factory=dict)
    back_drives: bool = True
    back_max_detour: float | None = None
    leave: float | None = None  # 返程：这个人想几点离开目的地（当天分钟数）；不填就是散场时间
    rail_est: dict[str, tuple[float, str]] = field(default_factory=dict)  # 高德估算的（分钟, 车次摘要）

    @property
    def drives(self) -> bool:
        return self.seats is not None


@dataclass
class Trip:
    venue: Place
    people: list[Person]
    stations: list[Place]
    max_stops: int
    station_cost: float
    discovered: bool
    warnings: list[str]
    estimate_rail: bool = True
    travel_date: str = ""  # 公交估算用的出发日期 YYYY-M-D
    travel_time: str = DEFAULTS["travel_time"]
    exit_buffer: float = 15  # 列车到站后出站、走到接人点的分钟数
    resolved: list[dict] = field(default_factory=list)  # 这次按文字定位到的坐标，写回配置后下次就不用再查
    back: "Leg | None" = None  # 返程插件开启时的返程设置
    back_plans: list = field(default_factory=list)
    outbound: bool = True  # 是否规划去程；关掉时只算返程（plans 为空）
    taxi_mode: str = DEFAULTS["taxi_mode"]
    taxi_extra: float = DEFAULTS["taxi_pool_extra_min"]  # 为了拼车，一个人最多比自己最快的走法多花几分钟
    taxi_wait: float = DEFAULTS["taxi_wait_min"]         # 同一辆出租里的人，到站或离场的时间最多相差几分钟
    try_mode: bool = False  # 试玩模式（网页版 /try）：行车时间是直线距离估算的，报告不能说来自高德


TRY_NOTICE = "试玩：行车时间按直线距离估算，路线画成直线，不是真实路况。"


def prefetch(amap, build) -> None:
    """客户端支持批量预取时，先把接下来要用的一组请求一次取回（网页版跨洋调用慢，靠它省时间）。"""
    if hasattr(amap, "prefetch"):
        amap.prefetch(build())


def resolve(amap, label: str, query: str, item: dict, station: bool = False,
            record: list | None = None, path: str = "") -> Place:
    if item.get("location"):
        return Place(label, *parse_loc(item["location"]), "配置里直接给的坐标", city=str(item.get("city") or ""))
    if station:
        # 站名不能退回地址解析：「清河西站」会被解析成辽宁铁岭清河区
        place = amap.find_station(query, item.get("city"))
        if place is None:
            raise SystemExit(f"高德没搜到车站「{query}」。给它加上 city = \"所在城市\"，或直接填 location")
    else:
        place = amap.geocode(query, item.get("city"))
    if place is None:
        raise SystemExit(f"找不到地点：{query}。换个更具体的写法，或直接填 location = \"经度,纬度\"")
    place.name = label
    if record is not None:
        record.append({"path": path, "location": place.loc, "city": place.city, "note": place.note})
    return place


def check_unique_names(people: list[dict]) -> None:
    """计算内核按名字区分人：重名会让两个人互相覆盖。去掉首尾空白后比较，报出具体是第几位和第几位。"""
    seen: dict[str, int] = {}
    for i, p in enumerate(people):
        name = str(p.get("name") or "").strip()
        if not name:
            continue
        if name in seen:
            raise SystemExit(f"成员名字重复：第 {seen[name] + 1} 位和第 {i + 1} 位都叫「{name}」。计算时按名字区分人，请改成不同的名字（比如加上姓或「大」「小」）")
        seen[name] = i


def leave_time(p: dict) -> float | None:
    """成员的离场时间 leave_time（返程）：时:分，24 小时制；没填返回 None。"""
    text = str(p.get("leave_time") or "").strip()
    if not text:
        return None
    if not re.fullmatch(r"([01]?\d|2[0-3]):[0-5]\d", text):
        raise SystemExit(f"{p.get('name') or '成员'}的离场时间「{text}」要写成 时:分（24 小时制），如 21:30")
    return float(train_times(text)[0])


def load_places(cfg: dict, amap, record: list) -> tuple[Place, list[Person]]:
    """解析目的地和每个人的出发地；按文字定位到的结果记进 record。"""
    opt = cfg.get("options", {})
    default_detour = float(opt.get("max_detour_min", DEFAULTS["max_detour_min"]))
    v = cfg.get("venue") or {}
    check_unique_names(cfg.get("people") or [])  # 先查重名，别白白调用高德
    report("定位目的地、成员和车站")
    prefetch(amap, lambda: [
        *([amap.geocode_query(v.get("address") or v.get("name", ""), v.get("city"))] if not v.get("location") else []),
        *(amap.geocode_query(p.get("from", ""), p.get("city")) for p in cfg.get("people", []) if not p.get("location")),
        *(amap.station_query(s["name"], s.get("city")) for s in cfg.get("stations") or [] if not s.get("location")),
    ])
    if not (v.get("location") or v.get("address") or v.get("name")):
        raise SystemExit("还没填目的地")
    venue = resolve(amap, v.get("name") or "目的地", v.get("address") or v.get("name", ""), v, record=record, path="venue")
    people = []
    for i, p in enumerate(cfg.get("people", [])):
        seats = p.get("car_seats")
        people.append(Person(
            name=p["name"],
            home=resolve(amap, f"{p['name']}出发地", p.get("from", ""), p, record=record, path=f"people.{i}"),
            seats=None if seats is None else int(seats),
            max_detour=float(p.get("max_detour_min", default_detour)),
            pickup_at_home=bool(p.get("pickup_at_home", True)),
            stations=p.get("stations"),
            rail_min={k: float(m) for k, m in (p.get("rail_min") or {}).items()},
            trains={k: str(t) for k, t in (p.get("trains") or {}).items() if str(t).strip()},
            note=str(p.get("note") or ""),
            party=max(1, int(p.get("party") or 1)),
            back_trains={k: str(t) for k, t in (p.get("return_trains") or {}).items() if str(t).strip()},
            back_rail_min={k: float(m) for k, m in (p.get("return_rail_min") or {}).items()},
            back_drives=bool(p.get("return_drives", True)),
            back_max_detour=float(p["return_max_detour_min"]) if p.get("return_max_detour_min") is not None else None,
            leave=leave_time(p),
        ))
    access = float(opt.get("station_access_min", DEFAULTS["station_access_min"]))
    for person in people:  # 填了车次没填分钟：按「首个发车 → 最后到站」加上去车站和候车的时间算
        for trains, minutes in ((person.trains, person.rail_min), (person.back_trains, person.back_rail_min)):
            for st, text in trains.items():
                times = train_times(text)
                if st not in minutes and len(times) >= 2:
                    minutes[st] = (times[-1] - times[0]) % 1440 + access
    return venue, people


def load_trip(cfg: dict, amap) -> Trip:
    opt = cfg.get("options", {})
    outbound = bool(opt.get("outbound", True))
    back = back_leg(cfg)  # 配置有问题先报出来，不白白调用高德
    if not outbound and back is None:
        raise SystemExit("去程和返程至少要规划一段：现在去程关了，返程也没开")
    if not outbound and not str((cfg.get("return") or {}).get("date") or "").strip():
        raise SystemExit("只规划返程时，要填返程日期（[return] 的 date，如 2026-10-18）")
    taxi_mode = str(opt.get("taxi_mode", DEFAULTS["taxi_mode"]))
    if taxi_mode not in ("save", "fast"):
        raise SystemExit(f"打车方式 taxi_mode 只能是 \"save\"（尽量拼车省钱）或 \"fast\"（各人走自己最快的站），现在是「{taxi_mode}」")
    resolved: list[dict] = []
    venue, people = load_places(cfg, amap, resolved)
    if not people:
        raise SystemExit("配置里至少要有一个 [[people]]")

    radius = float(opt.get("discover_radius_km", DEFAULTS["discover_radius_km"]))
    if cfg.get("stations"):
        stations = [resolve(amap, s["name"], s["name"], s, station=True, record=resolved, path=f"stations.{i}")
                    for i, s in enumerate(cfg["stations"])]
        discovered = False
    else:
        print(f"配置里没写候选站，自动搜索目的地 {radius:.0f} km 内的火车站…", file=sys.stderr)
        stations = pick_stations(amap.stations_near(venue, radius), venue, radius,
                                 int(opt.get("discover_limit", DEFAULTS["discover_limit"])))
        discovered = True

    names = {s.name for s in stations}
    warnings = []
    for p in people:
        for s in sorted({*(p.stations or []), *p.rail_min, *p.trains, *p.back_trains, *p.back_rail_min}):
            if s not in names:
                warnings.append(f"{p.name} 写的站「{s}」不在候选站里，已忽略（名字要和候选站完全一致）")
    # 只规划返程时没有去程日期可借用，日期取返程日期
    date = str((opt.get("travel_date") if outbound else cfg["return"]["date"]) or dt.date.today() + dt.timedelta(days=1))
    y, m, d = (int(x) for x in date.replace("/", "-").split("-"))
    return Trip(venue, people, stations, int(opt.get("max_stops", DEFAULTS["max_stops"])),
                float(opt.get("station_cost_min", DEFAULTS["station_cost_min"])), discovered, warnings,
                estimate_rail=bool(opt.get("estimate_rail", True)),
                travel_date=f"{y}-{m}-{d}", travel_time=str(opt.get("travel_time", DEFAULTS["travel_time"])),
                exit_buffer=float(opt.get("exit_buffer_min", DEFAULTS["exit_buffer_min"])), resolved=resolved, back=back,
                outbound=outbound, taxi_mode=taxi_mode,
                taxi_extra=float(opt.get("taxi_pool_extra_min", DEFAULTS["taxi_pool_extra_min"])),
                taxi_wait=float(opt.get("taxi_wait_min", DEFAULTS["taxi_wait_min"])))


def back_leg(cfg: dict) -> "Leg | None":
    """返程插件的设置：[return] enabled、depart_time（散场时间，没填离场时间的人从这时走）、
    security_min（发车前多久到站）、max_wait_min（乘客最多等车主多久）。"""
    r = cfg.get("return") or {}
    if not r.get("enabled"):
        return None
    times = train_times(str(r.get("depart_time") or ""))
    if not times:
        raise SystemExit("开了返程，但还没填散场后几点出发")
    return Leg("back", "返程", reverse=True, depart=times[0], margin=float(r.get("security_min", DEFAULTS["security_min"])),
               max_wait=float(r.get("max_wait_min", DEFAULTS["max_wait_min"])))


def train_times(text: str) -> list[int]:
    """车次说明里出现的所有时刻（当天分钟数），如 "G1234 08:00→11:30" → [480, 690]。"""
    return [int(h) * 60 + int(m) for h, m in re.findall(r"(\d{1,2}):(\d{2})", text)]


def clock(minute: float) -> str:
    m = round(minute) % 1440
    return f"{m // 60:02d}:{m % 60:02d}"


def estimate_rail(amap, trip: Trip) -> None:
    """用高德公共交通规划（含跨城火车）估算不开车的人到各候选站要多久。"""
    by_name = {s.name: s for s in trip.stations}
    riders = [p for p in trip.people if not p.drives and not p.rail_min]
    if not trip.estimate_rail or not riders or not by_name:
        return
    print(f"正在估算 {len(riders)} 位乘客到各站的公共交通用时…", file=sys.stderr)
    total = sum(len(by_name) if p.stations is None else len(p.stations) for p in riders)
    done = 0
    for p in riders:
        allowed = list(by_name) if p.stations is None else [s for s in p.stations if s in by_name]
        missing, error = [], ""
        for s in allowed:
            report("估算坐公共交通到各站的用时", done, total)
            done += 1
            try:  # 网络和频率限制在 _get 里已经重试过，这里失败就是真的查不到
                est = amap.transit(p.home, by_name[s], trip.travel_date, trip.travel_time)
            except QuotaError:
                raise  # 配额用完要停下，不能当成「这个站查不到」接着查下一个
            except AmapError as e:
                est, error = None, str(e)
            if est:
                p.rail_est[s] = est
            else:
                missing.append(s)
        if not allowed:
            continue
        if not p.rail_est:
            trip.warnings.append(f"没查到 {p.name} 到任何候选站的公共交通方案{'（' + error + '）' if error else ''}，"
                                 f"改按每站 {trip.station_cost:.0f} 分钟估算；建议去 12306 查好后填 rail_min")
        elif missing:
            trip.warnings.append(f"没查到 {p.name} 到 {'、'.join(missing)} 的公共交通方案"
                                 f"{'（' + error + '）' if error else ''}，已不考虑这些站；实际能到的话给他填 rail_min")


def points_of(trip: Trip) -> dict[str, Place]:
    pts = {"venue": trip.venue}
    pts.update({f"st:{s.name}": s for s in trip.stations})
    for p in trip.people:
        pts[f"{'car' if p.drives else 'home'}:{p.name}"] = p.home
    return pts


def build_matrix(amap, pts: dict[str, Place], skip: set[str], out: bool = True, back: bool = False) -> dict[tuple[str, str], float]:
    """行车分钟数 T[(起点, 终点)]，只查需要的方向。
    去程（out）：起点含车主出发地，终点含目的地，接人点两者都是。
    返程（back）：起点含目的地，终点含车主家，送人点两者都是。两段都要时是两者的并集。"""
    origins = [k for k in pts if k not in skip and ((out and k != "venue") or (back and not k.startswith("car:")))]
    dests = [k for k in pts if k not in skip and ((out and not k.startswith("car:")) or (back and k != "venue"))]
    print(f"正在向高德查询行车时间（约 {len(dests)} 次请求）…", file=sys.stderr)
    T: dict[tuple[str, str], float] = {}
    plan = [(d, [o for o in origins if o != d]) for d in dests]
    report("查询行车时间", 0, len(plan))
    prefetch(amap, lambda: [amap.distance_query([pts[o] for o in srcs], pts[d]) for d, srcs in plan if len(srcs) <= 100])
    for i, (d, srcs) in enumerate(plan):
        report("查询行车时间", i, len(plan))
        for o, m in zip(srcs, amap.drive_minutes([pts[o] for o in srcs], pts[d])):
            if m is not None:
                T[(o, d)] = m
        T[(d, d)] = 0.0
    return T


@dataclass
class Leg:
    """一段行程。去程：车主家 → 接人点 → 目的地；返程（插件）：目的地 → 送人点 → 车主家。
    方向决定路线顺序、绕路的基准和时间约束：去程看「到站后多久能上车」，返程看「发车前多久要到站」。"""
    key: str
    title: str
    reverse: bool = False
    depart: float | None = None  # 返程：散场时间（当天分钟数）；没填离场时间的人从这时出发
    margin: float = 40           # 返程：发车前多少分钟要到站
    max_wait: float = 30         # 返程：乘客最多等车主多久

    def ends(self, driver: str) -> tuple[str, str]:
        car = f"car:{driver}"
        return ("venue", car) if self.reverse else (car, "venue")

    def sequence(self, driver: str, stops: tuple) -> list[str]:
        start, end = self.ends(driver)
        return [start, *stops, end]

    def station_to_venue(self, T, stop: str) -> float:
        """打车组：去程从站到目的地，返程从目的地到站。"""
        return T.get(("venue", stop) if self.reverse else (stop, "venue"), INF)


OUT = Leg("out", "去程")
