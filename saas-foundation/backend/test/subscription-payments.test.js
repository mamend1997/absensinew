import assert from 'node:assert/strict';
import test from 'node:test';
import { applyPaidSubscriptionPayment } from '../src/core/subscription-payments.js';

test('a repeated Kasera paid event extends a monthly subscription only once', async () => {
  const order = {
    id: 'payment-row',
    sekolah_id: 17,
    plan: 'monthly',
    amount: 50000,
    status: 'pending',
    provider_reference: 'payreq_12345678-1234-1234-1234-123456789abc',
  };
  const updates = [];
  const connection = {
    async execute(sql, params) {
      if (sql.includes('SELECT id, sekolah_id, plan')) return [[{ ...order }]];
      updates.push({ sql, params });
      if (sql.includes('UPDATE subscription_payment_orders')) order.status = 'paid';
      return [{ affectedRows: 1 }];
    },
  };
  const payment = {
    provider: 'kasera',
    orderId: 'RH-monthly-renewal',
    amount: 50000,
    reference: order.provider_reference,
  };

  assert.equal(await applyPaidSubscriptionPayment(connection, payment), true);
  assert.equal(await applyPaidSubscriptionPayment(connection, payment), false);
  assert.equal(order.status, 'paid');
  assert.equal(updates.filter(({ sql }) => sql.includes('UPDATE schools')).length, 1);
  assert.match(updates.find(({ sql }) => sql.includes('UPDATE schools')).sql,
    /DATE_ADD\(subscription_expires_at, INTERVAL 1 MONTH\)/);
});
