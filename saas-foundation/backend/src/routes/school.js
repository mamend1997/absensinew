import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import {
  createProviderPayment, getDuitkuPaymentMethods,
} from '../core/billing.js';
import { calculateAttendance } from '../core/attendance.js';
import { inTransaction, pool } from '../db.js';
import {
  asyncRoute, fail, parseJson, requireFields,
} from '../http.js';
import {
  classroomScope, requireDevice, requirePermission, requireSchoolUser,
} from '../middleware/auth.js';
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
import { provisionSchool } from '../core/school-provision.js';
import { enforceOtpRequestLimit } from '../core/otp-rate-limit.js';
import {
  decryptGatewayToken, encryptGatewayToken, sendWhatsappMessage, validateGatewayUrl,
} from '../core/whatsapp-gateway.js';
import { config } from '../config.js';
import { createDeviceApiKey, hashPassword, signToken, verifyPassword } from '../security.js';
import { getPlatformPaymentSettings } from '../core/platform-payment-settings.js';

const router = Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_ROLES = ['admin-sekolah', 'operator-scanner'];
const ALLOWED_PERMISSIONS = new Set([
  'dashboard.read', 'attendance.read', 'attendance.export',
  'participants.read', 'participants.manage', 'participants.qr.print',
  'settings.operational.manage', 'attendance.excuse.manage', 'scanner.use',
  'school.users.manage', 'school.roles.manage',
]);

function string(value, field, max = 150) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) {
    throw fail(400, `${field} tidak valid.`, 'VALIDATION_ERROR');
  }
  return value.trim();
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
  if (new Set(permissions).size !== permissions.length ||
      permissions.some((permission) => !ownedPermissions.includes(permission))) {
    throw fail(403, 'Role tidak dapat memberi permission yang tidak dimiliki pengelola.', 'FORBIDDEN');
  }
  return permissions;
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

async function loadAttendanceSettings(schoolId) {
  const [[base]] = await pool.execute(
    `SELECT timezone, check_in_deadline, lateness_tolerance_minutes, check_out_start
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
  return { ...base, weekly_schedules: weekly, holidays };
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

  try {
    await sendWhatsappMessage(
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
    message: 'Kode OTP telah dikirim ke WhatsApp admin.',
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

  const [accounts] = await pool.execute(
    `SELECT u.id, u.sekolah_id
       FROM schools s JOIN users u ON u.sekolah_id = s.id
      WHERE s.school_code = ? AND u.whatsapp_phone = ? AND s.is_active = TRUE
        AND s.subscription_status <> 'suspend' AND u.is_active = TRUE
      LIMIT 1`,
    [req.body.school_code, phone],
  );
  const account = accounts[0];
  const challengeId = randomUUID();
  const otp = createRegistrationOtp();
  await pool.execute(
    `INSERT INTO school_password_reset_challenges
      (id, school_code, sekolah_id, user_id, whatsapp_phone, otp_hash, expires_at, request_ip_hash)
     VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP() + INTERVAL 5 MINUTE, ?)`,
    [challengeId, req.body.school_code, account?.sekolah_id ?? null, account?.id ?? null,
      phone, hashRegistrationOtp(challengeId, otp, config.jwtSecret), ipHash],
  );

  if (account) {
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
  }

  res.status(202).json({
    challenge_id: challengeId,
    expires_in_seconds: 300,
    message: 'Jika kode sekolah dan nomor WhatsApp cocok dengan akun aktif, kode verifikasi akan dikirim ke nomor tersebut.',
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
    }),
    token_type: 'Bearer',
    expires_in: process.env.JWT_TTL ?? '8h',
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

router.get('/roles', requireSchoolUser, requirePermission('school.roles.manage'), asyncRoute(async (req, res) => {
  if (!req.schoolUser.permissions.includes('school.roles.manage') &&
      !req.schoolUser.permissions.includes('school.users.manage')) {
    throw fail(403, 'Izin tidak mencukupi.', 'FORBIDDEN');
  }
  const [rows] = await pool.execute(
    `SELECT id, role_key, role_name, permissions, is_system
       FROM roles WHERE sekolah_id = ? ORDER BY id`,
    [req.schoolUser.sekolah_id],
  );
  res.json({ roles: rows.map((row) => ({ ...row, permissions: parseJson(row.permissions) })) });
}));

router.post('/roles', requireSchoolUser, requirePermission('school.roles.manage'), asyncRoute(async (req, res) => {
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
  if (found[0].is_system) throw fail(403, 'Role sistem tidak dapat diubah.', 'FORBIDDEN');
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
router.patch('/roles/:id', requireSchoolUser, requirePermission('school.roles.manage'), updateRole);
router.patch('/roles', requireSchoolUser, requirePermission('school.roles.manage'), updateRole);

router.get('/users', requireSchoolUser, requirePermission('school.users.manage'), asyncRoute(async (req, res) => {
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

router.post('/users', requireSchoolUser, requirePermission('school.users.manage'), asyncRoute(async (req, res) => {
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
  const rolePermissions = parseJson(roles[0].permissions);
  if (rolePermissions.some((permission) => !req.schoolUser.permissions.includes(permission))) {
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

router.get('/classrooms', requireSchoolUser, requirePermission('participants.read'), asyncRoute(async (req, res) => {
  const scope = classroomScope(req.schoolUser, 'c');
  const [rows] = await pool.execute(
    `SELECT c.id, c.unit_id, c.name, u.name AS unit_name
       FROM classrooms c JOIN units u ON u.id = c.unit_id AND u.sekolah_id = c.sekolah_id
      WHERE c.sekolah_id = ?${scope.sql} ORDER BY u.name, c.name`,
    [req.schoolUser.sekolah_id, ...scope.params],
  );
  res.json({ classrooms: rows });
}));

router.get('/participants', requireSchoolUser, requirePermission('participants.read'), asyncRoute(async (req, res) => {
  const scope = classroomScope(req.schoolUser);
  const [rows] = await pool.execute(
    `SELECT p.id, p.classroom_id, p.participant_code, p.full_name, p.qr_code,
            p.guardian_phone, p.is_active, c.name AS classroom_name
       FROM participants p JOIN classrooms c ON c.id = p.classroom_id AND c.sekolah_id = p.sekolah_id
      WHERE p.sekolah_id = ?${scope.sql} ORDER BY p.full_name`,
    [req.schoolUser.sekolah_id, ...scope.params],
  );
  res.json({ participants: rows });
}));

router.post('/participants', requireSchoolUser, requirePermission('participants.manage'), asyncRoute(async (req, res) => {
  requireFields(req.body, ['classroom_id', 'participant_code', 'full_name']);
  scopedClassroom(req.schoolUser, req.body.classroom_id);
  const [classrooms] = await pool.execute(
    'SELECT id FROM classrooms WHERE sekolah_id = ? AND id = ?',
    [req.schoolUser.sekolah_id, req.body.classroom_id],
  );
  if (!classrooms.length) throw fail(400, 'Kelas tidak ditemukan di sekolah ini.', 'VALIDATION_ERROR');
  const participantCode = string(req.body.participant_code, 'participant_code', 60);
  const fullName = string(req.body.full_name, 'full_name', 150);
  const qrCode = req.body.qr_code === undefined ? `SAAS-${randomUUID()}` : string(req.body.qr_code, 'qr_code', 160);
  const guardianPhone = req.body.guardian_phone == null ? null : string(req.body.guardian_phone, 'guardian_phone', 32);
  const [result] = await pool.execute(
    `INSERT INTO participants
      (sekolah_id, classroom_id, participant_code, full_name, qr_code, guardian_phone)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [req.schoolUser.sekolah_id, req.body.classroom_id, participantCode, fullName, qrCode, guardianPhone],
  );
  res.status(201).json({ participant: {
    id: String(result.insertId), classroom_id: String(req.body.classroom_id),
    participant_code: participantCode, full_name: fullName, qr_code: qrCode, guardian_phone: guardianPhone,
  } });
}));

const updateParticipant = asyncRoute(async (req, res) => {
  const participantId = req.params.id ?? req.body?.id;
  if (!/^[1-9]\d*$/.test(String(participantId ?? ''))) {
    throw fail(400, 'id peserta wajib diisi.', 'VALIDATION_ERROR');
  }
  const allowed = ['classroom_id', 'participant_code', 'full_name', 'qr_code', 'guardian_phone', 'is_active'];
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
    } else if (key === 'guardian_phone' && value === null) values.push(null);
    else values.push(string(value, key, key === 'participant_code' ? 60 : key === 'qr_code' ? 160 : key === 'guardian_phone' ? 32 : 150));
    updates.push(`\`${key}\` = ?`);
  }
  await pool.execute(
    `UPDATE participants SET ${updates.join(', ')} WHERE sekolah_id = ? AND id = ?`,
    [...values, req.schoolUser.sekolah_id, participantId],
  );
  const [[participant]] = await pool.execute(
    `SELECT id, classroom_id, participant_code, full_name, qr_code, guardian_phone, is_active
       FROM participants WHERE sekolah_id = ? AND id = ?`,
    [req.schoolUser.sekolah_id, participantId],
  );
  res.json({ participant });
});
router.put('/participants/:id', requireSchoolUser, requirePermission('participants.manage'), updateParticipant);
router.put('/participants', requireSchoolUser, requirePermission('participants.manage'), updateParticipant);

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
  const [result] = await pool.execute(
    'DELETE FROM participants WHERE sekolah_id = ? AND id = ?',
    [req.schoolUser.sekolah_id, participantId],
  );
  if (!result.affectedRows) throw fail(409, 'Peserta telah memiliki data terkait dan tidak dapat dihapus.', 'CONFLICT');
  res.status(204).end();
});
router.delete('/participants/:id', requireSchoolUser, requirePermission('participants.manage'), deleteParticipant);
router.delete('/participants', requireSchoolUser, requirePermission('participants.manage'), deleteParticipant);

router.get('/settings', requireSchoolUser, requirePermission('settings.operational.manage'), asyncRoute(async (req, res) => {
  const [[settings]] = await pool.execute(
    `SELECT timezone, check_in_deadline, lateness_tolerance_minutes, check_out_start
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
  res.json({ settings: { ...settings, weekly_schedules: schedules, holidays } });
}));

router.put('/settings', requireSchoolUser, requirePermission('settings.operational.manage'), asyncRoute(async (req, res) => {
  const body = req.body ?? {};
  const timezone = body.timezone ?? req.schoolUser.timezone;
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }); } catch { throw fail(400, 'Timezone tidak valid.'); }
  const tolerance = body.lateness_tolerance_minutes ?? 0;
  if (!Number.isInteger(tolerance) || tolerance < 0 || tolerance > 180) throw fail(400, 'Toleransi harus 0–180 menit.');
  const checkIn = body.check_in_deadline ?? '08:00:00';
  const checkOut = body.check_out_start ?? '15:00:00';
  const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/;
  if (!timePattern.test(checkIn) || !timePattern.test(checkOut)) throw fail(400, 'Format jam harus HH:mm[:ss].');
  const schedules = body.weekly_schedules ?? [];
  const holidays = body.holidays ?? [];
  if (!Array.isArray(schedules) || schedules.some((item) =>
    !Number.isInteger(item.weekday) || item.weekday < 0 || item.weekday > 6 ||
    typeof item.is_working_day !== 'boolean' ||
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
        lateness_tolerance_minutes = ?, check_out_start = ?, updated_by = ?
       WHERE sekolah_id = ?`,
      [timezone, checkIn, tolerance, checkOut, req.schoolUser.id, req.schoolUser.sekolah_id],
    );
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

router.get('/settings/whatsapp-gateway', requireSchoolUser, requirePermission('settings.operational.manage'), asyncRoute(async (req, res) => {
  const [[settings]] = await pool.execute(
    `SELECT endpoint_url, token_ciphertext, is_enabled
       FROM school_whatsapp_gateway_config WHERE sekolah_id = ?`,
    [req.schoolUser.sekolah_id],
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

router.put('/settings/whatsapp-gateway', requireSchoolUser, requirePermission('settings.operational.manage'), asyncRoute(async (req, res) => {
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
      (sekolah_id, endpoint_url, token_ciphertext, token_iv, token_auth_tag, is_enabled)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE endpoint_url = VALUES(endpoint_url),
       token_ciphertext = VALUES(token_ciphertext), token_iv = VALUES(token_iv),
       token_auth_tag = VALUES(token_auth_tag), is_enabled = VALUES(is_enabled)`,
    [req.schoolUser.sekolah_id, settings.endpointUrl, encrypted?.ciphertext ?? null,
      encrypted?.iv ?? null, encrypted?.authTag ?? null, settings.isEnabled],
  );
  res.json({ message: 'Pengaturan WhatsApp sekolah disimpan.' });
}));

router.delete('/settings/whatsapp-gateway', requireSchoolUser, requirePermission('settings.operational.manage'), asyncRoute(async (req, res) => {
  await pool.execute(
    `DELETE FROM school_whatsapp_gateway_config WHERE sekolah_id = ?`,
    [req.schoolUser.sekolah_id],
  );
  res.json({ message: 'Konfigurasi WhatsApp sekolah dihapus.' });
}));

router.get('/billing', requireSchoolUser, asyncRoute(async (req, res) => {
  requireBillingAdmin(req);
  const [[school]] = await pool.execute(
    `SELECT subscription_status, trial_ends_at, subscription_expires_at
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
    },
    orders: orders.map((order) => ({ ...order, amount: Number(order.amount) })),
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
  if (!['xendit', 'duitku'].includes(provider) ||
      !['monthly', 'lifetime'].includes(plan) ||
      typeof email !== 'string' || email.length > 255 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    throw fail(400, 'Provider, paket, dan email pembayaran harus valid.', 'VALIDATION_ERROR');
  }
  if (req.schoolUser.subscription_status === 'lifetime') {
    throw fail(409, 'Sekolah sudah memiliki langganan Lifetime.', 'ALREADY_LIFETIME');
  }
  if (provider === 'duitku' &&
      (typeof paymentMethod !== 'string' || !/^[A-Za-z0-9]{1,20}$/.test(paymentMethod))) {
    throw fail(400, 'Pilih metode pembayaran Duitku.', 'VALIDATION_ERROR');
  }
  const [[prices]] = await pool.execute(
    'SELECT monthly_price, lifetime_price FROM platform_billing_settings WHERE id = 1',
  );
  const amount = Number(plan === 'lifetime'
    ? prices?.lifetime_price ?? 1000000
    : prices?.monthly_price ?? 50000);
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

router.post('/attendance/sync-batch', requireDevice, asyncRoute(async (req, res) => {
  const records = req.body?.records;
  if (!Array.isArray(records) || records.length < 1 || records.length > 100) {
    throw fail(400, 'records harus berisi 1–100 scan.', 'VALIDATION_ERROR');
  }
  const acceptedIds = [];
  const rejectedIds = [];
  const rejected = [];
  const settings = await loadAttendanceSettings(req.device.sekolah_id);
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
    if (!['check_in', 'check_out'].includes(eventType) ||
        !/^[1-9]\d*$/.test(String(participantId ?? '')) ||
        typeof record.client_timestamp !== 'string' ||
        !/(?:Z|[+-]\d{2}:\d{2})$/i.test(record.client_timestamp) ||
        !Number.isFinite(Date.parse(record.client_timestamp))) {
      rejectedIds.push(id);
      rejected.push({ id_unik: id, reason: 'invalid_record' });
      continue;
    }
    try {
      const [participants] = await pool.execute(
        `SELECT p.id, p.participant_code, p.full_name, p.classroom_id, c.name AS classroom_name
           FROM participants p JOIN classrooms c
             ON c.id = p.classroom_id AND c.sekolah_id = p.sekolah_id
          WHERE p.sekolah_id = ? AND p.id = ? AND p.is_active = TRUE`,
        [req.device.sekolah_id, participantId],
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
      const timestamp = new Date(record.client_timestamp).toISOString()
        .slice(0, 23).replace('T', ' ');
      try {
        await pool.execute(
          `INSERT INTO attendance_logs
            (sekolah_id, id_unik, participant_id, device_id, participant_code_snapshot,
             participant_name_snapshot, classroom_name_snapshot, attendance_date,
             event_type, client_timestamp_utc, attendance_status, late_minutes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [req.device.sekolah_id, id, participant.id, req.device.id,
            participant.participant_code, participant.full_name, participant.classroom_name,
            calculation.date, eventType, timestamp, calculation.status, calculation.lateMinutes],
        );
      } catch (error) {
        if (error.code !== 'ER_DUP_ENTRY') throw error;
        const [existing] = await pool.execute(
          `SELECT participant_id, event_type, attendance_date
             FROM attendance_logs WHERE sekolah_id = ? AND id_unik = ?`,
          [req.device.sekolah_id, id],
        );
        if (existing.length && String(existing[0].participant_id) === String(participant.id) &&
            existing[0].event_type === eventType && existing[0].attendance_date === calculation.date) {
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
        reason: ['participant_not_found', 'non_working_day', 'checkout_too_early', 'daily_duplicate']
          .includes(error.message) ? error.message : 'invalid_record',
      });
    }
  }
  await pool.execute('UPDATE scanner_devices SET last_synced_at = CURRENT_TIMESTAMP WHERE id = ?', [req.device.id]);
  res.json({ accepted_ids: acceptedIds, rejected_ids: rejectedIds, rejected });
}));

router.get('/attendance/report', requireSchoolUser, requirePermission('attendance.read'), asyncRoute(async (req, res) => {
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
  res.json({ from, to, attendance: rows });
}));

export default router;
