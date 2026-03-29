const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const db = require('../db.js')

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'calllog-db-'))

test.afterEach(() => {
    db.resetDbForTests()
})

test('init createEntry getEntries shape', async () => {
    const dir = tmpDir()
    await db.init(dir)
    const ts = '2026-03-15T14:30:00.000Z'
    const id = db.createEntry({
        name: 'Caller',
        phone: '555-0100',
        organization: 'Org',
        deviceName: 'Laptop',
        supportRequest: 'VPN',
        notes: 'note',
        callTime: ts
    })
    assert.ok(typeof id === 'number' && id > 0)
    const entries = db.getEntries()
    assert.equal(entries.length, 1)
    const e = entries[0]
    assert.equal(e.name, 'Caller')
    assert.equal(e.phone, '555-0100')
    assert.equal(e.organization, 'Org')
    assert.equal(e.deviceName, 'Laptop')
    assert.equal(e.supportRequest, 'VPN')
    assert.equal(e.notes, 'note')
    assert.equal(e.callTime, ts)
})

test('createEntry accepts legacy mobile field', async () => {
    const dir = tmpDir()
    await db.init(dir)
    const id = db.createEntry({
        name: 'A',
        mobile: '555-9999',
        organization: 'O',
        supportRequest: 'S',
        callTime: '2026-01-01T00:00:00.000Z'
    })
    assert.ok(id)
    const e = db.getEntries()[0]
    assert.equal(e.phone, '555-9999')
})

test('updateEntry and deleteEntry', async () => {
    const dir = tmpDir()
    await db.init(dir)
    const id = db.createEntry({
        name: 'N1',
        phone: '1',
        organization: 'O',
        supportRequest: 'S',
        callTime: '2026-01-01T00:00:00.000Z'
    })
    assert.equal(db.updateEntry(id, { name: 'N2' }), true)
    assert.equal(db.getEntries()[0].name, 'N2')
    assert.equal(db.deleteEntry(id), true)
    assert.equal(db.getEntries().length, 0)
})

test('clearAll', async () => {
    const dir = tmpDir()
    await db.init(dir)
    db.createEntry({
        name: 'A',
        phone: '1',
        organization: 'O',
        supportRequest: 'S',
        callTime: '2026-01-01T00:00:00.000Z'
    })
    db.clearAll()
    assert.equal(db.getEntries().length, 0)
})

test('importFromLocalStorage', async () => {
    const dir = tmpDir()
    await db.init(dir)
    db.importFromLocalStorage([
        {
            name: 'Imp',
            phone: '222',
            organization: 'Io',
            supportRequest: 'Is',
            notes: '',
            timestamp: '2026-02-01T12:00:00.000Z'
        }
    ])
    const entries = db.getEntries()
    assert.equal(entries.length, 1)
    assert.equal(entries[0].name, 'Imp')
})
