"""
Locator patterns for Playwright E2E: prefer data-testid hooks with CSS fallbacks
so tests stay stable across refactors and partial rollbacks.
"""

# Entries list cards (see script.js renderEntryCard)
ENTRY_CARD = '[data-testid="entry-card"], .entry-card'

# Organization field autocomplete rows (script.js setupOrganizationAutocomplete)
ORG_AUTOCOMPLETE_ITEM = (
    '#organization-autocomplete-list [data-testid="autocomplete-item"], '
    '#organization-autocomplete-list .autocomplete-item'
)

# Toast messages (script.js showNotification)
APP_NOTIFICATION = '[data-testid="app-notification"], .notification'

# Reports grid tiles (script.js renderReportCard + loading skeleton)
REPORT_CARD = '[data-testid="report-card"], .report-card'

# Auth marketing card title (index.html)
AUTH_TITLE = '[data-testid="auth-title"], .auth-title'

# Missing Supabase config state (index.html)
AUTH_NO_CONFIG_TITLE = '[data-testid="auth-no-config-title"], .auth-no-config-title'

# Edit entry modal primary save (index.html #editForm)
EDIT_MODAL_SUBMIT = '[data-testid="edit-save-changes-btn"], button[type="submit"]'


def calendar_grid_day(empty_day: str) -> str:
    """Calendar cell for a given YYYY-MM-DD day key (data-day)."""
    return (
        f'#calendarGrid [data-testid="calendar-day"][data-day="{empty_day}"], '
        f'#calendarGrid button.cal-day[data-day="{empty_day}"]'
    )


def calendar_grid_any_day() -> str:
    """Any visible calendar day button (month navigation loops)."""
    return '#calendarGrid [data-testid="calendar-day"], #calendarGrid button.cal-day'


def history_entry_card(page, text_substring: str):
    """
    First #entriesList row whose visible text contains text_substring.

    Open the editor with .locator('.entry-name').click() — not .click() on the
    card root, since the default center hit can land on .copyable-request or
    .call-link and never open #editModal.
    """
    return page.locator("#entriesList").locator(ENTRY_CARD).filter(has_text=text_substring).first
