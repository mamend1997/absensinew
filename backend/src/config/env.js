import 'dotenv/config';

const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
};

const driver = process.env.DB_DRIVER ?? 'sqlite';
if (!['sqlite', 'mysql'].includes(driver)) {
  throw new Error('DB_DRIVER must be either "sqlite" or "mysql"');
}

const jwtSecret = required('JWT_SECRET');
if (jwtSecret.length < 32 || jwtSecret.startsWith('replace-this-')) {
  throw new Error('JWT_SECRET must be a non-example secret of at least 32 characters');
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  dbDriver: driver,
  sqlitePath: process.env.SQLITE_PATH ?? './data/absensi.sqlite',
  mysql: {
    host: process.env.MYSQL_HOST ?? '127.0.0.1',
    port: Number(process.env.MYSQL_PORT ?? 3306),
    database: process.env.MYSQL_DATABASE ?? 'absensi',
    user: process.env.MYSQL_USER ?? 'absensi_app',
    password: process.env.MYSQL_PASSWORD ?? '',
    connectionLimit: Number(process.env.MYSQL_CONNECTION_LIMIT ?? 10),
  },
  jwtSecret,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '8h',
  appTimezone: process.env.APP_TIMEZONE ?? 'Asia/Jakarta',
  webOrigin: process.env.WEB_ORIGIN ?? 'http://localhost:5173',
};

if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535');
}
