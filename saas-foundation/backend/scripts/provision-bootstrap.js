import { pool } from '../src/db.js';
import { hashPassword } from '../src/security.js';

const superPassword = process.env.BOOTSTRAP_SUPER_ADMIN_PASSWORD;
const schoolPassword = process.env.BOOTSTRAP_SCHOOL_ADMIN_PASSWORD;
if (!superPassword || !schoolPassword ||
    superPassword.length < 12 || schoolPassword.length < 12) {
  console.error(
    'Set BOOTSTRAP_SUPER_ADMIN_PASSWORD and BOOTSTRAP_SCHOOL_ADMIN_PASSWORD (12+ characters) in the environment.',
  );
  process.exitCode = 1;
} else {
  try {
    const superUsername = process.env.BOOTSTRAP_SUPER_ADMIN_USERNAME ?? 'bootstrap-superadmin';
    const schoolUsername = process.env.BOOTSTRAP_SCHOOL_ADMIN_USERNAME ?? 'bootstrap-admin';
    const superHash = await hashPassword(superPassword);
    const schoolHash = await hashPassword(schoolPassword);
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [superResult] = await connection.execute(
        `UPDATE super_admins SET username = ?, password_hash = ?, is_active = TRUE
          WHERE username = 'bootstrap-superadmin' AND is_active = FALSE`,
        [superUsername, superHash],
      );
      const [schoolResult] = await connection.execute(
        `UPDATE users u JOIN schools s ON s.id = u.sekolah_id
           SET u.username = ?, u.password_hash = ?, u.is_active = TRUE
         WHERE s.slug = 'sekolah-contoh' AND u.username = 'bootstrap-admin'
           AND u.is_active = FALSE`,
        [schoolUsername, schoolHash],
      );
      if (superResult.affectedRows !== 1 || schoolResult.affectedRows !== 1) {
        throw new Error(
          'Inactive bootstrap rows were not both found; apply database/schema.sql before provisioning.',
        );
      }
      await connection.commit();
      console.log('Bootstrap Super Admin and sekolah-contoh administrator activated.');
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
