import express from 'express';
import paymentRoutes from './routes/payments.js';
import superAdminRoutes from './routes/super-admin.js';
import schoolRoutes from './routes/school.js';
import { pool } from './db.js';
import { asyncRoute } from './http.js';

export const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
const allowedOrigins = new Set(
  (process.env.CORS_ORIGINS ?? 'http://localhost:5174,http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
);
app.use((req, res, next) => {
  const origin = req.get('origin');
  if (!origin) return next();
  if (!allowedOrigins.has(origin)) {
    return res.status(403).json({ error: { code: 'ORIGIN_NOT_ALLOWED', message: 'Origin tidak diizinkan.' } });
  }
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Device-Key');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  return next();
});
app.use(express.urlencoded({ extended: false, limit: '20kb' }));
app.use(express.json({
  limit: '2mb',
  strict: true,
  verify(req, res, buffer) {
    if (req.originalUrl.startsWith('/api/payments/kasera/webhook')) {
      req.rawBody = Buffer.from(buffer);
    }
  },
}));

app.get('/api/health', asyncRoute(async (req, res) => {
  await pool.query('SELECT 1');
  res.json({ status: 'ok', database: 'ok' });
}));
app.get('/api/branding/logo', asyncRoute(async (req, res) => {
  const [[branding]] = await pool.execute(
    'SELECT logo_mime_type, logo_data FROM platform_branding WHERE id = 1',
  );
  if (!branding?.logo_data || !branding.logo_mime_type) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Logo platform belum diunggah.' } });
  }
  res.set('Cache-Control', 'public, max-age=300');
  res.type(branding.logo_mime_type).send(branding.logo_data);
}));
app.get('/api/branding', asyncRoute(async (req, res) => {
  const [[branding]] = await pool.execute(
    'SELECT application_name FROM platform_branding WHERE id = 1',
  );
  res.set('Cache-Control', 'public, max-age=60');
  res.json({ application_name: branding?.application_name ?? 'Ruang Hadir' });
}));
app.get('/api/platform/downloads', asyncRoute(async (req, res) => {
  const [[settings]] = await pool.execute(
    'SELECT apk_drive_url FROM platform_download_settings WHERE id = 1',
  );
  res.set('Cache-Control', 'public, max-age=60');
  res.json({ apk_drive_url: settings?.apk_drive_url ?? null });
}));
app.use('/api/super-admin', superAdminRoutes);
app.use('/api/school', schoolRoutes);
app.use('/api/payments', paymentRoutes);

app.use((req, res) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Endpoint tidak ditemukan.' } });
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = Number.isInteger(error.statusCode) ? error.statusCode
    : error.type === 'entity.parse.failed' ? 400
      : error.code === 'ER_DUP_ENTRY' ? 409 : 500;
  const code = error.code === 'ER_DUP_ENTRY' ? 'CONFLICT'
    : status === 500 ? 'INTERNAL_ERROR' : error.code ?? 'REQUEST_ERROR';
  const message = status === 500
    ? 'Terjadi kesalahan internal.'
    : error.type === 'entity.parse.failed' ? 'JSON request tidak valid.' : error.message;
  if (status === 500) console.error(error);
  res.status(status).json({ error: { code, message } });
});
