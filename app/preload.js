const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('host', {
  win: (cmd) => ipcRenderer.send('win', cmd),
  setPlaying: (playing) => ipcRenderer.send('playing', playing),
  setTitle: (title) => ipcRenderer.send('title', title),
  openExternal: (url) => ipcRenderer.send('open-external', url),
  storeGet: () => ipcRenderer.invoke('store-get'),
  storeSet: (data) => ipcRenderer.invoke('store-set', data),
  oembed: (id) => ipcRenderer.invoke('oembed', id),
  paths: () => ipcRenderer.invoke('paths'),
  onMedia: (fn) => ipcRenderer.on('media', (_e, cmd) => fn(cmd)),
  onWindowState: (fn) => ipcRenderer.on('window-state', (_e, s) => fn(s)),
  onCursorMove: (fn) => ipcRenderer.on('cursor-move', () => fn()),
});
