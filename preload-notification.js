const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('notificationClicked', () => {
    ipcRenderer.send('notification-clicked');
});
