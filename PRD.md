# TranscriptSync — Product Requirements Document

## 1. Problem Statement

When listening to audio from a specific website, following along in a downloaded PDF transcript is painful — manual scrolling is distracting and makes it easy to lose your place. This app solves that by embedding the audio site and auto-scrolling a PDF transcript in sync with playback using real-time speech recognition.

---

## 2. Goals

- Load any PDF transcript and display it as readable, scrollable text
- Embed the target audio website (preserving login session)
- Capture the audio being played and run real-time speech-to-text (STT)
- Continuously match STT output against the transcript and auto-scroll to the current position
- Personal use only, runs offline (except for the audio site itself)

---

## 3. Non-Goals (v1)

- Multi-user support
- Syncing/saving position across sessions
- Editing the transcript
- Support for multiple audio sites
- Mobile or web deployment

---

## 4. Users

- Single user (Kieran), personal desktop tool

---

## 5. Core Features

### F1 — PDF Loading & Rendering
- File picker to load any `.pdf`
- Parse PDF into a list of text paragraphs/blocks, preserving order
- Display in a scrollable, readable pane (not rendered as image — text extraction only)
- Speaker initials at paragraph starts preserved as-is

### F2 — Website Embed
- Embedded browser view (webview) pointing to the target audio site
- Persists session/cookies between sessions (user logs in once)
- Standard playback controls available within the embed

### F3 — System Audio Capture
- Capture system audio output (loopback) — i.e. what is playing through speakers/headphones
- Segment into rolling chunks (e.g. 8–10 seconds, with 2s overlap to avoid boundary misses)
- Feed chunks into the STT engine

### F4 — Speech-to-Text Engine
- Run `faster-whisper` locally (Python subprocess)
- Small or medium model for balance of speed/accuracy
- Returns transcribed text per chunk

### F5 — Transcript Alignment
- Fuzzy-match each STT chunk against a sliding window of transcript paragraphs
- Track which paragraph is the "current" position
- Advance position only forward (never jump backward unless user rewinds)
- Configurable confidence threshold — if no good match, hold position

### F6 — Auto-Scroll
- Scroll the transcript pane to keep the current paragraph in view (centred or top-third)
- Highlight (or subtly mark) the active paragraph
- Smooth scroll animation

### F7 — Controls
- Play/Pause toggle for the STT listener (so you can pause without stopping audio)
- Manual scroll override — user can scroll freely; auto-scroll resumes after a short delay
- Optional: progress indicator bar showing approximate position in document

---

## 6. UI Layout

```
┌─────────────────────────────────────────────────────────┐
│  TranscriptSync                              [controls]  │
├──────────────────────────┬──────────────────────────────┤
│                          │                              │
│   PDF TRANSCRIPT PANE    │    EMBEDDED AUDIO SITE       │
│   (scrollable text)      │    (webview)                 │
│                          │                              │
│   ► Active paragraph     │    [site login / player]     │
│     highlighted          │                              │
│                          │                              │
│                          │                              │
├──────────────────────────┴──────────────────────────────┤
│  [Load PDF]  [● Listen]  [▐▐ Pause]   Status: Synced ✓  │
└─────────────────────────────────────────────────────────┘
```

- Split pane layout, resizable divider
- Toolbar at bottom with key actions and status

---

## 7. Configuration (stored locally)

- Target audio site URL
- Whisper model size (tiny / base / small / medium)
- STT chunk duration (seconds)
- Highlight colour
- Auto-scroll resume delay (seconds after manual scroll)

---

## 8. Success Criteria

- Transcript stays within 1–2 paragraphs of the actual audio position
- Alignment recovers automatically after short pauses or speaker changes
- App is stable for sessions of 60+ minutes

---

## 9. Out of Scope / Known Limitations

- **No timestamps in transcript** — alignment relies entirely on fuzzy STT matching; accuracy depends on Whisper model quality and audio clarity
- **System audio capture on Windows** requires FFmpeg with WASAPI loopback; must be pre-installed
- **Speaker identification** not implemented — initials already in transcript serve as visual cue only
