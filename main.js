const { app, BrowserWindow, dialog, ipcMain, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const { autoUpdater } = require('electron-updater');
// Local SQL database removed - using Supabase only

const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
const UPDATE_CHECK_START_DELAY_MS = 8000

/** Windows portable builds from electron-builder set this; NSIS installs do not. */
const isWindowsPortableBuild = () =>
    process.platform === 'win32' && !!process.env.PORTABLE_EXECUTABLE_DIR

/**
 * Auto-update is enabled for packaged Windows NSIS installs only.
 * Releases currently publish Windows assets only; portable/macOS/Linux are out of scope.
 */
const shouldRunAutoUpdater = () =>
    app.isPackaged && process.platform === 'win32' && !isWindowsPortableBuild()

let updaterPhase = 'idle'
let updaterAvailableVersion = null
let updaterDownloadedVersion = null
let updaterProgress = null
let updaterLastError = null

const isNetworkUpdaterError = (msg) =>
    /net::ERR_/i.test(msg) ||
    /ENOTFOUND/i.test(msg) ||
    /ETIMEDOUT/i.test(msg) ||
    /ECONNRESET/i.test(msg)

const buildUpdaterSnapshot = () => {
    if (!shouldRunAutoUpdater()) {
        return {
            supported: false,
            phase: 'idle',
            currentVersion: app.getVersion(),
            availableVersion: null,
            downloadedVersion: null,
            progress: null,
            errorMessage: null,
        }
    }
    return {
        supported: true,
        phase: updaterPhase,
        currentVersion: app.getVersion(),
        availableVersion: updaterAvailableVersion,
        downloadedVersion: updaterDownloadedVersion,
        progress: updaterProgress,
        errorMessage: updaterLastError,
    }
}

const emitUpdaterState = () => {
    if (!shouldRunAutoUpdater()) return
    if (!mainWindow || mainWindow.isDestroyed()) return
    mainWindow.webContents.send('updater-event', {
        type: 'state',
        ...buildUpdaterSnapshot(),
    })
}

const setupAutoUpdater = () => {
    if (!shouldRunAutoUpdater()) return

    autoUpdater.autoDownload = false

    autoUpdater.on('checking-for-update', () => {
        updaterPhase = 'checking'
        updaterLastError = null
        emitUpdaterState()
    })

    autoUpdater.on('update-available', (info) => {
        const ver = info && info.version ? String(info.version) : ''
        updaterPhase = 'available'
        updaterAvailableVersion = ver || null
        updaterLastError = null
        emitUpdaterState()
    })

    autoUpdater.on('update-not-available', () => {
        if (updaterPhase === 'downloaded' && updaterDownloadedVersion) {
            emitUpdaterState()
            return
        }
        updaterPhase = 'idle'
        updaterAvailableVersion = null
        updaterProgress = null
        emitUpdaterState()
    })

    autoUpdater.on('download-progress', (progress) => {
        updaterPhase = 'downloading'
        const pct =
            typeof progress.percent === 'number'
                ? Math.round(progress.percent)
                : progress.total > 0
                  ? Math.round((100 * progress.transferred) / progress.total)
                  : 0
        updaterProgress = {
            percent: Math.min(100, Math.max(0, pct)),
            transferred: progress.transferred,
            total: progress.total,
        }
        emitUpdaterState()
    })

    autoUpdater.on('update-downloaded', (info) => {
        const ver = info && info.version ? String(info.version) : updaterAvailableVersion || ''
        updaterPhase = 'downloaded'
        updaterDownloadedVersion = ver || null
        updaterAvailableVersion = ver || updaterAvailableVersion
        updaterProgress = null
        updaterLastError = null
        emitUpdaterState()
    })

    autoUpdater.on('error', (err) => {
        const msg = err && err.message ? String(err.message) : String(err)
        if (isNetworkUpdaterError(msg)) {
            console.warn('autoUpdater (network):', msg)
            if (updaterPhase === 'checking') {
                updaterPhase = 'idle'
                emitUpdaterState()
            }
            return
        }
        console.error('autoUpdater:', err)
        updaterPhase = 'error'
        updaterLastError = msg
        emitUpdaterState()
    })

    const runCheck = () => {
        autoUpdater.checkForUpdates().catch((err) => {
            console.warn('checkForUpdates:', err && err.message ? err.message : err)
        })
    }

    setTimeout(runCheck, UPDATE_CHECK_START_DELAY_MS)
    setInterval(runCheck, UPDATE_CHECK_INTERVAL_MS)
}

// Allow opening DevTools via keyboard even with frameless windows / no menu.
// This is helpful for debugging production issues (e.g., Edge Function 401s).
// Ctrl+Shift+I (Windows/Linux) or Cmd+Opt+I (macOS) will toggle DevTools.
function registerDevtoolsToggle(win) {
    if (!win || win.isDestroyed()) return;
    try {
        win.webContents.on('before-input-event', (event, input) => {
            const isMac = process.platform === 'darwin';
            const toggleCombo =
                (!isMac && input.control && input.shift && input.key && input.key.toLowerCase() === 'i') ||
                (isMac && input.meta && input.alt && input.key && input.key.toLowerCase() === 'i');
            if (!toggleCombo) return;
            event.preventDefault();
            if (win.webContents.isDevToolsOpened()) win.webContents.closeDevTools();
            else win.webContents.openDevTools({ mode: 'detach' });
        });
    } catch (e) {
        // no-op
    }
}

// Configure cache directory before app is ready to prevent permission errors
// This must be called before app.whenReady()
if (process.platform === 'win32') {
    // Use command line switches to configure cache
    // This prevents cache permission errors by using a writable location
    app.commandLine.appendSwitch('disk-cache-size', '10000000'); // 10MB cache
    
    // Set cache directory after app is ready (but configure early)
    app.whenReady().then(() => {
        try {
            const userDataPath = app.getPath('userData');
            const cachePath = path.join(userDataPath, 'Cache');
            
            // Ensure cache directory exists
            if (!fs.existsSync(cachePath)) {
                fs.mkdirSync(cachePath, { recursive: true });
            }
            
            // Set the cache path
            app.setPath('cache', cachePath);
        } catch (err) {
            // Ignore - will use default location if we can't set it
        }
    });
}


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
    const query = { title: title || 'Call Log', body: body || '' };
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
            contextIsolation: true,
            // Configure cache to use app's user data directory
            cache: true,
            partition: 'persist:main'
        },
        icon: getAppIconPath(),
        // Keep in sync with light theme --bg-primary
        backgroundColor: '#f6f7fb',
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

    registerDevtoolsToggle(mainWindow);

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

ipcMain.handle('get-master-key', () => {
    const envKey = (process.env.CALLLOG_MASTER_KEY || '').trim();
    if (envKey) return envKey;

    // Fallback: read local supabaseConfig.js for CALLLOG_MASTER_KEY in development.
    // This keeps renderer encryption working even when env vars are not set.
    try {
        const candidatePaths = [
            path.join(__dirname, 'supabaseConfig.js'),
            path.join(process.cwd(), 'supabaseConfig.js'),
            path.join(app.getAppPath(), 'supabaseConfig.js')
        ];

        for (const cfgPath of candidatePaths) {
            if (!fs.existsSync(cfgPath)) continue;
            const text = fs.readFileSync(cfgPath, 'utf8');

            const sandbox = { window: {} };
            vm.createContext(sandbox);
            vm.runInContext(text, sandbox, { timeout: 1000, filename: cfgPath });
            const vmKey = String(sandbox?.window?.supabaseConfig?.CALLLOG_MASTER_KEY || '').trim();
            if (vmKey) return vmKey;

            const m = text.match(/CALLLOG_MASTER_KEY\s*:\s*['"`]([^'"`\r\n]+)['"`]/);
            const regexKey = (m && m[1] ? String(m[1]).trim() : '');
            if (regexKey) return regexKey;
        }
        return '';
    } catch (e) {
        return '';
    }
});

ipcMain.handle('get-app-version', () => {
    return app.getVersion();
});

ipcMain.handle('updater-get-state', () => buildUpdaterSnapshot());

ipcMain.handle('updater-check-for-updates', async () => {
    if (!shouldRunAutoUpdater()) {
        return { ok: false, reason: 'unsupported' };
    }
    updaterLastError = null;
    updaterPhase = 'checking';
    emitUpdaterState();
    try {
        const result = await autoUpdater.checkForUpdates();
        return { ok: true, updateInfo: result && result.updateInfo ? result.updateInfo : null };
    } catch (err) {
        const msg = err && err.message ? String(err.message) : String(err);
        if (!isNetworkUpdaterError(msg)) {
            updaterPhase = 'error';
            updaterLastError = msg;
            emitUpdaterState();
        } else {
            updaterPhase = 'idle';
            emitUpdaterState();
        }
        return { ok: false, message: msg };
    }
});

ipcMain.handle('updater-download-update', async () => {
    if (!shouldRunAutoUpdater()) {
        return { ok: false, reason: 'unsupported' };
    }
    try {
        await autoUpdater.downloadUpdate();
        return { ok: true };
    } catch (err) {
        const msg = err && err.message ? String(err.message) : String(err);
        updaterPhase = 'error';
        updaterLastError = msg;
        emitUpdaterState();
        return { ok: false, message: msg };
    }
});

ipcMain.handle('updater-quit-and-install', () => {
    if (!shouldRunAutoUpdater()) {
        return { ok: false, reason: 'unsupported' };
    }
    setImmediate(() => {
        try {
            autoUpdater.quitAndInstall(false, true);
        } catch (err) {
            console.error('quitAndInstall:', err);
        }
    });
    return { ok: true };
});

// Local SQL database handlers removed - app now uses Supabase only
// All database operations are handled client-side via Supabase client

// This method will be called when Electron has finished initialization
app.whenReady().then(async () => {
    // Local SQL database initialization removed - using Supabase only
    createWindow();
    setupAutoUpdater();

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
