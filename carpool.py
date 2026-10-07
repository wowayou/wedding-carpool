#!/usr/bin/env python3
"""拼车出行规划：多人从不同城市去同一个地方，用高德真实行车时间算哪个高铁站最顺路、谁搭谁的车。

    export AMAP_KEY=你的高德Web服务Key     # 或把 Key 存进同目录的 .amap_key
    python3 carpool.py trip.toml          # 报告同时打印并写到 trip-report.md
    python3 ui.py                         # 网页界面，见 ui.py

配置格式见 trip.example.toml。只依赖 Python 3.11+ 标准库。
"""

from __future__ import annotations

import argparse
import datetime as dt
import http.client
import itertools
import json
import math
import os
import re
import sys
import time
import tomllib
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

API = "https://restapi.amap.com"
STATION_TYPE = "150200"  # 高德 POI 分类：交通设施服务;火车站
# 火车站 POI 里混着出入口、售票处、停车场等子点，按名字剔除
STATION_NOISE = ("-", "(", "（", "进站", "出站", "售票", "停车", "候车", "货运", "派出所",
                 "广场", "通道", "上车点", "下车点")
# 网络层的偶发错误（连接被重置、超时、返回半截）重试即可
TRANSIENT_ERRORS = (urllib.error.URLError, ConnectionError, TimeoutError, http.client.HTTPException, ValueError)
RETRIES = 3
COMBO_LIMIT = 30_000  # 车主路线组合的枚举上限，车多时自动收紧每辆车保留的候选路线
INF = math.inf


# 进度回调：长操作分阶段报告 (阶段说明, 已完成数, 总数)，网页版用来显示进度条；本地版不设
progress = None
current_stage = ""


def report(label: str, done: int | None = None, total: int | None = None) -> None:
    global current_stage
    current_stage = label
    if progress:
        progress(label, done, total)


class AmapError(RuntimeError):
    pass


class QuotaError(AmapError):
    """高德配额或额度用完：直接停下提示，不重试、不跳过（继续调用只会接着失败，买额度要用户自己决定）。"""


# 配额类错误：日调用量超限（含账号维度、海外）、额度用完、服务到期
# 网页版还有两种：单个行程每天的上限、站长 Key 全站每天的上限
QUOTA_INFOS = ("DAILY_QUERY_OVER_LIMIT", "QUOTA_PLAN_RUN_OUT", "SERVICE_EXPIRED", "TRIP_DAILY_LIMIT", "OWNER_DAILY_LIMIT")


def check_quota(info: str, detail: str = "") -> None:
    if any(q in info for q in QUOTA_INFOS):
        raise QuotaError(detail or (f"高德配额已用完（{info}），已停止计算，没有继续调用。"
                                    "额度一般次日恢复；要买额度会产生费用，请自己在高德控制台决定"))


@dataclass
class Place:
    name: str
    lng: float
    lat: float
    note: str = ""  # 解析结果，供人工核对
    citycode: str = ""  # 高德城市编码，公交跨城规划要用
    city: str = ""  # 城市名，拼 12306 查询链接要用

    @property
    def loc(self) -> str:
        return f"{self.lng:.6f},{self.lat:.6f}"


def parse_loc(text: str) -> tuple[float, float]:
    lng, lat = (float(x) for x in text.replace("，", ",").split(","))
    return lng, lat


def km_between(a: Place, b: Place) -> float:
    p1, p2 = math.radians(a.lat), math.radians(b.lat)
    h = (math.sin((p2 - p1) / 2) ** 2
         + math.cos(p1) * math.cos(p2) * math.sin(math.radians(b.lng - a.lng) / 2) ** 2)
    return 2 * 6371.0 * math.asin(math.sqrt(h))


def _text(v) -> str:
    return v if isinstance(v, str) else ""  # 高德对空字段有时返回 []


class Amap:
    """高德 Web 服务 API 的最小封装。坐标均为高德坐标（GCJ-02）。"""

    def __init__(self, key: str, pause: float = 0.35):
        self.key = key
        self.pause = pause  # 个人 Key 有 QPS 限制，串行调用并稍作间隔
        self.calls = 0
        self.cache: dict[str, dict] = {}  # 同一进程内重复计算（比如界面里改了座位数）不重复调用

    def _get(self, path: str, **params) -> dict:
        query = urllib.parse.urlencode(params)
        if (cache_key := f"{path}?{query}") in self.cache:
            return self.cache[cache_key]
        url = self._url(path, query)
        for attempt in range(RETRIES + 1):
            backoff = 1.5 * (attempt + 1)
            try:
                data = self._fetch(url)
            except TRANSIENT_ERRORS as e:
                if attempt == RETRIES:
                    raise AmapError(f"连不上高德（{path}，已重试 {RETRIES} 次）：{e}") from e
                time.sleep(backoff)
                continue
            self.calls += 1
            time.sleep(self.pause)
            if str(data.get("status")) == "1":
                break
            info = str(data.get("info"))
            check_quota(info, _text(data.get("error")))
            if ("QPS" in info or "TOO_FREQUENT" in info) and attempt < RETRIES:  # 频率超限，等一下再试
                time.sleep(backoff)
                continue
            raise AmapError(f"{path}：{info}（infocode {data.get('infocode')}）")
        self.cache[cache_key] = data
        return data

    # 各类请求的参数：接口方法和批量预取（prefetch）共用，保证缓存键一致
    def geocode_query(self, address: str, city: str | None = None) -> tuple[str, dict]:
        return "/v3/geocode/geo", {"address": address, **({"city": city} if city else {})}

    def station_query(self, name: str, city: str | None = None) -> tuple[str, dict]:
        return "/v5/place/text", {"keywords": name, "types": STATION_TYPE, "page_size": 10,
                                  **({"region": city} if city else {})}

    def distance_query(self, origins: list[Place], dest: Place) -> tuple[str, dict]:
        return "/v3/distance", {"origins": "|".join(p.loc for p in origins), "destination": dest.loc, "type": 1}

    def around_query(self, center: Place, radius_km: float) -> tuple[str, dict]:
        return "/v5/place/around", {"location": center.loc, "types": STATION_TYPE, "sortrule": "distance",
                                    "radius": min(int(radius_km * 1000), 50000), "page_size": 25}

    def stations_around(self, center: Place, radius_km: float) -> list[dict]:
        """一个点周围的火车站 POI（一页，按距离排序）。"""
        path, params = self.around_query(center, radius_km)
        return self._get(path, **params).get("pois") or []

    def driving_query(self, places: list[Place]) -> tuple[str, dict]:
        params = {"origin": places[0].loc, "destination": places[-1].loc, "extensions": "base"}
        if len(places) > 2:
            params["waypoints"] = ";".join(p.loc for p in places[1:-1])
        return "/v3/direction/driving", params

    def prefetch(self, queries: list[tuple[str, dict]]) -> None:
        """批量预取一组请求放进缓存。本地直连高德够快，不需要；网页版里改成一次发给 Worker 并发请求。"""

    # 下面两个方法在网页版里被替换：请求改发到 Worker 的 /api/amap 代理，Key 不进浏览器
    def _url(self, path: str, query: str) -> str:
        return f"{API}{path}?{query}&{urllib.parse.urlencode({'key': self.key})}"

    def _fetch(self, url: str) -> dict:
        with urllib.request.urlopen(url, timeout=20) as resp:
            return json.load(resp)

    def search(self, keywords: str, city: str | None = None, types: str | None = None) -> list[dict]:
        """给界面用的地点搜索：高德 POI 候选，加一条地址解析结果兜底。"""
        params = {"keywords": keywords, "page_size": 10, **({"region": city} if city else {}),
                  **({"types": types} if types else {})}
        out = [{"name": p.get("name"), "location": p.get("location"), "city": _text(p.get("cityname")),
                "detail": f"{p.get('pname') or ''}{p.get('cityname') or ''}{p.get('adname') or ''} {_text(p.get('address'))}"}
               for p in self._get("/v5/place/text", **params).get("pois") or []]
        place = self.geocode(keywords, city)
        if place:
            out.append({"name": keywords, "location": place.loc, "city": place.city, "detail": f"地址解析：{place.note}"})
        return out

    def drive_path(self, places: list[Place], max_points: int = 600) -> list[list[float]]:
        """按顺序经过各点的驾车路线，返回 [[lat, lng], ...]，给地图画线用。"""
        api, params = self.driving_query(places)
        path = self._get(api, **params)["route"]["paths"][0]
        pts = [[float(y), float(x)] for step in path["steps"]
               for x, y in (pair.split(",") for pair in step["polyline"].split(";"))]
        stride = max(1, len(pts) // max_points)
        return pts[::stride] + ([pts[-1]] if pts and (len(pts) - 1) % stride else [])

    def geocode(self, address: str, city: str | None = None) -> Place | None:
        path, params = self.geocode_query(address, city)
        hits = self._get(path, **params).get("geocodes") or []
        if not hits:
            return None
        g = hits[0]
        return Place(address, *parse_loc(g["location"]),
                     f"{g.get('formatted_address') or ''}（精度：{g.get('level') or '?'}）",
                     _text(g.get("citycode")), _text(g.get("city")) or _text(g.get("province")))

    def find_station(self, name: str, city: str | None = None) -> Place | None:
        path, params = self.station_query(name, city)
        pois = self._get(path, **params).get("pois") or []
        if not pois:
            return None
        poi = next((p for p in pois if p.get("name") == name), pois[0])
        return Place(name, *parse_loc(poi["location"]),
                     f"{poi.get('name')}（{poi.get('cityname', '')}{poi.get('adname', '')}）",
                     _text(poi.get("citycode")), _text(poi.get("cityname")))

    def stations_near(self, center: Place, radius_km: float, max_pages: int = 8) -> list[dict]:
        # 周边搜索最大 50km 且按距离排序，保证近处的站不漏；矩形搜索补上更远的站
        pois = self._get("/v5/place/around", location=center.loc, types=STATION_TYPE,
                         radius=min(int(radius_km * 1000), 50000), sortrule="distance",
                         page_size=25).get("pois") or []
        dlat = radius_km / 111.0
        dlng = radius_km / (111.0 * math.cos(math.radians(center.lat)))
        polygon = (f"{center.lng - dlng:.6f},{center.lat + dlat:.6f}|"
                   f"{center.lng + dlng:.6f},{center.lat - dlat:.6f}")
        for page in range(1, max_pages + 1):
            batch = self._get("/v5/place/polygon", polygon=polygon, types=STATION_TYPE,
                              page_size=25, page_num=page).get("pois") or []
            pois += batch
            if len(batch) < 25:
                break
        return pois

    def drive_minutes(self, origins: list[Place], dest: Place) -> list[float | None]:
        out: list[float | None] = []
        for i in range(0, len(origins), 100):  # 距离测量一次最多 100 个起点
            chunk = origins[i:i + 100]
            path, params = self.distance_query(chunk, dest)
            data = self._get(path, **params)
            mins: list[float | None] = [None] * len(chunk)
            for r in data.get("results") or []:
                if str(r.get("duration", "")).isdigit():
                    mins[int(r["origin_id"]) - 1] = int(r["duration"]) / 60
            out += mins
        return out

    def citycode(self, p: Place) -> str:
        if not p.citycode:
            comp = (self._get("/v3/geocode/regeo", location=p.loc).get("regeocode") or {}).get("addressComponent") or {}
            p.citycode = _text(comp.get("citycode"))
        return p.citycode

    def transit(self, a: Place, b: Place, date: str, clock: str) -> tuple[float, str] | None:
        """公共交通（含跨城火车）最快方案的分钟数和乘车摘要；查不到返回 None。"""
        data = self._get("/v3/direction/transit/integrated", origin=a.loc, destination=b.loc,
                         city=self.citycode(a), cityd=self.citycode(b), date=date, time=clock)
        plans = [t for t in (data.get("route") or {}).get("transits") or []
                 if str(t.get("duration", "")).isdigit()]
        if not plans:
            return None
        best = min(plans, key=lambda t: int(t["duration"]))
        trains = []
        for seg in best.get("segments") or []:
            rw = seg.get("railway")
            if isinstance(rw, dict) and rw.get("name"):
                dep = _text((rw.get("departure_stop") or {}).get("name"))
                arr = _text((rw.get("arrival_stop") or {}).get("name"))
                trains.append(f"{_text(rw.get('trip')) or rw['name']} {dep}→{arr}")
        return int(best["duration"]) / 60, "；".join(trains) or "无火车段"


def pick_stations(pois: list[dict], venue: Place, radius_km: float, limit: int) -> list[Place]:
    seen: set[str] = set()
    out = []
    for poi in pois:
        name = poi.get("name") or ""
        if name in seen or not name.endswith("站") or any(n in name for n in STATION_NOISE):
            continue
        if poi.get("typecode") and not str(poi["typecode"]).startswith("1502"):
            continue
        seen.add(name)
        place = Place(name, *parse_loc(poi["location"]),
                      f"{poi.get('cityname') or ''}{poi.get('adname') or ''}（自动发现）",
                      _text(poi.get("citycode")), _text(poi.get("cityname")))
        if km_between(place, venue) <= radius_km:
            out.append(place)
    out.sort(key=lambda p: km_between(p, venue))
    return out[:limit]


# ---------- 行程模型 ----------

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
    travel_time: str = "08:00"
    exit_buffer: float = 15  # 列车到站后出站、走到接人点的分钟数
    resolved: list[dict] = field(default_factory=list)  # 这次按文字定位到的坐标，写回配置后下次就不用再查


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


def load_places(cfg: dict, amap, record: list) -> tuple[Place, list[Person]]:
    """解析目的地和每个人的出发地；按文字定位到的结果记进 record。"""
    opt = cfg.get("options", {})
    default_detour = float(opt.get("max_detour_min", 30))
    v = cfg.get("venue") or {}
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
        ))
    access = float(opt.get("station_access_min", 45))
    for person in people:  # 填了车次没填分钟：按「首个发车 → 最后到站」加上去车站和候车的时间算
        for st, text in person.trains.items():
            times = train_times(text)
            if st not in person.rail_min and len(times) >= 2:
                person.rail_min[st] = (times[-1] - times[0]) % 1440 + access
    return venue, people


def load_trip(cfg: dict, amap) -> Trip:
    opt = cfg.get("options", {})
    resolved: list[dict] = []
    venue, people = load_places(cfg, amap, resolved)
    if not people:
        raise SystemExit("配置里至少要有一个 [[people]]")

    radius = float(opt.get("discover_radius_km", 120))
    if cfg.get("stations"):
        stations = [resolve(amap, s["name"], s["name"], s, station=True, record=resolved, path=f"stations.{i}")
                    for i, s in enumerate(cfg["stations"])]
        discovered = False
    else:
        print(f"配置里没写候选站，自动搜索目的地 {radius:.0f} km 内的火车站…", file=sys.stderr)
        stations = pick_stations(amap.stations_near(venue, radius), venue, radius,
                                 int(opt.get("discover_limit", 10)))
        discovered = True

    names = {s.name for s in stations}
    warnings = []
    for p in people:
        for s in sorted({*(p.stations or []), *p.rail_min, *p.trains}):
            if s not in names:
                warnings.append(f"{p.name} 写的站「{s}」不在候选站里，已忽略（名字要和候选站完全一致）")
    date = str(opt.get("travel_date") or dt.date.today() + dt.timedelta(days=1))
    y, m, d = (int(x) for x in date.replace("/", "-").split("-"))
    return Trip(venue, people, stations, int(opt.get("max_stops", 2)),
                float(opt.get("station_cost_min", 60)), discovered, warnings,
                estimate_rail=bool(opt.get("estimate_rail", True)),
                travel_date=f"{y}-{m}-{d}", travel_time=str(opt.get("travel_time", "08:00")),
                exit_buffer=float(opt.get("exit_buffer_min", 15)), resolved=resolved)


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


def build_matrix(amap, pts: dict[str, Place], skip: set[str]) -> dict[tuple[str, str], float]:
    """行车分钟数 T[(起点, 终点)]。起点含车主出发地，终点含目的地，接人点两者都是。"""
    origins = [k for k in pts if k != "venue" and k not in skip]
    dests = [k for k in pts if not k.startswith("car:") and k not in skip]
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


# ---------- 拼车求解 ----------

@dataclass(frozen=True)
class Route:
    driver: str
    stops: tuple[str, ...]  # 途经的接人点 id
    minutes: float          # 全程分钟
    detour: float           # 比直达多出的分钟


@dataclass
class Plan:
    routes: list[Route]
    rides: dict[str, tuple[str, str]]  # 乘客 -> (车主, 上车点 id)
    taxi: dict[str, str]                # 没搭上车的乘客 -> 建议去打车的站点 id
    stranded: list[str]                 # 一个能去的站都没有的乘客
    detour: float
    cost: float

    @property
    def score(self) -> tuple:
        # 先让尽量多的人搭上车，再看总成本，最后少停车
        return (-len(self.rides), round(self.cost, 1), sum(len(r.stops) for r in self.routes))


def rider_options(p: Person, station_names: list[str], station_cost: float) -> dict[str, float]:
    """乘客能在哪些点上车，以及到该点的额外成本（分钟）。

    去车站上车意味着要先坐一趟高铁：优先用手填的 rail_min，其次用高德估算的 rail_est，
    都没有就按 station_cost 估。这样顺路的「到家附近接」会排在「坐高铁去站」前面。
    """
    if p.rail_min:
        opts = {f"st:{s}": m for s, m in p.rail_min.items() if s in station_names}
    else:
        allowed = station_names if p.stations is None else [s for s in p.stations if s in station_names]
        if p.rail_est:
            opts = {f"st:{s}": p.rail_est[s][0] for s in allowed if s in p.rail_est}
        else:
            opts = {f"st:{s}": station_cost for s in allowed}
    if p.pickup_at_home:
        opts[f"home:{p.name}"] = 0.0
    return opts


def leg_minutes(T, legs: list[str]) -> float:
    return sum(T.get(pair, INF) for pair in zip(legs, legs[1:]))


def car_routes(driver: Person, pickups: list[str], T, max_stops: int) -> list[Route]:
    start = f"car:{driver.name}"
    direct = T.get((start, "venue"), INF)
    if direct == INF:
        raise SystemExit(f"高德没算出 {driver.name} 到目的地的驾车路线，检查出发地是否写对")
    best: dict[frozenset, Route] = {}
    if driver.seats:
        for k in range(1, max_stops + 1):
            for seq in itertools.permutations(pickups, k):
                total = leg_minutes(T, [start, *seq, "venue"])
                detour = total - direct
                key = frozenset(seq)
                if detour <= driver.max_detour and (key not in best or detour < best[key].detour):
                    best[key] = Route(driver.name, seq, total, max(detour, 0.0))
    return [Route(driver.name, (), direct, 0.0), *sorted(best.values(), key=lambda r: r.detour)]


def assign(routes: tuple[Route, ...], seats: dict[str, int], riders: list[Person],
           opts: dict[str, dict[str, float]]) -> tuple[dict[str, tuple[str, str]], float]:
    """把乘客分到车上：先最大化上车人数，再最小化成本（最小费用最大流）。"""
    n_r = len(riders)
    sink = n_r + len(routes) + 1
    graph: list[list[list]] = [[] for _ in range(sink + 1)]  # [to, cap, cost, rev, stop]

    def add(u, v, cap, cost, stop=None):
        graph[u].append([v, cap, cost, len(graph[v]), stop])
        graph[v].append([u, 0, -cost, len(graph[u]) - 1, None])

    for i, p in enumerate(riders, 1):
        add(0, i, 1, 0.0)
        for j, r in enumerate(routes, n_r + 1):
            common = [(opts[p.name][s], s) for s in r.stops if s in opts[p.name]]
            if common:
                cost, stop = min(common)
                add(i, j, 1, cost, stop)
    for j, r in enumerate(routes, n_r + 1):
        add(j, sink, seats[r.driver], 0.0)

    total = 0.0
    while True:
        dist = [INF] * (sink + 1)
        prev: list[tuple[int, int] | None] = [None] * (sink + 1)
        dist[0] = 0.0
        for _ in range(sink + 1):  # Bellman-Ford，残量图里有负边
            changed = False
            for u, edges in enumerate(graph):
                if dist[u] == INF:
                    continue
                for k, (v, cap, cost, _, _) in enumerate(edges):
                    if cap > 0 and dist[u] + cost < dist[v] - 1e-9:
                        dist[v], prev[v], changed = dist[u] + cost, (u, k), True
            if not changed:
                break
        if dist[sink] == INF:
            break
        v = sink
        while v != 0:
            u, k = prev[v]
            e = graph[u][k]
            e[1] -= 1
            graph[v][e[3]][1] += 1
            v = u
        total += dist[sink]

    rides = {}
    for i, p in enumerate(riders, 1):
        for v, cap, _, _, stop in graph[i]:
            if stop is not None and cap == 0:
                rides[p.name] = (routes[v - n_r - 1].driver, stop)
    return rides, total


def evaluate(combo: tuple[Route, ...], drivers: list[Person], riders: list[Person],
             opts: dict[str, dict[str, float]], T) -> Plan | None:
    rides, ride_cost = assign(combo, {d.name: d.seats or 0 for d in drivers}, riders, opts)
    used = set(rides.values())
    if any((r.driver, s) not in used for r in combo for s in r.stops):
        return None  # 白停一站的方案一定不如少停这一站的方案
    taxi, stranded, taxi_cost = {}, [], 0.0
    for p in riders:
        if p.name in rides:
            continue
        cands = [(c + T.get((s, "venue"), INF), s) for s, c in opts[p.name].items() if s.startswith("st:")]
        best = min(cands, default=(INF, ""))
        if best[0] == INF:
            stranded.append(p.name)
        else:
            taxi[p.name] = best[1]
            taxi_cost += best[0]
    detour = sum(r.detour for r in combo)
    return Plan(list(combo), rides, taxi, stranded, detour, detour + ride_cost + taxi_cost)


def solve(trip: Trip, T, top: int = 3) -> list[Plan]:
    report("比较各种接人组合")
    drivers = [p for p in trip.people if p.drives]
    riders = [p for p in trip.people if not p.drives]
    names = [s.name for s in trip.stations]
    opts = {p.name: rider_options(p, names, trip.station_cost) for p in riders}
    pickups = sorted({s for o in opts.values() for s in o})
    keep = max(1, int(COMBO_LIMIT ** (1 / max(len(drivers), 1))) - 1)
    per_car = [car_routes(d, pickups, T, trip.max_stops)[:keep + 1] for d in drivers]
    plans = [pl for combo in itertools.product(*per_car)
             if (pl := evaluate(combo, drivers, riders, opts, T))]
    return sorted(plans, key=lambda pl: pl.score)[:top]


# ---------- 报告 ----------

def fmt_min(m: float) -> str:
    if m == INF:
        return "无法到达"
    m = round(m)
    return f"{m // 60}小时{m % 60:02d}分" if m >= 60 else f"{m}分钟"


def marker_url(p: Place) -> str:
    q = urllib.parse.urlencode({"position": p.loc, "name": p.name, "src": "wedding-carpool",
                                "coordinate": "gaode", "callnative": 1}, safe=",")
    return f"https://uri.amap.com/marker?{q}"


def nav_url(a: Place, b: Place, via: Place | None = None) -> str:
    params = {"from": f"{a.loc},{a.name}", "to": f"{b.loc},{b.name}"}
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


def arrival_at(person: Person, stop: str) -> float | None:
    """乘客坐的车到这个站的时刻（车次说明里最后一个时间）。"""
    times = train_times(person.trains.get(stop[3:], "")) if stop.startswith("st:") else []
    return times[-1] if times else None


def pickup_ready(plan: Plan, trip: Trip) -> dict[tuple[str, str], float]:
    """(车主, 接人点) → 乘客都能上车的时刻：最晚到站的那位到站后再加出站时间。"""
    people = {p.name: p for p in trip.people}
    ready: dict[tuple[str, str], float] = {}
    for name, (driver, stop) in plan.rides.items():
        arr = arrival_at(people[name], stop)
        if arr is not None:
            ready[(driver, stop)] = max(ready.get((driver, stop), -INF), arr + trip.exit_buffer)
    return ready


def route_schedule(route: Route, ready: dict[tuple[str, str], float], T) -> dict | None:
    """按接人点的上车时刻倒推车主几点出发，再正推各点时刻；不知道车次时刻就返回 None。"""
    legs = [f"car:{route.driver}", *route.stops, "venue"]
    need = {s: ready[(route.driver, s)] for s in route.stops if (route.driver, s) in ready}
    if not need:
        return None
    elapsed, cum = 0.0, {}
    for a, b in zip(legs, legs[1:]):
        elapsed += T.get((a, b), INF)
        cum[b] = elapsed
    t = depart = max(need[s] - cum[s] for s in need)
    times = {}
    for a, b in zip(legs, legs[1:]):
        t = max(t + T.get((a, b), INF), need.get(b, -INF))  # 早到了就在接人点等
        times[b] = t
    return {"depart": depart, "times": times}


def taxi_schedule(plan: Plan, trip: Trip, T) -> dict[str, dict]:
    """打车组：站点 → 汇合时刻（最晚到站的人出站后）和到目的地时刻。"""
    people = {p.name: p for p in trip.people}
    out: dict[str, dict] = {}
    for name, stop in plan.taxi.items():
        group = out.setdefault(stop, {"names": [], "ready": None})
        group["names"].append(name)
        arr = arrival_at(people[name], stop)
        if arr is not None:
            group["ready"] = max(group["ready"] or -INF, arr + trip.exit_buffer)
    for stop, group in out.items():
        group["arrive"] = None if group["ready"] is None else group["ready"] + T.get((stop, "venue"), INF)
    return out


def describe(plan: Plan, pts: dict[str, Place], T, trip: Trip) -> list[str]:
    seats = {p.name: p.seats for p in trip.people if p.drives}
    ready = pickup_ready(plan, trip)
    lines = []
    for r in plan.routes:
        if not r.stops:
            lines.append(f"- **{r.driver}**（空 {seats[r.driver]} 座）：直接开到目的地，"
                         f"约 {fmt_min(r.minutes)}，不接人。")
            continue
        sched = route_schedule(r, ready, T)
        legs = []
        for s in r.stops:
            who = "、".join(n for n, (d, st) in plan.rides.items() if d == r.driver and st == s)
            at = f" {clock(sched['times'][s])}" if sched else ""
            legs.append(f"{stop_label(s, pts)}{at}（接 {who}）")
        if sched:
            timing = (f"建议 **{clock(sched['depart'])} 出发** → {' → '.join(legs)} → "
                      f"约 {clock(sched['times']['venue'])} 到目的地；")
        else:
            first = T.get((f"car:{r.driver}", r.stops[0]), INF)
            timing = f"出发 → {' → '.join(legs)} → 目的地；出发后约 {fmt_min(first)} 到第一个接人点；"
        lines.append(f"- **{r.driver}**（空 {seats[r.driver]} 座）：{timing}"
                     f"全程约 {fmt_min(r.minutes)}，比直达多绕 **{fmt_min(r.detour)}**。{route_links(r, pts)}")
    for s, group in taxi_schedule(plan, trip, T).items():
        timing = (f"约 {clock(group['ready'])} 在站汇合，{clock(group['arrive'])} 左右到目的地"
                  if group["ready"] is not None else f"车程约 {fmt_min(T.get((s, 'venue'), INF))}")
        lines.append(f"- **打车/包车组**：{'、'.join(group['names'])} 坐高铁到 **{pts[s].name}**，"
                     f"一起打车到目的地，{timing}。[导航]({nav_url(pts[s], pts['venue'])})")
    for name in plan.stranded:
        lines.append(f"- **{name}**：没有可用的候选站，需要单独安排。")
    return lines


def station_table(trip: Trip, pts: dict[str, Place], T) -> list[str]:
    drivers = [p for p in trip.people if p.drives]
    rows = []
    for s in trip.stations:
        sid = f"st:{s.name}"
        cells, ok = [], []
        for d in drivers:
            start = f"car:{d.name}"
            detour = leg_minutes(T, [start, sid, "venue"]) - T.get((start, "venue"), INF)
            fits = detour <= d.max_detour
            cells.append(("✅ " if fits else "") + fmt_min(max(detour, 0.0)))
            if fits:
                ok.append(detour)
        rows.append(((-len(ok), min(ok, default=INF), T.get((sid, "venue"), INF)),
                     [s.name, fmt_min(T.get((sid, "venue"), INF)), *cells]))
    rows.sort(key=lambda r: r[0])
    head = ["候选站", "站→目的地车程", *[f"{d.name}绕路" for d in drivers]]
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
            "括号里是配置里填的车次（标「手填」的只填了分钟数）；其余按 "
            f"{trip.travel_date} {trip.travel_time} 出发，用高德公共交通最快方案估算。"
            "高德跨城只给直达火车，不含火车换乘和刚开通的线路，估算可能偏差很大，请用 12306 核对。",
            "", *lines, ""]


def render(trip: Trip, pts: dict[str, Place], T, plans: list[Plan]) -> str:
    L = [f"# 拼车方案：{trip.venue.name}", ""]
    if trip.warnings:
        L += ["> ⚠️ " + w for w in trip.warnings] + [""]
    if not plans:
        L += ["没有找到可行方案。", ""]
    else:
        best = plans[0]
        used = {s for r in best.routes for s in r.stops if s.startswith("st:")} | set(best.taxi.values())
        riders = [p for p in trip.people if not p.drives]
        L += ["## 结论", "",
              f"- 不开车的 {len(riders)} 人里，**{len(best.rides)} 人能搭上顺风车**，"
              f"车主合计多绕 {fmt_min(best.detour)}。",
              f"- 建议坐到的站：**{'、'.join(pts[s].name for s in sorted(used)) or '不需要坐到站'}**。",
              "", "## 推荐方案", "", *describe(best, pts, T, trip), ""]
        for i, pl in enumerate(plans[1:], 2):
            L += [f"## 备选方案 {i}（{len(pl.rides)} 人搭车，车主合计多绕 {fmt_min(pl.detour)}）", "",
                  *describe(pl, pts, T, trip), ""]
    L += ["## 候选站对比", "",
          "每个车主「只在这个站停一次」时比直达多绕多久；✅ 表示在他能接受的绕路范围内。", "",
          *station_table(trip, pts, T), "", *rail_section(trip)]
    if trip.discovered:
        L += ["> 候选站是自动搜出来的（含普速站）。确认后把需要的站写进配置的 `[[stations]]`，"
              "可以去掉没有高铁的站、补上漏掉的站。", ""]
    L += ["## 地点核对与高德链接", "", "先确认「解析结果」对得上，链接可直接发群里，手机点开会跳到高德。", "",
          "| 地点 | 解析结果 | 链接 |", "|---|---|---|"]
    L += [f"| {p.name} | {p.note} | [打开]({marker_url(p)}) |" for p in pts.values()]
    L += ["", "## 说明", "",
          "- 时间来自高德驾车测距，接近查询时的路况，当天可能有出入；车次和到站时间请在 12306 核对。",
          "- 不开车的人到各站的用时：优先用配置里手填的 `rail_min`，否则用高德公共交通估算；"
          "估算不准或想排除某些站时，给他填 `stations` 或 `rail_min`。",
          "- 方案排序：先让尽量多的人搭上车，再比「车主绕路 + 乘客坐高铁 + 打车组车程」的总分钟数。",
          "- 高铁站一般要到停车场或网约车上车点接人，约定时说到具体停车场和区域。"]
    return "\n".join(L) + "\n"


def plan_trip(cfg: dict, amap) -> tuple[Trip, dict[str, Place], dict, list[Plan]]:
    trip = load_trip(cfg, amap)
    pts = points_of(trip)
    skip = {f"home:{p.name}" for p in trip.people if not p.drives and not p.pickup_at_home}
    T = build_matrix(amap, pts, skip)
    estimate_rail(amap, trip)
    return trip, pts, T, solve(trip, T)


def run(cfg: dict, amap) -> str:
    return render(*plan_trip(cfg, amap))


# ---------- 配置读写 ----------

def default_key() -> str | None:
    if os.environ.get("AMAP_KEY"):
        return os.environ["AMAP_KEY"]
    path = Path(__file__).with_name(".amap_key")
    return path.read_text(encoding="utf-8").strip() if path.exists() else None


def _toml_key(k: str) -> str:
    return k if re.fullmatch(r"[A-Za-z0-9_-]+", k) else json.dumps(k, ensure_ascii=False)


def _toml_value(v) -> str:
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return repr(v)
    if isinstance(v, str):
        return json.dumps(v, ensure_ascii=False)  # JSON 字符串转义是 TOML 基本字符串的子集
    if isinstance(v, (dt.date, dt.time)):
        return v.isoformat()
    if isinstance(v, list):
        return "[" + ", ".join(_toml_value(x) for x in v) + "]"
    if isinstance(v, dict):
        return "{ " + ", ".join(f"{_toml_key(k)} = {_toml_value(x)}" for k, x in v.items()) + " }"
    raise TypeError(f"无法写入 TOML：{v!r}")


def dump_toml(cfg: dict, header: str = "") -> str:
    """把配置写回 TOML（只支持本工具用到的结构）。空值不写。"""
    def body(table: dict) -> list[str]:
        return [f"{_toml_key(k)} = {_toml_value(v)}" for k, v in table.items()
                if v is not None and v != "" and v != [] and v != {}]

    out = [header] if header else []
    for name in ("venue", "options"):
        if cfg.get(name):
            out += [f"[{name}]", *body(cfg[name]), ""]
    for name in ("stations", "people"):
        for item in cfg.get(name) or []:
            out += [f"[[{name}]]", *body(item), ""]
    return "\n".join(out)


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
