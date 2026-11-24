import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const sourceDirectory = dirname(fileURLToPath(import.meta.url));

function createMutex() {
  let tail = Promise.resolve();
  return async () => {
    let unlock;
    const previous = tail;
    tail = new Promise((resolvePromise) => {
      unlock = resolvePromise;
    });
    await previous;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      unlock();
    };
  };
}

function matchingParenthesis(text, openIndex) {
  let depth = 0;
  let quote = null;
  for (let index = openIndex; index < text.length; index += 1) {
    const character = text[index];
    const next = text[index + 1];
    if (quote) {
      if (character === '\\' && quote !== '`' && next !== undefined) index += 1;
      else if (character === quote) {
        if (next === quote) index += 1;
        else quote = null;
      }
      continue;
    }
    if (character === "'" || character === '"' || character === '`') quote = character;
    else if (character === '(') depth += 1;
    else if (character === ')' && --depth === 0) return index;
  }
  throw new Error('Unclosed function call in SQL statement.');
}

function splitFunctionArguments(text) {
  let depth = 0;
  let quote = null;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const next = text[index + 1];
    if (quote) {
      if (character === '\\' && quote !== '`' && next !== undefined) index += 1;
      else if (character === quote) {
        if (next === quote) index += 1;
        else quote = null;
      }
      continue;
    }
    if (character === "'" || character === '"' || character === '`') quote = character;
    else if (character === '(') depth += 1;
    else if (character === ')') depth -= 1;
    else if (character === ',' && depth === 0) {
      return [text.slice(0, index).trim(), text.slice(index + 1).trim()];
    }
  }
  return [text.trim(), ''];
}

function rewriteFunctionCalls(sql, name, rewrite) {
  const pattern = new RegExp(`\\b${name}\\s*\\(`, 'ig');
  let output = '';
  let cursor = 0;
  let match;
  while ((match = pattern.exec(sql))) {
    const open = pattern.lastIndex - 1;
    const close = matchingParenthesis(sql, open);
    const args = sql.slice(open + 1, close);
    output += sql.slice(cursor, match.index) + rewrite(args);
    cursor = close + 1;
    pattern.lastIndex = cursor;
  }
  return output + sql.slice(cursor);
}

function rewriteIntervalFunctions(sql) {
  let translated = sql.replace(
    /\bTIMESTAMPADD\s*\(\s*(SECOND|MINUTE|HOUR|DAY|WEEK|MONTH|YEAR)\s*,\s*(\?|\d+)\s*,\s*(UTC_TIMESTAMP\(\)|[A-Za-z_][A-Za-z0-9_.]*)\s*\)/ig,
    (_, unit, amount, value) => `mysql_date_add(${value}, ${amount}, '${unit}')`,
  );
  translated = rewriteFunctionCalls(translated, 'DATE_ADD', (args) => {
    const [value, interval] = splitFunctionArguments(args);
    const match = interval.match(/^INTERVAL\s+(\?|\d+)\s+(SECOND|MINUTE|HOUR|DAY|WEEK|MONTH|YEAR)$/i);
    if (!match) throw new Error('Unsupported DATE_ADD interval in SQLite mode.');
    return `mysql_date_add(${value}, ${match[1]}, '${match[2]}')`;
  });
  translated = rewriteFunctionCalls(translated, 'DATE_SUB', (args) => {
    const [value, interval] = splitFunctionArguments(args);
    const match = interval.match(/^INTERVAL\s+(\?|\d+)\s+(SECOND|MINUTE|HOUR|DAY|WEEK|MONTH|YEAR)$/i);
    if (!match) throw new Error('Unsupported DATE_SUB interval in SQLite mode.');
    return `mysql_date_sub(${value}, ${match[1]}, '${match[2]}')`;
  });
  translated = translated.replace(
    /(UTC_TIMESTAMP\(\)|[A-Za-z_][A-Za-z0-9_.]*)\s*([+-])\s*INTERVAL\s+(\?|\d+)\s+(SECOND|MINUTE|HOUR|DAY|WEEK|MONTH|YEAR)\b/ig,
    (_, value, operator, amount, unit) =>
      `mysql_date_${operator === '+' ? 'add' : 'sub'}(${value}, ${amount}, '${unit}')`,
  );
  return translated;
}

export function translateMysqlSql(sql) {
  const getLock = sql.match(/^\s*SELECT\s+GET_LOCK\(\?,\s*0\)\s+AS\s+acquired\s*;?\s*$/i);
  if (getLock) return 'SELECT 1 AS acquired';
  if (/^\s*SELECT\s+RELEASE_LOCK\(\?\)\s*;?\s*$/i.test(sql)) return 'SELECT 1';
  if (/^\s*SET\s+FOREIGN_KEY_CHECKS\s*=\s*0\s*;?\s*$/i.test(sql)) {
    return 'PRAGMA foreign_keys = OFF';
  }
  if (/^\s*SET\s+FOREIGN_KEY_CHECKS\s*=\s*1\s*;?\s*$/i.test(sql)) {
    return 'PRAGMA foreign_keys = ON';
  }

  let translated = rewriteIntervalFunctions(sql);
  translated = translated
    .replace(/\bUTC_TIMESTAMP\(\)/ig, 'mysql_utc_timestamp()')
    .replace(/\bFOR\s+UPDATE\b/ig, '')
    .replace(/\bINSERT\s+IGNORE\s+INTO\b/ig, 'INSERT OR IGNORE INTO')
    .replace(/\bIF\s*\(/ig, 'IIF(')
    .replace(/\bGREATEST\s*\(/ig, 'MAX(');

  translated = rewriteFunctionCalls(translated, 'UNIX_TIMESTAMP', (args) =>
    `mysql_unix_timestamp(${args})`);
  translated = rewriteFunctionCalls(translated, 'DAYOFWEEK', (args) =>
    `mysql_dayofweek(${args})`);
  translated = rewriteFunctionCalls(translated, 'TIME_FORMAT', (args) => {
    const [value, format] = splitFunctionArguments(args);
    return `mysql_time_format(${value}, ${format})`;
  });

  const duplicateKeyIndex = translated.search(/\bON\s+DUPLICATE\s+KEY\s+UPDATE\b/i);
  if (duplicateKeyIndex >= 0) {
    const clauseLength = translated.match(/\bON\s+DUPLICATE\s+KEY\s+UPDATE\b/i)[0].length;
    const updateClause = translated.slice(duplicateKeyIndex + clauseLength)
      .replace(/\bVALUES\s*\(\s*`?([A-Za-z_][A-Za-z0-9_]*)`?\s*\)/ig, 'excluded.$1');
    translated = `${translated.slice(0, duplicateKeyIndex)}ON CONFLICT DO UPDATE SET${updateClause}`;
  }

  return translated;
}

function parseUtcDate(value) {
  if (value == null) return null;
  const text = String(value).trim();
  const normalized = text.includes('T') ? text : text.replace(' ', 'T');
  const parsed = new Date(/[zZ]|[+-]\d\d:\d\d$/.test(normalized) ? normalized : `${normalized}Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatUtcDate(date, dateOnly = false, milliseconds = false) {
  const iso = date.toISOString();
  return dateOnly
    ? iso.slice(0, 10)
    : `${iso.slice(0, 19).replace('T', ' ')}${milliseconds ? iso.slice(19, 23) : ''}`;
}

function addDateInterval(value, amount, unit) {
  const date = parseUtcDate(value);
  const count = Number(amount);
  if (!date || !Number.isFinite(count)) return null;
  const normalizedUnit = String(unit).toLowerCase();
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(String(value));
  const milliseconds = /\.\d{1,3}(?:$|Z)/.test(String(value));

  if (normalizedUnit === 'month' || normalizedUnit === 'year') {
    const originalDay = date.getUTCDate();
    const months = count * (normalizedUnit === 'year' ? 12 : 1);
    const targetMonth = date.getUTCMonth() + months;
    date.setUTCDate(1);
    date.setUTCMonth(targetMonth);
    const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
    date.setUTCDate(Math.min(originalDay, lastDay));
  } else {
    const unitMilliseconds = {
      second: 1000,
      minute: 60_000,
      hour: 3_600_000,
      day: 86_400_000,
      week: 604_800_000,
    }[normalizedUnit];
    if (!unitMilliseconds) return null;
    date.setTime(date.getTime() + count * unitMilliseconds);
  }
  return formatUtcDate(date, dateOnly, milliseconds);
}

function registerFunctions(database) {
  database.function('mysql_utc_timestamp', () => new Date().toISOString().slice(0, 19).replace('T', ' '));
  database.function('mysql_date_add', (value, amount, unit) => addDateInterval(value, amount, unit));
  database.function('mysql_date_sub', (value, amount, unit) => addDateInterval(value, -Number(amount), unit));
  database.function('mysql_unix_timestamp', (value) => {
    const date = parseUtcDate(value);
    return date ? Math.floor(date.getTime() / 1000) : null;
  });
  database.function('mysql_dayofweek', (value) => {
    const date = parseUtcDate(value);
    return date ? date.getUTCDay() + 1 : null;
  });
  database.function('mysql_time_format', (value, format) => {
    if (value == null) return null;
    const [hour = '00', minute = '00', second = '00'] = String(value).split(':');
    return String(format)
      .replace(/%H/g, hour.padStart(2, '0'))
      .replace(/%i/g, minute.padStart(2, '0'))
      .replace(/%s/g, second.padStart(2, '0'));
  });
}

function sqliteError(error, sql) {
  if (/UNIQUE constraint failed|PRIMARY KEY constraint failed/i.test(error.message)) {
    error.code = 'ER_DUP_ENTRY';
  } else if (/CHECK constraint failed/i.test(error.message)) {
    error.code = 'ER_CHECK_CONSTRAINT_VIOLATED';
  } else if (/FOREIGN KEY constraint failed/i.test(error.message) &&
      /^\s*(DELETE|UPDATE)\b/i.test(sql)) {
    error.code = 'ER_ROW_IS_REFERENCED_2';
  }
  return error;
}

function createConnection(database, release = () => {}) {
  let released = false;
  return {
    dialect: 'sqlite',
    async execute(sql, params = []) {
      return executeSql(database, sql, params);
    },
    async query(sql, params = []) {
      return executeSql(database, sql, params);
    },
    async beginTransaction() {
      database.exec('BEGIN IMMEDIATE');
    },
    async commit() {
      database.exec('COMMIT');
    },
    async rollback() {
      database.exec('ROLLBACK');
    },
    release() {
      if (released) return;
      released = true;
      release();
    },
    async listTables() {
      return database.prepare(
        "SELECT name AS table_name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      ).all();
    },
    async getTableColumns(tableName) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tableName)) throw new Error('Invalid SQLite table name.');
      return database.prepare(`PRAGMA table_info("${tableName}")`).all().map((column) => ({
        table_name: tableName,
        column_name: column.name,
        data_type: String(column.type ?? '').toLowerCase(),
        ordinal_position: column.cid + 1,
      }));
    },
  };
}

function executeSql(database, sql, params) {
  const translated = translateMysqlSql(sql);
  const isAdvisoryLockQuery =
    /^\s*SELECT\s+(?:GET_LOCK\(\?,\s*0\)\s+AS\s+acquired|RELEASE_LOCK\(\?\))\s*;?\s*$/i.test(sql);
  try {
    if (/^\s*PRAGMA\s+foreign_keys\s*=/i.test(translated)) {
      database.exec(translated);
      return [{ affectedRows: 0, insertId: 0 }, undefined];
    }
    const statement = database.prepare(translated);
    const values = isAdvisoryLockQuery
      ? []
      : params.map((value) => value === undefined ? null : value);
    if (statement.columns().length) return [statement.all(...values), undefined];
    const result = statement.run(...values);
    return [{
      affectedRows: Number(result.changes),
      insertId: Number(result.lastInsertRowid ?? 0),
    }, undefined];
  } catch (error) {
    throw sqliteError(error, translated);
  }
}

export function createSqlitePool(sqlitePath) {
  const filePath = isAbsolute(sqlitePath)
    ? sqlitePath
    : resolve(process.cwd(), sqlitePath);
  mkdirSync(dirname(filePath), { recursive: true });

  const database = new DatabaseSync(filePath);
  database.exec('PRAGMA foreign_keys = ON');
  database.exec('PRAGMA busy_timeout = 5000');
  database.exec('PRAGMA journal_mode = WAL');
  registerFunctions(database);

  const acquire = createMutex();
  const transactionContext = new AsyncLocalStorage();
  const connection = createConnection(database);

  const execute = async (sql, params = []) => {
    const activeConnection = transactionContext.getStore();
    if (activeConnection) return activeConnection.execute(sql, params);
    const release = await acquire();
    try {
      return await connection.execute(sql, params);
    } finally {
      release();
    }
  };

  return {
    dialect: 'sqlite',
    execute,
    query: execute,
    async getConnection() {
      const release = await acquire();
      return createConnection(database, release);
    },
    async transaction(work) {
      const activeConnection = transactionContext.getStore();
      if (activeConnection) {
        const savepoint = `nested_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        database.exec(`SAVEPOINT ${savepoint}`);
        try {
          const result = await work(activeConnection);
          database.exec(`RELEASE SAVEPOINT ${savepoint}`);
          return result;
        } catch (error) {
          database.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          database.exec(`RELEASE SAVEPOINT ${savepoint}`);
          throw error;
        }
      }

      const release = await acquire();
      try {
        database.exec('BEGIN IMMEDIATE');
        return await transactionContext.run(connection, async () => {
          try {
            const result = await work(connection);
            database.exec('COMMIT');
            return result;
          } catch (error) {
            database.exec('ROLLBACK');
            throw error;
          }
        });
      } finally {
        release();
      }
    },
    async initializeSchema() {
      const schemaPath = resolve(sourceDirectory, '..', 'database', 'schema.sqlite.sql');
      const schema = readFileSync(schemaPath, 'utf8');
      database.exec(schema);

      const reference = new DatabaseSync(':memory:');
      try {
        reference.exec(schema);
        const expectedTables = reference.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        ).all();
        for (const { name } of expectedTables) {
          const expected = new Set(
            reference.prepare(`PRAGMA table_info("${name}")`).all().map((column) => column.name),
          );
          const actual = new Set(
            database.prepare(`PRAGMA table_info("${name}")`).all().map((column) => column.name),
          );
          const missing = [...expected].filter((column) => !actual.has(column));
          if (missing.length) {
            throw new Error(`Tabel SQLite ${name} kehilangan kolom wajib: ${missing.join(', ')}.`);
          }
        }
      } finally {
        reference.close();
      }
    },
    async listTables() {
      return connection.listTables();
    },
    async getTableColumns(tableName) {
      return connection.getTableColumns(tableName);
    },
    async end() {
      database.close();
    },
  };
}
