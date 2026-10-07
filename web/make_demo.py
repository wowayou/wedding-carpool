#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""把一份真实生成的方案页（share.py 的输出）改成站点的示例页 web/demo.html。

    python3 web/make_demo.py 生成的方案页.html

生成方案页要先在编辑页里用虚构数据算一次方案并发布（会消耗一次高德额度）：宏村示例酒店，老王从杭州开车、
老张从南京开车，小李（同行 2 人）从上海、小陈从武汉坐高铁，开返程，最大绕路 60/45 分钟。
这里只做文字处理，不联网：加上「这是示例」说明、canonical，去掉页脚的自动删除日期，套上站点的页头页脚和样式，
并把页面图标换成站点上的文件（示例页不在方案页沙箱里，可以直接引用）。
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

OUT = Path(__file__).with_name("demo.html")


def convert(h: str) -> str:
    def once(pattern: str, repl: str, text: str, flags: int = 0) -> str:
        new, n = re.subn(pattern, lambda _m: repl, text, count=1, flags=flags)
        if n != 1:
            raise SystemExit(f"方案页里找不到要改的位置：{pattern}")
        return new

    h = re.sub(r"<br>这一页会在 [\d-]+ 前后自动删除", "", h)  # 示例页没有保留期
    h = once(r'<link rel="icon"[^>]*>\n(?:<link rel="apple-touch-icon"[^>]*>\n)?',
             '<link rel="icon" type="image/svg+xml" href="/favicon.svg">\n<link rel="apple-touch-icon" href="/apple-touch-icon.png">\n', h)
    h = once(r'<meta name="description"', '<link rel="canonical" href="https://carpool.eigentime.org/demo">\n<meta name="description"', h)
    # 站点样式和页头交互脚本：放在 og 之后、页面自己的样式之前
    h = re.sub(r'(<meta property="og:description"[^>]*>\n)', lambda m: m.group(1) + '<link rel="stylesheet" href="/design.css">\n<!-- include:site-script -->\n', h, count=1)
    h = once(r'<p class="draft">', '<p class="draft"><b>这是示例：</b>行程和名字都是虚构的，用来看方案页长什么样。<br>', h)
    h = once(r"<!doctype html>", "<!doctype html>\n<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->", h)
    h = once(r'<body>\n<div class="wrap">', '<body>\n<!-- include:header -->\n<main class="wrap" id="main">', h)
    h = once(r'</div>\n<script id="data"', '</main>\n<!-- include:footer -->\n<script id="data"', h)
    return h


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    OUT.write_text(convert(Path(sys.argv[1]).read_text(encoding="utf-8")), encoding="utf-8")
    print(f"已写入 {OUT}")
