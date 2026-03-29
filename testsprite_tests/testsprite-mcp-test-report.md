# TestSprite MCP Test Report — Call Log (Work Automations)

## 1. Document Metadata

- **Project:** Call Log / Work Automations (Electron + static `index.html` served at `http://localhost:4173/` for this run)
- **Date:** 2026-03-28
- **Runner:** TestSprite MCP (`generateCodeAndExecute`), production static serve
- **Artifacts:** Raw output in `testsprite_tests/tmp/raw_report.md`, structured results in `testsprite_tests/tmp/test_results.json`, generated Playwright scripts under `testsprite_tests/TC*.py`
- **Dashboard:** Session and per-test recordings are linked from the raw report on testsprite.com (sign in to TestSprite to open them)

## 2. Requirement Validation Summary

### Supabase sign-in and sign-up

| ID | Title | Status | Notes |
|----|--------|--------|--------|
| TC001 | Valid sign-in reaches main shell | Passed | Credentials submitted; run marked passed (assertion was URL non-null; treat as weak signal and confirm manually in browser) |
| TC002 | Invalid credentials show error | Failed | No visible error text matched expectation after bad login |
| TC003 | Continue with local storage when no Supabase | Failed | With Supabase configured, "Continue with local storage" is not shown; test assumption does not match configured environment |
| TC004 | Block submit when email missing | Passed | HTML5 / form validation behaved as expected |
| TC005 | Block submit when password missing | Passed | HTML5 / form validation behaved as expected |
| TC029 | Account requires sign-in when signed out | Passed | Gating behaved as expected |
| TC030 | Sign in then open Account | Failed | Reported stuck on sign-in after submit |
| TC031 | Update display name and save | Failed | Blocked by auth not completing in automated session |
| TC032 | Cancel profile edits | Failed | Blocked by auth not completing in automated session |

### Call intake form

| ID | Title | Status | Notes |
|----|--------|--------|--------|
| TC007 | Create call with optional fields and custom datetime | Failed | Auth overlay not dismissed in session; form unreachable |
| TC008 | Required-field validation blocks submit | Failed | Same auth blocking |
| TC009 | Organization autocomplete and save | Passed | Flow completed in automated run |

### History and calendar

| ID | Title | Status | Notes |
|----|--------|--------|--------|
| TC011 | Change day and open entry | Failed | Auth blocked main UI |
| TC012 | Calendar pick date, empty list | Passed | Completed after sign-in path |
| TC013 | Day navigation updates list | Passed | Completed |

### Search

| ID | Title | Status | Notes |
|----|--------|--------|--------|
| TC015 | Search filters entries | Failed | Auth modal blocked |
| TC016 | No-results state | Failed | Auth modal blocked |
| TC017 | Results update as query changes | Failed | Reported filter showed no matches for substring that should match visible names |
| TC018 | Clear query restores list | Passed | Completed |

### Edit and delete

| ID | Title | Status | Notes |
|----|--------|--------|--------|
| TC019 | Edit entry and see update in list | Passed | Completed |
| TC020 | Invalid edit shows validation | Failed | Auth blocked in that run |
| TC021 | Delete with confirmation removes row | Failed | Agent reported list still showed entry after confirm |
| TC022 | Cancel delete keeps entry | Failed | Auth blocked in that run |

### Statistics

| ID | Title | Status | Notes |
|----|--------|--------|--------|
| TC023 | Open and close statistics modal | Failed | Auth blocked |
| TC024 | Zero-data statistics state | Failed | Auth blocked |

### Reports

| ID | Title | Status | Notes |
|----|--------|--------|--------|
| TC025 | Reports overlay opens | Failed | Auth blocked in that run |
| TC026 | Run or refresh reports | Failed | Auth blocked |
| TC027 | Unavailable when backend not configured | Failed | UI showed LOADING panels instead of explicit unavailable copy |
| TC028 | Close reports without side effects | Passed | Completed |

### Theme

| ID | Title | Status | Notes |
|----|--------|--------|--------|
| TC033 | Theme toggle updates UI | Failed | Toggle not found while auth screen dominated the view |

### Ungrouped / cross-cutting

Several failures share the same root cause: **inconsistent auth completion and overlay dismissal** across parallel headless runs (timing, tunnel latency, or flaky selectors), not necessarily a single app bug. TC001 passed while other runs reported "Signing in..." stuck or close button ineffective—worth reproducing locally with Playwright against `http://localhost:4173/`.

## 3. Coverage and Matching Metrics

- **Total automated cases:** 30  
- **Passed:** 10 (33.3%)  
- **Failed:** 20 (66.7%)  

| Requirement area | Total | Passed | Failed |
|------------------|------:|-------:|-------:|
| Supabase sign-in and sign-up | 8 | 4 | 4 |
| Call intake form | 3 | 1 | 2 |
| History and calendar | 3 | 2 | 1 |
| Search | 4 | 1 | 3 |
| Edit and delete | 4 | 1 | 3 |
| Statistics | 2 | 0 | 2 |
| Reports | 4 | 1 | 3 |
| Theme | 1 | 0 | 1 |

## 4. Key Gaps and Risks

1. **Auth and browser context:** The app is built for Electron; running the same HTML in a remote headless browser plus tunnel can diverge (storage, timing, CORS, Supabase rate limits). Many failures are "could not reach main UI" rather than feature-level assertions.

2. **Test data and configuration:** `testsprite_tests/tmp/config.json` stores TestSprite login placeholders used for scripted sign-in. **Do not commit real passwords**; rotate any credential that was ever placed in that file and prefer environment-based injection for CI.

3. **Invalid-login messaging (TC002):** If the product should always surface a visible error for bad passwords, align UI copy with what tests assert (e.g. explicit text), or relax assertions to `role="alert"` / `#authError` content.

4. **Local-only path (TC003):** Automated tests against a Supabase-enabled build cannot see `authNoConfig`. For that scenario, use a build with empty/disabled Supabase config or a dedicated test URL.

5. **Search behavior (TC017):** The run reported empty results for partial matches; deserves a focused manual or unit test of the client-side filter logic independent of TestSprite.

6. **Delete flow (TC021):** If reproducible locally, verify delete confirmation wiring and list refresh after Supabase/local persistence.

7. **Reports idle state (TC027):** If reporting is off, prefer a definitive empty or "not configured" state instead of indefinite LOADING so automated checks can pass.

**Next steps:** Open `testsprite_tests/tmp/raw_report.md` for TestSprite dashboard links and screen recordings; re-run after stabilizing auth (longer waits after login, stable selectors on `#authScreen` / `#appShell`, or `needLogin: false` with a pre-seeded localStorage session if TestSprite supports it).
