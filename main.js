const { app, BrowserWindow, dialog, ipcMain, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const db = require('./db.js');

/** Resolve .ico path so taskbar uses it. Packaged: extraResources puts it in resources/. */
function getAppIconPath() {
    if (process.platform !== 'win32') return undefined;
    if (app.isPackaged) {
        const resIco = path.join(process.resourcesPath, 'icon.ico');
        if (fs.existsSync(resIco)) return resIco;
    }
    const buildIco = path.join(__dirname, 'build', 'icons', 'icon.ico');
    if (fs.existsSync(buildIco)) return buildIco;
    const bigFish = path.join(__dirname, 'Images', 'BigFish_Centered_Logo_Inverted.png');
    if (fs.existsSync(bigFish)) return bigFish;
    return undefined;
}

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled promise rejection:', reason);
});

let mainWindow;
let notificationWindow = null;

const NOTIFICATION_WIDTH = 340;
const NOTIFICATION_HEIGHT = 90;
const NOTIFICATION_MARGIN = 12;
const NOTIFICATION_DURATION_MS = 7000;

function showTrayNotification(title, body) {
    if (notificationWindow && !notificationWindow.isDestroyed()) {
        notificationWindow.close();
        notificationWindow = null;
    }
    const preloadPath = path.join(__dirname, 'preload-notification.js');
    if (!fs.existsSync(preloadPath)) {
        console.warn('preload-notification.js not found, skipping tray notification');
        return;
    }
    const win = new BrowserWindow({
        width: NOTIFICATION_WIDTH,
        height: NOTIFICATION_HEIGHT,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        skipTaskbar: true,
        resizable: false,
        focusable: true,
        show: false,
        webPreferences: {
            preload: preloadPath,
            nodeIntegration: false,
            contextIsolation: true
        }
    });
    win.setMenuBarVisibility(false);
    const query = { title: title || 'IT Support Call Logger', body: body || '' };
    win.loadFile('notification.html', { query }).catch((err) => {
        console.error('notification.html load error:', err);
        win.destroy();
        return;
    });
    win.once('ready-to-show', () => {
        const display = screen.getPrimaryDisplay();
        const { x, y, width, height } = display.workArea;
        const nx = x + width - NOTIFICATION_WIDTH - NOTIFICATION_MARGIN;
        const ny = y + height - NOTIFICATION_HEIGHT - NOTIFICATION_MARGIN;
        win.setPosition(nx, ny);
        win.show();
    });
    const closeNotification = () => {
        if (win && !win.isDestroyed()) {
            win.close();
        }
        if (notificationWindow === win) notificationWindow = null;
    };
    win.on('closed', () => {
        if (notificationWindow === win) notificationWindow = null;
    });
    const timeoutId = setTimeout(closeNotification, NOTIFICATION_DURATION_MS);
    win.on('closed', () => clearTimeout(timeoutId));
    notificationWindow = win;
}

ipcMain.on('notification-clicked', () => {
    if (notificationWindow && !notificationWindow.isDestroyed()) {
        notificationWindow.close();
        notificationWindow = null;
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
        mainWindow.focus();
    }
});

function createWindow() {
    /* Window size: larger default so New Call + Call History fit well; taller not wider */
    const PREFERRED_WIDTH = 1100;
    const PREFERRED_HEIGHT = 1000;

    mainWindow = new BrowserWindow({
        width: PREFERRED_WIDTH,
        height: PREFERRED_HEIGHT,
        minWidth: PREFERRED_WIDTH,
        minHeight: PREFERRED_HEIGHT,
        frame: false,
        autoHideMenuBar: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true
        },
        icon: getAppIconPath(),
        backgroundColor: '#f8fafc',
        show: false
    });

    // Load the index.html file
    mainWindow.loadFile('index.html').catch((err) => {
        console.error('Failed to load index.html:', err);
    });

    // Show window when ready to prevent visual flash
    mainWindow.once('ready-to-show', () => {
        const iconPath = getAppIconPath();
        if (iconPath) mainWindow.setIcon(iconPath);
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

ipcMain.handle('focus-app', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
        mainWindow.focus();
    }
});

ipcMain.handle('show-tray-notification', (event, { title, body }) => {
    showTrayNotification(title, body);
});

// Database (SQLite)
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
app.whenReady().then(async () => {
    try {
        const dbInstance = await db.init(app.getPath('userData'));
        if (!dbInstance) console.error('Database init failed (see "Database init error" above).');
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
