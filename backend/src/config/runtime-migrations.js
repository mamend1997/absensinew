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

  if (!(await database.hasColumn('attendance_notifications', 'id'))) {
    if (database.dialect === 'mysql') {
      await database.query(`
        CREATE TABLE IF NOT EXISTS attendance_notifications (
          id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
          id_unik CHAR(36) NOT NULL,
          recipient_phone VARCHAR(32) NOT NULL,
          event_type VARCHAR(32) NOT NULL,
          message TEXT NOT NULL,
          status ENUM('pending', 'sent', 'failed') NOT NULL DEFAULT 'pending',
          attempt_count SMALLINT UNSIGNED NOT NULL DEFAULT 0,
          next_attempt_at BIGINT UNSIGNED NOT NULL DEFAULT 0,
          last_error VARCHAR(500) NULL,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          sent_at TIMESTAMP NULL,
          PRIMARY KEY (id),
          UNIQUE KEY uq_attendance_notification_once (id_unik, recipient_phone, event_type),
          KEY idx_attendance_notification_pending (status, next_attempt_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
    } else {
      await database.query(`
        CREATE TABLE IF NOT EXISTS attendance_notifications (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          id_unik TEXT NOT NULL,
          recipient_phone TEXT NOT NULL,
          event_type TEXT NOT NULL,
          message TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending'
            CHECK (status IN ('pending', 'sent', 'failed')),
          attempt_count INTEGER NOT NULL DEFAULT 0,
          next_attempt_at INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          sent_at TEXT,
          UNIQUE (id_unik, recipient_phone, event_type)
        )
      `);
      await database.query(
        `CREATE INDEX IF NOT EXISTS idx_attendance_notification_pending
           ON attendance_notifications (status, next_attempt_at)`,
      );
    }
  }

  if (database.dialect === 'mysql') {
    await database.query(`
      CREATE TABLE IF NOT EXISTS scheduled_backup_settings (
        id TINYINT UNSIGNED NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT FALSE,
        backup_time CHAR(5) NOT NULL DEFAULT '02:00',
        encrypted_credentials TEXT NULL,
        last_run_date CHAR(10) NULL,
        last_status VARCHAR(24) NOT NULL DEFAULT 'never',
        last_run_at TIMESTAMP NULL,
        last_error VARCHAR(500) NULL,
        PRIMARY KEY (id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await database.query(
      `INSERT IGNORE INTO scheduled_backup_settings (id) VALUES (1)`,
    );
  } else {
    await database.query(`
      CREATE TABLE IF NOT EXISTS scheduled_backup_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
        backup_time TEXT NOT NULL DEFAULT '02:00',
        encrypted_credentials TEXT,
        last_run_date TEXT,
        last_status TEXT NOT NULL DEFAULT 'never',
        last_run_at TEXT,
        last_error TEXT
      )
    `);
    await database.query(
      `INSERT OR IGNORE INTO scheduled_backup_settings (id) VALUES (1)`,
    );
  }

  await database.ensureActivityLogSchema();
}
