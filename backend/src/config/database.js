import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import mysql from 'mysql2/promise';
import { config } from './env.js';

const isReadQuery = (sql) => /^\s*(SELECT|WITH|PRAGMA)\b/i.test(sql);

function createSqliteDatabase() {
  const path = isAbsolute(config.sqlitePath)
    ? config.sqlitePath
    : resolve(process.cwd(), config.sqlitePath);
  mkdirSync(dirname(path), { recursive: true });

  const connection = new DatabaseSync(path);
  connection.exec('PRAGMA foreign_keys = ON');
  connection.exec('PRAGMA busy_timeout = 5000');

  const query = async (sql, params = []) => {
    const statement = connection.prepare(sql);
    return isReadQuery(sql) ? statement.all(...params) : statement.run(...params);
  };

  return {
    dialect: 'sqlite',
    query,
    async transaction(callback) {
      connection.exec('BEGIN IMMEDIATE');
      try {
        const result = await callback({ query });
        connection.exec('COMMIT');
        return result;
      } catch (error) {
        connection.exec('ROLLBACK');
        throw error;
      }
    },
    async close() {
      connection.close();
    },
    async initializeSchema() {
      const schema = await readFile(
        resolve(process.cwd(), 'database/schema.sqlite.sql'),
        'utf8',
      );
      connection.exec(schema);
    },
    async hasColumn(table, column) {
      const rows = connection.prepare(`PRAGMA table_info(${table})`).all();
      return rows.some((row) => row.name === column);
    },
    async addColumn(table, columnDefinition) {
      connection.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDefinition}`);
    },
  };
}

function createMysqlDatabase() {
  const pool = mysql.createPool({
    ...config.mysql,
    waitForConnections: true,
    queueLimit: 0,
    charset: 'utf8mb4',
    timezone: 'Z',
    dateStrings: true,
    decimalNumbers: true,
  });

  const queryWith = async (executor, sql, params = []) => {
    const [result] = await executor.execute(sql, params);
    return result;
  };

  return {
    dialect: 'mysql',
    query: (sql, params = []) => queryWith(pool, sql, params),
    async transaction(callback) {
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const result = await callback({
          query: (sql, params = []) => queryWith(connection, sql, params),
        });
        await connection.commit();
        return result;
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
    },
    close: () => pool.end(),
    async initializeSchema() {
      const schema = await readFile(
        resolve(process.cwd(), 'database/schema.sql'),
        'utf8',
      );
      const statements = schema
        .replace(/--.*$/gm, '')
        .split(';')
        .map((statement) => statement.trim())
        .filter(Boolean);
      for (const statement of statements) await pool.query(statement);
    },
    async hasColumn(table, column) {
      const rows = await pool.execute(
        `SELECT COLUMN_NAME FROM information_schema.columns
         WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
        [table, column],
      );
      return rows[0].length > 0;
    },
    async addColumn(table, columnDefinition) {
      await pool.query(`ALTER TABLE ${table} ADD COLUMN ${columnDefinition}`);
    },
    check: async () => {
      const connection = await pool.getConnection();
      connection.release();
    },
  };
}

export const db =
  config.dbDriver === 'mysql' ? createMysqlDatabase() : createSqliteDatabase();
