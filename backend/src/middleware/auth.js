import jwt from 'jsonwebtoken';
import { config } from '../config/env.js';
import { db } from '../config/database.js';
import { asyncHandler } from '../utils/async-handler.js';
import { HttpError } from '../utils/http-error.js';

export const authenticate = asyncHandler(async (request, _response, next) => {
  const authorization = request.get('authorization');
  const [scheme, token] = authorization?.split(' ') ?? [];
  if (scheme !== 'Bearer' || !token) {
    throw new HttpError(401, 'Token autentikasi diperlukan');
  }

  let claims;
  try {
    claims = jwt.verify(token, config.jwtSecret);
  } catch {
    throw new HttpError(401, 'Token tidak valid atau sudah kedaluwarsa');
  }

  const rows = await db.query(
    `SELECT id, username, display_name, role, classroom_id, is_active
     FROM users WHERE id = ?`,
    [claims.sub],
  );
  const user = rows[0];
  if (!user || !user.is_active) throw new HttpError(401, 'Akun tidak aktif');
  request.user = {
    id: String(user.id),
    username: user.username,
    displayName: user.display_name,
    role: user.role,
    classroomId: user.classroom_id == null ? null : String(user.classroom_id),
  };
  next();
});

export function allowRoles(...roles) {
  return (request, _response, next) => {
    if (!request.user || !roles.includes(request.user.role)) {
      return next(new HttpError(403, 'Anda tidak memiliki izin untuk tindakan ini'));
    }
    next();
  };
}
