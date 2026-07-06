const fs = require('fs');
const path = require('path');

// Minimal file logger for packaged builds, where there is no console and
// devTools is disabled. Tees console.log/warn/error into
// <userData>/logs/main.log with timestamps. Must never throw — logging
// failure cannot be allowed to break the app.

const MAX_BYTES = 1024 * 1024;
const RECENT_LINES_MAX = 200;

let stream = null;
let logPath = null;
const recentLines = [];

function formatArg(a) {
  if (typeof a === 'string') return a;
  if (a instanceof Error) return a.stack || a.message;
  try {
    return JSON.stringify(a);
  } catch (_) {
    return String(a);
  }
}

function write(level, args) {
  const line = `${new Date().toISOString()} [${level}] ${args.map(formatArg).join(' ')}`;
  recentLines.push(line);
  if (recentLines.length > RECENT_LINES_MAX) recentLines.shift();
  if (stream) {
    try {
      stream.write(line + '\n');
    } catch (_) {
      // ignore
    }
  }
}

function init(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    logPath = path.join(dir, 'main.log');
    try {
      if (fs.statSync(logPath).size > MAX_BYTES) {
        const old = path.join(dir, 'main.old.log');
        fs.rmSync(old, { force: true });
        fs.renameSync(logPath, old);
      }
    } catch (_) {
      // no existing log — fine
    }
    stream = fs.createWriteStream(logPath, { flags: 'a' });
  } catch (_) {
    stream = null;
  }

  for (const level of ['log', 'warn', 'error']) {
    const orig = console[level].bind(console);
    console[level] = (...args) => {
      write(level, args);
      orig(...args);
    };
  }
  write('log', [`==== session start pid=${process.pid} ====`]);
}

function getLogPath() {
  return logPath;
}

// Recent log lines kept in memory for the diagnostics panel.
function getRecentLines() {
  return recentLines.slice();
}

module.exports = { init, getLogPath, getRecentLines };
