import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { config } from '../config.js';
import { inTransaction, pool } from '../db.js';
import { createPinnedGatewayLookup } from './whatsapp-gateway.js';

const key = createHash('sha256')
  .update('ruang-hadir-platform-backup-v1\0')
  .update(config.jwtSecret)
  .digest();

function seal(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return JSON.stringify({
    version: 1,
    algorithm: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  });
}

function open(value) {
  const envelope = JSON.parse(value);
  if (envelope.version !== 1 || envelope.algorithm !== 'aes-256-gcm') {
    throw new Error('Format data backup tidak dikenali.');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

export function encryptPlatformBackupCredentials(value) {
  return seal(JSON.stringify(value));
}

export function decryptPlatformBackupCredentials(value) {
  return JSON.parse(open(value));
}

export function extractTelegramSendError(statusCode, body, botToken, chatId) {
  let payload;
  try { payload = JSON.parse(body); } catch { payload = null; }
  if (statusCode >= 200 && statusCode < 300 && payload?.ok === true) return null;

  const description = typeof payload?.description === 'string'
    ? payload.description
    : '';
  let safeDescription = description.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  for (const secret of [botToken, chatId]) {
    if (secret) safeDescription = safeDescription.split(secret).join('[redacted]');
  }
  safeDescription = safeDescription.slice(0, 300);
  const apiCode = Number.isInteger(payload?.error_code) ? `, kode ${payload.error_code}` : '';
  const detail = safeDescription ? `: ${safeDescription}` : '.';
  return `Telegram menolak notifikasi (HTTP ${statusCode}${apiCode})${detail}`;
}

function localClock(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: config.backupTimezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    time: `${values.hour}:${values.minute}`,
  };
}

async function snapshotDatabase() {
  return inTransaction(async (connection) => {
    const tables = connection.dialect === 'sqlite'
      ? (await connection.listTables()).filter(({ table_name: name }) => name !== 'platform_backup_settings')
      : (await connection.execute(
        `SELECT TABLE_NAME AS table_name FROM information_schema.tables
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'
            AND TABLE_NAME <> 'platform_backup_settings'
          ORDER BY TABLE_NAME`,
      ))[0];
    const snapshot = {};
    for (const { table_name: tableName } of tables) {
      const [rows] = await connection.query(`SELECT * FROM \`${tableName}\``);
      snapshot[tableName] = rows;
    }
    return {
      format: 'ruang-hadir-saas-backup',
      version: 1,
      created_at: new Date().toISOString(),
      tables: snapshot,
    };
  });
}

async function notifyTelegram(credentials, text) {
  const hostname = 'api.telegram.org';
  let addresses;
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch (error) {
    const code = typeof error.code === 'string' ? ` (${error.code})` : '';
    throw new Error(`DNS api.telegram.org gagal${code}. Periksa koneksi jaringan backend.`);
  }
  if (!addresses.length) throw new Error('Telegram tidak dapat dihubungi.');
  const pinnedAddresses = [...addresses].sort((left, right) => {
    if (left.family === right.family) return 0;
    return left.family === 4 ? -1 : 1;
  });
  const body = JSON.stringify({ chat_id: credentials.chat_id, text });
  await new Promise((resolvePromise, reject) => {
    const request = httpsRequest({
      protocol: 'https:',
      hostname,
      port: 443,
      path: `/bot${encodeURIComponent(credentials.bot_token)}/sendMessage`,
      method: 'POST',
      servername: hostname,
      lookup: createPinnedGatewayLookup(pinnedAddresses),
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
      timeout: 10000,
    }, (response) => {
      const responseChunks = [];
      let responseBytes = 0;
      response.on('data', (chunk) => {
        if (responseBytes >= 4096) return;
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const boundedData = data.subarray(0, 4096 - responseBytes);
        responseChunks.push(boundedData);
        responseBytes += boundedData.length;
      });
      response.on('end', () => {
        const error = extractTelegramSendError(
          response.statusCode ?? 0,
          Buffer.concat(responseChunks).toString('utf8'),
          credentials.bot_token,
          credentials.chat_id,
        );
        if (error) reject(new Error(error));
        else resolvePromise();
      });
    });
    let timedOut = false;
    request.on('timeout', () => {
      timedOut = true;
      request.destroy(new Error('Telegram timeout.'));
    });
    request.on('error', (error) => {
      const code = typeof error.code === 'string' ? ` (${error.code})` : '';
      reject(new Error(
        timedOut
          ? 'Koneksi Telegram timeout setelah 10 detik.'
          : `Koneksi ke Telegram gagal${code}. Periksa akses jaringan backend.`,
      ));
    });
    request.end(body);
  });
}

async function claimDailyRun() {
  return inTransaction(async (connection) => {
    const [[settings]] = await connection.execute(
      `SELECT enabled, backup_time, encrypted_credentials, last_run_date,
              (last_status = 'running' AND last_run_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 2 HOUR)) AS run_in_progress
         FROM platform_backup_settings WHERE id = 1 FOR UPDATE`,
    );
    if (!settings || !Number(settings.enabled) || Number(settings.run_in_progress)) return null;
    const clock = localClock();
    if (clock.time < settings.backup_time || settings.last_run_date === clock.date) return null;
    await connection.execute(
      `UPDATE platform_backup_settings
          SET last_run_date = ?, last_status = 'running', last_run_at = UTC_TIMESTAMP(),
              last_error = NULL
        WHERE id = 1`,
      [clock.date],
    );
    return { ...settings, date: clock.date };
  });
}

async function claimManualRun() {
  return inTransaction(async (connection) => {
    const [[settings]] = await connection.execute(
      `SELECT encrypted_credentials,
              (last_status = 'running' AND last_run_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 2 HOUR)) AS run_in_progress
         FROM platform_backup_settings WHERE id = 1 FOR UPDATE`,
    );
    if (!settings || Number(settings.run_in_progress)) return null;
    const { date } = localClock();
    await connection.execute(
      `UPDATE platform_backup_settings
          SET last_status = 'running', last_run_at = UTC_TIMESTAMP(),
              last_error = NULL
        WHERE id = 1`,
    );
    return { ...settings, date };
  });
}

async function setResult(status, error = null, filename = null) {
  if (filename) {
    await pool.execute(
      `UPDATE platform_backup_settings
          SET last_status = ?, last_error = ?, last_run_file = ?
        WHERE id = 1`,
      [status, error, filename],
    );
    return;
  }
  await pool.execute(
    'UPDATE platform_backup_settings SET last_status = ?, last_error = ? WHERE id = 1',
    [status, error],
  );
}

async function writeEncryptedBackup(date, manual = false) {
  if (!config.backupDirectory) {
    throw new Error('BACKUP_DIRECTORY belum diarahkan ke volume privat yang persisten.');
  }
  const directory = isAbsolute(config.backupDirectory)
    ? config.backupDirectory
    : resolve(process.cwd(), config.backupDirectory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const data = await snapshotDatabase();
  const suffix = manual
    ? `-manual-${new Date().toISOString().replace(/[-:.]/g, '')}-${randomBytes(4).toString('hex')}`
    : '';
  const filename = `ruang-hadir-saas-${date}${suffix}.json.enc`;
  const path = resolve(directory, filename);
  await writeFile(path, seal(JSON.stringify(data)), {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  return filename;
}

async function executeBackup(claimed, manual) {
  try {
    if (!claimed.encrypted_credentials) throw new Error('Kredensial Telegram belum diatur.');
    const credentials = decryptPlatformBackupCredentials(claimed.encrypted_credentials);
    const filename = await writeEncryptedBackup(claimed.date, manual);
    try {
      await notifyTelegram(
        credentials,
        `Backup platform Ruang Hadir${manual ? ' manual' : ''} tanggal ${claimed.date} berhasil dibuat dan disimpan terenkripsi di volume privat. Data sekolah tidak dikirim melalui Telegram.`,
      );
      await setResult('success', null, filename);
    } catch (error) {
      await setResult(
        'notification_failed',
        error instanceof Error ? error.message.slice(0, 500) : 'Notifikasi Telegram gagal.',
        filename,
      );
    }
  } catch (error) {
    await setResult('failed', error instanceof Error ? error.message.slice(0, 500) : 'Backup gagal.');
    console.error('Backup platform gagal; data sekolah tidak dikirim ke Telegram.');
  }
  return true;
}

export async function runPlatformBackup() {
  const claimed = await claimDailyRun();
  if (!claimed) return false;
  return executeBackup(claimed, false);
}

export async function runPlatformBackupNow() {
  const claimed = await claimManualRun();
  if (!claimed) return false;
  return executeBackup(claimed, true);
}

export function startPlatformBackupWorker() {
  const timer = setInterval(() => {
    void runPlatformBackup().catch((error) =>
      console.error('Pemeriksaan backup platform gagal:', error),
    );
  }, 15000);
  timer.unref();
}

export async function latestPlatformBackupPath() {
  const [[settings]] = await pool.execute(
    'SELECT last_run_date, last_run_file FROM platform_backup_settings WHERE id = 1',
  );
  if (!config.backupDirectory) return null;
  const directory = isAbsolute(config.backupDirectory)
    ? config.backupDirectory
    : resolve(process.cwd(), config.backupDirectory);
  if (/^ruang-hadir-saas-\d{4}-\d{2}-\d{2}(?:-manual-[A-Za-z0-9-]+)?\.json\.enc$/.test(settings?.last_run_file ?? '')) {
    return resolve(directory, settings.last_run_file);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(settings?.last_run_date ?? '')) return null;
  return resolve(directory, `ruang-hadir-saas-${settings.last_run_date}.json.enc`);
}

