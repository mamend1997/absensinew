import { createHmac, timingSafeEqual } from 'node:crypto';

function hmacHex(value, key) {
  return createHmac('sha256', key).update(value).digest('hex');
}

export function duitkuInquirySignature(merchantCode, orderId, amount, apiKey) {
  return hmacHex(`${merchantCode}${orderId}${amount}`, apiKey);
}

export function duitkuPaymentMethodsSignature(merchantCode, amount, datetime, apiKey) {
  return hmacHex(`${merchantCode}${amount}${datetime}`, apiKey);
}

export function verifyDuitkuCallbackSignature(body, apiKey) {
  const { merchantCode, amount, merchantOrderId, signature } = body ?? {};
  if ([merchantCode, amount, merchantOrderId, signature].some((value) =>
    typeof value !== 'string' || value.length === 0) ||
      !/^[a-f\d]{64}$/i.test(signature)) return false;
  const expected = hmacHex(`${merchantCode}${amount}${merchantOrderId}`, apiKey);
  const expectedBytes = Buffer.from(expected, 'hex');
  const suppliedBytes = Buffer.from(signature, 'hex');
  return suppliedBytes.length === expectedBytes.length &&
    timingSafeEqual(suppliedBytes, expectedBytes);
}

export function verifyXenditCallbackToken(received, expected) {
  if (typeof received !== 'string' || !expected) return false;
  const receivedBytes = Buffer.from(received);
  const expectedBytes = Buffer.from(expected);
  return receivedBytes.length === expectedBytes.length &&
    timingSafeEqual(receivedBytes, expectedBytes);
}
