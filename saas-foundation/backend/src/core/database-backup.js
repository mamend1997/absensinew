import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { fail } from '../http.js';
import { inTransaction } from '../db.js';

const FORMAT = 'ruang-hadir-database-backup';
const BINARY_MARKER = '$ruang_hadir_binary_base64';
const BACKUP_KEY = createHash('sha256')
  .update('ruang-hadir-database-backup-v1\0')
  .update(process.env.JWT_SECRET ?? '')
  .digest();
const EXCLUDED_PLATFORM_TABLES = new Set([
  'platform_backup_settings',
  'super_admin_password_reset_challenges',
  'school_registration_challenges',
  'school_password_reset_challenges',
]);
const SCHOOL_BACKUP_TABLES = new Set([
  'units',
  'classrooms',
  'participants',
  'participant_operational_overrides',
  'operational_settings',
  'weekly_operational_schedules',
  'school_holidays',
  'attendance_logs',
  'participant_late_notifications',
  'attendance_exceptions',
  'activity_logs',
  'school_branding_config',
  'school_whatsapp_gateway_config',
  'school_google_sheets_config',
]);
const SCHOOL_RESTORE_ORDER = [
  'units',
  'classrooms',
  'participants',
  'operational_settings',
  'weekly_operational_schedules',
  'school_holidays',
  'school_branding_config',
  'school_whatsapp_gateway_config',
  'school_google_sheets_config',
  'attendance_logs',
  'participant_operational_overrides',
  'participant_late_notifications',
  'attendance_exceptions',
  'activity_logs',
];
const BINARY_TYPES = new Set(['binary', 'varbinary', 'tinyblob', 'blob', 'mediumblob', 'longblob', 'bit']);

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function encodeBinary(value) {
  if (Buffer.isBuffer(value)) return { [BINARY_MARKER]: value.toString('base64') };
  if (value instanceof Uint8Array) return { [BINARY_MARKER]: Buffer.from(value).toString('base64') };
  if (value && value.type === 'Buffer' && Array.isArray(value.data)) {
    return { [BINARY_MARKER]: Buffer.from(value.data).toString('base64') };
  }
  return value;
}

function decodeValue(value) {
  if (Array.isArray(value)) return value.map(decodeValue);
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === BINARY_MARKER &&
        typeof value[BINARY_MARKER] === 'string' &&
        /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value[BINARY_MARKER])) {
      return Buffer.from(value[BINARY_MARKER], 'base64');
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decodeValue(item)]));
  }
  return value;
}

function sign(unsignedPayload) {
  return createHmac('sha256', BACKUP_KEY)
    .update(canonicalJson(unsignedPayload))
    .digest('base64url');
}

function verifySignature(payload) {
  const { integrity, ...unsignedPayload } = payload;
  if (!integrity || integrity.algorithm !== 'hmac-sha256' ||
      typeof integrity.signature !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(integrity.signature)) {
    return false;
  }
  const expected = Buffer.from(sign(unsignedPayload));
  const supplied = Buffer.from(integrity.signature);
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

async function getSchema(connection, scope) {
  if (connection.dialect === 'sqlite') {
    const columns = [];
    for (const { table_name: tableName } of await connection.listTables()) {
      if (scope === 'platform' && EXCLUDED_PLATFORM_TABLES.has(tableName)) continue;
      if (scope === 'school' && !SCHOOL_BACKUP_TABLES.has(tableName)) continue;
      columns.push(...await connection.getTableColumns(tableName));
    }
    return new Map(
      [...new Set(columns.map((column) => column.table_name))].map((tableName) => [
        tableName,
        columns.filter((column) => column.table_name === tableName),
      ]),
    );
  }

  const [columns] = await connection.execute(
    `SELECT c.TABLE_NAME AS table_name, c.COLUMN_NAME AS column_name, c.DATA_TYPE AS data_type,
            c.ORDINAL_POSITION AS ordinal_position
       FROM information_schema.COLUMNS c
       JOIN information_schema.TABLES t
         ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
        AND t.TABLE_TYPE = 'BASE TABLE'
      WHERE c.TABLE_SCHEMA = DATABASE()
      ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION`,
  );
  const tables = new Map();
  for (const column of columns) {
    if (scope === 'platform' && EXCLUDED_PLATFORM_TABLES.has(column.table_name)) continue;
    if (scope === 'school' && !SCHOOL_BACKUP_TABLES.has(column.table_name)) continue;
    if (!tables.has(column.table_name)) tables.set(column.table_name, []);
    tables.get(column.table_name).push(column);
  }
  return tables;
}

async function makeBackup(connection, scope, schoolId = null) {
  const schema = await getSchema(connection, scope);
  const tables = {};
  for (const [tableName, columns] of schema) {
    const columnNames = columns.map((column) => column.column_name);
    const where = scope === 'school' ? ' WHERE sekolah_id = ?' : '';
    const [rows] = await connection.query(
      `SELECT * FROM \`${tableName}\`${where}`,
      scope === 'school' ? [schoolId] : [],
    );
    tables[tableName] = {
      columns: columnNames,
      rows: rows.map((row) => columns.map((column) =>
        BINARY_TYPES.has(column.data_type)
          ? encodeBinary(row[column.column_name])
          : row[column.column_name])),
    };
  }
  const unsignedPayload = {
    format: FORMAT,
    version: 1,
    scope,
    ...(scope === 'school' ? { school_id: String(schoolId) } : {}),
    created_at: new Date().toISOString(),
    tables,
  };
  return { ...unsignedPayload, integrity: { algorithm: 'hmac-sha256', signature: sign(unsignedPayload) } };
}

export async function createPlatformDatabaseBackup(connection = null) {
  if (connection) return makeBackup(connection, 'platform');
  return inTransaction((transaction) => makeBackup(transaction, 'platform'));
}

export async function createSchoolDatabaseBackup(connection, schoolId) {
  if (schoolId === undefined) {
    schoolId = connection;
    return inTransaction((transaction) => makeBackup(transaction, 'school', schoolId));
  }
  return makeBackup(connection, 'school', schoolId);
}

function validatePayload(payload, scope, schoolId) {
  if (!payload || payload.format !== FORMAT || payload.version !== 1 ||
      payload.scope !== scope || !payload.tables || typeof payload.tables !== 'object' ||
      Array.isArray(payload.tables) || typeof payload.created_at !== 'string' ||
      !Number.isFinite(Date.parse(payload.created_at)) ||
      scope === 'school' && String(payload.school_id) !== String(schoolId) ||
      !verifySignature(payload)) {
    throw fail(400, 'File backup tidak valid, tidak cocok, atau telah diubah.', 'INVALID_BACKUP');
  }
}

function validateRows(payloadTables, schema, scope, schoolId) {
  const expectedNames = [...schema.keys()].sort();
  const suppliedNames = Object.keys(payloadTables).sort();
  if (expectedNames.length !== suppliedNames.length ||
      expectedNames.some((name, index) => name !== suppliedNames[index])) {
    throw fail(400, 'Struktur database pada file backup tidak cocok dengan server ini.', 'BACKUP_SCHEMA_MISMATCH');
  }
  const rowsByTable = new Map();
  for (const [tableName, columns] of schema) {
    const backupTable = payloadTables[tableName];
    const names = columns.map((column) => column.column_name);
    if (!backupTable || !Array.isArray(backupTable.columns) ||
        names.length !== backupTable.columns.length ||
        names.some((name, index) => name !== backupTable.columns[index]) ||
        !Array.isArray(backupTable.rows)) {
      throw fail(400, `Struktur tabel ${tableName} pada file backup tidak valid.`, 'INVALID_BACKUP');
    }
    const rows = backupTable.rows.map((row) => {
      if (!Array.isArray(row) || row.length !== names.length) {
        throw fail(400, `Data tabel ${tableName} pada file backup tidak valid.`, 'INVALID_BACKUP');
      }
      const decoded = row.map((value, index) =>
        BINARY_TYPES.has(columns[index].data_type) ? decodeValue(value) : value);
      if (scope === 'school') {
        const tenantIndex = names.indexOf('sekolah_id');
        if (tenantIndex < 0 || String(decoded[tenantIndex]) !== String(schoolId)) {
          throw fail(400, `Data tabel ${tableName} bukan milik sekolah ini.`, 'INVALID_BACKUP_TENANT');
        }
      }
      return decoded;
    });
    rowsByTable.set(tableName, rows);
  }
  return rowsByTable;
}

async function restorePlatform(connection, schema, rowsByTable) {
  const names = [...schema.keys()];
  await connection.execute('SET FOREIGN_KEY_CHECKS = 0');
  try {
    await connection.beginTransaction();
    for (const tableName of names) await connection.query(`DELETE FROM \`${tableName}\``);
    for (const [tableName, columns] of schema) {
      const names = columns.map((column) => column.column_name);
      if (!names.length) continue;
      const sql = `INSERT INTO \`${tableName}\` (${names.map((name) => `\`${name}\``).join(', ')}) VALUES (${names.map(() => '?').join(', ')})`;
      for (const row of rowsByTable.get(tableName)) await connection.execute(sql, row);
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    await connection.execute('SET FOREIGN_KEY_CHECKS = 1');
  }
}

async function preserveSchoolClassrooms(connection, schoolId, schema, rowsByTable) {
  const importedClassrooms = rowsByTable.get('classrooms') ?? [];
  const classroomColumns = schema.get('classrooms')?.map((column) => column.column_name) ?? [];
  const classroomIdIndex = classroomColumns.indexOf('id');
  const importedIds = new Set(importedClassrooms.map((row) => String(row[classroomIdIndex])));
  const [users] = await connection.execute(
    'SELECT classroom_id FROM users WHERE sekolah_id = ? AND classroom_id IS NOT NULL',
    [schoolId],
  );
  const missingIds = [...new Set(users.map((row) => String(row.classroom_id)))]
    .filter((id) => !importedIds.has(id));
  if (!missingIds.length) return;
  const [currentClassrooms] = await connection.query(
    `SELECT * FROM classrooms WHERE sekolah_id = ? AND id IN (${missingIds.map(() => '?').join(', ')})`,
    [schoolId, ...missingIds],
  );
  const foundClassroomIds = new Set(currentClassrooms.map((row) => String(row.id)));
  if (missingIds.some((id) => !foundClassroomIds.has(id))) {
    throw fail(400, 'Backup tidak memuat kelas yang sedang dipakai akun sekolah.', 'BACKUP_CLASSROOM_MISMATCH');
  }
  const unitIds = [...new Set(currentClassrooms.map((row) => String(row.unit_id)))];
  if (!unitIds.length) {
    throw fail(400, 'Backup tidak memuat kelas yang sedang dipakai akun sekolah.', 'BACKUP_CLASSROOM_MISMATCH');
  }
  const [currentUnits] = await connection.query(
    `SELECT * FROM units WHERE sekolah_id = ? AND id IN (${unitIds.map(() => '?').join(', ')})`,
    [schoolId, ...unitIds],
  );
  const foundUnitIds = new Set(currentUnits.map((row) => String(row.id)));
  if (unitIds.some((id) => !foundUnitIds.has(id))) {
    throw fail(400, 'Kelas akun sekolah memiliki unit yang tidak tersedia.', 'BACKUP_CLASSROOM_MISMATCH');
  }
  const unitColumns = schema.get('units').map((column) => column.column_name);
  const classroomRows = rowsByTable.get('classrooms');
  const unitRows = rowsByTable.get('units');
  const unitIdIndex = unitColumns.indexOf('id');
  const currentUnitIds = new Set(unitRows.map((row) => String(row[unitIdIndex])));
  for (const row of currentUnits) {
    if (!currentUnitIds.has(String(row.id))) {
      unitRows.push(unitColumns.map((name) => row[name]));
    }
  }
  const currentClassroomIds = new Set(classroomRows.map((row) => String(row[classroomIdIndex])));
  for (const row of currentClassrooms) {
    if (!currentClassroomIds.has(String(row.id))) {
      classroomRows.push(classroomColumns.map((name) => row[name]));
    }
  }
}

async function sanitizeSchoolReferences(connection, schoolId, schema, rowsByTable) {
  const [users] = await connection.execute('SELECT id FROM users WHERE sekolah_id = ?', [schoolId]);
  const userIds = new Set(users.map((row) => String(row.id)));
  const [devices] = await connection.execute('SELECT id FROM scanner_devices WHERE sekolah_id = ?', [schoolId]);
  const deviceIds = new Set(devices.map((row) => String(row.id)));
  for (const tableName of ['operational_settings', 'school_holidays', 'attendance_logs', 'activity_logs']) {
    const columns = schema.get(tableName)?.map((column) => column.column_name) ?? [];
    for (const field of ['updated_by', 'created_by', 'recorded_by', 'actor_user_id']) {
      const index = columns.indexOf(field);
      if (index < 0) continue;
      for (const row of rowsByTable.get(tableName)) {
        if (row[index] != null && !userIds.has(String(row[index]))) row[index] = null;
      }
    }
  }
  const attendanceColumns = schema.get('attendance_logs').map((column) => column.column_name);
  const deviceIndex = attendanceColumns.indexOf('device_id');
  for (const row of rowsByTable.get('attendance_logs')) {
    if (deviceIndex >= 0 && row[deviceIndex] != null && !deviceIds.has(String(row[deviceIndex]))) {
      row[deviceIndex] = null;
    }
  }
  const exceptionColumns = schema.get('attendance_exceptions').map((column) => column.column_name);
  const actorIndex = exceptionColumns.indexOf('recorded_by');
  for (const row of rowsByTable.get('attendance_exceptions')) {
    if (!userIds.has(String(row[actorIndex]))) {
      throw fail(400, 'Backup berisi catatan izin dengan akun pencatat yang sudah tidak tersedia.', 'BACKUP_USER_MISMATCH');
    }
  }
}

async function restoreSchool(connection, schoolId, schema, rowsByTable) {
  await connection.execute('SET FOREIGN_KEY_CHECKS = 0');
  try {
    await connection.beginTransaction();
    await preserveSchoolClassrooms(connection, schoolId, schema, rowsByTable);
    await sanitizeSchoolReferences(connection, schoolId, schema, rowsByTable);
    const [existingSchools] = await connection.execute('SELECT id FROM schools WHERE id = ?', [schoolId]);
    if (!existingSchools.length) throw fail(404, 'Sekolah tidak ditemukan.', 'NOT_FOUND');
    const deleteOrder = [...SCHOOL_RESTORE_ORDER].reverse().filter((name) => schema.has(name));
    const insertOrder = SCHOOL_RESTORE_ORDER.filter((name) => schema.has(name));
    for (const tableName of deleteOrder) {
      await connection.execute(`DELETE FROM \`${tableName}\` WHERE sekolah_id = ?`, [schoolId]);
    }
    for (const tableName of insertOrder) {
      const columns = schema.get(tableName).map((column) => column.column_name);
      if (!columns.length) continue;
      const sql = `INSERT INTO \`${tableName}\` (${columns.map((name) => `\`${name}\``).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`;
      for (const row of rowsByTable.get(tableName)) await connection.execute(sql, row);
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    await connection.execute('SET FOREIGN_KEY_CHECKS = 1');
  }
}

export async function restoreDatabaseBackup(connection, rawPayload, scope, schoolId = null) {
  let payload;
  try {
    payload = JSON.parse(Buffer.isBuffer(rawPayload) ? rawPayload.toString('utf8') : String(rawPayload));
  } catch {
    throw fail(400, 'File backup harus berupa JSON yang valid.', 'INVALID_BACKUP');
  }
  validatePayload(payload, scope, schoolId);
  const schema = await getSchema(connection, scope);
  const rowsByTable = validateRows(payload.tables, schema, scope, schoolId);
  if (scope === 'platform') await restorePlatform(connection, schema, rowsByTable);
  else await restoreSchool(connection, String(schoolId), schema, rowsByTable);
  return { restored_tables: schema.size };
}
