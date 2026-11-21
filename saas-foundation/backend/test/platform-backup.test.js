import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';

process.env.JWT_SECRET ??= randomBytes(48).toString('base64url');
const { extractTelegramSendError } = await import('../src/core/platform-backup.js');

test('Telegram backup notification accepts only successful Bot API responses', () => {
  assert.equal(extractTelegramSendError(200, '{"ok":true}', 'bot-token', 'chat-id'), null);
  assert.match(
    extractTelegramSendError(
      400,
      JSON.stringify({
        ok: false,
        error_code: 400,
        description: 'Bad Request: chat not found (bot-token, chat-id)',
      }),
      'bot-token',
      'chat-id',
    ),
    /HTTP 400, kode 400\): Bad Request: chat not found \(\[redacted\], \[redacted\]\)/,
  );
});

test('Telegram backup notification errors are bounded and handle invalid responses', () => {
  const error = extractTelegramSendError(
    502,
    JSON.stringify({ ok: false, description: 'x'.repeat(500) }),
    'bot-token',
    'chat-id',
  );
  assert.equal(error.length, 'Telegram menolak notifikasi (HTTP 502): '.length + 300);
  assert.equal(extractTelegramSendError(502, 'not JSON', 'bot-token', 'chat-id'), 'Telegram menolak notifikasi (HTTP 502).');
});
