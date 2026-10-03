'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// `root` is 'config' (the folder from config.cfg) or 'picked' (the one just chosen in the dialog).
contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),
  chooseGameDir: () => ipcRenderer.invoke('dialog:gameDir'),
  fsList: (root, rel) => ipcRenderer.invoke('fs:list', root, rel),
  fsStat: (root, rel) => ipcRenderer.invoke('fs:stat', root, rel),
  fsRead: (root, rel, length) => ipcRenderer.invoke('fs:read', root, rel, length),
});
