import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';

process.env.JWT_SECRET ??= randomBytes(48).toString('base64url');
const { validateOtpRateLimitSettings } = await import('../src/core/otp-rate-limit.js');

test('OTP rate-limit settings accept the configured default and supported bounds', () => {
  assert.deepEqual(validateOtpRateLimitSettings({
    max_requests_per_phone: 10,
    window_minutes: 30,
  }), {
    max_requests_per_phone: 10,
    window_minutes: 30,
  });
  assert.deepEqual(validateOtpRateLimitSettings({
    max_requests_per_phone: 50,
    window_minutes: 1440,
  }), {
    max_requests_per_phone: 50,
    window_minutes: 1440,
  });
});

test('OTP rate-limit settings reject values outside supported bounds', () => {
  for (const settings of [
    { max_requests_per_phone: 0, window_minutes: 30 },
    { max_requests_per_phone: 51, window_minutes: 30 },
    { max_requests_per_phone: 10, window_minutes: 0 },
    { max_requests_per_phone: 10, window_minutes: 1441 },
  ]) {
    assert.throws(() => validateOtpRateLimitSettings(settings), { statusCode: 400 });
  }
});
