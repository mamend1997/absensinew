import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';

process.env.JWT_SECRET ??= randomBytes(48).toString('base64url');
const {
  createLateAttendanceMessage,
  shouldQueueLateAttendanceNotification,
} = await import('../src/core/late-attendance-notifications.js');

test('only late check-ins with a participant phone are queued', () => {
  assert.equal(shouldQueueLateAttendanceNotification({
    eventType: 'check_in',
    status: 'terlambat',
    participantPhone: '+628123456789',
  }), true);
  assert.equal(shouldQueueLateAttendanceNotification({
    eventType: 'check_in',
    status: 'hadir',
    participantPhone: '+628123456789',
  }), false);
  assert.equal(shouldQueueLateAttendanceNotification({
    eventType: 'check_out',
    status: 'pulang',
    participantPhone: '+628123456789',
  }), false);
  assert.equal(shouldQueueLateAttendanceNotification({
    eventType: 'check_in',
    status: 'terlambat',
    participantPhone: null,
  }), false);
});

test('late attendance message uses the school timezone and lateness calculation', () => {
  assert.equal(
    createLateAttendanceMessage({
      participantName: 'Ayu',
      attendanceDate: '2026-11-21',
      clientTimestamp: '2026-11-21T02:05:00.000Z',
      timeZone: 'Asia/Jakarta',
      lateMinutes: 5,
    }),
    'Pemberitahuan absensi: Ayu tercatat terlambat masuk pada 2026-11-21 pukul 09:05 (5 menit terlambat).',
  );
});
