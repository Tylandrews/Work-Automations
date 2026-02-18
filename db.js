const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

let db = null;

function getDbPath(userDataPath) {
    const dir = path.join(userDataPath, 'calllogger.db');
    return dir;
}

function init(userDataPath) {
    if (db) return db;
    try {
        const dbPath = getDbPath(userDataPath);
        const dir = path.dirname(dbPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        db = new Database(dbPath);

        db.exec(`
            CREATE TABLE IF NOT EXISTS calls (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                phone TEXT NOT NULL,
                organization TEXT NOT NULL,
                device_name TEXT DEFAULT '',
                support_request TEXT NOT NULL,
                notes TEXT DEFAULT '',
                call_time TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_calls_call_time ON calls(call_time);
        `);

        // Migrate existing DBs: rename mobile -> phone (SQLite 3.25.0+)
        try {
            const cols = db.prepare('PRAGMA table_info(calls)').all();
            if (cols.some(c => c.name === 'mobile')) {
                db.exec('ALTER TABLE calls RENAME COLUMN mobile TO phone');
            }
        } catch (_) {}

        // Migrate: add device_name column if missing
        try {
            const cols = db.prepare('PRAGMA table_info(calls)').all();
            if (!cols.some(c => c.name === 'device_name')) {
                db.exec('ALTER TABLE calls ADD COLUMN device_name TEXT DEFAULT \'\'');
            }
        } catch (_) {}

        return db;
    } catch (err) {
        console.error('Database init error:', err.message || err);
        db = null;
        return null;
    }
}

function rowToEntry(row) {
    const phone = row.phone != null ? row.phone : row.mobile;
    return {
        id: row.id,
        name: row.name,
        phone: phone || '',
        organization: row.organization,
        deviceName: (row.device_name != null ? row.device_name : '') || '',
        supportRequest: row.support_request,
        notes: row.notes || '',
        callTime: row.call_time,
        timestamp: row.call_time,
        createdAt: row.created_at,
        updatedAt: row.updated_at
    };
}

function getEntries() {
    if (!db) return [];
    const rows = db.prepare('SELECT * FROM calls ORDER BY call_time DESC').all();
    return rows.map(rowToEntry);
}

function createEntry(entry) {
    if (!db) return null;
    const now = new Date().toISOString();
    const callTime = entry.timestamp || entry.callTime || now;
    const stmt = db.prepare(`
        INSERT INTO calls (name, phone, organization, device_name, support_request, notes, call_time, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const phone = entry.phone != null ? entry.phone : entry.mobile;
    const result = stmt.run(
        entry.name || '',
        phone || '',
        entry.organization || '',
        entry.deviceName || '',
        entry.supportRequest || '',
        entry.notes || '',
        callTime,
        now,
        now
    );
    return Number(result.lastInsertRowid);
}

function updateEntry(id, fields) {
    if (!db) return false;
    const row = db.prepare('SELECT * FROM calls WHERE id = ?').get(id);
    if (!row) return false;

    const name = fields.name !== undefined ? fields.name : row.name;
    const rowPhone = row.phone != null ? row.phone : row.mobile;
    const phone = fields.phone !== undefined ? fields.phone : rowPhone;
    const organization = fields.organization !== undefined ? fields.organization : row.organization;
    const device_name = fields.deviceName !== undefined ? fields.deviceName : (row.device_name || '');
    const support_request = fields.supportRequest !== undefined ? fields.supportRequest : row.support_request;
    const notes = fields.notes !== undefined ? fields.notes : row.notes;
    const call_time = fields.callTime !== undefined ? fields.callTime : row.call_time;
    const updated_at = new Date().toISOString();

    const stmt = db.prepare(`
        UPDATE calls SET name = ?, phone = ?, organization = ?, device_name = ?, support_request = ?, notes = ?, call_time = ?, updated_at = ?
        WHERE id = ?
    `);
    stmt.run(name, phone, organization, device_name || '', support_request, notes || '', call_time, updated_at, id);
    return true;
}

function deleteEntry(id) {
    if (!db) return false;
    const result = db.prepare('DELETE FROM calls WHERE id = ?').run(id);
    return result.changes > 0;
}

function clearAll() {
    if (!db) return;
    db.prepare('DELETE FROM calls').run();
}

function importFromLocalStorage(entries) {
    if (!db || !Array.isArray(entries)) return;
    const now = new Date().toISOString();
    const stmt = db.prepare(`
        INSERT INTO calls (name, phone, organization, device_name, support_request, notes, call_time, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const e of entries) {
        const ts = e.timestamp || now;
        const phone = (e.phone != null ? e.phone : e.mobile) || '';
        stmt.run(
            e.name || '',
            phone,
            e.organization || '',
            e.deviceName || '',
            e.supportRequest || '',
            e.notes || '',
            ts,
            ts,
            ts
        );
    }
}

module.exports = {
    init,
    getEntries,
    createEntry,
    updateEntry,
    deleteEntry,
    clearAll,
    importFromLocalStorage
};
