const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('studio', {
  getSources: () => ipcRenderer.invoke('capture:sources'),
  startFloatingControls: () => ipcRenderer.send('recording:started'),
  setPaused: paused => ipcRenderer.send('recording:paused', paused),
  tick: seconds => ipcRenderer.send('recording:tick', seconds),
  recordingStopped: () => ipcRenderer.send('recording:stopped'),
  togglePause: () => ipcRenderer.send('control:pause'),
  stop: () => ipcRenderer.send('control:stop'),
  showStudio: () => ipcRenderer.send('control:show-studio'),
  onControl: (channel, callback) => {
    const allowed = ['recording:toggle-pause', 'recording:stop', 'studio:focus-editor'];
    if (allowed.includes(channel)) ipcRenderer.on(channel, callback);
  },
  onMiniControl: (channel, callback) => {
    const allowed = ['control:paused', 'control:tick'];
    if (allowed.includes(channel)) ipcRenderer.on(channel, (_event, value) => callback(value));
  }
});
