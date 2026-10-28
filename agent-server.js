// Optional MCP server that lets an AI agent (Claude Code, Codex, ...) record and produce videos.
// Off by default. Loopback only, bearer token, window-only unless you allow screens, no microphone unless you allow it,
// files limited to the FrameBase folder, every call logged.
const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs/promises');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');
const { createMediaTools } = require('./media-tools');

const DEFAULT_PORT = 47615;
const MAX_BODY = 256 * 1024;
const MAX_AUDIT_BYTES = 5 * 1024 * 1024;

const INSTRUCTIONS = `FrameBase Studio records app windows on the user's computer and turns recordings into finished videos.
All files live in one folder (see workspace_info); tools take file names from list_files and always write new files, never overwrite.
Typical product-review workflow:
1. list_sources, then start_recording on the app window (system_audio if the app makes sound). Drive the app while recording.
2. stop_recording. Use extract_frame to look at moments and media_info for the length.
3. trim_video to cut dead time; join_videos to put an intro, sections and outro together.
4. Write a script, then generate_voiceover (local speech) or copy your own narration file into the folder.
5. add_audio with the voice-over (mode "mix" keeps app sound quietly underneath; the last frame is held if narration runs long).
6. add_captions with timed lines, then open_in_editor so the user can review it.
The user sees an AGENT badge while you record and can stop you at any time. Ask before recording anything private.`;

function createAgentServer({ safeStorage, userDataPath, recordingsDir, controller, media = createMediaTools({ workspaceDir: recordingsDir }) }) {
  const settingsFile = path.join(userDataPath, 'agent-control.json');
  const auditFile = path.join(userDataPath, 'agent-audit.log');
  let settings = { enabled: false, allowScreens: false, allowMicrophone: false, tokenEnc: '', port: DEFAULT_PORT };
  let server = null;
  let port = 0;

  async function load() {
    try { settings = { ...settings, ...JSON.parse(await fs.readFile(settingsFile, 'utf8')) }; } catch { /* first run, or an unreadable file: stay off */ }
  }
  async function save() {
    // write then rename, so a crash mid-write cannot leave a half-written settings file
    const temporary = `${settingsFile}.${process.pid}.tmp`;
    await fs.mkdir(userDataPath, { recursive: true });
    await fs.writeFile(temporary, JSON.stringify(settings));
    await fs.rename(temporary, settingsFile);
  }

  function encrypt(value) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('This computer cannot encrypt the agent token, so agent control cannot be enabled.');
    // on Linux without a keyring Electron falls back to a fixed key, which is not real protection
    if (typeof safeStorage.getSelectedStorageBackend === 'function' && safeStorage.getSelectedStorageBackend() === 'basic_text') {
      throw new Error('No system keyring was found (for example GNOME Keyring or KWallet), so the agent token cannot be stored safely.');
    }
    return safeStorage.encryptString(value).toString('base64');
  }
  function getToken() {
    if (!settings.tokenEnc) return '';
    try { return safeStorage.decryptString(Buffer.from(settings.tokenEnc, 'base64')); } catch { return ''; }
  }
  async function rotateToken() {
    settings.tokenEnc = encrypt(crypto.randomBytes(32).toString('base64url'));
    await save();
  }
  const sameToken = (a, b) => {
    const ha = crypto.createHash('sha256').update(a).digest(), hb = crypto.createHash('sha256').update(b).digest();
    return crypto.timingSafeEqual(ha, hb);
  };

  async function audit(entry) {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry, detail: entry.detail ? String(entry.detail).slice(0, 300) : undefined });
    try {
      const stat = await fs.stat(auditFile).catch(() => null);
      if (stat && stat.size > MAX_AUDIT_BYTES) await fs.rename(auditFile, `${auditFile}.1`);
      await fs.appendFile(auditFile, line + '\n');
    } catch { /* logging must never break a recording */ }
  }

  const text = value => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });
  const failure = message => ({ isError: true, content: [{ type: 'text', text: message }] });
  function tool(mcp, name, description, shape, handler) {
    mcp.registerTool(name, { description, inputSchema: shape }, async args => {
      try {
        const result = await handler(args || {});
        await audit({ tool: name, args, ok: true });
        return result && result.content ? result : text(result);
      } catch (error) {
        await audit({ tool: name, args, ok: false, detail: error.message });
        return failure(error.message || String(error));
      }
    });
  }

  const fileName = z.string().min(1).max(260).describe('A file name from list_files (or its full path inside the FrameBase folder)');
  const outputName = z.string().max(80).optional().describe('Optional name for the new file; a number is added if it exists');
  const seconds = z.number().min(0).max(24 * 3600);

  function buildMcp() {
    const mcp = new McpServer({ name: 'framebase-studio', version: '0.2.0' }, { instructions: INSTRUCTIONS });

    // ---- recording ----
    tool(mcp, 'list_sources', 'List app windows (and screens, if the user allowed them) that can be recorded.',
      { kind: z.enum(['window', 'screen', 'all']).optional() },
      async ({ kind = 'window' }) => {
        const all = await controller.listSources();
        const allowed = all.filter(s => s.type === 'window' || settings.allowScreens);
        return { screens_allowed: settings.allowScreens, sources: allowed.filter(s => kind === 'all' || s.type === kind) };
      });
    tool(mcp, 'start_recording',
      'Start recording an app window. Pass source_id from list_sources, or window_title to match a window by name. A floating "AGENT" control bar stays visible and the user can stop at any time.',
      {
        source_id: z.string().max(200).optional(),
        window_title: z.string().max(200).optional().describe('Case-insensitive part of the window title'),
        system_audio: z.boolean().optional().describe('Record sound the computer plays (Windows only)'),
        microphone: z.boolean().optional().describe('Record the microphone; only works if the user allowed it'),
        max_seconds: z.number().int().min(1).max(3600).optional().describe('Auto-stop after this much recorded time (default 600; pauses do not count)')
      },
      async ({ source_id, window_title, system_audio = false, microphone = false, max_seconds = 600 }) => {
        if (microphone && !settings.allowMicrophone) throw new Error('Microphone recording by agents is off. The user can allow it in FrameBase > Agent control.');
        const sources = await controller.listSources();
        let source = source_id ? sources.find(s => s.id === source_id) : null;
        if (!source && window_title) source = sources.find(s => s.type === 'window' && s.name.toLowerCase().includes(window_title.toLowerCase()));
        if (!source) throw new Error('No matching source. Call list_sources and pass its id, or a window_title that matches.');
        if (source.type === 'screen' && !settings.allowScreens) throw new Error('Recording whole screens is off. The user can allow it in FrameBase > Agent control.');
        await controller.start({ sourceId: source.id, systemAudio: system_audio, microphone, maxSeconds: max_seconds });
        return { recording: true, source: source.name, max_seconds };
      });
    tool(mcp, 'pause_recording', 'Pause a recording you started.', {}, () => controller.setPaused(true));
    tool(mcp, 'resume_recording', 'Resume a recording you paused.', {}, () => controller.setPaused(false));
    tool(mcp, 'stop_recording', 'Stop the recording you started and save it to the FrameBase folder. Returns the file.', {}, () => controller.stop());
    tool(mcp, 'recording_status', 'Whether a recording is running, its length so far and the last saved file.', {}, async () => controller.status());

    // ---- files ----
    tool(mcp, 'workspace_info', 'Where files are kept, whether FFmpeg (needed for editing) is installed, and what the user allows.', {}, async () => ({
      folder: recordingsDir,
      ffmpeg: await media.ffmpegInfo(),
      screens_allowed: settings.allowScreens,
      microphone_allowed: settings.allowMicrophone
    }));
    tool(mcp, 'list_files', 'List videos, audio, images and caption files in the FrameBase folder, newest first.',
      { kind: z.enum(['video', 'audio', 'image', 'captions', 'all']).optional(), limit: z.number().int().min(1).max(200).optional() },
      async ({ kind = 'all', limit = 50 }) => media.listFiles({ kind, limit }));
    tool(mcp, 'list_recordings', 'List recent videos in the FrameBase folder.', { limit: z.number().int().min(1).max(50).optional() },
      async ({ limit = 10 }) => media.listFiles({ kind: 'video', limit }));
    tool(mcp, 'media_info', 'Length, size, resolution and audio of a file.', { file: fileName }, ({ file }) => media.probe(file));
    tool(mcp, 'extract_frame', 'Save a still frame as PNG and return it as an image so you can see the recording.',
      { file: fileName, at_seconds: seconds.optional(), width: z.number().int().min(160).max(3840).optional() },
      async ({ file, at_seconds = 0, width = 1280 }) => {
        const frame = await media.extractFrame({ input: file, at: at_seconds, width });
        const data = (await fs.readFile(frame.file)).toString('base64');
        return { content: [{ type: 'image', data, mimeType: 'image/png' }, { type: 'text', text: JSON.stringify(frame, null, 2) }] };
      });
    tool(mcp, 'open_in_editor', 'Open a video in the FrameBase editor so the user can watch and adjust it.', { file: fileName },
      async ({ file }) => controller.openInEditor(await media.resolveInput(file, ['video'])));

    // ---- editing (all write a new MP4) ----
    tool(mcp, 'trim_video', 'Keep only part of a video. Writes a new MP4.',
      { file: fileName, start_seconds: seconds.optional(), end_seconds: seconds.optional(), output_name: outputName },
      ({ file, start_seconds = 0, end_seconds, output_name }) => media.trim({ input: file, start: start_seconds, end: end_seconds, output_name }));
    tool(mcp, 'join_videos', 'Join clips end to end in the given order. Clips are fitted to the first clip\'s frame size. Writes a new MP4.',
      { files: z.array(fileName).min(2).max(50), output_name: outputName },
      ({ files, output_name }) => media.concat({ inputs: files, output_name }));
    tool(mcp, 'add_audio', 'Put a voice-over or music track onto a video. "mix" keeps the original sound underneath at original_volume; "replace" drops it. If the audio runs past the end, the last frame is held. Writes a new MP4.',
      {
        video: fileName, audio: fileName,
        mode: z.enum(['mix', 'replace']).optional(),
        start_at_seconds: seconds.optional(),
        audio_volume: z.number().min(0).max(4).optional(),
        original_volume: z.number().min(0).max(4).optional().describe('Volume of the video\'s own sound in mix mode (default 0.3)'),
        extend_video: z.boolean().optional().describe('Hold the last frame if the audio is longer (default true)'),
        output_name: outputName
      },
      ({ video, audio, mode, start_at_seconds, audio_volume, original_volume, extend_video, output_name }) =>
        media.addAudio({ video, audio, mode, start_at: start_at_seconds, audio_volume, original_volume, extend_video, output_name }));
    tool(mcp, 'add_captions', 'Burn captions or on-screen text into a video. Pass timed lines, or an .srt file from the folder. Writes a new MP4.',
      {
        video: fileName,
        captions: z.array(z.object({ start: seconds, end: seconds, text: z.string().min(1).max(500) })).max(2000).optional(),
        srt_file: fileName.optional(),
        font_size: z.number().min(8).max(96).optional(),
        output_name: outputName
      },
      ({ video, captions, srt_file, font_size, output_name }) => media.burnCaptions({ video, captions, srt_file, font_size, output_name }));
    tool(mcp, 'convert_video', 'Convert a video to MP4 (widely compatible) or WebM. Writes a new file.',
      { file: fileName, format: z.enum(['mp4', 'webm']).optional(), output_name: outputName },
      ({ file, format = 'mp4', output_name }) => media.convert({ input: file, format, output_name }));
    tool(mcp, 'convert_to_mp4', 'Convert a recording to MP4. Same as convert_video with format "mp4".', { file: fileName },
      ({ file }) => media.convert({ input: file, format: 'mp4' }));

    // ---- voice ----
    tool(mcp, 'list_voices', 'Speech voices installed on this computer, for generate_voiceover.', {}, async () => ({ voices: await media.listVoices() }));
    tool(mcp, 'generate_voiceover', 'Turn a script into a WAV voice-over using this computer\'s own speech engine (works offline). For a more natural voice, make the audio with another tool and copy it into the folder.',
      { text: z.string().min(1).max(20000), voice: z.string().max(200).optional(), rate: z.number().min(-10).max(10).optional().describe('-10 slow to 10 fast, 0 normal'), output_name: outputName },
      ({ text: script, voice, rate, output_name }) => media.speak({ text: script, voice, rate, output_name }));

    mcp.registerPrompt('product_review', {
      title: 'Record a software product review',
      description: 'Plan, record and produce a narrated review of an app on this computer.',
      argsSchema: { app: z.string().describe('The app or window to review'), length: z.string().optional().describe('Target length, e.g. "2 minutes"') }
    }, ({ app, length }) => ({
      messages: [{ role: 'user', content: { type: 'text', text: `Make a ${length || 'two-minute'} narrated product review of ${app} with FrameBase.
1. Call workspace_info and list_sources. Find the ${app} window; ask me before recording anything that looks private.
2. Outline 3-5 sections (intro, key features, verdict). Record each section as its own clip with start_recording/stop_recording while you demonstrate it.
3. Check each clip with extract_frame and trim_video away dead time.
4. Write a script per section, generate_voiceover for each, and add_audio onto the matching clip.
5. join_videos in order, add_captions with the key lines, then open_in_editor and tell me the file name.` } }]
    }));
    return mcp;
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0; const parts = [];
      req.on('data', chunk => { size += chunk.length; if (size > MAX_BODY) { reject(new Error('Request too large')); req.destroy(); } else parts.push(chunk); });
      req.on('end', () => { try { resolve(parts.length ? JSON.parse(Buffer.concat(parts).toString('utf8')) : undefined); } catch (error) { reject(error); } });
      req.on('error', reject);
    });
  }

  async function onRequest(req, res) {
    const reply = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    const refuse = async (code, reason) => { await audit({ event: 'refused', reason, ok: false }); reply(code, { error: reason }); };
    const host = req.headers.host || '';
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return refuse(403, 'Bad host');
    if (req.headers.origin) return refuse(403, 'Browser requests are not allowed');
    const token = getToken();
    const given = /^Bearer (.+)$/i.exec(req.headers.authorization || '');
    if (!token || !given || !sameToken(given[1], token)) return refuse(401, 'Missing or wrong token');
    if (new URL(req.url, 'http://127.0.0.1').pathname !== '/mcp') return reply(404, { error: 'Not found' });
    if (req.method !== 'POST') return reply(405, { error: 'Use POST' });
    try {
      const body = await readBody(req);
      const mcp = buildMcp();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => { transport.close(); mcp.close(); });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      if (!res.headersSent) reply(400, { error: error.message });
    }
  }

  function listen(wanted) {
    return new Promise((resolve, reject) => {
      const candidate = http.createServer((req, res) => { onRequest(req, res); });
      candidate.once('error', reject);
      candidate.listen(wanted, '127.0.0.1', () => { candidate.off('error', reject); resolve(candidate); });
    });
  }

  async function startListening() {
    if (server) return;
    // reuse the last port so the command the user gave their agent keeps working after a restart
    try { server = await listen(settings.port || DEFAULT_PORT); } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
      server = await listen(0);
    }
    port = server.address().port;
    if (settings.port !== port) { settings.port = port; await save(); }
  }
  async function stopListening() {
    if (!server) return;
    const closing = server; server = null; port = 0;
    await new Promise(resolve => { closing.close(resolve); closing.closeAllConnections?.(); });
  }

  return {
    async init() { await load(); if (settings.enabled && getToken()) await startListening(); },
    async info() {
      return {
        enabled: settings.enabled && Boolean(server), allowScreens: settings.allowScreens, allowMicrophone: settings.allowMicrophone,
        url: server ? `http://127.0.0.1:${port}/mcp` : '', hasToken: Boolean(getToken()), recordingsDir, auditFile,
        ffmpeg: await media.ffmpegInfo()
      };
    },
    async setEnabled(enabled) {
      if (enabled) { if (!getToken()) await rotateToken(); settings.enabled = true; await save(); await startListening(); }
      else { settings.enabled = false; await save(); await stopListening(); await controller.stopIfAgent(); }
      return this.info();
    },
    async setAllowScreens(value) { settings.allowScreens = value === true; await save(); return this.info(); },
    async setAllowMicrophone(value) { settings.allowMicrophone = value === true; await save(); return this.info(); },
    async rotateToken() { await rotateToken(); },
    async revealToken() { return getToken(); },
    allowsMicrophone: () => settings.allowMicrophone,
    stop: stopListening
  };
}

module.exports = { createAgentServer, INSTRUCTIONS };
