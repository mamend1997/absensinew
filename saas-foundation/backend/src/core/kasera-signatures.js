import { createHmac, timingSafeEqual } from 'node:crypto';

const SIGNATURE_MAX_AGE_MS = 5 * 60 * 1000;

export function verifyKaseraWebhookSignature(signatureHeader, rawBody, secret, now = Date.now()) {
  if (typeof signatureHeader !== 'string' || !Buffer.isBuffer(rawBody) ||
      typeof secret !== 'string' || !secret) return false;

  const parts = signatureHeader.split(',').map((part) => part.trim());
  const timestamps = parts.filter((part) => /^t=\d+$/.test(part));
  if (timestamps.length !== 1) return false;
  const timestamp = timestamps[0].slice(2);
  const timestampMs = Number(timestamp) * 1000;
  if (!Number.isSafeInteger(timestampMs) ||
      Math.abs(now - timestampMs) > SIGNATURE_MAX_AGE_MS) return false;

  const supplied = parts
    .filter((part) => /^v1=[a-f\d]{64}$/i.test(part))
    .map((part) => Buffer.from(part.slice(3), 'hex'));
  if (!supplied.length) return false;

  const expected = createHmac('sha256', secret)
    .update(`${timestamp}.`)
    .update(rawBody)
    .digest();
  return supplied.some((signature) =>
    signature.length === expected.length && timingSafeEqual(signature, expected));
}
