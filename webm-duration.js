// MediaRecorder writes WebM without a duration, so players cannot seek it. Patch the header in place.
const fs = require('node:fs/promises');
const { WebmFile } = require('@fix-webm-duration/parser');
const { fixParsedWebmDuration } = require('@fix-webm-duration/fix');

// The parser holds the whole file in memory; above this, callers should remux with FFmpeg instead.
const MAX_IN_MEMORY = 1024 * 1024 * 1024;

async function fixWebmFileDuration(file, durationMs) {
  if (!(durationMs > 0)) return { fixed: false, reason: 'unknown duration' };
  const { size } = await fs.stat(file);
  if (size > MAX_IN_MEMORY) return { fixed: false, reason: 'too large' };
  const webm = new WebmFile(new Uint8Array(await fs.readFile(file)));
  if (!fixParsedWebmDuration(webm, durationMs, { logger: false })) return { fixed: false, reason: 'already has a duration or is not a WebM' };
  const temporary = `${file}.fixing`;
  await fs.writeFile(temporary, webm.source);
  await fs.rename(temporary, file);
  return { fixed: true };
}

module.exports = { fixWebmFileDuration, MAX_IN_MEMORY };
