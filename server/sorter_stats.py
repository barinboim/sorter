#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Sorter stats — крошечный бэкенд для кросс-игрового лидерборда.

Чистая стандартная библиотека Python 3.8+ (http.server + sqlite3), без
зависимостей и фреймворков — ставится на любой VPS. Считает:
  • уникальных игроков по СОЛЁНОМУ ХЕШУ IP (сырой IP не хранится — GDPR-friendly);
  • сколько слов каждый «наиграл» (good / bad / всего) и сколько раундов;
  • агрегаты по словам — «самые любимые» и «самые ненавистные» через всех игроков.

Игра (статический сайт на GitHub Pages) шлёт сюда события fetch/sendBeacon.
Эндпоинты:
  POST /api/hello   {clientId}                         — регистрирует сессию (IP «зашёл в игру»)
  POST /api/words   {clientId, seq, items:[…]}         — пачка рассортированных слов
  POST /api/round   {clientId, seq}                    — раунд завершён (++rounds)
  GET  /api/leaderboard                                — публичный лидерборд (JSON)
  GET  /api/admin?token=…                              — приватная сводка с IP-инженерией

Запуск:
  SORTER_ADMIN_TOKEN=secret python3 sorter_stats.py
Конфиг через переменные окружения — см. ниже и server/README.md.
"""

import os
import re
import json
import time
import hmac
import sqlite3
import hashlib
import secrets
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# ── конфиг (всё через env) ──────────────────────────────────────────────────
HOST          = os.environ.get("SORTER_HOST", "127.0.0.1")
PORT          = int(os.environ.get("SORTER_PORT", "8787"))
DB_PATH       = os.environ.get("SORTER_DB", os.path.join(os.path.dirname(os.path.abspath(__file__)), "stats.db"))
SALT_PATH     = os.environ.get("SORTER_SALT_FILE", os.path.join(os.path.dirname(os.path.abspath(__file__)), "salt.secret"))
ADMIN_TOKEN   = os.environ.get("SORTER_ADMIN_TOKEN", "")
# CORS: какому origin'у можно. Несколько — через запятую. По умолчанию боевой домен игры.
ALLOW_ORIGINS = [o.strip() for o in os.environ.get(
    "SORTER_ALLOW_ORIGIN", "https://sorter.barinbo.im").split(",") if o.strip()]
# Доверять заголовкам прокси (nginx) для реального IP. На VPS за nginx — нужно true.
TRUST_PROXY   = os.environ.get("SORTER_TRUST_PROXY", "1") not in ("0", "false", "no", "")

MAX_BODY      = 64 * 1024     # потолок тела запроса
MAX_ITEMS     = 400           # слов в одной пачке
MAX_STR       = 80            # обрезаем длинные строки

# ── соль для хеша IP (секретная, стабильная) ────────────────────────────────
def _load_salt():
    env = os.environ.get("SORTER_SALT")
    if env:
        return env.encode("utf-8")
    try:
        with open(SALT_PATH, "rb") as f:
            data = f.read().strip()
            if data:
                return data
    except FileNotFoundError:
        pass
    salt = secrets.token_hex(32).encode("utf-8")
    try:
        # пишем 0600 — соль не должна утечь, иначе хеши становятся обратимыми
        fd = os.open(SALT_PATH, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "wb") as f:
            f.write(salt)
        print("[sorter] сгенерирована новая соль → %s (бэкапни её, иначе игроки «обнулятся»)" % SALT_PATH)
    except OSError as e:
        print("[sorter] ВНИМАНИЕ: не смог записать соль (%s) — использую эфемерную, игроки сбросятся после рестарта" % e)
    return salt

SALT = _load_salt()

def ip_hash(ip):
    return hmac.new(SALT, ip.encode("utf-8"), hashlib.sha256).hexdigest()

# ── генерация ника из хеша (детерминированно, без хранения IP) ───────────────
ADJ = ["neon", "amber", "cobalt", "ivory", "crimson", "jade", "onyx", "lunar",
       "solar", "velvet", "frost", "ember", "azure", "scarlet", "silver", "gilded",
       "quiet", "bright", "feral", "ancient", "swift", "noble", "wild", "vivid"]
NOUN = ["otter", "falcon", "lynx", "heron", "marten", "ibis", "raven", "vole",
        "stoat", "tern", "shrike", "auk", "civet", "tapir", "okapi", "saiga",
        "kestrel", "mantis", "narwhal", "quokka", "serval", "tahr", "wren", "yak"]

def nick_for(h):
    a = int(h[0:8], 16) % len(ADJ)
    n = int(h[8:16], 16) % len(NOUN)
    num = int(h[16:20], 16) % 100
    return "%s-%s-%02d" % (ADJ[a], NOUN[n], num)

# ── БД ──────────────────────────────────────────────────────────────────────
_db_lock = threading.Lock()

def db():
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    return conn

def init_db():
    conn = db()
    conn.executescript("""
    CREATE TABLE IF NOT EXISTS players (
      id         TEXT PRIMARY KEY,   -- солёный хеш IP (сырой IP не хранится)
      nick       TEXT,
      first_seen INTEGER,
      last_seen  INTEGER,
      sessions   INTEGER DEFAULT 0,
      words      INTEGER DEFAULT 0,
      good       INTEGER DEFAULT 0,
      bad        INTEGER DEFAULT 0,
      rounds     INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS word_votes (
      label TEXT,                    -- видимый токен (для grc/el/sa — транслит)
      lang  TEXT,
      good  INTEGER DEFAULT 0,
      bad   INTEGER DEFAULT 0,
      PRIMARY KEY (label, lang)
    );
    CREATE TABLE IF NOT EXISTS seen_batches (
      client_id TEXT,
      kind      TEXT,                -- 'words' | 'round'
      seq       INTEGER,
      ts        INTEGER,
      PRIMARY KEY (client_id, kind, seq)
    );
    CREATE INDEX IF NOT EXISTS idx_wv_good ON word_votes(good DESC);
    CREATE INDEX IF NOT EXISTS idx_wv_bad  ON word_votes(bad DESC);
    """)
    conn.commit()
    conn.close()

def ensure_player(conn, pid, now):
    row = conn.execute("SELECT id FROM players WHERE id=?", (pid,)).fetchone()
    if row is None:
        conn.execute(
            "INSERT INTO players (id, nick, first_seen, last_seen) VALUES (?,?,?,?)",
            (pid, nick_for(pid), now, now))
    else:
        conn.execute("UPDATE players SET last_seen=? WHERE id=?", (now, pid))

def fresh_batch(conn, client_id, kind, seq, now):
    """True, если пачку видим впервые (иначе дубликат retry/beacon — игнорим)."""
    if not isinstance(seq, int):
        return True  # без seq дедуп не делаем
    try:
        conn.execute(
            "INSERT INTO seen_batches (client_id, kind, seq, ts) VALUES (?,?,?,?)",
            (str(client_id)[:64], kind, seq, now))
        return True
    except sqlite3.IntegrityError:
        return False

# ── утилиты ─────────────────────────────────────────────────────────────────
def clean_str(s):
    if not isinstance(s, str):
        return ""
    s = s.strip().replace("\n", " ").replace("\t", " ")
    return s[:MAX_STR]

def client_ip(handler):
    if TRUST_PROXY:
        xff = handler.headers.get("X-Forwarded-For")
        if xff:
            return xff.split(",")[0].strip()
        xri = handler.headers.get("X-Real-IP")
        if xri:
            return xri.strip()
    return handler.client_address[0]


class Handler(BaseHTTPRequestHandler):
    server_version = "sorter-stats/1.0"
    protocol_version = "HTTP/1.1"

    # ── CORS / ответы ─────────────────────────────────────────────────────
    def _cors(self):
        origin = self.headers.get("Origin", "")
        allow = origin if origin in ALLOW_ORIGINS else (ALLOW_ORIGINS[0] if ALLOW_ORIGINS else "*")
        self.send_header("Access-Control-Allow-Origin", allow)
        self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Max-Age", "86400")

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _read_json(self):
        try:
            n = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return None
        if n <= 0 or n > MAX_BODY:
            return None
        raw = self.rfile.read(n)
        try:
            obj = json.loads(raw.decode("utf-8"))
            return obj if isinstance(obj, dict) else None
        except (ValueError, UnicodeDecodeError):
            return None

    def log_message(self, fmt, *args):
        pass  # тихо; логирование берёт на себя nginx

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/api/leaderboard":
            return self.leaderboard()
        if path == "/api/admin":
            return self.admin()
        if path in ("/", "/health", "/api/health"):
            return self._json(200, {"ok": True})
        return self._json(404, {"error": "not found"})

    def do_POST(self):
        path = self.path.split("?")[0]
        if path == "/api/hello":
            return self.hello()
        if path == "/api/words":
            return self.words()
        if path == "/api/round":
            return self.round_done()
        return self._json(404, {"error": "not found"})

    # ── POST /api/hello ───────────────────────────────────────────────────
    def hello(self):
        data = self._read_json() or {}
        client_id = clean_str(data.get("clientId", "")) or "anon"
        pid = ip_hash(client_ip(self))
        now = int(time.time())
        with _db_lock:
            conn = db()
            try:
                ensure_player(conn, pid, now)
                conn.execute("UPDATE players SET sessions = sessions + 1 WHERE id=?", (pid,))
                conn.commit()
                nick = conn.execute("SELECT nick FROM players WHERE id=?", (pid,)).fetchone()["nick"]
            finally:
                conn.close()
        self._json(200, {"ok": True, "nick": nick})

    # ── POST /api/words ───────────────────────────────────────────────────
    def words(self):
        data = self._read_json()
        if data is None:
            return self._json(400, {"error": "bad json"})
        items = data.get("items")
        if not isinstance(items, list):
            return self._json(400, {"error": "items required"})
        client_id = clean_str(data.get("clientId", "")) or "anon"
        seq = data.get("seq")
        pid = ip_hash(client_ip(self))
        now = int(time.time())
        with _db_lock:
            conn = db()
            try:
                if not fresh_batch(conn, client_id, "words", seq, now):
                    conn.commit()
                    return self._json(200, {"ok": True, "dup": True})
                ensure_player(conn, pid, now)
                ng = nb = 0
                for it in items[:MAX_ITEMS]:
                    if not isinstance(it, dict):
                        continue
                    label = clean_str(it.get("label", ""))
                    lang = clean_str(it.get("lang", "")) or "?"
                    good = bool(it.get("good"))
                    if not label:
                        continue
                    if good: ng += 1
                    else:    nb += 1
                    conn.execute(
                        "INSERT INTO word_votes (label, lang, good, bad) VALUES (?,?,?,?) "
                        "ON CONFLICT(label, lang) DO UPDATE SET good=good+?, bad=bad+?",
                        (label, lang, 1 if good else 0, 0 if good else 1,
                         1 if good else 0, 0 if good else 1))
                conn.execute(
                    "UPDATE players SET words=words+?, good=good+?, bad=bad+?, last_seen=? WHERE id=?",
                    (ng + nb, ng, nb, now, pid))
                conn.commit()
            finally:
                conn.close()
        self._json(200, {"ok": True, "counted": ng + nb})

    # ── POST /api/round ───────────────────────────────────────────────────
    def round_done(self):
        data = self._read_json() or {}
        client_id = clean_str(data.get("clientId", "")) or "anon"
        seq = data.get("seq")
        pid = ip_hash(client_ip(self))
        now = int(time.time())
        with _db_lock:
            conn = db()
            try:
                if not fresh_batch(conn, client_id, "round", seq, now):
                    conn.commit()
                    return self._json(200, {"ok": True, "dup": True})
                ensure_player(conn, pid, now)
                conn.execute("UPDATE players SET rounds=rounds+1, last_seen=? WHERE id=?", (now, pid))
                conn.commit()
            finally:
                conn.close()
        self._json(200, {"ok": True})

    # ── GET /api/leaderboard (публичный) ──────────────────────────────────
    def leaderboard(self):
        conn = db()
        try:
            top = [dict(r) for r in conn.execute(
                "SELECT nick, words, good, bad, rounds FROM players "
                "WHERE words > 0 ORDER BY words DESC, good DESC LIMIT 20").fetchall()]
            loved = [dict(r) for r in conn.execute(
                "SELECT label, lang, good, bad FROM word_votes "
                "WHERE good > 0 ORDER BY good DESC, bad ASC LIMIT 15").fetchall()]
            hated = [dict(r) for r in conn.execute(
                "SELECT label, lang, good, bad FROM word_votes "
                "WHERE bad > 0 ORDER BY bad DESC, good ASC LIMIT 15").fetchall()]
            agg = conn.execute(
                "SELECT COUNT(*) players, COALESCE(SUM(words),0) words, "
                "COALESCE(SUM(good),0) good, COALESCE(SUM(bad),0) bad, "
                "COALESCE(SUM(rounds),0) rounds FROM players").fetchone()
        finally:
            conn.close()
        self._json(200, {
            "totals": dict(agg),
            "players": top,
            "loved": loved,
            "hated": hated,
        })

    # ── GET /api/admin?token=… (приватный) ────────────────────────────────
    def admin(self):
        q = self.path.split("?", 1)[1] if "?" in self.path else ""
        token = ""
        for part in q.split("&"):
            if part.startswith("token="):
                token = part[6:]
        if not ADMIN_TOKEN or not hmac.compare_digest(token, ADMIN_TOKEN):
            return self._json(403, {"error": "forbidden"})
        conn = db()
        try:
            agg = dict(conn.execute(
                "SELECT COUNT(*) players, COALESCE(SUM(words),0) words, "
                "COALESCE(SUM(good),0) good, COALESCE(SUM(bad),0) bad, "
                "COALESCE(SUM(sessions),0) sessions, COALESCE(SUM(rounds),0) rounds "
                "FROM players").fetchone())
            # по-игроцкая инженерия вовлечённости (id = префикс хеша, не IP)
            players = []
            for r in conn.execute(
                "SELECT id, nick, first_seen, last_seen, sessions, words, good, bad, rounds "
                "FROM players ORDER BY words DESC LIMIT 500").fetchall():
                d = dict(r)
                d["id"] = d["id"][:12]   # короткий префикс хеша — для глаза, не восстановим IP
                players.append(d)
            langs = [dict(r) for r in conn.execute(
                "SELECT lang, COALESCE(SUM(good),0) good, COALESCE(SUM(bad),0) bad, "
                "COUNT(*) uniq FROM word_votes GROUP BY lang ORDER BY good+bad DESC").fetchall()]
        finally:
            conn.close()
        self._json(200, {"totals": agg, "players": players, "languages": langs})


def main():
    init_db()
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    httpd.daemon_threads = True
    print("[sorter] stats на http://%s:%d  · db=%s · origins=%s · proxy=%s"
          % (HOST, PORT, DB_PATH, ",".join(ALLOW_ORIGINS), TRUST_PROXY))
    if not ADMIN_TOKEN:
        print("[sorter] ВНИМАНИЕ: SORTER_ADMIN_TOKEN пуст — /api/admin отключён до установки токена.")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
