"""从 12306 的站名表生成 web/stations12306.json，供网页拼 12306 查询链接、推荐车站时过滤非客运站。

    curl -o /tmp/station_name.js https://kyfw.12306.cn/otn/resources/js/framework/station_name.js
    python3 web/gen_stations12306.py /tmp/station_name.js

站名表每条：拼音缩写|站名|电报码|拼音|简拼|序号|城市代码|城市名
"""

import json
import sys
from pathlib import Path


def main(src: str) -> None:
    text = Path(src).read_text(encoding="utf-8")
    stations, cities = {}, {}
    for item in text.split("@")[1:]:
        parts = item.split("|")
        if len(parts) < 8 or not parts[1] or not parts[2]:
            continue
        name, code, city = parts[1], parts[2], parts[7]
        stations[name] = code
        # 城市查询用与城市同名的站（如「泰州」），没有就用该城市的第一个站；12306 会把同城各站一起查出来
        if city and (city not in cities or name == city):
            cities[city] = code
    out = Path(__file__).with_name("stations12306.json")
    out.write_text(json.dumps({"stations": stations, "cities": cities}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{len(stations)} 个站，{len(cities)} 个城市 → {out}")


if __name__ == "__main__":
    main(sys.argv[1])
