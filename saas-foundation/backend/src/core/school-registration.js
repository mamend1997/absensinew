import { createHash, createHmac, randomInt, timingSafeEqual } from 'node:crypto';

const PASSWORD_UPPERCASE = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const PASSWORD_LOWERCASE = 'abcdefghijkmnopqrstuvwxyz';
const PASSWORD_DIGITS = '23456789';
const PASSWORD_SYMBOLS = '!@#$%^&*_-+=?';
const PASSWORD_CHARACTERS = `${PASSWORD_UPPERCASE}${PASSWORD_LOWERCASE}${PASSWORD_DIGITS}${PASSWORD_SYMBOLS}`;

export function validateRegistrationPassword(password) {
  return typeof password === 'string' &&
    password.length >= 8 &&
    Buffer.byteLength(password, 'utf8') <= 72 &&
    /[A-Z]/.test(password) &&
    /\d/.test(password) &&
    /[^A-Za-z0-9\s]/.test(password);
}

export function generateRegistrationPassword(length = 18) {
  if (!Number.isInteger(length) || length < 8 || length > 72) {
    throw new RangeError('Panjang kata sandi harus antara 8 dan 72 karakter.');
  }
  const password = [
    PASSWORD_UPPERCASE[randomInt(PASSWORD_UPPERCASE.length)],
    PASSWORD_LOWERCASE[randomInt(PASSWORD_LOWERCASE.length)],
    PASSWORD_DIGITS[randomInt(PASSWORD_DIGITS.length)],
    PASSWORD_SYMBOLS[randomInt(PASSWORD_SYMBOLS.length)],
  ];
  while (password.length < length) {
    password.push(PASSWORD_CHARACTERS[randomInt(PASSWORD_CHARACTERS.length)]);
  }
  for (let index = password.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(index + 1);
    [password[index], password[swapIndex]] = [password[swapIndex], password[index]];
  }
  return password.join('');
}

export function validateRegistrationUsername(username) {
  return typeof username === 'string' && /^[A-Za-z0-9._-]{3,80}$/.test(username);
}

export function normalizeWhatsappPhone(value) {
  if (typeof value !== 'string') return null;
  const compact = value.trim().replace(/[\s().-]/g, '');
  let normalized = compact;
  if (/^08\d+$/.test(compact)) normalized = `+62${compact.slice(1)}`;
  else if (/^628\d+$/.test(compact)) normalized = `+${compact}`;
  else if (/^8\d+$/.test(compact)) normalized = `+62${compact}`;
  if (!/^\+[1-9]\d{7,14}$/.test(normalized)) return null;
  return normalized;
}

export function createRegistrationOtp() {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

export function hashRegistrationOtp(challengeId, otp, secret) {
  return createHmac('sha256', secret)
    .update(`${challengeId}:${otp}`)
    .digest();
}

export function hashRegistrationIp(ip, secret) {
  return createHash('sha256').update(`${secret}:${ip}`).digest('hex');
}

export function equalOtpHash(expected, supplied) {
  const actual = Buffer.isBuffer(supplied) ? supplied : Buffer.from(supplied);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function registrationSlug(name, schoolCode) {
  const base = name.normalize('NFKD').toLowerCase()
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 90) || 'sekolah';
  return `${base}-${schoolCode}`;
}
