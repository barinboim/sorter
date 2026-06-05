#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
fetch_fonts.py — самохостинг шрифтов (одноразово, не часть рантайма).
Тянет CSS Google Fonts, скачивает все woff2 в assets/fonts/ и генерирует
локальный assets/fonts/fonts.css (url() переписаны на локальные пути,
unicode-range сохранён). Рантайм игры в сеть не ходит.
"""
import os
import re
import urllib.request

CSS_URL = (
    "https://fonts.googleapis.com/css2"
    "?family=Inter:wght@400;600;700;800"
    "&family=Spline+Sans+Mono:wght@400;600"
    "&display=swap"
)
# UA современного браузера → отдаёт woff2
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0 Safari/537.36")

HERE = os.path.dirname(os.path.abspath(__file__))
FONTS_DIR = os.path.join(HERE, "..", "assets", "fonts")
os.makedirs(FONTS_DIR, exist_ok=True)


def get(url, headers=None):
    req = urllib.request.Request(url, headers=headers or {"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def main():
    css = get(CSS_URL).decode("utf-8")
    blocks = re.split(r"(?=@font-face)", css)
    out_css = ["/* Самохостинг: Inter + Spline Sans Mono. Сгенерировано fetch_fonts.py */"]
    seen = {}
    n = 0
    for b in blocks:
        if "@font-face" not in b:
            continue
        fam = re.search(r"font-family:\s*'([^']+)'", b)
        wght = re.search(r"font-weight:\s*(\d+)", b)
        url = re.search(r"url\((https://[^)]+\.woff2)\)", b)
        if not (fam and url):
            continue
        # имя локального файла: <family>-<weight>-<idx>.woff2
        base = "%s-%s" % (slug(fam.group(1)), wght.group(1) if wght else "400")
        idx = seen.get(base, 0)
        seen[base] = idx + 1
        fname = "%s-%d.woff2" % (base, idx)
        data = get(url.group(1))
        with open(os.path.join(FONTS_DIR, fname), "wb") as fh:
            fh.write(data)
        n += 1
        local_block = b.replace(url.group(1), "./%s" % fname).strip()
        out_css.append(local_block)
    with open(os.path.join(FONTS_DIR, "fonts.css"), "w", encoding="utf-8") as fh:
        fh.write("\n\n".join(out_css) + "\n")
    print("downloaded %d woff2 -> %s" % (n, FONTS_DIR))


if __name__ == "__main__":
    main()
