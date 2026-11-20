import 'dotenv/config';

const jwtSecret = process.env.JWT_SECRET ?? '';
if (Buffer.byteLength(jwtSecret, 'utf8') < 32 ||
    /^(change-me|secret|password|replace-with)/i.test(jwtSecret)) {
  throw new Error('JWT_SECRET wajib diisi dengan secret acak minimal 32 byte.');
}

export const config = Object.freeze({
  host: process.env.HOST ?? '127.0.0.1',
  port: Number(process.env.PORT ?? 4100),
  jwtSecret,
  jwtTtl: process.env.JWT_TTL ?? '8h',
  mysql: Object.freeze({
    host: process.env.MYSQL_HOST ?? '127.0.0.1',
    port: Number(process.env.MYSQL_PORT ?? 3306),
    database: process.env.MYSQL_DATABASE ?? 'absensi_saas',
    user: process.env.MYSQL_USER ?? 'absensi_saas',
    password: process.env.MYSQL_PASSWORD ?? '',
    connectionLimit: Number(process.env.MYSQL_CONNECTION_LIMIT ?? 10),
    charset: 'utf8mb4',
    timezone: 'Z',
    dateStrings: true,
    decimalNumbers: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
  }),
});
