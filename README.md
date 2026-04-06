# Call Log

Call Log is an Electron desktop application for logging and reviewing telephone support interactions. It provides a dedicated intake form, calendar-based history, search, in-app statistics, and optional cloud synchronization through Supabase. A static marketing site is included under [`Website/`](Website/) for GitHub Pages.

[![Validate](https://github.com/Tylandrews/Work-Automations/actions/workflows/validate.yml/badge.svg)](https://github.com/Tylandrews/Work-Automations/actions/workflows/validate.yml)
[![E2E scenarios](https://img.shields.io/endpoint?url=https%3A%2F%2Ftylandrews.github.io%2FWork-Automations%2Fe2e-stats.json)](https://tylandrews.github.io/Work-Automations/)

The **E2E** badge reads [`Website/e2e-stats.json`](Website/e2e-stats.json) (static scenario count for the docs site). Playwright runs **locally** only; it is not executed in GitHub Actions. When you add or remove `e2e/TC*.py` files, update the `total` field (and `message` if you like) in that JSON.

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

### Auto-updates (Windows)

- **NSIS installer:** After you install from the setup executable, the app checks [Releases](https://github.com/Tylandrews/Work-Automations/releases/latest) for a newer version (first check a few seconds after launch, then about once every 24 hours). When an update finishes downloading, you get a prompt to restart and complete the install.
- **Portable `.exe`:** In-app auto-update is not supported. Download a newer build from Releases when you want to upgrade.
- **macOS and Linux:** Release automation in this repo currently publishes Windows artifacts only, so auto-update is not enabled for those platforms in the packaged app.
- **Forks or renamed repositories:** Set `build.publish` in `package.json` to your GitHub `owner` and `repo` so update metadata points at the correct Releases page.
- **Private repositories:** Reading release assets may require configuring a GitHub token for `electron-updater` (see upstream documentation). Public repositories do not need this.

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

**Windows NSIS artwork:** Branded wizard images live under [`nsis/branding/`](nsis/branding/) (`installer-sidebar.bmp`, `installer-header.bmp`). NSIS expects **uncompressed BMP** files at **164×314** (welcome/finish sidebar) and **150×57** (header strip on inner pages). They are regenerated during `prebuild` from [`Images/BigFish_Centered_Logo_Inverted.png`](Images/BigFish_Centered_Logo_Inverted.png) via [`scripts/generate-nsis-installer-assets.js`](scripts/generate-nsis-installer-assets.js); you can also run `npm run build:installer-assets` alone. Custom NSIS hooks are in [`nsis/installer.nsh`](nsis/installer.nsh).

To attach Chromium DevTools during local development, enable the appropriate call in `main.js` (see Electron documentation for `openDevTools`).

### End-to-end tests (Playwright)

| Command | Purpose |
| ------- | ------- |
| `npm run test:e2e` | Default local runner (live dashboard; higher parallelism unless you pass `-- --workers 1`). |
| `npm run test:e2e:ci` | Headless static HTML report, `--workers 1`, Chromium (`e2e/ci_e2e_shared.py`). |
| `npm run test:e2e:ci:firefox` | Same flags with Firefox. |

Configure `e2e/.env` from `e2e/.env.example` for local credentials.

### Automated release pipeline

This repository uses GitHub Actions for validation and release automation.

- [`.github/workflows/validate.yml`](.github/workflows/validate.yml) validates JavaScript syntax, runs `npm run test:unit`, builds icon assets, and on **pull requests** enforces [Conventional Commits](https://www.conventionalcommits.org/) on every commit in the PR (`scripts/validate-pr-conventional-commits.js`) so release automation can populate **Account → Release notes** correctly
- [`.github/workflows/release-electron.yml`](.github/workflows/release-electron.yml) builds and publishes Windows release assets when a tag in the format `vX.Y.Z` is pushed. It generates `release-notes.md` from commits since the previous semver tag, publishes that as the GitHub Release body, prepends the same summary to [`CHANGELOG.md`](CHANGELOG.md), refreshes [`changelog-bundled.json`](changelog-bundled.json) for the in-app **Account → Updates → Release notes** panel, then pushes those two tracked files to `main` (requires that branch to accept pushes from GitHub Actions)
- [`.github/workflows/deploy-pages.yml`](.github/workflows/deploy-pages.yml) deploys the committed [`Website/`](Website/) folder to GitHub Pages (no Playwright on Actions)

#### Release policy (version and tag alignment)

Release tags must match the app version in `package.json`.

Recommended flow:

```bash
npm version patch
git push
git push --tags
```

You can also use `minor` or `major` instead of `patch`. The release workflow validates that `vX.Y.Z` matches `package.json` before building.

#### Required repository secrets

Set these GitHub repository secrets before running release builds:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`

The release workflow creates `supabaseConfig.js` from these secrets at build time, then runs the existing build scripts.

#### Release outputs and recovery

- Expected release outputs are generated under `dist/` and uploaded to GitHub Releases (installer and related metadata files)
- If release fails:
  - Confirm tag format is `vX.Y.Z`
  - Confirm tag version matches `package.json`
  - Confirm required secrets are present
  - Re-run the workflow from the Actions tab after fixing the issue

### Supabase configuration

Cloud features require a valid `supabaseConfig.js` (not committed to the repository). Copy the example file and supply the project URL and anon key from the Supabase dashboard (**Settings → API**).

```bash
cp supabaseConfig.example.js supabaseConfig.js
```

The build pipeline validates configuration where applicable. Release builds intended for distribution should embed the configuration required for production use.

For organization autocomplete, apply migrations through `008_autotask_org_sync_meta.sql`. Deploy **`autotask-sync-all-companies`** for a weekly read-only full sync of active Autotask companies into `cached_autotask_companies` (see `supabase/functions/autotask-sync-all-companies/README.md`). The app loads org names from Supabase only; it does not call Autotask on each keystroke.

**Autotask is read-only from this app:** only zone lookup and `Companies/query` are used; nothing writes back to Autotask.

The legacy Edge Function `autotask-search-companies-v3` (per-query search) is optional and no longer required for the main UI autocomplete path.

Configure the same Autotask secrets for the sync function (`AUTOTASK_INTEGRATION_CODE`, `AUTOTASK_USERNAME`, `AUTOTASK_SECRET`, optional `AUTOTASK_ZONE_URL`, plus `SUPABASE_SERVICE_ROLE_KEY`).

#### Team statistics (administrators)

Administrators see a **Team statistics** control in the call history header. It opens an in-app workspace with overview charts, per-user totals, recent calls (metadata only), and a **Live** tab with in-app metrics plus instructions for the terminal dashboard.

Deploy the Edge Function after cloning or updating the repo (use **`--no-verify-jwt`** so the Supabase gateway does not validate the JWT before your code runs; this function still validates the session with `auth.getUser` and `profiles.is_admin`, same pattern as `account-admin`):

```bash
supabase functions deploy admin-analytics --no-verify-jwt
```

If you see **Invalid JWT** in the browser console when opening Team statistics, the function was likely deployed without `--no-verify-jwt`; redeploy with the flag above.

The function verifies the caller’s JWT and `profiles.is_admin`, then uses the service role to aggregate across all users. It does not return caller name, phone, or ciphertext fields.

**Terminal live line chart** ([blessed-contrib](https://github.com/yaronn/blessed-contrib)): from the repo root after `npm install`, set environment variables and run:

| Variable | Purpose |
| -------- | ------- |
| `SUPABASE_URL` | Same as in `supabaseConfig.js` |
| `SUPABASE_ANON_KEY` | Same anon key as the app |
| `CALL_LOG_ACCESS_TOKEN` | Your current session access token; in the app use **Copy access token** on the Team statistics **Live** tab (treat like a password; it expires with the session) |

```bash
npm run admin:live-dashboard
```

Use `q` or `Ctrl+C` to exit. On Windows, use a UTF-8 terminal (for example Windows Terminal) if box-drawing characters do not render correctly.

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
