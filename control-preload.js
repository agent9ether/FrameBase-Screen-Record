// Bridge for the floating recording controls. Deliberately tiny: record, pause, stop, show the studio, hide the bar.
const { contextBridge, ipcRenderer } = require('electron');

const EVENTS = ['control:recording', 'control:paused', 'control:tick', 'control:agent'];

contextBridge.exposeInMainWorld('controls', {
  getState: () => ipcRenderer.invoke('control:get-state'),
  record: () => ipcRenderer.send('control:record'),
  hide: () => ipcRenderer.send('control:hide'),
  togglePause: () => ipcRenderer.send('control:pause'),
  stop: () => ipcRenderer.send('control:stop'),
  showStudio: () => ipcRenderer.send('control:show-studio'),
  on(channel, callback) {
    if (EVENTS.includes(channel)) ipcRenderer.on(channel, (_event, value) => callback(value));
  }
});
