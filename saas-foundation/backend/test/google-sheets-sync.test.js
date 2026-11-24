import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateAppsScriptWebAppUrl } from '../src/core/google-sheets-url.js';
import { createSqlitePool } from '../src/sqlite-db.js';

process.env.JWT_SECRET ??= randomBytes(48).toString('base64url');
const [{ describeAppsScriptResponse, sendAttendanceToGoogleSheets },
  { encryptGatewayToken }] = await Promise.all([
  import('../src/core/google-sheets-sync.js'),
  import('../src/core/whatsapp-gateway.js'),
]);

test('Apps Script sync accepts only HTTPS deployment URLs', () => {
  const url = 'https://script.google.com/macros/s/Abc_123/exec';
  assert.equal(validateAppsScriptWebAppUrl(url), url);
});

test('Apps Script sync rejects lookalike hosts and URLs with extra parameters', () => {
  for (const url of [
    'http://script.google.com/macros/s/Abc_123/exec',
    'https://script.google.com.evil.example/macros/s/Abc_123/exec',
    'https://script.google.com/macros/s/Abc_123/exec?x=1',
    'https://example.com/macros/s/Abc_123/exec',
  ]) {
    assert.throws(() => validateAppsScriptWebAppUrl(url), { code: 'VALIDATION_ERROR' });
  }
});

test('Apps Script sync explains when the deployment URL points to a missing file', () => {
  assert.match(
    describeAppsScriptResponse(200, 'text/html', 'Maaf, file yang Anda minta tidak ada.'),
    /URL Web App Apps Script tidak ditemukan/,
  );
  assert.match(
    describeAppsScriptResponse(200, 'text/html', '<html>Sign in</html>'),
    /dapat diakses Anyone/,
  );
});

test('Google Sheets sync backfills and sends the effective checkout schedule', async () => {
  const token = encryptGatewayToken('test-sync-secret');
  const queries = [];
  const connection = {
    async execute(sql, params) {
      queries.push({ sql, params });
      if (sql.includes('FROM school_google_sheets_config')) {
        return [[{
          web_app_url: 'https://script.google.com/macros/s/test-deployment/exec',
          token_ciphertext: token.ciphertext,
          token_iv: token.iv,
          token_auth_tag: token.authTag,
        }]];
      }
      if (sql.includes('UPDATE attendance_logs')) return [{ affectedRows: 1 }];
      return [[{
        id_unik: 'scan-1',
        participant_id: '17',
        server_received_at_ms: 1795408245000,
        participant_code: 'P17',
        participant_name: 'Maman',
        classroom_name: 'Kelas 1',
        attendance_date: '2026-11-23',
        event_type: 'check_out',
        client_timestamp_utc: '2026-11-23 04:30:45.000',
        scheduled_check_out: '15:15:00',
        attendance_status: 'pulang',
        late_minutes: 0,
        scan_method: 'SCAN_QR',
      }]];
    },
  };
  const previousFetch = globalThis.fetch;
  let payload;
  globalThis.fetch = async (_url, options) => {
    payload = JSON.parse(options.body);
    return {
      ok: true,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify({ ok: true, accepted_ids: ['scan-1'] }),
    };
  };

  try {
    await sendAttendanceToGoogleSheets({
      schoolId: '4',
      ids: ['scan-1'],
      connection,
    });
  } finally {
    globalThis.fetch = previousFetch;
  }

  assert.match(queries[1].sql, /UPDATE attendance_logs/);
  assert.match(queries[1].sql, /COALESCE\(o\.check_out_start, w\.check_out_start, s\.check_out_start\)/);
  assert.equal(payload.records[0].scheduled_check_out, '15:15:00');
  assert.deepEqual(payload.records.map((record) => record.id_unik), ['scan-1']);
});

test('Google Sheets sync backfills schedules with SQLite queries', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'absensi-google-sheets-sqlite-'));
  const pool = createSqlitePool(join(directory, 'test.sqlite'));
  t.after(async () => {
    await pool.end();
    rmSync(directory, { recursive: true, force: true });
  });
  const token = encryptGatewayToken('test-sync-secret');
  await pool.execute(
    `CREATE TABLE school_google_sheets_config (
       sekolah_id INTEGER PRIMARY KEY, web_app_url TEXT, token_ciphertext TEXT,
       token_iv TEXT, token_auth_tag TEXT, is_enabled INTEGER
     )`,
  );
  await pool.execute(
    `CREATE TABLE attendance_logs (
       sekolah_id INTEGER, id_unik TEXT, participant_id INTEGER,
       participant_code_snapshot TEXT, participant_name_snapshot TEXT,
       classroom_name_snapshot TEXT, attendance_date TEXT, event_type TEXT,
       client_timestamp_utc TEXT, scheduled_check_out TEXT, server_received_at TEXT,
       attendance_status TEXT, late_minutes INTEGER, scan_method TEXT
     )`,
  );
  await pool.execute(
    `CREATE TABLE operational_settings (sekolah_id INTEGER, check_out_start TEXT)`,
  );
  await pool.execute(
    `CREATE TABLE weekly_operational_schedules (
       sekolah_id INTEGER, weekday INTEGER, check_out_start TEXT
     )`,
  );
  await pool.execute(
    `CREATE TABLE participant_operational_overrides (
       sekolah_id INTEGER, participant_id INTEGER, weekday INTEGER, check_out_start TEXT
     )`,
  );
  await pool.execute(
    `INSERT INTO school_google_sheets_config
       (sekolah_id, web_app_url, token_ciphertext, token_iv, token_auth_tag, is_enabled)
     VALUES (4, ?, ?, ?, ?, 1)`,
    [
      'https://script.google.com/macros/s/test-deployment/exec',
      token.ciphertext,
      token.iv,
      token.authTag,
    ],
  );
  await pool.execute(
    `INSERT INTO attendance_logs
       (sekolah_id, id_unik, participant_id, participant_code_snapshot,
        participant_name_snapshot, classroom_name_snapshot, attendance_date, event_type,
        client_timestamp_utc, scheduled_check_out, server_received_at,
        attendance_status, late_minutes, scan_method)
     VALUES (4, 'scan-1', 17, 'P17', 'Maman', 'Kelas 1', '2026-11-23',
             'check_out', '2026-11-23 04:30:45.000', NULL,
             '2026-11-23 04:30:45', 'pulang', 0, 'SCAN_QR')`,
  );
  await pool.execute(
    `INSERT INTO operational_settings (sekolah_id, check_out_start) VALUES (4, '15:00:00')`,
  );
  await pool.execute(
    `INSERT INTO weekly_operational_schedules
       (sekolah_id, weekday, check_out_start) VALUES (4, 1, '15:15:00')`,
  );

  const previousFetch = globalThis.fetch;
  let payload;
  globalThis.fetch = async (_url, options) => {
    payload = JSON.parse(options.body);
    return {
      ok: true,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify({ ok: true, accepted_ids: ['scan-1'] }),
    };
  };
  try {
    await sendAttendanceToGoogleSheets({
      schoolId: 4,
      ids: ['scan-1'],
      connection: pool,
    });
  } finally {
    globalThis.fetch = previousFetch;
  }

  assert.equal(payload.records[0].scheduled_check_out, '15:15:00');
  const [attendance] = await pool.execute(
    'SELECT scheduled_check_out FROM attendance_logs WHERE id_unik = ?',
    ['scan-1'],
  );
  assert.equal(attendance[0].scheduled_check_out, '15:15:00');
});
