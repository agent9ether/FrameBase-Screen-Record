// "Agent control" page, and the start request an agent sends through the main process.
(() => {
  if (!window.studio || !window.studio.agentInfo) return;
  const enabled = $('#agent-enabled'), screens = $('#agent-screens'), details = $('#agent-details');
  let revealed = false;

  async function refresh() {
    const info = await window.studio.agentInfo();
    enabled.checked = info.enabled;
    screens.checked = info.allowScreens;
    details.hidden = !info.enabled;
    $('#agent-url').textContent = info.url;
    $('#agent-folder').textContent = info.recordingsDir;
    $('#agent-command').textContent = `claude mcp add --transport http framebase ${info.url} --header "Authorization: Bearer <token>"`;
    if (!revealed) $('#agent-token').textContent = '••••••••••••••••••••';
  }
  const flash = (button, label) => { const old = button.textContent; button.textContent = label; setTimeout(() => { button.textContent = old; }, 1400); };
  const copy = async (button, value) => { await navigator.clipboard.writeText(value); flash(button, 'Copied'); };

  enabled.onchange = async () => {
    try { await window.studio.agentSetEnabled(enabled.checked); } catch (error) { alert(error.message); }
    revealed = false; refresh();
  };
  screens.onchange = async () => { await window.studio.agentSetAllowScreens(screens.checked); refresh(); };
  $('#agent-copy-url').onclick = e => copy(e.currentTarget, $('#agent-url').textContent);
  $('#agent-reveal').onclick = async e => {
    revealed = !revealed;
    $('#agent-token').textContent = revealed ? await window.studio.agentRevealToken() : '••••••••••••••••••••';
    e.currentTarget.textContent = revealed ? 'Hide' : 'Show';
  };
  $('#agent-copy-token').onclick = async e => copy(e.currentTarget, await window.studio.agentRevealToken());
  $('#agent-copy-command').onclick = async e => copy(e.currentTarget, $('#agent-command').textContent.replace('<token>', await window.studio.agentRevealToken()));
  $('#agent-rotate').onclick = async () => {
    if (!confirm('Create a new token? Agents using the old one will stop working until you give them the new one.')) return;
    await window.studio.agentRotateToken();
    revealed = false; $('#agent-reveal').textContent = 'Show'; refresh();
  };
  $$('.nav-item[data-view="agent"]').forEach(button => button.addEventListener('click', refresh));

  // An agent asked the main process to start a recording; run the same flow as the "Start recording" button.
  window.__agentStart = async ({ sourceId, systemAudio, microphone }) => {
    agentRecording = true;
    selectedCaptureSourceId = sourceId;
    $('#system-audio-toggle').checked = Boolean(systemAudio);
    $('#mic-toggle').checked = Boolean(microphone);
    try {
      await $('#confirm-source').onclick();
      if (recorder && recorder.state !== 'inactive') window.studio.agentResult({ kind: 'start', ok: true });
    } catch (error) {
      agentRecording = false;
      window.studio.agentResult({ kind: 'start', ok: false, error: error.message });
    }
  };
  refresh();
})();
