// Global state
let currentFilter = '';
let editingEntryId = null;
let selectedDay = null; // local day key: YYYY-MM-DD
let calendarMonth = null; // Date representing first day of visible month
let confirmResolver = null;

window.addEventListener('unhandledrejection', (event) => {
    console.error('Unhandled promise rejection (renderer):', event.reason);
});

// Initialize: Load existing entries and set current date/time
document.addEventListener('DOMContentLoaded', async () => {
    try {
        initTheme();
        await runMigrationIfNeeded();
        setCurrentDateTime();
        setupEventListeners();
        setupKeyboardShortcuts();
        setupTitlebar();
        await initializeHistoryDay();
        await renderCalendar(calendarMonth);
        await loadEntries();
        await updateStats();
        fitWindowToContent();
    } catch (err) {
        console.error('Startup error:', err);
    }
});

// Size the main window height to fit the full content (Electron only)
function fitWindowToContent() {
    if (typeof window.electronAPI?.setWindowHeight !== 'function') return;
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            const titlebar = document.querySelector('.titlebar');
            const formContainer = document.querySelector('.form-container');
            const titlebarHeight = titlebar ? titlebar.offsetHeight : 45;
            const containerPadding = 48;
            const formHeight = formContainer ? formContainer.scrollHeight : 600;
            const totalHeight = titlebarHeight + containerPadding + formHeight;
            window.electronAPI.setWindowHeight(totalHeight);
        });
    });
}

const THEME_KEY = 'calllogger-theme';

function initTheme() {
    const saved = localStorage.getItem(THEME_KEY);
    const theme = saved === 'dark' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', theme);
}

function getTheme() {
    return document.documentElement.getAttribute('data-theme') || 'light';
}

function setTheme(theme) {
    const value = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', value);
    localStorage.setItem(THEME_KEY, value);
    updateThemeToggleTitle();
}

function toggleTheme() {
    setTheme(getTheme() === 'dark' ? 'light' : 'dark');
}

function updateThemeToggleTitle() {
    const btn = document.getElementById('themeToggleBtn');
    if (!btn) return;
    btn.title = getTheme() === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
    btn.setAttribute('aria-label', btn.title);
}

async function runMigrationIfNeeded() {
    if (!window.electronAPI?.getEntries || !window.electronAPI?.importFromLocalStorage) return;
    try {
        const entries = await window.electronAPI.getEntries();
        if (entries.length > 0) return;
        const raw = localStorage.getItem('supportCalls');
        if (!raw) return;
        const arr = JSON.parse(raw);
        if (!Array.isArray(arr) || arr.length === 0) return;
        await window.electronAPI.importFromLocalStorage(arr);
        localStorage.removeItem('supportCalls');
    } catch (e) {
        console.error('Migration from localStorage failed', e);
    }
}

// Setup all event listeners
function setupEventListeners() {
    // Theme toggle
    document.getElementById('themeToggleBtn').addEventListener('click', () => {
        toggleTheme();
    });
    updateThemeToggleTitle();

    // Form submission handler
    document.getElementById('callForm').addEventListener('submit', handleFormSubmit);

    // Clear form button
    document.getElementById('clearBtn').addEventListener('click', clearForm);
    
    // Export button
    document.getElementById('exportBtn').addEventListener('click', exportToCSV);
    
    // Clear all button
    document.getElementById('clearAllBtn').addEventListener('click', clearAllEntries);
    
    // Search functionality (inside History panel)
    document.getElementById('searchBtn').addEventListener('click', toggleSearch);
    document.getElementById('closeSearch').addEventListener('click', toggleSearch);
    document.getElementById('searchInput').addEventListener('input', handleSearch);

    // History panel toggle and close
    document.getElementById('toggleHistoryPanel').addEventListener('click', toggleHistoryPanel);
    document.getElementById('closeHistoryPanelBtn').addEventListener('click', closeHistoryPanel);
    document.getElementById('historyPanelBackdrop').addEventListener('click', closeHistoryPanel);
    
    // Stats button
    document.getElementById('statsBtn').addEventListener('click', showStats);

    // Day / calendar controls
    document.getElementById('historyPrevDayBtn')?.addEventListener('click', () => shiftSelectedDay(-1));
    document.getElementById('historyNextDayBtn')?.addEventListener('click', () => shiftSelectedDay(1));
    document.getElementById('historyTodayBtn')?.addEventListener('click', () => setSelectedDay(getTodayKey(), true));
    document.getElementById('historyCalendarBtn')?.addEventListener('click', openCalendar);

    document.getElementById('closeCalendarModal')?.addEventListener('click', closeCalendar);
    document.getElementById('calendarModal')?.addEventListener('click', (e) => {
        if (e.target?.id === 'calendarModal') closeCalendar();
    });
    document.getElementById('calPrevMonth')?.addEventListener('click', () => navigateCalendarMonth(-1));
    document.getElementById('calNextMonth')?.addEventListener('click', () => navigateCalendarMonth(1));
    
    // Confirm modal
    document.getElementById('closeConfirmModal')?.addEventListener('click', () => closeConfirm(false));
    document.getElementById('confirmCancelBtn')?.addEventListener('click', () => closeConfirm(false));
    document.getElementById('confirmOkBtn')?.addEventListener('click', () => closeConfirm(true));
    document.getElementById('confirmModal')?.addEventListener('click', (e) => {
        if (e.target?.id === 'confirmModal') closeConfirm(false);
    });

    // Modal handlers
    document.getElementById('closeModal').addEventListener('click', closeEditModal);
    document.getElementById('cancelEdit').addEventListener('click', closeEditModal);
    document.getElementById('editModalDeleteBtn').addEventListener('click', showEditModalDeleteConfirm);
    document.getElementById('editModalDeleteCancel').addEventListener('click', hideEditModalDeleteConfirm);
    document.getElementById('editModalDeleteConfirmBtn').addEventListener('click', confirmEditModalDelete);
    document.getElementById('closeStatsModal').addEventListener('click', closeStatsModal);
    document.getElementById('editForm').addEventListener('submit', handleEditSubmit);
    
    // Close modals on outside click
    document.getElementById('editModal').addEventListener('click', (e) => {
        if (e.target.id === 'editModal') closeEditModal();
    });
    document.getElementById('statsModal').addEventListener('click', (e) => {
        if (e.target.id === 'statsModal') closeStatsModal();
    });

    setupEntriesListClick();
}

// ---------- Day helpers ----------
function toLocalDayKey(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function parseDayKey(dayKey) {
    const [y, m, d] = dayKey.split('-').map(Number);
    return new Date(y, m - 1, d);
}

function getTodayKey() {
    return toLocalDayKey(new Date());
}

function getDaysWithCalls(entries) {
    const set = new Set();
    for (const e of entries) {
        const dt = new Date(e.timestamp);
        if (!Number.isNaN(dt.getTime())) set.add(toLocalDayKey(dt));
    }
    return set;
}

function formatDayLabel(dayKey) {
    const todayKey = getTodayKey();
    if (dayKey === todayKey) return 'Today';

    const date = parseDayKey(dayKey);
    return date.toLocaleDateString(undefined, {
        weekday: 'short',
        year: 'numeric',
        month: 'short',
        day: 'numeric'
    });
}

function updateDayLabel() {
    const el = document.getElementById('historyDayLabel');
    if (!el || !selectedDay) return;
    el.textContent = formatDayLabel(selectedDay);
    el.title = selectedDay;
}

async function initializeHistoryDay() {
    const entries = await getEntries();
    const todayKey = getTodayKey();
    const days = getDaysWithCalls(entries);

    if (days.has(todayKey)) {
        selectedDay = todayKey;
    } else if (entries.length > 0 && entries[0].timestamp) {
        const newest = new Date(entries[0].timestamp);
        selectedDay = Number.isNaN(newest.getTime()) ? todayKey : toLocalDayKey(newest);
    } else {
        selectedDay = todayKey;
    }

    calendarMonth = parseDayKey(selectedDay);
    calendarMonth.setDate(1);
    updateDayLabel();
}

async function setSelectedDay(dayKey, closeCalendarAfter = false) {
    selectedDay = dayKey;
    updateDayLabel();

    // keep calendar month in sync with selected day
    calendarMonth = parseDayKey(selectedDay);
    calendarMonth.setDate(1);

    await renderCalendar(calendarMonth);
    await loadEntries();
    await updateStats();
    if (closeCalendarAfter) closeCalendar();
}

function shiftSelectedDay(deltaDays) {
    if (!selectedDay) return;
    const d = parseDayKey(selectedDay);
    d.setDate(d.getDate() + deltaDays);
    setSelectedDay(toLocalDayKey(d)); // fire-and-forget async
}

// ---------- Calendar ----------
async function openCalendar() {
    const modal = document.getElementById('calendarModal');
    if (!modal) return;
    modal.classList.add('show');
    modal.setAttribute('aria-hidden', 'false');
    await renderCalendar(calendarMonth || new Date());
}

function closeCalendar() {
    const modal = document.getElementById('calendarModal');
    if (!modal) return;
    modal.classList.remove('show');
    modal.setAttribute('aria-hidden', 'true');
}

function navigateCalendarMonth(deltaMonths) {
    if (!calendarMonth) {
        calendarMonth = new Date();
        calendarMonth.setDate(1);
    }
    const d = new Date(calendarMonth);
    d.setMonth(d.getMonth() + deltaMonths);
    d.setDate(1);
    calendarMonth = d;
    renderCalendar(calendarMonth);
}

async function renderCalendar(monthDate) {
    const grid = document.getElementById('calendarGrid');
    const label = document.getElementById('calendarMonthLabel');
    if (!grid || !label) return;

    const monthStart = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1);

    label.textContent = monthStart.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

    const entries = await getEntries();
    const daysWithCalls = getDaysWithCalls(entries);
    const todayKey = getTodayKey();

    // Build a 6x7 grid, Monday-first
    // JS getDay(): Sun=0..Sat=6. Convert so Mon=0..Sun=6
    const startDow = (monthStart.getDay() + 6) % 7;
    const firstCellDate = new Date(monthStart);
    firstCellDate.setDate(monthStart.getDate() - startDow);

    const cells = [];
    for (let i = 0; i < 42; i++) {
        const d = new Date(firstCellDate);
        d.setDate(firstCellDate.getDate() + i);
        const key = toLocalDayKey(d);
        const isOutside = d.getMonth() !== monthStart.getMonth();
        const isToday = key === todayKey;
        const isSelected = selectedDay && key === selectedDay;
        const hasCalls = daysWithCalls.has(key);

        const classes = [
            'cal-day',
            isOutside ? 'outside' : '',
            isToday ? 'today' : '',
            isSelected ? 'selected' : '',
            hasCalls ? 'has-calls' : ''
        ].filter(Boolean).join(' ');

        cells.push(`
            <button class="${classes}" type="button" data-day="${key}" aria-label="${key}">
                ${d.getDate()}
            </button>
        `);
    }

    grid.innerHTML = cells.join('');

    // Day click handlers
    grid.querySelectorAll('.cal-day').forEach((btn) => {
        btn.addEventListener('click', () => {
            const key = btn.getAttribute('data-day');
            if (key) setSelectedDay(key, true);
        });
    });
}

// ---------- Confirm modal ----------
function openConfirm({ title, message, detail, okLabel }) {
    const modal = document.getElementById('confirmModal');
    if (!modal) return Promise.resolve(false);

    document.getElementById('confirmTitle').textContent = title || 'Confirm';
    document.getElementById('confirmMessage').textContent = message || 'Are you sure?';
    document.getElementById('confirmDetail').textContent = detail || 'This action cannot be undone.';
    document.getElementById('confirmOkLabel').textContent = okLabel || 'Delete';

    modal.classList.add('show');
    modal.setAttribute('aria-hidden', 'false');

    // focus primary action for keyboard use
    setTimeout(() => document.getElementById('confirmOkBtn')?.focus(), 0);

    return new Promise((resolve) => {
        confirmResolver = resolve;
    });
}

function closeConfirm(result) {
    const modal = document.getElementById('confirmModal');
    if (!modal) return;
    modal.classList.remove('show');
    modal.setAttribute('aria-hidden', 'true');
    if (confirmResolver) {
        const resolve = confirmResolver;
        confirmResolver = null;
        resolve(!!result);
    }
}

// Setup keyboard shortcuts
function setupKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
        // Ctrl/Cmd combinations
        if (e.ctrlKey || e.metaKey) {
            switch(e.key.toLowerCase()) {
                case 'n':
                    e.preventDefault();
                    clearForm();
                    document.getElementById('name').focus();
                    break;
                case 'e':
                    e.preventDefault();
                    exportToCSV();
                    break;
                case 'l':
                    e.preventDefault();
                    clearForm();
                    break;
                case 'f':
                    e.preventDefault();
                    openHistoryPanelAndFocusSearch();
                    break;
            }
        }
        
        // Escape key
        if (e.key === 'Escape') {
            if (document.getElementById('editModal').classList.contains('show')) {
                closeEditModal();
            } else if (document.getElementById('statsModal').classList.contains('show')) {
                closeStatsModal();
            } else if (document.getElementById('calendarModal')?.classList.contains('show')) {
                closeCalendar();
            } else if (document.getElementById('confirmModal')?.classList.contains('show')) {
                closeConfirm(false);
            } else if (isHistoryPanelOpen()) {
                closeHistoryPanel();
            } else if (document.getElementById('searchContainer').style.display !== 'none') {
                toggleSearch();
            }
        }
    });
}

// History panel (slide-out)
function isHistoryPanelOpen() {
    const panel = document.getElementById('historyPanel');
    return panel?.classList.contains('is-open') ?? false;
}

function openHistoryPanel() {
    const panel = document.getElementById('historyPanel');
    const backdrop = document.getElementById('historyPanelBackdrop');
    const toggle = document.getElementById('toggleHistoryPanel');
    if (panel) panel.classList.add('is-open');
    if (backdrop) backdrop.classList.add('is-visible');
    if (backdrop) backdrop.setAttribute('aria-hidden', 'false');
    if (panel) panel.setAttribute('aria-hidden', 'false');
    if (toggle) {
        toggle.setAttribute('aria-expanded', 'true');
        toggle.classList.add('tb-history-active');
    }
}

function closeHistoryPanel() {
    const panel = document.getElementById('historyPanel');
    const backdrop = document.getElementById('historyPanelBackdrop');
    const toggle = document.getElementById('toggleHistoryPanel');
    if (panel) panel.classList.remove('is-open');
    if (backdrop) backdrop.classList.remove('is-visible');
    if (backdrop) backdrop.setAttribute('aria-hidden', 'true');
    if (panel) panel.setAttribute('aria-hidden', 'true');
    if (toggle) {
        toggle.setAttribute('aria-expanded', 'false');
        toggle.classList.remove('tb-history-active');
    }
}

function toggleHistoryPanel() {
    if (isHistoryPanelOpen()) closeHistoryPanel();
    else openHistoryPanel();
}

function openHistoryPanelAndFocusSearch() {
    if (!isHistoryPanelOpen()) openHistoryPanel();
    const container = document.getElementById('searchContainer');
    const input = document.getElementById('searchInput');
    if (container && input) {
        container.style.display = 'flex';
        setTimeout(() => input.focus(), 100);
    }
}

// Setup custom titlebar
function setupTitlebar() {
    // App action buttons (History, New, Export are in titlebar-right)
    const tbNewBtn = document.getElementById('tbNewBtn');
    const tbExportBtn = document.getElementById('tbExportBtn');

    if (tbNewBtn) tbNewBtn.addEventListener('click', () => { clearForm(); document.getElementById('name')?.focus(); });
    if (tbExportBtn) tbExportBtn.addEventListener('click', exportToCSV);

    // Window controls (Electron)
    const winMinBtn = document.getElementById('winMinBtn');
    const winMaxBtn = document.getElementById('winMaxBtn');
    const winCloseBtn = document.getElementById('winCloseBtn');

    if (window.electronAPI?.windowControls) {
        winMinBtn?.addEventListener('click', () => window.electronAPI.windowControls.minimize());
        winMaxBtn?.addEventListener('click', async () => {
            const isMax = await window.electronAPI.windowControls.maximizeToggle();
            setMaximizeButtonState(!!isMax);
        });
        winCloseBtn?.addEventListener('click', () => window.electronAPI.windowControls.close());

        // Initial state
        window.electronAPI.windowControls.isMaximized().then(setMaximizeButtonState).catch(() => {});
    } else {
        // Fallback for browser preview
        winMinBtn?.setAttribute('disabled', 'true');
        winMaxBtn?.setAttribute('disabled', 'true');
        winCloseBtn?.addEventListener('click', () => window.close());
    }
}

function setMaximizeButtonState(isMaximized) {
    const btn = document.getElementById('winMaxBtn');
    if (!btn) return;
    btn.textContent = isMaximized ? '❐' : '▢';
    btn.setAttribute('aria-label', isMaximized ? 'Restore' : 'Maximize');
    btn.setAttribute('title', isMaximized ? 'Restore' : 'Maximize');
}

// Set current date and time in the datetime-local input
function setCurrentDateTime() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    
    const dateTimeString = `${year}-${month}-${day}T${hours}:${minutes}`;
    document.getElementById('callDate').value = dateTimeString;
}

// Handle form submission
async function handleFormSubmit(e) {
    e.preventDefault();

    const callDateValue = document.getElementById('callDate').value;
    const entryDate = callDateValue ? new Date(callDateValue) : new Date();

    const formData = {
        name: document.getElementById('name').value.trim(),
        phone: document.getElementById('mobile').value.trim(),
        organization: document.getElementById('organization').value.trim(),
        deviceName: (document.getElementById('deviceName') && document.getElementById('deviceName').value) ? document.getElementById('deviceName').value.trim() : '',
        supportRequest: document.getElementById('supportRequest').value.trim(),
        notes: (document.getElementById('notes') && document.getElementById('notes').value) ? document.getElementById('notes').value.trim() : '',
        timestamp: entryDate.toISOString()
    };

    try {
        const saved = await saveEntry(formData);
        if (window.electronAPI?.createEntry && saved == null) {
            showNotification('Failed to save call. Check console for errors.');
            return;
        }
        showNotification('Call logged successfully!');
        clearForm();
        await setSelectedDay(toLocalDayKey(entryDate));
    } catch (err) {
        console.error('Save call failed:', err);
        showNotification('Failed to save call.');
    }
}

// Save entry (SQLite when in Electron, else localStorage). Returns id or null when using Electron.
async function saveEntry(entry) {
    if (window.electronAPI?.createEntry) {
        return await window.electronAPI.createEntry(entry);
    }
    const entries = await getEntries();
    const withId = { ...entry, id: Date.now(), dateTime: entry.timestamp };
    entries.unshift(withId);
    localStorage.setItem('supportCalls', JSON.stringify(entries));
    return withId.id;
}

// Get all entries (SQLite when in Electron, else localStorage)
async function getEntries() {
    if (window.electronAPI?.getEntries) {
        return await window.electronAPI.getEntries();
    }
    const stored = localStorage.getItem('supportCalls');
    return stored ? JSON.parse(stored) : [];
}

// Load and display entries
async function loadEntries() {
    const entries = await getEntries();
    const entriesList = document.getElementById('entriesList');

    // First filter by selected day (local day boundaries)
    const dayKey = selectedDay || getTodayKey();
    let filteredEntries = entries.filter((entry) => toLocalDayKey(new Date(entry.timestamp)) === dayKey);

    // Then apply text filter within the day
    if (currentFilter) {
        const filterLower = currentFilter.toLowerCase();
        filteredEntries = filteredEntries.filter(entry =>
            entry.name.toLowerCase().includes(filterLower) ||
            (entry.phone || entry.mobile || '').includes(filterLower) ||
            entry.organization.toLowerCase().includes(filterLower) ||
            (entry.deviceName && entry.deviceName.toLowerCase().includes(filterLower)) ||
            (entry.supportRequest && entry.supportRequest.toLowerCase().includes(filterLower)) ||
            (entry.notes && entry.notes.toLowerCase().includes(filterLower))
        );
    }
    
    if (filteredEntries.length === 0) {
        const totalForDay = entries.filter((entry) => toLocalDayKey(new Date(entry.timestamp)) === dayKey).length;
        const emptyIcon = entries.length === 0
            ? '<svg class="icon" aria-hidden="true"><use href="#i-empty"></use></svg>'
            : (totalForDay === 0
                ? '<svg class="icon" aria-hidden="true"><use href="#i-calendar"></use></svg>'
                : '<svg class="icon" aria-hidden="true"><use href="#i-search"></use></svg>');

        entriesList.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">${emptyIcon}</div>
                <p>${entries.length === 0 ? 'No calls logged yet' : (totalForDay === 0 ? 'No calls for this day' : 'No matching calls found')}</p>
                <p style="font-size: 0.9em; margin-top: 5px;">
                    ${entries.length === 0 ? 'Start logging calls using the form on the left' : (totalForDay === 0 ? 'Pick another day in the calendar' : 'Try adjusting your search terms')}
                </p>
            </div>
        `;
        return;
    }
    
    entriesList.innerHTML = filteredEntries.map(entry => createEntryCard(entry)).join('');
    
    await updateStats();
}

// Create HTML for an entry card
function createEntryCard(entry) {
    const date = new Date(entry.timestamp);
    const formattedDate = date.toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
    
    return `
        <div class="entry-card" data-id="${entry.id}" role="button" tabindex="0" title="Click to edit">
            <div class="entry-header">
                <div class="entry-name">${escapeHtml(entry.name)}</div>
                <span class="entry-date">${formattedDate}</span>
            </div>
            <div class="entry-detail">
                <strong>Phone:</strong> ${escapeHtml(entry.phone || entry.mobile || '')}
            </div>
            <div class="entry-detail">
                <strong>Organization:</strong> ${escapeHtml(entry.organization)}
            </div>
            ${entry.deviceName ? `<div class="entry-detail"><strong>Device:</strong> ${escapeHtml(entry.deviceName)}</div>` : ''}
            <div class="entry-request copyable-request" data-copy-text="${escapeHtmlAttr((entry.supportRequest || '').trim() + (entry.deviceName ? '\n' + (entry.deviceName || '').trim() : ''))}" title="Click to copy request and device">
                <strong>Request:</strong> ${escapeHtml(entry.supportRequest)}
            </div>
            ${entry.notes ? `<div class="entry-notes"><strong>Notes:</strong> ${escapeHtml(entry.notes)}</div>` : ''}
        </div>
    `;
}

// Delegated click: request area copies; rest of card opens edit
function setupEntriesListClick() {
    const list = document.getElementById('entriesList');
    if (!list) return;
    list.addEventListener('click', (e) => {
        const copyable = e.target.closest('.copyable-request');
        if (copyable) {
            const text = copyable.getAttribute('data-copy-text');
            if (text != null && text !== '') {
                navigator.clipboard.writeText(text).then(() => {
                    showNotification('Copied!');
                }).catch(() => {});
            }
            e.stopPropagation();
            e.preventDefault();
            return;
        }
        const card = e.target.closest('.entry-card');
        if (!card) return;
        const id = parseInt(card.getAttribute('data-id'));
        if (!Number.isNaN(id)) editEntry(id);
    });
    list.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const card = e.target.closest('.entry-card');
        if (!card) return;
        e.preventDefault();
        const id = parseInt(card.getAttribute('data-id'));
        if (!Number.isNaN(id)) editEntry(id);
    });
}

// Edit entry
async function editEntry(id) {
    const entries = await getEntries();
    const entry = entries.find(e => e.id === id);
    
    if (!entry) return;
    
    editingEntryId = id;
    document.getElementById('editId').value = id;
    document.getElementById('editName').value = entry.name;
    document.getElementById('editMobile').value = entry.phone || entry.mobile || '';
    document.getElementById('editOrganization').value = entry.organization;
    const editDeviceEl = document.getElementById('editDeviceName');
    if (editDeviceEl) editDeviceEl.value = entry.deviceName || '';
    document.getElementById('editSupportRequest').value = entry.supportRequest || '';
    const notesEl = document.getElementById('editNotes');
    if (notesEl) notesEl.value = entry.notes || '';
    
    // Set date
    const date = new Date(entry.timestamp);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    document.getElementById('editDate').value = `${year}-${month}-${day}T${hours}:${minutes}`;
    
    document.getElementById('editModal').classList.add('show');
    document.getElementById('editName').focus();
}

// Handle edit form submission
async function handleEditSubmit(e) {
    e.preventDefault();
    
    const id = parseInt(document.getElementById('editId').value);
    const fields = {
        name: document.getElementById('editName').value.trim(),
        phone: document.getElementById('editMobile').value.trim(),
        organization: document.getElementById('editOrganization').value.trim(),
        deviceName: (document.getElementById('editDeviceName') && document.getElementById('editDeviceName').value) ? document.getElementById('editDeviceName').value.trim() : '',
        supportRequest: document.getElementById('editSupportRequest').value.trim(),
        notes: document.getElementById('editNotes') ? document.getElementById('editNotes').value.trim() : ''
    };
    const editDateVal = document.getElementById('editDate').value;
    if (editDateVal) fields.callTime = new Date(editDateVal).toISOString();

    if (window.electronAPI?.updateEntry) {
        await window.electronAPI.updateEntry(id, fields);
    } else {
        const entries = await getEntries();
        const idx = entries.findIndex(e => e.id === id);
        if (idx === -1) return;
        entries[idx] = { ...entries[idx], ...fields, timestamp: fields.callTime || entries[idx].timestamp };
        localStorage.setItem('supportCalls', JSON.stringify(entries));
    }
    closeEditModal();
    await loadEntries();
    await updateStats();
    showNotification('Entry updated successfully!');
}

// Inline delete confirmation in Edit modal
function showEditModalDeleteConfirm() {
    const actions = document.getElementById('editModalActions');
    const confirm = document.getElementById('editModalDeleteConfirm');
    if (actions) actions.classList.add('edit-modal-actions-hidden');
    if (confirm) {
        confirm.setAttribute('aria-hidden', 'false');
    }
}

function hideEditModalDeleteConfirm() {
    const actions = document.getElementById('editModalActions');
    const confirm = document.getElementById('editModalDeleteConfirm');
    if (actions) actions.classList.remove('edit-modal-actions-hidden');
    if (confirm) confirm.setAttribute('aria-hidden', 'true');
}

async function confirmEditModalDelete() {
    const id = editingEntryId;
    if (!id) return;
    if (window.electronAPI?.deleteEntry) {
        await window.electronAPI.deleteEntry(id);
    } else {
        const entries = await getEntries();
        const filtered = entries.filter(e => e.id !== id);
        localStorage.setItem('supportCalls', JSON.stringify(filtered));
    }
    closeEditModal();
    await loadEntries();
    await updateStats();
    showNotification('Entry deleted successfully!');
}

// Legacy handler name in case referenced elsewhere
function handleEditModalDelete() {
    showEditModalDeleteConfirm();
}

// Delete entry
async function deleteEntry(id) {
    const confirmed = await openConfirm({
        title: 'Delete entry',
        message: 'Delete this call log entry?',
        detail: 'This action cannot be undone.',
        okLabel: 'Delete'
    });
    
    if (confirmed) {
        if (window.electronAPI?.deleteEntry) {
            await window.electronAPI.deleteEntry(id);
        } else {
            const entries = await getEntries();
            const filtered = entries.filter(e => e.id !== id);
            localStorage.setItem('supportCalls', JSON.stringify(filtered));
        }
        await loadEntries();
        await updateStats();
        showNotification('Entry deleted successfully!');
    }
}

// Close edit modal
function closeEditModal() {
    hideEditModalDeleteConfirm();
    document.getElementById('editModal').classList.remove('show');
    editingEntryId = null;
    document.getElementById('editForm').reset();
}

// Close stats modal
function closeStatsModal() {
    document.getElementById('statsModal').classList.remove('show');
}

// Toggle search
async function toggleSearch() {
    const container = document.getElementById('searchContainer');
    if (container.style.display === 'none') {
        container.style.display = 'flex';
        document.getElementById('searchInput').focus();
    } else {
        container.style.display = 'none';
        document.getElementById('searchInput').value = '';
        currentFilter = '';
        await loadEntries();
    }
}

// Handle search input
async function handleSearch(e) {
    currentFilter = e.target.value;
    await loadEntries();
}

// Show statistics
async function showStats() {
    const entries = await getEntries();
    const statsContent = document.getElementById('statsContent');
    
    if (entries.length === 0) {
        statsContent.innerHTML = '<p style="text-align: center; color: var(--text-secondary);">No data available</p>';
    } else {
        const orgs = new Set(entries.map(e => e.organization));
        const today = new Date();
        const last7Days = entries.filter(e => {
            const entryDate = new Date(e.timestamp);
            const diffDays = (today - entryDate) / (1000 * 60 * 60 * 24);
            return diffDays <= 7;
        });
        const oldest = new Date(entries[entries.length - 1].timestamp);
        const daysSpan = (today - oldest) / (1000 * 60 * 60 * 24);
        const safeDays = Math.max(daysSpan, 1);
        const avgPerDay = Math.round((entries.length / safeDays) * 10) / 10;
        
        statsContent.innerHTML = `
            <div class="stat-card">
                <div class="stat-value">${entries.length}</div>
                <div class="stat-label">Total Calls</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${orgs.size}</div>
                <div class="stat-label">Organizations</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${last7Days.length}</div>
                <div class="stat-label">Last 7 Days</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${avgPerDay}</div>
                <div class="stat-label">Avg/Day</div>
            </div>
        `;
    }
    
    document.getElementById('statsModal').classList.add('show');
}

// Update stats display
async function updateStats() {
    const entries = await getEntries();
    const statsEl = document.getElementById('entriesStats');

    const dayKey = selectedDay || getTodayKey();
    const entriesForDay = entries.filter((e) => toLocalDayKey(new Date(e.timestamp)) === dayKey);

    if (entries.length > 0) {
        const orgsForDay = new Set(entriesForDay.map(e => e.organization));
        const visibleCards = document.querySelectorAll('.entry-card').length;
        statsEl.innerHTML = `
            <strong>${formatDayLabel(dayKey)}</strong> •
            <strong>${entriesForDay.length}</strong> calls •
            <strong>${orgsForDay.size}</strong> orgs
            ${currentFilter && visibleCards !== entriesForDay.length ? ` • Filtered: <strong>${visibleCards}</strong> results` : ''}
        `;
        statsEl.classList.add('show');
    } else {
        statsEl.classList.remove('show');
    }
}

// Escape HTML to prevent XSS
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Escape for HTML attribute value (e.g. data-copy-text)
function escapeHtmlAttr(text) {
    if (text == null) return '';
    const s = String(text);
    return s
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// Clear form
function clearForm() {
    document.getElementById('callForm').reset();
    setCurrentDateTime();
    document.getElementById('name').focus();
}

// Show notification
function showNotification(message) {
    const notification = document.createElement('div');
    notification.className = 'notification';
    notification.textContent = message;
    document.body.appendChild(notification);
    
    setTimeout(() => {
        notification.style.animation = 'slideIn 0.3s ease reverse';
        setTimeout(() => notification.remove(), 300);
    }, 3000);
}

// Export to CSV
async function exportToCSV() {
    const entries = await getEntries();
    
    if (entries.length === 0) {
        showNotification('No entries to export');
        return;
    }
    
    const headers = ['Date & Time', 'Name', 'Phone', 'Organization', 'Device name', 'Support Request', 'Notes'];
    
    const rows = entries.map(entry => {
        const date = new Date(entry.timestamp).toLocaleString('en-US');
        return [
            date,
            entry.name,
            entry.phone || entry.mobile || '',
            entry.organization,
            (entry.deviceName || '').replace(/"/g, '""'),
            (entry.supportRequest || '').replace(/"/g, '""'),
            (entry.notes || '').replace(/"/g, '""')
        ].map(field => `"${field}"`).join(',');
    });
    
    const csvContent = [headers.map(h => `"${h}"`).join(','), ...rows].join('\n');
    
    if (window.electronAPI) {
        const defaultFilename = `support_calls_${new Date().toISOString().split('T')[0]}.csv`;
        const result = await window.electronAPI.saveFile(csvContent, defaultFilename);
        if (result) {
            showNotification('CSV exported successfully!');
        }
    } else {
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a');
        const url = URL.createObjectURL(blob);
        
        link.setAttribute('href', url);
        link.setAttribute('download', `support_calls_${new Date().toISOString().split('T')[0]}.csv`);
        link.style.visibility = 'hidden';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        
        showNotification('CSV exported successfully!');
    }
}

// Clear all entries
async function clearAllEntries() {
    const confirmed = await openConfirm({
        title: 'Clear all entries',
        message: 'Delete all call logs?',
        detail: 'This will remove every saved call log entry. This action cannot be undone.',
        okLabel: 'Clear all'
    });
    
    if (confirmed) {
        if (window.electronAPI?.clearAllEntries) {
            await window.electronAPI.clearAllEntries();
        } else {
            localStorage.removeItem('supportCalls');
        }
        await loadEntries();
        await updateStats();
        showNotification('All entries cleared');
    }
}
