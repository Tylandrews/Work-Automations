// Global state
let currentFilter = '';
let editingEntryId = null;
let selectedDay = null; // local day key: YYYY-MM-DD
let calendarMonth = null; // Date representing first day of visible month
/** Serializes prev/next month clicks so rapid navigation still advances one month per click */
let calendarMonthNavChain = Promise.resolve()
let confirmResolver = null;
let supabaseClient = null;
let supabaseRealtimeChannel = null;
let currentUserProfile = null; // { id, full_name, is_admin } for logged-in user (Supabase)
const profileCache = new Map(); // user_id -> full_name

/** Deploy: `supabase functions deploy account-admin` (use `--no-verify-jwt` if JWT is verified inside the function). */
const ACCOUNT_ADMIN_FUNCTION_SLUG = 'account-admin'
const ADMIN_LIST_PER_PAGE = 50

let currentAppView = 'calls'
let logoutClickHandler = null
let adminDirectoryPage = 1
let accountAdminLoadedOnce = false

function setAppView(view) {
    const main = document.getElementById('mainWorkspace');
    const account = document.getElementById('accountWorkspace');
    const backBtn = document.getElementById('accountBackBtn');
    const profileBtn = document.getElementById('profileBtn');
    if (!main || !account) return;
    if (view === 'account') {
        currentAppView = 'account';
        main.classList.add('hidden');
        main.setAttribute('aria-hidden', 'true');
        account.classList.remove('hidden');
        account.setAttribute('aria-hidden', 'false');
        if (backBtn) backBtn.style.display = '';
        if (profileBtn) profileBtn.style.display = 'none';
    } else {
        currentAppView = 'calls';
        main.classList.remove('hidden');
        main.setAttribute('aria-hidden', 'false');
        account.classList.add('hidden');
        account.setAttribute('aria-hidden', 'true');
        if (backBtn) backBtn.style.display = 'none';
        if (profileBtn && useSupabase() && getSupabase()) profileBtn.style.display = '';
    }
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
let autocompleteAbortController = null;
let autocompleteActiveInstance = null; // Currently active autocomplete instance
const ORG_SELECTION_CACHE_PREFIX = 'calllog-org-selection-';
const CACHED_AUTOTASK_COMPANIES_KEY = 'cached_autotask_companies';

function getCachedOrganizationSelection(inputId) {
    try {
        return String(localStorage.getItem(`${ORG_SELECTION_CACHE_PREFIX}${inputId}`) || '').trim();
    } catch (err) {
        return '';
    }
}

function setCachedOrganizationSelection(inputId, organizationName) {
    const value = String(organizationName || '').trim();
    if (!value) return;
    try {
        localStorage.setItem(`${ORG_SELECTION_CACHE_PREFIX}${inputId}`, value);
    } catch (err) {
        // Ignore localStorage errors
    }
}

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

    try {
        const existingRaw = localStorage.getItem(CACHED_AUTOTASK_COMPANIES_KEY);
        const existing = (() => {
            if (!existingRaw) return [];
            try {
                const parsed = JSON.parse(existingRaw);
                return Array.isArray(parsed) ? parsed : [];
            } catch (err) {
                return [];
            }
        })();

        const byName = new Map(
            existing
                .map((org) => ({
                    id: String(org?.id || ''),
                    name: String(org?.name || '').trim()
                }))
                .filter((org) => org.name)
                .map((org) => [org.name.toLowerCase(), org])
        );

        normalizedIncoming.forEach((org) => {
            byName.set(org.name.toLowerCase(), org);
        });

        const merged = Array.from(byName.values()).slice(0, 500);
        localStorage.setItem(CACHED_AUTOTASK_COMPANIES_KEY, JSON.stringify(merged));
    } catch (err) {
        // Ignore localStorage errors
    }
}

function loadPersistentAutotaskCompanies() {
    try {
        const raw = localStorage.getItem(CACHED_AUTOTASK_COMPANIES_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed
            .map((org) => ({
                id: String(org?.id || ''),
                name: String(org?.name || '').trim()
            }))
            .filter((org) => org.name);
    } catch (err) {
        return [];
    }
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
    return filterOrganizationsByQuerySubstring(loadPersistentAutotaskCompanies(), cacheKey, limit);
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
// SECURITY: This function NEVER contains or sends API keys.
// All API calls go through a Supabase Edge Function which stores Autotask credentials server-side.

/**
 * Search organizations via Supabase Edge Function (secure proxy)
 * @param {string} query - Search query (minimum 2 characters)
 * @param {number} limit - Maximum number of results (default: 20)
 * @returns {Promise<Array<{id: string, name: string}>>}
 */
async function searchOrganizationsViaProxy(query, limit = 20) {
    if (!query || query.trim().length < 2) {
        return [];
    }

    const cacheKey = query.toLowerCase().trim();
    const cached = autocompleteCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp) < AUTOCACHE_TTL_MS) {
        return cached.results;
    }

    const supabase = getSupabase();
    if (!supabase) {
        console.warn('Supabase not configured. Autocomplete disabled.');
        return [];
    }

    // Get Supabase session for authentication
    let { data: { session } } = await supabase.auth.getSession();
    if (!session) {
        console.warn('No active session. Autocomplete requires authentication.');
        return [];
    }
    const expiresAtMs = typeof session.expires_at === 'number' ? session.expires_at * 1000 : null;
    const isExpiringSoon = typeof expiresAtMs === 'number' ? expiresAtMs < (Date.now() + 30 * 1000) : false;
    if (isExpiringSoon) {
        const { data: refreshed, error: refreshErr } = await supabase.auth.refreshSession();
        if (refreshErr || !refreshed?.session?.access_token) {
            console.warn('Session expired. Please log in again.');
            return [];
        }
        session = refreshed.session;
    }
    if (!session?.access_token) {
        console.warn('Session expired. Please log in again.');
        return [];
    }

    // Get Supabase project URL
    const config = window.supabaseConfig || {};
    const supabaseUrl = (config.SUPABASE_URL || '').trim();
    if (!supabaseUrl) {
        console.warn('Supabase URL not configured.');
        return [];
    }

    // Call Edge Function (never sends API key - it's stored server-side)
    // Prefer the canonical function that performs Supabase cache writes.
    const baseFunctionsUrl = `${supabaseUrl.replace(/\/+$/, '')}/functions/v1`;
    const edgeFunctionCandidates = [
        `${baseFunctionsUrl}/autotask-search-companies-v3`,
        `${baseFunctionsUrl}/autotask-search-companies`
    ];
    const searchParams = new URLSearchParams({
        q: query.trim(),
        limit: String(Math.min(Math.max(limit, 1), 50))
    });

    try {
        const anonKey = (config.SUPABASE_ANON_KEY || '').trim();
        const isJwtLike = (token) => typeof token === 'string' && token.split('.').length === 3;
        let response = null;
        for (const endpoint of edgeFunctionCandidates) {
            const candidateResponse = await fetch(`${endpoint}?${searchParams}`, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${session.access_token}`,
                    // Supabase Edge Functions expect the project anon/publishable key as `apikey`
                    // This is safe to include client-side (as with the rest of the app).
                    'apikey': anonKey,
                    'Content-Type': 'application/json'
                }
            });
            if (candidateResponse.ok || candidateResponse.status !== 404) {
                response = candidateResponse;
                break;
            }
        }
        if (!response) {
            throw new Error('No deployed Autotask search edge function found.');
        }

        if (response.status === 401) {
            const { data: refreshed, error: refreshErr } = await supabase.auth.refreshSession();
            const refreshedToken = refreshed?.session?.access_token;
            if (!refreshErr && isJwtLike(refreshedToken)) {
                session = refreshed.session;
                response = null;
                for (const endpoint of edgeFunctionCandidates) {
                    const candidateResponse = await fetch(`${endpoint}?${searchParams}`, {
                        method: 'GET',
                        headers: {
                            'Authorization': `Bearer ${session.access_token}`,
                            // Supabase Edge Functions expect the project anon/publishable key as `apikey`
                            // This is safe to include client-side (as with the rest of the app).
                            'apikey': anonKey,
                            'Content-Type': 'application/json'
                        }
                    });
                    if (candidateResponse.ok || candidateResponse.status !== 404) {
                        response = candidateResponse;
                        break;
                    }
                }
                if (!response) {
                    throw new Error('No deployed Autotask search edge function found.');
                }
            }
        }

        if (!response.ok) {
            const txt = await response.text().catch(() => '');
            let errorDetails = '';
            let fullError = '';
            try {
                const errorJson = JSON.parse(txt);
                errorDetails = errorJson.details || errorJson.error || '';
                fullError = JSON.stringify(errorJson, null, 2);
            } catch {
                errorDetails = txt;
                fullError = txt;
            }
            console.warn('[autotask-autocomplete] non-2xx', response.status);
            console.warn('[autotask-autocomplete] Full error response:', fullError);
            if (response.status === 401) {
                console.warn('Session expired. Please log in again.');
                return [];
            }
            if (response.status === 503) {
                console.warn('Autotask API not configured on server.');
                return [];
            }
            throw new Error(`Edge Function returned ${response.status}: ${errorDetails || 'See console for details'}`);
        }

        const data = await response.json();
        const organizations = Array.isArray(data.organizations) ? data.organizations : [];
        addToCachedAutotaskCompanies(organizations);

        // Cache results
        autocompleteCache.set(cacheKey, {
            results: organizations,
            timestamp: Date.now()
        });

        return organizations;
    } catch (err) {
        console.error('Failed to search organizations:', err);
        return [];
    }
}

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

    const cachedOrganization = getCachedOrganizationSelection(inputId);
    if (!input.value.trim() && cachedOrganization) {
        input.value = cachedOrganization;
    }

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
            return `
                <div class="autocomplete-item" role="option" data-index="${index}" data-value="${escapeHtmlAttr(org.name)}" aria-selected="false">
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
        setCachedOrganizationSelection(inputId, org.name);
        addToCachedAutotaskCompanies(org);
        suppressNextInputSearch = true;
        hideDropdown();

        // Trigger input event for form validation
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.focus();
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

    // Debounced search
    async function performSearch(query) {
        // Cancel previous request
        if (autocompleteAbortController) {
            autocompleteAbortController.abort();
        }
        autocompleteAbortController = new AbortController();

        // Clear previous timer
        if (autocompleteDebounceTimer) {
            clearTimeout(autocompleteDebounceTimer);
        }

        autocompleteDebounceTimer = setTimeout(async () => {
            if (query.length < 2) {
                hideDropdown();
                return;
            }

            try {
                const orgs = await searchOrganizationsViaProxy(query, 20);
                if (autocompleteActiveInstance === inputId) {
                    renderSuggestions(orgs, query);
                }
            } catch (err) {
                if (err.name !== 'AbortError') {
                    console.error('Autocomplete search error:', err);
                    hideDropdown();
                }
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
            return;
        }
        const { data, error } = await supabase
            .from('profiles')
            .select('full_name, is_admin')
            .eq('id', session.user.id)
            .single();
        if (error) {
            console.error('loadCurrentUserProfile error:', error);
            currentUserProfile = { id: session.user.id, full_name: session.user.email || 'You', is_admin: false };
            updateAccountAdminTabVisibility();
            return;
        }
        currentUserProfile = { id: session.user.id, full_name: data.full_name || (session.user.email || 'You'), is_admin: !!data.is_admin };
        profileCache.set(session.user.id, currentUserProfile.full_name);
        updateAccountAdminTabVisibility();
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
    const layout = document.querySelector('.auth-layout');
    const brandCard = document.getElementById('authBrandCard');
    const formCard = document.getElementById('authFormCard');
    const supabase = getSupabase();
    if (!supabase || !form) return;

    let authMode = 'login'; // 'login' | 'signup'

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

    function switchToSignupMode() {
        authMode = 'signup';
        showAuthForm();
        if (authNameGroup) authNameGroup.style.display = '';
        if (nameInput) nameInput.setAttribute('required', '');
        if (signInBtn) signInBtn.textContent = 'Create account';
        if (signUpBtn) signUpBtn.textContent = 'Back to log in';
        authError.textContent = '';
    }

    function switchToLoginMode() {
        authMode = 'login';
        showAuthForm();
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
            // Save email for next time
            try {
                localStorage.setItem('calllog-saved-email', email);
            } catch (e) {
                // Ignore localStorage errors
            }
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
                // Save email for next time
                try {
                    localStorage.setItem('calllog-saved-email', email);
                } catch (e) {
                    // Ignore localStorage errors
                }
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
    setCurrentDateTime();
    setupEventListeners();
    setupKeyboardShortcuts();
    setupTitlebar();

    // Reports are Supabase-only
    const reportsBtn = document.getElementById('reportsBtn');
    if (reportsBtn) reportsBtn.style.display = useSupabase() ? '' : 'none';

    // Setup organization autocomplete (only if Supabase is configured)
    if (useSupabase()) {
        setupOrganizationAutocomplete('organization', 'organization-autocomplete-list');
        setupOrganizationAutocomplete('editOrganization', 'editOrganization-autocomplete-list');
    }

    await initializeHistoryDay();
    await renderCalendar(calendarMonth);
    await loadEntries();
    await updateStats();
    fitWindowToContent();
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
    
    // Search functionality (inside History panel)
    document.getElementById('searchBtn').addEventListener('click', toggleSearch);
    document.getElementById('closeSearch').addEventListener('click', toggleSearch);
    document.getElementById('searchInput').addEventListener('input', handleSearch);

    // Stats button
    document.getElementById('statsBtn').addEventListener('click', showStats);
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
    document.getElementById('closeStatsModal').addEventListener('click', closeStatsModal);
    document.getElementById('closeReportsModal')?.addEventListener('click', closeReportsModal);
    document.getElementById('editForm').addEventListener('submit', handleEditSubmit);

    setupAccountPageListeners();

    // Close modals on outside click
    // Keep Edit modal open on backdrop clicks to prevent accidental dismiss while editing.
    document.getElementById('editModal').addEventListener('click', (e) => {
        if (e.target.id === 'editModal') return;
    });
    document.getElementById('statsModal').addEventListener('click', (e) => {
        if (e.target.id === 'statsModal') closeStatsModal();
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
            } else if (document.getElementById('reportsModal')?.classList.contains('show')) {
                closeReportsModal();
            } else if (document.getElementById('calendarModal')?.classList.contains('show')) {
                closeCalendar();
            } else if (document.getElementById('confirmModal')?.classList.contains('show')) {
                closeConfirm(false);
            } else if (currentAppView === 'account') {
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
    if (formData.organization) {
        setCachedOrganizationSelection('organization', formData.organization);
        addToCachedAutotaskCompanies({ id: '', name: formData.organization });
    }

    try {
        const saved = await saveEntry(formData);
        if (saved == null) {
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

    // Immediate loading state to avoid pop-in
    setEntriesLoading(true);
    const loadStartedAt = performance.now();

    const entries = await getEntries();
    const dynamicMinMs = getDynamicMinLoadingMs(entries.length);

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
        await waitForMinLoading(loadStartedAt, dynamicMinMs);
        entriesList.innerHTML = html;
        setEntriesLoading(false);
        return;
    }
    
    const html = filteredEntries.map(entry => createEntryCard(entry)).join('');

    await updateStats();
    await waitForMinLoading(loadStartedAt, dynamicMinMs);
    entriesList.innerHTML = html;
    setEntriesLoading(false);
}

function getDynamicMinLoadingMs(totalEntries) {
    const base = 2000;
    // As the DB grows, keep the transition feeling intentional without becoming slow.
    // Adds up to +1500ms max, in small steps.
    const extra = Math.min(1500, Math.floor((Number(totalEntries) || 0) / 200) * 150);
    return base + extra;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForMinLoading(startedAt, minMs) {
    const elapsed = performance.now() - startedAt;
    const remaining = (minMs || 0) - elapsed;
    if (remaining > 0) await sleep(remaining);
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
function createEntryCard(entry) {
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
        <div class="entry-card" data-id="${escapeHtmlAttr(String(entry.id))}" role="button" tabindex="0" title="Click to edit">
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
            ${entry.notes ? `<div class="entry-notes"><strong>Notes:</strong> ${escapeHtml(entry.notes)}</div>` : ''}
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

// Close stats modal
function closeStatsModal() {
    document.getElementById('statsModal').classList.remove('show');
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
        <div class="report-card">
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
        <div class="report-card"><div class="report-card-title">Loading…</div></div>
        <div class="report-card"><div class="report-card-title">Loading…</div></div>
        <div class="report-card"><div class="report-card-title">Loading…</div></div>
        <div class="report-card"><div class="report-card-title">Loading…</div></div>
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

// ---------- Account page (Supabase) ----------
function updateAccountAdminTabVisibility() {
    const tab = document.getElementById('accountTabAdmin');
    if (!tab) return;
    const isAdmin = !!currentUserProfile?.is_admin;
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
    if (tabId === 'admin' && currentUserProfile?.is_admin) {
        if (!accountAdminLoadedOnce) {
            accountAdminLoadedOnce = true;
            fetchAdminDirectory(true).catch((err) => console.error('fetchAdminDirectory', err));
        }
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
    });
}

function openAccountPage() {
    if (!useSupabase() || !currentUserProfile) return;
    hydrateAccountProfileForm();
    document.getElementById('securityPasswordError').textContent = '';
    document.getElementById('securitySignOutEverywhereError').textContent = '';
    document.getElementById('adminInviteError').textContent = '';
    document.getElementById('adminUsersError').textContent = '';
    const np = document.getElementById('securityNewPassword');
    const cp = document.getElementById('securityConfirmPassword');
    if (np) np.value = '';
    if (cp) cp.value = '';
    updateAccountAdminTabVisibility();
    selectAccountTab('profile');
    setAppView('account');
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
        throw new Error(detail || `HTTP ${res.status}`);
    }
    if (payload && payload.ok === false) {
        throw new Error(payload.error || payload.detail || 'Request failed');
    }
    return payload;
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

        tdAct.appendChild(mkBtn(u.is_admin ? 'Remove admin' : 'Make admin', 'toggleAdmin', ''));
        tdAct.appendChild(document.createTextNode(' '));
        tdAct.appendChild(mkBtn(u.banned ? 'Enable' : 'Disable', 'toggleBan', ''));
        tdAct.appendChild(document.createTextNode(' '));
        tdAct.appendChild(mkBtn('Delete', 'deleteUser', 'btn-danger-outline'));

        tr.appendChild(tdEmail);
        tr.appendChild(tdName);
        tr.appendChild(tdAdmin);
        tr.appendChild(tdStatus);
        tr.appendChild(tdLast);
        tr.appendChild(tdAct);
        tbody.appendChild(tr);
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
    document.getElementById('accountBackInlineBtn')?.addEventListener('click', () => setAppView('calls'));

    document.getElementById('accountTabProfile')?.addEventListener('click', () => selectAccountTab('profile'));
    document.getElementById('accountTabSecurity')?.addEventListener('click', () => selectAccountTab('security'));
    document.getElementById('accountTabAdmin')?.addEventListener('click', () => selectAccountTab('admin'));

    document.getElementById('profileForm')?.addEventListener('submit', handleProfileSubmit);
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
                { onConflict: 'id' },
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
        currentUserProfile = { id: session.user.id, full_name: fullName, is_admin: !!currentUserProfile?.is_admin };
        profileCache.set(session.user.id, fullName);
        updateAccountAdminTabVisibility();
        showNotification('Account updated.');
    } catch (err) {
        errEl.textContent = err?.message || 'Update failed.';
    } finally {
        if (saveBtn) {
            saveBtn.disabled = false;
            saveBtn.textContent = originalText || 'Save profile';
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
    const redirEl = document.getElementById('adminInviteRedirect');
    const btn = document.getElementById('adminInviteSubmit');
    const email = (emailEl?.value || '').trim().toLowerCase();
    const redirectTo = (redirEl?.value || '').trim();
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
            redirectTo: redirectTo || undefined,
        });
        if (emailEl) emailEl.value = '';
        if (redirEl) redirEl.value = '';
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
        notification.classList.add('is-exiting');
        setTimeout(() => notification.remove(), 160);
    }, 3000);
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

