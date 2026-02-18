const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
    saveFile: (content, defaultFilename) => {
        return ipcRenderer.invoke('save-file', content, defaultFilename);
    },
    showMessageBox: (options) => {
        return ipcRenderer.invoke('show-message-box', options);
    },
    closeApp: () => {
        return ipcRenderer.invoke('close-app');
    },
    windowControls: {
        minimize: () => ipcRenderer.invoke('window-minimize'),
        maximizeToggle: () => ipcRenderer.invoke('window-maximize-toggle'),
        isMaximized: () => ipcRenderer.invoke('window-is-maximized'),
        close: () => ipcRenderer.invoke('window-close')
    },
    setWindowHeight: (height) => ipcRenderer.invoke('set-window-height', height),
    getEntries: () => ipcRenderer.invoke('get-entries'),
    createEntry: (entry) => ipcRenderer.invoke('create-entry', entry),
    updateEntry: (id, fields) => ipcRenderer.invoke('update-entry', id, fields),
    deleteEntry: (id) => ipcRenderer.invoke('delete-entry', id),
    clearAllEntries: () => ipcRenderer.invoke('clear-all-entries'),
    importFromLocalStorage: (entries) => ipcRenderer.invoke('import-from-localstorage', entries)
});
