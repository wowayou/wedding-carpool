# SPDX-License-Identifier: AGPL-3.0-or-later
"""地点和高德客户端：Place、Amap（直连高德 Web 服务）、AmapLike 接口、错误类型、额度判断、找站时的 POI 过滤。

只依赖标准库。换数据源时，写一个符合 AmapLike 的新实现即可，求解、行程表、报告都不用动。
"""

from __future__ import annotations

import http.client
import json
import math
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Protocol, runtime_checkable

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
        # 「(建设中)」「(暂停营业)」这类状态直接当原因，汇总里写「建设中 4 个」；别的标注照原样引出来
        return m.group(1) if re.search(r"建设|暂停|停用|停运|规划|关闭", m.group(1)) else f"站名带标注「{m.group(1)}」"
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


# ---------- 高德客户端的接口 ----------


@runtime_checkable
class AmapLike(Protocol):
    """计算核心（model、solver、routes……）和 service.py 对地图服务的全部要求。

    谁实现了它：Amap（本地直连高德）、browser.BrowserAmap（网页版，经 Worker 代理）、
    browser.TryAmap（试玩，不联网、按直线估算，查地点和公交的方法直接报错）、test_carpool.FakeAmap（离线测试）。
    换数据源（浏览器直接调用、JS API、天地图、腾讯地图等）时，写一个满足它的类传给 carpool.run / service.compute 即可。

    计算用到的高德服务类别（评估替代方案、和高德谈额度时看这张表）：

    | 用途 | 方法 | 高德 Web 服务接口 | 额度类别 |
    |---|---|---|---|
    | 地址解析 | geocode | /v3/geocode/geo | 路线和测距（lbs） |
    | 城市编码（公交跨城要用） | transit 内部 | /v3/geocode/regeo | 路线和测距（lbs） |
    | 按名字找车站 | find_station | /v5/place/text | 地点搜索（search） |
    | 界面里搜地点 | search | /v5/place/text（外加一次 geocode） | 地点搜索 + 路线和测距 |
    | 目的地周围的车站 | stations_near、stations_around | /v5/place/around、/v5/place/polygon | 地点搜索（search） |
    | 行车时间（多个起点到一个终点） | drive_minutes | /v3/distance（type=1，驾车） | 路线和测距（lbs） |
    | 驾车路线和轨迹 | drive_path、drive_routes | /v3/direction/driving | 路线和测距（lbs） |
    | 公共交通（含跨城火车） | transit | /v3/direction/transit/integrated | 路线和测距（lbs） |

    额度类别和 web/worker.js 的 quotaClass 一致：/v5/place/* 是地点搜索，其余都算路线和测距。

    可选部分：
    - 批量预取见 AmapPrefetch；没有 prefetch 方法的实现，计算会逐个请求，结果一样。
    - 属性 is_try（试玩模式）不在接口里：plan_trip 用 getattr(amap, "is_try", False) 读，没有就当 False。
    """

    calls: int  # 已经发出的高德请求数（命令行结束时打印；缓存命中不算）

    def geocode(self, address: str, city: str | None = None) -> Place | None:
        """把地址解析成坐标；解析不到返回 None。高德 /v3/geocode/geo，路线和测距类额度。"""

    def find_station(self, name: str, city: str | None = None) -> Place | None:
        """按名字找火车站（POI 分类 150200），同名优先；找不到返回 None。高德 /v5/place/text，地点搜索类额度。"""

    def search(self, keywords: str, city: str | None = None, types: str | None = None) -> list[dict]:
        """界面里的地点搜索：POI 候选加一条地址解析兜底。高德 /v5/place/text 加 /v3/geocode/geo，两类额度各一次。"""

    def stations_near(self, center: Place, radius_km: float, max_pages: int = 8) -> list[dict]:
        """目的地附近的火车站 POI（周边搜索加矩形搜索补远处的）。高德 /v5/place/around、/v5/place/polygon，地点搜索类额度。"""

    def stations_around(self, center: Place, radius_km: float, page: int = 1) -> list[dict]:
        """一个点周围的火车站 POI，一页，按距离排序，page 从 1 开始（找站建议用）。高德 /v5/place/around，地点搜索类额度。"""

    def drive_minutes(self, origins: list[Place], dest: Place) -> list[float | None]:
        """多个起点到一个终点的驾车分钟数，查不到的位置是 None。高德 /v3/distance（type=1），路线和测距类额度。"""

    def drive_path(self, places: list[Place], max_points: int = 600) -> list[list[float]]:
        """按顺序经过各点的驾车轨迹 [[lat, lng], ...]，给地图画线用。高德 /v3/direction/driving，路线和测距类额度。"""

    def drive_routes(self, places: list[Place], strategy: int = 0, alt: bool = False,
                     max_points: int = 600) -> list[dict]:
        """驾车路线 [{"path", "km", "minutes"}, ...]，alt 时最多三条备选。高德 /v3/direction/driving，路线和测距类额度。"""

    def transit(self, a: Place, b: Place, date: str, clock: str) -> tuple[float, str] | None:
        """公共交通（含跨城火车）最快方案的分钟数和乘车摘要；查不到返回 None。
        高德 /v3/direction/transit/integrated（城市编码另查 /v3/geocode/regeo），路线和测距类额度。"""


@runtime_checkable
class AmapPrefetch(AmapLike, Protocol):
    """AmapLike 加上「批量预取」：网页版跨洋调用慢，先把接下来要用的一组请求一次发出去，之后逐个调用直接命中缓存。

    各个 *_query 返回 (接口路径, 参数)，和对应的接口方法共用同一份参数，保证缓存键一致。
    carpool 里的 prefetch(amap, build) 只在客户端有 prefetch 方法时才调用 build，所以只有这个子接口的实现才会被调用 *_query。
    """

    cache: dict[str, dict]  # "路径?参数" -> 高德返回的内容

    def prefetch(self, queries: list[tuple[str, dict]]) -> None:
        """把一组请求一次取回放进缓存（本地直连不需要，空实现；网页版一次发给 Worker 并发请求）。"""

    def geocode_query(self, address: str, city: str | None = None) -> tuple[str, dict]:
        """geocode 的请求参数。"""

    def station_query(self, name: str, city: str | None = None) -> tuple[str, dict]:
        """find_station 的请求参数。"""

    def distance_query(self, origins: list[Place], dest: Place) -> tuple[str, dict]:
        """drive_minutes 的请求参数（一次最多 100 个起点）。"""

    def around_query(self, center: Place, radius_km: float, page: int = 1) -> tuple[str, dict]:
        """stations_around 的请求参数。"""

    def driving_query(self, places: list[Place], strategy: int | None = None) -> tuple[str, dict]:
        """drive_path、drive_routes 的请求参数。"""
