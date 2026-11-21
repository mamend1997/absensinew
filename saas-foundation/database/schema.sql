-- MySQL 8+. Jalankan pada database baru khusus fondasi SaaS.
-- Akun bootstrap berstatus nonaktif dan wajib diprovision dengan hash baru.
SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS super_admins (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    username VARCHAR(80) NOT NULL,
    display_name VARCHAR(150) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    whatsapp_phone VARCHAR(20) NULL,
    auth_version INT UNSIGNED NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_super_admin_username (username),
    UNIQUE KEY uq_super_admin_whatsapp (whatsapp_phone)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS super_admin_password_reset_challenges (
    id CHAR(36) NOT NULL,
    super_admin_id BIGINT UNSIGNED NULL,
    username VARCHAR(80) NOT NULL,
    whatsapp_phone VARCHAR(20) NOT NULL,
    otp_hash BINARY(32) NOT NULL,
    expires_at DATETIME NOT NULL,
    attempt_count TINYINT UNSIGNED NOT NULL DEFAULT 0,
    request_ip_hash CHAR(64) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME NULL,
    PRIMARY KEY (id),
    KEY idx_super_admin_reset_phone_created (whatsapp_phone, created_at),
    KEY idx_super_admin_reset_ip_created (request_ip_hash, created_at),
    KEY idx_super_admin_reset_admin_created (super_admin_id, created_at),
    KEY idx_super_admin_reset_expiry (expires_at),
    CONSTRAINT fk_super_admin_reset_admin FOREIGN KEY (super_admin_id)
        REFERENCES super_admins (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS platform_branding (
    id TINYINT UNSIGNED NOT NULL,
    application_name VARCHAR(120) NOT NULL DEFAULT 'Ruang Hadir',
    logo_mime_type VARCHAR(32) NULL,
    logo_data MEDIUMBLOB NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    CONSTRAINT chk_platform_branding_singleton CHECK (id = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
INSERT IGNORE INTO platform_branding (id) VALUES (1);

CREATE TABLE IF NOT EXISTS whatsapp_gateway_config (
    id TINYINT UNSIGNED NOT NULL,
    endpoint_url VARCHAR(500) NULL,
    token_ciphertext VARBINARY(1024) NULL,
    token_iv BINARY(12) NULL,
    token_auth_tag BINARY(16) NULL,
    is_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    CONSTRAINT chk_whatsapp_gateway_singleton CHECK (id = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
INSERT IGNORE INTO whatsapp_gateway_config (id) VALUES (1);

CREATE TABLE IF NOT EXISTS platform_download_settings (
    id TINYINT UNSIGNED NOT NULL,
    apk_drive_url VARCHAR(2048) NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    CONSTRAINT chk_platform_download_singleton CHECK (id = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
INSERT IGNORE INTO platform_download_settings (id) VALUES (1);

CREATE TABLE IF NOT EXISTS schools (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    slug VARCHAR(100) NOT NULL,
    school_code CHAR(4) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    name VARCHAR(180) NOT NULL,
    subscription_status ENUM('trial', 'aktif', 'suspend', 'lifetime') NOT NULL DEFAULT 'trial',
    trial_ends_at DATETIME NULL,
    subscription_expires_at DATETIME NULL,
    participant_quota INT UNSIGNED NOT NULL DEFAULT 500,
    timezone VARCHAR(64) NOT NULL DEFAULT 'Asia/Jakarta',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_schools_slug (slug),
    UNIQUE KEY uq_schools_code (school_code),
    CONSTRAINT chk_school_code_format CHECK (school_code REGEXP '^[0-9]{4}$')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS school_whatsapp_gateway_config (
    sekolah_id BIGINT UNSIGNED NOT NULL,
    endpoint_url VARCHAR(500) NULL,
    token_ciphertext VARBINARY(1024) NULL,
    token_iv BINARY(12) NULL,
    token_auth_tag BINARY(16) NULL,
    is_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (sekolah_id),
    CONSTRAINT fk_school_whatsapp_gateway_school FOREIGN KEY (sekolah_id)
        REFERENCES schools (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS platform_billing_settings (
    id TINYINT UNSIGNED NOT NULL,
    monthly_price BIGINT UNSIGNED NOT NULL DEFAULT 50000,
    lifetime_price BIGINT UNSIGNED NOT NULL DEFAULT 1000000,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    CONSTRAINT chk_platform_billing_singleton CHECK (id = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
INSERT IGNORE INTO platform_billing_settings (id) VALUES (1);

CREATE TABLE IF NOT EXISTS platform_backup_settings (
    id TINYINT UNSIGNED NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    backup_time CHAR(5) NOT NULL DEFAULT '02:00',
    encrypted_credentials TEXT NULL,
    last_run_date CHAR(10) NULL,
    last_status VARCHAR(24) NOT NULL DEFAULT 'never',
    last_run_at TIMESTAMP NULL,
    last_error VARCHAR(500) NULL,
    PRIMARY KEY (id),
    CONSTRAINT chk_platform_backup_settings_singleton CHECK (id = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
INSERT IGNORE INTO platform_backup_settings (id) VALUES (1);

CREATE TABLE IF NOT EXISTS platform_otp_rate_limit_settings (
    id TINYINT UNSIGNED NOT NULL,
    max_requests_per_phone TINYINT UNSIGNED NOT NULL DEFAULT 10,
    window_minutes SMALLINT UNSIGNED NOT NULL DEFAULT 30,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    CONSTRAINT chk_platform_otp_rate_limit_singleton CHECK (id = 1),
    CONSTRAINT chk_platform_otp_rate_limit_count CHECK (max_requests_per_phone BETWEEN 1 AND 50),
    CONSTRAINT chk_platform_otp_rate_limit_window CHECK (window_minutes BETWEEN 1 AND 1440)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
INSERT IGNORE INTO platform_otp_rate_limit_settings (id) VALUES (1);

CREATE TABLE IF NOT EXISTS subscription_payment_orders (
    id CHAR(36) NOT NULL,
    sekolah_id BIGINT UNSIGNED NOT NULL,
    order_id VARCHAR(50) NOT NULL,
    provider ENUM('xendit', 'duitku') NOT NULL,
    plan ENUM('monthly', 'lifetime') NOT NULL,
    amount BIGINT UNSIGNED NOT NULL,
    payment_method VARCHAR(20) NULL,
    status ENUM('pending', 'paid', 'expired', 'failed') NOT NULL DEFAULT 'pending',
    provider_reference VARCHAR(100) NULL,
    checkout_url VARCHAR(2048) NULL,
    expires_at DATETIME NULL,
    paid_at DATETIME NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_subscription_payment_order (order_id),
    KEY idx_subscription_payment_school (sekolah_id, created_at),
    KEY idx_subscription_payment_status (status, created_at),
    CONSTRAINT fk_subscription_payment_school FOREIGN KEY (sekolah_id)
        REFERENCES schools (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS roles (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    sekolah_id BIGINT UNSIGNED NOT NULL,
    role_key VARCHAR(80) NOT NULL,
    role_name VARCHAR(100) NOT NULL,
    permissions JSON NOT NULL,
    is_system BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_roles_school_key (sekolah_id, role_key),
    UNIQUE KEY uq_roles_school_name (sekolah_id, role_name),
    UNIQUE KEY uq_roles_school_id (sekolah_id, id),
    CONSTRAINT fk_roles_school FOREIGN KEY (sekolah_id) REFERENCES schools (id)
        ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS units (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    sekolah_id BIGINT UNSIGNED NOT NULL,
    name VARCHAR(100) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_units_school_name (sekolah_id, name),
    UNIQUE KEY uq_units_school_id (sekolah_id, id),
    CONSTRAINT fk_units_school FOREIGN KEY (sekolah_id) REFERENCES schools (id)
        ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS classrooms (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    sekolah_id BIGINT UNSIGNED NOT NULL,
    unit_id BIGINT UNSIGNED NOT NULL,
    name VARCHAR(100) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_classrooms_school_unit_name (sekolah_id, unit_id, name),
    UNIQUE KEY uq_classrooms_school_id (sekolah_id, id),
    CONSTRAINT fk_classrooms_school FOREIGN KEY (sekolah_id) REFERENCES schools (id)
        ON DELETE CASCADE,
    CONSTRAINT fk_classrooms_unit FOREIGN KEY (sekolah_id, unit_id)
        REFERENCES units (sekolah_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS users (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    sekolah_id BIGINT UNSIGNED NOT NULL,
    role_id BIGINT UNSIGNED NOT NULL,
    classroom_id BIGINT UNSIGNED NULL,
    username VARCHAR(80) NOT NULL,
    display_name VARCHAR(150) NOT NULL,
    whatsapp_phone VARCHAR(20) NULL,
    password_hash VARCHAR(255) NOT NULL,
    auth_version INT UNSIGNED NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_users_school_username (sekolah_id, username),
    UNIQUE KEY uq_users_school_whatsapp (sekolah_id, whatsapp_phone),
    UNIQUE KEY uq_users_school_id (sekolah_id, id),
    KEY idx_users_role (sekolah_id, role_id),
    CONSTRAINT fk_users_school FOREIGN KEY (sekolah_id) REFERENCES schools (id)
        ON DELETE CASCADE,
    CONSTRAINT fk_users_role FOREIGN KEY (sekolah_id, role_id)
        REFERENCES roles (sekolah_id, id),
    CONSTRAINT fk_users_classroom FOREIGN KEY (sekolah_id, classroom_id)
        REFERENCES classrooms (sekolah_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS school_registration_challenges (
    id CHAR(36) NOT NULL,
    school_name VARCHAR(180) NOT NULL,
    admin_name VARCHAR(150) NOT NULL,
    admin_username VARCHAR(80) NULL,
    whatsapp_phone VARCHAR(20) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    otp_hash BINARY(32) NOT NULL,
    expires_at DATETIME NOT NULL,
    attempt_count TINYINT UNSIGNED NOT NULL DEFAULT 0,
    request_ip_hash CHAR(64) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    verified_at DATETIME NULL,
    PRIMARY KEY (id),
    KEY idx_registration_phone_created (whatsapp_phone, created_at),
    KEY idx_registration_ip_created (request_ip_hash, created_at),
    KEY idx_registration_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS school_password_reset_challenges (
    id CHAR(36) NOT NULL,
    school_code CHAR(4) NOT NULL,
    sekolah_id BIGINT UNSIGNED NULL,
    user_id BIGINT UNSIGNED NULL,
    whatsapp_phone VARCHAR(20) NOT NULL,
    otp_hash BINARY(32) NOT NULL,
    expires_at DATETIME NOT NULL,
    attempt_count TINYINT UNSIGNED NOT NULL DEFAULT 0,
    request_ip_hash CHAR(64) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME NULL,
    PRIMARY KEY (id),
    KEY idx_password_reset_phone_created (whatsapp_phone, created_at),
    KEY idx_password_reset_ip_created (request_ip_hash, created_at),
    KEY idx_password_reset_user_created (user_id, created_at),
    KEY idx_password_reset_expiry (expires_at),
    CONSTRAINT fk_password_reset_school FOREIGN KEY (sekolah_id) REFERENCES schools (id)
        ON DELETE CASCADE,
    CONSTRAINT fk_password_reset_user FOREIGN KEY (user_id) REFERENCES users (id)
        ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS participants (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    sekolah_id BIGINT UNSIGNED NOT NULL,
    classroom_id BIGINT UNSIGNED NOT NULL,
    participant_code VARCHAR(60) NOT NULL,
    full_name VARCHAR(150) NOT NULL,
    qr_code VARCHAR(160) NOT NULL,
    guardian_phone VARCHAR(32) NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_participants_school_code (sekolah_id, participant_code),
    UNIQUE KEY uq_participants_school_qr (sekolah_id, qr_code),
    UNIQUE KEY uq_participants_school_id (sekolah_id, id),
    KEY idx_participants_classroom (sekolah_id, classroom_id, is_active),
    CONSTRAINT fk_participants_school FOREIGN KEY (sekolah_id) REFERENCES schools (id)
        ON DELETE CASCADE,
    CONSTRAINT fk_participants_classroom FOREIGN KEY (sekolah_id, classroom_id)
        REFERENCES classrooms (sekolah_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS operational_settings (
    sekolah_id BIGINT UNSIGNED NOT NULL,
    timezone VARCHAR(64) NOT NULL DEFAULT 'Asia/Jakarta',
    check_in_deadline TIME NOT NULL DEFAULT '08:00:00',
    lateness_tolerance_minutes SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    check_out_start TIME NOT NULL DEFAULT '15:00:00',
    updated_by BIGINT UNSIGNED NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (sekolah_id),
    CONSTRAINT fk_operational_settings_school FOREIGN KEY (sekolah_id)
        REFERENCES schools (id) ON DELETE CASCADE,
    CONSTRAINT fk_operational_settings_user FOREIGN KEY (sekolah_id, updated_by)
        REFERENCES users (sekolah_id, id),
    CONSTRAINT chk_operational_tolerance CHECK (lateness_tolerance_minutes <= 180)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS weekly_operational_schedules (
    sekolah_id BIGINT UNSIGNED NOT NULL,
    weekday TINYINT UNSIGNED NOT NULL,
    is_working_day BOOLEAN NOT NULL DEFAULT TRUE,
    check_in_deadline TIME NOT NULL DEFAULT '08:00:00',
    lateness_tolerance_minutes SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    check_out_start TIME NOT NULL DEFAULT '15:00:00',
    PRIMARY KEY (sekolah_id, weekday),
    CONSTRAINT fk_weekly_schedule_school FOREIGN KEY (sekolah_id)
        REFERENCES schools (id) ON DELETE CASCADE,
    CONSTRAINT chk_weekly_schedule_weekday CHECK (weekday BETWEEN 0 AND 6),
    CONSTRAINT chk_weekly_schedule_tolerance CHECK (lateness_tolerance_minutes <= 180)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS school_holidays (
    sekolah_id BIGINT UNSIGNED NOT NULL,
    holiday_date DATE NOT NULL,
    name VARCHAR(150) NOT NULL,
    created_by BIGINT UNSIGNED NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (sekolah_id, holiday_date),
    CONSTRAINT fk_holidays_school FOREIGN KEY (sekolah_id) REFERENCES schools (id)
        ON DELETE CASCADE,
    CONSTRAINT fk_holidays_user FOREIGN KEY (sekolah_id, created_by)
        REFERENCES users (sekolah_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS scanner_devices (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    sekolah_id BIGINT UNSIGNED NOT NULL,
    device_name VARCHAR(120) NOT NULL,
    api_key_hash VARCHAR(255) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    last_synced_at TIMESTAMP NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_devices_api_key_hash (api_key_hash),
    UNIQUE KEY uq_devices_school_id (sekolah_id, id),
    CONSTRAINT fk_devices_school FOREIGN KEY (sekolah_id) REFERENCES schools (id)
        ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS attendance_logs (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    sekolah_id BIGINT UNSIGNED NOT NULL,
    id_unik CHAR(36) NOT NULL,
    participant_id BIGINT UNSIGNED NOT NULL,
    device_id BIGINT UNSIGNED NULL,
    recorded_by BIGINT UNSIGNED NULL,
    participant_code_snapshot VARCHAR(60) NOT NULL,
    participant_name_snapshot VARCHAR(150) NOT NULL,
    classroom_name_snapshot VARCHAR(100) NOT NULL,
    attendance_date DATE NOT NULL,
    event_type ENUM('check_in', 'check_out') NOT NULL,
    client_timestamp_utc DATETIME(3) NOT NULL,
    server_received_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    attendance_status ENUM('hadir', 'terlambat', 'pulang') NOT NULL,
    late_minutes SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    scan_method ENUM('SCAN_QR', 'MANUAL_INPUT') NOT NULL DEFAULT 'SCAN_QR',
    PRIMARY KEY (id),
    UNIQUE KEY uq_attendance_school_idempotency (sekolah_id, id_unik),
    UNIQUE KEY uq_attendance_daily_event (sekolah_id, participant_id, attendance_date, event_type),
    KEY idx_attendance_report (sekolah_id, attendance_date, participant_id),
    KEY idx_attendance_status (sekolah_id, attendance_date, attendance_status),
    CONSTRAINT fk_attendance_school FOREIGN KEY (sekolah_id) REFERENCES schools (id)
        ON DELETE CASCADE,
    CONSTRAINT fk_attendance_participant FOREIGN KEY (sekolah_id, participant_id)
        REFERENCES participants (sekolah_id, id),
    CONSTRAINT fk_attendance_device FOREIGN KEY (sekolah_id, device_id)
        REFERENCES scanner_devices (sekolah_id, id),
    CONSTRAINT fk_attendance_user FOREIGN KEY (sekolah_id, recorded_by)
        REFERENCES users (sekolah_id, id),
    CONSTRAINT chk_attendance_status_event CHECK (
        (event_type = 'check_out' AND attendance_status = 'pulang' AND late_minutes = 0)
        OR
        (event_type = 'check_in' AND attendance_status IN ('hadir', 'terlambat')
         AND ((attendance_status = 'hadir' AND late_minutes = 0)
              OR (attendance_status = 'terlambat' AND late_minutes > 0)))
    )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS attendance_exceptions (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    sekolah_id BIGINT UNSIGNED NOT NULL,
    participant_id BIGINT UNSIGNED NOT NULL,
    recorded_by BIGINT UNSIGNED NOT NULL,
    attendance_date DATE NOT NULL,
    reason ENUM('izin', 'sakit', 'dispensasi') NOT NULL,
    note VARCHAR(500) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_attendance_exception_daily (sekolah_id, participant_id, attendance_date),
    CONSTRAINT fk_exception_school FOREIGN KEY (sekolah_id) REFERENCES schools (id)
        ON DELETE CASCADE,
    CONSTRAINT fk_exception_participant FOREIGN KEY (sekolah_id, participant_id)
        REFERENCES participants (sekolah_id, id),
    CONSTRAINT fk_exception_user FOREIGN KEY (sekolah_id, recorded_by)
        REFERENCES users (sekolah_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS activity_logs (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    sekolah_id BIGINT UNSIGNED NOT NULL,
    actor_user_id BIGINT UNSIGNED NULL,
    actor_name_snapshot VARCHAR(150) NOT NULL,
    action VARCHAR(80) NOT NULL,
    entity_type VARCHAR(80) NOT NULL,
    entity_id VARCHAR(100) NULL,
    before_data JSON NULL,
    after_data JSON NULL,
    ip_address VARCHAR(64) NULL,
    created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    KEY idx_activity_school_created (sekolah_id, created_at, id),
    KEY idx_activity_entity (sekolah_id, entity_type, entity_id, created_at),
    CONSTRAINT fk_activity_school FOREIGN KEY (sekolah_id) REFERENCES schools (id)
        ON DELETE CASCADE,
    CONSTRAINT fk_activity_user FOREIGN KEY (sekolah_id, actor_user_id)
        REFERENCES users (sekolah_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Akun ini sengaja tidak dapat login sampai hash diganti dan akun diaktifkan.
INSERT IGNORE INTO super_admins (username, display_name, password_hash, is_active)
VALUES (
    'bootstrap-superadmin',
    'Bootstrap Super Admin',
    'PROVISION_WITH_BCRYPT_HASH_BEFORE_ACTIVATION',
    FALSE
);

-- Data tenant contoh untuk database baru. Ganti kode jika sudah dipakai.
INSERT IGNORE INTO schools (
    slug, school_code, name, subscription_status, trial_ends_at,
    participant_quota, timezone
)
VALUES (
    'sekolah-contoh', '4829', 'Sekolah Contoh', 'trial',
    DATE_ADD(UTC_TIMESTAMP(), INTERVAL 30 DAY), 500, 'Asia/Jakarta'
);

INSERT INTO roles (sekolah_id, role_key, role_name, permissions, is_system)
SELECT s.id, r.role_key, r.role_name, r.permissions, r.is_system
FROM schools s
JOIN (
    SELECT 'admin-sekolah' AS role_key, 'Admin Sekolah' AS role_name,
        JSON_ARRAY(
            'dashboard.read', 'attendance.read', 'attendance.export',
            'participants.read', 'participants.manage', 'participants.qr.print',
            'settings.operational.manage', 'attendance.excuse.manage',
            'scanner.use', 'school.users.manage', 'school.roles.manage'
        ) AS permissions, TRUE AS is_system
    UNION ALL SELECT 'operator-scanner', 'Operator Scanner',
        JSON_ARRAY('scanner.use'), TRUE
    UNION ALL SELECT 'kepala-sekolah', 'Kepala Sekolah',
        JSON_ARRAY('dashboard.read', 'attendance.read', 'attendance.export'), FALSE
    UNION ALL SELECT 'wakasek-kesiswaan', 'Wakasek Kesiswaan',
        JSON_ARRAY(
            'dashboard.read', 'attendance.read', 'attendance.export',
            'participants.read', 'attendance.excuse.manage'
        ), FALSE
) r
WHERE s.slug = 'sekolah-contoh'
ON DUPLICATE KEY UPDATE
    role_name = VALUES(role_name),
    permissions = VALUES(permissions),
    is_system = VALUES(is_system);

INSERT INTO units (sekolah_id, name)
SELECT id, 'Unit Contoh' FROM schools WHERE slug = 'sekolah-contoh'
ON DUPLICATE KEY UPDATE name = VALUES(name);

INSERT INTO classrooms (sekolah_id, unit_id, name)
SELECT u.sekolah_id, u.id, 'Kelas 1'
FROM units u
JOIN schools s ON s.id = u.sekolah_id
WHERE s.slug = 'sekolah-contoh' AND u.name = 'Unit Contoh'
ON DUPLICATE KEY UPDATE name = VALUES(name);

INSERT IGNORE INTO users (
    sekolah_id, role_id, username, display_name, password_hash, is_active
)
SELECT s.id, r.id, 'bootstrap-admin', 'Bootstrap Admin Sekolah',
    'PROVISION_WITH_BCRYPT_HASH_BEFORE_ACTIVATION', FALSE
FROM schools s
JOIN roles r ON r.sekolah_id = s.id AND r.role_key = 'admin-sekolah'
WHERE s.slug = 'sekolah-contoh';

INSERT INTO participants (
    sekolah_id, classroom_id, participant_code, full_name, qr_code
)
SELECT c.sekolah_id, c.id, p.participant_code, p.full_name, p.qr_code
FROM classrooms c
JOIN schools s ON s.id = c.sekolah_id
JOIN (
    SELECT 'DEMO-001' AS participant_code, 'Peserta Contoh 1' AS full_name,
        'ABSENSI-DEMO-001' AS qr_code, 'Kelas 1' AS classroom_name
    UNION ALL SELECT 'DEMO-002', 'Peserta Contoh 2',
        'ABSENSI-DEMO-002', 'Kelas 1'
) p ON p.classroom_name = c.name
WHERE s.slug = 'sekolah-contoh'
ON DUPLICATE KEY UPDATE full_name = VALUES(full_name);

INSERT IGNORE INTO operational_settings (sekolah_id, timezone)
SELECT id, 'Asia/Jakarta' FROM schools WHERE slug = 'sekolah-contoh';

INSERT INTO weekly_operational_schedules (
    sekolah_id, weekday, is_working_day, check_in_deadline,
    lateness_tolerance_minutes, check_out_start
)
SELECT s.id, schedule.weekday, schedule.is_working_day,
    '08:00:00', 0, '15:00:00'
FROM schools s
JOIN (
    SELECT 0 AS weekday, FALSE AS is_working_day
    UNION ALL SELECT 1, TRUE
    UNION ALL SELECT 2, TRUE
    UNION ALL SELECT 3, TRUE
    UNION ALL SELECT 4, TRUE
    UNION ALL SELECT 5, TRUE
    UNION ALL SELECT 6, FALSE
) schedule
WHERE s.slug = 'sekolah-contoh'
ON DUPLICATE KEY UPDATE
    is_working_day = VALUES(is_working_day),
    check_in_deadline = VALUES(check_in_deadline),
    lateness_tolerance_minutes = VALUES(lateness_tolerance_minutes),
    check_out_start = VALUES(check_out_start);
