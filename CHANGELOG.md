# Changelog

All notable changes to GMS Scroller. Paste the relevant section into the GitHub
release body when publishing — that text is shown to users in the in-app update
prompt.

## [0.3.0] - 2026-05-29

### Added
- Automatic update check on startup, with an in-app prompt showing the changelog
  and Download & Install / Later options (via `electron-updater` + GitHub Releases).
- Bundled "Screen Capturer Recorder" audio driver — installed automatically on
  first install (skipped on updates if already present).
- GitHub Actions release pipeline: pushing a `vX.Y.Z` tag builds the Windows
  installer and publishes a draft GitHub release.

## [0.3.1] - 2026-06-05

### Added
- Installer updated to have a GUI with description of why screen 
  capture/recorder is required

## [0.4.0] - 2026-07-05

### Fixed
- **Installed builds now transcribe audio.** The speech-recognition worker was
  resolved to a path inside `app.asar`, which Python cannot read — audio
  matching only worked when running from source (`npm start`).
- Speaker initials with lowercase letters are now recognised, attributed in the margin,
  and their per-page footer rows no longer leak into the body text.
- Inline numbers (`1 John 4`, `Luke 7`) are no longer stripped from the text;
  page numbers and watermarks are still removed.
- Titles with "Lord's day" or day-first dates are now detected, and the
  SCRIPTURES READ section is kept when it appears before the title block.
- Loading a new PDF while one is already open now jumps back to the top.
- Installer build no longer fails on the uninstaller pass ("AudioDriverPage
  not referenced" NSIS warning-as-error).

### Added
- **Click any sentence to re-sync** — paragraphs are split into sentences and
  the audio position now tracks within long paragraphs instead of jumping a
  paragraph at a time.
- **Match visibility**: the current sentence range is highlighted, the exact
  matched words are marked, the search window is shown with a subtle
  underline, and a match score readout appears in the toolbar. Toggle via
  "Show match details" in Settings.
- **Lost-sync auto-recovery**: after three misses the search widens (including
  slightly backward) until the position is found again.
- **Whisper model picker** in Settings (tiny → large-v3).
- **Diagnostics panel** (toolbar button): audio device, chunk/transcription
  counters, last heard text, last match, and a live log tail.
- **Bundled FFmpeg and Python** — the installer now ships both runtimes with
  faster-whisper preinstalled; nothing needs to be installed separately.
  (Installer is ~400 MB larger as a result.)
- Main-process and renderer errors are written to
  `%APPDATA%\gms-scroller\logs\main.log` for diagnosing installed builds.
- A PDF path can be passed on the command line (enables "Open with…").