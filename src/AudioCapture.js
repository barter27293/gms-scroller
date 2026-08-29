const { EventEmitter } = require('events');
const { spawn } = require('child_process');

const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2;

// Priority order for loopback-capable audio inputs on Windows DirectShow.
// First match wins.
const DEVICE_PRIORITY = [
  /virtual-audio-capturer/i,   // screen-capture-recorder
  /stereo mix/i,               // built-in Windows (often disabled)
  /what u hear/i,              // Creative Sound Blaster
  /wave out mix/i,             // older Realtek
  /loopback/i,                 // generic
  /cable output/i,             // VB-Audio Cable
  /vb-audio/i,                 // VB-Audio variant naming
];

function listDshowAudioDevices(ffmpegCmd) {
  return new Promise((resolve) => {
    const proc = spawn(
      ffmpegCmd,
      ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );

    let stderrBuf = '';
    proc.stderr.on('data', (d) => {
      stderrBuf += d.toString();
    });
    proc.on('error', () => resolve([]));
    proc.on('close', () => {
      const devices = [];
      const seen = new Set();

      // FFmpeg >= 5: lines look like  [in#0 @ 0x...] "Device Name" (audio)
      for (const m of stderrBuf.matchAll(/"([^"]+)"\s*\(audio\)/g)) {
        if (!seen.has(m[1])) {
          devices.push(m[1]);
          seen.add(m[1]);
        }
      }

      // FFmpeg <= 4: section header "DirectShow audio devices" then "Name" lines
      if (devices.length === 0) {
        let inAudio = false;
        for (const rawLine of stderrBuf.split(/\r?\n/)) {
          const line = rawLine.trim();
          if (/DirectShow audio devices/i.test(line)) {
            inAudio = true;
            continue;
          }
          if (/DirectShow video devices/i.test(line)) {
            inAudio = false;
            continue;
          }
          if (!inAudio) continue;
          if (/Alternative name/i.test(line)) continue;
          const m = line.match(/"([^"]+)"/);
          if (m && !seen.has(m[1])) {
            devices.push(m[1]);
            seen.add(m[1]);
          }
        }
      }

      resolve(devices);
    });
  });
}

function pickBestDevice(devices) {
  for (const pat of DEVICE_PRIORITY) {
    const found = devices.find((d) => pat.test(d));
    if (found) return found;
  }
  return null;
}

class AudioCapture extends EventEmitter {
  constructor({ chunkSeconds = 8, overlapSeconds = 2, ffmpegCmd = 'ffmpeg' } = {}) {
    super();
    this.chunkSeconds = chunkSeconds;
    this.overlapSeconds = overlapSeconds;
    this.ffmpegCmd = ffmpegCmd;
    this.chunkBytes = SAMPLE_RATE * chunkSeconds * BYTES_PER_SAMPLE;
    this.overlapBytes = SAMPLE_RATE * overlapSeconds * BYTES_PER_SAMPLE;
    this.proc = null;
    this.buffer = Buffer.alloc(0);
    // Set by stop() so an in-flight start() can bail before spawning. See the
    // race diagram above start().
    this.aborted = false;
  }

  // start() is async and this.proc stays null across the awaited device
  // enumeration, so the `if (this.proc) return` guard below and stop()'s
  // `if (!this.proc) return` guard BOTH pass during that window:
  //
  //   start() ─▶ proc === null ─▶ await listDshowAudioDevices() ─▶ _spawnFFmpeg()
  //              (guard passes)     (spawns a 2nd ffmpeg, 1–3s)      (would run
  //                    ▲                      │                       regardless)
  //                    │              stop() lands here
  //                    │                      │
  //                    └──────────────────────┘
  //                       stop() early-returns on null proc → NO-OP
  //                       result without the flag: orphan ffmpeg holding the
  //                       audio device with nobody consuming its stdout.
  //
  // The `aborted` flag closes that window.
  async start() {
    if (this.proc) return;
    this.aborted = false;
    this.buffer = Buffer.alloc(0);

    this.emit('info', 'Enumerating DirectShow audio devices…');
    const devices = await listDshowAudioDevices(this.ffmpegCmd);
    if (this.aborted) return;

    if (devices.length === 0) {
      this.emit(
        'error',
        new Error(
          'FFmpeg returned no DirectShow audio devices. Check that FFmpeg is installed and on PATH.'
        )
      );
      return;
    }

    this.emit(
      'info',
      `Available audio devices: ${devices.map((d) => `"${d}"`).join(', ')}`
    );

    const device = pickBestDevice(devices);
    if (!device) {
      this.emit(
        'error',
        new Error(
          'No loopback-capable audio device detected. To capture system audio, install one of:\n' +
            '  • screen-capture-recorder (provides "virtual-audio-capturer")\n' +
            '    https://github.com/rdp/screen-capture-recorder-to-video-windows-free\n' +
            '  • Enable Windows Stereo Mix: Sound > Recording tab > right-click empty area > Show Disabled Devices > enable Stereo Mix\n' +
            '  • VB-Audio Cable (https://vb-audio.com/Cable/) and set Cable Input as your default playback device.'
        )
      );
      return;
    }

    this.emit('info', `Using audio device: "${device}"`);
    this._spawnFFmpeg(device);
  }

  _spawnFFmpeg(device) {
    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      '-f', 'dshow',
      '-i', `audio=${device}`,
      '-ar', String(SAMPLE_RATE),
      '-ac', '1',
      '-f', 's16le',
      'pipe:1',
    ];

    const proc = spawn(this.ffmpegCmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc = proc;

    let stderrBuf = '';

    proc.stdout.on('data', (data) => this._onPcm(data));

    proc.stderr.on('data', (data) => {
      stderrBuf += data.toString();
    });

    proc.on('error', (err) => {
      this.emit('error', new Error(`Failed to spawn FFmpeg: ${err.message}. Is FFmpeg on PATH?`));
    });

    proc.on('exit', (code) => {
      this.proc = null;
      if (code !== 0 && code !== null) {
        this.emit(
          'error',
          new Error(
            `FFmpeg exited with code ${code}.\nStderr: ${stderrBuf.trim().slice(-500)}`
          )
        );
      }
    });
  }

  _onPcm(data) {
    this.buffer = Buffer.concat([this.buffer, data]);
    while (this.buffer.length >= this.chunkBytes) {
      const chunk = this.buffer.subarray(0, this.chunkBytes);
      this.emit('chunk', Buffer.from(chunk));
      const keep = this.buffer.subarray(this.chunkBytes - this.overlapBytes);
      this.buffer = Buffer.from(keep);
    }
  }

  stop() {
    // Raised before the early return so a start() still awaiting device
    // enumeration sees it and skips _spawnFFmpeg.
    this.aborted = true;
    if (!this.proc) return;
    try {
      this.proc.kill('SIGTERM');
    } catch (_) {
      // ignore
    }
    this.proc = null;
    this.buffer = Buffer.alloc(0);
  }
}

module.exports = { AudioCapture };
