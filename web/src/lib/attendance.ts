import type {
  AttendanceMode,
  AttendanceStatus,
  Participant,
  QueuedScan,
  ScanMethod,
  Settings,
} from '../types';

function timeParts(date: Date, timeZone: string) {
  const values = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date).map(({ type, value }) => [type, value]),
  );
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    seconds: Number(values.hour) * 3600 +
      Number(values.minute) * 60 +
      Number(values.second),
  };
}

function clockSeconds(clock: string): number {
  const [hour, minute, second = '0'] = clock.split(':');
  return Number(hour) * 3600 + Number(minute) * 60 + Number(second);
}

export function createQueuedScan(
  participant: Participant,
  mode: AttendanceMode,
  settings: Settings,
  timestamp = new Date(),
  history: QueuedScan[] = [],
  scanMethod: ScanMethod = 'SCAN_QR',
): QueuedScan {
  const { date, seconds } = timeParts(timestamp, settings.timezone);
  const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  const dailySchedule = settings.weekly_schedules?.find(
    (schedule) => Number(schedule.weekday) === weekday,
  );
  const participantOverride = settings.participant_overrides?.find(
    (rule) =>
      String(rule.participant_id) === String(participant.id) &&
      Number(rule.weekday) === weekday,
  );
  const checkOutStart = dailySchedule?.check_out_start ?? settings.check_out_start;
  let eventType: 'masuk' | 'pulang' = mode === 'otomatis' ? 'masuk' : mode;
  if (mode === 'otomatis') {
    const hasCheckIn = history.some((record) =>
      record.id_peserta === Number(participant.id) &&
      record.attendance_date === date &&
      record.jenis_absen === 'masuk',
    );
    const hasCheckOut = history.some((record) =>
      record.id_peserta === Number(participant.id) &&
      record.attendance_date === date &&
      record.jenis_absen === 'pulang',
    );
    if (!hasCheckIn) {
      eventType = 'masuk';
    } else if (hasCheckOut) {
      throw new Error('Absensi masuk dan pulang peserta ini sudah tercatat hari ini.');
    } else if (seconds >= clockSeconds(checkOutStart)) {
      eventType = 'pulang';
    } else {
      throw new Error(
        `Absensi masuk peserta ini sudah tercatat. Scan pulang dapat dilakukan mulai pukul ${checkOutStart}.`,
      );
    }
  }

  let status: AttendanceStatus;
  let lateMinutes = 0;
  if (eventType === 'pulang') {
    if (seconds < clockSeconds(checkOutStart)) {
      throw new Error(
        `Absensi pulang baru dapat dicatat mulai pukul ${checkOutStart}.`,
      );
    }
    status = 'pulang';
  } else {
    const threshold =
      clockSeconds(
        participantOverride?.check_in_deadline ??
        dailySchedule?.check_in_deadline ??
        settings.check_in_deadline,
      ) +
      Number(
        dailySchedule?.lateness_tolerance_minutes ??
        settings.lateness_tolerance_minutes,
      ) * 60;
    if (seconds <= threshold) {
      status = 'hadir';
    } else {
      status = 'terlambat';
      lateMinutes = Math.ceil((seconds - threshold) / 60);
    }
  }

  const id = Number(participant.id);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new Error('ID peserta dari master server tidak valid.');
  }

  return {
    id_unik: crypto.randomUUID(),
    id_peserta: id,
    jenis_absen: eventType,
    client_timestamp: timestamp.toISOString(),
    status_kehadiran: status,
    menit_terlambat: lateMinutes,
    scan_method: scanMethod,
    attendance_date: date,
    participant_name: participant.full_name,
    participant_code: participant.participant_code,
    classroom_name: participant.classroom_name,
    status_sync: 'pending',
  };
}

export function formatLocalTime(timestamp: string, timeZone: string): string {
  return new Intl.DateTimeFormat('id-ID', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone,
  }).format(new Date(timestamp));
}
