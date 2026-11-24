import { pool } from '../db.js';
import { fail } from '../http.js';
import { decryptGatewayToken } from './whatsapp-gateway.js';
import { validateAppsScriptWebAppUrl } from './google-sheets-url.js';

export { validateAppsScriptWebAppUrl } from './google-sheets-url.js';

const SYNC_BATCH_SIZE = 100;
const MAX_BATCHES_PER_RUN = 5;
const ATTENDANCE_PAYLOAD_VERSION = 2;

export function describeAppsScriptResponse(responseStatus, contentType, text) {
  if (/file yang anda minta tidak ada|file you have requested does not exist/i.test(text)) {
    return 'URL Web App Apps Script tidak ditemukan. Salin ulang URL dari Apps Script > Deploy > Manage deployments, lalu pastikan deployment aktif dan aksesnya Anyone.';
  }
  return `Apps Script membalas bukan JSON (HTTP ${responseStatus}, ${contentType}). Pastikan Web App sudah di-deploy, dijalankan sebagai pemilik spreadsheet, dapat diakses Anyone, dan URL berakhir dengan /exec.`;
}

export async function sendAttendanceToGoogleSheets({ schoolId, ids, connection = pool }) {
  if (!ids.length) return;
  const [[settings]] = await connection.execute(
    `SELECT web_app_url, token_ciphertext, token_iv, token_auth_tag
       FROM school_google_sheets_config
      WHERE sekolah_id = ? AND is_enabled = TRUE`,
    [schoolId],
  );
  if (!settings) {
    throw fail(409, 'Sinkronisasi Google Sheets tidak aktif.', 'CONFIGURATION_ERROR');
  }

  const placeholders = ids.map(() => '?').join(', ');
  const scheduleUpdate = connection.dialect === 'sqlite'
    ? `UPDATE attendance_logs AS a
         SET scheduled_check_out = (
           SELECT COALESCE(o.check_out_start, w.check_out_start, s.check_out_start)
             FROM operational_settings s
             LEFT JOIN weekly_operational_schedules w
               ON w.sekolah_id = a.sekolah_id
              AND w.weekday = DAYOFWEEK(a.attendance_date) - 1
             LEFT JOIN participant_operational_overrides o
               ON o.sekolah_id = a.sekolah_id AND o.participant_id = a.participant_id
              AND o.weekday = DAYOFWEEK(a.attendance_date) - 1
            WHERE s.sekolah_id = a.sekolah_id)
       WHERE a.sekolah_id = ? AND a.id_unik IN (${placeholders})
         AND a.event_type IN ('check_out', 'permission_check_out')
         AND a.scheduled_check_out IS NULL
         AND (SELECT COALESCE(o.check_out_start, w.check_out_start, s.check_out_start)
                FROM operational_settings s
                LEFT JOIN weekly_operational_schedules w
                  ON w.sekolah_id = a.sekolah_id
                 AND w.weekday = DAYOFWEEK(a.attendance_date) - 1
                LEFT JOIN participant_operational_overrides o
                  ON o.sekolah_id = a.sekolah_id AND o.participant_id = a.participant_id
                 AND o.weekday = DAYOFWEEK(a.attendance_date) - 1
               WHERE s.sekolah_id = a.sekolah_id) IS NOT NULL`
    : `UPDATE attendance_logs a
         LEFT JOIN operational_settings s ON s.sekolah_id = a.sekolah_id
         LEFT JOIN weekly_operational_schedules w
           ON w.sekolah_id = a.sekolah_id
          AND w.weekday = DAYOFWEEK(a.attendance_date) - 1
         LEFT JOIN participant_operational_overrides o
           ON o.sekolah_id = a.sekolah_id AND o.participant_id = a.participant_id
          AND o.weekday = DAYOFWEEK(a.attendance_date) - 1
          SET a.scheduled_check_out = COALESCE(
            o.check_out_start, w.check_out_start, s.check_out_start)
        WHERE a.sekolah_id = ? AND a.id_unik IN (${placeholders})
          AND a.event_type IN ('check_out', 'permission_check_out')
          AND a.scheduled_check_out IS NULL
          AND COALESCE(o.check_out_start, w.check_out_start, s.check_out_start) IS NOT NULL`;
  await connection.execute(scheduleUpdate, [schoolId, ...ids]);
  const [rows] = await connection.execute(
    `SELECT a.id_unik, a.participant_id,
            UNIX_TIMESTAMP(a.server_received_at) * 1000 AS server_received_at_ms,
            a.participant_code_snapshot AS participant_code,
            a.participant_name_snapshot AS participant_name,
            a.classroom_name_snapshot AS classroom_name,
            a.attendance_date, a.event_type, a.client_timestamp_utc,
            TIME_FORMAT(COALESCE(a.scheduled_check_out, o.check_out_start,
              w.check_out_start, s.check_out_start), '%H:%i:%s') AS scheduled_check_out,
            a.attendance_status, a.late_minutes, a.scan_method
       FROM attendance_logs a
       LEFT JOIN operational_settings s ON s.sekolah_id = a.sekolah_id
       LEFT JOIN weekly_operational_schedules w
         ON w.sekolah_id = a.sekolah_id
        AND w.weekday = DAYOFWEEK(a.attendance_date) - 1
       LEFT JOIN participant_operational_overrides o
         ON o.sekolah_id = a.sekolah_id AND o.participant_id = a.participant_id
        AND o.weekday = DAYOFWEEK(a.attendance_date) - 1
      WHERE a.sekolah_id = ? AND a.id_unik IN (${placeholders})`,
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
    const contentType = response.headers.get('content-type') ?? 'tidak diketahui';
    throw fail(
      502,
      describeAppsScriptResponse(response.status, contentType, text),
      'GOOGLE_SHEETS_SYNC_FAILED',
    );
  }
  const accepted = new Set(
    result && typeof result === 'object' && Array.isArray(result.accepted_ids)
      ? result.accepted_ids
      : [],
  );
  if (!response.ok || !result || typeof result !== 'object' ||
      result.ok !== true || ids.some((id) => !accepted.has(id))) {
    const detail = typeof result?.detail === 'string'
      ? ` (${result.detail.slice(0, 300)})`
      : '';
    throw fail(
      502,
      result && typeof result.error === 'string'
        ? `Google Sheets menolak sinkronisasi: ${result.error}${detail}`
        : 'Google Sheets belum menerima semua data absensi.',
      'GOOGLE_SHEETS_SYNC_FAILED',
    );
  }
}

async function syncSchoolHistory(schoolId) {
  const lockConnection = await pool.getConnection();
  const lockName = `google-sheets-${schoolId}`;
  let locked = false;
  try {
    const [[lock]] = await lockConnection.execute(
      'SELECT GET_LOCK(?, 0) AS acquired',
      [lockName],
    );
    locked = Number(lock?.acquired) === 1;
    if (!locked) return;

    for (let batchNumber = 0; batchNumber < MAX_BATCHES_PER_RUN; batchNumber += 1) {
      const [[state]] = await lockConnection.execute(
        `SELECT last_synced_id, attendance_payload_version
           FROM school_google_sheets_sync_state
          WHERE sekolah_id = ?
            AND (last_error IS NULL OR last_attempt_at IS NULL
              OR last_attempt_at <= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 MINUTE))`,
        [schoolId],
      );
      if (!state) return;
      let lastSyncedId = state.last_synced_id;
      if (Number(state.attendance_payload_version) < ATTENDANCE_PAYLOAD_VERSION) {
        await lockConnection.execute(
          `UPDATE school_google_sheets_sync_state
              SET last_synced_id = 0, attendance_payload_version = ?,
                  last_attempt_at = NULL, last_success_at = NULL, last_error = NULL
            WHERE sekolah_id = ? AND attendance_payload_version < ?`,
          [ATTENDANCE_PAYLOAD_VERSION, schoolId, ATTENDANCE_PAYLOAD_VERSION],
        );
        lastSyncedId = 0;
      }

      const [permissionHistory] = await lockConnection.execute(
        `SELECT id_unik FROM attendance_logs
          WHERE sekolah_id = ? AND event_type IN ('permission_out', 'permission_in')
          ORDER BY id DESC LIMIT ${SYNC_BATCH_SIZE}`,
        [schoolId],
      );
      if (permissionHistory.length) {
        const permissionIds = permissionHistory.map((record) => record.id_unik);
        await sendAttendanceToGoogleSheets({
          schoolId,
          ids: permissionIds,
          connection: lockConnection,
        });
      }

      const [history] = await lockConnection.execute(
        `SELECT id, id_unik FROM attendance_logs
          WHERE sekolah_id = ? AND id > ?
          ORDER BY id ASC LIMIT ${SYNC_BATCH_SIZE}`,
        [schoolId, lastSyncedId],
      );
      if (!history.length) return;

      const lastId = String(history[history.length - 1].id);
      const ids = history.map((record) => record.id_unik);
      await lockConnection.execute(
        `UPDATE school_google_sheets_sync_state
            SET last_attempt_at = UTC_TIMESTAMP()
          WHERE sekolah_id = ?`,
        [schoolId],
      );
      try {
        await sendAttendanceToGoogleSheets({ schoolId, ids, connection: lockConnection });
        await lockConnection.execute(
          `UPDATE school_google_sheets_sync_state
              SET last_synced_id = GREATEST(last_synced_id, ?),
                  last_success_at = UTC_TIMESTAMP(), last_error = NULL
            WHERE sekolah_id = ?`,
          [lastId, schoolId],
        );
      } catch (error) {
        const message = error instanceof Error ? error.message.slice(0, 500) : 'Sinkronisasi Google Sheets gagal.';
        await lockConnection.execute(
          `UPDATE school_google_sheets_sync_state
              SET last_error = ?, last_attempt_at = UTC_TIMESTAMP()
            WHERE sekolah_id = ?`,
          [message, schoolId],
        );
        console.error(`Sinkronisasi Google Sheets sekolah ${schoolId} gagal:`, message);
        return;
      }
    }
  } finally {
    try {
      if (locked) {
        await lockConnection.execute('SELECT RELEASE_LOCK(?)', [lockName]);
      }
    } finally {
      lockConnection.release();
    }
  }
}

export function startGoogleSheetsSyncWorker() {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const [schools] = await pool.execute(
        `SELECT sekolah_id FROM school_google_sheets_config
          WHERE is_enabled = TRUE ORDER BY sekolah_id`,
      );
      for (const school of schools) {
        try {
          await syncSchoolHistory(school.sekolah_id);
        } catch (error) {
          console.error(
            `Pemeriksaan sinkronisasi Google Sheets sekolah ${school.sekolah_id} gagal:`,
            error instanceof Error ? error.message : error,
          );
        }
      }
    } catch (error) {
      console.error(
        'Pemeriksaan antrean Google Sheets gagal:',
        error instanceof Error ? error.message : error,
      );
    } finally {
      running = false;
    }
  };

  void run();
  const timer = setInterval(() => void run(), 15000);
  timer.unref();
}
