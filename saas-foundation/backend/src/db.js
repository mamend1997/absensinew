import mysql from 'mysql2/promise';
import { config } from './config.js';
import { createSqlitePool } from './sqlite-db.js';

export const pool = config.dbDriver === 'sqlite'
  ? createSqlitePool(config.sqlitePath)
  : mysql.createPool(config.mysql);

export async function inTransaction(work) {
  if (pool.dialect === 'sqlite') return pool.transaction(work);

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await work(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}
