const { app, BrowserWindow, dialog, ipcMain, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const db = require('./db.js');

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled promise rejection:', reason);
});

let mainWindow;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 1000,
        minHeight: 600,
        frame: false,
        autoHideMenuBar: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true
        },
        icon: fs.existsSync(path.join(__dirname, 'build', 'icon.png')) 
            ? path.join(__dirname, 'build', 'icon.png') 
            : undefined,
        backgroundColor: '#f8fafc',
        show: false
    });

    // Load the index.html file
    mainWindow.loadFile('index.html').catch((err) => {
        console.error('Failed to load index.html:', err);
    });

    // Show window when ready to prevent visual flash
    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
    });

    // Open DevTools in development (comment out for production)
    // mainWindow.webContents.openDevTools();

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

// Set window height to fit content (called from renderer)
ipcMain.handle('set-window-height', (event, height) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || mainWindow !== win || typeof height !== 'number') return;
    const [width] = win.getContentSize();
    const maxHeight = screen.getPrimaryDisplay().workAreaSize.height;
    const clamped = Math.min(Math.max(Math.round(height), 400), maxHeight);
    win.setContentSize(width, clamped);
});

// Handle file save dialog
ipcMain.handle('save-file', async (event, content, defaultFilename) => {
    try {
        const { filePath } = await dialog.showSaveDialog(mainWindow, {
            title: 'Save CSV File',
            defaultPath: defaultFilename,
            filters: [
                { name: 'CSV Files', extensions: ['csv'] },
                { name: 'All Files', extensions: ['*'] }
            ]
        });

        if (filePath) {
            fs.writeFileSync(filePath, content, 'utf8');
            return true;
        }
        return false;
    } catch (error) {
        console.error('save-file error:', error);
        return false;
    }
});

// Handle message box
ipcMain.handle('show-message-box', async (event, options) => {
    try {
        return await dialog.showMessageBox(mainWindow, options);
    } catch (err) {
        console.error('show-message-box error:', err);
        return { response: 0 };
    }
});

// Handle app close
ipcMain.handle('close-app', () => {
    app.quit();
});

// Window controls for custom title bar
ipcMain.handle('window-minimize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
});

ipcMain.handle('window-maximize-toggle', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    if (mainWindow.isMaximized()) {
        mainWindow.unmaximize();
        return false;
    }
    mainWindow.maximize();
    return true;
});

ipcMain.handle('window-is-maximized', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    return mainWindow.isMaximized();
});

ipcMain.handle('window-close', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
});

// Database (SQLite) – wrap so rejections are handled
ipcMain.handle('get-entries', () => {
    try {
        return db.getEntries();
    } catch (err) {
        console.error('get-entries error:', err);
        return [];
    }
});
ipcMain.handle('create-entry', (event, entry) => {
    try {
        const result = db.createEntry(entry);
        if (result == null) {
            console.error('create-entry: returned null (database may not be initialized - check for "Database init error" above)');
        }
        return result;
    } catch (err) {
        console.error('create-entry error:', err);
        return null;
    }
});
ipcMain.handle('update-entry', (event, id, fields) => {
    try {
        return db.updateEntry(id, fields);
    } catch (err) {
        console.error('update-entry error:', err);
        return false;
    }
});
ipcMain.handle('delete-entry', (event, id) => {
    try {
        return db.deleteEntry(id);
    } catch (err) {
        console.error('delete-entry error:', err);
        return false;
    }
});
ipcMain.handle('clear-all-entries', () => {
    try {
        db.clearAll();
    } catch (err) {
        console.error('clear-all-entries error:', err);
    }
});
ipcMain.handle('import-from-localstorage', (event, entries) => {
    try {
        db.importFromLocalStorage(entries);
    } catch (err) {
        console.error('import-from-localstorage error:', err);
    }
});

// This method will be called when Electron has finished initialization
app.whenReady().then(() => {
    try {
        const dbInstance = db.init(app.getPath('userData'));
        if (!dbInstance) console.error('Database init failed (see "Database init error" above). Run: npm run postinstall');
    } catch (err) {
        console.error('Database init failed:', err);
    }
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
}).catch((err) => {
    console.error('App whenReady failed:', err);
});

// Quit when all windows are closed
app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});
