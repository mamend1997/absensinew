function parseTime(value, fieldName) {
  if (typeof value !== 'string' || !/^\d{2}:\d{2}(?::\d{2})?$/.test(value)) {
    throw new TypeError(`${fieldName} harus berformat HH:mm atau HH:mm:ss.`);
  }
  const [hour, minute, second = '0'] = value.split(':').map(Number);
  if (hour > 23 || minute > 59 || second > 59) {
    throw new RangeError(`${fieldName} bukan waktu yang valid.`);
  }
  return hour * 3600 + minute * 60 + second;
}

function localDateTimeParts(timestamp, timeZone) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) {
    throw new TypeError('client_timestamp harus berupa timestamp yang valid.');
  }

  const values = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
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
    seconds: Number(values.hour) * 3600 + Number(values.minute) * 60 + Number(values.second),
  };
}

function isWorkingDay(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'boolean') return value;
  return Number(value) === 1;
}

export function calculateAttendance({
  eventType,
  clientTimestamp,
  participantId,
  settings,
}) {
  if (!settings || typeof settings !== 'object') {
    throw new TypeError('Pengaturan operasional sekolah wajib tersedia.');
  }
  if (!['check_in', 'check_out', 'permission_out', 'permission_in'].includes(eventType)) {
    throw new TypeError('eventType absensi tidak valid.');
  }

  const { date, seconds } = localDateTimeParts(
    clientTimestamp,
    settings.timezone ?? 'Asia/Jakarta',
  );
  const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  const schedule = settings.weekly_schedules?.find(
    (item) => Number(item.weekday) === weekday,
  );
  const working = isWorkingDay(schedule?.is_working_day, weekday >= 1 && weekday <= 5);
  const holiday = settings.holidays?.some((item) => item.date === date);

  if (eventType === 'permission_out') {
    return { date, status: 'izin_keluar', lateMinutes: 0 };
  }
  if (eventType === 'permission_in') {
    return { date, status: 'izin_masuk', lateMinutes: 0 };
  }
  if (!working || holiday) {
    return { date, status: null, lateMinutes: 0, reason: 'non_working_day' };
  }
  if (eventType === 'check_out') {
    return { date, status: 'pulang', lateMinutes: 0 };
  }

  const override = settings.participant_overrides?.find(
    (item) =>
      String(item.participant_id) === String(participantId) &&
      Number(item.weekday) === weekday,
  );
  const deadline = parseTime(
    override?.check_in_deadline ??
      schedule?.check_in_deadline ??
      settings.check_in_deadline,
    'check_in_deadline',
  );
  const tolerance = Number(
    schedule?.lateness_tolerance_minutes ?? settings.lateness_tolerance_minutes ?? 0,
  );
  if (!Number.isInteger(tolerance) || tolerance < 0 || tolerance > 180) {
    throw new RangeError('Toleransi keterlambatan harus antara 0 dan 180 menit.');
  }

  const threshold = deadline + tolerance * 60;
  if (seconds <= threshold) {
    return { date, status: 'hadir', lateMinutes: 0 };
  }
  return {
    date,
    status: 'terlambat',
    lateMinutes: roundMinutesToTenth((seconds - threshold) / 60),
  };
}

function roundMinutesToTenth(minutes) {
  return Math.max(0.1, Math.round(minutes * 10) / 10);
}

export function createQueuedScan({
  sekolah_id,
  id_peserta,
  id_perangkat,
  jenis_absen,
  scan_method = 'SCAN_QR',
  client_timestamp = new Date().toISOString(),
  calculation,
  id_unik = globalThis.crypto?.randomUUID?.(),
}) {
  if (!sekolah_id || !id_peserta || !id_unik) {
    throw new TypeError('sekolah_id, id_peserta, dan id_unik wajib tersedia.');
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id_unik)) {
    throw new TypeError('id_unik harus berupa UUID yang valid.');
  }
  if (!['check_in', 'check_out', 'permission_out', 'permission_in'].includes(jenis_absen)) {
    throw new TypeError('jenis_absen absensi tidak valid.');
  }
  if (!['SCAN_QR', 'MANUAL_INPUT'].includes(scan_method)) {
    throw new TypeError('scan_method harus SCAN_QR atau MANUAL_INPUT.');
  }
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(calculation?.date ?? '') ||
    !['hadir', 'terlambat', 'pulang', 'izin_keluar', 'izin_masuk'].includes(calculation?.status)
  ) {
    throw new TypeError('Hasil validasi absensi yang dapat dicatat wajib tersedia.');
  }
  const lateMinutes = calculation.lateMinutes;
  if (!Number.isFinite(lateMinutes) || lateMinutes < 0 || lateMinutes > 65535 ||
      Math.abs(lateMinutes * 10 - Math.round(lateMinutes * 10)) > 1e-8) {
    throw new RangeError('Menit keterlambatan tidak valid.');
  }
  if (
    (jenis_absen === 'check_out' && (calculation.status !== 'pulang' || lateMinutes !== 0)) ||
    (jenis_absen === 'permission_out' && (calculation.status !== 'izin_keluar' || lateMinutes !== 0)) ||
    (jenis_absen === 'permission_in' && (calculation.status !== 'izin_masuk' || lateMinutes !== 0)) ||
    (jenis_absen === 'check_in' && !['hadir', 'terlambat'].includes(calculation.status)) ||
    (calculation.status === 'hadir' && lateMinutes !== 0) ||
    (calculation.status === 'terlambat' && lateMinutes === 0)
  ) {
    throw new TypeError('Status absensi tidak sesuai dengan jenis scan atau menit keterlambatan.');
  }

  return {
    id_unik,
    sekolah_id: String(sekolah_id),
    id_peserta: String(id_peserta),
    id_perangkat: id_perangkat == null ? null : String(id_perangkat),
    jenis_absen,
    scan_method,
    attendance_date: calculation.date,
    client_timestamp: new Date(client_timestamp).toISOString(),
    status_kehadiran: calculation.status,
    menit_terlambat: lateMinutes,
    status_sync: 'pending',
  };
}
