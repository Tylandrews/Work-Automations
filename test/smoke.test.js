const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const pkgPath = path.join(root, 'package.json')

const readPkg = () => JSON.parse(fs.readFileSync(pkgPath, 'utf8'))

const assertFile = (relativePath, message) => {
    const full = path.join(root, ...relativePath.split('/'))
    assert.ok(fs.existsSync(full), message || `missing: ${relativePath}`)
}

const nodeCheck = (relativePath) => {
    const full = path.join(root, ...relativePath.split('/'))
    return spawnSync(process.execPath, ['--check', full], {
        encoding: 'utf8',
        cwd: root
    })
}

const runValidateReleaseTag = (tag) => {
    const script = path.join(root, 'scripts', 'validate-release-version.js')
    return spawnSync(process.execPath, [script, tag], {
        encoding: 'utf8',
        cwd: root
    })
}

describe('package.json', () => {
    test('is a valid application manifest', () => {
        const pkg = readPkg()
        assert.equal(pkg.name, 'call-log')
        assert.match(String(pkg.version || ''), /^\d+\.\d+\.\d+/)
        assert.equal(pkg.main, 'main.js')
    })

    test('lists runtime deps needed for production app', () => {
        const pkg = readPkg()
        assert.ok(pkg.dependencies && pkg.dependencies['electron-updater'], 'electron-updater in dependencies')
        assert.ok(pkg.dependencies && pkg.dependencies.gsap, 'gsap in dependencies')
    })

    test('electron-builder block has id, product name, and GitHub publish', () => {
        const pkg = readPkg()
        const b = pkg.build
        assert.ok(b, 'build section exists')
        assert.equal(b.appId, 'com.calllog.app')
        assert.equal(b.productName, 'Call Log')
        assert.ok(Array.isArray(b.publish) && b.publish.length > 0, 'publish array')
        const gh = b.publish.find((p) => p && p.provider === 'github')
        assert.ok(gh, 'github publish provider')
        assert.ok(String(gh.owner || '').length > 0, 'publish.owner')
        assert.ok(String(gh.repo || '').length > 0, 'publish.repo')
    })
})

describe('repository layout', () => {
    test('core app files exist', () => {
        assertFile('main.js')
        assertFile('preload.js')
        assertFile('preload-notification.js')
        assertFile('index.html')
        assertFile('notification.html')
        assertFile('script.js')
        assertFile('CHANGELOG.md')
        assertFile('changelog-bundled.json')
    })

    test('build and release scripts exist', () => {
        assertFile('scripts/validate-config.js')
        assertFile('scripts/validate-release-version.js')
        assertFile('scripts/generate-release-changelog.js')
        assertFile('scripts/clean-dist.js')
        assertFile('scripts/build-icon.js')
    })

    test('CI workflows exist', () => {
        assertFile('.github/workflows/validate.yml')
        assertFile('.github/workflows/release-electron.yml')
    })

    test('supabase example config documents required keys', () => {
        const examplePath = path.join(root, 'supabaseConfig.example.js')
        assert.ok(fs.existsSync(examplePath))
        const text = fs.readFileSync(examplePath, 'utf8')
        assert.ok(text.includes('SUPABASE_URL'), 'SUPABASE_URL documented')
        assert.ok(text.includes('SUPABASE_ANON_KEY'), 'SUPABASE_ANON_KEY documented')
    })
})

describe('syntax (node --check)', () => {
    const checked = [
        'main.js',
        'preload.js',
        'preload-notification.js',
        'script.js',
        'scripts/build-icon.js',
        'scripts/clean-dist.js',
        'scripts/validate-config.js',
        'scripts/validate-release-version.js',
        'scripts/generate-release-changelog.js'
    ]

    for (const rel of checked) {
        test(`${rel} parses`, () => {
            const r = nodeCheck(rel)
            assert.equal(r.status, 0, r.stderr || r.stdout || `exit ${r.status}`)
        })
    }
})

describe('scripts/validate-release-version.js', () => {
    const expectedTag = () => `v${readPkg().version}`

    test('exits 0 when tag matches package.json version', () => {
        const r = runValidateReleaseTag(expectedTag())
        assert.equal(r.status, 0, r.stderr || r.stdout)
    })

    test('exits 1 when tag does not match package.json version', () => {
        const r = runValidateReleaseTag('v0.0.1')
        assert.equal(r.status, 1)
        assert.ok(
            (r.stderr || r.stdout || '').includes('does not match'),
            'expected mismatch message'
        )
    })

    test('exits 1 when tag argument is missing', () => {
        const script = path.join(root, 'scripts', 'validate-release-version.js')
        const r = spawnSync(process.execPath, [script], { encoding: 'utf8', cwd: root })
        assert.equal(r.status, 1)
    })

    test('exits 1 for invalid tag format', () => {
        const r = runValidateReleaseTag('v1')
        assert.equal(r.status, 1)
    })
})

describe('auto-update wiring', () => {
    test('main process references electron-updater', () => {
        const mainPath = path.join(root, 'main.js')
        const text = fs.readFileSync(mainPath, 'utf8')
        assert.ok(text.includes('electron-updater'), 'requires electron-updater')
        assert.ok(text.includes('autoUpdater') || text.includes('setupAutoUpdater'), 'uses autoUpdater')
    })
})
