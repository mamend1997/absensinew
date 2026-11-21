import { app } from './app.js';
import { config } from './config.js';
import { pool } from './db.js';
import { ensureRuntimeMigrations } from './config/runtime-migrations.js';
import { startPlatformBackupWorker } from './core/platform-backup.js';
import { startLateAttendanceNotificationWorker } from './core/late-attendance-notifications.js';
import { startGoogleSheetsSyncWorker } from './core/google-sheets-sync.js';

await ensureRuntimeMigrations(pool);
startPlatformBackupWorker();
startLateAttendanceNotificationWorker();
startGoogleSheetsSyncWorker();

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
