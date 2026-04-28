# Changelog

All notable changes to **Call Log** are recorded here. Each GitHub release updates this file from commits since the previous version tag.

## [3.4.21] - 2026-04-28

### Fixed

- prevent Authorised Reps from flicking back to Recent Tickets when clicking tabs after ticket load
- fix Authorised Reps disappearing on unchanged org resolution by avoiding unnecessary hide/reset
- smooth Recent Tickets tab deselect transition with coordinated exit animation timing

### Changed

- hide Recent Tickets and Authorised Reps when no org is selected; keep Call History as default visible tab
- improve history tab header layout and integrated styling, including responsive width behavior as tabs appear
- add cascade-style entry animation for call history cards on load
- auto-open Recent Tickets when a new valid org is selected and show terminal-style `/ | \\` loading spinner

### Maintenance

- update changelog for v3.4.20

## [3.4.20] - 2026-04-09

### Maintenance

- update changelog for v3.4.19

## [3.4.19] - 2026-04-08

### Maintenance

- update changelog for v3.4.18

## [3.4.18] - 2026-04-06

### Maintenance

- update changelog for v3.4.16

## [3.4.16] - 2026-04-06

### Added

- add in-app feedback and feature request form

### Maintenance

- update changelog for v3.4.14

## [3.4.14] - 2026-04-06

### Added

- ticket source picklist API and call log updates

### Maintenance

- update changelog for v3.4.12

## [3.4.12] - 2026-04-06

### Added

- shared admin-managed regex rules for recent ticket colors (fixes #25)

### Maintenance

- update changelog for v3.4.11

### Other

- new file:   supabase/functions/autotask-recent-tickets/README.md 	new file:   supabase/functions/autotask-recent-tickets/deno.json 	new file:   supabase/functions/autotask-recent-tickets/index.ts

## [3.4.11] - 2026-04-06

### Summary

- See commit history for this release.








