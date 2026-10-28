const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeAgent, connectClient, rawRequest, resultText, resultJson } = require('./helpers');

const listToolsBody = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

test('server is off by default and does not listen', async () => {
  const { agent, cleanup } = await makeAgent();
  try {
    const info = await agent.info();
    assert.equal(info.enabled, false);
    assert.equal(info.url, '');
  } finally { await cleanup(); }
});

test('enabling creates a token that is stored encrypted, never in plain text', async () => {
  const { agent, dir, cleanup } = await makeAgent();
  try {
    await agent.setEnabled(true);
    const token = await agent.revealToken();
    assert.ok(token.length >= 32);
    const stored = fs.readFileSync(path.join(dir, 'agent-control.json'), 'utf8');
    assert.ok(!stored.includes(token), 'settings file must not contain the plain token');
    const info = await agent.info();
    assert.ok(!JSON.stringify(info).includes(token), 'info() must not leak the token');
  } finally { await cleanup(); }
});

test('rejects requests without the right bearer token', async () => {
  const { agent, cleanup } = await makeAgent();
  try {
    const { url } = await agent.setEnabled(true);
    const port = new URL(url).port;
    assert.equal((await rawRequest(port, { headers: { host: `127.0.0.1:${port}` }, body: listToolsBody })).status, 401);
    assert.equal((await rawRequest(port, { headers: { host: `127.0.0.1:${port}`, authorization: 'Bearer wrong' }, body: listToolsBody })).status, 401);
    assert.equal((await rawRequest(port, { headers: { host: `127.0.0.1:${port}`, authorization: 'Basic abc' }, body: listToolsBody })).status, 401);
  } finally { await cleanup(); }
});

test('rejects foreign Host headers (DNS rebinding) even with the right token', async () => {
  const { agent, cleanup } = await makeAgent();
  try {
    const { url } = await agent.setEnabled(true);
    const port = new URL(url).port;
    const authorization = `Bearer ${await agent.revealToken()}`;
    for (const host of [`evil.test:${port}`, '127.0.0.1', `127.0.0.1:${Number(port) + 1}`, `localhost.evil.test:${port}`]) {
      const res = await rawRequest(port, { headers: { host, authorization }, body: listToolsBody });
      assert.equal(res.status, 403, `host ${host} should be rejected`);
    }
    assert.equal((await rawRequest(port, { headers: { host: `localhost:${port}`, authorization }, body: listToolsBody })).status, 200);
  } finally { await cleanup(); }
});

test('rejects any request carrying an Origin header', async () => {
  const { agent, cleanup } = await makeAgent();
  try {
    const { url } = await agent.setEnabled(true);
    const port = new URL(url).port;
    const authorization = `Bearer ${await agent.revealToken()}`;
    for (const origin of ['http://evil.test', `http://127.0.0.1:${port}`, 'null']) {
      const res = await rawRequest(port, { headers: { host: `127.0.0.1:${port}`, authorization, origin }, body: listToolsBody });
      assert.equal(res.status, 403, `origin ${origin} should be rejected`);
    }
  } finally { await cleanup(); }
});

test('only POST /mcp is served', async () => {
  const { agent, cleanup } = await makeAgent();
  try {
    const { url } = await agent.setEnabled(true);
    const port = new URL(url).port;
    const headers = { host: `127.0.0.1:${port}`, authorization: `Bearer ${await agent.revealToken()}` };
    assert.equal((await rawRequest(port, { path: '/other', headers, body: listToolsBody })).status, 404);
    assert.equal((await rawRequest(port, { method: 'GET', headers, body: undefined })).status, 405);
  } finally { await cleanup(); }
});

test('rotating the token invalidates the old one', async () => {
  const { agent, cleanup } = await makeAgent();
  try {
    const { url } = await agent.setEnabled(true);
    const port = new URL(url).port;
    const old = await agent.revealToken();
    await agent.rotateToken();
    const fresh = await agent.revealToken();
    assert.notEqual(old, fresh);
    assert.equal((await rawRequest(port, { headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${old}` }, body: listToolsBody })).status, 401);
    assert.equal((await rawRequest(port, { headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${fresh}` }, body: listToolsBody })).status, 200);
  } finally { await cleanup(); }
});

test('disabling stops the server and stops an agent recording', async () => {
  const { agent, controller, cleanup } = await makeAgent();
  try {
    const { url } = await agent.setEnabled(true);
    await agent.setEnabled(false);
    assert.deepEqual(controller.calls.at(-1), ['stopIfAgent']);
    await assert.rejects(fetch(url, { method: 'POST' }));
  } finally { await cleanup(); }
});

test('a real MCP client can connect and list tools', async () => {
  const { agent, cleanup } = await makeAgent();
  try {
    const { url } = await agent.setEnabled(true);
    const client = await connectClient(url, await agent.revealToken());
    const { tools } = await client.listTools();
    const names = tools.map(t => t.name);
    for (const name of ['list_sources', 'start_recording', 'stop_recording', 'recording_status']) assert.ok(names.includes(name), name);
    await client.close();
  } finally { await cleanup(); }
});

test('list_sources hides screens until the user allows them', async () => {
  const { agent, cleanup } = await makeAgent();
  try {
    const { url } = await agent.setEnabled(true);
    const client = await connectClient(url, await agent.revealToken());
    let listed = resultJson(await client.callTool({ name: 'list_sources', arguments: { kind: 'all' } }));
    assert.equal(listed.screens_allowed, false);
    assert.ok(listed.sources.every(s => s.type === 'window'));
    await agent.setAllowScreens(true);
    listed = resultJson(await client.callTool({ name: 'list_sources', arguments: { kind: 'all' } }));
    assert.ok(listed.sources.some(s => s.type === 'screen'));
    await client.close();
  } finally { await cleanup(); }
});

test('start_recording refuses screens while screens are off', async () => {
  const { agent, controller, cleanup } = await makeAgent();
  try {
    const { url } = await agent.setEnabled(true);
    const client = await connectClient(url, await agent.revealToken());
    const result = await client.callTool({ name: 'start_recording', arguments: { source_id: 'screen:0:0' } });
    assert.equal(result.isError, true);
    assert.match(resultText(result), /whole screens is off/);
    assert.equal(controller.calls.filter(c => c[0] === 'start').length, 0);
    await client.close();
  } finally { await cleanup(); }
});

test('start_recording matches a window by title and passes options through', async () => {
  const { agent, controller, cleanup } = await makeAgent();
  try {
    const { url } = await agent.setEnabled(true);
    const client = await connectClient(url, await agent.revealToken());
    const result = await client.callTool({ name: 'start_recording', arguments: { window_title: 'product SPEC', system_audio: true, max_seconds: 30 } });
    assert.equal(result.isError, undefined);
    const [, options] = controller.calls.find(c => c[0] === 'start');
    assert.equal(options.sourceId, 'window:1:0');
    assert.equal(options.systemAudio, true);
    assert.equal(options.maxSeconds, 30);
    await client.close();
  } finally { await cleanup(); }
});

test('every tool call is written to the audit log without the token', async () => {
  const { agent, dir, cleanup } = await makeAgent();
  try {
    const { url } = await agent.setEnabled(true);
    const token = await agent.revealToken();
    const client = await connectClient(url, token);
    await client.callTool({ name: 'recording_status', arguments: {} });
    await client.callTool({ name: 'start_recording', arguments: { source_id: 'nope' } });
    const log = fs.readFileSync(path.join(dir, 'agent-audit.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.ok(log.some(row => row.tool === 'recording_status' && row.ok === true));
    assert.ok(log.some(row => row.tool === 'start_recording' && row.ok === false));
    assert.ok(!fs.readFileSync(path.join(dir, 'agent-audit.log'), 'utf8').includes(token));
    await client.close();
  } finally { await cleanup(); }
});

test('convert_to_mp4 refuses files outside the recordings folder', async () => {
  const { agent, dir, cleanup } = await makeAgent();
  try {
    const { url } = await agent.setEnabled(true);
    const client = await connectClient(url, await agent.revealToken());
    for (const file of [path.join(dir, 'agent-control.json'), path.join(dir, 'recordings', '..', 'x.webm'), 'C:/Windows/win.ini']) {
      const result = await client.callTool({ name: 'convert_to_mp4', arguments: { file } });
      assert.equal(result.isError, true, file);
    }
    await client.close();
  } finally { await cleanup(); }
});
