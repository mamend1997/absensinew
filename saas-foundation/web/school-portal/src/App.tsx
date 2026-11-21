import { TextToSpeech } from '@capacitor-community/text-to-speech';
import { BrowserMultiFormatReader } from '@zxing/browser';
import { Capacitor } from '@capacitor/core';
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import QRCode from 'qrcode';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  calculateAttendance,
  createQueuedScan,
} from './core/attendance.js';
import { createOfflineSyncManager } from './core/offline-sync.js';

const API_BASE = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '');
const DEFAULT_WHATSAPP_GATEWAY_URL = 'https://gateway-production-a1168195.up.railway.app/api/send-message';
const SESSION_KEY = 'saas_school_session';
const EXCELJS_CHUNK_RELOAD_KEY = 'saas_school_exceljs_chunk_reloaded';

window.addEventListener('vite:preloadError', (event) => {
  event.preventDefault();
  if (sessionStorage.getItem(EXCELJS_CHUNK_RELOAD_KEY)) {
    sessionStorage.removeItem(EXCELJS_CHUNK_RELOAD_KEY);
    return;
  }
  sessionStorage.setItem(EXCELJS_CHUNK_RELOAD_KEY, '1');
  window.location.reload();
});

async function loadExcelJS() {
  const { default: ExcelJS } = await import('exceljs');
  sessionStorage.removeItem(EXCELJS_CHUNK_RELOAD_KEY);
  return ExcelJS;
}

type Page = 'dashboard' | 'scanner' | 'reports' | 'participants' | 'settings' | 'roles' | 'downloads' | 'billing';
type Permission =
  | 'dashboard.read'
  | 'dashboard.view'
  | 'attendance.read'
  | 'attendance.view'
  | 'attendance.export'
  | 'attendance.edit'
  | 'participants.read'
  | 'participants.view'
  | 'participants.manage'
  | 'participants.edit'
  | 'participants.delete'
  | 'participants.qr.print'
  | 'settings.operational.manage'
  | 'settings.operational.view'
  | 'settings.operational.edit'
  | 'attendance.excuse.manage'
  | 'scanner.use'
  | 'school.users.manage'
  | 'school.users.view'
  | 'school.users.edit'
  | 'school.users.delete'
  | 'school.roles.manage'
  | 'school.roles.view'
  | 'school.roles.edit'
  | 'school.roles.delete';
type RoleAction = 'view' | 'edit' | 'delete';
interface RolePermissionGroup {
  key: string;
  label: string;
  view: Permission;
  edit?: Permission;
  delete?: Permission;
}
interface GoogleSheetsSettings {
  web_app_url: string;
  is_enabled: boolean;
  is_configured: boolean;
  secret_hint: string;
  last_sync_at: string | null;
  sync_error: string | null;
}
type SchoolTheme = 'current' | 'orange' | 'white';
interface SchoolBranding {
  application_name: string;
  logo_data_url: string | null;
  theme: SchoolTheme;
}
function schoolThemeFromValue(value: string): SchoolTheme | null {
  switch (value) {
    case 'current':
    case 'orange':
    case 'white':
      return value;
    default:
      return null;
  }
}
const ROLE_PERMISSION_GROUPS: RolePermissionGroup[] = [
  { key: 'dashboard', label: 'Ringkasan', view: 'dashboard.view' },
  { key: 'attendance', label: 'Rekap absensi', view: 'attendance.view', edit: 'attendance.edit' },
  { key: 'participants', label: 'Peserta & kelas', view: 'participants.view', edit: 'participants.edit', delete: 'participants.delete' },
  { key: 'settings', label: 'Pengaturan', view: 'settings.operational.view', edit: 'settings.operational.edit' },
  { key: 'users', label: 'Akun sekolah', view: 'school.users.view', edit: 'school.users.edit', delete: 'school.users.delete' },
  { key: 'roles', label: 'Role & izin', view: 'school.roles.view', edit: 'school.roles.edit', delete: 'school.roles.delete' },
  { key: 'scanner', label: 'Scanner', view: 'scanner.use' },
];
const LEGACY_PERMISSION_EXPANSIONS: Partial<Record<Permission, Permission[]>> = {
  'dashboard.read': ['dashboard.view'],
  'attendance.read': ['attendance.view'],
  'attendance.excuse.manage': ['attendance.edit'],
  'participants.read': ['participants.view'],
  'participants.manage': ['participants.view', 'participants.edit', 'participants.delete'],
  'settings.operational.manage': ['settings.operational.view', 'settings.operational.edit'],
  'school.users.manage': ['school.users.view', 'school.users.edit', 'school.users.delete'],
  'school.roles.manage': ['school.roles.view', 'school.roles.edit', 'school.roles.delete'],
};
const LEGACY_PERMISSION_KEYS = new Set(Object.keys(LEGACY_PERMISSION_EXPANSIONS));
const VIEW_PERMISSION_DEPENDENCIES: Partial<Record<Permission, Permission[]>> = {
  'attendance.export': ['attendance.view'],
  'attendance.edit': ['attendance.view'],
  'participants.edit': ['participants.view'],
  'participants.delete': ['participants.view'],
  'settings.operational.edit': ['settings.operational.view'],
  'school.users.edit': ['school.users.view', 'school.roles.view'],
  'school.users.delete': ['school.users.view'],
  'school.roles.edit': ['school.roles.view'],
  'school.roles.delete': ['school.roles.view'],
};

function normalizeRolePermissions(value: unknown): Permission[] {
  const permissions = new Set(Array.isArray(value)
    ? value.filter((permission): permission is Permission => typeof permission === 'string')
    : []);
  for (const [legacy, expanded] of Object.entries(LEGACY_PERMISSION_EXPANSIONS)) {
    if (permissions.has(legacy as Permission)) {
      for (const permission of expanded ?? []) permissions.add(permission);
    }
    for (const [permission, dependencies] of Object.entries(VIEW_PERMISSION_DEPENDENCIES)) {
      if (permissions.has(permission as Permission)) {
        for (const dependency of dependencies ?? []) permissions.add(dependency);
      }
    }
  }
  return [...permissions];
}

function hasPermission(permissions: Permission[], permission: Permission): boolean {
  return normalizeRolePermissions(permissions).includes(permission);
}

function currentRolePermissions(permissions: Permission[]): Permission[] {
  return permissions.filter((permission) => !LEGACY_PERMISSION_KEYS.has(permission));
}

function updateRolePermission(
  permissions: Permission[],
  group: RolePermissionGroup,
  action: RoleAction,
  enabled: boolean,
): Permission[] {
  const next = new Set(currentRolePermissions(normalizeRolePermissions(permissions)));
  const permission = group[action];
  if (!permission) return [...next];
  if (enabled) {
    next.add(permission);
    if (action !== 'view') next.add(group.view);
    if (group.key === 'attendance' && action === 'edit') next.add('attendance.export');
  } else {
    next.delete(permission);
    if (group.key === 'attendance' && action === 'edit') next.delete('attendance.export');
    if (action === 'view') {
      if (group.edit) next.delete(group.edit);
      if (group.delete) next.delete(group.delete);
      if (group.key === 'attendance') next.delete('attendance.export');
    }
  }
  return [...next];
}

interface SchoolInfo {
  id: string | number;
  name: string;
  school_code: string;
  subscription_status?: string;
  subscription_expired?: boolean;
}
interface UserInfo {
  id: string | number;
  display_name: string;
  role_name: string;
  role_key?: string;
  permissions: Permission[];
}
interface SchoolSession { token: string; school: SchoolInfo; user: UserInfo }
interface BillingData {
  billing_email: string | null;
  subscription: { status: string; trial_ends_at: string | null; expires_at: string | null; expired: boolean };
  prices: { monthly: number; lifetime: number };
  providers: { xendit: boolean; duitku: boolean; kasera: boolean };
  orders: Array<{
    order_id: string;
    provider: 'xendit' | 'duitku' | 'kasera';
    plan: 'monthly' | 'lifetime';
    amount: number;
    payment_method: string | null;
    status: 'pending' | 'paid' | 'expired' | 'failed';
    checkout_url: string | null;
    created_at: string;
  }>;
}
interface PaymentMethod { code: string; name: string; fee: number }
interface Participant {
  id: string;
  participant_code: string;
  full_name: string;
  classroom_id: string;
  classroom_name: string;
  qr_code: string;
  participant_phone?: string | null;
  is_active?: boolean | number | string;
}
interface Classroom { id: string; name: string; unit_id: string; unit_name?: string }
interface WeeklySchedule {
  weekday: number;
  is_working_day: boolean | number;
  check_in_deadline: string;
  lateness_tolerance_minutes: number;
  check_out_start: string;
}
interface Holiday { date: string; name: string }
interface OperationalSettings {
  timezone: string;
  check_in_deadline: string;
  lateness_tolerance_minutes: number;
  check_out_start: string;
  scan_welcome_message: string;
  scan_success_message: string;
  scan_failure_message: string;
  weekly_schedules: WeeklySchedule[];
  holidays: Holiday[];
  participant_overrides: ParticipantSchedule[];
  scanner_pin_configured?: boolean;
}
interface ParticipantSchedule {
  participant_id: string | number;
  weekday: number;
  check_in_deadline: string;
}
interface ParticipantImportResult {
  imported: number;
  skipped: number;
  results: Array<{
    row: number;
    participant_code?: string;
    status: 'imported' | 'skipped';
    reason?: string;
  }>;
}
interface ParticipantImportDraft {
  source_row: string;
  participant_code: string;
  full_name: string;
  classroom_id: string;
  qr_code: string;
  participant_phone: string;
}
interface ReportRow {
  attendance_date: string;
  participant_id: string;
  participant_name: string;
  participant_code: string;
  classroom_name: string;
  check_in_at?: string | null;
  check_out_at?: string | null;
  attendance_status?: string;
  late_minutes?: number;
  menit_terlambat?: number;
}
interface MonthlyReportRow extends ReportRow {
  monthly_attendance_count: number;
  monthly_late_minutes: number;
}
interface SchoolWhatsappGatewaySettings {
  endpoint_url: string;
  is_enabled: boolean;
  is_configured: boolean;
  token_hint: string;
  last_test_at: string | null;
  last_test_status: 'success' | 'failed' | null;
  last_test_message: string | null;
}
interface QueuedScan {
  id_unik: string;
  sekolah_id: string;
  id_peserta: string;
  participant_name?: string;
  id_perangkat: string | null;
  jenis_absen: 'check_in' | 'check_out';
  scan_method?: 'SCAN_QR' | 'MANUAL_INPUT';
  attendance_date: string;
  client_timestamp: string;
  status_kehadiran: string;
  menit_terlambat: number;
  status_sync: 'pending' | 'synced';
}
interface ScannerPreferences {
  cameraFacing: 'user' | 'environment';
  scanSpeed: 'fast' | 'balanced';
  usbScannerEnabled: boolean;
}
interface ScannerCache extends DBSchema {
  participants: { key: string; value: Participant };
  settings: { key: string; value: OperationalSettings };
  scannerPreferences: { key: string; value: ScannerPreferences };
  queue: {
    key: string;
    value: QueuedScan;
    indexes: { 'by-status': QueuedScan['status_sync'] };
  };
}
interface ScanResult { date: string; status: string | null; lateMinutes: number; reason?: string }
type LoginView = 'login' | 'register' | 'verify' | 'forgot-password' | 'reset-password';
interface ConfirmationDialog {
  title: string;
  message: string;
  confirmLabel: string;
}

const initialRegistrationForm = {
  school_name: '',
  username: '',
  whatsapp_phone: '',
  password: '',
};

const initialPasswordResetForm = {
  school_code: '',
  whatsapp_phone: '',
  otp: '',
  password: '',
};

const initialSettings: OperationalSettings = {
  timezone: 'Asia/Jakarta',
  check_in_deadline: '08:00:00',
  lateness_tolerance_minutes: 0,
  check_out_start: '15:00:00',
  scan_welcome_message: 'Pindai kartu atau barcode peserta saat melaksanakan absensi',
  scan_success_message: 'Terima kasih, {name}. Absensi {status} sudah dicatat.',
  scan_failure_message: 'Maaf, absensi {name} gagal. {reason}.',
  weekly_schedules: [],
  holidays: [],
  participant_overrides: [],
};
const initialScannerPreferences: ScannerPreferences = {
  cameraFacing: 'user',
  scanSpeed: 'fast',
  usbScannerEnabled: true,
};
const weekDays = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
const initialDate = new Date().toISOString().slice(0, 10);

function readSession(): SchoolSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY) ?? sessionStorage.getItem(SESSION_KEY);
    if (raw) localStorage.setItem(SESSION_KEY, raw);
    sessionStorage.removeItem(SESSION_KEY);
    return raw ? JSON.parse(raw) as SchoolSession : null;
  } catch (error) {
    console.error('Sesi sekolah lokal tidak dapat dibaca.', error);
    localStorage.removeItem(SESSION_KEY);
    sessionStorage.removeItem(SESSION_KEY);
    return null;
  }
}

function initialPage(currentSession: SchoolSession): Page {
  if (currentSession.school.subscription_expired ||
      new URLSearchParams(window.location.search).get('billing') === 'return') return 'billing';
  const permissions = currentSession.user.permissions;
  return hasPermission(permissions, 'scanner.use') &&
    (!hasPermission(permissions, 'dashboard.view') || window.matchMedia('(max-width: 900px)').matches)
    ? 'scanner'
    : 'dashboard';
}

function playAttendanceTone(success: boolean) {
  const fileName = success ? 'berhasil.wav' : 'gagal.wav';
  const audio = new Audio(`/audio/${fileName}`);
  audio.volume = 1;

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let timeout = 0;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      audio.removeEventListener('ended', finish);
      audio.removeEventListener('error', onError);
      resolve();
    };
    const onError = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      audio.removeEventListener('ended', finish);
      audio.removeEventListener('error', onError);
      audio.pause();
      reject(new Error(`File suara ${fileName} gagal diputar.`));
    };

    audio.addEventListener('ended', finish, { once: true });
    audio.addEventListener('error', onError, { once: true });
    timeout = window.setTimeout(() => {
      audio.pause();
      finish();
    }, 5000);
    void audio.play().catch(onError);
  });
}

function attendanceMessage(
  template: string,
  values: { name: string; status: string; reason: string },
) {
  return template.replace(/\{(name|status|reason)\}/gi, (_match, key: string) =>
    values[key.toLowerCase() as keyof typeof values] ?? '',
  );
}

function normalizeScanCode(value: unknown) {
  return String(value ?? '').normalize('NFKC').trim();
}

function isActiveParticipant(participant: Participant) {
  const active = participant.is_active;
  return active == null || active === true || active === 1 ||
    (typeof active === 'string' && ['1', 'true'].includes(active.toLowerCase()));
}

function findParticipantByScanCode(participants: Participant[], rawCode: string) {
  const code = normalizeScanCode(rawCode);
  const activeParticipants = participants.filter(isActiveParticipant);
  const exactMatches = activeParticipants.filter((participant) =>
    [participant.qr_code, participant.participant_code]
      .some((candidate) => normalizeScanCode(candidate) === code));
  if (exactMatches.length > 1) {
    throw new Error('QR/barcode ini terdaftar pada lebih dari satu peserta.');
  }
  if (exactMatches.length === 1) return exactMatches[0];

  const foldedCode = code.toLocaleUpperCase('id-ID');
  const caseInsensitiveMatches = activeParticipants.filter((participant) =>
    [participant.qr_code, participant.participant_code]
      .some((candidate) => normalizeScanCode(candidate).toLocaleUpperCase('id-ID') === foldedCode));
  if (caseInsensitiveMatches.length > 1) {
    throw new Error('QR/barcode cocok dengan lebih dari satu peserta.');
  }
  return caseInsensitiveMatches[0];
}

async function speakAttendanceMessage(text: string) {
  if (Capacitor.isNativePlatform()) {
    await TextToSpeech.speak({
      text,
      lang: 'id-ID',
      rate: 0.92,
      pitch: 1.05,
      volume: 1,
      queueStrategy: 0,
    });
    return;
  }

  if (!('speechSynthesis' in window) || !('SpeechSynthesisUtterance' in window)) {
    throw new Error('TTS tidak tersedia pada perangkat ini.');
  }

  const synthesis = window.speechSynthesis;
  synthesis.cancel();
  let voices = synthesis.getVoices();
  if (!voices.length) {
    voices = await new Promise<SpeechSynthesisVoice[]>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        synthesis.removeEventListener('voiceschanged', finish);
        resolve(synthesis.getVoices());
      };
      const timeout = window.setTimeout(finish, 1000);
      synthesis.addEventListener('voiceschanged', finish, { once: true });
    });
  }

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'id-ID';
  utterance.rate = 0.92;
  utterance.pitch = 1.05;
  utterance.volume = 1;
  utterance.voice = voices.find((voice) => voice.lang.toLowerCase().startsWith('id')) ?? null;

  await new Promise<void>((resolve, reject) => {
    utterance.onend = () => resolve();
    utterance.onerror = (event) => reject(new Error(`TTS gagal diputar: ${event.error}.`));
    synthesis.speak(utterance);
  });
}

async function announceAttendance(message: string, success: boolean) {
  try {
    await playAttendanceTone(success);
  } catch (error) {
    console.warn('Suara notifikasi absensi tidak dapat diputar.', error);
  }

  try {
    await speakAttendanceMessage(message);
  } catch (error) {
    console.warn('Ucapan absensi tidak dapat diputar.', error);
  }
}

class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(
  path: string,
  token?: string,
  options: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
    signal?: AbortSignal;
  } = {},
): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: options.method ?? 'GET',
    signal: options.signal,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...options.headers,
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const apiError = payload.error;
    const errorDetails = apiError && typeof apiError === 'object'
      ? apiError as Record<string, unknown>
      : null;
    const message = typeof apiError === 'string'
      ? apiError
      : typeof errorDetails?.message === 'string'
        ? errorDetails.message
        : `Permintaan gagal (${response.status}).`;
    const code = typeof errorDetails?.code === 'string' ? errorDetails.code : 'REQUEST_ERROR';
    throw new ApiError(message, response.status, code);
  }
  return payload as T;
}

function unwrapArray<T>(payload: unknown, key: string): T[] {
  if (Array.isArray(payload)) return payload as T[];
  if (payload && typeof payload === 'object') {
    const value = (payload as Record<string, unknown>)[key];
    if (Array.isArray(value)) return value as T[];
  }
  return [];
}

function PasswordEye({ visible }: { visible: boolean }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M2.5 12s3.2-6 9.5-6 9.5 6 9.5 6-3.2 6-9.5 6-9.5-6-9.5-6Z" />
      <circle cx="12" cy="12" r="2.7" />
      {!visible && <path d="m4 4 16 16" />}
    </svg>
  );
}

function database(schoolId: string | number): Promise<IDBPDatabase<ScannerCache>> {
  if (!('indexedDB' in window)) throw new Error('Penyimpanan lokal tidak tersedia pada browser ini.');
  return openDB<ScannerCache>(`saas-school-${schoolId}`, 3, {
    upgrade(db, oldVersion) {
      if (oldVersion < 1) {
        db.createObjectStore('participants', { keyPath: 'id' });
        const queue = db.createObjectStore('queue', { keyPath: 'id_unik' });
        queue.createIndex('by-status', 'status_sync');
      }
      if (oldVersion < 2) db.createObjectStore('settings');
      if (oldVersion < 3) db.createObjectStore('scannerPreferences');
    },
  });
}

function toLocalTime(value?: string | null) {
  if (!value) return '—';
  const timestamp = /(?:Z|[+-]\d{2}:\d{2})$/i.test(value)
    ? value
    : `${value.replace(' ', 'T')}Z`;
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
}

function csvCell(value: unknown) {
  const text = String(value ?? '');
  return `"${text.replace(/"/g, '""')}"`;
}

function phoneNationalDigits(value: string) {
  const digits = value.replace(/\D/g, '');
  const national = digits.startsWith('62') ? digits.slice(2) : digits.replace(/^0+/, '');
  return national.slice(0, 13);
}

function rupiah(value: number) {
  return new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    maximumFractionDigits: 0,
  }).format(value);
}

function aggregateMonthlyReport(rows: ReportRow[]): MonthlyReportRow[] {
  const totals = new Map<string, { attendanceCount: number; lateMinutes: number }>();
  for (const row of rows) {
    const total = totals.get(row.participant_id) ?? { attendanceCount: 0, lateMinutes: 0 };
    if (row.check_in_at) total.attendanceCount += 1;
    total.lateMinutes += Number(row.late_minutes ?? row.menit_terlambat ?? 0);
    totals.set(row.participant_id, total);
  }
  return rows.map((row) => {
    const total = totals.get(row.participant_id) ?? { attendanceCount: 0, lateMinutes: 0 };
    return {
      ...row,
      monthly_attendance_count: total.attendanceCount,
      monthly_late_minutes: total.lateMinutes,
    };
  });
}

function downloadReport(
  rows: MonthlyReportRow[],
  period: 'daily' | 'monthly',
  periodValue: string,
) {
  const headers = period === 'daily'
    ? ['No', 'Nama', 'Kelas', 'Tanggal', 'Masuk', 'Menit telat', 'Keluar']
    : ['No', 'Nama', 'Kelas', 'Tanggal', 'Masuk', 'Menit telat', 'Keluar', 'Total kehadiran bulanan', 'Total menit telat bulanan'];
  const table = [
    headers,
    ...rows.map((row, index) => {
      const dailyColumns = [
        index + 1,
        row.participant_name,
        row.classroom_name,
        row.attendance_date,
        row.check_in_at ? toLocalTime(row.check_in_at) : '',
        row.late_minutes ?? row.menit_terlambat ?? 0,
        row.check_out_at ? toLocalTime(row.check_out_at) : '',
      ];
      return period === 'daily'
        ? dailyColumns
        : [...dailyColumns, row.monthly_attendance_count, row.monthly_late_minutes];
    }),
  ];
  const blob = new Blob(
    [`\uFEFF${table.map((row) => row.map(csvCell).join(';')).join('\r\n')}`],
    { type: 'text/csv;charset=utf-8' },
  );
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `rekap-absensi-${period}-${periodValue}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

export default function App() {
  const [session, setSession] = useState<SchoolSession | null>(readSession);
  const [applicationName, setApplicationName] = useState('Ruang Hadir');
  const [schoolBranding, setSchoolBranding] = useState<SchoolBranding | null>(null);
  const [schoolBrandingName, setSchoolBrandingName] = useState('');
  const [schoolLogoUpload, setSchoolLogoUpload] = useState('');
  const [schoolBrandingBusy, setSchoolBrandingBusy] = useState(false);
  const [schoolBackupBusy, setSchoolBackupBusy] = useState(false);
  const [schoolRestoreFile, setSchoolRestoreFile] = useState<File | null>(null);
  const [schoolRestoreConfirmation, setSchoolRestoreConfirmation] = useState('');
  const [page, setPage] = useState<Page>(() =>
    new URLSearchParams(window.location.search).get('billing') === 'return' ? 'billing' : 'dashboard');
  const [loginView, setLoginView] = useState<LoginView>('login');
  const [loginForm, setLoginForm] = useState({ school_code: '', username: '', password: '' });
  const [registrationForm, setRegistrationForm] = useState(initialRegistrationForm);
  const [registrationChallengeId, setRegistrationChallengeId] = useState('');
  const [registrationOtp, setRegistrationOtp] = useState('');
  const [passwordResetForm, setPasswordResetForm] = useState(initialPasswordResetForm);
  const [passwordResetChallengeId, setPasswordResetChallengeId] = useState('');
  const [showLoginPassword, setShowLoginPassword] = useState(false);
  const [showRegistrationPassword, setShowRegistrationPassword] = useState(false);
  const [showResetPassword, setShowResetPassword] = useState(false);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [classrooms, setClassrooms] = useState<Classroom[]>([]);
  const [settings, setSettings] = useState<OperationalSettings>(initialSettings);
  const [scheduleParticipantId, setScheduleParticipantId] = useState('');
  const [scheduleOverrides, setScheduleOverrides] = useState<Record<number, string>>({});
  const [participantImportResult, setParticipantImportResult] = useState<ParticipantImportResult | null>(null);
  const [participantImportPreview, setParticipantImportPreview] = useState<ParticipantImportDraft[]>([]);
  const [roles, setRoles] = useState<Record<string, unknown>[]>([]);
  const [users, setUsers] = useState<Record<string, unknown>[]>([]);
  const [roleSavingId, setRoleSavingId] = useState('');
  const [apkDriveUrl, setApkDriveUrl] = useState('');
  const [billingData, setBillingData] = useState<BillingData | null>(null);
  const [billingProvider, setBillingProvider] = useState<'xendit' | 'duitku' | 'kasera'>('xendit');
  const [billingPlan, setBillingPlan] = useState<'monthly' | 'lifetime'>('monthly');
  const [billingEmail, setBillingEmail] = useState('');
  const [billingEmailBusy, setBillingEmailBusy] = useState(false);
  const [paymentMethods, setPaymentMethods] = useState<PaymentMethod[]>([]);
  const [paymentMethod, setPaymentMethod] = useState('');
  const [billingBusy, setBillingBusy] = useState(false);
  const [whatsappSettings, setWhatsappSettings] = useState<SchoolWhatsappGatewaySettings>({
    endpoint_url: DEFAULT_WHATSAPP_GATEWAY_URL,
    is_enabled: false,
    is_configured: false,
    token_hint: '',
    last_test_at: null,
    last_test_status: null,
    last_test_message: null,
  });
  const [whatsappToken, setWhatsappToken] = useState('');
  const [whatsappBusy, setWhatsappBusy] = useState(false);
  const [whatsappTestPhone, setWhatsappTestPhone] = useState('');
  const [whatsappTestBusy, setWhatsappTestBusy] = useState(false);
  const [googleSheetsSettings, setGoogleSheetsSettings] = useState<GoogleSheetsSettings>({
    web_app_url: '',
    is_enabled: false,
    is_configured: false,
    secret_hint: '',
    last_sync_at: null,
    sync_error: null,
  });
  const [googleSheetsSecret, setGoogleSheetsSecret] = useState('');
  const [googleSheetsBusy, setGoogleSheetsBusy] = useState(false);
  const [reportRows, setReportRows] = useState<ReportRow[]>([]);
  const [reportPeriod, setReportPeriod] = useState<'daily' | 'monthly'>('monthly');
  const [reportDate, setReportDate] = useState(initialDate);
  const [reportMonth, setReportMonth] = useState(initialDate.slice(0, 7));
  const [reportClassroom, setReportClassroom] = useState('');
  const [selectedReportEntries, setSelectedReportEntries] = useState<Set<string>>(new Set());
  const [pendingCount, setPendingCount] = useState(0);
  const [online, setOnline] = useState(navigator.onLine);
  const [lastScan, setLastScan] = useState('');
  const [scanPopup, setScanPopup] = useState<{ message: string; success: boolean; id: number } | null>(null);
  const [historyResetVersion, setHistoryResetVersion] = useState(0);
  const [manualCode, setManualCode] = useState('');
  const [manualAttendanceOpen, setManualAttendanceOpen] = useState(false);
  const [manualAttendanceQuery, setManualAttendanceQuery] = useState('');
  const [manualParticipantId, setManualParticipantId] = useState('');
  const [manualAttendanceBusy, setManualAttendanceBusy] = useState(false);
  const [selectedParticipantIds, setSelectedParticipantIds] = useState<Set<string>>(new Set());
  const [scanClock, setScanClock] = useState(() => new Date());
  const [participantForm, setParticipantForm] = useState({
    full_name: '', classroom_id: '', qr_code: '', participant_phone: '',
  });
  const [editingParticipantId, setEditingParticipantId] = useState('');
  const [classroomForm, setClassroomForm] = useState({ id: '', name: '' });
  const [roleForm, setRoleForm] = useState<{ role_key: string; role_name: string; permissions: Permission[] }>({
    role_key: '', role_name: '', permissions: [],
  });
  const [userForm, setUserForm] = useState({ username: '', display_name: '', password: '', role_id: '' });
  const [operationalForm, setOperationalForm] = useState(initialSettings);
  const [scannerPreferences, setScannerPreferences] = useState(initialScannerPreferences);
  const [scannerPreferencesReady, setScannerPreferencesReady] = useState(false);
  const scannerPreferencesRef = useRef(scannerPreferences);
  const [scannerPinForm, setScannerPinForm] = useState('');
  const [scannerMenuOpen, setScannerMenuOpen] = useState(false);
  const [scannerMenuPin, setScannerMenuPin] = useState('');
  const [scannerMenuTarget, setScannerMenuTarget] = useState<Page | 'manual-attendance' | null>(null);
  const [scannerUnlockBusy, setScannerUnlockBusy] = useState(false);
  const [holidayForm, setHolidayForm] = useState({ date: '', name: '' });
  const [cameraActive, setCameraActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirmationDialog, setConfirmationDialog] = useState<ConfirmationDialog | null>(null);
  const [offlineMode, setOfflineMode] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const controlsRef = useRef<{ stop: () => void } | null>(null);
  const cameraStartGenerationRef = useRef(0);
  const wedgeTimerRef = useRef<number | undefined>(undefined);
  const scanFeedbackTimerRef = useRef<number | undefined>(undefined);
  const scanPopupTimerRef = useRef<number | undefined>(undefined);
  const lastScanAtRef = useRef(new Map<string, number>());
  const confirmationResolverRef = useRef<((accepted: boolean) => void) | null>(null);
  const reportAbortRef = useRef<AbortController | null>(null);
  useEffect(() => () => {
    if (scanFeedbackTimerRef.current !== undefined) {
      window.clearTimeout(scanFeedbackTimerRef.current);
    }
    if (scanPopupTimerRef.current !== undefined) {
      window.clearTimeout(scanPopupTimerRef.current);
    }
  }, []);

  const passwordChecks = {
    length: registrationForm.password.length >= 8,
    uppercase: /[A-Z]/.test(registrationForm.password),
    number: /\d/.test(registrationForm.password),
    symbol: /[^A-Za-z0-9\s]/.test(registrationForm.password),
    maxBytes: new TextEncoder().encode(registrationForm.password).length <= 72,
  };
  const validRegistrationPassword = Object.values(passwordChecks).every(Boolean);
  const resetPasswordChecks = {
    length: passwordResetForm.password.length >= 8,
    uppercase: /[A-Z]/.test(passwordResetForm.password),
    number: /\d/.test(passwordResetForm.password),
    symbol: /[^A-Za-z0-9\s]/.test(passwordResetForm.password),
    maxBytes: new TextEncoder().encode(passwordResetForm.password).length <= 72,
  };
  const validResetPassword = Object.values(resetPasswordChecks).every(Boolean);

  useEffect(() => {
    if (!error && !notice) return;
    const timer = window.setTimeout(() => {
      setError('');
      setNotice('');
    }, 3000);
    return () => window.clearTimeout(timer);
  }, [session, error, notice]);

  useEffect(() => {
    let active = true;
    let objectUrl = '';
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]') ??
      document.head.appendChild(Object.assign(document.createElement('link'), { rel: 'icon' }));
    if (schoolBranding?.logo_data_url) {
      link.href = schoolBranding.logo_data_url;
      return () => {
        active = false;
        link.href = '/favicon.svg';
      };
    }
    fetch(`${API_BASE}/branding/logo`, { cache: 'no-store' })
      .then(async (response) => {
        if (response.status === 404) return null;
        if (!response.ok) throw new Error(`Logo platform gagal dimuat (${response.status}).`);
        return response.blob();
      })
      .then((blob) => {
        if (!active || !blob) return;
        objectUrl = URL.createObjectURL(blob);
        link.href = objectUrl;
      })
      .catch((reason: unknown) => console.error('Favicon platform gagal dimuat.', reason));
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
      if (link) link.href = '/favicon.svg';
    };
  }, [schoolBranding?.logo_data_url]);

  useEffect(() => {
    let active = true;
    fetch(`${API_BASE}/branding`, { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Nama aplikasi gagal dimuat (${response.status}).`);
        return response.json() as Promise<{ application_name?: string }>;
      })
      .then((result) => {
        if (active && result.application_name) setApplicationName(result.application_name);
      })
      .catch((reason: unknown) => console.error('Nama aplikasi gagal dimuat.', reason));
    return () => { active = false; };
  }, []);

  useEffect(() => {
    document.title = `${session ? schoolBranding?.application_name || session.school.name : applicationName} · Portal Sekolah`;
  }, [applicationName, schoolBranding?.application_name, session?.school.name]);

  const permissions = session?.user.permissions ?? [];
  const can = (permission: Permission) => hasPermission(permissions, permission);
  const displayApplicationName = session
    ? schoolBranding?.application_name || session.school.name
    : applicationName;
  const monthlyReportRows = useMemo(() => aggregateMonthlyReport(reportRows), [reportRows]);
  const invalidImportRowCount = participantImportPreview.filter((row) =>
    !row.full_name.trim() || !classrooms.some((classroom) => classroom.id === row.classroom_id)).length;
  const connected = online && !offlineMode;
  useEffect(() => {
    if (!session) return;
    let active = true;
    let firstCheck = true;
    const refreshSchoolSession = async () => {
      try {
        const result = await request<{ session?: SchoolSession; school?: SchoolInfo; user?: UserInfo }>(
          '/school/auth/me',
          session.token,
        );
        if (!active) return;
        const refreshed = result.session ?? (result.school && result.user
          ? {
            ...session,
            school: { ...session.school, ...result.school },
            user: { ...session.user, ...result.user },
          }
          : session);
        setSession(refreshed);
        localStorage.setItem(SESSION_KEY, JSON.stringify(refreshed));
        setOfflineMode(false);
        if (firstCheck) {
          setPage(initialPage(refreshed));
          if (!refreshed.school.subscription_expired) void loadSchoolData(refreshed);
        } else if (refreshed.school.subscription_expired) {
          setPage('billing');
        }
        firstCheck = false;
      } catch (reason) {
        if (!active) return;
        setOfflineMode(true);
        setError(reason instanceof Error ? reason.message : 'Sesi sekolah gagal diperbarui.');
      }
    };
    void refreshSchoolSession();
    const timer = window.setInterval(() => void refreshSchoolSession(), 30000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [session?.token]);

  useEffect(() => {
    if (!session || page !== 'billing' || session.user.role_key !== 'admin-sekolah') return;
    void loadBillingData();
  }, [page, session?.token]);

  useEffect(() => {
    if (!session || page !== 'billing' || billingProvider !== 'duitku') {
      setPaymentMethods([]);
      setPaymentMethod('');
      return;
    }
    let active = true;
    request<{ payment_methods: PaymentMethod[] }>(
      `/school/billing/payment-methods?provider=duitku&plan=${billingPlan}`,
      session.token,
    )
      .then((result) => {
        if (!active) return;
        setPaymentMethods(result.payment_methods);
        setPaymentMethod(result.payment_methods[0]?.code ?? '');
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : 'Metode pembayaran Duitku gagal dimuat.');
      });
    return () => { active = false; };
  }, [billingPlan, billingProvider, page, session?.token]);

  useEffect(() => {
    if (!session || !hasPermission(session.user.permissions, 'settings.operational.view')) return;
    request<{ settings: SchoolWhatsappGatewaySettings }>(
      '/school/settings/whatsapp-gateway',
      session.token,
    )
      .then((result) => setWhatsappSettings({
        ...result.settings,
        endpoint_url: result.settings.endpoint_url || DEFAULT_WHATSAPP_GATEWAY_URL,
      }))
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Pengaturan WhatsApp sekolah gagal dimuat.'));
  }, [session?.token]);

  useEffect(() => {
    if (!session) {
      setSchoolBranding(null);
      setSchoolBrandingName('');
      setSchoolLogoUpload('');
      return;
    }
    let active = true;
    setSchoolBranding(null);
    setSchoolBrandingName(session.school.name);
    setSchoolLogoUpload('');
    request<{ branding: SchoolBranding }>('/school/branding', session.token)
      .then(({ branding }) => {
        if (!active) return;
        setSchoolBranding(branding);
        setSchoolBrandingName(branding.application_name);
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : 'Identitas sekolah gagal dimuat.');
      });
    return () => { active = false; };
  }, [session?.token, session?.school.id]);

  useEffect(() => {
    if (!session || !hasPermission(session.user.permissions, 'settings.operational.view')) return;
    request<{ settings: GoogleSheetsSettings }>(
      '/school/settings/google-sheets',
      session.token,
    )
      .then((result) => setGoogleSheetsSettings(result.settings))
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Pengaturan Google Sheets gagal dimuat.'));
  }, [session?.token]);

  useEffect(() => {
    if (!session || page !== 'settings' || !googleSheetsSettings.is_enabled) return;
    let active = true;
    const timer = window.setInterval(() => {
      request<{ settings: GoogleSheetsSettings }>('/school/settings/google-sheets', session.token)
        .then(({ settings: latest }) => {
          if (!active) return;
          setGoogleSheetsSettings((current) => ({
            ...current,
            last_sync_at: latest.last_sync_at,
            sync_error: latest.sync_error,
          }));
        })
        .catch((reason: unknown) => {
          if (active) setError(reason instanceof Error ? reason.message : 'Status sinkronisasi Google Sheets gagal dimuat.');
        });
    }, 15000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [page, session?.token, googleSheetsSettings.is_enabled]);

  useEffect(() => {
    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  useEffect(() => {
    if (!session || page !== 'scanner' || !scannerPreferencesReady) return;
    let orientationTimer: number | undefined;
    let isLandscape = window.matchMedia('(orientation: landscape)').matches;
    const handleOrientationChange = () => {
      const nextIsLandscape = window.matchMedia('(orientation: landscape)').matches;
      if (nextIsLandscape === isLandscape) return;
      isLandscape = nextIsLandscape;
      if (orientationTimer !== undefined) window.clearTimeout(orientationTimer);
      orientationTimer = window.setTimeout(() => {
        orientationTimer = undefined;
        controlsRef.current?.stop();
        controlsRef.current = null;
        cameraStartGenerationRef.current += 1;
        setCameraActive(false);
        void startCamera(scannerPreferencesRef.current);
      }, 300);
    };
    window.addEventListener('orientationchange', handleOrientationChange);
    window.addEventListener('resize', handleOrientationChange);
    void startCamera(scannerPreferences);
    return () => {
      window.removeEventListener('orientationchange', handleOrientationChange);
      window.removeEventListener('resize', handleOrientationChange);
      if (orientationTimer !== undefined) window.clearTimeout(orientationTimer);
      cameraStartGenerationRef.current += 1;
      controlsRef.current?.stop();
      controlsRef.current = null;
      setCameraActive(false);
    };
  }, [page, session?.school.id, scannerPreferencesReady]);

  useEffect(() => {
    scannerPreferencesRef.current = scannerPreferences;
  }, [scannerPreferences]);

  useEffect(() => {
    if (!session) {
      setScannerPreferencesReady(false);
      return;
    }
    let active = true;
    setScannerPreferencesReady(false);
    setScannerPreferences(initialScannerPreferences);
    void database(session.school.id)
      .then((db) => db.get('scannerPreferences', 'default'))
      .then((preferences) => {
        if (active && preferences) setScannerPreferences({ ...initialScannerPreferences, ...preferences });
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : 'Pengaturan scanner lokal gagal dimuat.');
      })
      .finally(() => {
        if (active) setScannerPreferencesReady(true);
      });
    return () => { active = false; };
  }, [session?.school.id]);

  useEffect(() => () => {
    if (wedgeTimerRef.current) window.clearTimeout(wedgeTimerRef.current);
  }, [page]);

  useEffect(() => {
    if (page !== 'downloads') return;
    void request<{ apk_drive_url: string | null }>('/platform/downloads')
      .then((result) => setApkDriveUrl(result.apk_drive_url ?? ''))
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Link APK gagal dimuat.'));
  }, [page]);

  useEffect(() => {
    if (!session || page !== 'scanner' || !online) return;
    void syncPending().catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : 'Sinkronisasi otomatis gagal.');
    });
  }, [online, page, session?.school.id]);

  useEffect(() => {
    const timer = window.setInterval(() => setScanClock(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!session || page !== 'scanner' || !online) return;
    const timer = window.setInterval(() => {
      void syncPending().catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : 'Sinkronisasi otomatis gagal.');
      });
    }, 10000);
    return () => window.clearInterval(timer);
  }, [online, page, session?.school.id]);

  async function loadSchoolData(currentSession: SchoolSession) {
    if (currentSession.school.subscription_expired) return;
    const db = await database(currentSession.school.id);
    const cached = await db.getAll('participants');
    const canReadMaster = hasPermission(currentSession.user.permissions, 'participants.view') ||
      hasPermission(currentSession.user.permissions, 'scanner.use');
    const canReadSettings = hasPermission(currentSession.user.permissions, 'settings.operational.view') ||
      canReadMaster;
    setParticipants(canReadMaster ? cached : []);
    setClassrooms([]);
    const cachedSettings = canReadSettings ? await db.get('settings', 'operational') : undefined;
    if (cachedSettings && canReadSettings) {
      const normalizedCachedSettings = { ...initialSettings, ...cachedSettings };
      setSettings(normalizedCachedSettings);
      setOperationalForm(normalizedCachedSettings);
    }
    try {
      const [participantResult, classroomResult, settingResult] = await Promise.all([
        canReadMaster ? request<unknown>('/school/participants', currentSession.token) : Promise.resolve(null),
        canReadMaster ? request<unknown>('/school/classrooms', currentSession.token) : Promise.resolve(null),
        canReadSettings ? request<unknown>('/school/settings', currentSession.token) : Promise.resolve(null),
      ]);
      if (participantResult) {
        const freshParticipants = unwrapArray<Participant>(participantResult, 'participants')
          .map((item) => ({ ...item, id: String(item.id) }));
        setParticipants(freshParticipants);
        const write = db.transaction('participants', 'readwrite');
        await write.store.clear();
        for (const participant of freshParticipants) await write.store.put(participant);
        await write.done;
      }
      if (classroomResult && typeof classroomResult === 'object') {
        setClassrooms(unwrapArray<Classroom>(classroomResult, 'classrooms'));
      }
      if (settingResult) {
        const settingsPayload = settingResult && typeof settingResult === 'object'
          ? (settingResult as Record<string, unknown>).settings ?? settingResult
          : {};
        const nextSettings = {
          ...initialSettings,
          ...(settingsPayload as Partial<OperationalSettings>),
          participant_overrides: unwrapArray<ParticipantSchedule>(settingsPayload, 'participant_overrides')
            .map((item) => ({ ...item, participant_id: String(item.participant_id) })),
        };
        setSettings(nextSettings);
        setOperationalForm(nextSettings);
        await db.put('settings', nextSettings, 'operational');
      }
      setOfflineMode(false);
      setError('');
    } catch (reason) {
      setOfflineMode(true);
      if (canReadMaster && !cached.length) {
        setError(reason instanceof Error ? `${reason.message} Master peserta lokal belum tersedia.` : 'Tidak dapat memuat master peserta lokal.');
      }
    }
    await refreshPendingCount(currentSession.school.id);
  }

  async function loadBillingData() {
    if (!session) return;
    try {
      const result = await request<BillingData>('/school/billing', session.token);
      setBillingData(result);
      setBillingEmail(result.billing_email ?? '');
      if (!result.providers[billingProvider]) {
        const nextProvider = (['xendit', 'kasera', 'duitku'] as const)
          .find((provider) => result.providers[provider]);
        if (nextProvider) setBillingProvider(nextProvider);
      }
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Informasi tagihan gagal dimuat.');
    }
  }

  async function refreshPendingCount(schoolId = session?.school.id) {
    if (schoolId == null) return;
    const db = await database(schoolId);
    setPendingCount(await db.countFromIndex('queue', 'by-status', 'pending'));
  }

  async function resetLocalHistory() {
    if (!session || !await requestConfirmation({
      title: 'Reset riwayat scanner',
      message: 'Hapus semua riwayat scan yang tersimpan di perangkat ini? Riwayat yang belum tersinkron juga akan dihapus dan tidak dapat dipulihkan.',
      confirmLabel: 'Hapus semua riwayat',
    })) return;
    try {
      const db = await database(session.school.id);
      const transaction = db.transaction('queue', 'readwrite');
      await transaction.store.clear();
      await transaction.done;
      setPendingCount(0);
      setHistoryResetVersion((current) => current + 1);
      setMessage('Semua riwayat scanner di perangkat ini berhasil dihapus.');
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : 'Riwayat scanner gagal dihapus.', true);
    }
  }

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await request<{ access_token?: string }>('/school/auth/login', undefined, {
        method: 'POST',
        body: loginForm,
      });
      if (typeof result?.access_token !== 'string' || !result.access_token.trim()) {
        throw new Error('Respons login tidak memuat token sesi sekolah yang valid.');
      }
      const current = await request<{ user?: UserInfo; school?: SchoolInfo }>(
        '/school/auth/me',
        result.access_token,
      );
      if (!current.user || !current.school || !Array.isArray(current.user.permissions)) {
        throw new Error('Backend tidak mengembalikan profil sesi sekolah yang valid.');
      }
      const nextSession: SchoolSession = {
        token: result.access_token,
        school: current.school,
        user: current.user,
      };
      setSession(nextSession);
      localStorage.setItem(SESSION_KEY, JSON.stringify(nextSession));
      setLoginForm((current) => ({ ...current, password: '' }));
      setPage(initialPage(nextSession));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Login sekolah gagal.');
    } finally {
      setBusy(false);
    }
  }

  async function startRegistration(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await request<{ challenge_id: string; message: string }>(
        '/school/auth/register/start',
        undefined,
        { method: 'POST', body: registrationForm },
      );
      setRegistrationChallengeId(result.challenge_id);
      setRegistrationOtp('');
      setLoginView('verify');
      setNotice(result.message);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Permintaan OTP gagal.');
    } finally {
      setBusy(false);
    }
  }

  async function verifyRegistration(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await request<{
        school: SchoolInfo;
        admin_username: string;
        message: string;
      }>('/school/auth/register/verify', undefined, {
        method: 'POST',
        body: { challenge_id: registrationChallengeId, otp: registrationOtp },
      });
      setLoginForm({
        school_code: result.school.school_code,
        username: result.admin_username,
        password: '',
      });
      setRegistrationForm(initialRegistrationForm);
      setRegistrationChallengeId('');
      setRegistrationOtp('');
      setLoginView('login');
      setNotice(`${result.message} Kode sekolah Anda: ${result.school.school_code}.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Verifikasi OTP gagal.');
    } finally {
      setBusy(false);
    }
  }

  async function startPasswordReset(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await request<{ challenge_id: string; message: string }>(
        '/school/auth/password-reset/start',
        undefined,
        {
          method: 'POST',
          body: {
            school_code: passwordResetForm.school_code,
            whatsapp_phone: passwordResetForm.whatsapp_phone,
          },
        },
      );
      setPasswordResetChallengeId(result.challenge_id);
      setPasswordResetForm((current) => ({ ...current, otp: '' }));
      setLoginView('reset-password');
      setNotice(result.message);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Permintaan reset kata sandi gagal.');
    } finally {
      setBusy(false);
    }
  }

  async function verifyPasswordReset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setNotice('');
    if (!validResetPassword) {
      setError('Kata sandi harus minimal 8 karakter dan memiliki huruf besar, angka, serta simbol.');
      return;
    }
    setBusy(true);
    try {
      const result = await request<{ message: string }>(
        '/school/auth/password-reset/verify',
        undefined,
        {
          method: 'POST',
          body: {
            challenge_id: passwordResetChallengeId,
            otp: passwordResetForm.otp,
            password: passwordResetForm.password,
          },
        },
      );
      setLoginForm({
        school_code: passwordResetForm.school_code,
        username: passwordResetForm.whatsapp_phone,
        password: '',
      });
      setPasswordResetForm(initialPasswordResetForm);
      setPasswordResetChallengeId('');
      setShowResetPassword(false);
      setLoginView('login');
      setNotice(result.message);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Kode verifikasi atau reset kata sandi tidak valid.');
    } finally {
      setBusy(false);
    }
  }

  function signOut() {
    controlsRef.current?.stop();
    controlsRef.current = null;
    localStorage.removeItem(SESSION_KEY);
    setSession(null);
    setParticipants([]);
    setPage('dashboard');
    setError('');
    setNotice('');
  }

  function setMessage(message: string, isError = false) {
    if (isError) {
      setError(message);
      setNotice('');
    } else {
      setNotice(message);
      setError('');
    }
  }

  function syncManager() {
    if (!session) throw new Error('Sesi sekolah tidak tersedia untuk sinkronisasi.');
    return createOfflineSyncManager({
      schoolId: String(session.school.id),
      storage: {
        async putPendingIfAbsent({ scan }: { scan: QueuedScan }) {
          const db = await database(session.school.id);
          const tx = db.transaction('queue', 'readwrite');
          const existing = await tx.store.get(scan.id_unik);
          if (existing) {
            await tx.done;
            return false;
          }
          await tx.store.add(scan);
          await tx.done;
          return true;
        },
        async listPending({ limit }: { sekolah_id: string; limit: number }) {
          const db = await database(session.school.id);
          return (await db.getAllFromIndex('queue', 'by-status', 'pending')).slice(0, limit);
        },
        async markSynced({ ids }: { sekolah_id: string; ids: string[] }) {
          const db = await database(session.school.id);
          const tx = db.transaction('queue', 'readwrite');
          for (const id of ids) {
            const record = await tx.store.get(id);
            if (record) await tx.store.put({ ...record, status_sync: 'synced' });
          }
          await tx.done;
        },
      },
      async sendBatch({ records }: { sekolah_id: string; records: QueuedScan[] }) {
        return request<{ accepted_ids: string[]; rejected_ids?: string[] }>(
          '/school/attendance/sync-batch/session',
          session.token,
          { method: 'POST', body: { records } },
        );
      },
    });
  }

  async function syncPending() {
    const result = await syncManager().syncPending();
    await refreshPendingCount();
    return result;
  }

  function markSubscriptionExpired() {
    if (session) {
      const refreshed = {
        ...session,
        school: { ...session.school, subscription_expired: true },
      };
      setSession(refreshed);
      localStorage.setItem(SESSION_KEY, JSON.stringify(refreshed));
    }
    setPage('billing');
  }

  async function removeQueuedScan(id: string) {
    if (!session) return;
    const db = await database(session.school.id);
    await db.delete('queue', id);
    await refreshPendingCount(session.school.id);
  }

  async function handleScan(rawValue: string, scanMethod: 'SCAN_QR' | 'MANUAL_INPUT' = 'SCAN_QR'): Promise<boolean> {
    if (!session) return false;
    if (session.school.subscription_expired) {
      setPage('billing');
      return false;
    }
    const value = normalizeScanCode(rawValue);
    if (!value) return false;
    const now = Date.now();
    const previous = lastScanAtRef.current.get(value) ?? 0;
    if (now - previous < 3000) return false;
    lastScanAtRef.current.set(value, now);
    let participant: Participant | undefined;
    try {
      participant = findParticipantByScanCode(participants, value);
      if (!participant && online) {
        const result = await request<unknown>('/school/participants', session.token);
        const refreshedParticipants = unwrapArray<Participant>(result, 'participants')
          .map((item) => ({ ...item, id: String(item.id) }));
        setParticipants(refreshedParticipants);
        const db = await database(session.school.id);
        const transaction = db.transaction('participants', 'readwrite');
        await transaction.store.clear();
        for (const item of refreshedParticipants) await transaction.store.put(item);
        await transaction.done;
        participant = findParticipantByScanCode(refreshedParticipants, value);
      }
      if (!participant) throw new Error('QR/barcode tidak ditemukan di master peserta lokal.');
      const matchedParticipant = participant;
      const db = await database(session.school.id);
      const allScans = await db.getAll('queue');
      const initialCalculation = calculateAttendance({
        eventType: 'check_in',
        clientTimestamp: new Date().toISOString(),
        participantId: matchedParticipant.id,
        settings,
      }) as ScanResult;
      const hasCheckIn = allScans.some((record) =>
        record.id_peserta === matchedParticipant.id &&
        record.attendance_date === initialCalculation.date &&
        record.jenis_absen === 'check_in',
      );
      const eventType = hasCheckIn ? 'check_out' : 'check_in';
      const duplicate = allScans.some((record) =>
        record.id_peserta === matchedParticipant.id &&
        record.attendance_date === initialCalculation.date &&
        record.jenis_absen === eventType,
      );
      if (duplicate) throw new Error('Scan jenis ini sudah tercatat di perangkat untuk hari ini.');

      const calculation = eventType === 'check_in'
        ? initialCalculation
        : calculateAttendance({
          eventType,
          clientTimestamp: new Date().toISOString(),
          participantId: matchedParticipant.id,
          settings,
        }) as ScanResult;
      if (calculation.reason) {
        throw new Error(calculation.reason === 'checkout_too_early'
          ? 'Waktu pulang belum dimulai.'
          : 'Hari ini bukan hari operasional sekolah.');
      }
      const scan = createQueuedScan({
        sekolah_id: String(session.school.id),
        id_peserta: matchedParticipant.id,
        id_perangkat: null,
        jenis_absen: eventType,
        scan_method: scanMethod,
        calculation,
      }) as QueuedScan;
      scan.participant_name = matchedParticipant.full_name;
      await syncManager().enqueue(scan);
      const attendanceStatus = calculation.status === 'check_out' || calculation.status === 'pulang'
        ? 'pulang'
        : calculation.status === 'terlambat'
          ? `terlambat${calculation.lateMinutes ? ` ${calculation.lateMinutes} menit` : ''}`
          : 'hadir tepat waktu';
      const successMessage = attendanceMessage(settings.scan_success_message, {
        name: matchedParticipant.full_name,
        status: attendanceStatus,
        reason: '',
      });
      showScanFeedback(successMessage, true);
      void announceAttendance(successMessage, true);
      await refreshPendingCount();
      if (online) {
        try {
          await syncPending();
        } catch (reason) {
          if (reason instanceof ApiError && reason.code === 'SUBSCRIPTION_EXPIRED') {
            markSubscriptionExpired();
            try {
              await removeQueuedScan(scan.id_unik);
            } catch (cleanupError) {
              console.error('Scan yang ditolak tidak dapat dihapus dari antrean perangkat.', cleanupError);
            }
            return false;
          }
          console.warn('Scan tetap tersimpan lokal; sinkronisasi akan dicoba ulang.', reason);
        }
      }
      return true;
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'Scan gagal diproses.';
      const failureMessage = attendanceMessage(settings.scan_failure_message, {
        name: participant?.full_name ?? 'Peserta tidak dikenal',
        status: '',
        reason: message,
      });
      showScanFeedback(failureMessage, false);
      void announceAttendance(failureMessage, false);
      return false;
    }
  }

  function showScanFeedback(message: string, success: boolean) {
    setError('');
    setNotice('');
    setLastScan(message);
    if (scanFeedbackTimerRef.current !== undefined) {
      window.clearTimeout(scanFeedbackTimerRef.current);
    }
    scanFeedbackTimerRef.current = window.setTimeout(() => {
      setLastScan('');
      scanFeedbackTimerRef.current = undefined;
    }, 5000);
    setScanPopup((current) => ({ message, success, id: (current?.id ?? 0) + 1 }));
    if (scanPopupTimerRef.current !== undefined) {
      window.clearTimeout(scanPopupTimerRef.current);
    }
    scanPopupTimerRef.current = window.setTimeout(() => {
      setScanPopup(null);
      scanPopupTimerRef.current = undefined;
    }, 3000);
  }

  function handleWedgeChange(value: string) {
    setManualCode(value);
    if (wedgeTimerRef.current) window.clearTimeout(wedgeTimerRef.current);
    if (!value.trim()) return;
    wedgeTimerRef.current = window.setTimeout(() => {
      wedgeTimerRef.current = undefined;
      setManualCode('');
      void handleScan(value);
    }, 250);
  }

  function submitWedge(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (wedgeTimerRef.current) {
      window.clearTimeout(wedgeTimerRef.current);
      wedgeTimerRef.current = undefined;
    }
    const code = manualCode;
    setManualCode('');
    void handleScan(code);
  }

  async function startCamera(preferences = scannerPreferences) {
    if (!videoRef.current) return;
    const generation = ++cameraStartGenerationRef.current;
    try {
      const fastScan = preferences.scanSpeed === 'fast';
      const isLandscape = window.matchMedia('(orientation: landscape)').matches;
      const reader = new BrowserMultiFormatReader(undefined, {
        delayBetweenScanAttempts: fastScan ? 100 : 350,
        delayBetweenScanSuccess: fastScan ? 250 : 500,
      });
      const controls = await reader.decodeFromConstraints(
        {
          audio: false,
          video: {
            facingMode: { ideal: preferences.cameraFacing },
            width: { ideal: isLandscape ? 1280 : 720 },
            height: { ideal: isLandscape ? 720 : 1280 },
          },
        },
        videoRef.current,
        (result) => {
          if (result) void handleScan(result.getText());
        },
      );
      if (cameraStartGenerationRef.current !== generation) {
        controls.stop();
        return;
      }
      controlsRef.current = controls;
      setCameraActive(true);
      setError('');
    } catch (reason) {
      if (cameraStartGenerationRef.current !== generation) return;
      setMessage(reason instanceof Error ? reason.message : 'Kamera tidak dapat dibuka. Periksa izin kamera.', true);
    }
  }

  async function updateScannerPreferences(next: ScannerPreferences) {
    if (!session) return;
    try {
      const db = await database(session.school.id);
      await db.put('scannerPreferences', next, 'default');
      setScannerPreferences(next);
      setMessage('Pengaturan scanner disimpan pada perangkat ini.');
      if (!next.usbScannerEnabled) {
        if (wedgeTimerRef.current) window.clearTimeout(wedgeTimerRef.current);
        wedgeTimerRef.current = undefined;
        setManualCode('');
      }
      const cameraSettingsChanged =
        next.cameraFacing !== scannerPreferences.cameraFacing ||
        next.scanSpeed !== scannerPreferences.scanSpeed;
      if (cameraActive && cameraSettingsChanged) {
        controlsRef.current?.stop();
        controlsRef.current = null;
        setCameraActive(false);
        await startCamera(next);
      }
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : 'Pengaturan scanner gagal disimpan.', true);
    }
  }

  const loadReport = useCallback(async (
    event?: FormEvent<HTMLFormElement>,
    showLoading = true,
  ) => {
    event?.preventDefault();
    if (!session?.token) return;
    reportAbortRef.current?.abort();
    const controller = new AbortController();
    reportAbortRef.current = controller;
    let from = reportDate;
    let to = reportDate;
    if (reportPeriod === 'monthly') {
      const [year, month] = reportMonth.split('-').map(Number);
      from = `${reportMonth}-01`;
      const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
      to = `${reportMonth}-${String(lastDay).padStart(2, '0')}`;
    }
    const query = new URLSearchParams({ from, to });
    if (reportClassroom) query.set('classroom_id', reportClassroom);
    setBusy(showLoading);
    try {
      const result = await request<unknown>(`/school/attendance/report?${query}`, session.token, {
        signal: controller.signal,
      });
      if (reportAbortRef.current === controller) {
        const rows = unwrapArray<ReportRow>(result, 'attendance');
        const rowKeys = new Set(rows.map((row) => `${row.attendance_date}:${row.participant_id}`));
        setReportRows(rows);
        setSelectedReportEntries((current) => new Set([...current].filter((key) => rowKeys.has(key))));
        setError('');
      }
    } catch (reason) {
      if (!controller.signal.aborted && reportAbortRef.current === controller) {
        setMessage(reason instanceof Error ? reason.message : 'Rekap tidak dapat dimuat.', true);
      }
    } finally {
      if (reportAbortRef.current === controller) {
        reportAbortRef.current = null;
        setBusy(false);
      }
    }
  }, [reportClassroom, reportDate, reportMonth, reportPeriod, session?.token]);

  useEffect(() => {
    setSelectedReportEntries(new Set());
  }, [reportClassroom, reportDate, reportMonth, reportPeriod]);

  useEffect(() => {
    if (!session || (page !== 'dashboard' && page !== 'reports') ||
        !hasPermission(session.user.permissions, 'attendance.view')) return;
    void loadReport();
    const timer = window.setInterval(() => void loadReport(undefined, false), 30000);
    return () => {
      window.clearInterval(timer);
      reportAbortRef.current?.abort();
      reportAbortRef.current = null;
      setBusy(false);
    };
  }, [loadReport, page, session?.user.permissions]);

  async function deleteReportEntries(entries: Array<Pick<ReportRow, 'participant_id' | 'attendance_date'>>) {
    if (!session || !entries.length) return;
    if (!await requestConfirmation({
      title: 'Hapus riwayat rekap',
      message: `Hapus ${entries.length} riwayat absensi dari rekap portal sekolah? Penghapusan ini tidak dapat dibatalkan. Salinan yang sudah dikirim ke Google Sheets tidak ikut dihapus.`,
      confirmLabel: 'Hapus riwayat',
    })) return;
    setBusy(true);
    try {
      const result = await request<{ deleted_count: number }>('/school/attendance/report', session.token, {
        method: 'DELETE',
        body: { entries },
      });
      setSelectedReportEntries(new Set());
      setMessage(`${result.deleted_count} catatan absensi berhasil dihapus dari rekap.`);
      await loadReport(undefined, false);
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : 'Riwayat rekap gagal dihapus.', true);
    } finally {
      setBusy(false);
    }
  }

  async function removeSelectedParticipants() {
    if (!session) return;
    const selected = participants.filter((participant) => selectedParticipantIds.has(participant.id));
    if (!selected.length || !await requestConfirmation({
      title: 'Hapus peserta terpilih',
      message: `Hapus ${selected.length} peserta terpilih? Peserta yang masih memiliki riwayat absensi tidak dapat dihapus.`,
      confirmLabel: 'Hapus peserta',
    })) return;
    setBusy(true);
    let deletedCount = 0;
    const failedIds = new Set<string>();
    let firstError = '';
    try {
      for (const participant of selected) {
        try {
          await request(`/school/participants/${participant.id}`, session.token, { method: 'DELETE' });
          deletedCount += 1;
        } catch (reason) {
          failedIds.add(participant.id);
          if (!firstError) firstError = reason instanceof Error ? reason.message : 'Sebagian peserta gagal dihapus.';
        }
      }
      await loadSchoolData(session);
      setSelectedParticipantIds(failedIds);
      setMessage(failedIds.size
        ? `${deletedCount} peserta dihapus; ${failedIds.size} gagal dihapus. ${firstError}`
        : `${deletedCount} peserta berhasil dihapus.`);
    } catch (reason) {
      setSelectedParticipantIds(failedIds);
      setMessage(reason instanceof Error
        ? `Penghapusan peserta selesai sebagian, tetapi daftar peserta gagal diperbarui: ${reason.message}`
        : 'Penghapusan peserta selesai sebagian, tetapi daftar peserta gagal diperbarui.', true);
    } finally {
      setBusy(false);
    }
  }

  function requestConfirmation(dialog: ConfirmationDialog) {
    return new Promise<boolean>((resolve) => {
      confirmationResolverRef.current = resolve;
      setConfirmationDialog(dialog);
    });
  }

  function resolveConfirmation(accepted: boolean) {
    const resolve = confirmationResolverRef.current;
    confirmationResolverRef.current = null;
    setConfirmationDialog(null);
    resolve?.(accepted);
  }

  async function saveParticipant(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session) return;
    setBusy(true);
    try {
      const isEditing = Boolean(editingParticipantId);
      await request(
        isEditing ? `/school/participants/${editingParticipantId}` : '/school/participants',
        session.token,
        { method: isEditing ? 'PUT' : 'POST', body: participantForm },
      );
      setParticipantForm({ full_name: '', classroom_id: '', qr_code: '', participant_phone: '' });
      setEditingParticipantId('');
      await loadSchoolData(session);
      setMessage(isEditing ? 'Data peserta berhasil diperbarui.' : 'Peserta berhasil ditambahkan.');
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : 'Data peserta gagal disimpan.', true);
    } finally {
      setBusy(false);
    }
  }

  function editParticipant(participant: Participant) {
    setEditingParticipantId(participant.id);
    setParticipantForm({
      full_name: participant.full_name,
      classroom_id: participant.classroom_id,
      qr_code: participant.qr_code,
      participant_phone: participant.participant_phone ?? '',
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function saveClassroom(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session || !classroomForm.name.trim()) return;
    setBusy(true);
    try {
      const isEdit = Boolean(classroomForm.id);
      if (classroomForm.id) {
        await request(`/school/classrooms/${classroomForm.id}`, session.token, {
          method: 'PUT',
          body: { name: classroomForm.name.trim() },
        });
      } else {
        await request('/school/classrooms', session.token, {
          method: 'POST',
          body: { name: classroomForm.name.trim() },
        });
      }
      setClassroomForm({ id: '', name: '' });
      await loadSchoolData(session);
      setMessage(isEdit ? 'Nama kelas diperbarui.' : 'Kelas berhasil ditambahkan.');
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : 'Kelas gagal disimpan.', true);
    } finally {
      setBusy(false);
    }
  }

  async function deleteClassroom(classroom: Classroom) {
    if (!session || !await requestConfirmation({
      title: 'Hapus kelas',
      message: `Hapus kelas ${classroom.name}?`,
      confirmLabel: 'Hapus kelas',
    })) return;
    setBusy(true);
    try {
      await request(`/school/classrooms/${classroom.id}`, session.token, { method: 'DELETE' });
      await loadSchoolData(session);
      setMessage('Kelas berhasil dihapus.');
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : 'Kelas gagal dihapus.', true);
    } finally {
      setBusy(false);
    }
  }

  async function downloadParticipantTemplate() {
    try {
      const ExcelJS = await loadExcelJS();
      const workbook = new ExcelJS.Workbook();
      const participantSheet = workbook.addWorksheet('Peserta');
      participantSheet.columns = [
        { header: 'Nama Lengkap', key: 'full_name', width: 32 },
        { header: 'Nama Kelas', key: 'classroom_id', width: 24 },
        { header: 'QR / Barcode', key: 'qr_code', width: 28 },
        { header: 'No WA Peserta', key: 'participant_phone', width: 20 },
      ];
      participantSheet.views = [{ state: 'frozen', ySplit: 1 }];
      participantSheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      participantSheet.getRow(1).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF176F4C' },
      };

      const classroomSheet = workbook.addWorksheet('Referensi Kelas');
      classroomSheet.columns = [
        { header: 'ID Kelas', key: 'id', width: 16 },
        { header: 'Nama Kelas', key: 'name', width: 28 },
        { header: 'Unit', key: 'unit', width: 28 },
      ];
      classroomSheet.getRow(1).font = { bold: true };
      classrooms.forEach((classroom) => classroomSheet.addRow({
        id: classroom.id,
        name: classroom.name,
        unit: classroom.unit_name ?? '',
      }));
      const bytes = new Uint8Array(await workbook.xlsx.writeBuffer());
      const url = URL.createObjectURL(new Blob([bytes.buffer], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'template-impor-peserta.xlsx';
      link.click();
      URL.revokeObjectURL(url);
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : 'Template Excel gagal dibuat.', true);
    }
  }

  async function importParticipants(file: File) {
    setBusy(true);
    setParticipantImportResult(null);
    setParticipantImportPreview([]);
    try {
      if (!file.name.toLowerCase().endsWith('.xlsx') || file.size > 5 * 1024 * 1024) {
        throw new Error('Pilih file .xlsx dengan ukuran maksimal 5 MB.');
      }
      if (!classrooms.length) {
        throw new Error('Daftar kelas belum tersedia. Sinkronkan master peserta lalu coba lagi.');
      }
      const ExcelJS = await loadExcelJS();
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(await file.arrayBuffer());
      const sheet = workbook.getWorksheet('Peserta') ?? workbook.worksheets[0];
      if (!sheet) throw new Error('Sheet peserta tidak ditemukan.');
      if (sheet.rowCount > 501) throw new Error('Sheet peserta dibatasi maksimal 500 baris data.');
      const headerColumns = new Map<string, number>();
      sheet.getRow(1).eachCell((cell, column) => {
        headerColumns.set(cell.text.trim().toLowerCase(), column);
      });
      const findColumn = (...names: string[]) =>
        names.map((name) => headerColumns.get(name)).find((column) => column !== undefined);
      const codeColumn = findColumn('kode peserta', 'participant_code');
      const nameColumn = findColumn('nama lengkap', 'full_name');
      const classroomColumn = findColumn('id kelas', 'classroom_id', 'kelas', 'nama kelas');
      const qrColumn = findColumn('qr / barcode', 'qr_code');
      const participantPhoneColumn = findColumn('no wa peserta', 'participant_phone');
      if (!nameColumn || !classroomColumn) {
        throw new Error('Kolom wajib: Nama Lengkap dan ID Kelas atau Nama Kelas.');
      }
      const rows: ParticipantImportDraft[] = [];
      const resolveClassroomId = (reference: string) => {
        const normalizedReference = reference.trim();
        const exactMatch = classrooms.find((classroom) => classroom.id === normalizedReference);
        if (exactMatch) return exactMatch.id;
        const numericReference = normalizedReference
          .replace(/\.0+$/, '')
          .replace(/^0+(?=\d)/, '');
        const numericMatch = classrooms.find((classroom) => classroom.id === numericReference);
        if (numericMatch) return numericMatch.id;
        const nameMatches = classrooms.filter((classroom) =>
          classroom.name.trim().toLocaleLowerCase() === normalizedReference.toLocaleLowerCase());
        return nameMatches.length === 1 ? nameMatches[0].id : '';
      };
      for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
        const row = sheet.getRow(rowNumber);
        const value = (column?: number) => {
          if (!column) return '';
          const cell = row.getCell(column);
          if (typeof cell.value === 'number' && Number.isFinite(cell.value)) {
            return String(cell.value);
          }
          if (typeof cell.value === 'string') return cell.value.trim();
          return cell.text.trim();
        };
        const classroomReference = value(classroomColumn);
        const participant = {
          source_row: String(rowNumber),
          participant_code: value(codeColumn),
          full_name: value(nameColumn),
          classroom_id: resolveClassroomId(classroomReference),
          qr_code: value(qrColumn),
          participant_phone: value(participantPhoneColumn),
        };
        if (![participant.full_name, participant.classroom_id, participant.qr_code,
          participant.participant_phone, participant.participant_code, classroomReference].some(Boolean)) continue;
        rows.push(participant);
        if (rows.length > 500) throw new Error('Impor dibatasi maksimal 500 peserta per file.');
      }
      if (!rows.length) throw new Error('File tidak berisi baris peserta.');

      setParticipantImportPreview(rows);
      setMessage(`${rows.length} baris siap diperiksa. Pastikan nama dan kelas sudah benar sebelum menyimpan.`);
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : 'Pratinjau impor gagal dibuat.', true);
    } finally {
      setBusy(false);
    }
  }

  async function submitParticipantImport() {
    if (!session || !participantImportPreview.length) return;
    const invalidRows = participantImportPreview.filter((row) =>
      !row.full_name.trim() || !classrooms.some((classroom) => classroom.id === row.classroom_id));
    if (invalidRows.length) {
      setMessage('Lengkapi nama peserta dan pilih kelas yang tersedia pada setiap baris.', true);
      return;
    }
    setBusy(true);
    try {
      const result = await request<ParticipantImportResult>('/school/participants/import', session.token, {
        method: 'POST',
        body: { participants: participantImportPreview },
      });
      setParticipantImportResult(result);
      const importedRows = new Set(
        result.results.filter((item) => item.status === 'imported').map((item) => String(item.row)),
      );
      setParticipantImportPreview((current) =>
        current.filter((row) => !importedRows.has(row.source_row)));
      await loadSchoolData(session);
      setMessage(`Impor selesai: ${result.imported} berhasil, ${result.skipped} dilewati.`);
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : 'Impor peserta gagal disimpan.', true);
    } finally {
      setBusy(false);
    }
  }

  function openParticipantSchedule(participantId: string) {
    const next: Record<number, string> = {};
    for (const override of settings.participant_overrides) {
      if (String(override.participant_id) === participantId) {
        next[Number(override.weekday)] = override.check_in_deadline.slice(0, 5);
      }
    }
    setScheduleParticipantId(participantId);
    setScheduleOverrides(next);
  }

  async function saveParticipantSchedule() {
    if (!session || !scheduleParticipantId) return;
    setBusy(true);
    try {
      const overrides = Object.entries(scheduleOverrides)
        .filter(([, deadline]) => deadline)
        .map(([weekday, deadline]) => ({
          weekday: Number(weekday),
          check_in_deadline: `${deadline}:00`,
        }));
      await request(`/school/participants/${scheduleParticipantId}/schedule`, session.token, {
        method: 'PUT',
        body: { overrides },
      });
      const nextSettings = {
        ...settings,
        participant_overrides: [
          ...settings.participant_overrides.filter(
            (item) => String(item.participant_id) !== scheduleParticipantId,
          ),
          ...overrides.map((item) => ({
            ...item,
            participant_id: scheduleParticipantId,
          })),
        ],
      };
      setSettings(nextSettings);
      setOperationalForm(nextSettings);
      const db = await database(session.school.id);
      await db.put('settings', nextSettings, 'operational');
      setScheduleParticipantId('');
      setMessage('Jadwal khusus peserta berhasil disimpan dan tersedia untuk scanner offline.');
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : 'Jadwal khusus peserta gagal disimpan.', true);
    } finally {
      setBusy(false);
    }
  }

  async function removeParticipant(participant: Participant) {
    if (!session || !await requestConfirmation({
      title: 'Hapus peserta',
      message: `Hapus peserta ${participant.full_name}? Jika sudah memiliki riwayat absensi, sistem dapat menolak penghapusan.`,
      confirmLabel: 'Hapus peserta',
    })) return;
    try {
      await request(`/school/participants/${participant.id}`, session.token, { method: 'DELETE' });
      await loadSchoolData(session);
      setSelectedParticipantIds((current) => {
        const next = new Set(current);
        next.delete(participant.id);
        return next;
      });
      setMessage('Peserta berhasil dihapus.');
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : 'Peserta gagal dinonaktifkan.', true);
    }
  }

  async function printSelectedQrs() {
    const selected = participants.filter((participant) => selectedParticipantIds.has(participant.id));
    if (!selected.length) return;
    let printWindow: Window | null = null;
    try {
      printWindow = window.open('', '_blank');
      if (!printWindow) throw new Error('Browser memblokir jendela cetak. Izinkan pop-up untuk portal ini lalu coba lagi.');
      printWindow.opener = null;
      printWindow.document.write('<!doctype html><html lang="id"><head><meta charset="utf-8"><title>Menyiapkan kartu QR</title></head><body>Menyiapkan kartu QR…</body></html>');
      printWindow.document.close();
      const images = await Promise.all(selected.map(async (participant) => ({
        ...participant,
        image: await QRCode.toDataURL(participant.qr_code, { width: 280, margin: 2 }),
      })));
      printWindow.document.open();
      printWindow.document.write(`<!doctype html><html lang="id"><head><meta charset="utf-8"><title>Kartu QR Sekolah</title><style>
        @page{size:A4 portrait;margin:8mm}*{box-sizing:border-box}body{font-family:Arial,sans-serif;margin:0;color:#111}
        main{display:grid;grid-template-columns:repeat(4,1fr);gap:5mm}.item{display:grid;justify-items:center;gap:2mm;text-align:center;break-inside:avoid;padding:1mm}
        img{width:32mm;height:32mm}.name{font-size:9pt;font-weight:bold;overflow-wrap:anywhere}
      </style></head><body><main>${images.map((item) => `<article class="item"><img src="${item.image}" alt=""><div class="name">${item.full_name.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char)}</div></article>`).join('')}</main></body></html>`);
      printWindow.document.close();
      await Promise.all(Array.from(printWindow.document.images, (image) => image.decode()));
      printWindow.focus();
      printWindow.print();
    } catch (reason) {
      printWindow?.close();
      setMessage(reason instanceof Error ? reason.message : 'QR gagal disiapkan untuk cetak.', true);
    }
  }

  async function saveRole(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session) return;
    try {
      const result = await request<unknown>('/school/roles', session.token, {
        method: 'POST',
        body: {
          role_key: roleForm.role_key,
          role_name: roleForm.role_name,
          permissions: currentRolePermissions(roleForm.permissions),
        },
      });
      setRoles((current) => [...current, ((result as { role?: Record<string, unknown> }).role ?? result) as Record<string, unknown>]);
      setRoleForm({ role_key: '', role_name: '', permissions: [] });
      setMessage('Role baru berhasil dibuat.');
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : 'Role gagal dibuat.', true);
    }
  }

  async function saveExistingRole(role: Record<string, unknown>) {
    if (!session || role.id == null) return;
    const roleId = String(role.id);
    setRoleSavingId(roleId);
    try {
      const permissions = currentRolePermissions(normalizeRolePermissions(role.permissions));
      const result = await request<{ role?: Record<string, unknown> }>(
        `/school/roles/${roleId}`,
        session.token,
        { method: 'PATCH', body: { permissions } },
      );
      const savedRole = result.role ?? { ...role, permissions };
      setRoles((current) => current.map((item) => String(item.id) === roleId ? savedRole : item));
      setMessage(`Izin role ${String(role.role_name ?? '')} diperbarui.`);
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : 'Izin role gagal disimpan.', true);
    } finally {
      setRoleSavingId('');
    }
  }

  async function deleteRole(role: Record<string, unknown>) {
    if (!session || role.id == null || !await requestConfirmation({
      title: 'Hapus role',
      message: `Hapus role ${String(role.role_name ?? '')}?`,
      confirmLabel: 'Hapus role',
    })) return;
    try {
      await request(`/school/roles/${String(role.id)}`, session.token, { method: 'DELETE' });
      setRoles((current) => current.filter((item) => String(item.id) !== String(role.id)));
      setMessage('Role berhasil dihapus.');
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : 'Role gagal dihapus.', true);
    }
  }

  async function saveUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session) return;
    try {
      const result = await request<unknown>('/school/users', session.token, { method: 'POST', body: userForm });
      setUsers((current) => [...current, ((result as { user?: Record<string, unknown> }).user ?? result) as Record<string, unknown>]);
      setUserForm({ username: '', display_name: '', password: '', role_id: '' });
      setMessage('Akun sekolah berhasil dibuat.');
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : 'Akun sekolah gagal dibuat.', true);
    }
  }

  async function deactivateUser(user: Record<string, unknown>) {
    if (!session || user.id == null ||
        !await requestConfirmation({
          title: 'Nonaktifkan akun',
          message: `Nonaktifkan akun ${String(user.username ?? '')}?`,
          confirmLabel: 'Nonaktifkan akun',
        })) return;
    try {
      await request(`/school/users/${String(user.id)}`, session.token, { method: 'DELETE' });
      setUsers((current) => current.map((item) =>
        String(item.id) === String(user.id) ? { ...item, is_active: 0 } : item));
      setMessage('Akun sekolah dinonaktifkan.');
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : 'Akun sekolah gagal dinonaktifkan.', true);
    }
  }

  function updateWeeklySchedule(weekday: number, updates: Partial<WeeklySchedule>) {
    setOperationalForm((current) => {
      const schedules = weekDays.map((_name, day) => {
        const existing = current.weekly_schedules.find((item) => Number(item.weekday) === day);
        return existing ? {
          ...existing,
          weekday: day,
          is_working_day: Boolean(Number(existing.is_working_day)),
        } : {
          weekday: day,
          is_working_day: day >= 1 && day <= 5,
          check_in_deadline: current.check_in_deadline,
          lateness_tolerance_minutes: current.lateness_tolerance_minutes,
          check_out_start: current.check_out_start,
        };
      });
      return {
        ...current,
        weekly_schedules: schedules.map((schedule) => schedule.weekday === weekday
          ? { ...schedule, ...updates }
          : schedule),
      };
    });
  }

  async function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session) return;
    try {
      const weeklySchedules = weekDays.map((_name, weekday) => {
        const schedule = operationalForm.weekly_schedules.find(
          (item) => Number(item.weekday) === weekday,
        );
        return {
          weekday,
          is_working_day: schedule
            ? Boolean(Number(schedule.is_working_day))
            : weekday >= 1 && weekday <= 5,
          check_in_deadline: schedule?.check_in_deadline ?? operationalForm.check_in_deadline,
          lateness_tolerance_minutes: Number(schedule?.lateness_tolerance_minutes ??
            operationalForm.lateness_tolerance_minutes),
          check_out_start: schedule?.check_out_start ?? operationalForm.check_out_start,
        };
      });
      const result = await request<unknown>('/school/settings', session.token, {
        method: 'PUT',
        body: {
          ...operationalForm,
          weekly_schedules: weeklySchedules,
          ...(scannerPinForm ? { scanner_pin: scannerPinForm } : {}),
        },
      });
      const nextSettings = {
        ...operationalForm,
        weekly_schedules: weeklySchedules,
        ...((result as { settings?: Partial<OperationalSettings> }).settings ?? {}),
        participant_overrides: settings.participant_overrides,
      };
      setSettings(nextSettings);
      setOperationalForm(nextSettings);
      if (scannerPinForm) {
        setScannerPinForm('');
        setOperationalForm((current) => ({ ...current, scanner_pin_configured: true }));
        setSettings((current) => ({ ...current, scanner_pin_configured: true }));
      }
      const db = await database(session.school.id);
      await db.put('settings', nextSettings, 'operational');
      setMessage('Pengaturan operasional tersimpan.');
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : 'Pengaturan gagal disimpan.', true);
    }
  }

  function requestScannerMenu(target: Page | 'manual-attendance' = 'dashboard') {
    setScannerMenuTarget(target);
    setScannerMenuPin('');
    setScannerMenuOpen(true);
  }

  async function unlockScannerMenu(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session || !scannerMenuTarget) return;
    setScannerUnlockBusy(true);
    try {
      await request('/school/settings/scanner-pin/verify', session.token, {
        method: 'POST',
        body: { pin: scannerMenuPin },
      });
      setScannerMenuOpen(false);
      setScannerMenuPin('');
      if (scannerMenuTarget === 'manual-attendance') {
        setManualAttendanceQuery('');
        setManualParticipantId('');
        setManualAttendanceOpen(true);
      } else {
        setPage(scannerMenuTarget);
      }
      setError('');
      setNotice('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'PIN scanner tidak benar.');
    } finally {
      setScannerUnlockBusy(false);
    }
  }

  async function submitManualAttendance() {
    if (manualAttendanceBusy) return;
    const participant = participants.find((item) => String(item.id) === manualParticipantId);
    if (!participant) {
      setError('Pilih peserta terlebih dahulu.');
      return;
    }
    setManualAttendanceBusy(true);
    try {
      const saved = await handleScan(participant.qr_code || participant.participant_code, 'MANUAL_INPUT');
      if (saved) {
        setManualAttendanceOpen(false);
        setManualAttendanceQuery('');
        setManualParticipantId('');
        setPage('scanner');
      }
    } finally {
      setManualAttendanceBusy(false);
    }
  }

  async function selectSchoolLogo(file: File) {
    if (file.size > 1024 * 1024) {
      setMessage('Ukuran logo maksimal 1 MB.', true);
      return;
    }
    const extension = file.name.split('.').pop()?.toLowerCase();
    const mimeType = ['image/png', 'image/jpeg', 'image/webp'].includes(file.type)
      ? file.type
      : extension === 'png'
        ? 'image/png'
        : extension === 'jpg' || extension === 'jpeg'
          ? 'image/jpeg'
          : extension === 'webp'
            ? 'image/webp'
            : '';
    if (!mimeType) {
      setMessage('Pilih logo PNG, JPG, atau WebP.', true);
      return;
    }
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => typeof reader.result === 'string'
          ? resolve(reader.result)
          : reject(new Error('File logo tidak dapat dibaca.'));
        reader.onerror = () => reject(reader.error ?? new Error('File logo tidak dapat dibaca.'));
        reader.readAsDataURL(file);
      });
      const separator = dataUrl.indexOf(',');
      if (separator < 0) throw new Error('Format file logo tidak valid.');
      setSchoolLogoUpload(`data:${mimeType};base64,${dataUrl.slice(separator + 1)}`);
      setMessage('Pratinjau logo siap. Simpan identitas sekolah untuk menerapkan perubahan.');
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : 'File logo gagal dibaca.', true);
    }
  }

  async function saveSchoolBranding(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session) return;
    setSchoolBrandingBusy(true);
    try {
      const result = await request<{ branding: SchoolBranding }>('/school/branding', session.token, {
        method: 'PUT',
        body: {
          application_name: schoolBrandingName.trim(),
          theme: schoolBranding?.theme ?? 'current',
          ...(schoolLogoUpload ? { logo_data_url: schoolLogoUpload } : {}),
        },
      });
      setSchoolBranding(result.branding);
      setSchoolBrandingName(result.branding.application_name);
      setSchoolLogoUpload('');
      setMessage('Nama aplikasi dan logo sekolah berhasil disimpan.');
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : 'Identitas sekolah gagal disimpan.', true);
    } finally {
      setSchoolBrandingBusy(false);
    }
  }

  async function downloadSchoolBackup() {
    if (!session) return;
    setSchoolBackupBusy(true);
    try {
      const response = await fetch(`${API_BASE}/school/backup/export`, {
        headers: { authorization: `Bearer ${session.token}` },
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { error?: string | { message?: string } };
        const message = typeof payload.error === 'string' ? payload.error : payload.error?.message;
        throw new Error(message || `Unduhan gagal (${response.status}).`);
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = `ruang-hadir-school-${session.school.school_code}-backup-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(url);
      setMessage('Backup sekolah berhasil diunduh. Simpan file dengan aman; akun dan langganan tidak disertakan.');
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : 'Backup sekolah gagal diunduh.', true);
    } finally {
      setSchoolBackupBusy(false);
    }
  }

  async function restoreSchoolBackup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session || !schoolRestoreFile || schoolRestoreConfirmation !== 'PULIHKAN') {
      setMessage('Pilih file JSON dan ketik PULIHKAN untuk mengonfirmasi.', true);
      return;
    }
    setSchoolBackupBusy(true);
    try {
      const response = await fetch(`${API_BASE}/school/backup/restore`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${session.token}`,
          'content-type': 'application/json',
        },
        body: await schoolRestoreFile.text(),
      });
      const payload = await response.json().catch(() => ({})) as {
        message?: string;
        error?: string | { message?: string };
      };
      if (!response.ok) {
        const message = typeof payload.error === 'string' ? payload.error : payload.error?.message;
        throw new Error(message || `Restore gagal (${response.status}).`);
      }
      setSchoolRestoreFile(null);
      setSchoolRestoreConfirmation('');
      setMessage(payload.message ?? 'Data sekolah berhasil dipulihkan.');
      try {
        await Promise.all([
          loadSchoolData(session),
          request<{ branding: SchoolBranding }>('/school/branding', session.token)
            .then(({ branding }) => {
              setSchoolBranding(branding);
              setSchoolBrandingName(branding.application_name);
            }),
          request<{ settings: SchoolWhatsappGatewaySettings }>('/school/settings/whatsapp-gateway', session.token)
            .then(({ settings }) => setWhatsappSettings(settings)),
          request<{ settings: GoogleSheetsSettings }>('/school/settings/google-sheets', session.token)
            .then(({ settings }) => setGoogleSheetsSettings(settings)),
        ]);
      } catch (reason) {
        setMessage(
          `Restore berhasil, tetapi sebagian tampilan belum diperbarui: ${reason instanceof Error ? reason.message : 'muat ulang halaman.'}`,
          true,
        );
      }
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : 'Restore sekolah gagal.', true);
    } finally {
      setSchoolBackupBusy(false);
    }
  }

  async function deleteSchoolLogo() {
    if (!session || !await requestConfirmation({
      title: 'Hapus logo sekolah',
      message: 'Hapus logo sekolah dan kembali ke logo bawaan aplikasi?',
      confirmLabel: 'Hapus logo',
    })) return;
    setSchoolBrandingBusy(true);
    try {
      await request('/school/branding/logo', session.token, { method: 'DELETE' });
      setSchoolBranding((current) => current ? { ...current, logo_data_url: null } : current);
      setSchoolLogoUpload('');
      setMessage('Logo sekolah berhasil dihapus.');
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : 'Logo sekolah gagal dihapus.', true);
    } finally {
      setSchoolBrandingBusy(false);
    }
  }

  async function saveSchoolWhatsappSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session) return;
    setWhatsappBusy(true);
    setError('');
    setNotice('');
    try {
      await request('/school/settings/whatsapp-gateway', session.token, {
        method: 'PUT',
        body: {
          endpoint_url: whatsappSettings.endpoint_url,
          is_enabled: whatsappSettings.is_enabled,
          ...(whatsappToken ? { token: whatsappToken } : {}),
        },
      });
      setWhatsappToken('');
      const current = await request<{ settings: SchoolWhatsappGatewaySettings }>(
        '/school/settings/whatsapp-gateway',
        session.token,
      );
      setWhatsappSettings(current.settings);
      setNotice('Pengaturan WhatsApp gateway sekolah berhasil disimpan.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Pengaturan WhatsApp sekolah gagal disimpan.');
    } finally {
      setWhatsappBusy(false);
    }
  }

  async function saveGoogleSheetsSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session) return;
    setGoogleSheetsBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await request<{ settings: GoogleSheetsSettings }>(
        '/school/settings/google-sheets',
        session.token,
        {
          method: 'PUT',
          body: {
            web_app_url: googleSheetsSettings.web_app_url,
            is_enabled: googleSheetsSettings.is_enabled,
            ...(googleSheetsSecret ? { shared_secret: googleSheetsSecret } : {}),
          },
        },
      );
      setGoogleSheetsSettings(result.settings);
      setGoogleSheetsSecret('');
      setNotice('Sinkronisasi Google Sheets berhasil disimpan.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Pengaturan Google Sheets gagal disimpan.');
    } finally {
      setGoogleSheetsBusy(false);
    }
  }

  async function resyncGoogleSheetsHistory() {
    if (!session || !await requestConfirmation({
      title: 'Kirim ulang riwayat ke Google Sheets',
      message: 'Backend akan mengirim ulang seluruh riwayat absensi ke Apps Script. Baris dengan ID unik yang sama tidak akan digandakan.',
      confirmLabel: 'Kirim ulang riwayat',
    })) return;
    setGoogleSheetsBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await request<{ settings: GoogleSheetsSettings }>(
        '/school/settings/google-sheets/resync',
        session.token,
        { method: 'POST' },
      );
      setGoogleSheetsSettings(result.settings);
      setNotice('Kirim ulang riwayat dijadwalkan. Pantau status sinkronisasi di sini.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Riwayat gagal dijadwalkan untuk dikirim ulang.');
    } finally {
      setGoogleSheetsBusy(false);
    }
  }

  async function testSchoolWhatsappGateway() {
    if (!session) return;
    setWhatsappTestBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await request<{ log: Pick<SchoolWhatsappGatewaySettings, 'last_test_at' | 'last_test_status' | 'last_test_message'> }>(
        '/school/settings/whatsapp-gateway/test',
        session.token,
        { method: 'POST', body: { phone: `+62${whatsappTestPhone}` } },
      );
      setWhatsappSettings((current) => ({ ...current, ...result.log }));
      if (result.log.last_test_status === 'success') setNotice('Tes WA gateway sekolah berhasil dikirim.');
      else setError(result.log.last_test_message ?? 'Tes WA gateway sekolah gagal.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Tes WA gateway sekolah gagal.');
    } finally {
      setWhatsappTestBusy(false);
    }
  }

  async function startBillingPayment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session) return;
    setBillingBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await request<{ checkout_url: string }>('/school/billing/orders', session.token, {
        method: 'POST',
        body: {
          provider: billingProvider,
          plan: billingPlan,
          email: billingEmail.trim(),
          ...(billingProvider === 'duitku' ? { payment_method: paymentMethod } : {}),
        },
      });
      window.location.assign(result.checkout_url);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Tagihan pembayaran gagal dibuat.');
      setBillingBusy(false);
    }
  }

  async function saveBillingEmail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session) return;
    setBillingEmailBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await request<{ billing_email: string | null; message: string }>(
        '/school/billing/email',
        session.token,
        { method: 'PUT', body: { billing_email: billingEmail.trim() } },
      );
      setBillingEmail(result.billing_email ?? '');
      setBillingData((current) => current
        ? { ...current, billing_email: result.billing_email }
        : current);
      setNotice(result.message);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Email tagihan gagal disimpan.');
    } finally {
      setBillingEmailBusy(false);
    }
  }

  async function clearSchoolWhatsappSettings() {
    if (!session || !await requestConfirmation({
      title: 'Hapus konfigurasi gateway',
      message: 'Hapus konfigurasi WhatsApp gateway sekolah ini?',
      confirmLabel: 'Hapus konfigurasi',
    })) return;
    setWhatsappBusy(true);
    setError('');
    setNotice('');
    try {
      await request('/school/settings/whatsapp-gateway', session.token, { method: 'DELETE' });
      setWhatsappSettings({
        endpoint_url: DEFAULT_WHATSAPP_GATEWAY_URL, is_enabled: false, is_configured: false, token_hint: '',
        last_test_at: null, last_test_status: null, last_test_message: null,
      });
      setWhatsappToken('');
      setNotice('Konfigurasi WhatsApp gateway sekolah dihapus.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Konfigurasi WhatsApp sekolah gagal dihapus.');
    } finally {
      setWhatsappBusy(false);
    }
  }

  async function addHoliday(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next = [...operationalForm.holidays, holidayForm];
    setOperationalForm((current) => ({ ...current, holidays: next }));
    setHolidayForm({ date: '', name: '' });
  }

  useEffect(() => {
    if (!session || page !== 'roles') return;
    if (hasPermission(session.user.permissions, 'school.roles.view')) {
      void request<unknown>('/school/roles', session.token)
        .then((result) => setRoles(unwrapArray(result, 'roles')))
        .catch((reason: unknown) => setMessage(reason instanceof Error ? reason.message : 'Role gagal dimuat.', true));
    }
    if (hasPermission(session.user.permissions, 'school.users.view')) {
      void request<unknown>('/school/users', session.token)
        .then((result) => setUsers(unwrapArray(result, 'users')))
        .catch((reason: unknown) => setMessage(reason instanceof Error ? reason.message : 'Akun sekolah gagal dimuat.', true));
    }
  }, [page, session?.token]);

  const navItems = useMemo(() => {
    const items: { id: Page; label: string; permission?: Permission | Permission[] }[] = [
      { id: 'scanner', label: 'Scanner', permission: 'scanner.use' },
      { id: 'dashboard', label: 'Ringkasan & Rekap', permission: ['dashboard.view', 'attendance.view'] },
      { id: 'participants', label: 'Peserta', permission: 'participants.view' },
      { id: 'settings', label: 'Pengaturan', permission: 'settings.operational.view' },
      { id: 'roles', label: 'Akun & Role', permission: ['school.users.view', 'school.roles.view'] },
      { id: 'downloads', label: 'Unduh APK' },
      ...(session?.user.role_key === 'admin-sekolah' ? [{ id: 'billing' as const, label: 'Langganan' }] : []),
    ];
    return items.filter((item) => !item.permission || (Array.isArray(item.permission)
      ? item.permission.some((permission) => can(permission))
      : can(item.permission)));
  }, [session?.user.permissions, session?.user.role_key]);

  if (!session) {
    return (
      <main className="login-shell">
        {loginView === 'login' && <form className="login-card" onSubmit={(event) => void login(event)}>
          <div className="brand-mark">RH</div>
          <p className="eyebrow">PORTAL SEKOLAH</p>
          <h1>Masuk ke {applicationName}</h1>
          <label>Kode sekolah
            <input inputMode="numeric" autoComplete="organization" maxLength={4} pattern="\d{4}" required value={loginForm.school_code} onChange={(event) => setLoginForm((current) => ({ ...current, school_code: event.target.value.replace(/\D/g, '').slice(0, 4) }))} placeholder="Contoh: 4829" />
          </label>
          <label>Username / nomor WhatsApp<input autoComplete="username" required value={loginForm.username} onChange={(event) => setLoginForm((current) => ({ ...current, username: event.target.value }))} /></label>
          <label>Password
            <span className="password-input-wrap">
              <input type={showLoginPassword ? 'text' : 'password'} autoComplete="current-password" required value={loginForm.password} onChange={(event) => setLoginForm((current) => ({ ...current, password: event.target.value }))} />
              <button className="password-eye" type="button" onClick={() => setShowLoginPassword((visible) => !visible)} aria-label={showLoginPassword ? 'Sembunyikan kata sandi' : 'Tampilkan kata sandi'}><PasswordEye visible={showLoginPassword} /></button>
            </span>
          </label>
          <button className="button primary" disabled={busy}>{busy ? 'Memeriksa…' : 'Masuk ke sekolah'}</button>
          <button
            className="button secondary forgot-password-button"
            type="button"
            onClick={() => {
              setPasswordResetForm({
                ...initialPasswordResetForm,
                school_code: loginForm.school_code,
                whatsapp_phone: '',
              });
              setError('');
              setNotice('');
              setLoginView('forgot-password');
            }}
          >
            Lupa kata sandi?
          </button>
          <button className="button secondary register-school-button" type="button" onClick={() => { setLoginView('register'); setError(''); setNotice(''); }}>Daftarkan sekolah Anda</button>
        </form>}
        {loginView === 'register' && <form className="login-card registration-card" onSubmit={(event) => void startRegistration(event)}>
          <button className="text-button back-link" type="button" onClick={() => { setLoginView('login'); setError(''); setNotice(''); }}>← Kembali ke login</button>
          <div className="brand-mark">RH</div>
          <h1>Daftarkan sekolah</h1>
          <p className="muted">Kode sekolah 4 digit dibuat otomatis setelah verifikasi dan digunakan saat login.</p>
          <label>Nama sekolah<input autoComplete="organization" maxLength={180} required value={registrationForm.school_name} onChange={(event) => setRegistrationForm((current) => ({ ...current, school_name: event.target.value }))} /></label>
          <label>Username<input autoComplete="username" maxLength={80} pattern="[A-Za-z0-9._-]{3,80}" required value={registrationForm.username} onChange={(event) => setRegistrationForm((current) => ({ ...current, username: event.target.value }))} /></label>
          <label>Nomor WhatsApp admin
            <span className="phone-input-wrap">
              <span className="phone-prefix">+62</span>
              <input type="text" inputMode="numeric" autoComplete="off" maxLength={13} pattern="8[0-9]{6,12}" required value={registrationForm.whatsapp_phone} onChange={(event) => setRegistrationForm((current) => ({ ...current, whatsapp_phone: phoneNationalDigits(event.target.value) }))} />
            </span>
          </label>
          <label>Kata sandi admin
            <span className="password-input-wrap">
              <input type={showRegistrationPassword ? 'text' : 'password'} autoComplete="new-password" required value={registrationForm.password} onChange={(event) => setRegistrationForm((current) => ({ ...current, password: event.target.value }))} />
              <button className="password-eye" type="button" onClick={() => setShowRegistrationPassword((visible) => !visible)} aria-label={showRegistrationPassword ? 'Sembunyikan kata sandi' : 'Tampilkan kata sandi'}><PasswordEye visible={showRegistrationPassword} /></button>
            </span>
          </label>
          <ul className="password-checklist" aria-label="Persyaratan kata sandi">
            <li className={passwordChecks.length ? 'valid' : ''}><span>{passwordChecks.length ? '✓' : '○'}</span> Minimal 8 karakter</li>
            <li className={passwordChecks.uppercase ? 'valid' : ''}><span>{passwordChecks.uppercase ? '✓' : '○'}</span> Memiliki huruf besar</li>
            <li className={passwordChecks.number ? 'valid' : ''}><span>{passwordChecks.number ? '✓' : '○'}</span> Memiliki angka</li>
            <li className={passwordChecks.symbol ? 'valid' : ''}><span>{passwordChecks.symbol ? '✓' : '○'}</span> Memiliki simbol</li>
          </ul>
          {!passwordChecks.maxBytes && registrationForm.password && <p className="muted password-length-error">Kata sandi terlalu panjang.</p>}
          <button className="button primary" disabled={busy || !validRegistrationPassword}>{busy ? 'Mengirim OTP…' : 'Kirim kode verifikasi WhatsApp'}</button>
        </form>}
        {loginView === 'verify' && <form className="login-card registration-card" onSubmit={(event) => void verifyRegistration(event)}>
          <button className="text-button back-link" type="button" onClick={() => { setLoginView('register'); setError(''); setNotice(''); }}>← Kembali</button>
          <div className="brand-mark">RH</div>
          <p className="eyebrow">VERIFIKASI WHATSAPP</p>
          <h1>Masukkan kode OTP</h1>
          <p className="muted">Kode dikirim ke +62 {registrationForm.whatsapp_phone} dan berlaku selama 5 menit.</p>
          <label>Kode OTP<input autoComplete="one-time-code" inputMode="numeric" pattern="\d{6}" maxLength={6} required value={registrationOtp} onChange={(event) => setRegistrationOtp(event.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="6 digit" /></label>
          <button className="button primary" disabled={busy || registrationOtp.length !== 6}>{busy ? 'Memverifikasi…' : 'Verifikasi dan buat akun'}</button>
          <button className="text-button register-link" type="button" disabled={busy} onClick={() => void startRegistration()}>{busy ? 'Mengirim…' : 'Kirim ulang OTP'}</button>
        </form>}
        {loginView === 'forgot-password' && <form className="login-card registration-card" onSubmit={(event) => void startPasswordReset(event)}>
          <button className="text-button back-link" type="button" onClick={() => { setLoginView('login'); setError(''); setNotice(''); }}>← Kembali ke login</button>
          <div className="brand-mark">RH</div>
          <p className="eyebrow">PEMULIHAN AKUN</p>
          <h1>Lupa kata sandi?</h1>
          <p className="muted">Masukkan kode sekolah dan nomor WhatsApp yang terdaftar. Jika cocok dengan akun aktif, kode verifikasi akan dikirim ke nomor tersebut.</p>
          <label>Kode sekolah
            <input inputMode="numeric" autoComplete="organization" maxLength={4} pattern="\d{4}" required value={passwordResetForm.school_code} onChange={(event) => setPasswordResetForm((current) => ({ ...current, school_code: event.target.value.replace(/\D/g, '').slice(0, 4) }))} placeholder="Contoh: 4829" />
          </label>
          <label>Nomor WhatsApp terdaftar
            <span className="phone-input-wrap">
              <span className="phone-prefix">+62</span>
              <input type="text" inputMode="numeric" autoComplete="off" maxLength={13} pattern="8[0-9]{6,12}" required value={passwordResetForm.whatsapp_phone} onChange={(event) => setPasswordResetForm((current) => ({ ...current, whatsapp_phone: phoneNationalDigits(event.target.value) }))} />
            </span>
          </label>
          <button className="button primary" disabled={busy}>{busy ? 'Mengirim kode…' : 'Kirim kode reset'}</button>
        </form>}
        {loginView === 'reset-password' && <form className="login-card registration-card" onSubmit={(event) => void verifyPasswordReset(event)}>
          <button className="text-button back-link" type="button" onClick={() => { setLoginView('forgot-password'); setError(''); setNotice(''); }}>← Kembali</button>
          <div className="brand-mark">RH</div>
          <p className="eyebrow">PEMULIHAN AKUN</p>
          <h1>Buat kata sandi baru</h1>
          <label>Kode OTP WhatsApp
            <input autoComplete="one-time-code" inputMode="numeric" pattern="\d{6}" maxLength={6} required value={passwordResetForm.otp} onChange={(event) => setPasswordResetForm((current) => ({ ...current, otp: event.target.value.replace(/\D/g, '').slice(0, 6) }))} placeholder="6 digit" />
          </label>
          <label>Kata sandi baru
            <span className="password-input-wrap">
              <input type={showResetPassword ? 'text' : 'password'} autoComplete="new-password" required value={passwordResetForm.password} onChange={(event) => setPasswordResetForm((current) => ({ ...current, password: event.target.value }))} />
              <button className="password-eye" type="button" onClick={() => setShowResetPassword((visible) => !visible)} aria-label={showResetPassword ? 'Sembunyikan kata sandi' : 'Tampilkan kata sandi'}><PasswordEye visible={showResetPassword} /></button>
            </span>
          </label>
          <ul className="password-checklist" aria-label="Persyaratan kata sandi">
            <li className={resetPasswordChecks.length ? 'valid' : ''}><span>{resetPasswordChecks.length ? '✓' : '○'}</span> Minimal 8 karakter</li>
            <li className={resetPasswordChecks.uppercase ? 'valid' : ''}><span>{resetPasswordChecks.uppercase ? '✓' : '○'}</span> Memiliki huruf besar</li>
            <li className={resetPasswordChecks.number ? 'valid' : ''}><span>{resetPasswordChecks.number ? '✓' : '○'}</span> Memiliki angka</li>
            <li className={resetPasswordChecks.symbol ? 'valid' : ''}><span>{resetPasswordChecks.symbol ? '✓' : '○'}</span> Memiliki simbol</li>
          </ul>
          {!resetPasswordChecks.maxBytes && passwordResetForm.password && <p className="muted password-length-error">Kata sandi terlalu panjang.</p>}
          <button className="button primary" disabled={busy || passwordResetForm.otp.length !== 6 || !validResetPassword}>
            {busy ? 'Mengatur ulang…' : 'Atur ulang kata sandi'}
          </button>
          <button className="text-button register-link" type="button" disabled={busy} onClick={() => void startPasswordReset()}>{busy ? 'Mengirim…' : 'Kirim ulang kode OTP'}</button>
        </form>}
        {(error || notice) && <div className="toast-layer" aria-live={error ? 'assertive' : 'polite'}>
          <div className={`toast-popup ${error ? 'error' : 'success'}`} role={error ? 'alert' : 'status'}>
            <span>{error || notice}</span>
          </div>
        </div>}
      </main>
    );
  }

  return (
    <div className={page === 'scanner' ? 'portal-shell scanner-active' : 'portal-shell'} data-school-theme={schoolBranding?.theme ?? 'current'}>
      <header className="topbar">
        <div className="brand"><div className={`brand-mark${schoolBranding?.logo_data_url ? ' has-logo' : ''}`}>{schoolBranding?.logo_data_url ? <img src={schoolBranding.logo_data_url} alt="" /> : 'RH'}</div><div><strong>{session.school.name}</strong><small>Kode sekolah · {session.school.school_code}</small></div></div>
        <div className="top-actions">
          <span className={`connection ${connected ? 'online' : 'offline'}`}><i />{connected ? 'Online' : 'Offline'}</span>
          <span className="pending-pill">{pendingCount} pending</span>
          {!page ? null : page === 'scanner'
            ? <button className="button scanner-menu-button" type="button" onClick={() => requestScannerMenu('dashboard')}>Menu</button>
            : <><span className="user-chip">{session.user.display_name} · {session.user.role_name}</span><button className="button secondary" onClick={signOut}>Keluar</button></>}
        </div>
      </header>
      <div className={page === 'scanner' ? 'portal-layout kiosk-layout' : 'portal-layout'}>
        {page !== 'scanner' && <nav className="side-nav" aria-label="Menu sekolah">
          {navItems.map((item) => (
            <button key={item.id} data-page={item.id} aria-current={page === item.id ? 'page' : undefined} className={page === item.id ? 'nav-item active' : 'nav-item'} onClick={() => item.id === 'scanner' ? setPage('scanner') : setPage(item.id)}>
              {item.label}{item.id === 'scanner' && pendingCount > 0 && <span className="nav-badge">{pendingCount}</span>}
            </button>
          ))}
        </nav>}
        <main className={page === 'scanner' ? 'content scanner-kiosk' : 'content'}>
          {page === 'dashboard' && can('dashboard.view') && (
            <section>
              <p className="eyebrow">DASHBOARD SEKOLAH</p>
              <h1>Ringkasan absensi</h1>
              <p className="muted">Data operasional untuk {session.school.name}.</p>
              <div className="metric-grid">
                <article className="metric-card"><span>Peserta aktif lokal</span><strong>{participants.length}</strong></article>
                <article className="metric-card"><span>Antrean belum terkirim</span><strong>{pendingCount}</strong></article>
                <article className="metric-card"><span>Status koneksi</span><strong className={connected ? 'text-green' : 'text-red'}>{connected ? 'Online' : 'Offline'}</strong></article>
              </div>
            </section>
          )}

          {page === 'scanner' && (
            <section className="scanner-page" data-school-theme={schoolBranding?.theme ?? 'current'}>
              <header className="scan-screen-header">
                <div className="scan-header-top">
                  <div className="scan-brand">
                    <div className={`brand-mark${schoolBranding?.logo_data_url ? ' has-logo' : ''}`}>{schoolBranding?.logo_data_url ? <img src={schoolBranding.logo_data_url} alt="" /> : 'RH'}</div>
                    <div className="scan-brand-copy">
                      <strong>{displayApplicationName}</strong>
                      <div className="scan-date-time">
                        <span className="scan-date">{scanClock.toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</span>
                        <span className="scan-clock">{scanClock.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
                      </div>
                    </div>
                  </div>
                  <div className="scan-header-actions">
                    <div className={`connection-chip ${connected ? 'is-online' : 'is-offline'}`}><span />{connected ? 'Online' : 'Offline'}</div>
                    <button className="button scan-manual-button" type="button" onClick={() => requestScannerMenu('manual-attendance')}>Absensi Manual</button>
                    <button className="scan-menu-trigger" type="button" aria-label="Buka menu dengan PIN" onClick={() => requestScannerMenu('dashboard')}><span className="hamburger-icon" aria-hidden="true"><i /><i /><i /></span></button>
                  </div>
                </div>
                <div className={`scan-welcome${lastScan ? ' scan-welcome-feedback' : ''}`} aria-live="polite"><span className="scan-welcome-track">{lastScan || settings.scan_welcome_message}</span></div>
              </header>

              <div className="scan-camera-shell">
                <div className={`scan-camera-frame ${cameraActive ? 'camera-live' : ''}`}>
                  <video ref={videoRef} className="camera-video" muted playsInline />
                  {cameraActive && <div className="scan-target"><span className="scan-target-line" /></div>}
                  {!cameraActive && <div className="scan-camera-paused">Kamera dijeda</div>}
                </div>
              </div>

              {scannerPreferences.usbScannerEnabled && <form className="scanner-wedge-form" onSubmit={submitWedge}>
                <label htmlFor="scanner-wedge-code">Scanner barcode USB / Bluetooth</label>
                <div className="scanner-wedge-controls">
                  <input id="scanner-wedge-code" value={manualCode} onChange={(event) => handleWedgeChange(event.target.value)} placeholder="Fokuskan bidang ini, lalu scan kartu" autoComplete="off" autoFocus />
                  <button className="button secondary" type="submit" disabled={!manualCode.trim()}>Proses kode</button>
                </div>
              </form>}

              <section className="scan-history-card">
                <div className="scan-history-heading">
                  <div><h2>Log kehadiran terbaru</h2><p>Riwayat scan yang tersimpan di perangkat ini</p></div>
                  <div className="scan-history-actions">
                    {pendingCount > 0 && <span className="history-pending">{pendingCount} pending</span>}
                    <button type="button" className="button secondary small history-reset-button" onClick={() => void resetLocalHistory()}>Reset riwayat</button>
                  </div>
                </div>
                <LocalQueueList schoolId={session.school.id} refreshKey={`${lastScan}:${historyResetVersion}`} />
              </section>
              {scanPopup && <div className="scan-feedback-layer" aria-live={scanPopup.success ? 'polite' : 'assertive'}>
                <div key={scanPopup.id} className={`scan-feedback-popup ${scanPopup.success ? 'success' : 'error'}`} role={scanPopup.success ? 'status' : 'alert'}>{scanPopup.message}</div>
              </div>}

            </section>
          )}

          {(page === 'dashboard' || page === 'reports') && can('attendance.view') && (
            <section className="report-page">
              <div className="page-heading"><div><p className="eyebrow">LAPORAN</p><h1>{page === 'dashboard' ? 'Rekap absensi' : 'Ringkasan & Rekap'}</h1><p className="muted">Data dimuat otomatis saat menu dibuka, diperbarui setiap 30 detik, dan mengikuti filter harian atau bulanan serta kelas.</p></div></div>
              <form className="filter-form panel no-print" onSubmit={(event) => void loadReport(event)}>
                <label>Periode rekap<select value={reportPeriod} onChange={(event) => setReportPeriod(event.target.value as 'daily' | 'monthly')}><option value="monthly">Bulanan</option><option value="daily">Harian</option></select></label>
                <label>{reportPeriod === 'daily' ? 'Tanggal' : 'Bulan'}<input type={reportPeriod === 'daily' ? 'date' : 'month'} required value={reportPeriod === 'daily' ? reportDate : reportMonth} onChange={(event) => reportPeriod === 'daily' ? setReportDate(event.target.value) : setReportMonth(event.target.value)} /></label>
                <label>Kelas<select value={reportClassroom} onChange={(event) => setReportClassroom(event.target.value)}><option value="">Semua kelas</option>{classrooms.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
                <div className="heading-actions"><button className="button primary" disabled={busy}>{busy ? 'Memuat…' : 'Tampilkan'}</button>{can('attendance.export') && <button type="button" className="button secondary" onClick={() => downloadReport(monthlyReportRows, reportPeriod, reportPeriod === 'daily' ? reportDate : reportMonth)}>Ekspor CSV {reportPeriod === 'daily' ? 'harian' : 'bulanan'}</button>}{can('attendance.export') && <button type="button" className="button secondary" onClick={() => window.print()}>Cetak / PDF</button>}{can('attendance.edit') && selectedReportEntries.size > 0 && <button type="button" className="button danger" disabled={busy} onClick={() => void deleteReportEntries(reportRows.filter((row) => selectedReportEntries.has(`${row.attendance_date}:${row.participant_id}`)).map(({ participant_id, attendance_date }) => ({ participant_id, attendance_date })))}>Hapus terpilih ({selectedReportEntries.size})</button>}</div>
              </form>
              <div className="panel report-print-area">
                <div className="print-heading"><h2>{session.school.name} · Rekap Absensi</h2><p>{reportPeriod === 'daily' ? reportDate : reportMonth}</p></div>
                <div className="table-scroll"><table className="report-table"><thead><tr>{can('attendance.edit') && <th className="no-print"><input type="checkbox" aria-label="Pilih semua riwayat rekap" checked={reportRows.length > 0 && reportRows.every((row) => selectedReportEntries.has(`${row.attendance_date}:${row.participant_id}`))} onChange={(event) => setSelectedReportEntries(event.target.checked ? new Set(reportRows.map((row) => `${row.attendance_date}:${row.participant_id}`)) : new Set())} /></th>}<th>No</th><th>Nama</th><th>Kelas</th><th>Tanggal</th><th>Masuk</th><th>Menit telat</th><th>Keluar</th>{reportPeriod === 'monthly' && <><th>Total kehadiran bulanan</th><th>Total menit telat bulanan</th></>}{can('attendance.edit') && <th className="no-print">Aksi</th>}</tr></thead><tbody>
                  {monthlyReportRows.map((row, index) => <tr key={`${row.attendance_date}-${row.participant_id}-${index}`}>{can('attendance.edit') && <td className="no-print"><input type="checkbox" aria-label={`Pilih rekap ${row.participant_name} tanggal ${row.attendance_date}`} checked={selectedReportEntries.has(`${row.attendance_date}:${row.participant_id}`)} onChange={(event) => setSelectedReportEntries((current) => { const next = new Set(current); const key = `${row.attendance_date}:${row.participant_id}`; if (event.target.checked) next.add(key); else next.delete(key); return next; })} /></td>}<td>{index + 1}</td><td>{row.participant_name}</td><td>{row.classroom_name}</td><td>{row.attendance_date}</td><td>{toLocalTime(row.check_in_at)}</td><td>{row.late_minutes ?? row.menit_terlambat ?? 0}</td><td>{toLocalTime(row.check_out_at)}</td>{reportPeriod === 'monthly' && <><td>{row.monthly_attendance_count}</td><td>{row.monthly_late_minutes}</td></>}{can('attendance.edit') && <td className="no-print"><button type="button" className="button danger small" disabled={busy} onClick={() => void deleteReportEntries([{ participant_id: row.participant_id, attendance_date: row.attendance_date }])}>Hapus</button></td>}</tr>)}
                  {!monthlyReportRows.length && <tr><td colSpan={(reportPeriod === 'daily' ? 7 : 9) + (can('attendance.edit') ? 2 : 0)} className="empty">Belum ada data untuk {reportPeriod === 'daily' ? 'tanggal' : 'bulan'} dan filter ini.</td></tr>}
                </tbody></table></div>
              </div>
            </section>
          )}

          {page === 'participants' && (
            <section>
              <div className="page-heading"><div><p className="eyebrow">DATA SEKOLAH</p><h1>Master peserta</h1><p className="muted">Master lokal digunakan untuk validasi scan saat offline.</p></div></div>
              {can('participants.edit') && <form className="panel form-grid" onSubmit={(event) => void saveParticipant(event)}>
                <h2 className="wide">{editingParticipantId ? 'Edit peserta' : 'Tambah peserta'}</h2>
                <label>Nama lengkap<input required value={participantForm.full_name} onChange={(event) => setParticipantForm((current) => ({ ...current, full_name: event.target.value }))} /></label>
                <label>Kelas<select required value={participantForm.classroom_id} onChange={(event) => setParticipantForm((current) => ({ ...current, classroom_id: event.target.value }))}><option value="">Pilih kelas</option>{classrooms.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
                <label>QR / Barcode<input required value={participantForm.qr_code} onChange={(event) => setParticipantForm((current) => ({ ...current, qr_code: event.target.value }))} /></label>
                <label>No WA peserta<input type="tel" maxLength={32} placeholder="08xxxxxxxxxx" value={participantForm.participant_phone} onChange={(event) => setParticipantForm((current) => ({ ...current, participant_phone: event.target.value }))} /></label>
                <p className="muted wide">Peserta akan menerima WhatsApp otomatis jika check-in tercatat terlambat. Pastikan gateway WhatsApp sekolah aktif.</p>
                <div className="heading-actions wide">
                  <button className="button primary" disabled={busy}>{editingParticipantId ? 'Simpan perubahan' : 'Tambah peserta'}</button>
                  {editingParticipantId && <button type="button" className="button secondary" onClick={() => { setEditingParticipantId(''); setParticipantForm({ full_name: '', classroom_id: '', qr_code: '', participant_phone: '' }); }}>Batal</button>}
                </div>
              </form>}
              {can('participants.edit') && <div className="panel classroom-manager">
                <div className="section-title"><div><h2>Nama kelas / unit</h2><p className="muted">Kelola nama kelas yang digunakan pada master peserta.</p></div></div>
                <form className="classroom-form" onSubmit={(event) => void saveClassroom(event)}>
                  <label>Nama kelas<input required maxLength={100} value={classroomForm.name} onChange={(event) => setClassroomForm((current) => ({ ...current, name: event.target.value }))} placeholder="Contoh: Kelas 7A" /></label>
                  <button className="button primary" disabled={busy}>{classroomForm.id ? 'Simpan nama' : 'Tambah kelas'}</button>
                  {classroomForm.id && <button type="button" className="button secondary" onClick={() => setClassroomForm({ id: '', name: '' })}>Batal</button>}
                </form>
                <div className="classroom-list">{classrooms.map((classroom) => <div className="classroom-row" key={classroom.id}><div><strong>{classroom.name}</strong><small>{classroom.unit_name ?? 'Umum'}</small></div><div className="heading-actions"><button type="button" className="button secondary small" onClick={() => setClassroomForm({ id: classroom.id, name: classroom.name })}>Edit</button>{can('participants.delete') && <button type="button" className="button danger small" onClick={() => void deleteClassroom(classroom)}>Hapus</button>}</div></div>)}</div>
              </div>}
              {can('participants.edit') && <div className="panel participant-import">
                <div><h2>Impor dari Excel</h2><p className="muted">Gunakan Nama Kelas dari sheet Referensi Kelas; Anda juga dapat memilih ulang kelas di pratinjau. Kolom No WA Peserta digunakan untuk notifikasi saat terlambat. Maksimal 500 baris.</p></div>
                <div className="heading-actions">
                  <button type="button" className="button secondary" onClick={() => void downloadParticipantTemplate()}>Unduh template .xlsx</button>
                  <label className="button primary import-file-button">Pilih file Excel
                    <input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" disabled={busy} onChange={(event) => {
                      const file = event.currentTarget.files?.[0];
                      event.currentTarget.value = '';
                      if (file) void importParticipants(file);
                    }} />
                  </label>
                </div>
                {participantImportPreview.length > 0 && <div className="import-preview">
                  <div className="section-title">
                    <div><h3>Pratinjau {participantImportPreview.length} baris</h3><p className="muted">Kelas yang dipilih akan memakai ID kelas sekolah yang valid. Baris yang tidak ingin diimpor dapat dihapus dari pratinjau.</p></div>
                    <div className="heading-actions">
                      <button type="button" className="button primary" disabled={busy || invalidImportRowCount > 0} onClick={() => void submitParticipantImport()}>
                        {busy ? 'Menyimpan…' : `Simpan ${participantImportPreview.length} peserta`}
                      </button>
                      <button type="button" className="button secondary" disabled={busy} onClick={() => { setParticipantImportPreview([]); setParticipantImportResult(null); }}>Batal</button>
                    </div>
                  </div>
                  {invalidImportRowCount > 0 && <p className="import-preview-warning">Lengkapi nama dan pilih kelas untuk {invalidImportRowCount} baris sebelum menyimpan.</p>}
                  <div className="table-scroll"><table className="import-preview-table"><thead><tr><th>Baris</th><th>Kode peserta</th><th>Nama peserta</th><th>Kelas</th><th>QR / Barcode</th><th>No. WA peserta</th><th>Aksi</th></tr></thead><tbody>
                    {participantImportPreview.map((row) => <tr key={row.source_row}>
                      <td>{row.source_row}</td>
                      <td><input aria-label={`Kode peserta baris ${row.source_row}`} maxLength={60} value={row.participant_code} onChange={(event) => {
                        setParticipantImportResult(null);
                        setParticipantImportPreview((current) => current.map((item) => item.source_row === row.source_row ? { ...item, participant_code: event.target.value } : item));
                      }} /></td>
                      <td><input aria-label={`Nama peserta baris ${row.source_row}`} maxLength={150} value={row.full_name} onChange={(event) => {
                        setParticipantImportResult(null);
                        setParticipantImportPreview((current) => current.map((item) => item.source_row === row.source_row ? { ...item, full_name: event.target.value } : item));
                      }} /></td>
                      <td><select aria-label={`Kelas baris ${row.source_row}`} required value={row.classroom_id} onChange={(event) => {
                        setParticipantImportResult(null);
                        setParticipantImportPreview((current) => current.map((item) => item.source_row === row.source_row ? { ...item, classroom_id: event.target.value } : item));
                      }}>
                        <option value="">Pilih kelas</option>
                        {classrooms.map((classroom) => <option key={classroom.id} value={classroom.id}>{classroom.name}{classroom.unit_name ? ` · ${classroom.unit_name}` : ''} (ID {classroom.id})</option>)}
                      </select></td>
                      <td><input aria-label={`QR atau barcode baris ${row.source_row}`} maxLength={160} value={row.qr_code} onChange={(event) => {
                        setParticipantImportResult(null);
                        setParticipantImportPreview((current) => current.map((item) => item.source_row === row.source_row ? { ...item, qr_code: event.target.value } : item));
                      }} /></td>
                      <td><input aria-label={`Nomor WA peserta baris ${row.source_row}`} type="tel" maxLength={32} value={row.participant_phone} onChange={(event) => {
                        setParticipantImportResult(null);
                        setParticipantImportPreview((current) => current.map((item) => item.source_row === row.source_row ? { ...item, participant_phone: event.target.value } : item));
                      }} /></td>
                      <td><button type="button" className="button danger small" disabled={busy} onClick={() => {
                        setParticipantImportResult(null);
                        setParticipantImportPreview((current) => current.filter((item) => item.source_row !== row.source_row));
                      }}>Hapus baris</button></td>
                    </tr>)}
                  </tbody></table></div>
                </div>}
                {participantImportResult && <div className="import-result" role="status">
                  <strong>{participantImportResult.imported} peserta berhasil ditambahkan; {participantImportResult.skipped} baris dilewati.</strong>
                  {participantImportResult.results.some((item) => item.status === 'skipped') && <ul>
                    {participantImportResult.results.filter((item) => item.status === 'skipped').slice(0, 20).map((item) => (
                      <li key={`${item.row}-${item.participant_code ?? 'baris'}`}>Baris {item.row}{item.participant_code ? ` (${item.participant_code})` : ''}: {item.reason}</li>
                    ))}
                    {participantImportResult.skipped > 20 && <li>Dan {participantImportResult.skipped - 20} baris lainnya.</li>}
                  </ul>}
                </div>}
              </div>}
              {scheduleParticipantId && <div className="panel participant-schedule-editor">
                <div className="section-title"><div><h2>Jam masuk khusus: {participants.find((item) => item.id === scheduleParticipantId)?.full_name ?? 'Peserta'}</h2><p className="muted">Hari yang dibiarkan kosong mengikuti jadwal sekolah. Tersedia untuk scan offline.</p></div><button type="button" className="button secondary" onClick={() => setScheduleParticipantId('')}>Tutup</button></div>
                <div className="participant-schedule-grid">{weekDays.map((name, weekday) => <label key={weekday}>{name}
                  <input type="time" value={scheduleOverrides[weekday] ?? ''} onChange={(event) => setScheduleOverrides((current) => ({ ...current, [weekday]: event.target.value }))} />
                </label>)}</div>
                <div className="heading-actions"><button type="button" className="button primary" disabled={busy} onClick={() => void saveParticipantSchedule()}>{busy ? 'Menyimpan…' : 'Simpan jadwal khusus'}</button></div>
              </div>}
              <div className="panel">
                <div className="section-title"><div><h2>{participants.length} peserta lokal</h2><p className="muted">Data di-cache per sekolah pada perangkat ini.</p></div><div className="heading-actions">{can('participants.qr.print') && <button className="button secondary" onClick={() => void printSelectedQrs()}>Cetak QR terpilih</button>}{can('participants.delete') && selectedParticipantIds.size > 0 && <button className="button danger" disabled={busy} onClick={() => void removeSelectedParticipants()}>Hapus terpilih ({selectedParticipantIds.size})</button>}<button className="button secondary" onClick={() => session && void loadSchoolData(session)}>Sinkronkan master</button></div></div>
                <div className="table-scroll"><table><thead><tr><th><input type="checkbox" aria-label="Pilih semua peserta" checked={participants.length > 0 && participants.every((item) => selectedParticipantIds.has(item.id))} onChange={(event) => setSelectedParticipantIds(event.target.checked ? new Set(participants.map((item) => item.id)) : new Set())} /></th><th>Nama</th><th>Kelas</th><th>No. WA peserta</th><th>QR / Barcode</th><th className="no-print">Aksi</th></tr></thead><tbody>
                  {participants.map((participant) => <tr key={participant.id}><td><input type="checkbox" aria-label={`Pilih ${participant.full_name}`} checked={selectedParticipantIds.has(participant.id)} onChange={(event) => setSelectedParticipantIds((current) => { const next = new Set(current); if (event.target.checked) next.add(participant.id); else next.delete(participant.id); return next; })} /></td><td>{participant.full_name}</td><td>{participant.classroom_name ?? classrooms.find((item) => item.id === participant.classroom_id)?.name ?? '—'}</td><td>{participant.participant_phone ?? '—'}</td><td><code>{participant.qr_code}</code></td><td className="no-print"><div className="participant-actions">{can('participants.edit') && <><button className="button secondary small" onClick={() => editParticipant(participant)}>Edit</button><button className="button secondary small" onClick={() => openParticipantSchedule(participant.id)}>Atur jam</button></>}{can('participants.delete') && <button className="button danger small" onClick={() => void removeParticipant(participant)}>Hapus</button>}</div></td></tr>)}
                  {!participants.length && <tr><td colSpan={6} className="empty">Master peserta belum tersedia. Hubungkan jaringan untuk mengambil data sekolah.</td></tr>}
                </tbody></table></div>
              </div>
            </section>
          )}

          {page === 'settings' && (
            <section>
              <div className="page-heading"><div><p className="eyebrow">OPERASIONAL</p><h1>Pengaturan scanner & operasional</h1><p className="muted">Atur kamera perangkat, kecepatan scan, dan aturan operasional sekolah.</p></div></div>
              {can('settings.operational.edit') && <section className="panel scanner-preference-panel">
                <div><h2>Pengaturan scanner</h2><p className="muted">Preferensi kamera disimpan lokal pada perangkat ini, tidak mengubah perangkat scanner lainnya.</p></div>
                <div className="form-grid">
                  <label>Kamera default
                    <select value={scannerPreferences.cameraFacing} onChange={(event) => void updateScannerPreferences({ ...scannerPreferences, cameraFacing: event.target.value === 'environment' ? 'environment' : 'user' })}>
                      <option value="user">Kamera depan</option>
                      <option value="environment">Kamera belakang</option>
                    </select>
                  </label>
                  <label>Kecepatan pemindaian
                    <select value={scannerPreferences.scanSpeed} onChange={(event) => void updateScannerPreferences({ ...scannerPreferences, scanSpeed: event.target.value === 'balanced' ? 'balanced' : 'fast' })}>
                      <option value="fast">Cepat — lebih responsif</option>
                      <option value="balanced">Seimbang — lebih hemat baterai</option>
                    </select>
                  </label>
                </div>
                <label className="scanner-usb-toggle">
                  <input type="checkbox" checked={scannerPreferences.usbScannerEnabled} onChange={(event) => void updateScannerPreferences({ ...scannerPreferences, usbScannerEnabled: event.target.checked })} />
                  <span>Aktifkan field scanner barcode USB / Bluetooth</span>
                </label>
                <p className="muted">Mode cepat mengurangi jeda decode menjadi 100 ms (250 ms setelah berhasil); mode seimbang memakai 350 ms (500 ms setelah berhasil). Pemindaian aktual tetap bergantung pada kamera, fokus, pencahayaan, dan kualitas kode.</p>
              </section>}
              {can('settings.operational.view') && <section className="panel school-branding-panel">
                <div>
                  <h2>Identitas aplikasi sekolah</h2>
                  <p className="muted">Atur nama dan logo yang tampil pada scanner serta portal sekolah ini. Nama awal mengikuti nama sekolah dan dapat disesuaikan.</p>
                </div>
                {can('settings.operational.edit') ? <form className="school-branding-form" onSubmit={(event) => void saveSchoolBranding(event)}>
                  <label>Nama aplikasi sekolah
                    <input required maxLength={120} value={schoolBrandingName} onChange={(event) => setSchoolBrandingName(event.target.value)} />
                  </label>
                  <label>Tema warna scanner
                    <select value={schoolBranding?.theme ?? 'current'} disabled={schoolBrandingBusy} onChange={(event) => {
                      const theme = schoolThemeFromValue(event.currentTarget.value);
                      if (!theme) {
                        setMessage('Tema warna tidak valid.', true);
                        return;
                      }
                      setSchoolBranding((current) => current
                        ? { ...current, theme }
                        : { application_name: schoolBrandingName, logo_data_url: null, theme });
                    }}>
                      <option value="current">Warna dasar saat ini</option>
                      <option value="orange">Warna dasar oranye</option>
                      <option value="white">Warna dasar putih</option>
                    </select>
                  </label>
                  <div className="school-branding-logo-row">
                    <div className="school-branding-preview">
                      {(schoolLogoUpload || schoolBranding?.logo_data_url)
                        ? <img src={schoolLogoUpload || schoolBranding?.logo_data_url || ''} alt="Pratinjau logo sekolah" />
                        : <span>RH</span>}
                    </div>
                    <div className="school-branding-logo-controls">
                      <label>Logo sekolah (PNG, JPG, WebP; maks. 1 MB)
                        <input type="file" accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp" disabled={schoolBrandingBusy} onChange={(event) => {
                          const file = event.currentTarget.files?.[0];
                          event.currentTarget.value = '';
                          if (file) void selectSchoolLogo(file);
                        }} />
                      </label>
                      {schoolLogoUpload && <button type="button" className="button secondary small" disabled={schoolBrandingBusy} onClick={() => setSchoolLogoUpload('')}>Batalkan logo baru</button>}
                      {!schoolLogoUpload && schoolBranding?.logo_data_url && <button type="button" className="button danger small" disabled={schoolBrandingBusy} onClick={() => void deleteSchoolLogo()}>Hapus logo</button>}
                    </div>
                  </div>
                  <div className="heading-actions">
                    <button className="button primary" disabled={schoolBrandingBusy}>{schoolBrandingBusy ? 'Menyimpan…' : 'Simpan identitas'}</button>
                    <button type="button" className="button secondary" disabled={schoolBrandingBusy || !session} onClick={() => setSchoolBrandingName(session.school.name)}>Gunakan nama sekolah</button>
                  </div>
                </form> : <div className="school-branding-readonly">
                  <strong>{schoolBranding?.application_name || session.school.name}</strong>
                  {schoolBranding?.logo_data_url && <img src={schoolBranding.logo_data_url} alt="Logo sekolah" />}
                </div>}
              </section>}
              {can('settings.operational.edit') && <form className="panel settings-form" onSubmit={(event) => void saveSettings(event)}>
                <div className="form-grid">
                  <label>Zona waktu<input value={operationalForm.timezone} onChange={(event) => setOperationalForm((current) => ({ ...current, timezone: event.target.value }))} /></label>
                  <label>Batas masuk default<input type="time" required value={operationalForm.check_in_deadline.slice(0, 5)} onChange={(event) => setOperationalForm((current) => ({ ...current, check_in_deadline: `${event.target.value}:00` }))} /></label>
                  <label>Toleransi telat default (menit)<input type="number" min={0} max={180} value={operationalForm.lateness_tolerance_minutes} onChange={(event) => setOperationalForm((current) => ({ ...current, lateness_tolerance_minutes: Number(event.target.value) }))} /></label>
                  <label>Mulai pulang default<input type="time" required value={operationalForm.check_out_start.slice(0, 5)} onChange={(event) => setOperationalForm((current) => ({ ...current, check_out_start: `${event.target.value}:00` }))} /></label>
                  <label>PIN scanner (4–6 angka)
                    <input type="password" inputMode="numeric" pattern="\d{4,6}" minLength={4} maxLength={6} value={scannerPinForm} onChange={(event) => setScannerPinForm(event.target.value.replace(/\D/g, '').slice(0, 6))} placeholder={operationalForm.scanner_pin_configured ? 'PIN tersimpan — kosongkan untuk tidak mengubah' : 'Belum ada PIN khusus; awal 1234'} />
                  </label>
                </div>
                <div>
                  <h2>Jadwal mingguan</h2>
                  <p className="muted">Centang hari kerja lalu atur batas masuk, toleransi, dan mulai pulang masing-masing hari.</p>
                </div>
                <div className="schedule-list">{weekDays.map((name, weekday) => {
                  const schedule = operationalForm.weekly_schedules.find(
                    (item) => Number(item.weekday) === weekday,
                  ) ?? {
                    weekday,
                    is_working_day: weekday >= 1 && weekday <= 5,
                    check_in_deadline: operationalForm.check_in_deadline,
                    lateness_tolerance_minutes: operationalForm.lateness_tolerance_minutes,
                    check_out_start: operationalForm.check_out_start,
                  };
                  const workingDay = Boolean(Number(schedule.is_working_day));
                  return <div className="schedule-row" key={weekday}>
                    <strong>{name}</strong>
                    <label className="schedule-working-toggle">
                      <input
                        type="checkbox"
                        checked={workingDay}
                        onChange={(event) => updateWeeklySchedule(weekday, {
                          is_working_day: event.target.checked,
                        })}
                      />
                      Hari kerja
                    </label>
                    <label>Batas masuk
                      <input
                        type="time"
                        required={workingDay}
                        disabled={!workingDay}
                        value={schedule.check_in_deadline.slice(0, 5)}
                        onChange={(event) => updateWeeklySchedule(weekday, {
                          check_in_deadline: `${event.target.value}:00`,
                        })}
                      />
                    </label>
                    <label>Toleransi (menit)
                      <input
                        type="number"
                        min={0}
                        max={180}
                        required={workingDay}
                        disabled={!workingDay}
                        value={schedule.lateness_tolerance_minutes}
                        onChange={(event) => updateWeeklySchedule(weekday, {
                          lateness_tolerance_minutes: Number(event.target.value),
                        })}
                      />
                    </label>
                    <label>Mulai pulang
                      <input
                        type="time"
                        required={workingDay}
                        disabled={!workingDay}
                        value={schedule.check_out_start.slice(0, 5)}
                        onChange={(event) => updateWeeklySchedule(weekday, {
                          check_out_start: `${event.target.value}:00`,
                        })}
                      />
                    </label>
                  </div>;
                })}</div>
                <section className="attendance-speech-settings">
                  <div>
                    <h2>Pesan scanner & suara absensi</h2>
                    <p className="muted">Teks yang diatur akan tampil pada pop-up dan dibacakan setelah suara WAV. Variabel: <code>{'{name}'}</code>, <code>{'{status}'}</code>, <code>{'{reason}'}</code>.</p>
                  </div>
                  <div className="attendance-speech-tests">
                    <button className="button secondary small" type="button" onClick={() => void playAttendanceTone(true).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Suara berhasil gagal diputar.'))}>Tes berhasil.wav</button>
                    <button className="button secondary small" type="button" onClick={() => void playAttendanceTone(false).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Suara gagal.wav gagal diputar.'))}>Tes gagal.wav</button>
                    <button className="button secondary small" type="button" onClick={() => void speakAttendanceMessage(attendanceMessage(operationalForm.scan_success_message, { name: 'Contoh peserta', status: 'hadir tepat waktu', reason: '' })).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'TTS gagal diputar.'))}>Tes TTS</button>
                  </div>
                  <label>Teks sambutan scanner
                    <textarea maxLength={255} required rows={2} value={operationalForm.scan_welcome_message} onChange={(event) => setOperationalForm((current) => ({ ...current, scan_welcome_message: event.target.value }))} />
                  </label>
                  <label>Ucapan setelah absensi berhasil
                    <textarea maxLength={255} required rows={2} value={operationalForm.scan_success_message} onChange={(event) => setOperationalForm((current) => ({ ...current, scan_success_message: event.target.value }))} />
                  </label>
                  <label>Ucapan saat absensi gagal
                    <textarea maxLength={255} required rows={2} value={operationalForm.scan_failure_message} onChange={(event) => setOperationalForm((current) => ({ ...current, scan_failure_message: event.target.value }))} />
                  </label>
                </section>
                <div className="heading-actions"><button className="button primary">Simpan pengaturan</button></div>
              </form>}
              {can('settings.operational.edit') && <form className="panel holiday-form" onSubmit={(event) => void addHoliday(event)}>
                <div><h2>Hari libur khusus</h2><p className="muted">Tanggal libur sekolah di luar jadwal mingguan.</p></div>
                <div className="form-grid"><label>Tanggal<input type="date" required value={holidayForm.date} onChange={(event) => setHolidayForm((current) => ({ ...current, date: event.target.value }))} /></label><label>Nama libur<input required value={holidayForm.name} onChange={(event) => setHolidayForm((current) => ({ ...current, name: event.target.value }))} /></label><button className="button secondary">Tambah libur</button></div>
                <ul className="holiday-list">{operationalForm.holidays.map((holiday) => <li key={`${holiday.date}-${holiday.name}`}><span>{holiday.date} · {holiday.name}</span><button type="button" className="text-button" onClick={() => setOperationalForm((current) => ({ ...current, holidays: current.holidays.filter((item) => item !== holiday) }))}>Hapus</button></li>)}</ul>
              </form>}
              {can('participants.edit') && <section className="panel participant-schedule-settings">
                <div><h2>Batas masuk khusus peserta</h2><p className="muted">Pilih peserta dan atur batas waktu masuk untuk hari tertentu. Hari kosong memakai jadwal sekolah.</p></div>
                <label>Pilih peserta
                  <select value={scheduleParticipantId} onChange={(event) => openParticipantSchedule(event.target.value)}>
                    <option value="">Pilih peserta</option>
                    {participants.map((participant) => <option key={participant.id} value={participant.id}>{participant.full_name}</option>)}
                  </select>
                </label>
                {scheduleParticipantId && <>
                  <div className="participant-schedule-grid">{weekDays.map((name, weekday) => <label key={weekday}>{name}
                    <input type="time" value={scheduleOverrides[weekday] ?? ''} onChange={(event) => setScheduleOverrides((current) => ({ ...current, [weekday]: event.target.value }))} />
                  </label>)}</div>
                  <div className="heading-actions"><button type="button" className="button primary" disabled={busy} onClick={() => void saveParticipantSchedule()}>{busy ? 'Menyimpan…' : 'Simpan jadwal peserta'}</button><button type="button" className="button secondary" onClick={() => { setScheduleParticipantId(''); setScheduleOverrides({}); }}>Batal</button></div>
                </>}
              </section>}
              {can('settings.operational.view') && <section className="panel school-whatsapp-panel">
                <div>
                  <h2>Gateway WhatsApp sekolah</h2>
                  <p className="muted">Konfigurasi ini khusus untuk notifikasi sekolah, seperti keterlambatan; OTP pendaftaran dan reset kata sandi menggunakan gateway platform di Super Admin. Token dienkripsi di database dan tidak ditampilkan kembali. Simpan perubahan sebelum menguji gateway.</p>
                  <span className={`gateway-status ${whatsappSettings.is_enabled && whatsappSettings.is_configured ? 'ready' : ''}`}>
                    {whatsappSettings.is_enabled && whatsappSettings.is_configured ? '● Aktif' : '○ Belum aktif'}
                  </span>
                </div>
                {can('settings.operational.edit') ? <form className="school-whatsapp-form" onSubmit={(event) => void saveSchoolWhatsappSettings(event)}>
                  <label>URL HTTPS gateway<input type="url" required placeholder="https://gateway-production-a1168195.up.railway.app/api/send-message" value={whatsappSettings.endpoint_url} onChange={(event) => setWhatsappSettings((current) => ({ ...current, endpoint_url: event.target.value }))} /></label>
                  <label>Bearer token
                    <input type="password" autoComplete="new-password" placeholder={whatsappSettings.is_configured ? 'Tersimpan — kosongkan untuk mempertahankan' : 'Masukkan token gateway'} value={whatsappToken} onChange={(event) => setWhatsappToken(event.target.value)} />
                  </label>
                  {whatsappSettings.is_configured && <small className="gateway-hint">{whatsappSettings.token_hint}</small>}
                  <label>Nomor WhatsApp untuk tes
                    <span className="phone-input-wrap">
                      <span className="phone-prefix">+62</span>
                      <input type="text" inputMode="numeric" autoComplete="off" maxLength={13} pattern="8[0-9]{6,12}" value={whatsappTestPhone} onChange={(event) => setWhatsappTestPhone(phoneNationalDigits(event.target.value))} />
                    </span>
                  </label>
                  <label className="school-whatsapp-toggle"><input type="checkbox" checked={whatsappSettings.is_enabled} onChange={(event) => setWhatsappSettings((current) => ({ ...current, is_enabled: event.target.checked }))} /> Aktifkan konfigurasi gateway</label>
                  <div className="heading-actions">
                    <button className="button primary" disabled={whatsappBusy}>{whatsappBusy ? 'Menyimpan…' : 'Simpan pengaturan'}</button>
                    <button className="button secondary" type="button" disabled={whatsappBusy || whatsappTestBusy || !whatsappSettings.is_configured || !/^8[0-9]{6,12}$/.test(whatsappTestPhone)} onClick={() => void testSchoolWhatsappGateway()}>{whatsappTestBusy ? 'Mengirim tes…' : 'Tes WA gateway'}</button>
                    <button className="button secondary" type="button" disabled={whatsappBusy || whatsappTestBusy || !whatsappSettings.is_configured} onClick={() => void clearSchoolWhatsappSettings()}>Hapus konfigurasi</button>
                  </div>
                  {whatsappSettings.last_test_status && <div className={`gateway-test-log ${whatsappSettings.last_test_status}`}>
                    <strong>Log tes terakhir · {whatsappSettings.last_test_status === 'success' ? 'Berhasil' : 'Gagal'}</strong>
                    {whatsappSettings.last_test_at && <time>{whatsappSettings.last_test_at} UTC</time>}
                    <p>{whatsappSettings.last_test_message}</p>
                  </div>}
                </form> : <p className="muted">Konfigurasi tersedia untuk dilihat oleh akun ini.</p>}
              </section>}
              {can('settings.operational.view') && <section className="panel google-sheets-panel">
                <div>
                  <h2>Sinkronisasi Google Sheets</h2>
                  <p className="muted">Riwayat lama dan absensi baru dikirim otomatis di latar belakang. Status scan di scanner hanya berarti data sudah diterima server; status pengiriman ke Google Sheets dipantau terpisah di sini.</p>
                  <span className={`gateway-status ${googleSheetsSettings.is_enabled && googleSheetsSettings.is_configured ? 'ready' : ''}`}>
                    {googleSheetsSettings.is_enabled && googleSheetsSettings.is_configured ? '● Aktif' : '○ Belum aktif'}
                  </span>
                  {googleSheetsSettings.secret_hint && <small className="gateway-hint">Secret: {googleSheetsSettings.secret_hint}</small>}
                  {googleSheetsSettings.is_enabled && googleSheetsSettings.is_configured && googleSheetsSettings.sync_error &&
                    <div className="gateway-test-log failed">
                      <strong>Sinkronisasi gagal; akan dicoba ulang otomatis</strong>
                      <p>{googleSheetsSettings.sync_error}</p>
                    </div>}
                  {googleSheetsSettings.is_enabled && googleSheetsSettings.is_configured && !googleSheetsSettings.sync_error &&
                    <small className="gateway-hint">
                      {googleSheetsSettings.last_sync_at
                        ? `Sinkronisasi terakhir berhasil: ${googleSheetsSettings.last_sync_at} UTC`
                        : 'Riwayat absensi sedang menunggu sinkronisasi otomatis.'}
                    </small>}
                </div>
                {can('settings.operational.edit') ? <form className="school-whatsapp-form" onSubmit={(event) => void saveGoogleSheetsSettings(event)}>
                  <label>URL Web App Apps Script<input type="url" required placeholder="https://script.google.com/macros/s/.../exec" value={googleSheetsSettings.web_app_url} onChange={(event) => setGoogleSheetsSettings((current) => ({ ...current, web_app_url: event.target.value }))} /></label>
                  <label>Secret sinkronisasi<input type="password" autoComplete="new-password" placeholder={googleSheetsSettings.is_configured ? 'Tersimpan — kosongkan untuk mempertahankan' : 'Masukkan secret yang sama dengan Script Properties'} value={googleSheetsSecret} onChange={(event) => setGoogleSheetsSecret(event.target.value)} /></label>
                  <label className="school-whatsapp-toggle"><input type="checkbox" checked={googleSheetsSettings.is_enabled} onChange={(event) => setGoogleSheetsSettings((current) => ({ ...current, is_enabled: event.target.checked }))} /> Aktifkan sinkronisasi</label>
                  <button className="button primary" disabled={googleSheetsBusy}>{googleSheetsBusy ? 'Menyimpan…' : 'Simpan pengaturan'}</button>
                  {googleSheetsSettings.is_enabled && googleSheetsSettings.is_configured &&
                    <button className="button" type="button" disabled={googleSheetsBusy} onClick={() => void resyncGoogleSheetsHistory()}>
                      {googleSheetsBusy ? 'Memproses…' : 'Kirim ulang riwayat'}
                    </button>}
                </form> : <p className="muted">URL: {googleSheetsSettings.web_app_url || 'Belum dikonfigurasi'}</p>}
              </section>}
              {session.user.role_key === 'admin-sekolah' && <section className="panel school-backup-panel">
                <div>
                  <h2>Backup &amp; restore sekolah</h2>
                  <p className="muted">Unduh JSON berisi data operasional sekolah. Restore mengganti data operasional dari file, tetapi mempertahankan akun, akses, perangkat scanner, dan langganan.</p>
                  <p className="muted">File backup dapat berisi data peserta dan kehadiran. Simpan dengan aman. File tidak dikirim ke Telegram.</p>
                  <button type="button" className="button secondary" disabled={schoolBackupBusy} onClick={() => void downloadSchoolBackup()}>
                    {schoolBackupBusy ? 'Memproses…' : 'Unduh backup JSON'}
                  </button>
                </div>
                <form className="school-backup-form" onSubmit={(event) => void restoreSchoolBackup(event)}>
                  <h3>Pulihkan backup sekolah</h3>
                  <p className="alert warning">Data operasional sekolah saat ini akan diganti. Akun, akses, perangkat scanner, dan masa langganan tidak diubah.</p>
                  <label>File backup JSON
                    <input type="file" accept=".json,application/json" required disabled={schoolBackupBusy} onChange={(event) => {
                      setSchoolRestoreFile(event.currentTarget.files?.[0] ?? null);
                      event.currentTarget.value = '';
                    }} />
                  </label>
                  <label>Ketik PULIHKAN untuk mengonfirmasi
                    <input value={schoolRestoreConfirmation} onChange={(event) => setSchoolRestoreConfirmation(event.target.value)} autoComplete="off" disabled={schoolBackupBusy} />
                  </label>
                  <button className="button danger" disabled={schoolBackupBusy || !schoolRestoreFile || schoolRestoreConfirmation !== 'PULIHKAN'}>
                    {schoolBackupBusy ? 'Memulihkan…' : 'Pulihkan data sekolah'}
                  </button>
                </form>
              </section>}
            </section>
          )}

          {page === 'roles' && (
            <section>
              <div className="page-heading"><div><p className="eyebrow">AKSES SEKOLAH</p><h1>Akun & role</h1><p className="muted">Atur izin melihat, mengubah, dan menghapus untuk setiap modul.</p></div></div>
              {can('school.roles.edit') && <form className="panel form-grid" onSubmit={(event) => void saveRole(event)}>
                <h2 className="wide">Buat role</h2>
                <label>Kunci role<input required pattern="[a-z0-9-]+" value={roleForm.role_key} onChange={(event) => setRoleForm((current) => ({ ...current, role_key: event.target.value.toLowerCase() }))} placeholder="wakasek-kurikulum" /></label>
                <label>Nama role<input required value={roleForm.role_name} onChange={(event) => setRoleForm((current) => ({ ...current, role_name: event.target.value }))} placeholder="Wakasek Kurikulum" /></label>
                <div className="wide role-permission-matrix">
                  {ROLE_PERMISSION_GROUPS.map((group) => <div className="role-permission-row" key={group.key}>
                    <strong>{group.label}</strong>
                    {(['view', 'edit', 'delete'] as const).map((action) => {
                      const permission = group[action];
                      if (!permission) return null;
                      return <label key={action}><input type="checkbox" checked={roleForm.permissions.includes(permission)} onChange={(event) => setRoleForm((current) => ({ ...current, permissions: updateRolePermission(current.permissions, group, action, event.target.checked) }))} />{action === 'view' ? 'Lihat' : action === 'edit' ? 'Edit' : 'Hapus'}</label>;
                    })}
                  </div>)}
                </div>
                <button className="button primary" disabled={!roleForm.permissions.length}>Tambah role</button>
              </form>}
              {can('school.roles.view') && <div className="panel role-list-panel"><h2>Daftar role</h2>
                {roles.map((role, index) => {
                  const roleId = String(role.id ?? index);
                  const rolePermissions = normalizeRolePermissions(role.permissions);
                  return <article className="role-card" key={roleId}>
                    <div className="role-card-heading"><div><strong>{String(role.role_name ?? role.name ?? '—')}</strong><code>{String(role.role_key ?? '')}</code></div>
                      {can('school.roles.edit') && <button className="button primary small" disabled={roleSavingId === roleId} onClick={() => void saveExistingRole(role)}>{roleSavingId === roleId ? 'Menyimpan…' : 'Simpan izin'}</button>}
                      {can('school.roles.delete') && String(role.role_key) !== 'admin-sekolah' && <button className="button danger small" onClick={() => void deleteRole(role)}>Hapus role</button>}
                    </div>
                    <div className="role-permission-matrix">{ROLE_PERMISSION_GROUPS.map((group) => <div className="role-permission-row" key={group.key}>
                      <strong>{group.label}</strong>
                      {(['view', 'edit', 'delete'] as const).map((action) => {
                        const permission = group[action];
                        if (!permission) return null;
                        return <label key={action}><input type="checkbox" disabled={!can('school.roles.edit')} checked={rolePermissions.includes(permission)} onChange={(event) => setRoles((current) => current.map((item) => String(item.id) === roleId ? { ...item, permissions: updateRolePermission(normalizeRolePermissions(item.permissions), group, action, event.target.checked) } : item))} />{action === 'view' ? 'Lihat' : action === 'edit' ? 'Edit' : 'Hapus'}</label>;
                      })}
                    </div>)}</div>
                  </article>;
                })}
                {!roles.length && <p className="empty">Belum ada role yang dimuat.</p>}
              </div>}
              {can('school.users.edit') && <form className="panel form-grid" onSubmit={(event) => void saveUser(event)}>
                <h2 className="wide">Buat akun sekolah</h2>
                <label>Nama tampilan<input required value={userForm.display_name} onChange={(event) => setUserForm((current) => ({ ...current, display_name: event.target.value }))} /></label>
                <label>Username<input required value={userForm.username} onChange={(event) => setUserForm((current) => ({ ...current, username: event.target.value }))} /></label>
                <label>Password sementara<input type="password" minLength={12} required value={userForm.password} onChange={(event) => setUserForm((current) => ({ ...current, password: event.target.value }))} /></label>
                <label>Role<select required value={userForm.role_id} onChange={(event) => setUserForm((current) => ({ ...current, role_id: event.target.value }))}><option value="">Pilih role</option>{roles.map((role, index) => <option key={String(role.id ?? index)} value={String(role.id)}>{String(role.role_name ?? role.name)}</option>)}</select></label>
                <button className="button primary">Buat akun</button>
              </form>}
              {can('school.users.view') && <div className="panel"><h2>Daftar akun</h2><div className="table-scroll"><table><thead><tr><th>Username</th><th>Nama</th><th>Role</th><th>Status</th>{can('school.users.delete') && <th>Aksi</th>}</tr></thead><tbody>{users.map((user, index) => <tr key={String(user.id ?? index)}><td>{String(user.username ?? '')}</td><td>{String(user.display_name ?? '')}</td><td>{String(user.role_name ?? '')}</td><td>{Number(user.is_active) ? 'Aktif' : 'Nonaktif'}</td>{can('school.users.delete') && <td>{Number(user.is_active) ? <button className="button danger small" onClick={() => void deactivateUser(user)}>Nonaktifkan</button> : '—'}</td>}</tr>)}</tbody></table></div></div>}
            </section>
          )}

          {page === 'downloads' && (
            <section>
              <div className="page-heading"><div><p className="eyebrow">APLIKASI ANDROID</p><h1>Unduh aplikasi absensi</h1><p className="muted">APK disediakan melalui Google Drive dan belum dipublikasikan di Play Store.</p></div></div>
              <div className="panel apk-download-panel">
                {apkDriveUrl
                  ? <><div className="apk-download-icon" aria-hidden="true">↓</div><h2>Versi Android tersedia</h2><p className="muted">Pastikan nama dan versi file sesuai instruksi Admin sekolah sebelum memasang.</p><a className="button primary" href={apkDriveUrl} target="_blank" rel="noopener noreferrer">Buka link download Google Drive</a></>
                  : <><h2>APK belum tersedia</h2><p className="muted">Link unduhan akan muncul di sini setelah Super Admin mengaturnya.</p></>}
              </div>
            </section>
          )}

          {page === 'billing' && (
            <section>
              <div className="page-heading"><div><p className="eyebrow">AKUN SEKOLAH</p><h1>Langganan &amp; pembayaran</h1><p className="muted">Kelola akses dan perpanjang layanan sekolah.</p></div></div>
              {session.school.subscription_expired && <div className="alert warning"><strong>Masa aktif sekolah telah berakhir.</strong> Scan dan fitur operasional dihentikan sampai langganan diperpanjang. Silakan lanjutkan pembayaran di halaman ini.</div>}
              {session.school.subscription_expired && session.user.role_key !== 'admin-sekolah' && <div className="panel"><p className="muted">Hubungi Admin Sekolah untuk melakukan pembayaran perpanjangan langganan.</p></div>}
              {billingData && (
                <>
                  <div className="panel billing-status-panel">
                    <div><small>Status langganan</small><strong>{billingData.subscription.status === 'lifetime' ? 'Lifetime' : billingData.subscription.expired ? 'Kedaluwarsa' : billingData.subscription.status === 'trial' ? 'Uji coba' : 'Aktif'}</strong></div>
                    <div><small>Masa berlaku</small><strong>{billingData.subscription.status === 'lifetime' ? 'Selamanya' : billingData.subscription.expires_at ? new Date(billingData.subscription.expires_at).toLocaleDateString('id-ID') : billingData.subscription.trial_ends_at ? new Date(billingData.subscription.trial_ends_at).toLocaleDateString('id-ID') : 'Belum ditentukan'}</strong></div>
                  </div>
                  {billingData.subscription.status !== 'lifetime' && (
                    <form className="panel billing-form" onSubmit={(event) => void saveBillingEmail(event)}>
                      <h2>Profil tagihan Kasera</h2>
                      <p className="muted">Email ini hanya diteruskan ke Kasera sebagai data pelanggan invoice. Aplikasi tidak mengirim notifikasi email; invoice dan tautan pembayaran otomatis H-3 dikirim ke WhatsApp Admin Sekolah. Pastikan Kasera dan WhatsApp Gateway platform aktif.</p>
                      <div className="form-grid">
                        <label>Email tagihan
                          <input type="email" autoComplete="email" maxLength={254} required value={billingEmail} onChange={(event) => setBillingEmail(event.target.value)} />
                        </label>
                        <button className="button primary" disabled={billingEmailBusy}>{billingEmailBusy ? 'Menyimpan…' : 'Simpan email tagihan'}</button>
                      </div>
                    </form>
                  )}
                  {billingData.subscription.status !== 'lifetime' && (
                    <form className="panel billing-form" onSubmit={(event) => void startBillingPayment(event)}>
                      <h2>Pilih paket</h2>
                      <div className="form-grid">
                        <label>Paket
                          <select value={billingPlan} onChange={(event) => setBillingPlan(event.target.value as 'monthly' | 'lifetime')}>
                            <option value="monthly">Bulanan · {rupiah(billingData.prices.monthly)}</option>
                            <option value="lifetime">Lifetime · {rupiah(billingData.prices.lifetime)}</option>
                          </select>
                        </label>
                        <label>Payment gateway
                          <select value={billingProvider} onChange={(event) => setBillingProvider(event.target.value as 'xendit' | 'duitku' | 'kasera')}>
                            {billingData.providers.xendit && <option value="xendit">Xendit</option>}
                            {billingData.providers.duitku && <option value="duitku">Duitku</option>}
                            {billingData.providers.kasera && <option value="kasera">Kasera</option>}
                          </select>
                        </label>
                        <label>Email bukti pembayaran<input type="email" autoComplete="email" required maxLength={255} value={billingEmail} onChange={(event) => setBillingEmail(event.target.value)} /></label>
                        {billingProvider === 'duitku' && <label>Metode pembayaran
                          <select required value={paymentMethod} onChange={(event) => setPaymentMethod(event.target.value)}>
                            {paymentMethods.map((method) => <option key={method.code} value={method.code}>{method.name}{method.fee ? ` · biaya ${rupiah(method.fee)}` : ''}</option>)}
                          </select>
                        </label>}
                        <div className="billing-total"><span>Total</span><strong>{rupiah(billingPlan === 'lifetime' ? billingData.prices.lifetime : billingData.prices.monthly)}</strong></div>
                        <button className="button primary" disabled={billingBusy || (!billingData.providers.xendit && !billingData.providers.duitku && !billingData.providers.kasera) || (billingProvider === 'duitku' && !paymentMethod)}>
                          {billingBusy ? 'Membuat tagihan…' : 'Lanjutkan pembayaran'}
                        </button>
                      </div>
                      {!billingData.providers.xendit && !billingData.providers.duitku && !billingData.providers.kasera && <p className="alert warning">Payment gateway belum dikonfigurasi oleh Super Admin.</p>}
                    </form>
                  )}
                  <div className="panel">
                    <div className="section-title"><div><h2>Riwayat tagihan</h2><p className="muted">Status diperbarui otomatis setelah callback payment gateway terverifikasi.</p></div><button className="button secondary" onClick={() => void loadBillingData()}>Muat ulang</button></div>
                    <div className="table-scroll"><table><thead><tr><th>Order</th><th>Paket</th><th>Provider</th><th>Jumlah</th><th>Status</th><th>Tanggal</th><th>Link</th></tr></thead><tbody>
                      {billingData.orders.map((order) => <tr key={order.order_id}><td><code>{order.order_id}</code></td><td>{order.plan === 'lifetime' ? 'Lifetime' : 'Bulanan'}</td><td>{order.provider}</td><td>{rupiah(order.amount)}</td><td>{order.status}</td><td>{new Date(order.created_at).toLocaleString('id-ID')}</td><td>{order.status === 'pending' && order.checkout_url ? <a href={order.checkout_url} target="_blank" rel="noopener noreferrer">Bayar</a> : '—'}</td></tr>)}
                      {!billingData.orders.length && <tr><td colSpan={7} className="empty">Belum ada tagihan.</td></tr>}
                    </tbody></table></div>
                  </div>
                </>
              )}
            </section>
          )}
        </main>
      </div>
      {(error || notice) && <div className="toast-layer" aria-live={error ? 'assertive' : 'polite'}>
        <div className={`toast-popup ${error ? 'error' : 'success'}`} role={error ? 'alert' : 'status'}>
          <span>{error || notice}</span>
        </div>
      </div>}
      {confirmationDialog && <div
        className="pin-modal-backdrop"
        role="presentation"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) resolveConfirmation(false);
        }}
      >
        <section className="pin-modal confirm-modal" role="dialog" aria-modal="true" aria-labelledby="confirm-dialog-title" aria-describedby="confirm-dialog-message">
          <div className="pin-modal-icon" aria-hidden="true">!</div>
          <h2 id="confirm-dialog-title">{confirmationDialog.title}</h2>
          <p id="confirm-dialog-message">{confirmationDialog.message}</p>
          <div className="pin-modal-actions">
            <button type="button" className="button secondary" onClick={() => resolveConfirmation(false)}>Batal</button>
            <button type="button" className="button danger" onClick={() => resolveConfirmation(true)}>{confirmationDialog.confirmLabel}</button>
          </div>
        </section>
      </div>}
      {scannerMenuOpen && <div className="pin-modal-backdrop" role="presentation">
        <form className="pin-modal" onSubmit={(event) => void unlockScannerMenu(event)} role="dialog" aria-modal="true" aria-labelledby="scanner-pin-title">
          <div className="pin-modal-icon" aria-hidden="true">PIN</div>
          <h2 id="scanner-pin-title">{scannerMenuTarget === 'manual-attendance' ? 'Konfirmasi absensi manual' : 'Masuk ke menu sekolah'}</h2>
          <p>Masukkan PIN scanner untuk melanjutkan.</p>
          <input className="pin-modal-input" type="password" inputMode="numeric" pattern="\d{4,6}" minLength={4} maxLength={6} autoComplete="off" required autoFocus value={scannerMenuPin} onChange={(event) => setScannerMenuPin(event.target.value.replace(/\D/g, '').slice(0, 6))} />
          {error && <div className="pin-modal-error">{error}</div>}
          <div className="pin-modal-actions">
            <button type="button" className="button secondary" onClick={() => { setScannerMenuOpen(false); setScannerMenuPin(''); setError(''); }}>Batal</button>
            <button className="button primary" disabled={scannerUnlockBusy}>{scannerUnlockBusy ? 'Memeriksa…' : 'Buka menu'}</button>
          </div>
        </form>
      </div>}
      {manualAttendanceOpen && <div className="pin-modal-backdrop" role="presentation">
        <section className="pin-modal manual-attendance-modal" role="dialog" aria-modal="true" aria-labelledby="manual-attendance-title">
          <h2 id="manual-attendance-title">Pilih peserta</h2>
          <p>Status Masuk atau Pulang ditentukan otomatis mengikuti catatan hari ini.</p>
          <label>Cari nama, kode, atau kelas
            <input autoFocus value={manualAttendanceQuery} onChange={(event) => setManualAttendanceQuery(event.target.value)} />
          </label>
          <label>Peserta
            <select value={manualParticipantId} onChange={(event) => setManualParticipantId(event.target.value)}>
              <option value="">Pilih peserta</option>
              {participants.filter((participant) => {
                const search = manualAttendanceQuery.trim().toLocaleLowerCase();
                return !search || [participant.full_name, participant.classroom_name]
                  .some((value) => String(value ?? '').toLocaleLowerCase().includes(search));
              }).map((participant) => (
                <option key={participant.id} value={String(participant.id)}>
                  {participant.full_name} · {participant.classroom_name}
                </option>
              ))}
            </select>
          </label>
          <div className="pin-modal-actions">
            <button type="button" className="button secondary" disabled={manualAttendanceBusy} onClick={() => setManualAttendanceOpen(false)}>Batal</button>
            <button type="button" className="button primary" disabled={!manualParticipantId || manualAttendanceBusy} onClick={() => void submitManualAttendance()}>{manualAttendanceBusy ? 'Mencatat…' : 'Catat absensi'}</button>
          </div>
        </section>
      </div>}
    </div>
  );
}

function formatAttendanceDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : '—';
}

function LocalQueueList({ schoolId, refreshKey }: { schoolId: string | number; refreshKey: string }) {
  const [items, setItems] = useState<QueuedScan[]>([]);
  const [participantNames, setParticipantNames] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    let active = true;
    void database(schoolId).then(async (db) => {
      const [scans, participants] = await Promise.all([
        db.getAll('queue'),
        db.getAll('participants'),
      ]);
      if (active) {
        setItems(scans.sort((a, b) => b.client_timestamp.localeCompare(a.client_timestamp)).slice(0, 8));
        setParticipantNames(new Map(participants.map((participant) => [
          String(participant.id),
          participant.full_name,
        ])));
      }
    }).catch((error: unknown) => console.error('Riwayat lokal gagal dimuat.', error));
    return () => { active = false; };
  }, [schoolId, refreshKey]);
  return <div className="table-scroll"><table><thead><tr><th>Nama</th><th>Tanggal</th><th>Waktu</th><th>Jenis</th><th>Status server</th></tr></thead><tbody>
    {items.map((item) => <tr key={item.id_unik}>
      <td>{item.participant_name ?? participantNames.get(item.id_peserta) ?? 'Nama tidak tersedia'}</td>
      <td>{formatAttendanceDate(item.attendance_date)}</td>
      <td>{toLocalTime(item.client_timestamp)}</td>
      <td>{item.jenis_absen === 'check_in' ? 'Masuk' : 'Pulang'}</td>
      <td><span className={`tag ${item.status_sync}`}>{item.status_sync === 'synced' ? 'Tersimpan di server' : 'Belum ke server'}</span></td>
    </tr>)}
    {!items.length && <tr><td colSpan={5} className="empty">Belum ada scan tersimpan di perangkat.</td></tr>}
  </tbody></table></div>;
}
