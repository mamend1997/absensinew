import { pool } from '../db.js';
import { fail } from '../http.js';

const CHALLENGE_TABLES = new Set([
  'school_registration_challenges',
  'school_password_reset_challenges',
  'super_admin_password_reset_challenges',
]);

export function validateOtpRateLimitSettings(body) {
  const maxRequestsPerPhone = Number(body?.max_requests_per_phone);
  const windowMinutes = Number(body?.window_minutes);
  if (!Number.isInteger(maxRequestsPerPhone) || maxRequestsPerPhone < 1 || maxRequestsPerPhone > 50) {
    throw fail(400, 'Batas OTP per nomor harus antara 1 dan 50 permintaan.', 'VALIDATION_ERROR');
  }
  if (!Number.isInteger(windowMinutes) || windowMinutes < 1 || windowMinutes > 1440) {
    throw fail(400, 'Jendela waktu OTP harus antara 1 dan 1440 menit.', 'VALIDATION_ERROR');
  }
  return {
    max_requests_per_phone: maxRequestsPerPhone,
    window_minutes: windowMinutes,
  };
}

export async function getOtpRateLimitSettings() {
  const [[settings]] = await pool.execute(
    `SELECT max_requests_per_phone, window_minutes
       FROM platform_otp_rate_limit_settings WHERE id = 1`,
  );
  return {
    max_requests_per_phone: Number(settings?.max_requests_per_phone ?? 10),
    window_minutes: Number(settings?.window_minutes ?? 30),
  };
}

export async function enforceOtpRequestLimit({ challengeTable, phone, ipHash, message, errorCode }) {
  if (!CHALLENGE_TABLES.has(challengeTable)) {
    throw new TypeError('Tabel challenge OTP tidak valid.');
  }
  const settings = await getOtpRateLimitSettings();
  const lookupWindowMinutes = Math.max(settings.window_minutes, 60);
  const [[limits]] = await pool.execute(
    `SELECT
       SUM(whatsapp_phone = ?
         AND created_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? MINUTE)) AS phone_requests,
       SUM(request_ip_hash = ?
         AND created_at >= UTC_TIMESTAMP() - INTERVAL 1 HOUR) AS ip_requests
     FROM ${challengeTable}
     WHERE created_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? MINUTE)`,
    [phone, settings.window_minutes, ipHash, lookupWindowMinutes],
  );
  if (Number(limits.phone_requests ?? 0) >= settings.max_requests_per_phone) {
    throw fail(
      429,
      `${message} Maksimal ${settings.max_requests_per_phone} permintaan per nomor dalam ${settings.window_minutes} menit.`,
      errorCode,
    );
  }
  if (Number(limits.ip_requests ?? 0) >= 20) {
    throw fail(429, `${message} Batas alamat jaringan adalah 20 permintaan per jam.`, errorCode);
  }
  return settings;
}
