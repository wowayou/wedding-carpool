# 拼车方案：目的地

## 结论

- 不开车的 0 人里，**0 人能搭上顺风车**，车主合计多绕 0分钟。
- 建议坐到的站：**不需要坐到站**。

## 推荐方案

- **老王**（空 3 座）：直接开到目的地，约 3小时13分，不接人。
- **老刘**（空 0 座）：直接开到目的地，约 1小时51分，不接人。

排序依据：0 人搭车；总分钟 0 = 车主多绕 0 + 乘客到上车点 0 + 打车组 0

## 候选站对比

每个车主「只在这个站停一次」时比直达多绕多久；✅ 表示在他能接受的绕路范围内。

| 候选站 | 站→目的地车程 | 老王绕路 | 老刘绕路 |
|---|---|---|---|
| 西站 | 1小时36分 | ✅ 0分钟 | 2小时13分 |
| 近站 | 1小时29分 | 1小时48分 | 2小时58分 |

## 地点核对与高德链接

先确认「解析结果」对得上，链接可直接发群里，手机点开会跳到高德。

| 地点 | 解析结果 | 链接 |
|---|---|---|
| 目的地 | 配置里直接给的坐标 | [打开](https://uri.amap.com/marker?position=118.000000,30.000000&name=%E7%9B%AE%E7%9A%84%E5%9C%B0&src=wedding-carpool&coordinate=gaode&callnative=1) |
| 近站 | 配置里直接给的坐标 | [打开](https://uri.amap.com/marker?position=118.000000,30.800000&name=%E8%BF%91%E7%AB%99&src=wedding-carpool&coordinate=gaode&callnative=1) |
| 西站 | 配置里直接给的坐标 | [打开](https://uri.amap.com/marker?position=117.000000,30.000000&name=%E8%A5%BF%E7%AB%99&src=wedding-carpool&coordinate=gaode&callnative=1) |
| 老王出发地 | 配置里直接给的坐标 | [打开](https://uri.amap.com/marker?position=116.000000,30.000000&name=%E8%80%81%E7%8E%8B%E5%87%BA%E5%8F%91%E5%9C%B0&src=wedding-carpool&coordinate=gaode&callnative=1) |
| 老刘出发地 | 配置里直接给的坐标 | [打开](https://uri.amap.com/marker?position=118.000000,29.000000&name=%E8%80%81%E5%88%98%E5%87%BA%E5%8F%91%E5%9C%B0&src=wedding-carpool&coordinate=gaode&callnative=1) |

## 说明

- 时间来自高德驾车测距，接近查询时的路况，当天可能有出入；车次和到站时间请在 12306 核对。
- 不开车的人到各站的用时：优先用配置里手填的 `rail_min`，否则用高德公共交通估算；估算不准或想排除某些站时，给他填 `stations` 或 `rail_min`。
- 方案按计算规则第 2 版排序，规则和默认值见 https://carpool.eigentime.org/guide/method
- 高铁站一般要到停车场或网约车上车点接人，约定时说到具体停车场和区域。
