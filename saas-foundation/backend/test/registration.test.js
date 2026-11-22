import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import {
  createRegistrationOtp,
  equalOtpHash,
  generateRegistrationPassword,
  hashRegistrationOtp,
  normalizeWhatsappPhone,
  registrationSlug,
  validateRegistrationPassword,
  validateRegistrationUsername,
} from '../src/core/school-registration.js';

process.env.JWT_SECRET ??= randomBytes(48).toString('base64url');
const {
  createPinnedGatewayLookup,
  decryptGatewayToken,
  createWhatsappGatewayPayload,
  encryptGatewayToken,
  extractGatewayResponseFailure,
  extractGatewayResponseDetail,
  isGatewayDeliveryConfirmed,
  validateGatewayUrl,
} = await import('../src/core/whatsapp-gateway.js');

test('registration password enforces the visible minimum and character rules', () => {
  assert.equal(validateRegistrationPassword('Sekolah1!'), true);
  assert.equal(validateRegistrationPassword('abcdef1!'), false);
  assert.equal(validateRegistrationPassword('Sekolah!'), false);
  assert.equal(validateRegistrationPassword('Sekolah1'), false);
  assert.equal(validateRegistrationPassword('Ab1!xyz'), false);
  assert.equal(validateRegistrationPassword(`A1!${'a'.repeat(70)}`), false);
});

test('generated passwords meet registration rules and always include a symbol', () => {
  for (let index = 0; index < 40; index += 1) {
    const password = generateRegistrationPassword();
    assert.equal(password.length, 18);
    assert.equal(validateRegistrationPassword(password), true);
    assert.match(password, /[^A-Za-z0-9\s]/);
  }
  assert.throws(() => generateRegistrationPassword(7), RangeError);
});

test('WhatsApp numbers normalize to E.164 and reject invalid values', () => {
  assert.equal(normalizeWhatsappPhone('0812 3456-7890'), '+6281234567890');
  assert.equal(normalizeWhatsappPhone('6281234567890'), '+6281234567890');
  assert.equal(normalizeWhatsappPhone('+1 (202) 555-0123'), '+12025550123');
  assert.equal(normalizeWhatsappPhone('1234'), null);
  assert.equal(
    normalizeWhatsappPhone('0812 3456-7890'),
    normalizeWhatsappPhone('6281234567890'),
  );
});

test('registration usernames accept supported characters and enforce length', () => {
  assert.equal(validateRegistrationUsername('operator.admin-01'), true);
  assert.equal(validateRegistrationUsername('ab'), false);
  assert.equal(validateRegistrationUsername('user name'), false);
  assert.equal(validateRegistrationUsername('user@school'), false);
  assert.equal(validateRegistrationUsername('a'.repeat(81)), false);
});

test('registration OTPs are six digits and are compared using their challenge binding', () => {
  const challengeId = 'c4b93b62-1df9-4c98-b28f-34d27bd9e10a';
  const secret = randomBytes(32).toString('base64url');
  const otp = createRegistrationOtp();
  assert.match(otp, /^\d{6}$/);
  const digest = hashRegistrationOtp(challengeId, otp, secret);
  assert.equal(equalOtpHash(digest, hashRegistrationOtp(challengeId, otp, secret)), true);
  assert.equal(equalOtpHash(digest, hashRegistrationOtp(challengeId, '000000', secret)), false);
  assert.equal(equalOtpHash(digest, hashRegistrationOtp('another-id', otp, secret)), false);
});

test('registration slugs include the unique school code', () => {
  assert.equal(registrationSlug('Sekolah Dasar Harapan', '0042'), 'sekolah-dasar-harapan-0042');
  assert.equal(registrationSlug('!!!', '7310'), 'sekolah-7310');
});

test('WhatsApp gateway tokens are encrypted and gateway URLs must be public HTTPS', () => {
  const encrypted = encryptGatewayToken('private-test-token');
  assert.notEqual(encrypted.ciphertext.toString(), 'private-test-token');
  assert.equal(decryptGatewayToken({
    token_ciphertext: encrypted.ciphertext,
    token_iv: encrypted.iv,
    token_auth_tag: encrypted.authTag,
  }), 'private-test-token');
  assert.equal(validateGatewayUrl('https://gateway.example/send').hostname, 'gateway.example');
  assert.throws(() => validateGatewayUrl('http://gateway.example/send'), { statusCode: 400 });
  assert.throws(() => validateGatewayUrl('https://localhost/send'), { statusCode: 400 });
  assert.throws(() => validateGatewayUrl('https://mysql.railway.internal/send'), { statusCode: 400 });
});

test('WhatsApp gateway payload matches the send-message API contract', () => {
  assert.deepEqual(
    createWhatsappGatewayPayload('+628123456789', 'Pesan uji'),
    { phone: '+628123456789', message: 'Pesan uji' },
  );
});

test('WhatsApp gateway diagnostics redact secrets and bound error details', () => {
  assert.equal(
    extractGatewayResponseDetail(
      JSON.stringify({ message: 'Invalid +628123456789 token private-test-token' }),
      'private-test-token',
      '+628123456789',
    ),
    'Invalid [redacted] token [redacted]',
  );
  assert.equal(extractGatewayResponseDetail('not JSON', 'token', 'phone'), '');
  assert.equal(
    extractGatewayResponseDetail(JSON.stringify({ message: 'x'.repeat(500) }), 'token', 'phone').length,
    240,
  );
});

test('WhatsApp gateway rejects explicit delivery failures in successful HTTP responses', () => {
  assert.equal(
    extractGatewayResponseFailure(
      JSON.stringify({
        success: false,
        message: 'Nomor +628123456789 token private-test-token gagal dikirim.',
      }),
      'private-test-token',
      '+628123456789',
    ),
    'Gateway melaporkan pengiriman gagal: Nomor [redacted] token [redacted] gagal dikirim.',
  );
  assert.equal(
    extractGatewayResponseFailure(JSON.stringify({ status: 'queued' }), 'token', 'phone'),
    '',
  );
  assert.equal(extractGatewayResponseFailure('Accepted', 'token', 'phone'), '');
});

test('WhatsApp gateway only confirms delivery when the response explicitly says delivered', () => {
  assert.equal(isGatewayDeliveryConfirmed(JSON.stringify({ status: 'delivered' })), true);
  assert.equal(isGatewayDeliveryConfirmed(JSON.stringify({ delivered: true })), true);
  assert.equal(isGatewayDeliveryConfirmed(JSON.stringify({ delivery_status: 'delivered' })), true);
  assert.equal(isGatewayDeliveryConfirmed(JSON.stringify({ success: true, status: 'queued' })), false);
  assert.equal(isGatewayDeliveryConfirmed('Accepted'), false);
  assert.equal(isGatewayDeliveryConfirmed(''), false);
});

test('WhatsApp pinned DNS lookup honors Node requests for all resolved addresses', () => {
  const addresses = [
    { address: '8.8.8.8', family: 4 },
    { address: '2606:4700:4700::1111', family: 6 },
  ];
  const pinnedLookup = createPinnedGatewayLookup(addresses);
  let allResult;
  let singleResult;

  pinnedLookup('gateway.example', { all: true }, (...args) => { allResult = args; });
  pinnedLookup('gateway.example', { all: false }, (...args) => { singleResult = args; });

  assert.deepEqual(allResult, [null, addresses]);
  assert.deepEqual(singleResult, [null, '8.8.8.8', 4]);
});
