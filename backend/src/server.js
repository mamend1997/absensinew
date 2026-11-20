import { app } from './app.js';
import { config } from './config/env.js';
import { db } from './config/database.js';

try {
  if (db.check) await db.check();
  app.listen(config.port, () => {
    console.log(`Absensi API aktif pada http://localhost:${config.port}`);
  });
} catch (error) {
  console.error('Gagal menginisialisasi database:', error);
  process.exitCode = 1;
}
