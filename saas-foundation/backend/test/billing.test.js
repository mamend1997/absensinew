import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import {
  duitkuInquirySignature,
  duitkuPaymentMethodsSignature,
  verifyDuitkuCallbackSignature,
  verifyXenditCallbackToken,
} from '../src/core/billing-signatures.js';
import { verifyKaseraWebhookSignature } from '../src/core/kasera-signatures.js';

test('Duitku signatures use HMAC-SHA256 with the documented fields', () => {
  const key = 'merchant-api-key';
  const orderId = 'RH-order-123';
  const amount = 50000;
  assert.equal(
    duitkuInquirySignature('D123', orderId, amount, key),
    createHmac('sha256', key).update(`D123${orderId}${amount}`).digest('hex'),
  );
  assert.equal(
    duitkuPaymentMethodsSignature('D123', amount, '2026-11-21 00:00:00', key),
    createHmac('sha256', key).update('D123500002026-11-21 00:00:00').digest('hex'),
  );
});

test('Duitku callback verification rejects malformed or tampered signatures', () => {
  const body = {
    merchantCode: 'D123',
    amount: '50000',
    merchantOrderId: 'RH-order-123',
  };
  body.signature = createHmac('sha256', 'merchant-api-key')
    .update(`${body.merchantCode}${body.amount}${body.merchantOrderId}`)
    .digest('hex');
  assert.equal(verifyDuitkuCallbackSignature(body, 'merchant-api-key'), true);
  assert.equal(verifyDuitkuCallbackSignature({ ...body, amount: '50001' }, 'merchant-api-key'), false);
  assert.equal(verifyDuitkuCallbackSignature({ ...body, signature: 'bad' }, 'merchant-api-key'), false);
  assert.equal(verifyDuitkuCallbackSignature({
    ...body,
    signature: `${body.signature}zz`,
  }, 'merchant-api-key'), false);
});

test('Xendit callback token comparison rejects absent or mismatched tokens', () => {
  assert.equal(verifyXenditCallbackToken('callback-secret', 'callback-secret'), true);
  assert.equal(verifyXenditCallbackToken('other-secret', 'callback-secret'), false);
  assert.equal(verifyXenditCallbackToken(undefined, 'callback-secret'), false);
});

test('Kasera webhook signatures bind the raw body and reject stale timestamps', () => {
  const secret = 'kasera-webhook-secret';
  const timestamp = '1795224000';
  const rawBody = Buffer.from('{"type":"payment.paid"}');
  const signature = createHmac('sha256', secret)
    .update(`${timestamp}.`)
    .update(rawBody)
    .digest('hex');
  const header = `t=${timestamp},v1=${signature}`;
  const now = Number(timestamp) * 1000;

  assert.equal(verifyKaseraWebhookSignature(header, rawBody, secret, now), true);
  assert.equal(verifyKaseraWebhookSignature(header, Buffer.from('{}'), secret, now), false);
  assert.equal(verifyKaseraWebhookSignature(header, rawBody, secret, now + 301000), false);
  assert.equal(verifyKaseraWebhookSignature(`t=${timestamp},v1=${'0'.repeat(64)}`, rawBody, secret, now), false);
});
