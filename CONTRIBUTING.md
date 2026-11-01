# Contributing to FrameBase Studio

Thanks for helping! Bug reports, fixes, features and docs are all welcome. Please follow the
[code of conduct](CODE_OF_CONDUCT.md), and report security problems privately as described in
[SECURITY.md](SECURITY.md).

## Setting up

You need [Node.js](https://nodejs.org/) 20 or newer, and FFmpeg on PATH for the editing tools and their tests
(`winget install Gyan.FFmpeg`, `brew install ffmpeg` or `apt install ffmpeg`).

```bash
npm install
npm start          # run the app
npm test           # unit tests (FFmpeg tests skip without FFmpeg)
npm run test:e2e   # drives the real app; opens windows on your screen for about a minute
npm run lint
npm run pack       # unpacked build in release/
```

The app is plain JavaScript on Electron with no bundler or framework. [CLAUDE.md](CLAUDE.md) has a map of the files
and the project's rules; it's written for AI coding agents but is just as useful to people.

## Before you open a pull request

- Open an issue first for anything big, so we can agree on the approach.
- Keep each pull request to one change, with tests where it makes sense (`test/` for logic, `test/e2e/run.js` for
  anything that touches recording, IPC or the agent server).
- Run `npm run lint` and `npm test`, plus `npm run test:e2e` for recording, IPC or agent changes. In the pull
  request, say what you tested and what you couldn't (for example macOS, Linux, multiple monitors, a real microphone
  or system audio).
- Update [README.md](README.md) when behaviour changes, and add a line to [CHANGELOG.md](CHANGELOG.md).

## Project rules

These keep FrameBase safe to give an AI agent. Pull requests that break them won't be merged.

1. **Never fake success.** If a feature isn't implemented, hide it; no buttons or menu items that do nothing.
2. **Secrets only via `safeStorage`.** Never log, print or store tokens in plain settings.
3. **Don't loosen a security check to make something work**: context isolation, the sandbox, the content security
   policy, the agent server's Host and Origin checks, token comparison, permission handlers. Fix the cause instead.
4. **Keep the preload bridges small** and validate every IPC argument in `main.js`.
5. **Local only.** No network requests the user didn't ask for, and no telemetry.
6. **Cross-platform paths:** `path.join` and Electron's `app.getPath`, never hard-coded paths.

## Licence

By contributing, you agree that your contribution is licensed under the [MIT License](LICENSE).
