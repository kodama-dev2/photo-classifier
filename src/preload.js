const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  pickDir: (title) => ipcRenderer.invoke('pick-dir', { title }),
  getModelsStatus: () => ipcRenderer.invoke('models-status'),
  getAppInfo: () => ipcRenderer.invoke('app-info'),
  checkUpdate: () => ipcRenderer.invoke('check-update'),
  downloadUpdate: () => ipcRenderer.invoke('download-update'),
  mediaUrl: (filePath) => `pcimg://local/?p=${encodeURIComponent(filePath)}`,
  onModelsStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('models-status', listener);
    return () => ipcRenderer.removeListener('models-status', listener);
  },
  onProgress: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('progress', listener);
    return () => ipcRenderer.removeListener('progress', listener);
  },
  onUpdateProgress: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('update-progress', listener);
    return () => ipcRenderer.removeListener('update-progress', listener);
  },
  scan: (options) => ipcRenderer.invoke('scan', options),
  reclassify: (options) => ipcRenderer.invoke('reclassify', options),
  mergeClusters: (options) => ipcRenderer.invoke('merge-clusters', options),
  renameCluster: (options) => ipcRenderer.invoke('rename-cluster', options),
  cancel: () => ipcRenderer.invoke('cancel'),
  apply: (options) => ipcRenderer.invoke('apply', options),
  undo: () => ipcRenderer.invoke('undo'),
  reveal: (targetPath) => ipcRenderer.invoke('reveal', targetPath)
});
