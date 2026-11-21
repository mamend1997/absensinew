import { pool } from '../db.js';
import { asyncRoute, fail, parseJson } from '../http.js';
import { hashDeviceApiKey, readBearerToken, verifyToken } from '../security.js';

export const requireSuperAdmin = asyncRoute(async (req, res, next) => {
  const token = readBearerToken(req.get('authorization'));
  let claims;
  try {
    claims = token && verifyToken(token);
  } catch {
    claims = null;
  }
  if (claims?.kind !== 'super_admin' || !/^[1-9]\d*$/.test(String(claims.sub))) {
    throw fail(401, 'Autentikasi Super Admin wajib.', 'UNAUTHENTICATED');
  }
  const [rows] = await pool.execute(
    `SELECT id, username, display_name, whatsapp_phone, auth_version
       FROM super_admins WHERE id = ? AND is_active = TRUE`,
    [claims.sub],
  );
  if (!rows.length) throw fail(401, 'Sesi Super Admin tidak lagi aktif.', 'UNAUTHENTICATED');
  if (Number(rows[0].auth_version ?? 0) !== Number(claims.authVersion ?? 0)) {
    throw fail(401, 'Sesi Super Admin telah berakhir. Silakan masuk kembali.', 'UNAUTHENTICATED');
  }
  req.superAdmin = rows[0];
  next();
});

export const requireSchoolUser = asyncRoute(async (req, res, next) => {
  const token = readBearerToken(req.get('authorization'));
  let claims;
  try {
    claims = token && verifyToken(token);
  } catch {
    claims = null;
  }
  if (claims?.kind !== 'school_user' ||
      !/^[1-9]\d*$/.test(String(claims.sub)) ||
      !/^[1-9]\d*$/.test(String(claims.schoolId))) {
    throw fail(401, 'Autentikasi sekolah wajib.', 'UNAUTHENTICATED');
  }
  const [rows] = await pool.execute(
    `SELECT u.id, u.sekolah_id, u.role_id, u.classroom_id, u.username, u.whatsapp_phone, u.auth_version,
            u.display_name, r.role_key, r.role_name, r.permissions, r.sekolah_id AS role_sekolah_id,
            s.school_code, s.name AS school_name, s.timezone, s.subscription_status,
            s.trial_ends_at, s.subscription_expires_at,
            ((s.subscription_status = 'trial' AND s.trial_ends_at IS NOT NULL
              AND s.trial_ends_at <= UTC_TIMESTAMP()) OR
             (s.subscription_expires_at IS NOT NULL
              AND s.subscription_expires_at <= UTC_TIMESTAMP())) AS subscription_expired
       FROM users u
       JOIN roles r ON r.id = u.role_id AND r.sekolah_id = u.sekolah_id
       JOIN schools s ON s.id = u.sekolah_id
      WHERE u.id = ? AND u.sekolah_id = ? AND u.is_active = TRUE
        AND s.is_active = TRUE AND s.subscription_status <> 'suspend'`,
    [claims.sub, claims.schoolId],
  );
  const row = rows[0];
  if (!row || row.school_code !== claims.schoolCode ||
      Number(row.auth_version ?? 0) !== Number(claims.authVersion ?? 0)) {
    throw fail(401, 'Sesi sekolah tidak valid atau kode sekolah telah berubah.', 'UNAUTHENTICATED');
  }
  const permissions = parseJson(row.permissions);
  req.schoolUser = {
    ...row,
    role_key: row.role_key,
    sekolah_id: String(row.sekolah_id),
    role_sekolah_id: String(row.role_sekolah_id),
    classroom_id: row.classroom_id == null ? null : String(row.classroom_id),
    permissions,
    subscription_expired: Boolean(Number(row.subscription_expired)),
  };
  next();
});

export const requireDevice = asyncRoute(async (req, res, next) => {
  const key = req.get('x-device-key');
  if (typeof key !== 'string' || !/^saas_[A-Za-z0-9_-]{43}$/.test(key)) {
    throw fail(401, 'Kunci perangkat tidak valid.', 'UNAUTHENTICATED');
  }
  const [rows] = await pool.execute(
    `SELECT d.id, d.sekolah_id, d.device_name
       FROM scanner_devices d JOIN schools s ON s.id = d.sekolah_id
      WHERE d.api_key_hash = ? AND d.is_active = TRUE AND s.is_active = TRUE
        AND s.subscription_status <> 'suspend'
        AND (s.subscription_status <> 'trial' OR s.trial_ends_at IS NULL
             OR s.trial_ends_at > UTC_TIMESTAMP())
        AND (s.subscription_expires_at IS NULL
             OR s.subscription_expires_at > UTC_TIMESTAMP())`,
    [hashDeviceApiKey(key)],
  );
  if (!rows.length) throw fail(401, 'Kunci perangkat tidak aktif.', 'UNAUTHENTICATED');
  req.device = { ...rows[0], sekolah_id: String(rows[0].sekolah_id) };
  next();
});

export function requirePermission(permission) {
  return requireAnyPermission(permission);
}

export function requireAnyPermission(...permissions) {
  return (req, res, next) => {
    const user = req.schoolUser;
    if (user?.subscription_expired) {
      return next(fail(402, 'Langganan sekolah telah berakhir. Perpanjang untuk melanjutkan.', 'SUBSCRIPTION_EXPIRED'));
    }
    if (!user || String(user.role_sekolah_id) !== String(user.sekolah_id) ||
        !permissions.some((permission) => user.permissions.includes(permission))) {
      return next(fail(403, 'Izin tidak mencukupi.', 'FORBIDDEN'));
    }
    next();
  };
}

export function classroomScope(user, alias = 'p') {
  return user.classroom_id == null
    ? { sql: '', params: [] }
    : { sql: ` AND ${alias}.classroom_id = ?`, params: [user.classroom_id] };
}
