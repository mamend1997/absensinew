import { resolve } from 'node:path';
import { importMysqlDumpToSqlite } from '../src/utils/mysql-dump-to-sqlite.js';

function parseArguments(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (!['--input', '--output'].includes(key) || !args[index + 1]) {
      throw new Error('Usage: node scripts/import-mysql-dump-sqlite.js --input <dump.sql> --output <new.sqlite>');
    }
    values.set(key, args[index + 1]);
    index += 1;
  }

  if (!values.has('--input') || !values.has('--output')) {
    throw new Error('Usage: node scripts/import-mysql-dump-sqlite.js --input <dump.sql> --output <new.sqlite>');
  }
  return {
    input: resolve(values.get('--input')),
    output: resolve(values.get('--output')),
  };
}

try {
  const { input, output } = parseArguments(process.argv.slice(2));
  const result = importMysqlDumpToSqlite(input, output);
  console.log(`Import completed: ${result.tables} tables, ${result.rows} rows, integrity=${result.integrity}.`);
  console.log(`SQLite file: ${output}`);
} catch (error) {
  console.error('MySQL-to-SQLite import failed:', error.message);
  if (error.rollbackError) console.error('Rollback failed:', error.rollbackError);
  process.exitCode = 1;
}
