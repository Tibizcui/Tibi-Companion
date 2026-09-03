/* ============================================================================
   -- FICHIER VENDU (copie synchronisée) --
   Source de vérité : dépôt "Tibiscui.fr" / dashboard-shared.js.
   Ne PAS modifier la logique de décodage ici sans reporter le changement dans
   les 3 côtés : Stats/Libs/LZW.lua + Stats/Export.lua (dépôt TibiSuite -
   Unifié) ET Tibiscui.fr/dashboard-shared.js. Le rendu (HTML/graphiques) peut
   diverger librement de la version site si besoin propre à l'app.
============================================================================ */
/* ============================================================================
   TibiSuite - dashboard-shared.js (v2 - BI)
   ----------------------------------------------------------------------------
   Moteur partage par Dashboard.html (visualiseur generique multi-personnages,
   codes colles par le visiteur, stockes en localStorage) et Dashboard-Tibi.html
   (page figee sur un ou plusieurs exports fixes fournis par le site). Aucun
   appel reseau pour les donnees : le(s) code(s) d'export sont decodes et
   affiches entierement dans le navigateur du visiteur.

   Format attendu (produit par l'addon Stats, cf. TibiSuite - Unifie / Stats) :
     texte imprimable = Base64( LZW( JSON({schema, generatedAt, char, checksum, data}) ) )

   -- NE PAS TOUCHER sans mettre a jour Stats/Libs/LZW.lua en parallele --
   Le decodeur LZW ci-dessous est un miroir BIT A BIT de Stats/Libs/LZW.lua :
   dictionnaire fige a 4096 entrees (codes 12 bits), memes formules de pack/
   unpack. Idem pour djb2 (Export.lua). Toute evolution de ces fichiers Lua
   doit etre reportee ici, sinon les exports generes en jeu ne se liront plus.
   Tout le reste de ce fichier (rendu, filtres, graphiques, comparaison) peut
   evoluer librement : il ne touche jamais au format d'echange.
============================================================================ */

(function (global) {
  "use strict";

  // v1 : un code = un personnage (envelope.char + data.stats.days).
  // v2 : un code = tout le compte (data.chars["Nom-Royaume"] = {char,days,professions}) -
  // evite d'avoir a se reconnecter sur chaque personnage pour generer et coller
  // un code par personnage. Les deux formats restent lus (v1 = codes deja
  // colles avant cette evolution).
  var SUPPORTED_SCHEMAS = [1, 2];
  var STORE_KEY = "tibisuite-dashboard-profiles-v2";
  var MAX_PROFILES = 8;

  // ==========================================================================
  // LZW (miroir de Stats/Libs/LZW.lua) + Base64 (atob natif, alphabet standard)
  // ==========================================================================
  function lzwDecompress(bytes) {
    if (!bytes) return "";
    var count = bytes.charCodeAt(0) * 16777216 + bytes.charCodeAt(1) * 65536
      + bytes.charCodeAt(2) * 256 + bytes.charCodeAt(3);
    var codes = [];
    var pos = 4; // Lua pos=5 en indexation 1 == index 4 en indexation 0
    var i = 0;
    while (i < count) {
      var b1 = bytes.charCodeAt(pos), b2 = bytes.charCodeAt(pos + 1);
      var a = b1 * 16 + Math.floor(b2 / 16);
      codes.push(a);
      i++;
      if (i < count) {
        var b3 = bytes.charCodeAt(pos + 2);
        codes.push((b2 % 16) * 256 + b3);
        i++;
        pos += 3;
      } else {
        pos += 2;
      }
    }
    if (codes.length === 0) return "";

    var DICT_MAX = 4096;
    var dict = [];
    for (var d = 0; d < 256; d++) dict[d] = String.fromCharCode(d);
    var dictSize = 256;
    var out = [];
    var prev = dict[codes[0]];
    out.push(prev);
    for (var k = 1; k < codes.length; k++) {
      var code = codes[k], entry;
      if (dict[code] !== undefined) {
        entry = dict[code];
      } else if (code === dictSize) {
        entry = prev + prev.charAt(0);
      } else {
        throw new Error("LZW: code de decompression invalide");
      }
      out.push(entry);
      if (dictSize < DICT_MAX) {
        dict[dictSize] = prev + entry.charAt(0);
        dictSize++;
      }
      prev = entry;
    }
    return out.join("");
  }

  // Somme de controle djb2, miroir de Export.lua (memes formules, meme modulo).
  function djb2(s) {
    var h = 5381;
    for (var i = 0; i < s.length; i++) {
      h = (h * 33 + s.charCodeAt(i)) % 4294967296;
    }
    return (h >>> 0).toString(16).padStart(8, "0");
  }

  // Chaine binaire (issue d'atob) -> chaine UTF-8 JS correcte (le JSON produit
  // par l'addon peut contenir des caracteres accentues echappes en \uXXXX, mais
  // on reste defensif si jamais des octets UTF-8 bruts se glissaient dedans).
  function toUtf8(binStr) {
    try {
      return decodeURIComponent(escape(binStr));
    } catch (e) {
      return binStr;
    }
  }

  function decodeExportCode(code) {
    code = (code || "").trim();
    if (!code) throw new Error("Code vide.");
    var compressed = atob(code);
    var json = lzwDecompress(compressed);
    var parsed = JSON.parse(toUtf8(json));
    // La somme de controle (djb2) est calculee cote Lua sur les OCTETS BRUTS
    // de "data" (Export.lua), avant tout decodage UTF-8. La verifier ici sur
    // "data" une fois converti par toUtf8() donnerait un faux "code incomplet
    // ou modifie" des qu'un caractere accentue apparait dans les donnees (ex:
    // "Legion" dans un nom de reputation RepBar) : le decodage UTF-8 fusionne
    // chaque sequence d'octets multi-bytes en UN SEUL caractere JS, ce qui
    // change les valeurs octet-par-octet que djb2 parcourt. On reverifie donc
    // sur le JSON brut (pre-UTF8), qui reste l'exacte meme suite d'octets que
    // celle checksummee par Lua.
    try {
      var rawParsed = JSON.parse(json);
      if (rawParsed && typeof rawParsed.data === "string" && rawParsed.checksum) {
        parsed.checksumOk = djb2(rawParsed.data) === rawParsed.checksum;
      }
    } catch (e) {
      // Le parse "brut" peut echouer sur un JSON par ailleurs valide si des
      // octets UTF-8 y forment une sequence particuliere ; on laisse alors
      // envelopeToProfiles recalculer avec son ancien comportement (peut
      // donner un faux positif dans ce cas rare, mais jamais pire qu'avant).
    }
    return parsed;
  }

  // ==========================================================================
  // AIDES DE FORMAT
  // ==========================================================================
  var CLASS_COLORS = {
    WARRIOR: "#C79C6E", PALADIN: "#F58CBA", HUNTER: "#ABD473", ROGUE: "#FFF569",
    PRIEST: "#FFFFFF", DEATHKNIGHT: "#C41F3B", SHAMAN: "#0070DE", MAGE: "#69CCF0",
    WARLOCK: "#9482C9", MONK: "#00FF96", DRUID: "#FF7D0A", DEMONHUNTER: "#A330C9",
    EVOKER: "#33937F",
  };
  var MONTHS_FR = ["janv.", "fevr.", "mars", "avr.", "mai", "juin", "juil.", "aout", "sept.", "oct.", "nov.", "dec."];

  // Miroir de SkillTracker/Constants.lua : ST.EXP_NAME_INDEX. Sert UNIQUEMENT
  // a trier/regrouper les extensions du filtre Metiers dans le bon ordre
  // chronologique - les cles doivent matcher EXACTEMENT les noms que le jeu
  // stocke dans prof.lines[id].exp (accents compris, FR et EN).
  var EXP_NAME_INDEX = {
    "Classic": 0, "Classique": 0, "Vanilla": 0,
    "Outland": 1, "Outreterre": 1,
    "Northrend": 2, "Norfendre": 2,
    "Cataclysm": 3, "Cataclysme": 3,
    "Pandaria": 4, "Pandarie": 4,
    "Draenor": 5,
    "Legion": 6, "Légion": 6,
    "Zandalar": 7, "Kul Tiras": 7, "Kul Tiran": 7, "Battle for Azeroth": 7,
    "Shadowlands": 8, "Ombreterre": 8,
    "Dragon Isles": 9, "Îles aux Dragons": 9, "Dragonflight": 9,
    "Khaz Algar": 10, "The War Within": 10,
    "Midnight": 11,
  };
  function expIndexOf(name) {
    var idx = EXP_NAME_INDEX[name];
    return idx == null ? 99 : idx;
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function fmtGold(copper) {
    copper = Math.floor(copper || 0);
    var sign = copper < 0 ? "-" : "";
    var g = Math.abs(Math.floor(copper / 10000));
    return sign + g.toLocaleString("fr-FR") + " po";
  }

  function fmtGoldShort(copper) {
    copper = Math.floor(copper || 0);
    var g = copper / 10000;
    var sign = g < 0 ? "-" : "";
    var a = Math.abs(g);
    if (a >= 1000000) return sign + (a / 1000000).toFixed(1).replace(".0", "") + "M";
    if (a >= 1000) return sign + (a / 1000).toFixed(1).replace(".0", "") + "k";
    return sign + Math.round(a);
  }

  function fmtHours(seconds) {
    seconds = Math.floor(seconds || 0);
    var h = Math.floor(seconds / 3600);
    var m = Math.floor((seconds % 3600) / 60);
    return h + "h" + String(m).padStart(2, "0");
  }

  function fmtNum(n) { return Math.round(n || 0).toLocaleString("fr-FR"); }

  // Dates : tout est manipule en jours-epoch (entier = jours depuis 1970-01-01
  // UTC) pour eviter les pieges de fuseau horaire des objets Date en JS.
  function isoToEpochDay(iso) {
    var p = String(iso).split("-").map(Number);
    if (p.length !== 3 || !p[0]) return null;
    return Math.floor(Date.UTC(p[0], p[1] - 1, p[2]) / 86400000);
  }
  function epochDayToIso(ed) {
    var d = new Date(ed * 86400000);
    return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0") + "-" + String(d.getUTCDate()).padStart(2, "0");
  }
  function fmtDateShort(iso) {
    var ed = isoToEpochDay(iso);
    if (ed == null) return esc(iso);
    var d = new Date(ed * 86400000);
    return d.getUTCDate() + " " + MONTHS_FR[d.getUTCMonth()];
  }
  function fmtDateLong(iso) {
    var ed = isoToEpochDay(iso);
    if (ed == null) return esc(iso);
    var d = new Date(ed * 86400000);
    var days = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
    return days[d.getUTCDay()] + " " + d.getUTCDate() + " " + MONTHS_FR[d.getUTCMonth()] + " " + d.getUTCFullYear();
  }

  function classColor(cls) { return CLASS_COLORS[String(cls || "").toUpperCase()] || "#e4b64a"; }

  // ==========================================================================
  // AGREGATION
  // ==========================================================================
  function sumDays(days) {
    var out = { quests: 0, goldGain: 0, goldSpent: 0, played: 0, dungeons: 0, mplusCount: 0, dayCount: 0, activeDayCount: 0 };
    if (!days) return out;
    Object.keys(days).forEach(function (k) {
      var d = days[k] || {};
      out.quests += d.quests || 0;
      out.goldGain += d.goldGain || 0;
      out.goldSpent += d.goldSpent || 0;
      out.played += d.played || 0;
      out.dungeons += d.dungeons || 0;
      out.mplusCount += (d.mplus && d.mplus.length) || 0;
      out.dayCount++;
      if ((d.quests || d.played || d.dungeons)) out.activeDayCount++;
    });
    return out;
  }

  // Sous-ensemble de `days` dont la date (epoch-day) est dans [fromEd, toEd].
  function sliceDays(days, fromEd, toEd) {
    var out = {};
    Object.keys(days || {}).forEach(function (k) {
      var ed = isoToEpochDay(k);
      if (ed == null) return;
      if ((fromEd == null || ed >= fromEd) && (toEd == null || ed <= toEd)) out[k] = days[k];
    });
    return out;
  }

  function dayKeyBounds(days) {
    var keys = Object.keys(days || {});
    var min = null, max = null;
    keys.forEach(function (k) {
      var ed = isoToEpochDay(k);
      if (ed == null) return;
      if (min == null || ed < min) min = ed;
      if (max == null || ed > max) max = ed;
    });
    return { min: min, max: max };
  }

  // Fenetre "range" (en jours) ancree sur le jour le plus recent des donnees
  // (pas la date du navigateur : une page figee doit rester coherente meme
  // longtemps apres sa generation). range === 'all' => tout l'historique.
  function computeWindow(days, range) {
    var b = dayKeyBounds(days);
    if (b.max == null) return { from: null, to: null, prevFrom: null, prevTo: null };
    if (range === "all") return { from: b.min, to: b.max, prevFrom: null, prevTo: null };
    var n = Number(range) || 30;
    var to = b.max, from = b.max - (n - 1);
    var prevTo = from - 1, prevFrom = prevTo - (n - 1);
    return { from: from, to: to, prevFrom: prevFrom, prevTo: prevTo };
  }

  // ==========================================================================
  // MINI GRAPHIQUES SVG (sparkline carte KPI + graphe principal interactif)
  // ==========================================================================
  function catmullRomPath(pts) {
    // Genere un chemin lisse (courbes de Bezier) a partir de points {x,y}.
    if (pts.length < 2) return pts.length === 1 ? ("M" + pts[0].x + "," + pts[0].y) : "";
    var d = "M" + pts[0].x + "," + pts[0].y;
    for (var i = 0; i < pts.length - 1; i++) {
      var p0 = pts[i === 0 ? 0 : i - 1], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2 < pts.length ? i + 2 : i + 1];
      var c1x = p1.x + (p2.x - p0.x) / 6, c1y = p1.y + (p2.y - p0.y) / 6;
      var c2x = p2.x - (p3.x - p1.x) / 6, c2y = p2.y - (p3.y - p1.y) / 6;
      d += " C" + c1x + "," + c1y + " " + c2x + "," + c2y + " " + p2.x + "," + p2.y;
    }
    return d;
  }

  function buildSparkline(values, opts) {
    opts = opts || {};
    var w = opts.w || 96, h = opts.h || 32;
    if (!values.length) return "";
    var min = Math.min.apply(null, values), max = Math.max.apply(null, values);
    if (min === max) { min -= 1; max += 1; }
    var pts = values.map(function (v, i) {
      return { x: (values.length === 1 ? w / 2 : (i / (values.length - 1)) * w), y: h - ((v - min) / (max - min)) * h };
    });
    var color = opts.color || "var(--gold)";
    var last = pts[pts.length - 1];
    return (
      '<svg class="kpi-spark" viewBox="0 0 ' + w + " " + h + '" preserveAspectRatio="none" aria-hidden="true">' +
      '<path d="' + catmullRomPath(pts) + '" fill="none" stroke="' + color + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<circle cx="' + last.x + '" cy="' + last.y + '" r="2.6" fill="' + color + '"/>' +
      "</svg>"
    );
  }

  // series: [{ id, label, color, points:[{ed, v}] }] deja alignes sur le meme
  // axe de dates (ed = epoch-day). Retourne { html, hit:[{ed,x,rows:[]}], fmt }
  function buildLineChart(series, opts) {
    opts = opts || {};
    var W = opts.w || 880, H = opts.h || 260;
    var padL = 46, padR = 14, padT = 14, padB = 30;
    var innerW = W - padL - padR, innerH = H - padT - padB;

    var allEd = [], allV = [];
    series.forEach(function (s) { s.points.forEach(function (p) { allEd.push(p.ed); allV.push(p.v); }); });
    if (!allEd.length) return { html: '<p class="dash-empty">Pas assez de donnees pour tracer un graphique sur cette periode.</p>', hit: [] };

    var minEd = Math.min.apply(null, allEd), maxEd = Math.max.apply(null, allEd);
    var minV = Math.min(0, Math.min.apply(null, allV)), maxV = Math.max.apply(null, allV);
    if (minV === maxV) { maxV = minV + 1; }
    var span = maxV - minV;
    maxV += span * 0.12; // marge de respiration en haut
    span = (maxV - minV) || 1;

    function xOf(ed) { return padL + (maxEd === minEd ? innerW / 2 : ((ed - minEd) / (maxEd - minEd)) * innerW); }
    function yOf(v) { return padT + innerH - ((v - minV) / span) * innerH; }

    // Grille horizontale (5 niveaux) + libelles Y
    var gridN = 4, gridSvg = "";
    for (var g = 0; g <= gridN; g++) {
      var v = minV + (span * g) / gridN;
      var y = yOf(v);
      gridSvg += '<line x1="' + padL + '" x2="' + (W - padR) + '" y1="' + y + '" y2="' + y + '" class="chart-grid"/>';
      gridSvg += '<text x="' + (padL - 8) + '" y="' + (y + 3) + '" class="chart-axis-y" text-anchor="end">' + esc(opts.fmtY ? opts.fmtY(v) : Math.round(v)) + "</text>";
    }
    // Ligne du zero si les valeurs peuvent etre negatives
    if (minV < 0) gridSvg += '<line x1="' + padL + '" x2="' + (W - padR) + '" y1="' + yOf(0) + '" y2="' + yOf(0) + '" class="chart-zero"/>';

    // Libelles X (~6 repartis)
    var xLabels = "";
    var xTicks = Math.min(6, allEd.length > 0 ? (maxEd - minEd + 1) : 1);
    for (var t = 0; t <= xTicks; t++) {
      var ed = Math.round(minEd + ((maxEd - minEd) * t) / xTicks);
      xLabels += '<text x="' + xOf(ed) + '" y="' + (H - 8) + '" class="chart-axis-x" text-anchor="middle">' + esc(fmtDateShort(epochDayToIso(ed))) + "</text>";
    }

    var hit = {}; // ed -> {ed, x, rows:[]}
    var seriesSvg = series.map(function (s, si) {
      var pts = s.points.slice().sort(function (a, b) { return a.ed - b.ed; }).map(function (p) {
        var x = xOf(p.ed), y = yOf(p.v);
        if (!hit[p.ed]) hit[p.ed] = { ed: p.ed, x: x, rows: [] };
        hit[p.ed].rows.push({ id: s.id, y: y, v: p.v, color: s.color, label: s.label });
        return { x: x, y: y };
      });
      var path = catmullRomPath(pts);
      var areaId = "areaGrad" + si + "_" + (opts.uid || 0);
      var area = si === 0
        ? '<path d="' + path + " L" + xOf(maxEd) + "," + (padT + innerH) + " L" + xOf(minEd) + "," + (padT + innerH) + ' Z" fill="url(#' + areaId + ')" stroke="none"/>'
        : "";
      var grad = si === 0
        ? '<linearGradient id="' + areaId + '" x1="0" y1="0" x2="0" y2="1">' +
          '<stop offset="0%" stop-color="' + s.color + '" stop-opacity="0.32"/>' +
          '<stop offset="100%" stop-color="' + s.color + '" stop-opacity="0"/>' +
          "</linearGradient>"
        : "";
      return (
        (grad ? "<defs>" + grad + "</defs>" : "") + area +
        '<path d="' + path + '" fill="none" stroke="' + s.color + '" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="chart-line"/>'
      );
    }).join("");

    var legend = series.length > 1
      ? '<div class="chart-legend">' + series.map(function (s) {
          return '<span class="chart-legend-item"><i style="background:' + s.color + '"></i>' + esc(s.label) + "</span>";
        }).join("") + "</div>"
      : "";

    var hitArr = Object.keys(hit).map(function (k) { return hit[k]; }).sort(function (a, b) { return a.ed - b.ed; });

    var svg =
      '<svg class="bi-chart" viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="none" style="aspect-ratio:' + W + "/" + H + '" role="img" aria-label="' +
      esc(opts.ariaLabel || "Graphique d'evolution") + '">' +
      gridSvg + xLabels + seriesSvg +
      '<g class="chart-cursor" hidden><line x1="0" y1="' + padT + '" x2="0" y2="' + (padT + innerH) + '" class="chart-cursor-line"/></g>' +
      "</svg>";

    return {
      html: legend + '<div class="bi-chart-wrap">' + svg + '<div class="chart-tooltip" hidden></div></div>',
      hit: hitArr,
      fmt: opts.fmt || opts.fmtY || fmtNum,
    };
  }

  // ==========================================================================
  // METRIQUES DISPONIBLES POUR LE GRAPHIQUE PRINCIPAL
  // ==========================================================================
  var METRICS = {
    quests: { label: "Quetes", get: function (d) { return d.quests || 0; }, fmt: fmtNum, fmtY: function (v) { return fmtNum(v); } },
    gold: { label: "Or (net/jour)", get: function (d) { return (d.goldGain || 0) - (d.goldSpent || 0); }, fmt: fmtGold, fmtY: fmtGoldShort },
    played: { label: "Temps joue", get: function (d) { return (d.played || 0) / 3600; }, fmt: function (v) { return fmtHours(v * 3600); }, fmtY: function (v) { return v.toFixed(0) + "h"; } },
    dungeons: { label: "Donjons & M+", get: function (d) { return (d.dungeons || 0) + ((d.mplus && d.mplus.length) || 0); }, fmt: fmtNum, fmtY: fmtNum },
  };
  var METRIC_ORDER = ["quests", "gold", "played", "dungeons"];

  function seriesForProfile(profile, metricKey, fromEd, toEd) {
    var metric = METRICS[metricKey];
    var days = sliceDays(profile.days, fromEd, toEd);
    var keys = Object.keys(days).sort();
    return keys.map(function (k) { return { ed: isoToEpochDay(k), v: metric.get(days[k] || {}) }; }).filter(function (p) { return p.ed != null; });
  }

  // ==========================================================================
  // RENDU : bandeau personnage, KPI, tableau historique, metiers
  // ==========================================================================
  function renderCharBanner(char, opts) {
    char = char || {};
    opts = opts || {};
    var color = classColor(char.class);
    var tail = [char.spec, char.realm].filter(Boolean).join(" &middot; ");
    return (
      '<div class="dash-banner' + (opts.compact ? " dash-banner--compact" : "") + '">' +
        '<span class="dash-banner-level">[' + esc(char.level != null ? char.level : "?") + "]</span> " +
        '<span class="dash-banner-name" style="color:' + color + '">' + esc(char.name || "?") + "</span> " +
        (char.ilvl ? '<span class="dash-banner-ilvl">[' + esc(char.ilvl) + "]</span> " : "") +
        (tail ? '<span class="dash-banner-tail">&mdash; ' + tail + "</span>" : "") +
      "</div>"
    );
  }

  function deltaBadge(cur, prev) {
    if (prev == null) return '<span class="kpi-delta kpi-delta--flat">periode precedente indisponible</span>';
    if (prev === 0 && cur === 0) return '<span class="kpi-delta kpi-delta--flat">stable</span>';
    if (prev === 0) return '<span class="kpi-delta kpi-delta--up">nouveau</span>';
    var pct = ((cur - prev) / Math.abs(prev)) * 100;
    var up = pct >= 0;
    var cls = Math.abs(pct) < 1 ? "kpi-delta--flat" : (up ? "kpi-delta--up" : "kpi-delta--down");
    var arrow = Math.abs(pct) < 1 ? "&#8226;" : (up ? "&#9650;" : "&#9660;");
    return '<span class="kpi-delta ' + cls + '">' + arrow + " " + Math.abs(Math.round(pct)) + "% vs periode precedente</span>";
  }

  function renderKpis(profile, win) {
    var cur = sliceDays(profile.days, win.from, win.to);
    var prev = win.prevFrom != null ? sliceDays(profile.days, win.prevFrom, win.prevTo) : null;
    var t = sumDays(cur), p = prev ? sumDays(prev) : null;
    var net = t.goldGain - t.goldSpent, prevNet = p ? (p.goldGain - p.goldSpent) : null;
    var color = classColor(profile.char && profile.char.class);

    var defs = [
      { key: "quests", label: "Quetes completees", value: fmtNum(t.quests), cur: t.quests, prev: p ? p.quests : null, metric: "quests" },
      { key: "gold", label: "Or (net)", value: fmtGold(net), cur: net, prev: prevNet, cls: net >= 0 ? "pos" : "neg", sub: fmtGold(t.goldGain) + " gagne &middot; " + fmtGold(t.goldSpent) + " depense", metric: "gold" },
      { key: "played", label: "Temps joue", value: fmtHours(t.played), cur: t.played, prev: p ? p.played : null, sub: t.dayCount ? (fmtHours(t.played / t.dayCount) + " / jour en moyenne") : "", metric: "played" },
      { key: "dungeons", label: "Donjons & M+", value: fmtNum(t.dungeons + t.mplusCount), cur: t.dungeons + t.mplusCount, prev: p ? (p.dungeons + p.mplusCount) : null, sub: t.dungeons + " donjons &middot; " + t.mplusCount + " M+", metric: "dungeons" },
    ];

    return (
      '<div class="bi-kpis">' +
      defs.map(function (c) {
        var keys = Object.keys(cur).sort();
        var vals = keys.map(function (k) { return METRICS[c.metric].get(cur[k] || {}); });
        return (
          '<div class="kpi-card">' +
            '<div class="kpi-top"><span class="kpi-label">' + esc(c.label) + "</span>" + buildSparkline(vals, { color: color }) + "</div>" +
            '<div class="kpi-value ' + (c.cls || "") + '">' + c.value + "</div>" +
            (c.sub ? '<div class="kpi-sub">' + c.sub + "</div>" : "") +
            deltaBadge(c.cur, c.prev) +
          "</div>"
        );
      }).join("") +
      "</div>"
    );
  }

  function renderDaysTable(days, win, sort) {
    sort = sort || { key: "date", dir: "desc" };
    var scoped = sliceDays(days, win.from, win.to);
    var keys = Object.keys(scoped);
    var rows = keys.map(function (k) {
      var d = scoped[k] || {};
      var net = (d.goldGain || 0) - (d.goldSpent || 0);
      return { date: k, ed: isoToEpochDay(k), quests: d.quests || 0, net: net, dungeons: d.dungeons || 0, mplus: (d.mplus && d.mplus.length) || 0, played: d.played || 0 };
    });
    var sorters = {
      date: function (r) { return r.ed; }, quests: function (r) { return r.quests; },
      net: function (r) { return r.net; }, dungeons: function (r) { return r.dungeons + r.mplus; }, played: function (r) { return r.played; },
    };
    var sf = sorters[sort.key] || sorters.date;
    rows.sort(function (a, b) { return (sf(a) - sf(b)) * (sort.dir === "asc" ? 1 : -1); });

    if (rows.length === 0) {
      return '<p class="dash-empty">Aucune donnee journaliere sur cette periode.</p>';
    }
    var maxPlayed = Math.max.apply(null, rows.map(function (r) { return r.played; })) || 1;
    var COLS = [
      { key: "date", label: "Jour" }, { key: "quests", label: "Quetes" }, { key: "net", label: "Or (net)" },
      { key: "dungeons", label: "Donjons / M+" }, { key: "played", label: "Temps joue" },
    ];
    var head = COLS.map(function (c) {
      var active = sort.key === c.key;
      var arrow = active ? (sort.dir === "asc" ? " &#9650;" : " &#9660;") : "";
      return '<th><button type="button" class="dash-sort-btn" data-action="sort-table" data-key="' + c.key + '" aria-sort="' + (active ? (sort.dir === "asc" ? "ascending" : "descending") : "none") + '">' + c.label + arrow + "</button></th>";
    }).join("");
    var body = rows.map(function (r) {
      return (
        "<tr><td>" + esc(fmtDateLong(r.date)) + "</td><td>" + fmtNum(r.quests) + '</td><td class="' +
        (r.net >= 0 ? "pos" : "neg") + '">' + fmtGold(r.net) + "</td><td>" + r.dungeons + " / " + r.mplus + "</td>" +
        '<td><div class="dash-mini-bar"><span style="width:' + Math.round((r.played / maxPlayed) * 100) + '%"></span></div>' + fmtHours(r.played) + "</td></tr>"
      );
    }).join("");
    return (
      '<div class="dash-table-wrap"><table class="dash-table"><thead><tr>' + head + "</tr></thead><tbody>" + body + "</tbody></table></div>" +
      '<p class="dash-note">' + rows.length + " jour" + (rows.length > 1 ? "s" : "") + " sur la periode selectionnee. Clique un en-tete pour trier.</p>"
    );
  }

  // Extensions distinctes trouvees dans prof.lines[id].exp, sur TOUS les
  // metiers du profil - sert a peupler le filtre. prof.lines contient deja
  // le detail par palier/extension (Export.lua exporte la table complete,
  // pas seulement le palier courant), donc rien a changer cote addon.
  function collectProfessionExpansions(professions) {
    var set = {};
    Object.keys(professions || {}).forEach(function (key) {
      var prof = professions[key];
      if (!prof || !prof.lines) return;
      Object.keys(prof.lines).forEach(function (id) {
        var ln = prof.lines[id];
        if (ln && ln.exp) set[ln.exp] = true;
      });
    });
    var names = Object.keys(set);
    names.sort(function (a, b) { return expIndexOf(a) - expIndexOf(b); });
    return names;
  }

  function professionFilterHtml(expansions, active) {
    active = active || "overall";
    var opts = [{ key: "overall", label: "Total" }].concat(
      expansions.map(function (e) { return { key: e, label: e }; })
    );
    return (
      '<div class="filter-buttons bi-prof-filter" role="group" aria-label="Extension (metiers)">' +
      opts.map(function (o) {
        var isActive = active === o.key;
        return '<button type="button" class="filter-btn' + (isActive ? " active" : "") + '" data-action="prof-filter" data-value="' + esc(o.key) + '" aria-pressed="' + isActive + '">' + esc(o.label) + "</button>";
      }).join("") + "</div>"
    );
  }

  // filterExp absent/"overall" -> prof.base (total agrege toutes extensions,
  // comportement d'origine). Une extension precise -> somme des lignes de
  // prof.lines dont le .exp correspond ; un metier absent de cette extension
  // pour ce personnage est simplement omis (pas de faux "0/0").
  function renderProfessions(professions, filterExp) {
    var cards = [];
    Object.keys(professions || {}).forEach(function (key) {
      var prof = professions[key];
      if (!prof || !prof.name) return;
      var cur, max;
      if (!filterExp || filterExp === "overall") {
        var base = prof.base || {};
        cur = base.cur; max = base.max;
      } else {
        cur = 0; max = 0;
        var found = false;
        Object.keys(prof.lines || {}).forEach(function (id) {
          var ln = prof.lines[id];
          if (ln && ln.exp === filterExp) { cur += ln.cur || 0; max += ln.max || 0; found = true; }
        });
        if (!found) return;
      }
      var pct = max ? Math.min(100, Math.round((cur / max) * 100)) : null;
      cards.push(
        '<div class="prof-card">' +
          '<div class="prof-head"><span class="prof-name">' + esc(prof.name) + "</span>" +
          (pct != null ? '<span class="prof-pct">' + pct + "%</span>" : "") + "</div>" +
          (pct != null
            ? '<div class="prof-bar"><span style="width:' + pct + '%"></span></div><div class="prof-nums">' + fmtNum(cur) + " / " + fmtNum(max) + "</div>"
            : '<div class="dash-note" style="margin-top:6px">Pas de progression suivie.</div>') +
        "</div>"
      );
    });
    if (cards.length === 0) {
      return '<p class="dash-empty">Aucun metier suivi sur cette extension pour ce personnage.</p>';
    }
    return '<div class="prof-grid">' + cards.join("") + "</div>";
  }

  // ==========================================================================
  // COMPARAISON (2 profils)
  // ==========================================================================
  function renderComparison(profiles, ids, range, metricKey, uid) {
    var pA = profiles.filter(function (p) { return p.id === ids[0]; })[0];
    var pB = profiles.filter(function (p) { return p.id === ids[1]; })[0];
    if (!pA || !pB) return { html: '<p class="dash-empty">Selectionne deux personnages a comparer.</p>', charts: [] };
    var winA = computeWindow(pA.days, range), winB = computeWindow(pB.days, range);
    var tA = sumDays(sliceDays(pA.days, winA.from, winA.to)), tB = sumDays(sliceDays(pB.days, winB.from, winB.to));
    var netA = tA.goldGain - tA.goldSpent, netB = tB.goldGain - tB.goldSpent;
    var colorA = classColor(pA.char.class), colorB = classColor(pB.char.class);

    var rows = [
      { label: "Quetes completees", a: fmtNum(tA.quests), b: fmtNum(tB.quests), win: tA.quests === tB.quests ? null : (tA.quests > tB.quests ? "a" : "b") },
      { label: "Or (net)", a: fmtGold(netA), b: fmtGold(netB), win: netA === netB ? null : (netA > netB ? "a" : "b") },
      { label: "Temps joue", a: fmtHours(tA.played), b: fmtHours(tB.played), win: tA.played === tB.played ? null : (tA.played > tB.played ? "a" : "b") },
      { label: "Donjons & M+", a: fmtNum(tA.dungeons + tA.mplusCount), b: fmtNum(tB.dungeons + tB.mplusCount), win: (tA.dungeons + tA.mplusCount) === (tB.dungeons + tB.mplusCount) ? null : ((tA.dungeons + tA.mplusCount) > (tB.dungeons + tB.mplusCount) ? "a" : "b") },
      { label: "Jours actifs", a: fmtNum(tA.activeDayCount), b: fmtNum(tB.activeDayCount), win: tA.activeDayCount === tB.activeDayCount ? null : (tA.activeDayCount > tB.activeDayCount ? "a" : "b") },
    ];

    var table =
      '<table class="dash-table compare-table"><thead><tr><th></th>' +
      '<th><span class="compare-head" style="color:' + colorA + '">' + esc(pA.char.name) + "</span></th>" +
      '<th><span class="compare-head" style="color:' + colorB + '">' + esc(pB.char.name) + "</span></th>" +
      "</tr></thead><tbody>" +
      rows.map(function (r) {
        return "<tr><td>" + r.label + '</td><td class="' + (r.win === "a" ? "compare-win" : "") + '">' + r.a + '</td><td class="' + (r.win === "b" ? "compare-win" : "") + '">' + r.b + "</td></tr>";
      }).join("") +
      "</tbody></table>";

    var chart = buildLineChart([
      { id: "a", label: pA.char.name, color: colorA, points: seriesForProfile(pA, metricKey, winA.from, winA.to) },
      { id: "b", label: pB.char.name, color: colorB, points: seriesForProfile(pB, metricKey, winB.from, winB.to) },
    ], { ariaLabel: "Comparaison de " + METRICS[metricKey].label + " entre " + pA.char.name + " et " + pB.char.name, fmtY: METRICS[metricKey].fmtY, fmt: METRICS[metricKey].fmt, uid: uid });

    var html =
      '<div class="compare-grid">' + table + "</div>" +
      '<div class="bi-chart-card"><div class="bi-chart-head"><h3 class="dash-subtitle" style="margin:0">Evolution comparee</h3>' +
      metricSelectorHtml(metricKey) + "</div>" + chart.html + "</div>";
    return { html: html, charts: [chart] };
  }

  // ==========================================================================
  // CONTROLES (segments reutilisant les styles .filter-btn du site)
  // ==========================================================================
  function rangeSelectorHtml(range) {
    var opts = [["7", "7 jours"], ["30", "30 jours"], ["90", "90 jours"], ["all", "Tout"]];
    return (
      '<div class="filter-buttons bi-range" role="group" aria-label="Periode">' +
      opts.map(function (o) {
        return '<button type="button" class="filter-btn' + (String(range) === o[0] ? " active" : "") + '" data-action="range" data-value="' + o[0] + '" aria-pressed="' + (String(range) === o[0]) + '">' + o[1] + "</button>";
      }).join("") + "</div>"
    );
  }

  function metricSelectorHtml(metricKey) {
    return (
      '<div class="filter-buttons bi-metric" role="group" aria-label="Metrique du graphique">' +
      METRIC_ORDER.map(function (k) {
        return '<button type="button" class="filter-btn' + (metricKey === k ? " active" : "") + '" data-action="metric" data-value="' + k + '" aria-pressed="' + (metricKey === k) + '">' + METRICS[k].label + "</button>";
      }).join("") + "</div>"
    );
  }

  function profileChipsHtml(profiles, activeId, fixed) {
    if (profiles.length <= 1 && fixed) return "";
    return (
      '<div class="addon-chips bi-profiles" role="group" aria-label="Personnages">' +
      profiles.map(function (p) {
        var color = classColor(p.char.class);
        return (
          '<button type="button" class="addon-chip bi-profile-chip' + (p.id === activeId ? " active" : "") + '" data-action="select-profile" data-id="' + esc(p.id) + '" style="--chip-color:' + color + '" aria-pressed="' + (p.id === activeId) + '">' +
          '<i class="bi-chip-dot" style="background:' + color + '"></i>' + esc(p.char.name) +
          (fixed ? "" : ' <span class="bi-chip-remove" data-action="remove-profile" data-id="' + esc(p.id) + '" role="button" tabindex="0" aria-label="Retirer ' + esc(p.char.name) + '">&times;</span>') +
          "</button>"
        );
      }).join("") + "</div>"
    );
  }

  // ==========================================================================
  // APPLICATION (etat + rendu + interactions)
  // ==========================================================================
  var uidCounter = 0;

  function createApp(container, options) {
    options = options || {};
    var fixed = !!options.fixed;
    var uid = ++uidCounter;

    var state = {
      profiles: options.profiles || [],
      activeId: null,
      compareIds: [],
      compareMode: false,
      range: "30",
      metric: "quests",
      sort: { key: "date", dir: "desc" },
      profFilter: "overall",
    };
    if (state.profiles.length) state.activeId = state.profiles[0].id;

    function getActive() {
      return state.profiles.filter(function (p) { return p.id === state.activeId; })[0] || null;
    }

    function render() {
      if (state.profiles.length === 0) {
        container.innerHTML =
          '<div class="bi-empty">' +
          '<p class="dash-empty">' + (fixed
            ? "Aucune donnee n'a encore ete importee sur cette page. Genere un export en jeu (module Stats) puis remplace data/dashboard-tibi-data.js."
            : "Colle un code d'export ci-dessus pour voir apparaitre ton dashboard.") +
          "</p></div>";
        return;
      }

      var chips = profileChipsHtml(state.profiles, state.activeId, fixed);
      var canCompare = state.profiles.length >= 2;
      var toolbar =
        '<div class="bi-toolbar">' +
        (chips ? '<div class="bi-toolbar-row">' + chips + "</div>" : "") +
        '<div class="bi-toolbar-row bi-toolbar-row--between">' + rangeSelectorHtml(state.range) +
        (canCompare
          ? '<button type="button" class="btn ghost bi-compare-btn' + (state.compareMode ? " active" : "") + '" data-action="toggle-compare" aria-pressed="' + state.compareMode + '">' +
            (state.compareMode ? "Quitter la comparaison" : "Comparer 2 personnages") + "</button>"
          : "") +
        "</div></div>";

      if (state.compareMode && canCompare) {
        if (state.compareIds.length < 2) {
          state.compareIds = [state.profiles[0].id, state.profiles[1].id];
        }
        var pickers =
          '<div class="bi-toolbar-row compare-pickers">' +
          [0, 1].map(function (slot) {
            return '<select class="compare-select" data-action="compare-pick" data-slot="' + slot + '" aria-label="Personnage ' + (slot === 0 ? "A" : "B") + '">' +
              state.profiles.map(function (p) {
                return '<option value="' + esc(p.id) + '"' + (state.compareIds[slot] === p.id ? " selected" : "") + ">" + esc(p.char.name) + (p.char.realm ? " (" + esc(p.char.realm) + ")" : "") + "</option>";
              }).join("") + "</select>";
          }).join('<span class="compare-vs">vs</span>') +
          "</div>";
        var cmp = renderComparison(state.profiles, state.compareIds, state.range, state.metric, uid);
        container.innerHTML = toolbar + pickers + cmp.html;
        attachChartInteractivity(cmp.charts);
        return;
      }

      var active = getActive();
      if (!active) { state.activeId = state.profiles[0].id; active = getActive(); }
      var win = computeWindow(active.days, state.range);
      var bounds = dayKeyBounds(active.days);
      var period = bounds.min != null
        ? '<p class="bi-period">Du <strong>' + esc(fmtDateShort(epochDayToIso(win.from))) + "</strong> au <strong>" + esc(fmtDateShort(epochDayToIso(win.to))) + "</strong>" +
          (active.generatedAt ? ' &middot; export genere le ' + esc(active.generatedAt) : "") + "</p>"
        : "";

      var kpis = renderKpis(active, win);
      var chart = buildLineChart(
        [{ id: active.id, label: active.char.name, color: classColor(active.char.class), points: seriesForProfile(active, state.metric, win.from, win.to) }],
        { ariaLabel: "Evolution de " + METRICS[state.metric].label + " pour " + active.char.name, fmtY: METRICS[state.metric].fmtY, fmt: METRICS[state.metric].fmt, uid: uid }
      );

      var html = "";
      html += toolbar;
      html += renderCharBanner(active.char);
      if (active.checksumOk === false) {
        html += '<p class="dash-warning">Ce code semble incomplet ou modifie (somme de controle differente). L\'affichage ci-dessous peut etre partiel.</p>';
      }
      html += period;
      html += kpis;
      html += '<div class="bi-chart-card"><div class="bi-chart-head"><h3 class="dash-subtitle" style="margin:0">Evolution</h3>' + metricSelectorHtml(state.metric) + "</div>" + chart.html + "</div>";
      var hasProfessions = active.professions && typeof active.professions === "object" && Object.keys(active.professions).length > 0;
      var profSection = "";
      if (hasProfessions) {
        var profExpansions = collectProfessionExpansions(active.professions);
        var profFilterBar = profExpansions.length > 1 ? professionFilterHtml(profExpansions, state.profFilter) : "";
        profSection = '<h3 class="dash-subtitle">Metiers</h3>' + profFilterBar + renderProfessions(active.professions, state.profFilter);
      }

      html += '<div class="bi-columns">';
      html += '<div class="bi-col">' + profSection + "</div>";
      html += '<div class="bi-col bi-col--wide"><h3 class="dash-subtitle">Historique journalier</h3>' + renderDaysTable(active.days, win, state.sort) + "</div>";
      html += "</div>";

      container.innerHTML = html;
      attachChartInteractivity([chart]);
    }

    // `charts` : resultats de buildLineChart() de CE cycle de rendu, dans le
    // meme ordre que les .bi-chart-wrap apparaissent dans le HTML genere -
    // on les "zippe" par position plutot que de re-derailer les donnees du DOM.
    function attachChartInteractivity(charts) {
      var wraps = container.querySelectorAll(".bi-chart-wrap");
      wraps.forEach(function (wrap, i) {
        var entry = charts[i];
        if (!entry || !entry.hit || !entry.hit.length) return;
        var svg = wrap.querySelector("svg.bi-chart");
        var tooltip = wrap.querySelector(".chart-tooltip");
        var cursorLine = svg.querySelector(".chart-cursor-line");
        var cursorG = svg.querySelector(".chart-cursor");
        if (!svg || !tooltip || !cursorG) return;
        wrap.addEventListener("mousemove", function (e) {
          var r = svg.getBoundingClientRect();
          var vb = svg.viewBox.baseVal;
          var mx = ((e.clientX - r.left) / r.width) * vb.width;
          var nearest = null, best = Infinity;
          entry.hit.forEach(function (h) { var dist = Math.abs(h.x - mx); if (dist < best) { best = dist; nearest = h; } });
          if (!nearest) return;
          cursorG.removeAttribute("hidden");
          cursorLine.setAttribute("x1", nearest.x); cursorLine.setAttribute("x2", nearest.x);
          var rows = nearest.rows.map(function (row) {
            return '<div class="chart-tooltip-row"><i style="background:' + row.color + '"></i>' + esc(row.label) + ": <strong>" + esc(entry.fmt(row.v)) + "</strong></div>";
          }).join("");
          tooltip.innerHTML = '<div class="chart-tooltip-date">' + esc(fmtDateLong(epochDayToIso(nearest.ed))) + "</div>" + rows;
          tooltip.removeAttribute("hidden");
          var leftPct = (nearest.x / vb.width) * 100;
          tooltip.style.left = leftPct + "%";
          tooltip.style.transform = leftPct > 65 ? "translate(-100%,-8px)" : "translate(8px,-8px)";
        });
        wrap.addEventListener("mouseleave", function () {
          tooltip.setAttribute("hidden", "");
          cursorG.setAttribute("hidden", "");
        });
      });
    }

    container.addEventListener("click", function (e) {
      var el = e.target.closest("[data-action]");
      if (!el) return;
      var action = el.dataset.action;
      if (action === "range") { state.range = el.dataset.value; render(); }
      else if (action === "metric") { state.metric = el.dataset.value; render(); }
      else if (action === "prof-filter") { state.profFilter = el.dataset.value; render(); }
      else if (action === "select-profile") { state.activeId = el.dataset.id; render(); }
      else if (action === "remove-profile") {
        e.stopPropagation();
        var id = el.dataset.id;
        if (options.onRemove) options.onRemove(id);
        state.profiles = state.profiles.filter(function (p) { return p.id !== id; });
        if (state.activeId === id) state.activeId = state.profiles.length ? state.profiles[0].id : null;
        state.compareIds = state.compareIds.filter(function (cid) { return cid !== id; });
        render();
      }
      else if (action === "toggle-compare") { state.compareMode = !state.compareMode; render(); }
      else if (action === "sort-table") {
        var key = el.dataset.key;
        if (state.sort.key === key) state.sort.dir = state.sort.dir === "asc" ? "desc" : "asc";
        else state.sort = { key: key, dir: key === "date" ? "desc" : "desc" };
        render();
      }
    });
    container.addEventListener("keydown", function (e) {
      if (e.key !== "Enter" && e.key !== " ") return;
      var el = e.target.closest('[data-action="remove-profile"]');
      if (!el) return;
      e.preventDefault();
      el.click();
    });
    container.addEventListener("change", function (e) {
      var el = e.target.closest('[data-action="compare-pick"]');
      if (!el) return;
      var slot = Number(el.dataset.slot);
      state.compareIds[slot] = el.value;
      render();
    });

    return {
      render: render,
      setProfiles: function (profiles, activeId) {
        state.profiles = profiles;
        state.activeId = activeId || (profiles[0] && profiles[0].id) || null;
        render();
      },
    };
  }

  // ==========================================================================
  // PERSISTENCE (mode generique - Dashboard.html)
  // ==========================================================================
  function loadStoredCodes() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      var list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list : [];
    } catch (e) { return []; }
  }
  function saveStoredCodes(list) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(list.slice(-MAX_PROFILES))); } catch (e) {}
  }

  // Retourne TOUJOURS un tableau de profils (1 en v1, potentiellement
  // plusieurs en v2 - un code d'export = tout le compte).
  function envelopeToProfiles(envelope, code) {
    if (!envelope || SUPPORTED_SCHEMAS.indexOf(envelope.schema) === -1) {
      throw new Error("Format de schema non reconnu (v" + (envelope && envelope.schema) + ").");
    }
    var dataJSON = envelope.data;
    // decodeExportCode() precalcule checksumOk sur les octets bruts (seule
    // verification fiable, cf. son commentaire) ; ne recalculer ici que si
    // l'appelant nous a passe un envelope construit autrement.
    var checksumOk = true;
    if (envelope.checksumOk !== undefined) {
      checksumOk = envelope.checksumOk;
    } else if (envelope.checksum && typeof dataJSON === "string") {
      checksumOk = djb2(dataJSON) === envelope.checksum;
    }
    var data = {};
    try { data = typeof dataJSON === "string" ? JSON.parse(dataJSON) : (dataJSON || {}); }
    catch (e) { data = {}; checksumOk = false; }

    if (envelope.schema === 2) {
      var chars = data.chars || {};
      var profiles = Object.keys(chars).map(function (key) {
        var entry = chars[key] || {};
        var char = entry.char || {};
        return {
          id: (char.name || "?") + "-" + (char.realm || "?"), code: code, char: char,
          days: entry.days || {}, professions: entry.professions || {},
          generatedAt: envelope.generatedAt, checksumOk: checksumOk,
        };
      });
      if (profiles.length === 0) throw new Error("Ce code d'export ne contient aucun personnage.");
      return profiles;
    }

    // v1 (ancien format) : un seul personnage par code.
    var char = envelope.char || {};
    var id = (char.name || "?") + "-" + (char.realm || "?");
    return [{
      id: id, code: code, char: char, days: (data.stats && data.stats.days) || {},
      professions: data.professions || {}, generatedAt: envelope.generatedAt, checksumOk: checksumOk,
    }];
  }

  // ==========================================================================
  // API PUBLIQUE
  // ==========================================================================
  // Decode un code stocke en tableau de profils, [] si le code est perime/invalide.
  function safeDecode(code) {
    try { return envelopeToProfiles(decodeExportCode(code), code); } catch (e) { return []; }
  }

  function mountGeneric(container, formEls) {
    var stored = loadStoredCodes();
    var profiles = [];
    stored.forEach(function (entry) { profiles = profiles.concat(safeDecode(entry.code)); });
    var app = createApp(container, {
      fixed: false,
      profiles: profiles,
      // Un code d'export "compte" (schema v2) regroupe plusieurs personnages
      // dans le MEME code : retirer un seul personnage retire le code entier
      // (les autres personnages qu'il contient partent avec) - l'utilisateur
      // recolle un export a jour pour les recuperer, desormais trivial
      // puisqu'un seul code couvre tout le compte.
      onRemove: function (id) {
        saveStoredCodes(loadStoredCodes().filter(function (e) {
          return safeDecode(e.code).every(function (p) { return p.id !== id; });
        }));
      },
    });
    app.render();

    if (formEls && formEls.input && formEls.submit) {
      function addFromInput() {
        var code = (formEls.input.value || "").trim();
        if (!code) return;
        try {
          var newProfiles = envelopeToProfiles(decodeExportCode(code), code);
          var newIds = newProfiles.map(function (p) { return p.id; });
          // Remplace tout code stocke qui partage au moins un personnage avec
          // celui qu'on colle (re-export a jour du meme compte ou d'un
          // personnage deja present individuellement).
          var list = loadStoredCodes().filter(function (e) {
            return safeDecode(e.code).every(function (p) { return newIds.indexOf(p.id) === -1; });
          });
          list.push({ code: code, savedAt: Date.now() });
          saveStoredCodes(list);
          var refreshed = [];
          loadStoredCodes().forEach(function (entry) { refreshed = refreshed.concat(safeDecode(entry.code)); });
          app.setProfiles(refreshed, newIds[0]);
          if (formEls.onSuccess) formEls.onSuccess();
        } catch (err) {
          if (formEls.onError) formEls.onError(err);
        }
      }
      formEls.submit.addEventListener("click", addFromInput);
      formEls.onAdd = addFromInput;
    }
    app.clearAll = function () {
      saveStoredCodes([]);
      app.setProfiles([], null);
    };
    return app;
  }

  function mountFixed(container, codes) {
    codes = Array.isArray(codes) ? codes : (codes ? [codes] : []);
    var profiles = [];
    var errors = [];
    codes.filter(Boolean).forEach(function (code) {
      try { profiles = profiles.concat(envelopeToProfiles(decodeExportCode(code), code)); }
      catch (e) { errors.push(e); }
    });
    var app = createApp(container, { fixed: true, profiles: profiles });
    app.render();
    return { app: app, errors: errors };
  }

  // ==========================================================================
  // FUSION MULTI-SOURCES (Dashboard-Tibi : companion addon + fetcher API)
  // --------------------------------------------------------------------------
  // Deux sources alimentent la meme page figee. L'export addon (publie par le
  // companion PC, source "addon") FAIT FOI : il porte l'historique quotidien
  // complet (quetes, or, temps joue, donjons) que l'API ne connait pas.
  // L'API Blizzard (source "api") COMPLETE les champs manquants et garde
  // l'identite du personnage fraiche meme PC eteint (niveau, ilvl, spec), et
  // ajoute les personnages absents de l'export. Fusion au niveau du profil
  // (par personnage "Nom-Royaume"), champ par champ, addon prioritaire.
  // Aucun appel reseau ici : les deux sources sont deja des fichiers statiques
  // deposes cote site ; ce moteur ne fait que les lire et les entrelacer.
  // ==========================================================================
  function _present(v) { return v !== undefined && v !== null && v !== ""; }

  function mergeChar(addonChar, apiChar) {
    addonChar = addonChar || {}; apiChar = apiChar || {};
    var out = {}, keys = {};
    Object.keys(apiChar).forEach(function (k) { keys[k] = 1; });
    Object.keys(addonChar).forEach(function (k) { keys[k] = 1; });
    // addon prioritaire : sa valeur gagne des qu'elle est renseignee, sinon
    // on prend celle de l'API (identite gardee fraiche quand le PC est eteint).
    Object.keys(keys).forEach(function (k) {
      out[k] = _present(addonChar[k]) ? addonChar[k] : apiChar[k];
    });
    return out;
  }

  function mergeProfessions(addonProf, apiProf) {
    var out = {};
    if (apiProf) Object.keys(apiProf).forEach(function (k) { out[k] = apiProf[k]; });
    if (addonProf) Object.keys(addonProf).forEach(function (k) { out[k] = addonProf[k]; });
    return out;
  }

  // Fusionne deux listes de profils (addon prioritaire) en une liste unique
  // dedupliquee par id. Un personnage present dans une seule source est repris
  // tel quel ; present dans les deux, il est fusionne champ par champ.
  function mergeProfileSources(addonProfiles, apiProfiles) {
    addonProfiles = addonProfiles || []; apiProfiles = apiProfiles || [];
    var addonById = {}, apiById = {};
    addonProfiles.forEach(function (p) { addonById[p.id] = p; });
    apiProfiles.forEach(function (p) { apiById[p.id] = p; });
    var order = [], seen = {};
    addonProfiles.concat(apiProfiles).forEach(function (p) {
      if (!seen[p.id]) { seen[p.id] = 1; order.push(p.id); }
    });
    return order.map(function (id) {
      var a = addonById[id], b = apiById[id];
      if (a && !b) { a.sources = ["addon"]; return a; }
      if (b && !a) { b.sources = ["api"]; return b; }
      return {
        id: id, code: a.code, char: mergeChar(a.char, b.char),
        // L'API n'a pas d'historique journalier : l'addon garde toujours la main
        // sur `days` des qu'il en a. Si l'addon n'a rien (perso jamais exporte),
        // on retombe sur le `days` (vide) de l'API sans casser le rendu.
        days: (a.days && Object.keys(a.days).length) ? a.days : (b.days || {}),
        professions: mergeProfessions(a.professions, b.professions),
        generatedAt: Math.max(a.generatedAt || 0, b.generatedAt || 0),
        checksumOk: a.checksumOk, sources: ["addon", "api"],
      };
    });
  }

  // Decode une liste de codes addon en profils (source "addon"), en collectant
  // les erreurs sans jamais casser le rendu.
  function decodeAddonCodes(codes, errors) {
    var out = [];
    (codes || []).filter(Boolean).forEach(function (code) {
      try {
        envelopeToProfiles(decodeExportCode(code), code).forEach(function (p) {
          p.source = "addon"; out.push(p);
        });
      } catch (e) { if (errors) errors.push(e); }
    });
    return out;
  }

  // Transforme l'enveloppe API (objet JSON deja decode, schema 2, source "api")
  // en profils. L'enveloppe peut etre nulle (fetcher pas encore passe, ou pas
  // de composant API du tout) : on renvoie [] proprement.
  function apiEnvelopeToProfiles(envelope, errors) {
    if (!envelope) return [];
    try {
      return envelopeToProfiles(envelope, null).map(function (p) { p.source = "api"; return p; });
    } catch (e) { if (errors) errors.push(e); return []; }
  }

  // Point de montage de Dashboard-Tibi : fusionne l'export addon (companion) et
  // les donnees API, puis rend la MEME UI figee que mountFixed (aucune logique
  // d'affichage modifiee, seule la provenance des donnees devient automatique).
  function mountFixedMerged(container, opts) {
    opts = opts || {};
    var errors = [];
    var addonProfiles = decodeAddonCodes(opts.addonCodes || opts.codes, errors);
    var apiProfiles = apiEnvelopeToProfiles(opts.apiEnvelope, errors);
    var profiles = mergeProfileSources(addonProfiles, apiProfiles);
    var app = createApp(container, { fixed: true, profiles: profiles });
    app.render();
    return {
      app: app, errors: errors,
      counts: { addon: addonProfiles.length, api: apiProfiles.length, merged: profiles.length },
    };
  }

  global.TibiDashboard = {
    decodeExportCode: decodeExportCode,
    envelopeToProfiles: envelopeToProfiles,
    mergeProfileSources: mergeProfileSources,
    collectProfessionExpansions: collectProfessionExpansions,
    renderProfessions: renderProfessions,
    mountGeneric: mountGeneric,
    mountFixed: mountFixed,
    mountFixedMerged: mountFixedMerged,
  };
})(window);
