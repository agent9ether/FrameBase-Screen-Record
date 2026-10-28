const { app, BrowserWindow, desktopCapturer, dialog, ipcMain, safeStorage, screen, session } = require('electron');
const { createAgentServer } = require('./agent-server');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);

let studioWindow = null;
let controlWindow = null;
let isRecording = false;
let captureSelection = null;
let recordingSeconds = 0;
let recordingPaused = false;
let agentSession = false;
let agentStopTimer = null;
let lastSavedRecording = null;
let agent = null;
const agentWaiters = new Map();

function waitForAgentResult(kind, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { agentWaiters.delete(kind); reject(new Error(`Timed out waiting for the recorder (${kind}).`)); }, timeoutMs);
    agentWaiters.set(kind, result => { clearTimeout(timer); resolve(result); });
  });
}

function recordingsFolder() { return path.join(app.getPath('documents'), 'FrameBase Recordings'); }

// What the optional MCP server is allowed to do. It reuses the same renderer recording flow a person uses.
const agentController = {
  async listSources() {
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
    return sources
      .filter(({ name }) => name !== 'FrameBase Recording Controls')
      .map(({ id, name }) => ({ id, name, type: id.startsWith('window:') ? 'window' : 'screen' }));
  },
  async start({ sourceId, systemAudio, microphone, maxSeconds }) {
    if (isRecording) throw new Error('A recording is already running. Stop it first.');
    if (!studioWindow || studioWindow.isDestroyed()) createWindow();
    agentSession = true;
    const started = waitForAgentResult('start', 20000);
    // run with a simulated user gesture: Chromium only allows screen capture to start from one
    studioWindow.webContents.executeJavaScript(`window.__agentStart(${JSON.stringify({ sourceId, systemAudio: Boolean(systemAudio), microphone: Boolean(microphone) })})`, true).catch(() => {});
    let result;
    try { result = await started; } catch (error) { agentSession = false; throw error; }
    if (!result.ok) { agentSession = false; throw new Error(result.error || 'The recording did not start.'); }
    clearTimeout(agentStopTimer);
    agentStopTimer = setTimeout(() => { agentController.stop().catch(() => {}); }, maxSeconds * 1000);
    return result;
  },
  async setPaused(wanted) {
    if (!isRecording) throw new Error('Nothing is recording.');
    if (recordingPaused !== wanted && studioWindow && !studioWindow.isDestroyed()) studioWindow.webContents.send('recording:toggle-pause');
    return { paused: wanted };
  },
  async stop() {
    if (!isRecording) throw new Error('Nothing is recording.');
    clearTimeout(agentStopTimer);
    if (!agentSession) throw new Error('This recording was started by the user, not an agent, so an agent cannot stop it. The user can stop it from the floating controls.');
    const stopped = waitForAgentResult('stopped', 120000);
    studioWindow.webContents.send('recording:stop');
    const result = await stopped;
    agentSession = false;
    if (!result.ok) throw new Error(result.error || 'The recording could not be saved.');
    lastSavedRecording = { file: result.file, seconds: result.seconds, bytes: result.bytes };
    return lastSavedRecording;
  },
  async stopIfAgent() {
    if (isRecording && agentSession) await agentController.stop().catch(() => {});
  },
  status() {
    return { recording: isRecording, paused: recordingPaused, seconds: recordingSeconds, started_by_agent: isRecording && agentSession, last_saved: lastSavedRecording };
  }
};

function createWindow() {
  studioWindow = new BrowserWindow({
    width: 1440, height: 920, minWidth: 1100, minHeight: 720,
    title: 'FrameBase Studio', backgroundColor: '#0b0c0e',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false, autoplayPolicy: 'no-user-gesture-required' }
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
  ipcMain.handle('project:save', async (_event, payload) => {
    const result = await dialog.showSaveDialog(studioWindow, { title: 'Save FrameBase project', defaultPath: `${payload.name || 'Untitled project'}.framebase`, filters: [{ name: 'FrameBase project', extensions: ['framebase'] }] });
    if (result.canceled || !result.filePath) return { canceled: true };
    await fs.writeFile(result.filePath, JSON.stringify(payload));
    return { canceled: false, filePath: result.filePath };
  });
  ipcMain.handle('project:open', async () => {
    const result = await dialog.showOpenDialog(studioWindow, { title: 'Open FrameBase project', properties: ['openFile'], filters: [{ name: 'FrameBase project', extensions: ['framebase'] }] });
    if (result.canceled || !result.filePaths[0]) return null;
    return JSON.parse(await fs.readFile(result.filePaths[0], 'utf8'));
  });
  ipcMain.handle('video:export', async (_event, { bytes, name, format, inputType }) => {
    const extension = format === 'mp4' ? 'mp4' : 'webm';
    const result = await dialog.showSaveDialog(studioWindow, { title: `Export ${extension.toUpperCase()} video`, defaultPath: `${name || 'FrameBase recording'}.${extension}`, filters: [{ name: `${extension.toUpperCase()} video`, extensions: [extension] }] });
    if (result.canceled || !result.filePath) return { canceled: true };
    const source = Buffer.from(bytes);
    if (format === 'webm' && inputType === 'video/webm') { await fs.writeFile(result.filePath, source); return { canceled: false, filePath: result.filePath }; }
    const temporary = path.join(os.tmpdir(), `framebase-${Date.now()}.webm`);
    const converted = path.join(os.tmpdir(), `framebase-${Date.now()}.${extension}`);
    await fs.writeFile(temporary, source);
    try {
      const videoArgs = format === 'mp4' ? ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart'] : ['-c:v', 'libvpx-vp9', '-crf', '30', '-b:v', '0', '-c:a', 'libopus', '-b:a', '192k'];
      await execFileAsync('ffmpeg', ['-y', '-i', temporary, '-map', '0:v:0', '-map', '0:a?', ...videoArgs, converted], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
      await fs.rename(converted, result.filePath);
      return { canceled: false, filePath: result.filePath };
    } catch (error) {
      throw new Error(error.code === 'ENOENT' ? 'MP4 export needs FFmpeg installed and available on PATH.' : `MP4 conversion failed: ${error.stderr || error.message}`);
    } finally { await fs.rm(temporary, { force: true }); await fs.rm(converted, { force: true }); }
  });
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
    recordingSeconds = 0;
    recordingPaused = false;
    createControlWindow();
    if (agentSession && controlWindow) {
      controlWindow.webContents.once('did-finish-load', () => {
        if (controlWindow && !controlWindow.isDestroyed()) controlWindow.webContents.send('control:agent', true);
      });
    }
    if (studioWindow && !studioWindow.isDestroyed()) studioWindow.hide();
  });
  ipcMain.on('recording:paused', (_event, paused) => {
    recordingPaused = Boolean(paused);
    if (controlWindow && !controlWindow.isDestroyed()) controlWindow.webContents.send('control:paused', paused);
  });
  ipcMain.on('recording:tick', (_event, seconds) => {
    recordingSeconds = seconds;
    if (controlWindow && !controlWindow.isDestroyed()) controlWindow.webContents.send('control:tick', seconds);
  });
  ipcMain.on('agent:result', (_event, result) => {
    const waiter = result && agentWaiters.get(result.kind);
    if (waiter) { agentWaiters.delete(result.kind); waiter(result); return; }
    // the user stopped an agent-started recording from the floating controls: still remember the saved file
    if (result && result.kind === 'stopped' && result.ok) {
      agentSession = false;
      lastSavedRecording = { file: result.file, seconds: result.seconds, bytes: result.bytes };
    }
  });
  ipcMain.handle('agent:save-recording', async (_event, bytes, seconds) => {
    const folder = recordingsFolder();
    await fs.mkdir(folder, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
    const file = path.join(folder, `FrameBase-${stamp}.webm`);
    await fs.writeFile(file, Buffer.from(bytes));
    return { ok: true, file, seconds: Math.round(seconds), bytes: bytes.byteLength };
  });
  ipcMain.handle('agent:info', () => agent.info());
  ipcMain.handle('agent:set-enabled', (_event, enabled) => agent.setEnabled(Boolean(enabled)));
  ipcMain.handle('agent:set-allow-screens', (_event, value) => agent.setAllowScreens(value));
  ipcMain.handle('agent:rotate-token', async () => { await agent.rotateToken(); return agent.info(); });
  ipcMain.handle('agent:reveal-token', () => agent.revealToken());
  ipcMain.on('recording:stopped', () => {
    isRecording = false;
    recordingPaused = false;
    clearTimeout(agentStopTimer);
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
  agent = createAgentServer({ safeStorage, userDataPath: app.getPath('userData'), recordingsDir: recordingsFolder(), controller: agentController });
  agent.init().catch(error => console.error('Agent control did not start:', error.message));
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { if (agent) agent.stop(); });
