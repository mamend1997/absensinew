import { BrowserMultiFormatReader } from '@zxing/browser';
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import QRCode from 'qrcode';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  calculateAttendance,
  createQueuedScan,
} from './core/attendance.js';
import { createOfflineSyncManager } from './core/offline-sync.js';

const API_BASE = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '');
const SESSION_KEY = 'saas_school_session';
const DEVICE_KEY_PREFIX = 'saas_scanner_device_key_';
type Page = 'dashboard' | 'scanner' | 'reports' | 'participants' | 'settings' | 'roles' | 'devices' | 'downloads' | 'billing';
type Permission =
  | 'dashboard.read'
  | 'attendance.read'
  | 'attendance.export'
  | 'participants.read'
  | 'participants.manage'
  | 'participants.qr.print'
  | 'settings.operational.manage'
  | 'attendance.excuse.manage'
  | 'scanner.use'
  | 'school.users.manage'
  | 'school.roles.manage'
  | 'scanner.devices.manage';

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
  permissions: Permission[];
}
interface SchoolSession { token: string; school: SchoolInfo; user: UserInfo }
interface BillingData {
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
  is_active?: boolean | number;
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
interface ReportRow {
  attendance_date: string;
  participant_name: string;
  participant_code: string;
  classroom_name: string;
  check_in_at?: string | null;
  check_out_at?: string | null;
  attendance_status?: string;
  late_minutes?: number;
  menit_terlambat?: number;
}
interface Device { id: string | number; device_name: string; is_active: boolean | number }
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
  id_perangkat: string | null;
  jenis_absen: 'check_in' | 'check_out';
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
  return permissions.includes('scanner.use') &&
    (!permissions.includes('dashboard.read') || window.matchMedia('(max-width: 900px)').matches)
    ? 'scanner'
    : 'dashboard';
}

async function request<T>(
  path: string,
  token?: string,
  options: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: options.method ?? 'GET',
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
    const message = typeof apiError === 'string'
      ? apiError
      : apiError && typeof apiError === 'object' &&
        typeof (apiError as Record<string, unknown>).message === 'string'
        ? (apiError as Record<string, unknown>).message as string
        : `Permintaan gagal (${response.status}).`;
    throw new Error(message);
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
  const date = new Date(value);
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

function downloadReport(rows: ReportRow[]) {
  const table = [
    ['Tanggal', 'Kode', 'Nama', 'Kelas', 'Masuk', 'Keluar', 'Status', 'Menit terlambat'],
    ...rows.map((row) => [
      row.attendance_date,
      row.participant_code,
      row.participant_name,
      row.classroom_name,
      row.check_in_at ?? '',
      row.check_out_at ?? '',
      row.attendance_status ?? '',
      row.late_minutes ?? row.menit_terlambat ?? 0,
    ]),
  ];
  const blob = new Blob(
    [`\uFEFF${table.map((row) => row.map(csvCell).join(';')).join('\r\n')}`],
    { type: 'text/csv;charset=utf-8' },
  );
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'rekap-absensi.csv';
  link.click();
  URL.revokeObjectURL(url);
}

export default function App() {
  const [session, setSession] = useState<SchoolSession | null>(readSession);
  const [applicationName, setApplicationName] = useState('Ruang Hadir');
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
  const [roles, setRoles] = useState<Record<string, unknown>[]>([]);
  const [users, setUsers] = useState<Record<string, unknown>[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [apkDriveUrl, setApkDriveUrl] = useState('');
  const [billingData, setBillingData] = useState<BillingData | null>(null);
  const [billingProvider, setBillingProvider] = useState<'xendit' | 'duitku' | 'kasera'>('xendit');
  const [billingPlan, setBillingPlan] = useState<'monthly' | 'lifetime'>('monthly');
  const [billingEmail, setBillingEmail] = useState('');
  const [paymentMethods, setPaymentMethods] = useState<PaymentMethod[]>([]);
  const [paymentMethod, setPaymentMethod] = useState('');
  const [billingBusy, setBillingBusy] = useState(false);
  const [whatsappSettings, setWhatsappSettings] = useState<SchoolWhatsappGatewaySettings>({
    endpoint_url: '',
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
  const [reportRows, setReportRows] = useState<ReportRow[]>([]);
  const [reportFrom, setReportFrom] = useState(initialDate);
  const [reportTo, setReportTo] = useState(initialDate);
  const [reportStatus, setReportStatus] = useState('');
  const [reportClassroom, setReportClassroom] = useState('');
  const [pendingCount, setPendingCount] = useState(0);
  const [online, setOnline] = useState(navigator.onLine);
  const [deviceKey, setDeviceKey] = useState('');
  const [lastScan, setLastScan] = useState('');
  const [manualCode, setManualCode] = useState('');
  const [selectedParticipantIds, setSelectedParticipantIds] = useState<Set<string>>(new Set());
  const [scanClock, setScanClock] = useState(() => new Date());
  const [participantForm, setParticipantForm] = useState({
    participant_code: '', full_name: '', classroom_id: '', qr_code: '',
  });
  const [classroomForm, setClassroomForm] = useState({ id: '', name: '' });
  const [roleForm, setRoleForm] = useState({ role_key: '', role_name: '', permissions: '' });
  const [userForm, setUserForm] = useState({ username: '', display_name: '', password: '', role_id: '' });
  const [deviceName, setDeviceName] = useState('Scanner sekolah');
  const [operationalForm, setOperationalForm] = useState(initialSettings);
  const [scannerPreferences, setScannerPreferences] = useState(initialScannerPreferences);
  const [scannerPreferencesReady, setScannerPreferencesReady] = useState(false);
  const [scannerPinForm, setScannerPinForm] = useState('');
  const [scannerMenuOpen, setScannerMenuOpen] = useState(false);
  const [scannerMenuPin, setScannerMenuPin] = useState('');
  const [scannerMenuTarget, setScannerMenuTarget] = useState<Page | null>(null);
  const [scannerUnlockBusy, setScannerUnlockBusy] = useState(false);
  const [holidayForm, setHolidayForm] = useState({ date: '', name: '' });
  const [cameraActive, setCameraActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [offlineMode, setOfflineMode] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const controlsRef = useRef<{ stop: () => void } | null>(null);
  const wedgeTimerRef = useRef<number | undefined>(undefined);
  const lastScanAtRef = useRef(new Map<string, number>());
  const deviceStorageKey = session ? `${DEVICE_KEY_PREFIX}${session.school.id}` : '';
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
    let active = true;
    let objectUrl = '';
    fetch(`${API_BASE}/branding/logo`, { cache: 'no-store' })
      .then(async (response) => {
        if (response.status === 404) return null;
        if (!response.ok) throw new Error(`Logo platform gagal dimuat (${response.status}).`);
        return response.blob();
      })
      .then((blob) => {
        if (!active || !blob) return;
        objectUrl = URL.createObjectURL(blob);
        const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]') ??
          document.head.appendChild(Object.assign(document.createElement('link'), { rel: 'icon' }));
        link.href = objectUrl;
      })
      .catch((reason: unknown) => console.error('Favicon platform gagal dimuat.', reason));
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
      if (link) link.href = '/favicon.svg';
    };
  }, []);

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
    document.title = `${applicationName} · Portal Sekolah`;
  }, [applicationName]);

  const permissions = session?.user.permissions ?? [];
  const can = (permission: Permission) => permissions.includes(permission);
  useEffect(() => {
    if (!session) return;
    const savedDeviceKey = localStorage.getItem(deviceStorageKey) ?? sessionStorage.getItem(deviceStorageKey);
    if (savedDeviceKey) localStorage.setItem(deviceStorageKey, savedDeviceKey);
    sessionStorage.removeItem(deviceStorageKey);
    setDeviceKey(savedDeviceKey ?? '');
    void request<{ session?: SchoolSession; school?: SchoolInfo; user?: UserInfo }>(
      '/school/auth/me',
      session.token,
    ).then((result) => {
      const refreshed = result.session ?? (result.school && result.user
        ? { ...session, school: result.school, user: result.user }
        : session);
      setSession(refreshed);
      localStorage.setItem(SESSION_KEY, JSON.stringify(refreshed));
      setOfflineMode(false);
      setPage(initialPage(refreshed));
      if (!refreshed.school.subscription_expired) {
        void loadSchoolData(refreshed);
      }
    }).catch((reason: unknown) => {
      setOfflineMode(true);
      setError(reason instanceof Error ? reason.message : 'Sesi sekolah gagal diperbarui.');
    });
  }, [session?.token]);

  useEffect(() => {
    if (!session || page !== 'billing' ||
        !session.user.permissions.includes('school.users.manage')) return;
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
    if (!session || !session.user.permissions.includes('settings.operational.manage')) return;
    request<{ settings: SchoolWhatsappGatewaySettings }>(
      '/school/settings/whatsapp-gateway',
      session.token,
    )
      .then((result) => setWhatsappSettings(result.settings))
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Pengaturan WhatsApp sekolah gagal dimuat.'));
  }, [session?.token]);

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
    void startCamera(scannerPreferences);
    return () => {
      controlsRef.current?.stop();
      controlsRef.current = null;
      setCameraActive(false);
    };
  }, [page, session?.school.id, scannerPreferencesReady]);

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
    if (!session || page !== 'scanner' || !online || !deviceKey) return;
    void syncPending().catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : 'Sinkronisasi otomatis gagal.');
    });
  }, [online, deviceKey, page, session?.school.id]);

  useEffect(() => {
    const timer = window.setInterval(() => setScanClock(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!session || page !== 'scanner' || !online || !deviceKey) return;
    const timer = window.setInterval(() => {
      void syncPending().catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : 'Sinkronisasi otomatis gagal.');
      });
    }, 10000);
    return () => window.clearInterval(timer);
  }, [online, deviceKey, page, session?.school.id]);

  async function loadSchoolData(currentSession: SchoolSession) {
    if (currentSession.school.subscription_expired) return;
    const db = await database(currentSession.school.id);
    const cached = await db.getAll('participants');
    setParticipants(cached);
    const cachedSettings = await db.get('settings', 'operational');
    if (cachedSettings) {
      setSettings(cachedSettings);
      setOperationalForm(cachedSettings);
    }
    try {
      const [participantResult, classroomResult, settingResult] = await Promise.all([
        request<unknown>('/school/participants', currentSession.token),
        request<unknown>('/school/classrooms', currentSession.token),
        request<unknown>('/school/settings', currentSession.token),
      ]);
      const freshParticipants = unwrapArray<Participant>(participantResult, 'participants')
        .map((item) => ({ ...item, id: String(item.id) }));
      setParticipants(freshParticipants);
      const write = db.transaction('participants', 'readwrite');
      await write.store.clear();
      for (const participant of freshParticipants) await write.store.put(participant);
      await write.done;
      if (classroomResult && typeof classroomResult === 'object') {
        setClassrooms(unwrapArray<Classroom>(classroomResult, 'classrooms'));
      }
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
      setOfflineMode(false);
      setError('');
    } catch (reason) {
      setOfflineMode(true);
      if (!cached.length) {
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

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await request<{
        access_token: string;
        school: SchoolInfo;
        user: Partial<UserInfo> & { id: string | number; display_name: string; role_name: string };
      }>('/school/auth/login', undefined, {
        method: 'POST',
        body: loginForm,
      });
      if (!result.access_token || !result.school || !result.user) {
        throw new Error('Respons login tidak memuat sesi sekolah yang valid.');
      }
      const current = await request<{ user: UserInfo; school: SchoolInfo }>(
        '/school/auth/me',
        result.access_token,
      );
      const nextSession: SchoolSession = {
        token: result.access_token,
        school: current.school,
        user: { ...result.user, ...current.user, permissions: current.user.permissions },
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
    if (deviceStorageKey) localStorage.removeItem(deviceStorageKey);
    setSession(null);
    setParticipants([]);
    setPage('dashboard');
    setDeviceKey('');
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
    if (!session || !deviceKey) throw new Error('Atur API Key perangkat untuk sinkronisasi.');
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
          '/school/attendance/sync-batch',
          undefined,
          { method: 'POST', headers: { 'x-device-key': deviceKey }, body: { records } },
        );
      },
    });
  }

  async function syncPending() {
    const result = await syncManager().syncPending();
    await refreshPendingCount();
    if (result.rejected_ids.length) {
      setMessage(`${result.accepted_ids.length} scan tersinkron; ${result.rejected_ids.length} tetap pending untuk diperiksa.`, true);
    } else if (result.accepted_ids.length) {
      setMessage(`${result.accepted_ids.length} scan berhasil disinkronkan.`);
    }
    return result;
  }

  async function handleScan(rawValue: string) {
    if (!session) return;
    const value = rawValue.trim();
    if (!value) return;
    const now = Date.now();
    const previous = lastScanAtRef.current.get(value) ?? 0;
    if (now - previous < 3000) return;
    lastScanAtRef.current.set(value, now);
    const participant = participants.find((item) =>
      (item.qr_code === value || item.participant_code === value) &&
      (item.is_active == null || item.is_active === true || Number(item.is_active) === 1));
    if (!participant) {
      setMessage('QR/barcode tidak ditemukan di master peserta lokal.', true);
      return;
    }
    try {
      const db = await database(session.school.id);
      const allScans = await db.getAll('queue');
      const initialCalculation = calculateAttendance({
        eventType: 'check_in',
        clientTimestamp: new Date().toISOString(),
        participantId: participant.id,
        settings,
      }) as ScanResult;
      const hasCheckIn = allScans.some((record) =>
        record.id_peserta === participant.id &&
        record.attendance_date === initialCalculation.date &&
        record.jenis_absen === 'check_in',
      );
      const eventType = hasCheckIn ? 'check_out' : 'check_in';
      const duplicate = allScans.some((record) =>
        record.id_peserta === participant.id &&
        record.attendance_date === initialCalculation.date &&
        record.jenis_absen === eventType,
      );
      if (duplicate) throw new Error('Scan jenis ini sudah tercatat di perangkat untuk hari ini.');

      const calculation = eventType === 'check_in'
        ? initialCalculation
        : calculateAttendance({
          eventType,
          clientTimestamp: new Date().toISOString(),
          participantId: participant.id,
          settings,
        }) as ScanResult;
      if (calculation.reason) {
        throw new Error(calculation.reason === 'checkout_too_early'
          ? 'Waktu pulang belum dimulai.'
          : 'Hari ini bukan hari operasional sekolah.');
      }
      const scan = createQueuedScan({
        sekolah_id: String(session.school.id),
        id_peserta: participant.id,
        id_perangkat: null,
        jenis_absen: eventType,
        calculation,
      }) as QueuedScan;
      await syncManager().enqueue(scan);
      setLastScan(`${participant.full_name} · ${calculation.status}${calculation.lateMinutes ? ` ${calculation.lateMinutes} menit` : ''}`);
      await refreshPendingCount();
      if (online && deviceKey) await syncPending();
      else setMessage(`${participant.full_name} masuk antrean offline.`);
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : 'Scan gagal diproses.', true);
    }
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
    try {
      const fastScan = preferences.scanSpeed === 'fast';
      const reader = new BrowserMultiFormatReader(undefined, {
        delayBetweenScanAttempts: fastScan ? 100 : 350,
        delayBetweenScanSuccess: fastScan ? 250 : 500,
      });
      const controls = await reader.decodeFromConstraints(
        {
          audio: false,
          video: {
            facingMode: { ideal: preferences.cameraFacing },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
        },
        videoRef.current,
        (result) => {
          if (result) void handleScan(result.getText());
        },
      );
      controlsRef.current = controls;
      setCameraActive(true);
      setError('');
    } catch (reason) {
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

  async function loadReport(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (!session) return;
    const query = new URLSearchParams({ from: reportFrom, to: reportTo });
    if (reportStatus) query.set('status', reportStatus);
    if (reportClassroom) query.set('classroom_id', reportClassroom);
    setBusy(true);
    try {
      const result = await request<unknown>(`/school/attendance/report?${query}`, session.token);
      setReportRows(unwrapArray<ReportRow>(result, 'rows'));
      setError('');
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : 'Rekap tidak dapat dimuat.', true);
    } finally {
      setBusy(false);
    }
  }

  async function createParticipant(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session) return;
    setBusy(true);
    try {
      await request('/school/participants', session.token, { method: 'POST', body: participantForm });
      setParticipantForm({ participant_code: '', full_name: '', classroom_id: '', qr_code: '' });
      await loadSchoolData(session);
      setMessage('Peserta berhasil ditambahkan.');
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : 'Peserta gagal ditambahkan.', true);
    } finally {
      setBusy(false);
    }
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
    if (!session || !window.confirm(`Hapus kelas ${classroom.name}?`)) return;
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
      const { default: ExcelJS } = await import('exceljs');
      const workbook = new ExcelJS.Workbook();
      const participantSheet = workbook.addWorksheet('Peserta');
      participantSheet.columns = [
        { header: 'Kode Peserta', key: 'participant_code', width: 22 },
        { header: 'Nama Lengkap', key: 'full_name', width: 32 },
        { header: 'ID Kelas', key: 'classroom_id', width: 16 },
        { header: 'QR / Barcode', key: 'qr_code', width: 28 },
        { header: 'No WA Wali', key: 'guardian_phone', width: 20 },
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
    if (!session) return;
    setBusy(true);
    setParticipantImportResult(null);
    try {
      if (!file.name.toLowerCase().endsWith('.xlsx') || file.size > 5 * 1024 * 1024) {
        throw new Error('Pilih file .xlsx dengan ukuran maksimal 5 MB.');
      }
      const { default: ExcelJS } = await import('exceljs');
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
      const classroomColumn = findColumn('id kelas', 'classroom_id');
      const qrColumn = findColumn('qr / barcode', 'qr_code');
      const phoneColumn = findColumn('no wa wali', 'guardian_phone');
      if (!codeColumn || !nameColumn || !classroomColumn) {
        throw new Error('Kolom wajib: Kode Peserta, Nama Lengkap, dan ID Kelas.');
      }
      const rows: Array<Record<string, string>> = [];
      for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
        const row = sheet.getRow(rowNumber);
        const value = (column?: number) => column ? row.getCell(column).text.trim() : '';
        const participant = {
          participant_code: value(codeColumn),
          full_name: value(nameColumn),
          classroom_id: value(classroomColumn),
          qr_code: value(qrColumn),
          guardian_phone: value(phoneColumn),
          source_row: String(rowNumber),
        };
        if (![participant.participant_code, participant.full_name, participant.classroom_id,
          participant.qr_code, participant.guardian_phone].some(Boolean)) continue;
        rows.push(participant);
        if (rows.length > 500) throw new Error('Impor dibatasi maksimal 500 peserta per file.');
      }
      if (!rows.length) throw new Error('File tidak berisi baris peserta.');

      const result = await request<ParticipantImportResult>('/school/participants/import', session.token, {
        method: 'POST',
        body: { participants: rows },
      });
      setParticipantImportResult(result);
      await loadSchoolData(session);
      setMessage(`Impor selesai: ${result.imported} berhasil, ${result.skipped} dilewati.`);
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : 'Impor peserta gagal.', true);
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
    if (!session || !window.confirm(`Nonaktifkan peserta ${participant.full_name}?`)) return;
    try {
      await request(`/school/participants/${participant.id}`, session.token, { method: 'DELETE' });
      await loadSchoolData(session);
      setMessage('Peserta dinonaktifkan.');
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : 'Peserta gagal dinonaktifkan.', true);
    }
  }

  async function printSelectedQrs() {
    const selected = participants.filter((participant) => selectedParticipantIds.has(participant.id));
    if (!selected.length) return;
    try {
      const images = await Promise.all(selected.map(async (participant) => ({
        ...participant,
        image: await QRCode.toDataURL(participant.qr_code, { width: 280, margin: 2 }),
      })));
      const printWindow = window.open('', '_blank', 'noopener,noreferrer');
      if (!printWindow) throw new Error('Izinkan pop-up browser untuk mencetak kartu QR.');
      printWindow.document.write(`<!doctype html><html lang="id"><head><meta charset="utf-8"><title>Kartu QR Sekolah</title><style>
        @page{size:A4 portrait;margin:8mm}*{box-sizing:border-box}body{font-family:Arial,sans-serif;margin:0;color:#111}
        main{display:grid;grid-template-columns:repeat(4,1fr);gap:5mm}.item{display:grid;justify-items:center;gap:2mm;text-align:center;break-inside:avoid;padding:1mm}
        img{width:32mm;height:32mm}.name{font-size:9pt;font-weight:bold;overflow-wrap:anywhere}
      </style></head><body><main>${images.map((item) => `<article class="item"><img src="${item.image}" alt=""><div class="name">${item.full_name.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char)}</div></article>`).join('')}</main></body></html>`);
      printWindow.document.close();
      printWindow.focus();
      printWindow.print();
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : 'QR gagal disiapkan untuk cetak.', true);
    }
  }

  async function saveRole(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session) return;
    try {
      const permissionsList = roleForm.permissions.split(',').map((item) => item.trim()).filter(Boolean);
      const result = await request<unknown>('/school/roles', session.token, {
        method: 'POST',
        body: { role_key: roleForm.role_key, role_name: roleForm.role_name, permissions: permissionsList },
      });
      setRoles((current) => [...current, ((result as { role?: Record<string, unknown> }).role ?? result) as Record<string, unknown>]);
      setRoleForm({ role_key: '', role_name: '', permissions: '' });
      setMessage('Role baru berhasil dibuat.');
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : 'Role gagal dibuat.', true);
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

  async function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session) return;
    try {
      const result = await request<unknown>('/school/settings', session.token, {
        method: 'PUT',
        body: {
          ...operationalForm,
          ...(scannerPinForm ? { scanner_pin: scannerPinForm } : {}),
        },
      });
      const nextSettings = {
        ...operationalForm,
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

  function requestScannerMenu(target: Page = 'dashboard') {
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
      setPage(scannerMenuTarget);
      setError('');
      setNotice('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'PIN scanner tidak benar.');
    } finally {
      setScannerUnlockBusy(false);
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

  async function clearSchoolWhatsappSettings() {
    if (!session || !window.confirm('Hapus konfigurasi WhatsApp gateway sekolah ini?')) return;
    setWhatsappBusy(true);
    setError('');
    setNotice('');
    try {
      await request('/school/settings/whatsapp-gateway', session.token, { method: 'DELETE' });
      setWhatsappSettings({
        endpoint_url: '', is_enabled: false, is_configured: false, token_hint: '',
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

  async function createDevice(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session) return;
    try {
      const result = await request<{ api_key: string; device?: Device }>(
        '/school/devices',
        session.token,
        { method: 'POST', body: { device_name: deviceName } },
      );
      if (!result.api_key) throw new Error('Server tidak mengembalikan API Key perangkat.');
      localStorage.setItem(deviceStorageKey, result.api_key);
      setDeviceKey(result.api_key);
      if (result.device) setDevices((current) => [...current, result.device!]);
      setMessage('Perangkat terdaftar. Simpan API Key ini; key hanya ditampilkan saat dibuat.');
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : 'Perangkat gagal didaftarkan.', true);
    }
  }

  async function loadDevices() {
    if (!session) return;
    try {
      const result = await request<unknown>('/school/devices', session.token);
      setDevices(unwrapArray<Device>(result, 'devices'));
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : 'Daftar perangkat gagal dimuat.', true);
    }
  }

  async function revokeDevice(device: Device) {
    if (!session || !window.confirm(`Cabut akses perangkat ${device.device_name}?`)) return;
    try {
      await request(`/school/devices/${device.id}/revoke`, session.token, { method: 'POST' });
      await loadDevices();
      setMessage('Akses perangkat dicabut.');
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : 'Akses perangkat gagal dicabut.', true);
    }
  }

  useEffect(() => {
    if (!session || !['roles', 'devices'].includes(page)) return;
    if (page === 'roles') {
      void request<unknown>('/school/roles', session.token)
        .then((result) => setRoles(unwrapArray(result, 'roles')))
        .catch((reason: unknown) => setMessage(reason instanceof Error ? reason.message : 'Role gagal dimuat.', true));
      void request<unknown>('/school/users', session.token)
        .then((result) => setUsers(unwrapArray(result, 'users')))
        .catch((reason: unknown) => setMessage(reason instanceof Error ? reason.message : 'Akun sekolah gagal dimuat.', true));
    } else {
      void loadDevices();
    }
  }, [page, session?.token]);

  const navItems = useMemo(() => {
    const items: { id: Page; label: string; permission?: Permission }[] = [
      { id: 'scanner', label: 'Scanner', permission: 'scanner.use' },
      { id: 'dashboard', label: 'Ringkasan', permission: 'dashboard.read' },
      { id: 'reports', label: 'Rekap', permission: 'attendance.read' },
      { id: 'participants', label: 'Peserta', permission: 'participants.read' },
      { id: 'settings', label: 'Pengaturan', permission: 'settings.operational.manage' },
      { id: 'roles', label: 'Akun & Role', permission: 'school.users.manage' },
      { id: 'devices', label: 'Perangkat', permission: 'scanner.use' },
      { id: 'downloads', label: 'Unduh APK' },
      ...(can('school.users.manage') ? [{ id: 'billing' as const, label: 'Langganan' }] : []),
    ];
    return items.filter((item) => !item.permission || can(item.permission));
  }, [session?.user.permissions]);

  if (!session) {
    return (
      <main className="login-shell">
        {loginView === 'login' && <form className="login-card" onSubmit={(event) => void login(event)}>
          <div className="brand-mark">RH</div>
          <p className="eyebrow">PORTAL SEKOLAH</p>
          <h1>Masuk ke {applicationName}</h1>
          {error && <div className="alert error">{error}</div>}
          {notice && <div className="alert success">{notice}</div>}
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
          {error && <div className="alert error">{error}</div>}
          {notice && <div className="alert success">{notice}</div>}
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
          {error && <div className="alert error">{error}</div>}
          {notice && <div className="alert success">{notice}</div>}
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
          {error && <div className="alert error">{error}</div>}
          {notice && <div className="alert success">{notice}</div>}
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
          {error && <div className="alert error">{error}</div>}
          {notice && <div className="alert success">{notice}</div>}
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
      </main>
    );
  }

  return (
    <div className={page === 'scanner' ? 'portal-shell scanner-active' : 'portal-shell'}>
      <header className="topbar">
        <div className="brand"><div className="brand-mark">RH</div><div><strong>{session.school.name}</strong><small>Kode sekolah · {session.school.school_code}</small></div></div>
        <div className="top-actions">
          <span className={`connection ${online ? 'online' : 'offline'}`}><i />{online ? 'Online' : 'Offline'}</span>
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
          {offlineMode && <div className="alert warning">Mode offline: scanner memakai master peserta lokal. Perubahan data dan login baru membutuhkan jaringan.</div>}
          {error && <div className="alert error">{error}<button onClick={() => setError('')} aria-label="Tutup">×</button></div>}
          {notice && <div className="alert success">{notice}<button onClick={() => setNotice('')} aria-label="Tutup">×</button></div>}

          {page === 'dashboard' && (
            <section>
              <p className="eyebrow">DASHBOARD SEKOLAH</p>
              <h1>Ringkasan absensi</h1>
              <p className="muted">Data operasional untuk {session.school.name}.</p>
              <div className="metric-grid">
                <article className="metric-card"><span>Peserta aktif lokal</span><strong>{participants.length}</strong></article>
                <article className="metric-card"><span>Antrean belum terkirim</span><strong>{pendingCount}</strong></article>
                <article className="metric-card"><span>Status koneksi</span><strong className={online ? 'text-green' : 'text-red'}>{online ? 'Online' : 'Offline'}</strong></article>
              </div>
              <div className="panel quick-panel"><h2>Akses cepat</h2><p className="muted">Buka scanner untuk absensi atau rekap untuk memantau kehadiran.</p><div className="heading-actions">{can('scanner.use') && <button className="button primary" onClick={() => setPage('scanner')}>Buka Scanner</button>}{can('attendance.read') && <button className="button secondary" onClick={() => { setPage('reports'); void loadReport(); }}>Lihat Rekap</button>}</div></div>
            </section>
          )}

          {page === 'scanner' && (
            <section className="scanner-page">
              <header className="scan-screen-header">
                <div className="scan-header-top">
                  <div className="scan-brand">
                    <div className="brand-mark">RH</div>
                    <div className="scan-brand-copy">
                      <strong>{applicationName}</strong>
                      <div className="scan-date-time">
                        <span className="scan-date">{scanClock.toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</span>
                        <span className="scan-clock">{scanClock.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
                      </div>
                    </div>
                  </div>
                  <div className="scan-header-actions">
                    <div className={`connection-chip ${online ? 'is-online' : 'is-offline'}`}><span />{online ? 'Online' : 'Offline'}</div>
                    <select className="scan-camera-select" aria-label="Pilih kamera" value={scannerPreferences.cameraFacing} onChange={(event) => void updateScannerPreferences({ ...scannerPreferences, cameraFacing: event.target.value === 'environment' ? 'environment' : 'user' })}><option value="user">Depan</option><option value="environment">Belakang</option></select>
                    <button className="scan-menu-trigger" type="button" aria-label="Buka menu dengan PIN" onClick={() => requestScannerMenu('dashboard')}><span className="hamburger-icon" aria-hidden="true"><i /><i /><i /></span></button>
                  </div>
                </div>
                {lastScan && <div className="scan-welcome" aria-live="polite"><span className="scan-welcome-track">{lastScan}</span></div>}
                {!lastScan && <div className="scan-welcome"><span className="scan-welcome-track">Pindai kartu atau barcode peserta saat melaksanakan absensi</span></div>}
              </header>

              {pendingCount > 0 && <div className="scan-controls-row"><div className="scan-queue-summary"><span className="queue-mini-count">{pendingCount}</span><span>pending · sinkron otomatis</span></div></div>}

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
                <div className="scan-history-heading"><div><h2>Log kehadiran terbaru</h2><p>Riwayat scan yang tersimpan di perangkat ini</p></div>{pendingCount > 0 && <span className="history-pending">{pendingCount} pending</span>}</div>
                <LocalQueueList schoolId={session.school.id} />
              </section>

              {!cameraActive && <button className="button primary wide scan-resume-button" onClick={() => void startCamera()}>{scannerPreferences.cameraFacing === 'user' ? 'Buka kamera depan' : 'Buka kamera belakang'}</button>}
            </section>
          )}

          {page === 'reports' && (
            <section className="report-page">
              <div className="page-heading"><div><p className="eyebrow">LAPORAN</p><h1>Rekap absensi</h1><p className="muted">Filter tanggal, kelas, dan status absensi.</p></div></div>
              <form className="filter-form panel no-print" onSubmit={(event) => void loadReport(event)}>
                <label>Dari tanggal<input type="date" required value={reportFrom} onChange={(event) => setReportFrom(event.target.value)} /></label>
                <label>Sampai tanggal<input type="date" required value={reportTo} onChange={(event) => setReportTo(event.target.value)} /></label>
                <label>Kelas<select value={reportClassroom} onChange={(event) => setReportClassroom(event.target.value)}><option value="">Semua kelas</option>{classrooms.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
                <label>Status<select value={reportStatus} onChange={(event) => setReportStatus(event.target.value)}><option value="">Semua status</option><option value="hadir">Hadir</option><option value="terlambat">Terlambat</option><option value="pulang">Pulang</option><option value="belum_hadir">Tidak hadir</option></select></label>
                <div className="heading-actions"><button className="button primary" disabled={busy}>{busy ? 'Memuat…' : 'Tampilkan'}</button><button type="button" className="button secondary" onClick={() => downloadReport(reportRows)}>Ekspor CSV</button><button type="button" className="button secondary" onClick={() => window.print()}>Cetak / PDF</button></div>
              </form>
              <div className="panel report-print-area">
                <div className="print-heading"><h2>{session.school.name} · Rekap Absensi</h2><p>{reportFrom} sampai {reportTo}</p></div>
                <div className="table-scroll"><table className="report-table"><thead><tr><th>Tanggal</th><th>Nama</th><th>Kelas</th><th>Masuk</th><th>Keluar</th><th>Status</th><th>Menit telat</th></tr></thead><tbody>
                  {reportRows.map((row, index) => <tr key={`${row.attendance_date}-${row.participant_code}-${index}`}><td>{row.attendance_date}</td><td>{row.participant_name}</td><td>{row.classroom_name}</td><td>{toLocalTime(row.check_in_at)}</td><td>{toLocalTime(row.check_out_at)}</td><td>{row.attendance_status ?? '—'}</td><td>{row.late_minutes ?? row.menit_terlambat ?? 0}</td></tr>)}
                  {!reportRows.length && <tr><td colSpan={7} className="empty">Belum ada data untuk filter ini.</td></tr>}
                </tbody></table></div>
              </div>
            </section>
          )}

          {page === 'participants' && (
            <section>
              <div className="page-heading"><div><p className="eyebrow">DATA SEKOLAH</p><h1>Master peserta</h1><p className="muted">Master lokal digunakan untuk validasi scan saat offline.</p></div></div>
              {can('participants.manage') && <form className="panel form-grid" onSubmit={(event) => void createParticipant(event)}>
                <label>Kode peserta<input required value={participantForm.participant_code} onChange={(event) => setParticipantForm((current) => ({ ...current, participant_code: event.target.value }))} /></label>
                <label>Nama lengkap<input required value={participantForm.full_name} onChange={(event) => setParticipantForm((current) => ({ ...current, full_name: event.target.value }))} /></label>
                <label>Kelas<select required value={participantForm.classroom_id} onChange={(event) => setParticipantForm((current) => ({ ...current, classroom_id: event.target.value }))}><option value="">Pilih kelas</option>{classrooms.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
                <label>QR / Barcode<input required value={participantForm.qr_code} onChange={(event) => setParticipantForm((current) => ({ ...current, qr_code: event.target.value }))} /></label>
                <button className="button primary" disabled={busy}>Tambah peserta</button>
              </form>}
              {can('participants.manage') && <div className="panel classroom-manager">
                <div className="section-title"><div><h2>Nama kelas / unit</h2><p className="muted">Kelola nama kelas yang digunakan pada master peserta.</p></div></div>
                <form className="classroom-form" onSubmit={(event) => void saveClassroom(event)}>
                  <label>Nama kelas<input required maxLength={100} value={classroomForm.name} onChange={(event) => setClassroomForm((current) => ({ ...current, name: event.target.value }))} placeholder="Contoh: Kelas 7A" /></label>
                  <button className="button primary" disabled={busy}>{classroomForm.id ? 'Simpan nama' : 'Tambah kelas'}</button>
                  {classroomForm.id && <button type="button" className="button secondary" onClick={() => setClassroomForm({ id: '', name: '' })}>Batal</button>}
                </form>
                <div className="classroom-list">{classrooms.map((classroom) => <div className="classroom-row" key={classroom.id}><div><strong>{classroom.name}</strong><small>{classroom.unit_name ?? 'Umum'}</small></div><div className="heading-actions"><button type="button" className="button secondary small" onClick={() => setClassroomForm({ id: classroom.id, name: classroom.name })}>Edit</button><button type="button" className="button danger small" onClick={() => void deleteClassroom(classroom)}>Hapus</button></div></div>)}</div>
              </div>}
              {can('participants.manage') && <div className="panel participant-import">
                <div><h2>Impor dari Excel</h2><p className="muted">Gunakan template agar kolom dan ID kelas sesuai. Maksimal 500 baris per impor.</p></div>
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
                <div className="section-title"><div><h2>{participants.length} peserta lokal</h2><p className="muted">Data di-cache per sekolah pada perangkat ini.</p></div><div className="heading-actions">{can('participants.qr.print') && <button className="button secondary" onClick={() => void printSelectedQrs()}>Cetak QR terpilih</button>}<button className="button secondary" onClick={() => session && void loadSchoolData(session)}>Sinkronkan master</button></div></div>
                <div className="table-scroll"><table><thead><tr><th><input type="checkbox" aria-label="Pilih semua peserta" checked={participants.length > 0 && selectedParticipantIds.size === participants.length} onChange={(event) => setSelectedParticipantIds(event.target.checked ? new Set(participants.map((item) => item.id)) : new Set())} /></th><th>Kode</th><th>Nama</th><th>Kelas</th><th>QR</th><th className="no-print">Aksi</th></tr></thead><tbody>
                  {participants.map((participant) => <tr key={participant.id}><td><input type="checkbox" aria-label={`Pilih ${participant.full_name}`} checked={selectedParticipantIds.has(participant.id)} onChange={(event) => setSelectedParticipantIds((current) => { const next = new Set(current); if (event.target.checked) next.add(participant.id); else next.delete(participant.id); return next; })} /></td><td>{participant.participant_code}</td><td>{participant.full_name}</td><td>{participant.classroom_name ?? classrooms.find((item) => item.id === participant.classroom_id)?.name ?? '—'}</td><td><code>{participant.qr_code}</code></td><td className="no-print">{can('participants.manage') && <div className="participant-actions"><button className="button secondary small" onClick={() => openParticipantSchedule(participant.id)}>Atur jam</button><button className="button danger small" onClick={() => void removeParticipant(participant)}>Nonaktifkan</button></div>}</td></tr>)}
                  {!participants.length && <tr><td colSpan={6} className="empty">Master peserta belum tersedia. Hubungkan jaringan untuk mengambil data sekolah.</td></tr>}
                </tbody></table></div>
              </div>
            </section>
          )}

          {page === 'settings' && (
            <section>
              <div className="page-heading"><div><p className="eyebrow">OPERASIONAL</p><h1>Pengaturan scanner & operasional</h1><p className="muted">Atur kamera perangkat, kecepatan scan, dan aturan operasional sekolah.</p></div></div>
              <section className="panel scanner-preference-panel">
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
              </section>
              <form className="panel settings-form" onSubmit={(event) => void saveSettings(event)}>
                <div className="form-grid">
                  <label>Zona waktu<input value={operationalForm.timezone} onChange={(event) => setOperationalForm((current) => ({ ...current, timezone: event.target.value }))} /></label>
                  <label>Batas masuk<input type="time" required value={operationalForm.check_in_deadline.slice(0, 5)} onChange={(event) => setOperationalForm((current) => ({ ...current, check_in_deadline: `${event.target.value}:00` }))} /></label>
                  <label>Toleransi telat (menit)<input type="number" min={0} max={180} value={operationalForm.lateness_tolerance_minutes} onChange={(event) => setOperationalForm((current) => ({ ...current, lateness_tolerance_minutes: Number(event.target.value) }))} /></label>
                  <label>Mulai pulang<input type="time" required value={operationalForm.check_out_start.slice(0, 5)} onChange={(event) => setOperationalForm((current) => ({ ...current, check_out_start: `${event.target.value}:00` }))} /></label>
                  <label>PIN scanner (4–6 angka)
                    <input type="password" inputMode="numeric" pattern="\d{4,6}" minLength={4} maxLength={6} value={scannerPinForm} onChange={(event) => setScannerPinForm(event.target.value.replace(/\D/g, '').slice(0, 6))} placeholder={operationalForm.scanner_pin_configured ? 'PIN tersimpan — kosongkan untuk tidak mengubah' : 'Belum ada PIN khusus; awal 1234'} />
                  </label>
                </div>
                <h2>Jadwal mingguan</h2>
                <div className="schedule-list">{weekDays.map((name, weekday) => {
                  const schedule = operationalForm.weekly_schedules.find((item) => Number(item.weekday) === weekday);
                  return <label className="schedule-row" key={weekday}><span>{name}</span><input type="checkbox" checked={schedule ? Boolean(Number(schedule.is_working_day)) : weekday > 0 && weekday < 6} onChange={(event) => setOperationalForm((current) => {
                    const existing = current.weekly_schedules.filter((item) => Number(item.weekday) !== weekday);
                    return { ...current, weekly_schedules: [...existing, { weekday, is_working_day: event.target.checked, check_in_deadline: current.check_in_deadline, lateness_tolerance_minutes: current.lateness_tolerance_minutes, check_out_start: current.check_out_start }].sort((a, b) => a.weekday - b.weekday) };
                  })} /><span>Hari kerja</span></label>;
                })}</div>
                <div className="heading-actions"><button className="button primary">Simpan pengaturan</button></div>
              </form>
              <form className="panel holiday-form" onSubmit={(event) => void addHoliday(event)}>
                <div><h2>Hari libur khusus</h2><p className="muted">Tanggal libur sekolah di luar jadwal mingguan.</p></div>
                <div className="form-grid"><label>Tanggal<input type="date" required value={holidayForm.date} onChange={(event) => setHolidayForm((current) => ({ ...current, date: event.target.value }))} /></label><label>Nama libur<input required value={holidayForm.name} onChange={(event) => setHolidayForm((current) => ({ ...current, name: event.target.value }))} /></label><button className="button secondary">Tambah libur</button></div>
                <ul className="holiday-list">{operationalForm.holidays.map((holiday) => <li key={`${holiday.date}-${holiday.name}`}><span>{holiday.date} · {holiday.name}</span><button type="button" className="text-button" onClick={() => setOperationalForm((current) => ({ ...current, holidays: current.holidays.filter((item) => item !== holiday) }))}>Hapus</button></li>)}</ul>
              </form>
              {can('participants.manage') && <section className="panel participant-schedule-settings">
                <div><h2>Batas masuk khusus peserta</h2><p className="muted">Pilih peserta dan atur batas waktu masuk untuk hari tertentu. Hari kosong memakai jadwal sekolah.</p></div>
                <label>Pilih peserta
                  <select value={scheduleParticipantId} onChange={(event) => openParticipantSchedule(event.target.value)}>
                    <option value="">Pilih peserta</option>
                    {participants.map((participant) => <option key={participant.id} value={participant.id}>{participant.full_name} — {participant.participant_code}</option>)}
                  </select>
                </label>
                {scheduleParticipantId && <>
                  <div className="participant-schedule-grid">{weekDays.map((name, weekday) => <label key={weekday}>{name}
                    <input type="time" value={scheduleOverrides[weekday] ?? ''} onChange={(event) => setScheduleOverrides((current) => ({ ...current, [weekday]: event.target.value }))} />
                  </label>)}</div>
                  <div className="heading-actions"><button type="button" className="button primary" disabled={busy} onClick={() => void saveParticipantSchedule()}>{busy ? 'Menyimpan…' : 'Simpan jadwal peserta'}</button><button type="button" className="button secondary" onClick={() => { setScheduleParticipantId(''); setScheduleOverrides({}); }}>Batal</button></div>
                </>}
              </section>}
              {can('settings.operational.manage') && <section className="panel school-whatsapp-panel">
                <div>
                  <h2>Gateway WhatsApp sekolah</h2>
                  <p className="muted">Konfigurasi ini khusus untuk tenant sekolah ini. Token dienkripsi di database dan tidak ditampilkan kembali. Simpan perubahan sebelum menguji gateway.</p>
                  <span className={`gateway-status ${whatsappSettings.is_enabled && whatsappSettings.is_configured ? 'ready' : ''}`}>
                    {whatsappSettings.is_enabled && whatsappSettings.is_configured ? '● Aktif' : '○ Belum aktif'}
                  </span>
                </div>
                <form className="school-whatsapp-form" onSubmit={(event) => void saveSchoolWhatsappSettings(event)}>
                  <label>URL HTTPS gateway<input type="url" required placeholder="https://gateway.example/api/send" value={whatsappSettings.endpoint_url} onChange={(event) => setWhatsappSettings((current) => ({ ...current, endpoint_url: event.target.value }))} /></label>
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
                </form>
              </section>}
            </section>
          )}

          {page === 'roles' && (
            <section>
              <div className="page-heading"><div><p className="eyebrow">AKSES SEKOLAH</p><h1>Akun & role dinamis</h1><p className="muted">Izin melekat pada role sekolah dan tidak berlaku lintas tenant.</p></div></div>
              {can('school.roles.manage') && <form className="panel form-grid" onSubmit={(event) => void saveRole(event)}>
                <label>Kunci role<input required pattern="[a-z0-9-]+" value={roleForm.role_key} onChange={(event) => setRoleForm((current) => ({ ...current, role_key: event.target.value.toLowerCase() }))} placeholder="wakasek-kurikulum" /></label>
                <label>Nama role<input required value={roleForm.role_name} onChange={(event) => setRoleForm((current) => ({ ...current, role_name: event.target.value }))} placeholder="Wakasek Kurikulum" /></label>
                <label className="wide">Permission (pisahkan koma)<input required value={roleForm.permissions} onChange={(event) => setRoleForm((current) => ({ ...current, permissions: event.target.value }))} placeholder="dashboard.read,attendance.read,attendance.export" /></label>
                <button className="button primary">Tambah role</button>
              </form>}
              <div className="panel"><h2>Daftar role</h2><div className="table-scroll"><table><thead><tr><th>Nama role</th><th>Kunci</th><th>Permission</th></tr></thead><tbody>{roles.map((role, index) => <tr key={String(role.id ?? role.role_key ?? index)}><td>{String(role.role_name ?? role.name ?? '—')}</td><td><code>{String(role.role_key ?? '')}</code></td><td>{Array.isArray(role.permissions) ? role.permissions.join(', ') : String(role.permissions ?? '')}</td></tr>)}{!roles.length && <tr><td colSpan={3} className="empty">Belum ada role yang dimuat.</td></tr>}</tbody></table></div></div>
              {can('school.users.manage') && <form className="panel form-grid" onSubmit={(event) => void saveUser(event)}>
                <h2 className="wide">Buat akun sekolah</h2>
                <label>Nama tampilan<input required value={userForm.display_name} onChange={(event) => setUserForm((current) => ({ ...current, display_name: event.target.value }))} /></label>
                <label>Username<input required value={userForm.username} onChange={(event) => setUserForm((current) => ({ ...current, username: event.target.value }))} /></label>
                <label>Password sementara<input type="password" minLength={10} required value={userForm.password} onChange={(event) => setUserForm((current) => ({ ...current, password: event.target.value }))} /></label>
                <label>Role<select required value={userForm.role_id} onChange={(event) => setUserForm((current) => ({ ...current, role_id: event.target.value }))}><option value="">Pilih role</option>{roles.map((role, index) => <option key={String(role.id ?? index)} value={String(role.id)}>{String(role.role_name ?? role.name)}</option>)}</select></label>
                <button className="button primary">Buat akun</button>
                <div className="table-scroll wide"><table><thead><tr><th>Username</th><th>Nama</th><th>Role</th><th>Status</th></tr></thead><tbody>{users.map((user, index) => <tr key={String(user.id ?? index)}><td>{String(user.username ?? '')}</td><td>{String(user.display_name ?? '')}</td><td>{String(user.role_name ?? '')}</td><td>{Number(user.is_active) ? 'Aktif' : 'Nonaktif'}</td></tr>)}</tbody></table></div>
              </form>}
            </section>
          )}

          {page === 'devices' && (
            <section>
              <div className="page-heading"><div><p className="eyebrow">PERANGKAT TERDAFTAR</p><h1>Scanner sekolah</h1><p className="muted">Setiap key terikat ke sekolah ini dan dapat dicabut.</p></div></div>
              {can('scanner.use') && <form className="panel form-grid" onSubmit={(event) => void createDevice(event)}><label>Nama perangkat<input required value={deviceName} onChange={(event) => setDeviceName(event.target.value)} /></label><button className="button primary">Daftarkan perangkat</button><button type="button" className="button secondary" onClick={() => void loadDevices()}>Muat daftar</button></form>}
              {deviceKey && <div className="alert success key-reveal">API Key aktif untuk perangkat ini tersimpan pada sesi browser. Jangan bagikan key dan cabut bila perangkat hilang.</div>}
              <div className="panel"><div className="table-scroll"><table><thead><tr><th>Perangkat</th><th>Status</th><th>Aksi</th></tr></thead><tbody>{devices.map((device) => <tr key={device.id}><td>{device.device_name}</td><td>{Number(device.is_active) ? 'Aktif' : 'Dicabut'}</td><td>{Number(device.is_active) ? <button className="button danger small" onClick={() => void revokeDevice(device)}>Cabut akses</button> : '—'}</td></tr>)}{!devices.length && <tr><td colSpan={3} className="empty">Belum ada perangkat.</td></tr>}</tbody></table></div></div>
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
              {billingData && (
                <>
                  <div className="panel billing-status-panel">
                    <div><small>Status langganan</small><strong>{billingData.subscription.status === 'lifetime' ? 'Lifetime' : billingData.subscription.expired ? 'Kedaluwarsa' : billingData.subscription.status === 'trial' ? 'Uji coba' : 'Aktif'}</strong></div>
                    <div><small>Masa berlaku</small><strong>{billingData.subscription.status === 'lifetime' ? 'Selamanya' : billingData.subscription.expires_at ? new Date(billingData.subscription.expires_at).toLocaleDateString('id-ID') : billingData.subscription.trial_ends_at ? new Date(billingData.subscription.trial_ends_at).toLocaleDateString('id-ID') : 'Belum ditentukan'}</strong></div>
                  </div>
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
      {scannerMenuOpen && <div className="pin-modal-backdrop" role="presentation">
        <form className="pin-modal" onSubmit={(event) => void unlockScannerMenu(event)} role="dialog" aria-modal="true" aria-labelledby="scanner-pin-title">
          <div className="pin-modal-icon" aria-hidden="true">PIN</div>
          <h2 id="scanner-pin-title">Masuk ke menu sekolah</h2>
          <p>Masukkan PIN scanner untuk berpindah halaman.</p>
          <input className="pin-modal-input" type="password" inputMode="numeric" pattern="\d{4,6}" minLength={4} maxLength={6} autoComplete="off" required autoFocus value={scannerMenuPin} onChange={(event) => setScannerMenuPin(event.target.value.replace(/\D/g, '').slice(0, 6))} />
          {error && <div className="pin-modal-error">{error}</div>}
          <div className="pin-modal-actions">
            <button type="button" className="button secondary" onClick={() => { setScannerMenuOpen(false); setScannerMenuPin(''); setError(''); }}>Batal</button>
            <button className="button primary" disabled={scannerUnlockBusy}>{scannerUnlockBusy ? 'Memeriksa…' : 'Buka menu'}</button>
          </div>
        </form>
      </div>}
    </div>
  );
}

function LocalQueueList({ schoolId }: { schoolId: string | number }) {
  const [items, setItems] = useState<QueuedScan[]>([]);
  useEffect(() => {
    let active = true;
    void database(schoolId).then(async (db) => {
      const scans = await db.getAll('queue');
      if (active) setItems(scans.sort((a, b) => b.client_timestamp.localeCompare(a.client_timestamp)).slice(0, 8));
    }).catch((error: unknown) => console.error('Riwayat lokal gagal dimuat.', error));
    return () => { active = false; };
  }, [schoolId]);
  return <div className="table-scroll"><table><thead><tr><th>Waktu perangkat</th><th>Peserta ID</th><th>Jenis</th><th>Status</th><th>Sync</th></tr></thead><tbody>{items.map((item) => <tr key={item.id_unik}><td>{item.client_timestamp}</td><td>{item.id_peserta}</td><td>{item.jenis_absen === 'check_in' ? 'Masuk' : 'Pulang'}</td><td>{item.status_kehadiran}{item.menit_terlambat ? ` · ${item.menit_terlambat} mnt` : ''}</td><td><span className={`tag ${item.status_sync}`}>{item.status_sync}</span></td></tr>)}{!items.length && <tr><td colSpan={5} className="empty">Belum ada scan tersimpan di perangkat.</td></tr>}</tbody></table></div>;
}
