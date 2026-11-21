import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';

process.env.JWT_SECRET ??= randomBytes(48).toString('base64url');
const { app } = await import('../src/app.js');
const { pool } = await import('../src/db.js');
const { hashPassword, signToken } = await import('../src/security.js');

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

function adminToken(authVersion = 0) {
  return signToken({ kind: 'super_admin', sub: '1', authVersion });
}

test('changing a Super Admin password verifies the old password and invalidates the session', async (t) => {
  const oldHash = await hashPassword('CurrentPassword1!');
  let authVersion = 0;
  let updateCount = 0;
  let auditInsertCount = 0;
  t.mock.method(pool, 'execute', async (sql) => {
    if (sql.includes('SELECT id, username, display_name, whatsapp_phone, auth_version')) {
      return [[{
        id: 1,
        username: 'operator',
        display_name: 'Operator',
        whatsapp_phone: null,
        auth_version: authVersion,
      }]];
    }
    if (sql.includes('SELECT password_hash FROM super_admins')) return [[{ password_hash: oldHash }]];
    if (sql.includes('UPDATE super_admins') && sql.includes('auth_version = auth_version + 1')) {
      updateCount += 1;
      authVersion += 1;
      return [{ affectedRows: 1 }];
    }
    if (sql.includes('INSERT INTO platform_audit_logs')) {
      auditInsertCount += 1;
      return [{ affectedRows: 1 }];
    }
    throw new Error(`Unexpected SQL in test: ${sql}`);
  });

  const server = await startServer();
  const url = `http://127.0.0.1:${server.address().port}/api/super-admin/auth/change-password`;
  try {
    const invalidResponse = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${adminToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        current_password: 'WrongPassword1!',
        new_password: 'UpdatedPassword2!',
      }),
    });
    assert.equal(invalidResponse.status, 401);
    assert.equal(updateCount, 0);

    const response = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${adminToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        current_password: 'CurrentPassword1!',
        new_password: 'UpdatedPassword2!',
      }),
    });
    assert.equal(response.status, 200);
    assert.match((await response.json()).message, /Silakan masuk kembali/);
    assert.equal(updateCount, 1);
    assert.equal(auditInsertCount, 2);

    const oldSessionResponse = await fetch(
      `http://127.0.0.1:${server.address().port}/api/super-admin/audit-logs`,
      { headers: { authorization: `Bearer ${adminToken()}` } },
    );
    assert.equal(oldSessionResponse.status, 401);
  } finally {
    await closeServer(server);
  }
});

test('Super Admin audit log supports a bounded cursor page', async (t) => {
  let queryCount = 0;
  t.mock.method(pool, 'execute', async (sql) => {
    if (sql.includes('SELECT id, username, display_name, whatsapp_phone, auth_version')) {
      return [[{
        id: 1,
        username: 'operator',
        display_name: 'Operator',
        whatsapp_phone: null,
        auth_version: 0,
      }]];
    }
    if (sql.includes('FROM platform_audit_logs')) {
      queryCount += 1;
      return queryCount === 1
        ? [[{
          id: '42',
          username: 'operator',
          method: 'PUT',
          route: '/api/super-admin/settings/application-name',
          status_code: 200,
          ip_address: '127.0.0.1',
          user_agent: 'test',
          created_at: '2026-11-21 10:00:00',
        }]]
        : [[]];
    }
    throw new Error(`Unexpected SQL in test: ${sql}`);
  });

  const server = await startServer();
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/super-admin/audit-logs`;
  try {
    const first = await fetch(`${baseUrl}?limit=1`, {
      headers: { authorization: `Bearer ${adminToken()}` },
    });
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), {
      logs: [{
        id: '42',
        username: 'operator',
        method: 'PUT',
        route: '/api/super-admin/settings/application-name',
        status_code: 200,
        ip_address: '127.0.0.1',
        user_agent: 'test',
        created_at: '2026-11-21 10:00:00',
      }],
      next_before_id: '42',
    });

    const next = await fetch(`${baseUrl}?limit=1&before_id=42`, {
      headers: { authorization: `Bearer ${adminToken()}` },
    });
    assert.equal(next.status, 200);
    assert.deepEqual(await next.json(), { logs: [], next_before_id: null });
  } finally {
    await closeServer(server);
  }
});
