import { app } from './app.js';
import { config } from './config/env.js';
import { db } from './config/database.js';
import { ensureRuntimeMigrations } from './config/runtime-migrations.js';
import { startNotificationWorker } from './services/notification-service.js';
import { startScheduledBackupWorker } from './services/scheduled-backup-service.js';

try {
  await ensureRuntimeMigrations(db);
  if (db.check) await db.check();
  startNotificationWorker();
  startScheduledBackupWorker();
  app.listen(config.port, () => {
    console.log(`Absensi API aktif pada http://localhost:${config.port}`);
  });
} catch (error) {
  console.error('Gagal menginisialisasi database:', error);
  process.exitCode = 1;
}
