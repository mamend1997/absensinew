export const backupTableColumns = {
  units: ['id', 'name', 'created_at'],
  classrooms: ['id', 'unit_id', 'name', 'created_at'],
  users: [
    'id', 'username', 'display_name', 'password_hash', 'role',
    'classroom_id', 'is_active', 'created_at', 'updated_at',
  ],
  participants: [
    'id', 'participant_code', 'full_name', 'classroom_id', 'qr_code',
    'guardian_phone', 'is_active', 'created_at', 'updated_at',
  ],
  operational_settings: [
    'id', 'timezone', 'check_in_deadline', 'lateness_tolerance_minutes',
    'check_out_start', 'scan_welcome_message', 'scan_success_message',
    'scan_failure_message', 'enable_external_scanner', 'updated_by', 'updated_at',
  ],
  weekly_operational_schedules: [
    'weekday', 'is_working_day', 'check_in_deadline',
    'lateness_tolerance_minutes', 'check_out_start',
  ],
  participant_day_overrides: ['participant_id', 'weekday', 'check_in_deadline'],
  admin_menu_pin: ['id', 'pin_hash', 'updated_at'],
  attendance_logs: [
    'id', 'id_unik', 'participant_id', 'participant_code_snapshot',
    'participant_name_snapshot', 'classroom_name_snapshot', 'attendance_date',
    'event_type', 'client_timestamp', 'server_received_at', 'synced_at',
    'attendance_status', 'late_minutes', 'scan_method', 'device_id', 'recorded_by',
  ],
  attendance_notifications: [
    'id', 'id_unik', 'recipient_phone', 'event_type', 'message', 'status',
    'attempt_count', 'next_attempt_at', 'last_error', 'created_at', 'sent_at',
  ],
  activity_logs: [
    'id', 'actor_user_id', 'actor_username', 'actor_display_name', 'action',
    'entity_type', 'entity_id', 'before_data', 'after_data', 'ip_address', 'created_at',
  ],
};

export const backupTableNames = Object.keys(backupTableColumns);

export async function createBackupTables(database) {
  return database.transaction(async (transaction) => {
    const snapshot = {};
    for (const tableName of backupTableNames) {
      snapshot[tableName] = await transaction.query(`SELECT * FROM ${tableName}`);
    }
    return snapshot;
  });
}
