import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';

process.env.JWT_SECRET ??= randomBytes(48).toString('base64url');
const { createSubscriptionExpiryReminderMessage } = await import(
  '../src/core/subscription-expiry-reminders.js'
);

test('subscription expiry reminder formats the end date in the school timezone', () => {
  const message = createSubscriptionExpiryReminderMessage({
    schoolName: 'SMA Harapan',
    subscriptionStatus: 'aktif',
    expiresAt: '2026-11-24 17:00:00',
    timeZone: 'Asia/Jakarta',
    amount: 50000,
    checkoutUrl: 'https://kasera.id/checkout/test',
    invoiceExpiresAt: '2026-11-22 17:00:00',
  });
  assert.match(message, /Langganan akan berakhir pada 25 November 2026/);
  assert.match(message, /Rp\s?50\.000/);
  assert.match(message, /Batas pembayaran: 23 November 2026/);
  assert.match(message, /https:\/\/kasera\.id\/checkout\/test$/);
});

test('trial reminder identifies the trial period and includes the Kasera checkout', () => {
  const message = createSubscriptionExpiryReminderMessage({
    schoolName: 'SD Contoh',
    subscriptionStatus: 'trial',
    expiresAt: '2026-11-24 17:00:00',
    timeZone: 'Asia/Jakarta',
    amount: 50000,
    checkoutUrl: 'https://kasera.id/checkout/trial',
  });
  assert.match(message, /Masa uji coba akan berakhir pada 25 November 2026/);
  assert.match(message, /https:\/\/kasera\.id\/checkout\/trial$/);
});
