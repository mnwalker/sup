'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * The renderer never touches Node or the providers directly; it only gets a
 * read-only snapshot plus the two hover signals the main process needs.
 */
contextBridge.exposeInMainWorld('sup', {
  onUpdate: (fn) => {
    const handler = (_event, payload) => fn(payload);
    ipcRenderer.on('sup:update', handler);
    return () => ipcRenderer.removeListener('sup:update', handler);
  },
  onConfig: (fn) => {
    const handler = (_event, payload) => fn(payload);
    ipcRenderer.on('sup:config', handler);
    return () => ipcRenderer.removeListener('sup:config', handler);
  },
  ready: () => ipcRenderer.send('sup:ready'),
  expand: () => ipcRenderer.send('sup:expand'),
  collapse: () => ipcRenderer.send('sup:collapse'),
  refresh: () => ipcRenderer.send('sup:refresh'),
  openSettings: () => ipcRenderer.send('sup:open-settings'),
  quit: () => ipcRenderer.send('sup:quit'),
});
