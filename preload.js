// The studio window's only bridge to the main process. Runs sandboxed: no Node modules here.
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);
const send = (channel, ...args) => ipcRenderer.send(channel, ...args);
const EVENTS = ['recording:toggle-pause', 'recording:stop', 'studio:focus-editor', 'editor:open', 'studio:recovered', 'studio:open-record'];

contextBridge.exposeInMainWorld('studio', {
  platform: process.platform,
  appInfo: () => invoke('app:info'),
  getSources: () => invoke('capture:sources'),
  setCaptureSelection: (sourceId, systemAudio) => invoke('capture:set-selection', sourceId, systemAudio),
  recording: {
    begin: () => invoke('recording:begin'),
    chunk: data => invoke('recording:chunk', data),
    finish: durationMs => invoke('recording:finish', durationMs),
    failed: message => send('recording:failed', message),
    paused: paused => send('recording:paused', paused),
    tick: seconds => send('recording:tick', seconds)
  },
  media: {
    list: limit => invoke('media:list', limit),
    import: () => invoke('media:import'),
    reveal: token => invoke('media:reveal', token),
    openFolder: () => invoke('media:open-folder')
  },
  project: {
    save: payload => invoke('project:save', payload),
    open: () => invoke('project:open')
  },
  exporter: {
    begin: options => invoke('export:begin', options),
    fromSource: (id, token) => invoke('export:from-source', id, token),
    chunk: (id, data) => invoke('export:chunk', id, data),
    finish: (id, durationMs) => invoke('export:finish', id, durationMs),
    cancel: id => invoke('export:cancel', id)
  },
  agent: {
    info: () => invoke('agent:info'),
    setEnabled: enabled => invoke('agent:set-enabled', enabled),
    setAllowScreens: value => invoke('agent:set-allow-screens', value),
    setAllowMicrophone: value => invoke('agent:set-allow-microphone', value),
    rotateToken: () => invoke('agent:rotate-token'),
    revealToken: () => invoke('agent:reveal-token'),
    startFailed: message => send('agent:start-failed', message)
  },
  on(channel, callback) {
    if (EVENTS.includes(channel)) ipcRenderer.on(channel, (_event, value) => callback(value));
  }
});
