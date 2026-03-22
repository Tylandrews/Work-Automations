# Call Log

Desktop app for IT support teams to capture and review support calls, with optional Supabase sync, reporting, and a small public marketing site.

| Resource | Link |
| -------- | ---- |
| **Repository** | [github.com/Tylandrews/Work-Automations](https://github.com/Tylandrews/Work-Automations) |
| **Live site (GitHub Pages)** | [tylandrews.github.io/Work-Automations](https://tylandrews.github.io/Work-Automations/) (after you [enable Pages](#github-pages-marketing-site)) |
| **Latest release** | [Releases](https://github.com/Tylandrews/Work-Automations/releases/latest) |

## GitHub Pages (marketing site)

The landing page for the project lives in [`Website/`](Website/). It is a static HTML page (no build step).

### Enable GitHub Pages

1. Push this repository to GitHub (if it is not already remote).
2. In the repo on GitHub, open **Settings → Pages**.
3. Under **Build and deployment**, set **Source** to **GitHub Actions** (not “Deploy from a branch”).
4. Push to `main`, or open the **Actions** tab and run **Deploy GitHub Pages** manually. The workflow [`.github/workflows/deploy-pages.yml`](.github/workflows/deploy-pages.yml) uploads the `Website` folder as the site root.
5. When the workflow succeeds, **Settings → Pages** shows the public URL (typically `https://<username>.github.io/<repo>/` for a project site).

### After the first deploy

[`Website/index.html`](Website/index.html) is configured for [Tylandrews/Work-Automations](https://github.com/Tylandrews/Work-Automations). The `og:image` URL assumes the site is served at `https://tylandrews.github.io/Work-Automations/`; if your Pages URL differs, update that meta tag accordingly.

## Desktop application

### Features

- **Quick form entry**: Caller name, mobile number, organization, and support request
- **Automatic timestamps**: Date and time for each call (adjustable)
- **History**: Searchable list of logged calls
- **Supabase**: Cloud storage, auth, multi-user features, and scheduled reporting (see [`REPORTING.md`](REPORTING.md))
- **Electron**: Native desktop app on Windows, macOS, and Linux

### Installation

**End users (no Node.js)**  
Distribute the built installer or portable executable from the `dist` folder after you run `npm run build-win` (or the platform-specific build). Users run the installer or portable exe only; they do not install Node.js.

**Developers**

**Prerequisites:** Node.js 18+ and npm — https://nodejs.org/

```bash
npm install
npm start
```

### Building for distribution

Built artifacts are self-contained (Electron runtime included). End users do not need Node.js.

**Windows**

```bash
npm run build-win
```

Output in `dist/`: NSIS installer (recommended) and portable `.exe`.

**macOS**

```bash
npm run build-mac
```

**Linux**

```bash
npm run build-linux
```

**All platforms**

```bash
npm run build
```

### How to use

1. Launch with `npm start`, or run a build from `dist/`.
2. **Log a call**: Fill name, mobile, organization, and support request (date/time defaults to now). Click **Save Call**.
3. **History**: Recent calls appear in the panel; newest first.
4. **Clear**: **Clear All** removes all entries (with confirmation). **Clear Form** resets the form without saving.

### Project structure

```
Work Automations/
├── Website/                 # Public marketing site (GitHub Pages)
├── index.html               # Electron renderer UI
├── styles.css
├── script.js
├── main.js                  # Electron main process
├── preload.js
├── package.json
├── build/                   # App icons and build assets
└── supabase/                # Edge functions and related config
```

### Supabase (developers)

Cloud features use Supabase. For local development and builds, create `supabaseConfig.js` from the example:

```bash
cp supabaseConfig.example.js supabaseConfig.js
```

Copy **Project URL** and **anon/public** key from Supabase **Settings → API** into `supabaseConfig.js`. The file is gitignored; production builds bundle the config for end users.

### Development notes

- Uncomment `mainWindow.webContents.openDevTools()` in `main.js` for DevTools.
- Replace icon files under `build/` as needed (`icon.png`, `icon.ico`, `icon.icns`).
- **Teammate notifications**: Run two instances (`npm run start:1` and `npm run start:2`), sign in as different Supabase users in each window, and ensure **Realtime** is enabled for `public.calls` in **Dashboard → Database → Replication**. Logging a call in one window should trigger a tray notification in the other.

### Privacy and security

- Supabase data is protected by Row Level Security (RLS); the anon key is intended for client use with RLS.
- Electron uses context isolation for the renderer.
- An internet connection is required when using cloud sync and related features.

### Troubleshooting

**“Cannot find module 'better-sqlite3'”**  
Rebuild from current source: close the app, `npm install`, `npm run build-win`, reinstall from `dist`. The app uses **sql.js**, not `better-sqlite3`.

**Build: file locked / `app.asar` in use**  
Close Call Log and Electron processes, then `npm run build-win:fresh` or delete `dist` and rebuild.

**App won’t start**  
Check `node --version`, run `npm install` again.

**Data**  
Data location depends on OS (e.g. Windows `%APPDATA%\Call Log\`). With Supabase, data is subject to your project’s RLS and backup policies.

## License

MIT

---

**Note:** Uninstalling the desktop app may remove local data unless you have backed up the app data directory or rely on Supabase for retention.
