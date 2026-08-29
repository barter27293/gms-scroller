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
## [0.5.0] - 2026-08-29

### Added
- **Listening starts by itself.** The Listen button is gone: playback on the
  audio site now starts and gates transcription automatically, driven by the
  site's own media events. Pausing from either the app or the site's player
  works identically.
- **Playback speed** up to +25% (1.00x–1.25x in 5% steps), stepped from the
  transcript header and remembered between sessions. The alignment search
  window and the scroll drift both scale with the rate, so raising the speed
  does not degrade sync.
- **Time remaining** for the playing audio, shown on the right of the
  transcript header (blank for live streams with no finite duration).
- **App version** is shown in Settings.
- **Diagnostics panel is now a Settings toggle** instead of a toolbar button,
  and it carries the pipeline status and paragraph count.

### Changed
- **Toolbar reduced to Browser · Transcript · Settings, with Fullscreen alone
  on the right.** Pause/Resume, zoom, speed, time remaining and the pipeline
  state dot moved into the transcript header, which is now always visible —
  including in fullscreen, where the toolbar is hidden.
- **Load PDF button removed.** Transcripts load from the site's own
  "Load Transcript" link; the app opens on the Browser tab when nothing is
  loaded.
- **"Window expansion rate" rescaled x10.** The old 0.1 now reads as 1, with a
  0.1–20 range for finer tuning. Existing settings are migrated automatically
  and behaviour is unchanged.

### Fixed
- **Pausing no longer restarts the audio pipeline.** Previously every stop tore
  down FFmpeg and the Whisper worker; resuming re-enumerated audio devices,
  reloaded the speech model and discarded up to 8 seconds of buffered audio.
  Both processes now stay warm and the chunk feed is simply gated, with a
  5-minute idle timer reclaiming them. Scrubbing no longer costs a
  transcription.
- **Fixed a race in audio capture** where a stop arriving during device
  enumeration was ignored, leaving an orphaned FFmpeg process holding the
  audio device.
- Resume now works when the audio was paused from the site's own player
  controls rather than from the app.
- **Pages with more than one recording now follow the player you actually
  started.** Every player on a page reports a duration up front
  (`preload="metadata"`), so selecting "the first one with a duration" always
  bound Pause, speed and time remaining to the first reading no matter which
  was playing. Selection is now ranked on live playback state and a
  most-recently-started marker. Pausing the second reading while the first is
  still running also no longer stops transcription.
- Audio-capture setup failures ("No audio captured — check FFmpeg setup") stay
  visible in the transcript header instead of disappearing, and Whisper's cold
  start (~30s, or a ~500 MB first-run download) is now reported rather than
  looking like nothing happening.

### Internal
- First test suite: 28 cases over the alignment engine, unit building, the
  settings migration and the renderer helpers. Run with `npm test` (no new
  dependencies — uses Node's built-in test runner).
