const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  pickPdf: () => ipcRenderer.invoke('pdf:pick'),
  loadPdf: (filePath) => ipcRenderer.invoke('pdf:load', filePath),
  getVersion: () => ipcRenderer.invoke('app:get-version'),

  // Auto-listen: the renderer owns the webview media events, main owns
  // process lifecycle and the capture gate.
  setMediaPlaying: (playing) => ipcRenderer.send('media:playing', playing),
  setPlaybackRate: (rate) => ipcRenderer.send('media:rate', rate),

  listenStart: () => ipcRenderer.send('listen:start'),
  listenStop: () => ipcRenderer.send('listen:stop'),
  resync: (index) => ipcRenderer.send('align:resync', index),
  getConfig: () => ipcRenderer.invoke('config:get'),

  getCredentials: () => ipcRenderer.invoke('credentials:get'),
  saveCredentials: (payload) => ipcRenderer.invoke('credentials:save', payload),
  clearCredentials: () => ipcRenderer.invoke('credentials:clear'),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (payload) => ipcRenderer.invoke('settings:save', payload),

  onPdfLoaded: (cb) => ipcRenderer.on('pdf:loaded', (_, payload) => cb(payload)),
  onPositionUpdate: (cb) => ipcRenderer.on('position:update', (_, payload) => cb(payload)),
  onMatchState: (cb) => ipcRenderer.on('match:state', (_, payload) => cb(payload)),
  onStatusUpdate: (cb) => ipcRenderer.on('status:update', (_, payload) => cb(payload)),
  onTabActivate: (cb) => ipcRenderer.on('tab:activate', (_, payload) => cb(payload)),

  getDiagnostics: () => ipcRenderer.invoke('diag:get'),
  onDiagUpdate: (cb) => ipcRenderer.on('diag:update', (_, payload) => cb(payload)),

  toggleFullScreen: () => ipcRenderer.invoke('window:toggle-fullscreen'),
  isFullScreen: () => ipcRenderer.invoke('window:is-fullscreen'),
  onFullScreenChanged: (cb) => ipcRenderer.on('window:fullscreen-changed', (_, isFull) => cb(isFull)),

  onUpdateAvailable: (cb) => ipcRenderer.on('update:available', (_, p) => cb(p)),
  onUpdateProgress: (cb) => ipcRenderer.on('update:progress', (_, p) => cb(p)),
  onUpdateDownloaded: (cb) => ipcRenderer.on('update:downloaded', (_, p) => cb(p)),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
});
