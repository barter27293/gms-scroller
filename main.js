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

const { app, BrowserWindow, ipcMain, dialog, safeStorage, session } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const Store = require('electron-store');

const PdfParser = require('./src/PdfParser');
const { AudioCapture } = require('./src/AudioCapture');
const { WhisperBridge } = require('./src/WhisperBridge');
const { AlignmentEngine } = require('./src/AlignmentEngine');

const DEFAULTS = {
  audioSiteUrl: 'https://globalmediastream.com/',
  whisperModel: 'small',
  chunkSeconds: 8,
  overlapSeconds: 2,
  fuseThreshold: 0.35,
  highlightColour: '#fff3cd',
  autoScrollResumeDelay: 3000,
  // Advanced — tuning previously hardcoded in source.
  verboseLogging: false,
  alignmentParagraphsPerSecond: 1.0,
  scrollGain: 0.35,
  scrollMaxVelocity: 90,
  scrollBaselineVelocity: 8,
};

const store = new Store({ defaults: DEFAULTS });

let mainWindow = null;
let audio = null;
let whisper = null;
let alignment = null;
let watchdogTimer = null;

function sendStatus(message, state) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('status:update', { message, state });
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
    const texts = paragraphs.map((p) => p.alignText || p.text);
    if (alignment) alignment.setParagraphs(texts);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pdf:loaded', { title, paragraphs });
    }
    const speakerCount = paragraphs.filter((p) => p.speaker).length;
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
    paragraphsPerSecond: store.get('alignmentParagraphsPerSecond'),
  });
  alignment.on('position-update', (payload) => {
    console.log(`[Alignment] position-update -> paragraph #${payload.index}`);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('position:update', payload);
    }
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

  if (alignment && alignment.paragraphs.length === 0) {
    console.warn('[Pipeline] Listen clicked but no PDF loaded — alignment will produce no matches.');
    sendStatus('Load a PDF first', 'lost');
    return;
  }

  console.log('[Pipeline] === Listen started ===');
  console.log(`[Pipeline] config: chunkSeconds=${store.get('chunkSeconds')} overlapSeconds=${store.get('overlapSeconds')} model=${store.get('whisperModel')} fuseThreshold=${store.get('fuseThreshold')}`);

  audio = new AudioCapture({
    chunkSeconds: store.get('chunkSeconds'),
    overlapSeconds: store.get('overlapSeconds'),
  });
  whisper = new WhisperBridge({ model: store.get('whisperModel') });

  let chunkCount = 0;
  let transcriptionCount = 0;
  const startedAt = Date.now();

  if (watchdogTimer) clearInterval(watchdogTimer);
  watchdogTimer = setInterval(() => {
    if (!audio) return;
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
    if (chunkCount === 1 || chunkCount % 5 === 0) {
      console.log(`[Audio] chunk #${chunkCount} (${buf.length} bytes)`);
    }
    if (whisper) whisper.send(buf);
  });
  audio.on('info', (msg) => {
    console.log(`[Audio] ${msg}`);
    sendStatus(msg, 'listening');
  });
  audio.on('error', (err) => {
    console.error(`[Audio] ERROR: ${err.message}`);
    sendStatus(`Audio error: ${err.message}`, 'lost');
    stopListening();
  });

  whisper.on('transcription', (text) => {
    transcriptionCount++;
    console.log(`[Whisper] #${transcriptionCount}: "${text}"`);
    if (alignment) alignment.match(text);
    sendStatus('Synced', 'synced');
  });
  whisper.on('info', (msg) => {
    console.log(`[Whisper] ${msg}`);
    if (msg.toLowerCase().includes('error')) {
      sendStatus(msg, 'lost');
    }
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

function registerIpc() {
  ipcMain.handle('config:get', () => ({
    audioSiteUrl: store.get('audioSiteUrl'),
    highlightColour: store.get('highlightColour'),
    autoScrollResumeDelay: store.get('autoScrollResumeDelay'),
    scrollGain: store.get('scrollGain'),
    scrollMaxVelocity: store.get('scrollMaxVelocity'),
    scrollBaselineVelocity: store.get('scrollBaselineVelocity'),
  }));

  ipcMain.handle('settings:get', () => ({
    fuseThreshold: store.get('fuseThreshold'),
    alignmentParagraphsPerSecond: store.get('alignmentParagraphsPerSecond'),
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

    const next = {
      fuseThreshold: clamp(numOrDefault(payload.fuseThreshold, 0.35), 0.1, 0.8),
      alignmentParagraphsPerSecond: clamp(numOrDefault(payload.alignmentParagraphsPerSecond, 1.0), 0.1, 5.0),
      scrollGain: clamp(numOrDefault(payload.scrollGain, 0.35), 0.05, 2.0),
      scrollMaxVelocity: clamp(numOrDefault(payload.scrollMaxVelocity, 90), 20, 400),
      scrollBaselineVelocity: clamp(numOrDefault(payload.scrollBaselineVelocity, 8), 0, 60),
      verboseLogging: payload.verboseLogging === true,
    };

    for (const [k, v] of Object.entries(next)) store.set(k, v);

    // Apply runtime changes where possible
    if (alignment) {
      alignment.setThreshold(next.fuseThreshold);
      alignment.setParagraphsPerSecond(next.alignmentParagraphsPerSecond);
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
}

app.setName('GMS Scroller');

app.whenReady().then(() => {
  initPipeline();
  registerIpc();
  attachWebviewDownloadHandler();
  createWindow();

  // Suppress the blank popup window that the audio site opens when the user
  // clicks the PDF download link. The session.will-download handler above
  // still fires for the underlying download request and routes the file into
  // the transcript pane.
  app.on('web-contents-created', (_evt, contents) => {
    if (contents.getType() !== 'webview') return;
    contents.setWindowOpenHandler(({ url }) => {
      const isPdf = /\.pdf(\?|$)/i.test(url);
      if (isPdf) {
        // Trigger the download in the same partition so will-download fires.
        contents.downloadURL(url);
        return { action: 'deny' };
      }
      return { action: 'allow' };
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
