import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';

process.env.JWT_SECRET ??= randomBytes(48).toString('base64url');
const { app } = await import('../src/app.js');
const { pool } = await import('../src/db.js');
const { signToken } = await import('../src/security.js');

async function startServer() {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  return server;
}

async function closeServer(server) {
  server.closeAllConnections();
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

test('operational settings bind weekly schedule booleans as SQLite-compatible integers', async (t) => {
  const schoolUser = {
    id: 1,
    sekolah_id: 1,
    role_id: 1,
    classroom_id: null,
    username: 'admin',
    whatsapp_phone: null,
    auth_version: 0,
    display_name: 'Admin',
    role_key: 'admin-sekolah',
    role_name: 'Admin Sekolah',
    permissions: JSON.stringify(['settings.operational.edit']),
    role_sekolah_id: 1,
    school_code: '1525',
    school_name: 'SMK PGRI Cikoneng',
    timezone: 'Asia/Jakarta',
    subscription_status: 'aktif',
    trial_ends_at: null,
    subscription_expires_at: null,
    subscription_expired: 0,
  };
  const statements = [];
  const poolStatements = [];
  const connection = {
    async beginTransaction() {},
    async execute(sql, parameters = []) {
      statements.push({ sql, parameters });
      return [{ affectedRows: 1 }];
    },
    async commit() {},
    async rollback() {},
    release() {},
  };

  t.mock.method(pool, 'execute', async (sql, parameters = []) => {
    if (sql.includes('FROM users u') && sql.includes('JOIN schools s')) return [[schoolUser]];
    if (sql.includes('FROM school_whatsapp_gateway_config')) return [[]];
    if (sql.includes('FROM school_google_sheets_config')) return [[]];
    if (sql.includes('FROM school_google_sheets_sync_state')) return [[]];
    poolStatements.push({ sql, parameters });
    if (sql.includes('INSERT INTO school_whatsapp_gateway_config') ||
        sql.includes('INSERT INTO school_google_sheets_config') ||
        sql.includes('INSERT INTO school_google_sheets_sync_state')) {
      return [{ affectedRows: 1 }];
    }
    throw new Error(`Unexpected pool query: ${sql}`);
  });
  t.mock.method(pool, 'getConnection', async () => connection);

  const server = await startServer();
  const token = signToken({
    kind: 'school_user',
    sub: '1',
    schoolId: '1',
    schoolCode: '1525',
    authVersion: 0,
  });
  try {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/api/school/settings`,
      {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          timezone: 'Asia/Jakarta',
          check_in_deadline: '08:00:00',
          lateness_tolerance_minutes: 5,
          check_out_start: '15:00:00',
          weekly_schedules: Array.from({ length: 7 }, (_value, weekday) => ({
            weekday,
            is_working_day: weekday >= 1 && weekday <= 5,
          })),
        }),
      },
    );

    assert.equal(response.status, 200);
    const weeklyScheduleWrites = statements.filter(({ sql }) =>
      sql.includes('INSERT INTO weekly_operational_schedules'),
    );
    assert.equal(weeklyScheduleWrites.length, 7);
    for (const { parameters } of weeklyScheduleWrites) {
      assert.equal(typeof parameters[2], 'number');
    }

    const whatsappResponse = await fetch(
      `http://127.0.0.1:${server.address().port}/api/school/settings/whatsapp-gateway`,
      {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          endpoint_url: 'https://example.com/whatsapp',
          is_enabled: false,
          token: '',
        }),
      },
    );
    assert.equal(whatsappResponse.status, 200);
    const whatsappWrite = poolStatements.find(({ sql }) =>
      sql.includes('INSERT INTO school_whatsapp_gateway_config'),
    );
    assert.equal(typeof whatsappWrite.parameters[5], 'number');

    const sheetsResponse = await fetch(
      `http://127.0.0.1:${server.address().port}/api/school/settings/google-sheets`,
      {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          web_app_url: 'https://script.google.com/macros/s/test-deployment/exec',
          shared_secret: 'a-valid-test-shared-secret-value',
          is_enabled: false,
        }),
      },
    );
    assert.equal(sheetsResponse.status, 200);
    const sheetsWrite = poolStatements.find(({ sql }) =>
      sql.includes('INSERT INTO school_google_sheets_config'),
    );
    const syncStateWrite = poolStatements.find(({ sql }) =>
      sql.includes('INSERT INTO school_google_sheets_sync_state'),
    );
    assert.equal(typeof sheetsWrite.parameters[5], 'number');
    assert.ok(syncStateWrite.parameters.slice(1).every((value) => typeof value === 'number'));
  } finally {
    await closeServer(server);
  }
});