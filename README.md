# IT Support Call Logger - Desktop Application

A standalone Electron desktop application to quickly capture and log IT support call information.

## Features

- 📝 **Quick Form Entry**: Capture caller name, mobile number, organization, and support request
- 📅 **Automatic Timestamping**: Automatically records date and time of each call
- 💾 **Local Storage**: All data is stored locally (no server required)
- 📊 **View History**: See all logged calls in an easy-to-read format
- 🎨 **Modern UI**: Clean, professional interface that's easy to use
- 🖥️ **Standalone Desktop App**: Runs as a native desktop application

## Installation

### Prerequisites

- Node.js (v16 or higher) and npm installed on your system
- Download from: https://nodejs.org/

### Setup Steps

1. **Install Dependencies**
   ```bash
   npm install
   ```

2. **Run the Application**
   ```bash
   npm start
   ```

## Building for Distribution

### Build for Windows
```bash
npm run build-win
```
Creates installer and portable executable in the `dist` folder.

### Build for macOS
```bash
npm run build-mac
```
Creates DMG and ZIP files in the `dist` folder.

### Build for Linux
```bash
npm run build-linux
```
Creates AppImage and DEB packages in the `dist` folder.

### Build for All Platforms
```bash
npm run build
```

## How to Use

1. **Launch the Application**
   - Run `npm start` to launch the app
   - Or use the built executable from the `dist` folder

2. **Log a Call**
   - Fill in the form with:
     - Name (required)
     - Mobile Number (required)
     - Organization (required)
     - Support Request (required)
     - Date & Time (auto-filled with current time, but can be adjusted)
   - Click "Save Call"

3. **View Past Calls**
   - All logged calls appear in the right panel
   - Most recent calls appear at the top
   - Each entry shows all the captured information

4. **Clear Data**
   - Click "Clear All" to remove all logged entries (with native confirmation dialog)
   - Use "Clear Form" to reset the form without saving

## Data Storage

- All data is stored locally in Electron's localStorage
- Data persists between application sessions
- Data location varies by operating system:
  - **Windows**: `%APPDATA%\it-support-call-logger\`
  - **macOS**: `~/Library/Application Support/it-support-call-logger/`
  - **Linux**: `~/.config/it-support-call-logger/`
- To backup data, ensure your data directory is included in your backup routine.

## Project Structure

```
Work Automations/
├── index.html          # Main UI
├── styles.css          # Styling
├── script.js           # Application logic
├── main.js             # Electron main process
├── preload.js          # Electron preload script (security)
├── package.json        # Node.js dependencies and build config
└── build/              # Build assets (icons, etc.)
```

## Development

### Running in Development Mode
```bash
npm start
```

To enable DevTools for debugging, uncomment this line in `main.js`:
```javascript
mainWindow.webContents.openDevTools();
```

### Customizing the Icon

Replace the icon files in the `build/` folder:
- `icon.png` - For Linux (256x256 or 512x512)
- `icon.ico` - For Windows (multiple sizes: 16x16, 32x32, 48x48, 256x256)
- `icon.icns` - For macOS (multiple sizes)

You can use online tools like [CloudConvert](https://cloudconvert.com/) to convert between formats.

### Testing multi-user notifications (Supabase)

To see the **"Teammate logged a call"** notification (when someone else logs a call), run two app instances as two different Supabase users:

1. **Start two instances** (each keeps its own login and data):
   - Terminal 1: `npm run start:1`
   - Terminal 2: `npm run start:2`

2. **Log in as different users** in each window:
   - Window 1: sign up or log in as e.g. `user1@example.com`
   - Window 2: sign up or log in as e.g. `user2@example.com`  
   Both must use the same Supabase project (your `supabaseConfig.js`).

3. **Test:** In window 1, log a call (fill the form and save). Window 2 should show the tray notification: **"Teammate logged a call – with [name] – [org]"**. Repeat from window 2 to see the notification in window 1.

Ensure **Realtime** is enabled for the `calls` table in Supabase: **Dashboard → Database → Replication** → turn on for `public.calls`.

## Privacy & Security

- All data is stored locally on your device
- No data is sent to any server
- No internet connection required
- Uses Electron's context isolation for security
- You have full control over your data

## Troubleshooting

### "Cannot find module 'better-sqlite3'" after installing the app
The app uses **sql.js** for the database, not `better-sqlite3`. This error means the installed build was created from an older version of the project. To fix:

1. **Close** any running instance of "IT Support Call Logger" (and quit from the system tray if it’s there).
2. In this project folder run:
   ```bash
   npm install
   npm run build-win
   ```
3. Install the **new** build from the `dist` folder (e.g. run the NSIS installer in `dist` or use the portable exe).
4. Launch the newly installed app; it will use sql.js and the error should be gone.

### Build fails with "The process cannot access the file ... app.asar"
Something is locking the build output (often the installed app or an Electron process). Fix:

1. **Close** "IT Support Call Logger" completely (Task Manager → end any "IT Support Call Logger" or "Electron" processes if needed).
2. From the project folder run a clean build:
   ```bash
   npm run build-win:fresh
   ```
   This removes the `dist` folder then builds. If `dist` is locked, the clean step will fail—close the app and try again.
3. Or manually: delete the `dist` folder, then run `npm run build-win`.

### Application won't start
- Ensure Node.js is installed: `node --version`
- Reinstall dependencies: `rm -rf node_modules && npm install` (or on Windows: remove `node_modules` and run `npm install`)

### Build fails (general)
- Make sure all dependencies are installed: `npm install`
- Check that electron-builder is installed: `npm list electron-builder`

### Data not persisting
- Check application data directory permissions
- Ensure you're not running in a restricted environment

## Future Enhancements

Potential features that could be added:
- Search/filter functionality
- Edit existing entries
- Print functionality
- Integration with ticketing systems
- Cloud sync (optional)
- Customizable fields
- Data import in multiple formats

## License

MIT

---

**Note**: This application stores data locally. If you uninstall the application, you may lose data unless you have backed up the data directory.
