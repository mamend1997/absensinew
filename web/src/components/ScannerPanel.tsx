import { BarcodeFormat, BarcodeScanner, LensFacing } from '@capacitor-mlkit/barcode-scanning';
import { Capacitor } from '@capacitor/core';
import { BrowserMultiFormatReader, type IScannerControls } from '@zxing/browser';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { createQueuedScan } from '../lib/attendance';
import { enqueueScan, getQueue } from '../lib/offline';
import type { AttendanceMode, Participant, QueuedScan, Settings } from '../types';

interface ScannerPanelProps {
  participants: Participant[];
  settings: Settings | null;
  online: boolean;
  pending: number;
  onSync: () => Promise<void>;
  onQueueChanged: () => Promise<void>;
  onMenu: () => void;
  manualRequested: boolean;
  onManualRequestHandled: () => void;
}

function playBeep(success: boolean) {
  if (!('AudioContext' in window)) return;
  try {
    const context = new AudioContext();
    void context.resume();
    const start = context.currentTime + 0.02;
    const notes = success
      ? [{ frequency: 880, at: 0 }, { frequency: 1175, at: 0.12 }]
      : [{ frequency: 370, at: 0 }, { frequency: 220, at: 0.18 }];
    for (const note of notes) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = note.frequency;
      gain.gain.value = 0.055;
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(start + note.at);
      oscillator.stop(start + note.at + 0.11);
      oscillator.onended = () => {
        if (note === notes.at(-1)) void context.close();
      };
    }
  } catch (error) {
    console.warn('Beep tidak tersedia:', error);
  }
}

function statusTitle(scan: Pick<QueuedScan, 'status_kehadiran' | 'menit_terlambat'>) {
  if (scan.status_kehadiran === 'terlambat') {
    return `terlambat ${scan.menit_terlambat} menit`;
  }
  if (scan.status_kehadiran === 'pulang') return 'pulang';
  return 'hadir tepat waktu';
}

function preferredIndonesianVoice(voices: SpeechSynthesisVoice[]) {
  const indonesianVoices = voices.filter((voice) =>
    voice.lang.toLowerCase().startsWith('id'),
  );
  const femaleVoice = indonesianVoices.find((voice) =>
    /female|woman|perempuan|gadis|ayu|siti|intan|melati|putri|sari/i.test(
      `${voice.name} ${voice.voiceURI}`,
    ),
  );
  return femaleVoice ??
    indonesianVoices.find((voice) => /google/i.test(voice.name)) ??
    indonesianVoices[0];
}

function loadSpeechVoices(): Promise<SpeechSynthesisVoice[]> {
  const synthesis = window.speechSynthesis;
  const available = synthesis.getVoices();
  if (available.length) return Promise.resolve(available);

  return new Promise((resolve) => {
    const finish = () => {
      window.clearTimeout(timeout);
      synthesis.removeEventListener('voiceschanged', onVoicesChanged);
      resolve(synthesis.getVoices());
    };
    const onVoicesChanged = () => {
      if (synthesis.getVoices().length) finish();
    };
    const timeout = window.setTimeout(finish, 700);
    synthesis.addEventListener('voiceschanged', onVoicesChanged);
  });
}

async function speakTemplate(
  template: string,
  values: { name: string; status: string; reason: string },
): Promise<boolean> {
  if (!('speechSynthesis' in window) || !('SpeechSynthesisUtterance' in window)) {
    return false;
  }
  const text = template.replace(/\{(name|status|reason)\}/gi, (_match, key: string) =>
    values[key.toLowerCase() as keyof typeof values] ?? '',
  );
  const synthesis = window.speechSynthesis;
  const voices = await loadSpeechVoices();
  synthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'id-ID';
  utterance.rate = 0.92;
  utterance.pitch = 1.08;
  const indonesianVoice = preferredIndonesianVoice(voices);
  if (indonesianVoice) utterance.voice = indonesianVoice;
  synthesis.speak(utterance);
  return true;
}

export default function ScannerPanel({
  participants,
  settings,
  online,
  pending,
  onSync,
  onQueueChanged,
  onMenu,
  manualRequested,
  onManualRequestHandled,
}: ScannerPanelProps) {
  const mode: AttendanceMode = 'otomatis';
  const [scanning, setScanning] = useState(false);
  const [nativeScanVisible, setNativeScanVisible] = useState(false);
  const [history, setHistory] = useState<QueuedScan[]>([]);
  const [scanMessage, setScanMessage] = useState('');
  const [scanFailed, setScanFailed] = useState(false);
  const [cameraError, setCameraError] = useState('');
  const [successPopupName, setSuccessPopupName] = useState<string | null>(null);
  const [manualEntryOpen, setManualEntryOpen] = useState(false);
  const [manualSearch, setManualSearch] = useState('');
  const [scannerCode, setScannerCode] = useState('');
  const [now, setNow] = useState(() => new Date());
  const videoRef = useRef<HTMLVideoElement>(null);
  const readerRef = useRef(new BrowserMultiFormatReader());
  const mountedRef = useRef(true);
  const scanCooldownTimerRef = useRef<number | undefined>(undefined);
  const scanLockedRef = useRef(false);
  const manualEntryOpenRef = useRef(false);
  const lastAcceptedEventRef = useRef<{
    participantId: string;
    eventType: QueuedScan['jenis_absen'];
    at: number;
  } | null>(null);
  const scannerInputRef = useRef<HTMLInputElement>(null);
  const successPopupTimerRef = useRef<number | undefined>(undefined);
  const failureFeedbackTimerRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    mountedRef.current = true;
    const interval = window.setInterval(() => setNow(new Date()), 1000);
    return () => {
      mountedRef.current = false;
      window.clearInterval(interval);
      if (scanCooldownTimerRef.current) window.clearTimeout(scanCooldownTimerRef.current);
      if (successPopupTimerRef.current) window.clearTimeout(successPopupTimerRef.current);
      if (failureFeedbackTimerRef.current) window.clearTimeout(failureFeedbackTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!settings) {
      setScanMessage('');
      return;
    }
    setScanFailed(false);
    setScanMessage('');
    setScanning(true);
  }, [settings]);

  useEffect(() => {
    if (!manualRequested) return;
    manualEntryOpenRef.current = true;
    setManualEntryOpen(true);
    onManualRequestHandled();
  }, [manualRequested, onManualRequestHandled]);

  const refreshHistory = useCallback(async () => {
    const records = await getQueue();
    setHistory(records.sort((a, b) =>
      b.client_timestamp.localeCompare(a.client_timestamp),
    ).slice(0, 6));
  }, []);

  useEffect(() => {
    void refreshHistory();
  }, [pending, refreshHistory]);

  const manualMatches = participants.filter((participant) => {
    const query = manualSearch.trim().toLocaleLowerCase();
    return (participant.is_active === true || participant.is_active === 1) &&
      (!query ||
        participant.full_name.toLocaleLowerCase().includes(query) ||
        participant.participant_code.toLocaleLowerCase().includes(query) ||
        participant.id.toLocaleLowerCase().includes(query) ||
        participant.classroom_name.toLocaleLowerCase().includes(query));
  }).slice(0, 40);

  const onDecoded = useCallback(async (
    value: string,
    scanMethod: 'SCAN_QR' | 'MANUAL_INPUT' = 'SCAN_QR',
    selectedParticipant?: Participant,
  ) => {
    setCameraError('');
    setScanFailed(false);
    setSuccessPopupName(null);
    if (successPopupTimerRef.current) window.clearTimeout(successPopupTimerRef.current);
    if (failureFeedbackTimerRef.current) window.clearTimeout(failureFeedbackTimerRef.current);
    let participantName = 'Peserta tidak dikenal';
    try {
      if (!settings) throw new Error('Pengaturan belum tersimpan di perangkat.');
      const code = value.trim();
      const timestamp = new Date();
      const participant = selectedParticipant ?? participants.find(
        (item) => item.qr_code.trim() === code &&
          (item.is_active === true || item.is_active === 1),
      );
      if (!participant) {
        throw new Error(`Kode "${code}" tidak ditemukan di master peserta lokal.`);
      }

      participantName = participant.full_name;
      const localHistory = await getQueue();
      const scan = createQueuedScan(
        participant,
        mode,
        settings,
        timestamp,
        localHistory,
        scanMethod,
      );
      const lastAcceptedEvent = lastAcceptedEventRef.current;
      if (
        lastAcceptedEvent?.participantId === String(participant.id) &&
        lastAcceptedEvent.eventType === scan.jenis_absen &&
        timestamp.getTime() - lastAcceptedEvent.at < 3000
      ) {
        return;
      }
      await enqueueScan(scan);
      lastAcceptedEventRef.current = {
        participantId: String(participant.id),
        eventType: scan.jenis_absen,
        at: timestamp.getTime(),
      };
      await onQueueChanged();
      await refreshHistory();
      setSuccessPopupName(participant.full_name);
      successPopupTimerRef.current = window.setTimeout(() => {
        if (mountedRef.current) setSuccessPopupName(null);
        successPopupTimerRef.current = undefined;
      }, 1800);
      playBeep(true);
      void speakTemplate(settings.scan_success_message, {
        name: participant.full_name,
        status: statusTitle(scan),
        reason: '',
      }).catch((error: unknown) => console.warn('TTS sukses tidak dapat diputar:', error));
      if (online) void onSync();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Scan gagal diproses.';
      setScanFailed(true);
      setScanMessage(message);
      playBeep(false);
      void speakTemplate(settings?.scan_failure_message ?? 'Maaf, absensi {name} gagal. {reason}.', {
        name: participantName,
        status: '',
        reason: message,
      }).catch((speechError: unknown) => console.warn('TTS gagal tidak dapat diputar:', speechError));
      failureFeedbackTimerRef.current = window.setTimeout(() => {
        if (mountedRef.current) {
          setScanFailed(false);
          setScanMessage('');
        }
        failureFeedbackTimerRef.current = undefined;
      }, 1800);
    } finally {
      if (mountedRef.current) {
        scanCooldownTimerRef.current = window.setTimeout(() => {
          scanLockedRef.current = false;
          scanCooldownTimerRef.current = undefined;
        }, 1400);
      }
    }
  }, [
    mode,
    online,
    onQueueChanged,
    onSync,
    participants,
    refreshHistory,
    settings,
  ]);

  function closeManualEntry() {
    manualEntryOpenRef.current = false;
    setManualEntryOpen(false);
    setManualSearch('');
  }

  function selectManualParticipant(participant: Participant) {
    closeManualEntry();
    scanLockedRef.current = true;
    void onDecoded(participant.qr_code, 'MANUAL_INPUT', participant);
  }

  function submitScannerCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const code = scannerCode.trim();
    if (!code || scanLockedRef.current) return;
    setScannerCode('');
    scanLockedRef.current = true;
    void onDecoded(code);
    scannerInputRef.current?.focus();
  }

  useEffect(() => {
    if (!scanning) return;
    let cancelled = false;
    let controls: IScannerControls | undefined;
    let nativeListener: { remove: () => Promise<void> } | undefined;
    const native = Capacitor.isNativePlatform();

    async function start() {
      setCameraError('');
      try {
        if (native) {
          const permission = await BarcodeScanner.requestPermissions();
          if (permission.camera !== 'granted') {
            throw new Error('Izin kamera belum diberikan. Periksa izin aplikasi di pengaturan Android.');
          }
          if (cancelled) return;
          nativeListener = await BarcodeScanner.addListener('barcodesScanned', (event) => {
            const value = event.barcodes.find((barcode) => barcode.displayValue)?.displayValue;
            if (!value || scanLockedRef.current || manualEntryOpenRef.current) return;
            scanLockedRef.current = true;
            void onDecoded(value);
          });
          setNativeScanVisible(true);
          document.body.classList.add('barcode-scanner-active');
          await BarcodeScanner.startScan({
            formats: [
              BarcodeFormat.QrCode,
              BarcodeFormat.Code128,
              BarcodeFormat.Ean13,
              BarcodeFormat.Ean8,
            ],
            lensFacing: LensFacing.Back,
          });
          return;
        }

        const video = videoRef.current;
        if (!video) throw new Error('Elemen kamera belum siap.');
        controls = await readerRef.current.decodeFromConstraints(
          {
            audio: false,
            video: {
              facingMode: { ideal: 'environment' },
            },
          },
          video,
          (result) => {
            if (!result || scanLockedRef.current || manualEntryOpenRef.current) return;
            scanLockedRef.current = true;
            void onDecoded(result.getText());
          },
        );
      } catch (error) {
        if (!cancelled) {
          setScanning(false);
          setNativeScanVisible(false);
          document.body.classList.remove('barcode-scanner-active');
          setCameraError(error instanceof Error ? error.message : 'Kamera tidak dapat dibuka.');
        }
      }
    }

    void start();
    return () => {
      cancelled = true;
      controls?.stop();
      if (native) {
        document.body.classList.remove('barcode-scanner-active');
        void nativeListener?.remove();
        void BarcodeScanner.stopScan().catch((error: unknown) => {
          if (!String(error).includes('not running')) console.warn('Scanner stop:', error);
        });
      }
    };
  }, [onDecoded, scanning]);

  const timeZone = settings?.timezone ?? 'Asia/Jakarta';
  const dateLabel = new Intl.DateTimeFormat('id-ID', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone,
  }).format(now);
  const timeLabel = new Intl.DateTimeFormat('id-ID', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZone,
  }).format(now);
  return (
    <section className="page-content scan-page-content">
      <header className="scan-screen-header">
        <div className="scan-header-top">
          <div className="scan-brand">
            <div className="brand-mark compact">RH</div>
            <div className="scan-brand-copy">
              <strong>Ruang Hadir</strong>
              <div className="scan-date-time">
                <span className="scan-date">{dateLabel}</span>
                <time className="scan-clock" dateTime={now.toISOString()}>{timeLabel}</time>
              </div>
            </div>
          </div>
          <div className="scan-header-actions">
            <div className={`connection-chip ${online ? 'is-online' : 'is-offline'}`}>
              <span /> {online ? 'Online' : 'Offline'}
            </div>
            <button className="scan-menu-trigger" aria-label="Buka menu" onClick={onMenu}>
              <span className="hamburger-icon" aria-hidden="true"><i /><i /><i /></span>
            </button>
          </div>
        </div>
        <div className="scan-welcome" aria-label="Pesan sambutan scanner">
          <span className="scan-welcome-track">
            {settings?.scan_welcome_message || 'Selamat datang - mohon tertib saat melakukan absensi'}
          </span>
        </div>
      </header>

      {pending > 0 && (
        <div className="scan-controls-row">
        <div className="scan-queue-summary">
          <span className="queue-mini-count">{pending}</span>
          <span>pending</span>
        </div>
        </div>
      )}

      <div className="scan-camera-shell">
        <div className={`scan-camera-frame ${scanning && !Capacitor.isNativePlatform() ? 'camera-live' : ''}`}>
          <video ref={videoRef} className="camera-video" muted playsInline />
          {scanning && !Capacitor.isNativePlatform() && (
            <div className="scan-target">
              <span className="scan-target-line" />
            </div>
          )}
          {nativeScanVisible && (
            <div className="native-scan-overlay">
              <button className="button secondary" onClick={onMenu}>Menu</button>
              <button className="button secondary" onClick={() => {
                setNativeScanVisible(false);
                document.body.classList.remove('barcode-scanner-active');
                void BarcodeScanner.stopScan();
                setScanning(false);
              }}>Jeda kamera</button>
            </div>
          )}
          {!scanning && !cameraError && !nativeScanVisible && (
            <div className="scan-camera-paused">Kamera dijeda</div>
          )}
        </div>
      </div>

      <form className="scanner-wedge-form" onSubmit={submitScannerCode}>
        <label htmlFor="scanner-wedge-code">Scanner barcode USB / Bluetooth</label>
        <div className="scanner-wedge-controls">
          <input
            ref={scannerInputRef}
            id="scanner-wedge-code"
            autoFocus
            inputMode="none"
            autoComplete="off"
            value={scannerCode}
            onChange={(event) => setScannerCode(event.target.value)}
            placeholder="Fokuskan bidang ini, lalu scan kartu"
          />
          <button className="button secondary" type="submit" disabled={!scannerCode.trim()}>
            Proses kode
          </button>
        </div>
        <small>Scanner mode keyboard wedge mengirim kode lalu menekan Enter.</small>
      </form>

      <section className="scan-history-card">
        <div className="scan-history-heading">
          <div><h2>Log kehadiran terbaru</h2><p>Riwayat scan yang tersimpan di perangkat ini</p></div>
          {pending > 0 && <span className="history-pending">{pending} pending</span>}
        </div>
        {history.length ? (
          <div className="scan-history-list">
            {history.map((record) => (
              <article className="scan-history-row" key={record.id_unik}>
                <div className={`history-status-dot ${record.status_sync}`} />
                <div className="history-person">
                  <strong>{record.participant_name}</strong>
                  <small>{record.participant_code} · {record.classroom_name} · {record.jenis_absen}</small>
                </div>
                <div className="history-time">
                  <strong>{new Date(record.client_timestamp).toLocaleDateString('id-ID')}</strong>
                  <small>{new Date(record.client_timestamp).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</small>
                </div>
                <span className={`sync-label ${record.status_sync}`}>
                  {record.status_sync === 'synced' ? 'terkirim' : 'pending'}
                </span>
              </article>
            ))}
          </div>
        ) : (
          <div className="scan-history-empty">Belum ada scan tersimpan di perangkat ini.</div>
        )}
      </section>

      {(scanFailed || cameraError) && (
        <div className="scan-failure-popup" role="status" aria-live="assertive">
          <div className="scan-failure-card">
            <span className="scan-failure-icon" aria-hidden="true">!</span>
            <strong>{cameraError ? 'Kamera belum siap' : 'Scan gagal'}</strong>
            <span>{cameraError || scanMessage}</span>
          </div>
        </div>
      )}

      {(cameraError || !scanning) && (
        <button className="button primary wide scan-resume-button" disabled={!settings} onClick={() => {
          setCameraError('');
          setScanMessage('');
          setScanning(true);
        }}>
          {!settings ? 'Menyiapkan scanner…' : cameraError ? 'Coba buka kamera lagi' : 'Lanjutkan kamera'}
        </button>
      )}
      {successPopupName && (
        <div className="scan-success-popup" role="status" aria-live="assertive">
          <div className="scan-success-card">
            <span className="scan-success-check" aria-hidden="true">✓</span>
            <strong>Absensi berhasil</strong>
            <span>{successPopupName}</span>
          </div>
        </div>
      )}
      {manualEntryOpen && (
        <div
          className="manual-attendance-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeManualEntry();
          }}
        >
          <section className="manual-attendance-card" role="dialog" aria-modal="true" aria-labelledby="manual-attendance-title">
            <button type="button" className="modal-close" aria-label="Tutup" onClick={closeManualEntry}>×</button>
            <p className="eyebrow">INPUT CADANGAN</p>
            <h2 id="manual-attendance-title">Absen manual</h2>
            <p className="muted">Cari peserta berdasarkan nama, kode, atau ID. Mode Masuk/Pulang tetap ditentukan otomatis.</p>
            <input
              autoFocus
              value={manualSearch}
              onChange={(event) => setManualSearch(event.target.value)}
              placeholder="Cari nama, kode, atau ID peserta"
              aria-label="Cari peserta untuk absen manual"
            />
            <div className="manual-attendance-results">
              {manualMatches.map((participant) => (
                <button
                  type="button"
                  className="manual-attendance-result"
                  key={participant.id}
                  onClick={() => selectManualParticipant(participant)}
                >
                  <span className="avatar">{participant.full_name.slice(0, 1).toUpperCase()}</span>
                  <span><strong>{participant.full_name}</strong><small>{participant.classroom_name} · ID {participant.id}</small></span>
                </button>
              ))}
              {!manualMatches.length && <div className="empty-row">Peserta tidak ditemukan.</div>}
            </div>
            <span className="manual-attendance-badge">MANUAL_INPUT</span>
          </section>
        </div>
      )}
    </section>
  );
}
