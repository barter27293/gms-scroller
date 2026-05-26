# CLAUDE.md — TranscriptSync

## Project Overview

Electron desktop app that embeds an audio website in a webview and auto-scrolls a loaded PDF transcript using real-time speech-to-text alignment. Personal use tool.

## Tech Stack

- **Electron** (latest stable) — app shell
- **Vanilla JS / HTML / CSS** — renderer UI
- **pdf-parse** — PDF text extraction (Node.js)
- **fuse.js** — fuzzy text matching
- **electron-store** — config persistence
- **FFmpeg** — system audio capture (WASAPI loopback, Windows)
- **Python + faster-whisper** — local speech-to-text (subprocess)

## Project Structure

```
transcriptsync/
├── main.js                  # Main process: IPC, audio, whisper, alignment
├── preload.js               # contextBridge API exposed to renderer
├── package.json
├── renderer/
│   ├── index.html           # App shell
│   ├── styles.css           # All styles
│   └── renderer.js          # UI logic
├── src/
│   ├── AudioCapture.js      # FFmpeg WASAPI loopback
│   ├── WhisperBridge.js     # Python child process
│   ├── AlignmentEngine.js   # Fuzzy match + position tracking
│   └── PdfParser.js         # pdf-parse wrapper
└── python/
    └── whisper_worker.py    # faster-whisper stdin/stdout worker
```

## Environment Setup

### Node dependencies
```bash
npm install electron pdf-parse fuse.js electron-store
npm install --save-dev electron-builder
```

### Python dependencies
```bash
pip install faster-whisper
```

### System requirements
- FFmpeg installed and on PATH (`winget install ffmpeg`)
- Python 3.10+ on PATH
- Windows (WASAPI loopback); Linux/Mac requires different audio capture

## Key Implementation Details

### IPC Channels (main ↔ renderer via preload)

| Channel | Direction | Payload |
|---|---|---|
| `pdf:load` | renderer → main | file path string |
| `pdf:loaded` | main → renderer | `{ paragraphs: string[] }` |
| `listen:start` | renderer → main | — |
| `listen:stop` | renderer → main | — |
| `position:update` | main → renderer | `{ index: number }` |
| `status:update` | main → renderer | `{ message: string, state: 'idle'|'listening'|'synced'|'lost' }` |

### AlignmentEngine

- Holds `paragraphs: string[]` and `current: number` (current paragraph index)
- On each STT result, fuzzy-search a forward window of 20 paragraphs from `current`
- Only advance `current` — never go backward unless user triggers manual re-sync
- Threshold: 0.35 (fuse.js — lower is stricter)
- Emit `position:update` when current changes

### AudioCapture

FFmpeg command:
```
ffmpeg -f wasapi -loopback -i default -ar 16000 -ac 1 -f s16le pipe:1
```
- Spawn as child process, pipe stdout to Node readable stream
- Buffer 8 seconds (16000 * 8 * 2 bytes = 256000 bytes per chunk)
- Keep last 2 seconds of each chunk as prefix for next chunk (overlap)
- Emit `chunk` event with Buffer

### WhisperBridge

- Spawn `python python/whisper_worker.py` as child process
- Write PCM Buffer chunks to stdin
- Read lines from stdout as transcribed text strings
- Emit `transcription` event with text string

### PdfParser

- Use `pdf-parse` npm package
- Extract `.text` field, split on double newlines or large whitespace gaps
- Clean each paragraph: trim, collapse internal whitespace
- Filter out very short strings (< 10 chars) — likely page numbers/headers
- Return `string[]`

### TranscriptPane (renderer)

- Render paragraphs as `<p data-index="N">` elements
- On `position:update`: 
  - Remove `.active` class from previous paragraph
  - Add `.active` class to `paragraph[index]`
  - Call `paragraph[index].scrollIntoView({ behavior: 'smooth', block: 'center' })`
- If user manually scrolls: set `userScrolling = true`, `setTimeout` 3s to reset
- While `userScrolling`, skip auto-scroll but still update `.active` class

### Webview

```html
<webview 
  id="audioSite" 
  src="https://TARGET_SITE_URL" 
  partition="persist:audiosession"
  webpreferences="contextIsolation=yes">
</webview>
```
- `partition="persist:audiosession"` ensures cookies/login persists between sessions
- Set `TARGET_SITE_URL` from electron-store config

## Configuration (electron-store)

```json
{
  "audioSiteUrl": "https://example.com/audio",
  "whisperModel": "small",
  "chunkSeconds": 8,
  "overlapSeconds": 2,
  "fuseThreshold": 0.35,
  "highlightColour": "#fff3cd",
  "autoScrollResumeDelay": 3000
}
```

## Build & Run

```bash
# Development
npm start

# Package (Windows)
npm run build
```

## Known Constraints

- Windows-only in v1 (WASAPI loopback)
- FFmpeg, Python + faster-whisper must be installed separately (document in README)
- First run of Whisper downloads model (~500MB for small) — show progress to user
- If audio site blocks iframes/webviews, user may need to use `--disable-web-security` flag (dev only) or the site may need to be contacted

## Out of Scope (v1)

- Timestamps in transcript
- Speaker identification
- Session position persistence
- macOS/Linux audio capture
- Installer with bundled dependencies
