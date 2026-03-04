// Global state
let currentFilter = '';
let editingEntryId = null;
let selectedDay = null; // local day key: YYYY-MM-DD
let calendarMonth = null; // Date representing first day of visible month
let confirmResolver = null;
let supabaseClient = null;
let supabaseRealtimeChannel = null;
let currentUserProfile = null; // { id, full_name } for logged-in user (Supabase)
const profileCache = new Map(); // user_id -> full_name

function useSupabase() {
    const config = window.supabaseConfig || {};
    const url = (config.SUPABASE_URL || '').trim();
    const key = (config.SUPABASE_ANON_KEY || '').trim();
    return url.length > 0 && key.length > 0;
}

function getSupabase() {
    if (supabaseClient) return supabaseClient;
    const config = window.supabaseConfig || {};
    if (typeof window.supabase !== 'undefined' && config.SUPABASE_URL && config.SUPABASE_ANON_KEY) {
        supabaseClient = window.supabase.createClient(config.SUPABASE_URL, config.SUPABASE_ANON_KEY);
    }
    return supabaseClient;
}

function mapRowToEntry(row) {
    return {
        id: row.id,
        name: row.name,
        phone: row.phone || '',
        organization: row.organization,
        deviceName: row.device_name || '',
        supportRequest: row.support_request || '',
        notes: row.notes || '',
        callTime: row.call_time,
        timestamp: row.call_time,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        user_id: row.user_id
    };
}

window.addEventListener('unhandledrejection', (event) => {
    console.error('Unhandled promise rejection (renderer):', event.reason);
});

async function loadCurrentUserProfile() {
    const supabase = getSupabase();
    if (!supabase) return;
    try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) {
            currentUserProfile = null;
            return;
        }
        const { data, error } = await supabase
            .from('profiles')
            .select('full_name')
            .eq('id', session.user.id)
            .single();
        if (error) {
            console.error('loadCurrentUserProfile error:', error);
            currentUserProfile = { id: session.user.id, full_name: session.user.email || 'You' };
            return;
        }
        currentUserProfile = { id: session.user.id, full_name: data.full_name || (session.user.email || 'You') };
        profileCache.set(session.user.id, currentUserProfile.full_name);
    } catch (err) {
        console.error('loadCurrentUserProfile exception:', err);
    }
}

async function getProfileNameByUserId(userId) {
    if (!userId) return null;
    if (profileCache.has(userId)) return profileCache.get(userId);
    const supabase = getSupabase();
    if (!supabase) return null;
    try {
        const { data, error } = await supabase
            .from('profiles')
            .select('full_name')
            .eq('id', userId)
            .single();
        if (error) {
            console.error('getProfileNameByUserId error:', error);
            return null;
        }
        const name = data.full_name || null;
        if (name) profileCache.set(userId, name);
        return name;
    } catch (err) {
        console.error('getProfileNameByUserId exception:', err);
        return null;
    }
}

// Initialize: auth gate then app
document.addEventListener('DOMContentLoaded', async () => {
    try {
        initTheme();
        const authScreen = document.getElementById('authScreen');
        const appShell = document.getElementById('appShell');

        if (useSupabase()) {
            const supabase = getSupabase();
            if (!supabase) {
                showApp(appShell, authScreen);
                await initApp();
                return;
            }
            const { data: { session } } = await supabase.auth.getSession();
            if (session) {
                await loadCurrentUserProfile();
                showApp(appShell, authScreen);
                await initApp();
                setupLogout();
                subscribeRealtime();
            } else {
                showAuth(authScreen, appShell);
                setupAuthListeners();
            }
        } else {
            showApp(appShell, authScreen);
            await initApp();
        }
    } catch (err) {
        console.error('Startup error:', err);
    }
});

function showApp(appShell, authScreen) {
    if (authScreen) {
        authScreen.classList.add('hidden');
        authScreen.setAttribute('aria-hidden', 'true');
    }
    if (appShell) {
        appShell.classList.remove('hidden');
        appShell.setAttribute('aria-hidden', 'false');
    }
}

function showAuth(authScreen, appShell) {
    if (appShell) {
        appShell.classList.add('hidden');
        appShell.setAttribute('aria-hidden', 'true');
    }
    if (authScreen) {
        authScreen.classList.remove('hidden');
        authScreen.setAttribute('aria-hidden', 'false');
        document.getElementById('authNoConfig')?.classList.add('hidden');
        document.querySelector('.auth-card')?.classList.remove('hidden');
    }
}

function setupAuthListeners() {
    const form = document.getElementById('authForm');
    const signUpBtn = document.getElementById('authSignUpBtn');
    const signInBtn = document.getElementById('authSignInBtn');
    const authError = document.getElementById('authError');
    const authScreen = document.getElementById('authScreen');
    const appShell = document.getElementById('appShell');
    const nameInput = document.getElementById('authName');
    const authNameGroup = document.getElementById('authNameGroup');
    const supabase = getSupabase();
    if (!supabase || !form) return;

    let authMode = 'login'; // 'login' | 'signup'

    function switchToSignupMode() {
        authMode = 'signup';
        if (authNameGroup) authNameGroup.style.display = '';
        if (nameInput) nameInput.setAttribute('required', '');
        if (signInBtn) signInBtn.textContent = 'Create account';
        if (signUpBtn) signUpBtn.textContent = 'Back to Log in';
        authError.textContent = '';
    }

    function switchToLoginMode() {
        authMode = 'login';
        if (authNameGroup) authNameGroup.style.display = 'none';
        if (nameInput) nameInput.removeAttribute('required');
        if (signInBtn) signInBtn.textContent = 'Log in';
        if (signUpBtn) signUpBtn.textContent = 'Sign up';
        authError.textContent = '';
    }

    async function doLogin() {
        authError.textContent = '';
        const email = document.getElementById('authEmail').value.trim();
        const password = document.getElementById('authPassword').value;
        if (!email || !password) {
            authError.textContent = 'Please enter email and password.';
            return;
        }
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) {
            authError.textContent = error.message || 'Invalid login';
            return;
        }
        if (data.session) {
            await loadCurrentUserProfile();
            showApp(appShell, authScreen);
            setupLogout();
            subscribeRealtime();
            await initApp();
        }
    }

    async function doSignUp() {
        authError.textContent = '';
        authError.style.color = '';
        const fullName = nameInput?.value.trim();
        if (!fullName) {
            authError.textContent = 'Please enter your name.';
            return;
        }
        const email = document.getElementById('authEmail').value.trim();
        const password = document.getElementById('authPassword').value;
        if (!email || !password) {
            authError.textContent = 'Please enter email and password.';
            return;
        }
        const btn = signInBtn;
        if (btn) {
            btn.disabled = true;
            btn.textContent = 'Signing up…';
        }
        try {
            const { data, error } = await supabase.auth.signUp({ email, password });
            if (error) {
                authError.textContent = error.message || 'Sign up failed';
                return;
            }
            if (data.user) {
                try {
                    const { error: profileError } = await supabase
                        .from('profiles')
                        .upsert({ id: data.user.id, full_name: fullName })
                        .single();
                    if (profileError) console.error('Profile upsert error:', profileError);
                } catch (profileErr) {
                    console.error('Profile upsert exception:', profileErr);
                }
            }
            if (data.user && !data.session) {
                authError.textContent = 'Check your email to confirm your account.';
                authError.style.color = 'var(--success)';
                return;
            }
            if (data.session) {
                await loadCurrentUserProfile();
                showApp(appShell, authScreen);
                setupLogout();
                subscribeRealtime();
                await initApp();
            }
        } catch (err) {
            authError.textContent = err?.message || 'Sign up failed. Check your connection.';
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.textContent = 'Create account';
            }
        }
    }

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (authMode === 'signup') {
            await doSignUp();
            return;
        }
        if (signInBtn) {
            signInBtn.disabled = true;
            const originalText = signInBtn.textContent;
            signInBtn.textContent = 'Signing in…';
            try {
                await doLogin();
            } catch (err) {
                authError.textContent = err?.message || 'Login failed. Check your connection.';
            } finally {
                signInBtn.disabled = false;
                signInBtn.textContent = originalText;
            }
        }
    });

    if (signUpBtn) {
        signUpBtn.addEventListener('click', () => {
            if (authMode === 'login') {
                switchToSignupMode();
                nameInput?.focus();
            } else {
                switchToLoginMode();
            }
        });
    }

    // Window controls on auth screen (move, minimize, maximize, close)
    setupWindowControls(
        document.getElementById('authWinMinBtn'),
        document.getElementById('authWinMaxBtn'),
        document.getElementById('authWinCloseBtn')
    );
    if (window.electronAPI?.windowControls) {
        window.electronAPI.windowControls.isMaximized().then(setMaximizeButtonState).catch(() => {});
    }
}

function setupLogout() {
    const logoutBtn = document.getElementById('logoutBtn');
    const profileBtn = document.getElementById('profileBtn');
    if (logoutBtn) logoutBtn.style.display = '';
    if (profileBtn) profileBtn.style.display = '';
    const handler = async () => {
        const supabase = getSupabase();
        if (supabase) {
            await supabase.auth.signOut();
            if (supabaseRealtimeChannel) {
                supabase.removeChannel(supabaseRealtimeChannel);
                supabaseRealtimeChannel = null;
            }
        }
        if (logoutBtn) logoutBtn.style.display = 'none';
        if (profileBtn) profileBtn.style.display = 'none';
        logoutBtn?.removeEventListener('click', handler);
        showAuth(document.getElementById('authScreen'), document.getElementById('appShell'));
    };
    logoutBtn?.addEventListener('click', handler);
}

function subscribeRealtime() {
    const supabase = getSupabase();
    if (!supabase || supabaseRealtimeChannel) return;
    const channel = supabase
        .channel('calls-inserts')
        .on(
            'postgres_changes',
            { event: 'INSERT', schema: 'public', table: 'calls' },
            async (payload) => {
                const { data: { user } } = await supabase.auth.getUser();
                if (!payload.new) return;
                const callerName = payload.new.name || 'Someone';
                const org = payload.new.organization || '';
                const takerId = payload.new.user_id;

                // Always refresh entries when a new call is inserted
                await loadEntries();

                // Do not show a \"teammate\" notification for your own inserts
                if (!user || !takerId || takerId === user.id) return;

                const takerName =
                    (currentUserProfile && currentUserProfile.id === takerId && currentUserProfile.full_name) ||
                    (await getProfileNameByUserId(takerId)) ||
                    'Teammate';

                showNotification(`New call from ${takerName}: ${callerName} – ${org}`);
                showDesktopNotification(
                    `${takerName} logged a call`,
                    `with ${callerName}${org ? ' – ' + org : ''}`
                );
            }
        )
        .subscribe((status, err) => {
            if (err) console.error('Realtime subscription error:', err);
            if (status === 'CHANNEL_ERROR') console.warn('Realtime: channel error. Ensure Database → Replication has public.calls enabled.');
        });
    supabaseRealtimeChannel = channel;
}

async function initApp() {
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
}

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
    
    // Clear all button
    document.getElementById('clearAllBtn').addEventListener('click', clearAllEntries);
    
    // Search functionality (inside History panel)
    document.getElementById('searchBtn').addEventListener('click', toggleSearch);
    document.getElementById('closeSearch').addEventListener('click', toggleSearch);
    document.getElementById('searchInput').addEventListener('input', handleSearch);

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

    // Profile / Account modal (Supabase only)
    document.getElementById('profileBtn')?.addEventListener('click', openProfileModal);
    document.getElementById('closeProfileModal')?.addEventListener('click', closeProfileModal);
    document.getElementById('profileCancelBtn')?.addEventListener('click', closeProfileModal);
    document.getElementById('profileForm')?.addEventListener('submit', handleProfileSubmit);
    
    // Close modals on outside click
    document.getElementById('editModal').addEventListener('click', (e) => {
        if (e.target.id === 'editModal') closeEditModal();
    });
    document.getElementById('statsModal').addEventListener('click', (e) => {
        if (e.target.id === 'statsModal') closeStatsModal();
    });
    document.getElementById('profileModal')?.addEventListener('click', (e) => {
        if (e.target.id === 'profileModal') closeProfileModal();
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
                case 'l':
                    e.preventDefault();
                    clearForm();
                    break;
                case 'f':
                    e.preventDefault();
                    focusSearch();
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
            } else if (document.getElementById('profileModal')?.classList.contains('show')) {
                closeProfileModal();
            } else if (document.getElementById('searchContainer').style.display !== 'none') {
                toggleSearch();
            }
        }
    });
}

// Focus search in history panel (Ctrl+F)
function focusSearch() {
    const container = document.getElementById('searchContainer');
    const input = document.getElementById('searchInput');
    if (container && input) {
        container.style.display = 'flex';
        setTimeout(() => input.focus(), 100);
    }
}

// Setup custom titlebar
function setupWindowControls(winMinBtn, winMaxBtn, winCloseBtn) {
    if (!winMinBtn && !winMaxBtn && !winCloseBtn) return;
    if (window.electronAPI?.windowControls) {
        winMinBtn?.addEventListener('click', () => window.electronAPI.windowControls.minimize());
        winMaxBtn?.addEventListener('click', async () => {
            const isMax = await window.electronAPI.windowControls.maximizeToggle();
            setMaximizeButtonState(!!isMax);
        });
        winCloseBtn?.addEventListener('click', () => window.electronAPI.windowControls.close());
    } else {
        winMinBtn?.setAttribute('disabled', 'true');
        winMaxBtn?.setAttribute('disabled', 'true');
        winCloseBtn?.addEventListener('click', () => window.close());
    }
}

function setupTitlebar() {
    // Window controls (Electron)
    const winMinBtn = document.getElementById('winMinBtn');
    const winMaxBtn = document.getElementById('winMaxBtn');
    const winCloseBtn = document.getElementById('winCloseBtn');
    setupWindowControls(winMinBtn, winMaxBtn, winCloseBtn);

    if (window.electronAPI?.windowControls) {
        // Initial state for main titlebar
        window.electronAPI.windowControls.isMaximized().then(setMaximizeButtonState).catch(() => {});
    }
}

function setMaximizeButtonState(isMaximized) {
    const text = isMaximized ? '❐' : '▢';
    const label = isMaximized ? 'Restore' : 'Maximize';
    const mainBtn = document.getElementById('winMaxBtn');
    const authBtn = document.getElementById('authWinMaxBtn');
    [mainBtn, authBtn].forEach(btn => {
        if (!btn) return;
        btn.textContent = text;
        btn.setAttribute('aria-label', label);
        btn.setAttribute('title', label);
    });
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
        if (saved == null && (window.electronAPI?.createEntry || useSupabase())) {
            showNotification('Failed to save call. Check console for errors.');
            return;
        }
        showNotification('Call logged successfully!');
        const takerName = currentUserProfile?.full_name || 'You';
        showDesktopNotification(
            `${takerName} logged a call`,
            `with ${formData.name || 'Unknown'}${formData.organization ? ' – ' + formData.organization : ''}`
        );
        clearForm();
        await setSelectedDay(toLocalDayKey(entryDate));
    } catch (err) {
        console.error('Save call failed:', err);
        showNotification('Failed to save call.');
    }
}

// Save entry (Supabase when configured, else SQLite/localStorage). Returns id or null.
async function saveEntry(entry) {
    if (useSupabase()) {
        const supabase = getSupabase();
        if (!supabase) return null;
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) return null;
        const now = new Date().toISOString();
        const callTime = entry.timestamp || now;
        const { data, error } = await supabase
            .from('calls')
            .insert({
                user_id: session.user.id,
                name: entry.name || '',
                phone: entry.phone || '',
                organization: entry.organization || '',
                device_name: entry.deviceName || '',
                support_request: entry.supportRequest || '',
                notes: entry.notes || '',
                call_time: callTime,
                created_at: now,
                updated_at: now
            })
            .select('id')
            .single();
        if (error) {
            console.error('createEntry Supabase error:', error);
            return null;
        }
        return data ? data.id : null;
    }
    if (window.electronAPI?.createEntry) {
        return await window.electronAPI.createEntry(entry);
    }
    const entries = await getEntries();
    const withId = { ...entry, id: Date.now(), dateTime: entry.timestamp };
    entries.unshift(withId);
    localStorage.setItem('supportCalls', JSON.stringify(entries));
    return withId.id;
}

// Get all entries (Supabase when configured, else SQLite/localStorage)
async function getEntries() {
    if (useSupabase()) {
        const supabase = getSupabase();
        if (!supabase) return [];
        const { data, error } = await supabase
            .from('calls')
            .select('*')
            .order('call_time', { ascending: false });
        if (error) {
            console.error('getEntries Supabase error:', error);
            return [];
        }
        return (data || []).map(mapRowToEntry);
    }
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
        <div class="entry-card" data-id="${escapeHtmlAttr(String(entry.id))}" role="button" tabindex="0" title="Click to edit">
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
        const id = card.getAttribute('data-id');
        if (id) editEntry(id);
    });
    list.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const card = e.target.closest('.entry-card');
        if (!card) return;
        e.preventDefault();
        const id = card.getAttribute('data-id');
        if (id) editEntry(id);
    });
}

// Edit entry (id may be number or uuid string)
async function editEntry(id) {
    const entries = await getEntries();
    const entry = entries.find(e => String(e.id) === String(id));
    
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
    
    const id = document.getElementById('editId').value;
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

    if (useSupabase()) {
        const supabase = getSupabase();
        if (supabase) {
            const { data: { session } } = await supabase.auth.getSession();
            if (session) {
                const { error } = await supabase
                    .from('calls')
                    .update({
                        name: fields.name,
                        phone: fields.phone,
                        organization: fields.organization,
                        device_name: fields.deviceName || '',
                        support_request: fields.supportRequest,
                        notes: fields.notes || '',
                        call_time: fields.callTime || new Date().toISOString(),
                        updated_at: new Date().toISOString()
                    })
                    .eq('id', id)
                    .eq('user_id', session.user.id);
                if (error) {
                    console.error('updateEntry Supabase error:', error);
                }
            }
        }
    } else if (window.electronAPI?.updateEntry) {
        await window.electronAPI.updateEntry(id, fields);
    } else {
        const entries = await getEntries();
        const idx = entries.findIndex(e => String(e.id) === String(id));
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
    if (useSupabase()) {
        const supabase = getSupabase();
        if (supabase) {
            const { data: { session } } = await supabase.auth.getSession();
            if (session) {
                await supabase.from('calls').delete().eq('id', id).eq('user_id', session.user.id);
            }
        }
    } else if (window.electronAPI?.deleteEntry) {
        await window.electronAPI.deleteEntry(id);
    } else {
        const entries = await getEntries();
        const filtered = entries.filter(e => String(e.id) !== String(id));
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

// Delete entry (id may be number or uuid)
async function deleteEntry(id) {
    const confirmed = await openConfirm({
        title: 'Delete entry',
        message: 'Delete this call log entry?',
        detail: 'This action cannot be undone.',
        okLabel: 'Delete'
    });
    
    if (confirmed) {
        if (useSupabase()) {
            const supabase = getSupabase();
            if (supabase) {
                const { data: { session } } = await supabase.auth.getSession();
                if (session) {
                    await supabase.from('calls').delete().eq('id', id).eq('user_id', session.user.id);
                }
            }
        } else if (window.electronAPI?.deleteEntry) {
            await window.electronAPI.deleteEntry(id);
        } else {
            const entries = await getEntries();
            const filtered = entries.filter(e => String(e.id) !== String(id));
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

// ---------- Profile / Account modal (Supabase) ----------
function openProfileModal() {
    if (!useSupabase() || !currentUserProfile) return;
    const supabase = getSupabase();
    if (!supabase) return;
    const errEl = document.getElementById('profileError');
    const nameEl = document.getElementById('profileName');
    const emailEl = document.getElementById('profileEmail');
    if (!nameEl || !emailEl) return;
    errEl.textContent = '';
    nameEl.value = currentUserProfile.full_name || '';
    supabase.auth.getSession().then(({ data: { session } }) => {
        emailEl.value = session?.user?.email || '';
    });
    document.getElementById('profileModal').classList.add('show');
    document.getElementById('profileModal').setAttribute('aria-hidden', 'false');
    setTimeout(() => nameEl.focus(), 0);
}

function closeProfileModal() {
    const modal = document.getElementById('profileModal');
    if (!modal) return;
    modal.classList.remove('show');
    modal.setAttribute('aria-hidden', 'true');
    document.getElementById('profileError').textContent = '';
}

async function handleProfileSubmit(e) {
    e.preventDefault();
    if (!useSupabase()) return;
    const supabase = getSupabase();
    if (!supabase) return;
    const errEl = document.getElementById('profileError');
    const nameEl = document.getElementById('profileName');
    const emailEl = document.getElementById('profileEmail');
    const saveBtn = document.getElementById('profileSaveBtn');
    const fullName = nameEl.value.trim();
    const newEmail = emailEl.value.trim();
    errEl.textContent = '';
    if (!fullName) {
        errEl.textContent = 'Please enter your name.';
        return;
    }
    if (!newEmail) {
        errEl.textContent = 'Please enter your email.';
        return;
    }
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
        errEl.textContent = 'Session expired. Please log in again.';
        return;
    }
    const originalText = saveBtn?.textContent;
    if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving…';
    }
    try {
        const { error: profileError } = await supabase
            .from('profiles')
            .upsert(
                { id: session.user.id, full_name: fullName, updated_at: new Date().toISOString() },
                { onConflict: 'id' }
            );
        if (profileError) {
            errEl.textContent = profileError.message || 'Failed to update name.';
            return;
        }
        if (newEmail !== (session.user.email || '')) {
            const { error: authError } = await supabase.auth.updateUser({ email: newEmail });
            if (authError) {
                errEl.textContent = authError.message || 'Failed to update email.';
                return;
            }
        }
        currentUserProfile = { id: session.user.id, full_name: fullName };
        profileCache.set(session.user.id, fullName);
        closeProfileModal();
        showNotification('Account updated.');
    } catch (err) {
        errEl.textContent = err?.message || 'Update failed.';
    } finally {
        if (saveBtn) {
            saveBtn.disabled = false;
            saveBtn.textContent = originalText || 'Save';
        }
    }
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

// Show desktop / tray notification when a call is logged (Discord-style near system tray in Electron)
function showDesktopNotification(title, body) {
    if (window.electronAPI?.showTrayNotification) {
        window.electronAPI.showTrayNotification(title || 'IT Support Call Logger', body || '');
        return;
    }
    if (typeof Notification === 'undefined') return;
    if (Notification.permission === 'denied') return;
    if (Notification.permission === 'default') {
        Notification.requestPermission().then(perm => {
            if (perm === 'granted') doShowDesktopNotification(title, body);
        });
        return;
    }
    doShowDesktopNotification(title, body);
}

function doShowDesktopNotification(title, body) {
    if (typeof Notification === 'undefined') return;
    try {
        const n = new Notification(title, { body, icon: undefined });
        n.onclick = () => {
            n.close();
            if (window.electronAPI?.focusApp) window.electronAPI.focusApp();
        };
    } catch (e) {
        console.warn('Desktop notification failed:', e);
    }
}

// Clear all entries (Supabase: only current user's; local: all)
async function clearAllEntries() {
    const confirmed = await openConfirm({
        title: 'Clear all entries',
        message: useSupabase() ? 'Delete all your call logs?' : 'Delete all call logs?',
        detail: useSupabase() ? 'This will remove every call log you created. This action cannot be undone.' : 'This will remove every saved call log entry. This action cannot be undone.',
        okLabel: 'Clear all'
    });
    
    if (confirmed) {
        if (useSupabase()) {
            const supabase = getSupabase();
            if (supabase) {
                const { data: { session } } = await supabase.auth.getSession();
                if (session) {
                    await supabase.from('calls').delete().eq('user_id', session.user.id);
                }
            }
        } else if (window.electronAPI?.clearAllEntries) {
            await window.electronAPI.clearAllEntries();
        } else {
            localStorage.removeItem('supportCalls');
        }
        await loadEntries();
        await updateStats();
        showNotification('All entries cleared');
    }
}
