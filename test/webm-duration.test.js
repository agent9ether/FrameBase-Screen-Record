const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { fixWebmFileDuration } = require('../webm-duration');

const hasFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const durationOf = file => execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString().trim();

test('adds a duration to a live WebM like MediaRecorder writes', hasFfmpeg ? {} : { skip: 'FFmpeg is not installed' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'framebase-webm-'));
  try {
    const file = path.join(dir, 'live.webm');
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30:duration=2', '-c:v', 'libvpx', '-live', '1', '-f', 'webm', file]);
    assert.equal(durationOf(file), 'N/A', 'fixture should start without a duration');
    assert.deepEqual(await fixWebmFileDuration(file, 2000), { fixed: true });
    assert.ok(Math.abs(Number(durationOf(file)) - 2) < 0.1);
    assert.equal((await fixWebmFileDuration(file, 2000)).fixed, false, 'second run leaves it alone');
    assert.ok(!fs.existsSync(`${file}.fixing`));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('refuses an unknown duration', async () => {
  assert.deepEqual(await fixWebmFileDuration('unused.webm', 0), { fixed: false, reason: 'unknown duration' });
});
