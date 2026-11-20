import { db } from '../config/database.js';

export async function writeAuditLog({
  executor = db,
  user,
  action,
  entityType,
  entityId = null,
  before = null,
  after = null,
  ipAddress = null,
}) {
  await executor.query(
    `INSERT INTO activity_logs
      (actor_user_id, actor_username, actor_display_name, action,
       entity_type, entity_id, before_data, after_data, ip_address)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      user?.id ?? null,
      user?.username ?? 'system',
      user?.displayName ?? 'Sistem',
      action,
      entityType,
      entityId == null ? null : String(entityId),
      before == null ? null : JSON.stringify(before),
      after == null ? null : JSON.stringify(after),
      ipAddress,
    ],
  );
}

export function auditRequestContext(request) {
  return {
    user: request.user,
    ipAddress: request.ip,
  };
}
