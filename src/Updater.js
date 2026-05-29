// Auto-update wiring around electron-updater's autoUpdater.
//
// electron-updater reads the GitHub release that electron-builder published
// (the installer + latest.yml). The release *body* becomes `info.releaseNotes`
// — that's the changelog we surface to the user. Only published (non-draft)
// releases are visible to the updater, which is why our publish config uses
// `releaseType: "draft"`: it gives us a window to write the notes before the
// release goes live to clients.
//
// IMPORTANT: this only works in packaged builds. In `npm start` the app has no
// app-update.yml and autoUpdater will error — callers must guard on
// `app.isPackaged`.

const { autoUpdater } = require('electron-updater');

let initialised = false;

/**
 * Wire up autoUpdater and start a check.
 * @param {() => (Electron.BrowserWindow|null)} getWindow returns the main window
 */
function initAutoUpdater(getWindow) {
  if (initialised) return;
  initialised = true;

  // We drive download/install from the renderer modal, so don't auto-download.
  autoUpdater.autoDownload = false;
  // If the user picks "Later", still install the already-downloaded update on quit.
  autoUpdater.autoInstallOnAppQuit = true;

  const send = (channel, payload) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  };

  autoUpdater.on('update-available', (info) => {
    console.log(`[Updater] update available: ${info.version}`);
    send('update:available', {
      version: info.version,
      releaseNotes: info.releaseNotes || '',
      releaseName: info.releaseName || '',
      releaseDate: info.releaseDate || '',
    });
  });

  autoUpdater.on('update-not-available', (info) => {
    console.log(`[Updater] no update available (current is latest: ${info.version})`);
  });

  autoUpdater.on('download-progress', (p) => {
    send('update:progress', { percent: p.percent });
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log(`[Updater] update downloaded: ${info.version}`);
    send('update:downloaded', { version: info.version });
  });

  autoUpdater.on('error', (err) => {
    // Stay silent in the UI — a failed update check shouldn't nag the user.
    console.warn('[Updater] error:', err == null ? 'unknown' : err.message || err);
  });

  autoUpdater.checkForUpdates().catch((err) => {
    console.warn('[Updater] checkForUpdates failed:', err.message || err);
  });
}

function downloadUpdate() {
  return autoUpdater.downloadUpdate();
}

function quitAndInstall() {
  // isSilent=true (no NSIS UI), isForceRunAfter=true (relaunch after install).
  autoUpdater.quitAndInstall(true, true);
}

module.exports = { initAutoUpdater, downloadUpdate, quitAndInstall };
