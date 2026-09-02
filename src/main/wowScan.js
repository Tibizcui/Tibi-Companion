"use strict";
/* ============================================================================
   wowScan — détection des installations WoW et des comptes suivis
   ----------------------------------------------------------------------------
   Cherche des fichiers <racine>/_retail_/WTF/Account/<COMPTE>/SavedVariables/
   Stats.lua (module Stats de TibiSuite, pas TibiSuite.lua : voir CLAUDE.md).
============================================================================ */

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

function defaultRoots() {
  const roots = [];
  if (process.platform === "win32") {
    roots.push(
      "C:\\Program Files (x86)\\World of Warcraft",
      "C:\\Program Files\\World of Warcraft",
      "D:\\World of Warcraft",
      "D:\\Jeux\\World of Warcraft",
      "E:\\World of Warcraft"
    );
  } else if (process.platform === "darwin") {
    roots.push(
      "/Applications/World of Warcraft",
      path.join(os.homedir(), "Applications/World of Warcraft")
    );
  }
  return roots.filter((r) => {
    try { return fs.statSync(r).isDirectory(); } catch (e) { return false; }
  });
}

// Liste les comptes détectés sous une racine WoW donnée (retail uniquement,
// c'est la seule version que TibiSuite cible actuellement).
function listAccounts(wowRoot) {
  const accountsDir = path.join(wowRoot, "_retail_", "WTF", "Account");
  let entries;
  try { entries = fs.readdirSync(accountsDir, { withFileTypes: true }); }
  catch (e) { return []; }

  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const statsPath = path.join(accountsDir, entry.name, "SavedVariables", "Stats.lua");
    let exists = false;
    try { exists = fs.statSync(statsPath).isFile(); } catch (e) { /* pas encore créé */ }
    out.push({ account: entry.name, statsPath, exists });
  }
  return out;
}

// Détection automatique au premier lancement : essaie les racines par défaut,
// remonte tous les comptes trouvés (avec ou sans Stats.lua déjà présent).
function autoDetect() {
  const found = [];
  for (const root of defaultRoots()) {
    for (const acc of listAccounts(root)) {
      found.push({ wowRoot: root, ...acc });
    }
  }
  return found;
}

// Un dossier choisi à la main par l'utilisateur peut être la racine WoW
// elle-même, ou un dossier plus profond (ex: directement _retail_). On
// cherche jusqu'à 3 niveaux pour retomber sur "_retail_/WTF/Account".
function scanChosenFolder(chosenDir) {
  const candidates = [
    chosenDir,
    path.join(chosenDir, ".."),
    path.dirname(chosenDir),
  ];
  const seen = new Set();
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    const accounts = listAccounts(resolved);
    if (accounts.length) return { wowRoot: resolved, accounts };
  }
  // Dernier recours : le dossier choisi contient peut-être directement
  // _retail_ (ex: l'utilisateur a pointé vers World of Warcraft/_retail_).
  const asParent = path.resolve(chosenDir, "..");
  const accounts = listAccounts(asParent);
  return { wowRoot: asParent, accounts };
}

module.exports = { defaultRoots, listAccounts, autoDetect, scanChosenFolder };
