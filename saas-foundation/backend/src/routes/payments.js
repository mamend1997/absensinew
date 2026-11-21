import { Router } from 'express';
import { inTransaction, pool } from '../db.js';
import {
  verifyDuitkuCallbackSignature, verifyXenditCallbackToken,
} from '../core/billing-signatures.js';
import { getPlatformPaymentSettings } from '../core/platform-payment-settings.js';
import { asyncRoute, fail } from '../http.js';

const router = Router();

async function applyPayment({ provider, orderId, amount, reference }) {
  await inTransaction(async (connection) => {
    const [[order]] = await connection.execute(
      `SELECT id, sekolah_id, plan, amount, status
         FROM subscription_payment_orders
        WHERE provider = ? AND order_id = ? FOR UPDATE`,
      [provider, orderId],
    );
    if (!order) throw fail(404, 'Tagihan pembayaran tidak ditemukan.', 'PAYMENT_ORDER_NOT_FOUND');
    if (Number(order.amount) !== Number(amount)) {
      throw fail(400, 'Nominal pembayaran tidak cocok dengan tagihan.', 'PAYMENT_AMOUNT_MISMATCH');
    }
    if (order.status === 'paid') return;

    await connection.execute(
      `UPDATE subscription_payment_orders
          SET status = 'paid', provider_reference = COALESCE(?, provider_reference),
              paid_at = UTC_TIMESTAMP()
        WHERE id = ?`,
      [reference ?? null, order.id],
    );
    if (order.plan === 'lifetime') {
      await connection.execute(
        `UPDATE schools
            SET subscription_status = 'lifetime', trial_ends_at = NULL,
                subscription_expires_at = NULL
          WHERE id = ?`,
        [order.sekolah_id],
      );
    } else {
      await connection.execute(
        `UPDATE schools
            SET subscription_status = 'aktif', trial_ends_at = NULL,
                subscription_expires_at = CASE
                  WHEN subscription_expires_at > UTC_TIMESTAMP()
                    THEN DATE_ADD(subscription_expires_at, INTERVAL 1 MONTH)
                  ELSE DATE_ADD(UTC_TIMESTAMP(), INTERVAL 1 MONTH)
                END
          WHERE id = ?`,
        [order.sekolah_id],
      );
    }
  });
}

async function updateOrderStatus(provider, orderId, status) {
  await pool.execute(
    `UPDATE subscription_payment_orders
        SET status = ?
      WHERE provider = ? AND order_id = ? AND status = 'pending'`,
    [status, provider, orderId],
  );
}

router.post('/xendit/callback', asyncRoute(async (req, res) => {
  const settings = await getPlatformPaymentSettings();
  if (!verifyXenditCallbackToken(
    req.get('x-callback-token'), settings.credentials.xendit_callback_token,
  )) {
    throw fail(401, 'Callback Xendit tidak terverifikasi.', 'INVALID_PAYMENT_SIGNATURE');
  }
  const { external_id: orderId, status, amount, currency, id: reference } = req.body ?? {};
  if (typeof orderId !== 'string' || typeof status !== 'string') {
    throw fail(400, 'Callback Xendit tidak valid.', 'INVALID_PAYMENT_CALLBACK');
  }
  if (status === 'PAID' || status === 'SETTLED') {
    if (currency !== 'IDR' || !Number.isFinite(Number(amount))) {
      throw fail(400, 'Callback Xendit tidak memuat nominal atau mata uang yang valid.', 'INVALID_PAYMENT_CALLBACK');
    }
    await applyPayment({ provider: 'xendit', orderId, amount, reference });
  } else if (status === 'EXPIRED') {
    await updateOrderStatus('xendit', orderId, 'expired');
  }
  res.json({ received: true });
}));

router.post('/duitku/callback', asyncRoute(async (req, res) => {
  const body = req.body ?? {};
  const settings = await getPlatformPaymentSettings();
  if (body.merchantCode !== settings.credentials.duitku_merchant_code ||
      !verifyDuitkuCallbackSignature(body, settings.credentials.duitku_api_key)) {
    throw fail(401, 'Callback Duitku tidak terverifikasi.', 'INVALID_PAYMENT_SIGNATURE');
  }
  if (typeof body.merchantOrderId !== 'string' ||
      !/^[A-Za-z0-9-]{1,50}$/.test(body.merchantOrderId) ||
      !/^\d+$/.test(String(body.amount)) ||
      typeof body.resultCode !== 'string') {
    throw fail(400, 'Callback Duitku tidak valid.', 'INVALID_PAYMENT_CALLBACK');
  }
  if (body.resultCode === '00') {
    await applyPayment({
      provider: 'duitku',
      orderId: body.merchantOrderId,
      amount: Number(body.amount),
      reference: body.reference,
    });
  } else if (body.resultCode === '01') {
    await updateOrderStatus('duitku', body.merchantOrderId, 'failed');
  }
  res.status(200).send('OK');
}));

export default router;
