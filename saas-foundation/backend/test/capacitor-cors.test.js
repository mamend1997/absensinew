import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';

process.env.JWT_SECRET ??= randomBytes(48).toString('base64url');
process.env.CORS_ORIGINS = 'https://portal.example';
const { app } = await import('../src/app.js');

test('CORS allows the Capacitor origin while rejecting other unconfigured origins', async (t) => {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));

  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/api/health`;
  const allowed = await fetch(url, {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://localhost',
      'Access-Control-Request-Method': 'POST',
    },
  });
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://localhost');

  const rejected = await fetch(url, {
    method: 'OPTIONS',
    headers: { Origin: 'https://unconfigured.example' },
  });
  assert.equal(rejected.status, 403);
});
