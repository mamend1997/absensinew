import { Router } from 'express';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { db } from '../config/database.js';
import { config } from '../config/env.js';
import { allowRoles, authenticate } from '../middleware/auth.js';
import { auditRequestContext, writeAuditLog } from '../services/audit-service.js';
import {
  backupTableColumns,
  backupTableNames,
  createBackupTables,
} from '../services/backup-data.js';
import {
  decryptBackupCredentials,
  encryptBackupCredentials,
} from '../services/scheduled-backup-service.js';
import { asyncHandler } from '../utils/async-handler.js';
import { HttpError } from '../utils/http-error.js';

const router = Router();
router.use(authenticate, allowRoles('admin'));

const BACKUP_VERSION = 1;
const MAX_BACKUP_ROWS = 300000;

const tableNames = backupTableNames;
const insertOrder = tableNames;
const deleteOrder = [...tableNames].reverse().filter((tableName) => tableName !== 'activity_logs');

function parseJsonColumn(value) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function downloadName(date) {
  return `ruang-hadir-backup-${date.toISOString().slice(0, 10)}.json`;
}

function backupScheduleResponse(settings) {
  const credentials = settings.encrypted_credentials
    ? decryptBackupCredentials(settings.encrypted_credentials)
    : null;
  const chatId = credentials?.chat_id ?? '';
  return {
    enabled: Boolean(Number(settings.enabled)),
    backup_time: settings.backup_time,
    bot_configured: Boolean(credentials?.bot_token && chatId),
    chat_id_hint: chatId.length > 4 ? `***${chatId.slice(-4)}` : chatId,
    last_status: settings.last_status,
    last_run_at: settings.last_run_at,
    last_error: settings.last_error,
  };
}

router.get('/backup/schedule', asyncHandler(async (_request, response) => {
  const [settings] = await db.query(
    `SELECT enabled, backup_time, encrypted_credentials, last_status,
            last_run_at, last_error
       FROM scheduled_backup_settings WHERE id = 1`,
  );
  response.json(backupScheduleResponse(settings));
}));

router.put('/backup/schedule', asyncHandler(async (request, response) => {
  const input = z.object({
    enabled: z.boolean(),
    backup_time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
    bot_token: z.string().max(512).optional(),
    chat_id: z.string().max(100).optional(),
  }).parse(request.body);
  const [current] = await db.query(
    'SELECT encrypted_credentials FROM scheduled_backup_settings WHERE id = 1',
  );
  let encryptedCredentials = current?.encrypted_credentials ?? null;
  const botToken = input.bot_token?.trim() ?? '';
  const chatId = input.chat_id?.trim() ?? '';
  if (botToken || chatId) {
    if (!botToken || !chatId) {
      throw new HttpError(400, 'Token Bot dan Chat ID harus diisi bersama.');
    }
    encryptedCredentials = encryptBackupCredentials({
      bot_token: botToken,
      chat_id: chatId,
    });
  }
  if (input.enabled && (!encryptedCredentials || !config.backupDirectory)) {
    throw new HttpError(
      400,
      !encryptedCredentials
        ? 'Isi kredensial Telegram terlebih dahulu.'
        : 'BACKUP_DIRECTORY harus diarahkan ke volume privat yang persisten.',
    );
  }
  await db.query(
    `UPDATE scheduled_backup_settings
        SET enabled = ?, backup_time = ?, encrypted_credentials = ?
      WHERE id = 1`,
    [input.enabled ? 1 : 0, input.backup_time, encryptedCredentials],
  );
  await writeAuditLog({
    ...auditRequestContext(request),
    action: 'database.backup.schedule.updated',
    entityType: 'database_backup',
    after: {
      enabled: input.enabled,
      backup_time: input.backup_time,
      credentials_updated: Boolean(botToken && chatId),
    },
  });
  const [updated] = await db.query(
    `SELECT enabled, backup_time, encrypted_credentials, last_status,
            last_run_at, last_error
       FROM scheduled_backup_settings WHERE id = 1`,
  );
  response.json(backupScheduleResponse(updated));
}));

router.get('/backup/scheduled/latest', asyncHandler(async (_request, response, next) => {
  const [settings] = await db.query(
    'SELECT last_run_date FROM scheduled_backup_settings WHERE id = 1',
  );
  if (!config.backupDirectory || !/^\d{4}-\d{2}-\d{2}$/.test(settings?.last_run_date ?? '')) {
    throw new HttpError(404, 'Backup otomatis belum tersedia.');
  }
  const directory = isAbsolute(config.backupDirectory)
    ? config.backupDirectory
    : resolve(process.cwd(), config.backupDirectory);
  const filename = `ruang-hadir-${settings.last_run_date}.json.enc`;
  const path = resolve(directory, filename);
  try {
    const file = await stat(path);
    if (!file.isFile()) throw new HttpError(404, 'File backup otomatis tidak ditemukan.');
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error?.code === 'ENOENT') throw new HttpError(404, 'File backup otomatis tidak ditemukan.');
    throw error;
  }
  response.setHeader('Content-Type', 'application/octet-stream');
  response.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  const stream = createReadStream(path);
  stream.on('error', (error) => {
    if (response.headersSent) response.destroy(error);
    else next(error);
  });
  stream.pipe(response);
}));

router.get('/activity-logs', asyncHandler(async (request, response) => {
  const query = z.object({
    page: z.coerce.number().int().min(1).default(1),
    page_size: z.coerce.number().int().min(10).max(100).default(50),
    entity_type: z.string().trim().max(80).optional(),
    action: z.string().trim().max(80).optional(),
  }).parse(request.query);
  const conditions = [];
  const params = [];
  if (query.entity_type) {
    conditions.push('entity_type = ?');
    params.push(query.entity_type);
  }
  if (query.action) {
    conditions.push('action = ?');
    params.push(query.action);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const [rows, countRows] = await Promise.all([
    db.query(
      `SELECT id, actor_user_id, actor_username, actor_display_name, action,
              entity_type, entity_id, before_data, after_data, ip_address, created_at
       FROM activity_logs ${where}
       ORDER BY created_at DESC, id DESC
       LIMIT ? OFFSET ?`,
      [...params, query.page_size, (query.page - 1) * query.page_size],
    ),
    db.query(`SELECT COUNT(*) AS total FROM activity_logs ${where}`, params),
  ]);
  response.json({
    logs: rows.map((row) => ({
      ...row,
      before_data: parseJsonColumn(row.before_data),
      after_data: parseJsonColumn(row.after_data),
    })),
    page: query.page,
    page_size: query.page_size,
    total: Number(countRows[0]?.total ?? 0),
  });
}));

router.get('/backup', asyncHandler(async (_request, response) => {
  const tables = await createBackupTables(db);
  const createdAt = new Date();
  const backup = {
    format: 'ruang-hadir-backup',
    version: BACKUP_VERSION,
    created_at: createdAt.toISOString(),
    database_driver: db.dialect,
    tables,
  };
  await writeAuditLog({
    ...auditRequestContext(_request),
    action: 'database.backup.exported',
    entityType: 'database_backup',
    after: { version: BACKUP_VERSION, row_counts: Object.fromEntries(
      Object.entries(tables).map(([name, rows]) => [name, rows.length]),
    ) },
  });
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Content-Disposition', `attachment; filename="${downloadName(createdAt)}"`);
  response.send(JSON.stringify(backup));
}));

function validateBackup(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    value.format !== 'ruang-hadir-backup' ||
    value.version !== BACKUP_VERSION ||
    !value.tables ||
    typeof value.tables !== 'object' ||
    Array.isArray(value.tables)
  ) {
    throw new HttpError(400, 'Format file cadangan tidak didukung atau tidak valid.');
  }

  const tableKeys = Object.keys(value.tables);
  if (
    tableKeys.length !== tableNames.length ||
    tableNames.some((tableName) => !Array.isArray(value.tables[tableName]))
  ) {
    throw new HttpError(400, 'File cadangan tidak memuat seluruh tabel yang diperlukan.');
  }

  let totalRows = 0;
  for (const tableName of tableNames) {
    const rows = value.tables[tableName];
    totalRows += rows.length;
    for (const row of rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        throw new HttpError(400, `Data tabel ${tableName} tidak valid.`);
      }
      if (Object.keys(row).some((column) => !backupTableColumns[tableName].includes(column))) {
        throw new HttpError(400, `File cadangan memiliki kolom tak dikenal pada tabel ${tableName}.`);
      }
    }
  }
  if (totalRows > MAX_BACKUP_ROWS) {
    throw new HttpError(413, 'File cadangan melampaui batas jumlah baris yang diizinkan.');
  }
  if (!value.tables.users.some((user) =>
    user.role === 'admin' && (user.is_active === true || Number(user.is_active) === 1),
  )) {
    throw new HttpError(400, 'Cadangan harus menyertakan setidaknya satu akun Admin aktif.');
  }
  return value;
}

function restoreRowColumns(tableName, row) {
  const columns = Object.keys(row).filter((column) => backupTableColumns[tableName].includes(column));
  if (!columns.length) throw new HttpError(400, `Baris kosong tidak diizinkan pada tabel ${tableName}.`);
  return columns;
}

router.post('/backup/restore', asyncHandler(async (request, response) => {
  if (!Buffer.isBuffer(request.body)) {
    throw new HttpError(400, 'Kirim file cadangan JSON dengan Content-Type application/json.');
  }

  let parsed;
  try {
    parsed = JSON.parse(request.body.toString('utf8'));
  } catch {
    throw new HttpError(400, 'File cadangan bukan JSON yang valid.');
  }
  const backup = validateBackup(parsed);
  const counts = Object.fromEntries(
    tableNames.map((tableName) => [tableName, backup.tables[tableName].length]),
  );
  const actor = auditRequestContext(request);

  await db.transaction(async (transaction) => {
    for (const tableName of deleteOrder) {
      await transaction.query(`DELETE FROM ${tableName}`);
    }
    for (const tableName of insertOrder) {
      for (const row of backup.tables[tableName]) {
        const columns = restoreRowColumns(tableName, row);
        const placeholders = columns.map(() => '?').join(', ');
        const values = columns.map((column) => {
          const value = row[column];
          if (
            (column === 'before_data' || column === 'after_data') &&
            value != null &&
            typeof value !== 'string'
          ) {
            return JSON.stringify(value);
          }
          return value;
        });
        const ignorePrefix = tableName === 'activity_logs'
          ? db.dialect === 'mysql' ? 'INSERT IGNORE' : 'INSERT OR IGNORE'
          : 'INSERT';
        await transaction.query(
          `${ignorePrefix} INTO ${tableName} (${columns.join(', ')}) VALUES (${placeholders})`,
          values,
        );
      }
    }
    const restoredActor = backup.tables.users.some(
      (user) => String(user.id) === String(request.user.id),
    );
    await writeAuditLog({
      executor: transaction,
      user: restoredActor ? request.user : { ...request.user, id: null },
      action: 'database.backup.restored',
      entityType: 'database_backup',
      after: {
        backup_created_at: backup.created_at ?? null,
        source_driver: backup.database_driver ?? null,
        row_counts: counts,
      },
      ipAddress: request.ip,
    });
  });

  response.json({
    restored: true,
    backup_created_at: backup.created_at ?? null,
    row_counts: counts,
  });
}));

export default router;
