# SPDX-License-Identifier: AGPL-3.0-or-later
"""离线测试：用假的高德客户端验证选站和拼车逻辑。
行车分钟 = 直线公里数（60km/h）；公共交通分钟 = 公里数 / 3 + 30（火车约 180km/h 加市内接驳）。

    python3 -m unittest -v test_carpool.py
"""

import contextlib
import datetime as dt
import io
import json
import math
import os
import random
import re
import tempfile
import threading
import time
import tomllib
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest import mock

import browser
import carpool
import share
import service
import ui
from carpool import Place, km_between

VENUE = "118.0,30.0"
NEAR = "118.0,30.8"   # 目的地正北约 89km：离目的地最近的站
WEST = "117.0,30.0"   # 目的地正西约 96km：恰好在老王的路上
WANG = "116.0,30.0"   # 老王从西边开过来，直达约 193km


class FakeAmap:
    """只实现 carpool 用到的接口。"""

    def __init__(self, places=None, pois=None, no_transit=(), around=None, routes_fail=()):
        self.places = places or {}
        self.pois = pois or []
        self.around = around  # 可选：(中心, 半径, 页码) -> POI 列表，测翻页和各圈不同的结果
        self.routes_fail = set(routes_fail)  # 这些车主的路线查不到
        self.around_calls: list[tuple] = []  # 地点搜索调用（含翻页）
        self.route_calls: list[tuple] = []  # 驾车路线调用
        self.no_transit = set(no_transit)  # 这些站查不到公共交通方案
        self.calls = 0

    def geocode(self, address, city=None):
        self.calls += 1
        lng, lat = carpool.parse_loc(self.places[address])
        return Place(address, lng, lat, "fake")

    find_station = geocode

    def stations_near(self, center, radius_km):
        self.calls += 1
        return self.pois

    def stations_around(self, center, radius_km, page=1):
        self.calls += 1
        self.around_calls.append((center, radius_km, page))
        return self.around(center, radius_km, page) if self.around else self.pois

    def drive_minutes(self, origins, dest):
        self.calls += 1
        return [km_between(o, dest) for o in origins]

    def transit(self, a, b, date, clock):
        self.calls += 1
        if b.name in self.no_transit:
            return None
        return km_between(a, b) / 3 + 30, f"G1 某站→{b.name}"

    def search(self, keywords, city=None, types=None):
        self.calls += 1
        return [{"name": keywords, "location": self.places.get(keywords, VENUE), "detail": "fake"}]

    def drive_path(self, places):
        # 沿直线插值，像真实路线一样有密集的点
        self.calls += 1
        pts = [[a.lat + (b.lat - a.lat) * k / 20, a.lng + (b.lng - a.lng) * k / 20]
               for a, b in zip(places, places[1:]) for k in range(20)]
        return pts + [[places[-1].lat, places[-1].lng]]


def _fake_routes(self, places, strategy=0, alt=False):
    self.route_calls.append((places, strategy, alt))
    if any(n in p.name for n in self.routes_fail for p in places):
        raise carpool.AmapError("查不到路线")
    path = self.drive_path(places)
    km = sum(km_between(Place("", b[1], b[0]), Place("", a[1], a[0])) for a, b in zip(path, path[1:]))
    routes = [{"path": path, "km": km, "minutes": km}]  # 假高德：1 公里 1 分钟
    if alt:  # 备选路线：整体往北偏 0.3 度
        routes.append({"path": [[lat + 0.3, lng] for lat, lng in path], "km": km * 1.05, "minutes": km * 1.05})
    return routes


FakeAmap.drive_routes = _fake_routes


def person(name, loc, **kw):
    return {"name": name, "from": name, "location": loc, **kw}


def config(people, stations=(("近站", NEAR), ("西站", WEST)), **options):
    return {
        "venue": {"name": "目的地", "location": VENUE},
        "options": options,
        "stations": [{"name": n, "location": loc} for n, loc in stations],
        "people": people,
    }


def best_plan(cfg, amap=None):
    amap = amap or FakeAmap()
    trip = carpool.load_trip(cfg, amap)
    pts = carpool.points_of(trip)
    T = carpool.build_matrix(amap, pts, set())
    carpool.estimate_rail(amap, trip)
    return carpool.solve(trip, T), pts, T, trip


class SolveTest(unittest.TestCase):
    def test_picks_station_on_drivers_way_not_nearest(self):
        plans, *_ = best_plan(config([
            person("老王", WANG, car_seats=3),
            person("小陈", "114.0,34.0"),
        ]))
        best = plans[0]
        self.assertEqual(best.rides, {"小陈": ("老王", "st:西站")})
        self.assertLess(best.detour, 2)

    def test_seat_limit_sends_rest_to_taxi_at_nearest_station(self):
        plans, *_ = best_plan(config([
            person("老王", WANG, car_seats=1),
            person("小陈", "114.0,34.0"),
            person("小李", "113.0,35.0"),
        ]))
        best = plans[0]
        self.assertEqual(len(best.rides), 1)
        self.assertEqual(list(best.taxi.values()), ["st:近站"])

    def test_home_pickup_on_the_way(self):
        plans, *_ = best_plan(config([
            person("老王", WANG, car_seats=3),
            person("小李", "116.5,30.0"),
            person("小陈", "114.0,34.0"),
        ]))
        best = plans[0]
        self.assertEqual(best.rides["小李"], ("老王", "home:小李"))
        self.assertEqual(best.rides["小陈"], ("老王", "st:西站"))
        self.assertEqual(best.routes[0].stops, ("home:小李", "st:西站"))

    def test_rail_min_limits_stations(self):
        plans, *_ = best_plan(config([
            person("老王", WANG, car_seats=3),
            person("小陈", "114.0,34.0", rail_min={"近站": 120}),
        ]))
        best = plans[0]
        self.assertEqual(best.rides, {})
        self.assertEqual(best.taxi, {"小陈": "st:近站"})
        self.assertEqual(best.routes[0].stops, ())

    def test_detour_limit_respected(self):
        plans, *_ = best_plan(config([
            person("老王", WANG, car_seats=3, max_detour_min=10),
            person("小陈", "114.0,34.0", stations=["近站"]),
        ]))
        for plan in plans:
            for r in plan.routes:
                self.assertLessEqual(r.detour, 10)

    def test_no_drivers_all_taxi(self):
        plans, *_ = best_plan(config([person("小陈", "114.0,34.0"), person("我", "121.5,31.2")]))
        self.assertEqual(plans[0].taxi, {"小陈": "st:近站", "我": "st:近站"})

    def test_taxi_station_follows_riders_rail_direction(self):
        east = "119.0,30.0"  # 与西站到目的地距离相同，但在东边
        plans, *_ = best_plan(config(
            [person("我", "121.5,31.2"), person("小陈", "114.0,30.5")],
            stations=(("东站", east), ("西站", WEST)),
        ))
        self.assertEqual(plans[0].taxi, {"我": "st:东站", "小陈": "st:西站"})

    def test_station_without_transit_is_excluded_with_warning(self):
        plans, _, _, trip = best_plan(config([
            person("老王", WANG, car_seats=3),
            person("小陈", "114.0,34.0"),
        ]), FakeAmap(no_transit={"西站"}))
        self.assertEqual(plans[0].rides, {})
        self.assertEqual(plans[0].taxi, {"小陈": "st:近站"})
        self.assertTrue(any("没查到 小陈 到 西站" in w for w in trip.warnings))

    def test_no_transit_at_all_falls_back_to_flat_cost(self):
        plans, _, _, trip = best_plan(config([
            person("老王", WANG, car_seats=3),
            person("小陈", "114.0,34.0"),
        ]), FakeAmap(no_transit={"西站", "近站"}))
        self.assertEqual(plans[0].rides, {"小陈": ("老王", "st:西站")})
        self.assertTrue(any("改按每站 60 分钟估算" in w for w in trip.warnings))

    def test_travel_date_normalized(self):
        *_, trip = best_plan(config([person("小陈", "114.0,34.0")], travel_date="2026-10-07"))
        self.assertEqual(trip.travel_date, "2026-10-7")

    def test_stranded_when_no_station_allowed(self):
        plans, *_ = best_plan(config([
            person("老王", WANG, car_seats=3),
            person("小陈", "114.0,34.0", stations=["不存在站"], pickup_at_home=False),
        ]))
        self.assertEqual(plans[0].stranded, ["小陈"])

    def test_unknown_station_name_warns(self):
        *_, trip = best_plan(config([person("小陈", "114.0,34.0", stations=["不存在站"])]))
        self.assertTrue(any("不存在站" in w for w in trip.warnings))

    def test_many_people_finishes_quickly(self):
        stations = [(f"站{i}", f"{117.0 + 0.2 * i},{29.5 + 0.1 * i}") for i in range(10)]
        drivers = [person(f"车主{i}", f"{115.0 + i * 0.3},{29.0 + i * 0.4}", car_seats=2) for i in range(4)]
        riders = [person(f"乘客{i}", f"{112.0 + i},{33.0 + i * 0.2}") for i in range(6)]
        start = time.perf_counter()
        plans, *_ = best_plan(config(drivers + riders, stations=stations, max_detour_min=40))
        elapsed = time.perf_counter() - start
        self.assertTrue(plans)
        self.assertLess(elapsed, 60)
        print(f"\n4 车 6 乘客 10 站：{elapsed:.1f}s，最优方案 {len(plans[0].rides)} 人搭车")


class DiscoverTest(unittest.TestCase):
    def test_filters_noise_dedupes_and_sorts(self):
        venue = Place("v", 118.0, 30.0)
        pois = [
            {"name": "西站", "location": WEST, "typecode": "150200"},
            {"name": "西站-进站口", "location": WEST, "typecode": "150200"},
            {"name": "近站(东广场)", "location": NEAR, "typecode": "150200"},
            {"name": "近站", "location": NEAR, "typecode": "150200"},
            {"name": "近站", "location": NEAR, "typecode": "150200"},
            {"name": "远站", "location": "110.0,30.0", "typecode": "150200"},
            {"name": "某地铁站", "location": NEAR, "typecode": "150500"},
        ]
        got = carpool.pick_stations(pois, venue, radius_km=120, limit=10)
        self.assertEqual([p.name for p in got], ["近站", "西站"])

    def test_auto_discovery_when_no_stations(self):
        pois = [{"name": "近站", "location": NEAR}, {"name": "西站", "location": WEST}]
        cfg = config([person("老王", WANG, car_seats=3), person("小陈", "114.0,34.0")])
        del cfg["stations"]
        report = carpool.run(cfg, FakeAmap(pois=pois))
        self.assertIn("自动搜出来的", report)
        self.assertIn("西站（接 小陈）", report)


class RenderTest(unittest.TestCase):
    def test_report_has_plan_table_and_links(self):
        cfg = config([
            person("老王", WANG, car_seats=3),
            person("老张", "118.5,31.5", car_seats=2),
            person("小陈", "114.0,34.0"),
        ])
        report = carpool.run(cfg, FakeAmap())
        self.assertIn("## 推荐方案", report)
        self.assertIn("## 候选站对比", report)
        self.assertIn("https://uri.amap.com/navigation?from=116.000000,30.000000,", report)
        self.assertIn("&via=117.000000,30.000000,", report)
        self.assertIn("https://uri.amap.com/marker?position=118.000000,30.000000&name=", report)
        self.assertIn("## 不开车的人到各站要多久", report)
        self.assertIn("G1 某站→西站", report)

    def test_resolves_addresses_through_client(self):
        amap = FakeAmap(places={"杭州": WANG, "武汉": "114.0,34.0", "场地地址": VENUE, "西站": WEST})
        cfg = {
            "venue": {"name": "目的地", "address": "场地地址"},
            "stations": [{"name": "西站"}],
            "people": [{"name": "老王", "from": "杭州", "car_seats": 2}, {"name": "小陈", "from": "武汉"}],
        }
        self.assertIn("西站（接 小陈）", carpool.run(cfg, amap))


class StationLookupTest(unittest.TestCase):
    def test_unknown_station_fails_instead_of_geocoding(self):
        class NoStation(FakeAmap):
            def find_station(self, name, city=None):
                return None

        cfg = config([person("小陈", "114.0,34.0")])
        cfg["stations"] = [{"name": "清河西站"}]
        with self.assertRaises(SystemExit) as ctx:
            carpool.load_trip(cfg, NoStation(places={"清河西站": "124.0,42.0"}))
        self.assertIn("city", str(ctx.exception))


class RetryTest(unittest.TestCase):
    def ok(self, payload):
        return io.BytesIO(json.dumps(payload).encode())

    def test_retries_connection_reset_then_succeeds(self):
        replies = [ConnectionResetError(104, "Connection reset by peer"),
                   carpool.urllib.error.URLError(ConnectionResetError(104, "reset")),
                   self.ok({"status": "1", "geocodes": []})]
        with mock.patch("carpool.urllib.request.urlopen", side_effect=replies) as urlopen, \
             mock.patch("carpool.time.sleep"):
            self.assertIsNone(carpool.Amap("k").geocode("某地"))
        self.assertEqual(urlopen.call_count, 3)

    def test_retries_qps_limit(self):
        replies = [self.ok({"status": "0", "info": "CUQPS_HAS_EXCEEDED_THE_LIMIT", "infocode": "10019"}),
                   self.ok({"status": "1", "geocodes": []})]
        with mock.patch("carpool.urllib.request.urlopen", side_effect=replies), mock.patch("carpool.time.sleep"):
            self.assertIsNone(carpool.Amap("k").geocode("某地"))

    def test_gives_up_with_clear_error(self):
        with mock.patch("carpool.urllib.request.urlopen", side_effect=ConnectionResetError(104, "reset")), \
             mock.patch("carpool.time.sleep"), self.assertRaises(carpool.AmapError) as ctx:
            carpool.Amap("k").geocode("某地")
        self.assertIn("连不上高德", str(ctx.exception))

    def test_quota_error_stops_without_retry(self):
        reply = self.ok({"status": "0", "info": "DAILY_QUERY_OVER_LIMIT", "infocode": "10003"})
        with mock.patch("carpool.urllib.request.urlopen", return_value=reply) as urlopen, \
             mock.patch("carpool.time.sleep"), self.assertRaises(carpool.QuotaError) as ctx:
            carpool.Amap("k").geocode("某地")
        self.assertEqual(urlopen.call_count, 1)
        self.assertIn("配额已用完", str(ctx.exception))

    def test_quota_error_not_swallowed_downstream(self):
        class QuotaAmap(FakeAmap):
            def transit(self, a, b, date, clock):
                raise carpool.QuotaError("配额已用完")

            def drive_path(self, places):
                raise carpool.QuotaError("配额已用完")

        cfg = config([person("老王", WANG, car_seats=3), person("小陈", "114.0,34.0")])
        with self.assertRaises(carpool.QuotaError):  # 估算用时时不能当成「这个站查不到」
            carpool.plan_trip(cfg, QuotaAmap())
        cfg["people"][1]["rail_min"] = {"西站": 100}
        with self.assertRaises(carpool.QuotaError):  # 取路线时不能悄悄改画直线
            service.compute(cfg, QuotaAmap())

    def test_api_error_not_retried(self):
        reply = self.ok({"status": "0", "info": "INVALID_USER_KEY", "infocode": "10001"})
        with mock.patch("carpool.urllib.request.urlopen", return_value=reply) as urlopen, \
             mock.patch("carpool.time.sleep"), self.assertRaises(carpool.AmapError):
            carpool.Amap("k").geocode("某地")
        self.assertEqual(urlopen.call_count, 1)


class TrainScheduleTest(unittest.TestCase):
    def setUp(self):
        self.cfg = config([
            person("老王", WANG, car_seats=3),
            person("小陈", "114.0,34.0", trains={"西站": "G1 小陈家07:00→西站10:00"}, note="带了喜糖"),
        ])

    def test_trains_derive_minutes_and_limit_stations(self):
        trip = carpool.load_trip(self.cfg, FakeAmap())
        self.assertEqual(trip.people[1].rail_min, {"西站": 180 + 45})
        self.cfg["options"] = {"station_access_min": 30}
        self.assertEqual(carpool.load_trip(self.cfg, FakeAmap()).people[1].rail_min, {"西站": 210})

    def test_driver_departure_backed_out_from_train(self):
        plans, pts, T, trip = best_plan(self.cfg)
        best = plans[0]
        sched = carpool.route_schedule(best.routes[0], carpool.pickup_ready(best, trip), T)
        ready = 10 * 60 + 15  # 10:00 到站 + 15 分钟出站
        self.assertAlmostEqual(sched["depart"], ready - T[("car:老王", "st:西站")])
        self.assertAlmostEqual(sched["times"]["venue"], ready + T[("st:西站", "venue")])
        report = carpool.render(trip, pts, T, plans)
        self.assertIn(f"建议 **{carpool.clock(sched['depart'])} 出发**", report)

    def test_share_page(self):
        amap = FakeAmap()
        state = service.compute(self.cfg, amap)
        html = share.render_share(state, 0)
        for text in ("G1 小陈家07:00→西站10:00", "上 <b>老王</b> 的车", "10:15", "带了喜糖", "uri.amap.com/navigation"):
            self.assertIn(text, html)
        self.assertNotIn('"lng": 114.0', html)  # 不开车的人家的位置不进方案页
        self.assertNotIn("[30.0, 116.0]", html)  # 车主出发地不放精确位置：路线从约 2 公里外开始
        self.assertNotRegex(html, r'"lng": 116\.0[,}]')
        self.assertNotIn("116.000000,30.000000", html)  # 导航链接也不写出发地：起点留空，手机上用当前位置
        self.assertIn("老王 出发", html)

    def test_share_page_expiry_and_print(self):
        state = service.compute(self.cfg, FakeAmap())
        html = share.render_share(state, 0, expires=dt.date(2027, 4, 5))
        self.assertIn("这一页会在 2027-04-05 前后自动删除", html)
        self.assertNotIn("自动删除", share.render_share(state, 0))  # 本地版没有保留期，不写这行
        for text in ("window.print()", "@media print", "break-inside: avoid", "data:image/svg+xml"):
            self.assertIn(text, html)

    def test_share_page_hides_home_pickup(self):
        cfg = config([person("老王", WANG, car_seats=3), person("小李", "116.5,30.0"), person("小陈", "114.0,34.0")])
        state = service.compute(cfg, FakeAmap())
        html = share.render_share(state, 0)
        self.assertIn("到家附近接，具体地点在群里约", html)
        self.assertNotIn("116.500000,30.000000", html)  # 地图链接、导航链接都不指向小李家
        self.assertNotIn("[30.0, 116.5]", html)  # 小李家附近的路线不画


class BrowserBridgeTest(unittest.TestCase):
    def setUp(self):
        self._amap, browser.amap, browser._last = browser.amap, FakeAmap(), None

    def tearDown(self):
        browser.amap, browser._last = self._amap, None

    def call(self, method, **args):
        return json.loads(browser.handle(method, json.dumps(args)))

    def test_plan_then_share(self):
        self.assertIn("先点", self.call("share", plan=0)["error"])
        cfg = config([person("老王", WANG, car_seats=3), person("小陈", "114.0,34.0")])
        out = self.call("plan", config=cfg)
        self.assertEqual(out["plans"][0]["rides"], {"小陈": ["老王", "st:西站"]})
        self.assertIsNotNone(out["plans"][0]["routes"][0]["direct_path"])  # 直达路线用来对比绕路
        self.assertTrue(self.call("share", plan=0)["html"].startswith("<!doctype html>"))
        self.assertIn("没有方案", self.call("share", plan=7)["error"])
        ms = int(dt.datetime(2027, 4, 5, 23, 30, tzinfo=dt.timezone(dt.timedelta(hours=8))).timestamp() * 1000)  # 北京时间深夜，不能按 UTC 取日期
        self.assertIn("这一页会在 2027-04-05 前后自动删除", self.call("share", plan=0, expires=ms)["html"])
        self.assertNotIn("自动删除", self.call("share", plan=0)["html"])

    def test_errors_become_messages(self):
        self.assertIn("people", self.call("plan", config=config([]))["error"])
        self.assertIn("未知操作", self.call("nope")["error"])

    def test_prefetch_fills_cache_then_get_hits_it(self):
        amap = browser.BrowserAmap(pause=0)
        q1 = amap.geocode_query("杭州东站")
        q2 = amap.distance_query([Place("a", 1, 2)], Place("b", 3, 4))
        replies = {"results": [{"status": "1", "geocodes": []}, {"status": "0", "info": "ENGINE_RESPONSE_DATA_ERROR"}]}
        with mock.patch.object(amap, "_post_json", return_value=replies) as post:
            amap.prefetch([q1, q2, q1])  # 重复的只发一次
        self.assertEqual(len(post.call_args[0][1]["requests"]), 2)
        with mock.patch.object(amap, "_fetch", side_effect=AssertionError("不该再请求")):
            self.assertIsNone(amap.geocode("杭州东站"))
        self.assertNotIn(f"{q2[0]}?{carpool.urllib.parse.urlencode(q2[1])}", amap.cache)  # 失败的留给逐个请求

    def test_prefetch_stops_on_quota(self):
        amap = browser.BrowserAmap(pause=0)
        reply = {"results": [{"status": "0", "info": "USER_DAILY_QUERY_OVER_LIMIT", "infocode": "10044"}]}
        with mock.patch.object(amap, "_post_json", return_value=reply), self.assertRaises(carpool.QuotaError):
            amap.prefetch([amap.geocode_query("某地")])

    def test_prefetch_network_failure_is_silent(self):
        amap = browser.BrowserAmap(pause=0)
        with mock.patch.object(amap, "_post_json", side_effect=ConnectionError("断网")):
            amap.prefetch([amap.geocode_query("某地")])
        self.assertEqual(amap.cache, {})

    def test_share_tooltips_are_plain_text(self):
        # 地图提示框里的成员名字不能当 HTML 解析（审计 S-13）
        self.assertNotIn(".bindTooltip(r.label", share.TEMPLATE)
        self.assertIn("function text(s)", share.TEMPLATE)

    def test_browser_single_request_posts_query_in_body(self):
        # 单个请求也走 POST 批量接口：地点文字不出现在网址上（审计 S-12/D-14）
        amap = browser.BrowserAmap("/api/t/abc", pause=0)
        sent = []
        def fake_post(url, payload):
            sent.append((url, payload))
            return {"results": [{"status": "1", "info": "OK", "geocodes": []}]}
        with mock.patch.object(amap, "_post_json", side_effect=fake_post):
            data = amap._fetch(amap._url("/v3/geocode/geo", "address=%E5%AE%8F%E6%9D%91"))
        self.assertEqual(data["info"], "OK")
        self.assertEqual(sent, [("/api/t/abc/amap-batch", {"requests": [{"path": "/v3/geocode/geo", "query": "address=%E5%AE%8F%E6%9D%91"}]})])
        with mock.patch.object(amap, "_post_json", return_value={"results": [{"status": "0", "info": "NETWORK_ERROR", "error": "连不上"}]}):
            with self.assertRaises(ConnectionError):
                amap._fetch(amap._url("/v3/distance", "a=1"))
        with mock.patch.object(amap, "_post_json", return_value={"error": "需要用编辑链接打开", "info": "UNAUTHORIZED"}):
            self.assertEqual(amap._fetch(amap._url("/v3/distance", "a=1"))["info"], "UNAUTHORIZED")

    def test_browser_urls_go_through_proxy_without_key(self):
        self.assertEqual(browser.BrowserAmap("/api/t/abc")._url("/v3/distance", "a=1"), "/api/t/abc/amap/v3/distance?a=1")


class ResolveAndSuggestTest(unittest.TestCase):
    def test_text_places_are_written_back(self):
        amap = FakeAmap(places={"场地地址": VENUE, "杭州": WANG, "武汉": "114.0,34.0", "西站": WEST})
        cfg = {
            "venue": {"name": "目的地", "address": "场地地址"},
            "stations": [{"name": "西站"}, {"name": "近站", "location": NEAR}],
            "people": [{"name": "老王", "from": "杭州", "car_seats": 2}, {"name": "小陈", "from": "武汉"}],
        }
        out = service.plan_payload(service.compute(cfg, amap))
        self.assertEqual({r["path"]: r["location"] for r in out["resolved"]}, {
            "venue": "118.000000,30.000000", "people.0": "116.000000,30.000000",
            "people.1": "114.000000,34.000000", "stations.0": "117.000000,30.000000",
        })  # 近站已经有坐标，不在里面

    def test_suggest_finds_station_on_drivers_way_and_filters_freight(self):
        pois = [{"name": n, "location": loc, "typecode": "150200"} for n, loc in
                [("西站", WEST), ("近站", NEAR), ("货运站", "117.5,30.0"), ("远站", "110.0,30.0"), ("西站-进站口", WEST)]]
        # 近站在目的地以北约 89 公里：目的地周边 50 公里搜不到，靠周围那一圈搜到
        cfg = config([person("老王", WANG, car_seats=3), person("小陈", "114.0,34.0")], stations=())
        out = service.suggest_stations(cfg, FakeAmap(pois=pois), valid_names={"西", "近", "远"})
        names = [s["name"] for s in out["stations"]]
        self.assertEqual(names[:2], ["西站", "近站"])  # 西站在老王路上，绕路最少
        self.assertNotIn("货运站", names)  # 12306 里没有
        self.assertEqual(out["stations"][0]["best"], {"driver": "老王", "detour": 0})

    def test_suggest_skips_existing_stations(self):
        pois = [{"name": "西站", "location": WEST}, {"name": "近站", "location": NEAR}]
        cfg = config([person("老王", WANG, car_seats=3)], stations=(("西站", WEST),))
        self.assertEqual([s["name"] for s in service.suggest_stations(cfg, FakeAmap(pois=pois))["stations"]], ["近站"])

    def test_progress_is_reported_by_stage(self):
        seen = []
        carpool.progress = lambda label, done, total: seen.append((label, done, total))
        try:
            service.compute(config([person("老王", WANG, car_seats=3), person("小陈", "114.0,34.0")]), FakeAmap())
        finally:
            carpool.progress = None
        labels = list(dict.fromkeys(label for label, _, _ in seen))
        self.assertEqual(labels[:2], ["定位目的地、成员和车站", "查询行车时间"])
        self.assertIn("比较各种接人组合", labels)
        self.assertEqual(labels[-1], "获取路线轨迹")
        self.assertIn(("查询行车时间", 3, 4), seen)  # 目的地、两个车站、小陈家

    def test_trip_limit_errors_stop_like_quota(self):
        with self.assertRaises(carpool.QuotaError) as ctx:
            carpool.check_quota("TRIP_DAILY_LIMIT", "这个行程今天的高德调用已到上限")
        self.assertIn("行程今天", str(ctx.exception))

    def test_emergency_and_budget_infos_stop_like_quota(self):
        for info in ("PUBLIC_PAUSED", "TRIP_BLOCKED", "MONTHLY_BUDGET"):
            with self.assertRaises(carpool.QuotaError, msg=info) as ctx:
                carpool.check_quota(info, "站点暂时停用了公共额度")
            self.assertIn("额度", str(ctx.exception))
        carpool.check_quota("OK")  # 普通返回不受影响


class ReturnTripTest(unittest.TestCase):
    """返程插件：目的地 → 送人点 → 车主家，送到站要赶得上车次。"""

    def cfg(self, train="G2 西站20:30→小陈家23:30", depart="18:00", drives=True):
        c = config([person("老王", WANG, car_seats=3, return_drives=drives),
                    person("小陈", "114.0,34.0", return_trains={"西站": train})])
        c["return"] = {"enabled": True, "depart_time": depart}
        return c

    def run_trip(self, cfg):
        return carpool.plan_trip(cfg, FakeAmap())

    def test_drop_off_on_the_way_home(self):
        trip, pts, T, _ = self.run_trip(self.cfg())
        best = trip.back_plans[0]
        self.assertEqual(best.rides, {"小陈": ("老王", "st:西站")})
        self.assertLess(best.detour, 2)  # 西站就在老王回家的路上
        times = carpool.stop_times(best.routes[0], T, trip.back)
        self.assertAlmostEqual(times["st:西站"], 18 * 60 + T[("venue", "st:西站")])
        self.assertAlmostEqual(times["car:老王"], 18 * 60 + T[("venue", "st:西站")] + T[("st:西站", "car:老王")])

    def test_cannot_catch_train(self):
        # 19:30 发车要 18:50 前到；18:00 出发开 96 分钟，19:36 才到：送不了，打车也赶不上
        trip, pts, T, plans = self.run_trip(self.cfg(train="G2 西站19:30→小陈家22:30"))
        back = trip.back_plans[0]
        self.assertEqual((back.rides, back.taxi, back.stranded), ({}, {}, ["小陈"]))
        self.assertIn("赶不上任何一个候选站的车次", carpool.render(trip, pts, T, plans))

    def test_driver_not_driving_back(self):
        trip, *_ = self.run_trip(self.cfg(drives=False))
        back = trip.back_plans[0]
        self.assertEqual(back.rides, {})
        self.assertEqual(back.taxi, {"小陈": "st:西站"})
        self.assertEqual(back.routes[0].stops, ())

    def test_outbound_unchanged_by_return(self):
        with_back = self.run_trip(self.cfg())[3]
        cfg = self.cfg()
        del cfg["return"]
        without = self.run_trip(cfg)[3]
        self.assertEqual([(p.rides, round(p.detour, 3)) for p in with_back], [(p.rides, round(p.detour, 3)) for p in without])

    def test_report_has_return_section(self):
        trip, pts, T, plans = self.run_trip(self.cfg())
        report = carpool.render(trip, pts, T, plans)
        self.assertIn("## 返程（18:00 散场后出发，发车前 40 分钟到站）", report)
        self.assertIn("送 小陈，赶 G2 西站20:30→小陈家23:30", report)

    def test_share_page_and_payload_have_return(self):
        state = service.compute(self.cfg(), FakeAmap())
        payload = service.plan_payload(state)
        self.assertEqual(payload["back"]["depart"], "18:00")
        self.assertEqual(payload["back"]["plans"][0]["rides"], {"小陈": ["老王", "st:西站"]})
        self.assertIsNotNone(payload["back"]["plans"][0]["routes"][0]["path"])
        html = share.render_share(state, 0, 0)
        self.assertIn("返程 · 18:00 散场后出发", html)
        self.assertIn("坐 <b>G2 西站20:30→小陈家23:30</b>", html)
        self.assertNotIn("116.000000,30.000000", html)  # 返程导航也不指向车主家

    def test_missing_depart_time_is_an_error(self):
        cfg = self.cfg()
        cfg["return"]["depart_time"] = ""
        with self.assertRaises(SystemExit):
            self.run_trip(cfg)


class ReturnOnlyTest(unittest.TestCase):
    """去程和返程各有开关：只规划返程时，不算去程，也不用去程的车次、日期。"""

    def cfg(self, **options):
        c = config([person("老王", WANG, car_seats=3), person("小陈", "114.0,34.0", return_trains={"西站": "G2 西站20:30→小陈家23:30"})],
                   outbound=False, **options)
        c["return"] = {"enabled": True, "depart_time": "18:00", "date": "2026-10-18"}
        return c

    def test_only_return_gets_plans(self):
        trip, pts, T, plans = carpool.plan_trip(self.cfg(), FakeAmap())
        self.assertEqual((plans, trip.outbound), ([], False))
        self.assertEqual(trip.back_plans[0].rides, {"小陈": ("老王", "st:西站")})
        self.assertEqual(trip.travel_date, "2026-10-18")  # 没有去程日期可借用，取返程日期

    def test_same_return_plans_as_with_outbound(self):
        both = self.cfg()
        del both["options"]["outbound"]
        both["options"]["travel_date"] = "2026-10-17"
        only = carpool.plan_trip(self.cfg(), FakeAmap())[0].back_plans
        also = carpool.plan_trip(both, FakeAmap())[0].back_plans
        self.assertEqual([(p.rides, p.taxi, round(p.cost, 3)) for p in only], [(p.rides, p.taxi, round(p.cost, 3)) for p in also])

    def test_matrix_only_asks_for_return_directions(self):
        _, _, T, _ = carpool.plan_trip(self.cfg(), FakeAmap())
        self.assertFalse([k for k in T if k[0] != k[1] and (k[0].startswith("car:") or k[1] == "venue")])  # 没有「从车主家出发」和「到目的地」
        self.assertIn(("venue", "car:老王"), T)
        self.assertIn(("st:西站", "car:老王"), T)
        cfg = self.cfg()
        del cfg["options"]["outbound"]
        trip = carpool.load_trip(cfg, FakeAmap())  # 默认只查去程
        out = carpool.build_matrix(FakeAmap(), carpool.points_of(trip), set())
        self.assertFalse([k for k in out if k[0] != k[1] and (k[0] == "venue" or k[1].startswith("car:"))])

    def test_both_off_is_rejected_before_any_amap_call(self):
        amap = FakeAmap()
        cfg = self.cfg()
        del cfg["return"]
        with self.assertRaises(SystemExit) as ctx:
            carpool.plan_trip(cfg, amap)
        self.assertIn("至少要规划一段", str(ctx.exception))
        cfg["return"] = {"enabled": False, "depart_time": "18:00", "date": "2026-10-18"}
        with self.assertRaises(SystemExit):
            carpool.plan_trip(cfg, amap)
        self.assertEqual(amap.calls, 0)

    def test_return_only_needs_a_date(self):
        cfg = self.cfg()
        del cfg["return"]["date"]
        with self.assertRaises(SystemExit) as ctx:
            carpool.plan_trip(cfg, FakeAmap())
        self.assertIn("返程日期", str(ctx.exception))

    def test_report_has_no_outbound_wording(self):
        trip, pts, T, plans = carpool.plan_trip(self.cfg(), FakeAmap())
        report = carpool.render(trip, pts, T, plans)
        self.assertTrue(report.startswith("# 返程方案："))
        for word in ("去程", "## 结论", "## 推荐方案", "备选方案", "站→目的地", "不开车的人到各站要多久", "接人"):
            self.assertNotIn(word, report)
        self.assertIn("## 返程（18:00 散场后出发", report)
        self.assertIn("目的地→站车程", report)
        self.assertIn("送 小陈，赶 G2 西站20:30→小陈家23:30", report)

    def test_payload_and_share_page_only_have_return(self):
        state = service.compute(self.cfg(), FakeAmap())
        payload = service.plan_payload(state)
        self.assertEqual((payload["outbound"], payload["plans"]), (False, []))
        self.assertEqual(payload["back"]["plans"][0]["rides"], {"小陈": ["老王", "st:西站"]})
        html = share.render_share(state, 0, 0)
        self.assertIn("返程方案 1", html)
        self.assertIn("返程 · 18:00 散场后出发", html)
        self.assertIn("坐 <b>G2 西站20:30→小陈家23:30</b>", html)
        for word in ("<h2>开车的</h2>", "<h2>坐车的</h2>", "去程", "出发地出发"):
            self.assertNotIn(word, html)
        self.assertNotIn("116.000000,30.000000", html)  # 地图和链接都不指向车主家
        self.assertNotIn("[30.0, 116.0]", html)
        self.assertNotIn("@@", html)

    def test_share_choice_is_checked(self):
        state = service.compute(self.cfg(), FakeAmap())
        with self.assertRaises(SystemExit) as ctx:
            share.render_share(state, 0, 5)
        self.assertIn("没有返程方案 6", str(ctx.exception))
        both = service.compute(ReturnTripTest().cfg(), FakeAmap())
        with self.assertRaises(SystemExit):
            share.render_share(both, 3, 0)

    def test_share_page_names_the_chosen_combination(self):
        state = service.compute(ReturnTripTest().cfg(), FakeAmap())
        self.assertIn("去程方案 2 + 返程方案 2", share.render_share(state, 1, 1))
        no_back = service.compute(config([person("老王", WANG, car_seats=3), person("小陈", "114.0,34.0")]), FakeAmap())
        self.assertIn("去程方案 1", share.render_share(no_back, 0))
        self.assertNotIn("返程方案", share.render_share(no_back, 0))

    def test_bridge_shares_return_only(self):
        saved = browser.amap, browser._last
        browser.amap, browser._last = FakeAmap(), None
        try:
            out = json.loads(browser.handle("plan", json.dumps({"config": self.cfg()})))
            self.assertEqual(out["plans"], [])
            html = json.loads(browser.handle("share", json.dumps({"plan": -1, "back_plan": 0})))["html"]
            self.assertTrue(html.startswith("<!doctype html>"))
            self.assertIn("没有返程方案", json.loads(browser.handle("share", json.dumps({"back_plan": 4})))["error"])
        finally:
            browser.amap, browser._last = saved

    def test_suggest_stations_follows_the_way_home(self):
        pois = [{"name": n, "location": loc, "typecode": "150200"} for n, loc in [("西站", WEST), ("近站", NEAR)]]
        cfg = self.cfg()
        cfg["stations"] = []
        out = service.suggest_stations(cfg, FakeAmap(pois=pois))
        self.assertEqual([s["name"] for s in out["stations"]][:2], ["西站", "近站"])  # 西站在老王回家的路上
        self.assertEqual(out["stations"][0]["best"], {"driver": "老王", "detour": 0})
        self.assertEqual(out["stations"][0]["to_venue"], round(km_between(Place("", 118, 30), Place("", 117, 30))))  # 目的地到站

    def test_toml_keeps_the_return_table(self):
        cfg = {"venue": {"name": "v"}, "options": {"outbound": False}, "return": {"enabled": True, "depart_time": "18:00", "date": "2026-10-18"},
               "people": [{"name": "甲"}]}
        self.assertEqual(tomllib.loads(carpool.dump_toml(cfg)), cfg)


class LeaveTimeTest(unittest.TestCase):
    """个人离场时间：车主几点走车就几点走；乘客准备好后最多等 max_wait_min；打车的人从自己的离场时间出发。"""

    def cfg(self, driver=None, rider=None, train="G2 西站22:30→小陈家23:30", depart="18:00", **rider_kw):
        driver_kw = {} if driver is None else {"leave_time": driver}
        rider_kw = {**rider_kw, **({} if rider is None else {"leave_time": rider})}
        c = config([person("老王", WANG, car_seats=3, **driver_kw), person("小陈", "114.0,34.0", return_trains={"西站": train}, **rider_kw)])
        c["return"] = {"enabled": True, "depart_time": depart}
        return c

    def back(self, cfg):
        trip, pts, T, plans = carpool.plan_trip(cfg, FakeAmap())
        return trip, trip.back_plans[0], carpool.render(trip, pts, T, plans)

    def test_same_as_depart_time_changes_nothing(self):
        def key(cfg):
            return [(p.rides, p.taxi, p.stranded, round(p.cost, 3)) for p in carpool.plan_trip(cfg, FakeAmap())[0].back_plans]
        self.assertEqual(key(self.cfg()), key(self.cfg(driver="18:00", rider="18:00")))

    def test_driver_leaving_earlier_cannot_take_the_rider(self):
        _, plan, report = self.back(self.cfg(driver="17:30"))
        self.assertEqual((plan.rides, plan.taxi), ({}, {"小陈": "st:西站"}))
        self.assertIn("17:30 从目的地直接回家", report)

    def test_waiting_over_the_limit_cannot_board(self):
        _, plan, _ = self.back(self.cfg(driver="18:45"))  # 乘客 18:00 就绪，要等 45 分钟，超过默认的 30
        self.assertEqual(plan.rides, {})
        cfg = self.cfg(driver="18:45")
        cfg["return"]["max_wait_min"] = 60
        trip, plan, report = self.back(cfg)
        self.assertEqual(trip.back.max_wait, 60)
        self.assertEqual(plan.rides, {"小陈": ("老王", "st:西站")})
        self.assertIn("18:45 从目的地出发", report)
        self.assertIn("小陈等 45分钟", report)

    def test_short_wait_is_fine_and_shown(self):
        _, plan, report = self.back(self.cfg(driver="18:20"))
        self.assertEqual(plan.rides, {"小陈": ("老王", "st:西站")})
        self.assertIn("小陈等 20分钟", report)

    def test_arrival_is_timed_from_the_drivers_leave_time(self):
        # 车主 18:30 走，西站 96 分钟，20:06 到；乘客的车 20:30 发，要在 19:50 前到：赶不上
        _, plan, _ = self.back(self.cfg(driver="18:30", train="G2 西站20:30→小陈家23:30"))
        self.assertEqual(plan.rides, {})
        _, plan, _ = self.back(self.cfg(driver="18:00", train="G2 西站20:30→小陈家23:30"))
        self.assertEqual(plan.rides, {"小陈": ("老王", "st:西站")})

    def test_taxi_leaves_at_own_time(self):
        late = self.cfg(train="G2 西站19:30→小陈家22:30")
        late["people"][0]["return_drives"] = False
        self.assertEqual(self.back(late)[1].stranded, ["小陈"])  # 18:00 走赶不上 19:30 的车（和不填离场时间时一样）
        early = self.cfg(train="G2 西站19:30→小陈家22:30", rider="17:00")
        early["people"][0]["return_drives"] = False
        trip, plan, report = self.back(early)
        self.assertEqual((plan.stranded, plan.taxi), ([], {"小陈": "st:西站"}))
        self.assertIn("17:00 从目的地一起打车去", report)

    def test_taxi_group_with_different_times_goes_separately(self):
        cfg = self.cfg(train="G2 西站22:30→a", rider="17:30", stations=["西站"])
        cfg["people"][0]["return_drives"] = False
        cfg["people"].append(person("小李", "113.0,35.0", return_trains={"西站": "G2 西站22:30→b"}, leave_time="19:00", stations=["西站"]))
        _, plan, report = self.back(cfg)
        self.assertEqual(plan.taxi, {"小陈": "st:西站", "小李": "st:西站"})
        self.assertEqual(plan.taxi_cars, 2)  # 差 90 分钟，各打各的车，各自从自己的离场时间出发
        self.assertIn("小陈 17:30 从目的地一起打车去", report)
        self.assertIn("小李 19:00 从目的地一起打车去", report)

    def test_party_uses_its_registered_time(self):
        for driver, carried in (("18:00", 0), ("18:30", 2)):  # 同行的一组 18:30 就绪：车主 18:00 就走了，带不上
            _, plan, _ = self.back(self.cfg(driver=driver, rider="18:30", party=2))
            self.assertEqual(plan.carried, carried, driver)

    def test_payload_and_share_page_show_each_cars_time(self):
        state = service.compute(self.cfg(driver="18:20"), FakeAmap())
        payload = service.plan_payload(state)
        self.assertEqual(payload["back"]["plans"][0]["routes"][0]["depart"], "18:20")
        html = share.render_share(state, 0, 0)
        self.assertIn("返程 · 18:00 散场后出发", html)  # 标题仍是默认的散场时间
        self.assertIn("你 18:00 离场，等 20分钟", html)
        self.assertRegex(html, r'<span class="t">18:20</span><span>从目的地出发')

    def test_bad_leave_time_is_rejected(self):
        for bad in ("25:00", "八点", "18:7"):
            with self.assertRaises(SystemExit, msg=bad) as ctx:
                carpool.load_trip(self.cfg(rider=bad), FakeAmap())
            self.assertIn("小陈的离场时间", str(ctx.exception))
        carpool.load_trip(self.cfg(rider="8:05"), FakeAmap())
        self.assertIsNone(carpool.load_trip(self.cfg(), FakeAmap()).people[1].leave)


class TaxiPoolTest(unittest.TestCase):
    """拼车省钱：没搭上车的人，在多花不超过上限的前提下尽量拼一辆；到站或离场时间相差太多的拆成两辆；一辆最多 4 人。"""

    def pair(self, **options):
        # 老王绕路上限只有默认的 30 分钟，接不了小李；小李的最快站是西站，小陈的是近站，但近站对小李也只多花 20.9 分钟
        cfg = config([person("老王", WANG, car_seats=3), person("小李", "116.5,30.4"), person("小陈", "114.0,34.0")], **options)
        plans, *_ = best_plan(cfg)
        return next(p for p in plans if not p.rides)

    def test_save_mode_pools_two_people_with_different_fastest_stations(self):
        save = self.pair()
        self.assertEqual(save.taxi, {"小李": "st:近站", "小陈": "st:近站"})
        self.assertEqual(save.taxi_cars, 1)
        fast = self.pair(taxi_mode="fast")
        self.assertEqual(fast.taxi, {"小李": "st:西站", "小陈": "st:近站"})
        self.assertEqual(fast.taxi_cars, 2)
        self.assertGreater(save.taxi_min, fast.taxi_min)  # 拼车省钱，但总分钟多了一点
        self.assertLess(save.taxi_ride, fast.taxi_ride)  # 车数 × 车程少了

    def test_extra_limit_is_respected(self):
        # 小李去近站多花 20.9 分钟，小陈去西站多花 10.6 分钟
        plan = self.pair(taxi_pool_extra_min=5)  # 两人都超过上限：不拼
        self.assertEqual((plan.taxi, plan.taxi_cars), ({"小李": "st:西站", "小陈": "st:近站"}, 2))
        plan = self.pair(taxi_pool_extra_min=11)  # 只有小陈能多走一点：一起去西站
        self.assertEqual((plan.taxi, plan.taxi_cars), ({"小李": "st:西站", "小陈": "st:西站"}, 1))
        plan = self.pair(taxi_pool_extra_min=21)  # 两个站都行：去近站，车程短一点，车费省一点
        self.assertEqual((plan.taxi, plan.taxi_cars), ({"小李": "st:近站", "小陈": "st:近站"}, 1))

    def test_bad_taxi_mode_is_rejected(self):
        with self.assertRaises(SystemExit) as ctx:
            carpool.load_trip(config([person("小陈", "114.0,34.0")], taxi_mode="cheap"), FakeAmap())
        self.assertIn("taxi_mode", str(ctx.exception))

    def riders_to_one_station(self, arrivals, **options):
        people = [person(f"乘客{i}", "114.0,34.0", trains={"近站": f"G{i} 07:00→{arr}"}) for i, arr in enumerate(arrivals)]
        plans, pts, T, trip = best_plan(config(people, stations=(("近站", NEAR),), **options))
        return plans[0], carpool.render(trip, pts, T, plans)

    def test_arrivals_far_apart_take_separate_cars(self):
        plan, report = self.riders_to_one_station(["10:00", "10:20"])  # 差 20 分钟，在 30 分钟以内：一辆
        self.assertEqual(plan.taxi_cars, 1)
        self.assertIn("乘客0、乘客1 坐高铁到 **近站**", report)
        plan, report = self.riders_to_one_station(["10:00", "11:05"])  # 差 65 分钟：两辆
        self.assertEqual(plan.taxi_cars, 2)
        self.assertEqual(report.count("**打车/包车组**"), 2)
        self.assertIn("约 10:15 在站汇合", report)
        self.assertIn("约 11:20 在站汇合", report)
        plan, _ = self.riders_to_one_station(["10:00", "10:20"], taxi_wait_min=10)  # 上限调小到 10 分钟：拆开
        self.assertEqual(plan.taxi_cars, 2)

    def test_more_than_four_people_split_into_cars(self):
        plan, report = self.riders_to_one_station(["10:00"] * 5)
        self.assertEqual(plan.taxi_cars, 2)
        self.assertEqual(report.count("**打车/包车组**"), 2)
        people = [person("大家", "114.0,34.0", party=3, trains={"近站": "G9 07:00→10:00"}),
                  person("甲", "114.0,34.0", trains={"近站": "G1 07:00→10:00"}), person("乙", "114.0,34.0", trains={"近站": "G2 07:00→10:00"})]
        plans, *_ = best_plan(config(people, stations=(("近站", NEAR),)))
        self.assertEqual(plans[0].taxi_cars, 2)  # 3 + 1 坐满一辆，同行的一组不拆开，剩下一个另一辆

    def test_people_without_trains_ride_with_anyone(self):
        people = [person("甲", "114.0,34.0", trains={"近站": "G1 07:00→10:00"}), person("乙", "114.0,34.0", stations=["近站"])]
        plans, pts, T, trip = best_plan(config(people, stations=(("近站", NEAR),)))
        self.assertEqual(plans[0].taxi_cars, 1)
        report = carpool.render(trip, pts, T, plans)
        self.assertIn("乙没填车次，按同一时间算", report)
        html = share.render_share(service.compute(config(people, stations=(("近站", NEAR),)), FakeAmap()), 0)
        self.assertIn("你没填车次，按同一时间算", html)

    def test_return_taxi_waits_only_if_the_train_can_still_be_caught(self):
        def cars(leave_b, train_a="G2 西站19:30→a"):
            people = [person("甲", "114.0,34.0", return_trains={"西站": train_a}, leave_time="17:00", stations=["西站"]),
                      person("乙", "113.0,35.0", return_trains={"西站": "G3 西站22:30→b"}, leave_time=leave_b, stations=["西站"])]
            c = config(people)
            c["return"] = {"enabled": True, "depart_time": "18:00"}
            trip, pts, T, _ = carpool.plan_trip(c, FakeAmap())
            return trip.back_plans[0], carpool.render(trip, pts, T, [])
        plan, report = cars("17:10")  # 乙晚 10 分钟，一起走：17:10 出发，甲要等 10 分钟
        self.assertEqual(plan.taxi_cars, 1)
        self.assertIn("甲、乙 17:10 从目的地一起打车去", report)
        self.assertIn("甲等 10分钟", report)
        plan, _ = cars("17:25")  # 一起走要 17:25 才出发，甲的 19:30 那趟（17:13 前必须出发）就赶不上了：拆开
        self.assertEqual(plan.taxi_cars, 2)

    def test_too_many_combinations_use_the_greedy_fallback(self):
        cfg = config([person("老王", WANG, car_seats=3), person("小李", "116.5,30.4"), person("小陈", "114.0,34.0")])
        with mock.patch("carpool.TAXI_COMBO_LIMIT", 1), mock.patch.object(carpool.TaxiPool, "_greedy", autospec=True,
                                                                       side_effect=carpool.TaxiPool._greedy) as greedy:
            plans, *_ = best_plan(cfg)
        self.assertTrue(greedy.called)
        plan = next(p for p in plans if not p.rides)
        self.assertEqual(plan.taxi, {"小李": "st:近站", "小陈": "st:近站"})  # 贪心也把人挪到已经有人去的站
        self.assertEqual(plan.stranded, [])

    def test_greedy_never_exceeds_the_extra_limit(self):
        stations = [(f"站{i}", f"{117.0 + 0.2 * i},{29.5 + 0.1 * i}") for i in range(8)]
        riders = [person(f"乘客{i}", f"{112.0 + i},{33.0 + i * 0.2}") for i in range(6)]
        with mock.patch("carpool.TAXI_COMBO_LIMIT", 10):
            plans, _, T, trip = best_plan(config(riders, stations=stations, taxi_pool_extra_min=20))
        opts = {p.name: carpool.rider_options(p, [s.name for s in trip.stations], trip.station_cost) for p in trip.people}
        cost = lambda name, stop: opts[name][stop] + T[(stop, "venue")]  # noqa: E731
        plan = plans[0]
        self.assertEqual(sorted(plan.taxi), sorted(opts))
        for name, stop in plan.taxi.items():  # 每个人比自己最快的走法多花的，不超过上限
            fastest = min(cost(name, s) for s in opts[name] if s.startswith("st:"))
            self.assertLessEqual(cost(name, stop), fastest + 20 + 1e-6, name)
        fast = best_plan(config(riders, stations=stations, taxi_mode="fast"))[0][0]
        self.assertLessEqual(plan.taxi_ride, fast.taxi_ride + 1e-6)  # 贪心的结果不会比各走最快的站更贵

    def test_rank_basis_shows_taxi_line_without_changing_the_ranking(self):
        cfg = config([person("老王", WANG, car_seats=3), person("小李", "116.5,30.4"), person("小陈", "114.0,34.0")])
        trip, pts, T, plans = carpool.plan_trip(cfg, FakeAmap())
        report = carpool.render(trip, pts, T, plans)
        plan = plans[-1]
        low, high = round(plan.taxi_ride * 2, -1), round(plan.taxi_ride * 3, -1)
        self.assertIn(f"打车：1 辆，粗估 {low:.0f}–{high:.0f} 元", report)
        no_taxi = carpool.rank_basis(carpool.Plan([], {}, {}, [], 0, 0, 0))
        self.assertEqual(len(no_taxi), 1)  # 没人打车就不显示这一行
        # 打车费只用来选站：方案之间还是按（搭车人数、总分钟、停车次数）排
        self.assertEqual([p.score for p in plans], sorted(p.score for p in plans))
        self.assertEqual(plans[0].score[:1], (-plans[0].carried,))

    def test_payload_and_share_page_describe_each_car(self):
        cfg = config([person("老王", WANG, car_seats=3), person("小李", "116.5,30.4"), person("小陈", "114.0,34.0")])
        state = service.compute(cfg, FakeAmap())
        payload = service.plan_payload(state)
        self.assertEqual([p["taxi_cars"] for p in payload["plans"]][-1], 1)
        html = share.render_share(state, 2)  # 第三个方案：两人都打车去近站
        self.assertIn("和 小陈 汇合，打车", html)
        self.assertIn("和 小李 汇合，打车", html)


class PartyTest(unittest.TestCase):
    """同行人数：一组人要么一起上同一辆车，要么一起打车。"""

    def best(self, seats, *riders):
        cfg = config([person("老王", WANG, car_seats=seats), *riders])
        trip, pts, T, plans = carpool.plan_trip(cfg, FakeAmap())
        return plans[0], carpool.render(trip, pts, T, plans)

    def test_group_is_not_split(self):
        plan, report = self.best(2, person("小陈一家", "114.0,34.0", party=3))
        self.assertEqual((plan.rides, plan.carried), ({}, 0))
        self.assertEqual(plan.taxi, {"小陈一家": "st:近站"})
        self.assertIn("小陈一家（3 人）", report)
        self.assertIn("打车粗估", report)
        plan, _ = self.best(3, person("小陈一家", "114.0,34.0", party=3))
        self.assertEqual((plan.rides, plan.carried), ({"小陈一家": ("老王", "st:西站")}, 3))

    def test_seats_counted_by_people(self):
        plan, report = self.best(3, person("甲家", "114.0,34.0", party=2), person("乙家", "113.0,35.0", party=2))
        self.assertEqual((len(plan.rides), plan.carried), (1, 2))
        self.assertIn("不开车的 4 人里，**2 人能搭上顺风车**", report)


class RuleSnapshotTest(unittest.TestCase):
    """规则快照：固定场景下前几个方案的顺序和各项数字。改了排序或成本口径，这里会失败。"""

    HINT = ("计算结果变了。如果是有意修改规则：更新期望值，把 RULES_VERSION 加一，"
            "并更新 /guide/method 和 CHANGELOG。")

    def check(self, plans, expected):
        got = [(tuple(s for r in p.routes for s in r.stops), p.rides, p.taxi, p.stranded, p.carried,
                round(p.detour, 1), round(p.cost, 1)) for p in plans]
        self.assertEqual(got, expected, self.HINT)

    def test_station_on_the_way(self):
        plans, *_ = best_plan(config([person("老王", WANG, car_seats=3), person("小陈", "114.0,34.0")]))
        self.check(plans, [
            (("st:西站",), {"小陈": ("老王", "st:西站")}, {}, [], 1, 0.0, 205.7),
            ((), {}, {"小陈": "st:近站"}, [], 0, 0.0, 291.4),
        ])

    def test_seat_shortage_sends_rest_to_taxi(self):
        plans, *_ = best_plan(config([
            person("老王", WANG, car_seats=1), person("小陈", "114.0,34.0"), person("小李", "113.0,35.0")]))
        self.check(plans, [
            (("st:西站",), {"小陈": ("老王", "st:西站")}, {"小李": "st:近站"}, [], 1, 0.0, 544.7),
            ((), {}, {"小陈": "st:近站", "小李": "st:近站"}, [], 0, 0.0, 630.4),
        ])

    def test_pickup_near_home_costs_detour(self):
        cfg = config([person("老王", WANG, car_seats=3, max_detour_min=60),
                      person("小李", "116.5,30.4"), person("小陈", "114.0,34.0")])
        plans, *_ = best_plan(cfg)
        self.check(plans, [
            (("home:小李", "st:西站"), {"小李": ("老王", "home:小李"), "小陈": ("老王", "st:西站")}, {}, [], 2, 34.7, 240.3),
            (("st:西站",), {"小李": ("老王", "st:西站"), "小陈": ("老王", "st:西站")}, {}, [], 2, 0.0, 257.5),
            (("home:小李",), {"小李": ("老王", "home:小李")}, {"小陈": "st:近站"}, [], 1, 23.7, 315.1),
        ])

    def test_detour_over_limit_drops_the_plan(self):
        plans, *_ = best_plan(config([
            person("老王", WANG, car_seats=3), person("小李", "116.5,30.4"), person("小陈", "114.0,34.0")]))
        # 第 2 版有意修改：最后一个方案里，小李不再走自己最快的西站，而是和小陈拼同一辆车去近站
        # （多花 20.9 分钟，没超过 30 分钟的上限；少一辆车）。总分钟 439.5 → 460.4。第 1 版的数字见下一个测试
        self.check(plans, [
            (("st:西站",), {"小李": ("老王", "st:西站"), "小陈": ("老王", "st:西站")}, {}, [], 2, 0.0, 257.5),
            (("home:小李",), {"小李": ("老王", "home:小李")}, {"小陈": "st:近站"}, [], 1, 23.7, 315.1),
            ((), {}, {"小李": "st:近站", "小陈": "st:近站"}, [], 0, 0.0, 460.4),
        ])

    def test_fast_mode_keeps_the_version_1_numbers(self):
        # taxi_mode = "fast"：各人仍走自己最快的站，打车的选站和总分钟和第 1 版一样
        plans, *_ = best_plan(config([
            person("老王", WANG, car_seats=3), person("小李", "116.5,30.4"), person("小陈", "114.0,34.0")], taxi_mode="fast"))
        self.check(plans, [
            (("st:西站",), {"小李": ("老王", "st:西站"), "小陈": ("老王", "st:西站")}, {}, [], 2, 0.0, 257.5),
            (("home:小李",), {"小李": ("老王", "home:小李")}, {"小陈": "st:近站"}, [], 1, 23.7, 315.1),
            ((), {}, {"小李": "st:西站", "小陈": "st:近站"}, [], 0, 0.0, 439.5),
        ])

    def test_party_counts_by_people(self):
        plans, *_ = best_plan(config([
            person("老王", WANG, car_seats=3), person("甲家", "114.0,34.0", party=2), person("乙家", "113.0,35.0", party=2)]))
        self.check(plans, [
            (("st:西站",), {"甲家": ("老王", "st:西站")}, {"乙家": "st:近站"}, [], 2, 0.0, 544.7),
            ((), {}, {"甲家": "st:近站", "乙家": "st:近站"}, [], 0, 0.0, 630.4),
        ])

    def test_return_trip_catching_train(self):
        cfg = config([person("老王", WANG, car_seats=3),
                      person("小陈", "114.0,34.0", return_trains={"西站": "G2 西站20:30→小陈家23:30"})])
        cfg["return"] = {"enabled": True, "depart_time": "18:00"}
        trip, *_ = carpool.plan_trip(cfg, FakeAmap())
        self.check(trip.back_plans, [
            (("st:西站",), {"小陈": ("老王", "st:西站")}, {}, [], 1, 0.0, 225.0),
            ((), {}, {"小陈": "st:西站"}, [], 0, 0.0, 321.3),
        ])

    def test_return_trip_missing_train_is_stranded(self):
        cfg = config([person("老王", WANG, car_seats=3),
                      person("小陈", "114.0,34.0", return_trains={"西站": "G2 西站19:30→小陈家22:30"})])
        cfg["return"] = {"enabled": True, "depart_time": "18:00"}
        trip, *_ = carpool.plan_trip(cfg, FakeAmap())
        self.check(trip.back_plans, [((), {}, {}, ["小陈"], 0, 0.0, 0.0)])

    def test_nobody_can_reach_a_station(self):
        plans, *_ = best_plan(config([
            person("老王", WANG, car_seats=3),
            person("小陈", "114.0,34.0", stations=["不存在站"], pickup_at_home=False)]))
        self.check(plans, [((), {}, {}, ["小陈"], 0, 0.0, 0.0)])


class RankBasisTest(unittest.TestCase):
    """报告里的「排序依据」和方案页页脚：分项之和要对得上，版本号和规则链接要在。"""

    BASIS = re.compile(r"排序依据：(\d+) 人搭车；总分钟 (\d+) = 车主多绕 (\d+) \+ 乘客到上车点 (\d+) \+ 打车组 (\d+)")

    def report(self, cfg):
        trip, pts, T, plans = carpool.plan_trip(cfg, FakeAmap())
        return carpool.render(trip, pts, T, plans), plans

    def cfg(self, **driver):
        return config([person("老王", WANG, car_seats=3, **driver), person("小李", "116.5,30.4"), person("小陈", "114.0,34.0")])

    def test_components_sum_to_displayed_total(self):
        report, plans = self.report(self.cfg(max_detour_min=60))
        found = self.BASIS.findall(report)
        self.assertEqual(len(found), len(plans))
        for carried, total, *parts in found:
            self.assertEqual(int(total), sum(map(int, parts)))
        for p in plans:  # 分项合计就是排序用的成本
            self.assertAlmostEqual(p.cost, p.detour + p.rider_min + p.taxi_min)

    def test_same_headcount_shows_signed_component_changes(self):
        report, _ = self.report(self.cfg(max_detour_min=60))
        self.assertIn("和推荐方案比：总分钟多 17（车主多绕 −35，乘客到上车点 +52）", report)

    def test_fewer_riders_shows_headcount_change(self):
        report, _ = self.report(self.cfg())
        self.assertIn("和推荐方案比：少 1 人搭车", report)
        self.assertNotIn("和推荐方案比：总分钟", report)

    def test_tie_on_minutes_names_the_stop_difference(self):
        best = carpool.Plan([carpool.Route("甲", ("st:a",), 10, 0)], {}, {}, [], 0, 10, 1, 10, 0)
        other = carpool.Plan([carpool.Route("甲", ("st:a", "st:b"), 10, 0)], {}, {}, [], 0, 10, 1, 10, 0)
        self.assertEqual(carpool.rank_basis(other, best)[1], "和推荐方案比：总分钟相同，停车多 1 次")

    def test_return_plans_have_basis_and_rules_note(self):
        cfg = self.cfg()
        cfg["people"][2]["return_trains"] = {"西站": "G2 西站20:30→小陈家23:30"}
        cfg["return"] = {"enabled": True, "depart_time": "18:00"}
        report, _ = self.report(cfg)
        back = report.split("## 返程（")[1].split("## 候选站对比")[0]
        self.assertIn("排序依据：2 人搭车", back)
        self.assertIn("和推荐方案比：", back)
        self.assertIn(f"方案按计算规则第 {carpool.RULES_VERSION} 版排序", report)
        self.assertIn("https://carpool.eigentime.org/guide/method", report)

    def test_share_page_footer_links_to_rules(self):
        html = share.render_share(service.compute(self.cfg(), FakeAmap()), 0)
        self.assertIn(f"按公开的计算规则（第 {carpool.RULES_VERSION} 版）排序", html)
        self.assertIn('href="https://carpool.eigentime.org/guide/method" target="_blank" rel="noopener">怎么算的</a>', html)

    def test_demo_page_footer_matches_share_template(self):
        html = (Path(__file__).parent / "web" / "demo.html").read_text(encoding="utf-8")
        self.assertIn(f"按公开的计算规则（第 {carpool.RULES_VERSION} 版）排序", html)
        self.assertIn('href="https://carpool.eigentime.org/guide/method"', html)


class MethodPageTest(unittest.TestCase):
    """规则说明页 /guide/method 和代码对得上：默认值表、版本号。"""

    @classmethod
    def setUpClass(cls):
        cls.html = (Path(__file__).parent / "web" / "pages" / "guide-method.html").read_text(encoding="utf-8")

    @staticmethod
    def table_mismatches(html: str, defaults: dict) -> list[str]:
        """规则页默认值表和一组默认值对不上的地方（空表示一致）。"""
        cells = re.findall(r'<td[^>]*data-default="(\w+)"[^>]*>(.*?)</td>', html)
        page = {key: re.search(r"\d+:\d+|\d+|[a-z]+", re.sub(r"<[^>]+>", "", text)).group(0) for key, text in cells}
        out = [f"默认值表里 {key} 重复" for key in {k for k, _ in cells if [c for c, _ in cells].count(k) > 1}]
        want = {k: str(v) for k, v in defaults.items()}
        out += [f"{k}：页面 {page[k]}，定义 {want[k]}" for k in want if k in page and page[k] != want[k]]
        out += [f"{k} 定义里有，规则页没列" for k in want if k not in page]
        out += [f"{k} 规则页列了，定义里没有" for k in page if k not in want]
        return out

    def test_default_table_matches_code(self):
        self.assertEqual(self.table_mismatches(self.html, carpool.DEFAULTS), [])

    def test_changing_a_default_in_config_fields_is_caught_by_the_page_check(self):
        fields = {k: dict(v) for k, v in carpool.FIELDS.items()}
        fields["options.max_stops"]["default"] = 3  # 只改 config-fields.json 里的一个默认值
        changed = carpool.defaults_from(fields)
        self.assertEqual(changed["max_stops"], 3)  # DEFAULTS 跟着变
        self.assertEqual(len(self.table_mismatches(self.html, changed)), 1)  # 规则页没跟着改，测试能报出来
        self.assertIn("max_stops", self.table_mismatches(self.html, changed)[0])

    @staticmethod
    def suggest_table_mismatches(html: str, fields: dict) -> list[str]:
        """规则页「推荐车站怎么找」的设置表和 config-fields.json 里 options.suggest.* 对不上的地方（空表示一致）。"""
        text = lambda s: re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", s)).strip()
        defaults = {k: text(v) for k, v in re.findall(r'<td[^>]*data-suggest-default="([\w.]+)"[^>]*>(.*?)</td>', html)}
        ranges = {k: text(v) for k, v in re.findall(r'<td[^>]*data-suggest-range="([\w.]+)"[^>]*>(.*?)</td>', html)}
        out = []
        for path, f in fields.items():
            if not path.startswith("options.suggest."):
                continue
            kind, v = f["type"], f.get("default")
            if kind == "boolean":
                want, parts = ("开" if v else "关"), ["开", "关"]
            elif kind in ("number", "integer"):
                want, parts = f"{v:g} {f['unit']}", [f"{f['min']:g}–{f['max']:g} {f['unit']}"]
            elif kind == "choice":
                want, parts = next(c["label"] for c in f["choices"] if c["value"] == v), [c["label"] for c in f["choices"]]
            elif kind == "multi":
                want, parts = "、".join(c["label"] for c in f["choices"] if c["value"] in v), [c["label"] for c in f["choices"]]
            else:  # list：没有固定默认值，写 default_note
                want, parts = f["default_note"], []
            if path not in defaults:
                out.append(f"{path} 定义里有，规则页没列")
                continue
            if defaults[path] != want:
                out.append(f"{path}：页面默认值「{defaults[path]}」，定义「{want}」")
            out += [f"{path}：可选范围里没有「{p}」" for p in parts if p not in ranges.get(path, "")]
            if f.get("hint") and f["hint"] not in ranges.get(path, ""):
                out.append(f"{path}：提示「{f['hint']}」没写")
        out += [f"{k} 规则页列了，定义里没有" for k in defaults if k not in fields]
        return out

    def test_suggest_table_matches_config_fields(self):
        self.assertEqual(self.suggest_table_mismatches(self.html, carpool.FIELDS), [])
        self.assertEqual(len(re.findall(r"data-suggest-default=", self.html)), len([p for p in carpool.FIELDS if p.startswith("options.suggest.")]))

    def test_changing_a_suggest_default_is_caught_by_the_page_check(self):
        fields = {k: dict(v) for k, v in carpool.FIELDS.items()}
        fields["options.suggest.dest_radius_km"]["default"] = 100
        fields["options.suggest.route_cover"]["default"] = "detour"
        fields["options.suggest.drivers"]["default_note"] = "第一位车主"
        self.assertEqual(len(self.suggest_table_mismatches(self.html, fields)), 3)

    def test_page_names_the_current_version(self):
        self.assertIn(f"第 {carpool.RULES_VERSION} 版", self.html)

    def test_defaults_are_what_the_loader_uses(self):
        trip = carpool.load_trip(config([person("小陈", "114.0,34.0")]), FakeAmap())
        d = carpool.DEFAULTS
        self.assertEqual((trip.max_stops, trip.station_cost, trip.exit_buffer, trip.travel_time),
                         (d["max_stops"], d["station_cost_min"], d["exit_buffer_min"], d["travel_time"]))
        self.assertEqual(trip.people[0].max_detour, d["max_detour_min"])
        cfg = config([person("小陈", "114.0,34.0", trains={"西站": "G1 07:00→10:00"})])
        self.assertEqual(carpool.load_trip(cfg, FakeAmap()).people[0].rail_min, {"西站": 180 + d["station_access_min"]})
        cfg["return"] = {"enabled": True, "depart_time": "18:00"}
        self.assertEqual(carpool.load_trip(cfg, FakeAmap()).back.margin, d["security_min"])
        self.assertEqual(carpool.load_trip(cfg, FakeAmap()).back.max_wait, d["max_wait_min"])


class ConfigFieldsTest(unittest.TestCase):
    """config-fields.json 是配置项的唯一定义：DEFAULTS 由它生成，示例配置里的每一项它都要有。"""
    ROOT = Path(__file__).parent

    # 改成从文件生成之前的 DEFAULTS，原样固定下来：键和值都不能变（变了就是改了规则，要升 RULES_VERSION）
    OLD_DEFAULTS = {
        "max_detour_min": 30, "max_stops": 2, "station_cost_min": 60, "station_access_min": 45, "exit_buffer_min": 15,
        "security_min": 40, "max_wait_min": 30, "taxi_mode": "save", "taxi_pool_extra_min": 30, "taxi_wait_min": 30,
        "discover_radius_km": 120, "discover_limit": 10, "travel_time": "08:00",
    }

    def test_defaults_are_unchanged(self):
        self.assertEqual(carpool.DEFAULTS, self.OLD_DEFAULTS)
        self.assertEqual({type(v) for v in carpool.DEFAULTS.values()}, {type(v) for v in self.OLD_DEFAULTS.values()})

    def test_definitions_are_well_formed(self):
        raw = json.loads((self.ROOT / "config-fields.json").read_text(encoding="utf-8"))
        paths = [f["path"] for f in raw["fields"]]
        self.assertEqual(len(paths), len(set(paths)), "路径重复")
        table_keys = [f["path"].rsplit(".", 1)[-1] for f in raw["fields"] if f.get("rules_table")]
        self.assertEqual(len(table_keys), len(set(table_keys)), "规则页默认值表的键重复")
        for f in raw["fields"]:
            self.assertIn(f["section"], raw["sections"], f["path"])
            self.assertIn(f["type"], {"text", "number", "integer", "boolean", "time", "date", "choice", "multi", "list", "map"}, f["path"])
            self.assertTrue(f["label"], f["path"])
            if f.get("rules_table"):
                self.assertIn("default", f, f["path"])
            if "min" in f and "max" in f:
                self.assertLessEqual(f["min"], f["max"], f["path"])
            if "default" in f and "min" in f and isinstance(f["default"], (int, float)) and not isinstance(f["default"], bool):
                self.assertGreaterEqual(f["default"], f["min"], f["path"])
                self.assertLessEqual(f["default"], f.get("max", f["default"]), f["path"])
            if f["type"] in ("choice", "multi"):
                values = [c["value"] for c in f["choices"]]
                defaults = f.get("default") if f["type"] == "multi" else [f.get("default")]
                self.assertTrue(set(defaults) <= set(values), f["path"])
            if "default_from" in f:
                self.assertIn(f["default_from"], carpool.FIELDS, f["path"])

    def test_suggest_settings_are_defined_per_plan(self):
        f = carpool.FIELDS
        want = {"route_cover": "along", "alt_routes": False, "max_searches": 80, "dest_radius_km": 90, "home_radius_km": 30,
                "route_step_km": 30, "route_radius_km": 25, "show_count": 15, "checked_count": 6, "filter_12306": True,
                "route_strategy": 0, "sort": "detour", "over_limit": "show"}
        for key, value in want.items():
            self.assertEqual(f[f"options.suggest.{key}"]["default"], value, key)
        self.assertEqual([c["value"] for c in f["options.suggest.route_cover"]["choices"]], ["along", "detour"])
        self.assertEqual((f["options.suggest.max_searches"]["min"], f["options.suggest.max_searches"]["max"]), (20, 200))
        self.assertFalse(any(x.get("rules_table") for p, x in f.items() if p.startswith("options.suggest.")))

    def test_loader_reads_the_fields_file(self):
        fields = carpool.load_fields(self.ROOT / "config-fields.json")
        self.assertEqual(fields, carpool.FIELDS)
        self.assertEqual(carpool.defaults_from(fields), carpool.DEFAULTS)

    @staticmethod
    def example_keys() -> set[str]:
        """trip.example.toml 里出现的配置项（含被注释掉的示例行），按所在分段写成定义里的路径。"""
        section, keys = "", set()
        for line in (Path(__file__).parent / "trip.example.toml").read_text(encoding="utf-8").splitlines():
            m = re.match(r"^#?\s*\[\[?([\w.]+)\]\]?\s*(#.*)?$", line)
            if m:
                section = m.group(1)
                continue
            m = re.match(r"^#?\s*([a-z_0-9]+)\s*=", line)
            if m:
                keys.add({"people": "people[]", "stations": "stations[]"}.get(section, section) + "." + m.group(1))
        return keys

    def test_every_key_in_the_example_config_is_defined(self):
        keys = self.example_keys()
        self.assertIn("options.taxi_wait_min", keys)  # 确认解析到了被注释掉的示例行
        self.assertIn("people[].leave_time", keys)
        self.assertIn("return.security_min", keys)
        self.assertEqual({k for k in keys if k.startswith("options.suggest.")}, {p for p in carpool.FIELDS if p.startswith("options.suggest.")})
        self.assertEqual(sorted(k for k in keys if k not in carpool.FIELDS), [])

    def test_every_key_the_loader_reads_is_defined(self):
        src = (Path(__file__).parent / "carpool.py").read_text(encoding="utf-8")
        back = src[src.index("def back_leg"):src.index("def train_times")]
        read = [("options", k) for k in re.findall(r'\bopt\.get\("(\w+)"', src)]
        read += [("return", k) for k in re.findall(r'\br\.get\("(\w+)"', back)]
        places = src[src.index("def leave_time"):src.index("def load_trip")]
        read += [("venue", k) for k in re.findall(r'\bv\.get\("(\w+)"', places)]
        read += [("people[]", k) for k in re.findall(r'\bp\.get\("(\w+)"', places) + re.findall(r'\bp\["(\w+)"\]', places)]
        self.assertGreater(len(read), 20)
        self.assertEqual(sorted({f"{s}.{k}" for s, k in read if f"{s}.{k}" not in carpool.FIELDS}), [])


class SuggestGeometryTest(unittest.TestCase):
    """找站的搜索圈：圈和圈之间没有空当。"""

    def covered(self, circles, p):
        return any(km_between(c, p) <= r for c, r in circles)

    def test_dest_disc_has_no_gap(self):
        rnd = random.Random(7)
        for lat in (30.0, 55.0):
            venue = Place("", 118.0, lat)
            for radius in (40, 51, 100, 150):
                circles = [(Place("", c.lng, c.lat), r) for c, r in service.dest_circles(venue, radius)]
                self.assertEqual(len(circles) == 1, radius <= 50)
                self.assertTrue(all(r <= 50 for _, r in circles))
                for _ in range(1500):  # 圆内随机取点
                    d, a = radius * math.sqrt(rnd.random()), rnd.random() * 2 * math.pi
                    p = Place("", venue.lng + d * math.sin(a) / (111.195 * math.cos(math.radians(lat))), lat + d * math.cos(a) / 111.195)
                    if km_between(p, venue) <= radius:
                        self.assertTrue(self.covered(circles, p), (lat, radius, p))

    def test_route_samples_cover_the_corridor_end_to_end(self):
        a, b = Place("", 116.0, 30.0), Place("", 121.0, 31.5)
        path = FakeAmap().drive_path([a, b])
        for step, radius in ((30, 25), (40, 21), (60, 31)):
            samples = service.route_samples(path, step)
            self.assertEqual((samples[0].lat, samples[0].lng), tuple(path[0]))  # 首尾都取
            self.assertEqual((samples[-1].lat, samples[-1].lng), tuple(path[-1]))
            for p, q in zip(samples, samples[1:]):
                self.assertLessEqual(km_between(p, q), step * 1.001)
            r, width = service.route_radius(step, radius)
            self.assertAlmostEqual(width, math.sqrt(r * r - (step / 2) ** 2))
            rnd = random.Random(step)
            for _ in range(800):  # 路线两侧 width 以内的点都要在某个圈里
                lat, lng = path[rnd.randrange(len(path))]
                off = (rnd.random() * 2 - 1) * width * 0.99
                p = Place("", lng, lat + off / 111.195)
                self.assertTrue(self.covered([(s, r) for s in samples], p), (step, off))

    def test_route_radius_is_raised_until_circles_connect(self):
        self.assertEqual(service.route_radius(40, 10)[0], 21)  # 10 不到间隔的一半，调到刚好连得上
        self.assertEqual(service.route_radius(40, 20)[0], 21)  # 恰好等于一半也只是相切
        self.assertEqual(service.route_radius(30, 25)[0], 25)
        self.assertEqual(service.route_radius(60, 60)[0], 50)  # 高德最大 50 公里

    def test_detour_ellipse_has_no_gap(self):
        rnd = random.Random(3)
        for home, venue, limit in ((Place("", 116.0, 30.0), Place("", 118.0, 30.0), 30), (Place("", 100.0, 40.0), Place("", 116.0, 39.0), 60),
                                   (Place("", 120.58, 31.3), Place("", 121.47, 31.23), 20)):
            route_km = km_between(home, venue) * 1.2
            circles = [(c, 50) for c in service.detour_circles(home, venue, route_km, limit)]
            total = route_km + 2 * limit
            hit = 0
            for _ in range(4000):  # 椭圆（家到站 + 站到目的地 ≤ 路程 + 2·绕路上限）里随机取点
                p = Place("", min(home.lng, venue.lng) - 3 + rnd.random() * (abs(home.lng - venue.lng) + 6),
                          min(home.lat, venue.lat) - 3 + rnd.random() * (abs(home.lat - venue.lat) + 6))
                if km_between(home, p) + km_between(p, venue) <= total:
                    hit += 1
                    self.assertTrue(self.covered(circles, p), (home, p))
            self.assertGreater(hit, 100)


    def test_detour_ellipse_is_bounded_by_time_when_direct_route_is_slow(self):
        # 直达 150 公里却要 250 分钟（慢），绕路上限 10 分钟：经过某站的路再快，直线距离之和也可以到 2·(250+10) 公里
        home, venue, route_km, route_min, limit = Place("", 116.0, 30.0), Place("", 117.5, 30.0), 150, 250, 10
        new = [(c, 50) for c in service.detour_circles(home, venue, route_km, limit, route_min)]
        old = [(c, 50) for c in service.detour_circles(home, venue, route_km, limit)]  # 只按路程：路程 + 2·绕路分钟数
        rnd = random.Random(11)
        hit = leak = 0
        for _ in range(6000):
            p = Place("", 112 + rnd.random() * 9.5, 27 + rnd.random() * 6)
            if km_between(home, p) + km_between(p, venue) <= 2 * (route_min + limit):
                hit += 1
                self.assertTrue(self.covered(new, p), p)
                leak += not self.covered(old, p)
        self.assertGreater(hit, 300)
        self.assertGreater(leak, 0)  # 旧上界在这里会漏
        # 直达很快、路程更大时仍取路程那一项
        fast = service.detour_circles(home, venue, 400, 10, 100)
        self.assertEqual(len(fast), len(service.detour_circles(home, venue, 400, 10)))


class SuggestTest(unittest.TestCase):
    """找站：关键词、翻页、上限、过滤留痕、每位车主各自的绕路、排序和估算。"""

    def cfg(self, people=None, stations=(), **suggest):
        return config(people or [person("老王", WANG, car_seats=3, max_detour_min=30), person("小陈", "114.0,34.0")], stations=stations, suggest=suggest)

    def pois(self, *pairs):
        return [{"name": n, "location": loc, "typecode": "150200"} for n, loc in pairs]

    def test_requests_carry_keyword_and_page(self):
        amap = carpool.Amap("k")
        path, params = amap.around_query(Place("", 118, 30), 30)
        self.assertEqual((path, params["keywords"], params["types"], params["page_size"]), ("/v5/place/around", "火车站", "150200", 25))
        self.assertNotIn("page_num", params)
        self.assertEqual(amap.around_query(Place("", 118, 30), 30, 2)[1]["page_num"], 2)
        calls = []
        amap._get = lambda path, **p: calls.append((path, p)) or {"pois": []}
        amap.stations_near(Place("", 118, 30), 80)
        self.assertEqual([c[0] for c in calls], ["/v5/place/around", "/v5/place/polygon"])  # 自动找站的两种请求都带关键词
        self.assertTrue(all(c[1]["keywords"] == "火车站" for c in calls))

    def test_route_strategy_and_alt_routes(self):
        self.assertEqual([carpool.route_strategy(s, a) for s, a in ((0, False), (0, True), (12, True), (19, False))], [0, 10, 12, 19])
        amap = carpool.Amap("k")
        self.assertNotIn("strategy", amap.driving_query([Place("", 1, 2), Place("", 3, 4)])[1])
        self.assertEqual(amap.driving_query([Place("", 1, 2), Place("", 3, 4)], 10)[1]["strategy"], 10)
        seen = []
        paths = [{"distance": str(1000 * k), "steps": [{"polyline": f"1,{k};2,{k}"}]} for k in (1, 2, 3)]
        amap._get = lambda path, **p: seen.append(p) or {"route": {"paths": paths}}
        one = amap.drive_routes([Place("", 1, 2), Place("", 3, 4)])
        self.assertEqual((len(one), "strategy" in seen[0]), (1, False))
        alt = amap.drive_routes([Place("", 1, 2), Place("", 3, 4)], alt=True)
        self.assertEqual((len(alt), seen[1]["strategy"], alt[1]["km"], alt[2]["path"][0]), (3, 10, 2.0, [3.0, 1.0]))

    def test_pages_stop_when_not_full_and_mark_truncated_after_three(self):
        def full(n):
            return lambda c, r, page: [{"name": f"甲{page}{i:02d}站", "location": VENUE, "typecode": "150200"} for i in range(n(page))]
        amap = FakeAmap(around=full(lambda page: 25 if page == 1 else 3))
        out = service.suggest_stations(self.cfg(areas=["dest"], dest_radius_km=40), amap)
        self.assertEqual([c[2] for c in amap.around_calls], [1, 2])
        self.assertEqual((out["summary"]["searches"], out["summary"]["truncated"], out["summary"]["found"]), (2, [], 28))
        amap = FakeAmap(around=full(lambda page: 25))
        out = service.suggest_stations(self.cfg(areas=["dest"], dest_radius_km=40, show_count=5), amap)
        self.assertEqual([c[2] for c in amap.around_calls], [1, 2, 3])  # 最多 3 页
        self.assertEqual((out["summary"]["truncated"], out["summary"]["found"]), (["目的地附近"], 75))
        self.assertTrue(any("可能没列全" in n for n in out["notes"]))

    def test_pages_are_prefetched_in_batches(self):
        class Rec(carpool.Amap):
            def __init__(self):
                super().__init__("k")
                self.batches, self.gets = [], []

            def prefetch(self, queries):
                self.batches.append([q[1].get("page_num", 1) for q in queries])

            def _get(self, path, **params):
                self.gets.append(path)
                return {"pois": [{"name": f"候车室{i}", "location": VENUE} for i in range(25)]}  # 都是子点：整页满、全部被过滤

        amap = Rec()
        cfg = self.cfg(areas=["dest", "owner_home"], dest_radius_km=40)
        cfg["people"] = [person("老王", WANG, car_seats=3)]
        out = service.suggest_stations(cfg, amap)
        self.assertEqual([b for b in amap.batches if b], [[1, 1], [2, 2], [3, 3]])  # 先批量取第一页，满页的再批量取下一页
        self.assertEqual(out["summary"]["searches"], 6)
        self.assertEqual(out["summary"]["truncated"], ["目的地附近", "老王出发地附近"])

    def test_search_cap_stops_and_says_so(self):
        amap = FakeAmap()
        out = service.suggest_stations(self.cfg(areas=["dest", "owner_home", "rider_home"], dest_radius_km=150, max_searches=20), amap)
        self.assertGreater(out["summary"]["circles"], 20)
        self.assertEqual((len(amap.around_calls), out["summary"]["searches"], out["summary"]["cap_hit"]), (20, 20, True))
        self.assertTrue(out["summary"]["unsearched"])  # 没搜的圈写明
        self.assertEqual(sum(1 for c in out["trace"]["circles"] if not c["searched"]), out["summary"]["circles"] - 20)
        self.assertTrue(any("单次上限" in n for n in out["notes"]))
        self.assertTrue(out["estimate"]["over_cap"])

    def test_cap_counts_pages_and_covers_every_circle_first(self):
        amap = FakeAmap(around=lambda c, r, page: [{"name": f"乙{page}{i:02d}站", "location": VENUE, "typecode": "150200"} for i in range(25)])
        out = service.suggest_stations(self.cfg(areas=["dest"], dest_radius_km=150, max_searches=20), amap)
        self.assertGreater(out["summary"]["circles"], 15)
        self.assertEqual(len(amap.around_calls), 20)
        self.assertEqual([c[2] for c in amap.around_calls].count(1), out["summary"]["circles"])  # 每个圈先取第一页，剩下的名额才翻页
        self.assertTrue(out["summary"]["cap_hit"])
        self.assertEqual(out["summary"]["unsearched"], [])
        self.assertTrue(out["summary"]["truncated"])  # 本该翻页却没搜的圈，算没列全

    def test_every_drop_reason_is_recorded(self):
        pois = self.pois(("西站", WEST), ("新站(建设中)", WEST), ("货运站", WEST), ("某线路所", WEST), ("陌生站", WEST), ("老站", WEST),
                         ("北站进站口", WEST), ("公交站", WEST))
        pois[-1]["typecode"] = "150500"
        cfg = self.cfg(areas=["dest"], dest_radius_km=100, stations=(("老站", "117.9,30.0"),))
        amap = FakeAmap(pois=pois)
        out = service.suggest_stations(cfg, amap, valid_names={"西", "老"})
        self.assertEqual([s["name"] for s in out["stations"]], ["西站"])
        reasons = {d["name"]: d["reason"] for d in out["dropped"]}
        self.assertEqual(reasons["新站(建设中)"], "建设中")  # 状态直接当原因，汇总里写「建设中 1 个」
        self.assertEqual(carpool.reject_reason({"name": "某站(东广场)"}), "站名带标注「东广场」")
        self.assertIn("货运", reasons["货运站"])
        self.assertIn("不像火车站", reasons["某线路所"])
        self.assertIn("12306", reasons["陌生站"])
        self.assertIn("候选站", reasons["老站"])
        self.assertIn("进站", reasons["北站进站口"])
        self.assertIn("类型", reasons["公交站"])
        self.assertTrue(all(d["where"] for d in out["dropped"]))
        self.assertEqual(sum(out["summary"]["dropped"].values()), 7)
        off = service.suggest_stations({**cfg, "options": {"suggest": {"areas": ["dest"], "dest_radius_km": 100, "filter_12306": False}}}, amap, valid_names={"西"})
        self.assertIn("陌生站", [s["name"] for s in off["stations"]])  # 关掉过滤就不再查 12306
        self.assertTrue(any("12306" in n for n in off["notes"]))

    def test_unreachable_driver_is_skipped_and_said(self):
        cfg = self.cfg([person("老王", WANG, car_seats=3), person("老李", "116.0,31.0", car_seats=3), person("小陈", "114.0,34.0")],
                       areas=["owner_route"])
        amap = FakeAmap(pois=self.pois(("西站", WEST)), routes_fail={"老王"})
        out = service.suggest_stations(cfg, amap)
        self.assertEqual([s["driver"] for s in out["summary"]["skipped_drivers"]], ["老王"])
        self.assertEqual({c["where"].split("路")[0] for c in out["trace"]["circles"]}, {"老李"})
        self.assertTrue(any(d["name"] == "老王" and "路线查不到" in d["reason"] for d in out["dropped"]))
        self.assertEqual([r["driver"] for r in out["trace"]["routes"]], ["老李"])

    def test_each_driver_detour_limit_order_and_checked(self):
        near_far = self.pois(("近站", NEAR), ("西站", WEST))
        people = [person("老王", WANG, car_seats=3, max_detour_min=30), person("老周", "120.0,30.0", car_seats=3, max_detour_min=300)]
        out = service.suggest_stations(self.cfg(people, areas=["dest"], dest_radius_km=100), FakeAmap(pois=near_far))
        rows = {r["name"]: r for r in out["stations"]}
        west = rows["西站"]["detours"]
        self.assertEqual([(d["driver"], d["limit"], d["over"]) for d in west], [("老王", 30, False), ("老周", 300, False)])
        self.assertEqual(west[0]["minutes"], 0)
        self.assertEqual(rows["西站"]["best"], {"driver": "老王", "detour": 0})
        # 都超过上限：老周的上限也调小
        people[1]["max_detour_min"] = 50
        out = service.suggest_stations(self.cfg(people, areas=["dest"], dest_radius_km=100), FakeAmap(pois=near_far))
        west, near = out["stations"]
        self.assertEqual((west["name"], west["over_all"], west["checked"]), ("西站", False, True))  # 老王不绕路，可用
        self.assertEqual((near["name"], near["over_all"], near["checked"]), ("近站", True, False))  # 排在后面，不默认勾选
        self.assertTrue(all(d["over"] for d in near["detours"]))
        hide = service.suggest_stations(self.cfg(people, areas=["dest"], dest_radius_km=100, over_limit="hide"), FakeAmap(pois=near_far))
        self.assertEqual([s["name"] for s in hide["stations"]], ["西站"])
        self.assertEqual([(m["name"], "上限" in m["reason"]) for m in hide["more"]], [("近站", True)])
        # 到目的地最近的站，所有人都超限时也排在可用的后面
        by_dest = service.suggest_stations(self.cfg(people, areas=["dest"], dest_radius_km=100, sort="dest"), FakeAmap(pois=near_far))
        self.assertEqual([s["name"] for s in by_dest["stations"]], ["西站", "近站"])

    def test_three_sorts_show_count_and_checked_count(self):
        pois = self.pois(("近站", NEAR), ("西站", WEST), ("东站", "118.0,29.5"))
        people = [person("老王", WANG, car_seats=3, max_detour_min=900), person("小陈", "118.0,31.0")]
        run = lambda **s: service.suggest_stations(self.cfg(people, areas=["dest", "rider_home"], dest_radius_km=100, **s), FakeAmap(pois=pois))
        names = lambda out: [r["name"] for r in out["stations"]]
        self.assertEqual(names(run(sort="detour"))[0], "西站")  # 车主不用绕路
        self.assertEqual(names(run(sort="dest")), ["东站", "近站", "西站"])  # 东站 55 公里，近站 89，西站 96
        out = run(sort="rider_home")  # 小陈在目的地正北 111 公里
        self.assertEqual(names(out), ["近站", "西站", "东站"])
        self.assertAlmostEqual(out["stations"][0]["rider_km"], km_between(Place("", 118, 30.8), Place("", 118, 31)), delta=0.1)
        small = run(show_count=5, checked_count=1)
        self.assertEqual([r["checked"] for r in small["stations"]], [True, False, False])
        out = service.suggest_stations(self.cfg(people, areas=["dest"], dest_radius_km=100, sort="rider_home"), FakeAmap(pois=pois))
        self.assertEqual(out["settings"]["sort"], "detour")  # 没找乘客出发地附近，回落并说明
        self.assertTrue(any("离乘客家最近" in n for n in out["notes"]))

    def test_more_lists_what_was_not_shown(self):
        pois = [{"name": f"丙{i:02d}站", "location": f"118.{i:02d},30.0", "typecode": "150200"} for i in range(8)]
        out = service.suggest_stations(self.cfg(areas=["dest"], dest_radius_km=40, show_count=5), FakeAmap(pois=pois))
        self.assertEqual((len(out["stations"]), len(out["more"]), out["summary"]["found"]), (5, 3, 8))
        self.assertTrue(all("显示个数" in m["reason"] for m in out["more"]))
        self.assertEqual(out["summary"]["more"], {"超过显示个数": 3})
        self.assertEqual(sum(r["checked"] for r in out["stations"]), 5)  # 默认勾 6 个，但只显示 5 个，勾选个数夹到 5

    def test_settings_are_clamped_and_explained(self):
        st, notes = service.normalize_settings({"dest_radius_km": 9999, "max_searches": "abc", "sort": "乱写", "areas": ["dest", "zzz"],
                                                "checked_count": 99, "show_count": 5, "route_step_km": 40, "route_radius_km": 10,
                                                "alt_routes": "yes", "route_strategy": "12", "drivers": "老王", "over_limit": True})
        self.assertEqual((st["dest_radius_km"], st["max_searches"], st["sort"], st["areas"]), (150, 80, "detour", ["dest"]))
        self.assertEqual((st["checked_count"], st["alt_routes"], st["route_strategy"], st["drivers"], st["over_limit"]), (5, False, 12, [], "show"))
        self.assertEqual(st["route_radius_km"], 21)
        text = "；".join(notes)
        for part in ("超出", "不合法", "不认识的项", "默认勾选个数"):
            self.assertIn(part, text)
        defaults, notes = service.normalize_settings(None)
        self.assertEqual((notes, defaults), ([], {p.rsplit(".", 1)[1]: f.get("default", []) for p, f in carpool.FIELDS.items() if p.startswith("options.suggest.")}))
        self.assertEqual(service.normalize_settings({"areas": ["dest", "owner_route"], "route_step_km": 40, "route_radius_km": 10})[1][0],
                         "沿路范围从 10 公里调到 21 公里（相邻两圈才连得上）")

    def test_plan_only_makes_no_place_search(self):
        amap = FakeAmap(pois=self.pois(("西站", WEST)))
        cfg = self.cfg([person("老王", WANG, car_seats=3), person("老李", "116.0,31.0", car_seats=3), person("小陈", "114.0,34.0")])
        out = service.suggest_stations(cfg, amap, plan_only=True)
        self.assertEqual(amap.around_calls, [])  # 地点搜索 0 次
        self.assertEqual(len(amap.route_calls), 2)  # 只查车主路线
        self.assertEqual((out["stations"], out["more"], out["dropped"]), ([], [], []))
        est, circles = out["estimate"], out["trace"]["circles"]
        self.assertEqual((est["circles"], est["searches_min"], est["searches_max"], est["routes"]), (len(circles), len(circles), 3 * len(circles), 2))
        self.assertEqual({c["kind"] for c in circles}, {"dest", "home", "route"})
        self.assertEqual(len(out["trace"]["routes"]), 2)
        self.assertGreater(out["trace"]["corridor_km"], 0)
        self.assertEqual(est["over_cap"], len(circles) > 80)
        # 范围调大，估算超过上限
        big = service.suggest_stations({**cfg, "options": {"suggest": {"max_searches": 20, "dest_radius_km": 150}}}, FakeAmap(), plan_only=True)
        self.assertTrue(big["estimate"]["over_cap"])
        self.assertTrue(any("超过单次上限" in n for n in big["notes"]))
        # 估算和实际一致：圈数相同
        real = service.suggest_stations(cfg, amap)
        self.assertEqual(real["summary"]["circles"], est["circles"])
        self.assertEqual(real["summary"]["searches"], len(amap.around_calls))

    def test_plan_only_skips_routes_when_not_searching_along_them(self):
        amap = FakeAmap()
        out = service.suggest_stations(self.cfg(areas=["dest", "owner_home"]), amap, plan_only=True)
        self.assertEqual((amap.route_calls, out["estimate"]["routes"], out["trace"]["corridor_km"]), ([], 0, None))

    def test_detour_cover_uses_each_drivers_route_and_limit(self):
        people = [person("老王", WANG, car_seats=3, max_detour_min=10), person("老周", "120.0,30.0", car_seats=3, max_detour_min=60)]
        amap = FakeAmap()
        out = service.suggest_stations(self.cfg(people, areas=["owner_route"], route_cover="detour"), amap, plan_only=True)
        by = {}
        for c in out["trace"]["circles"]:
            self.assertEqual((c["kind"], c["radius_km"]), ("detour", 50))
            by.setdefault(c["where"], 0)
            by[c["where"]] += 1
        self.assertEqual(set(by), {"老王绕路范围内", "老周绕路范围内"})
        self.assertEqual([c[2] for c in amap.route_calls], [False, False])  # 全覆盖不需要备选路线
        wang = out["trace"]["routes"][0]
        direct = service.detour_circles(Place("", 116, 30), Place("", 118, 30), wang["km"], 10, wang["minutes"])
        self.assertEqual(len(direct), by["老王绕路范围内"])  # 用的是高德给的里程和这位车主自己的上限
        self.assertIsNone(out["trace"]["corridor_km"])

    def test_routes_carry_minutes_and_missing_minutes_is_said(self):
        out = service.suggest_stations(self.cfg(areas=["owner_route"], route_cover="detour"), FakeAmap(), plan_only=True)
        self.assertEqual(out["trace"]["routes"][0]["minutes"], out["trace"]["routes"][0]["km"])  # 假高德 1 公里 1 分钟
        self.assertFalse(any("按路程估算" in n for n in out["notes"]))

        class NoMinutes(FakeAmap):
            def drive_routes(self, *a, **k):
                return [{**r, "minutes": None} for r in super().drive_routes(*a, **k)]

        out = service.suggest_stations(self.cfg(areas=["owner_route"], route_cover="detour"), NoMinutes(), plan_only=True)
        self.assertIsNone(out["trace"]["routes"][0]["minutes"])
        self.assertTrue(any("按路程估算，可能不全" in n for n in out["notes"]))
        try_route = browser.TryAmap().drive_routes([Place("", 116, 30), Place("", 118, 30)])[0]
        self.assertGreater(try_route["minutes"], 0)

    def test_default_dest_radius_is_seven_circles(self):
        out = service.suggest_stations(self.cfg(areas=["dest"]), FakeAmap(), plan_only=True)
        self.assertEqual((out["settings"]["dest_radius_km"], out["estimate"]["circles"]), (90, 7))

    def test_circles_inside_other_circles_are_not_searched(self):
        # 默认设置：沿路第一个点是车主家（在「出发地附近」的圈里），最后一个点是目的地（在目的地圈里）
        cfg = self.cfg([person("老王", WANG, car_seats=3)], areas=["dest", "owner_home", "owner_route"], dest_radius_km=40)
        amap = FakeAmap()
        out = service.suggest_stations(cfg, amap, plan_only=True)
        centers = [(c["lat"], c["lng"], c["kind"]) for c in out["trace"]["circles"]]
        self.assertEqual([k for *_, k in centers if k != "route"], ["dest", "home"])
        self.assertNotIn((30.0, 116.0, "route"), centers)
        self.assertNotIn((30.0, 118.0, "route"), centers)
        all_route = service.route_samples(amap.drive_path([Place("", 116, 30), Place("", 118, 30)]), 30)
        self.assertLess(len(centers) - 2, len(all_route))
        self.assertEqual(out["estimate"]["circles"], len(centers))
        real = service.suggest_stations(cfg, amap)
        self.assertEqual(len(amap.around_calls), len(centers))  # 没有多搜

    def test_station_on_route_kept_even_if_route_circle_is_absorbed(self):
        # 西站离目的地 96 公里，在默认 90 公里的目的地范围之外，但在老王路上
        pois = self.pois(("西站", WEST))
        out = service.suggest_stations(self.cfg(areas=["dest", "owner_route"]), FakeAmap(pois=pois))
        self.assertEqual([(s["name"], s["where"]) for s in out["stations"]], [("西站", "老王路上")])
        out = service.suggest_stations(self.cfg(areas=["dest"]), FakeAmap(pois=pois))
        self.assertEqual(out["stations"], [])

    def test_alt_routes_add_circles(self):
        one = service.suggest_stations(self.cfg(areas=["owner_route"]), FakeAmap(), plan_only=True)
        amap = FakeAmap()
        alt = service.suggest_stations(self.cfg(areas=["owner_route"], alt_routes=True), amap, plan_only=True)
        self.assertEqual([r["alt"] for r in one["trace"]["routes"]], [1])
        self.assertEqual([r["alt"] for r in alt["trace"]["routes"]], [1, 2])
        self.assertTrue(amap.route_calls[0][2])
        self.assertGreater(len(alt["trace"]["circles"]), len(one["trace"]["circles"]))
        self.assertTrue(any("备选路线2" in c["where"] for c in alt["trace"]["circles"]))

    def test_only_selected_drivers_and_riders_homes(self):
        people = [person("老王", WANG, car_seats=3), person("老李", "116.0,31.0", car_seats=3), person("小陈", "114.0,34.0")]
        out = service.suggest_stations(self.cfg(people, areas=["owner_home", "rider_home"], drivers=["老李", "路人"]), FakeAmap(), plan_only=True)
        self.assertEqual([(c["where"], c["kind"]) for c in out["trace"]["circles"]], [("老李出发地附近", "home"), ("小陈出发地附近", "rider")])
        self.assertTrue(any("路人" in n for n in out["notes"]))

    def test_return_only_follows_the_way_home(self):
        cfg = ReturnOnlyTest().cfg()
        cfg["stations"] = []
        cfg["options"]["suggest"] = {"areas": ["owner_route"]}
        amap = FakeAmap()
        service.suggest_stations(cfg, amap, plan_only=True)
        self.assertEqual(amap.route_calls[0][0][0].name, "目的地")  # 返程：从目的地出发回车主家

    def test_try_mode_estimates_but_refuses_to_search(self):
        amap = browser.TryAmap()
        cfg = self.cfg()
        out = service.suggest_stations(cfg, amap, plan_only=True)
        self.assertGreater(out["estimate"]["circles"], 0)
        self.assertEqual(out["trace"]["routes"][0]["path"][0], [30.0, 116.0])  # 路线按直线
        with self.assertRaises(carpool.AmapError) as cm:
            service.suggest_stations(cfg, amap)
        self.assertIn(browser.TryAmap.REFUSE, str(cm.exception))


class TomlTest(unittest.TestCase):
    def test_dump_roundtrips(self):
        cfg = {
            "venue": {"name": "饭店 \"引号\"", "location": VENUE},
            "options": {"max_detour_min": 30, "travel_date": "2026-05-01", "empty": ""},
            "stations": [{"name": "西站", "city": "邢台"}],
            "people": [
                {"name": "老王", "from": "a\nb", "car_seats": 3, "max_detour_min": 25.5},
                {"name": "小陈", "pickup_at_home": False, "rail_min": {"西站": 120, "近 站": 90}, "rail_est": {}},
            ],
        }
        got = tomllib.loads(carpool.dump_toml(cfg, "# 头注释\n"))
        del cfg["options"]["empty"], cfg["people"][1]["rail_est"]  # 空值不写
        self.assertEqual(got, cfg)


class DuplicateNameTest(unittest.TestCase):
    """计算内核按名字区分人：重名要在调用高德之前就拦住，并说清楚是第几位和第几位。"""

    def test_duplicate_names_rejected_before_any_amap_call(self):
        amap = FakeAmap()
        cfg = config([person("老王", WANG, car_seats=3), person("小陈", "114.0,34.0"), person("老王", "113.0,35.0")])
        with self.assertRaises(SystemExit) as ctx:
            carpool.plan_trip(cfg, amap)
        self.assertIn("第 1 位和第 3 位都叫「老王」", str(ctx.exception))
        self.assertEqual(amap.calls, 0)

    def test_names_compared_after_trimming(self):
        cfg = config([person("老王", WANG, car_seats=3), person(" 老王 ", "114.0,34.0")])
        with self.assertRaises(SystemExit):
            carpool.load_trip(cfg, FakeAmap())

    def test_distinct_names_and_blank_names_pass_the_check(self):
        carpool.check_unique_names([{"name": "甲"}, {"name": "乙"}, {"name": ""}, {"name": ""}])  # 空名字由别处报错，这里不管


class ShareStyleTest(unittest.TestCase):
    """方案页内嵌的设计变量要和 web/design.css 一致；页面自包含（沙箱里不能引用 /design.css）。"""

    CSS = (Path(__file__).parent / "web" / "design.css").read_text(encoding="utf-8")

    @staticmethod
    def parse(block: str) -> dict:
        return dict(re.findall(r"(--[\w-]+):\s*([^;]+);", block))

    def css_light(self) -> dict:
        return self.parse(re.search(r":root \{(.*?)\n\}", self.CSS, re.S).group(1))

    def css_dark(self) -> dict:
        media = re.search(r"@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme=light\]\) \{(.*?)\n  \}", self.CSS, re.S)
        manual = re.search(r":root\[data-theme=dark\] \{(.*?)\n\}", self.CSS, re.S)
        self.assertEqual(self.parse(media.group(1)), self.parse(manual.group(1)))  # design.css 里两段深色必须一致
        return self.parse(media.group(1))

    def test_variables_match_design_css(self):
        for name, mine, theirs in (("浅色", share.LIGHT, self.css_light()), ("深色", share.DARK, self.css_dark())):
            for var, value in mine.items():
                self.assertEqual(theirs.get(var), value, f"{name}变量 {var} 和 web/design.css 不一致")
        for var in ("--bg", "--surface", "--surface-2", "--line", "--ink", "--ink-2", "--ink-3", "--accent", "--accent-hover",
                    "--on-accent", "--drive", "--ride", "--taxi", "--dest", "--station"):  # 核心颜色必须都在
            self.assertIn(var, share.LIGHT)
            self.assertIn(var, share.DARK)

    def test_rendered_page_is_self_contained_dark_and_print_light(self):
        cfg = config([person("老王", WANG, car_seats=3), person("小陈", "114.0,34.0")])
        html = share.render_share(service.compute(cfg, FakeAmap()), 0)
        self.assertNotIn('href="/design.css"', html)  # 沙箱里只放行 cdnjs 和高德瓦片
        self.assertNotIn("@@", html)  # 占位都换掉了
        self.assertIn("prefers-color-scheme: dark", html)
        self.assertIn(f"--bg: {share.DARK['--bg']};", html)
        self.assertIn("var(--map-filter)", html)  # 深色下降低瓦片亮度，只作用在瓦片层
        print_css = html[html.index("@media print"):html.index("</style>")]
        self.assertIn(f"--bg: {share.LIGHT['--bg']};", print_css)  # 打印时强制回到浅色
        for text in ("border-left-style: double", "border-left-style: dotted"):  # 黑白打印靠线型区分开车、坐车、打车
            self.assertIn(text, print_css)

    def test_user_text_is_escaped_and_not_substituted_twice(self):
        cfg = config([person("老王", WANG, car_seats=3), person("@@title@@<i>", "114.0,34.0")])
        html = share.render_share(service.compute(cfg, FakeAmap()), 0)
        self.assertIn("@@title@@&lt;i&gt;", html)
        self.assertNotIn("<i>", html)


class UiServerTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.config = Path(self.dir.name) / "trip.toml"
        self.config.write_text('[venue]\nname = "目的地"\nlocation = "118.0,30.0"\n# 手写注释\n', encoding="utf-8")
        self.app = ui.App(self.config, FakeAmap())
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), ui.make_handler(self.app))
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.dir.cleanup()

    def call(self, path, body=None):
        req = urllib.request.Request(self.base + path, data=None if body is None else json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req) as resp:
                return resp.status, json.load(resp)
        except urllib.error.HTTPError as e:
            with e:
                return e.code, json.load(e)

    def test_design_system_files_are_served(self):
        for path, marker in (("/design.css", b"--accent"), ("/icons.svg", b"<symbol"), ("/favicon.svg", b"<svg")):
            with urllib.request.urlopen(self.base + path) as resp:
                self.assertEqual(resp.status, 200)
                self.assertIn(marker, resp.read())

    def test_page_and_config(self):
        with urllib.request.urlopen(self.base + "/") as resp:
            self.assertIn("拼车出行规划", resp.read().decode())
        status, data = self.call("/api/config")
        self.assertEqual((status, data["config"]["venue"]["name"]), (200, "目的地"))

    def test_save_backs_up_once(self):
        cfg = config([person("老王", WANG, car_seats=3)])
        self.assertEqual(self.call("/api/config", {"config": cfg})[0], 200)
        self.assertEqual(tomllib.loads(self.config.read_text(encoding="utf-8"))["people"][0]["name"], "老王")
        backup = self.config.with_name("trip.toml.bak")
        self.assertIn("# 手写注释", backup.read_text(encoding="utf-8"))
        self.call("/api/config", {"config": cfg})
        self.assertIn("# 手写注释", backup.read_text(encoding="utf-8"))  # 第二次保存不覆盖备份

    def test_plan_returns_map_data(self):
        cfg = config([person("老王", WANG, car_seats=3), person("小陈", "114.0,34.0")])
        status, data = self.call("/api/plan", {"config": cfg})
        self.assertEqual(status, 200)
        best = data["plans"][0]
        self.assertEqual(best["rides"], {"小陈": ["老王", "st:西站"]})
        path = best["routes"][0]["path"]  # 出发地 → 西站 → 目的地
        self.assertEqual((path[0], path[20], path[-1]), ([30.0, 116.0], [30.0, 117.0], [30.0, 118.0]))
        self.assertIn("venue", data["points"])
        self.assertIn("## 推荐方案", data["report"])

    def test_config_error_is_400(self):
        cfg = config([])
        status, data = self.call("/api/plan", {"config": cfg})
        self.assertEqual(status, 400)
        self.assertIn("people", data["error"])

    def test_share_requires_plan_then_writes_file(self):
        self.assertEqual(self.call("/api/share", {"plan": 0})[0], 400)
        cfg = config([person("老王", WANG, car_seats=3), person("小陈", "114.0,34.0")])
        self.call("/api/plan", {"config": cfg})
        status, data = self.call("/api/share", {"plan": 0})
        self.assertEqual((status, data["file"]), (200, "trip-plan.html"))
        self.assertTrue(self.config.with_name("trip-plan.html").exists())
        with urllib.request.urlopen(self.base + "/share") as resp:
            self.assertIn("出行方案", resp.read().decode())
        self.assertEqual(self.call("/api/share", {"plan": 9})[0], 400)

    def test_suggest_and_station_list(self):
        # 本地版用真实的 12306 站名表过滤：「西站」不是真站名会被滤掉，「杭州东站」留下
        pois = [{"name": "西站", "location": WEST}, {"name": "杭州东站", "location": WEST}]
        self.app.amap = FakeAmap(pois=pois)
        cfg = config([person("老王", WANG, car_seats=3)], stations=())
        status, data = self.call("/api/suggest", {"config": cfg})
        self.assertEqual((status, [s["name"] for s in data["stations"]]), (200, ["杭州东站"]))
        self.app.amap = FakeAmap(pois=pois)  # 只估算：不做地点搜索
        status, data = self.call("/api/suggest", {"config": cfg, "plan_only": True})
        self.assertEqual((status, data["stations"], self.app.amap.around_calls), (200, [], []))
        self.assertGreater(data["estimate"]["circles"], 0)
        with urllib.request.urlopen(self.base + "/stations12306.json") as resp:
            self.assertIn("北京南", json.load(resp)["stations"])
        with urllib.request.urlopen(self.base + "/config-fields.json") as resp:  # 编辑页的占位、范围、中文名取自它
            self.assertEqual({f["path"]: f["default"] for f in json.load(resp)["fields"] if "default" in f}["options.max_stops"], 2)

    def test_search(self):
        status, data = self.call("/api/search?q=%E6%9D%AD%E5%B7%9E%E4%B8%9C%E7%AB%99")
        self.assertEqual((status, data["results"][0]["name"]), (200, "杭州东站"))


class TryAmapTest(unittest.TestCase):
    """试玩模式：不碰网络，行车时间按直线估算，报告不说数据来自高德。"""

    def setUp(self):
        self._amap, self._last = browser.amap, browser._last
        browser.amap, browser._last = browser.TryAmap(), None
        stops = (("近站", NEAR), ("西站", WEST))
        self.cfg = config([person("老王", WANG, car_seats=3), person("小陈", "114.0,34.0", trains={"西站": "G1 08:00→10:00"})],
                          stops, estimate_rail=False)

    def tearDown(self):
        browser.amap, browser._last = self._amap, self._last

    def call(self, method, **args):
        return json.loads(browser.handle(method, json.dumps(args)))

    def test_no_network(self):
        boom = AssertionError("试玩不该发网络请求")
        with (mock.patch("urllib.request.urlopen", side_effect=boom),
              mock.patch("socket.socket.connect", side_effect=boom),
              mock.patch.object(browser.BrowserAmap, "_post_json", side_effect=boom),
              mock.patch.object(carpool.Amap, "_fetch", side_effect=boom)):
            self.assertEqual(self.call("init", **{"try": True}), {"ok": True})
            out = self.call("plan", config=self.cfg)
        self.assertIn("plans", out)
        self.assertTrue(out["plans"][0]["routes"])
        self.assertFalse(issubclass(browser.TryAmap, browser.BrowserAmap))

    def test_estimates_by_straight_line(self):
        amap = browser.TryAmap()
        a, b = Place("a", 118.0, 30.0), Place("b", 118.0, 31.0)
        km = km_between(a, b)
        self.assertAlmostEqual(amap.drive_minutes([a], b)[0], km * 1.3 / 75 * 60 + 10)
        self.assertEqual(amap.drive_minutes([a, b], b), [amap.drive_minutes([a], b)[0], 0.0])  # 同一个点算 0
        self.assertEqual(amap.drive_path([a, b, a]), [[30.0, 118.0], [31.0, 118.0], [30.0, 118.0]])

    def test_new_places_are_refused_with_hint(self):
        amap = browser.TryAmap()
        for call in (lambda: amap.geocode("某地"), lambda: amap.search("某地"), lambda: amap.find_station("某站"),
                     lambda: amap.stations_near(Place("a", 1, 2), 10), lambda: amap.stations_around(Place("a", 1, 2), 10),
                     lambda: amap.transit(Place("a", 1, 2), Place("b", 3, 4), "2027-1-1", "08:00")):
            with self.assertRaises(carpool.AmapError) as cm:
                call()
            self.assertIn("试玩模式不能查新地点和公交", str(cm.exception))
        self.call("init", **{"try": True})
        for method, args in (("search", {"q": "某地"}), ("suggest", {"config": self.cfg})):
            msg = self.call(method, **args)["error"]
            self.assertIn("请新建行程", msg)
            self.assertNotIn("高德接口报错", msg)
        est = self.call("suggest", config=self.cfg, plan_only=True)  # 试玩也能看估算
        self.assertGreater(est["estimate"]["circles"], 0)
        self.assertEqual(est["stations"], [])
        no_loc = {**self.cfg, "people": [{"name": "新人", "from": "某地"}]}
        self.assertIn("试玩模式不能查新地点", self.call("plan", config=no_loc)["error"])

    def test_report_does_not_claim_amap(self):
        out = self.call("plan", config=self.cfg)
        report = out["report"]
        self.assertIn(carpool.TRY_NOTICE, out["warnings"])
        self.assertIn(f"> ⚠️ {carpool.TRY_NOTICE}", report)
        for phrase in ("来自高德", "高德驾车测距", "高德公共交通", "接近查询时的路况"):
            self.assertNotIn(phrase, report)
        self.assertIn("试玩模式：地点和车次都是虚构的示意", report)
        self.assertIn("试玩里的车次和时刻都是示意", report)

    def test_every_edit_the_page_allows_still_plans(self):
        """试玩页允许的改法（谁开车、空座、删站、开关返程、删成员）逐一试：能算出方案，或给出正常的提示，不能崩。"""
        import copy
        import itertools
        base = json.loads((Path(__file__).with_name("web") / "try-trip.json").read_text(encoding="utf-8"))["config"]
        base["options"].update(travel_date="2026-10-17")
        base["return"]["date"] = "2026-10-18"
        self.call("init", **{"try": True})
        names = [p["name"] for p in base["people"]]

        def check(cfg, label):
            out = self.call("plan", config=cfg)
            if "error" in out:  # 提示要是人话，不是 Python 的异常
                self.assertNotRegex(out["error"], r"^\w*(Error|Exception)\b", label)
                self.assertNotIn("Traceback", out["error"], label)
            else:
                self.assertIn("## 说明", out["report"], label)
                self.assertNotIn("来自高德", out["report"], label)
            return out

        for drives in itertools.product([False, True], repeat=len(names)):  # 谁开车：2^4 种
            cfg = copy.deepcopy(base)
            for p, d in zip(cfg["people"], drives):
                if d:  # 与页面的 toggleCar 一致：开车 → 空座 3，不再有同行人数和返程车次
                    p.update(car_seats=3)
                    for k in ("party", "return_trains"):
                        p.pop(k, None)
                else:
                    p.pop("car_seats", None)
                    p.pop("max_detour_min", None)
            check(cfg, f"开车 {drives}")
        for seats in (1, 2, 5):  # 改空座
            cfg = copy.deepcopy(base)
            for p in cfg["people"]:
                if "car_seats" in p:
                    p["car_seats"] = seats
            check(cfg, f"空座 {seats}")
        for i in range(len(base["stations"])):  # 删站（同时清掉乘客对这个站的车次）
            cfg = copy.deepcopy(base)
            gone = cfg["stations"].pop(i)["name"]
            for p in cfg["people"]:
                for k in ("trains", "return_trains", "rail_min"):
                    p.get(k, {}).pop(gone, None)
            check(cfg, f"删站 {gone}")
        cfg = copy.deepcopy(base)
        cfg["stations"] = []  # 站删光
        check(cfg, "站删光")
        for enabled in (True, False):  # 开关返程
            cfg = copy.deepcopy(base)
            cfg["return"]["enabled"] = enabled
            out = check(cfg, f"返程 {enabled}")
            self.assertEqual(bool(out.get("back")), enabled)
        for outbound in (True, False):  # 开关去程：关掉就只规划返程
            cfg = copy.deepcopy(base)
            if not outbound:
                cfg["options"]["outbound"] = False
            out = check(cfg, f"去程 {outbound}")
            self.assertEqual(bool(out["plans"]), outbound)
            self.assertTrue(out["back"]["plans"])
            self.assertEqual(out["outbound"], outbound)
        cfg = copy.deepcopy(base)
        cfg["options"]["outbound"], cfg["return"]["enabled"] = False, False  # 两段都关：提示要选一段，不是 Python 异常
        self.assertIn("至少要规划一段", check(cfg, "两段都关")["error"])
        for mode in ("save", "fast"):  # 切换打车方式
            cfg = copy.deepcopy(base)
            cfg["options"]["taxi_mode"] = mode
            check(cfg, f"打车 {mode}")
        for i in range(len(names)):  # 删成员
            cfg = copy.deepcopy(base)
            del cfg["people"][i]
            check(cfg, f"删成员 {names[i]}")
        out = check(copy.deepcopy(base), "示例原样")
        self.assertGreater(out["plans"][0]["carried"], 0)  # 初始示例本身要能搭上人
        leaves = {p["name"]: p["leave_time"] for p in base["people"] if p.get("leave_time")}
        self.assertTrue(leaves and all(t != base["return"]["depart_time"] for t in leaves.values()))  # 示例里有人的离场时间和散场时间不同
        self.assertIn("等 15分钟", out["report"])

    def test_real_trip_report_unchanged(self):
        browser.amap = FakeAmap()
        out = self.call("plan", config=self.cfg)
        self.assertNotIn("试玩", out["report"])
        self.assertNotIn("试玩", "".join(out["warnings"]))
        self.assertIn("时间来自高德驾车测距", out["report"])
        self.assertIn("否则用高德公共交通估算", out["report"])
        self.assertIn("用高德公共交通最快方案估算", out["report"])


class CliTest(unittest.TestCase):
    def test_missing_key_exits(self):
        with self.assertRaises(SystemExit) as ctx:
            carpool.main(["trip.example.toml", "--key", ""])
        self.assertEqual(ctx.exception.code, 2)


# ---------- 金标准：固定报告、方案页、界面数据的现有输出 ----------

GOLDEN_DIR = Path(__file__).parent / "tests" / "golden"
GOLDEN_GENERATED = dt.datetime(2026, 10, 9, 12, 0)  # 方案页的「生成时间」固定，否则每次都变
GOLDEN_EXPIRES = dt.date(2026, 10, 23)              # 方案页的「自动删除日期」固定


class NoPathAmap(FakeAmap):
    """取不到某位车主的行车轨迹（高德没返回路线）：界面数据里 path 为空，方案页退回直线示意。"""

    def __init__(self, missing, **kw):
        super().__init__(**kw)
        self.missing = missing

    def drive_path(self, places):
        if any(self.missing in p.name for p in places):
            raise carpool.AmapError("没有轨迹")
        return super().drive_path(places)


def _golden_return(c, **ret):
    c["return"] = {"enabled": True, "depart_time": "18:00", **ret}
    return c


def _golden_out_mixed():
    # 有车次/没车次的方案、到家附近接、同站多人、打车（省钱）、车主有备注、乘客有备注
    return config([person("老王", WANG, car_seats=3, note="尾号 1234"),
                   person("小陈", "114.0,34.0", trains={"西站": "G1 07:00→09:00"}, note="带一个行李箱"),
                   person("小李", "116.5,30.4", trains={"近站": "G3 08:00→10:00"}),
                   person("小赵", "117.6,30.0")], travel_date="2026-10-17"), FakeAmap()


def _golden_out_taxi_save():
    # 省钱拼车：同行 2 人的一组、没填车次的人（按同一时间算）、站上拼满 4 人；另一个站只有一位没填车次的人（不知道时刻）
    return config([person("甲", "114.0,34.0", trains={"近站": "G1 07:00→10:00"}, stations=["近站"]),
                   person("乙", "114.0,34.0", stations=["近站"]),
                   person("丙家", "114.0,34.0", party=2, trains={"近站": "G9 07:00→10:10"}, stations=["近站"]),
                   person("丁", "113.0,35.0", stations=["西站"])], travel_date="2026-10-17", taxi_mode="save"), FakeAmap()


def _golden_out_taxi_fast():
    # 各人走自己最快的站，分成两辆车
    return config([person("老王", WANG, car_seats=3),
                   person("小李", "116.5,30.4", trains={"西站": "G2 06:30→08:30", "近站": "G4 07:00→09:30"}),
                   person("小陈", "114.0,34.0", trains={"西站": "G6 06:00→09:00", "近站": "G8 06:00→08:00"})],
                  travel_date="2026-10-17", taxi_mode="fast"), FakeAmap()


def _golden_out_drivers():
    # 只有车主：没有要接的人；一位车主 0 个空座；一位车主的行车轨迹取不到
    return config([person("老王", WANG, car_seats=3), person("老刘", "118.0,29.0", car_seats=0)],
                  travel_date="2026-10-17"), NoPathAmap("老刘")


def _golden_out_stranded():
    # 有人没有任何能去的站（待安排），还有一个人搭车
    return config([person("老王", WANG, car_seats=3),
                   person("小陈", "114.0,34.0", trains={"西站": "G1 07:00→09:00"}),
                   person("小钱", "114.0,34.0", stations=["西站"], pickup_at_home=False),  # 搭车去西站，没填车次
                   person("小孙", "114.0,34.0", stations=["不存在站"], pickup_at_home=False, note="只能自己想办法")],
                  travel_date="2026-10-17"), FakeAmap()


def _golden_back_people():
    return [person("老王", WANG, car_seats=3, leave_time="18:45"),   # 18:45 才走，乘客要等
            person("老刘", "118.0,29.0", car_seats=0),                # 不能载人，直接回家
            person("小陈", "114.0,34.0", return_trains={"西站": "G2 西站22:30→小陈家23:30"}, leave_time="18:00"),
            person("小周", "117.5,30.0"),                              # 顺路送到家附近
            person("小孙", "114.0,34.0", stations=["西站"], pickup_at_home=False),  # 没填返程车次
            person("甲", "113.0,35.0", return_trains={"西站": "G5 西站22:30→a"}, leave_time="19:30", stations=["西站"]),
            person("乙", "113.0,35.0", return_trains={"西站": "G6 西站22:40→b"}, leave_time="19:40", stations=["西站"]),
            person("小赵", "113.5,35.0", return_trains={"近站": "G7 近站18:30→b"}, stations=["近站"])]  # 赶不上，待安排


def _golden_back_only():
    c = config(_golden_back_people(), outbound=False)
    return _golden_return(c, max_wait_min=60, date="2026-10-18"), NoPathAmap("老刘")


def _golden_both():
    people = _golden_back_people()
    people[2]["trains"] = {"西站": "G1 07:00→09:00"}
    people[5]["trains"] = {"西站": "G3 06:30→08:30"}
    return _golden_return(config(people, travel_date="2026-10-17"), max_wait_min=60), FakeAmap()


def _golden_back_taxi():
    # 车主不开车回去：返程全部打车，离场时间差得远的各打各的车，赶不上车次的待安排
    return _golden_return(config([person("老王", WANG, car_seats=3, return_drives=False),
                                  person("小陈", "114.0,34.0", return_trains={"西站": "G2 西站22:30→a"}, leave_time="17:30", stations=["西站"]),
                                  person("小李", "113.0,35.0", return_trains={"西站": "G2 西站22:30→b"}, leave_time="19:00", stations=["西站"]),
                                  person("小孙", "114.0,34.0", leave_time="20:00", stations=["西站"], pickup_at_home=False),  # 没填返程车次，离场晚，单独一辆
                                  person("小赵", "113.5,35.0", return_trains={"西站": "G7 西站19:00→c"}, stations=["西站"])],
                                 travel_date="2026-10-17")), FakeAmap()


def _golden_two_cars():
    # 两位车主各带一位乘客（去程、返程都是）；乘客和车主同时离场（不用等）、车主晚走（要等）
    c = config([person("老王", WANG, car_seats=1),
                person("老刘", "118.0,29.0", car_seats=1, leave_time="18:20"),
                person("小李", "116.5,30.0", trains={"西站": "G1 07:00→09:00"}, return_trains={"西站": "G2 西站22:30→a"}),
                person("小周", "118.0,29.5", trains={"近站": "G3 08:00→10:00"}, return_trains={"近站": "G4 近站22:30→b"}, leave_time="18:00")],
               travel_date="2026-10-17", max_stops=2)
    return _golden_return(c, max_wait_min=60), FakeAmap()


# 场景名 -> (配置和假高德, 方案页要生成的「去程 i, 返程 j」组合；None 表示这一段没规划)
GOLDEN_SCENARIOS = {
    "out_mixed": (_golden_out_mixed, [(0, None), (1, None), (2, None)]),
    "out_taxi_save": (_golden_out_taxi_save, [(0, None)]),
    "out_taxi_fast": (_golden_out_taxi_fast, [(0, None), (2, None)]),
    "out_drivers": (_golden_out_drivers, [(0, None)]),
    "out_stranded": (_golden_out_stranded, [(0, None)]),
    "back_only": (_golden_back_only, [(None, 0), (None, 1)]),
    "back_taxi": (_golden_back_taxi, [(None, 0)]),
    "both": (_golden_both, [(0, 0), (1, 1), (2, 0)]),
    "two_cars": (_golden_two_cars, [(0, 0), (1, 1)]),
}


def golden_outputs(name: str) -> dict[str, bytes]:
    """一个场景的全部输出：{文件名: 内容}。报告、界面数据各一份，方案页每个组合一份。"""
    build, combos = GOLDEN_SCENARIOS[name]
    cfg, amap = build()
    with contextlib.redirect_stderr(io.StringIO()):  # 进度提示不属于输出
        state = service.compute(cfg, amap)
    payload = service.plan_payload(state)
    out = {
        "report.md": carpool.render(state["trip"], state["pts"], state["T"], state["plans"]),
        "payload.json": json.dumps(payload, sort_keys=True, indent=1, ensure_ascii=False) + "\n",
    }
    for i, j in combos:
        label = "-".join(f"{k}{n + 1}" for k, n in (("o", i), ("b", j)) if n is not None)
        out[f"share-{label}.html"] = share.render_share(state, i or 0, j or 0, generated=GOLDEN_GENERATED, expires=GOLDEN_EXPIRES)
    return {k: v.encode("utf-8") for k, v in out.items()}


class GoldenTest(unittest.TestCase):
    """金标准：报告、方案页、界面数据的现有输出逐字节固定下来，重构时用来证明「一个字都没变」。
    重新生成（只在输出该变时才做，并检查 git diff）：GOLDEN_UPDATE=1 python3 -m unittest test_carpool.GoldenTest"""

    def check(self, name):
        got = golden_outputs(name)
        folder = GOLDEN_DIR / name
        if os.environ.get("GOLDEN_UPDATE") == "1":
            folder.mkdir(parents=True, exist_ok=True)
            for old in folder.iterdir():
                if old.name not in got:
                    old.unlink()
            for file, data in got.items():
                (folder / file).write_bytes(data)
            return
        actual = Path(tempfile.gettempdir()) / "wedding-carpool-golden-actual" / name
        for file, data in got.items():
            with self.subTest(scenario=name, file=file):
                want = (folder / file).read_bytes() if (folder / file).exists() else None
                if want == data:
                    continue
                actual.mkdir(parents=True, exist_ok=True)
                (actual / file).write_bytes(data)
                hint = (f"还没有这个金标准文件。确认输出正确后再生成：GOLDEN_UPDATE=1 python3 -m unittest test_carpool.GoldenTest"
                        if want is None else f"看差异：diff -u tests/golden/{name}/{file} {actual / file}")
                self.fail(f"场景 {name} 的 {file} 和金标准不一致。{hint}")
        with self.subTest(scenario=name, file="（多余的文件）"):
            extra = sorted(f.name for f in folder.iterdir() if f.name not in got) if folder.exists() else []
            self.assertEqual(extra, [], f"tests/golden/{name}/ 里有现在不会生成的文件：{extra}")

    def test_scenarios(self):
        for name in GOLDEN_SCENARIOS:
            self.check(name)
        folders = sorted(f.name for f in GOLDEN_DIR.iterdir()) if GOLDEN_DIR.exists() else []
        self.assertEqual(folders, sorted(GOLDEN_SCENARIOS), "tests/golden/ 下的文件夹要和场景一一对应")


if __name__ == "__main__":
    unittest.main()
