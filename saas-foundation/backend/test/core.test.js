import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calculateAttendance, createQueuedScan } from '../src/core/attendance.js';
import { aggregateAttendanceReport } from '../src/core/attendance-report.js';
import {
  calculateAttendance as calculateBrowserAttendance,
  createQueuedScan as createBrowserQueuedScan,
} from '../../web/school-portal/src/core/attendance.js';
import {
  assertValidSchoolCode,
  generateUniqueSchoolCode,
  isValidSchoolCode,
} from '../src/core/school-code.js';
import {
  assertTenantPermission,
  hasTenantPermission,
} from '../src/core/permissions.js';
import { createOfflineSyncManager } from '../src/core/offline-sync.js';

test('school codes keep leading zeroes, validate manual changes, and retry collisions', async () => {
  assert.equal(isValidSchoolCode('0042'), true);
  assert.equal(isValidSchoolCode('42'), false);
  assert.throws(() => assertValidSchoolCode('1A42'), /tepat 4 digit/);

  const candidates = ['0042', '0042', '7310'];
  const code = await generateUniqueSchoolCode({
    isTaken: async (candidate) => candidate === '0042',
    nextCode: () => candidates.shift(),
  });
  assert.equal(code, '7310');
});

test('school code generator fails explicitly if all allowed codes collide', async () => {
  await assert.rejects(
    generateUniqueSchoolCode({
      isTaken: async () => true,
      maxAttempts: 2,
      nextCode: () => '4829',
    }),
    /Tidak tersedia kode sekolah unik/,
  );
});

test('permissions are resolved only for the authenticated tenant role', () => {
  const principal = {
    sekolah_id: '10',
    role_sekolah_id: 10,
    permissions: ['scanner.use', 'attendance.read'],
  };
  assert.equal(
    hasTenantPermission({
      principal,
      requestedSchoolId: 10,
      permission: 'attendance.read',
    }),
    true,
  );
  assert.equal(
    hasTenantPermission({
      principal,
      requestedSchoolId: 11,
      permission: 'attendance.read',
    }),
    false,
  );
  assert.throws(
    () => assertTenantPermission({
      principal,
      requestedSchoolId: 10,
      permission: 'school.roles.manage',
    }),
    { statusCode: 403 },
  );
});

const settings = {
  timezone: 'Asia/Jakarta',
  check_in_deadline: '08:00:00',
  lateness_tolerance_minutes: 5,
  check_out_start: '15:00:00',
};

test('attendance calculation uses tenant timezone and tolerance', () => {
  const onTime = calculateAttendance({
    eventType: 'check_in',
    clientTimestamp: '2026-11-23T01:02:00.000Z',
    participantId: 'p1',
    settings,
  });
  assert.deepEqual(onTime, {
    date: '2026-11-23',
    status: 'hadir',
    lateMinutes: 0,
  });

  const late = calculateAttendance({
    eventType: 'check_in',
    clientTimestamp: '2026-11-23T01:15:00.000Z',
    participantId: 'p1',
    settings,
  });
  assert.equal(late.status, 'terlambat');
  assert.equal(late.lateMinutes, 10);
});

test('attendance calculation uses a participant-specific entry deadline for its weekday', () => {
  const participantOverrideSettings = {
    ...settings,
    participant_overrides: [
      { participant_id: 'p1', weekday: 1, check_in_deadline: '07:00:00' },
    ],
  };
  const participantLate = calculateAttendance({
    eventType: 'check_in',
    clientTimestamp: '2026-11-23T00:06:00.000Z',
    participantId: 'p1',
    settings: participantOverrideSettings,
  });
  const regularSchedule = calculateAttendance({
    eventType: 'check_in',
    clientTimestamp: '2026-11-23T00:06:00.000Z',
    participantId: 'p2',
    settings: participantOverrideSettings,
  });
  const offlineParticipantResult = calculateBrowserAttendance({
    eventType: 'check_in',
    clientTimestamp: '2026-11-23T00:06:00.000Z',
    participantId: 'p1',
    settings: participantOverrideSettings,
  });

  assert.equal(participantLate.status, 'terlambat');
  assert.equal(participantLate.lateMinutes, 1);
  assert.equal(regularSchedule.status, 'hadir');
  assert.deepEqual(offlineParticipantResult, participantLate);
});

test('attendance calculation respects non-working days and checkout start', () => {
  const holiday = calculateAttendance({
    eventType: 'check_in',
    clientTimestamp: '2026-11-22T01:00:00.000Z',
    participantId: 'p1',
    settings,
  });
  assert.equal(holiday.reason, 'non_working_day');

  const earlyCheckout = calculateAttendance({
    eventType: 'check_out',
    clientTimestamp: '2026-11-23T07:59:00.000Z',
    participantId: 'p1',
    settings,
  });
  assert.equal(earlyCheckout.reason, 'checkout_too_early');
});

test('attendance report groups check-in and check-out into a participant day', () => {
  const rows = aggregateAttendanceReport([
    {
      attendance_date: '2026-11-23',
      participant_id: 'p1',
      participant_code: 'P1',
      participant_name: 'Peserta Satu',
      classroom_name: 'Kelas 1',
      event_type: 'check_out',
      client_timestamp_utc: '2026-11-23 08:00:00',
      attendance_status: 'pulang',
      late_minutes: 0,
    },
    {
      attendance_date: '2026-11-23',
      participant_id: 'p1',
      participant_code: 'P1',
      participant_name: 'Peserta Satu',
      classroom_name: 'Kelas 1',
      event_type: 'check_in',
      client_timestamp_utc: '2026-11-23 01:10:00',
      attendance_status: 'terlambat',
      late_minutes: 10,
    },
  ]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].check_in_at, '2026-11-23 01:10:00');
  assert.equal(rows[0].check_out_at, '2026-11-23 08:00:00');
  assert.equal(rows[0].attendance_status, 'terlambat');
  assert.equal(rows[0].late_minutes, 10);
});

const scan = (id, sekolah_id = '10') => ({
  id_unik: id,
  sekolah_id,
  id_peserta: 'p1',
  id_perangkat: 'device1',
  jenis_absen: 'check_in',
  attendance_date: '2026-11-23',
  client_timestamp: '2026-11-23T01:15:00.000Z',
  status_kehadiran: 'terlambat',
  menit_terlambat: 10,
  status_sync: 'pending',
});

test('queued scan model preserves idempotency key and original client timestamp', () => {
  const record = createQueuedScan({
    sekolah_id: 10,
    id_peserta: 'p1',
    id_perangkat: 'device1',
    jenis_absen: 'check_in',
    client_timestamp: '2026-11-23T01:15:00.000Z',
    id_unik: '5a2c6ec7-33cb-4a2d-b205-7a2be89146e2',
    calculation: {
      date: '2026-11-23',
      status: 'terlambat',
      lateMinutes: 10,
    },
  });

  assert.equal(record.sekolah_id, '10');
  assert.equal(record.client_timestamp, '2026-11-23T01:15:00.000Z');
  assert.equal(record.status_sync, 'pending');
  assert.equal(record.menit_terlambat, 10);
  assert.equal(record.scan_method, 'SCAN_QR');
  assert.throws(
    () => createQueuedScan({
      sekolah_id: 10,
      id_peserta: 'p1',
      jenis_absen: 'check_in',
      id_unik: '5a2c6ec7-33cb-4a2d-b205-7a2be89146e2',
      calculation: { date: '2026-11-23', status: 'terlambat', lateMinutes: 0 },
    }),
    /Status absensi tidak sesuai/,
  );
});

test('browser queued scans preserve manual attendance origin', () => {
  const record = createBrowserQueuedScan({
    sekolah_id: 10,
    id_peserta: 'p1',
    jenis_absen: 'check_in',
    scan_method: 'MANUAL_INPUT',
    id_unik: '5a2c6ec7-33cb-4a2d-b205-7a2be89146e2',
    calculation: { date: '2026-11-23', status: 'hadir', lateMinutes: 0 },
  });
  assert.equal(record.scan_method, 'MANUAL_INPUT');
});

test('batch sync marks only server-accepted ids and keeps rejected records pending', async () => {
  const pending = new Map();
  const marked = [];
  const manager = createOfflineSyncManager({
    schoolId: '10',
    storage: {
      async putPendingIfAbsent({ scan: item }) {
        if (pending.has(item.id_unik)) return false;
        pending.set(item.id_unik, item);
        return true;
      },
      async listPending({ sekolah_id, limit }) {
        assert.equal(sekolah_id, '10');
        return [...pending.values()].slice(0, limit);
      },
      async markSynced({ sekolah_id, ids }) {
        assert.equal(sekolah_id, '10');
        for (const id of ids) {
          marked.push(id);
          pending.delete(id);
        }
      },
    },
    async sendBatch({ sekolah_id, records }) {
      assert.equal(sekolah_id, '10');
      assert.equal(records.length, 2);
      return { accepted_ids: [records[0].id_unik] };
    },
    batchSize: 2,
  });
  const acceptedId = '5a2c6ec7-33cb-4a2d-b205-7a2be89146e2';
  const rejectedId = 'afc7eaac-ce5c-4111-806f-598cba5a9199';
  await manager.enqueue(scan(acceptedId));
  await manager.enqueue(scan(rejectedId));

  const result = await manager.syncPending();
  assert.deepEqual(result.accepted_ids, [acceptedId]);
  assert.deepEqual(result.rejected_ids, [rejectedId]);
  assert.deepEqual(marked, [acceptedId]);
  assert.deepEqual([...pending.keys()], [rejectedId]);
});

test('offline queue rejects scans from another tenant', async () => {
  const manager = createOfflineSyncManager({
    schoolId: '10',
    storage: {
      async putPendingIfAbsent() {
        assert.fail('Out-of-tenant scan must not reach storage.');
      },
      async listPending() {
        return [];
      },
      async markSynced() {},
    },
    async sendBatch() {
      return { accepted_ids: [] };
    },
  });
  await assert.rejects(
    manager.enqueue(scan('5a2c6ec7-33cb-4a2d-b205-7a2be89146e2', '11')),
    /tidak termasuk sekolah/,
  );
});
