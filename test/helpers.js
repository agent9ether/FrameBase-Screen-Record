// Shared fixtures for the agent server tests. No Electron needed: safeStorage and the recorder are stubbed.
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { createAgentServer } = require('../agent-server');

const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  // reversible, but never equal to the plain text, so a test can tell the token was not stored as-is
  encryptString: text => Buffer.from(text, 'utf8').reverse(),
  decryptString: buffer => Buffer.from(buffer).reverse().toString('utf8')
};

function fakeController(overrides = {}) {
  const calls = [];
  const controller = {
    calls,
    async listSources() {
      return [
        { id: 'window:1:0', name: 'Notes - Product spec', type: 'window' },
        { id: 'window:2:0', name: 'Browser', type: 'window' },
        { id: 'screen:0:0', name: 'Screen 1', type: 'screen' }
      ];
    },
    async start(options) { calls.push(['start', options]); return { ok: true }; },
    async setPaused(paused) { calls.push(['setPaused', paused]); return { paused }; },
    async stop() { calls.push(['stop']); return { file: 'x.webm', seconds: 1, bytes: 1 }; },
    async stopIfAgent() { calls.push(['stopIfAgent']); },
    status() { return { recording: false }; },
    ...overrides
  };
  return controller;
}

async function makeAgent({ controller = fakeController(), safeStorage = fakeSafeStorage, ...options } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'framebase-test-'));
  const recordingsDir = path.join(dir, 'recordings');
  const agent = createAgentServer({ safeStorage, userDataPath: dir, recordingsDir, controller, ...options });
  await agent.init();
  return { agent, dir, recordingsDir, controller, cleanup: async () => { await agent.stop(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

async function connectClient(url, token) {
  const client = new Client({ name: 'framebase-test', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  await client.connect(transport);
  return client;
}

// Raw request so tests can set Host, Origin and Authorization exactly as an attacker would.
function rawRequest(port, { method = 'POST', path: urlPath = '/mcp', headers = {}, body = '{}' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers } }, res => {
      const parts = [];
      res.on('data', chunk => parts.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(parts).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

const resultText = result => result.content.map(part => part.text).join('\n');
const resultJson = result => JSON.parse(resultText(result));

module.exports = { fakeSafeStorage, fakeController, makeAgent, connectClient, rawRequest, resultText, resultJson };
