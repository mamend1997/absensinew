import { db } from '../src/config/database.js';

try {
  if (
    await db.hasColumn('weekly_operational_schedules', 'weekday') &&
    !(await db.hasColumn('weekly_operational_schedules', 'is_working_day'))
  ) {
    await db.addColumn(
      'weekly_operational_schedules',
      'is_working_day BOOLEAN NOT NULL DEFAULT TRUE',
    );
    await db.query(
      'UPDATE weekly_operational_schedules SET is_working_day = 0 WHERE weekday IN (0, 6)',
    );
  }

  await db.initializeSchema();

  if (!(await db.hasColumn('operational_settings', 'lateness_tolerance_minutes'))) {
    await db.addColumn(
      'operational_settings',
      'lateness_tolerance_minutes SMALLINT NOT NULL DEFAULT 0',
    );
  }
  if (!(await db.hasColumn('attendance_logs', 'synced_at'))) {
    await db.addColumn(
      'attendance_logs',
      'synced_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP',
    );
  }
  if (!(await db.hasColumn('attendance_logs', 'scan_method'))) {
    await db.addColumn(
      'attendance_logs',
      db.dialect === 'mysql'
        ? "scan_method ENUM('SCAN_QR', 'MANUAL_INPUT') NOT NULL DEFAULT 'SCAN_QR'"
        : "scan_method TEXT NOT NULL DEFAULT 'SCAN_QR' CHECK (scan_method IN ('SCAN_QR', 'MANUAL_INPUT'))",
    );
  }
  if (!(await db.hasColumn('operational_settings', 'scan_success_message'))) {
    await db.addColumn(
      'operational_settings',
      "scan_success_message VARCHAR(255) NOT NULL DEFAULT 'Terima kasih, {name}. Absensi {status} sudah dicatat.'",
    );
  }
  if (!(await db.hasColumn('operational_settings', 'scan_failure_message'))) {
    await db.addColumn(
      'operational_settings',
      "scan_failure_message VARCHAR(255) NOT NULL DEFAULT 'Maaf, absensi {name} gagal. {reason}.'",
    );
  }
  if (!(await db.hasColumn('operational_settings', 'scan_welcome_message'))) {
    await db.addColumn(
      'operational_settings',
      "scan_welcome_message VARCHAR(255) NOT NULL DEFAULT 'Selamat datang - mohon tertib saat melakukan absensi'",
    );
  }
  console.log('Skema database berhasil diinisialisasi.');
} catch (error) {
  console.error('Gagal menginisialisasi skema database:', error);
  process.exitCode = 1;
} finally {
  await db.close();
}
