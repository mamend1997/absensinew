import { app } from './app.js';
import { config } from './config.js';
import { pool } from './db.js';

await pool.execute(`
  CREATE TABLE IF NOT EXISTS platform_branding (
    id TINYINT UNSIGNED NOT NULL,
    logo_mime_type VARCHAR(32) NULL,
    logo_data MEDIUMBLOB NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    CONSTRAINT chk_platform_branding_singleton CHECK (id = 1)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`);
await pool.execute('INSERT IGNORE INTO platform_branding (id) VALUES (1)');

const server = app.listen(config.port, config.host, () => {
  console.log(`SaaS backend listening on http://${config.host}:${config.port}`);
});

async function shutdown(signal) {
  console.log(`Received ${signal}; shutting down.`);
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
