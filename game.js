/* Сортировщик — игровой цикл. Vanilla JS, без сборки. Работает на localhost. */
(function () {
  "use strict";

  // ── языки ──────────────────────────────────────────────────────────────
  var BASE_LANGS = [
    { code: "ru",  label: "RU",  name: "Русский" },
    { code: "en",  label: "EN",  name: "English" },
    { code: "fr",  label: "FR",  name: "Français" },
    { code: "it",  label: "IT",  name: "Italiano" },
    { code: "la",  label: "LA",  name: "Латынь" },
    { code: "grc", label: "GRC", name: "Древнегреческий" },
    { code: "el",  label: "EL",  name: "Новогреческий" },
    { code: "sa",  label: "SA",  name: "Санскрит" }
  ];
  // LANGS = базовые + свои словари (каждый — «язык» custom:<id>); пересобирается
  var LANGS = BASE_LANGS.slice();
  var LABEL = {};
  function rebuildLangs() {
    LANGS = BASE_LANGS.concat(customDicts().map(function (d) { return { code: "custom:" + d.id, label: "✎", name: d.name }; }));
    LABEL = {}; LANGS.forEach(function (L) { LABEL[L.code] = L.label; });
  }
  LANGS.forEach(function (L) { LABEL[L.code] = L.label; });
  // бейдж языка: для своего словаря — его полное имя (вместо ✎), иначе короткий код
  function langBadge(code) {
    if (code && code.indexOf("custom:") === 0) {
      var arr = customDicts();
      for (var i = 0; i < arr.length; i++) if ("custom:" + arr[i].id === code) return arr[i].name;
      return "✎";
    }
    return LABEL[code] || (code ? String(code).toUpperCase() : code);
  }
  var TR_LANGS = { grc: 1, el: 1, sa: 1 };     // крупный токен = транслит
  var ROUND_SIZE = 100;

  // крупный токен карточки = транслит для grc/el/sa, иначе само слово
  function bigToken(w) { return (TR_LANGS[w.lang] && w.tr) ? w.tr : w.w; }
  // число букв видимого слова: снимаем комбинирующие знаки, считаем \p{L}
  function letterCount(s) {
    var d = (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "");
    var m = d.match(/\p{L}/gu);
    return m ? m.length : 0;
  }
  // фильтр кандидата: только однословные + попадание в диапазон длины
  function passes(w) {
    if (w.w.indexOf(" ") !== -1) return false;
    var n = letterCount(bigToken(w));
    return n >= settings.lenMin && n <= settings.lenMax;
  }

  // ── фонетические признаки (для адаптивного подбора, рычаг 1) ─────────────
  var VOWELS = "aeiouyаеёиоуыэюя";
  function baseForm(s) {
    return (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-zа-яё]/g, "");
  }
  function isVowel(ch) { return !!ch && VOWELS.indexOf(ch) >= 0; }
  function initClass(ch) {
    if (!ch) return "x";
    if (isVowel(ch)) return "vowel";
    if ("pbtdkgкгтдпб".indexOf(ch) >= 0) return "plosive";
    if ("fvszхцчщ".indexOf(ch) >= 0) return "fricative";
    if ("lrлр".indexOf(ch) >= 0) return "liquid";
    if ("mnмн".indexOf(ch) >= 0) return "nasal";
    if ("jwyйшж".indexOf(ch) >= 0) return "glide";
    return "other";
  }
  function syllables(b) {
    var n = 0, prev = false;
    for (var i = 0; i < b.length; i++) { var v = isVowel(b[i]); if (v && !prev) n++; prev = v; }
    return n || 1;
  }
  // признаки: язык, часть речи, длина, слоги, начальный звук, окончание, дубль
  function featuresOf(word) {
    var b = baseForm(bigToken(word)) || "x", L = b.length;
    return [
      "lang:" + (word.lang || "coined"),
      "pos:" + (word.pos || "?"),
      L <= 4 ? "len:s" : (L <= 7 ? "len:m" : "len:l"),
      "syl:" + Math.min(syllables(b), 5),
      "init:" + initClass(b.charAt(0)),
      isVowel(b.charAt(b.length - 1)) ? "end:v" : "end:c",
      /(.)\1/.test(b) ? "dbl:1" : "dbl:0"
    ];
  }

  // ── localStorage ───────────────────────────────────────────────────────
  var K_PLAYED = "sorter.played.v1",
      K_SET    = "sorter.settings.v1",
      K_RND    = "sorter.roundno.v1",
      K_LAST   = "sorter.lastround.v1",
      K_TASTE  = "sorter.taste.v1",
      K_GOOD   = "sorter.goodcorpus.v1",
      K_DICTS  = "sorter.customdicts.v1",
      K_ALLGOOD = "sorter.allgood.v1",
      K_ALLBAD  = "sorter.allbad.v1",
      K_COMMENTS = "sorter.comments.v1";

  function load(k, def) { try { var v = JSON.parse(localStorage.getItem(k)); return v == null ? def : v; } catch (e) { return def; } }
  function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

  // ── состояние ──────────────────────────────────────────────────────────
  var poolByLang = {};                 // code -> [words]
  var played = new Set(load(K_PLAYED, []));
  var settings = load(K_SET, null) || { langs: {}, speed: 4 };
  if (!settings.langs || typeof settings.langs !== "object") settings.langs = {};
  LANGS.forEach(function (L) { if (!(L.code in settings.langs)) settings.langs[L.code] = true; });
  if (settings.lenMin == null) settings.lenMin = 2;
  if (settings.lenMax == null) settings.lenMax = 6;
  if (settings.roundSize == null) settings.roundSize = 100;
  if (settings.adaptive == null) settings.adaptive = true;
  if (settings.focus == null) settings.focus = 5;
  if (settings.animSpeed == null) settings.animSpeed = 1;

  // модель вкуса: наивный байес на признаках + вектор предпочтений по качествам Журавлёва
  function freshTaste() { var p = []; for (var i = 0; i < PHONO.N; i++) p.push(0); return { good: {}, bad: {}, ng: 0, nb: 0, P: p }; }
  var taste = load(K_TASTE, null) || freshTaste();
  if (!taste.P || taste.P.length !== PHONO.N) { taste.P = []; for (var _i = 0; _i < PHONO.N; _i++) taste.P.push(0); }
  var manualP = null;   // ручной набор качеств из настроек (перебивает выученный P)
  // корпус одобренных слов — ингредиенты для ковки (рычаг 2)
  var goodCorpus = load(K_GOOD, []);
  // кумулятивно «за всё время» + комментарии по словам (ключ lang|w)
  var allGood = load(K_ALLGOOD, []) || [];
  var allBad = load(K_ALLBAD, []) || [];
  var comments = load(K_COMMENTS, {}) || {};

  var round = null;
  var startMode = "discover";   // старт-экран всегда «поиск»; ковка запускается только с итогов (btnForgeRound)
  var resView = "round";        // экран итогов: round | all («за всё время»)
  var roundGen = 0;             // поколение раунда — чтобы стейл-колбэки не плодили карточки
  var ANIM = { fly: 300, appear: 190 };   // длительности анимаций (мс), задаются скоростью   // {cards:[], cursor, good:[], bad:[], target, active, locked}

  // ── DOM ────────────────────────────────────────────────────────────────
  var $ = function (id) { return document.getElementById(id); };
  var playfield = $("playfield"),
      basketGood = $("basketGood"), basketBad = $("basketBad"),
      skiphint = document.querySelector(".skiphint");

  // ── загрузка пулов ─────────────────────────────────────────────────────
  function parseJsonl(txt) {
    var out = [];
    var lines = txt.split("\n");
    for (var i = 0; i < lines.length; i++) {
      var s = lines[i].trim();
      if (!s) continue;
      try {
        var o = JSON.parse(s);
        if (o && o.w && o.g && o.lang) out.push(o);
      } catch (e) {}
    }
    return out;
  }

  function loadPools(onProgress) {
    var real = LANGS.filter(function (L) { return L.code.indexOf("custom") !== 0; });
    var done = 0, total = real.length;
    return Promise.all(real.map(function (L) {
      return fetch("data/pool_" + L.code + ".jsonl", { cache: "no-store" })
        .then(function (r) { return r.ok ? r.text() : ""; })
        .then(function (t) { if (t) poolByLang[L.code] = parseJsonl(t); })
        .catch(function () {})
        .then(function () { done++; if (onProgress) onProgress(done, total); });
    })).then(function () {
      var total = 0;
      LANGS.forEach(function (L) { total += (poolByLang[L.code] || []).length; });
      if (total > 0) return total;
      // фолбэк: сид-набор, если пулы ещё не собраны
      return fetch("data/sample.jsonl").then(function (r) { return r.text(); })
        .then(function (t) {
          parseJsonl(t).forEach(function (w) { (poolByLang[w.lang] = poolByLang[w.lang] || []).push(w); });
          var s = 0; LANGS.forEach(function (L) { s += (poolByLang[L.code] || []).length; });
          return s;
        }).catch(function () { return 0; });
    });
  }

  // ── вспомогательное ────────────────────────────────────────────────────
  function key(w) { return w.lang + "|" + w.w; }
  function shuffle(a) {
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }
  function candidates() {
    var out = [];
    LANGS.forEach(function (L) {
      if (!settings.langs[L.code]) return;
      var arr = poolByLang[L.code] || [];
      for (var i = 0; i < arr.length; i++) {
        if (!played.has(key(arr[i])) && passes(arr[i])) out.push(arr[i]);
      }
    });
    return out;
  }
  function availableCount() {
    var n = 0;
    LANGS.forEach(function (L) {
      if (!settings.langs[L.code]) return;
      var arr = poolByLang[L.code] || [];
      for (var i = 0; i < arr.length; i++) if (!played.has(key(arr[i])) && passes(arr[i])) n++;
    });
    return n;
  }

  // ── модель вкуса / адаптивный подбор (рычаг 1) ─────────────────────────
  var WARMUP = 10;
  function tasteTemp() {
    var s = Math.max(1, Math.min(10, settings.focus || 5));
    return 1.25 - (s - 1) / 9 * 1.05;   // 1.25 (разведка) .. 0.20 (фокус)
  }
  function adaptiveOn() { return settings.adaptive && (taste.ng + taste.nb) >= WARMUP; }
  function tasteUpdate(word, good) {
    var f = featuresOf(word), t = good ? taste.good : taste.bad;
    for (var i = 0; i < f.length; i++) t[f[i]] = (t[f[i]] || 0) + 1;
    if (good) taste.ng++; else taste.nb++;
    var qv = PHONO.vec(bigToken(word)), sgn = good ? 1 : -1;   // тянем P к качествам хороших слов
    for (var j = 0; j < taste.P.length; j++) taste.P[j] += qv[j] * sgn;
    save(K_TASTE, taste);
  }
  function activeP() { return manualP || taste.P; }
  function tasteScore(word) {
    var f = featuresOf(word), s = 0;
    for (var i = 0; i < f.length; i++) s += Math.log(((taste.good[f[i]] || 0) + 1) / ((taste.bad[f[i]] || 0) + 1));
    var P = activeP(), qv = PHONO.vec(bigToken(word)), dot = 0, mag = 0;
    for (var j = 0; j < P.length; j++) { dot += qv[j] * P[j]; mag += P[j] * P[j]; }
    if (mag > 0) s += dot / Math.sqrt(mag) * 0.8;   // вклад фоносемантики (P нормирован)
    return s;
  }
  // топ-n качеств-лидеров по |P|
  function phonLeaders(n) {
    var P = activeP(), arr = [];
    for (var i = 0; i < P.length; i++) arr.push({ i: i, v: P[i] });
    arr.sort(function (a, b) { return Math.abs(b.v) - Math.abs(a.v); });
    return arr.slice(0, n).map(function (x) { return { i: x.i, v: x.v, label: PHONO.pole(x.i, x.v) }; });
  }
  function updateLeaders() {
    var host = $("leaders"); if (!host) return;
    var manual = !!manualP, ready = manual || (taste.ng + taste.nb) >= 3;
    if (!ready) { host.className = "leaders"; host.innerHTML = ""; return; }
    var L = phonLeaders(5);
    var hi = Math.abs(L[0].v), lo = Math.abs(L[L.length - 1].v);
    if (!hi) { host.className = "leaders"; host.innerHTML = ""; return; }
    host.className = "leaders show";
    host.innerHTML = '<div class="lhead">' + (manual ? "мой набор качеств" : "качества-лидеры") + "</div>" +
      L.map(function (x) {
        var a = Math.abs(x.v);
        // усиливаем разрыв: 5-й ≈ 22%, лидер 100% — видно конкуренцию
        var w = hi <= lo ? 100 : Math.round(22 + (a - lo) / (hi - lo) * 78);
        return '<div class="lrow"><span class="lname">' + esc(x.label) + '</span><i style="width:' + w +
          '%"></i><b>' + (manual ? "•" : a.toFixed(1)) + "</b></div>";
      }).join("");
  }

  // ── ручной набор качеств (перебивает выученный P) ──────────────────────
  function manualHas(i, sign) { return (settings.manualQ || []).indexOf(i + ":" + sign) >= 0; }
  function toggleManual(i, sign) {
    settings.manualQ = settings.manualQ || [];
    var key = i + ":" + sign, oi = settings.manualQ.indexOf(i + ":" + (-sign));
    if (oi >= 0) settings.manualQ.splice(oi, 1);
    var ki = settings.manualQ.indexOf(key);
    if (ki >= 0) settings.manualQ.splice(ki, 1); else settings.manualQ.push(key);
    save(K_SET, settings);
  }
  function buildManualP() {
    var q = settings.manualQ || [];
    if (!q.length) { manualP = null; return; }
    var P = []; for (var i = 0; i < PHONO.N; i++) P.push(0);
    q.forEach(function (k) { var p = k.split(":"); P[+p[0]] = +p[1] * 2; });
    manualP = P;
  }
  function isLeader(i, sign) {
    var arr = [];
    for (var k = 0; k < taste.P.length; k++) arr.push({ i: k, v: taste.P[k] });
    arr.sort(function (a, b) { return Math.abs(b.v) - Math.abs(a.v); });
    var top = arr.slice(0, 5);
    for (var t = 0; t < top.length; t++) if (top[t].i === i && (top[t].v >= 0 ? 1 : -1) === sign && Math.abs(top[t].v) > 0.05) return true;
    return false;
  }
  function buildQpick() {
    var qp = $("qpick"); if (!qp) return; qp.innerHTML = "";
    PHONO.SCALES.forEach(function (sc, i) {
      for (var side = 0; side < 2; side++) {
        var sign = side === 0 ? 1 : -1;
        var chip = document.createElement("button");
        chip.className = "qchip" + (manualHas(i, sign) ? " on" : "") + (isLeader(i, sign) ? " lead" : "");
        chip.textContent = sc[side];
        (function (ii, ss) { chip.addEventListener("click", function () { toggleManual(ii, ss); buildQpick(); refreshQinfo(); updateLeaders(); }); })(i, sign);
        qp.appendChild(chip);
      }
    });
  }
  function refreshQinfo() {
    buildManualP();
    var el = $("leadersNow"); if (!el) return;
    if (manualP) { el.textContent = "ручной набор · " + settings.manualQ.length; el.className = "qlead manual"; }
    else {
      var L = phonLeaders(4).filter(function (x) { return Math.abs(x.v) > 0.05; });
      el.textContent = L.length ? L.map(function (x) { return x.label; }).join(" · ") : "учится…";
      el.className = "qlead";
    }
  }

  // ── проверка нейма по фоносемантике (вне геймплея) ─────────────────────
  function renderNeim(name, host) {
    if (!host) return;
    name = (name || "").trim();
    if (!name) { host.className = "neimres"; host.innerHTML = ""; return; }
    if (!PHONO.toPhonemes(name).length) { host.className = "neimres show"; host.innerHTML = '<div class="nempty">нет узнаваемых букв</div>'; return; }
    var v = PHONO.vec(name), arr = [];
    for (var i = 0; i < v.length; i++) arr.push({ i: i, v: v[i] });
    arr.sort(function (a, b) { return Math.abs(b.v) - Math.abs(a.v); });
    var top = arr.slice(0, 8), hi = Math.abs(top[0].v) || 1;
    host.className = "neimres show";
    host.innerHTML = top.map(function (x) {
      var w = Math.max(8, Math.round(Math.abs(x.v) / hi * 100));
      return '<div class="nrow"><span class="nname">' + esc(PHONO.pole(x.i, x.v)) + '</span><i style="width:' + w +
        '%"></i><b>' + (x.v >= 0 ? "+" : "") + x.v.toFixed(1) + "</b></div>";
    }).join("");
  }
  function setupNeim(inputId, resultId) {
    var inp = $(inputId), res = $(resultId);
    if (!inp || !res) return;
    inp.addEventListener("input", function () { renderNeim(inp.value, res); });
  }

  // ── свой словарь как «новый язык» ✎ ────────────────────────────────────
  function parseCustom(text, lang) {
    var out = [], lines = (text || "").split("\n");
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].replace(/\r$/, "").trim();
      if (!line || line.charAt(0) === "#") continue;
      var w = line, g = "", m = line.split(/\t| — | – | \| | :: | - /);
      if (m.length >= 2 && m[0].trim()) { w = m[0].trim(); g = m.slice(1).join(" ").trim(); }
      if (w) out.push({ w: w, g: g, tr: null, lang: lang || "custom", pos: "" });
    }
    return out;
  }
  function customDicts() { return load(K_DICTS, []) || []; }
  function saveDicts(arr) { save(K_DICTS, arr); }
  function loadCustomDicts() {
    customDicts().forEach(function (d) {
      poolByLang["custom:" + d.id] = parseCustom(d.text, "custom:" + d.id);
      if (settings.langs["custom:" + d.id] == null) settings.langs["custom:" + d.id] = true;
    });
    rebuildLangs();
  }
  function addCustomDict(name, text) {
    var dicts = customDicts();
    var id = "d" + (dicts.reduce(function (m, d) { return Math.max(m, +d.id.slice(1) || 0); }, 0) + 1);
    dicts.push({ id: id, name: (name || "Словарь").slice(0, 24), text: text || "" });
    saveDicts(dicts);
    poolByLang["custom:" + id] = parseCustom(text, "custom:" + id);
    settings.langs["custom:" + id] = true; save(K_SET, settings);
    rebuildLangs();
  }
  function removeCustomDict(id) {
    saveDicts(customDicts().filter(function (d) { return d.id !== id; }));
    delete poolByLang["custom:" + id];
    delete settings.langs["custom:" + id]; save(K_SET, settings);
    rebuildLangs();
  }
  function customInfoUpd() {
    var dicts = customDicts(), tot = 0;
    dicts.forEach(function (d) { tot += (poolByLang["custom:" + d.id] || []).length; });
    var el = $("customInfo"); if (el) el.textContent = dicts.length ? (dicts.length + " слов. · " + tot + " слов") : "";
  }
  function renderDictList() {
    var host = $("dictList"); if (!host) return;
    var dicts = customDicts();
    if (!dicts.length) { host.innerHTML = '<div class="dictempty">пока нет своих словарей</div>'; return; }
    host.innerHTML = dicts.map(function (d) {
      var n = (poolByLang["custom:" + d.id] || []).length;
      var on = settings.langs["custom:" + d.id] !== false;
      return '<div class="dictrow' + (on ? "" : " off") + '"><span class="dn">✎ ' + esc(d.name) + '</span><span class="dc">' + n + '</span><button class="dx" data-id="' + d.id + '">✕</button></div>';
    }).join("");
    Array.prototype.forEach.call(host.querySelectorAll(".dx"), function (b) {
      b.onclick = function () { removeCustomDict(b.getAttribute("data-id")); buildMenu(); };
    });
  }
  var LLM_PROMPT =
    "Составь словарь слов для нейминговой игры Sorter.\n" +
    "Формат строго:\n" +
    "— одно слово на строке;\n" +
    "— только кандидаты для бренда (сущ./прил./глаголы), без аббревиатур, имён собственных и вульгарного;\n" +
    "— длина 2–14 букв, благозвучные; латиница или кириллица.\n" +
    "Тема/территория: <ОПИШИ, напр. «тёплый кофейный бренд: ритуал, путешествие, тепло»>.\n" +
    "Дай 150 слов, по одному на строке, без нумерации и без комментариев.";
  function copyLlmPrompt() {
    var done = function () { var b = $("btnLlmPrompt"); if (!b) return; var t = b.textContent; b.textContent = "скопировано ✓"; setTimeout(function () { b.textContent = t; }, 1500); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(LLM_PROMPT).then(done, function () { window.prompt("Скопируй промпт:", LLM_PROMPT); });
    else window.prompt("Скопируй промпт:", LLM_PROMPT);
  }
  // следующее слово из remaining: адаптивно (Больцман по случайному окну) или равномерно
  function drawNext(pool) {
    if (!pool.length) return null;
    if (!adaptiveOn()) return pool.splice((Math.random() * pool.length) | 0, 1)[0];
    var S = Math.min(pool.length, 500), idx = [], seen = {}, tries = 0, i;
    while (idx.length < S && tries < S * 3) { var r = (Math.random() * pool.length) | 0; if (!seen[r]) { seen[r] = 1; idx.push(r); } tries++; }
    var T = tasteTemp(), sc = [], mx = -Infinity;
    for (i = 0; i < idx.length; i++) { var v = tasteScore(pool[idx[i]]); sc.push(v); if (v > mx) mx = v; }
    var tot = 0, w = [];
    for (i = 0; i < idx.length; i++) { var e = Math.exp((sc[i] - mx) / T); w.push(e); tot += e; }
    var rr = Math.random() * tot, acc = 0, pick = 0;
    for (i = 0; i < idx.length; i++) { acc += w[i]; if (rr <= acc) { pick = i; break; } }
    return pool.splice(idx[pick], 1)[0];
  }

  // ── ковка коинов (рычаг 2) ─────────────────────────────────────────────
  var _CYR = { "а":"a","б":"b","в":"v","г":"g","д":"d","е":"e","ё":"yo","ж":"zh","з":"z","и":"i","й":"y","к":"k","л":"l","м":"m","н":"n","о":"o","п":"p","р":"r","с":"s","т":"t","у":"u","ф":"f","х":"h","ц":"ts","ч":"ch","ш":"sh","щ":"sch","ъ":"","ы":"y","ь":"","э":"e","ю":"yu","я":"ya" };
  function latinize(s) { s = (s || "").toLowerCase(); var o = ""; for (var i = 0; i < s.length; i++) { var c = s[i]; o += (c in _CYR) ? _CYR[c] : c; } return o; }
  function cleanCoin(c) { return latinize(c).normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z]/g, ""); }
  function pick(a) { return a[(Math.random() * a.length) | 0]; }
  function cap(c) { return c ? c.charAt(0).toUpperCase() + c.slice(1) : c; }
  function isV(ch) { return "aeiou".indexOf(ch) >= 0; }
  function firstV(s) { for (var i = 0; i < s.length; i++) if (isV(s[i])) return i; return -1; }
  function lastV(s) { for (var i = s.length - 1; i >= 0; i--) if (isV(s[i])) return i; return -1; }
  function head(s) { var v = firstV(s); if (v < 0) return s.slice(0, Math.min(3, s.length)); var i = v + 1; while (i < s.length && isV(s[i])) i++; if (i < s.length && !isV(s[i])) i++; return s.slice(0, Math.max(2, i)); }
  function tail(s) { var v = lastV(s); if (v < 0) return s.slice(-Math.min(3, s.length)); var i = v; if (i > 0 && !isV(s[i - 1])) i--; return s.slice(i); }
  function trunc(s) { var t = 3 + ((Math.random() * 3) | 0); return s.length <= t ? s : s.slice(0, t); }
  var _SUF = ["o","a","ia","ix","ex","on","um","us","io","en","ar","is","os","eo","ova","ico","ane","ora","el"];
  var _PRE = ["e","ne","vi","za","ex","neo","de","re"];
  function gen(a, b, kind) {
    if (kind === 0) { var h = head(a), t = tail(b); if (h && t && h.charAt(h.length - 1) === t.charAt(0)) t = t.slice(1); return h + t; }
    if (kind === 1) { if (Math.random() < 0.72) { var s = pick(_SUF), x = a; if (isV(x.charAt(x.length - 1)) && isV(s.charAt(0))) x = x.slice(0, -1); return x + s; } return pick(_PRE) + a; }
    if (kind === 2) { return trunc(a); }
    if (kind === 3) { return trunc(a) + tail(b); }
    var m = (Math.random() * 4) | 0;
    if (m === 0) return a.replace(/c/g, "k").replace(/ph/g, "f");
    if (m === 1) { var i = firstV(a); return i < 0 ? a : a.slice(0, i) + "aeiou".charAt((("aeiou".indexOf(a[i]) + 2) % 5)) + a.slice(i + 1); }
    if (m === 2) { var j = 1 + ((Math.random() * Math.max(1, a.length - 1)) | 0); return a.slice(0, j) + a.charAt(j) + a.slice(j); }
    return isV(a.charAt(a.length - 1)) ? a : a + "a";
  }
  function sayable(c) {
    if (c.length < 3 || c.length > 11) return false;
    if (!/[aeiou]/.test(c)) return false;
    if (/[^aeiou]{4,}/.test(c)) return false;
    if (/(.)\1\1/.test(c)) return false;
    return true;
  }
  var KIND_RU = ["бленд", "аффикс", "усечение", "компаунд", "мутация"];
  function buildIngredients() {
    var ing = [], seen = {};
    for (var i = 0; i < goodCorpus.length; i++) { var t = cleanCoin(goodCorpus[i].w); if (t.length >= 3 && !seen[t]) { seen[t] = 1; ing.push(t); } }
    if (ing.length < 24) {
      var dict = [];
      LANGS.forEach(function (L) { var a = poolByLang[L.code] || []; for (var k = 0; k < a.length; k++) dict.push(a[k]); });
      var sample = [];
      for (var s = 0; s < 500 && dict.length; s++) sample.push(dict[(Math.random() * dict.length) | 0]);
      sample.sort(function (x, y) { return tasteScore(y) - tasteScore(x); });
      for (var m = 0; m < sample.length && ing.length < 40; m++) { var c = cleanCoin(bigToken(sample[m])); if (c.length >= 3 && !seen[c]) { seen[c] = 1; ing.push(c); } }
    }
    return ing.slice(0, 60);
  }
  function generateCoins(target) {
    var ing = buildIngredients();
    if (ing.length < 2) return [];
    var out = [], seen = {}, tries = 0, max = target * 40;
    while (out.length < target && tries < max) {
      tries++;
      var kind = (Math.random() * 5) | 0, a = pick(ing), b = pick(ing);
      var c = cleanCoin(gen(a, b, kind));
      if (!sayable(c) || seen[c]) continue;
      var w = cap(c);
      if (played.has("coined|" + w)) continue;
      seen[c] = 1;
      out.push({ w: w, g: KIND_RU[kind] + " · " + a + (kind === 0 || kind === 3 ? " + " + b : ""), tr: null, lang: "coined", pos: "", forged: true });
    }
    return out;
  }
  function addGoodCorpus(word) {
    goodCorpus.push({ w: bigToken(word), lang: word.lang });
    if (goodCorpus.length > 500) goodCorpus = goodCorpus.slice(-500);
    save(K_GOOD, goodCorpus);
  }

  // ── раунд ──────────────────────────────────────────────────────────────
  function startRound(forge) {
    var pool = forge ? generateCoins(Math.max(settings.roundSize || ROUND_SIZE, 80) * 2) : candidates();
    if (!pool.length) {
      alert(forge ? "Не удалось наковать коинов — насортируй сначала good-слов в режиме «Поиск»."
                  : "Под фильтры не попало ни одного слова. Ослабь длину/языки или сбрось историю в меню.");
      return;
    }
    round = { remaining: pool, good: [], bad: [], target: Math.min(settings.roundSize || ROUND_SIZE, pool.length),
              active: null, locked: false, streakDir: null, streakN: 0, forge: !!forge, gen: ++roundGen };
    hide($("startOverlay")); hide($("results")); show($("game"));
    clearPlayfield();   // убрать карточки прошлого раунда
    resetStreak();
    updateCounters();
    updateLeaders();
    spawnNext();
  }
  function clearPlayfield() {
    var cards = playfield.querySelectorAll(".card");
    for (var i = 0; i < cards.length; i++) cards[i].remove();
  }

  function restartRound() {
    if (round && (round.good.length + round.bad.length) > 0 &&
        !confirm("Начать раунд заново? Прогресс текущего раунда сбросится (сыгранные слова останутся в истории).")) return;
    startRound(round ? round.forge : startMode === "forge");
  }

  // досрочно завершить раунд и уйти к комментированию (итоги)
  function finishRound() {
    if (!round || !isGameVisible()) return;   // только во время игры, не на экране итогов
    if (round.good.length + round.bad.length === 0) {
      alert("Пока нет рассортированных слов — раскидай хотя бы одно.");
      return;
    }
    endRound();
  }

  function spawnNext() {
    if (!round) return;
    round.active = null;
    var sorted = round.good.length + round.bad.length;
    if (sorted >= round.target || round.remaining.length === 0) { endRound(); return; }
    var word = drawNext(round.remaining);
    if (!word) { endRound(); return; }
    var el = buildCard(word);
    playfield.appendChild(el);
    round.active = { word: word, el: el };
    round.locked = false;
    // мягкое появление по центру, без падения (через reflow, чтобы transition сработал)
    void el.offsetWidth;
    el.classList.add("in");
    enableDrag(el);
  }

  // свайп карточки (тач + мышь): ← BAD, → GOOD, ↑ SKIP — мобильное управление
  function enableDrag(el) {
    var sx = 0, sy = 0, dx = 0, dy = 0, on = false, pid = null;
    el.addEventListener("pointerdown", function (e) {
      if (!round || !round.active || round.locked || round.active.el !== el) return;
      on = true; pid = e.pointerId; sx = e.clientX; sy = e.clientY; dx = dy = 0;
      el.style.transition = "none";
      try { el.setPointerCapture(pid); } catch (_) {}
    });
    el.addEventListener("pointermove", function (e) {
      if (!on) return;
      dx = e.clientX - sx; dy = e.clientY - sy;
      el.style.transform = "translate(calc(-50% + " + dx + "px), calc(-50% + " + dy + "px)) rotate(" + (dx * 0.05) + "deg)";
      var horiz = Math.abs(dx) >= Math.abs(dy);
      el.classList.toggle("drag-good", horiz && dx > 30);
      el.classList.toggle("drag-bad", horiz && dx < -30);
      basketGood.classList.toggle("lit", horiz && dx > 30);
      basketBad.classList.toggle("lit", horiz && dx < -30);
      skiphint.classList.toggle("lit", !horiz && -dy > 30);
    });
    function end(e) {
      if (!on) return; on = false;
      try { el.releasePointerCapture(pid); } catch (_) {}
      basketGood.classList.remove("lit"); basketBad.classList.remove("lit"); skiphint.classList.remove("lit");
      var THx = Math.max(64, window.innerWidth * 0.16), THy = Math.max(64, window.innerHeight * 0.13);
      if (Math.abs(dx) > THx && Math.abs(dx) >= Math.abs(dy)) {
        var good = dx > 0;
        resolve(good ? "good" : "bad",
          "translate(" + (good ? 120 : -120) + "vw, calc(-50% + " + dy + "px)) rotate(" + (good ? 16 : -16) + "deg)");
      } else if (-dy > THy && Math.abs(dy) > Math.abs(dx)) {
        resolve("skip", "translate(calc(-50% + " + dx + "px), -120vh) scale(.7)");
      } else {
        el.classList.remove("drag-good", "drag-bad");
        el.style.transition = "transform .2s ease";
        el.style.transform = "translate(-50%,-50%)";
      }
    }
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
  }

  // Spritz ORP — точка оптимального распознавания (чуть левее центра),
  // её закрепляем ровно по центру карточки, чтобы взгляд не бегал.
  function orpIndex(len) {
    if (len <= 1) return 0;
    if (len <= 5) return 1;
    if (len <= 9) return 2;
    if (len <= 13) return 3;
    return 4;
  }
  // кегль под длину слова, чтобы длинные влезали без переноса
  function fontForLen(len) {
    if (len <= 8) return "min(3.1rem, 12vw)";
    if (len <= 12) return "min(2.5rem, 9.5vw)";
    if (len <= 15) return "min(2.05rem, 8vw)";
    return "min(1.7rem, 6.8vw)";
  }
  /* падение убрано — слово появляется по центру (метод Spritz) */
  function buildCard(word) {
    var el = document.createElement("div");
    el.className = "card";
    var forged = !!word.forged;
    var isTr = !!(TR_LANGS[word.lang] && word.tr);
    var origHtml = isTr ? '<div class="orig">' + esc(word.w) + "</div>" : "";
    var chars = Array.from((bigToken(word) || "").normalize("NFC"));
    var i = orpIndex(chars.length);
    var pre = esc(chars.slice(0, i).join(""));
    var orp = esc(chars[i] || "");
    var post = esc(chars.slice(i + 1).join(""));
    el.innerHTML =
      '<span class="pos">' + esc(forged ? "коин" : (word.pos || "")) + "</span>" +
      '<span class="lang-badge' + (forged ? " coin" : "") + '">' + (forged ? "✦" : langBadge(word.lang)) + "</span>" +
      origHtml +
      '<div class="reader">' +
        '<span class="tick top"></span>' +
        '<div class="w" style="font-size:' + fontForLen(chars.length) + '">' +
          '<span class="pre">' + pre + '</span>' +
          '<span class="orp">' + orp + '</span>' +
          '<span class="post">' + post + '</span>' +
        '</div>' +
        '<span class="tick bot"></span>' +
      '</div>' +
      '<div class="g' + (forged ? " prov" : "") + '">' + esc(word.g) + "</div>";
    return el;
  }

  // ── ввод ───────────────────────────────────────────────────────────────
  function resolve(action, fling) {
    if (!round || !round.active || round.locked) return;
    round.locked = true;
    var a = round.active, el = a.el, word = a.word, gen = round.gen;
    el.classList.remove("parked", "drag-good", "drag-bad");
    // выход: класс fly-* (клавиши) или инлайн-флинг от текущей позиции (свайп)
    function exit(cls) {
      if (fling) { el.style.transition = "transform " + ANIM.fly + "ms ease-out, opacity " + ANIM.fly + "ms"; el.style.transform = fling; el.style.opacity = "0"; }
      else el.classList.add(cls);
    }
    function nextIfCurrent() { if (round && round.gen === gen) spawnNext(); }

    if (action === "skip") {
      flashHint(skiphint);
      exit("fly-skip");
      after(el, nextIfCurrent);
      return;
    }
    var good = action === "good";
    flashBasket(good ? basketGood : basketBad);
    exit(good ? "fly-good" : "fly-bad");
    var item = { w: word.w, g: word.g, tr: word.tr || null, lang: word.lang, pos: word.pos || "" };
    (good ? round.good : round.bad).push(item);
    pushAllTime(item, good);   // кумулятив «за всё время»
    tasteUpdate(word, good);   // обучаем модель вкуса
    if (good && !round.forge) addGoodCorpus(word);   // словарные good → ингредиенты ковки
    var dir = good ? "good" : "bad";
    if (round.streakDir === dir) round.streakN++; else { round.streakDir = dir; round.streakN = 1; }
    updateStreak();
    played.add(key(word));
    save(K_PLAYED, Array.from(played));
    updateCounters();
    updateLeaders();
    after(el, nextIfCurrent);
  }
  function after(el, cb) {
    var done = false;
    function go() { if (done) return; done = true; if (el.parentNode) el.parentNode.removeChild(el); cb(); }
    el.addEventListener("transitionend", go);
    setTimeout(go, ANIM.fly + 80); // страховка (зависит от скорости анимации)
  }

  document.addEventListener("keydown", function (e) {
    if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;   // без авто-повтора
    if (!$("menuOverlay").classList.contains("hidden")) return;   // меню открыто
    // старт-экран: Enter / Space начинают раунд (вместо клика по кнопке)
    if (!$("startOverlay").classList.contains("hidden")) {
      if (e.key === "Enter" && !$("btnStart").disabled) {
        e.preventDefault(); startRound(startMode === "forge");
      }
      return;
    }
    // экран итогов: Enter запускает следующий раунд (если фокус не в поле комментария)
    if (!$("results").classList.contains("hidden")) {
      var ae = document.activeElement;
      if (e.key === "Enter" && !(ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA"))) {
        e.preventDefault(); startRound(round ? round.forge : startMode === "forge");
      }
      return;
    }
    if (!isGameVisible()) return;   // прочие экраны — клавиши игры не ловим
    // стрелки/Enter — по e.key; WASD/Space — по e.code (физ. клавиша, любая раскладка)
    // BAD: ← / A / Space · GOOD: → / D / Enter (вкл. numpad) · SKIP: ↑ / W
    var k = e.key, c = e.code;
    if (k === "ArrowLeft" || c === "KeyA" || c === "Space") { e.preventDefault(); resolve("bad"); }
    else if (k === "ArrowRight" || c === "KeyD" || k === "Enter") { e.preventDefault(); resolve("good"); }
    else if (k === "ArrowUp" || c === "KeyW") { e.preventDefault(); resolve("skip"); }
  });

  function flashBasket(b) { b.classList.add("lit"); setTimeout(function () { b.classList.remove("lit"); }, 220); }
  function flashHint(h) { if (!h) return; h.classList.add("lit"); setTimeout(function () { h.classList.remove("lit"); }, 220); }

  // ── счётчики ───────────────────────────────────────────────────────────
  function updateCounters() {
    var g = round ? round.good.length : 0, b = round ? round.bad.length : 0;
    var target = round ? round.target : (settings.roundSize || ROUND_SIZE);
    setCount($("goodCount"), g);
    setCount($("badCount"), b);
    $("cPlayed").textContent = g + b;
    $("cLeft").textContent = Math.max(0, target - g - b);
    $("progressBar").style.width = (target ? (g + b) / target * 100 : 0) + "%";
  }
  function setCount(el, val) {
    if (!el || el.textContent === String(val)) return;
    el.textContent = val;
    el.classList.remove("bump"); void el.offsetWidth; el.classList.add("bump");
  }

  // ── серии (streak) ─────────────────────────────────────────────────────
  function updateStreak() {
    var el = $("streak");
    if (round && round.streakN >= 3) {
      el.className = "streak show " + round.streakDir;
      el.innerHTML = (round.streakDir === "good" ? "GOOD" : "BAD") + " STREAK <b>×" + round.streakN + "</b>";
      void el.offsetWidth; el.classList.add("pop");
    } else {
      resetStreak();
    }
  }
  function resetStreak() { var el = $("streak"); el.className = "streak"; el.innerHTML = ""; }

  // ── итоги ──────────────────────────────────────────────────────────────
  function endRound() {
    var no = (load(K_RND, 0) | 0) + 1;
    save(K_RND, no);
    round.no = no;
    round.date = isoDate();
    show($("results")); hide($("game"));
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    setResView("round");
  }

  function getComment(it) { return comments[key(it)] || ""; }
  function setComment(it, v) { comments[key(it)] = v; save(K_COMMENTS, comments); }
  function curGood() { return resView === "all" ? allGood : (round ? round.good : []); }
  function curBad() { return resView === "all" ? allBad : (round ? round.bad : []); }
  function pushAllTime(item, good) {   // кумулятив: дедуп по ключу + копия в нужный список
    var k = key(item);
    allGood = allGood.filter(function (x) { return key(x) !== k; });
    allBad = allBad.filter(function (x) { return key(x) !== k; });
    (good ? allGood : allBad).push({ w: item.w, g: item.g, tr: item.tr || null, lang: item.lang, pos: item.pos || "" });
    save(K_ALLGOOD, allGood); save(K_ALLBAD, allBad);
  }

  function renderResList(host, arr, withComments) {
    host.innerHTML = "";
    var canDelete = resView === "all" && withComments;   // удаление отдельных good-слов — только в «за всё время»
    arr.forEach(function (item) {
      var row = document.createElement("div");
      row.className = "resrow" + (withComments ? "" : " solo") + (canDelete ? " delable" : "");
      var isTr = !!TR_LANGS[item.lang] && item.tr;
      var big = isTr ? item.tr : item.w;
      var meta = langBadge(item.lang) + " · " + item.g + (isTr ? " · " + item.w : "");
      var html = '<div class="word"><div class="rw">' + esc(big) + '</div>' +
                 '<div class="rmeta">' + esc(meta) + "</div></div>";
      if (withComments) html += '<input type="text" placeholder="комментарий…" value="' + esc(getComment(item)) + '">';
      html += '<button class="movebtn" title="' + (withComments ? "Переместить в BAD" : "Переместить в GOOD") +
              '">' + (withComments ? "→ BAD" : "← GOOD") + "</button>";
      if (canDelete) html += '<button class="delbtn" title="Удалить из «за всё время»">✕</button>';
      row.innerHTML = html;
      if (withComments) {
        var input = row.querySelector("input");
        input.addEventListener("input", function () { setComment(item, input.value); });
      }
      row.querySelector(".movebtn").addEventListener("click", function () { moveItem(item, !withComments); });
      if (canDelete) row.querySelector(".delbtn").addEventListener("click", function () { deleteAllTime(item); });
      host.appendChild(row);
    });
    if (!arr.length) host.innerHTML = "";
  }

  // перенос слова между колонками (исправить ошибку сортировки) — учитывает режим просмотра
  function moveItem(item, toGood) {
    var from = toGood ? curBad() : curGood(), to = toGood ? curGood() : curBad();
    var i = from.indexOf(item);
    if (i < 0) return;
    from.splice(i, 1); to.push(item);
    pushAllTime(item, toGood);   // синхронизируем кумулятив
    rerenderResults();
  }
  // удалить слово из «за всё время» совсем (вместе с комментарием)
  function deleteAllTime(item) {
    var k = key(item);
    allGood = allGood.filter(function (x) { return key(x) !== k; });
    allBad = allBad.filter(function (x) { return key(x) !== k; });
    delete comments[k]; save(K_COMMENTS, comments);
    save(K_ALLGOOD, allGood); save(K_ALLBAD, allBad);
    rerenderResults();
  }
  function rerenderResults() {
    var g = curGood(), b = curBad();
    $("resTitle").textContent = resView === "all"
      ? "За всё время · good " + g.length + " · bad " + b.length
      : "Раунд " + (round ? round.no : "") + " · сыграно " + (g.length + b.length) + " · good " + g.length + " · bad " + b.length;
    $("resGoodCount").textContent = g.length;
    $("resBadCount").textContent = b.length;
    renderResList($("resGood"), g, true);
    renderResList($("resBad"), b, false);
    saveBackup();
  }
  function setResView(v) {
    resView = v;
    var vr = $("viewRound"), va = $("viewAll");
    if (vr) vr.classList.toggle("on", v === "round");
    if (va) va.classList.toggle("on", v === "all");
    rerenderResults();
  }

  function saveBackup() {
    if (!round) return;
    save(K_LAST, { no: round.no, date: round.date, good: round.good, bad: round.bad });
  }

  // ── экспорт .txt ───────────────────────────────────────────────────────
  function exportTxt() {
    var g = curGood(), b = curBad(), all = resView === "all";
    if (!g.length && !b.length) { alert("Пока нечего экспортировать."); return; }
    var L = [];
    L.push("# " + (all ? "за всё время · " + isoDate() : "раунд " + round.no + " · " + round.date) +
           " · good " + g.length + " · bad " + b.length);
    L.push("# колонки: слово \\t язык \\t глосс \\t комментарий");
    L.push("## GOOD");
    g.forEach(function (it) { L.push(rowTxt(it)); });   // плохие в экспорт не идут — только хорошие
    var blob = new Blob([L.join("\n") + "\n"], { type: "text/plain;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = all ? "sorter_allgood_" + isoDate() + ".txt" : "round_" + pad2(round.no) + "_" + round.date + ".txt";
    document.body.appendChild(a); a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
  }
  function rowTxt(it) {
    var word = it.w + (it.tr && TR_LANGS[it.lang] ? " (" + it.tr + ")" : "");
    var c = (getComment(it) || "").trim() || "—";
    return [word, it.lang, it.g, c].join("\t");
  }

  // ── меню ───────────────────────────────────────────────────────────────
  function buildMenu() {
    var host = $("langToggles");
    host.innerHTML = "";
    LANGS.forEach(function (Lg) {
      var n = (poolByLang[Lg.code] || []).length;
      var el = document.createElement("button");
      el.className = "lang" + (settings.langs[Lg.code] ? " on" : "") + (n === 0 ? " empty" : "");
      el.innerHTML = '<span class="tag">' + Lg.label + '</span>' + Lg.name +
                     ' <span class="cnt">' + n + "</span>";
      el.addEventListener("click", function () {
        if (n === 0) return;
        settings.langs[Lg.code] = !settings.langs[Lg.code];
        el.classList.toggle("on", settings.langs[Lg.code]);
        save(K_SET, settings); menuInfo();
      });
      host.appendChild(el);
    });

    var at = $("adaptToggle");
    at.classList.toggle("on", !!settings.adaptive);
    at.onclick = function () { settings.adaptive = !settings.adaptive; at.classList.toggle("on", settings.adaptive); save(K_SET, settings); tasteInfoUpdate(); };
    var fo = $("focus");
    fo.value = settings.focus;
    fo.oninput = function () { settings.focus = +fo.value; save(K_SET, settings); };
    $("btnResetTaste").onclick = function () {
      if (!confirm("Сбросить выученный вкус (модель good/bad)? Языки и история не тронутся.")) return;
      taste = freshTaste(); save(K_TASTE, taste);
      tasteInfoUpdate(); updateLeaders(); buildQpick(); refreshQinfo();
    };
    tasteInfoUpdate();

    buildQpick(); refreshQinfo();
    $("btnClearQ").onclick = function () { settings.manualQ = []; save(K_SET, settings); buildQpick(); refreshQinfo(); updateLeaders(); };

    renderDictList(); customInfoUpd();
    $("customFile").onchange = function (e) {
      var files = e.target.files; if (!files || !files.length) return;
      var pending = files.length;
      Array.prototype.forEach.call(files, function (f) {
        var r = new FileReader();
        r.onload = function () { addCustomDict(f.name.replace(/\.txt$/i, ""), r.result); if (--pending === 0) buildMenu(); };
        r.readAsText(f);
      });
      e.target.value = "";
    };
    $("btnSavePaste").onclick = function () {
      var txt = $("customText").value.trim(); if (!txt) return;
      addCustomDict($("pasteName").value.trim() || "Словарь", txt);
      $("customText").value = ""; $("pasteName").value = ""; buildMenu();
    };
    $("btnLlmPrompt").onclick = copyLlmPrompt;

    var an = $("animSpeed"); an.value = settings.animSpeed; animLabel();
    an.oninput = function () { settings.animSpeed = +an.value; animLabel(); applyAnimSpeed(); save(K_SET, settings); };

    menuInfo();
  }
  function animLabel() { $("animVal").textContent = settings.animSpeed <= 1 ? "нормальная" : (settings.animSpeed >= 10 ? "супер-быстро" : "×" + settings.animSpeed); }
  function lenLabel() { $("lenVal").textContent = "до " + settings.lenMax + " букв"; }
  function roundLabel() { $("roundVal").textContent = settings.roundSize + " слов"; }
  function tasteInfoUpdate() {
    $("adaptInfo").textContent = settings.adaptive ? "вкл" : "выкл";
    $("tasteInfo").textContent = "выучено: " + taste.ng + " good · " + taste.nb + " bad" +
      (settings.adaptive && (taste.ng + taste.nb) < WARMUP ? " · нужно ≥" + WARMUP : "");
  }
  function menuInfo() {
    $("playedInfo").textContent = played.size + " сыграно · " + availableCount() + " под фильтрами";
    var at = $("alltimeInfo"); if (at) at.textContent = "за всё время: " + allGood.length + " good · " + allBad.length + " bad";
  }

  // ── утилиты ────────────────────────────────────────────────────────────
  function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
  function pad2(n) { return (n < 10 ? "0" : "") + n; }
  function isoDate() { var d = new Date(); return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()); }
  function show(el) { el.classList.remove("hidden"); }
  function hide(el) { el.classList.add("hidden"); }
  function isGameVisible() { return !$("game").classList.contains("hidden") && $("startOverlay").classList.contains("hidden"); }

  // ── кнопки ─────────────────────────────────────────────────────────────
  $("btnStart").addEventListener("click", function () { startRound(false); });          // старт-экран всегда «поиск»
  $("btnForgeRound").addEventListener("click", function () { startRound(true); });        // ковка — только с итогов
  $("btnRestart").addEventListener("click", restartRound);
  $("btnFinish").addEventListener("click", finishRound);
  $("btnNewRound").addEventListener("click", function () { hide($("results")); show($("startOverlay")); refreshStart(); });
  $("btnExport").addEventListener("click", exportTxt);
  $("viewRound").addEventListener("click", function () { setResView("round"); });
  $("viewAll").addEventListener("click", function () { setResView("all"); });
  $("btnMenu").addEventListener("click", function () { buildMenu(); show($("menuOverlay")); });
  $("btnAddDictStart").addEventListener("click", function () {
    buildMenu(); show($("menuOverlay"));
    var box = $("pasteBox");
    if (box) { box.scrollIntoView({ block: "center" }); var p = $("pasteName"); if (p) p.focus(); }
  });
  $("btnCloseMenu").addEventListener("click", closeMenu);
  $("btnCloseMenu2").addEventListener("click", closeMenu);
  function closeMenu() {
    hide($("menuOverlay"));
    if (round && (round.good.length + round.bad.length) < round.target && round.active == null && isGameVisible()) {
      // если стоим без активной карточки (например, меню открыли на паузе) — продолжим
      spawnNext();
    }
    refreshStart();
  }
  $("btnResetHistory").addEventListener("click", function () {
    if (!confirm("Сбросить историю? Сыгранные слова вернутся в пул, счётчик раундов — на 1. (Список «за всё время» и вкус не тронутся.)")) return;
    played = new Set(); save(K_PLAYED, []);
    save(K_RND, 0);   // следующий раунд снова первый
    buildMenu(); refreshStart();
  });
  $("btnResetAllTime").addEventListener("click", function () {
    if (!allGood.length && !allBad.length) { alert("Список «за всё время» уже пуст."); return; }
    if (!confirm("Очистить «за всё время» (" + allGood.length + " good · " + allBad.length + " bad) и комментарии к ним? Сыгранные слова и вкус не тронутся.")) return;
    allGood = []; allBad = []; comments = {};
    save(K_ALLGOOD, allGood); save(K_ALLBAD, allBad); save(K_COMMENTS, comments);
    if (resView === "all") rerenderResults();   // если открыт экран итогов в режиме «за всё время»
    buildMenu();
  });

  // компактный выбор словарей на старт-экране: аббревиатура (база) / имя (свой), без расшифровки
  function renderStartLangs() {
    var host = $("startLangs"); if (!host) return;
    host.innerHTML = "";
    LANGS.forEach(function (Lg) {
      var n = (poolByLang[Lg.code] || []).length;
      var el = document.createElement("button");
      el.type = "button";
      el.className = "lmini" + (settings.langs[Lg.code] ? " on" : "") + (n === 0 ? " empty" : "");
      el.textContent = langBadge(Lg.code);
      el.title = Lg.name + " · " + n + " слов";
      if (n > 0) el.addEventListener("click", function () {
        settings.langs[Lg.code] = !settings.langs[Lg.code];
        save(K_SET, settings); refreshStart();
      });
      host.appendChild(el);
    });
  }
  function refreshStart() {
    renderStartLangs();
    var avail = availableCount();
    var btn = $("btnStart");
    btn.disabled = avail === 0;
    btn.textContent = avail === 0 ? "Нет слов — включи словари/сбрось историю" : "Старт · раунд " + ((load(K_RND, 0) | 0) + 1);
    $("poolInfo").innerHTML = "доступно: " + avail + " · сыграно: " + played.size + " · твоих good-слов: " + goodCorpus.length;
  }

  // настройки на старт-экране: кол-во слов + только МАКС длина (мин фиксирован = 2)
  function setupStartControls() {
    var rs = $("roundSize"); rs.value = settings.roundSize; roundLabel();
    rs.oninput = function () { settings.roundSize = +rs.value; roundLabel(); save(K_SET, settings); refreshStart(); };
    settings.lenMin = 2;
    var lmax = $("lenMax"); lmax.value = settings.lenMax; lenLabel();
    lmax.oninput = function () { settings.lenMax = +lmax.value; lenLabel(); save(K_SET, settings); refreshStart(); };
  }
  function applyAnimSpeed() {
    var s = Math.max(1, Math.min(10, settings.animSpeed || 1)), f = (s - 1) / 9;
    ANIM.fly = Math.round(300 - f * 230);     // 300 → 70 мс
    ANIM.appear = Math.round(190 - f * 145);  // 190 → 45 мс
    document.documentElement.style.setProperty("--fly", ANIM.fly + "ms");
    document.documentElement.style.setProperty("--appear", ANIM.appear + "ms");
  }

  // ── старт ──────────────────────────────────────────────────────────────
  setupStartControls();
  applyAnimSpeed();
  buildManualP();
  loadCustomDicts();
  setupNeim("neimInput", "neimResult");
  setupNeim("neimInput2", "neimResult2");
  loadPools(function (done, total) {
    $("loadBar").style.width = (done / total * 100) + "%";
    $("loadCount").textContent = done + " / " + total;
  }).then(function () {
    hide($("loading"));
    show($("startReady"));
    refreshStart();
  });

})();
