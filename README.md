# Frameforge Studio

A desktop screen recorder with a built-in editing space. The first version includes screen and window capture, a local recording workflow, video import and preview, a basic timeline, and file export.

## Getting started

1. Install [Node.js](https://nodejs.org/).
2. In this folder, run `npm install`.
3. Run `npm start`.

On Windows, choose a screen or app window in the recording dialog and allow the system's capture permission prompt. Recordings remain on your device.

## Current scope

- Electron desktop shell
- Screen or window recording with pause and stop controls
- Microphone option
- Import and preview local video files
- Starter editing workspace with preview, inspector, and timeline layout
- Export of the source recording or imported clip

The editing controls are an early foundation. Timeline trimming, effects, and MP4 transcoding are future work; recordings currently export in WebM format.
