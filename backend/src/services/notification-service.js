import { config } from '../config/env.js';
import { db } from '../config/database.js';
import {
  decryptWhatsappGatewayToken,
  sendWhatsappGatewayMessage,
} from './whatsapp-gateway.js';

const MAX_ATTEMPTS = 8;
const BATCH_SIZE = 20;
let processing = false;

function normalizePhone(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('0')) return `62${digits.slice(1)}`;
  if (digits.startsWith('8')) return `62${digits}`;
  return digits;
}

function notificationFor({ participant, record, computed, settings }) {
  const timestamp = new Intl.DateTimeFormat('id-ID', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: settings.timezone,
  }).format(record.clientTimestamp);

  if (record.jenis_absen === 'pulang') {
    return {
      event: 'attendance.check_out',
      message: `${participant.full_name} tercatat pulang pada ${timestamp}.`,
    };
  }
  if (
    computed.status === 'terlambat' &&
    computed.lateMinutes >= config.notificationLateMinutes
  ) {
    return {
      event: 'attendance.late',
      message: `${participant.full_name} tercatat terlambat ${computed.lateMinutes} menit pada ${timestamp}.`,
    };
  }
  return {
    event: 'attendance.check_in',
    message: `${participant.full_name} tercatat masuk pada ${timestamp}.`,
  };
}

export async function enqueueAttendanceNotifications({
  transaction,
  participant,
  record,
  computed,
  settings,
}) {
  const recipients = [...new Set([
    normalizePhone(participant.guardian_phone),
    normalizePhone(config.notificationAdminPhone),
  ].filter(Boolean))];
  if (!recipients.length) return;

  const notification = notificationFor({ participant, record, computed, settings });
  const insertPrefix = db.dialect === 'mysql' ? 'INSERT IGNORE' : 'INSERT OR IGNORE';
  for (const recipientPhone of recipients) {
    await transaction.query(
      `${insertPrefix} INTO attendance_notifications
        (id_unik, recipient_phone, event_type, message)
       VALUES (?, ?, ?, ?)`,
      [record.id_unik, recipientPhone, notification.event, notification.message],
    );
  }
}

export async function processPendingNotifications() {
  if (processing) return;
  processing = true;
  try {
    const [gatewayRows] = await db.query(
      `SELECT endpoint_url, token_ciphertext, token_iv, token_auth_tag, is_managed, is_enabled
         FROM whatsapp_gateway_settings WHERE id = 1`,
    );
    const configuredGateway = gatewayRows?.[0];
    let gatewayUrl = config.whatsappGatewayUrl;
    let gatewayToken = config.whatsappGatewayToken;
    if (Number(configuredGateway?.is_managed)) {
      if (!Number(configuredGateway.is_enabled)) return;
      if (!configuredGateway.token_ciphertext || !configuredGateway.endpoint_url) return;
      gatewayUrl = configuredGateway.endpoint_url;
      gatewayToken = decryptWhatsappGatewayToken(configuredGateway);
    }
    if (!gatewayUrl || !gatewayToken) return;

    const pending = await db.query(
      `SELECT id, id_unik, recipient_phone, event_type, message, attempt_count
       FROM attendance_notifications
       WHERE status = 'pending' AND next_attempt_at <= ?
       ORDER BY id LIMIT ${BATCH_SIZE}`,
      [Date.now()],
    );
    for (const item of pending) {
      const claimTime = Date.now();
      const claimed = await db.query(
        `UPDATE attendance_notifications SET next_attempt_at = ?
         WHERE id = ? AND status = 'pending' AND next_attempt_at <= ?`,
        [claimTime + 30000, item.id, claimTime],
      );
      if (!Number(claimed.affectedRows ?? claimed.changes)) continue;
      try {
        await sendWhatsappGatewayMessage(
          gatewayUrl,
          gatewayToken,
          item.recipient_phone,
          item.message,
          item.event_type,
        );
        await db.query(
          `UPDATE attendance_notifications
           SET status = 'sent', sent_at = CURRENT_TIMESTAMP, last_error = NULL
           WHERE id = ? AND status = 'pending'`,
          [item.id],
        );
      } catch (error) {
        const attemptCount = Number(item.attempt_count) + 1;
        const status = attemptCount >= MAX_ATTEMPTS ? 'failed' : 'pending';
        const retryDelay = Math.min(60000 * (2 ** (attemptCount - 1)), 6 * 60 * 60 * 1000);
        const lastError = error instanceof Error ? error.message.slice(0, 500) : 'Unknown gateway error';
        await db.query(
          `UPDATE attendance_notifications SET status = ?, attempt_count = ?,
             next_attempt_at = ?, last_error = ? WHERE id = ? AND status = 'pending'`,
          [
            status,
            attemptCount,
            Date.now() + retryDelay,
            lastError,
            item.id,
          ],
        );
        console.error('WhatsApp notification delivery failed', {
          notificationId: item.id,
          attemptCount,
          error: lastError,
        });
      }
    }
  } finally {
    processing = false;
  }
}

export function startNotificationWorker() {
  const interval = setInterval(() => {
    void processPendingNotifications().catch((error) =>
      console.error('Notification outbox processing failed', error),
    );
  }, 30000);
  interval.unref();
  void processPendingNotifications().catch((error) =>
    console.error('Notification outbox processing failed', error),
  );
  return () => clearInterval(interval);
}
