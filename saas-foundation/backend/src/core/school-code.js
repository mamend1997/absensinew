import { randomInt } from 'node:crypto';

export function isValidSchoolCode(value) {
  return typeof value === 'string' && /^\d{4}$/.test(value);
}

export function assertValidSchoolCode(value) {
  if (!isValidSchoolCode(value)) {
    throw new TypeError('Kode sekolah harus tepat 4 digit angka.');
  }
  return value;
}

export async function generateUniqueSchoolCode({
  isTaken,
  maxAttempts = 10000,
  nextCode = () => String(randomInt(0, 10000)).padStart(4, '0'),
}) {
  if (typeof isTaken !== 'function') {
    throw new TypeError('Pemeriksa keunikan kode sekolah wajib disediakan.');
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10000) {
    throw new RangeError('maxAttempts harus berupa bilangan bulat antara 1 dan 10000.');
  }

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const candidate = assertValidSchoolCode(nextCode());
    if (!(await isTaken(candidate))) return candidate;
  }

  throw new Error('Tidak tersedia kode sekolah unik; coba lagi.');
}
