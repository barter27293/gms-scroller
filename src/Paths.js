const path = require('path');
const fs = require('fs');

// Resolves external binaries and scripts for both dev (`npm start`) and
// packaged builds. In a packaged app, files listed under `extraResources`
// live in process.resourcesPath — NOT inside app.asar. Child processes
// (python.exe, ffmpeg.exe) cannot read paths inside the asar archive, so
// anything they must open has to resolve to a real on-disk path.

function firstExisting(candidates, fallback) {
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch (_) {
      // ignore
    }
  }
  return fallback;
}

function whisperWorkerPath(isPackaged) {
  return isPackaged
    ? path.join(process.resourcesPath, 'python', 'whisper_worker.py')
    : path.join(__dirname, '..', 'python', 'whisper_worker.py');
}

// Bundled Python runtime (embeddable distribution with faster-whisper
// preinstalled, laid down by scripts/fetch-vendor.mjs). Falls back to the
// system `python` on PATH when no bundled runtime is present.
function pythonCmd(isPackaged) {
  const candidates = isPackaged
    ? [path.join(process.resourcesPath, 'python-runtime', 'python.exe')]
    : [path.join(__dirname, '..', 'vendor', 'python', 'python.exe')];
  return firstExisting(candidates, 'python');
}

// Bundled Whisper `small` model directory (laid down by fetch-vendor.mjs).
// Returns null when absent — the worker then falls back to downloading it,
// which only happens in dev before fetch-vendor has run.
function whisperModelPath(isPackaged) {
  const dir = isPackaged
    ? path.join(process.resourcesPath, 'models', 'faster-whisper-small')
    : path.join(__dirname, '..', 'vendor', 'models', 'faster-whisper-small');
  return firstExisting([path.join(dir, 'model.bin')], null) ? dir : null;
}

// Bundled FFmpeg; falls back to `ffmpeg` on PATH.
function ffmpegCmd(isPackaged) {
  const candidates = isPackaged
    ? [path.join(process.resourcesPath, 'ffmpeg', 'ffmpeg.exe')]
    : [path.join(__dirname, '..', 'vendor', 'ffmpeg', 'ffmpeg.exe')];
  return firstExisting(candidates, 'ffmpeg');
}

module.exports = { whisperWorkerPath, whisperModelPath, pythonCmd, ffmpegCmd };
