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
}

interface WhatsappGatewaySettings {
  endpoint_url: string;
  is_enabled: boolean;
  is_configured: boolean;
  token_hint: string;
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
  participant_quota: number;
}

interface ResetCredentials {
  schoolName: string;
  username: string;
  temporaryPassword: string;
}

interface BillingPrices {
  monthly_price: number;
  lifetime_price: number;
  providers?: { xendit: boolean; duitku: boolean };
}

const emptyForm: SchoolForm = {
  name: '',
  slug: '',
  subscription_status: 'trial',
  participant_quota: 500,
  initial_admin: { username: '', display_name: '', password: '' },
};

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

export default function App() {
  const [token, setToken] = useState(() => sessionStorage.getItem(TOKEN_KEY) ?? '');
  const [schools, setSchools] = useState<School[]>([]);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
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
  });
  const [gatewayToken, setGatewayToken] = useState('');
  const [gatewayBusy, setGatewayBusy] = useState(false);
  const [apkDriveUrl, setApkDriveUrl] = useState('');
  const [apkBusy, setApkBusy] = useState(false);
  const [billingPrices, setBillingPrices] = useState<BillingPrices>({
    monthly_price: 50000,
    lifetime_price: 1000000,
    providers: { xendit: false, duitku: false },
  });
  const [billingBusy, setBillingBusy] = useState(false);
  const [applicationName, setApplicationName] = useState('Ruang Hadir');
  const [applicationNameBusy, setApplicationNameBusy] = useState(false);
  const [editingSchool, setEditingSchool] = useState<School | null>(null);
  const [schoolEditForm, setSchoolEditForm] = useState<SchoolEditForm>({
    name: '',
    subscription_status: 'trial',
    participant_quota: 500,
  });
  const [deleteTarget, setDeleteTarget] = useState<School | null>(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState('');
  const [resetCredentials, setResetCredentials] = useState<ResetCredentials | null>(null);

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

  useEffect(() => {
    void loadSchools();
  }, [loadSchools]);

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
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Login Super Admin gagal.');
    } finally {
      setBusy(false);
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
      participant_quota: Number(school.participant_quota),
    });
  }

  async function saveSchoolEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editingSchool) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await request(`/super-admin/schools/${editingSchool.id}`, token, {
        method: 'PATCH',
        body: {
          name: schoolEditForm.name,
          subscription_status: schoolEditForm.subscription_status,
          participant_quota: Number(schoolEditForm.participant_quota),
        },
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

  async function resetSchoolPassword(school: School) {
    if (!window.confirm(`Buat kata sandi sementara untuk akun Admin ${school.name}${school.admin_username ? ` (${school.admin_username})` : ''}? Kata sandi saat ini langsung diganti.`)) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await request<{ username: string; temporary_password: string }>(
        `/super-admin/schools/${school.id}/admin-password/reset`,
        token,
        { method: 'POST', body: {} },
      );
      setResetCredentials({
        schoolName: school.name,
        username: result.username,
        temporaryPassword: result.temporary_password,
      });
      setNotice('Kata sandi sementara berhasil dibuat. Salin dan sampaikan dengan aman.');
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

  async function clearWhatsappGateway() {
    if (!window.confirm('Hapus URL dan token gateway WhatsApp? Pendaftaran OTP akan berhenti sampai gateway diatur lagi.')) return;
    setGatewayBusy(true);
    setError('');
    setNotice('');
    try {
      await request('/super-admin/settings/whatsapp-gateway', token, { method: 'DELETE' });
      setGatewaySettings({ endpoint_url: '', is_enabled: false, is_configured: false, token_hint: '' });
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
        <form className="login-card" onSubmit={(event) => void login(event)}>
          <div className="brand-mark">RH</div>
          <p className="eyebrow">{applicationName.toLocaleUpperCase('id-ID')} · PLATFORM</p>
          <h1>Super Admin SaaS</h1>
          <p className="muted">Kelola tenant sekolah dan status langganan platform.</p>
          {error && <div className="alert error">{error}</div>}
          <label>Username<input autoComplete="username" required value={username} onChange={(event) => setUsername(event.target.value)} /></label>
          <label>Password<input type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} /></label>
          <button className="button primary" disabled={busy}>{busy ? 'Memeriksa…' : 'Masuk sebagai Super Admin'}</button>
          <small className="muted">Portal ini terpisah dari login sekolah.</small>
        </form>
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
        <section className="panel gateway-panel">
          <div>
            <h2>Gateway WhatsApp untuk OTP</h2>
            <p className="muted">Gateway harus menerima POST JSON <code>{'{ phone, message }'}</code> dengan autentikasi Bearer dan membalas status HTTP 2xx. Token dienkripsi di database dan tidak ditampilkan kembali.</p>
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
            <label className="gateway-toggle"><input type="checkbox" checked={gatewaySettings.is_enabled} onChange={(event) => setGatewaySettings((current) => ({ ...current, is_enabled: event.target.checked }))} /> Aktifkan OTP WhatsApp untuk pendaftaran</label>
            <div className="gateway-actions">
              <button className="button primary" disabled={gatewayBusy}>{gatewayBusy ? 'Menyimpan…' : 'Simpan pengaturan'}</button>
              <button className="button secondary" type="button" disabled={gatewayBusy || !gatewaySettings.is_configured} onClick={() => void clearWhatsappGateway()}>Hapus konfigurasi</button>
            </div>
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
        <section className="panel">
          <div className="section-title"><div><h2>Daftar tenant</h2><p className="muted">{schools.length} sekolah</p></div><button className="button secondary" onClick={() => void loadSchools()}>Muat ulang</button></div>
          <div className="table-scroll">
            <table>
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
                        <button className="button secondary small" disabled={busy} onClick={() => openSchoolEditor(school)}>Edit</button>
                        <button className="button secondary small" disabled={busy} onClick={() => void resetSchoolPassword(school)}>Reset password</button>
                        <button className="button danger small" disabled={busy} onClick={() => { setDeleteTarget(school); setDeleteConfirmation(''); }}>Hapus</button>
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
      </div>
      {editingSchool && (
        <div className="modal-backdrop" role="presentation">
          <form className="modal-card" onSubmit={(event) => void saveSchoolEdit(event)}>
            <h2>Edit sekolah</h2>
            <p className="muted">Perbarui nama, status langganan, dan kuota untuk {editingSchool.name}.</p>
            <label>Nama sekolah<input required maxLength={180} value={schoolEditForm.name} onChange={(event) => setSchoolEditForm((current) => ({ ...current, name: event.target.value }))} /></label>
            <label>Status langganan
              <select value={schoolEditForm.subscription_status} onChange={(event) => setSchoolEditForm((current) => ({ ...current, subscription_status: event.target.value as SubscriptionStatus }))}>
                <option value="trial">Uji coba</option><option value="aktif">Aktif</option><option value="lifetime">Lifetime</option><option value="suspend">Ditangguhkan</option>
              </select>
            </label>
            <label>Kuota peserta<input type="number" min={1} max={1000000} required value={schoolEditForm.participant_quota} onChange={(event) => setSchoolEditForm((current) => ({ ...current, participant_quota: Number(event.target.value) }))} /></label>
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
      {resetCredentials && (
        <div className="modal-backdrop" role="presentation">
          <div className="modal-card">
            <h2>Kata sandi sementara dibuat</h2>
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
