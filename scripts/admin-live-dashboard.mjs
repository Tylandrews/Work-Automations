/**
 * Terminal live chart for admin call volume (last hour, UTC minute buckets).
 * Requires: npm install (blessed, blessed-contrib as devDependencies).
 *
 * Env:
 *   SUPABASE_URL          Project URL
 *   SUPABASE_ANON_KEY     Anon key (same as in supabaseConfig.js)
 *   CALL_LOG_ACCESS_TOKEN Current user JWT (admin). Use "Copy access token" in the app Live tab.
 */

import blessed from 'blessed'
import contrib from 'blessed-contrib'

const baseUrl = (process.env.SUPABASE_URL || '').replace(/\/+$/, '')
const anonKey = (process.env.SUPABASE_ANON_KEY || '').trim()
const accessToken = (process.env.CALL_LOG_ACCESS_TOKEN || '').trim()

if (!baseUrl || !anonKey || !accessToken) {
    console.error('Missing env: SUPABASE_URL, SUPABASE_ANON_KEY, and CALL_LOG_ACCESS_TOKEN are required.')
    process.exit(1)
}

const pollUrl = `${baseUrl}/functions/v1/admin-analytics`

const fetchLiveSeries = async () => {
    const res = await fetch(pollUrl, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${accessToken}`,
            apikey: anonKey,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ action: 'liveSeries', windowMinutes: 60 }),
    })
    const text = await res.text()
    let payload = null
    try {
        payload = text ? JSON.parse(text) : null
    } catch {
        throw new Error(`Invalid JSON: ${text.slice(0, 200)}`)
    }
    if (!res.ok) {
        const msg = payload?.detail || payload?.error || text || res.statusText
        throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg))
    }
    if (payload?.ok === false) {
        throw new Error(payload.error || payload.detail || 'Request failed')
    }
    return payload
}

const screen = blessed.screen({
    smartCSR: true,
    title: 'Call Log — live calls (admin)',
})

const grid = new contrib.grid({ rows: 12, cols: 12, screen })

const line = grid.set(0, 0, 12, 12, contrib.line, {
    label: ' Calls per minute (UTC) — admin-analytics ',
    style: {
        line: 'cyan',
        text: 'white',
        baseline: 'gray',
    },
    xLabelPadding: 2,
    xPadding: 4,
    showLegend: false,
    wholeNumbersOnly: true,
})

const status = blessed.box({
    bottom: 0,
    left: 0,
    width: '100%',
    height: 1,
    tags: true,
    style: { fg: 'gray', bg: 'black' },
    content: ' Loading… ',
})

screen.append(status)

const refresh = async () => {
    try {
        const payload = await fetchLiveSeries()
        const x = payload.labelsUtc || []
        const y = payload.counts || []
        line.setData([{ title: 'calls', x, y }])
        const gen = payload.generatedAt ? new Date(payload.generatedAt).toLocaleString() : ''
        status.setContent(` {gray-fg}Last OK: ${gen}  |  q / Ctrl+C exit{/} `)
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        status.setContent(` {red-fg}Error: ${msg.replace(/\{/g, '(').replace(/\}/g, ')')}{/} `)
    }
    screen.render()
}

await refresh()
const timer = setInterval(() => {
    refresh().catch(() => {})
}, 10_000)

const handleExit = () => {
    clearInterval(timer)
    process.exit(0)
}

screen.key(['escape', 'q', 'C-c'], handleExit)

screen.render()
