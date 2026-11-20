import express from 'express';
import superAdminRoutes from './routes/super-admin.js';
import schoolRoutes from './routes/school.js';
import { pool } from './db.js';
import { asyncRoute } from './http.js';

export const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb', strict: true }));

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
app.use('/api/super-admin', superAdminRoutes);
app.use('/api/school', schoolRoutes);

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
