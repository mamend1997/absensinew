import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { config } from '../config/env.js';
import { db } from '../config/database.js';
import { createBackupTables } from './backup-data.js';

const KEY = createHash('sha256')
  .update('ruang-hadir-scheduled-backup\0')
  .update(config.jwtSecret)
  .digest();

function encrypt(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return JSON.stringify({
    version: 1,
    algorithm: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  });
}

function decrypt(value) {
  const envelope = JSON.parse(value);
  if (envelope.version !== 1 || envelope.algorithm !== 'aes-256-gcm') {
    throw new Error('Format kredensial backup tidak dikenali.');
  }
  const decipher = createDecipheriv('aes-256-gcm', KEY, Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

export function encryptBackupCredentials(credentials) {
  return encrypt(JSON.stringify(credentials));
}

export function decryptBackupCredentials(value) {
  return JSON.parse(decrypt(value));
}

function localClock(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: config.appTimezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return { date: `${values.year}-${values.month}-${values.day}`, time: `${values.hour}:${values.minute}` };
}

async function sendTelegramNotification(credentials, text) {
  const response = await fetch(
    `https://api.telegram.org/bot${encodeURIComponent(credentials.bot_token)}/sendMessage`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: credentials.chat_id,
        text,
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(10000),
    },
  );
  if (!response.ok) throw new Error(`Telegram mengembalikan HTTP ${response.status}.`);
  const result = await response.json().catch(() => null);
  if (result?.ok !== true) throw new Error('Telegram tidak menerima notifikasi backup.');
}

async function claimDailyRun() {
  return db.transaction(async (transaction) => {
    const [settings] = await transaction.query(
      'SELECT enabled, backup_time, encrypted_credentials, last_run_date FROM scheduled_backup_settings WHERE id = 1',
    );
    if (!settings || !Number(settings.enabled)) return null;
    const clock = localClock();
    if (clock.time < settings.backup_time || settings.last_run_date === clock.date) return null;
    const result = await transaction.query(
      `UPDATE scheduled_backup_settings
          SET last_run_date = ?, last_status = 'running', last_run_at = CURRENT_TIMESTAMP,
              last_error = NULL
        WHERE id = 1 AND (last_run_date IS NULL OR last_run_date <> ?)`,
      [clock.date, clock.date],
    );
    if (db.dialect === 'mysql' && result.affectedRows !== 1) return null;
    if (db.dialect === 'sqlite' && result.changes !== 1) return null;
    return { ...settings, date: clock.date };
  });
}

async function setRunResult(status, error = null) {
  await db.query(
    `UPDATE scheduled_backup_settings
        SET last_status = ?, last_error = ?
      WHERE id = 1`,
    [status, error],
  );
}

async function createEncryptedBackup(date) {
  if (!config.backupDirectory) {
    throw new Error('BACKUP_DIRECTORY belum diarahkan ke volume privat yang persisten.');
  }
  const directory = isAbsolute(config.backupDirectory)
    ? config.backupDirectory
    : resolve(process.cwd(), config.backupDirectory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const tables = await createBackupTables(db);
  const plaintext = JSON.stringify({
    format: 'ruang-hadir-backup',
    version: 1,
    created_at: new Date().toISOString(),
    database_driver: db.dialect,
    tables,
  });
  const envelope = encrypt(plaintext);
  const path = resolve(directory, `ruang-hadir-${date}.json.enc`);
  await writeFile(path, envelope, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return path;
}

export async function runScheduledBackup() {
  const claimed = await claimDailyRun();
  if (!claimed) return false;
  try {
    if (!claimed.encrypted_credentials) {
      throw new Error('Kredensial Telegram belum diatur.');
    }
    const credentials = decryptBackupCredentials(claimed.encrypted_credentials);
    await createEncryptedBackup(claimed.date);
    try {
      await sendTelegramNotification(
        credentials,
        `Backup harian Ruang Hadir tanggal ${claimed.date} berhasil dibuat dan disimpan terenkripsi di volume privat. Data tidak dikirim melalui Telegram.`,
      );
      await setRunResult('success');
    } catch (error) {
      await setRunResult(
        'notification_failed',
        error instanceof Error ? error.message.slice(0, 500) : 'Notifikasi Telegram gagal.',
      );
      return true;
    }
    return true;
  } catch (error) {
    await setRunResult(
      'failed',
      error instanceof Error ? error.message.slice(0, 500) : 'Backup terjadwal gagal.',
    );
    console.error('Backup terjadwal gagal; data backup tidak dikirim ke Telegram.');
    return true;
  }
}

export function startScheduledBackupWorker() {
  const timer = setInterval(() => {
    void runScheduledBackup().catch((error) => {
      console.error('Pemeriksaan backup terjadwal gagal:', error);
    });
  }, 15000);
  timer.unref();
}
