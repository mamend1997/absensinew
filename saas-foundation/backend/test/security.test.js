import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';

process.env.JWT_SECRET ??= randomBytes(48).toString('base64url');
const {
  createDeviceApiKey,
  hashDeviceApiKey,
  signToken,
  verifyToken,
  hashPassword,
  verifyPassword,
} = await import('../src/security.js');

test('signed bearer tokens reject tampering and expired claims', () => {
  const token = signToken({ kind: 'school_user', sub: '1', schoolId: '2', schoolCode: '0042' });
  assert.equal(verifyToken(token).schoolCode, '0042');
  assert.throws(() => verifyToken(`${token.slice(0, -1)}x`));
  assert.throws(() => verifyToken(`v1.${Buffer.from(JSON.stringify({ exp: 1 })).toString('base64url')}.invalid`));
});

test('device keys are high entropy and only their hash is persisted', () => {
  const first = createDeviceApiKey();
  const second = createDeviceApiKey();
  assert.match(first.apiKey, /^saas_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first.apiKey, second.apiKey);
  assert.equal(first.hash, hashDeviceApiKey(first.apiKey));
  assert.notEqual(first.hash, first.apiKey);
});

test('password verification uses bcrypt hashes', async () => {
  const hash = await hashPassword('a distinct test-only password');
  assert.equal(await verifyPassword('a distinct test-only password', hash), true);
  assert.equal(await verifyPassword('incorrect', hash), false);
});
