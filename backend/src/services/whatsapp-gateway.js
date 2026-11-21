import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { config } from '../config/env.js';
import { HttpError } from '../utils/http-error.js';

const key = createHmac('sha256', 'ruang-hadir-whatsapp-gateway-v1')
  .update(config.jwtSecret)
  .digest();

export function validateWhatsappGatewayUrl(value) {
  if (typeof value !== 'string' || value.length > 500) {
    throw new HttpError(400, 'URL gateway wajib diisi.');
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new HttpError(400, 'URL gateway tidak valid.');
  }
  if (url.protocol !== 'https:' || url.username || url.password ||
      (url.port && url.port !== '443') || url.hostname === 'localhost' ||
      url.hostname.endsWith('.localhost') || url.hostname.endsWith('.local') ||
      url.hostname.endsWith('.internal')) {
    throw new HttpError(400, 'Gateway harus memakai HTTPS pada host publik.');
  }
  return url;
}

export function encryptWhatsappGatewayToken(token) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag() };
}

export function decryptWhatsappGatewayToken(row) {
  const decipher = createDecipheriv('aes-256-gcm', key, row.token_iv);
  decipher.setAuthTag(row.token_auth_tag);
  return Buffer.concat([
    decipher.update(row.token_ciphertext),
    decipher.final(),
  ]).toString('utf8');
}

function isPublicAddress(address) {
  if (address.includes(':')) {
    const groups = address.toLowerCase().split(':');
    const first = Number.parseInt(groups[0] || '0', 16);
    const second = Number.parseInt(groups[1] || '0', 16);
    return first >= 0x2000 && first <= 0x3fff &&
      !(first === 0x2001 && (second === 0x0002 || second === 0x0db8 || second === 0x0010));
  }
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((part) =>
    !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = octets;
  return a !== 0 && a !== 10 && a !== 127 && a < 224 &&
    !(a === 100 && b >= 64 && b <= 127) &&
    !(a === 169 && b === 254) &&
    !(a === 172 && b >= 16 && b <= 31) &&
    !(a === 192 && b === 168) &&
    !(a === 192 && b === 0) &&
    !(a === 198 && (b === 18 || b === 19 || b === 51)) &&
    !(a === 203 && b === 0);
}

export async function sendWhatsappGatewayMessage(urlValue, token, phone, message, event) {
  const url = validateWhatsappGatewayUrl(urlValue);
  let addresses;
  try {
    addresses = await lookup(url.hostname.replace(/^\[|\]$/g, ''), {
      all: true,
      verbatim: true,
    });
  } catch {
    throw new Error('Host gateway WhatsApp tidak dapat dihubungi.');
  }
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new Error('Host gateway WhatsApp tidak dapat digunakan.');
  }
  const body = JSON.stringify({ to: phone, message, event });
  await new Promise((resolve, reject) => {
    const address = addresses[0];
    const outgoing = httpsRequest({
      protocol: 'https:',
      hostname: url.hostname.replace(/^\[|\]$/g, ''),
      port: url.port || 443,
      path: `${url.pathname}${url.search}`,
      method: 'POST',
      servername: url.hostname.replace(/^\[|\]$/g, ''),
      lookup: (_hostname, _options, callback) =>
        callback(null, address.address, address.family),
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
      timeout: 10000,
    }, (response) => {
      response.resume();
      response.on('end', () => {
        if (response.statusCode >= 200 && response.statusCode < 300) resolve();
        else reject(new Error(`Gateway WhatsApp mengembalikan HTTP ${response.statusCode}.`));
      });
    });
    outgoing.on('timeout', () => outgoing.destroy(new Error('Gateway timeout.')));
    outgoing.on('error', () => reject(new Error('Gateway WhatsApp tidak dapat mengirim pesan.')));
    outgoing.end(body);
  });
}
