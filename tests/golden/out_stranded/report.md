# 拼车方案：目的地

> ⚠️ 小孙 写的站「不存在站」不在候选站里，已忽略（名字要和候选站完全一致）

## 结论

- 不开车的 3 人里，**2 人能搭上顺风车**，车主合计多绕 0分钟。
- 建议坐到的站：**西站**。

## 推荐方案

- **老王**（空 3 座）：建议 **07:39 出发** → 西站 09:15（接 小陈、小钱） → 约 10:51 到目的地；全程约 3小时13分，比直达多绕 **0分钟**。[一键导航](https://uri.amap.com/navigation?from=116.000000,30.000000,%E8%80%81%E7%8E%8B%E5%87%BA%E5%8F%91%E5%9C%B0&to=118.000000,30.000000,%E7%9B%AE%E7%9A%84%E5%9C%B0&via=117.000000,30.000000,%E8%A5%BF%E7%AB%99&mode=car&src=wedding-carpool&coordinate=gaode&callnative=1)
- **小孙**：没有可用的候选站，需要单独安排。

排序依据：2 人搭车；总分钟 371 = 车主多绕 0 + 乘客到上车点 371 + 打车组 0

## 备选方案 2（0 人搭车，车主合计多绕 0分钟）

- **老王**（空 3 座）：直接开到目的地，约 3小时13分，不接人。
- **打车/包车组**：小陈、小钱 坐高铁到 **西站**，一起打车到目的地，约 09:15 在站汇合，10:51 左右到目的地（小钱没填车次，按同一时间算），打车粗估约 190–290 元，以实际为准。[导航](https://uri.amap.com/navigation?from=117.000000,30.000000,%E8%A5%BF%E7%AB%99&to=118.000000,30.000000,%E7%9B%AE%E7%9A%84%E5%9C%B0&mode=car&src=wedding-carpool&coordinate=gaode&callnative=1)
- **小孙**：没有可用的候选站，需要单独安排。

排序依据：0 人搭车；总分钟 563 = 车主多绕 0 + 乘客到上车点 0 + 打车组 563

打车：1 辆，粗估 190–290 元

和推荐方案比：少 2 人搭车

## 候选站对比

每个车主「只在这个站停一次」时比直达多绕多久；✅ 表示在他能接受的绕路范围内。

| 候选站 | 站→目的地车程 | 老王绕路 |
|---|---|---|
| 西站 | 1小时36分 | ✅ 0分钟 |
| 近站 | 1小时29分 | 1小时48分 |

## 不开车的人到各站要多久

括号里是配置里填的车次（标「手填」的只填了分钟数）；其余按 2026-10-17 08:00 出发，用高德公共交通最快方案估算。高德跨城只给直达火车，不含火车换乘和刚开通的线路，估算可能偏差很大，请用 12306 核对。

- **小陈**：西站 2小时45分（G1 07:00→09:00）
- **小钱**：西站 3小时26分（G1 某站→西站）

## 地点核对与高德链接

先确认「解析结果」对得上，链接可直接发群里，手机点开会跳到高德。

| 地点 | 解析结果 | 链接 |
|---|---|---|
| 目的地 | 配置里直接给的坐标 | [打开](https://uri.amap.com/marker?position=118.000000,30.000000&name=%E7%9B%AE%E7%9A%84%E5%9C%B0&src=wedding-carpool&coordinate=gaode&callnative=1) |
| 近站 | 配置里直接给的坐标 | [打开](https://uri.amap.com/marker?position=118.000000,30.800000&name=%E8%BF%91%E7%AB%99&src=wedding-carpool&coordinate=gaode&callnative=1) |
| 西站 | 配置里直接给的坐标 | [打开](https://uri.amap.com/marker?position=117.000000,30.000000&name=%E8%A5%BF%E7%AB%99&src=wedding-carpool&coordinate=gaode&callnative=1) |
| 老王出发地 | 配置里直接给的坐标 | [打开](https://uri.amap.com/marker?position=116.000000,30.000000&name=%E8%80%81%E7%8E%8B%E5%87%BA%E5%8F%91%E5%9C%B0&src=wedding-carpool&coordinate=gaode&callnative=1) |
| 小陈出发地 | 配置里直接给的坐标 | [打开](https://uri.amap.com/marker?position=114.000000,34.000000&name=%E5%B0%8F%E9%99%88%E5%87%BA%E5%8F%91%E5%9C%B0&src=wedding-carpool&coordinate=gaode&callnative=1) |
| 小钱出发地 | 配置里直接给的坐标 | [打开](https://uri.amap.com/marker?position=114.000000,34.000000&name=%E5%B0%8F%E9%92%B1%E5%87%BA%E5%8F%91%E5%9C%B0&src=wedding-carpool&coordinate=gaode&callnative=1) |
| 小孙出发地 | 配置里直接给的坐标 | [打开](https://uri.amap.com/marker?position=114.000000,34.000000&name=%E5%B0%8F%E5%AD%99%E5%87%BA%E5%8F%91%E5%9C%B0&src=wedding-carpool&coordinate=gaode&callnative=1) |

## 说明

- 时间来自高德驾车测距，接近查询时的路况，当天可能有出入；车次和到站时间请在 12306 核对。
- 不开车的人到各站的用时：优先用配置里手填的 `rail_min`，否则用高德公共交通估算；估算不准或想排除某些站时，给他填 `stations` 或 `rail_min`。
- 方案按计算规则第 2 版排序，规则和默认值见 https://carpool.eigentime.org/guide/method
- 高铁站一般要到停车场或网约车上车点接人，约定时说到具体停车场和区域。
