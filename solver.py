# SPDX-License-Identifier: AGPL-3.0-or-later
"""拼车求解：评估一组车主路线的方案，在所有组合里挑最好的几个；plan_trip 把读配置、建矩阵、求解串起来。"""

from __future__ import annotations

import itertools

from base import report
from geo import Place
from model import (OUT, TRY_NOTICE, Leg, Person, Trip, build_matrix, estimate_rail, load_trip, points_of)
from routes import (Plan, Route, assign, back_deadline, car_routes, leave_of, leg_minutes, reaches_in_time, rider_options,
                    stop_times)
from taxi import TaxiPool
from timetable import ride_core, solo_minutes

COMBO_LIMIT = 30_000  # 车主路线组合的枚举上限，车多时自动收紧每辆车保留的候选路线


class RideLimit:
    """搭车最多多花（规则第 3 版）：一位乘客在某辆车的某个点上车（返程是下车），
    「不算等人的全程」要不超过 自己单独走 + ride_extra_min。口径和每个人的用时表一致（timetable.ride_core）。
    自己单独走每次求解按人算一次；没有能自己打车去的站的人没有可比的，不受限制。
    去程设了最晚到达时间（规则第 4 版）时，同一处还要检查这个人坐这辆车到目的地不晚于它（routes.reaches_in_time）。
    判断结果按（路线，点，人）缓存，枚举几万个组合时不重复算。"""

    def __init__(self, trip: Trip, drivers: list[Person], riders: list[Person], opts: dict[str, dict[str, float]], T, leg: Leg):
        self.trip, self.opts, self.T, self.leg = trip, opts, T, leg
        self.leaves = {d.name: leave_of(d, leg) for d in drivers}
        self.cap: dict[str, float] = {}
        for p in riders:
            solo = solo_minutes(p, opts[p.name], T, leg, trip)
            if solo is not None:
                self.cap[p.name] = solo + trip.ride_extra
        self.verdict: dict[tuple, bool] = {}

    def ride(self, route: Route, stop: str) -> float:
        """沿这辆车的路线，返程是目的地到下车点，去程是上车点到目的地的车程。"""
        seq = self.leg.sequence(route.driver, route.stops)
        i = seq.index(stop)
        return leg_minutes(self.T, seq[:i + 1] if self.leg.reverse else seq[i:])

    def minutes(self, route: Route, stop: str, p: Person) -> float:
        """这位乘客坐这辆车、在这个点上车（下车），不算等人的全程。"""
        return ride_core(p, stop, self.opts[p.name][stop], self.ride(route, stop), self.leg, self.trip.exit_buffer, self.leaves[route.driver])

    def allows(self, route: Route, stop: str, p: Person) -> bool:
        key = (route, stop, p.name)
        if key not in self.verdict:
            ok = self.leg.reverse or self.trip.arrive_by is None or reaches_in_time(p, stop, self.ride(route, stop), self.trip.exit_buffer, self.trip.arrive_by)
            cap = self.cap.get(p.name)
            self.verdict[key] = ok and (cap is None or self.minutes(route, stop, p) <= cap + 1e-9)
        return self.verdict[key]


def evaluate(combo: tuple[Route, ...], drivers: list[Person], riders: list[Person],
             opts: dict[str, dict[str, float]], T, leg: Leg, pool: TaxiPool, limit: RideLimit) -> Plan | None:
    allowed = limit.allows  # 搭车最多多花的上限；返程再加上下面两条
    if leg.reverse:  # 返程：车主几点走车就几点走；乘客准备好后最多等 max_wait，送到站的时刻要赶得上车次
        leaves = limit.leaves
        times = {r.driver: stop_times(r, T, leg, leaves[r.driver]) for r in combo}

        def allowed(route: Route, stop: str, p: Person) -> bool:
            if not 0 <= leaves[route.driver] - leave_of(p, leg) <= leg.max_wait:
                return False
            deadline = back_deadline(p, stop, leg)
            return (deadline is None or times[route.driver][stop] <= deadline) and limit.allows(route, stop, p)
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
    places = {st.name: st for st in trip.stations}
    opts = {p.name: rider_options(p, names, trip.station_cost, leg, places) for p in riders}
    pickups = sorted({s for o in opts.values() for s in o})
    keep = max(1, int(COMBO_LIMIT ** (1 / max(len(drivers), 1))) - 1)
    per_car = [car_routes(d, pickups, T, trip.max_stops, leg)[:keep + 1] for d in drivers]
    pool = TaxiPool(trip, riders, opts, T, leg)
    limit = RideLimit(trip, drivers, riders, opts, T, leg)
    plans = [pl for combo in itertools.product(*per_car)
             if (pl := evaluate(combo, drivers, riders, opts, T, leg, pool, limit))]
    return sorted(plans, key=lambda pl: pl.score)[:top]


def plan_trip(cfg: dict, amap) -> tuple[Trip, dict[str, Place], dict, list[Plan]]:
    trip = load_trip(cfg, amap)
    if getattr(amap, "is_try", False):  # 试玩：不估算公交，报告顶部先说明数据是示意的
        trip.try_mode, trip.estimate_rail = True, False
        trip.warnings.insert(0, TRY_NOTICE)
    pts = points_of(trip)
    skip = {f"home:{p.name}" for p in trip.people if not p.drives and not p.pickup_at_home}
    T = build_matrix(amap, pts, skip, out=trip.outbound, back=trip.back is not None)
    plans: list[Plan] = []
    estimate_rail(amap, trip)  # 只规划返程时，只估算回程车次没填的人
    if trip.outbound:
        plans = solve(trip, T)
    if trip.back:  # 返程插件
        trip.back_plans = solve(trip, T, leg=trip.back)
    return trip, pts, T, plans
