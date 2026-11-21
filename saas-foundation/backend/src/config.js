import 'dotenv/config';

const jwtSecret = process.env.JWT_SECRET ?? '';
if (Buffer.byteLength(jwtSecret, 'utf8') < 32 ||
    /^(change-me|secret|password|replace-with)/i.test(jwtSecret)) {
  throw new Error('JWT_SECRET wajib diisi dengan secret acak minimal 32 byte.');
}

const backupTimezone = process.env.BACKUP_TIMEZONE ?? 'Asia/Jakarta';
try {
  new Intl.DateTimeFormat('en', { timeZone: backupTimezone });
} catch {
  throw new Error('BACKUP_TIMEZONE harus berupa zona waktu IANA yang valid.');
}

export const config = Object.freeze({
  host: process.env.HOST ?? '127.0.0.1',
  port: Number(process.env.PORT ?? 4100),
  jwtSecret,
  jwtTtl: process.env.JWT_TTL ?? '8h',
  schoolJwtTtl: process.env.SCHOOL_JWT_TTL ?? '30d',
  publicWebUrl: process.env.PUBLIC_WEB_URL?.trim() ?? '',
  publicApiUrl: process.env.PUBLIC_API_URL?.trim() ?? '',
  backupDirectory: process.env.BACKUP_DIRECTORY?.trim() ?? '',
  backupTimezone,
  xenditSecretKey: process.env.XENDIT_SECRET_KEY?.trim() ?? '',
  xenditCallbackToken: process.env.XENDIT_CALLBACK_TOKEN?.trim() ?? '',
  duitkuMerchantCode: process.env.DUITKU_MERCHANT_CODE?.trim() ?? '',
  duitkuApiKey: process.env.DUITKU_API_KEY?.trim() ?? '',
  duitkuEnvironment: process.env.DUITKU_ENVIRONMENT === 'sandbox' ? 'sandbox' : 'production',
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
