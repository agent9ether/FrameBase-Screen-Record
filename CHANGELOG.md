# Changelog

All notable changes are listed here. Versions follow [semantic versioning](https://semver.org/).

## [Unreleased]

### Added
- Help › Report a Bug opens GitHub's bug form with the version and system filled in; Help › Suggest a Feature opens the
  feature form.

### Fixed
- The editor's Properties panel no longer runs past its right edge.

## [0.1.0] - first public release

### Recording
- Record a whole screen or a single window, with the microphone and system audio (Windows, and macOS 14.2 or
  newer). Recordings stream to disk as they're made, and are recovered if the app quits or crashes mid-recording.
- A floating bar to start, pause and stop recording without switching to the app; it can be hidden from the
  View menu.

### Editing
- Timeline editor with text and zooms that each have their own start and end. Drag them on the timeline, or type
  exact times.
- Text in 11 fonts with size, bold, italic, color and a background box.
- Smooth zooms that ease in and out at an adjustable speed and glide from one zoom to the next.
- Crop to fill the frame, and Space to play or pause.
- Export to MP4 (with FFmpeg) or WebM. Save and reopen projects.

### Agent control
- An MCP server that lets AI agents record, review, script, voice, cut and caption videos. It is off by default,
  local only, needs a token, is limited by permissions you choose, and logs every call.
- A Claude Code skill for the video-production workflow.

[Unreleased]: https://github.com/agent9ether/FrameBase-Screen-Record/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/agent9ether/FrameBase-Screen-Record/releases/tag/v0.1.0
