import { pool } from '../db.js';
import { fail } from '../http.js';
import { decryptGatewayToken } from './whatsapp-gateway.js';
import { validateAppsScriptWebAppUrl } from './google-sheets-url.js';

export { validateAppsScriptWebAppUrl } from './google-sheets-url.js';

export async function sendAttendanceToGoogleSheets({ schoolId, ids }) {
  if (!ids.length) return;
  const [[settings]] = await pool.execute(
    `SELECT web_app_url, token_ciphertext, token_iv, token_auth_tag
       FROM school_google_sheets_config
      WHERE sekolah_id = ? AND is_enabled = TRUE`,
    [schoolId],
  );
  if (!settings) return;

  const placeholders = ids.map(() => '?').join(', ');
  const [rows] = await pool.execute(
    `SELECT id_unik, participant_code_snapshot AS participant_code,
            participant_name_snapshot AS participant_name,
            classroom_name_snapshot AS classroom_name, attendance_date, event_type,
            client_timestamp_utc, attendance_status, late_minutes, scan_method
       FROM attendance_logs
      WHERE sekolah_id = ? AND id_unik IN (${placeholders})`,
    [schoolId, ...ids],
  );
  if (rows.length !== ids.length) {
    throw fail(502, 'Data absensi tersimpan tidak lengkap untuk Google Sheets.', 'GOOGLE_SHEETS_SYNC_FAILED');
  }

  let response;
  try {
    response = await fetch(validateAppsScriptWebAppUrl(settings.web_app_url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        secret: decryptGatewayToken(settings),
        records: rows.map((row) => ({
          ...row,
          attendance_date: String(row.attendance_date).slice(0, 10),
          client_timestamp: row.client_timestamp_utc,
          late_minutes: Number(row.late_minutes),
        })),
      }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    throw fail(
      502,
      `Absensi sudah tersimpan, tetapi Google Sheets belum dapat dijangkau: ${error.message}`,
      'GOOGLE_SHEETS_SYNC_FAILED',
    );
  }

  const text = await response.text();
  let result;
  try { result = JSON.parse(text); } catch {
    throw fail(502, 'Apps Script mengembalikan respons yang tidak valid.', 'GOOGLE_SHEETS_SYNC_FAILED');
  }
  const accepted = new Set(
    result && typeof result === 'object' && Array.isArray(result.accepted_ids)
      ? result.accepted_ids
      : [],
  );
  if (!response.ok || !result || typeof result !== 'object' ||
      result.ok !== true || ids.some((id) => !accepted.has(id))) {
    throw fail(
      502,
      typeof result.error === 'string'
        ? `Google Sheets menolak sinkronisasi: ${result.error}`
        : 'Google Sheets belum menerima semua data absensi.',
      'GOOGLE_SHEETS_SYNC_FAILED',
    );
  }
}
