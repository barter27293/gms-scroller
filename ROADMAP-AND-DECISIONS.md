# TranscriptSync — Roadmap & Decisions Log

## Build Roadmap

### Phase 1 — Scaffold & PDF (Day 1)
- [ ] Electron app scaffold (`npm init electron-app`)
- [ ] Split-pane layout (transcript left, webview right)
- [ ] PDF file picker + pdf-parse integration
- [ ] Render paragraphs in TranscriptPane
- [ ] Toolbar with Load PDF button

### Phase 2 — Webview (Day 1–2)
- [ ] Add `<webview>` with persistent session partition
- [ ] Load target site URL from config
- [ ] Confirm login persists between app restarts
- [ ] Confirm audio plays through system audio

### Phase 3 — Audio Capture (Day 2)
- [ ] AudioCapture.js with FFmpeg WASAPI loopback
- [ ] Verify PCM chunks are being produced (log buffer sizes)
- [ ] Implement chunk buffering with overlap

### Phase 4 — Whisper STT (Day 2–3)
- [ ] Write `whisper_worker.py`
- [ ] WhisperBridge.js — spawn Python, read stdout
- [ ] Test with pre-recorded audio file first
- [ ] Connect AudioCapture → WhisperBridge pipeline
- [ ] Log transcription output to console

### Phase 5 — Alignment (Day 3)
- [ ] AlignmentEngine.js with fuse.js
- [ ] Unit test matching with sample STT output vs paragraphs
- [ ] Tune threshold and window size
- [ ] Emit position updates

### Phase 6 — Auto-Scroll & Polish (Day 3–4)
- [ ] Wire position updates to TranscriptPane scroll
- [ ] Highlight active paragraph
- [ ] Manual scroll detection + resume timer
- [ ] Status indicator in toolbar
- [ ] Settings screen (or config file for now)

### Phase 7 — Testing & Packaging (Day 4–5)
- [ ] Full end-to-end test with real audio + PDF
- [ ] Handle edge cases (no match, end of document, very short paragraphs)
- [ ] README with prerequisite setup instructions
- [ ] electron-builder package for Windows

---

## Decisions Log

### Why Electron over Python desktop (PyQt)?
- Electron's `<webview>` tag is the most reliable way to embed a full browser session with login persistence
- PyQt's `QWebEngineView` works but is heavier to set up and the ecosystem for this use case is smaller
- JavaScript/Node.js is the natural fit for Electron + PDF.js ecosystem
- Python is still used (Whisper subprocess) where it's clearly the best tool

### Why faster-whisper over Web Speech API?
- Web Speech API sends audio to Google servers — privacy concern for potentially sensitive recordings
- faster-whisper runs entirely locally, offline
- Accuracy is significantly better, especially for multi-speaker or accented speech
- Latency with small/int8 model on CPU is acceptable for 8s chunks

### Why FFmpeg for audio capture vs Node native addon?
- FFmpeg WASAPI loopback is well-documented and reliable on Windows
- Avoids native Node.js addon compilation issues
- Pre-installed on most developer machines; easy install otherwise
- Gives fine control over sample rate / format conversion

### Why fuzzy matching vs forced alignment (e.g. aeneas, WhisperX)?
- Forced alignment tools require timestamp data or full-file processing upfront
- The transcript has no timestamps; pre-processing the whole audio isn't practical for a live stream
- Real-time fuzzy matching is simpler, lower latency, and good enough for paragraph-level sync
- WhisperX could be explored in v2 if accuracy needs improving

### Why forward-only window in alignment?
- Prevents the engine jumping to an earlier paragraph when STT makes an error that matches earlier text
- Audio always plays forward; there's no valid reason to jump backward during normal playback
- Manual re-sync option covers the edge case where user rewinds audio

### PDF rendering approach (text extraction vs PDF.js visual render)?
- Visual render (PDF.js) would render the PDF as-is but scrolling programmatically to a paragraph position is difficult
- Text extraction lets us have full control over scroll position and highlighting
- Downside: layout/formatting is lost; acceptable since we only need readable paragraphs
