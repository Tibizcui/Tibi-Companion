"use strict";
/* ============================================================================
   app.js — colle le watcher (process main) au moteur TibiDashboard (vendor)
============================================================================ */

(function () {
  const onboarding = document.getElementById("onboarding");
  const onboardingDetected = document.getElementById("onboarding-detected");
  const dashboardArea = document.getElementById("dashboard-area");
  const statusDot = document.getElementById("status-dot");
  const statusText = document.getElementById("status-text");
  const chkAutostart = document.getElementById("chk-autostart");
  const btnAddAccount = document.getElementById("btn-add-account");
  const btnScanDefault = document.getElementById("btn-scan-default");
  const btnPickFolder = document.getElementById("btn-pick-folder");
  const manualToggle = document.getElementById("manual-toggle");
  const manualPaste = document.getElementById("manual-paste");
  const dashInput = document.getElementById("dash-input");
  const dashGo = document.getElementById("dash-go");
  const dashFormError = document.getElementById("dash-form-error");
  const dashResult = document.getElementById("dash-result");

  let dashApp = null;
  const accountLabels = new Map(); // id -> label, pour les messages de statut

  function setStatus(kind, text) {
    statusDot.className = "status-dot" + (kind ? " " + kind : "");
    statusText.textContent = text;
  }

  function ensureDashApp() {
    if (dashApp) return dashApp;
    dashApp = window.TibiDashboard.mountGeneric(dashResult, {
      input: dashInput,
      submit: dashGo,
      onSuccess: function () {
        dashFormError.innerHTML = "";
        dashInput.value = "";
      },
      onError: function (err) {
        dashFormError.innerHTML =
          '<p class="dash-error">Impossible de lire ce code (' + err.message + ').</p>';
      },
    });
    return dashApp;
  }

  function feedBlob(blob) {
    dashInput.value = blob;
    dashGo.click();
  }

  function renderAccountList(container, wowRoot, accounts) {
    container.hidden = false;
    container.innerHTML = "";
    if (!accounts.length) {
      const empty = document.createElement("div");
      empty.className = "account-row";
      empty.innerHTML = '<div class="meta">Aucun compte WoW trouvé dans ce dossier.</div>';
      container.appendChild(empty);
      return;
    }

    function makeRow(acc) {
      const row = document.createElement("div");
      row.className = "account-row";
      const meta = document.createElement("div");
      meta.className = "meta";
      const strong = document.createElement("strong");
      strong.textContent = acc.account;
      const small = document.createElement("small");
      small.textContent = acc.exists ? "Stats.lua détecté" : "Pas encore de Stats.lua (fais un /reload en jeu)";
      meta.appendChild(strong);
      meta.appendChild(small);
      const btn = document.createElement("button");
      btn.className = "btn primary small";
      btn.type = "button";
      btn.textContent = "Ajouter";
      btn.addEventListener("click", async function () {
        await window.companionAPI.addAccount({ wowRoot, account: acc.account, statsPath: acc.statsPath });
        onboarding.hidden = true;
        dashboardArea.hidden = false;
        ensureDashApp();
      });
      row.appendChild(meta);
      row.appendChild(btn);
      return row;
    }

    // Priorité au(x) compte(s) qui ont déjà un export prêt : les dossiers
    // sans Stats.lua (vieux comptes, dossiers orphelins) n'ont rien
    // d'exploitable, on les relègue dans un tiroir replié plutôt que de les
    // afficher sur un pied d'égalité (source de confusion sinon).
    const ready = accounts.filter(function (a) { return a.exists; });
    const notReady = accounts.filter(function (a) { return !a.exists; });

    if (!ready.length) {
      const hint = document.createElement("p");
      hint.className = "dash-paste-hint";
      hint.textContent = "Aucun de ces dossiers n'a encore de code d'export : fais un /reload en jeu (avec le module Stats de TibiSuite actif), puis reviens ici.";
      container.appendChild(hint);
    }
    ready.forEach(function (acc) { container.appendChild(makeRow(acc)); });

    if (notReady.length) {
      const details = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = "Autres dossiers détectés sans export (" + notReady.length + ")";
      details.appendChild(summary);
      notReady.forEach(function (acc) { details.appendChild(makeRow(acc)); });
      container.appendChild(details);
    }
  }

  async function scanDefault() {
    setStatus("", "Détection en cours…");
    const found = await window.companionAPI.autoDetect();
    const byRoot = new Map();
    found.forEach(function (f) {
      if (!byRoot.has(f.wowRoot)) byRoot.set(f.wowRoot, []);
      byRoot.get(f.wowRoot).push(f);
    });
    if (!found.length) {
      setStatus("warn", "Aucune installation détectée automatiquement, choisis le dossier à la main.");
      return;
    }
    const [firstRoot, accounts] = byRoot.entries().next().value;
    renderAccountList(onboardingDetected, firstRoot, accounts);
    setStatus("", "Choisis le compte à suivre.");
  }

  async function pickFolder() {
    const res = await window.companionAPI.pickFolder();
    if (!res) return;
    renderAccountList(onboardingDetected, res.wowRoot, res.accounts);
  }

  async function init() {
    const state = await window.companionAPI.getState();
    chkAutostart.checked = !!state.autostart;
    state.accounts.forEach(function (a) { accountLabels.set(a.id, a.label || a.account); });

    if (state.accounts.length) {
      onboarding.hidden = true;
      dashboardArea.hidden = false;
      ensureDashApp();
      setStatus("", "En attente d'un /reload en jeu…");
    } else {
      onboarding.hidden = false;
      dashboardArea.hidden = true;
      setStatus("warn", "Aucun compte suivi pour le moment.");
    }
  }

  btnScanDefault.addEventListener("click", scanDefault);
  btnPickFolder.addEventListener("click", pickFolder);
  btnAddAccount.addEventListener("click", function () {
    onboarding.hidden = false;
    onboardingDetected.hidden = true;
    onboardingDetected.innerHTML = "";
  });
  manualToggle.addEventListener("click", function () {
    manualPaste.classList.toggle("open");
  });
  chkAutostart.addEventListener("change", function () {
    window.companionAPI.setAutostart(chkAutostart.checked);
  });

  window.companionAPI.onExportUpdate(function (payload) {
    ensureDashApp();
    feedBlob(payload.blob);
    const label = accountLabels.get(payload.id) || "compte";
    const time = new Date(payload.at).toLocaleTimeString("fr-FR");
    setStatus("ok", "Synchronisé (" + label + ") à " + time);
  });

  window.companionAPI.onExportError(function (payload) {
    const label = accountLabels.get(payload.id) || "compte";
    setStatus("warn", label + " : " + payload.message);
  });

  init();
})();
