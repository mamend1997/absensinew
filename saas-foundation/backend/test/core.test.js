import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calculateAttendance, createQueuedScan } from '../src/core/attendance.js';
import { aggregateAttendanceReport } from '../src/core/attendance-report.js';
import {
  calculateAttendance as calculateBrowserAttendance,
  attendanceEventTypeForMode,
  createQueuedScan as createBrowserQueuedScan,
  mergeDailyAttendanceState,
  remainingScanCooldownMs,
  shouldApplyAttendanceCooldown,
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
import {
  createOfflineSyncManager as createBrowserOfflineSyncManager,
  isNetworkUnavailableError,
  NetworkUnavailableError,
} from '../../web/school-portal/src/core/offline-sync.js';
import { extractSchoolAccessToken } from '../../web/school-portal/src/core/auth-session.js';
import {
  cameraRotationForScreen,
  cameraRotationFromOrientation,
  normalizeCameraRotation,
  rotateCameraByQuarterTurn,
} from '../../web/school-portal/src/core/camera-orientation.js';
import { getDefaultPage } from '../../web/school-portal/src/core/navigation.js';

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

test('attendance calculation respects non-working days and records checkout after the scan cooldown', () => {
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
  assert.deepEqual(earlyCheckout, {
    date: '2026-11-23',
    status: 'pulang',
    lateMinutes: 0,
  });
  assert.deepEqual(calculateBrowserAttendance({
    eventType: 'check_out',
    clientTimestamp: '2026-11-23T07:59:00.000Z',
    participantId: 'p1',
    settings,
  }), earlyCheckout);

  const permissionOut = calculateAttendance({
    eventType: 'permission_out',
    clientTimestamp: '2026-11-23T07:59:00.000Z',
    participantId: 'p1',
    settings,
  });
  assert.deepEqual(permissionOut, {
    date: '2026-11-23',
    status: 'izin_keluar',
    lateMinutes: 0,
  });
  assert.equal(calculateBrowserAttendance({
    eventType: 'permission_in',
    clientTimestamp: '2026-11-23T08:30:00.000Z',
    participantId: 'p1',
    settings,
  }).status, 'izin_masuk');
});

test('scan cooldown blocks scans until the configured interval has elapsed', () => {
  const lastScanAt = '2026-11-23T01:00:00.000Z';
  assert.equal(remainingScanCooldownMs(lastScanAt, Date.parse('2026-11-23T01:04:59.000Z'), 5), 1000);
  assert.equal(remainingScanCooldownMs(lastScanAt, Date.parse('2026-11-23T01:05:00.000Z'), 5), 0);
  assert.equal(remainingScanCooldownMs(null, Date.parse('2026-11-23T01:00:00.000Z'), 5), 0);
  assert.throws(() => remainingScanCooldownMs(lastScanAt, Date.now(), 0), /1 dan 60 menit/);
});

test('scanner session mode selects check-in, check-out, or automatic attendance', () => {
  assert.equal(attendanceEventTypeForMode('auto', false), 'check_in');
  assert.equal(attendanceEventTypeForMode('auto', true), 'check_out');
  assert.equal(attendanceEventTypeForMode('check_in', true), 'check_in');
  assert.equal(attendanceEventTypeForMode('check_out', false), 'check_out');
  assert.equal(attendanceEventTypeForMode('permission_out', false), 'permission_out');
  assert.equal(attendanceEventTypeForMode('permission_in', false), 'permission_in');
  assert.throws(() => attendanceEventTypeForMode('unknown', false), /Mode sesi/);
  assert.equal(shouldApplyAttendanceCooldown('check_in'), true);
  assert.equal(shouldApplyAttendanceCooldown('check_out'), true);
  assert.equal(shouldApplyAttendanceCooldown('permission_out'), false);
  assert.equal(shouldApplyAttendanceCooldown('permission_in'), false);
});

test('local attendance state advances cooldown and retains check-in after repeated check-outs', () => {
  const checkIn = {
    id_peserta: 'p1',
    attendance_date: '2026-11-23',
    jenis_absen: 'check_in',
    client_timestamp: '2026-11-23T01:00:00.000Z',
  };
  const checkout = {
    ...checkIn,
    jenis_absen: 'check_out',
    client_timestamp: '2026-11-23T01:05:00.000Z',
  };
  const repeatedCheckout = {
    ...checkout,
    client_timestamp: '2026-11-23T01:10:00.000Z',
  };
  const stateAfterCheckIn = mergeDailyAttendanceState(null, checkIn);
  const stateAfterCheckout = mergeDailyAttendanceState(stateAfterCheckIn, checkout);
  const stateAfterRepeatedCheckout = mergeDailyAttendanceState(stateAfterCheckout, repeatedCheckout);
  assert.equal(stateAfterRepeatedCheckout.check_in, true);
  assert.equal(stateAfterRepeatedCheckout.check_out, true);
  assert.equal(stateAfterRepeatedCheckout.last_scan_at, repeatedCheckout.client_timestamp);
  assert.equal(stateAfterRepeatedCheckout.last_scan_type, 'check_out');
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
      event_type: 'check_out',
      client_timestamp_utc: '2026-11-23 08:05:00',
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
  assert.equal(rows[0].check_out_at, '2026-11-23 08:05:00');
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

test('browser sync removes scans rejected by the server cooldown', async () => {
  const pending = new Map();
  const ignored = [];
  const id = '5a2c6ec7-33cb-4a2d-b205-7a2be89146e2';
  const manager = createBrowserOfflineSyncManager({
    schoolId: '10',
    storage: {
      async putPendingIfAbsent({ scan: item }) {
        pending.set(item.id_unik, item);
        return true;
      },
      async listPending() {
        return [...pending.values()];
      },
      async markSynced() {},
      async markIgnored({ ids }) {
        ignored.push(...ids);
        for (const scanId of ids) pending.delete(scanId);
      },
    },
    async sendBatch() {
      return {
        accepted_ids: [],
        ignored_ids: [id],
        ignored: [{ id_unik: id, reason: 'missing_check_in' }],
      };
    },
  });
  await manager.enqueue(scan(id));
  const result = await manager.syncPending();
  assert.deepEqual(result.ignored_ids, [id]);
  assert.deepEqual(result.ignored_details, [{ id_unik: id, reason: 'missing_check_in' }]);
  assert.deepEqual(result.rejected_ids, []);
  assert.deepEqual(ignored, [id]);
  assert.equal(pending.size, 0);
});

test('offline scanner recognizes browser fetch failures without hiding API errors', () => {
  assert.equal(isNetworkUnavailableError(new TypeError('Failed to fetch')), true);
  assert.equal(isNetworkUnavailableError(new TypeError('Load failed')), true);
  assert.equal(isNetworkUnavailableError(new NetworkUnavailableError()), true);
  assert.doesNotMatch(new NetworkUnavailableError().message, /failed to fetch/i);
  assert.equal(isNetworkUnavailableError(new Error('Unauthorized')), false);
  assert.equal(isNetworkUnavailableError(new TypeError('Invalid URL')), false);
});

test('default route opens scanner for scanner users, including offline-capable sessions', () => {
  assert.equal(getDefaultPage({
    subscriptionExpired: false,
    billingReturn: false,
    canScan: true,
  }), 'scanner');
  assert.equal(getDefaultPage({
    subscriptionExpired: false,
    billingReturn: false,
    canScan: false,
  }), 'dashboard');
  assert.equal(getDefaultPage({
    subscriptionExpired: true,
    billingReturn: false,
    canScan: true,
  }), 'billing');
});

test('school login accepts supported token response keys and rejects malformed tokens', () => {
  assert.equal(extractSchoolAccessToken({ access_token: ' bearer-token ' }), 'bearer-token');
  assert.equal(extractSchoolAccessToken({ data: { access_token: ' wrapped-token ' } }), 'wrapped-token');
  assert.equal(extractSchoolAccessToken({ result: { session: { accessToken: ' camel-token ' } } }), 'camel-token');
  assert.equal(extractSchoolAccessToken({ token: 'legacy-token' }), 'legacy-token');
  assert.equal(extractSchoolAccessToken({ access_token: '', token: 'fallback-token' }), 'fallback-token');
  assert.equal(extractSchoolAccessToken({ token: 123 }), '');
  assert.equal(extractSchoolAccessToken(null), '');
});

test('camera rotation follows physical device orientation while keeping the nearest stable angle', () => {
  assert.equal(cameraRotationFromOrientation(90, 0), 0);
  assert.equal(cameraRotationFromOrientation(0, -90), -90);
  assert.equal(cameraRotationFromOrientation(0, 90), 90);
  assert.equal(cameraRotationFromOrientation(-90, 0), -180);
  assert.equal(cameraRotationFromOrientation(45, 45, 0), 0);
  assert.equal(cameraRotationFromOrientation(null, null, 90), 90);
  assert.equal(cameraRotationForScreen(0, 90, 0, 0), 90);
  assert.equal(cameraRotationForScreen(0, 90, 90, 0), 0);
  assert.deepEqual([0, 90, 180, -90].map(rotateCameraByQuarterTurn), [90, -180, -90, 0]);
  assert.equal(normalizeCameraRotation(270), -90);
  assert.equal(normalizeCameraRotation(Number.NaN), 0);
});
