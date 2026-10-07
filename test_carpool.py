"""离线测试：用假的高德客户端验证选站和拼车逻辑。
行车分钟 = 直线公里数（60km/h）；公共交通分钟 = 公里数 / 3 + 30（火车约 180km/h 加市内接驳）。

    python3 -m unittest -v test_carpool.py
"""

import io
import json
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

    def __init__(self, places=None, pois=None, no_transit=()):
        self.places = places or {}
        self.pois = pois or []
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

    def stations_around(self, center, radius_km):
        self.calls += 1
        return self.pois

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

    def test_trip_limit_errors_stop_like_quota(self):
        with self.assertRaises(carpool.QuotaError) as ctx:
            carpool.check_quota("TRIP_DAILY_LIMIT", "这个行程今天的高德调用已到上限")
        self.assertIn("行程今天", str(ctx.exception))


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
        with urllib.request.urlopen(self.base + "/stations12306.json") as resp:
            self.assertIn("北京南", json.load(resp)["stations"])

    def test_search(self):
        status, data = self.call("/api/search?q=%E6%9D%AD%E5%B7%9E%E4%B8%9C%E7%AB%99")
        self.assertEqual((status, data["results"][0]["name"]), (200, "杭州东站"))


class CliTest(unittest.TestCase):
    def test_missing_key_exits(self):
        with self.assertRaises(SystemExit) as ctx:
            carpool.main(["trip.example.toml", "--key", ""])
        self.assertEqual(ctx.exception.code, 2)


if __name__ == "__main__":
    unittest.main()
