const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');

class WhisperBridge extends EventEmitter {
  constructor({ pythonCmd = 'python', model = 'small', workerPath } = {}) {
    super();
    this.pythonCmd = pythonCmd;
    this.model = model;
    this.workerPath = workerPath || path.join(__dirname, '..', 'python', 'whisper_worker.py');
    this.proc = null;
  }

  start() {
    if (this.proc) return;

    const env = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1', WHISPER_MODEL: this.model };
    const proc = spawn(this.pythonCmd, ['-u', this.workerPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });
    this.proc = proc;

    const rl = readline.createInterface({ input: proc.stdout });
    rl.on('line', (line) => {
      const text = line.trim();
      if (text) this.emit('transcription', text);
    });

    proc.stderr.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg) this.emit('info', msg);
    });

    proc.on('error', (err) => {
      this.emit('error', new Error(`Failed to spawn Python worker: ${err.message}. Is Python on PATH?`));
    });

    proc.on('exit', (code) => {
      this.proc = null;
      if (code !== 0 && code !== null) {
        this.emit('error', new Error(`whisper_worker.py exited with code ${code}`));
      }
    });
  }

  send(buffer) {
    if (!this.proc || !this.proc.stdin.writable) return;
    this.proc.stdin.write(buffer);
  }

  stop() {
    if (!this.proc) return;
    try {
      this.proc.stdin.end();
    } catch (_) {
      // ignore
    }
    try {
      this.proc.kill('SIGTERM');
    } catch (_) {
      // ignore
    }
    this.proc = null;
  }
}

module.exports = { WhisperBridge };
