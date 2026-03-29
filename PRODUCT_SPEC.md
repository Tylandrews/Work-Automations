# Product Specification: Call Log

## 1. Product summary

**Call Log** is an Electron desktop application for help-desk and IT support teams to **log, review, and analyze telephone support interactions**. It provides a focused intake workflow, calendar-based history, search, in-app statistics, optional organization lookup (when Autotask is configured), and optional **cloud sync and collaboration** via Supabase (authentication, shared data, realtime updates, desktop notifications, and scheduled reporting).

A separate static **marketing/documentation site** lives under `Website/` and is deployed to GitHub Pages; it is not the primary product surface.

## 2. Goals and purpose

| Goal | Description |
| ---- | ----------- |
| Fast capture | Reduce friction when logging a call so agents record consistent, structured information at the end of a conversation. |
| Findable history | Let users jump to any day, search within that day, and edit entries when corrections are needed. |
| Team awareness | When cloud features are enabled, teammates can see new activity (Realtime) and receive desktop notifications where configured. |
| Operational insight | Support weekly and monthly reporting snapshots stored in the database for management and review (see reporting pipeline). |

## 3. Target users and context

- **Primary:** Support agents and technicians who answer phones and need a dedicated tool instead of spreadsheets or ad-hoc notes.
- **Secondary:** Team leads who consume aggregated metrics via reporting tables or downstream tools.
- **Environment:** Desktop (Windows, macOS, Linux) via packaged Electron builds; network required for Supabase-backed features.

## 4. Platform and delivery

- **Client:** Electron application with context isolation; renderer loads `index.html` and related assets from the packaged app (not a hosted SPA in production).
- **Distribution:** Installers and portable executables published via GitHub Releases; end users do not install Node.js.
- **Backend (optional but expected for teams):** Supabase (Postgres, Auth, Realtime, Edge Functions). Client uses the **anon key** with Row Level Security; service role keys stay server-side only.

## 5. Core features

### 5.1 Structured call intake

The user can record a call with at least:

- Caller name  
- Organization (with optional autocomplete when Autotask integration is deployed and configured)  
- Telephone number  
- Optional device identifier  
- Support request (primary description)  
- Optional notes  
- Adjustable date and time (not limited to “right now”)

**Expected behavior:** Saving creates a persisted record according to the active data mode (cloud user must be signed in for Supabase-backed storage). Validation should prevent obviously broken submissions where the UI defines required fields.

### 5.2 Call history and calendar

- History is **scoped by selected calendar day**.  
- User can navigate between days via calendar UI.  
- Entries for the selected day are listed and can be **opened for editing**.  
- **Full-text search** applies within the selected day’s entries (not necessarily global search unless specified elsewhere in the product).

**Expected behavior:** Changing the day updates the list and search scope; edits persist and respect the same auth and RLS rules as creation.

### 5.3 Summary statistics

The application presents **in-app statistics** for the current context (e.g., counts and summaries aligned with the selected day or view as implemented in the UI).

**Expected behavior:** Stats stay consistent with the underlying list of calls for that context.

### 5.4 Authentication (Supabase)

- **Email-based sign-in** when `supabaseConfig.js` is present and the project is configured.  
- Signed-out or misconfigured states should degrade gracefully (clear messaging, no silent data loss beyond what the UI promises).

**Expected behavior:** Only authenticated users access their team’s data per RLS policies.

### 5.5 Realtime and notifications

- **Supabase Realtime** can reflect new calls for shared teams.  
- **Desktop notifications** may appear when new calls are recorded (where Electron and OS permissions allow).

**Expected behavior:** Multiple app instances signed in as different users can verify replication when Realtime is enabled on the relevant table (developer workflow documented in README).

### 5.6 Organization lookup (optional)

When the Edge Function `autotask-search-companies-v3` and secrets are configured, the UI can suggest or resolve **organization names** via Autotask.

**Expected behavior:** Without integration, organization remains a free-text field; with integration, search/autocomplete works within rate and security constraints of the backend.

### 5.7 Reporting snapshots (backend)

Scheduled or manual runs of the Edge Function `generate-reports` write **weekly (Friday)** and **monthly (end-of-month)** snapshots into `public.call_reports` with team- and user-scoped rows and JSON metrics (totals, unique orgs, per-user and per-org counts, daily timeseries).

**Expected behavior:** Idempotent backfill (up to defined lookback); never embed service role credentials in the desktop app; cron uses documented auth headers.

## 6. Security and privacy (requirements)

- **RLS** on Supabase tables governs what each user can read and write.  
- Renderer uses **context isolation** and preload bridges (`electronAPI`) for privileged operations (e.g., secure storage hooks, window controls, version, notifications).  
- **Master key** and other sensitive flows use IPC as implemented; testers on plain `http://localhost` will not have `electronAPI` and only partial behavior applies.

## 7. Non-goals and assumptions

- The product is **not** a full phone system or CTI integration by default; it logs metadata and notes about calls.  
- **Offline-first** operation is not described as a core requirement in existing docs; cloud features assume connectivity.  
- Automated browser testing against a static server validates **web-rendered UI** only unless Electron-specific test harnesses are used.

## 8. Success criteria (high level)

1. An agent can log a typical call in under a minute with the structured form.  
2. The same agent can find and edit that call on the correct calendar day using search when needed.  
3. With Supabase configured, two authenticated users on the same team see consistent data and optional realtime updates.  
4. Release builds install and launch without Node.js on the target OS.  
5. Reporting cron can populate `call_reports` without exposing service role keys to clients.

## 9. Related documentation

| Document | Content |
| -------- | ------- |
| `README.md` | Setup, build, release, Supabase configuration, troubleshooting |
| `REPORTING.md` | Metrics shape, cron schedule, secrets, verification SQL |
| `Website/` | Public marketing and documentation pages |

---

**Document version:** 1.0  
**Product name:** Call Log (repository: Work Automations)
