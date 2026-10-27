const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('studio', { getSources: () => ipcRenderer.invoke('capture:sources') });
