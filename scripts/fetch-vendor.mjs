// Downloads the bundled runtime dependencies into vendor/ (gitignored):
//
//   vendor/ffmpeg/ffmpeg.exe   — FFmpeg essentials build (gyan.dev)
//   vendor/python/             — Python embeddable runtime with faster-whisper
//                                preinstalled via pip
//
// electron-builder ships these via extraResources (see package.json) so the
// installed app needs neither FFmpeg nor Python on the user's machine.
// Idempotent: each step is skipped when its output already exists.
// Windows-only, matching the app itself.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = path.join(ROOT, 'vendor');
const TMP = path.join(VENDOR, 'tmp');

const FFMPEG_URL = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip';
const PYTHON_VERSION = '3.11.9';
const PYTHON_URL = `https://www.python.org/ftp/python/${PYTHON_VERSION}/python-${PYTHON_VERSION}-embed-amd64.zip`;
const GET_PIP_URL = 'https://bootstrap.pypa.io/get-pip.py';

function log(msg) {
  console.log(`[fetch-vendor] ${msg}`);
}

async function download(url, dest) {
  log(`downloading ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  log(`saved ${dest} (${Math.round(buf.length / 1024 / 1024)} MB)`);
}

function expandZip(zip, dest) {
  fs.mkdirSync(dest, { recursive: true });
  execFileSync(
    'powershell.exe',
    ['-NoProfile', '-Command', `Expand-Archive -LiteralPath "${zip}" -DestinationPath "${dest}" -Force`],
    { stdio: 'inherit' }
  );
}

function findFile(dir, name) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findFile(p, name);
      if (found) return found;
    } else if (entry.name.toLowerCase() === name) {
      return p;
    }
  }
  return null;
}

function run(cmd, args) {
  log(`running ${path.basename(cmd)} ${args.join(' ')}`);
  execFileSync(cmd, args, { stdio: 'inherit' });
}

async function fetchFfmpeg() {
  const target = path.join(VENDOR, 'ffmpeg', 'ffmpeg.exe');
  if (fs.existsSync(target)) {
    log('ffmpeg already present — skipping');
    return;
  }
  const zip = path.join(TMP, 'ffmpeg.zip');
  const extractDir = path.join(TMP, 'ffmpeg');
  await download(FFMPEG_URL, zip);
  expandZip(zip, extractDir);
  const exe = findFile(extractDir, 'ffmpeg.exe');
  if (!exe) throw new Error('ffmpeg.exe not found in the downloaded archive');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(exe, target);
  const license = findFile(extractDir, 'license');
  if (license) fs.copyFileSync(license, path.join(VENDOR, 'ffmpeg', 'LICENSE'));
  log(`ffmpeg ready: ${target}`);
}

async function fetchPython() {
  const pyDir = path.join(VENDOR, 'python');
  const pyExe = path.join(pyDir, 'python.exe');
  const sitePackages = path.join(pyDir, 'Lib', 'site-packages');
  if (fs.existsSync(pyExe) && fs.existsSync(path.join(sitePackages, 'faster_whisper'))) {
    log('python runtime with faster-whisper already present — skipping');
    return;
  }

  if (!fs.existsSync(pyExe)) {
    const zip = path.join(TMP, 'python-embed.zip');
    await download(PYTHON_URL, zip);
    expandZip(zip, pyDir);
  }

  // The embeddable distribution ships with `import site` commented out in its
  // ._pth file, which blocks pip and site-packages. Enable it.
  const pthFile = fs
    .readdirSync(pyDir)
    .map((f) => path.join(pyDir, f))
    .find((f) => f.endsWith('._pth'));
  if (!pthFile) throw new Error('._pth file not found in the python runtime');
  const pthLines = fs
    .readFileSync(pthFile, 'utf8')
    .split(/\r?\n/)
    .map((l) => (l.trim() === '#import site' ? 'import site' : l));
  if (!pthLines.some((l) => l.trim() === 'Lib\\site-packages')) {
    pthLines.splice(1, 0, 'Lib\\site-packages');
  }
  fs.writeFileSync(pthFile, pthLines.join('\n'));

  if (!fs.existsSync(path.join(sitePackages, 'pip'))) {
    const getPip = path.join(TMP, 'get-pip.py');
    await download(GET_PIP_URL, getPip);
    run(pyExe, [getPip, '--no-warn-script-location']);
  }

  run(pyExe, ['-m', 'pip', 'install', '--no-warn-script-location', 'faster-whisper']);

  // Smoke test: the worker's imports must resolve in the bundled runtime.
  run(pyExe, ['-c', 'import faster_whisper, numpy; print("bundled python OK:", faster_whisper.__version__)']);
  log(`python runtime ready: ${pyExe}`);
}

try {
  fs.mkdirSync(TMP, { recursive: true });
  await fetchFfmpeg();
  await fetchPython();
  fs.rmSync(TMP, { recursive: true, force: true });
  log('done');
} catch (err) {
  console.error(`[fetch-vendor] FAILED: ${err.message}`);
  process.exit(1);
}
