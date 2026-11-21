import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { api, apiUrl, getToken } from '../lib/api';

interface ActivityLog {
  id: string | number;
  actor_username: string;
  actor_display_name: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  before_data: unknown;
  after_data: unknown;
  ip_address: string | null;
  created_at: string;
}

interface ActivityResponse {
  logs: ActivityLog[];
  page: number;
  page_size: number;
  total: number;
}

interface BackupSchedule {
  enabled: boolean;
  backup_time: string;
  bot_configured: boolean;
  chat_id_hint: string;
  last_status: 'never' | 'running' | 'success' | 'failed' | 'notification_failed';
  last_run_at: string | null;
  last_error: string | null;
}

interface AdminToolsPanelProps {
  showToast: (message: string, type?: 'success' | 'error') => void;
  onRestored: () => void;
}

const RESTORE_CONFIRMATION = 'PULIHKAN DATABASE';
const BACKUP_MAX_BYTES = 25 * 1024 * 1024;

function displayDate(value: string): string {
  const date = new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString('id-ID');
}

function jsonLabel(value: unknown): string {
  if (value == null) return '—';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export default function AdminToolsPanel({ showToast, onRestored }: AdminToolsPanelProps) {
  const [activity, setActivity] = useState<ActivityResponse | null>(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [backupFile, setBackupFile] = useState<File | null>(null);
  const [confirmation, setConfirmation] = useState('');
  const [backupSchedule, setBackupSchedule] = useState<BackupSchedule | null>(null);
  const [backupEnabled, setBackupEnabled] = useState(false);
  const [backupTime, setBackupTime] = useState('02:00');
  const [botToken, setBotToken] = useState('');
  const [chatId, setChatId] = useState('');
  const [backupSettingsBusy, setBackupSettingsBusy] = useState(false);
  const [backupSettingsError, setBackupSettingsError] = useState('');
  const uploadRef = useRef<HTMLInputElement>(null);

  const refreshActivity = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await api<ActivityResponse>(
        `/admin-tools/activity-logs?page=${page}&page_size=50`,
      );
      setActivity(result);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Log aktivitas gagal dimuat.');
    } finally {
      setLoading(false);
    }
  }, [page]);

  useEffect(() => {
    void refreshActivity();
  }, [refreshActivity]);

  const refreshBackupSchedule = useCallback(async () => {
    try {
      const result = await api<BackupSchedule>('/admin-tools/backup/schedule');
      setBackupSchedule(result);
      setBackupEnabled(result.enabled);
      setBackupTime(result.backup_time);
      setBackupSettingsError('');
    } catch (reason) {
      setBackupSettingsError(reason instanceof Error ? reason.message : 'Pengaturan backup gagal dimuat.');
    }
  }, []);

  useEffect(() => {
    void refreshBackupSchedule();
  }, [refreshBackupSchedule]);

  async function downloadBackup() {
    setBusy(true);
    try {
      const backup = await api<Record<string, unknown>>('/admin-tools/backup');
      const blob = new Blob([JSON.stringify(backup, null, 2)], {
        type: 'application/json;charset=utf-8',
      });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `ruang-hadir-backup-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(link.href);
      showToast('File backup database berhasil diunduh.');
      await refreshActivity();
    } catch (reason) {
      showToast(reason instanceof Error ? reason.message : 'Backup database gagal dibuat.', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function downloadScheduledBackup() {
    setBusy(true);
    try {
      const response = await fetch(`${apiUrl()}/admin-tools/backup/scheduled/latest`, {
        headers: { authorization: `Bearer ${getToken() ?? ''}` },
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
      const blob = await response.blob();
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = 'ruang-hadir-backup-encrypted.json.enc';
      link.click();
      URL.revokeObjectURL(link.href);
      showToast('Backup otomatis terenkripsi berhasil diunduh.');
    } catch (reason) {
      showToast(reason instanceof Error ? reason.message : 'Unduhan backup otomatis gagal.', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function restoreBackup() {
    if (!backupFile || confirmation !== RESTORE_CONFIRMATION) return;
    if (backupFile.size > BACKUP_MAX_BYTES) {
      showToast('File backup melebihi batas 25 MB.', 'error');
      return;
    }
    if (!window.confirm(
      'Pemulihan akan mengganti seluruh data database saat ini dengan isi file backup. Lanjutkan?',
    )) return;

    setBusy(true);
    try {
      const backup = JSON.parse(await backupFile.text()) as unknown;
      const result = await api<{
        restored: boolean;
        backup_created_at: string | null;
      }>('/admin-tools/backup/restore', {
        method: 'POST',
        body: JSON.stringify(backup),
      });
      setBackupFile(null);
      setConfirmation('');
      if (uploadRef.current) uploadRef.current.value = '';
      showToast(
        `Database berhasil dipulihkan${result.backup_created_at
          ? ` dari backup ${displayDate(result.backup_created_at)}`
          : ''}. Silakan masuk kembali untuk memuat ulang data.`,
      );
      await refreshActivity();
      onRestored();
    } catch (reason) {
      showToast(reason instanceof Error ? reason.message : 'Pemulihan database gagal.', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function saveBackupSchedule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBackupSettingsBusy(true);
    setBackupSettingsError('');
    try {
      const result = await api<BackupSchedule>('/admin-tools/backup/schedule', {
        method: 'PUT',
        body: JSON.stringify({
          enabled: backupEnabled,
          backup_time: backupTime,
          bot_token: botToken,
          chat_id: chatId,
        }),
      });
      setBackupSchedule(result);
      setBotToken('');
      setChatId('');
      showToast('Pengaturan backup harian berhasil disimpan.');
    } catch (reason) {
      setBackupSettingsError(reason instanceof Error ? reason.message : 'Pengaturan backup gagal disimpan.');
    } finally {
      setBackupSettingsBusy(false);
    }
  }

  return (
    <section className="page-content admin-tools-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">ADMINISTRASI</p>
          <h1>Audit &amp; Backup</h1>
          <p className="muted">Lacak perubahan data dan simpan cadangan database.</p>
        </div>
        <button className="button secondary no-print" onClick={() => void refreshActivity()} disabled={loading}>
          {loading ? 'Memuat…' : 'Muat ulang log'}
        </button>
      </div>

      <section className="panel-card admin-backup-card">
        <div>
          <p className="eyebrow">CADANGAN DATABASE</p>
          <h2>Backup dan restore</h2>
          <p className="muted">
            Backup berisi master, pengaturan, akun, riwayat absensi, notifikasi, dan log audit.
            File JSON hanya dapat diunduh oleh Admin dan memuat hash kredensial untuk pemulihan akun.
            Simpan file dengan aman.
          </p>
        </div>
        <div className="admin-backup-actions no-print">
          <button className="button primary" disabled={busy} onClick={() => void downloadBackup()}>
            {busy ? 'Memproses…' : 'Unduh backup JSON'}
          </button>
          <label className="admin-backup-upload">
            Pilih file backup
            <input
              ref={uploadRef}
              type="file"
              accept=".json,application/json"
              disabled={busy}
              onChange={(event) => {
                setBackupFile(event.target.files?.[0] ?? null);
                setConfirmation('');
              }}
            />
          </label>
          {backupFile && (
            <div className="admin-restore-confirm">
              <p>{backupFile.name} · {(backupFile.size / 1024 / 1024).toFixed(2)} MB</p>
              <p className="notice error">
                Restore mengganti seluruh database aktif. Pastikan Anda mengunduh backup terbaru
                sebelum melanjutkan. Maksimal ukuran file 25 MB.
              </p>
              <label>
                Ketik <strong>{RESTORE_CONFIRMATION}</strong> untuk mengonfirmasi
                <input
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                  autoComplete="off"
                  disabled={busy}
                />
              </label>
              <button
                className="button danger-button"
                disabled={busy || confirmation !== RESTORE_CONFIRMATION}
                onClick={() => void restoreBackup()}
              >
                {busy ? 'Memulihkan…' : 'Pulihkan database'}
              </button>
            </div>
          )}
        </div>
      </section>

      <form className="panel-card backup-schedule-card" onSubmit={(event) => void saveBackupSchedule(event)}>
        <div>
          <p className="eyebrow">BACKUP OTOMATIS</p>
          <h2>Jadwal harian &amp; notifikasi Telegram</h2>
          <p className="muted">
            Backup disimpan terenkripsi di volume privat server. Telegram hanya menerima status,
            bukan file atau data peserta. Waktu mengikuti zona waktu aplikasi.
          </p>
        </div>
        <div className="backup-schedule-fields">
          <label className="backup-enable">
            <input type="checkbox" checked={backupEnabled} onChange={(event) => setBackupEnabled(event.target.checked)} />
            Aktifkan backup harian
          </label>
          <label>Waktu backup<input type="time" required value={backupTime} onChange={(event) => setBackupTime(event.target.value)} /></label>
          <label>Token Telegram Bot<input type="password" autoComplete="new-password" value={botToken} onChange={(event) => setBotToken(event.target.value)} placeholder={backupSchedule?.bot_configured ? 'Tersimpan terenkripsi; kosongkan untuk mempertahankan' : 'Token dari BotFather'} /></label>
          <label>Chat ID / channel<input value={chatId} onChange={(event) => setChatId(event.target.value)} placeholder={backupSchedule?.chat_id_hint || 'Chat ID tujuan notifikasi'} /></label>
          {backupSchedule && <p className="muted backup-status">
            Status: <strong>{backupSchedule.last_status}</strong>
            {backupSchedule.last_run_at ? ` · terakhir ${displayDate(backupSchedule.last_run_at)}` : ''}
            {backupSchedule.last_error ? ` · ${backupSchedule.last_error}` : ''}
          </p>}
          {backupSchedule && ['success', 'notification_failed'].includes(backupSchedule.last_status) && (
            <button type="button" className="button secondary" disabled={busy} onClick={() => void downloadScheduledBackup()}>
              Unduh backup otomatis terenkripsi
            </button>
          )}
          {backupSettingsError && <p className="notice error">{backupSettingsError}</p>}
          <button className="button primary" disabled={backupSettingsBusy}>
            {backupSettingsBusy ? 'Menyimpan…' : 'Simpan jadwal backup'}
          </button>
        </div>
      </form>

      <section className="table-card activity-log-card">
        <div className="table-heading">
          <div>
            <h2>Riwayat aktivitas</h2>
            <p className="muted">
              {activity ? `${activity.total} aktivitas tercatat` : 'Log perubahan oleh akun Admin/Operator'}
            </p>
          </div>
        </div>
        {error && <div className="notice error activity-log-error">{error}</div>}
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Waktu</th><th>Akun</th><th>Aktivitas</th><th>Data</th><th>Perubahan</th><th>IP</th>
              </tr>
            </thead>
            <tbody>
              {(activity?.logs ?? []).map((log) => (
                <tr key={log.id}>
                  <td>{displayDate(log.created_at)}</td>
                  <td><strong>{log.actor_display_name}</strong><small>{log.actor_username}</small></td>
                  <td>{log.action}</td>
                  <td>{log.entity_type}{log.entity_id ? ` · ${log.entity_id}` : ''}</td>
                  <td className="activity-change">
                    {log.before_data != null && <small>Sebelum: {jsonLabel(log.before_data)}</small>}
                    {log.after_data != null && <small>Sesudah: {jsonLabel(log.after_data)}</small>}
                    {log.before_data == null && log.after_data == null && '—'}
                  </td>
                  <td>{log.ip_address ?? '—'}</td>
                </tr>
              ))}
              {!activity?.logs.length && !loading && (
                <tr><td className="empty-row" colSpan={6}>Belum ada aktivitas tercatat.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        {activity && activity.total > activity.page_size && (
          <div className="pagination no-print">
            <span>Halaman {activity.page} dari {Math.ceil(activity.total / activity.page_size)}</span>
            <div className="heading-actions">
              <button className="button secondary small" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                Sebelumnya
              </button>
              <button
                className="button secondary small"
                disabled={page >= Math.ceil(activity.total / activity.page_size)}
                onClick={() => setPage(page + 1)}
              >
                Berikutnya
              </button>
            </div>
          </div>
        )}
      </section>
    </section>
  );
}
