import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import AppMenu from './components/AppMenu';
import Dashboard from './components/Dashboard';
import LoginView from './components/LoginView';
import ParticipantsPanel from './components/ParticipantsPanel';
import SettingsPanel from './components/SettingsPanel';
import { api, ApiError, getToken, saveToken } from './lib/api';
import {
  getParticipants,
  getMasterSyncCursor,
  getPendingScans,
  getSettings,
  markScansSynced,
  mergeParticipantDelta,
  pendingCount,
  replaceParticipants,
  saveMasterSyncCursor,
  saveSettings,
  clearMasterSyncCursors,
} from './lib/offline';
import type { Participant, QueuedScan, Settings, User } from './types';

const ScannerPanel = lazy(() => import('./components/ScannerPanel'));

type Page = 'rekap' | 'peserta' | 'pengaturan' | 'scanner';
type ThemeMode = 'green' | 'orange' | 'white';

const THEME_STORAGE_KEY = 'ruang_hadir_theme';

function savedTheme(): ThemeMode {
  const value = localStorage.getItem(THEME_STORAGE_KEY);
  return value === 'orange' || value === 'white' ? value : 'green';
}

function defaultPage(role: User['role']): Page {
  return role === 'admin' && window.matchMedia('(min-width: 900px)').matches
    ? 'rekap'
    : 'scanner';
}

function cachedUser(): User | null {
  const raw = localStorage.getItem('ruang_hadir_user');
  if (!raw) return null;
  try {
    return JSON.parse(raw) as User;
  } catch (error) {
    console.error('Cache akun lokal tidak dapat dibaca', error);
    localStorage.removeItem('ruang_hadir_user');
    return null;
  }
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [restoring, setRestoring] = useState(true);
  const [page, setPage] = useState<Page>('scanner');
  const [theme, setTheme] = useState<ThemeMode>(savedTheme);
  const [menuOpen, setMenuOpen] = useState(false);
  const [manualAttendanceRequested, setManualAttendanceRequested] = useState(false);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [pending, setPending] = useState(0);
  const [online, setOnline] = useState(navigator.onLine);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [syncBusy, setSyncBusy] = useState(false);
  const syncLock = useRef(false);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  const showToast = useCallback((message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
    window.setTimeout(() => setToast(null), 4200);
  }, []);

  const refreshQueue = useCallback(async () => {
    setPending(await pendingCount());
  }, []);

  const refreshMasterData = useCallback(async () => {
    if (!getToken()) return;
    const localParticipants = await getParticipants();
    const localSettings = getSettings();
    const participantCursor = localParticipants.length
      ? getMasterSyncCursor('participants')
      : null;
    const settingsCursor = localSettings
      ? getMasterSyncCursor('settings')
      : null;
    const participantPath = participantCursor
      ? `/peserta?updated_since=${encodeURIComponent(participantCursor)}`
      : '/peserta';
    const settingsPath = settingsCursor
      ? `/pengaturan?updated_since=${encodeURIComponent(settingsCursor)}`
      : '/pengaturan';
    const [participantResult, settingResult] = await Promise.all([
      api<{
        participants: Participant[];
        removed_ids?: string[];
        sync_cursor: string;
      }>(participantPath),
      api<{
        settings: Settings | null;
        unchanged?: boolean;
        sync_cursor: string;
      }>(settingsPath),
    ]);
    const normalizedParticipants = participantResult.participants.map((participant) => ({
      ...participant,
      id: String(participant.id),
      classroom_id: String(participant.classroom_id),
      unit_id: String(participant.unit_id),
    }));
    if (participantCursor) {
      await mergeParticipantDelta(
        normalizedParticipants,
        participantResult.removed_ids ?? [],
      );
      setParticipants((current) => {
        const merged = new Map(current.map((participant) => [participant.id, participant]));
        for (const participant of normalizedParticipants) {
          if (participant.is_active === true || participant.is_active === 1) {
            merged.set(participant.id, participant);
          } else {
            merged.delete(participant.id);
          }
        }
        for (const id of participantResult.removed_ids ?? []) merged.delete(id);
        return [...merged.values()];
      });
    } else {
      await replaceParticipants(normalizedParticipants);
      setParticipants(normalizedParticipants.filter((participant) =>
        participant.is_active === true || participant.is_active === 1,
      ));
    }
    if (settingResult.settings) {
      await saveSettings(settingResult.settings);
      setSettings(settingResult.settings);
    }
    saveMasterSyncCursor('participants', participantResult.sync_cursor);
    saveMasterSyncCursor('settings', settingResult.sync_cursor);
  }, []);

  const syncNow = useCallback(async () => {
    if (syncLock.current || !getToken()) return;
    if (!navigator.onLine) {
      showToast('Tidak ada koneksi. Catatan tetap tersimpan lokal.', 'error');
      return;
    }
    syncLock.current = true;
    setSyncBusy(true);
    try {
      const records = (await getPendingScans()).sort((left, right) =>
        left.client_timestamp.localeCompare(right.client_timestamp),
      );
      let acceptedCount = 0;
      const rejected: Array<{ id_unik: string; reason: string }> = [];
      for (let offset = 0; offset < records.length; offset += 100) {
        const batch = records.slice(offset, offset + 100);
        const payload = batch.map((scan: QueuedScan) => ({
          id_unik: scan.id_unik,
          id_peserta: scan.id_peserta,
          jenis_absen: scan.jenis_absen,
          client_timestamp: scan.client_timestamp,
          status_kehadiran: scan.status_kehadiran,
          menit_terlambat: scan.menit_terlambat,
          scan_method: scan.scan_method ?? 'SCAN_QR',
        }));
        const result = await api<{
          accepted_ids: string[];
          rejected: Array<{ id_unik: string; reason: string }>;
        }>('/absensi/sync-batch', {
          method: 'POST',
          body: JSON.stringify({ records: payload }),
        });
        await markScansSynced(result.accepted_ids);
        acceptedCount += result.accepted_ids.length;
        rejected.push(...result.rejected);
      }

      await refreshQueue();
      if (rejected.length) {
        const firstReason = rejected[0].reason === 'non_working_day'
          ? 'Hari tersebut ditetapkan sebagai hari libur.'
          : rejected[0].reason;
        showToast(
          `${acceptedCount} catatan tersinkron; ${rejected.length} ditolak dan tetap pending. ${firstReason}`,
          'error',
        );
      } else if (acceptedCount) {
        showToast(`${acceptedCount} catatan berhasil disinkronkan.`);
      }
    } catch (error) {
      await refreshQueue();
      showToast(
        error instanceof ApiError && error.status === 401
          ? 'Sesi berakhir. Login kembali saat koneksi tersedia.'
          : error instanceof Error
            ? `Sinkronisasi gagal: ${error.message}`
            : 'Sinkronisasi gagal. Catatan tetap pending.',
        'error',
      );
    } finally {
      syncLock.current = false;
      setSyncBusy(false);
    }
  }, [refreshQueue, showToast]);

  useEffect(() => {
    let active = true;
    async function restore() {
      const token = getToken();
      const userCache = cachedUser();
      try {
        const [localParticipants, localSettings] = await Promise.all([
          getParticipants(),
          Promise.resolve(getSettings()),
        ]);
        if (active) {
          setParticipants(localParticipants);
          setSettings(localSettings);
          await refreshQueue();
        }
      } catch (error) {
        console.error('Tidak dapat membaca cache scanner', error);
      }

      if (!token || !userCache) {
        if (active) setRestoring(false);
        return;
      }
      if (active) {
        setUser(userCache);
        setPage(defaultPage(userCache.role));
        setRestoring(false);
      }
      try {
        const result = await api<{ user: {
          id: string;
          username: string;
          displayName?: string;
          display_name?: string;
          role: User['role'];
          classroomId?: string | null;
          classroom_id?: string | null;
        } }>('/auth/me');
        const authenticatedUser: User = {
          id: result.user.id,
          username: result.user.username,
          displayName: result.user.displayName ?? result.user.display_name ?? result.user.username,
          role: result.user.role,
          classroomId: result.user.classroomId ?? result.user.classroom_id ?? null,
        };
        if (active) {
          setUser(authenticatedUser);
          setPage(defaultPage(authenticatedUser.role));
          localStorage.setItem('ruang_hadir_user', JSON.stringify(authenticatedUser));
        }
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          saveToken(null);
          clearMasterSyncCursors();
          localStorage.removeItem('ruang_hadir_user');
          if (active) setUser(null);
        }
      }
    }
    void restore();
    return () => { active = false; };
  }, [refreshQueue]);

  useEffect(() => {
    if (!user) return;
    let active = true;
    const handleOnline = () => {
      setOnline(true);
      void refreshMasterData().catch((error: unknown) => {
          if (active) showToast(
            error instanceof Error ? `Server belum dapat dijangkau: ${error.message}` : 'Server belum dapat dijangkau.',
            'error',
          );
        });
      void syncNow();
    };
    const handleOffline = () => setOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    if (navigator.onLine) {
      void refreshMasterData().catch((error: unknown) => {
          if (active) {
            showToast(
              error instanceof Error
                ? `Server tidak dapat dijangkau; memakai cache lokal. ${error.message}`
                : 'Server tidak dapat dijangkau; memakai cache lokal.',
              'error',
            );
          }
        });
      void syncNow();
    }
    return () => {
      active = false;
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [refreshMasterData, showToast, syncNow, user]);

  function onLogin(authenticatedUser: User) {
    setUser(authenticatedUser);
    setPage(defaultPage(authenticatedUser.role));
    void refreshMasterData().catch((error: unknown) => {
      showToast(
        error instanceof Error
          ? `Mode offline aktif; data yang tersedia berasal dari cache. ${error.message}`
          : 'Mode offline aktif; memakai cache lokal.',
        'error',
      );
    }).then(() => syncNow());
  }

  function logout() {
    setMenuOpen(false);
    saveToken(null);
    clearMasterSyncCursors();
    localStorage.removeItem('ruang_hadir_user');
    setUser(null);
    setPage('scanner');
  }

  const openMenu = useCallback(() => setMenuOpen(true), []);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  const selectMenuPage = useCallback((selectedPage: string) => {
    if (selectedPage === 'manual') {
      setPage('scanner');
      setManualAttendanceRequested(true);
    } else if (
      selectedPage === 'scanner' ||
      (user?.role === 'admin' &&
        (selectedPage === 'rekap' || selectedPage === 'peserta' || selectedPage === 'pengaturan'))
    ) {
      setPage(selectedPage);
    }
    setMenuOpen(false);
  }, [user]);

  if (restoring) {
    return <main className="restore-screen"><div className="brand-mark">RH</div><span>Memulihkan data perangkat…</span></main>;
  }
  if (!user || !getToken()) return <LoginView onLogin={onLogin} />;

  const navItems: Array<{ id: string; label: string; adminOnly?: boolean }> = [
    { id: 'scanner', label: 'Scanner' },
    { id: 'manual', label: 'Absen manual' },
    { id: 'rekap', label: 'Rekap absensi', adminOnly: true },
    { id: 'peserta', label: 'Peserta', adminOnly: true },
    { id: 'pengaturan', label: 'Pengaturan', adminOnly: true },
  ];

  return (
    <div className={`app-root ${user.role === 'operator' ? 'operator-app' : ''} ${page === 'scanner' ? 'scan-mode-app' : ''}`}>
      <main className="main-area">
        {page !== 'scanner' && (
          <button className="app-menu-trigger" aria-label="Buka menu" onClick={openMenu}>
            <span className="hamburger-icon" aria-hidden="true"><i /><i /><i /></span>
          </button>
        )}
        {page === 'rekap' && user.role === 'admin' && (
          <Dashboard participants={participants} timeZone={settings?.timezone ?? 'Asia/Jakarta'} />
        )}
        {page === 'scanner' && (
          <Suspense fallback={<div className="page-content muted">Memuat scanner…</div>}>
            <ScannerPanel
              participants={participants}
              settings={settings}
              online={online}
              pending={pending}
              onSync={syncNow}
              onQueueChanged={refreshQueue}
              onMenu={openMenu}
              manualRequested={manualAttendanceRequested}
              onManualRequestHandled={() => setManualAttendanceRequested(false)}
            />
          </Suspense>
        )}
        {page === 'peserta' && user.role === 'admin' && (
          <ParticipantsPanel
            participants={participants}
            onRefresh={refreshMasterData}
            showToast={showToast}
          />
        )}
        {page === 'pengaturan' && user.role === 'admin' && (
          <SettingsPanel
            participants={participants}
            settings={settings}
            onSave={(value) => {
              setSettings(value);
              void saveSettings(value);
            }}
            showToast={showToast}
          />
        )}
      </main>
      <AppMenu
        open={menuOpen}
        role={user.role}
        theme={theme}
        pages={navItems.filter((item) => !item.adminOnly || user.role === 'admin')}
        onThemeChange={setTheme}
        onSelect={selectMenuPage}
        onLogout={logout}
        onClose={closeMenu}
      />
      {toast && <div className={`toast ${toast.type}`} role="status">{toast.message}</div>}
      {syncBusy && <div className="sync-indicator">Menyinkronkan antrean…</div>}
    </div>
  );
}
