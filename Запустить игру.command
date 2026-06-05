#!/bin/bash
# Двойной клик по этому файлу запускает игру.
# Поднимает локальный сервер (no-cache) и открывает «Sorter 1.1» в браузере.
cd "$(dirname "$0")"
echo "🟢 Sorter 1.1 запущен — игра откроется в браузере."
echo "   Чтобы ОСТАНОВИТЬ: закрой это окно Терминала или нажми Ctrl+C."
echo ""
( sleep 1 && open "http://localhost:4180" ) &
exec python3 scripts/serve.py 4180
