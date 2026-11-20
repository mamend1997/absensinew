import { Router } from 'express';
import { z } from 'zod';
import { db } from '../config/database.js';
import { allowRoles, authenticate } from '../middleware/auth.js';
import { auditRequestContext, writeAuditLog } from '../services/audit-service.js';
import { asyncHandler } from '../utils/async-handler.js';
import { HttpError } from '../utils/http-error.js';

const router = Router();
router.use(authenticate, allowRoles('admin'));

const BACKUP_VERSION = 1;
const MAX_BACKUP_ROWS = 300000;

const tableColumns = {
  units: ['id', 'name', 'created_at'],
  classrooms: ['id', 'unit_id', 'name', 'created_at'],
  users: [
    'id', 'username', 'display_name', 'password_hash', 'role',
    'classroom_id', 'is_active', 'created_at', 'updated_at',
  ],
  participants: [
    'id', 'participant_code', 'full_name', 'classroom_id', 'qr_code',
    'guardian_phone', 'is_active', 'created_at', 'updated_at',
  ],
  operational_settings: [
    'id', 'timezone', 'check_in_deadline', 'lateness_tolerance_minutes',
    'check_out_start', 'scan_welcome_message', 'scan_success_message',
    'scan_failure_message', 'updated_by', 'updated_at',
  ],
  weekly_operational_schedules: [
    'weekday', 'is_working_day', 'check_in_deadline',
    'lateness_tolerance_minutes', 'check_out_start',
  ],
  participant_day_overrides: ['participant_id', 'weekday', 'check_in_deadline'],
  admin_menu_pin: ['id', 'pin_hash', 'updated_at'],
  attendance_logs: [
    'id', 'id_unik', 'participant_id', 'participant_code_snapshot',
    'participant_name_snapshot', 'classroom_name_snapshot', 'attendance_date',
    'event_type', 'client_timestamp', 'server_received_at', 'synced_at',
    'attendance_status', 'late_minutes', 'scan_method', 'device_id', 'recorded_by',
  ],
  attendance_notifications: [
    'id', 'id_unik', 'recipient_phone', 'event_type', 'message', 'status',
    'attempt_count', 'next_attempt_at', 'last_error', 'created_at', 'sent_at',
  ],
  activity_logs: [
    'id', 'actor_user_id', 'actor_username', 'actor_display_name', 'action',
    'entity_type', 'entity_id', 'before_data', 'after_data', 'ip_address', 'created_at',
  ],
};

const tableNames = Object.keys(tableColumns);
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
  const tables = await db.transaction(async (transaction) => {
    const snapshot = {};
    for (const tableName of tableNames) {
      snapshot[tableName] = await transaction.query(`SELECT * FROM ${tableName}`);
    }
    return snapshot;
  });
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
      if (Object.keys(row).some((column) => !tableColumns[tableName].includes(column))) {
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
  const columns = Object.keys(row).filter((column) => tableColumns[tableName].includes(column));
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
