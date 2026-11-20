import { Router } from 'express';
import { z } from 'zod';
import { db } from '../config/database.js';
import { allowRoles, authenticate } from '../middleware/auth.js';
import {
  calculateAttendance,
  checkExistingAttendanceRecord,
  getOperationalSettings,
  insertAttendanceRecord,
} from '../services/attendance-service.js';
import { asyncHandler } from '../utils/async-handler.js';
import { HttpError } from '../utils/http-error.js';
import { addCalendarDays } from '../utils/time.js';

const router = Router();
router.use(authenticate);

const syncRecordSchema = z.object({
  id_unik: z.string().uuid(),
  id_peserta: z.coerce.number().int().positive(),
  jenis_absen: z.enum(['masuk', 'pulang']),
  client_timestamp: z.string().datetime({ offset: true }),
  status_kehadiran: z.enum(['hadir', 'terlambat', 'pulang']),
  menit_terlambat: z.coerce.number().int().min(0).max(65535),
  scan_method: z.enum(['SCAN_QR', 'MANUAL_INPUT']).optional(),
});

router.post('/sync-batch', asyncHandler(async (request, response) => {
  const inputRows = Array.isArray(request.body)
    ? request.body
    : request.body?.records;
  const records = z.array(syncRecordSchema).min(1).max(100).parse(inputRows);
  const settings = await getOperationalSettings();
  if (!settings) throw new HttpError(500, 'Pengaturan operasional belum diinisialisasi');

  const acceptedIds = [];
  const rejected = [];
  await db.transaction(async (transaction) => {
    for (const input of records) {
      const clientTimestamp = new Date(input.client_timestamp);
      const record = {
        ...input,
        scan_method: input.scan_method ?? 'SCAN_QR',
        clientTimestamp,
      };
      const existing = await checkExistingAttendanceRecord({
        transaction,
        user: request.user,
        record,
      });
      if (existing) {
        if (existing.accepted) acceptedIds.push(input.id_unik);
        else rejected.push({ id_unik: input.id_unik, reason: existing.reason });
        continue;
      }

      const participants = await transaction.query(
        `SELECT p.id, p.participant_code, p.full_name, p.classroom_id,
                c.name AS classroom_name
         FROM participants p JOIN classrooms c ON c.id = p.classroom_id
         WHERE p.id = ? AND p.is_active = 1`,
        [input.id_peserta],
      );
      const participant = participants[0];
      if (!participant) {
        rejected.push({ id_unik: input.id_unik, reason: 'participant_not_found' });
        continue;
      }
      if (
        request.user.role === 'operator' &&
        String(participant.classroom_id) !== request.user.classroomId
      ) {
        rejected.push({ id_unik: input.id_unik, reason: 'classroom_forbidden' });
        continue;
      }

      const eventType = input.jenis_absen === 'masuk' ? 'check_in' : 'check_out';
      const computed = calculateAttendance({
        eventType,
        clientTimestamp,
        participantId: participant.id,
        settings,
      });
      if (computed.reason) {
        rejected.push({ id_unik: input.id_unik, reason: computed.reason });
        continue;
      }
      const dailyEvents = await transaction.query(
        `SELECT event_type, client_timestamp FROM attendance_logs
         WHERE participant_id = ? AND attendance_date = ?`,
        [participant.id, computed.date],
      );
      const priorCheckIn = dailyEvents.find((event) => event.event_type === 'check_in');
      const priorCheckOut = dailyEvents.find((event) => event.event_type === 'check_out');
      if (eventType === 'check_out' && !priorCheckIn) {
        rejected.push({ id_unik: input.id_unik, reason: 'checkin_required' });
        continue;
      }
      if (eventType === 'check_in' && priorCheckOut) {
        rejected.push({ id_unik: input.id_unik, reason: 'checkin_after_checkout' });
        continue;
      }
      if (
        eventType === 'check_out' &&
        new Date(`${String(priorCheckIn.client_timestamp).replace(' ', 'T')}Z`) > clientTimestamp
      ) {
        rejected.push({ id_unik: input.id_unik, reason: 'checkout_before_checkin' });
        continue;
      }
      if (
        computed.status !== input.status_kehadiran ||
        computed.lateMinutes !== input.menit_terlambat
      ) {
        rejected.push({ id_unik: input.id_unik, reason: 'attendance_value_mismatch' });
        continue;
      }

      const result = await insertAttendanceRecord({
        transaction,
        user: request.user,
        participant,
        record,
        computed,
      });
      if (result.accepted) acceptedIds.push(input.id_unik);
      else rejected.push({ id_unik: input.id_unik, reason: result.reason });
    }
  });

  response.json({ accepted_ids: acceptedIds, rejected });
}));

function parseDate(value, field) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new HttpError(400, `${field} harus berformat YYYY-MM-DD`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new HttpError(400, `${field} bukan tanggal yang valid`);
  }
  return value;
}

router.get('/rekap', allowRoles('admin'), asyncHandler(async (request, response) => {
  let startDate;
  let endDate;
  if (request.query.month !== undefined || request.query.year !== undefined) {
    const month = z.coerce.number().int().min(1).max(12).parse(request.query.month);
    const year = z.coerce.number().int().min(2000).max(2200).parse(request.query.year);
    startDate = `${year}-${String(month).padStart(2, '0')}-01`;
    endDate = `${year}-${String(month).padStart(2, '0')}-${String(
      new Date(Date.UTC(year, month, 0)).getUTCDate(),
    ).padStart(2, '0')}`;
  } else {
    startDate = parseDate(String(request.query.start_date ?? ''), 'start_date');
    endDate = parseDate(String(request.query.end_date ?? ''), 'end_date');
  }
  if (startDate > endDate) throw new HttpError(400, 'start_date tidak boleh setelah end_date');
  const dayCount =
    (Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) /
      86400000 +
    1;
  if (dayCount > 31) throw new HttpError(400, 'Rentang rekap maksimal 31 hari');

  const statusFilter = request.query.status
    ? z.enum(['hadir', 'terlambat', 'pulang', 'belum_hadir']).parse(request.query.status)
    : null;
  const classroomId = request.query.classroom_id
    ? z.coerce.number().int().positive().parse(request.query.classroom_id)
    : null;
  const unitId = request.query.unit_id
    ? z.coerce.number().int().positive().parse(request.query.unit_id)
    : null;

  const participantConditions = ['p.is_active = 1'];
  const participantParams = [];
  if (request.user.role === 'operator') {
    participantConditions.push('p.classroom_id = ?');
    participantParams.push(request.user.classroomId);
  }
  if (classroomId) {
    participantConditions.push('p.classroom_id = ?');
    participantParams.push(classroomId);
  }
  if (unitId) {
    participantConditions.push('c.unit_id = ?');
    participantParams.push(unitId);
  }
  const participants = await db.query(
    `SELECT p.id, p.participant_code, p.full_name, p.classroom_id,
            c.name AS classroom_name, u.id AS unit_id, u.name AS unit_name
     FROM participants p
     JOIN classrooms c ON c.id = p.classroom_id
     JOIN units u ON u.id = c.unit_id
     WHERE ${participantConditions.join(' AND ')}
     ORDER BY u.name, c.name, p.full_name`,
    participantParams,
  );
  const weeklySchedules = await db.query(
    'SELECT weekday, is_working_day FROM weekly_operational_schedules',
  );
  const scheduleByWeekday = new Map(
    weeklySchedules.map((schedule) => [Number(schedule.weekday), schedule]),
  );

  if (participants.length * dayCount > 50000) {
    throw new HttpError(
      413,
      'Hasil rekap terlalu besar; persempit filter kelas/unit atau rentang tanggal',
    );
  }
  const logs = participants.length
    ? await db.query(
        `SELECT a.* FROM attendance_logs a
         JOIN participants p ON p.id = a.participant_id
         JOIN classrooms c ON c.id = p.classroom_id
         JOIN units u ON u.id = c.unit_id
         WHERE a.attendance_date >= ? AND a.attendance_date <= ?
           AND ${participantConditions.join(' AND ')}
         ORDER BY a.attendance_date, a.participant_name_snapshot`,
        [startDate, endDate, ...participantParams],
      )
    : [];
  const logMap = new Map();
  for (const log of logs) {
    const key = `${String(log.participant_id)}:${String(log.attendance_date).slice(0, 10)}`;
    const events = logMap.get(key) ?? {};
    events[log.event_type] = log;
    logMap.set(key, events);
  }

  const rows = [];
  for (let offset = 0; offset < dayCount; offset += 1) {
    const date = addCalendarDays(startDate, offset);
    const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay();
    const schedule = scheduleByWeekday.get(weekday);
    const isWorkingDay = schedule
      ? Boolean(Number(schedule.is_working_day))
      : weekday >= 1 && weekday <= 5;
    for (const participant of participants) {
      const events = logMap.get(`${String(participant.id)}:${date}`) ?? {};
      if (!isWorkingDay && !events.check_in && !events.check_out) continue;
      const checkIn = events.check_in;
      const checkOut = events.check_out;
      const status = checkIn?.attendance_status ?? (checkOut ? 'pulang' : 'belum_hadir');
      if (statusFilter) {
        const matches = statusFilter === 'pulang'
          ? Boolean(checkOut)
          : status === statusFilter;
        if (!matches) continue;
      }
      rows.push({
        attendance_date: date,
        participant_id: String(participant.id),
        participant_code: participant.participant_code,
        participant_name: participant.full_name,
        classroom_id: String(participant.classroom_id),
        classroom_name: participant.classroom_name,
        unit_id: String(participant.unit_id),
        unit_name: participant.unit_name,
        status_kehadiran: status,
        menit_terlambat: Number(checkIn?.late_minutes ?? 0),
        masuk_at: checkIn?.client_timestamp ?? null,
        pulang_at: checkOut?.client_timestamp ?? null,
        id_unik: checkIn?.id_unik ?? checkOut?.id_unik ?? null,
        synced_at: checkIn?.synced_at ?? checkOut?.synced_at ?? null,
        scan_method: checkIn?.scan_method ?? null,
        checkout_scan_method: checkOut?.scan_method ?? null,
        has_pulang: Boolean(checkOut),
      });
    }
  }

  const summary = rows.reduce((totals, row) => {
    if (row.status_kehadiran === 'hadir') totals.hadir_tepat_waktu += 1;
    if (row.status_kehadiran === 'terlambat') {
      totals.terlambat += 1;
      totals.total_menit_terlambat += row.menit_terlambat;
    }
    if (row.has_pulang) totals.pulang += 1;
    if (row.status_kehadiran === 'belum_hadir') totals.belum_hadir += 1;
    return totals;
  }, {
    hadir_tepat_waktu: 0,
    terlambat: 0,
    total_menit_terlambat: 0,
    pulang: 0,
    belum_hadir: 0,
  });

  response.json({ filters: { start_date: startDate, end_date: endDate }, summary, rows });
}));

router.get('/', allowRoles('admin'), asyncHandler(async (request, response) => {
  const startDate = parseDate(String(request.query.start_date ?? ''), 'start_date');
  const endDate = parseDate(String(request.query.end_date ?? ''), 'end_date');
  const logs = await db.query(
    `SELECT * FROM attendance_logs
     WHERE attendance_date >= ? AND attendance_date <= ?
     ORDER BY attendance_date DESC, server_received_at DESC
     LIMIT 1000`,
    [startDate, endDate],
  );
  response.json({ records: logs });
}));

export default router;
