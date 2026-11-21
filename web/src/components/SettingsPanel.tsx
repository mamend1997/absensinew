import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../lib/api';
import type {
  Participant,
  Settings,
  WeeklySchedule,
} from '../types';

interface SettingsPanelProps {
  participants: Participant[];
  settings: Settings | null;
  onSave: (settings: Settings) => void;
  showToast: (message: string, type?: 'success' | 'error') => void;
}

const weekdays = [
  'Minggu',
  'Senin',
  'Selasa',
  'Rabu',
  'Kamis',
  'Jumat',
  'Sabtu',
];

interface ParticipantOverrideDraft {
  participant_id: string;
  weekday: number;
  check_in_deadline: string;
}

interface WhatsappGatewaySettings {
  endpoint_url: string;
  is_enabled: boolean;
  is_configured: boolean;
  token_hint: string;
}

export default function SettingsPanel({
  participants,
  settings,
  onSave,
  showToast,
}: SettingsPanelProps) {
  const [form, setForm] = useState({
    timezone: 'Asia/Jakarta',
    check_in_deadline: '08:00',
    lateness_tolerance_minutes: 0,
    check_out_start: '15:00',
    scan_welcome_message: 'Selamat datang - mohon tertib saat melakukan absensi',
    scan_success_message: 'Terima kasih, {name}. Absensi {status} sudah dicatat.',
    scan_failure_message: 'Maaf, absensi {name} gagal. {reason}.',
    enable_external_scanner: true,
  });
  const [weeklySchedules, setWeeklySchedules] = useState<WeeklySchedule[]>([]);
  const [participantOverrides, setParticipantOverrides] = useState<ParticipantOverrideDraft[]>([]);
  const [busy, setBusy] = useState(false);
  const [pinForm, setPinForm] = useState({ current_pin: '', new_pin: '' });
  const [pinBusy, setPinBusy] = useState(false);
  const [whatsappSettings, setWhatsappSettings] = useState<WhatsappGatewaySettings>({
    endpoint_url: '',
    is_enabled: false,
    is_configured: false,
    token_hint: '',
  });
  const [whatsappToken, setWhatsappToken] = useState('');
  const [whatsappBusy, setWhatsappBusy] = useState(false);

  useEffect(() => {
    void api<{ settings: WhatsappGatewaySettings }>('/pengaturan/whatsapp-gateway')
      .then((result) => setWhatsappSettings(result.settings))
      .catch((error: unknown) =>
        showToast(error instanceof Error ? error.message : 'Pengaturan WhatsApp gagal dimuat.', 'error'));
  }, [showToast]);

  useEffect(() => {
    if (!settings) return;
    setForm({
      timezone: settings.timezone,
      check_in_deadline: settings.check_in_deadline.slice(0, 5),
      lateness_tolerance_minutes: Number(settings.lateness_tolerance_minutes),
      check_out_start: settings.check_out_start.slice(0, 5),
      scan_welcome_message: settings.scan_welcome_message ??
        'Selamat datang - mohon tertib saat melakukan absensi',
      scan_success_message: settings.scan_success_message,
      scan_failure_message: settings.scan_failure_message,
      enable_external_scanner: settings.enable_external_scanner == null
        ? true
        : Boolean(Number(settings.enable_external_scanner)),
    });
    setWeeklySchedules(settings.weekly_schedules?.map((schedule) => ({
      ...schedule,
      weekday: Number(schedule.weekday),
      is_working_day: schedule.is_working_day == null
        ? Number(schedule.weekday) >= 1 && Number(schedule.weekday) <= 5
        : Boolean(schedule.is_working_day),
      check_in_deadline: schedule.check_in_deadline.slice(0, 5),
      lateness_tolerance_minutes: Number(schedule.lateness_tolerance_minutes),
      check_out_start: schedule.check_out_start.slice(0, 5),
    })) ?? weekdays.map((_day, weekday) => ({
      weekday,
      is_working_day: weekday >= 1 && weekday <= 5,
      check_in_deadline: settings.check_in_deadline.slice(0, 5),
      lateness_tolerance_minutes: Number(settings.lateness_tolerance_minutes),
      check_out_start: settings.check_out_start.slice(0, 5),
    })));
    setParticipantOverrides((settings.participant_overrides ?? []).map((rule) => ({
      participant_id: String(rule.participant_id),
      weekday: Number(rule.weekday),
      check_in_deadline: rule.check_in_deadline.slice(0, 5),
    })));
  }, [settings]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await api<{ settings: Settings }>('/pengaturan', {
        method: 'PUT',
        body: JSON.stringify({
          ...form,
          weekly_schedules: weeklySchedules,
          participant_overrides: participantOverrides
            .filter((rule) => rule.participant_id)
            .map((rule) => ({
              ...rule,
              participant_id: Number(rule.participant_id),
            })),
        }),
      });
      onSave(result.settings);
      showToast('Pengaturan berhasil diperbarui.');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Pengaturan gagal disimpan.', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function changeMenuPin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPinBusy(true);
    try {
      await api('/auth/menu-pin/change', {
        method: 'PUT',
        body: JSON.stringify(pinForm),
      });
      setPinForm({ current_pin: '', new_pin: '' });
      showToast('PIN menu berhasil diganti.');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'PIN menu gagal diganti.', 'error');
    } finally {
      setPinBusy(false);
    }
  }

  async function saveWhatsappGateway(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setWhatsappBusy(true);
    try {
      await api('/pengaturan/whatsapp-gateway', {
        method: 'PUT',
        body: JSON.stringify({
          endpoint_url: whatsappSettings.endpoint_url,
          is_enabled: whatsappSettings.is_enabled,
          token: whatsappToken,
        }),
      });
      setWhatsappToken('');
      const result = await api<{ settings: WhatsappGatewaySettings }>('/pengaturan/whatsapp-gateway');
      setWhatsappSettings(result.settings);
      showToast('Pengaturan WhatsApp berhasil disimpan.');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Pengaturan WhatsApp gagal disimpan.', 'error');
    } finally {
      setWhatsappBusy(false);
    }
  }

  async function removeWhatsappGateway() {
    setWhatsappBusy(true);
    try {
      await api('/pengaturan/whatsapp-gateway', { method: 'DELETE' });
      setWhatsappSettings({
        endpoint_url: '',
        is_enabled: false,
        is_configured: false,
        token_hint: '',
      });
      setWhatsappToken('');
      showToast('Konfigurasi WhatsApp berhasil dihapus.');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Konfigurasi WhatsApp gagal dihapus.', 'error');
    } finally {
      setWhatsappBusy(false);
    }
  }

  return (
    <section className="page-content">
      <div className="page-heading">
        <div>
          <p className="eyebrow">KONFIGURASI SISTEM</p>
          <h1>Pengaturan</h1>
          <p className="muted">Atur jadwal harian dan batas masuk khusus peserta.</p>
        </div>
      </div>
      <form className="panel-card settings-form form-stack" onSubmit={(event) => void submit(event)}>
        <label>
          Zona waktu
          <select value={form.timezone} onChange={(event) => setForm({ ...form, timezone: event.target.value })}>
            <option value="Asia/Jakarta">WIB · Asia/Jakarta</option>
            <option value="Asia/Makassar">WITA · Asia/Makassar</option>
            <option value="Asia/Jayapura">WIT · Asia/Jayapura</option>
          </select>
        </label>
        <div className="settings-schedule-sections">
          <div className="speech-settings">
            <div>
              <h2>Aturan jam per hari</h2>
              <p className="muted">Pilih hari kerja dan atur jam absensi. Hari libur tidak menerima scan dan tidak dihitung sebagai belum hadir.</p>
            </div>
            <div className="weekly-schedule-list">
              <div className="weekly-schedule-header" aria-hidden="true">
                <span>Hari</span><span>Status</span><span>Batas masuk</span><span>Toleransi (menit)</span><span>Mulai pulang</span>
              </div>
              {weeklySchedules.map((schedule) => (
                <div className="weekly-schedule-row" key={schedule.weekday}>
                  <strong>{weekdays[schedule.weekday]}</strong>
                  <label className="working-day-toggle">
                    <input
                      type="checkbox"
                      aria-label={`${weekdays[schedule.weekday]} termasuk hari kerja`}
                      checked={Boolean(schedule.is_working_day)}
                      onChange={(event) => setWeeklySchedules((current) => current.map((item) =>
                        item.weekday === schedule.weekday
                          ? { ...item, is_working_day: event.target.checked }
                          : item,
                      ))}
                    />
                    <span>{schedule.is_working_day ? 'Hari kerja' : 'Libur'}</span>
                  </label>
                  <input
                    aria-label={`${weekdays[schedule.weekday]} batas jam masuk`}
                    type="time"
                    required={Boolean(schedule.is_working_day)}
                    disabled={!schedule.is_working_day}
                    value={schedule.check_in_deadline}
                    onChange={(event) => setWeeklySchedules((current) => current.map((item) =>
                      item.weekday === schedule.weekday
                        ? { ...item, check_in_deadline: event.target.value }
                        : item,
                    ))}
                  />
                  <input
                    aria-label={`${weekdays[schedule.weekday]} toleransi keterlambatan`}
                    type="number"
                    min="0"
                    max="180"
                    required={Boolean(schedule.is_working_day)}
                    disabled={!schedule.is_working_day}
                    value={schedule.lateness_tolerance_minutes}
                    onChange={(event) => setWeeklySchedules((current) => current.map((item) =>
                      item.weekday === schedule.weekday
                        ? { ...item, lateness_tolerance_minutes: Number(event.target.value) }
                        : item,
                    ))}
                  />
                  <input
                    aria-label={`${weekdays[schedule.weekday]} jam mulai pulang`}
                    type="time"
                    required={Boolean(schedule.is_working_day)}
                    disabled={!schedule.is_working_day}
                    value={schedule.check_out_start}
                    onChange={(event) => setWeeklySchedules((current) => current.map((item) =>
                      item.weekday === schedule.weekday
                        ? { ...item, check_out_start: event.target.value }
                        : item,
                    ))}
                  />
                </div>
              ))}
            </div>
          </div>
          <div className="speech-settings">
            <div>
              <h2>Scanner barcode USB / Bluetooth</h2>
              <p className="muted">Tampilkan atau sembunyikan kolom input scanner eksternal di halaman scanner.</p>
            </div>
            <label className="settings-switch">
              <span>{form.enable_external_scanner ? 'Aktif' : 'Nonaktif'}</span>
              <input
                type="checkbox"
                role="switch"
                checked={form.enable_external_scanner}
                onChange={(event) => setForm((current) => ({
                  ...current,
                  enable_external_scanner: event.target.checked,
                }))}
                aria-label="Aktifkan scanner barcode USB atau Bluetooth"
              />
            </label>
          </div>
          <div className="speech-settings">
            <div>
              <h2>Batas masuk khusus peserta</h2>
              <p className="muted">Atur batas masuk yang berbeda untuk peserta dan hari tertentu, misalnya pukul 06.45. Toleransi mengikuti aturan hari tersebut.</p>
            </div>
            <div className="participant-override-list">
              {participantOverrides.map((rule, index) => (
                <div className="participant-override-row" key={`${rule.participant_id}-${rule.weekday}-${index}`}>
                  <label>
                    Peserta
                    <select
                      required
                      value={rule.participant_id}
                      onChange={(event) => setParticipantOverrides((current) => current.map((item, itemIndex) =>
                        itemIndex === index
                          ? { ...item, participant_id: event.target.value }
                          : item,
                      ))}
                    >
                      <option value="">Pilih peserta</option>
                      {participants.filter((participant) =>
                        participant.is_active === true || participant.is_active === 1,
                      ).map((participant) => (
                        <option key={participant.id} value={participant.id}>
                          {participant.full_name} · {participant.classroom_name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Hari
                    <select
                      value={rule.weekday}
                      onChange={(event) => setParticipantOverrides((current) => current.map((item, itemIndex) =>
                        itemIndex === index
                          ? { ...item, weekday: Number(event.target.value) }
                          : item,
                      ))}
                    >
                      {weekdays.map((day, weekday) => <option key={day} value={weekday}>{day}</option>)}
                    </select>
                  </label>
                  <label>
                    Batas masuk
                    <input
                      type="time"
                      required
                      value={rule.check_in_deadline}
                      onChange={(event) => setParticipantOverrides((current) => current.map((item, itemIndex) =>
                        itemIndex === index
                          ? { ...item, check_in_deadline: event.target.value }
                          : item,
                      ))}
                    />
                  </label>
                  <button
                    type="button"
                    className="button secondary"
                    aria-label="Hapus aturan khusus peserta"
                    onClick={() => setParticipantOverrides((current) => current.filter((_item, itemIndex) => itemIndex !== index))}
                  >
                    Hapus
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="button secondary"
                onClick={() => setParticipantOverrides((current) => [
                  ...current,
                  { participant_id: '', weekday: 1, check_in_deadline: '06:45' },
                ])}
              >
                Tambah batas peserta
              </button>
            </div>
          </div>
        </div>
        <div className="speech-settings">
          <div>
            <h2>Teks sambutan scanner</h2>
            <p className="muted">Teks ini bergerak dari kanan ke kiri di bagian atas layar scanner.</p>
          </div>
          <label>
            Teks sambutan
            <textarea
              maxLength={255}
              required
              rows={2}
              value={form.scan_welcome_message}
              onChange={(event) => setForm({ ...form, scan_welcome_message: event.target.value })}
              placeholder="Selamat datang - mohon tertib saat melakukan absensi"
            />
          </label>
        </div>
        <div className="speech-settings">
          <div>
            <h2>Suara pemindaian</h2>
            <p className="muted">
              Menggunakan suara Indonesia yang tersedia di perangkat dan memprioritaskan
              suara perempuan jika disediakan mesin TTS.
              Variabel yang dapat dipakai: <code>{'{name}'}</code>, <code>{'{status}'}</code>,
              dan <code>{'{reason}'}</code>.
            </p>
          </div>
          <label>
            Ucapan setelah scan berhasil
            <textarea
              maxLength={255}
              required
              rows={3}
              value={form.scan_success_message}
              onChange={(event) => setForm({ ...form, scan_success_message: event.target.value })}
              placeholder="Terima kasih, {name}. Absensi {status} sudah dicatat."
            />
          </label>
          <label>
            Ucapan saat scan gagal
            <textarea
              maxLength={255}
              required
              rows={2}
              value={form.scan_failure_message}
              onChange={(event) => setForm({ ...form, scan_failure_message: event.target.value })}
              placeholder="Maaf, absensi {name} gagal. {reason}."
            />
          </label>
          <small>Contoh status: hadir tepat waktu, terlambat 5 menit, atau pulang.</small>
        </div>
        <div className="notice">
          Perangkat scanner memakai salinan pengaturan terakhir. Simpan perubahan
          sebelum melakukan scan; sinkronisasi akan memvalidasi waktu pada server.
        </div>
        <button className="button primary" disabled={busy}>{busy ? 'Menyimpan…' : 'Simpan pengaturan'}</button>
      </form>
      <form className="panel-card settings-form whatsapp-gateway-settings" onSubmit={(event) => void saveWhatsappGateway(event)}>
        <div>
          <p className="eyebrow">NOTIFIKASI SEKOLAH</p>
          <h2>Gateway WhatsApp</h2>
          <p className="muted">Konfigurasi ini khusus untuk server sekolah. Bearer token dienkripsi dan tidak ditampilkan kembali.</p>
          <p className={`gateway-status ${whatsappSettings.is_enabled && whatsappSettings.is_configured ? 'ready' : ''}`}>
            {whatsappSettings.is_enabled && whatsappSettings.is_configured ? 'Aktif' : 'Belum aktif'}
          </p>
        </div>
        <div className="whatsapp-gateway-fields">
          <label>URL HTTPS gateway
            <input
              type="url"
              required={whatsappSettings.is_enabled}
              placeholder="https://gateway.example/api/send"
              value={whatsappSettings.endpoint_url}
              onChange={(event) => setWhatsappSettings((current) => ({ ...current, endpoint_url: event.target.value }))}
            />
          </label>
          <label>Bearer token
            <input
              type="password"
              autoComplete="new-password"
              placeholder={whatsappSettings.is_configured ? 'Tersimpan — kosongkan untuk mempertahankan' : 'Masukkan token gateway'}
              value={whatsappToken}
              onChange={(event) => setWhatsappToken(event.target.value)}
            />
          </label>
          {whatsappSettings.is_configured && <small className="muted">{whatsappSettings.token_hint}</small>}
          <label className="whatsapp-gateway-toggle">
            <input
              type="checkbox"
              checked={whatsappSettings.is_enabled}
              onChange={(event) => setWhatsappSettings((current) => ({ ...current, is_enabled: event.target.checked }))}
            />
            Aktifkan gateway
          </label>
          <div className="heading-actions">
            <button className="button primary" disabled={whatsappBusy}>{whatsappBusy ? 'Menyimpan…' : 'Simpan gateway'}</button>
            <button className="button secondary" type="button" disabled={whatsappBusy || !whatsappSettings.is_configured} onClick={() => void removeWhatsappGateway()}>Hapus konfigurasi</button>
          </div>
        </div>
      </form>
      <form className="panel-card settings-form form-stack menu-pin-settings" onSubmit={(event) => void changeMenuPin(event)}>
        <div>
          <h2>Keamanan menu</h2>
          <p className="muted">PIN 4 angka diminta setiap kali menu hamburger dibuka.</p>
        </div>
        <label>
          PIN saat ini
          <input
            type="password"
            inputMode="numeric"
            pattern="[0-9]{4}"
            maxLength={4}
            required
            value={pinForm.current_pin}
            onChange={(event) => setPinForm({ ...pinForm, current_pin: event.target.value.replace(/\D/g, '').slice(0, 4) })}
          />
        </label>
        <label>
          PIN baru
          <input
            type="password"
            inputMode="numeric"
            pattern="[0-9]{4}"
            maxLength={4}
            required
            value={pinForm.new_pin}
            onChange={(event) => setPinForm({ ...pinForm, new_pin: event.target.value.replace(/\D/g, '').slice(0, 4) })}
          />
        </label>
        <button className="button primary" disabled={pinBusy || pinForm.current_pin.length !== 4 || pinForm.new_pin.length !== 4}>
          {pinBusy ? 'Mengganti…' : 'Ganti PIN menu'}
        </button>
      </form>
    </section>
  );
}
