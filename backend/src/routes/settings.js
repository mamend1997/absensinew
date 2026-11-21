import { Router } from 'express';
import { z } from 'zod';
import { db } from '../config/database.js';
import { allowRoles, authenticate } from '../middleware/auth.js';
import { asyncHandler } from '../utils/async-handler.js';
import { HttpError } from '../utils/http-error.js';
import { getSyncCursor } from '../utils/sync-cursor.js';
import { auditRequestContext, writeAuditLog } from '../services/audit-service.js';
import {
  decryptWhatsappGatewayToken,
  encryptWhatsappGatewayToken,
  validateWhatsappGatewayUrl,
} from '../services/whatsapp-gateway.js';

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

router.get('/whatsapp-gateway', allowRoles('admin'), asyncHandler(async (_request, response) => {
  const rows = await db.query(
    `SELECT endpoint_url, token_ciphertext, token_iv, token_auth_tag, is_enabled
       FROM whatsapp_gateway_settings WHERE id = 1`,
  );
  const settings = rows[0];
  response.json({
    settings: {
      endpoint_url: settings?.endpoint_url ?? '',
      is_enabled: Boolean(Number(settings?.is_enabled ?? 0)),
      is_configured: Boolean(settings?.token_ciphertext),
      token_hint: settings?.token_ciphertext
        ? `Bearer token tersimpan terenkripsi (${decryptWhatsappGatewayToken(settings).slice(-4)})`
        : '',
    },
  });
}));

router.put('/whatsapp-gateway', allowRoles('admin'), asyncHandler(async (request, response) => {
  const input = z.object({
    endpoint_url: z.string().trim().max(500),
    token: z.string().max(1024).optional(),
    is_enabled: z.boolean(),
  }).parse(request.body);
  const endpointUrl = input.endpoint_url ? validateWhatsappGatewayUrl(input.endpoint_url).toString() : '';
  const rows = await db.query(
    `SELECT token_ciphertext, token_iv, token_auth_tag
       FROM whatsapp_gateway_settings WHERE id = 1`,
  );
  const current = rows[0];
  let credentials = current?.token_ciphertext
    ? {
      ciphertext: current.token_ciphertext,
      iv: current.token_iv,
      authTag: current.token_auth_tag,
    }
    : null;
  const token = input.token?.trim() ?? '';
  if (token) credentials = encryptWhatsappGatewayToken(token);
  if (input.is_enabled && (!endpointUrl || !credentials)) {
    throw new HttpError(400, 'URL gateway dan Bearer token harus diisi sebelum gateway diaktifkan.');
  }
  await db.query(
    `UPDATE whatsapp_gateway_settings
        SET endpoint_url = ?, token_ciphertext = ?, token_iv = ?, token_auth_tag = ?,
            is_managed = TRUE, is_enabled = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = 1`,
    [
      endpointUrl || null,
      credentials?.ciphertext ?? null,
      credentials?.iv ?? null,
      credentials?.authTag ?? null,
      input.is_enabled ? 1 : 0,
    ],
  );
  await writeAuditLog({
    ...auditRequestContext(request),
    action: 'settings.whatsapp_gateway.updated',
    entityType: 'whatsapp_gateway',
    entityId: 1,
    after: {
      endpoint_url: endpointUrl,
      is_enabled: input.is_enabled,
      token_updated: Boolean(token),
    },
  });
  response.json({ message: 'Pengaturan WhatsApp berhasil disimpan.' });
}));

router.delete('/whatsapp-gateway', allowRoles('admin'), asyncHandler(async (request, response) => {
  await db.query(
    `UPDATE whatsapp_gateway_settings
        SET endpoint_url = NULL, token_ciphertext = NULL, token_iv = NULL,
            token_auth_tag = NULL, is_managed = TRUE, is_enabled = FALSE,
            updated_at = CURRENT_TIMESTAMP
      WHERE id = 1`,
  );
  await writeAuditLog({
    ...auditRequestContext(request),
    action: 'settings.whatsapp_gateway.deleted',
    entityType: 'whatsapp_gateway',
    entityId: 1,
  });
  response.json({ message: 'Pengaturan WhatsApp berhasil dihapus.' });
}));

function uniqueBy(items, keyOf) {
  return new Set(items.map(keyOf)).size === items.length;
}

function withSeconds(value) {
  return value.length === 5 ? `${value}:00` : value;
}

function timestampValue(value) {
  if (value instanceof Date) return value.getTime();
  const timestamp = String(value);
  return new Date(timestamp.includes('T') ? timestamp : `${timestamp.replace(' ', 'T')}Z`).getTime();
}

router.get('/', asyncHandler(async (request, response) => {
  const syncCursor = await getSyncCursor();
  const rows = await db.query('SELECT * FROM operational_settings WHERE id = 1');
  if (!rows[0]) throw new HttpError(500, 'Pengaturan operasional belum diinisialisasi');
  const participantUpdates = await db.query(
    'SELECT MAX(updated_at) AS updated_at FROM participants',
  );
  const effectiveUpdatedAt = [
    rows[0].updated_at,
    participantUpdates[0]?.updated_at,
  ]
    .filter(Boolean)
    .reduce((latest, value) =>
      timestampValue(value) > timestampValue(latest) ? value : latest,
    );
  if (request.query.updated_since !== undefined) {
    const updatedSince = new Date(String(request.query.updated_since));
    if (Number.isNaN(updatedSince.valueOf())) {
      throw new HttpError(400, 'updated_since harus berupa tanggal yang valid');
    }
    if (timestampValue(effectiveUpdatedAt) < updatedSince.valueOf()) {
      return response.json({ settings: null, unchanged: true, sync_cursor: syncCursor });
    }
  }
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
    sync_cursor: syncCursor,
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
    enable_external_scanner: z.coerce.boolean().optional(),
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
    const previousOverrides = input.participant_overrides
    ? await transaction.query(
      `SELECT participant_id, weekday, check_in_deadline
       FROM participant_day_overrides ORDER BY participant_id, weekday`,
    )
    : [];
    const before = {
    timezone: currentRows[0].timezone,
    check_in_deadline: currentRows[0].check_in_deadline,
    lateness_tolerance_minutes: currentRows[0].lateness_tolerance_minutes,
    check_out_start: currentRows[0].check_out_start,
    scan_welcome_message: currentRows[0].scan_welcome_message,
    scan_success_message: currentRows[0].scan_success_message,
    scan_failure_message: currentRows[0].scan_failure_message,
    enable_external_scanner: currentRows[0].enable_external_scanner,
    weekly_schedules: currentWeeklySchedules,
    ...(input.participant_overrides ? { participant_overrides: previousOverrides } : {}),
    };
    await transaction.query(
      `UPDATE operational_settings SET timezone = ?, check_in_deadline = ?,
        lateness_tolerance_minutes = ?, check_out_start = ?,
        scan_welcome_message = ?, scan_success_message = ?, scan_failure_message = ?,
        enable_external_scanner = ?, updated_by = ?,
        updated_at = CURRENT_TIMESTAMP WHERE id = 1`,
      [
        input.timezone,
        checkIn,
        input.lateness_tolerance_minutes,
        checkOut,
        input.scan_welcome_message ?? currentRows[0].scan_welcome_message,
        input.scan_success_message ?? currentRows[0].scan_success_message,
        input.scan_failure_message ?? currentRows[0].scan_failure_message,
        input.enable_external_scanner ?? currentRows[0].enable_external_scanner,
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
    await writeAuditLog({
      executor: transaction,
      ...auditRequestContext(request),
      action: 'operational_settings.updated',
      entityType: 'operational_settings',
      entityId: 1,
      before,
      after: {
        timezone: input.timezone,
        check_in_deadline: checkIn,
        lateness_tolerance_minutes: input.lateness_tolerance_minutes,
        check_out_start: checkOut,
        scan_welcome_message: input.scan_welcome_message ?? currentRows[0].scan_welcome_message,
        scan_success_message: input.scan_success_message ?? currentRows[0].scan_success_message,
        scan_failure_message: input.scan_failure_message ?? currentRows[0].scan_failure_message,
        enable_external_scanner: input.enable_external_scanner ?? currentRows[0].enable_external_scanner,
        weekly_schedules: weeklySchedules.map((schedule) => ({
          ...schedule,
          check_in_deadline: withSeconds(schedule.check_in_deadline),
          check_out_start: withSeconds(schedule.check_out_start),
        })),
        ...(input.participant_overrides
          ? {
            participant_overrides: input.participant_overrides.map((rule) => ({
              ...rule,
              check_in_deadline: withSeconds(rule.check_in_deadline),
            })),
          }
          : {}),
      },
    });
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
