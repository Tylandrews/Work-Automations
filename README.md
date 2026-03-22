# Call Log

Call Log is an Electron desktop application for logging and reviewing telephone support interactions. It provides a dedicated intake form, calendar-based history, search, in-app statistics, and optional cloud synchronization through Supabase. A static marketing site is included under [`Website/`](Website/) for GitHub Pages.

| Resource | Link |
| -------- | ---- |
| Repository | [github.com/Tylandrews/Work-Automations](https://github.com/Tylandrews/Work-Automations) |
| Documentation site (GitHub Pages) | [tylandrews.github.io/Work-Automations](https://tylandrews.github.io/Work-Automations/) |
| Installers and release assets | [Releases](https://github.com/Tylandrews/Work-Automations/releases/latest) |

## Overview

The application is designed for help-desk and IT support workflows. Signed-in users store call records in a Supabase-backed database with row-level security. The interface supports optional organization lookup (where Autotask integration is configured), realtime updates for shared teams, desktop notifications, and scheduled reporting when the backend is configured accordingly. Details on reporting appear in [`REPORTING.md`](REPORTING.md).

## Features

- Structured call capture: caller name, organization, telephone number, optional device identifier, support request, optional notes, and adjustable date and time
- Call history scoped by day with calendar navigation, full-text search within the selected day, entry editing, and summary statistics
- Email-based authentication via Supabase where the project is configured
- Optional teammate notifications when new calls are recorded (Supabase Realtime)
- Cross-platform desktop delivery through Electron (Windows, macOS, Linux)

## Requirements

| Audience | Requirement |
| -------- | ------------- |
| End users (released builds) | No Node.js installation; run the published installer or portable executable from [Releases](https://github.com/Tylandrews/Work-Automations/releases/latest) |
| Contributors | Node.js 18 or newer and npm |

## Installation (end users)

Download the latest installer or portable executable for your platform from the [Releases](https://github.com/Tylandrews/Work-Automations/releases/latest) page. Executables produced by this project bundle the Electron runtime; end users do not install Node.js separately.

## Development

### Clone and run

```bash
git clone https://github.com/Tylandrews/Work-Automations.git
cd Work-Automations
npm install
npm start
```

### Build production artifacts

Production builds include the Electron runtime. Installers and portable packages are written to the `dist/` directory.

| Platform | Command |
| -------- | ------- |
| Windows | `npm run build-win` |
| macOS | `npm run build-mac` |
| Linux | `npm run build-linux` |
| All configured targets | `npm run build` |

On Windows, `npm run build-win` produces an NSIS installer and a portable executable. Close any running instance of the application before rebuilding if file locks occur.

To attach Chromium DevTools during local development, enable the appropriate call in `main.js` (see Electron documentation for `openDevTools`).

### Supabase configuration

Cloud features require a valid `supabaseConfig.js` (not committed to the repository). Copy the example file and supply the project URL and anon key from the Supabase dashboard (**Settings → API**).

```bash
cp supabaseConfig.example.js supabaseConfig.js
```

The build pipeline validates configuration where applicable. Release builds intended for distribution should embed the configuration required for production use.

### Project layout

```
├── Website/          Static marketing site (GitHub Pages)
├── index.html        Renderer UI
├── styles.css
├── script.js
├── main.js           Electron main process
├── preload.js
├── package.json
├── build/            Application icons and packaging assets
└── supabase/         Edge functions and related backend assets
```

## Documentation site (GitHub Pages)

The contents of [`Website/`](Website/) can be published with GitHub Actions. In the repository **Settings → Pages**, set **Build and deployment** source to **GitHub Actions** and use the workflow in [`.github/workflows/deploy-pages.yml`](.github/workflows/deploy-pages.yml). After a successful deployment, GitHub displays the public URL on the same settings page.

Absolute URLs in `Website/index.html` (for example Open Graph metadata) should match the deployed site URL if social previews are required.

## Security and privacy

- Database access is enforced with Supabase Row Level Security; client builds use the anon key as intended for public clients together with RLS policies
- The renderer runs with Electron context isolation enabled
- Network connectivity is required for cloud-backed features

## Troubleshooting

**Error referencing `better-sqlite3` after installation**  
Install a build produced from the current repository. Older builds may not match the present stack. From a clean tree: `npm install`, then rebuild with `npm run build-win` (or the appropriate platform command), and reinstall from `dist/`.

**Build failure: output files in use**  
Terminate all Call Log and Electron processes, then remove the `dist/` folder or run the Windows clean build script before building again.

**Application does not start in development**  
Confirm Node.js meets the version requirement and run `npm install` again.

**Data retention**  
Local application data paths follow Electron conventions by operating system. Uninstalling the application may remove local data unless it has been backed up or stored only in Supabase.

## Multi-instance testing (developers)

To verify teammate notifications, run two development instances (for example `npm run start:1` and `npm run start:2`), authenticate as distinct users, and ensure Realtime replication is enabled for the relevant table in the Supabase project.

## License

MIT License. See the repository for the full license text.
