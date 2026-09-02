"use strict";
/* ============================================================================
   main — cycle de vie de l'app, fenêtre, tray, IPC
============================================================================ */

const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, nativeImage } = require("electron");
const path = require("node:path");
const crypto = require("node:crypto");

const wowScan = require("./wowScan");
const { WatcherPool } = require("./watcher");
const { makeStore } = require("./store");

// Logo TibiSuite (copie de Tibiscui.fr/medias/Logo_Site.png, 1024x1024).
// nativeImage.resize() (natif Electron/Skia) suffit pour la fenêtre et le
// tray : pas besoin de générer des variantes basse résolution à la main.
const ICON_PATH = path.join(__dirname, "..", "assets", "icon.png");
const appIcon = nativeImage.createFromPath(ICON_PATH);

let mainWindow = null;
let tray = null;
let store = null;
let watcherPool = null;
let quitting = false;

function accountId(wowRoot, account) {
  return crypto.createHash("md5").update(wowRoot + "|" + account).digest("hex").slice(0, 12);
}

function sendToRenderer(channel, ...args) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, ...args);
}

function startWatchers() {
  const cfg = store.load();
  watcherPool.setAccounts(
    cfg.watchedAccounts.map((a) => ({ id: a.id, statsPath: a.statsPath }))
  );
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 860,
    minHeight: 600,
    backgroundColor: "#0a0b0e",
    icon: appIcon,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));

  mainWindow.on("close", (e) => {
    if (quitting) return;
    // Ferme vers le tray plutôt que quitter : le watcher continue en fond.
    e.preventDefault();
    mainWindow.hide();
  });
}

function createTray() {
  // Le tray attend une petite image (Windows/macOS l'affichent en ~16-22px) :
  // on part du même logo mais redimensionné pour rester net à cette taille.
  const trayIcon = appIcon.resize({ width: 32, height: 32, quality: "best" });
  tray = new Tray(trayIcon);
  tray.setToolTip("Tibi Companion");
  const menu = Menu.buildFromTemplate([
    { label: "Ouvrir Tibi Companion", click: () => { mainWindow.show(); } },
    { type: "separator" },
    { label: "Quitter", click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.on("click", () => { mainWindow.show(); });
}

function registerIpc() {
  ipcMain.handle("companion:get-state", () => {
    const cfg = store.load();
    return { accounts: cfg.watchedAccounts, autostart: cfg.autostart };
  });

  ipcMain.handle("companion:auto-detect", () => wowScan.autoDetect());

  ipcMain.handle("companion:pick-folder", async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: "Choisis le dossier d'installation de World of Warcraft",
      properties: ["openDirectory"],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    const { wowRoot, accounts } = wowScan.scanChosenFolder(res.filePaths[0]);
    return { wowRoot, accounts };
  });

  ipcMain.handle("companion:add-account", (evt, { wowRoot, account, statsPath }) => {
    const cfg = store.load();
    const id = accountId(wowRoot, account);
    if (!cfg.watchedAccounts.some((a) => a.id === id)) {
      cfg.watchedAccounts.push({ id, wowRoot, account, statsPath, label: account });
      store.save(cfg);
    }
    startWatchers();
    return cfg.watchedAccounts;
  });

  ipcMain.handle("companion:remove-account", (evt, id) => {
    const cfg = store.load();
    cfg.watchedAccounts = cfg.watchedAccounts.filter((a) => a.id !== id);
    store.save(cfg);
    startWatchers();
    return cfg.watchedAccounts;
  });

  ipcMain.handle("companion:set-autostart", (evt, enabled) => {
    const cfg = store.load();
    cfg.autostart = !!enabled;
    store.save(cfg);
    app.setLoginItemSettings({ openAtLogin: cfg.autostart, openAsHidden: true });
    return cfg.autostart;
  });
}

app.whenReady().then(() => {
  store = makeStore(app.getPath("userData"));
  watcherPool = new WatcherPool(
    (id, blob) => sendToRenderer("companion:export-update", { id, blob, at: Date.now() }),
    (id, message) => sendToRenderer("companion:export-error", { id, message })
  );

  // Applique l'état de démarrage auto sauvegardé (au cas où il aurait été
  // changé hors app, ex: réinstallation).
  const cfg = store.load();
  app.setLoginItemSettings({ openAtLogin: cfg.autostart, openAsHidden: true });

  registerIpc();
  createWindow();
  createTray();
  // Attendre que la page ait fini de charger avant de démarrer les watchers :
  // readOnce() pousse immédiatement le dernier export connu au renderer, or
  // si ce push arrive avant que app.js ait enregistré son écouteur
  // onExportUpdate, le message est perdu pour de bon (pas de mise en file
  // d'attente côté Electron) et le dashboard reste vide jusqu'au prochain
  // vrai /reload en jeu.
  mainWindow.webContents.once("did-finish-load", startWatchers);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else mainWindow.show();
  });
});

app.on("before-quit", () => { quitting = true; watcherPool && watcherPool.stopAll(); });
app.on("window-all-closed", () => { /* on reste en tray, cf. app.on(close) */ });
