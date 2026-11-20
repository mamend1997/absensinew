import { Router } from 'express';
import { z } from 'zod';
import { db } from '../config/database.js';
import { allowRoles, authenticate } from '../middleware/auth.js';
import { asyncHandler } from '../utils/async-handler.js';
import { HttpError } from '../utils/http-error.js';

const router = Router();
router.use(authenticate, allowRoles('admin'));

const classroomSchema = z.object({
  name: z.string().trim().min(1).max(100),
  unit_id: z.coerce.number().int().positive(),
});

router.get('/', asyncHandler(async (_request, response) => {
  const [classrooms, units] = await Promise.all([
    db.query(
      `SELECT c.id, c.name, c.unit_id, u.name AS unit_name
       FROM classrooms c JOIN units u ON u.id = c.unit_id
       ORDER BY u.name, c.name`,
    ),
    db.query('SELECT id, name FROM units ORDER BY name'),
  ]);
  response.json({ classrooms, units });
}));

router.post('/', asyncHandler(async (request, response) => {
  const input = classroomSchema.parse(request.body);
  const unit = await db.query('SELECT id FROM units WHERE id = ?', [input.unit_id]);
  if (!unit[0]) throw new HttpError(400, 'Unit tidak ditemukan.');
  const duplicate = await db.query(
    'SELECT id FROM classrooms WHERE unit_id = ? AND name = ?',
    [input.unit_id, input.name],
  );
  if (duplicate[0]) throw new HttpError(409, 'Nama kelas sudah digunakan pada unit ini.');

  const result = await db.query(
    'INSERT INTO classrooms (unit_id, name) VALUES (?, ?)',
    [input.unit_id, input.name],
  );
  response.status(201).json({ id: String(result.lastInsertRowid ?? result.insertId) });
}));

router.put('/:id', asyncHandler(async (request, response) => {
  const id = z.coerce.number().int().positive().parse(request.params.id);
  const input = classroomSchema.parse(request.body);
  const [existing, unit, duplicate] = await Promise.all([
    db.query('SELECT id FROM classrooms WHERE id = ?', [id]),
    db.query('SELECT id FROM units WHERE id = ?', [input.unit_id]),
    db.query(
      'SELECT id FROM classrooms WHERE unit_id = ? AND name = ? AND id <> ?',
      [input.unit_id, input.name, id],
    ),
  ]);
  if (!existing[0]) throw new HttpError(404, 'Kelas tidak ditemukan.');
  if (!unit[0]) throw new HttpError(400, 'Unit tidak ditemukan.');
  if (duplicate[0]) throw new HttpError(409, 'Nama kelas sudah digunakan pada unit ini.');

  await db.query('UPDATE classrooms SET name = ?, unit_id = ? WHERE id = ?', [
    input.name,
    input.unit_id,
    id,
  ]);
  response.json({ updated: true });
}));

router.delete('/:id', asyncHandler(async (request, response) => {
  const id = z.coerce.number().int().positive().parse(request.params.id);
  const [classroom, participantRefs, userRefs] = await Promise.all([
    db.query('SELECT id FROM classrooms WHERE id = ?', [id]),
    db.query('SELECT id FROM participants WHERE classroom_id = ? LIMIT 1', [id]),
    db.query('SELECT id FROM users WHERE classroom_id = ? LIMIT 1', [id]),
  ]);
  if (!classroom[0]) throw new HttpError(404, 'Kelas tidak ditemukan.');
  if (participantRefs[0] || userRefs[0]) {
    throw new HttpError(409, 'Kelas masih digunakan peserta atau akun operator.');
  }
  await db.query('DELETE FROM classrooms WHERE id = ?', [id]);
  response.json({ deleted: true });
}));

export default router;
