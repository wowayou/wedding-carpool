# SPDX-License-Identifier: AGPL-3.0-or-later
"""行程表（v3.9）：一个方案里谁几点出发、几点到哪、等多久、打车几点汇合，只在这里算一次。"""

from __future__ import annotations

from dataclasses import dataclass

from base import INF
from model import OUT, Leg, Trip, train_times
from routes import Plan, Route, arrival_at, leave_of, stop_times
from taxi import taxi_cars


# ---------- 行程表 ----------
# 一个方案里「谁几点出发、几点到哪、等多久、打车几点汇合」只在这一节算一次，存成行程表。
# 报告、方案页、界面数据都只读行程表，各自负责「怎么写出来」（文字、HTML、JSON），不再自己推算时刻。
# 时刻都是当天的原始分钟数（不取整）；不知道的时刻统一是 None（比如没填车次，推不出车主几点出发）。
# 「到不了」和「不知道」是两回事：行车时间矩阵里没有某一段路时，车程和由它推出的时刻沿用 INF，和求解部分一致，
# 输出端照旧显示（报告和方案页的写法因此和以前逐字相同）；不要把 INF 当成 None 来判断「有没有时刻」。
# 这个模块不引用报告和方案页的代码。

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


@dataclass
class Stop:
    """车主路线上的一个停靠点。"""
    point: str           # 点 id（st:站名 或 home:名字）
    time: float | None   # 车到这里的时刻
    people: list[str]    # 在这里上车（返程是下车）的人


@dataclass
class CarTrip:
    """一辆私家车。去程：出发地 → 接人点 → 目的地；返程：目的地 → 送人点 → 家。"""
    driver: str
    depart: float | None     # 出发时刻：去程按接人时刻倒推，不知道车次时刻就是 None；返程是车主的离场时间
    stops: list[Stop]
    arrive: float | None     # 到达时刻：去程到目的地，返程到家
    minutes: float           # 全程分钟
    detour: float            # 比直达多绕的分钟
    first_leg: float | None  # 出发后到第一个停靠点的车程；没有停靠点就是 None


@dataclass
class Rider:
    """一个坐车（私家车或出租）的人。去程里 board 是上车时刻、arrive 是到目的地；
    返程里 board 是车出发的时刻、arrive 是到送人点（出租是到站）。"""
    name: str
    driver: str | None       # 坐谁的车；出租为 None
    stop: str                # 在哪上车（返程是在哪下车）
    board: float | None
    arrive: float | None
    train: str = ""          # 要坐的车次说明，没填就是空
    train_depart: float | None = None  # 车次说明里的第一个时刻
    train_arrive: float | None = None  # 车次说明里的最后一个时刻
    leave: float | None = None         # 返程：这个人自己的离场时刻
    wait: float | None = None          # 返程：等车主（或同车的人）多久
    guessed: bool = False    # 出租：没填车次，时刻是按同车的人算的


@dataclass
class TaxiCar:
    """一辆出租。"""
    stop: str
    names: list[str]
    n: int                   # 一共几个人（同行的算多人）
    time: float | None       # 去程：站里汇合的时刻；返程：从目的地出发的时刻
    ride: float              # 站和目的地之间的车程
    unknown: list[str]       # 没填车次的人
    members: list[Rider]


@dataclass
class Stranded:
    name: str
    leave: float | None      # 返程：这个人的离场时刻


@dataclass
class Timeline:
    """一个方案（去程或返程）的行程表。cars 和 plan.routes 一一对应。"""
    cars: list[CarTrip]
    riders: list[Rider]      # 搭私家车的人，顺序同 plan.rides
    taxis: list[TaxiCar]
    stranded: list[Stranded]


@dataclass
class Timelines:
    """一次计算的全部行程表：去程方案和返程方案各一份，顺序同 plans 和 trip.back_plans。"""
    out: list[Timeline]
    back: list[Timeline]


def timeline(plan: Plan, trip: Trip, T, leg: Leg) -> Timeline:
    people = {p.name: p for p in trip.people}
    back = leg.reverse
    ready = {} if back else pickup_ready(plan, trip)
    cars: list[CarTrip] = []
    for r in plan.routes:
        seq = leg.sequence(r.driver, r.stops)
        names = lambda s, r=r: [n for n, (d, st) in plan.rides.items() if d == r.driver and st == s]  # noqa: E731
        if back:
            depart = leave_of(people[r.driver], leg)
            times = stop_times(r, T, leg, depart)
            arrive = times[f"car:{r.driver}"]
        else:
            sched = route_schedule(r, ready, T)
            depart = sched["depart"] if sched else None
            times = sched["times"] if sched else {}
            arrive = times.get("venue")
        cars.append(CarTrip(r.driver, depart, [Stop(s, times.get(s), names(s)) for s in r.stops], arrive, r.minutes, r.detour,
                            T.get((seq[0], seq[1]), INF) if r.stops else None))

    def rider(name: str, driver: str | None, stop: str, board, arrive, guessed: bool = False) -> Rider:
        p = people[name]
        text = (p.back_trains if back else p.trains).get(stop[3:], "") if stop.startswith("st:") else ""
        clocks = train_times(text)
        leave = leave_of(p, leg) if back else None
        return Rider(name, driver, stop, board, arrive, text, clocks[0] if clocks else None, clocks[-1] if clocks else None,
                     leave, board - leave if back and board is not None else None, guessed)

    by_driver = {c.driver: c for c in cars}
    riders = []
    for name, (driver, stop) in plan.rides.items():
        car = by_driver[driver]
        at = next(s.time for s in car.stops if s.point == stop)
        riders.append(rider(name, driver, stop, car.depart, at) if back else rider(name, driver, stop, at, car.arrive))
    taxis = []
    for car in taxi_cars(plan.taxi, people, T, leg, trip):
        t, ride = car["time"], car["ride"]
        end = None if t is None else t + ride
        members = [rider(n, None, car["stop"], t, end, n in car["unknown"]) for n in car["names"]]
        taxis.append(TaxiCar(car["stop"], car["names"], car["n"], t, ride, car["unknown"], members))
    stranded = [Stranded(n, leave_of(people[n], leg) if back else None) for n in plan.stranded]
    return Timeline(cars, riders, taxis, stranded)


def timelines(trip: Trip, T, plans: list[Plan]) -> Timelines:
    """去程方案和返程方案的行程表，求解后算一次，报告、方案页、界面数据共用。"""
    return Timelines([timeline(pl, trip, T, OUT) for pl in plans],
                     [timeline(pl, trip, T, trip.back) for pl in trip.back_plans] if trip.back else [])
