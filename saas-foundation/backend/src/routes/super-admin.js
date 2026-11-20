import { Router } from 'express';
import { generateUniqueSchoolCode, isValidSchoolCode } from '../core/school-code.js';
import { parseLogoDataUrl } from '../core/branding.js';
import { inTransaction, pool } from '../db.js';
import { asyncRoute, fail, requireFields } from '../http.js';
import { requireSuperAdmin } from '../middleware/auth.js';
import { hashPassword, signToken, verifyPassword } from '../security.js';

const router = Router();
const adminPermissions = [
  'dashboard.read', 'attendance.read', 'attendance.export',
  'participants.read', 'participants.manage', 'participants.qr.print',
  'settings.operational.manage', 'attendance.excuse.manage',
  'scanner.use', 'school.users.manage', 'school.roles.manage',
];

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

router.post('/auth/login', asyncRoute(async (req, res) => {
  requireFields(req.body, ['username', 'password']);
  const username = validateString(req.body.username, 'username', 80);
  const [rows] = await pool.execute(
    'SELECT id, username, display_name, password_hash, is_active FROM super_admins WHERE username = ?',
    [username],
  );
  const admin = rows[0];
  const valid = await verifyPassword(req.body.password, admin?.password_hash);
  if (!admin || !admin.is_active || !valid) {
    throw fail(401, 'Username atau password tidak benar.', 'INVALID_CREDENTIALS');
  }
  res.json({
    access_token: signToken({ kind: 'super_admin', sub: String(admin.id) }),
    token_type: 'Bearer',
    expires_in: process.env.JWT_TTL ?? '8h',
    admin: { id: String(admin.id), username: admin.username, display_name: admin.display_name },
  });
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

router.delete('/branding/logo', requireSuperAdmin, asyncRoute(async (req, res) => {
  await pool.execute(
    'UPDATE platform_branding SET logo_mime_type = NULL, logo_data = NULL WHERE id = 1',
  );
  res.json({ message: 'Logo platform dihapus.' });
}));

router.use(requireSuperAdmin);

router.get('/schools', asyncRoute(async (req, res) => {
  const [rows] = await pool.execute(
    `SELECT id, slug, school_code, name, subscription_status, trial_ends_at,
            subscription_expires_at, participant_quota, timezone, is_active, created_at, updated_at
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
  if (!['trial', 'aktif'].includes(status)) {
    throw fail(400, 'subscription_status harus trial atau aktif.', 'VALIDATION_ERROR');
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
  const result = await inTransaction(async (connection) => {
    const [schoolResult] = await connection.execute(
      `INSERT INTO schools
        (slug, school_code, name, subscription_status, trial_ends_at, participant_quota, timezone)
       VALUES (?, ?, ?, ?, IF(? = 'trial', DATE_ADD(UTC_TIMESTAMP(), INTERVAL 30 DAY), NULL), ?, ?)`,
      [slug, schoolCode, name, status, status, quota, timezone],
    );
    const schoolId = String(schoolResult.insertId);
    const roles = [
      ['admin-sekolah', 'Admin Sekolah', adminPermissions, true],
      ['operator-scanner', 'Operator Scanner', ['scanner.use'], true],
      ['kepala-sekolah', 'Kepala Sekolah', ['dashboard.read', 'attendance.read', 'attendance.export'], false],
      ['wakasek-kesiswaan', 'Wakasek Kesiswaan', [
        'dashboard.read', 'attendance.read', 'attendance.export', 'participants.read',
        'attendance.excuse.manage',
      ], false],
    ];
    for (const [key, roleName, permissions, system] of roles) {
      await connection.execute(
        'INSERT INTO roles (sekolah_id, role_key, role_name, permissions, is_system) VALUES (?, ?, ?, ?, ?)',
        [schoolId, key, roleName, JSON.stringify(permissions), system],
      );
    }
    const [[adminRole]] = await connection.execute(
      "SELECT id FROM roles WHERE sekolah_id = ? AND role_key = 'admin-sekolah'",
      [schoolId],
    );
    await connection.execute(
      `INSERT INTO users (sekolah_id, role_id, username, display_name, password_hash, is_active)
       VALUES (?, ?, ?, ?, ?, TRUE)`,
      [schoolId, adminRole.id, adminUsername, adminName, passwordHash],
    );
    await connection.execute(
      'INSERT INTO operational_settings (sekolah_id, timezone) VALUES (?, ?)',
      [schoolId, timezone],
    );
    for (let weekday = 0; weekday <= 6; weekday += 1) {
      await connection.execute(
        `INSERT INTO weekly_operational_schedules
          (sekolah_id, weekday, is_working_day, check_in_deadline,
           lateness_tolerance_minutes, check_out_start)
         VALUES (?, ?, ?, '08:00:00', 0, '15:00:00')`,
        [schoolId, weekday, weekday >= 1 && weekday <= 5],
      );
    }
    return { id: schoolId };
  });
  res.status(201).json({
    school: { ...result, slug, school_code: schoolCode, name, subscription_status: status },
    initial_admin: { username: adminUsername, display_name: adminName },
  });
}));

router.patch('/schools/:id', asyncRoute(async (req, res) => {
  const allowed = ['name', 'subscription_status', 'trial_ends_at',
    'subscription_expires_at', 'participant_quota', 'timezone', 'is_active'];
  const entries = Object.entries(req.body ?? {}).filter(([key]) => allowed.includes(key));
  if (!entries.length || entries.length !== Object.keys(req.body ?? {}).length) {
    throw fail(400, 'Field perubahan tidak valid atau kosong.', 'VALIDATION_ERROR');
  }
  const values = [];
  for (const [key, value] of entries) {
    if (key === 'name') values.push(validateString(value, key, 180));
    else if (key === 'subscription_status') {
      if (!['trial', 'aktif', 'suspend'].includes(value)) throw fail(400, 'Status langganan tidak valid.');
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
