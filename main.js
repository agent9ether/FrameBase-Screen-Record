const { app, BrowserWindow, desktopCapturer, ipcMain, screen, session } = require('electron');
const path = require('node:path');

let studioWindow = null;
let controlWindow = null;
let isRecording = false;
let captureSelection = null;

function createWindow() {
  studioWindow = new BrowserWindow({
    width: 1440, height: 920, minWidth: 1100, minHeight: 720,
    title: 'FrameBase Studio', backgroundColor: '#0b0c0e',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false }
  });
  studioWindow.loadFile('index.html');
  studioWindow.on('close', event => {
    if (isRecording) {
      event.preventDefault();
      studioWindow.hide();
    }
  });
}

function createControlWindow() {
  if (controlWindow && !controlWindow.isDestroyed()) {
    controlWindow.show();
    return;
  }
  const area = screen.getPrimaryDisplay().workArea;
  controlWindow = new BrowserWindow({
    width: 560, height: 74,
    x: Math.round(area.x + (area.width - 560) / 2), y: area.y + area.height - 94,
    title: 'FrameBase Recording Controls', backgroundColor: '#00000000',
    frame: false, transparent: true, resizable: false, movable: true,
    alwaysOnTop: true, skipTaskbar: true, hasShadow: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false }
  });
  controlWindow.setAlwaysOnTop(true);
  controlWindow.setVisibleOnAllWorkspaces(true);
  controlWindow.loadFile('mini-control.html');
  controlWindow.on('closed', () => { controlWindow = null; });
}

function showStudio() {
  if (!studioWindow || studioWindow.isDestroyed()) createWindow();
  studioWindow.show();
  studioWindow.restore();
  studioWindow.focus();
  studioWindow.webContents.send('studio:focus-editor');
}

app.whenReady().then(() => {
  ipcMain.handle('capture:sources', async () => {
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 200 } });
    return sources.map(({ id, name, thumbnail }) => ({ id, name, type: id.startsWith('window:') ? 'window' : 'screen', image: thumbnail.toDataURL() }));
  });
  ipcMain.handle('capture:set-selection', (_event, sourceId, systemAudio) => {
    captureSelection = { sourceId, systemAudio: Boolean(systemAudio) };
  });
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const selection = captureSelection;
      captureSelection = null;
      if (!selection) return callback(null);
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
      const source = sources.find(item => item.id === selection.sourceId);
      if (!source) return callback(null);
      callback({ video: source, ...(selection.systemAudio && process.platform === 'win32' ? { audio: 'loopback' } : {}) });
    } catch {
      callback(null);
    }
  });
  ipcMain.on('recording:started', () => {
    isRecording = true;
    createControlWindow();
    if (studioWindow && !studioWindow.isDestroyed()) studioWindow.hide();
  });
  ipcMain.on('recording:paused', (_event, paused) => {
    if (controlWindow && !controlWindow.isDestroyed()) controlWindow.webContents.send('control:paused', paused);
  });
  ipcMain.on('recording:tick', (_event, seconds) => {
    if (controlWindow && !controlWindow.isDestroyed()) controlWindow.webContents.send('control:tick', seconds);
  });
  ipcMain.on('recording:stopped', () => {
    isRecording = false;
    if (controlWindow && !controlWindow.isDestroyed()) controlWindow.close();
    showStudio();
  });
  ipcMain.on('control:pause', () => {
    if (studioWindow && !studioWindow.isDestroyed()) studioWindow.webContents.send('recording:toggle-pause');
  });
  ipcMain.on('control:stop', () => {
    if (studioWindow && !studioWindow.isDestroyed()) studioWindow.webContents.send('recording:stop');
  });
  ipcMain.on('control:show-studio', () => showStudio());
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
