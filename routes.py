# SPDX-License-Identifier: AGPL-3.0-or-later
"""候选路线和乘客分配：Route、Plan，乘客能在哪些点上车，车主的候选路线，把乘客分到车上（最小费用最大流）。"""

from __future__ import annotations

import itertools
from dataclasses import dataclass

from base import INF
from model import OUT, Leg, Person, train_times


@dataclass(frozen=True)
class Route:
    driver: str
    stops: tuple[str, ...]  # 途经的接人点 id
    minutes: float          # 全程分钟
    detour: float           # 比直达多出的分钟


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


def arrival_at(person: Person, stop: str) -> float | None:
    """乘客坐的车到这个站的时刻（车次说明里最后一个时间）。"""
    times = train_times(person.trains.get(stop[3:], "")) if stop.startswith("st:") else []
    return times[-1] if times else None
