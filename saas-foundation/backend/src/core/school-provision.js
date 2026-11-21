export const ADMIN_PERMISSIONS = [
  'dashboard.read', 'attendance.read', 'attendance.export',
  'participants.read', 'participants.manage', 'participants.qr.print',
  'settings.operational.manage', 'attendance.excuse.manage',
  'scanner.use', 'school.users.manage', 'school.roles.manage',
];

export async function provisionSchool(connection, {
  slug,
  schoolCode,
  name,
  adminUsername,
  adminName,
  adminPhone = null,
  passwordHash,
  status = 'trial',
  quota = 500,
  timezone = 'Asia/Jakarta',
}) {
  const [schoolResult] = await connection.execute(
    `INSERT INTO schools
      (slug, school_code, name, subscription_status, trial_ends_at, participant_quota, timezone)
     VALUES (?, ?, ?, ?, IF(? = 'trial', DATE_ADD(UTC_TIMESTAMP(), INTERVAL 30 DAY), NULL), ?, ?)`,
    [slug, schoolCode, name, status, status, quota, timezone],
  );
  const schoolId = String(schoolResult.insertId);
  const roles = [
    ['admin-sekolah', 'Admin Sekolah', ADMIN_PERMISSIONS, true],
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
    `INSERT INTO users
      (sekolah_id, role_id, username, display_name, whatsapp_phone, password_hash, is_active)
     VALUES (?, ?, ?, ?, ?, ?, TRUE)`,
    [schoolId, adminRole.id, adminUsername, adminName, adminPhone, passwordHash],
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
  return schoolId;
}
