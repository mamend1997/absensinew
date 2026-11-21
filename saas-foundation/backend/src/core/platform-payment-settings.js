import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { pool } from '../db.js';
import { fail } from '../http.js';

const encryptionKey = createHash('sha256')
  .update('ruang-hadir-platform-payment-credentials-v1\0')
  .update(config.jwtSecret)
  .digest();

function seal(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return JSON.stringify({
    version: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  });
}

function open(value) {
  const envelope = JSON.parse(value);
  if (envelope.version !== 1) throw new Error('Format kredensial pembayaran tidak dikenali.');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey, Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

function decryptCredentials(value) {
  if (!value) return {};
  const credentials = JSON.parse(open(value));
  if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) {
    throw new Error('Kredensial pembayaran tersimpan tidak valid.');
  }
  return credentials;
}

function mask(value) {
  return value ? `****${value.slice(-4)}` : '';
}

function callbackUrl(path) {
  if (!config.publicApiUrl) return '';
  try { return new URL(path, config.publicApiUrl).toString(); } catch { return ''; }
}

export async function getPlatformPaymentSettings() {
  const [[row]] = await pool.execute(
    `SELECT xendit_enabled, duitku_enabled, duitku_environment, kasera_enabled, encrypted_credentials
       FROM platform_payment_gateway_settings WHERE id = 1`,
  );
  const stored = decryptCredentials(row?.encrypted_credentials);
  const credentials = {
    xendit_secret_key: typeof stored.xendit_secret_key === 'string'
      ? stored.xendit_secret_key : config.xenditSecretKey,
    xendit_callback_token: typeof stored.xendit_callback_token === 'string'
      ? stored.xendit_callback_token : config.xenditCallbackToken,
    duitku_merchant_code: typeof stored.duitku_merchant_code === 'string'
      ? stored.duitku_merchant_code : config.duitkuMerchantCode,
    duitku_api_key: typeof stored.duitku_api_key === 'string'
      ? stored.duitku_api_key : config.duitkuApiKey,
    kasera_api_key: typeof stored.kasera_api_key === 'string'
      ? stored.kasera_api_key : '',
    kasera_webhook_secret: typeof stored.kasera_webhook_secret === 'string'
      ? stored.kasera_webhook_secret : '',
  };
  const xenditConfigured = Boolean(
    credentials.xendit_secret_key && credentials.xendit_callback_token &&
    config.publicWebUrl && config.publicApiUrl,
  );
  const duitkuConfigured = Boolean(
    credentials.duitku_merchant_code && credentials.duitku_api_key &&
    config.publicWebUrl && config.publicApiUrl,
  );
  const kaseraConfigured = Boolean(
    credentials.kasera_api_key && credentials.kasera_webhook_secret &&
    config.publicWebUrl && config.publicApiUrl,
  );
  const xenditEnabled = row?.xendit_enabled == null
    ? xenditConfigured : Boolean(Number(row.xendit_enabled));
  const duitkuEnabled = row?.duitku_enabled == null
    ? duitkuConfigured : Boolean(Number(row.duitku_enabled));
  const kaseraEnabled = row?.kasera_enabled == null
    ? kaseraConfigured : Boolean(Number(row.kasera_enabled));

  return {
    credentials,
    xendit: {
      configured: xenditConfigured,
      enabled: xenditEnabled,
      active: xenditConfigured && xenditEnabled,
    },
    duitku: {
      configured: duitkuConfigured,
      enabled: duitkuEnabled,
      active: duitkuConfigured && duitkuEnabled,
      environment: row?.duitku_environment ?? config.duitkuEnvironment,
    },
    kasera: {
      configured: kaseraConfigured,
      enabled: kaseraEnabled,
      active: kaseraConfigured && kaseraEnabled,
    },
    credential_source: row?.encrypted_credentials ? 'database' : 'environment',
  };
}

export async function getAdminPaymentGatewaySettings() {
  const settings = await getPlatformPaymentSettings();
  const { credentials } = settings;
  return {
    credential_source: settings.credential_source,
    callback_urls: {
      xendit: callbackUrl('/api/payments/xendit/callback'),
      duitku: callbackUrl('/api/payments/duitku/callback'),
      kasera: callbackUrl('/api/payments/kasera/webhook'),
    },
    xendit: {
      configured: settings.xendit.configured,
      enabled: settings.xendit.enabled,
      secret_key_hint: mask(credentials.xendit_secret_key),
      callback_token_hint: mask(credentials.xendit_callback_token),
    },
    duitku: {
      configured: settings.duitku.configured,
      enabled: settings.duitku.enabled,
      environment: settings.duitku.environment,
      merchant_code_hint: mask(credentials.duitku_merchant_code),
      api_key_hint: mask(credentials.duitku_api_key),
    },
    kasera: {
      configured: settings.kasera.configured,
      enabled: settings.kasera.enabled,
      api_key_hint: mask(credentials.kasera_api_key),
      webhook_secret_hint: mask(credentials.kasera_webhook_secret),
    },
  };
}

function inputValue(value, existing, field, maxLength) {
  if (value === undefined || value === '') return existing;
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) {
    throw fail(400, `${field} tidak valid.`, 'VALIDATION_ERROR');
  }
  return value.trim();
}

export function validatePaymentGatewayUpdate(body, current) {
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      !body.xendit || typeof body.xendit !== 'object' ||
      !body.duitku || typeof body.duitku !== 'object' ||
      typeof body.xendit.enabled !== 'boolean' ||
      typeof body.duitku.enabled !== 'boolean') {
    throw fail(400, 'Pengaturan payment gateway tidak valid.', 'VALIDATION_ERROR');
  }
  const environment = body.duitku.environment ?? current.duitku.environment;
  if (!['production', 'sandbox'].includes(environment)) {
    throw fail(400, 'Environment Duitku tidak valid.', 'VALIDATION_ERROR');
  }
  const credentials = {
    xendit_secret_key: inputValue(
      body.xendit.secret_key, current.credentials.xendit_secret_key, 'Secret key Xendit', 500,
    ),
    xendit_callback_token: inputValue(
      body.xendit.callback_token, current.credentials.xendit_callback_token, 'Callback token Xendit', 500,
    ),
    duitku_merchant_code: inputValue(
      body.duitku.merchant_code, current.credentials.duitku_merchant_code, 'Merchant code Duitku', 100,
    ),
    duitku_api_key: inputValue(
      body.duitku.api_key, current.credentials.duitku_api_key, 'API key Duitku', 500,
    ),
    kasera_api_key: inputValue(
      body.kasera?.api_key, current.credentials.kasera_api_key ?? '', 'API key Kasera', 500,
    ),
    kasera_webhook_secret: inputValue(
      body.kasera?.webhook_secret, current.credentials.kasera_webhook_secret ?? '', 'Webhook secret Kasera', 500,
    ),
  };
  if (body.kasera !== undefined &&
      (!body.kasera || typeof body.kasera !== 'object' || Array.isArray(body.kasera) ||
       typeof body.kasera.enabled !== 'boolean')) {
    throw fail(400, 'Pengaturan Kasera tidak valid.', 'VALIDATION_ERROR');
  }
  const kaseraEnabled = body.kasera?.enabled ?? current.kasera?.enabled ?? false;
  if (body.xendit.enabled && (!credentials.xendit_secret_key ||
      !credentials.xendit_callback_token || !config.publicWebUrl || !config.publicApiUrl)) {
    throw fail(400, 'Lengkapi kredensial Xendit serta PUBLIC_WEB_URL dan PUBLIC_API_URL sebelum mengaktifkannya.', 'VALIDATION_ERROR');
  }
  if (body.duitku.enabled && (!credentials.duitku_merchant_code ||
      !credentials.duitku_api_key || !config.publicWebUrl || !config.publicApiUrl)) {
    throw fail(400, 'Lengkapi kredensial Duitku serta PUBLIC_WEB_URL dan PUBLIC_API_URL sebelum mengaktifkannya.', 'VALIDATION_ERROR');
  }
  if (kaseraEnabled && (!credentials.kasera_api_key ||
      !credentials.kasera_webhook_secret || !config.publicWebUrl || !config.publicApiUrl)) {
    throw fail(400, 'Lengkapi API key dan webhook secret Kasera serta PUBLIC_WEB_URL dan PUBLIC_API_URL sebelum mengaktifkannya.', 'VALIDATION_ERROR');
  }
  if (kaseraEnabled && process.env.NODE_ENV === 'production' &&
      !credentials.kasera_api_key.startsWith('kp_live_')) {
    throw fail(400, 'Gunakan API key live Kasera untuk mengaktifkan tagihan produksi.', 'VALIDATION_ERROR');
  }
  return {
    credentials,
    xendit_enabled: body.xendit.enabled,
    duitku_enabled: body.duitku.enabled,
    duitku_environment: environment,
    kasera_enabled: kaseraEnabled,
  };
}

export async function savePaymentGatewaySettings(body) {
  const current = await getPlatformPaymentSettings();
  const settings = validatePaymentGatewayUpdate(body, current);
  await pool.execute(
    `UPDATE platform_payment_gateway_settings
        SET xendit_enabled = ?, duitku_enabled = ?, duitku_environment = ?, kasera_enabled = ?,
            encrypted_credentials = ?
      WHERE id = 1`,
    [
      settings.xendit_enabled,
      settings.duitku_enabled,
      settings.duitku_environment,
      settings.kasera_enabled,
      seal(JSON.stringify(settings.credentials)),
    ],
  );
  return getAdminPaymentGatewaySettings();
}
