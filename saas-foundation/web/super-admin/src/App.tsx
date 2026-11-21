import { useCallback, useEffect, useState, type FormEvent } from 'react';

const TOKEN_KEY = 'saas_super_admin_token';
const API_BASE = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '');
type SubscriptionStatus = 'trial' | 'aktif' | 'suspend' | 'lifetime';

interface School {
  id: number;
  name: string;
  slug: string;
  school_code: string;
  subscription_status: SubscriptionStatus;
  trial_ends_at: string | null;
  subscription_expires_at: string | null;
  participant_quota: number;
  is_active: boolean | number;
  admin_username: string | null;
  admin_whatsapp_phone: string | null;
}

interface SubscriptionPayment {
  order_id: string;
  school_id: string;
  school_name: string;
  provider: 'xendit' | 'duitku' | 'kasera';
  plan: 'monthly' | 'lifetime';
  amount: number;
  provider_reference: string | null;
  paid_at: string | null;
  created_at: string;
}

interface WhatsappGatewaySettings {
  endpoint_url: string;
  is_enabled: boolean;
  is_configured: boolean;
  token_hint: string;
  last_test_at: string | null;
  last_test_status: 'success' | 'failed' | null;
  last_test_message: string | null;
}

interface SchoolForm {
  name: string;
  slug: string;
  subscription_status: SubscriptionStatus;
  participant_quota: number;
  initial_admin: {
    username: string;
    display_name: string;
    password: string;
  };
}

interface SchoolEditForm {
  name: string;
  subscription_status: SubscriptionStatus;
  subscription_expires_at: string;
  participant_quota: number;
  admin_username: string;
  admin_whatsapp_phone: string;
}

interface ResetCredentials {
  schoolName: string;
  username: string;
  temporaryPassword: string;
}

type PasswordResetMode = 'generate' | 'custom';

interface BillingPrices {
  monthly_price: number;
  lifetime_price: number;
  providers?: { xendit: boolean; duitku: boolean; kasera: boolean };
}

interface PaymentGatewaySettings {
  credential_source: 'database' | 'environment';
  callback_urls: { xendit: string; duitku: string; kasera: string };
  xendit: {
    configured: boolean;
    enabled: boolean;
    secret_key_hint: string;
    callback_token_hint: string;
  };
  duitku: {
    configured: boolean;
    enabled: boolean;
    environment: 'production' | 'sandbox';
    merchant_code_hint: string;
    api_key_hint: string;
  };
  kasera: {
    configured: boolean;
    enabled: boolean;
    api_key_hint: string;
    webhook_secret_hint: string;
  };
}

interface PaymentGatewayForm {
  xendit_enabled: boolean;
  xendit_secret_key: string;
  xendit_callback_token: string;
  duitku_enabled: boolean;
  duitku_environment: 'production' | 'sandbox';
  duitku_merchant_code: string;
  duitku_api_key: string;
  kasera_enabled: boolean;
  kasera_api_key: string;
  kasera_webhook_secret: string;
}

interface PlatformBackupSettings {
  enabled: boolean;
  backup_time: string;
  bot_configured: boolean;
  chat_id_hint: string;
  last_status: 'never' | 'running' | 'success' | 'failed' | 'notification_failed';
  last_run_at: string | null;
  last_error: string | null;
}

interface OtpRateLimitSettings {
  max_requests_per_phone: number;
  window_minutes: number;
}

type LoginView = 'login' | 'forgot-password' | 'reset-password';

const emptyForm: SchoolForm = {
  name: '',
  slug: '',
  subscription_status: 'trial',
  participant_quota: 500,
  initial_admin: { username: '', display_name: '', password: '' },
};

function PasswordEye({ visible }: { visible: boolean }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M2.5 12s3.2-6 9.5-6 9.5 6 9.5 6-3.2 6-9.5 6-9.5-6-9.5-6Z" />
      <circle cx="12" cy="12" r="2.7" />
      {!visible && <path d="m4 4 16 16" />}
    </svg>
  );
}

function phoneNationalDigits(value: string) {
  const digits = value.replace(/\D/g, '');
  const national = digits.startsWith('62') ? digits.slice(2) : digits.replace(/^0+/, '');
  return national.slice(0, 13);
}

async function request<T>(
  path: string,
  token: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
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

function slugify(value: string) {
  return value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function readLogoFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === 'string'
      ? resolve(reader.result)
      : reject(new Error('File logo tidak dapat dibaca.'));
    reader.onerror = () => reject(new Error('File logo tidak dapat dibaca.'));
    reader.readAsDataURL(file);
  });
}

function validAdminPassword(value: string) {
  return value.length >= 8 && new TextEncoder().encode(value).length <= 72 &&
    /[A-Z]/.test(value) && /\d/.test(value) && /[^A-Za-z0-9\s]/.test(value);
}

function utcDateTimeInput(value: string | null) {
  if (!value) return '';
  const date = new Date(/(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    ? value
    : `${value.replace(' ', 'T')}Z`);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 16);
}

export default function App() {
  const [token, setToken] = useState(() => sessionStorage.getItem(TOKEN_KEY) ?? '');
  const [schools, setSchools] = useState<School[]>([]);
  const [subscriptionPayments, setSubscriptionPayments] = useState<SubscriptionPayment[]>([]);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loginView, setLoginView] = useState<LoginView>('login');
  const [showLoginPassword, setShowLoginPassword] = useState(false);
  const [forgotPhone, setForgotPhone] = useState('');
  const [resetChallengeId, setResetChallengeId] = useState('');
  const [resetOtp, setResetOtp] = useState('');
  const [resetPassword, setResetPassword] = useState('');
  const [showResetPassword, setShowResetPassword] = useState(false);
  const [recoveryPhone, setRecoveryPhone] = useState('');
  const [recoveryPhoneInput, setRecoveryPhoneInput] = useState('');
  const [recoveryCurrentPassword, setRecoveryCurrentPassword] = useState('');
  const [recoveryPhoneBusy, setRecoveryPhoneBusy] = useState(false);
  const [form, setForm] = useState<SchoolForm>(emptyForm);
  const [manualCodes, setManualCodes] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [logoDataUrl, setLogoDataUrl] = useState('');
  const [logoAvailable, setLogoAvailable] = useState(false);
  const [logoVersion, setLogoVersion] = useState(0);
  const [gatewaySettings, setGatewaySettings] = useState<WhatsappGatewaySettings>({
    endpoint_url: '',
    is_enabled: false,
    is_configured: false,
    token_hint: '',
    last_test_at: null,
    last_test_status: null,
    last_test_message: null,
  });
  const [gatewayToken, setGatewayToken] = useState('');
  const [gatewayBusy, setGatewayBusy] = useState(false);
  const [gatewayTestPhone, setGatewayTestPhone] = useState('');
  const [gatewayTestBusy, setGatewayTestBusy] = useState(false);
  const [apkDriveUrl, setApkDriveUrl] = useState('');
  const [apkBusy, setApkBusy] = useState(false);
  const [billingPrices, setBillingPrices] = useState<BillingPrices>({
    monthly_price: 50000,
    lifetime_price: 1000000,
    providers: { xendit: false, duitku: false, kasera: false },
  });
  const [billingBusy, setBillingBusy] = useState(false);
  const [paymentGatewaySettings, setPaymentGatewaySettings] = useState<PaymentGatewaySettings | null>(null);
  const [paymentGatewayForm, setPaymentGatewayForm] = useState<PaymentGatewayForm>({
    xendit_enabled: false,
    xendit_secret_key: '',
    xendit_callback_token: '',
    duitku_enabled: false,
    duitku_environment: 'production',
    duitku_merchant_code: '',
    duitku_api_key: '',
    kasera_enabled: false,
    kasera_api_key: '',
    kasera_webhook_secret: '',
  });
  const [paymentGatewayBusy, setPaymentGatewayBusy] = useState(false);
  const [backupSettings, setBackupSettings] = useState<PlatformBackupSettings>({
    enabled: false,
    backup_time: '02:00',
    bot_configured: false,
    chat_id_hint: '',
    last_status: 'never',
    last_run_at: null,
    last_error: null,
  });
  const [backupBotToken, setBackupBotToken] = useState('');
  const [backupChatId, setBackupChatId] = useState('');
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupAction, setBackupAction] = useState<'save' | 'run' | 'download' | null>(null);
  const [otpRateLimit, setOtpRateLimit] = useState<OtpRateLimitSettings>({
    max_requests_per_phone: 10,
    window_minutes: 30,
  });
  const [otpRateLimitLoaded, setOtpRateLimitLoaded] = useState(false);
  const [otpRateLimitBusy, setOtpRateLimitBusy] = useState(false);
  const [applicationName, setApplicationName] = useState('Ruang Hadir');
  const [applicationNameBusy, setApplicationNameBusy] = useState(false);
  const [editingSchool, setEditingSchool] = useState<School | null>(null);
  const [schoolEditForm, setSchoolEditForm] = useState<SchoolEditForm>({
    name: '',
    subscription_status: 'trial',
    subscription_expires_at: '',
    participant_quota: 500,
    admin_username: '',
    admin_whatsapp_phone: '',
  });
  const [deleteTarget, setDeleteTarget] = useState<School | null>(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState('');
  const [resetCredentials, setResetCredentials] = useState<ResetCredentials | null>(null);
  const [passwordResetTarget, setPasswordResetTarget] = useState<School | null>(null);
  const [passwordResetMode, setPasswordResetMode] = useState<PasswordResetMode>('generate');
  const [customAdminPassword, setCustomAdminPassword] = useState('');
  const [showCustomAdminPassword, setShowCustomAdminPassword] = useState(false);

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
    document.title = `Super Admin · ${applicationName}`;
  }, [applicationName]);

  useEffect(() => {
    let active = true;
    let objectUrl = '';
    fetch(`${API_BASE}/branding/logo?v=${logoVersion}`, { cache: 'no-store' })
      .then(async (response) => {
        if (response.status === 404) {
          if (active) setLogoAvailable(false);
          return null;
        }
        if (!response.ok) throw new Error(`Logo platform gagal dimuat (${response.status}).`);
        return response.blob();
      })
      .then((blob) => {
        if (!active || !blob) return;
        setLogoAvailable(true);
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
  }, [logoVersion]);

  const loadSchools = useCallback(async () => {
    if (!token) return;
    try {
      const result = await request<{ schools: School[] }>('/super-admin/schools', token);
      setSchools(result.schools);
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Daftar sekolah gagal dimuat.');
      if (reason instanceof Error && /token|sesi|auth|unauthorized/i.test(reason.message)) {
        sessionStorage.removeItem(TOKEN_KEY);
        setToken('');
      }
    }
  }, [token]);

  const loadSubscriptionPayments = useCallback(async () => {
    if (!token) return;
    try {
      const result = await request<{ payments: SubscriptionPayment[] }>('/super-admin/subscription-payments', token);
      setSubscriptionPayments(result.payments);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Daftar pembayaran langganan gagal dimuat.');
    }
  }, [token]);

  useEffect(() => {
    void loadSchools();
  }, [loadSchools]);

  useEffect(() => {
    void loadSubscriptionPayments();
  }, [loadSubscriptionPayments]);

  useEffect(() => {
    if (!token) return;
    request<{ settings: WhatsappGatewaySettings }>('/super-admin/settings/whatsapp-gateway', token)
      .then((result) => setGatewaySettings(result.settings))
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Pengaturan WhatsApp gagal dimuat.'));
  }, [token]);

  useEffect(() => {
    if (!token) return;
    request<{ apk_drive_url: string }>('/super-admin/settings/apk-download', token)
      .then((result) => setApkDriveUrl(result.apk_drive_url))
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Link APK gagal dimuat.'));
  }, [token]);

  useEffect(() => {
    if (!token) return;
    request<{ application_name: string }>('/super-admin/settings/application-name', token)
      .then((result) => setApplicationName(result.application_name))
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Nama aplikasi gagal dimuat.'));
  }, [token]);

  useEffect(() => {
    if (!token) return;
    request<BillingPrices>('/super-admin/settings/billing-prices', token)
      .then(setBillingPrices)
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Harga langganan gagal dimuat.'));
  }, [token]);

  useEffect(() => {
    if (!token) {
      setPaymentGatewaySettings(null);
      return;
    }
    request<{ settings: PaymentGatewaySettings }>('/super-admin/settings/payment-gateways', token)
      .then(({ settings }) => {
        setPaymentGatewaySettings(settings);
        setPaymentGatewayForm({
          xendit_enabled: settings.xendit.enabled,
          xendit_secret_key: '',
          xendit_callback_token: '',
          duitku_enabled: settings.duitku.enabled,
          duitku_environment: settings.duitku.environment,
          duitku_merchant_code: '',
          duitku_api_key: '',
          kasera_enabled: settings.kasera.enabled,
          kasera_api_key: '',
          kasera_webhook_secret: '',
        });
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Pengaturan payment gateway gagal dimuat.'));
  }, [token]);

  useEffect(() => {
    if (!token) return;
    request<PlatformBackupSettings>('/super-admin/settings/backup', token)
      .then(setBackupSettings)
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Pengaturan backup platform gagal dimuat.'));
  }, [token]);

  useEffect(() => {
    if (!token) {
      setOtpRateLimitLoaded(false);
      return;
    }
    setOtpRateLimitLoaded(false);
    request<{ settings: OtpRateLimitSettings }>('/super-admin/settings/otp-rate-limit', token)
      .then((result) => {
        setOtpRateLimit(result.settings);
        setOtpRateLimitLoaded(true);
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Batas OTP gagal dimuat.'));
  }, [token]);

  useEffect(() => {
    if (!token) return;
    request<{ whatsapp_phone: string }>('/super-admin/settings/recovery-phone', token)
      .then((result) => {
        setRecoveryPhone(result.whatsapp_phone);
        setRecoveryPhoneInput(phoneNationalDigits(result.whatsapp_phone));
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Nomor WhatsApp pemulihan gagal dimuat.'));
  }, [token]);

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await request<{ access_token: string }>('/super-admin/auth/login', '', {
        method: 'POST',
        body: { username, password },
      });
      sessionStorage.setItem(TOKEN_KEY, result.access_token);
      setToken(result.access_token);
      setPassword('');
      setLoginView('login');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Login Super Admin gagal.');
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
        '/super-admin/auth/password-reset/start',
        '',
        { method: 'POST', body: { username, whatsapp_phone: forgotPhone } },
      );
      setResetChallengeId(result.challenge_id);
      setResetOtp('');
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
    if (resetPassword.length < 8 || new TextEncoder().encode(resetPassword).length > 72 ||
        !/[A-Z]/.test(resetPassword) || !/\d/.test(resetPassword) ||
        !/[^A-Za-z0-9\s]/.test(resetPassword)) {
      setError('Kata sandi minimal 8 karakter dan wajib memiliki huruf besar, angka, serta simbol.');
      return;
    }
    setBusy(true);
    try {
      const result = await request<{ message: string }>(
        '/super-admin/auth/password-reset/verify',
        '',
        {
          method: 'POST',
          body: { challenge_id: resetChallengeId, otp: resetOtp, password: resetPassword },
        },
      );
      setPassword('');
      setResetPassword('');
      setResetChallengeId('');
      setShowResetPassword(false);
      setLoginView('login');
      setNotice(result.message);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Kode verifikasi atau reset kata sandi tidak valid.');
    } finally {
      setBusy(false);
    }
  }

  async function saveRecoveryPhone(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setRecoveryPhoneBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await request<{ whatsapp_phone: string; message: string }>(
        '/super-admin/settings/recovery-phone',
        token,
        {
          method: 'PUT',
          body: {
            whatsapp_phone: recoveryPhoneInput,
            current_password: recoveryCurrentPassword,
          },
        },
      );
      setRecoveryPhone(result.whatsapp_phone);
      setRecoveryPhoneInput(phoneNationalDigits(result.whatsapp_phone));
      setRecoveryCurrentPassword('');
      setNotice(result.message);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Nomor WhatsApp pemulihan gagal disimpan.');
    } finally {
      setRecoveryPhoneBusy(false);
    }
  }

  async function createSchool(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await request<{ school?: School; school_code?: string }>(
        '/super-admin/schools',
        token,
        { method: 'POST', body: form },
      );
      const school = result.school;
      setNotice(`Sekolah dibuat. Kode sekolah: ${school?.school_code ?? result.school_code ?? 'tersedia di tabel sekolah'}. Akun Admin awal: ${form.initial_admin.username}`);
      setForm(emptyForm);
      await loadSchools();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Sekolah gagal dibuat.');
    } finally {
      setBusy(false);
    }
  }

  async function updateSchool(school: School) {
    if (school.subscription_status === 'aktif' && !school.subscription_expires_at) {
      setError(`Atur tanggal akhir masa aktif ${school.name} melalui Edit sekolah.`);
      return;
    }
    setBusy(true);
    setError('');
    try {
      await request(`/super-admin/schools/${school.id}`, token, {
        method: 'PATCH',
        body: {
          subscription_status: school.subscription_status,
          participant_quota: Number(school.participant_quota),
        },
      });
      setNotice(`Perubahan ${school.name} disimpan.`);
      await loadSchools();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Perubahan sekolah gagal disimpan.');
    } finally {
      setBusy(false);
    }
  }

  function openSchoolEditor(school: School) {
    setEditingSchool(school);
    setSchoolEditForm({
      name: school.name,
      subscription_status: school.subscription_status,
      subscription_expires_at: utcDateTimeInput(school.subscription_expires_at),
      participant_quota: Number(school.participant_quota),
      admin_username: school.admin_username ?? '',
      admin_whatsapp_phone: phoneNationalDigits(school.admin_whatsapp_phone ?? ''),
    });
  }

  async function saveSchoolEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editingSchool) return;
    if (schoolEditForm.subscription_status === 'aktif' && !schoolEditForm.subscription_expires_at) {
      setError('Tanggal akhir masa aktif wajib diisi untuk langganan aktif.');
      return;
    }
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const body: Record<string, unknown> = {
        name: schoolEditForm.name,
        subscription_status: schoolEditForm.subscription_status,
        participant_quota: Number(schoolEditForm.participant_quota),
      };
      if (schoolEditForm.subscription_status === 'aktif') {
        body.subscription_expires_at = `${schoolEditForm.subscription_expires_at.replace('T', ' ')}:00`;
      }
      const adminUsername = schoolEditForm.admin_username.trim();
      if (adminUsername !== (editingSchool.admin_username ?? '')) {
        body.admin_username = adminUsername;
      }
      const adminPhone = schoolEditForm.admin_whatsapp_phone;
      if (adminPhone && adminPhone !== phoneNationalDigits(editingSchool.admin_whatsapp_phone ?? '')) {
        body.admin_whatsapp_phone = `+62${adminPhone}`;
      }
      await request(`/super-admin/schools/${editingSchool.id}`, token, {
        method: 'PATCH',
        body,
      });
      setNotice(`Perubahan ${schoolEditForm.name} disimpan.`);
      setEditingSchool(null);
      await loadSchools();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Data sekolah gagal diperbarui.');
    } finally {
      setBusy(false);
    }
  }

  function openSchoolPasswordReset(school: School) {
    setPasswordResetTarget(school);
    setPasswordResetMode('generate');
    setCustomAdminPassword('');
    setShowCustomAdminPassword(false);
    setError('');
  }

  async function resetSchoolPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!passwordResetTarget) return;
    if (passwordResetMode === 'custom' && !validAdminPassword(customAdminPassword)) {
      setError('Kata sandi harus minimal 8 karakter, maksimal 72 byte, dan memiliki huruf besar, angka, serta simbol.');
      return;
    }
    const school = passwordResetTarget;
    if (!window.confirm(`Ganti kata sandi akun Admin ${school.name}${school.admin_username ? ` (${school.admin_username})` : ''}? Kata sandi saat ini langsung diganti.`)) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await request<{ username: string; temporary_password: string }>(
        `/super-admin/schools/${school.id}/admin-password/reset`,
        token,
        {
          method: 'POST',
          body: passwordResetMode === 'custom' ? { password: customAdminPassword } : {},
        },
      );
      setResetCredentials({
        schoolName: school.name,
        username: result.username,
        temporaryPassword: result.temporary_password,
      });
      setPasswordResetTarget(null);
      setCustomAdminPassword('');
      setNotice('Kata sandi Admin berhasil diatur ulang. Salin dan sampaikan dengan aman.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Kata sandi Admin gagal diatur ulang.');
    } finally {
      setBusy(false);
    }
  }

  async function deleteSchool() {
    if (!deleteTarget) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await request(`/super-admin/schools/${deleteTarget.id}`, token, {
        method: 'DELETE',
        body: { confirm_school_name: deleteConfirmation },
      });
      setNotice(`Data sekolah ${deleteTarget.name} dan data terkait telah dihapus permanen.`);
      setDeleteTarget(null);
      setDeleteConfirmation('');
      await loadSchools();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Sekolah gagal dihapus.');
    } finally {
      setBusy(false);
    }
  }

  async function saveApplicationName(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setApplicationNameBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await request<{ application_name: string }>('/super-admin/settings/application-name', token, {
        method: 'PUT',
        body: { application_name: applicationName.trim() },
      });
      setApplicationName(result.application_name);
      setNotice('Nama aplikasi diperbarui di portal Super Admin dan portal sekolah.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Nama aplikasi gagal disimpan.');
    } finally {
      setApplicationNameBusy(false);
    }
  }

  async function saveBillingPrices(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBillingBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await request<Pick<BillingPrices, 'monthly_price' | 'lifetime_price'>>(
        '/super-admin/settings/billing-prices',
        token,
        {
          method: 'PUT',
          body: {
            monthly_price: Number(billingPrices.monthly_price),
            lifetime_price: Number(billingPrices.lifetime_price),
          },
        },
      );
      setBillingPrices((current) => ({ ...current, ...result }));
      setNotice('Harga paket langganan diperbarui.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Harga paket gagal disimpan.');
    } finally {
      setBillingBusy(false);
    }
  }

  async function savePaymentGateways(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPaymentGatewayBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await request<{ settings: PaymentGatewaySettings }>(
        '/super-admin/settings/payment-gateways',
        token,
        {
          method: 'PUT',
          body: {
            public_web_url: window.location.protocol === 'https:' ? window.location.origin : '',
            public_api_url: (() => {
              const apiUrl = new URL(API_BASE, window.location.origin);
              return apiUrl.protocol === 'https:' ? apiUrl.origin : '';
            })(),
            xendit: {
              enabled: paymentGatewayForm.xendit_enabled,
              secret_key: paymentGatewayForm.xendit_secret_key,
              callback_token: paymentGatewayForm.xendit_callback_token,
            },
            duitku: {
              enabled: paymentGatewayForm.duitku_enabled,
              environment: paymentGatewayForm.duitku_environment,
              merchant_code: paymentGatewayForm.duitku_merchant_code,
              api_key: paymentGatewayForm.duitku_api_key,
            },
            kasera: {
              enabled: paymentGatewayForm.kasera_enabled,
              api_key: paymentGatewayForm.kasera_api_key,
              webhook_secret: paymentGatewayForm.kasera_webhook_secret,
            },
          },
        },
      );
      setPaymentGatewaySettings(result.settings);
      setPaymentGatewayForm((current) => ({
        ...current,
        xendit_secret_key: '',
        xendit_callback_token: '',
        duitku_merchant_code: '',
        duitku_api_key: '',
        kasera_api_key: '',
        kasera_webhook_secret: '',
      }));
      setBillingPrices((current) => ({
        ...current,
        providers: {
          xendit: result.settings.xendit.enabled && result.settings.xendit.configured,
          duitku: result.settings.duitku.enabled && result.settings.duitku.configured,
          kasera: result.settings.kasera.enabled && result.settings.kasera.configured,
        },
      }));
      setNotice('Pengaturan payment gateway berhasil disimpan.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Pengaturan payment gateway gagal disimpan.');
    } finally {
      setPaymentGatewayBusy(false);
    }
  }

  async function savePlatformBackup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBackupBusy(true);
    setBackupAction('save');
    setError('');
    setNotice('');
    try {
      const result = await request<PlatformBackupSettings>('/super-admin/settings/backup', token, {
        method: 'PUT',
        body: {
          enabled: backupSettings.enabled,
          backup_time: backupSettings.backup_time,
          bot_token: backupBotToken,
          chat_id: backupChatId,
        },
      });
      setBackupSettings(result);
      setBackupBotToken('');
      setBackupChatId('');
      setNotice('Jadwal backup platform berhasil disimpan.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Pengaturan backup platform gagal disimpan.');
    } finally {
      setBackupBusy(false);
      setBackupAction(null);
    }
  }

  async function runBackupNow() {
    setBackupBusy(true);
    setBackupAction('run');
    setError('');
    setNotice('');
    try {
      const result = await request<Pick<PlatformBackupSettings, 'last_status' | 'last_run_at' | 'last_error'>>(
        '/super-admin/settings/backup/run',
        token,
        { method: 'POST' },
      );
      setBackupSettings((current) => ({ ...current, ...result }));
      if (result.last_status === 'success') {
        setNotice('Backup sekarang berhasil dibuat. File terenkripsi tersedia untuk diunduh.');
      } else if (result.last_status === 'notification_failed') {
        setError(`Backup berhasil disimpan, tetapi notifikasi Telegram gagal: ${result.last_error ?? 'Periksa konfigurasi Telegram.'}`);
      } else {
        setError(`Backup gagal: ${result.last_error ?? 'Status backup tidak tersedia.'}`);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Backup platform gagal dijalankan.');
    } finally {
      setBackupBusy(false);
      setBackupAction(null);
    }
  }

  async function saveOtpRateLimit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setOtpRateLimitBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await request<{ settings: OtpRateLimitSettings }>('/super-admin/settings/otp-rate-limit', token, {
        method: 'PUT',
        body: {
          max_requests_per_phone: Number(otpRateLimit.max_requests_per_phone),
          window_minutes: Number(otpRateLimit.window_minutes),
        },
      });
      setOtpRateLimit(result.settings);
      setNotice('Batas permintaan OTP berhasil disimpan.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Batas OTP gagal disimpan.');
    } finally {
      setOtpRateLimitBusy(false);
    }
  }

  async function downloadPlatformBackup() {
    setBackupBusy(true);
    setBackupAction('download');
    setError('');
    try {
      const response = await fetch(`${API_BASE}/super-admin/settings/backup/latest`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as {
          error?: string | { message?: string };
        };
        const message = typeof payload.error === 'string'
          ? payload.error
          : payload.error?.message;
        throw new Error(message || `Unduhan gagal (${response.status}).`);
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = 'ruang-hadir-saas-backup-encrypted.json.enc';
      link.click();
      URL.revokeObjectURL(url);
      setNotice('Backup platform terenkripsi berhasil diunduh.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Backup platform gagal diunduh.');
    } finally {
      setBackupBusy(false);
      setBackupAction(null);
    }
  }

  async function resetCode(school: School) {
    const entered = (manualCodes[school.id] ?? '').trim();
    const manualCode = entered || undefined;
    if (manualCode && !/^\d{4}$/.test(manualCode)) {
      setError('Kode manual harus tepat 4 digit.');
      return;
    }
    if (!window.confirm(`Buat kode sekolah baru untuk ${school.name}? Kode lama tidak bisa digunakan untuk login.`)) {
      return;
    }
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await request<{ school_code?: string; school?: School }>(
        `/super-admin/schools/${school.id}/code/reset`,
        token,
        { method: 'POST', body: manualCode ? { school_code: manualCode } : {} },
      );
      setNotice(`Kode terbaru untuk ${school.name}: ${result.school?.school_code ?? result.school_code ?? 'lihat tabel sekolah'}`);
      setManualCodes((current) => ({ ...current, [school.id]: '' }));
      await loadSchools();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Kode sekolah gagal diubah.');
    } finally {
      setBusy(false);
    }
  }

  async function uploadLogo(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!logoDataUrl) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await request('/super-admin/branding/logo', token, {
        method: 'PUT',
        body: { logo_data_url: logoDataUrl },
      });
      setLogoDataUrl('');
      setLogoAvailable(false);
      setLogoVersion((version) => version + 1);
      setNotice('Logo platform tersimpan dan favicon portal akan diperbarui.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Logo gagal disimpan.');
    } finally {
      setBusy(false);
    }
  }

  async function removeLogo() {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await request('/super-admin/branding/logo', token, { method: 'DELETE' });
      setLogoDataUrl('');
      setLogoAvailable(false);
      setLogoVersion((version) => version + 1);
      setNotice('Logo platform dihapus; favicon kembali ke logo bawaan.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Logo gagal dihapus.');
    } finally {
      setBusy(false);
    }
  }

  async function selectLogo(file?: File) {
    setLogoDataUrl('');
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 1024 * 1024) {
      setError('Pilih gambar PNG, JPEG, atau WebP dengan ukuran maksimal 1 MB.');
      return;
    }
    try {
      setLogoDataUrl(await readLogoFile(file));
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'File logo gagal dibaca.');
    }
  }

  async function saveWhatsappGateway(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setGatewayBusy(true);
    setError('');
    setNotice('');
    try {
      await request('/super-admin/settings/whatsapp-gateway', token, {
        method: 'PUT',
        body: {
          endpoint_url: gatewaySettings.endpoint_url,
          is_enabled: gatewaySettings.is_enabled,
          ...(gatewayToken ? { token: gatewayToken } : {}),
        },
      });
      setGatewayToken('');
      const current = await request<{ settings: WhatsappGatewaySettings }>(
        '/super-admin/settings/whatsapp-gateway',
        token,
      );
      setGatewaySettings(current.settings);
      setNotice('Pengaturan WhatsApp gateway berhasil disimpan.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Pengaturan WhatsApp gagal disimpan.');
    } finally {
      setGatewayBusy(false);
    }
  }

  async function testWhatsappGateway() {
    setGatewayTestBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await request<{ log: Pick<WhatsappGatewaySettings, 'last_test_at' | 'last_test_status' | 'last_test_message'> }>(
        '/super-admin/settings/whatsapp-gateway/test',
        token,
        { method: 'POST', body: { phone: `+62${gatewayTestPhone}` } },
      );
      setGatewaySettings((current) => ({ ...current, ...result.log }));
      if (result.log.last_test_status === 'success') setNotice('Tes WA gateway berhasil dikirim.');
      else setError(result.log.last_test_message ?? 'Tes WA gateway gagal.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Tes WA gateway gagal.');
    } finally {
      setGatewayTestBusy(false);
    }
  }

  async function clearWhatsappGateway() {
    if (!window.confirm('Hapus URL dan token gateway WhatsApp? Pendaftaran OTP akan berhenti sampai gateway diatur lagi.')) return;
    setGatewayBusy(true);
    setError('');
    setNotice('');
    try {
      await request('/super-admin/settings/whatsapp-gateway', token, { method: 'DELETE' });
      setGatewaySettings({
        endpoint_url: '', is_enabled: false, is_configured: false, token_hint: '',
        last_test_at: null, last_test_status: null, last_test_message: null,
      });
      setGatewayToken('');
      setNotice('Konfigurasi WhatsApp gateway telah dihapus.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Konfigurasi WhatsApp gagal dihapus.');
    } finally {
      setGatewayBusy(false);
    }
  }

  async function saveApkDownload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setApkBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await request<{ apk_drive_url: string }>(
        '/super-admin/settings/apk-download',
        token,
        { method: 'PUT', body: { apk_drive_url: apkDriveUrl.trim() } },
      );
      setApkDriveUrl(result.apk_drive_url);
      setNotice(result.apk_drive_url
        ? 'Link Google Drive APK tersedia di menu akun sekolah.'
        : 'Link download APK dihapus dari menu akun sekolah.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Link APK gagal disimpan.');
    } finally {
      setApkBusy(false);
    }
  }

  function signOut() {
    sessionStorage.removeItem(TOKEN_KEY);
    setToken('');
    setSchools([]);
  }

  if (!token) {
    return (
      <main className="login-shell">
        {loginView === 'login' && <form className="login-card" onSubmit={(event) => void login(event)}>
          <div className="brand-mark">RH</div>
          <p className="eyebrow">{applicationName.toLocaleUpperCase('id-ID')} · PLATFORM</p>
          <h1>Super Admin SaaS</h1>
          <p className="muted">Kelola tenant sekolah dan status langganan platform.</p>
          {error && <div className="alert error">{error}</div>}
          {notice && <div className="alert success">{notice}</div>}
          <label>Username<input autoComplete="username" required value={username} onChange={(event) => setUsername(event.target.value)} /></label>
          <label>Password
            <span className="password-input-wrap">
              <input type={showLoginPassword ? 'text' : 'password'} autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} />
              <button className="password-eye" type="button" onClick={() => setShowLoginPassword((visible) => !visible)} aria-label={showLoginPassword ? 'Sembunyikan kata sandi' : 'Tampilkan kata sandi'}><PasswordEye visible={showLoginPassword} /></button>
            </span>
          </label>
          <button className="button primary" disabled={busy}>{busy ? 'Memeriksa…' : 'Masuk sebagai Super Admin'}</button>
          <button className="text-button forgot-password-button" type="button" onClick={() => { setForgotPhone(''); setError(''); setNotice(''); setLoginView('forgot-password'); }}>Lupa kata sandi?</button>
        </form>}
        {loginView === 'forgot-password' && <form className="login-card" onSubmit={(event) => void startPasswordReset(event)}>
          <button className="text-button back-link" type="button" onClick={() => { setLoginView('login'); setError(''); setNotice(''); }}>← Kembali ke login</button>
          <div className="brand-mark">RH</div>
          <p className="eyebrow">PEMULIHAN AKUN</p>
          <h1>Lupa kata sandi?</h1>
          <p className="muted">Jika username dan nomor WhatsApp cocok dengan akun Super Admin aktif, OTP akan dikirim ke nomor tersebut.</p>
          {error && <div className="alert error">{error}</div>}
          {notice && <div className="alert success">{notice}</div>}
          <label>Username<input autoComplete="username" required value={username} onChange={(event) => setUsername(event.target.value)} /></label>
          <label>Nomor WhatsApp pemulihan
            <span className="phone-input-wrap">
              <span className="phone-prefix">+62</span>
              <input type="text" inputMode="numeric" autoComplete="off" maxLength={13} pattern="8[0-9]{6,12}" required value={forgotPhone} onChange={(event) => setForgotPhone(phoneNationalDigits(event.target.value))} />
            </span>
          </label>
          <button className="button primary" disabled={busy}>{busy ? 'Mengirim OTP…' : 'Kirim kode OTP'}</button>
        </form>}
        {loginView === 'reset-password' && <form className="login-card" onSubmit={(event) => void verifyPasswordReset(event)}>
          <button className="text-button back-link" type="button" onClick={() => { setLoginView('forgot-password'); setError(''); setNotice(''); }}>← Kembali</button>
          <div className="brand-mark">RH</div>
          <p className="eyebrow">PEMULIHAN AKUN</p>
          <h1>Buat kata sandi baru</h1>
          {error && <div className="alert error">{error}</div>}
          {notice && <div className="alert success">{notice}</div>}
          <label>Kode OTP<input autoComplete="one-time-code" inputMode="numeric" pattern="\d{6}" maxLength={6} required value={resetOtp} onChange={(event) => setResetOtp(event.target.value.replace(/\D/g, '').slice(0, 6))} /></label>
          <label>Kata sandi baru
            <span className="password-input-wrap">
              <input type={showResetPassword ? 'text' : 'password'} autoComplete="new-password" required value={resetPassword} onChange={(event) => setResetPassword(event.target.value)} />
              <button className="password-eye" type="button" onClick={() => setShowResetPassword((visible) => !visible)} aria-label={showResetPassword ? 'Sembunyikan kata sandi' : 'Tampilkan kata sandi'}><PasswordEye visible={showResetPassword} /></button>
            </span>
          </label>
          <button className="button primary" disabled={busy || resetOtp.length !== 6}>{busy ? 'Mengatur ulang…' : 'Atur ulang kata sandi'}</button>
          <button className="text-button register-link" type="button" disabled={busy} onClick={() => void startPasswordReset()}>{busy ? 'Mengirim…' : 'Kirim ulang OTP'}</button>
        </form>}
      </main>
    );
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand"><div className="brand-mark">RH</div><div><strong>{applicationName}</strong><small>Platform SaaS</small></div></div>
        <div className="top-actions"><span className="role-pill">Super Admin</span><button className="button secondary" onClick={signOut}>Keluar</button></div>
      </header>
      <div className="content">
        <section className="page-heading">
          <div><p className="eyebrow">KONSOL PLATFORM</p><h1>Manajemen sekolah</h1><p className="muted">Kelola tenant, kode sekolah, kuota peserta, dan masa langganan.</p></div>
          <div className="metric"><strong>{schools.length}</strong><span>Tenant terdaftar</span></div>
        </section>
        <nav className="section-menu" aria-label="Menu Super Admin">
          <a href="#payment-gateways">Payment gateway</a>
          <a href="#account-recovery">Nomor pemulihan</a>
          <a href="#automatic-backup">Backup otomatis</a>
          <a href="#otp-rate-limit">Batas OTP</a>
          <a href="#school-tenants">Akun sekolah</a>
          <a href="#subscription-payments">Pembayaran</a>
        </nav>
        {error && <div className="alert error">{error}</div>}
        {notice && <div className="alert success">{notice}</div>}
        <section className="panel branding-panel">
          <div>
            <h2>Logo dan favicon platform</h2>
            <p className="muted">Logo ini menjadi favicon portal Super Admin dan portal sekolah. Format PNG, JPEG, atau WebP; maksimal 1 MB.</p>
          </div>
          <form className="branding-form" onSubmit={(event) => void uploadLogo(event)}>
            <div className="branding-preview">
              {logoDataUrl
                ? <img src={logoDataUrl} alt="Pratinjau logo baru" />
                : logoAvailable
                  ? <img src={`${API_BASE}/branding/logo?v=${logoVersion}`} alt="Logo platform saat ini" onError={() => setLogoAvailable(false)} />
                  : <span>RH</span>}
            </div>
            <label>Pilih logo<input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => void selectLogo(event.target.files?.[0])} /></label>
            <button className="button primary" disabled={busy || !logoDataUrl}>{busy ? 'Menyimpan…' : 'Simpan logo'}</button>
            <button className="button secondary" type="button" disabled={busy} onClick={() => void removeLogo()}>Hapus logo</button>
          </form>
        </section>
        <section className="panel name-panel">
          <div>
            <h2>Nama aplikasi</h2>
            <p className="muted">Nama ini ditampilkan di portal Super Admin dan halaman sekolah.</p>
          </div>
          <form className="name-form" onSubmit={(event) => void saveApplicationName(event)}>
            <label>Nama aplikasi
              <input required maxLength={120} value={applicationName} onChange={(event) => setApplicationName(event.target.value)} />
            </label>
            <button className="button primary" disabled={applicationNameBusy}>{applicationNameBusy ? 'Menyimpan…' : 'Simpan nama'}</button>
          </form>
        </section>
        <section className="panel billing-prices-panel">
          <div>
            <h2>Harga perpanjangan</h2>
            <p className="muted">Harga digunakan server saat membuat tagihan baru. Perubahan tidak mengubah tagihan yang sudah dibuat.</p>
            <span className={`gateway-status ${billingPrices.providers?.xendit || billingPrices.providers?.duitku ? 'ready' : ''}`}>
              Provider tersedia: {[
                billingPrices.providers?.xendit && 'Xendit',
                billingPrices.providers?.duitku && 'Duitku',
              ].filter(Boolean).join(', ') || 'belum dikonfigurasi'}
            </span>
          </div>
          <form className="billing-prices-form" onSubmit={(event) => void saveBillingPrices(event)}>
            <label>Langganan bulanan (Rp)<input type="number" min={1000} max={1000000000} step={1000} required value={billingPrices.monthly_price} onChange={(event) => setBillingPrices((current) => ({ ...current, monthly_price: Number(event.target.value) }))} /></label>
            <label>Sekali bayar Lifetime (Rp)<input type="number" min={1000} max={1000000000} step={1000} required value={billingPrices.lifetime_price} onChange={(event) => setBillingPrices((current) => ({ ...current, lifetime_price: Number(event.target.value) }))} /></label>
            <button className="button primary" disabled={billingBusy}>{billingBusy ? 'Menyimpan…' : 'Simpan harga'}</button>
          </form>
        </section>
        <section id="payment-gateways" className="panel payment-gateways-panel">
          <div>
            <h2>Pengaturan payment gateway</h2>
            <p className="muted">Atur kredensial Xendit, Duitku, dan Kasera untuk tagihan sekolah. Kredensial dienkripsi saat disimpan dan tidak pernah ditampilkan kembali.</p>
            <p className="muted">Kredensial kosong akan mempertahankan nilai tersimpan. URL publik untuk callback dan halaman kembali disimpan otomatis dari alamat portal serta API saat pengaturan disimpan; environment backend tetap menjadi fallback.</p>
            {paymentGatewaySettings && <span className="gateway-status">
              Sumber kredensial: {paymentGatewaySettings.credential_source === 'database' ? 'pengaturan platform' : 'environment backend'}
            </span>}
          </div>
          <form className="payment-gateways-form" onSubmit={(event) => void savePaymentGateways(event)}>
            <fieldset>
              <legend>Xendit</legend>
              <small className="payment-callback-url">Callback URL: {paymentGatewaySettings?.callback_urls.xendit || 'Simpan pengaturan untuk menetapkan URL callback'}</small>
              <label className="gateway-toggle">
                <input type="checkbox" checked={paymentGatewayForm.xendit_enabled} onChange={(event) => setPaymentGatewayForm((current) => ({ ...current, xendit_enabled: event.target.checked }))} />
                Aktifkan Xendit
              </label>
              <label>Secret API key
                <input type="password" autoComplete="new-password" value={paymentGatewayForm.xendit_secret_key} onChange={(event) => setPaymentGatewayForm((current) => ({ ...current, xendit_secret_key: event.target.value }))} placeholder={paymentGatewaySettings?.xendit.secret_key_hint ? `Tersimpan (${paymentGatewaySettings.xendit.secret_key_hint}); kosongkan untuk mempertahankan` : 'Masukkan secret API key Xendit'} />
              </label>
              <label>Callback verification token
                <input type="password" autoComplete="new-password" value={paymentGatewayForm.xendit_callback_token} onChange={(event) => setPaymentGatewayForm((current) => ({ ...current, xendit_callback_token: event.target.value }))} placeholder={paymentGatewaySettings?.xendit.callback_token_hint ? `Tersimpan (${paymentGatewaySettings.xendit.callback_token_hint}); kosongkan untuk mempertahankan` : 'Masukkan callback token Xendit'} />
              </label>
              <span className={`gateway-status ${paymentGatewaySettings?.xendit.configured && paymentGatewaySettings.xendit.enabled ? 'ready' : ''}`}>
                {paymentGatewaySettings?.xendit.configured && paymentGatewaySettings.xendit.enabled ? '● Aktif dan siap' : '○ Belum aktif/terkonfigurasi'}
              </span>
            </fieldset>
            <fieldset>
              <legend>Duitku</legend>
              <small className="payment-callback-url">Callback URL: {paymentGatewaySettings?.callback_urls.duitku || 'Simpan pengaturan untuk menetapkan URL callback'}</small>
              <label className="gateway-toggle">
                <input type="checkbox" checked={paymentGatewayForm.duitku_enabled} onChange={(event) => setPaymentGatewayForm((current) => ({ ...current, duitku_enabled: event.target.checked }))} />
                Aktifkan Duitku
              </label>
              <label>Environment
                <select value={paymentGatewayForm.duitku_environment} onChange={(event) => setPaymentGatewayForm((current) => ({ ...current, duitku_environment: event.target.value as PaymentGatewayForm['duitku_environment'] }))}>
                  <option value="production">Production</option><option value="sandbox">Sandbox</option>
                </select>
              </label>
              <label>Merchant code
                <input autoComplete="off" value={paymentGatewayForm.duitku_merchant_code} onChange={(event) => setPaymentGatewayForm((current) => ({ ...current, duitku_merchant_code: event.target.value }))} placeholder={paymentGatewaySettings?.duitku.merchant_code_hint ? `Tersimpan (${paymentGatewaySettings.duitku.merchant_code_hint}); kosongkan untuk mempertahankan` : 'Masukkan merchant code Duitku'} />
              </label>
              <label>API key
                <input type="password" autoComplete="new-password" value={paymentGatewayForm.duitku_api_key} onChange={(event) => setPaymentGatewayForm((current) => ({ ...current, duitku_api_key: event.target.value }))} placeholder={paymentGatewaySettings?.duitku.api_key_hint ? `Tersimpan (${paymentGatewaySettings.duitku.api_key_hint}); kosongkan untuk mempertahankan` : 'Masukkan API key Duitku'} />
              </label>
              <span className={`gateway-status ${paymentGatewaySettings?.duitku.configured && paymentGatewaySettings.duitku.enabled ? 'ready' : ''}`}>
                {paymentGatewaySettings?.duitku.configured && paymentGatewaySettings.duitku.enabled ? '● Aktif dan siap' : '○ Belum aktif/terkonfigurasi'}
              </span>
            </fieldset>
            <fieldset>
              <legend>Kasera</legend>
              <small className="payment-callback-url">Webhook URL: {paymentGatewaySettings?.callback_urls.kasera || 'Simpan pengaturan untuk menetapkan URL webhook'}</small>
              <p className="muted">Pasang URL ini sebagai webhook Kasera untuk event payment.paid, lalu masukkan signing secret yang diberikan Kasera. Tagihan produksi memerlukan API key live.</p>
              <label className="gateway-toggle">
                <input type="checkbox" checked={paymentGatewayForm.kasera_enabled} onChange={(event) => setPaymentGatewayForm((current) => ({ ...current, kasera_enabled: event.target.checked }))} />
                Aktifkan Kasera
              </label>
              <label>API key Kasera
                <input type="password" autoComplete="new-password" value={paymentGatewayForm.kasera_api_key} onChange={(event) => setPaymentGatewayForm((current) => ({ ...current, kasera_api_key: event.target.value }))} placeholder={paymentGatewaySettings?.kasera.api_key_hint ? `Tersimpan (${paymentGatewaySettings.kasera.api_key_hint}); kosongkan untuk mempertahankan` : 'Masukkan API key kp_live_…'} />
              </label>
              <label>Webhook signing secret
                <input type="password" autoComplete="new-password" value={paymentGatewayForm.kasera_webhook_secret} onChange={(event) => setPaymentGatewayForm((current) => ({ ...current, kasera_webhook_secret: event.target.value }))} placeholder={paymentGatewaySettings?.kasera.webhook_secret_hint ? `Tersimpan (${paymentGatewaySettings.kasera.webhook_secret_hint}); kosongkan untuk mempertahankan` : 'Masukkan signing secret webhook Kasera'} />
              </label>
              <span className={`gateway-status ${paymentGatewaySettings?.kasera.configured && paymentGatewaySettings.kasera.enabled ? 'ready' : ''}`}>
                {paymentGatewaySettings?.kasera.configured && paymentGatewaySettings.kasera.enabled ? '● Aktif dan siap' : '○ Belum aktif/terkonfigurasi'}
              </span>
            </fieldset>
            <button className="button primary" disabled={paymentGatewayBusy || !paymentGatewaySettings}>
              {paymentGatewayBusy ? 'Menyimpan…' : 'Simpan pengaturan gateway'}
            </button>
          </form>
        </section>
        <section id="account-recovery" className="panel recovery-phone-panel">
          <div>
            <h2>Nomor WhatsApp pemulihan Super Admin</h2>
            <p className="muted">Nomor ini digunakan untuk mengirim OTP saat lupa kata sandi. Pastikan akses ke nomor tetap aktif.</p>
            <span className={`gateway-status ${recoveryPhone ? 'ready' : ''}`}>
              {recoveryPhone ? `● Terdaftar: ${recoveryPhone}` : '○ Nomor pemulihan belum didaftarkan'}
            </span>
          </div>
          <form className="recovery-phone-form" onSubmit={(event) => void saveRecoveryPhone(event)}>
            <label>Nomor WhatsApp
              <span className="phone-input-wrap">
                <span className="phone-prefix">+62</span>
                <input type="text" inputMode="numeric" autoComplete="off" maxLength={13} pattern="8[0-9]{6,12}" required value={recoveryPhoneInput} onChange={(event) => setRecoveryPhoneInput(phoneNationalDigits(event.target.value))} />
              </span>
            </label>
            <label>Password saat ini<input type="password" autoComplete="current-password" required value={recoveryCurrentPassword} onChange={(event) => setRecoveryCurrentPassword(event.target.value)} /></label>
            <button className="button primary" disabled={recoveryPhoneBusy}>{recoveryPhoneBusy ? 'Menyimpan…' : 'Simpan nomor pemulihan'}</button>
          </form>
        </section>
        <section id="automatic-backup" className="panel platform-backup-panel">
          <div>
            <h2>Backup otomatis platform</h2>
            <p className="muted">Backup mencakup database seluruh sekolah. File terenkripsi disimpan pada volume privat; Telegram hanya menerima notifikasi status.</p>
            <span className={`gateway-status ${backupSettings.enabled && backupSettings.bot_configured ? 'ready' : ''}`}>
              {backupSettings.enabled && backupSettings.bot_configured ? '● Backup aktif' : '○ Backup belum aktif'}
            </span>
            <p className="muted backup-run-status">
              Status terakhir: <strong>{backupSettings.last_status}</strong>
              {backupSettings.last_run_at ? ` · ${new Date(backupSettings.last_run_at).toLocaleString('id-ID')}` : ''}
              {backupSettings.last_error ? ` · ${backupSettings.last_error}` : ''}
            </p>
          </div>
          <form className="platform-backup-form" onSubmit={(event) => void savePlatformBackup(event)}>
            <label className="backup-toggle">
              <input type="checkbox" checked={backupSettings.enabled} onChange={(event) => setBackupSettings((current) => ({ ...current, enabled: event.target.checked }))} />
              Aktifkan backup harian
            </label>
            <label>Waktu backup<input type="time" required value={backupSettings.backup_time} onChange={(event) => setBackupSettings((current) => ({ ...current, backup_time: event.target.value }))} /></label>
            <label>Token Telegram Bot<input type="password" autoComplete="new-password" value={backupBotToken} onChange={(event) => setBackupBotToken(event.target.value)} placeholder={backupSettings.bot_configured ? 'Tersimpan terenkripsi; kosongkan untuk mempertahankan' : 'Token dari BotFather'} /></label>
            <label>Chat ID / channel<input value={backupChatId} onChange={(event) => setBackupChatId(event.target.value)} placeholder={backupSettings.chat_id_hint || 'Chat ID tujuan notifikasi'} /></label>
            <p className="muted">Waktu mengikuti zona waktu BACKUP_TIMEZONE pada backend. Backup manual berjalan langsung di luar jadwal; file terenkripsi disimpan pada volume privat dan Telegram hanya menerima notifikasi.</p>
            <div className="backup-actions">
              <button className="button primary" disabled={backupBusy}>{backupAction === 'save' ? 'Menyimpan…' : 'Simpan jadwal backup'}</button>
              <button className="button secondary" type="button" disabled={backupBusy || !backupSettings.bot_configured} onClick={() => void runBackupNow()}>{backupAction === 'run' ? 'Membuat backup…' : 'Backup sekarang'}</button>
              {['success', 'notification_failed'].includes(backupSettings.last_status) && <button className="button secondary" type="button" disabled={backupBusy} onClick={() => void downloadPlatformBackup()}>{backupAction === 'download' ? 'Mengunduh…' : 'Unduh backup terenkripsi'}</button>}
            </div>
          </form>
        </section>
        <section className="panel gateway-panel">
          <div>
            <h2>Gateway WhatsApp untuk OTP</h2>
            <p className="muted">Gateway harus menerima POST JSON <code>{'{ phone, message }'}</code> dengan autentikasi Bearer dan membalas status HTTP 2xx. Simpan konfigurasi sebelum menguji; hasil 2xx berarti gateway menerima permintaan, bukan bukti pesan sudah diterima ponsel.</p>
            <span className={`gateway-status ${gatewaySettings.is_enabled && gatewaySettings.is_configured ? 'ready' : ''}`}>
              {gatewaySettings.is_enabled && gatewaySettings.is_configured ? '● Aktif dan siap' : '○ Belum aktif'}
            </span>
          </div>
          <form className="gateway-form" onSubmit={(event) => void saveWhatsappGateway(event)}>
            <label>URL HTTPS gateway<input type="url" required placeholder="https://gateway.example/api/send" value={gatewaySettings.endpoint_url} onChange={(event) => setGatewaySettings((current) => ({ ...current, endpoint_url: event.target.value }))} /></label>
            <label>Bearer token
              <input type="password" autoComplete="new-password" placeholder={gatewaySettings.is_configured ? 'Tersimpan — kosongkan untuk mempertahankan' : 'Masukkan token gateway'} value={gatewayToken} onChange={(event) => setGatewayToken(event.target.value)} />
            </label>
            {gatewaySettings.is_configured && <small className="gateway-hint">{gatewaySettings.token_hint}</small>}
            <label>Nomor WhatsApp untuk tes
              <span className="phone-input-wrap">
                <span className="phone-prefix">+62</span>
                <input type="text" inputMode="numeric" autoComplete="off" maxLength={13} pattern="8[0-9]{6,12}" value={gatewayTestPhone} onChange={(event) => setGatewayTestPhone(phoneNationalDigits(event.target.value))} />
              </span>
            </label>
            <label className="gateway-toggle"><input type="checkbox" checked={gatewaySettings.is_enabled} onChange={(event) => setGatewaySettings((current) => ({ ...current, is_enabled: event.target.checked }))} /> Aktifkan OTP WhatsApp untuk pendaftaran</label>
            <div className="gateway-actions">
              <button className="button primary" disabled={gatewayBusy}>{gatewayBusy ? 'Menyimpan…' : 'Simpan pengaturan'}</button>
              <button className="button secondary" type="button" disabled={gatewayBusy || gatewayTestBusy || !gatewaySettings.is_configured || !/^8[0-9]{6,12}$/.test(gatewayTestPhone)} onClick={() => void testWhatsappGateway()}>{gatewayTestBusy ? 'Mengirim tes…' : 'Tes WA gateway'}</button>
              <button className="button secondary" type="button" disabled={gatewayBusy || gatewayTestBusy || !gatewaySettings.is_configured} onClick={() => void clearWhatsappGateway()}>Hapus konfigurasi</button>
            </div>
            {gatewaySettings.last_test_status && <div className={`gateway-test-log ${gatewaySettings.last_test_status}`}>
              <strong>Log tes terakhir · {gatewaySettings.last_test_status === 'success' ? 'Berhasil' : 'Gagal'}</strong>
              {gatewaySettings.last_test_at && <time>{gatewaySettings.last_test_at} UTC</time>}
              <p>{gatewaySettings.last_test_message}</p>
            </div>}
          </form>
        </section>
        <section id="otp-rate-limit" className="panel otp-rate-limit-panel">
          <div>
            <h2>Batas permintaan OTP</h2>
            <p className="muted">Berlaku untuk OTP pendaftaran sekolah dan reset kata sandi. Perlindungan tambahan tetap membatasi 20 permintaan per alamat jaringan per jam.</p>
          </div>
          <form className="otp-rate-limit-form" onSubmit={(event) => void saveOtpRateLimit(event)}>
            <label>Maksimal permintaan per nomor telepon
              <input type="number" min={1} max={50} required value={otpRateLimit.max_requests_per_phone} onChange={(event) => setOtpRateLimit((current) => ({ ...current, max_requests_per_phone: Number(event.target.value) }))} />
            </label>
            <label>Dalam jangka waktu (menit)
              <input type="number" min={1} max={1440} required value={otpRateLimit.window_minutes} onChange={(event) => setOtpRateLimit((current) => ({ ...current, window_minutes: Number(event.target.value) }))} />
            </label>
            <button className="button primary" disabled={otpRateLimitBusy || !otpRateLimitLoaded}>{otpRateLimitBusy ? 'Menyimpan…' : 'Simpan batas OTP'}</button>
          </form>
        </section>
        <section className="panel apk-panel">
          <div>
            <h2>Distribusi aplikasi Android</h2>
            <p className="muted">Masukkan link berbagi file APK Google Drive. Setelah disimpan, menu “Unduh APK” tampil untuk akun sekolah. Atur akses Drive agar pemilik link dapat mengunduh.</p>
            <span className={`gateway-status ${apkDriveUrl ? 'ready' : ''}`}>
              {apkDriveUrl ? '● Link APK tersedia' : '○ Belum ada link APK'}
            </span>
          </div>
          <form className="apk-form" onSubmit={(event) => void saveApkDownload(event)}>
            <label>Link file APK di Google Drive
              <input type="url" placeholder="https://drive.google.com/file/d/…/view" value={apkDriveUrl} onChange={(event) => setApkDriveUrl(event.target.value)} />
            </label>
            <div className="gateway-actions">
              <button className="button primary" disabled={apkBusy}>{apkBusy ? 'Menyimpan…' : 'Simpan link'}</button>
            </div>
          </form>
        </section>
        <section className="panel create-panel">
          <div><h2>Tambah sekolah</h2><p className="muted">Kode 4 digit dibuat acak dan harus unik.</p></div>
          <form className="create-form" onSubmit={(event) => void createSchool(event)}>
            <label>Nama sekolah<input required maxLength={180} value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value, slug: current.slug || slugify(event.target.value) }))} /></label>
            <label>Slug unik<input required maxLength={100} pattern="[a-z0-9-]+" value={form.slug} onChange={(event) => setForm((current) => ({ ...current, slug: slugify(event.target.value) }))} /></label>
            <label>Status
              <select value={form.subscription_status} onChange={(event) => setForm((current) => ({ ...current, subscription_status: event.target.value as SubscriptionStatus }))}>
                <option value="trial">Uji coba</option><option value="aktif">Aktif</option><option value="lifetime">Lifetime</option><option value="suspend">Ditangguhkan</option>
              </select>
            </label>
            <label>Kuota peserta<input type="number" min={1} max={1000000} required value={form.participant_quota} onChange={(event) => setForm((current) => ({ ...current, participant_quota: Number(event.target.value) }))} /></label>
            <label>Username Admin awal<input required maxLength={80} value={form.initial_admin.username} onChange={(event) => setForm((current) => ({ ...current, initial_admin: { ...current.initial_admin, username: event.target.value } }))} /></label>
            <label>Nama Admin awal<input required maxLength={150} value={form.initial_admin.display_name} onChange={(event) => setForm((current) => ({ ...current, initial_admin: { ...current.initial_admin, display_name: event.target.value } }))} /></label>
            <label>Password Admin awal<input type="password" minLength={12} required value={form.initial_admin.password} onChange={(event) => setForm((current) => ({ ...current, initial_admin: { ...current.initial_admin, password: event.target.value } }))} /></label>
            <button className="button primary" disabled={busy}>Buat tenant</button>
          </form>
        </section>
        <section id="school-tenants" className="panel">
          <div className="section-title"><div><h2>Daftar tenant</h2><p className="muted">{schools.length} sekolah</p></div><button className="button secondary" onClick={() => void loadSchools()}>Muat ulang</button></div>
          <div className="table-scroll">
            <table className="tenant-table">
              <thead><tr><th>Sekolah</th><th>Kode 4 digit</th><th>Status langganan</th><th>Kuota</th><th>Masa berlaku</th><th>Aksi kode</th><th>Aksi sekolah</th></tr></thead>
              <tbody>
                {schools.map((school) => (
                  <tr key={school.id}>
                    <td><strong>{school.name}</strong><small>{school.slug}</small></td>
                    <td><code className="school-code">{school.school_code}</code></td>
                    <td>
                      <div className="status-control">
                        <span className={`status-dot ${school.subscription_status}`} />
                        <select
                          aria-label={`Status ${school.name}`}
                          value={school.subscription_status}
                          onChange={(event) => setSchools((current) => current.map((item) => item.id === school.id ? { ...item, subscription_status: event.target.value as SubscriptionStatus } : item))}
                        >
                          <option value="trial">Uji coba</option><option value="aktif">Aktif</option><option value="lifetime">Lifetime</option><option value="suspend">Ditangguhkan</option>
                        </select>
                      </div>
                    </td>
                    <td><input className="quota-input" type="number" min={1} value={school.participant_quota} onChange={(event) => setSchools((current) => current.map((item) => item.id === school.id ? { ...item, participant_quota: Number(event.target.value) } : item))} /></td>
                    <td>{school.subscription_status === 'lifetime' ? 'Selamanya' : school.subscription_expires_at ? new Date(school.subscription_expires_at).toLocaleDateString('id-ID') : school.trial_ends_at ? `Trial s/d ${new Date(school.trial_ends_at).toLocaleDateString('id-ID')}` : '—'}</td>
                    <td>
                      <div className="code-actions">
                        <input
                          inputMode="numeric"
                          maxLength={4}
                          placeholder="Acak"
                          aria-label={`Kode manual baru ${school.name}`}
                          value={manualCodes[school.id] ?? ''}
                          onChange={(event) => setManualCodes((current) => ({ ...current, [school.id]: event.target.value.replace(/\D/g, '').slice(0, 4) }))}
                        />
                        <button className="button secondary small" disabled={busy} onClick={() => void resetCode(school)}>Atur ulang</button>
                        <button className="button secondary small" disabled={busy} onClick={() => void updateSchool(school)}>Simpan</button>
                      </div>
                    </td>
                    <td>
                      <div className="school-actions">
                        <button className="button secondary small" disabled={busy} onClick={() => openSchoolEditor(school)}>Edit sekolah</button>
                        <button className="button secondary small" disabled={busy} onClick={() => openSchoolPasswordReset(school)}>Reset login</button>
                        <button className="button danger small" disabled={busy} onClick={() => { setDeleteTarget(school); setDeleteConfirmation(''); }}>Hapus sekolah</button>
                      </div>
                    </td>
                  </tr>
                ))}
                {!schools.length && <tr><td colSpan={7} className="empty">Belum ada sekolah.</td></tr>}
              </tbody>
            </table>
          </div>
          <p className="fine-print">Perubahan kode membatalkan login sekolah yang memakai kode lama. Sampaikan kode terbaru ke operator sekolah.</p>
        </section>
        <section id="subscription-payments" className="panel">
          <div className="section-title">
            <div><h2>Pembayaran dan perpanjangan</h2><p className="muted">{subscriptionPayments.length} pembayaran berhasil</p></div>
            <button className="button secondary" onClick={() => void loadSubscriptionPayments()}>Muat ulang</button>
          </div>
          <div className="table-scroll">
            <table className="tenant-table">
              <thead><tr><th>Sekolah</th><th>Paket</th><th>Provider</th><th>Nominal</th><th>Referensi</th><th>Dibayar</th></tr></thead>
              <tbody>
                {subscriptionPayments.map((payment) => (
                  <tr key={payment.order_id}>
                    <td><strong>{payment.school_name}</strong><small>{payment.order_id}</small></td>
                    <td>{payment.plan === 'lifetime' ? 'Lifetime' : 'Bulanan'}</td>
                    <td>{payment.provider}</td>
                    <td>Rp{payment.amount.toLocaleString('id-ID')}</td>
                    <td>{payment.provider_reference ?? '—'}</td>
                    <td>{payment.paid_at ? new Date(payment.paid_at).toLocaleString('id-ID') : '—'}</td>
                  </tr>
                ))}
                {!subscriptionPayments.length && <tr><td colSpan={6} className="empty">Belum ada pembayaran berhasil.</td></tr>}
              </tbody>
            </table>
          </div>
          <p className="fine-print">Pembayaran terverifikasi otomatis memperpanjang masa aktif sesuai paket. Tidak diperlukan persetujuan manual.</p>
        </section>
      </div>
      {editingSchool && (
        <div className="modal-backdrop" role="presentation">
          <form className="modal-card" onSubmit={(event) => void saveSchoolEdit(event)}>
            <h2>Edit sekolah</h2>
            <p className="muted">Perbarui informasi sekolah dan akun Admin untuk {editingSchool.name}. Perubahan akun akan mengeluarkan sesi login yang aktif.</p>
            <label>Nama sekolah<input required maxLength={180} value={schoolEditForm.name} onChange={(event) => setSchoolEditForm((current) => ({ ...current, name: event.target.value }))} /></label>
            <label>Username Admin<input required={Boolean(editingSchool.admin_username)} maxLength={80} pattern="[A-Za-z0-9._-]{3,80}" value={schoolEditForm.admin_username} onChange={(event) => setSchoolEditForm((current) => ({ ...current, admin_username: event.target.value }))} /></label>
            <label>Nomor WhatsApp Admin
              <span className="phone-input-wrap">
                <span className="phone-prefix">+62</span>
                <input type="text" inputMode="numeric" autoComplete="off" maxLength={13} pattern="8[0-9]{6,12}" required={Boolean(editingSchool.admin_whatsapp_phone)} value={schoolEditForm.admin_whatsapp_phone} onChange={(event) => setSchoolEditForm((current) => ({ ...current, admin_whatsapp_phone: phoneNationalDigits(event.target.value) }))} />
              </span>
            </label>
            <label>Status langganan
              <select value={schoolEditForm.subscription_status} onChange={(event) => setSchoolEditForm((current) => ({ ...current, subscription_status: event.target.value as SubscriptionStatus }))}>
                <option value="trial">Uji coba</option><option value="aktif">Aktif</option><option value="lifetime">Lifetime</option><option value="suspend">Ditangguhkan</option>
              </select>
            </label>
            <label>Masa aktif hingga (UTC)
              <input
                type="datetime-local"
                required={schoolEditForm.subscription_status === 'aktif'}
                value={schoolEditForm.subscription_expires_at}
                onChange={(event) => setSchoolEditForm((current) => ({ ...current, subscription_expires_at: event.target.value }))}
              />
            </label>
            <label>Kuota peserta<input type="number" min={1} max={1000000} required value={schoolEditForm.participant_quota} onChange={(event) => setSchoolEditForm((current) => ({ ...current, participant_quota: Number(event.target.value) }))} /></label>
            <div className="edit-school-password">
              <strong>Akun Admin sekolah</strong>
              <p className="muted">Atur kata sandi baru atau buat otomatis. Kata sandi lama langsung dinonaktifkan.</p>
              <button className="button secondary" type="button" disabled={busy} onClick={() => openSchoolPasswordReset(editingSchool)}>
                Reset kata sandi login Admin
              </button>
            </div>
            <div className="modal-actions">
              <button className="button secondary" type="button" disabled={busy} onClick={() => setEditingSchool(null)}>Batal</button>
              <button className="button primary" disabled={busy}>{busy ? 'Menyimpan…' : 'Simpan perubahan'}</button>
            </div>
          </form>
        </div>
      )}
      {deleteTarget && (
        <div className="modal-backdrop" role="presentation">
          <div className="modal-card">
            <h2>Hapus sekolah permanen</h2>
            <p className="danger-copy">Tindakan ini menghapus sekolah, peserta, absensi, akun pengguna, serta data operasional dan tidak dapat dibatalkan.</p>
            <label>Ketik nama sekolah <strong>{deleteTarget.name}</strong> untuk mengonfirmasi
              <input autoComplete="off" value={deleteConfirmation} onChange={(event) => setDeleteConfirmation(event.target.value)} />
            </label>
            <div className="modal-actions">
              <button className="button secondary" disabled={busy} onClick={() => { setDeleteTarget(null); setDeleteConfirmation(''); }}>Batal</button>
              <button className="button danger" disabled={busy || deleteConfirmation !== deleteTarget.name} onClick={() => void deleteSchool()}>{busy ? 'Menghapus…' : 'Hapus permanen'}</button>
            </div>
          </div>
        </div>
      )}
      {passwordResetTarget && (
        <div className="modal-backdrop" role="presentation">
          <form className="modal-card" onSubmit={(event) => void resetSchoolPassword(event)}>
            <h2>Reset kata sandi Admin</h2>
            <p className="muted">{passwordResetTarget.name}{passwordResetTarget.admin_username ? ` · ${passwordResetTarget.admin_username}` : ''}. Kata sandi lama langsung dinonaktifkan.</p>
            {error && <div className="alert error">{error}</div>}
            <label>Metode pembuatan kata sandi
              <select value={passwordResetMode} onChange={(event) => { setPasswordResetMode(event.target.value as PasswordResetMode); setError(''); }}>
                <option value="generate">Generate acak dengan simbol</option>
                <option value="custom">Tentukan sendiri</option>
              </select>
            </label>
            {passwordResetMode === 'generate'
              ? <p className="muted">Sistem membuat sandi acak 18 karakter yang selalu berisi huruf besar, angka, dan simbol.</p>
              : <>
                <label>Kata sandi baru
                  <span className="password-input-wrap">
                    <input type={showCustomAdminPassword ? 'text' : 'password'} autoComplete="new-password" required value={customAdminPassword} onChange={(event) => setCustomAdminPassword(event.target.value)} />
                    <button className="password-eye" type="button" onClick={() => setShowCustomAdminPassword((visible) => !visible)} aria-label={showCustomAdminPassword ? 'Sembunyikan kata sandi' : 'Tampilkan kata sandi'}><PasswordEye visible={showCustomAdminPassword} /></button>
                  </span>
                </label>
                <small className="password-requirements">Minimal 8 karakter, maksimal 72 byte, dengan huruf besar, angka, dan simbol.</small>
              </>}
            <div className="modal-actions">
              <button className="button secondary" type="button" disabled={busy} onClick={() => setPasswordResetTarget(null)}>Batal</button>
              <button className="button primary" disabled={busy || (passwordResetMode === 'custom' && !validAdminPassword(customAdminPassword))}>{busy ? 'Mengatur ulang…' : 'Reset kata sandi'}</button>
            </div>
          </form>
        </div>
      )}
      {resetCredentials && (
        <div className="modal-backdrop" role="presentation">
          <div className="modal-card">
            <h2>Kata sandi berhasil diatur ulang</h2>
            <p className="muted">Akun Admin {resetCredentials.schoolName}: <strong>{resetCredentials.username}</strong></p>
            <label>Kata sandi baru
              <input readOnly value={resetCredentials.temporaryPassword} onFocus={(event) => event.currentTarget.select()} />
            </label>
            <p className="danger-copy">Kata sandi lama sudah tidak berlaku. Salin dan sampaikan kata sandi ini secara aman; nilainya tidak akan ditampilkan lagi setelah ditutup.</p>
            <div className="modal-actions">
              <button className="button secondary" onClick={() => void navigator.clipboard.writeText(resetCredentials.temporaryPassword).then(() => setNotice('Kata sandi disalin ke clipboard.')).catch(() => setError('Clipboard tidak dapat diakses; pilih dan salin kata sandi secara manual.'))}>Salin kata sandi</button>
              <button className="button primary" onClick={() => setResetCredentials(null)}>Selesai</button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
