// "Agent control" page, the agent status pill, and the start request an agent sends through the main process.
(() => {
  const agentApi = window.studio.agent;
  const enabled = $('#agent-enabled'), screens = $('#agent-screens'), microphone = $('#agent-microphone'), details = $('#agent-details');
  const HIDDEN_TOKEN = '••••••••••••••••••••';
  let revealed = false;

  const claudeCommand = (url, token) => `claude mcp add --transport http framebase ${url} --header "Authorization: Bearer ${token}"`;
  const mcpJson = (url, token) => JSON.stringify({ mcpServers: { framebase: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } } });

  async function refresh() {
    const info = await agentApi.info();
    enabled.checked = info.enabled;
    screens.checked = info.allowScreens;
    microphone.checked = info.allowMicrophone;
    details.hidden = !info.enabled;
    $('#agent-url').textContent = info.url;
    $('#agent-folder').textContent = info.recordingsDir;
    $('#agent-log').textContent = info.auditFile;
    $('#agent-command').textContent = claudeCommand(info.url, '<token>');
    $('#agent-json').textContent = mcpJson(info.url, '<token>');
    if (!revealed) $('#agent-token').textContent = HIDDEN_TOKEN;
    $('#agent-ffmpeg-note').textContent = info.ffmpeg.available
      ? `Editing tools are ready (FFmpeg ${info.ffmpeg.version}). Voice-overs use this computer's own speech voices, offline.`
      : 'Recording works now. Editing tools (trim, join, voice-over mixing, captions) need FFmpeg installed and on PATH, for example: winget install Gyan.FFmpeg';
    $('#agent-pill').classList.toggle('on', info.enabled);
    $('#agent-pill-label').textContent = info.enabled ? 'Agent control on' : 'Agent control off';
    $('#agent-nav-state').textContent = info.enabled ? 'ON' : '';
  }
  const flash = (button, label) => { const old = button.textContent; button.textContent = label; setTimeout(() => { button.textContent = old; }, 1400); };
  const copy = async (button, value) => { await navigator.clipboard.writeText(value); flash(button, 'Copied'); };
  const failed = error => { alert(error.message); refresh(); };

  enabled.onchange = async () => {
    try { await agentApi.setEnabled(enabled.checked); } catch (error) { alert(error.message); }
    revealed = false;
    refresh();
  };
  screens.onchange = () => agentApi.setAllowScreens(screens.checked).then(refresh, failed);
  microphone.onchange = () => agentApi.setAllowMicrophone(microphone.checked).then(refresh, failed);
  $('#agent-copy-url').onclick = event => copy(event.currentTarget, $('#agent-url').textContent);
  $('#agent-reveal').onclick = async event => {
    const button = event.currentTarget;
    revealed = !revealed;
    $('#agent-token').textContent = revealed ? await agentApi.revealToken() : HIDDEN_TOKEN;
    button.textContent = revealed ? 'Hide' : 'Show';
  };
  $('#agent-copy-token').onclick = async event => copy(event.currentTarget, await agentApi.revealToken());
  $('#agent-copy-command').onclick = async event => copy(event.currentTarget, claudeCommand($('#agent-url').textContent, await agentApi.revealToken()));
  $('#agent-copy-json').onclick = async event => copy(event.currentTarget, mcpJson($('#agent-url').textContent, await agentApi.revealToken()));
  $('#agent-rotate').onclick = async () => {
    if (!confirm('Create a new token? Agents using the old one will stop working until you give them the new one.')) return;
    await agentApi.rotateToken();
    revealed = false;
    $('#agent-reveal').textContent = 'Show';
    refresh();
  };
  $$('[data-view="agent"], [data-view-link="agent"]').forEach(button => button.addEventListener('click', refresh));

  // An agent asked the main process to start a recording: run the same capture flow as the Start recording button.
  // Success is reported by main when the recording file opens; only failures are sent back from here.
  window.__agentStart = async options => {
    try { await startCapture(options); } catch (error) { agentApi.startFailed(error.message); }
  };
  refresh();
})();
