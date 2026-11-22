import { randomUUID } from 'node:crypto';
import express, { Router } from 'express';
import {
  createSchoolDatabaseBackup,
  restoreDatabaseBackup,
} from '../core/database-backup.js';
import {
  createProviderPayment, getDuitkuPaymentMethods,
} from '../core/billing.js';
import { calculateAttendance } from '../core/attendance.js';
import { inTransaction, pool } from '../db.js';
import {
  asyncRoute, fail, parseJson, requireFields,
} from '../http.js';
import {
  classroomScope, requireAnyPermission, requireDevice, requirePermission, requireSchoolUser,
} from '../middleware/auth.js';
import {
  ALLOWED_PERMISSIONS, hasSchoolPermission, normalizeSchoolPermissions,
} from '../core/school-permissions.js';
import {
  createRegistrationOtp,
  equalOtpHash,
  hashRegistrationIp,
  hashRegistrationOtp,
  normalizeWhatsappPhone,
  registrationSlug,
  validateRegistrationPassword,
  validateRegistrationUsername,
} from '../core/school-registration.js';
import { generateUniqueSchoolCode } from '../core/school-code.js';
import { parseLogoDataUrl } from '../core/branding.js';
import { provisionSchool } from '../core/school-provision.js';
import { enforceOtpRequestLimit } from '../core/otp-rate-limit.js';
import {
  decryptGatewayToken, encryptGatewayToken, sendWhatsappMessage, validateGatewayUrl,
} from '../core/whatsapp-gateway.js';
import {
  sendAttendanceToGoogleSheets,
  validateAppsScriptWebAppUrl,
} from '../core/google-sheets-sync.js';
import { aggregateAttendanceReport } from '../core/attendance-report.js';
import { config } from '../config.js';
import { createDeviceApiKey, hashPassword, signToken, verifyPassword } from '../security.js';
import { getPlatformPaymentSettings } from '../core/platform-payment-settings.js';
import {
  createLateAttendanceMessage,
  enqueueLateAttendanceNotification,
  normalizeLateAttendanceRecipientPhone,
  shouldQueueLateAttendanceNotification,
} from '../core/late-attendance-notifications.js';
import { canDeleteSchoolRole } from '../core/school-roles.js';

const router = Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_ROLES = ['admin-sekolah', 'operator-scanner'];

function string(value, field, max = 150) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) {
    throw fail(400, `${field} tidak valid.`, 'VALIDATION_ERROR');
  }
  return value.trim();
}

function optionalWhatsappPhone(value) {
  if (value == null || (typeof value === 'string' && value.trim() === '')) return null;
  if (typeof value !== 'string' || value.length > 32) {
    throw fail(400, 'No WA peserta tidak valid. Gunakan format nomor WhatsApp yang benar.', 'VALIDATION_ERROR');
  }
  const phone = normalizeWhatsappPhone(value);
  if (!phone) throw fail(400, 'No WA peserta tidak valid. Gunakan format nomor WhatsApp yang benar.', 'VALIDATION_ERROR');
  return phone;
}

function scopedClassroom(user, classroomId) {
  if (user.classroom_id !== null && String(classroomId) !== user.classroom_id) {
    throw fail(403, 'Akses kelas di luar cakupan akun ditolak.', 'FORBIDDEN');
  }
}

function validatePermissions(permissions, ownedPermissions) {
  if (!Array.isArray(permissions) || permissions.some((permission) =>
    typeof permission !== 'string' || !ALLOWED_PERMISSIONS.has(permission))) {
    throw fail(400, 'Daftar permission tidak valid.', 'VALIDATION_ERROR');
  }
  const normalizedPermissions = normalizeSchoolPermissions(permissions);
  if (new Set(permissions).size !== permissions.length ||
      normalizedPermissions.some((permission) => !hasSchoolPermission(ownedPermissions, permission))) {
    throw fail(403, 'Role tidak dapat memberi permission yang tidak dimiliki pengelola.', 'FORBIDDEN');
  }
  return normalizedPermissions;
}

function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

function validateSchoolGatewaySettings(body) {
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

function requireBillingAdmin(req) {
  if (req.schoolUser.role_key !== 'admin-sekolah') {
    throw fail(403, 'Hanya Admin Sekolah yang dapat mengelola langganan.', 'FORBIDDEN');
  }
}

function requireSchoolAdmin(req) {
  if (req.schoolUser.role_key !== 'admin-sekolah') {
    throw fail(403, 'Hanya Admin Sekolah yang dapat mengelola backup.', 'FORBIDDEN');
  }
}

async function loadAttendanceSettings(schoolId) {
  const [[base]] = await pool.execute(
    `SELECT timezone, check_in_deadline, lateness_tolerance_minutes, check_out_start,
            scan_cooldown_minutes
       FROM operational_settings WHERE sekolah_id = ?`,
    [schoolId],
  );
  if (!base) throw fail(500, 'Pengaturan operasional sekolah belum tersedia.', 'CONFIGURATION_ERROR');
  const [weekly] = await pool.execute(
    `SELECT weekday, is_working_day, check_in_deadline,
            lateness_tolerance_minutes, check_out_start
       FROM weekly_operational_schedules WHERE sekolah_id = ?`,
    [schoolId],
  );
  const [holidays] = await pool.execute(
    'SELECT holiday_date AS date, name FROM school_holidays WHERE sekolah_id = ?',
    [schoolId],
  );
  const [participantOverrides] = await pool.execute(
    `SELECT participant_id, weekday, check_in_deadline
       FROM participant_operational_overrides WHERE sekolah_id = ?`,
    [schoolId],
  );
  return {
    ...base,
    weekly_schedules: weekly,
    holidays,
    participant_overrides: participantOverrides,
  };
}

router.post('/auth/register/start', asyncRoute(async (req, res) => {
  requireFields(req.body, ['school_name', 'username', 'whatsapp_phone', 'password']);
  const schoolName = string(req.body.school_name, 'Nama sekolah', 180);
  const username = string(req.body.username, 'Username', 80);
  if (!validateRegistrationUsername(username)) {
    throw fail(400, 'Username harus terdiri dari 3-80 huruf, angka, titik, garis bawah, atau tanda hubung.', 'VALIDATION_ERROR');
  }
  const phone = normalizeWhatsappPhone(req.body.whatsapp_phone);
  if (!phone) throw fail(400, 'Nomor WhatsApp tidak valid.', 'VALIDATION_ERROR');
  if (!validateRegistrationPassword(req.body.password)) {
    throw fail(400, 'Kata sandi minimal 8 karakter dan wajib memiliki huruf besar, angka, serta simbol.', 'VALIDATION_ERROR');
  }

  const [registeredUsers] = await pool.execute(
    `SELECT u.id
       FROM users u
       JOIN schools s ON s.id = u.sekolah_id
      WHERE u.whatsapp_phone = ?
      LIMIT 1`,
    [phone],
  );
  const [[superAdmin]] = await pool.execute(
    `SELECT id FROM super_admins
      WHERE whatsapp_phone = ? AND is_active = TRUE
      LIMIT 1`,
    [phone],
  );
  if (registeredUsers.length || superAdmin) {
    throw fail(
      409,
      'Nomor WhatsApp sudah terdaftar pada akun sekolah lain. Gunakan nomor WhatsApp yang belum digunakan.',
      'PHONE_ALREADY_REGISTERED',
    );
  }

  const [[gateway]] = await pool.execute(
    `SELECT endpoint_url, token_ciphertext, token_iv, token_auth_tag, is_enabled
       FROM whatsapp_gateway_config WHERE id = 1`,
  );
  if (!gateway?.is_enabled || !gateway.endpoint_url || !gateway.token_ciphertext) {
    throw fail(503, 'Pendaftaran sekolah belum tersedia karena gateway WhatsApp belum diaktifkan.', 'REGISTRATION_UNAVAILABLE');
  }

  const ipHash = hashRegistrationIp(req.ip ?? req.socket.remoteAddress ?? 'unknown', config.jwtSecret);
  await pool.execute(
    'DELETE FROM school_registration_challenges WHERE created_at < UTC_TIMESTAMP() - INTERVAL 1 DAY',
  );
  await enforceOtpRequestLimit({
    challengeTable: 'school_registration_challenges',
    phone,
    ipHash,
    message: 'Batas permintaan OTP tercapai.',
    errorCode: 'OTP_RATE_LIMITED',
  });

  const challengeId = randomUUID();
  const otp = createRegistrationOtp();
  const passwordHash = await hashPassword(req.body.password);
  await pool.execute(
    `INSERT INTO school_registration_challenges
      (id, school_name, admin_name, admin_username, whatsapp_phone, password_hash,
       otp_hash, expires_at, request_ip_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP() + INTERVAL 5 MINUTE, ?)`,
    [challengeId, schoolName, username, username, phone, passwordHash,
      hashRegistrationOtp(challengeId, otp, config.jwtSecret), ipHash],
  );

  let delivery;
  try {
    delivery = await sendWhatsappMessage(
      gateway.endpoint_url,
      decryptGatewayToken(gateway),
      phone,
      `Kode verifikasi Ruang Hadir: ${otp}. Berlaku 5 menit. Jangan bagikan kode ini kepada siapa pun.`,
    );
  } catch (error) {
    await pool.execute(
      'UPDATE school_registration_challenges SET attempt_count = 5 WHERE id = ?',
      [challengeId],
    );
    throw error;
  }
  res.status(202).json({
    challenge_id: challengeId,
    expires_in_seconds: 300,
    delivery_status: delivery.deliveryConfirmed ? 'delivered' : 'accepted',
    message: `OTP berhasil dikirim ke WhatsApp nomor ${phone}. Periksa pesan masuk di WhatsApp.`,
  });
}));

router.post('/auth/register/verify', asyncRoute(async (req, res) => {
  requireFields(req.body, ['challenge_id', 'otp']);
  if (typeof req.body.challenge_id !== 'string' || !UUID.test(req.body.challenge_id) ||
      typeof req.body.otp !== 'string' || !/^\d{6}$/.test(req.body.otp)) {
    throw fail(400, 'ID pendaftaran atau OTP tidak valid.', 'VALIDATION_ERROR');
  }
  const result = await inTransaction(async (connection) => {
    const [[challenge]] = await connection.execute(
      `SELECT id, school_name, admin_name, admin_username, whatsapp_phone, password_hash,
              otp_hash, expires_at > UTC_TIMESTAMP() AS otp_is_valid,
              attempt_count, verified_at
         FROM school_registration_challenges WHERE id = ? FOR UPDATE`,
      [req.body.challenge_id],
    );
    if (!challenge || challenge.verified_at ||
        !challenge.otp_is_valid ||
        Number(challenge.attempt_count) >= 5) {
      return { error: 'OTP tidak valid atau sudah kedaluwarsa.' };
    }
    if (!equalOtpHash(
      hashRegistrationOtp(challenge.id, req.body.otp, config.jwtSecret),
      challenge.otp_hash,
    )) {
      await connection.execute(
        'UPDATE school_registration_challenges SET attempt_count = attempt_count + 1 WHERE id = ?',
        [challenge.id],
      );
      return { error: 'OTP tidak valid atau sudah kedaluwarsa.' };
    }

    const [registeredUsers] = await connection.execute(
      'SELECT id FROM users WHERE whatsapp_phone = ? LIMIT 1',
      [challenge.whatsapp_phone],
    );
    const [[superAdmin]] = await connection.execute(
      'SELECT id FROM super_admins WHERE whatsapp_phone = ? AND is_active = TRUE LIMIT 1',
      [challenge.whatsapp_phone],
    );
    if (registeredUsers.length || superAdmin) {
      return {
        conflict: 'Nomor WhatsApp sudah terdaftar pada akun sekolah lain. Gunakan nomor WhatsApp yang belum digunakan.',
      };
    }

    const schoolCode = await generateUniqueSchoolCode({
      isTaken: async (code) => {
        const [rows] = await connection.execute(
          'SELECT 1 FROM schools WHERE school_code = ? LIMIT 1',
          [code],
        );
        return rows.length > 0;
      },
    });
    const schoolId = await provisionSchool(connection, {
      slug: registrationSlug(challenge.school_name, schoolCode),
      schoolCode,
      name: challenge.school_name,
      adminUsername: challenge.admin_username ?? challenge.whatsapp_phone,
      adminName: challenge.admin_name,
      adminPhone: challenge.whatsapp_phone,
      passwordHash: challenge.password_hash,
    });
    await connection.execute(
      'UPDATE school_registration_challenges SET verified_at = UTC_TIMESTAMP() WHERE id = ?',
      [challenge.id],
    );
    return {
      school: { id: schoolId, name: challenge.school_name, school_code: schoolCode },
      admin_username: challenge.admin_username ?? challenge.whatsapp_phone,
    };
  });
  if (result.conflict) {
    throw fail(409, result.conflict, 'PHONE_ALREADY_REGISTERED');
  }
  if (result.error) throw fail(400, result.error, 'INVALID_OTP');
  res.status(201).json({
    ...result,
    message: 'Pendaftaran berhasil. Simpan kode sekolah dan gunakan username yang Anda daftarkan.',
  });
}));

router.post('/auth/password-reset/start', asyncRoute(async (req, res) => {
  requireFields(req.body, ['school_code', 'whatsapp_phone']);
  if (typeof req.body.school_code !== 'string' || !/^\d{4}$/.test(req.body.school_code)) {
    throw fail(400, 'Kode sekolah tidak valid.', 'VALIDATION_ERROR');
  }
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
    'DELETE FROM school_password_reset_challenges WHERE created_at < UTC_TIMESTAMP() - INTERVAL 1 DAY',
  );
  await enforceOtpRequestLimit({
    challengeTable: 'school_password_reset_challenges',
    phone,
    ipHash,
    message: 'Batas permintaan reset tercapai.',
    errorCode: 'RESET_RATE_LIMITED',
  });

  const [[school]] = await pool.execute(
    `SELECT id FROM schools
      WHERE school_code = ? AND is_active = TRUE AND subscription_status <> 'suspend'
      LIMIT 1`,
    [req.body.school_code],
  );
  if (!school) {
    throw fail(404, 'Kode sekolah tidak valid atau sekolah tidak aktif.', 'SCHOOL_NOT_FOUND');
  }
  const [accounts] = await pool.execute(
    `SELECT id, sekolah_id FROM users
      WHERE sekolah_id = ? AND whatsapp_phone = ? AND is_active = TRUE
      LIMIT 1`,
    [school.id, phone],
  );
  const account = accounts[0];
  if (!account) {
    throw fail(404, 'Nomor WhatsApp tidak terdaftar pada sekolah aktif.', 'ACCOUNT_PHONE_NOT_FOUND');
  }
  const challengeId = randomUUID();
  const otp = createRegistrationOtp();
  await pool.execute(
    `INSERT INTO school_password_reset_challenges
      (id, school_code, sekolah_id, user_id, whatsapp_phone, otp_hash, expires_at, request_ip_hash)
     VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP() + INTERVAL 5 MINUTE, ?)`,
    [challengeId, req.body.school_code, account.sekolah_id, account.id,
      phone, hashRegistrationOtp(challengeId, otp, config.jwtSecret), ipHash],
  );

  try {
    await sendWhatsappMessage(
      gateway.endpoint_url,
      decryptGatewayToken(gateway),
      phone,
      `Kode reset kata sandi Ruang Hadir: ${otp}. Berlaku 5 menit. Jangan bagikan kode ini kepada siapa pun.`,
    );
  } catch (error) {
    await pool.execute(
      'UPDATE school_password_reset_challenges SET attempt_count = 5 WHERE id = ?',
      [challengeId],
    );
    throw error;
  }

  res.status(202).json({
    challenge_id: challengeId,
    expires_in_seconds: 300,
    message: `Kode OTP sudah dikirim ke WhatsApp nomor ${phone}.`,
  });
}));

router.post('/auth/password-reset/verify', asyncRoute(async (req, res) => {
  requireFields(req.body, ['challenge_id', 'otp', 'password']);
  if (typeof req.body.challenge_id !== 'string' || !UUID.test(req.body.challenge_id) ||
      typeof req.body.otp !== 'string' || !/^\d{6}$/.test(req.body.otp)) {
    throw fail(400, 'ID permintaan atau OTP tidak valid.', 'VALIDATION_ERROR');
  }
  if (!validateRegistrationPassword(req.body.password)) {
    throw fail(400, 'Kata sandi minimal 8 karakter dan wajib memiliki huruf besar, angka, serta simbol.', 'VALIDATION_ERROR');
  }

  const result = await inTransaction(async (connection) => {
    const [[challenge]] = await connection.execute(
      `SELECT id, sekolah_id, user_id, otp_hash,
              expires_at > UTC_TIMESTAMP() AS otp_is_valid,
              attempt_count, completed_at
         FROM school_password_reset_challenges WHERE id = ? FOR UPDATE`,
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
        'UPDATE school_password_reset_challenges SET attempt_count = attempt_count + 1 WHERE id = ?',
        [challenge.id],
      );
      return { error: 'Kode verifikasi tidak valid atau sudah kedaluwarsa.' };
    }
    if (!challenge.user_id || !challenge.sekolah_id) {
      return { error: 'Kode verifikasi tidak valid atau sudah kedaluwarsa.' };
    }

    const passwordHash = await hashPassword(req.body.password);
    const [update] = await connection.execute(
      `UPDATE users SET password_hash = ?, auth_version = auth_version + 1
        WHERE id = ? AND sekolah_id = ? AND is_active = TRUE`,
      [passwordHash, challenge.user_id, challenge.sekolah_id],
    );
    if (update.affectedRows !== 1) {
      return { error: 'Kode verifikasi tidak valid atau sudah kedaluwarsa.' };
    }
    await connection.execute(
      `UPDATE school_password_reset_challenges
          SET completed_at = UTC_TIMESTAMP()
        WHERE user_id = ? AND completed_at IS NULL`,
      [challenge.user_id],
    );
    return { success: true };
  });
  if (result.error) throw fail(400, result.error, 'INVALID_OTP');
  res.json({ message: 'Kata sandi berhasil direset. Silakan masuk dengan kata sandi baru.' });
}));

router.post('/auth/login', asyncRoute(async (req, res) => {
  requireFields(req.body, ['school_code', 'username', 'password']);
  if (typeof req.body.school_code !== 'string' || !/^\d{4}$/.test(req.body.school_code)) {
    throw fail(401, 'Kode sekolah, username, atau password tidak benar.', 'INVALID_CREDENTIALS');
  }
  const [rows] = await pool.execute(
    `SELECT u.id, u.sekolah_id, u.username, u.display_name, u.whatsapp_phone, u.password_hash, u.auth_version,
            u.is_active, s.school_code, s.name AS school_name, s.timezone,
            s.subscription_status, s.subscription_expires_at, r.role_name, r.role_key
       FROM schools s JOIN users u ON u.sekolah_id = s.id
       JOIN roles r ON r.id = u.role_id AND r.sekolah_id = u.sekolah_id
      WHERE s.school_code = ? AND u.username = ? AND s.is_active = TRUE
        AND s.subscription_status <> 'suspend'`,
    [req.body.school_code, req.body.username],
  );
  const user = rows[0];
  const valid = await verifyPassword(req.body.password, user?.password_hash);
  if (!user || !user.is_active || !valid) {
    throw fail(401, 'Kode sekolah, username, atau password tidak benar.', 'INVALID_CREDENTIALS');
  }
  res.json({
    access_token: signToken({
      kind: 'school_user',
      sub: String(user.id),
      schoolId: String(user.sekolah_id),
      schoolCode: user.school_code,
      authVersion: Number(user.auth_version ?? 0),
    }, config.schoolJwtTtl),
    token_type: 'Bearer',
    expires_in: config.schoolJwtTtl,
    user: {
      id: String(user.id), username: user.username, display_name: user.display_name,
      role_name: user.role_name,
    },
    school: {
      id: String(user.sekolah_id), school_code: user.school_code,
      name: user.school_name, timezone: user.timezone,
      subscription_status: user.subscription_status,
    },
  });
}));

router.get('/auth/me', requireSchoolUser, (req, res) => {
  const user = req.schoolUser;
  res.json({
    user: {
      id: String(user.id), username: user.username, display_name: user.display_name,
      role_id: String(user.role_id), role_name: user.role_name,
      classroom_id: user.classroom_id, permissions: user.permissions,
      role_key: user.role_key,
      subscription_expired: user.subscription_expired,
    },
    school: {
      id: user.sekolah_id, school_code: user.school_code,
      name: user.school_name, timezone: user.timezone,
      subscription_status: user.subscription_status,
      subscription_expired: user.subscription_expired,
    },
  });
});

router.get('/roles', requireSchoolUser, requirePermission('school.roles.view'), asyncRoute(async (req, res) => {
  const [rows] = await pool.execute(
    `SELECT id, role_key, role_name, permissions, is_system
       FROM roles WHERE sekolah_id = ? ORDER BY id`,
    [req.schoolUser.sekolah_id],
  );
  res.json({ roles: rows.map((row) => ({ ...row, permissions: parseJson(row.permissions) })) });
}));

router.post('/roles', requireSchoolUser, requirePermission('school.roles.edit'), asyncRoute(async (req, res) => {
  requireFields(req.body, ['role_key', 'role_name', 'permissions']);
  const roleKey = string(req.body.role_key, 'role_key', 80).toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(roleKey) || DEFAULT_ROLES.includes(roleKey)) {
    throw fail(400, 'role_key tidak valid atau telah dicadangkan.', 'VALIDATION_ERROR');
  }
  const permissions = validatePermissions(req.body.permissions, req.schoolUser.permissions);
  const [result] = await pool.execute(
    `INSERT INTO roles (sekolah_id, role_key, role_name, permissions, is_system)
     VALUES (?, ?, ?, ?, FALSE)`,
    [req.schoolUser.sekolah_id, roleKey, string(req.body.role_name, 'role_name', 100),
      JSON.stringify(permissions)],
  );
  res.status(201).json({
    role: { id: String(result.insertId), role_key: roleKey, role_name: req.body.role_name.trim(), permissions },
  });
}));

const updateRole = asyncRoute(async (req, res) => {
  const roleId = req.params.id ?? req.body?.role_id;
  if (!/^[1-9]\d*$/.test(String(roleId ?? ''))) throw fail(400, 'role_id wajib diisi.', 'VALIDATION_ERROR');
  const fields = Object.keys(req.body ?? {});
  if (!fields.length || fields.some((key) => !['role_id', 'role_name', 'permissions'].includes(key)) ||
      fields.every((key) => key === 'role_id')) {
    throw fail(400, 'Field perubahan role tidak valid.', 'VALIDATION_ERROR');
  }
  const [found] = await pool.execute(
    'SELECT id, role_key, is_system FROM roles WHERE sekolah_id = ? AND id = ?',
    [req.schoolUser.sekolah_id, roleId],
  );
  if (!found.length) throw fail(404, 'Role tidak ditemukan.', 'NOT_FOUND');
  if (found[0].is_system && req.body.role_name !== undefined) {
    throw fail(403, 'Nama role sistem tidak dapat diubah.', 'FORBIDDEN');
  }
  const updates = [];
  const values = [];
  if (req.body.role_name !== undefined) {
    updates.push('role_name = ?');
    values.push(string(req.body.role_name, 'role_name', 100));
  }
  if (req.body.permissions !== undefined) {
    updates.push('permissions = ?');
    values.push(JSON.stringify(validatePermissions(req.body.permissions, req.schoolUser.permissions)));
  }
  await pool.execute(
    `UPDATE roles SET ${updates.join(', ')} WHERE sekolah_id = ? AND id = ?`,
    [...values, req.schoolUser.sekolah_id, roleId],
  );
  const [[role]] = await pool.execute(
    'SELECT id, role_key, role_name, permissions, is_system FROM roles WHERE sekolah_id = ? AND id = ?',
    [req.schoolUser.sekolah_id, roleId],
  );
  role.permissions = parseJson(role.permissions);
  res.json({ role });
});
router.patch('/roles/:id', requireSchoolUser, requirePermission('school.roles.edit'), updateRole);
router.patch('/roles', requireSchoolUser, requirePermission('school.roles.edit'), updateRole);

router.delete('/roles/:id', requireSchoolUser, requirePermission('school.roles.delete'), asyncRoute(async (req, res) => {
  const roleId = req.params.id;
  if (!/^[1-9]\d*$/.test(roleId)) throw fail(400, 'role_id tidak valid.', 'VALIDATION_ERROR');
  const [[role]] = await pool.execute(
    'SELECT id, role_key FROM roles WHERE sekolah_id = ? AND id = ?',
    [req.schoolUser.sekolah_id, roleId],
  );
  if (!role) throw fail(404, 'Role tidak ditemukan.', 'NOT_FOUND');
  if (!canDeleteSchoolRole(role.role_key)) {
    throw fail(403, 'Role Admin Sekolah tidak dapat dihapus.', 'FORBIDDEN');
  }
  const [users] = await pool.execute(
    'SELECT id FROM users WHERE sekolah_id = ? AND role_id = ? LIMIT 1',
    [req.schoolUser.sekolah_id, roleId],
  );
  if (users.length) throw fail(409, 'Pindahkan akun dari role ini sebelum menghapusnya.', 'CONFLICT');
  await pool.execute('DELETE FROM roles WHERE sekolah_id = ? AND id = ?', [
    req.schoolUser.sekolah_id, roleId,
  ]);
  res.status(204).end();
}));

router.get('/users', requireSchoolUser, requirePermission('school.users.view'), asyncRoute(async (req, res) => {
  const scope = req.schoolUser.classroom_id === null ? { sql: '', params: [] }
    : { sql: ' AND u.classroom_id = ?', params: [req.schoolUser.classroom_id] };
  const [rows] = await pool.execute(
    `SELECT u.id, u.username, u.display_name, u.role_id, r.role_name,
            u.classroom_id, u.is_active, u.created_at
       FROM users u JOIN roles r ON r.id = u.role_id AND r.sekolah_id = u.sekolah_id
      WHERE u.sekolah_id = ?${scope.sql} ORDER BY u.id`,
    [req.schoolUser.sekolah_id, ...scope.params],
  );
  res.json({ users: rows });
}));

router.post('/users', requireSchoolUser, requirePermission('school.users.edit'), asyncRoute(async (req, res) => {
  requireFields(req.body, ['role_id', 'username', 'display_name', 'password']);
  if (typeof req.body.password !== 'string' || req.body.password.length < 12 ||
      req.body.password.length > 1024) throw fail(400, 'Password wajib 12–1024 karakter.', 'VALIDATION_ERROR');
  const username = string(req.body.username, 'username', 80);
  if (!/^[A-Za-z0-9._-]+$/.test(username)) throw fail(400, 'username tidak valid.', 'VALIDATION_ERROR');
  const [roles] = await pool.execute(
    'SELECT id, permissions FROM roles WHERE sekolah_id = ? AND id = ?',
    [req.schoolUser.sekolah_id, req.body.role_id],
  );
  if (!roles.length) throw fail(400, 'Role tidak ditemukan.', 'VALIDATION_ERROR');
  const rolePermissions = normalizeSchoolPermissions(parseJson(roles[0].permissions));
  if (rolePermissions.some((permission) => !hasSchoolPermission(req.schoolUser.permissions, permission))) {
    throw fail(403, 'Tidak dapat menetapkan role dengan izin lebih tinggi.', 'FORBIDDEN');
  }
  const classroomId = req.body.classroom_id ?? null;
  if (req.schoolUser.classroom_id !== null) {
    if (classroomId === null) throw fail(403, 'Akun terbatas kelas wajib menetapkan kelasnya.', 'FORBIDDEN');
    scopedClassroom(req.schoolUser, classroomId);
  }
  if (classroomId !== null) {
    const [classes] = await pool.execute(
      'SELECT id FROM classrooms WHERE sekolah_id = ? AND id = ?',
      [req.schoolUser.sekolah_id, classroomId],
    );
    if (!classes.length) throw fail(400, 'Kelas tidak ditemukan di sekolah ini.', 'VALIDATION_ERROR');
  }
  const hash = await hashPassword(req.body.password);
  const [result] = await pool.execute(
    `INSERT INTO users (sekolah_id, role_id, classroom_id, username, display_name, password_hash)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [req.schoolUser.sekolah_id, req.body.role_id, classroomId, username,
      string(req.body.display_name, 'display_name', 150), hash],
  );
  res.status(201).json({
    user: { id: String(result.insertId), username, display_name: req.body.display_name.trim(),
      role_id: String(req.body.role_id), classroom_id: classroomId == null ? null : String(classroomId) },
  });
}));

router.delete('/users/:id', requireSchoolUser, requirePermission('school.users.delete'), asyncRoute(async (req, res) => {
  const userId = req.params.id;
  if (!/^[1-9]\d*$/.test(userId)) throw fail(400, 'user_id tidak valid.', 'VALIDATION_ERROR');
  if (String(req.schoolUser.id) === userId) {
    throw fail(409, 'Akun yang sedang digunakan tidak dapat dinonaktifkan.', 'CONFLICT');
  }
  const classScope = req.schoolUser.classroom_id === null ? '' : ' AND classroom_id = ?';
  const values = [req.schoolUser.sekolah_id, userId];
  if (req.schoolUser.classroom_id !== null) values.push(req.schoolUser.classroom_id);
  const [[target]] = await pool.execute(
    `SELECT id, is_active, role_id FROM users
      WHERE sekolah_id = ? AND id = ?${classScope}`,
    values,
  );
  if (!target) throw fail(404, 'Akun tidak ditemukan.', 'NOT_FOUND');
  const [[role]] = await pool.execute(
    'SELECT role_key FROM roles WHERE sekolah_id = ? AND id = ?',
    [req.schoolUser.sekolah_id, target.role_id],
  );
  if (Number(target.is_active) && role?.role_key === 'admin-sekolah') {
    const [[remaining]] = await pool.execute(
      `SELECT COUNT(*) AS count
         FROM users u JOIN roles r ON r.id = u.role_id AND r.sekolah_id = u.sekolah_id
        WHERE u.sekolah_id = ? AND u.is_active = TRUE AND u.id <> ? AND r.role_key = 'admin-sekolah'`,
      [req.schoolUser.sekolah_id, userId],
    );
    if (Number(remaining.count) === 0) {
      throw fail(409, 'Sekolah harus memiliki minimal satu Admin Sekolah aktif.', 'CONFLICT');
    }
  }
  await pool.execute(
    'UPDATE users SET is_active = FALSE, auth_version = auth_version + 1 WHERE sekolah_id = ? AND id = ?',
    [req.schoolUser.sekolah_id, userId],
  );
  res.status(204).end();
}));

router.get('/classrooms', requireSchoolUser,
  requireAnyPermission('participants.view', 'participants.read', 'scanner.use'), asyncRoute(async (req, res) => {
  const scope = classroomScope(req.schoolUser, 'c');
  const [rows] = await pool.execute(
    `SELECT c.id, c.unit_id, c.name, u.name AS unit_name
       FROM classrooms c JOIN units u ON u.id = c.unit_id AND u.sekolah_id = c.sekolah_id
      WHERE c.sekolah_id = ?${scope.sql} ORDER BY u.name, c.name`,
    [req.schoolUser.sekolah_id, ...scope.params],
  );
  res.json({ classrooms: rows });
}));

router.post('/classrooms', requireSchoolUser, requirePermission('participants.edit'), asyncRoute(async (req, res) => {
  const name = string(req.body?.name, 'Nama kelas', 100);
  let unitId;
  if (req.body?.unit_id != null) {
    if (!/^[1-9]\d*$/.test(String(req.body.unit_id))) {
      throw fail(400, 'Unit kelas tidak valid.', 'VALIDATION_ERROR');
    }
    const [units] = await pool.execute(
      'SELECT id FROM units WHERE sekolah_id = ? AND id = ?',
      [req.schoolUser.sekolah_id, req.body.unit_id],
    );
    if (!units.length) throw fail(400, 'Unit kelas tidak ditemukan.', 'VALIDATION_ERROR');
    unitId = String(units[0].id);
  } else {
    const [units] = await pool.execute(
      'SELECT id FROM units WHERE sekolah_id = ? ORDER BY id LIMIT 1',
      [req.schoolUser.sekolah_id],
    );
    if (units.length) unitId = String(units[0].id);
    else {
      const [created] = await pool.execute(
        'INSERT INTO units (sekolah_id, name) VALUES (?, ?)',
        [req.schoolUser.sekolah_id, 'Umum'],
      );
      unitId = String(created.insertId);
    }
  }
  const [existing] = await pool.execute(
    'SELECT id FROM classrooms WHERE sekolah_id = ? AND unit_id = ? AND name = ?',
    [req.schoolUser.sekolah_id, unitId, name],
  );
  if (existing.length) throw fail(409, 'Nama kelas sudah ada.', 'CONFLICT');
  const [result] = await pool.execute(
    'INSERT INTO classrooms (sekolah_id, unit_id, name) VALUES (?, ?, ?)',
    [req.schoolUser.sekolah_id, unitId, name],
  );
  res.status(201).json({ classroom: { id: String(result.insertId), unit_id: unitId, name } });
}));

router.put('/classrooms/:id', requireSchoolUser, requirePermission('participants.edit'), asyncRoute(async (req, res) => {
  const classroomId = req.params.id;
  if (!/^[1-9]\d*$/.test(classroomId)) throw fail(400, 'ID kelas tidak valid.', 'VALIDATION_ERROR');
  const name = string(req.body?.name, 'Nama kelas', 100);
  const [found] = await pool.execute(
    'SELECT id, unit_id FROM classrooms WHERE sekolah_id = ? AND id = ?',
    [req.schoolUser.sekolah_id, classroomId],
  );
  if (!found.length) throw fail(404, 'Kelas tidak ditemukan.', 'NOT_FOUND');
  await pool.execute(
    'UPDATE classrooms SET name = ? WHERE sekolah_id = ? AND id = ?',
    [name, req.schoolUser.sekolah_id, classroomId],
  );
  res.json({ classroom: { id: classroomId, unit_id: String(found[0].unit_id), name } });
}));

router.delete('/classrooms/:id', requireSchoolUser, requirePermission('participants.delete'), asyncRoute(async (req, res) => {
  const classroomId = req.params.id;
  if (!/^[1-9]\d*$/.test(classroomId)) throw fail(400, 'ID kelas tidak valid.', 'VALIDATION_ERROR');
  const [participants] = await pool.execute(
    'SELECT id FROM participants WHERE sekolah_id = ? AND classroom_id = ? LIMIT 1',
    [req.schoolUser.sekolah_id, classroomId],
  );
  if (participants.length) throw fail(409, 'Kelas masih digunakan oleh peserta dan tidak dapat dihapus.', 'CONFLICT');
  const [users] = await pool.execute(
    'SELECT id FROM users WHERE sekolah_id = ? AND classroom_id = ? LIMIT 1',
    [req.schoolUser.sekolah_id, classroomId],
  );
  if (users.length) throw fail(409, 'Kelas masih digunakan oleh akun operator dan tidak dapat dihapus.', 'CONFLICT');
  const [result] = await pool.execute(
    'DELETE FROM classrooms WHERE sekolah_id = ? AND id = ?',
    [req.schoolUser.sekolah_id, classroomId],
  );
  if (!result.affectedRows) throw fail(404, 'Kelas tidak ditemukan.', 'NOT_FOUND');
  res.status(204).end();
}));

router.get('/participants', requireSchoolUser,
  requireAnyPermission('participants.view', 'participants.read', 'scanner.use'), asyncRoute(async (req, res) => {
  const scope = classroomScope(req.schoolUser);
  const [rows] = await pool.execute(
    `SELECT p.id, p.classroom_id, p.participant_code, p.full_name, p.qr_code,
            p.participant_phone, p.is_active, c.name AS classroom_name
       FROM participants p JOIN classrooms c ON c.id = p.classroom_id AND c.sekolah_id = p.sekolah_id
      WHERE p.sekolah_id = ?${scope.sql} ORDER BY p.full_name`,
    [req.schoolUser.sekolah_id, ...scope.params],
  );
  res.json({ participants: rows });
}));

router.post('/participants/import', requireSchoolUser, requirePermission('participants.edit'), asyncRoute(async (req, res) => {
  const records = req.body?.participants;
  if (!Array.isArray(records) || records.length < 1 || records.length > 500) {
    throw fail(400, 'participants harus berisi 1–500 baris.', 'VALIDATION_ERROR');
  }

  const connection = await pool.getConnection();
  const results = [];
  const seenCodes = new Set();
  const seenQrCodes = new Set();
  try {
    await connection.beginTransaction();
    const classroomVisibility = classroomScope(req.schoolUser, 'c');
    const [availableClassrooms] = await connection.execute(
      `SELECT c.id FROM classrooms c
        WHERE c.sekolah_id = ?${classroomVisibility.sql}`,
      [req.schoolUser.sekolah_id, ...classroomVisibility.params],
    );
    const availableClassroomIds = new Set(availableClassrooms.map((item) => String(item.id)));
    for (const [index, record] of records.entries()) {
      const sourceRow = Number(record?.source_row);
      const row = Number.isInteger(sourceRow) && sourceRow >= 2 && sourceRow <= 501
        ? sourceRow
        : index + 2;
      try {
        requireFields(record, ['classroom_id', 'full_name']);
        const classroomId = String(record.classroom_id);
        if (!/^[1-9]\d*$/.test(classroomId)) {
          throw fail(400, 'ID kelas tidak valid.', 'VALIDATION_ERROR');
        }
        if (!availableClassroomIds.has(classroomId)) {
          throw fail(400, 'Kelas tidak tersedia untuk akun ini.', 'VALIDATION_ERROR');
        }

        const participantCode = record.participant_code == null || record.participant_code === ''
          ? `AUTO-${randomUUID()}`
          : string(record.participant_code, 'Kode peserta', 60);
        const fullName = string(record.full_name, 'Nama lengkap', 150);
        const qrCode = record.qr_code == null || record.qr_code === ''
          ? `SAAS-${randomUUID()}`
          : string(record.qr_code, 'QR / Barcode', 160);
        const participantPhone = optionalWhatsappPhone(record.participant_phone);
        if (seenCodes.has(participantCode) || seenQrCodes.has(qrCode)) {
          results.push({ row, participant_code: participantCode, status: 'skipped', reason: 'Duplikat di file impor.' });
          continue;
        }
        const [existing] = await connection.execute(
          `SELECT participant_code, qr_code FROM participants
            WHERE sekolah_id = ? AND (participant_code = ? OR qr_code = ?) LIMIT 1`,
          [req.schoolUser.sekolah_id, participantCode, qrCode],
        );
        if (existing.length) {
          results.push({ row, participant_code: participantCode, status: 'skipped', reason: 'Kode peserta atau QR sudah digunakan.' });
          continue;
        }
        await connection.execute(
          `INSERT INTO participants
            (sekolah_id, classroom_id, participant_code, full_name, qr_code, participant_phone)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [req.schoolUser.sekolah_id, classroomId, participantCode, fullName, qrCode,
            participantPhone],
        );
        seenCodes.add(participantCode);
        seenQrCodes.add(qrCode);
        results.push({ row, participant_code: participantCode, status: 'imported' });
      } catch (error) {
        if (error?.code === 'ER_DUP_ENTRY') {
          results.push({ row, status: 'skipped', reason: 'Kode peserta atau QR sudah digunakan.' });
          continue;
        }
        if (error?.statusCode === 400 || error?.statusCode === 403) {
          results.push({ row, status: 'skipped', reason: error.message });
          continue;
        }
        throw error;
      }
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
  res.status(200).json({
    imported: results.filter((item) => item.status === 'imported').length,
    skipped: results.filter((item) => item.status === 'skipped').length,
    results,
  });
}));

router.post('/participants', requireSchoolUser, requirePermission('participants.edit'), asyncRoute(async (req, res) => {
  requireFields(req.body, ['classroom_id', 'full_name']);
  scopedClassroom(req.schoolUser, req.body.classroom_id);
  const [classrooms] = await pool.execute(
    'SELECT id FROM classrooms WHERE sekolah_id = ? AND id = ?',
    [req.schoolUser.sekolah_id, req.body.classroom_id],
  );
  if (!classrooms.length) throw fail(400, 'Kelas tidak ditemukan di sekolah ini.', 'VALIDATION_ERROR');
  const participantCode = req.body.participant_code == null || req.body.participant_code === ''
    ? `AUTO-${randomUUID()}`
    : string(req.body.participant_code, 'participant_code', 60);
  const fullName = string(req.body.full_name, 'full_name', 150);
  const qrCode = req.body.qr_code === undefined ? `SAAS-${randomUUID()}` : string(req.body.qr_code, 'qr_code', 160);
  const participantPhone = optionalWhatsappPhone(req.body.participant_phone);
  const [result] = await pool.execute(
    `INSERT INTO participants
      (sekolah_id, classroom_id, participant_code, full_name, qr_code, participant_phone)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [req.schoolUser.sekolah_id, req.body.classroom_id, participantCode, fullName, qrCode,
      participantPhone],
  );
  res.status(201).json({ participant: {
    id: String(result.insertId), classroom_id: String(req.body.classroom_id),
    participant_code: participantCode, full_name: fullName, qr_code: qrCode,
    participant_phone: participantPhone,
  } });
}));

router.put('/participants/:id/schedule', requireSchoolUser, requirePermission('participants.edit'), asyncRoute(async (req, res) => {
  const participantId = req.params.id;
  if (!/^[1-9]\d*$/.test(participantId)) {
    throw fail(400, 'ID peserta tidak valid.', 'VALIDATION_ERROR');
  }
  const overrides = req.body?.overrides;
  const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/;
  if (!Array.isArray(overrides) || overrides.length > 7 ||
      overrides.some((item) => !Number.isInteger(item.weekday) ||
        item.weekday < 0 || item.weekday > 6 ||
        typeof item.check_in_deadline !== 'string' ||
        !timePattern.test(item.check_in_deadline)) ||
      new Set(overrides.map((item) => item.weekday)).size !== overrides.length) {
    throw fail(400, 'Jadwal khusus peserta tidak valid.', 'VALIDATION_ERROR');
  }
  const [[participant]] = await pool.execute(
    'SELECT classroom_id FROM participants WHERE sekolah_id = ? AND id = ?',
    [req.schoolUser.sekolah_id, participantId],
  );
  if (!participant) throw fail(404, 'Peserta tidak ditemukan.', 'NOT_FOUND');
  scopedClassroom(req.schoolUser, String(participant.classroom_id));

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute(
      'DELETE FROM participant_operational_overrides WHERE sekolah_id = ? AND participant_id = ?',
      [req.schoolUser.sekolah_id, participantId],
    );
    for (const item of overrides) {
      await connection.execute(
        `INSERT INTO participant_operational_overrides
          (sekolah_id, participant_id, weekday, check_in_deadline)
         VALUES (?, ?, ?, ?)`,
        [req.schoolUser.sekolah_id, participantId, item.weekday, item.check_in_deadline],
      );
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
  res.json({ message: 'Jadwal khusus peserta diperbarui.', overrides });
}));

const updateParticipant = asyncRoute(async (req, res) => {
  const participantId = req.params.id ?? req.body?.id;
  if (!/^[1-9]\d*$/.test(String(participantId ?? ''))) {
    throw fail(400, 'id peserta wajib diisi.', 'VALIDATION_ERROR');
  }
  const allowed = ['classroom_id', 'participant_code', 'full_name', 'qr_code',
    'participant_phone', 'is_active'];
  const entries = Object.entries(req.body ?? {}).filter(([key]) => key !== 'id');
  if (!entries.length || entries.some(([key]) => !allowed.includes(key))) {
    throw fail(400, 'Field perubahan peserta tidak valid.', 'VALIDATION_ERROR');
  }
  const [found] = await pool.execute(
    'SELECT id, classroom_id FROM participants WHERE sekolah_id = ? AND id = ?',
    [req.schoolUser.sekolah_id, participantId],
  );
  if (!found.length) throw fail(404, 'Peserta tidak ditemukan.', 'NOT_FOUND');
  scopedClassroom(req.schoolUser, found[0].classroom_id);
  const updates = [];
  const values = [];
  for (const [key, value] of entries) {
    if (key === 'classroom_id') {
      scopedClassroom(req.schoolUser, value);
      const [classes] = await pool.execute(
        'SELECT id FROM classrooms WHERE sekolah_id = ? AND id = ?',
        [req.schoolUser.sekolah_id, value],
      );
      if (!classes.length) throw fail(400, 'Kelas tidak ditemukan di sekolah ini.', 'VALIDATION_ERROR');
      values.push(value);
    } else if (key === 'is_active') {
      if (typeof value !== 'boolean') throw fail(400, 'is_active harus boolean.', 'VALIDATION_ERROR');
      values.push(value);
    } else if (key === 'participant_phone') values.push(optionalWhatsappPhone(value));
    else values.push(string(value, key, key === 'participant_code' ? 60 : key === 'qr_code' ? 160 : 150));
    updates.push(`\`${key}\` = ?`);
  }
  await pool.execute(
    `UPDATE participants SET ${updates.join(', ')} WHERE sekolah_id = ? AND id = ?`,
    [...values, req.schoolUser.sekolah_id, participantId],
  );
  const [[participant]] = await pool.execute(
    `SELECT id, classroom_id, participant_code, full_name, qr_code,
            participant_phone, is_active
       FROM participants WHERE sekolah_id = ? AND id = ?`,
    [req.schoolUser.sekolah_id, participantId],
  );
  res.json({ participant });
});
router.put('/participants/:id', requireSchoolUser, requirePermission('participants.edit'), updateParticipant);
router.put('/participants', requireSchoolUser, requirePermission('participants.edit'), updateParticipant);

const deleteParticipant = asyncRoute(async (req, res) => {
  const participantId = req.params.id ?? req.body?.id ?? req.query.id;
  if (!/^[1-9]\d*$/.test(String(participantId ?? ''))) {
    throw fail(400, 'id peserta wajib diisi.', 'VALIDATION_ERROR');
  }
  const [found] = await pool.execute(
    'SELECT classroom_id FROM participants WHERE sekolah_id = ? AND id = ?',
    [req.schoolUser.sekolah_id, participantId],
  );
  if (!found.length) throw fail(404, 'Peserta tidak ditemukan.', 'NOT_FOUND');
  scopedClassroom(req.schoolUser, found[0].classroom_id);
  let result;
  try {
    [result] = await pool.execute(
      'DELETE FROM participants WHERE sekolah_id = ? AND id = ?',
      [req.schoolUser.sekolah_id, participantId],
    );
  } catch (error) {
    if (error?.code === 'ER_ROW_IS_REFERENCED_2' || error?.code === 'ER_ROW_IS_REFERENCED') {
      throw fail(409, 'Peserta memiliki riwayat atau data terkait sehingga tidak dapat dihapus.', 'CONFLICT');
    }
    throw error;
  }
  if (!result.affectedRows) throw fail(409, 'Peserta telah memiliki data terkait dan tidak dapat dihapus.', 'CONFLICT');
  res.status(204).end();
});
router.delete('/participants/:id', requireSchoolUser, requirePermission('participants.delete'), deleteParticipant);
router.delete('/participants', requireSchoolUser, requirePermission('participants.delete'), deleteParticipant);

router.get('/branding', requireSchoolUser, asyncRoute(async (req, res) => {
  const [[branding]] = await pool.execute(
    `SELECT application_name, logo_mime_type, logo_data, theme
       FROM school_branding_config WHERE sekolah_id = ?`,
    [req.schoolUser.sekolah_id],
  );
  res.json({
    branding: {
      application_name: branding?.application_name ?? req.schoolUser.school_name,
      logo_data_url: branding?.logo_data && branding.logo_mime_type
        ? `data:${branding.logo_mime_type};base64,${Buffer.from(branding.logo_data).toString('base64')}`
        : null,
      theme: branding?.theme ?? 'current',
    },
  });
}));

router.put('/branding', requireSchoolUser, requirePermission('settings.operational.edit'), asyncRoute(async (req, res) => {
  const applicationName = string(req.body?.application_name, 'Nama aplikasi', 120);
  const [[existingBranding]] = await pool.execute(
    'SELECT theme FROM school_branding_config WHERE sekolah_id = ?',
    [req.schoolUser.sekolah_id],
  );
  const theme = req.body?.theme ?? existingBranding?.theme ?? 'current';
  if (!['current', 'orange', 'white', 'white_blue'].includes(theme)) {
    throw fail(400, 'Tema aplikasi tidak valid.', 'VALIDATION_ERROR');
  }
  const logoDataUrl = req.body?.logo_data_url;
  if (logoDataUrl !== undefined && logoDataUrl !== null && logoDataUrl !== '') {
    const { mimeType, data } = parseLogoDataUrl(logoDataUrl);
    await pool.execute(
      `INSERT INTO school_branding_config
         (sekolah_id, application_name, logo_mime_type, logo_data, theme)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE application_name = VALUES(application_name),
                               logo_mime_type = VALUES(logo_mime_type),
                               logo_data = VALUES(logo_data), theme = VALUES(theme)`,
      [req.schoolUser.sekolah_id, applicationName, mimeType, data, theme],
    );
  } else {
    await pool.execute(
      `INSERT INTO school_branding_config (sekolah_id, application_name, theme)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE application_name = VALUES(application_name), theme = VALUES(theme)`,
      [req.schoolUser.sekolah_id, applicationName, theme],
    );
  }
  const [[branding]] = await pool.execute(
    `SELECT application_name, logo_mime_type, logo_data, theme
       FROM school_branding_config WHERE sekolah_id = ?`,
    [req.schoolUser.sekolah_id],
  );
  res.json({
    branding: {
      application_name: branding.application_name,
      logo_data_url: branding.logo_data && branding.logo_mime_type
        ? `data:${branding.logo_mime_type};base64,${Buffer.from(branding.logo_data).toString('base64')}`
        : null,
      theme: branding.theme,
    },
    message: 'Identitas aplikasi sekolah berhasil disimpan.',
  });
}));

router.delete('/branding/logo', requireSchoolUser,
  requirePermission('settings.operational.edit'), asyncRoute(async (req, res) => {
    await pool.execute(
      `UPDATE school_branding_config
          SET logo_mime_type = NULL, logo_data = NULL
        WHERE sekolah_id = ?`,
      [req.schoolUser.sekolah_id],
    );
    res.json({ message: 'Logo sekolah dihapus.' });
  }));

router.get('/settings', requireSchoolUser,
  requireAnyPermission('settings.operational.view', 'participants.view', 'participants.read', 'participants.manage', 'scanner.use'), asyncRoute(async (req, res) => {
  const [[settings]] = await pool.execute(
    `SELECT timezone, check_in_deadline, lateness_tolerance_minutes, check_out_start,
            scan_cooldown_minutes, scan_welcome_message, scan_success_message, scan_failure_message,
            scanner_pin_hash IS NOT NULL AS scanner_pin_configured
       FROM operational_settings WHERE sekolah_id = ?`,
    [req.schoolUser.sekolah_id],
  );
  if (!settings) throw fail(500, 'Pengaturan operasional belum tersedia.', 'CONFIGURATION_ERROR');
  const [schedules] = await pool.execute(
    `SELECT weekday, is_working_day, check_in_deadline, lateness_tolerance_minutes, check_out_start
       FROM weekly_operational_schedules WHERE sekolah_id = ? ORDER BY weekday`,
    [req.schoolUser.sekolah_id],
  );
  const [holidays] = await pool.execute(
    `SELECT holiday_date AS date, name FROM school_holidays
      WHERE sekolah_id = ? ORDER BY holiday_date`,
    [req.schoolUser.sekolah_id],
  );
  const overrideScope = classroomScope(req.schoolUser, 'p');
  const [participantOverrides] = await pool.execute(
    `SELECT o.participant_id, o.weekday, o.check_in_deadline
       FROM participant_operational_overrides o
       JOIN participants p
         ON p.id = o.participant_id AND p.sekolah_id = o.sekolah_id
      WHERE o.sekolah_id = ?${overrideScope.sql}
      ORDER BY o.participant_id, o.weekday`,
    [req.schoolUser.sekolah_id, ...overrideScope.params],
  );
  res.json({
    settings: {
      ...settings,
      weekly_schedules: schedules,
      holidays,
      participant_overrides: participantOverrides,
    },
  });
}));

router.put('/settings', requireSchoolUser, requirePermission('settings.operational.edit'), asyncRoute(async (req, res) => {
  const body = req.body ?? {};
  const timezone = body.timezone ?? req.schoolUser.timezone;
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }); } catch { throw fail(400, 'Timezone tidak valid.'); }
  const tolerance = body.lateness_tolerance_minutes ?? 0;
  if (!Number.isInteger(tolerance) || tolerance < 0 || tolerance > 180) throw fail(400, 'Toleransi harus 0–180 menit.');
  const scanCooldownMinutes = body.scan_cooldown_minutes;
  if (scanCooldownMinutes !== undefined &&
      (!Number.isInteger(scanCooldownMinutes) || scanCooldownMinutes < 1 || scanCooldownMinutes > 60)) {
    throw fail(400, 'Jeda scan harus antara 1 dan 60 menit.', 'VALIDATION_ERROR');
  }
  const checkIn = body.check_in_deadline ?? '08:00:00';
  const checkOut = body.check_out_start ?? '15:00:00';
  const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/;
  if (!timePattern.test(checkIn) || !timePattern.test(checkOut)) throw fail(400, 'Format jam harus HH:mm[:ss].');
  const scanMessages = ['scan_welcome_message', 'scan_success_message', 'scan_failure_message'].map((field) => {
    const value = body[field];
    if (value === undefined) return null;
    if (typeof value !== 'string' || !value.trim() || value.length > 255) {
      throw fail(400, `Teks ${field} harus diisi dan maksimal 255 karakter.`, 'VALIDATION_ERROR');
    }
    return value.trim();
  });
  if (body.scanner_pin !== undefined && body.scanner_pin !== null && body.scanner_pin !== '' &&
      (typeof body.scanner_pin !== 'string' || !/^\d{4,6}$/.test(body.scanner_pin))) {
    throw fail(400, 'PIN scanner harus terdiri dari 4–6 angka.', 'VALIDATION_ERROR');
  }
  const schedules = body.weekly_schedules ?? [];
  const holidays = body.holidays ?? [];
  if (!Array.isArray(schedules) || schedules.some((item) =>
    !Number.isInteger(item.weekday) || item.weekday < 0 || item.weekday > 6 ||
    ![true, false, 0, 1].includes(item.is_working_day) ||
    (item.lateness_tolerance_minutes !== undefined &&
      (!Number.isInteger(item.lateness_tolerance_minutes) || item.lateness_tolerance_minutes < 0 || item.lateness_tolerance_minutes > 180)) ||
    (item.check_in_deadline !== undefined && !timePattern.test(item.check_in_deadline)) ||
    (item.check_out_start !== undefined && !timePattern.test(item.check_out_start))) ||
    new Set(schedules.map((item) => item.weekday)).size !== schedules.length) {
    throw fail(400, 'Jadwal mingguan tidak valid.', 'VALIDATION_ERROR');
  }
  if (!Array.isArray(holidays) || holidays.some((item) =>
    !validDate(item.date) || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 150) ||
    new Set(holidays.map((item) => item.date)).size !== holidays.length) {
    throw fail(400, 'Daftar hari libur tidak valid.', 'VALIDATION_ERROR');
  }
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute(
      `UPDATE operational_settings SET timezone = ?, check_in_deadline = ?,
        lateness_tolerance_minutes = ?, check_out_start = ?,
        scan_cooldown_minutes = COALESCE(?, scan_cooldown_minutes),
        scan_welcome_message = COALESCE(?, scan_welcome_message),
        scan_success_message = COALESCE(?, scan_success_message),
        scan_failure_message = COALESCE(?, scan_failure_message),
        updated_by = ?
       WHERE sekolah_id = ?`,
      [
        timezone,
        checkIn,
        tolerance,
        checkOut,
        scanCooldownMinutes ?? null,
        ...scanMessages,
        req.schoolUser.id,
        req.schoolUser.sekolah_id,
      ],
    );
    if (typeof body.scanner_pin === 'string' && /^\d{4,6}$/.test(body.scanner_pin)) {
      await connection.execute(
        'UPDATE operational_settings SET scanner_pin_hash = ? WHERE sekolah_id = ?',
        [await hashPassword(body.scanner_pin), req.schoolUser.sekolah_id],
      );
    }
    for (const item of schedules) {
      await connection.execute(
        `INSERT INTO weekly_operational_schedules
          (sekolah_id, weekday, is_working_day, check_in_deadline,
           lateness_tolerance_minutes, check_out_start)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE is_working_day = VALUES(is_working_day),
           check_in_deadline = VALUES(check_in_deadline),
           lateness_tolerance_minutes = VALUES(lateness_tolerance_minutes),
           check_out_start = VALUES(check_out_start)`,
        [req.schoolUser.sekolah_id, item.weekday, item.is_working_day,
          item.check_in_deadline ?? checkIn, item.lateness_tolerance_minutes ?? tolerance,
          item.check_out_start ?? checkOut],
      );
    }
    if (Array.isArray(body.holidays)) {
      await connection.execute('DELETE FROM school_holidays WHERE sekolah_id = ?', [req.schoolUser.sekolah_id]);
      for (const holiday of holidays) {
        await connection.execute(
          `INSERT INTO school_holidays (sekolah_id, holiday_date, name, created_by)
           VALUES (?, ?, ?, ?)`,
          [req.schoolUser.sekolah_id, holiday.date, holiday.name.trim(), req.schoolUser.id],
        );
      }
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
  res.json({ message: 'Pengaturan diperbarui.' });
}));

router.post('/settings/scanner-pin/verify', requireSchoolUser,
  requireAnyPermission('scanner.use', 'dashboard.view'), asyncRoute(async (req, res) => {
    const pin = req.body?.pin;
    if (typeof pin !== 'string' || !/^\d{4,6}$/.test(pin)) {
      throw fail(400, 'PIN harus terdiri dari 4–6 angka.', 'VALIDATION_ERROR');
    }
    const [[settings]] = await pool.execute(
      'SELECT scanner_pin_hash FROM operational_settings WHERE sekolah_id = ?',
      [req.schoolUser.sekolah_id],
    );
    const configuredHash = settings?.scanner_pin_hash;
    const valid = configuredHash
      ? await verifyPassword(pin, configuredHash)
      : pin === '1234';
    if (!valid) throw fail(403, 'PIN scanner tidak benar.', 'INVALID_SCANNER_PIN');
    res.json({ valid: true });
  }));

router.get('/settings/whatsapp-gateway', requireSchoolUser, requirePermission('settings.operational.view'), asyncRoute(async (req, res) => {
  const schoolId = req.schoolUser.sekolah_id;
  const [[settings]] = await pool.execute(
    `SELECT endpoint_url, token_ciphertext, is_enabled,
            last_test_at, last_test_status, last_test_message
       FROM school_whatsapp_gateway_config WHERE sekolah_id = ?`,
    [schoolId],
  );
  const [[notificationCounts]] = await pool.execute(
    `SELECT SUM(status = 'pending') AS pending,
            SUM(status = 'sending') AS sending,
            SUM(status = 'failed') AS failed
       FROM participant_late_notifications
      WHERE sekolah_id = ?`,
    [schoolId],
  );
  const [[latestNotificationError]] = await pool.execute(
    `SELECT last_error FROM participant_late_notifications
      WHERE sekolah_id = ? AND status = 'failed' AND last_error IS NOT NULL
      ORDER BY updated_at DESC, id DESC LIMIT 1`,
    [schoolId],
  );
  const participantScope = classroomScope(req.schoolUser, 'p');
  const [[participantsWithoutPhone]] = await pool.execute(
    `SELECT COUNT(*) AS total FROM participants p
      WHERE p.sekolah_id = ? AND p.is_active = TRUE
        ${participantScope.sql}
        AND (p.participant_phone IS NULL OR p.participant_phone = '')`,
    [schoolId, ...participantScope.params],
  );
  res.json({
    settings: {
      endpoint_url: settings?.endpoint_url ?? '',
      is_enabled: Boolean(settings?.is_enabled),
      is_configured: Boolean(settings?.endpoint_url && settings?.token_ciphertext),
      token_hint: settings?.token_ciphertext ? 'Token tersimpan aman' : '',
      last_test_at: settings?.last_test_at ?? null,
      last_test_status: settings?.last_test_status ?? null,
      last_test_message: settings?.last_test_message ?? null,
      late_notifications: {
        pending: Number(notificationCounts?.pending ?? 0),
        sending: Number(notificationCounts?.sending ?? 0),
        failed: Number(notificationCounts?.failed ?? 0),
        participants_without_phone: Number(participantsWithoutPhone?.total ?? 0),
        latest_error: latestNotificationError?.last_error ?? null,
      },
    },
  });
}));

router.put('/settings/whatsapp-gateway', requireSchoolUser, requirePermission('settings.operational.edit'), asyncRoute(async (req, res) => {
  const settings = validateSchoolGatewaySettings(req.body ?? {});
  const [[existing]] = await pool.execute(
    `SELECT token_ciphertext, token_iv, token_auth_tag
       FROM school_whatsapp_gateway_config WHERE sekolah_id = ?`,
    [req.schoolUser.sekolah_id],
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
    `INSERT INTO school_whatsapp_gateway_config
      (sekolah_id, endpoint_url, token_ciphertext, token_iv, token_auth_tag, is_enabled,
       last_test_at, last_test_status, last_test_message)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL)
     ON DUPLICATE KEY UPDATE endpoint_url = VALUES(endpoint_url),
       token_ciphertext = VALUES(token_ciphertext), token_iv = VALUES(token_iv),
       token_auth_tag = VALUES(token_auth_tag), is_enabled = VALUES(is_enabled),
       last_test_at = NULL, last_test_status = NULL, last_test_message = NULL`,
    [req.schoolUser.sekolah_id, settings.endpointUrl, encrypted?.ciphertext ?? null,
      encrypted?.iv ?? null, encrypted?.authTag ?? null, settings.isEnabled],
  );
  res.json({ message: 'Pengaturan WhatsApp sekolah disimpan.' });
}));

router.post('/settings/whatsapp-gateway/test', requireSchoolUser, requirePermission('settings.operational.edit'), asyncRoute(async (req, res) => {
  const phone = normalizeWhatsappPhone(req.body?.phone);
  if (!phone) throw fail(400, 'Nomor WhatsApp uji coba tidak valid.', 'VALIDATION_ERROR');
  const [[gateway]] = await pool.execute(
    `SELECT endpoint_url, token_ciphertext, token_iv, token_auth_tag
       FROM school_whatsapp_gateway_config WHERE sekolah_id = ?`,
    [req.schoolUser.sekolah_id],
  );
  let status = 'failed';
  let message = 'Gateway WhatsApp sekolah belum dikonfigurasi.';
  if (gateway?.endpoint_url && gateway.token_ciphertext) {
    try {
      const delivery = await sendWhatsappMessage(
        gateway.endpoint_url,
        decryptGatewayToken(gateway),
        phone,
        'Uji koneksi gateway WhatsApp sekolah. Jika pesan ini diterima, gateway siap digunakan.',
      );
      status = delivery.deliveryConfirmed ? 'success' : 'accepted';
      message = delivery.deliveryConfirmed
        ? `Gateway mengonfirmasi pesan delivered (HTTP ${delivery.statusCode}).`
        : `Gateway menerima permintaan (HTTP ${delivery.statusCode}), tetapi belum mengonfirmasi pesan delivered.${delivery.detail ? ` Respons: ${delivery.detail}` : ''}`;
    } catch (error) {
      message = error instanceof Error ? error.message.slice(0, 500) : 'Pengiriman pesan uji gagal.';
    }
  }
  await pool.execute(
    `INSERT INTO school_whatsapp_gateway_config
      (sekolah_id, last_test_at, last_test_status, last_test_message)
     VALUES (?, UTC_TIMESTAMP(), ?, ?)
     ON DUPLICATE KEY UPDATE last_test_at = VALUES(last_test_at),
       last_test_status = VALUES(last_test_status), last_test_message = VALUES(last_test_message)`,
    [req.schoolUser.sekolah_id, status, message],
  );
  const [[log]] = await pool.execute(
    `SELECT last_test_at, last_test_status, last_test_message
       FROM school_whatsapp_gateway_config WHERE sekolah_id = ?`,
    [req.schoolUser.sekolah_id],
  );
  res.json({ log });
}));

router.post('/settings/whatsapp-gateway/retry-failed', requireSchoolUser,
  requirePermission('settings.operational.edit'), asyncRoute(async (req, res) => {
    const [[gateway]] = await pool.execute(
      `SELECT is_enabled, endpoint_url, token_ciphertext
         FROM school_whatsapp_gateway_config WHERE sekolah_id = ?`,
      [req.schoolUser.sekolah_id],
    );
    if (!gateway?.is_enabled || !gateway.endpoint_url || !gateway.token_ciphertext) {
      throw fail(409, 'Aktifkan dan simpan gateway WhatsApp sebelum mencoba ulang notifikasi.', 'CONFIGURATION_ERROR');
    }
    const [result] = await pool.execute(
      `UPDATE participant_late_notifications
          SET status = 'pending', attempts = 0, next_attempt_at = UTC_TIMESTAMP(),
              last_error = NULL, sent_at = NULL
        WHERE sekolah_id = ? AND status = 'failed'`,
      [req.schoolUser.sekolah_id],
    );
    res.json({
      requeued: result.affectedRows,
      message: result.affectedRows
        ? `${result.affectedRows} notifikasi dijadwalkan untuk dicoba ulang.`
        : 'Tidak ada notifikasi gagal yang perlu dicoba ulang.',
    });
  }));

router.delete('/settings/whatsapp-gateway', requireSchoolUser, requirePermission('settings.operational.edit'), asyncRoute(async (req, res) => {
  await pool.execute(
    `DELETE FROM school_whatsapp_gateway_config WHERE sekolah_id = ?`,
    [req.schoolUser.sekolah_id],
  );
  res.json({ message: 'Konfigurasi WhatsApp sekolah dihapus.' });
}));

router.get('/settings/google-sheets', requireSchoolUser,
  requirePermission('settings.operational.view'), asyncRoute(async (req, res) => {
    const [[settings]] = await pool.execute(
      `SELECT c.web_app_url, c.token_ciphertext, c.is_enabled,
              s.last_success_at, s.last_error
         FROM school_google_sheets_config c
         LEFT JOIN school_google_sheets_sync_state s ON s.sekolah_id = c.sekolah_id
        WHERE c.sekolah_id = ?`,
      [req.schoolUser.sekolah_id],
    );
    const [[permissionCount]] = await pool.execute(
      `SELECT COUNT(*) AS jumlah
         FROM attendance_logs
        WHERE sekolah_id = ?
          AND event_type IN ('permission_out', 'permission_in')`,
      [req.schoolUser.sekolah_id],
    );
    res.json({
      settings: {
        web_app_url: settings?.web_app_url ?? '',
        is_enabled: Boolean(settings?.is_enabled),
        is_configured: Boolean(settings?.web_app_url && settings?.token_ciphertext),
        secret_hint: settings?.token_ciphertext ? 'Secret tersimpan terenkripsi' : '',
        last_sync_at: settings?.last_success_at ?? null,
        sync_error: settings?.last_error ?? null,
        permission_record_count: Number(permissionCount?.jumlah ?? 0),
      },
    });
  }));

router.put('/settings/google-sheets', requireSchoolUser,
  requirePermission('settings.operational.edit'), asyncRoute(async (req, res) => {
    const body = req.body ?? {};
    if (typeof body.is_enabled !== 'boolean') {
      throw fail(400, 'Status aktif Google Sheets tidak valid.', 'VALIDATION_ERROR');
    }
    const [[existing]] = await pool.execute(
      `SELECT web_app_url, token_ciphertext, token_iv, token_auth_tag, is_enabled
         FROM school_google_sheets_config WHERE sekolah_id = ?`,
      [req.schoolUser.sekolah_id],
    );
    const rawUrl = typeof body.web_app_url === 'string' ? body.web_app_url.trim() : '';
    const webAppUrl = rawUrl
      ? validateAppsScriptWebAppUrl(rawUrl)
      : existing?.web_app_url ?? '';
    const sharedSecret = typeof body.shared_secret === 'string' ? body.shared_secret : '';
    if (sharedSecret && (sharedSecret.length < 24 || sharedSecret.length > 500)) {
      throw fail(400, 'Secret Google Sheets harus berisi 24–500 karakter.', 'VALIDATION_ERROR');
    }
    const encrypted = sharedSecret
      ? encryptGatewayToken(sharedSecret)
      : existing?.token_ciphertext
        ? {
          ciphertext: existing.token_ciphertext,
          iv: existing.token_iv,
          authTag: existing.token_auth_tag,
        }
        : null;
    if (body.is_enabled && (!webAppUrl || !encrypted)) {
      throw fail(400, 'Masukkan URL Apps Script dan secret sebelum mengaktifkan sinkronisasi.', 'VALIDATION_ERROR');
    }
    if (!webAppUrl || !encrypted) {
      await pool.execute('DELETE FROM school_google_sheets_config WHERE sekolah_id = ?', [
        req.schoolUser.sekolah_id,
      ]);
      return res.json({
        settings: {
          web_app_url: '', is_enabled: false, is_configured: false, secret_hint: '',
          last_sync_at: null, sync_error: null,
        },
      });
    }
    await pool.execute(
      `INSERT INTO school_google_sheets_config
        (sekolah_id, web_app_url, token_ciphertext, token_iv, token_auth_tag, is_enabled)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE web_app_url = VALUES(web_app_url),
         token_ciphertext = VALUES(token_ciphertext), token_iv = VALUES(token_iv),
         token_auth_tag = VALUES(token_auth_tag), is_enabled = VALUES(is_enabled)`,
      [req.schoolUser.sekolah_id, webAppUrl, encrypted.ciphertext,
        encrypted.iv, encrypted.authTag, body.is_enabled],
    );
    const resetSyncCursor = !existing
      || webAppUrl !== existing.web_app_url
      || Boolean(sharedSecret)
      || (body.is_enabled && !Boolean(Number(existing.is_enabled)));
    await pool.execute(
      `INSERT INTO school_google_sheets_sync_state (sekolah_id)
       VALUES (?)
       ON DUPLICATE KEY UPDATE
         last_synced_id = IF(?, 0, last_synced_id),
         last_attempt_at = IF(?, NULL, last_attempt_at),
         last_success_at = IF(?, NULL, last_success_at),
         last_error = IF(?, NULL, last_error)`,
      [req.schoolUser.sekolah_id, resetSyncCursor, resetSyncCursor, resetSyncCursor, resetSyncCursor],
    );
    const [[syncState]] = await pool.execute(
      `SELECT last_success_at, last_error
         FROM school_google_sheets_sync_state WHERE sekolah_id = ?`,
      [req.schoolUser.sekolah_id],
    );
    res.json({
      settings: {
        web_app_url: webAppUrl,
        is_enabled: body.is_enabled,
        is_configured: true,
        secret_hint: 'Secret tersimpan terenkripsi',
        last_sync_at: syncState?.last_success_at ?? null,
        sync_error: syncState?.last_error ?? null,
      },
    });
  }));

router.post('/settings/google-sheets/resync', requireSchoolUser,
  requirePermission('settings.operational.edit'), asyncRoute(async (req, res) => {
    const [[settings]] = await pool.execute(
      `SELECT web_app_url, token_ciphertext
         FROM school_google_sheets_config
        WHERE sekolah_id = ? AND is_enabled = TRUE`,
      [req.schoolUser.sekolah_id],
    );
    if (!settings?.web_app_url || !settings?.token_ciphertext) {
      throw fail(409, 'Aktifkan Google Sheets sebelum mengirim ulang riwayat.', 'SYNC_NOT_CONFIGURED');
    }
    const connection = await pool.getConnection();
    const lockName = `google-sheets-${req.schoolUser.sekolah_id}`;
    let locked = false;
    try {
      const [[lock]] = await connection.execute('SELECT GET_LOCK(?, 0) AS acquired', [lockName]);
      locked = Number(lock?.acquired) === 1;
      if (!locked) {
        throw fail(409, 'Sinkronisasi sedang berjalan. Coba kirim ulang riwayat kembali sebentar lagi.', 'SYNC_IN_PROGRESS');
      }
      await connection.execute(
        `INSERT INTO school_google_sheets_sync_state (sekolah_id)
         VALUES (?)
         ON DUPLICATE KEY UPDATE last_synced_id = 0, last_attempt_at = NULL,
           last_success_at = NULL, last_error = NULL`,
        [req.schoolUser.sekolah_id],
      );
    } finally {
      try {
        if (locked) await connection.execute('SELECT RELEASE_LOCK(?)', [lockName]);
      } finally {
        connection.release();
      }
    }
    res.json({
      settings: {
        web_app_url: settings.web_app_url,
        is_enabled: true,
        is_configured: true,
        secret_hint: 'Secret tersimpan terenkripsi',
        last_sync_at: null,
        sync_error: null,
      },
    });
  }));

router.post('/settings/google-sheets/resync-permissions', requireSchoolUser,
  requirePermission('settings.operational.edit'), asyncRoute(async (req, res) => {
    const [[settings]] = await pool.execute(
      `SELECT web_app_url, token_ciphertext
         FROM school_google_sheets_config
        WHERE sekolah_id = ? AND is_enabled = TRUE`,
      [req.schoolUser.sekolah_id],
    );
    if (!settings?.web_app_url || !settings?.token_ciphertext) {
      throw fail(409, 'Aktifkan Google Sheets sebelum mengirim ulang izin.', 'SYNC_NOT_CONFIGURED');
    }
    const [rows] = await pool.execute(
      `SELECT id_unik FROM attendance_logs
        WHERE sekolah_id = ?
          AND event_type IN ('permission_out', 'permission_in')
        ORDER BY id ASC`,
      [req.schoolUser.sekolah_id],
    );
    if (!rows.length) {
      throw fail(404, 'Belum ada record Izin Keluar atau Masuk Kembali untuk dikirim.', 'NO_PERMISSION_RECORDS');
    }
    for (let index = 0; index < rows.length; index += 100) {
      await sendAttendanceToGoogleSheets({
        schoolId: req.schoolUser.sekolah_id,
        ids: rows.slice(index, index + 100).map((row) => row.id_unik),
      });
    }
    await pool.execute(
      `INSERT INTO school_google_sheets_sync_state (sekolah_id)
       VALUES (?) ON DUPLICATE KEY UPDATE
         last_attempt_at = UTC_TIMESTAMP(),
         last_success_at = UTC_TIMESTAMP(),
         last_error = NULL`,
      [req.schoolUser.sekolah_id],
    );
    res.json({
      sent_count: rows.length,
      message: `${rows.length} record izin berhasil dikirim ke Google Sheets.`,
    });
  }));

router.get('/backup/export', requireSchoolUser, asyncRoute(async (req, res) => {
  requireSchoolAdmin(req);
  const backup = await createSchoolDatabaseBackup(req.schoolUser.sekolah_id);
  res.set('Cache-Control', 'no-store');
  res.attachment(`ruang-hadir-school-${req.schoolUser.school_code}-backup-${new Date().toISOString().slice(0, 10)}.json`);
  res.type('application/json').send(JSON.stringify(backup));
}));

router.post(
  '/backup/restore',
  requireSchoolUser,
  (req, res, next) => { try { requireSchoolAdmin(req); next(); } catch (error) { next(error); } },
  express.raw({ type: 'application/json', limit: '100mb' }),
  asyncRoute(async (req, res) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) {
      throw fail(400, 'Pilih file backup JSON yang valid.', 'INVALID_BACKUP');
    }
    const connection = await pool.getConnection();
    try {
      const result = await restoreDatabaseBackup(
        connection,
        req.body,
        'school',
        req.schoolUser.sekolah_id,
      );
      res.json({
        ...result,
        message: 'Data operasional sekolah berhasil dipulihkan. Akun dan langganan tidak diubah.',
      });
    } finally {
      connection.release();
    }
  }),
);

router.get('/billing', requireSchoolUser, asyncRoute(async (req, res) => {
  requireBillingAdmin(req);
  const [[school]] = await pool.execute(
    `SELECT subscription_status, trial_ends_at, subscription_expires_at, billing_email
       FROM schools WHERE id = ?`,
    [req.schoolUser.sekolah_id],
  );
  const [[prices]] = await pool.execute(
    'SELECT monthly_price, lifetime_price FROM platform_billing_settings WHERE id = 1',
  );
  const [orders] = await pool.execute(
    `SELECT order_id, provider, plan, amount, payment_method, status,
            checkout_url, expires_at, paid_at, created_at
       FROM subscription_payment_orders
      WHERE sekolah_id = ? ORDER BY created_at DESC LIMIT 10`,
    [req.schoolUser.sekolah_id],
  );
  const paymentSettings = await getPlatformPaymentSettings();
  res.json({
    billing_email: school.billing_email,
    subscription: {
      status: school.subscription_status,
      trial_ends_at: school.trial_ends_at,
      expires_at: school.subscription_expires_at,
      expired: req.schoolUser.subscription_expired,
    },
    prices: {
      monthly: Number(prices?.monthly_price ?? 50000),
      lifetime: Number(prices?.lifetime_price ?? 1000000),
    },
    providers: {
      xendit: paymentSettings.xendit.active,
      duitku: paymentSettings.duitku.active,
      kasera: paymentSettings.kasera.active,
    },
    orders: orders.map((order) => ({ ...order, amount: Number(order.amount) })),
  });
}));

router.put('/billing/email', requireSchoolUser, asyncRoute(async (req, res) => {
  requireBillingAdmin(req);
  const value = req.body?.billing_email;
  if (typeof value !== 'string' || value.length > 254) {
    throw fail(400, 'Email tagihan tidak valid.', 'VALIDATION_ERROR');
  }
  const billingEmail = value.trim();
  if (billingEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(billingEmail)) {
    throw fail(400, 'Email tagihan harus berupa alamat email yang valid.', 'VALIDATION_ERROR');
  }
  await pool.execute(
    'UPDATE schools SET billing_email = ? WHERE id = ?',
    [billingEmail || null, req.schoolUser.sekolah_id],
  );
  res.json({
    billing_email: billingEmail,
    message: billingEmail
      ? 'Email tagihan Kasera berhasil disimpan. Notifikasi tagihan tetap dikirim melalui WhatsApp.'
      : 'Email tagihan Kasera dihapus.',
  });
}));

router.get('/billing/payment-methods', requireSchoolUser, asyncRoute(async (req, res) => {
  requireBillingAdmin(req);
  if (req.query.provider !== 'duitku' ||
      !['monthly', 'lifetime'].includes(String(req.query.plan))) {
    throw fail(400, 'Provider atau paket pembayaran tidak valid.', 'VALIDATION_ERROR');
  }
  const [[prices]] = await pool.execute(
    'SELECT monthly_price, lifetime_price FROM platform_billing_settings WHERE id = 1',
  );
  const amount = Number(req.query.plan === 'lifetime'
    ? prices?.lifetime_price ?? 1000000
    : prices?.monthly_price ?? 50000);
  res.json({ payment_methods: await getDuitkuPaymentMethods(amount) });
}));

router.post('/billing/orders', requireSchoolUser, asyncRoute(async (req, res) => {
  requireBillingAdmin(req);
  const { provider, plan, payment_method: paymentMethod, email } = req.body ?? {};
  if (!['xendit', 'duitku', 'kasera'].includes(provider) ||
      !['monthly', 'lifetime'].includes(plan) ||
      typeof email !== 'string' || email.length > 255 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    throw fail(400, 'Provider, paket, dan email pembayaran harus valid.', 'VALIDATION_ERROR');
  }
  if (provider === 'kasera' && email.trim().length > 254) {
    throw fail(400, 'Email pembayaran Kasera maksimal 254 karakter.', 'VALIDATION_ERROR');
  }
  if (req.schoolUser.subscription_status === 'lifetime') {
    throw fail(409, 'Sekolah sudah memiliki langganan Lifetime.', 'ALREADY_LIFETIME');
  }
  if (provider === 'duitku' &&
      (typeof paymentMethod !== 'string' || !/^[A-Za-z0-9]{1,20}$/.test(paymentMethod))) {
    throw fail(400, 'Pilih metode pembayaran Duitku.', 'VALIDATION_ERROR');
  }
  if (provider !== 'duitku' && paymentMethod !== undefined) {
    throw fail(400, 'Metode pembayaran hanya berlaku untuk Duitku.', 'VALIDATION_ERROR');
  }
  const [[prices]] = await pool.execute(
    'SELECT monthly_price, lifetime_price FROM platform_billing_settings WHERE id = 1',
  );
  const amount = Number(plan === 'lifetime'
    ? prices?.lifetime_price ?? 1000000
    : prices?.monthly_price ?? 50000);
  if (provider === 'kasera' && amount > 1000000) {
    throw fail(400, 'Kasera mensyaratkan informasi pengiriman untuk nominal di atas Rp1.000.000; gunakan provider lain untuk tagihan ini.', 'PAYMENT_AMOUNT_UNSUPPORTED');
  }
  if (provider === 'duitku') {
    const methods = await getDuitkuPaymentMethods(amount);
    if (!methods.some((method) => method.code === paymentMethod)) {
      throw fail(400, 'Metode pembayaran Duitku tidak tersedia untuk paket ini.', 'PAYMENT_METHOD_UNAVAILABLE');
    }
  }

  const id = randomUUID();
  const orderId = `RH-${randomUUID()}`;
  const order = {
    id,
    order_id: orderId,
    provider,
    plan,
    amount,
    payment_method: provider === 'duitku' ? paymentMethod : null,
  };
  await pool.execute(
    `INSERT INTO subscription_payment_orders
      (id, sekolah_id, order_id, provider, plan, amount, payment_method, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
    [id, req.schoolUser.sekolah_id, orderId, provider, plan, amount, order.payment_method],
  );
  try {
    const payment = await createProviderPayment({
      order,
      school: { id: req.schoolUser.sekolah_id, name: req.schoolUser.school_name },
      payerName: req.schoolUser.display_name,
      email: email.trim(),
      phone: req.schoolUser.whatsapp_phone,
    });
    await pool.execute(
      `UPDATE subscription_payment_orders
          SET checkout_url = ?, provider_reference = ?, expires_at = ?
        WHERE id = ? AND sekolah_id = ? AND status = 'pending'`,
      [payment.checkoutUrl, payment.reference, payment.expiresAt,
        id, req.schoolUser.sekolah_id],
    );
    res.status(201).json({
      order_id: orderId,
      provider,
      plan,
      amount,
      checkout_url: payment.checkoutUrl,
      expires_at: payment.expiresAt,
    });
  } catch (error) {
    await pool.execute(
      `UPDATE subscription_payment_orders SET status = 'failed'
        WHERE id = ? AND sekolah_id = ? AND status = 'pending'`,
      [id, req.schoolUser.sekolah_id],
    );
    throw error;
  }
}));

router.get('/devices', requireSchoolUser, requirePermission('scanner.use'), asyncRoute(async (req, res) => {
  const [rows] = await pool.execute(
    `SELECT id, device_name, is_active, last_synced_at, created_at
       FROM scanner_devices WHERE sekolah_id = ? ORDER BY id`,
    [req.schoolUser.sekolah_id],
  );
  res.json({ devices: rows });
}));

router.post('/devices', requireSchoolUser, requirePermission('scanner.use'), asyncRoute(async (req, res) => {
  requireFields(req.body, ['device_name']);
  const name = string(req.body.device_name, 'device_name', 120);
  const { apiKey, hash } = createDeviceApiKey();
  const [result] = await pool.execute(
    `INSERT INTO scanner_devices (sekolah_id, device_name, api_key_hash)
     VALUES (?, ?, ?)`,
    [req.schoolUser.sekolah_id, name, hash],
  );
  res.status(201).json({
    device: { id: String(result.insertId), device_name: name, is_active: true },
    api_key: apiKey,
    warning: 'Simpan API key sekarang; nilainya tidak ditampilkan lagi.',
  });
}));

router.post('/devices/:id/revoke', requireSchoolUser, requirePermission('scanner.use'), asyncRoute(async (req, res) => {
  const [result] = await pool.execute(
    'UPDATE scanner_devices SET is_active = FALSE WHERE sekolah_id = ? AND id = ?',
    [req.schoolUser.sekolah_id, req.params.id],
  );
  if (!result.affectedRows) throw fail(404, 'Perangkat tidak ditemukan.', 'NOT_FOUND');
  res.json({ message: 'Kunci perangkat telah dicabut.' });
}));

const syncPermissionBatch = asyncRoute(async (req, res) => {
  const schoolId = req.schoolUser?.sekolah_id ?? req.device?.sekolah_id;
  const deviceId = req.device?.id ?? null;
  const records = req.body?.records;
  if (!Array.isArray(records) || records.length < 1 || records.length > 100) {
    throw fail(400, 'records harus berisi 1–100 izin.', 'VALIDATION_ERROR');
  }
  const acceptedIds = [];
  const rejectedIds = [];
  const rejected = [];
  const seen = new Set();
  const settings = await loadAttendanceSettings(schoolId);
  for (const record of records) {
    const id = record?.id_unik;
    const eventType = record?.event_type ?? record?.jenis_absen;
    const participantId = record?.participant_id ?? record?.id_peserta;
    const scanMethod = record?.scan_method ?? 'SCAN_QR';
    if (typeof id !== 'string' || !UUID.test(id)) {
      if (id) rejectedIds.push(id);
      rejected.push({ id_unik: id ?? null, reason: 'invalid_id' });
      continue;
    }
    if (seen.has(id)) {
      rejectedIds.push(id);
      rejected.push({ id_unik: id, reason: 'duplicate_in_batch' });
      continue;
    }
    seen.add(id);
    if (!['permission_out', 'permission_in'].includes(eventType) ||
        !['SCAN_QR', 'MANUAL_INPUT'].includes(scanMethod) ||
        typeof record.client_timestamp !== 'string' ||
        !/(?:Z|[+-]\d{2}:\d{2})$/i.test(record.client_timestamp) ||
        !Number.isFinite(Date.parse(record.client_timestamp))) {
      rejectedIds.push(id);
      rejected.push({ id_unik: id, reason: 'invalid_record' });
      continue;
    }
    try {
      let participantRows = [];
      if (/^[1-9]\d*$/.test(String(participantId ?? ''))) {
        [participantRows] = await pool.execute(
        `SELECT p.id, p.participant_code, p.full_name, c.name AS classroom_name
           FROM participants p
           JOIN classrooms c ON c.id = p.classroom_id AND c.sekolah_id = p.sekolah_id
          WHERE p.sekolah_id = ? AND p.id = ? AND p.is_active = TRUE`,
        [schoolId, participantId],
        );
      }
      if (!participantRows.length) {
        const participantCode = String(record.participant_code ?? record.qr_code ?? '').trim();
        if (participantCode) {
          [participantRows] = await pool.execute(
            `SELECT p.id, p.participant_code, p.full_name, c.name AS classroom_name
               FROM participants p
               JOIN classrooms c ON c.id = p.classroom_id AND c.sekolah_id = p.sekolah_id
              WHERE p.sekolah_id = ? AND p.is_active = TRUE
                AND (p.participant_code = ? OR p.qr_code = ?)
              LIMIT 1`,
            [schoolId, participantCode, participantCode],
          );
        }
      }
      if (!participantRows.length) {
        const participantName = String(record.participant_name ?? '').trim();
        if (participantName) {
          [participantRows] = await pool.execute(
            `SELECT p.id, p.participant_code, p.full_name, c.name AS classroom_name
               FROM participants p
               JOIN classrooms c ON c.id = p.classroom_id AND c.sekolah_id = p.sekolah_id
              WHERE p.sekolah_id = ? AND p.is_active = TRUE
                AND p.full_name = ?
              LIMIT 2`,
            [schoolId, participantName],
          );
          if (participantRows.length > 1) participantRows = [];
        }
      }
      if (!participantRows.length) throw new Error('participant_not_found');
      const participant = participantRows[0];
      const calculation = calculateAttendance({
        eventType,
        clientTimestamp: record.client_timestamp,
        participantId: participant.id,
        settings,
      });
      if (!calculation.status) throw new Error(calculation.reason);
      const timestamp = new Date(record.client_timestamp).toISOString()
        .slice(0, 23).replace('T', ' ');
      await inTransaction(async (connection) => {
        const [existing] = await connection.execute(
          `SELECT id FROM attendance_logs
            WHERE sekolah_id = ? AND id_unik = ? FOR UPDATE`,
          [schoolId, id],
        );
        if (existing.length) return;
        await connection.execute(
          `INSERT INTO attendance_logs
            (sekolah_id, id_unik, participant_id, device_id, recorded_by,
             participant_code_snapshot, participant_name_snapshot, classroom_name_snapshot,
             attendance_date, event_type, client_timestamp_utc, attendance_status,
             late_minutes, scan_method)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [schoolId, id, participant.id, deviceId, req.schoolUser?.id ?? null,
            participant.participant_code, participant.full_name, participant.classroom_name,
            calculation.date, eventType, timestamp, calculation.status, 0, scanMethod],
        );
      });
      acceptedIds.push(id);
    } catch (error) {
      if (error?.code === 'ER_DUP_ENTRY') {
        const [existing] = await pool.execute(
          `SELECT id FROM attendance_logs
            WHERE sekolah_id = ? AND id_unik = ?`,
          [schoolId, id],
        );
        if (existing.length) {
          acceptedIds.push(id);
          continue;
        }
      }
      rejectedIds.push(id);
      rejected.push({
        id_unik: id,
        reason: ['participant_not_found', 'non_working_day', 'daily_duplicate']
          .includes(error.message) ? error.message : 'invalid_record',
      });
    }
  }
  res.json({ accepted_ids: acceptedIds, ignored_ids: [], rejected_ids: rejectedIds, rejected });
});

const syncAttendanceBatch = asyncRoute(async (req, res) => {
  const schoolId = req.schoolUser?.sekolah_id ?? req.device.sekolah_id;
  const deviceId = req.device?.id ?? null;
  const records = req.body?.records;
  if (!Array.isArray(records) || records.length < 1 || records.length > 100) {
    throw fail(400, 'records harus berisi 1–100 scan.', 'VALIDATION_ERROR');
  }
  const acceptedIds = [];
  const rejectedIds = [];
  const ignoredIds = [];
  const ignored = [];
  const rejected = [];
  const settings = await loadAttendanceSettings(schoolId);
  const cooldownMinutes = Number(settings.scan_cooldown_minutes ?? 5);
  if (!Number.isInteger(cooldownMinutes) || cooldownMinutes < 1 || cooldownMinutes > 60) {
    throw fail(500, 'Jeda scan pada pengaturan sekolah tidak valid.', 'CONFIGURATION_ERROR');
  }
  const seen = new Set();
  for (const record of records) {
    const id = record?.id_unik;
    if (typeof id !== 'string' || !UUID.test(id)) {
      if (id) rejectedIds.push(id);
      rejected.push({ id_unik: id ?? null, reason: 'invalid_id' });
      continue;
    }
    if (seen.has(id)) {
      rejectedIds.push(id);
      rejected.push({ id_unik: id, reason: 'duplicate_in_batch' });
      continue;
    }
    seen.add(id);
    const eventType = record.event_type ?? record.jenis_absen;
    const participantId = record.participant_id ?? record.id_peserta;
    const scanMethod = record.scan_method ?? 'SCAN_QR';
    if (!['check_in', 'check_out', 'permission_out', 'permission_in'].includes(eventType) ||
        !/^[1-9]\d*$/.test(String(participantId ?? '')) ||
        !['SCAN_QR', 'MANUAL_INPUT'].includes(scanMethod) ||
        typeof record.client_timestamp !== 'string' ||
        !/(?:Z|[+-]\d{2}:\d{2})$/i.test(record.client_timestamp) ||
        !Number.isFinite(Date.parse(record.client_timestamp))) {
      rejectedIds.push(id);
      rejected.push({ id_unik: id, reason: 'invalid_record' });
      continue;
    }
    try {
      const [participants] = await pool.execute(
        `SELECT p.id, p.participant_code, p.full_name, p.classroom_id,
                p.participant_phone, c.name AS classroom_name
           FROM participants p JOIN classrooms c
             ON c.id = p.classroom_id AND c.sekolah_id = p.sekolah_id
          WHERE p.sekolah_id = ? AND p.id = ? AND p.is_active = TRUE`,
        [schoolId, participantId],
      );
      if (!participants.length) throw new Error('participant_not_found');
      const participant = participants[0];
      const calculation = calculateAttendance({
        eventType,
        clientTimestamp: record.client_timestamp,
        participantId: participant.id,
        settings,
      });
      if (!calculation.status) throw new Error(calculation.reason);
      const recipientPhone = normalizeLateAttendanceRecipientPhone(participant.participant_phone);
      const timestamp = new Date(record.client_timestamp).toISOString()
        .slice(0, 23).replace('T', ' ');
      const cooldownThreshold = new Date(
        Date.parse(record.client_timestamp) - cooldownMinutes * 60_000,
      ).toISOString().slice(0, 23).replace('T', ' ');
      try {
        const syncResult = await inTransaction(async (connection) => {
          const [existingId] = await connection.execute(
            `SELECT participant_id, event_type, attendance_date
               FROM attendance_logs
              WHERE sekolah_id = ? AND id_unik = ?
              FOR UPDATE`,
            [schoolId, id],
          );
          if (existingId.length) {
            if (String(existingId[0].participant_id) === String(participant.id) &&
                existingId[0].event_type === eventType &&
                existingId[0].attendance_date === calculation.date) {
              return 'already-saved';
            }
            throw new Error('daily_duplicate');
          }
          if (eventType === 'check_out') {
            const [checkInRows] = await connection.execute(
              `SELECT id FROM attendance_logs
                WHERE sekolah_id = ? AND participant_id = ?
                  AND attendance_date = ? AND event_type = 'check_in'
                LIMIT 1 FOR UPDATE`,
              [schoolId, participant.id, calculation.date],
            );
            if (!checkInRows.length) return 'ignored_missing_check_in';
          }
          if (['check_in', 'check_out'].includes(eventType)) {
            const [recentScans] = await connection.execute(
              `SELECT id FROM attendance_logs
                WHERE sekolah_id = ? AND participant_id = ? AND attendance_date = ?
                  AND event_type IN ('check_in', 'check_out')
                  AND client_timestamp_utc > ?
                ORDER BY client_timestamp_utc DESC, id DESC
                FOR UPDATE`,
              [schoolId, participant.id, calculation.date, cooldownThreshold],
            );
            if (recentScans.length) {
              return 'ignored_cooldown';
            }
          }
          const [result] = await connection.execute(
            `INSERT INTO attendance_logs
              (sekolah_id, id_unik, participant_id, device_id, recorded_by, participant_code_snapshot,
               participant_name_snapshot, classroom_name_snapshot, attendance_date,
               event_type, client_timestamp_utc, attendance_status, late_minutes, scan_method)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [schoolId, id, participant.id, deviceId, req.schoolUser?.id ?? null,
              participant.participant_code, participant.full_name, participant.classroom_name,
              calculation.date, eventType, timestamp, calculation.status, calculation.lateMinutes, scanMethod],
          );
          if (shouldQueueLateAttendanceNotification({
            eventType,
            status: calculation.status,
            participantPhone: recipientPhone,
          })) {
            const message = createLateAttendanceMessage({
              participantName: participant.full_name,
              attendanceDate: calculation.date,
              clientTimestamp: record.client_timestamp,
              timeZone: settings.timezone,
              lateMinutes: calculation.lateMinutes,
            });
            await enqueueLateAttendanceNotification(connection, {
              schoolId,
              attendanceLogId: result.insertId,
              recipientPhone,
              message,
            });
          }
          return 'saved';
        });
        if (syncResult === 'ignored_missing_check_in' || syncResult === 'ignored_cooldown') {
          ignoredIds.push(id);
          ignored.push({
            id_unik: id,
            reason: syncResult === 'ignored_missing_check_in' ? 'missing_check_in' : 'cooldown',
          });
          continue;
        }
      } catch (error) {
        if (error.code !== 'ER_DUP_ENTRY') throw error;
        const [existing] = await pool.execute(
          `SELECT participant_id, event_type, attendance_date
             FROM attendance_logs WHERE sekolah_id = ? AND id_unik = ?`,
          [schoolId, id],
        );
        if (existing.length && String(existing[0].participant_id) === String(participant.id) &&
            existing[0].event_type === eventType && existing[0].attendance_date === calculation.date) {
          acceptedIds.push(id);
          continue;
        }
        if (!String(error.message || '').includes('uq_attendance_daily_event')) {
          throw new Error('daily_duplicate');
        }
        const [sameDayEvent] = await pool.execute(
          `SELECT id_unik FROM attendance_logs
            WHERE sekolah_id = ? AND participant_id = ?
              AND attendance_date = ? AND event_type = ?
            LIMIT 1`,
          [schoolId, participant.id, calculation.date, eventType],
        );
        if (sameDayEvent.length) {
          if (eventType === 'check_out') {
            await inTransaction(async (connection) => {
              const [existingCheckout] = await connection.execute(
                `SELECT id FROM attendance_logs
                  WHERE sekolah_id = ? AND participant_id = ?
                    AND attendance_date = ? AND event_type = 'check_out'
                  LIMIT 1 FOR UPDATE`,
                [schoolId, participant.id, calculation.date],
              );
              if (!existingCheckout.length) return;
              const [deleted] = await connection.execute(
                `DELETE FROM attendance_logs
                  WHERE id = ? AND client_timestamp_utc < ?`,
                [existingCheckout[0].id, timestamp],
              );
              if (!deleted.affectedRows) return;
              await connection.execute(
                `INSERT INTO attendance_logs
                  (sekolah_id, id_unik, participant_id, device_id, recorded_by,
                   participant_code_snapshot, participant_name_snapshot,
                   classroom_name_snapshot, attendance_date, event_type,
                   client_timestamp_utc, attendance_status, late_minutes, scan_method)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'check_out', ?, ?, ?, ?)`,
                [schoolId, id, participant.id, deviceId, req.schoolUser?.id ?? null,
                  participant.participant_code, participant.full_name, participant.classroom_name,
                  calculation.date, timestamp, calculation.status, calculation.lateMinutes, scanMethod],
              );
            });
          }
          acceptedIds.push(id);
          continue;
        }
        throw new Error('daily_duplicate');
      }
      acceptedIds.push(id);
    } catch (error) {
      rejectedIds.push(id);
      rejected.push({
        id_unik: id,
        reason: ['participant_not_found', 'non_working_day', 'daily_duplicate']
          .includes(error.message) ? error.message : 'invalid_record',
      });
    }
  }
  if (deviceId) {
    await pool.execute('UPDATE scanner_devices SET last_synced_at = CURRENT_TIMESTAMP WHERE id = ?', [deviceId]);
  }
  res.json({ accepted_ids: acceptedIds, ignored_ids: ignoredIds, ignored, rejected_ids: rejectedIds, rejected });
});

router.post('/attendance/sync-batch', requireDevice, syncAttendanceBatch);
router.post('/attendance/sync-batch/session', requireSchoolUser,
  requirePermission('scanner.use'), syncAttendanceBatch);
router.post('/attendance/permissions/sync-batch/session', requireSchoolUser,
  requirePermission('scanner.use'), syncPermissionBatch);

router.get('/attendance/report', requireSchoolUser, requirePermission('attendance.view'), asyncRoute(async (req, res) => {
  const from = req.query.from;
  const to = req.query.to;
  if (!validDate(from) || !validDate(to) || from > to ||
      (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000 > 366) {
    throw fail(400, 'Gunakan from/to YYYY-MM-DD dengan rentang maksimal 367 hari.', 'VALIDATION_ERROR');
  }
  const scope = classroomScope(req.schoolUser, 'p');
  const [rows] = await pool.execute(
    `SELECT a.id, a.id_unik, a.participant_id, a.participant_code_snapshot AS participant_code,
            a.participant_name_snapshot AS participant_name,
            a.classroom_name_snapshot AS classroom_name, a.attendance_date, a.event_type,
            a.client_timestamp_utc, a.attendance_status, a.late_minutes, a.scan_method
       FROM attendance_logs a JOIN participants p
         ON p.id = a.participant_id AND p.sekolah_id = a.sekolah_id
      WHERE a.sekolah_id = ? AND a.attendance_date BETWEEN ? AND ?${scope.sql}
      ORDER BY a.attendance_date, a.server_received_at, a.id`,
    [req.schoolUser.sekolah_id, from, to, ...scope.params],
  );
  res.json({ from, to, attendance: aggregateAttendanceReport(rows) });
}));

router.delete('/attendance/report', requireSchoolUser, requirePermission('attendance.edit'), asyncRoute(async (req, res) => {
  const rawEntries = req.body?.entries;
  if (!Array.isArray(rawEntries) || rawEntries.length === 0 || rawEntries.length > 500) {
    throw fail(400, 'Pilih 1 sampai 500 riwayat absensi untuk dihapus.', 'VALIDATION_ERROR');
  }
  const entries = [];
  const seen = new Set();
  for (const entry of rawEntries) {
    const participantId = String(entry?.participant_id ?? '');
    const attendanceDate = entry?.attendance_date;
    if (!/^[1-9]\d*$/.test(participantId) || !validDate(attendanceDate)) {
      throw fail(400, 'Peserta dan tanggal riwayat absensi tidak valid.', 'VALIDATION_ERROR');
    }
    const key = `${attendanceDate}:${participantId}`;
    if (!seen.has(key)) {
      seen.add(key);
      entries.push({ participantId, attendanceDate });
    }
  }
  const scope = classroomScope(req.schoolUser, 'p');
  const selectedRows = entries
    .map(() => '(a.participant_id = ? AND a.attendance_date = ?)')
    .join(' OR ');
  const [result] = await pool.execute(
    `DELETE a FROM attendance_logs a
       JOIN participants p
         ON p.id = a.participant_id AND p.sekolah_id = a.sekolah_id
      WHERE a.sekolah_id = ? AND (${selectedRows})${scope.sql}`,
    [
      req.schoolUser.sekolah_id,
      ...entries.flatMap(({ participantId, attendanceDate }) => [participantId, attendanceDate]),
      ...scope.params,
    ],
  );
  res.json({ deleted_count: result.affectedRows });
}));

export default router;
