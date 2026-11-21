import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';

process.env.JWT_SECRET ??= randomBytes(48).toString('base64url');
process.env.PUBLIC_WEB_URL ??= 'https://web.example';
process.env.PUBLIC_API_URL ??= 'https://api.example';
const { validatePaymentGatewayUpdate } = await import('../src/core/platform-payment-settings.js');

const current = {
  credentials: {
    xendit_secret_key: 'xendit-secret',
    xendit_callback_token: 'xendit-callback',
    duitku_merchant_code: 'merchant-123',
    duitku_api_key: 'duitku-key',
  },
  xendit: { enabled: true },
  duitku: { enabled: true, environment: 'production' },
};

test('payment gateway update retains blank credentials and accepts provider environment', () => {
  const result = validatePaymentGatewayUpdate({
    xendit: { enabled: true, secret_key: '', callback_token: '' },
    duitku: {
      enabled: false,
      environment: 'sandbox',
      merchant_code: '',
      api_key: '',
    },
  }, current);

  assert.deepEqual(result, {
    credentials: current.credentials,
    xendit_enabled: true,
    duitku_enabled: false,
    duitku_environment: 'sandbox',
  });
});

test('payment gateway update rejects enabling providers without credentials', () => {
  const emptyCurrent = {
    credentials: {
      xendit_secret_key: '',
      xendit_callback_token: '',
      duitku_merchant_code: '',
      duitku_api_key: '',
    },
    xendit: { enabled: false },
    duitku: { enabled: false, environment: 'production' },
  };
  assert.throws(() => validatePaymentGatewayUpdate({
    xendit: { enabled: true },
    duitku: { enabled: false },
  }, emptyCurrent), { statusCode: 400 });
});

test('payment gateway update rejects invalid environment and secret values', () => {
  assert.throws(() => validatePaymentGatewayUpdate({
    xendit: { enabled: false },
    duitku: { enabled: false, environment: 'staging' },
  }, current), { statusCode: 400 });
  assert.throws(() => validatePaymentGatewayUpdate({
    xendit: { enabled: false, secret_key: 12 },
    duitku: { enabled: false },
  }, current), { statusCode: 400 });
});
