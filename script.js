// Global state
let currentFilter = '';
let editingEntryId = null;
let selectedDay = null; // local day key: YYYY-MM-DD
let calendarMonth = null; // Date representing first day of visible month
/** Serializes prev/next month clicks so rapid navigation still advances one month per click */
let calendarMonthNavChain = Promise.resolve()
let isCallDateAutoMode = true
let callDateAutoSyncIntervalId = null
let callDateAutoSyncTimeoutId = null
let confirmResolver = null;
let supabaseClient = null;
let supabaseRealtimeChannel = null;
let currentUserProfile = null; // { id, full_name, is_admin, profile_load_error? } for logged-in user (Supabase)
const profileCache = new Map(); // user_id -> full_name
const PROFILE_DISPLAY_NAME_MAX_LEN = 120;
let authDeepLinkListenerBound = false;

// #region agent log
fetch('http://127.0.0.1:7442/ingest/de52a58c-6176-4a1a-a3fe-7fb8f60f932e',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'76bee9'},body:JSON.stringify({sessionId:'76bee9',runId:'baseline',hypothesisId:'H6',location:'script.js:19',message:'scriptLoadedInstrumentationActive',data:{href:String(window.location?.href||''),readyState:String(document.readyState||'')},timestamp:Date.now()})}).catch(()=>{})
// #endregion

function clampDisplayName(raw) {
    const t = String(raw ?? '').trim();
    if (!t) return '';
    if (t.length <= PROFILE_DISPLAY_NAME_MAX_LEN) return t;
    return t.slice(0, PROFILE_DISPLAY_NAME_MAX_LEN);
}

function getPasswordRecoveryRedirectUrl() {
    const u = String(window.supabaseConfig?.PASSWORD_RESET_REDIRECT_URL || 'calllog://auth/callback').trim();
    return u || 'calllog://auth/callback';
}

function parseAuthHashParamsFromUrl(url) {
    try {
        const s = String(url);
        const i = s.indexOf('#');
        const hash = i >= 0 ? s.slice(i + 1) : '';
        const q = new URLSearchParams(hash);
        return {
            access_token: q.get('access_token'),
            refresh_token: q.get('refresh_token'),
            type: q.get('type'),
        };
    } catch {
        return { access_token: null, refresh_token: null, type: null };
    }
}

async function applyAuthDeepLinkSession(url) {
    const supabase = getSupabase();
    if (!supabase || !url) return { ok: false };
    const { access_token, refresh_token } = parseAuthHashParamsFromUrl(url);
    if (!access_token || !refresh_token) return { ok: false };
    const { error } = await supabase.auth.setSession({ access_token, refresh_token });
    if (error) {
        console.error('applyAuthDeepLinkSession:', error);
        return { ok: false, error };
    }
    return { ok: true };
}

/** Deploy: `supabase functions deploy account-admin` (use `--no-verify-jwt` if JWT is verified inside the function). */
const ACCOUNT_ADMIN_FUNCTION_SLUG = 'account-admin'
/** Deploy: `supabase functions deploy admin-analytics` */
const ADMIN_ANALYTICS_FUNCTION_SLUG = 'admin-analytics'
const ADMIN_LIST_PER_PAGE = 50

let currentAppView = 'calls'
let logoutClickHandler = null
let adminDirectoryPage = 1
/** Chart.js instance for admin team overview */
let adminStatsPageChart = null
let adminStatsLiveTimer = null
let adminRecentPage = 1
let accountAdminLoadedOnce = false

function destroyAdminStatsPageChart() {
    if (adminStatsPageChart) {
        try { adminStatsPageChart.destroy() } catch (_) {}
        adminStatsPageChart = null
    }
}

function stopAdminLivePolling() {
    if (adminStatsLiveTimer) {
        clearInterval(adminStatsLiveTimer)
        adminStatsLiveTimer = null
    }
}
let accountUpdaterUnsubscribe = null
let accountUpdaterListenersBound = false
let accountUpdaterToastVersion = null
let accountUpdaterToastDownloadedVersion = null
let accountChangelogLoadPromise = null

function setAppView(view) {
    const main = document.getElementById('mainWorkspace');
    const account = document.getElementById('accountWorkspace');
    const stats = document.getElementById('statsWorkspace');
    const adminStats = document.getElementById('adminStatsWorkspace');
    const backBtn = document.getElementById('accountBackBtn');
    const profileBtn = document.getElementById('profileBtn');
    if (!main || !account) return;

    const hideStats = () => {
        if (stats) {
            stats.classList.add('hidden');
            stats.setAttribute('aria-hidden', 'true');
        }
        destroyStatsPageChart();
    };

    const hideAdminStats = () => {
        if (adminStats) {
            adminStats.classList.add('hidden');
            adminStats.setAttribute('aria-hidden', 'true');
        }
        destroyAdminStatsPageChart();
        stopAdminLivePolling();
    };

    const showCallsShell = () => {
        currentAppView = 'calls';
        main.classList.remove('hidden');
        main.setAttribute('aria-hidden', 'false');
        account.classList.add('hidden');
        account.setAttribute('aria-hidden', 'true');
        hideStats();
        hideAdminStats();
        if (backBtn) backBtn.style.display = 'none';
        if (profileBtn && useSupabase() && getSupabase()) profileBtn.style.display = '';
        document.body?.setAttribute('data-shell', 'app');
    };

    if (view === 'account') {
        currentAppView = 'account';
        main.classList.add('hidden');
        main.setAttribute('aria-hidden', 'true');
        account.classList.remove('hidden');
        account.setAttribute('aria-hidden', 'false');
        hideStats();
        hideAdminStats();
        if (backBtn) backBtn.style.display = '';
        if (profileBtn) profileBtn.style.display = 'none';
        document.body?.setAttribute('data-shell', 'account');
        return;
    }

    if (view === 'statistics') {
        currentAppView = 'statistics';
        main.classList.add('hidden');
        main.setAttribute('aria-hidden', 'true');
        account.classList.add('hidden');
        account.setAttribute('aria-hidden', 'true');
        hideAdminStats();
        if (stats) {
            stats.classList.remove('hidden');
            stats.setAttribute('aria-hidden', 'false');
        }
        if (backBtn) backBtn.style.display = '';
        if (profileBtn) profileBtn.style.display = 'none';
        document.body?.setAttribute('data-shell', 'statistics');
        return;
    }

    if (view === 'adminStatistics') {
        if (!currentUserProfile?.is_admin) {
            showCallsShell();
            return;
        }
        currentAppView = 'adminStatistics';
        main.classList.add('hidden');
        main.setAttribute('aria-hidden', 'true');
        account.classList.add('hidden');
        account.setAttribute('aria-hidden', 'true');
        hideStats();
        if (adminStats) {
            adminStats.classList.remove('hidden');
            adminStats.setAttribute('aria-hidden', 'false');
        }
        if (backBtn) backBtn.style.display = '';
        if (profileBtn) profileBtn.style.display = 'none';
        document.body?.setAttribute('data-shell', 'admin-statistics');
        return;
    }

    showCallsShell();
}

const PII_KEY_NAME = 'calls_pii';
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const encryptionState = {
    enabled: false,
    initialized: false,
    keyVersion: 1,
    dataKey: null,
    blindKey: null,
    initPromise: null
};
const REQUIRE_ENCRYPTED_PII_WRITES = true;
const DEBUG_ENCRYPTION = true
let debugDecryptSkipLoggedCount = 0
let debugDecryptFailLoggedCount = 0

function isPiiWriteAllowed() {
    return encryptionState.enabled || !REQUIRE_ENCRYPTED_PII_WRITES;
}

// Autocomplete state
const autocompleteCache = new Map(); // query -> { results, timestamp }
const AUTOCACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
/** Debounce before hitting the network; instant path uses localStorage + memory cache first */
const AUTOCOMPLETE_DEBOUNCE_MS = 150
let autocompleteDebounceTimer = null;
let autocompleteActiveInstance = null; // Currently active autocomplete instance
const CACHED_AUTOTASK_COMPANIES_KEY = 'cached_autotask_companies';
/** Align with Edge Function autotask-sync-all-companies (weekly full sync). */
const ORG_FULL_SYNC_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
/** Upper bound for local org list (localStorage / memory). */
const CACHED_AUTOTASK_COMPANIES_LOCAL_MAX = 50000;
/** Parsed org list from localStorage; null means not loaded yet. */
let persistentAutotaskCompaniesMemory = null;

function addToCachedAutotaskCompanies(organizations) {
    const incoming = Array.isArray(organizations) ? organizations : [organizations];
    const normalizedIncoming = incoming
        .map((org) => {
            if (typeof org === 'string') return { id: '', name: org.trim() };
            return {
                id: String(org?.id || ''),
                name: String(org?.name || '').trim()
            };
        })
        .filter((org) => org.name);
    if (normalizedIncoming.length === 0) return;

    const existing = loadPersistentAutotaskCompanies();
    const byName = new Map(
        existing.map((org) => [org.name.toLowerCase(), org])
    );
    normalizedIncoming.forEach((org) => {
        byName.set(org.name.toLowerCase(), org);
    });
    let merged = Array.from(byName.values());
    if (merged.length > CACHED_AUTOTASK_COMPANIES_LOCAL_MAX) {
        merged = merged.slice(0, CACHED_AUTOTASK_COMPANIES_LOCAL_MAX);
    }
    persistentAutotaskCompaniesMemory = merged;
    try {
        localStorage.setItem(CACHED_AUTOTASK_COMPANIES_KEY, JSON.stringify(merged));
    } catch (err) {
        // Ignore localStorage errors
    }
}

function loadPersistentAutotaskCompanies() {
    if (persistentAutotaskCompaniesMemory !== null) {
        return persistentAutotaskCompaniesMemory;
    }
    try {
        const raw = localStorage.getItem(CACHED_AUTOTASK_COMPANIES_KEY);
        if (!raw) {
            persistentAutotaskCompaniesMemory = [];
            return persistentAutotaskCompaniesMemory;
        }
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
            persistentAutotaskCompaniesMemory = [];
            return persistentAutotaskCompaniesMemory;
        }
        persistentAutotaskCompaniesMemory = parsed
            .map((org) => ({
                id: String(org?.id || ''),
                name: String(org?.name || '').trim()
            }))
            .filter((org) => org.name);
        return persistentAutotaskCompaniesMemory;
    } catch (err) {
        persistentAutotaskCompaniesMemory = [];
        return persistentAutotaskCompaniesMemory;
    }
}

/**
 * Replace local org cache from a full server list (dedupe by autotask id or name).
 */
function replaceAllCachedAutotaskCompaniesLocal(organizations) {
    const byKey = new Map();
    for (const org of organizations) {
        const id = String(org?.id || '').trim();
        const name = String(org?.name || '').trim();
        if (!name) continue;
        const key = id || `name:${name.toLowerCase()}`;
        byKey.set(key, { id, name });
    }
    let list = Array.from(byKey.values());
    if (list.length > CACHED_AUTOTASK_COMPANIES_LOCAL_MAX) {
        list = list.slice(0, CACHED_AUTOTASK_COMPANIES_LOCAL_MAX);
    }
    persistentAutotaskCompaniesMemory = list;
    try {
        localStorage.setItem(CACHED_AUTOTASK_COMPANIES_KEY, JSON.stringify(list));
    } catch (err) {
        // Ignore localStorage errors
    }
    autocompleteCache.clear();
}

function isAutotaskOrgFullSyncStale(lastFullSyncAtIso) {
    if (!lastFullSyncAtIso) return true;
    const t = new Date(lastFullSyncAtIso).getTime();
    return Number.isNaN(t) || (Date.now() - t > ORG_FULL_SYNC_INTERVAL_MS);
}

async function loadAllCachedAutotaskCompaniesFromSupabaseIntoLocal(supabase) {
    const pageSize = 1000;
    let from = 0;
    const all = [];
    for (;;) {
        const { data, error } = await supabase
            .from('cached_autotask_companies')
            .select('autotask_id, company_name')
            .order('autotask_id', { ascending: true })
            .range(from, from + pageSize - 1);
        if (error) throw error;
        if (!data || data.length === 0) break;
        for (const row of data) {
            const name = String(row.company_name || '').trim();
            if (!name) continue;
            all.push({ id: String(row.autotask_id || ''), name });
        }
        if (data.length < pageSize) break;
        from += pageSize;
    }
    replaceAllCachedAutotaskCompaniesLocal(all);
}

/**
 * Invoke read-only full Autotask sync into Supabase (Edge Function).
 * @returns {Promise<boolean>} false if request failed hard; true otherwise (including skipped).
 */
async function invokeAutotaskFullCompanySyncEdgeFunction(supabase, force = false) {
    // Same pattern as loadRecentTicketsForOrganization: getSession() alone can return a stale JWT;
    // Edge gateway verify_jwt then returns 401. getUser() validates with the server first.
    const { data: userData, error: userError } = await supabase.auth.getUser();
    if (userError || !userData?.user) {
        console.warn('Not signed in; skipping Autotask full org sync.');
        return false;
    }
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) {
        console.warn('No session after getUser; skipping Autotask full org sync.');
        return false;
    }

    const config = window.supabaseConfig || {};
    const supabaseUrl = (config.SUPABASE_URL || '').trim();
    const anonKey = (config.SUPABASE_ANON_KEY || '').trim();
    if (!supabaseUrl || !anonKey) return false;

    const baseFunctionsUrl = `${supabaseUrl.replace(/\/+$/, '')}/functions/v1`;
    const suffix = force ? '?force=1' : '';
    const url = `${baseFunctionsUrl}/autotask-sync-all-companies${suffix}`;

    const requestSync = (accessToken) =>
        fetch(url, {
            method: 'GET',
            headers: {
                Authorization: `Bearer ${accessToken}`,
                apikey: anonKey,
                'Content-Type': 'application/json',
            },
        });

    let response = await requestSync(session.access_token);
    if (response.status === 401) {
        const { data: refreshed, error: refreshErr } = await supabase.auth.refreshSession();
        if (!refreshErr && refreshed?.session?.access_token) {
            response = await requestSync(refreshed.session.access_token);
        }
    }

    if (response.status === 503) {
        console.warn('Autotask API not configured on server; org list not synced from PSA.');
        return true;
    }
    if (response.status === 401) {
        console.warn('Session expired during org sync.');
        return false;
    }
    if (!response.ok) {
        const txt = await response.text().catch(() => '');
        console.warn('[autotask-sync-all-companies] failed:', response.status, txt);
        return false;
    }
    return true;
}

/**
 * Load orgs from Supabase into local cache; if weekly sync is due, run Edge full sync then reload.
 * Non-blocking for callers (uses internal async IIFE).
 */
function refreshAutotaskOrgCacheAfterAuth() {
    if (!useSupabase()) return;
    const supabase = getSupabase();
    if (!supabase) return;

    const run = async () => {
        try {
            let stale = true;
            try {
                const { data: meta, error: metaErr } = await supabase
                    .from('autotask_org_sync_meta')
                    .select('last_full_sync_at')
                    .eq('id', 1)
                    .maybeSingle();
                if (!metaErr && meta) {
                    stale = isAutotaskOrgFullSyncStale(meta.last_full_sync_at);
                }
            } catch (metaReadErr) {
                console.warn('[org-cache] sync meta unreadable; apply migration 008 if missing.', metaReadErr);
            }

            await loadAllCachedAutotaskCompaniesFromSupabaseIntoLocal(supabase);

            if (stale) {
                const ok = await invokeAutotaskFullCompanySyncEdgeFunction(supabase, false);
                if (ok) {
                    await loadAllCachedAutotaskCompaniesFromSupabaseIntoLocal(supabase);
                }
            }
        } catch (err) {
            console.warn('[org-cache] refresh failed:', err);
        }
    };

    void run();
}

function filterOrganizationsByQuerySubstring(organizations, queryLower, limit) {
    const q = String(queryLower || '').trim().toLowerCase();
    if (q.length < 2) return [];
    const out = [];
    const seen = new Set();
    for (const org of organizations) {
        const name = String(org?.name || '').trim();
        const n = name.toLowerCase();
        if (!n.includes(q)) continue;
        if (seen.has(n)) continue;
        seen.add(n);
        out.push({ id: String(org?.id || ''), name });
        if (out.length >= limit) break;
    }
    return out;
}

/**
 * Synchronous suggestions from RAM cache or persisted company list (no network).
 */
function getInstantAutocompleteResults(query, limit = 20) {
    const trimmed = String(query || '').trim();
    if (trimmed.length < 2) return [];
    const cacheKey = trimmed.toLowerCase();
    const cached = autocompleteCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp) < AUTOCACHE_TTL_MS) {
        return cached.results;
    }
    const results = filterOrganizationsByQuerySubstring(loadPersistentAutotaskCompanies(), cacheKey, limit);
    autocompleteCache.set(cacheKey, { results, timestamp: Date.now() });
    return results;
}

/** Resolved Autotask company for the main call form `#organization` (read-only PSA lookups). */
let resolvedMainFormOrganization = { autotaskId: '', name: '' };
let mainFormOrganizationCommitTimer = null;
let recentTicketsDebounceTimer = null;
let recentTicketsAbortController = null;
let recentTicketsSpinnerTimer = null;
let recentTicketsSpinnerIndex = 0;
let lastRecentTicketClickKey = '';
let authorisedRepsDebounceTimer = null;
let authorisedRepsAbortController = null;
let authorisedRepsHideTimer = null;
let recentTicketsHideTimer = null;
let pendingAuthorisedRepsCompanyId = '';
const AUTHORISED_REPS_EXIT_MS = 260;
const RECENT_TICKETS_EXIT_MS = 240;

function normalizeHexColor(raw) {
    let s = String(raw || '').trim();
    if (!s.startsWith('#')) s = `#${s}`;
    const hex = s.slice(1).replace(/[^0-9a-fA-F]/g, '');
    if (hex.length === 3) {
        const expanded = hex.split('').map((c) => c + c).join('');
        return `#${expanded}`.toLowerCase();
    }
    if (hex.length >= 6) return `#${hex.slice(0, 6).toLowerCase()}`;
    return '#6b7280';
}

/**
 * Recent-ticket accent colors by Autotask Ticket `source` (integer picklist id).
 * To see every id and label for your tenant: Settings → Administration → Load picklist from Autotask.
 */
const RECENT_TICKET_SOURCE_STYLES = [
    { source: 2, label: '1300 784 889 (SLA)', color: '#16a34a' },
    { source: 4, label: 'Email (SLA)', color: '#84cc16' },
    { source: 6, label: 'Face to Face (SLA)', color: '#eab308' },
    { source: 23, label: 'SaaS Alerts', color: '#7c3aed' },
    { source: 22, label: 'RMM', color: '#dc2626' },
];

function buildRecentTicketSourceStyleMap() {
    const m = new Map();
    for (const row of RECENT_TICKET_SOURCE_STYLES) {
        const id = Number(row?.source);
        if (!Number.isFinite(id)) continue;
        const label = String(row?.label ?? '').trim() || `Source ${id}`;
        m.set(id, { label, color: normalizeHexColor(row?.color) });
    }
    return m;
}

const recentTicketSourceStyleMap = buildRecentTicketSourceStyleMap();

function classifyRecentTicketSource(rawSource) {
    if (rawSource == null || rawSource === '') return null;
    const id = typeof rawSource === 'number' ? rawSource : Number(rawSource);
    if (!Number.isFinite(id)) return null;
    const entry = recentTicketSourceStyleMap.get(id);
    if (!entry) return null;
    return { label: entry.label, color: entry.color };
}

function updateRecentTicketsLegend() {
    const el = document.getElementById('recentTicketsLegend');
    if (!el) return;
    const rows = RECENT_TICKET_SOURCE_STYLES.filter((r) => Number.isFinite(Number(r?.source)));
    if (rows.length === 0) {
        el.innerHTML = '';
        el.setAttribute('hidden', '');
        return;
    }
    const chips = rows
        .map((r) => {
            const lab = escapeHtml(String(r.label || '').trim() || `Source ${r.source}`);
            const col = normalizeHexColor(r.color);
            return `<span class="recent-tickets-legend__chip" style="--legend-accent:${escapeHtmlAttr(col)}">${lab}</span>`;
        })
        .join('');
    const other = '<span class="recent-tickets-legend__chip recent-tickets-legend__chip--other">Other</span>';
    el.innerHTML = `<span class="recent-tickets-legend__label">Key</span>${chips}${other}`;
    el.removeAttribute('hidden');
}

function resolveAutotaskCompanyIdFromCache(organizationName) {
    const want = String(organizationName || '').trim().toLowerCase();
    if (!want) return '';
    const companies = loadPersistentAutotaskCompanies();
    for (const org of companies) {
        const name = String(org?.name || '').trim();
        if (!name) continue;
        if (name.toLowerCase() !== want) continue;
        const id = String(org?.id || '').trim();
        return id;
    }
    return '';
}

function historyTabElementToWhich(el) {
    if (!el) return 'history';
    if (el.id === 'historyTabRecentTickets') return 'recent';
    if (el.id === 'historyTabCallHistory') return 'history';
    if (el.id === 'historyTabAuthorisedReps') return 'authorisedReps';
    return 'history';
}

function getHistoryPanelVisibleTabElements() {
    const tabRecent = document.getElementById('historyTabRecentTickets');
    const tabHistory = document.getElementById('historyTabCallHistory');
    const tabAuth = document.getElementById('historyTabAuthorisedReps');
    const out = [];
    if (tabHistory) out.push(tabHistory);
    if (tabRecent && !tabRecent.hasAttribute('hidden')) out.push(tabRecent);
    if (tabAuth && !tabAuth.hasAttribute('hidden')) out.push(tabAuth);
    return out;
}

function selectHistoryPanelTab(which) {
    const tabRecent = document.getElementById('historyTabRecentTickets');
    const tabHistory = document.getElementById('historyTabCallHistory');
    const tabAuth = document.getElementById('historyTabAuthorisedReps');
    const panelRecent = document.getElementById('historyPanelRecentTickets');
    const panelHistory = document.getElementById('historyPanelCallHistory');
    const panelAuth = document.getElementById('historyPanelAuthorisedReps');
    if (!tabRecent || !tabHistory || !panelRecent || !panelHistory) return;

    const authVisible = !!(tabAuth && panelAuth && !tabAuth.hasAttribute('hidden'));
    let sel = which;
    if (sel === 'authorisedReps' && !authVisible) sel = 'history';

    panelRecent.setAttribute('hidden', '');
    panelHistory.setAttribute('hidden', '');
    if (panelAuth) panelAuth.setAttribute('hidden', '');

    tabRecent.setAttribute('aria-selected', 'false');
    tabHistory.setAttribute('aria-selected', 'false');
    tabRecent.tabIndex = -1;
    tabHistory.tabIndex = -1;
    if (tabAuth) {
        tabAuth.setAttribute('aria-selected', 'false');
        tabAuth.tabIndex = -1;
    }

    if (sel === 'recent') {
        tabRecent.setAttribute('aria-selected', 'true');
        tabRecent.tabIndex = 0;
        panelRecent.removeAttribute('hidden');
        updateRecentTicketsLegend();
    } else if (sel === 'history') {
        tabHistory.setAttribute('aria-selected', 'true');
        tabHistory.tabIndex = 0;
        panelHistory.removeAttribute('hidden');
    } else if (sel === 'authorisedReps' && panelAuth && authVisible) {
        tabAuth.setAttribute('aria-selected', 'true');
        tabAuth.tabIndex = 0;
        panelAuth.removeAttribute('hidden');
    }
}

function setupHistoryPanelTabs() {
    const tabRecent = document.getElementById('historyTabRecentTickets');
    const tabHistory = document.getElementById('historyTabCallHistory');
    const tabAuth = document.getElementById('historyTabAuthorisedReps');
    const tablist = tabRecent?.closest('[role="tablist"]');
    tabRecent?.addEventListener('click', () => selectHistoryPanelTab('recent'));
    tabHistory?.addEventListener('click', () => selectHistoryPanelTab('history'));
    tabAuth?.addEventListener('click', () => selectHistoryPanelTab('authorisedReps'));

    tablist?.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return;
        e.preventDefault();
        const tabs = getHistoryPanelVisibleTabElements();
        if (tabs.length === 0) return;
        const currentWhich = ['recent', 'history', 'authorisedReps'].find((w) => {
            const id =
                w === 'recent'
                    ? 'historyTabRecentTickets'
                    : w === 'history'
                      ? 'historyTabCallHistory'
                      : 'historyTabAuthorisedReps';
            const t = document.getElementById(id);
            return t?.getAttribute('aria-selected') === 'true';
        });
        let idx = tabs.findIndex((t) => historyTabElementToWhich(t) === currentWhich);
        if (idx < 0) idx = 0;

        if (e.key === 'Home') {
            const first = tabs[0];
            selectHistoryPanelTab(historyTabElementToWhich(first));
            first?.focus();
            return;
        }
        if (e.key === 'End') {
            const last = tabs[tabs.length - 1];
            selectHistoryPanelTab(historyTabElementToWhich(last));
            last?.focus();
            return;
        }
        if (e.key === 'ArrowRight') {
            const next = tabs[(idx + 1) % tabs.length];
            selectHistoryPanelTab(historyTabElementToWhich(next));
            next?.focus();
            return;
        }
        if (e.key === 'ArrowLeft') {
            const prev = tabs[(idx - 1 + tabs.length) % tabs.length];
            selectHistoryPanelTab(historyTabElementToWhich(prev));
            prev?.focus();
        }
    });

    setRecentTicketsTabVisible(false, { immediate: true });
    setAuthorisedRepsTabVisible(false, { immediate: true });
    selectHistoryPanelTab('history');
}

function updateRecentTicketsHintVisibility() {
    const hint = document.getElementById('recentTicketsHint');
    if (!hint) return;
    const orgInput = document.getElementById('organization');
    const name = String(orgInput?.value || '').trim();
    const hasId = !!String(resolvedMainFormOrganization.autotaskId || '').trim();
    const show = !hasId && !!name;
    hint.style.display = show ? '' : 'none';
}

function clearRecentTicketsListUi() {
    stopRecentTicketsLoadingIndicator();
    const list = document.getElementById('recentTicketsList');
    if (list) list.innerHTML = '';
    const status = document.getElementById('recentTicketsStatus');
    if (status) status.textContent = '';
    const errEl = document.getElementById('recentTicketsError');
    if (errEl) {
        errEl.textContent = '';
        errEl.setAttribute('hidden', '');
    }
}

function clearAuthorisedRepsUi() {
    const status = document.getElementById('authorisedRepsStatus');
    const errEl = document.getElementById('authorisedRepsError');
    const content = document.getElementById('authorisedRepsContent');
    if (status) status.textContent = '';
    if (errEl) {
        errEl.textContent = '';
        errEl.setAttribute('hidden', '');
    }
    if (content) content.textContent = '';
}

function prefersReducedMotion() {
    return !!window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function stopRecentTicketsLoadingIndicator() {
    if (recentTicketsSpinnerTimer) {
        clearInterval(recentTicketsSpinnerTimer);
        recentTicketsSpinnerTimer = null;
    }
    recentTicketsSpinnerIndex = 0;
    const status = document.getElementById('recentTicketsStatus');
    if (!status) return;
    status.classList.remove('recent-tickets-status--loading');
    status.textContent = '';
}

function startRecentTicketsLoadingIndicator() {
    stopRecentTicketsLoadingIndicator();
    const status = document.getElementById('recentTicketsStatus');
    if (!status) return;
    status.classList.add('recent-tickets-status--loading');
    if (prefersReducedMotion()) {
        status.textContent = 'Loading tickets...';
        return;
    }
    const frames = ['/', '|', '\\'];
    const render = () => {
        const glyph = frames[recentTicketsSpinnerIndex % frames.length];
        recentTicketsSpinnerIndex += 1;
        status.textContent = `Loading tickets ${glyph}`;
    };
    render();
    recentTicketsSpinnerTimer = setInterval(render, 140);
}

function revealAuthorisedRepsAfterRecentTickets(companyId) {
    const cid = String(companyId || '').trim();
    if (!cid) return;
    if (String(resolvedMainFormOrganization.autotaskId || '').trim() !== cid) return;
    if (pendingAuthorisedRepsCompanyId !== cid) return;
    pendingAuthorisedRepsCompanyId = '';
    setAuthorisedRepsTabVisible(true);
    scheduleAuthorisedRepsFetch(cid);
}

function updateHistoryTabsLayoutState() {
    const tablist = document.querySelector('.history-panel-tabs');
    const tabRecent = document.getElementById('historyTabRecentTickets');
    const tabAuth = document.getElementById('historyTabAuthorisedReps');
    if (!tablist) return;
    const hasRecent = !!(tabRecent && !tabRecent.hasAttribute('hidden'));
    const hasAuth = !!(tabAuth && !tabAuth.hasAttribute('hidden'));
    tablist.classList.toggle('history-panel-tabs--history-only', !hasRecent && !hasAuth);
    tablist.classList.toggle('history-panel-tabs--history-recent', hasRecent && !hasAuth);
    tablist.classList.toggle('history-panel-tabs--full', hasRecent && hasAuth);
}

function setRecentTicketsTabVisible(show, options = {}) {
    const immediate = !!options.immediate;
    const tab = document.getElementById('historyTabRecentTickets');
    const panel = document.getElementById('historyPanelRecentTickets');
    if (!tab || !panel) return;
    if (recentTicketsHideTimer) {
        clearTimeout(recentTicketsHideTimer);
        recentTicketsHideTimer = null;
    }
    if (show) {
        tab.removeAttribute('hidden');
        tab.classList.remove('hidden');
        tab.classList.remove('recent-tickets-tab--exit');
        if (!prefersReducedMotion() && !immediate) {
            tab.classList.remove('recent-tickets-tab--enter');
            void tab.offsetWidth;
            tab.classList.add('recent-tickets-tab--enter');
        }
        updateHistoryTabsLayoutState();
        return;
    }
    if (tab.getAttribute('aria-selected') === 'true') {
        selectHistoryPanelTab('history');
    }
    const hideNow = immediate || prefersReducedMotion();
    if (hideNow) {
        tab.classList.remove('recent-tickets-tab--enter', 'recent-tickets-tab--exit');
        tab.setAttribute('hidden', '');
        tab.classList.add('hidden');
        panel.setAttribute('hidden', '');
        clearRecentTicketsListUi();
        updateHistoryTabsLayoutState();
        return;
    }
    tab.classList.remove('recent-tickets-tab--enter');
    tab.classList.add('recent-tickets-tab--exit');
    recentTicketsHideTimer = setTimeout(() => {
        tab.classList.remove('recent-tickets-tab--exit');
        tab.setAttribute('hidden', '');
        tab.classList.add('hidden');
        panel.setAttribute('hidden', '');
        clearRecentTicketsListUi();
        updateHistoryTabsLayoutState();
        recentTicketsHideTimer = null;
    }, RECENT_TICKETS_EXIT_MS);
}

function setAuthorisedRepsTabVisible(show, options = {}) {
    const immediate = !!options.immediate;
    const tab = document.getElementById('historyTabAuthorisedReps');
    const panel = document.getElementById('historyPanelAuthorisedReps');
    if (!tab || !panel) return;
    if (authorisedRepsHideTimer) {
        clearTimeout(authorisedRepsHideTimer);
        authorisedRepsHideTimer = null;
    }
    if (show) {
        tab.removeAttribute('hidden');
        tab.classList.remove('hidden');
        tab.classList.remove('authorised-reps-tab--exit');
        panel.classList.remove('authorised-reps-panel--exit');
        if (!prefersReducedMotion()) {
            tab.classList.remove('authorised-reps-tab--enter');
            panel.classList.remove('authorised-reps-panel--enter');
            void tab.offsetWidth;
            tab.classList.add('authorised-reps-tab--enter');
            panel.classList.add('authorised-reps-panel--enter');
        }
        updateHistoryTabsLayoutState();
        return;
    }
    const wasSelected = tab.getAttribute('aria-selected') === 'true';
    if (wasSelected) {
        selectHistoryPanelTab('history');
    }
    if (authorisedRepsDebounceTimer) {
        clearTimeout(authorisedRepsDebounceTimer);
        authorisedRepsDebounceTimer = null;
    }
    if (authorisedRepsAbortController) {
        authorisedRepsAbortController.abort();
        authorisedRepsAbortController = null;
    }
    clearAuthorisedRepsUi();
    const hideNow = immediate || prefersReducedMotion();
    if (hideNow) {
        tab.classList.remove('authorised-reps-tab--enter', 'authorised-reps-tab--exit');
        panel.classList.remove('authorised-reps-panel--enter', 'authorised-reps-panel--exit');
        tab.setAttribute('hidden', '');
        tab.classList.add('hidden');
        panel.setAttribute('hidden', '');
        updateHistoryTabsLayoutState();
        return;
    }
    tab.classList.remove('authorised-reps-tab--enter');
    panel.classList.remove('authorised-reps-panel--enter');
    tab.classList.add('authorised-reps-tab--exit');
    panel.classList.add('authorised-reps-panel--exit');
    authorisedRepsHideTimer = setTimeout(() => {
        tab.classList.remove('authorised-reps-tab--exit');
        panel.classList.remove('authorised-reps-panel--exit');
        tab.setAttribute('hidden', '');
        tab.classList.add('hidden');
        panel.setAttribute('hidden', '');
        authorisedRepsHideTimer = null;
        updateHistoryTabsLayoutState();
    }, AUTHORISED_REPS_EXIT_MS);
}

function scheduleMainOrganizationResolution() {
    if (mainFormOrganizationCommitTimer) {
        clearTimeout(mainFormOrganizationCommitTimer);
    }
    mainFormOrganizationCommitTimer = setTimeout(() => {
        mainFormOrganizationCommitTimer = null;
        commitMainOrganizationResolution();
    }, 350);
}

function commitMainOrganizationResolution(explicitOrg) {
    const orgInput = document.getElementById('organization');
    if (!orgInput) return;

    const previousResolvedName = String(resolvedMainFormOrganization.name || '').trim();
    const previousResolvedAutotaskId = String(resolvedMainFormOrganization.autotaskId || '').trim();
    let name = String(orgInput.value || '').trim();
    let autotaskId = '';

    if (explicitOrg && typeof explicitOrg === 'object') {
        const exName = String(explicitOrg.name || '').trim();
        const exId = String(explicitOrg.id || '').trim();
        const nameLo = name.toLowerCase();
        const exLo = exName.toLowerCase();
        if (exId && exName && nameLo === exLo) {
            autotaskId = exId;
        }
    }

    if (!autotaskId && name) {
        autotaskId = resolveAutotaskCompanyIdFromCache(name);
    }

    // #region agent log
    fetch('http://127.0.0.1:7442/ingest/de52a58c-6176-4a1a-a3fe-7fb8f60f932e',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'76bee9'},body:JSON.stringify({sessionId:'76bee9',runId:'baseline',hypothesisId:'H1',location:'script.js:771',message:'commitMainOrganizationResolution',data:{name,autotaskId,explicitOrgName:String(explicitOrg?.name||''),explicitOrgId:String(explicitOrg?.id||'')},timestamp:Date.now()})}).catch(()=>{})
    // #endregion

    const hasResolvedChanged =
        previousResolvedName !== name ||
        previousResolvedAutotaskId !== autotaskId;

    resolvedMainFormOrganization = { autotaskId, name };

    if (!name) {
        resolvedMainFormOrganization = { autotaskId: '', name: '' };
        pendingAuthorisedRepsCompanyId = '';
        setRecentTicketsTabVisible(false, { immediate: true });
        setAuthorisedRepsTabVisible(false);
        selectHistoryPanelTab('history');
        updateRecentTicketsHintVisibility();
        return;
    }

    if (!autotaskId) {
        pendingAuthorisedRepsCompanyId = '';
        setRecentTicketsTabVisible(false, { immediate: true });
        setAuthorisedRepsTabVisible(false);
        selectHistoryPanelTab('history');
        updateRecentTicketsHintVisibility();
        return;
    }

    updateRecentTicketsHintVisibility();
    setRecentTicketsTabVisible(true);
    if (!hasResolvedChanged) return;
    selectHistoryPanelTab('recent');
    pendingAuthorisedRepsCompanyId = autotaskId;
    setAuthorisedRepsTabVisible(false, { immediate: true });
    scheduleRecentTicketsFetch(autotaskId);
}

function scheduleRecentTicketsFetch(companyId) {
    if (recentTicketsDebounceTimer) {
        clearTimeout(recentTicketsDebounceTimer);
    }
    // #region agent log
    fetch('http://127.0.0.1:7442/ingest/de52a58c-6176-4a1a-a3fe-7fb8f60f932e',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'76bee9'},body:JSON.stringify({sessionId:'76bee9',runId:'baseline',hypothesisId:'H2',location:'script.js:801',message:'scheduleRecentTicketsFetch',data:{companyId:String(companyId||'')},timestamp:Date.now()})}).catch(()=>{})
    // #endregion
    recentTicketsDebounceTimer = setTimeout(() => {
        recentTicketsDebounceTimer = null;
        void loadRecentTicketsForCompanyId(companyId);
    }, 300);
}

function scheduleAuthorisedRepsFetch(companyId) {
    if (authorisedRepsDebounceTimer) {
        clearTimeout(authorisedRepsDebounceTimer);
    }
    authorisedRepsDebounceTimer = setTimeout(() => {
        authorisedRepsDebounceTimer = null;
        void loadAuthorisedRepsForCompanyId(companyId);
    }, 300);
}

function formatRecentTicketWhen(iso) {
    if (!iso || typeof iso !== 'string') return '';
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) return '';
    try {
        return new Date(ms).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
    } catch (e) {
        return '';
    }
}

function isValidExternalHttpUrl(rawUrl) {
    const s = String(rawUrl || '').trim();
    if (!s) return false;
    try {
        const u = new URL(s);
        return u.protocol === 'http:' || u.protocol === 'https:';
    } catch (_) {
        return false;
    }
}

function renderRecentTicketsList(tickets) {
    const list = document.getElementById('recentTicketsList');
    if (!list) return;
    lastRecentTicketClickKey = '';
    const rows = Array.isArray(tickets) ? tickets : [];
    if (rows.length === 0) {
        list.innerHTML = '<p class="recent-tickets-hint">No tickets with activity in the last 14 days.</p>';
        return;
    }
    list.innerHTML = rows
        .map((t, index) => {
            const num = escapeHtml(String(t.ticketNumber || '').trim() || String(t.id || ''));
            const rawTitle = String(t.title || '').trim();
            const title = escapeHtml(rawTitle || '(No title)');
            const match = classifyRecentTicketSource(t.source);
            const rowCls = match ? 'recent-ticket-row recent-ticket-row--matched' : 'recent-ticket-row recent-ticket-row--other';
            const accentStyle = match ? ` style="--recent-ticket-accent:${escapeHtmlAttr(normalizeHexColor(match.color))}"` : '';
            const when = formatRecentTicketWhen(t.lastActivityDate);
            const metaParts = [];
            if (when) metaParts.push(when);
            const statusLabel = String(t.statusName || '').trim();
            if (statusLabel) metaParts.push(statusLabel);
            else if (t.status != null && t.status !== '') metaParts.push(`Status ${t.status}`);
            const prr = String(t.primaryResourceRole || '').trim();
            if (prr) metaParts.push(prr);
            const meta = metaParts.join(' · ');
            const rawNum = String(t.ticketNumber || '').trim() || String(t.id || '');
            const ticketValue = escapeHtmlAttr(rawNum);
            const ticketId = String(t.id || '').trim();
            const ticketKey = escapeHtmlAttr(ticketId || rawNum);
            const ticketUrl = String(t.ticketUrl || t.ticketUrlByNumber || '').trim();
            const ticketUrlAttr = escapeHtmlAttr(ticketUrl);
            const ariaExtra = match
                ? ` Ticket source: ${match.label}.`
                : ' No mapped ticket source color.';
            const ariaUse = escapeHtmlAttr(`Use ticket ${rawNum} in ticket number field.${ariaExtra}`);
            const metaBlock = meta ? `<span class="recent-ticket-row__meta">${escapeHtml(meta)}</span>` : '';
            const cascadeDelay = `${Math.min(index, 20) * 70}ms`;
            return `<div class="recent-ticket-row-wrap recent-ticket-row-wrap--enter" role="listitem" style="--ticket-cascade-delay:${cascadeDelay}"><button type="button" class="${rowCls}" data-ticket-number="${ticketValue}" data-ticket-key="${ticketKey}" data-ticket-url="${ticketUrlAttr}" aria-label="${ariaUse}"${accentStyle}><span class="recent-ticket-row__num">${num}</span><span class="recent-ticket-row__title">${title}</span>${metaBlock}</button></div>`;
        })
        .join('');
}

function bindRecentTicketsListClicks() {
    const list = document.getElementById('recentTicketsList');
    if (!list || list.dataset.boundRecentClicks === '1') return;
    list.dataset.boundRecentClicks = '1';
    list.addEventListener('click', async (e) => {
        const btn = e.target.closest('.recent-ticket-row');
        if (!btn) return;
        const raw = btn.getAttribute('data-ticket-number') || '';
        const ticketKey = String(btn.getAttribute('data-ticket-key') || raw).trim();
        const ticketUrl = String(btn.getAttribute('data-ticket-url') || '').trim();
        const ticketUrlIsValid = isValidExternalHttpUrl(ticketUrl);
        const ticketNumberEl = document.getElementById('ticketNumber');
        if (ticketNumberEl) {
            ticketNumberEl.value = raw;
            ticketNumberEl.dispatchEvent(new Event('input', { bubbles: true }));
        }
        // #region agent log
        fetch('http://127.0.0.1:7442/ingest/de52a58c-6176-4a1a-a3fe-7fb8f60f932e',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'76bee9'},body:JSON.stringify({sessionId:'76bee9',runId:'baseline',hypothesisId:'H3',location:'script.js:898',message:'recentTicketClicked',data:{ticketKey,ticketNumber:raw,organizationValue:String(document.getElementById('organization')?.value||''),resolvedOrgId:String(resolvedMainFormOrganization?.autotaskId||'')},timestamp:Date.now()})}).catch(()=>{})
        // #endregion
        const status = document.getElementById('recentTicketsStatus');
        if (status) status.textContent = '';
        ticketNumberEl?.focus();

        const sameAsPrevious = ticketKey && ticketKey === lastRecentTicketClickKey;
        lastRecentTicketClickKey = ticketKey;
        if (!sameAsPrevious) return;

        if (!ticketUrlIsValid) {
            lastRecentTicketClickKey = '';
            return;
        }

        try {
            if (typeof window.electronAPI?.openExternalUrl !== 'function') {
                lastRecentTicketClickKey = '';
                return;
            }
            await window.electronAPI.openExternalUrl(ticketUrl);
        } catch (_) {
            /* silent: no status text on ticket click */
        } finally {
            lastRecentTicketClickKey = '';
        }
    });
}

async function loadRecentTicketsForCompanyId(companyId) {
    const cid = String(companyId || '').trim();
    if (!cid) return;

    const orgInput = document.getElementById('organization');
    const currentResolved = String(resolvedMainFormOrganization.autotaskId || '').trim();
    if (currentResolved !== cid) return;
    const finalizeRecentTicketsLoad = () => revealAuthorisedRepsAfterRecentTickets(cid);

    // #region agent log
    fetch('http://127.0.0.1:7442/ingest/de52a58c-6176-4a1a-a3fe-7fb8f60f932e',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'76bee9'},body:JSON.stringify({sessionId:'76bee9',runId:'baseline',hypothesisId:'H4',location:'script.js:931',message:'loadRecentTicketsForCompanyId:start',data:{cid,currentResolved,orgInputValue:String(orgInput?.value||'')},timestamp:Date.now()})}).catch(()=>{})
    // #endregion

    if (recentTicketsAbortController) {
        recentTicketsAbortController.abort();
    }
    recentTicketsAbortController = new AbortController();
    const { signal } = recentTicketsAbortController;

    const errEl = document.getElementById('recentTicketsError');
    if (errEl) {
        errEl.textContent = '';
        errEl.setAttribute('hidden', '');
    }
    startRecentTicketsLoadingIndicator();
    const list = document.getElementById('recentTicketsList');
    if (list) list.innerHTML = '';
    // #region agent log
    fetch('http://127.0.0.1:7442/ingest/de52a58c-6176-4a1a-a3fe-7fb8f60f932e',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'76bee9'},body:JSON.stringify({sessionId:'76bee9',runId:'baseline',hypothesisId:'H5',location:'script.js:947',message:'recentTicketsUiClearedForReload',data:{cid,hadList:!!list},timestamp:Date.now()})}).catch(()=>{})
    // #endregion

    if (!useSupabase()) {
        stopRecentTicketsLoadingIndicator();
        if (errEl) {
            errEl.textContent = 'Sign-in is required to load Autotask tickets.';
            errEl.removeAttribute('hidden');
        }
        finalizeRecentTicketsLoad();
        return;
    }

    const supabase = getSupabase();
    if (!supabase) {
        stopRecentTicketsLoadingIndicator();
        finalizeRecentTicketsLoad();
        return;
    }

    // getSession() alone can return a stale JWT; Edge verify_jwt then returns 401. getUser() validates/refreshes with the server first.
    const { data: userData, error: userError } = await supabase.auth.getUser();
    if (userError || !userData?.user) {
        stopRecentTicketsLoadingIndicator();
        if (errEl) {
            errEl.textContent = 'Sign in to load Autotask tickets.';
            errEl.removeAttribute('hidden');
        }
        finalizeRecentTicketsLoad();
        return;
    }
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) {
        stopRecentTicketsLoadingIndicator();
        if (errEl) {
            errEl.textContent = 'Session expired. Sign in again to load tickets.';
            errEl.removeAttribute('hidden');
        }
        finalizeRecentTicketsLoad();
        return;
    }

    const config = window.supabaseConfig || {};
    const supabaseUrl = (config.SUPABASE_URL || '').trim();
    const anonKey = (config.SUPABASE_ANON_KEY || '').trim();
    if (!supabaseUrl || !anonKey) {
        stopRecentTicketsLoadingIndicator();
        finalizeRecentTicketsLoad();
        return;
    }

    const baseFunctionsUrl = `${supabaseUrl.replace(/\/+$/, '')}/functions/v1`;
    const url = `${baseFunctionsUrl}/autotask-recent-tickets?companyId=${encodeURIComponent(cid)}`;

    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                Authorization: `Bearer ${session.access_token}`,
                apikey: anonKey,
                'Content-Type': 'application/json',
            },
            signal,
        });

        if (signal.aborted) {
            stopRecentTicketsLoadingIndicator();
            return;
        }

        if (String(resolvedMainFormOrganization.autotaskId || '').trim() !== cid) return;
        if (String(orgInput?.value || '').trim() !== resolvedMainFormOrganization.name) return;

        if (response.status === 503) {
            stopRecentTicketsLoadingIndicator();
            if (errEl) {
                errEl.textContent = 'Autotask is not configured on the server.';
                errEl.removeAttribute('hidden');
            }
            finalizeRecentTicketsLoad();
            return;
        }
        if (response.status === 401) {
            stopRecentTicketsLoadingIndicator();
            if (errEl) {
                errEl.textContent = 'Session expired. Sign in again to load tickets.';
                errEl.removeAttribute('hidden');
            }
            finalizeRecentTicketsLoad();
            return;
        }
        if (response.status === 400) {
            stopRecentTicketsLoadingIndicator();
            if (errEl) {
                errEl.textContent = 'Could not load tickets for this organization.';
                errEl.removeAttribute('hidden');
            }
            finalizeRecentTicketsLoad();
            return;
        }
        if (!response.ok) {
            const txt = await response.text().catch(() => '');
            stopRecentTicketsLoadingIndicator();
            if (errEl) {
                errEl.textContent = 'Failed to load tickets. Please try again.';
                errEl.removeAttribute('hidden');
            }
            console.warn('[autotask-recent-tickets]', response.status, txt);
            finalizeRecentTicketsLoad();
            return;
        }

        const data = await response.json().catch(() => ({}));
        const tickets = Array.isArray(data?.tickets) ? data.tickets : [];
        stopRecentTicketsLoadingIndicator();
        updateRecentTicketsLegend();
        renderRecentTicketsList(tickets);
        finalizeRecentTicketsLoad();
    } catch (err) {
        if (signal.aborted) {
            stopRecentTicketsLoadingIndicator();
            return;
        }
        stopRecentTicketsLoadingIndicator();
        if (errEl && err?.name !== 'AbortError') {
            errEl.textContent = 'Failed to load tickets. Please try again.';
            errEl.removeAttribute('hidden');
        }
        finalizeRecentTicketsLoad();
    }
}

async function loadAuthorisedRepsForCompanyId(companyId) {
    const cid = String(companyId || '').trim();
    if (!cid) return;

    const orgInput = document.getElementById('organization');
    const currentResolved = String(resolvedMainFormOrganization.autotaskId || '').trim();
    if (currentResolved !== cid) return;

    if (authorisedRepsAbortController) {
        authorisedRepsAbortController.abort();
    }
    authorisedRepsAbortController = new AbortController();
    const { signal } = authorisedRepsAbortController;

    const status = document.getElementById('authorisedRepsStatus');
    const errEl = document.getElementById('authorisedRepsError');
    const content = document.getElementById('authorisedRepsContent');
    if (errEl) {
        errEl.textContent = '';
        errEl.setAttribute('hidden', '');
    }
    if (content) content.textContent = '';
    if (status) status.textContent = 'Loading authorised reps…';

    if (!useSupabase()) {
        if (status) status.textContent = '';
        if (errEl) {
            errEl.textContent = 'Sign-in is required to load Autotask company data.';
            errEl.removeAttribute('hidden');
        }
        if (content) content.textContent = '';
        return;
    }

    const supabase = getSupabase();
    if (!supabase) {
        if (status) status.textContent = '';
        return;
    }

    const { data: userData, error: userError } = await supabase.auth.getUser();
    if (userError || !userData?.user) {
        if (status) status.textContent = '';
        if (errEl) {
            errEl.textContent = 'Sign in to load authorised reps.';
            errEl.removeAttribute('hidden');
        }
        return;
    }
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) {
        if (status) status.textContent = '';
        if (errEl) {
            errEl.textContent = 'Session expired. Sign in again to load authorised reps.';
            errEl.removeAttribute('hidden');
        }
        return;
    }

    const config = window.supabaseConfig || {};
    const supabaseUrl = (config.SUPABASE_URL || '').trim();
    const anonKey = (config.SUPABASE_ANON_KEY || '').trim();
    if (!supabaseUrl || !anonKey) {
        if (status) status.textContent = '';
        return;
    }

    const baseFunctionsUrl = `${supabaseUrl.replace(/\/+$/, '')}/functions/v1`;
    const url = `${baseFunctionsUrl}/autotask-company-authorised-reps?companyId=${encodeURIComponent(cid)}`;

    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                Authorization: `Bearer ${session.access_token}`,
                apikey: anonKey,
                'Content-Type': 'application/json',
            },
            signal,
        });

        if (signal.aborted) return;

        if (String(resolvedMainFormOrganization.autotaskId || '').trim() !== cid) return;
        if (String(orgInput?.value || '').trim() !== resolvedMainFormOrganization.name) return;

        if (response.status === 503) {
            if (status) status.textContent = '';
            if (errEl) {
                errEl.textContent = 'Autotask is not configured on the server.';
                errEl.removeAttribute('hidden');
            }
            return;
        }
        if (response.status === 401) {
            if (status) status.textContent = '';
            if (errEl) {
                errEl.textContent = 'Session expired. Sign in again to load authorised reps.';
                errEl.removeAttribute('hidden');
            }
            return;
        }
        if (response.status === 400) {
            if (status) status.textContent = '';
            if (errEl) {
                errEl.textContent = 'Could not load authorised reps for this organization.';
                errEl.removeAttribute('hidden');
            }
            return;
        }
        if (!response.ok) {
            const txt = await response.text().catch(() => '');
            if (status) status.textContent = '';
            if (errEl) {
                errEl.textContent = 'Failed to load authorised reps. Please try again.';
                errEl.removeAttribute('hidden');
            }
            console.warn('[autotask-company-authorised-reps]', response.status, txt);
            return;
        }

        const data = await response.json().catch(() => ({}));
        if (status) status.textContent = '';
        const rawVal = data?.value;
        const text = rawVal != null && String(rawVal).trim() ? String(rawVal).trim() : '';
        if (content) {
            content.textContent = text || 'No authorised reps on file.';
        }
    } catch (err) {
        if (signal.aborted) return;
        if (status) status.textContent = '';
        if (errEl && err?.name !== 'AbortError') {
            errEl.textContent = 'Failed to load authorised reps. Please try again.';
            errEl.removeAttribute('hidden');
        }
    }
}

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

function b64Encode(bytes) {
    let binary = '';
    const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    for (let i = 0; i < arr.length; i++) binary += String.fromCharCode(arr[i]);
    return btoa(binary);
}

function b64Decode(base64) {
    const binary = atob(base64);
    const arr = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);
    return arr;
}

async function sha256Bytes(text) {
    const data = textEncoder.encode(text);
    const hash = await crypto.subtle.digest('SHA-256', data);
    return new Uint8Array(hash);
}

async function getMasterKeyMaterial() {
    let raw = '';
    if (window.electronAPI?.getMasterKey) {
        raw = String(await window.electronAPI.getMasterKey().catch(() => '') || '').trim();
    }
    if (!raw) {
        raw = String(window.supabaseConfig?.CALLLOG_MASTER_KEY || '').trim();
    }
    if (!raw) return null;

    try {
        const decoded = b64Decode(raw);
        if (decoded.length === 32) return decoded;
    } catch (_) {
        // fall through to hash-based normalization
    }

    return sha256Bytes(raw);
}

function normalizeForBlindIndex(value, fieldName) {
    const v = String(value || '').trim();
    if (!v) return '';
    if (fieldName === 'phone') return v.toLowerCase().replace(/\s+/g, '');
    if (fieldName === 'name') return v.toLowerCase().replace(/\s+/g, ' ');
    return v.toLowerCase();
}

async function importAesKey(rawKey) {
    return crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function importHmacKey(rawKey) {
    return crypto.subtle.importKey(
        'raw',
        rawKey,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );
}

function toHex(bytes) {
    return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function computeBlindIndex(fieldName, value) {
    if (!encryptionState.enabled || !encryptionState.blindKey) return null;
    const normalized = normalizeForBlindIndex(value, fieldName);
    if (!normalized) return null;
    const sig = await crypto.subtle.sign('HMAC', encryptionState.blindKey, textEncoder.encode(normalized));
    return toHex(new Uint8Array(sig));
}

async function encryptValue(fieldName, plaintext) {
    if (!encryptionState.enabled || !encryptionState.dataKey) return null;
    const value = String(plaintext || '').trim();
    if (!value) return null;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const aad = textEncoder.encode(`calls:${fieldName}`);
    const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: aad },
        encryptionState.dataKey,
        textEncoder.encode(value)
    );
    return `v1.${b64Encode(iv)}.${b64Encode(new Uint8Array(ciphertext))}`;
}

async function decryptValue(fieldName, payload) {
    if (!encryptionState.enabled || !encryptionState.dataKey) return null;
    if (!payload || typeof payload !== 'string') return null;
    const parts = payload.split('.');
    if (parts.length !== 3 || parts[0] !== 'v1') return null;
    const iv = b64Decode(parts[1]);
    const data = b64Decode(parts[2]);
    const aad = textEncoder.encode(`calls:${fieldName}`);
    try {
        const plaintext = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv, additionalData: aad },
            encryptionState.dataKey,
            data
        );
        return textDecoder.decode(plaintext);
    } catch (e) {
        if (DEBUG_ENCRYPTION && debugDecryptFailLoggedCount < 20) {
            debugDecryptFailLoggedCount += 1
            console.warn('[decrypt]', fieldName, 'failed:', e?.message || e)
        }
        return null
    }
}

async function wrapDek(masterKeyBytes, dekBytes) {
    const key = await importAesKey(masterKeyBytes);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const wrapped = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: textEncoder.encode('calls:dek') },
        key,
        dekBytes
    );
    return `v1.${b64Encode(iv)}.${b64Encode(new Uint8Array(wrapped))}`;
}

async function unwrapDek(masterKeyBytes, wrappedPayload) {
    const parts = String(wrappedPayload || '').split('.');
    if (parts.length !== 3 || parts[0] !== 'v1') {
        throw new Error('Invalid wrapped DEK format');
    }
    const key = await importAesKey(masterKeyBytes);
    const iv = b64Decode(parts[1]);
    const wrapped = b64Decode(parts[2]);
    const raw = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv, additionalData: textEncoder.encode('calls:dek') },
        key,
        wrapped
    );
    return new Uint8Array(raw);
}

async function getOrCreateWrappedDek(supabase) {
    const { data, error } = await supabase
        .from('app_keys')
        .select('key_version, dek_encrypted')
        .eq('key_name', PII_KEY_NAME)
        .maybeSingle();
    if (!error && data?.dek_encrypted) {
        return { wrappedDek: data.dek_encrypted, keyVersion: Number(data.key_version || 1) };
    }

    const dek = crypto.getRandomValues(new Uint8Array(64));
    const masterKey = await getMasterKeyMaterial();
    if (!masterKey) throw new Error('Missing CALLLOG_MASTER_KEY');
    const wrappedDek = await wrapDek(masterKey, dek);
    const keyVersion = 1;
    const { error: upsertError } = await supabase
        .from('app_keys')
        .upsert({ key_name: PII_KEY_NAME, key_version: keyVersion, dek_encrypted: wrappedDek }, { onConflict: 'key_name' });
    if (upsertError) throw upsertError;
    return { wrappedDek, keyVersion };
}

async function initializeEncryption() {
    if (encryptionState.enabled && encryptionState.dataKey && encryptionState.blindKey) return
    if (encryptionState.initPromise) return encryptionState.initPromise

    encryptionState.initPromise = (async () => {
        if (!window.crypto?.subtle || !useSupabase()) return

        const supabase = getSupabase();
        if (!supabase) return

        const masterKey = await getMasterKeyMaterial();
        if (!masterKey) {
            console.warn('CALLLOG_MASTER_KEY is not set. Encryption is disabled and PII writes are blocked.');
            encryptionState.enabled = false
            return
        }
        if (DEBUG_ENCRYPTION) {
            console.debug('[encryption] master key loaded:', !!masterKey)
        }

        try {
            const { wrappedDek, keyVersion } = await getOrCreateWrappedDek(supabase);
            const rawDek = await unwrapDek(masterKey, wrappedDek);
            if (rawDek.length < 64) {
                throw new Error('Wrapped DEK must be at least 64 bytes');
            }
            encryptionState.dataKey = await importAesKey(rawDek.slice(0, 32));
            encryptionState.blindKey = await importHmacKey(rawDek.slice(32, 64));
            encryptionState.keyVersion = Number(keyVersion || 1);
            encryptionState.enabled = true;
            encryptionState.initialized = true
            if (DEBUG_ENCRYPTION) {
                console.debug('[encryption] initialized:', {
                    enabled: encryptionState.enabled,
                    hasDataKey: !!encryptionState.dataKey,
                    hasBlindKey: !!encryptionState.blindKey
                })
            }
        } catch (err) {
            console.error('Encryption init failed. PII writes are blocked while encryption is unavailable.', err);
            encryptionState.enabled = false;
            encryptionState.initialized = true
        }
    })()

    try {
        await encryptionState.initPromise
    } finally {
        encryptionState.initPromise = null
    }
}

// ========== Autotask Organization Autocomplete ==========
// Organization names are served from a local cache hydrated from Supabase `cached_autotask_companies`
// (weekly full sync via Edge Function `autotask-sync-all-companies`). No per-keystroke Autotask calls.

/**
 * Setup autocomplete for an organization input field
 * @param {string} inputId - ID of the input element
 * @param {string} dropdownId - ID of the dropdown container
 */
function setupOrganizationAutocomplete(inputId, dropdownId) {
    const input = document.getElementById(inputId);
    const dropdown = document.getElementById(dropdownId);
    if (!input || !dropdown) return;

    let selectedIndex = -1;
    let suggestions = [];
    let suppressNextInputSearch = false;

    function hideDropdown() {
        dropdown.classList.remove('show');
        dropdown.setAttribute('aria-hidden', 'true');
        input.setAttribute('aria-expanded', 'false');
        selectedIndex = -1;
        suggestions = [];
    }

    function showDropdown() {
        dropdown.classList.add('show');
        dropdown.setAttribute('aria-hidden', 'false');
        input.setAttribute('aria-expanded', 'true');
    }

    function renderSuggestions(orgs, query) {
        const q = String(query || '').trim().toLowerCase()
        const ranked = [...orgs].sort((a, b) => {
            const an = String(a?.name || '').toLowerCase()
            const bn = String(b?.name || '').toLowerCase()

            const aFirstWord = an.split(/\s+/)[0] || ''
            const bFirstWord = bn.split(/\s+/)[0] || ''

            // Rank by: first-word prefix, any-word prefix, then earliest occurrence, then alphabetical
            const aFirstWordPrefix = q && aFirstWord.startsWith(q) ? 0 : 1
            const bFirstWordPrefix = q && bFirstWord.startsWith(q) ? 0 : 1
            if (aFirstWordPrefix !== bFirstWordPrefix) return aFirstWordPrefix - bFirstWordPrefix

            const aAnyWordPrefix = q && new RegExp(`(^|\\s)${q.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}`).test(an) ? 0 : 1
            const bAnyWordPrefix = q && new RegExp(`(^|\\s)${q.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}`).test(bn) ? 0 : 1
            if (aAnyWordPrefix !== bAnyWordPrefix) return aAnyWordPrefix - bAnyWordPrefix

            const aIdx = q ? an.indexOf(q) : -1
            const bIdx = q ? bn.indexOf(q) : -1
            const aPos = aIdx >= 0 ? aIdx : 9999
            const bPos = bIdx >= 0 ? bIdx : 9999
            if (aPos !== bPos) return aPos - bPos

            return an.localeCompare(bn)
        })

        suggestions = ranked;
        selectedIndex = -1;

        if (ranked.length === 0) {
            hideDropdown();
            return;
        }

        dropdown.innerHTML = ranked.map((org, index) => {
            const escapedName = escapeHtml(org.name);
            const atId = escapeHtmlAttr(String(org?.id || ''));
            return `
                <div class="autocomplete-item" data-testid="autocomplete-item" role="option" data-index="${index}" data-value="${escapeHtmlAttr(org.name)}" data-autotask-id="${atId}" aria-selected="false">
                    ${escapedName}
                </div>
            `;
        }).join('');

        showDropdown();

        // Update ARIA attributes
        dropdown.setAttribute('aria-activedescendant', '');
    }

    function selectSuggestion(index) {
        if (index < 0 || index >= suggestions.length) return;

        const org = suggestions[index];
        input.value = org.name;
        addToCachedAutotaskCompanies(org);
        suppressNextInputSearch = true;
        hideDropdown();

        // Trigger input event for form validation
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.focus();

        if (inputId === 'organization') {
            if (mainFormOrganizationCommitTimer) {
                clearTimeout(mainFormOrganizationCommitTimer);
                mainFormOrganizationCommitTimer = null;
            }
            commitMainOrganizationResolution(org);
        }
    }

    function highlightItem(index) {
        // Remove previous highlight
        dropdown.querySelectorAll('.autocomplete-item').forEach((item, i) => {
            item.classList.toggle('highlighted', i === index);
            item.setAttribute('aria-selected', i === index ? 'true' : 'false');
        });

        if (index >= 0 && index < suggestions.length) {
            const item = dropdown.querySelector(`[data-index="${index}"]`);
            if (item) {
                dropdown.setAttribute('aria-activedescendant', `${inputId}-item-${index}`);
                item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            }
        } else {
            dropdown.setAttribute('aria-activedescendant', '');
        }
    }

    // Debounced local filter (Supabase-backed list loaded at startup / after weekly sync)
    function performSearch(query) {
        if (autocompleteDebounceTimer) {
            clearTimeout(autocompleteDebounceTimer);
        }

        autocompleteDebounceTimer = setTimeout(() => {
            if (query.length < 2) {
                hideDropdown();
                return;
            }
            const orgs = getInstantAutocompleteResults(query, 20);
            if (autocompleteActiveInstance === inputId) {
                renderSuggestions(orgs, query);
            }
        }, AUTOCOMPLETE_DEBOUNCE_MS);
    }

    // Input event handler
    input.addEventListener('input', (e) => {
        if (suppressNextInputSearch) {
            suppressNextInputSearch = false;
            hideDropdown();
            return;
        }
        const query = e.target.value.trim();
        autocompleteActiveInstance = inputId;

        if (query.length < 2) {
            hideDropdown();
            return;
        }

        const instantOrgs = getInstantAutocompleteResults(query, 20);
        if (instantOrgs.length > 0) {
            renderSuggestions(instantOrgs, query);
        }

        performSearch(query);
    });

    // Focus event handler
    input.addEventListener('focus', () => {
        autocompleteActiveInstance = inputId;
        const query = input.value.trim();
        if (query.length >= 2) {
            const inst = getInstantAutocompleteResults(query, 20);
            if (inst.length > 0) {
                renderSuggestions(inst, query);
                return;
            }
        }
        if (query.length >= 2 && suggestions.length > 0) {
            showDropdown();
        }
    });

    // Blur event handler (with delay to allow clicks)
    input.addEventListener('blur', () => {
        setTimeout(() => {
            if (autocompleteActiveInstance !== inputId) {
                hideDropdown();
            }
        }, 200);
    });

    // Keyboard navigation
    input.addEventListener('keydown', (e) => {
        if (!dropdown.classList.contains('show')) {
            if (e.key === 'ArrowDown' && input.value.trim().length >= 2) {
                const qv = input.value.trim();
                const inst = getInstantAutocompleteResults(qv, 20);
                if (inst.length > 0) {
                    renderSuggestions(inst, qv);
                }
                performSearch(qv);
                e.preventDefault();
            }
            return;
        }

        switch (e.key) {
            case 'ArrowDown':
                e.preventDefault();
                selectedIndex = Math.min(selectedIndex + 1, suggestions.length - 1);
                highlightItem(selectedIndex);
                break;
            case 'ArrowUp':
                e.preventDefault();
                selectedIndex = Math.max(selectedIndex - 1, -1);
                highlightItem(selectedIndex);
                break;
            case 'Enter':
                e.preventDefault();
                if (selectedIndex >= 0) {
                    selectSuggestion(selectedIndex);
                } else if (suggestions.length > 0) {
                    const currentValue = input.value.trim().toLowerCase();
                    const exactIndex = suggestions.findIndex((org) => {
                        return String(org?.name || '').trim().toLowerCase() === currentValue;
                    });
                    selectSuggestion(exactIndex >= 0 ? exactIndex : 0);
                } else {
                    hideDropdown();
                }
                break;
            case 'Escape':
                e.preventDefault();
                hideDropdown();
                input.focus();
                break;
        }
    });

    // Click handler for dropdown items
    dropdown.addEventListener('click', (e) => {
        const item = e.target.closest('.autocomplete-item');
        if (!item) return;

        const index = parseInt(item.getAttribute('data-index'), 10);
        if (!isNaN(index)) {
            selectSuggestion(index);
        }
    });

    // Click outside to close
    document.addEventListener('click', (e) => {
        if (!input.contains(e.target) && !dropdown.contains(e.target)) {
            if (autocompleteActiveInstance === inputId) {
                hideDropdown();
            }
        }
    });

    if (inputId === 'organization') {
        input.addEventListener('input', () => {
            scheduleMainOrganizationResolution();
        });
        input.addEventListener('blur', () => {
            // #region agent log
            fetch('http://127.0.0.1:7442/ingest/de52a58c-6176-4a1a-a3fe-7fb8f60f932e',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'76bee9'},body:JSON.stringify({sessionId:'76bee9',runId:'baseline',hypothesisId:'H1',location:'script.js:1689',message:'organizationBlurScheduledCommit',data:{organizationValue:String(input.value||''),resolvedOrgId:String(resolvedMainFormOrganization?.autotaskId||'')},timestamp:Date.now()})}).catch(()=>{})
            // #endregion
            setTimeout(() => scheduleMainOrganizationResolution(), 280);
        });
    }
}

async function mapRowToEntry(row) {
    let name = row.name || '';
    let phone = row.phone || '';

    if (encryptionState.enabled) {
        if (row.name_ciphertext) {
            try {
                name = await decryptValue('name', row.name_ciphertext) || '';
            } catch (e) {
                console.error('Failed to decrypt name for row', row.id, e);
            }
        }
        if (row.phone_ciphertext) {
            try {
                phone = await decryptValue('phone', row.phone_ciphertext) || '';
            } catch (e) {
                console.error('Failed to decrypt phone for row', row.id, e);
            }
        }
    } else if (DEBUG_ENCRYPTION && (row.name_ciphertext || row.phone_ciphertext) && debugDecryptSkipLoggedCount < 20) {
        debugDecryptSkipLoggedCount += 1
        console.warn('[decrypt-skip] encryption disabled but ciphertext present for row', row.id, {
            hasNameCiphertext: !!row.name_ciphertext,
            hasPhoneCiphertext: !!row.phone_ciphertext
        })
    }

    return {
        id: row.id,
        name,
        phone,
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
            updateRecentTicketsLegend();
            return;
        }
        const uid = session.user.id;
        const prevSameUser = currentUserProfile?.id === uid ? currentUserProfile : null;
        const emailFallback = session.user.email || 'You';
        const metaName = clampDisplayName(session.user.user_metadata?.full_name);

        const fetchProfileRow = async () =>
            supabase.from('profiles').select('full_name, is_admin').eq('id', uid).maybeSingle();

        let { data, error } = await fetchProfileRow();
        if (error) {
            await new Promise((r) => setTimeout(r, 400));
            ({ data, error } = await fetchProfileRow());
        }

        if (error) {
            console.error('loadCurrentUserProfile error:', error);
            currentUserProfile = {
                id: uid,
                full_name: (prevSameUser && prevSameUser.full_name) || metaName || emailFallback,
                is_admin: prevSameUser ? !!prevSameUser.is_admin : false,
                profile_load_error: true,
            };
            profileCache.set(uid, currentUserProfile.full_name);
            updateAccountAdminTabVisibility();
            updateRecentTicketsLegend();
            return;
        }

        if (!data) {
            const seedName = metaName || (emailFallback.includes('@') ? emailFallback.split('@')[0] : emailFallback) || 'User';
            const { error: upErr } = await supabase
                .from('profiles')
                .upsert(
                    { id: uid, full_name: seedName, updated_at: new Date().toISOString() },
                    { onConflict: 'id' },
                );
            if (upErr) console.error('loadCurrentUserProfile self-heal upsert:', upErr);
            ({ data, error } = await fetchProfileRow());
        }

        if (error || !data) {
            currentUserProfile = {
                id: uid,
                full_name: metaName || emailFallback,
                is_admin: false,
            };
        } else {
            currentUserProfile = {
                id: uid,
                full_name: data.full_name || metaName || emailFallback,
                is_admin: !!data.is_admin,
            };
        }
        profileCache.set(uid, currentUserProfile.full_name);
        updateAccountAdminTabVisibility();
        updateRecentTicketsLegend();
    } catch (err) {
        console.error('loadCurrentUserProfile exception:', err);
    }
}

async function completeAuthenticatedStartup(appShell, authScreen) {
    await loadCurrentUserProfile();
    showApp(appShell, authScreen);
    setupLogout();
    subscribeRealtime();
    await initApp();
}

async function tryConsumePendingAuthDeepLink(appShell, authScreen) {
    const getPending = window.electronAPI?.getPendingAuthDeepLink;
    if (typeof getPending !== 'function') return false;
    const url = await getPending();
    if (!url) return false;
    const { ok } = await applyAuthDeepLinkSession(url);
    if (!ok) return false;
    const supabase = getSupabase();
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return false;
    await completeAuthenticatedStartup(appShell, authScreen);
    showNotification('You are signed in. If you reset your password, set a new one under Settings, then Security.');
    return true;
}

function ensureAuthDeepLinkListener(appShell, authScreen) {
    if (authDeepLinkListenerBound) return;
    authDeepLinkListenerBound = true;
    window.electronAPI?.onAuthDeepLink?.(async (url) => {
        const { ok } = await applyAuthDeepLinkSession(url);
        if (!ok) return;
        const supabase = getSupabase();
        if (!supabase) return;
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) return;
        if (document.body?.getAttribute('data-shell') !== 'auth') return;
        await completeAuthenticatedStartup(appShell, authScreen);
        showNotification('You are signed in. If you reset your password, set a new one under Settings, then Security.');
    });
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

async function updateAppVersionLabel() {
    const versionLabel = document.getElementById('appVersion');
    if (!versionLabel) return;
    let versionText = '';
    if (window.electronAPI?.getAppVersion) {
        versionText = String(await window.electronAPI.getAppVersion().catch(() => '') || '').trim();
    }
    versionLabel.textContent = versionText ? `v${versionText}` : 'v--';
}

// Initialize: auth gate then app
document.addEventListener('DOMContentLoaded', async () => {
    try {
        await updateAppVersionLabel();
        initTheme();
        initWaterCanvasRipples();
        const authScreen = document.getElementById('authScreen');
        const appShell = document.getElementById('appShell');

        if (useSupabase()) {
            // Never show the logged-in UI until we know session state.
            showAuth(authScreen, appShell);
            const supabase = getSupabase();
            if (!supabase) {
                showApp(appShell, authScreen);
                await initApp();
                return;
            }
            const { data: { session } } = await supabase.auth.getSession();
            if (session) {
                await completeAuthenticatedStartup(appShell, authScreen);
            } else {
                const openedViaDeepLink = await tryConsumePendingAuthDeepLink(appShell, authScreen);
                if (!openedViaDeepLink) {
                    setupAuthListeners();
                }
            }
        } else {
            // Supabase is required — show configuration message only
            showAuth(authScreen, appShell);
            document.querySelector('.auth-layout')?.classList.add('auth-layout--supabase-missing');
            const noConfigEl = document.getElementById('authNoConfig');
            if (noConfigEl) {
                noConfigEl.classList.remove('hidden');
                const titleEl = noConfigEl.querySelector('.auth-no-config-title');
                const bodyEl = noConfigEl.querySelector('.auth-no-config-body');
                if (titleEl) titleEl.textContent = 'Supabase configuration required';
                if (bodyEl) {
                    bodyEl.textContent = 'Call Log requires Supabase. Add your project URL and anon key in supabaseConfig.js (see supabaseConfig.example.js).';
                }
            }
        }
    } catch (err) {
        console.error('Startup error:', err);
    }
});

function initWaterCanvasRipples() {
    const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const canvas = document.getElementById('waterCanvas');
    if (!canvas || reduceMotion) return;

    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return;

    // Low-res sim grid, scaled up. Keeps it subtle and cheap.
    let simW = 220;
    let simH = 140;
    let a = new Float32Array(simW * simH);
    let b = new Float32Array(simW * simH);
    let raf = 0;

    const off = document.createElement('canvas');
    const offCtx = off.getContext('2d', { alpha: true });
    if (!offCtx) return;

    function resize() {
        const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
        const w = Math.max(1, Math.floor(window.innerWidth * dpr));
        const h = Math.max(1, Math.floor(window.innerHeight * dpr));
        canvas.width = w;
        canvas.height = h;
        canvas.style.width = '100%';
        canvas.style.height = '100%';

        // Scale simulation with viewport (a bit denser for smoother look), but clamp for stability/perf.
        simW = Math.max(220, Math.min(360, Math.floor(window.innerWidth / 5.5)));
        simH = Math.max(150, Math.min(260, Math.floor(window.innerHeight / 5.5)));
        a = new Float32Array(simW * simH);
        b = new Float32Array(simW * simH);

        off.width = simW;
        off.height = simH;
        off.style.imageRendering = 'auto';
    }

    function idx(x, y) {
        return (y * simW + x) | 0;
    }

    function splash(nx, ny, strength = 0.9, radius = 6) {
        const x0 = Math.floor(nx * (simW - 1));
        const y0 = Math.floor(ny * (simH - 1));
        const r2 = radius * radius;
        for (let y = -radius; y <= radius; y++) {
            const yy = y0 + y;
            if (yy <= 1 || yy >= simH - 2) continue;
            for (let x = -radius; x <= radius; x++) {
                const xx = x0 + x;
                if (xx <= 1 || xx >= simW - 2) continue;
                const d2 = x * x + y * y;
                if (d2 > r2) continue;
                const falloff = 1 - d2 / r2;
                a[idx(xx, yy)] += strength * falloff;
            }
        }
    }

    function step() {
        // Simple 2-buffer wave propagation.
        const damp = 0.985;
        for (let y = 1; y < simH - 1; y++) {
            for (let x = 1; x < simW - 1; x++) {
                const i = idx(x, y);
                const v =
                    (a[i - 1] + a[i + 1] + a[i - simW] + a[i + simW]) * 0.5 -
                    b[i];
                b[i] = v * damp;
            }
        }
        const tmp = a;
        a = b;
        b = tmp;
    }

    function render(t) {
        step();

        // Render: caustics/refraction feel (watery, not noisy).
        const img = offCtx.createImageData(simW, simH);
        const data = img.data;
        const time = (t || 0) * 0.001;
        const drift = time * 0.28;
        // Keep motion subtle: tiny domain warp for "water" feel, not jitter.
        const warpX = 0.26 * Math.sin(time * 0.55);
        const warpY = 0.24 * Math.cos(time * 0.5);

        // Light direction for "water light" shimmer.
        const lx = -0.35;
        const ly = -0.2;
        const lz = 1.0;
        const lLen = Math.hypot(lx, ly, lz) || 1;
        const nlx = lx / lLen;
        const nly = ly / lLen;
        const nlz = lz / lLen;

        // Small helper for indexing with clamp.
        const clamp = (v, lo, hi) => (v < lo ? lo : (v > hi ? hi : v));
        for (let y = 0; y < simH; y++) {
            for (let x = 0; x < simW; x++) {
                // Domain warp so the pattern "swims" like water.
                const wx = x + warpX * Math.sin(y * 0.06 + drift);
                const wy = y + warpY * Math.cos(x * 0.055 - drift * 0.9);
                const ix = clamp(wx | 0, 1, simW - 2);
                const iy = clamp(wy | 0, 1, simH - 2);

                const i = idx(ix, iy);
                const v = a[i];

                // Surface normal approx from height gradient.
                const gx = (a[idx(ix + 1, iy)] - a[idx(ix - 1, iy)]) * 0.5;
                const gy = (a[idx(ix, iy + 1)] - a[idx(ix, iy - 1)]) * 0.5;

                // Normal pointing "out of screen"
                const nz = 1.0;
                // Softer "surface" so highlights don't spike.
                const nx = -gx * 1.6;
                const ny = -gy * 1.6;
                const nLen = Math.hypot(nx, ny, nz) || 1;
                const nnx = nx / nLen;
                const nny = ny / nLen;
                const nnz = nz / nLen;

                // Light response: brighter where normal aligns.
                const ndotl = Math.max(0, nnx * nlx + nny * nly + nnz * nlz);

                // "Caustic intensity": emphasize ridges + spec-ish response.
                const ridge = Math.min(1, Math.abs(gx) + Math.abs(gy));
                // Keep the watery character but lower overall contrast/energy.
                let caustic = ndotl * ndotl * 0.62 + ridge * 0.22;
                caustic = Math.min(1, Math.max(0, caustic));

                // Gentle breathing so it doesn't look like static lighting.
                const breathe = 0.92 + 0.08 * Math.sin(drift + (ix * 0.028) + (iy * 0.026));
                caustic *= breathe;

                // Alpha curve: keep subtle but noticeably watery.
                let alpha = 5 + 46 * Math.pow(caustic, 1.75) + 7 * Math.min(1, Math.abs(v));
                alpha = clamp(alpha, 0, 58);

                // Water tint (cool/teal) with slight variation.
                const tint = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin((ix * 0.04 + iy * 0.037) + drift * 0.85));
                const r = 202 + 10 * tint;
                const gch = 220 + 18 * tint;
                const bch = 236 + 14 * tint;

                const o = (y * simW + x) * 4;
                data[o + 0] = r;
                data[o + 1] = gch;
                data[o + 2] = bch;
                data[o + 3] = alpha;
            }
        }

        offCtx.putImageData(img, 0, 0);

        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.imageSmoothingEnabled = true;
        ctx.globalCompositeOperation = 'source-over';

        // Soft blur by layered draws (cheap faux blur), kept very subtle.
        ctx.globalAlpha = 0.28;
        ctx.drawImage(off, -3, -2, canvas.width + 6, canvas.height + 4);
        ctx.globalAlpha = 0.34;
        ctx.drawImage(off, 2, 2, canvas.width - 1, canvas.height - 1);
        ctx.globalAlpha = 0.62;
        ctx.drawImage(off, 0, 0, canvas.width, canvas.height);

        raf = requestAnimationFrame(render);
    }

    // Pointer interaction: small droplets.
    let lastSplash = 0;
    const onPointer = (e) => {
        const now = performance.now();
        if (now - lastSplash < 18) return;
        lastSplash = now;
        const w = window.innerWidth || 1;
        const h = window.innerHeight || 1;
        const nx = Math.max(0, Math.min(1, e.clientX / w));
        const ny = Math.max(0, Math.min(1, e.clientY / h));

        const shell = document.body?.getAttribute('data-shell') || 'auth';
        const strength = shell === 'app' ? 0.65 : 0.85;
        splash(nx, ny, strength, shell === 'app' ? 5 : 6);
    };

    window.addEventListener('resize', resize, { passive: true });
    document.addEventListener('pointermove', onPointer, { passive: true });
    document.addEventListener('pointerdown', (e) => {
        onPointer(e);
        // A slightly stronger drop on click/tap.
        const w = window.innerWidth || 1;
        const h = window.innerHeight || 1;
        splash(Math.max(0, Math.min(1, e.clientX / w)), Math.max(0, Math.min(1, e.clientY / h)), 1.3, 9);
    }, { passive: true });
    document.addEventListener('mousemove', onPointer, { passive: true });

    resize();
    // Seed a gentle initial motion so it doesn’t start dead still.
    splash(0.35, 0.45, 0.7, 10);
    splash(0.68, 0.52, 0.55, 12);
    raf = requestAnimationFrame(render);
}

function showApp(appShell, authScreen) {
    document.body?.setAttribute('data-shell', 'app');
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
    document.body?.setAttribute('data-shell', 'auth');
    if (appShell) {
        appShell.classList.add('hidden');
        appShell.setAttribute('aria-hidden', 'true');
    }
    if (authScreen) {
        authScreen.classList.remove('hidden');
        authScreen.setAttribute('aria-hidden', 'false');
        document.getElementById('authNoConfig')?.classList.add('hidden');
        document.querySelector('.auth-card')?.classList.remove('hidden');
        
        // Load saved email if available, and clear password for security
        const emailInput = document.getElementById('authEmail');
        const passwordInput = document.getElementById('authPassword');
        
        // Always clear password for security
        if (passwordInput) {
            passwordInput.value = '';
        }
        
        if (emailInput) {
            try {
                const savedEmail = localStorage.getItem('calllog-saved-email');
                if (savedEmail) {
                    emailInput.value = savedEmail;
                }
            } catch (e) {
                // Ignore localStorage errors
            }
        }
    }
    resetAuthForgotToLogin();
}

function resetAuthForgotToLogin() {
    const panel = document.getElementById('authForgotPanel');
    const pwdG = document.getElementById('authPasswordGroup');
    const act = document.getElementById('authPrimaryActions');
    const forgotLink = document.getElementById('authForgotWrap');
    const title = document.querySelector('#authFormCard .auth-title');
    const subtitle = document.querySelector('#authFormCard .auth-subtitle');
    if (panel) {
        panel.classList.add('hidden');
        panel.setAttribute('aria-hidden', 'true');
    }
    pwdG?.classList.remove('hidden');
    act?.classList.remove('hidden');
    forgotLink?.classList.remove('hidden');
    if (title) title.textContent = 'Sign in';
    if (subtitle) {
        subtitle.textContent =
            'Sign in with the account an administrator invited. New users receive an email invite.';
    }
}

function setupAuthListeners() {
    const form = document.getElementById('authForm');
    const signInBtn = document.getElementById('authSignInBtn');
    const authError = document.getElementById('authError');
    const authScreen = document.getElementById('authScreen');
    const appShell = document.getElementById('appShell');
    const layout = document.querySelector('.auth-layout');
    const brandCard = document.getElementById('authBrandCard');
    const formCard = document.getElementById('authFormCard');
    const supabase = getSupabase();
    if (!supabase || !form) return;

    function showAuthBrand() {
        layout?.classList.remove('is-form');
        formCard?.setAttribute('aria-hidden', 'true');
        brandCard?.focus?.();
    }

    function showAuthForm() {
        layout?.classList.add('is-form');
        formCard?.setAttribute('aria-hidden', 'false');
        
        // Load saved email if available
        const emailInput = document.getElementById('authEmail');
        const passwordInput = document.getElementById('authPassword');
        
        // Always clear password for security
        if (passwordInput) {
            passwordInput.value = '';
        }
        
        if (emailInput) {
            try {
                const savedEmail = localStorage.getItem('calllog-saved-email');
                if (savedEmail) {
                    emailInput.value = savedEmail;
                }
            } catch (e) {
                // Ignore localStorage errors
            }
        }
        
        setTimeout(() => {
            const emailInput = document.getElementById('authEmail');
            if (emailInput) {
                // If email is already filled, focus on password; otherwise focus on email
                if (emailInput.value.trim()) {
                    document.getElementById('authPassword')?.focus();
                } else {
                    emailInput.focus();
                }
            }
        }, 0);
    }

    // Default view: brand card centered; click to continue.
    showAuthBrand();

    brandCard?.addEventListener('click', showAuthForm);
    brandCard?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            showAuthForm();
        }
    });

    function enterAuthForgotMode() {
        authError.textContent = '';
        authError.style.color = '';
        resetAuthForgotToLogin();
        const pwdG = document.getElementById('authPasswordGroup');
        const act = document.getElementById('authPrimaryActions');
        const forgotLink = document.getElementById('authForgotWrap');
        const panel = document.getElementById('authForgotPanel');
        const title = document.querySelector('#authFormCard .auth-title');
        const subtitle = document.querySelector('#authFormCard .auth-subtitle');
        pwdG?.classList.add('hidden');
        act?.classList.add('hidden');
        forgotLink?.classList.add('hidden');
        panel?.classList.remove('hidden');
        panel?.setAttribute('aria-hidden', 'false');
        if (title) title.textContent = 'Reset password';
        if (subtitle) subtitle.textContent = 'We will email you a secure link.';
        setTimeout(() => document.getElementById('authEmail')?.focus(), 0);
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
            try {
                localStorage.setItem('calllog-saved-email', email);
            } catch (e) {
                // Ignore localStorage errors
            }
            await completeAuthenticatedStartup(appShell, authScreen);
        }
    }

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
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

    document.getElementById('authForgotBtn')?.addEventListener('click', () => {
        enterAuthForgotMode();
    });
    document.getElementById('authForgotBackBtn')?.addEventListener('click', () => {
        authError.textContent = '';
        authError.style.color = '';
        resetAuthForgotToLogin();
    });
    document.getElementById('authForgotSendBtn')?.addEventListener('click', async () => {
        authError.textContent = '';
        authError.style.color = '';
        const email = document.getElementById('authEmail')?.value.trim() || '';
        if (!email) {
            authError.textContent = 'Enter your email address.';
            return;
        }
        const sendBtn = document.getElementById('authForgotSendBtn');
        if (sendBtn) {
            sendBtn.disabled = true;
            sendBtn.textContent = 'Sending…';
        }
        try {
            const { error } = await supabase.auth.resetPasswordForEmail(email, {
                redirectTo: getPasswordRecoveryRedirectUrl(),
            });
            if (error) {
                authError.textContent = error.message || 'Could not send reset email.';
                return;
            }
            authError.textContent =
                'If an account exists for that email, you will receive a link shortly. Open it on this computer.';
            authError.style.color = 'var(--success)';
        } catch (err) {
            authError.textContent = err?.message || 'Could not send reset email.';
        } finally {
            if (sendBtn) {
                sendBtn.disabled = false;
                sendBtn.textContent = 'Send reset link';
            }
        }
    });

    ensureAuthDeepLinkListener(appShell, authScreen);

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

async function runAuthSignOutAndTeardown(signOutOptions) {
    const supabase = getSupabase();
    const logoutBtn = document.getElementById('logoutBtn');
    const profileBtn = document.getElementById('profileBtn');
    const accountBackBtn = document.getElementById('accountBackBtn');
    if (supabase) {
        await supabase.auth.signOut(signOutOptions);
        if (supabaseRealtimeChannel) {
            supabase.removeChannel(supabaseRealtimeChannel);
            supabaseRealtimeChannel = null;
        }
    }

    encryptionState.enabled = false
    encryptionState.initialized = false
    encryptionState.keyVersion = 1
    encryptionState.dataKey = null
    encryptionState.blindKey = null
    encryptionState.initPromise = null

    setAppView('calls');
    if (logoutBtn) logoutBtn.style.display = 'none';
    if (profileBtn) profileBtn.style.display = 'none';
    if (accountBackBtn) accountBackBtn.style.display = 'none';
    if (logoutClickHandler) {
        logoutBtn?.removeEventListener('click', logoutClickHandler);
        logoutClickHandler = null;
    }
    const authScreen = document.getElementById('authScreen');
    const appShell = document.getElementById('appShell');
    updateRecentTicketsLegend();
    showAuth(authScreen, appShell);
    setupAuthListeners();
}

function setupLogout() {
    const logoutBtn = document.getElementById('logoutBtn');
    const profileBtn = document.getElementById('profileBtn');
    if (logoutBtn) logoutBtn.style.display = '';
    if (profileBtn) profileBtn.style.display = '';
    const accountBackBtn = document.getElementById('accountBackBtn');
    if (accountBackBtn) accountBackBtn.style.display = 'none';

    logoutClickHandler = async () => {
        await runAuthSignOutAndTeardown();
    };
    logoutBtn?.addEventListener('click', logoutClickHandler);
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
                refreshStatisticsPageIfVisible();
                refreshAdminStatsIfVisible();

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
    await initializeEncryption();
    if (DEBUG_ENCRYPTION) {
        console.debug('[initApp] encryption after init:', {
            enabled: encryptionState.enabled,
            hasDataKey: !!encryptionState.dataKey,
            hasBlindKey: !!encryptionState.blindKey
        })
    }
    if (encryptionState.enabled) {
        encryptBackfillForCurrentUser().catch((err) => {
            console.error('Backfill failed:', err);
        });
    }
    setupEventListeners();
    startCallDateAutoSync();
    setupStatisticsPageListeners();
    setupAdminStatisticsPageListeners();
    setupKeyboardShortcuts();
    setupTitlebar();

    // Reports are Supabase-only
    const reportsBtn = document.getElementById('reportsBtn');
    if (reportsBtn) reportsBtn.style.display = useSupabase() ? '' : 'none';

    // Setup organization autocomplete (only if Supabase is configured)
    if (useSupabase()) {
        setupOrganizationAutocomplete('organization', 'organization-autocomplete-list');
        setupOrganizationAutocomplete('editOrganization', 'editOrganization-autocomplete-list');
        refreshAutotaskOrgCacheAfterAuth();
        setTimeout(() => scheduleMainOrganizationResolution(), 900);
    }

    await initializeHistoryDay();
    await renderCalendar(calendarMonth);
    await loadEntries();
    await updateStats();
    fitWindowToContent();
    setupAccountUpdaterPanel();
}

// Size the main window height to fit the full content (Electron only)
function fitWindowToContent() {
    if (typeof window.electronAPI?.setWindowHeight !== 'function') return;
    // Avoid fighting user resize: only run once, only grow, and never when maximized.
    const KEY = 'calllogger-window-autosized-v1';
    try {
        if (localStorage.getItem(KEY) === '1') return;
    } catch (e) {}

    // If the window is maximized, do nothing (let the OS/window manager own sizing).
    if (window.electronAPI?.windowControls?.isMaximized) {
        window.electronAPI.windowControls.isMaximized().then((isMax) => {
            if (isMax) return;
            doFit();
        }).catch(() => doFit());
        return;
    }

    doFit();

    function doFit() {
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                const titlebar = document.querySelector('.titlebar');
                const formContainer = document.querySelector('.form-container');
                const titlebarHeight = titlebar ? titlebar.offsetHeight : 45;
                const containerPadding = 48;
                const formHeight = formContainer ? formContainer.scrollHeight : 600;
                const totalHeight = titlebarHeight + containerPadding + formHeight;

                // Only grow the window; never shrink it.
                const current = window.innerHeight || 0;
                if (current && totalHeight <= current + 4) {
                    try { localStorage.setItem(KEY, '1'); } catch (e) {}
                    return;
                }

                window.electronAPI.setWindowHeight(totalHeight);
                try { localStorage.setItem(KEY, '1'); } catch (e) {}
            });
        });
    }
}

const THEME_KEY = 'calllogger-theme';

function initTheme() {
    const saved = localStorage.getItem(THEME_KEY);
    // Default to dark unless user explicitly chose light.
    const theme = saved === 'light' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', theme);
    // Persist default so the first launch is consistent across reloads.
    if (!saved) localStorage.setItem(THEME_KEY, theme);
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
    // Migration from local storage removed - using Supabase only
    // If you need to migrate data, use Supabase's import tools or write a one-time migration script
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
    setupCallDateAutoModeListeners();
    
    // Search functionality (inside History panel)
    document.getElementById('searchBtn').addEventListener('click', toggleSearch);
    document.getElementById('closeSearch').addEventListener('click', toggleSearch);
    document.getElementById('searchInput').addEventListener('input', handleSearch);

    // Statistics page
    document.getElementById('statsBtn').addEventListener('click', () => {
        openStatisticsPage()
    })
    document.getElementById('reportsBtn')?.addEventListener('click', openReportsModal);

    // Day / calendar controls
    document.getElementById('historyPrevDayBtn')?.addEventListener('click', () => shiftSelectedDay(-1));
    document.getElementById('historyNextDayBtn')?.addEventListener('click', () => shiftSelectedDay(1));
    document.getElementById('historyTodayBtn')?.addEventListener('click', () => setSelectedDay(getTodayKey(), true));
    document.getElementById('historyCalendarBtn')?.addEventListener('click', openCalendar);

    document.getElementById('closeCalendarModal')?.addEventListener('click', closeCalendar);
    document.getElementById('calendarModal')?.addEventListener('click', (e) => {
        if (e.target?.id === 'calendarModal') closeCalendar();
    });
    document.getElementById('calPrevMonth')?.addEventListener('click', () => {
        calendarMonthNavChain = calendarMonthNavChain
            .then(() => navigateCalendarMonth(-1))
            .catch((err) => console.warn('[calendar] navigate prev', err));
    });
    document.getElementById('calNextMonth')?.addEventListener('click', () => {
        calendarMonthNavChain = calendarMonthNavChain
            .then(() => navigateCalendarMonth(1))
            .catch((err) => console.warn('[calendar] navigate next', err));
    });
    
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
    document.getElementById('closeReportsModal')?.addEventListener('click', closeReportsModal);
    document.getElementById('editForm').addEventListener('submit', handleEditSubmit);

    setupAccountPageListeners();
    setupHistoryPanelTabs();
    bindRecentTicketsListClicks();

    // Close modals on outside click
    // Keep Edit modal open on backdrop clicks to prevent accidental dismiss while editing.
    document.getElementById('editModal').addEventListener('click', (e) => {
        if (e.target.id === 'editModal') return;
    });
    document.getElementById('reportsModal')?.addEventListener('click', (e) => {
        if (e.target.id === 'reportsModal') closeReportsModal();
    });

    setupEntriesListClick();

    // Reports actions
    document.getElementById('reportsRefreshBtn')?.addEventListener('click', () => refreshReports());
    document.getElementById('runReportsNowBtn')?.addEventListener('click', () => runReportsNow());
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

async function navigateCalendarMonth(deltaMonths) {
    if (!calendarMonth) {
        calendarMonth = new Date();
        calendarMonth.setDate(1);
    }
    const d = new Date(calendarMonth);
    d.setMonth(d.getMonth() + deltaMonths);
    d.setDate(1);
    calendarMonth = d;
    await renderCalendar(calendarMonth);
}

async function renderCalendar(monthDate) {
    const grid = document.getElementById('calendarGrid');
    const label = document.getElementById('calendarMonthLabel');
    if (!grid || !label) return;

    const monthStart = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1);

    const entries = await getEntries();
    const daysWithCalls = getDaysWithCalls(entries);
    const todayKey = getTodayKey();

    // Update header only after data is loaded so it stays in sync with the grid (avoids stale cells)
    label.textContent = monthStart.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

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
            <button class="${classes}" type="button" data-testid="calendar-day" data-day="${key}" aria-label="${key}">
                ${d.getDate()}
            </button>
        `);
    }

    grid.innerHTML = cells.join('');

    // Day click handlers
    grid.querySelectorAll('[data-testid="calendar-day"]').forEach((btn) => {
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
            } else if (document.getElementById('reportsModal')?.classList.contains('show')) {
                closeReportsModal();
            } else if (document.getElementById('calendarModal')?.classList.contains('show')) {
                closeCalendar();
            } else if (document.getElementById('confirmModal')?.classList.contains('show')) {
                closeConfirm(false);
            } else if (currentAppView === 'account' || currentAppView === 'statistics' || currentAppView === 'adminStatistics') {
                setAppView('calls');
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

function toDateTimeLocalValue(now = new Date()) {
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');

    return `${year}-${month}-${day}T${hours}:${minutes}`;
}

// Set current date and time in the datetime-local input
function setCurrentDateTime(options = {}) {
    const { force = false } = options;
    if (!force && !isCallDateAutoMode) return;
    const input = document.getElementById('callDate');
    if (!input) return;
    input.value = toDateTimeLocalValue(new Date());
}

function stopCallDateAutoSync() {
    if (callDateAutoSyncTimeoutId) {
        clearTimeout(callDateAutoSyncTimeoutId);
        callDateAutoSyncTimeoutId = null;
    }
    if (callDateAutoSyncIntervalId) {
        clearInterval(callDateAutoSyncIntervalId);
        callDateAutoSyncIntervalId = null;
    }
}

function startCallDateAutoSync() {
    stopCallDateAutoSync();
    isCallDateAutoMode = true;
    setCurrentDateTime({ force: true });

    const now = new Date();
    const delayToNextMinute = (60 - now.getSeconds()) * 1000 - now.getMilliseconds();
    callDateAutoSyncTimeoutId = setTimeout(() => {
        callDateAutoSyncTimeoutId = null;
        setCurrentDateTime();
        callDateAutoSyncIntervalId = setInterval(() => {
            setCurrentDateTime();
        }, 60000);
    }, Math.max(0, delayToNextMinute));
}

function setupCallDateAutoModeListeners() {
    const callDateInput = document.getElementById('callDate');
    if (!callDateInput) return;
    const setManualMode = () => {
        isCallDateAutoMode = false;
    };
    callDateInput.addEventListener('input', setManualMode);
    callDateInput.addEventListener('change', setManualMode);
    window.addEventListener('beforeunload', stopCallDateAutoSync);
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
        notes: (document.getElementById('ticketNumber') && document.getElementById('ticketNumber').value) ? document.getElementById('ticketNumber').value.trim() : '',
        timestamp: entryDate.toISOString()
    };
    if (formData.organization) {
        addToCachedAutotaskCompanies({ id: '', name: formData.organization });
    }

    try {
        const saved = await saveEntry(formData);
        if (saved == null) {
            const supabase = getSupabase();
            if (!supabase) {
                showNotification('Failed to save call. Check console for errors.');
                return;
            }
            const { data: { session } } = await supabase.auth.getSession();
            if (!session) {
                showNotification('Please log in to save calls.');
            } else if (!isPiiWriteAllowed()) {
                showNotification(
                    'Cannot save: encryption is not set up. Add CALLLOG_MASTER_KEY to supabaseConfig.js (see supabaseConfig.example.js), use the same key as your other machines, then restart the app.'
                );
            } else {
                showNotification('Failed to save call. Check console for errors.');
            }
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
        flashEntryCard(saved);
    } catch (err) {
        console.error('Save call failed:', err);
        showNotification('Failed to save call.');
    }
}

// Save entry (Supabase only). Returns id or null.
async function saveEntry(entry) {
    if (!useSupabase()) {
        console.error('Supabase is not configured. Cannot save entry.');
        return null;
    }
    const supabase = getSupabase();
    if (!supabase) {
        console.error('Supabase client not available.');
        return null;
    }
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
        console.error('No active session. Please log in.');
        return null;
    }
    if (!isPiiWriteAllowed()) {
        console.error('Refusing to save entry: encryption is not enabled.');
        return null;
    }
    const now = new Date().toISOString();
    const callTime = entry.timestamp || now;
    let nameCiphertext = null;
    let phoneCiphertext = null;
    let nameBlindIndex = null;
    let phoneBlindIndex = null;
    let keyVersion = 1;

    if (encryptionState.enabled) {
        nameCiphertext = await encryptValue('name', entry.name || '');
        phoneCiphertext = await encryptValue('phone', entry.phone || '');
        nameBlindIndex = await computeBlindIndex('name', entry.name || '');
        phoneBlindIndex = await computeBlindIndex('phone', entry.phone || '');
        keyVersion = encryptionState.keyVersion;
    }

    const { data, error } = await supabase
        .from('calls')
        .insert({
            user_id: session.user.id,
            name: encryptionState.enabled ? '' : (entry.name || ''),
            phone: encryptionState.enabled ? '' : (entry.phone || ''),
            organization: entry.organization || '',
            device_name: entry.deviceName || '',
            support_request: entry.supportRequest || '',
            notes: entry.notes || '',
            name_ciphertext: nameCiphertext,
            name_blind_index: nameBlindIndex,
            phone_ciphertext: phoneCiphertext,
            phone_blind_index: phoneBlindIndex,
            key_version: keyVersion,
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

// Get all entries (Supabase only)
async function getEntries() {
    if (!useSupabase()) {
        console.error('Supabase is not configured. Cannot retrieve entries.');
        return [];
    }
    const supabase = getSupabase();
    if (!supabase) {
        console.error('Supabase client not available.');
        return [];
    }
    const { data, error } = await supabase
        .from('calls')
        .select('*')
        .order('call_time', { ascending: false });
    if (error) {
        console.error('getEntries Supabase error:', error);
        return [];
    }
    const rows = data || [];
    return Promise.all(rows.map(mapRowToEntry));
}

async function findEntriesByExactPhone(phone) {
    if (!encryptionState.enabled) return [];
    const blindIndex = await computeBlindIndex('phone', phone);
    if (!blindIndex) return [];
    const supabase = getSupabase();
    if (!supabase) return [];
    const { data, error } = await supabase
        .from('calls')
        .select('*')
        .eq('phone_blind_index', blindIndex)
        .order('call_time', { ascending: false });
    if (error) {
        console.error('findEntriesByExactPhone error:', error);
        return [];
    }
    return Promise.all((data || []).map(mapRowToEntry));
}

async function encryptBackfillForCurrentUser(batchSize = 200) {
    if (!encryptionState.enabled || !useSupabase()) return;
    const supabase = getSupabase();
    if (!supabase) return;
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;

    const { data, error } = await supabase
        .from('calls')
        .select('id, user_id, name, phone, name_ciphertext, phone_ciphertext, name_blind_index, phone_blind_index')
        .eq('user_id', session.user.id)
        .or('name_ciphertext.is.null,phone_ciphertext.is.null')
        .order('updated_at', { ascending: true })
        .limit(batchSize);

    if (error) {
        console.error('Backfill select error:', error);
        return;
    }

    const rows = data || [];
    for (const row of rows) {
        const now = new Date().toISOString();
        const patch = {
            key_version: encryptionState.keyVersion,
            updated_at: now
        };

        let hasChanges = false;

        // NAME
        if (row.name_ciphertext) {
            // If ciphertext already exists but plaintext `name` is still present, clear it.
            if (row.name) {
                patch.name = '';
                hasChanges = true;
            }

            // Ensure blind index exists for exact/fast matching.
            if (!row.name_blind_index) {
                let namePlain = row.name || '';
                if (!namePlain) {
                    try {
                        namePlain = (await decryptValue('name', row.name_ciphertext)) || '';
                    } catch (e) {
                        console.error('Backfill decrypt name failed for row', row.id, e);
                        namePlain = '';
                    }
                }

                if (namePlain) {
                    patch.name_blind_index = await computeBlindIndex('name', namePlain);
                    hasChanges = true;
                }
            }
        } else if (row.name) {
            // No ciphertext: encrypt and clear plaintext.
            patch.name_ciphertext = await encryptValue('name', row.name);
            patch.name_blind_index = await computeBlindIndex('name', row.name);
            patch.name = '';
            hasChanges = true;
        }

        // PHONE
        if (row.phone_ciphertext) {
            if (row.phone) {
                patch.phone = '';
                hasChanges = true;
            }

            if (!row.phone_blind_index) {
                let phonePlain = row.phone || '';
                if (!phonePlain) {
                    try {
                        phonePlain = (await decryptValue('phone', row.phone_ciphertext)) || '';
                    } catch (e) {
                        console.error('Backfill decrypt phone failed for row', row.id, e);
                        phonePlain = '';
                    }
                }

                if (phonePlain) {
                    patch.phone_blind_index = await computeBlindIndex('phone', phonePlain);
                    hasChanges = true;
                }
            }
        } else if (row.phone) {
            patch.phone_ciphertext = await encryptValue('phone', row.phone);
            patch.phone_blind_index = await computeBlindIndex('phone', row.phone);
            patch.phone = '';
            hasChanges = true;
        }

        if (!hasChanges) continue;

        const { error: updateError } = await supabase
            .from('calls')
            .update(patch)
            .eq('id', row.id)
            .eq('user_id', session.user.id);
        if (updateError) {
            console.error('Backfill update failed for row', row.id, updateError);
        }
    }

    // Second pass: clear plaintext when ciphertext already exists (this can happen if a previous
    // run encrypted only one of the fields).
    const now = new Date().toISOString();

    try {
        const { data: nameRows, error: nameErr } = await supabase
            .from('calls')
            .select('id, name, name_ciphertext, name_blind_index')
            .eq('user_id', session.user.id)
            .neq('name', '')
            .not('name_ciphertext', 'is', null)
            .order('updated_at', { ascending: true })
            .limit(batchSize);

        if (nameErr) throw nameErr;

        for (const r of (nameRows || [])) {
            const patch = {
                name: '',
                updated_at: now,
                key_version: encryptionState.keyVersion
            };

            if (!r.name_blind_index && r.name) {
                patch.name_blind_index = await computeBlindIndex('name', r.name);
            }

            if (!patch.name_blind_index && !r.name && r.name_ciphertext) {
                try {
                    const plain = (await decryptValue('name', r.name_ciphertext)) || '';
                    if (plain) patch.name_blind_index = await computeBlindIndex('name', plain);
                } catch (e) {
                    console.error('Backfill decrypt name (cleanup) failed for row', r.id, e);
                }
            }

            const { error: updateError } = await supabase
                .from('calls')
                .update(patch)
                .eq('id', r.id)
                .eq('user_id', session.user.id);
            if (updateError) console.error('Backfill cleanup name update failed for row', r.id, updateError);
        }
    } catch (e) {
        console.error('Backfill cleanup name pass failed:', e);
    }

    try {
        const { data: phoneRows, error: phoneErr } = await supabase
            .from('calls')
            .select('id, phone, phone_ciphertext, phone_blind_index')
            .eq('user_id', session.user.id)
            .neq('phone', '')
            .not('phone_ciphertext', 'is', null)
            .order('updated_at', { ascending: true })
            .limit(batchSize);

        if (phoneErr) throw phoneErr;

        for (const r of (phoneRows || [])) {
            const patch = {
                phone: '',
                updated_at: now,
                key_version: encryptionState.keyVersion
            };

            if (!r.phone_blind_index && r.phone) {
                patch.phone_blind_index = await computeBlindIndex('phone', r.phone);
            }

            if (!patch.phone_blind_index && !r.phone && r.phone_ciphertext) {
                try {
                    const plain = (await decryptValue('phone', r.phone_ciphertext)) || '';
                    if (plain) patch.phone_blind_index = await computeBlindIndex('phone', plain);
                } catch (e) {
                    console.error('Backfill decrypt phone (cleanup) failed for row', r.id, e);
                }
            }

            const { error: updateError } = await supabase
                .from('calls')
                .update(patch)
                .eq('id', r.id)
                .eq('user_id', session.user.id);
            if (updateError) console.error('Backfill cleanup phone update failed for row', r.id, updateError);
        }
    } catch (e) {
        console.error('Backfill cleanup phone pass failed:', e);
    }
}

// Load and display entries
async function loadEntries() {
    const entriesList = document.getElementById('entriesList');
    if (!entriesList) return;

    if (DEBUG_ENCRYPTION) {
        console.debug('[entries] encryption state at load:', {
            enabled: encryptionState.enabled,
            hasDataKey: !!encryptionState.dataKey,
            hasBlindKey: !!encryptionState.blindKey
        })
    }

    setEntriesLoading(true);

    const entries = await getEntries();

    // First filter by selected day (local day boundaries)
    const dayKey = selectedDay || getTodayKey();
    let filteredEntries = entries.filter((entry) => toLocalDayKey(new Date(entry.timestamp)) === dayKey);

    // Then apply text filter within the day
    if (currentFilter) {
        const filterLower = currentFilter.toLowerCase();
        let exactPhoneMatches = null;
        if (encryptionState.enabled && /^[+\d()\-\s]{5,}$/.test(currentFilter.trim())) {
            const rows = await findEntriesByExactPhone(currentFilter.trim());
            exactPhoneMatches = new Set(rows.map((r) => String(r.id)));
        }
        filteredEntries = filteredEntries.filter(entry =>
            entry.name.toLowerCase().includes(filterLower) ||
            String(entry.phone || entry.mobile || '').toLowerCase().includes(filterLower) ||
            (exactPhoneMatches ? exactPhoneMatches.has(String(entry.id)) : false) ||
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

        const html = `
            <div class="empty-state">
                <div class="empty-state-icon">${emptyIcon}</div>
                <p>${entries.length === 0 ? 'No calls logged yet' : (totalForDay === 0 ? 'No calls for this day' : 'No matching calls found')}</p>
                <p style="font-size: 0.9em; margin-top: 5px;">
                    ${entries.length === 0 ? 'Start logging calls using the form on the left' : (totalForDay === 0 ? 'Pick another day in the calendar' : 'Try adjusting your search terms')}
                </p>
            </div>
        `;
        entriesList.innerHTML = html;
        setEntriesLoading(false);
        return;
    }
    
    const html = filteredEntries.map((entry, index) => createEntryCard(entry, index)).join('');

    await updateStats();
    entriesList.innerHTML = html;
    setEntriesLoading(false);
}

function setEntriesLoading(isLoading) {
    const list = document.getElementById('entriesList');
    if (!list) return;
    list.classList.toggle('is-loading', !!isLoading);
    list.classList.toggle('is-loaded', !isLoading);
    list.setAttribute('aria-busy', isLoading ? 'true' : 'false');
    if (!isLoading) return;

    // Keep this fast and lightweight: 4 cards approximating real layout
    list.innerHTML = `
        <div class="loading-header" aria-hidden="true">
            <span class="loading-fish">
                <svg class="icon" aria-hidden="true"><use href="#i-fish"></use></svg>
                <span>Loading calls</span><span class="loading-dots"></span>
            </span>
        </div>
        <div class="skeleton-card" aria-hidden="true">
            <div class="skeleton-line title"></div>
            <div class="skeleton-line meta"></div>
            <div class="skeleton-line wide"></div>
            <div class="skeleton-line mid"></div>
            <div class="skeleton-line short"></div>
        </div>
        <div class="skeleton-card" aria-hidden="true">
            <div class="skeleton-line title" style="width: 46%"></div>
            <div class="skeleton-line meta" style="width: 38%"></div>
            <div class="skeleton-line wide"></div>
            <div class="skeleton-line mid" style="width: 66%"></div>
            <div class="skeleton-line short" style="width: 58%"></div>
        </div>
        <div class="skeleton-card" aria-hidden="true">
            <div class="skeleton-line title" style="width: 62%"></div>
            <div class="skeleton-line meta" style="width: 30%"></div>
            <div class="skeleton-line wide"></div>
            <div class="skeleton-line mid"></div>
            <div class="skeleton-line short" style="width: 44%"></div>
        </div>
        <div class="skeleton-card" aria-hidden="true">
            <div class="skeleton-line title" style="width: 52%"></div>
            <div class="skeleton-line meta" style="width: 36%"></div>
            <div class="skeleton-line wide"></div>
            <div class="skeleton-line mid" style="width: 70%"></div>
            <div class="skeleton-line short" style="width: 50%"></div>
        </div>
    `;
}

function normalizePhoneForTel(phone) {
    const raw = String(phone ?? '').trim();
    if (!raw) return '';

    // Keep a leading plus (E.164 style) and drop all other non-digit characters.
    const hasPlus = raw.startsWith('+')
    const digits = raw.replace(/[^\d]/g, '')
    if (!digits) return '';

    return hasPlus ? `+${digits}` : digits
}

// Create HTML for an entry card
function createEntryCard(entry, index = 0) {
    const date = new Date(entry.timestamp);
    const formattedDate = date.toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });

    const rawPhone = String(entry.phone || entry.mobile || '').trim();
    const telNumber = normalizePhoneForTel(rawPhone);
    const telHref = telNumber ? `tel:${telNumber}` : '';

    const phoneHtml = telHref
        ? `<a class="call-link" href="${escapeHtmlAttr(telHref)}" tabindex="0" aria-label="Call ${escapeHtml(rawPhone)}" title="Click to call">${escapeHtml(rawPhone)}</a>`
        : escapeHtml(rawPhone);
    
    return `
        <div class="entry-card entry-card--enter" data-testid="entry-card" data-id="${escapeHtmlAttr(String(entry.id))}" role="button" tabindex="0" title="Click to edit" style="--entry-cascade-delay:${Math.min(index, 24) * 55}ms">
            <div class="entry-header">
                <div class="entry-name">${escapeHtml(entry.name)}</div>
                <span class="entry-date">${formattedDate}</span>
            </div>
            <div class="entry-detail">
                <strong>Phone:</strong> ${phoneHtml}
            </div>
            <div class="entry-detail">
                <strong>Organization:</strong> ${escapeHtml(entry.organization)}
            </div>
            ${entry.deviceName ? `<div class="entry-detail"><strong>Device:</strong> ${escapeHtml(entry.deviceName)}</div>` : ''}
            <div class="entry-request copyable-request" data-copy-text="${escapeHtmlAttr((entry.supportRequest || '').trim() + (entry.deviceName ? '\n' + (entry.deviceName || '').trim() : ''))}" title="Click to copy request and device">
                <strong>Request:</strong> ${escapeHtml(entry.supportRequest)}
            </div>
            ${entry.notes ? `<div class="entry-ticket-number"><strong>Ticket number:</strong> ${escapeHtml(entry.notes)}</div>` : ''}
        </div>
    `;
}

// Delegated click: request area copies; rest of card opens edit
function setupEntriesListClick() {
    const list = document.getElementById('entriesList');
    if (!list) return;
    list.addEventListener('click', (e) => {
        const callLink = e.target.closest('.call-link')
        if (callLink) return

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
        const callLink = e.target.closest('.call-link')
        if (callLink) {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                callLink.click()
            }
            return
        }

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
    const ticketNumberEl = document.getElementById('editTicketNumber');
    if (ticketNumberEl) ticketNumberEl.value = entry.notes || '';
    
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
        notes: document.getElementById('editTicketNumber') ? document.getElementById('editTicketNumber').value.trim() : ''
    };
    const editDateVal = document.getElementById('editDate').value;
    if (editDateVal) fields.callTime = new Date(editDateVal).toISOString();

    if (!useSupabase()) {
        console.error('Supabase is not configured. Cannot update entry.');
        return;
    }
    const supabase = getSupabase();
    if (!supabase) {
        console.error('Supabase client not available.');
        return;
    }
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
        console.error('No active session. Please log in.');
        return;
    }
    if (!isPiiWriteAllowed()) {
        console.error('Refusing to update entry: encryption is not enabled.');
        showNotification('Cannot update call: encryption is not active.');
        return;
    }
    let nameCiphertext = null;
    let phoneCiphertext = null;
    let nameBlindIndex = null;
    let phoneBlindIndex = null;
    if (encryptionState.enabled) {
        nameCiphertext = await encryptValue('name', fields.name);
        phoneCiphertext = await encryptValue('phone', fields.phone);
        nameBlindIndex = await computeBlindIndex('name', fields.name);
        phoneBlindIndex = await computeBlindIndex('phone', fields.phone);
    }

    const { error } = await supabase
        .from('calls')
        .update({
            name: encryptionState.enabled ? '' : fields.name,
            phone: encryptionState.enabled ? '' : fields.phone,
            organization: fields.organization,
            device_name: fields.deviceName || '',
            support_request: fields.supportRequest,
            notes: fields.notes || '',
            name_ciphertext: encryptionState.enabled ? nameCiphertext : null,
            name_blind_index: encryptionState.enabled ? nameBlindIndex : null,
            phone_ciphertext: encryptionState.enabled ? phoneCiphertext : null,
            phone_blind_index: encryptionState.enabled ? phoneBlindIndex : null,
            key_version: encryptionState.enabled ? encryptionState.keyVersion : 1,
            call_time: fields.callTime || new Date().toISOString(),
            updated_at: new Date().toISOString()
        })
        .eq('id', id)
        .eq('user_id', session.user.id);
    if (error) {
        console.error('updateEntry Supabase error:', error);
    }
    closeEditModal();
    await loadEntries();
    await updateStats();
    flashEntryCard(id);
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
    if (!useSupabase()) {
        console.error('Supabase is not configured. Cannot delete entry.');
        return;
    }
    const supabase = getSupabase();
    if (!supabase) {
        console.error('Supabase client not available.');
        return;
    }
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
        console.error('No active session. Please log in.');
        return;
    }
    await supabase.from('calls').delete().eq('id', id).eq('user_id', session.user.id);
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
        if (!useSupabase()) {
            console.error('Supabase is not configured. Cannot delete entry.');
            return;
        }
        const supabase = getSupabase();
        if (!supabase) {
            console.error('Supabase client not available.');
            return;
        }
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) {
            console.error('No active session. Please log in.');
            return;
        }
        await supabase.from('calls').delete().eq('id', id).eq('user_id', session.user.id);
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

// ---------- Reports modal (Supabase) ----------
function openReportsModal() {
    const modal = document.getElementById('reportsModal');
    if (!modal) return;
    modal.classList.add('show');
    modal.setAttribute('aria-hidden', 'false');
    if (!useSupabase()) {
        const errEl = document.getElementById('reportsError');
        const grid = document.getElementById('reportsGrid');
        if (errEl) errEl.textContent = 'Reporting requires Supabase. Configure your project URL and anon key.';
        if (grid) grid.innerHTML = '';
        return;
    }
    updateReportsAdminUI();
    refreshReports().catch(() => {});
}

function closeReportsModal() {
    const modal = document.getElementById('reportsModal');
    if (!modal) return;
    modal.classList.remove('show');
    modal.setAttribute('aria-hidden', 'true');
    const errEl = document.getElementById('reportsError');
    if (errEl) errEl.textContent = '';
}

function updateReportsAdminUI() {
    const runBtn = document.getElementById('runReportsNowBtn');
    if (!runBtn) return;
    const isAdmin = !!currentUserProfile?.is_admin;
    runBtn.style.display = isAdmin ? '' : 'none';
    updateAccountAdminTabVisibility();
}

function formatPeriodLabel(periodStart, periodEnd) {
    if (!periodStart || !periodEnd) return '';
    return `${periodStart} to ${periodEnd}`;
}

/** Chart.js instances for report cards; destroyed on refresh */
let reportCharts = [];

/** Single Chart.js instance for statistics activity chart */
let statsPageChart = null

const STATS_DOW_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

function destroyStatsPageChart() {
    if (statsPageChart) {
        try { statsPageChart.destroy() } catch (_) {}
        statsPageChart = null
    }
}

function startOfLocalDay(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

function endOfLocalDay(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999)
}

function localDayIndexFromDate(date) {
    const day = date.getDay()
    return day === 0 ? 6 : day - 1
}

function addLocalDays(d, delta) {
    const x = new Date(d.getTime())
    x.setDate(x.getDate() + delta)
    return x
}

function parseDayKeyToLocalStart(dayKey) {
    const [y, m, da] = dayKey.split('-').map(Number)
    if (!y || !m || !da) return null
    return new Date(y, m - 1, da)
}

function enumerateLocalDayKeys(fromDayKey, toDayKey) {
    const start = parseDayKeyToLocalStart(fromDayKey)
    const end = parseDayKeyToLocalStart(toDayKey)
    if (!start || !end || start > end) return []
    const out = []
    let d = new Date(start.getFullYear(), start.getMonth(), start.getDate())
    const endT = new Date(end.getFullYear(), end.getMonth(), end.getDate()).getTime()
    while (d.getTime() <= endT) {
        out.push(toLocalDayKey(d))
        d = addLocalDays(d, 1)
    }
    return out
}

function calendarDaysInclusive(startDate, endDate) {
    const s = startOfLocalDay(startDate)
    const e = startOfLocalDay(endDate)
    const msPerDay = 86400000
    return Math.max(1, Math.round((e.getTime() - s.getTime()) / msPerDay) + 1)
}

/**
 * @param {{ startIso: string|null, endIso: string|null }} range
 * @returns {Promise<{ rows: Array<{ call_time: string, organization: string|null, device_name: string|null, support_request: string|null }>, error: Error|null }>}
 */
async function fetchMyCallsForStats(range) {
    if (!useSupabase()) {
        return { rows: [], error: new Error('Supabase is not configured.') }
    }
    const supabase = getSupabase()
    if (!supabase) {
        return { rows: [], error: new Error('Supabase client not available.') }
    }
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) {
        return { rows: [], error: new Error('Sign in to load statistics.') }
    }
    let q = supabase
        .from('calls')
        .select('call_time, organization, device_name, support_request')
        .order('call_time', { ascending: true })
    if (range.startIso) q = q.gte('call_time', range.startIso)
    if (range.endIso) q = q.lte('call_time', range.endIso)
    const { data, error } = await q
    if (error) {
        console.error('fetchMyCallsForStats error:', error)
        return { rows: [], error: new Error(error.message || 'Failed to load statistics.') }
    }
    return { rows: data || [], error: null }
}

/**
 * @param {Array<{ call_time: string, organization: string|null, device_name: string|null }>} rows
 * @param {{ fromDayKey: string, toDayKey: string, rangeDaysInclusive: number, showPace: boolean }} rangeMeta
 */
function computeStatsBundle(rows, rangeMeta) {
    const total = rows.length
    const orgCounts = new Map()
    const deviceSet = new Set()
    const perDay = new Map()
    const dowCounts = [0, 0, 0, 0, 0, 0, 0]

    let minTs = null
    let maxTs = null

    for (const r of rows) {
        const org = (r.organization || '').trim() || '(Unknown)'
        orgCounts.set(org, (orgCounts.get(org) || 0) + 1)
        const dev = (r.device_name || '').trim()
        if (dev) deviceSet.add(dev)

        const dt = new Date(r.call_time)
        if (Number.isNaN(dt.getTime())) continue
        if (minTs == null || dt < minTs) minTs = dt
        if (maxTs == null || dt > maxTs) maxTs = dt

        const dk = toLocalDayKey(dt)
        perDay.set(dk, (perDay.get(dk) || 0) + 1)
        dowCounts[localDayIndexFromDate(dt)] += 1
    }

    const dayKeys = enumerateLocalDayKeys(rangeMeta.fromDayKey, rangeMeta.toDayKey)
    const dailyTimeseries = dayKeys.map((day) => ({ day, calls: perDay.get(day) || 0 }))

    const maxDow = Math.max(1, ...dowCounts)
    const topOrgs = [...orgCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15)
        .map(([name, count], i) => ({
            rank: i + 1,
            name,
            count,
            pct: total > 0 ? Math.round((count / total) * 1000) / 10 : 0
        }))

    const avgPerDay = total > 0 ? Math.round((total / rangeMeta.rangeDaysInclusive) * 10) / 10 : 0

    let firstLabel = '—'
    let lastLabel = '—'
    if (minTs && maxTs) {
        firstLabel = toLocalDayKey(minTs)
        lastLabel = toLocalDayKey(maxTs)
    }

    let pace = null
    if (rangeMeta.showPace && maxTs) {
        const anchorEnd = startOfLocalDay(maxTs)
        const lastStart = addLocalDays(anchorEnd, -6)
        const prevEnd = addLocalDays(lastStart, -1)
        const prevStart = addLocalDays(prevEnd, -6)

        let last7 = 0
        let prev7 = 0
        for (const r of rows) {
            const dt = new Date(r.call_time)
            if (Number.isNaN(dt.getTime())) continue
            const t = dt.getTime()
            if (t >= lastStart.getTime() && t <= endOfLocalDay(anchorEnd).getTime()) last7 += 1
            if (t >= prevStart.getTime() && t <= endOfLocalDay(prevEnd).getTime()) prev7 += 1
        }
        let pct = null
        if (prev7 > 0) pct = Math.round(((last7 - prev7) / prev7) * 1000) / 10
        pace = { last7, prev7, pct }
    }

    return {
        total,
        uniqueOrgs: orgCounts.size,
        uniqueDevices: deviceSet.size,
        firstLabel,
        lastLabel,
        avgPerDay,
        dailyTimeseries,
        dowCounts,
        maxDow,
        topOrgs,
        pace
    }
}

function renderStatisticsKpis(bundle) {
    return `
        <div class="stats-kpi-card">
            <div class="stats-kpi-value">${bundle.total}</div>
            <div class="stats-kpi-label">Total Calls</div>
        </div>
        <div class="stats-kpi-card">
            <div class="stats-kpi-value">${bundle.uniqueOrgs}</div>
            <div class="stats-kpi-label">Organizations</div>
        </div>
        <div class="stats-kpi-card">
            <div class="stats-kpi-value">${bundle.uniqueDevices}</div>
            <div class="stats-kpi-label">Devices named</div>
        </div>
        <div class="stats-kpi-card">
            <div class="stats-kpi-value">${escapeHtml(bundle.firstLabel)} – ${escapeHtml(bundle.lastLabel)}</div>
            <div class="stats-kpi-label">First / last call</div>
        </div>
        <div class="stats-kpi-card">
            <div class="stats-kpi-value">${bundle.avgPerDay}</div>
            <div class="stats-kpi-label">Avg / day in range</div>
        </div>
    `
}

function renderStatisticsDow(bundle) {
    return STATS_DOW_LABELS.map((label, i) => {
        const n = bundle.dowCounts[i] || 0
        const w = bundle.maxDow > 0 ? Math.round((n / bundle.maxDow) * 100) : 0
        return `
            <div class="stats-dow-row">
                <span class="stats-dow-label">${label}</span>
                <div class="stats-dow-bar-track" role="presentation">
                    <div class="stats-dow-bar-fill" style="width: ${w}%"></div>
                </div>
                <span class="stats-dow-count">${n}</span>
            </div>
        `
    }).join('')
}

function renderStatisticsOrgsTable(bundle) {
    if (!bundle.topOrgs.length) {
        return '<tr><td colspan="4">No organizations in range</td></tr>'
    }
    return bundle.topOrgs.map((o) => `
        <tr>
            <td>${o.rank}</td>
            <td>${escapeHtml(o.name)}</td>
            <td>${o.count}</td>
            <td>${o.pct}%</td>
        </tr>
    `).join('')
}

function attachStatsActivityChart(timeseries) {
    destroyStatsPageChart()
    const wrap = document.querySelector('[data-stats-chart]')
    const canvas = document.getElementById('statsActivityCanvas')
    if (!wrap || !canvas || typeof Chart === 'undefined') return
    if (!Array.isArray(timeseries) || timeseries.length === 0) return
    const config = makeReportChartConfig(timeseries)
    statsPageChart = new Chart(canvas, config)
}

function getStatisticsRangeFromUI() {
    const presetEl = document.getElementById('statsRangePreset')
    const preset = presetEl ? presetEl.value : '30'
    const today = new Date()
    const todayStart = startOfLocalDay(today)

    if (preset === 'all') {
        return {
            preset,
            startIso: null,
            endIso: null,
            fromDayKey: null,
            toDayKey: null,
            rangeDaysInclusive: 1,
            showPace: true
        }
    }

    if (preset === 'custom') {
        const startInp = document.getElementById('statsRangeStart')
        const endInp = document.getElementById('statsRangeEnd')
        const sk = (startInp && startInp.value) ? startInp.value : toLocalDayKey(today)
        const ek = (endInp && endInp.value) ? endInp.value : toLocalDayKey(today)
        const sDate = parseDayKeyToLocalStart(sk)
        const eDate = parseDayKeyToLocalStart(ek)
        if (!sDate || !eDate || sDate > eDate) {
            return {
                preset,
                startIso: null,
                endIso: null,
                fromDayKey: toLocalDayKey(today),
                toDayKey: toLocalDayKey(today),
                rangeDaysInclusive: 1,
                showPace: false,
                invalid: true
            }
        }
        const startIso = startOfLocalDay(sDate).toISOString()
        const endIso = endOfLocalDay(eDate).toISOString()
        const rangeDaysInclusive = calendarDaysInclusive(sDate, eDate)
        return {
            preset,
            startIso,
            endIso,
            fromDayKey: sk,
            toDayKey: ek,
            rangeDaysInclusive,
            showPace: rangeDaysInclusive >= 14
        }
    }

    const days = preset === '7' ? 7 : preset === '90' ? 90 : 30
    const startDate = addLocalDays(todayStart, -(days - 1))
    const fromDayKey = toLocalDayKey(startDate)
    const toDayKey = toLocalDayKey(today)
    return {
        preset,
        startIso: startOfLocalDay(startDate).toISOString(),
        endIso: endOfLocalDay(today).toISOString(),
        fromDayKey,
        toDayKey,
        rangeDaysInclusive: days,
        showPace: days >= 14
    }
}

async function loadStatisticsPage() {
    const errEl = document.getElementById('statsPageError')
    const loadingEl = document.getElementById('statsLoading')
    const mainEl = document.getElementById('statsMainContent')
    const emptyEl = document.getElementById('statsEmptyState')
    if (errEl) errEl.textContent = ''

    const rangeSpec = getStatisticsRangeFromUI()
    if (rangeSpec.invalid) {
        if (errEl) errEl.textContent = 'Choose a valid custom range (from on or before to).'
        if (loadingEl) loadingEl.classList.add('hidden')
        if (mainEl) mainEl.classList.add('hidden')
        if (emptyEl) emptyEl.classList.add('hidden')
        return
    }

    if (loadingEl) loadingEl.classList.remove('hidden')
    if (mainEl) mainEl.classList.add('hidden')
    if (emptyEl) emptyEl.classList.add('hidden')

    const fetchRange = rangeSpec.preset === 'all'
        ? { startIso: null, endIso: null }
        : { startIso: rangeSpec.startIso, endIso: rangeSpec.endIso }

    const { rows, error } = await fetchMyCallsForStats(fetchRange)
    if (loadingEl) loadingEl.classList.add('hidden')

    if (error) {
        if (errEl) errEl.textContent = error.message || 'Failed to load statistics.'
        destroyStatsPageChart()
        if (mainEl) mainEl.classList.add('hidden')
        if (emptyEl) emptyEl.classList.add('hidden')
        return
    }

    let fromDayKey = rangeSpec.fromDayKey
    let toDayKey = rangeSpec.toDayKey
    let rangeDaysInclusive = rangeSpec.rangeDaysInclusive
    let showPace = rangeSpec.showPace

    if (rangeSpec.preset === 'all') {
        if (rows.length === 0) {
            fromDayKey = toLocalDayKey(new Date())
            toDayKey = fromDayKey
            rangeDaysInclusive = 1
            showPace = false
        } else {
            let minD = null
            let maxD = null
            for (const r of rows) {
                const dt = new Date(r.call_time)
                if (Number.isNaN(dt.getTime())) continue
                if (!minD || dt < minD) minD = dt
                if (!maxD || dt > maxD) maxD = dt
            }
            fromDayKey = minD ? toLocalDayKey(minD) : toLocalDayKey(new Date())
            toDayKey = maxD ? toLocalDayKey(maxD) : fromDayKey
            rangeDaysInclusive = calendarDaysInclusive(parseDayKeyToLocalStart(fromDayKey), parseDayKeyToLocalStart(toDayKey))
            showPace = rangeDaysInclusive >= 14
        }
    }

    const rangeMeta = { fromDayKey, toDayKey, rangeDaysInclusive, showPace }
    const bundle = computeStatsBundle(rows, rangeMeta)

    if (bundle.total === 0) {
        if (emptyEl) {
            emptyEl.classList.remove('hidden')
            const p = emptyEl.querySelector('.stats-empty-text')
            if (p) p.textContent = 'No data available'
        }
        destroyStatsPageChart()
        return
    }

    if (emptyEl) emptyEl.classList.add('hidden')
    if (mainEl) mainEl.classList.remove('hidden')

    const kpi = document.getElementById('statsKpiRow')
    if (kpi) kpi.innerHTML = renderStatisticsKpis(bundle)

    const paceEl = document.getElementById('statsPace')
    if (paceEl) {
        if (bundle.pace && rangeMeta.showPace) {
            paceEl.classList.remove('hidden')
            const { last7, prev7, pct } = bundle.pace
            let line = `<strong>Last 7 days:</strong> ${last7} calls · <strong>Previous 7:</strong> ${prev7} calls`
            if (pct != null) {
                const dir = pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat'
                const sign = pct > 0 ? '+' : ''
                line += ` <span class="stats-pace-muted">(${sign}${pct}% vs prior week, ${dir})</span>`
            }
            paceEl.innerHTML = line
        } else {
            paceEl.classList.add('hidden')
            paceEl.innerHTML = ''
        }
    }

    const dowEl = document.getElementById('statsDowBars')
    if (dowEl) dowEl.innerHTML = renderStatisticsDow(bundle)

    const orgBody = document.getElementById('statsOrgTableBody')
    if (orgBody) orgBody.innerHTML = renderStatisticsOrgsTable(bundle)

    attachStatsActivityChart(bundle.dailyTimeseries)
}

function openStatisticsPage() {
    setAppView('statistics')
    const errEl = document.getElementById('statsPageError')
    if (errEl) errEl.textContent = ''
    loadStatisticsPage().catch((e) => {
        console.error('loadStatisticsPage error:', e)
        if (errEl) errEl.textContent = e?.message || 'Failed to load statistics.'
    })
}

function refreshStatisticsPageIfVisible() {
    if (currentAppView !== 'statistics') return
    loadStatisticsPage().catch((e) => console.warn('refreshStatisticsPageIfVisible:', e))
}

function setupStatisticsPageListeners() {
    const preset = document.getElementById('statsRangePreset')
    const customWrap = document.getElementById('statsCustomRange')
    const applyCustom = document.getElementById('statsApplyCustomBtn')
    const refreshBtn = document.getElementById('statsRefreshBtn')
    const backInline = document.getElementById('statsBackInlineBtn')
    const openReports = document.getElementById('statsOpenReportsBtn')

    const syncCustomVisibility = () => {
        if (!preset || !customWrap) return
        const isCustom = preset.value === 'custom'
        customWrap.classList.toggle('hidden', !isCustom)
        if (isCustom) {
            const startInp = document.getElementById('statsRangeStart')
            const endInp = document.getElementById('statsRangeEnd')
            const t = new Date()
            if (startInp && !startInp.value) startInp.value = toLocalDayKey(addLocalDays(startOfLocalDay(t), -29))
            if (endInp && !endInp.value) endInp.value = toLocalDayKey(t)
        }
    }

    preset?.addEventListener('change', () => {
        syncCustomVisibility()
        if (preset.value !== 'custom') {
            loadStatisticsPage().catch((e) => console.error(e))
        }
    })

    applyCustom?.addEventListener('click', () => {
        loadStatisticsPage().catch((e) => console.error(e))
    })

    refreshBtn?.addEventListener('click', () => {
        loadStatisticsPage().catch((e) => console.error(e))
    })

    backInline?.addEventListener('click', () => setAppView('calls'))

    openReports?.addEventListener('click', () => {
        openReportsModal()
    })

    syncCustomVisibility()
}

function getReportChartCssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '';
}

function getReportChartPrimaryColor() {
    return getReportChartCssVar('--primary') || '#86a3ff';
}

function formatReportChartDay(dayStr) {
    if (!dayStr || typeof dayStr !== 'string') return '';
    return dayStr.slice(5);
}

function makeReportChartConfig(timeseries) {
    const labels = timeseries.map(p => formatReportChartDay(p.day || p.date));
    const data = timeseries.map(p => Number(p.calls ?? p.count ?? 0));
    const color = getReportChartPrimaryColor();
    const textSecondary = getReportChartCssVar('--text-secondary') || 'rgba(255,255,255,0.68)';
    const borderColor = getReportChartCssVar('--border') || 'rgba(255,255,255,0.1)';
    return {
        type: 'bar',
        data: {
            labels,
            datasets: [{
                label: 'Calls',
                data,
                backgroundColor: color,
                borderColor: color,
                borderWidth: 1,
                borderRadius: 4
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 300 },
            plugins: {
                legend: { display: false },
                tooltip: { enabled: true }
            },
            scales: {
                x: {
                    grid: { display: false },
                    ticks: {
                        maxRotation: 0,
                        font: { size: 10 },
                        color: textSecondary
                    }
                },
                y: {
                    beginAtZero: true,
                    grid: { color: borderColor },
                    ticks: {
                        font: { size: 10 },
                        color: textSecondary,
                        stepSize: 1
                    }
                }
            }
        }
    };
}

function renderReportCard({ title, subtitle, callsTotal, orgsUnique, timeseries }, chartIndex) {
    const chartPlaceholder = `<div class="report-chart" data-chart-id="${chartIndex}" role="img" aria-label="Bar chart"></div>`;
    return `
        <div class="report-card" data-testid="report-card">
            <div class="report-card-header">
                <div class="report-card-title">${escapeHtml(title)}</div>
                <div class="report-card-subtitle">${escapeHtml(subtitle || '')}</div>
            </div>
            <div class="report-metrics">
                <div class="report-metric">
                    <div class="report-metric-value">${Number(callsTotal || 0)}</div>
                    <div class="report-metric-label">Calls</div>
                </div>
                <div class="report-metric">
                    <div class="report-metric-value">${Number(orgsUnique || 0)}</div>
                    <div class="report-metric-label">Organizations</div>
                </div>
            </div>
            ${chartPlaceholder}
        </div>
    `;
}

function attachReportCharts(grid, timeseriesList) {
    if (typeof Chart === 'undefined') return;
    reportCharts.forEach(c => { try { c.destroy(); } catch (_) {} });
    reportCharts = [];
    timeseriesList.forEach((timeseries, i) => {
        const container = grid.querySelector(`[data-chart-id="${i}"]`);
        if (!container || !Array.isArray(timeseries) || timeseries.length === 0) return;
        const canvas = document.createElement('canvas');
        container.appendChild(canvas);
        const config = makeReportChartConfig(timeseries);
        const chart = new Chart(canvas, config);
        reportCharts.push(chart);
    });
}

async function fetchLatestReport({ scope, periodType, userId }) {
    const supabase = getSupabase();
    if (!supabase) return null;
    let q = supabase
        .from('call_reports')
        .select('period_type, period_start, period_end, scope, user_id, metrics, generated_at')
        .eq('scope', scope)
        .eq('period_type', periodType)
        .order('period_start', { ascending: false })
        .limit(1);
    if (scope === 'user') q = q.eq('user_id', userId);
    if (scope === 'team') q = q.is('user_id', null);
    const { data, error } = await q;
    if (error) throw error;
    return (data && data[0]) ? data[0] : null;
}

async function refreshReports() {
    const grid = document.getElementById('reportsGrid');
    const errEl = document.getElementById('reportsError');
    if (!grid) return;
    if (errEl) errEl.textContent = '';

    const supabase = getSupabase();
    if (!supabase) {
        if (errEl) errEl.textContent = 'Unable to load reports. Check Supabase configuration.';
        grid.innerHTML = '';
        return;
    }

    const loadingCardsHtml = `
        <div class="report-card" data-testid="report-card"><div class="report-card-title">Loading…</div></div>
        <div class="report-card" data-testid="report-card"><div class="report-card-title">Loading…</div></div>
        <div class="report-card" data-testid="report-card"><div class="report-card-title">Loading…</div></div>
        <div class="report-card" data-testid="report-card"><div class="report-card-title">Loading…</div></div>
    `;
    grid.innerHTML = loadingCardsHtml;

    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
        if (errEl) errEl.textContent = 'Sign in to load reports.';
        grid.innerHTML = '';
        return;
    }

    try {
        const [tw, tm, uw, um] = await Promise.all([
            fetchLatestReport({ scope: 'team', periodType: 'weekly', userId: null }),
            fetchLatestReport({ scope: 'team', periodType: 'monthly', userId: null }),
            fetchLatestReport({ scope: 'user', periodType: 'weekly', userId: session.user.id }),
            fetchLatestReport({ scope: 'user', periodType: 'monthly', userId: session.user.id })
        ]);

        const timeseriesList = [
            tw?.metrics?.daily_timeseries || [],
            tm?.metrics?.daily_timeseries || [],
            uw?.metrics?.daily_timeseries || [],
            um?.metrics?.daily_timeseries || []
        ];
        const cards = [];
        cards.push(renderReportCard({
            title: 'Team (weekly)',
            subtitle: tw ? formatPeriodLabel(tw.period_start, tw.period_end) : 'No report yet',
            callsTotal: tw?.metrics?.calls_total,
            orgsUnique: tw?.metrics?.orgs_unique,
            timeseries: timeseriesList[0]
        }, 0));
        cards.push(renderReportCard({
            title: 'Team (monthly)',
            subtitle: tm ? formatPeriodLabel(tm.period_start, tm.period_end) : 'No report yet',
            callsTotal: tm?.metrics?.calls_total,
            orgsUnique: tm?.metrics?.orgs_unique,
            timeseries: timeseriesList[1]
        }, 1));
        cards.push(renderReportCard({
            title: 'You (weekly)',
            subtitle: uw ? formatPeriodLabel(uw.period_start, uw.period_end) : 'No report yet',
            callsTotal: uw?.metrics?.calls_total,
            orgsUnique: uw?.metrics?.orgs_unique,
            timeseries: timeseriesList[2]
        }, 2));
        cards.push(renderReportCard({
            title: 'You (monthly)',
            subtitle: um ? formatPeriodLabel(um.period_start, um.period_end) : 'No report yet',
            callsTotal: um?.metrics?.calls_total,
            orgsUnique: um?.metrics?.orgs_unique,
            timeseries: timeseriesList[3]
        }, 3));

        grid.innerHTML = cards.join('');
        attachReportCharts(grid, timeseriesList);
    } catch (e) {
        console.error('refreshReports error:', e);
        if (errEl) errEl.textContent = e?.message || 'Failed to load reports.';
        grid.innerHTML = '';
    }
}

async function getSupabaseAccessToken() {
    const supabase = getSupabase();
    if (!supabase) return null;
    const { data: { session } } = await supabase.auth.getSession();
    if (session?.access_token && String(session.access_token).split('.').length === 3) return session.access_token;
    const { data: refreshed, error: refreshErr } = await supabase.auth.refreshSession();
    if (refreshErr) throw refreshErr;
    const tok = refreshed?.session?.access_token;
    if (tok && String(tok).split('.').length === 3) return tok;
    return null;
}

async function runReportsNow() {
    if (!useSupabase()) return;
    if (!currentUserProfile?.is_admin) return;
    const supabase = getSupabase();
    if (!supabase) return;

    const errEl = document.getElementById('reportsError');
    const btn = document.getElementById('runReportsNowBtn');
    if (errEl) errEl.textContent = '';
    const originalText = btn?.textContent;
    if (btn) {
        btn.disabled = true;
        btn.textContent = 'Running…';
    }
    try {
        const accessToken = await getSupabaseAccessToken();
        if (!accessToken) throw new Error('Session expired. Please log in again.');

        const url = (window.supabaseConfig?.SUPABASE_URL || '').trim();
        const anonKey = (window.supabaseConfig?.SUPABASE_ANON_KEY || '').trim();
        if (!url || !anonKey) throw new Error('Supabase is not configured.');

        const res = await fetch(`${url.replace(/\/+$/, '')}/functions/v1/generate-reports-admin-open`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${accessToken}`,
                apikey: anonKey,
                'Content-Type': 'application/json'
            }
        });

        const responseText = await res.text().catch(() => '');
        const payload = (() => {
            try { return responseText ? JSON.parse(responseText) : null; } catch { return null; }
        })();
        if (!res.ok) {
            const raw = payload?.error ?? payload?.message ?? payload ?? responseText;
            const detail = (raw == null)
                ? ''
                : (typeof raw === 'string'
                    ? raw
                    : (() => {
                        try { return JSON.stringify(raw); } catch { return ''; }
                    })());
            const msg = detail || responseText || `Edge Function returned a non-2xx status code (HTTP ${res.status})`;
            throw new Error(`${msg} (HTTP ${res.status})`);
        }
        if (payload && payload.ok === false) {
            const raw = payload?.error ?? payload?.message ?? payload;
            const detail = (raw == null)
                ? 'Report generation failed.'
                : (typeof raw === 'string'
                    ? raw
                    : (() => { try { return JSON.stringify(raw); } catch { return String(raw); } })());
            throw new Error(detail);
        }

        showNotification('Reports generated.');
        await refreshReports();
    } catch (e) {
        console.error('runReportsNow error:', e);
        const msg = (e && typeof e === 'object' && 'message' in e && typeof e.message === 'string' && e.message)
            ? e.message
            : (() => { try { return JSON.stringify(e); } catch { return String(e); } })();
        if (errEl) errEl.textContent = msg || 'Failed to run reports.';
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = originalText || 'Run reports now';
        }
    }
}

// ---------- Account page: bundled release notes (changelog-bundled.json) ----------
async function loadAccountChangelog() {
    const card = document.getElementById('accountChangelogCard')
    if (!card) return

    if (accountChangelogLoadPromise) {
        await accountChangelogLoadPromise.catch(() => {})
        return
    }

    accountChangelogLoadPromise = (async () => {
        const mount = document.getElementById('accountChangelogBody')
        const hint = document.getElementById('accountChangelogHint')
        if (!mount || !hint) return
        try {
            const res = await fetch('changelog-bundled.json', { cache: 'no-store' })
            if (!res.ok) {
                card.classList.add('hidden')
                return
            }
            const data = await res.json()
            const releases = Array.isArray(data?.releases) ? data.releases : []
            renderAccountChangelogIntoPanel(releases)
        } catch (err) {
            console.error('loadAccountChangelog:', err)
            card.classList.add('hidden')
        }
    })()

    await accountChangelogLoadPromise
}

function renderAccountChangelogIntoPanel(releases) {
    const card = document.getElementById('accountChangelogCard')
    const mount = document.getElementById('accountChangelogBody')
    const hint = document.getElementById('accountChangelogHint')
    if (!card || !mount || !hint) return

    if (!releases.length) {
        hint.textContent =
            'Notes for each release are added automatically on publish. This build has no bundled entries yet—see CHANGELOG.md in the repository if you need history.'
        mount.innerHTML = ''
        card.classList.remove('hidden')
        return
    }

    hint.textContent = 'What shipped in recent versions—aligned with the GitHub release pipeline.'

    const maxReleases = 8
    const slice = releases.slice(0, maxReleases)
    const parts = []
    for (const rel of slice) {
        const ver = String(rel?.version || '').trim() || '0.0.0'
        const date = String(rel?.date || '').trim()
        parts.push(`<article class="account-changelog-release" aria-label="Version ${escapeHtml(ver)}">`)
        parts.push('<h4 class="account-changelog-version">')
        parts.push(`v${escapeHtml(ver)}`)
        if (date) {
            parts.push(` <span class="account-changelog-date">${escapeHtml(date)}</span>`)
        }
        parts.push('</h4>')
        const sec = rel?.sections && typeof rel.sections === 'object' ? rel.sections : {}
        const order = ['Added', 'Fixed', 'Changed', 'Maintenance', 'Other']
        let anySection = false
        for (const title of order) {
            const items = sec[title]
            if (!Array.isArray(items) || !items.length) continue
            anySection = true
            parts.push(`<p class="account-changelog-section-title">${escapeHtml(title)}</p>`)
            parts.push('<ul class="account-changelog-list">')
            for (const t of items) {
                const line = String(t || '').trim()
                if (!line) continue
                parts.push(`<li>${escapeHtml(line)}</li>`)
            }
            parts.push('</ul>')
        }
        if (!anySection) {
            parts.push('<p class="profile-hint">See commit history for details.</p>')
        }
        parts.push('</article>')
    }
    mount.innerHTML = parts.join('')
    card.classList.remove('hidden')
}

// ---------- Account page: in-app updater (Electron, Windows NSIS) ----------
function formatUpdaterBytes(n) {
    if (n == null || typeof n !== 'number' || n < 0) return ''
    if (n < 1024) return `${n} B`
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
    return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function maybeToastAccountUpdater(state) {
    if (!state || !state.supported) return
    if (state.phase === 'available' && state.availableVersion) {
        const v = String(state.availableVersion)
        if (accountUpdaterToastVersion !== v) {
            accountUpdaterToastVersion = v
            showNotification(`Update available: v${v}. Open Settings, Updates tab, to download when you are ready.`)
        }
    }
    if (state.phase === 'downloaded' && state.downloadedVersion) {
        const v = String(state.downloadedVersion)
        if (accountUpdaterToastDownloadedVersion !== v) {
            accountUpdaterToastDownloadedVersion = v
            showNotification(`Update v${v} is ready. Open Settings, Updates tab, to install and restart.`)
        }
    }
}

function renderAccountUpdater(state) {
    if (!state || typeof state !== 'object') return
    const card = document.getElementById('accountUpdateCard')
    const hint = document.getElementById('accountUpdateHint')
    const statusEl = document.getElementById('accountUpdateStatus')
    const errEl = document.getElementById('accountUpdateError')
    const progressWrap = document.getElementById('accountUpdateProgressWrap')
    const progressFill = document.getElementById('accountUpdateProgressFill')
    const progressBar = document.getElementById('accountUpdateProgressBar')
    const progressLabel = document.getElementById('accountUpdateProgressLabel')
    const checkBtn = document.getElementById('accountUpdateCheckBtn')
    const dlBtn = document.getElementById('accountUpdateDownloadBtn')
    const installBtn = document.getElementById('accountUpdateInstallBtn')
    if (!card) return

    if (!window.electronAPI?.updater) {
        card.classList.add('hidden')
        return
    }
    card.classList.remove('hidden')

    const cv = state.currentVersion ? `v${state.currentVersion}` : 'this version'

    if (!state.supported) {
        if (hint) {
            hint.textContent =
                'In-app updates apply only when Call Log is installed with the Windows setup program (not the portable .exe).'
        }
        if (statusEl) statusEl.textContent = `You are running ${cv}.`
        if (errEl) errEl.textContent = ''
        if (progressWrap) progressWrap.classList.add('hidden')
        if (checkBtn) checkBtn.style.display = 'none'
        if (dlBtn) dlBtn.style.display = 'none'
        if (installBtn) installBtn.style.display = 'none'
        return
    }

    if (hint) {
        hint.textContent =
            'Check for new releases, download in the background, then install and restart when you are ready.'
    }

    const phase = state.phase || 'idle'
    if (phase !== 'error' && errEl) errEl.textContent = ''
    if (phase === 'error' && errEl && state.errorMessage) {
        errEl.textContent = String(state.errorMessage)
    }

    let statusText = ''
    if (phase === 'idle') {
        statusText = `You are on ${cv}.`
    } else if (phase === 'checking') {
        statusText = 'Checking for updates…'
    } else if (phase === 'available' && state.availableVersion) {
        statusText = `Version v${state.availableVersion} is available (you are on ${cv}).`
    } else if (phase === 'downloading') {
        statusText = 'Downloading update…'
    } else if (phase === 'downloaded' && state.downloadedVersion) {
        statusText = `Version v${state.downloadedVersion} is downloaded and ready to install.`
    } else if (phase === 'error') {
        statusText = 'Something went wrong with the updater.'
    } else {
        statusText = `You are on ${cv}.`
    }
    if (statusEl) statusEl.textContent = statusText

    const showProgress = phase === 'downloading' && state.progress
    if (progressWrap) {
        if (showProgress) {
            progressWrap.classList.remove('hidden')
            const pct = state.progress.percent != null ? state.progress.percent : 0
            if (progressFill) progressFill.style.width = `${Math.min(100, Math.max(0, pct))}%`
            if (progressBar) {
                progressBar.setAttribute('aria-valuenow', String(Math.round(pct)))
            }
            if (progressLabel) {
                const t = state.progress.total
                const x = state.progress.transferred
                let extra = ''
                if (typeof t === 'number' && t > 0 && typeof x === 'number') {
                    extra = ` (${formatUpdaterBytes(x)} / ${formatUpdaterBytes(t)})`
                }
                progressLabel.textContent = `${Math.round(pct)}%${extra}`
            }
        } else {
            progressWrap.classList.add('hidden')
        }
    }

    const busy = phase === 'checking' || phase === 'downloading'
    if (checkBtn) {
        checkBtn.style.display = ''
        checkBtn.disabled = busy || phase === 'downloaded'
    }
    if (dlBtn) {
        const showDl = phase === 'available'
        dlBtn.style.display = showDl ? '' : 'none'
        dlBtn.disabled = busy
    }
    if (installBtn) {
        const showIn = phase === 'downloaded'
        installBtn.style.display = showIn ? '' : 'none'
        installBtn.disabled = false
    }

    maybeToastAccountUpdater(state)
}

const handleAccountUpdaterCheck = async () => {
    const api = window.electronAPI?.updater
    if (!api) return
    const errEl = document.getElementById('accountUpdateError')
    if (errEl) errEl.textContent = ''
    try {
        await api.checkForUpdates()
    } catch (err) {
        console.error('checkForUpdates:', err)
        if (errEl) errEl.textContent = err?.message || 'Update check failed.'
    }
}

const handleAccountUpdaterDownload = async () => {
    const api = window.electronAPI?.updater
    if (!api) return
    const errEl = document.getElementById('accountUpdateError')
    if (errEl) errEl.textContent = ''
    try {
        const res = await api.downloadUpdate()
        if (!res?.ok && errEl) {
            errEl.textContent = res?.message || 'Download failed.'
        }
    } catch (err) {
        console.error('downloadUpdate:', err)
        if (errEl) errEl.textContent = err?.message || 'Download failed.'
    }
}

const handleAccountUpdaterInstall = async () => {
    const api = window.electronAPI?.updater
    if (!api) return
    try {
        await api.quitAndInstall()
    } catch (err) {
        console.error('quitAndInstall:', err)
    }
}

function setupAccountUpdaterPanel() {
    const card = document.getElementById('accountUpdateCard')
    const api = window.electronAPI?.updater
    if (!card) return
    if (!api) {
        card.classList.add('hidden')
        return
    }
    card.classList.remove('hidden')

    if (!accountUpdaterListenersBound) {
        accountUpdaterListenersBound = true
        document.getElementById('accountUpdateCheckBtn')?.addEventListener('click', handleAccountUpdaterCheck)
        document.getElementById('accountUpdateDownloadBtn')?.addEventListener('click', handleAccountUpdaterDownload)
        document.getElementById('accountUpdateInstallBtn')?.addEventListener('click', handleAccountUpdaterInstall)
    }

    if (accountUpdaterUnsubscribe) {
        accountUpdaterUnsubscribe()
        accountUpdaterUnsubscribe = null
    }
    accountUpdaterUnsubscribe = api.onEvent((payload) => {
        if (payload?.type === 'state') {
            renderAccountUpdater(payload)
        }
    })

    api.getState().then(renderAccountUpdater).catch(() => {})
}

// ---------- Account page (Supabase) ----------
function updateAccountAdminTabVisibility() {
    const tab = document.getElementById('accountTabAdmin');
    const teamStatsBtn = document.getElementById('adminStatsBtn');
    const isAdmin = !!currentUserProfile?.is_admin;
    const showTeamStats = isAdmin && useSupabase() && getSupabase();
    if (teamStatsBtn) {
        teamStatsBtn.classList.toggle('hidden', !showTeamStats);
    }
    if (!tab) return;
    if (isAdmin) {
        tab.classList.remove('hidden');
    } else {
        tab.classList.add('hidden');
        if (tab.getAttribute('aria-selected') === 'true') {
            selectAccountTab('profile');
        }
    }
}

function selectAccountTab(tabId) {
    const rows = [
        { id: 'profile', tabEl: 'accountTabProfile', panelEl: 'accountPanelProfile' },
        { id: 'updates', tabEl: 'accountTabUpdates', panelEl: 'accountPanelUpdates' },
        { id: 'security', tabEl: 'accountTabSecurity', panelEl: 'accountPanelSecurity' },
        { id: 'admin', tabEl: 'accountTabAdmin', panelEl: 'accountPanelAdmin' },
    ];
    for (const row of rows) {
        const active = row.id === tabId;
        const te = document.getElementById(row.tabEl);
        const pe = document.getElementById(row.panelEl);
        if (te?.classList.contains('hidden')) {
            if (pe) {
                pe.classList.add('hidden');
                pe.setAttribute('hidden', '');
            }
            continue;
        }
        if (te) {
            te.setAttribute('aria-selected', active ? 'true' : 'false');
            te.tabIndex = active ? 0 : -1;
        }
        if (pe) {
            if (active) {
                pe.classList.remove('hidden');
                pe.removeAttribute('hidden');
            } else {
                pe.classList.add('hidden');
                pe.setAttribute('hidden', '');
            }
        }
    }
    if (tabId === 'updates') {
        window.electronAPI?.updater?.getState().then(renderAccountUpdater).catch(() => {})
        loadAccountChangelog().catch(() => {})
    }
    if (tabId === 'admin' && currentUserProfile?.is_admin) {
        if (!accountAdminLoadedOnce) {
            accountAdminLoadedOnce = true;
            fetchAdminDirectory(true).catch((err) => console.error('fetchAdminDirectory', err));
        }
    }
}

async function updateProfileEmailPendingHint() {
    const hint = document.getElementById('profileEmailPendingHint');
    if (!hint) return;
    const supabase = getSupabase();
    if (!supabase) {
        hint.textContent = '';
        hint.classList.add('hidden');
        return;
    }
    const { data: { user }, error } = await supabase.auth.getUser();
    if (error || !user) {
        hint.textContent = '';
        hint.classList.add('hidden');
        return;
    }
    const pending = user.new_email;
    if (pending) {
        hint.textContent = `Confirm ${pending} using the link emailed to that address. You can still sign in with your current email until you confirm.`;
        hint.classList.remove('hidden');
    } else {
        hint.textContent = '';
        hint.classList.add('hidden');
    }
}

function hydrateAccountProfileForm() {
    if (!useSupabase() || !currentUserProfile) return;
    const supabase = getSupabase();
    if (!supabase) return;
    const errEl = document.getElementById('profileError');
    const nameEl = document.getElementById('profileName');
    const emailEl = document.getElementById('profileEmail');
    if (!nameEl || !emailEl) return;
    if (errEl) errEl.textContent = '';
    nameEl.value = currentUserProfile.full_name || '';
    supabase.auth.getSession().then(({ data: { session } }) => {
        emailEl.value = session?.user?.email || '';
        updateProfileEmailPendingHint().catch(() => {});
    });
}

function openAccountPage() {
    if (!useSupabase() || !currentUserProfile) return;
    hydrateAccountProfileForm();
    document.getElementById('securityPasswordError').textContent = '';
    document.getElementById('securitySignOutEverywhereError').textContent = '';
    document.getElementById('adminInviteError').textContent = '';
    document.getElementById('adminUsersError').textContent = '';
    const feedbackErr = document.getElementById('feedbackError');
    if (feedbackErr) feedbackErr.textContent = '';
    const np = document.getElementById('securityNewPassword');
    const cp = document.getElementById('securityConfirmPassword');
    if (np) np.value = '';
    if (cp) cp.value = '';
    updateAccountAdminTabVisibility();
    selectAccountTab('profile');
    setAppView('account');
    window.electronAPI?.updater?.getState().then(renderAccountUpdater).catch(() => {});
    setTimeout(() => document.getElementById('profileName')?.focus(), 0);
}

async function invokeAccountAdmin(body) {
    if (!useSupabase()) throw new Error('Supabase is not configured.');
    const accessToken = await getSupabaseAccessToken();
    if (!accessToken) throw new Error('Session expired. Please log in again.');
    const url = (window.supabaseConfig?.SUPABASE_URL || '').trim();
    const anonKey = (window.supabaseConfig?.SUPABASE_ANON_KEY || '').trim();
    if (!url || !anonKey) throw new Error('Supabase is not configured.');
    const res = await fetch(`${url.replace(/\/+$/, '')}/functions/v1/${ACCOUNT_ADMIN_FUNCTION_SLUG}`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${accessToken}`,
            apikey: anonKey,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
    });
    const responseText = await res.text().catch(() => '');
    const payload = (() => {
        try {
            return responseText ? JSON.parse(responseText) : null;
        } catch {
            return null;
        }
    })();
    if (!res.ok) {
        const raw = payload?.error ?? payload?.detail ?? payload?.message ?? responseText;
        const detail = raw == null ? '' : typeof raw === 'string' ? raw : JSON.stringify(raw);
        const haystack = `${detail} ${responseText}`.toLowerCase();
        const missingFn =
            res.status === 404 ||
            haystack.includes('requested function was not found') ||
            haystack.includes('function not found');
        if (missingFn) {
            throw new Error(
                `The account-admin API is not deployed to this Supabase project. From a machine with the Supabase CLI, run: supabase functions deploy ${ACCOUNT_ADMIN_FUNCTION_SLUG} --no-verify-jwt`,
            );
        }
        const invalidGatewayJwt = res.status === 401 && haystack.includes('invalid jwt');
        if (invalidGatewayJwt) {
            throw new Error(
                `The account-admin function is rejecting the token at the Supabase gateway. Redeploy with gateway JWT verification off (the function still checks your session and is_admin): supabase functions deploy ${ACCOUNT_ADMIN_FUNCTION_SLUG} --no-verify-jwt`,
            );
        }
        throw new Error(detail || `HTTP ${res.status}`);
    }
    if (payload && payload.ok === false) {
        throw new Error(payload.error || payload.detail || 'Request failed');
    }
    return payload;
}

async function invokeAdminAnalytics(body) {
    if (!useSupabase()) throw new Error('Supabase is not configured.');
    const accessToken = await getSupabaseAccessToken();
    if (!accessToken) throw new Error('Session expired. Please log in again.');
    const url = (window.supabaseConfig?.SUPABASE_URL || '').trim();
    const anonKey = (window.supabaseConfig?.SUPABASE_ANON_KEY || '').trim();
    if (!url || !anonKey) throw new Error('Supabase is not configured.');
    const res = await fetch(`${url.replace(/\/+$/, '')}/functions/v1/${ADMIN_ANALYTICS_FUNCTION_SLUG}`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${accessToken}`,
            apikey: anonKey,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
    });
    const responseText = await res.text().catch(() => '');
    const payload = (() => {
        try {
            return responseText ? JSON.parse(responseText) : null;
        } catch {
            return null;
        }
    })();
    if (!res.ok) {
        const raw =
            payload?.error ?? payload?.detail ?? payload?.message ?? payload?.msg ?? responseText;
        const detail = raw == null ? '' : typeof raw === 'string' ? raw : JSON.stringify(raw);
        const haystack = `${detail} ${responseText}`.toLowerCase();
        const missingFn =
            res.status === 404 ||
            haystack.includes('requested function was not found') ||
            haystack.includes('function not found');
        if (missingFn) {
            throw new Error(
                'The admin-analytics API is not deployed to this Supabase project. From a machine with the Supabase CLI, run: supabase functions deploy admin-analytics --no-verify-jwt',
            );
        }
        const invalidGatewayJwt = res.status === 401 && haystack.includes('invalid jwt');
        if (invalidGatewayJwt) {
            throw new Error(
                'The admin-analytics function is rejecting the token at the Supabase gateway. Redeploy with gateway JWT verification off (the function still checks your session and is_admin): supabase functions deploy admin-analytics --no-verify-jwt',
            );
        }
        throw new Error(detail || `HTTP ${res.status}`);
    }
    if (payload && payload.ok === false) {
        throw new Error(payload.error || payload.detail || payload.msg || 'Request failed');
    }
    return payload;
}

let currentAdminStatsTabId = 'overview';

function getAdminStatisticsRangeFromUI() {
    const presetEl = document.getElementById('adminStatsRangePreset');
    const preset = presetEl ? presetEl.value : '30';
    const today = new Date();
    const todayStart = startOfLocalDay(today);

    if (preset === 'all') {
        return {
            preset,
            startIso: null,
            endIso: null,
            fromDayKey: null,
            toDayKey: null,
            rangeDaysInclusive: 1,
            invalid: false,
        };
    }

    if (preset === 'custom') {
        const startInp = document.getElementById('adminStatsRangeStart');
        const endInp = document.getElementById('adminStatsRangeEnd');
        const sk = (startInp && startInp.value) ? startInp.value : toLocalDayKey(today);
        const ek = (endInp && endInp.value) ? endInp.value : toLocalDayKey(today);
        const sDate = parseDayKeyToLocalStart(sk);
        const eDate = parseDayKeyToLocalStart(ek);
        if (!sDate || !eDate || sDate > eDate) {
            return {
                preset,
                startIso: null,
                endIso: null,
                fromDayKey: toLocalDayKey(today),
                toDayKey: toLocalDayKey(today),
                rangeDaysInclusive: 1,
                invalid: true,
            };
        }
        const startIso = startOfLocalDay(sDate).toISOString();
        const endIso = endOfLocalDay(eDate).toISOString();
        const rangeDaysInclusive = calendarDaysInclusive(sDate, eDate);
        return {
            preset,
            startIso,
            endIso,
            fromDayKey: sk,
            toDayKey: ek,
            rangeDaysInclusive,
            invalid: false,
        };
    }

    const days = preset === '7' ? 7 : preset === '90' ? 90 : 30;
    const startDate = addLocalDays(todayStart, -(days - 1));
    const fromDayKey = toLocalDayKey(startDate);
    const toDayKey = toLocalDayKey(today);
    return {
        preset,
        startIso: startOfLocalDay(startDate).toISOString(),
        endIso: endOfLocalDay(today).toISOString(),
        fromDayKey,
        toDayKey,
        rangeDaysInclusive: days,
        invalid: false,
    };
}

function setAdminStatsLoading(show) {
    const el = document.getElementById('adminStatsLoading');
    if (!el) return;
    el.classList.toggle('hidden', !show);
}

function renderAdminKpis(p) {
    const first = p.first_call ? escapeHtml(toLocalDayKey(new Date(p.first_call))) : '—';
    const last = p.last_call ? escapeHtml(toLocalDayKey(new Date(p.last_call))) : '—';
    return `
        <div class="stats-kpi-card">
            <div class="stats-kpi-value">${Number(p.total || 0)}</div>
            <div class="stats-kpi-label">Total calls</div>
        </div>
        <div class="stats-kpi-card">
            <div class="stats-kpi-value">${Number(p.unique_users || 0)}</div>
            <div class="stats-kpi-label">Users</div>
        </div>
        <div class="stats-kpi-card">
            <div class="stats-kpi-value">${Number(p.unique_orgs || 0)}</div>
            <div class="stats-kpi-label">Organizations</div>
        </div>
        <div class="stats-kpi-card">
            <div class="stats-kpi-value">${first} – ${last}</div>
            <div class="stats-kpi-label">First / last (local day)</div>
        </div>
        <div class="stats-kpi-card">
            <div class="stats-kpi-value">${escapeHtml(String(p.avg_per_day ?? 0))}</div>
            <div class="stats-kpi-label">Avg / day in range</div>
        </div>
    `;
}

function renderAdminOrgsTable(topOrgs) {
    const list = topOrgs || [];
    if (!list.length) {
        return '<tr><td colspan="4">No organizations in range</td></tr>';
    }
    return list.map((o) => `
        <tr>
            <td>${o.rank}</td>
            <td>${escapeHtml(o.name)}</td>
            <td>${o.count}</td>
            <td>${o.pct}%</td>
        </tr>
    `).join('');
}

function attachAdminOverviewChart(dailyTimeseries, perUserSeries) {
    destroyAdminStatsPageChart();
    const canvas = document.getElementById('adminStatsOverviewCanvas');
    if (!canvas || typeof Chart === 'undefined') return;
    if (!Array.isArray(dailyTimeseries) || dailyTimeseries.length === 0) return;
    const labels = dailyTimeseries.map((p) => formatReportChartDay(p.day));
    const primary = getReportChartPrimaryColor();
    const textSecondary = getReportChartCssVar('--text-secondary') || 'rgba(255,255,255,0.68)';
    const borderColor = getReportChartCssVar('--border') || 'rgba(255,255,255,0.1)';
    const palette = ['#86a3ff', '#7ad7a6', '#f0b27a', '#e070c8', '#9bdcff', '#d4b8ff', '#ff8a8a', '#c9f068'];
    const series = Array.isArray(perUserSeries) ? perUserSeries : [];
    const datasets = [{
        label: 'Total',
        data: dailyTimeseries.map((p) => Number(p.calls ?? 0)),
        borderColor: primary,
        backgroundColor: 'transparent',
        tension: 0.2,
        fill: false,
        borderWidth: 2,
    }];
    series.forEach((s, i) => {
        datasets.push({
            label: s.title || s.user_id,
            data: (s.y || []).map((n) => Number(n)),
            borderColor: palette[i % palette.length],
            backgroundColor: 'transparent',
            tension: 0.2,
            fill: false,
            borderWidth: 1.5,
        });
    });
    adminStatsPageChart = new Chart(canvas, {
        type: 'line',
        data: { labels, datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 300 },
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: {
                    display: series.length > 0,
                    labels: { color: textSecondary, boxWidth: 10, font: { size: 10 } },
                },
                tooltip: { enabled: true },
            },
            scales: {
                x: {
                    grid: { display: false },
                    ticks: {
                        maxRotation: 0,
                        font: { size: 10 },
                        color: textSecondary,
                    },
                },
                y: {
                    beginAtZero: true,
                    grid: { color: borderColor },
                    ticks: {
                        font: { size: 10 },
                        color: textSecondary,
                    },
                },
            },
        },
    });
}

async function loadAdminOverviewTab() {
    const errEl = document.getElementById('adminStatsPageError');
    const mainEl = document.getElementById('adminStatsOverviewMain');
    const emptyEl = document.getElementById('adminStatsOverviewEmpty');
    if (errEl) errEl.textContent = '';
    const rangeSpec = getAdminStatisticsRangeFromUI();
    if (rangeSpec.invalid) {
        if (errEl) errEl.textContent = 'Choose a valid custom range (from on or before to).';
        if (mainEl) mainEl.classList.add('hidden');
        if (emptyEl) emptyEl.classList.add('hidden');
        return;
    }
    setAdminStatsLoading(true);
    if (mainEl) mainEl.classList.add('hidden');
    if (emptyEl) emptyEl.classList.add('hidden');
    destroyAdminStatsPageChart();
    try {
        const fetchRange = rangeSpec.preset === 'all'
            ? { startIso: null, endIso: null }
            : { startIso: rangeSpec.startIso, endIso: rangeSpec.endIso };
        const payload = await invokeAdminAnalytics({
            action: 'summary',
            timezoneOffsetMinutes: new Date().getTimezoneOffset(),
            startIso: fetchRange.startIso,
            endIso: fetchRange.endIso,
            fromDayKey: rangeSpec.fromDayKey,
            toDayKey: rangeSpec.toDayKey,
        });
        setAdminStatsLoading(false);
        if (Number(payload.total || 0) === 0) {
            if (emptyEl) emptyEl.classList.remove('hidden');
            return;
        }
        if (mainEl) mainEl.classList.remove('hidden');
        const kpi = document.getElementById('adminStatsKpiRow');
        if (kpi) kpi.innerHTML = renderAdminKpis(payload);
        const orgBody = document.getElementById('adminStatsOrgTableBody');
        if (orgBody) orgBody.innerHTML = renderAdminOrgsTable(payload.top_orgs);
        attachAdminOverviewChart(payload.daily_timeseries, payload.per_user_series);
    } catch (e) {
        setAdminStatsLoading(false);
        console.error('loadAdminOverviewTab', e);
        if (errEl) errEl.textContent = e?.message || 'Failed to load team overview.';
        destroyAdminStatsPageChart();
    }
}

async function loadAdminByUserTab() {
    const errEl = document.getElementById('adminStatsPageError');
    const mainEl = document.getElementById('adminStatsByUserMain');
    const emptyEl = document.getElementById('adminStatsByUserEmpty');
    if (errEl) errEl.textContent = '';
    const rangeSpec = getAdminStatisticsRangeFromUI();
    if (rangeSpec.invalid) {
        if (errEl) errEl.textContent = 'Choose a valid custom range (from on or before to).';
        if (mainEl) mainEl.classList.add('hidden');
        if (emptyEl) emptyEl.classList.add('hidden');
        return;
    }
    setAdminStatsLoading(true);
    if (mainEl) mainEl.classList.add('hidden');
    if (emptyEl) emptyEl.classList.add('hidden');
    try {
        const fetchRange = rangeSpec.preset === 'all'
            ? { startIso: null, endIso: null }
            : { startIso: rangeSpec.startIso, endIso: rangeSpec.endIso };
        const payload = await invokeAdminAnalytics({
            action: 'byUser',
            startIso: fetchRange.startIso,
            endIso: fetchRange.endIso,
        });
        setAdminStatsLoading(false);
        const users = payload.users || [];
        if (users.length === 0) {
            if (emptyEl) emptyEl.classList.remove('hidden');
            return;
        }
        if (mainEl) mainEl.classList.remove('hidden');
        const tbody = document.getElementById('adminStatsByUserTableBody');
        if (tbody) {
            tbody.innerHTML = users.map((u) => {
                const t = u.last_call_time ? escapeHtml(new Date(u.last_call_time).toLocaleString()) : '—';
                return `<tr><td>${escapeHtml(u.user_label || u.user_id)}</td><td>${u.call_count}</td><td>${t}</td></tr>`;
            }).join('');
        }
    } catch (e) {
        setAdminStatsLoading(false);
        console.error('loadAdminByUserTab', e);
        if (errEl) errEl.textContent = e?.message || 'Failed to load users.';
    }
}

const ADMIN_RECENT_PER_PAGE = 25;

async function loadAdminRecentTab() {
    const errEl = document.getElementById('adminStatsPageError');
    const tbody = document.getElementById('adminStatsRecentTableBody');
    const pageLabel = document.getElementById('adminStatsRecentPageLabel');
    const prevBtn = document.getElementById('adminStatsRecentPrevBtn');
    const nextBtn = document.getElementById('adminStatsRecentNextBtn');
    if (errEl) errEl.textContent = '';
    const rangeSpec = getAdminStatisticsRangeFromUI();
    if (rangeSpec.invalid) {
        if (tbody) tbody.innerHTML = '';
        if (pageLabel) pageLabel.textContent = '';
        if (errEl) errEl.textContent = 'Choose a valid custom range (from on or before to).';
        return;
    }
    setAdminStatsLoading(true);
    try {
        const fetchRange = rangeSpec.preset === 'all'
            ? { startIso: null, endIso: null }
            : { startIso: rangeSpec.startIso, endIso: rangeSpec.endIso };
        const payload = await invokeAdminAnalytics({
            action: 'recentCalls',
            startIso: fetchRange.startIso,
            endIso: fetchRange.endIso,
            page: adminRecentPage,
            perPage: ADMIN_RECENT_PER_PAGE,
        });
        setAdminStatsLoading(false);
        const calls = payload.calls || [];
        const total = Number(payload.total ?? calls.length);
        const totalPages = Math.max(1, Math.ceil(total / ADMIN_RECENT_PER_PAGE));
        if (adminRecentPage > totalPages) {
            adminRecentPage = totalPages;
            await loadAdminRecentTab();
            return;
        }
        if (tbody) {
            if (calls.length === 0) {
                tbody.innerHTML = '<tr><td colspan="5">No calls in this range</td></tr>';
            } else {
                tbody.innerHTML = calls.map((c) => {
                    const snip = (c.support_request || '').trim();
                    const short = snip.length > 80 ? `${escapeHtml(snip.slice(0, 80))}…` : escapeHtml(snip);
                    const when = c.call_time ? escapeHtml(new Date(c.call_time).toLocaleString()) : '—';
                    return `<tr><td>${when}</td><td>${escapeHtml(c.user_label || '')}</td><td>${escapeHtml((c.organization || '').trim() || '—')}</td><td>${escapeHtml((c.device_name || '').trim() || '—')}</td><td>${short || '—'}</td></tr>`;
                }).join('');
            }
        }
        if (pageLabel) pageLabel.textContent = `Page ${adminRecentPage} of ${totalPages} (${total} calls)`;
        if (prevBtn) prevBtn.disabled = adminRecentPage <= 1;
        if (nextBtn) nextBtn.disabled = adminRecentPage >= totalPages;
    } catch (e) {
        setAdminStatsLoading(false);
        console.error('loadAdminRecentTab', e);
        if (errEl) errEl.textContent = e?.message || 'Failed to load recent calls.';
        if (tbody) tbody.innerHTML = '';
    }
}

async function loadAdminLiveTabData() {
    const errEl = document.getElementById('adminStatsPageError');
    const metricsEl = document.getElementById('adminLiveMetrics');
    try {
        const payload = await invokeAdminAnalytics({ action: 'liveSeries', windowMinutes: 60 });
        const counts = payload.counts || [];
        const sum = counts.reduce((a, b) => a + Number(b || 0), 0);
        const peak = counts.length ? Math.max(...counts.map((n) => Number(n || 0))) : 0;
        const gen = payload.generatedAt ? new Date(payload.generatedAt).toLocaleString() : '—';
        if (metricsEl) {
            metricsEl.innerHTML = `
                <p><strong>Calls in the last hour (UTC buckets):</strong> ${sum}</p>
                <p><strong>Peak calls in one minute:</strong> ${peak}</p>
                <p class="profile-hint">Server time at refresh: ${escapeHtml(gen)}</p>
            `;
        }
    } catch (e) {
        console.error('loadAdminLiveTabData', e);
        if (errEl) errEl.textContent = e?.message || 'Failed to load live metrics.';
        if (metricsEl) metricsEl.innerHTML = '';
    }
}

function fillAdminCliBlock() {
    const url = (window.supabaseConfig?.SUPABASE_URL || '').trim();
    const block = document.getElementById('adminCliCommandBlock');
    if (!block) return;
    const lines = [
        '# PowerShell (example):',
        `$env:SUPABASE_URL="${url || 'https://YOUR_PROJECT.supabase.co'}"`,
        '$env:SUPABASE_ANON_KEY="<copy from supabaseConfig.js>"',
        '$env:CALL_LOG_ACCESS_TOKEN="<use Copy access token in this tab>"',
        'npm run admin:live-dashboard',
        '',
        'Quit the terminal dashboard with q or Ctrl+C.',
    ];
    block.textContent = lines.join('\n');
}

function startAdminLivePolling() {
    stopAdminLivePolling();
    adminStatsLiveTimer = setInterval(() => {
        if (currentAppView !== 'adminStatistics') return;
        if (currentAdminStatsTabId !== 'live') return;
        loadAdminLiveTabData().catch(() => {});
    }, 30000);
}

const handleAdminCopyToken = async () => {
    const feedback = document.getElementById('adminCopyTokenFeedback');
    try {
        const tok = await getSupabaseAccessToken();
        if (!tok) throw new Error('No active session');
        await navigator.clipboard.writeText(tok);
        if (feedback) feedback.textContent = 'Token copied. Treat it like a password.'
    } catch (e) {
        if (feedback) feedback.textContent = e?.message || 'Copy failed';
    }
    setTimeout(() => {
        if (feedback) feedback.textContent = '';
    }, 5000);
};

function selectAdminStatsTab(tabId) {
    const rows = [
        { id: 'overview', tabEl: 'adminStatsTabOverview', panelEl: 'adminStatsPanelOverview' },
        { id: 'byUser', tabEl: 'adminStatsTabByUser', panelEl: 'adminStatsPanelByUser' },
        { id: 'recent', tabEl: 'adminStatsTabRecent', panelEl: 'adminStatsPanelRecent' },
        { id: 'live', tabEl: 'adminStatsTabLive', panelEl: 'adminStatsPanelLive' },
    ];
    currentAdminStatsTabId = tabId;
    stopAdminLivePolling();
    for (const row of rows) {
        const active = row.id === tabId;
        const te = document.getElementById(row.tabEl);
        const pe = document.getElementById(row.panelEl);
        if (te) {
            te.setAttribute('aria-selected', active ? 'true' : 'false');
            te.tabIndex = active ? 0 : -1;
        }
        if (pe) {
            if (active) {
                pe.classList.remove('hidden');
                pe.removeAttribute('hidden');
            } else {
                pe.classList.add('hidden');
                pe.setAttribute('hidden', '');
            }
        }
    }
    if (tabId === 'live') {
        fillAdminCliBlock();
        loadAdminLiveTabData().catch((e) => console.error(e));
        startAdminLivePolling();
    }
    if (tabId === 'overview') {
        loadAdminOverviewTab().catch((e) => console.error(e));
    }
    if (tabId === 'byUser') {
        loadAdminByUserTab().catch((e) => console.error(e));
    }
    if (tabId === 'recent') {
        adminRecentPage = 1;
        loadAdminRecentTab().catch((e) => console.error(e));
    }
}

function openAdminStatisticsPage() {
    if (!currentUserProfile?.is_admin) return;
    const errEl = document.getElementById('adminStatsPageError');
    if (errEl) errEl.textContent = '';
    setAppView('adminStatistics');
    const preset = document.getElementById('adminStatsRangePreset');
    const customWrap = document.getElementById('adminStatsCustomRange');
    if (preset && customWrap) {
        customWrap.classList.toggle('hidden', preset.value !== 'custom');
    }
    selectAdminStatsTab('overview');
}

function refreshAdminStatsIfVisible() {
    if (currentAppView !== 'adminStatistics') return;
    const id = currentAdminStatsTabId;
    if (id === 'overview') loadAdminOverviewTab().catch((e) => console.warn(e));
    else if (id === 'byUser') loadAdminByUserTab().catch((e) => console.warn(e));
    else if (id === 'recent') loadAdminRecentTab().catch((e) => console.warn(e));
    else if (id === 'live') loadAdminLiveTabData().catch((e) => console.warn(e));
}

function setupAdminStatisticsPageListeners() {
    const preset = document.getElementById('adminStatsRangePreset');
    const customWrap = document.getElementById('adminStatsCustomRange');
    const applyCustom = document.getElementById('adminStatsApplyCustomBtn');
    const refreshBtn = document.getElementById('adminStatsRefreshBtn');
    const backInline = document.getElementById('adminStatsBackInlineBtn');
    const adminBtn = document.getElementById('adminStatsBtn');

    const syncCustomVisibility = () => {
        if (!preset || !customWrap) return;
        const isCustom = preset.value === 'custom';
        customWrap.classList.toggle('hidden', !isCustom);
        if (isCustom) {
            const startInp = document.getElementById('adminStatsRangeStart');
            const endInp = document.getElementById('adminStatsRangeEnd');
            const t = new Date();
            if (startInp && !startInp.value) startInp.value = toLocalDayKey(addLocalDays(startOfLocalDay(t), -29));
            if (endInp && !endInp.value) endInp.value = toLocalDayKey(t);
        }
    };

    preset?.addEventListener('change', () => {
        syncCustomVisibility();
        if (preset.value !== 'custom' && currentAppView === 'adminStatistics') {
            refreshAdminStatsIfVisible();
        }
    });

    applyCustom?.addEventListener('click', () => {
        refreshAdminStatsIfVisible();
    });

    refreshBtn?.addEventListener('click', () => {
        refreshAdminStatsIfVisible();
    });

    backInline?.addEventListener('click', () => setAppView('calls'));

    adminBtn?.addEventListener('click', () => openAdminStatisticsPage());

    document.getElementById('adminStatsTabOverview')?.addEventListener('click', () => selectAdminStatsTab('overview'));
    document.getElementById('adminStatsTabByUser')?.addEventListener('click', () => selectAdminStatsTab('byUser'));
    document.getElementById('adminStatsTabRecent')?.addEventListener('click', () => selectAdminStatsTab('recent'));
    document.getElementById('adminStatsTabLive')?.addEventListener('click', () => selectAdminStatsTab('live'));

    document.getElementById('adminStatsRecentPrevBtn')?.addEventListener('click', () => {
        if (adminRecentPage > 1) {
            adminRecentPage -= 1;
            loadAdminRecentTab().catch((e) => console.error(e));
        }
    });
    document.getElementById('adminStatsRecentNextBtn')?.addEventListener('click', () => {
        adminRecentPage += 1;
        loadAdminRecentTab().catch((e) => console.error(e));
    });

    document.getElementById('adminLiveRefreshBtn')?.addEventListener('click', () => {
        loadAdminLiveTabData().catch((e) => console.error(e));
    });

    document.getElementById('adminCopyTokenBtn')?.addEventListener('click', () => {
        handleAdminCopyToken().catch((e) => console.error(e));
    });

    syncCustomVisibility();
}

function appendAdminUserRows(users) {
    const tbody = document.getElementById('adminUsersTableBody');
    if (!tbody) return;
    const selfId = currentUserProfile?.id;
    for (const u of users) {
        const tr = document.createElement('tr');
        tr.dataset.userId = u.id;
        tr.dataset.isAdmin = u.is_admin ? '1' : '0';
        tr.dataset.banned = u.banned ? '1' : '0';
        const isSelf = u.id === selfId;
        const tdEmail = document.createElement('td');
        tdEmail.textContent = u.email || '';
        const tdName = document.createElement('td');
        tdName.textContent = u.full_name || '';
        const tdAdmin = document.createElement('td');
        tdAdmin.textContent = u.is_admin ? 'Yes' : 'No';
        const tdStatus = document.createElement('td');
        tdStatus.textContent = u.banned ? 'Banned' : 'Active';
        const tdLast = document.createElement('td');
        tdLast.textContent = u.last_sign_in_at
            ? new Date(u.last_sign_in_at).toLocaleString()
            : '—';
        const tdAct = document.createElement('td');
        tdAct.className = 'account-actions-cell';

        const mkBtn = (label, action, extraClass) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = `btn btn-secondary btn-sm admin-row-action ${extraClass || ''}`;
            b.textContent = label;
            b.dataset.action = action;
            b.dataset.userId = u.id;
            if (isSelf && (action === 'ban' || action === 'delete')) {
                b.disabled = true;
                b.title = 'Not available for your own account';
            }
            return b;
        };

        const actionsInner = document.createElement('div');
        actionsInner.className = 'account-actions-inner';
        actionsInner.appendChild(mkBtn(u.is_admin ? 'Remove admin' : 'Make admin', 'toggleAdmin', ''));
        actionsInner.appendChild(mkBtn(u.banned ? 'Enable' : 'Disable', 'toggleBan', ''));
        actionsInner.appendChild(mkBtn('Delete', 'deleteUser', 'btn-danger-outline'));
        tdAct.appendChild(actionsInner);

        tr.appendChild(tdEmail);
        tr.appendChild(tdName);
        tr.appendChild(tdAdmin);
        tr.appendChild(tdStatus);
        tr.appendChild(tdLast);
        tr.appendChild(tdAct);
        tbody.appendChild(tr);
    }
}

async function handleAdminLoadAutotaskTicketSources() {
    if (!currentUserProfile?.is_admin) return;
    const errEl = document.getElementById('adminTicketSourcesError');
    const tbody = document.getElementById('adminTicketSourcesTableBody');
    const wrap = document.getElementById('adminTicketSourcesWrap');
    const btn = document.getElementById('adminTicketSourcesBtn');
    if (errEl) errEl.textContent = '';
    if (!useSupabase()) {
        if (errEl) errEl.textContent = 'Sign-in is required.';
        return;
    }
    const supabase = getSupabase();
    if (!supabase) {
        if (errEl) errEl.textContent = 'Sign-in is required.';
        return;
    }
    const { error: userError } = await supabase.auth.getUser();
    if (userError) {
        if (errEl) errEl.textContent = 'Session invalid. Please sign in again.';
        return;
    }
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) {
        if (errEl) errEl.textContent = 'Session expired. Please sign in again.';
        return;
    }
    const config = window.supabaseConfig || {};
    const supabaseUrl = String(config.SUPABASE_URL || '').trim();
    if (!supabaseUrl) {
        if (errEl) errEl.textContent = 'Supabase is not configured.';
        return;
    }
    const baseFunctionsUrl = `${supabaseUrl.replace(/\/+$/, '')}/functions/v1`;
    const origLabel = btn?.textContent;
    if (btn) {
        btn.disabled = true;
        btn.textContent = 'Loading…';
    }
    try {
        const res = await fetch(`${baseFunctionsUrl}/autotask-ticket-sources`, {
            headers: { Authorization: `Bearer ${session.access_token}` },
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            if (errEl) errEl.textContent = data?.error || `Request failed (${res.status}).`;
            return;
        }
        const sources = Array.isArray(data?.sources) ? data.sources : [];
        if (tbody) {
            tbody.innerHTML = sources
                .map((s) => {
                    const id = escapeHtml(String(s.value));
                    const lab = escapeHtml(String(s.label || '—'));
                    const act = s.isActive === false ? 'No' : 'Yes';
                    return `<tr><td>${id}</td><td>${lab}</td><td>${act}</td></tr>`;
                })
                .join('');
        }
        if (wrap) wrap.removeAttribute('hidden');
    } catch (e) {
        if (errEl) errEl.textContent = 'Could not load ticket sources.';
        console.error('[autotask-ticket-sources]', e);
    } finally {
        if (btn) {
            btn.disabled = false;
            if (origLabel) btn.textContent = origLabel;
        }
    }
}

async function fetchAdminDirectory(reset) {
    if (!currentUserProfile?.is_admin) return;
    const errEl = document.getElementById('adminUsersError');
    const tbody = document.getElementById('adminUsersTableBody');
    const loadMoreBtn = document.getElementById('adminLoadMoreBtn');
    if (errEl) errEl.textContent = '';
    let pageToFetch;
    if (reset) {
        adminDirectoryPage = 1;
        if (tbody) tbody.innerHTML = '';
        pageToFetch = 1;
    } else {
        pageToFetch = adminDirectoryPage;
    }
    try {
        const payload = await invokeAccountAdmin({
            action: 'list',
            page: pageToFetch,
            perPage: ADMIN_LIST_PER_PAGE,
        });
        const users = payload.users || [];
        appendAdminUserRows(users);
        adminDirectoryPage = pageToFetch + 1;
        const hasMore = users.length >= ADMIN_LIST_PER_PAGE;
        if (loadMoreBtn) loadMoreBtn.style.display = hasMore ? '' : 'none';
    } catch (err) {
        if (errEl) errEl.textContent = err?.message || 'Failed to load users.';
    }
}

async function handleAdminTableAction(action, userId, sourceBtn) {
    const errEl = document.getElementById('adminUsersError');
    if (errEl) errEl.textContent = '';
    const tr = sourceBtn?.closest?.('tr');
    const rowIsAdmin = tr?.dataset.isAdmin === '1';
    const rowBanned = tr?.dataset.banned === '1';
    try {
        if (action === 'toggleAdmin') {
            const next = !rowIsAdmin;
            const ok = await openConfirm({
                title: next ? 'Grant administrator' : 'Remove administrator',
                message: next
                    ? 'This user will be able to manage accounts and run privileged actions.'
                    : 'This user will lose administrator access.',
                detail: 'You can change this again later.',
                okLabel: next ? 'Grant' : 'Remove',
            });
            if (!ok) return;
            await invokeAccountAdmin({ action: 'setAdmin', userId, is_admin: next });
        } else if (action === 'toggleBan') {
            const nextBan = !rowBanned;
            const ok = await openConfirm({
                title: nextBan ? 'Disable user' : 'Enable user',
                message: nextBan
                    ? 'The user will not be able to sign in until re-enabled.'
                    : 'The user will be able to sign in again.',
                detail: nextBan ? 'They remain in the directory until deleted.' : '',
                okLabel: nextBan ? 'Disable' : 'Enable',
            });
            if (!ok) return;
            await invokeAccountAdmin({ action: 'setBanned', userId, banned: nextBan });
        } else if (action === 'deleteUser') {
            const ok = await openConfirm({
                title: 'Delete user',
                message: 'Permanently delete this user and their auth record?',
                detail: 'This cannot be undone. Profile data for this user will be removed.',
                okLabel: 'Delete user',
            });
            if (!ok) return;
            await invokeAccountAdmin({ action: 'deleteUser', userId });
        }
        await fetchAdminDirectory(true);
        accountAdminLoadedOnce = true;
    } catch (err) {
        const msg = err?.message || String(err);
        if (errEl) {
            if (msg.includes('last_admin')) {
                errEl.textContent = 'Cannot remove the last administrator.';
            } else {
                errEl.textContent = msg;
            }
        }
    }
}

function setupAccountPageListeners() {
    document.getElementById('profileBtn')?.addEventListener('click', openAccountPage);
    document.getElementById('accountBackBtn')?.addEventListener('click', () => setAppView('calls'));

    document.getElementById('accountTabProfile')?.addEventListener('click', () => selectAccountTab('profile'));
    document.getElementById('accountTabUpdates')?.addEventListener('click', () => selectAccountTab('updates'));
    document.getElementById('accountTabSecurity')?.addEventListener('click', () => selectAccountTab('security'));
    document.getElementById('accountTabAdmin')?.addEventListener('click', () => selectAccountTab('admin'));

    document.getElementById('profileForm')?.addEventListener('submit', handleProfileSubmit);
    document.getElementById('feedbackForm')?.addEventListener('submit', handleFeedbackSubmit);
    document.getElementById('securityPasswordForm')?.addEventListener('submit', handleSecurityPasswordSubmit);
    document.getElementById('securitySignOutEverywhereBtn')?.addEventListener('click', handleSecuritySignOutEverywhere);
    document.getElementById('adminInviteForm')?.addEventListener('submit', handleAdminInviteSubmit);
    document.getElementById('adminUsersRefreshBtn')?.addEventListener('click', () => {
        accountAdminLoadedOnce = true;
        fetchAdminDirectory(true).catch((e) => console.error(e));
    });
    document.getElementById('adminLoadMoreBtn')?.addEventListener('click', () => {
        fetchAdminDirectory(false).catch((e) => console.error(e));
    });
    document.getElementById('adminTicketSourcesBtn')?.addEventListener('click', () => {
        void handleAdminLoadAutotaskTicketSources();
    });

    document.getElementById('adminUsersTableBody')?.addEventListener('click', (e) => {
        const btn = e.target.closest?.('.admin-row-action');
        if (!btn || btn.disabled) return;
        const action = btn.dataset.action;
        const userId = btn.dataset.userId;
        if (!action || !userId) return;
        handleAdminTableAction(action, userId, btn);
    });
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
    const fullName = clampDisplayName(nameEl?.value || '');
    const newEmail = emailEl?.value.trim() || '';
    if (errEl) errEl.textContent = '';
    if (nameEl) nameEl.value = fullName;
    if (!fullName) {
        if (errEl) errEl.textContent = 'Please enter your name.';
        return;
    }
    if (!newEmail) {
        if (errEl) errEl.textContent = 'Please enter your email.';
        return;
    }
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
        if (errEl) errEl.textContent = 'Session expired. Please log in again.';
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
                { onConflict: 'id' },
            );
        if (profileError) {
            if (errEl) errEl.textContent = profileError.message || 'Failed to update name.';
            return;
        }
        const { error: metaErr } = await supabase.auth.updateUser({ data: { full_name: fullName } });
        if (metaErr) console.warn('updateUser full_name metadata:', metaErr);
        if (newEmail !== (session.user.email || '')) {
            const { error: authError } = await supabase.auth.updateUser({ email: newEmail });
            if (authError) {
                if (errEl) errEl.textContent = authError.message || 'Failed to update email.';
                return;
            }
            await supabase.auth.refreshSession();
        }
        currentUserProfile = { id: session.user.id, full_name: fullName, is_admin: !!currentUserProfile?.is_admin };
        profileCache.set(session.user.id, fullName);
        updateAccountAdminTabVisibility();
        await updateProfileEmailPendingHint();
        showNotification('Profile updated.');
    } catch (err) {
        if (errEl) errEl.textContent = err?.message || 'Update failed.';
    } finally {
        if (saveBtn) {
            saveBtn.disabled = false;
            saveBtn.textContent = originalText || 'Save profile';
        }
    }
}

const FEEDBACK_ALLOWED_CATEGORIES = new Set(['feature', 'improvement', 'bug', 'other']);

const getFeedbackAppVersionForPayload = () => {
    const raw = String(document.getElementById('appVersion')?.textContent || '').trim();
    const stripped = raw.replace(/^v/i, '').trim();
    return stripped.length ? stripped : null;
};

async function handleFeedbackSubmit(e) {
    e.preventDefault();
    if (!useSupabase()) return;
    const supabase = getSupabase();
    if (!supabase) return;
    const errEl = document.getElementById('feedbackError');
    const categoryEl = document.getElementById('feedbackCategory');
    const messageEl = document.getElementById('feedbackMessage');
    const btn = document.getElementById('feedbackSubmitBtn');
    if (errEl) errEl.textContent = '';
    const rawCategory = (categoryEl?.value || '').trim();
    const category = FEEDBACK_ALLOWED_CATEGORIES.has(rawCategory) ? rawCategory : 'other';
    const message = (messageEl?.value || '').trim();
    if (!message) {
        if (errEl) errEl.textContent = 'Please add a short description.';
        messageEl?.focus();
        return;
    }
    if (message.length > 8000) {
        if (errEl) errEl.textContent = 'Please keep your message under 8000 characters.';
        messageEl?.focus();
        return;
    }
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
        if (errEl) errEl.textContent = 'Session expired. Please sign in again.';
        return;
    }
    const originalText = btn?.textContent;
    if (btn) {
        btn.disabled = true;
        btn.textContent = 'Sending…';
    }
    try {
        const { error } = await supabase.from('app_feedback').insert({
            user_id: session.user.id,
            category,
            message,
            app_version: getFeedbackAppVersionForPayload(),
        });
        if (error) {
            const msg = String(error.message || error.details || '');
            const missingTable =
                msg.includes('app_feedback') &&
                (msg.includes('does not exist') || msg.includes('schema cache') || msg.includes('Could not find'));
            if (errEl) {
                errEl.textContent = missingTable
                    ? 'Feedback storage is not set up on this project yet. Ask an administrator to apply migration 011_app_feedback.sql.'
                    : msg || 'Could not send feedback.';
            }
            return;
        }
        if (messageEl) messageEl.value = '';
        if (categoryEl) categoryEl.value = 'feature';
        showNotification('Thanks — your feedback was sent.');
    } catch (err) {
        if (errEl) errEl.textContent = err?.message || 'Could not send feedback.';
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = originalText || 'Send feedback';
        }
    }
}

async function handleSecurityPasswordSubmit(e) {
    e.preventDefault();
    if (!useSupabase()) return;
    const supabase = getSupabase();
    if (!supabase) return;
    const errEl = document.getElementById('securityPasswordError');
    const np = document.getElementById('securityNewPassword')?.value || '';
    const cp = document.getElementById('securityConfirmPassword')?.value || '';
    const btn = document.getElementById('securityPasswordSubmit');
    errEl.textContent = '';
    if (np.length < 8) {
        errEl.textContent = 'Password must be at least 8 characters.';
        return;
    }
    if (np !== cp) {
        errEl.textContent = 'Passwords do not match.';
        return;
    }
    const orig = btn?.textContent;
    if (btn) {
        btn.disabled = true;
        btn.textContent = 'Updating…';
    }
    try {
        const { error } = await supabase.auth.updateUser({ password: np });
        if (error) {
            errEl.textContent = error.message || 'Failed to update password.';
            return;
        }
        document.getElementById('securityNewPassword').value = '';
        document.getElementById('securityConfirmPassword').value = '';
        showNotification('Password updated.');
    } catch (err) {
        errEl.textContent = err?.message || 'Update failed.';
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = orig || 'Update password';
        }
    }
}

async function handleSecuritySignOutEverywhere() {
    const errEl = document.getElementById('securitySignOutEverywhereError');
    if (errEl) errEl.textContent = '';
    const ok = await openConfirm({
        title: 'Sign out everywhere',
        message: 'End all sessions for this account on every device?',
        detail: 'You will need to sign in again on this device.',
        okLabel: 'Sign out everywhere',
    });
    if (!ok) return;
    try {
        await runAuthSignOutAndTeardown({ scope: 'global' });
    } catch (err) {
        if (errEl) errEl.textContent = err?.message || 'Sign out failed.';
    }
}

async function handleAdminInviteSubmit(e) {
    e.preventDefault();
    const errEl = document.getElementById('adminInviteError');
    const emailEl = document.getElementById('adminInviteEmail');
    const btn = document.getElementById('adminInviteSubmit');
    const email = (emailEl?.value || '').trim().toLowerCase();
    if (errEl) errEl.textContent = '';
    if (!email) {
        if (errEl) errEl.textContent = 'Enter an email address.';
        return;
    }
    const orig = btn?.textContent;
    if (btn) {
        btn.disabled = true;
        btn.textContent = 'Sending…';
    }
    try {
        await invokeAccountAdmin({
            action: 'invite',
            email,
        });
        if (emailEl) emailEl.value = '';
        showNotification('Invite sent.');
        await fetchAdminDirectory(true);
        accountAdminLoadedOnce = true;
    } catch (err) {
        if (errEl) errEl.textContent = err?.message || 'Invite failed.';
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = orig || 'Send invite';
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
    startCallDateAutoSync();
    document.getElementById('name').focus();
    if (mainFormOrganizationCommitTimer) {
        clearTimeout(mainFormOrganizationCommitTimer);
        mainFormOrganizationCommitTimer = null;
    }
    commitMainOrganizationResolution();
}

const activeNotifications = []
const NOTIFICATION_BASE_TOP = 60
const NOTIFICATION_GAP = 10

const repositionNotifications = () => {
    let offset = NOTIFICATION_BASE_TOP
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    for (const el of activeNotifications) {
        el.style.top = `${offset}px`
        if (!prefersReducedMotion) {
            el.style.transition = 'top 180ms var(--ease-out-quart)'
        }
        offset += el.offsetHeight + NOTIFICATION_GAP
    }
}

const removeNotification = (el) => {
    const idx = activeNotifications.indexOf(el)
    if (idx !== -1) activeNotifications.splice(idx, 1)
    el.remove()
    repositionNotifications()
}

const showNotification = (message) => {
    const notification = document.createElement('div')
    notification.className = 'notification'
    notification.setAttribute('data-testid', 'app-notification')
    notification.textContent = message
    document.body.appendChild(notification)

    activeNotifications.push(notification)
    repositionNotifications()

    setTimeout(() => {
        notification.classList.add('is-exiting')
        setTimeout(() => removeNotification(notification), 160)
    }, 3000)
}

function cssEscapeValue(value) {
    const v = String(value ?? '');
    if (typeof window.CSS !== 'undefined' && typeof window.CSS.escape === 'function') {
        return window.CSS.escape(v);
    }
    return v.replace(/["\\]/g, '\\$&');
}

function flashEntryCard(entryId) {
    if (entryId == null) return;
    const id = String(entryId);

    requestAnimationFrame(() => {
        const el = document.querySelector(`.entry-card[data-id="${cssEscapeValue(id)}"]`);
        if (!el) return;
        el.classList.remove('entry-card--flash');
        // Force restart if called repeatedly
        void el.offsetWidth;
        el.classList.add('entry-card--flash');
        setTimeout(() => el.classList.remove('entry-card--flash'), 800);
    });
}

// Show desktop / tray notification when a call is logged (Discord-style near system tray in Electron)
function showDesktopNotification(title, body) {
    if (window.electronAPI?.showTrayNotification) {
        window.electronAPI.showTrayNotification(title || 'Call Log', body || '');
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

