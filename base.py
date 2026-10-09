# SPDX-License-Identifier: AGPL-3.0-or-later
"""公共基础：常量、配置项定义（config-fields.json）、进度回调。

不依赖本项目的其他模块，是依赖关系的最底层。模块级的可变全局（progress、current_stage）在这里，
门面 carpool.py 会把对它们的读写转到这里（见 carpool.py 的说明）。
"""

from __future__ import annotations

import json
import math
from pathlib import Path

INF = math.inf

# 计算规则的版本：只有排序规则或成本口径变了才加一；改界面、改文字不加。说明见 /guide/method
RULES_VERSION = 2
# 配置项只在 config-fields.json 里定义一处（路径、类型、默认值、范围、单位、中文名……）。
# 网页版把这个文件和 .py 一起加载（见 web/pyworker.js）；编辑页、规则页的测试读的也是它
FIELDS_FILE = Path(__file__).with_name("config-fields.json")


def load_fields(path: Path = FIELDS_FILE) -> dict[str, dict]:
    """读配置项定义，返回 {路径: 定义}，路径如 options.max_detour_min、people[].max_detour_min。"""
    fields = json.loads(Path(path).read_text(encoding="utf-8"))["fields"]
    return {f["path"]: f for f in fields}


def defaults_from(fields: dict[str, dict]) -> dict:
    """规则页默认值表里的那些项（rules_table）：{配置里的键: 默认值}，键取路径的最后一段。"""
    return {f["path"].rsplit(".", 1)[-1]: f["default"] for f in fields.values() if f.get("rules_table")}


FIELDS = load_fields()
# 配置里没写时的默认值，由 FIELDS 生成；说明页的默认值表会和它核对（test_carpool.py）
DEFAULTS = defaults_from(FIELDS)



# 进度回调：长操作分阶段报告 (阶段说明, 已完成数, 总数)，网页版用来显示进度条；本地版不设
progress = None
current_stage = ""


def report(label: str, done: int | None = None, total: int | None = None) -> None:
    global current_stage
    current_stage = label
    if progress:
        progress(label, done, total)
