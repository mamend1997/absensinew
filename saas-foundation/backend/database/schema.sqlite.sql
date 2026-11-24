PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS "activity_logs" (
  "id" INTEGER NOT NULL,
  "sekolah_id" INTEGER NOT NULL,
  "actor_user_id" INTEGER DEFAULT NULL,
  "actor_name_snapshot" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "entity_type" TEXT NOT NULL,
  "entity_id" TEXT DEFAULT NULL,
  "before_data" TEXT DEFAULT NULL,
  "after_data" TEXT DEFAULT NULL,
  "ip_address" TEXT DEFAULT NULL,
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("id"),
  CONSTRAINT "fk_activity_school" FOREIGN KEY ("sekolah_id") REFERENCES "schools" ("id") ON DELETE CASCADE,
  CONSTRAINT "fk_activity_user" FOREIGN KEY ("sekolah_id", "actor_user_id") REFERENCES "users" ("sekolah_id", "id")
);

CREATE TABLE IF NOT EXISTS "attendance_exceptions" (
  "id" INTEGER NOT NULL,
  "sekolah_id" INTEGER NOT NULL,
  "participant_id" INTEGER NOT NULL,
  "recorded_by" INTEGER NOT NULL,
  "attendance_date" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "note" TEXT DEFAULT NULL,
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("id"),
  UNIQUE ("sekolah_id", "participant_id", "attendance_date"),
  CONSTRAINT "fk_exception_participant" FOREIGN KEY ("sekolah_id", "participant_id") REFERENCES "participants" ("sekolah_id", "id"),
  CONSTRAINT "fk_exception_school" FOREIGN KEY ("sekolah_id") REFERENCES "schools" ("id") ON DELETE CASCADE,
  CONSTRAINT "fk_exception_user" FOREIGN KEY ("sekolah_id", "recorded_by") REFERENCES "users" ("sekolah_id", "id")
);

CREATE TABLE IF NOT EXISTS "attendance_logs" (
  "id" INTEGER NOT NULL,
  "sekolah_id" INTEGER NOT NULL,
  "id_unik" TEXT NOT NULL,
  "participant_id" INTEGER NOT NULL,
  "device_id" INTEGER DEFAULT NULL,
  "recorded_by" INTEGER DEFAULT NULL,
  "participant_code_snapshot" TEXT NOT NULL,
  "participant_name_snapshot" TEXT NOT NULL,
  "classroom_name_snapshot" TEXT NOT NULL,
  "attendance_date" TEXT NOT NULL,
  "event_type" TEXT NOT NULL,
  "client_timestamp_utc" TEXT NOT NULL,
  "scheduled_check_out" TEXT DEFAULT NULL,
  "server_received_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "attendance_status" TEXT NOT NULL,
  "late_minutes" NUMERIC NOT NULL DEFAULT '0.0',
  "scan_method" TEXT NOT NULL DEFAULT 'SCAN_QR',
  PRIMARY KEY ("id"),
  UNIQUE ("sekolah_id", "id_unik"),
  CONSTRAINT "fk_attendance_device" FOREIGN KEY ("sekolah_id", "device_id") REFERENCES "scanner_devices" ("sekolah_id", "id"),
  CONSTRAINT "fk_attendance_participant" FOREIGN KEY ("sekolah_id", "participant_id") REFERENCES "participants" ("sekolah_id", "id"),
  CONSTRAINT "fk_attendance_school" FOREIGN KEY ("sekolah_id") REFERENCES "schools" ("id") ON DELETE CASCADE,
  CONSTRAINT "fk_attendance_user" FOREIGN KEY ("sekolah_id", "recorded_by") REFERENCES "users" ("sekolah_id", "id"),
  CONSTRAINT "chk_attendance_status_event" CHECK (((("event_type" in ('check_out','permission_check_out')) and ("attendance_status" = 'pulang') and ("late_minutes" = 0)) or (("event_type" = 'check_in') and ("attendance_status" in ('hadir','terlambat')) and ((("attendance_status" = 'hadir') and ("late_minutes" = 0)) or (("attendance_status" = 'terlambat') and ("late_minutes" > 0)))) or (("event_type" = 'permission_out') and ("attendance_status" = 'izin_keluar') and ("late_minutes" = 0)) or (("event_type" = 'permission_in') and ("attendance_status" = 'izin_masuk') and ("late_minutes" = 0))))
);

CREATE TABLE IF NOT EXISTS "classrooms" (
  "id" INTEGER NOT NULL,
  "sekolah_id" INTEGER NOT NULL,
  "unit_id" INTEGER NOT NULL,
  "name" TEXT NOT NULL,
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("id"),
  UNIQUE ("sekolah_id", "unit_id", "name"),
  UNIQUE ("sekolah_id", "id"),
  CONSTRAINT "fk_classrooms_school" FOREIGN KEY ("sekolah_id") REFERENCES "schools" ("id") ON DELETE CASCADE,
  CONSTRAINT "fk_classrooms_unit" FOREIGN KEY ("sekolah_id", "unit_id") REFERENCES "units" ("sekolah_id", "id")
);

CREATE TABLE IF NOT EXISTS "operational_settings" (
  "sekolah_id" INTEGER NOT NULL,
  "timezone" TEXT NOT NULL DEFAULT 'Asia/Jakarta',
  "check_in_deadline" TEXT NOT NULL DEFAULT '08:00:00',
  "lateness_tolerance_minutes" INTEGER NOT NULL DEFAULT '0',
  "check_out_start" TEXT NOT NULL DEFAULT '15:00:00',
  "scanner_pin_hash" TEXT DEFAULT NULL,
  "updated_by" INTEGER DEFAULT NULL,
  "updated_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "scan_welcome_message" TEXT NOT NULL DEFAULT 'Pindai kartu atau barcode peserta saat melaksanakan absensi',
  "scan_success_message" TEXT NOT NULL DEFAULT 'Terima kasih, {name}. Absensi {status} sudah dicatat.',
  "scan_failure_message" TEXT NOT NULL DEFAULT 'Maaf, absensi {name} gagal. {reason}.',
  "scan_cooldown_minutes" INTEGER NOT NULL DEFAULT '5',
  PRIMARY KEY ("sekolah_id"),
  CONSTRAINT "fk_operational_settings_school" FOREIGN KEY ("sekolah_id") REFERENCES "schools" ("id") ON DELETE CASCADE,
  CONSTRAINT "fk_operational_settings_user" FOREIGN KEY ("sekolah_id", "updated_by") REFERENCES "users" ("sekolah_id", "id"),
  CONSTRAINT "chk_operational_tolerance" CHECK (("lateness_tolerance_minutes" <= 180))
);

CREATE TABLE IF NOT EXISTS "participant_late_notifications" (
  "id" INTEGER NOT NULL,
  "sekolah_id" INTEGER NOT NULL,
  "attendance_log_id" INTEGER NOT NULL,
  "recipient_phone" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT '0',
  "next_attempt_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_error" TEXT DEFAULT NULL,
  "sent_at" TEXT NULL DEFAULT NULL,
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("id"),
  UNIQUE ("attendance_log_id"),
  CONSTRAINT "fk_late_notification_attendance" FOREIGN KEY ("attendance_log_id") REFERENCES "attendance_logs" ("id") ON DELETE CASCADE,
  CONSTRAINT "fk_late_notification_school" FOREIGN KEY ("sekolah_id") REFERENCES "schools" ("id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "participant_operational_overrides" (
  "sekolah_id" INTEGER NOT NULL,
  "participant_id" INTEGER NOT NULL,
  "weekday" INTEGER NOT NULL,
  "check_in_deadline" TEXT DEFAULT NULL,
  "check_out_start" TEXT DEFAULT NULL,
  PRIMARY KEY ("sekolah_id","participant_id","weekday"),
  CONSTRAINT "fk_participant_override_participant" FOREIGN KEY ("sekolah_id", "participant_id") REFERENCES "participants" ("sekolah_id", "id") ON DELETE CASCADE,
  CONSTRAINT "chk_participant_override_weekday" CHECK (("weekday" between 0 and 6))
);

CREATE TABLE IF NOT EXISTS "participants" (
  "id" INTEGER NOT NULL,
  "sekolah_id" INTEGER NOT NULL,
  "classroom_id" INTEGER NOT NULL,
  "participant_code" TEXT NOT NULL,
  "full_name" TEXT NOT NULL,
  "qr_code" TEXT NOT NULL,
  "participant_phone" TEXT DEFAULT NULL,
  "guardian_phone" TEXT DEFAULT NULL,
  "is_active" INTEGER NOT NULL DEFAULT '1',
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("id"),
  UNIQUE ("sekolah_id", "participant_code"),
  UNIQUE ("sekolah_id", "qr_code"),
  UNIQUE ("sekolah_id", "id"),
  CONSTRAINT "fk_participants_classroom" FOREIGN KEY ("sekolah_id", "classroom_id") REFERENCES "classrooms" ("sekolah_id", "id"),
  CONSTRAINT "fk_participants_school" FOREIGN KEY ("sekolah_id") REFERENCES "schools" ("id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "platform_audit_logs" (
  "id" INTEGER NOT NULL,
  "super_admin_id" INTEGER DEFAULT NULL,
  "username" TEXT NOT NULL,
  "method" TEXT NOT NULL,
  "route" TEXT NOT NULL,
  "status_code" INTEGER NOT NULL,
  "ip_address" TEXT DEFAULT NULL,
  "user_agent" TEXT DEFAULT NULL,
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("id"),
  CONSTRAINT "fk_platform_audit_admin" FOREIGN KEY ("super_admin_id") REFERENCES "super_admins" ("id") ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS "platform_backup_settings" (
  "id" INTEGER NOT NULL,
  "enabled" INTEGER NOT NULL DEFAULT '0',
  "backup_time" TEXT NOT NULL DEFAULT '02:00',
  "encrypted_credentials" TEXT,
  "last_run_date" TEXT DEFAULT NULL,
  "last_run_file" TEXT DEFAULT NULL,
  "last_status" TEXT NOT NULL DEFAULT 'never',
  "last_run_at" TEXT NULL DEFAULT NULL,
  "last_error" TEXT DEFAULT NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "chk_platform_backup_settings_singleton" CHECK (("id" = 1))
);

CREATE TABLE IF NOT EXISTS "platform_billing_settings" (
  "id" INTEGER NOT NULL,
  "monthly_price" INTEGER NOT NULL DEFAULT '50000',
  "lifetime_price" INTEGER NOT NULL DEFAULT '1000000',
  "updated_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("id"),
  CONSTRAINT "chk_platform_billing_singleton" CHECK (("id" = 1))
);

CREATE TABLE IF NOT EXISTS "platform_branding" (
  "id" INTEGER NOT NULL,
  "logo_mime_type" TEXT DEFAULT NULL,
  "logo_data" BLOB,
  "updated_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "application_name" TEXT NOT NULL DEFAULT 'Ruang Hadir',
  PRIMARY KEY ("id"),
  CONSTRAINT "chk_platform_branding_singleton" CHECK (("id" = 1))
);

CREATE TABLE IF NOT EXISTS "platform_download_settings" (
  "id" INTEGER NOT NULL,
  "apk_drive_url" TEXT DEFAULT NULL,
  "updated_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("id"),
  CONSTRAINT "chk_platform_download_singleton" CHECK (("id" = 1))
);

CREATE TABLE IF NOT EXISTS "platform_otp_rate_limit_settings" (
  "id" INTEGER NOT NULL,
  "max_requests_per_phone" INTEGER NOT NULL DEFAULT '10',
  "window_minutes" INTEGER NOT NULL DEFAULT '30',
  "updated_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("id"),
  CONSTRAINT "chk_platform_otp_rate_limit_count" CHECK (("max_requests_per_phone" between 1 and 50)),
  CONSTRAINT "chk_platform_otp_rate_limit_singleton" CHECK (("id" = 1)),
  CONSTRAINT "chk_platform_otp_rate_limit_window" CHECK (("window_minutes" between 1 and 1440))
);

CREATE TABLE IF NOT EXISTS "platform_payment_gateway_settings" (
  "id" INTEGER NOT NULL,
  "xendit_enabled" INTEGER DEFAULT NULL,
  "duitku_enabled" INTEGER DEFAULT NULL,
  "duitku_environment" TEXT DEFAULT NULL,
  "encrypted_credentials" TEXT,
  "updated_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "kasera_enabled" INTEGER DEFAULT NULL,
  "public_web_url" TEXT DEFAULT NULL,
  "public_api_url" TEXT DEFAULT NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "chk_platform_payment_gateway_singleton" CHECK (("id" = 1))
);

CREATE TABLE IF NOT EXISTS "roles" (
  "id" INTEGER NOT NULL,
  "sekolah_id" INTEGER NOT NULL,
  "role_key" TEXT NOT NULL,
  "role_name" TEXT NOT NULL,
  "permissions" TEXT NOT NULL,
  "is_system" INTEGER NOT NULL DEFAULT '0',
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("id"),
  UNIQUE ("sekolah_id", "role_key"),
  UNIQUE ("sekolah_id", "role_name"),
  UNIQUE ("sekolah_id", "id"),
  CONSTRAINT "fk_roles_school" FOREIGN KEY ("sekolah_id") REFERENCES "schools" ("id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "scanner_devices" (
  "id" INTEGER NOT NULL,
  "sekolah_id" INTEGER NOT NULL,
  "device_name" TEXT NOT NULL,
  "api_key_hash" TEXT NOT NULL,
  "is_active" INTEGER NOT NULL DEFAULT '1',
  "last_synced_at" TEXT NULL DEFAULT NULL,
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("id"),
  UNIQUE ("api_key_hash"),
  UNIQUE ("sekolah_id", "id"),
  CONSTRAINT "fk_devices_school" FOREIGN KEY ("sekolah_id") REFERENCES "schools" ("id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "school_branding_config" (
  "sekolah_id" INTEGER NOT NULL,
  "application_name" TEXT NOT NULL,
  "logo_mime_type" TEXT DEFAULT NULL,
  "logo_data" BLOB,
  "updated_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "theme" TEXT NOT NULL DEFAULT 'current',
  PRIMARY KEY ("sekolah_id"),
  CONSTRAINT "fk_school_branding_school" FOREIGN KEY ("sekolah_id") REFERENCES "schools" ("id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "school_google_sheets_config" (
  "sekolah_id" INTEGER NOT NULL,
  "web_app_url" TEXT NOT NULL,
  "token_ciphertext" BLOB NOT NULL,
  "token_iv" BLOB NOT NULL,
  "token_auth_tag" BLOB NOT NULL,
  "is_enabled" INTEGER NOT NULL DEFAULT '1',
  "updated_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("sekolah_id"),
  CONSTRAINT "fk_school_google_sheets_school" FOREIGN KEY ("sekolah_id") REFERENCES "schools" ("id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "school_google_sheets_sync_state" (
  "sekolah_id" INTEGER NOT NULL,
  "last_synced_id" INTEGER NOT NULL DEFAULT '0',
  "attendance_payload_version" INTEGER NOT NULL DEFAULT '0',
  "last_attempt_at" TEXT DEFAULT NULL,
  "last_success_at" TEXT DEFAULT NULL,
  "last_error" TEXT DEFAULT NULL,
  PRIMARY KEY ("sekolah_id"),
  CONSTRAINT "fk_school_google_sheets_sync_state_school" FOREIGN KEY ("sekolah_id") REFERENCES "schools" ("id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "school_holidays" (
  "sekolah_id" INTEGER NOT NULL,
  "holiday_date" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "created_by" INTEGER DEFAULT NULL,
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("sekolah_id","holiday_date"),
  CONSTRAINT "fk_holidays_school" FOREIGN KEY ("sekolah_id") REFERENCES "schools" ("id") ON DELETE CASCADE,
  CONSTRAINT "fk_holidays_user" FOREIGN KEY ("sekolah_id", "created_by") REFERENCES "users" ("sekolah_id", "id")
);

CREATE TABLE IF NOT EXISTS "school_password_reset_challenges" (
  "id" TEXT NOT NULL,
  "school_code" TEXT NOT NULL,
  "sekolah_id" INTEGER DEFAULT NULL,
  "user_id" INTEGER DEFAULT NULL,
  "whatsapp_phone" TEXT NOT NULL,
  "otp_hash" BLOB NOT NULL,
  "expires_at" TEXT NOT NULL,
  "attempt_count" INTEGER NOT NULL DEFAULT '0',
  "request_ip_hash" TEXT NOT NULL,
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TEXT DEFAULT NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "fk_password_reset_school" FOREIGN KEY ("sekolah_id") REFERENCES "schools" ("id") ON DELETE CASCADE,
  CONSTRAINT "fk_password_reset_user" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS "school_registration_challenges" (
  "id" TEXT NOT NULL,
  "school_name" TEXT NOT NULL,
  "admin_name" TEXT NOT NULL,
  "admin_username" TEXT DEFAULT NULL,
  "whatsapp_phone" TEXT NOT NULL,
  "password_hash" TEXT NOT NULL,
  "otp_hash" BLOB NOT NULL,
  "expires_at" TEXT NOT NULL,
  "attempt_count" INTEGER NOT NULL DEFAULT '0',
  "request_ip_hash" TEXT NOT NULL,
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "verified_at" TEXT DEFAULT NULL,
  PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "school_subscription_expiry_reminders" (
  "id" INTEGER NOT NULL,
  "sekolah_id" INTEGER NOT NULL,
  "expires_at" TEXT NOT NULL,
  "recipient_phone" TEXT DEFAULT NULL,
  "payment_order_id" TEXT DEFAULT NULL,
  "provider_order_id" TEXT DEFAULT NULL,
  "checkout_url" TEXT DEFAULT NULL,
  "amount" INTEGER DEFAULT NULL,
  "invoice_expires_at" TEXT DEFAULT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT '0',
  "next_attempt_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_attempt_at" TEXT DEFAULT NULL,
  "last_error" TEXT DEFAULT NULL,
  "sent_at" TEXT DEFAULT NULL,
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("id"),
  UNIQUE ("sekolah_id", "expires_at"),
  UNIQUE ("payment_order_id"),
  CONSTRAINT "fk_school_expiry_reminder_school" FOREIGN KEY ("sekolah_id") REFERENCES "schools" ("id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "school_whatsapp_gateway_config" (
  "sekolah_id" INTEGER NOT NULL,
  "endpoint_url" TEXT DEFAULT NULL,
  "token_ciphertext" BLOB DEFAULT NULL,
  "token_iv" BLOB DEFAULT NULL,
  "token_auth_tag" BLOB DEFAULT NULL,
  "is_enabled" INTEGER NOT NULL DEFAULT '0',
  "updated_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_test_at" TEXT DEFAULT NULL,
  "last_test_status" TEXT DEFAULT NULL,
  "last_test_message" TEXT DEFAULT NULL,
  PRIMARY KEY ("sekolah_id"),
  CONSTRAINT "fk_school_whatsapp_gateway_school" FOREIGN KEY ("sekolah_id") REFERENCES "schools" ("id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "schools" (
  "id" INTEGER NOT NULL,
  "slug" TEXT NOT NULL,
  "school_code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "billing_email" TEXT DEFAULT NULL,
  "subscription_status" TEXT NOT NULL DEFAULT 'trial',
  "trial_ends_at" TEXT DEFAULT NULL,
  "subscription_expires_at" TEXT DEFAULT NULL,
  "participant_quota" INTEGER NOT NULL DEFAULT '500',
  "timezone" TEXT NOT NULL DEFAULT 'Asia/Jakarta',
  "is_active" INTEGER NOT NULL DEFAULT '1',
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("id"),
  UNIQUE ("slug"),
  UNIQUE ("school_code"),
  CONSTRAINT "chk_school_code_format" CHECK ("school_code" GLOB '[0-9][0-9][0-9][0-9]')
);

CREATE TABLE IF NOT EXISTS "subscription_payment_orders" (
  "id" TEXT NOT NULL,
  "sekolah_id" INTEGER NOT NULL,
  "order_id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "plan" TEXT NOT NULL,
  "amount" INTEGER NOT NULL,
  "payment_method" TEXT DEFAULT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "provider_reference" TEXT DEFAULT NULL,
  "checkout_url" TEXT DEFAULT NULL,
  "expires_at" TEXT DEFAULT NULL,
  "paid_at" TEXT DEFAULT NULL,
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("id"),
  UNIQUE ("order_id"),
  CONSTRAINT "fk_subscription_payment_school" FOREIGN KEY ("sekolah_id") REFERENCES "schools" ("id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "super_admin_password_reset_challenges" (
  "id" TEXT NOT NULL,
  "super_admin_id" INTEGER DEFAULT NULL,
  "username" TEXT NOT NULL,
  "whatsapp_phone" TEXT NOT NULL,
  "otp_hash" BLOB NOT NULL,
  "expires_at" TEXT NOT NULL,
  "attempt_count" INTEGER NOT NULL DEFAULT '0',
  "request_ip_hash" TEXT NOT NULL,
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TEXT DEFAULT NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "fk_super_admin_reset_admin" FOREIGN KEY ("super_admin_id") REFERENCES "super_admins" ("id") ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS "super_admins" (
  "id" INTEGER NOT NULL,
  "username" TEXT NOT NULL,
  "display_name" TEXT NOT NULL,
  "password_hash" TEXT NOT NULL,
  "whatsapp_phone" TEXT DEFAULT NULL,
  "auth_version" INTEGER NOT NULL DEFAULT '0',
  "is_active" INTEGER NOT NULL DEFAULT '1',
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("id"),
  UNIQUE ("username"),
  UNIQUE ("whatsapp_phone")
);

CREATE TABLE IF NOT EXISTS "units" (
  "id" INTEGER NOT NULL,
  "sekolah_id" INTEGER NOT NULL,
  "name" TEXT NOT NULL,
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("id"),
  UNIQUE ("sekolah_id", "name"),
  UNIQUE ("sekolah_id", "id"),
  CONSTRAINT "fk_units_school" FOREIGN KEY ("sekolah_id") REFERENCES "schools" ("id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "users" (
  "id" INTEGER NOT NULL,
  "sekolah_id" INTEGER NOT NULL,
  "role_id" INTEGER NOT NULL,
  "classroom_id" INTEGER DEFAULT NULL,
  "username" TEXT NOT NULL,
  "display_name" TEXT NOT NULL,
  "whatsapp_phone" TEXT DEFAULT NULL,
  "password_hash" TEXT NOT NULL,
  "auth_version" INTEGER NOT NULL DEFAULT '0',
  "is_active" INTEGER NOT NULL DEFAULT '1',
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("id"),
  UNIQUE ("sekolah_id", "username"),
  UNIQUE ("sekolah_id", "id"),
  UNIQUE ("sekolah_id", "whatsapp_phone"),
  CONSTRAINT "fk_users_classroom" FOREIGN KEY ("sekolah_id", "classroom_id") REFERENCES "classrooms" ("sekolah_id", "id"),
  CONSTRAINT "fk_users_role" FOREIGN KEY ("sekolah_id", "role_id") REFERENCES "roles" ("sekolah_id", "id"),
  CONSTRAINT "fk_users_school" FOREIGN KEY ("sekolah_id") REFERENCES "schools" ("id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "weekly_operational_schedules" (
  "sekolah_id" INTEGER NOT NULL,
  "weekday" INTEGER NOT NULL,
  "is_working_day" INTEGER NOT NULL DEFAULT '1',
  "check_in_deadline" TEXT NOT NULL DEFAULT '08:00:00',
  "lateness_tolerance_minutes" INTEGER NOT NULL DEFAULT '0',
  "check_out_start" TEXT NOT NULL DEFAULT '15:00:00',
  PRIMARY KEY ("sekolah_id","weekday"),
  CONSTRAINT "fk_weekly_schedule_school" FOREIGN KEY ("sekolah_id") REFERENCES "schools" ("id") ON DELETE CASCADE,
  CONSTRAINT "chk_weekly_schedule_tolerance" CHECK (("lateness_tolerance_minutes" <= 180)),
  CONSTRAINT "chk_weekly_schedule_weekday" CHECK (("weekday" between 0 and 6))
);

CREATE TABLE IF NOT EXISTS "whatsapp_gateway_config" (
  "id" INTEGER NOT NULL,
  "endpoint_url" TEXT DEFAULT NULL,
  "token_ciphertext" BLOB DEFAULT NULL,
  "token_iv" BLOB DEFAULT NULL,
  "token_auth_tag" BLOB DEFAULT NULL,
  "is_enabled" INTEGER NOT NULL DEFAULT '0',
  "updated_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_test_at" TEXT DEFAULT NULL,
  "last_test_status" TEXT DEFAULT NULL,
  "last_test_message" TEXT DEFAULT NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "chk_whatsapp_gateway_singleton" CHECK (("id" = 1))
);

CREATE INDEX IF NOT EXISTS "activity_logs_fk_activity_user" ON "activity_logs" ("sekolah_id", "actor_user_id");

CREATE INDEX IF NOT EXISTS "activity_logs_idx_activity_entity" ON "activity_logs" ("sekolah_id", "entity_type", "entity_id", "created_at");

CREATE INDEX IF NOT EXISTS "activity_logs_idx_activity_school_created" ON "activity_logs" ("sekolah_id", "created_at", "id");

CREATE INDEX IF NOT EXISTS "attendance_exceptions_fk_exception_user" ON "attendance_exceptions" ("sekolah_id", "recorded_by");

CREATE INDEX IF NOT EXISTS "attendance_logs_fk_attendance_device" ON "attendance_logs" ("sekolah_id", "device_id");

CREATE INDEX IF NOT EXISTS "attendance_logs_fk_attendance_user" ON "attendance_logs" ("sekolah_id", "recorded_by");

CREATE INDEX IF NOT EXISTS "attendance_logs_idx_attendance_report" ON "attendance_logs" ("sekolah_id", "attendance_date", "participant_id");

CREATE INDEX IF NOT EXISTS "attendance_logs_idx_attendance_school_participant" ON "attendance_logs" ("sekolah_id", "participant_id");

CREATE INDEX IF NOT EXISTS "attendance_logs_idx_attendance_status" ON "attendance_logs" ("sekolah_id", "attendance_date", "attendance_status");

CREATE INDEX IF NOT EXISTS "operational_settings_fk_operational_settings_user" ON "operational_settings" ("sekolah_id", "updated_by");

CREATE INDEX IF NOT EXISTS "participant_late_notifications_fk_late_notification_school" ON "participant_late_notifications" ("sekolah_id");

CREATE INDEX IF NOT EXISTS "participant_late_notifications_idx_late_notification_due" ON "participant_late_notifications" ("status", "next_attempt_at", "id");

CREATE INDEX IF NOT EXISTS "participants_idx_participants_classroom" ON "participants" ("sekolah_id", "classroom_id", "is_active");

CREATE INDEX IF NOT EXISTS "platform_audit_logs_idx_platform_audit_admin_created" ON "platform_audit_logs" ("super_admin_id", "id");

CREATE INDEX IF NOT EXISTS "school_holidays_fk_holidays_user" ON "school_holidays" ("sekolah_id", "created_by");

CREATE INDEX IF NOT EXISTS "school_password_reset_challenges_fk_password_reset_school" ON "school_password_reset_challenges" ("sekolah_id");

CREATE INDEX IF NOT EXISTS "school_password_reset_challenges_idx_password_reset_expiry" ON "school_password_reset_challenges" ("expires_at");

CREATE INDEX IF NOT EXISTS "school_password_reset_challenges_idx_password_reset_ip_created" ON "school_password_reset_challenges" ("request_ip_hash", "created_at");

CREATE INDEX IF NOT EXISTS "school_password_reset_challenges_idx_password_reset_phone_created" ON "school_password_reset_challenges" ("whatsapp_phone", "created_at");

CREATE INDEX IF NOT EXISTS "school_password_reset_challenges_idx_password_reset_user_created" ON "school_password_reset_challenges" ("user_id", "created_at");

CREATE INDEX IF NOT EXISTS "school_registration_challenges_idx_registration_expiry" ON "school_registration_challenges" ("expires_at");

CREATE INDEX IF NOT EXISTS "school_registration_challenges_idx_registration_ip_created" ON "school_registration_challenges" ("request_ip_hash", "created_at");

CREATE INDEX IF NOT EXISTS "school_registration_challenges_idx_registration_phone_created" ON "school_registration_challenges" ("whatsapp_phone", "created_at");

CREATE INDEX IF NOT EXISTS "school_subscription_expiry_reminders_idx_school_expiry_reminder_due" ON "school_subscription_expiry_reminders" ("status", "next_attempt_at", "id");

CREATE INDEX IF NOT EXISTS "subscription_payment_orders_idx_subscription_payment_school" ON "subscription_payment_orders" ("sekolah_id", "created_at");

CREATE INDEX IF NOT EXISTS "subscription_payment_orders_idx_subscription_payment_status" ON "subscription_payment_orders" ("status", "created_at");

CREATE INDEX IF NOT EXISTS "super_admin_password_reset_challenges_idx_super_admin_reset_admin_created" ON "super_admin_password_reset_challenges" ("super_admin_id", "created_at");

CREATE INDEX IF NOT EXISTS "super_admin_password_reset_challenges_idx_super_admin_reset_expiry" ON "super_admin_password_reset_challenges" ("expires_at");

CREATE INDEX IF NOT EXISTS "super_admin_password_reset_challenges_idx_super_admin_reset_ip_created" ON "super_admin_password_reset_challenges" ("request_ip_hash", "created_at");

CREATE INDEX IF NOT EXISTS "super_admin_password_reset_challenges_idx_super_admin_reset_phone_created" ON "super_admin_password_reset_challenges" ("whatsapp_phone", "created_at");

CREATE INDEX IF NOT EXISTS "users_fk_users_classroom" ON "users" ("sekolah_id", "classroom_id");

CREATE INDEX IF NOT EXISTS "users_idx_users_role" ON "users" ("sekolah_id", "role_id");

INSERT OR IGNORE INTO platform_branding (id) VALUES (1);

INSERT OR IGNORE INTO whatsapp_gateway_config (id) VALUES (1);

INSERT OR IGNORE INTO platform_billing_settings (id) VALUES (1);

INSERT OR IGNORE INTO platform_payment_gateway_settings (id) VALUES (1);

INSERT OR IGNORE INTO platform_backup_settings (id) VALUES (1);

INSERT OR IGNORE INTO platform_otp_rate_limit_settings (id) VALUES (1);

INSERT OR IGNORE INTO platform_download_settings (id) VALUES (1);
