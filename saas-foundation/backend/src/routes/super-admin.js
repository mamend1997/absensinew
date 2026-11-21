import { randomBytes, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { config } from '../config.js';
import {
  decryptPlatformBackupCredentials,
  encryptPlatformBackupCredentials,
  latestPlatformBackupPath,
} from '../core/platform-backup.js';
import { Router } from 'express';
import { generateUniqueSchoolCode, isValidSchoolCode } from '../core/school-code.js';
import { parseLogoDataUrl } from '../core/branding.js';
import { provisionSchool } from '../core/school-provision.js';
import {
  decryptGatewayToken, encryptGatewayToken, validateGatewayUrl,
} from '../core/whatsapp-gateway.js';
import { inTransaction, pool } from '../db.js';
import { asyncRoute, fail, requireFields } from '../http.js';
import { requireSuperAdmin } from '../middleware/auth.js';
import { hashPassword, signToken, verifyPassword } from '../security.js';
import {
  createRegistrationOtp,
  equalOtpHash,
  hashRegistrationIp,
  hashRegistrationOtp,
  normalizeWhatsappPhone,
  validateRegistrationPassword,
} from '../core/school-registration.js';

const router = Router();
function validateString(value, name, maxLength) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) {
    throw fail(400, `${name} tidak valid.`, 'VALIDATION_ERROR');
  }
  return value.trim();
}

function validateSchoolCode(value) {
  if (!isValidSchoolCode(value)) {
    throw fail(400, 'Kode sekolah harus tepat 4 digit angka.', 'VALIDATION_ERROR');
  }
  return value;
}

function validateGatewaySettings(body) {
  const endpointUrl = validateGatewayUrl(body.endpoint_url).toString();
  if (typeof body.is_enabled !== 'boolean') {
    throw fail(400, 'is_enabled harus berupa boolean.', 'VALIDATION_ERROR');
  }
  if (body.token !== undefined &&
      (typeof body.token !== 'string' || body.token.length > 1024)) {
    throw fail(400, 'Token gateway tidak valid.', 'VALIDATION_ERROR');
  }
  return { endpointUrl, isEnabled: body.is_enabled, token: body.token?.trim() ?? '' };
}

function validateDriveFileUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) {
    throw fail(400, 'Link download APK tidak valid.', 'VALIDATION_ERROR');
  }
  let url;
  try { url = new URL(value); } catch { throw fail(400, 'Link download APK tidak valid.', 'VALIDATION_ERROR'); }
  const isDriveFile = url.hostname === 'drive.google.com' &&
    (/^\/file\/d\/[A-Za-z0-9_-]+(?:\/|$)/.test(url.pathname) ||
      ['/open', '/uc'].includes(url.pathname) && Boolean(url.searchParams.get('id')));
  if (url.protocol !== 'https:' || !isDriveFile || url.username || url.password) {
    throw fail(400, 'Gunakan link file Google Drive yang dapat dibuka dan diunduh.', 'VALIDATION_ERROR');
  }
  return url.toString();
}

router.post('/auth/login', asyncRoute(async (req, res) => {
  requireFields(req.body, ['username', 'password']);
  const username = validateString(req.body.username, 'username', 80);
  const [rows] = await pool.execute(
    'SELECT id, username, display_name, password_hash, auth_version, is_active FROM super_admins WHERE username = ?',
    [username],
  );
  const admin = rows[0];
  const valid = await verifyPassword(req.body.password, admin?.password_hash);
  if (!admin || !admin.is_active || !valid) {
    throw fail(401, 'Username atau password tidak benar.', 'INVALID_CREDENTIALS');
  }
  res.json({
    access_token: signToken({
      kind: 'super_admin',
      sub: String(admin.id),
      authVersion: Number(admin.auth_version ?? 0),
    }),
    token_type: 'Bearer',
    expires_in: process.env.JWT_TTL ?? '8h',
    admin: { id: String(admin.id), username: admin.username, display_name: admin.display_name },
  });
}));

router.post('/auth/password-reset/start', asyncRoute(async (req, res) => {
  requireFields(req.body, ['username', 'whatsapp_phone']);
  const username = validateString(req.body.username, 'username', 80);
  const phone = normalizeWhatsappPhone(req.body.whatsapp_phone);
  if (!phone) throw fail(400, 'Nomor WhatsApp tidak valid.', 'VALIDATION_ERROR');
  const [[gateway]] = await pool.execute(
    `SELECT endpoint_url, token_ciphertext, token_iv, token_auth_tag, is_enabled
       FROM whatsapp_gateway_config WHERE id = 1`,
  );
  if (!gateway?.is_enabled || !gateway.endpoint_url || !gateway.token_ciphertext) {
    throw fail(503, 'Reset kata sandi belum tersedia karena gateway WhatsApp belum diaktifkan.', 'RESET_UNAVAILABLE');
  }

  const ipHash = hashRegistrationIp(req.ip ?? req.socket.remoteAddress ?? 'unknown', config.jwtSecret);
  await pool.execute(
    'DELETE FROM super_admin_password_reset_challenges WHERE created_at < UTC_TIMESTAMP() - INTERVAL 1 DAY',
  );
  const [[limits]] = await pool.execute(
    `SELECT
       SUM(whatsapp_phone = ? AND created_at >= UTC_TIMESTAMP() - INTERVAL 1 HOUR) AS phone_requests,
       SUM(request_ip_hash = ? AND created_at >= UTC_TIMESTAMP() - INTERVAL 1 HOUR) AS ip_requests
     FROM super_admin_password_reset_challenges
     WHERE created_at >= UTC_TIMESTAMP() - INTERVAL 1 HOUR`,
    [phone, ipHash],
  );
  if (Number(limits.phone_requests ?? 0) >= 3 || Number(limits.ip_requests ?? 0) >= 20) {
    throw fail(429, 'Batas permintaan reset tercapai. Coba kembali beberapa saat lagi.', 'RESET_RATE_LIMITED');
  }

  const [admins] = await pool.execute(
    `SELECT id FROM super_admins
      WHERE username = ? AND whatsapp_phone = ? AND is_active = TRUE
      LIMIT 1`,
    [username, phone],
  );
  const admin = admins[0];
  const challengeId = randomUUID();
  const otp = createRegistrationOtp();
  await pool.execute(
    `INSERT INTO super_admin_password_reset_challenges
      (id, super_admin_id, username, whatsapp_phone, otp_hash, expires_at, request_ip_hash)
     VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP() + INTERVAL 5 MINUTE, ?)`,
    [challengeId, admin?.id ?? null, username, phone,
      hashRegistrationOtp(challengeId, otp, config.jwtSecret), ipHash],
  );

  if (admin) {
    try {
      await sendWhatsappMessage(
        gateway.endpoint_url,
        decryptGatewayToken(gateway),
        phone,
        `Kode reset Super Admin Ruang Hadir: ${otp}. Berlaku 5 menit. Jangan bagikan kode ini kepada siapa pun.`,
      );
    } catch (error) {
      await pool.execute(
        'UPDATE super_admin_password_reset_challenges SET attempt_count = 5 WHERE id = ?',
        [challengeId],
      );
      throw error;
    }
  }

  res.status(202).json({
    challenge_id: challengeId,
    expires_in_seconds: 300,
    message: 'Jika username dan nomor WhatsApp cocok dengan akun aktif, kode verifikasi akan dikirim.',
  });
}));

router.post('/auth/password-reset/verify', asyncRoute(async (req, res) => {
  requireFields(req.body, ['challenge_id', 'otp', 'password']);
  if (typeof req.body.challenge_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(req.body.challenge_id) ||
      typeof req.body.otp !== 'string' || !/^\d{6}$/.test(req.body.otp)) {
    throw fail(400, 'ID permintaan atau OTP tidak valid.', 'VALIDATION_ERROR');
  }
  if (!validateRegistrationPassword(req.body.password)) {
    throw fail(400, 'Kata sandi minimal 8 karakter dan wajib memiliki huruf besar, angka, serta simbol.', 'VALIDATION_ERROR');
  }

  const result = await inTransaction(async (connection) => {
    const [[challenge]] = await connection.execute(
      `SELECT id, super_admin_id, otp_hash,
              expires_at > UTC_TIMESTAMP() AS otp_is_valid,
              attempt_count, completed_at
         FROM super_admin_password_reset_challenges WHERE id = ? FOR UPDATE`,
      [req.body.challenge_id],
    );
    if (!challenge || challenge.completed_at ||
        !challenge.otp_is_valid ||
        Number(challenge.attempt_count) >= 5) {
      return { error: 'Kode verifikasi tidak valid atau sudah kedaluwarsa.' };
    }
    if (!equalOtpHash(
      hashRegistrationOtp(challenge.id, req.body.otp, config.jwtSecret),
      challenge.otp_hash,
    )) {
      await connection.execute(
        'UPDATE super_admin_password_reset_challenges SET attempt_count = attempt_count + 1 WHERE id = ?',
        [challenge.id],
      );
      return { error: 'Kode verifikasi tidak valid atau sudah kedaluwarsa.' };
    }
    if (!challenge.super_admin_id) {
      return { error: 'Kode verifikasi tidak valid atau sudah kedaluwarsa.' };
    }

    const passwordHash = await hashPassword(req.body.password);
    const [update] = await connection.execute(
      `UPDATE super_admins SET password_hash = ?, auth_version = auth_version + 1
        WHERE id = ? AND is_active = TRUE`,
      [passwordHash, challenge.super_admin_id],
    );
    if (update.affectedRows !== 1) {
      return { error: 'Kode verifikasi tidak valid atau sudah kedaluwarsa.' };
    }
    await connection.execute(
      `UPDATE super_admin_password_reset_challenges
          SET completed_at = UTC_TIMESTAMP()
        WHERE super_admin_id = ? AND completed_at IS NULL`,
      [challenge.super_admin_id],
    );
    return { success: true };
  });
  if (result.error) throw fail(400, result.error, 'INVALID_OTP');
  res.json({ message: 'Kata sandi Super Admin berhasil direset. Silakan masuk kembali.' });
}));

router.put('/branding/logo', requireSuperAdmin, asyncRoute(async (req, res) => {
  const { mimeType, data } = parseLogoDataUrl(req.body?.logo_data_url);
  await pool.execute(
    `INSERT INTO platform_branding (id, logo_mime_type, logo_data) VALUES (1, ?, ?)
     ON DUPLICATE KEY UPDATE logo_mime_type = VALUES(logo_mime_type), logo_data = VALUES(logo_data)`,
    [mimeType, data],
  );
  res.json({ message: 'Logo platform diperbarui.' });
}));

router.get('/settings/application-name', requireSuperAdmin, asyncRoute(async (req, res) => {
  const [[branding]] = await pool.execute(
    'SELECT application_name FROM platform_branding WHERE id = 1',
  );
  res.json({ application_name: branding?.application_name ?? 'Ruang Hadir' });
}));

router.put('/settings/application-name', requireSuperAdmin, asyncRoute(async (req, res) => {
  const applicationName = validateString(req.body?.application_name, 'Nama aplikasi', 120);
  await pool.execute(
    'UPDATE platform_branding SET application_name = ? WHERE id = 1',
    [applicationName],
  );
  res.json({ application_name: applicationName, message: 'Nama aplikasi diperbarui.' });
}));

router.delete('/branding/logo', requireSuperAdmin, asyncRoute(async (req, res) => {
  await pool.execute(
    'UPDATE platform_branding SET logo_mime_type = NULL, logo_data = NULL WHERE id = 1',
  );
  res.json({ message: 'Logo platform dihapus.' });
}));

router.get('/settings/whatsapp-gateway', requireSuperAdmin, asyncRoute(async (req, res) => {
  const [[settings]] = await pool.execute(
    `SELECT endpoint_url, token_ciphertext, is_enabled
       FROM whatsapp_gateway_config WHERE id = 1`,
  );
  res.json({
    settings: {
      endpoint_url: settings?.endpoint_url ?? '',
      is_enabled: Boolean(settings?.is_enabled),
      is_configured: Boolean(settings?.endpoint_url && settings?.token_ciphertext),
      token_hint: settings?.token_ciphertext ? 'Token tersimpan aman' : '',
    },
  });
}));

router.put('/settings/whatsapp-gateway', requireSuperAdmin, asyncRoute(async (req, res) => {
  const settings = validateGatewaySettings(req.body ?? {});
  const [[existing]] = await pool.execute(
    'SELECT token_ciphertext, token_iv, token_auth_tag FROM whatsapp_gateway_config WHERE id = 1',
  );
  const encrypted = settings.token
    ? encryptGatewayToken(settings.token)
    : existing?.token_ciphertext
      ? {
        ciphertext: existing.token_ciphertext,
        iv: existing.token_iv,
        authTag: existing.token_auth_tag,
      }
      : null;
  if (settings.isEnabled && !encrypted) {
    throw fail(400, 'Masukkan token gateway sebelum mengaktifkannya.', 'VALIDATION_ERROR');
  }
  await pool.execute(
    `INSERT INTO whatsapp_gateway_config
      (id, endpoint_url, token_ciphertext, token_iv, token_auth_tag, is_enabled)
     VALUES (1, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE endpoint_url = VALUES(endpoint_url),
       token_ciphertext = VALUES(token_ciphertext), token_iv = VALUES(token_iv),
       token_auth_tag = VALUES(token_auth_tag), is_enabled = VALUES(is_enabled)`,
    [settings.endpointUrl, encrypted?.ciphertext ?? null, encrypted?.iv ?? null,
      encrypted?.authTag ?? null, settings.isEnabled],
  );
  res.json({ message: 'Pengaturan WhatsApp gateway disimpan.' });
}));

router.delete('/settings/whatsapp-gateway', requireSuperAdmin, asyncRoute(async (req, res) => {
  await pool.execute(
    `UPDATE whatsapp_gateway_config
        SET endpoint_url = NULL, token_ciphertext = NULL, token_iv = NULL,
            token_auth_tag = NULL, is_enabled = FALSE
      WHERE id = 1`,
  );
  res.json({ message: 'Konfigurasi WhatsApp gateway dihapus.' });
}));

router.get('/settings/apk-download', requireSuperAdmin, asyncRoute(async (req, res) => {
  const [[settings]] = await pool.execute(
    'SELECT apk_drive_url FROM platform_download_settings WHERE id = 1',
  );
  res.json({ apk_drive_url: settings?.apk_drive_url ?? '' });
}));

router.put('/settings/apk-download', requireSuperAdmin, asyncRoute(async (req, res) => {
  const apkDriveUrl = req.body?.apk_drive_url === ''
    ? null
    : validateDriveFileUrl(req.body?.apk_drive_url);
  await pool.execute(
    `INSERT INTO platform_download_settings (id, apk_drive_url) VALUES (1, ?)
     ON DUPLICATE KEY UPDATE apk_drive_url = VALUES(apk_drive_url)`,
    [apkDriveUrl],
  );
  res.json({ message: 'Link download APK diperbarui.', apk_drive_url: apkDriveUrl ?? '' });
}));

router.use(requireSuperAdmin);

router.get('/settings/recovery-phone', asyncRoute(async (req, res) => {
  const [[admin]] = await pool.execute(
    'SELECT whatsapp_phone FROM super_admins WHERE id = ?',
    [req.superAdmin.id],
  );
  res.json({ whatsapp_phone: admin?.whatsapp_phone ?? '' });
}));

router.put('/settings/recovery-phone', asyncRoute(async (req, res) => {
  requireFields(req.body, ['whatsapp_phone', 'current_password']);
  const phone = normalizeWhatsappPhone(req.body.whatsapp_phone);
  if (!phone) throw fail(400, 'Nomor WhatsApp tidak valid.', 'VALIDATION_ERROR');
  const [[admin]] = await pool.execute(
    'SELECT password_hash FROM super_admins WHERE id = ? AND is_active = TRUE',
    [req.superAdmin.id],
  );
  if (!await verifyPassword(req.body.current_password, admin?.password_hash)) {
    throw fail(401, 'Kata sandi saat ini tidak benar.', 'INVALID_CREDENTIALS');
  }
  await pool.execute(
    'UPDATE super_admins SET whatsapp_phone = ? WHERE id = ? AND is_active = TRUE',
    [phone, req.superAdmin.id],
  );
  res.json({ whatsapp_phone: phone, message: 'Nomor WhatsApp pemulihan berhasil disimpan.' });
}));

router.get('/settings/billing-prices', asyncRoute(async (req, res) => {
  const [[settings]] = await pool.execute(
    'SELECT monthly_price, lifetime_price FROM platform_billing_settings WHERE id = 1',
  );
  res.json({
    monthly_price: Number(settings?.monthly_price ?? 50000),
    lifetime_price: Number(settings?.lifetime_price ?? 1000000),
    providers: {
      xendit: Boolean(
        process.env.XENDIT_SECRET_KEY && process.env.XENDIT_CALLBACK_TOKEN &&
        process.env.PUBLIC_WEB_URL && process.env.PUBLIC_API_URL,
      ),
      duitku: Boolean(
        process.env.DUITKU_MERCHANT_CODE && process.env.DUITKU_API_KEY &&
        process.env.PUBLIC_WEB_URL && process.env.PUBLIC_API_URL,
      ),
    },
  });
}));

router.put('/settings/billing-prices', asyncRoute(async (req, res) => {
  const { monthly_price: monthlyPrice, lifetime_price: lifetimePrice } = req.body ?? {};
  for (const [name, value] of [['monthly_price', monthlyPrice], ['lifetime_price', lifetimePrice]]) {
    if (!Number.isSafeInteger(value) || value < 1000 || value > 1000000000) {
      throw fail(400, `${name} harus berupa bilangan rupiah antara 1.000 dan 1.000.000.000.`, 'VALIDATION_ERROR');
    }
  }
  await pool.execute(
    `UPDATE platform_billing_settings SET monthly_price = ?, lifetime_price = ? WHERE id = 1`,
    [monthlyPrice, lifetimePrice],
  );
  res.json({ monthly_price: monthlyPrice, lifetime_price: lifetimePrice });
}));

router.get('/settings/backup', asyncRoute(async (req, res) => {
  const [[settings]] = await pool.execute(
    `SELECT enabled, backup_time, encrypted_credentials, last_status,
            last_run_at, last_error
       FROM platform_backup_settings WHERE id = 1`,
  );
  const credentials = settings?.encrypted_credentials
    ? decryptPlatformBackupCredentials(settings.encrypted_credentials)
    : null;
  const chatId = credentials?.chat_id ?? '';
  res.json({
    enabled: Boolean(Number(settings?.enabled)),
    backup_time: settings?.backup_time ?? '02:00',
    bot_configured: Boolean(credentials?.bot_token && chatId),
    chat_id_hint: chatId.length > 4 ? `***${chatId.slice(-4)}` : chatId,
    last_status: settings?.last_status ?? 'never',
    last_run_at: settings?.last_run_at ?? null,
    last_error: settings?.last_error ?? null,
  });
}));

router.put('/settings/backup', asyncRoute(async (req, res) => {
  const { enabled, backup_time: backupTime, bot_token: botTokenValue, chat_id: chatIdValue } = req.body ?? {};
  if (typeof enabled !== 'boolean' || typeof backupTime !== 'string' ||
      !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(backupTime) ||
      botTokenValue !== undefined && (typeof botTokenValue !== 'string' || botTokenValue.length > 512) ||
      chatIdValue !== undefined && (typeof chatIdValue !== 'string' || chatIdValue.length > 100)) {
    throw fail(400, 'Pengaturan backup tidak valid.', 'VALIDATION_ERROR');
  }
  const [[current]] = await pool.execute(
    'SELECT encrypted_credentials FROM platform_backup_settings WHERE id = 1',
  );
  let encryptedCredentials = current?.encrypted_credentials ?? null;
  const botToken = botTokenValue?.trim() ?? '';
  const chatId = chatIdValue?.trim() ?? '';
  if (botToken || chatId) {
    if (!botToken || !chatId) {
      throw fail(400, 'Token Bot dan Chat ID harus diisi bersama.', 'VALIDATION_ERROR');
    }
    encryptedCredentials = encryptPlatformBackupCredentials({
      bot_token: botToken,
      chat_id: chatId,
    });
  }
  if (enabled && (!encryptedCredentials || !config.backupDirectory)) {
    throw fail(
      400,
      !encryptedCredentials
        ? 'Isi kredensial Telegram terlebih dahulu.'
        : 'BACKUP_DIRECTORY harus diarahkan ke volume privat yang persisten.',
      'BACKUP_CONFIGURATION_REQUIRED',
    );
  }
  await pool.execute(
    `UPDATE platform_backup_settings
        SET enabled = ?, backup_time = ?, encrypted_credentials = ?
      WHERE id = 1`,
    [enabled, backupTime, encryptedCredentials],
  );
  const [[updated]] = await pool.execute(
    `SELECT enabled, backup_time, encrypted_credentials, last_status,
            last_run_at, last_error
       FROM platform_backup_settings WHERE id = 1`,
  );
  const credentials = updated.encrypted_credentials
    ? decryptPlatformBackupCredentials(updated.encrypted_credentials)
    : null;
  const chatIdHint = credentials?.chat_id ?? '';
  res.json({
    enabled: Boolean(Number(updated.enabled)),
    backup_time: updated.backup_time,
    bot_configured: Boolean(credentials?.bot_token && chatIdHint),
    chat_id_hint: chatIdHint.length > 4 ? `***${chatIdHint.slice(-4)}` : chatIdHint,
    last_status: updated.last_status,
    last_run_at: updated.last_run_at,
    last_error: updated.last_error,
  });
}));

router.get('/settings/backup/latest', asyncRoute(async (req, res, next) => {
  const path = await latestPlatformBackupPath();
  if (!path) throw fail(404, 'Backup otomatis belum tersedia.', 'NOT_FOUND');
  try {
    const file = await stat(path);
    if (!file.isFile()) throw fail(404, 'File backup tidak ditemukan.', 'NOT_FOUND');
  } catch (error) {
    if (error.code === 'ENOENT') throw fail(404, 'File backup tidak ditemukan.', 'NOT_FOUND');
    throw error;
  }
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', 'attachment; filename="ruang-hadir-saas-backup.json.enc"');
  const stream = createReadStream(path);
  stream.on('error', (error) => {
    if (res.headersSent) res.destroy(error);
    else next(error);
  });
  stream.pipe(res);
}));

router.get('/schools', asyncRoute(async (req, res) => {
  const [rows] = await pool.execute(
    `SELECT id, slug, school_code, name, subscription_status, trial_ends_at,
            subscription_expires_at, participant_quota, timezone, is_active, created_at, updated_at,
            (SELECT u.username
               FROM users u JOIN roles r ON r.sekolah_id = u.sekolah_id AND r.id = u.role_id
              WHERE u.sekolah_id = schools.id AND r.role_key = 'admin-sekolah'
              ORDER BY u.id LIMIT 1) AS admin_username
       FROM schools ORDER BY id DESC`,
  );
  res.json({ schools: rows });
}));

router.post('/schools', asyncRoute(async (req, res) => {
  requireFields(req.body, ['slug', 'name', 'initial_admin']);
  const slug = validateString(req.body.slug, 'slug', 100).toLowerCase();
  const name = validateString(req.body.name, 'name', 180);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw fail(400, 'slug hanya boleh huruf kecil, angka, dan tanda hubung.', 'VALIDATION_ERROR');
  }
  const initialAdmin = req.body.initial_admin;
  requireFields(initialAdmin, ['username', 'display_name', 'password']);
  const adminUsername = validateString(initialAdmin.username, 'initial_admin.username', 80);
  const adminName = validateString(initialAdmin.display_name, 'initial_admin.display_name', 150);
  if (typeof initialAdmin.password !== 'string' || initialAdmin.password.length < 12 ||
      initialAdmin.password.length > 1024) {
    throw fail(400, 'Password admin awal wajib 12–1024 karakter.', 'VALIDATION_ERROR');
  }
  const quota = req.body.participant_quota ?? 500;
  if (!Number.isInteger(quota) || quota < 1 || quota > 1000000) {
    throw fail(400, 'participant_quota tidak valid.', 'VALIDATION_ERROR');
  }
  const status = req.body.subscription_status ?? 'trial';
  if (!['trial', 'aktif', 'lifetime'].includes(status)) {
    throw fail(400, 'subscription_status harus trial, aktif, atau lifetime.', 'VALIDATION_ERROR');
  }
  const timezone = req.body.timezone ?? 'Asia/Jakarta';
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone });
  } catch {
    throw fail(400, 'Timezone tidak valid.', 'VALIDATION_ERROR');
  }
  const schoolCode = req.body.school_code === undefined
    ? await generateUniqueSchoolCode({
      isTaken: async (code) => {
        const [rows] = await pool.execute('SELECT 1 FROM schools WHERE school_code = ? LIMIT 1', [code]);
        return rows.length > 0;
      },
    })
    : validateSchoolCode(req.body.school_code);
  const passwordHash = await hashPassword(initialAdmin.password);
  const id = await inTransaction((connection) => provisionSchool(connection, {
    slug,
    schoolCode,
    name,
    adminUsername,
    adminName,
    passwordHash,
    status,
    quota,
    timezone,
  }));
  res.status(201).json({
    school: { id, slug, school_code: schoolCode, name, subscription_status: status },
    initial_admin: { username: adminUsername, display_name: adminName },
  });
}));

router.patch('/schools/:id', asyncRoute(async (req, res) => {
  const allowed = ['name', 'subscription_status', 'trial_ends_at',
    'subscription_expires_at', 'participant_quota', 'timezone', 'is_active'];
  const changes = { ...(req.body ?? {}) };
  if (changes.subscription_status === 'lifetime') {
    changes.trial_ends_at = null;
    changes.subscription_expires_at = null;
  }
  const entries = Object.entries(changes).filter(([key]) => allowed.includes(key));
  if (!entries.length || entries.length !== Object.keys(changes).length) {
    throw fail(400, 'Field perubahan tidak valid atau kosong.', 'VALIDATION_ERROR');
  }
  const values = [];
  for (const [key, value] of entries) {
    if (key === 'name') values.push(validateString(value, key, 180));
    else if (key === 'subscription_status') {
      if (!['trial', 'aktif', 'suspend', 'lifetime'].includes(value)) throw fail(400, 'Status langganan tidak valid.');
      values.push(value);
    } else if (key === 'participant_quota') {
      if (!Number.isInteger(value) || value < 1 || value > 1000000) throw fail(400, 'Kuota tidak valid.');
      values.push(value);
    } else if (key === 'timezone') {
      try { new Intl.DateTimeFormat('en', { timeZone: value }); } catch { throw fail(400, 'Timezone tidak valid.'); }
      values.push(value);
    } else if (key === 'is_active') {
      if (typeof value !== 'boolean') throw fail(400, 'is_active harus boolean.');
      values.push(value);
    } else {
      if (value !== null && (typeof value !== 'string' ||
          !/^\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2}:\d{2})?$/.test(value))) {
        throw fail(400, `${key} tidak valid.`);
      }
      values.push(value);
    }
  }
  const assignments = entries.map(([key]) => `\`${key}\` = ?`).join(', ');
  const [existing] = await pool.execute('SELECT id FROM schools WHERE id = ?', [req.params.id]);
  if (!existing.length) throw fail(404, 'Sekolah tidak ditemukan.', 'NOT_FOUND');
  const [result] = await pool.execute(
    `UPDATE schools SET ${assignments} WHERE id = ?`,
    [...values, req.params.id],
  );
  const [[school]] = await pool.execute(
    `SELECT id, slug, school_code, name, subscription_status, trial_ends_at,
            subscription_expires_at, participant_quota, timezone, is_active
       FROM schools WHERE id = ?`,
    [req.params.id],
  );
  res.json({ school });
}));

router.post('/schools/:id/admin-password/reset', asyncRoute(async (req, res) => {
  const schoolId = req.params.id;
  if (!/^[1-9]\d*$/.test(schoolId)) throw fail(400, 'ID sekolah tidak valid.', 'VALIDATION_ERROR');
  const [[admin]] = await pool.execute(
    `SELECT u.id, u.username
       FROM users u JOIN roles r ON r.sekolah_id = u.sekolah_id AND r.id = u.role_id
      WHERE u.sekolah_id = ? AND r.role_key = 'admin-sekolah' AND u.is_active = TRUE
      ORDER BY u.id LIMIT 1`,
    [schoolId],
  );
  if (!admin) throw fail(404, 'Akun Admin sekolah aktif tidak ditemukan.', 'NOT_FOUND');
  const temporaryPassword = randomBytes(18).toString('base64url');
  const passwordHash = await hashPassword(temporaryPassword);
  await pool.execute(
    'UPDATE users SET password_hash = ? WHERE id = ? AND sekolah_id = ?',
    [passwordHash, admin.id, schoolId],
  );
  res.json({
    username: admin.username,
    temporary_password: temporaryPassword,
    message: 'Kata sandi sementara dibuat. Simpan dan sampaikan dengan aman.',
  });
}));

router.delete('/schools/:id', asyncRoute(async (req, res) => {
  const schoolId = req.params.id;
  if (!/^[1-9]\d*$/.test(schoolId)) throw fail(400, 'ID sekolah tidak valid.', 'VALIDATION_ERROR');
  const confirmation = req.body?.confirm_school_name;
  if (typeof confirmation !== 'string' || confirmation.length > 180) {
    throw fail(400, 'Ketik nama sekolah sebagai konfirmasi.', 'VALIDATION_ERROR');
  }
  const name = await inTransaction(async (connection) => {
    const [[school]] = await connection.execute(
      'SELECT name FROM schools WHERE id = ? FOR UPDATE',
      [schoolId],
    );
    if (!school) throw fail(404, 'Sekolah tidak ditemukan.', 'NOT_FOUND');
    if (confirmation !== school.name) {
      throw fail(400, 'Nama konfirmasi tidak cocok. Tidak ada data yang dihapus.', 'VALIDATION_ERROR');
    }
    const tenantTables = [
      'attendance_logs',
      'attendance_exceptions',
      'activity_logs',
      'operational_settings',
      'school_holidays',
      'weekly_operational_schedules',
      'scanner_devices',
      'participants',
      'users',
      'classrooms',
      'units',
      'roles',
    ];
    for (const table of tenantTables) {
      await connection.execute(`DELETE FROM \`${table}\` WHERE sekolah_id = ?`, [schoolId]);
    }
    await connection.execute('DELETE FROM schools WHERE id = ?', [schoolId]);
    return school.name;
  });
  res.json({ message: `Data sekolah ${name} dan seluruh data terkait telah dihapus permanen.` });
}));

router.post('/schools/:id/code/reset', asyncRoute(async (req, res) => {
  const [schools] = await pool.execute(
    'SELECT id, school_code FROM schools WHERE id = ?',
    [req.params.id],
  );
  if (!schools.length) throw fail(404, 'Sekolah tidak ditemukan.', 'NOT_FOUND');
  let code;
  if (req.body?.school_code !== undefined) {
    code = validateSchoolCode(req.body.school_code);
    if (code === schools[0].school_code) {
      throw fail(400, 'Kode baru harus berbeda dari kode saat ini.', 'VALIDATION_ERROR');
    }
    const [taken] = await pool.execute(
      'SELECT id FROM schools WHERE school_code = ? LIMIT 1',
      [code],
    );
    if (taken.length) throw fail(409, 'Kode sekolah sudah digunakan.', 'CODE_CONFLICT');
  } else {
    code = await generateUniqueSchoolCode({
      isTaken: async (candidate) => {
        const [rows] = await pool.execute(
          'SELECT 1 FROM schools WHERE school_code = ? LIMIT 1',
          [candidate],
        );
        return rows.length > 0;
      },
    });
  }
  const [result] = await pool.execute(
    'UPDATE schools SET school_code = ? WHERE id = ? AND school_code = ?',
    [code, req.params.id, schools[0].school_code],
  );
  if (!result.affectedRows) throw fail(409, 'Kode sekolah berubah bersamaan; ulangi permintaan.', 'CODE_CONFLICT');
  res.json({ school_code: code, message: 'Kode sekolah diperbarui; sesi sekolah dengan kode lama tidak berlaku.' });
}));

export default router;
