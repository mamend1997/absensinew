import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createSqlitePool, translateMysqlSql } from '../src/sqlite-db.js';
import { ensureRuntimeMigrations } from '../src/config/runtime-migrations.js';

process.env.JWT_SECRET ??= randomBytes(48).toString('base64url');
const { createPlatformDatabaseBackup, restoreDatabaseBackup } =
  await import('../src/core/database-backup.js');

function createTestPool(t) {
  const directory = mkdtempSync(join(tmpdir(), 'absensi-saas-sqlite-'));
  const pool = createSqlitePool(join(directory, 'test.sqlite'));
  t.after(async () => {
    await pool.end();
    rmSync(directory, { recursive: true, force: true });
  });
  return pool;
}

test('SQLite adapter initializes the SaaS schema without overwriting existing rows', async (t) => {
  const pool = createTestPool(t);
  await ensureRuntimeMigrations(pool);
  await pool.execute(
    `UPDATE platform_branding SET application_name = 'Preserved name' WHERE id = 1`,
  );
  await pool.initializeSchema();

  const tables = await pool.listTables();
  const [branding] = await pool.execute(
    'SELECT application_name FROM platform_branding WHERE id = 1',
  );
  const [backupSettings] = await pool.execute(
    'SELECT id FROM platform_backup_settings WHERE id = 1',
  );
  assert.ok(tables.some(({ table_name: name }) => name === 'schools'));
  assert.ok(tables.some(({ table_name: name }) => name === 'attendance_logs'));
  assert.equal(branding[0].application_name, 'Preserved name');
  assert.equal(backupSettings.length, 1);
});

test('SQLite schema validation rejects an existing table with missing columns', async (t) => {
  const pool = createTestPool(t);
  await pool.execute('CREATE TABLE platform_branding (id INTEGER PRIMARY KEY)');
  await assert.rejects(
    pool.initializeSchema(),
    /platform_branding kehilangan kolom wajib/,
  );
});

test('SQLite adapter supports nested transactions, rollback, and MySQL upserts', async (t) => {
  const pool = createTestPool(t);
  await pool.execute('CREATE TABLE sample (id INTEGER PRIMARY KEY, name TEXT UNIQUE)');

  await assert.rejects(pool.transaction(async (connection) => {
    await connection.execute('INSERT INTO sample (id, name) VALUES (?, ?)', [1, 'rolled back']);
    await pool.transaction(async (nested) => {
      await nested.execute('INSERT INTO sample (id, name) VALUES (?, ?)', [2, 'nested']);
    });
    throw new Error('force rollback');
  }), /force rollback/);

  await pool.execute('INSERT INTO sample (id, name) VALUES (?, ?)', [1, 'initial']);
  await pool.execute('INSERT IGNORE INTO sample (id, name) VALUES (?, ?)', [1, 'ignored']);
  await pool.execute(
    `INSERT INTO sample (id, name) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE name = VALUES(name)`,
    [1, 'updated'],
  );
  const [rows] = await pool.execute('SELECT id, name FROM sample ORDER BY id');
  assert.deepEqual(rows.map((row) => ({ ...row })), [{ id: 1, name: 'updated' }]);
  assert.match(
    translateMysqlSql('SELECT * FROM sample FOR UPDATE'),
    /SELECT \* FROM sample\s*$/i,
  );
});

test('SQLite adapter treats MySQL advisory locks as parameterless no-ops', async (t) => {
  const pool = createTestPool(t);
  const [acquired] = await pool.execute(
    'SELECT GET_LOCK(?, 0) AS acquired',
    ['google-sheets-4'],
  );
  const [released] = await pool.execute(
    'SELECT RELEASE_LOCK(?)',
    ['google-sheets-4'],
  );

  assert.equal(acquired[0].acquired, 1);
  assert.equal(released.length, 1);
});

test('SQLite adapter reports MySQL-compatible check and delete constraint errors', async (t) => {
  const pool = createTestPool(t);
  await pool.execute('CREATE TABLE parents (id INTEGER PRIMARY KEY)');
  await pool.execute(
    'CREATE TABLE children (id INTEGER PRIMARY KEY CHECK (id > 0), parent_id INTEGER REFERENCES parents(id))',
  );
  await assert.rejects(
    pool.execute('INSERT INTO children (id) VALUES (?)', [-1]),
    { code: 'ER_CHECK_CONSTRAINT_VIOLATED' },
  );
  await pool.execute('INSERT INTO parents (id) VALUES (?)', [1]);
  await pool.execute('INSERT INTO children (id, parent_id) VALUES (?, ?)', [1, 1]);
  await assert.rejects(
    pool.execute('DELETE FROM parents WHERE id = ?', [1]),
    { code: 'ER_ROW_IS_REFERENCED_2' },
  );
});

test('SQLite platform backup restores rows and binary values', async (t) => {
  const pool = createTestPool(t);
  await pool.initializeSchema();
  const originalLogo = Buffer.from([0, 1, 2, 255]);
  await pool.execute(
    'UPDATE platform_branding SET logo_mime_type = ?, logo_data = ? WHERE id = 1',
    ['image/png', originalLogo],
  );
  const backup = await createPlatformDatabaseBackup(pool);

  const connection = await pool.getConnection();
  try {
    await connection.execute(
      'UPDATE platform_branding SET logo_mime_type = ?, logo_data = ? WHERE id = 1',
      ['image/jpeg', Buffer.from([9])],
    );
    const restored = await restoreDatabaseBackup(
      connection,
      JSON.stringify(backup),
      'platform',
    );
    assert.ok(restored.restored_tables > 0);
  } finally {
    connection.release();
  }

  const [branding] = await pool.execute(
    'SELECT logo_mime_type, logo_data FROM platform_branding WHERE id = 1',
  );
  assert.equal(branding[0].logo_mime_type, 'image/png');
  assert.deepEqual(Buffer.from(branding[0].logo_data), originalLogo);
});

test('SQLite adapter translates MySQL date functions and serializes connections', async (t) => {
  const pool = createTestPool(t);
  const [rows] = await pool.execute(
    `SELECT DATE_ADD(?, INTERVAL 1 MONTH) AS added,
            DAYOFWEEK(?) AS weekday,
            TIME_FORMAT(?, '%H:%i:%s') AS formatted,
            UNIX_TIMESTAMP(?) AS epoch`,
    [
      '2024-01-31 10:00:00',
      '2024-11-24',
      '9:05:07',
      '2024-11-24 00:00:00',
    ],
  );
  assert.equal(rows[0].added, '2024-02-29 10:00:00');
  assert.equal(rows[0].weekday, 1);
  assert.equal(rows[0].formatted, '09:05:07');
  assert.equal(rows[0].epoch, 1732406400);

  const connection = await pool.getConnection();
  let queryCompleted = false;
  const pendingQuery = pool.execute('SELECT 1').then(() => { queryCompleted = true; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(queryCompleted, false);
  connection.release();
  await pendingQuery;
  assert.equal(queryCompleted, true);
});
