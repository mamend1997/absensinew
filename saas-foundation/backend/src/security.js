import {
  createHmac, randomBytes, timingSafeEqual, createHash,
} from 'node:crypto';
import bcrypt from 'bcryptjs';
import { config } from './config.js';

const DUMMY_HASH = bcrypt.hashSync(randomBytes(32).toString('base64url'), 10);
const duration = /^(\d+)(s|m|h|d)$/.exec(config.jwtTtl);
if (!duration) throw new Error('JWT_TTL harus berupa durasi seperti 8h atau 30m.');
const ttlSeconds = Number(duration[1]) * ({ s: 1, m: 60, h: 3600, d: 86400 })[duration[2]];

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

export function signToken(payload) {
  const now = Math.floor(Date.now() / 1000);
  const body = encode({ ...payload, iat: now, exp: now + ttlSeconds });
  const input = `v1.${body}`;
  const signature = createHmac('sha256', config.jwtSecret).update(input).digest('base64url');
  return `${input}.${signature}`;
}

export function verifyToken(token) {
  if (typeof token !== 'string' || token.length > 4096) throw new Error('Invalid token');
  const [version, body, signature, extra] = token.split('.');
  if (version !== 'v1' || !body || !signature || extra) throw new Error('Invalid token');
  const input = `${version}.${body}`;
  const expected = createHmac('sha256', config.jwtSecret).update(input).digest();
  const actual = Buffer.from(signature, 'base64url');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new Error('Invalid token');
  }
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  if (!Number.isInteger(payload.exp) || payload.exp <= Math.floor(Date.now() / 1000)) {
    throw new Error('Expired token');
  }
  return payload;
}

export function readBearerToken(header) {
  const match = /^Bearer ([^\s]+)$/i.exec(header ?? '');
  if (!match) return null;
  return match[1];
}

export async function verifyPassword(password, hash) {
  if (typeof password !== 'string' || password.length > 1024) {
    await bcrypt.compare('invalid', DUMMY_HASH);
    return false;
  }
  return bcrypt.compare(password, hash || DUMMY_HASH);
}

export function hashPassword(password) {
  return bcrypt.hash(password, 12);
}

export function createDeviceApiKey() {
  const secret = randomBytes(32).toString('base64url');
  return { apiKey: `saas_${secret}`, hash: hashDeviceApiKey(`saas_${secret}`) };
}

export function hashDeviceApiKey(apiKey) {
  return createHash('sha256').update(apiKey, 'utf8').digest('hex');
}
