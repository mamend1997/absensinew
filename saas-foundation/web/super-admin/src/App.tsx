import { useCallback, useEffect, useState, type FormEvent } from 'react';

const TOKEN_KEY = 'saas_super_admin_token';
const API_BASE = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '');
type SubscriptionStatus = 'trial' | 'aktif' | 'suspend';

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
    throw new Error(typeof payload.error === 'string' ? payload.error : `Permintaan gagal (${response.status}).`);
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
          <p className="eyebrow">RUANG HADIR · PLATFORM</p>
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
        <div className="brand"><div className="brand-mark">RH</div><div><strong>Ruang Hadir</strong><small>Platform SaaS</small></div></div>
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
        <section className="panel create-panel">
          <div><h2>Tambah sekolah</h2><p className="muted">Kode 4 digit dibuat acak dan harus unik.</p></div>
          <form className="create-form" onSubmit={(event) => void createSchool(event)}>
            <label>Nama sekolah<input required maxLength={180} value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value, slug: current.slug || slugify(event.target.value) }))} /></label>
            <label>Slug unik<input required maxLength={100} pattern="[a-z0-9-]+" value={form.slug} onChange={(event) => setForm((current) => ({ ...current, slug: slugify(event.target.value) }))} /></label>
            <label>Status
              <select value={form.subscription_status} onChange={(event) => setForm((current) => ({ ...current, subscription_status: event.target.value as SubscriptionStatus }))}>
                <option value="trial">Uji coba</option><option value="aktif">Aktif</option><option value="suspend">Ditangguhkan</option>
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
              <thead><tr><th>Sekolah</th><th>Kode 4 digit</th><th>Status langganan</th><th>Kuota</th><th>Masa berlaku</th><th>Aksi kode</th></tr></thead>
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
                          <option value="trial">Uji coba</option><option value="aktif">Aktif</option><option value="suspend">Ditangguhkan</option>
                        </select>
                      </div>
                    </td>
                    <td><input className="quota-input" type="number" min={1} value={school.participant_quota} onChange={(event) => setSchools((current) => current.map((item) => item.id === school.id ? { ...item, participant_quota: Number(event.target.value) } : item))} /></td>
                    <td>{school.subscription_expires_at ? new Date(school.subscription_expires_at).toLocaleDateString('id-ID') : school.trial_ends_at ? `Trial s/d ${new Date(school.trial_ends_at).toLocaleDateString('id-ID')}` : '—'}</td>
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
                  </tr>
                ))}
                {!schools.length && <tr><td colSpan={6} className="empty">Belum ada sekolah.</td></tr>}
              </tbody>
            </table>
          </div>
          <p className="fine-print">Perubahan kode membatalkan login sekolah yang memakai kode lama. Sampaikan kode terbaru ke operator sekolah.</p>
        </section>
      </div>
    </main>
  );
}
