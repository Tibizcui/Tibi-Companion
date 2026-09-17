/* ============================================================================
   TibiSuite - dashboard-shared.js (v2 - BI)
   ----------------------------------------------------------------------------
   Moteur partage par les deux sections de Dashboard.html : "Mon Dashboard"
   (visualiseur generique multi-personnages, codes colles par le visiteur,
   stockes en localStorage) et "Donnee live Tibiscui" (section figee sur un ou
   plusieurs exports fixes fournis par le site). Aucun
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
  // Identifiant d'activeId reserve au profil virtuel "Compte" (somme de tous
  // les personnages charges) - ne peut jamais collisionner avec un vrai id
  // de profil (ceux-ci sont "Nom-Royaume", cf. buildProfileFromEnvelope). Meme
  // valeur que le charKey "__account__" du module Stats (UI.lua) - c'est le
  // meme concept ("Compte (tous personnages)"), harmonise entre l'addon et
  // le dashboard.
  var ALL_PROFILES_ID = "__account__";

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
    var compressed;
    try {
      compressed = atob(code);
    } catch (e) {
      throw new Error("Code invalide : ce n'est pas un code d'export TibiSuite reconnaissable.");
    }
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

  // Slug Armory Blizzard (royaume/nom) : minuscules, sans accents, espaces/
  // apostrophes -> tiret. Approximation raisonnable de la convention
  // Blizzard (verifiee sur "Kirin Tor" -> "kirin-tor"), pas garantie a 100%
  // pour tous les royaumes a caracteres speciaux.
  function armorySlug(s) {
    // Filtre par code point (0x0300-0x036f = marques diacritiques
    // combinantes) plutot qu'une classe de regex avec un caractere accentue
    // litteral dans le source - evite tout risque d'encodage/normalisation
    // Unicode invisible au fichier (meme famille de piege que le NBSP
    // francais rencontre ailleurs dans le projet).
    var noAccents = String(s || "").normalize("NFD").split("").filter(function (ch) {
      var code = ch.charCodeAt(0);
      return !(code >= 0x0300 && code <= 0x036f);
    }).join("");
    return noAccents.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  }

  // Lien vers la page Hauts faits du personnage sur l'Armurerie Blizzard EU
  // (pas de lien profond vers UN haut fait precis : aucun format d'ancre
  // fiable trouve sur le nouveau site worldofwarcraft.blizzard.com).
  function armoryCharUrl(char) {
    if (!char || !char.name || !char.realm) return null;
    return "https://worldofwarcraft.blizzard.com/fr-fr/worldsoul/eu/armory/character/" +
      armorySlug(char.realm) + "/" + armorySlug(char.name) + "/achievements";
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
  // Duree d'un run (M+ ou donjon normal, en secondes - miroir de Stats/UI.lua
  // fmtDuration) : plus courte typiquement qu'une session de jeu totale
  // (fmtHours), donc "Ym Ss" sous l'heure plutot que "0h23".
  function fmtDuration(seconds) {
    if (seconds == null) return "-";
    seconds = Math.floor(seconds);
    if (seconds <= 0) return "-";
    var h = Math.floor(seconds / 3600);
    var m = Math.floor((seconds % 3600) / 60);
    var s = seconds % 60;
    if (h > 0) return h + "h" + String(m).padStart(2, "0");
    return m + "m" + String(s).padStart(2, "0");
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
  function fmtGeneratedAt(ts) {
    if (!ts) return "";
    var d = new Date(ts * 1000);
    var dd = String(d.getUTCDate()).padStart(2, "0");
    var mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    return dd + "/" + mm + "/" + d.getUTCFullYear();
  }
  function fmtDateLong(iso) {
    var ed = isoToEpochDay(iso);
    if (ed == null) return esc(iso);
    var d = new Date(ed * 86400000);
    var days = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
    return days[d.getUTCDay()] + " " + d.getUTCDate() + " " + MONTHS_FR[d.getUTCMonth()] + " " + d.getUTCFullYear();
  }
  // Horodatage d'un evenement individuel (questLog/dungeonLog/delveLog/repLog,
  // en secondes Unix comme generatedAt) - meme convention UTC que
  // fmtGeneratedAt ci-dessus (coherent quelle que soit la timezone du
  // visiteur, au prix d'un decalage vs l'heure locale reelle du joueur).
  function fmtEventTime(ts) {
    if (!ts) return "?";
    var d = new Date(ts * 1000);
    var dd = String(d.getUTCDate()).padStart(2, "0");
    var mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    var hh = String(d.getUTCHours()).padStart(2, "0");
    var mi = String(d.getUTCMinutes()).padStart(2, "0");
    return dd + "/" + mm + " " + hh + ":" + mi;
  }

  function classColor(cls) { return CLASS_COLORS[String(cls || "").toUpperCase()] || "#e4b64a"; }

  // ==========================================================================
  // AGREGATION
  // ==========================================================================
  function sumDays(days) {
    var out = { quests: 0, goldGain: 0, goldSpent: 0, played: 0, dungeons: 0, mplusCount: 0, raids: 0, delves: 0, repGained: 0, pvpKillsGained: 0, profGained: 0,
      bgPlayedGained: 0, bgWonGained: 0, arenaPlayedGained: 0, arenaWonGained: 0, dayCount: 0, activeDayCount: 0 };
    if (!days) return out;
    Object.keys(days).forEach(function (k) {
      var d = days[k] || {};
      out.quests += d.quests || 0;
      out.goldGain += d.goldGain || 0;
      out.goldSpent += d.goldSpent || 0;
      out.played += d.played || 0;
      out.dungeons += d.dungeons || 0;
      out.mplusCount += (d.mplus && d.mplus.length) || 0;
      out.raids += d.raids || 0;
      out.delves += d.delves || 0;
      out.repGained += d.repGained || 0;
      out.pvpKillsGained += d.pvpKillsGained || 0;
      out.profGained += d.profGained || 0;
      out.bgPlayedGained += d.bgPlayedGained || 0;
      out.bgWonGained += d.bgWonGained || 0;
      out.arenaPlayedGained += d.arenaPlayedGained || 0;
      out.arenaWonGained += d.arenaWonGained || 0;
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

  // Fusionne une entree "days[dateKey]" de plusieurs personnages pour la
  // meme date : les nombres s'additionnent (quests, played, goldGain...),
  // les tableaux se concatenent (questLog, mplus, dungeonLog...) - generique
  // sur les cles plutot que de lister chaque metrique en dur, pour rester
  // valide si l'addon Stats ajoute une metrique plus tard.
  function mergeDayEntry(base, extra) {
    var out = Object.assign({}, base);
    Object.keys(extra || {}).forEach(function (k) {
      var v = extra[k];
      if (Array.isArray(v)) out[k] = (out[k] || []).concat(v);
      else if (typeof v === "number") out[k] = (out[k] || 0) + v;
      else if (out[k] == null) out[k] = v;
    });
    return out;
  }

  // Fusionne les `days` de plusieurs profils en un seul historique (cle =
  // date, valeur = somme/concat de tous les personnages actifs ce jour-la) -
  // sert au profil virtuel "Compte" (cf. buildAccountProfile).
  function mergeProfilesDays(profiles) {
    var merged = {};
    (profiles || []).forEach(function (p) {
      var days = (p && p.days) || {};
      Object.keys(days).forEach(function (k) {
        merged[k] = mergeDayEntry(merged[k] || {}, days[k] || {});
      });
    });
    return merged;
  }

  // Profil virtuel "Compte" (id reserve ALL_PROFILES_ID) : somme les `days`
  // de tous les personnages charges. `char` reste volontairement minimal
  // (pas de classe/niveau/reputation a "sommer" - ces details restent
  // propres a un seul personnage) : les tuiles PVP/Gouffres/Reputations et
  // le detail Metiers s'affichent alors vides plutot que faux.
  function buildAccountProfile(profiles) {
    profiles = profiles || [];
    var generatedAt = null;
    profiles.forEach(function (p) {
      if (p && p.generatedAt && (generatedAt == null || p.generatedAt > generatedAt)) generatedAt = p.generatedAt;
    });
    return {
      id: ALL_PROFILES_ID,
      char: { name: "Compte (" + profiles.length + " personnage" + (profiles.length > 1 ? "s" : "") + ")" },
      days: mergeProfilesDays(profiles),
      professions: {},
      generatedAt: generatedAt,
      checksumOk: true,
    };
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
        if (!hit[p.ed]) hit[p.ed] = { ed: p.ed, x: x, rows: [], dateLabel: p.label || null };
        hit[p.ed].rows.push({ id: s.id, y: y, v: p.v, actual: p.actual, fmt: s.fmt, color: s.color, label: s.label });
        return { x: x, y: y };
      });
      var path = catmullRomPath(pts);
      var areaId = "areaGrad" + si + "_" + (opts.uid || 0);
      var area = (si === 0 && !opts.noArea)
        ? '<path d="' + path + " L" + xOf(maxEd) + "," + (padT + innerH) + " L" + xOf(minEd) + "," + (padT + innerH) + ' Z" fill="url(#' + areaId + ')" stroke="none"/>'
        : "";
      var grad = (si === 0 && !opts.noArea)
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
    raids: { label: "Raids", get: function (d) { return d.raids || 0; }, fmt: fmtNum, fmtY: fmtNum },
    delves: { label: "Gouffres", get: function (d) { return d.delves || 0; }, fmt: fmtNum, fmtY: fmtNum },
    repGained: { label: "Reputation gagnee", get: function (d) { return d.repGained || 0; }, fmt: fmtNum, fmtY: fmtNum },
    profGained: { label: "Points de metier gagnes", get: function (d) { return d.profGained || 0; }, fmt: fmtNum, fmtY: fmtNum },
    pvpKillsGained: { label: "Adversaires tues", get: function (d) { return d.pvpKillsGained || 0; }, fmt: fmtNum, fmtY: fmtNum },
    bgPlayedGained: { label: "Champs de bataille joues", get: function (d) { return d.bgPlayedGained || 0; }, fmt: fmtNum, fmtY: fmtNum },
    bgWonGained: { label: "Champs de bataille gagnes", get: function (d) { return d.bgWonGained || 0; }, fmt: fmtNum, fmtY: fmtNum },
    arenaPlayedGained: { label: "Arenes jouees", get: function (d) { return d.arenaPlayedGained || 0; }, fmt: fmtNum, fmtY: fmtNum },
    arenaWonGained: { label: "Arenes gagnees", get: function (d) { return d.arenaWonGained || 0; }, fmt: fmtNum, fmtY: fmtNum },
  };
  // Temps joue en premier (meme ordre que l'addon Stats, UI.lua CARD_METRICS -
  // demande utilisateur, priorite visuelle a la mesure la plus consultee),
  // le reste dans son ordre precedent. PVP (adversaires tues/champs de
  // bataille/arenes) vit dans son propre graphique dedie (PVP_METRIC_ORDER
  // plus bas), pas ici.
  var METRIC_ORDER = ["played", "quests", "gold", "dungeons", "raids", "delves", "repGained", "profGained"];

  // Graphique PVP dedie : toujours superpose (pas de mode une-seule-metrique,
  // 5 courbes restent lisibles).
  var PVP_METRIC_ORDER = ["pvpKillsGained", "bgPlayedGained", "bgWonGained", "arenaPlayedGained", "arenaWonGained"];

  // Couleurs fixes pour la superposition multi-metriques (Evolution ET
  // graphique PVP) - une couleur distincte par metrique, choisies pour
  // rester lisibles sur le fond graphite. Memes teintes que l'addon Stats
  // (UI.lua, OVERLAY_COLORS / PVP_OVERLAY_COLORS).
  var OVERLAY_COLORS = {
    quests: "#4fd1c5", gold: "#f4d68a", played: "#7c9eff", dungeons: "#ff8a8a", raids: "#e0975c",
    delves: "#b389f4", repGained: "#6ee7b7", profGained: "#ffb454",
    pvpKillsGained: "#ff6ec7", bgPlayedGained: "#7c9eff", bgWonGained: "#6ee7b7",
    arenaPlayedGained: "#ffb454", arenaWonGained: "#b389f4",
  };

  // Identite couleur des 3 sections repliables (tuiles resume) - meme
  // principe que l'addon Stats (UI.lua, SECTION_ACCENTS) : PVP reprend le
  // rose de pvpKillsGained (pas de carte PVP dans METRIC_ORDER), Gouffres et
  // Tourments partagent la meme tuile/couleur (fusion demandee, memes deux
  // systemes de contenu solo scalable que l'addon), Reputations reprend le
  // vert de repGained.
  var SUMMARY_SECTION_COLORS = {
    pvp: OVERLAY_COLORS.pvpKillsGained,
    delves: OVERLAY_COLORS.delves,
    reputations: OVERLAY_COLORS.repGained,
  };

  // Normalise une serie {ed,v,label} sur 0-100 (min-max de la serie elle-meme)
  // pour rendre des metriques d'echelles tres differentes (quetes ~100,
  // or ~milliers, temps joue en heures...) comparables visuellement sur un
  // meme axe Y. La valeur reelle est conservee dans `actual` pour l'infobulle.
  function normalizeSeries(points) {
    if (!points.length) return points;
    var vals = points.map(function (p) { return p.v; });
    var minV = Math.min.apply(null, vals), maxV = Math.max.apply(null, vals);
    var span = maxV - minV;
    // Serie plate (aucune variation sur la periode, cas courant : 0 activite
    // tous les jours) -> 0%, pas 50% - une ligne a 50% donnerait l'impression
    // trompeuse d'etre a mi-chemin de quelque chose alors qu'il n'y a
    // litteralement rien a etaler entre un min et un max identiques.
    return points.map(function (p) {
      return { ed: p.ed, label: p.label, actual: p.v, v: span ? ((p.v - minV) / span) * 100 : 0 };
    });
  }

  function seriesForProfile(profile, metricKey, fromEd, toEd) {
    var metric = METRICS[metricKey];
    var days = sliceDays(profile.days, fromEd, toEd);
    var keys = Object.keys(days).sort();
    return keys.map(function (k) { return { ed: isoToEpochDay(k), v: metric.get(days[k] || {}) }; }).filter(function (p) { return p.ed != null; });
  }

  // Regroupe des points quotidiens {ed,v} en semaine/mois/annee (somme des
  // valeurs, meme logique que SX.BuildSeries cote addon - Stats/Core.lua).
  // Semaine calendaire debut lundi (miroir de SX.StartOfWeek).
  function bucketAnchorEd(ed, granularity) {
    var d = new Date(ed * 86400000);
    if (granularity === "week") {
      var dow = d.getUTCDay(); // 0=dimanche..6=samedi
      var diffToMonday = (dow === 0) ? 6 : (dow - 1);
      return ed - diffToMonday;
    }
    if (granularity === "month") return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 86400000);
    if (granularity === "year") return Math.floor(Date.UTC(d.getUTCFullYear(), 0, 1) / 86400000);
    return ed;
  }

  function bucketLabel(anchorEd, granularity, long) {
    var d = new Date(anchorEd * 86400000);
    if (granularity === "week") return (long ? "Semaine du " : "") + d.getUTCDate() + " " + MONTHS_FR[d.getUTCMonth()];
    if (granularity === "month") {
      var name = MONTHS_FR[d.getUTCMonth()];
      return name.charAt(0).toUpperCase() + name.slice(1) + " " + d.getUTCFullYear();
    }
    if (granularity === "year") return String(d.getUTCFullYear());
    return fmtDateLong(epochDayToIso(anchorEd));
  }

  function bucketSeries(points, granularity) {
    if (!granularity || granularity === "day") return points;
    var buckets = {}, order = [];
    points.forEach(function (p) {
      var anchor = bucketAnchorEd(p.ed, granularity);
      if (!buckets[anchor]) { buckets[anchor] = { ed: anchor, v: 0, label: bucketLabel(anchor, granularity, true) }; order.push(anchor); }
      buckets[anchor].v += p.v;
    });
    return order.sort(function (a, b) { return a - b; }).map(function (ed) { return buckets[ed]; });
  }

  // Une serie par metrique de METRIC_ORDER, normalisee 0-100 (cf.
  // normalizeSeries) pour rester comparable malgre des echelles tres
  // differentes (quetes ~100, or ~milliers, temps joue en heures...).
  function overlaySeriesForProfile(profile, granularity, fromEd, toEd, metricOrder) {
    return (metricOrder || METRIC_ORDER).map(function (key) {
      var pts = bucketSeries(seriesForProfile(profile, key, fromEd, toEd), granularity);
      return { id: key, label: METRICS[key].label, color: OVERLAY_COLORS[key] || "#e4b64a", fmt: METRICS[key].fmt, points: normalizeSeries(pts) };
    });
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
        (char.achievementPoints != null
          ? '<span class="dash-banner-tail"> - <img class="dash-achiev-icon" src="https://wow.zamimg.com/images/wow/icons/medium/achievement_general.jpg" alt="" loading="lazy"> '
            + esc(fmtNum(char.achievementPoints)) + " points de hauts faits</span>"
          : "") +
      "</div>"
    );
  }

  // Photo instantanee fournie par Blizzard (cote/saison, victoires-defaites,
  // honneur, conquete) - pas d'historique jour par jour comme les cartes KPI
  // ci-dessus, donc pas de sparkline/delta : juste l'etat actuel.
  var PVP_BRACKET_ORDER = ["2v2", "3v3", "rbg", "shuffle", "blitz"];
  var PVP_BRACKET_LABELS = { "2v2": "Arene 2c2", "3v3": "Arene 3c3", rbg: "BG classe", shuffle: "Melee solo", blitz: "Blitz" };

  function pctOf(wins, total) {
    if (!total) return 0;
    return Math.round((wins / total) * 100);
  }

  // key/color/expanded : tuile cliquable qui deplie/replie son detail (cf.
  // action "toggle-summary") - meme principe que l'addon Stats (UI.lua,
  // BuildTile/view.summaryExpanded). Couleur de section sur le lisere du
  // haut et le titre, comme les cartes KPI (OVERLAY_COLORS).
  function tileHtml(key, title, color, expanded, stats, sub) {
    var indicator = expanded
      ? '<span style="color:' + color + ';font-weight:700">- Replier</span>'
      : '<span style="color:var(--muted);font-weight:700">+ Deplier</span>';
    return (
      '<div class="stats-tile" data-action="toggle-summary" data-value="' + esc(key) + '" style="border-top-color:' + color + ';cursor:pointer">' +
        '<div class="stats-tile-head"><div class="stats-tile-title" style="color:' + color + '">' + esc(title) + "</div>" + indicator + "</div>" +
        '<div class="stats-tile-stats">' +
          stats.map(function (s) { return '<div><div class="stats-tile-label">' + esc(s[0]) + '</div><div class="stats-tile-value">' + esc(s[1]) + "</div></div>"; }).join("") +
        "</div>" +
        (sub ? '<div class="stats-tile-sub">' + sub + "</div>" : "") +
      "</div>"
    );
  }

  // Trois tuiles resume (PVP / Gouffres+Tourments / Reputations) - photo
  // instantanee fournie par Blizzard, pas d'historique jour par jour comme
  // les cartes KPI ci-dessus (aucune donnee equivalente n'existe cote
  // client). Repliees par defaut (summaryExpanded) ; le detail (par
  // bracket, par champ de bataille, par type de gouffre/donjon Tourment)
  // n'est rendu que si sa tuile est depliee (cf. les appels a
  // renderPvpDetail/renderDelveDetail/renderTorghastDungeonDetail/
  // renderReputationDetail plus bas). Gouffres et Tourments partagent
  // desormais UNE seule tuile/un seul depliage (demande utilisateur du
  // 2026-09-13, meme fusion que l'addon - deux systemes de contenu solo
  // scalable).
  function renderSummaryTiles(char, summaryExpanded) {
    var pvp = char && char.pvp, t = char && char.torghast;
    var types = char && char.delveTypes;
    var delveTypesTotal = 0;
    if (types) Object.keys(types).forEach(function (n) { delveTypesTotal += types[n].count || 0; });
    // delveTypes ne compte qu'a partir du moment ou l'addon a commence a
    // suivre (aucune API retroactive par NOM de gouffre) ; delveCompletedLifetime
    // vient des Statistiques Blizzard (a vie, toutes saisons) et peut donc
    // etre superieur - on prend toujours le plus grand des deux.
    var delveTotal = Math.max(delveTypesTotal, (char && char.delveCompletedLifetime) || 0);
    var hasTorghastData = t && (t.highestLayer != null || t.soulAsh != null || t.soulCinders != null);

    var delveSub;
    if (char && char.delveTierAchievementName) delveSub = '<span style="color:var(--gold-soft);font-weight:700">' + esc(char.delveTierAchievementName) + "</span>";
    else if (char && char.delveAllMaxed) delveSub = '<span style="color:var(--gold-soft);font-weight:700">Tous les gouffres rencontres sont au palier max !</span>';
    else if (delveTotal === 0 && !hasTorghastData) delveSub = "Aucun gouffre ni Tourment termine";
    else {
      var extras = [];
      if (char && char.delveCompanionLevel != null) extras.push("Compagnon " + char.delveCompanionLevel);
      if (t && t.soulAsh != null) extras.push("Cendres " + fmtNum(t.soulAsh));
      if (t && t.soulCinders != null) extras.push("Noires " + fmtNum(t.soulCinders));
      delveSub = extras.join(" &middot; ");
    }
    var pvpSub = (pvp && pvp.brackets && Object.keys(pvp.brackets).length) ? "" : "Aucune activite PVP classee cette saison.";

    var repSummary = char && char.reputations && char.reputations.summary;
    var repSub = (repSummary && repSummary.paragonReady) ? '<span style="color:var(--gold-soft);font-weight:700">' + repSummary.paragonReady + " caisse(s) paragon disponible(s)</span>"
      : (repSummary && repSummary.tracked > 0 && repSummary.maxedCount === repSummary.tracked) ? '<span style="color:var(--gold-soft);font-weight:700">Toutes les factions suivies sont au maximum !</span>'
      : (!repSummary || repSummary.tracked === 0) ? "Aucune reputation suivie pour ce personnage."
      : "";

    return (
      '<div class="stats-tiles">' +
        tileHtml("pvp", "PVP", SUMMARY_SECTION_COLORS.pvp, !!summaryExpanded.pvp,
          [["Tues", fmtNum(pvp && pvp.honorableKills || 0)], ["Honneur", fmtNum(pvp && pvp.honor || 0)], ["Conquete", fmtNum(pvp && pvp.conquest || 0)]], pvpSub) +
        tileHtml("delves", "Gouffres et Tourments", SUMMARY_SECTION_COLORS.delves, !!summaryExpanded.delves,
          [["Total", fmtNum(delveTotal)], ["Palier gouffre", (char && char.delveHighestTier != null) ? char.delveHighestTier : "-"], ["Palier tourment", (t && t.highestLayer != null) ? t.highestLayer : "-"]], delveSub) +
        tileHtml("reputations", "Reputations", SUMMARY_SECTION_COLORS.reputations, !!summaryExpanded.reputations,
          [["Suivies", fmtNum(repSummary && repSummary.tracked || 0)], ["Rang max", (repSummary && repSummary.highestRenownRank != null) ? repSummary.highestRenownRank : "-"], ["Exaltees", fmtNum(repSummary && repSummary.maxedCount || 0)]], repSub) +
      "</div>"
    );
  }

  function tableHtml(title, headers, rows, noDataText) {
    if (!rows.length) return '<p class="kpi-sub" style="margin:0 0 18px">' + esc(noDataText) + "</p>";
    return (
      (title ? '<div class="stats-table-title">' + esc(title) + "</div>" : "") +
      '<table class="stats-table"><thead><tr>' +
        headers.map(function (h) { return '<th class="' + (h[1] || "") + '">' + esc(h[0]) + "</th>"; }).join("") +
      "</tr></thead><tbody>" +
        rows.map(function (r) { return "<tr>" + r.map(function (c) { return '<td class="' + (c[1] || "") + '">' + c[0] + "</td>"; }).join("") + "</tr>"; }).join("") +
      "</tbody></table>"
    );
  }

  // Enveloppe commune des panneaux de detail sous une tuile - lisere/titre
  // dans la couleur de la section (cf. SUMMARY_SECTION_COLORS), meme
  // traitement que le fix "couleur de la carte d'origine" des cartes KPI.
  function statsDetailWrap(color, title, innerHtml) {
    return '<div class="stats-detail" style="border-top-color:' + color + '"><div class="stats-detail-title" style="color:' + color + '">' + esc(title) + "</div>" + innerHtml + "</div>";
  }

  // Detail PVP : bilan par bracket + detail par champ de bataille, en
  // tableaux, sous les tuiles resume.
  function renderPvpDetail(char) {
    var pvp = char && char.pvp;
    if (!pvp) return "";

    var lineParts = [];
    if (pvp.deathsByPlayers != null) lineParts.push("Tue par un joueur : " + fmtNum(pvp.deathsByPlayers));
    if (pvp.deathsByEnemyFaction != null) lineParts.push("Tue par la faction adverse : " + fmtNum(pvp.deathsByEnemyFaction));
    var arena = pvp.arena;
    lineParts.push("Arene (2c2+3c3+melee solo) : " + (arena ? (fmtNum(arena.played || 0) + " matchs - " + fmtNum(arena.won || 0) + " victoires (" + pctOf(arena.won || 0, arena.played || 0) + "%)") : "-"));
    lineParts.push("Champs de bataille : " + (pvp.bgParticipation ? (fmtNum(pvp.bgParticipation) + " participations - " + fmtNum(pvp.bgWinsTotal || 0) + " victoires (" + pctOf(pvp.bgWinsTotal || 0, pvp.bgParticipation) + "%)") : "-"));
    var summaryLine = '<p class="kpi-sub" style="margin:0 0 16px">' + lineParts.map(esc).join(" &middot; ") + "</p>";

    var bracketRows = PVP_BRACKET_ORDER.map(function (key) {
      var b = pvp.brackets && pvp.brackets[key];
      if (!b) return null;
      var wins = b.seasonWon || 0, losses = Math.max(0, (b.seasonPlayed || 0) - wins);
      return [
        [esc(PVP_BRACKET_LABELS[key])],
        ['<span style="color:var(--gold-soft);font-weight:700">' + esc(b.rating || 0) + "</span>", "num"],
        [esc(b.seasonBest || b.rating || 0), "num"],
        [esc(wins) + "V / " + esc(losses) + "D (" + pctOf(wins, wins + losses) + "%)", "num"],
      ];
    }).filter(Boolean);
    var bracketTable = tableHtml("Detail par bracket", [["Bracket"], ["Cote", "num"], ["Meilleur", "num"], ["Bilan", "num"]], bracketRows, "Aucune activite PVP classee cette saison.");

    var bgRows = [];
    if (pvp.bgWinsByName) {
      var names = Object.keys(pvp.bgWinsByName).sort(function (a, b) { return pvp.bgWinsByName[b] - pvp.bgWinsByName[a]; }).slice(0, 6);
      bgRows = names.map(function (n) { return [[esc(n)], [esc(pvp.bgWinsByName[n]), "num"]]; });
    }
    var bgTable = tableHtml("Champs de bataille - detail", [["Nom"], ["Victoires", "num"]], bgRows, "Aucun champ de bataille joue.");

    return statsDetailWrap(SUMMARY_SECTION_COLORS.pvp, "PVP", summaryLine + bracketTable + bgTable);
  }

  // Detail Gouffres : tableau par type (nom / nombre de fois / palier max).
  function renderDelveDetail(char) {
    var types = char && char.delveTypes;
    var rows = [];
    if (types) {
      var names = Object.keys(types).sort(function (a, b) { return (types[b].count || 0) - (types[a].count || 0); }).slice(0, 8);
      rows = names.map(function (n) {
        var e = types[n];
        return [[esc(n)], [esc(e.count || 0), "num"], ['<span style="color:var(--gold-soft);font-weight:700">' + esc(e.highestTier || 0) + "</span>", "num"]];
      });
    }
    return statsDetailWrap(SUMMARY_SECTION_COLORS.delves, "Gouffre", tableHtml("", [["Nom"], ["Fois", "num"], ["Palier max", "num"]], rows, "Aucun gouffre termine pour ce personnage."));
  }

  // Difficulte "Tourment" appliquee a des donjons classiques (haut fait
  // distinct par donjon/echelon, ex: "Tourment : Couloirs Distordus
  // (echelon 6)") - different de la tour Torghast/Ombreterre (tuile resume),
  // malgre le meme mot "Tourment" pour les deux systemes.
  function renderTorghastDungeonDetail(char) {
    var types = char && char.torghastByDungeon;
    var rows = [];
    if (types) {
      var armoryUrl = armoryCharUrl(char);
      var names = Object.keys(types).sort(function (a, b) { return (types[b].count || 0) - (types[a].count || 0); }).slice(0, 10);
      rows = names.map(function (n) {
        var e = types[n];
        var echelonHtml = '<span style="color:var(--gold-soft);font-weight:700">' + esc(e.highestEchelon || 0) + "</span>";
        var achHtml = "";
        if (e.highestAchievementName) {
          achHtml = armoryUrl
            ? '<a href="' + esc(armoryUrl) + '" target="_blank" rel="noopener" title="Voir sur l\'Armurerie Blizzard">' + esc(e.highestAchievementName) + "</a>"
            : esc(e.highestAchievementName);
        }
        return [[esc(n)], [esc(e.count || 0), "num"], [echelonHtml, "num"], [achHtml]];
      });
    }
    return statsDetailWrap(SUMMARY_SECTION_COLORS.delves, "Tourments - La tour des damnes", tableHtml("", [["Nom"], ["Fois", "num"], ["Echelon max", "num"], ["Haut fait"]], rows, "Aucun Tourment termine pour ce personnage."));
  }

  function repSystemLabel(info) {
    if (info.system === "renown") return "Renom " + (info.rank || 0);
    if (info.system === "friendship" || info.system === "classic") return info.label || "";
    return "";
  }

  function renderReputationDetail(char) {
    var list = char && char.reputations && char.reputations.list;
    var rows = [];
    if (list) {
      // Uniquement les factions avec une progression RECENTE constatee
      // (lastGainAt present) - pas un tri par % avec repli, un vrai filtre :
      // les factions jamais touchees depuis que ce suivi existe n'apparaissent
      // pas du tout (demande explicite : les 10 dernieres reputations sur
      // lesquelles le joueur a fait progresser la completion recemment).
      var recent = list.filter(function (info) { return !info.maxed && info.lastGainAt; });
      var sorted = recent.slice().sort(function (a, b) { return b.lastGainAt - a.lastGainAt; }).slice(0, 10);
      rows = sorted.map(function (info) {
        var pctText = Math.round((info.pct || 0) * 100) + "%";
        var progressHtml = '<span style="color:var(--gold-soft);font-weight:700">' + esc(pctText) + "</span>";
        return [[esc(info.name || "?")], [esc(repSystemLabel(info))], [progressHtml, "num"]];
      });
    }
    return statsDetailWrap(SUMMARY_SECTION_COLORS.reputations, "Reputation", tableHtml("", [["Nom"], ["Systeme"], ["Progression", "num"]], rows, "Aucune progression de reputation recente."));
  }

  // Metiers suivis nativement par Stats (char.professionsNative, distinct
  // du champ "professions" alimente par SkillTrackerDB pour la vue par
  // extension ci-dessus) - meme principe strict que reputation : uniquement
  // les metiers avec une progression RECENTE constatee, exclut ceux deja a
  // 100%.
  function renderProfessionDetail(char) {
    var list = char && char.professionsNative && char.professionsNative.list;
    var rows = [];
    if (list) {
      var recent = list.filter(function (info) { return !info.maxed && info.lastGainAt; });
      var sorted = recent.slice().sort(function (a, b) { return b.lastGainAt - a.lastGainAt; }).slice(0, 10);
      rows = sorted.map(function (info) {
        var pctText = Math.min(100, Math.round((info.pct || 0) * 100)) + "%";
        var progressHtml = '<span style="color:var(--gold-soft);font-weight:700">' + esc(pctText) + "</span>";
        var levelText = fmtNum(info.cur || 0) + " / " + fmtNum(info.max || 0);
        return [[esc(info.name || "?")], [esc(levelText)], [progressHtml, "num"]];
      });
    }
    return '<div class="stats-detail"><div class="stats-detail-title">Metiers</div>' + tableHtml("", [["Nom"], ["Niveau"], ["Progression", "num"]], rows, "Aucune progression de metier recente.") + "</div>";
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

  function delvesSubLabel(char) {
    if (!char) return "";
    var parts = [];
    if (char.delveHighestTier != null) parts.push("Palier max " + char.delveHighestTier);
    if (char.delveCompanionLevel != null) parts.push("Compagnon niv. " + char.delveCompanionLevel);
    return parts.join(" &middot; ");
  }

  function renderKpis(profile, win) {
    var cur = sliceDays(profile.days, win.from, win.to);
    var prev = win.prevFrom != null ? sliceDays(profile.days, win.prevFrom, win.prevTo) : null;
    var t = sumDays(cur), p = prev ? sumDays(prev) : null;
    var net = t.goldGain - t.goldSpent, prevNet = p ? (p.goldGain - p.goldSpent) : null;
    var color = classColor(profile.char && profile.char.class);

    // Temps joue en premier (cf. METRIC_ORDER) - meme ordre que l'addon.
    var defs = [
      { key: "played", label: "Temps joue", value: fmtHours(t.played), cur: t.played, prev: p ? p.played : null, sub: t.dayCount ? (fmtHours(t.played / t.dayCount) + " / jour en moyenne") : "", metric: "played" },
      { key: "quests", label: "Quetes completees", value: fmtNum(t.quests), cur: t.quests, prev: p ? p.quests : null, metric: "quests" },
      { key: "gold", label: "Or (net)", value: fmtGold(net), cur: net, prev: prevNet, cls: net >= 0 ? "pos" : "neg", sub: fmtGold(t.goldGain) + " gagne &middot; " + fmtGold(t.goldSpent) + " depense", metric: "gold" },
      { key: "dungeons", label: "Donjons & M+", value: fmtNum(t.dungeons + t.mplusCount), cur: t.dungeons + t.mplusCount, prev: p ? (p.dungeons + p.mplusCount) : null, sub: t.dungeons + " donjons &middot; " + t.mplusCount + " M+", metric: "dungeons" },
      { key: "raids", label: "Raids", value: fmtNum(t.raids), cur: t.raids, prev: p ? p.raids : null, metric: "raids" },
      { key: "delves", label: "Gouffres", value: fmtNum(t.delves), cur: t.delves, prev: p ? p.delves : null, sub: delvesSubLabel(profile.char), metric: "delves" },
      { key: "repGained", label: "Reputation gagnee", value: fmtNum(t.repGained), cur: t.repGained, prev: p ? p.repGained : null, metric: "repGained" },
      { key: "profGained", label: "Points de metier gagnes", value: fmtNum(t.profGained), cur: t.profGained, prev: p ? p.profGained : null, metric: "profGained" },
    ];

    return (
      '<div class="bi-kpis">' +
      defs.map(function (c) {
        var keys = Object.keys(cur).sort();
        var vals = keys.map(function (k) { return METRICS[c.metric].get(cur[k] || {}); });
        // Cliquable des qu'un journal d'evenements existe pour la metrique
        // (EVENT_LOG_COLS) - les 8 cartes en ont desormais toutes un.
        var clickable = !!EVENT_LOG_COLS[c.metric];
        // Couleur propre a chaque carte (meme palette que l'addon Stats,
        // OVERLAY_COLORS) sur le liseré du haut et le mini-graphique, au
        // lieu de la couleur de classe uniforme - demande utilisateur du
        // 2026-09-13, meme traitement que la refonte de la grille de cartes
        // cote addon. "Or" garde son code vert/rouge gain-perte (c.cls),
        // plus parlant qu'une couleur de categorie sur cette carte precise.
        var metricColor = OVERLAY_COLORS[c.metric] || color;
        var valueStyle = c.cls ? "" : ' style="color:' + metricColor + '"';
        return (
          '<div class="kpi-card' + (clickable ? " kpi-card--clickable" : "") + '" style="border-top-color:' + metricColor + '"' +
            (clickable ? ' data-action="toggle-event-detail" data-value="' + c.metric + '"' : "") + '>' +
            '<div class="kpi-top"><span class="kpi-label">' + esc(c.label) + "</span>" + buildSparkline(vals, { color: metricColor }) + "</div>" +
            '<div class="kpi-value ' + (c.cls || "") + '"' + valueStyle + '>' + c.value + "</div>" +
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

  // Aligne le bas de la table "Historique journalier" sur le bas de la colonne
  // Metiers en plafonnant sa hauteur (scroll interne) a celle de cette colonne.
  // Sans effet en dessous de 900px : .bi-columns repasse en une seule colonne
  // empilee (cf. style.css), la table doit alors garder sa hauteur naturelle.
  function syncHistoryTableHeight() {
    var stacked = window.matchMedia("(max-width:900px)").matches;
    document.querySelectorAll(".bi-columns .bi-col--wide .dash-table-wrap").forEach(function (wrap) {
      var columns = wrap.closest(".bi-columns");
      var profCol = columns && columns.querySelector(".bi-col:not(.bi-col--wide)");
      if (stacked || !profCol || !profCol.textContent.trim()) { wrap.style.maxHeight = ""; return; }
      // Ecart possible entre les deux colonnes avant leur contenu principal
      // (ex. filtre "Metiers" sous son titre, absent au-dessus de la table) :
      // on aligne les BAS des deux colonnes, pas seulement leurs hauteurs.
      wrap.style.maxHeight = "";
      var target = profCol.getBoundingClientRect().bottom - wrap.getBoundingClientRect().top;
      wrap.style.maxHeight = Math.max(120, Math.round(target)) + "px";
    });
  }
  var syncHistoryResizeTimer = null;
  window.addEventListener("resize", function () {
    clearTimeout(syncHistoryResizeTimer);
    syncHistoryResizeTimer = setTimeout(syncHistoryTableHeight, 150);
  });

  // ==========================================================================
  // DETAIL PAR EVENEMENT (clic sur une carte KPI) : liste chronologique des
  // evenements individuels d'une metrique, miroir de Stats/UI.lua
  // BuildEventListDetail cote addon. Les 8 cartes ont desormais toutes un
  // journal d'evenements.
  // ==========================================================================
  // Demande utilisateur (2026-09-17) : toujours les 10 evenements les plus
  // recents, quelle que soit la carte - avant, jusqu'a 300 lignes rendaient
  // le detail illisible sur les metriques a volume eleve (Temps joue, Or).
  var EVENT_LOG_MAX_ROWS = 10;
  var EVENT_METRIC_LABELS = { quests: "Quetes", dungeons: "Donjons & M+", raids: "Raids", delves: "Gouffres",
                               repGained: "Reputation gagnee", gold: "Or", played: "Temps joue", profGained: "Points de metier gagnes" };
  // Traduction des valeurs BRUTES stockees par Core.lua (source de l'or,
  // activite de temps joue) vers un libelle affiche.
  var GOLD_SOURCE_LABELS = { quest: "Quete", vendor: "Marchand", ah: "Hotel des ventes", other: "Autre" };
  var PLAYTIME_ACTIVITY_LABELS = { dungeon: "Donjon", raid: "Raid", delve: "Gouffre", world: "Monde" };
  var EVENT_LOG_COLS = {
    quests: [
      { label: "Quete", get: function (e) { return e.quest; } },
      { label: "Zone", get: function (e) { return e.zone; } },
      { label: "XP", get: function (e) { return e.xp; }, num: true },
    ],
    dungeons: [
      // mplus utilise "map", dungeonLog (donjons normaux) utilise "name".
      { label: "Nom", get: function (e) { return e.map || e.name; } },
      { label: "Niveau", get: function (e) { return e.level; }, num: true },
      { label: "Spe", get: function (e) { return e.spec; } },
      // time est en secondes (M+ converti depuis les millisecondes Blizzard,
      // donjon normal = duree brute entree/sortie d'instance - cf. Core.lua).
      { label: "Temps", get: function (e) { return e.time; }, num: true, duration: true },
    ],
    raids: [
      { label: "Nom", get: function (e) { return e.name; } },
      { label: "Spe", get: function (e) { return e.spec; } },
      { label: "Boss tues", get: function (e) { return e.bossKills; }, num: true },
      { label: "Temps", get: function (e) { return e.time; }, num: true, duration: true },
    ],
    delves: [
      { label: "Nom", get: function (e) { return e.name; } },
      { label: "Palier", get: function (e) { return e.tier; }, num: true },
    ],
    repGained: [
      { label: "Faction", get: function (e) { return e.faction; } },
      { label: "Nb", get: function (e) { return e.count; }, num: true },
      { label: "Gain", get: function (e) { return e.amount; }, num: true },
    ],
    gold: [
      { label: "Source", get: function (e) { return GOLD_SOURCE_LABELS[e.source] || e.source; } },
      { label: "Nb", get: function (e) { return e.count; }, num: true },
      { label: "Montant", get: function (e) { return e.amount; }, num: true, gold: true },
    ],
    played: [
      { label: "Activite", get: function (e) { return PLAYTIME_ACTIVITY_LABELS[e.activity] || e.activity; } },
      { label: "Nb", get: function (e) { return e.count; }, num: true },
      { label: "Temps", get: function (e) { return e.time; }, num: true, duration: true },
    ],
    profGained: [
      { label: "Metier", get: function (e) { return e.profession; } },
      { label: "Nb", get: function (e) { return e.count; }, num: true },
      { label: "Gain", get: function (e) { return e.amount; }, num: true },
    ],
  };

  // Metriques regroupees par jour+dimension avant affichage (cf.
  // groupEventRows) - toutes celles dont chaque evenement se resume a
  // {dimension, montant/duree} sans autre colonne distinctive a preserver
  // (contrairement a quetes/donjons/raids/gouffres : niveau/spe/duree/palier
  // par evenement). Meme principe et memes cles que Stats/UI.lua
  // (GROUPED_METRICS/GroupEventRows) - ces journaux peuvent accumuler des
  // dizaines de micro-evenements par jour (chaque tick de reputation, chaque
  // petit gain d'or, chaque segment "Monde" recoupe par un /reload),
  // illisibles un par un (constat utilisateur, capture d'ecran en jeu du
  // 2026-09-14).
  var GROUPED_METRICS = { gold: "source", played: "activity", repGained: "faction", profGained: "profession" };

  function eventDayKey(ts) {
    if (!ts) return "?";
    var d = new Date(ts * 1000);
    return d.getFullYear() + "-" + d.getMonth() + "-" + d.getDate();
  }

  // Regroupe une liste d'evenements par jour + valeur de dimKey en une seule
  // entree par groupe : count + somme de amount/time. ts retenu = le plus
  // recent du groupe (sert uniquement au tri/affichage de la colonne Date).
  function groupEventRows(rows, dimKey) {
    var order = [], byKey = {};
    rows.forEach(function (row) {
      var gKey = eventDayKey(row.ts) + "" + row[dimKey];
      var g = byKey[gKey];
      if (!g) {
        g = {}; g[dimKey] = row[dimKey]; g.ts = row.ts; g.count = 0; g.amount = 0; g.time = 0;
        byKey[gKey] = g;
        order.push(g);
      }
      g.count += 1;
      g.amount += row.amount || 0;
      g.time += row.time || 0;
      if (row.ts && row.ts > (g.ts || 0)) g.ts = row.ts;
    });
    return order;
  }

  // Aplatit les journaux d'evenements de plusieurs jours (fenetre win) en une
  // seule liste triee par ts decroissant - meme fusion mplus+dungeonLog que
  // cote Lua (SX.Aggregate) pour la carte "Donjons & M+".
  function flattenEventLog(days, win, metricKey) {
    var scoped = sliceDays(days, win.from, win.to);
    var rows = [];
    Object.keys(scoped).forEach(function (k) {
      var d = scoped[k] || {};
      if (metricKey === "quests") {
        (d.questLog || []).forEach(function (e) { rows.push(e); });
      } else if (metricKey === "dungeons") {
        (d.mplus || []).forEach(function (e) { rows.push(e); });
        (d.dungeonLog || []).forEach(function (e) { rows.push(e); });
      } else if (metricKey === "raids") {
        (d.raidLog || []).forEach(function (e) { rows.push(e); });
      } else if (metricKey === "delves") {
        (d.delveLog || []).forEach(function (e) { rows.push(e); });
      } else if (metricKey === "repGained") {
        (d.repLog || []).forEach(function (e) { rows.push(e); });
      } else if (metricKey === "gold") {
        (d.goldLog || []).forEach(function (e) { rows.push(e); });
      } else if (metricKey === "played") {
        (d.playtimeLog || []).forEach(function (e) { rows.push(e); });
      } else if (metricKey === "profGained") {
        (d.profLog || []).forEach(function (e) { rows.push(e); });
      }
    });
    if (GROUPED_METRICS[metricKey]) rows = groupEventRows(rows, GROUPED_METRICS[metricKey]);
    rows.sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
    return rows;
  }

  function renderEventLogTable(profile, metricKey, win, sort) {
    sort = sort || { key: "date", dir: "desc" };
    var cols = EVENT_LOG_COLS[metricKey];
    if (!cols) return "";
    var allRows = flattenEventLog(profile.days, win, metricKey);
    if (allRows.length === 0) {
      return '<p class="dash-empty">Aucun evenement enregistre sur cette periode.</p>';
    }
    var rows = allRows.slice(0, EVENT_LOG_MAX_ROWS);

    var sorters = { date: function (r) { return r.ts || 0; } };
    cols.forEach(function (c, i) {
      sorters["c" + i] = function (r) { var v = c.get(r); return c.num ? (v || 0) : String(v || ""); };
    });
    var sf = sorters[sort.key] || sorters.date;
    rows.sort(function (a, b) {
      var va = sf(a), vb = sf(b);
      var cmp = va < vb ? -1 : va > vb ? 1 : 0;
      return cmp * (sort.dir === "asc" ? 1 : -1);
    });

    var headCols = [{ key: "date", label: "Date" }].concat(cols.map(function (c, i) { return { key: "c" + i, label: c.label }; }));
    var head = headCols.map(function (c) {
      var active = sort.key === c.key;
      var arrow = active ? (sort.dir === "asc" ? " &#9650;" : " &#9660;") : "";
      return '<th><button type="button" class="dash-sort-btn" data-action="sort-events" data-key="' + c.key + '" aria-sort="' + (active ? (sort.dir === "asc" ? "ascending" : "descending") : "none") + '">' + c.label + arrow + "</button></th>";
    }).join("");
    var body = rows.map(function (r) {
      var tds = cols.map(function (c) {
        var v = c.get(r);
        var text = c.duration ? fmtDuration(v)
          : c.gold ? fmtGold(v || 0)
          : (v == null || v === "") ? "-" : (c.num ? fmtNum(Math.round(v)) : esc(String(v)));
        return "<td" + (c.num ? ' class="num"' : "") + ">" + text + "</td>";
      }).join("");
      return "<tr><td>" + esc(fmtEventTime(r.ts)) + "</td>" + tds + "</tr>";
    }).join("");
    return (
      '<div class="dash-table-wrap"><table class="dash-table"><thead><tr>' + head + "</tr></thead><tbody>" + body + "</tbody></table></div>" +
      '<p class="dash-note">' + allRows.length + " evenement" + (allRows.length > 1 ? "s" : "") + " sur la periode selectionnee" +
      (allRows.length > EVENT_LOG_MAX_ROWS ? " (affichage limite aux " + EVENT_LOG_MAX_ROWS + " plus recents)" : "") +
      ". Clique un en-tete pour trier.</p>"
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
    names.sort(function (a, b) { return expIndexOf(b) - expIndexOf(a); });
    return names;
  }

  function professionFilterHtml(expansions, active) {
    active = active || "overall";
    var opts = [{ key: "overall", label: "Total" }].concat(
      expansions.map(function (e) { return { key: e, label: e }; })
    );
    return (
      '<select class="compare-select bi-prof-filter" data-action="prof-filter" aria-label="Extension (metiers)">' +
      opts.map(function (o) {
        return '<option value="' + esc(o.key) + '"' + (active === o.key ? " selected" : "") + ">" + esc(o.label) + "</option>";
      }).join("") + "</select>"
    );
  }

  // Icones de metier (jeu "ui_profession_*" introduit avec la refonte
  // Dragonflight, confirme present sur Wowhead pour l'ensemble des metiers
  // standards) - mappees par nom FR normalise (sans accents/casse) puisque
  // l'addon exporte le nom localise, pas un identifiant stable. Metier
  // absent de la table (secondaire rare, nom inattendu) -> pas d'icone,
  // le nom texte suffit toujours.
  var PROFESSION_ICONS = {
    alchimie: "ui_profession_alchemy",
    forge: "ui_profession_blacksmithing",
    enchantement: "ui_profession_enchanting",
    ingenierie: "ui_profession_engineering",
    herboristerie: "ui_profession_herbalism",
    joaillerie: "ui_profession_jewelcrafting",
    "travail du cuir": "ui_profession_leatherworking",
    minage: "ui_profession_mining",
    couture: "ui_profession_tailoring",
    depecage: "ui_profession_skinning",
    cuisine: "ui_profession_cooking",
    peche: "ui_profession_fishing",
    inscription: "ui_profession_inscription",
  };

  function professionIconUrl(name) {
    var key = String(name || "")
      .toLowerCase()
      .normalize("NFD").split("").filter(function (ch) {
        var code = ch.charCodeAt(0);
        return !(code >= 0x0300 && code <= 0x036f);
      }).join("")
      .trim();
    var slug = PROFESSION_ICONS[key];
    return slug ? "https://wow.zamimg.com/images/wow/icons/medium/" + slug + ".jpg" : null;
  }

  // filterExp absent/"overall" -> prof.base (total agrege toutes extensions,
  // comportement d'origine). Une extension precise -> somme des lignes de
  // prof.lines dont le .exp correspond ; un metier absent de cette extension
  // pour ce personnage est simplement omis (pas de faux "0/0").
  // Tri/regroupement : metiers en cours d'abord (du moins au plus avance,
  // ce qui merite le plus d'attention en tete), puis les metiers a 100%
  // regroupes a part sous un sous-titre - retour utilisateur : le melange
  // sans ordre n'etait pas lisible.
  function renderProfessions(professions, filterExp) {
    var entries = [];
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
      entries.push({ name: prof.name, cur: cur, max: max, pct: pct });
    });
    if (entries.length === 0) {
      return '<p class="dash-empty">Aucun metier suivi sur cette extension pour ce personnage.</p>';
    }

    function cardHtml(e) {
      var icon = professionIconUrl(e.name);
      var iconHtml = icon ? '<img class="prof-icon" src="' + icon + '" alt="" loading="lazy">' : "";
      return (
        '<div class="prof-card">' +
          '<div class="prof-head">' + iconHtml + '<span class="prof-name">' + esc(e.name) + "</span>" +
          (e.pct != null ? '<span class="prof-pct">' + e.pct + "%</span>" : "") + "</div>" +
          (e.pct != null
            ? '<div class="prof-bar"><span style="width:' + e.pct + '%"></span></div><div class="prof-nums">' + fmtNum(e.cur) + " / " + fmtNum(e.max) + "</div>"
            : '<div class="dash-note" style="margin-top:6px">Pas de progression suivie.</div>') +
        "</div>"
      );
    }

    var inProgress = entries.filter(function (e) { return e.pct == null || e.pct < 100; })
      .sort(function (a, b) { return (a.pct == null ? -1 : a.pct) - (b.pct == null ? -1 : b.pct); });
    var completed = entries.filter(function (e) { return e.pct === 100; });

    var html = "";
    if (inProgress.length) html += '<div class="prof-grid">' + inProgress.map(cardHtml).join("") + "</div>";
    if (completed.length) {
      html += '<div class="prof-section-title">Termines (' + completed.length + ")</div>";
      html += '<div class="prof-grid">' + completed.map(cardHtml).join("") + "</div>";
    }
    return html;
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
      { label: "Raids", a: fmtNum(tA.raids), b: fmtNum(tB.raids), win: tA.raids === tB.raids ? null : (tA.raids > tB.raids ? "a" : "b") },
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
    var opts = [["1", "Jour"], ["7", "7 jours"], ["30", "30 jours"], ["90", "90 jours"], ["all", "Tout"]];
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

  var GRANULARITY_OPTS = [["day", "Jour"], ["week", "Semaine"], ["month", "Mois"], ["year", "Annee"]];
  function granularitySelectorHtml(granularity, action) {
    action = action || "granularity";
    return (
      '<div class="filter-buttons bi-granularity" role="group" aria-label="Granularite du graphique">' +
      GRANULARITY_OPTS.map(function (o) {
        return '<button type="button" class="filter-btn' + (granularity === o[0] ? " active" : "") + '" data-action="' + action + '" data-value="' + o[0] + '" aria-pressed="' + (granularity === o[0]) + '">' + o[1] + "</button>";
      }).join("") + "</div>"
    );
  }

  function overlayToggleHtml(active) {
    return (
      '<button type="button" class="btn ghost small bi-overlay-toggle' + (active ? " active" : "") + '" data-action="overlay" aria-pressed="' + active + '">' +
      (active ? "Revenir a une seule metrique" : "Superposer toutes les metriques") + "</button>"
    );
  }

  // Legende cliquable des graphiques superposes (Evolution en mode overlay,
  // PVP dans le temps) : chaque metrique se cache/montre individuellement -
  // trop de courbes superposees reste illisible quelle que soit la
  // granularite, laisser choisir lesquelles afficher regle le probleme a
  // la racine plutot que d'ajuster le rendu davantage.
  function metricLegendToggleHtml(metricOrder, colorsMap, stateTable, action) {
    return (
      '<div class="filter-buttons bi-legend-toggle" role="group" aria-label="Courbes affichees">' +
      metricOrder.map(function (key) {
        var enabled = stateTable[key] !== false;
        var color = colorsMap[key] || "#e4b64a";
        return '<button type="button" class="filter-btn bi-legend-btn' + (enabled ? " on" : "") + '" data-action="' + action + '" data-value="' + key + '" aria-pressed="' + enabled + '">' +
          '<i style="background:' + (enabled ? color : "var(--muted)") + '"></i>' + esc(METRICS[key].label) + "</button>";
      }).join("") + "</div>"
    );
  }

  function filterEnabledMetrics(metricOrder, stateTable) {
    return metricOrder.filter(function (key) { return stateTable[key] !== false; });
  }

  function profileChipsHtml(profiles, activeId, fixed) {
    if (profiles.length <= 1 && fixed) return "";
    // Bouton "Compte" au debut des chips de personnages, separe par un trait
    // dore (demande utilisateur, libelle harmonise avec le charKey
    // "__account__"/"Compte (tous personnages)" du module Stats en jeu) :
    // n'a de sens qu'a partir de 2 personnages charges, sinon ce serait un
    // doublon strict du seul personnage disponible.
    var accountBtn = profiles.length >= 2
      ? '<button type="button" class="addon-chip bi-account-chip' + (activeId === ALL_PROFILES_ID ? " active" : "") + '" data-action="select-account" aria-pressed="' + (activeId === ALL_PROFILES_ID) + '" title="Additionne les statistiques de tous les personnages charges">Compte</button>' +
        '<span class="bi-chip-sep" aria-hidden="true">|</span>'
      : "";
    return (
      '<div class="addon-chips bi-profiles" role="group" aria-label="Personnages">' +
      accountBtn +
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
      granularity: "day",
      overlay: false,
      pvpGranularity: "day",
      // Legende cliquable des graphiques superposes : cle metrique -> false
      // = courbe cachee (absent/true = visible). Trop de metriques
      // superposees reste illisible quelle que soit la granularite -
      // laisser choisir lesquelles afficher regle le probleme a la racine.
      overlayEnabledMetrics: {},
      pvpEnabledMetrics: {},
      sort: { key: "date", dir: "desc" },
      profFilter: "overall",
      // Detail par evenement (clic sur une carte KPI) : eventMetric = cle de
      // la carte ouverte (null = aucune). eventSort separe de `sort`
      // ci-dessus (qui pilote la table "Historique journalier") pour que les
      // deux tris n'interferent pas l'un avec l'autre.
      eventMetric: null,
      eventSort: { key: "date", dir: "desc" },
      // Sections repliables (PVP/Gouffres+Tourments/Reputations) - meme
      // principe que l'addon Stats (UI.lua, view.summaryExpanded) : repliees
      // par defaut, cliquer sur la tuile deplie son detail complet.
      summaryExpanded: {},
    };
    if (state.profiles.length) state.activeId = state.profiles[0].id;

    function getActive() {
      if (state.activeId === ALL_PROFILES_ID) return buildAccountProfile(state.profiles);
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
          (active.generatedAt ? ' &middot; export genere le ' + esc(fmtGeneratedAt(active.generatedAt)) : "") + "</p>"
        : "";

      var kpis = renderKpis(active, win);
      var enabledEvolutionMetrics = filterEnabledMetrics(METRIC_ORDER, state.overlayEnabledMetrics);
      var chart = state.overlay
        ? buildLineChart(
            overlaySeriesForProfile(active, state.granularity, win.from, win.to, enabledEvolutionMetrics),
            { ariaLabel: "Evolution de toutes les metriques pour " + active.char.name, fmtY: function (v) { return Math.round(v) + "%"; }, noArea: true, uid: uid }
          )
        : buildLineChart(
            [{ id: active.id, label: active.char.name, color: classColor(active.char.class), points: bucketSeries(seriesForProfile(active, state.metric, win.from, win.to), state.granularity) }],
            { ariaLabel: "Evolution de " + METRICS[state.metric].label + " pour " + active.char.name, fmtY: METRICS[state.metric].fmtY, fmt: METRICS[state.metric].fmt, uid: uid }
          );
      var enabledPvpMetrics = filterEnabledMetrics(PVP_METRIC_ORDER, state.pvpEnabledMetrics);
      var pvpChart = buildLineChart(
        overlaySeriesForProfile(active, state.pvpGranularity, win.from, win.to, enabledPvpMetrics),
        { ariaLabel: "PVP dans le temps pour " + active.char.name, fmtY: function (v) { return Math.round(v) + "%"; }, noArea: true, uid: uid + 1000 }
      );

      var html = "";
      html += toolbar;
      html += renderCharBanner(active.char);
      if (active.checksumOk === false) {
        html += '<p class="dash-warning">Ce code semble incomplet ou modifie (somme de controle differente). L\'affichage ci-dessous peut etre partiel.</p>';
      }
      html += period;
      html += kpis;
      if (state.eventMetric && EVENT_LOG_COLS[state.eventMetric]) {
        var evLabel = EVENT_METRIC_LABELS[state.eventMetric] || state.eventMetric;
        // Meme couleur que la carte d'origine (OVERLAY_COLORS) au lieu du
        // gris/or generique - demande utilisateur du 2026-09-13, meme
        // principe que le fix cote addon (BuildDetail/BuildEventListDetail).
        var evColor = OVERLAY_COLORS[state.eventMetric] || "#e4b64a";
        html += '<div class="bi-chart-card" style="border-top-color:' + evColor + '"><div class="bi-chart-head"><h3 class="dash-subtitle" style="margin:0;color:' + evColor + '">Detail : ' + esc(evLabel) + '</h3></div>' +
          renderEventLogTable(active, state.eventMetric, win, state.eventSort) + "</div>";
      }
      html += renderSummaryTiles(active.char, state.summaryExpanded);
      // Detail rendu seulement si sa tuile est depliee (cf. tileHtml,
      // action "toggle-summary") - repond a la meme demande que l'addon :
      // tuile qui "ne fait rien" et detail toujours affiche en double
      // dessous. Metiers (renderProfessionDetail) reste toujours affiche :
      // pas une tuile de renderSummaryTiles, hors perimetre de cet
      // alignement (demande explicite : "aligne aussi LES TUILES").
      if (state.summaryExpanded.pvp) html += renderPvpDetail(active.char);
      if (state.summaryExpanded.delves) { html += renderDelveDetail(active.char); html += renderTorghastDungeonDetail(active.char); }
      if (state.summaryExpanded.reputations) html += renderReputationDetail(active.char);
      html += renderProfessionDetail(active.char);
      html += '<div class="bi-chart-card"><div class="bi-chart-head"><h3 class="dash-subtitle" style="margin:0">Evolution</h3>' +
        (state.overlay ? "" : metricSelectorHtml(state.metric)) + "</div>" +
        '<div class="bi-chart-subhead">' + granularitySelectorHtml(state.granularity) + overlayToggleHtml(state.overlay) + "</div>" + chart.html +
        (state.overlay
          ? '<p class="dash-note bi-legend-hint">Clique sur une metrique pour l\'afficher/la masquer</p>' + metricLegendToggleHtml(METRIC_ORDER, OVERLAY_COLORS, state.overlayEnabledMetrics, "toggle-overlay-metric")
          : "") + "</div>";
      html += '<div class="bi-chart-card"><div class="bi-chart-head"><h3 class="dash-subtitle" style="margin:0">PVP dans le temps</h3></div>' +
        '<div class="bi-chart-subhead">' + granularitySelectorHtml(state.pvpGranularity, "pvp-granularity") + "</div>" + pvpChart.html +
        '<p class="dash-note bi-legend-hint">Clique sur une metrique pour l\'afficher/la masquer</p>' +
        metricLegendToggleHtml(PVP_METRIC_ORDER, OVERLAY_COLORS, state.pvpEnabledMetrics, "toggle-pvp-metric") + "</div>";
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
      attachChartInteractivity([chart, pvpChart]);
      syncHistoryTableHeight();
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
            var val = row.fmt ? row.fmt(row.actual) : entry.fmt(row.v);
            return '<div class="chart-tooltip-row"><i style="background:' + row.color + '"></i>' + esc(row.label) + ": <strong>" + esc(val) + "</strong></div>";
          }).join("");
          tooltip.innerHTML = '<div class="chart-tooltip-date">' + esc(nearest.dateLabel || fmtDateLong(epochDayToIso(nearest.ed))) + "</div>" + rows;
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
      else if (action === "granularity") { state.granularity = el.dataset.value; render(); }
      else if (action === "pvp-granularity") { state.pvpGranularity = el.dataset.value; render(); }
      else if (action === "toggle-overlay-metric") {
        var k1 = el.dataset.value;
        state.overlayEnabledMetrics[k1] = (state.overlayEnabledMetrics[k1] === false) ? true : false;
        render();
      }
      else if (action === "toggle-pvp-metric") {
        var k2 = el.dataset.value;
        state.pvpEnabledMetrics[k2] = (state.pvpEnabledMetrics[k2] === false) ? true : false;
        render();
      }
      else if (action === "overlay") { state.overlay = !state.overlay; render(); }
      else if (action === "select-profile") { state.activeId = el.dataset.id; render(); }
      else if (action === "select-account") { state.activeId = ALL_PROFILES_ID; render(); }
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
      else if (action === "toggle-event-detail") {
        var evMetric = el.dataset.value;
        state.eventMetric = (state.eventMetric === evMetric) ? null : evMetric;
        render();
      }
      else if (action === "toggle-summary") {
        var sKey = el.dataset.value;
        state.summaryExpanded[sKey] = !state.summaryExpanded[sKey];
        render();
      }
      else if (action === "sort-events") {
        var evKey = el.dataset.key;
        if (state.eventSort.key === evKey) state.eventSort.dir = state.eventSort.dir === "asc" ? "desc" : "asc";
        else state.eventSort = { key: evKey, dir: "desc" };
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
      var pick = e.target.closest('[data-action="compare-pick"]');
      if (pick) {
        var slot = Number(pick.dataset.slot);
        state.compareIds[slot] = pick.value;
        render();
        return;
      }
      var profFilter = e.target.closest('[data-action="prof-filter"]');
      if (profFilter) { state.profFilter = profFilter.value; render(); }
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
