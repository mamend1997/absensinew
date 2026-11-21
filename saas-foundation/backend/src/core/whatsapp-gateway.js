import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { config } from '../config.js';
import { fail } from '../http.js';

const key = createHmac('sha256', 'saas-whatsapp-gateway-token-v1')
  .update(config.jwtSecret)
  .digest();

export function validateGatewayUrl(value) {
  if (typeof value !== 'string' || value.length > 500) {
    throw fail(400, 'URL gateway wajib diisi.', 'VALIDATION_ERROR');
  }
  let url;
  try { url = new URL(value); } catch { throw fail(400, 'URL gateway tidak valid.', 'VALIDATION_ERROR'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443' ||
      url.hostname === 'localhost' || url.hostname.endsWith('.localhost') ||
      url.hostname.endsWith('.local') || url.hostname.endsWith('.internal')) {
    throw fail(400, 'Gateway harus memakai HTTPS pada host publik.', 'VALIDATION_ERROR');
  }
  return url;
}

export function encryptGatewayToken(token) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag() };
}

export function decryptGatewayToken(row) {
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
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
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

export async function sendWhatsappMessage(urlValue, token, phone, message) {
  const url = validateGatewayUrl(urlValue);
  let addresses;
  try {
    addresses = await lookup(url.hostname, { all: true, verbatim: true });
  } catch {
    throw fail(502, 'Host gateway tidak dapat dihubungi.', 'GATEWAY_DELIVERY_FAILED');
  }
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw fail(503, 'Host gateway tidak dapat digunakan.', 'GATEWAY_UNAVAILABLE');
  }
  const body = JSON.stringify({ phone, message });
  const address = addresses[0];
  await new Promise((resolve, reject) => {
    const request = httpsRequest({
      protocol: 'https:',
      hostname: url.hostname,
      port: url.port || 443,
      path: `${url.pathname}${url.search}`,
      method: 'POST',
      servername: url.hostname,
      lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
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
        else reject(fail(502, 'Gateway WhatsApp gagal mengirim OTP.', 'GATEWAY_DELIVERY_FAILED'));
      });
    });
    request.on('timeout', () => request.destroy(new Error('Gateway timeout.')));
    request.on('error', () => reject(fail(502, 'Gateway WhatsApp tidak dapat dihubungi.', 'GATEWAY_DELIVERY_FAILED')));
    request.end(body);
  });
}
