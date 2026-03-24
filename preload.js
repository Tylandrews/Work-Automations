const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
    showMessageBox: (options) => {
        return ipcRenderer.invoke('show-message-box', options);
    },
    closeApp: () => {
        return ipcRenderer.invoke('close-app');
    },
    focusApp: () => {
        return ipcRenderer.invoke('focus-app');
    },
    showTrayNotification: (title, body) => {
        return ipcRenderer.invoke('show-tray-notification', { title, body });
    },
    windowControls: {
        minimize: () => ipcRenderer.invoke('window-minimize'),
        maximizeToggle: () => ipcRenderer.invoke('window-maximize-toggle'),
        isMaximized: () => ipcRenderer.invoke('window-is-maximized'),
        close: () => ipcRenderer.invoke('window-close')
    },
    setWindowHeight: (height) => ipcRenderer.invoke('set-window-height', height),
    getMasterKey: () => ipcRenderer.invoke('get-master-key')
});
