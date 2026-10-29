---
name: framebase-video-production
description: Record app windows and produce narrated videos (product reviews, feature demos, tutorials, bug reports) with the FrameBase Studio MCP server. Use when the user asks for a screen recording, a demo or review video, a voice-over, captions, or to trim or join clips, and the `framebase` MCP tools are available.
---

# Video production with FrameBase Studio

FrameBase Studio is a desktop recorder on the user's computer. Its MCP server (usually named `framebase`) records app
windows and edits the results with FFmpeg. Every file lives in one folder; tools take file names from `list_files`
and always write a **new** file, so nothing is overwritten.

## Before you start

1. Call `workspace_info`. If `ffmpeg.available` is false, recording still works but trimming, joining, voice-overs
   and captions do not: tell the user to install FFmpeg (`winget install Gyan.FFmpeg`, `brew install ffmpeg`,
   `apt install ffmpeg`) and restart FrameBase.
2. Call `list_sources`. Agents can record app windows; whole screens and the microphone only work if the user turned
   them on in FrameBase > Agent control. Do not ask the user to turn them on unless the video really needs it.
3. Look at the window titles. If a window shows something private (mail, chats, banking, password managers), ask
   before recording it, or ask the user to close it.

## Recording

- Record one section per clip: `start_recording` → drive the app → `stop_recording`. Short clips are easier to trim,
  narrate and reorder than one long take.
- Pass `max_seconds` a little above what you need; the recording stops itself there.
- The user sees an **AGENT** badge and can stop you. If `stop_recording` says nothing is recording, the user stopped
  it: `recording_status` shows the saved file.
- Use `system_audio: true` only when the app's own sound matters (Windows, or macOS 14.2 and newer).

## Checking what you recorded

- `media_info` gives the length and size. `extract_frame` returns the frame as an image: look at the start, middle
  and end of each clip before editing, and re-record a section if the window was covered or showed the wrong thing.

## Producing a narrated video

1. `trim_video` each clip to remove dead time at the start and end.
2. Write the narration per section. Aim for about 150 words per minute of video.
3. `generate_voiceover` makes a WAV with the computer's own voices (offline; `list_voices` shows them). For a more
   natural voice, generate audio with another tool you have and copy it into the FrameBase folder first.
4. `add_audio` puts the voice-over on its clip. `mode: "mix"` keeps the app's sound underneath at
   `original_volume` (default 0.3); if the narration is longer than the clip the last frame is held.
5. `join_videos` puts the sections in order (clips are fitted to the first clip's frame size).
6. `add_captions` burns in timed text. Use `media_info` on each voice-over to time captions, or pass an `.srt` file.
7. `open_in_editor` so the user can watch it, and tell them the file name.

## Product review outline

Intro (what the app is, who it is for) → 2-4 key features, one clip each → a weakness or limit → verdict.
Keep the whole review between 1 and 3 minutes unless the user asks otherwise.
