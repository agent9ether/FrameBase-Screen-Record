const { contextBridge, ipcRenderer } = require('electron');
const { fixWebmDuration } = require('@fix-webm-duration/fix');
contextBridge.exposeInMainWorld('studio', {
  getSources: () => ipcRenderer.invoke('capture:sources'),
  setCaptureSelection: (sourceId, systemAudio) => ipcRenderer.invoke('capture:set-selection', sourceId, systemAudio),
  fixWebmDuration: async (data, duration) => {
    const blob = new Blob([data], { type: 'video/webm' });
    const fixed = await fixWebmDuration(blob, duration, { logger: false });
    return fixed.arrayBuffer();
  },
  saveProject: payload => ipcRenderer.invoke('project:save', payload),
  openProject: () => ipcRenderer.invoke('project:open'),
  exportVideo: options => ipcRenderer.invoke('video:export', options),
  startFloatingControls: () => ipcRenderer.send('recording:started'),
  setPaused: paused => ipcRenderer.send('recording:paused', paused),
  tick: seconds => ipcRenderer.send('recording:tick', seconds),
  recordingStopped: () => ipcRenderer.send('recording:stopped'),
  togglePause: () => ipcRenderer.send('control:pause'),
  stop: () => ipcRenderer.send('control:stop'),
  showStudio: () => ipcRenderer.send('control:show-studio'),
  agentInfo: () => ipcRenderer.invoke('agent:info'),
  agentSetEnabled: enabled => ipcRenderer.invoke('agent:set-enabled', enabled),
  agentSetAllowScreens: value => ipcRenderer.invoke('agent:set-allow-screens', value),
  agentRotateToken: () => ipcRenderer.invoke('agent:rotate-token'),
  agentRevealToken: () => ipcRenderer.invoke('agent:reveal-token'),
  agentSaveRecording: (data, durationMs) => ipcRenderer.invoke('agent:save-recording', data, durationMs / 1000),
  agentResult: result => ipcRenderer.send('agent:result', result),
  onControl: (channel, callback) => {
    const allowed = ['recording:toggle-pause', 'recording:stop', 'studio:focus-editor'];
    if (allowed.includes(channel)) ipcRenderer.on(channel, callback);
  },
  onMiniControl: (channel, callback) => {
    const allowed = ['control:paused', 'control:tick', 'control:agent'];
    if (allowed.includes(channel)) ipcRenderer.on(channel, (_event, value) => callback(value));
  }
});
