# SPDX-License-Identifier: AGPL-3.0-or-later
"""打车安排：没搭上车的人怎么分车、去哪个站打车（TaxiPool）。"""

from __future__ import annotations

import itertools
import math
from dataclasses import dataclass

from base import INF
from model import Leg, Person, Trip
from routes import arrival_at, back_deadline, leave_of

TAXI_COMBO_LIMIT = 20_000  # 打车选站组合的穷举上限，超过就用贪心
CAR_SEATS = 4  # 一辆出租最多坐几个人

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
