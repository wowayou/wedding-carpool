# SPDX-License-Identifier: AGPL-3.0-or-later
"""配置写回 TOML（只支持本工具用到的结构）。读 TOML 用标准库 tomllib。"""

from __future__ import annotations

import datetime as dt
import json
import re


def _toml_key(k: str) -> str:
    return k if re.fullmatch(r"[A-Za-z0-9_-]+", k) else json.dumps(k, ensure_ascii=False)


def _toml_value(v) -> str:
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return repr(v)
    if isinstance(v, str):
        return json.dumps(v, ensure_ascii=False)  # JSON 字符串转义是 TOML 基本字符串的子集
    if isinstance(v, (dt.date, dt.time)):
        return v.isoformat()
    if isinstance(v, list):
        return "[" + ", ".join(_toml_value(x) for x in v) + "]"
    if isinstance(v, dict):
        return "{ " + ", ".join(f"{_toml_key(k)} = {_toml_value(x)}" for k, x in v.items()) + " }"
    raise TypeError(f"无法写入 TOML：{v!r}")


def dump_toml(cfg: dict, header: str = "") -> str:
    """把配置写回 TOML（只支持本工具用到的结构）。空值不写。"""
    def body(table: dict) -> list[str]:
        return [f"{_toml_key(k)} = {_toml_value(v)}" for k, v in table.items()
                if v is not None and v != "" and v != [] and v != {}]

    out = [header] if header else []
    for name in ("venue", "options", "return"):
        if cfg.get(name):
            out += [f"[{name}]", *body(cfg[name]), ""]
    for name in ("stations", "people"):
        for item in cfg.get(name) or []:
            out += [f"[[{name}]]", *body(item), ""]
    return "\n".join(out)
