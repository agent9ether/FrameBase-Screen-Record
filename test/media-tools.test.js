const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createMediaTools, toSrt, HAS_SUBTITLES } = require('../media-tools');
const { makeAgent, connectClient, resultJson } = require('./helpers');

const hasFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const needs = hasFfmpeg ? {} : { skip: 'FFmpeg is not installed' };
const hasLibass = hasFfmpeg && HAS_SUBTITLES.test(execFileSync('ffmpeg', ['-hide_banner', '-filters']).toString());

function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'framebase-media-'));
  const workspaceDir = path.join(dir, 'FrameBase Recordings');
  fs.mkdirSync(workspaceDir);
  return { dir, workspaceDir, media: createMediaTools({ workspaceDir }), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
// small synthetic clips: a test pattern with a tone, an odd-sized silent one like a window capture, and a narration
function makeClips(workspaceDir) {
  const ff = args => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { cwd: workspaceDir });
  ff(['-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30:duration=3', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:v', 'libvpx', '-c:a', 'libopus', '-shortest', 'clip.webm']);
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=501x333:rate=24:duration=2', '-c:v', 'libvpx', 'silent.webm']);
  ff(['-f', 'lavfi', '-i', 'sine=frequency=220:duration=5', 'voice.wav']);
}

test('srt formatting', () => {
  assert.equal(toSrt([{ start: 0, end: 1.5, text: 'Hello' }, { start: 61.25, end: 3725.004, text: 'Two\nlines' }]),
    '1\n00:00:00,000 --> 00:00:01,500\nHello\n\n2\n00:01:01,250 --> 01:02:05,004\nTwo\nlines\n');
});

test('inputs must live inside the workspace', async () => {
  const { dir, workspaceDir, media, cleanup } = workspace();
  try {
    fs.writeFileSync(path.join(dir, 'secret.webm'), 'x');
    fs.writeFileSync(path.join(workspaceDir, 'ok.webm'), 'x');
    await assert.rejects(media.resolveInput('../secret.webm'), /outside/);
    await assert.rejects(media.resolveInput(path.join(dir, 'secret.webm')), /outside/);
    await assert.rejects(media.resolveInput('missing.webm'), /no file/);
    await assert.rejects(media.resolveInput('ok.webm', ['audio']), /not a audio/);
    assert.equal(path.basename(await media.resolveInput('ok.webm')), 'ok.webm');
    assert.equal(path.basename(await media.resolveInput(path.join(workspaceDir, 'ok.webm'))), 'ok.webm');
    let linked = false;
    try { fs.symlinkSync(path.join(dir, 'secret.webm'), path.join(workspaceDir, 'link.webm')); linked = true; } catch { /* symlinks need extra rights on Windows */ }
    if (linked) await assert.rejects(media.resolveInput('link.webm'), /points outside/);
  } finally { cleanup(); }
});

test('outputs get fresh names and never overwrite', async () => {
  const { workspaceDir, media, cleanup } = workspace();
  try {
    fs.writeFileSync(path.join(workspaceDir, 'review.mp4'), 'keep me');
    const a = await media.reserveOutput('review', 'x', 'mp4');
    const b = await media.reserveOutput('../../evil\\name<>', 'x', 'mp4');
    assert.equal(path.basename(a), 'review-2.mp4');
    assert.equal(path.dirname(b), fs.realpathSync.native(workspaceDir));
    assert.equal(fs.readFileSync(path.join(workspaceDir, 'review.mp4'), 'utf8'), 'keep me');
  } finally { cleanup(); }
});

test('missing FFmpeg gives a clear message instead of a crash', async () => {
  const { workspaceDir, cleanup } = workspace();
  try {
    fs.writeFileSync(path.join(workspaceDir, 'a.webm'), 'x');
    const media = createMediaTools({ workspaceDir, ffmpeg: 'definitely-not-ffmpeg', ffprobe: 'definitely-not-ffprobe' });
    assert.deepEqual(await media.ffmpegInfo(), { available: false, version: null, captions: false });
    await assert.rejects(media.probe('a.webm'), /needs FFmpeg installed/);
  } finally { cleanup(); }
});

test('probe, trim, join, add audio, captions, frame and convert', needs, async () => {
  const { workspaceDir, media, cleanup } = workspace();
  try {
    makeClips(workspaceDir);
    const info = await media.probe('clip.webm');
    assert.ok(Math.abs(info.seconds - 3) < 0.2, `duration ${info.seconds}`);
    assert.equal(info.video.width, 640);
    assert.ok(info.audio);

    const trimmed = await media.trim({ input: 'clip.webm', start: 0.5, end: 2 });
    assert.ok(Math.abs((await media.probe(trimmed.name)).seconds - 1.5) < 0.2);

    const joined = await media.concat({ inputs: ['clip.webm', 'silent.webm'] });
    const joinedInfo = await media.probe(joined.name);
    assert.ok(Math.abs(joinedInfo.seconds - 5) < 0.3, `joined ${joinedInfo.seconds}`);
    assert.equal(joinedInfo.video.width, 640);
    assert.ok(joinedInfo.audio, 'silent clip gets a silent track so the join keeps audio');

    const voiced = await media.addAudio({ video: 'clip.webm', audio: 'voice.wav' });
    assert.ok(Math.abs(voiced.held_last_frame_seconds - 2) < 0.2);
    assert.ok(Math.abs((await media.probe(voiced.name)).seconds - 5) < 0.3, 'video extended to cover the narration');

    const frame = await media.extractFrame({ input: 'clip.webm', at: 99 });
    assert.ok(frame.at < 3);
    assert.ok(fs.statSync(frame.file).size > 1000);

    const converted = await media.convert({ input: 'clip.webm', format: 'mp4' });
    assert.equal(path.extname(converted.name), '.mp4');

    const listed = await media.listFiles({ kind: 'video' });
    assert.ok(listed.length >= 5 && listed.every(row => row.kind === 'video'));
  } finally { cleanup(); }
});

test('burned-in captions, or a clear error when FFmpeg has no libass', needs, async () => {
  const { workspaceDir, media, cleanup } = workspace();
  try {
    makeClips(workspaceDir);
    assert.equal((await media.ffmpegInfo()).captions, hasLibass);
    const burning = media.burnCaptions({ video: 'silent.webm', captions: [{ start: 0, end: 1, text: 'Hello, "world" \\ 100%' }] });
    if (!hasLibass) { await assert.rejects(burning, /built without libass/); return; }
    const captioned = await burning;
    assert.ok((await media.probe(captioned.name)).video);
    assert.ok(!fs.readdirSync(workspaceDir).some(name => name.startsWith('.framebase-')), 'temporary caption files are removed');
  } finally { cleanup(); }
});

test('a folder reached through an alias (symlink, junction, 8.3 name) still accepts its own files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'framebase-alias-'));
  try {
    const real = path.join(dir, 'real');
    fs.mkdirSync(path.join(real, 'FrameBase Recordings'), { recursive: true });
    fs.writeFileSync(path.join(real, 'FrameBase Recordings', 'clip.webm'), 'x');
    fs.writeFileSync(path.join(dir, 'outside.webm'), 'x');
    const alias = path.join(dir, 'alias');
    fs.symlinkSync(real, alias, 'junction');
    const media = createMediaTools({ workspaceDir: path.join(alias, 'FrameBase Recordings') });
    assert.equal(path.basename(await media.resolveInput(path.join(alias, 'FrameBase Recordings', 'clip.webm'))), 'clip.webm');
    assert.equal(path.basename(await media.resolveInput(path.join(real, 'FrameBase Recordings', 'clip.webm'))), 'clip.webm');
    await assert.rejects(media.resolveInput(path.join(alias, 'FrameBase Recordings', '..', '..', 'outside.webm')), /outside/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('voice-over uses the local speech engine', process.platform === 'win32' ? {} : { skip: 'checked on Windows only' }, async () => {
  const { media, cleanup } = workspace();
  try {
    const voices = await media.listVoices();
    assert.ok(voices.length > 0, 'Windows ships at least one voice');
    const spoken = await media.speak({ text: 'FrameBase makes product reviews. "Quotes" and $dollars; stay literal.' });
    assert.ok(spoken.bytes > 10000);
    if (hasFfmpeg) assert.ok(spoken.seconds > 1);
    await assert.rejects(media.speak({ text: 'x', voice: 'No Such Voice' }), /speech engine/);
  } finally { cleanup(); }
});

test('agents get a frame back as an image they can look at', needs, async () => {
  const { agent, recordingsDir, cleanup } = await makeAgent();
  try {
    fs.mkdirSync(recordingsDir, { recursive: true });
    makeClips(recordingsDir);
    const { url } = await agent.setEnabled(true);
    const client = await connectClient(url, await agent.revealToken());
    const result = await client.callTool({ name: 'extract_frame', arguments: { file: 'clip.webm', at_seconds: 1 } });
    assert.equal(result.content[0].type, 'image');
    assert.equal(result.content[0].mimeType, 'image/png');
    const info = resultJson(await client.callTool({ name: 'media_info', arguments: { file: 'clip.webm' } }));
    assert.equal(info.video.height, 360);
    await client.close();
  } finally { await cleanup(); }
});
