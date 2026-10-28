const { app, BrowserWindow, Menu, desktopCapturer, dialog, ipcMain, protocol, safeStorage, screen, session, shell, webContents } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createAgentServer } = require('./agent-server');
const { createMediaTools, MP4_OUT, WEBM_OUT, EVEN } = require('./media-tools');
const { fixWebmFileDuration } = require('./webm-duration');

const execFileAsync = promisify(execFile);
const MEDIA_SCHEME = 'framebase-media';
const MIME = { webm: 'video/webm', mp4: 'video/mp4', mov: 'video/quicktime', mkv: 'video/x-matroska', wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg' };

// Video files reach the renderer through this scheme, and only files main has handed out (recordings, picked files).
protocol.registerSchemesAsPrivileged([{ scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);

let studioWindow = null;
let controlWindow = null;
let agent = null;
let media = null;
let quitting = false;
let agentStarting = false;
let lastSavedRecording = null;
const recording = { active: false, paused: false, seconds: 0, byAgent: false, maxSeconds: 0, autoStopping: false, handle: null, partFile: null };
let captureSelection = null;
const waiters = new Map();
const mediaGrants = new Map();
const exportJobs = new Map();

function recordingsFolder() { return path.join(app.getPath('documents'), 'FrameBase Recordings'); }
const alive = win => Boolean(win && !win.isDestroyed());

function waitFor(kind, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiters.delete(kind); reject(new Error(`Timed out waiting for the recorder (${kind}).`)); }, timeoutMs);
    waiters.set(kind, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
  });
}
function settle(kind, value, error) {
  const waiter = waiters.get(kind);
  if (!waiter) return;
  waiters.delete(kind);
  if (error) waiter.reject(error); else waiter.resolve(value);
}

function grantMedia(file) {
  for (const [token, granted] of mediaGrants) if (granted === file) return describeGrant(token, file);
  const token = crypto.randomBytes(16).toString('hex');
  mediaGrants.set(token, file);
  return describeGrant(token, file);
}
function describeGrant(token, file) {
  return { token, name: path.basename(file), path: file, url: `${MEDIA_SCHEME}://media/${token}`, inWorkspace: !path.relative(recordingsFolder(), file).startsWith('..') };
}
function grantedPath(token) {
  const file = typeof token === 'string' ? mediaGrants.get(token) : null;
  if (!file) throw new Error('That file is no longer available. Open it again.');
  return file;
}

async function serveMedia(request) {
  const { hostname, pathname } = new URL(request.url);
  const file = hostname === 'media' ? mediaGrants.get(pathname.slice(1)) : null;
  const stat = file ? await fs.stat(file).catch(() => null) : null;
  if (!stat || !stat.isFile()) return new Response('Not found', { status: 404 });
  const headers = { 'Content-Type': MIME[path.extname(file).slice(1).toLowerCase()] || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*' };
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('range') || '');
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : Math.max(0, stat.size - Number(range[2]));
    let end = range[1] && range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
    if (start > end || start >= stat.size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${stat.size}` } });
    return new Response(Readable.toWeb(createReadStream(file, { start, end })), { status: 206, headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': String(end - start + 1) } });
  }
  return new Response(Readable.toWeb(createReadStream(file)), { headers: { ...headers, 'Content-Length': String(stat.size) } });
}

// ---- recording files ----
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');

async function finalizeRecording(partFile, stem, durationMs) {
  const target = await media.reserveOutput(stem, stem, 'webm');
  await fs.rename(partFile, target);
  let fixed = durationMs > 0 ? await fixWebmFileDuration(target, durationMs).catch(() => ({ fixed: false })) : { fixed: false };
  if (!fixed.fixed && (await media.ffmpegInfo()).available) {
    // large or interrupted files: a stream copy writes a proper duration and seek index
    const remuxed = `${target}.remux.webm`;
    try {
      await execFileAsync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', target, '-c', 'copy', remuxed], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
      await fs.rename(remuxed, target);
      fixed = { fixed: true };
    } catch { await fs.rm(remuxed, { force: true }); }
  }
  const { size } = await fs.stat(target);
  return { file: target, bytes: size, seekable: fixed.fixed };
}

// A recording that never finished (crash, power loss): keep what was written.
async function recoverPart(partFile) {
  const stat = await fs.stat(partFile).catch(() => null);
  if (!stat) return null;
  if (stat.size === 0) { await fs.rm(partFile, { force: true }); return null; }
  return finalizeRecording(partFile, `${path.basename(partFile).replace(/\.webm\.part$/, '')}-recovered`, 0);
}

async function recoverLeftovers() {
  const folder = recordingsFolder();
  const names = await fs.readdir(folder).catch(() => []);
  const recovered = [];
  for (const name of names.filter(n => n.endsWith('.webm.part') && path.join(folder, n) !== recording.partFile)) {
    const result = await recoverPart(path.join(folder, name)).catch(() => null);
    if (result) recovered.push(grantMedia(result.file));
  }
  return recovered;
}

function resetRecording() {
  Object.assign(recording, { active: false, paused: false, seconds: 0, byAgent: false, maxSeconds: 0, autoStopping: false, handle: null, partFile: null });
  if (alive(controlWindow)) controlWindow.close();
}

async function salvageRecording(reason) {
  if (!recording.active) return null;
  const { handle, partFile } = recording;
  resetRecording();
  await handle?.close().catch(() => {});
  const result = await recoverPart(partFile).catch(() => null);
  if (result) lastSavedRecording = { file: result.file, seconds: null, bytes: result.bytes, recovered: true };
  settle('start', null, new Error(reason));
  settle('stopped', null, new Error(`${reason}${result ? ` What was recorded was kept in ${result.file}.` : ''}`));
  return result;
}

// ---- what the optional MCP server may do; it reuses the recording flow a person uses ----
const agentController = {
  async listSources() {
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
    return sources
      .filter(({ name }) => name !== 'FrameBase Recording Controls')
      .map(({ id, name }) => ({ id, name, type: id.startsWith('window:') ? 'window' : 'screen' }));
  },
  async start({ sourceId, systemAudio, microphone, maxSeconds }) {
    if (recording.active || agentStarting) throw new Error('A recording is already running or starting. Stop it first.');
    agentStarting = true;
    try {
      if (!alive(studioWindow)) createWindow();
      if (studioWindow.webContents.isLoading()) await new Promise(resolve => studioWindow.webContents.once('did-finish-load', resolve));
      recording.maxSeconds = maxSeconds;
      const started = waitFor('start', 20000);
      // run with a simulated user gesture: Chromium only allows screen capture to start from one
      studioWindow.webContents.executeJavaScript(`window.__agentStart(${JSON.stringify({ sourceId, systemAudio: Boolean(systemAudio), microphone: Boolean(microphone) })})`, true).catch(() => {});
      await started;
      return { ok: true };
    } finally { agentStarting = false; }
  },
  async setPaused(wanted) {
    if (!recording.active) throw new Error('Nothing is recording.');
    if (!recording.byAgent) throw new Error('This recording was started by the user, so only the user can pause or resume it.');
    if (recording.paused !== wanted) {
      const changed = waitFor('paused', 5000);
      studioWindow.webContents.send('recording:toggle-pause');
      await changed;
    }
    return { paused: recording.paused };
  },
  async stop() {
    if (!recording.active) throw new Error('Nothing is recording.');
    if (!recording.byAgent) throw new Error('This recording was started by the user, not an agent, so an agent cannot stop it. The user can stop it from the floating controls.');
    const stopped = waitFor('stopped', 120000);
    studioWindow.webContents.send('recording:stop');
    await stopped;
    return lastSavedRecording;
  },
  async stopIfAgent() {
    if (recording.active && recording.byAgent) await agentController.stop().catch(() => {});
  },
  async openInEditor(file) {
    showStudio();
    studioWindow.webContents.send('editor:open', grantMedia(file));
    return { opened: path.basename(file) };
  },
  status() {
    return { recording: recording.active, paused: recording.paused, seconds: recording.seconds, started_by_agent: recording.active && recording.byAgent, max_seconds: recording.byAgent ? recording.maxSeconds : null, last_saved: lastSavedRecording };
  }
};

// ---- windows ----
function createWindow() {
  studioWindow = new BrowserWindow({
    width: 1440, height: 920, minWidth: 1100, minHeight: 720,
    title: 'FrameBase Studio', backgroundColor: '#0b0c0e', show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, autoplayPolicy: 'no-user-gesture-required' }
  });
  studioWindow.loadFile(path.join(__dirname, 'index.html'));
  studioWindow.once('ready-to-show', () => { if (!recording.active) studioWindow.show(); });
  studioWindow.on('close', event => {
    // keep recording in the background; the floating bar can bring the studio back
    if (recording.active && !quitting) { event.preventDefault(); studioWindow.hide(); }
  });
  studioWindow.webContents.on('render-process-gone', async (_event, details) => {
    await salvageRecording(`The studio stopped unexpectedly (${details.reason}).`);
    if (!quitting && alive(studioWindow)) { studioWindow.reload(); studioWindow.show(); }
  });
  studioWindow.webContents.on('did-finish-load', async () => {
    const recovered = await recoverLeftovers();
    if (recovered.length && alive(studioWindow)) studioWindow.webContents.send('studio:recovered', recovered);
  });
}

function sendControlState() {
  if (!alive(controlWindow)) return;
  controlWindow.webContents.send('control:agent', recording.byAgent);
  controlWindow.webContents.send('control:paused', recording.paused);
  controlWindow.webContents.send('control:tick', recording.seconds);
}

function createControlWindow() {
  if (alive(controlWindow)) { sendControlState(); controlWindow.show(); return; }
  const area = screen.getPrimaryDisplay().workArea;
  controlWindow = new BrowserWindow({
    width: 560, height: 74,
    x: Math.round(area.x + (area.width - 560) / 2), y: area.y + area.height - 94,
    title: 'FrameBase Recording Controls', backgroundColor: '#00000000',
    frame: false, transparent: true, resizable: false, movable: true, minimizable: false, maximizable: false,
    alwaysOnTop: true, skipTaskbar: true, hasShadow: false,
    webPreferences: { preload: path.join(__dirname, 'control-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  controlWindow.setAlwaysOnTop(true, 'screen-saver');
  controlWindow.setVisibleOnAllWorkspaces(true);
  controlWindow.setContentProtection(true); // keep the controls out of the recording itself
  controlWindow.loadFile(path.join(__dirname, 'mini-control.html'));
  controlWindow.webContents.on('did-finish-load', sendControlState);
  controlWindow.on('closed', () => { controlWindow = null; });
}

function showStudio() {
  if (!alive(studioWindow)) createWindow();
  studioWindow.show();
  studioWindow.restore();
  studioWindow.focus();
  studioWindow.webContents.send('studio:focus-editor');
}

function buildMenu() {
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : [{ label: 'File', submenu: [{ role: 'quit' }] }]),
    { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }, ...(app.isPackaged ? [] : [{ type: 'separator' }, { role: 'toggleDevTools' }])] },
    { role: 'windowMenu' }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---- IPC: every channel checks which window sent it and validates its arguments ----
const fromStudio = event => alive(studioWindow) && event.sender === studioWindow.webContents;
const fromControl = event => alive(controlWindow) && event.sender === controlWindow.webContents;
function handle(channel, guard, fn) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!guard(event)) throw new Error('Not allowed from this window.');
    return fn(...args);
  });
}
function listen(channel, guard, fn) {
  ipcMain.on(channel, (event, ...args) => { if (guard(event)) fn(...args); });
}
const isText = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max;
const isBytes = value => value instanceof ArrayBuffer || ArrayBuffer.isView(value);
function cleanEdits(edits = {}) {
  const zoomLevel = Math.min(3, Math.max(1, Number(edits.zoomLevel) || 1));
  const textItems = (Array.isArray(edits.textItems) ? edits.textItems : []).slice(0, 100)
    .filter(item => item && typeof item.text === 'string')
    .map(item => ({ text: item.text.slice(0, 500), x: Math.min(100, Math.max(0, Number(item.x) || 0)), y: Math.min(100, Math.max(0, Number(item.y) || 0)) }));
  return { zoomLevel, cropEnabled: edits.cropEnabled === true, textItems };
}
const projectName = value => (typeof value === 'string' ? value : '').replace(/[^\w .-]+/g, '').trim().slice(0, 80) || 'Untitled project';

async function transcode(input, output, format) {
  const args = format === 'mp4' ? MP4_OUT : WEBM_OUT;
  try {
    await execFileAsync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-map', '0:v:0', '-map', '0:a?', '-vf', EVEN, ...args, output], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  } catch (error) {
    await fs.rm(output, { force: true });
    throw new Error(error.code === 'ENOENT' ? 'This export needs FFmpeg installed and on PATH.' : `Conversion failed: ${String(error.stderr || error.message).trim().split('\n').pop()}`);
  }
}
async function moveFile(from, to) {
  try { await fs.rename(from, to); } catch (error) {
    if (error.code !== 'EXDEV') throw error;
    await fs.copyFile(from, to);
    await fs.rm(from, { force: true });
  }
}

function registerIpc() {
  handle('app:info', fromStudio, async () => ({ platform: process.platform, recordingsDir: recordingsFolder(), ffmpeg: await media.ffmpegInfo() }));

  // capture
  handle('capture:sources', fromStudio, async () => {
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 200 } });
    return sources
      .filter(({ name }) => name !== 'FrameBase Recording Controls')
      .map(({ id, name, thumbnail }) => ({ id, name, type: id.startsWith('window:') ? 'window' : 'screen', image: thumbnail.toDataURL() }));
  });
  handle('capture:set-selection', fromStudio, (sourceId, systemAudio) => {
    if (!isText(sourceId, 200) || !/^(screen|window):/.test(sourceId)) throw new Error('Invalid capture source.');
    captureSelection = { sourceId, systemAudio: systemAudio === true };
  });

  // recording: the renderer streams chunks here so nothing is lost if the app stops
  handle('recording:begin', fromStudio, async () => {
    if (recording.active) throw new Error('A recording is already running.');
    const folder = recordingsFolder();
    await fs.mkdir(folder, { recursive: true });
    const partFile = path.join(folder, `FrameBase-${stamp()}-${crypto.randomBytes(3).toString('hex')}.webm.part`);
    const fileHandle = await fs.open(partFile, 'wx');
    Object.assign(recording, { active: true, paused: false, seconds: 0, autoStopping: false, byAgent: agentStarting, handle: fileHandle, partFile });
    if (!agentStarting) recording.maxSeconds = 0;
    createControlWindow();
    if (alive(studioWindow)) studioWindow.hide();
    settle('start', { ok: true });
    return { byAgent: recording.byAgent };
  });
  handle('recording:chunk', fromStudio, async data => {
    if (!recording.active || !recording.handle) throw new Error('No recording is open.');
    if (!isBytes(data)) throw new Error('Invalid recording data.');
    await recording.handle.write(Buffer.from(data.buffer || data, data.byteOffset || 0, data.byteLength));
  });
  handle('recording:finish', fromStudio, async durationMs => {
    if (!recording.active) throw new Error('No recording is open.');
    const { handle: fileHandle, partFile } = recording;
    const seconds = Math.max(0, Number(durationMs) || 0) / 1000;
    resetRecording();
    try {
      await fileHandle.close();
      const result = await finalizeRecording(partFile, path.basename(partFile).replace(/-[0-9a-f]{6}\.webm\.part$/, ''), seconds * 1000);
      lastSavedRecording = { file: result.file, seconds: Math.round(seconds), bytes: result.bytes };
      settle('stopped', lastSavedRecording);
      return { ...grantMedia(result.file), seconds, bytes: result.bytes, seekable: result.seekable };
    } catch (error) {
      settle('stopped', null, error);
      throw error;
    } finally {
      if (!quitting) showStudio();
    }
  });
  listen('recording:failed', fromStudio, async message => {
    const reason = isText(message, 500) ? message : 'The recording failed.';
    if (recording.active) await salvageRecording(reason);
    else settle('start', null, new Error(reason));
    if (!quitting) showStudio();
  });
  listen('recording:paused', fromStudio, paused => {
    recording.paused = paused === true;
    settle('paused', recording.paused);
    if (alive(controlWindow)) controlWindow.webContents.send('control:paused', recording.paused);
  });
  listen('recording:tick', fromStudio, seconds => {
    if (!Number.isFinite(seconds) || seconds < 0) return;
    recording.seconds = Math.floor(seconds);
    if (alive(controlWindow)) controlWindow.webContents.send('control:tick', recording.seconds);
    // agent recordings stop after max_seconds of recorded time; paused time does not count
    if (recording.byAgent && recording.maxSeconds && recording.seconds >= recording.maxSeconds && !recording.autoStopping) {
      recording.autoStopping = true;
      studioWindow.webContents.send('recording:stop');
    }
  });

  // floating controls
  handle('control:get-state', fromControl, () => ({ byAgent: recording.byAgent, paused: recording.paused, seconds: recording.seconds }));
  listen('control:pause', fromControl, () => { if (alive(studioWindow)) studioWindow.webContents.send('recording:toggle-pause'); });
  listen('control:stop', fromControl, () => { if (alive(studioWindow)) studioWindow.webContents.send('recording:stop'); });
  listen('control:show-studio', fromControl, () => showStudio());

  // media library
  handle('media:list', fromStudio, async limit => {
    const rows = await media.listFiles({ kind: 'video', limit: Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 500) : 200 });
    return rows.map(row => ({ ...grantMedia(row.file), bytes: row.bytes, modified: row.modified }));
  });
  handle('media:import', fromStudio, async () => {
    const result = await dialog.showOpenDialog(studioWindow, { title: 'Import a video', properties: ['openFile'], filters: [{ name: 'Video', extensions: ['webm', 'mp4', 'mov', 'mkv'] }] });
    return result.canceled || !result.filePaths[0] ? null : grantMedia(result.filePaths[0]);
  });
  handle('media:reveal', fromStudio, token => { shell.showItemInFolder(grantedPath(token)); });
  handle('media:open-folder', fromStudio, async () => {
    await fs.mkdir(recordingsFolder(), { recursive: true });
    const error = await shell.openPath(recordingsFolder());
    if (error) throw new Error(error);
  });

  // projects: an edit list next to a reference to the source video (v1 files embedded the video and still open)
  handle('project:save', fromStudio, async payload => {
    if (!payload || typeof payload !== 'object') throw new Error('Invalid project.');
    const source = grantedPath(payload.mediaToken);
    const name = projectName(payload.name);
    const result = await dialog.showSaveDialog(studioWindow, { title: 'Save FrameBase project', defaultPath: path.join(path.dirname(source), `${name}.framebase`), filters: [{ name: 'FrameBase project', extensions: ['framebase'] }] });
    if (result.canceled || !result.filePath) return { canceled: true };
    const project = { version: 2, name, media: { path: source, relative: path.relative(path.dirname(result.filePath), source) }, edits: cleanEdits(payload.edits) };
    await fs.writeFile(result.filePath, JSON.stringify(project, null, 2));
    return { canceled: false, filePath: result.filePath };
  });
  handle('project:open', fromStudio, async () => {
    const result = await dialog.showOpenDialog(studioWindow, { title: 'Open FrameBase project', properties: ['openFile'], filters: [{ name: 'FrameBase project', extensions: ['framebase'] }] });
    if (result.canceled || !result.filePaths[0]) return null;
    const projectFile = result.filePaths[0];
    const project = JSON.parse(await fs.readFile(projectFile, 'utf8'));
    let source;
    if (project.version === 2 && project.media) {
      const candidates = [path.resolve(path.dirname(projectFile), String(project.media.relative || '')), String(project.media.path || '')];
      for (const candidate of candidates) if (candidate && (await fs.stat(candidate).catch(() => null))?.isFile()) { source = candidate; break; }
      if (!source) throw new Error(`The project's video was not found. It was at ${project.media.path}.`);
    } else if (typeof project.media === 'string') {
      // version 1 kept the whole video as base64; write it out once as a normal file
      const extension = /mp4/.test(String(project.type)) ? 'mp4' : 'webm';
      const name = projectName(project.name);
      source = await media.reserveOutput(`${name}-from-project`, name, extension);
      await fs.writeFile(source, Buffer.from(project.media, 'base64'));
    } else throw new Error('This is not a FrameBase project file.');
    return { name: projectName(project.name), edits: cleanEdits(project.edits || project), media: grantMedia(source) };
  });

  // export: pick the destination first, then either convert the source directly or receive a rendered stream
  handle('export:begin', fromStudio, async ({ format, name } = {}) => {
    if (!['mp4', 'webm'].includes(format)) throw new Error('Choose MP4 or WebM.');
    if (format === 'mp4' && !(await media.ffmpegInfo()).available) throw new Error('MP4 export needs FFmpeg installed and on PATH.');
    const result = await dialog.showSaveDialog(studioWindow, { title: `Export ${format.toUpperCase()} video`, defaultPath: `${projectName(name)}.${format}`, filters: [{ name: `${format.toUpperCase()} video`, extensions: [format] }] });
    if (result.canceled || !result.filePath) return { canceled: true };
    const id = crypto.randomUUID();
    exportJobs.set(id, { target: result.filePath, format, temp: path.join(os.tmpdir(), `framebase-export-${id}.webm`), handle: null });
    return { canceled: false, id };
  });
  handle('export:from-source', fromStudio, async (id, token) => {
    const job = exportJobs.get(id);
    if (!job) throw new Error('Unknown export.');
    exportJobs.delete(id);
    const source = grantedPath(token);
    if (path.extname(source).slice(1).toLowerCase() === job.format) await fs.copyFile(source, job.target);
    else await transcode(source, job.target, job.format);
    return { filePath: job.target };
  });
  handle('export:chunk', fromStudio, async (id, data) => {
    const job = exportJobs.get(id);
    if (!job || !isBytes(data)) throw new Error('Unknown export.');
    job.handle = job.handle || await fs.open(job.temp, 'wx');
    await job.handle.write(Buffer.from(data.buffer || data, data.byteOffset || 0, data.byteLength));
  });
  handle('export:finish', fromStudio, async (id, durationMs) => {
    const job = exportJobs.get(id);
    if (!job || !job.handle) throw new Error('Nothing was rendered.');
    exportJobs.delete(id);
    try {
      await job.handle.close();
      if (job.format === 'webm') {
        await fixWebmFileDuration(job.temp, Number(durationMs) || 0).catch(() => {});
        await moveFile(job.temp, job.target);
      } else {
        await transcode(job.temp, job.target, job.format);
      }
      return { filePath: job.target };
    } finally { await fs.rm(job.temp, { force: true }); }
  });
  handle('export:cancel', fromStudio, async id => {
    const job = exportJobs.get(id);
    if (!job) return;
    exportJobs.delete(id);
    await job.handle?.close().catch(() => {});
    await fs.rm(job.temp, { force: true });
  });

  // agent control settings (the token only leaves main through the explicit reveal)
  handle('agent:info', fromStudio, () => agent.info());
  handle('agent:set-enabled', fromStudio, enabled => agent.setEnabled(enabled === true));
  handle('agent:set-allow-screens', fromStudio, value => agent.setAllowScreens(value === true));
  handle('agent:set-allow-microphone', fromStudio, value => agent.setAllowMicrophone(value === true));
  handle('agent:rotate-token', fromStudio, async () => { await agent.rotateToken(); return agent.info(); });
  handle('agent:reveal-token', fromStudio, () => agent.revealToken());
  listen('agent:start-failed', fromStudio, message => settle('start', null, new Error(isText(message, 500) ? message : 'The recording did not start.')));
}

function lockDownSessions() {
  const fromStudioContents = contents => alive(studioWindow) && contents === studioWindow.webContents;
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    if (!fromStudioContents(contents)) return callback(false);
    // the microphone, and only when asked for by the studio; screens go through the display-media handler below
    if (permission === 'media') return callback((details.mediaTypes || []).every(type => type === 'audio'));
    callback(permission === 'clipboard-sanitized-write');
  });
  session.defaultSession.setPermissionCheckHandler((contents, permission) => Boolean(contents) && fromStudioContents(contents) && ['media', 'clipboard-sanitized-write'].includes(permission));
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      const selection = captureSelection;
      captureSelection = null;
      if (!selection || !request.frame || !fromStudioContents(webContents.fromFrame(request.frame))) return callback({});
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
      const source = sources.find(item => item.id === selection.sourceId);
      if (!source) return callback({});
      callback({ video: source, ...(selection.systemAudio && process.platform === 'win32' ? { audio: 'loopback' } : {}) });
    } catch {
      callback({});
    }
  });
}

app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', event => event.preventDefault());
  contents.on('will-redirect', event => event.preventDefault());
  contents.on('will-attach-webview', event => event.preventDefault());
});

const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();
app.on('second-instance', () => { if (!recording.active) showStudio(); });

app.whenReady().then(() => {
  if (!primaryInstance) return;
  media = createMediaTools({ workspaceDir: recordingsFolder() });
  protocol.handle(MEDIA_SCHEME, serveMedia);
  buildMenu();
  lockDownSessions();
  registerIpc();
  agent = createAgentServer({ safeStorage, userDataPath: app.getPath('userData'), recordingsDir: recordingsFolder(), controller: agentController, media });
  agent.init().catch(error => console.error('Agent control did not start:', error.message));
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', event => {
  if (recording.active && !quitting) {
    // stop and save the recording before letting the app close
    event.preventDefault();
    quitting = true;
    const stopped = waitFor('stopped', 30000);
    if (alive(studioWindow)) studioWindow.webContents.send('recording:stop');
    stopped.catch(() => salvageRecording('FrameBase was closed while recording.')).finally(() => app.quit());
    return;
  }
  quitting = true;
  if (agent) agent.stop();
});
