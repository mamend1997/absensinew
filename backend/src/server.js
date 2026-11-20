import { app } from './app.js';
import { config } from './config/env.js';
import { db } from './config/database.js';
import { startNotificationWorker } from './services/notification-service.js';

try {
  if (db.check) await db.check();
  startNotificationWorker();
  app.listen(config.port, () => {
    console.log(`Absensi API aktif pada http://localhost:${config.port}`);
  });
} catch (error) {
  console.error('Gagal menginisialisasi database:', error);
  process.exitCode = 1;
}
