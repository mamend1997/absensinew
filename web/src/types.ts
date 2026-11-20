export type Role = 'admin' | 'operator';

export interface User {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  classroomId: string | null;
}

export interface Participant {
  id: string;
  participant_code: string;
  full_name: string;
  classroom_id: string;
  classroom_name: string;
  unit_id: string;
  unit_name: string;
  qr_code: string;
  guardian_phone?: string | null;
  is_active: boolean | number;
  updated_at?: string;
}

export interface Settings {
  id: number;
  timezone: string;
  check_in_deadline: string;
  lateness_tolerance_minutes: number;
  check_out_start: string;
  scan_welcome_message: string;
  scan_success_message: string;
  scan_failure_message: string;
  weekly_schedules?: WeeklySchedule[];
  participant_overrides?: ParticipantDayOverride[];
  updated_at?: string;
}

export interface WeeklySchedule {
  weekday: number;
  is_working_day: boolean | number;
  check_in_deadline: string;
  lateness_tolerance_minutes: number;
  check_out_start: string;
}

export interface ParticipantDayOverride {
  participant_id: string | number;
  participant_name?: string;
  weekday: number;
  check_in_deadline: string;
}

export type AttendanceMode = 'otomatis' | 'masuk' | 'pulang';
export type AttendanceStatus = 'hadir' | 'terlambat' | 'pulang';
export type ScanMethod = 'SCAN_QR' | 'MANUAL_INPUT';

export interface SyncRecord {
  id_unik: string;
  id_peserta: number;
  jenis_absen: 'masuk' | 'pulang';
  client_timestamp: string;
  status_kehadiran: AttendanceStatus;
  menit_terlambat: number;
  scan_method?: ScanMethod;
}

export interface QueuedScan extends SyncRecord {
  attendance_date: string;
  participant_name: string;
  participant_code: string;
  classroom_name: string;
  status_sync: 'pending' | 'synced';
}

export interface ReportRow {
  attendance_date: string;
  participant_id: string;
  participant_code: string;
  participant_name: string;
  classroom_id: string;
  classroom_name: string;
  unit_id: string;
  unit_name: string;
  status_kehadiran: AttendanceStatus | 'belum_hadir';
  menit_terlambat: number;
  masuk_at: string | null;
  pulang_at: string | null;
  scan_method?: ScanMethod | null;
  checkout_scan_method?: ScanMethod | null;
}

export interface ReportResponse {
  filters: { start_date: string; end_date: string };
  summary: {
    hadir_tepat_waktu: number;
    terlambat: number;
    total_menit_terlambat: number;
    pulang: number;
    belum_hadir: number;
  };
  rows: ReportRow[];
}
