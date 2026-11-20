import { Router } from 'express';
import { z } from 'zod';
import { db } from '../config/database.js';
import { allowRoles, authenticate } from '../middleware/auth.js';
import { asyncHandler } from '../utils/async-handler.js';
import { HttpError } from '../utils/http-error.js';

const router = Router();
router.use(authenticate);

const clockSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/);
const weeklyScheduleSchema = z.object({
  weekday: z.coerce.number().int().min(0).max(6),
  is_working_day: z.boolean().optional(),
  check_in_deadline: clockSchema,
  lateness_tolerance_minutes: z.coerce.number().int().min(0).max(180),
  check_out_start: clockSchema,
});
const participantOverrideSchema = z.object({
  participant_id: z.coerce.number().int().positive(),
  weekday: z.coerce.number().int().min(0).max(6),
  check_in_deadline: clockSchema,
});

function uniqueBy(items, keyOf) {
  return new Set(items.map(keyOf)).size === items.length;
}

function withSeconds(value) {
  return value.length === 5 ? `${value}:00` : value;
}

router.get('/', asyncHandler(async (request, response) => {
  const rows = await db.query('SELECT * FROM operational_settings WHERE id = 1');
  if (!rows[0]) throw new HttpError(500, 'Pengaturan operasional belum diinisialisasi');
  const [weeklySchedules, participantOverrides] = await Promise.all([
    db.query(
      `SELECT weekday, is_working_day, check_in_deadline,
              lateness_tolerance_minutes, check_out_start
       FROM weekly_operational_schedules ORDER BY weekday`,
    ),
    request.user.role === 'operator'
      ? db.query(
        `SELECT o.participant_id, p.full_name AS participant_name, o.weekday,
                o.check_in_deadline
         FROM participant_day_overrides o
         JOIN participants p ON p.id = o.participant_id
         WHERE p.is_active = 1 AND p.classroom_id = ?
         ORDER BY p.full_name, o.weekday`,
        [request.user.classroomId],
      )
      : db.query(
        `SELECT o.participant_id, p.full_name AS participant_name, o.weekday,
                o.check_in_deadline
         FROM participant_day_overrides o
         JOIN participants p ON p.id = o.participant_id
         WHERE p.is_active = 1
         ORDER BY p.full_name, o.weekday`,
      ),
  ]);
  response.json({
    settings: {
      ...rows[0],
      weekly_schedules: weeklySchedules,
      participant_overrides: participantOverrides,
    },
  });
}));

router.put('/', allowRoles('admin'), asyncHandler(async (request, response) => {
  const input = z.object({
    timezone: z.string().trim().min(1).max(64),
    check_in_deadline: clockSchema,
    lateness_tolerance_minutes: z.coerce.number().int().min(0).max(180),
    check_out_start: clockSchema,
    scan_welcome_message: z.string().trim().min(1).max(255).optional(),
    scan_success_message: z.string().trim().min(1).max(255).optional(),
    scan_failure_message: z.string().trim().min(1).max(255).optional(),
    weekly_schedules: z.array(weeklyScheduleSchema).length(7).optional(),
    participant_overrides: z.array(participantOverrideSchema).max(500).optional(),
  }).parse(request.body);

  if (
    input.weekly_schedules &&
    !uniqueBy(input.weekly_schedules, (schedule) => schedule.weekday)
  ) {
    throw new HttpError(400, 'Setiap hari harus memiliki tepat satu aturan jam.');
  }
  if (
    input.participant_overrides &&
    !uniqueBy(
      input.participant_overrides,
      (rule) => `${rule.participant_id}:${rule.weekday}`,
    )
  ) {
    throw new HttpError(400, 'Aturan khusus peserta tidak boleh berulang pada hari yang sama.');
  }

  try {
    new Intl.DateTimeFormat('en', { timeZone: input.timezone });
  } catch {
    throw new HttpError(400, 'Timezone tidak dikenal');
  }

  const checkIn = withSeconds(input.check_in_deadline);
  const checkOut = withSeconds(input.check_out_start);
  const currentRows = await db.query('SELECT * FROM operational_settings WHERE id = 1');
  if (!currentRows[0]) throw new HttpError(500, 'Pengaturan operasional belum diinisialisasi');
  const currentWeeklySchedules = await db.query(
    `SELECT weekday, is_working_day, check_in_deadline,
            lateness_tolerance_minutes, check_out_start
     FROM weekly_operational_schedules ORDER BY weekday`,
  );
  const defaultWeeklySchedules = Array.from({ length: 7 }, (_value, weekday) => ({
    weekday,
    is_working_day: weekday >= 1 && weekday <= 5,
    check_in_deadline: checkIn,
    lateness_tolerance_minutes: input.lateness_tolerance_minutes,
    check_out_start: checkOut,
  }));
  const weeklySchedules = input.weekly_schedules
    ? input.weekly_schedules.map((schedule) => ({
      ...schedule,
      is_working_day: schedule.is_working_day ?? (schedule.weekday >= 1 && schedule.weekday <= 5),
    }))
    : currentWeeklySchedules.length === 7
      ? currentWeeklySchedules
      : defaultWeeklySchedules;
  await db.transaction(async (transaction) => {
    await transaction.query(
      `UPDATE operational_settings SET timezone = ?, check_in_deadline = ?,
        lateness_tolerance_minutes = ?, check_out_start = ?,
        scan_welcome_message = ?, scan_success_message = ?, scan_failure_message = ?, updated_by = ?,
        updated_at = CURRENT_TIMESTAMP WHERE id = 1`,
      [
        input.timezone,
        checkIn,
        input.lateness_tolerance_minutes,
        checkOut,
        input.scan_welcome_message ?? currentRows[0].scan_welcome_message,
        input.scan_success_message ?? currentRows[0].scan_success_message,
        input.scan_failure_message ?? currentRows[0].scan_failure_message,
        request.user.id,
      ],
    );
    await transaction.query('DELETE FROM weekly_operational_schedules');
    for (const schedule of weeklySchedules) {
      await transaction.query(
        `INSERT INTO weekly_operational_schedules
          (weekday, is_working_day, check_in_deadline,
           lateness_tolerance_minutes, check_out_start)
         VALUES (?, ?, ?, ?, ?)`,
        [
          schedule.weekday,
          schedule.is_working_day,
          withSeconds(schedule.check_in_deadline),
          schedule.lateness_tolerance_minutes,
          withSeconds(schedule.check_out_start),
        ],
      );
    }

    if (input.participant_overrides) {
      const participantIds = [...new Set(
        input.participant_overrides.map((rule) => rule.participant_id),
      )];
      if (participantIds.length) {
        const placeholders = participantIds.map(() => '?').join(', ');
        const activeParticipants = await transaction.query(
          `SELECT id FROM participants WHERE is_active = 1 AND id IN (${placeholders})`,
          participantIds,
        );
        if (activeParticipants.length !== participantIds.length) {
          throw new HttpError(400, 'Aturan khusus merujuk ke peserta yang tidak aktif atau tidak ditemukan.');
        }
      }
      await transaction.query('DELETE FROM participant_day_overrides');
      for (const rule of input.participant_overrides) {
        await transaction.query(
          `INSERT INTO participant_day_overrides
            (participant_id, weekday, check_in_deadline)
           VALUES (?, ?, ?)`,
          [rule.participant_id, rule.weekday, withSeconds(rule.check_in_deadline)],
        );
      }
    }
  });
  const rows = await db.query('SELECT * FROM operational_settings WHERE id = 1');
  const [savedSchedules, savedOverrides] = await Promise.all([
    db.query(
      `SELECT weekday, is_working_day, check_in_deadline,
              lateness_tolerance_minutes, check_out_start
       FROM weekly_operational_schedules ORDER BY weekday`,
    ),
    db.query(
      `SELECT o.participant_id, p.full_name AS participant_name, o.weekday,
              o.check_in_deadline
       FROM participant_day_overrides o
       JOIN participants p ON p.id = o.participant_id
       WHERE p.is_active = 1
       ORDER BY p.full_name, o.weekday`,
    ),
  ]);
  response.json({
    settings: {
      ...rows[0],
      weekly_schedules: savedSchedules,
      participant_overrides: savedOverrides,
    },
  });
}));

export default router;
