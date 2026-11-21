import { useEffect } from 'react';

const SCHOOL_PORTAL_URL = import.meta.env.VITE_SCHOOL_PORTAL_URL ||
  'https://saas-school-portal-production.up.railway.app';

export default function LoginView() {
  useEffect(() => {
    window.location.replace(SCHOOL_PORTAL_URL);
  }, []);

  return (
    <main className="login-page">
      <section className="login-story">
        <div className="brand-mark">RH</div>
        <p className="eyebrow light">RUANG HADIR · PORTAL SEKOLAH</p>
        <h1>Masuk dengan kode sekolah.</h1>
        <p className="story-copy">
          Login sekolah sekarang menggunakan kode sekolah 4 digit agar akun
          terhubung ke tenant yang benar.
        </p>
      </section>
      <section className="login-panel">
        <div className="login-card">
          <div className="brand-mark compact">RH</div>
          <p className="eyebrow">PORTAL SEKOLAH</p>
          <h2>Mengarahkan ke login sekolah</h2>
          <p className="muted">Gunakan halaman login yang meminta kode sekolah 4 digit.</p>
          <a className="button primary wide" href={SCHOOL_PORTAL_URL}>
            Buka login dengan kode sekolah
          </a>
        </div>
      </section>
    </main>
  );
}
