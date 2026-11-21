import { randomUUID } from 'node:crypto';
import { inTransaction, pool } from '../db.js';
import { createProviderPayment } from './billing.js';
import { getPlatformPaymentSettings } from './platform-payment-settings.js';
import { decryptGatewayToken, sendWhatsappMessage } from './whatsapp-gateway.js';

const MAX_ATTEMPTS = 5;
const RETRY_DELAY_SECONDS = [60, 300, 900, 3600];
const BATCH_SIZE = 10;

function expiryExpression(alias = 's') {
  return `CASE WHEN ${alias}.subscription_status = 'trial'
    THEN ${alias}.trial_ends_at ELSE ${alias}.subscription_expires_at END`;
}

export function createSubscriptionExpiryReminderMessage({
  schoolName,
  subscriptionStatus,
  expiresAt,
  timeZone,
  amount,
  checkoutUrl,
  invoiceExpiresAt,
}) {
  const formatDate = (value, includeTime = false) => {
    const timestamp = typeof value === 'string' && !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)
      ? `${value.replace(' ', 'T')}Z`
      : value;
    return new Intl.DateTimeFormat('id-ID', {
      timeZone,
      dateStyle: 'long',
      ...(includeTime ? { timeStyle: 'short' } : {}),
    }).format(new Date(timestamp));
  };
  const expiryDate = formatDate(expiresAt);
  const period = subscriptionStatus === 'trial' ? 'Masa uji coba' : 'Langganan';
  const invoiceDeadline = invoiceExpiresAt
    ? `\nBatas pembayaran: ${formatDate(invoiceExpiresAt, true)}`
    : '';
  const formattedAmount = new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    maximumFractionDigits: 0,
  }).format(Number(amount));
  return `Tagihan perpanjangan Ruang Hadir untuk ${schoolName}. ${period} akan berakhir pada ${expiryDate}. Total: ${formattedAmount}.${invoiceDeadline}\nBayar melalui Kasera: ${checkoutUrl}`;
}

async function queueDueReminders() {
  const expiry = expiryExpression();
  await pool.execute(
    `INSERT IGNORE INTO school_subscription_expiry_reminders (sekolah_id, expires_at)
     SELECT s.id, ${expiry}
       FROM schools s
      WHERE s.is_active = TRUE
        AND ((s.subscription_status = 'trial' AND s.trial_ends_at IS NOT NULL)
          OR (s.subscription_status = 'aktif' AND s.subscription_expires_at IS NOT NULL))
        AND ${expiry} >= UTC_TIMESTAMP() + INTERVAL 72 HOUR
        AND ${expiry} < UTC_TIMESTAMP() + INTERVAL 96 HOUR`,
  );
}

async function claimReminder() {
  return inTransaction(async (connection) => {
    const [[reminder]] = await connection.execute(
      `SELECT n.id, n.sekolah_id, n.expires_at, n.attempts, n.payment_order_id,
              n.provider_order_id, COALESCE(n.checkout_url, o.checkout_url) AS checkout_url,
              COALESCE(n.amount, o.amount, prices.monthly_price, 50000) AS amount,
              COALESCE(n.invoice_expires_at, o.expires_at) AS invoice_expires_at,
              s.name AS school_name, s.billing_email, s.subscription_status, s.timezone,
              u.display_name AS admin_name, u.whatsapp_phone,
              g.endpoint_url, g.token_ciphertext, g.token_iv, g.token_auth_tag
         FROM school_subscription_expiry_reminders n
         JOIN schools s ON s.id = n.sekolah_id AND s.is_active = TRUE
         LEFT JOIN platform_billing_settings prices ON prices.id = 1
         LEFT JOIN subscription_payment_orders o ON o.id = n.payment_order_id
         JOIN users u ON u.id = (
           SELECT u2.id
             FROM users u2
             JOIN roles r2 ON r2.sekolah_id = u2.sekolah_id AND r2.id = u2.role_id
            WHERE u2.sekolah_id = s.id AND u2.is_active = TRUE
              AND u2.whatsapp_phone IS NOT NULL AND r2.role_key = 'admin-sekolah'
            ORDER BY u2.id LIMIT 1
         )
         JOIN whatsapp_gateway_config g
           ON g.id = 1 AND g.is_enabled = TRUE
          AND g.endpoint_url IS NOT NULL AND g.token_ciphertext IS NOT NULL
        WHERE n.expires_at > UTC_TIMESTAMP()
          AND n.attempts < ?
          AND s.billing_email IS NOT NULL AND s.billing_email <> ''
          AND ((s.subscription_status = 'trial' AND s.trial_ends_at = n.expires_at)
            OR (s.subscription_status = 'aktif' AND s.subscription_expires_at = n.expires_at))
          AND ((n.status IN ('pending', 'failed') AND n.next_attempt_at <= UTC_TIMESTAMP())
            OR (n.status = 'sending'
              AND n.updated_at <= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 10 MINUTE)))
        ORDER BY n.next_attempt_at, n.id
        LIMIT 1 FOR UPDATE`,
      [MAX_ATTEMPTS],
    );
    if (!reminder) return null;
    let paymentOrderId = reminder.payment_order_id;
    let providerOrderId = reminder.provider_order_id;
    let amount = Number(reminder.amount);
    if (!paymentOrderId) {
      const [[existingOrder]] = await connection.execute(
        `SELECT id, order_id, amount, checkout_url, expires_at
           FROM subscription_payment_orders
          WHERE sekolah_id = ? AND provider = 'kasera' AND plan = 'monthly'
            AND status = 'pending' AND checkout_url IS NOT NULL
            AND expires_at > UTC_TIMESTAMP()
          ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
        [reminder.sekolah_id],
      );
      if (existingOrder) {
        paymentOrderId = existingOrder.id;
        providerOrderId = existingOrder.order_id;
        amount = Number(existingOrder.amount);
        reminder.checkout_url = existingOrder.checkout_url;
        reminder.invoice_expires_at = existingOrder.expires_at;
      } else {
        paymentOrderId = randomUUID();
        providerOrderId = `RH-${randomUUID()}`;
        await connection.execute(
          `INSERT INTO subscription_payment_orders
            (id, sekolah_id, order_id, provider, plan, amount, status)
           VALUES (?, ?, ?, 'kasera', 'monthly', ?, 'pending')`,
          [paymentOrderId, reminder.sekolah_id, providerOrderId, amount],
        );
      }
    }
    await connection.execute(
      `UPDATE school_subscription_expiry_reminders
          SET status = 'sending', attempts = attempts + 1,
              recipient_phone = ?, payment_order_id = ?, provider_order_id = ?,
              amount = ?, checkout_url = COALESCE(?, checkout_url),
              invoice_expires_at = COALESCE(?, invoice_expires_at),
              last_attempt_at = UTC_TIMESTAMP(), last_error = NULL
        WHERE id = ?`,
      [reminder.whatsapp_phone, paymentOrderId, providerOrderId, amount,
        reminder.checkout_url, reminder.invoice_expires_at, reminder.id],
    );
    return { ...reminder, payment_order_id: paymentOrderId, provider_order_id: providerOrderId, amount };
  });
}

async function sendNextReminder() {
  const reminder = await claimReminder();
  if (!reminder) return false;
  try {
    let checkoutUrl = reminder.checkout_url;
    let invoiceExpiresAt = reminder.invoice_expires_at;
    if (!checkoutUrl) {
      const payment = await createProviderPayment({
        order: {
          id: reminder.payment_order_id,
          order_id: reminder.provider_order_id,
          provider: 'kasera',
          plan: 'monthly',
          amount: reminder.amount,
          payment_method: null,
        },
        school: { id: reminder.sekolah_id, name: reminder.school_name },
        payerName: reminder.admin_name,
        email: reminder.billing_email,
        phone: reminder.whatsapp_phone,
      });
      checkoutUrl = payment.checkoutUrl;
      invoiceExpiresAt = payment.expiresAt;
      await pool.execute(
        `UPDATE subscription_payment_orders
            SET checkout_url = ?, provider_reference = ?, expires_at = ?
          WHERE id = ? AND status = 'pending'`,
        [checkoutUrl, payment.reference, invoiceExpiresAt, reminder.payment_order_id],
      );
      await pool.execute(
        `UPDATE school_subscription_expiry_reminders
            SET checkout_url = ?, invoice_expires_at = ?
          WHERE id = ?`,
        [checkoutUrl, invoiceExpiresAt, reminder.id],
      );
    }
    const message = createSubscriptionExpiryReminderMessage({
      schoolName: reminder.school_name,
      subscriptionStatus: reminder.subscription_status,
      expiresAt: reminder.expires_at,
      timeZone: reminder.timezone,
      amount: reminder.amount,
      checkoutUrl,
      invoiceExpiresAt,
    });
    await sendWhatsappMessage(
      reminder.endpoint_url,
      decryptGatewayToken(reminder),
      reminder.whatsapp_phone,
      message,
    );
    await pool.execute(
      `UPDATE school_subscription_expiry_reminders
          SET status = 'sent', last_error = NULL, sent_at = UTC_TIMESTAMP()
        WHERE id = ?`,
      [reminder.id],
    );
  } catch (error) {
    const attempts = Number(reminder.attempts) + 1;
    const status = attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
    const retryDelay = RETRY_DELAY_SECONDS[Math.min(attempts - 1, RETRY_DELAY_SECONDS.length - 1)];
    const message = error instanceof Error ? error.message.slice(0, 500) : 'Pengiriman pengingat WhatsApp gagal.';
    await pool.execute(
      `UPDATE school_subscription_expiry_reminders
          SET status = ?, next_attempt_at = TIMESTAMPADD(SECOND, ?, UTC_TIMESTAMP()),
              last_error = ?
        WHERE id = ?`,
      [status, retryDelay, message, reminder.id],
    );
    if (attempts >= MAX_ATTEMPTS && !reminder.checkout_url) {
      await pool.execute(
        `UPDATE subscription_payment_orders SET status = 'failed'
          WHERE id = ? AND status = 'pending' AND checkout_url IS NULL`,
        [reminder.payment_order_id],
      );
    }
    console.error(`Pengingat perpanjangan sekolah ${reminder.sekolah_id} gagal (${status}): ${message}`);
  }
  return true;
}

export function startSubscriptionExpiryReminderWorker() {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await queueDueReminders();
      const paymentSettings = await getPlatformPaymentSettings();
      if (!paymentSettings.kasera.active) return;
      for (let count = 0; count < BATCH_SIZE; count += 1) {
        if (!await sendNextReminder()) break;
      }
    } catch (error) {
      console.error('Pemrosesan pengingat perpanjangan sekolah gagal:', error);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => { void run(); }, 60000);
  timer.unref();
  void run();
}
