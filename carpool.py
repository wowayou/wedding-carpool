#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
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
STATION_KEYWORD = "火车站"  # 周边搜索要同时带上：只靠 types 会连同候车室、进站口等子类一起返回
PAGE_SIZE = 25  # 周边搜索一页最多条数
# 火车站 POI 里混着出入口、售票处、停车场等子点，按名字剔除
STATION_NOISE = ("-", "(", "（", "进站", "出站", "售票", "停车", "候车", "货运", "派出所",
                 "广场", "通道", "上车点", "下车点")
# 网络层的偶发错误（连接被重置、超时、返回半截）重试即可
TRANSIENT_ERRORS = (urllib.error.URLError, ConnectionError, TimeoutError, http.client.HTTPException, ValueError)
RETRIES = 3
COMBO_LIMIT = 30_000  # 车主路线组合的枚举上限，车多时自动收紧每辆车保留的候选路线
TAXI_COMBO_LIMIT = 20_000  # 打车选站组合的穷举上限，超过就用贪心
CAR_SEATS = 4  # 一辆出租最多坐几个人
INF = math.inf

# 计算规则的版本：只有排序规则或成本口径变了才加一；改界面、改文字不加。说明见 /guide/method
RULES_VERSION = 2
# 配置项只在 config-fields.json 里定义一处（路径、类型、默认值、范围、单位、中文名……）。
# 网页版把这个文件和 .py 一起加载（见 web/pyworker.js）；编辑页、规则页的测试读的也是它
FIELDS_FILE = Path(__file__).with_name("config-fields.json")


def load_fields(path: Path = FIELDS_FILE) -> dict[str, dict]:
    """读配置项定义，返回 {路径: 定义}，路径如 options.max_detour_min、people[].max_detour_min。"""
    fields = json.loads(Path(path).read_text(encoding="utf-8"))["fields"]
    return {f["path"]: f for f in fields}


def defaults_from(fields: dict[str, dict]) -> dict:
    """规则页默认值表里的那些项（rules_table）：{配置里的键: 默认值}，键取路径的最后一段。"""
    return {f["path"].rsplit(".", 1)[-1]: f["default"] for f in fields.values() if f.get("rules_table")}


FIELDS = load_fields()
# 配置里没写时的默认值，由 FIELDS 生成；说明页的默认值表会和它核对（test_carpool.py）
DEFAULTS = defaults_from(FIELDS)


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
QUOTA_INFOS = ("DAILY_QUERY_OVER_LIMIT", "QUOTA_PLAN_RUN_OUT", "SERVICE_EXPIRED", "TRIP_DAILY_LIMIT", "OWNER_DAILY_LIMIT",
               "INVITE_DISABLED", "OWNER_RESERVED",  # 邀请码停用、公共额度留给已在算的行程
               "PUBLIC_PAUSED", "TRIP_BLOCKED", "MONTHLY_BUDGET")  # 站长暂停了公共额度、停用了这个行程的公共额度、站点本月预算用完


def check_quota(info: str, detail: str = "") -> None:
    if any(q in info for q in QUOTA_INFOS):
        raise QuotaError(detail or (f"高德配额已用完（{info}），已停止计算，没有继续调用。"
                                    "额度一般次日恢复，月配额要等下个月；要买额度会产生费用，请自己在高德控制台决定"))


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

    def around_query(self, center: Place, radius_km: float, page: int = 1) -> tuple[str, dict]:
        # types 照旧 150200，再加 keywords：否则大站的候车室、进站口等子点会占满一页（实测，见 docs/v3.8-plan.md 第四节）
        params = {"location": center.loc, "types": STATION_TYPE, "keywords": STATION_KEYWORD, "sortrule": "distance",
                  "radius": min(int(radius_km * 1000), 50000), "page_size": PAGE_SIZE}
        if page > 1:
            params["page_num"] = page
        return "/v5/place/around", params

    def stations_around(self, center: Place, radius_km: float, page: int = 1) -> list[dict]:
        """一个点周围的火车站 POI（一页，按距离排序）；page 从 1 开始。"""
        path, params = self.around_query(center, radius_km, page)
        return self._get(path, **params).get("pois") or []

    def driving_query(self, places: list[Place], strategy: int | None = None) -> tuple[str, dict]:
        params = {"origin": places[0].loc, "destination": places[-1].loc, "extensions": "base"}
        if len(places) > 2:
            params["waypoints"] = ";".join(p.loc for p in places[1:-1])
        if strategy:  # 不写就是高德默认（0）
            params["strategy"] = strategy
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

    def drive_routes(self, places: list[Place], strategy: int = 0, alt: bool = False,
                     max_points: int = 600) -> list[dict]:
        """驾车路线 [{"path": [[lat, lng], ...], "km": 里程, "minutes": 用时}, ...]。不开 alt 只取第一条；
        开了 alt 时，策略 0 改用 10（高德 strategy 10 到 20 返回最多 3 条路线），其余策略本身就是多路线。"""
        api, params = self.driving_query(places, route_strategy(strategy, alt))
        paths = self._get(api, **params)["route"]["paths"][:3 if alt else 1]
        out = []
        for path in paths:
            pts = [[float(y), float(x)] for step in path["steps"]
                   for x, y in (pair.split(",") for pair in step["polyline"].split(";"))]
            stride = max(1, len(pts) // max_points)
            out.append({"path": pts[::stride] + ([pts[-1]] if pts and (len(pts) - 1) % stride else []),
                        "km": float(path["distance"]) / 1000,
                        "minutes": float(path["duration"]) / 60 if str(path.get("duration", "")).isdigit() else None})
        return out

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
        pois = self._get("/v5/place/around", location=center.loc, types=STATION_TYPE, keywords=STATION_KEYWORD,
                         radius=min(int(radius_km * 1000), 50000), sortrule="distance",
                         page_size=25).get("pois") or []
        dlat = radius_km / 111.0
        dlng = radius_km / (111.0 * math.cos(math.radians(center.lat)))
        polygon = (f"{center.lng - dlng:.6f},{center.lat + dlat:.6f}|"
                   f"{center.lng + dlng:.6f},{center.lat - dlat:.6f}")
        for page in range(1, max_pages + 1):
            batch = self._get("/v5/place/polygon", polygon=polygon, types=STATION_TYPE, keywords=STATION_KEYWORD,
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


def route_strategy(strategy: int, alt: bool) -> int:
    """实际传给高德驾车接口的 strategy：开备选路线且是默认策略 0 时改用 10。"""
    return 10 if alt and not strategy else strategy


def reject_reason(poi: dict) -> str | None:
    """这个 POI 不是客运火车站的原因；None 表示可以留下。"""
    name = poi.get("name") or ""
    if m := re.search(r"[(（]([^)）]*)", name):
        return f"站名带标注「{m.group(1)}」"
    for noise in STATION_NOISE:
        if noise in name:
            return f"站名里有「{noise}」，不是客运站点"
    if not name.endswith("站"):
        return "名字不像火车站"
    if poi.get("typecode") and not str(poi["typecode"]).startswith("1502"):
        return "类型不是火车站"
    return None


def pick_stations(pois: list[dict], venue: Place, radius_km: float, limit: int) -> list[Place]:
    seen: set[str] = set()
    out = []
    for poi in pois:
        name = poi.get("name") or ""
        if name in seen or reject_reason(poi):
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


# ---------- 拼车求解 ----------

@dataclass(frozen=True)
class Route:
    driver: str
    stops: tuple[str, ...]  # 途经的接人点 id
    minutes: float          # 全程分钟
    detour: float           # 比直达多出的分钟


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


@dataclass
class Plan:
    routes: list[Route]
    rides: dict[str, tuple[str, str]]  # 乘客 -> (车主, 上/下车点 id)
    taxi: dict[str, str]                # 没搭上车的乘客 -> 建议打车的站点 id
    stranded: list[str]                 # 一个能去的站都没有（或返程赶不上车）的乘客
    detour: float
    cost: float                         # = detour + rider_min + taxi_min，排序用
    carried: int = 0                    # 搭上车的人数（按同行人数算）
    rider_min: float = 0.0              # 搭上车的乘客到上车点的用时合计
    taxi_min: float = 0.0               # 打车组到站用时，加上站到目的地的车程，合计
    taxi_cars: int = 0                  # 打车要几辆车
    taxi_ride: float = 0.0              # 车数 × 车程分钟数，只用来粗估打车费，不参与排序

    @property
    def score(self) -> tuple:
        # 先让尽量多的人搭上车，再看总成本，最后少停车
        return (-self.carried, round(self.cost, 1), sum(len(r.stops) for r in self.routes))


def rider_options(p: Person, station_names: list[str], station_cost: float, leg: Leg = OUT) -> dict[str, float]:
    """乘客能在哪些点上（下）车，以及到该点的额外成本（分钟）。

    去车站上车意味着要先坐一趟高铁：优先用手填的 rail_min，其次用高德估算的 rail_est，
    都没有就按 station_cost 估。这样顺路的「到家附近接」会排在「坐高铁去站」前面。返程同理，用返程的车次。
    """
    if leg.reverse:
        known = p.back_rail_min
        opts = ({f"st:{s}": m for s, m in known.items() if s in station_names} if known
                else {f"st:{s}": station_cost for s in (station_names if p.stations is None else
                                                        [x for x in p.stations if x in station_names])})
        if p.pickup_at_home:
            opts[f"home:{p.name}"] = 0.0
        return opts
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


def car_routes(driver: Person, pickups: list[str], T, max_stops: int, leg: Leg = OUT) -> list[Route]:
    start, end = leg.ends(driver.name)
    direct = T.get((start, end), INF)
    if direct == INF:
        raise SystemExit(f"高德没算出 {driver.name} 的{leg.title}驾车路线，检查出发地是否写对")
    best: dict[frozenset, Route] = {}
    limit = driver.max_detour if not leg.reverse or driver.back_max_detour is None else driver.back_max_detour
    if driver.seats and (not leg.reverse or driver.back_drives):
        for k in range(1, max_stops + 1):
            for seq in itertools.permutations(pickups, k):
                total = leg_minutes(T, [start, *seq, end])
                detour = total - direct
                key = frozenset(seq)
                if detour <= limit and (key not in best or detour < best[key].detour):
                    best[key] = Route(driver.name, seq, total, max(detour, 0.0))
    return [Route(driver.name, (), direct, 0.0), *sorted(best.values(), key=lambda r: r.detour)]


def back_deadline(p: Person, stop: str, leg: Leg) -> float | None:
    """返程：乘客在这个站最晚几点要到（发车时刻减去提前量）；不知道车次就没有限制。"""
    times = train_times(p.back_trains.get(stop[3:], "")) if stop.startswith("st:") else []
    return times[0] - leg.margin if times else None


def leave_of(p: Person, leg: Leg) -> float:
    """返程：这个人几点离开目的地。车主的离场时间就是车的出发时间。"""
    return p.leave if p.leave is not None else leg.depart or 0.0


def stop_times(route: Route, T, leg: Leg, depart: float | None = None) -> dict[str, float]:
    """返程：车主从 depart（默认散场时间）出发，依次到各送人点的时刻。"""
    t, out = leg.depart or 0.0 if depart is None else depart, {}
    seq = leg.sequence(route.driver, route.stops)
    for a, b in zip(seq, seq[1:]):
        t += T.get((a, b), INF)
        out[b] = t
    return out


def assign(routes: tuple[Route, ...], seats: dict[str, int], riders: list[Person],
           opts: dict[str, dict[str, float]], allowed=None) -> tuple[dict[str, tuple[str, str]], float]:
    """把乘客分到车上：先最大化上车人数，再最小化成本。
    allowed(route, stop, rider) 用来排除不可行的上下车点（返程赶不上车次）。
    每组都是一个人时用最小费用最大流；有多人同行时整组不能拆开，改为穷举。"""
    usable = lambda r, s, p: s in opts[p.name] and (allowed is None or allowed(r, s, p))  # noqa: E731
    if any(p.party > 1 for p in riders):
        return _assign_groups(routes, seats, riders, opts, usable)
    n_r = len(riders)
    sink = n_r + len(routes) + 1
    graph: list[list[list]] = [[] for _ in range(sink + 1)]  # [to, cap, cost, rev, stop]

    def add(u, v, cap, cost, stop=None):
        graph[u].append([v, cap, cost, len(graph[v]), stop])
        graph[v].append([u, 0, -cost, len(graph[u]) - 1, None])

    for i, p in enumerate(riders, 1):
        add(0, i, 1, 0.0)
        for j, r in enumerate(routes, n_r + 1):
            common = [(opts[p.name][s], s) for s in r.stops if usable(r, s, p)]
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


def _assign_groups(routes, seats, riders, opts, usable) -> tuple[dict[str, tuple[str, str]], float]:
    """有多人同行时：每组整体上一辆车，穷举所有分法，先多拉人，再少成本。"""
    order = sorted(riders, key=lambda p: -p.party)
    choices = [[(j, s, opts[p.name][s]) for j, r in enumerate(routes) for s in r.stops if usable(r, s, p)] for p in order]
    rest = [sum(p.party for p in order[i:]) for i in range(len(order) + 1)]
    cap = [seats[r.driver] for r in routes]
    best = {"key": (-1, 0.0), "rides": {}, "cost": 0.0}
    chosen: dict[str, tuple[str, str]] = {}

    def dfs(i: int, carried: int, cost: float) -> None:
        if (carried + rest[i], -cost) <= best["key"]:
            return  # 剩下的全上车也比不过已有的最好分法
        if i == len(order):
            best.update(key=(carried, -cost), rides=dict(chosen), cost=cost)
            return
        p = order[i]
        for j, stop, c in sorted(choices[i], key=lambda x: x[2]):
            if cap[j] >= p.party:
                cap[j] -= p.party
                chosen[p.name] = (routes[j].driver, stop)
                dfs(i + 1, carried + p.party, cost + c)
                del chosen[p.name]
                cap[j] += p.party
        dfs(i + 1, carried, cost)

    dfs(0, 0, 0.0)
    return best["rides"], best["cost"]


# ---------- 打车安排 ----------

@dataclass
class Arrangement:
    """没搭上车的这群人怎么打车。"""
    taxi: dict[str, str]    # 人 -> 去哪个站
    stranded: list[str]     # 一个能去的站都没有（或返程赶不上）的人
    minutes: float          # 每人（同行的一组算一份）到站用时加站到目的地车程，合计
    cars: int               # 要几辆车
    ride: float             # 车数 × 车程分钟数，打车费按它粗估


def taxi_slot(p: Person, stop: str, T, leg: Leg, exit_buffer: float) -> tuple[float | None, float, float]:
    """这个人去这个站打车：(能上车/出发的时刻, 最晚能走的时刻, 站和目的地之间的车程)。
    去程：到站后加出站时间才能上车，没填车次就不知道时刻（None，当作可以和任何人拼）。
    返程：从自己的离场时间走，要赶在发车前 N 分钟到站，所以出发不能晚于「发车前提前量 − 车程」。"""
    ride = leg.station_to_venue(T, stop)
    if leg.reverse:
        deadline = back_deadline(p, stop, leg)
        return leave_of(p, leg), INF if deadline is None else deadline - ride, ride
    arr = arrival_at(p, stop)
    return None if arr is None else arr + exit_buffer, INF, ride


def pack_cars(members: list[tuple], wait: float) -> list[dict]:
    """同一个站的人分成几辆车。members = [(名字, 同行人数, 时刻或 None, 最晚出发时刻)]。
    按时刻排好，时刻相差不超过 wait 的才拼一辆；一辆最多 CAR_SEATS 人，同行的一组不拆开；
    不知道时刻的人当作可以和任何人拼，先填满已有的车，坐不下再另开一辆。"""
    cars: list[dict] = []
    known = sorted((m for m in members if m[2] is not None), key=lambda m: (m[2], m[0]))
    for name, party, t, latest in known:
        for car in cars:
            if car["n"] + party <= CAR_SEATS and t - car["start"] <= wait and t <= car["latest"] and t <= latest:
                car["names"].append(name)
                car["n"] += party
                car["t"], car["latest"] = t, min(car["latest"], latest)
                break
        else:
            cars.append({"names": [name], "n": party, "start": t, "t": t, "latest": latest, "unknown": []})
    for name, party, t, latest in (m for m in members if m[2] is None):
        for car in cars:
            if car["n"] + party <= CAR_SEATS:
                car["names"].append(name)
                car["unknown"].append(name)
                car["n"] += party
                break
        else:
            cars.append({"names": [name], "n": party, "start": None, "t": None, "latest": INF, "unknown": [name]})
    return cars


def taxi_cars(assigned: dict[str, str], people: dict[str, Person], T, leg: Leg, trip: Trip) -> list[dict]:
    """每辆出租：站点、同车的人、出发（汇合）时刻、车程。报告和方案页用，和选站时的分车规则一样。"""
    by_stop: dict[str, list[tuple]] = {}
    for name, stop in assigned.items():
        t, latest, _ = taxi_slot(people[name], stop, T, leg, trip.exit_buffer)
        by_stop.setdefault(stop, []).append((name, people[name].party, t, latest))
    out = []
    for stop, members in by_stop.items():
        ride = leg.station_to_venue(T, stop)
        for car in pack_cars(members, trip.taxi_wait):
            out.append({"stop": stop, "names": car["names"], "n": car["n"], "time": car["t"], "unknown": car["unknown"], "ride": ride})
    return out


class TaxiPool:
    """没搭上车的人怎么打车。结果只取决于「哪些人没搭上车」，所以按人群缓存：同一群人整个求解只算一次。

    taxi_mode = "fast"：每人走自己最快的站，只按时间切分来分车、估打车费。
    taxi_mode = "save"：在每人最多比自己最快的走法多花 taxi_pool_extra_min 分钟的前提下，
    先让打车费（车数 × 车程）最少，再让总分钟最少。组合数不超过 TAXI_COMBO_LIMIT 时穷举，超过时用贪心。"""

    def __init__(self, trip: Trip, riders: list[Person], opts: dict[str, dict[str, float]], T, leg: Leg):
        self.trip, self.T, self.leg = trip, T, leg
        self.order = [p.name for p in riders]
        self.cands: dict[str, list[tuple]] = {}
        for p in riders:  # (到站再打车的总分钟, 站, 时刻, 最晚时刻, 车程)，最快的排前面；同样快的按站名
            found = []
            for s, c in opts[p.name].items():
                if not s.startswith("st:"):
                    continue
                t, latest, ride = taxi_slot(p, s, T, leg, trip.exit_buffer)
                if ride != INF and (t is None or t <= latest):
                    found.append((c + ride, s, t, latest, ride))
            self.cands[p.name] = sorted(found, key=lambda x: (x[0], x[1]))
        self.party = {p.name: p.party for p in riders}
        self.cache: dict[frozenset, Arrangement] = {}

    def arrange(self, left: frozenset) -> Arrangement:
        got = self.cache.get(left)
        if got is None:
            got = self.cache[left] = self._arrange([n for n in self.order if n in left])
        return got

    def _arrange(self, names: list[str]) -> Arrangement:
        stranded = [n for n in names if not self.cands[n]]
        members = [n for n in names if self.cands[n]]
        pick = {n: self.cands[n][0] for n in members}
        if self.trip.taxi_mode == "save" and len(members) > 1:
            pick = self._save(members, pick)
        cars, ride = self._cars(pick)
        return Arrangement({n: pick[n][1] for n in members}, stranded, sum(c[0] for c in pick.values()), cars, ride)

    def _cars(self, pick: dict[str, tuple]) -> tuple[int, float]:
        by_stop: dict[str, list[tuple]] = {}
        for n, c in pick.items():
            by_stop.setdefault(c[1], []).append((n, self.party[n], c[2], c[3]))
        cars, ride = 0, 0.0
        for members in by_stop.values():
            k = sum((car["n"] + CAR_SEATS - 1) // CAR_SEATS for car in pack_cars(members, self.trip.taxi_wait))
            cars += k
            ride += k * pick[members[0][0]][4]
        return cars, ride

    def _measure(self, pick: dict[str, tuple]) -> tuple[float, float]:
        return round(self._cars(pick)[1], 6), round(sum(c[0] for c in pick.values()), 6)

    def _save(self, members: list[str], fast: dict[str, tuple]) -> dict[str, tuple]:
        extra = self.trip.taxi_extra
        pools = [[c for c in self.cands[n] if c[0] <= self.cands[n][0][0] + extra] for n in members]
        if all(len(pool) == 1 for pool in pools):
            return fast
        if math.prod(len(pool) for pool in pools) > TAXI_COMBO_LIMIT:
            return self._greedy(members, pools, fast)
        best, best_pick = self._measure(fast), fast
        for combo in itertools.product(*pools):  # 第一个就是各走最快的站，同样好时保持它
            pick = dict(zip(members, combo))
            if (m := self._measure(pick)) < best:
                best, best_pick = m, pick
        return best_pick

    def _greedy(self, members: list[str], pools: list[list[tuple]], fast: dict[str, tuple]) -> dict[str, tuple]:
        """组合太多：先各走最快的站，再把人挪到已经有人去的站，只要没超过多花上限、能省钱就挪，直到挪不动。"""
        cur, best = dict(fast), self._measure(fast)
        for _ in range(3 * len(members) + 3):
            used = {c[1] for c in cur.values()}
            move = None
            for n, pool in zip(members, pools):
                for c in pool:
                    if c[1] == cur[n][1] or c[1] not in used:
                        continue
                    m = self._measure({**cur, n: c})
                    if m < (move[0] if move else best):
                        move = (m, n, c)
            if move is None:
                break
            best, n, c = move
            cur[n] = c
        return cur


def evaluate(combo: tuple[Route, ...], drivers: list[Person], riders: list[Person],
             opts: dict[str, dict[str, float]], T, leg: Leg, pool: TaxiPool) -> Plan | None:
    allowed = None
    if leg.reverse:  # 返程：车主几点走车就几点走；乘客准备好后最多等 max_wait，送到站的时刻要赶得上车次
        leaves = {d.name: leave_of(d, leg) for d in drivers}
        times = {r.driver: stop_times(r, T, leg, leaves[r.driver]) for r in combo}

        def allowed(route: Route, stop: str, p: Person) -> bool:
            if not 0 <= leaves[route.driver] - leave_of(p, leg) <= leg.max_wait:
                return False
            deadline = back_deadline(p, stop, leg)
            return deadline is None or times[route.driver][stop] <= deadline
    rides, ride_cost = assign(combo, {d.name: d.seats or 0 for d in drivers}, riders, opts, allowed)
    used = set(rides.values())
    if any((r.driver, s) not in used for r in combo for s in r.stops):
        return None  # 白停一站的方案一定不如少停这一站的方案
    left = pool.arrange(frozenset(p.name for p in riders if p.name not in rides))  # 没搭上车的人另外安排打车
    detour = sum(r.detour for r in combo)
    carried = sum(p.party for p in riders if p.name in rides)
    return Plan(list(combo), rides, dict(left.taxi), list(left.stranded), detour, detour + ride_cost + left.minutes, carried,
                ride_cost, left.minutes, left.cars, left.ride)


def solve(trip: Trip, T, top: int = 3, leg: Leg = OUT) -> list[Plan]:
    report(f"比较各种{'送人' if leg.reverse else '接人'}组合")
    drivers = [p for p in trip.people if p.drives]
    riders = [p for p in trip.people if not p.drives]
    names = [s.name for s in trip.stations]
    opts = {p.name: rider_options(p, names, trip.station_cost, leg) for p in riders}
    pickups = sorted({s for o in opts.values() for s in o})
    keep = max(1, int(COMBO_LIMIT ** (1 / max(len(drivers), 1))) - 1)
    per_car = [car_routes(d, pickups, T, trip.max_stops, leg)[:keep + 1] for d in drivers]
    pool = TaxiPool(trip, riders, opts, T, leg)
    plans = [pl for combo in itertools.product(*per_car)
             if (pl := evaluate(combo, drivers, riders, opts, T, leg, pool))]
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
            names = who([n for n, (d, st) in plan.rides.items() if d == r.driver and st == s], trip)
            at = f" {clock(sched['times'][s])}" if sched else ""
            legs.append(f"{stop_label(s, pts)}{at}（接 {names}）")
        if sched:
            timing = (f"建议 **{clock(sched['depart'])} 出发** → {' → '.join(legs)} → "
                      f"约 {clock(sched['times']['venue'])} 到目的地；")
        else:
            first = T.get((f"car:{r.driver}", r.stops[0]), INF)
            timing = f"出发 → {' → '.join(legs)} → 目的地；出发后约 {fmt_min(first)} 到第一个接人点；"
        lines.append(f"- **{r.driver}**（空 {seats[r.driver]} 座）：{timing}"
                     f"全程约 {fmt_min(r.minutes)}，比直达多绕 **{fmt_min(r.detour)}**。{route_links(r, pts)}")
    for car in taxi_cars(plan.taxi, {p.name: p for p in trip.people}, T, OUT, trip):
        s, ride, ready = car["stop"], car["ride"], car["time"]
        timing = (f"约 {clock(ready)} 在站汇合，{clock(ready + ride)} 左右到目的地" if ready is not None else f"车程约 {fmt_min(ride)}")
        if car["unknown"] and ready is not None:
            timing += f"（{who(car['unknown'], trip)}没填车次，按同一时间算）"
        lines.append(f"- **打车/包车组**：{who(car['names'], trip)} 坐高铁到 **{pts[s].name}**，"
                     f"一起打车到目的地，{timing}{taxi_fare(ride, car['n'])}。[导航]({nav_url(pts[s], pts['venue'])})")
    for name in plan.stranded:
        lines.append(f"- **{name}**：没有可用的候选站，需要单独安排。")
    return lines


def describe_back(plan: Plan, pts: dict[str, Place], T, trip: Trip) -> list[str]:
    """返程（插件）：车主几点从目的地出发、几点送到哪、几点到家；乘客等多久；打车组几点出发赶哪趟车。"""
    leg = trip.back
    seats = {p.name: p.seats for p in trip.people if p.drives}
    people = {p.name: p for p in trip.people}
    lines = []
    for r in plan.routes:
        home = f"car:{r.driver}"
        depart = leave_of(people[r.driver], leg)
        if not r.stops:
            lines.append(f"- **{r.driver}**：{clock(depart)} 从目的地直接回家，约 {fmt_min(r.minutes)}，不送人。")
            continue
        times = stop_times(r, T, leg, depart)
        legs = []
        for s in r.stops:
            names = [n for n, (d, st) in plan.rides.items() if d == r.driver and st == s]
            trains = [people[n].back_trains.get(s[3:]) for n in names if s.startswith("st:")]
            catch = f"，赶 {'、'.join(t for t in trains if t)}" if any(trains) else ""
            waits = "".join(f"，{n}等 {fmt_min(depart - leave_of(people[n], leg))}" for n in names
                            if depart - leave_of(people[n], leg) >= 1)
            legs.append(f"{stop_label(s, pts)} {clock(times[s])}（送 {who(names, trip)}{catch}{waits}）")
        lines.append(f"- **{r.driver}**（空 {seats[r.driver]} 座）：{clock(depart)} 从目的地出发 → {' → '.join(legs)} → "
                     f"约 {clock(times[home])} 到家；全程约 {fmt_min(r.minutes)}，比直达多绕 **{fmt_min(r.detour)}**。")
    for car in taxi_cars(plan.taxi, people, T, leg, trip):
        s, names, ride, t = car["stop"], car["names"], car["ride"], car["time"]
        trains = [people[n].back_trains.get(pts[s].name) for n in names]
        catch = f"，赶 {'、'.join(x for x in trains if x)}" if any(trains) else ""
        waits = "".join(f"，{n}等 {fmt_min(t - leave_of(people[n], leg))}" for n in names if t - leave_of(people[n], leg) >= 1)
        lines.append(f"- **打车组**：{who(names, trip)} {clock(t)} 从目的地一起打车去 **{pts[s].name}**，"
                     f"约 {clock(t + ride)} 到{catch}{waits}{taxi_fare(ride, car['n'])}。")
    for name in plan.stranded:
        lines.append(f"- **{name}**：按 {clock(leave_of(people[name], leg))} 离场，赶不上任何一个候选站的车次，需要单独安排（提前离场或改签）。")
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


def render(trip: Trip, pts: dict[str, Place], T, plans: list[Plan]) -> str:
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
              "", "## 推荐方案", "", *describe(best, pts, T, trip), "",
              *paragraphs(rank_basis(best))]
        for i, pl in enumerate(plans[1:], 2):
            L += [f"## 备选方案 {i}（{pl.carried} 人搭车，车主合计多绕 {fmt_min(pl.detour)}）", "",
                  *describe(pl, pts, T, trip), "", *paragraphs(rank_basis(pl, best))]
    if trip.back:
        L += [f"## 返程（{clock(trip.back.depart)} 散场后出发，发车前 {trip.back.margin:.0f} 分钟到站）", ""]
        if not trip.back_plans:
            L += ["没有找到可行的返程方案。", ""]
        for i, pl in enumerate(trip.back_plans, 1):
            L += [f"### 返程方案 {i}（{pl.carried} 人搭车，车主合计多绕 {fmt_min(pl.detour)}）", "",
                  *describe_back(pl, pts, T, trip), "", *paragraphs(rank_basis(pl, trip.back_plans[0]))]
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


def plan_trip(cfg: dict, amap) -> tuple[Trip, dict[str, Place], dict, list[Plan]]:
    trip = load_trip(cfg, amap)
    if getattr(amap, "is_try", False):  # 试玩：不估算公交，报告顶部先说明数据是示意的
        trip.try_mode, trip.estimate_rail = True, False
        trip.warnings.insert(0, TRY_NOTICE)
    pts = points_of(trip)
    skip = {f"home:{p.name}" for p in trip.people if not p.drives and not p.pickup_at_home}
    T = build_matrix(amap, pts, skip, out=trip.outbound, back=trip.back is not None)
    plans: list[Plan] = []
    if trip.outbound:  # 只规划返程时用不到去程的车次和用时
        estimate_rail(amap, trip)
        plans = solve(trip, T)
    if trip.back:  # 返程插件
        trip.back_plans = solve(trip, T, leg=trip.back)
    return trip, pts, T, plans


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
    for name in ("venue", "options", "return"):
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
