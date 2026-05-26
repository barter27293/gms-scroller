const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  pickPdf: () => ipcRenderer.invoke('pdf:pick'),
  loadPdf: (filePath) => ipcRenderer.invoke('pdf:load', filePath),
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
  onStatusUpdate: (cb) => ipcRenderer.on('status:update', (_, payload) => cb(payload)),
});
