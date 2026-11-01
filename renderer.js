// Studio UI: navigation, recording, the media library, the editor and export.
// Talks to the main process only through window.studio (preload.js).
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const api = window.studio;
const pages = { projects: $('#projects-page'), editor: $('#editor-page'), library: $('#library-page'), agent: $('#agent-page') };
const PAGE_TITLES = { projects: 'Home', editor: 'Editing space', library: 'Media library', agent: 'Agent control' };

let appInfo = { platform: api.platform, recordingsDir: '', ffmpeg: { available: false } };
// recording
let mediaStream = null, recorder = null, timer = null, seconds = 0, paused = false;
let selectedSource = 'screen', selectedCaptureSourceId = null, activeCaptureStreams = [], captureAudioContext = null;
let recordingStartedAt = 0, pausedTotalMs = 0, pausedAt = 0, writeQueue = Promise.resolve(), writeError = null;
// editor
let current = null, zoomLevel = 1, cropEnabled = false, textItems = [], playheadFrame = 0, exportFormat = 'mp4', recoveredGrants = [];

// ---- formatting ----
function fmt(n) {
  if (!Number.isFinite(n) || n < 0) n = 0;
  const m = Math.floor(n / 60), s = Math.floor(n % 60), cs = Math.floor((n % 1) * 100);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}
const clock = n => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
const formatDate = iso => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const el = (tag, props = {}, children = []) => { const node = Object.assign(document.createElement(tag), props); node.append(...children); return node; };

// ---- navigation ----
function showPage(name) {
  Object.entries(pages).forEach(([key, node]) => node.classList.toggle('active-page', key === name));
  $$('.nav-item[data-view]').forEach(button => button.classList.toggle('active', button.dataset.view === name));
  $('#crumb-current').textContent = PAGE_TITLES[name];
  if (name === 'projects' || name === 'library') refreshLibrary();
}
$$('.nav-item[data-view]').forEach(button => { button.onclick = () => showPage(button.dataset.view); });
$$('[data-view-link]').forEach(button => button.addEventListener('click', () => showPage(button.dataset.viewLink)));
$('#back-projects').onclick = () => showPage('projects');
const openEditor = () => showPage('editor');

// ---- library ----
const thumbnailLoader = new IntersectionObserver(entries => entries.forEach(entry => {
  if (!entry.isIntersecting) return;
  const video = entry.target;
  thumbnailLoader.unobserve(video);
  video.src = `${video.dataset.src}#t=0.5`;
}), { rootMargin: '200px' });

function mediaCard(item) {
  const video = el('video', { muted: true, preload: 'metadata', crossOrigin: 'anonymous' });
  video.dataset.src = item.url;
  const duration = el('span', { className: 'duration', hidden: true });
  video.onloadedmetadata = () => { if (Number.isFinite(video.duration)) { duration.textContent = clock(Math.round(video.duration)); duration.hidden = false; } };
  thumbnailLoader.observe(video);
  const thumb = el('button', { className: 'thumbnail', type: 'button', title: `Open ${item.name} in the editor` }, [video, duration, el('span', { className: 'play-hover', textContent: '▶' })]);
  thumb.onclick = () => { loadMedia(item); openEditor(); };
  const reveal = el('button', { className: 'card-action', type: 'button', textContent: 'Show', title: 'Show in folder' });
  reveal.onclick = () => api.media.reveal(item.token).catch(error => alert(error.message));
  return el('article', { className: 'project-card media-card' }, [thumb, el('div', { className: 'card-info' }, [el('div', {}, [el('h3', { textContent: item.name, title: item.name }), el('span', { textContent: `${formatDate(item.modified)} · ${formatBytes(item.bytes)}` })]), reveal])]);
}

async function refreshLibrary() {
  let items;
  try { items = await api.media.list(); } catch (error) { console.error('Could not list recordings:', error); return; }
  $('#library-count').textContent = items.length ? String(items.length) : '';
  $('#stat-count').textContent = String(items.length);
  $('#stat-size').textContent = items.length ? formatBytes(items.reduce((sum, item) => sum + item.bytes, 0)) : '0 MB';
  const importCard = el('button', { className: 'new-project-card', type: 'button' }, [el('span', { className: 'plus', textContent: '＋' }), el('strong', { textContent: 'Import a clip' }), el('span', { textContent: 'Open a video from anywhere on this computer' })]);
  importCard.onclick = importClip;
  const recent = items.slice(0, 5).map(mediaCard);
  if (!items.length) recent.push(el('div', { className: 'grid-empty', textContent: 'No recordings yet. Press New recording, or let an agent record for you.' }));
  $('#recent-grid').replaceChildren(...recent, importCard);
  $('#library-grid').replaceChildren(...items.map(mediaCard));
  $('#library-empty').hidden = items.length > 0;
}
$('#open-folder').onclick = $('#library-folder').onclick = () => api.media.openFolder().catch(error => alert(error.message));

// ---- recording ----
function openModal() {
  if (recorder && recorder.state !== 'inactive') return;
  $('#record-modal').hidden = false;
}
$('#new-record').onclick = openModal;
$('#preview-record').onclick = openModal;
$('#library-record').onclick = openModal;
$('#close-modal').onclick = () => { $('#record-modal').hidden = true; };
$('#record-modal').onclick = event => { if (event.target.id === 'record-modal') event.currentTarget.hidden = true; };
$$('#source-options .source-option').forEach(button => {
  button.onclick = () => { $$('#source-options .source-option').forEach(x => x.classList.toggle('selected', x === button)); selectedSource = button.dataset.type; };
});

async function openSourcePicker() {
  const picker = $('#source-picker'), grid = $('#source-grid');
  $('#source-picker-title').textContent = selectedSource === 'window' ? 'Choose an app window' : 'Choose a screen';
  $('#source-picker-hint').textContent = selectedSource === 'window' ? 'Select the exact app window you want to record.' : 'Select the display you want to record.';
  $('#confirm-source').disabled = true;
  selectedCaptureSourceId = null;
  grid.replaceChildren(el('div', { className: 'source-loading', textContent: 'Finding open screens and windows…' }));
  picker.hidden = false;
  try {
    const sources = (await api.getSources()).filter(source => source.type === selectedSource);
    if (!sources.length) { grid.replaceChildren(el('div', { className: 'source-loading', textContent: 'No matching sources found. Open a window and try again.' })); return; }
    grid.replaceChildren(...sources.map(source => {
      const card = el('button', { className: 'source-card', type: 'button' }, [el('img', { src: source.image, alt: '' }), el('strong', { textContent: source.name }), el('small', { textContent: source.type === 'window' ? 'Application window' : 'Display' })]);
      card.onclick = () => { $$('.source-card').forEach(item => item.classList.toggle('selected', item === card)); selectedCaptureSourceId = source.id; $('#confirm-source').disabled = false; };
      return card;
    }));
  } catch (error) {
    console.error('Could not list capture sources:', error);
    grid.replaceChildren(el('div', { className: 'source-loading', textContent: 'Could not load screens or app windows. Restart the app and try again.' }));
  }
}
$('#begin-recording').onclick = openSourcePicker;
$('#source-picker-back').onclick = () => { $('#source-picker').hidden = true; };
$('#source-picker').onclick = event => { if (event.target.id === 'source-picker') event.currentTarget.hidden = true; };

function createRecordingStream(displayStream, micStream) {
  const videoTracks = displayStream.getVideoTracks();
  const audioTracks = [...displayStream.getAudioTracks(), ...(micStream ? micStream.getAudioTracks() : [])];
  if (!audioTracks.length) return new MediaStream(videoTracks);
  if (!captureAudioContext) throw new Error('Audio processing could not start. Please try again.');
  const output = captureAudioContext.createGain(), destination = captureAudioContext.createMediaStreamDestination();
  output.connect(destination);
  audioTracks.forEach(track => captureAudioContext.createMediaStreamSource(new MediaStream([track])).connect(output));
  return new MediaStream([...videoTracks, ...destination.stream.getAudioTracks()]);
}

async function cleanupCapture() {
  activeCaptureStreams.forEach(stream => stream.getTracks().forEach(track => track.stop()));
  activeCaptureStreams = [];
  if (captureAudioContext) { await captureAudioContext.close().catch(() => {}); captureAudioContext = null; }
  mediaStream = null;
}

// Used by the Start recording button and by an agent (agent-ui.js). Throws if capture could not start.
async function startCapture({ sourceId, systemAudio, microphone }) {
  if (recorder && recorder.state !== 'inactive') throw new Error('A recording is already running.');
  const wantsSystemAudio = Boolean(systemAudio) && (await appInfoReady).systemAudio === true;
  let begun = false;
  try {
    if (wantsSystemAudio || microphone) { captureAudioContext = new AudioContext(); await captureAudioContext.resume(); }
    await api.setCaptureSelection(sourceId, wantsSystemAudio);
    const displayStream = await navigator.mediaDevices.getDisplayMedia({ video: { width: { max: 3840 }, height: { max: 2160 }, frameRate: { ideal: 30, max: 30 } }, audio: wantsSystemAudio });
    activeCaptureStreams = [displayStream];
    // without permission the system audio track arrives already ended and stays silent; say so instead of recording silence
    if (wantsSystemAudio && !displayStream.getAudioTracks().some(track => track.readyState === 'live')) {
      throw new Error(appInfo.platform === 'darwin'
        ? 'macOS did not allow system audio. Allow FrameBase in System Settings › Privacy & Security › Screen & System Audio Recording (when you run it with npm start, allow your terminal app instead), or turn off system audio.'
        : 'System audio could not be captured. Turn off system audio and try again.');
    }
    let micStream = null;
    if (microphone) {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: false });
      activeCaptureStreams.push(micStream);
    }
    mediaStream = createRecordingStream(displayStream, micStream);
    if (!mediaStream.getVideoTracks().length) throw new Error('The selected source did not provide video.');
    const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus') ? 'video/webm;codecs=vp8,opus' : 'video/webm';
    recorder = new MediaRecorder(mediaStream, { mimeType, videoBitsPerSecond: 8000000, audioBitsPerSecond: 192000 });
    writeQueue = Promise.resolve();
    writeError = null;
    // each second of video goes straight to disk, in order, so a crash loses at most a second
    recorder.ondataavailable = event => {
      if (!event.data.size) return;
      const blob = event.data;
      writeQueue = writeQueue.then(async () => { if (!writeError) await api.recording.chunk(await blob.arrayBuffer()); })
        .catch(error => { writeError = error; stopRecording(); });
    };
    recorder.onstop = finishCapture;
    // the recorded window was closed, or the system ended the share
    displayStream.getVideoTracks()[0].addEventListener('ended', stopRecording);
    await api.recording.begin();
    begun = true;
    recorder.start(1000);
  } catch (error) {
    recorder = null;
    await cleanupCapture();
    if (begun) api.recording.failed(error.message);
    if (error.name === 'NotAllowedError') throw new Error('Capture was cancelled or blocked. Choose a screen or window and try again.');
    throw new Error(`Could not start recording: ${error.message || 'check screen and microphone permissions.'}`);
  }
  $('#record-modal').hidden = true;
  $('#source-picker').hidden = true;
  $('#recording-bar').hidden = false;
  seconds = 0; paused = false; pausedTotalMs = 0; pausedAt = 0;
  recordingStartedAt = performance.now();
  $('#record-clock').textContent = '00:00';
  $('#pause-recording').textContent = 'Ⅱ';
  timer = setInterval(() => {
    if (paused) return;
    seconds += 1;
    $('#record-clock').textContent = clock(seconds);
    api.recording.tick(seconds);
  }, 1000);
}

$('#confirm-source').onclick = async () => {
  if (!selectedCaptureSourceId) return;
  try {
    await startCapture({ sourceId: selectedCaptureSourceId, systemAudio: $('#system-audio-toggle').checked, microphone: $('#mic-toggle').checked });
  } catch (error) { alert(error.message); }
};

async function finishCapture() {
  clearInterval(timer);
  $('#recording-bar').hidden = true;
  const elapsedMs = Math.max(1, performance.now() - recordingStartedAt - pausedTotalMs - (paused ? performance.now() - pausedAt : 0));
  recorder = null;
  try {
    await writeQueue;
    if (writeError) throw writeError;
    const saved = await api.recording.finish(elapsedMs);
    loadMedia(saved);
    openEditor();
  } catch (error) {
    api.recording.failed(`Saving the recording failed: ${error.message}`);
    alert(`The recording could not be saved completely: ${error.message}\nAnything already written was kept in your recordings folder.`);
  } finally {
    await cleanupCapture();
    refreshLibrary();
  }
}

function pauseRecording() {
  if (!recorder || recorder.state === 'inactive') return;
  paused = recorder.state === 'recording';
  if (paused) { pausedAt = performance.now(); recorder.pause(); } else { pausedTotalMs += performance.now() - pausedAt; recorder.resume(); }
  $('#pause-recording').textContent = paused ? '▶' : 'Ⅱ';
  api.recording.paused(paused);
}
function stopRecording() {
  if (recorder && recorder.state !== 'inactive') recorder.stop();
}
$('#stop-recording').onclick = stopRecording;
$('#pause-recording').onclick = pauseRecording;

// ---- editor ----
const video = $('#preview-video');

function loadMedia(grant, edits = {}) {
  current = grant;
  zoomLevel = edits.zoomLevel || 1;
  cropEnabled = Boolean(edits.cropEnabled);
  textItems = Array.isArray(edits.textItems) ? edits.textItems.map(item => ({ ...item })) : [];
  video.pause();
  video.crossOrigin = 'anonymous';
  video.src = grant.url;
  video.hidden = false;
  $('#preview-frame').hidden = false;
  $('#empty-preview').hidden = true;
  $('#preview-badge').hidden = false;
  $('#clip-track').hidden = false;
  $('.track-empty').hidden = true;
  $('#clip-label').textContent = grant.name;
  $('#editor-title').textContent = grant.name.replace(/\.[^.]+$/, '');
  $('#inspector-empty').hidden = true;
  $('#inspector-panel').hidden = false;
  $('#fact-name').textContent = grant.name;
  $('#fact-name').title = grant.path;
  $('#fact-resolution').textContent = '…';
  $('#fact-duration').textContent = '…';
  syncEditControls();
  renderTextItems();
  applyViewTransform();
  video.load();
}

video.onloadedmetadata = () => {
  fitPreviewFrame();
  const total = Number.isFinite(video.duration) ? video.duration : 0;
  $('#total-time').textContent = fmt(total);
  $('#timeline-duration').textContent = fmt(total).slice(0, 5);
  $('#fact-resolution').textContent = video.videoWidth ? `${video.videoWidth} × ${video.videoHeight}` : 'Audio only';
  $('#fact-duration').textContent = Number.isFinite(video.duration) ? fmt(video.duration) : 'Unknown';
  renderRuler(total);
  updatePlayhead();
};
video.onerror = () => { if (current) alert(`This video could not be played: ${current.name}`); };

function videoDuration() { return Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 1; }
function renderRuler(duration) {
  const labels = $$('.timeline-ruler span');
  labels.forEach((label, i) => { label.textContent = fmt((duration * i) / (labels.length - 1)).slice(0, 5); });
}
function updatePlayhead() {
  if (video.hidden) return;
  const ratio = Math.min(1, Math.max(0, (video.currentTime || 0) / videoDuration()));
  $('.playhead').style.left = `${ratio * 100}%`;
  $('#play-time').textContent = fmt(video.currentTime || 0);
}

async function importClip() {
  try {
    const grant = await api.media.import();
    if (grant) { loadMedia(grant); openEditor(); }
  } catch (error) { alert(`Could not open this file: ${error.message}`); }
}
$('#import-clip').onclick = importClip;
$('#library-import').onclick = importClip;
$('#reveal-clip').onclick = () => { if (current) api.media.reveal(current.token).catch(error => alert(error.message)); };

// frame edits
function syncEditControls() {
  $('#zoom-range').value = String(Math.round(zoomLevel * 100));
  $('#zoom-value').textContent = `${Math.round(zoomLevel * 100)}%`;
  $('#crop-check').checked = cropEnabled;
  $('#crop-tool').classList.toggle('selected', cropEnabled);
  $('#zoom-tool').classList.toggle('selected', zoomLevel !== 1);
  $('#text-tool').classList.toggle('selected', textItems.length > 0);
}
// The frame is the exported picture: the video's shape, or the stage's shape when cropping to fill.
// It is fitted inside the stage so the whole picture shows, and text positions are relative to it.
function fitPreviewFrame() {
  const stage = $('#preview-stage'), frame = $('#preview-frame');
  const stageWidth = stage.clientWidth, stageHeight = stage.clientHeight;
  if (!stageWidth || !stageHeight) return;
  const aspect = cropEnabled || !video.videoWidth ? stageWidth / stageHeight : video.videoWidth / video.videoHeight;
  const width = Math.min(stageWidth, stageHeight * aspect);
  frame.style.width = `${Math.floor(width)}px`;
  frame.style.height = `${Math.floor(width / aspect)}px`;
}
new ResizeObserver(fitPreviewFrame).observe($('#preview-stage'));
function applyViewTransform() {
  video.style.transform = `scale(${zoomLevel})`;
  video.style.objectFit = cropEnabled ? 'cover' : 'contain';
  fitPreviewFrame();
}
const hasEdits = () => zoomLevel !== 1 || cropEnabled || textItems.length > 0;
function requireClip() {
  if (current) return true;
  alert('Record or import a clip first.');
  return false;
}
$('#zoom-range').oninput = event => { zoomLevel = Number(event.target.value) / 100; syncEditControls(); applyViewTransform(); };
$('#crop-check').onchange = event => { cropEnabled = event.target.checked; syncEditControls(); applyViewTransform(); };
$('#zoom-tool').onclick = () => { if (requireClip()) $('#zoom-range').focus(); };
$('#crop-tool').onclick = () => { if (!requireClip()) return; cropEnabled = !cropEnabled; syncEditControls(); applyViewTransform(); };
$('#text-tool').onclick = () => { if (requireClip()) $('#text-input').focus(); };
$('#text-form').onsubmit = event => {
  event.preventDefault();
  const value = $('#text-input').value.trim();
  if (!value || !requireClip()) return;
  textItems.push({ text: value, x: 38, y: 44 });
  $('#text-input').value = '';
  renderTextItems();
};

function renderTextItems() {
  const layer = $('#text-overlay-layer');
  layer.replaceChildren(...textItems.map(item => {
    const node = el('div', { className: 'preview-text', textContent: item.text, title: 'Drag to move' });
    node.style.left = `${item.x}%`;
    node.style.top = `${item.y}%`;
    node.onpointerdown = event => {
      node.setPointerCapture(event.pointerId);
      const rect = layer.getBoundingClientRect(), box = node.getBoundingClientRect();
      const offsetX = event.clientX - box.left, offsetY = event.clientY - box.top;
      node.onpointermove = move => {
        item.x = Math.max(0, Math.min(95, ((move.clientX - offsetX - rect.left) / rect.width) * 100));
        item.y = Math.max(0, Math.min(95, ((move.clientY - offsetY - rect.top) / rect.height) * 100));
        node.style.left = `${item.x}%`;
        node.style.top = `${item.y}%`;
      };
      node.onpointerup = () => { node.onpointermove = null; };
    };
    return node;
  }));
  $('#text-list').replaceChildren(...textItems.map((item, index) => {
    const input = el('input', { type: 'text', value: item.text, maxLength: 500 });
    input.oninput = () => { item.text = input.value; layer.children[index].textContent = input.value; };
    const remove = el('button', { type: 'button', textContent: '×', title: 'Remove this text' });
    remove.onclick = () => { textItems.splice(index, 1); renderTextItems(); };
    return el('li', {}, [input, remove]);
  }));
  syncEditControls();
}

// playback
function animatePlayhead() { updatePlayhead(); if (!video.paused) playheadFrame = requestAnimationFrame(animatePlayhead); }
$('#play-toggle').onclick = () => {
  if (video.hidden) return;
  if (video.paused) {
    if (video.ended || (Number.isFinite(video.duration) && video.currentTime >= video.duration)) video.currentTime = 0;
    video.play().catch(error => { console.error('Video playback failed:', error); alert('This video could not be played. Try recording again or importing a different file.'); });
  } else video.pause();
};
video.ontimeupdate = updatePlayhead;
video.onplay = () => { $('#play-toggle').textContent = 'Ⅱ'; cancelAnimationFrame(playheadFrame); playheadFrame = requestAnimationFrame(animatePlayhead); };
video.onpause = () => { $('#play-toggle').textContent = '▶'; cancelAnimationFrame(playheadFrame); updatePlayhead(); };
video.onended = () => { $('#play-toggle').textContent = '▶'; updatePlayhead(); };
let lastPreviewVolume = 1;
function syncVolume() {
  const volume = $('#volume-control');
  video.volume = Number(volume.value);
  video.muted = video.volume === 0;
  $('#mute-toggle').textContent = video.muted ? '◖×' : '◖))';
  $('#mute-toggle').title = video.muted ? 'Unmute audio' : 'Mute audio';
  if (!video.muted) lastPreviewVolume = video.volume;
}
$('#volume-control').oninput = syncVolume;
$('#mute-toggle').onclick = () => {
  const volume = $('#volume-control');
  if (video.muted || video.volume === 0) { video.muted = false; volume.value = String(lastPreviewVolume || 1); } else { lastPreviewVolume = video.volume; volume.value = '0'; }
  syncVolume();
};
$('#track-area').onclick = event => {
  if (video.hidden) return;
  const rect = event.currentTarget.getBoundingClientRect(), ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
  video.currentTime = ratio * videoDuration();
  updatePlayhead();
};

// ---- projects ----
const safeName = () => ($('#editor-title').textContent || 'FrameBase recording').replace(/[^a-z0-9-_ ]/gi, '').trim() || 'FrameBase recording';
$('#save-project').onclick = async () => {
  if (!requireClip()) return;
  try {
    const result = await api.project.save({ name: safeName(), mediaToken: current.token, edits: { zoomLevel, cropEnabled, textItems } });
    if (!result.canceled) alert(`Project saved:\n${result.filePath}\n\nThe project points to the video in its current place, so keep them together.`);
  } catch (error) { alert(`Could not save project: ${error.message}`); }
};
$('#open-project').onclick = async () => {
  try {
    const project = await api.project.open();
    if (!project) return;
    loadMedia(project.media, project.edits);
    $('#editor-title').textContent = project.name;
    openEditor();
  } catch (error) { alert(`Could not open project: ${error.message}`); }
};

// ---- export ----
function openExport() {
  if (!requireClip()) return;
  const mp4 = $('#export-modal [data-format="mp4"]');
  mp4.disabled = !appInfo.ffmpeg.available;
  $('#export-mp4-note').textContent = appInfo.ffmpeg.available ? 'Plays everywhere.' : 'Needs FFmpeg installed and on PATH.';
  if (!appInfo.ffmpeg.available) exportFormat = 'webm';
  $$('#export-modal [data-format]').forEach(button => button.classList.toggle('selected', button.dataset.format === exportFormat));
  const length = !Number.isFinite(video.duration) ? '' : video.duration < 90 ? `, about ${Math.ceil(video.duration)} s` : `, about ${Math.round(video.duration / 60)} min`;
  $('#export-summary').textContent = hasEdits()
    ? `Zoom, crop and text are burned in. The clip plays once to render${length}; keep this window open.`
    : 'The clip is saved as-is, or converted if you pick another format.';
  $('#export-status').textContent = '';
  $('#export-modal').hidden = false;
}
$$('#export-modal [data-format]').forEach(button => {
  button.onclick = () => { if (button.disabled) return; exportFormat = button.dataset.format; $$('#export-modal [data-format]').forEach(x => x.classList.toggle('selected', x === button)); };
});
$('#export-close').onclick = () => { $('#export-modal').hidden = true; };
$('#export-video').onclick = openExport;

$('#export-start').onclick = async () => {
  const button = $('#export-video');
  const job = await api.exporter.begin({ format: exportFormat, name: safeName() }).catch(error => { alert(error.message); return { canceled: true }; });
  if (job.canceled) return;
  $('#export-modal').hidden = true;
  button.disabled = true;
  button.textContent = 'Exporting…';
  try {
    let result;
    if (hasEdits()) {
      const durationMs = await renderEditedClip(chunk => api.exporter.chunk(job.id, chunk));
      button.textContent = 'Saving…';
      result = await api.exporter.finish(job.id, durationMs);
    } else {
      result = await api.exporter.fromSource(job.id, current.token);
    }
    alert(`Exported to:\n${result.filePath}`);
  } catch (error) {
    await api.exporter.cancel(job.id).catch(() => {});
    alert(`Export failed: ${error.message}`);
  } finally {
    button.disabled = false;
    button.replaceChildren('Export ', el('span', { textContent: '↗' }));
  }
};

// Plays the clip once onto a canvas with the zoom, crop and text applied, streaming the result to main.
async function renderEditedClip(sendChunk) {
  const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d');
  canvas.width = video.videoWidth - (video.videoWidth % 2);
  const frame = $('#preview-frame'), stageWidth = frame.clientWidth || canvas.width, stageHeight = frame.clientHeight || video.videoHeight;
  canvas.height = cropEnabled ? Math.max(2, Math.round(canvas.width / (stageWidth / stageHeight) / 2) * 2) : video.videoHeight - (video.videoHeight % 2);
  if (!canvas.width || !canvas.height) throw new Error('The video is not ready to export.');
  const oldTime = video.currentTime, wasPaused = video.paused, oldVolume = video.volume, oldMuted = video.muted, raf = { id: 0 };
  const draw = () => {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const scale = (cropEnabled ? Math.max(canvas.width / video.videoWidth, canvas.height / video.videoHeight) : Math.min(canvas.width / video.videoWidth, canvas.height / video.videoHeight)) * zoomLevel;
    const w = video.videoWidth * scale, h = video.videoHeight * scale;
    ctx.drawImage(video, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
    textItems.forEach(item => {
      const fontSize = Math.max(16, (20 * canvas.width) / stageWidth);
      ctx.font = `600 ${fontSize}px Manrope, Arial, sans-serif`;
      ctx.textBaseline = 'top';
      const lines = String(item.text).split('\n'), lineHeight = fontSize * 1.25, pad = fontSize * 0.25;
      const maxWidth = Math.max(...lines.map(line => ctx.measureText(line).width), 1);
      const x = (item.x / 100) * canvas.width, y = (item.y / 100) * canvas.height;
      ctx.fillStyle = 'rgba(0,0,0,.5)';
      ctx.fillRect(x, y, maxWidth + pad * 2, lines.length * lineHeight + pad * 2);
      ctx.fillStyle = '#fff';
      ctx.shadowColor = '#000';
      ctx.shadowBlur = fontSize * 0.2;
      lines.forEach((line, index) => ctx.fillText(line, x + pad, y + pad + index * lineHeight));
      ctx.shadowBlur = 0;
    });
  };
  video.pause();
  video.volume = 1;
  video.muted = false;
  if (video.currentTime !== 0) { video.currentTime = 0; await new Promise(resolve => video.addEventListener('seeked', resolve, { once: true })); }
  draw();
  const canvasStream = canvas.captureStream(30), sourceStream = video.captureStream();
  sourceStream.getAudioTracks().forEach(track => canvasStream.addTrack(track));
  const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus') ? 'video/webm;codecs=vp8,opus' : 'video/webm';
  const mediaRecorder = new MediaRecorder(canvasStream, { mimeType, videoBitsPerSecond: 12000000, audioBitsPerSecond: 192000 });
  let sendQueue = Promise.resolve(), sendError = null;
  mediaRecorder.ondataavailable = event => {
    if (!event.data.size) return;
    const blob = event.data;
    sendQueue = sendQueue.then(async () => { if (!sendError) await sendChunk(await blob.arrayBuffer()); }).catch(error => { sendError = error; video.pause(); });
  };
  const ended = new Promise((resolve, reject) => {
    video.addEventListener('ended', resolve, { once: true });
    video.addEventListener('error', () => reject(new Error('The source video stopped before export finished.')), { once: true });
  });
  const stopped = new Promise(resolve => mediaRecorder.addEventListener('stop', resolve, { once: true }));
  mediaRecorder.start(1000);
  let lastUpdate = 0;
  const tick = now => {
    draw();
    if (now - lastUpdate > 1000) { $('#export-video').textContent = `Rendering ${Math.min(99, Math.floor((video.currentTime / video.duration) * 100))}%`; lastUpdate = now; }
    if (!video.ended) raf.id = requestAnimationFrame(tick);
  };
  raf.id = requestAnimationFrame(tick);
  try {
    await video.play();
    await ended;
    mediaRecorder.stop();
    await stopped;
    await sendQueue;
    if (sendError) throw sendError;
    return Math.max(1, video.duration * 1000);
  } finally {
    cancelAnimationFrame(raf.id);
    if (mediaRecorder.state !== 'inactive') mediaRecorder.stop();
    canvasStream.getTracks().forEach(track => track.stop());
    sourceStream.getTracks().forEach(track => track.stop());
    video.pause();
    video.currentTime = Math.min(oldTime, video.duration || oldTime);
    video.volume = oldVolume;
    video.muted = oldMuted;
    if (!wasPaused) video.play().catch(() => {});
  }
}

// ---- recovered recordings ----
function showRecovered(list) {
  recoveredGrants = list;
  $('#recovered-text').textContent = list.length === 1 ? `${list[0].name} was saved from a recording that did not finish.` : `${list.length} recordings that did not finish were saved.`;
  $('#recovered-notice').hidden = false;
  refreshLibrary();
}
$('#recovered-open').onclick = () => { if (recoveredGrants[0]) { loadMedia(recoveredGrants[0]); openEditor(); } $('#recovered-notice').hidden = true; };
$('#recovered-close').onclick = () => { $('#recovered-notice').hidden = true; };

// ---- keyboard and main-process events ----
document.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'r') { event.preventDefault(); openModal(); }
  if (event.key === 'Escape') { $('#record-modal').hidden = true; $('#export-modal').hidden = true; $('#source-picker').hidden = true; }
});
api.on('recording:toggle-pause', pauseRecording);
api.on('recording:stop', stopRecording);
api.on('studio:focus-editor', () => { if (current) openEditor(); });
api.on('editor:open', grant => { loadMedia(grant); openEditor(); refreshLibrary(); });
api.on('studio:recovered', showRecovered);
api.on('studio:open-record', openModal);

const appInfoReady = api.appInfo().then(info => {
  appInfo = info;
  $('#record-shortcut').textContent = info.platform === 'darwin' ? '⌘ R' : 'Ctrl R';
  $('#folder-path').textContent = info.recordingsDir;
  $('#folder-path').title = info.recordingsDir;
  $('#stat-ffmpeg').textContent = info.ffmpeg.available ? `FFmpeg ${info.ffmpeg.version}` : 'FFmpeg not found';
  if (info.platform === 'darwin') $('#system-audio-note').textContent = 'Capture sound playing on this Mac';
  if (!info.systemAudio) {
    $('#system-audio-toggle').checked = false;
    $('#system-audio-toggle').disabled = true;
    $('#system-audio-row').classList.add('disabled');
    $('#system-audio-note').textContent = info.platform === 'darwin' ? 'Needs macOS 14.2 or newer' : 'Available on Windows and macOS only';
  }
  return info;
});
refreshLibrary();
