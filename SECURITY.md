# Security policy

FrameBase lets AI agents record your screen and edit files, so security reports are very welcome.

## Reporting a vulnerability

Please **don't open a public issue**. Report it privately through
[GitHub's private vulnerability reporting](https://github.com/agent9ether/FrameBase-Screen-Record/security/advisories/new)
with steps to reproduce, the platform, and what an attacker could do. You should hear back within a week. Once a fix
is released, the advisory is published and you're credited unless you'd rather not be.

## Supported versions

Only the latest release gets security fixes.

## What's in scope

The most sensitive part is the agent-control server (`agent-server.js` and the agent controller in `main.js`).
Its intended protections are:

- It is off until turned on, listens on `127.0.0.1` only, and needs a bearer token stored with the OS keychain
  (Electron `safeStorage`) and compared in constant time.
- Requests with a wrong `Host` header or any `Origin` header are refused, which blocks web pages and DNS rebinding.
- Screen capture needs *Allow screens* and the microphone needs *Allow microphone*; recordings show an AGENT badge
  and stop automatically after a time limit.
- Media tools only read files inside the recordings folder (symlinks are checked) and only write new files there.
- Every tool call and refused request is written to an audit log.

A way around any of these is a vulnerability. So are escapes from the renderer sandbox or context isolation,
IPC handlers in `main.js` that accept unchecked input, and the `framebase-media://` scheme serving files outside the
recordings folder.

Not in scope: a person who already has your token, or already runs code as your user on your computer, controlling
the app; and warnings about unsigned builds.
