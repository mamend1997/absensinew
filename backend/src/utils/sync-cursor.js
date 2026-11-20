import { db } from '../config/database.js';

export async function getSyncCursor() {
  const rows = await db.query('SELECT CURRENT_TIMESTAMP AS sync_cursor');
  const value = rows[0]?.sync_cursor;
  if (!value) throw new Error('Database did not return a sync cursor');
  const timestamp = value instanceof Date
    ? value
    : new Date(String(value).includes('T')
      ? String(value)
      : `${String(value).replace(' ', 'T')}Z`);
  if (Number.isNaN(timestamp.valueOf())) {
    throw new Error('Database returned an invalid sync cursor');
  }
  return timestamp.toISOString();
}
