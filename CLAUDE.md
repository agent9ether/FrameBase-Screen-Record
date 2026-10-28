# CLAUDE.md: FrameBase Studio

Desktop screen recorder with a built-in editing space. Electron 38, plain JS (no bundler, no framework). Read
[README.md](README.md) first.

## Commands

```bash
npm install
npm start          # electron .
```

There is currently **no** lint, test, typecheck or packaging setup (package.json only has `start`). Adding them is part
of the build-out: tests for `agent-server.js` first, then a linter and an electron-builder config. Until they exist,
verify by running the app and say what you could not verify.

## Layout

| File | Role |
|---|---|
| `main.js` | Main process: windows, capture source handling (`setDisplayMediaRequestHandler`), IPC handlers, agent controller, save-to-disk |
| `preload.js` | The only bridge to the renderer (`window.studio`); every method here is attack surface |
| `renderer.js`, `index.html`, `styles.css`, `player-controls.css`, `capture-picker.css` | Main UI, MediaRecorder capture, editor/player |
| `mini-control.{html,js,css}` | Floating recording control, including the AGENT badge |
| `agent-server.js` | Agent-control MCP server (Streamable HTTP, stateless per request) |
| `agent-ui.js`, `agent.css` | Agent settings page and `window.__agentStart` |

Recordings are saved to `Documents\FrameBase Recordings\FrameBase-<stamp>.webm`. Agent settings live in userData
(`agent-control.json`) and the audit log in `agent-audit.log`.

## Agent control (the part to be most careful with)

- Binds to `127.0.0.1` only, default port 47615, falls back to a random port.
- Bearer token, stored encrypted with `safeStorage`; compared by sha256 + `timingSafeEqual`.
- Host header must be `127.0.0.1:<port>` or `localhost:<port>`; any `Origin` header is rejected (DNS rebinding and
  browser-origin defence).
- Starting a capture uses `executeJavaScript(..., true)` for the user gesture; screens need `allowScreens` on.
- Every tool call is audit-logged; recordings have an auto-stop timer and show the AGENT badge.
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
