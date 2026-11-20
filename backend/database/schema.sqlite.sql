-- SQLite 3.35+. Jalankan dengan foreign key enforcement aktif.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS units (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS classrooms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    unit_id INTEGER NOT NULL REFERENCES units(id),
    name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (unit_id, name)
);

CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'operator')),
    classroom_id INTEGER REFERENCES classrooms(id),
    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK ((role = 'admin') OR (role = 'operator' AND classroom_id IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS participants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    participant_code TEXT NOT NULL UNIQUE,
    full_name TEXT NOT NULL,
    classroom_id INTEGER NOT NULL REFERENCES classrooms(id),
    qr_code TEXT NOT NULL UNIQUE,
    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_participants_classroom_active
    ON participants (classroom_id, is_active);

CREATE TABLE IF NOT EXISTS admin_menu_pin (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    pin_hash TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS operational_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    timezone TEXT NOT NULL DEFAULT 'Asia/Jakarta',
    check_in_deadline TEXT NOT NULL DEFAULT '08:00:00',
    lateness_tolerance_minutes INTEGER NOT NULL DEFAULT 0
        CHECK (lateness_tolerance_minutes BETWEEN 0 AND 180),
    check_out_start TEXT NOT NULL DEFAULT '15:00:00',
    scan_welcome_message TEXT NOT NULL
        DEFAULT 'Selamat datang - mohon tertib saat melakukan absensi',
    scan_success_message TEXT NOT NULL
        DEFAULT 'Terima kasih, {name}. Absensi {status} sudah dicatat.',
    scan_failure_message TEXT NOT NULL
        DEFAULT 'Maaf, absensi {name} gagal. {reason}.',
    updated_by INTEGER REFERENCES users(id),
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS weekly_operational_schedules (
    weekday INTEGER PRIMARY KEY CHECK (weekday BETWEEN 0 AND 6),
    check_in_deadline TEXT NOT NULL,
    lateness_tolerance_minutes INTEGER NOT NULL
        CHECK (lateness_tolerance_minutes BETWEEN 0 AND 180),
    check_out_start TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS participant_day_overrides (
    participant_id INTEGER NOT NULL REFERENCES participants(id),
    weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
    check_in_deadline TEXT NOT NULL,
    PRIMARY KEY (participant_id, weekday)
);

CREATE TABLE IF NOT EXISTS attendance_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    id_unik TEXT NOT NULL UNIQUE,
    participant_id INTEGER NOT NULL REFERENCES participants(id),
    participant_code_snapshot TEXT NOT NULL,
    participant_name_snapshot TEXT NOT NULL,
    classroom_name_snapshot TEXT NOT NULL,
    attendance_date TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK (event_type IN ('check_in', 'check_out')),
    client_timestamp TEXT NOT NULL,
    server_received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    attendance_status TEXT NOT NULL CHECK (
        attendance_status IN ('hadir', 'terlambat', 'pulang')
    ),
    late_minutes INTEGER NOT NULL DEFAULT 0 CHECK (late_minutes BETWEEN 0 AND 65535),
    scan_method TEXT NOT NULL DEFAULT 'SCAN_QR'
        CHECK (scan_method IN ('SCAN_QR', 'MANUAL_INPUT')),
    device_id TEXT,
    recorded_by INTEGER REFERENCES users(id),
    UNIQUE (participant_id, attendance_date, event_type),
    CHECK (
        (event_type = 'check_out' AND attendance_status = 'pulang' AND late_minutes = 0)
        OR
        (event_type = 'check_in' AND attendance_status IN ('hadir', 'terlambat')
         AND ((attendance_status = 'hadir' AND late_minutes = 0)
              OR (attendance_status = 'terlambat' AND late_minutes > 0)))
    )
);
CREATE INDEX IF NOT EXISTS idx_attendance_date_class
    ON attendance_logs (attendance_date, classroom_name_snapshot);
CREATE INDEX IF NOT EXISTS idx_attendance_date_status
    ON attendance_logs (attendance_date, attendance_status);

INSERT OR IGNORE INTO units (name) VALUES ('Unit Contoh');
INSERT OR IGNORE INTO classrooms (unit_id, name)
    SELECT id, 'Kelas 1' FROM units WHERE name = 'Unit Contoh';
INSERT OR IGNORE INTO participants (participant_code, full_name, classroom_id, qr_code)
    SELECT 'DEMO-001', 'Peserta Contoh 1', c.id, 'ABSENSI-DEMO-001'
    FROM classrooms c JOIN units u ON u.id = c.unit_id
    WHERE u.name = 'Unit Contoh' AND c.name = 'Kelas 1';
INSERT OR IGNORE INTO participants (participant_code, full_name, classroom_id, qr_code)
    SELECT 'DEMO-002', 'Peserta Contoh 2', c.id, 'ABSENSI-DEMO-002'
    FROM classrooms c JOIN units u ON u.id = c.unit_id
    WHERE u.name = 'Unit Contoh' AND c.name = 'Kelas 1';
INSERT OR IGNORE INTO operational_settings (id, timezone, check_in_deadline, check_out_start)
    VALUES (1, 'Asia/Jakarta', '08:00:00', '15:00:00');
INSERT OR IGNORE INTO weekly_operational_schedules
    (weekday, check_in_deadline, lateness_tolerance_minutes, check_out_start)
    SELECT 0, check_in_deadline, lateness_tolerance_minutes, check_out_start
    FROM operational_settings WHERE id = 1;
INSERT OR IGNORE INTO weekly_operational_schedules
    (weekday, check_in_deadline, lateness_tolerance_minutes, check_out_start)
    SELECT 1, check_in_deadline, lateness_tolerance_minutes, check_out_start
    FROM operational_settings WHERE id = 1;
INSERT OR IGNORE INTO weekly_operational_schedules
    (weekday, check_in_deadline, lateness_tolerance_minutes, check_out_start)
    SELECT 2, check_in_deadline, lateness_tolerance_minutes, check_out_start
    FROM operational_settings WHERE id = 1;
INSERT OR IGNORE INTO weekly_operational_schedules
    (weekday, check_in_deadline, lateness_tolerance_minutes, check_out_start)
    SELECT 3, check_in_deadline, lateness_tolerance_minutes, check_out_start
    FROM operational_settings WHERE id = 1;
INSERT OR IGNORE INTO weekly_operational_schedules
    (weekday, check_in_deadline, lateness_tolerance_minutes, check_out_start)
    SELECT 4, check_in_deadline, lateness_tolerance_minutes, check_out_start
    FROM operational_settings WHERE id = 1;
INSERT OR IGNORE INTO weekly_operational_schedules
    (weekday, check_in_deadline, lateness_tolerance_minutes, check_out_start)
    SELECT 5, check_in_deadline, lateness_tolerance_minutes, check_out_start
    FROM operational_settings WHERE id = 1;
INSERT OR IGNORE INTO weekly_operational_schedules
    (weekday, check_in_deadline, lateness_tolerance_minutes, check_out_start)
    SELECT 6, check_in_deadline, lateness_tolerance_minutes, check_out_start
    FROM operational_settings WHERE id = 1;
