// Bridge for the floating recording controls. Deliberately tiny: pause, stop, show the studio.
const { contextBridge, ipcRenderer } = require('electron');

const EVENTS = ['control:paused', 'control:tick', 'control:agent'];

contextBridge.exposeInMainWorld('controls', {
  getState: () => ipcRenderer.invoke('control:get-state'),
  togglePause: () => ipcRenderer.send('control:pause'),
  stop: () => ipcRenderer.send('control:stop'),
  showStudio: () => ipcRenderer.send('control:show-studio'),
  on(channel, callback) {
    if (EVENTS.includes(channel)) ipcRenderer.on(channel, (_event, value) => callback(value));
  }
});
