"use strict";
/* ============================================================================
   store — configuration persistée (JSON local, zéro dépendance)
   ----------------------------------------------------------------------------
   { watchedAccounts: [{id, wowRoot, account, statsPath, label}], autostart }
============================================================================ */

const fs = require("node:fs");
const path = require("node:path");

function makeStore(userDataDir) {
  const filePath = path.join(userDataDir, "config.json");

  function load() {
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw);
      return {
        watchedAccounts: Array.isArray(parsed.watchedAccounts) ? parsed.watchedAccounts : [],
        autostart: !!parsed.autostart,
      };
    } catch (e) {
      return { watchedAccounts: [], autostart: false };
    }
  }

  function save(data) {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
  }

  return { load, save };
}

module.exports = { makeStore };
