import { Router } from 'express';
import { inTransaction, pool } from '../db.js';
import {
  verifyDuitkuCallbackSignature, verifyXenditCallbackToken,
} from '../core/billing-signatures.js';
import { verifyKaseraWebhookSignature } from '../core/kasera-signatures.js';
import { applyPaidSubscriptionPayment } from '../core/subscription-payments.js';
import { getPlatformPaymentSettings } from '../core/platform-payment-settings.js';
import { asyncRoute, fail } from '../http.js';

const router = Router();

async function applyPayment(payment) {
  await inTransaction((connection) => applyPaidSubscriptionPayment(connection, payment));
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

router.post('/kasera/webhook', asyncRoute(async (req, res) => {
  const settings = await getPlatformPaymentSettings();
  const rawBody = req.rawBody;
  if (!settings.credentials.kasera_webhook_secret ||
      !verifyKaseraWebhookSignature(
        req.get('kasera-signature-v1'),
        rawBody,
        settings.credentials.kasera_webhook_secret,
      )) {
    throw fail(401, 'Webhook Kasera tidak terverifikasi.', 'INVALID_PAYMENT_SIGNATURE');
  }

  const event = req.body;
  if (event?.type === 'test.ping' && event.test === true) {
    return res.json({ received: true });
  }
  if (event?.type !== 'payment.paid' ||
      typeof event.id !== 'string' ||
      typeof event.livemode !== 'boolean' ||
      event.livemode !== settings.credentials.kasera_api_key.startsWith('kp_live_')) {
    throw fail(400, 'Webhook pembayaran Kasera tidak valid atau mode tidak cocok.', 'INVALID_PAYMENT_CALLBACK');
  }
  const payment = event.data;
  if (typeof payment?.external_id !== 'string' ||
      typeof payment.payment_request_id !== 'string' ||
      !/^payreq_[0-9a-f-]{36}$/i.test(payment.payment_request_id) ||
      payment.currency !== 'IDR' ||
      !Number.isSafeInteger(Number(payment.amount))) {
    throw fail(400, 'Data pembayaran Kasera tidak lengkap.', 'INVALID_PAYMENT_CALLBACK');
  }
  await applyPayment({
    provider: 'kasera',
    orderId: payment.external_id,
    amount: Number(payment.amount),
    reference: payment.payment_request_id,
  });
  res.json({ received: true });
}));

export default router;
