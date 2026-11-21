import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';

process.env.JWT_SECRET ??= randomBytes(48).toString('base64url');
const {
  createPlatformDatabaseBackup,
  createSchoolDatabaseBackup,
  restoreDatabaseBackup,
} = await import('../src/core/database-backup.js');

function fakeConnection(columns, rowsByTable = {}) {
  const statements = [];
  return {
    statements,
    async execute(sql, params = []) {
      statements.push({ sql, params });
      if (sql.includes('information_schema.COLUMNS')) return [columns];
      return [[]];
    },
    async query(sql, params = []) {
      statements.push({ sql, params });
      const table = sql.match(/FROM `([^`]+)`/)?.[1];
      return [rowsByTable[table] ?? []];
    },
    async beginTransaction() { statements.push({ sql: 'BEGIN' }); },
    async commit() { statements.push({ sql: 'COMMIT' }); },
    async rollback() { statements.push({ sql: 'ROLLBACK' }); },
  };
}

test('platform JSON backup is signed and restores binary values', async () => {
  const columns = [
    { table_name: 'sample', column_name: 'id', data_type: 'int', ordinal_position: 1 },
    { table_name: 'sample', column_name: 'secret', data_type: 'varbinary', ordinal_position: 2 },
  ];
  const source = fakeConnection(columns, { sample: [{ id: 1, secret: Buffer.from([1, 2, 3]) }] });
  const backup = await createPlatformDatabaseBackup(source);
  const target = fakeConnection(columns);
  const result = await restoreDatabaseBackup(target, Buffer.from(JSON.stringify(backup)), 'platform');
  assert.equal(result.restored_tables, 1);
  const insert = target.statements.find(({ sql }) => sql.startsWith('INSERT INTO `sample`'));
  assert.deepEqual(insert.params[1], Buffer.from([1, 2, 3]));
  assert.ok(target.statements.some(({ sql }) => sql === 'COMMIT'));
});

test('tampered backups are rejected before database writes', async () => {
  const columns = [{ table_name: 'sample', column_name: 'id', data_type: 'int', ordinal_position: 1 }];
  const source = fakeConnection(columns, { sample: [{ id: 1 }] });
  const backup = await createPlatformDatabaseBackup(source);
  backup.tables.sample.rows[0][0] = 2;
  const target = fakeConnection(columns);
  await assert.rejects(
    restoreDatabaseBackup(target, JSON.stringify(backup), 'platform'),
    { code: 'INVALID_BACKUP' },
  );
  assert.equal(target.statements.some(({ sql }) => sql === 'BEGIN'), false);
});

test('school backups cannot be restored into a different school', async () => {
  const columns = [
    { table_name: 'participants', column_name: 'sekolah_id', data_type: 'bigint', ordinal_position: 1 },
    { table_name: 'participants', column_name: 'id', data_type: 'bigint', ordinal_position: 2 },
  ];
  const source = fakeConnection(columns, { participants: [{ sekolah_id: 7, id: 1 }] });
  const backup = await createSchoolDatabaseBackup(source, '7');
  const schoolSelect = source.statements.find(({ sql }) => sql.startsWith('SELECT * FROM `participants`'));
  assert.equal(schoolSelect.sql, 'SELECT * FROM `participants` WHERE sekolah_id = ?');
  assert.deepEqual(schoolSelect.params, ['7']);
  const target = fakeConnection(columns);
  await assert.rejects(
    restoreDatabaseBackup(target, JSON.stringify(backup), 'school', '8'),
    { code: 'INVALID_BACKUP' },
  );
  assert.equal(target.statements.some(({ sql }) => sql === 'BEGIN'), false);
});

test('school restore rejects signed data containing another tenant row', async () => {
  const columns = [
    { table_name: 'participants', column_name: 'sekolah_id', data_type: 'bigint', ordinal_position: 1 },
    { table_name: 'participants', column_name: 'id', data_type: 'bigint', ordinal_position: 2 },
  ];
  const source = fakeConnection(columns, { participants: [{ sekolah_id: 8, id: 1 }] });
  const backup = await createSchoolDatabaseBackup(source, '7');
  const target = fakeConnection(columns);
  await assert.rejects(
    restoreDatabaseBackup(target, JSON.stringify(backup), 'school', '7'),
    { code: 'INVALID_BACKUP_TENANT' },
  );
  assert.equal(target.statements.some(({ sql }) => sql === 'BEGIN'), false);
});
