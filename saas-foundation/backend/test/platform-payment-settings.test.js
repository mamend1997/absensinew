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
    kasera_api_key: 'kp_live_key',
    kasera_webhook_secret: 'kasera-webhook-secret',
  },
  xendit: { enabled: true },
  duitku: { enabled: true, environment: 'production' },
  kasera: { enabled: true },
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
    kasera_enabled: true,
  });
});

test('payment gateway update rejects enabling providers without credentials', () => {
  const emptyCurrent = {
    credentials: {
      xendit_secret_key: '',
      xendit_callback_token: '',
      duitku_merchant_code: '',
      duitku_api_key: '',
      kasera_api_key: '',
      kasera_webhook_secret: '',
    },
    xendit: { enabled: false },
    duitku: { enabled: false, environment: 'production' },
    kasera: { enabled: false },
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
  assert.throws(() => validatePaymentGatewayUpdate({
    xendit: { enabled: false },
    duitku: { enabled: false },
    kasera: { enabled: true, api_key: '', webhook_secret: '' },
  }, {
    ...current,
    credentials: {
      ...current.credentials,
      kasera_api_key: '',
      kasera_webhook_secret: '',
    },
    kasera: { enabled: false },
  }), { statusCode: 400 });
});

test('Super Admin routes load the WhatsApp delivery helper', async () => {
  const { default: router } = await import('../src/routes/super-admin.js');
  assert.ok(router);
});
