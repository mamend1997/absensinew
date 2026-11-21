import { useState, type FormEvent } from 'react';
import { api, saveToken } from '../lib/api';
import type { User } from '../types';

interface LoginResponse {
  token: string;
  user: {
    id: string;
    username: string;
    display_name: string;
    role: User['role'];
    classroom_id: string | null;
  };
}

interface LoginViewProps {
  onLogin: (user: User) => void;
}

export default function LoginView({ onLogin }: LoginViewProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      const result = await api<LoginResponse>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      });
      saveToken(result.token);
      const user: User = {
        id: result.user.id,
        username: result.user.username,
        displayName: result.user.display_name,
        role: result.user.role,
        classroomId: result.user.classroom_id,
      };
      localStorage.setItem('ruang_hadir_user', JSON.stringify(user));
      onLogin(user);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Login gagal');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-page">
      <section className="login-story">
        <div className="brand-mark">RH</div>
        <p className="eyebrow light">RUANG HADIR · SISTEM ABSENSI</p>
        <h1>Hadir lebih mudah.<br />Rekap lebih jelas.</h1>
        <p className="story-copy">
          Pemindaian cepat, antrean offline yang aman, dan ringkasan kehadiran
          untuk setiap kelas.
        </p>
        <div className="story-foot">
          <span className="story-dot" /> Data tersimpan lokal saat koneksi terputus
        </div>
      </section>
      <section className="login-panel">
        <div className="login-card">
          <div className="brand-mark compact">RH</div>
          <p className="eyebrow">SELAMAT DATANG</p>
          <h2>Masuk ke akun</h2>
          <p className="muted">Gunakan akun Admin atau Operator Anda.</p>
          <form onSubmit={submit} className="form-stack">
            <label>
              Username
              <input
                autoComplete="username"
                autoFocus
                required
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                placeholder="Masukkan username"
              />
            </label>
            <label>
              Password
              <span className="login-password-wrap">
                <input
                  autoComplete="current-password"
                  required
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="Masukkan password"
                />
                <button
                  className="login-password-toggle"
                  type="button"
                  onClick={() => setShowPassword((visible) => !visible)}
                  aria-label={showPassword ? 'Sembunyikan password' : 'Tampilkan password'}
                >
                  <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                    <path d="M2.5 12s3.2-6 9.5-6 9.5 6 9.5 6-3.2 6-9.5 6-9.5-6-9.5-6Z" />
                    <circle cx="12" cy="12" r="2.7" />
                    {!showPassword && <path d="m4 4 16 16" />}
                  </svg>
                </button>
              </span>
            </label>
            {error && <div className="notice error">{error}</div>}
            <button className="button primary wide" disabled={busy}>
              {busy ? 'Memeriksa akun…' : 'Masuk'}
            </button>
          </form>
          <a
            className="button secondary wide school-portal-link"
            href="https://saas-school-portal-production.up.railway.app"
          >
            Portal sekolah · kode sekolah &amp; daftar
          </a>
          <p className="login-help">
            Perlu koneksi internet untuk masuk pertama kali. Setelah login, data
            scanner tersimpan di perangkat.
          </p>
        </div>
      </section>
    </main>
  );
}
