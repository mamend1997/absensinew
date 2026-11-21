export async function ensureRuntimeMigrations(pool) {
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
}
