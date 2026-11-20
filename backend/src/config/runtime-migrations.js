export async function ensureRuntimeMigrations(database) {
  const hasUsers = await database.hasColumn('users', 'id');
  if (!hasUsers) return;

  if (
    await database.hasColumn('weekly_operational_schedules', 'weekday') &&
    !(await database.hasColumn('weekly_operational_schedules', 'is_working_day'))
  ) {
    await database.addColumn(
      'weekly_operational_schedules',
      'is_working_day BOOLEAN NOT NULL DEFAULT TRUE',
    );
    await database.query(
      'UPDATE weekly_operational_schedules SET is_working_day = 0 WHERE weekday IN (0, 6)',
    );
  }

  const columns = [
    ['participants', 'id', 'guardian_phone', 'guardian_phone VARCHAR(32) NULL'],
    [
      'operational_settings',
      'id',
      'lateness_tolerance_minutes',
      'lateness_tolerance_minutes SMALLINT NOT NULL DEFAULT 0',
    ],
    ['attendance_logs', 'id', 'synced_at', 'synced_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP'],
    [
      'attendance_logs',
      'id',
      'scan_method',
      database.dialect === 'mysql'
        ? "scan_method ENUM('SCAN_QR', 'MANUAL_INPUT') NOT NULL DEFAULT 'SCAN_QR'"
        : "scan_method TEXT NOT NULL DEFAULT 'SCAN_QR' CHECK (scan_method IN ('SCAN_QR', 'MANUAL_INPUT'))",
    ],
    [
      'operational_settings',
      'id',
      'scan_success_message',
      "scan_success_message VARCHAR(255) NOT NULL DEFAULT 'Terima kasih, {name}. Absensi {status} sudah dicatat.'",
    ],
    [
      'operational_settings',
      'id',
      'scan_failure_message',
      "scan_failure_message VARCHAR(255) NOT NULL DEFAULT 'Maaf, absensi {name} gagal. {reason}.'",
    ],
    [
      'operational_settings',
      'id',
      'scan_welcome_message',
      "scan_welcome_message VARCHAR(255) NOT NULL DEFAULT 'Selamat datang - mohon tertib saat melakukan absensi'",
    ],
    [
      'operational_settings',
      'id',
      'enable_external_scanner',
      database.dialect === 'mysql'
        ? 'enable_external_scanner BOOLEAN NOT NULL DEFAULT TRUE'
        : 'enable_external_scanner INTEGER NOT NULL DEFAULT 1 CHECK (enable_external_scanner IN (0, 1))',
    ],
  ];

  for (const [table, anchorColumn, column, definition] of columns) {
    if (
      await database.hasColumn(table, anchorColumn) &&
      !(await database.hasColumn(table, column))
    ) {
      await database.addColumn(table, definition);
    }
  }

  await database.ensureActivityLogSchema();
}
