import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';

process.env.JWT_SECRET ??= randomBytes(48).toString('base64url');
const { pool } = await import('../src/db.js');
const { requireAnyPermission, requireDevice } = await import('../src/middleware/auth.js');

test('expired school users are rejected from permission-protected operations with renewal guidance', () => {
  let receivedError;
  requireAnyPermission('attendance.view')({
    schoolUser: {
      subscription_expired: true,
      role_sekolah_id: '17',
      sekolah_id: '17',
      permissions: ['attendance.view'],
    },
  }, {}, (error) => { receivedError = error; });

  assert.equal(receivedError.statusCode, 402);
  assert.equal(receivedError.code, 'SUBSCRIPTION_EXPIRED');
});

test('expired scanner devices are rejected with the subscription-expired contract', async (t) => {
  t.mock.method(pool, 'execute', async () => [[{
    id: 4,
    sekolah_id: 17,
    device_name: 'Gate scanner',
    subscription_expired: 1,
  }]]);
  let receivedError;

  await requireDevice({
    get(name) {
      return name === 'x-device-key' ? `saas_${'a'.repeat(43)}` : undefined;
    },
  }, {}, (error) => { receivedError = error; });

  assert.equal(receivedError.statusCode, 402);
  assert.equal(receivedError.code, 'SUBSCRIPTION_EXPIRED');
});
