"use strict";
/* ============================================================================
   watcher — surveille un ou plusieurs Stats.lua et extrait StatsDB.export
   ----------------------------------------------------------------------------
   Portage du coeur de Tibiscui.fr/tools/companion/companion.mjs, sans la
   partie publication (git/SFTP/FTP) : ici on émet juste le blob décodé vers
   le renderer, rien n'est jamais envoyé ailleurs.

   Limite honnête (héritée du companion.mjs) : WoW n'écrit ce fichier qu'au
   /reload ou à la déconnexion, pas en temps réel.
============================================================================ */

const fs = require("node:fs");

const POLL_INTERVAL_MS = 2000;
const DEBOUNCE_MS = 1500;

// StatsDB.export est écrit par l'addon comme ["export"] = "<base64...>" .
// Le code est du Base64 imprimable (A-Za-z0-9+/=) : pas de guillemet ni
// d'antislash dedans, donc [^"]* est sûr.
function extractExport(luaText) {
  const m = luaText.match(/\["export"\]\s*=\s*"([^"]*)"/);
  return m ? m[1] : null;
}

class AccountWatcher {
  constructor(id, statsPath, onUpdate, onError) {
    this.id = id;
    this.statsPath = statsPath;
    this.onUpdate = onUpdate;
    this.onError = onError;
    this.lastBlob = null;
    this._debTimer = null;
    this._watching = false;
  }

  readOnce() {
    let luaText;
    try { luaText = fs.readFileSync(this.statsPath, "utf8"); }
    catch (e) { this.onError && this.onError(this.id, "Lecture impossible : " + e.message); return; }

    const blob = extractExport(luaText);
    if (!blob) {
      this.onError && this.onError(this.id, "Aucun code d'export trouvé (fais un /reload en jeu au moins une fois).");
      return;
    }
    if (blob === this.lastBlob) return;
    this.lastBlob = blob;
    this.onUpdate && this.onUpdate(this.id, blob);
  }

  start() {
    if (this._watching) return;
    this._watching = true;
    this.readOnce();
    fs.watchFile(this.statsPath, { interval: POLL_INTERVAL_MS }, (curr, prev) => {
      if (curr.mtimeMs === prev.mtimeMs && curr.size === prev.size) return;
      if (this._debTimer) clearTimeout(this._debTimer);
      this._debTimer = setTimeout(() => this.readOnce(), DEBOUNCE_MS);
    });
  }

  stop() {
    if (!this._watching) return;
    this._watching = false;
    if (this._debTimer) clearTimeout(this._debTimer);
    fs.unwatchFile(this.statsPath);
  }
}

// Gère un ensemble de comptes surveillés simultanément (multi-compte WoW).
class WatcherPool {
  constructor(onUpdate, onError) {
    this.onUpdate = onUpdate;
    this.onError = onError;
    this.watchers = new Map(); // id -> AccountWatcher
  }

  setAccounts(accounts) {
    const nextIds = new Set(accounts.map((a) => a.id));
    for (const [id, w] of this.watchers) {
      if (!nextIds.has(id)) { w.stop(); this.watchers.delete(id); }
    }
    for (const acc of accounts) {
      if (this.watchers.has(acc.id)) continue;
      const w = new AccountWatcher(acc.id, acc.statsPath, this.onUpdate, this.onError);
      this.watchers.set(acc.id, w);
      w.start();
    }
  }

  stopAll() {
    for (const w of this.watchers.values()) w.stop();
    this.watchers.clear();
  }
}

module.exports = { extractExport, AccountWatcher, WatcherPool };
