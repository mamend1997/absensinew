import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';

process.env.JWT_SECRET ??= randomBytes(48).toString('base64url');
const { config } = await import('../src/config.js');
const {
  createDeviceApiKey,
  hashDeviceApiKey,
  signToken,
  verifyToken,
  hashPassword,
  verifyPassword,
} = await import('../src/security.js');

function secondsForDuration(value) {
  const [, amount, unit] = /^([1-9]\d*)(s|m|h|d)$/.exec(value) ?? [];
  return Number(amount) * ({ s: 1, m: 60, h: 3600, d: 86400 })[unit];
}

test('signed bearer tokens reject tampering and expired claims', () => {
  const token = signToken({ kind: 'school_user', sub: '1', schoolId: '2', schoolCode: '0042' });
  assert.equal(verifyToken(token).schoolCode, '0042');
  const replacementCharacter = token.endsWith('x') ? 'y' : 'x';
  assert.throws(() => verifyToken(`${token.slice(0, -1)}${replacementCharacter}`));
  assert.throws(() => verifyToken(`v1.${Buffer.from(JSON.stringify({ exp: 1 })).toString('base64url')}.invalid`));
});

test('school session tokens can persist for 30 days without extending admin token duration', () => {
  const now = Math.floor(Date.now() / 1000);
  const schoolToken = verifyToken(signToken({ kind: 'school_user' }, config.schoolJwtTtl));
  const adminToken = verifyToken(signToken({ kind: 'super_admin' }));
  assert.equal(schoolToken.exp - schoolToken.iat, secondsForDuration(config.schoolJwtTtl));
  assert.equal(adminToken.exp - adminToken.iat, secondsForDuration(config.jwtTtl));
  if (!process.env.SCHOOL_JWT_TTL) assert.equal(config.schoolJwtTtl, '30d');
  assert.ok(Math.abs(schoolToken.iat - now) <= 1);
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
