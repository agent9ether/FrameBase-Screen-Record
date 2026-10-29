# CLAUDE.md: FrameBase Studio

Desktop screen recorder and editor that people and AI agents (via MCP) can drive. Electron 45, plain JS (no bundler, no framework). Read
[README.md](README.md) first.

## Commands

```bash
npm install
npm start          # electron .
npm test           # node:test unit tests (agent server, media tools, WebM duration)
npm run test:e2e   # drives the real app end to end; opens windows on screen
npm run lint       # ESLint flat config
npm run pack       # electron-builder --dir (release/ is ignored)
```

Run `npm test` and `npm run lint`, plus `npm run test:e2e` for anything touching recording, IPC or the agent. Say what
you could not verify (macOS/Linux, multi-monitor, a real microphone and system audio need a manual run).

## Layout

| File | Role |
|---|---|
| `main.js` | Main process: windows, permission and display-media handlers, `framebase-media://` scheme, sender-checked IPC, streaming recordings to disk, recovery, agent controller |
| `preload.js` | Studio bridge (`window.studio`), sandboxed; every method here is attack surface |
| `control-preload.js` | Floating bar bridge (`window.controls`): record (opens the picker), pause, stop, show studio, hide bar only |
| `renderer.js`, `index.html`, `styles.css`, `studio.css`, `player-controls.css`, `capture-picker.css`, `fonts.css` | Main UI, MediaRecorder capture, library, editor, export |
| `mini-control.{html,js,css}` | Floating bar: idle Record button, recording controls, the AGENT badge |
| `agent-server.js` | Agent-control MCP server (Streamable HTTP, stateless per request), tools and prompt |
| `media-tools.js` | FFmpeg and OS speech helpers confined to the recordings folder; used by agents and export |
| `webm-duration.js` | Writes the duration into MediaRecorder WebM files |
| `agent-ui.js`, `agent.css` | Agent settings page and `window.__agentStart` |
| `agent-skills/` | Claude Code skill for the video-production workflow |
| `test/`, `test/e2e/run.js` | Unit tests and the real-app end-to-end run |

Recordings stream to `Documents/FrameBase Recordings/FrameBase-<stamp>-<id>.webm.part` while recording and become
`FrameBase-<stamp>.webm` when finished; leftover `.part` files are recovered on start. Agent settings live in userData
(`agent-control.json`) and the audit log in `agent-audit.log`.

## Agent control (the part to be most careful with)

- Binds to `127.0.0.1` only, default port 47615 (the last port is remembered), falls back to a random port.
- Bearer token, stored encrypted with `safeStorage`; compared by sha256 + `timingSafeEqual`.
- Host header must be `127.0.0.1:<port>` or `localhost:<port>`; any `Origin` header is rejected (DNS rebinding and
  browser-origin defence).
- Starting a capture uses `executeJavaScript(..., true)` for the user gesture; screens need `allowScreens` on and the
  microphone needs `allowMicrophone` on. `display-capture` is only granted while a picked source is pending.
- Media tools only read files inside the recordings folder (symlinks checked) and only write new files.
- Every tool call and refused request is audit-logged; recordings have an auto-stop limit and show the AGENT badge.
- Don't weaken any of this to make something easier.

## Non-negotiables

1. **Never fake success.** If a feature is not implemented, hide it. No dead buttons or menu items.
2. **Secrets only via `safeStorage`.** Never log, print, store in plain settings, or send tokens to the renderer
   (the explicit reveal action is the one exception).
3. **Don't loosen a security check to get something working** (contextIsolation, sandbox, CSP, Host/Origin checks,
   token comparison, permission handlers). Fix the cause.
4. **Keep the preload surface small.** Validate every IPC argument in `main.js`; don't expose raw `ipcRenderer`.
5. **Local only.** No outbound network calls the user didn't trigger. No telemetry.
6. **Cross-platform paths:** `path.join` and Electron `app.getPath`, never hard-coded Windows paths.

## Working agreements

- Small, verified commits on a feature branch; local `main` is ahead of origin and **unpushed**.
- **Ask before** pushing, tagging, publishing, releasing, or deleting files.
- Update README.md when behavior changes (especially the Agent control section).
- Report failures honestly, including anything you couldn't test (audio capture, multi-monitor, crash mid-recording
  need a real run).
- Don't commit secrets, `agent-control.json`, audit logs, recordings, or `node_modules`.
