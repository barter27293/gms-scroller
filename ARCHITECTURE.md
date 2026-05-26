# TranscriptSync — Technical Architecture

## Stack Decision

| Layer | Choice | Reason |
|---|---|---|
| App shell | **Electron** | Cross-platform desktop; embeds Chromium webview; Node.js backend; can access system audio |
| Frontend | **HTML/CSS/Vanilla JS** (in renderer) | No framework needed for this UI complexity |
| PDF parsing | **pdf-parse** (Node) or **pdfplumber** (Python) | Text extraction from PDF; not image rendering |
| System audio | **FFmpeg** (WASAPI loopback, Windows) | Reliable loopback capture; cross-platform options exist |
| STT engine | **faster-whisper** (Python subprocess) | Best local STT accuracy; runs offline; small model fits real-time |
| Text matching | **fuse.js** (JS) or **rapidfuzz** (Python) | Fuzzy string matching for STT-to-transcript alignment |
| Config storage | **electron-store** | Simple persistent config in JSON |
| Webview | **Electron `<webview>` tag** | Embeds target site with persistent session |

---

## Component Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  ELECTRON MAIN PROCESS (Node.js)                                │
│                                                                 │
│  ┌──────────────────┐   ┌─────────────────────────────────┐    │
│  │  AudioCapture    │   │  WhisperBridge                  │    │
│  │  (FFmpeg child)  │──▶│  (Python faster-whisper child)  │    │
│  │  WASAPI loopback │   │  Chunk → transcribed text       │    │
│  └──────────────────┘   └────────────────┬────────────────┘    │
│                                          │                      │
│  ┌───────────────────────────────────────▼────────────────┐    │
│  │  AlignmentEngine                                        │    │
│  │  - Maintains paragraph list from parsed PDF             │    │
│  │  - Sliding window fuzzy match (fuse.js / rapidfuzz)    │    │
│  │  - Tracks current paragraph index                       │    │
│  │  - Emits `position-update` event to renderer            │    │
│  └───────────────────────────────────────┬────────────────┘    │
│                                          │ IPC                  │
└──────────────────────────────────────────┼─────────────────────┘
                                           │
┌──────────────────────────────────────────▼─────────────────────┐
│  ELECTRON RENDERER PROCESS (Chromium)                           │
│                                                                 │
│  ┌──────────────────────────┐  ┌──────────────────────────┐    │
│  │  TranscriptPane          │  │  AudioSiteWebview        │    │
│  │  - Renders paragraphs    │  │  - <webview> tag         │    │
│  │  - Auto-scroll to index  │  │  - Persistent session    │    │
│  │  - Highlights active ¶   │  │  - Target site URL       │    │
│  └──────────────────────────┘  └──────────────────────────┘    │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Toolbar: [Load PDF] [Listen ●] [Pause] [Status]         │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Data Flow

```
1. User loads PDF
   → main process calls pdf-parse
   → extracts ordered array of paragraph strings
   → sends to renderer (TranscriptPane) + AlignmentEngine

2. User clicks [Listen]
   → main spawns FFmpeg (WASAPI loopback) → raw PCM stream
   → chunks PCM into N-second segments with overlap
   → pipes each chunk to WhisperBridge (Python subprocess stdin)
   → Whisper returns transcribed text string

3. AlignmentEngine receives transcribed text
   → fuzzy matches against paragraphs[currentIndex .. currentIndex+20]
   → if match score > threshold: advance currentIndex to best match
   → emits { index: N } via IPC to renderer

4. Renderer receives position update
   → highlights paragraph[N]
   → smoothly scrolls paragraph[N] into view
```

---

## Key Files / Project Structure

```
transcriptsync/
├── package.json
├── main.js                  # Electron main process entry
├── preload.js               # IPC bridge (contextBridge)
├── renderer/
│   ├── index.html
│   ├── styles.css
│   └── renderer.js          # UI logic, scroll, highlight
├── src/
│   ├── AudioCapture.js      # FFmpeg WASAPI loopback wrapper
│   ├── WhisperBridge.js     # Python subprocess manager
│   ├── AlignmentEngine.js   # Fuzzy match + position tracking
│   └── PdfParser.js         # pdf-parse wrapper
├── python/
│   └── whisper_worker.py    # faster-whisper stdin→stdout worker
└── config/
    └── settings.json        # electron-store managed
```

---

## Audio Capture Detail (Windows)

FFmpeg command for WASAPI loopback:
```bash
ffmpeg -f wasapi -loopback -i default -ar 16000 -ac 1 -f s16le pipe:1
```
- `-loopback` captures system output (what's playing)
- `-ar 16000` 16kHz mono — Whisper's expected format
- `-f s16le pipe:1` raw PCM to stdout → Node.js readable stream

Chunk strategy:
- Buffer 8 seconds of PCM
- Emit chunk, then start next buffer but keep last 2 seconds (overlap)
- This avoids words being split at chunk boundaries

---

## Whisper Worker (Python)

```python
# python/whisper_worker.py
# Reads raw PCM chunks from stdin, outputs transcribed text to stdout
from faster_whisper import WhisperModel
import sys, struct, numpy as np

model = WhisperModel("small", device="cpu", compute_type="int8")

SAMPLE_RATE = 16000
CHUNK_SECONDS = 8

while True:
    raw = sys.stdin.buffer.read(SAMPLE_RATE * CHUNK_SECONDS * 2)  # 16-bit = 2 bytes
    if not raw:
        break
    audio = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    segments, _ = model.transcribe(audio, language="en")
    text = " ".join(s.text for s in segments)
    sys.stdout.write(text + "\n")
    sys.stdout.flush()
```

---

## Fuzzy Matching Strategy

```javascript
// AlignmentEngine.js (simplified)
const Fuse = require('fuse.js');

// Window: only look N paragraphs ahead from current position
const WINDOW = 20;
const THRESHOLD = 0.35; // lower = stricter

match(sttText) {
  const window = this.paragraphs.slice(this.current, this.current + WINDOW);
  const fuse = new Fuse(window, { includeScore: true, threshold: THRESHOLD });
  const results = fuse.search(sttText);
  if (results.length > 0) {
    this.current += results[0].refIndex;
    this.emit('position-update', this.current);
  }
}
```

The forward-only window prevents the engine jumping backward when STT makes an error.

---

## Prerequisites (User Machine)

| Dependency | Purpose | Install |
|---|---|---|
| FFmpeg | System audio capture | `winget install ffmpeg` |
| Python 3.10+ | Whisper worker | python.org |
| faster-whisper | STT | `pip install faster-whisper` |
| Node.js 18+ | Electron runtime | nodejs.org |

---

## Risks & Mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| STT drift over long sessions | Medium | Re-anchor on clear speaker initial match; allow manual paragraph click to re-sync |
| WASAPI not capturing browser audio | Low | Test early; fallback: VB-Cable virtual audio device |
| Whisper too slow for real-time | Low | Use `small` model + `int8` quantisation on CPU; 8s chunks give enough processing time |
| Webview login session lost | Low | Electron persists cookies in user data dir by default |
| PDF with complex layout confuses parser | Medium | Pre-process: strip page numbers, headers; manual review before loading |
