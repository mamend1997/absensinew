import { inTransaction, pool } from '../db.js';
import { decryptGatewayToken, sendWhatsappMessage } from './whatsapp-gateway.js';

const MAX_ATTEMPTS = 6;

export function shouldQueueLateAttendanceNotification({ eventType, status, participantPhone }) {
  return eventType === 'check_in' && status === 'terlambat' &&
    typeof participantPhone === 'string' && participantPhone.length > 0;
}

export function createLateAttendanceMessage({
  participantName,
  attendanceDate,
  clientTimestamp,
  timeZone,
  lateMinutes,
}) {
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(clientTimestamp));
  return `Pemberitahuan absensi: ${participantName} tercatat terlambat masuk pada ${attendanceDate} pukul ${time} (${lateMinutes} menit terlambat).`;
}

export async function enqueueLateAttendanceNotification(connection, {
  schoolId,
  attendanceLogId,
  recipientPhone,
  message,
}) {
  await connection.execute(
    `INSERT INTO participant_late_notifications
      (sekolah_id, attendance_log_id, recipient_phone, message)
     VALUES (?, ?, ?, ?)`,
    [schoolId, attendanceLogId, recipientPhone, message],
  );
}

async function claimNotification() {
  return inTransaction(async (connection) => {
    const [[notification]] = await connection.execute(
      `SELECT n.id, n.attempts, n.recipient_phone, n.message,
              g.endpoint_url, g.token_ciphertext, g.token_iv, g.token_auth_tag
         FROM participant_late_notifications n
         JOIN school_whatsapp_gateway_config g
           ON g.sekolah_id = n.sekolah_id AND g.is_enabled = TRUE
          AND g.endpoint_url IS NOT NULL AND g.token_ciphertext IS NOT NULL
        WHERE (n.status = 'pending' AND n.next_attempt_at <= UTC_TIMESTAMP())
           OR (n.status = 'sending' AND n.updated_at <= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 10 MINUTE))
        ORDER BY n.id LIMIT 1 FOR UPDATE`,
    );
    if (!notification) return null;
    await connection.execute(
      `UPDATE participant_late_notifications
          SET status = 'sending', updated_at = UTC_TIMESTAMP()
        WHERE id = ?`,
      [notification.id],
    );
    return notification;
  });
}

async function sendNextNotification() {
  const notification = await claimNotification();
  if (!notification) return;
  try {
    await sendWhatsappMessage(
      notification.endpoint_url,
      decryptGatewayToken(notification),
      notification.recipient_phone,
      notification.message,
    );
    await pool.execute(
      `UPDATE participant_late_notifications
          SET status = 'sent', attempts = attempts + 1, last_error = NULL,
              sent_at = UTC_TIMESTAMP()
        WHERE id = ?`,
      [notification.id],
    );
  } catch (error) {
    const attempts = Number(notification.attempts) + 1;
    const status = attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
    const retryDelaySeconds = Math.min(3600, 30 * (2 ** (attempts - 1)));
    const message = error instanceof Error ? error.message.slice(0, 500) : 'Pengiriman WhatsApp gagal.';
    await pool.execute(
      `UPDATE participant_late_notifications
          SET status = ?, attempts = ?, next_attempt_at = TIMESTAMPADD(SECOND, ?, UTC_TIMESTAMP()),
              last_error = ?
        WHERE id = ?`,
      [status, attempts, retryDelaySeconds, message, notification.id],
    );
    console.error(`Notifikasi keterlambatan peserta ${notification.id} gagal (${status}): ${message}`);
  }
}

export function startLateAttendanceNotificationWorker() {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void sendNextNotification()
      .catch((error) => console.error('Pemrosesan notifikasi keterlambatan gagal:', error))
      .finally(() => { running = false; });
  }, 5000);
  timer.unref();
}
