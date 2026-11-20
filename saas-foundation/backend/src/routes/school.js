import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { calculateAttendance } from '../core/attendance.js';
import { pool } from '../db.js';
import {
  asyncRoute, fail, parseJson, requireFields,
} from '../http.js';
import {
  classroomScope, requireDevice, requirePermission, requireSchoolUser,
} from '../middleware/auth.js';
import { createDeviceApiKey, hashPassword, signToken, verifyPassword } from '../security.js';

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

router.post('/auth/login', asyncRoute(async (req, res) => {
  requireFields(req.body, ['school_code', 'username', 'password']);
  if (typeof req.body.school_code !== 'string' || !/^\d{4}$/.test(req.body.school_code)) {
    throw fail(401, 'Kode sekolah, username, atau password tidak benar.', 'INVALID_CREDENTIALS');
  }
  const [rows] = await pool.execute(
    `SELECT u.id, u.sekolah_id, u.username, u.display_name, u.password_hash,
            u.is_active, s.school_code, s.name AS school_name, s.timezone,
            s.subscription_status, r.role_name
       FROM schools s JOIN users u ON u.sekolah_id = s.id
       JOIN roles r ON r.id = u.role_id AND r.sekolah_id = u.sekolah_id
      WHERE s.school_code = ? AND u.username = ? AND s.is_active = TRUE
        AND s.subscription_status <> 'suspend'
        AND (s.subscription_status <> 'trial' OR s.trial_ends_at IS NULL
             OR s.trial_ends_at > UTC_TIMESTAMP())
        AND (s.subscription_expires_at IS NULL
             OR s.subscription_expires_at > UTC_TIMESTAMP())`,
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
    },
    school: {
      id: user.sekolah_id, school_code: user.school_code,
      name: user.school_name, timezone: user.timezone,
    },
  });
});

router.get('/roles', requireSchoolUser, asyncRoute(async (req, res) => {
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
