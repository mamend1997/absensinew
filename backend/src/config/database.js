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
    async ensureActivityLogSchema() {
      connection.exec(`
        CREATE TABLE IF NOT EXISTS activity_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
          actor_username TEXT NOT NULL,
          actor_display_name TEXT NOT NULL,
          action TEXT NOT NULL,
          entity_type TEXT NOT NULL,
          entity_id TEXT,
          before_data TEXT,
          after_data TEXT,
          ip_address TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_activity_logs_created
          ON activity_logs (created_at, id);
        CREATE INDEX IF NOT EXISTS idx_activity_logs_entity
          ON activity_logs (entity_type, entity_id, created_at);
      `);
    },
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
    async ensureActivityLogSchema() {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS activity_logs (
          id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
          actor_user_id BIGINT UNSIGNED NULL,
          actor_username VARCHAR(80) NOT NULL,
          actor_display_name VARCHAR(150) NOT NULL,
          action VARCHAR(80) NOT NULL,
          entity_type VARCHAR(80) NOT NULL,
          entity_id VARCHAR(100) NULL,
          before_data JSON NULL,
          after_data JSON NULL,
          ip_address VARCHAR(64) NULL,
          created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
          PRIMARY KEY (id),
          KEY idx_activity_logs_created (created_at, id),
          KEY idx_activity_logs_entity (entity_type, entity_id, created_at),
          CONSTRAINT fk_activity_logs_actor FOREIGN KEY (actor_user_id)
            REFERENCES users (id) ON DELETE SET NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
    },
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
