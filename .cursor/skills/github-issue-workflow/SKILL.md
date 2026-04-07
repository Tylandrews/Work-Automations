---
name: github-issue-workflow
description: >-
  Manage GitHub issues end-to-end using the GitHub MCP server and the GitHub CLI
  (`gh`). Create issues, list open issues, pick an issue to work on, fix it in
  Cursor, then close the issue. Tie work to in-app release notes via Conventional
  Commits and the existing changelog pipeline. Use when the user asks to create a
  GitHub issue, work on an issue, close an issue, list issues, release notes, or
  manage the issue-to-fix workflow.
---

# GitHub Issue Workflow

A complete workflow for managing GitHub issues through Cursor using the GitHub MCP server (`user-github`) with the GitHub CLI (`gh`) as a fallback.

## Prerequisites

- The GitHub MCP server must be enabled in Cursor
- The GitHub CLI (`gh`) must be installed and authenticated (`gh auth login`)
- The repository remote must be a GitHub URL

## Tool Strategy

Always try the **MCP server first** -- it is faster and keeps context inside Cursor. If an MCP call fails with a permissions error (e.g. 403), **fall back to the `gh` CLI** via the Shell tool. The `gh` CLI uses the user's own GitHub auth token and has full read/write access.

## Determine Repository Info

Before calling any MCP tool, determine the `owner` and `repo` from the git remote:

```bash
git remote get-url origin
```

Parse the URL to extract:
- **owner**: the GitHub username or org (e.g. `Tylandrews`)
- **repo**: the repository name without `.git` (e.g. `Work-Automations`)

Use these values in all MCP calls below.

---

## Release notes and the in-app changelog

**Goal:** When you finish issue work, user-facing changes must show up under **Account → Release notes** in the app after the next versioned release.

### How it flows

1. **Commits on `main`** use [Conventional Commits](https://www.conventionalcommits.org/) (`feat`, `fix`, `perf`, etc.). The release script (`scripts/generate-release-changelog.js`) reads `git log` between the previous semver tag and the new tag and buckets subjects into **Added**, **Fixed**, **Changed**, **Maintenance**, and **Other**.
2. **Tagging `vX.Y.Z`** runs [`.github/workflows/release-electron.yml`](.github/workflows/release-electron.yml), which regenerates [`CHANGELOG.md`](CHANGELOG.md), [`changelog-bundled.json`](changelog-bundled.json), and `release-notes.md`. The desktop app loads `changelog-bundled.json` (see `loadAccountChangelog` in `script.js`).
3. **CI** runs [`scripts/validate-pr-conventional-commits.js`](scripts/validate-pr-conventional-commits.js) on every **pull request** so non-conventional subjects fail the check before merge (empty commit ranges pass).

### Commit message rules (required for issue work)

- **Format:** `type(optional-scope): description`
- **Types used for grouping:** `feat` (Added), `fix` (Fixed), `perf` / `refactor` (Changed), `chore` / `ci` / `build` / `docs` / `test` / `style` (Maintenance)
- **Link the issue** in the subject or body GitHub understands, for example: `fix(call-log): correct search debounce (fixes #42)` or put `fixes #42` in the PR / commit body
- **Squash merges:** The **squash commit title** must still follow the same pattern, or it will fail PR validation and land as a single bad line in history

### Local check before push

```bash
# Same as CI: compare PR base..head SHAs (example: against main)
git fetch origin main
BASE_SHA=$(git merge-base HEAD origin/main)
HEAD_SHA=$(git rev-parse HEAD)
BASE_SHA="$BASE_SHA" HEAD_SHA="$HEAD_SHA" node scripts/validate-pr-conventional-commits.js
```

### What does *not* update the app

Closing an issue, adding labels, or editing the issue body does **not** change the in-app panel. Only a **published release** (tag + workflow) refreshes `changelog-bundled.json` in the artifact users install.

---

## Defaults for Every Issue

These defaults apply to **every** issue created or updated through this workflow:

### Auto-Assign

Always assign the issue to **Tylandrews**. Never prompt for assignee -- it is always the repo owner.

### Auto-Label (Type)

Every issue **must** have at least one type label. Pick the most appropriate from:

| Label | When to use |
|-------|-------------|
| `bug` | Something is broken, behaves incorrectly, or regressed |
| `enhancement` | New feature, improvement to existing behavior, or UX polish |

If neither clearly fits, default to `enhancement`.

### GitHub Project Integration

Every issue **must** be added to the **Call Log Project** (project number `3`, owner `Tylandrews`).

After creating an issue, always:
1. Add it to the project
2. Set its **Priority** field
3. Optionally set **Status** (default to `Backlog` for new issues)

### Priority (via Project Field)

Priority is managed through the project's built-in Priority field, **not** through labels. Evaluate the issue against the criteria below and assign the best fit:

| Project value | Criteria |
|---------------|----------|
| `P0` | Blocks core functionality, causes data loss, or affects all users. Must be fixed immediately. |
| `P1` | Significant impact on usability or a key workflow. Should be addressed in the current sprint. |
| `P2` | Lower impact -- minor polish, nice-to-have, workarounds exist, or cosmetic. Address when convenient. |

**When unsure:** If the priority is ambiguous (e.g. could reasonably be `P1` or `P2`), **ask the user** before creating the issue. Present the options and your reasoning, then let the user decide.

### Project Field IDs (for gh CLI)

These IDs are needed when setting fields via `gh project item-edit`:

- **Project ID:** `PVT_kwHOA97V1c4BSsxC`
- **Priority field ID:** `PVTSSF_lAHOA97V1c4BSsxCzhAKDjs`
  - `P0`: option ID `79628723`
  - `P1`: option ID `0a877460`
  - `P2`: option ID `da944a9c`
- **Status field ID:** `PVTSSF_lAHOA97V1c4BSsxCzhAKDbc`
  - `Backlog`: option ID `f75ad846`
  - `Ready`: option ID `61e4505c`
  - `In progress`: option ID `47fc9ee4`
  - `In review`: option ID `df73e18b`
  - `Done`: option ID `98236657`

---

## Workflow Commands

The user can trigger any phase independently. Ask which phase they need if unclear.

---

### Phase 1: Create an Issue

When the user wants to create a new issue:

1. Ask for a **title** and **description** (or infer from conversation context)
2. Determine the **type label** (`bug` or `enhancement`) from context
3. Determine the **priority** (`P0`, `P1`, or `P2`) using the criteria above -- ask the user if unsure
4. Create the issue (assigned to Tylandrews, with type label):

```
CallMcpTool:
  server: "user-github"
  toolName: "issue_write"
  arguments:
    method: "create"
    owner: "<owner>"
    repo: "<repo>"
    title: "<issue title>"
    body: "<issue description in markdown>"
    labels: ["<type label>"]
    assignees: ["Tylandrews"]
```

**gh CLI fallback:**

```bash
gh issue create --repo <owner>/<repo> --title "<title>" --body "<body>" --label "<type>" --assignee Tylandrews
```

5. Add the issue to the Call Log Project and set priority:

```bash
# Add issue to project (returns the item ID)
gh project item-add 3 --owner Tylandrews --url <issue-url> --format json

# Set priority on the project item
gh project item-edit --project-id PVT_kwHOA97V1c4BSsxC --id <item-id> --field-id PVTSSF_lAHOA97V1c4BSsxCzhAKDjs --single-select-option-id <priority-option-id>

# Set status to Backlog
gh project item-edit --project-id PVT_kwHOA97V1c4BSsxC --id <item-id> --field-id PVTSSF_lAHOA97V1c4BSsxCzhAKDbc --single-select-option-id f75ad846
```

6. Confirm creation to the user and report the issue number, type label, and project priority

---

### Phase 2: List Open Issues

When the user wants to see what needs work:

```
CallMcpTool:
  server: "user-github"
  toolName: "list_issues"
  arguments:
    owner: "<owner>"
    repo: "<repo>"
    state: "OPEN"
    perPage: 10
    orderBy: "CREATED_AT"
    direction: "DESC"
```

**gh CLI fallback:**

```bash
gh issue list --repo <owner>/<repo> --state open --limit 10
```

Present the issues in a clear list format:
- **#number** - title (labels)

---

### Phase 3: Work on an Issue

When the user picks an issue to fix:

1. Read the full issue details:

```
CallMcpTool:
  server: "user-github"
  toolName: "issue_read"
  arguments:
    method: "get"
    owner: "<owner>"
    repo: "<repo>"
    issue_number: <number>
```

**gh CLI fallback:**

```bash
gh issue view <number> --repo <owner>/<repo>
```

2. Also fetch any comments for extra context:

```
CallMcpTool:
  server: "user-github"
  toolName: "issue_read"
  arguments:
    method: "get_comments"
    owner: "<owner>"
    repo: "<repo>"
    issue_number: <number>
```

**gh CLI fallback:**

```bash
gh issue view <number> --repo <owner>/<repo> --comments
```

3. Summarize the issue for the user
4. Create a todo list based on the issue requirements
5. Begin working on the fix using the codebase tools
6. **Release notes:** Plan the **Conventional Commit** line(s) that will appear in **Account → Release notes** after the next tag (see **Release notes and the in-app changelog** above). Prefer one logical change per commit with a clear user-facing description.
7. After fixing, recommend commits that will pass `validate-pr-conventional-commits.js` and map to the right changelog section, for example:
   - `fix(scope): short user-visible description (fixes #<number>)`
   - `feat(scope): short user-visible description (fixes #<number>)`
8. Optionally remind the user they can run the local `BASE_SHA` / `HEAD_SHA` check before opening a PR

---

### Phase 4: Close an Issue

When the user says the issue is done or asks to close it:

1. Confirm which issue number to close
2. Call the GitHub MCP tool:

```
CallMcpTool:
  server: "user-github"
  toolName: "issue_write"
  arguments:
    method: "update"
    owner: "<owner>"
    repo: "<repo>"
    issue_number: <number>
    state: "closed"
    state_reason: "completed"
```

**gh CLI fallback (use when MCP returns a 403):**

```bash
gh issue close <number> --repo <owner>/<repo> --reason completed
```

3. Confirm the issue was closed
4. **Release notes:** Remind the user that the in-app **Release notes** panel updates on the next **versioned release** (GitHub tag + `release-electron.yml`), not when the issue closes. If the fix is urgent to *describe* before release, the commit messages on `main` are already the source of truth for the next changelog entry

---

## Quick Reference

| Action | MCP Tool | gh CLI Fallback |
|--------|----------|-----------------|
| Create issue | `issue_write` (`method: "create"`) | `gh issue create --title "…" --body "…"` |
| List issues | `list_issues` (`state: "OPEN"`) | `gh issue list --state open` |
| Read issue | `issue_read` (`method: "get"`) | `gh issue view <number>` |
| Read comments | `issue_read` (`method: "get_comments"`) | `gh issue view <number> --comments` |
| Close issue | `issue_write` (`method: "update"`, `state: "closed"`) | `gh issue close <number> --reason completed` |
| Reopen issue | `issue_write` (`method: "update"`, `state: "open"`) | `gh issue reopen <number>` |
| Search issues | `search_issues` (`query: "…"`) | `gh issue list --search "…"` |
| Add comment | `add_issue_comment` | `gh issue comment <number> --body "…"` |
| Edit issue | `issue_write` (`method: "update"`, `title`/`body`) | `gh issue edit <number> --title "…"` |

### Release notes (no MCP)

| Action | Command / artifact |
|--------|----------------------|
| PR commit check (CI) | `node scripts/validate-pr-conventional-commits.js` with `BASE_SHA` + `HEAD_SHA` |
| Regenerate bundled changelog (release) | `node scripts/generate-release-changelog.js vX.Y.Z` (normally run by Actions) |
| In-app data | `changelog-bundled.json` (Account → Release notes) |

## Additional gh CLI Commands

These operations are only available via `gh` and extend the workflow beyond what the MCP server provides:

| Action | Command |
|--------|---------|
| View issue in browser | `gh issue view <number> --web` |
| Assign user | `gh issue edit <number> --add-assignee <user>` |
| Add/remove labels | `gh issue edit <number> --add-label "bug" --remove-label "wontfix"` |
| Pin issue | `gh issue pin <number>` |
| Transfer issue | `gh issue transfer <number> <destination-repo>` |
| Create from file | `gh issue create --title "…" --body-file ./description.md` |
| List with filters | `gh issue list --label "bug" --assignee "@me" --milestone "v2.0"` |

## Usage Examples

**User**: "Create an issue for the broken login button"
- Agent creates issue with title and description, reports issue number

**User**: "Show me open issues"
- Agent lists all open issues

**User**: "Work on issue #5"
- Agent reads issue #5, understands the problem, fixes the code, and uses a Conventional Commit so the change appears correctly in **Account → Release notes** after the next release

**User**: "Close issue #5"
- Agent closes the issue as completed

**User**: "Create an issue, fix it, then close it"
- Agent runs the full workflow end-to-end
