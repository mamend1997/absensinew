import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function splitStatements(sql) {
  const statements = [];
  let statement = '';
  let quote = null;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    const next = sql[index + 1];

    if (lineComment) {
      if (character === '\n') {
        lineComment = false;
        statement += '\n';
      }
      continue;
    }

    if (blockComment) {
      if (character === '*' && next === '/') {
        blockComment = false;
        index += 1;
        statement += ' ';
      }
      continue;
    }

    if (quote) {
      statement += character;
      if (character === '\\' && quote !== '`' && next !== undefined) {
        statement += next;
        index += 1;
      } else if (character === quote) {
        if (next === quote) {
          statement += next;
          index += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }

    if (character === '-' && next === '-' && /\s/.test(sql[index + 2] ?? '')) {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === '#') {
      lineComment = true;
      continue;
    }
    if (character === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character;
      statement += character;
      continue;
    }
    if (character === ';') {
      if (statement.trim()) statements.push(statement.trim());
      statement = '';
      continue;
    }
    statement += character;
  }

  if (statement.trim()) statements.push(statement.trim());
  return statements;
}

function matchingParenthesis(text, openIndex) {
  let depth = 0;
  let quote = null;

  for (let index = openIndex; index < text.length; index += 1) {
    const character = text[index];
    const next = text[index + 1];

    if (quote) {
      if (character === '\\' && quote !== '`' && next !== undefined) {
        index += 1;
      } else if (character === quote) {
        if (next === quote) index += 1;
        else quote = null;
      }
      continue;
    }

    if (character === "'" || character === '"' || character === '`') {
      quote = character;
    } else if (character === '(') {
      depth += 1;
    } else if (character === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }

  throw new Error('Unclosed parenthesis in MySQL dump.');
}

function splitTopLevel(text) {
  const parts = [];
  let start = 0;
  let depth = 0;
  let quote = null;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const next = text[index + 1];

    if (quote) {
      if (character === '\\' && quote !== '`' && next !== undefined) {
        index += 1;
      } else if (character === quote) {
        if (next === quote) index += 1;
        else quote = null;
      }
      continue;
    }

    if (character === "'" || character === '"' || character === '`') {
      quote = character;
    } else if (character === '(') {
      depth += 1;
    } else if (character === ')') {
      depth -= 1;
    } else if (character === ',' && depth === 0) {
      parts.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }

  if (text.slice(start).trim()) parts.push(text.slice(start).trim());
  return parts;
}

function quoteIdentifier(identifier) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error(`Unsupported identifier in MySQL dump: ${identifier}`);
  }
  return `"${identifier}"`;
}

function sqliteType(mysqlType) {
  const type = mysqlType.toLowerCase();
  if (['bigint', 'int', 'integer', 'mediumint', 'smallint', 'tinyint', 'bit', 'bool', 'boolean', 'year'].includes(type)) {
    return 'INTEGER';
  }
  if (['decimal', 'numeric'].includes(type)) return 'NUMERIC';
  if (['float', 'double', 'real'].includes(type)) return 'REAL';
  if (['binary', 'varbinary', 'tinyblob', 'blob', 'mediumblob', 'longblob'].includes(type)) {
    return 'BLOB';
  }
  if (
    ['char', 'varchar', 'tinytext', 'text', 'mediumtext', 'longtext', 'enum', 'set', 'json',
      'date', 'datetime', 'timestamp', 'time'].includes(type)
  ) {
    return 'TEXT';
  }
  throw new Error(`Unsupported MySQL column type: ${mysqlType}`);
}

function readColumnDefinition(part) {
  const name = part.match(/^`([^`]+)`\s+/);
  if (!name) return null;

  let rest = part.slice(name[0].length);
  const type = rest.match(/^([A-Za-z]+)/);
  if (!type) throw new Error(`Missing type for column ${name[1]}.`);
  const mysqlType = type[1];
  let cursor = type[0].length;
  while (/\s/.test(rest[cursor] ?? '')) cursor += 1;

  if (rest[cursor] === '(') cursor = matchingParenthesis(rest, cursor) + 1;
  rest = rest.slice(cursor)
    .replace(/\s+ON UPDATE CURRENT_TIMESTAMP(?:\(\d+\))?/ig, '')
    .replace(/\bAUTO_INCREMENT\b/ig, '')
    .replace(/\bUNSIGNED\b|\bZEROFILL\b/ig, '')
    .replace(/\bCHARACTER\s+SET\s+[A-Za-z0-9_]+/ig, '')
    .replace(/\bCOLLATE\s+[A-Za-z0-9_]+/ig, '')
    .replace(/(^|[\s(=,])_(?:utf8mb4|utf8mb3|utf8|binary|latin1|ascii|ucs2)(?=')/ig, '$1')
    .replace(/\s+COMMENT\s+'(?:[^'\\]|\\.|'')*'/ig, '')
    .replace(/\bDEFAULT_GENERATED\b/ig, '')
    .replace(/CURRENT_TIMESTAMP\(\d+\)/ig, 'CURRENT_TIMESTAMP')
    .replace(/\bDEFAULT\s+[bB]'([01])'/g, 'DEFAULT $1')
    .trim();

  return `${quoteIdentifier(name[1])} ${sqliteType(mysqlType)}${rest ? ` ${rest}` : ''}`;
}

function normalizeConstraint(part) {
  let normalized = part
    .replace(/`([^`]+)`/g, (_, name) => quoteIdentifier(name))
    .replace(/\bUNSIGNED\b|\bZEROFILL\b/ig, '')
    .replace(/\bCHARACTER\s+SET\s+[A-Za-z0-9_]+/ig, '')
    .replace(/\bCOLLATE\s+[A-Za-z0-9_]+/ig, '')
    .replace(/(^|[\s(=,])_(?:utf8mb4|utf8mb3|utf8|binary|latin1|ascii|ucs2)(?=')/ig, '$1')
    .replace(/\s+USING\s+BTREE\b/ig, '');

  normalized = normalized.replace(
    /("(?:[^"]+)"|[A-Za-z_][A-Za-z0-9_]*)\s+REGEXP\s+'\^\[0-9\]\{(\d+)\}\$'/i,
    (_, column, count) => `${column} GLOB '${'[0-9]'.repeat(Number(count))}'`,
  );
  normalized = normalized.replace(
    /REGEXP_LIKE\(\s*("(?:[^"]+)"|[A-Za-z_][A-Za-z0-9_]*)\s*,\s*'\^\[0-9\]\{(\d+)\}\$'\s*\)/i,
    (_, column, count) => `${column} GLOB '${'[0-9]'.repeat(Number(count))}'`,
  );
  if (/\bREGEXP(?:_LIKE)?\b/i.test(normalized)) {
    throw new Error('Unsupported regular-expression check in MySQL dump.');
  }
  return normalized.trim();
}

function indexDefinition(part, tableName) {
  const match = part.match(/^(UNIQUE\s+)?(?:KEY|INDEX)\s+`([^`]+)`\s*/i);
  if (!match) return null;
  const open = part.indexOf('(', match[0].length);
  if (open < 0) throw new Error(`Invalid index definition on table ${tableName}.`);
  const close = matchingParenthesis(part, open);
  const columns = part.slice(open + 1, close)
    .replace(/(`[^`]+`)\s*\(\d+\)/g, '$1')
    .trim();
  const unique = Boolean(match[1]);
  return {
    unique,
    name: match[2],
    columns: splitTopLevel(columns).map((column) => normalizeConstraint(column)).join(', '),
  };
}

export function translateCreateTable(statement) {
  const header = statement.match(/^CREATE TABLE\s+`([^`]+)`\s*\(/i);
  if (!header) throw new Error('Invalid CREATE TABLE statement in MySQL dump.');
  const tableName = header[1];
  const open = statement.indexOf('(', header[0].length - 1);
  const close = matchingParenthesis(statement, open);
  const parts = splitTopLevel(statement.slice(open + 1, close));
  const definitions = [];
  const columns = [];
  const indexes = [];

  for (const part of parts) {
    if (/^PRIMARY\s+KEY\b/i.test(part)) {
      const keyOpen = part.indexOf('(');
      const keyClose = matchingParenthesis(part, keyOpen);
      definitions.push(`PRIMARY KEY ${normalizeConstraint(part.slice(keyOpen, keyClose + 1))}`);
      continue;
    }

    const index = indexDefinition(part, tableName);
    if (index) {
      if (index.unique) definitions.push(`UNIQUE (${index.columns})`);
      else {
        const indexName = quoteIdentifier(`${tableName}_${index.name}`);
        indexes.push(
          `CREATE INDEX ${indexName} ON ${quoteIdentifier(tableName)} (${index.columns})`,
        );
      }
      continue;
    }

    if (/^(FULLTEXT|SPATIAL)\b/i.test(part)) {
      throw new Error(`Unsupported index type on table ${tableName}.`);
    }

    if (/^(CONSTRAINT|FOREIGN\s+KEY|CHECK)\b/i.test(part)) {
      definitions.push(normalizeConstraint(part));
      continue;
    }

    const column = readColumnDefinition(part);
    if (!column) throw new Error(`Unsupported table definition on ${tableName}.`);
    const name = part.match(/^`([^`]+)`/)[1];
    columns.push(name);
    definitions.push(column);
  }

  const createSql = `CREATE TABLE ${quoteIdentifier(tableName)} (\n  ${definitions.join(',\n  ')}\n)`;
  return { tableName, columns, createSql, indexes };
}

function skipWhitespace(text, index) {
  while (/\s/.test(text[index] ?? '')) index += 1;
  return index;
}

function readQuotedValue(text, index) {
  const quote = text[index];
  let value = '';
  index += 1;

  while (index < text.length) {
    const character = text[index];
    const next = text[index + 1];

    if (character === '\\' && next !== undefined) {
      const escapes = {
        0: '\0',
        b: '\b',
        n: '\n',
        r: '\r',
        t: '\t',
        Z: '\x1a',
        '\\': '\\',
        "'": "'",
        '"': '"',
      };
      value += Object.prototype.hasOwnProperty.call(escapes, next) ? escapes[next] : next;
      index += 2;
      continue;
    }

    if (character === quote) {
      if (next === quote) {
        value += quote;
        index += 2;
        continue;
      }
      return { value, index: index + 1 };
    }

    value += character;
    index += 1;
  }

  throw new Error('Unterminated string value in MySQL dump.');
}

function readValue(text, start) {
  let index = skipWhitespace(text, start);
  if (text.slice(index, index + 2) === '\\N') return { value: null, index: index + 2 };

  const stringPrefix = text.slice(index).match(/^_[A-Za-z0-9]+(?=')/);
  if (stringPrefix) index += stringPrefix[0].length;
  else if (/^[nN]/.test(text[index] ?? '') && text[index + 1] === "'") index += 1;

  if (text[index] === "'" || text[index] === '"') return readQuotedValue(text, index);

  const hexString = text.slice(index).match(/^[xX]'([0-9a-fA-F]*)'/);
  if (hexString) {
    if (hexString[1].length % 2 !== 0) throw new Error('Odd-length hexadecimal value in MySQL dump.');
    return { value: Buffer.from(hexString[1], 'hex'), index: index + hexString[0].length };
  }

  const bitString = text.slice(index).match(/^[bB]'([01]+)'/);
  if (bitString) {
    const value = BigInt(`0b${bitString[1]}`);
    if (value > 9223372036854775807n) {
      throw new Error('Bit value exceeds SQLite signed 64-bit range.');
    }
    return { value: value.toString(), index: index + bitString[0].length };
  }

  const hexValue = text.slice(index).match(/^0[xX]([0-9a-fA-F]*)/);
  if (hexValue) {
    if (hexValue[1].length % 2 !== 0) throw new Error('Odd-length hexadecimal value in MySQL dump.');
    return { value: Buffer.from(hexValue[1], 'hex'), index: index + hexValue[0].length };
  }

  const token = text.slice(index).match(/^[^,\s)]+/);
  if (!token) throw new Error('Invalid value in MySQL dump.');
  const value = token[0];
  if (/^NULL$/i.test(value)) return { value: null, index: index + value.length };
  if (/^TRUE$/i.test(value)) return { value: 1, index: index + value.length };
  if (/^FALSE$/i.test(value)) return { value: 0, index: index + value.length };
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) {
    if (/^[+-]?\d+$/.test(value)) {
      const integer = BigInt(value);
      if (integer > 9223372036854775807n || integer < -9223372036854775808n) {
        throw new Error('Integer value exceeds SQLite signed 64-bit range.');
      }
    }
    return { value, index: index + value.length };
  }
  throw new Error('Unsupported literal in MySQL dump.');
}

function parseInsert(statement, database, tableColumns, rowCounts) {
  const header = statement.match(/^INSERT\s+INTO\s+`([^`]+)`/i);
  if (!header) throw new Error('Invalid INSERT statement in MySQL dump.');
  const tableName = header[1];
  const tableColumnsForInsert = tableColumns.get(tableName);
  if (!tableColumnsForInsert) throw new Error(`INSERT references unknown table ${tableName}.`);

  let index = skipWhitespace(statement, header[0].length);
  let columns = tableColumnsForInsert;
  if (statement[index] === '(') {
    const close = matchingParenthesis(statement, index);
    columns = [...statement.slice(index + 1, close).matchAll(/`([^`]+)`/g)]
      .map((match) => match[1]);
    index = skipWhitespace(statement, close + 1);
  }

  const valuesKeyword = statement.slice(index).match(/^VALUES\b/i);
  if (!valuesKeyword) throw new Error(`INSERT has no VALUES clause for table ${tableName}.`);
  index = skipWhitespace(statement, index + valuesKeyword[0].length);

  const placeholders = columns.map(() => '?').join(', ');
  const quotedColumns = columns.map(quoteIdentifier).join(', ');
  const insert = database.prepare(
    `INSERT INTO ${quoteIdentifier(tableName)} (${quotedColumns}) VALUES (${placeholders})`,
  );
  let rows = 0;

  while (index < statement.length && statement[index] !== ';') {
    index = skipWhitespace(statement, index);
    if (statement[index] === ';' || index >= statement.length) break;
    if (statement[index] !== '(') throw new Error(`Invalid row in INSERT for table ${tableName}.`);
    index += 1;
    const values = [];

    while (true) {
      index = skipWhitespace(statement, index);
      const parsed = readValue(statement, index);
      values.push(parsed.value);
      index = skipWhitespace(statement, parsed.index);
      if (statement[index] === ',') {
        index += 1;
        continue;
      }
      if (statement[index] === ')') {
        index += 1;
        break;
      }
      throw new Error(`Invalid value separator in INSERT for table ${tableName}.`);
    }

    if (values.length !== columns.length) {
      throw new Error(`Column/value count mismatch in INSERT for table ${tableName}.`);
    }
    try {
      insert.run(...values);
    } catch (error) {
      let context = '';
      if (tableName === 'attendance_logs') {
        const eventType = values[columns.indexOf('event_type')];
        const status = values[columns.indexOf('attendance_status')];
        const lateMinutes = Number(values[columns.indexOf('late_minutes')]);
        const eventCategory = ['check_in', 'check_out'].includes(eventType) ? eventType : 'other';
        const statusCategory = ['hadir', 'terlambat', 'pulang'].includes(status) ? status : 'other';
        const minutesCategory = lateMinutes === 0 ? 'zero' : lateMinutes > 0 ? 'positive' : 'other';
        context = ` (attendance categories: ${eventCategory}, ${statusCategory}, ${minutesCategory} minutes)`;
      }
      throw new Error(
        `Failed to insert row ${rows + 1} into table ${tableName}${context}: ${error.message}`,
      );
    }
    rows += 1;
    index = skipWhitespace(statement, index);
    if (statement[index] === ',') index += 1;
    else if (statement[index] !== ';' && index < statement.length) {
      throw new Error(`Invalid row separator in INSERT for table ${tableName}.`);
    }
  }

  rowCounts.set(tableName, (rowCounts.get(tableName) ?? 0) + rows);
}

function isIgnorableStatement(statement) {
  return /^(SET|USE|LOCK\s+TABLES|UNLOCK\s+TABLES|DROP\s+TABLE|CREATE\s+DATABASE|START\s+TRANSACTION|COMMIT)\b/i.test(statement)
    || /^ALTER\s+TABLE\b[\s\S]*\b(?:ENABLE|DISABLE)\s+KEYS\s*$/i.test(statement);
}

export function importMysqlDumpToSqlite(inputPath, outputPath) {
  const input = resolve(inputPath);
  const output = resolve(outputPath);
  if (input === output) throw new Error('Input dump and output database must be different files.');
  if (existsSync(output)) throw new Error(`Refusing to overwrite existing output: ${output}`);

  const sql = readFileSync(input, 'utf8');
  mkdirSync(dirname(output), { recursive: true });
  let database;
  let inTransaction = false;
  try {
    database = new DatabaseSync(output);
    database.exec('PRAGMA foreign_keys = OFF');
    database.exec('BEGIN IMMEDIATE');
    inTransaction = true;

    const tableColumns = new Map();
    const rowCounts = new Map();
    const indexes = [];

    for (const statement of splitStatements(sql)) {
      if (/^CREATE TABLE\b/i.test(statement)) {
        const table = translateCreateTable(statement);
        try {
          database.exec(table.createSql);
        } catch (error) {
          throw new Error(`Failed to create SQLite table ${table.tableName}: ${error.message}`);
        }
        tableColumns.set(table.tableName, table.columns);
        indexes.push(...table.indexes);
      } else if (/^INSERT\s+INTO\b/i.test(statement)) {
        parseInsert(statement, database, tableColumns, rowCounts);
      } else if (!isIgnorableStatement(statement)) {
        const type = statement.match(/^[A-Za-z]+/)?.[0] ?? 'unknown';
        throw new Error(`Unsupported MySQL dump statement: ${type}.`);
      }
    }

    for (const index of indexes) database.exec(index);
    database.exec('COMMIT');
    inTransaction = false;
    database.exec('PRAGMA foreign_keys = ON');

    const integrity = database.prepare('PRAGMA integrity_check').all()[0]?.integrity_check;
    if (integrity !== 'ok') throw new Error(`SQLite integrity check failed: ${integrity ?? 'no result'}.`);

    const foreignKeyViolations = database.prepare('PRAGMA foreign_key_check').all();
    if (foreignKeyViolations.length) {
      throw new Error(`SQLite foreign key check found ${foreignKeyViolations.length} violation(s).`);
    }

    let rows = 0;
    for (const tableName of tableColumns.keys()) {
      const expected = rowCounts.get(tableName) ?? 0;
      const actual = database.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(tableName)}`).get().count;
      if (actual !== expected) {
        throw new Error(`Row count mismatch for table ${tableName}: imported ${expected}, found ${actual}.`);
      }
      rows += actual;
    }

    database.close();
    database = undefined;
    return { tables: tableColumns.size, rows, integrity };
  } catch (error) {
    if (database) {
      if (inTransaction) {
        try {
          database.exec('ROLLBACK');
        } catch (rollbackError) {
          error.rollbackError = rollbackError.message;
        }
      }
      database.close();
      database = undefined;
    }
    for (const path of [output, `${output}-journal`, `${output}-wal`, `${output}-shm`]) {
      if (existsSync(path)) unlinkSync(path);
    }
    throw error;
  } finally {
    if (database) database.close();
  }
}
