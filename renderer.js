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
let current = null, cropEnabled = false, textItems = [], zooms = [], selected = null, playheadFrame = 0, exportFormat = 'mp4', recoveredGrants = [];

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
  ({ cropEnabled, textItems, zooms } = editTiming.normalizeEdits(edits));
  selected = null;
  video.pause();
  video.crossOrigin = 'anonymous';
  video.src = grant.url;
  video.hidden = false;
  $('#preview-frame').hidden = false;
  $('#empty-preview').hidden = true;
  $('#preview-badge').hidden = false;
  $('#clip-track').hidden = false;
  $('#text-lane').hidden = false;
  $('#zoom-lane').hidden = false;
  $('.track-empty').hidden = true;
  $('#clip-label').textContent = grant.name;
  $('#editor-title').textContent = grant.name.replace(/\.[^.]+$/, '');
  $('#inspector-empty').hidden = true;
  $('#inspector-panel').hidden = false;
  $('#fact-name').textContent = grant.name;
  $('#fact-name').title = grant.path;
  $('#fact-resolution').textContent = '…';
  $('#fact-duration').textContent = '…';
  editsChanged();
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
  editTiming.fitToDuration(textItems, total);
  editTiming.fitToDuration(zooms, total);
  editsChanged();
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
  applyTimedEdits();
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

// ---- timed edits: text and zoom placed on the timeline ----
// Each text and zoom has a start and end in seconds. The preview and the export both ask edit-timing.js what shows
// at the current moment, so what plays in the preview is what gets exported.
const textNodes = new Map();
const isTextItem = item => textItems.includes(item);
const hasEdits = () => cropEnabled || textItems.length > 0 || zooms.length > 0;
function requireClip() {
  if (current) return true;
  alert('Record or import a clip first.');
  return false;
}

function editsChanged() {
  if (selected && !isTextItem(selected) && !zooms.includes(selected)) selected = null;
  renderTextNodes();
  renderTimelineEdits();
  renderEditLists();
  renderSelected();
  syncEditControls();
  fitPreviewFrame();
  applyTimedEdits();
}
function syncEditControls() {
  $('#crop-check').checked = cropEnabled;
  $('#crop-tool').classList.toggle('selected', cropEnabled);
  $('#zoom-tool').classList.toggle('selected', zooms.length > 0);
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
  // text sizes are pixels of a 1080-pixel-tall frame
  frame.style.setProperty('--text-scale', String(Math.floor(width / aspect) / 1080));
}
new ResizeObserver(fitPreviewFrame).observe($('#preview-stage'));

// What the preview shows at the playhead. While a zoom is selected and the clip is paused, the picture stays
// unzoomed and a box marks the part that will fill the frame, so it can be dragged into place.
function applyTimedEdits() {
  const time = video.currentTime || 0;
  video.style.objectFit = cropEnabled ? 'cover' : 'contain';
  const editingZoom = Boolean(selected) && !isTextItem(selected) && video.paused;
  const view = editTiming.zoomView(editingZoom ? { level: 1, x: 50, y: 50 } : editTiming.zoomAt(zooms, time));
  video.style.transform = `translate(${view.tx * 100}%, ${view.ty * 100}%) scale(${view.level})`;
  const box = $('#zoom-box');
  box.hidden = !editingZoom;
  if (editingZoom) {
    const area = editTiming.zoomView(selected).box;
    Object.assign(box.style, { left: `${area.left * 100}%`, top: `${area.top * 100}%`, width: `${area.width * 100}%`, height: `${area.height * 100}%` });
    box.textContent = `${Math.round(selected.level * 100)}%`;
  }
  textItems.forEach(item => {
    const node = textNodes.get(item);
    if (node) node.hidden = !(item === selected || editTiming.textsAt([item], time).length > 0);
  });
}

function renderTextNodes() {
  const layer = $('#text-overlay-layer');
  for (const [item, node] of textNodes) if (!isTextItem(item)) { node.remove(); textNodes.delete(item); }
  textItems.forEach(item => {
    let node = textNodes.get(item);
    if (!node) {
      node = el('div', { className: 'preview-text', title: 'Drag to move' });
      node.onpointerdown = event => {
        select(item, { seek: false });
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
      textNodes.set(item, node);
      layer.append(node);
    }
    node.textContent = item.text;
    Object.assign(node.style, {
      left: `${item.x}%`, top: `${item.y}%`,
      fontFamily: editTiming.FONTS[item.font].css, fontSize: `calc(var(--text-scale, 0.4) * ${item.size}px)`,
      fontWeight: item.bold ? '700' : '400', fontStyle: item.italic ? 'italic' : 'normal',
      color: item.color, background: item.backgroundOpacity > 0 ? editTiming.rgba(item.background, item.backgroundOpacity) : 'transparent'
    });
    node.classList.toggle('selected', item === selected);
  });
}

// drag the zoom box to choose where the selected zoom points
$('#zoom-box').onpointerdown = event => {
  if (!selected || isTextItem(selected)) return;
  const box = event.currentTarget, frame = $('#preview-frame').getBoundingClientRect(), start = box.getBoundingClientRect();
  const offsetX = event.clientX - (start.left + start.width / 2), offsetY = event.clientY - (start.top + start.height / 2);
  box.setPointerCapture(event.pointerId);
  box.onpointermove = move => {
    const x = ((move.clientX - offsetX - frame.left) / frame.width) * 100, y = ((move.clientY - offsetY - frame.top) / frame.height) * 100;
    const area = editTiming.zoomView({ level: selected.level, x, y }).box;
    selected.x = (area.left + area.width / 2) * 100;
    selected.y = (area.top + area.height / 2) * 100;
    applyTimedEdits();
  };
  box.onpointerup = () => { box.onpointermove = null; };
};

// timeline tracks: drag a block to move it, drag its edges to change when it starts or ends
function renderTimelineEdits() {
  const duration = videoDuration();
  const lanes = [['#text-lane', textItems, item => item.text], ['#zoom-lane', zooms, item => `Zoom ${Math.round(item.level * 100)}%`]];
  lanes.forEach(([lane, items, label]) => {
    const { rows, count } = editTiming.stackRows(items);
    $(lane).replaceChildren(...items.map(item => {
      const block = el('div', { className: `edit-block${item === selected ? ' selected' : ''}`, title: `${label(item)}: ${fmt(item.start)} to ${fmt(item.end)}. Drag to move, drag the edges to change the length.` }, [
        el('span', { className: 'edit-handle start' }), el('span', { className: 'edit-label', textContent: label(item) }), el('span', { className: 'edit-handle end' })
      ]);
      const place = () => {
        block.style.left = `${(item.start / duration) * 100}%`;
        block.style.width = `${((item.end - item.start) / duration) * 100}%`;
      };
      place();
      block.style.top = `${(rows.get(item) / count) * 100}%`;
      block.style.height = `${100 / count}%`;
      block.onclick = event => event.stopPropagation();
      block.onpointerdown = event => {
        event.stopPropagation();
        const edge = event.target.classList;
        const mode = edge.contains('start') ? 'start' : edge.contains('end') ? 'end' : 'move';
        const width = $(lane).getBoundingClientRect().width || 1, x0 = event.clientX, { start, end } = item;
        video.pause();
        select(item, { seek: false, timeline: false });
        $$('.edit-block.selected').forEach(other => other.classList.remove('selected'));
        block.classList.add('selected');
        block.setPointerCapture(event.pointerId);
        let moved = false;
        block.onpointermove = move => {
          if (Math.abs(move.clientX - x0) > 2) moved = true;
          if (!moved) return;
          const delta = ((move.clientX - x0) / width) * duration;
          if (mode === 'move') {
            const shift = Math.max(-start, Math.min(duration - end, delta));
            item.start = start + shift;
            item.end = end + shift;
          }
          if (mode === 'start') item.start = Math.max(0, Math.min(end - editTiming.MIN_LENGTH, start + delta));
          if (mode === 'end') item.end = Math.min(duration, Math.max(start + editTiming.MIN_LENGTH, end + delta));
          place();
          // show the frame at the edge being moved
          video.currentTime = mode === 'end' ? Math.max(item.start, item.end - 0.05) : item.start;
          syncSelectedTimes();
        };
        block.onpointerup = () => {
          block.onpointermove = null;
          if (!moved) select(item);
          editsChanged();
        };
      };
      return block;
    }));
  });
}

function renderEditLists() {
  const row = (item, label) => {
    const pick = el('button', { type: 'button', className: `edit-pick${item === selected ? ' selected' : ''}`, title: 'Select' }, [
      el('span', { textContent: label }), el('small', { textContent: `${fmt(item.start).slice(0, 7)} – ${fmt(item.end).slice(0, 7)}` })
    ]);
    pick.onclick = () => select(item);
    const remove = el('button', { type: 'button', className: 'edit-remove', textContent: '×', title: 'Remove' });
    remove.onclick = () => removeEdit(item);
    return el('li', {}, [pick, remove]);
  };
  $('#text-list').replaceChildren(...textItems.map(item => row(item, item.text)));
  $('#zoom-list').replaceChildren(...zooms.map(item => row(item, `Zoom ${Math.round(item.level * 100)}%`)));
}

// the selected text or zoom, with its exact times
function renderSelected() {
  $('#selected-edit').hidden = !selected;
  if (!selected) return;
  const text = isTextItem(selected);
  $('#selected-title').textContent = text ? 'Selected text' : 'Selected zoom';
  $('#selected-text-field').hidden = !text;
  $('#text-style-fields').hidden = !text;
  $('#selected-level-field').hidden = text;
  $('#selected-zoom-hint').hidden = text;
  if (text) {
    if (document.activeElement !== $('#selected-text')) $('#selected-text').value = selected.text;
    syncTextStyleFields();
  } else { $('#zoom-range').value = String(Math.round(selected.level * 100)); $('#zoom-value').textContent = `${Math.round(selected.level * 100)}%`; }
  syncSelectedTimes();
}
function syncTextStyleFields() {
  $('#text-font').value = selected.font;
  $('#text-size').value = String(selected.size);
  $('#text-size-value').textContent = String(selected.size);
  $('#text-bold').checked = selected.bold;
  $('#text-italic').checked = selected.italic;
  $('#text-color').value = selected.color;
  $('#text-bg').value = selected.background;
  $('#text-bg-opacity').value = String(selected.backgroundOpacity);
  $('#text-bg-value').textContent = selected.backgroundOpacity ? `${selected.backgroundOpacity}%` : 'Off';
  $$('#text-swatches button').forEach(swatch => swatch.classList.toggle('selected', swatch.dataset.color === selected.color));
}

// text style: the selected text changes as you edit, and new text starts with the last style used
let lastTextStyle = { ...editTiming.TEXT_STYLE };
$('#text-font').replaceChildren(...Object.entries(editTiming.FONTS).map(([key, font]) => {
  const option = el('option', { value: key, textContent: font.label });
  option.style.fontFamily = font.css;
  return option;
}));
['#ffffff', '#111111', '#ffd400', '#d6f279', '#ff5a4f', '#4fa3ff', '#ff7bd5'].forEach(color => {
  const swatch = el('button', { type: 'button', title: color });
  swatch.dataset.color = color;
  swatch.style.background = color;
  swatch.onclick = () => setTextStyle({ color });
  $('#text-swatches').append(swatch);
});
function setTextStyle(change) {
  if (!selected || !isTextItem(selected)) return;
  Object.assign(selected, editTiming.textStyle({ ...selected, ...change }));
  lastTextStyle = editTiming.textStyle(selected);
  syncTextStyleFields();
  renderTextNodes();
}
$('#text-font').onchange = event => setTextStyle({ font: event.target.value });
$('#text-size').oninput = event => setTextStyle({ size: Number(event.target.value) });
$('#text-bold').onchange = event => setTextStyle({ bold: event.target.checked });
$('#text-italic').onchange = event => setTextStyle({ italic: event.target.checked });
$('#text-color').oninput = event => setTextStyle({ color: event.target.value });
$('#text-bg').oninput = event => setTextStyle({ background: event.target.value, backgroundOpacity: selected && selected.backgroundOpacity === 0 ? 55 : selected?.backgroundOpacity });
$('#text-bg-opacity').oninput = event => setTextStyle({ backgroundOpacity: Number(event.target.value) });
function syncSelectedTimes() {
  if (!selected) return;
  [['#selected-start', selected.start], ['#selected-end', selected.end]].forEach(([id, value]) => {
    if (document.activeElement !== $(id)) $(id).value = value.toFixed(1);
  });
}
function select(item, { seek = true, timeline = true } = {}) {
  selected = item;
  // jump to a moment the item applies to, so the preview shows it
  if (seek && item && !(video.currentTime >= item.start && video.currentTime < item.end)) video.currentTime = item.start;
  renderTextNodes();
  if (timeline) renderTimelineEdits();
  renderEditLists();
  renderSelected();
  applyTimedEdits();
}
function removeEdit(item) {
  textItems = textItems.filter(other => other !== item);
  zooms = zooms.filter(other => other !== item);
  editsChanged();
}
function addText(text) {
  const item = { text, x: 38, y: 44, ...editTiming.placeAt(video.currentTime || 0, videoDuration()), ...lastTextStyle };
  textItems.push(item);
  editsChanged();
  select(item);
}
function addZoom() {
  if (!requireClip()) return;
  video.pause();
  const item = { level: 1.5, x: 50, y: 50, ...editTiming.placeAt(video.currentTime || 0, videoDuration()) };
  zooms.push(item);
  editsChanged();
  select(item);
}

$('#selected-text').oninput = event => {
  if (!selected || !isTextItem(selected)) return;
  selected.text = event.target.value.slice(0, 500);
  renderTextNodes();
  renderTimelineEdits();
  renderEditLists();
};
$('#zoom-range').oninput = event => {
  if (!selected || isTextItem(selected)) return;
  selected.level = Number(event.target.value) / 100;
  $('#zoom-value').textContent = `${event.target.value}%`;
  renderTimelineEdits();
  renderEditLists();
  applyTimedEdits();
};
$$('#selected-start, #selected-end').forEach(input => {
  input.onchange = () => {
    const value = Number(input.value);
    if (!selected || input.value === '' || !Number.isFinite(value)) return syncSelectedTimes();
    if (input.id === 'selected-start') selected.start = Math.max(0, Math.min(selected.end - editTiming.MIN_LENGTH, value));
    else selected.end = Math.min(videoDuration(), Math.max(selected.start + editTiming.MIN_LENGTH, value));
    editsChanged();
  };
});
$('#selected-delete').onclick = () => { if (selected) removeEdit(selected); };
document.addEventListener('keydown', event => {
  if (!selected || !['Delete', 'Backspace'].includes(event.key) || !pages.editor.classList.contains('active-page')) return;
  if (event.target.closest('input, textarea, select')) return;
  event.preventDefault();
  removeEdit(selected);
});
$('#crop-check').onchange = event => { cropEnabled = event.target.checked; editsChanged(); };
$('#crop-tool').onclick = () => { if (!requireClip()) return; cropEnabled = !cropEnabled; editsChanged(); };
$('#zoom-tool').onclick = addZoom;
$('#add-zoom').onclick = $('#add-zoom-here').onclick = addZoom;
$('#text-tool').onclick = $('#add-text').onclick = () => { if (requireClip()) $('#text-input').focus(); };
$('#text-form').onsubmit = event => {
  event.preventDefault();
  const value = $('#text-input').value.trim();
  if (!value || !requireClip()) return;
  $('#text-input').value = '';
  addText(value);
};

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
  // clicking an empty spot also lets go of the selected text or zoom
  if (selected) { selected = null; editsChanged(); }
  updatePlayhead();
};

// ---- projects ----
const safeName = () => ($('#editor-title').textContent || 'FrameBase recording').replace(/[^a-z0-9-_ ]/gi, '').trim() || 'FrameBase recording';
$('#save-project').onclick = async () => {
  if (!requireClip()) return;
  try {
    const result = await api.project.save({ name: safeName(), mediaToken: current.token, edits: { cropEnabled, textItems, zooms } });
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
  // the canvas only draws a font once it is loaded
  await Promise.all(textItems.map(item => document.fonts.load(editTiming.fontCss(item, 40), item.text).catch(() => [])));
  const oldTime = video.currentTime, wasPaused = video.paused, oldVolume = video.volume, oldMuted = video.muted, raf = { id: 0 };
  const draw = () => {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const time = video.currentTime;
    const scale = cropEnabled ? Math.max(canvas.width / video.videoWidth, canvas.height / video.videoHeight) : Math.min(canvas.width / video.videoWidth, canvas.height / video.videoHeight);
    const w = video.videoWidth * scale, h = video.videoHeight * scale;
    const view = editTiming.zoomView(editTiming.zoomAt(zooms, time));
    ctx.setTransform(view.level, 0, 0, view.level, view.tx * canvas.width, view.ty * canvas.height);
    ctx.drawImage(video, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // drawn like the preview's .preview-text: 0.25em padding, 1.25 line height, 0.12em corners, a soft shadow
    editTiming.textsAt(textItems, time).forEach(item => {
      const fontSize = (item.size * canvas.height) / 1080;
      ctx.font = editTiming.fontCss(item, fontSize);
      ctx.textBaseline = 'top';
      const lines = String(item.text).split('\n'), lineHeight = fontSize * 1.25, pad = fontSize * 0.25;
      const maxWidth = Math.max(...lines.map(line => ctx.measureText(line).width), 1);
      const x = (item.x / 100) * canvas.width, y = (item.y / 100) * canvas.height;
      if (item.backgroundOpacity > 0) {
        ctx.fillStyle = editTiming.rgba(item.background, item.backgroundOpacity);
        ctx.beginPath();
        ctx.roundRect(x, y, maxWidth + pad * 2, lines.length * lineHeight + pad * 2, fontSize * 0.12);
        ctx.fill();
      }
      ctx.fillStyle = item.color;
      ctx.shadowColor = 'rgba(0, 0, 0, 0.8)';
      ctx.shadowBlur = fontSize * 0.2;
      lines.forEach((line, index) => ctx.fillText(line, x + pad, y + pad + index * lineHeight + (lineHeight - fontSize) / 2));
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
