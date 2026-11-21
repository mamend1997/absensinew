-- MySQL 8+ / MariaDB. Buat database terpisah sebelum menjalankan file ini.
-- Contoh: CREATE DATABASE absensi CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS units (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    name VARCHAR(100) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_units_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS classrooms (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    unit_id BIGINT UNSIGNED NOT NULL,
    name VARCHAR(100) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_classrooms_unit_name (unit_id, name),
    CONSTRAINT fk_classrooms_unit FOREIGN KEY (unit_id) REFERENCES units (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS users (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    username VARCHAR(80) NOT NULL,
    display_name VARCHAR(150) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role ENUM('admin', 'operator') NOT NULL,
    classroom_id BIGINT UNSIGNED NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_users_username (username),
    CONSTRAINT fk_users_classroom FOREIGN KEY (classroom_id) REFERENCES classrooms (id),
    CONSTRAINT chk_users_role_classroom CHECK (
        (role = 'admin') OR (role = 'operator' AND classroom_id IS NOT NULL)
    )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS participants (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    participant_code VARCHAR(60) NOT NULL,
    full_name VARCHAR(150) NOT NULL,
    classroom_id BIGINT UNSIGNED NOT NULL,
    qr_code VARCHAR(160) NOT NULL,
    guardian_phone VARCHAR(32) NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_participants_code (participant_code),
    UNIQUE KEY uq_participants_qr (qr_code),
    KEY idx_participants_classroom_active (classroom_id, is_active),
    CONSTRAINT fk_participants_classroom FOREIGN KEY (classroom_id) REFERENCES classrooms (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS operational_settings (
    id TINYINT UNSIGNED NOT NULL,
    timezone VARCHAR(64) NOT NULL DEFAULT 'Asia/Jakarta',
    check_in_deadline TIME NOT NULL DEFAULT '08:00:00',
    lateness_tolerance_minutes SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    check_out_start TIME NOT NULL DEFAULT '15:00:00',
    scan_welcome_message VARCHAR(255) NOT NULL
        DEFAULT 'Selamat datang - mohon tertib saat melakukan absensi',
    scan_success_message VARCHAR(255) NOT NULL
        DEFAULT 'Terima kasih, {name}. Absensi {status} sudah dicatat.',
    scan_failure_message VARCHAR(255) NOT NULL
        DEFAULT 'Maaf, absensi {name} gagal. {reason}.',
    enable_external_scanner BOOLEAN NOT NULL DEFAULT TRUE,
    updated_by BIGINT UNSIGNED NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    CONSTRAINT chk_operational_settings_singleton CHECK (id = 1),
    CONSTRAINT fk_settings_updated_by FOREIGN KEY (updated_by) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS whatsapp_gateway_settings (
    id TINYINT UNSIGNED NOT NULL,
    endpoint_url VARCHAR(500) NULL,
    token_ciphertext VARBINARY(1024) NULL,
    token_iv BINARY(12) NULL,
    token_auth_tag BINARY(16) NULL,
    is_managed BOOLEAN NOT NULL DEFAULT FALSE,
    is_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    CONSTRAINT chk_whatsapp_gateway_settings_singleton CHECK (id = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
INSERT IGNORE INTO whatsapp_gateway_settings (id) VALUES (1);

CREATE TABLE IF NOT EXISTS weekly_operational_schedules (
    weekday TINYINT UNSIGNED NOT NULL,
    is_working_day BOOLEAN NOT NULL DEFAULT TRUE,
    check_in_deadline TIME NOT NULL,
    lateness_tolerance_minutes SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    check_out_start TIME NOT NULL,
    PRIMARY KEY (weekday),
    CONSTRAINT chk_weekly_schedule_weekday CHECK (weekday BETWEEN 0 AND 6),
    CONSTRAINT chk_weekly_schedule_tolerance CHECK (lateness_tolerance_minutes <= 180)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS participant_day_overrides (
    participant_id BIGINT UNSIGNED NOT NULL,
    weekday TINYINT UNSIGNED NOT NULL,
    check_in_deadline TIME NOT NULL,
    PRIMARY KEY (participant_id, weekday),
    CONSTRAINT chk_participant_override_weekday CHECK (weekday BETWEEN 0 AND 6),
    CONSTRAINT fk_participant_override_participant
        FOREIGN KEY (participant_id) REFERENCES participants (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS admin_menu_pin (
    id TINYINT UNSIGNED NOT NULL,
    pin_hash VARCHAR(255) NOT NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    CONSTRAINT chk_admin_menu_pin_singleton CHECK (id = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS attendance_logs (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    id_unik CHAR(36) NOT NULL,
    participant_id BIGINT UNSIGNED NOT NULL,
    participant_code_snapshot VARCHAR(60) NOT NULL,
    participant_name_snapshot VARCHAR(150) NOT NULL,
    classroom_name_snapshot VARCHAR(100) NOT NULL,
    attendance_date DATE NOT NULL,
    event_type ENUM('check_in', 'check_out') NOT NULL,
    client_timestamp DATETIME(3) NOT NULL,
    server_received_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    synced_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    attendance_status ENUM('hadir', 'terlambat', 'pulang') NOT NULL,
    late_minutes SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    scan_method ENUM('SCAN_QR', 'MANUAL_INPUT') NOT NULL DEFAULT 'SCAN_QR',
    device_id VARCHAR(100) NULL,
    recorded_by BIGINT UNSIGNED NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_attendance_id_unik (id_unik),
    UNIQUE KEY uq_attendance_daily_event (participant_id, attendance_date, event_type),
    KEY idx_attendance_date_class (attendance_date, classroom_name_snapshot),
    KEY idx_attendance_date_status (attendance_date, attendance_status),
    CONSTRAINT fk_attendance_participant FOREIGN KEY (participant_id) REFERENCES participants (id),
    CONSTRAINT fk_attendance_recorder FOREIGN KEY (recorded_by) REFERENCES users (id),
    CONSTRAINT chk_attendance_status_event CHECK (
        (event_type = 'check_out' AND attendance_status = 'pulang' AND late_minutes = 0)
        OR
        (event_type = 'check_in' AND attendance_status IN ('hadir', 'terlambat')
         AND ((attendance_status = 'hadir' AND late_minutes = 0)
              OR (attendance_status = 'terlambat' AND late_minutes > 0)))
    )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS activity_logs (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    actor_user_id BIGINT UNSIGNED NULL,
    actor_username VARCHAR(80) NOT NULL,
    actor_display_name VARCHAR(150) NOT NULL,
    action VARCHAR(80) NOT NULL,
    entity_type VARCHAR(80) NOT NULL,
    entity_id VARCHAR(100) NULL,
    before_data JSON NULL,
    after_data JSON NULL,
    ip_address VARCHAR(64) NULL,
    created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    KEY idx_activity_logs_created (created_at, id),
    KEY idx_activity_logs_entity (entity_type, entity_id, created_at),
    CONSTRAINT fk_activity_logs_actor FOREIGN KEY (actor_user_id)
        REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
INSERT IGNORE INTO scheduled_backup_settings (id) VALUES (1);

-- Seed referensi awal. Tidak ada akun dengan password default.
INSERT INTO units (name) VALUES ('Unit Contoh')
    ON DUPLICATE KEY UPDATE name = VALUES(name);

INSERT INTO classrooms (unit_id, name)
SELECT id, 'Kelas 1' FROM units WHERE name = 'Unit Contoh'
    ON DUPLICATE KEY UPDATE name = VALUES(name);

INSERT INTO participants (participant_code, full_name, classroom_id, qr_code)
SELECT 'DEMO-001', 'Peserta Contoh 1', c.id, 'ABSENSI-DEMO-001'
FROM classrooms c JOIN units u ON u.id = c.unit_id
WHERE u.name = 'Unit Contoh' AND c.name = 'Kelas 1'
ON DUPLICATE KEY UPDATE full_name = VALUES(full_name);

INSERT INTO participants (participant_code, full_name, classroom_id, qr_code)
SELECT 'DEMO-002', 'Peserta Contoh 2', c.id, 'ABSENSI-DEMO-002'
FROM classrooms c JOIN units u ON u.id = c.unit_id
WHERE u.name = 'Unit Contoh' AND c.name = 'Kelas 1'
ON DUPLICATE KEY UPDATE full_name = VALUES(full_name);

INSERT INTO operational_settings (
    id, timezone, check_in_deadline, lateness_tolerance_minutes, check_out_start
)
VALUES (1, 'Asia/Jakarta', '08:00:00', 0, '15:00:00')
ON DUPLICATE KEY UPDATE id = VALUES(id);

INSERT IGNORE INTO weekly_operational_schedules
    (weekday, is_working_day, check_in_deadline, lateness_tolerance_minutes, check_out_start)
    SELECT 0, FALSE, check_in_deadline, lateness_tolerance_minutes, check_out_start
    FROM operational_settings WHERE id = 1;
INSERT IGNORE INTO weekly_operational_schedules
    (weekday, is_working_day, check_in_deadline, lateness_tolerance_minutes, check_out_start)
    SELECT 1, TRUE, check_in_deadline, lateness_tolerance_minutes, check_out_start
    FROM operational_settings WHERE id = 1;
INSERT IGNORE INTO weekly_operational_schedules
    (weekday, is_working_day, check_in_deadline, lateness_tolerance_minutes, check_out_start)
    SELECT 2, TRUE, check_in_deadline, lateness_tolerance_minutes, check_out_start
    FROM operational_settings WHERE id = 1;
INSERT IGNORE INTO weekly_operational_schedules
    (weekday, is_working_day, check_in_deadline, lateness_tolerance_minutes, check_out_start)
    SELECT 3, TRUE, check_in_deadline, lateness_tolerance_minutes, check_out_start
    FROM operational_settings WHERE id = 1;
INSERT IGNORE INTO weekly_operational_schedules
    (weekday, is_working_day, check_in_deadline, lateness_tolerance_minutes, check_out_start)
    SELECT 4, TRUE, check_in_deadline, lateness_tolerance_minutes, check_out_start
    FROM operational_settings WHERE id = 1;
INSERT IGNORE INTO weekly_operational_schedules
    (weekday, is_working_day, check_in_deadline, lateness_tolerance_minutes, check_out_start)
    SELECT 5, TRUE, check_in_deadline, lateness_tolerance_minutes, check_out_start
    FROM operational_settings WHERE id = 1;
INSERT IGNORE INTO weekly_operational_schedules
    (weekday, is_working_day, check_in_deadline, lateness_tolerance_minutes, check_out_start)
    SELECT 6, FALSE, check_in_deadline, lateness_tolerance_minutes, check_out_start
    FROM operational_settings WHERE id = 1;
