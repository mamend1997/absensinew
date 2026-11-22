export async function ensureRuntimeMigrations(pool) {
  const [attendanceColumns] = await pool.execute(
    `SELECT COLUMN_NAME, COLUMN_TYPE FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'attendance_logs'`,
  );
  if (attendanceColumns.length) {
    const eventColumn = attendanceColumns.find((column) => column.COLUMN_NAME === 'event_type');
    if (eventColumn && !String(eventColumn.COLUMN_TYPE).includes('permission_out')) {
      await pool.execute(
        `ALTER TABLE attendance_logs
         MODIFY COLUMN event_type ENUM('check_in','check_out','permission_out','permission_in') NOT NULL`,
      );
    }
    const statusColumn = attendanceColumns.find((column) => column.COLUMN_NAME === 'attendance_status');
    if (statusColumn && !String(statusColumn.COLUMN_TYPE).includes('izin_keluar')) {
      await pool.execute(
        `ALTER TABLE attendance_logs
         MODIFY COLUMN attendance_status ENUM('hadir','terlambat','pulang','izin_keluar','izin_masuk') NOT NULL`,
      );
    }
    const [attendanceIndexes] = await pool.execute(
      `SELECT INDEX_NAME FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'attendance_logs'`,
    );
    if (attendanceIndexes.some((index) => index.INDEX_NAME === 'uq_attendance_daily_event')) {
      await pool.execute('ALTER TABLE attendance_logs DROP INDEX uq_attendance_daily_event');
    }
  }

  const [schoolColumns] = await pool.execute(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'schools'`,
  );
  if (schoolColumns.length && !schoolColumns.some((column) => column.COLUMN_NAME === 'billing_email')) {
    await pool.execute('ALTER TABLE schools ADD COLUMN billing_email VARCHAR(254) NULL AFTER name');
  }

  const [participantColumns] = await pool.execute(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'participants'`,
  );
  if (participantColumns.length && !participantColumns.some((column) => column.COLUMN_NAME === 'participant_phone')) {
    await pool.execute('ALTER TABLE participants ADD COLUMN participant_phone VARCHAR(32) NULL AFTER qr_code');
  }

  const [operationalColumns] = await pool.execute(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'operational_settings'`,
  );
  if (operationalColumns.length && !operationalColumns.some((column) => column.COLUMN_NAME === 'scanner_pin_hash')) {
    await pool.execute(
      'ALTER TABLE operational_settings ADD COLUMN scanner_pin_hash VARCHAR(255) NULL AFTER check_out_start',
    );
  }
  const operationalColumnNames = new Set(operationalColumns.map((column) => column.COLUMN_NAME));
  const operationalSettingsColumns = [
    ['scan_cooldown_minutes', 'SMALLINT UNSIGNED NOT NULL DEFAULT 5'],
    ['scan_welcome_message', "VARCHAR(255) NOT NULL DEFAULT 'Pindai kartu atau barcode peserta saat melaksanakan absensi'"],
    ['scan_success_message', "VARCHAR(255) NOT NULL DEFAULT 'Terima kasih, {name}. Absensi {status} sudah dicatat.'"],
    ['scan_failure_message', "VARCHAR(255) NOT NULL DEFAULT 'Maaf, absensi {name} gagal. {reason}.'"],
  ];
  for (const [name, definition] of operationalSettingsColumns) {
    if (operationalColumns.length && !operationalColumnNames.has(name)) {
      await pool.execute(`ALTER TABLE operational_settings ADD COLUMN ${name} ${definition}`);
    }
  }

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS participant_operational_overrides (
      sekolah_id BIGINT UNSIGNED NOT NULL,
      participant_id BIGINT UNSIGNED NOT NULL,
      weekday TINYINT UNSIGNED NOT NULL,
      check_in_deadline TIME NOT NULL,
      PRIMARY KEY (sekolah_id, participant_id, weekday),
      CONSTRAINT fk_participant_override_participant
        FOREIGN KEY (sekolah_id, participant_id)
        REFERENCES participants (sekolah_id, id) ON DELETE CASCADE,
      CONSTRAINT chk_participant_override_weekday CHECK (weekday BETWEEN 0 AND 6)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS participant_late_notifications (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      sekolah_id BIGINT UNSIGNED NOT NULL,
      attendance_log_id BIGINT UNSIGNED NOT NULL,
      recipient_phone VARCHAR(32) NOT NULL,
      message TEXT NOT NULL,
      status ENUM('pending', 'sending', 'sent', 'failed') NOT NULL DEFAULT 'pending',
      attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
      next_attempt_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_error VARCHAR(500) NULL,
      sent_at TIMESTAMP NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_late_notification_attendance (attendance_log_id),
      KEY idx_late_notification_due (status, next_attempt_at, id),
      CONSTRAINT fk_late_notification_school FOREIGN KEY (sekolah_id)
        REFERENCES schools (id) ON DELETE CASCADE,
      CONSTRAINT fk_late_notification_attendance FOREIGN KEY (attendance_log_id)
        REFERENCES attendance_logs (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  const [superAdminColumns] = await pool.execute(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'super_admins'`,
  );
  const superAdminColumnNames = new Set(superAdminColumns.map((column) => column.COLUMN_NAME));
  if (superAdminColumnNames.size && !superAdminColumnNames.has('whatsapp_phone')) {
    await pool.execute('ALTER TABLE super_admins ADD COLUMN whatsapp_phone VARCHAR(20) NULL AFTER password_hash');
  }
  if (superAdminColumnNames.size && !superAdminColumnNames.has('auth_version')) {
    await pool.execute('ALTER TABLE super_admins ADD COLUMN auth_version INT UNSIGNED NOT NULL DEFAULT 0 AFTER whatsapp_phone');
  }
  const [superAdminIndexes] = await pool.execute(
    `SELECT INDEX_NAME FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'super_admins'`,
  );
  if (superAdminColumnNames.size && !superAdminIndexes.some((index) => index.INDEX_NAME === 'uq_super_admin_whatsapp')) {
    await pool.execute('ALTER TABLE super_admins ADD UNIQUE KEY uq_super_admin_whatsapp (whatsapp_phone)');
  }

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS platform_branding (
      id TINYINT UNSIGNED NOT NULL,
      application_name VARCHAR(120) NOT NULL DEFAULT 'Ruang Hadir',
      logo_mime_type VARCHAR(32) NULL,
      logo_data MEDIUMBLOB NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      CONSTRAINT chk_platform_branding_singleton CHECK (id = 1)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.execute('INSERT IGNORE INTO platform_branding (id) VALUES (1)');
  const [brandingColumns] = await pool.execute(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'platform_branding'`,
  );
  if (!brandingColumns.some((column) => column.COLUMN_NAME === 'application_name')) {
    await pool.execute(
      "ALTER TABLE platform_branding ADD COLUMN application_name VARCHAR(120) NOT NULL DEFAULT 'Ruang Hadir'",
    );
  }

  const [[schoolStatusColumn]] = await pool.execute(
    `SELECT COLUMN_TYPE FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'schools'
        AND COLUMN_NAME = 'subscription_status'`,
  );
  if (schoolStatusColumn && !schoolStatusColumn.COLUMN_TYPE.includes('lifetime')) {
    await pool.execute(
      "ALTER TABLE schools MODIFY subscription_status ENUM('trial', 'aktif', 'suspend', 'lifetime') NOT NULL DEFAULT 'trial'",
    );
  }

  const [columns] = await pool.execute(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'`,
  );
  const columnNames = new Set(columns.map((column) => column.COLUMN_NAME));
  if (columnNames.size && !columnNames.has('whatsapp_phone')) {
    await pool.execute('ALTER TABLE users ADD COLUMN whatsapp_phone VARCHAR(20) NULL AFTER display_name');
  }
  if (columnNames.size && !columnNames.has('auth_version')) {
    await pool.execute('ALTER TABLE users ADD COLUMN auth_version INT UNSIGNED NOT NULL DEFAULT 0 AFTER password_hash');
  }

  const [indexes] = await pool.execute(
    `SELECT INDEX_NAME FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'`,
  );
  if (columnNames.size && !indexes.some((index) => index.INDEX_NAME === 'uq_users_school_whatsapp')) {
    await pool.execute(
      'ALTER TABLE users ADD UNIQUE KEY uq_users_school_whatsapp (sekolah_id, whatsapp_phone)',
    );
  }

  await pool.execute(`
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.execute('INSERT IGNORE INTO whatsapp_gateway_config (id) VALUES (1)');
  const [platformGatewayColumns] = await pool.execute(
    `SELECT COLUMN_NAME, COLUMN_TYPE FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'whatsapp_gateway_config'`,
  );
  const platformGatewayColumnNames = new Set(platformGatewayColumns.map((column) => column.COLUMN_NAME));
  if (!platformGatewayColumnNames.has('last_test_at')) {
    await pool.execute('ALTER TABLE whatsapp_gateway_config ADD COLUMN last_test_at DATETIME NULL');
  }
  if (!platformGatewayColumnNames.has('last_test_status')) {
    await pool.execute("ALTER TABLE whatsapp_gateway_config ADD COLUMN last_test_status ENUM('success', 'failed', 'accepted') NULL");
  } else {
    const statusColumn = platformGatewayColumns.find((column) => column.COLUMN_NAME === 'last_test_status');
    if (!statusColumn.COLUMN_TYPE.includes("'accepted'")) {
      await pool.execute("ALTER TABLE whatsapp_gateway_config MODIFY COLUMN last_test_status ENUM('success', 'failed', 'accepted') NULL");
    }
  }
  if (!platformGatewayColumnNames.has('last_test_message')) {
    await pool.execute('ALTER TABLE whatsapp_gateway_config ADD COLUMN last_test_message VARCHAR(500) NULL');
  }

  await pool.execute(`
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  const [schoolGatewayColumns] = await pool.execute(
    `SELECT COLUMN_NAME, COLUMN_TYPE FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'school_whatsapp_gateway_config'`,
  );
  const schoolGatewayColumnNames = new Set(schoolGatewayColumns.map((column) => column.COLUMN_NAME));
  if (!schoolGatewayColumnNames.has('last_test_at')) {
    await pool.execute('ALTER TABLE school_whatsapp_gateway_config ADD COLUMN last_test_at DATETIME NULL');
  }
  if (!schoolGatewayColumnNames.has('last_test_status')) {
    await pool.execute("ALTER TABLE school_whatsapp_gateway_config ADD COLUMN last_test_status ENUM('success', 'failed', 'accepted') NULL");
  } else {
    const statusColumn = schoolGatewayColumns.find((column) => column.COLUMN_NAME === 'last_test_status');
    if (!statusColumn.COLUMN_TYPE.includes("'accepted'")) {
      await pool.execute("ALTER TABLE school_whatsapp_gateway_config MODIFY COLUMN last_test_status ENUM('success', 'failed', 'accepted') NULL");
    }
  }
  if (!schoolGatewayColumnNames.has('last_test_message')) {
    await pool.execute('ALTER TABLE school_whatsapp_gateway_config ADD COLUMN last_test_message VARCHAR(500) NULL');
  }

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS school_branding_config (
      sekolah_id BIGINT UNSIGNED NOT NULL,
      application_name VARCHAR(120) NOT NULL,
      logo_mime_type VARCHAR(32) NULL,
      logo_data MEDIUMBLOB NULL,
      theme VARCHAR(16) NOT NULL DEFAULT 'current',
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (sekolah_id),
      CONSTRAINT fk_school_branding_school FOREIGN KEY (sekolah_id)
        REFERENCES schools (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  const [schoolBrandingColumns] = await pool.execute(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'school_branding_config'`,
  );
  if (!schoolBrandingColumns.some((column) => column.COLUMN_NAME === 'theme')) {
    await pool.execute("ALTER TABLE school_branding_config ADD COLUMN theme VARCHAR(16) NOT NULL DEFAULT 'current'");
  }

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS school_google_sheets_config (
      sekolah_id BIGINT UNSIGNED NOT NULL,
      web_app_url VARCHAR(1000) NOT NULL,
      token_ciphertext VARBINARY(1024) NOT NULL,
      token_iv BINARY(12) NOT NULL,
      token_auth_tag BINARY(16) NOT NULL,
      is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (sekolah_id),
      CONSTRAINT fk_school_google_sheets_school FOREIGN KEY (sekolah_id)
        REFERENCES schools (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS school_google_sheets_sync_state (
      sekolah_id BIGINT UNSIGNED NOT NULL,
      last_synced_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
      last_attempt_at DATETIME NULL,
      last_success_at DATETIME NULL,
      last_error VARCHAR(500) NULL,
      PRIMARY KEY (sekolah_id),
      CONSTRAINT fk_school_google_sheets_sync_state_school FOREIGN KEY (sekolah_id)
        REFERENCES schools (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.execute(
    `INSERT IGNORE INTO school_google_sheets_sync_state (sekolah_id)
     SELECT sekolah_id FROM school_google_sheets_config WHERE is_enabled = TRUE`,
  );

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS platform_billing_settings (
      id TINYINT UNSIGNED NOT NULL,
      monthly_price BIGINT UNSIGNED NOT NULL DEFAULT 50000,
      lifetime_price BIGINT UNSIGNED NOT NULL DEFAULT 1000000,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      CONSTRAINT chk_platform_billing_singleton CHECK (id = 1)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.execute('INSERT IGNORE INTO platform_billing_settings (id) VALUES (1)');

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS platform_payment_gateway_settings (
      id TINYINT UNSIGNED NOT NULL,
      xendit_enabled BOOLEAN NULL DEFAULT NULL,
      duitku_enabled BOOLEAN NULL DEFAULT NULL,
      duitku_environment ENUM('production', 'sandbox') NULL DEFAULT NULL,
      kasera_enabled BOOLEAN NULL DEFAULT NULL,
      encrypted_credentials TEXT NULL,
      public_web_url VARCHAR(1000) NULL,
      public_api_url VARCHAR(1000) NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      CONSTRAINT chk_platform_payment_gateway_singleton CHECK (id = 1)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.execute('INSERT IGNORE INTO platform_payment_gateway_settings (id) VALUES (1)');
  const [paymentGatewayColumns] = await pool.execute(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'platform_payment_gateway_settings'`,
  );
  if (!paymentGatewayColumns.some((column) => column.COLUMN_NAME === 'kasera_enabled')) {
    await pool.execute('ALTER TABLE platform_payment_gateway_settings ADD COLUMN kasera_enabled BOOLEAN NULL DEFAULT NULL');
  }
  if (!paymentGatewayColumns.some((column) => column.COLUMN_NAME === 'public_web_url')) {
    await pool.execute('ALTER TABLE platform_payment_gateway_settings ADD COLUMN public_web_url VARCHAR(1000) NULL');
  }
  if (!paymentGatewayColumns.some((column) => column.COLUMN_NAME === 'public_api_url')) {
    await pool.execute('ALTER TABLE platform_payment_gateway_settings ADD COLUMN public_api_url VARCHAR(1000) NULL');
  }

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS platform_backup_settings (
      id TINYINT UNSIGNED NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT FALSE,
      backup_time CHAR(5) NOT NULL DEFAULT '02:00',
      encrypted_credentials TEXT NULL,
      last_run_date CHAR(10) NULL,
      last_run_file VARCHAR(255) NULL,
      last_status VARCHAR(24) NOT NULL DEFAULT 'never',
      last_run_at TIMESTAMP NULL,
      last_error VARCHAR(500) NULL,
      PRIMARY KEY (id),
      CONSTRAINT chk_platform_backup_settings_singleton CHECK (id = 1)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.execute('INSERT IGNORE INTO platform_backup_settings (id) VALUES (1)');
  const [backupColumns] = await pool.execute(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'platform_backup_settings'`,
  );
  if (!backupColumns.some((column) => column.COLUMN_NAME === 'last_run_file')) {
    await pool.execute('ALTER TABLE platform_backup_settings ADD COLUMN last_run_file VARCHAR(255) NULL AFTER last_run_date');
  }

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS platform_otp_rate_limit_settings (
      id TINYINT UNSIGNED NOT NULL,
      max_requests_per_phone TINYINT UNSIGNED NOT NULL DEFAULT 10,
      window_minutes SMALLINT UNSIGNED NOT NULL DEFAULT 30,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      CONSTRAINT chk_platform_otp_rate_limit_singleton CHECK (id = 1),
      CONSTRAINT chk_platform_otp_rate_limit_count CHECK (max_requests_per_phone BETWEEN 1 AND 50),
      CONSTRAINT chk_platform_otp_rate_limit_window CHECK (window_minutes BETWEEN 1 AND 1440)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.execute('INSERT IGNORE INTO platform_otp_rate_limit_settings (id) VALUES (1)');

  await pool.execute(`
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS subscription_payment_orders (
      id CHAR(36) NOT NULL,
      sekolah_id BIGINT UNSIGNED NOT NULL,
      order_id VARCHAR(50) NOT NULL,
      provider ENUM('xendit', 'duitku', 'kasera') NOT NULL,
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  const [[paymentOrderProvider]] = await pool.execute(
    `SELECT COLUMN_TYPE FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'subscription_payment_orders'
        AND COLUMN_NAME = 'provider'`,
  );
  if (paymentOrderProvider && !paymentOrderProvider.COLUMN_TYPE.includes('kasera')) {
    await pool.execute(
      "ALTER TABLE subscription_payment_orders MODIFY provider ENUM('xendit', 'duitku', 'kasera') NOT NULL",
    );
  }
  const [[paymentMethodColumn]] = await pool.execute(
    `SELECT CHARACTER_MAXIMUM_LENGTH FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'subscription_payment_orders'
        AND COLUMN_NAME = 'payment_method'`,
  );
  if (paymentMethodColumn && Number(paymentMethodColumn.CHARACTER_MAXIMUM_LENGTH) < 32) {
    await pool.execute('ALTER TABLE subscription_payment_orders MODIFY payment_method VARCHAR(32) NULL');
  }

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS platform_download_settings (
      id TINYINT UNSIGNED NOT NULL,
      apk_drive_url VARCHAR(2048) NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      CONSTRAINT chk_platform_download_singleton CHECK (id = 1)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.execute('INSERT IGNORE INTO platform_download_settings (id) VALUES (1)');

  await pool.execute(`
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  const [registrationColumns] = await pool.execute(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'school_registration_challenges'`,
  );
  if (!registrationColumns.some((column) => column.COLUMN_NAME === 'admin_username')) {
    await pool.execute(
      'ALTER TABLE school_registration_challenges ADD COLUMN admin_username VARCHAR(80) NULL AFTER admin_name',
    );
  }

  await pool.execute(`
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
      CONSTRAINT fk_password_reset_school FOREIGN KEY (sekolah_id)
        REFERENCES schools (id) ON DELETE CASCADE,
      CONSTRAINT fk_password_reset_user FOREIGN KEY (user_id)
        REFERENCES users (id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS platform_audit_logs (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      super_admin_id BIGINT UNSIGNED NULL,
      username VARCHAR(80) NOT NULL,
      method VARCHAR(10) NOT NULL,
      route VARCHAR(255) NOT NULL,
      status_code SMALLINT UNSIGNED NOT NULL,
      ip_address VARCHAR(64) NULL,
      user_agent VARCHAR(512) NULL,
      created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      KEY idx_platform_audit_admin_created (super_admin_id, id),
      CONSTRAINT fk_platform_audit_admin FOREIGN KEY (super_admin_id)
        REFERENCES super_admins (id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS school_subscription_expiry_reminders (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      sekolah_id BIGINT UNSIGNED NOT NULL,
      expires_at DATETIME NOT NULL,
      recipient_phone VARCHAR(32) NULL,
      payment_order_id CHAR(36) NULL,
      provider_order_id VARCHAR(50) NULL,
      checkout_url VARCHAR(2048) NULL,
      amount BIGINT UNSIGNED NULL,
      invoice_expires_at DATETIME NULL,
      status ENUM('pending', 'sending', 'sent', 'failed') NOT NULL DEFAULT 'pending',
      attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
      next_attempt_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_attempt_at DATETIME NULL,
      last_error VARCHAR(500) NULL,
      sent_at DATETIME NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_school_expiry_reminder (sekolah_id, expires_at),
      UNIQUE KEY uq_school_expiry_payment_order (payment_order_id),
      KEY idx_school_expiry_reminder_due (status, next_attempt_at, id),
      CONSTRAINT fk_school_expiry_reminder_school FOREIGN KEY (sekolah_id)
        REFERENCES schools (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}
