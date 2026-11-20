import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../config/database.js';
import { allowRoles, authenticate } from '../middleware/auth.js';
import { asyncHandler } from '../utils/async-handler.js';
import { HttpError } from '../utils/http-error.js';
import { getSyncCursor } from '../utils/sync-cursor.js';

const router = Router();
router.use(authenticate);

const participantSchema = z.object({
  participant_code: z.string().trim().min(1).max(60),
  full_name: z.string().trim().min(1).max(150),
  classroom_id: z.coerce.number().int().positive(),
  qr_code: z.string().trim().min(1).max(160),
  guardian_phone: z.preprocess(
    (value) => value === '' ? null : value,
    z.string().trim().max(32).nullable().optional(),
  ),
});
const importParticipantSchema = z.object({
  participant_code: z.string().trim().min(1).max(60).optional(),
  full_name: z.string().trim().min(1).max(150),
  classroom_id: z.coerce.number().int().positive().optional(),
  classroom_name: z.string().trim().min(1).max(100).optional(),
  unit_name: z.string().trim().min(1).max(100).optional(),
  qr_code: z.string().trim().min(1).max(160).optional(),
  guardian_phone: z.preprocess(
    (value) => value === '' ? null : value,
    z.string().trim().max(32).nullable().optional(),
  ),
}).superRefine((row, context) => {
  if (!row.classroom_id && !(row.classroom_name && row.unit_name)) {
    context.addIssue({
      code: 'custom',
      message: 'Setiap baris harus berisi classroom_id atau classroom_name dan unit_name.',
      path: ['classroom_name'],
    });
  }
  if (!row.qr_code && !row.participant_code) {
    context.addIssue({
      code: 'custom',
      message: 'Setiap baris harus berisi qr_code.',
      path: ['qr_code'],
    });
  }
});

const selectParticipants = `
  SELECT p.id, p.participant_code, p.full_name, p.classroom_id,
         c.name AS classroom_name, u.id AS unit_id, u.name AS unit_name,
         p.qr_code, p.guardian_phone, p.is_active, p.updated_at
  FROM participants p
  JOIN classrooms c ON c.id = p.classroom_id
  JOIN units u ON u.id = c.unit_id
`;

router.get('/', asyncHandler(async (request, response) => {
  const includeInactive =
    (request.query.include_inactive === 'true' && request.user.role === 'admin') ||
    request.query.updated_since !== undefined;
  const syncCursor = await getSyncCursor();
  const conditions = [];
  const params = [];
  let updatedSinceSql = null;
  if (!includeInactive) conditions.push('p.is_active = 1');
  if (request.user.role === 'operator') {
    conditions.push('p.classroom_id = ?');
    params.push(request.user.classroomId);
  }
  if (request.query.updated_since !== undefined) {
    const updatedSince = new Date(String(request.query.updated_since));
    if (Number.isNaN(updatedSince.valueOf())) {
      throw new HttpError(400, 'updated_since harus berupa tanggal yang valid');
    }
    conditions.push('p.updated_at >= ?');
    updatedSinceSql = updatedSince.toISOString().slice(0, 19).replace('T', ' ');
    params.push(updatedSinceSql);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const participants = await db.query(
    `${selectParticipants} ${where} ORDER BY p.participant_code`,
    params,
  );
  const removedIds = request.user.role === 'operator' && updatedSinceSql
    ? await db.query(
      `SELECT id FROM participants
       WHERE classroom_id <> ? AND updated_at >= ?`,
      [request.user.classroomId, updatedSinceSql],
    )
    : [];
  response.json({
    participants,
    removed_ids: removedIds.map((participant) => String(participant.id)),
    sync_cursor: syncCursor,
  });
}));

router.post('/', allowRoles('admin'), asyncHandler(async (request, response) => {
  const input = participantSchema.parse(request.body);
  const result = await db.query(
    `INSERT INTO participants
      (participant_code, full_name, classroom_id, qr_code, guardian_phone)
     VALUES (?, ?, ?, ?, ?)`,
    [
      input.participant_code,
      input.full_name,
      input.classroom_id,
      input.qr_code,
      input.guardian_phone ?? null,
    ],
  );
  response.status(201).json({ id: String(result.lastInsertRowid ?? result.insertId) });
}));

router.put('/:id', allowRoles('admin'), asyncHandler(async (request, response) => {
  const id = z.coerce.number().int().positive().parse(request.params.id);
  const input = participantSchema.parse(request.body);
  const hasGuardianPhone = Object.hasOwn(request.body, 'guardian_phone');
  const result = await db.query(
    `UPDATE participants SET participant_code = ?, full_name = ?,
      classroom_id = ?, qr_code = ?,
      guardian_phone = CASE WHEN ? = 1 THEN ? ELSE guardian_phone END,
      updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND is_active = 1`,
    [
      input.participant_code,
      input.full_name,
      input.classroom_id,
      input.qr_code,
      hasGuardianPhone ? 1 : 0,
      input.guardian_phone ?? null,
      id,
    ],
  );
  if (!result.affectedRows && !result.changes) throw new HttpError(404, 'Peserta tidak ditemukan');
  response.json({ updated: true });
}));

router.delete('/bulk', allowRoles('admin'), asyncHandler(async (request, response) => {
  const { ids } = z.object({
    ids: z.array(z.coerce.number().int().positive()).min(1).max(1000),
  }).parse(request.body);
  const uniqueIds = [...new Set(ids)];
  const placeholders = uniqueIds.map(() => '?').join(', ');
  const result = await db.query(
    `UPDATE participants SET is_active = 0, updated_at = CURRENT_TIMESTAMP
     WHERE is_active = 1 AND id IN (${placeholders})`,
    uniqueIds,
  );
  response.json({ deleted: Number(result.affectedRows ?? result.changes ?? 0) });
}));

router.delete('/:id', allowRoles('admin'), asyncHandler(async (request, response) => {
  const id = z.coerce.number().int().positive().parse(request.params.id);
  const result = await db.query(
    `UPDATE participants SET is_active = 0, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND is_active = 1`,
    [id],
  );
  if (!result.affectedRows && !result.changes) throw new HttpError(404, 'Peserta tidak ditemukan');
  response.json({ deleted: true });
}));

router.post('/import', allowRoles('admin'), asyncHandler(async (request, response) => {
  const rows = z.array(importParticipantSchema).min(1).max(1000).parse(request.body.participants);
  const importResult = await db.transaction(async (transaction) => {
    let imported = 0;
    for (const participant of rows) {
      let classroomId = participant.classroom_id;
      if (!classroomId) {
        const classrooms = await transaction.query(
          `SELECT c.id FROM classrooms c
           JOIN units u ON u.id = c.unit_id
           WHERE c.name = ? AND u.name = ?`,
          [participant.classroom_name, participant.unit_name],
        );
        if (!classrooms[0]) {
          throw new HttpError(
            400,
            `Kelas "${participant.classroom_name}" pada unit "${participant.unit_name}" tidak ditemukan.`,
          );
        }
        classroomId = classrooms[0].id;
      }
      const qrCode = participant.qr_code ?? participant.participant_code;
      const hasGuardianPhone = Object.hasOwn(participant, 'guardian_phone');
      const existing = participant.participant_code
        ? await transaction.query(
          'SELECT id FROM participants WHERE participant_code = ?',
          [participant.participant_code],
        )
        : await transaction.query(
          'SELECT id FROM participants WHERE qr_code = ?',
          [qrCode],
        );
      if (existing[0]) {
        await transaction.query(
          `UPDATE participants SET full_name = ?, classroom_id = ?, qr_code = ?,
            guardian_phone = CASE WHEN ? = 1 THEN ? ELSE guardian_phone END,
            is_active = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
          [
            participant.full_name,
            classroomId,
            qrCode,
            hasGuardianPhone ? 1 : 0,
            participant.guardian_phone ?? null,
            existing[0].id,
          ],
        );
      } else {
        await transaction.query(
          `INSERT INTO participants
            (participant_code, full_name, classroom_id, qr_code, guardian_phone)
           VALUES (?, ?, ?, ?, ?)`,
          [
            participant.participant_code ?? `P-${randomUUID()}`,
            participant.full_name,
            classroomId,
            qrCode,
            participant.guardian_phone ?? null,
          ],
        );
      }
      imported += 1;
    }
    return imported;
  });
  response.json({ imported: importResult });
}));

export default router;
