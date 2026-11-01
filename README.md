# FrameBase Studio

A desktop screen recorder and editor that **AI agents can drive**. Ask Claude Code, Codex or any MCP client to
record an app window, look at what it captured, write and voice a script, cut the clips together and add captions,
and get a finished product review, feature demo or tutorial back. People can use every part of it without an agent
too.

Everything runs on your computer: recordings, editing and voice-overs never leave it, and the app makes no network
requests of its own.

## Getting started

1. Install [Node.js](https://nodejs.org/) 20 or newer.
2. In this folder, run `npm install`, then `npm start`.
3. For editing tools (trim, join, voice-over mixing, captions, MP4 export), install FFmpeg and make sure it is on
   PATH: `winget install Gyan.FFmpeg` on Windows, `brew install ffmpeg` on macOS, `apt install ffmpeg` on Linux.
   Recording and WebM export work without it.

## Let an agent make the video

1. Open **Agent control** in the sidebar and turn on **Allow AI agents to record and edit**.
2. Press **Copy** next to *Add to Claude Code* and run that command in a terminal. It looks like
   `claude mcp add --transport http framebase http://127.0.0.1:47615/mcp --header "Authorization: Bearer <token>"`.
   For other MCP clients, copy the JSON config instead.
3. Ask the agent, for example: *"Use FrameBase to make a two-minute narrated review of the Notes app."*

Clients that support MCP prompts also get a `product_review` prompt, and the server sends its own workflow
instructions. For Claude Code there is a skill with more detail in
[agent-skills/framebase-video-production](agent-skills/framebase-video-production/SKILL.md): copy that folder into
`~/.claude/skills/` (or your project's `.claude/skills/`).

### Tools

| Tool | What it does |
|---|---|
| `list_sources` | App windows that can be recorded (screens too, if you allow them) |
| `start_recording` | Record a window by `source_id` or `window_title`; optional `system_audio` (Windows, macOS 14.2+), `microphone` (if allowed) and `max_seconds` (default 600, paused time does not count) |
| `pause_recording` / `resume_recording` | Pause or resume a recording the agent started |
| `stop_recording` | Stop and save; returns the file |
| `recording_status` | Running or not, recorded seconds, last saved file |
| `workspace_info` | The recordings folder, whether FFmpeg is installed, what you allow |
| `list_files` / `list_recordings` | Videos, audio, images and captions in the folder |
| `media_info` | Length, resolution and audio of a file |
| `extract_frame` | Saves a PNG and returns it as an image, so the agent can see what it recorded |
| `trim_video` | Keep part of a video |
| `join_videos` | Join clips in order, fitted to the first clip's frame |
| `generate_voiceover` / `list_voices` | Turn a script into a WAV with the computer's own speech voices, offline |
| `add_audio` | Put a voice-over or music on a video (mix with or replace its sound); holds the last frame if the audio is longer |
| `add_captions` | Burn in timed text, from a list of lines or an `.srt` file |
| `convert_video` / `convert_to_mp4` | Convert to MP4 or WebM |
| `open_in_editor` | Open a result in the FrameBase editor for you to review |

Editing tools need FFmpeg. Burned-in captions also need an FFmpeg build with libass (the `subtitles` filter); slim
builds leave it out, and `workspace_info` reports `captions: false` in that case. Voice-overs use Windows speech, macOS `say`, or `espeak-ng` on Linux; an agent can also
copy in narration it made another way.

### How it stays safe

* Off by default. Listens on `127.0.0.1` only, needs a bearer token stored encrypted by the operating system
  (`safeStorage`; on Linux a system keyring is required), and refuses any request with an `Origin` header or a
  `Host` other than `127.0.0.1:<port>` / `localhost:<port>`.
* Agents can record **app windows** only, unless you tick *Also allow whole screens*. They cannot record the
  microphone unless you tick *Allow agents to record the microphone*.
* A floating **AGENT** bar stays on screen while an agent records and you can stop it at any time. An agent can only
  pause or stop recordings it started, and recordings stop by themselves after `max_seconds`.
* File tools only read files inside the recordings folder (symlinks are checked) and always write new files; they
  never overwrite or delete anything.
* Every call, and every refused request, is written to `agent-audit.log` in the app's data folder (rotated at 5 MB).
  Turning the switch off stops the server and any agent recording.
* The address stays the same across restarts unless the port is taken. Copied commands contain the token, and your
  agent's config will store it: press **New token** if it leaks.

## Recording and editing yourself

* **New recording** (Ctrl R, ⌘ R on macOS): pick a screen or app window, optionally system audio and your
  microphone. A floating bar lets you pause, stop or bring the studio back; it is kept out of the recording.
* The floating bar also stays on screen while you are not recording, with a **Record** button that opens the source
  picker. Hide it with its ✕ and bring it back from **View › Floating Record Bar**.
* **System audio** works on Windows and on macOS 14.2 or newer. macOS asks for permission the first time (System
  Settings › Privacy & Security › Screen & System Audio Recording). When you run from source with `npm start`, macOS
  asks about your terminal app instead, and it may not offer system audio at all; the built app (`npm run dist`)
  carries its own permission text. If macOS refuses, FrameBase says so instead of recording silence.
* Recordings are written to `Documents/FrameBase Recordings` **while you record**. If the app or computer stops
  mid-recording, the next start keeps what was written as `…-recovered.webm`. Quitting while recording stops and
  saves first. Closing the recorded window stops the recording.
* **Home** and **Media library** list the videos in that folder, including what agents make.
* The **editor** plays a clip and places **text** and **zooms** on the timeline. **＋ Text** and **＋ Zoom** add one
  at the playhead, lasting 3 seconds; drag it on its track to move it, or drag its edges to change when it starts and
  ends (or type exact times in the Properties panel). Drag text on the preview to position it, and give each text
  its own font, size, bold or italic, color and background (color and opacity) in the Properties panel; new text
  starts with the last style you used. Manrope, DM Sans and DM Mono come with the app; the other fonts are the
  computer's own, and a similar font stands in where one is missing (mostly on Linux). While a zoom is
  selected, a box on the preview shows the area it zooms into: drag the box, and set how far with the slider. Zooms
  ease in and out. *Crop to fill the frame* applies to the whole clip. Select an item and press Delete to remove it.
* **Export**: MP4 (needs FFmpeg) or WebM. Without edits the clip is copied or converted directly; with zoom, crop or
  text, the clip plays once in real time to render them in.
* **Save project** writes a small `.framebase` file that points to the video and stores your edits with their times. Keep the two
  together. Older project files still open: their zoom and text cover the whole clip, and ones that embedded the
  video write it out to the recordings folder once.

## Development

```bash
npm start          # run the app
npm test           # unit tests: agent server, media tools, WebM duration (FFmpeg tests skip without FFmpeg)
npm run test:e2e   # drives the real app end to end; opens windows on your screen for about a minute
npm run lint
npm run pack       # unpacked build in release/
npm run dist       # installer (NSIS on Windows, dmg on macOS, AppImage on Linux)
```

Builds are not code-signed, so Windows SmartScreen and macOS Gatekeeper will warn. There is no auto-update.
