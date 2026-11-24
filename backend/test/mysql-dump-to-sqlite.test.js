import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { importMysqlDumpToSqlite } from '../src/utils/mysql-dump-to-sqlite.js';

test('imports MySQL tables, escaped text, binary values, and foreign keys into a new SQLite file', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'mysql-dump-sqlite-'));
  const input = path.join(directory, 'source.sql');
  const output = path.join(directory, 'target.sqlite');
  const dump = `
-- MySQL dump
CREATE TABLE \`parents\` (
  \`id\` bigint unsigned NOT NULL AUTO_INCREMENT,
  \`name\` varchar(80) COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`uq_parent_name\` (\`name\`)
) ENGINE=InnoDB;
CREATE TABLE \`children\` (
  \`id\` bigint unsigned NOT NULL AUTO_INCREMENT,
  \`parent_id\` bigint unsigned NOT NULL,
  \`payload\` varbinary(8) DEFAULT NULL,
  \`enabled\` tinyint(1) NOT NULL DEFAULT '1',
  PRIMARY KEY (\`id\`),
  KEY \`idx_child_parent\` (\`parent_id\`),
  CONSTRAINT \`fk_child_parent\` FOREIGN KEY (\`parent_id\`) REFERENCES \`parents\` (\`id\`) ON DELETE CASCADE
) ENGINE=InnoDB;
INSERT INTO \`parents\` VALUES (1,'O\\'Brien\\nAcademy');
INSERT INTO \`children\` VALUES (5,1,0x410042,1);
`;
  writeFileSync(input, dump, 'utf8');

  try {
    const result = importMysqlDumpToSqlite(input, output);
    assert.deepEqual(result, { tables: 2, rows: 2, integrity: 'ok' });

    const database = new DatabaseSync(output);
    try {
      database.exec('PRAGMA foreign_keys = ON');
      const parent = database.prepare('SELECT name FROM parents WHERE id = 1').get();
      const child = database.prepare('SELECT parent_id, payload, enabled FROM children WHERE id = 5').get();
      assert.equal(parent.name, "O'Brien\nAcademy");
      assert.equal(child.parent_id, 1);
      assert.deepEqual(Buffer.from(child.payload), Buffer.from([0x41, 0x00, 0x42]));
      assert.equal(child.enabled, 1);
      assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
      assert.throws(() => database.exec('INSERT INTO children (id, parent_id) VALUES (6, 99)'));
    } finally {
      database.close();
    }

    const existing = readFileSync(output);
    assert.throws(() => importMysqlDumpToSqlite(input, output), /Refusing to overwrite/);
    assert.deepEqual(readFileSync(output), existing);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('rejects unsupported regular-expression checks rather than silently dropping them', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'mysql-dump-sqlite-'));
  const input = path.join(directory, 'source.sql');
  const output = path.join(directory, 'target.sqlite');
  writeFileSync(input, `
CREATE TABLE \`codes\` (
  \`code\` varchar(8) NOT NULL,
  CONSTRAINT \`chk_code\` CHECK (\`code\` REGEXP '^[A-Z]+$')
) ENGINE=InnoDB;
`, 'utf8');

  try {
    assert.throws(
      () => importMysqlDumpToSqlite(input, output),
      /Unsupported regular-expression check/,
    );
    assert.equal(pathExists(output), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('translates numeric REGEXP_LIKE constraints to SQLite GLOB checks', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'mysql-dump-sqlite-'));
  const input = path.join(directory, 'source.sql');
  const output = path.join(directory, 'target.sqlite');
  writeFileSync(input, `
CREATE TABLE \`codes\` (
  \`code\` char(4) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  CONSTRAINT \`chk_code\` CHECK (regexp_like(\`code\`,_ascii'^[0-9]{4}$'))
) ENGINE=InnoDB;
INSERT INTO \`codes\` VALUES ('1234');
`, 'utf8');

  try {
    const result = importMysqlDumpToSqlite(input, output);
    assert.deepEqual(result, { tables: 1, rows: 1, integrity: 'ok' });

    const database = new DatabaseSync(output);
    try {
      database.exec('PRAGMA foreign_keys = ON');
      assert.throws(() => database.exec("INSERT INTO codes VALUES ('12A4')"));
    } finally {
      database.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function pathExists(filePath) {
  try {
    readFileSync(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
