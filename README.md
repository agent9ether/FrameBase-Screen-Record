# FrameBase Studio

A desktop screen recorder with a built-in editing space. The first version includes screen and window capture, a local recording workflow, video import and preview, a basic timeline, and file export.

## Getting started

1. Install [Node.js](https://nodejs.org/).
2. In this folder, run `npm install`.
3. Run `npm start`.

On Windows, choose a screen or app window in the recording dialog and allow the system's capture permission prompt. Recordings remain on your device.

## Current scope

- Electron desktop shell
- Screen or app-window recording with an explicit source picker
- System audio loopback on Windows, with optional microphone audio mixed in
- Always-on-top floating controls while recording, so the full studio can stay hidden
- Fixed WebM duration metadata so recordings can seek correctly in the editor
- Microphone option
- Import and preview local video files
- Starter editing workspace with preview, inspector, and timeline layout
- Export of complete source clips as WebM, plus MP4 conversion with FFmpeg installed
- Save and reopen portable `.framebase` project files with their source video
- Preview zoom, crop framing, and draggable text overlays

## Agent control (optional MCP server)

FrameBase can let an AI agent such as Claude Code or Codex start and stop recordings. It is **off by default**.

1. Open **Agent control** in the sidebar and turn on **Allow AI agents to record**.
2. Press **Copy** next to *Add to Claude Code* and run that command in a terminal. It looks like
   `claude mcp add --transport http framebase http://127.0.0.1:47615/mcp --header "Authorization: Bearer <token>"`.
3. Ask the agent to record an app window.

| Tool | What it does |
|---|---|
| `list_sources` | App windows that can be recorded (screens too, if you allow them) |
| `start_recording` | Start recording a window by `source_id` or `window_title`; optional system audio, microphone and `max_seconds` (default 600) |
| `pause_recording` / `resume_recording` | Pause or resume |
| `stop_recording` | Stop and save to `Documents\FrameBase Recordings`; returns the file path |
| `recording_status` | Running or not, seconds so far, last saved file |
| `list_recordings` | Recent files in the recordings folder |
| `convert_to_mp4` | Convert a saved recording to MP4 (needs FFmpeg on PATH) |

How it stays safe:

* Listens on `127.0.0.1` only, needs a bearer token (stored encrypted with the operating system), and refuses browser requests.
* Agents can only record **app windows** unless you tick *Also allow whole screens*.
* A floating **AGENT** control bar stays on screen while an agent records, and you can stop at any time. Recordings stop by themselves after `max_seconds`.
* An agent can only stop recordings it started, and can only convert files inside the recordings folder.
* Every call is written to `agent-audit.log` in the app's data folder. Turning the switch off stops the server.

Zoom, crop framing, and draggable text overlays are available in the preview and are saved with the project. Export preserves the full source clip; MP4 and format conversion require FFmpeg on PATH.
