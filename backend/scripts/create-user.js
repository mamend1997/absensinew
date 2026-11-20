import bcrypt from 'bcryptjs';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { db } from '../src/config/database.js';

const args = new Map(
  process.argv.slice(2).map((argument) => {
    const [key, ...value] = argument.replace(/^--/, '').split('=');
    return [key, value.join('=')];
  }),
);
const prompt = createInterface({ input: stdin, output: stdout });

try {
  const username = args.get('username') ?? (await prompt.question('Username: ')).trim();
  const displayName = args.get('name') ?? (await prompt.question('Nama tampilan: ')).trim();
  const role = args.get('role') ?? (await prompt.question('Role (admin/operator): ')).trim();
  const classroomValue = args.get('classroom-id') ??
    (role === 'operator' ? await prompt.question('ID kelas: ') : '');
  const password = await prompt.question('Password (minimal 12 karakter): ');

  if (!username || !displayName || !['admin', 'operator'].includes(role)) {
    throw new Error('Username/nama harus terisi dan role harus admin atau operator.');
  }
  if (password.length < 12) throw new Error('Password harus minimal 12 karakter.');
  if (role === 'operator' && !/^\d+$/.test(classroomValue)) {
    throw new Error('Operator harus mempunyai --classroom-id yang valid.');
  }
  const passwordHash = await bcrypt.hash(password, 12);
  await db.query(
    `INSERT INTO users (username, display_name, password_hash, role, classroom_id)
     VALUES (?, ?, ?, ?, ?)`,
    [username, displayName, passwordHash, role, classroomValue ? Number(classroomValue) : null],
  );
  console.log(`Akun ${role} "${username}" berhasil dibuat.`);
} catch (error) {
  console.error(`Gagal membuat akun: ${error.message}`);
  process.exitCode = 1;
} finally {
  prompt.close();
  await db.close();
}
