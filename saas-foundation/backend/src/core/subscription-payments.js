import { fail } from '../http.js';

export async function applyPaidSubscriptionPayment(connection, {
  provider,
  orderId,
  amount,
  reference,
}) {
  const [[order]] = await connection.execute(
    `SELECT id, sekolah_id, plan, amount, status, provider_reference
       FROM subscription_payment_orders
      WHERE provider = ? AND order_id = ? FOR UPDATE`,
    [provider, orderId],
  );
  if (!order) throw fail(404, 'Tagihan pembayaran tidak ditemukan.', 'PAYMENT_ORDER_NOT_FOUND');
  if (Number(order.amount) !== Number(amount)) {
    throw fail(400, 'Nominal pembayaran tidak cocok dengan tagihan.', 'PAYMENT_AMOUNT_MISMATCH');
  }
  if (provider === 'kasera' &&
      (!reference || String(order.provider_reference) !== String(reference))) {
    throw fail(400, 'Referensi transaksi Kasera tidak cocok dengan tagihan.', 'PAYMENT_REFERENCE_MISMATCH');
  }
  if (order.status === 'paid') return false;

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
  return true;
}
