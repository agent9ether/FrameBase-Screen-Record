// End-to-end check of the real app: `npm run test:e2e` (opens windows on your screen for ~1 minute).
// Runs main.js with throwaway data folders, drives it as an MCP client would, and checks the files it writes.
const { app, BrowserWindow, dialog } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'framebase-e2e-'));
app.setPath('userData', path.join(root, 'userData'));
app.setPath('documents', path.join(root, 'Documents'));
const recordings = path.join(root, 'Documents', 'FrameBase Recordings');
const exportsDir = path.join(root, 'exports');
fs.mkdirSync(exportsDir, { recursive: true });
// stand in for the save dialog
let nextSavePath = null;
dialog.showSaveDialog = async () => ({ canceled: !nextSavePath, filePath: nextSavePath });

const results = [];
const consoleProblems = [];
function check(name, ok, detail = '') { results.push({ name, ok: Boolean(ok), detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`); }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const studio = () => BrowserWindow.getAllWindows().find(win => win.getTitle() === 'FrameBase Studio' && !win.isDestroyed());
const inStudio = code => studio().webContents.executeJavaScript(code).catch(error => { throw new Error(`${error.message} in: ${code.slice(0, 120)}`); });
const probeSeconds = file => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString().trim());
async function until(predicate, timeoutMs, label) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { if (await predicate()) return true; await sleep(200); }
  throw new Error(`Timed out: ${label}`);
}

app.on('web-contents-created', (_event, contents) => {
  contents.on('console-message', details => {
    const message = details.message || String(details);
    if (/Content Security Policy|Refused to|Uncaught|is not defined|TypeError/.test(message)) consoleProblems.push(message.slice(0, 300));
  });
});

require('../../main.js');

async function run() {
  await until(() => studio() && !studio().webContents.isLoading(), 20000, 'studio window');
  await sleep(1500);
  await inStudio('window.alert = message => { (window.__alerts = window.__alerts || []).push(String(message)); }; window.confirm = () => true; true');

  // --- security basics in the real window ---
  const prefs = studio().webContents.getLastWebPreferences();
  check('studio runs sandboxed with context isolation', prefs.sandbox === true && prefs.contextIsolation === true && prefs.nodeIntegration === false);
  check('page cannot reach Node', await inStudio('typeof require === "undefined" && typeof process === "undefined"'));
  const before = studio().webContents.getURL();
  await inStudio('location.href = "https://example.com"; true').catch(() => {});
  await sleep(800);
  check('navigation away is blocked', studio().webContents.getURL() === before);
  check('window.open is blocked', await inStudio('window.open("https://example.com") === null'));
  const fontsOk = await inStudio('document.fonts.ready.then(() => document.fonts.check("600 16px Manrope") && [...document.fonts].some(f => f.family.includes("Manrope") && f.status === "loaded"))');
  check('bundled fonts load from disk', fontsOk);

  // --- enable agent control ---
  const info = await inStudio('window.studio.agent.setEnabled(true)');
  check('agent control starts', info.enabled && info.url.startsWith('http://127.0.0.1:'), info.url);
  const token = await inStudio('window.studio.agent.revealToken()');
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const client = new Client({ name: 'framebase-e2e', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(info.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const textPart = result.content.find(part => part.type === 'text');
    let data = null;
    try { data = JSON.parse(textPart.text); } catch { data = textPart && textPart.text; }
    return { error: result.isError ? textPart.text : null, data, content: result.content };
  };

  // --- a window to record: a moving pattern, loaded from a file so it is a secure context like a real app page ---
  const targetFile = path.join(root, 'target.html');
  fs.writeFileSync(targetFile, '<title>FrameBase E2E Target</title><body style="margin:0;background:#222"><canvas id=c width=640 height=400></canvas><script>const c=document.getElementById("c").getContext("2d");let t=0;setInterval(()=>{t++;c.fillStyle="hsl("+(t*7%360)+",70%,50%)";c.fillRect(0,0,640,400);c.fillStyle="#fff";c.font="40px sans-serif";c.fillText("frame "+t,40,200)},33)</script>');
  const target = new BrowserWindow({ width: 640, height: 400, x: 40, y: 40, title: 'FrameBase E2E Target', show: true, webPreferences: { sandbox: true } });
  await target.loadFile(targetFile);
  target.setTitle('FrameBase E2E Target');
  await sleep(800);

  // the target page must not get the microphone
  const micDenied = await target.webContents.executeJavaScript('navigator.mediaDevices.getUserMedia({audio:true}).then(() => false, error => error.name)');
  check('other windows are refused the microphone', micDenied && micDenied !== false, String(micDenied));

  const sources = await call('list_sources');
  check('list_sources finds the target window', sources.data.sources.some(s => s.name === 'FrameBase E2E Target'));
  check('list_sources hides screens by default', sources.data.sources.every(s => s.type === 'window'));
  check('list_sources hides the floating controls', !sources.data.sources.some(s => s.name === 'FrameBase Recording Controls'));
  const mic = await call('start_recording', { window_title: 'FrameBase E2E Target', microphone: true });
  check('agent microphone refused while off', /Microphone recording by agents is off/.test(mic.error || ''));

  // --- agent recording with pause ---
  const started = await call('start_recording', { window_title: 'FrameBase E2E Target', max_seconds: 60 });
  check('start_recording', !started.error, started.error || '');
  const again = await call('start_recording', { window_title: 'FrameBase E2E Target' });
  check('second start is refused while recording', Boolean(again.error));
  await sleep(1200);
  const partFiles = fs.readdirSync(recordings).filter(name => name.endsWith('.webm.part'));
  check('recording streams to a file on disk while recording', partFiles.length === 1 && fs.statSync(path.join(recordings, partFiles[0])).size > 0, partFiles.join(','));
  await sleep(1800);
  const paused = await call('pause_recording');
  check('pause_recording confirms the pause', paused.data && paused.data.paused === true, JSON.stringify(paused.data || paused.error));
  await sleep(1500);
  const statusPaused = await call('recording_status');
  const secondsAtPause = statusPaused.data.seconds;
  await sleep(1500);
  check('paused time is not counted', (await call('recording_status')).data.seconds === secondsAtPause);
  await call('resume_recording');
  await sleep(2000);
  const stopped = await call('stop_recording');
  check('stop_recording returns the saved file', stopped.data && stopped.data.file && fs.existsSync(stopped.data.file), stopped.error || '');
  const recorded = stopped.data.file;
  const recordedSeconds = probeSeconds(recorded);
  check('saved WebM has a duration header', recordedSeconds > 3 && recordedSeconds < 8, `${recordedSeconds}s`);
  check('no partial files left', fs.readdirSync(recordings).every(name => !name.endsWith('.part')));

  // --- auto-stop after max_seconds of recorded time ---
  await sleep(1500);
  await call('start_recording', { window_title: 'FrameBase E2E Target', max_seconds: 2 });
  await until(async () => !(await call('recording_status')).data.recording, 15000, 'auto-stop');
  check('max_seconds auto-stops the recording', true);
  await sleep(1500);

  // --- production tools on the real recording ---
  const name = path.basename(recorded);
  const infoResult = await call('media_info', { file: name });
  check('media_info', infoResult.data && infoResult.data.video && infoResult.data.video.width > 100, JSON.stringify(infoResult.data && infoResult.data.video));
  const frame = await call('extract_frame', { file: name, at_seconds: 1 });
  check('extract_frame returns an image', frame.content[0].type === 'image');
  const trimmed = await call('trim_video', { file: name, start_seconds: 0.5, end_seconds: 2.5, output_name: 'e2e-trim' });
  check('trim_video', trimmed.data && trimmed.data.name === 'e2e-trim.mp4', trimmed.error || '');
  const voice = await call('generate_voiceover', { text: 'This is the FrameBase end to end test.', output_name: 'e2e-voice' });
  check('generate_voiceover (local speech)', voice.data && voice.data.seconds > 1, voice.error || '');
  const voiced = await call('add_audio', { video: 'e2e-trim.mp4', audio: 'e2e-voice.wav', output_name: 'e2e-voiced' });
  check('add_audio holds the last frame for long narration', voiced.data && voiced.data.seconds > 2, voiced.error || JSON.stringify(voiced.data));
  const captioned = await call('add_captions', { video: 'e2e-voiced.mp4', captions: [{ start: 0, end: 2, text: 'FrameBase test' }], output_name: 'e2e-captioned' });
  check('add_captions', !captioned.error, captioned.error || '');
  const joined = await call('join_videos', { files: ['e2e-trim.mp4', 'e2e-captioned.mp4'], output_name: 'e2e-final' });
  check('join_videos', !joined.error, joined.error || '');
  const escape = await call('trim_video', { file: path.join(root, 'userData', 'agent-control.json') });
  check('tools refuse files outside the folder', Boolean(escape.error));

  // --- open_in_editor: the studio plays it through the media scheme without tainting the canvas ---
  const opened = await call('open_in_editor', { file: 'e2e-final.mp4' });
  check('open_in_editor', !opened.error, opened.error || '');
  await until(() => inStudio('document.querySelector("#preview-video").readyState >= 2'), 15000, 'editor video loads');
  check('editor shows the file', await inStudio('document.querySelector("#editor-title").textContent') === 'e2e-final');
  const untainted = await inStudio('(() => { const v = document.querySelector("#preview-video"); const c = document.createElement("canvas"); c.width = 8; c.height = 8; const x = c.getContext("2d"); x.drawImage(v, 0, 0, 8, 8); try { x.getImageData(0, 0, 1, 1); return true; } catch (e) { return e.name; } })()');
  check('editor canvas is not tainted (export can render)', untainted === true, String(untainted));
  const seekOk = await inStudio('new Promise(r => { const v = document.querySelector("#preview-video"); v.addEventListener("seeked", () => r(v.currentTime > 1), { once: true }); v.currentTime = 1.5; })');
  check('editor can seek (range requests work)', seekOk);
  const library = await inStudio('window.studio.media.list()');
  check('media library lists recordings and agent output', library.some(item => item.name === 'e2e-final.mp4') && library.some(item => item.name === name));

  // --- exports: straight conversion, then a rendered edit ---
  nextSavePath = path.join(exportsDir, 'plain.mp4');
  const plain = await inStudio('window.studio.exporter.begin({ format: "mp4", name: "plain" }).then(job => window.studio.exporter.fromSource(job.id, window.__current = document.querySelector("#preview-video").src.split("/").pop()))').catch(error => ({ error: error.message }));
  check('export without edits converts the source', fs.existsSync(nextSavePath) && fs.statSync(nextSavePath).size > 1000, JSON.stringify(plain));
  await call('open_in_editor', { file: 'e2e-trim.mp4' });
  await until(() => inStudio('document.querySelector("#preview-video").readyState >= 2 && document.querySelector("#editor-title").textContent === "e2e-trim"'), 15000, 'trim loads');
  nextSavePath = path.join(exportsDir, 'edited.webm');
  await inStudio(`(() => {
    const zoom = document.querySelector('#zoom-range'); zoom.value = '150'; zoom.dispatchEvent(new Event('input'));
    document.querySelector('#text-input').value = 'Edited'; document.querySelector('#text-form').requestSubmit();
    document.querySelector('#export-video').click();
    document.querySelector('#export-modal [data-format="webm"]').click();
    document.querySelector('#export-start').click();
    return true;
  })()`);
  await until(() => fs.existsSync(nextSavePath) && inStudio('!document.querySelector("#export-video").disabled'), 30000, 'edited export');
  const editedSeconds = probeSeconds(nextSavePath);
  check('export with zoom and text renders a WebM with duration', editedSeconds > 1.5 && editedSeconds < 3, `${editedSeconds}s`);
  const alerts = await inStudio('window.__alerts || []');
  check('export reports where it saved', alerts.some(text => text.includes('edited.webm')), alerts.slice(-1)[0] || '');

  // --- crash mid-recording keeps what was recorded ---
  await call('start_recording', { window_title: 'FrameBase E2E Target', max_seconds: 60 });
  await sleep(2500);
  studio().webContents.forcefullyCrashRenderer();
  await until(() => fs.readdirSync(recordings).some(file => file.includes('-recovered')), 20000, 'recovered file');
  const recovered = fs.readdirSync(recordings).find(file => file.includes('-recovered'));
  check('a renderer crash mid-recording keeps the file', fs.statSync(path.join(recordings, recovered)).size > 0, recovered);
  const afterCrash = await call('recording_status');
  check('state resets after a crash', afterCrash.data.recording === false);
  await until(() => studio() && !studio().webContents.isLoading(), 20000, 'studio reloads');
  await sleep(1500);
  await inStudio('window.alert = message => { (window.__alerts = window.__alerts || []).push(String(message)); }; true');

  check('no CSP violations or script errors in the console', consoleProblems.length === 0, consoleProblems.slice(0, 3).join(' | '));

  // --- quitting mid-recording saves the file ---
  const beforeQuit = new Set(fs.readdirSync(recordings));
  await call('start_recording', { window_title: 'FrameBase E2E Target', max_seconds: 60 });
  await sleep(2500);
  await client.close().catch(() => {});
  target.destroy();
  app.once('will-quit', () => {
    const added = fs.readdirSync(recordings).filter(file => !beforeQuit.has(file));
    check('quitting mid-recording saves the recording', added.some(file => file.endsWith('.webm') && !file.includes('recovered')), added.join(','));
    finish();
  });
  app.quit();
}

function finish() {
  const failed = results.filter(result => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? `; failed: ${failed.map(f => f.name).join('; ')}` : ''}`);
  if (!process.env.FRAMEBASE_E2E_KEEP) { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* Chromium may still hold profile files */ } }
  else console.log(`kept ${root}`);
  process.exitCode = failed.length ? 1 : 0;
}

app.whenReady().then(() => run().catch(error => {
  check('e2e run completed', false, error.stack || error.message);
  finish();
  app.exit(1);
}));
