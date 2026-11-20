import { db } from '../config/database.js';
import { localDateTimeParts, toSqlUtc } from '../utils/time.js';

export function calculateAttendance({
  eventType,
  clientTimestamp,
  participantId,
  settings,
}) {
  const { date, seconds } = localDateTimeParts(
    clientTimestamp,
    settings.timezone,
  );
  const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  const dailySchedule = settings.weekly_schedules?.find(
    (schedule) => Number(schedule.weekday) === weekday,
  );
  const isWorkingDay = dailySchedule?.is_working_day == null
    ? weekday >= 1 && weekday <= 5
    : Boolean(Number(dailySchedule.is_working_day));
  if (!isWorkingDay) {
    return { date, status: null, lateMinutes: 0, reason: 'non_working_day' };
  }

  if (eventType === 'check_out') {
    const [hour, minute, second] = (dailySchedule?.check_out_start ?? settings.check_out_start)
      .split(':')
      .map(Number);
    if (seconds < hour * 3600 + minute * 60 + second) {
      return { date, status: null, lateMinutes: 0, reason: 'checkout_too_early' };
    }
    return { date, status: 'pulang', lateMinutes: 0 };
  }

  const participantOverride = settings.participant_overrides?.find(
    (rule) =>
      String(rule.participant_id) === String(participantId) &&
      Number(rule.weekday) === weekday,
  );
  const [hour, minute, second] = (
    participantOverride?.check_in_deadline ??
    dailySchedule?.check_in_deadline ??
    settings.check_in_deadline
  )
    .split(':')
    .map(Number);
  const threshold =
    hour * 3600 +
    minute * 60 +
    second +
    Number(
      dailySchedule?.lateness_tolerance_minutes ??
      settings.lateness_tolerance_minutes,
    ) * 60;
  if (seconds <= threshold) {
    return { date, status: 'hadir', lateMinutes: 0 };
  }

  return {
    date,
    status: 'terlambat',
    lateMinutes: Math.ceil((seconds - threshold) / 60),
  };
}

function canonicalStoredTimestamp(value) {
  if (value instanceof Date) return value.toISOString();
  return new Date(`${String(value).replace(' ', 'T')}Z`).toISOString();
}

export async function checkExistingAttendanceRecord({
  transaction,
  user,
  record,
}) {
  const rows = await transaction.query(
    `SELECT a.participant_id, a.event_type, a.client_timestamp,
            a.attendance_status, a.late_minutes, a.scan_method, p.classroom_id
     FROM attendance_logs a
     JOIN participants p ON p.id = a.participant_id
     WHERE a.id_unik = ?`,
    [record.id_unik],
  );
  const existing = rows[0];
  if (!existing) return null;

  if (
    user.role === 'operator' &&
    String(existing.classroom_id) !== user.classroomId
  ) {
    return { accepted: false, reason: 'classroom_forbidden' };
  }
  const identical =
    String(existing.participant_id) === String(record.id_peserta) &&
    existing.event_type === (record.jenis_absen === 'masuk' ? 'check_in' : 'check_out') &&
    canonicalStoredTimestamp(existing.client_timestamp) ===
      record.clientTimestamp.toISOString() &&
    existing.attendance_status === record.status_kehadiran &&
    Number(existing.late_minutes) === record.menit_terlambat &&
    (existing.scan_method ?? 'SCAN_QR') === (record.scan_method ?? 'SCAN_QR');
  return identical
    ? { accepted: true, duplicate: true }
    : { accepted: false, reason: 'id_unik_conflict' };
}

export async function insertAttendanceRecord({
  transaction,
  user,
  participant,
  record,
  computed,
}) {
  const eventType = record.jenis_absen === 'masuk' ? 'check_in' : 'check_out';
  const timestampSql = toSqlUtc(record.clientTimestamp);
  try {
    await transaction.query(
      `INSERT INTO attendance_logs (
        id_unik, participant_id, participant_code_snapshot,
        participant_name_snapshot, classroom_name_snapshot, attendance_date,
        event_type, client_timestamp, attendance_status, late_minutes,
        scan_method, recorded_by, synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [
        record.id_unik,
        participant.id,
        participant.participant_code,
        participant.full_name,
        participant.classroom_name,
        computed.date,
        eventType,
        timestampSql,
        computed.status,
        computed.lateMinutes,
        record.scan_method ?? 'SCAN_QR',
        user.id,
      ],
    );
    return { accepted: true, duplicate: false };
  } catch (error) {
    if (
      error.code === 'ER_DUP_ENTRY' ||
      error.errcode === 2067 ||
      error.errcode === 1555
    ) {
      const duplicate = await checkExistingAttendanceRecord({
        transaction,
        user,
        record,
      });
      if (duplicate) return duplicate;
      return { accepted: false, reason: 'attendance_already_exists' };
    }
    throw error;
  }
}

export async function getOperationalSettings() {
  const rows = await db.query('SELECT * FROM operational_settings WHERE id = 1');
  if (!rows[0]) return null;
  const [weeklySchedules, participantOverrides] = await Promise.all([
    db.query(
      `SELECT weekday, is_working_day, check_in_deadline,
              lateness_tolerance_minutes, check_out_start
       FROM weekly_operational_schedules`,
    ),
    db.query(
      `SELECT participant_id, weekday, check_in_deadline
       FROM participant_day_overrides`,
    ),
  ]);
  return {
    ...rows[0],
    weekly_schedules: weeklySchedules,
    participant_overrides: participantOverrides,
  };
}
