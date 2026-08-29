// pdfjs-dist emits its own warnings via console.log with a "Warning: " prefix
// (not console.warn or process.emitWarning). Intercept and drop the noisy
// "Cannot polyfill DOMMatrix/Path2D" (require('canvas') optional dep) and
// "fetchStandardFontData" (font data missing — not needed for text extraction)
// messages BEFORE pdfjs-dist is loaded by PdfParser.
const _origConsoleLog = console.log;
console.log = (...args) => {
  const first = args[0];
  if (
    typeof first === 'string' &&
    first.startsWith('Warning:') &&
    (/Cannot polyfill `(DOMMatrix|Path2D|ImageData)`/.test(first) ||
      /fetchStandardFontData/.test(first))
  ) {
    return;
  }
  _origConsoleLog.apply(console, args);
};

const { app, BrowserWindow, Menu, ipcMain, dialog, safeStorage, session } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const Store = require('electron-store');

const PdfParser = require('./src/PdfParser');
const { AudioCapture } = require('./src/AudioCapture');
const { WhisperBridge } = require('./src/WhisperBridge');
const { AlignmentEngine } = require('./src/AlignmentEngine');
const { initAutoUpdater, downloadUpdate, quitAndInstall } = require('./src/Updater');
const Paths = require('./src/Paths');
const Settings = require('./src/settings');
const { buildUnits } = require('./src/buildUnits');
const FileLog = require('./src/FileLog');

// Tee console output into <userData>/logs/main.log — packaged builds have no
// console, so this is the only way to diagnose failures in installed copies.
FileLog.init(path.join(app.getPath('userData'), 'logs'));

const DEFAULTS = {
  audioSiteUrl: 'https://globalmediastream.com/',
  whisperModel: 'small',
  chunkSeconds: 8,
  overlapSeconds: 2,
  fuseThreshold: 0.35,
  highlightColour: '#fff3cd',
  autoScrollResumeDelay: 3000,
  showMatchDetails: true,
  // Advanced — tuning previously hardcoded in source.
  verboseLogging: false,
  showDiagnostics: false,
  // NOTE: `alignmentParagraphsPerSecond` is deliberately ABSENT. `conf` merges
  // and persists the defaults object on construction, so any key listed here
  // reads back as a real value forever — absence would stop being a signal and
  // the migration below could not tell "never set" from "set to the default".
  windowExpansionRate: Settings.EXPANSION_DEFAULT,
  scrollGain: 0.35,
  scrollMaxVelocity: 90,
  scrollBaselineVelocity: 8,
};

const store = new Store({ defaults: DEFAULTS });

// One-shot rescale of the window expansion rate (×10). The legacy key was
// tuned in a range where useful values clustered near the 0.1 floor; the new
// scale puts the working value at 1. Behaviour-preserving: the engine still
// receives `windowExpansionRate / 10`.
if (store.get('settingsScaleVersion') !== 2) {
  const migrated = Settings.migrateExpansionRate(store.get('alignmentParagraphsPerSecond'));
  if (migrated !== null) {
    console.log(`[Settings] migrating alignmentParagraphsPerSecond=${store.get('alignmentParagraphsPerSecond')} -> windowExpansionRate=${migrated}`);
    store.set('windowExpansionRate', migrated);
  }
  store.set('settingsScaleVersion', 2);
}

let mainWindow = null;
let audio = null;
let whisper = null;
let alignment = null;
let watchdogTimer = null;

// ---- Media-driven capture gating ----
// Auto-listen is driven by the webview's media events. Pausing must NOT tear
// the pipeline down: AudioCapture.start() spawns a throwaway ffmpeg to
// enumerate dshow devices (1–3s) and needs 8s of PCM before its first chunk,
// so restart-per-pause would cost a transcription every time you scrub.
// Instead the chunk handler is gated on `capturing`, and a 5-minute idle
// reaper reclaims both processes if playback never resumes.
let capturing = false;
let idleReaperTimer = null;
let playbackRate = 1;
const IDLE_REAP_MS = 5 * 60 * 1000;

function sendStatus(message, state) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('status:update', { message, state });
  }
}

// ---- Diagnostics state (surfaced in the renderer's diagnostics panel) ----
const diag = {
  audioDevice: null,
  chunks: 0,
  transcriptions: 0,
  lastText: null,
  lastMatch: null,
  whisperState: 'not started',
};

function diagSnapshot(includeLog) {
  const snap = {
    ...diag,
    ffmpegPath: Paths.ffmpegCmd(app.isPackaged),
    pythonPath: Paths.pythonCmd(app.isPackaged),
    logPath: FileLog.getLogPath(),
  };
  if (includeLog) snap.recentLog = FileLog.getRecentLines().slice(-60);
  return snap;
}

function sendDiag() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('diag:update', diagSnapshot(false));
  }
}

async function loadPdfFromPath(filePath) {
  try {
    sendStatus('Parsing PDF…', 'idle');
    const result = await PdfParser.parse(filePath, {
      verbose: store.get('verboseLogging') === true,
    });
    const { title = null, paragraphs } = Array.isArray(result)
      ? { title: null, paragraphs: result }
      : result;
    const units = buildUnits(paragraphs);
    // Renderer must rebuild the DOM before the position-update from
    // setUnits arrives — IPC messages are delivered in send order.
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pdf:loaded', { title, paragraphs, units });
    }
    if (alignment) alignment.setUnits(units);
    const speakerCount = paragraphs.filter((p) => p.speaker).length;
    console.log(`[Pdf] ${paragraphs.length} paragraphs -> ${units.length} alignment units`);
    sendStatus(`Loaded ${paragraphs.length} paragraphs (${speakerCount} attributed)`, 'idle');
    return { ok: true, count: paragraphs.length };
  } catch (err) {
    sendStatus(`PDF load failed: ${err.message}`, 'lost');
    return { ok: false, error: err.message };
  }
}

// Hook the audio-site session so PDF downloads land straight in the
// transcript pane instead of spawning a blank popup + save dialog.
function attachWebviewDownloadHandler() {
  const sess = session.fromPartition('persist:audiosession');

  sess.on('will-download', (event, item) => {
    const url = item.getURL() || '';
    const mime = item.getMimeType() || '';
    const isPdf =
      /\.pdf(\?|$)/i.test(url) ||
      mime === 'application/pdf' ||
      /\.pdf$/i.test(item.getFilename() || '');

    if (!isPdf) return; // leave non-PDF downloads to the default flow

    const tmpPath = path.join(os.tmpdir(), `gms-scroller-${Date.now()}.pdf`);
    item.setSavePath(tmpPath);
    sendStatus('Downloading transcript PDF…', 'idle');

    item.once('done', async (_evt, state) => {
      if (state !== 'completed') {
        sendStatus(`PDF download ${state}`, 'lost');
        return;
      }
      await loadPdfFromPath(tmpPath);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('tab:activate', 'transcript');
      }
      // best-effort cleanup
      fs.unlink(tmpPath, () => {});
    });
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: '#1e1e1e',
    title: 'GMS Scroller',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
      devTools: !app.isPackaged,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Renderer warnings/errors are invisible in packaged builds (no devtools) —
  // forward them into the main console/log file.
  mainWindow.webContents.on('console-message', (_evt, level, message, line, sourceId) => {
    if (level >= 2) {
      console.warn(`[Renderer] ${message} (${path.basename(sourceId || '')}:${line})`);
    }
  });

  // F11 toggles OS fullscreen.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') {
      mainWindow.setFullScreen(!mainWindow.isFullScreen());
      event.preventDefault();
    }
  });

  const emitFullScreen = (isFull) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window:fullscreen-changed', isFull);
    }
  };
  mainWindow.on('enter-full-screen', () => emitFullScreen(true));
  mainWindow.on('leave-full-screen', () => emitFullScreen(false));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function initPipeline() {
  alignment = new AlignmentEngine({
    threshold: store.get('fuseThreshold'),
    unitsPerSecond: Settings.effectiveUnitsPerSecond(store.get('windowExpansionRate'), playbackRate),
  });
  alignment.on('position-update', (payload) => {
    console.log(
      `[Alignment] position-update -> unit #${payload.index} (para ${payload.para}, sentences ${payload.sentStart}–${payload.sentEnd})`
    );
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('position:update', payload);
    }
  });
  // Every match attempt (hit or miss) drives the match-visibility UI.
  alignment.on('attempt', (payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('match:state', payload);
    }
    const win = payload.window ? `${payload.window.from}–${payload.window.to}` : '—';
    diag.lastMatch = payload.matched
      ? `unit #${payload.index}, score ${payload.score.toFixed(3)} (window ${win}${payload.window && payload.window.recovery ? ', recovery' : ''})`
      : `no match (window ${win})`;
    sendDiag();
  });
  alignment.on('no-match', (text) => {
    console.log(`[Alignment] no match for: "${(text || '').slice(0, 80)}"`);
    sendStatus('Listening — no match yet', 'lost');
  });
  alignment.on('info', (msg) => {
    console.log(`[Alignment] ${msg}`);
  });
}

function startListening() {
  if (audio || whisper) return;

  if (alignment && alignment.units.length === 0) {
    console.warn('[Pipeline] Listen clicked but no PDF loaded — alignment will produce no matches.');
    sendStatus('Load a PDF first', 'lost');
    return;
  }

  console.log('[Pipeline] === Listen started ===');
  console.log(`[Pipeline] config: chunkSeconds=${store.get('chunkSeconds')} overlapSeconds=${store.get('overlapSeconds')} model=${store.get('whisperModel')} fuseThreshold=${store.get('fuseThreshold')}`);

  audio = new AudioCapture({
    chunkSeconds: store.get('chunkSeconds'),
    overlapSeconds: store.get('overlapSeconds'),
    ffmpegCmd: Paths.ffmpegCmd(app.isPackaged),
  });
  // The worker script must resolve OUTSIDE app.asar in packaged builds —
  // python.exe cannot read files inside the asar archive.
  whisper = new WhisperBridge({
    model: store.get('whisperModel'),
    workerPath: Paths.whisperWorkerPath(app.isPackaged),
    pythonCmd: Paths.pythonCmd(app.isPackaged),
  });
  console.log(`[Pipeline] ffmpeg=${Paths.ffmpegCmd(app.isPackaged)} python=${Paths.pythonCmd(app.isPackaged)} worker=${Paths.whisperWorkerPath(app.isPackaged)}`);

  let chunkCount = 0;
  let transcriptionCount = 0;
  const startedAt = Date.now();

  diag.audioDevice = null;
  diag.chunks = 0;
  diag.transcriptions = 0;
  diag.lastText = null;
  diag.lastMatch = null;
  diag.whisperState = 'starting…';
  sendDiag();

  if (watchdogTimer) clearInterval(watchdogTimer);
  watchdogTimer = setInterval(() => {
    if (!audio) return;
    // Only judge the pipeline while we are actually feeding Whisper — a long
    // pause would otherwise trip the "chunks but no transcriptions" warning.
    if (!capturing) return;
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    if (chunkCount === 0 && elapsed >= 15) {
      console.warn(`[Pipeline] WARNING: ${elapsed}s elapsed and zero audio chunks received.`);
      console.warn('[Pipeline] FFmpeg is not capturing system audio. Most common cause on Windows:');
      console.warn('[Pipeline]   - mainline FFmpeg does not support -f wasapi -loopback');
      console.warn('[Pipeline]   - dshow fallback needs "virtual-audio-capturer" (install screen-capture-recorder)');
      console.warn('[Pipeline]   - or route audio via VB-Audio Cable and edit src/AudioCapture.js');
      sendStatus('No audio captured — check FFmpeg setup (see console)', 'lost');
      clearInterval(watchdogTimer);
      watchdogTimer = null;
    } else if (chunkCount > 0 && transcriptionCount === 0 && elapsed >= 30) {
      console.warn(`[Pipeline] WARNING: ${chunkCount} chunks received but zero transcriptions after ${elapsed}s. Whisper may be stuck loading the model or hitting an error.`);
      clearInterval(watchdogTimer);
      watchdogTimer = null;
    }
  }, 5000);

  audio.on('chunk', (buf) => {
    chunkCount++;
    diag.chunks = chunkCount;
    if (chunkCount === 1 || chunkCount % 5 === 0) {
      console.log(`[Audio] chunk #${chunkCount} (${buf.length} bytes)`);
      sendDiag();
    }
    // Gate, do not tear down. See the `capturing` comment near the top.
    if (capturing && whisper) whisper.send(buf);
  });
  audio.on('info', (msg) => {
    console.log(`[Audio] ${msg}`);
    const deviceM = msg.match(/^Using audio device: "(.+)"$/);
    if (deviceM) {
      diag.audioDevice = deviceM[1];
      sendDiag();
    }
    sendStatus(msg, 'listening');
  });
  audio.on('error', (err) => {
    console.error(`[Audio] ERROR: ${err.message}`);
    sendStatus(`Audio error: ${err.message}`, 'lost');
    stopListening();
  });

  whisper.on('transcription', (text) => {
    transcriptionCount++;
    diag.transcriptions = transcriptionCount;
    diag.lastText = text;
    diag.whisperState = 'transcribing';
    console.log(`[Whisper] #${transcriptionCount}: "${text}"`);
    if (alignment) alignment.match(text);
    sendStatus('Synced', 'synced');
  });
  whisper.on('info', (msg) => {
    console.log(`[Whisper] ${msg}`);
    if (/loading/i.test(msg)) diag.whisperState = 'loading model…';
    else if (/model ready/i.test(msg)) diag.whisperState = 'ready';
    if (msg.toLowerCase().includes('error')) {
      diag.whisperState = `error: ${msg.slice(0, 120)}`;
      sendStatus(msg, 'lost');
    }
    sendDiag();
  });
  whisper.on('error', (err) => {
    console.error(`[Whisper] ERROR: ${err.message}`);
    sendStatus(`Whisper error: ${err.message}`, 'lost');
    stopListening();
  });

  whisper.start();
  audio.start();
  sendStatus('Listening…', 'listening');
}

function stopListening() {
  cancelIdleReaper();
  capturing = false;
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
  if (audio) {
    audio.removeAllListeners();
    audio.stop();
    audio = null;
  }
  if (whisper) {
    whisper.removeAllListeners();
    whisper.stop();
    whisper = null;
  }
  console.log('[Pipeline] === Listen stopped ===');
  sendStatus('Idle', 'idle');
}

function cancelIdleReaper() {
  if (idleReaperTimer) {
    clearTimeout(idleReaperTimer);
    idleReaperTimer = null;
  }
}

function startIdleReaper() {
  cancelIdleReaper();
  idleReaperTimer = setTimeout(() => {
    idleReaperTimer = null;
    if (capturing) return; // resumed under us
    console.log('[Pipeline] idle for 5 min — reclaiming ffmpeg + whisper');
    stopListening();
  }, IDLE_REAP_MS);
}

// Single entry point for webview media state. The renderer owns the events;
// main owns process lifecycle.
function setMediaPlaying(playing) {
  if (playing) {
    cancelIdleReaper();
    capturing = true;
    if (!audio && !whisper) {
      startListening();
    } else {
      sendStatus('Listening…', 'listening');
    }
  } else {
    if (!capturing) return;
    capturing = false;
    console.log('[Pipeline] media paused — gating chunks, pipeline stays warm');
    sendStatus('Paused', 'idle');
    startIdleReaper();
  }
}

function applyPlaybackRate(rate) {
  const n = Number(rate);
  playbackRate = Number.isFinite(n) && n > 0 ? n : 1;
  if (alignment) {
    alignment.setUnitsPerSecond(
      Settings.effectiveUnitsPerSecond(store.get('windowExpansionRate'), playbackRate)
    );
  }
}

function registerIpc() {
  ipcMain.handle('config:get', () => ({
    audioSiteUrl: store.get('audioSiteUrl'),
    highlightColour: store.get('highlightColour'),
    autoScrollResumeDelay: store.get('autoScrollResumeDelay'),
    scrollGain: store.get('scrollGain'),
    scrollMaxVelocity: store.get('scrollMaxVelocity'),
    scrollBaselineVelocity: store.get('scrollBaselineVelocity'),
    showMatchDetails: store.get('showMatchDetails'),
    // init() reads config:get, not settings:get — keeping showDiagnostics here
    // saves a second IPC round trip on every startup.
    showDiagnostics: store.get('showDiagnostics'),
  }));

  ipcMain.handle('settings:get', () => ({
    whisperModel: store.get('whisperModel'),
    showMatchDetails: store.get('showMatchDetails'),
    fuseThreshold: store.get('fuseThreshold'),
    windowExpansionRate: store.get('windowExpansionRate'),
    showDiagnostics: store.get('showDiagnostics'),
    scrollGain: store.get('scrollGain'),
    scrollMaxVelocity: store.get('scrollMaxVelocity'),
    scrollBaselineVelocity: store.get('scrollBaselineVelocity'),
    verboseLogging: store.get('verboseLogging'),
  }));

  ipcMain.handle('settings:save', (_, payload) => {
    if (!payload || typeof payload !== 'object') {
      return { ok: false, error: 'Invalid payload.' };
    }
    const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
    const numOrDefault = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
    const WHISPER_MODELS = ['tiny', 'base', 'small', 'medium', 'large-v3'];

    const next = {
      whisperModel: WHISPER_MODELS.includes(payload.whisperModel)
        ? payload.whisperModel
        : store.get('whisperModel'),
      showMatchDetails: payload.showMatchDetails !== false,
      fuseThreshold: clamp(numOrDefault(payload.fuseThreshold, 0.35), 0.1, 0.8),
      windowExpansionRate: clamp(
        numOrDefault(payload.windowExpansionRate, Settings.EXPANSION_DEFAULT),
        Settings.EXPANSION_MIN,
        Settings.EXPANSION_MAX
      ),
      showDiagnostics: payload.showDiagnostics === true,
      scrollGain: clamp(numOrDefault(payload.scrollGain, 0.35), 0.05, 2.0),
      scrollMaxVelocity: clamp(numOrDefault(payload.scrollMaxVelocity, 90), 20, 400),
      scrollBaselineVelocity: clamp(numOrDefault(payload.scrollBaselineVelocity, 8), 0, 60),
      verboseLogging: payload.verboseLogging === true,
    };

    for (const [k, v] of Object.entries(next)) store.set(k, v);

    // Apply runtime changes where possible
    if (alignment) {
      alignment.setThreshold(next.fuseThreshold);
      alignment.setUnitsPerSecond(
        Settings.effectiveUnitsPerSecond(next.windowExpansionRate, playbackRate)
      );
    }

    return { ok: true, settings: next };
  });

  ipcMain.handle('pdf:pick', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select transcript PDF',
      properties: ['openFile'],
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('pdf:load', async (_, filePath) => loadPdfFromPath(filePath));

  ipcMain.handle('app:get-version', () => app.getVersion());

  // Webview media state drives capture gating (see setMediaPlaying).
  ipcMain.on('media:playing', (_, playing) => setMediaPlaying(playing === true));
  ipcMain.on('media:rate', (_, rate) => applyPlaybackRate(rate));

  ipcMain.on('listen:start', () => startListening());
  ipcMain.on('listen:stop', () => stopListening());

  ipcMain.handle('window:toggle-fullscreen', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    mainWindow.setFullScreen(!mainWindow.isFullScreen());
    return mainWindow.isFullScreen();
  });
  ipcMain.handle('window:is-fullscreen', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    return mainWindow.isFullScreen();
  });
  ipcMain.on('align:resync', (_, index) => {
    if (alignment) alignment.resync(index);
  });

  ipcMain.handle('diag:get', () => diagSnapshot(true));

  // Secure credential storage via OS keychain (DPAPI on Windows).
  ipcMain.handle('credentials:get', () => {
    if (!safeStorage.isEncryptionAvailable()) return null;
    const stored = store.get('audioCredentials');
    if (!stored) return null;
    try {
      const buf = Buffer.from(stored, 'base64');
      const json = safeStorage.decryptString(buf);
      return JSON.parse(json);
    } catch (err) {
      console.warn('[Credentials] failed to decrypt:', err.message);
      return null;
    }
  });

  ipcMain.handle('credentials:save', (_, payload) => {
    if (!safeStorage.isEncryptionAvailable()) {
      return { ok: false, error: 'OS encryption unavailable on this machine.' };
    }
    if (!payload || typeof payload !== 'object') {
      return { ok: false, error: 'Invalid payload.' };
    }
    const data = {
      username: String(payload.username || ''),
      password: String(payload.password || ''),
      autosubmit: payload.autosubmit !== false,
    };
    try {
      const encrypted = safeStorage.encryptString(JSON.stringify(data));
      store.set('audioCredentials', encrypted.toString('base64'));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('credentials:clear', () => {
    store.delete('audioCredentials');
    return { ok: true };
  });

  // Auto-update: renderer drives download/install from the update modal.
  ipcMain.handle('update:download', () => downloadUpdate());
  ipcMain.handle('update:install', () => quitAndInstall());
}

app.setName('GMS Scroller');

// Remove the default Electron menu (also kills the View > Toggle DevTools
// shortcut). DevTools still works via F12 in dev where webPreferences.devTools
// is true; in the packaged build it's disabled entirely.
Menu.setApplicationMenu(null);

app.whenReady().then(() => {
  initPipeline();
  registerIpc();
  attachWebviewDownloadHandler();
  createWindow();

  // Support "Open with…" / command-line PDF loading: gms-scroller file.pdf
  const pdfArg = process.argv.slice(1).find((a) => /\.pdf$/i.test(a));
  if (pdfArg && fs.existsSync(pdfArg)) {
    mainWindow.webContents.once('did-finish-load', () => loadPdfFromPath(pdfArg));
  }

  // Check GitHub for a newer release on every launch (packaged builds only —
  // autoUpdater has no update feed in `npm start`).
  if (app.isPackaged) initAutoUpdater(() => mainWindow);

  // Suppress every popup window the audio site tries to open and route the
  // underlying request through downloadURL. session.will-download then decides
  // whether it's a PDF (load into transcript) or something else (ignored).
  // The site's download link often redirects via a script URL that does NOT
  // end in .pdf, so we can't filter here on extension alone.
  app.on('web-contents-created', (_evt, contents) => {
    if (contents.getType() !== 'webview') return;
    contents.setWindowOpenHandler(({ url }) => {
      console.log(`[Popup] denied + downloadURL: ${url}`);
      try { contents.downloadURL(url); } catch (err) {
        console.warn('[Popup] downloadURL failed:', err.message);
      }
      return { action: 'deny' };
    });
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  stopListening();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  stopListening();
});
