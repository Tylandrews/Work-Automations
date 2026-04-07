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
    getMasterKey: () => ipcRenderer.invoke('get-master-key'),
    getAppVersion: () => ipcRenderer.invoke('get-app-version'),
    updater: {
        getState: () => ipcRenderer.invoke('updater-get-state'),
        checkForUpdates: () => ipcRenderer.invoke('updater-check-for-updates'),
        downloadUpdate: () => ipcRenderer.invoke('updater-download-update'),
        quitAndInstall: () => ipcRenderer.invoke('updater-quit-and-install'),
        onEvent: (callback) => {
            if (typeof callback !== 'function') return () => {};
            const listener = (_event, payload) => {
                callback(payload);
            };
            ipcRenderer.on('updater-event', listener);
            return () => ipcRenderer.removeListener('updater-event', listener);
        },
    },
    getPendingAuthDeepLink: () => ipcRenderer.invoke('get-pending-auth-deep-link'),
    onAuthDeepLink: (callback) => {
        if (typeof callback !== 'function') return () => {};
        const listener = (_event, deepUrl) => {
            callback(deepUrl);
        };
        ipcRenderer.on('auth-deep-link', listener);
        return () => ipcRenderer.removeListener('auth-deep-link', listener);
    },
});
