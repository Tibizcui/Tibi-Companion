"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("companionAPI", {
  getState: () => ipcRenderer.invoke("companion:get-state"),
  autoDetect: () => ipcRenderer.invoke("companion:auto-detect"),
  pickFolder: () => ipcRenderer.invoke("companion:pick-folder"),
  addAccount: (payload) => ipcRenderer.invoke("companion:add-account", payload),
  removeAccount: (id) => ipcRenderer.invoke("companion:remove-account", id),
  setAutostart: (enabled) => ipcRenderer.invoke("companion:set-autostart", enabled),

  onExportUpdate: (cb) => {
    const handler = (evt, payload) => cb(payload);
    ipcRenderer.on("companion:export-update", handler);
    return () => ipcRenderer.removeListener("companion:export-update", handler);
  },
  onExportError: (cb) => {
    const handler = (evt, payload) => cb(payload);
    ipcRenderer.on("companion:export-error", handler);
    return () => ipcRenderer.removeListener("companion:export-error", handler);
  },
});
