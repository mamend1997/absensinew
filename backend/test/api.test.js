import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { ensureRuntimeMigrations } from '../src/config/runtime-migrations.js';

const tempDir = await mkdtemp(join(tmpdir(), 'absensi-api-'));
const execFileAsync = promisify(execFile);
process.env.DB_DRIVER = 'sqlite';
process.env.SQLITE_PATH = join(tempDir, 'test.sqlite');
process.env.JWT_SECRET = 'test-secret-for-absensi-api-at-least-32-characters';
process.env.NODE_ENV = 'test';
process.env.WEB_ORIGIN = 'http://localhost:5173';
process.env.NOTIFICATION_ADMIN_PHONE = '08123456789';
process.env.WHATSAPP_GATEWAY_URL = '';
process.env.WHATSAPP_GATEWAY_TOKEN = '';
process.env.BACKUP_DIRECTORY = join(tempDir, 'private-backups');

const [{ app }, { db }, { runScheduledBackup }] = await Promise.all([
  import('../src/app.js'),
  import('../src/config/database.js'),
  import('../src/services/scheduled-backup-service.js'),
]);
await db.initializeSchema();

test('startup migration recreates a missing audit table without replacing other data', async () => {
  await db.query('DROP TABLE activity_logs');
  await db.query('DROP TABLE scheduled_backup_settings');
  await db.query('DROP TABLE attendance_notifications');
  await ensureRuntimeMigrations(db);
  const rows = await db.query('SELECT COUNT(*) AS count FROM activity_logs');
  assert.equal(Number(rows[0].count), 0);
  const backupSettings = await db.query(
    'SELECT enabled, backup_time FROM scheduled_backup_settings WHERE id = 1',
  );
  assert.equal(backupSettings[0].backup_time, '02:00');
  assert.equal(
    Number((await db.query('SELECT COUNT(*) AS count FROM attendance_notifications'))[0].count),
    0,
  );
});

const passwordHash = await bcrypt.hash('test-password-2026', 4);
const classroom = (await db.query(
  `SELECT c.id FROM classrooms c JOIN units u ON u.id = c.unit_id
   WHERE u.name = 'Unit Contoh' AND c.name = 'Kelas 1'`,
))[0];
await db.query(
  `INSERT INTO users (username, display_name, password_hash, role)
   VALUES (?, ?, ?, ?)`,
  ['admin-test', 'Admin Test', passwordHash, 'admin'],
);
await db.query(
  `INSERT INTO users (username, display_name, password_hash, role, classroom_id)
   VALUES (?, ?, ?, ?, ?)`,
  ['operator-test', 'Operator Test', passwordHash, 'operator', classroom.id],
);
await db.query("UPDATE operational_settings SET updated_at = '2000-01-01 00:00:00' WHERE id = 1");
await db.query("UPDATE participants SET updated_at = '2000-01-01 00:00:00'");

const server = app.listen(0, '127.0.0.1');
await new Promise((resolveListen) => server.once('listening', resolveListen));
const baseUrl = `http://127.0.0.1:${server.address().port}/api`;

async function request(path, { method = 'GET', token, body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { response, data: await response.json() };
}

after(async () => {
  await new Promise((resolveClose, reject) =>
    server.close((error) => error ? reject(error) : resolveClose()),
  );
  await db.close();
  await rm(tempDir, { recursive: true, force: true });
});

test('auth, role permissions, idempotent batch sync, and monthly report', async () => {
  const login = await request('/auth/login', {
    method: 'POST',
    body: { username: 'admin-test', password: 'test-password-2026' },
  });
  assert.equal(login.response.status, 200);
  const adminToken = login.data.token;
  const backupScheduleUpdate = await request('/admin-tools/backup/schedule', {
    method: 'PUT',
    token: adminToken,
    body: {
      enabled: false,
      backup_time: '03:15',
      bot_token: '123456:example-token-for-tests',
      chat_id: '-1001234567890',
    },
  });
  assert.equal(backupScheduleUpdate.response.status, 200);
  assert.equal(backupScheduleUpdate.data.bot_configured, true);
  assert.equal(JSON.stringify(backupScheduleUpdate.data).includes('example-token'), false);
  assert.equal(JSON.stringify(backupScheduleUpdate.data).includes('-1001234567890'), false);
  const storedCredentials = (await db.query(
    'SELECT encrypted_credentials FROM scheduled_backup_settings WHERE id = 1',
  ))[0].encrypted_credentials;
  assert.equal(storedCredentials.includes('example-token'), false);
  const operatorLogin = await request('/auth/login', {
    method: 'POST',
    body: { username: 'operator-test', password: 'test-password-2026' },
  });
  const operatorToken = operatorLogin.data.token;
  assert.equal(
    (await request('/admin-tools/backup/schedule', { token: operatorToken })).response.status,
    403,
  );

  const classList = await request('/kelas', { token: adminToken });
  assert.equal(classList.response.status, 200);
  const createdClass = await request('/kelas', {
    method: 'POST',
    token: adminToken,
    body: { name: 'X AKL Uji', unit_id: classList.data.units[0].id },
  });
  assert.equal(createdClass.response.status, 201);
  const updatedClass = await request(`/kelas/${createdClass.data.id}`, {
    method: 'PUT',
    token: adminToken,
    body: { name: 'XI AKL Uji', unit_id: classList.data.units[0].id },
  });
  assert.equal(updatedClass.data.updated, true);
  const deletedClass = await request(`/kelas/${createdClass.data.id}`, {
    method: 'DELETE',
    token: adminToken,
  });
  assert.equal(deletedClass.data.deleted, true);
  assert.equal(
    (await request('/kelas', { token: operatorToken })).response.status,
    403,
  );

  const pinStatus = await request('/auth/menu-pin/status', { token: adminToken });
  assert.deepEqual(pinStatus.data, { configured: false });
  const operatorPinSetup = await request('/auth/menu-pin/setup', {
    method: 'POST',
    token: operatorToken,
    body: { pin: '4826' },
  });
  assert.equal(operatorPinSetup.response.status, 403);
  const pinSetup = await request('/auth/menu-pin/setup', {
    method: 'POST',
    token: adminToken,
    body: { pin: '4826' },
  });
  assert.equal(pinSetup.response.status, 201);
  const wrongPin = await request('/auth/menu-pin/verify', {
    method: 'POST',
    token: adminToken,
    body: { pin: '0000' },
  });
  assert.equal(wrongPin.response.status, 401);
  assert.equal(wrongPin.data.error, 'PIN salah');
  assert.equal(
    (await request('/auth/menu-pin/verify', {
      method: 'POST',
      token: operatorToken,
      body: { pin: '4826' },
    })).response.status,
    200,
  );
  assert.equal(
    (await request('/auth/menu-pin/change', {
      method: 'PUT',
      token: adminToken,
      body: { current_pin: '4826', new_pin: '5937' },
    })).response.status,
    200,
  );
  assert.equal(
    (await request('/auth/menu-pin/verify', {
      method: 'POST',
      token: adminToken,
      body: { pin: '5937' },
    })).response.status,
    200,
  );

  const participants = await request('/peserta', { token: adminToken });
  assert.equal(participants.data.participants.length, 2);
  assert.equal(participants.data.participants[0].classroom_name, 'Kelas 1');
  assert.ok(participants.data.sync_cursor);
  const operationalSettings = await request('/pengaturan', { token: adminToken });
  assert.ok(operationalSettings.data.sync_cursor);
  const unchangedSettings = await request(
    `/pengaturan?updated_since=${encodeURIComponent(operationalSettings.data.sync_cursor)}`,
    { token: adminToken },
  );
  assert.equal(unchangedSettings.data.unchanged, true);
  const forbidden = await request('/peserta', {
    method: 'POST',
    token: operatorToken,
    body: {
      participant_code: 'NOPE',
      full_name: 'Tidak Diizinkan',
      classroom_id: classroom.id,
      qr_code: 'NOPE-QR',
    },
  });
  assert.equal(forbidden.response.status, 403);
  const reportForbidden = await request('/absensi/rekap?month=11&year=2026', {
    token: operatorToken,
  });
  assert.equal(reportForbidden.response.status, 403);

  const createdParticipant = await request('/peserta', {
    method: 'POST',
    token: adminToken,
    body: {
      participant_code: 'TEST-001',
      full_name: 'Peserta Uji',
      classroom_id: classroom.id,
      qr_code: 'QR-TEST-001',
      guardian_phone: '628123450001',
    },
  });
  assert.equal(createdParticipant.response.status, 201);
  const participantDelta = await request(
    `/peserta?updated_since=${encodeURIComponent(participants.data.sync_cursor)}`,
    { token: adminToken },
  );
  assert.equal(
    participantDelta.data.participants.find(
      (item) => String(item.id) === createdParticipant.data.id,
    ).guardian_phone,
    '628123450001',
  );
  const changedSettings = await request(
    `/pengaturan?updated_since=${encodeURIComponent(operationalSettings.data.sync_cursor)}`,
    { token: adminToken },
  );
  assert.ok(changedSettings.data.settings);
  const updatedParticipant = await request(`/peserta/${createdParticipant.data.id}`, {
    method: 'PUT',
    token: adminToken,
    body: {
      participant_code: 'TEST-001',
      full_name: 'Peserta Uji Diubah',
      classroom_id: classroom.id,
      qr_code: 'QR-TEST-001',
    },
  });
  assert.equal(updatedParticipant.data.updated, true);
  const participantAfterUpdate = await request('/peserta', { token: adminToken });
  assert.equal(
    participantAfterUpdate.data.participants.find(
      (item) => String(item.id) === createdParticipant.data.id,
    ).guardian_phone,
    '628123450001',
  );
  const operatorSnapshot = await request('/peserta', { token: operatorToken });
  assert.ok(operatorSnapshot.data.participants.some(
    (item) => String(item.id) === createdParticipant.data.id,
  ));
  const transferClass = await request('/kelas', {
    method: 'POST',
    token: adminToken,
    body: { name: 'Kelas Tujuan Uji', unit_id: classList.data.units[0].id },
  });
  const movedParticipant = await request(`/peserta/${createdParticipant.data.id}`, {
    method: 'PUT',
    token: adminToken,
    body: {
      participant_code: 'TEST-001',
      full_name: 'Peserta Uji Diubah',
      classroom_id: transferClass.data.id,
      qr_code: 'QR-TEST-001',
    },
  });
  assert.equal(movedParticipant.response.status, 200);
  const operatorDelta = await request(
    `/peserta?updated_since=${encodeURIComponent(operatorSnapshot.data.sync_cursor)}`,
    { token: operatorToken },
  );
  assert.ok(operatorDelta.data.removed_ids.includes(createdParticipant.data.id));
  assert.equal(
    operatorDelta.data.participants.some(
      (item) => String(item.id) === createdParticipant.data.id,
    ),
    false,
  );
  const importedParticipants = await request('/peserta/import', {
    method: 'POST',
    token: adminToken,
    body: {
      participants: [
        {
          participant_code: 'TEST-001',
          full_name: 'Peserta Hasil Impor',
          classroom_id: classroom.id,
          qr_code: 'QR-TEST-001',
          guardian_phone: '628123450003',
        },
        {
          participant_code: 'TEST-002',
          full_name: 'Peserta Baru Impor',
          classroom_id: classroom.id,
          qr_code: 'QR-TEST-002',
        },
        {
          full_name: 'Peserta Template Excel',
          unit_name: 'Unit Contoh',
          classroom_name: 'Kelas 1',
          qr_code: 'QR-EXCEL-001',
        },
      ],
    },
  });
  assert.equal(importedParticipants.data.imported, 3);
  const deletedParticipant = await request(`/peserta/${createdParticipant.data.id}`, {
    method: 'DELETE',
    token: adminToken,
  });
  assert.equal(deletedParticipant.data.deleted, true);
  const bulkParticipant = (await request('/peserta', { token: adminToken }))
    .data.participants.find((item) => item.qr_code === 'QR-EXCEL-001');
  const bulkDeleted = await request('/peserta/bulk', {
    method: 'DELETE',
    token: adminToken,
    body: { ids: [bulkParticipant.id] },
  });
  assert.deepEqual(bulkDeleted.data, { deleted: 1 });

  const participant = participants.data.participants[0];
  const secondParticipant = participants.data.participants.find(
    (item) => item.participant_code !== participant.participant_code,
  );
  const scan = {
    id_unik: '00000000-0000-4000-8000-000000000101',
    id_peserta: participant.id,
    jenis_absen: 'masuk',
    client_timestamp: '2026-11-20T01:05:00.000Z',
    status_kehadiran: 'terlambat',
    menit_terlambat: 5,
  };
  const sync = await request('/absensi/sync-batch', {
    method: 'POST',
    token: adminToken,
    body: { records: [scan] },
  });
  assert.deepEqual(sync.data.accepted_ids, [scan.id_unik]);
  assert.deepEqual(sync.data.rejected, []);
  const queuedNotification = (await db.query(
    'SELECT * FROM attendance_notifications WHERE id_unik = ?',
    [scan.id_unik],
  ))[0];
  assert.equal(queuedNotification.recipient_phone, '628123456789');
  assert.equal(queuedNotification.event_type, 'attendance.late');
  assert.equal(queuedNotification.status, 'pending');

  const updatedSettings = await request('/pengaturan', {
    method: 'PUT',
    token: adminToken,
    body: {
      timezone: 'Asia/Jakarta',
      check_in_deadline: '08:00',
      lateness_tolerance_minutes: 5,
      check_out_start: '15:00',
      scan_welcome_message: 'Selamat datang - mohon tertib saat melakukan absensi',
      scan_success_message: 'Terima kasih, {name}. Absensi {status} sudah dicatat.',
      scan_failure_message: 'Maaf, absensi {name} gagal. {reason}.',
      enable_external_scanner: false,
    },
  });
  assert.equal(updatedSettings.response.status, 200);
  assert.equal(Number(updatedSettings.data.settings.enable_external_scanner), 0);
  assert.equal(updatedSettings.data.settings.lateness_tolerance_minutes, 5);
  assert.equal(Number(updatedSettings.data.settings.weekly_schedules[0].is_working_day), 0);
  assert.equal(Number(updatedSettings.data.settings.weekly_schedules[1].is_working_day), 1);
  assert.equal(Number(updatedSettings.data.settings.weekly_schedules[6].is_working_day), 0);
  assert.equal(
    updatedSettings.data.settings.scan_welcome_message,
    'Selamat datang - mohon tertib saat melakukan absensi',
  );

  const weeklySchedules = Array.from({ length: 7 }, (_value, weekday) => ({
    weekday,
    is_working_day: weekday >= 1 && weekday <= 5,
    check_in_deadline: '08:00',
    lateness_tolerance_minutes: 5,
    check_out_start: '15:00',
  }));
  weeklySchedules[5] = {
    weekday: 5,
    is_working_day: true,
    check_in_deadline: '08:30',
    lateness_tolerance_minutes: 0,
    check_out_start: '15:00',
  };
  const scheduleUpdate = await request('/pengaturan', {
    method: 'PUT',
    token: adminToken,
    body: {
      timezone: 'Asia/Jakarta',
      check_in_deadline: '08:00',
      lateness_tolerance_minutes: 5,
      check_out_start: '15:00',
      weekly_schedules: weeklySchedules,
      participant_overrides: [{
        participant_id: participant.id,
        weekday: 5,
        check_in_deadline: '06:45',
      }],
    },
  });
  assert.equal(scheduleUpdate.response.status, 200);
  assert.equal(scheduleUpdate.data.settings.weekly_schedules.length, 7);
  assert.equal(Number(scheduleUpdate.data.settings.weekly_schedules[0].is_working_day), 0);
  assert.equal(Number(scheduleUpdate.data.settings.weekly_schedules[6].is_working_day), 0);
  assert.equal(scheduleUpdate.data.settings.participant_overrides[0].check_in_deadline, '06:45:00');

  const holidayScans = await request('/absensi/sync-batch', {
    method: 'POST',
    token: adminToken,
    body: [
      {
        id_unik: '00000000-0000-4000-8000-000000000109',
        id_peserta: participant.id,
        jenis_absen: 'masuk',
        client_timestamp: '2026-11-29T01:00:00.000Z',
        status_kehadiran: 'hadir',
        menit_terlambat: 0,
      },
      {
        id_unik: '00000000-0000-4000-8000-000000000110',
        id_peserta: participant.id,
        jenis_absen: 'pulang',
        client_timestamp: '2026-11-29T08:10:00.000Z',
        status_kehadiran: 'pulang',
        menit_terlambat: 0,
      },
    ],
  });
  assert.deepEqual(holidayScans.data.rejected.map((item) => item.reason), [
    'non_working_day',
    'non_working_day',
  ]);
  assert.deepEqual(holidayScans.data.accepted_ids, []);

  const earlyOverrideScan = {
    id_unik: '00000000-0000-4000-8000-000000000104',
    id_peserta: participant.id,
    jenis_absen: 'masuk',
    client_timestamp: '2026-11-26T23:50:00.000Z',
    status_kehadiran: 'terlambat',
    menit_terlambat: 5,
    scan_method: 'MANUAL_INPUT',
  };
  const earlyOverrideResult = await request('/absensi/sync-batch', {
    method: 'POST',
    token: adminToken,
    body: [earlyOverrideScan],
  });
  assert.deepEqual(earlyOverrideResult.data.accepted_ids, [earlyOverrideScan.id_unik]);

  const regularScheduleScan = {
    id_unik: '00000000-0000-4000-8000-000000000105',
    id_peserta: secondParticipant.id,
    jenis_absen: 'masuk',
    client_timestamp: '2026-11-26T23:50:00.000Z',
    status_kehadiran: 'hadir',
    menit_terlambat: 0,
  };
  const regularScheduleResult = await request('/absensi/sync-batch', {
    method: 'POST',
    token: adminToken,
    body: [regularScheduleScan],
  });
  assert.deepEqual(regularScheduleResult.data.accepted_ids, [regularScheduleScan.id_unik]);

  const orderedScans = [
    {
      id_unik: '00000000-0000-4000-8000-000000000106',
      id_peserta: secondParticipant.id,
      jenis_absen: 'masuk',
      client_timestamp: '2026-11-23T01:00:00.000Z',
      status_kehadiran: 'hadir',
      menit_terlambat: 0,
      scan_method: 'MANUAL_INPUT',
    },
    {
      id_unik: '00000000-0000-4000-8000-000000000107',
      id_peserta: secondParticipant.id,
      jenis_absen: 'pulang',
      client_timestamp: '2026-11-23T08:10:00.000Z',
      status_kehadiran: 'pulang',
      menit_terlambat: 0,
      scan_method: 'SCAN_QR',
    },
  ];
  const orderedSync = await request('/absensi/sync-batch', {
    method: 'POST',
    token: adminToken,
    body: { records: orderedScans },
  });
  assert.deepEqual(orderedSync.data.accepted_ids, orderedScans.map((item) => item.id_unik));

  const checkoutWithoutCheckin = await request('/absensi/sync-batch', {
    method: 'POST',
    token: adminToken,
    body: [{
      id_unik: '00000000-0000-4000-8000-000000000108',
      id_peserta: participant.id,
      jenis_absen: 'pulang',
      client_timestamp: '2026-11-24T08:10:00.000Z',
      status_kehadiran: 'pulang',
      menit_terlambat: 0,
    }],
  });
  assert.equal(checkoutWithoutCheckin.data.rejected[0].reason, 'checkin_required');

  const retry = await request('/absensi/sync-batch', {
    method: 'POST',
    token: adminToken,
    body: [scan],
  });
  assert.deepEqual(retry.data.accepted_ids, [scan.id_unik]);
  assert.equal(
    (await db.query(
      'SELECT COUNT(*) AS count FROM attendance_notifications WHERE id_unik = ?',
      [scan.id_unik],
    ))[0].count,
    1,
  );
  assert.equal(
    (await db.query('SELECT COUNT(*) AS count FROM attendance_logs'))[0].count,
    5,
  );

  const conflict = await request('/absensi/sync-batch', {
    method: 'POST',
    token: adminToken,
    body: [{
      ...scan,
      status_kehadiran: 'hadir',
      menit_terlambat: 0,
    }],
  });
  assert.equal(conflict.data.rejected[0].reason, 'id_unik_conflict');

  const checkout = {
    id_unik: '00000000-0000-4000-8000-000000000102',
    id_peserta: participant.id,
    jenis_absen: 'pulang',
    client_timestamp: '2026-11-20T08:10:00.000Z',
    status_kehadiran: 'pulang',
    menit_terlambat: 0,
  };
  const checkoutResult = await request('/absensi/sync-batch', {
    method: 'POST',
    token: adminToken,
    body: [checkout],
  });
  assert.deepEqual(checkoutResult.data.accepted_ids, [checkout.id_unik]);

  const withinTolerance = await request('/absensi/sync-batch', {
    method: 'POST',
    token: adminToken,
    body: [{
      id_unik: '00000000-0000-4000-8000-000000000103',
      id_peserta: secondParticipant.id,
      jenis_absen: 'masuk',
      client_timestamp: '2026-11-20T01:05:00.000Z',
      status_kehadiran: 'hadir',
      menit_terlambat: 0,
    }],
  });
  assert.deepEqual(withinTolerance.data.accepted_ids, [
    '00000000-0000-4000-8000-000000000103',
  ]);

  const report = await request('/absensi/rekap?month=11&year=2026', {
    token: adminToken,
  });
  const extendedRangeReport = await request(
    '/absensi/rekap?start_date=2026-10-20&end_date=2026-12-05',
    { token: adminToken },
  );
  assert.equal(extendedRangeReport.response.status, 200);
  assert.equal(report.data.summary.terlambat, 2);
  assert.equal(report.data.summary.total_menit_terlambat, 10);
  assert.equal(report.data.summary.pulang, 2);
  assert.equal(report.data.summary.hadir_tepat_waktu, 3);
  const row = report.data.rows.find(
    (item) =>
      item.participant_id === String(participant.id) &&
      item.attendance_date === '2026-11-20',
  );
  assert.equal(row.status_kehadiran, 'terlambat');
  assert.ok(row.masuk_at);
  assert.ok(row.pulang_at);
  const manualRow = report.data.rows.find(
    (item) =>
      item.participant_id === String(participant.id) &&
      item.attendance_date === '2026-11-27',
  );
  assert.equal(manualRow.scan_method, 'MANUAL_INPUT');
  const orderedRow = report.data.rows.find(
    (item) =>
      item.participant_id === String(secondParticipant.id) &&
    item.attendance_date === '2026-11-23',
  );
  assert.equal(orderedRow.scan_method, 'MANUAL_INPUT');
  assert.equal(orderedRow.checkout_scan_method, 'SCAN_QR');
  assert.equal(
    report.data.rows.some((item) => item.attendance_date === '2026-11-29'),
    false,
  );
  assert.ok(report.data.holiday_dates.includes('2026-11-29'));

  assert.equal(
    (await request('/admin-tools/activity-logs', { token: operatorToken })).response.status,
    403,
  );
  assert.equal(
    (await request('/admin-tools/backup', { token: operatorToken })).response.status,
    403,
  );
  const activityLog = await request('/admin-tools/activity-logs?page_size=100', {
    token: adminToken,
  });
  assert.equal(activityLog.response.status, 200);
  assert.ok(activityLog.data.logs.some((item) =>
    item.action === 'operational_settings.updated' &&
    item.actor_username === 'admin-test' &&
    item.before_data?.check_in_deadline,
  ));
  assert.ok(activityLog.data.logs.some((item) =>
    item.action === 'attendance.recorded' &&
    item.entity_id === scan.id_unik,
  ));
  const operatorChange = await request('/pengaturan', {
    method: 'PUT',
    token: operatorToken,
    body: {
      timezone: 'Asia/Jakarta',
      check_in_deadline: '09:00',
      lateness_tolerance_minutes: 0,
      check_out_start: '15:00',
    },
  });
  assert.equal(operatorChange.response.status, 403);

  const backupResponse = await request('/admin-tools/backup', { token: adminToken });
  assert.equal(backupResponse.response.status, 200);
  assert.equal(backupResponse.data.format, 'ruang-hadir-backup');
  assert.equal(backupResponse.data.version, 1);
  assert.equal(
    backupResponse.data.tables.attendance_logs.length,
    (await db.query('SELECT COUNT(*) AS count FROM attendance_logs'))[0].count,
  );
  assert.ok(backupResponse.data.tables.activity_logs.length > 0);
  const malformedRestore = await request('/admin-tools/backup/restore', {
    method: 'POST',
    token: adminToken,
    body: { format: 'not-a-backup' },
  });
  assert.equal(malformedRestore.response.status, 400);
  const restore = await request('/admin-tools/backup/restore', {
    method: 'POST',
    token: adminToken,
    body: backupResponse.data,
  });
  assert.equal(restore.response.status, 200);
  assert.equal(restore.data.restored, true);
  assert.equal(
    (await db.query('SELECT COUNT(*) AS count FROM attendance_logs'))[0].count,
    backupResponse.data.tables.attendance_logs.length,
  );
  assert.ok((await db.query(
    "SELECT id FROM activity_logs WHERE action = 'database.backup.restored'",
  )).length);
  assert.ok((await db.query(
    "SELECT id FROM activity_logs WHERE action = 'database.backup.exported'",
  )).length);

  for (let attempt = 0; attempt < 35; attempt += 1) {
    const statusResult = await request('/auth/menu-pin/status', { token: adminToken });
    assert.equal(statusResult.response.status, 200);
  }
  const validPinAfterStatusChecks = await request('/auth/menu-pin/verify', {
    method: 'POST',
    token: adminToken,
    body: { pin: '5937' },
  });
  assert.equal(validPinAfterStatusChecks.response.status, 200);

  for (let attempt = 0; attempt < 9; attempt += 1) {
    const anotherWrongPin = await request('/auth/menu-pin/verify', {
      method: 'POST',
      token: adminToken,
      body: { pin: '0000' },
    });
    assert.equal(anotherWrongPin.response.status, 401);
    assert.equal(anotherWrongPin.data.error, 'PIN salah');
  }
  const rateLimitedPin = await request('/auth/menu-pin/verify', {
    method: 'POST',
    token: adminToken,
    body: { pin: '0000' },
  });
  assert.equal(rateLimitedPin.response.status, 429);
  assert.match(rateLimitedPin.data.error, /Terlalu banyak percobaan PIN/);

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const invalidLogin = await request('/auth/login', {
      method: 'POST',
      body: { username: 'unknown-user', password: 'wrong-password' },
    });
    assert.equal(invalidLogin.response.status, 401);
  }
  const rateLimitedLogin = await request('/auth/login', {
    method: 'POST',
    body: { username: 'unknown-user', password: 'wrong-password' },
  });
  assert.equal(rateLimitedLogin.response.status, 429);
  assert.match(rateLimitedLogin.data.error, /Terlalu banyak percobaan masuk/);
  const loginAudit = await db.query(
    `SELECT action, after_data FROM activity_logs
      WHERE action IN ('auth.login.succeeded', 'auth.login.failed')`,
  );
  assert.ok(loginAudit.some((row) => row.action === 'auth.login.succeeded'));
  assert.ok(loginAudit.some((row) => row.action === 'auth.login.failed'));
  assert.equal(JSON.stringify(loginAudit).includes('test-password-2026'), false);

  const enableSchedule = await request('/admin-tools/backup/schedule', {
    method: 'PUT',
    token: adminToken,
    body: { enabled: true, backup_time: '00:00' },
  });
  assert.equal(enableSchedule.response.status, 200);
  const originalFetch = globalThis.fetch;
  let telegramRequest;
  globalThis.fetch = async (url, options) => {
    telegramRequest = { url: String(url), body: JSON.parse(options.body) };
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    assert.equal(await runScheduledBackup(), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
  const backupDirectory = join(tempDir, 'private-backups');
  const backupFiles = await readdir(backupDirectory);
  assert.equal(backupFiles.length, 1);
  const encryptedBackup = await readFile(join(backupDirectory, backupFiles[0]), 'utf8');
  assert.equal(encryptedBackup.includes('test-password-2026'), false);
  assert.equal(encryptedBackup.includes('Unit Contoh'), false);
  assert.match(encryptedBackup, /"algorithm":"aes-256-gcm"/);
  assert.match(telegramRequest.url, /^https:\/\/api\.telegram\.org\/bot/);
  assert.match(telegramRequest.body.text, /tidak dikirim melalui Telegram/);
  assert.equal('document' in telegramRequest.body, false);
  const encryptedDownload = await fetch(`${baseUrl}/admin-tools/backup/scheduled/latest`, {
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(encryptedDownload.status, 200);
  assert.equal(await encryptedDownload.text(), encryptedBackup);
  const decryptedPath = join(tempDir, 'recovered-backup.json');
  await execFileAsync(process.execPath, [
    join(process.cwd(), 'scripts', 'decrypt-scheduled-backup.js'),
    join(backupDirectory, backupFiles[0]),
    decryptedPath,
  ]);
  const recoveredBackup = JSON.parse(await readFile(decryptedPath, 'utf8'));
  assert.equal(recoveredBackup.format, 'ruang-hadir-backup');
  assert.ok(recoveredBackup.tables.users.length > 0);
  const backupStatus = await request('/admin-tools/backup/schedule', { token: adminToken });
  assert.equal(backupStatus.data.last_status, 'success');
});
