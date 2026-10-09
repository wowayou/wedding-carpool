# SPDX-License-Identifier: AGPL-3.0-or-later
"""拼车求解：评估一组车主路线的方案，在所有组合里挑最好的几个；plan_trip 把读配置、建矩阵、求解串起来。"""

from __future__ import annotations

import itertools

from base import report
from geo import Place
from model import (OUT, TRY_NOTICE, Leg, Person, Trip, build_matrix, estimate_rail, load_trip, points_of)
from routes import Plan, Route, assign, back_deadline, car_routes, leave_of, rider_options, stop_times
from taxi import TaxiPool

COMBO_LIMIT = 30_000  # 车主路线组合的枚举上限，车多时自动收紧每辆车保留的候选路线


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
