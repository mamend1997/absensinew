import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { config } from '../config/env.js';
import { db } from '../config/database.js';
import { allowRoles, authenticate } from '../middleware/auth.js';
import { asyncHandler } from '../utils/async-handler.js';
import { HttpError } from '../utils/http-error.js';
import { auditRequestContext, writeAuditLog } from '../services/audit-service.js';

const router = Router();
const loginSchema = z.object({
  username: z.string().trim().min(1).max(80),
  password: z.string().min(1).max(200),
});
const pinSchema = z.object({ pin: z.string().regex(/^\d{4}$/, 'PIN harus terdiri dari 4 angka') });
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_request, response) => {
    response.status(429).json({
      error: 'Terlalu banyak percobaan masuk. Silakan coba lagi nanti.',
    });
  },
});
const pinVerificationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_request, response) => {
    response.status(429).json({
      error: 'Terlalu banyak percobaan PIN. Silakan coba lagi nanti.',
    });
  },
});

router.post('/login', loginLimiter, asyncHandler(async (request, response) => {
  const { username, password } = loginSchema.parse(request.body);
  const rows = await db.query(
    `SELECT id, username, display_name, password_hash, role, classroom_id, is_active
     FROM users WHERE username = ?`,
    [username],
  );
  const user = rows[0];
  if (!user || !user.is_active || !(await bcrypt.compare(password, user.password_hash))) {
    await writeAuditLog({
      user: user
        ? { id: user.id, username: user.username, displayName: user.display_name }
        : { id: null, username, displayName: 'Pengguna tidak diketahui' },
      action: 'auth.login.failed',
      entityType: 'user',
      entityId: user?.id ?? null,
      after: { reason: 'invalid_credentials' },
      ipAddress: request.ip,
    });
    throw new HttpError(401, 'Username atau password salah');
  }

  await writeAuditLog({
    user: { id: user.id, username: user.username, displayName: user.display_name },
    action: 'auth.login.succeeded',
    entityType: 'user',
    entityId: user.id,
    after: { role: user.role },
    ipAddress: request.ip,
  });

  const token = jwt.sign(
    { role: user.role },
    config.jwtSecret,
    { subject: String(user.id), expiresIn: config.jwtExpiresIn },
  );
  response.json({
    token,
    token_type: 'Bearer',
    expires_in: config.jwtExpiresIn,
    user: {
      id: String(user.id),
      username: user.username,
      display_name: user.display_name,
      role: user.role,
      classroom_id: user.classroom_id == null ? null : String(user.classroom_id),
    },
  });
}));

router.get('/me', authenticate, (request, response) => {
  response.json({ user: request.user });
});

router.get('/menu-pin/status', authenticate, asyncHandler(async (_request, response) => {
  const rows = await db.query('SELECT id FROM admin_menu_pin WHERE id = 1');
  response.json({ configured: Boolean(rows[0]) });
}));

router.post('/menu-pin/setup', authenticate, allowRoles('admin'), asyncHandler(async (request, response) => {
  const { pin } = pinSchema.parse(request.body);
  const pinHash = await bcrypt.hash(pin, 10);
  await db.transaction(async (transaction) => {
    const rows = await transaction.query('SELECT id FROM admin_menu_pin WHERE id = 1');
    if (rows[0]) throw new HttpError(409, 'PIN menu sudah diatur');
    await transaction.query(
      'INSERT INTO admin_menu_pin (id, pin_hash) VALUES (1, ?)',
      [pinHash],
    );
    await writeAuditLog({
      executor: transaction,
      ...auditRequestContext(request),
      action: 'admin_menu_pin.configured',
      entityType: 'admin_menu_pin',
      entityId: 1,
      after: { configured: true },
    });
  });
  response.status(201).json({ configured: true });
}));

router.post('/menu-pin/verify', authenticate, pinVerificationLimiter, asyncHandler(async (request, response) => {
  const { pin } = pinSchema.parse(request.body);
  const rows = await db.query('SELECT pin_hash FROM admin_menu_pin WHERE id = 1');
  if (!rows[0]) throw new HttpError(409, 'PIN menu belum diatur oleh Admin');
  if (!(await bcrypt.compare(pin, rows[0].pin_hash))) {
    throw new HttpError(401, 'PIN salah');
  }
  response.json({ verified: true });
}));

router.put('/menu-pin/change', authenticate, allowRoles('admin'), pinVerificationLimiter, asyncHandler(async (request, response) => {
  const input = z.object({
    current_pin: z.string().regex(/^\d{4}$/),
    new_pin: z.string().regex(/^\d{4}$/),
  }).parse(request.body);
  const rows = await db.query('SELECT pin_hash FROM admin_menu_pin WHERE id = 1');
  if (!rows[0]) throw new HttpError(409, 'PIN menu belum diatur');
  if (!(await bcrypt.compare(input.current_pin, rows[0].pin_hash))) {
    throw new HttpError(401, 'PIN saat ini salah');
  }
  const pinHash = await bcrypt.hash(input.new_pin, 10);
  await db.transaction(async (transaction) => {
    await transaction.query(
      'UPDATE admin_menu_pin SET pin_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1',
      [pinHash],
    );
    await writeAuditLog({
      executor: transaction,
      ...auditRequestContext(request),
      action: 'admin_menu_pin.changed',
      entityType: 'admin_menu_pin',
      entityId: 1,
      before: { configured: true },
      after: { configured: true },
    });
  });
  response.json({ updated: true });
}));

export default router;
