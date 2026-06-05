ДАННЫЕ ИГРЫ — источники и лицензии
==================================

pool_<lang>.jsonl — игровые пулы слов, собранные скриптами ../scripts/.
Это производные данные; рантайм игры читает только их.

Источники
---------
1. Викисловарь через Wiktextract / kaikki.org
   https://kaikki.org
   Per-language машиночитаемые дампы (JSON Lines).
   Лицензия: CC BY-SA (как у Викисловаря). Производные пулы наследуют CC BY-SA.
   Атрибуция: Wiktionary contributors; extraction by Tatu Ylonen / kaikki.org.

2. Частотные списки (только этап сборки, в игре не используются)
   hermitdave/FrequencyWords — https://github.com/hermitdave/FrequencyWords
   На основе субтитров OpenSubtitles. Лицензия: MIT (репозиторий списков).
   Файлы freq_<lang>.txt — локальный кэш для пересборки; можно не публиковать.

Языки и режим сборки
--------------------
  ru en fr it el   — freq-режим (средне-частотная полоса)
  la grc sa        — reservoir-режим (равномерная выборка, частот нет)

Транслитерация (поле tr) обязательна для sa/grc/el (деванагари/греческица),
берётся из forms[*] (romanization) дампа kaikki.

Пересобрать:  cd ..  &&  bash scripts/fetch_all.sh
