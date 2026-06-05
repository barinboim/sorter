#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
serve.py — локальный статик-сервер для Sorter с отключённым кэшем.
Обычный `python3 -m http.server` кэширует game.js/style.css, и после правок
браузер показывает старое. Этот сервер шлёт Cache-Control: no-store — всегда свежак.

Запуск:  python3 scripts/serve.py [порт]   (по умолчанию 4180)
"""
import http.server
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # корень проекта sorter/
os.chdir(ROOT)
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 4180


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, *a):  # тише в консоли
        pass


http.server.ThreadingHTTPServer.allow_reuse_address = True
httpd = http.server.ThreadingHTTPServer(("", PORT), NoCacheHandler)
print("Sorter → http://localhost:%d  (no-cache, Ctrl+C чтобы остановить)" % PORT)
try:
    httpd.serve_forever()
except KeyboardInterrupt:
    print("\nостановлено")
