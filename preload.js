const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopApi', {
  config: {
    listFiles: () => ipcRenderer.invoke('config:list-files'),
    read: (path) => ipcRenderer.invoke('config:read', path),
    save: (path, content) => ipcRenderer.invoke('config:save', { path, content }),
    listBackups: (path) => ipcRenderer.invoke('config:list-backups', path),
    readBackup: (path) => ipcRenderer.invoke('config:read-backup', path),
    deleteBackup: (targetPath, backupPath) => ipcRenderer.invoke('config:delete-backup', targetPath, backupPath),
    chooseFile: () => ipcRenderer.invoke('config:choose-file'),
    openFolder: (path) => ipcRenderer.invoke('config:open-folder', path)
  },
  oidc: {
    onStatusChanged: (callback) => {
      const listener = (_event, status) => callback(status);
      ipcRenderer.on('auth:changed', listener);
      return () => ipcRenderer.removeListener('auth:changed', listener);
    },
    readSettings: () => ipcRenderer.invoke('oidc:read-settings'),
    saveSettings: (settings) => ipcRenderer.invoke('oidc:save-settings', settings),
    apiKeys: () => ipcRenderer.invoke('oidc:api-keys'),
    status: () => ipcRenderer.invoke('auth:status'),
    login: () => ipcRenderer.invoke('auth:login'),
    logout: () => ipcRenderer.invoke('auth:logout'),
    openProvider: () => ipcRenderer.invoke('auth:open-provider'),
    openLastUrl: () => ipcRenderer.invoke('auth:open-last-url')
  },
  update: {
    status: () => ipcRenderer.invoke('update:status'),
    check: () => ipcRenderer.invoke('update:check'),
    download: () => ipcRenderer.invoke('update:download'),
    install: () => ipcRenderer.invoke('update:install'),
    onChanged: (callback) => {
      const listener = (_event, state) => callback(state);
      ipcRenderer.on('update:changed', listener);
      return () => ipcRenderer.removeListener('update:changed', listener);
    }
  },
  codex: {
    restart: () => ipcRenderer.invoke('codex:restart')
  },
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
    close: () => ipcRenderer.send('window:close')
  }
});
