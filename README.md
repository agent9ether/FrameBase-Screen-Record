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

Zoom, crop framing, and draggable text overlays are available in the preview and are saved with the project. Export preserves the full source clip; MP4 and format conversion require FFmpeg on PATH.
