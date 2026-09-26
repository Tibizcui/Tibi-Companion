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
    var out = { quests: 0, worldQuests: 0, goldGain: 0, goldSpent: 0, played: 0, dungeons: 0, mplusCount: 0, raids: 0, delves: 0, repGained: 0, pvpKillsGained: 0, profGained: 0,
      bgPlayedGained: 0, bgWonGained: 0, arenaPlayedGained: 0, arenaWonGained: 0, dayCount: 0, activeDayCount: 0 };
    if (!days) return out;
    Object.keys(days).forEach(function (k) {
      var d = days[k] || {};
      out.quests += d.quests || 0;
      out.worldQuests += d.worldQuests || 0;
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
    worldQuests: { label: "Expeditions", get: function (d) { return d.worldQuests || 0; }, fmt: fmtNum, fmtY: fmtNum },
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
  var METRIC_ORDER = ["played", "quests", "worldQuests", "gold", "dungeons", "raids", "delves", "repGained", "profGained"];

  // Graphique PVP dedie : toujours superpose (pas de mode une-seule-metrique,
  // 5 courbes restent lisibles).
  var PVP_METRIC_ORDER = ["pvpKillsGained", "bgPlayedGained", "bgWonGained", "arenaPlayedGained", "arenaWonGained"];

  // Couleurs fixes pour la superposition multi-metriques (Evolution ET
  // graphique PVP) - une couleur distincte par metrique, choisies pour
  // rester lisibles sur le fond graphite. Memes teintes que l'addon Stats
  // (UI.lua, OVERLAY_COLORS / PVP_OVERLAY_COLORS).
  var OVERLAY_COLORS = {
    quests: "#4fd1c5", gold: "#f4d68a", played: "#7c9eff", dungeons: "#ff8a8a", raids: "#e0975c",
    delves: "#b389f4", repGained: "#6ee7b7", profGained: "#ffb454", worldQuests: "#a3e635",
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
        // Pas de niveau (ex. profil virtuel "Compte") : rien plutot qu'un "[?]".
        (char.level != null ? '<span class="dash-banner-level">[' + esc(char.level) + "]</span> " : "") +
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
    // Journal des parties (d.pvpLog) : ouvre la meme liste d'evenements que
    // les cartes KPI, affichee en haut du tableau de bord.
    var matchesBtn = '<p style="margin:0 0 16px"><button type="button" class="btn ghost" style="padding:6px 14px;font-size:13px" data-action="toggle-event-detail" data-value="pvpMatches">Journal des parties</button></p>';

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

    return statsDetailWrap(SUMMARY_SECTION_COLORS.pvp, "PVP", summaryLine + matchesBtn + bracketTable + bgTable);
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

  // Memes icones que les cartes de l'addon Stats (CARD_ICONS, Stats/UI.lua),
  // servies par le meme CDN que l'icone des hauts faits et des metiers. Les
  // quetes utilisent la texture "Interface\GossipFrame\AvailableQuestIcon"
  // (le "!" dore) qui n'existe pas comme icone de CDN : redessinee en SVG.
  var KPI_ICONS = {
    played: "inv_misc_pocketwatch_01", gold: "inv_misc_coin_01", dungeons: "inv_misc_map_01",
    raids: "inv_misc_head_dragon_01", delves: "inv_misc_gem_01",
    repGained: "achievement_reputation_01", profGained: "inv_misc_wrench_01",
    worldQuests: "inv_misc_spyglass_03",
  };
  function kpiIconHtml(metric) {
    if (metric === "quests") {
      return '<svg class="kpi-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M6.4 1.5h3.2l-.7 8.2H7.1zM8 11.3a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z" fill="#ffd100"/></svg>';
    }
    return KPI_ICONS[metric]
      ? '<img class="kpi-icon" src="https://wow.zamimg.com/images/wow/icons/medium/' + KPI_ICONS[metric] + '.jpg" alt="" loading="lazy">'
      : "";
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
      { key: "worldQuests", label: "Expeditions", value: fmtNum(t.worldQuests), cur: t.worldQuests, prev: p ? p.worldQuests : null, metric: "worldQuests" },
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
            '<div class="kpi-top"><span class="kpi-title">' + kpiIconHtml(c.metric) + '<span class="kpi-label">' + esc(c.label) + "</span></span>" + buildSparkline(vals, { color: metricColor }) + "</div>" +
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
  var EVENT_METRIC_LABELS = { quests: "Quetes", worldQuests: "Expeditions", dungeons: "Donjons & M+", raids: "Raids", delves: "Gouffres",
                               repGained: "Reputation gagnee", gold: "Or", played: "Temps joue", profGained: "Points de metier gagnes",
                               pvpMatches: "Parties JcJ" };
  // Traduction des valeurs BRUTES stockees par Core.lua (source de l'or,
  // activite de temps joue) vers un libelle affiche.
  var GOLD_SOURCE_LABELS = { quest: "Quete", vendor: "Marchand", ah: "Hotel des ventes", other: "Autre" };
  var PLAYTIME_ACTIVITY_LABELS = { dungeon: "Donjon", raid: "Raid", delve: "Gouffre", world: "Monde" };
  var PVP_KIND_LABELS = { bg: "Champ de bataille", rbg: "CdB cote", blitz: "Blitz", arena: "Arene cotee",
                          skirmish: "Escarmouche", shuffle: "Melee solo", brawl: "Bagarre" };
  // Champ "exp" des journaux (Stats/Core.lua, SX.ExpansionFor*) : numero
  // d'extension Blizzard. Miroir de L["EXP_SHORT_n"] (Stats/Locales/enUS.lua).
  var EXPANSION_SHORT = ["Classic", "Burning Crusade", "Lich King", "Cataclysm", "Pandaria", "Draenor",
                         "Legion", "Battle for Azeroth", "Shadowlands", "Dragonflight", "The War Within", "Midnight"];
  function expansionLabel(n) {
    if (n == null) return null;
    return EXPANSION_SHORT[n] || ("#" + n);
  }
  // Colonne Extension, toujours en dernier. num:true pour trier dans l'ordre
  // chronologique des extensions ; fmt pour afficher le nom et non le numero.
  // Absente (evenement anterieur a l'ajout) = -1 au tri, "-" a l'affichage.
  var EXP_COL = { label: "Extension", get: function (e) { return e.exp; }, num: true, exp: true };
  var EVENT_LOG_COLS = {
    quests: [
      { label: "Quete", get: function (e) { return e.quest; } },
      { label: "Zone", get: function (e) { return e.zone; } },
      { label: "XP", get: function (e) { return e.xp; }, num: true },
      EXP_COL,
    ],
    // Memes entrees que quests : questLog filtre sur e.wq (cf. flattenEventLog
    // et Stats/Core.lua OnQuestTurnedIn).
    worldQuests: [
      { label: "Expedition", get: function (e) { return e.quest; } },
      { label: "Zone", get: function (e) { return e.zone; } },
      { label: "XP", get: function (e) { return e.xp; }, num: true },
      EXP_COL,
    ],
    // Journal JcJ (d.pvpLog, une ligne par partie) - pas de carte KPI, ouvert
    // depuis le detail PVP (bouton "Journal des parties").
    pvpMatches: [
      { label: "Carte", get: function (e) { return e.map; } },
      { label: "Type", get: function (e) { return PVP_KIND_LABELS[e.kind] || e.kind; } },
      { label: "Resultat", get: function (e) { return e.won === true ? 1 : e.won === false ? 0 : null; }, num: true, won: true },
      { label: "Temps", get: function (e) { return e.time; }, num: true, duration: true },
      EXP_COL,
    ],
    dungeons: [
      // mplus utilise "map", dungeonLog (donjons normaux) utilise "name".
      { label: "Nom", get: function (e) { return e.map || e.name; } },
      { label: "Niveau", get: function (e) { return e.level; }, num: true },
      { label: "Spe", get: function (e) { return e.spec; } },
      // time est en secondes (M+ converti depuis les millisecondes Blizzard,
      // donjon normal = duree brute entree/sortie d'instance - cf. Core.lua).
      { label: "Temps", get: function (e) { return e.time; }, num: true, duration: true },
      EXP_COL,
    ],
    raids: [
      { label: "Nom", get: function (e) { return e.name; } },
      { label: "Spe", get: function (e) { return e.spec; } },
      { label: "Boss tues", get: function (e) { return e.bossKills; }, num: true },
      { label: "Temps", get: function (e) { return e.time; }, num: true, duration: true },
      EXP_COL,
    ],
    delves: [
      { label: "Nom", get: function (e) { return e.name; } },
      { label: "Palier", get: function (e) { return e.tier; }, num: true },
      EXP_COL,
    ],
    repGained: [
      { label: "Faction", get: function (e) { return e.faction; } },
      { label: "Nb", get: function (e) { return e.count; }, num: true },
      { label: "Gain", get: function (e) { return e.amount; }, num: true },
      EXP_COL,
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
      EXP_COL,
    ],
  };

  function hasExpColumn(metricKey) {
    return (EVENT_LOG_COLS[metricKey] || []).some(function (c) { return c.exp; });
  }

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
      // exp dans la cle, comme GroupEventRows cote addon (Stats/UI.lua).
      var gKey = eventDayKey(row.ts) + "" + row[dimKey] + "" + row.exp + "" + (row.expEst ? 1 : 0);
      var g = byKey[gKey];
      if (!g) {
        g = {}; g[dimKey] = row[dimKey]; g.ts = row.ts; g.count = 0; g.amount = 0; g.time = 0; g.exp = row.exp; g.expEst = row.expEst;
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
      } else if (metricKey === "worldQuests") {
        (d.questLog || []).forEach(function (e) { if (e.wq) rows.push(e); });
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
      } else if (metricKey === "pvpMatches") {
        (d.pvpLog || []).forEach(function (e) { rows.push(e); });
      }
    });
    if (GROUPED_METRICS[metricKey]) rows = groupEventRows(rows, GROUPED_METRICS[metricKey]);
    rows.sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
    return rows;
  }

  // Filtre par extension de la liste d'evenements : "all", "none" (sans
  // extension connue) ou le numero d'extension en texte (valeur du <select>).
  // Choix = extensions presentes sur la periode, plus le filtre actif meme
  // s'il ne matche plus rien (meme logique que BuildEventListDetail, addon).
  function expFilterHtml(allRows, active) {
    var seen = {}, nums = [], hasNone = false;
    allRows.forEach(function (r) {
      if (r.exp == null) hasNone = true;
      else if (!seen[r.exp]) { seen[r.exp] = true; nums.push(r.exp); }
    });
    if (active !== "all" && active !== "none" && !seen[active]) { seen[active] = true; nums.push(Number(active)); }
    nums.sort(function (a, b) { return a - b; });
    var opts = [{ key: "all", label: "Toutes" }].concat(nums.map(function (n) { return { key: String(n), label: expansionLabel(n) }; }));
    if (hasNone || active === "none") opts.push({ key: "none", label: "Non renseignee" });
    return (
      '<div class="bi-event-filter" style="display:flex;justify-content:flex-end;align-items:center;gap:8px;margin:0 0 10px">' +
      '<span class="kpi-sub" style="margin:0">Extension</span>' +
      '<select class="compare-select" data-action="event-exp-filter" aria-label="Filtrer par extension">' +
      opts.map(function (o) {
        return '<option value="' + esc(o.key) + '"' + (String(active) === o.key ? " selected" : "") + ">" + esc(o.label) + "</option>";
      }).join("") + "</select></div>"
    );
  }

  function renderEventLogTable(profile, metricKey, win, sort, expFilter) {
    sort = sort || { key: "date", dir: "desc" };
    expFilter = expFilter == null ? "all" : String(expFilter);
    var cols = EVENT_LOG_COLS[metricKey];
    if (!cols) return "";
    var allRows = flattenEventLog(profile.days, win, metricKey);
    var filterHtml = "";
    if (hasExpColumn(metricKey)) {
      filterHtml = expFilterHtml(allRows, expFilter);
      if (expFilter !== "all") {
        allRows = allRows.filter(function (r) {
          return expFilter === "none" ? r.exp == null : (r.exp != null && String(r.exp) === expFilter);
        });
      }
    }
    if (allRows.length === 0) {
      return filterHtml + '<p class="dash-empty">Aucun evenement enregistre sur cette periode.</p>';
    }
    var rows = allRows.slice(0, EVENT_LOG_MAX_ROWS);

    var sorters = { date: function (r) { return r.ts || 0; } };
    cols.forEach(function (c, i) {
      sorters["c" + i] = function (r) {
        var v = c.get(r);
        if (c.exp || c.won) return v == null ? -1 : v;
        return c.num ? (v || 0) : String(v || "");
      };
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
        var text = c.exp ? (v == null ? "-" : (r.expEst ? '<span class="dash-exp-est" title="Extension estimee a partir de la zone (anciens evenements)">≈</span> ' : "") + esc(expansionLabel(v)))
          : c.won ? (v === 1 ? '<span style="color:#6ee7b7">Victoire</span>' : v === 0 ? '<span style="color:#ff6b6b">Defaite</span>' : "-")
          : c.duration ? fmtDuration(v)
          : c.gold ? fmtGold(v || 0)
          : (v == null || v === "") ? "-" : (c.num ? fmtNum(Math.round(v)) : esc(String(v)));
        var alignRight = c.num && !c.exp && !c.won;
        return "<td" + (alignRight ? ' class="num"' : "") + ">" + text + "</td>";
      }).join("");
      return "<tr><td>" + esc(fmtEventTime(r.ts)) + "</td>" + tds + "</tr>";
    }).join("");
    return (
      filterHtml +
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
  // REPARTITION PAR PERSONNAGE (vue "Compte" uniquement)
  // ----------------------------------------------------------------
  // buildAccountProfile vide volontairement `professions` pour le profil
  // virtuel "Compte" (pas de metier "sommable" entre personnages, voir sa
  // note) : la colonne de gauche, a cote de l'historique journalier, restait
  // donc vide des que "Compte" est actif. On y affiche a la place la
  // contribution de chaque personnage sur la periode selectionnee (temps
  // joue, quetes, or net) - la seule chose que la vue "Compte" peut montrer
  // que la vue par personnage ne montre pas.
  function renderAccountBreakdown(profiles, win) {
    var rows = (profiles || []).map(function (p) {
      var t = sumDays(sliceDays(p.days, win.from, win.to));
      return { name: p.char.name, color: classColor(p.char.class), played: t.played || 0, quests: t.quests || 0, net: (t.goldGain || 0) - (t.goldSpent || 0) };
    }).filter(function (r) { return r.played > 0 || r.quests > 0 || r.net !== 0; });
    if (rows.length === 0) {
      return '<p class="dash-empty">Aucune activite sur cette periode.</p>';
    }
    rows.sort(function (a, b) { return b.played - a.played; });
    var maxPlayed = Math.max.apply(null, rows.map(function (r) { return r.played; })) || 1;
    return '<div class="acct-grid">' + rows.map(function (r) {
      var pct = Math.max(2, Math.round((r.played / maxPlayed) * 100));
      return (
        '<div class="acct-card">' +
          '<div class="acct-head"><i class="bi-chip-dot" style="background:' + r.color + '"></i><span class="prof-name">' + esc(r.name) + "</span></div>" +
          '<div class="prof-bar"><span style="width:' + pct + "%;background:linear-gradient(90deg," + r.color + "," + r.color + "80)\"></span></div>" +
          '<div class="acct-nums"><span>' + fmtHours(r.played) + '</span><span>' + fmtNum(r.quests) + " quete" + (r.quests === 1 ? "" : "s") + '</span><span class="' +
          (r.net >= 0 ? "pos" : "neg") + '">' + fmtGold(r.net) + "</span></div>" +
        "</div>"
      );
    }).join("") + "</div>";
  }

  // ==========================================================================
  // CETTE SEMAINE (WeeklyCompass)
  // ==========================================================================
  // Miroir de WeeklyCompass : chaque personnage exporte `weekly` =
  // { resetAt, lastSeen, entries: [{key,label,short,category,order,status,
  // current,max,ilvl,detail}] } (Stats/Export.lua, collectWeekly). resetAt est
  // l'horodatage serveur du PROCHAIN reset : une fois depasse, les compteurs
  // appartiennent a une semaine terminee et sont affiches grises, jamais
  // presentes comme actuels. Champ absent = WeeklyCompass pas installe.
  var WEEKLY_CATEGORY_ORDER = { vault: 10, lairs: 20, delves: 30, hunt: 40, misc: 90 };
  var WEEKLY_STATUS = {
    done:        { label: "Fait",     color: "#6bba7a" },
    in_progress: { label: "En cours", color: "#deb052" },
    not_started: { label: "A faire",  color: "#d1706a" },
    unknown:     { label: "Inconnu",  color: "#8c8c94" },
  };
  var WEEKLY_ACCENT = "#0affbe";  // turquoise de WeeklyCompass (UI/Dashboard.lua)

  function weeklyIsStale(weekly) {
    return !!(weekly && weekly.resetAt && Date.now() / 1000 >= weekly.resetAt);
  }

  function weeklyCellText(e) {
    if (!e) return "-";
    if (e.status === "unknown") return "?";
    if (e.max != null) return fmtNum(e.current || 0) + "/" + fmtNum(e.max);
    return e.detail != null ? String(e.detail) : (WEEKLY_STATUS[e.status] || WEEKLY_STATUS.unknown).label;
  }

  function weeklyCell(e, stale) {
    var st = WEEKLY_STATUS[(e && e.status) || "unknown"] || WEEKLY_STATUS.unknown;
    var color = (!e || stale) ? "var(--muted)" : st.color;
    var title = e ? (e.label || "") + " : " + st.label + (e.ilvl ? " (ilvl " + e.ilvl + ")" : "") : "";
    return '<td class="wk-cell" style="color:' + color + '" title="' + esc(title) + '">' + esc(weeklyCellText(e)) + "</td>";
  }

  // Colonnes = union ordonnee des entrees de tous les personnages, meme regle
  // de tri que l'addon (categorie, puis ordre, puis cle).
  // L'en-tete vient du personnage vu le plus recemment (lastSeen) : un reroll
  // pas reconnecte garde un ancien libelle (ex. "Mythique+" devenu "Donjons").
  function weeklyColumns(profiles) {
    var cols = [], byKey = {};
    profiles.forEach(function (p) {
      var seenAt = (p.weekly && p.weekly.lastSeen) || 0;
      ((p.weekly && p.weekly.entries) || []).forEach(function (e) {
        var col = byKey[e.key];
        if (!col) {
          col = byKey[e.key] = { key: e.key, header: e.short || e.label || e.key, category: e.category, order: e.order || 100, seenAt: seenAt };
          cols.push(col);
        } else if (seenAt > col.seenAt) {
          col.header = e.short || e.label || e.key;
          col.seenAt = seenAt;
        }
      });
    });
    cols.sort(function (a, b) {
      var ca = WEEKLY_CATEGORY_ORDER[a.category] || 100, cb = WEEKLY_CATEGORY_ORDER[b.category] || 100;
      if (ca !== cb) return ca - cb;
      if (a.order !== b.order) return a.order - b.order;
      return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    });
    return cols;
  }

  var WEEKLY_CTA = '<p class="dash-empty">Aucune donnee de semaine dans ce code. Installe <strong>WeeklyCompass</strong> ' +
    '(avec Stats) pour voir ici ce qu\'il reste a faire cette semaine sur chacun de tes personnages.</p>';

  function weeklyCard(body, note) {
    return '<div class="bi-chart-card wk-card" style="border-top-color:' + WEEKLY_ACCENT + '">' +
      '<div class="bi-chart-head"><h3 class="dash-subtitle" style="margin:0;color:' + WEEKLY_ACCENT + '">Cette semaine</h3></div>' +
      body + (note ? '<p class="dash-note">' + note + "</p>" : "") + "</div>";
  }

  // Vue compte : la meme grille qu'en jeu, personnages x activites.
  function renderWeeklyGrid(profiles) {
    var withWeekly = (profiles || []).filter(function (p) { return p.weekly && p.weekly.entries && p.weekly.entries.length; });
    if (withWeekly.length === 0) return weeklyCard(WEEKLY_CTA);
    var cols = weeklyColumns(withWeekly);
    var anyStale = false;
    var head = "<tr><th>Personnage</th>" + cols.map(function (c) { return "<th>" + esc(c.header) + "</th>"; }).join("") + "</tr>";
    var rows = withWeekly.map(function (p) {
      var stale = weeklyIsStale(p.weekly);
      if (stale) anyStale = true;
      var byKey = {};
      p.weekly.entries.forEach(function (e) { byKey[e.key] = e; });
      return '<tr class="' + (stale ? "wk-stale" : "") + '"><td><i class="bi-chip-dot" style="background:' + classColor(p.char.class) + '"></i> ' +
        esc(p.char.name) + (stale ? ' <span class="wk-stale-tag">a rafraichir</span>' : "") + "</td>" +
        cols.map(function (c) { return weeklyCell(byKey[c.key], stale); }).join("") + "</tr>";
    }).join("");
    var note = "? = activite pas encore suivie par l'addon. " +
      (anyStale ? "Les lignes grisees datent d'une semaine terminee : reconnecte ces personnages pour les mettre a jour." : "");
    return weeklyCard('<div class="dash-table-wrap"><table class="dash-table wk-table"><thead>' + head + "</thead><tbody>" + rows + "</tbody></table></div>", note);
  }

  // Vue personnage : la liste detaillee, avec l'ilvl deja obtenu en Chambre forte.
  function renderWeeklyDetail(profile) {
    var weekly = profile && profile.weekly;
    if (!weekly || !weekly.entries || !weekly.entries.length) return weeklyCard(WEEKLY_CTA);
    var stale = weeklyIsStale(weekly);
    var entries = weekly.entries.slice().sort(function (a, b) {
      var ca = WEEKLY_CATEGORY_ORDER[a.category] || 100, cb = WEEKLY_CATEGORY_ORDER[b.category] || 100;
      if (ca !== cb) return ca - cb;
      return (a.order || 100) - (b.order || 100);
    });
    var rows = entries.map(function (e) {
      var st = WEEKLY_STATUS[e.status] || WEEKLY_STATUS.unknown;
      return '<tr class="' + (stale ? "wk-stale" : "") + '"><td>' + esc(e.label || e.key) + "</td>" + weeklyCell(e, stale) +
        '<td style="color:' + (stale ? "var(--muted)" : st.color) + '">' + esc(st.label) + "</td>" +
        "<td>" + (e.ilvl ? "ilvl " + esc(e.ilvl) : "") + "</td></tr>";
    }).join("");
    var note = (weekly.lastSeen ? "Releve le " + esc(fmtGeneratedAt(weekly.lastSeen)) + ". " : "") +
      (stale ? "Cette semaine est terminee depuis : reconnecte ce personnage pour la mettre a jour." : "");
    return weeklyCard('<div class="dash-table-wrap"><table class="dash-table wk-table"><thead><tr><th>Activite</th><th>Progression</th><th>Statut</th><th>Recompense</th></tr></thead><tbody>' +
      rows + "</tbody></table></div>", note);
  }

  // ==========================================================================
  // PERSONNAGES ET FICHE (WeeklyCompass, phase 4)
  // ==========================================================================
  // Miroir de l'onglet Personnages et de la fiche detaillee de WeeklyCompass.
  // Chaque profil porte `compass` = { lastSeen, hidden, profile:{level, spec,
  // ilvl, gold (cuivre), rest}, keystone:{text, level, expiresAt},
  // score:{value, color}, lockouts:[{name, diff, diffID, killed, total,
  // expiresAt}], sheet:{updatedAt, race, className, slots, set, stats,
  // currencies, talents} } et `warband` = { money, at } (Stats/Export.lua,
  // collectCompass). Section publique (fixed) : l'or n'est jamais affiche.
  var COMPASS_ACCENT = "#0affbe";
  var TRACK_COLORS = { explorer: "#9e9e9e", adventurer: "#ffffff", veteran: "#1eff00",
    champion: "#0070dd", hero: "#a335ee", myth: "#ff8000" };
  var QUALITY_COLORS = { 0: "#9d9d9d", 1: "#ffffff", 2: "#1eff00", 3: "#0070dd", 4: "#a335ee", 5: "#ff8000", 6: "#e6cc80", 7: "#00ccff" };
  var DIFF_COLORS = {};
  [8, 16, 23].forEach(function (id) { DIFF_COLORS[id] = "#ff8000"; });
  [2, 5, 6, 15].forEach(function (id) { DIFF_COLORS[id] = "#b366ff"; });
  [1, 3, 4, 9, 14, 33].forEach(function (id) { DIFF_COLORS[id] = "#59a6ff"; });
  [7, 17].forEach(function (id) { DIFF_COLORS[id] = "#4de64d"; });
  var SLOT_LABELS = { 1: "Tete", 2: "Cou", 3: "Epaules", 15: "Dos", 5: "Torse", 9: "Poignets", 16: "Main droite",
    17: "Main gauche", 10: "Mains", 6: "Taille", 7: "Jambes", 8: "Pieds", 11: "Anneau 1", 12: "Anneau 2",
    13: "Bijou 1", 14: "Bijou 2" };
  var SLOT_ORDER = [1, 2, 3, 15, 5, 9, 16, 17, 10, 6, 7, 8, 11, 12, 13, 14];
  var WOWHEAD_BASE = "https://www.wowhead.com/fr/";
  var COMPASS_CTA = '<p class="dash-empty">Aucune fiche WeeklyCompass dans ce code. Installe <strong>WeeklyCompass</strong> ' +
    "(avec Stats) pour voir ici le niveau d'objet, l'equipement, l'ensemble de raid et les talents de chacun de tes personnages.</p>";

  function nowSec() { return Date.now() / 1000; }
  function fmtGold(copper) { return fmtNum(Math.floor((copper || 0) / 10000)) + " po"; }
  function fmtDec(x) { return (Math.round((x || 0) * 10) / 10).toFixed(1).replace(".", ","); }
  function fmtDelay(sec) {
    sec = Math.max(0, sec || 0);
    var d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600);
    return d > 0 ? d + " j " + h + " h" : Math.max(1, h) + " h";
  }
  function liveLockouts(c) {
    var t = nowSec();
    return ((c && c.lockouts) || []).filter(function (it) { return (it.expiresAt || 0) > t; });
  }
  function liveKeystone(c) {
    return (c && c.keystone && (!c.keystone.expiresAt || c.keystone.expiresAt > nowSec())) ? c.keystone : null;
  }
  function compassCard(title, body, note, extraClass) {
    return '<div class="bi-chart-card cp-card' + (extraClass ? " " + extraClass : "") + '" style="border-top-color:' + COMPASS_ACCENT + '">' +
      '<div class="bi-chart-head"><h3 class="dash-subtitle" style="margin:0;color:' + COMPASS_ACCENT + '">' + title + "</h3></div>" +
      body + (note ? '<p class="dash-note">' + note + "</p>" : "") + "</div>";
  }
  // Banque de Bataillon : le releve le plus recent parmi les profils du code.
  function latestWarband(profiles) {
    var best = null;
    (profiles || []).forEach(function (p) {
      if (p.warband && typeof p.warband.money === "number" && (!best || (p.warband.at || 0) > (best.at || 0))) best = p.warband;
    });
    return best;
  }

  // Colonnes de la vue compte. value = valeur de tri, cell = contenu HTML.
  function compassColumns(fixed) {
    var cols = [
      { key: "level", label: "Niv.", value: function (c) { return c.profile && c.profile.level; },
        cell: function (c) { return c.profile && c.profile.level != null ? esc(c.profile.level) : "-"; } },
      { key: "spec", label: "Spe", value: null,
        cell: function (c) { return c.profile && c.profile.spec ? esc(c.profile.spec) : "-"; } },
      { key: "ilvl", label: "iLvl", value: function (c) { return c.profile && c.profile.ilvl; },
        cell: function (c) { return c.profile && c.profile.ilvl ? fmtDec(c.profile.ilvl) : "-"; } },
    ];
    if (!fixed) {
      cols.push({ key: "gold", label: "Or", value: function (c) { return c.profile && c.profile.gold; },
        cell: function (c) { return c.profile && c.profile.gold != null ? fmtGold(c.profile.gold) : "-"; } });
    }
    cols.push(
      { key: "key", label: "Cle", value: function (c) { var k = liveKeystone(c); return k && k.level; },
        cell: function (c) { var k = liveKeystone(c); return k ? esc(k.text) : "-"; } },
      { key: "score", label: "Score M+", value: function (c) { return c.score && c.score.value; },
        cell: function (c) {
          if (!c.score || !c.score.value) return "-";
          var col = c.score.color ? "rgb(" + c.score.color.map(function (v) { return Math.round(v * 255); }).join(",") + ")" : "inherit";
          return '<span style="color:' + col + '">' + esc(Math.floor(c.score.value)) + "</span>";
        } },
      { key: "raids", label: "Raids", value: function (c) { return liveLockouts(c).length || null; },
        cell: function (c) {
          var live = liveLockouts(c);
          if (!live.length) return "-";
          var title = live.map(function (it) { return it.name + " (" + it.diff + ") " + it.killed + "/" + it.total; }).join("\n");
          return '<span title="' + esc(title) + '">' + live.length + " raid" + (live.length > 1 ? "s" : "") + "</span>";
        } },
      { key: "rest", label: "Repos", value: function (c) { return c.profile && c.profile.rest; },
        cell: function (c) { return c.profile && c.profile.rest ? esc(c.profile.rest) + " %" : "-"; } }
    );
    return cols;
  }

  // Vue compte : l'onglet Personnages du jeu, triable, avec une ligne de total.
  function renderCompassGrid(profiles, fixed, sort) {
    var rows = (profiles || []).filter(function (p) { return p.compass && !p.compass.hidden; });
    if (rows.length === 0) return compassCard("Personnages", COMPASS_CTA);
    // Comme en jeu : une colonne chiffree sans aucune valeur (ex. Cle quand
    // personne n'en a) n'est pas affichee. Niveau et iLvl restent toujours.
    var cols = compassColumns(fixed).filter(function (c) {
      if (!c.value || c.key === "level" || c.key === "ilvl") return true;
      return rows.some(function (p) { var v = c.value(p.compass); return v != null && v !== 0; });
    });
    sort = sort || { key: "name", dir: "asc" };
    var sortCol = null;
    cols.forEach(function (c) { if (c.key === sort.key) sortCol = c; });
    rows = rows.slice().sort(function (a, b) {
      if (sortCol && sortCol.value) {
        var va = sortCol.value(a.compass), vb = sortCol.value(b.compass);
        if (va !== vb) {
          if (va == null) return 1;
          if (vb == null) return -1;
          return sort.dir === "asc" ? va - vb : vb - va;
        }
      }
      var na = a.char.name || "", nb = b.char.name || "";
      if (sort.key === "name" && sort.dir === "desc") return nb.localeCompare(na);
      return na.localeCompare(nb);
    });
    function th(key, label, sortable) {
      if (!sortable) return "<th>" + esc(label) + "</th>";
      var active = sort.key === key;
      var arrow = active ? (sort.dir === "asc" ? " &#9650;" : " &#9660;") : "";
      return '<th><button type="button" class="dash-sort-btn" data-action="compass-sort" data-key="' + key + '" aria-sort="' +
        (active ? (sort.dir === "asc" ? "ascending" : "descending") : "none") + '">' + esc(label) + arrow + "</button></th>";
    }
    var head = "<tr>" + th("name", "Personnage", true) + cols.map(function (c) { return th(c.key, c.label, !!c.value); }).join("") + "</tr>";
    // Homonymes (meme nom sur deux royaumes) : le royaume s'affiche en gris,
    // comme dans le tableau du jeu.
    var nameCount = {};
    rows.forEach(function (p) { nameCount[p.char.name] = (nameCount[p.char.name] || 0) + 1; });
    var body = rows.map(function (p) {
      var realm = nameCount[p.char.name] > 1 && p.char.realm ? ' <span class="cp-sub">- ' + esc(p.char.realm) + "</span>" : "";
      return '<tr><td><i class="bi-chip-dot" style="background:' + classColor(p.char.class) + '"></i> ' + esc(p.char.name) + realm + "</td>" +
        cols.map(function (c) { return '<td class="cp-cell">' + c.cell(p.compass) + "</td>"; }).join("") + "</tr>";
    }).join("");
    // Total : or (+ banque de Bataillon, hors section publique), cles, raids.
    var totals = {}, goldSum = 0, keys = 0, raids = 0;
    rows.forEach(function (p) {
      var c = p.compass;
      if (c.profile && c.profile.gold) goldSum += c.profile.gold;
      if (liveKeystone(c)) keys++;
      raids += liveLockouts(c).length;
    });
    var wb = fixed ? null : latestWarband(profiles);
    if (!fixed) {
      var goldTitle = "Personnages : " + fmtGold(goldSum) + (wb ? "\nBanque de Bataillon : " + fmtGold(wb.money) + " (releve le " + fmtGeneratedAt(wb.at) + ")" : "\nBanque de Bataillon : pas encore relevee");
      totals.gold = '<span title="' + esc(goldTitle) + '">' + fmtGold(goldSum + (wb ? wb.money : 0)) + "</span>";
    }
    totals.key = keys ? String(keys) : "";
    totals.raids = raids ? String(raids) : "";
    // Ligne de total seulement si au moins une colonne affichee a un total
    // (section publique sans or, sans cle ni raid : rien a additionner).
    var hasTotal = cols.some(function (c) { return totals[c.key]; });
    var totalRow = hasTotal ? '<tr class="cp-total"><td>Total</td>' + cols.map(function (c) { return '<td class="cp-cell">' + (totals[c.key] || "") + "</td>"; }).join("") + "</tr>" : "";
    var note = "Clique sur un personnage (puces ci-dessus) pour ouvrir sa fiche detaillee." +
      (wb ? " L'or total inclut la banque de Bataillon." : "");
    return compassCard("Personnages", '<div class="dash-table-wrap"><table class="dash-table cp-table"><thead>' + head + "</thead><tbody>" + body + totalRow + "</tbody></table></div>", note);
  }

  function statBars(stats) {
    var defs = [["crit", "Coup critique"], ["haste", "Hate"], ["mastery", "Maitrise"], ["versa", "Polyvalence"]];
    var scale = 40;
    defs.forEach(function (d) { if ((stats[d[0]] || 0) > scale) scale = stats[d[0]]; });
    return defs.map(function (d) {
      var v = stats[d[0]];
      var pct = v ? Math.min(100, (v / scale) * 100) : 0;
      return '<div class="cp-stat"><span>' + d[1] + '</span><b>' + (v != null ? fmtDec(v) + " %" : "-") + '</b><i><em style="width:' + pct.toFixed(1) + '%"></em></i></div>';
    }).join("");
  }

  function vaultGrid(weekly) {
    var byKey = {};
    ((weekly && weekly.entries) || []).forEach(function (e) { byKey[e.key] = e; });
    var rowsDef = [["greatVault:3", "Raid"], ["greatVault:1", "Donjons"], ["greatVault:6", "Monde"]];
    var stale = weeklyIsStale(weekly);
    return '<div class="cp-vault' + (stale ? " cp-stale" : "") + '">' + rowsDef.map(function (r) {
      var e = byKey[r[0]];
      var slots = (e && e.slots) || [];
      var boxes = [0, 1, 2].map(function (i) {
        var s = slots[i];
        if (!s) return '<span class="cp-box">-</span>';
        var done = s.threshold > 0 && s.progress >= s.threshold;
        if (done) {
          var col = s.color ? "rgb(" + s.color.map(function (v) { return Math.round(v * 255); }).join(",") + ")" : "#6bba7a";
          return '<span class="cp-box done" style="color:' + col + '">' + (s.ilvl ? esc(s.ilvl) : "&#10003;") + "</span>";
        }
        return '<span class="cp-box">' + Math.min(s.progress || 0, s.threshold || 0) + "/" + (s.threshold || 0) + "</span>";
      }).join("");
      return '<div class="cp-vault-row"><span>' + r[1] + "</span>" + boxes + "</div>";
    }).join("") + "</div>" + (stale ? '<p class="dash-note">Semaine terminee depuis : reconnecte ce personnage.</p>' : "");
  }

  // Vue personnage : la fiche detaillee du jeu.
  function renderSheet(profile, fixed) {
    var c = profile && profile.compass;
    if (!c) return compassCard("Fiche", COMPASS_CTA);
    var sh = c.sheet;
    if (!sh) {
      return compassCard("Fiche", '<p class="dash-empty">Pas encore de fiche detaillee pour ce personnage : connecte-toi une fois dessus avec WeeklyCompass pour la remplir (equipement, ensemble, talents).</p>');
    }
    var color = classColor(profile.char && profile.char.class);
    var p = c.profile || {};
    var headParts = [];
    if (p.level) headParts.push("Niveau " + esc(p.level));
    if (p.spec) headParts.push(esc(p.spec));
    if (sh.className) headParts.push(esc(sh.className));
    if (sh.race) headParts.push(esc(sh.race));
    var header = '<div class="cp-head"><div><div class="cp-name" style="color:' + color + '">' + esc(profile.char.name) + "</div>" +
      '<div class="cp-sub">' + headParts.join(" &middot; ") + "</div></div>" +
      '<div class="cp-ilvl"><b>' + (p.ilvl ? fmtDec(p.ilvl) : "-") + "</b><span>Niveau d'objet equipe</span></div></div>";

    // Talents : heroique, build, (modifie), copier, Wowhead.
    var t = sh.talents;
    var talents = "";
    if (t && (t.hero || t.build || t.code)) {
      var tp = [];
      if (t.hero) tp.push('<b style="color:' + COMPASS_ACCENT + '">' + esc(t.hero) + "</b>");
      if (t.starter) tp.push("Build de depart");
      else if (t.build) tp.push("Build &laquo; " + esc(t.build) + " &raquo;" + (t.modified ? ' <span class="cp-modified" title="Les talents actifs ne correspondent plus au build enregistre.">(modifie)</span>' : ""));
      var heroList = (t.heroTalents || []).map(function (h) {
        return esc(h.name || "?") + ((h.max || 1) > 1 ? " " + (h.rank || 0) + "/" + h.max : "");
      }).join(", ");
      talents = '<div class="cp-talents"><div title="' + esc(heroList) + '">' + tp.join(" &middot; ") + "</div>" +
        (t.code ? '<div class="cp-talent-btns"><button type="button" class="btn ghost small" data-action="copy-build" data-code="' + esc(t.code) + '">Copier le build</button>' +
          '<a class="btn ghost small" href="' + WOWHEAD_BASE + "talent-calc/blizzard/" + encodeURIComponent(t.code) + '" target="_blank" rel="noopener noreferrer">Voir l\'arbre sur Wowhead</a></div>' : "") +
        (heroList ? '<p class="dash-note" style="margin-top:6px">Talents heroiques : ' + heroList + (t.otherCount ? " (+ " + t.otherCount + " talents de classe et de specialisation)" : "") + "</p>" : "") +
        "</div>";
    }

    // Equipement.
    var bySlot = {};
    (sh.slots || []).forEach(function (s) { bySlot[s.slot] = s; });
    var gear = SLOT_ORDER.map(function (id) {
      var s = bySlot[id];
      if (!s) return '<div class="cp-item empty"><span class="cp-slot">' + SLOT_LABELS[id] + "</span><span>-</span></div>";
      var warns = [];
      if (s.missingEnchant) warns.push("Sans enchant.");
      if (s.emptySockets) warns.push(s.emptySockets > 1 ? s.emptySockets + " chasses vides" : "Chasse vide");
      var name = esc(s.name || "?");
      if (s.id) name = '<a href="' + WOWHEAD_BASE + "item=" + encodeURIComponent(s.id) + '" target="_blank" rel="noopener noreferrer" style="color:' + (QUALITY_COLORS[s.quality] || "#fff") + '">' + name + "</a>";
      return '<div class="cp-item"><span class="cp-slot">' + SLOT_LABELS[id] + '</span><b style="color:' + (TRACK_COLORS[s.track] || "#fff") + '">' + (s.ilvl || "") + "</b>" +
        '<span class="cp-item-name">' + name + "</span>" + (warns.length ? '<span class="cp-warn">' + warns.join(" &middot; ") + "</span>" : "") + "</div>";
    }).join("");

    // Ensemble de raid.
    var set = sh.set;
    var setHtml = set
      ? '<div class="cp-set"><div><b>' + esc(set.name) + '</b><span class="' + (set.count >= 4 ? "cp-ok" : "cp-mid") + '">' + esc(set.count) + "/" + esc(set.total || 5) + "</span></div>" +
        '<div class="cp-sub">' + [set.raid, set.expansion].filter(Boolean).map(esc).join(" &middot; ") + "</div>" +
        '<div class="cp-sub">' + (set.count >= 2 ? "&#10003;" : "&#10007;") + " 2 pieces &nbsp; " + (set.count >= 4 ? "&#10003;" : "&#10007;") + " 4 pieces" +
        (set.current === true ? ' <span class="cp-badge now">Saison en cours</span>' : set.current === false ? ' <span class="cp-badge old">Saison precedente (' + esc(set.patch || "?") + ")</span>" : "") + "</div></div>"
      : '<p class="dash-empty">Aucun ensemble de raid porte.</p>';

    // Raids.
    var live = liveLockouts(c);
    var raidsHtml = live.length
      ? live.map(function (it) {
        var full = it.total > 0 && it.killed >= it.total;
        return '<div class="cp-raid"><span>' + esc(it.name) + ' <em style="color:' + (DIFF_COLORS[it.diffID] || "var(--muted)") + '">' + esc(it.diff) + "</em></span><b class=\"" + (full ? "cp-ok" : "cp-mid") + '">' + it.killed + "/" + it.total + "</b></div>";
      }).join("") + '<p class="dash-note">Reset dans ' + fmtDelay(live[0].expiresAt - nowSec()) + "</p>"
      : '<p class="dash-empty">Aucun raid verrouille.</p>';

    // Monnaies (et or, hors section publique).
    var cur = (sh.currencies || []).map(function (m) {
      return '<div class="cp-raid"><span>' + esc(m.name) + "</span><b>" + fmtNum(m.quantity || 0) +
        (m.max ? ' <em class="cp-sub">(' + fmtNum(m.useEarned ? m.earned || 0 : m.quantity || 0) + "/" + fmtNum(m.max) + ")</em>" : "") + "</b></div>";
    }).join("");
    if (!fixed && p.gold != null) cur = '<div class="cp-raid"><span>Or</span><b>' + fmtGold(p.gold) + "</b></div>" + cur;

    var right =
      '<h4 class="cp-h">Ensemble de raid</h4>' + setHtml +
      '<h4 class="cp-h">Statistiques secondaires</h4>' + statBars(sh.stats || {}) +
      '<h4 class="cp-h">Grand Coffre</h4>' + vaultGrid(profile.weekly) +
      '<h4 class="cp-h">Verrouillages de raid</h4>' + raidsHtml +
      (cur ? '<h4 class="cp-h">Monnaies</h4>' + cur : "");
    var note = "Fiche du " + esc(fmtGeneratedAt(sh.updatedAt || c.lastSeen)) + ". Objets et arbre de talents : liens vers Wowhead.";
    return compassCard("Fiche", header + talents + '<div class="cp-cols"><div><h4 class="cp-h">Equipement</h4>' + gear + "</div><div>" + right + "</div></div>", note, "cp-sheet");
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
    // doublon strict du seul personnage disponible. Compte sur TOUS les
    // profils (profiles, pas visibleProfiles) : masquer un personnage de la
    // rangee ne doit jamais le sortir du total (demande utilisateur
    // 2026-09-17, cf. le X qui masque au lieu de desynchroniser plus bas).
    var accountBtn = profiles.length >= 2
      ? '<button type="button" class="addon-chip bi-account-chip' + (activeId === ALL_PROFILES_ID ? " active" : "") + '" data-action="select-account" aria-pressed="' + (activeId === ALL_PROFILES_ID) + '" title="Additionne les statistiques de tous les personnages charges">Compte</button>' +
        '<span class="bi-chip-sep" aria-hidden="true">|</span>'
      : "";
    // X = masquer de la rangee (localStorage, cf. PROFILE_HIDDEN_KEY), jamais
    // desynchroniser : sur un compte auto-synchronise ("+ Compte WoW"), un
    // seul export regroupe tous les personnages, donc "retirer" un
    // personnage effacait auparavant TOUT le code du stockage local jusqu'au
    // prochain /reload - source de confusion (constat utilisateur
    // 2026-09-17 : "Compte" ne comptait plus les personnages fermes).
    var hidden = fixed ? {} : loadHiddenProfiles();
    var visibleProfiles = profiles.filter(function (p) { return !hidden[p.id]; });
    var hiddenCount = profiles.length - visibleProfiles.length;
    var showAllBtn = hiddenCount > 0
      ? ' <button type="button" class="addon-chip bi-chip-showall" data-action="show-all-profiles" title="Reafficher les personnages masques">+' + hiddenCount + " masque" + (hiddenCount > 1 ? "s" : "") + "</button>"
      : "";
    // Le glisser-deposer (cf. onChipPointerMove) remplace les anciennes
    // fleches monter/descendre : on l'annonce sous la rangee, sinon rien ne
    // laisse deviner qu'un chip se deplace.
    var dragHint = visibleProfiles.length >= 2
      ? '<p class="bi-drag-hint">Astuce : glisse-depose les personnages pour changer leur ordre.</p>'
      : "";
    return (
      '<div class="bi-profiles-block">' +
      '<div class="addon-chips bi-profiles" role="group" aria-label="Personnages">' +
      accountBtn +
      visibleProfiles.map(function (p) {
        var color = classColor(p.char.class);
        return (
          '<button type="button" class="addon-chip bi-profile-chip' + (p.id === activeId ? " active" : "") + '" data-action="select-profile" data-id="' + esc(p.id) + '" title="Glisse-depose pour changer l\'ordre" style="--chip-color:' + color + '" aria-pressed="' + (p.id === activeId) + '">' +
          '<i class="bi-chip-dot" style="background:' + color + '"></i>' + esc(p.char.name) +
          (fixed ? "" : ' <span class="bi-chip-remove" data-action="hide-profile" data-id="' + esc(p.id) + '" role="button" tabindex="0" aria-label="Masquer ' + esc(p.char.name) + '">&times;</span>') +
          "</button>"
        );
      }).join("") + showAllBtn + "</div>" + dragHint + "</div>"
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
      profiles: sortProfiles(options.profiles || [], fixed),
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
      // Tri de la carte Personnages (WeeklyCompass).
      compassSort: { key: "name", dir: "asc" },
      profFilter: "overall",
      // Detail par evenement (clic sur une carte KPI) : eventMetric = cle de
      // la carte ouverte (null = aucune). eventSort separe de `sort`
      // ci-dessus (qui pilote la table "Historique journalier") pour que les
      // deux tris n'interferent pas l'un avec l'autre.
      eventMetric: null,
      eventSort: { key: "date", dir: "desc" },
      // Filtre par extension de la liste d'evenements ("all"/"none"/numero),
      // partage entre cartes comme eventSort (cf. expFilterHtml).
      eventExpFilter: "all",
      // Sections repliables (PVP/Gouffres+Tourments/Reputations) - meme
      // principe que l'addon Stats (UI.lua, view.summaryExpanded) : repliees
      // par defaut, cliquer sur la tuile deplie son detail complet.
      summaryExpanded: {},
    };
    // startOnAccount (Tibi Companion) : a l'ouverture on affiche le profil
    // virtuel "Compte" (tous les personnages) plutot que le 1er personnage.
    // Le chip "Compte" n'existe qu'a partir de 2 personnages (cf.
    // profileChipsHtml) : en dessous, on retombe sur le personnage seul.
    function defaultActiveId() {
      if (!state.profiles.length) return null;
      return (options.startOnAccount && state.profiles.length >= 2) ? ALL_PROFILES_ID : state.profiles[0].id;
    }
    if (state.profiles.length) state.activeId = defaultActiveId();

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
        var evColor = OVERLAY_COLORS[state.eventMetric] || (state.eventMetric === "pvpMatches" ? SUMMARY_SECTION_COLORS.pvp : "#e4b64a");
        html += '<div class="bi-chart-card" data-event-detail style="border-top-color:' + evColor + '"><div class="bi-chart-head"><h3 class="dash-subtitle" style="margin:0;color:' + evColor + '">Detail : ' + esc(evLabel) + '</h3></div>' +
          renderEventLogTable(active, state.eventMetric, win, state.eventSort, state.eventExpFilter) + "</div>";
      }
      html += active.id === ALL_PROFILES_ID ? renderWeeklyGrid(state.profiles) : renderWeeklyDetail(active);
      // Section publique (fixed) : l'or n'y est jamais affiche.
      html += active.id === ALL_PROFILES_ID ? renderCompassGrid(state.profiles, fixed, state.compassSort) : renderSheet(active, fixed);
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
      if (active.id === ALL_PROFILES_ID) {
        profSection = '<h3 class="dash-subtitle">Repartition par personnage</h3>' + renderAccountBreakdown(state.profiles, win);
      } else if (hasProfessions) {
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
      else if (action === "hide-profile") {
        // Masque de la rangee (localStorage) - NE retire plus le personnage
        // de state.profiles ni du stockage des codes : "Compte" doit
        // continuer a l'additionner (demande utilisateur 2026-09-17, cf.
        // profileChipsHtml pour le contexte complet de ce changement).
        e.stopPropagation();
        var id = el.dataset.id;
        var hiddenSet = loadHiddenProfiles();
        hiddenSet[id] = true;
        saveHiddenProfiles(hiddenSet);
        if (state.activeId === id) {
          var stillVisible = state.profiles.filter(function (p) { return !hiddenSet[p.id]; });
          state.activeId = stillVisible.length ? stillVisible[0].id : ALL_PROFILES_ID;
        }
        render();
      }
      else if (action === "show-all-profiles") {
        saveHiddenProfiles({});
        render();
      }
      else if (action === "toggle-compare") { state.compareMode = !state.compareMode; render(); }
      else if (action === "compass-sort") {
        var ck = el.dataset.key;
        if (state.compassSort.key === ck) state.compassSort.dir = state.compassSort.dir === "asc" ? "desc" : "asc";
        // Colonne chiffree : le plus grand en haut ; noms : ordre alphabetique.
        else state.compassSort = { key: ck, dir: ck === "name" ? "asc" : "desc" };
        render();
      }
      else if (action === "copy-build") {
        var code = el.dataset.code || "";
        var done = function (ok) {
          var prev = el.textContent;
          el.textContent = ok ? "Copie !" : "Copie impossible";
          setTimeout(function () { el.textContent = prev; }, 1600);
        };
        // Repli si le presse-papiers moderne est refuse (navigateur ancien,
        // page non securisee) : ancienne methode, puis fenetre avec le code
        // pre-selectionne pour une copie manuelle. Jamais d'echec silencieux.
        var fallback = function () {
          var ta = document.createElement("textarea");
          ta.value = code;
          ta.setAttribute("readonly", "");
          ta.style.position = "fixed"; ta.style.opacity = "0";
          document.body.appendChild(ta);
          ta.select();
          var ok = false;
          try { ok = document.execCommand("copy"); } catch (err) { ok = false; }
          document.body.removeChild(ta);
          if (ok) done(true);
          else window.prompt("Copie ce code (Ctrl+C) :", code);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(code).then(function () { done(true); }, fallback);
        } else {
          fallback();
        }
      }
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
        // Ouvert depuis le detail PVP (bas de page) : la liste s'affiche en
        // haut, on l'amene a l'ecran.
        if (state.eventMetric === "pvpMatches") {
          var evCard = container.querySelector("[data-event-detail]");
          if (evCard && evCard.scrollIntoView) evCard.scrollIntoView({ behavior: "smooth", block: "start" });
        }
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
      var el = e.target.closest('[data-action="hide-profile"]');
      if (!el) return;
      e.preventDefault();
      el.click();
    });
    // Glisser-deposer des chips de personnages (demande utilisateur
    // 2026-09-19), en pointer events plutot qu'en HTML5 drag&drop : un
    // <button draggable> reste capricieux selon les navigateurs, et les
    // pointer events couvrent souris ET tactile (appui long ~350 ms pour ne
    // pas voler le defilement de la page). Le chip suit le pointeur par
    // transform, un filet dore marque l'emplacement cible, l'ordre n'est
    // applique/persiste qu'au relachement.
    var chipDrag = null;
    var suppressChipClick = false;

    function dragChips() {
      return Array.prototype.slice.call(container.querySelectorAll(".bi-profile-chip"));
    }
    function clearDropMarkers() {
      dragChips().forEach(function (c) { c.classList.remove("drop-before", "drop-after"); });
    }
    function locateDropTarget(x, y) {
      var best = null, bestD = Infinity;
      dragChips().forEach(function (c) {
        if (c === chipDrag.chip) return;
        var r = c.getBoundingClientRect();
        var dx = x < r.left ? r.left - x : (x > r.right ? x - r.right : 0);
        var dy = y < r.top ? r.top - y : (y > r.bottom ? y - r.bottom : 0);
        // La distance verticale pese plus : a l'interieur d'une rangee on
        // vise le voisin de la MEME rangee avant celui de la rangee du dessous.
        var d = dx * dx + (dy * 3) * (dy * 3);
        if (d < bestD) { bestD = d; best = { chip: c, after: x > r.left + r.width / 2 }; }
      });
      return best;
    }
    function blockTouchScroll(e) { if (chipDrag && chipDrag.active) e.preventDefault(); }
    function beginChipDrag() {
      chipDrag.active = true;
      suppressChipClick = true;
      chipDrag.chip.classList.add("dragging");
      document.body.classList.add("bi-dragging");
      document.addEventListener("touchmove", blockTouchScroll, { passive: false });
    }
    function endChipDrag() {
      if (!chipDrag) return;
      clearTimeout(chipDrag.timer);
      document.removeEventListener("pointermove", onChipPointerMove);
      document.removeEventListener("pointerup", onChipPointerUp);
      document.removeEventListener("pointercancel", onChipPointerCancel);
      document.removeEventListener("touchmove", blockTouchScroll);
      document.body.classList.remove("bi-dragging");
      chipDrag.chip.classList.remove("dragging");
      chipDrag.chip.style.transform = "";
      clearDropMarkers();
      chipDrag = null;
      setTimeout(function () { suppressChipClick = false; }, 0);
    }
    function applyChipReorder(id, target) {
      // Reordonne les personnages VISIBLES, en gardant les masques (mode
      // "Mon Dashboard") a leur place.
      var hiddenMap = fixed ? {} : loadHiddenProfiles();
      var ids = state.profiles.filter(function (p) { return !hiddenMap[p.id]; })
        .map(function (p) { return p.id; })
        .filter(function (x) { return x !== id; });
      var ti = ids.indexOf(target.chip.dataset.id);
      if (ti === -1) return false;
      ids.splice(target.after ? ti + 1 : ti, 0, id);
      var byId = {};
      state.profiles.forEach(function (p) { byId[p.id] = p; });
      var reordered = state.profiles.slice(), k = 0;
      state.profiles.forEach(function (p, i) {
        if (!hiddenMap[p.id]) reordered[i] = byId[ids[k++]];
      });
      state.profiles = reordered;
      saveProfileOrder(reordered.map(function (p) { return p.id; }), fixed);
      return true;
    }
    function onChipPointerMove(e) {
      if (!chipDrag || e.pointerId !== chipDrag.pointerId) return;
      var dx = e.clientX - chipDrag.startX, dy = e.clientY - chipDrag.startY;
      if (!chipDrag.active) {
        var dist = Math.sqrt(dx * dx + dy * dy);
        if (chipDrag.touch) { if (dist > 10) endChipDrag(); return; }
        if (dist < 6) return;
        beginChipDrag();
      }
      chipDrag.chip.style.transform = "translate(" + dx + "px," + dy + "px)";
      clearDropMarkers();
      chipDrag.target = locateDropTarget(e.clientX, e.clientY);
      if (chipDrag.target) chipDrag.target.chip.classList.add(chipDrag.target.after ? "drop-after" : "drop-before");
    }
    function onChipPointerUp(e) {
      if (!chipDrag || e.pointerId !== chipDrag.pointerId) return;
      var moved = chipDrag.active && chipDrag.target && applyChipReorder(chipDrag.id, chipDrag.target);
      endChipDrag();
      if (moved) render();
    }
    function onChipPointerCancel(e) {
      if (!chipDrag || e.pointerId !== chipDrag.pointerId) return;
      endChipDrag();
    }
    container.addEventListener("pointerdown", function (e) {
      if (e.button !== undefined && e.button !== 0) return;
      var chip = e.target.closest(".bi-profile-chip");
      if (!chip || !container.contains(chip)) return;
      if (e.target.closest('[data-action="hide-profile"]')) return;
      if (chipDrag) endChipDrag();
      chipDrag = { chip: chip, id: chip.dataset.id, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY,
                   active: false, touch: e.pointerType === "touch", target: null, timer: null };
      if (chipDrag.touch) {
        chipDrag.timer = setTimeout(function () {
          if (chipDrag && !chipDrag.active) beginChipDrag();
        }, 350);
      }
      document.addEventListener("pointermove", onChipPointerMove);
      document.addEventListener("pointerup", onChipPointerUp);
      document.addEventListener("pointercancel", onChipPointerCancel);
    });
    // Un glisser termine ne doit pas compter comme un clic de selection.
    container.addEventListener("click", function (e) {
      if (suppressChipClick && e.target.closest(".bi-profile-chip")) { e.stopPropagation(); e.preventDefault(); }
    }, true);

    container.addEventListener("change", function (e) {
      var pick = e.target.closest('[data-action="compare-pick"]');
      if (pick) {
        var slot = Number(pick.dataset.slot);
        state.compareIds[slot] = pick.value;
        render();
        return;
      }
      var profFilter = e.target.closest('[data-action="prof-filter"]');
      if (profFilter) { state.profFilter = profFilter.value; render(); return; }
      var expFilter = e.target.closest('[data-action="event-exp-filter"]');
      if (expFilter) { state.eventExpFilter = expFilter.value; render(); }
    });

    return {
      render: render,
      setProfiles: function (profiles, activeId) {
        state.profiles = sortProfiles(profiles, fixed);
        if (activeId) {
          state.activeId = activeId;
        } else if (options.startOnAccount) {
          // Chaque synchro rappelle setProfiles : on garde la vue courante si
          // elle est encore valide au lieu de la renvoyer sur un personnage.
          var cur = state.activeId;
          var valid = (cur === ALL_PROFILES_ID && state.profiles.length >= 2) ||
            state.profiles.some(function (p) { return p.id === cur; });
          if (!valid) state.activeId = defaultActiveId();
        } else {
          state.activeId = (state.profiles[0] && state.profiles[0].id) || null;
        }
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

  // Ordre personnalise des personnages (fleches monter/descendre, demande
  // utilisateur 2026-09-17) : purement local a cette installation de
  // Companion, independant de StatsDB.charOrder cote addon (que Companion ne
  // peut de toute facon pas reecrire depuis ici). Juste une liste d'ids
  // ("Nom-Royaume") dans l'ordre voulu.
  var PROFILE_ORDER_KEY = "tibisuite-dashboard-profile-order-v1";
  // Section "Donnee live Tibiscui" (mode fixe) : cle separee pour que
  // reordonner ses chips ne touche pas l'ordre de "Mon Dashboard".
  var PROFILE_ORDER_KEY_FIXED = "tibisuite-dashboard-profile-order-fixed-v1";
  function loadProfileOrder(fixed) {
    try {
      var raw = localStorage.getItem(fixed ? PROFILE_ORDER_KEY_FIXED : PROFILE_ORDER_KEY);
      var list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list : [];
    } catch (e) { return []; }
  }
  function saveProfileOrder(order, fixed) {
    try { localStorage.setItem(fixed ? PROFILE_ORDER_KEY_FIXED : PROFILE_ORDER_KEY, JSON.stringify(order)); } catch (e) {}
  }

  // Ordre par defaut de la section "Donnee live Tibiscui" (demande
  // utilisateur 2026-09-19) : Tibiscui puis Tibizcui en tete, tous les autres
  // ensuite dans leur ordre naturel. Simple base : un ordre choisi par le
  // visiteur (glisser-deposer, cf. PROFILE_ORDER_KEY_FIXED) reste prioritaire.
  var PRIORITY_NAMES = ["tibiscui", "tibizcui"];
  function withPriorityFirst(profiles) {
    var head = [], seen = {};
    PRIORITY_NAMES.forEach(function (name) {
      profiles.forEach(function (p) {
        var n = String((p.char && p.char.name) || "").toLowerCase();
        if (n === name && !seen[p.id]) { head.push(p); seen[p.id] = true; }
      });
    });
    return head.concat(profiles.filter(function (p) { return !seen[p.id]; }));
  }

  // Applique l'ordre persiste a une liste de profils fraichement (re)chargee
  // (paste, sync live, merge addon+API) : les ids connus d'abord dans l'ordre
  // sauvegarde, puis tout profil pas encore vu (nouveau personnage) ajoute a
  // la fin dans son ordre naturel - jamais perdu, juste pas encore range.
  function sortProfiles(profiles, fixed) {
    if (fixed) profiles = withPriorityFirst(profiles);
    var order = loadProfileOrder(fixed);
    if (!order.length) return profiles;
    var byId = {};
    profiles.forEach(function (p) { byId[p.id] = p; });
    var sorted = [], seen = {};
    order.forEach(function (id) {
      if (byId[id] && !seen[id]) { sorted.push(byId[id]); seen[id] = true; }
    });
    profiles.forEach(function (p) { if (!seen[p.id]) sorted.push(p); });
    return sorted;
  }

  // Personnages masques de la rangee de chips (X, demande utilisateur
  // 2026-09-17) : { id: true, ... }, purement local a cette installation.
  // Ne retire JAMAIS un personnage de state.profiles ni du stockage des
  // codes - "Compte" continue de tout additionner, cf. profileChipsHtml.
  var PROFILE_HIDDEN_KEY = "tibisuite-dashboard-profile-hidden-v1";
  function loadHiddenProfiles() {
    try {
      var raw = localStorage.getItem(PROFILE_HIDDEN_KEY);
      var obj = raw ? JSON.parse(raw) : {};
      return (obj && typeof obj === "object" && !Array.isArray(obj)) ? obj : {};
    } catch (e) { return {}; }
  }
  function saveHiddenProfiles(hidden) {
    try { localStorage.setItem(PROFILE_HIDDEN_KEY, JSON.stringify(hidden)); } catch (e) {}
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
      var profiles = Object.keys(chars).filter(function (key) {
        // Cles parasites du dictionnaire (ex. "charOrder", la liste d'ordre
        // des personnages stockee a cote des vrais - constate 2026-09-19 :
        // elle remontait en chip fantome vide) : un vrai personnage a toujours
        // une cle "Nom-Royaume".
        return key.indexOf("-") > 0;
      }).map(function (key) {
        var entry = chars[key] || {};
        var char = entry.char || {};
        // Repli sur la cle du dictionnaire ("Nom-Royaume", cf. SX.GetCharKeys
        // cote addon) si char.name/char.realm sont vides - constate en jeu
        // (2026-09-17) : le personnage COURANT peut s'exporter avec un objet
        // char.name/char.realm vides si UnitName()/GetRealmName() renvoient
        // vide au moment exact du logout (chargement/changement de royaume en
        // cours), alors que la cle du dictionnaire, ecrite plus tot par
        // StatsDB, reste toujours correcte. Sans ce repli, le personnage
        // remontait comme un chip fantome "?-?" sans nom.
        if (!char.name || !char.realm) {
          var sep = key.indexOf("-");
          if (sep > 0) {
            if (!char.name) char.name = key.slice(0, sep);
            if (!char.realm) char.realm = key.slice(sep + 1);
          }
        }
        return {
          id: (char.name || "?") + "-" + (char.realm || "?"), code: code, char: char,
          days: entry.days || {}, professions: entry.professions || {},
          weekly: entry.weekly || null,
          // WeeklyCompass phase 4 : onglet Personnages + fiche detaillee du
          // perso, et banque de Bataillon (commune au compte, meme valeur
          // recopiee sur chaque profil du code). Absents = addon ancien.
          compass: entry.compass || null,
          warband: data.warband || null,
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
    // Pas d'onRemove : le X de la rangee masque seulement (localStorage,
    // cf. hide-profile / PROFILE_HIDDEN_KEY), il ne touche plus jamais aux
    // codes stockes ici - un code d'export "compte" (schema v2) regroupe de
    // toute facon plusieurs personnages dans le MEME code, donc "retirer"
    // un seul personnage effacait auparavant tout le code jusqu'au prochain
    // /reload (confusion constatee 2026-09-17 : "Compte" ne recomptait plus
    // les personnages "fermes").
    var app = createApp(container, {
      fixed: false,
      profiles: profiles,
      startOnAccount: !!(formEls && formEls.startOnAccount),
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
          app.setProfiles(refreshed, formEls.startOnAccount ? undefined : newIds[0]);
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
      saveProfileOrder([]);
      saveHiddenProfiles({});
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
        // Seul l'addon connait la semaine WeeklyCompass (l'API n'en a pas).
        weekly: a.weekly || b.weekly || null,
        compass: a.compass || b.compass || null,
        warband: a.warband || b.warband || null,
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
