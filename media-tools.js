// Video production helpers built on FFmpeg and the operating system's speech engine.
// Every input must already be inside the workspace folder and every output is written there under a new name,
// so nothing that calls these (the editor or an agent) can read or overwrite files elsewhere.
const path = require('node:path');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const ENCODE_TIMEOUT = 60 * 60 * 1000;
const MEDIA_EXTENSIONS = { video: ['webm', 'mp4', 'mov', 'mkv'], audio: ['wav', 'mp3', 'm4a', 'aac', 'ogg', 'opus', 'flac'], image: ['png', 'jpg', 'jpeg'], captions: ['srt'] };
// H.264 needs even dimensions; window captures are often odd-sized
const EVEN = 'scale=trunc(iw/2)*2:trunc(ih/2)*2';
const MP4_OUT = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart'];
const WEBM_OUT = ['-c:v', 'libvpx-vp9', '-crf', '32', '-b:v', '0', '-row-mt', '1', '-c:a', 'libopus', '-b:a', '160k'];

function kindOf(file) {
  const ext = path.extname(file).slice(1).toLowerCase();
  return Object.keys(MEDIA_EXTENSIONS).find(kind => MEDIA_EXTENSIONS[kind].includes(ext)) || null;
}

function srtTime(seconds) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
}

function toSrt(captions) {
  return captions.map((cue, index) => {
    const textValue = String(cue.text).replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trim();
    return `${index + 1}\n${srtTime(cue.start)} --> ${srtTime(cue.end)}\n${textValue}\n`;
  }).join('\n');
}

function createMediaTools({ workspaceDir, ffmpeg = 'ffmpeg', ffprobe = 'ffprobe', platform = process.platform, run = execFileAsync }) {
  let ffmpegCheck = null;

  const isInside = (root, candidate) => {
    const rel = path.relative(root, candidate);
    return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
  };

  async function ensureWorkspace() {
    await fs.mkdir(workspaceDir, { recursive: true });
    return fs.realpath(workspaceDir);
  }

  // Accepts a bare file name or a full path, but only for a file that really lives in the workspace (symlinks included).
  async function resolveInput(name, kinds) {
    if (typeof name !== 'string' || !name.trim()) throw new Error('A file name is required.');
    const root = await ensureWorkspace();
    const candidate = path.resolve(root, name);
    if (!isInside(root, candidate)) throw new Error(`"${name}" is outside the FrameBase folder. Copy it into ${workspaceDir} first.`);
    let real;
    try { real = await fs.realpath(candidate); } catch { throw new Error(`There is no file called "${name}" in the FrameBase folder.`); }
    if (!isInside(root, real)) throw new Error(`"${name}" points outside the FrameBase folder.`);
    if (!(await fs.stat(real)).isFile()) throw new Error(`"${name}" is not a file.`);
    if (kinds && !kinds.includes(kindOf(real))) throw new Error(`"${name}" is not a ${kinds.join(' or ')} file.`);
    return real;
  }

  // Reserves a new, unused file name in the workspace so results never overwrite anything.
  async function reserveOutput(requested, fallbackStem, extension) {
    const root = await ensureWorkspace();
    const stem = (path.parse(String(requested || '')).name || fallbackStem).replace(/[^\w .-]+/g, '').replace(/^[.\s]+/, '').trim().slice(0, 80) || 'FrameBase';
    for (let n = 1; n < 1000; n += 1) {
      const file = path.join(root, `${n === 1 ? stem : `${stem}-${n}`}.${extension}`);
      try { await (await fs.open(file, 'wx')).close(); return file; } catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    throw new Error('Could not find a free file name.');
  }

  async function ffmpegInfo() {
    if (!ffmpegCheck) {
      ffmpegCheck = run(ffmpeg, ['-hide_banner', '-version'], { windowsHide: true })
        .then(({ stdout }) => ({ available: true, version: (/ffmpeg version n?(\d[\w.]*?)(?:[-_\s]|$)/.exec(stdout) || [])[1] || 'unknown' }))
        .catch(() => ({ available: false, version: null }));
    }
    const info = await ffmpegCheck;
    if (!info.available) ffmpegCheck = null; // let the user install it without restarting
    return info;
  }

  async function needFfmpeg() {
    if (!(await ffmpegInfo()).available) throw new Error('This needs FFmpeg installed and on PATH (for example: winget install Gyan.FFmpeg, brew install ffmpeg, or apt install ffmpeg). Restart FrameBase after installing.');
  }

  async function encode(args, output) {
    await needFfmpeg();
    try {
      await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args, output], { windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: ENCODE_TIMEOUT, cwd: path.dirname(output) });
    } catch (error) {
      await fs.rm(output, { force: true });
      throw new Error(`FFmpeg failed: ${String(error.stderr || error.message).trim().split('\n').slice(-4).join(' ')}`);
    }
    const stat = await fs.stat(output);
    return { file: output, name: path.basename(output), bytes: stat.size };
  }

  async function probe(name) {
    const file = await resolveInput(name, ['video', 'audio', 'image']);
    await needFfmpeg();
    let data;
    try {
      const { stdout } = await run(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
      data = JSON.parse(stdout);
    } catch (error) {
      throw new Error(`Could not read "${name}": ${String(error.stderr || error.message).trim()}`);
    }
    const video = data.streams.find(s => s.codec_type === 'video');
    const audio = data.streams.find(s => s.codec_type === 'audio');
    let duration = Number(data.format.duration);
    if (!Number.isFinite(duration) && kindOf(file) !== 'image') duration = await measureDuration(file);
    const fps = video && video.avg_frame_rate && video.avg_frame_rate !== '0/0' ? (([a, b]) => Math.round((a / b) * 100) / 100)(video.avg_frame_rate.split('/').map(Number)) : null;
    return {
      file, name: path.basename(file), bytes: Number(data.format.size) || (await fs.stat(file)).size,
      seconds: Number.isFinite(duration) ? Math.round(duration * 1000) / 1000 : null,
      video: video ? { codec: video.codec_name, width: video.width, height: video.height, fps } : null,
      audio: audio ? { codec: audio.codec_name, channels: audio.channels, sample_rate: Number(audio.sample_rate) } : null
    };
  }

  // Raw MediaRecorder files can lack a duration header; decode once to find it.
  async function measureDuration(file) {
    try {
      const { stderr } = await run(ffmpeg, ['-hide_banner', '-i', file, '-map', '0', '-c', 'copy', '-f', 'null', '-'], { windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: ENCODE_TIMEOUT });
      const times = [...String(stderr).matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)];
      if (!times.length) return NaN;
      const [, h, m, s] = times.at(-1);
      return Number(h) * 3600 + Number(m) * 60 + Number(s);
    } catch { return NaN; }
  }

  async function requireDuration(name) {
    const info = await probe(name);
    if (!info.seconds) throw new Error(`Could not work out how long "${name}" is.`);
    return info;
  }

  async function trim({ input, start = 0, end, output_name }) {
    const info = await requireDuration(input);
    const to = end === undefined ? info.seconds : Math.min(end, info.seconds);
    if (!(start >= 0) || !(to > start)) throw new Error(`Pick a range inside the clip (0 to ${info.seconds}s) with end after start.`);
    const output = await reserveOutput(output_name, `${path.parse(info.name).name}-trim`, 'mp4');
    const result = await encode(['-ss', String(start), '-to', String(to), '-i', info.file, '-map', '0:v:0', '-map', '0:a?', '-vf', EVEN, ...MP4_OUT], output);
    return { ...result, seconds: Math.round((to - start) * 1000) / 1000 };
  }

  async function concat({ inputs, output_name }) {
    if (!Array.isArray(inputs) || inputs.length < 2) throw new Error('Give at least two clips to join, in order.');
    const clips = [];
    for (const input of inputs) {
      const info = await requireDuration(input);
      if (!info.video) throw new Error(`"${input}" has no video.`);
      clips.push(info);
    }
    // conform every clip to the first one's frame so different window sizes can be joined
    const width = clips[0].video.width - (clips[0].video.width % 2), height = clips[0].video.height - (clips[0].video.height % 2);
    const chains = clips.map((clip, i) => {
      const v = `[${i}:v:0]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p[v${i}]`;
      const a = clip.audio ? `[${i}:a:0]aresample=48000,aformat=channel_layouts=stereo[a${i}]` : `anullsrc=r=48000:cl=stereo,atrim=duration=${clip.seconds}[a${i}]`;
      return `${v};${a}`;
    });
    const filter = `${chains.join(';')};${clips.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=${clips.length}:v=1:a=1[v][a]`;
    const output = await reserveOutput(output_name, `${path.parse(clips[0].name).name}-joined`, 'mp4');
    const result = await encode([...clips.flatMap(c => ['-i', c.file]), '-filter_complex', filter, '-map', '[v]', '-map', '[a]', ...MP4_OUT], output);
    return { ...result, seconds: Math.round(clips.reduce((sum, c) => sum + c.seconds, 0) * 1000) / 1000 };
  }

  // Lay a voice-over (or music) onto a video. If the audio runs past the end, the last frame is held so nothing is cut off.
  async function addAudio({ video, audio, mode = 'mix', start_at = 0, audio_volume = 1, original_volume = 0.3, extend_video = true, output_name }) {
    const clip = await requireDuration(video);
    if (!clip.video) throw new Error(`"${video}" has no video.`);
    const voice = await requireDuration(audio);
    if (!voice.audio) throw new Error(`"${audio}" has no audio.`);
    const audioEnd = start_at + voice.seconds;
    const hold = extend_video && audioEnd > clip.seconds ? audioEnd - clip.seconds : 0;
    const delayMs = Math.round(start_at * 1000);
    const parts = [`[0:v:0]${EVEN}${hold ? `,tpad=stop_mode=clone:stop_duration=${hold.toFixed(3)}` : ''}[v]`];
    parts.push(`[1:a:0]aresample=48000,aformat=channel_layouts=stereo,volume=${audio_volume}${delayMs ? `,adelay=${delayMs}:all=1` : ''}[voice]`);
    if (mode === 'mix' && clip.audio) {
      parts.push(`[0:a:0]aresample=48000,aformat=channel_layouts=stereo,volume=${original_volume}${hold ? `,apad=pad_dur=${hold.toFixed(3)}` : ''}[orig]`);
      parts.push('[orig][voice]amix=inputs=2:duration=longest:normalize=0[a]');
    } else {
      parts.push('[voice]anull[a]');
    }
    const total = clip.seconds + hold;
    const output = await reserveOutput(output_name, `${path.parse(clip.name).name}-voiceover`, 'mp4');
    const result = await encode(['-i', clip.file, '-i', voice.file, '-filter_complex', parts.join(';'), '-map', '[v]', '-map', '[a]', '-t', total.toFixed(3), ...MP4_OUT], output);
    return { ...result, seconds: Math.round(total * 1000) / 1000, held_last_frame_seconds: Math.round(hold * 1000) / 1000 };
  }

  async function burnCaptions({ video, captions, srt_file, font_size = 22, output_name }) {
    const clip = await requireDuration(video);
    if (!clip.video) throw new Error(`"${video}" has no video.`);
    let srtText;
    if (srt_file) srtText = await fs.readFile(await resolveInput(srt_file, ['captions']), 'utf8');
    else if (Array.isArray(captions) && captions.length) {
      for (const cue of captions) if (!(cue.end > cue.start) || cue.start < 0) throw new Error('Every caption needs start >= 0 and end after start (seconds).');
      srtText = toSrt(captions);
    } else throw new Error('Pass captions (a list of {start, end, text}) or srt_file.');
    const root = await ensureWorkspace();
    // a name we control, used relative to the working folder, avoids FFmpeg filter escaping of Windows paths
    const temporary = `.framebase-captions-${crypto.randomBytes(6).toString('hex')}.srt`;
    await fs.writeFile(path.join(root, temporary), srtText, 'utf8');
    const output = await reserveOutput(output_name, `${path.parse(clip.name).name}-captions`, 'mp4');
    try {
      const style = `FontName=Arial,FontSize=${Math.round(font_size)},PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2,Shadow=0,MarginV=28`;
      return await encode(['-i', clip.file, '-map', '0:v:0', '-map', '0:a?', '-vf', `${EVEN},subtitles=${temporary}:force_style='${style}'`, ...MP4_OUT], output);
    } finally { await fs.rm(path.join(root, temporary), { force: true }); }
  }

  async function extractFrame({ input, at = 0, width = 1280 }) {
    const clip = await requireDuration(input);
    if (!clip.video) throw new Error(`"${input}" has no video.`);
    const time = Math.min(Math.max(0, at), Math.max(0, clip.seconds - 0.05));
    const output = await reserveOutput(null, `${path.parse(clip.name).name}-frame-${time.toFixed(1).replace('.', '_')}s`, 'png');
    const result = await encode(['-ss', String(time), '-i', clip.file, '-frames:v', '1', '-vf', `scale='min(${Math.round(width)},iw)':-2`], output);
    return { ...result, at: time };
  }

  async function convert({ input, format = 'mp4', output_name }) {
    const clip = await probe(input);
    if (!clip.video) throw new Error(`"${input}" has no video.`);
    const output = await reserveOutput(output_name, path.parse(clip.name).name, format);
    return encode(['-i', clip.file, '-map', '0:v:0', '-map', '0:a?', '-vf', EVEN, ...(format === 'mp4' ? MP4_OUT : WEBM_OUT)], output);
  }

  // ---- speech (local, no network) ----
  const POWERSHELL_VOICES = 'Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo.Name + "|" + $_.VoiceInfo.Culture.Name + "|" + $_.VoiceInfo.Gender }; $s.Dispose()';
  // Stop: otherwise a bad voice name is ignored and the default voice is used without telling anyone
  const POWERSHELL_SPEAK = '$ErrorActionPreference = "Stop"; Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; if ($env:FB_VOICE) { $s.SelectVoice($env:FB_VOICE) }; $s.Rate = [int]$env:FB_RATE; $s.SetOutputToWaveFile($env:FB_OUT); $s.Speak($env:FB_TEXT); $s.Dispose()';

  async function listVoices() {
    try {
      if (platform === 'win32') {
        const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', POWERSHELL_VOICES], { windowsHide: true });
        return stdout.split(/\r?\n/).filter(Boolean).map(line => { const [name, language, gender] = line.split('|'); return { name, language, gender }; });
      }
      if (platform === 'darwin') {
        const { stdout } = await run('say', ['-v', '?']);
        return stdout.split('\n').filter(Boolean).map(line => { const match = /^(.+?)\s{2,}(\S+)/.exec(line); return match ? { name: match[1].trim(), language: match[2] } : null; }).filter(Boolean);
      }
      const { stdout } = await run('espeak-ng', ['--voices']);
      return stdout.split('\n').slice(1).filter(Boolean).map(line => { const cols = line.trim().split(/\s+/); return { name: cols[3], language: cols[1] }; });
    } catch {
      return [];
    }
  }

  async function speak({ text: script, voice, rate = 0, output_name }) {
    const spoken = String(script || '').trim();
    if (!spoken) throw new Error('Give the text to speak.');
    if (spoken.length > 20000) throw new Error('Keep each voice-over under 20,000 characters; split longer scripts and join the clips.');
    const output = await reserveOutput(output_name, 'voiceover', 'wav');
    try {
      if (platform === 'win32') {
        // text and voice go through the environment, never into the command line
        await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', POWERSHELL_SPEAK], { windowsHide: true, timeout: ENCODE_TIMEOUT, env: { ...process.env, FB_TEXT: spoken, FB_VOICE: voice || '', FB_RATE: String(Math.round(rate)), FB_OUT: output } });
      } else if (platform === 'darwin') {
        await runWithInput('say', [...(voice ? ['-v', voice] : []), '-r', String(Math.round(175 + rate * 15)), '--file-format=WAVE', '--data-format=LEI16@44100', '-o', output, '-f', '-'], spoken);
      } else {
        await runWithInput('espeak-ng', [...(voice ? ['-v', voice] : []), '-s', String(Math.round(175 + rate * 15)), '-w', output, '--stdin'], spoken);
      }
    } catch (error) {
      await fs.rm(output, { force: true });
      const missing = error.code === 'ENOENT' ? (platform === 'linux' ? ' Install espeak-ng to use local voice-overs.' : '') : '';
      throw new Error(`The speech engine could not create the voice-over: ${String(error.stderr || error.message).trim().split('\n').pop()}${missing}`);
    }
    const stat = await fs.stat(output);
    if (stat.size < 100) { await fs.rm(output, { force: true }); throw new Error('The speech engine produced no audio. Check the voice name with list_voices.'); }
    let seconds = null;
    if ((await ffmpegInfo()).available) seconds = (await probe(output)).seconds;
    return { file: output, name: path.basename(output), bytes: stat.size, seconds };
  }

  function runWithInput(command, args, input) {
    return new Promise((resolve, reject) => {
      const child = execFile(command, args, { timeout: ENCODE_TIMEOUT }, (error, stdout, stderr) => (error ? reject(Object.assign(error, { stderr })) : resolve({ stdout, stderr })));
      child.stdin.end(input);
    });
  }

  async function listFiles({ kind = 'all', limit = 50 } = {}) {
    const root = await ensureWorkspace();
    const names = (await fs.readdir(root)).filter(name => !name.startsWith('.') && kindOf(name) && (kind === 'all' || kindOf(name) === kind));
    const rows = await Promise.all(names.map(async name => {
      const stat = await fs.stat(path.join(root, name)).catch(() => null);
      return stat && stat.isFile() && stat.size > 0 ? { name, file: path.join(root, name), kind: kindOf(name), bytes: stat.size, modified: stat.mtime.toISOString() } : null;
    }));
    return rows.filter(Boolean).sort((a, b) => b.modified.localeCompare(a.modified)).slice(0, limit);
  }

  return { workspaceDir, resolveInput, reserveOutput, ffmpegInfo, probe, trim, concat, addAudio, burnCaptions, extractFrame, convert, listVoices, speak, listFiles, kindOf };
}

module.exports = { createMediaTools, toSrt, srtTime, MEDIA_EXTENSIONS, MP4_OUT, WEBM_OUT, EVEN };
