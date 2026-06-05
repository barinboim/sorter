#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build_pools.py — одноразовая сборка игровых пулов слов из дампов kaikki.org
(Wiktextract). НЕ часть рантайма игры.

Читает JSONL (одна статья Викисловаря = одна строка) из STDIN, фильтрует и
нормализует, пишет data/pool_<lang>.jsonl со строками строго вида:

    {"w": "такелаж", "g": "оснастка судна; снасти", "tr": null, "lang": "ru", "pos": "noun"}

  w    — заголовок статьи (для деванагари/греческого — оригинальное письмо).
  g    — краткий глосс (первое значение). Обязателен.
  tr   — транслитерация латиницей. Обязательна для sa/grc/el, иначе null.
  lang — код языка (ru/en/fr/it/grc/el/la/sa).
  pos  — часть речи (noun/adj/verb).

Использование (стримом, чтобы гигабайтные дампы не падали на диск):

    curl -sL "<kaikki-url>" | python3 scripts/build_pools.py --lang ru --freq data/freq_ru.txt

Для языков без частотного списка (la/grc/sa) применяется равномерная выборка
(reservoir sampling) по всему файлу — иначе был бы алфавитный перекос к началу.
Для языков с частотами (ru/en/fr/it/el) берётся средне-частотная полоса:
отсекаются и сверхчастотный бытовой верх, и сверхредкий хвост.
"""

import sys
import os
import json
import argparse
import random
import re
import unicodedata

# --- что оставляем -----------------------------------------------------------

KEEP_POS = {"noun", "adj", "verb"}

# Если у любого значения есть такой тег — статью выкидываем целиком.
BAD_TAGS = {
    "vulgar", "offensive", "derogatory", "slur", "ethnic-slur",
    "obscene", "pejorative",
}

# Глоссы-«не-слова»: формы, отсылки, имена собственные — для нейминга мусор.
BAD_GLOSS_RE = re.compile(
    r"^(alternative |obsolete |archaic spelling|misspelling|nonstandard spelling|"
    r"plural of|singular of|genitive of|dative of|accusative of|vocative of|"
    r"nominative of|ablative of|locative of|instrumental of|"
    r"inflection of|inflected form|romanization of|romanisation of|transliteration of|"
    r"feminine of|masculine of|neuter of|diminutive of|augmentative of|"
    r"comparative of|superlative of|frequentative of|"
    r"synonym of|alternative form|alternative spelling|alternative name|"
    r"abbreviation of|initialism of|acronym of|clipping of|short for|"
    r"a surname|a male given name|a female given name|a given name|a unisex given name|"
    r"a placeholder name|honorific|patronymic|"
    r"present participle of|past participle of|gerund of|gerundive of|"
    r"used to|used as|used in|misspelling of)",
    re.IGNORECASE,
)

# Символы, которых в красивом нейм-слове быть не должно.
BAD_CHARS = set("0123456789/\\()[]<>=+*@#_|{}~^$%&\"")


# --- утилиты -----------------------------------------------------------------

# Греческий → латиница (запасной транслит, если в forms нет romanization).
_GREEK_MAP = {
    "α": "a", "β": "b", "γ": "g", "δ": "d", "ε": "e", "ζ": "z", "η": "e",
    "θ": "th", "ι": "i", "κ": "k", "λ": "l", "μ": "m", "ν": "n", "ξ": "x",
    "ο": "o", "π": "p", "ρ": "r", "σ": "s", "ς": "s", "τ": "t", "υ": "y",
    "φ": "ph", "χ": "ch", "ψ": "ps", "ω": "o",
}


def greek_translit(w):
    """Грубая, но детерминированная латинизация греческого — как подсказка глазу."""
    out = []
    for ch in unicodedata.normalize("NFD", w):
        if unicodedata.combining(ch):
            continue  # сбрасываем ударения/придыхания
        low = ch.lower()
        if low in _GREEK_MAP:
            mapped = _GREEK_MAP[low]
            out.append(mapped.upper() if ch.isupper() else mapped)
        elif ch.isspace() or ch == "-":
            out.append(ch)
    res = "".join(out).strip()
    return res or None


def clean_gloss(g):
    g = re.sub(r"\s+", " ", g).strip().strip(" .;,")
    if len(g) > 140:
        g = g[:140].rsplit(" ", 1)[0] + "…"
    return g


def valid_headword(w):
    """2–18 символов для однословных; ≤3 слов; без цифр и мусорных символов."""
    if not w:
        return None
    w = w.strip()
    if not w or w[0] == "-" or w[-1] == "-":
        return None
    if any(ch in BAD_CHARS for ch in w):
        return None
    parts = w.split()
    if len(parts) > 3:
        return None
    if len(parts) == 1:
        if not (2 <= len(w) <= 18):
            return None
    else:
        if len(w) > 32:
            return None
    return w


def entry_has_bad_tag(entry):
    for s in entry.get("senses") or []:
        tags = s.get("tags") or []
        if any(t in BAD_TAGS for t in tags):
            return True
    return False


def first_good_gloss(entry):
    """Первый содержательный глосс; пропускаем формы/отсылки/имена."""
    for s in entry.get("senses") or []:
        if s.get("form_of") or s.get("alt_of"):
            continue
        glosses = s.get("glosses") or s.get("raw_glosses") or []
        if not glosses:
            continue
        g = glosses[0].strip()
        if not g or BAD_GLOSS_RE.match(g):
            continue
        return clean_gloss(g)
    return None


def extract_tr(entry):
    """Транслитерация из forms (tag=romanization/…), затем из sense.roman."""
    for f in entry.get("forms") or []:
        tags = f.get("tags") or []
        if "romanization" in tags or "transliteration" in tags or "transcription" in tags:
            form = (f.get("form") or "").strip()
            if form and form not in ("no-table-tags", "-"):
                return form
    for s in entry.get("senses") or []:
        r = s.get("roman")
        if r:
            return r.strip()
    r = entry.get("roman")
    return r.strip() if r else None


def build_record(entry, lang):
    if entry.get("lang_code") and entry["lang_code"] != lang:
        return None
    pos = entry.get("pos")
    if pos not in KEEP_POS:
        return None
    w = valid_headword(entry.get("word") or "")
    if not w:
        return None
    if entry_has_bad_tag(entry):
        return None
    g = first_good_gloss(entry)
    if not g:
        return None
    tr = None
    if lang in ("grc", "el", "sa"):
        tr = extract_tr(entry)
        if not tr and lang in ("grc", "el"):
            tr = greek_translit(w)
        if not tr:
            return None  # для этих языков транслит обязателен
    return {"w": w, "g": g, "tr": tr, "lang": lang, "pos": pos}


def load_freq(path, hi):
    """word -> rank (0 = самое частотное), только верхние `hi` строк."""
    rank = {}
    with open(path, encoding="utf-8") as fh:
        for i, line in enumerate(fh):
            if i >= hi:
                break
            tok = line.split()
            if not tok:
                continue
            w = tok[0].strip().lower()
            if w and w not in rank:
                rank[w] = i
    return rank


def write_out(path, records):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        for r in records:
            fh.write(json.dumps(r, ensure_ascii=False) + "\n")


# --- основной цикл -----------------------------------------------------------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--lang", required=True, help="код языка: ru/en/fr/it/grc/el/la/sa")
    ap.add_argument("--out", default=None, help="путь вывода (по умолч. data/pool_<lang>.jsonl)")
    ap.add_argument("--cap", type=int, default=40000, help="максимум слов в пуле")
    ap.add_argument("--freq", default=None, help="частотный список hermitdave (word count)")
    ap.add_argument("--freq-lo", type=int, default=120, help="отсечь верхние N частотных (бытовой топ)")
    ap.add_argument("--freq-hi", type=int, default=45000, help="нижняя граница частотной полосы")
    ap.add_argument("--seed", type=int, default=1234, help="seed для reservoir-выборки")
    args = ap.parse_args()

    out = args.out or os.path.join("data", "pool_%s.jsonl" % args.lang)
    use_freq = bool(args.freq) and os.path.exists(args.freq) and os.path.getsize(args.freq) > 0
    freq = load_freq(args.freq, args.freq_hi) if use_freq else None

    seen = set()
    rng = random.Random(args.seed)
    collected = []     # freq-режим: (rank, record)
    reservoir = []     # reservoir-режим
    n_valid = 0
    n_lines = 0

    for line in sys.stdin:
        n_lines += 1
        line = line.strip()
        if not line:
            continue
        try:
            entry = json.loads(line)
        except Exception:
            continue
        rec = build_record(entry, args.lang)
        if rec is None:
            continue
        key = rec["w"].lower()
        if key in seen:
            continue

        if use_freq:
            r = freq.get(key)
            if r is None or r < args.freq_lo:
                continue
            seen.add(key)
            collected.append((r, rec))
        else:
            seen.add(key)
            n_valid += 1
            if len(reservoir) < args.cap:
                reservoir.append(rec)
            else:
                j = rng.randint(0, n_valid - 1)
                if j < args.cap:
                    reservoir[j] = rec

    if use_freq:
        collected.sort(key=lambda x: x[0])
        records = [r for _, r in collected[:args.cap]]
    else:
        records = reservoir

    write_out(out, records)

    by_pos = {}
    for r in records:
        by_pos[r["pos"]] = by_pos.get(r["pos"], 0) + 1
    mode = "freq" if use_freq else "reservoir"
    sys.stderr.write(
        "[%s] lines=%d kept=%d mode=%s pos=%s -> %s\n"
        % (args.lang, n_lines, len(records), mode, by_pos, out)
    )


if __name__ == "__main__":
    main()
