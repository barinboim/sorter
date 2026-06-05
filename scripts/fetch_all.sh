#!/usr/bin/env bash
# Одноразовая загрузка словарей kaikki.org + частот hermitdave и сборка пулов.
# Дампы СТРИМЯТСЯ через build_pools.py — гигабайты на диск не сохраняются.
# Запуск:  bash scripts/fetch_all.sh   (из корня проекта sorter/)
# (без set -u — системный bash 3.2 на macOS падает на пустых массивах)
set -o pipefail

cd "$(dirname "$0")/.." || exit 1
mkdir -p data logs
PY=python3
B=scripts/build_pools.py
LOG=logs/build.log
: > "$LOG"

CURL="curl --retry 3 --retry-delay 2 --fail -sL"

freq() {  # код -> data/freq_<код>.txt (частотный список OpenSubtitles)
  local c="$1" out="data/freq_$1.txt"
  if [ ! -s "$out" ]; then
    $CURL "https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/${c}/${c}_50k.txt" -o "$out" \
      || echo "[warn] freq $c не скачался — язык соберётся без частот" | tee -a "$LOG"
  fi
}

build() {  # lang  url  [freq-код]
  local lang="$1" url="$2" fc="${3:-}"
  local out="data/pool_${lang}.jsonl"
  if [ -s "$out" ]; then
    echo "[$(date +%H:%M:%S)] == $lang уже собран ($(wc -l < "$out") слов) — пропуск" | tee -a "$LOG"
    return
  fi
  local fa=()
  if [ -n "$fc" ]; then freq "$fc"; [ -s "data/freq_${fc}.txt" ] && fa=(--freq "data/freq_${fc}.txt"); fi
  echo "[$(date +%H:%M:%S)] >>> $lang  $url" | tee -a "$LOG"
  $CURL "$url" | "$PY" "$B" --lang "$lang" ${fa[@]+"${fa[@]}"} 2>>"$LOG"
  local n=0; [ -f "$out" ] && n=$(wc -l < "$out")
  echo "[$(date +%H:%M:%S)] <<< $lang  итог: $n слов" | tee -a "$LOG"
}

K="https://kaikki.org/dictionary"

# от малого к большому — мелкие пулы готовы первыми, можно тестировать игру
build sa  "$K/Sanskrit/kaikki.org-dictionary-Sanskrit.jsonl"
build el  "$K/Greek/kaikki.org-dictionary-Greek.jsonl"               el
build grc "$K/Ancient%20Greek/kaikki.org-dictionary-AncientGreek.jsonl"
build fr  "$K/French/kaikki.org-dictionary-French.jsonl"             fr
build it  "$K/Italian/kaikki.org-dictionary-Italian.jsonl"           it
build ru  "$K/Russian/kaikki.org-dictionary-Russian.jsonl"           ru
build la  "$K/Latin/kaikki.org-dictionary-Latin.jsonl"
build en  "$K/English/kaikki.org-dictionary-English.jsonl"           en

echo "[$(date +%H:%M:%S)] ВСЁ ГОТОВО" | tee -a "$LOG"
wc -l data/pool_*.jsonl 2>/dev/null | tee -a "$LOG"
