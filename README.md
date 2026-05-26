# TranscriptSync

Electron desktop app that embeds an audio website (default: `https://globalmediastream.com/`) and auto-scrolls a loaded PDF transcript using real-time speech-to-text alignment via `faster-whisper`.

Personal use. Windows-only in v1 (uses FFmpeg loopback for system audio capture).

---

## Prerequisites

| Dependency | Why | Install |
|---|---|---|
| Node.js 18+ | Electron runtime | https://nodejs.org |
| Python 3.10+ | faster-whisper subprocess | https://python.org |
| FFmpeg | System audio loopback capture | `winget install ffmpeg` |
| faster-whisper | STT engine | `pip install faster-whisper` |

Verify each is on PATH:

```powershell
node --version
python --version
ffmpeg -version
```

---

## Install

```powershell
npm install
pip install faster-whisper
```

First run of the listener downloads the Whisper `small` model (~500 MB). The status bar will show "Loading model…".

---

## Run

```powershell
npm start
```

1. Click **Load PDF** and pick a transcript.
2. Sign in to the audio site in the right-hand pane (session persists across restarts).
3. Click **● Listen** — start audio playback on the site. The active paragraph in the transcript will highlight and scroll into view.
4. Click any paragraph to manually re-sync the position.
5. Scroll the transcript manually — auto-scroll pauses for 3 s then resumes.

---

## Package (Windows installer)

```powershell
npm run build
```

Output lands in `dist/`.

---

## Audio capture setup (Windows)

The app needs a way to capture **system audio output** (what your speakers/headphones are playing) — not microphone input. On Windows, mainline FFmpeg cannot do this directly, so you need to install one of these:

### Option A — screen-capture-recorder (recommended, easiest)

Provides a virtual DirectShow device called `virtual-audio-capturer` that captures system audio. Free.

- Download from https://github.com/rdp/screen-capture-recorder-to-video-windows-free
- Or via Chocolatey: `choco install screen-capture-recorder`

After install, no config needed — `AudioCapture` auto-detects it.

### Option B — Enable Windows Stereo Mix (if available)

Some sound card drivers expose a "Stereo Mix" loopback device that's disabled by default.

1. Right-click the speaker icon in the taskbar → **Open Sound settings**
2. Scroll down → **More sound settings** → **Recording** tab
3. Right-click an empty area → **Show Disabled Devices**
4. If **Stereo Mix** appears, right-click it → **Enable**

If Stereo Mix isn't listed, your driver doesn't expose it — use Option A or C.

### Option C — VB-Audio Cable

Virtual audio cable. Route playback through it so FFmpeg can capture from `Cable Output`.

1. Download from https://vb-audio.com/Cable/
2. Install
3. Set **Cable Input** as your default playback device in Windows Sound settings
4. Audio from the embedded site will route through Cable, and FFmpeg captures from Cable Output

Downside: while Cable is your default playback, you won't hear the audio directly — you'd need to monitor it via the cable's listen-to feature.

### How the app picks a device

On `● Listen`, `AudioCapture` enumerates available DirectShow audio devices via `ffmpeg -list_devices true -f dshow -i dummy` and picks the first one matching this priority:

1. `virtual-audio-capturer` (screen-capture-recorder)
2. `Stereo Mix`
3. `What U Hear` (Creative Sound Blaster)
4. `Wave Out Mix` (older Realtek)
5. anything containing `loopback`
6. `Cable Output` (VB-Audio Cable)
7. anything containing `vb-audio`

If none match, an error is shown listing what was found so you can see what your machine has.

---

## Config

Configuration lives in `electron-store` (user data dir, JSON). Defaults:

```json
{
  "audioSiteUrl": "https://globalmediastream.com/",
  "whisperModel": "small",
  "chunkSeconds": 8,
  "overlapSeconds": 2,
  "fuseThreshold": 0.35,
  "highlightColour": "#fff3cd",
  "autoScrollResumeDelay": 3000
}
```

To override, edit `%APPDATA%/transcriptsync/config.json` while the app is closed.

---

## Project structure

```
transcriptsync/
├── main.js               # Electron main process: IPC, pipeline wiring
├── preload.js            # contextBridge API to renderer
├── package.json
├── renderer/             # UI: split pane, transcript, webview, toolbar
│   ├── index.html
│   ├── styles.css
│   └── renderer.js
├── src/                  # Main-process modules
│   ├── PdfParser.js      # pdfjs-dist wrapper + speaker extraction
│   ├── AudioCapture.js   # FFmpeg WASAPI + dshow fallback
│   ├── WhisperBridge.js  # Python subprocess manager
│   └── AlignmentEngine.js# Fuse.js fuzzy match, forward-only position
└── python/
    └── whisper_worker.py # faster-whisper stdin/stdout worker
```

Architecture details: see `ARCHITECTURE.md`. Product spec: see `PRD.md`.
