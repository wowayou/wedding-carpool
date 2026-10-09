# 拼车方案：目的地

## 结论

- 不开车的 5 人里，**0 人能搭上顺风车**，车主合计多绕 0分钟。
- 建议坐到的站：**西站、近站**。

## 推荐方案

- **打车/包车组**：甲、丙家（2 人）、乙 坐高铁到 **近站**，一起打车到目的地，约 10:25 在站汇合，11:54 左右到目的地（乙没填车次，按同一时间算），打车粗估约 180–270 元，以实际为准。[导航](https://uri.amap.com/navigation?from=118.000000,30.800000,%E8%BF%91%E7%AB%99&to=118.000000,30.000000,%E7%9B%AE%E7%9A%84%E5%9C%B0&mode=car&src=wedding-carpool&coordinate=gaode&callnative=1)
- **打车/包车组**：丁 坐高铁到 **西站**，一起打车到目的地，车程约 1小时36分，打车粗估约 190–290 元，以实际为准。[导航](https://uri.amap.com/navigation?from=117.000000,30.000000,%E8%A5%BF%E7%AB%99&to=118.000000,30.000000,%E7%9B%AE%E7%9A%84%E5%9C%B0&mode=car&src=wedding-carpool&coordinate=gaode&callnative=1)

排序依据：0 人搭车；总分钟 1279 = 车主多绕 0 + 乘客到上车点 0 + 打车组 1279

打车：2 辆，粗估 370–560 元

## 候选站对比

每个车主「只在这个站停一次」时比直达多绕多久；✅ 表示在他能接受的绕路范围内。

| 候选站 | 站→目的地车程 |
|---|---|
| 近站 | 1小时29分 |
| 西站 | 1小时36分 |

## 不开车的人到各站要多久

括号里是配置里填的车次（标「手填」的只填了分钟数）；其余按 2026-10-17 08:00 出发，用高德公共交通最快方案估算。高德跨城只给直达火车，不含火车换乘和刚开通的线路，估算可能偏差很大，请用 12306 核对。

- **甲**：近站 3小时45分（G1 07:00→10:00）
- **乙**：近站 3小时22分（G1 某站→近站）
- **丙家**：近站 3小时55分（G9 07:00→10:10）
- **丁**：西站 4小时14分（G1 某站→西站）

## 地点核对与高德链接

先确认「解析结果」对得上，链接可直接发群里，手机点开会跳到高德。

| 地点 | 解析结果 | 链接 |
|---|---|---|
| 目的地 | 配置里直接给的坐标 | [打开](https://uri.amap.com/marker?position=118.000000,30.000000&name=%E7%9B%AE%E7%9A%84%E5%9C%B0&src=wedding-carpool&coordinate=gaode&callnative=1) |
| 近站 | 配置里直接给的坐标 | [打开](https://uri.amap.com/marker?position=118.000000,30.800000&name=%E8%BF%91%E7%AB%99&src=wedding-carpool&coordinate=gaode&callnative=1) |
| 西站 | 配置里直接给的坐标 | [打开](https://uri.amap.com/marker?position=117.000000,30.000000&name=%E8%A5%BF%E7%AB%99&src=wedding-carpool&coordinate=gaode&callnative=1) |
| 甲出发地 | 配置里直接给的坐标 | [打开](https://uri.amap.com/marker?position=114.000000,34.000000&name=%E7%94%B2%E5%87%BA%E5%8F%91%E5%9C%B0&src=wedding-carpool&coordinate=gaode&callnative=1) |
| 乙出发地 | 配置里直接给的坐标 | [打开](https://uri.amap.com/marker?position=114.000000,34.000000&name=%E4%B9%99%E5%87%BA%E5%8F%91%E5%9C%B0&src=wedding-carpool&coordinate=gaode&callnative=1) |
| 丙家出发地 | 配置里直接给的坐标 | [打开](https://uri.amap.com/marker?position=114.000000,34.000000&name=%E4%B8%99%E5%AE%B6%E5%87%BA%E5%8F%91%E5%9C%B0&src=wedding-carpool&coordinate=gaode&callnative=1) |
| 丁出发地 | 配置里直接给的坐标 | [打开](https://uri.amap.com/marker?position=113.000000,35.000000&name=%E4%B8%81%E5%87%BA%E5%8F%91%E5%9C%B0&src=wedding-carpool&coordinate=gaode&callnative=1) |

## 说明

- 时间来自高德驾车测距，接近查询时的路况，当天可能有出入；车次和到站时间请在 12306 核对。
- 不开车的人到各站的用时：优先用配置里手填的 `rail_min`，否则用高德公共交通估算；估算不准或想排除某些站时，给他填 `stations` 或 `rail_min`。
- 方案按计算规则第 2 版排序，规则和默认值见 https://carpool.eigentime.org/guide/method
- 高铁站一般要到停车场或网约车上车点接人，约定时说到具体停车场和区域。
