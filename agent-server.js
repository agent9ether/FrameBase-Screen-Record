// Optional MCP server that lets an AI agent (Claude Code, Codex, ...) drive recordings.
// Off by default. Loopback only, bearer token, window-only unless you allow screens, every call logged.
const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs/promises');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');

const execFileAsync = promisify(execFile);
const DEFAULT_PORT = 47615;
const MAX_BODY = 64 * 1024;

function createAgentServer({ safeStorage, userDataPath, recordingsDir, controller }) {
  const settingsFile = path.join(userDataPath, 'agent-control.json');
  const auditFile = path.join(userDataPath, 'agent-audit.log');
  let settings = { enabled: false, allowScreens: false, tokenEnc: '' };
  let server = null;
  let port = 0;

  async function load() {
    try { settings = { ...settings, ...JSON.parse(await fs.readFile(settingsFile, 'utf8')) }; } catch { /* first run */ }
  }
  const save = () => fs.writeFile(settingsFile, JSON.stringify(settings));

  function encrypt(text) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('This computer cannot encrypt the agent token, so agent control cannot be enabled.');
    return safeStorage.encryptString(text).toString('base64');
  }
  function getToken() {
    if (!settings.tokenEnc) return '';
    try { return safeStorage.decryptString(Buffer.from(settings.tokenEnc, 'base64')); } catch { return ''; }
  }
  async function rotateToken() {
    settings.tokenEnc = encrypt(crypto.randomBytes(24).toString('base64url'));
    await save();
    return getToken();
  }
  const sameToken = (a, b) => {
    const ha = crypto.createHash('sha256').update(a).digest(), hb = crypto.createHash('sha256').update(b).digest();
    return crypto.timingSafeEqual(ha, hb);
  };

  async function audit(tool, args, ok, detail) {
    const line = JSON.stringify({ ts: new Date().toISOString(), tool, args, ok, detail: detail ? String(detail).slice(0, 300) : undefined });
    try { await fs.appendFile(auditFile, line + '\n'); } catch { /* logging must never break a recording */ }
  }

  const text = value => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });
  const failure = message => ({ isError: true, content: [{ type: 'text', text: message }] });
  function tool(server, name, description, shape, handler) {
    server.registerTool(name, { description, inputSchema: shape }, async args => {
      try {
        const result = await handler(args || {});
        await audit(name, args, true);
        return text(result);
      } catch (error) {
        await audit(name, args, false, error.message);
        return failure(error.message || String(error));
      }
    });
  }

  function buildMcp() {
    const mcp = new McpServer({ name: 'framebase-studio', version: '0.1.0' });
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
        source_id: z.string().optional(),
        window_title: z.string().optional().describe('Case-insensitive part of the window title'),
        system_audio: z.boolean().optional(),
        microphone: z.boolean().optional(),
        max_seconds: z.number().int().min(1).max(3600).optional().describe('Auto-stop after this long (default 600)')
      },
      async ({ source_id, window_title, system_audio = false, microphone = false, max_seconds = 600 }) => {
        const sources = await controller.listSources();
        let source = source_id ? sources.find(s => s.id === source_id) : null;
        if (!source && window_title) source = sources.find(s => s.type === 'window' && s.name.toLowerCase().includes(window_title.toLowerCase()));
        if (!source) throw new Error('No matching source. Call list_sources and pass its id, or a window_title that matches.');
        if (source.type === 'screen' && !settings.allowScreens) throw new Error('Recording whole screens is off. The user can allow it in FrameBase > Agent control.');
        await controller.start({ sourceId: source.id, systemAudio: system_audio, microphone, maxSeconds: max_seconds });
        return { recording: true, source: source.name, max_seconds };
      });
    tool(mcp, 'pause_recording', 'Pause the current recording.', {}, () => controller.setPaused(true));
    tool(mcp, 'resume_recording', 'Resume a paused recording.', {}, () => controller.setPaused(false));
    tool(mcp, 'stop_recording', 'Stop the recording and save it to the FrameBase Recordings folder. Returns the file path.', {}, () => controller.stop());
    tool(mcp, 'recording_status', 'Whether a recording is running, its length so far and the last saved file.', {}, async () => controller.status());
    tool(mcp, 'list_recordings', 'List recent files in the FrameBase Recordings folder.', { limit: z.number().int().min(1).max(50).optional() }, async ({ limit = 10 }) => {
      await fs.mkdir(recordingsDir, { recursive: true });
      const names = (await fs.readdir(recordingsDir)).filter(n => /\.(webm|mp4)$/i.test(n));
      const rows = await Promise.all(names.map(async name => { const stat = await fs.stat(path.join(recordingsDir, name)); return { file: path.join(recordingsDir, name), bytes: stat.size, modified: stat.mtime.toISOString() }; }));
      return rows.sort((a, b) => b.modified.localeCompare(a.modified)).slice(0, limit);
    });
    tool(mcp, 'convert_to_mp4', 'Convert a recording in the FrameBase Recordings folder to MP4 (needs FFmpeg on PATH).', { file: z.string() }, async ({ file }) => {
      const resolved = path.resolve(file);
      if (path.dirname(resolved) !== path.resolve(recordingsDir)) throw new Error('Only files inside the FrameBase Recordings folder can be converted.');
      const out = resolved.replace(/\.[^.]+$/, '') + '.mp4';
      try {
        await execFileAsync('ffmpeg', ['-y', '-i', resolved, '-map', '0:v:0', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', out], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
      } catch (error) {
        throw new Error(error.code === 'ENOENT' ? 'MP4 export needs FFmpeg installed and available on PATH.' : `MP4 conversion failed: ${error.stderr || error.message}`);
      }
      return { file: out };
    });
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
    const host = req.headers.host || '';
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return reply(403, { error: 'Bad host' });
    if (req.headers.origin) return reply(403, { error: 'Browser requests are not allowed' });
    const token = getToken();
    const given = /^Bearer (.+)$/i.exec(req.headers.authorization || '');
    if (!token || !given || !sameToken(given[1], token)) return reply(401, { error: 'Missing or wrong token' });
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
    try { server = await listen(DEFAULT_PORT); } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
      server = await listen(0);
    }
    port = server.address().port;
  }
  async function stopListening() {
    if (!server) return;
    const closing = server; server = null; port = 0;
    await new Promise(resolve => { closing.close(resolve); closing.closeAllConnections?.(); });
  }

  return {
    async init() { await load(); if (settings.enabled && getToken()) await startListening(); },
    async info() {
      return { enabled: settings.enabled && Boolean(server), allowScreens: settings.allowScreens, url: server ? `http://127.0.0.1:${port}/mcp` : '', hasToken: Boolean(getToken()), recordingsDir, auditFile };
    },
    async setEnabled(enabled) {
      if (enabled) { if (!getToken()) await rotateToken(); settings.enabled = true; await save(); await startListening(); }
      else { settings.enabled = false; await save(); await stopListening(); await controller.stopIfAgent(); }
      return this.info();
    },
    async setAllowScreens(value) { settings.allowScreens = Boolean(value); await save(); return this.info(); },
    async rotateToken() { return rotateToken(); },
    async revealToken() { return getToken(); },
    stop: stopListening
  };
}

module.exports = { createAgentServer };
