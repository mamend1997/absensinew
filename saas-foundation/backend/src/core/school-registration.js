import { createHash, createHmac, randomInt, timingSafeEqual } from 'node:crypto';

export function validateRegistrationPassword(password) {
  return typeof password === 'string' &&
    password.length >= 8 &&
    Buffer.byteLength(password, 'utf8') <= 72 &&
    /[A-Z]/.test(password) &&
    /\d/.test(password) &&
    /[^A-Za-z0-9\s]/.test(password);
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
