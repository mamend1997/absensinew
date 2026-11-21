import assert from 'node:assert/strict';
import test from 'node:test';
import { ensureRuntimeMigrations } from '../src/config/runtime-migrations.js';

function migrationDatabase(dialect) {
  let notificationsTableExists = false;
  const statements = [];
  return {
    dialect,
    statements,
    async hasColumn(table, column) {
      return table !== 'attendance_notifications' ||
        column === 'id' && notificationsTableExists;
    },
    async query(sql) {
      statements.push(sql);
      if (sql.includes('CREATE TABLE IF NOT EXISTS attendance_notifications')) {
        notificationsTableExists = true;
      }
    },
    async ensureActivityLogSchema() {},
  };
}

for (const dialect of ['mysql', 'sqlite']) {
  test(`runtime migration creates the missing attendance notification table on ${dialect}`, async () => {
    const database = migrationDatabase(dialect);
    await ensureRuntimeMigrations(database);
    await ensureRuntimeMigrations(database);

    const createStatements = database.statements.filter((sql) =>
      sql.includes('CREATE TABLE IF NOT EXISTS attendance_notifications'),
    );
    assert.equal(createStatements.length, 1);
    if (dialect === 'sqlite') {
      assert.match(createStatements[0], /UNIQUE \(id_unik, recipient_phone, event_type\)/);
      assert.ok(database.statements.some((sql) =>
        sql.includes('CREATE INDEX IF NOT EXISTS idx_attendance_notification_pending'),
      ));
    } else {
      assert.match(createStatements[0], /uq_attendance_notification_once/);
      assert.match(createStatements[0], /ENGINE=InnoDB/);
    }
  });
}
