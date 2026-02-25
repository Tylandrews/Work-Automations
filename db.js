const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

let db = null;
let dbPath = null;
let SQL = null;

function getDbPath(userDataPath) {
    return path.join(userDataPath, 'calllogger.db');
}

function save() {
    if (!db || !dbPath) return;
    try {
        const data = db.export();
        const buffer = Buffer.from(data);
        fs.writeFileSync(dbPath, buffer);
    } catch (err) {
        console.error('Database save error:', err.message || err);
    }
}

function execToRows(sql, params) {
    const results = params ? db.exec(sql, params) : db.exec(sql);
    if (!results.length || !results[0].values.length) return [];
    const { columns, values } = results[0];
    return values.map((row) => Object.fromEntries(columns.map((c, i) => [c, row[i]])));
}

function execGetOne(sql, params) {
    const rows = execToRows(sql, params);
    return rows[0] || null;
}

async function init(userDataPath) {
    if (db) return db;
    try {
        SQL = SQL || (await initSqlJs());
        dbPath = getDbPath(userDataPath);
        const dir = path.dirname(dbPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        let buffer = null;
        if (fs.existsSync(dbPath)) {
            buffer = fs.readFileSync(dbPath);
        }
        db = new SQL.Database(buffer);

        db.run(`
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
            )
        `);
        db.run(`CREATE INDEX IF NOT EXISTS idx_calls_call_time ON calls(call_time)`);

        // Migrate: rename mobile -> phone
        try {
            const cols = execToRows('PRAGMA table_info(calls)');
            if (cols.some((c) => c.name === 'mobile')) {
                db.run('ALTER TABLE calls RENAME COLUMN mobile TO phone');
            }
        } catch (_) {}

        // Migrate: add device_name if missing
        try {
            const cols = execToRows('PRAGMA table_info(calls)');
            if (!cols.some((c) => c.name === 'device_name')) {
                db.run("ALTER TABLE calls ADD COLUMN device_name TEXT DEFAULT ''");
            }
        } catch (_) {}

        save();
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
    const rows = execToRows('SELECT * FROM calls ORDER BY call_time DESC');
    return rows.map(rowToEntry);
}

function createEntry(entry) {
    if (!db) return null;
    const now = new Date().toISOString();
    const callTime = entry.timestamp || entry.callTime || now;
    const phone = entry.phone != null ? entry.phone : entry.mobile;
    db.run(
        `INSERT INTO calls (name, phone, organization, device_name, support_request, notes, call_time, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            entry.name || '',
            phone || '',
            entry.organization || '',
            entry.deviceName || '',
            entry.supportRequest || '',
            entry.notes || '',
            callTime,
            now,
            now
        ]
    );
    const res = execGetOne('SELECT last_insert_rowid() as id');
    const id = res ? Number(res.id) : null;
    save();
    return id;
}

function updateEntry(id, fields) {
    if (!db) return false;
    const row = execGetOne('SELECT * FROM calls WHERE id = $id', { $id: id });
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

    db.run(
        `UPDATE calls SET name = ?, phone = ?, organization = ?, device_name = ?, support_request = ?, notes = ?, call_time = ?, updated_at = ?
         WHERE id = ?`,
        [name, phone, organization, device_name || '', support_request, notes || '', call_time, updated_at, id]
    );
    save();
    return true;
}

function deleteEntry(id) {
    if (!db) return false;
    db.run('DELETE FROM calls WHERE id = ?', [id]);
    const res = execGetOne('SELECT changes() as n');
    const n = res ? Number(res.n) : 0;
    save();
    return n > 0;
}

function clearAll() {
    if (!db) return;
    db.run('DELETE FROM calls');
    save();
}

function importFromLocalStorage(entries) {
    if (!db || !Array.isArray(entries)) return;
    const now = new Date().toISOString();
    for (const e of entries) {
        const ts = e.timestamp || now;
        const phone = (e.phone != null ? e.phone : e.mobile) || '';
        db.run(
            `INSERT INTO calls (name, phone, organization, device_name, support_request, notes, call_time, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                e.name || '',
                phone,
                e.organization || '',
                e.deviceName || '',
                e.supportRequest || '',
                e.notes || '',
                ts,
                ts,
                ts
            ]
        );
    }
    save();
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
