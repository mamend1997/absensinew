import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../lib/api';
import type { Role } from '../types';

interface MenuEntry {
  id: string;
  label: string;
}

interface AppMenuProps {
  open: boolean;
  role: Role;
  theme: 'green' | 'orange' | 'white';
  pages: MenuEntry[];
  onSelect: (page: string) => void;
  onThemeChange: (theme: 'green' | 'orange' | 'white') => void;
  onLogout: () => void;
  onClose: () => void;
}

type MenuStage = 'closed' | 'loading' | 'setup' | 'verify' | 'items' | 'missing' | 'error';

const themes = [
  { id: 'orange', label: 'Oranye' },
  { id: 'green', label: 'Hijau' },
  { id: 'white', label: 'Putih' },
] as const;

export default function AppMenu({
  open,
  role,
  theme,
  pages,
  onSelect,
  onThemeChange,
  onLogout,
  onClose,
}: AppMenuProps) {
  const [stage, setStage] = useState<MenuStage>('closed');
  const [pin, setPin] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState(false);

  useEffect(() => {
    if (!open) {
      setStage('closed');
      setPin('');
      setConfirmation('');
      setErrorMessage('');
      setConfirmLogout(false);
      return;
    }

    let active = true;
    setStage('loading');
    setErrorMessage('');
    void api<{ configured: boolean }>('/auth/menu-pin/status')
      .then(({ configured }) => {
        if (active) setStage(configured ? 'verify' : role === 'admin' ? 'setup' : 'missing');
      })
      .catch((error: unknown) => {
        if (active) {
          setErrorMessage(error instanceof Error ? error.message : 'Status PIN tidak dapat diperiksa.');
          setStage('error');
        }
      });

    return () => { active = false; };
  }, [open, role]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (confirmLogout) setConfirmLogout(false);
        else onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [confirmLogout, onClose, open]);

  async function submitPin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorMessage('');
    if (pin.length !== 4) {
      setErrorMessage('PIN harus terdiri dari 4 angka.');
      return;
    }
    if (stage === 'setup' && pin !== confirmation) {
      setErrorMessage('Konfirmasi PIN belum cocok.');
      return;
    }

    setBusy(true);
    try {
      if (stage === 'setup') {
        await api('/auth/menu-pin/setup', {
          method: 'POST',
          body: JSON.stringify({ pin }),
        });
      } else {
        await api('/auth/menu-pin/verify', {
          method: 'POST',
          body: JSON.stringify({ pin }),
        });
      }
      setPin('');
      setConfirmation('');
      setStage('items');
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'PIN tidak dapat diproses.');
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;

  return (
    <div className="menu-gate-overlay" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="menu-gate-card" role="dialog" aria-modal="true" aria-labelledby="menu-gate-title">
        <button className="menu-gate-close" aria-label="Tutup menu" onClick={onClose}>×</button>
        <p className="menu-gate-eyebrow">RUANG HADIR</p>
        <h2 id="menu-gate-title">
          {stage === 'setup' ? 'Atur PIN menu' : stage === 'items' ? 'Menu aplikasi' : 'Masukkan PIN'}
        </h2>
        <div className="theme-picker">
          <p>Tema tampilan</p>
          <div className="theme-options" role="group" aria-label="Pilih tema tampilan">
            {themes.map((option) => (
              <button
                key={option.id}
                className={`theme-option ${theme === option.id ? 'selected' : ''}`}
                aria-pressed={theme === option.id}
                onClick={() => onThemeChange(option.id)}
              >
                <span className={`theme-swatch theme-swatch-${option.id}`} aria-hidden="true" />
                {option.label}
              </button>
            ))}
          </div>
        </div>
        {stage === 'loading' && <p className="menu-gate-help">Memeriksa pengaturan PIN…</p>}
        {(stage === 'setup' || stage === 'verify') && (
          <form className="menu-pin-form" onSubmit={(event) => void submitPin(event)}>
            <p className="menu-gate-help">
              {stage === 'setup'
                ? 'Buat PIN 4 angka untuk membuka menu. PIN disimpan dalam bentuk hash di server.'
                : 'Masukkan PIN 4 angka untuk membuka menu.'}
            </p>
            <label>
              {stage === 'setup' ? 'PIN baru' : 'PIN menu'}
              <input
                autoFocus
                autoComplete="one-time-code"
                inputMode="numeric"
                maxLength={4}
                pattern="[0-9]{4}"
                required
                type="password"
                value={pin}
                onChange={(event) => setPin(event.target.value.replace(/\D/g, '').slice(0, 4))}
              />
            </label>
            {stage === 'setup' && (
              <label>
                Ulangi PIN
                <input
                  autoComplete="new-password"
                  inputMode="numeric"
                  maxLength={4}
                  pattern="[0-9]{4}"
                  required
                  type="password"
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value.replace(/\D/g, '').slice(0, 4))}
                />
              </label>
            )}
            {errorMessage && <p className="menu-gate-error" role="alert">{errorMessage}</p>}
            <button className="button primary wide" disabled={busy || pin.length !== 4 || (stage === 'setup' && confirmation.length !== 4)}>
              {busy ? 'Memeriksa…' : stage === 'setup' ? 'Simpan PIN' : 'Buka menu'}
            </button>
          </form>
        )}
        {stage === 'missing' && (
          <>
            <p className="menu-gate-help">PIN menu belum disiapkan. Minta Admin untuk mengaturnya terlebih dahulu.</p>
            <button className="button secondary wide" onClick={onClose}>Kembali ke scanner</button>
          </>
        )}
        {stage === 'error' && (
          <>
            <p className="menu-gate-error" role="alert">{errorMessage}</p>
            <button className="button secondary wide" onClick={onClose}>Tutup</button>
          </>
        )}
        {stage === 'items' && !confirmLogout && (
          <nav className="menu-gate-items" aria-label="Menu aplikasi">
            {pages.map((page) => (
              <button key={page.id} onClick={() => onSelect(page.id)}>{page.label}</button>
            ))}
            <button className="menu-gate-logout" onClick={() => setConfirmLogout(true)}>
              Keluar
            </button>
          </nav>
        )}
        {stage === 'items' && confirmLogout && (
          <section className="menu-logout-confirm" role="alertdialog" aria-modal="true" aria-labelledby="logout-confirm-title">
            <h3 id="logout-confirm-title">Keluar dari akun?</h3>
            <p>Sesi akun ini akan diakhiri pada perangkat ini.</p>
            <div className="menu-logout-actions">
              <button className="button secondary" onClick={() => setConfirmLogout(false)}>Batal</button>
              <button className="button danger-button" onClick={onLogout}>Keluar</button>
            </div>
          </section>
        )}
      </section>
    </div>
  );
}
