# Sorter stats — бэкенд лидерборда

Крошечный сервис на **чистом Python 3.8+** (`http.server` + `sqlite3`, без зависимостей)
для кросс-игровой статистики: лидерборд игроков, агрегаты по словам и учёт уникальных
игроков по **солёному хешу IP** (сырой IP не хранится).

Игра — статический сайт на GitHub Pages (`sorter.barinbo.im`) — шлёт сюда события.
Сервис ставится на любой VPS за nginx.

---

## Что он считает

- **Игроки** (`players`): один = один солёный хеш IP. Поля: ник (генерится из хеша),
  first/last seen, сессии, всего слов, good, bad, раундов.
- **Слова** (`word_votes`): по каждому видимому токену — сколько раз `good` и `bad`
  через всех игроков. Отсюда «самые любимые» / «самые отвергнутые».
- **Дедуп** пачек (`seen_batches`) по `(clientId, kind, seq)` — повторные ретраи и
  `sendBeacon` при закрытии вкладки не задваивают счётчики.

## Приватность

- **Сырой IP не пишется в БД никогда.** Хранится только `HMAC-SHA256(salt, ip)`.
- Соль секретная и стабильная (`salt.secret`, режим 0600, **в git не коммитится** —
  см. `.gitignore`). Потеряешь соль → все игроки станут «новыми».
- В `/api/admin` id игрока показывается как 12-символьный префикс хеша (не IP).
- Ники анонимные (`neon-otter-42`), из хеша, обратно в IP не раскручиваются.

> ⚠️ Хеш IP — это псевдонимизация, не полная анонимизация: под GDPR это всё ещё
> персональные данные. Для публичного сайта добавь строчку в политику/баннер о том,
> что считается обезличенная статистика игры.

---

## Эндпоинты

| Метод | Путь | Тело / параметры | Назначение |
|------|------|------------------|------------|
| POST | `/api/hello` | `{clientId}` | игрок «зашёл в игру» (++сессии) |
| POST | `/api/words` | `{clientId, seq, items:[{label,lang,good}]}` | пачка рассортированных слов |
| POST | `/api/round` | `{clientId, seq}` | раунд завершён (++rounds) |
| GET  | `/api/leaderboard` | — | публичный JSON (топ игроков + слова) |
| GET  | `/api/admin` | `?token=…` | приватная сводка + IP-инженерия |
| GET  | `/api/health` | — | `{"ok":true}` |

Фронт (`game.js`) уже шлёт всё это сам — fire-and-forget, с `sendBeacon` на закрытии
вкладки. Если бэкенд недоступен, игра работает как обычно.

---

## Конфиг (переменные окружения)

| Переменная | По умолчанию | Что |
|-----------|--------------|-----|
| `SORTER_HOST` | `127.0.0.1` | адрес прослушки (за nginx — локалхост) |
| `SORTER_PORT` | `8787` | порт |
| `SORTER_ALLOW_ORIGIN` | `https://sorter.barinbo.im` | разрешённые origin'ы CORS (через запятую) |
| `SORTER_TRUST_PROXY` | `1` | брать IP из `X-Forwarded-For`/`X-Real-IP` (нужно за nginx) |
| `SORTER_ADMIN_TOKEN` | — | токен для `/api/admin` (пуст → admin выключен) |
| `SORTER_SALT` / `SORTER_SALT_FILE` | `salt.secret` | соль для хеша IP |
| `SORTER_DB` | `stats.db` | путь к SQLite |

---

## Локальный запуск (проверить)

```bash
cd server
SORTER_ADMIN_TOKEN=dev python3 sorter_stats.py
# в другом терминале:
curl -XPOST localhost:8787/api/hello -d '{"clientId":"c1"}'
curl -XPOST localhost:8787/api/words -d '{"clientId":"c1","seq":1,"items":[{"label":"такелаж","lang":"ru","good":true}]}'
curl localhost:8787/api/leaderboard
curl "localhost:8787/api/admin?token=dev"
```

---

## Деплой на VPS (один раз)

Предполагается Debian/Ubuntu + nginx. Скорректируй под себя.

```bash
# 1. код на сервер
sudo mkdir -p /opt/sorter
sudo rsync -a server/ /opt/sorter/server/      # или git clone и symlink

# 2. отдельный пользователь
sudo useradd -r -s /usr/sbin/nologin sorter
sudo chown -R sorter:sorter /opt/sorter

# 3. секреты
sudo cp /opt/sorter/server/sorter-stats.env.example /etc/sorter-stats.env
sudo sed -i "s/ЗАМЕНИ.*/$(openssl rand -hex 24)/" /etc/sorter-stats.env   # admin-токен
sudo chmod 600 /etc/sorter-stats.env

# 4. systemd
sudo cp /opt/sorter/server/sorter-stats.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now sorter-stats
sudo systemctl status sorter-stats        # должно быть active (running)

# 5. nginx + TLS (api.barinbo.im → IP VPS в DNS заранее)
sudo cp /opt/sorter/server/nginx.conf.example /etc/nginx/sites-available/api.barinbo.im
sudo ln -s /etc/nginx/sites-available/api.barinbo.im /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d api.barinbo.im    # выдаст HTTPS

# 6. бэкап соли (без неё игроки обнуляются)!
sudo cp /opt/sorter/server/salt.secret ~/sorter-salt.backup
```

## Подключить фронт

В `game.js` (корень репо) вверху найди и поставь свой хост:

```js
var API_BASE = "https://api.barinbo.im";   // ← URL этого бэкенда; "" чтобы выключить
```

Запушь — GitHub Pages обновится. Кнопки «🏆 Лидерборд» появятся на старт-экране и
в итогах. Если оставить `API_BASE = ""`, телеметрия и кнопки выключены, игра ходит
только к своим `.jsonl` (как 1.0).

## Своя приватная сводка

```bash
curl "https://api.barinbo.im/api/admin?token=ТВОЙ_ТОКЕН" | python3 -m json.tool
```
Отдаёт тоталы (игроки, слова, сессии, раунды), пер-игроцкую вовлечённость
(сколько слов «наиграл» каждый хеш) и разбивку по языкам.
